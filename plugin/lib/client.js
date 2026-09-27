/**
 * DSH 股票监控插件 - Client 端（交易体系仪表盘）
 *
 * 6 个 Tab：
 * - ⏱ 择时：大盘阶段 / 跌无可跌清单 / 企稳信号 / 建议仓位
 * - 🔥 情绪：涨跌停/炸板/连板梯队 + 风格判定（机构抱团 vs 题材妖股）
 * - 🧩 板块：行业/概念排行 + 阶段标签 + 龙头候选
 * - 💼 持仓：仓位体检 / 持仓管理（增删改）/ 止盈止损模式
 * - ⚠️ 预警：规则管理 + 触发历史
 * - 🔍 选股：4策略 + 全市场预热池
 *
 * 严格只读监控，所有交易由用户手动执行。
 */

const PLUGIN_API_BASE = (() => {
    try {
        const port = localStorage.getItem("dsh-plugin-stock:port");
        return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8765";
    } catch { return "http://127.0.0.1:8765"; }
})();
const STORAGE_KEY = "dsh-plugin-stock:order";
// K线库加载顺序：① 本地后端服务（随插件打包，最稳）② 国内CDN回退 ③ 国际CDN兜底
const KLINECHART_CDNS = [
    `${PLUGIN_API_BASE}/api/static/klinecharts.min.js`,
    "https://cdn.staticfile.net/klinecharts/9.8.12/klinecharts.min.js",
    "https://cdn.jsdelivr.net/npm/klinecharts@9.8.12/dist/klinecharts.min.js",
    "https://unpkg.com/klinecharts@9.8.12/dist/klinecharts.min.js",
];

