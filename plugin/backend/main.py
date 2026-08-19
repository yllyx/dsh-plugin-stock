"""
DSH 股票插件 - Python 后端主入口

启动 FastAPI 服务，提供：
- REST API: 行情、K线、选股、持仓
- WebSocket: 实时推送
- 预警引擎
"""

import asyncio
import sys
import json
import time
from pathlib import Path
from contextlib import asynccontextmanager
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, WebSocket, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from loguru import logger

from data_source import data_source, normalize_stock_code
from screener import run_screen, calculate_market_temperature
from alert_engine import alert_engine
from ws_manager import ws_manager, broadcaster


# 配置日志
logger.remove()
logger.add(sys.stderr, level="INFO")


# ============= 数据模型 =============
class Holding(BaseModel):
    code: str
    name: str
    buy_price: float
    shares: int
    stop_loss_pct: float = -7
    take_profit_pct: float = 15
    buy_date: Optional[str] = None


class AlertRule(BaseModel):
    code: str
    type: str
    threshold: float = 0
    message: str = ""


class ScreenRequest(BaseModel):
    screen_type: str
    stock_pool: Optional[List[str]] = None
    max_results: int = 30


# ============= 应用生命周期 =============
@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动/关闭时执行"""
    logger.info("DSH 股票后端启动...")

    # 加载预警配置
    alert_engine.load()

    # 连接行情服务
    if data_source.connect():
        logger.info("通达信行情服务已连接")
    else:
        logger.warning("通达信行情服务连接失败，将以模拟数据运行")

    # 启动后台任务
    broadcaster_task = asyncio.create_task(broadcaster.start(interval=3))
    alert_task = asyncio.create_task(alert_engine.run_loop(interval=30))

    yield

    # 关闭
    logger.info("DSH 股票后端关闭...")
    broadcaster.running = False
    alert_engine.save()
    data_source.disconnect()


app = FastAPI(
    title="DSH Stock Plugin API",
    description="DSH 股票插件后端 API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============= 健康检查 =============
@app.get("/health")
async def health():
    """健康检查"""
    return {
        "status": "ok",
        "data_connected": data_source.connected,
        "websocket_clients": len(ws_manager.active_connections),
        "holdings_count": len(alert_engine.holdings),
        "alerts_count": len(alert_engine.alerts),
    }


# ============= 行情 API =============
@app.get("/api/quote/{code}")
async def get_quote(code: str):
    """获取单只股票实时行情"""
    market, sec_code = normalize_stock_code(code)
    quotes = data_source.get_security_quotes([(market, sec_code)])
    if not quotes:
        raise HTTPException(status_code=404, detail="未获取到行情")
    return quotes[0]


@app.post("/api/quotes")
async def get_quotes(codes: List[str]):
    """批量获取行情"""
    market_codes = [normalize_stock_code(c) for c in codes]
    quotes = data_source.get_security_quotes(market_codes)
    return {"quotes": quotes, "count": len(quotes)}


@app.get("/api/index-quotes")
async def get_index_quotes():
    """获取主要指数行情"""
    indices = [
        ("000001", "上证指数"),
        ("399001", "深证成指"),
        ("000300", "沪深300"),
        ("000905", "中证500"),
        ("399006", "创业板指"),
    ]
    market_codes = [normalize_stock_code(c) for c, _ in indices]
    quotes = data_source.get_security_quotes(market_codes)

    result = {}
    for i, (code, name) in enumerate(indices):
        if i < len(quotes):
            result[code] = quotes[i]
            result[code]["display_name"] = name

    # 计算大盘温度
    temperature = calculate_market_temperature(result)
    return {
        "indices": result,
        "temperature": temperature,
        "timestamp": time.time(),
    }


# ============= K线 API =============
@app.get("/api/kline/{code}")
async def get_kline(
    code: str,
    category: int = Query(9, description="K线类型: 9=日, 4=日, 5=周, 6=月"),
    count: int = Query(250, description="K线数量"),
):
    """获取K线数据"""
    market, sec_code = normalize_stock_code(code)
    bars = data_source.get_security_bars(sec_code, market, category=category, count=count)
    return {
        "code": code,
        "category": category,
        "data": bars,
        "count": len(bars),
    }


# ============= 选股 API =============
@app.post("/api/screen")
async def screen_stocks(req: ScreenRequest):
    """执行选股"""
    results = await run_screen(req.screen_type, req.stock_pool, req.max_results)
    return {"results": results, "count": len(results)}


@app.get("/api/screen/types")
async def screen_types():
    """获取可选的选股类型"""
    return {
        "types": [
            {"id": "institutional", "name": "机构抱团股", "description": "趋势跟随，适合主升浪"},
            {"id": "breakout", "name": "启动股", "description": "捕捉主升浪起点"},
            {"id": "trend", "name": "均线多头", "description": "经典趋势策略"},
            {"id": "speculative", "name": "题材妖股", "description": "短线博弈"},
        ]
    }


# ============= 持仓 API =============
@app.get("/api/holdings")
async def list_holdings():
    """获取所有持仓"""
    return {"holdings": alert_engine.holdings}


@app.post("/api/holdings")
async def add_holding(holding: Holding):
    """添加持仓"""
    alert_engine.add_holding(
        holding.code, holding.name,
        holding.buy_price, holding.shares,
        holding.stop_loss_pct, holding.take_profit_pct,
    )
    return {"status": "ok"}


@app.delete("/api/holdings/{code}")
async def delete_holding(code: str):
    """删除持仓"""
    alert_engine.remove_holding(code)
    return {"status": "ok"}


@app.post("/api/holdings/refresh")
async def refresh_holdings():
    """刷新持仓最新价格"""
    codes = list(alert_engine.holdings.keys())
    if not codes:
        return {"holdings": [], "total_value": 0, "total_profit": 0}

    market_codes = [normalize_stock_code(c) for c in codes]
    quotes = data_source.get_security_quotes(market_codes)

    refreshed = []
    total_value = 0
    total_cost = 0
    for q in quotes:
        code = q["code"]
        if code not in alert_engine.holdings:
            continue
        h = alert_engine.holdings[code]
        market_value = q["price"] * h["shares"]
        cost = h["buy_price"] * h["shares"]
        profit_pct = (q["price"] - h["buy_price"]) / h["buy_price"] * 100 if h["buy_price"] else 0

        refreshed.append({
            "code": code,
            "name": h["name"],
            "buy_price": h["buy_price"],
            "current_price": q["price"],
            "shares": h["shares"],
            "market_value": market_value,
            "cost": cost,
            "profit_pct": profit_pct,
            "profit_amount": market_value - cost,
            "change_pct": q["change_pct"],
            "stop_loss_pct": h.get("stop_loss_pct", -7),
            "take_profit_pct": h.get("take_profit_pct", 15),
        })
        total_value += market_value
        total_cost += cost

    return {
        "holdings": refreshed,
        "total_value": total_value,
        "total_cost": total_cost,
        "total_profit": total_value - total_cost,
        "total_profit_pct": ((total_value - total_cost) / total_cost * 100) if total_cost else 0,
    }


# ============= 预警 API =============
@app.get("/api/alerts")
async def list_alerts():
    """获取预警规则"""
    return {"alerts": alert_engine.alerts}


@app.post("/api/alerts")
async def add_alert(rule: AlertRule):
    """添加预警"""
    alert_engine.add_alert(rule.code, rule.type, rule.threshold, rule.message)
    return {"status": "ok"}


# ============= WebSocket =============
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket 端点"""
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")

            if action == "subscribe":
                codes = data.get("codes", [])
                await ws_manager.subscribe(websocket, codes)
                await ws_manager.send_personal(websocket, {
                    "type": "subscribed",
                    "codes": codes,
                })
            elif action == "unsubscribe":
                codes = data.get("codes", [])
                await ws_manager.unsubscribe(websocket, codes)
            elif action == "ping":
                await ws_manager.send_personal(websocket, {
                    "type": "pong",
                    "timestamp": time.time(),
                })
    except Exception as e:
        logger.debug(f"WebSocket 异常: {e}")
    finally:
        await ws_manager.disconnect(websocket)


# ============= 启动 =============
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8765,
        reload=False,
        log_level="info",
    )
