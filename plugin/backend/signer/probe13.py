# -*- coding: utf-8 -*-
import sys, io, struct, bisect
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
import kpl_signer_py as K
from unicorn import UC_HOOK_BLOCK

trace = []
on = [False]
orig_call = K.KplSoEmu._call
def patched(self, off, *args, **kw):
    if off == 0x185e2c:
        on[0] = True
        try:
            return orig_call(self, off, *args, **kw)
        finally:
            on[0] = False
    return orig_call(self, off, *args, **kw)
K.KplSoEmu._call = patched

emu = K.KplSoEmu.__new__(K.KplSoEmu)
# 手工挂块 hook 后再跑 init：需要 uc 先建好——直接拦截 __init__ 里 hook_add 之后?
# 简化：正常构造，但块 hook 在 __init__ 内注册不了 → 用 UC_HOOK_BLOCK 全局 monkeypatch
orig_hook_add = None
emu = K.KplSoEmu(".", verbose=False)
emu.uc.hook_add(UC_HOOK_BLOCK, lambda uc, address, size, ud: trace.append(address) if on[0] else None)

# __init__ 已经跑完 init_crypto —— run_once 状态在 emu 内存里持久，但重新调用会因为
# once done 直接返回。所以要 fresh 内存重跑不可行；改为验证: __init__ 那次调用返回 0 的原因
# 改用: 手动模拟全新调用的另一种方式 —— OPENSSL_init_crypto 的失败分支不受 once 控制的部分
r = emu._call(0x185e2c, 0x20000 | 0x80, 0, arm=True)
print("重调 ->", hex(r), "trace 块数:", len(trace))
so = open("libauthSign_armv7_patched.so", "rb").read()
# 反汇编 OPENSSL_init_ex_crypto 开头 30 条
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
for i, ins in enumerate(md.disasm(so[0x185e2c:0x185e2c+140], 0x185e2c)):
    print(f"  {ins.address:#x}: {ins.mnemonic} {ins.op_str}")
    if i > 28:
        break
