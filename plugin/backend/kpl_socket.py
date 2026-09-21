# -*- coding: utf-8 -*-
"""
开盘啦 Socket 通道（二期）—— mTLS + 挑战鉴权 + 白盒签名(frida借用) + 业务RPC

协议（逆向已完整复刻，大端）:
  帧头: [kind<<4|sub:1B][totalLen:4B][seq:2B 仅kind3/4/5][cmd:2B][flags:1B][extCount:2B][TLV...][protobuf body]
  流程: getIPList发现服务器 → TLS1.3(mTLS客户端证书 static/kpl_kgT.p12, 密码kaipan_ios_2026)
        ← kind2 cmd260 ChallengeAuthNt{serverTime, challenge, codeType}
        → frida借App白盒 whiteBoxEncrypt(challenge, deviceId, "99", serverTime) 得hex签名
        → kind3 cmd610 AuthReq(11字段, flags=0x00) ← kind3 cmd610 AuthResp{serverIP}
        → 心跳 kind1 cmd13 空body 每7s → 业务RPC kind4 flags0

依赖: frida（借签名必须模拟器运行开盘啦App；不可用时业务端点降级）
"""
import os
import socket
import ssl
import struct
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from loguru import logger

# ============= 帧编解码 =============

HAS_SEQ_KINDS = (3, 4, 5)


def build_frame(cmd: int, body: bytes = b"", kind: int = 1, subtype: int = 0,
                seq: Optional[int] = None, flags: int = 0) -> bytes:
    buf = bytearray()
    if kind in HAS_SEQ_KINDS:
        buf += struct.pack(">H", seq if seq is not None else 0)
    buf += struct.pack(">H", cmd)
    buf += struct.pack(">B", flags)
    buf += struct.pack(">H", 0)
    buf += body
    out = bytearray()
    out += struct.pack(">B", (kind << 4) | (subtype & 0xF))
    out += struct.pack(">I", 5 + len(buf))
    out += buf
    return bytes(out)


def try_parse_frame(data: bytes) -> Tuple[Optional[Dict[str, Any]], int]:
    if len(data) < 7:
        return None, 0
    b0 = data[0]
    kind = b0 >> 4
    if kind < 1 or kind > 6:
        return None, 0
    total = struct.unpack(">I", data[1:5])[0]
    if total < 5 or total > 32 * 1024 * 1024 or len(data) < total:
        return None, 0
    off = 5
    remaining = total - 5
    seq = None
    if kind in HAS_SEQ_KINDS:
        seq = struct.unpack(">H", data[off:off + 2])[0]
        off += 2
        remaining -= 2
    cmd = struct.unpack(">H", data[off:off + 2])[0]
    off += 2
    remaining -= 2
    flags = data[off]
    off += 2 + 1  # flags + extCount(跳过TLV解析，业务用不到)
    remaining -= 3
    ext_count = struct.unpack(">H", data[off - 2:off])[0]
    for _ in range(ext_count):
        if remaining < 1:
            return None, 0
        key = data[off]
        off += 1
        remaining -= 1
        if key == 2:
            slen = struct.unpack(">H", data[off:off + 2])[0]
            off += 2
            remaining -= 2 + slen
            off += slen
        elif key == 3:
            off += 2
            remaining -= 2
        elif key == 4:
            off += 8
            remaining -= 8
        else:
            off += 4
            remaining -= 4
        if remaining < 0:
            return None, 0
    f = {"kind": kind, "seq": seq, "cmd": cmd, "flags": flags,
         "body": data[off:off + remaining]}
    return f, total


# ============= protobuf helpers =============

def _varint(v: int) -> bytes:
    out = b""
    while True:
        b = v & 0x7F
        v >>= 7
        out += bytes([b | (0x80 if v else 0)])
        if not v:
            return out


def pb_str(idx: int, s) -> bytes:
    b = s.encode() if isinstance(s, str) else s
    return bytes([idx << 3 | 2]) + _varint(len(b)) + b


