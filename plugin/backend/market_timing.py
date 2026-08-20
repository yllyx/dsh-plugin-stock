"""
大盘择时引擎

回答两个问题：
1. 大盘是否"跌无可跌"（下跌动能衰竭）—— 多因子清单打分
2. 是否出现"企稳信号"（可以开始试仓）—— K线形态确认

并给出：市场阶段判定（主升/震荡/下跌/主跌）→ 建议总仓位区间 → 操作节奏

数据：pytdx 指数日K（沪深300/上证指数，沪市 market=1）+ 东财涨跌停统计 + 两融余额（可选降级）
结果缓存 300s。
"""

import time
from typing import Any, Dict, List, Optional

import pandas as pd
from loguru import logger

import eastmoney
from data_source import data_source
from screener import ma, rsi, macd
from market_sentiment import market_sentiment

# 注意：000300/000001/000905/000852 均为沪市指数（market=1），
# 不能走 normalize_stock_code（0开头会被误判为深市个股，如 000001 会取到平安银行）
INDEX_HS300 = (1, "000300")
INDEX_SZZS = (1, "000001")

CACHE_TTL = 300

STAGE_CONFIG = {
    "主升": {"position": "70-80%", "action": "趋势持有为主，可重仓，注意分批兑现"},
    "震荡": {"position": "40-60%", "action": "高抛低吸，半仓灵活，等方向选择"},
    "下跌": {"position": "20-30%", "action": "轻仓观望为主，只做超跌反弹，严格止损"},
    "主跌": {"position": "0-20%", "action": "空仓或极轻仓防守，等待跌无可跌+企稳信号"},
}


