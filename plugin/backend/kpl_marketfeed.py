# -*- coding: utf-8 -*-
"""
开盘啦(KPL) 行情菜单订阅面（二期）—— socket 订阅 + 拉取式接口的统一数据层

数据源全部为 App 同源（2026-09-30 实测定案）：
- 2100-2126 (HQDaBan 家族, pb.Empty 订阅)：订阅后服务端以全量快照持续推送
  （盘中/盘后均推送，样本 18:4x 实抓）。推送由 kpl_socket.Session._feed_frames
  分帧入库 sub_latest，本模块负责订阅管理+语义化解析。
- 3003 (AppGlobal.SubMainIndexTrends)：主指数分时（拉取式），currNums=[0,1,2]
  = 上证/深证/创业板；价格 4 位定点（38304500→3830.45），time=HHMMSS00。
- ZhiShuRanking/RealRankingInfo (HTTP, apphwshhq)：板块强度表
  （App 行情菜单·板块 tab 表格，列头 Title 服务端下发"第二季度机构增仓/2026年平均PE/
  2027年平均PE"与 App 表头逐字一致；Type=12/13/14 实测返回 801 板块行）。

⚠️ ASCII 前缀剥离必须用 mini 头 bytes[2:4] 的长度值（权威）：
   2106 的前缀是 "hqDaban|133:20010/2106-0/0"（26 字符，尾部多参数回显），
   按 regex 匹配到斜杠会错位 1 字节导致整帧解析失败（2026-09-30 实锤）。
"""

import json
import struct
import threading
import time
from typing import Any, Dict, List, Optional

from loguru import logger

SUB_CMDS = [2100, 2101, 2106, 2107, 2108, 2109, 2110, 2111,
            2114, 2115, 2116, 2117, 2126,
            3004, 3007]
# 3004 HQList.SubRealtimeLHB：行情菜单·个股 tab 全市场榜单（RealtimeLHBReq，LHB=LeaderBoard）
#   {quotaType1, sortType2, cxType3, limitType4, stType5(沪), zbType6(中小), cybType7(创业),
#    kcbType8(科创), bjsType9(北交), indexType10, start20, count21, startTime30, endTime31}
#   2026-09-30 实锤（RealTimeChartsPresenter 字节码）：App 用 3101(GetRealtimeLHBRangeData，
#   区间回放 startTime/endTime=HHMM 整数) / 3004 订阅实时；两者盘后均静默（App 靠本地缓存），
#   盘中订阅有推送。items = GroupStockQuotasResp.Item（quotas f100 动态列）。
# 3007 HQList.SubPlateTypeQuotasList：行情菜单·板块 tab 强度表
#   （PlateListPresenter 字节码实锤）Req{quotaType1, sortType2, plateType3, start4, count5}；
#   Resp Item{plateId1, plateName2, strength3, incRate4, incSpeed5, tur6, mainNetAmount7, mainBuy8...}
#   盘后同样静默。
# 2121 涨停股票列表（打板 tab"涨停"列表，QxZtSituationStockReq{bsType1,orderType2,sortType3}）
# 带参订阅：请求体非 pb.Empty，与 SUB_CMDS 分开发送
ZT_LIST_CMD = 2121


def _zt_list_body() -> bytes:
    from kpl_socket import pb_uint
    return pb_uint(1, 1) + pb_uint(2, 1) + pb_uint(3, 1)


def _stock_rank_body() -> bytes:
    """3004 个股榜单请求体：全市场开关全开，涨幅序，count 由调用端改（此处 50）"""
    from kpl_socket import pb_uint
    return (pb_uint(1, 1) + pb_uint(2, 1) + pb_uint(5, 1) + pb_uint(6, 1)
            + pb_uint(7, 1) + pb_uint(8, 1) + pb_uint(9, 1)
            + pb_uint(20, 0) + pb_uint(21, 50))


