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
from typing import Any, Dict, List, Optional

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
        """按域限速：同域请求保持最小间隔，跨域并行（App 即每域独立连接）"""
        with self._lock:
            now = time.time()
            last = self._last_req_by_host.get(host, 0.0)
            wait = last + MIN_INTERVAL - now
            if wait > 0:
                time.sleep(wait)
            self._last_req_by_host[host] = time.time()

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

    # ---------- 首页聚合（复刻 App 首页信息流，模块接口均为 2026-09-22 实测） ----------

    def get_home_feed(self, force: bool = False) -> Optional[Dict[str, Any]]:
        """首页各模块聚合：大盘解读/最新主题/AI快讯/最强风口/市场风口/市场情绪/活跃板块/推荐文章"""
        if force:
            self.invalidate("homefeed")
        return self._cached_swr("homefeed", 20, self._fetch_home_feed)

    def _fetch_home_feed(self) -> Optional[Dict[str, Any]]:
        from concurrent.futures import ThreadPoolExecutor
        out: Dict[str, Any] = {}
        pool = ThreadPoolExecutor(max_workers=6)
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
        _now = time.localtime()
        _trading = (_now.tm_wday < 5 and (555 <= _now.tm_hour * 60 + _now.tm_min <= 690
                                          or 780 <= _now.tm_hour * 60 + _now.tm_min <= 900))
        futs["poprank"] = pool.submit(self.get_pop_rank, 1 if _trading else 13, 1, 0, 5)
        # 3.7 严重异动提醒（StockBidYiDong/GetPianLiZhi_Index，偏离值监控）
        futs["yidong"] = pool.submit(self.get_yidong_alert)
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
        # 严重异动提醒（偏离值监控列表）
        try:
            yd = futs["yidong"].result() or {}
            out["yidong"] = yd.get("items") or []
            out["yidong_day"] = yd.get("day")
        except Exception:
            out["yidong"] = []
        try:
            out["qiangdu"] = (futs["qd"].result() or {}).get("list") or []
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
        day_s = str(got.get("Day") or used_day or "")
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

    def get_yidong_alert(self) -> Dict[str, Any]:
        """严重异动提醒（App 同源 StockBidYiDong/GetPianLiZhi_Index）：
        涨幅偏离值监控列表——距触发交易所"严重异动"的进度。
        List 项字段：[0]code [1]name [2]口径(1盘中/0收盘) [3]规则 [4]当日涨幅 [5]已交易天数
        [6]累计偏离值% [7]触发提示 [8]触发所需涨幅 [11]现价 [12]状态。同股盘中/收盘两种口径取盘中。"""
        key = "yidong"
        hit = self._cache.get(key)
        if hit and time.time() - hit["ts"] < 60:
            return hit["data"]

        def _fetch():
            d = self.call(HOST_HQ, "StockBidYiDong", "GetPianLiZhi_Index", {}, False)
            items: Dict[str, Dict[str, Any]] = {}
            order: list = []
            for row in (d or {}).get("List") or []:
                if not isinstance(row, list) or len(row) < 13:
                    continue
                code = str(row[0])
                it = {"code": code, "name": row[1], "kind": row[2], "rule": row[3],
                      "day_pct": row[4], "days": row[5], "dev": row[6], "tip": row[7],
                      "need": row[8], "price": row[11], "status": row[12]}
                if code not in items:            # 保持首次出现顺序
                    items[code] = it
                    order.append(code)
                elif it["kind"] == 1:            # 盘中口径覆盖收盘口径
                    items[code] = it
            lst = [items[c] for c in order]
            for it in lst:
                fixed = self._remember_name("stocks", it["code"], it.get("name") or "")
                if fixed and not it.get("name"):
                    it["name"] = fixed
                # App 派生字段：触发价=昨收×(1+触发涨幅)；当日偏离值空间=触发涨幅-当日涨幅
                try:
                    day_pct = float(it.get("day_pct") or 0)
                    need = float(it.get("need") or 0)
                    price = float(it.get("price") or 0)
                    prev_close = price / (1 + day_pct / 100) if day_pct > -100 else 0
                    it["prev_close"] = round(prev_close, 2)
                    it["trigger_price"] = round(prev_close * (1 + need / 100), 2)
                    it["space"] = round(need - day_pct, 2)
                except Exception:
                    pass
                # 规则简称（"连续10个交易日内涨幅偏离值累计达到 100%" -> "10日100%"）
                try:
                    import re as _re
                    m = _re.match(r"连续(\d+)个交易日.*?达到\s*([\d.]+)%", it.get("rule") or "")
                    if m:
                        it["rule_short"] = f"{m.group(1)}日{m.group(2)}%"
                except Exception:
                    pass
            self._flush_names()
            return {"day": (d or {}).get("Day"), "items": lst}

        data = _fetch()
        if data.get("items"):
            self._cache[key] = {"data": data, "ts": time.time()}
        return data

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
