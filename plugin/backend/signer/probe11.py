# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu
emu = KplSoEmu(".", verbose=False)
emu.init_bax_pwd()

KEY = bytes.fromhex("d6c8a0bcf7b472eb34751af6471877f4")
PT  = bytes.fromhex("00112233445566778899aabbccddeeff")
SET_KEY, ENC = 0x1dffd0, 0x1e10b4

ctx = emu.heap_alloc(0x4000); emu.uc.mem_write(ctx, b"\xAA" * 0x4000)
kbuf = emu.heap_alloc(16); emu.uc.mem_write(kbuf, KEY)
pbuf = emu.heap_alloc(16); emu.uc.mem_write(pbuf, PT)
obuf = emu.heap_alloc(16)

def d(a, n): return bytes(emu.uc.mem_read(a, n)).hex()

for tag, args in (("set_key(ctx,kbuf,128)", (ctx, kbuf, 128)),
                  ("set_key(kbuf,ctx,128)", (kbuf, ctx, 128))):
    try:
        r = emu._call(SET_KEY, *args, arm=True)
        print(f"{tag} -> {r:#x}", flush=True)
        print("  ctx[0:64] =", d(ctx, 64), flush=True)
        nz = sum(1 for b in emu.uc.mem_read(ctx, 0x4000) if b != 0xAA)
        print("  ctx 非0xAA 字节数:", nz, flush=True)
        if nz:
            r2 = emu._call(ENC, ctx, obuf, pbuf, arm=True)
            print("  encrypt ->", r2, "C =", d(obuf, 16), flush=True)
            break
    except Exception as e:
        print(f"{tag} 异常: {e}", flush=True)
