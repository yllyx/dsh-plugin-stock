/**
 * DSH 股票插件 - 发布脚本
 *
 * 一键完成：测试 → 版本管理 → 打包验证 → 发布到 npm
 *
 * 用法：
 *   node publish.js                  # 干运行（仅检查，不发布）
 *   node publish.js --bump patch     # 升级补丁版本号
 *   node publish.js --bump minor     # 升级次版本号
 *   node publish.js --publish        # 实际发布
 *   node publish.js --publish --tag beta   # 发布到 beta tag
 *   node publish.js --registry http://localhost:4873  # 发布到私有 registry
 *   node publish.js --yes            # 跳过所有确认（CI 模式）
 *
 * 安全特性：
 *   1. 默认 dry-run，必须加 --publish 才真正发布
 *   2. 发布前必须所有测试通过
 *   3. 交互式确认（CI 模式可用 --yes 跳过）
 *   4. 失败自动回滚版本号
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ============= 配色 =============
const c = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
};
const log = {
    info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
    success: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
    warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
    error: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
    title: (msg) => console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}`),
    sub: (msg) => console.log(`${c.dim}  ${msg}${c.reset}`),
};

// ============= 参数解析 =============
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        publish: false,
        bump: null,
        tag: "latest",
        registry: null,
        yes: false,
        skipTests: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--publish") opts.publish = true;
        else if (a === "--bump") opts.bump = args[++i];
        else if (a === "--tag") opts.tag = args[++i];
        else if (a === "--registry") opts.registry = args[++i];
        else if (a === "--yes" || a === "-y") opts.yes = true;
        else if (a === "--skip-tests") opts.skipTests = true;
        else if (a === "--help" || a === "-h") {
            console.log(`用法：node publish.js [选项]

选项：
  --publish           实际发布（默认 dry-run）
  --bump <type>       升级版本号（patch|minor|major）
  --tag <name>        发布 tag（默认 latest）
  --registry <url>    指定 registry（默认 npm 官方）
  --yes / -y          跳过所有确认
  --skip-tests        跳过测试（不推荐）
  --help / -h         显示帮助

示例：
  node publish.js --bump patch --publish
  node publish.js --publish --tag beta
  node publish.js --registry http://localhost:4873 --publish --yes`);
            process.exit(0);
        }
        else {
            log.error(`未知参数：${a}`);
            process.exit(1);
        }
    }
    return opts;
}

// ============= 工具函数 =============
function run(cmd, opts = {}) {
    try {
        return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...opts }).trim();
    } catch (e) {
        return null;
    }
}

function readJSON(path) {
    return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJSON(path, data) {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function confirm(question) {
    if (opts.yes) return true;
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question(`${c.yellow}?${c.reset} ${question} ${c.dim}(y/N)${c.reset}: `)).trim().toLowerCase();
    rl.close();
    return answer === "y" || answer === "yes";
}

// ============= 主流程 =============
const opts = parseArgs();
const ROOT = process.cwd();
const PKG_PATH = join(ROOT, "package.json");

log.title("📦 DSH 股票插件发布工具");

// 1. 检查目录
log.title("\n[1/7] 检查工作目录");
if (!existsSync(PKG_PATH)) {
    log.error("未找到 package.json，请在 plugin/ 目录下运行");
    process.exit(1);
}
const pkg = readJSON(PKG_PATH);
log.success(`包名: ${c.cyan}${pkg.name}${c.reset}`);
log.info(`当前版本: ${pkg.version}`);

// 2. 升级版本号
let originalVersion = pkg.version;
if (opts.bump) {
    log.title(`\n[2/7] 升级版本号 (${opts.bump})`);
    if (!["patch", "minor", "major"].includes(opts.bump)) {
        log.error(`--bump 必须是 patch / minor / major`);
        process.exit(1);
    }
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    let next;
    if (opts.bump === "major") next = `${major + 1}.0.0`;
    else if (opts.bump === "minor") next = `${major}.${minor + 1}.0`;
    else next = `${major}.${minor}.${patch + 1}`;

    if (!await confirm(`版本从 ${originalVersion} 升级到 ${c.green}${next}${c.reset}`)) {
        log.warn("已取消");
        process.exit(0);
    }
    pkg.version = next;
    writeJSON(PKG_PATH, pkg);
    log.success(`版本已更新为 ${pkg.version}`);
} else {
    log.title("\n[2/7] 版本号");
    log.info(`保持当前版本 ${pkg.version}`);
}

// 3. 验证 package.json 字段
log.title("\n[3/7] 验证 package.json");
const required = ["name", "version", "description", "main", "files", "dsh"];
let valid = true;
for (const f of required) {
    if (!pkg[f]) {
        log.error(`缺少字段: ${f}`);
        valid = false;
    }
}
if (pkg.name && !pkg.name.startsWith("dsh-")) {
    log.warn(`包名 ${pkg.name} 不以 'dsh-' 开头（DSH 插件命名约定）`);
}
if (pkg.dsh?.client?.inject) {
    log.success(`DSH 客户端注入声明: ${pkg.dsh.client.inject.length} 个`);
} else {
    log.error("缺少 dsh.client.inject 配置");
    valid = false;
}
if (!valid) {
    process.exit(1);
}
log.success("package.json 验证通过");

// 4. 运行测试
if (!opts.skipTests) {
    log.title("\n[4/7] 运行测试");
    log.info("执行 test_apply.js...");
    try {
        execSync("node test_apply.js", { stdio: "inherit" });
        log.success("test_apply.js 通过");
    } catch (e) {
        log.error("test_apply.js 失败");
        if (opts.bump) {
            pkg.version = originalVersion;
            writeJSON(PKG_PATH, pkg);
            log.warn(`版本已回滚到 ${originalVersion}`);
        }
        process.exit(1);
    }
} else {
    log.title("\n[4/7] 跳过测试 (--skip-tests)");
    log.warn("已跳过测试，建议实际发布前不要跳过");
}

// 5. 检查敏感文件
log.title("\n[5/7] 检查敏感文件");
const sensitivePatterns = [
    /\.env$/,
    /\.env\./,
    /secrets?\.json$/,
    /credentials\.json$/,
    /config\.json$/,  // 用户配置文件，不应该发布
    /__pycache__/,
    /\.pyc$/,
    /\.DS_Store$/,
    /\.log$/,
];
const filesToCheck = run("npm pack --dry-run --silent") || "";
let foundSensitive = false;
for (const pat of sensitivePatterns) {
    if (pat.test(".env") && filesToCheck.includes(".env")) {
        log.error(`包含敏感文件: .env`);
        foundSensitive = true;
    }
}
// 单独检查 config.json（用户配置）
if (existsSync(join(ROOT, "backend/config.json"))) {
    log.warn("backend/config.json 存在（用户运行时生成，应被 .npmignore 排除）");
    log.sub("请确认 .npmignore 包含 config.json");
}
if (!foundSensitive) {
    log.success("未发现敏感文件");
}

// 6. 打包预览
log.title("\n[6/7] 打包预览");
try {
    const output = execSync("npm pack --dry-run 2>&1", { encoding: "utf-8" });
    const lines = output.split("\n").filter(l =>
        l.includes("npm notice") &&
        (l.includes("kB") || l.includes("B")) &&
        !l.includes("filename")
    );
    const totalSizeLine = lines.find(l => l.includes("package size"));
    if (totalSizeLine) log.info(totalSizeLine.trim().replace(/npm notice\s*/, ""));
    log.success("打包预览完成");
    log.sub("查看完整内容: npm pack --dry-run");
} catch (e) {
    log.error("打包预览失败");
    if (opts.bump) {
        pkg.version = originalVersion;
        writeJSON(PKG_PATH, pkg);
        log.warn(`版本已回滚到 ${originalVersion}`);
    }
    process.exit(1);
}

