/**
 * DSH 股票监控插件 - Host 端入口
 *
 * 职责：
 * 1. 自动启动并管理 Python 后端进程（无需用户手动）
 * 2. 注册 AI 助手工具（stock_quote / stock_kline / stock_screen / stock_holdings）
 * 3. 严格只读监控，不做自动交易
 *
 * 注意：这里不用 @deepseek-ai/dsh-tools 的 defineTool()。
 * defineTool 的 parameters 走 property-map DSL（会拒绝标准 JSON Schema），
 * 而 ctx.tools.register() 直接接受完整 JSON Schema（dsh-mnemon 等插件同款做法），
 * 且 register 只校验 output.schema（assertSupportedJsonSchema），不校验 parameters。
 */

import { BackendManager, resolveBackendDir } from "./backend-manager.js";

const DEFAULT_PORT = Number(process.env.STOCK_BACKEND_PORT) || 8765;
const BACKEND_DIR = resolveBackendDir(import.meta.url);

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

// 宽松 output schema：与 dsh-mnemon 的 JSON_OBJECT_OUTPUT 同款
const JSON_OBJECT_OUTPUT = { type: "object", additionalProperties: true };

// ============= 工具定义（原始对象，完整 JSON Schema parameters）=============

const stockQuoteTool = {
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
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) {
                return [{ type: "text", text: `获取 ${args.code} 行情失败：${value?.error || "未知错误"}` }];
            }
            return [
                { type: "text", text: `【${value.name} (${value.code})】` },
                { type: "text", text: `当前：${value.price?.toFixed(2) ?? "N/A"}  涨跌：${value.change >= 0 ? "+" : ""}${value.change?.toFixed(2) ?? "N/A"} (${value.change_pct >= 0 ? "+" : ""}${value.change_pct?.toFixed(2) ?? "N/A"}%)` },
                { type: "text", text: `今开：${value.open?.toFixed(2) ?? "N/A"}  最高：${value.high?.toFixed(2) ?? "N/A"}  最低：${value.low?.toFixed(2) ?? "N/A"}  昨收：${value.last_close?.toFixed(2) ?? "N/A"}` },
                { type: "text", text: `成交量：${value.volume ? (value.volume / 10000).toFixed(0) + "万" : "N/A"}  成交额：${value.amount ? (value.amount / 100000000).toFixed(2) + "亿" : "N/A"}` },
            ];
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        if (!args.code) return { error: "缺少 code 参数" };
        return await makeToolRequest(`/api/quote/${args.code}`);
    },
};

const stockKlineTool = {
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
            count: { type: "integer", description: "K线数量（建议 60-500）", default: 120 },
        },
        required: ["code"],
    },
    output: {
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) {
                return [{ type: "text", text: `获取 ${args.code} K线失败：${value?.error || "未知错误"}` }];
            }
            const data = value.data || [];
            if (!data.length) return [{ type: "text", text: `未获取到 ${args.code} 的K线数据` }];
            const last = data[data.length - 1];
            return [
                { type: "text", text: `【${value.code} K线 - 共 ${data.length} 条】` },
                { type: "text", text: `最新：${last.datetime}  收：${last.close?.toFixed(2)}` },
                { type: "text", text: `区间最高：${Math.max(...data.map((d) => d.high)).toFixed(2)}  最低：${Math.min(...data.map((d) => d.low)).toFixed(2)}` },
                { type: "text", text: `\n最近 5 条：` },
                ...data.slice(-5).reverse().map((d) => ({
                    type: "text",
                    text: `  ${d.datetime} O:${d.open?.toFixed(2)} H:${d.high?.toFixed(2)} L:${d.low?.toFixed(2)} C:${d.close?.toFixed(2)} V:${((d.volume || 0) / 10000).toFixed(0)}万`,
                })),
            ];
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        if (!args.code) return { error: "缺少 code 参数" };
        return await makeToolRequest(`/api/kline/${args.code}?category=${args.category || 9}&count=${args.count || 120}`);
    },
};

const stockScreenTool = {
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
            max_results: { type: "integer", description: "最大结果数", default: 20 },
        },
        required: ["screen_type"],
    },
    output: {
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) return [{ type: "text", text: `选股失败：${value?.error || "未知错误"}` }];
            const results = value.results || [];
            const name = { institutional: "机构抱团股", breakout: "启动股", trend: "均线多头", speculative: "题材妖股" }[args.screen_type] || args.screen_type;
            if (!results.length) return [{ type: "text", text: `【${name}选股】未找到符合条件的股票` }];
            const lines = [
                { type: "text", text: `【${name}选股】共 ${results.length} 只：${value.pool_mode === "market" ? "（全市场）" : ""}` },
                ...results.map((r) => ({
                    type: "text",
                    text: `  ${r.code} ${r.name} 现价：${r.price?.toFixed(2)} 涨跌：${r.change_pct >= 0 ? "+" : ""}${r.change_pct?.toFixed(2)}%${r.reason ? "  理由：" + r.reason : ""}`,
                })),
            ];
            return lines;
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        if (!args.screen_type) return { error: "缺少 screen_type 参数" };
        return await makeToolRequest(`/api/screen`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ screen_type: args.screen_type, max_results: args.max_results || 20 }),
        });
    },
};

