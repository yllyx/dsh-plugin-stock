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

from fastapi import FastAPI, Request, WebSocket, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from loguru import logger
from pathlib import Path

from data_source import data_source, normalize_stock_code
from screener import run_screen, market_pool
from alert_engine import alert_engine
from ws_manager import ws_manager, broadcaster
from market_timing import market_timing
from market_sentiment import market_sentiment
from sector_monitor import sector_monitor
from position_manager import position_manager
from storage import storage
from config import config
import system_api
import kpl as kpl_api
from sentiment_monitor import get_sentiment_monitor
from sentiment_db import get_sentiment_db
from user_keywords import get_user_keywords
from keyword_learner import get_keyword_learner
from event_calendar import get_event_calendar
from event_rules import get_event_rules
from event_impact_analyzer import get_event_impact_analyzer
from sector_mapper import get_sector_mapper, get_stock_matcher, get_investment_advisor
from impact_history import get_impact_history_db
from impact_predictor import get_impact_predictor
from position_priority import get_position_priority
from user_preference import get_user_preference
from system_validator import get_system_validator


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


class HoldingAlertToggle(BaseModel):
    alert_type: str  # stop_loss / take_profit / trailing_stop / breakeven_stop / ladder_tp / time_stop
    enabled: bool


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

    # 安装内存日志环形缓冲（系统Tab查看用）
    system_api.install_log_sink()
    logger.info(f"数据目录: {storage.data_dir}")

    alert_engine.load()
    position_manager.load()

    # 连接放后台任务，端口立即可监听（健康检查窗口只有15秒）
    logger.info("行情连接将在后台建立（不阻塞启动）")
    keepalive_task = asyncio.create_task(connection_keepalive_loop())
    broadcaster_task = asyncio.create_task(broadcaster.start(interval=3))
    alert_task = asyncio.create_task(alert_engine.run_loop(interval=config.alert_interval))
    sentiment_task = asyncio.create_task(sentiment_refresh_loop())
    market_pool.start()
    kpl_api.start_snapshot_loop()
    
    # 启动舆情监控
    sentiment_monitor = get_sentiment_monitor()
    sentiment_monitor.start(interval=300)  # 5分钟监控一次

    # 启动自动进化循环（每日盘后：事件回填/关键词学习/预测验证/日历刷新）
    from evolution_loop import evolution_loop
    evolution_task = asyncio.create_task(evolution_loop())

    yield

    logger.info("DSH 股票后端关闭...")
    broadcaster.running = False
    market_pool.stop()
    kpl_api.stop_snapshot_loop()
    sentiment_monitor.stop()  # 停止舆情监控
    for task in (keepalive_task, alert_task, sentiment_task, evolution_task):
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


# ============= 静态资源（K线库本地服务，避免CDN被墙） =============
STATIC_DIR = Path(__file__).parent / "static"
_STATIC_MIME = {
    "klinecharts.min.js": "application/javascript; charset=utf-8",
    "klinecharts.js": "application/javascript; charset=utf-8",
}


@app.get("/api/static/{filename}")
async def serve_static(filename: str):
    """本地静态资源服务（K线库等，避免依赖外部CDN）"""
    if filename not in _STATIC_MIME:
        raise HTTPException(status_code=404, detail="资源不存在")
    p = STATIC_DIR / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"文件未打包: {filename}")
    return Response(content=p.read_bytes(), media_type=_STATIC_MIME[filename])