window.__ModuleLoader__.load({
    id: "dsh-plugin-stock",
    factory: (require) => {
        const React = require("react");
        const { useState, useEffect, useRef, useCallback } = React;
        const { createRoot } = require("react-dom/client");

        // ============= 工具 =============
        const formatNum = (n, d = 2) => (n == null ? "-" : Number(n).toFixed(d));
        const formatPct = (n) => (n == null ? "-" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`);
        const formatYi = (n) => (n == null ? "-" : n >= 10000 ? `${(n / 10000).toFixed(1)}万亿` : `${Math.round(n)}亿`);
        const formatTime = (ts) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false });
        const cls = (n) => (n == null ? "" : n >= 0 ? "up" : "down");
        const formatDate = (dateStr) => {
            const date = new Date(dateStr);
            const today = new Date();
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            const dateOnly = new Date(dateStr);
            if (dateOnly.toDateString() === today.toDateString()) {
                return "今天";
            } else if (dateOnly.toDateString() === tomorrow.toDateString()) {
                return "明天";
            } else {
                return `${dateOnly.getMonth() + 1}月${dateOnly.getDate()}日`;
            }
        };

        async function api(path, options) {
            const resp = await fetch(`${PLUGIN_API_BASE}${path}`, options);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            return resp.json();
        }
        const post = (path, body) => api(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const put = (path, body) => api(path, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        function usePolling(fn, intervalMs, deps) {
            useEffect(() => {
                let alive = true;
                const run = async () => { if (alive) await fn(); };
                run();
                const t = setInterval(run, intervalMs);
                return () => { alive = false; clearInterval(t); };
            }, deps || []);
        }

        function loadOrder() {
            try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
            catch { return []; }
        }
        function saveOrder(codes) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(codes));
        }

        let klineLoading = null;
        function loadKlineChart() {
            if (window.klinecharts) return Promise.resolve(window.klinecharts);
            if (klineLoading) return klineLoading;
            klineLoading = new Promise((resolve, reject) => {
                let idx = 0;
                const tryNext = () => {
                    if (idx >= KLINECHART_CDNS.length) {
                        klineLoading = null;
                        reject(new Error("K线库加载失败（本地服务与全部CDN均不可用，请检查后端是否运行）"));
                        return;
                    }
                    const script = document.createElement("script");
                    script.src = KLINECHART_CDNS[idx++];
                    script.onload = () => (window.klinecharts ? resolve(window.klinecharts) : tryNext());
                    script.onerror = tryNext;
                    document.head.appendChild(script);
                };
                tryNext();
            });
            return klineLoading;
        }

        // ============= 通用小组件 =============
        function RefreshBtn({ onClick, loading, title }) {
            return React.createElement("button", {
                className: `dsh-stock-refresh ${loading ? "spin" : ""}`,
                onClick, title: title || "立即刷新",
            }, loading ? "⟳" : "↻");
        }

        function TabHead({ title, extra, onRefresh, refreshing }) {
            return React.createElement("div", { className: "dsh-stock-tab-head" },
                React.createElement("span", { className: "dsh-stock-tab-title" }, title),
                extra,
                onRefresh && React.createElement(RefreshBtn, { onClick: onRefresh, loading: refreshing }));
        }

        function LoadingBar({ show }) {
            return show ? React.createElement("div", { className: "dsh-stock-loadingbar" }) : null;
        }

        // ============= K线模态框 =============
        function KLineModal({ code, name, onClose }) {
            const containerRef = useRef(null);
            const chartRef = useRef(null);
            const [period, setPeriod] = useState(9);
            const [loading, setLoading] = useState(true);
            const [error, setError] = useState(null);

            useEffect(() => {
                if (!code) return;
                let cancelled = false;
                (async () => {
                    try {
                        setLoading(true);
                        setError(null);
                        const kc = await loadKlineChart();
                        if (cancelled) return;
                        const data = await api(`/api/kline/${code}?category=${period}&count=500`);
                        if (cancelled) return;
                        const candles = (data.data || []).map((d) => ({
                            timestamp: new Date(d.datetime.replace(/\s.*$/, "")).getTime(),
                            open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
                        }));
                        if (!chartRef.current) {
                            chartRef.current = kc.init(containerRef.current);
                            chartRef.current.createIndicator("MA", false, { id: "candle_pane" });
                            chartRef.current.createIndicator("VOL");
                            chartRef.current.createIndicator("MACD");
                        }
                        chartRef.current.applyNewData(candles);
                        setLoading(false);
                    } catch (e) {
                        if (!cancelled) { setError(e.message); setLoading(false); }
                    }
                })();
                return () => { cancelled = true; };
            }, [code, period]);

            useEffect(() => () => {
                if (chartRef.current && containerRef.current) {
                    chartRef.current.dispose();
                    chartRef.current = null;
                }
            }, []);

            if (!code) return null;
            const periods = { 9: "日K", 5: "周K", 6: "月K", 0: "5分", 1: "15分", 2: "30分", 3: "60分" };
            return React.createElement("div", { className: "dsh-stock-modal-mask", onClick: onClose },
                React.createElement("div", { className: "dsh-stock-modal", onClick: (e) => e.stopPropagation() },
                    React.createElement("div", { className: "dsh-stock-modal-header" },
                        React.createElement("span", null, `${name} (${code})`),
                        React.createElement("button", { className: "close-btn", onClick: onClose }, "✕")
                    ),
                    React.createElement("div", { className: "dsh-stock-periods" },
                        Object.entries(periods).map(([k, label]) =>
                            React.createElement("button", {
                                key: k,
                                className: period == k ? "active" : "",
                                onClick: () => setPeriod(Number(k)),
                            }, label)
                        )
                    ),
                    loading && React.createElement("div", { className: "dsh-stock-modal-overlay" }, "加载 K线…"),
                    error && React.createElement("div", { className: "dsh-stock-modal-overlay error" }, `错误：${error}`),
                    React.createElement("div", { ref: containerRef, className: "dsh-stock-kline" })
                )
            );
        }

        // ============= 通用小组件 =============
        function Checklist({ title, data }) {
            if (!data) return null;
            return React.createElement("div", { className: "dsh-stock-card" },
                React.createElement("div", { className: "dsh-stock-card-title" },
                    title,
                    React.createElement("span", { className: `dsh-stock-badge ${data.confirmed ? "good" : ""}` },
                        `${data.hit_count}/${data.total}`)),
                React.createElement("div", { className: "dsh-stock-conclusion" }, data.conclusion),
                React.createElement("div", { className: "dsh-stock-checklist" },
                    (data.items || []).map((i, idx) =>
                        React.createElement("div", { key: idx, className: `dsh-stock-check ${i.hit ? "hit" : i.skipped ? "skip" : "miss"}` },
                            React.createElement("span", { className: "dsh-stock-check-mark" },
                                i.hit ? "✓" : i.skipped ? "⊘" : "✗"),
                            React.createElement("span", { className: "dsh-stock-check-name" },
                                i.name,
                                React.createElement("span", { className: "dsh-stock-check-value" }, i.value)),
                            i.note && React.createElement("span", { className: "dsh-stock-check-note" }, i.note),
                        ))
                )
            );
        }

        function ErrorBox({ error }) {
            if (!error) return null;
            return React.createElement("div", { className: "dsh-stock-error-box" }, `⚠️ ${error}`);
        }

        function LoadingBox({ loading, children }) {
            if (loading) return React.createElement("div", { className: "dsh-stock-loading" }, "加载中…");
            return children;
        }

        // ============= Tab 1: 择时 =============
        function TimingTab({ openStock }) {
            const [timing, setTiming] = useState(null);
            const [indices, setIndices] = useState(null);
            const [error, setError] = useState(null);
            const [refreshing, setRefreshing] = useState(false);

            const load = useCallback(async (force) => {
                if (force) setRefreshing(true);
                try {
                    const [t, idx] = await Promise.all([
                        api(`/api/market/timing${force ? "?force=1" : ""}`),
                        api("/api/index-quotes"),
                    ]);
                    setTiming(t.error ? null : t);
                    setError(t.error || null);
                    setIndices(idx.indices || {});
                } catch (e) { setError(e.message); }
                if (force) setRefreshing(false);
            }, []);
            usePolling(() => load(false), 60000, []);

            const stageColors = { "主升": "good", "震荡": "mid", "下跌": "bad", "主跌": "bad" };
            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement(TabHead, {
                    title: "⏱ 大盘择时",
                    onRefresh: () => load(true), refreshing,
                    extra: indices && React.createElement("span", { className: "dsh-stock-src-tag" },
                        `指数源: ${indices["000300"] ? "实时" : "-"}`),
                }),
                React.createElement(LoadingBar, { show: refreshing && !timing }),
                React.createElement(ErrorBox, { error }),
                indices && React.createElement("div", { className: "dsh-stock-indices" },
                    Object.entries(indices).map(([code, idx]) =>
                        React.createElement("div", { key: code, className: `dsh-stock-idx ${cls(idx.change_pct)}` },
                            React.createElement("span", { className: "name" }, idx.display_name || code),
                            React.createElement("span", { className: "pt" }, formatNum(idx.price)),
                            React.createElement("span", { className: "pct" }, formatPct(idx.change_pct))
                        ))
                ),
                timing && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "dsh-stock-stage-row" },
                        React.createElement("span", { className: `dsh-stock-stage-badge ${stageColors[timing.stage.stage] || ""}` },
                            `市场阶段：${timing.stage.stage}`),
                        React.createElement("span", { className: "dsh-stock-position-badge" },
                            `建议仓位 ${timing.suggested_position}`)),
                    React.createElement("div", { className: "dsh-stock-detail" }, timing.stage.detail),
                    React.createElement("div", { className: "dsh-stock-action" }, `📋 ${timing.action_advice}`),
                    React.createElement(Checklist, { title: "🕳 跌无可跌（下跌动能衰竭）", data: timing.bottom_exhaustion }),
                    React.createElement(Checklist, { title: "🌱 企稳信号（入场确认）", data: timing.stabilization }),
                    React.createElement("div", { className: "dsh-stock-card" },
                        React.createElement("div", { className: "dsh-stock-card-title" }, "操作节奏"),
                        React.createElement("div", { className: "dsh-stock-rhythm" }, timing.rhythm)),
                )
            );
        }

        // ============= Tab 2: 情绪/风格 =============
        function SentimentTab({ openStock }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const [refreshing, setRefreshing] = useState(false);

            const load = useCallback(async (force) => {
                if (force) setRefreshing(true);
                try {
                    const d = await api(`/api/market/sentiment${force ? "?force=1" : ""}`);
                    if (d.error) { setError(d.error); }
                    else { setError(null); setData(d); }
                } catch (e) { setError(e.message); }
                if (force) setRefreshing(false);
            }, []);
            usePolling(() => load(false), 60000, []);

            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement(TabHead, { title: "🔥 市场情绪与风格", onRefresh: () => load(true), refreshing }),
                React.createElement(LoadingBar, { show: refreshing && !data }),
                error && React.createElement(ErrorBox, { error }),
                !data && !error && React.createElement("div", { className: "dsh-stock-loading" }, "加载中…"),
                data && React.createElement(SentimentBody, { data, openStock }),
            );
        }

        function SentimentBody({ data, openStock }) {

            const s = data.sentiment || {};
            const st = data.style || {};
            const ladder = s.ladder || {};
            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement("div", { className: "dsh-stock-stat-grid" },
                    [["涨停", s.zt_count, "up"], ["跌停", s.dt_count, "down"],
                     ["炸板率", s.zb_rate != null ? `${s.zb_rate}%` : "-", "mid"],
                     ["上涨家数", s.up_count, "up"], ["下跌家数", s.down_count, "down"],
                     ["两市成交", s.total_amount_yi != null ? `${s.total_amount_yi}亿` : "-", "mid"]]
                        .map(([label, v, tone], i) =>
                            React.createElement("div", { key: i, className: `dsh-stock-stat ${tone}` },
                                React.createElement("span", { className: "label" }, label),
                                React.createElement("span", { className: "value" }, v)))),
                React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "🎭 市场风格判定"),
                    React.createElement("div", { className: "dsh-stock-style-bar" },
                        React.createElement("span", { className: "pole" }, "机构抱团"),
                        React.createElement("div", { className: "dsh-stock-style-track" },
                            React.createElement("div", { className: "dsh-stock-style-marker", style: { left: `${st.score}%` } }),
                            React.createElement("div", { className: "dsh-stock-style-zones" },
                                React.createElement("span", null, "←抱团期"),
                                React.createElement("span", null, "均衡"),
                                React.createElement("span", null, "妖股期→"))),
                        React.createElement("span", { className: "pole" }, "题材妖股")),
                    React.createElement("div", { className: `dsh-stock-style-label ${st.score >= 65 ? "up" : st.score <= 35 ? "down" : "mid"}` },
                        `${st.label}（得分 ${st.score}/100）`),
                    React.createElement("div", { className: "dsh-stock-detail" }, `🎯 适配策略：${st.strategy}`),
                    React.createElement("div", { className: "dsh-stock-factors" },
                        (st.factors || []).map((f, i) =>
                            React.createElement("div", { key: i, className: "dsh-stock-factor" },
                                React.createElement("span", { className: `dsh-stock-factor-tag ${f.direction === "speculative" ? "up" : "down"}` },
                                    f.direction === "speculative" ? "妖股+" : "抱团+"),
                                React.createElement("span", null, `${f.name}：${f.detail}`)))),
                ),
                ladder.heights && ladder.heights.length > 0 && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" },
                        "🪜 连板梯队",
                        React.createElement("span", { className: "dsh-stock-badge" },
                            `最高${ladder.max_height}板 · 连板${ladder.lianban_total}只 · 首板${ladder.shouban_count}只`)),
                    React.createElement("div", { className: "dsh-stock-ladder" },
                        ladder.heights.map((h) =>
                            React.createElement("div", { key: h.height, className: "dsh-stock-ladder-row" },
                                React.createElement("span", { className: `dsh-stock-ladder-h ${h.height >= 4 ? "hot" : ""}` }, `${h.height}板×${h.count}`),
                                React.createElement("span", { className: "dsh-stock-ladder-stocks" },
                                    h.stocks.map((s2) =>
                                        React.createElement("span", {
                                            key: s2.code, className: "dsh-stock-ladder-stock",
                                            onClick: () => openStock({ code: s2.code, name: s2.name }),
                                        }, s2.name))))))
                )
            );
        }

        // ============= Tab 3: 板块 =============
        const STAGE_TONE = { "启动": "good", "发酵": "up", "高潮": "hot", "退潮": "down", "盘整": "mid", "未知": "mid" };

        function SectorTab({ openStock }) {
            const [boardType, setBoardType] = useState("industry");
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const [loading, setLoading] = useState(true);
            const [expanded, setExpanded] = useState(null);
            const [leaders, setLeaders] = useState(null);
            const [leadersLoading, setLeadersLoading] = useState(false);

            const load = useCallback(async (force) => {
                setLoading(true);
                try {
                    const d = await api(`/api/sectors?board_type=${boardType}&top_n=20${force ? "&force=1" : ""}`);
                    if (d.error) { setError(d.error); setData(null); }
                    else { setError(null); setData(d); }
                } catch (e) { setError(e.message); }
                setLoading(false);
            }, [boardType]);
            usePolling(() => load(false), 60000, [boardType]);

            const toggle = async (bk) => {
                if (expanded === bk.bk_code) { setExpanded(null); return; }
                setExpanded(bk.bk_code);
                setLeadersLoading(true);
                setLeaders(null);
                try {
                    const d = await api(`/api/sectors/${bk.bk_code}/leaders?name=${encodeURIComponent(bk.name)}&top_n=5`);
                    setLeaders(d);
                } catch (e) { setLeaders({ error: e.message, leaders: [] }); }
                setLeadersLoading(false);
            };

            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement(TabHead, {
                    title: "🧩 板块监控与龙头",
                    onRefresh: () => load(true), refreshing: loading,
                }),
                React.createElement("div", { className: "dsh-stock-seg" },
                    ["industry", "concept"].map((t) =>
                        React.createElement("button", {
                            key: t,
                            className: boardType === t ? "active" : "",
                            disabled: loading,
                            onClick: () => { setBoardType(t); setExpanded(null); },
                        }, t === "industry" ? "行业板块" : "概念板块"))),
                React.createElement(LoadingBar, { show: loading }),
                React.createElement(ErrorBox, { error }),
                !data && !error && !loading && React.createElement("div", { className: "dsh-stock-loading" }, "加载中…"),
                data && data.boards && React.createElement("div", { className: "dsh-stock-table" },
                    React.createElement("div", { className: "dsh-stock-thead" },
                        React.createElement("span", null, "板块"),
                        React.createElement("span", null, "涨幅"),
                        React.createElement("span", null, "成交额"),
                        React.createElement("span", null, "5日动量"),
                        React.createElement("span", null, "阶段"),
                        React.createElement("span", null, "领涨股")),
                    data.boards.map((b) =>
                        React.createElement(React.Fragment, { key: b.bk_code },
                            React.createElement("div", {
                                className: `dsh-stock-trow ${cls(b.change_pct)}`,
                                onClick: () => toggle(b),
                            },
                                React.createElement("span", { className: "dsh-stock-bname" }, b.name),
                                React.createElement("span", { className: "num" }, formatPct(b.change_pct)),
                                React.createElement("span", { className: "num" }, formatYi(b.amount / 1e8)),
                                React.createElement("span", { className: "num" },
                                    b.momentum_5d != null ? formatPct(b.momentum_5d) : "-"),
                                React.createElement("span", null,
                                    React.createElement("span", { className: `dsh-stock-stage-chip ${STAGE_TONE[b.stage] || "mid"}` },
                                        b.stage || "-")),
                                React.createElement("span", { className: "dsh-stock-leader" },
                                    `${b.leader_name || "-"}`,
                                    b.leader_change_pct != null ? ` ${formatPct(b.leader_change_pct)}` : "")),
                            expanded === b.bk_code && React.createElement("div", { className: "dsh-stock-leaders" },
                                leadersLoading && React.createElement("div", { className: "dsh-stock-loading" }, "拉取龙头候选…"),
                                leaders && leaders.error && React.createElement("div", { className: "dsh-stock-error-box" }, `⚠️ ${leaders.error}`),
                                leaders && leaders.leaders && leaders.leaders.length > 0 && React.createElement(React.Fragment, null,
                                    React.createElement("div", { className: "dsh-stock-leaders-title" },
                                        `🐲 龙头候选（板块5日 ${formatPct(leaders.board_pct_5d)}）`),
                                    leaders.leaders.map((l, i) =>
                                        React.createElement("div", {
                                            key: l.code, className: "dsh-stock-leader-row",
                                            onClick: () => openStock({ code: l.code, name: l.name }),
                                        },
                                            React.createElement("span", { className: "rank" }, `#${i + 1}`),
                                            React.createElement("span", { className: "name" }, `${l.name} (${l.code})`),
                                            React.createElement("span", { className: `num ${cls(l.change_pct)}` }, formatPct(l.change_pct)),
                                            React.createElement("span", { className: "dsh-stock-leader-reason" }, l.reasons.join("·")))),
                                    React.createElement("div", { className: "dsh-stock-detail" },
                                        "龙头判定：涨幅/涨停 > 换手10-25% > 流通市值50-300亿 > 量比放大。仅为候选清单，需结合辨识度与基本面确认。")),
                                leaders && leaders.leaders && leaders.leaders.length === 0 && !leadersLoading &&
                                    React.createElement("div", { className: "dsh-stock-empty-inline" }, "该板块暂无符合条件的龙头候选"))
                        ))
                )
            );
        }

        // ============= Tab 4: 持仓/仓位 =============
        const STOP_MODE_LABEL = { fixed: "固定比例", trailing: "移动止损", ladder: "阶梯止盈" };
        const STOP_MODE_TIPS = {
            fixed: "固定比例：触及止损线（默认 -7%）或止盈线（默认 +15%）立即预警。适合明确看好目标价、对波动不敏感的场景。",
            trailing: "移动止损：股价曾盈利超 5% 后止损线自动上移到成本（保本）；之后从最高点回撤超过阈值（默认 10%）预警。适合上涨趋势中保护浮盈。",
            ladder: "阶梯止盈：盈利 +20% 提示卖 1/3、+50% 再卖 1/3；尾仓按移动止损保护。适合部分锁利 + 保留向上空间。",
        };

        function PositionTab({ openStock, refreshTick }) {
            const [overview, setOverview] = useState(null);
            const [account, setAccount] = useState(null);
            const [error, setError] = useState(null);
            const [refreshing, setRefreshing] = useState(false);
            const [capitalInput, setCapitalInput] = useState("");
            const [showForm, setShowForm] = useState(false);
            const [form, setForm] = useState({
                code: "", name: "", buy_price: "", shares: "",
                stop_loss_pct: -7, take_profit_pct: 15, stop_mode: "fixed", trail_drawdown_pct: 10,
            });
            const [formError, setFormError] = useState(null);
            const [saving, setSaving] = useState(false);

            const load = useCallback(async (force) => {
                if (force) setRefreshing(true);
                try {
                    const [ov, acc] = await Promise.all([
                        api(`/api/position/overview?t=${Date.now()}`),
                        api("/api/account"),
                    ]);
                    setOverview(ov.error ? null : ov);
                    setError(ov.error || null);
                    setAccount(acc);
                } catch (e) { setError(e.message); }
                if (force) setRefreshing(false);
            }, [refreshTick]);
            usePolling(() => load(false), 10000, [refreshTick]);

            const saveCapital = async () => {
                const v = Number(capitalInput);
                if (!v || v <= 0) return;
                try {
                    await put("/api/account", { total_capital: v });
                    setCapitalInput("");
                    load();
                } catch (e) { setError(e.message); }
            };

            const addHolding = async () => {
                if (!form.code || !form.name || !form.buy_price || !form.shares) {
                    setFormError("代码/名称/成本/数量必填");
                    return;
                }
                setSaving(true);
                setFormError(null);
                try {
                    await post("/api/holdings", {
                        code: form.code.trim(), name: form.name.trim(),
                        buy_price: Number(form.buy_price), shares: Number(form.shares),
                        stop_loss_pct: Number(form.stop_loss_pct),
                        take_profit_pct: Number(form.take_profit_pct),
                        stop_mode: form.stop_mode,
                        trail_drawdown_pct: Number(form.trail_drawdown_pct),
                    });
                    setShowForm(false);
                    setForm({ code: "", name: "", buy_price: "", shares: "", stop_loss_pct: -7, take_profit_pct: 15, stop_mode: "fixed", trail_drawdown_pct: 10 });
                    load();
                } catch (e) { setFormError(e.message); }
                setSaving(false);
            };

            const removeHolding = async (code) => {
                try {
                    await api(`/api/holdings/${code}`, { method: "DELETE" });
                    load();
                } catch (e) { setError(e.message); }
            };

            const changeMode = async (code, stopMode) => {
                try {
                    await put(`/api/holdings/${code}`, { stop_mode: stopMode });
                    load();
                } catch (e) { setError(e.message); }
            };

            const cap = account && account.total_capital;
            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement(TabHead, { title: "💼 持仓与仓位", onRefresh: () => load(true), refreshing }),
                React.createElement(ErrorBox, { error }),
                React.createElement("div", { className: "dsh-stock-account-row" },
                    React.createElement("span", { className: "dsh-stock-account-label" },
                        cap ? `💰 总资金：${Number(cap).toLocaleString()}元` : "💰 未设置总资金"),
                    React.createElement("input", {
                        className: "dsh-stock-input", placeholder: "输入总资金(元)",
                        value: capitalInput,
                        onChange: (e) => setCapitalInput(e.target.value),
                        onKeyDown: (e) => e.key === "Enter" && saveCapital(),
                    }),
                    React.createElement("button", { className: "dsh-stock-btn sm", onClick: saveCapital }, "保存"),
                    React.createElement("button", { className: "dsh-stock-btn sm ghost", onClick: () => setShowForm(!showForm) },
                        showForm ? "收起" : "＋ 添加持仓")),
                showForm && React.createElement("div", { className: "dsh-stock-form" },
                    React.createElement("div", { className: "dsh-stock-form-grid" },
                        ["code", "name", "buy_price", "shares", "stop_loss_pct", "take_profit_pct"].map((k) =>
                            React.createElement("label", { key: k, className: "dsh-stock-field" },
                                React.createElement("span", { className: "dsh-stock-field-label" },
                                    { code: "股票代码", name: "股票名称", buy_price: "成本价(元)",
                                      shares: "持股数(股)", stop_loss_pct: "止损线(%)", take_profit_pct: "止盈线(%)" }[k]),
                                React.createElement("input", {
                                    className: "dsh-stock-input",
                                    placeholder: { code: "如 600519", name: "如 贵州茅台", buy_price: "如 1500",
                                                   shares: "如 100", stop_loss_pct: "默认 -7", take_profit_pct: "默认 15" }[k],
                                    value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }),
                                })))),
                    React.createElement("div", { className: "dsh-stock-form-row" },
                        React.createElement("span", { className: "dsh-stock-form-label" }, "止盈止损模式："),
                        Object.entries(STOP_MODE_LABEL).map(([v, label]) =>
                            React.createElement("button", {
                                key: v, className: `dsh-stock-seg-btn ${form.stop_mode === v ? "active" : ""}`,
                                title: STOP_MODE_TIPS[v],
                                onClick: () => setForm({ ...form, stop_mode: v }),
                            }, label)),
                        form.stop_mode === "trailing" && React.createElement("label", { className: "dsh-stock-field inline" },
                            React.createElement("span", { className: "dsh-stock-field-label" }, "高点回撤阈值(%)"),
                            React.createElement("input", {
                                className: "dsh-stock-input sm",
                                placeholder: "默认 10",
                                value: form.trail_drawdown_pct,
                                onChange: (e) => setForm({ ...form, trail_drawdown_pct: e.target.value }),
                            }))),
                    formError && React.createElement("div", { className: "dsh-stock-error-box" }, formError),
                    React.createElement("div", { className: "dsh-stock-form-row" },
                        React.createElement("button", { className: "dsh-stock-btn", disabled: saving, onClick: addHolding },
                            saving ? "保存中…" : "保存持仓"),
                        React.createElement("span", { className: "dsh-stock-form-hint" },
                            "鼠标悬停在模式按钮上查看各模式详细说明"))),
                overview && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "dsh-stock-card" },
                        React.createElement("div", { className: "dsh-stock-card-title" }, "📊 仓位体检"),
                        React.createElement("div", { className: "dsh-stock-detail" }, overview.summary || "-"),
                        overview.position_pct != null && React.createElement("div", { className: "dsh-stock-position-track" },
                            React.createElement("div", { className: "dsh-stock-position-fill", style: { width: `${Math.min(100, overview.position_pct)}%` } }),
                            React.createElement("span", { className: "dsh-stock-position-text" },
                                `持仓 ${overview.position_pct}% · 现金 ${overview.cash_pct}% · 建议 ${overview.suggested_position || "-"}（${overview.timing_stage}）`)),
                        overview.warnings && overview.warnings.length > 0 && React.createElement("div", { className: "dsh-stock-warnings" },
                            overview.warnings.map((w, i) =>
                                React.createElement("div", { key: i, className: "dsh-stock-warning" }, `⚠️ ${w}`))),
                        overview.notes && overview.notes.map((n, i) =>
                            React.createElement("div", { key: i, className: "dsh-stock-note" }, `💡 ${n}`)),
                    (overview.holdings || []).length > 0 && React.createElement("div", { className: "dsh-stock-holdings" },
                        overview.holdings.map((h) =>
                            React.createElement("div", { key: h.code, className: `dsh-stock-holding ${cls(h.profit_pct)}` },
                                React.createElement("div", { className: "dsh-stock-holding-main", onClick: () => openStock({ code: h.code, name: h.name }) },
                                    React.createElement("span", { className: "name" }, `${h.name} (${h.code})`),
                                    React.createElement("span", { className: "num" },
                                        `${formatNum(h.current_price)} · ${formatPct(h.profit_pct)}${h.weight_pct != null ? ` · 仓位${h.weight_pct}%` : ""}`)),
                                React.createElement("div", { className: "dsh-stock-holding-info" },
                                    React.createElement("span", { title: STOP_MODE_TIPS[h.stop_mode] || "" }, `${STOP_MODE_LABEL[h.stop_mode] || h.stop_mode}${h.industry ? ` · ${h.industry}` : ""}`),
                                    React.createElement("span", { className: "dsh-stock-holding-advice" }, h.advice)),
                                React.createElement("div", { className: "dsh-stock-holding-ops" },
                                    React.createElement("select", {
                                        className: "dsh-stock-select",
                                        value: h.stop_mode || "fixed",
                                        onChange: (e) => changeMode(h.code, e.target.value),
                                    }, Object.entries(STOP_MODE_LABEL).map(([v, l]) =>
                                        React.createElement("option", { key: v, value: v, title: STOP_MODE_TIPS[v] }, l))),
                                    React.createElement("button", {
                                        className: "dsh-stock-btn sm danger",
                                        onClick: () => removeHolding(h.code),
                                    }, "删除"))))
                    ),
                    (overview.holdings || []).length === 0 && React.createElement("div", { className: "dsh-stock-empty-inline" },
                        "暂无持仓，点击「＋ 添加持仓」录入"))
                )
            );
        }

        // ============= Tab 5: 预警 =============
        const ALERT_TYPE_LABEL = {
            stop_loss: "🛑止损", take_profit: "🎯止盈", trailing_stop: "📉移动止损",
            breakeven_stop: "🛡保本止损", ladder_tp: "💰阶梯止盈", time_stop: "⏰时间止损",
            price_above: "↑突破", price_below: "↓跌破", change_pct_above: "📈涨幅",
        };

        function AlertTab({ openStock, liveAlerts }) {
            const [rules, setRules] = useState([]);
            const [history, setHistory] = useState([]);
            const [error, setError] = useState(null);
            const [form, setForm] = useState({ code: "", type: "price_above", threshold: "" });

            const load = useCallback(async () => {
                try {
                    const [r, h] = await Promise.all([
                        api("/api/alerts"),
                        api("/api/alerts/history"),
                    ]);
                    setRules(r.alerts || []);
                    setHistory(h.history || []);
                    setError(null);
                } catch (e) { setError(e.message); }
            }, []);
            usePolling(load, 30000, []);

            const addRule = async () => {
                if (!form.code || form.threshold === "") return;
                try {
                    await post("/api/alerts", {
                        code: form.code.trim(), type: form.type,
                        threshold: Number(form.threshold),
                    });
                    setForm({ code: "", type: "price_above", threshold: "" });
                    load();
                } catch (e) { setError(e.message); }
            };
            const delRule = async (id) => {
                try { await api(`/api/alerts/${id}`, { method: "DELETE" }); load(); }
                catch (e) { setError(e.message); }
            };
            const toggleRule = async (rule) => {
                try { await put(`/api/alerts/${rule.id}`, { enabled: !rule.enabled }); load(); }
                catch (e) { setError(e.message); }
            };

            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement(ErrorBox, { error }),
                liveAlerts.length > 0 && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "🟢 本次会话实时预警"),
                    liveAlerts.slice(0, 5).map((a, i) =>
                        React.createElement("div", { key: i, className: `dsh-stock-alert ${a.severity}` }, a.message))),
                React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "➕ 添加预警规则"),
                    React.createElement("div", { className: "dsh-stock-form-row" },
                        React.createElement("input", {
                            className: "dsh-stock-input", placeholder: "代码 如 600519",
                            value: form.code, onChange: (e) => setForm({ ...form, code: e.target.value }),
                        }),
                        React.createElement("select", {
                            className: "dsh-stock-select",
                            value: form.type,
                            onChange: (e) => setForm({ ...form, type: e.target.value }),
                        },
                            React.createElement("option", { value: "price_above" }, "价格突破"),
                            React.createElement("option", { value: "price_below" }, "价格跌破"),
                            React.createElement("option", { value: "change_pct_above" }, "涨幅超%"),
                        ),
                        React.createElement("input", {
                            className: "dsh-stock-input", placeholder: "阈值",
                            value: form.threshold, onChange: (e) => setForm({ ...form, threshold: e.target.value }),
                        }),
                        React.createElement("button", { className: "dsh-stock-btn sm", onClick: addRule }, "添加"))),
                rules.length > 0 && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, `📋 预警规则 (${rules.length})`),
                    rules.map((r) =>
                        React.createElement("div", { key: r.id, className: `dsh-stock-rule ${r.enabled ? "" : "off"}` },
                            React.createElement("span", { className: "dsh-stock-rule-text" },
                                `${r.code} ${ALERT_TYPE_LABEL[r.type] || r.type} ${r.threshold}`),
                            React.createElement("span", { className: "dsh-stock-rule-ops" },
                                React.createElement("button", { className: "dsh-stock-btn sm ghost", onClick: () => toggleRule(r) },
                                    r.enabled ? "停用" : "启用"),
                                React.createElement("button", { className: "dsh-stock-btn sm danger", onClick: () => delRule(r.id) }, "删除"))))),
                React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "📜 触发历史（持久化）"),
                    history.length === 0
                        ? React.createElement("div", { className: "dsh-stock-empty-inline" }, "暂无触发记录")
                        : history.map((a, i) =>
                            React.createElement("div", { key: i, className: `dsh-stock-alert ${a.severity || "medium"}` },
                                React.createElement("span", { className: "dsh-stock-alert-time" }, formatTime(a.timestamp)),
                                ` ${a.message}`)))
            );
        }

        // ============= Tab 6: 选股 =============
        const SCREEN_TYPES = [
            { id: "institutional", name: "机构抱团股", desc: "高位强势+均线多头" },
            { id: "breakout", name: "启动股", desc: "横盘放量突破+MACD金叉" },
            { id: "trend", name: "均线多头", desc: "六线多头趋势明确" },
            { id: "speculative", name: "题材妖股", desc: "近期涨停+放量新高" },
        ];

        function ScreenTab({ openStock }) {
            const [running, setRunning] = useState(null);
            const [results, setResults] = useState(null);
            const [useMarket, setUseMarket] = useState(false);
            const [poolStatus, setPoolStatus] = useState(null);
            const [error, setError] = useState(null);

            useEffect(() => {
                api("/api/screen/pool-status").then(setPoolStatus).catch(() => {});
            }, []);

            const run = async (typeId) => {
                setRunning(typeId);
                setError(null);
                setResults(null);
                try {
                    const d = await post("/api/screen", {
                        screen_type: typeId,
                        max_results: 30,
                        ...(useMarket ? { pool: "market" } : {}),
                    });
                    if (d.error) { setError(d.error); }
                    setResults(d);
                    api("/api/screen/pool-status").then(setPoolStatus).catch(() => {});
                } catch (e) { setError(e.message); }
                setRunning(null);
            };

            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement("div", { className: "dsh-stock-screen-grid" },
                    SCREEN_TYPES.map((t) =>
                        React.createElement("button", {
                            key: t.id,
                            className: "dsh-stock-screen-btn",
                            disabled: !!running,
                            onClick: () => run(t.id),
                        },
                            React.createElement("span", { className: "name" }, running === t.id ? "扫描中…" : t.name),
                            React.createElement("span", { className: "desc" }, t.desc)))),
                React.createElement("div", { className: "dsh-stock-pool-row" },
                    React.createElement("label", { className: "dsh-stock-check-inline" },
                        React.createElement("input", {
                            type: "checkbox", checked: useMarket,
                            onChange: (e) => setUseMarket(e.target.checked),
                        }),
                        " 全市场池"),
                    poolStatus && React.createElement("span", { className: "dsh-stock-pool-status" },
                        `缓存 ${poolStatus.warmed}/${poolStatus.total} 只${poolStatus.warming ? " · 预热中…" : ""}`,
                        useMarket && poolStatus.warmed < 100 ? "（预热不足，暂不可用）" : "")),
                React.createElement(ErrorBox, { error }),
                results && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" },
                        `选出 ${results.count} 只${results.pool_mode === "market" ? "（全市场）" : ""}`),
                    (results.results || []).map((r) =>
                        React.createElement("div", {
                            key: r.code,
                            className: `dsh-stock-srow ${cls(r.change_pct)}`,
                            onClick: () => openStock({ code: r.code, name: r.name }),
                        },
                            React.createElement("span", { className: "name" }, `${r.name} (${r.code})`),
                            React.createElement("span", { className: "num" }, `${formatNum(r.price)} ${formatPct(r.change_pct)}`),
                            r.reason && React.createElement("span", { className: "dsh-stock-srow-reason" }, r.reason))),
                    results.count === 0 && React.createElement("div", { className: "dsh-stock-empty-inline" }, "无符合条件的股票"))
            );
        }

        // ============= Tab 7: 舆情联动 =============
        // --- 舆情辅助函数 ---
        function newsImportanceStars(score) {
            if (score >= 90) return "⭐⭐⭐⭐⭐";
            if (score >= 75) return "⭐⭐⭐⭐";
            if (score >= 60) return "⭐⭐⭐";
            if (score >= 45) return "⭐⭐";
            return "⭐";
        }
        function newsSentimentIcon(tag) {
            if (tag === "positive") return "📈";
            if (tag === "negative") return "📉";
            return "📊";
        }
        function newsSourceName(src) {
            const map = { eastmoney: "东财", sina: "新浪", fed: "美联储", wallstreetcn: "华尔街" };
            return map[src] || src || "资讯";
        }
        function parseMaybeJson(v) {
            if (v == null) return null;
            if (Array.isArray(v)) return v;
            if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
            return null;
        }
        function formatNewsTime(ts) {
            if (!ts) return "";
            const t = new Date(ts);
            if (isNaN(t.getTime())) return String(ts);
            const now = new Date();
            const diff = Math.floor((now - t) / 1000);
            if (diff < 60) return "刚刚";
            if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
            return `${t.getMonth() + 1}月${t.getDate()}日`;
        }
        function formatEventDate(dateStr) {
            const d = new Date(dateStr + "T00:00:00");
            if (isNaN(d.getTime())) return dateStr;
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const diffDays = Math.round((d - today) / 86400000);
            if (diffDays === 0) return "今天";
            if (diffDays === 1) return "明天";
            if (diffDays === 2) return "后天";
            return `${d.getMonth() + 1}月${d.getDate()}日`;
        }

        // --- 关键词管理面板（独立组件） ---
        function KeywordManagerPanel({ onDone }) {
            const [keywords, setKeywords] = useState([]);
            const [suggestions, setSuggestions] = useState([]);
            const [loading, setLoading] = useState(false);
            const [sugLoading, setSugLoading] = useState(false);
            const [activeTab, setActiveTab] = useState("list");
            const [newKeyword, setNewKeyword] = useState("");
            const [newCategory, setNewCategory] = useState("自定义");
            const [newImportance, setNewImportance] = useState(70);
            const [evoStats, setEvoStats] = useState(null);

            const loadKeywords = useCallback(async () => {
                setLoading(true);
                try { setKeywords(await api("/api/sentiment/keywords")); } catch (e) { console.error(e); }
                setLoading(false);
            }, []);
            const loadEvoStats = useCallback(async () => {
                try { setEvoStats(await api("/api/evolution/status")); } catch (e) { /* 静默 */ }
            }, []);
            const loadSuggestions = useCallback(async () => {
                setSugLoading(true);
                try { setSuggestions(await api("/api/sentiment/keywords/suggestions?days=30")); } catch (e) { console.error(e); }
                setSugLoading(false);
            }, []);
            useEffect(() => { loadKeywords(); loadEvoStats(); }, [loadKeywords, loadEvoStats]);

            const handleAdd = async () => {
                if (!newKeyword.trim()) return;
                try {
                    await post("/api/sentiment/keywords", {
                        keyword: newKeyword.trim(), category: newCategory, importance: Number(newImportance), notes: "",
                    });
                    setNewKeyword("");
                    loadKeywords();
                    if (onDone) onDone();
                } catch (e) { alert("添加失败: " + e.message); }
            };
            const handleDelete = async (id) => {
                try { await api(`/api/sentiment/keywords/${id}`, { method: "DELETE" }); loadKeywords(); }
                catch (e) { alert("删除失败: " + e.message); }
            };
            const handleAccept = async (s) => {
                try {
                    await post("/api/sentiment/keywords/suggestions/accept", {
                        keyword: s.keyword, suggested_importance: s.suggested_importance, category: "AI推荐",
                    });
                    setSuggestions(prev => prev.filter(x => x.keyword !== s.keyword));
                    loadKeywords();
                } catch (e) { alert("接受推荐失败: " + e.message); }
            };
            const handleReject = async (kw) => {
                try {
                    await api(`/api/sentiment/keywords/suggestions/reject?keyword=${encodeURIComponent(kw)}`, { method: "POST" });
                    setSuggestions(prev => prev.filter(x => x.keyword !== kw));
                } catch (e) { alert("拒绝失败: " + e.message); }
            };

            const confidenceBadge = (c) => c === "high" ? "🟢 高" : c === "medium" ? "🟡 中" : "⚪ 低";

            return React.createElement("div", { className: "dsh-stock-kw-panel" },
                evoStats && React.createElement("div", { className: "dsh-stock-evo-bar" },
                    React.createElement("span", { className: "dsh-stock-evo-item" }, "🧬 自动进化"),
                    React.createElement("span", { className: "dsh-stock-evo-item" }, `历史样本 ${evoStats.impact_samples ?? 0}`),
                    React.createElement("span", { className: "dsh-stock-evo-item" },
                        `预测准确率 ${evoStats.prediction_stats && evoStats.prediction_stats.accuracy != null ? evoStats.prediction_stats.accuracy + "%" : "待积累"}`),
                    evoStats.learn && evoStats.learn.auto_accepted && evoStats.learn.auto_accepted.length > 0 &&
                        React.createElement("span", { className: "dsh-stock-evo-item" },
                            `已学词 ${evoStats.learn.auto_accepted.length}: ${evoStats.learn.auto_accepted.slice(0, 3).join("、")}`),
                    React.createElement("button", {
                        className: "dsh-stock-evo-run",
                        title: "立即执行：拉取百度真实日历 + 事件回填 + 关键词学习",
                        onClick: async () => {
                            try {
                                await api("/api/evolution/run?task=calendar", { method: "POST" });
                                await api("/api/evolution/run?task=learn", { method: "POST" });
                                loadEvoStats(); loadKeywords();
                                if (onDone) onDone();
                            } catch (e) { alert("执行失败: " + e.message); }
                        },
                    }, "⚡ 立即进化")),
                React.createElement("div", { className: "dsh-stock-kw-tabs" },
                    React.createElement("button", { className: activeTab === "list" ? "active" : "", onClick: () => setActiveTab("list") }, `我的关键词 (${keywords.length})`),
                    React.createElement("button", { className: activeTab === "sug" ? "active" : "", onClick: () => { setActiveTab("sug"); loadSuggestions(); } }, "🤖 AI推荐")),

                activeTab === "list" && React.createElement("div", { className: "dsh-stock-kw-add" },
                    React.createElement("input", { value: newKeyword, onChange: e => setNewKeyword(e.target.value), placeholder: "输入关键词，如：降息、宁德时代、集采" }),
                    React.createElement("input", { className: "dsh-stock-kw-cat", value: newCategory, onChange: e => setNewCategory(e.target.value), placeholder: "分类" }),
                    React.createElement("input", { className: "dsh-stock-kw-imp", type: "number", min: 0, max: 100, value: newImportance, onChange: e => setNewImportance(e.target.value) }),
                    React.createElement("button", { className: "dsh-stock-kw-add-btn", onClick: handleAdd }, "＋ 添加")),

                activeTab === "list" && (loading
                    ? React.createElement("div", { className: "dsh-stock-loading" }, "加载中...")
                    : keywords.length === 0
                        ? React.createElement("div", { className: "dsh-stock-empty-inline" }, "暂无自定义关键词，添加后舆情监控会优先匹配推送")
                        : React.createElement("div", { className: "dsh-stock-kw-list" },
                            keywords.map(kw => React.createElement("div", { key: kw.id, className: "dsh-stock-kw-item" },
                                React.createElement("span", { className: "dsh-stock-kw-word" }, kw.keyword),
                                React.createElement("span", { className: "dsh-stock-kw-meta" }, `${kw.category || "自定义"} · 重要度${kw.importance}`),
                                React.createElement("button", { className: "dsh-stock-kw-del", onClick: () => handleDelete(kw.id) }, "✕"))))),

                activeTab === "sug" && (sugLoading
                    ? React.createElement("div", { className: "dsh-stock-loading" }, "分析历史舆情中...")
                    : suggestions.length === 0
                        ? React.createElement("div", { className: "dsh-stock-empty-inline" },
                            "暂无推荐。系统会分析高影响力新闻中的高频新词，积累数据后自动推荐")
                        : React.createElement("div", { className: "dsh-stock-kw-list" },
                            suggestions.map(s => React.createElement("div", { key: s.keyword, className: "dsh-stock-kw-item" },
                                React.createElement("div", { className: "dsh-stock-kw-sug-main" },
                                    React.createElement("span", { className: "dsh-stock-kw-word" }, s.keyword),
                                    React.createElement("span", { className: "dsh-stock-kw-meta" }, `建议重要度 ${s.suggested_importance} · 置信度 ${confidenceBadge(s.confidence)}`),
                                    s.reasoning && React.createElement("div", { className: "dsh-stock-kw-reason" }, s.reasoning)),
                                React.createElement("div", { className: "dsh-stock-kw-sug-btns" },
                                    React.createElement("button", { className: "dsh-stock-kw-accept", onClick: () => handleAccept(s) }, "✓ 接受"),
                                    React.createElement("button", { className: "dsh-stock-kw-del", onClick: () => handleReject(s.keyword) }, "✗"))))))
            );
        }

        // --- 投资建议弹窗（独立组件） ---
        function AdviceModal({ newsId, onClose, openStock }) {
            const [loading, setLoading] = useState(true);
            const [advice, setAdvice] = useState(null);
            const [err, setErr] = useState(null);

            useEffect(() => {
                const run = async () => {
                    try {
                        const data = await api("/api/sentiment/investment-advice?news_id=" + encodeURIComponent(newsId) + "&include_stocks=true", { method: "POST" });
                        setAdvice(data);
                    } catch (e) { setErr(e.message); }
                    setLoading(false);
                };
                run();
            }, [newsId]);

            const dirText = (d) => d === "positive" ? "📈 利好" : d === "negative" ? "📉 利空" : "📊 中性";
            const stockName = (s) => s.stock_name || s.name || "";
            const stockCode = (s) => s.stock_code || s.code || "";
            const pctText = (p) => p == null ? "" : (p >= 0 ? "+" : "") + Number(p).toFixed(1) + "%";
            const pctCls = (p) => p >= 0 ? "up" : "down";

            const head = React.createElement("div", { className: "dsh-stock-adv-head" },
                React.createElement("span", null, "💡 投资建议分析"),
                React.createElement("button", { className: "dsh-stock-adv-close", onClick: onClose }, "✕"));

            if (loading || err) {
                return React.createElement("div", { className: "dsh-stock-adv-overlay", onClick: onClose },
                    React.createElement("div", { className: "dsh-stock-adv-content", onClick: (e) => e.stopPropagation() },
                        head,
                        loading && React.createElement("div", { className: "dsh-stock-loading" }, "分析舆情关联中..."),
                        err && React.createElement("div", { className: "dsh-stock-error" }, "分析失败: " + err)));
            }
            if (!advice) return null;

            const s = advice.sentiment || {};
            const adv = advice.investment_advice || {};
            const impact = adv.impact_analysis || {};
            const confText = impact.confidence === "high" ? "高" : impact.confidence === "low" ? "低" : "中";
            const dirText2 = (d) => d === "positive" ? "📈 整体利好" : d === "negative" ? "📉 整体利空" : "📊 影响中性";

            // 板块（含实时数据）
            const sectorNodes = [];
            (advice.related_sectors || []).forEach((sec, si) => {
                const boards = sec.real_boards && sec.real_boards.length > 0 ? sec.real_boards : [{ name: sec.sector_name }];
                boards.forEach((rb, bi) => {
                    const kids = [];
                    kids.push(React.createElement("span", { key: "n", className: "dsh-stock-advice-sector-name" }, rb.name || sec.sector_name));
                    kids.push(React.createElement("span", { key: "d", className: "dsh-stock-advice-sector-dir" }, dirText(sec.impact)));
                    if (rb.change_pct != null) {
                        kids.push(React.createElement("span", { key: "c", className: "dsh-stock-adv-pct " + pctCls(rb.change_pct) }, "今日" + pctText(rb.change_pct)));
                    }
                    if (rb.momentum_5d != null) {
                        kids.push(React.createElement("span", { key: "m", className: "dsh-stock-adv-mom" }, "5日" + pctText(rb.momentum_5d)));
                    }
                    if (rb.stage && rb.stage !== "未知") {
                        kids.push(React.createElement("span", { key: "s", className: "dsh-stock-adv-stage" }, rb.stage));
                    }
                    if (sec.reasoning) {
                        kids.push(React.createElement("div", { key: "r", className: "dsh-stock-advice-sector-reason" }, sec.reasoning));
                    }
                    sectorNodes.push(React.createElement("div", { key: si + "-" + bi, className: "dsh-stock-advice-sector " + (sec.impact || "") }, kids));
                });
            });

            // 推荐龙头
            const leaderNodes = (adv.recommended_stocks || []).map((ls, i) => {
                const kids = [];
                kids.push(React.createElement("span", { key: "n", className: "dsh-stock-adv-leader-name" }, ls.name));
                kids.push(React.createElement("span", { key: "c", className: "dsh-stock-adv-leader-code" }, ls.code));
                if (ls.change_pct != null) {
                    kids.push(React.createElement("span", { key: "p", className: "dsh-stock-adv-leader-pct " + pctCls(ls.change_pct) }, pctText(ls.change_pct)));
                }
                if (ls.is_leader) {
                    kids.push(React.createElement("span", { key: "t", className: "dsh-stock-adv-leader-tag" }, "龙头"));
                }
                (ls.reasons || []).filter((r) => r.indexOf("今日") !== 0).slice(0, 2).forEach((r, ri) => {
                    kids.push(React.createElement("span", { key: "r" + ri, className: "dsh-stock-adv-leader-reason" }, r));
                });
                return React.createElement("div", {
                    key: i,
                    className: "dsh-stock-adv-leader",
                    onClick: () => openStock && openStock({ code: ls.code, name: ls.name }),
                }, kids);
            });

            // 舆情提及个股
            const mentionNodes = (advice.related_stocks || []).slice(0, 6).map((ms, i) =>
                React.createElement("span", {
                    key: i,
                    className: "dsh-stock-stock-tag",
                    onClick: () => openStock && openStock({ code: stockCode(ms), name: stockName(ms) }),
                }, stockName(ms) + " (" + stockCode(ms) + ")"));

            // 影响分析与操作建议
            const tipNodes = [];
            tipNodes.push(React.createElement("div", { key: "imp", className: "dsh-stock-advice-tip" },
                React.createElement("div", { className: "dsh-stock-advice-tip-text" },
                    dirText2(impact.overall_impact) + "（置信度: " + confText + "）" + (impact.description ? " — " + impact.description : ""))));
            if (adv.operation_advice) {
                tipNodes.push(React.createElement("div", { key: "op", className: "dsh-stock-advice-tip" },
                    React.createElement("div", { className: "dsh-stock-advice-tip-stock" }, "📝 操作建议"),
                    React.createElement("div", { className: "dsh-stock-advice-tip-text" }, adv.operation_advice)));
            }
            (adv.risk_warnings || []).forEach((w, i) => {
                tipNodes.push(React.createElement("div", { key: "rk" + i, className: "dsh-stock-advice-tip-text" }, "⚠️ " + w));
            });

            const body = React.createElement("div", { className: "dsh-stock-adv-body" },
                React.createElement("div", { className: "dsh-stock-advice-sec" },
                    React.createElement("div", { className: "dsh-stock-advice-sec-title" }, "📰 舆情"),
                    React.createElement("div", { className: "dsh-stock-advice-news-title" }, s.title || ""),
                    React.createElement("div", { className: "dsh-stock-advice-news-meta" },
                        newsImportanceStars(s.importance_score) + " " + Math.round(s.importance_score || 0) + "分 · " +
                        newsSentimentIcon(s.sentiment_tag) + " " + dirText(s.sentiment_tag))),
                sectorNodes.length > 0 && React.createElement("div", { className: "dsh-stock-advice-sec" },
                    React.createElement("div", { className: "dsh-stock-advice-sec-title" }, "🧩 相关板块（实时）"),
                    sectorNodes),
                leaderNodes.length > 0 && React.createElement("div", { className: "dsh-stock-advice-sec" },
                    React.createElement("div", { className: "dsh-stock-advice-sec-title" }, "🎯 推荐龙头（点击看K线）"),
                    leaderNodes),
                mentionNodes.length > 0 && React.createElement("div", { className: "dsh-stock-advice-sec" },
                    React.createElement("div", { className: "dsh-stock-advice-sec-title" }, "📈 舆情提及个股"),
                    mentionNodes),
                React.createElement("div", { className: "dsh-stock-advice-sec" },
                    React.createElement("div", { className: "dsh-stock-advice-sec-title" }, "💡 影响分析与操作建议"),
                    tipNodes));

            return React.createElement("div", { className: "dsh-stock-adv-overlay", onClick: onClose },
                React.createElement("div", { className: "dsh-stock-adv-content", onClick: (e) => e.stopPropagation() },
                    head,
                    body));
        }

        // --- 舆情主Tab ---
        function NewsTab({ openStock }) {
            const [cnNews, setCnNews] = useState([]);
            const [usNews, setUsNews] = useState([]);
            const [loading, setLoading] = useState(true);
            const [error, setError] = useState(null);
            const [filter, setFilter] = useState("all");
            const [liveNews, setLiveNews] = useState([]);
            const [showKw, setShowKw] = useState(false);
            const [calView, setCalView] = useState(false);
            const [calEvents, setCalEvents] = useState([]);
            const [calLoading, setCalLoading] = useState(false);
            const [adviceNewsId, setAdviceNewsId] = useState(null);

            const load = useCallback(async () => {
                setLoading(true); setError(null);
                try {
                    const [cn, us] = await Promise.all([
                        api("/api/sentiment/cn?limit=20").catch(() => []),
                        api("/api/sentiment/us?limit=20").catch(() => []),
                    ]);
                    setCnNews(Array.isArray(cn) ? cn : []);
                    setUsNews(Array.isArray(us) ? us : []);
                } catch (e) { setError(e.message); }
                setLoading(false);
            }, []);
            useEffect(() => { load(); }, [load]);

            // 事件日历
            const loadCalendar = useCallback(async () => {
                setCalLoading(true);
                try {
                    const data = await api("/api/calendar/upcoming?days=30");
                    const groups = Object.entries(data || {})
                        .map(([date, events]) => ({ date, events }))
                        .sort((a, b) => a.date.localeCompare(b.date));
                    setCalEvents(groups);
                } catch (e) { console.error("日历加载失败:", e); setCalEvents([]); }
                setCalLoading(false);
            }, []);
            useEffect(() => { if (calView) loadCalendar(); }, [calView, loadCalendar]);

            const generateCalendar = async () => {
                setCalLoading(true);
                try {
                    // 优先拉取百度真实日历（含预期/前值），再补规则库长期事件
                    await api("/api/calendar/fetch?days=30", { method: "POST" });
                    await api("/api/calendar/generate?months=3", { method: "POST" });
                    await loadCalendar();
                }
                catch (e) { alert("拉取日历失败: " + e.message); setCalLoading(false); }
            };

            // WebSocket 实时舆情推送
            useEffect(() => {
                let ws = null;
                try {
                    ws = new WebSocket(PLUGIN_API_BASE.replace("http", "ws") + "/ws");
                    ws.onmessage = (evt) => {
                        try {
                            const msg = JSON.parse(evt.data);
                            if (msg.type === "sentiment_news" && Array.isArray(msg.data)) {
                                setLiveNews(prev => [...msg.data, ...prev].slice(0, 10));
                                load();
                            }
                        } catch { /* ignore */ }
                    };
                } catch { /* ignore */ }
                return () => { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); };
            }, [load]);

            const displayNews = filter === "all" ? [...cnNews, ...usNews] : (filter === "cn" ? cnNews : usNews);
            const sortedNews = [...displayNews].sort((a, b) => (b.importance_score || 0) - (a.importance_score || 0));

            const todayStr = new Date().toISOString().slice(0, 10);

            const renderNewsItem = (news, idx) => {
                const sectors = parseMaybeJson(news.related_sectors) || [];
                const stocks = parseMaybeJson(news.related_stocks) || [];
                // 点击埋点：用户偏好学习（后台静默，不打扰）
                const reportClick = () => {
                    api(`/api/user/click/record?sentiment_id=${encodeURIComponent(String(news.id))}&click_type=view`, { method: "POST" }).catch(() => {});
                };
                return React.createElement("div", {
                    key: news.id || idx,
                    className: `dsh-stock-news-item ${news.sentiment_tag || ""}`,
                    onClick: reportClick,
                },
                    React.createElement("div", { className: "dsh-stock-news-item-head" },
                        React.createElement("span", { className: "dsh-stock-news-item-src" },
                            `${newsSentimentIcon(news.sentiment_tag)} ${newsSourceName(news.source)}${news.country === "us" ? " 🇺🇸" : " 🇨🇳"}`),
                        React.createElement("span", { className: "dsh-stock-news-item-time" }, formatNewsTime(news.published_at)),
                        React.createElement("span", { className: "dsh-stock-news-item-imp" },
                            `${newsImportanceStars(news.importance_score)} ${Math.round(news.importance_score || 0)}`)),
                    React.createElement("div", { className: "dsh-stock-news-item-title" }, news.title),
                    news.content && React.createElement("div", { className: "dsh-stock-news-item-content" }, news.content),
                    news.url && React.createElement("a", { href: news.url, target: "_blank", rel: "noopener noreferrer", className: "dsh-stock-news-item-link" }, "查看原文 →"),
                    sectors.length > 0 && React.createElement("div", { className: "dsh-stock-news-tags" },
                        React.createElement("span", { className: "dsh-stock-news-tags-label" }, "🧩 板块:"),
                        sectors.slice(0, 5).map((sec, i) => React.createElement("span", {
                            key: i,
                            className: `dsh-stock-sector-tag ${sec.impact || ""}`,
                            title: sec.reasoning || "",
                        }, sec.sector_name))),
                    stocks.length > 0 && React.createElement("div", { className: "dsh-stock-news-tags" },
                        React.createElement("span", { className: "dsh-stock-news-tags-label" }, "📈 个股:"),
                        stocks.slice(0, 5).map((s, i) => React.createElement("span", {
                            key: i,
                            className: "dsh-stock-stock-tag",
                            onClick: () => openStock && openStock({ code: s.stock_code || s.code, name: s.stock_name || s.name }),
                            style: { cursor: "pointer" },
                        }, s.stock_name || s.name))),
                    (news.importance_score || 0) >= 75 && React.createElement("button", {
                        className: "dsh-stock-advice-btn",
                        onClick: () => setAdviceNewsId(String(news.id)),
                    }, "💡 投资建议"));
            };

            const renderCalendarDay = (group) => {
                const isToday = group.date === todayStr;
                const diffDays = Math.round((new Date(group.date + "T00:00:00") - new Date(todayStr + "T00:00:00")) / 86400000);
                const flagOf = (c) => c === "us" ? "🇺🇸" : c === "cn" ? "🇨🇳" : c === "eu" ? "🇪🇺" : c === "jp" ? "🇯🇵" : "🌍";
                return React.createElement("div", { key: group.date, className: `dsh-stock-cal-day ${isToday ? "today" : ""}` },
                    React.createElement("div", { className: "dsh-stock-cal-date" },
                        `${formatEventDate(group.date)}`,
                        diffDays >= 0 && diffDays <= 3 && diffDays > 0 && React.createElement("span", { className: "dsh-stock-cal-urgent" }, ` ⚡${diffDays}天后`)),
                    React.createElement("div", { className: "dsh-stock-cal-events" },
                        group.events.map((ev, i) => {
                            const evSectors = parseMaybeJson(ev.related_sectors) || [];
                            return React.createElement("div", { key: i, className: "dsh-stock-cal-event" },
                                React.createElement("span", { className: "dsh-stock-cal-event-imp" }, newsImportanceStars(ev.importance_score || ev.importance || 60)),
                                React.createElement("span", { className: "dsh-stock-cal-event-name" },
                                    `${ev.event_time && ev.event_time !== "00:00" ? ev.event_time + " " : ""}${ev.event_name || ev.name}`,
                                    ev.is_estimated == 1 && React.createElement("span", { className: "dsh-stock-cal-est", title: "规则推算日期，真实日期以官方/百度日历为准" }, "预计"),
                                    ev.source === "baidu" && React.createElement("span", { className: "dsh-stock-cal-src" }, "实时")),
                                ev.description && React.createElement("span", { className: "dsh-stock-cal-desc" }, ev.description),
                                evSectors.length > 0 && React.createElement("span", { className: "dsh-stock-cal-secs" },
                                    evSectors.slice(0, 3).map((s, si) => React.createElement("span", { key: si, className: "dsh-stock-cal-sec-tag" }, s.sector_name))),
                                React.createElement("span", { className: "dsh-stock-cal-event-country" }, flagOf(ev.country)));
                        })));
            };

            return React.createElement("div", { className: "dsh-stock-tab-body" },

                React.createElement("div", { className: "dsh-stock-news-toolbar" },
                    React.createElement("div", { className: "dsh-stock-news-filter" },
                        React.createElement("button", { className: filter === "all" ? "active" : "", onClick: () => setFilter("all") }, "全部"),
                        React.createElement("button", { className: filter === "cn" ? "active" : "", onClick: () => setFilter("cn") }, "🇨🇳 国内"),
                        React.createElement("button", { className: filter === "us" ? "active" : "", onClick: () => setFilter("us") }, "🇺🇸 美国")),
                    React.createElement("button", { className: calView ? "active" : "", onClick: () => setCalView(!calView) }, "📅 事件日历"),
                    React.createElement("button", { className: showKw ? "active" : "", onClick: () => setShowKw(!showKw) }, "🔑 关键词"),
                    React.createElement("button", { onClick: load }, "🔄 刷新")),

                showKw && React.createElement(KeywordManagerPanel, { onDone: load }),

                liveNews.length > 0 && React.createElement("div", { className: "dsh-stock-live-box" },
                    React.createElement("div", { className: "dsh-stock-live-title" }, `⚡ 实时推送 (${liveNews.length})`),
                    liveNews.slice(0, 3).map((n, i) => React.createElement("div", { key: i, className: "dsh-stock-live-item" },
                        React.createElement("span", { className: "dsh-stock-live-imp" }, newsImportanceStars(n.importance_score)),
                        React.createElement("span", { className: "dsh-stock-live-item-title" }, n.title),
                        React.createElement("span", { className: "dsh-stock-live-time" }, formatNewsTime(n.published_at))))),

                calView && React.createElement("div", { className: "dsh-stock-cal-panel" },
                    React.createElement("div", { className: "dsh-stock-cal-head" },
                        React.createElement("span", null, "📅 未来30天重要事件"),
                        React.createElement("button", { className: "dsh-stock-cal-gen", onClick: generateCalendar, disabled: calLoading }, "⚡ 生成未来事件")),
                    calLoading
                        ? React.createElement("div", { className: "dsh-stock-loading" }, "加载日历...")
                        : calEvents.length === 0
                            ? React.createElement("div", { className: "dsh-stock-empty-inline" }, "暂无日历数据，点击「生成未来事件」按规则库生成（非农/CPI/FOMC等）")
                            : React.createElement("div", { className: "dsh-stock-cal-list" }, calEvents.map(renderCalendarDay))),

                loading && React.createElement("div", { className: "dsh-stock-loading" }, "加载舆情数据中..."),
                error && React.createElement("div", { className: "dsh-stock-error" }, `错误: ${error}`),

                !loading && !error && React.createElement("div", { className: "dsh-stock-news-list" },
                    sortedNews.length === 0
                        ? React.createElement("div", { className: "dsh-stock-empty" },
                            "暂无舆情数据。后端每 5 分钟自动抓取一次中美重要新闻，",
                            React.createElement("br"),
                            "可通过「🔑 关键词」添加关注词提高命中率")
                        : sortedNews.map(renderNewsItem)),

                !loading && !error && React.createElement("div", { className: "dsh-stock-news-footer" },
                    `🇨🇳 ${cnNews.length} 条 · 🇺🇸 ${usNews.length} 条 · ⭐高分 ${[...cnNews, ...usNews].filter(n => (n.importance_score || 0) >= 80).length} 条`),

                adviceNewsId && React.createElement(AdviceModal, { newsId: adviceNewsId, onClose: () => setAdviceNewsId(null), openStock })
            );
        }

        // ============= Tab 8: 系统 =============
        function SystemTab() {
            const [status, setStatus] = useState(null);
            const [probe, setProbe] = useState(null);
            const [probing, setProbing] = useState(false);
            const [reconnecting, setReconnecting] = useState(false);
            const [restarting, setRestarting] = useState(false);
            const [logs, setLogs] = useState([]);
            const [logLevel, setLogLevel] = useState("INFO");
            const [configData, setConfigData] = useState(null);
            const [cfgForm, setCfgForm] = useState(null);
            const [cfgMsg, setCfgMsg] = useState(null);
            const [dirInput, setDirInput] = useState("");
            const [error, setError] = useState(null);

            const loadStatus = useCallback(async () => {
                try { setStatus(await api("/api/system/status")); setError(null); } catch (e) { setError(e.message); }
            }, []);
            usePolling(loadStatus, 10000, []);

            const loadCfg = useCallback(async () => {
                try {
                    const c = await api("/api/system/config");
                    setConfigData(c);
                    setCfgForm({
                        custom_tdx_hosts: (c.custom_tdx_hosts || []).join("\n"),
                        alert_interval: c.alert_interval,
                        alert_cooldown: c.alert_cooldown,
                        warm_interval: c.warm_interval,
                        tdx_install_dir: c.tdx_install_dir || "",
                        tdx_username: c.tdx_username || "",
                        tdx_password: c.tdx_password || "",
                    });
                    setDirInput(c.data_dir || "");
                } catch (e) { setError(e.message); }
            }, []);
            useEffect(() => { loadCfg(); }, []);
            const loadLogs = useCallback(async () => {
                try {
                    const d = await api(`/api/system/logs?level=${logLevel}&limit=200`);
                    setLogs(d.logs || []);
                } catch { /* ignore */ }
            }, [logLevel]);
            usePolling(loadLogs, 15000, [logLevel]);

            const doProbe = async () => {
                setProbing(true); setProbe(null);
                try { setProbe(await api("/api/system/tdx-probe")); }
                catch (e) { setError(e.message); }
                setProbing(false);
            };
            const doReconnect = async () => {
                setReconnecting(true);
                try { await post("/api/system/tdx-reconnect", {}); loadStatus(); }
                catch (e) { setError(e.message); }
                setReconnecting(false);
            };
            const doRestart = async () => {
                if (!window.confirm("确认重启股票后端？约3-5秒后自动恢复。")) return;
                setRestarting(true);
                try { await post("/api/system/restart", {}); } catch { /* 进程退出导致请求中断，忽略 */ }
                // 等待新进程起来
                setTimeout(() => { setRestarting(false); loadStatus(); loadCfg(); }, 5000);
            };
            const saveCfg = async () => {
                setCfgMsg(null);
                try {
                    const hosts = (cfgForm.custom_tdx_hosts || "").split("\n").map(s => s.trim()).filter(Boolean);
                    const r = await put("/api/system/config", {
                        custom_tdx_hosts: hosts,
                        alert_interval: Number(cfgForm.alert_interval),
                        alert_cooldown: Number(cfgForm.alert_cooldown),
                        warm_interval: Number(cfgForm.warm_interval),
                        tdx_install_dir: (cfgForm.tdx_install_dir || "").trim(),
                        tdx_username: (cfgForm.tdx_username || "").trim(),
                        tdx_password: cfgForm.tdx_password || "",
                    });
                    setConfigData(r.config);
                    setCfgMsg("✓ 配置已保存并生效");
                } catch (e) { setCfgMsg(`✗ 保存失败: ${e.message}`); }
            };
            const tdxClientUpdate = async () => {
                setCfgMsg("启动客户端中…");
                try {
                    const r = await post("/api/system/tdx-client-update", {});
                    setCfgMsg((r.ok ? "🚀 " : "⚠️ ") + r.message);
                    setTimeout(loadStatus, 3000);
                } catch (e) { setCfgMsg(`✗ 启动失败: ${e.message}`); }
            };
            const migrateDir = async () => {
                if (!dirInput || !window.confirm(
                    `确认切换数据目录到？\n${dirInput}\n\n将复制持仓/资金/配置/K线库到新目录（同名文件不覆盖），之后所有数据保存在新目录。`)) return;
                setCfgMsg("迁移中…");
                try {
                    const r = await put("/api/system/config", { data_dir: dirInput });
                    setCfgMsg(`✓ ${r.data_dir_result.message}（复制: ${(r.data_dir_result.copied || []).join("、") || "无"}）`);
                    loadStatus(); loadCfg();
                } catch (e) { setCfgMsg(`✗ 迁移失败: ${e.message}`); }
            };

            const up = (s) => s ? Math.floor(s / 60) + "分钟" : "-";
            const fmtBytes = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.round(n / 1024) + "KB";
            const pool = status && status.market_pool;

            return React.createElement("div", { className: "dsh-stock-tab-body" },
                React.createElement(TabHead, { title: "⚙️ 系统管理", onRefresh: loadStatus, refreshing: false }),
                React.createElement(ErrorBox, { error }),
                restarting && React.createElement("div", { className: "dsh-stock-error-box" }, "⟳ 后端重启中，约3-5秒后自动恢复…"),

                // 后端不可达时的降级卡：设置项虽然拉不到，但要告诉用户会自动恢复，
                // 且不再让"重启后端"按钮跟着 status 卡片一起消失（死循环）
                !status && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "🚑 后端未运行"),
                    React.createElement("div", { className: "dsh-stock-detail" },
                        "后端进程当前不可达（可能冷开机首次启动超时被杀，或刚崩溃）。",
                        React.createElement("br"),
                        "插件宿主每 20 秒自动探测并重新拉起，通常 1 分钟内自愈，无需重启 DSH；",
                        React.createElement("br"),
                        "恢复后本页设置会自动出现。若超过 3 分钟仍未恢复，请重启 DSH 或手动在终端执行：",
                        React.createElement("br"),
                        React.createElement("code", null, "python -m uvicorn main:app --port 8765（cwd=插件 backend 目录）"))),

                status && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "📊 运行状态"),
                    React.createElement("div", { className: "dsh-stock-sys-grid" },
                        [
                            ["插件版本", status.plugin_version],
                            ["运行时长", up(status.uptime_sec)],
                            ["通达信", status.tdx.connected ? `✓ 已连接 ${status.tdx.current_host}` : "✗ 未连接"],
                            ["预热池", pool ? `${pool.warmed}/${pool.total} 只${pool.warming ? " · 预热中" : ""}` : "-"],
                            ["K线库", pool && pool.db_rows ? `${pool.db_rows} 行 (${fmtBytes((status.data_dir.files.find(f => f.name === "market.db") || {}).size || 0)})` : "空"],
                            ["K线源", pool ? (pool.alt_source === "tencent" ? "腾讯(备源)" : "东财(主源)") : "-"],
                        ].map(([k, v], i) =>
                            React.createElement("div", { key: i, className: "dsh-stock-sys-item" },
                                React.createElement("span", { className: "label" }, k),
                                React.createElement("span", { className: "value" }, v)))),
                    status.tdx_local && status.tdx_local.available && React.createElement("div", { className: "dsh-stock-detail" },
                        `💾 本地通达信数据: ${status.tdx_local.sh_count + status.tdx_local.sz_count} 只日线 · 最新 ${status.tdx_local.latest_date}` +
                        (status.tdx_local.up_to_date ? "（当日✓）" : "（非当日，可点击下方按钮更新）") +
                        (status.tdx_client_running ? " · 客户端运行中" : "")),
                    React.createElement("div", { className: "dsh-stock-form-row" },
                        React.createElement("button", { className: "dsh-stock-btn sm", disabled: reconnecting, onClick: doReconnect },
                            reconnecting ? "重连中…" : "🔄 重连通达信"),
                        React.createElement("button", { className: "dsh-stock-btn sm ghost", disabled: probing, onClick: doProbe },
                            probing ? "体检中…" : "🩺 服务器体检"),
                        React.createElement("button", { className: "dsh-stock-btn sm ghost", disabled: restarting, onClick: tdxClientUpdate },
                            "💾 启动通达信更新数据"),
                        React.createElement("button", { className: "dsh-stock-btn sm danger", disabled: restarting, onClick: doRestart }, "⚡ 重启后端"))),

                probe && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" },
                        "🩺 通达信服务器体检",
                        React.createElement("span", { className: "dsh-stock-badge" },
                            `${probe.ok_count}/${probe.total} 可用${probe.best ? ` · 最快 ${probe.best.host}(${probe.best.latency_ms}ms)` : ""}`)),
                    React.createElement("div", { className: "dsh-stock-probe-list" },
                        probe.results.map((r, i) =>
                            React.createElement("div", { key: i, className: `dsh-stock-probe-row ${r.status}` },
                                React.createElement("span", { className: "host" }, r.host),
                                React.createElement("span", { className: "status" }, PROBE_STATUS[r.status] || r.status),
                                React.createElement("span", { className: "ms" }, r.latency_ms + "ms"))))),

                cfgForm && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "🗂 数据目录"),
                    React.createElement("div", { className: "dsh-stock-detail" },
                        `当前: ${configData.data_dir}`,
                        (status.data_dir.files || []).filter(f => f.exists).map(f => ` · ${f.name} ${fmtBytes(f.size)}`).join("")),
                    React.createElement("div", { className: "dsh-stock-form-row" },
                        React.createElement("input", {
                            className: "dsh-stock-input", style: { flex: 1, minWidth: 220 },
                            placeholder: "新数据目录绝对路径，如 D:\\stock-data",
                            value: dirInput, onChange: (e) => setDirInput(e.target.value),
                        }),
                        React.createElement("button", { className: "dsh-stock-btn sm", onClick: migrateDir }, "保存并迁移数据")),
                    React.createElement("div", { className: "dsh-stock-form-hint" },
                        "持仓/资金/配置/K线库都保存在数据目录（插件升级不丢失）。切换时复制旧数据到新目录，同名文件不覆盖。")),

                cfgForm && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "💾 通达信本地数据源"),
                    React.createElement("label", { className: "dsh-stock-field" },
                        React.createElement("span", { className: "dsh-stock-field-label" }, "通达信安装目录（本地 vipdoc 数据优先使用，秒级载入全市场；留空自动探测常见位置）"),
                        React.createElement("input", {
                            className: "dsh-stock-input", style: { width: "100%" },
                            placeholder: "如 D:\\app\\tdx",
                            value: cfgForm.tdx_install_dir,
                            onChange: (e) => setCfgForm({ ...cfgForm, tdx_install_dir: e.target.value }),
                        })),
                    React.createElement("div", { className: "dsh-stock-form-grid" },
                        React.createElement("label", { className: "dsh-stock-field" },
                            React.createElement("span", { className: "dsh-stock-field-label" }, "客户端账号（可选，仅弹登录框时用）"),
                            React.createElement("input", {
                                className: "dsh-stock-input",
                                placeholder: "行情通常免登录",
                                value: cfgForm.tdx_username,
                                onChange: (e) => setCfgForm({ ...cfgForm, tdx_username: e.target.value }),
                            })),
                        React.createElement("label", { className: "dsh-stock-field" },
                            React.createElement("span", { className: "dsh-stock-field-label" }, "客户端密码（可选）"),
                            React.createElement("input", {
                                className: "dsh-stock-input", type: "password",
                                placeholder: "明文保存在本机，注意风险",
                                value: cfgForm.tdx_password,
                                onChange: (e) => setCfgForm({ ...cfgForm, tdx_password: e.target.value }),
                            }))),
                    React.createElement("div", { className: "dsh-stock-form-hint" },
                        "「启动通达信更新数据」= 启动客户端→尝试自动登录→尝试触发盘后下载→监测到新数据自动载入（30分钟）。自动触发失败时在客户端手动：系统→盘后数据下载（勾选日线+分钟线）。")),

                cfgForm && React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" }, "🔧 运行配置"),
                    React.createElement("label", { className: "dsh-stock-field" },
                        React.createElement("span", { className: "dsh-stock-field-label" }, "自定义通达信服务器（每行一个 ip:port，优先探测；留空用内置列表）"),
                        React.createElement("textarea", {
                            className: "dsh-stock-textarea",
                            placeholder: "如\n119.147.212.81:7709",
                            value: cfgForm.custom_tdx_hosts,
                            onChange: (e) => setCfgForm({ ...cfgForm, custom_tdx_hosts: e.target.value }),
                        })),
                    React.createElement("div", { className: "dsh-stock-form-grid" },
                        [["alert_interval", "预警检查间隔(秒)"], ["alert_cooldown", "预警冷却(秒)"], ["warm_interval", "预热间隔(秒)"]].map(([k, label]) =>
                            React.createElement("label", { key: k, className: "dsh-stock-field" },
                                React.createElement("span", { className: "dsh-stock-field-label" }, label),
                                React.createElement("input", {
                                    className: "dsh-stock-input",
                                    value: cfgForm[k],
                                    onChange: (e) => setCfgForm({ ...cfgForm, [k]: e.target.value }),
                                })))),
                    React.createElement("div", { className: "dsh-stock-form-row" },
                        React.createElement("button", { className: "dsh-stock-btn sm", onClick: saveCfg }, "保存配置"),
                        cfgMsg && React.createElement("span", { className: "dsh-stock-cfg-msg" }, cfgMsg))),

                React.createElement("div", { className: "dsh-stock-card" },
                    React.createElement("div", { className: "dsh-stock-card-title" },
                        "📜 运行日志",
                        React.createElement("select", {
                            className: "dsh-stock-select",
                            value: logLevel,
                            onChange: (e) => setLogLevel(e.target.value),
                        }, ["INFO", "WARNING", "ERROR"].map(l =>
                            React.createElement("option", { key: l, value: l }, l)))),
                    React.createElement("div", { className: "dsh-stock-logs" },
                        logs.length === 0
                            ? React.createElement("div", { className: "dsh-stock-empty-inline" }, "暂无日志")
                            : logs.slice().reverse().map((l, i) =>
                                React.createElement("div", { key: i, className: `dsh-stock-log-line ${l.level}` },
                                    React.createElement("span", { className: "t" }, l.time),
                                    React.createElement("span", { className: "lv" }, l.level),
                                    React.createElement("span", { className: "mod" }, l.module),
                                    React.createElement("span", { className: "txt" }, l.text)))),
                    React.createElement("div", { className: "dsh-stock-form-hint" }, "最近500条内存日志，15秒自动刷新；完整日志在 DSH 的 logs 目录")),
            );
        }

        // ============= 开盘啦 Tab（仿App结构：底部导航 + 功能模块页 + 下钻详情） =============

        const KPL_NAV = [
            { id: "home", label: "首页", icon: "🏠" },
            { id: "market", label: "行情", icon: "📈" },
            { id: "watchlist", label: "自选股", icon: "➕" },
            { id: "lhb", label: "龙虎榜", icon: "📊" },
            { id: "recommend", label: "推荐", icon: "👍" },
        ];
        const KPL_SECTORS = [
            { code: "801045", name: "医药" }, { code: "801723", name: "创新药" },
            { code: "801676", name: "地产链" }, { code: "801007", name: "房地产" },
            { code: "801159", name: "AI应用" }, { code: "801001", name: "芯片" },
            { code: "801722", name: "存储" }, { code: "801162", name: "通信" },
        ];

        /* ---- 通用小组件 ---- */

        function KplTrendChart({ trend, preclose, height }) {
            const ref = useRef(null);
            useEffect(() => {
                if (!ref.current || !trend || !trend.length || !preclose) return;
                const cv = ref.current;
                const W = cv.clientWidth || 600, H = height || 160;
                cv.width = W * 2; cv.height = H * 2;
                const ctx = cv.getContext("2d");
                ctx.scale(2, 2);
                const chartH = H * 0.72, volTop = chartH + 10, volH = H - volTop - 16;
                const prices = trend.map((t) => t[1]);
                const hi = Math.max(...prices, preclose), lo = Math.min(...prices, preclose);
                const pad = (hi - lo) * 0.1 || 1;
                const top = hi + pad, bot = lo - pad;
                const X = (i) => (i / Math.max(1, trend.length - 1)) * (W - 4) + 2;
                const Y = (p) => 4 + (top - p) / (top - bot) * (chartH - 8);
                // 昨收虚线
                ctx.strokeStyle = "#5a6478"; ctx.setLineDash([4, 3]); ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(0, Y(preclose)); ctx.lineTo(W, Y(preclose)); ctx.stroke();
                ctx.setLineDash([]);
                // 价格线
                const upTrend = prices[prices.length - 1] >= preclose;
                ctx.strokeStyle = upTrend ? "#e74c4c" : "#2ecc71"; ctx.lineWidth = 1.4;
                ctx.beginPath();
                trend.forEach((t, i) => { i ? ctx.lineTo(X(i), Y(t[1])) : ctx.moveTo(X(i), Y(t[1])); });
                ctx.stroke();
                // 均价线（如有第3列则用它，否则跳过）
                ctx.strokeStyle = "#f39c12"; ctx.lineWidth = 1; ctx.setLineDash([]);
                ctx.beginPath();
                let hasAvg = false;
                trend.forEach((t, i) => {
                    if (t[2]) { hasAvg = true; i ? ctx.lineTo(X(i), Y(t[2])) : ctx.moveTo(X(i), Y(t[2])); }
                    else { i ? ctx.lineTo(X(i), Y(t[1])) : ctx.moveTo(X(i), Y(t[1])); }
                });
                if (hasAvg) ctx.stroke(); else ctx.beginPath();
                ctx.lineWidth = 1;
                // 量柱
                const maxVol = Math.max(...trend.map((t) => t[4] || 0), 1);
                trend.forEach((t, i) => {
                    const v = t[4] || 0;
                    if (!v) return;
                    const bh = (v / maxVol) * volH;
                    ctx.fillStyle = t[1] >= (trend[i - 1] ? trend[i - 1][1] : preclose) ? "rgba(231,76,60,.5)" : "rgba(46,204,113,.5)";
                    ctx.fillRect(X(i) - 1, volTop + volH - bh, 2, bh);
                });
                // 时间轴
                ctx.fillStyle = "#7a8499"; ctx.font = "9px sans-serif";
                ctx.fillText("09:30", 2, H - 2);
                ctx.fillText("11:30/13:00", W / 2 - 28, H - 2);
                ctx.fillText("15:00", W - 32, H - 2);
                // 涨跌幅标注
                ctx.fillStyle = upTrend ? "#e74c4c" : "#2ecc71";
                ctx.fillText(`${((prices[prices.length - 1] / preclose - 1) * 100).toFixed(2)}%`, W - 42, Y(prices[prices.length - 1]) - 4);
            }, [trend, preclose, height]);
            return React.createElement("canvas", { ref, style: { width: "100%", height: (height || 160) + "px", display: "block" } });
        }

        function KplLadder({ asks, bids, totalAsk, totalBid }) {
            const fmtV = (v) => v >= 1e8 ? (v / 1e8).toFixed(2) + "亿" : v >= 1e4 ? (v / 1e4).toFixed(1) + "万" : String(v || 0);
            const row = (label, px, vol, color) =>
                React.createElement("div", { className: "kpl-ladder-row", key: label },
                    React.createElement("span", { className: "lbl" }, label),
                    React.createElement("span", { className: "px", style: { color } }, px ? px.toFixed(2) : "--"),
                    React.createElement("span", { className: "vol" }, fmtV(vol)));
            const askRows = asks.map((a, i) => row(`卖${asks.length - i}`, a.px, a.vol, "#2ecc71"));
            const bidRows = bids.map((b, i) => row(`买${i + 1}`, b.px, b.vol, "#e74c4c"));
            return React.createElement("div", { className: "kpl-ladder" },
                React.createElement("div", { className: "kpl-ladder-total sell" }, React.createElement("span", null, "总卖"), React.createElement("span", null, fmtV(totalAsk || 0))),
                ...askRows,
                React.createElement("div", { className: "kpl-ladder-sep" }),
                ...bidRows,
                React.createElement("div", { className: "kpl-ladder-total buy" }, React.createElement("span", null, "总买"), React.createElement("span", null, fmtV(totalBid || 0))));
        }

        /* ---- 页面头部（返回+标题+搜索） ---- */

        function KplPageHeader({ title, subtitle, onBack, onSearch, extra }) {
            return React.createElement("div", { className: "kpl-page-head" },
                React.createElement("button", { className: "kpl-head-back", onClick: onBack }, "◀"),
                React.createElement("div", { className: "kpl-head-center" },
                    React.createElement("span", { className: "t" }, title),
                    subtitle && React.createElement("span", { className: "c" }, subtitle)),
                extra,
                React.createElement("button", { className: "kpl-head-search", onClick: onSearch }, "🔍"));
        }

        /* ---- 登录卡（短信 / 密码 / 手动绑定 三模式） ---- */

        function KplBindCard({ onBound }) {
            const [mode, setMode] = useState("sms");
            const [phone, setPhone] = useState("");
            const [code, setCode] = useState("");
            const [account, setAccount] = useState("");
            const [password, setPassword] = useState("");
            const [remember, setRemember] = useState(true);
            const [uid, setUid] = useState(""); const [tok, setTok] = useState("");
            const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
            const [countdown, setCountdown] = useState(0);

            const tick = useRef(null);
            useEffect(() => {
                tick.current = setInterval(() => setCountdown(c => (c > 0 ? c - 1 : 0)), 1000);
                return () => clearInterval(tick.current);
            }, []);

            const doSendCode = async () => {
                if (!/^1\d{10}$/.test(phone.trim())) { setMsg("✗ 请输入正确的11位手机号"); return; }
                setBusy(true); setMsg(null);
                try {
                    const r = await post("/api/kpl/send-code", { phone: phone.trim() });
                    if (r.ok) { setMsg("✓ 验证码已发送，请查收短信"); setCountdown(60); }
                    else setMsg("✗ " + (r.error || "发送失败"));
                } catch (e) { setMsg("✗ " + e.message); }
                setBusy(false);
            };
            const doLoginSms = async () => {
                if (!/^1\d{10}$/.test(phone.trim())) { setMsg("✗ 手机号不正确"); return; }
                if (!code.trim()) { setMsg("✗ 请输入验证码"); return; }
                setBusy(true); setMsg(null);
                try {
                    const r = await post("/api/kpl/login-sms", { phone: phone.trim(), code: code.trim() });
                    if (r.ok) { setMsg("✓ 登录成功"); onBound(); }
                    else setMsg("✗ " + (r.error || "登录失败"));
                } catch (e) { setMsg("✗ " + e.message); }
                setBusy(false);
            };
            const doLoginPwd = async () => {
                if (!account.trim() || !password.trim()) { setMsg("✗ 请填写账号和密码"); return; }
                setBusy(true); setMsg(null);
                try {
                    const r = await post("/api/kpl/login-pwd", {
                        account: account.trim(), password: password, remember,
                    });
                    if (r.ok) { setMsg("✓ 登录成功"); onBound(); }
                    else setMsg("✗ " + (r.error || "登录失败"));
                } catch (e) { setMsg("✗ " + e.message); }
                setBusy(false);
            };
            const doBind = async () => {
                if (!uid.trim() || !tok.trim()) { setMsg("✗ 请填写"); return; }
                setBusy(true);
                try {
                    const s = await post("/api/kpl/bind", { user_id: uid.trim(), token: tok.trim() });
                    setMsg(s.logged_in ? "✓ 绑定成功" : "✗ Token 校验失败");
                    if (s.logged_in) onBound();
                } catch (e) { setMsg("✗ " + e.message); }
                setBusy(false);
            };

            const tabs = [["sms", "短信登录"], ["pwd", "密码登录"], ["bind", "手动绑定"]];
            return React.createElement("div", { className: "kpl-bind" },
                React.createElement("div", { className: "kpl-bind-h" }, "🔐 登录开盘啦账号"),
                React.createElement("div", { className: "kpl-bind-tabs" },
                    tabs.map(([id, label]) =>
                        React.createElement("div", {
                            key: id,
                            className: `kpl-bind-tab ${mode === id ? "on" : ""}`,
                            onClick: () => { setMode(id); setMsg(null); },
                        }, label))),
                mode === "sms" && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "kpl-bind-row" },
                        React.createElement("input", { className: "kpl-bind-in", placeholder: "手机号",
                            maxLength: 11, value: phone, onChange: e => setPhone(e.target.value) }),
                        React.createElement("button", {
                            className: "kpl-bind-btn ghost", disabled: busy || countdown > 0,
                            onClick: doSendCode,
                        }, countdown > 0 ? countdown + "s" : "获取验证码")),
                    React.createElement("input", { className: "kpl-bind-in", placeholder: "短信验证码",
                        maxLength: 6, value: code, onChange: e => setCode(e.target.value) }),
                    React.createElement("button", { className: "kpl-bind-btn", disabled: busy, onClick: doLoginSms },
                        busy ? "登录中…" : "登 录")),
                mode === "pwd" && React.createElement(React.Fragment, null,
                    React.createElement("input", { className: "kpl-bind-in", placeholder: "账号（手机号/用户名）",
                        value: account, onChange: e => setAccount(e.target.value) }),
                    React.createElement("input", { className: "kpl-bind-in", type: "password", placeholder: "密码",
                        value: password, onChange: e => setPassword(e.target.value) }),
                    React.createElement("label", { className: "kpl-bind-remember" },
                        React.createElement("input", { type: "checkbox", checked: remember,
                            onChange: e => setRemember(e.target.checked) }),
                        "记住密码（Token失效时自动重登；明文存本机配置）"),
                    React.createElement("button", { className: "kpl-bind-btn", disabled: busy, onClick: doLoginPwd },
                        busy ? "登录中…" : "登 录")),
                mode === "bind" && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "kpl-bind-d" }, "App登录后抓包获取 UserID+Token（约2个月有效）"),
                    React.createElement("input", { className: "kpl-bind-in", placeholder: "UserID", value: uid, onChange: e => setUid(e.target.value) }),
                    React.createElement("input", { className: "kpl-bind-in", placeholder: "Token", value: tok, onChange: e => setTok(e.target.value) }),
                    React.createElement("button", { className: "kpl-bind-btn", disabled: busy, onClick: doBind }, busy ? "…" : "绑定")),
                msg && React.createElement("div", { className: "kpl-bind-msg" }, msg));
        }

        /* ---- 底部导航 ---- */

        function KplBottomNav({ active, onChange }) {
            return React.createElement("div", { className: "kpl-bottom-nav" },
                KPL_NAV.map((n) =>
                    React.createElement("div", {
                        key: n.id, className: `kpl-nav-item ${active === n.id ? "on" : ""}`,
                        onClick: () => onChange(n.id),
                    }, React.createElement("span", { className: "ico" }, n.icon),
                       React.createElement("span", { className: "lbl" }, n.label))));
        }

        /* ---- 首页 ---- */

        // 首页数据 SWR 缓存（模块级）：切回开盘啦 Tab 秒显旧数据，后台静默刷新
        const _kplHomeCache = { ov: null, home: null };

        function KplHomePage({ go, status, reloadStatus }) {
            const [ov, setOv] = useState(() => _kplHomeCache.ov);
            const [home, setHome] = useState(() => _kplHomeCache.home);
            const [explainOpen, setExplainOpen] = useState(false);
            const load = useCallback(async () => {
                // 并行拉取（原先串行 await 拖慢首屏）
                const [o, h] = await Promise.all([
                    api("/api/kpl/overview").catch(() => null),
                    api("/api/kpl/home").catch(() => null),
                ]);
                if (o) { _kplHomeCache.ov = o; setOv(o); }
                if (h) { _kplHomeCache.home = h; setHome(h); }
            }, []);
            usePolling(load, 30000, []);
            const statusLoaded = !!status;
            const logged = statusLoaded ? !!status.logged_in : true; // 未加载完时不闪登录卡
            // 大盘解读弹窗：每次打开面板首次展示
            useEffect(() => {
                if (home && home.explain && home.explain.content && !sessionStorage.getItem("kpl_explain_seen")) {
                    setExplainOpen(true);
                    sessionStorage.setItem("kpl_explain_seen", "1");
                }
            }, [home]);
            const funcs = [
                ["📊 龙虎榜", () => go({ page: "lhb" })],
                ["🌡 市场情绪", () => go({ page: "market", sub: "sentiment" })],
                ["📝 复盘啦", () => {}],
                ["📚 题材库", () => go({ page: "market", sub: "plate" })],
                ["🛒 商品现货", () => {}],
                ["📰 快讯", () => go({ page: "market", sub: "live" })],
                ["🎥 大盘直播", () => go({ page: "market", sub: "live" })],
                ["💼 ETF基金", () => {}],
                ["📖 功能介绍", () => {}],
                ["🏢 机构增仓", () => {}],
            ];
            const rateCls = r => (Number(r) >= 0 ? "up" : "down");
            const fmtRate = r => (Number(r) >= 0 ? "+" : "") + Number(r).toFixed(2) + "%";
            const sentiment = (home && home.sentiment) || {};
            const today = sentiment.today || {}, yest = sentiment.yesterday || {};
            const qd = (home && home.qiangdu) || [];
            const qdRows = qd.length > 0 && [
                React.createElement("div", { key: "h", className: "kpl-qd-head" },
                    React.createElement("span", null, "股票名称"),
                    React.createElement("span", null, "强度"),
                    React.createElement("span", null, "涨跌幅"),
                    React.createElement("span", null, "板块")),
                ...qd.slice(0, 8).map((row, i) => {
                    const name = Array.isArray(row) ? row[1] : (row.Name || row.name || "-");
                    const strength = Array.isArray(row) ? row[2] : (row.Strength || row.strength || "-");
                    const rate = Array.isArray(row) ? row[3] : (row.Rate || row.rate || 0);
                    const plates = Array.isArray(row) ? (row[4] || "") : (row.Plate || row.plate || "");
                    return React.createElement("div", { key: i, className: "kpl-qd-row" },
                        React.createElement("span", { className: "name" }, name),
                        React.createElement("span", { className: "strength" }, strength),
                        React.createElement("span", { className: "rate " + rateCls(rate) }, fmtRate(rate)),
                        React.createElement("span", { className: "plates" }, plates));
                }),
            ];
            return React.createElement("div", { className: "kpl-page" },
                !logged && React.createElement(KplBindCard, { onBound: reloadStatus }),
                logged && status && status.user_info && React.createElement("div", { className: "kpl-user-bar" },
                    React.createElement("span", null,
                        "👤 " + (status.user_info.username || status.user_info.user_id)
                        + (status.phone_masked ? `（${status.phone_masked}）` : "")
                        + (status.token_invalid ? " ⚠ Token已失效" : (status.can_relogin ? " · 自动续期✓" : ""))),
                    React.createElement("button", {
                        className: "kpl-user-logout", onClick: async () => {
                            try { await post("/api/kpl/logout", {}); reloadStatus(); } catch { /* */ }
                        },
                    }, "退出")),
                React.createElement("div", { className: "kpl-func-grid" },
                    funcs.map(([label, fn]) =>
                        React.createElement("div", { key: label, className: "kpl-func-btn", onClick: fn }, label))),

                // ===== 最新主题（默认2条，更多进主题机会页） =====
                ((home && home.themes) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "最新主题"),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "themes" }) }, "更多 ›"))),
                ((home && home.themes) || []).slice(0, 2).map(t =>
                    React.createElement("div", { key: t.id, className: "kpl-theme-row" },
                        React.createElement("div", { className: "kpl-theme-badge" }, t.theme || "主题"),
                        React.createElement("div", { className: "kpl-theme-main" },
                            React.createElement("div", { className: "kpl-theme-title" }, t.title),
                            React.createElement("div", { className: "kpl-theme-stocks" },
                                (t.stocks || []).map(s =>
                                    React.createElement("span", { key: s.code, className: "kpl-theme-stock" },
                                        s.name, " ", React.createElement("b", { className: rateCls(s.rate) }, fmtRate(s.rate)))))))),

                // ===== 最强风口 =====
                React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "最强风口"),
                        React.createElement("span", {
                            className: "more", onClick: () => go({ page: "qiangdu" }),
                        }, qdRows.length ? "更多 ›" : "进入 ›")),
                    qdRows.length > 0 && React.createElement("div", null, qdRows),
                    qdRows.length === 0 && React.createElement("div", { className: "kpl-empty" }, "盘中数据，收盘后清空")),

                // ===== AI快讯 =====
                ((home && home.flash) || []).length > 0 && React.createElement("div", { className: "kpl-flash" },
                    React.createElement("div", { className: "kpl-flash-head" },
                        React.createElement("span", { className: "t" }, "AI快讯 ›"),
                        React.createElement("span", { className: "robot" }, "🤖")),
                    home.flash.slice(0, 3).map(f => React.createElement("div", { key: f.id, className: "kpl-flash-item" },
                        React.createElement("div", { className: "kpl-flash-line" },
                            React.createElement("b", { className: "kpl-flash-time" }, f.time ? new Date(f.time * 1000).toTimeString().slice(0, 8) : ""),
                            React.createElement("span", null, " ", f.title || (f.content || "").slice(0, 60))),
                        f.stocks && f.stocks.length > 0 && React.createElement("div", { className: "kpl-flash-stocks" },
                            f.stocks.slice(0, 3).map(s =>
                                React.createElement("span", { key: s.code, className: "kpl-flash-stock" },
                                    s.name, " ", React.createElement("b", { className: rateCls(s.rate) }, fmtRate(s.rate))))))),
                    React.createElement("div", { className: "kpl-flash-foot" }, "来源：开盘啦快讯")),

                // ===== 市场情绪 =====
                React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "市场情绪"),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "market", sub: "sentiment" }) }, "更多 ›")),
                    React.createElement("div", { className: "kpl-sent-grid" },
                        [["涨停板", today.ztjs, yest.ztjs], ["封板率%", today.strong, yest.strong], ["跌停板", today.df_num, yest.df_num]].map(([label, t, y]) =>
                            React.createElement("div", { key: label, className: "kpl-sent-cell" },
                                React.createElement("div", { className: "lbl" }, label),
                                React.createElement("div", { className: "val" },
                                    React.createElement("b", { className: rateCls(t || 0) }, t != null ? t : "-"),
                                    y != null && React.createElement("span", { className: "yest" }, " / 昨 " + y))))),
                    today.Day && React.createElement("div", { className: "kpl-sent-day" }, `数据日 ${today.Day}${yest.Day ? `（对比 ${yest.Day}）` : ""}`)),

                // ===== 题材库（Socket 实时, 前3条 + 更多进题材库页） =====
                ((home && home.tika) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "题材库"),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "tika" }) }, "更多 ›")),
                    home.tika.map(t => React.createElement(React.Fragment, { key: t.id },
                        React.createElement("div", {
                            className: "kpl-tika-row",
                            onClick: () => go({ page: "tikaDetail", id: t.id, name: t.name }),
                        },
                            React.createElement("span", { className: "rank hot-rank" }, "热"),
                            React.createElement("span", { className: "name" }, t.name),
                            (t.zt_num || 0) > 0 && React.createElement("span", { className: "zt" }, t.zt_num + "涨停"),
                            t.is_hot === 1 && React.createElement("span", { className: "kpl-hot-fire" }, "持续火爆"),
                            React.createElement("b", { className: rateCls(t.pct) }, fmtRate(t.pct))),
                        (t.concepts || []).length > 0 && React.createElement("div", { className: "kpl-tika2-child" },
                            "└ " + (t.concepts[0]["2"] || "子题材"))))),

                // ===== 人气榜（Socket 3008 实时, 前5名 + 急升提示 + 更多进人气榜页） =====
                ((home && home.poprank) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "开盘啦人气榜",
                            React.createElement("span", { className: "kpl-pop2-badge" },
                                (() => {
                                    const n = new Date();
                                    const wk = n.getDay() >= 1 && n.getDay() <= 5;
                                    const m = n.getHours() * 60 + n.getMinutes();
                                    const trading = wk && ((m >= 555 && m <= 690) || (m >= 780 && m <= 900));
                                    return trading ? "盘中" : "复盘";
                                })())),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "poprank" }) }, "更多 ›")),
                    ((home && home.poprank_hot) || []).length > 0 && React.createElement("div", { className: "kpl-pop2-hot5" },
                        React.createElement("span", { className: "lab" }, "急升"),
                        (home.poprank_hot || []).slice(0, 3).map((s, i) =>
                            React.createElement("span", { key: s.code, className: "it" },
                                s.name,
                                React.createElement("b", { className: rateCls(s.pct) }, fmtRate(s.pct)),
                                i < Math.min(home.poprank_hot.length, 3) - 1 && React.createElement("i", { className: "sep" }, "·")))),
                    home.poprank.slice(0, 5).map((s, i) =>
                        React.createElement("div", {
                            key: s.code, className: "kpl-pop2-row",
                            onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                        },
                            React.createElement("span", { className: `rk ${i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : ""}` }, s.num || i + 1),
                            React.createElement("div", { className: "main" },
                                React.createElement("div", { className: "nm" },
                                    s.name,
                                    s.lb_status && React.createElement("i", { className: "lb" }, s.lb_status),
                                    s.rank_change ? React.createElement("span", {
                                        className: `kpl-pop2-rc ${s.rank_change > 0 ? "up" : "down"}`,
                                    }, (s.rank_change > 0 ? "↑" : "↓") + Math.abs(s.rank_change)) : null),
                                (s.zt_reason || (s.tags || []).length > 0) && React.createElement("div", { className: "cd" },
                                    s.zt_reason && React.createElement("i", { className: "zr" }, s.zt_reason),
                                    (s.tags || []).slice(0, 1).map(t => React.createElement("i", { key: t.value, className: "tg" }, t.value)))),
                            React.createElement("div", { className: "vals" },
                                React.createElement("div", { className: "hot" },
                                    React.createElement("b", null, (s.hot_val || 0).toLocaleString()),
                                    React.createElement("span", { className: "lbl" }, "人气值")),
                                s.rank_change != null && s.rank_change !== 0 && React.createElement("span", {
                                    className: `rc ${s.rank_change > 0 ? "up" : "down"}`,
                                }, Math.abs(s.rank_change) + (s.rank_change > 0 ? "↑" : "↓")),
                                React.createElement("b", { className: `pct ${rateCls(s.pct)}` }, fmtRate(s.pct)))))),

                // ===== 严重异动提醒（偏离值监控，App 同款表格 UI） =====
                ((home && home.yidong) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "严重异动提醒"),
                        React.createElement("span", { className: "date" }, home.yidong_day || "")),
                    React.createElement("div", { className: "kpl-yd2" },
                        React.createElement("div", { className: "hd" },
                            React.createElement("span", { className: "c1" }, "股票名称"),
                            React.createElement("span", { className: "c2" }, "涨幅"),
                            React.createElement("span", { className: "c3" }, "触发异动涨幅/股价"),
                            React.createElement("span", { className: "c4" }, "当日偏离空间")),
                        home.yidong.slice(0, 5).map(s =>
                            React.createElement("div", {
                                key: s.code, className: "kpl-yd2-row",
                                onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                            },
                                React.createElement("div", { className: "c1" },
                                    React.createElement("div", { className: "nm" }, s.name),
                                    React.createElement("div", { className: "cd" },
                                        s.code,
                                        s.rule_short && React.createElement("i", null, s.rule_short))),
                                React.createElement("div", { className: "c2" },
                                    React.createElement("b", { className: rateCls(s.day_pct) }, fmtRate(s.day_pct)),
                                    React.createElement("span", null, s.price)),
                                React.createElement("div", { className: "c3" },
                                    React.createElement("b", { className: "org" }, fmtRate(s.need)),
                                    React.createElement("span", null, s.trigger_price)),
                                React.createElement("div", { className: "c4" },
                                    React.createElement("b", { className: Number(s.space) >= 0 ? "up" : "down" }, fmtRate(s.space)),
                                    React.createElement("span", null, s.rule_short || "")))))),

                // ===== 近期活跃板块 =====
                ((home && home.active_plates) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "近期活跃板块")),
                    React.createElement("div", { className: "kpl-active-plates" },
                        home.active_plates.map((p, i) =>
                            React.createElement("div", {
                                key: i, className: "kpl-active-plate",
                                onClick: p.id ? () => go({ page: "tikaDetail", id: p.id, name: p.name }) : undefined,
                            },
                                React.createElement("div", { className: "n" }, p.name),
                                React.createElement("div", { className: "r " + rateCls(p.rate) }, fmtRate(p.rate)))))),

                // ===== 市场风口（热词） =====
                ((home && home.tuyere_words) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "市场风口"),
                        React.createElement("span", { className: "more" }, "更多 ›")),
                    React.createElement("div", { className: "kpl-tuyere" },
                        home.tuyere_words.slice(0, 10).map((w, i) =>
                            React.createElement("span", { key: i, className: "kpl-tuyere-pill" },
                                w.KeyWord, React.createElement("b", null, " " + (w.num || "")))))),

                // ===== 推荐文章 =====
                ((home && home.articles) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "推荐文章"),
                        React.createElement("span", { className: "more" }, "更多 ›")),
                    home.articles.slice(0, 5).map(a =>
                        React.createElement("div", { key: a.id, className: "kpl-article-row",
                            onClick: () => a.url && window.open(a.url, "_blank") },
                            React.createElement("div", { className: "kpl-article-main" },
                                React.createElement("div", { className: "kpl-article-title" },
                                    (a.content || "").slice(0, 42) + ((a.content || "").length > 42 ? "…" : "")),
                                React.createElement("div", { className: "kpl-article-time" },
                                    a.time ? new Date(a.time * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "")),
                            React.createElement("div", { className: "kpl-article-thumb" }, "📄")))),

                // ===== 大盘解读弹窗 =====
                explainOpen && home && home.explain && React.createElement("div", { className: "kpl-explain-mask", onClick: () => setExplainOpen(false) },
                    React.createElement("div", { className: "kpl-explain", onClick: e => e.stopPropagation() },
                        React.createElement("div", { className: "kpl-explain-head" },
                            React.createElement("span", { className: "t" }, "开盘啦"),
                            React.createElement("span", { className: "x", onClick: () => setExplainOpen(false) }, "✕")),
                        React.createElement("div", { className: "kpl-explain-body" }, home.explain.content),
                        React.createElement("button", { className: "kpl-explain-more",
                            onClick: () => { setExplainOpen(false); } }, "知道了"))));
        }
        /* ---- 主题机会页（最新主题 / 投资日历） ---- */

        function KplThemesPage({ go }) {
            const [tab, setTab] = useState("themes");
            const [items, setItems] = useState([]);
            const [index, setIndex] = useState(0);
            const [hasMore, setHasMore] = useState(false);
            const [loading, setLoading] = useState(false);
            const load = useCallback(async (t, idx, append) => {
                setLoading(true);
                try {
                    const d = await api(`/api/kpl/themes?tab=${t}&index=${idx}&st=30`);
                    const rows = d.items || [];
                    setItems(prev => append ? [...prev, ...rows] : rows);
                    setIndex(idx);
                    setHasMore(!!d.has_more);
                } catch { /* */ }
                setLoading(false);
            }, []);
            useEffect(() => { load(tab, 0, false); }, [tab, load]);

            const WD = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
            const dayKey = t => {
                const d = new Date(t * 1000);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            };
            const groups = [];
            const byDay = {};
            (items || []).forEach(it => {
                const key = tab === "themes"
                    ? dayKey(it.time || 0)
                    : (it.date || "");
                if (!key) return;
                if (!byDay[key]) {
                    byDay[key] = [];
                    groups.push({ key, rows: byDay[key] });
                }
                byDay[key].push(it);
            });
            const dayLabel = key => {
                const d = new Date(key + "T00:00:00");
                if (isNaN(d)) return key;
                const md = tab === "calendar"
                    ? `${d.getMonth() + 1}月${d.getDate()}日`
                    : key;
                return `${md} ${WD[d.getDay()]}`;
            };
            const rateCls = r => (Number(r) >= 0 ? "up" : "down");
            const fmtRate = r => (Number(r) >= 0 ? "+" : "") + Number(r).toFixed(2) + "%";

            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, {
                    title: "主题机会", onBack: () => go({ page: "back" }),
                    onSearch: () => go({ page: "search" }),
                }),
                React.createElement("div", { className: "kpl-subtabs" },
                    [["themes", "最新主题"], ["calendar", "投资日历"]].map(([id, label]) =>
                        React.createElement("span", {
                            key: id,
                            className: `kpl-subtab ${tab === id ? "on" : ""}`,
                            onClick: () => setTab(id),
                        }, label))),
                groups.map(g => React.createElement("div", { key: g.key, className: "kpl-thm-day" },
                    React.createElement("div", { className: "kpl-thm-dayhead" }, dayLabel(g.key)),
                    g.rows.map(row => tab === "themes"
                        ? React.createElement("div", {
                            key: row.id, className: "kpl-thm-item",
                            onClick: () => go({ page: "themeDetail", id: row.id }),
                        },
                            React.createElement("div", { className: "kpl-thm-top" },
                                React.createElement("span", { className: "kpl-thm-name" }, row.theme || "主题"),
                                React.createElement("span", { className: "kpl-thm-time" },
                                    row.time ? new Date(row.time * 1000).toTimeString().slice(0, 5) : "")),
                            React.createElement("div", { className: "kpl-thm-title" }, row.title),
                            React.createElement("div", { className: "kpl-thm-stocks" },
                                (row.stocks || []).slice(0, 4).map(s =>
                                    React.createElement("div", {
                                        key: s.code, className: "kpl-thm-stock",
                                        onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                                    },
                                        React.createElement("span", { className: "n" }, s.name),
                                        React.createElement("b", { className: rateCls(s.rate) }, fmtRate(s.rate))))))
                        : React.createElement("div", { key: row.id, className: "kpl-thm-calrow" },
                            React.createElement("span", { className: `kpl-thm-tag c${row.color}` }, row.tag || "事件"),
                            React.createElement("div", { className: "kpl-thm-brief" }, row.brief))))),
                !loading && items.length === 0 && React.createElement("div", { className: "kpl-empty" }, "暂无数据"),
                hasMore && React.createElement("button", {
                    className: "kpl-thm-more", disabled: loading,
                    onClick: () => load(tab, index + 1, true),
                }, loading ? "加载中…" : "加载更多"),
                loading && items.length > 0 && React.createElement("div", { className: "kpl-empty" }, "加载中…"));
        }

        /* ---- 主题详情页 ---- */

        function KplThemeDetailPage({ id, go }) {
            const [d, setD] = useState(null);
            const [err, setErr] = useState(null);
            useEffect(() => {
                let alive = true;
                api(`/api/kpl/themes/${id}`).then(x => { if (alive) setD(x); })
                    .catch(e => { if (alive) setErr(e.message || "加载失败"); });
                return () => { alive = false; };
            }, [id]);
            const rateCls = r => (Number(r) >= 0 ? "up" : "down");
            const fmtRate = r => (Number(r) >= 0 ? "+" : "") + Number(r).toFixed(2) + "%";
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, {
                    title: "主题机会", onBack: () => go({ page: "back" }),
                    onSearch: () => go({ page: "search" }),
                }),
                err && React.createElement("div", { className: "kpl-empty" }, "✗ " + err),
                !d && !err && React.createElement("div", { className: "kpl-empty" }, "加载中…"),
                d && React.createElement("div", { className: "kpl-thmd" },
                    React.createElement("div", { className: "kpl-thmd-title" }, d.title),
                    React.createElement("div", { className: "kpl-thmd-meta" },
                        React.createElement("span", null,
                            d.time ? new Date(d.time * 1000).toLocaleString("zh-CN", {
                                year: "numeric", month: "2-digit", day: "2-digit",
                                hour: "2-digit", minute: "2-digit",
                            }).replace(/\//g, "-") : ""),
                        React.createElement("span", { className: "src" }, d.source || ""))),
                d && d.theme && d.theme.name && React.createElement("div", { className: "kpl-thmd-intro" },
                    React.createElement("div", { className: "kpl-thmd-badge" }, d.theme.name),
                    React.createElement("div", { className: "kpl-thmd-desc" }, d.theme.desc || "")),
                d && d.content && React.createElement("div", {
                    className: "kpl-thmd-content",
                    dangerouslySetInnerHTML: { __html: d.content },
                }),
                d && (d.stocks || []).length > 0 && React.createElement("div", { className: "kpl-thmd-stocks" },
                    React.createElement("div", { className: "kpl-thmd-sthead" }, "关联个股："),
                    d.stocks.map(s =>
                        React.createElement("div", { key: s.code, className: "kpl-thmd-stock" },
                            React.createElement("div", { className: "row" },
                                React.createElement("span", {
                                    className: "name",
                                    onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                                }, s.name),
                                React.createElement("span", { className: "code" }, s.code),
                                React.createElement("b", { className: rateCls(s.rate) }, fmtRate(s.rate))),
                            s.desc && React.createElement("div", { className: "desc" }, s.desc)))));
        }

        /* ---- 题材库页（Socket 实时: 热度/涨幅排序 + 详情双视图） ---- */

        function KplTikaPage({ go }) {
            const [sort, setSort] = useState("hot");
            const [data, setData] = useState(null);
            const [loading, setLoading] = useState(true);
            const [kw, setKw] = useState("");
            const [expanded, setExpanded] = useState({});
            const prevRef = useRef({});   // 上次快照热度 -> 排名变化箭头
            const load = useCallback(async (silent) => {
                if (!silent) setLoading(true);
                try {
                    const d = await api("/api/kpl/tika" + (silent ? "" : "?force=1"));
                    // 排名变化：与上次快照对比
                    const prev = prevRef.current;
                    const withDelta = (d.items || []).map(it => {
                        const p = prev[it.name];
                        it.delta = (p != null && it.hot != null) ? (it.hot - p) : null;
                        return it;
                    });
                    if (Object.keys(prev).length) {
                        withDelta.forEach(it => {
                            const sortedHot = [...withDelta].sort((a, b) => (b.hot || 0) - (a.hot || 0));
                            const nowRank = sortedHot.findIndex(x => x.name === it.name) + 1;
                            const prevRank = prev[it.name + "#rank"];
                            it.rankDelta = (prevRank != null && nowRank !== prevRank) ? (prevRank - nowRank) : null;
                        });
                    }
                    // 记录本次快照供下次对比
                    const next = {};
                    const sortedNow = [...withDelta].sort((a, b) => (b.hot || 0) - (a.hot || 0));
                    sortedNow.forEach((it, i) => { next[it.name] = it.hot; next[it.name + "#rank"] = i + 1; });
                    prevRef.current = next;
                    setData(d);
                } catch { setData({ items: [] }); }
                setLoading(false);
            }, []);
            useEffect(() => { load(false); }, [load]);
            // 自动刷新（App 下拉重新请求同效）：30 秒静默刷新
            useEffect(() => {
                const t = setInterval(() => load(true), 30000);
                return () => clearInterval(t);
            }, [load]);
            const items = ((data && data.items) || []).filter(t => !kw.trim() || (t.name || "").includes(kw.trim()));
            const sorted = [...items].sort((a, b) =>
                sort === "hot" ? (b.hot || 0) - (a.hot || 0) : (b.pct || 0) - (a.pct || 0));
            const rateCls = r => (Number(r) >= 0 ? "up" : "down");
            const fmtRate = r => (Number(r) >= 0 ? "+" : "") + Number(r).toFixed(2) + "%";
            const rankCls = i => i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : "";
            const renderRow = (t, i) => {
                const hasKids = (t.concepts || []).length > 0;
                const open = expanded[t.id];
                // App 行结构：名次 | 名称+涨停chip | 右侧=持续火爆徽标/上涨家数↑/涨幅
                const rightSlot = t.is_hot === 1
                    ? React.createElement("span", { className: "kpl-hot-fire" }, "持续火爆")
                    : sort === "hot" && (t.up_num || 0) > 0
                        ? React.createElement("span", { className: "kpl-tika2-up up" }, t.up_num + "↑")
                        : React.createElement("b", { className: rateCls(t.pct) }, fmtRate(t.pct));
                return React.createElement(React.Fragment, { key: t.id },
                    React.createElement("div", { className: "kpl-tika2-row", onClick: () => go({ page: "tikaDetail", id: t.id, name: t.name }) },
                        React.createElement("span", { className: `kpl-tika2-rank ${rankCls(i)}` }, (i + 1) + "."),
                        React.createElement("span", { className: "kpl-tika2-name" },
                            t.name,
                            (t.zt_num || 0) > 0 && React.createElement("span", { className: "kpl-tika2-zt" }, t.zt_num + "个涨停"),
                            hasKids && React.createElement("span", {
                                className: "kpl-tika2-caret",
                                onClick: e => { e.stopPropagation(); setExpanded(prev => ({ ...prev, [t.id]: !prev[t.id] })); },
                            }, open ? "▾" : "▸")),
                        (t.rankDelta != null && t.rankDelta !== 0) && React.createElement("span", {
                            className: "kpl-tika2-delta " + (t.rankDelta > 0 ? "up" : "down"),
                        }, Math.abs(t.rankDelta) + (t.rankDelta > 0 ? "↑" : "↓")),
                        rightSlot),
                    hasKids && open && (t.concepts || []).map((c, ci) =>
                        React.createElement("div", { key: ci, className: "kpl-tika2-child" },
                            "└ " + (c["2"] || c.name || c["1"] || "子题材"))));
            };
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, {
                    title: "题材库", onBack: () => go({ page: "back" }),
                    onSearch: () => go({ page: "search" }),
                }),
                // 搜索框（App 同款）
                React.createElement("div", { className: "kpl-tika2-search" },
                    React.createElement("input", {
                        placeholder: "请输入你想要搜索的题材关键词",
                        value: kw, onChange: e => setKw(e.target.value),
                    })),
                // 排序表头
                React.createElement("div", { className: "kpl-tika2-head" },
                    React.createElement("span", { className: "lbl" }, "排序"),
                    React.createElement("span", { className: "lbl" }, "题材名称"),
                    React.createElement("span", { className: "sorts" },
                        React.createElement("span", {
                            className: `s ${sort === "hot" ? "on" : ""}`,
                            onClick: () => setSort("hot"),
                        }, "按热度"),
                        React.createElement("span", { className: "sep" }, "|"),
                        React.createElement("span", {
                            className: `s ${sort === "pct" ? "on" : ""}`,
                            onClick: () => setSort("pct"),
                        }, "按涨幅"))),
                loading && React.createElement("div", { className: "kpl-empty" }, "加载中…"),
                data && data.error && React.createElement("div", { className: "kpl-empty" }, "⚠ " + data.error),
                sorted.map(renderRow),
                !loading && sorted.length === 0 && !data?.error && React.createElement("div", { className: "kpl-empty" }, "暂无数据"));
        }

        function KplTikaDetailPage({ id, name, go }) {
            const [view, setView] = useState("table");
            const [d, setD] = useState(null);
            const [err, setErr] = useState(null);
            const [introOpen, setIntroOpen] = useState(false);   // 查看全文弹窗（App ThemeDescDialog 同款）
            const [hideBrief, setHideBrief] = useState(false);   // 个股行情"隐藏简介"开关
            const [sortKey, setSortKey] = useState("hot");       // 默认人气值
            const [sortDir, setSortDir] = useState("desc");      // 默认降序
            useEffect(() => {
                let alive = true;
                api(`/api/kpl/tika/${id}?name=${encodeURIComponent(name || "")}`).then(x => {
                    if (!alive) return;
                    if (x.error) setErr(x.error); else setD(x);
                }).catch(e => { if (alive) setErr(e.message || "加载失败"); });
                return () => { alive = false; };
            }, [id, name]);
            const rateCls = r => (Number(r) >= 0 ? "up" : "down");
            const fmtRate = r => (Number(r) >= 0 ? "+" : "") + Number(r).toFixed(2) + "%";
            const amountFmt = a => {
                const n = Number(a);
                if (!isFinite(n) || n === 0) return a || "-";
                return n >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : n >= 1e4 ? (n / 1e4).toFixed(0) + "万" : String(a);
            };
            const dateFmt = ts => ts ? new Date(ts * 1000).toLocaleDateString("zh-CN",
                { year: "2-digit", month: "2-digit", day: "2-digit" }).replace(/\//g, "-") : "";
            // 个股行情右侧数值列（App classes 顺序；涨速/2分钟成交额/市值暂无数据源不展示）
            const cols = [
                { key: "price", label: "价格", fmt: v => v || "--" },
                { key: "pct", label: "涨幅", fmt: v => v != null && v !== "" ? fmtRate(v) : "--" },
                { key: "hot", label: "人气值", fmt: v => v != null && v !== "" ? String(v) : "--" },
                { key: "amount", label: "成交额", fmt: amountFmt },
                { key: "turnover", label: "换手率", fmt: v => v ? v + "%" : "--" },
            ];
            const stocks = React.useMemo(() => {
                const list = [...(d && d.stocks) || []];
                const num = v => { const n = Number(v); return isFinite(n) ? n : -Infinity; };
                list.sort((a, b) => sortDir === "desc" ? num(b[sortKey]) - num(a[sortKey]) : num(a[sortKey]) - num(b[sortKey]));
                return list;
            }, [d, sortKey, sortDir]);
            const stat = (d && d.stat) || null;
            const statNums = React.useMemo(() => {
                if (stat && stat.stock_num != null) return stat;
                const withPct = ((d && d.stocks) || []).filter(s => s.pct != null && s.pct !== "");
                const up = withPct.filter(s => Number(s.pct) > 0).length;
                const down = withPct.filter(s => Number(s.pct) < 0).length;
                const avg = withPct.length ? withPct.reduce((a, s) => a + Number(s.pct), 0) / withPct.length : null;
                return { stock_num: (d && d.stocks || []).length, up_num: up, down_num: down, avg_pct: avg };
            }, [d, stat]);
            const clickSort = key => {
                if (sortKey === key) setSortDir(dir => dir === "desc" ? "asc" : "desc");
                else { setSortKey(key); setSortDir("desc"); }
            };
            const ztCodes = (d && d.zt) || {};
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, {
                    title: d ? (d.name || name) : (name || "题材"),
                    subtitle: d && d.pct != null ? fmtRate(d.pct) : undefined,
                    onBack: () => go({ page: "back" }),
                    onSearch: () => go({ page: "search" }),
                }),
                React.createElement("div", { className: "kpl-subtabs" },
                    [["table", "小表格"], ["stocks", "个股行情"]].map(([vid, label]) =>
                        React.createElement("span", {
                            key: vid,
                            className: `kpl-subtab ${view === vid ? "on" : ""}`,
                            onClick: () => setView(vid),
                        }, label))),
                err && React.createElement("div", { className: "kpl-empty" }, "⚠ " + err),
                !d && !err && React.createElement("div", { className: "kpl-empty" }, "加载中…"),
                // ===== 题材描述 + 查看全文 + 日期（App 小表格顶部同款） =====
                d && (d.brief || d.introduction || d.update_time) && React.createElement("div", { className: "kpl-tikad2-desc" },
                    React.createElement("div", { className: "kpl-tikad2-descrow" },
                        React.createElement("div", { className: "txt" }, d.brief || ""),
                        (d.introduction || d.brief) && React.createElement("span", {
                            className: "more", onClick: () => setIntroOpen(true),
                        }, "查看全文 ▼")),
                    (d.create_time || d.update_time) && React.createElement("div", { className: "kpl-tikad2-dates" },
                        React.createElement("span", null, d.create_time ? dateFmt(d.create_time) + "创建" : ""),
                        React.createElement("span", null, d.update_time ? dateFmt(d.update_time) + "更新" : ""))),
                // ===== 小表格视图：红色边框表格（App 同款 一级分类左列 + 二级分类/股票区） =====
                d && view === "table" && React.createElement("div", { className: "kpl-tikad2-wrap" },
                    (d.table || []).length > 0 ? React.createElement("div", { className: "kpl-tikad2-table" },
                        React.createElement("div", { className: "head" },
                            React.createElement("span", { className: "t" }, d.name || name || ""),
                            React.createElement("span", { className: "logo" }, "开盘啦")),
                        (d.table || []).map(lv1 =>
                            React.createElement("div", { key: lv1.id, className: "row" },
                                React.createElement("div", { className: "l1" }, lv1.name || "-"),
                                React.createElement("div", { className: "r" },
                                    (lv1.groups || []).map(g =>
                                        React.createElement("div", { key: g.id, className: "grp" },
                                            React.createElement("span", { className: "gname" }, g.name),
                                            React.createElement("span", { className: "stocks" },
                                                (g.stocks || []).map(s =>
                                                    React.createElement("a", {
                                                        key: s.code,
                                                        className: "stk" + (s.is_zt || ztCodes[s.code] ? " zt" : ""),
                                                        title: s.reason || undefined,
                                                        onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                                                    }, s.name)))))))),
                        React.createElement("div", { className: "disc" },
                            "免责声明:本文涉及资讯、数据等内容来自网络公共信息，仅供参考，不构成投资建议。"))
                        : React.createElement("div", { className: "kpl-empty" }, "暂无小表格数据")),
                // ===== 个股行情视图：统计条 + 表头排序 + 左固定/右横滑列表 =====
                d && view === "stocks" && React.createElement("div", { className: "kpl-tikad2-stocks" },
                    React.createElement("div", { className: "kpl-tikad2-stat" },
                        React.createElement("span", null, "股票数量：", React.createElement("b", null, statNums.stock_num != null ? statNums.stock_num : "-")),
                        React.createElement("span", null, "上涨：", React.createElement("b", { className: "up" }, statNums.up_num != null ? statNums.up_num : "-")),
                        React.createElement("span", null, "下跌：", React.createElement("b", { className: "down" }, statNums.down_num != null ? statNums.down_num : "-")),
                        React.createElement("span", null, "平均涨幅：", React.createElement("b", { className: rateCls(statNums.avg_pct || 0) },
                            statNums.avg_pct != null ? fmtRate(statNums.avg_pct) : "-"))),
                    (stocks.length > 0 || true) && React.createElement("div", { className: "kpl-tikad2-scroll" },
                        React.createElement("div", { className: "kpl-tikad2-thead" },
                            React.createElement("div", { className: "left" },
                                React.createElement("span", {
                                    className: "hidesw" + (hideBrief ? " off" : ""),
                                    onClick: () => setHideBrief(v => !v),
                                }, "隐藏简介"),
                                !hideBrief && React.createElement("span", { className: "hidesw-ic" }, "📋")),
                            cols.map(c =>
                                React.createElement("span", {
                                    key: c.key,
                                    className: "cell sortable" + (sortKey === c.key ? " on" : ""),
                                    onClick: () => clickSort(c.key),
                                }, c.label,
                                    sortKey === c.key && React.createElement("i", null, sortDir === "desc" ? "▼" : "▲")))),
                        stocks.map(s =>
                            React.createElement("div", {
                                key: s.code,
                                className: "kpl-tikad2-srow" + (s.is_zt || ztCodes[s.code] ? " zt" : ""),
                                onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                            },
                                React.createElement("div", { className: "left" },
                                    React.createElement("div", { className: "nm" },
                                        s.name,
                                        (s.is_zt || ztCodes[s.code]) && React.createElement("span", { className: "ztb" }, "涨停")),
                                    React.createElement("div", { className: "cd" },
                                        s.code,
                                        (s.tags || []).slice(0, 2).map(t =>
                                            React.createElement("i", { key: t.id, title: t.reason }, t.name))),
                                    !hideBrief && (s.tags || []).length > 0 && React.createElement("div", { className: "brief" },
                                        (s.tags[0].name + "：" + (s.tags[0].reason || "")).slice(0, 60))),
                                cols.map(c =>
                                    React.createElement("span", { key: c.key, className: "cell" },
                                        c.key === "pct" && s[c.key] != null && s[c.key] !== ""
                                            ? React.createElement("b", { className: rateCls(s.pct) }, fmtRate(s.pct))
                                            : c.fmt(s[c.key])))))),
                    d && stocks.length === 0 && React.createElement("div", { className: "kpl-empty" }, "暂无个股数据")),
                // ===== 查看全文弹窗（App ThemeDescDialog 同款：正文全文） =====
                introOpen && d && React.createElement("div", { className: "kpl-explain-mask", onClick: () => setIntroOpen(false) },
                    React.createElement("div", { className: "kpl-explain", onClick: e => e.stopPropagation() },
                        React.createElement("div", { className: "kpl-explain-head" },
                            React.createElement("span", { className: "t" }, "题材介绍"),
                            React.createElement("span", { className: "x", onClick: () => setIntroOpen(false) }, "✕")),
                        React.createElement("div", {
                            className: "kpl-explain-body kpl-tikad2-introfull",
                            dangerouslySetInnerHTML: { __html: d.introduction || d.brief || "" },
                        }),
                        React.createElement("button", { className: "kpl-explain-more", onClick: () => setIntroOpen(false) }, "知道了"))));
        }

        /* ---- 人气榜页（cmd 3008，App 同源双榜：复盘/盘中 × 热度排名/排名飙升/热度飙升） ---- */

        function KplPopRankPage({ go }) {
            // App 字节码实锤（2026-09-26）：盘中/复盘共用同一 Fragment，type=「tab+排序」联合编码
            // 盘中三排序=type 1/2/16，复盘三排序=type 13/14/17；服务端返回即目标序（勿本地重排）
            const TABS = [
                { id: "live", label: "盘中人气榜", types: [1, 2, 16] },
                { id: "replay", label: "复盘人气榜", types: [13, 14, 17] },
            ];
            const SORTS = [
                { id: "hot", label: "热度排名" },
                { id: "rc", label: "排名飙升" },
                { id: "hc", label: "热度飙升" },
            ];
            // App 同款：首页徽标非交易时段=复盘，进页默认复盘榜；交易时段=盘中榜
            const inTradingHours = (() => {
                const n = new Date();
                if (n.getDay() === 0 || n.getDay() === 6) return false;
                const m = n.getHours() * 60 + n.getMinutes();
                return (m >= 555 && m <= 690) || (m >= 780 && m <= 900);
            })();
            // ⚠️ state 只存 id 字符串：组件每次渲染重建 TABS/SORTS 数组，若存对象，
            // indexOf 按引用查找会失配 → type=undefined → 422"加载失败"（2026-09-27 实证）
            const [tabId, setTabId] = useState(inTradingHours ? "live" : "replay");
            const [sortId, setSortId] = useState("hot");
            const [data, setData] = useState(null);
            const [loading, setLoading] = useState(true);
            const tab = TABS.find(t => t.id === tabId) || TABS[0];
            const sortIdx = Math.max(0, SORTS.findIndex(s => s.id === sortId));
            const sort = SORTS[sortIdx];
            const load = useCallback(async (t, sIdx) => {
                setLoading(true);
                let failed = false;
                // 后端偶发事件循环停顿（数十秒级）会导致单次 fetch 失败，自动重试 2 次吞掉抖动
                for (let i = 0; i < 3; i++) {
                    try {
                        setData(await api(`/api/kpl/poprank?type=${t.types[sIdx]}&order=1&start=0&count=50`));
                        failed = false;
                        break;
                    } catch {
                        failed = true;
                        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
                    }
                }
                if (failed) setData({ items: [], error: "加载失败" });
                setLoading(false);
            }, []);
            useEffect(() => { load(tab, sortIdx); }, [tabId, sortId, load]);
            const rateCls = r => (Number(r) >= 0 ? "up" : "down");
            const fmtRate = r => (Number(r) >= 0 ? "+" : "") + Number(r).toFixed(2) + "%";
            const rankCls = n => n === 1 ? "r1" : n === 2 ? "r2" : n === 3 ? "r3" : "";
            const items = (data && data.items) || [];
            const ts = data && data.timestamp;
            const lastUp = ts ? new Date(ts * 1000).toLocaleString("zh-CN",
                { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
            const five = (data && data.five_minute_items) || [];
            const [descOpen, setDescOpen] = useState({});
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "开盘啦人气榜", onBack: () => go({ page: "back" }) }),
                React.createElement("div", { className: "kpl-pop2-tabs" },
                    TABS.map(t =>
                        React.createElement("span", {
                            key: t.id, className: `kpl-pop2-tab ${tab.id === t.id ? "on" : ""}`,
                            onClick: () => setTabId(t.id),
                        }, t.label))),
                // 盘中榜：非交易时段提示停止更新（App 同款）
                tab.id === "live" && !inTradingHours && React.createElement("div", { className: "kpl-pop2-stale" },
                    `当前时段停止更新${lastUp ? `，最后更新时间为 ${lastUp}` : ""}`,
                    React.createElement("span", { className: "x", onClick: e => e.currentTarget.parentNode.remove() }, "✕")),
                React.createElement("div", { className: "kpl-pop2-sorts" },
                    SORTS.map(so =>
                        React.createElement("span", {
                            key: so.id, className: `pill ${sort.id === so.id ? "on" : ""}`,
                            onClick: () => setSortId(so.id),
                        }, so.label))),
                loading && React.createElement("div", { className: "kpl-empty" }, "加载中…"),
                !loading && data && data.error && React.createElement("div", { className: "kpl-empty", onClick: () => load(tab, sortIdx), style: { cursor: "pointer" } },
                    "加载失败，点击重试"),
                !loading && !data?.error && items.length === 0 && React.createElement("div", { className: "kpl-empty" }, "暂无数据"),
                items.map(s =>
                    React.createElement("div", { key: s.code, className: "kpl-pop2-card" },
                        React.createElement("div", { className: "r1" },
                            React.createElement("span", { className: `rk ${rankCls(s.num)}` }, s.num || "-"),
                            React.createElement("span", { className: "nm" }, s.name),
                            React.createElement("span", { className: "code" }, s.code),
                            React.createElement("b", { className: `pct ${rateCls(s.pct)}` }, fmtRate(s.pct)),
                            // App 同款：热度飙升视图右列显示"热度变化值↑"，其余视图显示🔥热度值
                            sort.id === "hc"
                                ? React.createElement("span", { className: "hv" }, React.createElement("b", null, (s.hot_change || 0).toLocaleString()), "↑")
                                : React.createElement("span", { className: "hv" }, "🔥", React.createElement("b", null, (s.hot_val || 0).toLocaleString()))),
                        (s.rank_change || (s.tags || []).length > 0 || s.zt_reason || s.lb_status) && React.createElement("div", { className: "r2" },
                            s.rank_change ? React.createElement("span", { className: `rcup ${s.rank_change > 0 ? "up" : "down"}` },
                                (s.rank_change > 0 ? "↑" : "↓") + Math.abs(s.rank_change)) : null,
                            s.zt_reason && React.createElement("i", { className: "chip-o" }, s.zt_reason),
                            s.lb_status && React.createElement("i", { className: "chip-o" }, s.lb_status),
                            (s.tags || []).map(t =>
                                React.createElement("i", { key: t.value, className: "chip-b" }, t.value))),
                        s.desc && React.createElement("div", {
                            className: "desc" + (descOpen[s.code] ? " open" : ""),
                            onClick: e => { e.stopPropagation(); setDescOpen(p => ({ ...p, [s.code]: !p[s.code] })); },
                        }, (s.desc || "").slice(0, descOpen[s.code] ? 999 : 60),
                            React.createElement("span", { className: "arr" }, descOpen[s.code] ? " ∧" : " >")))),
                // 底部 5 分钟人气提示条（fiveMinuteItems，App 同款）
                five.length > 0 && React.createElement("div", { className: "kpl-pop2-five" },
                    React.createElement("span", { className: "t" }, "排名", React.createElement("b", null, "上升")),
                    five.slice(0, 1).map(s =>
                        React.createElement("span", { key: s.code, className: "it" },
                            s.name, " ｜ 5分钟人气上升 ", s.num || 0, " 位"))));
        }

        /* ---- 行情页（子Tab: 板块/个股/...） ---- */

        function KplMarketPage({ go, initialSub }) {
            const [sub, setSub] = useState(initialSub || "plate");
            const subs = ["板块", "个股", "港股", "打板", "情绪", "直播", "全球"];
            const subMap = { "板块": "plate", "个股": "stock", "港股": "hk", "打板": "daban", "情绪": "sentiment", "直播": "live", "全球": "global" };
            const activeSub = Object.keys(subMap).find(k => subMap[k] === sub) || "板块";
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-subtabs" },
                    subs.map(s => React.createElement("span", {
                        key: s, className: `kpl-subtab ${subMap[s] === sub ? "on" : ""}`,
                        onClick: () => setSub(subMap[s]),
                    }, s))),
                sub === "plate" && React.createElement(KplPlateSub, { go }),
                sub === "sentiment" && React.createElement(KplSentimentSub, null),
                sub === "global" && React.createElement(KplGlobalSub, null),
                !["plate", "sentiment", "global"].includes(sub) && React.createElement("div", { className: "kpl-placeholder" }, `${activeSub} 页面二期提供`));
        }

        function KplPlateSub({ go }) {
            const [ov, setOv] = useState(null);
            const load = useCallback(async () => {
                try { setOv(await api("/api/kpl/overview")); } catch { /* */ }
            }, []);
            usePolling(load, 20000, []);
            const dingpan = (ov && ov.dingpan) || {};
            const db = dingpan.DaBanList || dingpan.DaBanList === 0 ? dingpan.DaBanList : {};
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-stat-cards" },
                    [["涨停板", (db.tZhangTing ?? "-") + " / " + (db.lZhangTing ?? "-")], ["封板率", (db.tFengBan ?? "-") + "%"], ["跌停股", (db.tDieTing ?? "-") + " / " + (db.lDieTing ?? "-")]]
                        .map(([label, val], i) =>
                            React.createElement("div", { key: i, className: "kpl-stat-card" },
                                React.createElement("div", { className: "kpl-stat-label" }, label),
                                React.createElement("div", { className: "kpl-stat-value" }, val)))),
                React.createElement("div", { className: "kpl-sec-title" }, "📈 精选板块强度（点击下钻）"),
                React.createElement("div", { className: "kpl-sector-table" },
                    KPL_SECTORS.map((s) => React.createElement(KplSectorRow, { key: s.code, sector: s, go, list: KPL_SECTORS }))));
        }

        function KplSectorRow({ sector, go, list }) {
            const [info, setInfo] = useState(null);
            useEffect(() => {
                let alive = true;
                const t = setTimeout(async () => {
                    try { const d = await api(`/api/kpl/plate/${sector.code}`); if (alive) setInfo(d.info); }
                    catch { /* */ }
                }, Math.floor(Math.random() * 2500));
                return () => { alive = false; clearTimeout(t); };
            }, [sector.code]);
            return React.createElement("div", { className: "kpl-sector-row", onClick: () => go({ page: "sector", plate: sector, list }) },
                React.createElement("div", { className: "kpl-sector-name" },
                    React.createElement("div", { className: "n" }, sector.name),
                    React.createElement("div", { className: "c" }, sector.code)),
                info ? React.createElement("div", { className: "kpl-sector-num" }, React.createElement("span", { className: cls(info.change_pct) + " strong" }, String(info.point ?? "-")),
                    React.createElement("span", { className: cls(info.change_pct) + " pct" }, formatPct(info.change_pct)))
                    : React.createElement("div", { className: "kpl-sector-num" }, "--"),
                info ? React.createElement("div", { className: "kpl-sector-num" }, React.createElement("span", { className: cls(info.main_net >= 0) }, (info.main_net / 1e8).toFixed(1) + "亿"))
                    : React.createElement("div", { className: "kpl-sector-num" }, "--"),
                info && info.zt_count != null ? React.createElement("div", { className: "kpl-sector-zt" }, `涨停 ${info.zt_count}`) : null);
        }

        function KplSentimentSub() {
            const [data, setData] = useState(null);
            const load = useCallback(async () => {
                try { setData(await api("/api/kpl/overview")); } catch { /* */ }
            }, []);
            usePolling(load, 60000, []);
            const hist = (data && data.sentiment_history) || [];
            return React.createElement("div", { className: "kpl-page" },
                hist.length === 0 && React.createElement("div", { className: "kpl-placeholder" }, "暂无情绪数据"),
                hist.slice(0, 10).map((d, i) =>
                    React.createElement("div", { key: i, className: "kpl-sent-row" },
                        React.createElement("span", { className: "day" }, d.Day),
                        React.createElement("span", { className: "strong" }, `强度 ${d.strong}`),
                        React.createElement("span", { className: "zt" }, `涨停 ${d.ztjs}`),
                        React.createElement("span", { className: "lb" }, `连板高度 ${d.lbgd}`))));
        }

        function KplGlobalSub() {
            const [data, setData] = useState(null);
            const load = useCallback(async () => {
                try { setData(await api("/api/kpl/overview")); } catch { /* */ }
            }, []);
            usePolling(load, 60000, []);
            const global = (data && data.global) || {};
            const groups = {};
            for (const [k, v] of Object.entries(global)) {
                if (!Array.isArray(v) || !v.length) continue;
                for (const item of v) {
                    if (item && typeof item === "object" && item.last_px) {
                        const cat = k.replace(/Time|Type/g, "");
                        if (!groups[cat]) groups[cat] = [];
                        groups[cat].push(item);
                    }
                }
            }
            return React.createElement("div", { className: "kpl-page" },
                Object.keys(groups).length === 0 && React.createElement("div", { className: "kpl-placeholder" }, "暂无全球指数数据"),
                Object.entries(groups).map(([cat, items]) =>
                    React.createElement("div", { key: cat },
                        React.createElement("div", { className: "kpl-sec-title" }, cat),
                        React.createElement("div", { className: "kpl-global-grid" },
                            items.slice(0, 6).map((item, i) =>
                                React.createElement("div", { key: i, className: "kpl-global-card" },
                                    React.createElement("div", { className: "name" }, item.prod_name || item.code || "-"),
                                    React.createElement("div", { className: `px ${cls(item.change_rate)}` }, item.last_px),
                                    React.createElement("div", { className: `chg ${cls(item.change_rate)}` }, item.increase_amount + " " + item.change_rate)))))));
        }

        /* ---- 自选股页 ---- */

        function KplWatchPage({ go }) {
            const [wl, setWl] = useState(null);
            const [quotes, setQuotes] = useState({});
            const [group, setGroup] = useState("0");
            const [error, setError] = useState(null);
            const load = useCallback(async () => {
                try {
                    const d = await api("/api/kpl/watchlist");
                    if (d && d.error) { setError(d.error); return; }
                    setWl(d); setError(null);
                    const codes = ((d || {}).stocks || {})[group] || [];
                    const qs = {};
                    for (const code of codes.slice(0, 15)) {
                        try { qs[code] = await api(`/api/kpl/quote/${code}`); } catch { /* */ }
                    }
                    setQuotes(qs);
                } catch (e) { setError(e.message); }
            }, [group]);
            usePolling(load, 10000, [group]);
            const del = async (code) => {
                try { await post("/api/kpl/watchlist/del", { code, combine_id: group }); load(); }
                catch (e) { setError(e.message); }
            };
            const groups = (wl && wl.groups) || [];
            const codes = (wl && wl.stocks && wl.stocks[group]) || [];
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(ErrorBox, { error }),
                groups.length > 0 && React.createElement("div", { className: "kpl-groups" },
                    groups.map((g) => React.createElement("span", {
                        key: g.id, className: `kpl-group-chip ${group === g.id ? "on" : ""}`,
                        onClick: () => setGroup(g.id),
                    }, g.name))),
                wl && codes.length === 0 && React.createElement("div", { className: "kpl-placeholder" },
                    "该分组暂无自选股"),
                codes.map((code) => {
                    const qt = quotes[code];
                    const name = (qt && qt.name) || code;
                    return React.createElement("div", { key: code, className: "kpl-wrow",
                        onClick: () => go({ page: "stock", stock: { code, name } }) },
                        React.createElement("div", { className: "kpl-wrow-info" },
                            React.createElement("div", { className: "n" }, name),
                            React.createElement("div", { className: "c" }, code)),
                        qt ? React.createElement("div", { className: "kpl-wrow-quote" },
                            React.createElement("div", { className: `px ${cls(qt.change_pct)}` }, formatNum(qt.last)),
                            React.createElement("div", { className: `pct ${cls(qt.change_pct)}` }, formatPct(qt.change_pct)))
                            : React.createElement("div", { className: "kpl-wrow-quote" }, "--"),
                        React.createElement("button", { className: "kpl-wrow-del",
                            onClick: (e) => { e.stopPropagation(); del(code); } }, "－"));
                }),
                React.createElement("button", { className: "kpl-add-stock-btn", onClick: () => go({ page: "search" }) },
                    "＋ 搜索添加自选股"));
        }

        /* ---- 龙虎榜 / 推荐 (占位) ---- */

        function KplLhbPage() {
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-placeholder" }, "📊 龙虎榜功能二期提供"));
        }

        function KplRecommendPage() {
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-placeholder" }, "👍 推荐功能二期提供"));
        }

        /* ---- 板块详情（下钻 1:1） ---- */

        function KplSectorDetail({ plate, list, go }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const load = useCallback(async () => {
                try { const d = await api(`/api/kpl/plate/${plate.code}`); setError(null); setData(d); }
                catch (e) { setError(e.message); }
            }, [plate.code]);
            usePolling(load, 20000, [plate.code]);
            const info = data && data.info;
            const idx = list.findIndex((s) => s.code === plate.code);
            const nav = (dir) => {
                const ni = (idx + dir + list.length) % list.length;
                go({ page: "sector", plate: list[ni], list });
            };
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: plate.name, subtitle: plate.code,
                    onBack: () => go({ page: "back" }), onSearch: () => go({ page: "search" }),
                    extra: list.length > 1 && [
                        React.createElement("button", { key: "p", className: "kpl-head-nav", onClick: () => nav(-1) }, "◀"),
                        React.createElement("button", { key: "n", className: "kpl-head-nav", onClick: () => nav(1) }, "▶"),
                    ] }),
                React.createElement(LoadingBar, { show: !data && !error }),
                React.createElement(ErrorBox, { error }),
                info && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "kpl-sf-block" },
                        React.createElement("div", { className: "kpl-sf-big" }, String(info.point)),
                        React.createElement("div", { className: "kpl-sf-rank" }, `排名 ${info.rank ?? "-"}`)),
                    React.createElement("div", { className: "kpl-sf-grid" },
                        [["涨幅", formatPct(info.change_pct), info.change_pct >= 0],
                         ["主力净额", (info.main_net / 1e8).toFixed(2) + "亿", info.main_net >= 0],
                         ["成交额", (info.amount / 1e8).toFixed(1) + "亿", true],
                         ["涨停数", info.zt_count, true],
                         ["涨停封单", (info.zt_seal / 1e8).toFixed(2) + "亿", true],
                         ["大单封单", (info.big_seal / 1e8).toFixed(2) + "亿", true]]
                            .map(([k, v, up], i) =>
                                React.createElement("div", { key: i, className: "kpl-sf-item" },
                                    React.createElement("span", { className: "k" }, k),
                                    React.createElement("span", { className: "v " + (up ? "up" : "down") }, v))))),
                data && (data.son_plates || []).length > 0 && React.createElement("div", { className: "kpl-son-chips" },
                    React.createElement("span", { className: "kpl-son-label" }, "细分"),
                    data.son_plates.map((s) =>
                        React.createElement("span", { key: s.code, className: "kpl-son-chip",
                            onClick: () => go({ page: "sector", plate: { code: s.code, name: s.name }, list }),
                        }, React.createElement("b", null, s.name), React.createElement("span", null, s.strength)))),
                data && (data.filter_tags || []).length > 0 && React.createElement("div", { className: "kpl-ft-chips" },
                    data.filter_tags.map((t, i) =>
                        React.createElement("span", { key: i, className: `kpl-ft-chip ${t.open ? "" : "locked"}` },
                            t.open ? t.name : `🔒${t.name}`))),
                data && data.trend && data.trend.trend && data.trend.trend.length > 0 &&
                    React.createElement(KplTrendChart, { trend: data.trend.trend, preclose: data.trend.preclose, height: 170 }),
                React.createElement("div", { className: "kpl-note" },
                    "ℹ️ 股票池列表（龙一/人气值）走KPL Socket通道，二期提供"));
        }

        /* ---- 个股详情（下钻） ---- */

        function KplStockDetail({ stock, go }) {
            const [q, setQ] = useState(null);
            const [error, setError] = useState(null);
            const [inWatch, setInWatch] = useState(null);
            const load = useCallback(async () => {
                try { const d = await api(`/api/kpl/quote/${stock.code}?force=1`); setError(null); setQ(d); }
                catch (e) { setError(e.message); }
            }, [stock.code]);
            usePolling(load, 10000, [stock.code]);
            const toggleWatch = async () => {
                try {
                    if (inWatch) await post("/api/kpl/watchlist/del", { code: stock.code });
                    else await post("/api/kpl/watchlist/add", { code: stock.code });
                    setInWatch(!inWatch);
                } catch (e) { setError(e.message); }
            };
            const up = q && q.change >= 0;
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: q ? q.name : stock.name, subtitle: stock.code,
                    onBack: () => go({ page: "back" }), onSearch: () => go({ page: "search" }) }),
                React.createElement(LoadingBar, { show: !q && !error }),
                React.createElement(ErrorBox, { error }),
                q && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "kpl-stock-quote" },
                        React.createElement("div", { className: "kpl-stock-price" },
                            React.createElement("div", { className: "big " + (up ? "up" : "down") }, formatNum(q.last)),
                            React.createElement("div", { className: "chg " + (up ? "up" : "down") },
                                `${q.change >= 0 ? "+" : ""}${formatNum(q.change)}  ${formatPct(q.change_pct)}`)),
                        React.createElement("div", { className: "kpl-stock-grid" },
                            [["高", formatNum(q.high)], ["换手", formatNum(q.turnover_ratio) + "%"], ["振幅", formatNum(q.amplitude) + "%"],
                             ["低", formatNum(q.low)], ["市值", formatYi((q.market_cap || 0) / 1e8)], ["金额", formatYi((q.amount || 0) / 1e8)],
                             ["开", formatNum(q.open)], ["流通", formatYi((q.float_cap || 0) / 1e8)], ["市盈TTM", formatNum(q.pe_ttm)]]
                                .map(([k, v], i) => React.createElement("div", { key: i, className: "kpl-sg-item" },
                                    React.createElement("span", { className: "k" }, k),
                                    React.createElement("span", { className: "v" }, v))))),
                    q.zt_reason && React.createElement("div", { className: "kpl-reason" }, `📌 ${q.zt_reason}`),
                    React.createElement("div", { className: "kpl-stock-ladder-wrap" },
                        React.createElement(KplLadder, { asks: q.asks, bids: q.bids, totalAsk: q.total_ask, totalBid: q.total_bid }),
                        React.createElement("div", { className: "kpl-stock-side" },
                            React.createElement("div", { className: "kpl-mini" },
                                React.createElement("div", { className: "k" }, "主力净入"),
                                React.createElement("div", { className: "v " + cls((q.amount_in || 0) - (q.amount_out || 0)) },
                                    formatYi(((q.amount_in || 0) - (q.amount_out || 0)) / 1e8))),
                            React.createElement("div", { className: "kpl-mini" },
                                React.createElement("div", { className: "k" }, "量比"),
                                React.createElement("div", { className: "v" }, formatNum(q.vol_ratio))),
                            React.createElement("div", { className: "kpl-mini" },
                                React.createElement("div", { className: "k" }, "委比"),
                                React.createElement("div", { className: "v" }, formatNum(q.entrust_rate) + "%")))),
                    React.createElement("div", { className: "kpl-stock-actions" },
                        React.createElement("button", { className: "kpl-action-btn", onClick: () => go({ page: "lhb" }) }, "📊 龙虎榜(二期)"),
                        React.createElement("button", { className: "kpl-action-btn star", onClick: toggleWatch },
                            inWatch ? "★ 移出自选" : "☆ 加自选")),
                ));
        }

        /* ---- 搜索（下钻） ---- */

        function KplSearch({ go }) {
            const [q, setQ] = useState("");
            const [hot, setHot] = useState([]);
            const [results, setResults] = useState(null);
            const loadHot = useCallback(async () => {
                try { const d = await api("/api/kpl/overview"); setHot((d && d.hot_stocks) || []); } catch { /* */ }
            }, []);
            useEffect(() => { loadHot(); }, []);
            useEffect(() => {
                if (!q.trim()) { setResults(null); return; }
                const t = setTimeout(async () => {
                    try { const d = await api(`/api/kpl/search-local?q=${encodeURIComponent(q.trim())}`); setResults(d.results || []); }
                    catch { /* */ }
                }, 300);
                return () => clearTimeout(t);
            }, [q]);
            const add = async (code) => {
                try { await post("/api/kpl/watchlist/add", { code }); }
                catch { /* */ }
            };
            const rows = results !== null ? results : hot.map((h) => ({ code: h.ID, name: h.Name || "" }));
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "搜索", onBack: () => go({ page: "back" }) }),
                React.createElement("input", { className: "kpl-search-input", placeholder: "搜索个股（代码/名称）",
                    value: q, onChange: (e) => setQ(e.target.value) }),
                results === null && React.createElement("div", { className: "kpl-sec-title" }, "🔥 热搜股票"),
                rows.map((r) => React.createElement("div", { key: r.code, className: "kpl-search-row" },
                    React.createElement("span", { className: "name", onClick: () => go({ page: "stock", stock: r }) },
                        (r.name || "—") + " "),
                    React.createElement("span", { className: "code" }, r.code),
                    React.createElement("button", { className: "kpl-add-btn", onClick: () => add(r.code) }, "＋"))),
                results !== null && rows.length === 0 && React.createElement("div", { className: "kpl-placeholder" }, "无匹配结果"));
        }

        /* ---- 主路由：底部导航 + 下钻 ---- */

        const KPL_STATUS_MEM = { data: null };

        function KplTab() {
            const [activeNav, setActiveNav] = useState("home");
            // 下钻页栈：支持 主题机会→详情→个股 逐级返回
            const [drills, setDrills] = useState([]);
            const [status, setStatus] = useState(KPL_STATUS_MEM.data);
            const loadStatus = useCallback(async () => {
                try {
                    const s = await api("/api/kpl/status");
                    KPL_STATUS_MEM.data = s;
                    setStatus(s);
                } catch { /* */ }
            }, []);
            usePolling(loadStatus, 30000, []);

            const go = (r) => {
                if (r.page === "back") { setDrills(prev => prev.slice(0, -1)); return; }
                setDrills(prev => [...prev, r]);
            };
            const switchNav = (id) => { setDrills([]); setActiveNav(id); };

            // 下钻页面渲染（栈顶）
            const drill = drills.length > 0 ? drills[drills.length - 1] : null;
            let content;
            if (drill) {
                if (drill.page === "sector") content = React.createElement(KplSectorDetail, { plate: drill.plate, list: drill.list || KPL_SECTORS, go });
                else if (drill.page === "stock") content = React.createElement(KplStockDetail, { stock: drill.stock, go });
                else if (drill.page === "search") content = React.createElement(KplSearch, { go });
                else if (drill.page === "lhb") content = React.createElement(KplLhbPage);
                else if (drill.page === "themes") content = React.createElement(KplThemesPage, { go });
                else if (drill.page === "themeDetail") content = React.createElement(KplThemeDetailPage, { id: drill.id, go });
                else if (drill.page === "tika") content = React.createElement(KplTikaPage, { go });
                else if (drill.page === "tikaDetail") content = React.createElement(KplTikaDetailPage, { id: drill.id, name: drill.name, go });
                else if (drill.page === "poprank") content = React.createElement(KplPopRankPage, { go });
                else if (drill.page === "qiangdu") content = React.createElement(KplQiangduPage, { go });
                else content = React.createElement(KplOverview, { go });
            } else if (activeNav === "home") {
                content = React.createElement(KplHomePage, { go, status, reloadStatus: loadStatus });
            } else if (activeNav === "market") {
                content = React.createElement(KplMarketPage, { go });
            } else if (activeNav === "watchlist") {
                content = React.createElement(KplWatchPage, { go });
            } else if (activeNav === "lhb") {
                content = React.createElement(KplLhbPage);
            } else {
                content = React.createElement(KplRecommendPage);
            }

            return React.createElement("div", { className: "kpl-app" },
                React.createElement("div", { className: "kpl-content" }, content),
                React.createElement(KplBottomNav, { active: activeNav, onChange: switchNav }));
        }

        // 兼容：KplOverview 用于首页（一期保留名称）
        function KplOverview({ go, status, reloadStatus }) {
            return React.createElement(KplHomePage, { go, status, reloadStatus });
        }

        // ============= 主面板 =============
        // ============= 主面板 =============
        const TABS = [
            { id: "timing", label: "⏱ 择时" },
            { id: "sentiment", label: "🔥 情绪风格" },
            { id: "sector", label: "🧩 板块" },
            { id: "position", label: "💼 持仓仓位" },
            { id: "alert", label: "⚠️ 预警" },
            { id: "screen", label: "🔍 选股" },
            { id: "news", label: "🌐 舆情联动" },
            { id: "kpl", label: "🚀 开盘啦" },
            { id: "system", label: "⚙️ 系统" },
        ];

        function WatchlistPanel(props) {
            const [tab, setTab] = useState("timing");
            const [liveAlerts, setLiveAlerts] = useState([]);
            const [connected, setConnected] = useState(false);
            const [selectedStock, setSelectedStock] = useState(null);
            const [backendStatus, setBackendStatus] = useState({ state: "starting", error: null, retrying: false });
            const [refreshTick, setRefreshTick] = useState(0);
            const sockRef = useRef(null);
            const statusPollRef = useRef(null);

            // 轮询后端状态
            useEffect(() => {
                let mounted = true;
                const poll = async () => {
                    if (!mounted) return;
                    try {
                        const resp = await fetch(`${PLUGIN_API_BASE}/health`);
                        if (resp.ok) {
                            setBackendStatus({ state: "running", error: null, retrying: false });
                        } else {
                            setBackendStatus({ state: "failed", error: `HTTP ${resp.status}`, retrying: false });
                        }
                    } catch {
                        setBackendStatus({ state: "starting", error: "等待后端响应...", retrying: false });
                    }
                };
                poll();
                statusPollRef.current = setInterval(poll, 3000);
                return () => {
                    mounted = false;
                    if (statusPollRef.current) clearInterval(statusPollRef.current);
                };
            }, []);

            useEffect(() => () => sockRef.current?.close(), []);

            // WebSocket：接收预警推送
            useEffect(() => {
                if (backendStatus.state !== "running") return;
                const ws = new WebSocket(PLUGIN_API_BASE.replace("http", "ws") + "/ws");
                sockRef.current = ws;
                ws.onopen = () => setConnected(true);
                ws.onmessage = (e) => {
                    try {
                        const msg = JSON.parse(e.data);
                        if (msg.type === "alert") {
                            setLiveAlerts((prev) => [msg.data, ...prev].slice(0, 20));
                            setRefreshTick((t) => t + 1); // 触发持仓Tab刷新
                            showNotification(msg.data);
                        }
                    } catch { /* ignore */ }
                };
                ws.onclose = () => { setConnected(false); };
                ws.onerror = () => ws.close();
                return () => ws.close();
            }, [backendStatus.state]);

            function showNotification(alert) {
                const title = ALERT_TYPE_LABEL[alert.type] ? `${ALERT_TYPE_LABEL[alert.type]} 预警` : "⚠️ 行情预警";
                if (window.__DSH_NOTIFY__) window.__DSH_NOTIFY__({ type: alert.severity === "high" ? "error" : "warning", title, message: alert.message });
                if ("Notification" in window && Notification.permission === "granted") {
                    new Notification(title, { body: alert.message });
                }
            }

            const backendOk = backendStatus.state === "running";
            const openStock = (s) => setSelectedStock(s);

            const tabContent = {
                timing: React.createElement(TimingTab, { openStock }),
                sentiment: React.createElement(SentimentTab, { openStock }),
                sector: React.createElement(SectorTab, { openStock }),
                position: React.createElement(PositionTab, { openStock, refreshTick }),
                alert: React.createElement(AlertTab, { openStock, liveAlerts }),
                screen: React.createElement(ScreenTab, { openStock }),
                news: React.createElement(NewsTab, { openStock }),
                kpl: React.createElement(KplTab, null),
                system: React.createElement(SystemTab),
            }[tab];

            return React.createElement("div", { className: "dsh-stock-panel" },
                React.createElement("div", { className: "dsh-stock-header" },
                    React.createElement("span", null, "📈 股票监控"),
                    React.createElement("span", { className: `dsh-stock-status ${connected ? "ok" : "off"}` },
                        backendOk ? (connected ? "● 实时" : "○ 连接中") : "○ 后端未启动")),
                !backendOk && React.createElement("div", { className: "dsh-stock-backend-banner" },
                    "⚠️ 后端服务连接中，数据就绪后自动恢复（进程状态与重启见 ⚙️ 系统 Tab）"),
                React.createElement("div", { className: "dsh-stock-tabs" },
                    TABS.map((t) =>
                        React.createElement("button", {
                            key: t.id,
                            className: `dsh-stock-tab ${tab === t.id ? "active" : ""}`,
                            onClick: () => setTab(t.id),
                        }, t.label))),
                React.createElement("div", { className: "dsh-stock-tab-content" }, tabContent),
                React.createElement("div", { className: "dsh-stock-footer" },
                    `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })} · 仅监控不交易 · 红涨绿跌`),
                selectedStock && React.createElement(KLineModal, {
                    code: selectedStock.code,
                    name: selectedStock.name,
                    onClose: () => setSelectedStock(null),
                })
            );
        }

        // ============= 样式 =============
        const STYLE_ID = "dsh-plugin-stock-styles";
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
                .dsh-stock-panel { padding: 8px; font-size: 12px; }
                .dsh-stock-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 0 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); margin-bottom: 8px; font-weight: 600; }
                .dsh-stock-status.ok { color: #22c55e; }
                .dsh-stock-status.off { color: #f59e0b; }
                .dsh-stock-footer { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); font-size: 10px; color: var(--dsw-alias-label-secondary); text-align: center; }
                .dsh-stock-loading { padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary); }
                .up { color: #ef4444; }
                .down { color: #22c55e; }
                .mid { color: #f59e0b; }
                /* Tabs */
                .dsh-stock-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l2); margin-bottom: 10px; flex-wrap: wrap; }
                .dsh-stock-tab { background: transparent; border: none; color: var(--dsw-alias-label-secondary); padding: 6px 10px; cursor: pointer; font-size: 12px; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; }
                .dsh-stock-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
                .dsh-stock-tab.active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-button-primary, #3b82f6); font-weight: 600; }
                .dsh-stock-tab-body { display: flex; flex-direction: column; gap: 10px; }
                /* 指数卡 */
                .dsh-stock-indices { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
                .dsh-stock-idx { display: flex; flex-direction: column; padding: 6px 4px; background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; align-items: center; gap: 1px; }
                .dsh-stock-idx .name { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-idx .pt { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
                .dsh-stock-idx .pct { font-size: 11px; font-weight: 600; }
                .dsh-stock-idx.up .pt, .dsh-stock-idx.up .pct { color: #ef4444; }
                .dsh-stock-idx.down .pt, .dsh-stock-idx.down .pct { color: #22c55e; }
                /* 阶段徽章 */
                .dsh-stock-stage-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
                .dsh-stock-stage-badge { padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 13px; }
                .dsh-stock-stage-badge.good { background: rgba(239,68,68,.15); color: #ef4444; }
                .dsh-stock-stage-badge.mid { background: rgba(245,158,11,.15); color: #f59e0b; }
                .dsh-stock-stage-badge.bad { background: rgba(34,197,94,.15); color: #22c55e; }
                .dsh-stock-position-badge { padding: 4px 12px; border-radius: 12px; background: var(--dsw-alias-button-elevated-fill); font-weight: 600; }
                .dsh-stock-detail { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
                .dsh-stock-action { padding: 8px 10px; background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; font-size: 12px; }
                .dsh-stock-rhythm { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
                /* 卡片 */
                .dsh-stock-card { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
                .dsh-stock-card-title { font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
                .dsh-stock-badge { font-size: 10px; padding: 1px 8px; border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); }
                .dsh-stock-badge.good { background: rgba(239,68,68,.15); color: #ef4444; }
                .dsh-stock-conclusion { font-size: 11px; font-weight: 500; }
                /* 清单 */
                .dsh-stock-checklist { display: flex; flex-direction: column; gap: 3px; }
                .dsh-stock-check { display: flex; align-items: baseline; gap: 6px; padding: 3px 6px; border-radius: 4px; font-size: 11px; }
                .dsh-stock-check.hit { background: rgba(239,68,68,.08); }
                .dsh-stock-check.miss { opacity: .75; }
                .dsh-stock-check.skip { opacity: .5; }
                .dsh-stock-check-mark { width: 14px; font-weight: 700; }
                .dsh-stock-check.hit .dsh-stock-check-mark { color: #ef4444; }
                .dsh-stock-check.miss .dsh-stock-check-mark { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-check-name { flex: 1; }
                .dsh-stock-check-value { color: var(--dsw-alias-label-secondary); margin-left: 6px; font-variant-numeric: tabular-nums; }
                .dsh-stock-check-note { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                /* 情绪统计 */
                .dsh-stock-stat-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
                .dsh-stock-stat { background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; padding: 8px 4px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
                .dsh-stock-stat .label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-stat .value { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
                .dsh-stock-stat.up .value { color: #ef4444; }
                .dsh-stock-stat.down .value { color: #22c55e; }
                .dsh-stock-stat.mid .value { color: #f59e0b; }
                /* 风格条 */
                .dsh-stock-style-bar { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
                .dsh-stock-style-bar .pole { font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
                .dsh-stock-style-track { flex: 1; position: relative; height: 22px; background: linear-gradient(90deg, rgba(239,68,68,.25), rgba(148,163,184,.2), rgba(34,197,94,.25)); border-radius: 11px; }
                .dsh-stock-style-marker { position: absolute; top: -2px; width: 4px; height: 26px; background: var(--dsw-alias-label-primary); border-radius: 2px; transform: translateX(-2px); box-shadow: 0 0 4px rgba(0,0,0,.5); }
                .dsh-stock-style-zones { position: absolute; inset: 0; display: flex; justify-content: space-between; align-items: center; padding: 0 6px; font-size: 9px; color: var(--dsw-alias-label-secondary); pointer-events: none; }
                .dsh-stock-style-label { text-align: center; font-size: 13px; font-weight: 700; }
                .dsh-stock-factors { display: flex; flex-direction: column; gap: 3px; }
                .dsh-stock-factor { display: flex; gap: 6px; font-size: 11px; align-items: baseline; }
                .dsh-stock-factor-tag { font-size: 9px; padding: 1px 5px; border-radius: 6px; white-space: nowrap; }
                .dsh-stock-factor-tag.up { background: rgba(239,68,68,.12); color: #ef4444; }
                .dsh-stock-factor-tag.down { background: rgba(34,197,94,.12); color: #22c55e; }
                /* 连板梯队 */
                .dsh-stock-ladder { display: flex; flex-direction: column; gap: 3px; }
                .dsh-stock-ladder-row { display: flex; gap: 8px; align-items: baseline; }
                .dsh-stock-ladder-h { min-width: 52px; font-weight: 700; font-size: 11px; color: #f59e0b; }
                .dsh-stock-ladder-h.hot { color: #ef4444; }
                .dsh-stock-ladder-stocks { display: flex; flex-wrap: wrap; gap: 4px; }
                .dsh-stock-ladder-stock { padding: 1px 6px; background: var(--dsw-alias-bg-base); border-radius: 8px; cursor: pointer; font-size: 11px; }
                .dsh-stock-ladder-stock:hover { color: #ef4444; }
                /* 板块表 */
                .dsh-stock-seg { display: flex; gap: 4px; }
                .dsh-stock-seg button, .dsh-stock-seg-btn { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                .dsh-stock-seg button.active, .dsh-stock-seg-btn.active { background: var(--dsw-alias-button-primary, #3b82f6); color: white; border-color: transparent; font-weight: 600; }
                .dsh-stock-table { display: flex; flex-direction: column; font-size: 11px; }
                .dsh-stock-thead, .dsh-stock-trow { display: grid; grid-template-columns: 1.6fr .8fr .9fr .9fr .7fr 1.3fr; gap: 4px; padding: 5px 6px; align-items: center; }
                .dsh-stock-thead { color: var(--dsw-alias-label-secondary); font-size: 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .dsh-stock-trow { border-radius: 4px; cursor: pointer; }
                .dsh-stock-trow:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .dsh-stock-trow .num { font-variant-numeric: tabular-nums; text-align: right; }
                .dsh-stock-bname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .dsh-stock-stage-chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; }
                .dsh-stock-stage-chip.good { background: rgba(239,68,68,.15); color: #ef4444; }
                .dsh-stock-stage-chip.up { background: rgba(239,68,68,.1); color: #ef4444; }
                .dsh-stock-stage-chip.hot { background: #ef4444; color: white; }
                .dsh-stock-stage-chip.down { background: rgba(34,197,94,.15); color: #22c55e; }
                .dsh-stock-stage-chip.mid { background: rgba(148,163,184,.15); color: var(--dsw-alias-label-secondary); }
                .dsh-stock-leader { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
                .dsh-stock-leaders { background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 8px; margin: 2px 0 6px; display: flex; flex-direction: column; gap: 4px; }
                .dsh-stock-leaders-title { font-weight: 600; font-size: 11px; }
                .dsh-stock-leader-row { display: grid; grid-template-columns: 28px 1.4fr .7fr 2fr; gap: 6px; align-items: baseline; padding: 3px 4px; border-radius: 4px; cursor: pointer; }
                .dsh-stock-leader-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .dsh-stock-leader-row .rank { color: #f59e0b; font-weight: 700; }
                .dsh-stock-leader-row .num { text-align: right; }
                .dsh-stock-leader-reason { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .dsh-stock-empty-inline { padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 11px; }
                /* 持仓 */
                .dsh-stock-account-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
                .dsh-stock-account-label { font-weight: 600; }
                .dsh-stock-input { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 4px; padding: 5px 8px; font-size: 11px; width: 130px; }
                .dsh-stock-input.sm { width: 100px; }
                .dsh-stock-select { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 4px; padding: 4px 6px; font-size: 11px; }
                .dsh-stock-btn { background: var(--dsw-alias-button-primary, #3b82f6); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
                .dsh-stock-btn.sm { padding: 4px 10px; font-size: 11px; }
                .dsh-stock-btn.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
                .dsh-stock-btn.danger { background: rgba(239,68,68,.12); color: #ef4444; }
                .dsh-stock-btn:disabled { opacity: .5; cursor: not-allowed; }
                .dsh-stock-btn:hover:not(:disabled) { opacity: .85; }
                .dsh-stock-form { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
                .dsh-stock-form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
                .dsh-stock-form-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
                .dsh-stock-form-label { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-form-hint { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-position-track { position: relative; height: 18px; background: var(--dsw-alias-bg-base); border-radius: 9px; overflow: hidden; }
                .dsh-stock-position-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #f59e0b); border-radius: 9px; transition: width .4s; }
                .dsh-stock-position-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,.4); }
                .dsh-stock-warnings { display: flex; flex-direction: column; gap: 2px; }
                .dsh-stock-warning { font-size: 11px; color: #f59e0b; background: rgba(245,158,11,.08); padding: 3px 8px; border-radius: 4px; }
                .dsh-stock-note { font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-holdings { display: flex; flex-direction: column; gap: 6px; }
                .dsh-stock-holding { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
                .dsh-stock-holding-main { display: flex; justify-content: space-between; cursor: pointer; }
                .dsh-stock-holding-main .name { font-weight: 600; }
                .dsh-stock-holding-main:hover .name { color: var(--dsw-alias-button-primary, #3b82f6); }
                .dsh-stock-holding-info { display: flex; justify-content: space-between; font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-holding-advice { max-width: 65%; text-align: right; }
                .dsh-stock-holding-ops { display: flex; gap: 6px; align-items: center; }
                /* 预警 */
                .dsh-stock-alert { padding: 4px 6px; border-radius: 4px; font-size: 11px; }
                .dsh-stock-alert.high { background: rgba(239,68,68,.1); color: #ef4444; }
                .dsh-stock-alert.medium { background: rgba(245,158,11,.1); color: #f59e0b; }
                .dsh-stock-alert.low, .dsh-stock-alert.undefined { background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-secondary); }
                .dsh-stock-alert-time { font-variant-numeric: tabular-nums; opacity: .7; margin-right: 4px; }
                .dsh-stock-rule { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; border-radius: 4px; }
                .dsh-stock-rule.off { opacity: .45; }
                .dsh-stock-rule-text { font-size: 11px; }
                .dsh-stock-rule-ops { display: flex; gap: 4px; }
                .dsh-stock-check-inline { display: flex; gap: 4px; align-items: center; cursor: pointer; }
                /* 选股 */
                .dsh-stock-screen-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
                .dsh-stock-screen-btn { background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 10px 6px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; align-items: center; }
                .dsh-stock-screen-btn:hover:not(:disabled) { border-color: var(--dsw-alias-button-primary, #3b82f6); }
                .dsh-stock-screen-btn:disabled { opacity: .5; cursor: not-allowed; }
                .dsh-stock-screen-btn .name { font-weight: 600; font-size: 12px; }
                .dsh-stock-screen-btn .desc { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-pool-row { display: flex; gap: 12px; align-items: center; font-size: 11px; }
                .dsh-stock-pool-status { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-srow { display: flex; gap: 8px; align-items: baseline; padding: 4px 6px; border-radius: 4px; cursor: pointer; flex-wrap: wrap; }
                .dsh-stock-srow:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .dsh-stock-srow .num { font-variant-numeric: tabular-nums; }
                .dsh-stock-srow-reason { font-size: 10px; color: var(--dsw-alias-label-secondary); flex-basis: 100%; padding-left: 4px; }
                .dsh-stock-error-box { padding: 8px 10px; border-radius: 6px; background: rgba(245,158,11,.08); color: #f59e0b; font-size: 11px; }
                /* Tab 头部与刷新 */
                .dsh-stock-tab-head { display: flex; align-items: center; gap: 8px; }
                .dsh-stock-tab-title { font-weight: 700; font-size: 13px; flex: 1; }
                .dsh-stock-src-tag { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-refresh { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 4px; width: 24px; height: 24px; cursor: pointer; font-size: 13px; line-height: 1; }
                .dsh-stock-refresh:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-button-primary, #3b82f6); }
                .dsh-stock-refresh.spin { animation: dsh-spin 1s linear infinite; color: var(--dsw-alias-button-primary, #3b82f6); }
                @keyframes dsh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                .dsh-stock-loadingbar { height: 2px; background: linear-gradient(90deg, transparent, var(--dsw-alias-button-primary, #3b82f6), transparent); animation: dsh-slide 1.2s ease infinite; border-radius: 1px; }
                @keyframes dsh-slide { 0% { opacity: .3; } 50% { opacity: 1; } 100% { opacity: .3; } }
                /* 表单字段 */
                .dsh-stock-field { display: flex; flex-direction: column; gap: 3px; }
                .dsh-stock-field.inline { flex-direction: row; align-items: center; gap: 6px; }
                .dsh-stock-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-textarea { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 4px; padding: 6px 8px; font-size: 11px; min-height: 54px; resize: vertical; font-family: inherit; }
                /* 系统Tab */
                .dsh-stock-sys-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
                .dsh-stock-sys-item { background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
                .dsh-stock-sys-item .label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-sys-item .value { font-size: 12px; font-weight: 600; word-break: break-all; }
                .dsh-stock-probe-list { display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow-y: auto; }
                .dsh-stock-probe-row { display: grid; grid-template-columns: 1.4fr 1fr auto; gap: 6px; padding: 3px 6px; border-radius: 4px; font-size: 11px; font-variant-numeric: tabular-nums; }
                .dsh-stock-probe-row.ok .status { color: #22c55e; }
                .dsh-stock-probe-row.no_data .status { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-probe-row.timeout .status { color: #ef4444; }
                .dsh-stock-probe-row .ms { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-logs { display: flex; flex-direction: column; gap: 1px; max-height: 220px; overflow-y: auto; background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 6px; font-family: var(--dsh-font-mono, monospace); }
                .dsh-stock-log-line { display: flex; gap: 6px; font-size: 10px; line-height: 1.6; }
                .dsh-stock-log-line .t { color: var(--dsw-alias-label-secondary); flex: none; }
                .dsh-stock-log-line .lv { flex: none; width: 52px; font-weight: 600; }
                .dsh-stock-log-line.WARNING .lv { color: #f59e0b; }
                .dsh-stock-log-line.ERROR .lv { color: #ef4444; }
                .dsh-stock-log-line.INFO .lv { color: #3b82f6; }
                .dsh-stock-log-line .mod { color: var(--dsw-alias-label-secondary); flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
                .dsh-stock-log-line .txt { word-break: break-all; }
                .dsh-stock-cfg-msg { font-size: 11px; }
                /* K线弹窗（显式配色，不依赖主题变量，避免深色主题下文字不可见） */
                .dsh-stock-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 9999; display: flex; align-items: center; justify-content: center; }
                .dsh-stock-modal { background: #171b26; color: #e8eaf0; border-radius: 12px; width: 90vw; max-width: 900px; height: 80vh; max-height: 600px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.5); position: relative; border: 1px solid #2a3040; }
                .dsh-stock-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2a3040; font-size: 16px; font-weight: 600; color: #e8eaf0; }
                .dsh-stock-modal-header .close-btn { background: transparent; border: none; color: #9aa3b5; font-size: 18px; cursor: pointer; padding: 0 4px; }
                .dsh-stock-modal-header .close-btn:hover { color: #e8eaf0; }
                .dsh-stock-periods { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid #2a3040; }
                .dsh-stock-periods button { background: transparent; border: 1px solid #3a4254; color: #b8c0d0; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
                .dsh-stock-periods button.active { background: #2b344a; color: #fff; font-weight: 600; border-color: #4a90d9; }
                .dsh-stock-kline { flex: 1; min-height: 0; background: #171b26; }
                .dsh-stock-modal-overlay { position: absolute; top: 100px; left: 0; right: 0; padding: 20px; text-align: center; color: #9aa3b5; pointer-events: none; }
                .dsh-stock-modal-overlay.error { color: #ef4444; }
                /* 后端状态卡 */
                .dsh-stock-backend-banner { padding: 6px 10px; border-radius: 6px; margin-bottom: 8px; background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.3); color: #f59e0b; font-size: 11px; }
                /* 导航行入口（样式语言对齐 任务看板/SSH/记忆系统 的注入行） */
                .dsh-stock-entry { width: 100%; height: 32px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; background: 0 0; border: none; border-radius: 8px; align-items: center; gap: 8px; padding: 0 12px; font-size: 13px; display: flex; }
                .dsh-stock-entry:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-primary); }
                .dsh-stock-entry[data-active] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
                .dsh-stock-entry-icon { flex: none; justify-content: center; align-items: center; display: inline-flex; }
                .dsh-stock-entry-label { text-overflow: ellipsis; overflow: hidden; }
                [data-dsh-frame][data-sidebar-collapsed] .dsh-stock-entry { justify-content: center; width: 100%; padding: 0; }
                [data-dsh-frame][data-sidebar-collapsed] .dsh-stock-entry-label { display: none; }
                /* 右侧整页视图（与任务看板同款：绝对定位铺满会话列，激活属性切换显隐） */
                [data-dsh-stock-view] { z-index: 60; background: var(--dsw-alias-bg-base); display: none; position: absolute; inset: 0; overflow: hidden; }
                html[data-dsh-stock-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-mnemon-active]) [data-dsh-stock-view] { display: block; }
                html[data-dsh-stock-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-mnemon-active]) [data-pane="conversation"] > :not([data-dsh-stock-view]),
                html[data-dsh-stock-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-mnemon-active]) [class*="centerCol"] > :not([data-dsh-stock-view]) { display: none !important; }
                [data-dsh-stock-view] .dsh-stock-panel { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 14px 16px; max-width: 960px; margin: 0 auto; }
                /* ===== 舆情联动 Tab ===== */
                .dsh-stock-news-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .dsh-stock-news-filter { display: flex; gap: 2px; margin-right: auto; }
                .dsh-stock-news-toolbar button { background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                .dsh-stock-news-toolbar button:hover { color: var(--dsw-alias-label-primary); }
                .dsh-stock-news-toolbar button.active { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-button-primary, #3b82f6); font-weight: 600; }
                /* 舆情列表项 */
                .dsh-stock-news-list { display: flex; flex-direction: column; gap: 8px; }
                .dsh-stock-news-item { background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; }
                .dsh-stock-news-item.positive { border-left: 3px solid #ef4444; }
                .dsh-stock-news-item.negative { border-left: 3px solid #22c55e; }
                .dsh-stock-news-item-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
                .dsh-stock-news-item-src { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-news-item-time { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-left: auto; }
                .dsh-stock-news-item-imp { font-size: 10px; white-space: nowrap; }
                .dsh-stock-news-item-title { font-size: 12px; font-weight: 600; line-height: 1.4; }
                .dsh-stock-news-item-content { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .dsh-stock-news-item-link { font-size: 10px; color: var(--dsw-alias-button-primary, #3b82f6); text-decoration: none; display: inline-block; margin-top: 3px; }
                .dsh-stock-news-tags { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin-top: 5px; }
                .dsh-stock-news-tags-label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-sector-tag { font-size: 10px; padding: 1px 7px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); }
                .dsh-stock-sector-tag.positive { background: rgba(239,68,68,.15); color: #ef4444; }
                .dsh-stock-sector-tag.negative { background: rgba(34,197,94,.15); color: #22c55e; }
                .dsh-stock-stock-tag { font-size: 10px; padding: 1px 7px; border-radius: 8px; background: rgba(59,130,246,.12); color: var(--dsw-alias-button-primary, #3b82f6); }
                .dsh-stock-advice-btn { background: rgba(245,158,11,.12); color: #f59e0b; border: 1px solid rgba(245,158,11,.4); padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-top: 6px; }
                .dsh-stock-advice-btn:hover { background: rgba(245,158,11,.22); }
                .dsh-stock-news-footer { text-align: center; font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
                /* 实时推送 */
                .dsh-stock-live-box { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.3); border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; }
                .dsh-stock-live-title { font-size: 11px; font-weight: 600; color: #f59e0b; margin-bottom: 3px; }
                .dsh-stock-live-item { display: flex; gap: 6px; align-items: baseline; font-size: 11px; padding: 1px 0; }
                .dsh-stock-live-imp { font-size: 9px; }
                .dsh-stock-live-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .dsh-stock-live-time { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                /* 事件日历 */
                .dsh-stock-cal-panel { background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
                .dsh-stock-cal-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 12px; margin-bottom: 6px; }
                .dsh-stock-cal-gen { background: rgba(59,130,246,.12); color: var(--dsw-alias-button-primary, #3b82f6); border: 1px solid rgba(59,130,246,.4); padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 10px; }
                .dsh-stock-cal-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
                .dsh-stock-cal-day.today { background: rgba(59,130,246,.07); border-radius: 6px; margin: -2px -4px; padding: 2px 4px; }
                .dsh-stock-cal-date { font-size: 11px; font-weight: 600; margin-bottom: 2px; }
                .dsh-stock-cal-urgent { color: #f59e0b; font-size: 10px; font-weight: 600; }
                .dsh-stock-cal-event { display: flex; gap: 6px; align-items: baseline; font-size: 11px; padding: 1px 0 1px 8px; }
                .dsh-stock-cal-event-imp { font-size: 9px; }
                .dsh-stock-cal-event-name { flex: 1; }
                .dsh-stock-cal-event-country { font-size: 10px; }
                /* 关键词管理 */
                .dsh-stock-kw-panel { background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
                .dsh-stock-kw-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
                .dsh-stock-kw-tabs button { background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--dsw-alias-label-secondary); padding: 4px 10px; cursor: pointer; font-size: 11px; }
                .dsh-stock-kw-tabs button.active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-button-primary, #3b82f6); font-weight: 600; }
                .dsh-stock-kw-add { display: flex; gap: 4px; margin-bottom: 8px; }
                .dsh-stock-kw-add input { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 4px; padding: 4px 8px; font-size: 11px; }
                .dsh-stock-kw-add input:first-child { flex: 1; }
                .dsh-stock-kw-cat { width: 80px !important; }
                .dsh-stock-kw-imp { width: 52px !important; }
                .dsh-stock-kw-add-btn { background: var(--dsw-alias-button-primary, #3b82f6); color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap; }
                .dsh-stock-kw-list { display: flex; flex-direction: column; gap: 4px; }
                .dsh-stock-kw-item { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 4px; background: var(--dsw-alias-interactive-bg-hover); font-size: 11px; }
                .dsh-stock-kw-word { font-weight: 600; }
                .dsh-stock-kw-meta { color: var(--dsw-alias-label-secondary); font-size: 10px; margin-left: auto; }
                .dsh-stock-kw-reason { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
                .dsh-stock-kw-del { background: transparent; border: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 0 4px; }
                .dsh-stock-kw-del:hover { color: #ef4444; }
                .dsh-stock-kw-sug-main { flex: 1; min-width: 0; }
                .dsh-stock-kw-sug-btns { display: flex; gap: 4px; }
                .dsh-stock-kw-accept { background: rgba(34,197,94,.15); color: #22c55e; border: 1px solid rgba(34,197,94,.4); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; white-space: nowrap; }
                /* 投资建议弹窗 */
                .dsh-stock-adv-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 100; display: flex; align-items: center; justify-content: center; }
                .dsh-stock-adv-content { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 14px 16px; width: 90%; max-width: 560px; max-height: 80vh; overflow-y: auto; }
                .dsh-stock-adv-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 13px; margin-bottom: 10px; }
                .dsh-stock-adv-close { background: transparent; border: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 16px; padding: 4px 10px; margin: -4px -6px 0 0; }
                .dsh-stock-adv-close:hover { color: var(--dsw-alias-label-primary); }
                .dsh-stock-advice-sec { margin-bottom: 10px; }
                .dsh-stock-advice-sec-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }
                .dsh-stock-advice-news-title { font-size: 12px; font-weight: 600; line-height: 1.4; }
                .dsh-stock-advice-news-meta { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
                .dsh-stock-advice-sector { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 4px 6px; border-radius: 4px; background: var(--dsw-alias-interactive-bg-hover); margin-bottom: 3px; font-size: 11px; }
                .dsh-stock-advice-sector-name { font-weight: 600; }
                .dsh-stock-advice-sector.positive .dsh-stock-advice-sector-dir { color: #ef4444; }
                .dsh-stock-advice-sector.negative .dsh-stock-advice-sector-dir { color: #22c55e; }
                .dsh-stock-advice-sector-rel { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .dsh-stock-advice-sector-reason { width: 100%; font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-advice-tip { padding: 6px 8px; border-radius: 6px; background: var(--dsh-alias-interactive-bg-hover, var(--dsw-alias-interactive-bg-hover)); margin-bottom: 6px; }
                .dsh-stock-advice-tip-stock { font-size: 11px; font-weight: 600; margin-bottom: 2px; }
                .dsh-stock-advice-tip-text { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
                /* 弹窗实时板块/龙头（0.4.1） */
                .dsh-stock-adv-pct { font-size: 10px; font-weight: 600; }
                .dsh-stock-adv-pct.up { color: #ef4444; }
                .dsh-stock-adv-pct.down { color: #22c55e; }
                .dsh-stock-adv-mom { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-adv-stage { font-size: 9px; padding: 1px 6px; border-radius: 8px; background: rgba(59,130,246,.14); color: var(--dsw-alias-button-primary, #3b82f6); font-weight: 600; }
                .dsh-stock-adv-leader { display: flex; gap: 6px; align-items: baseline; padding: 5px 8px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover); margin-bottom: 4px; cursor: pointer; font-size: 11px; }
                .dsh-stock-adv-leader:hover { background: rgba(59,130,246,.12); }
                .dsh-stock-adv-leader-name { font-weight: 600; }
                .dsh-stock-adv-leader-code { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .dsh-stock-adv-leader-pct { font-weight: 600; margin-left: auto; }
                .dsh-stock-adv-leader-pct.up { color: #ef4444; }
                .dsh-stock-adv-leader-pct.down { color: #22c55e; }
                .dsh-stock-adv-leader-tag { font-size: 9px; padding: 1px 5px; border-radius: 6px; background: rgba(245,158,11,.15); color: #f59e0b; }
                .dsh-stock-adv-leader-reason { font-size: 9px; color: var(--dsw-alias-label-secondary); }
                /* 日历增强（0.4.1） */
                .dsh-stock-cal-est { font-size: 9px; padding: 0 4px; margin-left: 4px; border-radius: 4px; background: rgba(148,163,184,.2); color: var(--dsw-alias-label-secondary); }
                .dsh-stock-cal-src { font-size: 9px; padding: 0 4px; margin-left: 4px; border-radius: 4px; background: rgba(34,197,94,.15); color: #22c55e; }
                .dsh-stock-cal-desc { font-size: 9px; color: var(--dsw-alias-label-secondary); margin-left: 6px; }
                .dsh-stock-cal-secs { margin-left: 4px; }
                .dsh-stock-cal-sec-tag { font-size: 9px; padding: 0 4px; margin-left: 3px; border-radius: 6px; background: rgba(59,130,246,.12); color: var(--dsw-alias-button-primary, #3b82f6); }
                /* 进化统计条（0.4.1） */
                .dsh-stock-evo-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 5px 8px; margin-bottom: 8px; border-radius: 6px; background: rgba(168,85,247,.07); border: 1px solid rgba(168,85,247,.25); font-size: 10px; }
                .dsh-stock-evo-item { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-evo-item:first-child { color: #a855f7; font-weight: 600; }
                .dsh-stock-evo-run { margin-left: auto; background: rgba(168,85,247,.15); color: #a855f7; border: 1px solid rgba(168,85,247,.4); padding: 2px 10px; border-radius: 4px; cursor: pointer; font-size: 10px; }
                .dsh-stock-evo-run:hover { background: rgba(168,85,247,.25); }
                /* ===== 开盘啦 Tab ===== */
                .dsh-stock-kpl-page { display: flex; flex-direction: column; gap: 8px; }
                .dsh-stock-kpl-head { display: flex; align-items: center; gap: 8px; }
                .dsh-stock-kpl-back, .dsh-stock-kpl-nav { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
                .dsh-stock-kpl-back:hover, .dsh-stock-kpl-nav:hover { color: var(--dsw-alias-label-primary); }
                .dsh-stock-kpl-head-title { flex: 1; display: flex; align-items: baseline; gap: 6px; }
                .dsh-stock-kpl-head-title .t { font-weight: 700; font-size: 15px; }
                .dsh-stock-kpl-head-title .c { color: var(--dsw-alias-label-secondary); font-size: 11px; }
                .dsh-stock-kpl-tag { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(59,130,246,.15); color: #60a5fa; }
                .dsh-stock-kpl-bind { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
                .dsh-stock-kpl-bind-title { font-weight: 700; }
                .dsh-stock-kpl-bind-desc { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
                .dsh-stock-kpl-userbar { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 8px 12px; font-size: 12px; font-weight: 600; }
                .dsh-stock-kpl-quick { display: flex; gap: 6px; flex-wrap: wrap; }
                .dsh-stock-kpl-section-title { font-weight: 700; font-size: 12px; margin-top: 2px; }
                .dsh-stock-kpl-sectorlist { display: flex; flex-direction: column; gap: 2px; }
                .dsh-stock-kpl-sectorrow { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr .8fr; gap: 6px; padding: 8px 10px; background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; cursor: pointer; align-items: center; }
                .dsh-stock-kpl-sectorrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .dsh-stock-kpl-sectorrow .name { font-weight: 600; }
                .dsh-stock-kpl-sectorrow .code { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .dsh-stock-kpl-sectorrow .num { text-align: right; font-variant-numeric: tabular-nums; }
                .dsh-stock-kpl-sectorrow .zt { color: #ef4444; font-size: 10px; }
                .dsh-stock-kpl-strength { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
                .dsh-stock-kpl-strength .big { font-size: 20px; font-weight: 800; }
                .dsh-stock-kpl-strength .sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-kpl-ind-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
                .dsh-stock-kpl-ind-grid .item { display: flex; flex-direction: column; gap: 1px; }
                .dsh-stock-kpl-ind-grid .label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-kpl-ind-grid .value { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
                .dsh-stock-kpl-reason { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.3); color: #f59e0b; border-radius: 6px; padding: 6px 10px; font-size: 11px; line-height: 1.5; }
                .dsh-stock-kpl-chart-wrap { display: flex; gap: 6px; }
                .dsh-stock-kpl-chart { flex: 1; background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 6px; min-width: 0; }
                .dsh-stock-kpl-side { display: flex; flex-direction: column; gap: 4px; }
                .dsh-stock-kpl-side button { writing-mode: vertical-rl; text-orientation: upright; background: var(--dsw-alias-button-elevated-fill); border: none; color: var(--dsw-alias-label-secondary); padding: 10px 4px; cursor: pointer; font-size: 12px; border-radius: 4px; }
                .dsh-stock-kpl-side button.active { background: #ef4444; color: white; }
                .dsh-stock-kpl-tabs { display: flex; gap: 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 4px; }
                .dsh-stock-kpl-tabs .on { color: #ef4444; font-weight: 700; border-bottom: 2px solid #ef4444; padding-bottom: 2px; }
                .dsh-stock-kpl-tabs .dim { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-kpl-chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
                .dsh-stock-kpl-chip { flex: none; background: rgba(239,68,68,.5); color: white; border-radius: 4px; padding: 6px 12px; font-size: 11px; cursor: pointer; text-align: center; }
                .dsh-stock-kpl-chip:hover { background: #ef4444; }
                .dsh-stock-kpl-filterchips { display: flex; gap: 6px; flex-wrap: wrap; }
                .dsh-stock-kpl-fchip { border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 14px; padding: 3px 10px; font-size: 10px; cursor: default; }
                .dsh-stock-kpl-fchip.vip { opacity: .55; }
                .dsh-stock-kpl-note { font-size: 10px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
                .dsh-stock-kpl-quotehead { display: flex; gap: 14px; background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 12px; }
                .dsh-stock-kpl-quotehead.up .big, .dsh-stock-kpl-quotehead.up .chg { color: #ef4444; }
                .dsh-stock-kpl-quotehead.down .big, .dsh-stock-kpl-quotehead.down .chg { color: #22c55e; }
                .dsh-stock-kpl-quotehead .big { font-size: 30px; font-weight: 800; font-variant-numeric: tabular-nums; }
                .dsh-stock-kpl-quotehead .chg { font-size: 12px; font-weight: 600; }
                .dsh-stock-kpl-quotehead .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px 12px; flex: 1; }
                .dsh-stock-kpl-quotehead .gi { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; }
                .dsh-stock-kpl-quotehead .k { color: var(--dsw-alias-label-secondary); }
                .dsh-stock-kpl-detail-body { display: flex; gap: 8px; }
                .dsh-stock-kpl-pankou { flex: 1.2; background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 10px; min-width: 0; }
                .dsh-stock-kpl-pankou-title { font-weight: 600; font-size: 11px; margin-bottom: 6px; }
                .dsh-stock-kpl-ladder { display: flex; flex-direction: column; gap: 1px; font-variant-numeric: tabular-nums; }
                .dsh-stock-kpl-ladder-row { display: grid; grid-template-columns: 2.4em 1fr 1fr; gap: 8px; font-size: 11px; padding: 2px 4px; }
                .dsh-stock-kpl-ladder-row .px { text-align: right; }
                .dsh-stock-kpl-ladder-row .vol { text-align: right; color: #60a5fa; }
                .dsh-stock-kpl-ladder-row.sell .px { color: #22c55e; }
                .dsh-stock-kpl-ladder-row.buy .px { color: #ef4444; }
                .dsh-stock-kpl-ladder-sep { height: 2px; background: var(--dsw-alias-border-l2); margin: 3px 0; }
                .dsh-stock-kpl-detail-side { display: flex; flex-direction: column; gap: 6px; width: 130px; }
                .dsh-stock-kpl-mini { background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; padding: 8px; }
                .dsh-stock-kpl-mini .k { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-kpl-mini .v { font-size: 14px; font-weight: 700; }
                .dsh-stock-kpl-actions { display: flex; gap: 6px; }
                .dsh-stock-kpl-groups { display: flex; gap: 4px; flex-wrap: wrap; }
                .dsh-stock-kpl-group { padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer; background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-secondary); }
                .dsh-stock-kpl-group.on { background: #ef4444; color: white; font-weight: 600; }
                .dsh-stock-kpl-wrow { display: flex; gap: 10px; align-items: center; background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; padding: 8px 10px; }
                .dsh-stock-kpl-wrow .name { flex: 1; font-weight: 500; cursor: pointer; }
                .dsh-stock-kpl-wrow .name:hover { color: var(--dsw-alias-button-primary, #3b82f6); }
                .dsh-stock-kpl-wrow .code { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .dsh-stock-kpl-wrow .num { font-variant-numeric: tabular-nums; font-weight: 600; }
                .dsh-stock-kpl-searchbar { display: flex; gap: 6px; align-items: center; }
                .dsh-stock-kpl-srow { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-button-elevated-fill); }
                .dsh-stock-kpl-srow .name { flex: 1; cursor: pointer; }
                .dsh-stock-kpl-srow .name:hover { color: var(--dsw-alias-button-primary, #3b82f6); }
                .dsh-stock-kpl-srow .code { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .dsh-stock-kpl-hotlist { display: flex; flex-direction: column; gap: 2px; }
                .dsh-stock-kpl-hotrow { display: flex; gap: 10px; align-items: center; padding: 5px 8px; border-radius: 4px; font-size: 12px; }
                .dsh-stock-kpl-hotrow .rank { color: #ef4444; font-weight: 700; width: 18px; }
                .dsh-stock-kpl-hotwords { display: flex; gap: 6px; flex-wrap: wrap; }
                .dsh-stock-kpl-hotword { background: var(--dsw-alias-button-elevated-fill); border-radius: 10px; padding: 2px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
                /* ===== KPL App 底部导航 + 新布局 ===== */
                .kpl-app { display: flex; flex-direction: column; height: calc(100vh - 120px); min-height: 500px; overflow: hidden; }
                .kpl-content { flex: 1; overflow-y: auto; min-height: 0; }
                .kpl-bottom-nav { display: flex; background: var(--dsw-alias-bg-base, #1a1a2e); border-top: 1px solid var(--dsw-alias-border-l2); flex-shrink: 0; }
                .kpl-nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 6px 0; cursor: pointer; color: var(--dsw-alias-label-secondary); }
                .kpl-nav-item .ico { font-size: 16px; }
                .kpl-nav-item .lbl { font-size: 10px; margin-top: 1px; }
                .kpl-nav-item.on { color: #ef4444; font-weight: 700; }
                .kpl-page { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
                .kpl-subtabs { display: flex; gap: 14px; overflow-x: auto; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 4px; }
                .kpl-subtab { color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; font-size: 13px; padding: 4px 0; }
                .kpl-subtab.on { color: #ef4444; font-weight: 700; border-bottom: 2px solid #ef4444; }
                .kpl-stat-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
                .kpl-stat-card { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 10px 8px; text-align: center; }
                .kpl-stat-label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .kpl-stat-value { font-size: 16px; font-weight: 700; margin-top: 2px; }
                .kpl-sector-table { display: flex; flex-direction: column; gap: 4px; }
                .kpl-sector-row { display: grid; grid-template-columns: 1.2fr 1fr 1fr .8fr; gap: 4px; background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; padding: 10px 10px; cursor: pointer; align-items: center; }
                .kpl-sector-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .kpl-sector-name .n { font-weight: 600; font-size: 13px; }
                .kpl-sector-name .c { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .kpl-sector-num { text-align: right; }
                .kpl-sector-num .strong { font-size: 15px; font-weight: 700; }
                .kpl-sector-num .pct { font-size: 12px; display: block; }
                .kpl-sector-num .up { color: #ef4444; }
                .kpl-sector-num .down { color: #22c55e; }
                .kpl-sector-zt { font-size: 10px; color: #ef4444; text-align: center; }
                .kpl-func-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
                .kpl-func-btn { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 12px 4px; text-align: center; cursor: pointer; font-size: 11px; font-weight: 500; }
                .kpl-func-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .kpl-user-bar { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 8px 12px; font-size: 12px; font-weight: 600; }
                .kpl-hot-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
                .kpl-hot-item { background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; padding: 8px 4px; text-align: center; cursor: pointer; }
                .kpl-hot-item .rank { color: #ef4444; font-weight: 700; display: block; font-size: 14px; }
                .kpl-hot-item .code { font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .kpl-hot-words { display: flex; gap: 6px; flex-wrap: wrap; }
                .kpl-hot-word { background: var(--dsw-alias-button-elevated-fill); border-radius: 10px; padding: 2px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .kpl-page-head { display: flex; align-items: center; gap: 8px; }
                .kpl-head-back, .kpl-head-nav, .kpl-head-search { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
                .kpl-head-back:hover, .kpl-head-nav:hover, .kpl-head-search:hover { color: var(--dsw-alias-label-primary); }
                .kpl-head-center { flex: 1; display: flex; align-items: baseline; gap: 6px; }
                .kpl-head-center .t { font-weight: 700; font-size: 15px; }
                .kpl-head-center .c { color: var(--dsw-alias-label-secondary); font-size: 11px; }
                .kpl-sf-block { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 12px; display: flex; align-items: baseline; gap: 12px; }
                .kpl-sf-big { font-size: 26px; font-weight: 800; }
                .kpl-sf-rank { font-size: 12px; color: var(--dsw-alias-label-secondary); }
                .kpl-sf-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 4px; }
                .kpl-sf-item { display: flex; flex-direction: column; gap: 1px; }
                .kpl-sf-item .k { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .kpl-sf-item .v { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
                .kpl-sf-item .v.up { color: #ef4444; }
                .kpl-sf-item .v.down { color: #22c55e; }
                .kpl-son-chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
                .kpl-son-label { font-size: 10px; color: var(--dsw-alias-label-secondary); writing-mode: vertical-rl; text-align: center; }
                .kpl-son-chip { flex: none; background: rgba(239,68,68,.4); color: white; border-radius: 4px; padding: 8px 14px; font-size: 12px; cursor: pointer; text-align: center; }
                .kpl-son-chip:hover { background: #ef4444; }
                .kpl-son-chip b { display: block; font-size: 13px; }
                .kpl-son-chip span { font-size: 11px; opacity: .85; }
                .kpl-ft-chips { display: flex; gap: 6px; flex-wrap: wrap; }
                .kpl-ft-chip { border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 14px; padding: 3px 12px; font-size: 11px; cursor: default; }
                .kpl-ft-chip.locked { opacity: .5; }
                .kpl-note { font-size: 10px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
                .kpl-stock-quote { display: flex; gap: 14px; background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 14px; align-items: flex-start; }
                .kpl-stock-price .big { font-size: 36px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; }
                .kpl-stock-price .chg { font-size: 13px; font-weight: 600; margin-top: 4px; }
                .kpl-stock-price .up { color: #ef4444; }
                .kpl-stock-price .down { color: #22c55e; }
                .kpl-stock-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px 14px; flex: 1; }
                .kpl-sg-item { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; }
                .kpl-sg-item .k { color: var(--dsw-alias-label-secondary); }
                .kpl-stock-ladder-wrap { display: flex; gap: 8px; }
                .kpl-stock-ladder-wrap > :first-child { flex: 1; }
                .kpl-stock-side { display: flex; flex-direction: column; gap: 6px; width: 120px; }
                .kpl-mini { background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; padding: 8px; }
                .kpl-mini .k { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .kpl-mini .v { font-size: 16px; font-weight: 700; }
                .kpl-stock-actions { display: flex; gap: 6px; }
                .kpl-action-btn { flex: 1; background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
                .kpl-action-btn.star { background: rgba(239,68,68,.12); color: #ef4444; border-color: rgba(239,68,68,.3); }
                .kpl-action-btn:hover { opacity: .85; }
                .kpl-groups { display: flex; gap: 4px; flex-wrap: wrap; }
                .kpl-group-chip { padding: 4px 12px; border-radius: 14px; font-size: 11px; cursor: pointer; background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-secondary); }
                .kpl-group-chip.on { background: #ef4444; color: white; font-weight: 600; }
                .kpl-wrow { display: flex; gap: 10px; align-items: center; background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; padding: 10px 12px; cursor: pointer; }
                .kpl-wrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .kpl-wrow-info { flex: 1; }
                .kpl-wrow-info .n { font-weight: 600; font-size: 13px; }
                .kpl-wrow-info .c { color: var(--dsw-alias-label-secondary); font-size: 10px; }
                .kpl-wrow-quote { text-align: right; }
                .kpl-wrow-quote .px { font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; }
                .kpl-wrow-quote .pct { font-size: 11px; }
                .kpl-wrow-del { background: rgba(239,68,68,.12); border: none; color: #ef4444; border-radius: 4px; width: 28px; height: 28px; cursor: pointer; font-size: 14px; }
                .kpl-add-stock-btn { width: 100%; padding: 12px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 13px; }
                .kpl-add-stock-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); }
                .kpl-search-input { width: 100%; padding: 10px 12px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); font-size: 14px; outline: none; }
                .kpl-search-row { display: flex; gap: 8px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .kpl-search-row .name { flex: 1; cursor: pointer; font-weight: 500; }
                .kpl-search-row .code { color: var(--dsw-alias-label-secondary); font-size: 11px; }
                .kpl-add-btn { background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.3); color: #ef4444; border-radius: 4px; width: 30px; height: 30px; cursor: pointer; font-size: 16px; }
                .kpl-bind { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
                .kpl-bind-h { font-weight: 700; }
                .kpl-bind-d { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
                .kpl-bind-in { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 4px; padding: 8px 10px; font-size: 13px; width: 100%; }
                .kpl-bind-btn { background: #ef4444; color: white; border: none; border-radius: 4px; padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 600; }
                .kpl-bind-btn.ghost { background: var(--dsw-alias-bg-base); color: #ef4444; border: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; min-width: 92px; }
                .kpl-bind-btn:disabled { opacity: .55; cursor: not-allowed; }
                .kpl-bind-msg { font-size: 11px; }
                .kpl-bind-tabs { display: flex; gap: 4px; background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 3px; }
                .kpl-bind-tab { flex: 1; text-align: center; font-size: 12px; padding: 5px 0; border-radius: 4px; cursor: pointer; color: var(--dsw-alias-label-secondary); }
                .kpl-bind-tab.on { background: #ef4444; color: #fff; font-weight: 600; }
                .kpl-bind-row { display: flex; gap: 8px; align-items: stretch; }
                .kpl-bind-remember { display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
                .kpl-user-bar { display: flex; justify-content: space-between; align-items: center; background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 10px 12px; font-size: 13px; }
                .kpl-user-logout { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 11px; }
                .kpl-user-logout:hover { color: #ef4444; border-color: #ef4444; }
                /* ---- 首页模块（复刻App布局） ---- */
                .kpl-sec { background: var(--dsw-alias-button-elevated-fill); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
                .kpl-sec-head { display: flex; justify-content: space-between; align-items: baseline; }
                .kpl-sec-head .t { font-weight: 800; font-size: 15px; }
                .kpl-sec-head .more { font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
                .kpl-sec-head .more:hover { color: #ef4444; }
                .kpl-sec-head .date { font-size: 11px; color: #3b82f6; }
                .kpl-empty { text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 14px 0; }
                .kpl-theme-row { display: flex; gap: 10px; align-items: center; padding: 8px; background: var(--dsw-alias-bg-base); border-radius: 8px; }
                .kpl-theme-badge { min-width: 64px; height: 52px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#dc2626,#ef4444); color: #fff; font-size: 13px; font-weight: 700; border-radius: 6px; padding: 4px; text-align: center; }
                .kpl-theme-main { flex: 1; min-width: 0; }
                .kpl-theme-title { font-size: 13px; font-weight: 600; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .kpl-theme-stocks { display: flex; gap: 8px; margin-top: 5px; flex-wrap: wrap; }
                .kpl-theme-stock { background: var(--dsw-alias-button-elevated-fill); border-radius: 4px; padding: 2px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .kpl-qd-head, .kpl-qd-row { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1.4fr; gap: 6px; align-items: center; font-size: 12px; padding: 6px 4px; }
                .kpl-qd-head { color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .kpl-qd-row { border-bottom: 1px dashed var(--dsw-alias-border-l2); }
                .kpl-qd-row:last-child { border-bottom: none; }
                .kpl-qd-row .name { font-weight: 600; }
                .kpl-qd-row .strength { color: #f59e0b; font-weight: 700; }
                .kpl-qd-row .plates { color: #3b82f6; font-size: 11px; text-align: right; }
                .kpl-flash { background: #1f2937; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; position: relative; overflow: hidden; }
                .kpl-flash-head { display: flex; justify-content: space-between; }
                .kpl-flash-head .t { color: #f3f4f6; font-weight: 800; font-size: 15px; }
                .kpl-flash-item { border-bottom: 1px dashed rgba(255,255,255,.12); padding-bottom: 6px; }
                .kpl-flash-item:last-of-type { border-bottom: none; }
                .kpl-flash-line { color: #e5e7eb; font-size: 12px; line-height: 1.55; }
                .kpl-flash-time { color: #ef4444; font-family: monospace; }
                .kpl-flash-stocks { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
                .kpl-flash-stock { background: rgba(255,255,255,.08); border-radius: 4px; padding: 1px 7px; font-size: 11px; color: #d1d5db; }
                .kpl-flash-foot { font-size: 10px; color: #6b7280; }
                .kpl-sent-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
                .kpl-sent-cell { text-align: center; background: var(--dsw-alias-bg-base); border-radius: 8px; padding: 8px 4px; }
                .kpl-sent-cell .lbl { font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .kpl-sent-cell .val b { font-size: 19px; }
                .kpl-sent-cell .val .yest { font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .kpl-sent-day { font-size: 10px; color: var(--dsw-alias-label-secondary); text-align: right; }
                .kpl-active-plates { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
                .kpl-active-plate { text-align: center; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 4px; cursor: pointer; }
                .kpl-active-plate .n { font-size: 12px; color: #3b82f6; font-weight: 600; }
                .kpl-active-plate .r { font-size: 13px; font-weight: 700; margin-top: 2px; }
                .kpl-tuyere { display: flex; flex-wrap: wrap; gap: 8px; }
                .kpl-tuyere-pill { background: #ef4444; color: #fff; border-radius: 999px; padding: 4px 14px; font-size: 12px; font-weight: 600; }
                .kpl-tuyere-pill b { font-weight: 400; opacity: .85; }
                .kpl-article-row { display: flex; gap: 10px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); cursor: pointer; }
                .kpl-article-row:last-child { border-bottom: none; }
                .kpl-article-main { flex: 1; min-width: 0; }
                .kpl-article-title { font-size: 13px; font-weight: 500; line-height: 1.45; }
                .kpl-article-time { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }
                .kpl-article-thumb { width: 74px; height: 46px; border-radius: 6px; background: linear-gradient(135deg,#f59e0b,#ef4444); display: flex; align-items: center; justify-content: center; font-size: 18px; }
                .kpl-explain-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 9999; display: flex; align-items: center; justify-content: center; }
                .kpl-explain { width: min(560px, 92vw); max-height: 82vh; overflow: auto; background: #fff; color: #111827; border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
                .kpl-explain-head { display: flex; justify-content: center; align-items: center; position: relative; }
                .kpl-explain-head .t { font-size: 17px; font-weight: 800; }
                .kpl-explain-head .x { position: absolute; right: 0; font-size: 16px; cursor: pointer; color: #6b7280; }
                .kpl-explain-body { font-size: 14px; line-height: 1.9; text-indent: 2em; }
                .kpl-explain-more { background: rgba(239,68,68,.12); color: #ef4444; border: none; border-radius: 999px; padding: 10px 0; font-size: 14px; font-weight: 700; cursor: pointer; }
                /* ---- 主题机会页 ---- */
                .kpl-thm-day { display: flex; flex-direction: column; }
                .kpl-thm-dayhead { background: var(--dsw-alias-button-elevated-fill); color: #f59e0b; font-size: 15px; font-weight: 700; text-align: center; padding: 8px 0; }
                .kpl-thm-item { background: var(--dsw-alias-button-elevated-fill); border-radius: 10px; margin: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
                .kpl-thm-top { display: flex; justify-content: space-between; align-items: baseline; }
                .kpl-thm-name { color: #3b82f6; font-size: 16px; font-weight: 800; }
                .kpl-thm-time { color: var(--dsw-alias-label-secondary); font-size: 12px; }
                .kpl-thm-title { font-size: 15px; font-weight: 600; line-height: 1.5; }
                .kpl-thm-stocks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
                .kpl-thm-stock { display: flex; justify-content: space-between; align-items: center; background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 8px 12px; cursor: pointer; }
                .kpl-thm-stock .n { font-size: 13px; }
                .kpl-thm-stock b { font-size: 13px; }
                .kpl-thm-calrow { display: flex; gap: 12px; align-items: flex-start; background: var(--dsw-alias-button-elevated-fill); border-radius: 10px; margin: 8px; padding: 12px; }
                .kpl-thm-tag { min-width: 52px; text-align: center; color: #fff; font-size: 13px; font-weight: 700; border-radius: 999px; padding: 5px 0; }
                .kpl-thm-tag.c1 { background: #ef4444; }
                .kpl-thm-tag.c2 { background: #f59e0b; }
                .kpl-thm-brief { font-size: 15px; font-weight: 600; line-height: 1.6; }
                .kpl-thm-more { margin: 4px 8px 12px; background: var(--dsw-alias-button-elevated-fill); border: 1px dashed var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 8px; padding: 10px 0; cursor: pointer; font-size: 13px; }
                .kpl-thm-more:hover { color: #ef4444; border-color: #ef4444; }
                /* ---- 主题详情页 ---- */
                .kpl-thmd { display: flex; flex-direction: column; }
                .kpl-thmd-title { font-size: 19px; font-weight: 800; line-height: 1.5; padding: 12px 12px 0; }
                .kpl-thmd-meta { display: flex; justify-content: space-between; padding: 8px 12px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .kpl-thmd-intro { display: flex; gap: 12px; align-items: center; background: var(--dsw-alias-button-elevated-fill); margin: 10px 8px; border-radius: 10px; padding: 12px; }
                .kpl-thmd-badge { min-width: 78px; height: 78px; display: flex; align-items: center; justify-content: center; background: rgba(239,68,68,.75); color: #fff; font-size: 15px; font-weight: 700; border-radius: 8px; padding: 6px; text-align: center; }
                .kpl-thmd-desc { font-size: 14px; line-height: 1.8; }
                .kpl-thmd-content { padding: 4px 12px 8px; font-size: 15px; line-height: 2; color: var(--dsw-alias-label-primary); }
                .kpl-thmd-content p { margin: 0 0 10px; }
                .kpl-thmd-stocks { padding: 8px 12px 16px; }
                .kpl-thmd-sthead { color: #ef4444; font-size: 15px; font-weight: 800; padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .kpl-thmd-stock { border-bottom: 1px solid var(--dsw-alias-border-l2); padding: 10px 0; }
                .kpl-thmd-stock:last-child { border-bottom: none; }
                .kpl-thmd-stock .row { display: grid; grid-template-columns: 1fr 1fr 1fr; align-items: center; gap: 8px; }
                .kpl-thmd-stock .name { color: #3b82f6; font-size: 15px; font-weight: 700; cursor: pointer; }
                .kpl-thmd-stock .code { font-size: 14px; font-weight: 600; }
                .kpl-thmd-stock b { text-align: right; font-size: 14px; }
                .kpl-thmd-stock .desc { font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.7; margin-top: 6px; text-indent: 2em; }
                /* ---- 题材库（Socket 实时） ---- */
                .kpl-tika-row { display: flex; gap: 10px; align-items: center; padding: 10px 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); cursor: pointer; }
                .kpl-tika-row:last-child { border-bottom: none; }
                .kpl-tika-row:hover { background: var(--dsw-alias-button-elevated-fill); }
                .kpl-tika-row .rank { width: 22px; text-align: center; color: var(--dsw-alias-label-secondary); font-weight: 700; }
                .kpl-tika-row .rank.hot-rank { background: #f59e0b; color: #fff; border-radius: 4px; font-size: 11px; width: auto; padding: 1px 5px; }
                .kpl-tika-row .name { flex: 1; font-weight: 700; font-size: 14px; }
                .kpl-tika-row .hot { color: #f59e0b; font-size: 12px; min-width: 70px; text-align: right; }
                .kpl-tika-row .zt { color: #ef4444; font-size: 11px; border: 1px solid rgba(239,68,68,.4); border-radius: 4px; padding: 1px 6px; }
                .kpl-tika-row b { min-width: 64px; text-align: right; font-size: 13px; }
                .kpl-tikad-table { padding: 8px 0; }
                .kpl-tikad-thead, .kpl-tikad-trow { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr; gap: 4px; padding: 8px 10px; font-size: 13px; align-items: center; }
                .kpl-tikad-thead { color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .kpl-tikad-trow { border-bottom: 1px dashed var(--dsw-alias-border-l2); }
                .kpl-tikad-trow:last-child { border-bottom: none; }
                .kpl-tikad-trow .n { font-weight: 600; }
                .kpl-tikad-trow b { text-align: right; }
                .kpl-tikad-sthead { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 8px 6px 4px; }
                .kpl-tikad-srow { padding: 10px 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); cursor: pointer; }
                .kpl-tikad-srow:hover { background: var(--dsw-alias-button-elevated-fill); }
                .kpl-tikad-srow .row { display: grid; grid-template-columns: 1.4fr 1fr 1fr; align-items: center; gap: 8px; }
                .kpl-tikad-srow .name { font-weight: 700; font-size: 14px; color: #3b82f6; }
                .kpl-tikad-srow .code { color: var(--dsw-alias-label-secondary); font-size: 13px; }
                .kpl-tikad-srow b { text-align: right; font-size: 14px; }
                .kpl-tikad-srow .meta { display: flex; gap: 12px; margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .kpl-tikad-intro { background: var(--dsw-alias-button-elevated-fill); border-radius: 8px; padding: 10px 12px; margin: 8px; }
                .kpl-tikad-brief { font-size: 13px; line-height: 1.8; color: var(--dsw-alias-label-primary); }
                .kpl-tikad-dates { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
                .kpl-tikad-l1 { margin: 8px; }
                .kpl-tikad-l1name { font-size: 15px; font-weight: 800; padding: 6px 0; border-bottom: 2px solid #ef4444; }
                .kpl-tikad-l2 { margin-top: 8px; }
                .kpl-tikad-l2name { font-size: 13px; font-weight: 700; color: var(--dsw-alias-label-secondary); padding: 4px 0; }
                .kpl-tikad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
                .kpl-tikad-cell { text-align: center; color: #3b82f6; font-size: 13px; padding: 6px 2px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; }
                .kpl-tikad-cell:hover { border-color: #3b82f6; }
                .kpl-tikad-cell.zz { color: #ef4444; font-weight: 600; }
                .kpl-hot-fire { background: #ef4444; color: #fff; font-size: 11px; font-weight: 700; border-radius: 3px; padding: 2px 6px; white-space: nowrap; }
                /* ---- 题材库列表页（App 同款布局） ---- */
                .kpl-tika2-search { margin: 8px; }
                .kpl-tika2-search input { width: 100%; padding: 10px 12px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; color: var(--dsw-alias-label-primary); font-size: 13px; outline: none; }
                .kpl-tika2-head { display: flex; gap: 14px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 12px; color: var(--dsw-alias-label-secondary); }
                .kpl-tika2-head .lbl { flex: 0 0 auto; }
                .kpl-tika2-head .sorts { margin-left: auto; display: flex; gap: 6px; }
                .kpl-tika2-head .s { cursor: pointer; }
                .kpl-tika2-head .s.on { color: #ef4444; font-weight: 700; }
                .kpl-tika2-head .sep { opacity: .5; }
                .kpl-tika2-row { display: flex; align-items: center; gap: 8px; padding: 12px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); cursor: pointer; }
                .kpl-tika2-row:hover { background: var(--dsw-alias-button-elevated-fill); }
                .kpl-tika2-rank { width: 26px; font-weight: 800; font-size: 15px; color: var(--dsw-alias-label-primary); }
                .kpl-tika2-rank.r1 { color: #ef4444; }
                .kpl-tika2-rank.r2 { color: #f97316; }
                .kpl-tika2-rank.r3 { color: #eab308; }
                .kpl-tika2-name { flex: 1; font-size: 15px; font-weight: 600; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
                .kpl-tika2-caret { margin-left: 4px; color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 2px 4px; }
                .kpl-tika2-delta { font-size: 12px; font-weight: 700; min-width: 36px; text-align: right; }
                .kpl-tika2-delta.up { color: #ef4444; }
                .kpl-tika2-delta.down { color: #22c55e; }
                .kpl-tika2-zt { color: #ef4444; font-size: 11px; border: 1px solid rgba(239,68,68,.45); border-radius: 4px; padding: 1px 6px; font-weight: 600; white-space: nowrap; }
                .kpl-tika2-up { font-size: 14px; font-weight: 700; min-width: 44px; text-align: right; }
                /* ---- 题材详情页 v2（App 同款：描述/小表格/个股行情宽表） ---- */
                .kpl-tikad2-desc { background: #efefef; color: #111; border-radius: 6px; padding: 10px 12px 6px; margin: 6px 8px; }
                .kpl-tikad2-descrow { display: flex; align-items: flex-end; gap: 10px; }
                .kpl-tikad2-descrow .txt { flex: 1; font-size: 14px; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .kpl-tikad2-descrow .more { color: #2f6bff; font-size: 14px; font-weight: 600; white-space: nowrap; cursor: pointer; padding-bottom: 2px; }
                .kpl-tikad2-dates { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: #8a8a8a; }
                .kpl-tikad2-wrap { margin: 6px 8px; }
                .kpl-tikad2-table { border: 2px solid #e0333a; border-radius: 2px; overflow: hidden; background: #fff; }
                .kpl-tikad2-table .head { background: linear-gradient(90deg, #e0333a, #c81e26); color: #fff; display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; }
                .kpl-tikad2-table .head .t { font-size: 17px; font-weight: 800; }
                .kpl-tikad2-table .head .logo { font-size: 13px; font-weight: 800; opacity: .92; letter-spacing: 1px; }
                .kpl-tikad2-table .row { display: flex; border-top: 1px solid #e6b8ba; }
                .kpl-tikad2-table .row:first-of-type { border-top: none; }
                .kpl-tikad2-table .l1 { flex: none; width: 96px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 15px; font-weight: 800; color: #111; padding: 10px 6px; border-right: 1px solid #e0333a; word-break: break-all; }
                .kpl-tikad2-table .r { flex: 1; min-width: 0; }
                .kpl-tikad2-table .grp { display: flex; align-items: flex-start; padding: 8px 10px; }
                .kpl-tikad2-table .grp + .grp { border-top: 1px solid #e6b8ba; }
                .kpl-tikad2-table .gname { flex: none; font-size: 14px; font-weight: 700; color: #111; padding-right: 10px; border-right: 1px solid #d9d9d9; margin-right: 10px; line-height: 1.9; }
                .kpl-tikad2-table .stocks { flex: 1; display: flex; flex-wrap: wrap; gap: 4px 14px; }
                .kpl-tikad2-table .stk { color: #2f6bff; font-size: 14px; font-weight: 600; line-height: 1.9; cursor: pointer; }
                .kpl-tikad2-table .stk:hover { text-decoration: underline; }
                .kpl-tikad2-table .stk.zt { color: #e0333a; font-weight: 800; }
                .kpl-tikad2-table .disc { border-top: 1px solid #e6b8ba; padding: 8px 10px; font-size: 12px; color: #999; }
                .kpl-tikad2-introfull { font-size: 14px; line-height: 1.9; }
                .kpl-tikad2-introfull img { max-width: 100%; }
                /* 个股行情宽表：统计条 + 表头排序 + 左固定/右横滑（显式白底卡片，防深色主题黑字黑底） */
                .kpl-tikad2-stat { display: flex; gap: 18px; padding: 8px 12px; background: #f5f5f5; color: #333; font-size: 13px; margin: 6px 8px; border-radius: 4px; flex-wrap: wrap; }
                .kpl-tikad2-stat b.up { color: #e0333a; }
                .kpl-tikad2-stat b.down { color: #0aa858; }
                .kpl-tikad2-scroll { overflow-x: auto; margin: 0 8px; background: #fff; border-radius: 4px; }
                .kpl-tikad2-thead, .kpl-tikad2-srow { display: flex; align-items: stretch; min-width: max-content; border-bottom: 1px solid #ececec; }
                .kpl-tikad2-thead { position: sticky; top: 0; background: #fff; z-index: 2; font-size: 13px; color: #8a8a8a; }
                .kpl-tikad2-thead .left, .kpl-tikad2-srow .left { flex: none; width: 210px; position: sticky; left: 0; background: #fff; z-index: 1; padding: 8px 10px; }
                .kpl-tikad2-thead .hidesw { cursor: pointer; font-weight: 600; }
                .kpl-tikad2-thead .hidesw.off { opacity: .45; }
                .kpl-tikad2-thead .hidesw-ic { margin-left: 6px; opacity: .7; }
                .kpl-tikad2-thead .cell { flex: none; width: 72px; text-align: right; cursor: pointer; display: flex; align-items: center; justify-content: flex-end; gap: 2px; padding: 8px 6px; }
                .kpl-tikad2-thead .cell.on { color: #e0333a; font-weight: 800; }
                .kpl-tikad2-thead .cell i { font-style: normal; font-size: 10px; }
                .kpl-tikad2-srow { cursor: pointer; }
                .kpl-tikad2-srow:hover { background: #f7f9ff; }
                .kpl-tikad2-srow .nm { font-size: 15px; font-weight: 800; color: #111; display: flex; align-items: center; gap: 6px; }
                .kpl-tikad2-srow .ztb { background: #e0333a; color: #fff; font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 5px; }
                .kpl-tikad2-srow .cd { font-size: 12px; color: #8a8a8a; margin-top: 2px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
                .kpl-tikad2-srow .cd i { font-style: normal; background: #f59e0b; color: #fff; font-size: 10px; border-radius: 3px; padding: 1px 4px; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-tikad2-srow .brief { font-size: 12px; color: #9a9a9a; margin-top: 4px; line-height: 1.5; }
                .kpl-tikad2-srow .cell { flex: none; width: 72px; text-align: right; font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: flex-end; padding: 8px 6px; color: #333; }
                .kpl-tikad2-srow .cell b.up, .kpl-tikad2-srow .cell.up { color: #e0333a; }
                .kpl-tikad2-srow .cell b.down, .kpl-tikad2-srow .cell.down { color: #0aa858; }
                .kpl-tikad2-srow.zt .nm, .kpl-tikad2-srow.zt .cell, .kpl-tikad2-srow.zt .cell b.up, .kpl-tikad2-srow.zt .cell b.down { color: #e0333a; }
                /* ---- 人气榜（3008，App 同款行布局，显式白底） ---- */
                .kpl-pop2-hot5 { display: flex; align-items: center; gap: 8px; background: #fff5f3; border: 1px solid #ffd9d4; border-radius: 6px; padding: 6px 10px; margin: 0 8px 4px; font-size: 12px; overflow: hidden; }
                .kpl-pop2-hot5 .lab { color: #e0333a; font-weight: 800; flex: none; }
                .kpl-pop2-hot5 .it { color: #333; white-space: nowrap; }
                .kpl-pop2-hot5 .it b { margin: 0 3px; }
                .kpl-pop2-hot5 .it .sep { color: #ccc; margin-left: 8px; }
                .kpl-pop2-row { display: flex; align-items: center; gap: 8px; padding: 10px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); cursor: pointer; }
                .kpl-pop2-row:hover { background: var(--dsw-alias-button-elevated-fill); }
                .kpl-pop2-row .rk { flex: none; width: 26px; text-align: center; font-weight: 800; font-size: 15px; color: var(--dsw-alias-label-secondary); }
                .kpl-pop2-row .rk.r1 { color: #e0333a; }
                .kpl-pop2-row .rk.r2 { color: #f97316; }
                .kpl-pop2-row .rk.r3 { color: #eab308; }
                .kpl-pop2-row .main { flex: 1; min-width: 0; }
                .kpl-pop2-row .nm { font-size: 15px; font-weight: 800; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 6px; }
                .kpl-pop2-row .nm .lb { font-style: normal; background: rgba(224,51,58,.1); color: #e0333a; font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 4px; }
                .kpl-pop2-row .cd { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; display: flex; gap: 5px; align-items: center; overflow: hidden; }
                .kpl-pop2-row .cd .zr { font-style: normal; background: rgba(245,158,11,.14); color: #b45309; border-radius: 3px; padding: 1px 4px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-pop2-row .cd .tg { font-style: normal; background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-secondary); border-radius: 3px; padding: 1px 4px; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-pop2-row .vals { flex: none; display: flex; align-items: center; gap: 10px; }
                .kpl-pop2-row .hot { text-align: right; line-height: 1.3; }
                .kpl-pop2-row .hot b { display: block; font-size: 14px; color: var(--dsw-alias-label-primary); }
                .kpl-pop2-row .hot .lbl { display: block; font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .kpl-pop2-row .rc { font-size: 12px; font-weight: 700; width: 34px; text-align: right; }
                .kpl-pop2-row .pct { width: 64px; text-align: right; font-size: 14px; }
                .kpl-pop2-more { display: block; width: 60%; margin: 10px auto; padding: 8px; background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
                .kpl-pop2-badge { font-size: 12px; color: #2f6bff; font-weight: 600; margin-left: 8px; }
                .kpl-pop2-rc { font-size: 11px; font-weight: 700; }
                .kpl-pop2-rc.up { color: #e0333a; } .kpl-pop2-rc.down { color: #0aa858; }
                .kpl-pop2-stale { background: #fff7e6; color: #b45309; border: 1px solid #ffe1ad; border-radius: 6px; padding: 8px 12px; margin: 6px 8px; font-size: 12px; }
                .kpl-pop2-tabs { display: flex; background: #fff; border-radius: 10px 10px 0 0; margin: 6px 8px 0; padding: 6px 10px 0; }
                .kpl-pop2-tab { flex: 1; text-align: center; font-size: 16px; color: #666; padding: 10px 0 8px; cursor: pointer; position: relative; }
                .kpl-pop2-tab.on { color: #111; font-weight: 800; }
                .kpl-pop2-tab.on::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%); bottom: 2px; width: 28px; height: 3px; background: #e0333a; border-radius: 2px; }
                .kpl-pop2-sorts { display: flex; gap: 10px; background: #fff; margin: 0 8px; padding: 8px 10px 4px; }
                .kpl-pop2-sorts .pill { font-size: 14px; color: #333; border: 1px solid #e5e5e5; border-radius: 8px; padding: 6px 14px; cursor: pointer; background: #fff; }
                .kpl-pop2-sorts .pill.on { color: #e0333a; border-color: #e0333a; background: #fff5f4; font-weight: 700; }
                .kpl-pop2-card { background: #fff; margin: 0 8px; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
                .kpl-pop2-card:hover { background: #fafbff; }
                .kpl-pop2-card .r1 { display: flex; align-items: center; gap: 8px; }
                .kpl-pop2-card .r1 .nm { font-size: 16px; font-weight: 800; color: #111; }
                .kpl-pop2-card .r1 .code { font-size: 13px; color: #999; flex: 1; }
                .kpl-pop2-card .r1 .pct { font-size: 17px; font-weight: 800; }
                .kpl-pop2-card .r1 .pct.up { color: #e0333a; } .kpl-pop2-card .r1 .pct.down { color: #0aa858; }
                .kpl-pop2-card .r1 .hv { margin-left: 8px; font-size: 13px; color: #e0333a; }
                .kpl-pop2-card .r1 .hv b { font-size: 15px; }
                .kpl-pop2-card .r2 { display: flex; align-items: center; gap: 6px; margin: 6px 0 0 34px; flex-wrap: wrap; }
                .kpl-pop2-card .rcup { font-size: 12px; font-weight: 800; color: #e0333a; }
                .kpl-pop2-card .rcup.down { color: #0aa858; }
                .kpl-pop2-card .chip-o { font-style: normal; border: 1px solid #f59e0b; color: #b45309; background: #fff; font-size: 11px; border-radius: 3px; padding: 0 4px; }
                .kpl-pop2-card .chip-b { font-style: normal; border: 1px solid #6d9eff; color: #2f6bff; background: #fff; font-size: 11px; border-radius: 3px; padding: 0 4px; }
                .kpl-pop2-card .desc { font-size: 13px; color: #666; line-height: 1.7; margin: 8px 0 0 34px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
                .kpl-pop2-card .desc.open { -webkit-line-clamp: 99; }
                .kpl-pop2-card .desc .arr { color: #999; }
                .kpl-pop2-five { display: flex; align-items: center; gap: 10px; background: #fff; border-radius: 8px; margin: 8px; padding: 10px 14px; font-size: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
                .kpl-pop2-five .t { color: #111; font-weight: 800; }
                .kpl-pop2-five .t b { color: #e0333a; }
                .kpl-pop2-five .it { color: #333; }
                /* ---- 最强风口页（App 风向标同源，显式白底） ---- */
                .kpl-qd2-stat { display: flex; gap: 12px; background: #fff; border-radius: 6px; padding: 10px 14px; margin: 6px 8px; }
                .kpl-qd2-stat .cell { flex: 1; text-align: center; }
                .kpl-qd2-stat .lbl { font-size: 12px; color: #8a8a8a; }
                .kpl-qd2-stat b { font-size: 20px; margin-right: 2px; }
                .kpl-qd2-stat b.up { color: #e0333a; }
                .kpl-qd2-stat b.down { color: #0aa858; }
                .kpl-qd2-stat .yest { font-size: 12px; color: #999; }
                .kpl-qd2-head, .kpl-qd2-row { display: grid; grid-template-columns: 34px 1.2fr 64px 76px 1fr; gap: 6px; align-items: center; padding: 10px 10px; }
                .kpl-qd2-head { color: var(--dsw-alias-label-secondary); font-size: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .kpl-qd2-row { border-bottom: 1px solid var(--dsw-alias-border-l2); cursor: pointer; }
                .kpl-qd2-row:hover { background: var(--dsw-alias-button-elevated-fill); }
                .kpl-qd2-row .rk { color: var(--dsw-alias-label-secondary); font-weight: 700; }
                .kpl-qd2-row .nm { font-weight: 800; font-size: 14px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-qd2-row .st { color: #e0333a; text-align: right; }
                .kpl-qd2-row .rt { text-align: right; }
                .kpl-qd2-row .rt.up { color: #e0333a; }
                .kpl-qd2-row .rt.down { color: #0aa858; }
                .kpl-qd2-row .pl { font-size: 12px; color: #2f6bff; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                /* ---- 严重异动提醒（App 同款 4 列表格，显式白底） ---- */
                .kpl-yd2 { background: #fff; border-radius: 6px; padding: 2px 10px; }
                .kpl-yd2 .hd { display: grid; grid-template-columns: 1.3fr 68px 92px 88px; gap: 6px; padding: 8px 0 6px; font-size: 11px; color: #999; border-bottom: 1px solid #f0f0f0; }
                .kpl-yd2 .hd .c2 { text-align: right; } .kpl-yd2 .hd .c3 { text-align: right; } .kpl-yd2 .hd .c4 { text-align: right; }
                .kpl-yd2-row { display: grid; grid-template-columns: 1.3fr 68px 92px 88px; gap: 6px; align-items: center; padding: 8px 0; border-bottom: 1px solid #f5f5f5; cursor: pointer; }
                .kpl-yd2-row:hover { background: #f7f9ff; }
                .kpl-yd2-row .nm { font-size: 14px; font-weight: 800; color: #111; }
                .kpl-yd2-row .cd { font-size: 11px; color: #8a8a8a; margin-top: 2px; display: flex; gap: 5px; align-items: center; }
                .kpl-yd2-row .cd i { font-style: normal; background: rgba(245,158,11,.14); color: #b45309; border-radius: 3px; padding: 0 4px; }
                .kpl-yd2-row .c2, .kpl-yd2-row .c3, .kpl-yd2-row .c4 { text-align: right; line-height: 1.4; }
                .kpl-yd2-row .c2 b, .kpl-yd2-row .c3 b, .kpl-yd2-row .c4 b { display: block; font-size: 14px; }
                .kpl-yd2-row .c2 span, .kpl-yd2-row .c3 span, .kpl-yd2-row .c4 span { display: block; font-size: 11px; color: #999; }
                .kpl-yd2-row b.up { color: #e0333a; } .kpl-yd2-row b.down { color: #0aa858; }
                .kpl-yd2-row .org { color: #f59e0b; }
                .kpl-tika2-child { padding: 6px 12px 6px 44px; font-size: 13px; color: #3b82f6; border-left: 2px solid var(--dsw-alias-border-l2); margin: 2px 0 2px 26px; cursor: pointer; }
            `;
            document.head.appendChild(style);
        }

        // ============= 面板互斥协议（与 任务看板 / SSH / 记忆系统 同款） =============
        const STOCK_ENTRY_ATTR = "data-dsh-stock-entry";
        const STOCK_VIEW_ATTR = "data-dsh-stock-view";
        const STOCK_ACTIVE_ATTR = "data-dsh-stock-active";
        const PANEL_ACTIVATE_EVENT = "dsh-panel-activate";
        const STOCK_PANEL_NAME = "stock";
        const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]';
        const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]';
        const ENTRY_FAMILY = ["[data-dsh-taskboard-entry]", "[data-dsh-ssh-entry]", "[data-dsh-mnemon-entry]", "[data-dsh-skill-explorer-entry]", "[data-dsh-stock-entry]"];

        const panel = { open: false };
        const panelListeners = new Set();
        let dispatchingSelf = false;

        function setPanelOpen(open) {
            if (panel.open === open) return;
            panel.open = open;
            const root = document.documentElement;
            if (open) {
                dispatchingSelf = true;
                try {
                    document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: "ssh" }));
                    document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: "taskboard" }));
                    document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: STOCK_PANEL_NAME }));
                } finally {
                    dispatchingSelf = false;
                }
                root.setAttribute(STOCK_ACTIVE_ATTR, "");
            } else {
                root.removeAttribute(STOCK_ACTIVE_ATTR);
            }
            for (const listener of panelListeners) listener(panel.open);
        }

        // ============= 侧边栏导航行入口（对齐任务看板的 DOM 注入方式） =============
        function sidebarShellRoot() {
            const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
            if (column === null) return void 0;
            return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild ?? void 0;
        }

        function newSessionButton(root) {
            const nested = root.querySelector('button[class*="newSession"]');
            if (nested !== null) return nested;
            for (const child of root.children) {
                if (child.tagName === "BUTTON") return child;
            }
            return void 0;
        }

        // 插到既有导航行家族（任务看板/SSH/记忆系统/技能中心）的末尾
        function placeStockEntry(root, entry) {
            const button = newSessionButton(root);
            if (button === void 0) return false;
            if (entry.parentElement !== root) {
                const row = button.closest('[class*="logoRow"]');
                const base = row !== null && row.parentElement === root ? row : button;
                const family = Array.from(root.children).filter(
                    (el) => el instanceof HTMLElement && el.matches(ENTRY_FAMILY.join(", "))
                );
                const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
                root.insertBefore(entry, anchor);
            }
            return true;
        }

        function mountSidebarEntry() {
            if (document.querySelector("[" + STOCK_ENTRY_ATTR + "]") !== null) return () => {};
            const entry = document.createElement("button");
            entry.type = "button";
            entry.setAttribute(STOCK_ENTRY_ATTR, "");
            entry.setAttribute("data-dsh-plugin", "dsh-plugin-stock");
            entry.setAttribute("data-dsh-part", "sidebar-entry");
            entry.className = "dsh-stock-entry";
            entry.setAttribute("aria-label", "股票监控");
            entry.title = "股票监控";
            entry.innerHTML = '<span class="dsh-stock-entry-icon">📈</span><span class="dsh-stock-entry-label">股票监控</span>';
            entry.addEventListener("click", () => setPanelOpen(!panel.open));

            const syncActive = () => {
                if (panel.open) entry.dataset.active = "true";
                else delete entry.dataset.active;
            };
            panelListeners.add(syncActive);
            syncActive();

            let shellRoot;
            let placed = false;
            const rootObserver = new MutationObserver(() => {
                if (shellRoot === void 0 || !shellRoot.isConnected) {
                    placed = false;
                    tryPlace();
                    return;
                }
                if (!shellRoot.contains(entry)) placed = placeStockEntry(shellRoot, entry);
            });
            function tryPlace() {
                if (placed && document.body.contains(entry)) return;
                if (placed && !document.body.contains(entry)) {
                    rootObserver.disconnect();
                    shellRoot = void 0;
                    placed = false;
                }
                shellRoot ??= sidebarShellRoot();
                if (shellRoot === void 0) return;
                placed = placeStockEntry(shellRoot, entry);
                if (placed) rootObserver.observe(shellRoot, { childList: true, subtree: true });
            }
            const waitObserver = new MutationObserver(tryPlace);
            waitObserver.observe(document.body, { childList: true, subtree: true });
            tryPlace();

            return () => {
                waitObserver.disconnect();
                rootObserver.disconnect();
                panelListeners.delete(syncActive);
                entry.remove();
            };
        }

        // ============= 右侧整页视图（挂进会话列，激活属性切换显隐） =============
        function mountStockView() {
            let root;
            let container;
            const ensure = () => {
                if (container !== void 0) return;
                const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR);
                if (column === null) return;
                container = document.createElement("div");
                container.setAttribute(STOCK_VIEW_ATTR, "");
                container.dataset.dshPlugin = "dsh-plugin-stock";
                column.appendChild(container);
                root = createRoot(container);
                root.render(React.createElement(WatchlistPanel, null));
            };
            const waitObserver = new MutationObserver(ensure);
            waitObserver.observe(document.body, { childList: true, subtree: true });

            const onOtherActivate = (event) => {
                if (dispatchingSelf) return;
                if (event.detail !== STOCK_PANEL_NAME && panel.open) setPanelOpen(false);
            };
            const onClickSidebarRow = (event) => {
                if (!panel.open) return;
                const target = event.target;
                if (target === null) return;
                if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) setPanelOpen(false);
            };
            document.addEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate);
            document.addEventListener("click", onClickSidebarRow, true);
            ensure();

            return () => {
                document.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate);
                document.removeEventListener("click", onClickSidebarRow, true);
                waitObserver.disconnect();
                root?.unmount();
                container?.remove();
                container = void 0;
            };
        }

        // ============= 官方插件契约：factory 返回插件主体（name / inject / apply） =============
        const pluginModule = { exports: {} };
        pluginModule.exports.name = "dsh-plugin-stock";
        pluginModule.exports.inject = [];
        pluginModule.exports.apply = function apply(ctx) {
            const disposeEntry = mountSidebarEntry();
            const disposeView = mountStockView();
            ctx?.effect?.(() => () => {
                disposeView();
                disposeEntry();
            });
        };
        return pluginModule.exports;
    },
});
