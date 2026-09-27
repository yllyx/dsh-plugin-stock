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
import json
import os
import queue
import re
import subprocess
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
    # total = inner 长度（seq/cmd/flags/ext/body，不含 kind1B+本字段4B）——App 同款，服务器实测接受
    out = bytearray()
    out += struct.pack(">B", (kind << 4) | (subtype & 0xF))
    out += struct.pack(">I", len(buf))
    out += buf
    return bytes(out)


def try_parse_frame(data: bytes) -> Tuple[Optional[Dict[str, Any]], int]:
    if len(data) < 12:
        return None, 0
    b0 = data[0]
    kind = b0 >> 4
    if kind < 1 or kind > 6:
        return None, 0
    total = struct.unpack(">I", data[1:5])[0]
    # 帧实际长度 = 5(kind1+total4) + total(inner)
    if total < 5 or total > 32 * 1024 * 1024 or len(data) < 5 + total:
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
    off += 1
    remaining -= 1
    # ⚠ 帧头布局字节级对账结论（2026-09-23，3009+260 双帧实测）：
    #   kind2(挑战帧):   [kind1][total4][cmd2][rsv3]  body@10 —— body 首字节
    #     `08` = pb field1 varint serverTime(秒级) ✓
    #   kind4(数据帧):   [kind1][total4][seq2][cmd2][flags1][ext1]  body@11
    #     —— 3009 响应 body = `1b 03 00 18` mini头 + "global|..." ASCII 前缀
    #     (00 18 = 前缀长 24)，随后 protobuf。旧代码一律按"flags 后 2 字节
    #     extCount"读：3009 帧把 extCount(00)+body首字节(1b) 拼成 0x001b=27，
    #     再按"每 TLV 跳 4 字节"错跳 135B，把 body 最前面的置顶题材
    #     (AI硬件/地方国资)整段吞掉 → 题材库恒比 App 少两条
    if kind == 2:
        off += 2
        remaining -= 2
    else:
        ext_count = data[off]
        off += 1
        remaining -= 1
        if ext_count > 8:  # 正常帧无扩展或极少；异常值视为布局漂移，拒绝解析
            return None, 0
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
    return f, 5 + total


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


# ============= 内置白盒签名器（unidbg 离线模拟 libauthSign.so） =============

# 签名器部署物：backend/signer/{kplsigner.jar, lib/*.jar, kpl_min.apk, libauthSign_armv7_patched.so}
# 需要系统 Java 8+（java 在 PATH 或 JAVA_HOME）。签名仅在 socket 建连时需要一次（约2秒）。
SIGNER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "signer")
_warm_signer = None  # 常驻签名器子进程（_WarmSigner）


def _find_java() -> Optional[str]:
    """定位可用的 java：PATH 里的存根可能不可执行（Oracle java8path 已知问题），
    逐个候选执行 -version 校验，失败则尝试 JAVA_HOME 与常见安装目录的真实 JDK。"""
    import shutil
    cands = []
    p = shutil.which("java")
    if p and "Common Files\\Oracle" not in p:   # Oracle 存根优先级降低（排后仍校验）
        cands.append(p)
    cands.append(os.path.join(os.environ.get("JAVA_HOME", ""), "bin", "java.exe"))
    cands.append(r"D:\Program Files\Java\jdk-1.8\bin\java.exe")
    cands.append(r"C:\Program Files\Java\jdk-1.8\bin\java.exe")
    seen = set()
    import subprocess
    for cand in cands:
        if not cand or cand in seen or not os.path.isfile(cand):
            continue
        seen.add(cand)
        try:
            r = subprocess.run([cand, "-version"], capture_output=True, timeout=15)
            if r.returncode == 0:
                return cand
        except Exception:
            continue
    # 兜底：PATH 存根再试一次（万一可用）
    return p


_sign_lock = threading.Lock()  # 暖签名器 stdin/stdout 行协议非线程安全，单飞串行


def sign_local(challenge: str, device_id: str, conn_type: str, server_time: str,
               timeout_s: float = 120) -> Optional[str]:
    """白盒签名。优先常驻暖进程（JVM 只启一次, 后续签名 ~50ms）；
    暖进程失败回退单次调用。多线程并发调用必须串行（行协议会串包）。"""
    with _sign_lock:
        return _sign_local_impl(challenge, device_id, conn_type, server_time, timeout_s)


