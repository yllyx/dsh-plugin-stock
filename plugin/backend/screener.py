"""
筛选引擎 - 选股策略 + 全市场预热池

- 4 种选股策略（返回命中理由）：机构抱团 / 启动股 / 均线多头 / 题材妖股
- 全市场预热池（MarketPool）：后台线程逐只拉取日K（东财K线接口），
  内存缓存 DataFrame；pool="market" 时基于缓存全市场扫描
- 默认池：东财列表不可用时退回内置白马池
"""

import time
import threading
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from loguru import logger

from data_source import data_source, normalize_stock_code
import eastmoney


def ma(series, n):
    return series.rolling(n).mean()


def ema(series, n):
    return series.ewm(span=n, adjust=False).mean()


def rsi(series, n=14):
    delta = series.diff()
    gain = delta.where(delta > 0, 0)
    loss = -delta.where(delta < 0, 0)
    avg_gain = gain.rolling(n).mean()
    avg_loss = loss.rolling(n).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def macd(series, fast=12, slow=26, signal=9):
    ema_fast = ema(series, fast)
    ema_slow = ema(series, slow)
    diff = ema_fast - ema_slow
    dea = ema(diff, signal)
    return diff, dea, (diff - dea) * 2


# ============= 选股策略（返回 (是否命中, 命中理由)） =============

def screen_institutional(df) -> Tuple[bool, Optional[str]]:
    """机构抱团股：高位强势 + 均线多头"""
    if df.empty or len(df) < 60:
        return False, None

    close, high, low = df["close"], df["high"], df["low"]

    hhv_1y = high.tail(250).max()
    llv_1y = low.tail(250).min()
    if hhv_1y == llv_1y:
        return False, None
    position = (close.iloc[-1] - llv_1y) / (hhv_1y - llv_1y) * 100
    if position < 80:
        return False, None

    ma5, ma10 = ma(close, 5).iloc[-1], ma(close, 10).iloc[-1]
    ma20, ma60 = ma(close, 20).iloc[-1], ma(close, 60).iloc[-1]
    if not (ma5 > ma10 > ma20 > ma60):
        return False, None

    return True, f"价格处于1年区间{position:.0f}%高位，MA5>10>20>60多头排列"


def screen_breakout(df) -> Tuple[bool, Optional[str]]:
    """启动股：长期横盘后放量突破 + MACD金叉"""
    if df.empty or len(df) < 60:
        return False, None

    close, high, low, volume = df["close"], df["high"], df["low"], df["volume"]

    hhv_60 = high.tail(60).max()
    llv_60 = low.tail(60).min()
    if llv_60 == 0:
        return False, None
    amplitude = (hhv_60 - llv_60) / llv_60 * 100
    if amplitude >= 30:
        return False, None
    if close.iloc[-1] < hhv_60 * 0.99:
        return False, None

    vol_ma5 = ma(volume, 5).iloc[-1]
    vol_ratio = volume.iloc[-1] / vol_ma5 if vol_ma5 else 0
    if vol_ratio < 2:
        return False, None

    ma250 = ma(close, 250).iloc[-1] if len(df) >= 250 else ma(close, min(120, len(df))).iloc[-1]
    if close.iloc[-1] <= ma250 or close.iloc[-1] >= ma250 * 1.2:
        return False, None

    diff, dea, _ = macd(close)
    if not (diff.iloc[-1] > dea.iloc[-1] and diff.iloc[-2] <= dea.iloc[-2]):
        return False, None

    return True, f"60日横盘(振幅{amplitude:.0f}%)后放量{vol_ratio:.1f}倍突破，站上年线且MACD金叉"


def screen_trend(df) -> Tuple[bool, Optional[str]]:
    """均线多头：六线多头排列"""
    if df.empty or len(df) < 120:
        return False, None

    close = df["close"]
    m = [ma(close, n).iloc[-1] for n in (5, 10, 20, 30, 60, 120)]
    if all(m[i] > m[i + 1] for i in range(len(m) - 1)):
        return True, "MA5>10>20>30>60>120 六线多头，趋势明确"
    return False, None


