# -*- coding: utf-8 -*-
"""
权威交易日历（A 股）—— 深交所官方月历 API 为主源

数据源: https://www.szse.cn/api/report/exchange/onepersistenthour/monthList?month=YYYY-MM
       （交易所官方发布，jybz=1 交易日 / 0 休市——法定节假日、调休全部由交易所口径保证，
        插件不做任何自己的节假日推断）
缓存:   {data_dir}/trade_calendar.json 按月落盘（日历数据不变，7 天过期重拉；
        过期后网络失败仍用旧缓存——日历回退极少变化）
兜底:   无任何缓存时退化为周末规则（周末=非交易日，工作日=交易日），
        并在结果里带 source="weekend-fallback" 供调用方感知。

用法:
    from trade_calendar import get_cal
    cal = get_cal()
    cal.is_trading_day("2026-10-01")   # False（国庆）
    cal.is_trading_now()               # 交易日 + A股时段(9:15-11:30/13:00-15:00)
    cal.next_trading_day("2026-09-30") # "2026-10-08"
"""

import json
import threading
import time
import urllib.request
from datetime import date as _date, datetime, timedelta
from typing import Any, Dict, Optional

from loguru import logger

SZSE_URL = ("https://www.szse.cn/api/report/exchange/onepersistenthour/"
            "monthList?month={month}&random={rand}")
CACHE_NAME = "trade_calendar.json"
CACHE_TTL = 7 * 86400          # 月历重拉周期
MEM_TTL = 300                  # 内存缓存

# A 股交易时段（分钟数，与既有 keepalive/poprank 口径一致）
MORNING = (9 * 60 + 15, 11 * 60 + 30)
AFTERNOON = (13 * 60, 15 * 60)


def _fetch_month(month: str, timeout: float = 8) -> Optional[Dict[str, int]]:
    """拉深交所某月月历 → {"2026-10-01": 0, "2026-10-08": 1}"""
    url = SZSE_URL.format(month=month, rand=str(time.time()))
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://www.szse.cn/",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf8"))
        out: Dict[str, int] = {}
        for row in d.get("data") or []:
            day, bz = row.get("jyrq"), row.get("jybz")
            if day and bz is not None:
                out[str(day)] = 1 if str(bz) == "1" else 0
        return out or None
    except Exception as e:
        logger.debug(f"交易日历拉取 {month}: {e}")
        return None


class TradeCalendar:
    def __init__(self, data_dir):
        self._data_dir = data_dir
        self._lock = threading.Lock()
        self._months: Dict[str, Dict[str, int]] = {}
        self._fetched: Dict[str, float] = {}     # month → 拉取时刻
        self._disk_loaded = False
        self._prewarmed = False

    # ---------- 存储 ----------

    def _disk_path(self):
        return self._data_dir / CACHE_NAME

    def _load_disk(self) -> None:
        if self._disk_loaded:
            return
        self._disk_loaded = True
        try:
            sn = json.loads(self._disk_path().read_text(encoding="utf-8"))
            self._months = {str(k): dict(v) for k, v in (sn.get("months") or {}).items()}
            self._fetched = {str(k): float(v) for k, v in (sn.get("fetched") or {}).items()}
        except Exception:
            pass

    def _save_disk(self) -> None:
        try:
            tmp = self._disk_path().with_suffix(".tmp")
            tmp.write_text(json.dumps({"months": self._months, "fetched": self._fetched},
                                      ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._disk_path())
        except Exception as e:
            logger.debug(f"交易日历落盘: {e}")

    def _ensure_month(self, month: str, max_age: float = CACHE_TTL) -> bool:
        """确保某月数据在内存（先磁盘后网络）。返回该月是否有数据"""
        with self._lock:
            self._load_disk()
            hit = self._months.get(month)
            if hit and time.time() - self._fetched.get(month, 0) < max_age:
                return True
            got = _fetch_month(month)
            if got:
                self._months[month] = got
                self._fetched[month] = time.time()
                self._save_disk()
                return True
            return bool(hit)

    def prewarm(self) -> None:
        """预热本月±1 月（启动线程调用）。"""
        if self._prewarmed:
            return
        self._prewarmed = True
        today = _date.today()
        for delta in (-1, 0, 1):
            d = today.replace(day=1) + timedelta(days=32 * delta)
            self._ensure_month(d.strftime("%Y-%m"))

    # ---------- 查询 ----------

    @staticmethod
    def _norm(d) -> _date:
        if isinstance(d, _date):
            return d
        return datetime.strptime(str(d)[:10], "%Y-%m-%d").date()

    def is_trading_day(self, d) -> bool:
        """是否交易日。官方数据缺失时：周末=非交易日，工作日暂按交易日（fallback）"""
        dt = self._norm(d)
        month = dt.strftime("%Y-%m")
        with self._lock:
            self._load_disk()
            hit = self._months.get(month)
        if hit and dt.strftime("%Y-%m-%d") in hit:
            return hit[dt.strftime("%Y-%m-%d")] == 1
        # 无官方数据：后台补拉一次（同步、短超时），仍无则周末规则
        self._ensure_month(month, max_age=0)
        with self._lock:
            hit = self._months.get(month)
        if hit and dt.strftime("%Y-%m-%d") in hit:
            return hit[dt.strftime("%Y-%m-%d")] == 1
        return dt.weekday() < 5

    def is_trading_now(self, now: Optional[datetime] = None) -> bool:
        """当前时刻是否在 A 股交易时段（交易日 + 9:15-11:30 / 13:00-15:00）"""
        n = now or datetime.now()
        if not self.is_trading_day(n.date()):
            return False
        m = n.hour * 60 + n.minute
        return MORNING[0] <= m <= MORNING[1] or AFTERNOON[0] <= m <= AFTERNOON[1]

    def _step(self, d: _date, days: int) -> Optional[_date]:
        """从 d 起（不含 d）向前/向后找最近交易日；最多找 40 天"""
        for i in range(1, 40):
            dt = d + timedelta(days=days * i)
            # 未有数据月份直接试探（is_trading_day 内部会拉月）
            if self.is_trading_day(dt):
                return dt
        return None

    def next_trading_day(self, d) -> Optional[str]:
        dt = self._step(self._norm(d), +1)
        return dt.strftime("%Y-%m-%d") if dt else None

    def prev_trading_day(self, d) -> Optional[str]:
        dt = self._step(self._norm(d), -1)
        return dt.strftime("%Y-%m-%d") if dt else None

    def today(self) -> Dict[str, Any]:
        """今日状态摘要（供端点/前端使用）"""
        n = datetime.now()
        return {
            "today": n.strftime("%Y-%m-%d"),
            "is_trading_day": self.is_trading_day(n.date()),
            "in_trading_hours": self.is_trading_now(n),
            "prev_trading_day": self.prev_trading_day(n.date()),
            "next_trading_day": self.next_trading_day(n.date()),
            "source": "szse-official",
        }


_cal: Optional[TradeCalendar] = None
_cal_lock = threading.Lock()


def get_cal() -> TradeCalendar:
    global _cal
    with _cal_lock:
        if _cal is None:
            from storage import storage
            _cal = TradeCalendar(storage.data_dir)
        return _cal
