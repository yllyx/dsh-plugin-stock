# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu, EmuError
emu = KplSoEmu(".", verbose=True)
emu.init_bax_pwd()
n0 = len(emu.magic_log)
h = emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
print("ENC 返回 R0 =", hex(h), flush=True)
print("objects[h] =", emu.objects.get(h), flush=True)
names = emu._magic_name
print("=== ENC 段 magic 序列 ===", flush=True)
for kind, addr, ret in emu.magic_log[n0:]:
    print("  ", names.get(addr, kind + "?" + hex(addr)), "->",
          hex(ret) if isinstance(ret, int) else ret, flush=True)
