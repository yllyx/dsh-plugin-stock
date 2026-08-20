"""
市场情绪统计 + 风格识别（机构抱团期 vs 题材妖股期）

数据来源：
- 东财 涨停池/跌停池/炸板池 → 涨跌停家数、连板梯队、炸板率
- 东财 行业板块排行汇总 → 全市场涨跌家数、两市成交额
- pytdx 指数K线 → 沪深300 vs 中证1000 相对强弱（抱团/小盘风格）

结果缓存 60s，由后端刷新循环预热。
"""

import time
from typing import Any, Dict, List, Optional

from loguru import logger

import eastmoney
from data_source import data_source

CACHE_TTL = 60


class MarketSentiment:
    """情绪统计与风格判定"""

    CODES_CACHE_TTL = 24 * 3600

    def __init__(self):
        self._cache: Optional[Dict[str, Any]] = None
        self._cache_time: float = 0
        self._refreshing = False
        self._codes: Optional[List[Dict[str, Any]]] = None
        self._codes_time: float = 0

    def _all_a_codes(self) -> List[Dict[str, Any]]:
        """全市场A股代码（东财列表，缓存24h；pytdx 沪市列表协议不可用）"""
        if self._codes and time.time() - self._codes_time < self.CODES_CACHE_TTL:
            return self._codes
        codes = eastmoney.get_all_stock_codes()
        if codes:
            self._codes = codes
            self._codes_time = time.time()
            return codes
        return self._codes or []

    # ---------- 主入口 ----------

    def get(self, force: bool = False) -> Dict[str, Any]:
        """获取情绪+风格数据（带缓存）"""
        if not force and self._cache and (time.time() - self._cache_time) < CACHE_TTL:
            return self._cache
        if self._refreshing:
            return self._cache or {"error": "数据加载中"}
        self._refreshing = True
        try:
            self._cache = self._collect()
            self._cache_time = time.time()
            return self._cache
        except Exception as e:
            logger.error(f"情绪统计异常: {e}")
            return self._cache or {"error": f"数据获取失败: {e}"}
        finally:
            self._refreshing = False

    # ---------- 数据采集 ----------

    def _collect(self) -> Dict[str, Any]:
        zt = eastmoney.get_zt_pool()
        dt = eastmoney.get_dt_pool()
        zb = eastmoney.get_zb_pool()

        zt_count = len(zt)
        dt_count = len(dt)
        zb_count = len(zb)

        # 连板梯队
        ladder = self._ladder(zt)
        # 全市场涨跌家数 / 两市成交额（东财代码表 + pytdx 批量行情）
        # 注：不能用行业板块 f104/f105 求和——东财行业板块含多级嵌套会重复计数
        breadth = self._market_breadth(self._all_a_codes)
        up_count = breadth.get("up", 0)
        down_count = breadth.get("down", 0)
        total_amount = breadth.get("amount", 0)

        sentiment = {
            "zt_count": zt_count,
            "dt_count": dt_count,
            "zb_count": zb_count,
            # 炸板率 = 炸板 / (涨停 + 炸板)，衡量打板资金亏钱效应
            "zb_rate": round(zb_count / (zt_count + zb_count) * 100, 1) if (zt_count + zb_count) else 0,
            "up_count": up_count,
            "down_count": down_count,
            "total_amount_yi": round(total_amount / 1e8, 0),  # 亿元
            "ladder": ladder,
            "data_available": bool(zt or dt or up_count),
        }

        style = self._style(zt, dt, sentiment)
        return {"sentiment": sentiment, "style": style, "timestamp": time.time()}

    @staticmethod
    def _market_breadth(codes_provider) -> Dict[str, int]:
        """全市场涨跌家数与成交额：东财代码表 + 通达信批量行情统计"""
        breadth = {"up": 0, "down": 0, "amount": 0}
        try:
            codes = [(s["market"], s["code"]) for s in codes_provider()]
            for i in range(0, len(codes), 60):
                batch = codes[i:i + 60]
                quotes = data_source.get_security_quotes(batch)
                for q in quotes:
                    if q["last_close"] <= 0:
                        continue
                    if q["price"] > q["last_close"]:
                        breadth["up"] += 1
                    elif q["price"] < q["last_close"]:
                        breadth["down"] += 1
                    breadth["amount"] += q["amount"]
        except Exception as e:
            logger.warning(f"市场广度统计失败: {e}")
        return breadth

    def _ladder(self, zt: List[Dict[str, Any]]) -> Dict[str, Any]:
        """连板梯队：按连板高度分组"""
        by_height: Dict[int, List[Dict[str, Any]]] = {}
        for s in zt:
            h = int(s.get("lbc", 1) or 1)
            by_height.setdefault(h, []).append(s)
        heights = sorted(by_height.keys(), reverse=True)
        return {
            "max_height": heights[0] if heights else 0,
            "heights": [
                {
                    "height": h,
                    "count": len(by_height[h]),
                    "stocks": [
                        {"code": s["code"], "name": s["name"], "lbc": s["lbc"], "hybk": s.get("hybk", "")}
                        for s in sorted(by_height[h], key=lambda x: x.get("fbt", 0))[:10]
                    ],
                }
                for h in heights if h >= 2
            ][:8],
            "lianban_total": sum(len(v) for h, v in by_height.items() if h >= 2),
            "shouban_count": len(by_height.get(1, [])),
        }

    # ---------- 风格判定 ----------

    def _style(self, zt: List[Dict[str, Any]], dt: List[Dict[str, Any]],
               sentiment: Dict[str, Any]) -> Dict[str, Any]:
        """
        风格得分 0-100：越低越偏机构抱团，越高越偏题材妖股
        <35 抱团期 / 35-65 均衡 / >65 妖股期
        """
        factors: List[Dict[str, Any]] = []
        score = 50.0

        def add(name: str, value: float, weight: float, direction: str, detail: str):
            """direction: 'speculative' 加分 / 'institutional' 减分"""
            nonlocal score
            if direction == "speculative":
                score += value * weight
            else:
                score -= value * weight
            factors.append({"name": name, "detail": detail, "direction": direction,
                            "strength": round(value, 2)})

        # 因子1：连板股数量（>20只 妖股氛围）
        lianban_total = sentiment["ladder"]["lianban_total"]
        v = max(0.0, min(1.0, (lianban_total - 8) / 22))  # 8只以下0分，30只满分
        add("连板股数量", v, 0.30, "speculative" if v > 0.3 else "institutional",
            f"连板股 {lianban_total} 只（2板及以上）")

        # 因子2：涨停/跌停比 + 指数不涨（赚钱效应靠打板）
        ratio = sentiment["zt_count"] / sentiment["dt_count"] if sentiment["dt_count"] else 99
        idx_flat = self._index_flat()
        if ratio > 5 and idx_flat is not None and idx_flat < 0.5:
            add("涨停远多于跌停但指数平淡", 0.8, 0.20, "speculative",
                f"涨跌停比 {ratio:.1f}:1，沪深300 仅 {idx_flat:.2f}%")
        elif ratio > 5:
            add("涨停远多于跌停但指数平淡", 0.2, 0.20, "speculative",
                f"涨跌停比 {ratio:.1f}:1")

        # 因子3：沪深300 vs 中证1000 近20日相对强弱（抱团核心因子）
        rs = self._relative_strength()
        if rs is not None:
            v = max(-1.0, min(1.0, rs / 5))  # ±5% 强弱差满分
            add("大盘/小盘相对强弱(20日)", abs(v), 0.30,
                "institutional" if v > 0.1 else "speculative",
                f"沪深300 近20日 {'强于' if v > 0 else '弱于'} 中证1000 {abs(rs):.2f}%")

        # 因子4：涨停池市值结构（小市值妖股 vs 大中市值机构票）
        if zt:
            small = sum(1 for s in zt if s.get("ltsz", 0) and s["ltsz"] < 100e8)
            big = len(zt) - small
            v = max(0.0, min(1.0, (small / len(zt) - 0.6) / 0.35))
            add("涨停股市值结构", v, 0.20, "speculative",
                f"涨停股中流通市值<100亿 占 {small}/{len(zt)}")

        # score 从 50 基线出发，由各因子加减后收敛到 0-100
        score = max(0.0, min(100.0, score))
        if score >= 65:
            label = "题材妖股期"
            strategy = "打板/低吸强势股回调，快进快出，重视情绪退潮信号"
        elif score <= 35:
            label = "机构抱团期"
            strategy = "趋势跟随白马/龙头，回踩均线买入，持有周期放长"
        else:
            label = "均衡混合期"
            strategy = "趋势与题材并用，控制总仓位，避免追高"
        return {
            "score": round(score, 0),
            "label": label,
            "strategy": strategy,
            "factors": factors,
        }

    def _index_flat(self) -> Optional[float]:
        """沪深300 当日涨跌幅（判断指数是否平淡）"""
        try:
            quotes = data_source.get_security_quotes([(1, "000300")])
            if quotes:
                return quotes[0].get("change_pct", 0)
        except Exception:
            pass
        return None

    def _relative_strength(self) -> Optional[float]:
        """沪深300 与 中证1000 近20日涨幅差（正值=大盘强=抱团）"""
        try:
            import pandas as pd
            bars300 = data_source.get_security_bars("000300", 1, category=9, count=30)
            bars1000 = data_source.get_security_bars("000852", 1, category=9, count=30)
            if not bars300 or not bars1000:
                return None
            def ret20(bars):
                closes = [b["close"] for b in bars]
                if len(closes) < 21:
                    return None
                return (closes[-1] - closes[-21]) / closes[-21] * 100
            r300, r1000 = ret20(bars300), ret20(bars1000)
            if r300 is None or r1000 is None:
                return None
            return r300 - r1000
        except Exception:
            return None


market_sentiment = MarketSentiment()