def _plate_rank_body(plate_type: int = 1, count: int = 30) -> bytes:
    """3007 板块强度表请求体"""
    from kpl_socket import pb_uint
    return (pb_uint(1, 1) + pb_uint(2, 1) + pb_uint(3, plate_type)
            + pb_uint(4, 0) + pb_uint(5, count))

MAX_PUSH_AGE = 120          # 推送超过该秒数视为 stale（服务端推送周期约 30-60s）
SNAP_FRESH_S = 20           # snapshot 内存缓存新鲜窗


# ============= 通用 protobuf 解析 =============

def pb_tree(msg: bytes, depth: int = 0) -> Any:
    """通用递归解析：返回标量 / dict / list。
    bytes 先试 UTF-8 文本（无控制字符才当文本），否则递归为子消息。
    同一字段多次出现（repeated）→ 聚合为 list。"""
    if depth > 8:
        return f"<{len(msg)}B>"
    out: Dict[str, list] = {}
    i, n = 0, len(msg)
    try:
        while i < n:
            tag, shift = 0, 0
            while True:
                b = msg[i]; i += 1
                tag |= (b & 0x7F) << shift; shift += 7
                if not b & 0x80:
                    break
            fno, wt = tag >> 3, tag & 7
            if wt == 0:
                v, shift = 0, 0
                while True:
                    b = msg[i]; i += 1
                    v |= (b & 0x7F) << shift; shift += 7
                    if not b & 0x80:
                        break
                val = v
            elif wt == 2:
                ln, shift = 0, 0
                while True:
                    b = msg[i]; i += 1
                    ln |= (b & 0x7F) << shift; shift += 7
                    if not b & 0x80:
                        break
                raw = msg[i:i + ln]; i += ln
                val = _decode_bytes(raw, depth)
            elif wt == 5:
                val = struct.unpack("<f", msg[i:i + 4])[0]; i += 4
            elif wt == 1:
                val = struct.unpack("<q", msg[i:i + 8])[0]; i += 8
            else:
                break
            out.setdefault(str(fno), []).append(val)
    except (IndexError, struct.error):
        pass  # 截断尾帧：保留已解析部分（推送采集窗内正常现象）
    return {k: (v[0] if len(v) == 1 else v) for k, v in out.items()}


def _decode_bytes(raw: bytes, depth: int) -> Any:
    try:
        txt = raw.decode("utf-8")
        if txt and not any(ord(c) < 32 and c not in "\n\t\r" for c in txt):
            return txt
    except Exception:
        pass
    if not raw:
        return ""
    return pb_tree(raw, depth + 1)


def strip_push_prefix(body: bytes) -> bytes:
    """剥推送 body 的 4B mini 头 + ASCII 前缀。前缀长度以 mini 头 bytes[2:4] 为权威。
    ⚠️ 仅用于"组首帧"——大快照的分帧续体不带 mini 头，拼接后统一剥一次。"""
    if len(body) < 6:
        return body
    plen = int.from_bytes(body[2:4], "big")
    if 0 < plen < 200 and len(body) >= 4 + plen:
        return body[4 + plen:]
    return body


def _looks_like_frame_head(body: bytes) -> bool:
    """该 body 是否以 mini头+ASCII前缀 开头（组帧判定用）"""
    if len(body) < 8:
        return False
    plen = int.from_bytes(body[2:4], "big")
    if not (4 < plen < 200):
        return False
    head = body[4:4 + plen]
    return head[:1].isascii() and head.isascii() and b"|" in head


# ============= 各 cmd 语义化 =============

def _sub_snap(node: dict) -> dict:
    """2114 内层快照：f1-6 标量 + f20 分布"""
    return {
        "zt": node.get("1"), "dt": node.get("2"),
        "realZt": node.get("3"), "realDt": node.get("4"),
        "rise": node.get("5"), "down": node.get("6"),
        "dists": _dists(node.get("20")),
    }


