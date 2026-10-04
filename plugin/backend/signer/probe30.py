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
state = {"armed": False}
trace = []
cur = {}
def patched(self, off, *args, **kw):
    if not state["armed"] and off == self.OFF_OPENSSL_INIT:
        state["armed"] = True
        uc = self.uc
        base = self.base
        def entry(uc_, a, s, ud):
            r = [uc_.reg_read(UC_ARM_REG_R0 + i) for i in range(4)]
            sp = uc_.reg_read(UC_ARM_REG_SP)
            words = list(struct.unpack("<32I", bytes(uc_.mem_read(sp, 128))))
            mask = struct.unpack("<I", bytes(uc_.mem_read(sp + 116, 4)))[0]
            cur["args"] = (r, words, mask)
        def ret(uc_, a, s, ud):
            if "args" in cur:
                trace.append({"args": cur.pop("args"), "ret": uc_.reg_read(UC_ARM_REG_R0)})
        self.uc.hook_add(UC_HOOK_CODE, entry, begin=base + 0x1e7784, end=base + 0x1e7784)
        # 返回点：0x1e7810 pop 处 R0 已定值
        self.uc.hook_add(UC_HOOK_CODE, ret, begin=base + 0x1e7810, end=base + 0x1e7810)
        print(">>> affineU32 watch 已挂")
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
print("affineU32 调用次数:", len(trace))
for i, t in enumerate(trace[:8]):
    r, words, mask = t["args"]
    print(f"[{i}] r0..r3={[hex(x) for x in r]} mask={mask:#x} ret={t['ret']:#x} sp[0..3]={[hex(x) for x in words[:4]]}")
json.dump([{"r": t["args"][0], "w": t["args"][1], "mask": t["args"][2], "ret": t["ret"]} for t in trace],
          open("affine_trace.json", "w"))
print("已写 affine_trace.json")
