/**
 * 后端进程管理器
 *
 * 负责：
 * 1. 自动查找 Python 解释器
 * 2. 检测并安装依赖（首次运行）
 * 3. 启动 uvicorn 后端
 * 4. 健康检查 / 自动重启
 * 5. 进程生命周期管理
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 8765;
// 首次运行含 pip install 依赖 + K线库冷载入，给足余量；/health 已非阻塞（status() 无锁）
const HEALTH_TIMEOUT_MS = 30000;
const HEALTH_POLL_MS = 500;

class BackendManager {
    constructor(options = {}) {
        this.port = options.port || DEFAULT_PORT;
        this.backendDir = options.backendDir;
        this.logger = options.logger || console;
        this.pythonCmd = null;
        this.process = null;
        this.state = "stopped"; // stopped | starting | running | failed
        this.lastError = null;
        this.autoInstall = options.autoInstall !== false;
        this.onStateChange = options.onStateChange || (() => {});
    }

    setState(state, error = null) {
        this.state = state;
        this.lastError = error;
        this.onStateChange(state, error);
        const msg = error ? ` - ${error}` : "";
        if (this.logger?.info) this.logger.info(`[dsh-plugin-stock:backend] ${state}${msg}`);
    }

    async findPython() {
        if (this.pythonCmd) return this.pythonCmd;
        const candidates = process.platform === "win32"
            ? ["python", "python3", "py"]
            : ["python3", "python"];
        for (const cmd of candidates) {
            try {
                const version = await this.runCmd(cmd, ["--version"]);
                if (version && /Python 3\.(1[0-9]|[2-9]\d)/.test(version)) {
                    this.pythonCmd = cmd;
                    if (this.logger?.info) this.logger.info(`[dsh-plugin-stock:backend] 使用 Python: ${cmd} (${version.trim()})`);
                    return cmd;
                }
            } catch { /* try next */ }
        }
        return null;
    }

    async hasInstalledDeps() {
        try {
            const out = await this.runCmd(this.pythonCmd, ["-c", "import fastapi, uvicorn, pytdx"], { cwd: this.backendDir });
            return out !== null;
        } catch {
            return false;
        }
    }

    async installDeps() {
        if (this.logger?.info) this.logger.info(`[dsh-plugin-stock:backend] 首次运行，安装依赖中...`);
        return await this.runCmd(
            this.pythonCmd,
            ["-m", "pip", "install", "-r", "requirements.txt", "--disable-pip-version-check"],
            { cwd: this.backendDir, timeout: 180000 },
        );
    }

    async isAlreadyRunning() {
        try {
            const resp = await fetch(`http://127.0.0.1:${this.port}/health`);
            return resp.ok;
        } catch {
            return false;
        }
    }

    async start() {
        if (this.state === "running" || this.state === "starting") return this.state === "running";
        this.setState("starting");

        if (!existsSync(this.backendDir)) {
            this.setState("failed", `后端目录不存在: ${this.backendDir}。插件包可能损坏。`);
            return false;
        }

        if (await this.isAlreadyRunning()) {
            if (this.logger?.info) this.logger.info(`[dsh-plugin-stock:backend] 端口 ${this.port} 已被占用，直接复用`);
            this.setState("running");
            return true;
        }

        this.pythonCmd = await this.findPython();
        if (!this.pythonCmd) {
            this.setState("failed", `未找到 Python 3.10+。请安装 Python 并确保在 PATH 中。`);
            return false;
        }

        if (this.autoInstall && !(await this.hasInstalledDeps())) {
            const ok = await this.installDeps();
            if (!ok) {
                this.setState("failed", `依赖安装失败。请手动: cd ${this.backendDir} && pip install -r requirements.txt`);
                return false;
            }
        }

        try {
            this.process = spawn(
                this.pythonCmd,
                ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(this.port), "--log-level", "warning"],
                {
                    cwd: this.backendDir,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                    env: { ...process.env, PYTHONUNBUFFERED: "1" },
                },
            );

            this.process.stdout?.on("data", (d) => {
                if (this.logger?.debug) this.logger.debug(`[backend] ${d.toString().trim()}`);
            });
            this.process.stderr?.on("data", (d) => {
                const msg = d.toString().trim();
                if (msg && this.logger?.warn) this.logger.warn(`[backend] ${msg}`);
            });

            this.process.on("exit", (code, signal) => {
                if (this.state !== "stopped") {
                    this.setState("failed", `进程退出 code=${code} signal=${signal}`);
                }
            });

            const start = Date.now();
            while (Date.now() - start < HEALTH_TIMEOUT_MS) {
                if (await this.isAlreadyRunning()) {
                    this.setState("running");
                    return true;
                }
                await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
            }

            this.setState("failed", "健康检查超时。后端可能启动失败。");
            this.process?.kill("SIGTERM");
            return false;
        } catch (e) {
            this.setState("failed", `启动失败: ${e.message}`);
            return false;
        }
    }

    async stop() {
        if (!this.process) return;
        this.setState("stopped");
        try {
            this.process.kill("SIGTERM");
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    this.process?.kill("SIGKILL");
                    resolve();
                }, 3000);
                this.process?.on("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        } catch (e) {
            if (this.logger?.warn) this.logger.warn(`[backend] 停止失败: ${e.message}`);
        }
        this.process = null;
    }

    runCmd(cmd, args, options = {}) {
        return new Promise((resolve) => {
            try {
                const proc = spawn(cmd, args, {
                    cwd: options.cwd,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                });
                let stdout = "";
                proc.stdout?.on("data", (d) => { stdout += d.toString(); });
                proc.on("error", () => resolve(null));
                proc.on("close", (code) => resolve(code === 0 ? stdout : null));
                if (options.timeout) {
                    setTimeout(() => { proc.kill(); resolve(null); }, options.timeout);
                }
            } catch {
                resolve(null);
            }
        });
    }

    get url() {
        return `http://127.0.0.1:${this.port}`;
    }
}

/** 解析后端目录（相对于当前文件） */
export function resolveBackendDir(importMetaUrl) {
    const here = dirname(fileURLToPath(importMetaUrl));
    return resolve(here, "..", "backend");
}

export { BackendManager };
