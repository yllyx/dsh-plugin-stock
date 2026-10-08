"""
开盘啦(KPL)数据源客户端 —— 纯HTTP接口（一期，全部实测验证）

统一入口: POST https://<域>/w1/api/index.php (ThinkPHP 风格 c=控制器&a=动作)
认证: 表单参数 UserID + Token（无签名头；Token来自App登录，约2个月长效，不绑设备）
限速: 全客户端任意两请求 >= 2.5s（KPL无签名但有过往封控先例，主动降速）
降级: 任何失败返回 None/[]，由调用方回退插件已有数据源

域名分工:
- applhb.longhuvip.com    用户/登录/自选/搜索/龙虎榜/评论
- apphwshhq.longhuvip.com 行情L2/板块/盯盘/情绪/全球指数/ETF
- apparticle.longhuvip.com 资讯/板块指数列表
- apphis.longhuvip.com     历史(情绪周期/热搜)

一期边界（Socket通道功能在二期）:
- 板块详情页的股票池列表(龙一/龙二/人气值)走Socket → 用东财成分股降级
- 板块强度排行总表走Socket → 用 GetIndexList 指数/板块列表 + SonPlate 降级
"""

import base64
import hashlib
import json
import os
import pathlib
import random
import re
import threading
import datetime
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from loguru import logger

from config import config
from storage import storage

# ============= 常量 =============

HOST_LHB = "https://applhb.longhuvip.com/w1/api/index.php"     # 用户/自选/搜索/登录
HOST_HQ = "https://apphwshhq.longhuvip.com/w1/api/index.php"   # 行情L2/板块
HOST_HQ2 = "https://apphwhq.longhuvip.com/w1/api/index.php"    # 指数行情
HOST_ART = "https://apparticle.longhuvip.com/w1/api/index.php" # 资讯/板块列表
HOST_HIS = "https://apphis.longhuvip.com/w1/api/index.php"     # 历史情绪
HOST_LHB_KPL = "https://applhb.kaipanla.com/w1/api/index.php"  # 龙虎榜（App ApiConfig.API_LHB，2026-09-30 实测）

MIN_INTERVAL = 2.5  # 秒，全局请求最小间隔

_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 11; sdk_gphone_x86 Build/RSB4.210609.001)",
}

# ============= 登录 RSA（逆向自 App: nv0 类，实现在 kpl_rsa_encrypt） =============

# APK assets/pub.key: RSA-2048 X.509 SPKI（Base64 内文）。App 登录/发码均用它加密，
# 与 assets/PublicKey+PrivateKey 不是同一对（后者用于解密服务端下发数据）。
_RSA_PUB_B64 = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyFNPWCzVAVxio7Gwir3B"
    "weI0aHuxBAu9e9HaoX+pnyyx9dK38iaDGRnkL0Ms5isF3nBCiZkzvix64CJ81woE"
    "W6PUHTd4w/xlsvtspca8WM++S/1YrFOpKst/FJVCvWZ7vwcxf530OZiwqchY/LHo"
    "cVzii7fwCV2i6ZIQH3uC7ksFHZanK+ah6nA6dUbEnUcHakMMsEKG/yZHPYsHu60W"
    "3SJy1i0mnjFDngAfejrWlv0qZjp57JFYcmh8I3a8maN/fis678rgkjAgZqF05bwL"
    "B2vb5eIS/WFFC9CQ8BWpbrZYlQ7IZ+8NvdX5DFSDel7t4/1dEXSd8zRP9ywkDhG4"
    "FwIDAQAB"
)

def _parse_spki_rsa_pub(b64_body: str):
    """解析 X.509 SPKI Base64 内文 → (n, e)（DER 最小解析，免依赖）"""
    def read_tlv(d, i):
        tag = d[i]; i += 1
        l = d[i]; i += 1
        if l & 0x80:
            nb = l & 0x7F
            l = int.from_bytes(d[i:i + nb], "big"); i += nb
        return tag, d[i:i + l], i + l

    der = base64.b64decode(b64_body)
    _, spki, _ = read_tlv(der, 0)          # SubjectPublicKeyInfo SEQUENCE
    _, _, i = read_tlv(spki, 0)            # AlgorithmIdentifier（跳过）
    _, bitstr, _ = read_tlv(spki, i)       # BIT STRING
    _, rsa_seq, _ = read_tlv(bitstr[1:], 0)  # 跳过 unused-bits 字节 → RSAPublicKey SEQUENCE
    _, mod_bytes, j = read_tlv(rsa_seq, 0)   # modulus INTEGER
    _, exp_bytes, _ = read_tlv(rsa_seq, j)   # exponent INTEGER
    return int.from_bytes(mod_bytes, "big"), int.from_bytes(exp_bytes, "big")


_RSA_N, _RSA_E = _parse_spki_rsa_pub(_RSA_PUB_B64)


def kpl_rsa_encrypt(text: str) -> str:
    """App 同款登录加密: PKCS#1 v1.5 加密 → Java Base64.encode(bytes,0)（76字符/行+换行）。
    纯 Python 实现（modexp），无需 cryptography 依赖。"""
    plain = text.encode("utf-8")
    k = (_RSA_N.bit_length() + 7) // 8  # 256
    if len(plain) > k - 11:
        raise ValueError("plaintext too long for RSA block")
    # PKCS#1 v1.5: 0x00 0x02 || PS(随机非零, >=8B) || 0x00 || msg
    ps_len = k - len(plain) - 3
    ps = bytearray()
    while len(ps) < ps_len:
        b = random.randbytes(ps_len - len(ps))
        ps.extend(x for x in b if x != 0)
    em = b"\x00\x02" + bytes(ps) + b"\x00" + plain
    c = pow(int.from_bytes(em, "big"), _RSA_E, _RSA_N)
    ct = c.to_bytes(k, "big")
    return base64.encodebytes(ct).decode("ascii")  # 76字符/行+尾部换行，与App抓包一致


def _kpl_check_code(device_id: str, phone: str) -> str:
    """发验证码防刷校验（逆向 d7.a: md5 小写hex）"""
    return hashlib.md5(f"{device_id}{phone}kaipanla".encode("utf-8")).hexdigest()


# ============= 客户端 =============

