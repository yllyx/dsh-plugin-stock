# -*- coding: utf-8 -*-
import sys, io, struct, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from kpl_signer_py import EmuError
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

orig_call = K.KplSoEmu._call
state = {"armed": False, "on": False}
trace = []
cur = {}
def patched(self, off, *args, **kw):
    if not state["armed"] and off == self.OFF_OPENSSL_INIT:
        state["armed"] = True
        base = self.base
        def entry(uc_, a, s, ud):
            if not state["on"]:
                return
            r = [uc_.reg_read(UC_ARM_REG_R0 + i) for i in range(4)]
            sp = uc_.reg_read(UC_ARM_REG_SP)
            words = list(struct.unpack("<32I", bytes(uc_.mem_read(sp, 128))))
            mask = struct.unpack("<I", bytes(uc_.mem_read(sp + 116, 4)))[0]
            cur["args"] = (r, words, mask)
        def ret(uc_, a, s, ud):
            if not state["on"] or "args" not in cur:
                return
            trace.append({"r": cur["args"][0], "w": cur["args"][1], "mask": cur["args"][2],
                          "ret": uc_.reg_read(UC_ARM_REG_R0)})
            cur.pop("args")
        self.uc.hook_add(UC_HOOK_CODE, entry, begin=base + 0x1e7784, end=base + 0x1e7784)
        self.uc.hook_add(UC_HOOK_CODE, ret, begin=base + 0x1e7810, end=base + 0x1e7810)
    if off == self.OFF_ENC:
        state["on"] = True
        try:
            return orig_call(self, off, *args, **kw)
        finally:
            state["on"] = False
    return orig_call(self, off, *args, **kw)
K.KplSoEmu._call = patched
emu = K.KplSoEmu(".", verbose=False)
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
except EmuError:
    pass
print("ENC 窗口内 affineU32 次数:", len(trace))
json.dump(trace, open("affine_enc_trace.json", "w"))
# 找 E'(ctr1) 的 4 word：28093364 e3592552 7a9272a2 27c279c1
target = [0x28093364, 0xe3592552, 0x7a9272a2, 0x27c279c1]
for i, t in enumerate(trace):
    if t["ret"] in target:
        print(f"[{i}] ret={t['ret']:#x} mask={t['mask']:#x} r0={t['r'][0]:#x}")
