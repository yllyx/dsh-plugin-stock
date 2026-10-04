# -*- coding: utf-8 -*-
"""开盘啦 socket 签名 —— 纯 Python 白盒 SM4-GCM 复现（无 JVM / 无 unicorn / 无子进程）

算法全案（2026-10-02 从 libauthSign_armv7_patched.so 算法级逆向，全部逐位对拍验证）：
- 白盒 SM4：ctx 表 283KB（middle_new.bin 经 set_key 变换后的常量，固化 wb_ctx_dump.bin）
- 块加密 wb_block(in16)：头 4 仿射(表 0x5280/0x5304/0x5388/0x540c，mask=BE word)
  → 32 轮 [4 通道仿射(轮表序列 tbl_seq) + S 盒(表 ctx+0x66a0+轮*0x2000)
  + 第 5 仿射(输入=S 输出) 产新状态 d^e] → 尾 4 仿射(通道序 Q3,Q0,Q1,Q2)
- 仿射 affineU32：TAB_A[256] 真值表 + bit 基（0x80000000>>i），返回 acc^bias
- GCM：H=wb_block(0^16)；E(J0)=wb_block(IV||1)；密文块 n keystream =
  wb_block(IV||(n+2)) 的 word 反转（首块 IV||2，NIST incr(J0)）；部分块取前 len 字节
- tag：GHASH 终态(无 AAD，len 块=大端(0,len*8)) ⊕ word反转(E(J0))。
  GHASH 域乘为魔改实现（不走标准 GF(2^128)），以 128 次单位向量观测固化为线性矩阵
  ghash_matrix.json（128×16B 列），对任意输入通用
- 签名布局（95B）：challenge[:12](ASCII, 即 IV) + 密文(与明文等长) + tag(16)
- 明文组装：kp26 + deviceId + "1" + "6.3.20.0" + channelID(129) + connType + serverTime + "w48"
"""
import os
import struct
import json

_DIR = os.path.dirname(os.path.abspath(__file__))
_CTX = None
_TAB_A = None
_TBL_SEQ = None
_M_COLS = None


def _init():
    global _CTX, _TAB_A, _TBL_SEQ
    if _CTX is not None:
        return
    with open(os.path.join(_DIR, "wb_ctx_dump.bin"), "rb") as f:
        _CTX = f.read()
    with open(os.path.join(_DIR, "tab_a.bin"), "rb") as f:
        _TAB_A = struct.unpack("<256I", f.read())
    with open(os.path.join(_DIR, "tbl_seq.json")) as f:
        _TBL_SEQ = json.load(f)
    missing = [i for i, v in enumerate(_TBL_SEQ) if v is None]
    if missing:
        raise RuntimeError(f"tbl_seq 有未解析项: {missing[:5]}")


def _u32(off):
    return struct.unpack_from("<I", _CTX, off)[0]


def _affine(base, mask):
    r = struct.unpack_from("<4I", _CTX, base)
    stk = struct.unpack_from("<29I", _CTX, base + 0x10)
    work = list(r) + list(stk[:28])
    acc = 0
    for i in range(32):
        m = work[i] & mask
        m ^= m >> 16
        idx = (m & 0xFF) ^ ((m >> 8) & 0xFF)
        if _TAB_A[idx & 0xFF]:
            acc ^= 0x80000000 >> i
    return (acc ^ stk[28]) & 0xFFFFFFFF


def _sbox(x, sb):
    r7 = 0x66A0
    return (_u32(r7 + ((x & 0xFF) * 8) + sb + 0x804)
            ^ _u32(r7 + ((x >> 5) & 0x7F8) + sb + 4)
            ^ _u32(r7 + ((x >> 13) & 0x7F8) + sb - 0x7FC)
            ^ _u32(r7 + ((x >> 21) & 0xFFFFFFF8) + sb - 0xFFC))


_HEAD = (0x5280, 0x5304, 0x5388, 0x540C)


def wb_block(in16: bytes) -> bytes:
    """白盒 SM4 单块加密（16B → 16B），与 so 内 wbsm4_wsise_encrypt 逐位等价。"""
    _init()
    wbw = list(struct.unpack(">4I", in16))
    h = [_affine(_HEAD[j], wbw[j]) for j in range(4)]
    q = [h[1], h[2], h[3], h[0]]
    for r in range(32):
        bi = 4 + r * 5
        a = _affine(_TBL_SEQ[bi + 0], q[0])
        b = _affine(_TBL_SEQ[bi + 1], q[1])
        c = _affine(_TBL_SEQ[bi + 2], q[2])
        d = _affine(_TBL_SEQ[bi + 3], q[3])
        nw = _sbox(a ^ b ^ c, r * 0x2000)
        e = _affine(_TBL_SEQ[bi + 4], nw)
        q = [q[1], q[2], d ^ e, q[0]]
    outs = [_affine(_TBL_SEQ[164 + k], q[(3, 0, 1, 2)[k]]) for k in range(4)]
    return b"".join(struct.pack(">I", x) for x in outs)