class KplClient:
    """开盘啦HTTP客户端（单例）：限速 + 登录态 + TTL缓存"""

    def __init__(self):
        self._client: Optional[httpx.Client] = None
        self._lock = threading.Lock()
        self._last_req_by_host: Dict[str, float] = {}
        self._cache: Dict[str, Dict[str, Any]] = {}   # key -> {"data":..., "ts":...}
        self._token_invalid = False
        self._info_cache: Optional[Dict[str, Any]] = None   # GetInfo 结果（后台验活写入）
        self._last_verify_ts: float = 0.0                    # 上次后台验活时间
        self._names_lock = threading.Lock()
        self._names_dirty = False
        # 名称持久缓存（复刻 App KPL_CACHE.STOCK 表机制：socket 响应只带 id 时
        # 用本地库补名，解析到新名字回写落盘；服务端对已同步设备可能下发增量响应）
        self._names: Dict[str, Dict[str, str]] = {"themes": {}, "stocks": {}}
        try:
            p = storage.data_dir / "kpl_names_cache.json"
            if p.exists():
                self._names.update(json.loads(p.read_text(encoding="utf-8")))
        except Exception as e:
            logger.debug(f"名称缓存加载失败(空表起): {e}")

    def _remember_name(self, kind: str, key: str, name: str) -> str:
        """登记名称并返回最终名称：新名字回写缓存（防抖落盘），缺失时用缓存补。"""
        key, name = str(key or ""), str(name or "")
        if not key:
            return name
        table = self._names[kind]
        if name:
            if table.get(key) != name:
                table[key] = name
                self._names_dirty = True
            return name
        return table.get(key, "")

    def _flush_names(self):
        """名称缓存落盘（同一数据目录，升级不丢）。名称变更后由调用方择机触发。"""
        if not self._names_dirty:
            return
        with self._names_lock:
            if not self._names_dirty:
                return
            try:
                p = storage.data_dir / "kpl_names_cache.json"
                tmp = p.with_suffix(".tmp")
                tmp.write_text(json.dumps(self._names, ensure_ascii=False), encoding="utf-8")
                tmp.replace(p)
                self._names_dirty = False
            except Exception as e:
                logger.debug(f"名称缓存落盘失败: {e}")

    # ---------- 基础 ----------

    def _get_client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                headers=_HEADERS, timeout=6.0,
                limits=httpx.Limits(max_keepalive_connections=0))
        return self._client

    def _rate_wait(self, host: str = ""):
        """按域限速：同域请求保持最小间隔，跨域并行。
        ⭐ 锁内只记账（把本域下次可发时刻登记好），锁外 sleep——旧实现持锁 sleep
        使所有域所有线程串行排队，home feed 一轮 12 请求被拖到 30s+（审计 H3）。"""
        wait = 0.0
        with self._lock:
            now = time.time()
            last = self._last_req_by_host.get(host, 0.0)
            start_at = max(now, last + MIN_INTERVAL)
            wait = start_at - now
            self._last_req_by_host[host] = start_at
        if wait > 0:
            time.sleep(wait)

    def is_logged_in(self) -> bool:
        uid = config.get("kpl_user_id")
        tok = config.get("kpl_token")
        return bool(uid and tok and str(uid) != "0") and not self._token_invalid

    def _common(self, authed: bool) -> Dict[str, str]:
        common = dict(
            apiv="w48", VerSion="6.3.20.0", PhoneOSNew="1", Red="0",
            DeviceID=self._device_id(),
        )
        if authed:
            common["UserID"] = str(config.get("kpl_user_id") or "0")
            common["Token"] = str(config.get("kpl_token") or "0")
        else:
            common["UserID"] = "0"
            common["Token"] = "0"
        return common

    def call(self, host: str, controller: str, action: str,
             biz: Optional[Dict[str, Any]] = None, authed: bool = True) -> Optional[Dict[str, Any]]:
        """统一请求入口。返回JSON dict，失败返回 None"""
        if authed and not self.is_logged_in():
            self._try_auto_relogin()
            if not self.is_logged_in():
                return None
        self._rate_wait(host)
        data = {**self._common(authed), "c": controller, "a": action}
        if biz:
            for k, v in biz.items():
                if v is not None:
                    data[k] = v
        try:
            r = self._get_client().post(host, data=data)
            if r.status_code != 200:
                logger.debug(f"KPL {controller}/{action} HTTP {r.status_code}")
                return None
            d = r.json()
            err = str(d.get("errcode", "0"))
            if err not in ("0", "9999") :  # 9999 含 method not exists 等试探性错误
                logger.debug(f"KPL {controller}/{action} errcode={err}: {d.get('errmsg','')[:80]}")
            return d
        except Exception as e:
            logger.debug(f"KPL {controller}/{action} 请求失败: {e}")
            return None

    # ---------- 缓存 ----------

    def _cached(self, key: str, ttl: float, fn):
        now = time.time()
        hit = self._cache.get(key)
        if hit and now - hit["ts"] < ttl:
            return hit["data"]
        data = fn()
        if data is not None:
            self._cache[key] = {"data": data, "ts": now}
        return (data if data is not None else (hit or {}).get("data"))

    def _cached_swr(self, key: str, ttl: float, fn):
        """stale-while-revalidate：过期先回旧值并后台刷新（单飞），冷启动才同步拉取。
        用于首页各模块——前端切换 Tab 秒开，不用等 2.5s 限速串行队列。"""
        now = time.time()
        hit = self._cache.get(key)
        if hit and now - hit["ts"] < ttl:
            return hit["data"]
        if hit:
            if not hit.get("refreshing"):
                hit["refreshing"] = True

                def _bg():
                    try:
                        data = fn()
                        if data is not None:
                            self._cache[key] = {"data": data, "ts": time.time()}
                        elif key in self._cache:
                            self._cache[key]["refreshing"] = False
                    except Exception:
                        if key in self._cache:
                            self._cache[key]["refreshing"] = False

                threading.Thread(target=_bg, daemon=True, name=f"kpl-swr-{key}").start()
            return hit["data"]
        data = fn()
        if data is not None:
            self._cache[key] = {"data": data, "ts": now}
        return data

    def invalidate(self, prefix: str = ""):
        for k in [k for k in self._cache if k.startswith(prefix)]:
            del self._cache[k]

    # ---------- 登录态 ----------

    def bind(self, user_id: str, token: str):
        """绑定登录态（用户从App抓包/其他途径获得 UserID+Token）"""
        config.update({"kpl_user_id": str(user_id).strip(),
                       "kpl_token": str(token).strip()})
        self._token_invalid = False
        self.invalidate()

    def unbind(self):
        config.update({"kpl_user_id": "", "kpl_token": ""})
        self._token_invalid = False
        self.invalidate()

    # ---------- 登录（逆向自 App 6.3.20.0：nv0/j00/ox0 字节码 + mitmproxy 抓包验证） ----------

    def send_code(self, phone: str, stype: str = "1") -> Dict[str, Any]:
        """发送短信验证码。⚠️ 必须用 c=PwlMob a=PwlSendVerify（登录页同款，免登录态）；
        Verify/SendVerify 是换绑手机/注销场景（需登录，未登录报"登录状态失效！"）"""
        phone = phone.strip()
        if not phone:
            return {"ok": False, "error": "手机号不能为空"}
        did = self._device_id()
        d = self.call(HOST_LHB, "PwlMob", "PwlSendVerify", {
            "Phone": kpl_rsa_encrypt(phone),
            "CheckCode": _kpl_check_code(did, phone),
            "SType": stype,
        }, authed=False)
        if d is None:
            return {"ok": False, "error": "网络请求失败"}
        err = str(d.get("errcode", "0"))
        if err == "0" and d.get("Phone"):
            return {"ok": True, "phone": d.get("Phone")}
        return {"ok": False, "error": d.get("errmsg") or d.get("Msg") or f"发送失败(errcode={err})"}

    def login_sms(self, phone: str, code: str, invite: str = "") -> Dict[str, Any]:
        """短信验证码登录 c=Login a=LoginPhone（Phone RSA密文, Verify 明文）"""
        phone = phone.strip()
        code = code.strip()
        if not phone or not code:
            return {"ok": False, "error": "手机号和验证码不能为空"}
        return self._finish_login(self.call(HOST_LHB, "Login", "LoginPhone", {
            "Phone": kpl_rsa_encrypt(phone),
            "Verify": code,
            "InviteCode": invite or "",
            "DeviceToken": hashlib.md5(self._device_id().encode()).hexdigest(),
            "ClientID": "3",
        }, authed=False), phone=phone)

    def login_pwd(self, account: str, password: str) -> Dict[str, Any]:
        """账号密码登录 c=Login2 a=LoginDo（Phone/Password 均 RSA密文, EncryptType=RSA）
        密文超50字符的场景（App历史逻辑）直接原样传。"""
        account = account.strip()
        password = password.strip()
        if not account or not password:
            return {"ok": False, "error": "账号和密码不能为空"}
        enc_pwd = password if len(password) > 50 else kpl_rsa_encrypt(password)
        return self._finish_login(self.call(HOST_LHB, "Login2", "LoginDo", {
            "Phone": kpl_rsa_encrypt(account),
            "Password": enc_pwd,
            "EncryptType": "RSA",
        }, authed=False), phone=account)

    def _finish_login(self, d: Optional[Dict[str, Any]], phone: str) -> Dict[str, Any]:
        if d is None:
            return {"ok": False, "error": "网络请求失败"}
        uid = str(d.get("UserID") or "").strip()
        tok = str(d.get("Token") or "").strip()
        if uid and tok and uid != "0":
            endtime = d.get("EndTime")
            config.update({
                "kpl_user_id": uid, "kpl_token": tok,
                "kpl_token_endtime": str(endtime or ""),
                "kpl_username": d.get("UserName") or d.get("Name") or "",
                "kpl_phone": phone,
            })
            self._token_invalid = False
            self.invalidate()
            return {"ok": True, "user_id": uid, "username": d.get("UserName") or d.get("Name") or "",
                    "endtime": endtime}
        return {"ok": False, "error": d.get("errmsg") or d.get("Msg") or "登录失败（账号/验证码错误？）"}

    def _device_id(self) -> str:
        import uuid
        did = config.get("kpl_device_id")
        if not did:
            did = str(uuid.uuid4())
            config.update({"kpl_device_id": did})
        return did

    def _try_auto_relogin(self) -> bool:
        """Token失效且存有账号密码时静默重登（密码明文存配置，同通达信先例）"""
        phone = config.get("kpl_phone")
        pwd = config.get("kpl_password")
        if not (phone and pwd):
            return False
        now = time.time()
        if now - getattr(self, "_last_relogin_ts", 0) < 60:
            return False
        self._last_relogin_ts = now
        logger.info("KPL Token失效，尝试自动重登")
        r = self.login_pwd(phone, pwd)
        if r.get("ok"):
            logger.info(f"KPL 自动重登成功 UserID={r.get('user_id')}")
            return True
        logger.warning(f"KPL 自动重登失败: {r.get('error')}")
        return False

    def logout(self) -> Dict[str, Any]:
        """清除本地登录态（Token 服务端自然过期，不主动注销）"""
        config.update({"kpl_user_id": "", "kpl_token": "", "kpl_token_endtime": "",
                       "kpl_username": "", "kpl_phone": "", "kpl_password": ""})
        self._token_invalid = False
        self.invalidate()
        return {"ok": True}

    def save_credentials(self, phone: str, password: str):
        """记住账号密码（用于Token失效自动重登）"""
        config.update({"kpl_phone": phone.strip(), "kpl_password": password.strip()})

    def status(self) -> Dict[str, Any]:
        """登录态（即时返回，不做阻塞式网络校验）。
        有 Token 且未被明确判定失效 = 已登录，用户信息取自登录时持久化的 kpl_username；
        Token 验活由后台线程限频执行（5分钟），只有服务端明确拒绝才置 token_invalid，
        网络抖动不影响登录态。"""
        uid = str(config.get("kpl_user_id") or "")
        tok = str(config.get("kpl_token") or "")
        have_token = bool(uid and tok and uid != "0")
        if have_token and not self._token_invalid:
            now = time.time()
            if now - self._last_verify_ts > 300:
                self._last_verify_ts = now
                threading.Thread(target=self._verify_token, daemon=True,
                                 name="kpl-verify").start()
        info = dict(self._info_cache) if self._info_cache else None
        if info is None and have_token and config.get("kpl_username"):
            info = {"user_id": uid, "username": config.get("kpl_username"), "kai_pan_b": ""}
        phone = str(config.get("kpl_phone") or "")
        return {
            "logged_in": have_token and not self._token_invalid,
            "user_id": uid,
            "token_endtime": config.get("kpl_token_endtime"),
            "user_info": info,
            "token_invalid": self._token_invalid,
            "phone_masked": (phone[:3] + "****" + phone[-4:]) if len(phone) >= 7 else "",
            "has_credentials": bool(phone and config.get("kpl_password")),
            "can_relogin": bool(phone and config.get("kpl_password")),
        }

    def _verify_token(self):
        """后台验活：成功刷新用户信息缓存；服务端明确拒绝登录态才标记失效。"""
        d = self.call(HOST_LHB, "UserInfo", "GetInfo")
        if d and (d.get("UserName") or d.get("UserID")):
            self._info_cache = {"user_id": str(config.get("kpl_user_id") or ""),
                                "username": d.get("UserName"),
                                "kai_pan_b": d.get("KaiPanB")}
            self._token_invalid = False
            if d.get("UserName"):
                config.update({"kpl_username": d.get("UserName")})
        elif isinstance(d, dict):
            msg = str(d.get("errmsg") or d.get("Msg") or "")
            if "登录" in msg or "token" in msg.lower() or "失效" in msg:
                self._token_invalid = True
                logger.warning(f"KPL Token 被服务端判定失效: {msg[:60]}")
        # d is None（网络失败/超时）→ 保持现状，不误杀

    # ---------- 自选股 ----------

    def get_watchlist(self, force: bool = False) -> Optional[Dict[str, Any]]:
        """自选分组+列表。返回 {groups:[{id,name}], stocks:{group:[codes]}, init_mess}"""
        def fetch():
            d = self.call(HOST_LHB, "UserSelectStock", "GetAllUserSelStock")
            if not d or "CombList" not in d:
                return None
            groups = [{"id": g.get("ID"), "name": g.get("Name")} for g in d.get("CombList", [])]
            return {"groups": groups,
                    "stocks": d.get("StockList", {}),
                    "init_mess": d.get("InitMess", {})}
        if force:
            self.invalidate("watchlist")
        return self._cached("watchlist", 30, fetch)

    def add_stock(self, code: str, combine_id: str = "0") -> Dict[str, Any]:
        r = self.call(HOST_LHB, "UserSelectStock", "AddStock",
                      {"StockID": code, "CombineID": combine_id})
        self.invalidate("watchlist")
        if r and str(r.get("state")) == "1":
            return {"ok": True, "init": r.get("Inits")}
        return {"ok": False, "error": (r or {}).get("errmsg", "添加失败（未登录或参数错误）")}

    def del_stock(self, code: str, combine_id: str = "0") -> Dict[str, Any]:
        r = self.call(HOST_LHB, "UserSelectStock", "DelStock",
                      {"StockID": code, "CombineID": combine_id})
        self.invalidate("watchlist")
        if r and str(r.get("errcode")) == "0":
            return {"ok": True}
        return {"ok": False, "error": (r or {}).get("errmsg", "删除失败")}

    # ---------- 个股行情 ----------

    def get_pankou(self, code: str, force: bool = False) -> Optional[Dict[str, Any]]:
        """个股详情一次拿全：名称/全量报价/十档委托/涨停原因/板块标签"""
        def fetch():
            d = self.call(HOST_HQ, "StockL2Data", "GetStockPanKou", {"StockID": code}, authed=False)
            if not d or not d.get("real"):
                return None
            real = d.get("real", {})
            wt = d.get("weituo", {}) or {}
            asks = [{"px": wt.get(f"s{i}", [0, 0])[0], "vol": wt.get(f"s{i}", [0, 0])[1]} for i in range(10, 0, -1)]
            bids = [{"px": wt.get(f"b{i}", [0, 0])[0], "vol": wt.get(f"b{i}", [0, 0])[1]} for i in range(1, 11)]
            return {
                "code": d.get("code"), "name": d.get("name"),
                "preclose": d.get("preclose_px"),
                "last": real.get("last_px"), "change": real.get("px_change"),
                "change_pct": real.get("px_change_rate"),
                "high": real.get("high_px"), "low": real.get("low_px"), "open": real.get("open_px"),
                "avg": real.get("avg_px"), "turnover_ratio": real.get("turnover_ratio"),
                "amount": real.get("total_turnover"), "vol_ratio": real.get("vol_ratio"),
                "amplitude": real.get("amplitude"),
                "up_limit": real.get("up_px"), "down_limit": real.get("down_px"),
                "entrust_rate": real.get("entrust_rate"),
                "amount_in": real.get("amount_in"), "amount_out": real.get("amount_out"),
                "market_cap": real.get("market_value"), "float_cap": real.get("circulation_amount"),
                "pe": real.get("pe_rate"), "pe_ttm": real.get("TTMPeRate"),
                "asks": asks, "bids": bids,
                "total_ask": wt.get("totals"), "total_bid": wt.get("totalb"),
                "zt_reason": d.get("ZTReason", ""), "risk_reason": d.get("FXReason", ""),
                "group_tag": d.get("Gang", ""),
            }
        if force:
            self.invalidate(f"pankou:{code}")
        return self._cached(f"pankou:{code}", 5, fetch)

    # ---------- 板块 ----------

    def get_plate_info(self, plate_id: str) -> Optional[Dict[str, Any]]:
        """板块头部指标 [排名,点位,成交额,主力净额,涨幅,涨停数,涨停封单,大单封单]"""
        def fetch():
            d = self.call(HOST_HQ, "ZhiShuRanking", "GetPlate_Info_QJ",
                          {"PlateID": plate_id, "Date": ""}, authed=False)
            lst = (d or {}).get("List")
            if not lst or not isinstance(lst, list) or len(lst) < 8:
                return None
            return {"rank": lst[0], "point": lst[1], "amount": lst[2],
                    "main_net": lst[3], "change_pct": lst[4], "zt_count": lst[5],
                    "zt_seal": lst[6], "big_seal": lst[7], "date": (d or {}).get("Date")}
        return self._cached(f"plateinfo:{plate_id}", 15, fetch)

    def get_son_plates(self, plate_id: str) -> Optional[List[Dict[str, Any]]]:
        """细分板块强度 [[码,名,强度]...]"""
        def fetch():
            d = self.call(HOST_HQ, "ZhiShuRanking", "SonPlate_Info",
                          {"PlateID": plate_id}, authed=False)
            lst = (d or {}).get("List") or []
            return [{"code": x[0], "name": x[1], "strength": x[2]} for x in lst if len(x) >= 3]
        return self._cached(f"sonplate:{plate_id}", 60, fetch)

    def get_filter_tags(self, plate_id: str) -> Optional[List[Dict[str, Any]]]:
        """股票池筛选标签（人气激增等VIP项 IsOpen=0）"""
        def fetch():
            d = self.call(HOST_HQ, "ZhiShuRanking", "GetGPCPHBTS_Tag",
                          {"isKLine": "0", "PlateID": plate_id}, authed=False)
            lst = (d or {}).get("List") or []
            return [{"id": x.get("GoodID"), "name": x.get("TSZB_N"),
                     "open": x.get("IsOpen") == 1, "type": x.get("TSZB_Type")} for x in lst]
        return self._cached(f"tags:{plate_id}", 300, fetch)

    def get_plate_trend(self, plate_id: str) -> Optional[Dict[str, Any]]:
        """板块分时 + 分钟量价"""
        def fetch():
            trend = self.call(HOST_HQ, "ZhiShuL2Data", "GetTrendIncremental",
                              {"StockID": plate_id, "Day": ""}, authed=False)
            voltur = self.call(HOST_HQ, "ZhiShuL2Data", "GetVolTurIncremental",
                               {"StockID": plate_id, "Day": ""}, authed=False)
            if not trend:
                return None
            return {"trend": trend.get("trend", []), "preclose": trend.get("preclose_px"),
                    "volumeturnover": (voltur or {}).get("volumeturnover", [])}
        return self._cached(f"platetrend:{plate_id}", 15, fetch)

    def get_plate_events(self, plate_id: str) -> Optional[List[Dict[str, Any]]]:
        """板块分时直播（盘中事件+涨停标注）"""
        def fetch():
            d = self.call(HOST_HQ, "ConceptionPoint", "BKFenShiZhiBo",
                          {"PlateID": plate_id, "Date": ""}, authed=False)
            return (d or {}).get("list") or []
        return self._cached(f"plateevt:{plate_id}", 30, fetch)

    # ---------- 总览/情绪/全球 ----------

    def get_dingpan(self) -> Optional[Dict[str, Any]]:
        """盯盘聚合（封单变动/机构动向/连板天梯）—— App 30s轮询同款"""
        def fetch():
            return self.call(HOST_HQ, "HomeDingPan", "ModuleVersatile")
        return self._cached_swr("dingpan", 15, fetch)

    def get_index_quotes(self) -> Optional[Dict[str, Any]]:
        def fetch():
            # View 含 2,3,4,5 才有 BaceFaceList（题材名→板块id 映射, App 同款参数）
            d = self.call(HOST_HQ2, "Index", "GetInfo",
                          {"View": "2,3,4,5,7,8,9,10,11"})
            if not d:
                d = self.call(HOST_ART, "IndexPlate", "GetIndexList",
                              {"view": "1,2,3,4,6", "st": "2", "Type": "0"})
            # 积累 题材名→801xxx板块id 映射（BaceFaceList: [[名称, 涨幅, 板块id], ...]）
            try:
                for row in (d or {}).get("BaceFaceList") or []:
                    if isinstance(row, list) and len(row) >= 3:
                        self._theme_board_map[str(row[0])] = str(row[2])
            except Exception:
                pass
            return d
        return self._cached_swr("indexq", 10, fetch)

    _theme_board_map: Dict[str, str] = {}
    _pool_qmap_cache: Dict[str, Dict[str, Any]] = {}
    _theme_board_map_ts: float = 0.0

    def _theme_board_id(self, name: str) -> str:
        """题材名→801xxx 板块id（Index/GetInfo 的 BaceFaceList 积累, 10分钟缓存）"""
        if not name:
            return ""
        if not self._theme_board_map or time.time() - self._theme_board_map_ts > 600:
            try:
                # View 含 2,3,4,5 才返回 BaceFaceList（App 同款参数，缺 View 响应为空）
                d = self.call(HOST_HQ2, "Index", "GetInfo",
                              {"View": "2,3,4,5,7,8,9,10,11"}, authed=False)
                rows = (d or {}).get("BaceFaceList") or []
                for row in rows:
                    if isinstance(row, list) and len(row) >= 3:
                        self._theme_board_map[str(row[0])] = str(row[2])
                self._theme_board_map_ts = time.time()
                if not rows:
                    logger.info(f"themedet BaceFaceList 为空（映射表缺 {name} 的板块id）")
            except Exception as e:
                logger.info(f"themedet BaceFaceList 拉取异常: {type(e).__name__} {e}")
        if name in self._theme_board_map:
            return self._theme_board_map[name]
        # 模糊匹配：题材名与映射键双向包含（如 3009"国产芯片概念" ↔ BaceFace"芯片"），最长键优先
        best = ""
        for key, plate in self._theme_board_map.items():
            if key and (key in name or name in key) and len(key) > len(best):
                best = key
        return self._theme_board_map.get(best, "")

    def get_sentiment_history(self) -> Optional[List[Dict[str, Any]]]:
        def fetch():
            d = self.call(HOST_HIS, "HisHomeDingPan", "ChangeStatistics",
                          {"st": "1000", "Index": "0"}, authed=False)
            return (d or {}).get("info") or []
        return self._cached_swr("senthist", 300, fetch)

    def get_global(self) -> Optional[Dict[str, Any]]:
        def fetch():
            d = self.call(HOST_HQ, "GlobalIndex", "GetSearchList",
                          {"Type": "1,2,3,4,5,6"})
            return d
        return self._cached("global", 60, fetch)

    # ---------- 搜索/热搜 ----------

    def get_hot_stocks(self) -> Optional[List[Dict[str, Any]]]:
        def fetch():
            d = self.call(HOST_LHB, "Search", "TodayTopList", authed=False)
            return (d or {}).get("list") or []
        return self._cached_swr("hotstocks", 120, fetch)

    def get_hot_words(self) -> Optional[List[str]]:
        def fetch():
            d = self.call(HOST_HIS, "HisLimitResumption", "GetHotSearch", authed=False)
            return (d or {}).get("word") or []
        return self._cached_swr("hotwords", 600, fetch)

    # ---------- 搜索页（App 搜索 1:1，2026-10-04 协议实测） ----------

    _pinyin_cache: Dict[str, Any] = {}

    @staticmethod
    def _stock_names() -> Dict[str, str]:
        """全市场 {code: name}：随包打包的 App KPL_CACHE 名称表（13690 条，静态稳）。"""
        idx = KplClient._pinyin_cache.get("names")
        if idx is not None:
            return idx
        import os
        pth = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "static", "kpl_stock_names.json")
        try:
            names = json.loads(open(pth, encoding="utf-8").read())
        except Exception:
            names = {}
        KplClient._pinyin_cache["names"] = names
        return names

    def _name_pinyin_index(self) -> Dict[str, Tuple[str, str]]:
        """全市场名称 → (全拼, 首字母)，惰性构建一次（pypinyin 纯 py）。"""
        idx = KplClient._pinyin_cache.get("idx")
        if idx is not None:
            return idx
        try:
            from pypinyin import lazy_pinyin, Style
        except Exception:
            KplClient._pinyin_cache["idx"] = {}
            return {}
        idx = {}
        for code, name in self._stock_names().items():
            if not name:
                continue
            try:
                full = "".join(lazy_pinyin(name)).lower()
                abbr = "".join(lazy_pinyin(name, style=Style.FIRST_LETTER)).lower()
                idx[code] = (full, abbr)
            except Exception:
                continue
        KplClient._pinyin_cache["idx"] = idx
        return idx

    def search_suggest(self, q: str, limit: int = 20) -> List[Dict[str, Any]]:
        """综合联想：代码/名称包含 + 全拼/拼音首字母前缀匹配（App 输入中即时联想）。
        名称表为 App 全量 STOCK 表（含港股/外汇/期货/板块）——外汇期货剔除，
        A 股排前，港美股/板块带 market 标识（详情页仅支持 A 股）。"""
        q = (q or "").strip().upper()
        if not q:
            return []
        ql = q.lower()
        names = self._stock_names()
        idx = self._name_pinyin_index()

        def market_of(code: str) -> str:
            if code.startswith("HK:"):
                return "HK"
            if code.startswith("US:"):
                return "US"
            if code.isdigit() and len(code) == 6:
                return "A"
            if code.startswith(("88", "80", "85", "99")):
                return "板块"
            return ""   # 外汇/期货等杂码，剔除

        a_rows, other_rows = [], []
        for code, name in names.items():
            if not name:
                continue
            mk = market_of(code)
            if not mk:
                continue   # 外汇/期货等（App 搜索结果亦无此类）
            hit = q in code or q in name.upper()
            if not hit and idx.get(code):
                full, abbr = idx[code]
                hit = mk == "A" and (full.startswith(ql) or abbr.startswith(ql) or ql in abbr)
            if hit:
                row = {"code": code, "name": name, "market": mk}
                (a_rows if mk == "A" else other_rows).append(row)
                if len(a_rows) >= limit:
                    break
        return a_rows + other_rows[:max(0, limit - len(a_rows))]

    @staticmethod
    def _tx_pct_batch(codes: List[str]) -> Dict[str, Any]:
        """腾讯批量行情补涨跌幅（免鉴权）：{code: pct_str}。codes 无市场前缀自动补。"""
        out: Dict[str, Any] = {}
        if not codes:
            return out
        def pref(c):
            return ("sh" if c.startswith(("6", "9", "5")) else
                    "bj" if c.startswith(("4", "8", "9")) else "sz") + c
        url = "https://qt.gtimg.cn/q=" + ",".join(pref(c) for c in codes[:60])
        try:
            r = httpx.get(url, timeout=6, headers={"User-Agent": "Mozilla/5.0"})
            txt = r.text
            import re as _re
            for m in _re.finditer(r'v_[a-z]+(\d{6})="([^"]+)"', txt):
                code, payload = m.group(1), m.group(2)
                parts = payload.split("~")
                if len(parts) > 32:
                    out[code] = parts[32]   # 涨跌幅%
        except Exception:
            pass
        return out

    def get_search_hot(self) -> Dict[str, Any]:
        """搜索页默认态各 tab 热门（同刻并发）。
        综合=Search/ZongHeHotList.StockList(补名+腾讯涨幅)；龙虎榜=DaZongJiaoYi/GetHotSearch；
        涨停原因=HisLimitResumption/GetHotSearch；基金/营业部 App 热门暂固定（待盘中定位接口）。"""
        from concurrent.futures import ThreadPoolExecutor
        pool_names = self._stock_names()

        def zonghe():
            d = self.call(HOST_LHB, "Search", "ZongHeHotList", authed=True)
            stocks = []
            for x in (d or {}).get("StockList") or []:
                code = x.get("ID") or ""
                stocks.append({"code": code, "name": x.get("Name") or pool_names.get(code, ""),
                               "reason": x.get("Reason") or "", "is_dy": x.get("IsDY")})
            pct = self._tx_pct_batch([s["code"] for s in stocks])
            for s in stocks:
                s["pct"] = pct.get(s["code"])
            return stocks

        def lhb():
            d = self.call(HOST_LHB, "DaZongJiaoYi", "GetHotSearch", authed=False)
            rows = [{"code": x.get("StockID"), "name": x.get("Name")}
                    for x in (d or {}).get("List") or []]
            pct = self._tx_pct_batch([r["code"] for r in rows if r.get("code")])
            for r in rows:
                r["pct"] = pct.get(r.get("code") or "")
            return rows

        def zt():
            return self.get_hot_words() or []

        with ThreadPoolExecutor(3) as ex:
            f1, f2, f3 = ex.submit(zonghe), ex.submit(lhb), ex.submit(zt)
            stocks, lhb_hot, zt_words = f1.result(), f2.result(), f3.result()
        return {
            "stocks": stocks,
            "lhb_hot": lhb_hot,
            "zt_words": zt_words,
            "fund_hot": [
                {"name": "华夏中证5G通信主题ETF"},
                {"name": "鹏华全球中短债债券A类人民币(QDII)"},
                {"name": "东方红中证东方红红利低波动指数A"},
                {"name": "安信工业4.0混合A"},
            ],
            "biz_hot": [
                {"name": "国泰海通证券武汉紫阳东路"},
                {"name": "中国银河证券大连黄河路"},
                {"name": "国投证券绍兴延安东路"},
                {"name": "国泰海通证券南京太平南路"},
            ],
        }

    def search_combine(self, kw: str) -> Dict[str, Any]:
        """综合搜索"更多结果"：资讯/快讯/互动易/题材/管理（APPComplexData/GetCombineSearch @ART）。"""
        d = self.call(HOST_ART, "APPComplexData", "GetCombineSearch", {"search": kw}, authed=False)
        comb = (d or {}).get("Combines") or {}
        out = {}
        for k, v in comb.items():
            if isinstance(v, dict):
                out[k] = v.get("List") or []
        return out

    def search_fund(self, kw: str, index: int = 0, st: int = 10) -> List[Dict[str, Any]]:
        """基金 tab 搜索（Search/JiJinQuery @LHB：keyword/Index/st）。"""
        d = self.call(HOST_LHB, "Search", "JiJinQuery",
                      {"keyword": kw, "Index": str(index), "st": str(st)}, authed=False)
        return (d or {}).get("list") or []

    # ---------- 推荐菜单/文章详情（App PContent2.html 同源协议，2026-10-04 H5 JS 逆向） ----------

    def get_article(self, aid: str) -> Dict[str, Any]:
        """文章详情：ForumsMsgJX/GetInfo {MsgID, Tag:1} @ART（App 文章 H5 页 PContent2.js 同源）。
        Content 为 HTML 正文；Stock 为相关股票数组。"""
        d = self.call(HOST_ART, "ForumsMsgJX", "GetInfo",
                      {"MsgID": str(aid), "Tag": "1"}, authed=False)
        msg = (d or {}).get("Msg") or {}
        return {
            "id": msg.get("ID") or aid,
            "title": msg.get("Title") or "",
            "content": msg.get("Content") or "",
            "time": msg.get("CreateTime"),
            "account": msg.get("Account") or "",
            "msg_type": msg.get("MsgType"),
            "zhaiyao": msg.get("ZhaiYao") or "",
            "stocks": msg.get("Stock") or [],
            "column": (msg.get("Column") or {}).get("Name") or "",
            "vote_count": msg.get("VoteCount") or 0,
            "share_count": msg.get("ShareCount") or 0,
        }

    def get_recommend_articles(self, st: int = 20, index: int = 0) -> List[Dict[str, Any]]:
        """推荐页文章流（UserInfo/AppNews @LHB，st 条数/Index 页码——j00.r1 字节码参数）。
        Type=39 为大盘解读文案，剔除。"""
        d = self.call(HOST_LHB, "UserInfo", "AppNews",
                      {"st": str(st), "Index": str(index)}, authed=True)
        out = []
        for x in (d or {}).get("List") or []:
            if str(x.get("Type")) == "39":
                continue
            out.append({
                "id": x.get("ID"), "title": (x.get("Title") or "").strip(),
                "content": (x.get("Content") or "").strip(),
                "time": x.get("Time"), "type": x.get("Type"),
                "url": x.get("URL") or "",
                "stock_name": x.get("StockName") or "", "stock_id": x.get("StockID") or "",
            })
        return out

    def get_art_tab_feed(self) -> List[Dict[str, Any]]:
        """文章 tab 列表（IndexPlate/GetIndexList view=1,2,3,4,6 st=2 @kaipanla 版 ART）。
        App 实拍同源：官方教程条目无 TopicID（点开走 ID），转载条目带 TopicID/Account/Stock。
        TopicID 是 App 点击时传详情的 MsgID（GetInfo 双模式兼容数字 ID 与 TopicID）。"""
        import httpx
        common = self._common(False)
        common.update({"c": "IndexPlate", "a": "GetIndexList",
                       "view": "1,2,3,4,6", "st": "2", "Type": "0"})
        host = HOST_ART.replace("longhuvip", "kaipanla")
        try:
            r = httpx.post(host, data=common, timeout=15,
                           headers={"User-Agent": "Mozilla/5.0"})
            d = r.json()
        except Exception:
            return []
        out = []
        for x in ((d or {}).get("MsgTop") or {}).get("List") or []:
            img = ((x.get("img") or {}).get("List") or [])
            stocks = x.get("Stock") or []
            out.append({
                "id": x.get("ID"),
                # ⭐ App 详情链路用 AID（文章体系 ID）：GetInfo {MsgID: AID}
                "aid": str(x.get("AID") or x.get("ID")),
                "title": x.get("Title") or "",
                "zhaiyao": x.get("ZhaiYao") or "",
                "time": x.get("CreateTime"),
                "account": x.get("Account") or "",
                "img": img[0] if img else "",
                "stocks": stocks if isinstance(stocks, list) else [],
                "is_pay": 0,
                "vote": x.get("Like") or 0,
            })
        return out

    # ============= 严重异动提醒家族（2026-10-05 全套逆向：newindex/deviation 包字节码 +
    #               yd8/yd16/yd17/yd30~32 实拍锚定；响应样本 captures/yidong_family_20261005.json）=============
    # 页面结构（App）：首页块「严重异动提醒 次日评估 更多›」→ 更多/重点监控 → AbnormalAlertActivity
    # （异动提醒页：概览头+日期导航+预警开关 + 3 tab 严重异动/热门股偏离值/重点监控）；
    # 「查看多次异动个股(N)」→ DeviationManyChangeActivity（沪深主板/创业科创板双 tab）。
    # 接口族（c=StockBidYiDong）：
    #   GetPianLiZhi_W46 @HQ 今日 / GetYDTPZFPL_W46 {Day} @HIS 历史 —— 严重异动 tab（明日/今日双节，行 20 字段）
    #   GetYDTPZFPL_W46_HisAll {Day,IsZT,Index,st[,Status]} @HIS —— 近期严重异动节（分页历史）
    #   GetPianLiZhi_Hot @HQ / GetPianLiZhi_Hot_His {Day} @HIS —— 热门股偏离值 tab
    #   GetPianLiZhi_Index {ZDJK_Type:1} @HQ / _W32 {Day,IsZT} @HIS —— 严重异动提醒独立页（13 字段，[11]=预计触发价）
    #   GetPianLiZhi_Many @HQ —— 多次异动个股页（行 11 字段，[2]=板块族 1主板/2创业科创）
    #   GetYDTP_ZDJK_Today/His @HQ —— 重点监控 tab（监管期证券）
    #   GetYDTP_WXHJ_His @HQ 无参 / {Index,st} @HIS —— 问询函件（PDF）

    @staticmethod
    def _yd_num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    @classmethod
    def _parse_w46_row(cls, r) -> Dict[str, Any]:
        """严重异动 tab 行（20 字段，语义经 yd30/yd31 实拍逐位锚定）：
        [0]code [1]name [2]规则简称(10日100%/30日200%/...停牌核查) [3]当日涨幅(明日节=0基数)
        [4]连板文字(3连板/昨日首板) [5]触发所需涨幅% [6]预计触发价 [7]当日偏离值空间%
        [8]当日状态(触发严重异动/未触发异动) [9]次日偏离值空间% [10]概念串 [11]0 [12]规则简称2
        [13]触发价2 [14]次日涨幅(仅历史行有值) [15][16]停牌标 [17]停牌日期 [18]异动日期 [19]现价"""
        g = cls._yd_num
        concept = str(r[10] or "")
        return {
            "code": str(r[0]), "name": r[1], "rule_short": r[2],
            "day_pct": g(r[3]), "zt_text": r[4] or "",
            "need": g(r[5]), "trigger_price": g(r[6]),
            "space_today": g(r[7]), "status_today": r[8] or "",
            "space_next": g(r[9]),
            "concept": concept.split("、")[0] if concept else "",
            "concept_full": concept,
            "next_day_pct": g(r[14]) if len(r) > 14 else None,
            "suspended": bool((len(r) > 16 and r[16]) or "停牌" in str(r[2])),
            "action_date": (r[18] or "") if len(r) > 18 else "",
            "price": g(r[19]) if len(r) > 19 else None,
        }

    def get_yidong_severe(self, day: str = "") -> Dict[str, Any]:
        """严重异动 tab（App 异动提醒页同源）。今日=GetPianLiZhi_W46@HQ（List_Tormorow 明日评估节
        + List_Today 今日盘面节，服务端拼写就是 Tormorow）；历史=GetYDTPZFPL_W46{Day}@HIS。"""
        def _fetch():
            if day:
                d = self.call(HOST_HIS, "StockBidYiDong", "GetYDTPZFPL_W46", {"Day": day}, False)
            else:
                d = self.call(HOST_HQ, "StockBidYiDong", "GetPianLiZhi_W46", {}, False)
            d = d or {}
            ok = lambda rows: [self._parse_w46_row(r) for r in rows or []
                               if isinstance(r, list) and len(r) > 19]
            return {"day": d.get("Day") or day or "",
                    "tomorrow": ok(d.get("List_Tormorow")),
                    "today": ok(d.get("List_Today"))}
        return self._cached_swr("yd_severe" if not day else f"yd_severe_{day}", 60, _fetch)

    def get_yidong_severe_his(self, day: str, status: int = -1,
                              index: int = 0, st: int = 20) -> Dict[str, Any]:
        """近期严重异动（GetYDTPZFPL_W46_HisAll {Day,IsZT,Index,st[,Status]} @HIS）。
        App 三档筛选 pill：全部=不传 Status(-1)、触发严重异动=1、被停牌=2（字节码 Status>=0 才带上）。"""
        def _fetch():
            params = {"Day": day, "IsZT": "0", "Index": str(index), "st": str(st)}
            if status is not None and status >= 0:
                params["Status"] = str(status)
            d = self.call(HOST_HIS, "StockBidYiDong", "GetYDTPZFPL_W46_HisAll", params, False) or {}
            rows = [self._parse_w46_row(r) for r in d.get("List_His") or []
                    if isinstance(r, list) and len(r) > 19]
            return {"day": d.get("Day") or day, "total": d.get("List_His_Total"), "list": rows}
        key = f"yd_severehis_{day}_{status}_{index}_{st}"
        return self._cached_swr(key, 300, _fetch)

    def get_yidong_hot(self, day: str = "") -> Dict[str, Any]:
        """热门股偏离值 tab（GetPianLiZhi_Hot@HQ 今日 / GetPianLiZhi_Hot_His{Day}@HIS）。
        行 12 字段（yd32 实拍锚定）：[0]code [1]name [2]规则简称 [3]当日涨幅% [4]涨幅偏离值%
        [5]连板文字 [6]当日触发异动偏离值空间% [7]?未展示 [8]概念串 [9]0 [10]异动统计日数("10日")
        [11]标签("10日100%"/"同向异动")。默认按 [4] 降序（App 列头红箭头同序，服务端序即此序）。"""
        def _fetch():
            if day:
                d = self.call(HOST_HIS, "StockBidYiDong", "GetPianLiZhi_Hot_His", {"Day": day}, False)
            else:
                d = self.call(HOST_HQ, "StockBidYiDong", "GetPianLiZhi_Hot", {}, False)
            d = d or {}
            lst = []
            for r in d.get("List") or []:
                if not isinstance(r, list) or len(r) < 11:
                    continue
                concept = str(r[8] or "")
                lst.append({
                    "code": str(r[0]), "name": r[1], "rule_short": r[2],
                    "pct": self._yd_num(r[3]), "dev": self._yd_num(r[4]),
                    "zt_text": r[5] or "", "space": self._yd_num(r[6]),
                    "concept": concept.split("、")[0] if concept else "",
                    "days": r[10] or "", "tag": r[11] or "",
                })
            return {"day": d.get("Day") or day or "", "list": lst}
        return self._cached_swr("yd_hot" if not day else f"yd_hot_{day}", 60, _fetch)

    def get_yidong_wxhj(self, index: int = 0, st: int = 30) -> Dict[str, Any]:
        """问询函件（GetYDTP_WXHJ_His：首页@HQ 无参 / 翻页@HIS {Index,st}）。
        行: [code, name, 日期, PDF链接(appdata.longhuvip.com/SupPDFs/..), 类型]"""
        if index > 0:
            d = self.call(HOST_HIS, "StockBidYiDong", "GetYDTP_WXHJ_His",
                          {"Index": str(index), "st": str(st)}, False)
        else:
            d = self.call(HOST_HQ, "StockBidYiDong", "GetYDTP_WXHJ_His", {}, False)
        d = d or {}
        lst = []
        for r in d.get("List") or []:
            if not isinstance(r, list) or len(r) < 4:
                continue
            lst.append({"code": str(r[0]), "name": r[1], "date": r[2], "pdf": r[3]})
        return {"list": lst}

    def get_yidong_many(self) -> Dict[str, Any]:
        """多次异动个股（GetPianLiZhi_Many@HQ，App「查看多次异动个股」下钻同源，yd16 实拍锚定）。
        行 11 字段: [0]code [1]name [2]板块族(1=沪深主板/2=创业科创板，与 00·60/30·68 前缀完全相关)
        [3]分组名 [4]下一触发次数 [5]第N日 [6]3日内偏离值% [7]预计价格 [8]预计价格对应涨幅%
        [9]当前价格 [10]?(恒0)。day_pct=现价实时涨幅（App 经 RefreshStockList_price 刷新，插件用
        GetStockPanKou 并发 6 补齐，60s 缓存）。"""
        def _fetch():
            d = self.call(HOST_HQ, "StockBidYiDong", "GetPianLiZhi_Many", {}, authed=False)
            lst = []
            for row in (d or {}).get("List") or []:
                if not isinstance(row, list) or len(row) < 10:
                    continue
                lst.append({
                    "code": str(row[0]), "name": row[1], "board": row[2],
                    "group": row[3], "next_cnt": row[4], "day_n": row[5],
                    "dev3": self._yd_num(row[6]), "est_price": self._yd_num(row[7]),
                    "est_pct": self._yd_num(row[8]), "price": self._yd_num(row[9]),
                })
            groups = []
            for it in lst:
                if it["group"] not in groups:
                    groups.append(it["group"])
            out = {"day": (d or {}).get("Day"), "groups": groups, "list": lst}
            # 现价下副行=当日实时涨幅（App 经 UserSelectStock/RefreshStockList_price 刷新，接口已 9999；
            # 插件用 GetStockPanKou 并发 6 补齐，App chips 同机制）
            try:
                codes = list({it["code"] for it in lst})
                rates = self._pankou_batch(codes)
                for it in lst:
                    it["day_pct"] = rates.get(it["code"])
            except Exception:
                pass
            return out
        return self._cached_swr("yd_many", 60, _fetch)

    def get_zdjk(self, his: bool = False, day: str = "") -> Dict[str, Any]:
        """重点监控/监管期证券（GetYDTP_ZDJK_Today@HQ / GetYDTP_ZDJK_His@HIS）。
        List 条目: [code, name, 监控开始日期, 监控结束日期, 2]。"""
        key = f"zdjk_his_{day}" if his else "zdjk_today"

        def _fetch():
            params = {"Day": day} if (his and day) else {}
            d = self.call(HOST_HQ, "StockBidYiDong",
                          "GetYDTP_ZDJK_His" if his else "GetYDTP_ZDJK_Today",
                          params, authed=False)
            lst = []
            for row in (d or {}).get("List") or []:
                if not isinstance(row, list) or len(row) < 4:
                    continue
                lst.append({"code": str(row[0]), "name": row[1],
                            "start": row[2], "end": row[3]})
            return lst
        return self._cached_swr(key, 120, _fetch)

    def get_yidong_home(self) -> Dict[str, Any]:
        """首页严重异动提醒块（App 同源=GetPianLiZhi_W46「明日评估」节前 5 行，
        yd8 实拍锚定：列头 次日涨幅/触发异动涨幅股票价格/次日触发异动偏离值空间，
        概念 tag=行[10]概念串首项；副标题固定文案「次日评估」）。
        many_count=「查看多次异动个股(N)」角标（GetPianLiZhi_Many 去重代码数，即服务端 Index.Many_Num）。"""
        def _fetch():
            sev = self.get_yidong_severe()
            rows = (sev or {}).get("tomorrow") or []
            try:
                many = self.get_yidong_many()
                cnt = len({r["code"] for r in many.get("list") or []}) or None
            except Exception:
                cnt = None
            return {"day": (sev or {}).get("day") or "", "items": rows[:5], "many_count": cnt}
        return self._cached_swr("yd_home", 60, _fetch)

    def get_recommend_columns(self) -> List[Dict[str, Any]]:
        """推荐页栏目 tab（ForumsMsgColumn/GetList @ART，App 推荐页顶部分类）。
        顺序=服务端 Orders 序（GetList 返回序，与 App 一致），不过滤不重排。"""
        d = self.call(HOST_ART, "ForumsMsgColumn", "GetList",
                      {"Index": "0", "st": "50"}, authed=True)
        cols = []
        for x in (d or {}).get("List") or []:
            cols.append({"id": str(x.get("ID")), "name": x.get("Name") or "",
                         "recommend": str(x.get("Recommend")) == "1",
                         "focus": x.get("Focus") or 0,
                         "head_pic": x.get("HeadPic") or "", "descn": x.get("Descn") or "",
                         "sub": str(x.get("Sub")) == "1",
                         "hot": str(x.get("Tag")) == "2"})
        return cols

    def get_column_feed(self, column_id: str, pre_index: Optional[str] = None) -> Dict[str, Any]:
        """栏目文章 feed（ForumsMsgColumn/GetInfo {ColumnID, PreIndex} @ART，带缩略图卡片）。
        PreIndex 为上一页返回的游标（首页不传）。"""
        biz = {"ColumnID": str(column_id)}
        if pre_index:
            biz["PreIndex"] = str(pre_index)
        d = self.call(HOST_ART, "ForumsMsgColumn", "GetInfo", biz, authed=False)
        base = (d or {}).get("Base") or {}
        lst = []
        for x in (d or {}).get("List") or []:
            img = ((x.get("img") or {}).get("List") or [])
            lst.append({
                "id": x.get("ID"),
                # ⭐ AID=文章体系 ID（ForumsMsgJX/GetInfo 的 MsgID 用它，非本表 ID）
                "aid": x.get("AID") or "",
                "title": x.get("Title") or "",
                "zhaiyao": x.get("ZhaiYao") or "",
                "time": x.get("CreateTime"),
                "msg_type": x.get("MsgType"),
                "vote": x.get("VoteCount") or 0, "share": x.get("ShareCount") or 0,
                "img": img[0] if img else "",
                "is_pay": x.get("IsPay") or 0,
                "account": x.get("Account") or "",
                "stocks": x.get("Stock") or [],
            })
        return {
            "column": {"id": base.get("ID") or column_id, "name": base.get("Name") or "",
                       "descn": base.get("Descn") or "",
                       "head_pic": base.get("HeadPic") or "", "focus": base.get("Focus") or 0},
            "pre_index": (d or {}).get("PreIndex"),
            "list": lst,
        }


    # ---------- 首页聚合（复刻 App 首页信息流，模块接口均为 2026-09-22 实测） ----------

    def get_home_feed(self, force: bool = False) -> Optional[Dict[str, Any]]:
        """首页各模块聚合：大盘解读/最新主题/AI快讯/最强风口/市场风口/市场情绪/活跃板块/推荐文章。
        ⭐ 三层速度对齐 App：内存 SWR(20s) → 磁盘缓存秒显(kpl_home_cache.json) → 同步冷拉。
        磁盘层让后端重启/冷启动时首页也秒显上次数据（App 同款本地缓存行为），后台自动刷新。"""
        if force:
            self.invalidate("homefeed")
        now = time.time()
        hit = self._cache.get("homefeed")
        if hit and now - hit["ts"] < 20:
            return hit["data"]
        if hit:
            if not hit.get("refreshing"):
                hit["refreshing"] = True
                threading.Thread(target=self._bg_refresh_homefeed, daemon=True,
                                 name="kpl-swr-homefeed").start()
            return hit["data"]
        disk = self._load_home_disk()
        if disk:
            self._cache["homefeed"] = {"data": disk, "ts": now, "refreshing": True}
            threading.Thread(target=self._bg_refresh_homefeed, daemon=True,
                             name="kpl-swr-homefeed").start()
            return disk
        data = self._fetch_home_feed()
        if data is not None:
            self._cache["homefeed"] = {"data": data, "ts": time.time()}
            self._save_home_disk(data)
        return data

    def _home_disk_path(self):
        from storage import storage as _st
        return _st.data_dir / "kpl_home_cache.json"

    def _load_home_disk(self) -> Optional[Dict[str, Any]]:
        try:
            sn = json.loads(self._home_disk_path().read_text(encoding="utf-8"))
            if sn.get("data") and time.time() - float(sn.get("ts") or 0) < 7 * 86400:
                return sn["data"]
        except Exception:
            pass
        return None

    def _save_home_disk(self, data: Dict[str, Any]) -> None:
        try:
            tmp = self._home_disk_path().with_suffix(".tmp")
            tmp.write_text(json.dumps({"ts": time.time(), "data": data},
                                      ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._home_disk_path())
        except Exception as e:
            logger.debug(f"home 磁盘缓存: {e}")

    def _bg_refresh_homefeed(self) -> None:
        try:
            data = self._fetch_home_feed()
            if data is not None:
                self._cache["homefeed"] = {"data": data, "ts": time.time(),
                                           "refreshing": False}
                self._save_home_disk(data)
            elif "homefeed" in self._cache:
                self._cache["homefeed"]["refreshing"] = False
        except Exception:
            if "homefeed" in self._cache:
                self._cache["homefeed"]["refreshing"] = False

    _home_pool: List = []   # 模块级单例线程池占位（类属性）

    def _fetch_home_feed(self) -> Optional[Dict[str, Any]]:
        from concurrent.futures import ThreadPoolExecutor
        out: Dict[str, Any] = {}
        if not KplClient._home_pool or KplClient._home_pool[0]._shutdown:
            ex = ThreadPoolExecutor(max_workers=8)
            KplClient._home_pool = [ex]
        pool = KplClient._home_pool[0]
        futs = {}
        # 1. 大盘解读(Type=39) + 推荐文章 —— applhb UserInfo/AppNews
        futs["news"] = pool.submit(self.call, HOST_LHB, "UserInfo", "AppNews", {"st": "30", "Index": "0"}, False)
        # 2. AI快讯 —— apparticle PCNewsFlash/GetList
        futs["flash"] = pool.submit(self.call, HOST_ART, "PCNewsFlash", "GetList",
                          {"st": "20", "Type": "0", "Index": "0", "Date": ""}, False)
        # 3. 最新主题 —— apparticle ThemeNews/GetList（与主题机会页同源，首页只取前2条）
        futs["themes"] = pool.submit(self.call, HOST_ART, "ThemeNews", "GetList",
                           {"st": "10", "Index": "0", "Type": "-1"}, False)
        # 3.5 题材库热榜（Socket，后台已有缓存则即时）
        futs["tika"] = pool.submit(self.get_themes_socket)
        # 3.6 人气榜（socket 3008，App 首页同源：盘中时段=盘中榜 type1，其余=复盘榜 type13）
        # ⭐ 交易日判定走深交所官方日历（法定节假日休市日不再误判"盘中"，2026-09-30）
        from trade_calendar import get_cal
        _trading = get_cal().is_trading_now()
        futs["poprank"] = pool.submit(self.get_pop_rank, 1 if _trading else 13, 1, 0, 5)
        # 3.7 严重异动提醒块（StockBidYiDong/GetPianLiZhi_W46「明日评估」节，App 首页块同源）
        futs["yidong"] = pool.submit(self.get_yidong_home)
        # 3.8 风向标（socket 2103 订阅式，盘中实时；盘后走快照，会话死时跳过不阻塞）
        futs["daban"] = pool.submit(self.get_daban)
        # 3.9 市场风口（StockFengKData/GetFengKList，服务端含历史）
        futs["fengkou"] = pool.submit(self.get_fengkou)
        # 4. 最强风口 —— Index/GetInfo ZQFKList（App 同源全时段，get_qiangdu 内含快照兜底）
        futs["qd"] = pool.submit(self.get_qiangdu)
        # 5. 市场风口热词 —— apparticle ForumsTuyere/GetHotSearch
        futs["tuyere"] = pool.submit(self.call, HOST_ART, "ForumsTuyere", "GetHotSearch", {}, False)
        # 6. 市场情绪（今日/昨日 涨停家数/封板率/跌停数）—— 复用情绪历史前两条
        futs["sent"] = pool.submit(self.get_sentiment_history)
        # 6.5 首页量能对照行（App：上证量能/沪深京量能 + 昨日此时/昨日总计）
        #     = MarketCapacity Type=1(上证)/Type=4(沪深京)，trends 末条 cur=今日 yes=昨日此时，昨日单日 last=昨日总计
        def _cap_ln(ctype, day=None):
            host = "https://apphwhq.kaipanla.com/w1/api/index.php" if not day else "https://apphis.kaipanla.com/w1/api/index.php"
            ctl = "HomeDingPan" if not day else "HisHomeDingPan"
            act = "MarketCapacity" if not day else "MarketSCLN"
            biz = {"Type": ctype} if not day else {"Date": day.replace("-", ""), "Type": ctype}
            d = self.call(host, ctl, act, biz, False)
            info = (d or {}).get("info") or {}
            tr = info.get("trends") or []
            last_ln = None
            if tr:
                tail = tr[-1]
                try:
                    last_ln = {"cur": int(float(tail[1])), "yes": int(float(tail[2]))}
                except Exception:
                    last_ln = None
            return {"last": info.get("last"), "yclnstr": info.get("yclnstr"), "tail": last_ln}
        def _cap_ln_pair(ctype, prev_day):
            today = _cap_ln(ctype)
            yest = _cap_ln(ctype, prev_day) if prev_day else {}
            return {"cur": today.get("last"),
                    "yes_now": (today.get("tail") or {}).get("yes"),
                    "yest_total": yest.get("last")}

        # 首页情绪模块量能对照（异步计算，不阻塞主 fetch）
        def _cap_ln_async():
            try:
                from trade_calendar import get_cal
                prev = get_cal().prev_trading_day(time.strftime("%Y-%m-%d"))
                out["capln"] = {
                    "sh": _cap_ln_pair("1", prev),
                    "hsjk": _cap_ln_pair("4", prev),
                }
            except Exception as e:
                logger.debug(f"capln: {e}")
        pool.submit(_cap_ln_async)

        items = ((futs["news"].result() or {}).get("List")) or []
        explain = next((it for it in items if str(it.get("Type")) == "39"), None)
        out["explain"] = self._norm_news(explain) if explain else None
        out["articles"] = [self._norm_news(it) for it in items if str(it.get("Type")) != "39"][:10]
        fl = ((futs["flash"].result() or {}).get("List")) or []
        out["flash"] = [{
            "id": x.get("CID"), "time": x.get("Time"), "title": x.get("Title"),
            "content": x.get("Content"), "source": x.get("Source"),
            "stocks": [{"code": s[0], "name": s[1], "rate": s[2]}
                       for s in (x.get("Stocks") or []) if isinstance(s, list) and len(s) >= 3],
        } for x in fl]
        tl = ((futs["themes"].result() or {}).get("List")) or []
        out["themes"] = [{
            "id": x.get("CID"), "title": x.get("Title"),
            # ZSName 与 Kword 互补：响应里两者必有其一（App 同款显示），只取 ZSName 会缺名
            "theme": x.get("ZSName") or x.get("Kword") or "",
            "time": x.get("TimeStamp"), "source": x.get("Source"),
            "stocks": [{"code": s.get("Code"), "name": s.get("Name"), "rate": s.get("Rate")}
                       for s in (x.get("Stocks") or []) if isinstance(s, dict)][:2],
        } for x in tl[:2]]
        try:
            tk_items = (futs["tika"].result() or {}).get("items") or []
            out["tika"] = tk_items[:3]
        except Exception:
            out["tika"] = []
        # 人气榜前5 + 5分钟急升条（3008）
        try:
            pr = futs["poprank"].result() or {}
            out["poprank"] = pr.get("items") or []
            out["poprank_hot"] = pr.get("five_minute_items") or []
        except Exception:
            out["poprank"] = []
            out["poprank_hot"] = []
        # 严重异动提醒块（W46 明日评估节 + 多次异动角标）
        try:
            yd = futs["yidong"].result() or {}
            out["yidong"] = yd.get("items") or []
            out["yidong_day"] = yd.get("day")
            out["yidong_many_count"] = yd.get("many_count")
        except Exception:
            out["yidong"] = []
        try:
            qd_ret = futs["qd"].result() or {}
            out["qiangdu"] = qd_ret.get("list") or []
            out["qiangdu_day"] = qd_ret.get("day") or ""
        except Exception:
            out["qiangdu"] = []
        try:
            out["daban"] = futs["daban"].result() or {}
        except Exception:
            out["daban"] = {}
        try:
            out["fengkou"] = (futs["fengkou"].result() or {}).get("rows") or []
        except Exception:
            out["fengkou"] = []
        out["tuyere_words"] = ((futs["tuyere"].result() or {}).get("List")) or []
        sent = futs["sent"].result() or []
        out["sentiment"] = {
            "today": sent[0] if len(sent) > 0 else {},
            "yesterday": sent[1] if len(sent) > 1 else {},
        }
        # 7. 近期活跃板块（App 同源：Index/GetInfo 的 BaceFaceList 恒 4 条热门板块，
        #    [板块名, 涨幅, 801/803板块id]——2026-09-27 mitmproxy 抓包实锤，勿再走 3009 涨幅榜）
        try:
            bf = self._active_plates_raw()
            out["active_plates"] = [{"name": n, "rate": float(r), "plateId": pid}
                                    for n, r, pid in bf]
        except Exception:
            out["active_plates"] = []
        pool.shutdown(wait=False)
        return out

    # ---------- 主题机会页（复刻 App「更多→主题机会」，2026-09-22 mitmproxy 实测） ----------

    def get_theme_list(self, tab: str = "themes", index: int = 0, st: int = 30) -> Dict[str, Any]:
        """主题机会两个Tab的数据。tab: 'themes'=最新主题(Type=-1) | 'calendar'=投资日历(Type=3)
        最新主题条目: CID/Title/ZSName(主题)/TimeStamp/Source/Stocks[{Code,Name,Rate,SetTop}]
        投资日历条目: PID/Brief/Date/TagName(会议|事件)/ColorType(1红2橙)/Stocks"""
        t = "-1" if tab == "themes" else "3"
        d = self.call(HOST_ART, "ThemeNews", "GetList",
                      {"st": str(st), "Index": str(index), "Type": t}, authed=False)
        lst = (d or {}).get("List") or []
        if tab == "themes":
            items = [{
                "id": x.get("CID"), "title": x.get("Title"),
                # ZSName 与 Kword 互补（同 home feed，缺一用另一）
                "theme": x.get("ZSName") or x.get("Kword") or "",
                "time": x.get("TimeStamp"), "source": x.get("Source"),
                "stocks": sorted(
                    [{"code": s.get("Code"), "name": s.get("Name"), "rate": s.get("Rate"),
                      "top": s.get("SetTop") == 1}
                     for s in (x.get("Stocks") or []) if isinstance(s, dict)],
                    key=lambda s: (not s["top"],)),
            } for x in lst]
        else:
            items = [{
                "id": x.get("PID"), "brief": x.get("Brief"), "date": x.get("Date"),
                "tag": x.get("TagName"), "color": x.get("ColorType"),
                "stocks": [{"code": s.get("Code"), "name": s.get("Name"), "rate": s.get("Rate")}
                           for s in (x.get("Stocks") or []) if isinstance(s, dict)],
            } for x in lst]
        return {"items": items, "index": index, "has_more": len(lst) >= st}

    _themedet_stale: dict = {}
    _themedet_refreshing: set = set()
    _themedet_disk_loaded = False
    _themedet_disk_last: float = 0.0

    def get_fengkou(self, day: str = "") -> Dict[str, Any]:
        """市场风口（App 下钻页同源 StockFengKData/GetFengKList）。
        ⭐ App 真实参数（2026-09-28 mitmproxy 抓包）：域=apphis.kaipanla.com（HIS 系），
        biz={Index:0, st:500, Order:17, **Day:YYYYMMDD 无横线, Time:"1500"**(回放时刻=收盘快照)}。
        Day 缺省时 App 由客户端定位最近交易日——插件同样从今天往回找（最多 7 天，跳过周末，
        节假日自动落空到下一候选）。历史深度实测 ≥09-22（546 条）。
        响应 List 条目：[代码,名称,"0",涨跌幅,0,主力买入,主力卖出(-负),主力净额,风口概念,0,
        标签(基金/游资),概念,上榜时间戳]；本地按主力净额降序重排+按代码去重。"""
        key = f"fengkou:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        got = None
        if not day:
            # 盘中实时（App 同款）：apphwhq 域 无 Day 无 Time，返回今日推送
            d = self.call(HOST_HQ2, "StockFengKData", "GetFengKList",
                          {"Index": "0", "st": "500", "Order": "17"}, authed=False)
            got = d if (d or {}).get("List") else None
        # 历史日期（App 同款）：apphis 域 + Day 无横线 + Time=1500 收盘快照
        if not got and day:
            d = self.call("https://apphis.kaipanla.com/w1/api/index.php", "StockFengKData",
                          "GetFengKList",
                          {"Index": "0", "st": "500", "Order": "17",
                           "Day": day.replace("-", ""), "Time": "1500"}, authed=False)
            got = d if (d or {}).get("List") else None
        if not got:
            return {"rows": [], "day": day, "day_arr": [], "total": 0}
        lst = got.get("List") or []
        rows, seen = [], set()
        for r in lst:
            if not isinstance(r, (list, tuple)) or len(r) < 13:
                continue
            code = str(r[0])
            if code in seen:
                continue
            seen.add(code)
            try:
                net = float(r[7])
            except Exception:
                net = 0.0
            try:
                rate = float(r[3])
            except Exception:
                rate = None
            rows.append({"code": code, "name": str(r[1]), "rate": rate,
                         "net": net, "concept": str(r[8] or ""),
                         "tag": str(r[10] or ""), "ts": r[12]})
        rows.sort(key=lambda r: -r["net"])
        day_s = str(got.get("Day") or day or "")   # 回看请求日兜底（曾引用未定义 used_day，NameError 被 homefeed 吞掉表现为"模块无数据"）
        if len(day_s) == 8:
            day_s = f"{day_s[:4]}-{day_s[4:6]}-{day_s[6:]}"
        out = {"rows": rows, "day": day_s, "day_arr": (got or {}).get("DayArr") or [],
               "total": (got or {}).get("Count") or len(rows)}
        if rows:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_daban(self) -> Dict[str, Any]:
        """风向标（App 首页风向标模块+打板页顶部情绪条 同源 Index/GetInfo）：
        CWeatherVaneList = 风向标 6 卡（SZ 上涨 3 + XD 下跌 3，[代码,名称,涨幅,板块]）；
        DaBanList = 打板情绪条（涨停板/封板率/跌停股 今日/昨日 + 涨跌家数/量能）。"""
        key = "daban"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        d = self._getinfo_full()
        cw = d.get("CWeatherVaneList") or {}
        db = d.get("DaBanList") or {}

        def norm(items):
            out = []
            for r in items or []:
                if isinstance(r, (list, tuple)) and len(r) >= 4:
                    out.append({"code": str(r[0]), "name": str(r[1]),
                                "rate": r[2], "plate": str(r[3] or "")})
            return out

        data = {
            "sz": norm(cw.get("SZ")),           # 上涨风向标 3
            "xd": norm(cw.get("XD")),           # 下跌风向标 3
            "head": {
                "zt": [db.get("tZhangTing"), db.get("lZhangTing")],      # 涨停板 今/昨
                "fbl": [db.get("tFengBan"), db.get("lFengBan")],         # 封板率% 今/昨
                "dt": [db.get("tDieTing"), db.get("lDieTing")],          # 跌停股 今/昨
                "szjs": db.get("SZJS"), "xdjs": db.get("XDJS"),          # 涨/跌家数
                "szln": db.get("szln"), "qscln": db.get("qscln"),        # 沪/沪深量能
            },
            "day": d.get("Day") or "", "source": "getinfo",
        }
        if data.get("sz") or data.get("xd") or data.get("head", {}).get("zt", [None])[0]:
            self._cache[key] = {"data": data, "ts": time.time()}
        return data

    def _getinfo_full(self, max_age: float = 60.0) -> Dict[str, Any]:
        """Index/GetInfo View 全量（App 打板页高频轮询同款接口）：
        BaceFaceList(近期活跃板块) / CWeatherVaneList(风向标 SZ+XD) / DaBanList(打板情绪条) /
        ZQFKList(最强风口) / PLZList(严重异动) 等。缓存 60s（对齐 App 轮询节奏）。"""
        now = time.time()
        c = getattr(self, "_getinfo_cache", None)
        if c and now - c[0] < max_age:
            return c[1]
        d = self.call(HOST_HQ2, "Index", "GetInfo",
                      {"View": "1,2,3,4,5,6,7,8,9,10,11"}, authed=False) or {}
        self._getinfo_cache = (now, d)
        return d

    def _active_plates_raw(self):
        """近期活跃板块原始数据：Index/GetInfo 的 BaceFaceList（App 同源恒 4 条）。"""
        d = self._getinfo_full()
        return d.get("BaceFaceList") or []

    def get_sector_detail(self, plate_id: str) -> Dict[str, Any]:
        """板块详情（App 近期活跃板块点入的页面，VNA=803037 这类 801/803 板块）。
        数据：2501 股票池 + BaceFaceList 板块涨幅。
        ⭐ quotas 列锚定（2026-09-27 用 App 概要值逐列求和自校准实锤）：
          q1=现价 q2=涨跌% q3=成交额 q4=换手率 q9=主力净额 q21=涨停封单。
        App 概要的强度/排名/大单封单无数据源，如实缺席；默认按涨幅降序（用户要求）。"""
        pid = str(plate_id)
        key = f"sectordet:{pid}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        out: Dict[str, Any] = {"plateId": pid}
        rate = None
        for n, r, p in self._active_plates_raw():
            if str(p) == pid:
                out["name"] = n
                rate = float(r)
                break
        out.setdefault("name", "")
        out["rate"] = rate
        # 股票池（2501）
        import kpl_socket as _ks
        alive = self._themedet_quotes_alive()
        stocks: List[Dict[str, Any]] = []
        if alive:
            try:
                pool = _ks.get_kpl_socket().get_sector_pool(pid, quota_type=2, count=100)
                for it in (pool or {}).get("items") or []:
                    q = it.get("quotas") or []
                    code = str(it.get(1) or "")
                    nm = str(it.get(2) or "")
                    if not nm:
                        # 名称缺失兜底两级：插件名称缓存 → market_pool 全 A 股名称表
                        nm = self._remember_name("stocks", code, "")
                        if not nm:
                            try:
                                from screener import market_pool
                                nm = market_pool.get_name(code)
                                if nm:
                                    self._remember_name("stocks", code, nm)
                            except Exception:
                                pass
                    try:
                        rate_v = float(q[2]) if len(q) > 2 else None
                    except Exception:
                        rate_v = None
                    row = {"code": code, "name": nm, "price": q[1] if len(q) > 1 else "",
                           "rate": rate_v,
                           "amount": q[3] if len(q) > 3 else "",
                           "mainNet": q[9] if len(q) > 9 else "",
                           "ztSeal": q[21] if len(q) > 21 else ""}
                    stocks.append(row)
                    if nm:
                        self._remember_name("stocks", code, nm)
                if stocks:
                    self._flush_names()
                    # App 默认：涨幅降序
                    stocks.sort(key=lambda s: (s.get("rate") is None,
                                               -(s["rate"] or 0)), )
            except Exception as e:
                logger.debug(f"板块详情 2501 失败({pid}): {e}")
        else:
            out["pool_pending"] = True
        # 概要（与 App 对齐：涨幅/涨停数/主力净额/涨停封单/成交额；由池内数据推导）
        if stocks:
            def _f(v):
                try:
                    return float(v)
                except Exception:
                    return 0.0
            out["summary"] = {
                "stock_num": len(stocks),
                "rate": rate,
                "zt_num": sum(1 for s in stocks
                              if isinstance(s.get("rate"), (int, float)) and s["rate"] >= 9.8),
                "main_net": round(sum(_f(s.get("mainNet")) for s in stocks) / 1e8, 2),
                "zt_seal": round(sum(_f(s.get("ztSeal")) for s in stocks) / 1e8, 2),
                "amount_sum": round(sum(_f(s.get("amount")) for s in stocks) / 1e8, 2),
            }
        out["stocks"] = stocks
        self._cache[key] = {"data": out, "ts": time.time()}
        return out

    # ---------- 行情·直播页播报流（App MarketLiveFragment 1:1，2026-10-03 逆向）----------
    # App 机制实锤：LiveNewsEntity 仅 {time,comment}；播报下的关联股 chips=客户端文本匹配
    # 本地 STOCK 表(13843 名称)+板块名，涨跌幅取内存快照。插件同款：market_pool 5247 全A +
    # kpl_plate_names 1568 板块 反向索引匹配，匹配股并发拉 GetStockPanKou（App 同源）。
    _news_index: List = []   # [name_idx(名称→code), plate_idx(名称→id)] 懒加载

    def _news_name_index(self):
        # ⚠️ 空索引不缓存（后端刚启动时 market_pool 预热未完成，[{},{}] 是 truthy——曾致匹配永远落空）
        if KplClient._news_index and KplClient._news_index[0]:
            return KplClient._news_index
        name_idx = {}
        try:
            from screener import market_pool
            # ⚠️ 勿持 market_pool._lock 遍历：pytdx 断连重试循环会长期持锁（实测死等 60s+）。
            names_snapshot = dict(market_pool._names or {})
            for code, nm in names_snapshot.items():
                if nm and len(nm) >= 2:
                    name_idx[nm] = code
        except Exception as e:
            logger.debug(f"livenews 个股索引: {e}")
        if not name_idx:
            # 兜底：随插件打包的 App KPL_CACHE STOCK 名称表（13690 条，App 同源，
            # 2026-10-03 导出）——market_pool 依赖东财名称接口，限流期恒空（实测）。
            try:
                import os
                pth = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "static", "kpl_stock_names.json")
                if os.path.exists(pth):
                    packed = json.loads(open(pth, encoding="utf-8").read())
                    # 打包表是 {code: name}——反转成 名称→code
                    for code, nm in packed.items():
                        if nm and len(nm) >= 2:
                            name_idx[nm] = code
                    logger.info(f"livenews 名称索引用打包表 n={len(name_idx)}")
            except Exception as e:
                logger.info(f"livenews 打包名称表读失败: {e}")
        plate_idx = {}
        try:
            from storage import storage as _st
            pth = _st.data_dir / "kpl_plate_names.json"
            if pth.exists():
                dj = json.loads(pth.read_text(encoding="utf-8"))
                # 结构：{ts, names:{id: name}}（801/885 系板块名）
                for pid, nm in (dj.get("names") or {}).items():
                    if nm and len(nm) >= 2:
                        plate_idx[nm] = pid
        except Exception as e:
            logger.debug(f"livenews 板块索引: {e}")
        if name_idx:
            KplClient._news_index = [name_idx, plate_idx]
            return KplClient._news_index
        return [name_idx, plate_idx]

    def _pankou_batch(self, codes: List[str]) -> Dict[str, Any]:
        """并发拉 GetStockPanKou 取涨跌幅（App 同源；绕 _rate_wait——App 无域间隔，
        仅对匹配到的股票一次批量+磁盘缓存，量级 ~100 只）。"""
        out = {}
        if not codes:
            return out

        def one(code):
            try:
                data = {**self._common(False), "c": "StockL2Data",
                        "a": "GetStockPanKou", "StockID": code}
                r = self._get_client().post(HOST_HQ, data=data, timeout=8)
                d = r.json()
                real = (d or {}).get("real") or {}
                rate = real.get("px_change_rate")
                return code, (round(float(rate), 2) if rate is not None else None)
            except Exception:
                return code, None

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as ex:
            for code, rate in ex.map(one, codes):
                out[code] = rate
        return out

    def get_live_news_feed(self, day: str = "") -> Dict[str, Any]:
        """直播页播报流。休市当日数据不变→磁盘缓存秒回；盘中 TTL 120s 重建。
        首次构建（并发 PanKou ~10s）走后台线程，先返回 building 标志由前端重拉。"""
        day = self._mood_norm_day(day)
        key = f"livenews:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 120:
            return hit["data"]
        try:
            from storage import storage as _st
            pth = _st.data_dir / "kpl_livenews_cache.json"
        except Exception:
            pth = None
        if pth is not None and pth.exists():
            try:
                dj = json.loads(pth.read_text(encoding="utf-8"))
                if dj.get("day") == day and time.time() - dj.get("ts", 0) < 7 * 86400:
                    self._cache[key] = {"data": dj["data"], "ts": time.time()}
                    return dj["data"]
            except Exception as e:
                logger.debug(f"livenews 磁盘读: {e}")
        building = {"building": True, "day": day, "items": []}
        if getattr(KplClient, "_news_building", False):
            return building
        KplClient._news_building = True

        def _bg():
            try:
                logger.info(f"livenews 构建 start day={day}")
                d = self.call("https://apphis.kaipanla.com/w1/api/index.php",
                              "HisMarketSentiment", "GetLiveNews", {"date": day}, False)
                raw = (d or {}).get("list") or []
                logger.info(f"livenews GetLiveNews rows={len(raw)}")
                name_idx, plate_idx = self._news_name_index()
                if not name_idx:
                    # market_pool 预热未完成：本轮不出缓存，等下轮前端重拉
                    KplClient._news_building = False
                    return
                # 权重板块涨幅表（App chips 板块涨幅同源：WeightPerformance SZ/XD）
                wpct = {}
                try:
                    wt = self.call("https://apphis.kaipanla.com/w1/api/index.php",
                                   "HisHomeDingPan", "WeightPerformance", {"Day": day}, False)
                    info = (wt or {}).get("info") or {}
                    for row in (info.get("SZ") or []) + (info.get("XD") or []):
                        if isinstance(row, list) and len(row) >= 3:
                            wpct[str(row[1])] = row[2]
                except Exception:
                    pass
                items = []
                codes = set()
                parsed = []
                import re as _re
                for it in raw:
                    cm = str(it.get("comment") or "")
                    stocks, plates = [], []
                    for nm, code in name_idx.items():
                        # 只收 A 股 6 位数字代码（打包表含全球期汇/港美股，"风电"等简称会误命中）
                        if nm in cm and _re.match(r"^\d{6}$", str(code)):
                            stocks.append({"code": code, "name": nm})
                            codes.add(code)
                    for nm, pid in plate_idx.items():
                        if nm in cm:
                            plates.append({"id": pid, "name": nm,
                                           "pct": wpct.get(nm)})
                    parsed.append({"time": it.get("time"), "comment": cm,
                                   "stocks": stocks, "plates": plates})
                logger.info(f"livenews 匹配完成 codes={len(codes)} items={len(parsed)}")
                pmap = self._pankou_batch(sorted(codes)) if codes else {}
                logger.info(f"livenews pankou done n={len(pmap)}")
                for p in parsed:
                    for st_ in p["stocks"]:
                        st_["pct"] = pmap.get(st_["code"])
                    p["stocks"] = sorted(p["stocks"], key=lambda x: -abs(x["pct"] or 0))[:16]
                    p["plates"] = p["plates"][:6]
                    items.append(p)
                data = {"day": day, "items": items, "building": False}
                self._cache[key] = {"data": data, "ts": time.time()}
                try:
                    tmp = pth.with_suffix(".tmp")
                    tmp.write_text(json.dumps({"ts": time.time(), "day": day,
                                               "data": data}, ensure_ascii=False), encoding="utf-8")
                    tmp.replace(pth)
                except Exception as e:
                    logger.debug(f"livenews 磁盘写: {e}")
            except Exception as e:
                import traceback
                logger.info("livenews 构建异常: {} | {}".format(e, traceback.format_exc()))
            finally:
                KplClient._news_building = False

        threading.Thread(target=_bg, daemon=True).start()
        return building

    def get_stock_detail_extras(self, code: str, day: str = "") -> Dict[str, Any]:
        """个股详情页大 tab 数据（2026-10-03 逆向 ox0 实锤，接口全部一次实测通）：
        - 涨停原因历史 = LimitResumption(His)/KLineZhangTingReason{StockID,Date}：reason+bfreason 双段
        - 公司新闻 = CompanyNotice/CorporateNewsStockList{StockID,Index,st} @HIS（List=["id_时间_标题_来源"]）
        - 公告(PDF) = CompanyNotice/CompanyNewsReportList{StockID,Index,st,Type} @HIS（…_PDF链接）
        - 研报 = CompanyNotice/ResearchFieldList{StockID,Type,Index,st} @HIS
        - F10：BigReminderW43(大事提醒)/GetCompanyInfo(公司资料)/GetFinanceInfo(财务) @apparticle
        - 主力监控 = StockYiDongKanPan/StockMainMonitor @HQ——errcode 1018 未订阅（App 同为 VIP 盯盘功能）
        300s 缓存。筹码/逐笔委托/分钟K/区间统计接口未在 HTTP 层定位（StockChip 系实体存在但无 ox0 方法），待盘中抓包。"""
        day = day or self._mood_norm_day("")
        key = f"sdex:{code}:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 300:
            return hit["data"]
        HQ = "https://apphwhq.kaipanla.com/w1/api/index.php"
        HIS = "https://apphis.kaipanla.com/w1/api/index.php"
        ART = "https://apparticle.longhuvip.com/w1/api/index.php"
        from concurrent.futures import ThreadPoolExecutor
        if not KplClient._mood_pool or KplClient._mood_pool[0]._shutdown:
            KplClient._mood_pool = [ThreadPoolExecutor(max_workers=10)]
        pool = KplClient._mood_pool[0]
        futs = {
            "ztrs": pool.submit(self.call, HIS, "HisLimitResumption", "KLineZhangTingReason",
                                {"StockID": str(code), "Date": day}, False),
            "news": pool.submit(self.call, HIS, "CompanyNotice", "CorporateNewsStockList",
                                {"StockID": str(code), "Index": "0", "st": "20"}, False),
            "notice": pool.submit(self.call, HIS, "CompanyNotice", "CompanyNewsReportList",
                                  {"StockID": str(code), "Index": "0", "st": "20", "Type": "0"}, False),
            "research": pool.submit(self.call, HIS, "CompanyNotice", "ResearchFieldList",
                                    {"StockID": str(code), "Type": "0", "Index": "0", "st": "20"}, False),
            "reminder": pool.submit(self.call, ART, "StockF10Basic", "BigReminderW43",
                                    {"StockID": str(code), "Index": "0", "st": "20"}, False),
            "company": pool.submit(self.call, ART, "StockF10Basic", "GetCompanyInfo",
                                   {"StockID": str(code)}, False),
            "finance": pool.submit(self.call, ART, "StockF10Basic", "GetFinanceInfo",
                                   {"StockID": str(code), "State": "1", "Type": "1", "DL": ""}, False),
            "monitor": pool.submit(self.call, HQ, "StockYiDongKanPan", "StockMainMonitor",
                                   {"StockID": str(code), "Money": "300000", "Sort": "1",
                                    "Type": "1", "Order": "0", "Index": "0", "st": "30"}, False),
            # F10 全家桶：GetIndex 一个接口返回 Concept/Topic/Company/Finance/Record/YJPL（2026-10-03 实测定案）
            "f10index": pool.submit(self.call, ART, "StockF10Basic", "GetIndex",
                                    {"StockID": str(code)}, False),
        }
        g = lambda k: futs[k].result()
        def _list3(d):
            rows = []
            for it in ((d or {}).get("List") or []):
                if isinstance(it, list):
                    rows.append(it)
                elif isinstance(it, str):
                    rows.append(it.split("_"))
            return rows
        out = {
            "day": day, "code": code,
            "ztrs": (g("ztrs") or {}).get("info") or None,
            "news": _list3(g("news")),
            "notices": _list3(g("notice")),
            "research": _list3(g("research")),
            "reminder": (g("reminder") or {}).get("info") or [],
            "company": ((g("company") or {}).get("List") or {}),
            "finance": _list3(g("finance")),
            "monitor_vip": True,
            # ⭐ GetIndex 数据在顶层（无 info 包裹，实测；与 ox0 其它接口相反）
            "f10index": g("f10index") or {},
        }
        if out["ztrs"] or out["news"]:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_plate_extras(self, plate_id: str, day: str = "") -> Dict[str, Any]:
        """板块详情下钻增强数据（2026-10-03 逆向 IndexQuotaTLinePresenter/IndexQuotationActivity）：
        - 概要 8 项 = ZhiShuRanking/GetPlate_Info_QJ{PlateID}（List=[排名,强度,成交额,涨停数,?,涨停封单,大单封单,?]，
          09-30 实测强度 -174 与 App 逐位、成交额 59685254552=596.85 亿逐位）+ ZhiShuL2Data/GetPlateZF{StockID,Day}(涨幅因子)
        - 分时 = ConceptionPoint/BKFenShiZhiBo{PlateID}（盘中直播分钟点，盘后空=App 亦靠本地缓存；
          当日分钟订阅=socket 2202，10-08 盘中接入）
        - 机构纪要 = Theme/InfoBKR{ZSCode} @applhb（实测 errcode=0）
        60s 缓存。"""
        day = self._mood_norm_day(day)
        key = f"plateextras:{plate_id}:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        HQ = "https://apphwhq.kaipanla.com/w1/api/index.php"
        HIS = "https://apphis.kaipanla.com/w1/api/index.php"
        LHB = "https://applhb.kaipanla.com/w1/api/index.php"
        from concurrent.futures import ThreadPoolExecutor
        if not KplClient._mood_pool or KplClient._mood_pool[0]._shutdown:
            KplClient._mood_pool = [ThreadPoolExecutor(max_workers=8)]
        pool = KplClient._mood_pool[0]
        futs = {
            "qj": pool.submit(self.call, HQ, "ZhiShuRanking", "GetPlate_Info_QJ",
                              {"PlateID": str(plate_id), "RStart": "", "REnd": ""}, False),
            "zf": pool.submit(self.call, HIS, "ZhiShuL2Data", "GetPlateZF",
                              {"StockID": str(plate_id), "Day": day}, False),
            "fenshi": pool.submit(self.call, HQ, "ConceptionPoint", "BKFenShiZhiBo",
                                  {"PlateID": str(plate_id)}, False),
            "bkr": pool.submit(self.call, LHB, "Theme", "InfoBKR", {"ZSCode": str(plate_id)}, False),
        }
        g = lambda k: futs[k].result()
        qj = (g("qj") or {}).get("List") or []
        def _num(i):
            try:
                v = qj[i]
                return None if v == "--" else v
            except Exception:
                return None
        out = {
            "day": day,
            "qj": {
                "rank": _num(0),
                "strength": _num(1),
                "amount": _num(2),
                "zt_num": _num(3),
                "main_net": _num(4),
                "zt_seal": _num(5),
                "big_seal": _num(6),
            } if qj else None,
            "zf": (g("zf") or {}).get("ZF"),
            "fenshi": {"list": (g("fenshi") or {}).get("list") or [],
                       "date": (g("fenshi") or {}).get("date")},
            "bkr": g("bkr") or {},
            "pending": {"fenshi_live": True,
                        "note": "分时为盘中直播推送(2202 订阅+HTTP 初拉)，盘后无数据=App 同款读本地缓存；K线=socket 2400/2402 盘后静默待盘中"},
        }
        self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_theme_detail(self, news_id) -> Dict[str, Any]:
        """主题详情（点击最新主题条目）：ThemeNews/GetInfo（apparticle）。
        含标题/时间/HTML正文/主题介绍卡(ZSCode/ZSName/ZSDesc)/关联个股(带Desn公司简介)"""
        d = self.call(HOST_ART, "ThemeNews", "GetInfo",
                      {"NewsID": str(news_id), "Type": "0"}, authed=False)
        info = (d or {}).get("Info") or {}
        return {
            "id": info.get("CID"), "title": info.get("Title"), "source": info.get("Source"),
            "time": info.get("TimeStamp"), "content": info.get("Content"),
            "theme": {"code": info.get("ZSCode"), "name": info.get("ZSName"),
                      "desc": info.get("ZSDesc")},
            "stocks": [{"code": s.get("Code"), "name": s.get("Name"),
                        "rate": s.get("Rate"), "desc": s.get("Desn")}
                       for s in (info.get("Stocks") or []) if isinstance(s, dict)],
        }

    # ---------- 题材库（Socket 通道：内置 unidbg 签名器 + 插件内 socket 客户端，无外部依赖） ----------

    def get_themes_socket(self, force: bool = False) -> Dict[str, Any]:
        """题材库全列表（cmd=3009, 实时热度/涨停数/涨幅，服务端 raw 序=热度降序）。
        签名器不可用时 error 提示（需 Java 8+，部署物 backend/signer/）"""
        if force:
            self.invalidate("themesock")
        hit = self._cache.get("themesock")
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]

        def _fetch():
            import kpl_socket
            raw = kpl_socket.get_kpl_socket().get_themes()
            if raw is None:
                return {"error": "socket 通道不可用（内置签名需 Java 8+；确认 backend/signer/ 完整）",
                        "items": []}
            items = [{
                "id": str(t.get("id", "")), "name": t.get("name", ""),
                "pinyin": t.get("pinyin", ""), "hot": t.get("hot", 0),
                "zt_num": t.get("zt_num", 0), "pct": t.get("pct", 0),
                "is_hot": t.get("is_hot", 0), "up_num": t.get("up_num", 0),
                "concepts": t.get("concepts") or [],
            } for t in raw]
            # 名称缓存合并：新名登记，缺名用本地缓存补（App KPL_CACHE 同机制）
            for it in items:
                fixed = self._remember_name("themes", it.get("id"), it.get("name") or "")
                if fixed and not it.get("name"):
                    it["name"] = fixed
            items.sort(key=lambda x: x.get("hot") or 0, reverse=True)
            self._flush_names()
            return {"items": items}

        data = _fetch()
        if data.get("items"):
            self._cache["themesock"] = {"data": data, "ts": time.time()}
            # 磁盘层（App 同款）：休市日/会话异常时秒显最近列表
            try:
                from storage import storage as _st
                tmp = (_st.data_dir / "kpl_tika_cache.json").with_suffix(".tmp")
                tmp.write_text(json.dumps({"ts": time.time(),
                                           "data": data}, ensure_ascii=False), encoding="utf-8")
                tmp.replace(_st.data_dir / "kpl_tika_cache.json")
            except Exception as e:
                logger.debug(f"tika 磁盘缓存写: {e}")
        else:
            try:
                from storage import storage as _st
                pth = _st.data_dir / "kpl_tika_cache.json"
                if pth.exists():
                    dj = json.loads(pth.read_text(encoding="utf-8"))
                    if dj.get("data", {}).get("items") and time.time() - dj.get("ts", 0) < 7 * 86400:
                        data = dict(dj["data"])
                        data["stale"] = True
            except Exception as e:
                logger.debug(f"tika 磁盘缓存读: {e}")
        return data

    # ---- 人气榜（cmd 3008；实现见下方 get_pop_rank，含 SWR 陈旧缓存）----

    # SWR 陈旧缓存：socket 会话被互踢/重连时单次拉取可达 40s+，绝不能让前端干等
    # （2026-09-26 "盘中/飙升视图无数据"反馈的根因就是拉取太慢）。内存 + 磁盘双层：
    # 磁盘层让后端重启后依然能秒回六个视图的最近一次成功数据。
    _pop_stale: dict = {}
    _pop_refreshing: set = set()
    _pop_disk_loaded = False

    @staticmethod
    def _pop_disk_path():
        from storage import storage as _st
        return _st.data_dir / "kpl_pop_cache.json"

    def _load_pop_disk(self) -> None:
        """启动后首次使用时加载磁盘陈旧缓存（内存里已有的以较新者为准）"""
        if self._pop_disk_loaded:
            return
        self._pop_disk_loaded = True
        try:
            d = json.loads(self._pop_disk_path().read_text(encoding="utf-8"))
            for k, v in (d or {}).items():
                old = self._pop_stale.get(k)
                if not old or v.get("ts", 0) > old.get("ts", 0):
                    self._pop_stale[k] = v
        except Exception:
            pass

    def _save_pop_disk(self, key: str, data: Dict[str, Any]) -> None:
        # ⚠️ 高频写盘会触发杀软实时扫描挂起整个进程（2026-09-27 实测每 30-60s 一波
        # 10-40s 的全后端冻结，与写盘频率吻合）——磁盘层仅作崩溃恢复，防抖 5 分钟一写
        try:
            now = time.time()
            if now - getattr(self, "_pop_disk_last", 0.0) < 300:
                return
            self._pop_disk_last = now
            p = self._pop_disk_path()
            try:
                cur = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                cur = {}
            cur[key] = {"data": data, "ts": now}
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(cur, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, p)
        except Exception as e:
            logger.debug(f"poprank 磁盘缓存写入失败: {e}")

    def get_pop_rank(self, type_: int = 1, order: int = 1, start: int = 0,
                     count: int = 50, use_cache: bool = True) -> Dict[str, Any]:
        """人气榜（cmd 3008，App 同源）。
        ⭐ type 是「tab+排序」联合编码（2026-09-26 字节码实锤 IntradayPopularityListFragment.Jg/Kg）：
          盘中 tab 三排序 = 1/2/16，复盘 tab 三排序 = 13/14/17（默认视图=1/13）。
          13/14/17 为服务端实时序列，盘后仍成组更新（分钟级），短连接直拉即与 App 一致。
        order：App 初始进页传 2、点排序胶囊后传 1，实测两者返回内容一致，固定用 1。
        type<=3 响应才带 five_minute_items（5分钟急升条），13/14/17 亦携带但 App 不解析。
        缓存：30s 新鲜 + SWR 陈旧兜底（内存+磁盘；有旧值立即返回并后台刷新，标 stale=true，
        7 天内有效——超过 7 天视为过期数据不再返回）。
        返回 {items, five_minute_items, day, timestamp}。"""
        key = f"poprank:{type_}:{order}:{start}:{count}"
        hit = self._cache.get(key)
        if use_cache and hit and time.time() - hit["ts"] < 30:
            return hit["data"]

        def _fetch():
            import kpl_socket
            raw = kpl_socket.get_kpl_socket().get_pop_rank(type_, order, start, count)
            if raw is None:
                return {"error": "人气榜获取失败（socket 通道不可用）", "items": [], "five_minute_items": []}
            for it in (raw.get("items") or []) + (raw.get("five_minute_items") or []):
                fixed = self._remember_name("stocks", it.get("code"), it.get("name") or "")
                if fixed and not it.get("name"):
                    it["name"] = fixed
            self._flush_names()
            return raw

        self._load_pop_disk()
        stale = self._pop_stale.get(key)
        if use_cache and stale and time.time() - stale.get("ts", 0) < 7 * 86400:
            if key not in self._pop_refreshing:
                self._pop_refreshing.add(key)
                threading.Thread(target=self._pop_refresh_bg,
                                 args=(key, type_, order, start, count),
                                 daemon=True, name=f"kpl-pop-swr-{type_}").start()
            return {**stale["data"], "stale": True}

        data = _fetch()
        if data.get("items"):
            self._cache_set(key, data)
        elif stale:
            return {**stale["data"], "stale": True}
        return data

    def _cache_set(self, key: str, data: Dict[str, Any]) -> None:
        now = time.time()
        self._cache[key] = {"data": data, "ts": now}
        self._pop_stale[key] = {"data": data, "ts": now}
        self._save_pop_disk(key, data)

    def _pop_refresh_bg(self, key: str, type_: int, order: int, start: int, count: int) -> None:
        try:
            self.get_pop_rank(type_, order, start, count, use_cache=False)
        except Exception as e:
            logger.debug(f"poprank SWR 后台刷新失败 {key}: {e}")
        finally:
            self._pop_refreshing.discard(key)

    def prewarm_poprank(self) -> None:
        """启动预热人气榜全部视图（默认视图优先），顺序执行共用一条 socket 会话。
        预热后前端任意 tab/排序首点即命中缓存秒开。"""
        for t in (13, 1, 14, 17, 2, 16):
            try:
                self.get_pop_rank(t, 1, 0, 50)
            except Exception as e:
                logger.debug(f"poprank 预热 type={t}: {e}")
            time.sleep(1)

    def prewarm_themes(self) -> None:
        """预热题材库列表 + 前 5 热门题材详情（用户最常点的题材，进详情页秒开）。
        与 poprank 预热同线程串行调用（共用 socket 会话锁，避免并行竞争）。"""
        try:
            ths = self.get_themes_socket() or []
            for t in ths[:5]:
                try:
                    self.get_theme_detail_socket(str(t.get("id")), t.get("name") or "")
                except Exception as e:
                    logger.debug(f"themedet 预热 {t.get('id')}: {e}")
                time.sleep(0.5)
        except Exception as e:
            logger.debug(f"themedet 预热失败: {e}")

    def get_pop_replay(self) -> Dict[str, Any]:
        """复盘人气榜 = type=13（App 复盘 tab 默认视图·热度排名）。
        2026-09-26 证伪旧结论：复盘榜并非"收盘结算瞬态推送、错过后拿不到"，
        而是服务端持续维护的实时序列（ts 成组刷新），当年扫参数只试了 type 1-10
        而漏掉 13-17 才对不上；捕获循环/当日缓存机制已删除。"""
        return self.get_pop_rank(13, 1, 0, 50)

    def get_yidong_index(self, day: str = "", is_zt: int = 0) -> Dict[str, Any]:
        """严重异动提醒独立页列表（GetPianLiZhi_Index {ZDJK_Type:1}@HQ 今日 /
        GetPianLiZhi_Index_W32 {Day,IsZT}@HIS 历史，IsZT=1 只看已触发）。
        行 13 字段：[0]code [1]name [2]口径(1盘中/0收盘) [3]规则全文 [4]当日涨幅 [5]已统计交易日
        [6]累计偏离值% [7]触发提示 [8]触发所需涨幅 [9]? [10]日期 [11]预计触发价 [12]状态文字。
        ⭐ [11] 是预计触发价不是现价（yd8 实拍：善水科技 [11]=36.29=列头「触发异动涨幅股票价格」，
        现价 35.93=[11]/(1+need%)×(1+day_pct%)，旧版把它当现价再乘 (1+need%) 是错的）。"""
        def _fetch():
            if day:
                d = self.call(HOST_HIS, "StockBidYiDong", "GetPianLiZhi_Index_W32",
                              {"Day": day, "IsZT": str(is_zt)}, False)
            else:
                d = self.call(HOST_HQ, "StockBidYiDong", "GetPianLiZhi_Index",
                              {"ZDJK_Type": "1"}, False)
            d = d or {}
            items: Dict[str, Dict[str, Any]] = {}
            order: list = []
            for row in d.get("List") or []:
                if not isinstance(row, list) or len(row) < 13:
                    continue
                code = str(row[0])
                it = {"code": code, "name": row[1], "kind": row[2], "rule": row[3],
                      "day_pct": self._yd_num(row[4]), "days": row[5],
                      "dev": self._yd_num(row[6]), "tip": row[7],
                      "need": self._yd_num(row[8]),
                      "trigger_price": self._yd_num(row[11]), "status": row[12]}
                if code not in items:
                    items[code] = it
                    order.append(code)
                elif it["kind"] == 1:
                    items[code] = it
            lst = [items[c] for c in order]
            for it in lst:
                fixed = self._remember_name("stocks", it["code"], it.get("name") or "")
                if fixed and not it.get("name"):
                    it["name"] = fixed
                # 现价=触发价/(1+need%)×(1+day_pct%)（yd8 实拍善水科技 36.29→35.93、近岸蛋白 164.08→160.39）
                try:
                    need = float(it.get("need") or 0)
                    trig = float(it.get("trigger_price") or 0)
                    dp = float(it.get("day_pct") or 0)
                    if trig and need > -100:
                        it["price"] = round(trig / (1 + need / 100) * (1 + dp / 100), 2)
                except Exception:
                    pass
            self._flush_names()
            return {"day": d.get("Day"), "many_num": d.get("Many_Num"),
                    "zdjk_list": d.get("ZDJKList") or [], "wxhj_list": d.get("WXHJList") or [],
                    "items": lst}
        key = "yd_index" if not day else f"yd_index_{day}_{is_zt}"
        return self._cached_swr(key, 60, _fetch)

    # ============= 龙虎榜（App 底部导航·龙虎榜菜单同源 LongHuBang 控制器 @applhb.kaipanla.com）=============
    # 2026-09-30 全套实测锚定（App 截图逐位比对）：
    #   GetStockList   股票榜（万科Ａ 4.41%/净买 71384560=7138万 ✓，字段 D3=3日榜标）
    #   GetAgencyListV2 机构榜（个股+BuyIn+FengKou 801板块数组；App"机构净买▼"排序）
    #   GetBusinessList 营业部榜（245 席位；中信证券上海分公司 5.03亿/4.73亿/21 ✓）
    #   GetAgencyDayList 机构买卖日明细（SDay/EDay 参数，字节码实锤）→ 机构净买入历史柱状图
    #   GetYiXianByDay 一线游资分组榜（订阅 tab 官方组合同源）
    #   UpdateList 上榜代码清单（增量刷新判定用）
    # App 顶部"今日上榜数" = 各榜行数（股票66/机构31/营业部245，2026-09-30 实测一致）

    def get_lhb(self, day: str = "") -> Dict[str, Any]:
        """龙虎榜三榜合一（股票/机构/营业部 + 机构净买入历史 + 上榜数）。60s 缓存。
        ⭐ 历史回看参数名是 **Time**（App 字节码 j00.G 实锤：GetStockList=
        {Type:"2", Time, Index:"0", st:"500"}；Day 参数会被服务端静默忽略恒返最新——
        2026-10-01 实测 Time=0929 超声电子 4222万 与 App 实拍逐位一致）。
        非交易日（节假日/周末）自动归一到最近前一交易日（深交所日历）。"""
        day = day or time.strftime("%Y-%m-%d")
        try:
            from trade_calendar import get_cal
            if not get_cal().is_trading_day(day):
                prev = get_cal().prev_trading_day(day)
                if prev:
                    day = prev
        except Exception:
            pass
        key = f"lhb:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]

        def _f(d):
            try:
                return float(d)
            except Exception:
                return 0.0

        # 股票榜（App 参数 {Type:"2", Time, Index:0, st:500}，服务端序直出）
        stocks = []
        try:
            d = self.call(HOST_LHB_KPL, "LongHuBang", "GetStockList",
                          {"Type": "2", "Time": day, "Index": "0", "st": "500"},
                          authed=True)
            for it in (d or {}).get("list") or []:
                stocks.append({
                    "id": str(it.get("ID") or ""), "name": str(it.get("Name") or ""),
                    "pct": str(it.get("IncreaseAmount") or ""), "d3": it.get("D3"),
                    "buy_in": _f(it.get("BuyIn")), "join_num": it.get("JoinNum"),
                    "turnover": _f(it.get("Turnover")),
                    "turnover_ratio": it.get("TurnoverRatio"),
                    "amplitude": it.get("Amplitude"),
                    "circ_cap": _f(it.get("CircPrice")),
                    "total_cap": _f(it.get("Capitalization")),
                })
        except Exception as e:
            logger.debug(f"GetStockList: {e}")

        # 风口概念（App 口径 = GetAgencyListV2 的 FengKou 801板块id 体系）。
        # GetStockList 不带概念；GetFengKList 的"风口概念"串与 App 龙虎榜概念口径不同（实测
        # 襄阳轴承：FengKou=机器人概念/汽车零部件，风口串=新能源汽车——弃用，宁缺勿错）。
        # GetAgencyListV2 在下方机构榜处统一拉取（concept_map 同时供股票榜复用）。

        # 机构榜（App 按"机构净买▼"排序 → 本地 BuyIn 降序）+ 概念表（FengKou 801id 翻译）
        agencies = []
        concept_map: Dict[str, str] = {}
        try:
            d = self.call(HOST_LHB_KPL, "LongHuBang", "GetAgencyListV2",
                          {"Time": day, "Index": "0", "st": "500"}, authed=True)
            plate_names = self._active_plate_names()
            for it in (d or {}).get("List") or []:
                fk = it.get("FengKou") or []
                names = [plate_names.get(str(p), "") for p in
                         (fk if isinstance(fk, list) else [fk])]
                txt = "/".join([n for n in names if n][:2])
                sid = str(it.get("ID") or "")
                if txt:
                    concept_map[sid] = txt
                agencies.append({
                    "id": sid, "name": str(it.get("Name") or ""),
                    "day": it.get("Day"), "buy_in": _f(it.get("BuyIn")),
                    "join_num": it.get("JoinNum"),
                    "pct": str(it.get("IncreaseAmount") or ""),
                    "concept": txt,
                })
            agencies.sort(key=lambda r: -r["buy_in"])
        except Exception as e:
            logger.debug(f"GetAgencyListV2: {e}")
        for s in stocks:
            s["concept"] = concept_map.get(s["id"], "")

        # 营业部榜（App 按"买入▼"排序 → 本地 Buy 降序；历史用 Time 参数）
        business = []
        try:
            d = self.call(HOST_LHB_KPL, "LongHuBang", "GetBusinessList",
                          {"Time": day}, authed=True)
            for it in (d or {}).get("list") or []:
                business.append({
                    "id": str(it.get("ID") or ""), "name": str(it.get("Name") or ""),
                    "buy": _f(it.get("Buy")), "sell": _f(it.get("Sell")),
                    "join_num": it.get("JoinNum"),
                })
            business.sort(key=lambda r: -r["buy"])
        except Exception as e:
            logger.debug(f"GetBusinessList: {e}")

        # 机构净买入历史（近 90 个自然日，柱状图数据）
        try:
            sday = (datetime.datetime.strptime(day, "%Y-%m-%d")
                    - datetime.timedelta(days=90)).strftime("%Y-%m-%d")
            agency_days = self.get_lhb_agency_days(sday, day)
        except Exception:
            agency_days = []

        out = {"day": day,
               "counts": {"stock": len(stocks), "agency": len(agencies),
                          "business": len(business)},
               "stocks": stocks, "agencies": agencies, "business": business,
               "agency_days": agency_days,
               "agency_net": round(sum(r["buy_in"] for r in agencies), 2)}
        if stocks or business or agencies:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_lhb_agency_days(self, sday: str, eday: str) -> List[Dict[str, Any]]:
        """机构买卖日明细（GetAgencyDayList，SDay/EDay）→ 按日聚合净买（柱状图）"""
        try:
            d = self.call(HOST_LHB_KPL, "LongHuBang", "GetAgencyDayList",
                          {"SDay": sday, "EDay": eday}, authed=True)
        except Exception as e:
            logger.debug(f"GetAgencyDayList: {e}")
            return []
        by_day: Dict[str, float] = {}
        for it in (d or {}).get("List") or []:
            day = str(it.get("Day") or "")
            try:
                by_day[day] = by_day.get(day, 0.0) + float(it.get("BuyIn") or 0)
            except Exception:
                continue
        return [{"day": k, "net": round(v, 2)} for k, v in sorted(by_day.items())]

    def get_lhb_yixian(self, day: str = "") -> List[Dict[str, Any]]:
        """一线游资分组榜（GetYiXianByDay，订阅 tab 官方组合同源）"""
        day = day or time.strftime("%Y-%m-%d")
        key = f"lhbyx:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        try:
            d = self.call(HOST_LHB_KPL, "LongHuBang", "GetYiXianByDay",
                          {"Time": day}, authed=True)
        except Exception as e:
            logger.debug(f"GetYiXianByDay: {e}")
            return []
        groups = []
        for g in (d or {}).get("List") or []:
            stocks = [{"id": str(s.get("ID") or ""), "name": str(s.get("Name") or ""),
                       "money": s.get("Money"), "pct": str(s.get("IncreaseAmount") or ""),
                       "num": s.get("Num"), "d3": s.get("D3")}
                      for s in (g.get("List") or []) if isinstance(s, dict)]
            groups.append({"id": str(g.get("ID") or ""), "name": str(g.get("Name") or ""),
                           "stocks": stocks})
        if groups:
            self._cache[key] = {"data": groups, "ts": time.time()}
        return groups

    def _active_plate_names(self) -> Dict[str, str]:
        """801/803 板块id → 名称（FengKou 概念翻译用）。
        主源：`kpl_plate_names.json` 官方名表（KPL_CACHE STOCK 表 TYPE=1 板块行 1568 条，
        2026-09-30 从 App 数据库导出；板块名稳定不过期）。文件缺失时后台
        _build_plate_names 遍历构建（行业种子 × SonPlate_Info 子概念）。"""
        cache = getattr(self, "_plate_name_cache", None)
        if cache is not None:
            return cache
        names: Dict[str, str] = {}
        # ① 官方名表（无过期：板块名不变）
        try:
            from storage import storage as _st
            p = _st.data_dir / "kpl_plate_names.json"
            if p.exists():
                sn = json.loads(p.read_text(encoding="utf-8"))
                names.update({str(k): str(v) for k, v in (sn.get("names") or {}).items()})
        except Exception:
            pass
        # ② 即时部分（官方表缺失时的兜底）
        try:
            for nm, _r, pid in self._active_plates_raw():
                names.setdefault(str(pid), str(nm))
        except Exception:
            pass
        self._plate_name_cache = names
        # ③ 全表缺失才后台构建
        if len(names) < 100:
            threading.Thread(target=self._build_plate_names, daemon=True,
                             name="kpl-plate-names").start()
        return names

    def _build_plate_names(self) -> None:
        """构建 801/803 板块名表：已知行业种子 × SonPlate_Info{PlateID}（返回该行业
        子概念 [id,名称,强度] 列表）→ 概念级 {id: name}。
        ⚠️ PlateTCConfig 的 58 个 id 是无子板块的另一族（实测 SonPlate 全空），不可作种子。
        种子=实拍/接口已确认的行业 id（锂电池 801004/医药 801045/芯片 801001…），
        一层遍历 ~40 请求覆盖当日 FengKou 概念绝大多数；落盘 7 天重建。"""
        if getattr(self, "_plate_names_building", False):
            return
        self._plate_names_building = True
        try:
            seeds = [ "801001", "801004", "801005", "801007", "801008", "801014",
                      "801027", "801029", "801033", "801035", "801045", "801058",
                      "801065", "801067", "801072", "801087", "801104", "801111",
                      "801114", "801116", "801122", "801123", "801128", "801136",
                      "801146", "801155", "801156", "801157", "801159", "801162",
                      "801166", "801177", "801181", "801196", "801198", "801199",
                      "801218", "801224", "801235", "801250", "801256", "801258",
                      "801273", "801301", "801314", "801328", "801350", "801351",
                      "801375", "801399", "801430", "801433", "801437", "801445",
                      "801460", "801511", "801519", "801522", "801529", "801546",
                      "801580", "801584", "801587", "801629", "801631", "801642",
                      "801657", "801660", "801694", "801718", "801722", "801723",
                      "801725", "801760", "801807", "801827", "801829", "801871",
                      "801874", "801880", "801881", "801886", "801932" ]
            names: Dict[str, str] = {}
            for pid in seeds:
                try:
                    r = self.call("https://apphwshhq.longhuvip.com/w1/api/index.php",
                                  "ZhiShuRanking", "SonPlate_Info",
                                  {"PlateID": pid}, authed=True)
                except Exception:
                    continue
                for row in (r or {}).get("List") or []:
                    if isinstance(row, (list, tuple)) and len(row) >= 2:
                        names[str(row[0])] = str(row[1])
            # 行业级名字（FengKou 首位常为行业）由 KPL_SECTORS/BaceFaceList/JJYDBK 补
            for nm, code in (("芯片", "801001"), ("锂电池", "801004"), ("医药", "801045"),
                             ("创新药", "801723"), ("地产链", "801676"), ("房地产", "801007"),
                             ("AI应用", "801159"), ("存储", "801722"), ("酿酒", "801035"),
                             ("银行", "801027"), ("化工", "801235"), ("元器件", "801445"),
                             ("面板", "801067"), ("通信", "801660"), ("科创板", "801351")):
                names.setdefault(code, nm)
            try:
                for nm, _r, pid in self._active_plates_raw():
                    names.setdefault(str(pid), str(nm))
            except Exception:
                pass
            if len(names) >= 100:
                try:
                    from storage import storage as _st
                    p = _st.data_dir / "kpl_plate_names.json"
                    tmp = p.with_suffix(".tmp")
                    tmp.write_text(json.dumps({"ts": time.time(), "names": names},
                                              ensure_ascii=False), encoding="utf-8")
                    tmp.replace(p)
                except Exception as e:
                    logger.debug(f"板块名表落盘: {e}")
                with getattr(self, "_plate_name_lock", threading.Lock()):
                    merged = dict(getattr(self, "_plate_name_cache", {}) or {})
                    merged.update(names)
                    self._plate_name_cache = merged
                logger.info(f"KPL 板块名表构建完成: {len(names)} 条")
            else:
                logger.warning(f"KPL 板块名表构建失败（仅 {len(names)} 条）")
        finally:
            self._plate_names_building = False

    def get_stock_f10(self, code: str) -> Dict[str, Any]:
        """F10（App F10 页同源 StockF10Basic @apparticle）：公司资料+财务数据。300s 缓存。"""
        code = str(code)
        key = f"f10:{code}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 300:
            return hit["data"]
        HA = "https://apparticle.longhuvip.com/w1/api/index.php"
        out: Dict[str, Any] = {"code": code}
        try:
            d = self.call(HA, "StockF10Basic", "GetCompanyInfo",
                          {"StockID": code}, authed=True)
            out["company"] = d.get("List") or d
        except Exception as e:
            logger.debug(f"GetCompanyInfo: {e}")
        try:
            d = self.call(HA, "StockF10Basic", "GetFinanceInfo",
                          {"StockID": code}, authed=True)
            rows = (d or {}).get("List") or []
            # 表头（App 同款列序）：营收/净利/扣非/EPS/净资产/未分配/公积金/每经营现金流/ROE/净利率/毛利率/周转…
            out["finance"] = rows[:8]
        except Exception as e:
            logger.debug(f"GetFinanceInfo: {e}")
        if out.get("company") or out.get("finance"):
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_stock_f10_full(self, code: str) -> Dict[str, Any]:
        """F10 完整版：公司资料+财务行+主营构成+主要指标图表（StockF10Basic @apparticle）。
        GetMainIndicators 需 Type 参数（1142"报告类型为空"→Type=1 破解）。600s 缓存。"""
        code = str(code)
        key = f"f10full:{code}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 600:
            return hit["data"]
        HA = "https://apparticle.longhuvip.com/w1/api/index.php"
        out: Dict[str, Any] = {"code": code}
        try:
            d = self.call(HA, "StockF10Basic", "GetCompanyInfo",
                          {"StockID": code}, authed=True)
            out["company"] = d.get("List") or d
        except Exception as e:
            logger.debug(f"GetCompanyInfo: {e}")
        try:
            d = self.call(HA, "StockF10Basic", "GetFinanceInfo",
                          {"StockID": code}, authed=True)
            out["finance"] = (d or {}).get("List") or []
        except Exception as e:
            logger.debug(f"GetFinanceInfo: {e}")
        try:
            d = self.call(HA, "StockF10Basic", "GetMainIndicators",
                          {"StockID": code, "Type": "1"}, authed=True)
            out["indicators"] = {k: v for k, v in (d or {}).items() if k != "errcode"}
        except Exception as e:
            logger.debug(f"GetMainIndicators: {e}")
        if out.get("company") or out.get("finance") or out.get("indicators"):
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_hk_stocks(self, force: bool = False) -> Dict[str, Any]:
        """港股列表（App 港股 tab 基础数据同源）：cmd 2304 下发 CDN url
        （plate/N_hk_<ts>.data）→ JSON{timestamp, items:[HK:代码,名称,1,拼音,板块组,标记]}。
        版本号不变免重下（磁盘缓存 kpl_hk_stocks.json）。"""
        import kpl_socket as _ks
        from storage import storage as _st
        cache_p = _st.data_dir / "kpl_hk_stocks.json"
        if not force:
            try:
                sn = json.loads(cache_p.read_text(encoding="utf-8"))
                if sn.get("items"):
                    return sn
            except Exception:
                pass
        try:
            meta = _ks.get_kpl_socket().get_hk_stockfile_url()
        except Exception as e:
            logger.debug(f"hk_stockfile_url: {e}")
            meta = None
        if not meta or not meta.get("url"):
            return {"items": [], "ts": 0}
        url = str(meta["url"])
        if not url.endswith(".data"):
            url += ".data"
        import httpx
        try:
            r = httpx.get(url, headers={"User-Agent": "okhttp/3.12.0"}, timeout=20)
            r.raise_for_status()
            d = json.loads(r.content.decode("utf-8"))
        except Exception as e:
            logger.debug(f"hk file download: {e}")
            return {"items": [], "ts": 0}
        rows = []
        for it in d.get("items") or []:
            parts = str(it).split(",")
            if len(parts) >= 5:
                rows.append({"code": parts[0].split(":", 1)[-1], "name": parts[1],
                             "group": parts[4], "flag": parts[5] if len(parts) > 5 else ""})
        out = {"ts": d.get("timestamp") or meta.get("ts"), "items": rows,
               "total": len(rows), "url": url}
        try:
            cache_p.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            logger.debug(f"hk cache: {e}")
        return out

    def get_stock_fenbi(self, code: str) -> Dict[str, Any]:
        """分时成交逐笔（App 个股详情"分时成交"列表同源 StockL2Data/GetStockFenBi2）：
        fb=[[时间,价格,方向,手数,笔数,?, ?, 金额]...]。30s 缓存。"""
        code = str(code)
        key = f"fenbi:{code}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        try:
            d = self.call("https://apphwshhq.longhuvip.com/w1/api/index.php",
                          "StockL2Data", "GetStockFenBi2",
                          {"StockID": code, "Index": "0", "st": "30", "Type": "1"}, authed=True)
        except Exception as e:
            logger.debug(f"GetStockFenBi2: {e}")
            return {}
        rows = []
        for r in (d or {}).get("fb") or []:
            if isinstance(r, (list, tuple)) and len(r) >= 8:
                rows.append({"time": r[0], "px": r[1], "dir": r[2], "vol": r[3],
                             "n": r[4], "money": r[7]})
        out = {"code": code, "day": (d or {}).get("Day"), "total": (d or {}).get("total"),
               "rows": rows}
        if rows:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_zt_big_orders(self, code: str) -> Dict[str, Any]:
        """涨停大单明细+连板状态（cmd 2014，涨停态盘口深度块数据源）。60s 缓存。"""
        code = str(code)
        key = f"ztbig:{code}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        import kpl_socket as _ks
        try:
            r = _ks.get_kpl_socket().get_zt_big_orders(code)
        except Exception as e:
            logger.debug(f"zt_big_orders: {e}")
            r = None
        out = r or {}
        if out:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_avoid_risks(self) -> Dict[str, Any]:
        """闪电避雷（App LightningProtection 页同源）：3011 潜在风险（excel+五类明细）
        + 3012 ST/退市股列表。120s 缓存。"""
        key = "avoidrisks"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 120:
            return hit["data"]
        import kpl_socket as _ks
        out: Dict[str, Any] = {}
        try:
            r = _ks.get_kpl_socket().get_avoid_risks(rtype=1)
            if r:
                out.update(r)
        except Exception as e:
            logger.debug(f"avoid_risks: {e}")
        try:
            st = _ks.get_kpl_socket().get_avoid_risk_stocks()
            if st:
                out["st_stocks"] = st.get("st") or []
                out["ts_stocks"] = st.get("ts") or []
        except Exception as e:
            logger.debug(f"avoid_risk_stocks: {e}")
        if out:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_lhb_business_detail(self, bid: str) -> Dict[str, Any]:
        """营业部详情（App 下钻 H5 DepkDetails 同源）：
        GetOneBusinessInfo（名称/关联营业部 AssocNum/上榜次数 UpNum/订阅态）
        + GetNewDoStockLog（历史操作表：Time=12 近12月, Day=3 近三月,
        Money=5000000 金额>500万, Order=2——App 抓包原参数）。"""
        key = f"lhbbd:{bid}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 120:
            return hit["data"]
        out: Dict[str, Any] = {"id": str(bid), "logs": []}
        try:
            d = self.call(HOST_LHB_KPL, "Business", "GetOneBusinessInfo",
                          {"BusinessID": str(bid)}, authed=True)
            out.update({"name": d.get("Name"), "assoc_num": d.get("AssocNum"),
                        "up_num": d.get("UpNum"), "is_dy": d.get("IsDY"),
                        "type": d.get("Type")})
        except Exception as e:
            logger.debug(f"GetOneBusinessInfo: {e}")
        try:
            d = self.call(HOST_LHB_KPL, "Business", "GetNewDoStockLog",
                          {"BusinessID": str(bid), "Time": "12", "st": "60",
                           "Index": "0", "SDay": "0", "Day": "3",
                           "Money": "5000000", "Order": "2"}, authed=True)
            logs = []
            for it in (d or {}).get("list") or []:
                logs.append({
                    "stock_id": str(it.get("StockID") or ""),
                    "name": str(it.get("Name") or ""),
                    "pct": str(it.get("IncreaseAmount") or ""),
                    "d3": it.get("D3"), "buy": it.get("Buy") or 0,
                    "sell": it.get("Sell") or 0,
                    "type": it.get("Type"),          # 1=买入 2=卖出
                    "money": it.get("Money"), "time": it.get("Time"),
                })
            out["logs"] = logs
        except Exception as e:
            logger.debug(f"GetNewDoStockLog: {e}")
        if out.get("name"):
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_lhb_stock_detail(self, code: str, day: str = "") -> Dict[str, Any]:
        """个股龙虎榜详情（App 下钻 H5 StockDetails 同源 Stock/GetNewOneStockInfo）：
        席位买卖列表 List[].BuyList/SellList + 历史上榜日 OnTimeList + 连板 lbnum。
        服务端 Time 缺省回最近上榜日。"""
        key = f"lhbsd:{code}:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 120:
            return hit["data"]
        params = {"Type": "0", "StockID": str(code)}
        if day:
            params["Time"] = day
        try:
            d = self.call(HOST_LHB_KPL, "Stock", "GetNewOneStockInfo",
                          params, authed=True)
        except Exception as e:
            logger.debug(f"GetNewOneStockInfo: {e}")
            return {}

        def _seats(rows):
            out = []
            for it in rows or []:
                if not isinstance(it, dict):
                    continue
                out.append({
                    "id": str(it.get("ID") or ""), "name": str(it.get("Name") or ""),
                    "buy": float(it.get("Buy") or 0), "sell": float(it.get("Sell") or 0),
                    "px": it.get("PX"), "day": it.get("Day"),
                })
            return out

        seats = []
        for grp in (d or {}).get("List") or []:
            if isinstance(grp, dict):
                seats.append({"buy": _seats(grp.get("BuyList")),
                              "sell": _seats(grp.get("SellList")),
                              "reason": grp.get("ReasonType")})
        out = {
            "name": d.get("Name"), "day": d.get("Time"),
            "price": d.get("CurPrice"), "pct": d.get("QuoteChange"),
            "turnover_ratio": d.get("TurnoverRatio"), "circ": d.get("Circulation"),
            "buy_in": d.get("BuyIn"), "lbnum": d.get("lbnum"), "tag": d.get("tag"),
            "on_times": (d.get("OnTimeList") or [])[:30],
            "seats": seats,
        }
        if out.get("name"):
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_lhb_sub(self, day: str = "") -> Dict[str, Any]:
        """订阅 tab 三子页数据（App 订阅 tab = H5 MySub.html 同源）：
        - today: UserBusiness/GetDay {Day} → 游资分组体系（顶级/一线/知名游资/机构/庄股）
          各组成员=订阅对象当日上榜动态（无订阅时为空，与 App 空白一致）
        - offices: UserBusiness/GetOfficev2 → 我的订阅营业部列表
        - official: 官方组合 = GetYiXianByDay（复用 get_lhb_yixian）"""
        day = day or time.strftime("%Y-%m-%d")
        key = f"lhbsub:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        out: Dict[str, Any] = {"day": day, "groups": [], "offices": []}
        try:
            d = self.call(HOST_LHB_KPL, "UserBusiness", "GetDay",
                          {"Day": day}, authed=True)
            tmap = {str(t.get("ID")): str(t.get("Name"))
                    for t in (d or {}).get("TList") or []}
            members = (d or {}).get("List") or {}
            for gid, lst in members.items():
                rows = []
                for m in lst if isinstance(lst, list) else []:
                    if isinstance(m, dict):
                        rows.append({"id": str(m.get("ID") or ""),
                                     "name": str(m.get("Name") or ""),
                                     "money": m.get("Money"), "num": m.get("Num")})
                out["groups"].append({"id": str(gid),
                                      "name": tmap.get(str(gid), f"分组{gid}"),
                                      "stocks": rows})
        except Exception as e:
            logger.debug(f"UserBusiness/GetDay: {e}")
        try:
            d = self.call(HOST_LHB_KPL, "UserBusiness", "GetOfficev2", {}, authed=True)
            offices = []
            for o in (d or {}).get("List") or []:
                if isinstance(o, dict):
                    offices.append({"id": str(o.get("ID") or o.get("BusinessID") or ""),
                                    "name": str(o.get("Name") or ""),
                                    "buy": o.get("Buy"), "sell": o.get("Sell")})
            out["offices"] = offices
        except Exception as e:
            logger.debug(f"GetOfficev2: {e}")
        out["official"] = self.get_lhb_yixian(day)
        self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_kpl_stock_chart(self, code: str) -> Dict[str, Any]:
        """个股日 K（App 龙虎榜 H5 K线图同源 Stock/GetStockChart @applhb）：
        x=日期序列 y=收盘 m5/m10/m20/m30=均线 vol=成交量（~530 根）。
        供 AI 投资分析工具使用（KPL 数据源，非东财/腾讯）。30s 缓存。"""
        code = str(code)
        key = f"kplchart:{code}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        try:
            d = self.call(HOST_LHB_KPL, "Stock", "GetStockChart",
                          {"StockID": code, "Index": "0", "st": "530"}, authed=True)
        except Exception as e:
            logger.debug(f"GetStockChart: {e}")
            return {}
        out = {"code": code, "name": d.get("Name"),
               "dates": d.get("x") or [], "close": d.get("y") or [],
               "m5": d.get("m5") or [], "m10": d.get("m10") or [],
               "m20": d.get("m20") or [], "m30": d.get("m30") or [],
               "vol": d.get("vol") or []}
        if out["dates"]:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    # ---------- 行情·情绪 tab（App MarketMoodFragment/MoodFragment 完整复刻，2026-10-02 逆向）----------

    _mood_pool: List = []   # 情绪页并行拉取线程池单例（类属性）
    _mood_refreshing: bool = False

    def _mood_disk_path(self):
        from storage import storage as _st
        return _st.data_dir / "kpl_mood_cache.json"

    def get_mood_page(self, day: str = "") -> Dict[str, Any]:
        """行情·情绪 tab 聚合（权威映射 kanpan_spec/docs/mood_page_map.md）。
        App 架构：历史/盘后=HIS 域 HTTP（本接口，休市 today 域只回反爬占位串）；
        当日盘中=socket 订阅（marketfeed 2100/2106/2114 等）。day 缺省=最近前一交易日
        （与 App 休市显示最近交易日缓存同款）。
        ⭐ 三层速度对齐 App：内存 60s → 磁盘秒显(kpl_mood_cache.json)+后台刷新 → 同步冷拉
        （apphis 域 11 请求×2.5s 限速，冷拉 ~25s，磁盘层把首开变秒开）。"""
        from trade_calendar import get_cal
        day = day or time.strftime("%Y-%m-%d")
        try:
            if not get_cal().is_trading_day(day):
                prev = get_cal().prev_trading_day(day)
                if prev:
                    day = prev
        except Exception:
            pass
        key = f"mood:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        # 磁盘层：同交易日 7 天内有效 → 秒回 + 后台刷新
        disk = None
        try:
            p = self._mood_disk_path()
            if p.exists():
                dj = json.loads(p.read_text(encoding="utf-8"))
                # v2 结构校验（zdtj.raw 为 2026-10-03 新增；旧缓存无此键则弃用重拉）
                zj = ((dj.get("data") or {}).get("zdtj") or {})
                if dj.get("day") == day and zj.get("raw") and time.time() - dj.get("ts", 0) < 7 * 86400:
                    disk = dj.get("data")
        except Exception as e:
            logger.debug(f"mood 磁盘缓存读: {e}")
        if disk is not None:
            self._cache[key] = {"data": disk, "ts": time.time() - 3600}
            if not KplClient._mood_refreshing:
                KplClient._mood_refreshing = True
                threading.Thread(target=self._bg_refresh_mood, args=(day,), daemon=True).start()
            return disk
        data = self._fetch_mood(day)
        if data:
            self._cache[key] = {"data": data, "ts": time.time()}
            self._save_mood_disk(data)
        return data or {"day": day}

    def _bg_refresh_mood(self, day: str) -> None:
        try:
            data = self._fetch_mood(day)
            if data:
                self._cache[f"mood:{day}"] = {"data": data, "ts": time.time()}
                self._save_mood_disk(data)
        except Exception as e:
            logger.debug(f"mood 后台刷新: {e}")
        finally:
            KplClient._mood_refreshing = False

    def _save_mood_disk(self, data: Dict[str, Any]) -> None:
        try:
            tmp = self._mood_disk_path().with_suffix(".tmp")
            tmp.write_text(json.dumps({"ts": time.time(), "day": data.get("day"),
                                       "data": data}, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._mood_disk_path())
        except Exception as e:
            logger.debug(f"mood 磁盘缓存写: {e}")

    def _fetch_mood(self, day: str) -> Optional[Dict[str, Any]]:
        HIS_K = "https://apphis.kaipanla.com/w1/api/index.php"
        from concurrent.futures import ThreadPoolExecutor
        if not KplClient._mood_pool or KplClient._mood_pool[0]._shutdown:
            KplClient._mood_pool = [ThreadPoolExecutor(max_workers=11)]
        pool = KplClient._mood_pool[0]
        HDP = "HisHomeDingPan"
        f = {
            "head": pool.submit(self.call, HIS_K, HDP, "HisDaBanHeadInfo", {"Day": day}, False),
            "zdtj": pool.submit(self.call, HIS_K, HDP, "MarketZDTJ", {"Date": day, "FBJS": "1"}, False),
            "cap": pool.submit(self.call, HIS_K, HDP, "MarketSCLN", {"Date": day.replace("-", ""), "Type": "4"}, False),  # Type=4 沪深京（App 默认，2026-10-03 Type 枚举实测定案）
            "ztexpr": pool.submit(self.call, HIS_K, HDP, "ZhangTingExpression", {"Day": day, "Is_New": "1"}, False),
            "line": pool.submit(self.call, HIS_K, "HisMarketSentiment", "GetSentimentChart", {"date": day}, False),
            "line5": pool.submit(self.call, HIS_K, "HisMarketSentiment", "GetSentimentChart", {"date": day, "five_days": "1"}, False),
            "live": pool.submit(self.call, HIS_K, "HisMarketSentiment", "GetLiveNews", {"date": day}, False),
            "senthist": pool.submit(self.get_sentiment_history),
            "withdraw": pool.submit(self.call, HIS_K, HDP, "SharpWithdrawal", {"Day": day, "Is_New": "1"}, False),
            "wind": pool.submit(self.call, HIS_K, HDP, "HisWeatherVane", {"Day": day}, False),
            "weight": pool.submit(self.call, HIS_K, HDP, "WeightPerformance", {"Day": day}, False),
            "nb": pool.submit(self.call, HIS_K, HDP, "NorthboundFundsB", {"Day": day}, False),
        }
        g = lambda k: f[k].result()
        info = lambda k: (g(k) or {}).get("info") or {}
        # ⭐ 响应层级两种：MarketZDTJ/MarketSCLN/ZhangTingExpression/SharpWithdrawal/
        #   WeightPerformance/NorthboundFundsB 包 info；HisDaBanHeadInfo=顶层 nums、
        #   HisWeatherVane=顶层 top/bottom、GetSentimentChart=顶层 points、GetLiveNews=顶层 list（实测）

        # 涨跌统计 11 档（App 同款聚合：key N=(N-1,N]% 涨幅桶，1/2/3 桶=3~0% 等，2026-10-02 对齐）
        z = info("zdtj")
        num = lambda k: int(z.get(str(k)) or 0)
        bars = []
        if z:
            bars = [
                {"lbl": "涨停", "v": num("ZT"), "cls": "up"},
                {"lbl": ">10%", "v": num(11), "cls": "up"},
                {"lbl": "10~7%", "v": num(8) + num(9) + num(10), "cls": "up"},
                {"lbl": "7~3%", "v": num(4) + num(5) + num(6) + num(7), "cls": "up"},
                {"lbl": "3~0%", "v": num(1) + num(2) + num(3), "cls": "up"},
                {"lbl": "平", "v": num(0), "cls": "flat"},
                {"lbl": "0~3%", "v": num(-1) + num(-2) + num(-3), "cls": "down"},
                {"lbl": "3~7%", "v": num(-4) + num(-5) + num(-6) + num(-7), "cls": "down"},
                {"lbl": "7~10%", "v": num(-8) + num(-9) + num(-10), "cls": "down"},
                {"lbl": "10%<", "v": num(-11), "cls": "down"},
                {"lbl": "跌停", "v": num("DT"), "cls": "down"},
            ]
        # 涨停表现：天梯+连板率（App ZTExpressionEntity 阈值：二板<15低/≥25高，余<30低/≥45高）
        e = info("ztexpr") or []
        expr = {}
        if isinstance(e, list) and len(e) >= 14:
            f1 = lambda x: float(x) if x is not None else 0.0
            grade2 = lambda v: "低" if v < 15 else ("中" if v < 25 else "高")
            gradeN = lambda v: "低" if v < 30 else ("中" if v < 45 else "高")
            gradeZb = lambda v: "低" if v < 25 else ("中" if v < 37 else "高")
            gradePerf = lambda v: "低" if v < 1 else ("中" if v < 3.5 else "高")
            gradePb = lambda v: "低" if v < -1 else ("中" if v < 1 else "高")
            expr = {
                "ladder": [int(e[0] or 0), int(e[1] or 0), int(e[2] or 0), int(e[3] or 0), int(e[4] or 0)],
                "lbRates": [
                    {"v": f1(e[5]), "g": grade2(f1(e[5]))},
                    {"v": f1(e[6]), "g": gradeN(f1(e[6]))},
                    {"v": f1(e[7]), "g": gradeN(f1(e[7]))},
                    {"v": f1(e[8]), "g": gradeN(f1(e[8]))}],
                "breakRate": {"v": f1(e[9]), "g": gradeZb(f1(e[9]))},
                "rows": [
                    {"lbl": "昨日涨停今表现", "v": f1(e[10]), "g": gradePerf(f1(e[10]))},
                    {"lbl": "昨日连板今表现", "v": f1(e[11]), "g": gradePerf(f1(e[11]))},
                    {"lbl": "昨日破板今表现", "v": f1(e[12]), "g": gradePb(f1(e[12]))}],
                "text": e[13] if len(e) > 13 else "",
            }
        # 大幅回撤
        wd = []
        for it in (info("withdraw") or []):
            if isinstance(it, list) and len(it) >= 7:
                wd.append({"code": it[0], "name": it[1], "pct": it[2],
                           "drawdown": it[3], "high": it[4], "plates": str(it[6] or "")})
        hn = g("head") or {}
        cap = info("cap") or {}
        wind = g("wind") or {}
        out = {
            "day": day,
            "head": hn.get("nums") if isinstance(hn, dict) else None,
            "zdtj": {"bars": bars, "zt": z.get("ZT"), "dt": z.get("DT"),
                     "raw": z, "sjzt": z.get("SJZT"), "sjdt": z.get("SJDT"),
                     "szjs": z.get("SZJS"), "xdjs": z.get("XDJS"),
                     "stzt": z.get("STZT"), "stdt": z.get("STDT")} if z else None,
            "cap": {"last": cap.get("last"), "ycln": cap.get("ycln"), "yclnstr": cap.get("yclnstr"),
                    "csbl": cap.get("csbl"), "color": cap.get("color"),
                    "pre": cap.get("s_zrcs"), "trends": cap.get("trends") or []} if cap else None,
            "ztexpr": expr or None,
            "mood_line": (g("line") or {}).get("points") or [],
            "mood_line5": (g("line5") or {}).get("points") or [],
            "live_news": (g("live") or {}).get("list") or [],
            "lb_strength": (g("senthist") or []),
            "withdrawal": wd,
            "windvane": {"top": wind.get("top") or [], "bottom": wind.get("bottom") or []},
            "weights": info("weight") or {},
            "northbound": info("nb") or None,
        }
        return out or None

    # ---------- 情绪页下钻（2026-10-03 逆向：MarketCapacityMoreDialog/ZhangTingExpression/MaximumRetreat/WeightPerformanceList）----------

    def _mood_norm_day(self, day: str) -> str:
        from trade_calendar import get_cal
        day = day or time.strftime("%Y-%m-%d")
        try:
            if not get_cal().is_trading_day(day):
                prev = get_cal().prev_trading_day(day)
                if prev:
                    day = prev
        except Exception:
            pass
        return day

    def get_mood_capacity(self, day: str = "", ctype: str = "4") -> Dict[str, Any]:
        """市场量能按指数切换（App 量能模块筛选弹窗 MarketCapacityMoreDialogFragment）。
        MarketSCLN Type 实测定案：0=沪深 1=上证 2=创业板 3=北证 4=沪深京(App默认) 5=科创板。60s 缓存。"""
        day = self._mood_norm_day(day)
        ctype = str(ctype or "4")
        key = f"moodcap:{ctype}:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        d = self.call("https://apphis.kaipanla.com/w1/api/index.php", "HisHomeDingPan",
                      "MarketSCLN", {"Date": day.replace("-", ""), "Type": ctype}, False)
        info = (d or {}).get("info") or {}
        out = {"day": day, "type": ctype,
               "last": info.get("last"), "ycln": info.get("ycln"), "yclnstr": info.get("yclnstr"),
               "csbl": info.get("csbl"), "color": info.get("color"),
               "pre": info.get("s_zrcs"), "trends": info.get("trends") or []}
        if out["trends"]:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_mood_ztdetail(self, day: str = "") -> Dict[str, Any]:
        """涨停表现下钻（App ZhangTingExpressionActivity 双表页）。
        头部梯头=DailyLimitIndex{Day}+实际涨跌停=MarketStockZDNum{Date}（字节码 ox0.p5/n2 实锤，已实测）；
        涨停股列表当日=socket 2120(pb.Empty, ZhangTingStockListPresenterImpl 实锤)——marketfeed 未订阅，
        10-08 盘中补；历史=DailyLimitPerformance{Day,PidType,Type,Order,Index,st}（通道实测通，
        PidType 语义 ZTEChild 一板1~更高5，但响应行数与 App 一板 40 只不符——精确参数待 10-08 盘中抓包校准）。"""
        day = self._mood_norm_day(day)
        key = f"moodztd:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 300:
            return hit["data"]
        HIS_K = "https://apphis.kaipanla.com/w1/api/index.php"
        from concurrent.futures import ThreadPoolExecutor
        if not KplClient._mood_pool or KplClient._mood_pool[0]._shutdown:
            KplClient._mood_pool = [ThreadPoolExecutor(max_workers=8)]
        pool = KplClient._mood_pool[0]
        futs = {
            "head": pool.submit(self.call, HIS_K, "HisHomeDingPan", "MarketStockZDNum", {"Date": day}, False),
            "ladder": pool.submit(self.call, HIS_K, "HisHomeDingPan", "DailyLimitIndex", {"Day": day}, False),
        }
        lists = {}
        for pid in range(1, 6):
            futs[f"p{pid}"] = pool.submit(
                self.call, HIS_K, "HisHomeDingPan", "DailyLimitPerformance",
                {"Day": day, "PidType": str(pid), "Type": "0", "Order": "0", "Index": "0", "st": "60"}, False)
        hd = (futs["head"].result() or {}).get("info") or {}
        lad = (futs["ladder"].result() or {}).get("info") or []
        out = {
            "day": day,
            "sjzt": hd.get("SJZT"), "sjdt": hd.get("SJDT"),
            "ladder": lad if isinstance(lad, list) else [],
            "lists": {}, "pending": True,
            "note": "涨停股明细通道已接通(socket 2120/DailyLimitPerformance)，参数枚举待 10-08 盘中与 App 抓包校准",
        }
        for pid in range(1, 6):
            d = futs[f"p{pid}"].result() or {}
            info = d.get("info")
            rows = info.get("list") if isinstance(info, dict) else info
            out["lists"][str(pid)] = rows if isinstance(rows, list) else []
        self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_mood_withdrawlist(self, day: str = "") -> Dict[str, Any]:
        """大幅回撤全部（App MaximumRetreatActivity；SharpWithdrawalList{Day,Type,Order,Index}
        字节码 ox0.o2 实锤已实测：info=[code,name,0,"",高点涨幅,回撤,当日涨幅]，顶层 num/date）。"""
        day = self._mood_norm_day(day)
        key = f"moodwdl:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 120:
            return hit["data"]
        d = self.call("https://apphis.kaipanla.com/w1/api/index.php", "HisHomeDingPan",
                      "SharpWithdrawalList", {"Day": day, "Type": "0", "Order": "0", "Index": "0"}, False)
        info = (d or {}).get("info") or []
        rows = []
        for it in (info if isinstance(info, list) else []):
            if isinstance(it, list) and len(it) >= 7:
                rows.append({"code": it[0], "name": it[1], "high": it[4],
                             "drawdown": it[5], "pct": it[6]})
        out = {"day": day, "num": (d or {}).get("num"), "rows": rows}
        if rows:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_mood_weightslist(self, day: str = "") -> Dict[str, Any]:
        """权重表现下钻（App WeightPerformanceListActivity：指数条+全行业表 涨幅▼/涨速/成交额）。
        WeightPerformanceList{Day,Type,Order,Index}=9 个权重板块族（实测定案，非 dd8 全行业表）；
        全行业表列与主页面 WeightPerformance info.SZ/XD 行一致（涨幅列同源），涨速/成交额列
        通道=PlateWeightStock{ZSCode}（5 种 ZSCode 盘后全空——两击规则停止，参数值待 10-08 盘中抓包）。"""
        day = self._mood_norm_day(day)
        key = f"moodwtl:{day}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 120:
            return hit["data"]
        HIS_K = "https://apphis.kaipanla.com/w1/api/index.php"
        from concurrent.futures import ThreadPoolExecutor
        if not KplClient._mood_pool or KplClient._mood_pool[0]._shutdown:
            KplClient._mood_pool = [ThreadPoolExecutor(max_workers=8)]
        pool = KplClient._mood_pool[0]
        f1 = pool.submit(self.call, HIS_K, "HisHomeDingPan", "WeightPerformanceList",
                         {"Day": day, "Type": "0", "Order": "0", "Index": "0"}, False)
        f2 = pool.submit(self.call, HIS_K, "HisHomeDingPan", "WeightPerformance", {"Day": day}, False)
        wl = (f1.result() or {}).get("info") or []
        weight_rows = []
        for it in (wl if isinstance(wl, list) else []):
            if isinstance(it, list) and len(it) >= 5:
                weight_rows.append({"id": it[0], "name": it[1], "pct": it[2],
                                    "speed": it[3], "amount": it[4]})
        info = (f2.result() or {}).get("info") or {}
        allrows = []
        for k in ("SZ", "XD"):
            for it in (info.get(k) or []):
                if isinstance(it, list) and len(it) >= 6:
                    allrows.append({"id": it[0], "name": it[1], "pct": it[2],
                                    "leader": it[4], "leader_pct": it[5], "speed": None, "amount": None})
        out = {"day": day, "weight_families": weight_rows, "rows": allrows,
               "pending_cols": True,
               "note": "涨速/成交额列通道 PlateWeightStock{ZSCode} 参数待 10-08 盘中抓包校准"}
        if allrows or weight_rows:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_kpl_stock_trend(self, code: str) -> Dict[str, Any]:
        """个股分时（App 个股详情分时图同源 StockL2Data/GetStockTrend）：
        trend=[[时间,现价,均价,量,阶段]...]+昨收/开盘/最高/最低。30s 缓存。"""
        code = str(code)
        key = f"kpltrend:{code}"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        try:
            d = self.call("https://apphwshhq.longhuvip.com/w1/api/index.php",
                          "StockL2Data", "GetStockTrend",
                          {"StockID": code}, authed=True)
        except Exception as e:
            logger.debug(f"GetStockTrend: {e}")
            return {}
        out = {"code": code, "name": d.get("code"),
               "preClose": d.get("preclose_px"), "begin": d.get("begin_px"),
               "high": d.get("hprice"), "low": d.get("lprice"),
               "trend": d.get("trend") or []}
        if out["trend"]:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_kpl_timing(self) -> Dict[str, Any]:
        """KPL 口径大盘择时聚合（AI 分析工具数据源）：打板情绪条(2100)+涨跌统计(2110)
        +市场总览(2115)+连板天梯(2117)+涨停分钟序列(2116)+综合强度(ChangeStatistics)。
        全部开盘啦数据源。60s 缓存。"""
        key = "kpltiming"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        out: Dict[str, Any] = {}
        try:
            from kpl_marketfeed import get_feed
            snap = get_feed().snapshot()
            head = ((snap.get("dabanhead") or {}).get("data")) or {}
            zd = ((snap.get("zdstat") or {}).get("data")) or {}
            ov = ((snap.get("overview") or {}).get("data")) or {}
            lad = ((snap.get("ladder") or {}).get("data")) or {}
            zts = ((snap.get("ztseries") or {}).get("data")) or {}
            out.update({
                "zt_fb_dt": {"zt": head.get("zt"), "fbl": head.get("fb"), "dt": head.get("dt")},
                "rise_down": {"rise": zd.get("rise"), "down": zd.get("down"),
                              "real_zt": zd.get("realZt"), "real_dt": zd.get("realDt"),
                              "sign": zd.get("sign")},
                "market_overview": {
                    "hs_amount": ov.get("hsAmount"), "hs_pct": ov.get("hsPct"),
                    "qx_temp": ov.get("qx"), "qx_status": ov.get("qxStatus"),
                    "forecast_money": ov.get("forecastMoney"),
                    "strong_today": ov.get("strongTD"), "strong_yest": ov.get("strongYD")},
                "max_lb": (lad.get("ladder") or [{}])[0].get("h") if lad.get("ladder") else None,
                "ladder_top3": [{"h": r.get("h"),
                                 "names": [s.get("name") for s in (r.get("stocks") or [])[:3]]}
                                for r in (lad.get("ladder") or [])[:3]],
                "zt_series_tail": (zts.get("series") or [])[-5:],
                "day": zts.get("day") or out.get("day"),
            })
        except Exception as e:
            logger.debug(f"get_kpl_timing: {e}")
        # 综合强度（ChangeStatistics strong）与情绪历史
        try:
            sent = self.get_sentiment_history() or []
            if sent:
                out["sentiment_today"] = sent[0]
                out["sentiment_yest"] = sent[1] if len(sent) > 1 else {}
        except Exception:
            pass
        if out:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_kpl_sentiment(self) -> Dict[str, Any]:
        """KPL 口径市场情绪聚合（AI 分析工具数据源）：综合强度温度计+情绪历史
        +风向标涨跌榜 top3+今日风口（ZQFKList）。"""
        key = "kplsent"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]
        out: Dict[str, Any] = {}
        try:
            sent = self.get_sentiment_history() or []
            out["sentiment_today"] = sent[0] if sent else {}
            out["sentiment_history"] = sent[:5]
        except Exception:
            pass
        try:
            d = self._getinfo_full()
            out["wind_vane"] = {"up": (d.get("CWeatherVaneList") or {}).get("SZ") or [],
                                "down": (d.get("CWeatherVaneList") or {}).get("XD") or []}
            out["hot_topics"] = [{"code": r[0], "name": r[1], "strength": r[2]}
                                 for r in (d.get("ZQFKList") or [])[:5]
                                 if isinstance(r, (list, tuple)) and len(r) >= 3]
        except Exception:
            pass
        try:
            from kpl_marketfeed import get_feed
            ov = ((get_feed().snapshot().get("overview") or {}).get("data")) or {}
            out["qx_temp"] = ov.get("qx")
            out["qx_status"] = ov.get("qxStatus")
        except Exception:
            pass
        if out:
            self._cache[key] = {"data": out, "ts": time.time()}
        return out

    def get_active_plates(self) -> Dict[str, Any]:
        """近期活跃板块（Index/GetInfo {View:2,3,4,5} BaceFaceList，App 板块 tab 休市回退/首页块同源）。
        行=[名称, 涨幅, 801板块id]。3007 强度表未破前，板块 tab 回退用。"""
        def _fetch():
            d = self.call(HOST_HQ2, "Index", "GetInfo",
                          {"View": "2,3,4,5"}, authed=False)
            rows = (d or {}).get("BaceFaceList") or []
            lst = []
            for r in rows:
                if isinstance(r, list) and len(r) >= 3:
                    try:
                        lst.append({"name": str(r[0]), "rate": float(r[1]),
                                    "plateId": str(r[2])})
                    except (TypeError, ValueError):
                        continue
            return {"list": lst}
        return self._cached_swr("active_plates", 60, _fetch)

    def get_qiangdu(self) -> Dict[str, Any]:
        """最强风口（App 首页模块同源 Index/GetInfo 的 ZQFKList，
        [代码,名称,强度,涨幅,概念(顿号分隔)]——2026-09-28 实锤：QiangDu_Article 盘后清空，
        ZQFKList 全时段有数据且与板块详情"强度"同体系）。
        盘后快照 kpl_qd_snapshot.json 双兜底（App 盘后保留当日数据同款）。"""
        key = "qiangdu"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        today = time.strftime("%Y-%m-%d")
        snap_path = storage.data_dir / "kpl_qd_snapshot.json"

        def _load_snap():
            try:
                sn = json.loads(snap_path.read_text(encoding="utf-8"))
                if sn.get("list"):
                    return sn.get("list") or [], sn.get("day") or ""
            except Exception:
                pass
            return [], ""

        def _save_snap(l):
            try:
                snap_path.write_text(json.dumps({"day": today, "list": l},
                                                ensure_ascii=False), encoding="utf-8")
            except Exception as e:
                logger.debug(f"最强风口快照落盘失败: {e}")

        # 主源：GetInfo ZQFKList（全时段）
        d = self._getinfo_full()
        zq = d.get("ZQFKList") or []
        lst = []
        for r in zq:
            if isinstance(r, (list, tuple)) and len(r) >= 5:
                lst.append([r[0], r[1], r[2], r[3], str(r[4] or "").replace("、", "/")])
        sent = self.get_sentiment_history() or []
        sentiment = {"today": sent[0] if len(sent) > 0 else {},
                     "yesterday": sent[1] if len(sent) > 1 else {}}
        if lst:
            _save_snap(lst)
            return {"list": lst, "cached": False, "day": today, "sentiment": sentiment}
        snap_list, snap_day = _load_snap()
        return {"list": snap_list, "cached": True, "day": snap_day or today,
                "sentiment": sentiment}

    @staticmethod
    def _themedet_disk_path():
        from storage import storage as _st
        return _st.data_dir / "kpl_theme_cache.json"

    def _load_themedet_disk(self) -> None:
        if self._themedet_disk_loaded:
            return
        self._themedet_disk_loaded = True
        try:
            d = json.loads(self._themedet_disk_path().read_text(encoding="utf-8"))
            for k, v in (d or {}).items():
                old = self._themedet_stale.get(k)
                if not old or v.get("ts", 0) > old.get("ts", 0):
                    self._themedet_stale[k] = v
        except Exception:
            pass

    def _save_themedet_disk(self, key: str, data: Dict[str, Any]) -> None:
        # 高频写盘触发杀软扫描挂起进程（见 poprank 同款注释），防抖 5 分钟+原子写
        try:
            now = time.time()
            if now - self._themedet_disk_last < 300:
                return
            self._themedet_disk_last = now
            p = self._themedet_disk_path()
            try:
                cur = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                cur = {}
            cur[key] = {"data": data, "ts": now}
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(cur, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, p)
        except Exception as e:
            logger.debug(f"themedet 磁盘缓存写入失败: {e}")

    def _themedet_quotes_alive(self) -> bool:
        import kpl_socket as _ks
        try:
            return _ks.get_kpl_socket().session_alive()
        except Exception:
            return False

    def _themedet_refresh_bg(self, tid: str, name: str) -> None:
        """后台补全题材详情（socket 死时的 quotes/stat pending 由本线程重拉填充缓存）"""
        import time as _t
        _t0 = _t.time()
        try:
            # 会话未就绪（预热建连中/重连中）时等待，最多 90s——否则 bg 空转写 pending
            # 版缓存，启动窗口内用户永远拿到无行情数据（2026-09-27 实测）
            waited = False
            while not self._themedet_quotes_alive() and _t.time() - _t0 < 90:
                time.sleep(3)
                waited = True
            d = self.get_theme_detail_socket(tid, name, use_cache=False)
            # 3010 服务端实算 ~9-15s，在此单独补全（不阻塞首响应），结果直接写缓存
            if not d.get("error"):
                try:
                    import kpl_socket as _ks
                    stat = _ks.get_kpl_socket().get_theme_stat(int(tid))
                    if stat:
                        d["stat"] = {"stock_num": stat.get("stock_num"),
                                     "up_num": stat.get("up_num"),
                                     "down_num": stat.get("down_num"),
                                     "avg_pct": stat.get("avg_ratio")}
                        d.pop("stat_pending", None)
                        key2 = f"themedet:{tid}"
                        now = time.time()
                        self._cache[key2] = {"data": d, "ts": now}
                        self._themedet_stale[key2] = {"data": d, "ts": now}
                        self._save_themedet_disk(key2, d)
                except Exception as e:
                    logger.info(f"themedet 3010 补全异常 {tid}: {type(e).__name__} {e}")
            logger.info(f"themedet 后台刷新 {tid}({name}) 完成 {round(_t.time()-_t0,1)}s "
                        f"(waited={waited}) stat={'Y' if d.get('stat') else 'N'} "
                        f"quotes={d.get('quotes_source') or '-'} "
                        f"pending={d.get('quotes_pending') or d.get('stat_pending')}")
        except Exception as e:
            logger.info(f"themedet 后台刷新 {tid} 异常: {type(e).__name__} {e}")
        finally:
            self._themedet_refreshing.discard(f"themedet:{tid}")

    def get_theme_detail_socket(self, theme_id: str, name: str = "",
                                use_cache: bool = True) -> Dict[str, Any]:
        """题材详情（App 同源）：HTTP Theme/InfoGet 一个接口包含全部数据——
        Table（小表格分类矩阵）、StockList（成分股平铺）、BriefIntro、Introduction、ZT（涨停股）。
        个股实时涨幅：socket 2501 池按代码匹配；统计条：socket 3010。
        ⚡ 性能：SWR 陈旧缓存秒回；socket 死时短路跳过行情（标 quotes_pending/stat_pending，
        后台线程补全进缓存）——响应绝不被 socket 重连阻塞。"""
        tid = str(theme_id)
        key = f"themedet:{tid}"
        hit = self._cache.get(key)
        if use_cache and hit and time.time() - hit["ts"] < 30:
            return hit["data"]
        self._load_themedet_disk()
        stale = self._themedet_stale.get(key)
        if use_cache and stale and time.time() - stale.get("ts", 0) < 7 * 86400:
            if key not in self._themedet_refreshing:
                self._themedet_refreshing.add(key)
                threading.Thread(target=self._themedet_refresh_bg, args=(tid, name),
                                 daemon=True, name=f"themedet-bg-{tid}").start()
            return {**stale["data"], "stale": True}

        out: Dict[str, Any] = {"id": tid, "name": name}

        d = self.call(HOST_LHB, "Theme", "InfoGet", {"ID": tid, "id": tid}, authed=True)
        if not d or str(d.get("errcode", "0")) != "0":
            logger.info(f"themedet InfoGet 失败 {tid}({name}) err={str(d)[:120] if d else 'None'}")
            if stale:
                return {**stale["data"], "stale": True}
            return {"error": "题材详情获取失败", "id": tid}

        out["name"] = self._remember_name("themes", tid, d.get("Name") or name)
        out["brief"] = d.get("BriefIntro") or ""
        out["introduction"] = d.get("Introduction") or ""
        out["create_time"] = d.get("CreateTime")
        out["update_time"] = d.get("UpdateTime")
        out["zt"] = d.get("ZT") or {}
        # 题材自身涨幅（3009 缓存里查）
        try:
            for t in (self._cache.get("themesock") or {}).get("data", {}).get("items") or []:
                if str(t.get("id")) == tid:
                    out["pct"] = t.get("pct")
                    out["hot"] = t.get("hot")
                    break
        except Exception:
            pass

        # 小表格矩阵：Level1 → Level2 → Stocks（is_zt = ZT map 涨停标记，App 红色高亮同款）
        zt = d.get("ZT") or {}
        table = []
        for lv1 in d.get("Table") or []:
            l1 = lv1.get("Level1") or {}
            row1 = {"id": l1.get("ID"), "name": l1.get("Name"), "groups": [],
                    # Level1 可直接挂 Stocks（无二级分类的形态，如"生产商"）
                    "stocks": [{
                        "code": s.get("StockID"), "name": s.get("prod_name"),
                        "hot": s.get("Hot"), "is_zz": s.get("IsZz"), "is_hot": s.get("IsHot"),
                        "reason": s.get("Reason"), "is_zt": str(s.get("StockID")) in zt,
                    } for s in l1.get("Stocks") or []]}
            for lv2 in lv1.get("Level2") or []:
                row1["groups"].append({
                    "id": lv2.get("ID"), "name": lv2.get("Name"),
                    "stocks": [{
                        "code": s.get("StockID"), "name": s.get("prod_name"),
                        "hot": s.get("Hot"), "is_zz": s.get("IsZz"), "is_hot": s.get("IsHot"),
                        "reason": s.get("Reason"), "is_zt": str(s.get("StockID")) in zt,
                    } for s in lv2.get("Stocks") or []],
                })
            table.append(row1)
        out["table"] = table

        # 成分股平铺（InfoGet StockList：代码/名称/人气值/板块标签，App 详情页同接口）
        stock_list = [{
            "code": s.get("StockID"), "name": s.get("prod_name"),
            "hot": s.get("HotNum"),
            "is_zt": str(s.get("StockID")) in zt,
            "tags": [{"id": t.get("ID"), "name": t.get("Name"), "reason": t.get("Reason")}
                     for t in s.get("Tag") or []],
        } for s in d.get("StockList") or []]
        for s in stock_list:
            fixed = self._remember_name("stocks", s["code"], s.get("name") or "")
            if fixed and not s.get("name"):
                s["name"] = fixed
        # 实时数值列 + 统计条。
        # ⚡ socket 短路：会话死亡时内联拉取会触发 40-80s 重连扫描——死会话跳过。
        alive = self._themedet_quotes_alive()
        pending = False
        bid = self._theme_board_id(out["name"])
        if not bid and alive and stock_list:
            # 无 BaceFaceList 映射 → 走 3001 按成分股 stockIds 订阅行情（App 同通道）
            try:
                import kpl_socket as _ks3001
                caps = _ks3001.get_kpl_socket().get_stock_quotas(
                    [str(x["code"]) for x in stock_list], wait_s=6,
                    capture_path=storage.data_dir / "kpl_3001_capture.bin")
                if caps:
                    for x in stock_list:
                        qq = caps.get(str(x["code"]))
                        if qq and len(qq) > 4:
                            # 列锚定待盘中样本校正（通用 21 列序）
                            x["price"] = qq[1] if len(qq) > 1 else ""
                            x["rate"] = qq[2] if len(qq) > 2 else ""
                            x["amount"] = qq[4] if len(qq) > 4 else ""
                            x["turnover"] = qq[8] if len(qq) > 8 else ""
                    out["quotes_source"] = "socket3001"
            except Exception as e:
                logger.debug(f"题材详情 3001 行情失败({out['name']}): {e}")
        merged = 0
        if bid:
            try:
                import kpl_socket as _ks
                now = time.time()
                pc = self._pool_qmap_cache.get(bid)
                if pc and now - pc["ts"] < 30:
                    qmap = pc["qmap"]
                elif not alive:
                    out["quotes_pending"] = True
                    pending = True
                    qmap = None
                else:
                    # quotaType=1 市值序（题材核心股靠前）；单页 500（服务端拒 start 分页/count>500，
                    # 中小市值尾部个股暂无行情，前端显示 --，记录待后续补全量通道）
                    pool = _ks.get_kpl_socket().get_sector_pool(bid, quota_type=1, count=500)
                    qmap = {}
                    for it in (pool or {}).get("items") or []:
                        code = str(it.get(1, ""))
                        qmap[code] = it.get("quotas") or []
                        # 池里带股票名(f2)：登记到名称缓存，供缺名兜底
                        self._remember_name("stocks", code, str(it.get(2) or ""))
                    self._pool_qmap_cache[bid] = {"ts": now, "qmap": qmap}
                if qmap:
                    for s in stock_list:
                        if not s.get("name"):
                            s["name"] = self._remember_name("stocks", str(s["code"]), "")
                        q = qmap.get(str(s["code"]))
                        if q and len(q) > 4:
                            s["price"], s["pct"] = q[1], q[2]
                            s["amount"], s["turnover"] = q[3], q[4]
                            merged += 1
                    self._flush_names()
            except Exception as e:
                logger.debug(f"题材详情 2501 行情失败({out['name']}): {e}")
        out["stocks"] = stock_list
        out["quotes_source"] = f"socket2501:{merged}" if merged else ""

        # 统计条（3010）：服务端实时计算实测 ~9s（周日/盘后更慢），不进关键路径——
        # 首响应标 stat_pending 立回，由 _themedet_refresh_bg 单独拉取并写缓存，
        # 前端收到 stat_pending 后自动重拉拿到
        out["stat_pending"] = True
        pending = True
        if pending and key not in self._themedet_refreshing:
            self._themedet_refreshing.add(key)
            threading.Thread(target=self._themedet_refresh_bg, args=(tid, name),
                             daemon=True, name=f"themedet-bg-{tid}").start()
        if stock_list or table:
            now = time.time()
            self._cache[key] = {"data": out, "ts": now}
            self._themedet_stale[key] = {"data": out, "ts": now}
            self._save_themedet_disk(key, out)
        return out

    @staticmethod
    def _norm_news(it: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": it.get("ID"), "time": it.get("Time"), "type": it.get("Type"),
            "content": it.get("Content"), "url": it.get("URL"),
            "stock_name": it.get("StockName"), "stock_id": it.get("StockID"),
        }