class MarketTiming:
    """大盘择时引擎"""

    def __init__(self):
        self._cache: Optional[Dict[str, Any]] = None
        self._cache_time: float = 0
        self._refreshing = False

    def get(self, force: bool = False) -> Dict[str, Any]:
        if not force and self._cache and (time.time() - self._cache_time) < CACHE_TTL:
            return self._cache
        if self._refreshing:
            return self._cache or {"error": "择时数据计算中"}
        self._refreshing = True
        try:
            self._cache = self.analyze()
            self._cache_time = time.time()
            return self._cache
        except Exception as e:
            logger.error(f"择时分析异常: {e}")
            return self._cache or {"error": f"择时分析失败: {e}"}
        finally:
            self._refreshing = False

    # ---------- 主分析 ----------

    def analyze(self) -> Dict[str, Any]:
        bars = data_source.get_security_bars(INDEX_HS300[1], INDEX_HS300[0], category=9, count=1100)
        if not bars or len(bars) < 120:
            return {"error": "无法获取沪深300日K（通达信未连接）"}

        df = pd.DataFrame(bars)
        close, high, low, vol, amount = df["close"], df["high"], df["low"], df["volume"], df["amount"]

        exhaustion = self._exhaustion_checklist(df)
        stabilization = self._stabilization_checklist(df)
        stage = self._stage(df)
        cfg = STAGE_CONFIG[stage["stage"]]

        result = {
            "stage": stage,
            "bottom_exhaustion": exhaustion,   # 跌无可跌清单
            "stabilization": stabilization,    # 企稳信号清单
            "suggested_position": cfg["position"],
            "action_advice": cfg["action"],
            "rhythm": (
                "左侧试仓(10-20%) → 企稳信号确认 → 加仓(30-50%) → 站上20日线 → 重仓(60-80%) → 加速期分批兑现"
            ),
            "indicators": {
                "rsi14": round(float(rsi(close, 14).iloc[-1]), 1),
                "close": float(close.iloc[-1]),
                "drawdown_250d_pct": round(self._drawdown(close, high), 2),
                "ma20": round(float(ma(close, 20).iloc[-1]), 1),
                "vol_ratio_5_60": round(self._vol_ratio(amount), 2),
            },
            "timestamp": time.time(),
        }
        return result

    # ---------- "跌无可跌"清单 ----------

    def _exhaustion_checklist(self, df: pd.DataFrame) -> Dict[str, Any]:
        close, high, low, amount = df["close"], df["high"], df["low"], df["amount"]
        items: List[Dict[str, Any]] = []

        def item(name: str, hit: bool, value: str, note: str = ""):
            items.append({"name": name, "hit": bool(hit), "value": value, "note": note})

        # 1. RSI 超卖
        r = float(rsi(close, 14).iloc[-1])
        item("RSI14 超卖(<30)", r < 30, f"RSI={r:.1f}", "跌无可跌通常伴随超卖")

        # 2. MACD 底背离
        div, div_desc = self._macd_divergence(df)
        item("MACD 底背离", div, div_desc, "指数新低但MACD不新低，下跌动能衰竭")

        # 3. 距250日高点回撤>20%
        dd = self._drawdown(close, high)
        item("距一年高点回撤>20%", dd < -20, f"回撤 {dd:.1f}%", "深度回撤后风险大幅释放")

        # 4. 价格处于近5年低分位(<20%)
        pctile = self._price_percentile(close)
        item("价格低分位(<20%)", pctile < 20, f"近5年分位 {pctile:.0f}%",
             "估值proxy：PE分位无免费接口，用价格分位近似")

        # 5. 成交额萎缩（5日均额 < 60日均额的60%）
        vr = self._vol_ratio(amount)
        item("成交额萎缩至6成以下", vr < 0.6, f"5日/60日均额比 {vr:.2f}", "地量见地价")

        # 6. 跌停家数 > 涨停家数（恐慌宣泄）
        senti = market_sentiment.get()
        s = senti.get("sentiment", {})
        if s.get("data_available"):
            item("跌停家数>涨停家数", s["dt_count"] > s["zt_count"],
                 f"涨停{s['zt_count']}家 / 跌停{s['dt_count']}家", "恐慌性抛售接近尾声的标志")
        else:
            items.append({"name": "跌停家数>涨停家数", "hit": False, "value": "数据不可用", "note": "东财接口失败，已跳过", "skipped": True})

        # 7. 两融余额连续下降（杠杆资金离场近尾声）
        margin = eastmoney.get_margin_balance(days=8)
        if margin and len(margin) >= 5:
            downs = sum(1 for i in range(len(margin) - 1) if margin[i]["total"] < margin[i + 1]["total"])
            item("两融余额连续下降", downs >= 4, f"近{len(margin)-1}日中{downs}日下降",
                 f"最新余额 {margin[0]['total']/1e12:.2f}万亿")
        else:
            items.append({"name": "两融余额连续下降", "hit": False, "value": "数据不可用", "note": "两融接口失败，已跳过", "skipped": True})

        scored = [i for i in items if not i.get("skipped")]
        hit_count = sum(1 for i in scored if i["hit"])
        confirmed = hit_count >= 4 and len(scored) >= 5
        return {
            "items": items,
            "hit_count": hit_count,
            "total": len(scored),
            "confirmed": confirmed,
            "conclusion": (
                "满足{}项/{}项，已到「跌无可跌」区域，可开始左侧试仓".format(hit_count, len(scored))
                if confirmed else
                "满足{}项/{}项，尚未到「跌无可跌」区域，继续等待".format(hit_count, len(scored))
            ),
        }

    # ---------- "企稳信号"清单 ----------

    def _stabilization_checklist(self, df: pd.DataFrame) -> Dict[str, Any]:
        close, open_, high, low, vol = df["close"], df["open"], df["high"], df["low"], df["volume"]
        items: List[Dict[str, Any]] = []

        def item(name: str, hit: bool, value: str, note: str = ""):
            items.append({"name": name, "hit": bool(hit), "value": value, "note": note})

        # 1. 缩量止跌：最近3日不创20日新低 且 量能<前期恐慌日一半
        try:
            recent_low = float(low.iloc[-3:].min())
            prior_low = float(low.iloc[-20:-3].min())
            panic_vol = float(vol.iloc[-20:-3].max())
            recent_vol = float(vol.iloc[-3:].mean())
            no_new_low = recent_low > prior_low
            shrink = recent_vol < panic_vol * 0.5
            item("缩量止跌", no_new_low and shrink,
                 f"3日未创新低:{'是' if no_new_low else '否'} 量能比恐慌日:{recent_vol/panic_vol:.0%}",
                 "卖压衰竭的最直接证据")
        except Exception:
            item("缩量止跌", False, "数据不足", "")

        # 2. 放量反包阳线：最近2日内出现 阳线实体包住前日阴线 + 收盘站上MA5
        try:
            engulfed = False
            ma5 = ma(close, 5)
            for i in (len(df) - 1, len(df) - 2):
                if i < 1:
                    continue
                c1, o1 = float(close.iloc[i]), float(open_.iloc[i])
                c0, o0 = float(close.iloc[i - 1]), float(open_.iloc[i - 1])
                if (c1 > o1 and c0 < o0           # 今日阳、昨日阴
                        and c1 >= o0 and o1 <= c0  # 实体反包
                        and c1 > float(ma5.iloc[i])):
                    engulfed = True
                    break
            item("放量反包阳线", engulfed, "近2日出现" if engulfed else "近2日未出现",
                 "多头第一次有力反击")
        except Exception:
            item("放量反包阳线", False, "数据不足", "")

        # 3. 向上跳空缺口未回补（今日或昨日低点高于前日高点）
        try:
            gap = False
            for i in (len(df) - 1, len(df) - 2):
                if i < 1:
                    continue
                if float(low.iloc[i]) > float(high.iloc[i - 1]):
                    gap = True
                    break
            item("向上跳空缺口", gap, "近2日出现" if gap else "近2日未出现", "强势资金入场痕迹")
        except Exception:
            item("向上跳空缺口", False, "数据不足", "")

        # 4. 多板块联动反弹（行业板块上涨家数占比>60% 且当日指数上涨）
        try:
            senti = market_sentiment.get()
            s = senti.get("sentiment", {})
            idx_change = 0.0
            quotes = data_source.get_security_quotes([INDEX_HS300])
            if quotes:
                idx_change = quotes[0].get("change_pct", 0)
            if s.get("data_available") and (s["up_count"] + s["down_count"]) > 0:
                up_ratio = s["up_count"] / (s["up_count"] + s["down_count"])
                broad = up_ratio > 0.6 and idx_change > 0
                item("多板块联动反弹", broad,
                     f"上涨家数占比{up_ratio:.0%}，沪深300 {idx_change:+.2f}%",
                     "普涨才是真反弹，个别权重护盘不算")
            else:
                item("多板块联动反弹", False, "数据不可用", "")
        except Exception:
            item("多板块联动反弹", False, "数据不足", "")

        hit_count = sum(1 for i in items if i["hit"])
        confirmed = hit_count >= 2
        return {
            "items": items,
            "hit_count": hit_count,
            "total": len(items),
            "confirmed": confirmed,
            "conclusion": (
                f"出现 {hit_count}/{len(items)} 个企稳信号，可分批试仓（建议观察2-3天确认）"
                if confirmed else
                f"仅 {hit_count}/{len(items)} 个企稳信号，不宜急于入场，耐心等待确认"
            ),
        }

    # ---------- 阶段判定 ----------

    def _stage(self, df: pd.DataFrame) -> Dict[str, Any]:
        close, amount = df["close"], df["amount"]
        ma20 = ma(close, 20)
        last_close = float(close.iloc[-1])
        m20 = float(ma20.iloc[-1])
        m20_slope = (float(ma20.iloc[-1]) - float(ma20.iloc[-5])) / float(ma20.iloc[-5]) * 100
        vr = self._vol_ratio(amount)
        chg5 = (float(close.iloc[-1]) - float(close.iloc[-6])) / float(close.iloc[-6]) * 100

        if last_close > m20 and m20_slope > 0.3:
            stage = "主升"
        elif last_close < m20 * 0.97 and m20_slope < -0.3 and chg5 < -4:
            stage = "主跌"
        elif last_close < m20 and m20_slope < 0:
            stage = "下跌"
        else:
            stage = "震荡"

        return {
            "stage": stage,
            "detail": (
                f"收盘{last_close:.0f} vs MA20 {m20:.0f}（{'上方' if last_close > m20 else '下方'}），"
                f"MA20五日斜率 {m20_slope:+.2f}%，5日涨跌 {chg5:+.1f}%，量比(5日/60日) {vr:.2f}"
            ),
        }

    # ---------- 指标工具 ----------

    @staticmethod
    def _drawdown(close: pd.Series, high: pd.Series) -> float:
        window = min(250, len(high))
        hh = float(high.tail(window).max())
        last = float(close.iloc[-1])
        return (last - hh) / hh * 100 if hh else 0

    @staticmethod
    def _price_percentile(close: pd.Series) -> float:
        window = min(1000, len(close))
        tail = close.tail(window)
        return float((tail < float(close.iloc[-1])).mean() * 100)

    @staticmethod
    def _vol_ratio(amount: pd.Series) -> float:
        a5 = float(amount.tail(5).mean())
        a60 = float(amount.tail(60).mean())
        return a5 / a60 if a60 else 1.0

    @staticmethod
    def _macd_divergence(df: pd.DataFrame) -> (bool, str):
        """60日内价格创新低但 DIFF 未创新低"""
        try:
            close, low = df["close"], df["low"]
            diff, dea, _ = macd(close)
            window = min(60, len(df) - 30)
            if window < 30:
                return False, "数据不足"
            recent = df.tail(window)
            low_idx = recent["low"].idxmin()
            # 找前一个低点区间（当前低点之前30日内的最低点）
            before = df.loc[:low_idx].tail(40)
            if before.empty or len(before) < 10:
                return False, "数据不足"
            prev_low_idx = before["low"].idxmin()
            if prev_low_idx == low_idx:
                return False, "仅一个低点"
            price_lower = float(low.loc[low_idx]) < float(low.loc[prev_low_idx])
            diff_higher = float(diff.loc[low_idx]) > float(diff.loc[prev_low_idx])
            hit = price_lower and diff_higher
            return hit, (
                f"新低{float(low.loc[low_idx]):.0f} vs 前低{float(low.loc[prev_low_idx]):.0f}，"
                f"DIFF {'抬升' if diff_higher else '同步走低'}"
            )
        except Exception:
            return False, "计算失败"


market_timing = MarketTiming()
