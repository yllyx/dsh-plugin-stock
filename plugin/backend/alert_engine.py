"""
预警引擎 2.0 - 持仓止盈止损 + 自定义预警

止损止盈模式（stop_mode）：
- fixed:    固定百分比止损/止盈（默认，兼容旧数据）
- trailing: 移动止损 —— 盈利>5%后止损线上移到成本（保本），从最高点回撤超阈值触发
- ladder:   阶梯止盈 —— +20% 提示卖1/3，+50% 再卖1/3，剩余按移动止损保护

附加：时间止损（买入超5个交易日仍不赚钱 → 提示走势不符预期）
规则管理：预警规则可增删启停；触发历史持久化（最近200条）

只预警，不自动交易。
"""

import asyncio
import time
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any

from loguru import logger

from config import config
from storage import storage
from data_source import data_source, normalize_stock_code
from ws_manager import ws_manager


MAX_HISTORY = 200
TRADING_DAY_HOURS = 24  # 简化：用自然日近似交易日


class AlertEngine:
    """预警引擎"""

    def __init__(self):
        self.alerts: List[Dict[str, Any]] = []
        self.holdings: Dict[str, Dict[str, Any]] = {}
        self.history: List[Dict[str, Any]] = []
        self.last_check: Dict[str, float] = {}

    @property
    def cooldown(self) -> int:
        return config.alert_cooldown

    # ---------- 持久化 ----------

    def _file(self) -> Path:
        return storage.path("alerts.json")

    def load(self):
        f = self._file()
        if f.exists():
            try:
                with open(f, encoding="utf-8") as fh:
                    data = json.load(fh)
                self.holdings = data.get("holdings", {})
                # 旧数据兼容：补全 alerts_enabled 字段（默认全部开启）
                for code, h in self.holdings.items():
                    if "alerts_enabled" not in h:
                        h["alerts_enabled"] = {
                            "stop_loss": True, "take_profit": True, "trailing_stop": True,
                            "breakeven_stop": True, "ladder_tp": True, "time_stop": True,
                        }
                self.alerts = data.get("alerts", [])
                self.history = data.get("history", [])
                logger.info(f"加载 {len(self.holdings)} 持仓，{len(self.alerts)} 预警规则，{len(self.history)} 条历史")
            except Exception as e:
                logger.error(f"加载配置失败: {e}")

    def save(self):
        try:
            with open(self._file(), "w", encoding="utf-8") as f:
                json.dump({
                    "holdings": self.holdings,
                    "alerts": self.alerts,
                    "history": self.history[-MAX_HISTORY:],
                }, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"保存配置失败: {e}")

    # ---------- 持仓管理 ----------

    def add_holding(
        self, code: str, name: str,
        buy_price: float, shares: int,
        stop_loss_pct: float = -7,
        take_profit_pct: float = 15,
        stop_mode: str = "fixed",
        trail_drawdown_pct: float = 10,
    ):
        self.holdings[code] = {
            "name": name,
            "buy_price": buy_price,
            "shares": shares,
            "stop_loss_pct": stop_loss_pct,
            "take_profit_pct": take_profit_pct,
            "stop_mode": stop_mode,
            "trail_drawdown_pct": trail_drawdown_pct,
            "high_water_mark": buy_price,
            "buy_date": time.strftime("%Y-%m-%d"),
            # 每个预警类型可独立启用/暂停（默认全部开启）：
            # stop_loss(止损) take_profit(止盈) trailing_stop(移动止损) ladder_tp(阶梯) time_stop(时间)
            "alerts_enabled": {
                "stop_loss": True, "take_profit": True, "trailing_stop": True,
                "breakeven_stop": True, "ladder_tp": True, "time_stop": True,
            },
        }
        self.save()
        logger.info(f"已添加持仓: {code} {name} 模式={stop_mode}")

    def update_holding(self, code: str, updates: Dict[str, Any]) -> bool:
        """修改持仓的止盈止损参数"""
        if code not in self.holdings:
            return False
        allowed = {"stop_loss_pct", "take_profit_pct", "stop_mode",
                   "trail_drawdown_pct", "shares", "buy_price", "name"}
        for k, v in updates.items():
            if k in allowed:
                self.holdings[code][k] = v
        self.save()
        return True

    def remove_holding(self, code: str):
        if code in self.holdings:
            del self.holdings[code]
            self.save()
            logger.info(f"已删除持仓: {code}")

    # ---------- 预警规则管理 ----------

    def add_alert(self, code: str, alert_type: str, threshold: float = 0, message: str = ""):
        self.alerts.append({
            "id": f"{code}-{alert_type}-{int(time.time())}",
            "code": code,
            "type": alert_type,
            "threshold": threshold,
            "message": message,
            "enabled": True,
            "created": time.time(),
        })
        self.save()

    def remove_alert(self, alert_id: str) -> bool:
        before = len(self.alerts)
        self.alerts = [a for a in self.alerts if a.get("id") != alert_id]
        changed = len(self.alerts) < before
        if changed:
            self.save()
        return changed

    def toggle_alert(self, alert_id: str, enabled: bool) -> bool:
        for a in self.alerts:
            if a.get("id") == alert_id:
                a["enabled"] = enabled
                self.save()
                return True
        return False

    # ---------- 止盈止损 2.0 检查 ----------

    def _fire(self, triggered: List[Dict[str, Any]], item: Dict[str, Any], key: str):
        """冷却控制 + 记录 + 广播"""
        last = self.last_check.get(key, 0)
        if time.time() - last < self.cooldown:
            return
        self.last_check[key] = time.time()
        triggered.append(item)
        self.history.append(item)
        self.history = self.history[-MAX_HISTORY:]

    async def check_holdings(self) -> List[Dict[str, Any]]:
        if not self.holdings:
            return []

        codes = list(self.holdings.keys())
        market_codes = [normalize_stock_code(c) for c in codes]
        quotes = data_source.get_security_quotes(market_codes)
        if not quotes:
            return []

        triggered = []
        dirty = False
        today = time.strftime("%Y-%m-%d")

        for q in quotes:
            code = q["code"]
            h = self.holdings.get(code)
            if not h:
                continue
            buy_price = h["buy_price"]
            price = q["price"]
            if not buy_price or not price:
                continue

            profit_pct = (price - buy_price) / buy_price * 100
            mode = h.get("stop_mode", "fixed")
            trail_pct = h.get("trail_drawdown_pct", 10)
            enabled = h.get("alerts_enabled") or {}  # None/缺失 →所有开启
            disabled = {t for t, on in enabled.items() if not on}

            # 更新最高水位
            hwm = max(h.get("high_water_mark") or buy_price, price)
            if hwm != h.get("high_water_mark"):
                h["high_water_mark"] = hwm
                dirty = True
            drawdown_from_hwm = (price - hwm) / hwm * 100

            # 保本标记：曾盈利超5%
            if profit_pct > 5 and not h.get("_breakeven"):
                h["_breakeven"] = True
                dirty = True

            name = h["name"]

            # 1. 基础固定止损（所有模式都保留）
            if profit_pct <= h.get("stop_loss_pct", -7) and "stop_loss" not in disabled:
                self._fire(triggered, {
                    "type": "stop_loss", "code": code, "name": name, "price": price,
                    "profit_pct": round(profit_pct, 2),
                    "message": f"{name}({code}) 触及止损位 {h.get('stop_loss_pct', -7)}%，现亏 {profit_pct:.2f}%，纪律执行离场",
                    "severity": "high", "timestamp": time.time(),
                }, f"{code}:stop_loss")

            # 2. 模式化止盈止损
            if mode == "trailing":
                if (h.get("_breakeven") and price < buy_price and profit_pct > h.get("stop_loss_pct", -7)
                        and "breakeven_stop" not in disabled):
                    self._fire(triggered, {
                        "type": "breakeven_stop", "code": code, "name": name, "price": price,
                        "profit_pct": round(profit_pct, 2),
                        "message": f"{name}({code}) 曾盈利后跌回成本，保本止损触发（{profit_pct:.2f}%）",
                        "severity": "high", "timestamp": time.time(),
                    }, f"{code}:breakeven")
                if drawdown_from_hwm <= -trail_pct and profit_pct > 0 and "trailing_stop" not in disabled:
                    self._fire(triggered, {
                        "type": "trailing_stop", "code": code, "name": name, "price": price,
                        "profit_pct": round(profit_pct, 2),
                        "message": f"{name}({code}) 从高点{hwm:.2f}回撤{-drawdown_from_hwm:.1f}%（阈值{trail_pct}%），移动止损触发，仍盈利{profit_pct:.1f}%",
                        "severity": "medium", "timestamp": time.time(),
                    }, f"{code}:trailing")

            elif mode == "ladder":
                if profit_pct >= 20 and not h.get("_l20") and "ladder_tp" not in disabled:
                    h["_l20"] = True
                    dirty = True
                    self._fire(triggered, {
                        "type": "ladder_tp", "code": code, "name": name, "price": price,
                        "profit_pct": round(profit_pct, 2),
                        "message": f"{name}({code}) 盈利{profit_pct:.1f}% 达阶梯第一档(+20%)，建议卖出1/3锁定利润",
                        "severity": "medium", "timestamp": time.time(),
                    }, f"{code}:l20")
                if profit_pct >= 50 and not h.get("_l50") and "ladder_tp" not in disabled:
                    h["_l50"] = True
                    dirty = True
                    self._fire(triggered, {
                        "type": "ladder_tp", "code": code, "name": name, "price": price,
                        "profit_pct": round(profit_pct, 2),
                        "message": f"{name}({code}) 盈利{profit_pct:.1f}% 达阶梯第二档(+50%)，建议再卖1/3，剩余移动止盈持有",
                        "severity": "medium", "timestamp": time.time(),
                    }, f"{code}:l50")
                if h.get("_l50") and drawdown_from_hwm <= -10 and "trailing_stop" not in disabled:
                    self._fire(triggered, {
                        "type": "trailing_stop", "code": code, "name": name, "price": price,
                        "profit_pct": round(profit_pct, 2),
                        "message": f"{name}({code}) 高点回撤{-drawdown_from_hwm:.1f}%，尾仓移动止盈保护触发",
                        "severity": "medium", "timestamp": time.time(),
                    }, f"{code}:trailing")

            else:  # fixed
                if profit_pct >= h.get("take_profit_pct", 15) and "take_profit" not in disabled:
                    self._fire(triggered, {
                        "type": "take_profit", "code": code, "name": name, "price": price,
                        "profit_pct": round(profit_pct, 2),
                        "message": f"{name}({code}) 触及止盈位 {h.get('take_profit_pct', 15)}%，现盈利 {profit_pct:.2f}%，可分批兑现",
                        "severity": "medium", "timestamp": time.time(),
                    }, f"{code}:take_profit")

            # 3. 时间止损（所有模式）：买入超5个交易日且盈利不足2%
            buy_date = h.get("buy_date")
            if buy_date:
                try:
                    days = (datetime.now() - datetime.strptime(buy_date, "%Y-%m-%d")).days
                    if days >= 7 and profit_pct < 2 and h.get("_time_alert_date") != today and "time_stop" not in disabled:
                        h["_time_alert_date"] = today
                        dirty = True
                        self._fire(triggered, {
                            "type": "time_stop", "code": code, "name": name, "price": price,
                            "profit_pct": round(profit_pct, 2),
                            "message": f"{name}({code}) 买入已{days}天仍无像样涨幅（{profit_pct:.2f}%），时间止损提醒：判断可能出错",
                            "severity": "low", "timestamp": time.time(),
                        }, f"{code}:time")
                except (ValueError, TypeError):
                    pass

        if dirty:
            self.save()

        if triggered:
            for t in triggered:
                await ws_manager.broadcast({"type": "alert", "data": t})
            self.save()

        return triggered

    # ---------- 自定义预警 ----------

    async def check_custom_alerts(self) -> List[Dict[str, Any]]:
        if not self.alerts:
            return []

        triggered = []
        codes = list(set(a["code"] for a in self.alerts if a.get("enabled")))
        market_codes = [normalize_stock_code(c) for c in codes]
        if not market_codes:
            return []

        quotes = data_source.get_security_quotes(market_codes)
        for q in quotes:
            code = q["code"]
            for alert in self.alerts:
                if alert["code"] != code or not alert.get("enabled"):
                    continue
                item = None
                if alert["type"] == "price_above" and q["price"] >= alert["threshold"]:
                    item = {"type": "price_above", "code": code, "name": q.get("name", code), "price": q["price"],
                            "message": f"{q.get('name', code)}({code}) 突破 {alert['threshold']}",
                            "severity": "medium", "timestamp": time.time()}
                elif alert["type"] == "price_below" and q["price"] <= alert["threshold"]:
                    item = {"type": "price_below", "code": code, "name": q.get("name", code), "price": q["price"],
                            "message": f"{q.get('name', code)}({code}) 跌破 {alert['threshold']}",
                            "severity": "high", "timestamp": time.time()}
                elif alert["type"] == "change_pct_above" and q["change_pct"] >= alert["threshold"]:
                    item = {"type": "change_pct_above", "code": code, "name": q.get("name", code),
                            "change_pct": q["change_pct"],
                            "message": f"{q.get('name', code)}({code}) 涨幅超 {alert['threshold']}%",
                            "severity": "medium", "timestamp": time.time()}
                if item:
                    self._fire(triggered, item, f"{code}:{alert['type']}:{alert['id']}")

        if triggered:
            for t in triggered:
                await ws_manager.broadcast({"type": "alert", "data": t})
            self.save()

        return triggered

    async def run_loop(self, interval: int = 30):
        logger.info(f"预警引擎启动（间隔 {config.alert_interval}s，冷却 {config.alert_cooldown}s）")
        while True:
            try:
                await self.check_holdings()
                await self.check_custom_alerts()
            except Exception as e:
                logger.error(f"预警检查异常: {e}")
            await asyncio.sleep(config.alert_interval)


alert_engine = AlertEngine()