def _dists(v) -> list:
    out = []
    for it in v if isinstance(v, list) else ([v] if isinstance(v, dict) else []):
        if isinstance(it, dict):
            out.append({"k": str(it.get("1", "")), "v": it.get("2")})
    out.sort(key=lambda x: float(x["k"]) if x["k"] not in ("", "-") else 0)
    return out


def _kv_rows(v) -> list:
    """2126/2101 行数组归一"""
    return [r for r in (v if isinstance(v, list) else ([v] if isinstance(v, dict) else []))
            if isinstance(r, dict)]


def _flat(msg: bytes):
    """protobuf 平铺（3004 items 的 f100 quotas 列遍历用）"""
    from kpl_socket import pb_flat
    return pb_flat(msg)


def parse_cmd(cmd: int, body) -> Optional[dict]:
    """原始推送（bytes 单帧 或 parts 列表）→ 语义 dict。字段号依据 2026-09-30 样本解析。
    多帧按 protobuf merge 语义合并（repeated 拼接/标量取新），与服务端消息合并规则一致。"""
    if isinstance(body, (list, tuple)):
        parts = [p for p in body if p]
        if not parts:
            return None
        if len(parts) == 1:
            return parse_cmd(cmd, parts[0])
        trees = []
        for p in parts:
            pb = strip_push_prefix(p) if _looks_like_frame_head(p) else p
            tr = pb_tree(pb)
            if isinstance(tr, dict):
                trees.append(tr)
        if not trees:
            return None
        merged: dict = {}
        for tr in trees:
            _merge_pb(merged, tr)
        return _parse_cmd_tree(cmd, merged)
    pb = strip_push_prefix(body)
    t = pb_tree(pb)
    if not isinstance(t, dict):
        return None
    return _parse_cmd_tree(cmd, t)


def _merge_pb(dst: dict, src: dict) -> None:
    for k, v in src.items():
        if k not in dst:
            dst[k] = v
        elif isinstance(dst[k], list) and isinstance(v, list):
            dst[k] = dst[k] + v
        elif isinstance(dst[k], dict) and isinstance(v, dict):
            _merge_pb(dst[k], v)
        else:
            dst[k] = v


