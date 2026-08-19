/**
 * 一键发布到 npm + 准备插件市场提交
 *
 * 用法：
 *   node publish-and-submit.js                    # 只生成提交文件
 *   node publish-and-submit.js --publish          # 发布到 npm + 生成提交文件
 *   node publish-and-submit.js --owner=yourname   # 指定 GitHub 用户名
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SUBMIT_DIR = join(ROOT, "..", "catalog-submission");

const args = process.argv.slice(2);
const opts = { publish: false, owner: null };
for (const a of args) {
    if (a === "--publish") opts.publish = true;
    else if (a.startsWith("--owner=")) opts.owner = a.split("=")[1];
}

const c = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    bold: "\x1b[1m",
};
const log = {
    info: (m) => console.log(`${c.blue}ℹ${c.reset} ${m}`),
    success: (m) => console.log(`${c.green}✓${c.reset} ${m}`),
    warn: (m) => console.log(`${c.yellow}⚠${c.reset} ${m}`),
    title: (m) => console.log(`\n${c.bold}${c.cyan}${m}${c.reset}`),
};

log.title("📦 DSH 股票插件 - 一键发布");

// 1. 验证 package.json
log.title("\n[1/4] 验证 package.json");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
if (!pkg.dsh?.bundle?.patch) {
    log.warn("缺少 dsh.bundle.patch 字段（插件市场必需）");
    process.exit(1);
}
if (pkg.publishConfig?.access !== "public") {
    log.warn("缺少 publishConfig.access: 'public'");
    process.exit(1);
}
if (!existsSync(join(ROOT, pkg.dsh.bundle.patch))) {
    log.warn(`bundle patch 文件不存在: ${pkg.dsh.bundle.patch}`);
    process.exit(1);
}
log.success(`包名 ${pkg.name}@${pkg.version}`);
log.success(`bundle.patch = ${pkg.dsh.bundle.patch} ✓`);

// 2. 解析 owner
log.title("\n[2/4] 解析 GitHub 用户名");
let owner = opts.owner;
if (!owner) {
    const repoUrl = pkg.repository?.url || "";
    const match = repoUrl.match(/github\.com\/([^/]+)/);
    owner = match?.[1];
}
if (!owner || owner === "your-name") {
    log.warn("无法自动识别 GitHub 用户名");
    log.info("请用 --owner=your-github-username 参数指定");
    process.exit(1);
}
log.success(`GitHub 用户名: ${c.cyan}${owner}${c.reset}`);

// 3. 准备提交文件
log.title("\n[3/4] 准备插件市场提交文件");
mkdirSync(SUBMIT_DIR, { recursive: true });
const submitFile = join(SUBMIT_DIR, `${owner}--${pkg.name}.json`);

// 查找模板：优先 <owner>--<name>.json，回退到 your-name--<name>.json
let content;
const candidates = [
    join(SUBMIT_DIR, `${owner}--${pkg.name}.json`),
    join(SUBMIT_DIR, `your-name--${pkg.name}.json`),
];
const templatePath = candidates.find((p) => existsSync(p));
if (templatePath) {
    content = readFileSync(templatePath, "utf-8");
    content = content
        .replace(/your-name/g, owner)
        .replace(/<你的用户名>/g, owner)
        .replace(/YOUR-USERNAME/g, owner);
    writeFileSync(submitFile, content, "utf-8");
    log.success(`已生成: ${submitFile}`);
} else {
    log.warn(`找不到模板文件，请确保 catalog-submission/ 下有 your-name--${pkg.name}.json 或 ${owner}--${pkg.name}.json`);
    process.exit(1);
}

// 5. 可选发布
if (opts.publish) {
    log.title("\n[4/4] 发布到 npm");
    try {
        execSync("node publish.js --publish --yes", { stdio: "inherit" });
    } catch (e) {
        log.warn("发布失败，可手动重试: npm run publish:patch");
        process.exit(1);
    }
} else {
    log.title("\n[4/4] 跳过 npm 发布");
    log.info("实际发布: node publish-and-submit.js --publish");
}

// 最终输出
log.title("\n✨ 准备完成");
console.log(`
${c.cyan}接下来的步骤：${c.reset}

${c.bold}A. 推送到 GitHub${c.reset}
   cd ..
   git init && git add . && git commit -m "feat: DSH 股票监控插件"
   git remote add origin https://github.com/${owner}/${pkg.name}.git
   git push -u origin main
   git tag -a v${pkg.version} -m "v${pkg.version}"
   git push origin v${pkg.version}

${c.bold}B. 在 GitHub 添加 topic${c.reset}
   仓库 → About → Topics → 添加 ${c.cyan}dsh-plugin${c.reset}

${c.bold}C. 提交到插件市场${c.reset}
   1. Fork: https://github.com/imsai-sh/awesome-deepseek-harness-plugins
   2. 复制 ${c.green}${submitFile}${c.reset} 到 fork 的 catalog/plugins/
   3. git add + commit + push
   4. 创建 PR（标题：Add dsh-plugin-stock）

${c.bold}详细：${c.reset}
   ${c.cyan}../GO_LIVE.md${c.reset}
`);
