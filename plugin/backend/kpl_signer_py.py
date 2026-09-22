# -*- coding: utf-8 -*-
"""开盘啦白盒签名器（纯 Python / unicorn 模拟 libauthSign.so armeabi-v7a）

模拟范围（由 unidbg verbose 实测确定，恰好覆盖 so 的实际 JNI 面）：
  initBaxPwd(env, clazz, AssetManager):
    FindClass(ActivityThread) → currentApplication() → Application
    → getPackageName() → getPackageManager() → getPackageInfo(pkg,0x40)
    → signatures[0].toByteArray() → 证书 DER（密钥由此解出）
  whiteBoxEncrypt(env, clazz, ch, dev, conn, time):
    Config.channelID("129") / Config.versionName("6.3.20.0") / ApiConfig.apiVersion("w48")
    GetStringUtfChars(各参数) → 计算 → NewByteArray + SetByteArrayRegion(输出收集)

实现：unicorn ARM/THUMB + ELF32 加载 + JNIEnv vtable 分发 + libc 子集。
所有已知 unidbg/frida 检测字符串已在 so 补丁版中破坏。
"""
import os
import sys
import struct
import time as _time
from typing import Optional

from unicorn import *
from unicorn.arm_const import *
import capstone

_SO_NAME = "libauthSign_armv7_patched.so"

# ============= JNI vtable 槽位（armeabi-v7a 4字节表，含4保留项） =============
S_FIND_CLASS = 6
S_GET_OBJECT_CLASS = 31
S_GET_METHOD_ID = 33
S_GET_FIELD_ID = 94
S_GET_OBJECT_FIELD = 95
S_GET_STATIC_FIELD_ID = 144
S_GET_STATIC_OBJECT_FIELD = 145
S_CALL_STATIC_OBJECT_METHOD_V = 115
S_NEW_STRING_UTF = 167
S_GET_STRING_UTF_CHARS = 169
S_RELEASE_STRING_UTF_CHARS = 170
S_GET_ARRAY_LENGTH = 171
S_NEW_OBJECT_ARRAY = 172
S_GET_OBJECT_ARRAY_ELEMENT = 173
S_NEW_BYTE_ARRAY = 176
S_SET_BYTE_ARRAY_REGION = 207
S_CALL_OBJECT_METHOD_V = 34


class EmuError(Exception):
    pass