def _sign_local_impl(challenge: str, device_id: str, conn_type: str, server_time: str,
                     timeout_s: float) -> Optional[str]:
    global _warm_signer
    java = _find_java()
    if not java:
        logger.warning("KPL 签名器: 未找到 java（需要 Java 8+）")
        return None
    signer_jar = os.path.join(SIGNER_DIR, "kplsigner.jar")
    lib_dir = os.path.join(SIGNER_DIR, "lib")
    if not os.path.isfile(signer_jar):
        logger.warning("KPL 签名器: 部署物缺失 (signer/kplsigner.jar)")
        return None
    req = json.dumps({"challenge": challenge, "device_id": device_id,
                      "conn_type": conn_type, "server_time": str(server_time)})
    # 1) 常驻暖进程
    warm = _warm_signer
    if warm is not None and warm.alive():
        try:
            return warm.sign(req)
        except Exception as e:
            logger.debug(f"KPL 暖签名器异常, 重启: {str(e)[:80]}")
            try:
                warm.kill()
            except Exception:
                pass
            _warm_signer = None
    # 2) 启动暖进程并首签（首签含 JVM 启动 ~2s）
    cp = signer_jar + os.pathsep + os.pathsep.join(
        os.path.join(lib_dir, j) for j in sorted(os.listdir(lib_dir)) if j.endswith(".jar"))
    try:
        warm = _WarmSigner(java, cp, SIGNER_DIR)
        sig = warm.sign(req, timeout_s=timeout_s)
        if sig:
            _warm_signer = warm
            return sig
        warm.kill()
    except Exception as e:
        logger.debug(f"KPL 暖签名器启动失败: {str(e)[:100]}")
    # 3) 回退单次调用（无 cwd 依赖）
    try:
        r = subprocess.run([java, "-Xmx512m", "-cp", cp, "kplsigner.KplSigner"],
                           input=req.encode(), capture_output=True,
                           timeout=timeout_s, cwd=SIGNER_DIR)
        for line in r.stdout.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if line.startswith('{"sig"'):
                d = json.loads(line)
                if d.get("sig") and len(d["sig"]) > 20:
                    return str(d["sig"])
        logger.debug(f"KPL 签名器输出异常: {r.stdout.decode('utf-8', 'replace')[-200:]}")
        return None
    except Exception as e:
        logger.debug(f"KPL 签名器调用失败: {str(e)[:100]}")
        return None