def _parse_cmd_tree(cmd: int, t: dict) -> Optional[dict]:
    try:
        if cmd == 2100:      # 打板情绪条（DaBanHeadResp）
            return {"zt": [t.get("1"), t.get("2")], "fb": [t.get("3"), t.get("4")],
                    "dt": [t.get("5"), t.get("6")]}
        if cmd == 2101:      # 市场雷达（DaBanMarketRadarResp items f10）
            items = []
            for it in _kv_rows(t.get("10")):
                items.append({
                    "status": it.get("1"), "color": it.get("2"),
                    "content": it.get("3"), "code": it.get("4"),
                    "name": it.get("5"), "ts": it.get("6"),
                    "plateType": it.get("7"), "incRate": it.get("8"),
                })
            items.sort(key=lambda x: x.get("ts") or 0, reverse=True)
            return {"items": items[:30]}
        if cmd == 2106:      # 量能（QxMarketEnergyResp）
            series = []
            for it in _kv_rows(t.get("10")):
                series.append({
                    "time": it.get("1"), "cur": it.get("2"), "yes": it.get("3"),
                    "pred": it.get("4"), "pct": it.get("5"), "text": it.get("6"),
                    "color": it.get("7"), "ratio": it.get("10"),
                })
            return {"amount": t.get("9"), "text": t.get("5"),
                    "flag": t.get("6"), "day": t.get("8"), "series": series}
        if cmd == 2107:      # 涨停形势（QxZtSituationRespV2）
            return {"v": [t.get(f) for f in
                          ("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11")],
                    "text": t.get("12") if isinstance(t.get("12"), str) else None}
        if cmd == 2108:      # 权重表现（QxWeightPerformanceResp）
            def _stock(it):
                return {"code": it.get("1"), "name": it.get("2"),
                        "pct": it.get("3"), "x": it.get("4")}
            return {
                "downStocks": [_stock(x) for x in _kv_rows(t.get("1"))],
                "day": t.get("2"), "v3": t.get("3"), "zt": t.get("4"),
                "comment": t.get("5") if isinstance(t.get("5"), str) else None,
                "upPlates": [{"id": x.get("1"), "name": x.get("2"), "pct": x.get("3"),
                              "leadCode": x.get("4"), "leadName": x.get("5")}
                             for x in _kv_rows(t.get("10"))],
                "downPlates": [{"id": x.get("1"), "name": x.get("2"), "pct": x.get("3"),
                                "leadCode": x.get("4"), "leadName": x.get("5")}
                               for x in _kv_rows(t.get("11"))],
            }
        if cmd == 2109:      # 北向资金（QxNorthboundFundsResp）
            f20 = t.get("20") if isinstance(t.get("20"), dict) else {}
            f21 = t.get("21") if isinstance(t.get("21"), dict) else {}
            return {"day": t.get("1"), "net": t.get("2"),
                    "text": t.get("3") if isinstance(t.get("3"), str) else None,
                    "disclose": {k: v for k, v in f20.items() if isinstance(v, str)},
                    "amounts": {k: v for k, v in f21.items() if isinstance(v, str)}}
        if cmd == 2110:      # 涨跌统计（QxZDStatResp）
            return {"zt": t.get("1"), "dt": t.get("2"),
                    "realZt": t.get("3"), "realDt": t.get("4"),
                    "rise": t.get("5"), "down": t.get("6"),
                    "sign": t.get("7") if isinstance(t.get("7"), str) else None,
                    "day": t.get("8"), "dists": _dists(t.get("10"))}
        if cmd == 2111:      # 情绪提示（QxZDStatLineChartResp）
            tip = t.get("6")
            return {"v1": t.get("1"), "v2": t.get("2"), "realZt": t.get("3"),
                    "realDt": t.get("4"), "day": t.get("5"),
                    "tip": tip if isinstance(tip, str) else None}
        if cmd == 2114:      # 涨跌分布今昨（QxNewZDStatResp）
            return {"day": t.get("1"),
                    "today": _sub_snap(t.get("10")) if isinstance(t.get("10"), dict) else {},
                    "yest": _sub_snap(t.get("11")) if isinstance(t.get("11"), dict) else {}}
        if cmd == 2115:      # 市场总览（QxMarketOverviewResp）
            return {"hsPct": t.get("1"), "hsAmount": t.get("2"),
                    "hsjPct": t.get("3"), "hsjAmount": t.get("4"),
                    "strongTD": t.get("5"), "strongYD": t.get("6"),
                    "qx": t.get("9"), "qxStatus": t.get("10"),
                    "drawback": t.get("11"),
                    "forecastMoney": t.get("12") if isinstance(t.get("12"), str) else None,
                    "forecastZf": t.get("13") if isinstance(t.get("13"), str) else None}
        if cmd == 2116:      # 涨停家数分钟序列 + 盘面播报（QxPlateStrengthAndLossEffectResp）
            series = []
            for it in _kv_rows(t.get("10")):
                series.append({"time": it.get("1"), "n": it.get("2")})
            series.sort(key=lambda x: str(x.get("time") or ""))
            broadcast = t.get("20")
            return {"day": t.get("1"), "series": series,
                    "broadcast": broadcast if isinstance(broadcast, str) else None}
        if cmd == 2117:      # 连板天梯（QxMarketHighBenchmarkResp f20）
            ladder = []
            for it in _kv_rows(t.get("20")):
                st = it.get("2")
                stocks = []
                for s in st if isinstance(st, list) else ([st] if isinstance(st, dict) else []):
                    if isinstance(s, dict):
                        stocks.append({"code": s.get("1"), "name": s.get("2"), "ts": s.get("3")})
                stocks.sort(key=lambda x: int(x.get("ts") or 0))
                ladder.append({"h": it.get("1"), "stocks": stocks})
            ladder.sort(key=lambda x: int(x.get("h") or 0), reverse=True)
            return {"day": t.get("1"), "ladder": ladder}
        if cmd == 2126:      # 风向标（QxWindVaneResp up/down）
            def _row(it):
                return {"code": it.get("1"), "name": it.get("2"),
                        "pct": it.get("3"), "plate": it.get("4")}
            return {"up": [_row(x) for x in _kv_rows(t.get("1"))],
                    "down": [_row(x) for x in _kv_rows(t.get("2"))]}
        if cmd == ZT_LIST_CMD:   # 涨停股票列表（QxZtSituationStockResp）
            items = []
            for it in _kv_rows(t.get("10")):
                items.append({
                    "code": it.get("1"), "name": it.get("2"), "tag": it.get("3"),
                    "state": it.get("4"), "price": it.get("5"), "pct": it.get("6"),
                    "ztTime": it.get("7"),
                    "ztReason": it.get("8") if isinstance(it.get("8"), str) else None,
                    "reasonCount": it.get("9"),
                })
            items.sort(key=lambda x: x.get("ztTime") or 0)
            return {"day": t.get("4"), "total": t.get("5"), "items": items}
        if cmd == 3004:      # 个股 tab 全市场榜单（RealtimeLHBResp）
            items = []
            for it in _kv_rows(t.get("41")):
                row, quotas = {}, []
                for f2, _w, v2 in _flat(it):
                    if f2 == 100 and isinstance(v2, bytes):
                        quotas.append(v2.decode("utf8", "replace"))
                    elif isinstance(v2, bytes):
                        row[str(f2)] = v2.decode("utf8", "replace")
                    else:
                        row[str(f2)] = v2
                row["quotas"] = quotas
                items.append(row)
            return {"total": t.get("30"), "day": ((t.get("33") or [""])[0]
                    if isinstance(t.get("33"), list) else t.get("33")),
                    "items": items}
        if cmd == 3007:      # 板块 tab 强度表（PlateTypeQuotasListResp）
            items = []
            for it in _kv_rows(t.get("12")):
                items.append({
                    "plateId": it.get("1"), "plateName": it.get("2"),
                    "strength": it.get("3"), "incRate": it.get("4"),
                    "incSpeed": it.get("5"), "tur": it.get("6"),
                    "mainNet": it.get("7"), "mainBuy": it.get("8"),
                })
            names = t.get("11")
            return {"total": t.get("9"),
                    "indexNames": names if isinstance(names, list) else
                    ([names] if names else []),
                    "items": items}
    except Exception as e:
        logger.debug(f"marketfeed parse {cmd}: {e}")
        return None
    return {"raw": t}


