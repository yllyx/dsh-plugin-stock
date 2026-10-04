# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *
emu = K.KplSoEmu(".", verbose=False)
dumped = [False]
def on_final(uc, a, s, ud):
    if dumped[0]:
        return
    dumped[0] = True
    ctx = uc.reg_read(UC_ARM_REG_R0)
    inner = struct.unpack_from("<I", bytes(uc.mem_read(ctx, 4)), 0)[0]
    big = bytes(uc.mem_read(inner, 0x600))
    open("gcm_ctx_final.bin", "wb").write(big)
    print("prov GCM ctx @", hex(inner), "dumped 0x600", flush=True)
    for probe, name in ((bytes.fromhex("7b7c30376a72476df38b567fc44f1bed"), "EJ0"),
                        (bytes.fromhex("e5dce5e7acf56429c11d172238e8b454"), "H"),
                        (bytes.fromhex("ebb9b31fcfb3baf91c328640b9943ed3"), "TAG"),
                        (bytes.fromhex("90c58328a5c1fd94efb9d03f7ddb253e"), "Y猜")):
        i = big.find(probe)
        print(f"{name} @inner+{i:#x}" if i >= 0 else f"{name} 未在前0x600", flush=True)
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
