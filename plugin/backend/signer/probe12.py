# -*- coding: utf-8 -*-
import sys, io, struct, bisect
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu
from unicorn import UC_HOOK_BLOCK, UC_HOOK_CODE
from unicorn.arm_const import *
emu = KplSoEmu(".", verbose=False)

# 先手工跑完 initBaxPwd 前置? 不——OPENSSL_init_crypto 只依赖 libc，直接调
trace = []
on = [False]
def tb(uc, address, size, ud):
    if on[0]:
        trace.append(address)
emu.uc.hook_add(UC_HOOK_BLOCK, tb)

so = open("libauthSign_armv7_patched.so", "rb").read()
e_shoff, = struct.unpack_from("<I", so, 0x20)
esz, nsh, shstrx = struct.unpack_from("<HHH", so, 0x2E)
S = []
for i in range(nsh):
    o = e_shoff + i * esz
    v = struct.unpack_from("<IIIIIIIIII", so, o)
    S.append({"name": v[0], "type": v[1], "addr": v[3], "off": v[4], "size": v[5]})
shoff = S[shstrx]["off"]
for s in S:
    e = so.find(b"\x00", shoff + s["name"])
    s["nm"] = so[shoff + s["name"]:e].decode()
dynsym = next(s for s in S if s["type"] == 11)
dynstr = next(s for s in S if s["nm"] == ".dynstr")
syms = []
for i in range(dynsym["size"] // 16):
    o = dynsym["off"] + i * 16
    st_name, st_value = struct.unpack_from("<II", so, o)
    if st_value:
        e = so.find(b"\x00", dynstr["off"] + st_name)
        syms.append((st_value, so[dynstr["off"] + st_name:e].decode() or "?"))
syms.sort()
def sn(t):
    idx = bisect.bisect_right(syms, (t, "\xff")) - 1
    return syms[idx][1] if idx >= 0 else "?"

# 包一层：入口开 trace，返回关（用 retprobe 机制手搓：改 LR 到 magic）
m = emu._new_magic("probe", "initret")
def handler():
    on[0] = False
    emu.uc.reg_write(UC_ARM_REG_LR, saved_lr[0])
    return 0
saved_lr = [0]
emu.libc_handlers[m] = handler
emu._magic_name[m] = "initret"

old_hook = emu._hook_code
seen = [0]
def hook2(uc, address, size, ud):
    seen[0] += 1
    if seen[0] < 6:
        print("hook2 pc=", hex(address - emu.base))
    if address == emu.base + 0x185e2c:
        print(">>> 入口命中")
        on[0] = True
        saved_lr[0] = uc.reg_read(UC_ARM_REG_LR)
        uc.reg_write(UC_ARM_REG_LR, m)
    return old_hook(uc, address, size, ud)
emu.uc.hook_add(UC_HOOK_CODE, hook2)

try:
    r = emu._call(0x185e2c, 0x20000 | 0x80, 0, arm=True)
    print("OPENSSL_init_crypto ->", hex(r), "hook2 触发数:", seen[0])
except Exception as e:
    print("异常:", e)
print("trace 块数:", len(trace))
for t in trace[-60:]:
    off = t - emu.base
    print(f"  {off:#x} {sn(off) if off > 0 else '(堆)'}")
