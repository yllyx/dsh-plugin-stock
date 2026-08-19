"""
筛选引擎 - 实现通达信公式系统的逻辑

将 通达信公式/.tn6 文件的逻辑移植到 Python
"""

import pandas as pd
import numpy as np
from typing import List, Dict, Any
from loguru import logger

from data_source import data_source, normalize_stock_code


def ma(series, n):
    return series.rolling(n).mean()


def ema(series, n):
    return series.ewm(span=n, adjust=False).mean()


def rsi(series, n=14):
    delta = series.diff()
    gain = delta.where(delta > 0, 0)
    loss = -delta.where(delta < 0, 0)
    avg_gain = gain.rolling(n).mean()
    avg_loss = loss.rolling(n).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def macd(series, fast=12, slow=26, signal=9):
    ema_fast = ema(series, fast)
    ema_slow = ema(series, slow)
    diff = ema_fast - ema_slow
    dea = ema(diff, signal)
    return diff, dea, (diff - dea) * 2


def screen_institutional(df):
    """
    机构抱团股筛选
    对应：通达信公式/2_选股公式/机构抱团股筛选.tn6
    """
    if df.empty or len(df) < 60:
        return False

    close = df["close"]
    high = df["high"]
    low = df["low"]

    # 位置：当前价格在近1年高点 80% 以上
    hhv_1y = high.tail(250).max()
    llv_1y = low.tail(250).min()
    if hhv_1y == llv_1y:
        return False
    position = (close.iloc[-1] - llv_1y) / (hhv_1y - llv_1y) * 100
    if position < 80:
        return False

    # 均线多头排列
    ma5 = ma(close, 5).iloc[-1]
    ma10 = ma(close, 10).iloc[-1]
    ma20 = ma(close, 20).iloc[-1]
    ma60 = ma(close, 60).iloc[-1]
    if not (ma5 > ma10 > ma20 > ma60):
        return False

    return True


def screen_breakout(df):
    """
    启动股筛选
    对应：通达信公式/2_选股公式/启动股筛选.tn6
    """
    if df.empty or len(df) < 60:
        return False

    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]

    # 长期横盘：过去60天振幅<30%
    hhv_60 = high.tail(60).max()
    llv_60 = low.tail(60).min()
    if llv_60 == 0:
        return False
    amplitude = (hhv_60 - llv_60) / llv_60 * 100
    if amplitude >= 30:
        return False

    # 突破横盘
    if close.iloc[-1] < hhv_60 * 0.99:
        return False

    # 放量
    vol_ma5 = ma(volume, 5).iloc[-1]
    if volume.iloc[-1] < vol_ma5 * 2:
        return False

    # 站上年线
    ma250 = ma(close, 250).iloc[-1] if len(df) >= 250 else ma(close, min(120, len(df))).iloc[-1]
    if close.iloc[-1] <= ma250:
        return False
    if close.iloc[-1] >= ma250 * 1.2:
        return False  # 不能涨幅过大

    # MACD金叉
    diff, dea, _ = macd(close)
    if not (diff.iloc[-1] > dea.iloc[-1] and diff.iloc[-2] <= dea.iloc[-2]):
        return False

    return True


def screen_trend(df):
    """
    均线多头选股
    对应：通达信公式/2_选股公式/均线多头选股.tn6
    """
    if df.empty or len(df) < 120:
        return False

    close = df["close"]
    ma5 = ma(close, 5).iloc[-1]
    ma10 = ma(close, 10).iloc[-1]
    ma20 = ma(close, 20).iloc[-1]
    ma30 = ma(close, 30).iloc[-1]
    ma60 = ma(close, 60).iloc[-1]
    ma120 = ma(close, 120).iloc[-1]

    return bool(ma5 > ma10 > ma20 > ma30 > ma60 > ma120)


def screen_speculative(df):
    """
    题材妖股筛选
    对应：通达信公式/2_选股公式/题材妖股筛选.tn6
    """
    if df.empty or len(df) < 20:
        return False

    close = df["close"]
    volume = df["volume"]

    # 近5日有涨停
    last_5 = close.tail(5)
    prev = close.shift(1).tail(5)
    pct_change = (last_5 - prev) / prev * 100
    has_limit_up = (pct_change >= 9.5).any()
    if not has_limit_up:
        return False

    # 放量
    vol_ma5 = ma(volume, 5).iloc[-1]
    if volume.iloc[-1] < vol_ma5 * 2:
        return False

    # 突破20日新高
    hhv_20 = df["high"].tail(20).max()
    if close.iloc[-1] < hhv_20 * 0.98:
        return False

    return True


SCREENS = {
    "institutional": screen_institutional,
    "breakout": screen_breakout,
    "trend": screen_trend,
    "speculative": screen_speculative,
}


async def run_screen(
    screen_type: str,
    stock_pool: List[str] = None,
    max_results: int = 30,
) -> List[Dict[str, Any]]:
    """
    执行选股
    """
    screen_fn = SCREENS.get(screen_type)
    if not screen_fn:
        return []

    if not stock_pool:
        # 默认：沪深300 + 中证500 + 创业板部分
        stock_pool = ["600519", "000858", "000001", "600036", "000333",
                      "300750", "002594", "601318", "600276", "000651",
                      "300059", "600900", "601888", "000568", "002475"]

    results = []
    for code in stock_pool[:50]:  # 限制每次扫描数量
        try:
            market, sec_code = normalize_stock_code(code)
            bars = data_source.get_security_bars(sec_code, market, category=9, count=250)
            if not bars:
                continue
            df = pd.DataFrame(bars)
            if screen_fn(df):
                # 获取最新价
                quotes = data_source.get_security_quotes([(market, sec_code)])
                if quotes:
                    q = quotes[0]
                    results.append({
                        "code": sec_code,
                        "name": q["name"],
                        "price": q["price"],
                        "change_pct": q["change_pct"],
                        "type": screen_type,
                    })
            if len(results) >= max_results:
                break
        except Exception as e:
            logger.debug(f"筛选 {code} 失败: {e}")
            continue

    return results


def calculate_market_temperature(idx_data: dict) -> dict:
    """
    大盘情绪温度计 (0-100)
    对应：通达信公式/1_大盘择时/大盘情绪温度计.tn6
    """
    score = 50
    details = {}

    # 沪深300 涨跌幅
    if "000300" in idx_data:
        change = idx_data["000300"].get("change_pct", 0)
        if change > 1.5:
            trend = 30
        elif change > 0.5:
            trend = 20
        elif change > -0.5:
            trend = 10
        else:
            trend = 0
        score += (trend - 10)
        details["趋势分"] = trend

    # 量能
    if "000300" in idx_data:
        vol_ratio = idx_data["000300"].get("volume_ratio", 1)
        if 1 <= vol_ratio <= 2:
            volume_score = 20
        elif vol_ratio < 1:
            volume_score = 5
        else:
            volume_score = 15
        details["量能分"] = volume_score
        score = (score + volume_score) // 2

    score = max(0, min(100, score))
    return {
        "温度评分": score,
        "details": details,
        "建议仓位": (
            "80-100%" if score >= 80 else
            "60-80%" if score >= 60 else
            "40-60%" if score >= 40 else
            "20-40%" if score >= 20 else
            "0-20%"
        ),
    }
