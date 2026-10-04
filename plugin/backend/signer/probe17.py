# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
emu = K.KplSoEmu(".", verbose=True)
n0 = len(emu.magic_log)
nb = emu.write_cstr("default")
r1 = emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
print("add_builtin ->", hex(r1))
n1 = len(emu.magic_log)
r = emu._call(0x196174, 0, nb, 1, arm=True)
print("try_load ->", hex(r))
names = emu._magic_name
print("=== try_load 期间桩调用 ===")
for kind, addr, ret in emu.magic_log[n1:]:
    print("  ", names.get(addr, kind + "?" + hex(addr)), "->", hex(ret) if isinstance(ret, int) else ret)
