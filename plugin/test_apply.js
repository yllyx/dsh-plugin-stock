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
const webServerRoutes = [];
const mockCtx = {
    tools: {
        register: (tool) => { registeredTools.push(tool); return tool; },
    },
    systemPrompt: {
        section: (s) => { promptSection = s; },
    },
    webServer: {
        register: (route) => { webServerRoutes.push(route); return () => {}; },
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
    get: (name) => ({
        agents: { create: async () => ({ agent: { session: {}, followup: () => {} } }) },
        sessionTitle: { rename: () => {} },
    })[name],
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

if (registeredTools.length !== 14) {
    console.error(`[FAIL] 期望 14 个工具（8 基础 + 6 开盘啦分析），实际 ${registeredTools.length}`);
    process.exit(1);
}

const kplTools = registeredTools.filter((t) => t.name.startsWith("kpl_"));
if (kplTools.length !== 6) {
    console.error(`[FAIL] 期望 6 个 kpl_* 工具，实际 ${kplTools.length}`);
    process.exit(1);
}
// 路由在 effect 内注册（effect mock 不执行 fn 以免误 spawn 后端），静态检查源码
const { readFileSync } = await import("node:fs");
const indexSrc = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
if (!indexSrc.includes('path: "/stock-plugin/analyze"')) {
    console.error("[FAIL] /stock-plugin/analyze 路由未注册");
    process.exit(1);
}
console.log("[OK] webServerRoutes 收集: " + webServerRoutes.length + "（effect 未执行属预期）");
console.log(`[OK] kpl_* 工具: ${kplTools.map((t) => t.name).join(", ")}`);

console.log("\n[PASS] 插件验证通过");
