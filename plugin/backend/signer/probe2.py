# -*- coding: utf-8 -*-
import sys, io, os, threading, traceback, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
BK = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\backend"
sys.path.insert(0, BK)
from kpl_signer_py import KplSoEmu, EmuError

emu = KplSoEmu(".", verbose=True)

def watchdog():
    time.sleep(200)
    print("!!! 墙钟 200s 到，强制 emu_stop", flush=True)
    try:
        emu.uc.emu_stop()
    except Exception:
        pass
t = threading.Thread(target=watchdog, daemon=True)
t.start()

try:
    emu.init_bax_pwd()
    print("=== initBaxPwd OK ===", flush=True)
    out = emu.white_box_encrypt("abcdef1234567890abcdef1234567890",
                                "cff05554-1f7f-3d76-9392-1352a7ebeec4", "99", "1789963509")
    print("=== ENC len=", len(out), "hex=", out.hex()[:200], flush=True)
except BaseException as e:
    print("EXC", type(e).__name__, ":", e, flush=True)
    traceback.print_exc()

log = getattr(emu, "magic_log", [])
names = getattr(emu, "_magic_name", {})
print("magic 调用总数:", len(log), flush=True)
print("最后 40 个:", flush=True)
for kind, addr, ret in log[-40:]:
    nm = names.get(addr)
    if not nm:
        nm = kind + "?" + hex(addr)
    print("  ", nm, "->", hex(ret) if isinstance(ret, int) else ret, flush=True)
err = getattr(emu, "_emu_error", None)
print("_emu_error:", err, flush=True)
