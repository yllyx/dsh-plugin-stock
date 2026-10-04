# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:/deepseek-proj/stock-all/dsh-stock-plugin/plugin/backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from kpl_signer_py import EmuError
emu = K.KplSoEmu(".", verbose=False)
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "112233445566778899aabbccddeeff00")),
              emu._reg_handle(("jstring", "ffffffff-2222-4444-8888-cccc00001111")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1780001234")))
    print("=== ENC OK（意外）")
except EmuError as e:
    pass
def rd(a, n):
    return bytes(emu.uc.mem_read(a, n))
# golden 值从 memcpy 监视点附近提取：tag@0x401effb0、ct@0x50047980
print("IV-chal:", "112233445566")
print("tag:", rd(0x401effb0, 16).hex())
print("ct:", rd(0x50047980, 80).hex())
