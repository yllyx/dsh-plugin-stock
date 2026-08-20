"""
东方财富免费行情接口客户端

补充 pytdx 无法覆盖的聚合数据：
- 涨停池 / 跌停池 / 炸板池（连板梯队、封板时间、炸板次数）
- 行业/概念板块排行（涨幅、成交额、换手、上涨下跌家数、领涨股）
- 板块成分股、板块指数日K（板块阶段判定）
- 两融余额（日线级，可选）
- 全市场 A 股代码列表（选股预热池 / 股票->行业映射）

所有请求 5s 超时，失败返回 None / 空结构，由调用方降级处理。
"""

import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx
from loguru import logger

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}

_client: Optional[httpx.Client] = None


def _get_client() -> httpx.Client:
    global _client
    if _client is None:
        # 禁用 keep-alive：东财服务端会主动断开复用连接，
        # 导致 "Server disconnected without sending a response"
        _client = httpx.Client(
            headers=_HEADERS,
            timeout=5.0,
            limits=httpx.Limits(max_keepalive_connections=0),
        )
    return _client


def _get_json(url: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """GET 并解析 JSON，任何异常返回 None（调用方降级）"""
    try:
        resp = _get_client().get(url, params=params)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.debug(f"东财接口失败 {url.split('?')[0]}: {e}")
        return None


def _get_json_with_retry(url: str, params: Dict[str, Any], retries: int = 1) -> Optional[Dict[str, Any]]:
    for i in range(retries + 1):
        data = _get_json(url, params)
        if data is not None:
            return data
        time.sleep(0.3)
    return None


# push2 主域可能对高频访问限流（Server disconnected），delay 镜像域数据相同、更宽松
PUSH2_BASES = [
    "https://push2.eastmoney.com",
    "https://push2delay.eastmoney.com",
]


def _api_get(path: str, params: Dict[str, Any], bases: List[str] = None, retries_per_base: int = 1) -> Optional[Dict[str, Any]]:
    """跨多个镜像域名请求，全部失败才返回 None"""
    for base in (bases or PUSH2_BASES):
        data = _get_json_with_retry(base + path, params, retries=retries_per_base)
        if data is not None:
            return data
    return None


def _page_clist(fs: str, fields: str, max_count: int, sort_fid: str = "f3") -> List[Dict[str, Any]]:
    """
    分页拉取 clist 列表接口（单页上限100条，页间加间隔防断连）
    """
    items: List[Dict[str, Any]] = []
    pn = 1
    while len(items) < max_count:
        params = {
            "pn": pn,
            "pz": 100,
            "po": 1,
            "np": 1,
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fltt": 2,
            "invt": 2,
            "fid": sort_fid,
            "fs": fs,
            "fields": fields,
        }
        data = _api_get("/api/qt/clist/get", params)
        if not data:
            break
        diff = (data.get("data") or {}).get("diff") or []
        if not diff:
            break
        items.extend(diff)
        pn += 1
        if len(diff) < 100:
            break
        time.sleep(0.15)  # 防止连续请求被服务端断连
    return items


# ============= 涨跌停池 =============

def _pool_url(kind: str) -> str:
    return f"https://push2ex.eastmoney.com/getTopic{kind}Pool"


def _fetch_pool(kind: str, date: str) -> List[Dict[str, Any]]:
    params = {
        "ut": "7eea3edcaed734bea9cbfc24409ed989",
        "dpt": "wz.ztzt",
        "Pageindex": 0,
        "pagesize": 10000,
        "sort": "fbt:asc",
        "date": date,
    }
    data = _get_json_with_retry(_pool_url(kind), params)
    if not data:
        return []
    pool = (data.get("data") or {}).get("pool") or []
    return pool


def _parse_pool_item(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "code": item.get("c", ""),
        "name": item.get("n", ""),
        "price": round(item.get("p", 0) / 1000, 2),
        "change_pct": item.get("zdp", 0),
        "lbc": item.get("lbc", 1),          # 连板数
        "fbt": item.get("fbt", 0),          # 首次封板时间 HHMMSS
        "zbc": item.get("zbc", 0),          # 炸板次数
        "hs": item.get("hs", 0),            # 换手率 %
        "ltsz": item.get("ltsz", 0),        # 流通市值（元）
        "hybk": item.get("hybk", ""),       # 所属行业
    }


def _today_or_yesterday() -> str:
    return datetime.now().strftime("%Y%m%d")


def get_zt_pool(date: Optional[str] = None) -> List[Dict[str, Any]]:
    """涨停池。date 为 YYYYMMDD，默认今天（空则自动回退昨天）"""
    date = date or _today_or_yesterday()
    pool = _fetch_pool("ZT", date)
    if not pool and date == _today_or_yesterday():
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
        pool = _fetch_pool("ZT", yesterday)
    return [_parse_pool_item(i) for i in pool]


def get_dt_pool(date: Optional[str] = None) -> List[Dict[str, Any]]:
    """跌停池"""
    date = date or _today_or_yesterday()
    pool = _fetch_pool("DT", date)
    if not pool and date == _today_or_yesterday():
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
        pool = _fetch_pool("DT", yesterday)
    return [_parse_pool_item(i) for i in pool]


def get_zb_pool(date: Optional[str] = None) -> List[Dict[str, Any]]:
    """炸板池（曾涨停后打开）"""
    date = date or _today_or_yesterday()
    pool = _fetch_pool("ZB", date)
    return [_parse_pool_item(i) for i in pool]


# ============= 板块 =============

_BOARD_FS = {
    "industry": "m:90+t:2+f:!50",
    "concept": "m:90+t:3+f:!50",
}

_BOARD_FIELDS = "f2,f3,f4,f6,f8,f12,f13,f14,f104,f105,f128,f136,f140"


def _fmt_num(v) -> Optional[float]:
    """东财 fltt=2 时数值已是 float，但停牌等情况会返回 '-'"""
    if v in (None, "-", ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def get_board_rank(board_type: str = "industry", max_count: int = 200) -> List[Dict[str, Any]]:
    """行业/概念板块排行（接口按涨跌幅降序返回，取前 max_count 个已够排行展示）"""
    fs = _BOARD_FS.get(board_type)
    if not fs:
        return []
    diff = _page_clist(fs, _BOARD_FIELDS, max_count=max_count)
    result = []
    for d in diff:
        result.append({
            "bk_code": d.get("f12", ""),
            "name": d.get("f14", ""),
            "price": _fmt_num(d.get("f2")),
            "change_pct": _fmt_num(d.get("f3")),
            "change": _fmt_num(d.get("f4")),
            "amount": _fmt_num(d.get("f6")) or 0,      # 成交额（元）
            "turnover_rate": _fmt_num(d.get("f8")),
            "up_count": d.get("f104", 0),              # 板内上涨家数
            "down_count": d.get("f105", 0),            # 板内下跌家数
            "leader_name": d.get("f128", ""),          # 领涨股
            "leader_code": d.get("f140", ""),
            "leader_change_pct": _fmt_num(d.get("f136")),
        })
    return result


def get_board_stocks(bk_code: str, max_count: int = 1000) -> List[Dict[str, Any]]:
    """板块成分股（按涨幅降序）"""
    diff = _page_clist(f"b:{bk_code}+f:!50",
                       "f2,f3,f8,f10,f12,f13,f14,f20,f21", max_count)
    stocks = []
    for d in diff:
        stocks.append({
            "code": d.get("f12", ""),
            "market": d.get("f13", 0),
            "name": d.get("f14", ""),
            "price": _fmt_num(d.get("f2")),
            "change_pct": _fmt_num(d.get("f3")),
            "turnover_rate": _fmt_num(d.get("f8")),
            "volume_ratio": _fmt_num(d.get("f10")),
            "total_mv": _fmt_num(d.get("f20")) or 0,   # 总市值（元）
            "float_mv": _fmt_num(d.get("f21")) or 0,   # 流通市值（元）
        })
    return stocks


def get_board_kline(bk_code: str, days: int = 60) -> List[Dict[str, Any]]:
    """板块指数日K（用于板块阶段判定/动量计算）"""
    return get_kline(f"90.{bk_code}", klt=101, lmt=days)


# 历史K线有多个编号子域镜像，轮询可分散限流压力
KLINE_BASES = [
    "https://push2his.eastmoney.com",
    "https://21.push2his.eastmoney.com",
    "https://92.push2his.eastmoney.com",
    "https://48.push2his.eastmoney.com",
]


def get_kline(secid: str, klt: int = 101, lmt: int = 250) -> List[Dict[str, Any]]:
    """
    东财K线（个股/指数/板块通用），secid 形如 '1.600519' / '1.000300' / '90.BK0475'
    klt: 1=1分, 5=5分, 15=15分, 30=30分, 60=60分, 101=日, 102=周, 103=月
    """
    params = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5",
        "fields2": "f51,f52,f53,f54,f55,f56,f57",
        "klt": klt,
        "fqt": 1,
        "end": "20500101",
        "lmt": lmt,
    }
    data = None
    for base in KLINE_BASES:
        data = _get_json_with_retry(base + "/api/qt/stock/kline/get", params, retries=0)
        if data is not None:
            break
        time.sleep(0.2)
    if not data:
        return []
    klines = ((data.get("data") or {}).get("klines")) or []
    result = []
    for line in klines:
        # 格式: 日期[,时分],开,收,高,低,成交量,成交额
        parts = line.split(",")
        if len(parts) < 7:
            continue
        try:
            result.append({
                "datetime": parts[0],
                "open": float(parts[1]),
                "close": float(parts[2]),
                "high": float(parts[3]),
                "low": float(parts[4]),
                "volume": float(parts[5]),
                "amount": float(parts[6]),
            })
        except (ValueError, IndexError):
            continue
    return result


# ============= 两融余额（可选降级） =============

def get_margin_balance(days: int = 10) -> Optional[List[Dict[str, Any]]]:
    """
    沪深两融余额历史（日线级，降级返回 None）
    返回按日期降序: [{"date": "2026-08-19", "rzye": 融资余额, "rqye": ..., "rzrqye": 总余额}, ...]
    """
    params = {
        "reportName": "RPTA_RZRQ_LSHJ",
        "columns": "ALL",
        "source": "WEB",
        "sortColumns": "dim_date",
        "sortTypes": "-1",
        "pageNumber": 1,
        "pageSize": days,
    }
    data = _get_json("https://datacenter-web.eastmoney.com/api/data/v1/get", params)
    if not data:
        return None
    rows = ((data.get("result") or {}).get("data")) or []
    result = []
    for r in rows:
        try:
            result.append({
                "date": str(r.get("DIM_DATE", ""))[:10],
                "rzye": float(r.get("RZYE", 0)),       # 融资余额
                "rqye": float(r.get("RQYE", 0)),       # 融券余额
                "total": float(r.get("RZRQYE", 0)),    # 两融总余额
            })
        except (TypeError, ValueError):
            continue
    return result if result else None


# ============= 指数实时行情（pytdx 不可用时的回退源） =============

def get_index_quotes(secids: List[str]) -> List[Dict[str, Any]]:
    """
    指数实时行情（东财 ulist，一次请求多个指数）
    secids 形如 ["1.000001", "0.399001", "1.000300"]
    返回与 pytdx 行情同构的 dict 列表
    """
    params = {
        "fltt": 2,
        "invt": 2,
        "fields": "f2,f3,f4,f12,f13,f14",
        "secids": ",".join(secids),
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "np": 1,
    }
    data = _api_get("/api/qt/ulist.np/get", params)
    if not data:
        return []
    diff = (data.get("data") or {}).get("diff") or []
    result = []
    for d in diff:
        price = _fmt_num(d.get("f2"))
        pct = _fmt_num(d.get("f3"))
        if price is None:
            continue
        result.append({
            "code": d.get("f12", ""),
            "name": d.get("f14", "") or "",
            "price": price,
            "change_pct": pct if pct is not None else 0.0,
            "change": _fmt_num(d.get("f4")) or 0.0,
            "last_close": round(price / (1 + (pct or 0) / 100), 3),
        })
    return result


# ============= 个股所属行业 =============

def get_stock_industry(code: str, market: int) -> Optional[str]:
    """个股所属行业（用于持仓同板块集中度检查）"""
    params = {
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "invt": 2,
        "fltt": 2,
        "fields": "f127",
        "secid": f"{market}.{code}",
    }
    data = _api_get("/api/qt/stock/get", params)
    if not data:
        return None
    return (data.get("data") or {}).get("f127") or None


# ============= 全市场股票列表 =============

_A_SHARE_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"  # 深主板/创业板/沪主板/科创板


def get_all_stock_codes(max_count: int = 6000) -> List[Dict[str, Any]]:
    """全市场 A 股列表 [{"code","market","name"}]，排除退市股"""
    diff = _page_clist(_A_SHARE_FS, "f12,f13,f14", max_count, sort_fid="f12")
    stocks = []
    for d in diff:
        name = d.get("f14", "")
        if "退" in name:
            continue
        stocks.append({
            "code": d.get("f12", ""),
            "market": d.get("f13", 0),
            "name": name,
        })
    return stocks