const stockHoldingsTool = {
    name: "stock_holdings",
    description: "管理持仓（仅记账和监控，不做自动交易）。支持：list 列出持仓与总盈亏 / add 添加 / remove 删除。止盈止损模式 stop_mode：fixed=固定百分比（默认），trailing=移动止损（盈利>5%后保本，从高点回撤超 trail_drawdown_pct% 触发），ladder=阶梯止盈（+20%提示卖1/3，+50%再卖1/3，剩余移动止损）。另会自动执行时间止损提醒（买入超5个交易日无涨幅）。",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["list", "add", "remove"], description: "操作" },
            code: { type: "string", description: "股票代码（add/remove 时必填）" },
            name: { type: "string", description: "股票名称（add 时必填）" },
            buy_price: { type: "number", description: "买入价格（add 时必填）" },
            shares: { type: "integer", description: "持股数量（add 时必填）" },
            stop_loss_pct: { type: "number", description: "止损百分比（默认 -7）", default: -7 },
            take_profit_pct: { type: "number", description: "止盈百分比（默认 15，仅 fixed 模式生效）", default: 15 },
            stop_mode: { type: "string", enum: ["fixed", "trailing", "ladder"], description: "止盈止损模式（默认 fixed）" },
            trail_drawdown_pct: { type: "number", description: "移动止损的高点回撤阈值%（默认 10）", default: 10 },
        },
        required: ["action"],
    },
    output: {
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) return [{ type: "text", text: `操作失败：${value?.error || "未知错误"}` }];
            if (args.action === "add") return [{ type: "text", text: value.status === "ok" ? `已添加 ${args.code} ${args.name}（${args.stop_mode || "fixed"} 模式）` : "添加失败" }];
            if (args.action === "remove") return [{ type: "text", text: value.status === "ok" ? `已删除 ${args.code}` : "删除失败" }];
            const holdings = value.holdings || [];
            if (!holdings.length) return [{ type: "text", text: "当前无持仓" }];
            const MODE = { fixed: "固定", trailing: "移动", ladder: "阶梯" };
            const lines = [
                { type: "text", text: `【当前持仓】共 ${holdings.length} 只` },
                { type: "text", text: `总市值：${value.total_value?.toFixed(0) ?? "N/A"}  总盈亏：${value.total_profit?.toFixed(0) ?? "N/A"} (${value.total_profit_pct?.toFixed(2) ?? "N/A"}%)` },
                { type: "text", text: "" },
                ...holdings.map((h) => ({
                    type: "text",
                    text: `${h.profit_pct <= h.stop_loss_pct ? "🛑止损" : h.profit_pct >= h.take_profit_pct ? "🎯止盈" : "•持有"}  ${h.code} ${h.name} 成本：${h.buy_price?.toFixed(2)} 现价：${h.current_price?.toFixed(2)} ${h.shares}股  ${h.profit_pct >= 0 ? "+" : ""}${h.profit_pct?.toFixed(2)}% (${h.profit_pct >= 0 ? "+" : ""}${h.profit_amount?.toFixed(0)}元) [${MODE[h.stop_mode] || h.stop_mode}模式]`,
                })),
            ];
            return lines;
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
                    stop_mode: args.stop_mode || "fixed",
                    trail_drawdown_pct: args.trail_drawdown_pct ?? 10,
                }),
            });
        }
        if (args.action === "remove") {
            if (!args.code) return { error: "需要 code" };
            return await makeToolRequest(`/api/holdings/${args.code}`, { method: "DELETE" });
        }
        return { error: `未知操作：${args.action}` };
    },
};

// ============= 交易体系工具（择时/情绪/板块/仓位） =============

