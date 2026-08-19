"""
WebSocket 连接管理器

管理所有 WebSocket 客户端连接，广播实时行情和预警
"""

import asyncio
import json
from typing import Set, Dict, Any
from fastapi import WebSocket
from loguru import logger


class WebSocketManager:
    """WebSocket 连接管理器"""

    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self.subscriptions: Dict[WebSocket, Set[str]] = {}

    async def connect(self, websocket: WebSocket):
        """接受新连接"""
        await websocket.accept()
        self.active_connections.add(websocket)
        self.subscriptions[websocket] = set()
        logger.info(f"WebSocket 已连接，当前连接数: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        """断开连接"""
        self.active_connections.discard(websocket)
        self.subscriptions.pop(websocket, None)
        logger.info(f"WebSocket 已断开，当前连接数: {len(self.active_connections)}")

    async def send_personal(self, websocket: WebSocket, message: Dict[str, Any]):
        """发送个人消息"""
        try:
            await websocket.send_json(message)
        except Exception as e:
            logger.debug(f"发送消息失败: {e}")
            await self.disconnect(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        """广播消息给所有连接"""
        if not self.active_connections:
            return
        disconnected = []
        for ws in list(self.active_connections):
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            await self.disconnect(ws)

    async def subscribe(self, websocket: WebSocket, codes: list):
        """订阅股票代码"""
        if websocket in self.subscriptions:
            self.subscriptions[websocket].update(codes)
            logger.debug(f"订阅: {codes}")

    async def unsubscribe(self, websocket: WebSocket, codes: list):
        """取消订阅"""
        if websocket in self.subscriptions:
            self.subscriptions[websocket].difference_update(codes)


ws_manager = WebSocketManager()


class QuoteBroadcaster:
    """行情广播器 - 定期推送实时行情"""

    def __init__(self, ws_manager: WebSocketManager):
        self.ws = ws_manager
        self.running = False

    async def start(self, interval: float = 3.0):
        """启动广播"""
        self.running = True
        asyncio.create_task(self._run(interval))

    async def stop(self):
        """停止广播"""
        self.running = False

    async def _run(self, interval: float):
        """广播循环"""
        from data_source import data_source, normalize_stock_code

        while self.running:
            try:
                if not self.ws.subscriptions:
                    await asyncio.sleep(interval)
                    continue

                all_codes = set()
                for codes in self.ws.subscriptions.values():
                    all_codes.update(codes)

                if not all_codes:
                    await asyncio.sleep(interval)
                    continue

                market_codes = []
                for code in all_codes:
                    market, sec_code = normalize_stock_code(code)
                    market_codes.append((market, sec_code))

                quotes = data_source.get_security_quotes(market_codes)
                if quotes:
                    await self.ws.broadcast({
                        "type": "quotes",
                        "data": quotes,
                        "timestamp": asyncio.get_event_loop().time(),
                    })
            except Exception as e:
                logger.error(f"广播异常: {e}")

            await asyncio.sleep(interval)


broadcaster = QuoteBroadcaster(ws_manager)
