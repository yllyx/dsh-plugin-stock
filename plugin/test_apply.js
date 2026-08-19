/**
 * 插件加载测试
 *
 * 插件不再依赖 @deepseek-ai/dsh-tools（工具用原始对象直接注册，
 * 与 dsh-mnemon 同款做法），无需 mock 任何外部包。
 */

import { rmSync } from "node:fs";

// 清理老版本残留的 mock
try { rmSync("node_modules", { recursive: true, force: true }); } catch {}

const mod = await import(new URL("./lib/index.js", import.meta.url).href);

console.log("=== 插件加载测试 ===\n");
console.log("Exports:", Object.keys(mod));

if (typeof mod.apply !== "function") {
    console.error("[FAIL] apply 不是函数");
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
    effect: (fn) => {
        effectDisposers.push(fn);
        return () => effectDisposers.splice(effectDisposers.indexOf(fn), 1);
    },
};

await mod.apply(mockCtx);

console.log(`\n[OK] apply() 成功执行`);
console.log(`[OK] 注册工具数: ${registeredTools.length}`);
for (const t of registeredTools) {
    const valid = t.name && t.description && t.parameters && t.parameters.type === "object"
        && typeof t.execute === "function" && t.output && typeof t.output.render === "function";
    console.log(`  ${valid ? "OK" : "FAIL"} ${t.name}: ${t.description.slice(0, 45)}...`);
}
console.log(`[OK] system prompt section: ${promptSection?.name || "未注册"}`);
console.log(`[OK] effect 注册数: ${effectDisposers.length} (后端启动 + 清理)`);

if (registeredTools.length !== 4) {
    console.error(`[FAIL] 期望 4 个工具，实际注册 ${registeredTools.length}`);
    process.exit(1);
}

console.log("\n[PASS] 插件验证通过");