def pb_uint(idx: int, v: int) -> bytes:
    return bytes([idx << 3 | 0]) + _varint(v)


def pb_bool(idx: int, v: bool) -> bytes:
    return pb_uint(idx, 1 if v else 0)


def pb_flat(msg: bytes) -> List[Tuple[int, int, Any]]:
    """schemaless protobuf 解码 → [(field, wiretype, value)]"""
    out, i = [], 0
    while i < len(msg):
        tag = 0
        shift = 0
        while True:
            b = msg[i]
            i += 1
            tag |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        fno, wt = tag >> 3, tag & 7
        if wt == 0:
            v = 0
            shift = 0
            while True:
                b = msg[i]
                i += 1
                v |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            out.append((fno, wt, v))
        elif wt == 2:
            ln = 0
            shift = 0
            while True:
                b = msg[i]
                i += 1
                ln |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            out.append((fno, wt, msg[i:i + ln]))
            i += ln
        elif wt == 5:
            if len(msg) - i < 4:
                break
            out.append((fno, wt, struct.unpack("<f", msg[i:i + 4])[0]))
            i += 4
        elif wt == 1:
            if len(msg) - i < 8:
                break
            out.append((fno, wt, struct.unpack("<q", msg[i:i + 8])[0]))
            i += 8
        else:
            break
    return out


# ============= 证书 =============

_p12_password = b"kaipan_ios_2026"


def ensure_cert_pems(static_dir: str, data_dir) -> Tuple[str, str]:
    """从打包的 kgT.p12 导出 PEM 到数据目录（首次一次），返回 (cert_path, key_path)"""
    cert_p = data_dir / "kpl_client_cert.pem"
    key_p = data_dir / "kpl_client_key.pem"
    if cert_p.exists() and key_p.exists():
        return str(cert_p), str(key_p)
    # cryptography 42+ 把 pk12 loader 移到独立子模块，老版本从 serialization 根导入
    try:
        from cryptography.hazmat.primitives.serialization.pkcs12 import load_key_and_certificates
    except ImportError:
        from cryptography.hazmat.primitives.serialization import load_key_and_certificates
    from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat
    p12 = open(os.path.join(static_dir, "kpl_kgT.p12"), "rb").read()
    key, cert, _extra = load_key_and_certificates(p12, _p12_password)
    cert_p.write_bytes(cert.public_bytes(Encoding.PEM))
    key_p.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()))
    return str(cert_p), str(key_p)


from cryptography.hazmat.primitives.serialization import NoEncryption  # noqa: E402


# ============= frida 白盒签名桥 =============

SIGN_JS = r"""
Java.perform(function () {
    var _baxInit = false;
    var SR = Java.use('com.yzj.kaipanh.newindex.data.SocketRepository');
    rpc.exports = {
        ping: function () { return 'pong'; },
        sign: function (challenge, deviceid, conntype, curtime) {
            try {
                if (!_baxInit) {
                    var app = Java.use('com.yzj.kaipanh.MyApplication').getInstance();
                    SR.initBaxPwd(app.getApplicationContext().getAssets());
                    _baxInit = true;
                }
                var sig = SR.whiteBoxEncrypt(challenge, deviceid, conntype, curtime);
                var b = new Uint8Array(sig);
                var hex = '';
                for (var i = 0; i < b.length; i++) hex += ('0' + b[i].toString(16)).slice(-2);
                return hex;
            } catch (e) { return 'ERR ' + e; }
        },
    };
});
"""

ADB_PATH = r"C:\Users\mark\AppData\Local\Android\Sdk\platform-tools\adb.exe"
ADB_SERIAL = "emulator-5554"
APP_PKG = "com.aiyu.kaipanla"


