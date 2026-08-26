"""
系统自动进化循环

四大每日任务（盘后16:30起跑，evolution_state 表防重）：
- backfill 事件回填：已发生事件 → 板块实际涨跌 → 写历史影响库 + 回填事件实际结果
- learn    关键词学习：分析高影响力新闻，高置信度新词自动进词库
- verify   预测验证：对2天前的板块预测拉实际行情，判定方向正误
- calendar 日历刷新：百度真实日历数据过期时重拉
"""

import asyncio
import json
import time
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from loguru import logger

from sentiment_db import get_sentiment_db
import eastmoney

# 每日任务开始时间（A股收盘后）
DAILY_RUN_HOUR = 16
DAILY_RUN_MINUTE = 30

# 板块K线回看窗口（回填仅覆盖近40天事件）
BACKFILL_WINDOW_DAYS = 40

# 方向判定阈值（涨跌幅绝对值超过此值才算明确方向）
DIRECTION_THRESHOLD = 0.2


def get_sector_change_pct(bk_code: str, event_date: str, event_time: str = '00:00') -> Optional[float]:
    """
    计算事件日→反应日的板块涨跌幅(%)

    基线 = 事件日前一交易日收盘；
    反应日 = 事件日当天（盘中事件，如中国09:30数据）或次交易日（盘后事件，如美国20:30数据）
    """
    try:
        bars = eastmoney.get_board_kline(bk_code, days=BACKFILL_WINDOW_DAYS + 10)
        if not bars:
            return None
        # 15:00后发布（A股已收盘）→ 反应从下一交易日算起
        after_market_close = (event_time or '00:00') >= '15:00'
        baseline = None
        after = None
        for b in bars:
            d = (b.get('datetime') or '')[:10]
            if not d:
                continue
            if d < event_date:
                baseline = b  # 持续更新为事件前最后一根
            elif after is None:
                if after_market_close and d == event_date:
                    continue  # 跳过事件日当天，取下一交易日
                after = b
        if baseline is None or after is None:
            return None
        base_close = baseline.get('close')
        after_close = after.get('close')
        if not base_close or not after_close:
            return None
        return round((after_close / base_close - 1) * 100, 2)
    except Exception as e:
        logger.debug(f"板块区间涨跌幅计算失败({bk_code},{event_date}): {e}")
        return None


def _direction_of(pct: Optional[float]) -> Optional[str]:
    if pct is None:
        return None
    if pct > DIRECTION_THRESHOLD:
        return 'positive'
    if pct < -DIRECTION_THRESHOLD:
        return 'negative'
    return 'neutral'


# ============= 任务A：事件回填 =============

def run_backfill(limit: int = 20, force: bool = False) -> Dict[str, Any]:
    """已发生事件 → 板块实际涨跌 → 历史影响库 + actual_result"""
    db = get_sentiment_db()
    today = datetime.now().strftime('%Y-%m-%d')

    events = db.get_events_for_backfill(today, limit=limit)
    backfilled, skipped = 0, 0
    for ev in events:
        try:
            # 超出K线回看窗口的事件直接标记，避免每轮重试
            if (datetime.now() - datetime.strptime(ev['event_date'], '%Y-%m-%d')).days > BACKFILL_WINDOW_DAYS:
                db.update_event_actual_result(ev['id'], '超出回填窗口（40天）')
                skipped += 1
                continue

            sectors = json.loads(ev['related_sectors'] or '[]')
            with_bk = [s for s in sectors if s.get('bk_code')]
            if not with_bk:
                db.update_event_actual_result(ev['id'], '无板块映射，跳过')
                skipped += 1
                continue

            from impact_history import get_impact_history_db
            impact_db = get_impact_history_db()

            changes = []
            for sec in with_bk[:3]:
                pct = get_sector_change_pct(sec['bk_code'], ev['event_date'], ev.get('event_time') or '00:00')
                time.sleep(0.5)  # 东财限流保护
                if pct is None:
                    continue
                direction = _direction_of(pct)
                sector_display = sec.get('sector_real_name') or sec['sector_name']
                impact_db.add_impact_record(
                    event_name=ev['event_name'],
                    event_type=ev['event_type'],
                    event_date=ev['event_date'],
                    country=ev.get('country') or 'cn',
                    sector_name=sector_display,
                    impact_direction=direction,
                    impact_magnitude=pct,
                    market_context=None,
                    sample_quality=2,
                )
                changes.append((sector_display, pct))

            if changes:
                actual = '；'.join(f"{name}{pct:+.1f}%" for name, pct in changes)
                db.update_event_actual_result(ev['id'], actual)
                backfilled += 1
                logger.info(f"事件回填: {ev['event_name'][:30]} → {actual[:60]}")
            else:
                # 行情还没出来（如事件在今天），下轮重试
                skipped += 1
        except Exception as e:
            logger.warning(f"事件回填失败({ev.get('event_name', '?')}): {e}")
            skipped += 1

    result = {'events_scanned': len(events), 'backfilled': backfilled, 'skipped': skipped}
    db.set_evolution_state('backfill', today, result)
    return result