def screen_speculative(df) -> Tuple[bool, Optional[str]]:
    """题材妖股：近期涨停 + 放量 + 新高"""
    if df.empty or len(df) < 20:
        return False, None

    close, volume = df["close"], df["volume"]

    last_5 = close.tail(5)
    prev = close.shift(1).tail(5)
    pct_change = (last_5 - prev) / prev * 100
    has_limit_up = (pct_change >= 9.5).any()
    if not has_limit_up:
        return False, None

    vol_ma5 = ma(volume, 5).iloc[-1]
    if vol_ma5 and volume.iloc[-1] < vol_ma5 * 2:
        return False, None

    hhv_20 = df["high"].tail(20).max()
    if close.iloc[-1] < hhv_20 * 0.98:
        return False, None

    return True, "近5日有涨停+今日放量+逼近20日新高"


SCREENS = {
    "institutional": screen_institutional,
    "breakout": screen_breakout,
    "trend": screen_trend,
    "speculative": screen_speculative,
}

DEFAULT_POOL = ["600519", "000858", "000001", "600036", "000333",
                "300750", "002594", "601318", "600276", "000651",
                "300059", "600900", "601888", "000568", "002475"]


# ============= 全市场预热池 =============

class MarketPool:
    """
    后台线程预热全市场日K缓存（独立 pytdx 连接）。
    状态量 warmed/total 供 API 展示进度。
    """

    def __init__(self):
        self._dfs: Dict[str, pd.DataFrame] = {}
        self._fetch_date: Dict[str, str] = {}
        self._names: Dict[str, str] = {}
        self._codes: List[Dict[str, Any]] = []
        self._codes_date: str = ""
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.warming = False

    # ---------- 对外 ----------

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._warm_loop, daemon=True, name="stock-market-pool")
        self._thread.start()

    def stop(self):
        self._stop.set()

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "total": len(self._codes),
                "warmed": len(self._dfs),
                "progress_pct": round(len(self._dfs) / len(self._codes) * 100, 1) if self._codes else 0,
                "warming": self.warming,
                "codes_date": self._codes_date,
            }

    def get_df(self, code: str) -> Optional[pd.DataFrame]:
        with self._lock:
            return self._dfs.get(code)

    def get_name(self, code: str) -> str:
        with self._lock:
            return self._names.get(code, "")

    def scan(self, screen_fn, max_results: int) -> List[Dict[str, Any]]:
        """对已预热的股票池执行筛选"""
        results = []
        with self._lock:
            codes = list(self._dfs.keys())
        for code in codes:
            if len(results) >= max_results:
                break
            df = self.get_df(code)
            if df is None:
                continue
            try:
                ok, reason = screen_fn(df)
            except Exception:
                continue
            if ok:
                results.append({
                    "code": code,
                    "name": self.get_name(code),
                    "price": float(df["close"].iloc[-1]),
                    "change_pct": round((df["close"].iloc[-1] - df["close"].iloc[-2]) /
                                        df["close"].iloc[-2] * 100, 2) if len(df) >= 2 else 0,
                    "reason": reason,
                    "asof": self._fetch_date.get(code, ""),
                })
        return results

    # ---------- 预热循环 ----------

    def _refresh_codes(self):
        today = time.strftime("%Y-%m-%d")
        if self._codes and self._codes_date == today:
            return
        codes = eastmoney.get_all_stock_codes()
        if codes:
            with self._lock:
                self._codes = codes
                self._names = {c["code"]: c["name"] for c in codes}
                self._codes_date = today
            logger.info(f"全市场池: {len(codes)} 只 A 股")

    def _warm_loop(self):
        while not self._stop.is_set():
            try:
                self._refresh_codes()
            except Exception as e:
                logger.debug(f"刷新股票列表失败: {e}")

            if not self._codes:
                self._stop.wait(300)
                continue

            self.warming = True
            today = time.strftime("%Y-%m-%d")
            done = 0
            consecutive_fail = 0
            aborted = False
            for item in self._codes:
                if self._stop.is_set():
                    break
                code = item["code"]
                market = item["market"]
                with self._lock:
                    fresh = self._fetch_date.get(code) == today
                if fresh:
                    continue
                try:
                    bars = eastmoney.get_kline(f"{market}.{code}", klt=101, lmt=250)
                    if bars:
                        consecutive_fail = 0
                        df = pd.DataFrame([{
                            "open": b["open"], "high": b["high"],
                            "low": b["low"], "close": b["close"],
                            "volume": b["volume"], "amount": b["amount"],
                        } for b in bars])
                        with self._lock:
                            self._dfs[code] = df
                            self._fetch_date[code] = today
                        done += 1
                    else:
                        consecutive_fail += 1
                        if consecutive_fail >= 30:
                            # K线接口连续失败（可能被限流），熔断本轮，10分钟后重试
                            logger.warning("K线接口连续失败30次，预热熔断，10分钟后重试")
                            aborted = True
                            break
                except Exception as e:
                    logger.debug(f"预热 {code} 失败: {e}")
                # 限速：约 5-6 只/秒，全部预热约 20 分钟（东财K线接口）
                self._stop.wait(0.18)

            self.warming = False
            if done:
                logger.info(f"本轮预热完成，新拉取 {done} 只，缓存共 {len(self._dfs)} 只")
            # 预热完等待 60 分钟再检查过期；熔断则 10 分钟后重试
            self._stop.wait(600 if aborted else 3600)


