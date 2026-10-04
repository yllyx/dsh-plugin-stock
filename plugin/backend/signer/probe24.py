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
        for a, tag in ((0x234ae4, "defprov_init"), (0x198248, "prov_activate")):
            m = self._new_magic("probe", tag)
            self.libc_handlers[m] = ("retprobe", tag)
            self._magic_name[m] = "RET." + tag
            self._retprobe_lr[tag] = 0
            def h(uc, addr, s, ud, tag=tag, m=m):
                lr = uc.reg_read(UC_ARM_REG_LR)
                self._retprobe_lr[tag] = lr
                uc.reg_write(UC_ARM_REG_LR, m)
            self.uc.hook_add(UC_HOOK_CODE, h, begin=self.base + a, end=self.base + a)
    return orig_call(self, off, *args, **kw)
K.KplSoEmu._call = patched
emu = K.KplSoEmu(".", verbose=False)
nb = emu.write_cstr("default")
emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
emu._call(0x196174, 0, nb, 1, arm=True)
