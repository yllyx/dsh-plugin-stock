"""
板块监控 + 龙头股识别

- 板块排行（行业/概念）：涨幅、成交额、换手、5日动量、阶段标签（启动/发酵/高潮/退潮/盘整）
- 阶段判定用东财板块指数日K（30日） bootstrap，不依赖本地历史积累
- 龙头候选：板块成分股按 涨幅/涨停/换手区间/市值区间/量比 打分，输出前5及理由

缓存：排行 60s，板块K线 30min。
"""

import time
from typing import Any, Dict, List, Optional

from loguru import logger

import eastmoney

RANK_TTL = 60
KLINE_TTL = 1800


def _limit_threshold(code: str) -> float:
    """涨停幅度阈值（近似）：创业/科创 20%，其余 10%"""
    if code.startswith(("30", "68")):
        return 19.8
    return 9.8


class SectorMonitor:

    def __init__(self):
        self._rank_cache: Dict[str, Dict[str, Any]] = {}   # board_type -> {"data", "time"}
        self._kline_cache: Dict[str, Dict[str, Any]] = {}  # bk_code -> {"data", "time"}
        self._leaders_cache: Dict[str, Dict[str, Any]] = {}  # bk_code -> {"data", "time"}

    # ---------- 板块排行 ----------

    def get_ranking(self, board_type: str = "industry", top_n: int = 15, force: bool = False) -> Dict[str, Any]:
        cached = self._rank_cache.get(board_type)
        if not force and cached and time.time() - cached["time"] < RANK_TTL:
            return {"boards": cached["data"][:top_n], "cached": True}

        boards = eastmoney.get_board_rank(board_type)
        if not boards:
            if cached:
                return {"boards": cached["data"][:top_n], "cached": True, "degraded": True}
            return {"error": "板块数据不可用（东财接口失败）", "boards": []}

        # 先按涨幅排序，只对实际展示的 top_n 板块做K线阶段判定（并行拉取，控制耗时）
        boards.sort(key=lambda b: (b.get("change_pct") is not None, b.get("change_pct") or -99), reverse=True)
        display = boards[:top_n]
        today = time.strftime("%Y-%m-%d")
        total_amount = sum(b["amount"] for b in boards) or 1

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {b["bk_code"]: pool.submit(self._classify, b, today) for b in display}
            for bk, fut in futures.items():
                b = next(x for x in display if x["bk_code"] == bk)
                b["momentum_5d"], b["stage"], b["stage_detail"] = fut.result()

        for b in boards:
            b["amount_ratio_pct"] = round(b["amount"] / total_amount * 100, 1)

        self._rank_cache[board_type] = {"data": boards, "time": time.time()}
        return {"boards": display, "cached": False}

    def _classify(self, b: Dict[str, Any], today: str):
        """单个板块的动量与阶段判定（供并行调用）"""
        k = self._board_kline(b["bk_code"])
        if k is not None and len(k) >= 10:
            k = self._append_today_bar(k, b, today)
            return self._momentum(k, 5), *self._stage(k)
        return None, "未知", "K线数据不可用"

    # ---------- 龙头候选 ----------

    def get_leaders(self, bk_code: str, name: str = "", top_n: int = 5) -> Dict[str, Any]:
        cached = self._leaders_cache.get(bk_code)
        if cached and time.time() - cached["time"] < RANK_TTL:
            return cached["data"]

        stocks = eastmoney.get_board_stocks(bk_code, max_count=200)
        if not stocks:
            if cached:
                return cached["data"]
            return {"error": f"板块 {name or bk_code} 成分股数据不可用", "leaders": []}

        k = self._board_kline(bk_code)
        board_pct_5d = self._momentum(k, 5) if k else 0

        scored = []
        for s in stocks:
            if not s.get("change_pct") or s["change_pct"] is None:
                continue
            score = 0.0
            reasons = []
            # 1. 当日涨幅（核心）
            score += max(-10, min(20, s["change_pct"] * 2))
            reasons.append(f"今日{s['change_pct']:+.2f}%")
            # 2. 涨停加分
            if s["change_pct"] >= _limit_threshold(s["code"]):
                score += 12
                reasons.append("涨停")
            # 3. 换手率适中区间（游资活跃但不过度）
            tr = s.get("turnover_rate") or 0
            if 10 <= tr <= 25:
                score += 8
                reasons.append(f"换手{tr:.0f}%活跃")
            elif 5 <= tr <= 30:
                score += 4
            # 4. 市值 50-300亿 加分（弹性+资金关注平衡）
            fmv = s.get("float_mv") or 0
            if 50e8 <= fmv <= 300e8:
                score += 8
                reasons.append("流通市值50-300亿")
            elif 300e8 < fmv <= 800e8:
                score += 4
            # 5. 量比放大
            vr = s.get("volume_ratio") or 0
            if vr >= 1.5:
                score += 5
                reasons.append(f"量比{vr:.1f}放量")
            scored.append({
                "code": s["code"],
                "name": s["name"],
                "price": s.get("price"),
                "change_pct": s["change_pct"],
                "turnover_rate": tr,
                "float_mv_yi": round(fmv / 1e8, 0),
                "score": round(score, 1),
                "reasons": reasons,
            })

        scored.sort(key=lambda x: x["score"], reverse=True)
        result = {
            "bk_code": bk_code,
            "name": name,
            "board_pct_5d": board_pct_5d,
            "leaders": scored[:top_n],
        }
        self._leaders_cache[bk_code] = {"data": result, "time": time.time()}
        return result

    # ---------- 内部：板块K线与阶段 ----------

    def _board_kline(self, bk_code: str) -> Optional[List[Dict[str, Any]]]:
        cached = self._kline_cache.get(bk_code)
        if cached and time.time() - cached["time"] < KLINE_TTL:
            return cached["data"]
        k = eastmoney.get_board_kline(bk_code, days=35)
        self._kline_cache[bk_code] = {"data": k, "time": time.time()}
        return k

    @staticmethod
    def _append_today_bar(kline: List[Dict[str, Any]], board: Dict[str, Any], today: str) -> List[Dict[str, Any]]:
        """
        盘中板块K线只到昨日，而排行数据是实时的：
        用排行接口的实时价格/涨幅/成交额合成今日bar，让阶段判定反映当日盘面。
        """
        if not kline or kline[-1]["datetime"] == today:
            return kline
        price, pct = board.get("price"), board.get("change_pct")
        if not price or pct is None:
            return kline
        prev_close = price / (1 + pct / 100)
        return kline + [{
            "datetime": today,
            "open": prev_close, "close": price,
            "high": max(price, prev_close), "low": min(price, prev_close),
            "volume": 0, "amount": board.get("amount", 0),
        }]

    @staticmethod
    def _momentum(kline: List[Dict[str, Any]], days: int) -> Optional[float]:
        closes = [k["close"] for k in kline]
        if len(closes) < days + 1:
            return None
        return round((closes[-1] - closes[-1 - days]) / closes[-1 - days] * 100, 2)

    @staticmethod
    def _stage(kline: List[Dict[str, Any]]) -> (str, str):
        """
        板块阶段：启动 / 发酵 / 高潮 / 退潮 / 盘整
        规则（基于近30日板块指数K线）：
        - 启动：长期盘整(20日振幅<10%)后首日放量(2倍)上涨(>2%)
        - 发酵：近3日累计涨幅>5%
        - 高潮：当日涨幅>4% 且处于近20日高位
        - 退潮：昨日涨幅>2% 但今日下跌
        """
        try:
            n = len(kline)
            today = kline[-1]
            pct_today = (today["close"] - kline[-2]["close"]) / kline[-2]["close"] * 100
            pct_yesterday = (kline[-2]["close"] - kline[-3]["close"]) / kline[-3]["close"] * 100
            closes = [k["close"] for k in kline]
            amounts = [k["amount"] for k in kline]
            avg_amount_10 = sum(amounts[-11:-1]) / 10
            high_20 = max(closes[-20:])
            low_20 = min(closes[-20:])
            amplitude_20 = (high_20 - low_20) / low_20 * 100
            cum_3d = (closes[-1] - closes[-4]) / closes[-4] * 100
            vol_expand = today["amount"] > avg_amount_10 * 2

            if amplitude_20 < 10 and pct_today > 2 and vol_expand:
                return "启动", f"20日振幅仅{amplitude_20:.0f}%，今日放量({today['amount']/avg_amount_10:.1f}倍)上涨{pct_today:.1f}%"
            if pct_yesterday > 2 and pct_today < 0:
                return "退潮", f"昨日+{pct_yesterday:.1f}%后今日{pct_today:.1f}%，资金撤离迹象"
            if cum_3d > 5 and today["close"] >= high_20 * 0.99:
                return "高潮", f"3日累涨{cum_3d:.1f}%且贴近20日新高，谨防情绪见顶"
            if cum_3d > 4:
                return "发酵", f"3日累涨{cum_3d:.1f}%，主升进行中"
            return "盘整", f"20日振幅{amplitude_20:.0f}%，今日{pct_today:+.1f}%"
        except (IndexError, KeyError, ZeroDivisionError):
            return "未知", "数据不足"


sector_monitor = SectorMonitor()
