# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu, EmuError
emu = KplSoEmu(".", verbose=True)
try:
    emu.init_bax_pwd()
    h = emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
                  emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
                  emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
                  emu._reg_handle(("jstring", "99")),
                  emu._reg_handle(("jstring", "1789963509")))
    print("ENC OK R0=", hex(h), flush=True)
except EmuError as e:
    print("ENC 崩（预期内）:", str(e)[:120], flush=True)

def rd(a, n):
    try:
        return bytes(emu.uc.mem_read(a, n))
    except Exception:
        return b"?"
# EncryptUpdate out=0x50047980 outl 在栈 0x401eff38；Final tag=0x500479c0
outl = struct.unpack("<I", rd(0x401eff38, 4))[0] if isinstance(rd(0x401eff38, 4), bytes) else 0
import struct as _s
try:
    outl = _s.unpack("<I", rd(0x401eff38, 4))[0]
except Exception:
    outl = 67
print("outl =", outl, flush=True)
print("密文(0x50047980):", rd(0x50047980, min(outl, 80)).hex() if outl else "?", flush=True)
print("tag(0x500479c0):", rd(0x500479c0, 16).hex(), flush=True)
# wrapper 里 std::string 结果（c_str）——未知地址，跳过
# 检查最后 NewByteArray 的对象
outs = [(h2, v) for h2, v in emu.objects.items() if isinstance(v, tuple) and v[0] == "out" and v[1]]
for h2, v in outs[-5:]:
    print(f"out handle {h2:#x}: len={len(v[1])} hex={bytes(v[1]).hex()[:200]}", flush=True)
