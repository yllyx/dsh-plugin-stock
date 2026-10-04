# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu
emu = KplSoEmu(".", verbose=True)
print("cert 类型/长度:", type(emu.cert), len(emu.cert) if emu.cert else "空", flush=True)
print("cert 前 8 字节:", bytes(emu.cert[:8]).hex() if emu.cert else "-", flush=True)
emu.init_bax_pwd()
h = emu._call(emu.OFF_ENC, emu.JNIENV_BASE, 0,
              emu._reg_handle(("jstring", "abcdef1234567890abcdef1234567890")),
              emu._reg_handle(("jstring", "cff05554-1f7f-3d76-9392-1352a7ebeec4")),
              emu._reg_handle(("jstring", "99")),
              emu._reg_handle(("jstring", "1789963509")))
print("R0=", hex(h), "objects[h]=", emu.objects.get(h), flush=True)
for hh in (0x124, 0x125, 0x126, 0x127, 0x128, 0x129):
    print(hex(hh), "methods=", emu.methods.get(hh), "fields=", emu.fields.get(hh),
          "obj=", emu.objects.get(hh), flush=True)
