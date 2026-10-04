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
import json
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
S_GET_BYTE_ARRAY_REGION = 200
S_CALL_OBJECT_METHOD = 34
S_CALL_OBJECT_METHOD_V = 35
S_EXCEPTION_CHECK = 228
S_GET_STRING_UTF_LENGTH = 168
S_NEW_GLOBAL_REF = 76
S_DELETE_LOCAL_REF = 117
S_GET_STATIC_METHOD_ID = 113
S_CALL_STATIC_VOID_METHOD_V = 142
S_CALL_BOOLEAN_METHOD_V = 49
S_CALL_VOID_METHOD_V = 62
S_GET_JAVA_VM = 219
S_THROW_NEW = 14
S_EXCEPTION_OCCURRED = 15
S_MONITOR_ENTER = 217
S_MONITOR_EXIT = 218
S_ENSURE_LOCAL_CAPACITY = 27


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
    OFF_PROVIDER_LOAD = 0x196174   # OSSL_PROVIDER_try_load（OpenSSL 3 default provider 激活，retain=1）
    OFF_PROVIDER_ADD_BUILTIN = 0x196398   # OSSL_PROVIDER_add_builtin
    OFF_DEFAULT_PROVIDER_INIT = 0x234ae4  # ossl_default_provider_init
    OFF_OPENSSL_INIT = 0x185e2c   # OPENSSL_init_crypto

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
        self._magic_name = {}
        self._assets = {}          # name -> bytes（白盒表）
        self._evp_log = []         # EVP 边界 dump 记录
        self.magic_log = []        # magic 调用日志（verbose）
        self._unmapped_seen = set()
        self._retprobes = {}       # EVP 函数名 -> 返回值探针 magic
        self._retprobe_lr = {}
        self._trace_init = False   # EncryptInit_ex 窗口块级 trace
        self._watch_memcpy = False
        self._init_trace = []

        cert = open(os.path.join(signer_dir, "cert.der"), "rb").read()
        so = open(os.path.join(signer_dir, _SO_NAME), "rb").read()

        # 白盒表：从 kpl_min.apk 提取 assets/middle_new.bin
        import zipfile
        apk_path = os.path.join(signer_dir, "kpl_min.apk")
        with zipfile.ZipFile(apk_path) as z:
            self._assets["middle_new.bin"] = z.read("assets/middle_new.bin")

        self._so_bytes = so
        self._load_elf(so)
        self.uc.mem_map(self.STACK_BASE, self.STACK_SIZE)
        self.uc.reg_write(UC_ARM_REG_SP, self.STACK_BASE + self.STACK_SIZE - 0x10000)
        # 启用 NEON/VFP（unidbg 同款: CPACR CP10/CP11 + FPEXC.EN）
        self.uc.reg_write(UC_ARM_REG_C1_C0_2, 0xF00000)
        self.uc.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.uc.mem_map(self.HEAP_BASE, self.HEAP_SIZE)
        self._heap_ptr = self.HEAP_BASE
        # NULL 页：so 内部 OBJ 名字表注册等非必需副作用会解引用 NULL，
        # 映射零页让这些读返回 0 而不中断（数据本就不被业务使用）
        self.uc.mem_map(0, 0x1000)
        # bionic TLS：Android arm32 __get_tls() 读 cp15 c13 c0 3（TPIDRURO）。
        # unicorn 默认 0 → BoringSSL 线程局部错误状态/ossl_err_get_state_int 读 NULL。
        self._tls_base = self.heap_alloc(0x800)
        self.uc.reg_write(UC_ARM_REG_C13_C0_3, self._tls_base)
        self._errno_addr = self.heap_alloc(8)
        self._init_libc()
        self._build_jnienv()
        # ⭐ 重定位必须在 libc/JNI 桩注册之后执行，否则全部导入解析失败
        self._apply_relocs(self._so_bytes)
        # _fix_bare_vaddrs 已停用：RELATIVE/JUMP_SLOT 正规修复后它会把表内小整数 id 误 +base（污染 core dispatch 表）
        # self._fix_bare_vaddrs(self._so_bytes)
        self.uc.hook_add(UC_HOOK_CODE, self._hook_code,
                         begin=self.MAGIC_BASE, end=self.MAGIC_BASE + 0x100000)
        # ⭐ BoringSSL 全局初始化（objects 哈希表等）在 .init_array 构造函数里，
        # 不跑则 OPENSSL_LH_insert 读 NULL。unidbg 加载器同款时机：重定位后、业务调用前。
        self._run_init_array(self._so_bytes)
        # ⭐ OpenSSL 3.x：静态链接下先 OPENSSL_init_crypto 建全局基础设施（provider store 等）
        try:
            r0 = self._call(self.OFF_OPENSSL_INIT, 0, 0, arm=True)   # 基础 init；ADD_ALL 标志依赖 provider 会鸡生蛋失败
            print(f"[OSSL] OPENSSL_init_crypto -> {r0:#x}", file=sys.stderr)
        except EmuError as e:
            print(f"[OSSL] init_crypto 失败: {e}", file=sys.stderr)
        # ⭐ EncryptInit_ex 走 evp_generic_fetch→provider 查找，
        # 静态链接下 default provider 不自动激活——先 add_builtin 内建实现再 load
        try:
            nb = self.write_cstr("default")
            r1 = self._call(self.OFF_PROVIDER_ADD_BUILTIN, 0, nb, self.base + self.OFF_DEFAULT_PROVIDER_INIT, arm=True)
            print(f"[OSSL] add_builtin(default) -> {r1:#x}", file=sys.stderr)
            r = self._call(self.OFF_PROVIDER_LOAD, 0, nb, 1, arm=True)
            print(f"[OSSL] OSSL_PROVIDER_load(default) -> {r:#x}", file=sys.stderr)
        except EmuError as e:
            print(f"[OSSL] provider load 失败: {e}", file=sys.stderr)

        self._pc_hist = []
        self._emu_error = None
        self._in_so = (self.base, self.base + 0x400000)

        def _on_unmapped(uc, access, address, size, value, user_data):
            pc = uc.reg_read(UC_ARM_REG_PC)
            lr = uc.reg_read(UC_ARM_REG_LR)
            hist = " ".join(hex(x) for x in self._pc_hist[-12:])
            self._emu_error = (f"UNMAPPED access={access} addr={address:#x} pc={pc:#x} lr={lr:#x} 近期PC: {hist}")
            return False   # 让 unicorn 报错停止；错误详情在 _emu_error
        self.uc.hook_add(UC_HOOK_MEM_UNMAPPED, _on_unmapped)
        self._trace_n = 0

        def _pc_hist_hook(uc, address, size, ud):
            self._pc_hist.append(address)
            if len(self._pc_hist) > 24:
                del self._pc_hist[:12]
        # 全局 PC 记录（性能可接受：仅列表追加）
        self.uc.hook_add(UC_HOOK_CODE, _pc_hist_hook)

        # EVP 边界 hook（按符号偏移，开发期分析仪器）
        self._evp_dump_enabled = True
        self._hook_evp_boundary()
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
        # 重定位延迟到 _init_libc/_build_jnienv 之后（见 __init__）

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
        # 注册 so 自身 DEFINED 符号（导出/内部），供重定位与 PLT 解析
        self._so_size = 0
        for sec in secs:
            if sec["type"] != 11:   # SHT_DYNSYM=11（6 是 SHT_DYNAMIC，曾写错致 DEFINED 符号全没注册）
                continue
            n = sec["size"] // 16
            for i in range(n):
                off = sec["off"] + i * 16
                st_name, st_value, _st_size, st_info, _st_other = struct.unpack_from("<IIIBB", data, off)
                st_shndx = struct.unpack_from("<H", data, off + 14)[0]
                if st_shndx == 0 or st_value == 0:
                    continue
                end = data.find(b"\x00", dynstr["off"] + st_name)
                name2 = data[dynstr["off"] + st_name:end].decode()
                if name2 and name2 not in self._symbol_addr:
                    self._symbol_addr[name2] = st_value   # 存偏移（调用时 +base）
        self._so_size = max(s["addr"] + s["size"] for s in secs if s["addr"] and s["size"]) or 0x400000

        for relname in (".rel.dyn", ".rel.plt"):
            rel = byname.get(relname)
            if not rel:
                continue
            n = rel["size"] // 8
            for i in range(n):
                off = rel["off"] + i * 8
                r_offset, r_info = struct.unpack_from("<II", data, off)
                rtype = r_info & 0xFF
                if rtype == 23:   # R_ARM_RELATIVE：现值 += base（核心！12201 个，函数指针表全靠它）
                    # 从 emu 内存读（bss 区无文件数据；LOAD 时文件 addend 已写入）
                    cur = struct.unpack("<I", bytes(self.uc.mem_read(self.base + r_offset, 4)))[0]
                    if cur:
                        self.uc.mem_write(self.base + r_offset, struct.pack("<I", (cur + self.base) & 0xFFFFFFFF))
                    continue
                if rtype == 3:   # R_ARM_REL32: 相对地址需 +base
                    cur = struct.unpack_from("<I", data, r_offset)[0]
                    self.uc.mem_write(self.base + r_offset, struct.pack("<I", (cur + self.base) & 0xFFFFFFFF))
                    continue
                if rtype not in (7, 2, 21, 22):   # JUMP_SLOT / ABS32 / GLOB_DAT / COPY
                    continue
                sym = symname(r_info >> 8)
                fn_addr = self._symbol_for(sym)
                if fn_addr is not None:
                    if fn_addr < self._so_size:      # 存的是偏移 → +base
                        fn_addr = (self.base + fn_addr) & 0xFFFFFFFF
                    self.uc.mem_write(self.base + r_offset, struct.pack("<I", fn_addr))
                elif rtype == 21:
                    # GLOB_DAT 数据对象（__stack_chk_guard 等）: 分配真实内存（canary=0 可用）
                    data_addr = self.heap_alloc(16)
                    self.uc.mem_write(self.base + r_offset, struct.pack("<I", data_addr))
                else:
                    # std::string 家族按符号名挂通用模拟器；其余未桩 → 陷阱（执行时报符号名）
                    fn2 = self._stdstring_handler(sym)
                    if fn2 is not None:
                        addr2 = self._new_magic("stdstr", sym[:40])
                        self.libc_handlers[addr2] = fn2
                        self._symbol_addr[sym] = addr2
                        self._magic_name[addr2] = sym[:48]
                        self.uc.mem_write(self.base + r_offset, struct.pack("<I", addr2))
                        continue
                    trap = self._new_magic("unimpl", sym)
                    self.libc_handlers[trap] = ("unimpl", sym)
                    self.uc.mem_write(self.base + r_offset, struct.pack("<I", trap))

    def _run_init_array(self, data):
        """执行 .init_array 构造函数（BoringSSL CRYPTO_library_init 等）。"""
        for sec in self._sections(data):
            if sec["type"] != 14 or not sec["addr"] or not sec["size"]:   # SHT_INIT_ARRAY
                continue
            n = sec["size"] // 4
            for i in range(n):
                fn, = struct.unpack_from("<I", data, sec["off"] + i * 4)
                if fn:
                    try:
                        self._call(fn, 0, 0, 0)
                    except EmuError as e:
                        print(f"[init_array[{i}]] fn={fn:#x} 出错: {e}", file=sys.stderr)

    def _fix_bare_vaddrs(self, data):
        """未重定位的 GOT/数据指针残留裸 vaddr（lazy PLT 初值等）→ +base。
        ⭐ 读 emu 当前内存值判断（reloc 已写的 magic/heap 值不在 so vaddr 范围，不会被覆盖）。"""
        secs = self._sections(data)
        hi = self._so_size
        for sec in secs:
            if sec["type"] != 1 or sec["size"] < 4 or sec["addr"] == 0:
                continue
            if sec["name"] not in (".got", ".got.plt", ".data.rel.ro", ".data", ".bss"):
                continue
            for k in range(0, sec["size"] - 3, 4):
                addr = self.base + sec["addr"] + k
                v = struct.unpack("<I", self.uc.mem_read(addr, 4))[0]
                if 0 < v < hi:
                    self.uc.mem_write(addr, struct.pack("<I", (v + self.base) & 0xFFFFFFFF))

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

        def _posix_memalign():
            # int posix_memalign(void **memptr, size_t alignment, size_t size)
            out = uc.reg_read(UC_ARM_REG_R0)
            buf = self.heap_alloc(uc.reg_read(UC_ARM_REG_R2))
            uc.mem_write(out, struct.pack("<I", buf))
            return 0

        def _mmap():
            return self.heap_alloc(max(uc.reg_read(UC_ARM_REG_R1), 0x1000))

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
                data = bytes(uc.mem_read(src, n))
                if self._watch_memcpy and n <= 64:
                    print(f"[memcpy] n={n} dst={dst:#x} src={src:#x} data={data.hex()}", file=sys.stderr)
                uc.mem_write(dst, data)
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
            if self.verbose:
                print(f"[memcmp] a={a.hex()} b={b.hex()} n={n}", file=sys.stderr)
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

        def _getentropy():
            buf, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)
            uc.mem_write(buf, bytes(range(n & 0xFF)))
            return 0

        def _strdup():
            src = uc.reg_read(UC_ARM_REG_R0)
            s = self.read_cstr(src)
            return self.write_cstr(s)

        def _sprintf():
            dst = uc.reg_read(UC_ARM_REG_R0)
            fmt = self.read_cstr(uc.reg_read(UC_ARM_REG_R1))
            # 极简 %d/%s/%x 处理（栈上变参：r2,r3,[sp],[sp+4]...）
            regs = [uc.reg_read(UC_ARM_REG_R2), uc.reg_read(UC_ARM_REG_R3)]
            sp = uc.reg_read(UC_ARM_REG_SP)
            extra = [struct.unpack("<I", uc.mem_read(sp + i * 4, 4))[0] for i in range(4)]
            vals = regs + extra
            vi = 0
            out = []
            i = 0
            while i < len(fmt):
                c = fmt[i]
                if c == "%" and i + 1 < len(fmt):
                    spec = fmt[i + 1]
                    v = vals[vi] if vi < len(vals) else 0
                    vi += 1
                    if spec == "d":
                        out.append(str(v - 0x100000000 if v >= 0x80000000 else v))
                    elif spec == "u":
                        out.append(str(v))
                    elif spec == "s":
                        out.append(self.read_cstr(v))
                    elif spec == "x":
                        out.append(format(v, "x"))
                    elif spec == "c":
                        out.append(chr(v & 0xFF))
                    elif spec == "%":
                        out.append("%")
                        vi -= 1
                    i += 2
                    continue
                out.append(c)
                i += 1
            res = "".join(out).encode() + b"\x00"
            uc.mem_write(dst, res)
            return len(res) - 1

        def _aasset_open():
            name = self.read_cstr(uc.reg_read(UC_ARM_REG_R1))
            data = self._assets.get(name)
            if data is None:
                print(f"[AAsset] open MISS: {name}", file=sys.stderr)
                return 0
            h = self._reg_handle(["aasset", name, data, 0])   # list：pos 分块续读要可变
            print(f"[AAsset] open {name} len={len(data)}", file=sys.stderr)
            return h

        def _aasset_len():
            obj = self.objects.get(uc.reg_read(UC_ARM_REG_R0))
            if isinstance(obj, (list, tuple)) and obj[0] == "aasset":
                return len(obj[2])
            return 0

        def _aasset_read():
            h = uc.reg_read(UC_ARM_REG_R0)
            obj = self.objects.get(h)
            buf = uc.reg_read(UC_ARM_REG_R1)
            cnt = uc.reg_read(UC_ARM_REG_R2)
            if isinstance(obj, (list, tuple)) and obj[0] == "aasset":
                _, _, data, pos = obj
                chunk = data[pos:pos + cnt]
                uc.mem_write(buf, chunk)
                self.objects[h] = ["aasset", obj[1], data, pos + len(chunk)]
                return len(chunk)
            return 0

        # 摘要族桩：SHA256(data, len, out) 等标准签名，返回 out
        def _sha_stub(alg, out_len):
            def _f():
                import hashlib
                p = self.uc.reg_read(UC_ARM_REG_R0)
                n = self.uc.reg_read(UC_ARM_REG_R1)
                out = self.uc.reg_read(UC_ARM_REG_R2)
                raw = bytes(self.uc.mem_read(p, n)) if n else b""
                d = hashlib.new(alg, raw).digest()[:out_len]
                if out:
                    self.uc.mem_write(out, d)
                return out
            return _f

        def _pthread_key_create():
            # int pthread_key_create(pthread_key_t *key, destructor)：分配 TLS 槽号
            out = uc.reg_read(UC_ARM_REG_R0)
            slot = getattr(self, "_tls_slot_seq", 16)
            self._tls_slot_seq = slot + 1
            if out:
                uc.mem_write(out, struct.pack("<I", slot * 4))
            return 0

        def _pthread_getspecific():
            slot = uc.reg_read(UC_ARM_REG_R0)
            return struct.unpack("<I", uc.mem_read(self._tls_base + slot, 4))[0]

        def _pthread_setspecific():
            slot = uc.reg_read(UC_ARM_REG_R0)
            val = uc.reg_read(UC_ARM_REG_R1)
            uc.mem_write(self._tls_base + slot, struct.pack("<I", val))
            return 0

        def _pthread_once():
            # int pthread_once(once_control, init_routine)：首次真执行 init（CRYPTO_THREAD_run_once 依赖）
            ctrl = uc.reg_read(UC_ARM_REG_R0)
            fn = uc.reg_read(UC_ARM_REG_R1)
            if ctrl:
                done = struct.unpack("<I", uc.mem_read(ctrl, 4))[0]
                if not done and fn:
                    uc.mem_write(ctrl, struct.pack("<I", 1))
                    fp = fn & ~1
                    self._call(fp, arm=not (fn & 1))
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
            "qsort": 0,
            "mmap": _mmap, "mprotect": 0, "mlock": 0, "madvise": 0, "munmap": 0,
            "posix_memalign": _posix_memalign,
            "sysconf": 4096,
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
            "pthread_once": _pthread_once, "pthread_getspecific": _pthread_getspecific,
            "pthread_setspecific": _pthread_setspecific, "pthread_key_create": _pthread_key_create,
            "pthread_key_delete": 0,
            "getentropy": lambda: _getentropy(),
            "strdup": lambda: _strdup(),
            "sprintf": lambda: _sprintf(),
            "snprintf": 0, "__sprintf_chk": lambda: _sprintf(),
            "ioctl": 0, "write": 0, "fstat": 0, "gai_strerror": 0,
            # AAsset 五件套（initBaxPwd 经原生接口读 assets/middle_new.bin 白盒表）
            "AAssetManager_fromJava": lambda: uc.reg_read(UC_ARM_REG_R1),
            "AAssetManager_open": lambda: _aasset_open(),
            "AAsset_getLength": lambda: _aasset_len(),
            "AAsset_read": lambda: _aasset_read(),
            "AAsset_close": 0,
            "abort": 0, "getsockopt": 0xFFFFFFFF,
            "__FD_SET_chk": 0,
            "SHA256": _sha_stub("sha256", 32),
            "SHA1": _sha_stub("sha1", 20),
            "SHA512": _sha_stub("sha512", 64),
            "SHA384": _sha_stub("sha384", 48),
            "MD5": _sha_stub("md5", 16),
            # C++ runtime：operator new/delete 族（Itanium ABI）
            "_Znwj": lambda: malloc(),            # operator new(uint)
            "_Znam": lambda: malloc(),            # operator new[](uint)
            "_ZdlPv": 0,                          # operator delete(void*)
            "_ZdaPv": 0,                          # operator delete[](void*)
            "_Znwm": lambda: malloc(),            # operator new(ulong) 变体
            "__cxa_begin_catch": 0, "__cxa_end_catch": 0,
            "__cxa_allocate_exception": lambda: malloc(),
            "__cxa_free_exception": 0, "__cxa_throw": 0, "__cxa_guard_acquire": 0,
            "__cxa_guard_release": 0, "__cxa_atexit": 0,
            "getauxval": 0,   # BoringSSL CPU 能力探测：返回 0 走纯 C 路径
            "__errno": lambda: self._errno_addr,   # 必须返回真 int*（NULL 被解引用）
        }
        for name, ret in libc.items():
            addr = self._new_magic("libc", name)
            self.libc_handlers[addr] = (lambda r: (lambda: r))(ret) if not callable(ret) else ret
            self._symbol_addr[name] = addr
            self._magic_name[addr] = name

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
            S_CALL_OBJECT_METHOD: self._jni_call_object_method_v,
            S_CALL_OBJECT_METHOD_V: self._jni_call_object_method_v,
            S_GET_ARRAY_LENGTH: self._jni_get_array_length,
            S_GET_OBJECT_ARRAY_ELEMENT: self._jni_get_object_array_element,
            S_GET_STRING_UTF_CHARS: self._jni_get_string_utf_chars,
            S_RELEASE_STRING_UTF_CHARS: lambda: 0,
            S_NEW_STRING_UTF: self._jni_new_string_utf,
            S_NEW_BYTE_ARRAY: self._jni_new_byte_array,
            S_SET_BYTE_ARRAY_REGION: self._jni_set_byte_array_region,
            S_GET_OBJECT_CLASS: lambda: self._reg_handle(("class", None)),
            S_GET_BYTE_ARRAY_REGION: self._jni_get_byte_array_region,
            S_EXCEPTION_CHECK: lambda: 0,
            S_GET_STRING_UTF_LENGTH: self._jni_get_string_utf_length,
            S_NEW_GLOBAL_REF: lambda: uc.reg_read(UC_ARM_REG_R1),
            S_DELETE_LOCAL_REF: lambda: 0,
            S_GET_STATIC_METHOD_ID: self._jni_get_method_id,
            S_GET_METHOD_ID: self._jni_get_method_id,
            S_CALL_STATIC_VOID_METHOD_V: lambda: 0,
            S_CALL_BOOLEAN_METHOD_V: lambda: 1,
            S_CALL_VOID_METHOD_V: lambda: 0,
            S_GET_JAVA_VM: lambda: self._reg_handle(("javavm", None)),
            S_THROW_NEW: lambda: 0,
            S_EXCEPTION_OCCURRED: lambda: 0,
            S_MONITOR_ENTER: lambda: 0,
            S_MONITOR_EXIT: lambda: 0,
            S_ENSURE_LOCAL_CAPACITY: lambda: uc.reg_read(UC_ARM_REG_R1),
        }
        # Get*ArrayElements 族（180-199 批量）：r1=数组句柄 → 返回堆缓冲【原生指针】
        # （JNI 语义：返回 jbyte* 供 native 直接读写，非 jobject 句柄）
        def _jni_get_array_elements():
            h = self.uc.reg_read(UC_ARM_REG_R1)
            obj = self.objects.get(h)
            data = b""
            if isinstance(obj, tuple) and obj[0] in ("out", "bytes"):
                data = bytes(obj[1])
            addr = self.heap_alloc(max(len(data), 1))
            if data:
                self.uc.mem_write(addr, data)
            return addr
        for _slot in range(180, 200):
            if _slot not in slots:
                addr = self._new_magic("jni", _slot)
                self.uc.mem_write(env_table + _slot * 4, struct.pack("<I", addr))
                self._magic_name[addr] = "JNI.arr#%d" % _slot
                slots[_slot] = _jni_get_array_elements
        _jni_names = {
            6: "FindClass", 31: "GetObjectClass", 33: "GetMethodID", 94: "GetFieldID",
            95: "GetObjectField", 144: "GetStaticFieldID", 145: "GetStaticObjectField",
            115: "CallStaticObjectMethodV", 34: "CallObjectMethod", 35: "CallObjectMethodV",
            171: "GetArrayLength", 173: "GetObjectArrayElement", 169: "GetStringUTFChars",
            170: "ReleaseStringUTFChars", 167: "NewStringUTF", 176: "NewByteArray",
            207: "SetByteArrayRegion", 200: "GetByteArrayRegion", 228: "ExceptionCheck",
            168: "GetStringUTFLength", 76: "NewGlobalRef", 117: "DeleteLocalRef",
            113: "GetStaticMethodID", 142: "CallStaticVoidMethodV", 49: "CallBooleanMethodV",
            62: "CallVoidMethodV", 219: "GetJavaVM", 14: "ThrowNew", 15: "ExceptionOccurred",
            217: "MonitorEnter", 218: "MonitorExit", 27: "EnsureLocalCapacity",
        }
        for slot, fn in slots.items():
            addr = self._new_magic("jni", fn)
            self.uc.mem_write(env_table + slot * 4, struct.pack("<I", addr))
            self._magic_name[addr] = "JNI." + _jni_names.get(slot, f"slot{slot}")

    # ---------- JNI 实现 ----------
    def _jni_find_class(self):
        name = self.read_cstr(self.uc.reg_read(UC_ARM_REG_R1))
        return self._reg_handle(("class", name))

    def _jni_get_method_id(self):
        uc = self.uc
        name = self.read_cstr(uc.reg_read(UC_ARM_REG_R2))
        sig = self.read_cstr(uc.reg_read(UC_ARM_REG_R3))
        h = self._reg_handle(("method", name, sig))
        self.methods[h] = name + "|" + sig   # 名字+签名都留，供调用点匹配（如 toByteArray）
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
        idx = self.uc.reg_read(UC_ARM_REG_R2)   # JNI 第 3 参 index 在 r2（env,array,index）
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

    def _jni_get_byte_array_region(self):
        uc = self.uc
        h = uc.reg_read(UC_ARM_REG_R1)
        off = uc.reg_read(UC_ARM_REG_R2)
        ln = uc.reg_read(UC_ARM_REG_R3)
        dst = struct.unpack("<I", uc.mem_read(uc.reg_read(UC_ARM_REG_SP), 4))[0]
        obj = self.objects.get(h)
        if isinstance(obj, tuple) and obj[0] in ("out", "bytes"):
            data = bytes(obj[1])
            uc.mem_write(dst, data[off:off + ln])
        return 0

    def _jni_get_string_utf_length(self):
        h = self.uc.reg_read(UC_ARM_REG_R1)
        obj = self.objects.get(h)
        if isinstance(obj, tuple) and obj[0] == "jstring":
            return len(obj[1].encode())
        return 0

    # ---------- EVP 边界 hook（开发期分析：dump key/IV/明文/密文） ----------
    EVP_OFFS = {
        0xec8d8: "EncryptInit_ex",
        0xebac8: "CipherInit_ex",
        0xebb24: "EncryptUpdate",
        0xec1a4: "EncryptFinal_ex",
        0xecf98: "CTX_ctrl",
        0xe9958: "wbsm4_gcm_get",
    }
    EVP_OFFS_BY_NAME = {v: k for k, v in EVP_OFFS.items()}

    def _hook_evp_boundary(self):
        for off, name in self.EVP_OFFS.items():
            addr = self.base + off
            self.uc.hook_add(UC_HOOK_CODE, self._make_evp_hook(name), begin=addr, end=addr)
            # 返回值探针：入口改 LR → magic 打印 R0 后跳回
            m = self._new_magic("evpret", name)
            self.libc_handlers[m] = ("retprobe", name)
            self._magic_name[m] = "EVP.RET." + name
            self._retprobes[name] = m
        # 白盒核心三函数入口（ARM 模式）
        for off, name in ((0x1dffd0, "wb_set_key"), (0x1e10b4, "wb_encrypt"),
                          (0x1e0018, "wb_gen"), (0x1dfff4, "wb_export")):
            self.uc.hook_add(UC_HOOK_CODE, self._make_wb_hook(name), begin=self.base + off, end=self.base + off)
        # EncryptInit_ex 窗口的块级 trace
        self.uc.hook_add(UC_HOOK_BLOCK, self._trace_block)

    def _trace_block(self, uc, address, size, ud):
        if getattr(self, "_trace_init", False):
            self._init_trace.append(address)
            if len(self._init_trace) > 4000:
                del self._init_trace[:2000]

    def _make_wb_hook(self, name):
        def _h(uc, address, size, ud):
            r = [uc.reg_read(UC_ARM_REG_R0 + i) for i in range(3)]
            rec = {"fn": name, "r": [hex(x) for x in r]}
            if name in ("wb_set_key", "wb_export"):
                rec["key@r1"] = self._safe_read(r[1], 16).hex()
                rec["bits@r2"] = r[2]
            elif name == "wb_encrypt":
                # 实参序：r0=in 块(IV||ctr) r1=out 块 r2=ctx
                rec["in16"] = self._safe_read(r[0], 16).hex()
                rec["out16"] = self._safe_read(r[1], 16).hex()
                rec["ctx"] = hex(r[2])
            self._evp_log.append(rec)
            print(f"[WB.{name}] {json.dumps(rec)}", file=sys.stderr)
        return _h

    def _safe_read(self, addr, n):
        try:
            return bytes(self.uc.mem_read(addr, n))
        except Exception:
            return b"?"

    def _make_evp_hook(self, name):
        def _h(uc, address, size, ud):
            r = [uc.reg_read(UC_ARM_REG_R0 + i) for i in range(5)]
            # 挂返回值探针（只对会返回 int 的主链函数）
            if name in self._retprobes and address == self.base + self.EVP_OFFS_BY_NAME.get(name, -1):
                old_lr = uc.reg_read(UC_ARM_REG_LR)
                self._retprobe_lr[name] = old_lr
                uc.reg_write(UC_ARM_REG_LR, self._retprobes[name])
                if name == "EncryptInit_ex":
                    self._trace_init = True   # 块级 trace 窗口开
            sp = uc.reg_read(UC_ARM_REG_SP)
            rec = {"fn": name, "r": [hex(x) for x in r[:4]]}
            if name in ("EncryptInit_ex", "CipherInit_ex"):
                # (ctx, cipher, impl, key, iv, enc) r3=key, [sp]=iv, [sp+4]=enc
                rec["key@r3"] = self._safe_read(r[3], 16).hex()
                ivp = struct.unpack("<I", uc.mem_read(sp, 4))[0]
                rec["iv@[sp]"] = self._safe_read(ivp, 16).hex()
                rec["cipher@r1"] = hex(r[1])
                # dump EVP_CIPHER 结构头部（nid/bs/kl/ivl/ctxsz/flags + init/do_cipher/ctrl 指针）
                rec["cipher_struct"] = self._safe_read(r[1], 64).hex()
            elif name == "EncryptUpdate":
                # (ctx, out, *outl, in, inl): r3=in, [sp]=inl
                inl = struct.unpack("<I", uc.mem_read(sp, 4))[0]
                rec["pt"] = self._safe_read(r[3], min(inl, 128)).hex()
                rec["inl"] = inl
                rec["out@r1"] = hex(r[1])
            elif name == "EncryptFinal_ex":
                # (ctx, out, *outl, tag, *tagl): r1=out [sp]=outl r3=tag [sp+4]=tagl
                try:
                    outl = struct.unpack("<I", uc.mem_read(sp, 4))[0]
                    tagl = struct.unpack("<I", uc.mem_read(sp + 4, 4))[0]
                except Exception:
                    outl = tagl = 16
                rec["out@r1"] = hex(r[1])
                rec["tag@r3"] = self._safe_read(r[3], 16).hex()
            elif name == "CTX_ctrl":
                rec["type"] = r[1]
                rec["arg"] = r[2]
                rec["ptr@r3"] = self._safe_read(r[3], 16).hex()
            elif name == "wbsm4_gcm_get":
                # 返回后才能拿到结构体——挂一次性返回 hook 太重，直接在 result 收集阶段读
                pass
            self._evp_log.append(rec)
            print(f"[EVP.{name}] {json.dumps(rec)}", file=sys.stderr)
        return _h

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

    # ---------- libc++ std::string 通用模拟（32 位 SSO 布局） ----------
    # short: [size<<1][data 11B]；long: [cap|1][size][ptr]。成员函数 this=r0。
    def _stdstring_handler(self, sym: str):
        if "basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE" not in sym:
            return None
        uc = self.uc
        import struct as _s

        def read(this):
            raw = bytes(self.uc.mem_read(this, 12))
            if raw[0] & 1:   # long
                size = int.from_bytes(raw[4:8], "little")
                ptr = int.from_bytes(raw[8:12], "little")
                return bytes(self.uc.mem_read(ptr, size)), ptr, size
            n = raw[0] >> 1
            return raw[1:1 + n], this + 1, n

        def write(this, new: bytes):
            if len(new) <= 10:
                self.uc.mem_write(this, bytes([len(new) << 1]) + new + b"\x00" * (11 - len(new)))
                return this + 1
            buf = self.heap_alloc(len(new) + 1)
            self.uc.mem_write(buf, new + b"\x00")
            self.uc.mem_write(this, _s.pack("<III", (len(new) + 1) | 1, len(new), buf))
            return buf

        def h_append(this, add: bytes):
            cur, _, _ = read(this)
            write(this, cur + add)
            return this

        def h_ctor(this, init: bytes):
            write(this, init)
            return this

        tail = sym
        if "6appendEPKcj" in tail:
            return lambda: h_append(uc.reg_read(UC_ARM_REG_R0),
                                    bytes(self.uc.mem_read(uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2))))
        if "6appendEPKc" in tail:
            return lambda: h_append(uc.reg_read(UC_ARM_REG_R0),
                                    self.read_cstr(uc.reg_read(UC_ARM_REG_R1)).encode())
        if "6appendERKS" in tail:
            return lambda: h_append(uc.reg_read(UC_ARM_REG_R0), read(uc.reg_read(UC_ARM_REG_R1))[0])
        if "6assignEPKcj" in tail or "aSEPKcj" in tail:
            return lambda: (write(uc.reg_read(UC_ARM_REG_R0),
                                  bytes(self.uc.mem_read(uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)))),
                            uc.reg_read(UC_ARM_REG_R0))[1]
        if "6assignEPKc" in tail or "aSEPKc" in tail:
            return lambda: (write(uc.reg_read(UC_ARM_REG_R0), self.read_cstr(uc.reg_read(UC_ARM_REG_R1)).encode()),
                            uc.reg_read(UC_ARM_REG_R0))[1]
        if "aSERKS" in tail:
            return lambda: (write(uc.reg_read(UC_ARM_REG_R0), read(uc.reg_read(UC_ARM_REG_R1))[0]),
                            uc.reg_read(UC_ARM_REG_R0))[1]
        if "9push_backEc" in tail:
            return lambda: h_append(uc.reg_read(UC_ARM_REG_R0), bytes([uc.reg_read(UC_ARM_REG_R1) & 0xFF]))
        if "pLEPKc" in tail:
            return lambda: h_append(uc.reg_read(UC_ARM_REG_R0), self.read_cstr(uc.reg_read(UC_ARM_REG_R1)).encode())
        if "pLERKS" in tail:
            return lambda: h_append(uc.reg_read(UC_ARM_REG_R0), read(uc.reg_read(UC_ARM_REG_R1))[0])
        if "5c_strEv" in tail or "4dataEv" in tail or "5c_strB5cxx11Ev" in tail:
            return lambda: read(uc.reg_read(UC_ARM_REG_R0))[1]
        if "4sizeEv" in tail or "6lengthEv" in tail:
            return lambda: read(uc.reg_read(UC_ARM_REG_R0))[2]
        if "5emptyEv" in tail:
            return lambda: 1 if read(uc.reg_read(UC_ARM_REG_R0))[2] == 0 else 0
        if "5clearEv" in tail:
            return lambda: (write(uc.reg_read(UC_ARM_REG_R0), b""), uc.reg_read(UC_ARM_REG_R0))[1]
        if "7reserveEj" in tail or "8capacityEv" in tail:
            return lambda: uc.reg_read(UC_ARM_REG_R0)
        if "C1EPKcj" in tail or "C2EPKcj" in tail:
            return lambda: h_ctor(uc.reg_read(UC_ARM_REG_R0),
                                  bytes(self.uc.mem_read(uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2))))
        if "C1EPKc" in tail or "C2EPKc" in tail:
            return lambda: h_ctor(uc.reg_read(UC_ARM_REG_R0), self.read_cstr(uc.reg_read(UC_ARM_REG_R1)).encode())
        if "C1ERKS" in tail or "C2ERKS" in tail:
            return lambda: h_ctor(uc.reg_read(UC_ARM_REG_R0), read(uc.reg_read(UC_ARM_REG_R1))[0])
        if "C1Ev" in tail or "C2Ev" in tail:
            return lambda: h_ctor(uc.reg_read(UC_ARM_REG_R0), b"")
        if "D1Ev" in tail or "D2Ev" in tail:
            return lambda: 0   # 析构：泄漏不管
        if "ixEj" in tail:     # operator[](i) → 返回字符地址（lvalue）
            def _at():
                this = uc.reg_read(UC_ARM_REG_R0)
                i = uc.reg_read(UC_ARM_REG_R1)
                _d, ptr, _n = read(this)
                if ptr == this + 1:
                    return this + 1 + i
                return ptr + i
            return _at
        return None

    def _hook_code(self, uc, address, size, user_data):
        handler = self.libc_handlers.get(address)
        if handler is not None:
            if isinstance(handler, tuple):
                if handler[0] == "retprobe":
                    # EVP 返回值探针：打印 R0，恢复真 LR（不写 R0，保留真返回值）
                    nm = handler[1]
                    if nm == "EncryptInit_ex":
                        self._trace_init = False
                        print("[INIT-TRACE 尾 40 块] " + " ".join(hex(x - self.base) for x in self._init_trace[-40:]), file=sys.stderr)
                    print(f"[EVP.RET {nm}] r0={uc.reg_read(UC_ARM_REG_R0):#x}", file=sys.stderr)
                    self._evp_log.append({"fn": "RET." + nm, "r0": hex(uc.reg_read(UC_ARM_REG_R0))})
                    uc.reg_write(UC_ARM_REG_LR, self._retprobe_lr.pop(nm, uc.reg_read(UC_ARM_REG_LR)))
                    uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
                    return
                raise EmuError(f"未桩导入被调用: {handler[1]} pc={address:#x} lr={uc.reg_read(UC_ARM_REG_LR):#x}")
            try:
                ret = handler()
            except Exception as e:
                raise EmuError(f"libc {self._magic_name.get(address, hex(address))}@{address:#x}: {type(e).__name__}: {e} r0={uc.reg_read(UC_ARM_REG_R0):#x} r1={uc.reg_read(UC_ARM_REG_R1):#x} r2={uc.reg_read(UC_ARM_REG_R2):#x} pc={address:#x} lr={uc.reg_read(UC_ARM_REG_LR):#x}")
            if self.verbose:
                self.magic_log.append(("libc", address, ret))
                if len(self.magic_log) > 500:
                    del self.magic_log[:250]
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
        if self.verbose:
            self.magic_log.append(("jni", address, ret))
            if len(self.magic_log) > 500:
                del self.magic_log[:250]
        uc.reg_write(UC_ARM_REG_R0, ret & 0xFFFFFFFF)
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def _call(self, func_offset: int, *args, arm: bool = False) -> int:
        uc = self.uc
        self._emu_error = None
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
        # thumb 函数地址带 LSB；BoringSSL 内核函数是 ARM 模式（LSB=0 即切 ARM）
        start = (self.base + func_offset) if arm else (self.base + func_offset) | 1
        try:
            uc.emu_start(start, sentinel, timeout=120_000_000, count=0)
        except Exception as e:
            if self._emu_error:
                raise EmuError(self._emu_error + f" | 调用: {func_offset:#x} | uc: {e}")
            raise
        if self._emu_error:
            raise EmuError(self._emu_error + " | 调用: " + hex(func_offset))
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
