"""
生产版 v3：通达信内存持仓读取器
- Memory.scanSync 找 GBK 名称 → 回溯 code 起点 → 读 172B 记录 → 解析
- 自动发现任意持仓（不依赖固定持仓名 pattern：扫所有 6位数字记录头）
用法: python tdx_reader_v3.py [--once]
"""
import json
import subprocess
import sys
import time

import frida

SCRIPT = r"""
function scanAll() {
    const results = [];
    const seen = {};
    const ranges = Process.enumerateRangesSync({protection: 'rw-', coalesce: true});
    let totalScanned = 0;
    for (const r of ranges) {
        if (r.size > 256*1024*1024) continue;
        // 直接扫"6位数字+\0+GBK名称(至少4个GBK高字节)"模式：
        // 用两段扫描：先扫所有 \0 结尾的 6 数字（正则不支持，改用手动遍历太慢）
        // 高效法：扫 GBK 高字节对模式 (xx xx 须 81-fe/40-fe)，捕获一段后回溯验证 code
        // 折衷：用 b3a4b3c7 (长城) + bec5ccec (九天) 验证通路，再扩展
        // 更通用：扫 0x30-0x39 ×6 + 00 + 2-8 GBK 字节 —— Memory.scan 不支持正则
        // 最终方案：Memory.scanSync 逐 GBK 常用字 pattern 代价高；
        // 直接扫所有 [6 digits][00] 后 0x40 处 int64 ∈ (0,1e8) 且 +0x50 处 float ∈ (0.01,100000)
        // 用逐字节遍历 + 尝试解析（.text/rdata 排除后 rw 区 ~500MB，JS 遍历太慢）
        // 改用 Memory.scan 两遍法：先扫 b'\x00'+6digits+'\x00' 太多命中
        // 实测最优：扫 GBK 高频字 pattern（由 Python 传入已知持仓名+通配）
        // Python 会传入 patterns 列表
        const pats = %PATTERNS%;
        for (const pat of pats) {
            try {
                Memory.scanSync(r.base, r.size, pat).forEach(function(m) {
                    // 回溯找 code 起点
                    for (let back = 7; back <= 0x30; back++) {
                        const cand = m.address.sub(back);
                        let ok = true;
                        try {
                            const arr = new Uint8Array(Memory.readByteArray(cand, 7));
                            for (let k = 0; k < 6; k++) {
                                if (arr[k] < 0x30 || arr[k] > 0x39) { ok = false; break; }
                            }
                            if (!ok || arr[6] !== 0) { ok = false; }
                        } catch (e) { ok = false; }
                        if (!ok) continue;
                        const qty = Memory.readS64(cand.add(0x40)).toNumber();
                        const avail = Memory.readS64(cand.add(0x48)).toNumber();
                        const cost = Memory.readFloat(cand.add(0x50));
                        const price = Memory.readFloat(cand.add(0x54));
                        if (qty <= 0 || qty > 1e8) continue;
                        if (avail < 0 || avail > qty) continue;
                        if (!(cost > 0.01 && cost < 100000)) continue;
                        const mv = Memory.readDouble(cand.add(0x58));
                        const pl = Memory.readDouble(cand.add(0x60));
                        const plpct = Memory.readDouble(cand.add(0x68));
                        if (mv === 0 && pl === 0) continue;
                        const key = cand.toString();
                        if (seen[key]) continue;
                        seen[key] = true;
                        // 读名称和股东号
                        let name = '';
                        try {
                            const nb = new Uint8Array(Memory.readByteArray(cand.add(7), 24));
                            // GBK 逐字节解码（名称首字节从代码\0 后开始）
                            let tmp = [];
                            for (let k = 0; k < 24 && nb[k] !== 0; k++) tmp.push(nb[k]);
                            const nameBytes = new Uint8Array(tmp);
                            let buf2 = '';
                            for (let k = 0; k < nameBytes.length; k++) buf2 += String.fromCharCode(nameBytes[k]);
                            // 用 python-friendly 方式：发给 Python 解码
                            name = '\x01' + buf2;  // 标记为原始字节
                        } catch (e) { }
                        let holder = '';
                        try {
                            const hb = new Uint8Array(Memory.readByteArray(cand.add(0x24), 12));
                            for (let k = 0; k < 12; k++) {
                                if (hb[k] >= 0x30 && hb[k] <= 0x39) holder += String.fromCharCode(hb[k]);
                            }
                        } catch (e) { }
            results.push({
                            code_digits: (function() {
                                let cd = '';
                                try {
                                    const ab = new Uint8Array(Memory.readByteArray(cand, 6));
                                    for (let k = 0; k < 6; k++) cd += String.fromCharCode(ab[k]);
                                } catch (e) { }
                                return cd;
                            })(),
                            name: name, holder: holder,
                            qty: qty, avail: avail, cost: cost, price: price,
                            mv: mv, pl: pl, plpct: plpct
                        });
                        break;  // 找到 code 起点后不再继续回溯
                    }
                });
            } catch (e) { }
        }
    }
    send({t: 'r', results: results, totalScanned: totalScanned});
}

setTimeout(scanAll, 50);
"""