class KplSoEmu:
    """libauthSign.so 的 unicorn 模拟器（armv7 thumb）"""

    BASE = 0x10000000
    STACK_BASE = 0x40000000
    STACK_SIZE = 0x200000
    HEAP_BASE = 0x50000000
    HEAP_SIZE = 0x4000000
    JNIENV_BASE = 0x60000000
    MAGIC_BASE = 0x61000000
    MAGIC_STRIDE = 16

    OFF_INIT = 0x2A4430   # initBaxPwd（unidbg verbose 显示 0x2a4431 含 thumb 位）
    OFF_ENC = 0x2A4BB0    # whiteBoxEncrypt

    def __init__(self, signer_dir: str, verbose: bool = False):
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB)
        self.verbose = verbose
        self.signer_dir = signer_dir
        self._heap_ptr = self.HEAP_BASE
        self._handle_seq = 0x100
        self.objects = {}
        self.methods = {}
        self.fields = {}
        self.symbols = {}
        self._sym_seq = 0
        self._symbol_addr = {}
        self.libc_handlers = {}

        cert = open(os.path.join(signer_dir, "cert.der"), "rb").read()
        so = open(os.path.join(signer_dir, _SO_NAME), "rb").read()

        self._load_elf(so)
        self.uc.mem_map(self.STACK_BASE, self.STACK_SIZE)
        self.uc.reg_write(UC_ARM_REG_SP, self.STACK_BASE + self.STACK_SIZE - 0x10000)
        # 启用 NEON/VFP（unidbg 同款: CPACR CP10/CP11 + FPEXC.EN）
        self.uc.reg_write(UC_ARM_REG_C1_C0_2, 0xF00000)
        self.uc.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.uc.mem_map(self.HEAP_BASE, self.HEAP_SIZE)
        self._heap_ptr = self.HEAP_BASE
        self._init_libc()
        self._build_jnienv()
        self.uc.hook_add(UC_HOOK_CODE, self._hook_code,
                         begin=self.MAGIC_BASE, end=self.MAGIC_BASE + 0x100000)
        def _on_unmapped(uc, access, address, size, value, user_data):
            print(f"[UNMAPPED] access={access} addr={address:#x} size={size} pc={uc.reg_read(UC_ARM_REG_PC):#x}", file=sys.stderr)
            uc.mem_map(address & ~0xFFF, 0x1000)
            return True
        self.uc.hook_add(UC_HOOK_MEM_UNMAPPED, _on_unmapped)
        self._trace_n = 0
        def _trace(uc, address, size, ud):
            self._trace_n += 1
            if self._trace_n <= 60 or self._trace_n % 20000 == 0:
                print(f"[T{self._trace_n}] pc={address:#x} size={size}", file=sys.stderr)
        self.uc.hook_add(UC_HOOK_CODE, _trace)
        self.cert = cert

    # ---------- ELF32 ----------
    def _load_elf(self, data: bytes):
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x2A)[0]
        e_phnum = struct.unpack_from("<H", data, 0x2C)[0]
        segs = []
        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            p_type, p_offset, p_vaddr, _p_paddr, p_filesz, p_memsz = struct.unpack_from("<IIIIII", data, off)
            if p_type == 1:
                segs.append((p_offset, p_vaddr, p_filesz, p_memsz))
        if not segs:
            raise EmuError("no PT_LOAD")
        lo = min(s[1] for s in segs)
        hi = max(s[1] + s[3] for s in segs)
        self.base = self.BASE
        size = (hi - lo + 0xFFFF) & ~0xFFFF
        self.uc.mem_map(self.base, size + 0x10000)
        for p_offset, p_vaddr, p_filesz, _p_memsz in segs:
            self.uc.mem_write(self.base + p_vaddr, data[p_offset:p_offset + p_filesz])
        self._apply_relocs(data)

    def _sections(self, data):
        e_shoff = struct.unpack_from("<I", data, 0x20)[0]
        e_shentsize = struct.unpack_from("<H", data, 0x2E)[0]
        e_shnum = struct.unpack_from("<H", data, 0x30)[0]
        e_shstrndx = struct.unpack_from("<H", data, 0x32)[0]
        secs = []
        for i in range(e_shnum):
            off = e_shoff + i * e_shentsize
            vals = struct.unpack_from("<10I", data, off)
            name, stype, _flags, addr, offset, size = vals[0], vals[1], vals[2], vals[3], vals[4], vals[5]
            secs.append({"name_off": name, "type": stype, "addr": addr,
                         "off": offset, "size": size})
        strsec = secs[e_shstrndx]

        def nm(n):
            end = data.find(b"\x00", strsec["off"] + n)
            return data[strsec["off"] + n:end].decode()
        for s in secs:
            s["name"] = nm(s["name_off"])
        return secs

    def _apply_relocs(self, data):
        secs = self._sections(data)
        byname = {s["name"]: s for s in secs}
        dynsym = byname.get(".dynsym")
        dynstr = byname.get(".dynstr")
        if not dynsym or not dynstr:
            return

        def symname(idx):
            off = dynsym["off"] + idx * 16
            st_name = struct.unpack_from("<I", data, off)[0]
            end = data.find(b"\x00", dynstr["off"] + st_name)
            return data[dynstr["off"] + st_name:end].decode()
        for relname in (".rel.dyn", ".rel.plt"):
            rel = byname.get(relname)
            if not rel:
                continue
            n = rel["size"] // 8
            for i in range(n):
                off = rel["off"] + i * 8
                r_offset, r_info = struct.unpack_from("<II", data, off)
                rtype = r_info & 0xFF
                if rtype not in (7, 2):
                    continue
                sym = symname(r_info >> 8)
                fn_addr = self._symbol_for(sym)
                if fn_addr:
                    self.uc.mem_write(self.base + r_offset, struct.pack("<I", fn_addr))
                else:
                    # 数据符号（如 __stack_chk_guard）: 分配真实内存
                    data_addr = self.heap_alloc(16)
                    self.uc.mem_write(self.base + r_offset, struct.pack("<I", data_addr))

    # ---------- magic/符号 ----------
    def _new_magic(self, kind, fn):
        self._sym_seq += 1
        addr = self.MAGIC_BASE + self._sym_seq * self.MAGIC_STRIDE
        self.symbols[addr] = (kind, fn)
        return addr

    def _symbol_for(self, name: str) -> Optional[int]:
        return self._symbol_addr.get(name)

    # ---------- libc 子集 ----------
    def _init_libc(self):
        uc = self.uc

        def malloc():
            return self.heap_alloc(uc.reg_read(UC_ARM_REG_R0))

        def calloc():
            n = uc.reg_read(UC_ARM_REG_R0)
            a = self.heap_alloc(n)
            uc.mem_write(a, b"\x00" * n)
            return a

        def free():
            return 0

        def realloc():
            old, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)
            a = self.heap_alloc(n)
            if old and n:
                try:
                    uc.mem_write(a, bytes(uc.mem_read(old, n)))
                except Exception:
                    pass
            return a

        def memcpy_like():
            dst, src, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)
            if n and src:
                uc.mem_write(dst, bytes(uc.mem_read(src, n)))
            return dst

        def memset():
            dst, c, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1) & 0xFF, uc.reg_read(UC_ARM_REG_R2)
            if n:
                uc.mem_write(dst, bytes([c]) * n)
            return dst

        def strlen():
            a = uc.reg_read(UC_ARM_REG_R0)
            n = 0
            while uc.mem_read(a + n, 1) != b"\x00" and n < 65536:
                n += 1
            return n

        def __strlen_chk():
            return strlen()

        def __memcpy_chk():
            return memcpy_like()

        def memcmp():
            d, s, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)
            a = bytes(uc.mem_read(d, n))
            b = bytes(uc.mem_read(s, n))
            return (a > b) - (a < b)

        def strcmp():
            d, s = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)
            a = self.read_cstr(d)
            b = self.read_cstr(s)
            return (a > b) - (a < b)

        def strncmp():
            d, s, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)
            a = self.read_cstr(d)[:n]
            b = self.read_cstr(s)[:n]
            return (a > b) - (a < b)

        def strcpy_like():
            dst, src = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)
            s = self.read_cstr(src)
            uc.mem_write(dst, s.encode() + b"\x00")
            return dst

        def strncpy():
            dst, src, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)
            s = self.read_cstr(src).encode()[:n]
            uc.mem_write(dst, s + b"\x00" * (n - len(s)))
            return dst

        def clock_gettime():
            tp = uc.reg_read(UC_ARM_REG_R1)
            now = _time.time()
            uc.mem_write(tp, struct.pack("<II", int(now), int(now % 1 * 1e9)))
            return 0

        def gettimeofday():
            tp = uc.reg_read(UC_ARM_REG_R0)
            now = _time.time()
            uc.mem_write(tp, struct.pack("<II", int(now), int(now % 1 * 1e6)))
            return 0

        libc = {
            "malloc": malloc, "calloc": calloc, "free": free, "realloc": realloc,
            "memcpy": memcpy_like, "memmove": memcpy_like, "memset": memset,
            "memcmp": memcmp, "strlen": strlen, "__strlen_chk": __strlen_chk,
            "__memcpy_chk": __memcpy_chk, "strcmp": strcmp, "strncmp": strncmp,
            "strcpy": strcpy_like, "strncpy": strncpy, "strcat": strcpy_like,
            "strchr": 0, "strrchr": 0, "strstr": 0, "strtok": 0,
            "strspn": 0, "strcspn": 0, "memchr": 0,
            "getenv": 0, "getuid": 10067, "getpid": 4321,
            "clock_gettime": clock_gettime, "gettimeofday": gettimeofday,
            "time": int(_time.time()), "usleep": 0,
            "__android_log_print": 0, "__errno": 0,
            "fopen": 0, "fclose": 0, "fgets": 0, "fread": 0,
            "fwrite": 0, "fseek": 0, "ftell": 0, "fflush": 0,
            "ferror": 0, "feof": 0, "fputc": 0, "fprintf": 0,
            "vfprintf": 0, "__vsnprintf_chk": 0, "snprintf": 0,
            "sscanf": 0, "atoi": 0, "atol": 0, "strtol": 0, "strtoul": 0,
            "stat": 0xFFFFFFFF, "__open_2": 0xFFFFFFFF, "open": 0xFFFFFFFF, "read": 0,
            "close": 0, "select": 0, "socket": 0xFFFFFFFF, "connect": 0xFFFFFFFF,
            "bind": 0xFFFFFFFF, "listen": 0xFFFFFFFF, "accept": 0xFFFFFFFF,
            "shutdown": 0, "setsockopt": 0, "getsockopt": 0xFFFFFFFF,
            "getsockname": 0, "gethostbyname": 0, "getaddrinfo": 0xFFFFFFFF,
            "freeaddrinfo": 0, "getnameinfo": 0xFFFFFFFF,
            "qsort": 0, "sysconf": 0,
            "mmap": 0, "mprotect": 0, "mlock": 0, "madvise": 0, "munmap": 0,
            "posix_memalign": 0,
            "sigfillset": 0, "sigdelset": 0, "sigprocmask": 0,
            "sigaction": 0, "siglongjmp": 0,
            "dlopen": 1, "dlsym": 0, "dlerror": 0, "dlclose": 0,
            "readdir": 0, "opendir": 0, "closedir": 0,
            "gmtime": 0, "strerror": 0,
            "dl_unwind_find_exidx": 0, "__stack_chk_fail": 0, "__assert2": 0,
            "wmemmove": 0, "wmemcpy": 0, "wcslen": 0, "wmemset": 0,
            "wmemcmp": 0, "wcstoul": 0, "strtoll": 0, "wcstoll": 0,
            "strtoull": 0, "wcstoull": 0, "strtod": 0, "wcstof": 0,
            "wcstod": 0, "swprintf": 0, "wmemchr": 0, "wcstol": 0,
            "putchar": 0, "printf": 0, "vasprintf": 0,
            "pthread_mutex_lock": 0, "pthread_mutex_unlock": 0,
            "pthread_once": 0, "pthread_getspecific": 0,
            "pthread_setspecific": 0, "pthread_key_create": 0,
            "pthread_key_delete": 0,
            "syscall": 0, "abort": 0, "getsockopt": 0xFFFFFFFF,
            "__FD_SET_chk": 0,
        }
        for name, ret in libc.items():
            addr = self._new_magic("libc", None)
            self.libc_handlers[addr] = (lambda r: (lambda: r))(ret) if not callable(ret) else ret
            self._symbol_addr[name] = addr

    # ---------- JNI 环境 ----------
    def _build_jnienv(self):
        self.uc.mem_map(self.JNIENV_BASE, 0x1000)
        self.uc.mem_map(self.MAGIC_BASE, 0x100000)
        env_table = self.JNIENV_BASE + 0x100
        self.uc.mem_write(self.JNIENV_BASE, struct.pack("<I", env_table))

        slots = {
            S_FIND_CLASS: self._jni_find_class,
            S_GET_METHOD_ID: self._jni_get_method_id,
            S_GET_FIELD_ID: self._jni_get_field_id,
            S_GET_STATIC_FIELD_ID: self._jni_get_field_id,
            S_GET_STATIC_OBJECT_FIELD: self._jni_get_static_object_field,
            S_GET_OBJECT_FIELD: self._jni_get_object_field,
            S_CALL_STATIC_OBJECT_METHOD_V: self._jni_call_static_object_method_v,
            S_CALL_OBJECT_METHOD_V: self._jni_call_object_method_v,
            S_GET_ARRAY_LENGTH: self._jni_get_array_length,
            S_GET_OBJECT_ARRAY_ELEMENT: self._jni_get_object_array_element,
            S_GET_STRING_UTF_CHARS: self._jni_get_string_utf_chars,
            S_RELEASE_STRING_UTF_CHARS: lambda: 0,
            S_NEW_STRING_UTF: self._jni_new_string_utf,
            S_NEW_BYTE_ARRAY: self._jni_new_byte_array,
            S_SET_BYTE_ARRAY_REGION: self._jni_set_byte_array_region,
            S_GET_OBJECT_CLASS: lambda: self._reg_handle(("class", None)),
        }
        for slot, fn in slots.items():
            addr = self._new_magic("jni", fn)
            self.uc.mem_write(env_table + slot * 4, struct.pack("<I", addr))

    # ---------- JNI 实现 ----------
    def _jni_find_class(self):
        name = self.read_cstr(self.uc.reg_read(UC_ARM_REG_R1))
        return self._reg_handle(("class", name))

    def _jni_get_method_id(self):
        uc = self.uc
        name = self.read_cstr(uc.reg_read(UC_ARM_REG_R2))
        sig = self.read_cstr(uc.reg_read(UC_ARM_REG_R3))
        h = self._reg_handle(("method", sig))
        self.methods[h] = sig
        return h

    def _jni_get_field_id(self):
        uc = self.uc
        fname = self.read_cstr(uc.reg_read(UC_ARM_REG_R2))
        fsig = self.read_cstr(uc.reg_read(UC_ARM_REG_R3))
        h = self._reg_handle(("field", fname, fsig))
        self.fields[h] = (fname, fsig)
        return h

    def _jni_get_static_object_field(self):
        fh = self.uc.reg_read(UC_ARM_REG_R2)
        fname, _fsig = self.fields.get(fh, ("?", ""))
        vals = {"channelID": "129", "versionName": "6.3.20.0", "apiVersion": "w48"}
        return self._new_jstring(vals.get(fname, ""))

    def _jni_get_object_field(self):
        fh = self.uc.reg_read(UC_ARM_REG_R2)
        fname, _fsig = self.fields.get(fh, ("?", ""))
        if "signatures" in fname:
            return self._reg_handle(("sigarray", [self.cert]))
        return self._reg_handle(("nullfield", None))

    def _jni_call_static_object_method_v(self):
        mh = self.uc.reg_read(UC_ARM_REG_R2)
        sig = self.methods.get(mh, "")
        if "currentApplication" in sig:
            return self._reg_handle(("app", None))
        return self._reg_handle(("nullobj", None))

    def _jni_call_object_method_v(self):
        uc = self.uc
        oh = uc.reg_read(UC_ARM_REG_R1)
        mh = uc.reg_read(UC_ARM_REG_R2)
        sig = self.methods.get(mh, "")
        obj = self.objects.get(oh)
        if "getPackageName" in sig:
            return self._new_jstring("com.aiyu.kaipanla")
        if "getPackageManager" in sig:
            return self._reg_handle(("pm", None))
        if "getPackageInfo" in sig:
            return self._reg_handle(("pkginfo", None))
        if "toByteArray" in sig:
            if isinstance(obj, tuple):
                data = obj[1] if obj[0] == "sigobj" else (obj[1] if isinstance(obj[1], bytes) else b"")
            else:
                data = b""
            return self._reg_handle(("bytes", data))
        if "getAssets" in sig:
            return self._reg_handle(("assetmgr", None))
        return self._reg_handle(("nullobj", None))

    def _jni_get_array_length(self):
        obj = self.objects.get(self.uc.reg_read(UC_ARM_REG_R1))
        if isinstance(obj, tuple):
            if obj[0] == "sigarray":
                return len(obj[1])
            if obj[0] in ("bytes", "out"):
                return len(obj[1])
        if isinstance(obj, (bytes, bytearray, list)):
            return len(obj)
        return 1

    def _jni_get_object_array_element(self):
        idx = struct.unpack("<I", self.uc.mem_read(self.uc.reg_read(UC_ARM_REG_SP), 4))[0]
        obj = self.objects.get(self.uc.reg_read(UC_ARM_REG_R1))
        if isinstance(obj, tuple) and obj[0] == "sigarray" and idx < len(obj[1]):
            return self._reg_handle(("sigobj", obj[1][idx]))
        return self._reg_handle(("nullobj", None))

    def _jni_get_string_utf_chars(self):
        h = self.uc.reg_read(UC_ARM_REG_R1)
        s = ""
        obj = self.objects.get(h)
        if isinstance(obj, tuple) and obj[0] == "jstring":
            s = obj[1]
        elif isinstance(obj, str):
            s = obj
        return self.write_cstr(s)

    def _jni_new_string_utf(self):
        s = self.read_cstr(self.uc.reg_read(UC_ARM_REG_R1))
        return self._new_jstring(s)

    def _jni_new_byte_array(self):
        n = self.uc.reg_read(UC_ARM_REG_R1)
        return self._reg_handle(("out", bytearray(n)))

    def _jni_set_byte_array_region(self):
        uc = self.uc
        h = uc.reg_read(UC_ARM_REG_R1)
        off = uc.reg_read(UC_ARM_REG_R2)
        ln = uc.reg_read(UC_ARM_REG_R3)
        src = struct.unpack("<I", uc.mem_read(uc.reg_read(UC_ARM_REG_SP), 4))[0]
        obj = self.objects.get(h)
        if isinstance(obj, tuple) and obj[0] == "out":
            obj[1][off:off + ln] = bytes(uc.mem_read(src, ln))
        return 0

    # ---------- 基础设施 ----------
    def heap_alloc(self, size: int) -> int:
        size = (size + 15) & ~15
        addr = self._heap_ptr
        self._heap_ptr += size
        return addr

    def write_cstr(self, s: str) -> int:
        b = s.encode() + b"\x00"
        a = self.heap_alloc(len(b))
        self.uc.mem_write(a, b)
        return a

    def read_cstr(self, addr: int) -> str:
        out = b""
        while True:
            c = self.uc.mem_read(addr, 1)
            if c == b"\x00":
                break
            out += bytes(c)
            addr += 1
            if len(out) > 65536:
                break
        return out.decode("utf-8", "replace")

    def _reg_handle(self, obj):
        self._handle_seq += 1
        h = self._handle_seq
        self.objects[h] = obj
        return h

    def _new_jstring(self, s: str):
        return self._reg_handle(("jstring", s))

    def _hook_code(self, uc, address, size, user_data):
        handler = self.libc_handlers.get(address)
        if handler is not None:
            try:
                ret = handler()
            except Exception as e:
                raise EmuError(f"libc@{address:#x}: {e}")
            uc.reg_write(UC_ARM_REG_R0, ret & 0xFFFFFFFF)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
            return
        payload = self.symbols.get(address)
        if payload is None:
            return
        _kind, fn = payload
        try:
            ret = fn()
        except Exception as e:
            raise EmuError(f"jni@{address:#x}: {e}")
        uc.reg_write(UC_ARM_REG_R0, ret & 0xFFFFFFFF)
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def _call(self, func_offset: int, *args) -> int:
        uc = self.uc
        sentinel = self.STACK_BASE + 0x100
        uc.mem_write(sentinel, b"\x00\xbf")  # NOP (thumb)
        for i, a in enumerate(args[:4]):
            uc.reg_write(UC_ARM_REG_R0 + i, a & 0xFFFFFFFF)
        sp = uc.reg_read(UC_ARM_REG_SP)
        extra = args[4:]
        if extra:
            buf = b"".join(struct.pack("<I", a & 0xFFFFFFFF) for a in extra)
            uc.mem_write(sp - len(buf), buf)
            uc.reg_write(UC_ARM_REG_SP, sp - len(buf))
        uc.reg_write(UC_ARM_REG_LR, sentinel)
        start = (self.base + func_offset) | 1
        uc.emu_start(start, sentinel, timeout=120_000_000, count=0)
        return uc.reg_read(UC_ARM_REG_R0)

    # ---------- 高层 ----------
    def init_bax_pwd(self):
        am = self._reg_handle(("assetmgr", None))
        self._call(self.OFF_INIT, self.JNIENV_BASE, 0, am)

    def white_box_encrypt(self, challenge: str, device_id: str,
                          conn_type: str, server_time: str) -> bytes:
        jch = self._reg_handle(("jstring", challenge))
        jdev = self._reg_handle(("jstring", device_id))
        jconn = self._reg_handle(("jstring", conn_type))
        jtime = self._reg_handle(("jstring", server_time))
        h = self._call(self.OFF_ENC, self.JNIENV_BASE, 0, jch, jdev, jconn, jtime)
        obj = self.objects.get(h)
        if isinstance(obj, tuple) and obj[0] == "out":
            return bytes(obj[1])
        if isinstance(obj, (bytes, bytearray)):
            return bytes(obj)
        return b""


class KplPySigner:
    """对外：一次初始化，多次签名"""

    def __init__(self, signer_dir: str, verbose: bool = False):
        self.emu = KplSoEmu(signer_dir, verbose)
        self.emu.init_bax_pwd()

    def sign(self, challenge: str, device_id: str, conn_type: str, server_time: str) -> bytes:
        return self.emu.white_box_encrypt(challenge, device_id, conn_type, server_time)


if __name__ == "__main__":
    import sys
    import json
    d = os.path.dirname(os.path.abspath(__file__))
    signer = KplPySigner(d)
    print("[pysigner] ready", file=sys.stderr)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            out = signer.sign(req.get("challenge", ""), req.get("device_id", ""),
                              req.get("conn_type", "99"), str(req.get("server_time", "")))
            print(json.dumps({"sig": out.hex()}))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
        sys.stdout.flush()