@app.get("/api/system/kline-library")
async def kline_library_check():
    """检查K线库本地文件是否可用（前端据此决定是否走本地）"""
    p = STATIC_DIR / "klinecharts.min.js"
    return {"local_available": p.exists(), "version": "9.8.12", "size_kb": round(p.stat().st_size / 1024) if p.exists() else 0}


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
    """主要指数行情（pytdx 优先，不可用时回退东财）"""
    market_codes = [(m, c) for m, c, _ in INDEX_LIST]
    quotes = await asyncio.to_thread(data_source.get_security_quotes, market_codes)

    result = {}
    if quotes:
        for i, (_, code, name) in enumerate(INDEX_LIST):
            if i < len(quotes):
                result[code] = quotes[i]
                result[code]["display_name"] = name
    else:
        # 东财回退：一次请求全部指数
        import eastmoney as em
        name_map = {c: n for _, c, n in INDEX_LIST}
        secids = [f"{m}.{c}" for m, c, _ in INDEX_LIST]
        eq = await asyncio.to_thread(em.get_index_quotes, secids)
        for q in eq:
            code = q.get("code")
            if code in name_map:
                q["display_name"] = name_map[code]
                result[code] = q

    return {
        "indices": result,
        "source": "pytdx" if quotes else ("eastmoney" if result else "unavailable"),
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
async def get_market_timing(force: bool = Query(False, description="跳过缓存立即重算")):
    """大盘择时：跌无可跌清单 + 企稳信号 + 阶段判定 + 建议仓位"""
    return await asyncio.to_thread(market_timing.get, force)


@app.get("/api/market/sentiment")
async def get_market_sentiment(force: bool = Query(False)):
    """市场情绪统计 + 风格判定（抱团 vs 妖股）"""
    return await asyncio.to_thread(market_sentiment.get, force)


@app.get("/api/sectors")
async def get_sectors(
    board_type: str = Query("industry", description="industry=行业, concept=概念"),
    top_n: int = Query(15, ge=5, le=50),
    force: bool = Query(False),
):
    """板块排行（含5日动量与阶段标签）"""
    return await asyncio.to_thread(sector_monitor.get_ranking, board_type, top_n, force)


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


@app.put("/api/holdings/{code}/alerts")
async def toggle_holding_alert(code: str, req: HoldingAlertToggle):
    """启用/暂停某持仓的某类预警"""
    h = alert_engine.holdings.get(code)
    if not h:
        raise HTTPException(status_code=404, detail=f"持仓 {code} 不存在")
    enabled = h.setdefault("alerts_enabled", {
        "stop_loss": True, "take_profit": True, "trailing_stop": True,
        "breakeven_stop": True, "ladder_tp": True, "time_stop": True,
    })
    valid = {"stop_loss", "take_profit", "trailing_stop", "breakeven_stop", "ladder_tp", "time_stop"}
    if req.alert_type not in valid:
        raise HTTPException(status_code=400, detail=f"未知预警类型 {req.alert_type}")
    enabled[req.alert_type] = req.enabled
    alert_engine.save()
    return {"status": "ok", "code": code, "alert_type": req.alert_type, "enabled": req.enabled, "alerts_enabled": enabled}


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


# ============= 系统管理 =============
@app.get("/api/system/status")
async def api_system_status():
    """系统状态总览（版本/连接/预热池/数据目录）"""
    return await system_api.system_status()


@app.get("/api/system/tdx-probe")
async def api_tdx_probe():
    """并行探测全部通达信服务器"""
    return await system_api.tdx_probe()


@app.post("/api/system/tdx-reconnect")
async def api_tdx_reconnect():
    """强制断开并重连通达信"""
    return await system_api.tdx_reconnect()


@app.post("/api/system/tdx-client-update")
async def api_tdx_client_update():
    """启动通达信客户端并尽力拉取最新本地数据（自动登录尝试+盘后下载+变化监测自动重载）"""
    return await system_api.tdx_client_update()


@app.get("/api/system/config")
async def api_get_config():
    return await system_api.get_config()


@app.put("/api/system/config")
async def api_update_config(req: system_api.ConfigUpdate, request: Request):
    """更新配置；data_dir 走迁移流程（复制旧数据到新目录并在线切换）"""
    return await system_api.update_config(req, request)


@app.get("/api/system/logs")
async def api_system_logs(level: str = Query("INFO"), limit: int = Query(200, le=500)):
    """最近内存日志（环形缓冲500条）"""
    return await system_api.get_logs(level, limit)


@app.post("/api/system/restart")
async def api_system_restart(request: Request):
    """后端自重启（分离进程2秒后拉起，前端靠health轮询恢复）"""
    return await system_api.restart_backend(request)


# ============= 舆情监控 API =============
@app.get("/api/sentiment/latest")
async def get_latest_sentiment(limit: int = Query(50, ge=10, le=200), min_score: int = Query(60, ge=0, le=100)):
    """获取最新舆情"""
    sentiment_monitor = get_sentiment_monitor()
    return await sentiment_monitor.get_latest_sentiment(limit, min_score)


@app.get("/api/sentiment/cn")
async def get_cn_sentiment(limit: int = Query(30, ge=10, le=100)):
    """获取国内重要舆情"""
    sentiment_monitor = get_sentiment_monitor()
    return await sentiment_monitor.get_cn_sentiment(limit)


@app.get("/api/sentiment/us")
async def get_us_sentiment(limit: int = Query(30, ge=10, le=100)):
    """获取美国重要舆情"""
    sentiment_monitor = get_sentiment_monitor()
    return await sentiment_monitor.get_us_sentiment(limit)


@app.get("/api/sentiment/event-type/{event_type}")
async def get_sentiment_by_type(event_type: str, limit: int = Query(30, ge=10, le=100)):
    """根据事件类型获取舆情"""
    from sentiment_db import get_sentiment_db
    db = get_sentiment_db()
    return await asyncio.to_thread(db.get_by_event_type, event_type, limit)


class EventImpactRequest(BaseModel):
    event_name: str
    event_type: str
    description: str
    sectors: List[str]
    market_context: Optional[Dict[str, Any]] = None


@app.post("/api/sentiment/analyze-impact")
async def analyze_event_impact(req: EventImpactRequest):
    """分析事件对板块的影响"""
    sentiment_monitor = get_sentiment_monitor()
    event = {
        'event_name': req.event_name,
        'event_type': req.event_type,
        'description': req.description,
        'market_context': req.market_context,
    }
    return await sentiment_monitor.analyze_event_impact(event, req.sectors)


# ============= 用户自定义关键词管理 API =============
class UserKeywordInput(BaseModel):
    keyword: str
    category: str = "自定义"
    importance: int = 70
    notes: str = ""


class UserKeywordUpdate(BaseModel):
    keyword: Optional[str] = None
    category: Optional[str] = None
    importance: Optional[int] = None
    notes: Optional[str] = None


class StockKeywordInput(BaseModel):
    stock_code: str
    stock_name: str
    keywords: List[str]


@app.get("/api/sentiment/keywords")
async def get_keywords_list():
    """获取所有用户自定义关键词"""
    user_keywords = get_user_keywords()
    return user_keywords.get_all_keywords()


@app.post("/api/sentiment/keywords")
async def add_user_keyword(req: UserKeywordInput):
    """添加用户自定义关键词"""
    user_keywords = get_user_keywords()
    return await asyncio.to_thread(
        user_keywords.add_keyword,
        req.keyword,
        req.category,
        req.importance,
        req.notes
    )


@app.put("/api/sentiment/keywords/{keyword_id}")
async def update_user_keyword(keyword_id: str, req: UserKeywordUpdate):
    """更新用户自定义关键词"""
    user_keywords = get_user_keywords()
    result = await asyncio.to_thread(
        user_keywords.update_keyword,
        keyword_id,
        req.keyword,
        req.category,
        req.importance,
        req.notes
    )
    if result is None:
        raise HTTPException(status_code=404, detail="关键词不存在")
    return result


@app.delete("/api/sentiment/keywords/{keyword_id}")
async def delete_user_keyword(keyword_id: str):
    """删除用户自定义关键词"""
    user_keywords = get_user_keywords()
    success = await asyncio.to_thread(user_keywords.delete_keyword, keyword_id)
    if not success:
        raise HTTPException(status_code=404, detail="关键词不存在")
    return {"status": "ok"}


@app.get("/api/sentiment/keywords/statistics")
async def get_keyword_statistics():
    """获取用户关键词统计信息"""
    user_keywords = get_user_keywords()
    return await asyncio.to_thread(user_keywords.get_statistics)


@app.post("/api/sentiment/keywords/stock")
async def add_stock_keywords(req: StockKeywordInput):
    """为股票添加关键词监控"""
    user_keywords = get_user_keywords()
    return await asyncio.to_thread(
        user_keywords.add_stock_watch,
        req.stock_code,
        req.stock_name,
        req.keywords
    )


@app.get("/api/sentiment/keywords/stock/{stock_code}")
async def get_stock_keywords(stock_code: str):
    """获取股票的监控关键词"""
    user_keywords = get_user_keywords()
    result = await asyncio.to_thread(user_keywords.get_stock_keywords, stock_code)
    if result is None:
        raise HTTPException(status_code=404, detail="股票监控不存在")
    return result


@app.delete("/api/sentiment/keywords/stock/{stock_code}")
async def delete_stock_keywords(stock_code: str):
    """删除股票关键词监控"""
    user_keywords = get_user_keywords()
    success = await asyncio.to_thread(user_keywords.remove_stock_watch, stock_code)
    if not success:
        raise HTTPException(status_code=404, detail="股票监控不存在")
    return {"status": "ok"}


@app.post("/api/sentiment/keywords/blacklist")
async def add_blacklist_keyword(keyword: str):
    """添加黑名单关键词"""
    user_keywords = get_user_keywords()
    success = await asyncio.to_thread(user_keywords.add_blacklist, keyword)
    if not success:
        raise HTTPException(status_code=400, detail="关键词已在黑名单中")
    return {"status": "ok"}


@app.delete("/api/sentiment/keywords/blacklist/{keyword}")
async def remove_blacklist_keyword(keyword: str):
    """移除黑名单关键词"""
    user_keywords = get_user_keywords()
    success = await asyncio.to_thread(user_keywords.remove_blacklist, keyword)
    if not success:
        raise HTTPException(status_code=404, detail="关键词不在黑名单中")
    return {"status": "ok"}


@app.get("/api/sentiment/keywords/blacklist")
async def get_blacklist():
    """获取黑名单"""
    user_keywords = get_user_keywords()
    return await asyncio.to_thread(user_keywords.get_blacklist)


@app.post("/api/sentiment/keywords/optimize")
async def optimize_keywords():
    """优化关键词数据（清理重复、更新统计）"""
    user_keywords = get_user_keywords()
    return await asyncio.to_thread(user_keywords.optimize_data)


# ============= AI智能推荐关键词 API =============
class SuggestionRequest(BaseModel):
    keyword: str
    suggested_importance: int
    category: str = "AI推荐"


@app.get("/api/sentiment/keywords/suggestions")
async def get_keyword_suggestions(days: int = Query(30, ge=7, le=90)):
    """获取AI推荐的关键词"""
    learner = get_keyword_learner()
    return await asyncio.to_thread(learner.generate_suggestions, days)


@app.post("/api/sentiment/keywords/suggestions/accept")
async def accept_suggestion(req: SuggestionRequest):
    """接受AI推荐的关键词，添加到用户词库"""
    learner = get_keyword_learner()
    success = await asyncio.to_thread(
        learner.accept_suggestion,
        req.keyword,
        req.suggested_importance,
        req.category
    )
    if not success:
        raise HTTPException(status_code=400, detail="接受推荐失败")
    return {"status": "ok", "message": f"已添加关键词: {req.keyword}"}


@app.post("/api/sentiment/keywords/suggestions/reject")
async def reject_suggestion(keyword: str):
    """拒绝AI推荐的关键词，加入黑名单"""
    learner = get_keyword_learner()
    success = await asyncio.to_thread(learner.reject_suggestion, keyword)
    if not success:
        raise HTTPException(status_code=400, detail="拒绝推荐失败")
    return {"status": "ok", "message": f"已将关键词加入黑名单: {keyword}"}


@app.get("/api/sentiment/keywords/learning-stats")
async def get_learning_statistics(days: int = Query(30, ge=7, le=90)):
    """获取关键词学习统计信息"""
    learner = get_keyword_learner()
    return await asyncio.to_thread(learner.get_learning_statistics, days)


# ============= 事件日历 API =============
@app.get("/api/calendar/events")
async def get_calendar_events(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    country: Optional[str] = Query(None),
    min_importance: int = Query(60, ge=0, le=100)
):
    """获取事件日历"""
    calendar = get_event_calendar()
    return await asyncio.to_thread(
        calendar.get_events_by_date_range,
        start_date, end_date, country, min_importance
    )


@app.get("/api/calendar/upcoming")
async def get_upcoming_events(days: int = Query(7, ge=1, le=30)):
    """获取近期事件（按日期分组）"""
    calendar = get_event_calendar()
    return await asyncio.to_thread(calendar.get_upcoming_events, days)


@app.post("/api/calendar/generate")
async def generate_calendar(months: int = Query(12, ge=1, le=24)):
    """生成未来N个月的事件日历"""
    calendar = get_event_calendar()
    result = await asyncio.to_thread(calendar.generate_calendar, months)
    return {"status": "ok", "count": len(result), "events": result}


@app.post("/api/calendar/fetch")
async def fetch_calendar_data(days: int = Query(30, ge=7, le=90)):
    """从财经网站抓取最新的日历数据"""
    calendar = get_event_calendar()
    result = await asyncio.to_thread(calendar.fetch_all_calendars, days)
    return {"status": "ok", "count": len(result), "events": result}


@app.get("/api/calendar/statistics")
async def get_calendar_statistics(days: int = Query(30, ge=7, le=90)):
    """获取事件日历统计信息"""
    calendar = get_event_calendar()
    return await asyncio.to_thread(calendar.get_event_statistics, days)


@app.post("/api/calendar/cleanup")
async def cleanup_old_events(days: int = Query(90, ge=30, le=180)):
    """清理旧事件数据"""
    calendar = get_event_calendar()
    deleted_count = await asyncio.to_thread(calendar.cleanup_old_events, days)
    return {"status": "ok", "deleted_count": deleted_count}


# ============= 事件影响分析 API =============
class EventImpactRequest(BaseModel):
    event_name: str
    event_type: str
    importance_score: int = 70
    keywords: List[str] = []
    country: str = "cn"
    market_context: Optional[Dict[str, Any]] = None


@app.post("/api/calendar/analyze-impact")
async def analyze_event_impact(req: EventImpactRequest):
    """分析事件对板块的影响"""
    analyzer = get_event_impact_analyzer()
    
    # 构建事件对象
    event = {
        'name': req.event_name,
        'event_type': req.event_type,
        'importance_score': req.importance_score,
        'keywords': req.keywords,
        'country': req.country,
    }
    
    # 推断相关板块
    sectors = []
    sector_keywords = {
        '黄金': ['黄金', '贵金属'],
        '地产': ['房地产', '住房'],
        '银行': ['银行', '利率'],
        '半导体': ['芯片', '半导体'],
    }
    
    for keyword in req.keywords:
        for sector, keywords in sector_keywords.items():
            if keyword in keywords and sector not in sectors:
                sectors.append(sector)
    
    # 如果没有推断出板块，使用默认板块
    if not sectors:
        sectors = ['黄金', '银行', '消费']
    
    predictions = await asyncio.to_thread(
        analyzer.predict_sector_impact,
        event,
        sectors,
        req.market_context
    )
    
    return {
        'event': event,
        'analyzed_sectors': sectors,
        'predictions': predictions
    }


# ============= 板块关联和个股投资建议 API =============
@app.get("/api/sentiment/sectors/{news_id}")
async def get_sentiment_sectors(news_id: str):
    """获取舆情相关的板块分析"""
    # 从数据库获取舆情
    db = get_sentiment_db()
    sentiment = await asyncio.to_thread(db.get_news_by_id, news_id)
    
    if not sentiment:
        raise HTTPException(status_code=404, detail="舆情不存在")
    
    # 如果舆情已经有板块关联数据，直接返回
    if 'related_sectors' in sentiment and sentiment['related_sectors']:
        return {
            'news_id': news_id,
            'related_sectors': sentiment['related_sectors']
        }
    
    # 实时计算板块关联
    sector_mapper = get_sector_mapper()
    related_sectors = sector_mapper.identify_sectors_from_sentiment(sentiment)
    
    return {
        'news_id': news_id,
        'related_sectors': related_sectors
    }


@app.post("/api/sentiment/investment-advice")
async def generate_investment_advice(
    news_id: str,
    include_stocks: bool = True
):
    """基于舆情生成投资建议（真实板块实时数据 + 龙头 + 动态文案 + 预测落库）"""
    db = get_sentiment_db()
    news = await asyncio.to_thread(db.get_news_by_id, news_id)

    if not news:
        raise HTTPException(status_code=404, detail="舆情不存在")

    sector_mapper = get_sector_mapper()

    # 1. 板块识别（DB已有则复用，否则实时识别）
    related_sectors = news.get('related_sectors') or []
    if not related_sectors:
        related_sectors = sector_mapper.identify_sectors_from_sentiment(news)

    # 2. 板块→东财实时数据enrich（涨跌/动量/阶段/龙头），最多前3个板块控制耗时
    enriched_sectors = await asyncio.to_thread(
        lambda: [sector_mapper.enrich_sector_with_realtime(s) for s in related_sectors[:3]]
    )

    # 3. 个股：直接匹配（标题+内容，兼容code/stock_code键名）
    related_stocks = []
    if include_stocks:
        stock_matcher = get_stock_matcher()
        if news.get('related_stocks'):
            related_stocks = news['related_stocks']
        else:
            seen = set()
            for text in (news.get('title', ''), (news.get('content') or '')[:500]):
                for stock in stock_matcher.match_stocks_in_text(text):
                    code = stock.get('code') or stock.get('stock_code')
                    if code and code not in seen:
                        seen.add(code)
                        related_stocks.append(stock)

    # 4. 生成投资建议（动态文案）
    investment_advisor = get_investment_advisor()
    advice = await asyncio.to_thread(
        investment_advisor.generate_investment_tip,
        news,
        related_stocks,
        enriched_sectors,
    )

    # 5. 预测落库（进化闭环：2天后自动验证方向正误）
    sector_predictions = []
    for sec in enriched_sectors:
        for rb in sec.get('real_boards', []):
            sector_predictions.append({
                'sector_name': rb['name'],
                'bk_code': rb['bk_code'],
                'direction': sec.get('impact', 'neutral'),
                'positive_pct': None,
            })
    if sector_predictions:
        await asyncio.to_thread(
            db.record_predictions, news.get('id'), news.get('title', ''), sector_predictions
        )

    # 响应：板块用enriched（含实时数据），个股含直接匹配+龙头
    return {
        'sentiment': news,
        'related_sectors': enriched_sectors,
        'related_stocks': related_stocks + [
            {'code': s['code'], 'name': s['name']} for s in advice.get('recommended_stocks', [])
            if s.get('is_leader') and not any(x.get('code') == s['code'] for x in related_stocks)
        ],
        'investment_advice': advice
    }


# ============= 自动进化 API =============
@app.post("/api/evolution/run")
async def run_evolution_task(task: str = Query(..., description="backfill/learn/verify/calendar"), force: bool = False):
    """手动触发进化任务（测试或立即进化用）"""
    from evolution_loop import run_task
    result = await asyncio.to_thread(run_task, task, force)
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result


@app.get("/api/evolution/status")
async def get_evolution_status_api():
    """进化系统状态（最近回填/学习时间、样本数、预测准确率）"""
    from evolution_loop import get_evolution_status
    return await asyncio.to_thread(get_evolution_status)


# ============= 历史影响预测 API =============
@app.get("/api/impact/history/statistics")
async def get_impact_history_statistics(
    event_type: str = Query(..., description="事件类型"),
    sector_name: str = Query(..., description="板块名称")
):
    """获取历史影响统计数据"""
    impact_db = get_impact_history_db()
    stats = await asyncio.to_thread(
        impact_db.calculate_historical_stats,
        "",  # event_name暂不使用
        event_type,
        sector_name
    )
    return stats


@app.post("/api/impact/predict")
async def predict_impact(
    event_name: str,
    event_type: str,
    sector_name: str,
    market_context: Optional[Dict[str, Any]] = None
):
    """预测事件对板块的影响"""
    predictor = get_impact_predictor()
    
    event = {
        'name': event_name,
        'event_type': event_type
    }
    
    prediction = await asyncio.to_thread(
        predictor.predict_sector_impact,
        event,
        sector_name,
        market_context
    )
    
    return prediction


@app.post("/api/impact/risk-analysis")
async def analyze_risk_scenarios(
    event_name: str,
    event_type: str,
    sector_name: str
):
    """分析风险情景"""
    predictor = get_impact_predictor()
    
    event = {
        'name': event_name,
        'event_type': event_type
    }
    
    risk_analysis = await asyncio.to_thread(
        predictor.analyze_risk_scenarios,
        event,
        sector_name
    )
    
    return risk_analysis


@app.get("/api/impact/similar-events")
async def get_similar_events(
    event_name: str,
    event_type: str,
    sector_name: str,
    limit: int = 10
):
    """获取相似的历史事件"""
    impact_db = get_impact_history_db()
    similar_events = await asyncio.to_thread(
        impact_db.find_similar_events,
        event_name,
        event_type,
        sector_name,
        limit
    )
    return {
        'event_name': event_name,
        'event_type': event_type,
        'sector_name': sector_name,
        'similar_events': similar_events
    }


@app.post("/api/impact/add-record")
async def add_impact_record(
    event_name: str,
    event_type: str,
    event_date: str,
    country: str,
    sector_name: str,
    impact_direction: str,
    impact_magnitude: float,
    market_context: Optional[Dict[str, Any]] = None,
    sample_quality: int = 1
):
    """添加新的影响记录"""
    impact_db = get_impact_history_db()
    success = await asyncio.to_thread(
        impact_db.add_impact_record,
        event_name,
        event_type,
        event_date,
        country,
        sector_name,
        impact_direction,
        impact_magnitude,
        market_context,
        sample_quality
    )
    
    if success:
        return {"status": "ok", "message": "影响记录添加成功"}
    else:
        raise HTTPException(status_code=500, detail="添加影响记录失败")


# ============= 个性化和用户偏好 API =============
@app.post("/api/user/positions/update")
async def update_user_positions(positions: List[Dict[str, Any]]):
    """更新用户持仓数据"""
    position_priority = get_position_priority()
    await asyncio.to_thread(position_priority.update_positions, positions)
    return {"status": "ok", "message": "持仓数据更新成功"}


@app.get("/api/user/positions/relevance/{news_id}")
async def get_position_relevance(news_id: str):
    """获取舆情与持仓的关联性"""
    # 从数据库获取舆情
    db = get_sentiment_db()
    sentiment = await asyncio.to_thread(db.get_news_by_id, news_id)
    
    if not sentiment:
        raise HTTPException(status_code=404, detail="舆情不存在")
    
    position_priority = get_position_priority()
    relevance = await asyncio.to_thread(
        position_priority.identify_position_relevance,
        sentiment
    )
    
    return relevance


@app.get("/api/user/positions/risk/{news_id}")
async def get_position_risk(news_id: str):
    """计算持仓风险"""
    # 从数据库获取舆情
    db = get_sentiment_db()
    sentiment = await asyncio.to_thread(db.get_news_by_id, news_id)
    
    if not sentiment:
        raise HTTPException(status_code=404, detail="舆情不存在")
    
    position_priority = get_position_priority()
    position_relevance = await asyncio.to_thread(
        position_priority.identify_position_relevance,
        sentiment
    )
    
    risk_analysis = await asyncio.to_thread(
        position_priority.calculate_portfolio_risk,
        sentiment,
        position_relevance
    )
    
    return risk_analysis


@app.post("/api/user/click/record")
async def record_user_click(
    sentiment_id: str,
    click_type: str = "view"
):
    """记录用户点击行为"""
    # 从数据库获取舆情详情
    db = get_sentiment_db()
    sentiment = await asyncio.to_thread(db.get_news_by_id, sentiment_id)
    
    if sentiment:
        user_preference = get_user_preference()
        await asyncio.to_thread(
            user_preference.record_click,
            sentiment,
            click_type
        )
    
    return {"status": "ok"}


@app.get("/api/user/preferences")
async def get_user_preferences():
    """获取用户偏好数据"""
    user_preference = get_user_preference()
    return await asyncio.to_thread(user_preference.get_user_statistics)


@app.post("/api/user/preferences/reset")
async def reset_user_preferences():
    """重置用户偏好"""
    user_preference = get_user_preference()
    await asyncio.to_thread(user_preference.reset_preferences)
    return {"status": "ok", "message": "用户偏好已重置"}


@app.get("/api/user/sentiments/personalized")
async def get_personalized_sentiments():
    """获取个性化排序的舆情列表"""
    user_preference = get_user_preference()
    position_priority = get_position_priority()
    
    # 获取所有舆情
    db = get_sentiment_db()
    all_sentiments = await asyncio.to_thread(db.get_all_news, limit=50)
    
    if not all_sentiments:
        return []
    
    # 应用持仓优先排序
    prioritized_sentiments = await asyncio.to_thread(
        position_priority.prioritize_sentiments,
        all_sentiments
    )
    
    # 计算个性化评分
    for sentiment in prioritized_sentiments:
        personalized_score = await asyncio.to_thread(
            user_preference.calculate_personalized_score,
            sentiment
        )
        sentiment['personalized_score'] = personalized_score
    
    # 按个性化分数再次排序
    prioritized_sentiments.sort(
        key=lambda x: x.get('personalized_score', 0),
        reverse=True
    )
    
    return prioritized_sentiments


# ============= 系统测试和验证 API =============
@app.get("/api/system/validate")
async def run_system_validation():
    """运行系统验证测试"""
    validator = get_system_validator()
    results = await validator.run_all_tests()
    return results


@app.get("/api/system/health")
async def system_health_check():
    """系统健康检查"""
    
    health_status = {
        'status': 'healthy',
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'components': {}
    }
    
    # 检查数据库连接
    try:
        from sentiment_db import get_sentiment_db
        db = get_sentiment_db()
        db.get_all_news(limit=1)
        health_status['components']['sentiment_db'] = 'healthy'
    except Exception as e:
        health_status['components']['sentiment_db'] = f'unhealthy: {str(e)}'
        health_status['status'] = 'degraded'
    
    # 检查舆情监控
    try:
        from sentiment_monitor import get_sentiment_monitor
        monitor = get_sentiment_monitor()
        health_status['components']['sentiment_monitor'] = 'healthy'
    except Exception as e:
        health_status['components']['sentiment_monitor'] = f'unhealthy: {str(e)}'
        health_status['status'] = 'degraded'
    
    # 检查事件日历
    try:
        from event_calendar import get_event_calendar
        calendar = get_event_calendar()
        health_status['components']['event_calendar'] = 'healthy'
    except Exception as e:
        health_status['components']['event_calendar'] = f'unhealthy: {str(e)}'
        health_status['status'] = 'degraded'
    
    # 如果有任何组件不健康，返回503状态
    if health_status['status'] == 'degraded':
        raise HTTPException(status_code=503, detail=health_status)
    
    return health_status


@app.get("/api/system/statistics")
async def get_system_statistics():
    """获取系统统计信息"""
    
    try:
        # 舆情统计
        from sentiment_db import get_sentiment_db
        sentiment_db = get_sentiment_db()
        all_news = sentiment_db.get_all_news(limit=1000)
        
        # 事件统计
        from event_calendar import get_event_calendar_db
        calendar_db = get_event_calendar_db()
        all_events = calendar_db.get_all_events(limit=1000)
        
        # 关键词统计
        from user_keywords import get_user_keywords
        user_keywords = get_user_keywords()
        keywords = user_keywords.get_all_keywords()
        
        return {
            'sentiment_count': len(all_news),
            'event_count': len(all_events),
            'keyword_count': len(keywords),
            'system_uptime': '统计中...',
            'last_update': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        }
        
    except Exception as e:
        logger.error(f"获取系统统计失败: {e}")
        raise HTTPException(status_code=500, detail=f"获取系统统计失败: {str(e)}")


# ============= 开盘啦 API =============
class KplBind(BaseModel):
    user_id: str
    token: str


class KplWatchChange(BaseModel):
    code: str
    combine_id: str = "0"


@app.get("/api/kpl/status")
async def kpl_status():
    """开盘啦登录态（绑定状态/用户信息）"""
    return await asyncio.to_thread(kpl_api.status)


@app.post("/api/kpl/bind")
async def kpl_bind(req: KplBind):
    """绑定开盘啦登录态（UserID+Token）"""
    kpl_api.bind(req.user_id.strip(), req.token.strip())
    return await asyncio.to_thread(kpl_api.status)


@app.post("/api/kpl/unbind")
async def kpl_unbind():
    kpl_api.unbind()
    return {"status": "ok"}


@app.get("/api/kpl/watchlist")
async def kpl_watchlist():
    """自选分组+列表（后端快照循环维护实时行情）"""
    wl = await asyncio.to_thread(kpl_api.get_watchlist)
    return wl or {"groups": [], "stocks": {}, "init_mess": {}}


@app.post("/api/kpl/watchlist/add")
async def kpl_watchlist_add(req: KplWatchChange):
    return await asyncio.to_thread(kpl_api.add_stock, req.code.strip(), req.combine_id.strip())


@app.post("/api/kpl/watchlist/del")
async def kpl_watchlist_del(req: KplWatchChange):
    return await asyncio.to_thread(kpl_api.del_stock, req.code.strip(), req.combine_id.strip())


@app.get("/api/kpl/quote/{code}")
async def kpl_quote(code: str, force: bool = Query(False)):
    """个股详情一次拿全（报价头+十档+涨停原因）"""
    d = await asyncio.to_thread(kpl_api.get_pankou, code, force)
    if not d:
        raise HTTPException(status_code=404, detail="未获取到盘口数据")
    return d


@app.get("/api/kpl/plate/{plate_id}")
async def kpl_plate(plate_id: str):
    """板块详情：头部指标+细分强度+筛选标签+分时+事件"""
    info, sons, tags, trend, events = await asyncio.gather(
        asyncio.to_thread(kpl_api.get_plate_info, plate_id),
        asyncio.to_thread(kpl_api.get_son_plates, plate_id),
        asyncio.to_thread(kpl_api.get_filter_tags, plate_id),
        asyncio.to_thread(kpl_api.get_plate_trend, plate_id),
        asyncio.to_thread(kpl_api.get_plate_events, plate_id),
    )
    if not info and not sons:
        raise HTTPException(status_code=404, detail="板块数据不可用")
    return {"info": info, "son_plates": sons or [], "filter_tags": tags or [],
            "trend": trend or {}, "events": events or []}


@app.get("/api/kpl/overview")
async def kpl_overview():
    """行情总览：盯盘聚合+指数+情绪历史+全球+热搜"""
    def _all():
        return {
            "dingpan": kpl_api.get_dingpan(),
            "index": kpl_api.get_index_quotes(),
            "sentiment_history": kpl_api.get_sentiment_history(),
            "global": kpl_api.get_global(),
            "hot_stocks": kpl_api.get_hot_stocks(),
            "hot_words": kpl_api.get_hot_words(),
        }
    return await asyncio.to_thread(_all)


@app.get("/api/kpl/search-local")
async def kpl_search_local(q: str = Query(...)):
    """本地代码表模糊搜索（名称/代码），开盘啦App同款本地联想方式"""
    from screener import market_pool
    q = q.strip().upper()
    if not q:
        return {"results": []}
    results = []
    with market_pool._lock:
        for code, name in market_pool._names.items():
            if q in code or q in (name or ""):
                results.append({"code": code, "name": name})
                if len(results) >= 20:
                    break
    return {"results": results}


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
