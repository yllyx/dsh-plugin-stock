# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
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
best = {}
n = dynsym["size"] // 16
for i in range(n):
    o = dynsym["off"] + i * 16
    st_name, st_value, st_size, st_info = struct.unpack_from("<IIIB", so, o)
    if st_shndx := struct.unpack_from("<H", so, o + 14)[0]:
        if st_value and st_size:
            e = so.find(b"\x00", dynstr["off"] + st_name)
            best[st_value] = (so[dynstr["off"] + st_name:e].decode(), st_size)
for target in (0x18fa30, 0x175bb8, 0x1a6550, 0x2ad9f0):
    cand = [(v, nm, sz) for v, (nm, sz) in best.items() if v <= target < v + sz]
    cand.sort(key=lambda x: -x[0])
    if cand:
        v, nm, sz = cand[0]
        print(f"{target:#x} ∈ {nm} @ {v:#x} size={sz:#x} (+{target-v:#x})")
    else:
        print(f"{target:#x} 无符号覆盖")
