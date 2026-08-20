"""
仓位管理引擎

- 资金账户：总资金（页面/工具可设置，持久化 account.json）
- 仓位体检：当前总仓位 vs 择时建议区间、单票 ≤25%、持仓数量 3-6 只、同行业合计 ≤40%
- 每只持仓的加减仓建议（金字塔加仓 / 分批兑现）
- 现金比例：永远保留 20-30% 机动资金提示
"""

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from loguru import logger

import eastmoney
from storage import storage
from data_source import data_source, normalize_stock_code
from market_timing import market_timing

SINGLE_STOCK_LIMIT = 25      # 单票仓位上限 %
SECTOR_LIMIT = 40            # 同行业合计上限 %


class PositionManager:

    def __init__(self):
        self.account: Dict[str, Any] = {"total_capital": 0, "updated": None}
        self._industry_cache: Dict[str, str] = {}  # code -> 行业

    # ---------- 账户 ----------

    def _file(self) -> Path:
        return storage.path("account.json")

    def load(self):
        f = self._file()
        if f.exists():
            try:
                self.account = json.loads(f.read_text(encoding="utf-8"))
            except Exception as e:
                logger.error(f"加载账户失败: {e}")

    def save(self):
        try:
            self._file().write_text(
                json.dumps(self.account, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error(f"保存账户失败: {e}")

    def set_capital(self, total: float) -> Dict[str, Any]:
        self.account["total_capital"] = float(total)
        self.account["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self.save()
        return self.account

    # ---------- 仓位体检 ----------

    def overview(self, holdings: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """holdings 来自 alert_engine.holdings"""
        result: Dict[str, Any] = {
            "total_capital": self.account.get("total_capital", 0),
            "holdings": [],
            "warnings": [],
            "timestamp": time.time(),
        }
        if not holdings:
            result["summary"] = "暂无持仓"
            return result

        market_codes = [normalize_stock_code(c) for c in holdings]
        quotes = data_source.get_security_quotes(market_codes) or []

        total_capital = result["total_capital"]
        total_value = 0.0
        rows: List[Dict[str, Any]] = []
        sector_values: Dict[str, float] = {}

        for q in quotes:
            code = q["code"]
            h = holdings.get(code)
            if not h:
                continue
            market_value = q["price"] * h["shares"]
            cost = h["buy_price"] * h["shares"]
            profit_pct = (q["price"] - h["buy_price"]) / h["buy_price"] * 100 if h["buy_price"] else 0
            weight = market_value / total_capital * 100 if total_capital else None
            industry = self._industry_of(code)
            if industry and market_value:
                sector_values[industry] = sector_values.get(industry, 0) + market_value
            rows.append({
                "code": code,
                "name": h["name"],
                "buy_price": h["buy_price"],
                "current_price": q["price"],
                "shares": h["shares"],
                "market_value": round(market_value, 0),
                "profit_pct": round(profit_pct, 2),
                "weight_pct": round(weight, 1) if weight is not None else None,
                "industry": industry,
                "advice": self._holding_advice(h, profit_pct),
            })
            total_value += market_value

        result["holdings"] = rows
        result["total_value"] = round(total_value, 0)

        if not total_capital:
            result["summary"] = "未设置总资金，无法计算仓位比例。请先设置总资金。"
            result["warnings"].append("未设置总资金（账户设置）")
            return result

        position_pct = total_value / total_capital * 100
        cash_pct = 100 - position_pct
        result["position_pct"] = round(position_pct, 1)
        result["cash_pct"] = round(cash_pct, 1)

        # 择时建议区间
        timing = market_timing.get()
        suggested = timing.get("suggested_position", "")
        lo, hi = self._parse_range(suggested)
        result["suggested_position"] = suggested
        result["timing_stage"] = timing.get("stage", {}).get("stage", "未知")

        # ---- 检查项 ----
        warnings = result["warnings"]
        if hi and position_pct > hi:
            warnings.append(f"总仓位 {position_pct:.0f}% 超过当前市场阶段建议上限 {hi}%，建议减仓")
        if lo and position_pct < lo and timing.get("stage", {}).get("stage") in ("主升", "震荡"):
            warnings.append(f"总仓位 {position_pct:.0f}% 低于建议区间 {suggested}，可择机加仓")
        if cash_pct < 20:
            warnings.append(f"现金仅 {cash_pct:.0f}%，低于 20% 安全线，失去机动资金")

        for r in rows:
            if r["weight_pct"] and r["weight_pct"] > SINGLE_STOCK_LIMIT:
                warnings.append(f"{r['name']} 单票仓位 {r['weight_pct']:.0f}% 超过 {SINGLE_STOCK_LIMIT}% 上限")

        n = len(rows)
        if n > 6:
            warnings.append(f"持仓 {n} 只偏多（建议 3-6 只），精力分散")
        elif n < 3:
            result.setdefault("notes", []).append(f"仅 {n} 只持仓，可再分散 1-2 只降低单票风险")

        for ind, val in sorted(sector_values.items(), key=lambda kv: -kv[1]):
            pct = val / total_capital * 100
            if pct > SECTOR_LIMIT:
                warnings.append(f"同行业「{ind}」合计仓位 {pct:.0f}% 超过 {SECTOR_LIMIT}% 上限，集中度过高")
            break  # 只报最高的一个

        result["summary"] = (
            f"当前总仓位 {position_pct:.0f}%（现金 {cash_pct:.0f}%），"
            f"市场阶段「{result['timing_stage']}」建议 {suggested}，"
            + ("仓位合规" if not warnings else f"{len(warnings)} 项风险提示")
        )
        return result

    # ---------- 内部 ----------

    def _industry_of(self, code: str) -> Optional[str]:
        if code in self._industry_cache:
            return self._industry_cache[code]
        market, _ = normalize_stock_code(code)
        ind = eastmoney.get_stock_industry(code, market)
        if ind:
            self._industry_cache[code] = ind
        return ind

    @staticmethod
    def _parse_range(s: str):
        """'70-80%' -> (70, 80)"""
        try:
            lo, hi = s.replace("%", "").split("-")
            return float(lo), float(hi)
        except (ValueError, AttributeError):
            return None, None

    @staticmethod
    def _holding_advice(h: Dict[str, Any], profit_pct: float) -> str:
        sl = h.get("stop_loss_pct", -7)
        tp = h.get("take_profit_pct", 15)
        if profit_pct <= sl:
            return "🛑 已触及止损位，纪律执行离场"
        if profit_pct >= 50:
            return "💰 盈利超50%，建议再兑现1/3，剩余移动止损持有"
        if profit_pct >= 20:
            return "💰 盈利超20%，建议兑现1/3锁定利润"
        if profit_pct >= tp:
            return "🎯 已到止盈位，可分批兑现"
        if 0 < profit_pct < 10:
            return "📈 走势正常持有；若趋势确立可用更小仓位金字塔加仓"
        if profit_pct >= -3:
            return "⏳ 观察期，不加仓；跌破止损位坚决离场"
        return "⚠️ 浮亏接近止损位，做好离场准备，不补仓摊薄"


position_manager = PositionManager()
