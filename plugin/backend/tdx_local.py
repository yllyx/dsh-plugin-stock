"""
通达信客户端本地数据读取（vipdoc 目录）

文件格式（社区公开格式，日线已实测校准）：
- .day 日线（32字节/根）：uint32日期YYYYMMDD, 开高低收×100(uint32×4),
  成交额float32, 成交量uint32(手), 保留uint32 —— 已用真实文件验证
- .lc1 一分钟 / .lc5 五分钟（32字节/根）：uint16日期(自2000-01-01天数),
  uint16时间HHMM, 开高低收×100, 成交额, 成交量 —— best-effort，
  待客户端下载分钟数据后校准（本机当前无样本文件）

数据特点：全市场、历史深、零网络；缺点是静态快照，
仅当通达信客户端运行并下载盘后数据时更新。
"""

import struct
import time
from datetime import date as _date, timedelta
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

from loguru import logger

# 常见通达信安装位置（未配置时自动探测）
CANDIDATE_DIRS = [
    r"C:\new_tdx", r"D:\new_tdx", r"E:\new_tdx",
    r"C:\tdx", r"D:\tdx", r"E:\tdx",
    r"D:\app\tdx", r"C:\Program Files\new_tdx",
]

SH_PREFIXES = ("60", "68")   # 沪A：主板/科创板
SZ_PREFIXES = ("00", "30")   # 深A：主板/创业板


# ============= 目录解析 =============

def resolve_vipdoc_dir(install_dir: Optional[str] = None) -> Optional[Path]:
    """
    解析 vipdoc 目录：接受安装根目录或 vipdoc 目录本身；未配置时自动探测。
    """
    candidates: List[Path] = []
    if install_dir:
        p = Path(install_dir)
        candidates += [p / "vipdoc", p]
    for c in CANDIDATE_DIRS:
        candidates.append(Path(c) / "vipdoc")

    for p in candidates:
        try:
            if (p / "sh" / "lday").is_dir() and (p / "sz" / "lday").is_dir():
                return p
        except OSError:
            continue
    return None


def find_tdx_exe(install_dir: Optional[str] = None) -> Optional[Path]:
    """定位通达信主程序 tdxw.exe"""
    roots: List[Path] = []
    if install_dir:
        roots.append(Path(install_dir))
    vipdoc = resolve_vipdoc_dir(install_dir)
    if vipdoc:
        roots.append(vipdoc.parent)
    for root in roots:
        exe = root / "tdxw.exe"
        if exe.exists():
            return exe
    return None


# ============= 文件解析 =============

def read_day_file(path: Path) -> List[Dict]:
    """解析日线 .day（升序）"""
    bars: List[Dict] = []
    try:
        data = path.read_bytes()
        if len(data) < 32 or len(data) % 32 != 0:
            return []
        for i in range(0, len(data), 32):
            rec = data[i:i + 32]
            d, o, h, l, c = struct.unpack("<IIIII", rec[:20])
            amount, vol = struct.unpack("<fI", rec[20:28])
            if d < 19900101:
                continue
            bars.append({
                "datetime": f"{d//10000:04d}-{d//100%100:02d}-{d%100:02d}",
                "open": o / 100, "high": h / 100,
                "low": l / 100, "close": c / 100,
                "volume": vol, "amount": amount,
            })
    except Exception as e:
        logger.debug(f"解析 {path.name} 失败: {e}")
    return bars