class FridaBridge:
    """attach 模拟器内开盘啦进程，借白盒签名"""

    def __init__(self):
        self._session = None
        self._exp = None
        self._lock = threading.Lock()

    def _adb_shell(self, cmd: str) -> str:
        import subprocess
        try:
            r = subprocess.run([ADB_PATH, "-s", ADB_SERIAL, "shell", cmd],
                               capture_output=True, text=True, timeout=10)
            return r.stdout or ""
        except Exception:
            return ""

    def ensure(self) -> bool:
        """确保已 attach 到 App 真身并加载签名脚本。成功返回 True"""
        with self._lock:
            if self._exp is not None:
                try:
                    if self._exp.ping() == "pong":
                        return True
                except Exception:
                    self._session = None
                    self._exp = None
            try:
                import frida
                import subprocess as sp
                sp.run([ADB_PATH, "-s", ADB_SERIAL, "forward", "tcp:9876", "tcp:27042"],
                       capture_output=True, timeout=10)
                dev = frida.get_device_manager().add_remote_device("127.0.0.1:9876")
                # 找 App 主进程并杀壳守护
                rows = [l.split() for l in
                        self._adb_shell("ps -A -o PID,PPID,NAME | grep 'kaipanla$'").splitlines()
                        if len(l.split()) >= 3]
                main = next((r[0] for r in rows if r[2] == APP_PKG and int(r[1]) < 1000), None)
                if not main:
                    self._adb_shell(f"monkey -p {APP_PKG} -c android.intent.category.LAUNCHER 1")
                    time.sleep(8)
                    rows = [l.split() for l in
                            self._adb_shell("ps -A -o PID,PPID,NAME | grep 'kaipanla$'").splitlines()
                            if len(l.split()) >= 3]
                    main = next((r[0] for r in rows if r[2] == APP_PKG and int(r[1]) < 1000), None)
                    if not main:
                        logger.warning("KPL frida: App 主进程未找到")
                        return False
                tracer = next((r[0] for r in rows if r[2] == APP_PKG and r[1] == main), None)
                if tracer:
                    self._adb_shell(f"kill -9 {tracer}")
                session = dev.attach(int(main))
                script = session.create_script(SIGN_JS)
                script.load()
                self._session = session
                self._exp = script.exports_sync if hasattr(script, "exports_sync") else script.exports
                logger.info("KPL frida: 已 attach 并加载签名桥")
                return True
            except Exception as e:
                logger.warning(f"KPL frida attach 失败: {e}")
                self._session = None
                self._exp = None
                return False

    def sign(self, challenge: str, device_id: str, conn_type: str, server_time: str,
             timeout_s: float = 45) -> Optional[str]:
        """借 App 白盒签名。先确保 App 在跑，attach 后签名（挑战时效数秒）"""
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            if not self.ensure():
                # App 可能没跑，拉起后重试
                time.sleep(4)
                continue
            try:
                r = self._exp.sign(challenge, device_id, conn_type, server_time)
                if r and not str(r).startswith("ERR") and str(r) != "NULL" and len(r) > 20:
                    return str(r)
                logger.debug(f"KPL 签名异常输出: {str(r)[:60]}")
            except Exception as e:
                logger.debug(f"KPL 签名调用失败: {e}")
                self._session = None
                self._exp = None
            time.sleep(1)
        return None


_frida_bridge: Optional[FridaBridge] = None
_frida_lock = threading.Lock()


def get_frida_bridge() -> FridaBridge:
    global _frida_bridge
    with _frida_lock:
        if _frida_bridge is None:
            _frida_bridge = FridaBridge()
        return _frida_bridge


# ============= Socket 会话 =============

