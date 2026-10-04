# -*- coding: utf-8 -*-
import sys, io, struct, bisect
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_BLOCK
from unicorn.arm_const import *

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

emu = K.KplSoEmu(".", verbose=False)
tr = []
h = emu.uc.hook_add(UC_HOOK_BLOCK, lambda uc, a, s, ud: tr.append(a))
nb = emu.write_cstr("default")
r1 = emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
print("add_builtin ->", hex(r1))
tr.clear()
r = emu._call(0x196174, 0, nb, 1, arm=True)
print("try_load ->", hex(r), "块数:", len(tr))
for t in tr[-55:]:
    o2 = t - emu.base
    print(f"  {o2:#x} {sn(o2) if o2 > 0 else '(非so)'}")
