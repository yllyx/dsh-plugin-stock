# -*- coding: utf-8 -*-
"""SM4 + GCM 纯 Python 实现（无第三方依赖）。
SM4: GB/T 32907-2016；GCM: NIST SP 800-38D（128bit 块通用模式）。
仅用于白盒签名复原（kpl_sign_whitebox），性能足够签名级调用量。
"""


def _rotl(x, n):
    n %= 32
    return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF


_SM4_SBOX = bytes.fromhex(
    "d690e9fecce13db716b614c228fb2c052b679a762abe04c3aa441326498606999c4250f491ef987a33540b43edcfac62e4b31ca9c908e89580df94fa758f3fa64707a7fcf37317ba83593c19e6854fa8686b81b27164da8bf8eb0f4b70569d351e240e5e6358d1a225227c3b01217887d40046579fd327524c3602e7a0c4c89eeabf8ad240c738b5a3f7f2cef96115a1e0ae5da49b341a55ad933230f58cb1e31df6e22e8266ca60c02923ab0d534e6fd5db3745defd8e2f03ff6a726d6c5b518d1baf92bbddbc7f11d95c411f105ad80ac13188a5cd7bbd2d74d012b8e5b4b08969974a0c96777e65b9f109c56ec68418f07dec3adc4d2079ee5f3ed7cb3948")
SM4_SBOX = _SM4_SBOX

_SM4_FK = (0xA3B1BAC6, 0x56AA3350, 0x677D9197, 0xB27022DC)


def _sm4_ck():
    cks = []
    for i in range(32):
        row = []
        for j in range(4):
            row.append((4 * i + j) * 7 % 256)
        cks.append(row)
    return cks


_SM4_CK = _sm4_ck()


def _sm4_tau(b):
    return ((SM4_SBOX[(b >> 24) & 0xFF] << 24) | (SM4_SBOX[(b >> 16) & 0xFF] << 16) |
            (SM4_SBOX[(b >> 8) & 0xFF] << 8) | SM4_SBOX[b & 0xFF])


def _sm4_l_enc(b):
    return b ^ _rotl(b, 2) ^ _rotl(b, 10) ^ _rotl(b, 18) ^ _rotl(b, 24)


def _sm4_l_key(b):
    return b ^ _rotl(b, 13) ^ _rotl(b, 23)


def sm4_key_schedule(key: bytes):
    mk = [int.from_bytes(key[i * 4:i * 4 + 4], "big") for i in range(4)]
    k = [mk[i] ^ _SM4_FK[i] for i in range(4)]
    rk = []
    for i in range(32):
        tmp = k[1] ^ k[2] ^ k[3] ^ int.from_bytes(
            bytes(_SM4_CK[i]), "big")
        tmp = _sm4_tau(tmp)
        tmp = _sm4_l_key(tmp)
        new = k[0] ^ tmp
        rk.append(new)
        k = [k[1], k[2], k[3], new]
    return rk


def sm4_encrypt_block(rk, block: bytes) -> bytes:
    x = [int.from_bytes(block[i * 4:i * 4 + 4], "big") for i in range(4)]
    for i in range(32):
        tmp = x[1] ^ x[2] ^ x[3] ^ rk[i]
        tmp = _sm4_tau(tmp)
        tmp = _sm4_l_enc(tmp)
        new = x[0] ^ tmp
        x = [x[1], x[2], x[3], new]
    out = [x[3], x[2], x[1], x[0]]
    return b"".join(v.to_bytes(4, "big") for v in out)


# ---------- GCM（128bit 块通用） ----------

def _gf128_mul(x: int, y: int) -> int:
    # NIST SP 800-38D Algorithm 1（右移实现，R=0xE1）
    R = 0xE1000000000000000000000000000000
    z, v = 0, y
    for i in range(127, -1, -1):
        if (x >> i) & 1:
            z ^= v
        if v & 1:
            v = (v >> 1) ^ R
        else:
            v >>= 1
    return z


def ghash(h: bytes, aad: bytes, ct: bytes) -> bytes:
    def pad(b):
        p = (-len(b)) % 16
        return b + b"\x00" * p
    data = pad(aad) + pad(ct)
    data += (len(aad) * 8).to_bytes(8, "big") + (len(ct) * 8).to_bytes(8, "big")
    y = 0
    for i in range(0, len(data), 16):
        y ^= int.from_bytes(data[i:i + 16], "big")
        y = _gf128_mul(y, int.from_bytes(h, "big"))
    return y.to_bytes(16, "big")


class GCM:
    def __init__(self, encrypt_block_fn):
        self.enc = encrypt_block_fn

    def encrypt(self, key: bytes, iv: bytes, plaintext: bytes, aad: bytes = b""):
        h = self.enc(key, b"\x00" * 16)
        if len(iv) == 12:
            j0 = iv + b"\x00\x00\x00\x01"
        else:
            j0 = ghash(h, b"", iv)
        # CTR 加密（从 counter 1 开始）
        ct = bytearray()
        n = (len(plaintext) + 15) // 16
        for i in range(n):
            ctr = (int.from_bytes(j0, "big") + i + 1) & ((1 << 128) - 1)
            ks = self.enc(key, ctr.to_bytes(16, "big"))
            chunk = plaintext[i * 16:(i + 1) * 16]
            ct.extend(bytes(a ^ b for a, b in zip(chunk, ks)))
        tag = bytes(a ^ b for a, b in zip(ghash(h, aad, bytes(ct)), self.enc(key, j0)))
        return bytes(ct), tag

    def decrypt(self, key: bytes, iv: bytes, ct: bytes, tag: bytes, aad: bytes = b""):
        h = self.enc(key, b"\x00" * 16)
        if len(iv) == 12:
            j0 = iv + b"\x00\x00\x00\x01"
        else:
            j0 = ghash(h, b"", iv)
        pt = bytearray()
        n = (len(ct) + 15) // 16
        for i in range(n):
            ctr = (int.from_bytes(j0, "big") + i + 1) & ((1 << 128) - 1)
            ks = self.enc(key, ctr.to_bytes(16, "big"))
            chunk = ct[i * 16:(i + 1) * 16]
            pt.extend(bytes(a ^ b for a, b in zip(chunk, ks)))
        calc = bytes(a ^ b for a, b in zip(ghash(h, aad, ct), self.enc(key, j0)))
        ok = calc == tag
        return bytes(pt), ok
