/**
 * Backend Manager 单元测试 - 验证自动启动逻辑（不依赖 DSH）
 */

import { BackendManager } from "./lib/backend-manager.js";

async function main() {
    console.log("=== BackendManager 单元测试 ===\n");

    const mgr = new BackendManager({
        port: 8765,
        backendDir: "./backend",
        autoInstall: false,  // 跳过 pip install，依赖已装的
        logger: {
            info: (...a) => console.log("  [INFO]", ...a),
            warn: (...a) => console.log("  [WARN]", ...a),
            debug: () => {},
        },
    });

    mgr.onStateChange = (state, err) => {
        console.log(`  → 状态变化: ${state}${err ? ` (${err})` : ""}`);
    };

    console.log("1. 测试 findPython()...");
    const python = await mgr.findPython();
    console.log(`   ✓ Python 解释器: ${python || "未找到"}`);

    console.log("\n2. 测试 hasInstalledDeps()...");
    const installed = await mgr.hasInstalledDeps();
    console.log(`   ${installed ? "✓" : "✗"} 依赖状态: ${installed ? "已安装" : "缺失"}`);

    console.log("\n3. 测试 start()...");
    console.log("   启动中（这可能需要 5-15 秒）...");
    const start = Date.now();
    const ok = await mgr.start();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`   ${ok ? "✓" : "✗"} 启动结果: ${ok ? "成功" : "失败"} (${elapsed}s)`);

    if (!ok) {
        console.log(`   错误: ${mgr.lastError}`);
        process.exit(1);
    }

    console.log("\n4. 测试健康检查...");
    const r = await fetch(`${mgr.url}/health`);
    const data = await r.json();
    console.log(`   ✓ /health: ${JSON.stringify(data)}`);

    console.log("\n5. 测试 stop()...");
    await mgr.stop();
    console.log("   ✓ 进程已停止");

    console.log("\n✅ BackendManager 单元测试通过");

    // 清理残留
    if (process.platform === "win32") {
        const { execSync } = await import("node:child_process");
        try { execSync("taskkill /F /IM python.exe /FI \"WINDOWTITLE eq *uvicorn*\" 2>nul", { stdio: "ignore" }); } catch {}
        try { execSync("taskkill /F /IM python.exe 2>nul", { stdio: "ignore" }); } catch {}
    }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
