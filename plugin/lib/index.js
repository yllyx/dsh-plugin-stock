/**
 * DSH 股票监控插件 - Host 端入口
 *
 * 职责：
 * 1. 自动启动并管理 Python 后端进程（无需用户手动）
 * 2. 注册 AI 助手工具（让 AI 在对话中查询行情/持仓/K线/选股）
 * 3. 严格只读监控，不做自动交易
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { BackendManager, resolveBackendDir } from "./backend-manager.js";

const DEFAULT_PORT = Number(process.env.STOCK_BACKEND_PORT) || 8765;
const BACKEND_DIR = resolveBackendDir(import.meta.url);

// 全局后端管理器实例（单例）
let backend = null;

function getBackend() {
    if (backend) return backend;
    backend = new BackendManager({
        port: DEFAULT_PORT,
        backendDir: BACKEND_DIR,
        autoInstall: true,
    });
    return backend;
}

function makeToolRequest(path, options = {}) {
    const url = `${getBackend().url}${path}`;
    return fetch(url, options).then(async (resp) => {
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            return { error: err.detail || `HTTP ${resp.status}` };
        }
        return resp.json();
    }).catch((e) => ({ error: `后端未连接：${e.message}。请重启 DSH 或检查后端日志。` }));
}

function backendStatusError() {
    const b = getBackend();
    if (b.state === "running") return null;
    const detail = b.lastError || "正在启动...";
    return `后端不可用（${b.state}）：${detail}`;
}

// ============= 工具定义 =============

const stockQuoteTool = defineTool({
    name: "stock_quote",
    description: "获取 A 股实时行情。输入 6 位股票代码，返回当前价格、涨跌幅、成交量等。6 开头为沪市，0/3 开头为深市。",
    parameters: {
        type: "object",
        properties: {
            code: { type: "string", description: "股票代码，如 '600519'" },
        },
        required: ["code"],
    },
    output: {
        schema: { type: "object" },
        render(args, value) {
            if (!value || value.error) return `获取 ${args.code} 行情失败：${value?.error || "未知错误"}`;
            return [
                `【${value.name} (${value.code})】`,
                `当前：${value.price?.toFixed(2) ?? "N/A"}  涨跌：${value.change >= 0 ? "+" : ""}${value.change?.toFixed(2) ?? "N/A"} (${value.change_pct >= 0 ? "+" : ""}${value.change_pct?.toFixed(2) ?? "N/A"}%)`,
                `今开：${value.open?.toFixed(2) ?? "N/A"}  最高：${value.high?.toFixed(2) ?? "N/A"}  最低：${value.low?.toFixed(2) ?? "N/A"}  昨收：${value.last_close?.toFixed(2) ?? "N/A"}`,
                `成交量：${value.volume ? (value.volume / 10000).toFixed(0) + "万" : "N/A"}  成交额：${value.amount ? (value.amount / 100000000).toFixed(2) + "亿" : "N/A"}`,
            ].join("\n");
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        return await makeToolRequest(`/api/quote/${args.code}`);
    },
});

const stockKlineTool = defineTool({
    name: "stock_kline",
    description: "获取股票K线数据。可用于技术分析、计算均线、MACD 等指标。",
    parameters: {
        type: "object",
        properties: {
            code: { type: "string", description: "股票代码" },
            category: {
                type: "integer",
                description: "K线周期：9=日线, 5=周线, 6=月线, 0=5分, 1=15分, 2=30分, 3=60分",
                enum: [0, 1, 2, 3, 5, 6, 9],
                default: 9,
            },
            count: { type: "integer", description: "K线数量（建议 60-500）", minimum: 10, maximum: 1000, default: 120 },
        },
        required: ["code"],
    },
    output: {
        schema: { type: "object" },
        render(args, value) {
            if (!value || value.error) return `获取 ${args.code} K线失败：${value?.error || "未知错误"}`;
            const data = value.data || [];
            if (!data.length) return `未获取到 ${args.code} 的K线数据`;
            const last = data[data.length - 1];
            return [
                `【${value.code} K线 - 共 ${data.length} 条】`,
                `最新：${last.datetime}  收：${last.close?.toFixed(2)}`,
                `区间最高：${Math.max(...data.map((d) => d.high)).toFixed(2)}  最低：${Math.min(...data.map((d) => d.low)).toFixed(2)}`,
                `\n最近 5 条：`,
                ...data.slice(-5).reverse().map((d) => `  ${d.datetime} O:${d.open?.toFixed(2)} H:${d.high?.toFixed(2)} L:${d.low?.toFixed(2)} C:${d.close?.toFixed(2)} V:${((d.volume || 0) / 10000).toFixed(0)}万`),
            ].join("\n");
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        return await makeToolRequest(`/api/kline/${args.code}?category=${args.category || 9}&count=${args.count || 120}`);
    },
});

const stockScreenTool = defineTool({
    name: "stock_screen",
    description: "执行选股策略。可选类型：institutional(机构抱团股/趋势跟随) / breakout(启动股/捕捉主升浪起点) / trend(均线多头/经典趋势) / speculative(题材妖股/短线博弈)。",
    parameters: {
        type: "object",
        properties: {
            screen_type: {
                type: "string",
                description: "选股类型",
                enum: ["institutional", "breakout", "trend", "speculative"],
            },
            max_results: { type: "integer", description: "最大结果数", minimum: 1, maximum: 100, default: 20 },
        },
        required: ["screen_type"],
    },
    output: {
        schema: { type: "object" },
        render(args, value) {
            if (!value || value.error) return `选股失败：${value?.error || "未知错误"}`;
            const results = value.results || [];
            const name = { institutional: "机构抱团股", breakout: "启动股", trend: "均线多头", speculative: "题材妖股" }[args.screen_type] || args.screen_type;
            if (!results.length) return `【${name}选股】未找到符合条件的股票`;
            return [
                `【${name}选股】共 ${results.length} 只：`,
                ...results.map((r) => `  ${r.code} ${r.name} 现价：${r.price?.toFixed(2)} 涨跌：${r.change_pct >= 0 ? "+" : ""}${r.change_pct?.toFixed(2)}%`),
            ].join("\n");
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        return await makeToolRequest(`/api/screen`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ screen_type: args.screen_type, max_results: args.max_results || 20 }),
        });
    },
});

const stockHoldingsTool = defineTool({
    name: "stock_holdings",
    description: "管理持仓（仅记账和监控）。可以列出当前持仓、添加新持仓、删除持仓、查看总盈亏。注意：本工具不做任何自动交易。",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["list", "add", "remove"], description: "操作" },
            code: { type: "string", description: "股票代码（add/remove 时必填）" },
            name: { type: "string", description: "股票名称（add 时必填）" },
            buy_price: { type: "number", description: "买入价格（add 时必填）" },
            shares: { type: "integer", description: "持股数量（add 时必填）" },
            stop_loss_pct: { type: "number", description: "止损百分比（默认 -7）", default: -7 },
            take_profit_pct: { type: "number", description: "止盈百分比（默认 15）", default: 15 },
        },
        required: ["action"],
    },
    output: {
        schema: { type: "object" },
        render(args, value) {
            if (!value || value.error) return `操作失败：${value?.error || "未知错误"}`;
            if (args.action === "add") return value.status === "ok" ? `已添加 ${args.code} ${args.name}` : "添加失败";
            if (args.action === "remove") return value.status === "ok" ? `已删除 ${args.code}` : "删除失败";
            const holdings = value.holdings || [];
            if (!holdings.length) return "当前无持仓";
            const lines = [
                `【当前持仓】共 ${holdings.length} 只`,
                `总市值：${value.total_value?.toFixed(0) ?? "N/A"}  总盈亏：${value.total_profit?.toFixed(0) ?? "N/A"} (${value.total_profit_pct?.toFixed(2) ?? "N/A"}%)`,
                "",
            ];
            for (const h of holdings) {
                const sign = h.profit_pct >= 0 ? "+" : "";
                const flag = h.profit_pct <= h.stop_loss_pct ? "🛑止损" : h.profit_pct >= h.take_profit_pct ? "🎯止盈" : "•持有";
                lines.push(`${flag}  ${h.code} ${h.name} 成本：${h.buy_price?.toFixed(2)} 现价：${h.current_price?.toFixed(2)} ${h.shares}股  ${sign}${h.profit_pct?.toFixed(2)}% (${sign}${h.profit_amount?.toFixed(0)}元)`);
            }
            return lines.join("\n");
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        if (args.action === "list") return await makeToolRequest(`/api/holdings/refresh`, { method: "POST" });
        if (args.action === "add") {
            if (!args.code || !args.name || !args.buy_price || !args.shares) return { error: "需要 code/name/buy_price/shares" };
            return await makeToolRequest(`/api/holdings`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code: args.code, name: args.name,
                    buy_price: args.buy_price, shares: args.shares,
                    stop_loss_pct: args.stop_loss_pct ?? -7,
                    take_profit_pct: args.take_profit_pct ?? 15,
                }),
            });
        }
        if (args.action === "remove") {
            if (!args.code) return { error: "需要 code" };
            return await makeToolRequest(`/api/holdings/${args.code}`, { method: "DELETE" });
        }
        return { error: `未知操作：${args.action}` };
    },
});

// ============= 插件入口 =============

async function apply(ctx) {
    // 注册 4 个 AI 工具
    ctx.tools.register(stockQuoteTool);
    ctx.tools.register(stockKlineTool);
    ctx.tools.register(stockScreenTool);
    ctx.tools.register(stockHoldingsTool);

    ctx.systemPrompt?.section?.({
        name: "stock-plugin",
        order: 200,
        text: `
DSH 股票监控插件已激活。你拥有以下工具：
- stock_quote: 查询 A 股实时行情
- stock_kline: 查询K线数据（日/周/月/分钟）
- stock_screen: 执行选股（机构抱团/启动股/题材妖股/均线多头）
- stock_holdings: 查看/管理用户的持仓（监控用，不做自动交易）

用户当前偏好：监控持仓，手动交易。所有交易建议必须由用户自己确认执行，不要假设会自动下单。
`,
    });

    // 自动启动后端（后台进行，不阻塞插件加载）
    const b = getBackend();
    b.logger = {
        info: (...args) => ctx.logger?.info?.("[backend]", ...args),
        warn: (...args) => ctx.logger?.warn?.("[backend]", ...args),
        debug: (...args) => ctx.logger?.debug?.("[backend]", ...args),
    };
    b.onStateChange = (state, error) => {
        ctx.logger?.info?.(`[dsh-plugin-stock] 后端状态: ${state}${error ? ` - ${error}` : ""}`);
    };
    ctx.effect(() => b.start().catch((e) => {
        ctx.logger?.error?.(`[dsh-plugin-stock] 后端启动异常: ${e.message}`);
    }));

    // 卸载时关闭后端
    ctx.effect(() => () => b.stop());

    ctx.logger?.info?.("dsh-plugin-stock: 已注册 stock_quote / stock_kline / stock_screen / stock_holdings 工具");
}

export { apply };