# ============= 主指数分时 3003 =============

def parse_index_trends(body: bytes) -> Optional[list]:
    """3003 响应 body（含 mini头+前缀）→ [{code?, day, preClose, turnover, points}]。
    currNums 顺序即请求顺序 [0,1,2]=上证/深证/创业板（响应无 id 字段按序对齐）。"""
    pb = strip_push_prefix(body)
    t = pb_tree(pb)
    if not isinstance(t, dict):
        return None
    out = []
    for it in _kv_rows(t.get("1")):
        pts = []
        for p in _kv_rows(it.get("10")):
            tm = int(p.get("1") or 0) // 100000         # HMMSSmmm(93000000=9:30) → HMM(930)
            pts.append({"t": f"{tm // 100:02d}:{tm % 100:02d}",
                        "v": (int(p.get("2") or 0)) / 10000.0})
        out.append({"day": str(it.get("3") or ""), "preClose": (int(it.get("4") or 0)) / 10000.0,
                    "turnover": it.get("5"), "total": it.get("9"), "points": pts})
    return out


# ============= 板块强度表 RealRankingInfo =============

def get_plate_rank(client) -> dict:
    """App 行情菜单·板块 tab 强度表：ZhiShuRanking/RealRankingInfo。
    Type=12/13/14（精选/行业两 tab 的数据行，2026-09-30 实测 801 板块返回）；
    列头 Title 由服务端下发。ZSType=1 Index=0 st=每页条数 Order=1。"""
    out = {"tabs": {}}
    for typ, name in ((12, "sel"), (13, "hy")):
        try:
            d = client.call("https://apphwshhq.longhuvip.com/w1/api/index.php",
                            "ZhiShuRanking", "RealRankingInfo",
                            {"Type": typ, "ZSType": 1, "Index": 0, "st": 30, "Order": 1,
                             "RStart": 0, "REnd": 29}, authed=True)
            if not isinstance(d, dict):
                continue
            rows = []
            for r in d.get("list") or []:
                if isinstance(r, list) and r:
                    rows.append(r)
            out["tabs"][name] = {"title": d.get("Title") or [], "list": rows,
                                 "count": d.get("Count"), "day": (d.get("Day") or [""])[0]}
        except Exception as e:
            logger.debug(f"RealRankingInfo Type={typ}: {e}")
    return out


