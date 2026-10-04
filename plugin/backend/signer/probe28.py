# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu, EmuError
import kpl_sm4_gcm as S

emu = KplSoEmu(".", verbose=False)
try:
    emu.init_bax_pwd()
    emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
except EmuError:
    pass
CTX = 0x500781c0
ekbuf = emu.heap_alloc(64); emu.uc.mem_write(ekbuf, b"\x00" * 64)
for args, tag in (((CTX, ekbuf, 16), "(ctx,buf,16)"), ((CTX, ekbuf, 128), "(ctx,buf,128)"),
                  ((CTX, ekbuf), "(ctx,buf)")):
    try:
        r = emu._call(0x1dfff4, *args, arm=True)
        key = bytes(emu.uc.mem_read(ekbuf, 16))
        print(f"export_key{tag} -> {r:#x} key={key.hex()}", flush=True)
        rk = S.sm4_key_schedule(key)
        c = S.sm4_encrypt_block(rk, bytes.fromhex("61626364656631323334353600000001"))
        print("  SM4(K')(ctr1) =", c.hex(), " 目标=28093364e35925527a9272a227c279c1 相同:", c.hex() == "28093364e35925527a9272a227c279c1", flush=True)
        break
    except EmuError as e:
        print(f"export_key{tag} 出错: {str(e)[:100]}", flush=True)
