# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
so = open("libauthSign_armv7_patched.so", "rb").read()

# 手工解析 dynsym 查 EVP_wbsm4_wsise_gcm
def secs(data):
    e_shoff, = struct.unpack_from("<I", data, 0x20)
    e_shentsize, e_shnum = struct.unpack_from("<HH", data, 0x2E)
    out = []
    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        name, typ, _fl, addr, off2, size, _lk, _inf, _al, ent = struct.unpack_from("<IIIIIIIIII", data, off)
        out.append({"name": name, "type": typ, "addr": addr, "off": off2, "size": size, "ent": ent})
    shstr = out[struct.unpack_from("<H", data, 0x32)[0]]
    for s in out:
        e = data.find(b"\x00", shstr["off"] + s["name"])
        s["nm"] = data[shstr["off"] + s["name"]:e].decode()
    return out
S = secs(so)
by = {s["nm"]: s for s in S}
dynsym, dynstr = by[".dynsym"], by[".dynstr"]
n = dynsym["size"] // 16
for i in range(n):
    off = dynsym["off"] + i * 16
    st_name, st_value, st_size, st_info, st_other = struct.unpack_from("<IIIBB", so, off)
    st_shndx = struct.unpack_from("<H", so, off + 14)[0]
    e = so.find(b"\x00", dynstr["off"] + st_name)
    nm = so[dynstr["off"] + st_name:e].decode()
    if "wbsm4" in nm:
        print(f"dynsym[{i}] {nm} value={st_value:#x} shndx={st_shndx} info={st_info:#x} size={st_size}")
