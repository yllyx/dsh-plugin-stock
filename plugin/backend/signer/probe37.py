# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = "E:/deepseek-proj/stock-all/dsh-stock-plugin/plugin/backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import *
emu = K.KplSoEmu(".", verbose=False)
state = {"hook": None, "watched": False}
def on_write(uc, access, address, size, value, ud):
    pc = uc.reg_read(UC_ARM_REG_PC)
    lr = uc.reg_read(UC_ARM_REG_LR)
    print(f"!!! tag 写入: addr={address:#x} size={size} value={value:#x} pc={pc-emu.base:#x} lr={lr-emu.base:#x}", flush=True)
def on_final(uc, a, s, ud):
    if state["watched"]:
        return
    state["watched"] = True
    emu._watch_memcpy = True
    uc.hook_add(UC_HOOK_MEM_WRITE, on_write, begin=0x50078040, end=0x50078060)
    print(">>> memcpy+写监视开启", flush=True)
emu.uc.hook_add(UC_HOOK_CODE, on_final, begin=emu.base + 0xec1a4, end=emu.base + 0xec1a4)
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
except EmuError:
    pass
