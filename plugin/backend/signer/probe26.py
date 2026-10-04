# -*- coding: utf-8 -*-
import struct, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K

emu = K.KplSoEmu(".", verbose=False)
so = emu._so_bytes
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
by = {s["nm"]: s for s in S}
dynsym, dynstr, relplt, plt = by[".dynsym"], by[".dynstr"], by[".rel.plt"], by[".plt"]
def symname(idx):
    o = dynsym["off"] + idx * 16
    st_name, = struct.unpack_from("<I", so, o)
    e = so.find(b"\x00", dynstr["off"] + st_name)
    return so[dynstr["off"] + st_name:e].decode()
bound = {}
for i in range(relplt["size"] // 8):
    o = relplt["off"] + i * 8
    r_offset, r_info = struct.unpack_from("<II", so, o)
    bound[r_offset] = symname(r_info >> 8)

bad = []
base = plt["addr"]
end = base + plt["size"]
# PLT0 = 20B，之后每 12/16B。本 so stub 间隔 0x10
off = base + 0x14
while off + 12 <= end:
    w1, = struct.unpack_from("<I", so, plt["off"] + (off - base))
    if (w1 >> 8) & 0xFFFFFF in (0x2a0c00 + 0xc0, ) or True:
        pass
    try:
        w2, = struct.unpack_from("<I", so, plt["off"] + (off - base) + 4)
        w3, = struct.unpack_from("<I", so, plt["off"] + (off - base) + 8)
        imm8 = w2 & 0xFF
        rot = (w2 >> 8) & 0xF
        val = ((imm8 >> (2 * rot)) | (imm8 << (32 - 2 * rot))) & 0xFFFFFFFF if rot else imm8
        imm12 = w3 & 0xFFF
        got = (off + 8 + val + imm12) & 0xFFFFFFFF
        cur = struct.unpack("<I", bytes(emu.uc.mem_read(emu.base + got, 4)))[0]
        if cur == 0 or cur == emu.base + plt["addr"] + 0x14 or (cur >= emu.base + plt["addr"] and cur < emu.base + plt["addr"] + 0x14):
            bad.append((off, got, bound.get(got, "?")))
    except Exception:
        pass
    off += 0x10
print("PLT 总扫描结束，未绑定槽:", len(bad))
for o, g, nm in bad[:40]:
    print(f"  PLT {o:#x} GOT {g:#x} → {nm}")