# ============= 任务B：关键词自动学习 =============

def run_learn() -> Dict[str, Any]:
    """分析高影响力新闻；置信度high的新词自动进词库，其余留推荐列表"""
    db = get_sentiment_db()
    today = datetime.now().strftime('%Y-%m-%d')

    from keyword_learner import get_keyword_learner
    learner = get_keyword_learner()

    suggestions = learner.analyze_high_impact_news(days=30) or []

    def _fld(s, name, default=None):
        # KeywordSuggestion 为 dataclass；兼容 dict
        if isinstance(s, dict):
            return s.get(name, default)
        return getattr(s, name, default)

    auto_accepted = []
    for s in suggestions:
        if _fld(s, 'confidence') == 'high':
            try:
                if learner.accept_suggestion(_fld(s, 'keyword'), _fld(s, 'suggested_importance', 75), 'AI自动学习'):
                    auto_accepted.append(_fld(s, 'keyword'))
            except Exception as e:
                logger.debug(f"自动接受关键词失败({_fld(s, 'keyword')}): {e}")

    result = {
        'suggestions': len(suggestions),
        'auto_accepted': auto_accepted,
        'high_confidence': sum(1 for s in suggestions if _fld(s, 'confidence') == 'high'),
    }
    db.set_evolution_state('learn', today, result)
    if auto_accepted:
        logger.info(f"关键词自动学习: {len(suggestions)}个建议, 自动接受 {auto_accepted}")
    return result


# ============= 任务C：预测验证 =============

def run_verify(limit: int = 50) -> Dict[str, Any]:
    """验证2天前的板块方向预测：拉实际行情判定正误"""
    db = get_sentiment_db()
    today = datetime.now()

    predictions = db.get_unverified_predictions(limit=limit)
    verified, hit = 0, 0
    for p in predictions:
        try:
            created = (p.get('created_at') or '')[:10]
            if not created:
                continue
            # 只验证至少1天前的预测（次日行情已出）
            if (today - datetime.strptime(created, '%Y-%m-%d')).days < 1:
                continue
            bk = p.get('bk_code')
            if not bk:
                # 无板块代码无法验证，标记后不再重试
                db.verify_prediction(p['id'], 'unverifiable', 0.0)
                continue
            pct = get_sector_change_pct(bk, created)
            time.sleep(0.4)
            if pct is None:
                continue
            direction = _direction_of(pct)
            db.verify_prediction(p['id'], direction, pct)
            verified += 1
            if direction == p.get('direction'):
                hit += 1
        except Exception as e:
            logger.debug(f"预测验证失败(id={p.get('id')}): {e}")

    result = {'verified': verified, 'hit': hit}
    db.set_evolution_state('verify', today.strftime('%Y-%m-%d'), result)
    return result


# ============= 任务D：日历刷新 =============

