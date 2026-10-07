"""
通达信 PC 客户端自选分组直读（T0002/blocknew 目录）

用户实际操盘在通达信手机 App，分组经「云同步」落到 PC 客户端的 blocknew
文件；插件直读这些文件 = PC 最后一次云同步的状态（目录内最新 blk mtime
即同步时间口径，前端展示"同步于"提示）。

格式（2026-10-05 本机 D:\\app\\tdx 实测，observed）：
- *.blk：纯文本行，每行 7 字符 = 市场号 + 6 位代码 + CRLF
  （'0'=深 '1'=沪 '2'=北交）。旧版本可能为 7 字节二进制记录（市场号为
  原始字节），零命中时按二进制兜底解析
- blocknew.cfg：分组索引。实测记录**非严格 120B 定长**（"条件预警"组名
  出现在 592 而非 600 边界），故按 GBK 解码后以 \\0 分段提取 token，按
  「含中文的组名 + 相邻 ASCII 短文件名」配对（实测 6 组全部正确解析）
- zxg.blk = 默认「自选股」组（不在 cfg 索引内，固定置顶）
- 目录内存在 cfg 未收录的 .blk（云同步板块产物）：按文件短名补充展示

只读模块，不写任何通达信文件；实时行情为可选附加（pytdx，仅沪深市场码）。
"""

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from loguru import logger

from config import config
from tdx_local import CANDIDATE_DIRS

MARKET_NAMES = {0: "SZ", 1: "SH", 2: "BJ"}

_BLK_LINE_RE = re.compile(r"^([0-2])(\d{6})$")
_CFG_HAS_CJK = re.compile(r"[\u4e00-\u9fa5]")
_CFG_SHORT_RE = re.compile(r"^[A-Za-z0-9_]{1,16}$")

_cache_lock = threading.Lock()
_cache: Dict[str, Any] = {"sig": None, "data": None}

_packaged_tbl: Optional[Dict[str, str]] = None


# ============= 目录定位 =============

def resolve_blocknew_dir(install_dir: Optional[str] = None) -> Optional[Path]:
    """定位 blocknew 目录：接受安装根目录 / T0002 / blocknew 本身；未配置时探测常见位置"""
    candidates: List[Path] = []
    if install_dir:
        p = Path(install_dir)
        candidates += [p / "T0002" / "blocknew", p / "blocknew", p]
    for c in CANDIDATE_DIRS:
        candidates.append(Path(c) / "T0002" / "blocknew")
    for p in candidates:
        try:
            if p.is_dir() and any(p.glob("*.blk")):
                return p
        except OSError:
            continue
    return None


# ============= 名称兜底 =============

def _packaged_names() -> Dict[str, str]:
    """随包打包的全市场 {code: name} 静态表（与 kpl.py 同一份文件，惰性加载一次）"""
    global _packaged_tbl
    if _packaged_tbl is None:
        try:
            pth = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "static", "kpl_stock_names.json")
            with open(pth, encoding="utf-8") as f:
                _packaged_tbl = json.load(f)
        except Exception:
            _packaged_tbl = {}
    return _packaged_tbl


def _stock_name(code: str) -> str:
    nm = _packaged_names().get(code, "")
    if nm:
        return nm
    try:
        from screener import market_pool
        return market_pool.get_name(code) or ""
    except Exception:
        return ""


# ============= 文件解析 =============

def parse_blk(path: Path) -> List[Tuple[int, str]]:
    """解析分组成分文件 → [(market, code)]；文本行格式为主，7 字节二进制记录兜底"""
    try:
        raw = path.read_bytes()
    except OSError:
        return []
    out: List[Tuple[int, str]] = []
    for line in raw.decode("ascii", errors="ignore").splitlines():
        m = _BLK_LINE_RE.match(line.strip())
        if m:
            out.append((int(m.group(1)), m.group(2)))
    if not out and raw and len(raw) % 7 == 0:
        for i in range(0, len(raw), 7):
            rec = raw[i:i + 7]
            code = rec[1:7].decode("ascii", errors="ignore")
            if rec[0] in (0, 1, 2) and code.isdigit():
                out.append((rec[0], code))
    seen = set()
    dedup: List[Tuple[int, str]] = []
    for pair in out:
        if pair not in seen:
            seen.add(pair)
            dedup.append(pair)
    return dedup