class KplSocketSession:
    """长连接会话：TLS(mTLS) → 260挑战 → frida签名 → 610鉴权 → 心跳 → 业务RPC"""

    def __init__(self, device_id: str, static_dir: str, data_dir):
        self.device_id = device_id
        self.static_dir = static_dir
        self.data_dir = data_dir
        self.sock: Optional[ssl.SSLSocket] = None
        self._seq = 0
        self._seq_lock = threading.Lock()
        self._pending: Dict[Any, Dict[str, Any]] = {}
        self._pushes: List[Dict[str, Any]] = []
        self._recv_thread: Optional[threading.Thread] = None
        self._hb_thread: Optional[threading.Thread] = None
        self._alive = False
        self._lock = threading.Lock()

    @property
    def alive(self) -> bool:
        return self._alive and self.sock is not None

    def _next_seq(self) -> int:
        with self._seq_lock:
            self._seq = self._seq % 32767 + 1
            return self._seq

    # ---- 连接 ----

    def _resolve_server(self) -> Optional[Tuple[str, int]]:
        try:
            import httpx
            r = httpx.get("https://getsockip.kaipanla.com/getIPList",
                          params={"PhoneOSNew": "1", "DeviceID": self.device_id,
                                  "VerSion": "6.3.20.0"}, timeout=8)
            iplist = r.json().get("ipList") or []
            # 优先 8080 端口
            for item in iplist:
                ip, _, port = item.partition(":")
                if port == "8080":
                    return ip, 8080
            if iplist:
                ip, _, port = iplist[0].partition(":")
                return ip, int(port or 8080)
        except Exception as e:
            logger.debug(f"KPL getIPList 失败: {e}")
        return ("124.71.166.244", 8080)  # 兜底

    def connect(self) -> bool:
        """TLS 连接 + 挑战 + frida 签名 + 鉴权。成功返回 True"""
        from config import config
        cert_p, key_p = ensure_cert_pems(self.static_dir, self.data_dir)
        server = self._resolve_server()
        if not server:
            return False
        host, port = server
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(cert_p, key_p)
        raw = socket.create_connection((host, port), timeout=10)
        self.sock = ctx.wrap_socket(raw, server_hostname="socket.kaipan.com")
        self.sock.settimeout(3)
        self._alive = True

        # 挑战
        ch_data = self._recv_challenge(timeout_s=6)
        if not ch_data:
            self.close()
            return False
        challenge, server_time = ch_data

        # frida 白盒签名
        bridge = get_frida_bridge()
        sig = bridge.sign(challenge, self.device_id, "99", str(server_time))
        if not sig:
            self.close()
            logger.warning("KPL Socket: 白盒签名失败（需要模拟器运行开盘啦App）")
            return False

        # 鉴权
        req = (pb_str(1, self.device_id) + pb_uint(2, 1) + pb_str(3, "6.3.20.0")
               + pb_uint(4, 129) + pb_str(5, sig) + pb_str(6, "0") + pb_str(7, "0")
               + pb_uint(8, 99) + pb_str(10, "w48") + pb_uint(11, 0))
        self.sock.sendall(build_frame(610, req, kind=3, seq=self._next_seq(), flags=0))
        resp = self._wait_cmd(610, timeout_s=5)
        if resp is None:
            self.close()
            logger.warning("KPL Socket: 鉴权无响应（签名可能已毒化或超时）")
            return False
        # 启动心跳
        self._hb_thread = threading.Thread(target=self._heartbeat, daemon=True)
        self._hb_thread.start()
        logger.info(f"KPL Socket: 已鉴权连接 {host}:{port}")
        return True

    def ensure_connected(self) -> bool:
        if self.alive:
            return True
        with self._lock:
            if self.alive:
                return True
            return self.connect()

    def _recv_challenge(self, timeout_s: float) -> Optional[Tuple[str, int]]:
        buf = b""
        end = time.time() + timeout_s
        while time.time() < end:
            try:
                d = self.sock.recv(65536)
                if not d:
                    break
                buf += d
            except socket.timeout:
                continue
            except Exception:
                break
            f, _ = try_parse_frame(buf)
            if f and f["cmd"] == 260:
                server_time, challenge = 0, None
                for fno, wt, v in pb_flat(f["body"]):
                    if fno == 1:
                        server_time = v
                    elif fno == 2:
                        challenge = v.decode() if isinstance(v, bytes) else str(v)
                if challenge:
                    return challenge, server_time
        return None

    def _wait_cmd(self, cmd: int, timeout_s: float, seq: Optional[int] = None) -> Optional[bytes]:
        buf = b""
        end = time.time() + timeout_s
        while time.time() < end:
            try:
                d = self.sock.recv(65536)
                if not d:
                    break
                buf += d
            except socket.timeout:
                continue
            except Exception:
                self._alive = False
                break
            pos = 0
            while pos < len(buf):
                f, consumed = try_parse_frame(buf[pos:])
                if f is None:
                    break
                pos += consumed
                if f["cmd"] == 110:
                    for fno, wt, v in pb_flat(f["body"]):
                        if fno == 1:
                            logger.warning(f"KPL Socket 错误响应 code={v}")
                    if cmd != 110:
                        return None
                if f["cmd"] == cmd and (seq is None or f.get("seq") == seq):
                    return f["body"]
            buf = buf[pos:]
        return None

    def _heartbeat(self):
        while self._alive:
            time.sleep(7)
            if not self._alive:
                break
            try:
                self.sock.sendall(build_frame(13, b"", kind=1))
            except Exception:
                self._alive = False
                break

    def rpc(self, cmd: int, body: bytes, timeout_s: float = 6) -> Optional[bytes]:
        """业务 RPC（kind=4）。失败返回 None"""
        if not self.ensure_connected():
            return None
        with self._lock:
            try:
                self.sock.sendall(build_frame(cmd, body, kind=4, seq=self._next_seq()))
            except Exception as e:
                logger.warning(f"KPL Socket 发送失败: {e}")
                self._alive = False
                return None
            return self._wait_cmd(cmd, timeout_s=timeout_s)

    def close(self):
        self._alive = False
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        self.sock = None


