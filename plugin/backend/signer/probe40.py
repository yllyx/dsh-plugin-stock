# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:/deepseek-proj/stock-all/dsh-stock-plugin/plugin/backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from kpl_signer_py import EmuError
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *
emu = K.KplSoEmu(".", verbose=False)
ht_ptr = [None]
xi_ptr = [None]
def on_ghash(uc, a, s, ud):
    if ht_ptr[0] is None:
        ht_ptr[0] = uc.reg_read(UC_ARM_REG_R1)
        xi_ptr[0] = uc.reg_read(UC_ARM_REG_R0)
        print(f"Htable @ {ht_ptr[0]:#x}", flush=True)
emu.uc.hook_add(UC_HOOK_CODE, on_ghash, begin=emu.base + 0x1a2d30, end=emu.base + 0x1a2d30)
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
except EmuError:
    pass
HT = ht_ptr[0]
assert HT, "未捕获 Htable"
htable = bytes(emu.uc.mem_read(HT, 256))
open("htable.bin", "wb").write(htable)

# 矩阵观测：f(x) = gcm_ghash_4bit(xi=0, inp=x, len=16) 后的 Xi
def f(x16):
    xi = emu.heap_alloc(16); emu.uc.mem_write(xi, b"\x00" * 16)
    inp = emu.heap_alloc(16); emu.uc.mem_write(inp, x16)
    emu._call(0x1a2d30, xi, HT, inp, 16, arm=True)
    return bytes(emu.uc.mem_read(xi, 16))

# 采样基：观测 f 在 128 个单位 bit 上的值
Mcols = []
for bit in range(128):
    x = bytearray(16)
    x[bit // 8] |= 1 << (bit % 8)
    Mcols.append(f(bytes(x)))
# 检查线性：f(a)^f(b)==f(a^b)?
t1, t2, t3 = bytes(range(16)), bytes(16), b"\xff" * 16
assert bytes(p ^ q for p, q in zip(f(t1), f(t2))) == f(bytes(p ^ q for p, q in zip(t1, t2))), "非线性!"
assert bytes(p ^ q for p, q in zip(f(t3), f(t1))) == f(bytes(p ^ q for p, q in zip(t3, t1))), "非线性2"
def apply_M(x16):
    v = int.from_bytes(x16, "little")
    acc = 0
    for bit in range(128):
        if (v >> bit) & 1:
            acc ^= int.from_bytes(Mcols[bit], "little")
    return acc.to_bytes(16, "little")
print("M 矩阵构建完成，线性验证通过", flush=True)
import json
json.dump([c.hex() for c in Mcols], open("ghash_matrix.json", "w"))
json.dump(htable.hex(), open("htable_hex.txt", "w"))
# 快速验证 4 块序列
C64 = bytes.fromhex("43790152803f43624fa747960af31ff61f18301cb53bf1c5aee0d5bdc49e1267b1fc7a23dfa666f0d21660eb55a940cb5e85b522d9048a962cbfc768417ab7ce")
x = 0
for i in range(0, 64, 16):
    x ^= int.from_bytes(C64[i:i+16], "little")
    x = int.from_bytes(apply_M(x.to_bytes(16, "little")), "little")
print("重放 Xi(64B) =", x.to_bytes(16, "little").hex(), " 目标=38297b4da9287c1a1735cb852d4906c7", flush=True)