# ============= 订阅管理器 =============

INDEX_NAMES = ["SH", "SZ", "CYB"]   # 3003 currNums 顺序：上证/深证/创业板


def get_index_trend(max_age: float = 30) -> Dict[str, Any]:
    """3003 主指数分时（拉取式，App 直播 tab 大盘分时图 + 板块 tab 顶部横滑卡同源）。
    currNums=[0,1,2]；价格 4 位定点；带 30s 缓存 + 陈旧兜底。"""
    import time as _t
    cache = getattr(get_index_trend, "_c", None)
    now = _t.time()
    if cache and now - cache[0] < max_age:
        return cache[1]
    from kpl_socket import get_kpl_socket, pb_uint
    api = get_kpl_socket()
    body = pb_uint(1, 0) + pb_uint(1, 1) + pb_uint(1, 2)
    resp = api._session_rpc(3003, body, timeout_s=15)
    out: Dict[str, Any] = {"indexes": [], "ts": int(now)}
    if resp:
        parsed = parse_index_trends(resp) or []
        out["indexes"] = [{"num": n, **p} for n, p in zip(INDEX_NAMES, parsed)]
    else:
        if cache:                       # 拉取失败兜底旧值
            old = dict(cache[1])
            old["stale"] = True
            return old
        out["stale"] = False
    get_index_trend._c = (now, out)
    return out


