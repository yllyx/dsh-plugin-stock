# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
so = open("libauthSign_armv7_patched.so", "rb").read()
def secs(data):
    e_shoff, = struct.unpack_from("<I", data, 0x20)
    e_shentsize, e_shnum = struct.unpack_from("<HH", data, 0x2E)
    out = []
    for i in range(e_shnum):
        o = e_shoff + i * e_shentsize
        name, typ, _f, addr, off, size, _lk, _inf, _al, _ent = struct.unpack_from("<IIIIIIIIII", data, o)
        out.append({"type": typ, "addr": addr, "off": off, "size": size})
    shstr = out[struct.unpack_from("<H", data, 0x32)[0]]
    return out, shstr
S, _ = secs(so)
dynsym = next(s for s in S if s["type"] == 11)
def secs2(data):
    e_shoff, = struct.unpack_from("<I", data, 0x20)
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", data, 0x2E)
    out = []
    for i in range(e_shnum):
        o = e_shoff + i * e_shentsize
        vals = struct.unpack_from("<IIIIIIIIII", data, o)
        out.append({"name": vals[0], "type": vals[1], "addr": vals[3], "off": vals[4], "size": vals[5]})
    shstr_off = out[e_shstrndx]["off"]
    for s in out:
        e = data.find(b"\x00", shstr_off + s["name"])
        s["nm"] = data[shstr_off + s["name"]:e].decode()
    return out
S = secs2(so)
by = {s["nm"]: s for s in S}
dynsym, dynstr = by[".dynsym"], by[".dynstr"]
def symname(idx):
    o = dynsym["off"] + idx * 16
    st_name, = struct.unpack_from("<I", so, o)
    e = so.find(b"\x00", dynstr["off"] + st_name)
    return so[dynstr["off"] + st_name:e].decode()
relplt = by[".rel.plt"]
bound = {}
n = relplt["size"] // 8
for i in range(n):
    o = relplt["off"] + i * 8
    r_offset, r_info = struct.unpack_from("<II", so, o)
    bound[r_offset] = symname(r_info >> 8)
print("rel.plt 条目数:", n)
gotplt = by[".got.plt"]
print(".got.plt addr=%#x size=%#x" % (gotplt["addr"], gotplt["size"]))
# .got.plt 初值扫描：哪些槽的文件初值仍指向 PLT0（=got.plt addr 区）且不在 bound
raw = so[gotplt["off"]:gotplt["off"]+gotplt["size"]]
for i in range(0, gotplt["size"], 4):
    v = struct.unpack_from("<I", raw, i)[0]
    slot = gotplt["addr"] + i
    if slot in bound:
        continue
    if v == gotplt["addr"] + 0x10 or v == gotplt["addr"] + 0x14 or v == gotplt["addr"] + 0x20:
        print(f"未绑定 GOT 槽 {slot:#x} 文件初值 {v:#x}")
# PLT0 = .plt 开头 20B；GOT[0]=_DYNAMIC GOT[1] GOT[2]
