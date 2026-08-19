"""
数据源 - 通达信协议封装

提供 A 股实时行情、K线数据、基本面数据等
使用 pytdx 库，支持 TCP 协议连接通达信行情服务器
"""

import asyncio
import time
from typing import Optional, List, Dict, Any
from loguru import logger
from pytdx.config.hosts import hq_hosts
from pytdx.hq import TdxHq_API


class TdxDataSource:
    """通达信数据源封装"""

    def __init__(self):
        self.api: Optional[TdxHq_API] = None
        self.connected = False
        self.last_connect_time = 0
        self.connect_interval = 30

    def connect(self) -> bool:
        """连接行情服务器（自动选最优）"""
        if self.connected and (time.time() - self.last_connect_time) < self.connect_interval:
            return True

        try:
            self.api = TdxHq_API()
            best_host = None
            best_latency = float("inf")

            # 尝试多个服务器，选最优
            for host in hq_hosts[:5]:
                try:
                    start = time.time()
                    with self.api.connect(host["ip"], host["port"], time_out=3):
                        latency = time.time() - start
                        if latency < best_latency:
                            best_latency = latency
                            best_host = host
                            if latency < 0.1:
                                break
                except Exception as e:
                    logger.debug(f"{host} 连接失败: {e}")
                    continue

            if best_host:
                self.api = TdxHq_API()
                self.api.connect(best_host["ip"], best_host["port"])
                self.connected = True
                self.last_connect_time = time.time()
                logger.info(f"已连接通达信: {best_host['ip']} 延迟: {best_latency:.3f}s")
                return True
            else:
                logger.warning("所有服务器连接失败")
                return False
        except Exception as e:
            logger.error(f"连接异常: {e}")
            return False

    def disconnect(self):
        """断开连接"""
        if self.api:
            try:
                self.api.disconnect()
            except Exception:
                pass
        self.connected = False

    def ensure_connected(self) -> bool:
        """确保连接有效"""
        if not self.connected:
            return self.connect()
        if (time.time() - self.last_connect_time) > 60:
            try:
                self.api.disconnect()
            except Exception:
                pass
            self.connected = False
            return self.connect()
        return True

    def get_security_quotes(self, codes: List[tuple]) -> List[Dict[str, Any]]:
        """
        获取实时行情
        codes: [(market, code), ...]
        market: 0=深圳, 1=上海
        """
        if not self.ensure_connected():
            return []
        try:
            data = self.api.get_security_quotes(codes)
            results = []
            for d in data:
                results.append({
                    "code": d.get("code", ""),
                    "name": d.get("name", ""),
                    "price": float(d.get("price", 0)),
                    "open": float(d.get("open", 0)),
                    "high": float(d.get("high", 0)),
                    "low": float(d.get("low", 0)),
                    "last_close": float(d.get("last_close", 0)),
                    "change": float(d.get("change", 0)),
                    "change_pct": float(d.get("change_percent", 0)),
                    "volume": int(d.get("vol", 0)),
                    "amount": float(d.get("amount", 0)),
                    "bid1": float(d.get("bid1", 0)),
                    "ask1": float(d.get("ask1", 0)),
                    "bid1_vol": int(d.get("bid_vol1", 0)),
                    "ask1_vol": int(d.get("ask_vol1", 0)),
                    "timestamp": int(time.time() * 1000),
                })
            return results
        except Exception as e:
            logger.error(f"获取行情失败: {e}")
            self.connected = False
            return []

    def get_security_bars(
        self, code: str, market: int = 0,
        category: int = 9, start: int = 0, count: int = 100,
    ) -> List[Dict[str, Any]]:
        """
        获取K线数据
        category: 0=5分, 1=15分, 2=30分, 3=60分, 4=日, 5=周, 6=月, 8=1分, 9=日
        """
        if not self.ensure_connected():
            return []
        try:
            data = self.api.get_security_bars(category, market, code, start, count)
            results = []
            for d in data:
                results.append({
                    "datetime": str(d.get("datetime", "")),
                    "open": float(d.get("open", 0)),
                    "high": float(d.get("high", 0)),
                    "low": float(d.get("low", 0)),
                    "close": float(d.get("close", 0)),
                    "volume": int(d.get("vol", 0)),
                    "amount": float(d.get("amount", 0)),
                })
            return results
        except Exception as e:
            logger.error(f"获取K线失败: {e}")
            self.connected = False
            return []

    def get_stock_list(self, market: int = 1) -> List[Dict[str, Any]]:
        """获取股票列表"""
        if not self.ensure_connected():
            return []
        try:
            data = self.api.get_security_list(market, 0)
            results = []
            for d in data:
                results.append({
                    "code": d.get("code", ""),
                    "name": d.get("name", ""),
                    "market": market,
                })
            return results
        except Exception as e:
            logger.error(f"获取股票列表失败: {e}")
            self.connected = False
            return []

    def get_index_quotes(self, codes: List[tuple]) -> List[Dict[str, Any]]:
        """获取指数行情"""
        return self.get_security_quotes(codes)


# 全局单例
data_source = TdxDataSource()


def normalize_stock_code(code: str) -> tuple:
    """
    标准化股票代码，返回 (market, code)
    上证: 6开头 -> market=1
    深证: 0/3开头 -> market=0
    """
    code = code.strip()
    if code.startswith("6") or code.startswith("9"):
        return (1, code)
    elif code.startswith(("0", "3", "2")):
        return (0, code)
    else:
        return (0, code)