def parse_cfg(path: Path) -> List[Dict[str, str]]:
    """blocknew.cfg → [{name, short}]

    主路径：严格 120B 定长记录（2026-10-07 实锤：云同步新版 1560B=13 条、
    旧版 720B=6 条，均为 120 整数倍；布局 [0..49]=中文名GBK [50..99]=ASCII短码
    其余 \0。旧笔记"非定长/592 边界"是 od 行偏移误读，已纠正）。
    兜底：长度非 120 整数倍时退回 GBK \\0 分词配对法（兼容其它历史版本）。
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return []
    if raw and len(raw) % 120 == 0:
        groups: List[Dict[str, str]] = []
        for i in range(0, len(raw), 120):
            rec = raw[i:i + 120]
            cn = rec[0:50].split(b"\x00")[0].strip()
            sn = rec[50:100].split(b"\x00")[0].strip()
            if not sn:
                continue
            name = cn.decode("gbk", errors="replace").strip() or sn.decode("ascii", errors="replace")
            groups.append({"name": name, "short": sn.decode("ascii", errors="replace")})
        return groups
    text = raw.decode("gbk", errors="ignore")
    tokens = [t.strip() for t in text.split("\x00") if t.strip()]
    groups = []
    i = 0
    while i < len(tokens):
        if (_CFG_HAS_CJK.search(tokens[i]) and i + 1 < len(tokens)
                and _CFG_SHORT_RE.match(tokens[i + 1])):
            groups.append({"name": tokens[i], "short": tokens[i + 1]})
            i += 2
        else:
            i += 1
    return groups


# ============= 分组别名（外部导入板块无中文名，只能靠用户在插件里起名） =============
# 根因（2026-10-07 定案）：2025 年各批次 .blk 是外部工具批量导入的板块，从未在
# blocknew.cfg 注册中文名，通达信客户端本身也只显示短码；云同步 cfg 又只含
# 云端跟踪的 13+1 个板块。磁盘上不存在这些组的原名 → 本地别名层是唯一正解。

_ALIAS_SEED = {
    # gs_bak/20261007_blocknew.cfg 旧索引实锤的历史名（云同步后 cfg 换版丢失）
    "QXLT": "情绪龙头",
    "ZLT": "准龙头",
}


def aliases_file() -> Path:
    from storage import resolve_data_dir
    return resolve_data_dir() / "tdx_group_aliases.json"


def load_aliases() -> Dict[str, str]:
    """别名表：{组短名: 显示名}；首次调用用历史实锼名播种"""
    p = aliases_file()
    if not p.exists():
        try:
            save_aliases(dict(_ALIAS_SEED))
        except Exception:
            return dict(_ALIAS_SEED)
        return dict(_ALIAS_SEED)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except Exception:
        return dict(_ALIAS_SEED)


def save_aliases(aliases: Dict[str, str]) -> None:
    p = aliases_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(aliases, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def set_alias(gid: str, name: str) -> Dict[str, str]:
    """设置/清除（name 空串=清除）一个别名，返回最新全表"""
    aliases = load_aliases()
    gid = (gid or "").strip()
    name = (name or "").strip()
    if not gid:
        raise ValueError("gid required")
    if name:
        aliases[gid] = name
    else:
        aliases.pop(gid, None)
    save_aliases(aliases)
    return aliases


# ============= 聚合 =============

def _dir_signature(d: Path) -> Tuple:
    """目录指纹（blk/cfg 文件名+mtime+size），文件未变不重解析"""
    try:
        sig = []
        for f in sorted(d.iterdir()):
            if f.is_file() and f.suffix.lower() in (".blk", ".cfg"):
                st = f.stat()
                sig.append((f.name, st.st_mtime_ns, st.st_size))
        return tuple(sig)
    except OSError:
        return ()


def _parse_all(d: Path) -> Dict[str, Any]:
    cfg_groups = parse_cfg(d / "blocknew.cfg") if (d / "blocknew.cfg").exists() else []
    groups: List[Dict[str, Any]] = []
    stocks: Dict[str, List[Dict[str, Any]]] = {}
    latest_mtime = 0.0

    def add_group(gid: str, name: str, f: Optional[Path], members: List[Tuple[int, str]]) -> None:
        groups.append({"id": gid, "name": name, "count": len(members)})
        stocks[gid] = [
            {"code": cd, "market": mk, "market_label": MARKET_NAMES.get(mk, str(mk)),
             "name": _stock_name(cd)}
            for mk, cd in members
        ]
        if f is not None:
            nonlocal latest_mtime
            try:
                latest_mtime = max(latest_mtime, f.stat().st_mtime)
            except OSError:
                pass

    used = set()
    zxg = d / "zxg.blk"
    if zxg.exists():
        members = parse_blk(zxg)
        if members:
            add_group("zxg", "自选股", zxg, members)
            used.add("zxg")
    for g in cfg_groups:
        sid = g["short"]
        if sid in used:
            continue
        used.add(sid)
        f = d / (sid + ".blk")
        members = parse_blk(f) if f.exists() else []
        if members:
            add_group(sid, g["name"], f, members)
    for f in sorted(d.glob("*.blk")):
        sid = f.stem
        if sid in used:
            continue
        members = parse_blk(f)
        if members:
            used.add(sid)
            add_group(sid, sid, f, members)
    return {"groups": groups, "stocks": stocks, "latest_mtime": latest_mtime}


# ============= 行情附加（性能关键：这里曾是端点慢的唯一大头） =============
# 旧实现每次请求对全部组 ~1700 只重拉 pytdx（28 个分块），盘后撞僵尸服务器
# 扫描时单请求 10-50s。现架构：条目级缓存 20s + 只拉当前显示组 + 后台单飞
# 刷新（请求恒快）+ 磁盘缓存秒显（重启/冷启动有上一 session 的收盘价）。

_QUOTES_FRESH = 20.0        # 条目新鲜期（秒），过期由后台刷新
_QUOTES_BUDGET = 8.0        # 单轮后台刷新的时间预算（秒），防 pytdx 僵尸扫描无限烧
_QUOTES_DISK_SAVE = 300.0   # 磁盘落盘防抖（秒，高频写盘触发杀软扫描的老坑）

_quotes_cache: Dict[str, Dict[str, Any]] = {}   # code -> {price, change_pct, ts}
_quotes_lock = threading.Lock()
_quotes_fetching = False
_quotes_disk_loaded = False
_quotes_last_save = 0.0


def _quotes_disk_path() -> Path:
    from storage import resolve_data_dir
    return resolve_data_dir() / "kpl_tdx_quotes_cache.json"


def _quotes_load_disk() -> None:
    """磁盘缓存只做秒显兜底：条目 ts=0（视为过期，首次后台刷新即替换）"""
    global _quotes_disk_loaded, _quotes_last_save
    _quotes_disk_loaded = True
    try:
        raw = json.loads(_quotes_disk_path().read_text(encoding="utf-8"))
        now = time.time()
        n = 0
        for cd, v in (raw.get("quotes") or {}).items():
            if isinstance(v, dict) and "price" in v:
                _quotes_cache[str(cd)] = {"price": v.get("price"), "change_pct": v.get("change_pct"), "ts": 0}
                n += 1
        _quotes_last_save = now
        logger.info(f"tdx_watch 行情磁盘缓存载入 {n} 条")
    except Exception:
        pass


def _quotes_save_disk() -> None:
    global _quotes_last_save
    try:
        p = _quotes_disk_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"quotes": _quotes_cache}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)
        _quotes_last_save = time.time()
    except Exception as e:
        logger.debug(f"tdx_watch 行情磁盘缓存写盘失败: {e}")


def _apply_quotes(result: Dict[str, Any], gids: List[str], only_gid: Optional[str],
                  need: List[Tuple[int, str]]) -> None:
    """缓存行情回填到全部组（换组立即有显示，价格允许 ≤20s 旧）；
    过期/缺失清单只对 only_gid（当前显示组）收集，后台只刷新看得见的组"""
    now = time.time()
    for gid in gids:
        for s in result["stocks"].get(gid, []):
            e = _quotes_cache.get(s["code"])
            if e is not None:
                s["price"] = e.get("price")
                s["change_pct"] = e.get("change_pct")
            if only_gid and gid != only_gid:
                continue
            if s["market"] in (0, 1) and (e is None or now - e.get("ts", 0) >= _QUOTES_FRESH):
                need.append((s["market"], s["code"]))


def _quotes_bg_fetch(need: List[Tuple[int, str]]) -> None:
    """后台单飞：分块拉取过期/缺失行情 + 到期落盘。
    双源：腾讯批量（qt.gtimg，0.2s/块、盘后稳定）优先，空/失败回退 pytdx；
    双源都不通才停（别把预算烧在 pytdx 僵尸服务器扫描上）。"""
    global _quotes_fetching
    from data_source import data_source
    from tencent import get_realtime_quotes as _tx_quotes
    try:
        t0 = time.time()
        got_any = False
        for i in range(0, len(need), 60):
            if time.time() - t0 > _QUOTES_BUDGET:
                break
            chunk = need[i:i + 60]
            got: Dict[str, Dict[str, Any]] = {}
            try:
                for q in _tx_quotes(chunk):
                    if q.get("code"):
                        got[q["code"]] = q
            except Exception as e:
                logger.debug(f"tdx_watch 腾讯批量行情失败: {e}")
            if not got:
                try:
                    for q in data_source.get_security_quotes(chunk):
                        if q.get("code") and q.get("price") is not None:
                            got[q["code"]] = q
                except Exception as e:
                    logger.debug(f"tdx_watch pytdx 批量行情失败: {e}")
            if not got:
                break
            got_any = True
            now = time.time()
            for cd, q in got.items():
                _quotes_cache[cd] = {"price": q.get("price"), "change_pct": q.get("change_pct"), "ts": now}
        with _quotes_lock:
            save_due = got_any and time.time() - _quotes_last_save > _QUOTES_DISK_SAVE
        if save_due:
            with _quotes_lock:
                if time.time() - _quotes_last_save > _QUOTES_DISK_SAVE:
                    _quotes_save_disk()
    finally:
        with _quotes_lock:
            _quotes_fetching = False


def _attach_quotes(result: Dict[str, Any], gids: List[str],
                   only_gid: Optional[str] = None) -> None:
    """给分组填 price/change_pct。恒快：先用缓存（含磁盘兜底）回填立即返回，
    过期条目交后台单飞线程刷新（请求不等 pytdx）。only_gid=只刷新当前显示组。
    北交（market=2）无 pytdx 行情，保持空。"""
    global _quotes_fetching
    with _quotes_lock:
        if not _quotes_disk_loaded and not _quotes_cache:
            _quotes_load_disk()
    need: List[Tuple[int, str]] = []
    with _quotes_lock:
        _apply_quotes(result, gids, only_gid, need)
    if not need:
        return
    with _quotes_lock:
        if _quotes_fetching:
            return  # 上一轮还在拉：本轮先返回缓存值，下轮轮询收新
        _quotes_fetching = True
    threading.Thread(target=_quotes_bg_fetch, args=(need,), daemon=True).start()


# ============= 对外入口 =============

def get_watchlist(install_dir: Optional[str] = None, group: Optional[str] = None,
                  with_quotes: bool = False, quotes_group: Optional[str] = None) -> Dict[str, Any]:
    """自选分组全量：{available, dir, synced_at, groups:[{id,name,count}], stocks:{gid:[...]}}

    quotes_group：只对该组做行情刷新（前端传当前显示组，未传=全部——全量仅首屏兜底）。
    行情走条目缓存+后台刷新，本函数任何路径都不阻塞在 pytdx 上。
    """
    d = resolve_blocknew_dir(install_dir or config.tdx_install_dir)
    if not d:
        return {"available": False,
                "message": "未找到通达信 blocknew 目录（请在系统 Tab 配置「通达信安装目录」）",
                "groups": [], "stocks": {}}

    sig = (str(d), _dir_signature(d))
    with _cache_lock:
        if _cache["sig"] == sig and _cache["data"] is not None:
            parsed = _cache["data"]
        else:
            parsed = _parse_all(d)
            _cache["sig"] = sig
            _cache["data"] = parsed

    wanted = [dict(g) for g in parsed["groups"] if not group or g["id"] == group]
    aliases = load_aliases()
    for g in wanted:
        g["alias"] = aliases.get(g["id"], "")
        if g["alias"]:
            g["name"] = g["alias"]
    result: Dict[str, Any] = {
        "available": True,
        "dir": str(d),
        "synced_at": time.strftime("%Y-%m-%d %H:%M", time.localtime(parsed["latest_mtime"]))
        if parsed["latest_mtime"] else "",
        "groups": wanted,
        "stocks": {g["id"]: list(parsed["stocks"].get(g["id"], [])) for g in wanted},
    }
    if with_quotes:
        _attach_quotes(result, [g["id"] for g in wanted], quotes_group or None)
    return result