def build_plain(device_id: str, conn_type: str, server_time: str) -> bytes:
    return ("kp26" + device_id + "1" + "6.3.20.0" + "129" + conn_type
            + server_time + "w48").encode()


def encrypt_gcm_ct(iv12: bytes, plaintext: bytes) -> bytes:
    """密文 = 明文 ⊕ keystream；keystream 块 n（0 起）= wb_block(iv12 || be32(n+2)) 的
    word 序反转（大端 w3w2w1w0），部分块取前 len 字节。"""
    _init()
    out = bytearray()
    n_blocks = (len(plaintext) + 15) // 16
    for n in range(n_blocks):
        ctr = iv12 + struct.pack(">I", n + 2)
        w = struct.unpack(">4I", wb_block(ctr))
        ks = struct.pack(">4I", w[3], w[2], w[1], w[0])
        chunk = plaintext[16 * n:16 * n + 16]
        out.extend(p ^ k for p, k in zip(chunk, ks))
    return bytes(out)


def _load_mcols():
    global _M_COLS
    if _M_COLS is None:
        with open(os.path.join(_DIR, "ghash_matrix.json")) as f:
            _M_COLS = [bytes.fromhex(h) for h in json.load(f)]
    return _M_COLS


def _ghash_mul_wb(x16: bytes) -> bytes:
    """魔改域乘（GF(2) 线性映射，矩阵列固化自 gcm_ghash_4bit 的 128 次单位向量观测）。"""
    cols = _load_mcols()
    v = int.from_bytes(x16, "little")
    acc = 0
    for bit in range(128):
        if (v >> bit) & 1:
            acc ^= int.from_bytes(cols[bit], "little")
    return acc.to_bytes(16, "little")


def ghash_tag(iv12: bytes, ct: bytes, ej0: bytes) -> bytes:
    """tag = GHASH 终态(无 AAD，len 块=大端(0,len*8)) ⊕ word反转(E(J0))。"""
    _load_mcols()
    x = bytes(16)
    data = ct
    pad = (16 - len(data) % 16) % 16
    if pad:
        data = data + bytes(pad)
    for i in range(0, len(data), 16):
        x = bytes(p ^ q for p, q in zip(x, data[i:i + 16]))
        x = _ghash_mul_wb(x)
    x = bytes(p ^ q for p, q in zip(x, struct.pack(">QQ", 0, len(ct) * 8)))
    x = _ghash_mul_wb(x)
    w = struct.unpack(">4I", ej0)
    ek0r = struct.pack(">4I", w[3], w[2], w[1], w[0])
    return bytes(p ^ q for p, q in zip(x, ek0r))


def white_box_sign(challenge: str, device_id: str, conn_type: str,
                   server_time: str) -> bytes:
    """签名（95B）= challenge[:12] + GCM 密文 + tag(16)。"""
    iv12 = challenge[:12].encode()
    pt = build_plain(device_id, conn_type, server_time)
    ct = encrypt_gcm_ct(iv12, pt)
    ej0 = wb_block(iv12 + struct.pack(">I", 1))   # E(J0)
    tag = ghash_tag(iv12, ct, ej0)
    return iv12 + ct + tag


if __name__ == "__main__":
    _init()
    g = json.load(open(os.path.join(_DIR, "golden.json")))
    h = wb_block(bytes(16))
    assert h.hex() == g["H_wb"], f"H 不匹配: {h.hex()}"
    ct = encrypt_gcm_ct(g["iv"].encode(), g["plaintext"].encode())
    assert ct.hex() == g["ciphertext"], f"密文不匹配:\n{ct.hex()}\n{g['ciphertext']}"
    sig = white_box_sign(g["challenge"], g["device_id"], g["conn_type"], g["server_time"])
    assert len(sig) == g["sig_len"], f"sig 长度 {len(sig)} != 95"
    assert sig[-16:].hex() == g["tag"], f"tag 不匹配: {sig[-16:].hex()} != {g['tag']}"
    print(f"[kpl_sign_whitebox] 全链自校验通过：H/密文/tag 逐位一致，sig 95B = {sig.hex()[:32]}...")