market_pool = MarketPool()


# ============= 执行入口 =============

async def run_screen(
    screen_type: str,
    stock_pool: Optional[List[str]] = None,
    max_results: int = 30,
    pool: Optional[str] = None,
) -> Dict[str, Any]:
    """
    执行选股。
    pool="market" 时走全市场预热缓存；否则 stock_pool 为空则用默认白马池。
    返回 {"results": [...], "count": N, "pool_mode": "..."}
    """
    screen_fn = SCREENS.get(screen_type)
    if not screen_fn:
        return {"results": [], "count": 0, "error": f"未知选股类型 {screen_type}"}

    # 全市场模式
    if pool == "market":
        st = market_pool.status()
        if st["warmed"] < 50:
            return {
                "results": [], "count": 0, "pool_mode": "market",
                "error": f"全市场缓存预热中（{st['warmed']}/{st['total']}），请几分钟后再试",
            }
        results = market_pool.scan(screen_fn, max_results)
        results.sort(key=lambda r: r.get("change_pct", 0), reverse=True)
        return {"results": results, "count": len(results), "pool_mode": "market", "pool_status": st}

    # 指定池或默认池
    codes = stock_pool or DEFAULT_POOL
    results = []
    for code in codes[:50]:
        try:
            market, sec_code = normalize_stock_code(code)
            bars = data_source.get_security_bars(sec_code, market, category=9, count=250)
            if not bars:
                continue
            df = pd.DataFrame(bars)
            ok, reason = screen_fn(df)
            if ok:
                quotes = data_source.get_security_quotes([(market, sec_code)])
                q = quotes[0] if quotes else {}
                results.append({
                    "code": sec_code,
                    "name": q.get("name", ""),
                    "price": q.get("price", float(df["close"].iloc[-1])),
                    "change_pct": q.get("change_pct", 0),
                    "reason": reason,
                })
            if len(results) >= max_results:
                break
        except Exception as e:
            logger.debug(f"筛选 {code} 失败: {e}")
            continue

    return {
        "results": results,
        "count": len(results),
        "pool_mode": "custom" if stock_pool else "default",
    }