const stockMarketTimingTool = {
    name: "stock_market_timing",
    description: "大盘择时诊断。返回：市场阶段（主升/震荡/下跌/主跌）、『跌无可跌』多因子清单（RSI超卖/MACD底背离/回撤深度/价格分位/成交萎缩/跌停家数/两融余额）、『企稳信号』清单（缩量止跌/放量反包/跳空缺口/多板块联动）、建议总仓位区间和操作节奏。用户问『现在能不能入场/抄底/加仓』时必须先调用本工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) return [{ type: "text", text: `择时分析失败：${value?.error || "未知错误"}` }];
            const lines = [
                `【大盘择时】阶段：${value.stage?.stage}  建议仓位：${value.suggested_position}`,
                value.stage?.detail || "",
                "",
                `── 跌无可跌（${value.bottom_exhaustion?.hit_count}/${value.bottom_exhaustion?.total}）${value.bottom_exhaustion?.confirmed ? "✅ 已进入底部区域" : ""} ──`,
                ...(value.bottom_exhaustion?.items || []).map((i) =>
                    `  ${i.hit ? "✓" : i.skipped ? "⊘" : "✗"} ${i.name}：${i.value}`),
                "",
                `── 企稳信号（${value.stabilization?.hit_count}/${value.stabilization?.total}）──`,
                ...(value.stabilization?.items || []).map((i) =>
                    `  ${i.hit ? "✓" : "✗"} ${i.name}：${i.value}`),
                "",
                `结论：${value.bottom_exhaustion?.conclusion || ""}；${value.stabilization?.conclusion || ""}`,
                `节奏：${value.rhythm}`,
            ];
            return lines.map((t) => ({ type: "text", text: t }));
        },
    },
    async execute() {
        const err = backendStatusError();
        if (err) return { error: err };
        return await makeToolRequest(`/api/market/timing`);
    },
};

const stockSentimentTool = {
    name: "stock_sentiment",
    description: "市场情绪统计 + 风格判定。返回：涨停/跌停/炸板家数与炸板率、连板梯队（高度分布与个股）、全市场涨跌家数、两市成交额，以及市场风格判定（机构抱团期/题材妖股期/均衡混合期，含各因子明细和适配策略）。用户问『现在是抱团还是妖股行情/情绪怎么样/适合打板吗』时调用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) return [{ type: "text", text: `情绪分析失败：${value?.error || "未知错误"}` }];
            const s = value.sentiment || {};
            const st = value.style || {};
            const ladder = s.ladder || {};
            const lines = [
                `【市场情绪】涨停 ${s.zt_count} · 跌停 ${s.dt_count} · 炸板率 ${s.zb_rate}% · 连板 ${ladder.lianban_total} 只（最高${ladder.max_height}板）`,
                `  上涨 ${s.up_count} / 下跌 ${s.down_count} · 两市成交 ${s.total_amount_yi}亿`,
                "",
                `【风格判定】${st.label}（得分 ${st.score}/100，越高越偏题材妖股）`,
                `  适配策略：${st.strategy}`,
                ...(st.factors || []).map((f) => `  · ${f.name}：${f.detail}`),
            ];
            const heights = ladder.heights || [];
            for (const h of heights.slice(0, 5)) {
                lines.push(`  ${h.height}板×${h.count}：${h.stocks.map((x) => x.name).join("、")}`);
            }
            return lines.map((t) => ({ type: "text", text: t }));
        },
    },
    async execute() {
        const err = backendStatusError();
        if (err) return { error: err };
        return await makeToolRequest(`/api/market/sentiment`);
    },
};

const stockSectorsTool = {
    name: "stock_sectors",
    description: "板块监控与龙头候选。返回行业/概念板块排行（涨幅、成交额、5日动量、所处阶段：启动/发酵/高潮/退潮/盘整），并给出指定板块的龙头候选股（打分+理由：涨幅/涨停/换手/市值/量比）。用户问『哪个板块要启动/板块里谁是龙头/买什么方向』时调用。",
    parameters: {
        type: "object",
        properties: {
            board_type: { type: "string", enum: ["industry", "concept"], description: "industry=行业板块（默认），concept=概念板块" },
            top_n: { type: "integer", description: "返回板块数量（默认10）", default: 10 },
            leaders_of: { type: "string", description: "可选，板块代码（如 BK0475）。传入时返回该板块龙头候选" },
        },
    },
    output: {
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) return [{ type: "text", text: `板块分析失败：${value?.error || "未知错误"}` }];
            const toBlocks = (lines) => lines.map((t) => ({ type: "text", text: t }));
            if (value.leaders) {
                const lines = [`【${value.name || args.leaders_of} 龙头候选】板块5日 ${value.board_pct_5d ?? "-"}%`];
                for (const [i, l] of (value.leaders || []).entries()) {
                    lines.push(`  #${i + 1} ${l.name}(${l.code}) ${l.change_pct >= 0 ? "+" : ""}${l.change_pct}% 换手${l.turnover_rate?.toFixed(0)}% 流通${l.float_mv_yi}亿`);
                    lines.push(`     理由：${(l.reasons || []).join("、")}`);
                }
                return toBlocks(lines);
            }
            const lines = [`【板块排行 · ${args.board_type === "concept" ? "概念" : "行业"}】`];
            for (const b of value.boards || []) {
                lines.push(`  ${b.name} ${b.change_pct >= 0 ? "+" : ""}${b.change_pct}% 成交${(b.amount / 1e8).toFixed(0)}亿 5日${b.momentum_5d != null ? (b.momentum_5d >= 0 ? "+" : "") + b.momentum_5d + "%" : "-"} [${b.stage}] 领涨:${b.leader_name}`);
            }
            lines.push(`提示：可用 leaders_of=BK代码 查看某板块的龙头候选`);
            return toBlocks(lines);
        },
    },
    async execute(args) {
        const err = backendStatusError();
        if (err) return { error: err };
        if (args.leaders_of) {
            return await makeToolRequest(`/api/sectors/${args.leaders_of}/leaders?top_n=5`);
        }
        return await makeToolRequest(`/api/sectors?board_type=${args.board_type || "industry"}&top_n=${args.top_n || 10}`);
    },
};

