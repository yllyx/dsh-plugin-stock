"""
DSH 股票插件 - Python 后端主入口

提供：
- REST API: 行情、K线、择时、情绪/风格、板块/龙头、仓位、选股、持仓、预警
- WebSocket: 实时推送
- 预警引擎 + 情绪缓存刷新循环 + 全市场预热池
"""

import asyncio
import sys
import time
from contextlib import asynccontextmanager
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, WebSocket, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from loguru import logger

from data_source import data_source, normalize_stock_code
from screener import run_screen, market_pool
from alert_engine import alert_engine
from ws_manager import ws_manager, broadcaster
from market_timing import market_timing
from market_sentiment import market_sentiment
from sector_monitor import sector_monitor
from position_manager import position_manager


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
    stop_mode: str = "fixed"          # fixed | trailing | ladder
    trail_drawdown_pct: float = 10


class HoldingUpdate(BaseModel):
    stop_loss_pct: Optional[float] = None
    take_profit_pct: Optional[float] = None
    stop_mode: Optional[str] = None
    trail_drawdown_pct: Optional[float] = None
    shares: Optional[int] = None
    buy_price: Optional[float] = None


class AlertRule(BaseModel):
    code: str
    type: str
    threshold: float = 0
    message: str = ""


class AlertRuleUpdate(BaseModel):
    enabled: bool


class AccountUpdate(BaseModel):
    total_capital: float


class ScreenRequest(BaseModel):
    screen_type: str
    stock_pool: Optional[List[str]] = None
    max_results: int = 30
    pool: Optional[str] = None       # "market" 走全市场预热缓存


# ============= 指数定义（市场代码显式指定，避免 000001 等被误判为深市个股） =============
INDEX_LIST = [
    (1, "000001", "上证指数"),
    (1, "000300", "沪深300"),
    (0, "399001", "深证成指"),
    (0, "399006", "创业板指"),
    (1, "000905", "中证500"),
]


# ============= 后台循环 =============
async def connection_keepalive_loop():
    """
    后台维持通达信连接：启动时不阻塞端口监听（旧版在 lifespan 里同步 connect，
    网络差时串行探测多台服务器可达几十秒，导致健康检查15秒超时被杀）。
    未连接时每 30s 重试；连接由各 API 的 ensure_connected 兜底。
    """
    while True:
        try:
            if not data_source.connected:
                await asyncio.to_thread(data_source.connect)
        except Exception as e:
            logger.debug(f"连接维持失败: {e}")
        await asyncio.sleep(30)


async def sentiment_refresh_loop():
    """每 60s 用线程刷新情绪/风格缓存，避免阻塞事件循环"""
    while True:
        try:
            await asyncio.to_thread(market_sentiment.get, True)
        except Exception as e:
            logger.debug(f"情绪刷新失败: {e}")
        await asyncio.sleep(60)


# ============= 应用生命周期 =============
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("DSH 股票后端启动...")

    alert_engine.load()
    position_manager.load()

    # 连接放后台任务，端口立即可监听（健康检查窗口只有15秒）
    logger.info("行情连接将在后台建立（不阻塞启动）")
    keepalive_task = asyncio.create_task(connection_keepalive_loop())
    broadcaster_task = asyncio.create_task(broadcaster.start(interval=3))
    alert_task = asyncio.create_task(alert_engine.run_loop(interval=30))
    sentiment_task = asyncio.create_task(sentiment_refresh_loop())
    market_pool.start()

    yield

    logger.info("DSH 股票后端关闭...")
    broadcaster.running = False
    market_pool.stop()
    for task in (keepalive_task, alert_task, sentiment_task):
        task.cancel()
    alert_engine.save()
    position_manager.save()
    data_source.disconnect()


