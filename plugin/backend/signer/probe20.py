# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

orig_call = K.KplSoEmu._call
state = {"armed": False}
def patched(self, off, *args, **kw):
    if not state["armed"] and off == self.OFF_OPENSSL_INIT:
        state["armed"] = True
        def mk(nm, o):
            def h(uc, a, s, ud):
                print(f"[{nm}] r0={uc.reg_read(UC_ARM_REG_R0):#x} r1={uc.reg_read(UC_ARM_REG_R1):#x}", flush=True)
            return h
        for nm, o in (("provider_find", 0x197618), ("provider_activate", 0x198248),
                      ("provider_new", 0x197938), ("provider_free", 0x19780c),
                      ("defprov_init", 0x234ae4)):
            self.uc.hook_add(UC_HOOK_CODE, mk(nm, o), begin=self.base + o, end=self.base + o)
        print(">>> watch 已挂", flush=True)
    return orig_call(self, off, *args, **kw)
K.KplSoEmu._call = patched
emu = K.KplSoEmu(".", verbose=False)
nb = emu.write_cstr("default")
emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
print("--- add_builtin 完成，调 try_load ---")
emu._call(0x196174, 0, nb, 1, arm=True)
print("done")