const stockPositionTool = {
    name: "stock_position",
    description: "仓位体检。返回：当前总仓位 vs 大盘阶段建议仓位、现金比例、单票仓位超限（>25%）、同行业集中度（>40%）、持仓数量建议（3-6只）、每只持仓的加仓/减仓/止盈止损建议。用户问『我仓位重不重/现在该买多少/要不要减仓』时调用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
        schema: JSON_OBJECT_OUTPUT,
        render(args, value) {
            if (!value || value.error) return [{ type: "text", text: `仓位分析失败：${value?.error || "未知错误"}` }];
            const lines = [`【仓位体检】${value.summary || ""}`];
            if (value.position_pct != null) {
                lines.push(`  总仓位 ${value.position_pct}%（现金 ${value.cash_pct}%）· 建议 ${value.suggested_position}（${value.timing_stage}阶段）`);
            }
            for (const w of value.warnings || []) lines.push(`  ⚠️ ${w}`);
            for (const n of value.notes || []) lines.push(`  💡 ${n}`);
            for (const h of value.holdings || []) {
                lines.push(`  · ${h.name}(${h.code}) 成本${h.buy_price} 现价${h.current_price} 盈亏${h.profit_pct >= 0 ? "+" : ""}${h.profit_pct}%${h.weight_pct != null ? ` 仓位${h.weight_pct}%` : ""} ${h.industry ? `[${h.industry}]` : ""}`);
                lines.push(`    → ${h.advice}`);
            }
            return lines.map((t) => ({ type: "text", text: t }));
        },
    },
    async execute() {
        const err = backendStatusError();
        if (err) return { error: err };
        return await makeToolRequest(`/api/position/overview`);
    },
};

// ============= 插件入口 =============

// Cordis 插件契约：必须导出 name 和 inject（声明依赖的服务），
// 否则访问 ctx.tools 会抛 "cannot get property 'tools' without inject"。
const name = "dsh-plugin-stock";
const inject = ["tools", "systemPrompt"];

async function apply(ctx) {
    // 注册 8 个 AI 工具（原始对象，完整 JSON Schema）
    ctx.tools.register(stockQuoteTool);
    ctx.tools.register(stockKlineTool);
    ctx.tools.register(stockScreenTool);
    ctx.tools.register(stockHoldingsTool);
    ctx.tools.register(stockMarketTimingTool);
    ctx.tools.register(stockSentimentTool);
    ctx.tools.register(stockSectorsTool);
    ctx.tools.register(stockPositionTool);

    ctx.systemPrompt?.section?.({
        name: "stock-plugin",
        order: 200,
        text: `
DSH 股票监控插件已激活（交易体系辅助）。你拥有以下工具：
【行情】stock_quote 实时行情 / stock_kline K线
【择时】stock_market_timing 大盘阶段、跌无可跌清单、企稳信号、建议仓位 —— 用户问"能否入场/抄底/加仓"时必先调用
【情绪风格】stock_sentiment 涨跌停/连板梯队 + 抱团期vs妖股期判定 —— 用户问"什么行情/适合打板吗"时调用
【板块龙头】stock_sectors 板块排行(启动/发酵/高潮/退潮阶段) + 龙头候选 —— 用户问"哪个板块/买什么方向"时调用
【选股】stock_screen 4种策略（机构抱团/启动股/均线多头/题材妖股），结合风格判定结果推荐策略
【持仓仓位】stock_holdings 持仓记账 / stock_position 仓位体检（总仓位vs建议、单票≤25%、同行业≤40%）
【纪律】止损止盈支持 fixed/trailing(移动止损)/ladder(阶梯止盈) 三种模式 + 时间止损提醒

分析顺序建议：择时(能不能做) → 风格(怎么做) → 板块(做什么) → 龙头/选股(买什么) → 仓位(买多少) → 止损止盈(怎么保护)。
用户当前偏好：监控+建议，手动交易。所有交易建议必须由用户自己确认执行，不要假设会自动下单。
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

    ctx.logger?.info?.("dsh-plugin-stock: 已注册 8 个工具（行情/K线/择时/情绪/板块/选股/持仓/仓位）");
}

export { apply, inject, name };