app = FastAPI(
    title="DSH Stock Plugin API",
    description="DSH 股票插件后端 API（择时/情绪/板块/仓位/止盈止损/选股）",
    version="2.0.0",
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
    return {
        "status": "ok",
        "data_connected": data_source.connected,
        "websocket_clients": len(ws_manager.active_connections),
        "holdings_count": len(alert_engine.holdings),
        "alerts_count": len(alert_engine.alerts),
        "market_pool": market_pool.status(),
    }


# ============= 行情 API =============
@app.get("/api/quote/{code}")
async def get_quote(code: str):
    market, sec_code = normalize_stock_code(code)
    quotes = await asyncio.to_thread(data_source.get_security_quotes, [(market, sec_code)])
    if not quotes:
        raise HTTPException(status_code=404, detail="未获取到行情")
    return quotes[0]


@app.post("/api/quotes")
async def get_quotes(codes: List[str]):
    market_codes = [normalize_stock_code(c) for c in codes]
    quotes = await asyncio.to_thread(data_source.get_security_quotes, market_codes)
    return {"quotes": quotes, "count": len(quotes)}


@app.get("/api/index-quotes")
async def get_index_quotes():
    """主要指数行情（市场代码显式指定）"""
    market_codes = [(m, c) for m, c, _ in INDEX_LIST]
    quotes = await asyncio.to_thread(data_source.get_security_quotes, market_codes)

    result = {}
    for i, (_, code, name) in enumerate(INDEX_LIST):
        if i < len(quotes):
            result[code] = quotes[i]
            result[code]["display_name"] = name

    return {
        "indices": result,
        "timestamp": time.time(),
    }


# ============= K线 API =============
@app.get("/api/kline/{code}")
async def get_kline(
    code: str,
    category: int = Query(9, description="K线类型: 9=日, 5=周, 6=月"),
    count: int = Query(250, description="K线数量"),
):
    market, sec_code = normalize_stock_code(code)
    bars = await asyncio.to_thread(
        data_source.get_security_bars, sec_code, market, category, 0, count)
    return {
        "code": code,
        "category": category,
        "data": bars,
        "count": len(bars),
    }


# ============= 择时 / 情绪 / 板块 =============
@app.get("/api/market/timing")
async def get_market_timing():
    """大盘择时：跌无可跌清单 + 企稳信号 + 阶段判定 + 建议仓位"""
    return await asyncio.to_thread(market_timing.get)


@app.get("/api/market/sentiment")
async def get_market_sentiment():
    """市场情绪统计 + 风格判定（抱团 vs 妖股）"""
    return await asyncio.to_thread(market_sentiment.get)


@app.get("/api/sectors")
async def get_sectors(
    board_type: str = Query("industry", description="industry=行业, concept=概念"),
    top_n: int = Query(15, ge=5, le=50),
):
    """板块排行（含5日动量与阶段标签）"""
    return await asyncio.to_thread(sector_monitor.get_ranking, board_type, top_n)


@app.get("/api/sectors/{bk_code}/leaders")
async def get_sector_leaders(
    bk_code: str,
    name: str = Query("", description="板块名（展示用）"),
    top_n: int = Query(5, ge=3, le=10),
):
    """板块龙头候选（打分+理由）"""
    return await asyncio.to_thread(sector_monitor.get_leaders, bk_code, name, top_n)


# ============= 账户与仓位 =============
@app.get("/api/account")
async def get_account():
    return position_manager.account


@app.put("/api/account")
async def update_account(req: AccountUpdate):
    if req.total_capital <= 0:
        raise HTTPException(status_code=400, detail="总资金必须大于0")
    return position_manager.set_capital(req.total_capital)


@app.get("/api/position/overview")
async def get_position_overview():
    """仓位体检：当前仓位 vs 建议 + 风险提示 + 每只持仓建议"""
    return await asyncio.to_thread(position_manager.overview, alert_engine.holdings)


# ============= 选股 API =============
@app.post("/api/screen")
async def screen_stocks(req: ScreenRequest):
    """执行选股（pool="market" 为全市场预热缓存模式）"""
    result = await run_screen(
        req.screen_type, req.stock_pool, req.max_results,
        pool=req.pool,
    )
    return result


@app.get("/api/screen/types")
async def screen_types():
    return {
        "types": [
            {"id": "institutional", "name": "机构抱团股", "description": "趋势跟随，适合抱团主升期"},
            {"id": "breakout", "name": "启动股", "description": "横盘放量突破，捕捉主升浪起点"},
            {"id": "trend", "name": "均线多头", "description": "经典趋势策略"},
            {"id": "speculative", "name": "题材妖股", "description": "短线博弈，适合妖股期"},
        ]
    }


@app.get("/api/screen/pool-status")
async def screen_pool_status():
    """全市场预热池进度"""
    return market_pool.status()


# ============= 持仓 API =============
@app.get("/api/holdings")
async def list_holdings():
    return {"holdings": alert_engine.holdings}


@app.post("/api/holdings")
async def add_holding(holding: Holding):
    alert_engine.add_holding(
        holding.code, holding.name,
        holding.buy_price, holding.shares,
        holding.stop_loss_pct, holding.take_profit_pct,
        stop_mode=holding.stop_mode,
        trail_drawdown_pct=holding.trail_drawdown_pct,
    )
    return {"status": "ok"}


@app.put("/api/holdings/{code}")
async def update_holding(code: str, updates: HoldingUpdate):
    """修改持仓止盈止损参数"""
    ok = alert_engine.update_holding(code, {k: v for k, v in updates.dict().items() if v is not None})
    if not ok:
        raise HTTPException(status_code=404, detail=f"持仓 {code} 不存在")
    return {"status": "ok", "holding": alert_engine.holdings[code]}


@app.delete("/api/holdings/{code}")
async def delete_holding(code: str):
    alert_engine.remove_holding(code)
    return {"status": "ok"}


@app.post("/api/holdings/refresh")
async def refresh_holdings():
    """持仓最新价格与盈亏"""
    codes = list(alert_engine.holdings.keys())
    if not codes:
        return {"holdings": [], "total_value": 0, "total_profit": 0}

    market_codes = [normalize_stock_code(c) for c in codes]
    quotes = await asyncio.to_thread(data_source.get_security_quotes, market_codes)

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
            "stop_mode": h.get("stop_mode", "fixed"),
            "trail_drawdown_pct": h.get("trail_drawdown_pct", 10),
            "high_water_mark": h.get("high_water_mark", h["buy_price"]),
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
    return {"alerts": alert_engine.alerts}


@app.post("/api/alerts")
async def add_alert(rule: AlertRule):
    alert_engine.add_alert(rule.code, rule.type, rule.threshold, rule.message)
    return {"status": "ok"}


@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: str):
    ok = alert_engine.remove_alert(alert_id)
    if not ok:
        raise HTTPException(status_code=404, detail="规则不存在")
    return {"status": "ok"}


@app.put("/api/alerts/{alert_id}")
async def toggle_alert(alert_id: str, req: AlertRuleUpdate):
    ok = alert_engine.toggle_alert(alert_id, req.enabled)
    if not ok:
        raise HTTPException(status_code=404, detail="规则不存在")
    return {"status": "ok"}


@app.get("/api/alerts/history")
async def alert_history():
    """最近触发的预警（持久化，最多200条）"""
    return {"history": list(reversed(alert_engine.history))[:50]}


# ============= WebSocket =============
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
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
