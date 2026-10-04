# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *
emu = K.KplSoEmu(".", verbose=False)
WATCH = {"ossl_provider_new": 0x197938, "ossl_provider_activate": 0x198248,
         "ossl_provider_find": 0x197618, "ossl_provider_free": 0x19780c}
def mk(nm):
    def h(uc, a, s, ud):
        print(f"[{nm}] r0={uc.reg_read(UC_ARM_REG_R0):#x} r1={uc.reg_read(UC_ARM_REG_R1):#x} r2={uc.reg_read(UC_ARM_REG_R2):#x}", flush=True)
        hits[nm] = hits.get(nm, 0) + 1
    return h
hits = {}
for nm, off in WATCH.items():
    emu.uc.hook_add(UC_HOOK_CODE, mk(nm), begin=emu.base + off, end=emu.base + off)
nb = emu.write_cstr("default")
emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
print("--- add_builtin 完成，调 try_load ---")
emu._call(0x196174, 0, nb, 1, arm=True)
print("命中统计:", hits)
