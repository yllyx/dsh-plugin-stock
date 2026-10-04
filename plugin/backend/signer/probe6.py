# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
so = open("libauthSign_armv7_patched.so", "rb").read()
BASE = 0x10000000
# PLT stub at so 偏移 0xe0300（lr=0x100e0300 是 push 后第一条），读 0xe0300-0xe0310
off = 0xe0300
stub = so[off:off+16]
for i in range(4):
    w = struct.unpack_from("<I", stub, i*4)[0]
    print(f"{off+i*4:#x}: {w:#010x}")
