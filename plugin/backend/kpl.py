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
import random
import threading
import time
from typing import Any, Dict, List, Optional

import httpx
from loguru import logger

from config import config

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
        self._last_req: float = 0.0
        self._cache: Dict[str, Dict[str, Any]] = {}   # key -> {"data":..., "ts":...}
        self._token_invalid = False

    # ---------- 基础 ----------

    def _get_client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                headers=_HEADERS, timeout=6.0,
                limits=httpx.Limits(max_keepalive_connections=0))
        return self._client

    def _rate_wait(self):
        """全局限速：与上一请求保持最小间隔"""
        with self._lock:
            now = time.time()
            wait = self._last_req + MIN_INTERVAL - now
            if wait > 0:
                time.sleep(wait)
            self._last_req = time.time()

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
        self._rate_wait()
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
        logged = self.is_logged_in()
        endtime = config.get("kpl_token_endtime")
        info = None
        if logged:
            d = self.call(HOST_LHB, "UserInfo", "GetInfo")
            if d and (d.get("UserName") or d.get("UserID")):
                info = {"user_id": str(config.get("kpl_user_id") or ""),
                        "username": d.get("UserName"),
                        "kai_pan_b": d.get("KaiPanB")}
            elif d is None:
                self._token_invalid = True
        phone = str(config.get("kpl_phone") or "")
        return {
            "logged_in": logged and info is not None,
            "user_id": config.get("kpl_user_id") or "",
            "token_endtime": endtime,
            "user_info": info,
            "token_invalid": self._token_invalid,
            "phone_masked": (phone[:3] + "****" + phone[-4:]) if len(phone) >= 7 else "",
            "has_credentials": bool(phone and config.get("kpl_password")),
            "can_relogin": bool(phone and config.get("kpl_password")),
        }

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
        return self._cached("dingpan", 15, fetch)

    def get_index_quotes(self) -> Optional[Dict[str, Any]]:
        def fetch():
            d = self.call(HOST_HQ2, "Index", "GetInfo",
                          {"View": "1,7,8,9,10,11"})
            if not d:
                d = self.call(HOST_ART, "IndexPlate", "GetIndexList",
                              {"view": "1,2,3,4,6", "st": "2", "Type": "0"})
            return d
        return self._cached("indexq", 10, fetch)

    def get_sentiment_history(self) -> Optional[List[Dict[str, Any]]]:
        def fetch():
            d = self.call(HOST_HIS, "HisHomeDingPan", "ChangeStatistics",
                          {"st": "1000", "Index": "0"}, authed=False)
            return (d or {}).get("info") or []
        return self._cached("senthist", 300, fetch)

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
        return self._cached("hotstocks", 120, fetch)

    def get_hot_words(self) -> Optional[List[str]]:
        def fetch():
            d = self.call(HOST_HIS, "HisLimitResumption", "GetHotSearch", authed=False)
            return (d or {}).get("word") or []
        return self._cached("hotwords", 600, fetch)

    # ---------- 首页聚合（复刻 App 首页信息流，模块接口均为 2026-09-22 实测） ----------

    def get_home_feed(self, force: bool = False) -> Optional[Dict[str, Any]]:
        """首页各模块聚合：大盘解读/最新主题/AI快讯/最强风口/市场风口/市场情绪/活跃板块/推荐文章"""
        if force:
            self.invalidate("homefeed")
        return self._cached("homefeed", 20, self._fetch_home_feed)

    def _fetch_home_feed(self) -> Optional[Dict[str, Any]]:
        out: Dict[str, Any] = {}
        # 1. 大盘解读(Type=39) + 推荐文章 —— applhb UserInfo/AppNews
        news = self.call(HOST_LHB, "UserInfo", "AppNews", {"st": "30", "Index": "0"}, authed=False)
        items = (news or {}).get("List") or []
        explain = next((it for it in items if str(it.get("Type")) == "39"), None)
        out["explain"] = self._norm_news(explain) if explain else None
        out["articles"] = [self._norm_news(it) for it in items if str(it.get("Type")) != "39"][:10]
        # 2. AI快讯 —— apparticle PCNewsFlash/GetList
        flash = self.call(HOST_ART, "PCNewsFlash", "GetList",
                          {"st": "20", "Type": "0", "Index": "0", "Date": ""}, authed=False)
        fl = (flash or {}).get("List") or []
        out["flash"] = [{
            "id": x.get("CID"), "time": x.get("Time"), "title": x.get("Title"),
            "content": x.get("Content"), "source": x.get("Source"),
            "stocks": [{"code": s[0], "name": s[1], "rate": s[2]}
                       for s in (x.get("Stocks") or []) if isinstance(s, list) and len(s) >= 3],
        } for x in fl]
        # 3. 最新主题 —— apparticle ThemeNews/GetList（与主题机会页同源，首页只取前2条）
        themes = self.call(HOST_ART, "ThemeNews", "GetList",
                           {"st": "10", "Index": "0", "Type": "-1"}, authed=False)
        tl = (themes or {}).get("List") or []
        out["themes"] = [{
            "id": x.get("CID"), "title": x.get("Title"), "theme": x.get("ZSName"),
            "time": x.get("TimeStamp"), "source": x.get("Source"),
            "stocks": [{"code": s.get("Code"), "name": s.get("Name"), "rate": s.get("Rate")}
                       for s in (x.get("Stocks") or []) if isinstance(s, dict)][:2],
        } for x in tl[:2]]
        # 4. 最强风口 —— apphwshhq ZhiShuRanking/QiangDu_Article（盘中才有数据）
        qd = self.call(HOST_HQ, "ZhiShuRanking", "QiangDu_Article", {}, authed=False)
        out["qiangdu"] = (qd or {}).get("List") or []
        # 5. 市场风口热词 —— apparticle ForumsTuyere/GetHotSearch
        tuyere = self.call(HOST_ART, "ForumsTuyere", "GetHotSearch", {}, authed=False)
        out["tuyere_words"] = (tuyere or {}).get("List") or []
        # 6. 市场情绪（今日/昨日 涨停家数/封板率/跌停数）—— 复用情绪历史前两条
        sent = self.get_sentiment_history() or []
        out["sentiment"] = {
            "today": sent[0] if len(sent) > 0 else {},
            "yesterday": sent[1] if len(sent) > 1 else {},
        }
        # 7. 近期活跃板块（指数板块列表按涨幅排序取前6）
        idx = self.call(HOST_ART, "IndexPlate", "GetIndexList",
                        {"view": "1,2,3,4,6", "st": "2", "Type": "0"}, authed=False)
        plates = []
        for lst in [(idx or {}).get("list"), (idx or {}).get("List")]:
            if isinstance(lst, list) and lst:
                for x in lst:
                    if isinstance(x, dict) and x.get("Name"):
                        plates.append({"name": x.get("Name"), "rate": x.get("PX_change_rate") or x.get("px_change_rate") or 0})
                    elif isinstance(x, list) and len(x) >= 5:
                        plates.append({"name": x[1], "rate": x[4]})
                break
        plates = [p for p in plates if isinstance(p.get("rate"), (int, float))]
        plates.sort(key=lambda p: p["rate"], reverse=True)
        out["active_plates"] = plates[:6]
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
                "id": x.get("CID"), "title": x.get("Title"), "theme": x.get("ZSName"),
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