def read_minute_file(path: Path) -> List[Dict]:
    """
    解析分钟线 .lc1/.lc5（best-effort，格式待样本校准）
    返回空列表表示解析不成功（调用方回退网络源）。
    """
    bars: List[Dict] = []
    try:
        data = path.read_bytes()
        if len(data) < 32 or len(data) % 32 != 0:
            return []
        epoch2000 = _date(2000, 1, 1).toordinal()
        for i in range(0, len(data), 32):
            rec = data[i:i + 32]
            d16, t16 = struct.unpack("<HH", rec[:4])
            o, h, l, c = struct.unpack("<IIII", rec[4:20])
            amount, vol = struct.unpack("<fI", rec[20:28])
            # 日期编码两种候选：自2000-01-01的天数 / 自1970的天数，取落在合理区间的
            for base, tag in ((epoch2000, "2000"), (_date(1970, 1, 1).toordinal(), "1970")):
                try:
                    dt = _date.fromordinal(base + d16)
                    if 2010 <= dt.year <= 2035:
                        hh, mm = t16 // 100, t16 % 100
                        if 0 <= hh <= 23 and 0 <= mm <= 59:
                            bars.append({
                                "datetime": f"{dt.isoformat()} {hh:02d}:{mm:02d}",
                                "open": o / 100, "high": h / 100,
                                "low": l / 100, "close": c / 100,
                                "volume": vol, "amount": amount,
                            })
                        break
                except ValueError:
                    continue
    except Exception as e:
        logger.debug(f"解析 {path.name} 失败: {e}")
    return bars


# ============= 遍历 =============

def iter_local_daily(vipdoc: Path, min_bars: int = 30) -> Iterator[Tuple[str, int, List[Dict]]]:
    """遍历全部A股日线文件，产出 (code, market, bars)"""
    for market, side, prefixes in [(1, "sh", SH_PREFIXES), (0, "sz", SZ_PREFIXES)]:
        d = vipdoc / side / "lday"
        if not d.is_dir():
            continue
        for f in d.glob(f"{side}*.day"):
            code = f.stem[2:]
            if not (len(code) == 6 and code[:2] in prefixes):
                continue
            bars = read_day_file(f)
            if len(bars) >= min_bars:
                yield code, market, bars


def vipdoc_signature(vipdoc: Optional[Path]) -> Tuple[int, float]:
    """目录数据指纹（文件数 + 最新mtime），用于监测客户端是否写入了新数据"""
    if not vipdoc:
        return (0, 0.0)
    n = 0
    latest = 0.0
    try:
        for side in ("sh", "sz"):
            d = vipdoc / side / "lday"
            if not d.is_dir():
                continue
            for f in d.glob(f"{side}6*.day"):
                n += 1
                m = f.stat().st_mtime
                if m > latest:
                    latest = m
    except OSError:
        pass
    return (n, latest)


def local_status(install_dir: Optional[str]) -> Dict:
    """本地数据状态（系统Tab展示）"""
    vipdoc = resolve_vipdoc_dir(install_dir)
    if not vipdoc:
        return {"available": False, "message": "未找到通达信数据目录，请在配置中指定安装目录"}
    sh = sz = 0
    latest = ""
    try:
        sh = sum(1 for _ in (vipdoc / "sh" / "lday").glob("sh6*.day"))
        sz = sum(1 for _ in (vipdoc / "sz" / "lday").glob("sz0*.day"))
        sz += sum(1 for _ in (vipdoc / "sz" / "lday").glob("sz3*.day"))
        m = vipdoc / "sh" / "lday" / "sh600519.day"
        if m.exists():
            bars = read_day_file(m)
            if bars:
                latest = bars[-1]["datetime"]
    except Exception:
        pass
    today = time.strftime("%Y-%m-%d")
    min5 = sum(1 for _ in (vipdoc / "sh" / "fzline").glob("*.lc5")) if (vipdoc / "sh" / "fzline").is_dir() else 0
    min1 = sum(1 for _ in (vipdoc / "sh" / "minline").glob("*.lc1")) if (vipdoc / "sh" / "minline").is_dir() else 0
    return {
        "available": True,
        "dir": str(vipdoc),
        "sh_count": sh,
        "sz_count": sz,
        "latest_date": latest,
        "up_to_date": latest == today,
        "minute5_count": min5,
        "minute1_count": min1,
    }
