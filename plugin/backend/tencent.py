"""
腾讯行情接口（K线备选源，与东财互为灾备）

- 日/周/月K（qfq 前复权，与东财 fqt=1 口径一致）
  https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq
- 分钟K（m5/m15/m30/m60）
  https://web.ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m5,,320

失败返回空列表，由调用方回退。
"""

import httpx
from loguru import logger
from typing import Dict, List

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://gu.qq.com/",
}

_client: httpx.Client = None


def _get_client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(
            headers=_HEADERS, timeout=6.0,
            limits=httpx.Limits(max_keepalive_connections=0))
    return _client


def _symbol(code: str, market: int) -> str:
    return ("sh" if market == 1 else "sz") + code


def get_realtime_quotes(codes: List[tuple]) -> List[Dict]:
    """腾讯批量实时行情（pytdx 灾备；盘后返回最近收盘数据，稳定且快）

    codes=[(market, code), ...] 单次≤60 只。响应 GBK 文本：
    v_sz000066="51~中国长城~000066~14.10~15.70~14.20~...~"; 字段 [3]=现价 [4]=昨收，
    涨跌%=[32]（部分品种 [32] 缺失时用现价/昨收现算）。
    """
    client = _get_client()
    url = "https://qt.gtimg.cn/q=" + ",".join(_symbol(cd, mk) for mk, cd in codes)
    r = client.get(url)
    r.raise_for_status()
    out: List[Dict] = []
    for line in r.content.decode("gbk", errors="ignore").splitlines():
        if '="' not in line:
            continue
        sym, _, body = line.partition('="')
        body = body.rstrip('";').strip()
        f = body.split("~")
        if len(f) < 5:
            continue
        code = f[2]
        try:
            price = float(f[3])
            prev = float(f[4])
        except ValueError:
            continue
        pct = None
        if len(f) > 32:
            try:
                pct = float(f[32])
            except ValueError:
                pct = None
        if pct is None and prev:
            pct = round((price - prev) / prev * 100, 2)
        out.append({"code": code, "price": price, "prev_close": prev, "change_pct": pct})
    return out


# 东财 klt → 腾讯周期
_KLT_MAP = {101: "day", 102: "week", 103: "month"}
_MKLT_MAP = {5: "m5", 15: "m15", 30: "m30", 60: "m60"}


def get_kline(code: str, market: int, klt: int = 101, lmt: int = 250) -> List[Dict]:
    """腾讯K线，返回与东财 get_kline 同构的列表（升序）"""
    symbol = _symbol(code, market)
    try:
        if klt in _KLT_MAP:
            period = _KLT_MAP[klt]
            url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
                   f"?param={symbol},{period},,,{min(lmt, 640)},qfq")
            data = _get_client().get(url).json()
            node = (data.get("data") or {}).get(symbol) or {}
            rows = node.get("qfqday") or node.get("day") or []
            # [date, open, close, high, low, volume, ...]
            bars = []
            for r in rows:
                if len(r) < 6:
                    continue
                try:
                    bars.append({
                        "datetime": str(r[0]),
                        "open": float(r[1]), "close": float(r[2]),
                        "high": float(r[3]), "low": float(r[4]),
                        "volume": float(r[5]), "amount": 0.0,
                    })
                except (ValueError, TypeError):
                    continue
            return bars
        elif klt in _MKLT_MAP:
            period = _MKLT_MAP[klt]
            url = (f"https://ifzq.gtimg.cn/appstock/app/kline/mkline"
                   f"?param={symbol},{period},,,{min(lmt, 800)}")
            data = _get_client().get(url).json()
            node = (data.get("data") or {}).get(symbol) or {}
            rows = node.get(period) or []
            bars = []
            for r in rows:
                if len(r) < 6:
                    continue
                try:
                    dt = str(r[0])
                    # 分钟线日期格式 202608201325 → 2026-08-20 13:25
                    if len(dt) == 12 and dt.isdigit():
                        dt = f"{dt[:4]}-{dt[4:6]}-{dt[6:8]} {dt[8:10]}:{dt[10:12]}"
                    bars.append({
                        "datetime": dt,
                        "open": float(r[1]), "close": float(r[2]),
                        "high": float(r[3]), "low": float(r[4]),
                        "volume": float(r[5]), "amount": 0.0,
                    })
                except (ValueError, TypeError):
                    continue
            return bars
        return []
    except Exception as e:
        logger.debug(f"腾讯K线失败 {symbol}: {e}")
        return []
