# -*- coding: utf-8 -*-
import sys, io, struct, bisect
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

so = open("libauthSign_armv7_patched.so", "rb").read()
# 符号表（用于最近符号）
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

orig_call = K.KplSoEmu._call
state = {"armed": False}
def patched(self, off, *args, **kw):
    if not state["armed"] and off == self.OFF_OPENSSL_INIT:
        state["armed"] = True
        for plt, tag in ((0x2b2ea0, "P1"), (0x2b2f30, "P2")):
            def h(uc, a, s, ud, tag=tag, plt=plt):
                got = plt + 8 + 0x2b000 + ((so[plt+8] | (so[plt+9]<<8) | (so[plt+10]<<16) | (so[plt+11]<<24)) & 0xFFF)
                fn, = struct.unpack("<I", uc.mem_read(self.base + (got & ~3), 4))
                print(f"[{tag}@{plt:#x}] 被调 GOT={got:#x} fn={fn:#x} ≈ {sn(fn - self.base) if fn else 'NULL'}", flush=True)
            self.uc.hook_add(UC_HOOK_CODE, h, begin=self.base + plt, end=self.base + plt)
    return orig_call(self, off, *args, **kw)
K.KplSoEmu._call = patched
emu = K.KplSoEmu(".", verbose=False)
nb = emu.write_cstr("default")
emu._call(0x196398, 0, nb, emu.base + 0x234ae4, arm=True)
emu._call(0x196174, 0, nb, 1, arm=True)
