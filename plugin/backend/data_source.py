"""
数据源 - 通达信协议封装

提供 A 股实时行情、K线数据、基本面数据等
使用 pytdx 库，支持 TCP 协议连接通达信行情服务器
"""

import asyncio
import threading
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
        self._connect_lock = threading.Lock()

    def connect(self) -> bool:
        """连接行情服务器（自动选可用）。并发调用时只允许一个探测进行中。"""
        if self.connected and (time.time() - self.last_connect_time) < self.connect_interval:
            return True
        if not self._connect_lock.acquire(blocking=False):
            # 已有探测在进行，短暂等待其结果
            for _ in range(50):
                if self.connected:
                    return True
                time.sleep(0.2)
            return self.connected
        try:
            for host in hq_hosts[:8]:
                try:
                    ip, port = self._host_addr(host)
                    probe_api = TdxHq_API()
                    start = time.time()
                    probe_api.connect(ip, port, time_out=2.5)
                    q = probe_api.get_security_quotes([(1, "600519")])
                    latency = time.time() - start
                    if q and q[0].get("price"):
                        self.api = probe_api
                        self.connected = True
                        self.last_connect_time = time.time()
                        logger.info(f"已连接通达信: {ip} 延迟: {latency:.3f}s（数据验证通过）")
                        return True
                    probe_api.disconnect()
                except Exception as e:
                    logger.debug(f"{host} 连接失败: {e}")
                    continue

            logger.warning("所有服务器连接失败")
            return False
        except Exception as e:
            logger.error(f"连接异常: {e}")
            return False
        finally:
            self._connect_lock.release()

    @staticmethod
    def _host_addr(host) -> tuple:
        """hq_hosts 条目可能是元组 (name, ip, port) 或字典 {ip, port}"""
        if isinstance(host, dict):
            return host["ip"], host["port"]
        return host[1], host[2]

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

        注意：pytdx 行情不含 name/change_percent 字段，
        name 由调用方补充（指数用 display_name，个股用持仓/股票池名），
        涨跌幅从昨收价计算。
        """
        if not self.ensure_connected():
            return []
        try:
            data = self.api.get_security_quotes(codes)
            results = []
            for d in data or []:
                price = float(d.get("price", 0) or 0)
                last_close = float(d.get("last_close", 0) or 0)
                change = price - last_close if last_close else 0.0
                change_pct = change / last_close * 100 if last_close else 0.0
                results.append({
                    "code": d.get("code", ""),
                    "name": d.get("name", "") or "",
                    "price": price,
                    "open": float(d.get("open", 0) or 0),
                    "high": float(d.get("high", 0) or 0),
                    "low": float(d.get("low", 0) or 0),
                    "last_close": last_close,
                    "change": round(change, 3),
                    "change_pct": round(change_pct, 3),
                    "volume": int(d.get("vol", 0) or 0),
                    "amount": float(d.get("amount", 0) or 0),
                    "bid1": float(d.get("bid1", 0) or 0),
                    "ask1": float(d.get("ask1", 0) or 0),
                    "bid1_vol": int(d.get("bid_vol1", 0) or 0),
                    "ask1_vol": int(d.get("ask_vol1", 0) or 0),
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
        获取K线数据（统一入口，自动路由数据源）
        category: 0=5分, 1=15分, 2=30分, 3=60分, 4=日, 5=周, 6=月, 9=日

        路由规则（2026-08 实测）：
        - 指数：pytdx get_index_bars（协议干净；个股命令 get_security_bars
          在新版服务器返回的数据上解析错位，已不可用）
        - 个股：东财 push2his K线接口
        """
        from eastmoney import get_kline

        if self._is_index(code, market):
            return self._index_bars(code, market, category, start, count)

        klt = {9: 101, 4: 101, 5: 102, 6: 103, 0: 5, 1: 15, 2: 30, 3: 60, 8: 1}.get(category, 101)
        bars = get_kline(f"{market}.{code}", klt=klt, lmt=count)
        return bars[start:start + count] if start else bars

    @staticmethod
    def _is_index(code: str, market: int) -> bool:
        """指数判定：沪市 000/880/899 开头，深市 399 开头"""
        if market == 1:
            return code.startswith(("000", "880", "899"))
        if market == 0:
            return code.startswith("399")
        return False

    def _index_bars(
        self, code: str, market: int,
        category: int, start: int, count: int,
    ) -> List[Dict[str, Any]]:
        """指数K线：pytdx get_index_bars，按单次800根上限分页"""
        if not self.ensure_connected():
            return []
        try:
            chunks: List[List[Dict[str, Any]]] = []
            fetched = 0
            offset = start
            while fetched < count:
                n = min(800, count - fetched)
                data = self.api.get_index_bars(category, market, code, offset, n) or []
                if not data:
                    break
                chunks.append(data)
                fetched += len(data)
                offset += len(data)
                if len(data) < n:
                    break
            merged: List[Dict[str, Any]] = []
            for chunk in reversed(chunks):
                merged.extend(chunk)

            results = []
            for d in merged:
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
            logger.error(f"获取指数K线失败: {e}")
            self.connected = False
            return []

    def get_stock_list(self, market: int = 1) -> List[Dict[str, Any]]:
        """获取证券列表（分页拉全）。包含股票/基金/债券，调用方按代码前缀过滤"""
        if not self.ensure_connected():
            return []
        results = []
        start = 0
        try:
            while True:
                data = self.api.get_security_list(market, start) or []
                for d in data:
                    results.append({
                        "code": d.get("code", ""),
                        "name": d.get("name", ""),
                        "market": market,
                    })
                if len(data) < 1000:
                    break
                start += len(data)
            return results
        except Exception as e:
            logger.error(f"获取股票列表失败: {e}")
            self.connected = False
            return results

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
