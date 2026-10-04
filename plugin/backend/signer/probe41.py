# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:/deepseek-proj/stock-all/dsh-stock-plugin/plugin/backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from kpl_signer_py import EmuError
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *
emu = K.KplSoEmu(".", verbose=False)
n = [0]
cur = {}
def on_ghash(uc, a, s, ud):
    cur["xi"] = uc.reg_read(UC_ARM_REG_R0)
    cur["inp"] = uc.reg_read(UC_ARM_REG_R2)
    cur["len"] = uc.reg_read(UC_ARM_REG_R3)
    print(f"[ghash#{n[0]}] xi@{cur['xi']:#x} len={cur['len']}", flush=True)
    n[0] += 1
def on_ghash_end(uc, a, s, ud):
    if "xi" in cur:
        print(f"   → Xi_after={bytes(uc.mem_read(cur['xi'], 16)).hex()}", flush=True)
        cur.pop("xi")
def on_finish(uc, a, s, ud):
    ctx = uc.reg_read(UC_ARM_REG_R0)
    print(f"[finish] ctx={ctx:#x} ctx[0:80]={bytes(uc.mem_read(ctx, 80)).hex()}", flush=True)
def on_finish_end(uc, a, s, ud):
    print(f"[finish尾] tag区:", flush=True)
emu.uc.hook_add(UC_HOOK_CODE, on_ghash, begin=emu.base + 0x1a2d30, end=emu.base + 0x1a2d30)
emu.uc.hook_add(UC_HOOK_CODE, on_ghash_end, begin=emu.base + 0x1a2e6c, end=emu.base + 0x1a2e6c)
emu.uc.hook_add(UC_HOOK_CODE, on_finish, begin=emu.base + 0x1a2a60, end=emu.base + 0x1a2a60)
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
except EmuError:
    pass
