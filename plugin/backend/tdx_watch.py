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
    """blocknew.cfg → [{name, short}]；GBK \\0 分词配对法（适配实测的非定长记录）"""
    try:
        raw = path.read_bytes()
    except OSError:
        return []
    text = raw.decode("gbk", errors="ignore")
    tokens = [t.strip() for t in text.split("\x00") if t.strip()]
    groups: List[Dict[str, str]] = []
    i = 0
    while i < len(tokens):
        if (_CFG_HAS_CJK.search(tokens[i]) and i + 1 < len(tokens)
                and _CFG_SHORT_RE.match(tokens[i + 1])):
            groups.append({"name": tokens[i], "short": tokens[i + 1]})
            i += 2
        else:
            i += 1
    return groups


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


# ============= 行情附加 =============

def _attach_quotes(result: Dict[str, Any], gids: List[str]) -> None:
    """给已选分组填 price/change_pct（pytdx 单次上限内分块；北交市场码不支持，保持空）"""
    from data_source import data_source
    pairs: List[Tuple[int, str]] = []
    seen = set()
    for gid in gids:
        for s in result["stocks"].get(gid, []):
            if s["market"] in (0, 1) and s["code"] not in seen:
                seen.add(s["code"])
                pairs.append((s["market"], s["code"]))
    quotes: Dict[str, Dict[str, Any]] = {}
    for i in range(0, len(pairs), 60):
        try:
            for q in data_source.get_security_quotes(pairs[i:i + 60]):
                if q.get("code"):
                    quotes[q["code"]] = q
        except Exception as e:
            logger.debug(f"tdx_watch 批量行情失败: {e}")
    for gid in gids:
        for s in result["stocks"].get(gid, []):
            q = quotes.get(s["code"])
            if q:
                s["price"] = q.get("price") or None
                s["change_pct"] = q.get("change_pct")


# ============= 对外入口 =============

def get_watchlist(install_dir: Optional[str] = None, group: Optional[str] = None,
                  with_quotes: bool = False) -> Dict[str, Any]:
    """自选分组全量：{available, dir, synced_at, groups:[{id,name,count}], stocks:{gid:[...]}}"""
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

    wanted = [g for g in parsed["groups"] if not group or g["id"] == group]
    result: Dict[str, Any] = {
        "available": True,
        "dir": str(d),
        "synced_at": time.strftime("%Y-%m-%d %H:%M", time.localtime(parsed["latest_mtime"]))
        if parsed["latest_mtime"] else "",
        "groups": wanted,
        "stocks": {g["id"]: list(parsed["stocks"].get(g["id"], [])) for g in wanted},
    }
    if with_quotes:
        _attach_quotes(result, [g["id"] for g in wanted])
    return result
