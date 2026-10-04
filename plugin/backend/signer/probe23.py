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
        for a, tag in ((0x234b08, "P1_ret"), (0x234b1c, "P2_ret")):
            def h(uc, addr, s, ud, tag=tag):
                print(f"[{tag}] r0={uc.reg_read(UC_ARM_REG_R0):#x}", flush=True)
            self.uc.hook_add(UC_HOOK_CODE, h, begin=self.base + a, end=self.base + a)
        def hd(uc, addr, s, ud):
            print(f"[defprov_exit 走到 0x234c08 fail 分支]", flush=True)
        self.uc.hook_add(UC_HOOK_CODE, hd, begin=self.base + 0x234c08, end=self.base + 0x234c08)
    return orig_call(self, off, *args, **kw)
K.KplSoEmu._call = patched
emu = K.KplSoEmu(".", verbose=False)
nb = emu.write_cstr("default")
emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
emu._call(0x196174, 0, nb, 1, arm=True)