class _WarmSigner:
    """常驻签名器子进程（stdin/stdout 行协议）"""

    def __init__(self, java: str, cp: str, cwd: str):
        self.proc = subprocess.Popen(
            [java, "-Xmx512m", "-cp", cp, "kplsigner.KplSigner"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=cwd)

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def kill(self):
        try:
            self.proc.kill()
        except Exception:
            pass

    def sign(self, req_line: str, timeout_s: float = 60) -> Optional[str]:
        # readline 无超时且 Java 子进程偶发卡死会永久阻塞（持锁饿死全部 socket 拉取），
        # 必须用读线程+队列实现真超时（2026-09-27 后端"永远拉不到新数据"的根因）
        self.proc.stdin.write((req_line + "\n").encode())
        self.proc.stdin.flush()
        q: "queue.Queue[str]" = queue.Queue()
        threading.Thread(target=lambda: q.put(self.proc.stdout.readline()), daemon=True).start()
        try:
            line = q.get(timeout=max(5.0, timeout_s)).decode("utf-8", "replace").strip()
        except queue.Empty:
            self.kill()
            raise RuntimeError(f"signer timeout after {timeout_s}s")
        if line.startswith('{"sig"'):
            d = json.loads(line)
            sig = d.get("sig")
            if sig and len(sig) > 20:
                return str(sig)
        raise RuntimeError(f"bad signer output: {line[:120]}")


def socket_signer_available() -> bool:
    """内置签名器是否可用（java + 部署物齐全）"""
    return _find_java() is not None and os.path.isfile(os.path.join(SIGNER_DIR, "kplsigner.jar"))


# ============= Socket 会话 =============

_last_good_server = None  # 上次鉴权成功的服务器（模块级, 进程内复用）


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

    def _resolve_servers(self) -> List[Tuple[str, int]]:
        """getIPList 动态服务器列表（8080 优先，去重保序）+ 兜底"""
        cands: List[Tuple[str, int]] = []
        try:
            import httpx
            r = httpx.get("https://getsockip.kaipanla.com/getIPList",
                          params={"PhoneOSNew": "1", "DeviceID": self.device_id,
                                  "VerSion": "6.3.20.0"}, timeout=8)
            iplist = r.json().get("ipList") or []
            for item in iplist:
                ip, _, port = item.partition(":")
                entry = (ip, int(port or 8080))
                if entry not in cands:
                    cands.append(entry)
            cands.sort(key=lambda hp: 0 if hp[1] == 8080 else 1)
            # 上次鉴权成功的服务器优先（跳过逐台试错扫描）
            if _last_good_server and _last_good_server in cands:
                cands.remove(_last_good_server)
                cands.insert(0, _last_good_server)
            elif _last_good_server:
                cands.insert(0, _last_good_server)
        except Exception as e:
            logger.debug(f"KPL getIPList 失败: {e}")
        for fallback in (("124.71.166.244", 8080), ("124.71.166.244", 80)):
            if fallback not in cands:
                cands.append(fallback)
        return cands

    def connect(self) -> bool:
        """TLS 连接 + 挑战 + 白盒签名 + 鉴权。逐服务器尝试（仅部分端口会推 260 挑战）。"""
        global _last_good_server
        from config import config
        cert_p, key_p = ensure_cert_pems(self.static_dir, self.data_dir)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(cert_p, key_p)

        for host, port in self._resolve_servers():
            try:
                raw = socket.create_connection((host, port), timeout=8)
                self.sock = ctx.wrap_socket(raw, server_hostname="socket.kaipan.com")
                self.sock.settimeout(3)
                self._alive = True
            except Exception as e:
                logger.debug(f"KPL dial {host}:{port} 失败: {str(e)[:60]}")
                continue

            # 挑战（80/14000 等端口可能不推挑战 → 换下一台）
            ch_data = self._recv_challenge(timeout_s=6)
            if not ch_data:
                logger.debug(f"KPL {host}:{port} 无挑战，换下一台")
                self.close()
                continue
            challenge, server_time = ch_data

            # 白盒签名：内置 unidbg 签名器（离线模拟 libauthSign.so，无模拟器/无网络依赖）
            sig = sign_local(challenge, self.device_id, "99", str(server_time))
            if not sig:
                self.close()
                logger.warning("KPL Socket: 离线签名失败（需 Java 8+ 且 signer 部署物完整）")
                return False

            # 鉴权（App 同款：登录态 UserID/Token，与 HTTP 数据面同一用户）
            from config import config as _cfg
            _uid = str(_cfg.get("kpl_user_id") or "0") or "0"
            _tok = str(_cfg.get("kpl_token") or "0") or "0"
            req = (pb_str(1, self.device_id) + pb_uint(2, 1) + pb_str(3, "6.3.20.0")
                   + pb_uint(4, 129) + pb_str(5, sig) + pb_str(6, _uid) + pb_str(7, _tok)
                   + pb_uint(8, 99) + pb_str(10, "w48") + pb_uint(11, 0))
            self.sock.sendall(build_frame(610, req, kind=3, seq=self._next_seq(), flags=0))
            resp = self._wait_cmd(610, timeout_s=5)
            if resp is None:
                self.close()
                logger.debug(f"KPL {host}:{port} 鉴权无响应，换下一台")
                continue
            # 启动心跳
            self._hb_thread = threading.Thread(target=self._heartbeat, daemon=True)
            self._hb_thread.start()
            global _last_good_server
            _last_good_server = (host, port)
            logger.info(f"KPL Socket: 已鉴权连接 {host}:{port}")
            return True
        return False

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
        # 大响应（2501/3009 可达 20KB+）会拆成多帧流式下发：收到首个匹配帧后
        # 再收 tail_s 静默窗口，把同 cmd 的后续帧 body 顺序拼接（2026-09-23
        # 2501 实测 23KB 分 4 帧到达，旧逻辑只回第一帧导致行情列大量缺失）
        tail_s = 0.8
        matched = bytearray()
        tail_end = None
        while time.time() < end:
            if tail_end is not None and time.time() >= tail_end:
                break
            try:
                d = self.sock.recv(65536)
                if not d:
                    break
                buf += d
            except socket.timeout:
                if tail_end is not None:
                    break
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
                    matched.extend(f["body"])
                    tail_end = time.time() + tail_s
            buf = buf[pos:]
        if matched:
            return bytes(matched)
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
                        self._session = KplSocketSession(self.device_id, self.static_dir, self.data_dir)
                    resp = self._session.rpc(cmd, body, timeout_s)
                    if resp is not None:
                        return resp
                except Exception as e:
                    logger.debug(f"KPL Socket RPC {cmd} 尝试{attempt}: {e}")
                self._session = None  # 强制重建会话
        return None

    # ---- 板块详情：股票池（龙一排序+全字段行情） ----

    def get_sector_pool(self, plate_id: str, quota_type: int = 2, count: int = 50,
                        start: int = 0) -> Optional[Dict[str, Any]]:
        """cmd 2501: 板块股票池。quotaType=2 涨幅降序（即App默认龙一排序）"""
        body = (pb_str(1, plate_id) + pb_uint(2, quota_type) + pb_uint(3, start)
                + pb_uint(4, 0) + pb_uint(5, 0) + pb_uint(6, 0) + pb_uint(7, count)
                + pb_uint(8, 0) + pb_uint(9, 0) + pb_uint(10, 0) + pb_bool(11, False))
        resp = self._session_rpc(2501, body)
        if resp is None:
            return None
        # 剥 ASCII 前缀：mini头+`hqList|.../801401:2:0:...`后才是 protobuf，
        # 扫描找 items(f22) 密集区起点（多帧拼接后前缀长度不定）
        out: Dict[str, Any] = {"items": [], "total": None}
        start = 0
        for off in range(0, min(120, len(resp))):
            try:
                ff = pb_flat(resp[off:])
                if sum(1 for f, w, v in ff if f == 22 and isinstance(v, bytes)) >= 3:
                    start = off
                    break
            except Exception:
                continue
        for fno, wt, v in pb_flat(resp[start:]):
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

    # ---- 人气榜 ----

    @staticmethod
    def _pop_item(v: bytes) -> Dict[str, Any]:
        """StockPopRankResp.Item: stockId1 name2 ratio3(float) rankChange4(uint64下溢负) num5
        isPop6 isContinuous7 ztReason8 lbStatus9 desc10 fullText11 tag12 tagList13 hotChange14 hotVal15 tagListV2(16)"""
        it: Dict[str, Any] = {"tags": []}
        for f2, wt2, v2 in pb_flat(v):
            if f2 == 1 and isinstance(v2, bytes):
                it["code"] = v2.decode("utf8", "replace")
            elif f2 == 2 and isinstance(v2, bytes):
                it["name"] = v2.decode("utf8", "replace")
            elif f2 == 3 and wt2 == 5:
                it["pct"] = round(v2, 2)
            elif f2 == 4 and wt2 == 0:
                it["rank_change"] = v2 - (1 << 64) if v2 >= (1 << 63) else v2
            elif f2 == 5 and wt2 == 0:
                it["num"] = v2
            elif f2 == 8 and isinstance(v2, bytes):
                it["zt_reason"] = v2.decode("utf8", "replace")
            elif f2 == 9 and isinstance(v2, bytes):
                it["lb_status"] = v2.decode("utf8", "replace")
            elif f2 == 10 and isinstance(v2, bytes):
                it["desc"] = v2.decode("utf8", "replace")
            elif f2 == 11 and isinstance(v2, bytes):
                it["full_text"] = v2.decode("utf8", "replace")
            elif f2 in (13, 16) and isinstance(v2, bytes):
                try:
                    tv = {}
                    for f4, w4, v4 in pb_flat(v2):
                        if f4 == 1 and isinstance(v4, bytes):
                            tv["value"] = v4.decode("utf8", "replace")
                        elif f4 == 2 and w4 == 0:
                            tv["color"] = v4
                    if tv.get("value") and f2 == 13:
                        it["tags"].append(tv)
                except Exception:
                    pass
            elif f2 == 14 and wt2 == 0:
                it["hot_change"] = v2
            elif f2 == 15 and wt2 == 0:
                it["hot_val"] = v2
        return it

    def get_pop_rank(self, type_: int = 1, order: int = 1, start: int = 0,
                     count: int = 50) -> Optional[Dict[str, Any]]:
        """cmd 3008: 股票人气排行（App 同源）。type=1 复盘人气榜（默认，最近完整交易日收盘排名），
        type=2 盘中人气榜（交易时段实时推送，盘后冻结）。order=服务端排序（三种排序由前端本地切换）。
        返回 {items, five_minute_items, day, timestamp(最后更新时间, 秒)}。"""
        body = pb_uint(1, type_) + pb_uint(2, order) + pb_uint(3, start) + pb_uint(4, count)
        resp = self._session_rpc(3008, body, timeout_s=12)
        if resp is None:
            return None
        out: Dict[str, Any] = {"items": [], "five_minute_items": [], "day": None, "timestamp": None}
        # ASCII 前缀形如 "global|26:20020/3008-0/{type}:{order}"，其后即 protobuf（f1 type 回显 0x08 起）
        m = re.search(rb"3008-0/\d+:\d+", resp)
        start_off = m.end() if m else 0
        for fno, wt, v in pb_flat(resp[start_off:]):
            if fno == 10 and isinstance(v, bytes):
                out["items"].append(self._pop_item(v))
            elif fno == 11 and isinstance(v, bytes):
                out["five_minute_items"].append(self._pop_item(v))
            elif fno == 5 and wt == 0:
                out["timestamp"] = v
            elif fno == 6 and isinstance(v, bytes):
                out["day"] = v.decode("utf8", "replace")
        return out

    # ---- 题材库 ----

    def get_themes(self) -> Optional[List[Dict[str, Any]]]:
        """cmd 3009: 题材库全量。返回 [{id,name,pinyin,hot,zt_num,pct,is_hot,up_num}]（服务端 raw 序=热度降序）"""
        resp = self._session_rpc(3009, b"", timeout_s=12)
        if resp is None:
            return None
        themes = []
        for off in range(0, min(200, len(resp))):
            try:
                ff = pb_flat(resp[off:])
                if sum(1 for f, wt, v in ff if f == 10 and isinstance(v, bytes)) > 3:
                    for fno, wt, v in ff:
                        if fno != 10 or not isinstance(v, bytes):
                            continue
                        it = {"concepts": []}
                        for f3, wt3, v3 in pb_flat(v):
                            if f3 == 1 and isinstance(v3, bytes):
                                it["id"] = v3.decode("utf8", "replace")
                            elif f3 == 2 and isinstance(v3, bytes):
                                it["name"] = v3.decode("utf8", "replace")
                            elif f3 == 4 and isinstance(v3, bytes):
                                it["pinyin"] = v3.decode("utf8", "replace")
                            elif f3 == 5 and wt3 == 0:
                                it["is_hot"] = v3        # 持续火爆标
                            elif f3 == 6 and wt3 == 0:
                                it["hot"] = v3           # 热度
                            elif f3 == 7 and wt3 == 0:
                                it["zt_num"] = v3        # 涨停数
                            elif f3 == 8 and wt3 == 0:
                                it["up_num"] = v3        # 上涨家数
                            elif f3 == 9 and wt3 == 0:
                                it["is_new"] = v3
                            elif f3 == 12 and wt3 == 5:
                                it["pct"] = round(v3, 2)
                            elif f3 == 12 and wt3 == 0:
                                it["pct"] = round(v3 / 100.0, 2)
                            elif f3 == 13 and isinstance(v3, bytes):
                                try:
                                    it["concepts"].append({
                                        str(f4): (v4.decode("utf8", "replace") if isinstance(v4, bytes) else v4)
                                        for f4, wt4, v4 in pb_flat(v3)})
                                except Exception:
                                    pass
                        if it.get("name"):
                            themes.append(it)
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