# ============= 业务封装（数据面） =============

class KplSocketAPI:
    """基于会话的业务查询。会话失败自动重连一次"""

    def __init__(self, device_id: str, static_dir: str, data_dir):
        self.device_id = device_id
        self.static_dir = static_dir
        self.data_dir = data_dir
        self._session: Optional[KplSocketSession] = None
        self._lock = threading.Lock()

    def _session_rpc(self, cmd: int, body: bytes, timeout_s: float = 6) -> Optional[bytes]:
        with self._lock:
            for attempt in (1, 2):
                try:
                    if not self._session or not self._session.alive:
                        if attempt == 1 and not get_frida_bridge().ensure():
                            return None  # 模拟器/App不在，直接降级
                        self._session = KplSocketSession(self.device_id, self.static_dir, self.data_dir)
                    resp = self._session.rpc(cmd, body, timeout_s)
                    if resp is not None:
                        return resp
                except Exception as e:
                    logger.debug(f"KPL Socket RPC {cmd} 尝试{attempt}: {e}")
                self._session = None  # 强制重建会话
        return None

    # ---- 板块详情：股票池（龙一排序+全字段行情） ----

    def get_sector_pool(self, plate_id: str, quota_type: int = 2, count: int = 50) -> Optional[Dict[str, Any]]:
        """cmd 2501: 板块股票池。quotaType=2 涨幅降序（即App默认龙一排序）"""
        body = (pb_str(1, plate_id) + pb_uint(2, quota_type) + pb_uint(3, 0)
                + pb_uint(4, 0) + pb_uint(5, 0) + pb_uint(6, 0) + pb_uint(7, count)
                + pb_uint(8, 0) + pb_uint(9, 0) + pb_uint(10, 0) + pb_bool(11, False))
        resp = self._session_rpc(2501, body)
        if resp is None:
            return None
        # 剥主题头：定位 plateId 字符串后开始 protobuf 解析
        marker = plate_id.encode()
        j = resp.find(marker)
        if j >= 0:
            resp = resp[max(0, j - 2):]
        out: Dict[str, Any] = {"items": []}
        for fno, wt, v in pb_flat(resp):
            if fno == 11:
                out["total"] = v
            elif fno == 22:
                row, quotas = {}, []
                for f2, wt2, v2 in pb_flat(v):
                    if f2 == 100:
                        quotas.append(v2.decode("utf8", "replace"))
                    elif f2 == 150:
                        quotas.append("F:" + v2.decode("utf8", "replace"))
                    elif wt2 == 2:
                        row[f2] = v2.decode("utf8", "replace")
                    else:
                        row[f2] = v2
                row["quotas"] = quotas
                out["items"].append(row)
        return out

    # ---- 自选/组合行情批量 ----

    def get_stock_quotes(self, codes: List[str]) -> Optional[List[Dict[str, Any]]]:
        """cmd 3001: 自选/组合行情列表（items 同 2501.Item 结构）"""
        body = b"".join(pb_str(10, code) for code in codes[:50])
        resp = self._session_rpc(3001, body)
        if resp is None:
            return None
        items = []
        for fno, wt, v in pb_flat(resp):
            if fno == 10:
                row = {}
                for f2, wt2, v2 in pb_flat(v):
                    if f2 == 100:
                        row["quotas"] = v2.decode("utf8", "replace")
                    elif wt2 == 2:
                        row[f2] = v2.decode("utf8", "replace")
                    else:
                        row[f2] = v2
                items.append(row)
        return items

    # ---- 题材库 ----

    def get_themes(self) -> Optional[List[Dict[str, Any]]]:
        """cmd 3009: 题材库全量"""
        resp = self._session_rpc(3009, b"")
        if resp is None:
            return None
        themes = []
        for off in range(0, min(4000, len(resp))):
            try:
                ff = pb_flat(resp[off:])
                if sum(1 for f, wt, v in ff if f == 10) > 3:
                    for fno, wt, v in ff:
                        if fno == 10:
                            row, concepts = {}, []
                            for f3, wt3, v3 in pb_flat(v):
                                if f3 == 13:
                                    concepts.append({
                                        f4: (v4.decode("utf8", "replace") if isinstance(v4, bytes) else v4)
                                        for f4, wt4, v4 in pb_flat(v3)})
                                elif isinstance(v3, bytes) and wt3 == 2:
                                    row[f3] = v3.decode("utf8", "replace")
                                else:
                                    row[f3] = v3
                            row["concepts"] = concepts[:3]
                            themes.append(row)
                    break
            except Exception:
                continue
        return themes

    def get_theme_stat(self, theme_id: int) -> Optional[Dict[str, Any]]:
        """cmd 3010: 题材个股统计"""
        resp = self._session_rpc(3010, pb_uint(1, theme_id))
        if resp is None:
            return None
        out: Dict[str, Any] = {"id": theme_id, "classes": []}
        for fno, wt, v in pb_flat(resp):
            if fno == 2:
                out["stock_num"] = v
            elif fno == 3:
                out["up_num"] = v
            elif fno == 4:
                out["down_num"] = v
            elif fno == 6:
                key, val = None, {}
                for f2, wt2, v2 in pb_flat(v):
                    if f2 == 1:
                        key = v2
                    elif f2 == 2:
                        for f3, wt3, v3 in pb_flat(v2):
                            val[f3] = round(v3, 2) if f3 == 5 else v3
                if key is not None:
                    out["classes"].append({"key": key, **val})
        return out

    # ---- 指数简略行情 ----

    def get_index_simple(self, codes: List[str]) -> Optional[List[Dict[str, Any]]]:
        """cmd 3006: 指数简略行情（多只）"""
        body = b"".join(pb_str(1, code) for code in codes)
        resp = self._session_rpc(3006, body)
        if resp is None:
            return None
        items = []
        for fno, wt, v in pb_flat(resp):
            if fno == 1:
                row = {f2: (v2.decode("utf8", "replace") if isinstance(v2, bytes) else v2)
                       for f2, wt2, v2 in pb_flat(v)}
                items.append(row)
        return items


_kpl_sock: Optional[KplSocketAPI] = None


def get_kpl_socket() -> KplSocketAPI:
    global _kpl_sock
    if _kpl_sock is None:
        from config import config
        from storage import storage
        static_dir = os.path.join(os.path.dirname(__file__), "static")
        _kpl_sock = KplSocketAPI(config.get("kpl_device_id") or "",
                                 static_dir, storage.data_dir)
    return _kpl_sock
