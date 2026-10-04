# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

emu = K.KplSoEmu(".", verbose=False)
hits = []
def wb_hook(uc, address, size, ud):
    hits.append([uc.reg_read(UC_ARM_REG_R0 + i) for i in range(4)])
emu.uc.hook_add(UC_HOOK_CODE, wb_hook, begin=emu.base + 0x234ae4, end=emu.base + 0x234ae4)
nb = emu.write_cstr("default")
r1 = emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
print("add_builtin ->", hex(r1))
r = emu._call(0x196174, 0, nb, 1, arm=True)
print("try_load ->", hex(r))
print("ossl_default_provider_init 被调次数:", len(hits))
for h in hits:
    print("  args:", [hex(x) for x in h])
