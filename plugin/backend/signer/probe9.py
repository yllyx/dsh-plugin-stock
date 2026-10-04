# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu, EmuError
emu = KplSoEmu(".", verbose=False)
emu.init_bax_pwd()
print("init OK", flush=True)

KEY = bytes.fromhex("d6c8a0bcf7b472eb34751af6471877f4")
PT  = bytes.fromhex("00112233445566778899aabbccddeeff")

ctx = emu.heap_alloc(0x2000)
emu.uc.mem_write(ctx, b"\x00" * 0x2000)
kbuf = emu.heap_alloc(16); emu.uc.mem_write(kbuf, KEY)
pbuf = emu.heap_alloc(16); emu.uc.mem_write(pbuf, PT)
obuf = emu.heap_alloc(16)
ekbuf = emu.heap_alloc(64); emu.uc.mem_write(ekbuf, b"\x00" * 64)

SET_KEY, ENC, EXP = 0x1dffd0, 0x1e10b4, 0x1dfff4
r = emu._call(SET_KEY, ctx, kbuf, 128, arm=True)
print("set_key ->", r, flush=True)
r = emu._call(ENC, ctx, obuf, pbuf, arm=True)
print("encrypt ->", r, "C_emu =", bytes(emu.uc.mem_read(obuf, 16)).hex(), flush=True)

# export_key 两种签名试探
for args, tag in (((ctx, ekbuf, 16), "(ctx, buf, 16)"), ((ctx, ekbuf, 128), "(ctx, buf, 128)"), ((ctx, ekbuf), "(ctx, buf)")):
    try:
        r = emu._call(EXP, *args, arm=True)
        print(f"export_key{tag} -> {r} key=", bytes(emu.uc.mem_read(ekbuf, 16)).hex(), flush=True)
        break
    except EmuError as e:
        print(f"export_key{tag} 出错: {e}", flush=True)

# 标准 SM4 对拍
from kpl_sm4_gcm import sm4_key_schedule, sm4_encrypt_block
rk = sm4_key_schedule(KEY)
c_std = sm4_encrypt_block(PT, rk)
print("C_std =", c_std.hex(), flush=True)
print("恒等:", bytes(emu.uc.mem_read(obuf, 16)) == c_std, flush=True)