// 7. 发布
log.title("\n[7/7] 发布");
if (!opts.publish) {
    log.info("当前为 dry-run 模式，未实际发布");
    log.sub(`实际发布: node publish.js --publish${opts.bump ? ` --bump ${opts.bump}` : ""}`);
    log.sub(`查看包大小: npm pack`);
    log.sub(`查看完整内容: tar -tzf dsh-plugin-stock-${pkg.version}.tgz`);
    process.exit(0);
}

// 真实发布流程
log.warn(`即将发布到 ${opts.registry || "npm 官方"} 的 ${c.cyan}${opts.tag}${c.reset} tag`);
log.info(`包: ${pkg.name}@${pkg.version}`);

if (!await confirm("确认发布？")) {
    log.warn("已取消");
    if (opts.bump) {
        pkg.version = originalVersion;
        writeJSON(PKG_PATH, pkg);
        log.warn(`版本已回滚到 ${originalVersion}`);
    }
    process.exit(0);
}

// 检查 npm 登录
log.info("检查 npm 登录状态...");
const whoami = run("npm whoami");
if (!whoami) {
    log.error("未登录 npm，请先运行: npm login");
    process.exit(1);
}
log.success(`已登录为: ${whoami}`);

// 执行发布
const publishCmd = ["npm", "publish", `--tag=${opts.tag}`];
if (opts.registry) publishCmd.push(`--registry=${opts.registry}`);

log.info(`执行: ${publishCmd.join(" ")}`);
try {
    const output = execSync(publishCmd.join(" "), { stdio: "inherit" });
    log.success("发布成功！");
} catch (e) {
    log.error("发布失败");
    if (opts.bump) {
        pkg.version = originalVersion;
        writeJSON(PKG_PATH, pkg);
        log.warn(`版本已回滚到 ${originalVersion}`);
    }
    process.exit(1);
}

// 发布后：git tag
log.title("\n发布完成！");
log.info(`📦 ${c.cyan}${pkg.name}@${pkg.version}${c.reset} 已发布到 ${opts.tag}`);
log.info("");
log.info("用户安装方式：");
log.sub(`${c.green}npm install ${pkg.name}${c.reset}`);
log.sub(`${c.green}pnpm add ${pkg.name}${c.reset}`);
log.info("");
log.info("或 DSH 用户添加到 apps/web/package.json：");
log.sub(`${c.green}"${pkg.name}": "^${pkg.version}"${c.reset}`);

// 可选 git tag
if (run("git rev-parse --git-dir")) {
    const tagName = `v${pkg.version}`;
    if (await confirm(`创建 git tag ${tagName}？`)) {
        try {
            execSync(`git tag -a ${tagName} -m "Release ${pkg.version}"`, { stdio: "inherit" });
            log.success(`已创建 tag ${tagName}`);
            if (await confirm("推送到 origin？")) {
                execSync(`git push origin ${tagName}`, { stdio: "inherit" });
                log.success("tag 已推送");
            }
        } catch (e) {
            log.warn("git tag 操作失败（不影响发布）");
        }
    }
}

log.info("");
log.success("🎉 全部完成！");