def run_calendar() -> Dict[str, Any]:
    """百度真实日历过期（最新事件>3天前）时重拉未来30天"""
    db = get_sentiment_db()
    today = datetime.now()

    today_str = today.strftime('%Y-%m-%d')
    future_max = db.conn.execute(
        "SELECT MAX(event_date) FROM event_calendar WHERE source='baidu' AND event_date >= ?",
        (today_str,)
    ).fetchone()[0]
    past_events = db.conn.execute(
        "SELECT COUNT(*) FROM event_calendar WHERE source='baidu' AND event_date < ?",
        (today_str,)
    ).fetchone()[0]

    # stale = 未来覆盖不足20天，或过去事件太少（回填无历史可学）
    cover_days = 0
    if future_max:
        try:
            cover_days = (datetime.strptime(future_max, '%Y-%m-%d') - today).days
        except ValueError:
            cover_days = 0
    stale = cover_days < 20 or past_events < 50
    max_date = future_max

    fetched = 0
    include_past_used = 0
    if stale:
        from event_calendar import get_event_calendar
        include_past_used = 14 if past_events < 50 else 0
        events = get_event_calendar().fetch_baidu_calendar(days=30, include_past=include_past_used)
        fetched = len(events)
        db.set_evolution_state('calendar', today.strftime('%Y-%m-%d'), {'fetched': fetched, 'include_past': include_past_used})
    return {'stale': stale, 'fetched': fetched, 'max_event_date': max_date, 'include_past': include_past_used}


# ============= 调度器 =============

def run_task(task: str, force: bool = False) -> Dict[str, Any]:
    """手动/定时执行单个进化任务"""
    runners = {
        'backfill': run_backfill,
        'learn': run_learn,
        'verify': run_verify,
        'calendar': run_calendar,
    }
    runner = runners.get(task)
    if not runner:
        return {'error': f'未知任务: {task}'}
    return runner(force=force) if task == 'backfill' else runner()


def get_evolution_status() -> Dict[str, Any]:
    """进化系统状态总览"""
    db = get_sentiment_db()
    today = datetime.now().strftime('%Y-%m-%d')
    status = {'today': today}
    for task in ('backfill', 'learn', 'verify', 'calendar'):
        state = db.get_evolution_state(task)
        detail = {}
        if state and state.get('detail'):
            try:
                detail = json.loads(state['detail'])
            except (ValueError, TypeError):
                detail = {}
        status[task] = {
            'last_run': state['last_run'] if state else None,
            'ran_today': bool(state and state['last_run'] == today),
            **detail,
        }
    status['prediction_stats'] = db.get_prediction_stats()

    # 历史影响样本量（impact_history 为短连接模式，独立连接查询）
    try:
        import sqlite3
        from impact_history import get_impact_history_db
        ih = get_impact_history_db()
        with sqlite3.connect(ih.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM impact_history").fetchone()
            status['impact_samples'] = row[0] if row else 0
    except Exception:
        status['impact_samples'] = None
    return status


async def evolution_loop(check_interval: int = 3600):
    """每日调度循环：每小时的16:30后依次跑未执行的当日任务"""
    logger.info(f"进化循环启动（每日{DAILY_RUN_HOUR}:{DAILY_RUN_MINUTE}后执行，检查间隔{check_interval}秒）")
    while True:
        try:
            now = datetime.now()
            if now.hour > DAILY_RUN_HOUR or (now.hour == DAILY_RUN_HOUR and now.minute >= DAILY_RUN_MINUTE):
                db = get_sentiment_db()
                today = now.strftime('%Y-%m-%d')
                pending = [t for t in ('backfill', 'learn', 'verify', 'calendar')
                           if not (db.get_evolution_state(t) or {}).get('last_run') == today]
                for task in pending:
                    logger.info(f"进化任务开始: {task}")
                    result = await asyncio.to_thread(run_task, task)
                    logger.info(f"进化任务完成: {task} → {result}")
        except Exception as e:
            logger.warning(f"进化循环异常: {e}")
        await asyncio.sleep(check_interval)