class MarketFeed:
    """订阅 2100-2126 家族 + 周期保活。snapshot() 返回全部 cmd 的语义化最新数据。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._snap: Dict[str, Any] = {}
        self._snap_ts = 0.0
        self._snap_lock = threading.Lock()
        self._ka_started = False

    def _api(self):
        from kpl_socket import get_kpl_socket
        return get_kpl_socket()

    def ensure_subscribed(self, connect: bool = True):
        api = self._api()
        api.subscribe(SUB_CMDS)          # 登记 desired_subs（重连自动重发）
        if not api.session_alive():
            if not connect:
                return False
            api.ensure_session(timeout_s=90)
        s = api._session
        if s and s.alive:
            s.send_subscriptions(SUB_CMDS)
            # 带参订阅单独发：send_subscriptions 只发 pb.Empty
            for cmd, body_fn in ((ZT_LIST_CMD, _zt_list_body),
                                 (3004, _stock_rank_body), (3007, _plate_rank_body)):
                if cmd not in s.sub_cmds:
                    try:
                        from kpl_socket import build_frame
                        with s._send_lock:
                            s.sock.sendall(build_frame(cmd, body_fn(),
                                                       kind=4, seq=s._next_seq()))
                        s.sub_cmds.add(cmd)
                    except Exception as e:
                        logger.debug(f"订阅 {cmd}: {e}")
        if not self._ka_started:
            self._ka_started = True
            threading.Thread(target=self._keepalive_loop, daemon=True,
                             name="kpl-feed-ka").start()
        return bool(s and s.alive)

    def _keepalive_loop(self):
        """每 25s 检查各订阅 cmd 数据龄：会话活但数据缺失/过期 → 重发订阅帧。
        会话重连后 _session_rpc 会自动重发 desired_subs；本线程兜底推送停滞。"""
        from kpl_socket import build_frame
        while True:
            time.sleep(25)
            try:
                api = self._api()
                s = api._session
                if not (s and s.alive):
                    continue
                now = time.time()
                ages = s.sub_latest
                stale_cmds = [c for c in SUB_CMDS
                              if c not in ages or now - ages[c]["ts"] > MAX_PUSH_AGE]
                # 带参订阅（盘中有推送；盘后静默时不强求）也纳入重发
                for cmd, body_fn in ((ZT_LIST_CMD, _zt_list_body),
                                     (3004, _stock_rank_body), (3007, _plate_rank_body)):
                    if s.alive and cmd in s.sub_cmds and (
                            cmd not in ages or now - ages[cmd]["ts"] > MAX_PUSH_AGE * 6):
                        stale_cmds.append((cmd, body_fn()))
                if stale_cmds:
                    try:
                        with s._send_lock:
                            for c in stale_cmds:
                                if isinstance(c, tuple):
                                    s.sock.sendall(build_frame(c[0], c[1], kind=4,
                                                               seq=s._next_seq()))
                                else:
                                    s.sock.sendall(build_frame(c, b"", kind=4,
                                                               seq=s._next_seq()))
                        logger.debug(f"marketfeed 重发订阅: {[c if not isinstance(c, tuple) else c[0] for c in stale_cmds]}")
                    except Exception as e:
                        logger.debug(f"重发订阅失败: {e}")
            except Exception as e:
                logger.debug(f"feed keepalive: {e}")

    def snapshot(self, force: bool = False, wait_s: float = 0) -> Dict[str, Any]:
        """全部订阅 cmd 的语义化快照（20s 缓存）。返回 {name: {data, ts, stale, source}}"""
        with self._snap_lock:
            if not force and self._snap and time.time() - self._snap_ts < SNAP_FRESH_S:
                return self._snap
        alive = self.ensure_subscribed()
        if wait_s > 0:
            time.sleep(wait_s)       # 显式等待：等服务端首轮推送
        result: Dict[str, Any] = {}
        api = self._api()
        s = api._session
        names = {2100: "dabanhead", 2101: "radar", 2106: "energy", 2107: "ztsitu",
                 2108: "weights", 2109: "north", 2110: "zdstat", 2111: "zdtip",
                 2114: "zddist", 2115: "overview", 2116: "ztseries", 2117: "ladder",
                 2126: "windvane", ZT_LIST_CMD: "ztlist",
                 3004: "stockrank", 3007: "platerank"}
        now = time.time()
        # 首次订阅/会话新建后推送尚未落库：覆盖不足一半时等 4s 再读一轮
        got = sum(1 for c in names if s and c in s.sub_latest)
        if got < len(names) // 2 and alive:
            time.sleep(4)
        for cmd, name in names.items():
            hit = s.sub_latest.get(cmd) if s else None
            if not hit:
                result[name] = {"data": None, "ts": None, "stale": False,
                                "source": "push", "waiting": True}
                continue
            parts = hit.get("parts") or [hit.get("body") or b""]
            parsed = parse_cmd(cmd, parts)
            result[name] = {"data": parsed, "ts": int(hit["ts"]),
                            "stale": (now - hit["ts"]) > MAX_PUSH_AGE,
                            "source": "push", "waiting": False}
        result["_meta"] = {"alive": bool(alive), "ages": api.push_ages(),
                           "day": time.strftime("%Y-%m-%d")}
        with self._snap_lock:
            self._snap = result
            self._snap_ts = time.time()
        return result


_feed: Optional[MarketFeed] = None
_feed_lock = threading.Lock()


def get_feed() -> MarketFeed:
    global _feed
    with _feed_lock:
        if _feed is None:
            _feed = MarketFeed()
        return _feed