_kpl: Optional[KplClient] = None


def get_kpl() -> KplClient:
    global _kpl
    if _kpl is None:
        _kpl = KplClient()
    return _kpl


# ============= 后台自选行情快照循环 =============

_snapshot_stop = threading.Event()
_snapshot_thread: Optional[threading.Thread] = None


def start_snapshot_loop():
    """后台逐只轮询自选股 GetStockPanKou（2.5s/只，持续循环），前端读缓存秒回"""
    global _snapshot_thread
    if _snapshot_thread and _snapshot_thread.is_alive():
        return
    def _loop():
        kpl = get_kpl()
        time.sleep(3)
        # 预热首页缓存（后台串行拉 ~7 个请求），用户首次点开开盘啦 Tab 即秒开
        try:
            kpl.get_home_feed()
            kpl.get_hot_stocks()
            logger.info("KPL 首页缓存预热完成")
        except Exception:
            pass
        while not _snapshot_stop.is_set():
            wl = kpl.get_watchlist()
            stocks = (wl or {}).get("stocks", {})
            codes = []
            for group_codes in stocks.values():
                codes.extend(group_codes)
            if not codes:
                _snapshot_stop.wait(15)
                continue
            # 轮询一圈后停留10s
            for code in codes:
                if _snapshot_stop.is_set():
                    return
                if not kpl.is_logged_in():
                    _snapshot_stop.wait(30)
                    break
                try:
                    kpl.get_pankou(code, force=True)
                except Exception:
                    pass
                _snapshot_stop.wait(2.5)
            else:
                _snapshot_stop.wait(10)
    _snapshot_thread = threading.Thread(target=_loop, daemon=True, name="kpl-snapshot")
    _snapshot_thread.start()
    logger.info("KPL 自选行情快照循环已启动（2.5s/只）")


def stop_snapshot_loop():
    _snapshot_stop.set()


# 模块级属性委托：kpl.status() / kpl.get_watchlist() 等直接转发到单例方法
def __getattr__(name: str):
    if not name.startswith("_"):
        client = get_kpl()
        attr = getattr(client, name, None)
        if attr is not None:
            return attr
    raise AttributeError(f"module 'kpl' has no attribute '{name}'")
