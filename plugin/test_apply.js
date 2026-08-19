/**
 * 插件加载测试
 *
 * 通过临时创建 node_modules/@deepseek-ai/dsh-tools 目录，模拟 DSH 环境
 * 注意：本测试只验证插件加载和工具注册，不会实际启动 Python 后端
 * （后端启动测试见 test_backend.js）
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const mockDir = "node_modules/@deepseek-ai/dsh-tools";
mkdirSync(mockDir, { recursive: true });
writeFileSync(
    join(mockDir, "package.json"),
    JSON.stringify({
        name: "@deepseek-ai/dsh-tools",
        main: "index.js",
        type: "module",
        exports: { ".": { default: "./index.js" } },
    }),
);
writeFileSync(join(mockDir, "index.js"), `export const defineTool = (opts) => Object.assign({ _isMockTool: true }, opts);\n`);

try {
    const mod = await import(new URL("./lib/index.js", import.meta.url).href);

    console.log("=== 插件加载测试 ===\n");
    console.log("Exports:", Object.keys(mod));

    const apply = mod.apply;
    if (typeof apply !== "function") {
        console.error("❌ apply 不是函数");
        process.exit(1);
    }

    const registeredTools = [];
    let promptSection = null;
    const effectDisposers = [];
    const mockCtx = {
        tools: {
            register: (tool) => { registeredTools.push(tool); return tool; },
        },
        systemPrompt: {
            section: (s) => { promptSection = s; },
        },
        logger: {
            info: (...a) => console.log("[plugin]", ...a),
            warn: (...a) => console.log("[plugin WARN]", ...a),
            error: (...a) => console.log("[plugin ERROR]", ...a),
            debug: () => {},
        },
        // 关键：不实际执行 effect 函数（避免启动后端）
        effect: (fn) => {
            effectDisposers.push(fn);
            return () => effectDisposers.splice(effectDisposers.indexOf(fn), 1);
        },
    };

    // apply 是 async，需要 await
    await mod.apply(mockCtx);

    console.log(`\n✓ apply() 成功执行`);
    console.log(`✓ 注册工具数: ${registeredTools.length}`);
    for (const t of registeredTools) {
        const valid = t.name && t.description && t.parameters && t.parameters.type === "object" && typeof t.execute === "function";
        const status = valid ? "✓" : "✗";
        console.log(`  ${status} ${t.name}: ${t.description.slice(0, 45)}...`);
    }
    console.log(`✓ system prompt section: ${promptSection?.name || "未注册"}`);
    console.log(`✓ effect 注册数: ${effectDisposers.length} (后端启动 + 清理)`);

    // 验证 backend-manager 模块可独立加载
    const bm = await import(new URL("./lib/backend-manager.js", import.meta.url).href);
    console.log(`✓ backend-manager.js exports: ${Object.keys(bm).join(", ")}`);
    const bmInstance = new bm.BackendManager({ port: 9999, backendDir: "./backend" });
    console.log(`✓ BackendManager 实例化: state=${bmInstance.state}, port=${bmInstance.port}`);

    if (registeredTools.length !== 4) {
        console.error(`❌ 期望 4 个工具，实际注册 ${registeredTools.length}`);
        process.exit(1);
    }
    if (effectDisposers.length < 2) {
        console.error(`❌ 期望注册 ≥2 个 effect（后端启动 + 清理），实际 ${effectDisposers.length}`);
        process.exit(1);
    }

    console.log("\n✅ 插件验证通过");
} finally {
    try { rmSync("node_modules", { recursive: true, force: true }); } catch {}
}
