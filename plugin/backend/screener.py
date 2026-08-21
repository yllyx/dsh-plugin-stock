"""
筛选引擎 - 选股策略 + 全市场预热池

- 4 种选股策略（返回命中理由）：机构抱团 / 启动股 / 均线多头 / 题材妖股
- 全市场预热池（MarketPool）：后台线程逐只拉取日K（东财K线接口），
  内存缓存 DataFrame；pool="market" 时基于缓存全市场扫描
- 默认池：东财列表不可用时退回内置白马池
"""

import sqlite3
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from loguru import logger

from data_source import data_source, normalize_stock_code
from storage import storage
import eastmoney
import tencent


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
    全市场日K缓存池：
    - 内存 DataFrame 缓存（选股扫描用）
    - SQLite 持久化（storage.data_dir/market.db）：启动整库载入，
      预热循环增量 upsert 当日bar，进程重启后断点续传、选股开机即可用
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
        self._db: Optional[sqlite3.Connection] = None
        self._db_lock = threading.Lock()
        self._db_upsert_buffer: List[tuple] = []
        self._alt_source = False   # K线源切换标志（东财连续失败→腾讯）
        self.warming = False
        self._db_rows: int = 0

    # ---------- SQLite 持久化 ----------

    def _db_conn(self) -> sqlite3.Connection:
        with self._db_lock:
            if self._db is None:
                self._db = sqlite3.connect(str(storage.path("market.db")), check_same_thread=False)
                self._db.execute("PRAGMA journal_mode=WAL")
                self._db.execute("PRAGMA synchronous=NORMAL")
                self._db.execute("""
                    CREATE TABLE IF NOT EXISTS kline_daily (
                        code TEXT NOT NULL,
                        date TEXT NOT NULL,
                        open REAL, high REAL, low REAL, close REAL,
                        volume REAL, amount REAL,
                        PRIMARY KEY (code, date)
                    ) WITHOUT ROWID""")
                self._db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
                self._db_rows = self._db.execute("SELECT COUNT(*) FROM kline_daily").fetchone()[0]
            return self._db

    def db_close(self):
        with self._db_lock:
            if self._db is not None:
                try:
                    self._db.commit()
                    self._db.close()
                except Exception:
                    pass
                self._db = None

    def db_load_all(self):
        """启动时整库载入内存（约3-8秒），未预热的日期由预热循环补"""
        t0 = time.time()
        conn = self._db_conn()
        by_code: Dict[str, Dict[str, list]] = {}
        for code, date, o, h, l, c, v, a in conn.execute(
                "SELECT code, date, open, high, low, close, volume, amount FROM kline_daily ORDER BY code, date"):
            cols = by_code.setdefault(code, {"open": [], "high": [], "low": [], "close": [],
                                             "volume": [], "amount": [], "dates": []})
            cols["open"].append(o); cols["high"].append(h); cols["low"].append(l)
            cols["close"].append(c); cols["volume"].append(v); cols["amount"].append(a)
            cols["dates"].append(date)
        # DataFrame 在锁外构建（耗时主体），仅赋值瞬间短暂加锁（微秒级/只），
        # 避免 /health 在整个载入期被 status() 的锁请求阻塞
        for code, cols in by_code.items():
            # 只保留最近250根，与在线预热口径一致
            n = max(0, len(cols["close"]) - 250)
            df = pd.DataFrame({
                "open": cols["open"][n:], "high": cols["high"][n:],
                "low": cols["low"][n:], "close": cols["close"][n:],
                "volume": cols["volume"][n:], "amount": cols["amount"][n:],
            })
            with self._lock:
                self._dfs[code] = df
                self._fetch_date[code] = cols["dates"][-1]
        logger.info(f"K线库载入 {len(by_code)} 只（{time.time()-t0:.1f}s，{self._db_rows} 行）")

    def _db_upsert(self, code: str, bars: List[Dict[str, Any]]):
        """缓存写入（只保留最近250根，与内存口径一致），攒批200行一个事务"""
        for b in bars[-250:]:
            date = str(b.get("datetime", ""))[:10]
            if not date:
                continue
            self._db_upsert_buffer.append((code, date, b["open"], b["high"], b["low"],
                                           b["close"], b["volume"], b["amount"]))
        if len(self._db_upsert_buffer) >= 200:
            self._db_flush()

    def _db_flush(self):
        if not self._db_upsert_buffer:
            return
        try:
            conn = self._db_conn()
            with self._db_lock:
                conn.executemany(
                    "INSERT OR REPLACE INTO kline_daily VALUES (?,?,?,?,?,?,?,?)",
                    self._db_upsert_buffer)
                conn.commit()
                self._db_rows = conn.execute("SELECT COUNT(*) FROM kline_daily").fetchone()[0]
            self._db_upsert_buffer = []
        except Exception as e:
            logger.debug(f"K线库写入失败: {e}")

    def db_prune(self, keep_days: int = 400):
        """清理超过保留期的旧K线，防止库无限增长"""
        try:
            conn = self._db_conn()
            cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - keep_days * 86400))
            with self._db_lock:
                cur = conn.execute("DELETE FROM kline_daily WHERE date < ?", (cutoff,))
                conn.commit()
            if cur.rowcount > 0:
                logger.info(f"K线库清理 {cur.rowcount} 行旧数据（<{cutoff}）")
        except Exception as e:
            logger.debug(f"K线库清理失败: {e}")

    def db_reload(self):
        """数据目录切换后：关旧连接、清内存、从新位置重载"""
        self.db_close()
        with self._lock:
            self._dfs.clear()
            self._fetch_date.clear()
        self.db_load_all()

    # ---------- 对外 ----------

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._warm_loop, daemon=True, name="stock-market-pool")
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._db_flush()
        self.db_close()

    def status(self) -> Dict[str, Any]:
        # 全部为普通属性原子读（不加锁）：/health 与系统状态在K线库载入期间也必须立即可响应
        return {
            "total": len(self._codes),
            "warmed": len(self._dfs),
            "progress_pct": round(len(self._dfs) / len(self._codes) * 100, 1) if self._codes else 0,
            "warming": self.warming,
            "codes_date": self._codes_date,
            "db_rows": self._db_rows,
            "db_file": str(storage.path("market.db")),
            "alt_source": "tencent" if self._alt_source else "eastmoney",
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

    def load_local_tdx(self) -> int:
        """
        从本地通达信 vipdoc 载入全市场日线（内存保留完整深度历史）。
        SQLite 只入最近250根。批量事务写入，8000只秒级~半分钟完成。
        """
        from config import config
        from tdx_local import resolve_vipdoc_dir, iter_local_daily

        vipdoc = resolve_vipdoc_dir(config.tdx_install_dir)
        if not vipdoc:
            return 0

        t0 = time.time()
        count = 0
        db_rows: List[tuple] = []
        conn = self._db_conn()
        for code, market, bars in iter_local_daily(vipdoc):
            df = pd.DataFrame([{
                "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"],
                "volume": b["volume"], "amount": b["amount"],
            } for b in bars])
            with self._lock:
                old = self._dfs.get(code)
                # 本地更深（历史更长）或内存无数据时采用本地
                if old is None or len(df) > len(old):
                    self._dfs[code] = df
                    self._fetch_date[code] = bars[-1]["datetime"]
            for b in bars[-250:]:
                db_rows.append((code, str(b["datetime"])[:10], b["open"], b["high"],
                                b["low"], b["close"], b["volume"], b["amount"]))
            count += 1
            # 每2000只提交一个事务
            if len(db_rows) >= 500_000:
                with self._db_lock:
                    conn.executemany("INSERT OR REPLACE INTO kline_daily VALUES (?,?,?,?,?,?,?,?)", db_rows)
                    conn.commit()
                db_rows = []
        if db_rows:
            with self._db_lock:
                conn.executemany("INSERT OR REPLACE INTO kline_daily VALUES (?,?,?,?,?,?,?,?)", db_rows)
                conn.commit()
            self._db_rows = conn.execute("SELECT COUNT(*) FROM kline_daily").fetchone()[0]
        logger.info(f"本地通达信载入 {count} 只（{time.time()-t0:.1f}s，目录 {vipdoc}）")
        return count

    def _fetch_kline(self, market: int, code: str) -> List[Dict[str, Any]]:
        """在线补缺：东财↔腾讯自适应轮换（连续失败自动切换，下一轮恢复默认顺序）"""
        if self._alt_source:
            order = [tencent.get_kline, eastmoney.get_kline]
        else:
            order = [eastmoney.get_kline, tencent.get_kline]
        for fetch in order:
            bars = fetch(code, market, klt=101, lmt=250)
            if bars:
                return bars
        return []

    def _warm_loop(self):
        # 三层载入：SQLite持久库（秒级）→ 本地通达信vipdoc（秒级、千根深度）→ 在线补缺
        try:
            self.db_load_all()
        except Exception as e:
            logger.warning(f"K线库载入失败（将全量在线预热）: {e}")
        try:
            self.load_local_tdx()
        except Exception as e:
            logger.warning(f"本地通达信数据载入失败: {e}")

        from config import config
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
                    bars = self._fetch_kline(market, code)
                    if bars:
                        consecutive_fail = 0
                        self._alt_source = False
                        df = pd.DataFrame([{
                            "open": b["open"], "high": b["high"],
                            "low": b["low"], "close": b["close"],
                            "volume": b["volume"], "amount": b["amount"],
                        } for b in bars])
                        with self._lock:
                            self._dfs[code] = df
                            self._fetch_date[code] = str(bars[-1].get("datetime", ""))[:10] or today
                        self._db_upsert(code, bars)
                        done += 1
                    else:
                        consecutive_fail += 1
                        # 主源连续失败10次 → 切换备源重试当前股票
                        if consecutive_fail == 10 and not self._alt_source:
                            self._alt_source = True
                            logger.warning("K线主源(东财)连续失败，本轮切换腾讯源")
                        if consecutive_fail >= 30:
                            # 双源均连续失败（均被限流），熔断本轮，10分钟后重试
                            logger.warning("K线接口连续失败30次，预热熔断，10分钟后重试")
                            aborted = True
                            break
                except Exception as e:
                    logger.debug(f"预热 {code} 失败: {e}")
                # 限速：约 3 只/秒（放缓降低东财限流风险）；本地/缓存命中的不等待
                self._stop.wait(0.35)

            self.warming = False
            self._db_flush()
            if done:
                logger.info(f"本轮预热完成，新拉取 {done} 只，缓存共 {len(self._dfs)} 只")
                self.db_prune()
            # 预热完等待配置的间隔再检查过期；熔断则 10 分钟后重试
            self._stop.wait(600 if aborted else config.warm_interval)


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
