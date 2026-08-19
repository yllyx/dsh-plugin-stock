"""
预警引擎

负责监控持仓股票和关注股票的价格变动、止盈止损、技术指标
"""

import asyncio
import time
import json
from pathlib import Path
from typing import Dict, List, Any, Optional
from loguru import logger

from data_source import data_source, normalize_stock_code
from ws_manager import ws_manager


ALERTS_FILE = Path(__file__).parent / "alerts.json"


class AlertEngine:
    """预警引擎"""

    def __init__(self):
        self.alerts: List[Dict[str, Any]] = []
        self.holdings: Dict[str, Dict[str, Any]] = {}
        self.last_check: Dict[str, float] = {}
        self.cooldown = 300

    def load(self):
        """加载配置"""
        if ALERTS_FILE.exists():
            try:
                with open(ALERTS_FILE, encoding="utf-8") as f:
                    data = json.load(f)
                self.holdings = data.get("holdings", {})
                self.alerts = data.get("alerts", [])
                logger.info(f"加载 {len(self.holdings)} 持仓，{len(self.alerts)} 预警规则")
            except Exception as e:
                logger.error(f"加载配置失败: {e}")

    def save(self):
        """保存配置"""
        try:
            with open(ALERTS_FILE, "w", encoding="utf-8") as f:
                json.dump({
                    "holdings": self.holdings,
                    "alerts": self.alerts,
                }, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"保存配置失败: {e}")

    def add_holding(
        self, code: str, name: str,
        buy_price: float, shares: int,
        stop_loss_pct: float = -7,
        take_profit_pct: float = 15,
    ):
        """添加持仓"""
        self.holdings[code] = {
            "name": name,
            "buy_price": buy_price,
            "shares": shares,
            "stop_loss_pct": stop_loss_pct,
            "take_profit_pct": take_profit_pct,
            "buy_date": time.strftime("%Y-%m-%d"),
        }
        self.save()
        logger.info(f"已添加持仓: {code} {name}")

    def remove_holding(self, code: str):
        """删除持仓"""
        if code in self.holdings:
            del self.holdings[code]
            self.save()
            logger.info(f"已删除持仓: {code}")

    def add_alert(
        self, code: str, alert_type: str,
        threshold: float = 0,
        message: str = "",
    ):
        """添加预警规则"""
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

    async def check_holdings(self) -> List[Dict[str, Any]]:
        """检查持仓的止盈止损"""
        if not self.holdings:
            return []

        triggered = []
        codes = list(self.holdings.keys())
        market_codes = []
        for code in codes:
            market, sec_code = normalize_stock_code(code)
            market_codes.append((market, sec_code))

        quotes = data_source.get_security_quotes(market_codes)
        if not quotes:
            return []

        for q in quotes:
            code = q["code"]
            if code not in self.holdings:
                continue

            holding = self.holdings[code]
            buy_price = holding["buy_price"]
            current_price = q["price"]

            if buy_price == 0:
                continue

            profit_pct = (current_price - buy_price) / buy_price * 100
            last_check_time = self.last_check.get(code, 0)

            if profit_pct <= holding["stop_loss_pct"]:
                if (time.time() - last_check_time) > self.cooldown:
                    triggered.append({
                        "type": "stop_loss",
                        "code": code,
                        "name": holding["name"],
                        "price": current_price,
                        "profit_pct": profit_pct,
                        "message": f"{holding['name']}({code}) 触及止损位，亏损 {profit_pct:.2f}%",
                        "severity": "high",
                        "timestamp": time.time(),
                    })
                    self.last_check[code] = time.time()
            elif profit_pct >= holding["take_profit_pct"]:
                if (time.time() - last_check_time) > self.cooldown:
                    triggered.append({
                        "type": "take_profit",
                        "code": code,
                        "name": holding["name"],
                        "price": current_price,
                        "profit_pct": profit_pct,
                        "message": f"{holding['name']}({code}) 触及止盈位，盈利 {profit_pct:.2f}%",
                        "severity": "medium",
                        "timestamp": time.time(),
                    })
                    self.last_check[code] = time.time()

        if triggered:
            for t in triggered:
                await ws_manager.broadcast({
                    "type": "alert",
                    "data": t,
                })

        return triggered

    async def check_custom_alerts(self) -> List[Dict[str, Any]]:
        """检查自定义预警"""
        if not self.alerts:
            return []

        triggered = []
        codes = list(set(a["code"] for a in self.alerts if a.get("enabled")))
        market_codes = []
        for code in codes:
            market, sec_code = normalize_stock_code(code)
            market_codes.append((market, sec_code))

        if not market_codes:
            return []

        quotes = data_source.get_security_quotes(market_codes)
        for q in quotes:
            code = q["code"]
            for alert in self.alerts:
                if alert["code"] != code or not alert.get("enabled"):
                    continue

                if alert["type"] == "price_above" and q["price"] >= alert["threshold"]:
                    triggered.append({
                        "type": "price_above",
                        "code": code,
                        "price": q["price"],
                        "message": f"{code} 突破 {alert['threshold']}",
                        "timestamp": time.time(),
                    })
                elif alert["type"] == "price_below" and q["price"] <= alert["threshold"]:
                    triggered.append({
                        "type": "price_below",
                        "code": code,
                        "price": q["price"],
                        "message": f"{code} 跌破 {alert['threshold']}",
                        "timestamp": time.time(),
                    })
                elif alert["type"] == "change_pct_above" and q["change_pct"] >= alert["threshold"]:
                    triggered.append({
                        "type": "change_pct_above",
                        "code": code,
                        "change_pct": q["change_pct"],
                        "message": f"{code} 涨幅超 {alert['threshold']}%",
                        "timestamp": time.time(),
                    })

        if triggered:
            for t in triggered:
                await ws_manager.broadcast({"type": "alert", "data": t})

        return triggered

    async def run_loop(self, interval: int = 30):
        """主循环"""
        logger.info(f"预警引擎启动，检查间隔 {interval}s")
        while True:
            try:
                await self.check_holdings()
                await self.check_custom_alerts()
            except Exception as e:
                logger.error(f"预警检查异常: {e}")
            await asyncio.sleep(interval)


alert_engine = AlertEngine()