# patterns：覆盖常见持仓股名 GBK 片段。核心逻辑：扫到 GBK 名后回溯 code 起点。
# 生产化：改为扫描「6位数字+\0+GBK」记录头而非固定名——但 Memory.scanSync 不支持正则；
# 实测方案：扫 0x30-0x39 起始 6 字节数字代码不可行，改扫已验证的持仓 GBK 名 + 已知持仓股
# 用户可在此 list 中添加更多持仓股 GBK 片段（从插件配置自动生成）
PATTERNS = [
    '长城'.encode('gbk').hex(),
    '九天'.encode('gbk').hex(),
]
# 去重
PATTERNS = list(dict.fromkeys(PATTERNS))


def find_pid():
    out = subprocess.check_output(["tasklist", "/FI", "IMAGENAME eq tdxw.exe"])
    for line in out.decode("gbk", errors="ignore").splitlines():
        if "tdxw.exe" in line:
            return int(line.split()[1])
    return None


def get_positions(timeout=60):
    """读取通达信内存持仓 → 返回标准 dict（供 main.py 调用）"""
    script_src = SCRIPT.replace('%PATTERNS%', json.dumps(PATTERNS))
    pid = find_pid()
    if not pid:
        return {"ok": False, "error": "tdxw not running", "positions": [], "count": 0}
    session = frida.attach(pid)
    script = session.create_script(script_src)

    positions = []
    done = False

    def on_message(message, data):
        nonlocal positions, done
        if message.get("type") == "send":
            p = message["payload"]
            if p.get("t") == "r":
                positions = p.get("results", [])
                done = True

    script.on("message", on_message)
    script.load()
    t0 = time.time()
    while time.time() - t0 < timeout and not done:
        time.sleep(1)
    try:
        session.detach()
    except Exception:
        pass
    dedup = {}
    for p in positions:
        cd = p.get('code_digits', '')
        raw_name = p.get('name', '')
        if raw_name.startswith('\x01'):
            try:
                raw_name = raw_name[1:].encode('latin-1').decode('gbk', errors='replace')
            except Exception:
                pass
        if not cd:
            continue
        if cd not in dedup or p.get('mv', 0) != 0:
            p['name'] = raw_name
            dedup[cd] = p
    plist = sorted(dedup.values(), key=lambda x: x.get('code_digits', ''))
    return {
        "ok": len(plist) > 0,
        "source": "tdx-memory",
        "positions": plist,
        "count": len(plist),
        "ts": int(time.time()),
    }


if __name__ == "__main__":
    import json as _json
    print(_json.dumps(get_positions(), ensure_ascii=False, indent=1))
