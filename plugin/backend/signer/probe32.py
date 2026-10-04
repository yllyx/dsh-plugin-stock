# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu, EmuError
emu = KplSoEmu(".", verbose=False)
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
except EmuError:
    pass
def rd(a, n):
    return bytes(emu.uc.mem_read(a, n))
print("tag@0x401effb0:", rd(0x401effb0, 16).hex())
print("tag@0x500479c0:", rd(0x500479c0, 16).hex())
print("ct@0x50047980:", rd(0x50047980, 80).hex())
big = rd(0x500478e0, 0x800)
print("GCMCTX:", big.hex())
i = big.find(bytes.fromhex("7b7c30376a72476df38b567fc44f1bed"))
print("EK0@ctx+", hex(i) if i >= 0 else "未找到")
i2 = big.find(bytes.fromhex("e5dce5e7acf56429c11d172238e8b454"))
print("H@ctx+", hex(i2) if i2 >= 0 else "未找到")
