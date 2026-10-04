# -*- coding: utf-8 -*-
import sys, io, struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_MEM_WRITE
from unicorn.arm_const import *

so = open("libauthSign_armv7_patched.so", "rb").read()
# r6 = (0x185e40) + word@文件(0x185e38 的 ldr r6,[pc,#0x45c] → 0x185e38+8+0x45c=0x18629c)
w, = struct.unpack_from("<I", so, 0x18629c)
gbase = (0x185e48 + w) & 0xFFFFFFFF   # add r6,pc,r6 的 PC=addr+8
print("全局基址 =", hex(gbase))
target = gbase + 4
print("stopped 标志地址 =", hex(target))

emu = K.KplSoEmu(".", verbose=False)
def on_write(uc, access, address, size, value, ud):
    if address <= emu.base + target < address + size:
        print(f"!!! 写 stopped: value={value:#x} size={size} pc={uc.reg_read(UC_ARM_REG_PC)-emu.base:#x} lr={uc.reg_read(UC_ARM_REG_LR)-emu.base:#x}", flush=True)
emu.uc.hook_add(UC_HOOK_MEM_WRITE, on_write)
t2 = emu.base + target
print("构造完成后 stopped =", hex(struct.unpack("<I", emu.uc.mem_read(t2, 4))[0]), flush=True)
