# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu, EmuError
emu = KplSoEmu(".", verbose=False)
ctx_addr = [None]
orig_hook = emu._make_wb_hook
def wb_hook_maker(name):
    h = orig_hook(name)
    def h2(uc, a, s, ud):
        if name == "wb_set_key":
            ctx_addr[0] = uc.reg_read(uc.__class__.R1 if False else 1)  # 占位
        return h(uc, a, s, ud)
    return h2
# 直接用 WB hook 的 r 值打点
import kpl_signer_py as KK
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
except EmuError:
    pass
CTX = 0x500781c0
d = bytes(emu.uc.mem_read(CTX, 0x80000))
open("ctx_dump.bin", "wb").write(d)
nz = sum(1 for b in d if b)
print(f"ctx dump 0x6000B 非零 {nz}，已写 ctx_dump.bin")
# 表区概览：0x5280 / 0x5304 各 0x84
for off in (0x5280, 0x5304, 0x5388):
    print(f"ctx+{off:#x}: {d[off:off+32].hex()}")
# 尾部探测到多大
tail = 0
for off in range(0x80000 - 16, 0x40000, -16):
    if any(d[off:off+16]):
        tail = off + 16
        break
print("ctx 有效尾 ≈", hex(tail))
