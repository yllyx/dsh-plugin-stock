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
            { id: "search", label: "搜索", icon: "🔍" },
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
        // localStorage 持久层：刷新页面也秒显上次数据（App 同款本地缓存行为）
        const _kplHomeLS = {
            get(k) { try { const v = localStorage.getItem("dsh-stock:" + k); return v ? JSON.parse(v) : null; } catch { return null; } },
            set(k, v) { try { if (v) localStorage.setItem("dsh-stock:" + k, JSON.stringify(v)); } catch { /* */ } },
        };

        function KplHomePage({ go, status, reloadStatus }) {
            const [ov, setOv] = useState(() => _kplHomeCache.ov || _kplHomeLS.get("ov"));
            const [home, setHome] = useState(() => _kplHomeCache.home || _kplHomeLS.get("home"));
            const [explainOpen, setExplainOpen] = useState(false);
            const load = useCallback(async () => {
                // 并行拉取（原先串行 await 拖慢首屏）
                const [o, h] = await Promise.all([
                    api("/api/kpl/overview").catch(() => null),
                    api("/api/kpl/home").catch(() => null),
                ]);
                if (o) { _kplHomeCache.ov = o; _kplHomeLS.set("ov", o); setOv(o); }
                if (h) { _kplHomeCache.home = h; _kplHomeLS.set("home", h); setHome(h); }
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
                ["⚡ 闪电避雷", () => go({ page: "avoid" })],
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
            const db = (home && home.daban) || {};
            const qd = (home && home.qiangdu) || [];
            const qdDay = (home && home.qiangdu_day) || "";
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
                ((home && home.themes) || []).slice(0, 2).map((t, ti) =>
                    React.createElement("div", { key: t.id, className: "kpl-theme2-row" },
                        React.createElement("div", { className: "kpl-theme2-badge" + (ti === 0 ? " red" : " gold") },
                            t.theme || "主题"),
                        React.createElement("div", { className: "kpl-theme2-main" },
                            React.createElement("div", { className: "kpl-theme2-title" }, t.title),
                            React.createElement("div", { className: "kpl-theme2-stocks" },
                                (t.stocks || []).slice(0, 2).map(s =>
                                    React.createElement("span", { key: s.code, className: "kpl-theme2-stock" },
                                        React.createElement("i", null, s.name),
                                        React.createElement("b", { className: rateCls(s.rate) }, fmtRate(s.rate)))))))),

                // ===== 最强风口（App home_s2：标题+日期徽标+四列表头+3行+解锁行） =====
                React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "最强风口",
                            React.createElement("span", { className: "date" },
                                " " + ((home && home.qiangdu && home.qiangdu.day) || "").slice(5) + " ")),
                        React.createElement("span", {
                            className: "more", onClick: () => go({ page: "qiangdu" }),
                        }, qdRows.length ? "更多 ›" : "进入 ›")),
                    qdRows.length > 0 ? React.createElement("div", { className: "kpl-qd3" },
                        React.createElement("div", { className: "hd" },
                            React.createElement("span", null, "股票名称"),
                            React.createElement("span", null, "强度"),
                            React.createElement("span", null, "涨跌幅"),
                            React.createElement("span", null, "板块")),
                        qdRows.slice(0, 3).map((r, i) => React.createElement("div", {
                            key: i, className: "rw",
                            onClick: () => go({ page: "stock", stock: { code: r.code, name: r.name } }),
                        },
                            React.createElement("span", { className: "nm" },
                                React.createElement("b", null, r.name),
                                React.createElement("i", null, r.code)),
                            React.createElement("span", { className: "st" }, r.st || "--"),
                            React.createElement("span", { className: "pct" },
                                React.createElement("b", { className: Number(r.rate) >= 0 ? "up" : "down" }, Number(r.rate).toFixed(2) + "%")),
                            React.createElement("span", { className: "pl" }, r.plate || "--"))),
                        React.createElement("div", { className: "lock" }, "🔓 解锁查看更多数据"))
                    : qdRows.length === 0 && React.createElement("div", { className: "kpl-empty" }, "盘中数据，收盘后清空")),

                // ===== 全部功能宫格入口（App 搜索页宫格同款） =====
                React.createElement("div", { className: "kpl-sec", style: { padding: "8px 12px" } },
                    React.createElement("div", { className: "kpl-fg-entry", onClick: () => go({ page: "funcgrid" }) },
                        React.createElement("span", { className: "ic" }, "▦"),
                        React.createElement("span", { className: "t" }, "全部功能"),
                        React.createElement("span", { className: "more" }, "›"))),
                // ===== 风向标（App 同源 CWeatherVaneList：SZ 涨 3 卡 + XD 跌 3 卡） =====
                React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "风向标"),
                        React.createElement("span", {
                            className: "more", onClick: () => go({ page: "sector", plate: { code: "801225", name: "并购重组" } }),
                        }, "更多 ›")),
                    home && home.daban && ((home.daban.sz || []).length + (home.daban.xd || []).length) > 0 &&
                        React.createElement("div", { className: "kpl-fx-cards" },
                            (home.daban.sz || []).map((r, i) =>
                                React.createElement("div", { key: "s" + i, className: "kpl-fx-card" },
                                    React.createElement("div", { className: "plate" }, r.plate || "--"),
                                    React.createElement("div", { className: "sname" }, r.name),
                                    React.createElement("div", { className: "srate up" }, "+" + Number(r.rate).toFixed(2) + "%"))),
                            (home.daban.xd || []).map((r, i) =>
                                React.createElement("div", { key: "x" + i, className: "kpl-fx-card" },
                                    React.createElement("div", { className: "plate" }, r.plate || "--"),
                                    React.createElement("div", { className: "sname" }, r.name),
                                    React.createElement("div", { className: "srate down" }, Number(r.rate).toFixed(2) + "%")))),
                    home && home.daban && ((home.daban.sz || []).length + (home.daban.xd || []).length) === 0 &&
                        React.createElement("div", { className: "kpl-empty" },
                            "盘中实时推送，下一交易日 9:30 起自动更新")),

                // ===== AI快讯（App 深色大卡：黑底白字+时间红+全文+来源+AI解读，home_s3/s4） =====
                ((home && home.flash) || []).length > 0 && React.createElement("div", { className: "kpl-flash2" },
                    React.createElement("div", { className: "kpl-flash2-head" },
                        React.createElement("span", { className: "t" }, "AI快讯"),
                        React.createElement("span", { className: "arr" }, "›"),
                        React.createElement("span", { className: "robot" }, "🤖")),
                    home.flash.slice(0, 1).map(f => React.createElement("div", { key: f.id, className: "kpl-flash2-body" },
                        React.createElement("div", { className: "kpl-flash2-line" },
                            React.createElement("b", { className: "tm" }, f.time ? new Date(f.time * 1000).toTimeString().slice(0, 8) : ""),
                            React.createElement("span", { className: "tx" }, " " + (f.title || (f.content || "")))),
                        React.createElement("div", { className: "ft" },
                            React.createElement("span", { className: "src" }, "来源：" + (f.source || "开盘啦快讯")),
                            React.createElement("span", { className: "ai" }, "AI解读")))),
                    home.flash.length > 1 && React.createElement("div", { className: "kpl-flash2-more" },
                        home.flash.slice(1, 3).map(f => React.createElement("div", { key: f.id, className: "kpl-flash2-line sm" },
                            React.createElement("b", { className: "tm" }, f.time ? new Date(f.time * 1000).toTimeString().slice(0, 5) : ""),
                            React.createElement("span", { className: "tx" }, " " + (f.title || (f.content || "")).slice(0, 46)))))),

                // ===== 市场情绪（App 首页模块 1:1：白底三列 + 红绿家数条 + 量能行） =====
                React.createElement("div", { className: "kpl-sent3" },
                    React.createElement("div", { className: "kpl-sent3-head" },
                        React.createElement("span", { className: "t" }, "市场情绪"),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "sentiment" }) }, "更多 ›")),
                    React.createElement("div", { className: "kpl-sent3-grid" },
                        [["涨停板", "zt", "up"], ["封板率", "fbl", "up"], ["跌停板", "dt", "down"]].map(([label, k, cls]) => {
                            const pair = (db && db.head && db.head[k]) || [];
                            return React.createElement("div", { key: k, className: "cell" },
                                React.createElement("div", { className: "lbl" }, label),
                                React.createElement("div", { className: "val" },
                                    React.createElement("b", { className: cls }, pair[0] != null ? pair[0] : "--"),
                                    pair[1] != null && React.createElement("span", { className: "yest" }, " / " + pair[1])),
                                React.createElement("div", { className: "lbl2" },
                                    React.createElement("span", null, "今日"),
                                    React.createElement("span", null, "昨日")));
                        })),
                    (db && db.head && (Number(db.head.szjs) > 0 || Number(db.head.xdjs) > 0)) && (() => {
                        const r = Number(db.head.szjs) || 0, x = Number(db.head.xdjs) || 0, tot = r + x;
                        const rp = tot > 0 ? (r / tot * 100) : 50;
                        return React.createElement("div", { className: "kpl-sent3-zd" },
                            React.createElement("div", { className: "bar" },
                                React.createElement("div", { className: "red", style: { width: rp + "%" } }),
                                React.createElement("div", { className: "green", style: { width: (100 - rp) + "%" } })),
                            React.createElement("div", { className: "cnt" },
                                React.createElement("span", { className: "up" }, "涨" + r + "家"),
                                React.createElement("span", { className: "down" }, "跌" + x + "家")));
                    })(),
                    (db && db.head && db.head.szln) && React.createElement("div", { className: "kpl-sent3-ln" },
                        [["上证量能", home && home.capln && home.capln.sh],
                         ["沪深京量能", home && home.capln && home.capln.hsjk]].map(([k2, cp], i) =>
                            React.createElement("div", { key: i, className: "ln" },
                                React.createElement("span", { className: "k" }, k2),
                                React.createElement("b", { className: "up" },
                                    (cp && cp.cur ? (Number(cp.cur) / 1e8).toFixed(0) : (Number(db.head.szln) / 1e8).toFixed(0)) + "亿↑"),
                                React.createElement("span", { className: "yest" }, "昨日此时 " + (cp && cp.yes_now ? (Number(cp.yes_now) / 1e8).toFixed(0) + "亿" : "--")),
                                React.createElement("span", { className: "yest" }, "昨日总计 " + (cp && cp.yest_total ? (Number(cp.yest_total) / 1e8).toFixed(0) + "亿" : "--")))))),

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
                                // 权威交易日历判定（深交所官方，法定节假日=复盘徽标）
                                (() => isTradingNowCal() ? "盘中" : "复盘")())),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "poprank" }) }, "更多 ›")),
                    ((home && home.poprank_hot) || []).length > 0 && React.createElement("div", { className: "kpl-pop2-hot5" },
                        React.createElement("span", { className: "lab" }, "急升"),
                        (home.poprank_hot || []).slice(0, 3).map((s, i) =>
                            React.createElement("span", { key: s.code, className: "it" },
                                s.name,
                                React.createElement("b", { className: rateCls(s.pct) }, fmtRate(s.pct)),
                                i < Math.min(home.poprank_hot.length, 3) - 1 && React.createElement("i", { className: "sep" }, "·")))),
                    home.poprank.slice(0, 3).map((s, i) =>
                        React.createElement("div", {
                            key: s.code, className: "kpl-pop3-card",
                            onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                        },
                            React.createElement("div", { className: "r1" },
                                React.createElement("span", { className: `rk ${i === 0 ? "c1" : i === 1 ? "c2" : "c3"}` }, i + 1),
                                React.createElement("b", { className: "nm" }, s.name),
                                React.createElement("span", { className: "cd" }, s.code),
                                React.createElement("span", { className: "sp" }),
                                React.createElement("b", { className: `pct ${rateCls(s.pct)}` }, fmtRate(s.pct)),
                                React.createElement("span", { className: "fire" }, "🔥", React.createElement("b", null, (s.hot_val || 0).toLocaleString()))),
                            React.createElement("div", { className: "r2" },
                                s.rank_change ? React.createElement("span", {
                                    className: `rc ${s.rank_change > 0 ? "up" : "down"}`,
                                }, (s.rank_change > 0 ? "↑" : "↓") + Math.abs(s.rank_change)) : React.createElement("span", { className: "rc" }, "-"),
                                (s.zt_reason || (s.tags || []).length > 0) && React.createElement("span", { className: "chips" },
                                    s.zt_reason && React.createElement("i", { className: "zr" }, s.zt_reason),
                                    (s.tags || []).slice(0, 1).map(t => React.createElement("i", { key: t.value, className: "tg" }, t.value)))),
                            s.desc && React.createElement("div", { className: "desc" }, s.desc)))),

                // ===== 严重异动提醒（App 首页块 1:1：W46「明日评估」节，yd8 实拍——列头+蓝色「次日评估」副标+右上「更多 ›」） =====
                ((home && home.yidong) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "严重异动提醒"),
                        React.createElement("span", { className: "kpl-yd2-eval" }, "次日评估"),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "ydAlert" }) }, "更多 ›")),
                    React.createElement("div", { className: "kpl-yd2-hd" },
                        React.createElement("span", null, "股票名称"),
                        React.createElement("span", null, "次日涨幅"),
                        React.createElement("span", null, "触发异动涨幅股票价格"),
                        React.createElement("span", null, "次日触发异动偏离值空间")),
                    React.createElement("div", { className: "kpl-yd2" },
                        home.yidong.slice(0, 5).map(s =>
                            React.createElement("div", {
                                key: s.code, className: "kpl-yd2-row",
                                onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                            },
                                React.createElement("div", { className: "c nm" },
                                    React.createElement("div", { className: "nm2" }, s.name),
                                    React.createElement("div", { className: "cd" }, s.code,
                                        s.concept ? React.createElement("i", null, s.concept) : null)),
                                React.createElement("div", { className: "c v" },
                                    React.createElement("b", { className: rateCls(s.day_pct) }, ydPct(s.day_pct)),
                                    React.createElement("span", null, s.price != null ? s.price : "--")),
                                React.createElement("div", { className: "c v org" },
                                    React.createElement("b", null, ydPct(s.need)),
                                    React.createElement("span", null, s.trigger_price != null ? s.trigger_price : "--")),
                                React.createElement("div", { className: "c v" },
                                    React.createElement("b", null, ydPct(s.space_next)),
                                    React.createElement("span", { className: "rl" }, s.rule_short || "")))))),

                React.createElement("div", { className: "kpl-yd2-links" },
                    React.createElement("div", { className: "ln", onClick: () => go({ page: "yidongMany" }) },
                        "查看多次异动个股" + (home && home.yidong_many_count ? `（${home.yidong_many_count}）` : "")),
                    React.createElement("div", { className: "ln has-arr", onClick: () => go({ page: "ydAlert", tab: "zdjk" }) },
                        "重点监控", React.createElement("i", { className: "ar" }, "›"))),
                // ===== 近期活跃板块（App 同源 BaceFaceList 4 条；点击进板块详情） =====
                ((home && home.active_plates) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "近期活跃板块")),
                    React.createElement("div", { className: "kpl-active-plates" },
                        home.active_plates.map((p, i) =>
                            React.createElement("div", {
                                key: i, className: "kpl-active-plate",
                                onClick: p.plateId ? () => go({ page: "sectorDetail", plateId: String(p.plateId), name: p.name }) : undefined,
                            },
                                React.createElement("div", { className: "n" }, p.name),
                                React.createElement("div", { className: "r " + rateCls(p.rate) }, (p.rate >= 0 ? "+" : "") + Number(p.rate).toFixed(2) + "%"))))),

                // ===== 市场风口（App 同款散布 pill：股票名 红涨绿跌） =====
                React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "市场风口"),
                        React.createElement("span", {
                            className: "more", onClick: () => go({ page: "fengkou" }),
                        }, (home && home.fengkou || []).length ? "更多 ›" : "进入 ›")),
                    ((home && home.fengkou) || []).length > 0 && React.createElement("div", { className: "kpl-fk-scatter" },
                        (home.fengkou || []).slice(0, 6).map((r, i) =>
                            React.createElement("span", {
                                key: i, className: `kpl-fk-pill ${Number(r.net) >= 0 ? "red" : "green"}`,
                                style: { top: [8, 58, 30, 78, 4, 50][i % 6] + "%", left: [30, 4, 62, 12, 48, 74][i % 6] + "%" },
                                onClick: () => go({ page: "stock", stock: { code: r.code, name: r.name } }),
                            }, r.name))),
                    ((home && home.fengkou) || []).length === 0 && React.createElement("div", { className: "kpl-empty" },
                        "监控交易最活跃的股票，自动上榜")),

                // ===== 推荐文章 =====
                ((home && home.articles) || []).length > 0 && React.createElement("div", { className: "kpl-sec" },
                    React.createElement("div", { className: "kpl-sec-head" },
                        React.createElement("span", { className: "t" }, "推荐文章"),
                        React.createElement("span", { className: "more", onClick: () => go({ page: "artCenter" }) }, "更多 ›")),
                    home.articles.slice(0, 5).map(a =>
                        React.createElement("div", { key: a.id, className: "kpl-article-row",
                            onClick: () => go({ page: "article", aid: a.id, title: (a.content || "").slice(0, 30) }) },
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
                let timer = null;
                // quotes/stat_pending = 后端 socket 会话死时短路返回（秒开但行情列--），
                // 后台线程补全进缓存后前端自动重拉补上（App 同款：先出列表后出行情）
                const load = (retries) => {
                    api(`/api/kpl/tika/${id}?name=${encodeURIComponent(name || "")}`).then(x => {
                        if (!alive) return;
                        if (x.error) { setErr(x.error); return; }
                        setD(x);
                        if ((x.quotes_pending || x.stat_pending) && retries > 0) {
                            timer = setTimeout(() => load(retries - 1), 3000);
                        }
                    }).catch(e => { if (alive) setErr(e.message || "加载失败"); });
                };
                load(2);
                return () => { alive = false; if (timer) clearTimeout(timer); };
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
                                    // Level1 直接挂 Stocks 形态（无二级分类，如"生产商/投入研发"）
                                    (lv1.groups || []).length === 0 && (lv1.stocks || []).length > 0 &&
                                        React.createElement("div", { key: "l1stocks", className: "grp" },
                                            React.createElement("span", { className: "stocks" },
                                                (lv1.stocks || []).map(s =>
                                                    React.createElement("a", {
                                                        key: s.code,
                                                        className: "stk" + (s.is_zt || ztCodes[s.code] ? " zt" : ""),
                                                        title: s.reason || undefined,
                                                        onClick: () => go({ page: "stock", stock: { code: s.code, name: s.name } }),
                                                    }, s.name)))),
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
            // （权威交易日历：法定节假日休市日恒为复盘，深交所官方口径）
            const inTradingHours = isTradingNowCal();
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

        /* ---- 最强风口页（App 打板页·风向标同源，2026-09-27 实拍复刻）---- */

        function KplQiangduPage({ go }) {
            const [data, setData] = useState(null);
            const [idx, setIdx] = useState(null);
            const [loading, setLoading] = useState(true);
            useEffect(() => {
                let alive = true;
                api("/api/kpl/qiangdu").then(x => {
                    if (!alive) return;
                    setData(x); setLoading(false);
                }).catch(() => { if (alive) setLoading(false); });
                api("/api/index-quotes").then(x => {
                    if (alive) setIdx(((x || {}).indices || {})["000001"] || null);
                }).catch(() => { });
                return () => { alive = false; };
            }, []);
            const rateCls = r => (Number(r) >= 0 ? "up" : "down");
            const fmtRate = r => (Number(r) >= 0 ? "+" : "") + Number(r).toFixed(2) + "%";
            // 优先对象行（后端已反查代码/上榜时间），回退原始数组行
            const list = ((data && data.rows) || []).length > 0 ? (data.rows || [])
                : ((data && data.list) || []).map(row => Array.isArray(row) ? {
                    name: row[1] || "-", st: row[2] || "", rate: row[3],
                    plate: row[4] || "", time: /^\d{1,2}:\d{2}$/.test(String(row[0] || "")) ? row[0] : "",
                    code: "",
                } : { name: row.Name || "-", st: "", rate: row.Rate, plate: row.Plate || "", time: "", code: "" });
            const sent = (data && data.sentiment) || {};
            const t = sent.today || {}, y = sent.yesterday || {};
            const day = (data && (data.snap_day || data.day)) || "";
            const idxUp = idx && Number(idx.change_pct) >= 0;
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "最强风口", onBack: () => go({ page: "back" }) }),
                // 交易日 9:30 前提示（App 同款）：数据尚未开始计算（非交易日不提示）
                (() => {
                    const n = new Date();
                    const beforeOpen = isTradingDayToday() &&
                        (n.getHours() * 60 + n.getMinutes()) < 570;
                    return beforeOpen && React.createElement("div", { className: "kpl-fk-tip" },
                        "数据将在 9:30 开始计算");
                })(),
                // 指数条（App 顶部：沪 3888.37 -48.15 -1.22%）
                idx && React.createElement("div", { className: "kpl-qd2-idx" },
                    React.createElement("span", { className: "nm" }, "沪"),
                    React.createElement("b", { className: idxUp ? "up" : "down" }, idx.price != null ? idx.price : "--"),
                    React.createElement("span", { className: `chg ${idxUp ? "up" : "down"}` },
                        `${idx.change != null ? idx.change : "--"}  ${idx.change_pct != null ? fmtRate(idx.change_pct) : "--"}`)),
                // 情绪指标条（涨停板/强势股/跌停股 今日/昨日）
                React.createElement("div", { className: "kpl-qd2-stat" },
                    [{ k: "涨停板", tk: t.ztjs, yk: y.ztjs }, { k: "强势股", tk: t.strong, yk: y.strong },
                     { k: "跌停股", tk: t.df_num, yk: y.df_num }].map(c =>
                        React.createElement("div", { key: c.k, className: "cell" },
                            React.createElement("div", { className: "lbl" }, c.k),
                            React.createElement("div", null,
                                React.createElement("b", { className: "up" }, c.tk || "--"), " / ",
                                React.createElement("span", { className: "yest" }, c.yk || "--")),
                            React.createElement("div", { className: "lbl" }, "今日 / 昨日")))),
                // 表头 + 最强风口列表（App 同款：名称+代码+上榜时间徽标 | 强度 | 涨跌幅 | 精选板块）
                React.createElement("div", { className: "kpl-qd2-head" },
                    React.createElement("span", null, "#"),
                    React.createElement("span", null, "股票名称"),
                    React.createElement("span", { className: "st" }, "强度"),
                    React.createElement("span", { className: "rt" }, "涨跌幅"),
                    React.createElement("span", { className: "pl" }, "精选板块")),
                loading && React.createElement("div", { className: "kpl-empty" }, "加载中…"),
                !loading && list.map((r, i) =>
                    React.createElement("div", { key: i, className: "kpl-qd2-row" },
                        React.createElement("span", { className: "rk" }, i + 1),
                        React.createElement("span", { className: "nm" },
                            r.name,
                            React.createElement("span", { className: "cd" },
                                r.code || "",
                                r.time ? React.createElement("i", { className: "tm" }, r.time) : null)),
                        React.createElement("span", { className: "st" }, r.st),
                        React.createElement("span", { className: `rt ${rateCls(r.rate)}` }, fmtRate(r.rate)),
                        React.createElement("span", { className: "pl" }, (r.plate || "").split("/").map((p, j) =>
                            React.createElement("span", { key: j, className: "pl-item" }, p))))),
                !loading && list.length === 0 && React.createElement("div", { className: "kpl-empty" },
                    "风向标为盘中实时数据，下一交易日 9:30 起自动更新"),
                day && React.createElement("div", { className: "kpl-qd2-day" },
                    `数据日期 ${day}${(data && data.cached) ? "（盘后快照）" : ""}`));
        }

        /* ---- 风向标页（App 打板页·风向标 tab 同源，socket 2103 订阅式）---- */

        /* ---- 风向标页（App 打板页·风向标 tab 同源 CWeatherVaneList+DaBanList）---- */

        function KplDabanPage({ go }) {
            const [data, setData] = useState(null);
            const [loading, setLoading] = useState(true);
            useEffect(() => {
                let alive = true;
                api("/api/kpl/daban").then(x => {
                    if (!alive) return; setData(x); setLoading(false);
                }).catch(() => { if (alive) setLoading(false); });
                return () => { alive = false; };
            }, []);
            const head = (data && data.head) || {};
            const sz = (data && data.sz) || [];
            const xd = (data && data.xd) || [];
            const fmtPair = pair => (pair == null || pair[0] == null) ? "--" :
                (String(pair[0]) + (pair[0].toString().indexOf("%") < 0 && isNaN(Number(pair[0])) ? "" : "") ) ;
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "风向标", onBack: () => go({ page: "back" }) }),
                // 情绪条（App 打板页顶部同款：涨停板/封板率/跌停股 今日/昨日）
                React.createElement("div", { className: "kpl-sd-summary" },
                    [{ k: "涨停板", tk: head.zt ? head.zt[0] : null, yk: head.zt ? head.zt[1] : null },
                     { k: "封板率%", tk: head.fbl ? head.fbl[0] : null, yk: head.fbl ? head.fbl[1] : null },
                     { k: "跌停股", tk: head.dt ? head.dt[0] : null, yk: head.dt ? head.dt[1] : null }].map(c =>
                        React.createElement("div", { key: c.k, className: "cell" },
                            React.createElement("div", { className: "lbl" }, c.k),
                            React.createElement("div", null,
                                React.createElement("b", { className: c.k === "跌停股" ? "down" : "up" }, c.tk != null ? c.tk : "--"),
                                " / ",
                                React.createElement("span", { className: "yest" }, c.yk != null ? c.yk : "--")),
                            React.createElement("div", { className: "lbl" }, "今日 / 昨日")))),
                // 风向标 6 卡（SZ 涨 3 + XD 跌 3，App 首页同款）
                React.createElement("div", { className: "kpl-fx-cards" },
                    sz.map((r, i) =>
                        React.createElement("div", { key: "s" + i, className: "kpl-fx-card" },
                            React.createElement("div", { className: "plate" }, r.plate || "--"),
                            React.createElement("div", { className: "sname" }, r.name),
                            React.createElement("div", { className: "srate up" }, "+" + Number(r.rate).toFixed(2) + "%"))),
                    xd.map((r, i) =>
                        React.createElement("div", { key: "x" + i, className: "kpl-fx-card" },
                            React.createElement("div", { className: "plate" }, r.plate || "--"),
                            React.createElement("div", { className: "sname" }, r.name),
                            React.createElement("div", { className: "srate down" }, Number(r.rate).toFixed(2) + "%")))),
                (data && data.day) && React.createElement("div", { className: "kpl-qd2-day" },
                    `数据日期 ${data.day}`),
                React.createElement("div", { className: "kpl-qd2-day" },
                    "打板页完整股票列表（竞价/即将涨停/涨停）开发中"));
        }

        /* ---- 行情页（子Tab: 板块/个股/港股/打板/情绪/直播/全球）---- */

        // 行情菜单订阅面 hook：2100-2126/3003/3004/3007 统一数据源（kpl_marketfeed）
        function useMarketFeed(intervalMs) {
            const [feed, setFeed] = useState(null);
            const load = useCallback(async () => {
                try {
                    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
                    const timer = ctl ? setTimeout(() => ctl.abort(), 30000) : null;
                    const resp = await fetch(`${PLUGIN_API_BASE}/api/kpl/marketfeed`, { signal: ctl ? ctl.signal : undefined });
                    if (timer) clearTimeout(timer);
                    if (resp.ok) setFeed(await resp.json());
                } catch (e) { /* 超时/失败保留旧值，下轮轮询重试 */ }
            }, []);
            useEffect(() => { load(); }, [load]);
            usePolling(load, intervalMs || 20000, []);
            return feed;
        }

        function feedData(feed, name) {
            const slot = (feed && feed[name]) || {};
            return { data: slot.data, ts: slot.ts, stale: !!slot.stale,
                     waiting: !slot.data };
        }

        function fmtTs(ts) {
            if (!ts) return "";
            const d = new Date(ts * 1000);
            const p = n => (n < 10 ? "0" : "") + n;
            return p(d.getHours()) + ":" + p(d.getMinutes());
        }

        function fmtAmount(v) {   // 元 → x.x亿 / xxx万
            const n = Number(v);
            if (!isFinite(n)) return "--";
            if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + "亿";
            if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(0) + "万";
            return String(n);
        }

        function fmtPrice(v) {    // 4 位定点 → 价格
            const n = Number(v);
            return isFinite(n) ? (n / 10000).toFixed(2) : "--";
        }

        /* ---- 权威交易日历（深交所官方月历，含法定节假日）----
         * 后端 /api/trade-calendar；WatchlistPanel 启动时拉取+10分钟刷新到 window.__kplTradeCal。
         * 判定 helper：无日历数据时退化周末规则（与旧行为一致）。 */

        function isTradingDayToday() {
            const c = window.__kplTradeCal;
            if (c) return !!c.is_trading_day;
            const d = new Date().getDay();
            return d >= 1 && d <= 5;
        }

        function isTradingNowCal() {
            const c = window.__kplTradeCal;
            if (c) return !!c.in_trading_hours;
            const n = new Date();
            if (n.getDay() === 0 || n.getDay() === 6) return false;
            const m = n.getHours() * 60 + n.getMinutes();
            return (m >= 555 && m <= 690) || (m >= 780 && m <= 900);
        }

        // 分时折线图（canvas，红涨绿跌，昨收虚线；3003 MainIndexTrends 同源）
        function KplTrendCanvas({ points, preClose, height }) {
            const ref = useRef(null);
            useEffect(() => {
                const cv = ref.current;
                if (!cv || !points || !points.length) return;
                const dpr = window.devicePixelRatio || 1;
                const W = cv.clientWidth || 320, H = height || 150;
                cv.width = W * dpr; cv.height = H * dpr;
                const ctx = cv.getContext("2d");
                ctx.scale(dpr, dpr);
                ctx.clearRect(0, 0, W, H);
                const vs = points.map(p => p.v);
                let hi = Math.max(...vs, preClose || 0), lo = Math.min(...vs, preClose || 0);
                if (hi === lo) { hi += 1; lo -= 1; }
                const pad = (hi - lo) * 0.12;
                hi += pad; lo -= pad;
                const x = i => (i / Math.max(1, points.length - 1)) * (W - 8) + 4;
                const y = v => 4 + (hi - v) / (hi - lo) * (H - 8);
                if (preClose) {
                    ctx.strokeStyle = "#999"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.moveTo(0, y(preClose)); ctx.lineTo(W, y(preClose)); ctx.stroke();
                    ctx.setLineDash([]);
                }
                const up = vs[vs.length - 1] >= (preClose || vs[0]);
                const col = up ? "#e03131" : "#0ca678";
                ctx.strokeStyle = col; ctx.lineWidth = 1.4;
                ctx.beginPath();
                points.forEach((p, i) => { if (i) ctx.lineTo(x(i), y(p.v)); else ctx.moveTo(x(0), y(p.v)); });
                ctx.stroke();
                ctx.lineTo(x(points.length - 1), H); ctx.lineTo(x(0), H); ctx.closePath();
                ctx.fillStyle = up ? "rgba(224,49,49,.08)" : "rgba(12,166,120,.08)";
                ctx.fill();
            }, [points, preClose, height]);
            return React.createElement("canvas", { ref, className: "kpl-mkt-trend", style: { height: (height || 150) + "px" } });
        }

        // 双序列折线（量能今昨对比等）
        function KplDualTrendCanvas({ a, b, height }) {
            const ref = useRef(null);
            useEffect(() => {
                const cv = ref.current;
                if (!cv || !a || !b || !a.length) return;
                const dpr = window.devicePixelRatio || 1;
                const W = cv.clientWidth || 320, H = height || 90;
                cv.width = W * dpr; cv.height = H * dpr;
                const ctx = cv.getContext("2d");
                ctx.scale(dpr, dpr);
                ctx.clearRect(0, 0, W, H);
                const all = a.concat(b).map(p => p.v);
                const hi = Math.max(...all, 1);
                const draw = (pts, color) => {
                    ctx.strokeStyle = color; ctx.lineWidth = 1.3;
                    ctx.beginPath();
                    pts.forEach((p, i) => {
                        const x = (i / Math.max(1, pts.length - 1)) * (W - 6) + 3;
                        const y = 4 + (hi - p.v) / hi * (H - 10);
                        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
                    });
                    ctx.stroke();
                };
                draw(b, "#0ca678");
                draw(a, "#e03131");
            }, [a, b, height]);
            return React.createElement("canvas", { ref, className: "kpl-mkt-trend", style: { height: (height || 90) + "px" } });
        }

        // 涨跌分布柱状图（zddist dists：±11 档，红涨绿跌）
        function KplDistBars({ dists }) {
            if (!dists || !dists.length) return null;
            const max = Math.max(...dists.map(d => Number(d.v) || 0), 1);
            return React.createElement("div", { className: "kpl-mkt-dist" },
                dists.map(d => {
                    const k = Number(d.k);
                    const up = k >= 0;
                    const h = Math.max(2, Math.round((Number(d.v) || 0) / max * 52));
                    return React.createElement("div", { key: d.k, className: "col", title: d.k + "%: " + d.v + "家" },
                        React.createElement("div", { className: "bar " + (up ? "up" : "down"), style: { height: h + "px" } }),
                        React.createElement("div", { className: "lbl" }, Math.abs(k) === 11 ? d.k : (k % 5 === 0 ? d.k : "")));
                }));
        }

        /* ---- 行情·打板子页（App 打板 tab 同源：marketfeed 2100/2101/2117/2121/2126）---- */

        function KplDabanSub({ go }) {
            const feed = useMarketFeed(20000);
            const head = feedData(feed, "dabanhead");
            const radar = feedData(feed, "radar");
            const ladder = feedData(feed, "ladder");
            const ztlist = feedData(feed, "ztlist");
            const wind = feedData(feed, "windvane");
            const dbcount = feedData(feed, "dabancount");
            const h = head.data || {};
            const radarItems = (radar.data && radar.data.items) || [];
            const lad = (ladder.data && ladder.data.ladder) || [];
            const ztItems = (ztlist.data && ztlist.data.items) || [];
            const wu = (wind.data && wind.data.up) || [];
            const wd = (wind.data && wind.data.down) || [];
            const empty = !head.data && !radar.data;
            // 打板页四子 tab（App 同款）：竞价/即将涨停/风向标/涨停
            const [dtab, setDtab] = useState("jj");
            const [dbLists, setDbLists] = useState(null);
            useEffect(() => {
                if (dtab === "fxb") return;   // 风向标用 windvane 槽位
                let alive = true;
                api("/api/kpl/dabanlists").then((d) => { if (alive) setDbLists(d); }).catch(() => { if (alive) setDbLists({ lists: {} }); });
                return () => { alive = false; };
            }, [dtab]);
            const cnt = (dbcount.data && dbcount.data.counts) || [];
            const badge = (i) => cnt[i] != null ? React.createElement("span", { className: "kpl-dt-badge" }, cnt[i]) : null;
            const listRows = (dbLists && dbLists.lists && dbLists.lists[dtab === "jj" ? "jj" : "jjzt"] || { items: [] }).items || [];
            const silent = dbLists && dbLists.silent;
            return React.createElement("div", { className: "kpl-mkt-wrap" },
                empty && React.createElement("div", { className: "kpl-mkt-empty" },
                    "正在建立行情连接（约 40 秒），数据到达后自动显示"),
                React.createElement("div", { className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-dtabs" },
                        [["jj", "竞价"], ["jjzt", "即将涨停"], ["fxb", "风向标"], ["zt", "涨停"]].map(function (pair, i) {
                            return React.createElement("span", {
                                key: pair[0], className: "kpl-dtab" + (dtab === pair[0] ? " on" : ""),
                                onClick: function () { setDtab(pair[0]); },
                            }, pair[1], badge(i));
                        })),
                    dtab === "jj" && (silent ? React.createElement("div", { className: "kpl-mkt-empty sm" },
                        "竞价榜为交易时段数据（9:25-9:30 集合竞价），休市无数据")
                        : listRows.length ? React.createElement("div", { className: "kpl-mkt-ztlist" },
                            listRows.slice(0, 20).map((r, i) =>
                                React.createElement("div", { key: i, className: "row" },
                                    React.createElement("div", { className: "nm" },
                                        React.createElement("b", null, r.name || "--"),
                                        React.createElement("span", { className: "cd" }, r.code || ""),
                                        r.financingTag ? React.createElement("span", { className: "d3tag" }, "融") : null,
                                        r.stockTag ? React.createElement("span", { className: "d3tag" }, r.stockTag === "1" ? "游" : r.stockTag) : null),
                                    React.createElement("div", { className: "pct up" }, (r.quotas && r.quotas[0]) || "--"),
                                    React.createElement("div", { className: "price" }, (r.quotas && r.quotas[1]) || "--"),
                                    React.createElement("div", { className: "why" }, (r.quotas && r.quotas[2]) || ""))))
                            : React.createElement("div", { className: "kpl-mkt-empty sm" }, "数据加载中…")),
                    dtab === "jjzt" && (silent ? React.createElement("div", { className: "kpl-mkt-empty sm" },
                        "即将涨停榜为交易时段数据，休市无数据")
                        : listRows.length ? React.createElement("div", { className: "kpl-mkt-ztlist" },
                            listRows.slice(0, 20).map((r, i) =>
                                React.createElement("div", { key: i, className: "row" },
                                    React.createElement("div", { className: "nm" },
                                        React.createElement("b", null, r.name || "--"),
                                        React.createElement("span", { className: "cd" }, r.code || "")),
                                    React.createElement("div", { className: "pct up" }, (r.quotas && r.quotas[0]) || "--"),
                                    React.createElement("div", { className: "price" }, (r.quotas && r.quotas[1]) || "--"),
                                    React.createElement("div", { className: "why" }, (r.quotas && r.quotas[2]) || ""))))
                            : React.createElement("div", { className: "kpl-mkt-empty sm" }, "数据加载中…")),
                    dtab === "fxb" && React.createElement("div", { className: "kpl-mkt-wind" },
                        wu.concat(wd).slice(0, 20).map((r, i) => React.createElement("div", { key: i, className: "wrow" },
                            React.createElement("span", { className: "nm" }, r.name),
                            React.createElement("span", { className: "plate" }, r.plate || ""),
                            React.createElement("span", { className: "pct " + (Number(r.pct) >= 0 ? "up" : "down") },
                                Number(r.pct).toFixed(2) + "%")))),
                    dtab === "zt" && (ztItems.length ? React.createElement("div", { className: "kpl-mkt-ztlist" },
                        ztItems.slice(0, 30).map((r, i) =>
                            React.createElement("div", { key: i, className: "row" },
                                React.createElement("div", { className: "nm" },
                                    React.createElement("b", null, r.name || "--"),
                                    React.createElement("span", { className: "cd" }, r.code || "")),
                                React.createElement("div", { className: "pct up" },
                                    r.pct != null ? Number(r.pct).toFixed(2) + "%" : "--"),
                                React.createElement("div", { className: "price" }, r.price != null ? fmtPrice(r.price) : "--"),
                                React.createElement("div", { className: "why" }, r.ztReason || (r.state === 2 ? "涨停" : "")))))
                        : React.createElement("div", { className: "kpl-mkt-empty sm" }, "涨停列表数据加载中…"))),
                React.createElement("div", { className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-mkt-sec-t" }, "打板情绪"),
                    React.createElement("div", { className: "kpl-mkt-mood3" },
                        [{ k: "涨停板", v: h.zt, cls: "up" }, { k: "封板率%", v: h.fb, cls: "up" },
                         { k: "跌停股", v: h.dt, cls: "down" }].map(c =>
                            React.createElement("div", { key: c.k, className: "cell" },
                                React.createElement("div", { className: "lbl" }, c.k),
                                React.createElement("div", { className: "val" },
                                    React.createElement("b", { className: c.cls }, c.v && c.v[0] != null ? c.v[0] : "--"),
                                    React.createElement("span", { className: "yest" }, " / " + (c.v && c.v[1] != null ? c.v[1] : "--"))),
                                React.createElement("div", { className: "sub" }, "今日 / 昨日"))))),
                React.createElement("div", { className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-mkt-sec-t" }, "市场雷达",
                        React.createElement("span", { className: "kpl-mkt-tips" }, radarItems[0] ? fmtTs(radarItems[0].ts) : "")),
                    radarItems.length ? radarItems.slice(0, 12).map((r, i) =>
                        React.createElement("div", { key: i, className: "kpl-mkt-radar" },
                            React.createElement("span", { className: "t" }, fmtTs(r.ts)),
                            React.createElement("span", { className: "chip " + (r.color === 1 ? "up" : "down") }, r.status || "--"),
                            React.createElement("span", { className: "txt" },
                                (r.name ? r.name + "：" : "") + (r.content || ""))))
                        : React.createElement("div", { className: "kpl-mkt-empty sm" }, "暂无雷达消息")),
                lad.length ? React.createElement("div", { className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-mkt-sec-t" }, "连板天梯"),
                    lad.map(r => React.createElement("div", { key: r.h, className: "kpl-mkt-ladder" },
                        React.createElement("span", { className: "h up" }, r.h + "板"),
                        React.createElement("span", { className: "names" },
                            (r.stocks || []).map(s => s.name).join("、") || "--")))) : null,

                (wu.length || wd.length) ? React.createElement("div", { className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-mkt-sec-t" }, "风向标"),
                    React.createElement("div", { className: "kpl-mkt-wind" },
                        wu.map((r, i) => React.createElement("div", { key: "u" + i, className: "wrow" },
                            React.createElement("span", { className: "nm" }, r.name),
                            React.createElement("span", { className: "plate" }, r.plate || ""),
                            React.createElement("span", { className: "pct up" }, "+" + Number(r.pct).toFixed(2) + "%"))),
                        wd.map((r, i) => React.createElement("div", { key: "d" + i, className: "wrow" },
                            React.createElement("span", { className: "nm" }, r.name),
                            React.createElement("span", { className: "plate" }, r.plate || ""),
                            React.createElement("span", { className: "pct down" }, Number(r.pct).toFixed(2) + "%"))))) : null);
        }

        /* ---- 行情·直播子页（App 直播 tab 同源：3003 分时 + 2110/2114/2115/2116/2106/2108/2109）---- */

        function KplLiveSub({ go }) {
            // App 行情·直播 tab（MarketLiveFragment）1:1：顶部上证分时 + 全天播报时间轴流。
            // 播报关联标的=后端文本匹配（App 客户端匹配本地 STOCK 表同机制），building 时自动重拉。
            const [trend, setTrend] = useState(null);
            const [news, setNews] = useState(null);
            const [retryN, setRetryN] = useState(0);
            const loadTrend = useCallback(async () => {
                try { setTrend(await api("/api/kpl/mkttrend")); } catch (e) { /* */ }
            }, []);
            useEffect(() => { loadTrend(); }, [loadTrend]);
            usePolling(loadTrend, 30000, []);
            const loadNews = useCallback(async () => {
                try {
                    const d = await api("/api/kpl/livenews");
                    setNews(d);
                    if (d && d.building) setRetryN((n) => n + 1);
                } catch (e) { /* */ }
            }, []);
            useEffect(() => { loadNews(); }, [loadNews]);
            useEffect(() => {
                if (!retryN || retryN > 6) return undefined;
                const t = setTimeout(loadNews, 3000);
                return () => clearTimeout(t);
            }, [retryN, loadNews]);
            const idxes = (trend && trend.indexes) || [];
            const cur = idxes.find((x) => x.num === "SH") || idxes[0] || null;
            const items = (news && news.items) || [];
            const kids = [];
            if (cur) {
                const last = cur.points && cur.points.length ? cur.points[cur.points.length - 1].v : cur.preClose;
                const diff = last - cur.preClose;
                const pct = cur.preClose ? diff / cur.preClose * 100 : 0;
                const up = diff >= 0;
                kids.push(React.createElement("div", { key: "fs", className: "kpl-lv-fs" },
                    React.createElement(KplTrendCanvas, { points: cur.points, preClose: cur.preClose, height: 210 }),
                    React.createElement("div", { className: "kpl-lv-fshead" },
                        React.createElement("b", { className: up ? "up" : "down" }, last != null ? last.toFixed(2) : "--"),
                        React.createElement("span", { className: up ? "up" : "down" },
                            (up ? "+" : "") + (diff != null ? diff.toFixed(2) : "--") + "  "
                            + (up ? "+" : "") + (pct != null ? pct.toFixed(2) : "") + "%"))));
            } else {
                kids.push(React.createElement("div", { key: "fsw", className: "kpl-mdd-empty" }, "分时数据建立连接中…"));
            }
            items.forEach((it, i) => {
                const tlabel = it.time ? fmtTs(Number(it.time)) : "--:--";
                const stocks = (it.stocks || []).filter((s) => s.pct != null);
                const plates = (it.plates || []);
                kids.push(React.createElement("div", { key: i, className: "kpl-lv-item" },
                    React.createElement("div", { className: "tl" },
                        React.createElement("div", { className: "tm" }, tlabel),
                        React.createElement("div", { className: "dot" }),
                        React.createElement("div", { className: "ln" })),
                    React.createElement("div", { className: "card" },
                        React.createElement("div", { className: "txt" }, it.comment),
                        (stocks.length || plates.length) ? React.createElement("div", { className: "chips" },
                            stocks.map((s, j) => React.createElement("span", {
                                key: "s" + j, className: "chip",
                                onClick: () => go && go({ page: "stock", stock: { code: s.code, name: s.name } }),
                            },
                                React.createElement("i", null, s.name),
                                React.createElement("b", { className: s.pct >= 0 ? "up" : "down" },
                                    (s.pct >= 0 ? "+" : "") + Number(s.pct).toFixed(2) + "%"))),
                            plates.map((p, j) => React.createElement("span", { key: "p" + j, className: "chip plate" },
                                React.createElement("i", null, p.name),
                                p.pct != null ? React.createElement("b", { className: p.pct >= 0 ? "up" : "down" },
                                    (p.pct >= 0 ? "+" : "") + Number(p.pct).toFixed(2) + "%") : null)))
                            : null)));
            });
            if (news && news.building) {
                kids.push(React.createElement("div", { key: "bld", className: "kpl-mdd-empty" },
                    "播报关联标的分析中（首次约 10 秒，随后走本地缓存）…"));
            }
            if (!news && !items.length) {
                kids.push(React.createElement("div", { key: "load", className: "kpl-mdd-empty" }, "加载中…"));
            }
            return React.createElement("div", { className: "kpl-mkt-wrap kpl-lv" }, kids);
        }



        /* ---- 行情·个股子页（App 个股 tab 同源：3004 RealtimeLHB 订阅）---- */

        function KplStockSub() {
            const feed = useMarketFeed(20000);
            const rank = feedData(feed, "stockrank");
            const items = (rank.data && rank.data.items) || [];
            return React.createElement("div", { className: "kpl-mkt-wrap" },
                React.createElement("div", { className: "kpl-mkt-stkhead" },
                    React.createElement("span", { className: "nm" }, "股票名称"),
                    React.createElement("span", { className: "pct" }, "涨幅"),
                    React.createElement("span", { className: "price" }, "价格"),
                    React.createElement("span", { className: "net" }, "主力净额")),
                items.length ? items.map((r, i) => {
                    const q = r.quotas || [];
                    const pct = parseFloat(q[2]);
                    return React.createElement("div", { key: i, className: "kpl-mkt-stkrow" },
                        React.createElement("div", { className: "nm" },
                            React.createElement("b", null, r["2"] || "--"),
                            React.createElement("span", { className: "cd" }, r["1"] || "")),
                        React.createElement("div", { className: "pct " + (pct >= 0 ? "up" : "down") },
                            isFinite(pct) ? pct.toFixed(2) + "%" : "--"),
                        React.createElement("div", { className: "price" }, q[1] || "--"),
                        React.createElement("div", { className: "net" }, q[9] || "--"));
                })
                    : React.createElement("div", { className: "kpl-mkt-empty" },
                        "全市场榜单为交易时段推送（App 同款：盘后展示本地缓存，插件从下一交易日起积累）",
                        React.createElement("br"),
                        (window.__kplTradeCal && window.__kplTradeCal.next_trading_day)
                            ? "下一交易日： " + window.__kplTradeCal.next_trading_day
                            : "下一交易日以交易所日历为准"));
        }

        /* ---- 行情·港股子页（HKFragment/HKStockListFragment 协议逆向中）---- */

        /* ---- 严重异动提醒家族（App deviation 包同源；块与下钻页共用格式化） ---- */
        // App 块内数值格式（yd8 实拍）：0 → "0%"，其余两位小数、不带 +
        function ydPct(v) {
            if (v == null || isNaN(Number(v))) return "--";
            const n = Number(v);
            return n === 0 ? "0%" : n.toFixed(2) + "%";
        }
        // 异动提醒页表格数值（yd30 实拍）：一律两位小数、不带 +
        function ydPct2(v) {
            if (v == null || isNaN(Number(v))) return "--";
            return Number(v).toFixed(2) + "%";
        }
        // 上/下一交易日步进（自然日 ±1，跳过周末；法定节假日以 trade-cal 修正，无数据时如实展示空列表）
        function ydStepDay(day, dir) {
            const d = day ? new Date(day + "T00:00:00") : new Date();
            let t = d.getTime();
            for (let i = 0; i < 10; i++) {
                t += dir * 86400000;
                const wd = new Date(t).getDay();
                if (wd !== 0 && wd !== 6) break;
            }
            const y = new Date(t), p = (x) => (x < 10 ? "0" + x : "" + x);
            return y.getFullYear() + "-" + p(y.getMonth() + 1) + "-" + p(y.getDate());
        }

        // 渲染异常守卫（纯函数）：子页渲染抛错时显示原因而非白屏，下次轮询自动重试。
        // 勿用 class ErrorBoundary：模块执行期求值 React.Component 在 DSH 打包环境失败曾致整模块白屏。
        function kplGuard(Comp, name) {
            return function Guarded(props) {
                try {
                    return Comp(props);
                } catch (e) {
                    return React.createElement("div", { className: "kpl-empty" },
                        "模块渲染异常(" + name + ")：" + (e && e.message ? e.message : e),
                        React.createElement("div", { className: "kpl-mkt-tips" }, "请刷新页面重试；若持续出现请反馈"));
                }
            };
        }

        // 个股详情守卫必须模块级创建一次：放进 drill 分支渲染体内时，父级每次重渲染
        // （10s 报价轮询等）都产生新组件类型 → React 把详情页整页卸载重建 →
        // 横移页码/tab/滚动位置全丢，表现为"过几秒刷新一次、tab 无法停留"（#27⑤ 同案）。
        const KPL_STOCK_DETAIL_G = kplGuard(KplStockDetail, "个股详情");

        // 严重异动家族两页同样模块级守卫（#27）
        const KPL_YD_ALERT_G = kplGuard(KplYdAlertPage, "异动提醒");
        const KPL_YD_MANY_G = kplGuard(KplYidongManyPage, "多次异动个股");

        // 守卫包装必须在模块层做一次：放进渲染体内的话，父级每次重渲染（3s 状态轮询等）
        // 都会产生新组件类型，React 按不同组件整页卸载重建子页——表现为每隔几秒"闪一下"+丢状态重拉数据。
        const KPL_G = {
            plate: kplGuard(KplPlateSub, "板块"),
            stock: kplGuard(KplStockSub, "个股"),
            hk: kplGuard(KplHkSub, "港股"),
            daban: kplGuard(KplDabanSub, "打板"),
            sentiment: kplGuard(KplSentimentSub, "情绪"),
            live: kplGuard(KplLiveSub, "直播"),
            global: kplGuard(KplGlobalSub, "全球"),
        };

        function KplHkSub({ go }) {
            const [d, setD] = useState(null);
            const [error, setError] = useState(null);
            const load = useCallback(async () => {
                try { setD(await api("/api/kpl/hk-stocks")); setError(null); }
                catch (e) { setError(e.message); }
            }, []);
            useEffect(() => { load(); }, [load]);
            const items = (d && d.items) || [];
            const children = [];
            if (error) children.push(React.createElement("div", { key: "e", className: "kpl-empty" }, "加载失败：" + error));
            if (!d && !error) children.push(React.createElement("div", { key: "l", className: "kpl-empty" }, "正在加载港股列表…"));
            if (d) {
                children.push(React.createElement("div", { key: "s", className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-mkt-sec-t" }, "港股全列表",
                        React.createElement("span", { className: "kpl-mkt-tips" },
                            items.length + " 只 · 数据版本 " + (d.ts ? new Date(d.ts * 1000).toISOString().slice(0, 10) : "--")))));
                if (items.length) {
                    const rows = items.slice(0, 100).map(function (r, i) {
                        return React.createElement("div", {
                            key: r.code + i, className: "kpl-lhb-row hk",
                            onClick: function () { go && go({ page: "stock", stock: { code: r.code, name: r.name } }); },
                        },
                            React.createElement("div", { className: "nm sticky" },
                                React.createElement("b", null, r.name),
                                React.createElement("span", { className: "cd" }, "HK" + r.code)),
                            React.createElement("div", { className: "numcol" }, r.code),
                            React.createElement("div", { className: "concept" }, "组 " + r.group));
                    });
                    children.push(React.createElement("div", { key: "t", className: "kpl-lhb-scroll" },
                        React.createElement("div", { className: "kpl-lhb-table stk" },
                            React.createElement("div", { className: "kpl-lhb-head hk" },
                                React.createElement("span", { className: "sticky" }, "名称"),
                                React.createElement("span", null, "代码"),
                                React.createElement("span", { className: "r" }, "板块组")),
                            rows)));
                    if (items.length > 100) {
                        children.push(React.createElement("div", { key: "m", className: "kpl-mkt-tips" },
                            "共 " + items.length + " 只，当前显示前 100（行情列随协议接入扩展）"));
                    }
                } else {
                    children.push(React.createElement("div", { key: "n", className: "kpl-empty" }, "暂无数据"));
                }
            }
            return React.createElement("div", { className: "kpl-mkt-wrap" }, children);
        }

        /* ---- 行情页主容器 ---- */

        function KplMarketPage({ go, initialSub }) {
            const [sub, setSub] = useState(initialSub || "plate");
            const subs = ["板块", "个股", "港股", "打板", "情绪", "直播", "全球"];
            const subMap = { "板块": "plate", "个股": "stock", "港股": "hk", "打板": "daban", "情绪": "sentiment", "直播": "live", "全球": "global" };
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-subtabs" },
                    subs.map(s => React.createElement("span", {
                        key: s, className: "kpl-subtab " + (subMap[s] === sub ? "on" : ""),
                        onClick: () => setSub(subMap[s]),
                    }, s))),
                sub === "plate" && React.createElement(KPL_G.plate, { go }),
                sub === "stock" && React.createElement(KPL_G.stock, null),
                sub === "hk" && React.createElement(KPL_G.hk, { go }),
                sub === "daban" && React.createElement(KPL_G.daban, { go }),
                sub === "sentiment" && React.createElement(KPL_G.sentiment, { go }),
                sub === "live" && React.createElement(KPL_G.live, { go }),
                sub === "global" && React.createElement(KPL_G.global, null));
        }

        /* ---- 板块 tab（App stareplate/PlateFragment 1:1 布局：横滑卡+盘中雷达+精选/行业+强度表+时间轴）---- */

        function KplPlateSub({ go }) {
            const feed = useMarketFeed(20000);
            const [trend, setTrend] = useState(null);
            const loadTrend = useCallback(async function () {
                try { setTrend(await api("/api/kpl/mkttrend")); } catch (e) { /* */ }
            }, []);
            useEffect(function () { loadTrend(); }, [loadTrend]);
            usePolling(loadTrend, 30000, []);
            const idxes = (trend && trend.indexes) || [];
            const z = ((feed && feed.zdstat) || {}).data || {};
            const e = ((feed && feed.energy) || {}).data || {};
            const radar = feedData(feed, "radar");
            const radarItems = ((radar.data && radar.data.items) || []).slice().reverse();
            const [idxSel, setIdxSel] = useState("SH");
            const [idxCards, setIdxCards] = useState([]);
            const loadIdx = useCallback(async function () {
                try {
                    const d = await api("/api/kpl/index-cards");
                    if (d && d.cards && d.cards.length) setIdxCards(d.cards);
                } catch (e) { /* 快速重试兜底 */ }
            }, []);
            useEffect(function () {
                loadIdx();
                let n = 0;
                const t = setInterval(async function () {
                    n++;
                    await loadIdx();
                    if (n >= 20) clearInterval(t);   // 前 100 秒每 5s 快速重试，之后由 30s 轮询接管
                }, 5000);
                return function () { clearInterval(t); };
            }, []);
            const [ptab, setPtab] = useState("jx");
            const ix = idxes.find(function (x) { return x.num === idxSel; }) || idxes[0];
            const ixLast = ix && ix.points && ix.points.length ? ix.points[ix.points.length - 1].v : (ix ? ix.preClose : null);
            const ixDiff = (ix && ixLast != null) ? ixLast - ix.preClose : null;
            const ixPct = (ix && ixDiff != null && ix.preClose) ? ixDiff / ix.preClose * 100 : null;
            // 量能 text="17150亿(19.27%,增量2770亿)" → 主数 + 增量
            let eMain = "", eInc = "";
            const em = /^([\d.]+亿)\(([\d.]+)%,增量([\d.]+)亿\)$/.exec((e && e.text) || "");
            if (em) { eMain = em[1]; eInc = "增量" + em[3] + "亿(" + em[2] + "%)"; }
            const idxCard = React.createElement("div",
                { className: "kpl-plt-card " + (ixDiff != null ? (ixDiff >= 0 ? "upbg" : "dnbg") : "") },
                React.createElement("div", { className: "kpl-plt-ilbl" },
                    [["SH", "沪"], ["SZ", "深"], ["CYB", "创"]].map(function (pair) {
                        return React.createElement("span", {
                            key: pair[0], className: idxSel === pair[0] ? "on" : "",
                            onClick: function () { setIdxSel(pair[0]); },
                        }, pair[1]);
                    })),
                React.createElement("div", { className: "kpl-plt-big " + (ixDiff != null && ixDiff < 0 ? "dn" : "up") },
                    ixLast != null ? ixLast.toFixed(2) : "--"),
                React.createElement("div", { className: (ixDiff != null && ixDiff < 0 ? "dn" : "up") + " kpl-plt-sub" },
                    ixDiff != null ? ((ixDiff >= 0 ? "+" : "") + ixDiff.toFixed(2) + "  " + (ixPct >= 0 ? "+" : "") + ixPct.toFixed(2) + "%") : "--"),
                React.createElement("div", { className: "kpl-plt-dots" },
                    ["SH", "SZ", "CYB"].map(function (num, i) {
                        return React.createElement("i", { key: num, className: idxSel === num ? "on" : "" });
                    })));
            const volCard = React.createElement("div", { className: "kpl-plt-card upbg" },
                React.createElement("div", { className: "kpl-plt-lbl" }, "沪深京预测量能"),
                React.createElement("div", { className: "kpl-plt-big rd" }, eMain || "--"),
                React.createElement("div", { className: "kpl-plt-sub rd" }, eInc || " "));
            const zdCard = React.createElement("div", { className: "kpl-plt-card " + (z.rise != null && z.rise >= z.down ? "upbg" : "dnbg") },
                React.createElement("div", { className: "kpl-plt-lbl" }, "涨跌家数"),
                React.createElement("div", { className: "kpl-plt-mid" },
                    React.createElement("span", { className: "up" }, z.rise != null ? z.rise : "--"),
                    React.createElement("span", { className: "sep" }, "/"),
                    React.createElement("span", { className: "dn" }, z.down != null ? z.down : "--")),
                React.createElement("div", { className: "kpl-plt-sub" },
                    "涨跌停 ",
                    React.createElement("span", { className: "rd" }, z.realZt != null ? z.realZt : "-"),
                    " : ",
                    React.createElement("span", { className: "gn" }, z.realDt != null ? z.realDt : "-")));
            return React.createElement("div", { className: "kpl-page" },
                // 顶部横滑卡：沪深创 / 沪深京预测量能 / 涨跌家数（App 多卡横滑流）
                React.createElement("div", { className: "kpl-plt-cards" },
                    idxCard, volCard, zdCard,
                    // 指数卡（App 卡流后段：微盘股/科创50/北证50/上证50/沪深300——点位源 MainIndexQuotas 接入中）
                    // 指数卡（App 卡流后段：socket 3006 SubIndexSimpleQuotas 同源实时点位）
                    idxCards.map(function (c) {
                        var up = Number(c.incRate) >= 0;
                        return React.createElement("div", { className: "kpl-plt-card " + (up ? "upbg" : "dnbg"), key: c.id },
                            React.createElement("div", { className: "kpl-plt-lbl" }, c.name || c.id),
                            React.createElement("div", { className: "kpl-plt-big " + (up ? "up" : "dn") },
                                c.price != null ? c.price.toFixed(2) : "--"),
                            React.createElement("div", { className: "kpl-plt-sub " + (up ? "up" : "dn") },
                                (c.incPrice != null ? (up ? "+" : "") + c.incPrice.toFixed(2) + "  " : "") +
                                (up ? "+" : "") + Number(c.incRate).toFixed(2) + "%"));
                    })),
                // 折叠频道行（App PlateFragment：横向轮播 4 卡，默认第 1 张；左右滑动切卡）
                React.createElement(KplPlateTicker, { radarItems: radarItems, go: go }),
                // 精选/行业 + 右侧入口
                React.createElement("div", { className: "kpl-plt-filter" },
                    React.createElement("span", {
                        className: "pill" + (ptab === "jx" ? " on" : ""),
                        onClick: function () { setPtab("jx"); },
                    }, "精选"),
                    React.createElement("span", {
                        className: "pill" + (ptab === "hy" ? " on" : ""),
                        onClick: function () { setPtab("hy"); },
                    }, "行业"),
                    React.createElement("span", { className: "tools" },
                        React.createElement("i", { onClick: function () { go({ page: "func_pending", name: "多日统计" }); } }, "📊 多日统计"),
                        React.createElement("i", { onClick: function () { go({ page: "func_pending", name: "板块叠加" }); } }, "📋 板块叠加"),
                        React.createElement("i", { onClick: function () { go({ page: "func_pending", name: "历史" }); } }, "🕓 历史"))),
                // 强度表（RealRankingInfo HTTP 组装，App 同源数值）
                React.createElement(KplPlateRankTable, { go: go, industry: ptab === "hy" }),
                // 底部时间轴（App 历史统计滑条 1:1 静态位）
                React.createElement("div", { className: "kpl-plt-timeline" },
                    React.createElement("div", { className: "bar" },
                        React.createElement("i", { className: "dot", style: { left: "4%" } }),
                        React.createElement("span", { className: "tick tk1" }, "09:25"),
                        React.createElement("span", { className: "tick tk2" }, "11:30"),
                        React.createElement("span", { className: "tick tk3" }, "15:00"),
                        React.createElement("i", { className: "dot", style: { left: "66%" } })),
                    React.createElement("span", { className: "his", onClick: function () { go({ page: "func_pending", name: "历史统计" }); } }, "⇄ 历史统计")));
        }

        // 折叠频道行（App：盘中=盘中雷达 2101；盘后=尾盘抢筹 GetWPQCIndex「尾盘抢筹 10-08 **** 挂单抢筹5317万」）
        // 折叠频道行（App PlateFragment：横向轮播 4 卡，默认第 1 张；左右滑动切卡）
        // 卡1 盘中雷达（2101 收起摘要）· 卡2 市场雷达（2101 明细）· 卡3 尾盘抢筹（GetWPQCIndex）
        // · 卡4 竞价异动板块（GetBKJJSearch，竞价时段数据）
        function KplPlateTicker({ radarItems, go }) {
            const [wp, setWp] = useState(null);
            const [bk, setBk] = useState(null);
            const [openMap, setOpenMap] = useState({});   // 各卡展开态（默认卡2/3/4 展开，卡1 收起）
            useEffect(function () {
                let alive = true;
                api("/api/kpl/wpqc").then(function (d) { if (alive) setWp(d); }).catch(function () { });
                api("/api/kpl/bkjj").then(function (d) { if (alive) setBk(d); }).catch(function () { });
                return function () { alive = false; };
            }, []);
            const isOpen = function (k, def) { return openMap[k] != null ? openMap[k] : def; };
            const tog = function (k, def) { return function () { setOpenMap(function (m) { const o = Object.assign({}, m); o[k] = (m[k] != null ? m[k] : def) ? false : true; return o; }); }; };
            const r0 = radarItems[0] || null;
            const rTop = radarItems.slice(0, 6);
            const wpList = (wp && wp.list) || [];
            const bkList = (bk && bk.list) || [];

            function cardHead(key, defOpen, title, right) {
                return React.createElement("div", { className: "hd", onClick: tog(key, defOpen) },
                    React.createElement("span", { className: "t" }, title),
                    React.createElement("span", { className: "rt" }, right || null),
                    React.createElement("i", { className: "col" }, isOpen(key, defOpen) ? "收起" : "展开"));
            }

            // 卡1 盘中雷达（收起=单行最新；展开=列表）
            const radarCard = React.createElement("div", { className: "kpl-tk-card", key: "radar" },
                cardHead("radar", false, "盘中雷达",
                    r0 ? React.createElement("span", { className: "rt" },
                        React.createElement("i", { className: "tm" }, fmtTs(Number(r0.ts))),
                        React.createElement("i", { className: "nm" }, r0.name || ""),
                        React.createElement("i", { className: "st" }, r0.status || "")) : null),
                isOpen("radar", false) && React.createElement("div", { className: "bd" },
                    radarItems.length ? radarItems.map(function (r, i) {
                        return React.createElement("div", { key: i, className: "it" },
                            React.createElement("span", { className: "tm" }, fmtTs(Number(r.ts))),
                            React.createElement("span", { className: "nm" }, r.name || ""),
                            React.createElement("span", { className: "st" }, r.status || ""),
                            React.createElement("span", { className: "tx" }, r.content || ""));
                    }) : React.createElement("div", { className: "it" }, React.createElement("span", { className: "tx" }, "盘中雷达为交易时段推送"))));

            // 卡2 市场雷达（明细，默认展开）
            const mktCard = React.createElement("div", { className: "kpl-tk-card", key: "mkt" },
                cardHead("mkt", true, "市场雷达"),
                isOpen("mkt", true) && React.createElement("div", { className: "bd" },
                    radarItems.length ? radarItems.slice(0, 8).map(function (r, i) {
                        return React.createElement("div", { key: i, className: "it" },
                            React.createElement("span", { className: "tm" }, fmtTs(Number(r.ts))),
                            React.createElement("span", { className: "nm" }, r.name || ""),
                            React.createElement("span", { className: "st" }, r.status || ""),
                            React.createElement("span", { className: "tx" }, r.content || ""));
                    }) : React.createElement("div", { className: "it" }, React.createElement("span", { className: "tx" }, "盘中雷达为交易时段推送"))));

            // 卡3 尾盘抢筹
            const wpCard = React.createElement("div", { className: "kpl-tk-card", key: "wp" },
                cardHead("wp", true, "尾盘抢筹",
                    wp && wp.day ? React.createElement("span", { className: "rt" },
                        React.createElement("i", { className: "tm" }, wp.day)) : null),
                isOpen("wp", true) && React.createElement("div", { className: "bd" },
                    wpList.length ? wpList.map(function (r, i) {
                        return React.createElement("div", { key: i, className: "it" },
                            React.createElement("span", { className: "tm" }, wp.day || ""),
                            React.createElement("span", { className: "st" }, "****"),
                            React.createElement("span", { className: "tx" },
                                "挂单抢筹", React.createElement("b", { className: "rd" },
                                    r.amount != null ? fmtAmount(r.amount) : "--")));
                    }) : React.createElement("div", { className: "it" }, React.createElement("span", { className: "tx" }, "尾盘抢筹为 14:30 后数据"))));

            // 卡4 竞价异动板块
            const bkCard = React.createElement("div", { className: "kpl-tk-card", key: "bk" },
                cardHead("bk", true, "竞价异动板块"),
                isOpen("bk", true) && React.createElement("div", { className: "bd" },
                    bkList.length ? bkList.map(function (r, i) {
                        const cells = Array.isArray(r) ? r : [];
                        return React.createElement("div", { key: i, className: "it" },
                            React.createElement("span", { className: "nm" }, String(cells[0] || "")),
                            React.createElement("span", { className: "tx" }, String(cells[1] || "竞价爆量")),
                            React.createElement("span", { className: "tx" }, String(cells[2] || "")),
                            React.createElement("span", { className: "tx" }, "异动金额"),
                            React.createElement("span", { className: "tm" }, String(cells[3] || "")));
                    }) : React.createElement("div", { className: "it" }, React.createElement("span", { className: "tx" }, "竞价异动为集合竞价时段（9:20-9:25）数据"))));

            return React.createElement("div", { className: "kpl-tk-wrap" }, radarCard, mktCard, wpCard, bkCard);
        }

        // 板块强度表（RealRankingInfo HTTP 组装，与 App 强度列逐位对拍 2026-10-08：
        // 锂电池 6290/石油石化 3210/并购重组 1377；子板块 SonPlate_Info 嵌行）
        function KplPlateRankTable({ go, industry }) {
            const [d, setD] = useState(null);
            const [error, setError] = useState(null);
            useEffect(function () {
                let alive = true;
                api("/api/kpl/plate-strength" + (industry ? "?industry=1" : ""))
                    .then(function (x) { if (alive) setD(x); })
                    .catch(function (e) { if (alive) setError(e.message); });
                return function () { alive = false; };
            }, [industry]);
            const rows = (d && d.list) || [];
            const head = React.createElement("div", { className: "kpl-plt-thead" },
                React.createElement("span", { className: "c nm" }, "板块"),
                React.createElement("span", { className: "c hl" }, "强度", React.createElement("i", { className: "srt dn" }, "▼")),
                React.createElement("span", { className: "c" }, "主力净额", React.createElement("i", { className: "srt" }, "⇅")),
                React.createElement("span", { className: "c" }, "第二季度机构增仓", React.createElement("i", { className: "srt" }, "⇅")));
            if (error) {
                return React.createElement("div", { className: "kpl-plt-table" },
                    head, React.createElement("div", { className: "kpl-mkt-empty sm" }, "加载失败：" + error));
            }
            if (!d) {
                return React.createElement("div", { className: "kpl-plt-table" },
                    head, React.createElement("div", { className: "kpl-mkt-empty sm" }, "加载中…"));
            }
            return React.createElement("div", { className: "kpl-plt-table" },
                head,
                rows.map(function (r, i) {
                    const isSub = !!r.parent;
                    return React.createElement("div", {
                        key: r.plateId + i,
                        className: "kpl-plt-trow" + (isSub ? " sub" : ""),
                        onClick: function () { go && go({ page: "sectorDetail", plateId: r.plateId, name: r.name }); },
                    },
                        React.createElement("div", { className: "c nm" },
                            isSub ? React.createElement("i", { className: "ln" }) : null,
                            React.createElement("b", null, r.name || "--"),
                            React.createElement("span", { className: "cd" }, r.plateId || "")),
                        React.createElement("div", { className: "c hl" },
                            r.strength != null ? Number(r.strength).toFixed(0) : "--"),
                        React.createElement("div", { className: "c " + (Number(r.mainNet) >= 0 ? "up" : "dn") },
                            r.mainNet != null ? fmtAmount(r.mainNet) : "--"),
                        React.createElement("div", { className: "c " + (Number(r.instInc) >= 0 ? "up" : "dn") },
                            r.instInc != null ? fmtAmount(r.instInc) : "--"));
                }));
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

        /* ---- 情绪页（App 行情·情绪 tab=MarketMoodFragment·数据分析 1:1 复刻，2026-10-02 逆向）----
         * 数据 /api/kpl/mood?day=（HIS 域 HTTP 聚合，模块映射见 kanpan_spec/docs/mood_page_map.md）。
         * App 实拍顺序：温度计→涨跌统计→市场量能→涨停表现→活跃股走势+播报→连板强度→大幅回撤→风向标→权重表现。
         * 隐藏规则同 App：北向资金 status==0 隐藏；"历史数据"悬浮按钮 ◀▶ 切交易日。 */

        const CAP_TYPE_NAMES = { "4": "沪深京", "0": "沪深", "1": "上证", "3": "北证", "2": "创业板", "5": "科创板" };

        function kplMoodGrade(g) {   // App ZTExpressionEntity.getTextColor：低=绿 高=红 中=灰
            return g === "高" ? "#e03131" : (g === "低" ? "#2f9e44" : "#868e96");
        }

        // 温度计（综合强度 0-100：渐变条+刻度+右侧大数字，App 同款）
        function KplMoodThermo({ v }) {
            const w = Math.min(100, Math.max(0, Number(v) || 0));
            const ticks = [];
            for (let i = 0; i <= 100; i += 10) ticks.push(React.createElement("span", { key: i }, i));
            return React.createElement("div", { className: "kpl-mood-thermo" },
                React.createElement("div", { className: "lft" },
                    React.createElement("div", { className: "tube" },
                        React.createElement("div", { className: "fill", style: { width: Math.max(6, w * 0.86 + 6) + "%" } })),
                    React.createElement("div", { className: "scale" }, ticks)),
                React.createElement("div", { className: "num" },
                    React.createElement("b", null, v != null && v !== "" ? v : "--"),
                    React.createElement("div", { className: "lbl" }, "综合强度")));
        }

        // 涨跌统计 11 档柱状（App 同款：上数值/中柱/下标签，红灰绿 + 红绿比例条 + 涨跌家数）
        function KplMoodZdBars({ z }) {
            const bars = (z && z.bars) || [];
            if (!bars.length) return null;
            const max = Math.max.apply(null, bars.map(b => b.v).concat([1]));
            const szjs = Number(z.szjs || 0), xdjs = Number(z.xdjs || 0);
            const tot = szjs + xdjs;
            const redPct = tot > 0 ? szjs / tot * 100 : 50;
            return React.createElement("div", { className: "kpl-mood-zdbars" },
                React.createElement("div", { className: "row" },
                    bars.map((b, i) => React.createElement("div", { key: i, className: "col" },
                        React.createElement("div", { className: "v " + b.cls }, b.v),
                        React.createElement("div", { className: "bar " + b.cls,
                            style: { height: Math.max(3, Math.round(b.v / max * 150)) + "px" } }),
                        React.createElement("div", { className: "lbl" + (b.v != null ? "" : " dim") }, b.lbl)))),
                React.createElement("div", { className: "ratio" },
                    React.createElement("div", { className: "red", style: { width: redPct + "%" } }),
                    React.createElement("div", { className: "mid" }),
                    React.createElement("div", { className: "green", style: { width: (100 - redPct) + "%" } })),
                React.createElement("div", { className: "rn" },
                    React.createElement("span", { className: "up" }, "涨" + szjs + "家"),
                    React.createElement("span", { className: "down" }, "跌" + xdjs + "家")));
        }

        // 连板强度点线图（strong 历史序列，红点橙线；App 同款 >75 过热 <25 过冷）
        function KplMoodDots({ series }) {
            const ref = useRef(null);
            useEffect(() => {
                const cv = ref.current;
                if (!cv || !series || !series.length) return;
                const dpr = window.devicePixelRatio || 1;
                const W = cv.clientWidth || 320, H = 170;
                cv.width = W * dpr; cv.height = H * dpr;
                const ctx = cv.getContext("2d");
                ctx.scale(dpr, dpr);
                ctx.clearRect(0, 0, W, H);
                const vs = series.map(d => Number(d.strong) || 0);
                let hi = Math.max.apply(null, vs.concat([100])), lo = 0;
                const x = i => 8 + i / Math.max(1, vs.length - 1) * (W - 16);
                const y = v => 8 + (hi - v) / (hi - lo) * (H - 20);
                [0, 25, 50, 75, 100].forEach(g => {
                    ctx.strokeStyle = g === 25 || g === 75 ? "#ffd8a8" : "#eee";
                    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.moveTo(0, y(g)); ctx.lineTo(W, y(g)); ctx.stroke();
                });
                ctx.setLineDash([]);
                ctx.strokeStyle = "#f59f00"; ctx.lineWidth = 1.2;
                ctx.beginPath();
                vs.forEach((v, i) => { if (i) ctx.lineTo(x(i), y(v)); else ctx.moveTo(x(0), y(v)); });
                ctx.stroke();
                ctx.fillStyle = "#e03131";
                vs.forEach((v, i) => {
                    ctx.beginPath(); ctx.arc(x(i), y(v), 2.6, 0, Math.PI * 2); ctx.fill();
                });
            }, [series]);
            return React.createElement("canvas", { ref, className: "kpl-mkt-trend", style: { height: "170px" } });
        }

        function KplMoodBody({ startDay, go }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const [day, setDay] = useState(startDay || "");
            const [mode5, setMode5] = useState(false);
            const [capType, setCapType] = useState("4");
            const [capDrop, setCapDrop] = useState(false);
            const [capData, setCapData] = useState(null);
            const load = useCallback(async (d) => {
                try {
                    setError(null);
                    setData(await api("/api/kpl/mood" + (d ? "?day=" + encodeURIComponent(d) : "")));
                } catch (e) { setError(e && e.message ? e.message : String(e)); }
            }, []);
            useEffect(() => { load(day); }, [load, day]);
            usePolling(() => load(day), 60000, [day]);
            useEffect(() => {
                let alive = true;
                api("/api/kpl/mood/capacity?type=" + capType + (day ? "&day=" + encodeURIComponent(day) : ""))
                    .then((x) => { if (alive) setCapData(x); }).catch(() => { /* 保留旧值 */ });
                return () => { alive = false; };
            }, [capType, day]);
            const d = data || {};
            const z = d.zdtj || null;
            const head = d.head || {};
            const cap = d.cap || null;
            const expr = d.ztexpr || null;
            const wd = d.withdrawal || [];
            const wv = d.windvane || { top: [], bottom: [] };
            const wts = d.weights || {};
            const news = d.live_news || [];
            const hist = d.lb_strength || [];
            const nb = d.northbound;
            const dayLbl = d.day ? d.day.slice(5).replace("-", "-") : "--";
            const fmtYi = (v) => { const n = Number(v); return isFinite(n) && n ? (n / 1e4).toFixed(0) + "亿" : "--"; };
            const pct2 = (v) => (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%";
            // 日期步进（后端按交易日历归一，▶ 今日禁用=App 同款）
            const today = new Date();
            const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
            const stepDay = (dd, n) => {
                const t = new Date(dd + "T00:00:00");
                t.setDate(t.getDate() + n);
                return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
            };
            const curDay = d.day || day || todayStr;
            const capTrends = (cap && cap.trends || []).map(t => ({ v: Number(t[4]) || 0 }));
            const moodPts = ((mode5 && d.mood_line5 && d.mood_line5.length ? d.mood_line5 : d.mood_line) || []).map(p => ({ v: Number(p.value) || 0 }));
            let moodHi = null, moodLo = null;
            moodPts.forEach(p => {
                if (moodHi == null || p.v > moodHi) moodHi = p.v;
                if (moodLo == null || p.v < moodLo) moodLo = p.v;
            });
            const news0 = news.length ? news[0] : null;
            const newsTime = news0 ? fmtTs(Number(news0.time)) : "";
            const weightCards = (wts.SZ || []).slice(0, 3).concat((wts.XD || []).slice(0, 3));
            const nbShow = nb && Number(nb.status) > 0 && String(nb.totalB) !== "88";
            return React.createElement("div", { className: "kpl-mood" },
                error && React.createElement("div", { className: "kpl-empty" },
                    "加载失败：" + error,
                    React.createElement("div", { className: "kpl-mkt-tips" },
                        React.createElement("span", { className: "kpl-mood-retry", onClick: () => load(day) }, "点击重试"))),
                !data && !error && React.createElement("div", { className: "kpl-empty" }, "加载中…"),
                data && React.createElement("div", null,
                    // ① 温度计
                    React.createElement("div", { className: "kpl-mood-sec plain" },
                        React.createElement(KplMoodThermo, { v: hist.length ? hist[0].strong : null })),
                    // ② 涨跌统计
                    z ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "涨跌统计"),
                        React.createElement("div", { className: "sjzt" },
                            "实际涨跌停：",
                            React.createElement("b", { className: "up" }, z.sjzt != null ? z.sjzt : "--"), " : ",
                            React.createElement("b", { className: "down" }, z.sjdt != null ? z.sjdt : "--"),
                            React.createElement("span", { className: "tip" }, " (过滤ST股)")),
                        React.createElement(KplMoodZdBars, { z: z })) : null,
                    // ③ 市场量能
                    cap ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "市场量能 ",
                            React.createElement("span", { className: "day" }, dayLbl),
                            React.createElement("span", { className: "filter", title: "切换指数",
                                onClick: () => setCapDrop(!capDrop) }, "☱ 指数"),
                            React.createElement("span", { className: "more" }, "历史量能")),
                        capDrop ? React.createElement("div", { className: "kpl-mood-capdrop" },
                            [["4", "沪深京"], ["0", "沪深"], ["1", "上证"], ["3", "北证"], ["2", "创业板"], ["5", "科创板"]].map((t) =>
                                React.createElement("span", {
                                    key: t[0], className: t[0] === capType ? "on" : "",
                                    onClick: () => { setCapType(t[0]); setCapDrop(false); },
                                }, t[1]))) : null,
                        React.createElement("div", { className: "cap-row1" }, (CAP_TYPE_NAMES[capType] || "沪深京") + " | 实际量能 ",
                            React.createElement("b", null, fmtYi((capData && capData.last) != null ? capData.last : cap.last))),
                        React.createElement("div", { className: "cap-row2" },
                            React.createElement("i", { className: "dot" }), "今日 | 预测量能 ",
                            React.createElement("b", { className: "up" }, (capData && capData.yclnstr) || cap.yclnstr || "--")),
                        React.createElement(KplTrendCanvas, { points: ((capData && capData.trends) || cap.trends || []).map((t) => ({ v: Number(t[4]) || 0 })), preClose: 0, height: 160 }),
                        React.createElement("div", { className: "axis-x" },
                            React.createElement("span", null, "09:30"),
                            React.createElement("span", null, "11:30/13:00"),
                            React.createElement("span", null, "15:00")),
                        React.createElement("div", { className: "note" },
                            "注:红色代表当日预测量能增量，绿色代表缩量",
                            React.createElement("span", { className: "ovl" }, "◎ 叠加上证（盘中）"))) : null,
                    // ④ 涨停表现
                    expr ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "涨停表现",
                            React.createElement("span", { className: "more lnk", onClick: () => go({ page: "mood_zte", day: d.day }) }, "更多")),
                        React.createElement("div", { className: "kpl-mood-three" },
                            React.createElement("div", { className: "cell" },
                                React.createElement("div", { className: "lbl" }, "涨停板"),
                                React.createElement("div", { className: "vv" },
                                    React.createElement("b", { className: "up" }, z && z.sjzt != null ? z.sjzt : "--"), " / ",
                                    React.createElement("span", { className: "old" }, head.lZhangTing != null ? head.lZhangTing : "--")),
                                React.createElement("div", { className: "sub" },
                                    React.createElement("span", null, "今日"), React.createElement("span", null, "昨日"))),
                            React.createElement("div", { className: "cell" },
                                React.createElement("div", { className: "lbl" }, "封板率"),
                                React.createElement("div", { className: "vv" },
                                    React.createElement("b", { className: "up" }, head.tFengBan != null ? Math.round(Number(head.tFengBan)) + "%" : "--"), " / ",
                                    React.createElement("span", { className: "old" }, head.lFengBan != null ? Math.round(Number(head.lFengBan)) + "%" : "--")),
                                React.createElement("div", { className: "sub" },
                                    React.createElement("span", null, "今日"), React.createElement("span", null, "昨日"))),
                            React.createElement("div", { className: "cell" },
                                React.createElement("div", { className: "lbl" }, "跌停板"),
                                React.createElement("div", { className: "vv" },
                                    React.createElement("b", { className: "down" }, z && z.sjdt != null ? z.sjdt : "--"), " / ",
                                    React.createElement("span", { className: "old" }, head.lDieTing != null ? head.lDieTing : "--")),
                                React.createElement("div", { className: "sub" },
                                    React.createElement("span", null, "今日"), React.createElement("span", null, "昨日")))),
                        React.createElement("div", { className: "kpl-mood-ladder" },
                            React.createElement("div", { className: "lr head" },
                                ["一板", "二板", "三板", "四板", "高度板"].map((t, i) =>
                                    React.createElement("span", { key: i }, t))),
                            React.createElement("div", { className: "lr nums" },
                                expr.ladder.map((v, i) => React.createElement("span", { key: i }, v))),
                            React.createElement("div", { className: "lr rates" },
                                React.createElement("span", null, "连板率"),
                                expr.lbRates.map((r, i) => React.createElement("span", { key: i, className: "g" },
                                    Math.round(r.v) + "% ",
                                    React.createElement("i", { style: { color: kplMoodGrade(r.g) } }, r.g))))),
                        React.createElement("div", { className: "kpl-mood-rows" },
                            React.createElement("div", { className: "mrow" },
                                React.createElement("span", null, "今日涨停破板率"),
                                React.createElement("span", { className: "val" },
                                    React.createElement("b", { style: { color: kplMoodGrade(expr.breakRate.g) } },
                                        Number(expr.breakRate.v).toFixed(2) + "%"),
                                    React.createElement("i", { className: "g" }, " (" + expr.breakRate.g + ")"),
                                    React.createElement("em", { className: "arr" }, ">"))),
                            expr.rows.map((r, i) => React.createElement("div", { key: i, className: "mrow" },
                                React.createElement("span", null, r.lbl),
                                React.createElement("span", { className: "val" },
                                    React.createElement("b", { style: { color: r.v >= 0 ? "#e03131" : "#2f9e44" } }, pct2(r.v)),
                                    React.createElement("i", { className: "g" }, " (" + r.g + ")"),
                                    React.createElement("em", { className: "arr" }, ">")))))) : null,
                    // ⑤ 活跃股走势 + 播报
                    moodPts.length ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "活跃股走势 ",
                            React.createElement("span", { className: "day" }, dayLbl)),
                        React.createElement(KplTrendCanvas, { points: moodPts, preClose: 0, height: 170 }),
                        moodHi != null ? React.createElement("div", null,
                            React.createElement("span", { className: "kpl-mood-hi" }, "峰值 " + pct2(moodHi)),
                            React.createElement("span", { className: "kpl-mood-lo" }, "谷值 " + pct2(moodLo))) : null,
                        React.createElement("div", { className: "axis-x" },
                            React.createElement("span", null, "09:30"),
                            React.createElement("span", null, "11:30/13:00"),
                            React.createElement("span", null, "15:00")),
                        React.createElement("div", { className: "note row" },
                            React.createElement("span", null, "注:涨幅>2%代表短线活跃，<-1%代表冰点。"),
                            React.createElement("span", { className: "sw" },
                                React.createElement("span", { className: mode5 ? "" : "on", onClick: () => setMode5(false) }, "当日"),
                                " | ",
                                React.createElement("span", { className: mode5 ? "on" : "", onClick: () => setMode5(true) }, "5日"))),
                        news0 ? React.createElement("div", { className: "kpl-mood-broadcast" },
                            React.createElement("b", null, newsTime), " " + news0.comment) : null) : null,
                    // ⑥ 连板强度
                    hist.length ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "连板强度"),
                        React.createElement("div", { className: "cap-lg" },
                            React.createElement("span", { className: "lg red" }, "连板强度：",
                                React.createElement("b", null, hist[0].strong)),
                            React.createElement("span", { className: "lg green" }, "大幅回撤：",
                                React.createElement("b", null, wd.length)),
                            React.createElement("span", { className: "rt" }, dayLbl)),
                        React.createElement(KplMoodDots, { series: hist.slice(0, 60).slice().reverse() }),
                        React.createElement("div", { className: "note" }, "注:连板强度>75代表情绪过热，<25代表过冷")) : null,
                    // ⑦ 大幅回撤
                    wd.length ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "大幅回撤 ",
                            React.createElement("span", { className: "cnt" }, wd.length + "个"),
                            React.createElement("span", { className: "more lnk", onClick: () => go({ page: "mood_withdraw", day: d.day }) }, "更多")),
                        React.createElement("div", { className: "kpl-mood-wd" },
                            React.createElement("div", { className: "wr head" },
                                React.createElement("span", null, "股票名称"),
                                React.createElement("span", null, "涨幅"),
                                React.createElement("span", { className: "hl" }, "当日回撤"),
                                React.createElement("span", null, "板块")),
                            wd.map((r, i) => React.createElement("div", {
                                key: r.code + i, className: "wr",
                                onClick: () => go && go({ page: "stock", stock: { code: r.code, name: r.name } }),
                            },
                                React.createElement("span", { className: "nm" },
                                    React.createElement("b", null, r.name),
                                    React.createElement("i", { className: "cd" }, r.code)),
                                React.createElement("span", { className: "pct" },
                                    React.createElement("b", { className: "down" }, Number(r.pct).toFixed(2) + "%")),
                                React.createElement("span", { className: "hl dd" },
                                    React.createElement("b", { className: "down" }, Number(r.drawdown).toFixed(2) + "%")),
                                React.createElement("span", { className: "plates" },
                                    r.plates.split("、").map((p, j) => React.createElement("span", { key: j }, p, " ▾"))))))) : null,
                    // ⑧ 风向标
                    (wv.top || []).length ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "风向标",
                            React.createElement("span", { className: "more lnk", onClick: () => go({ page: "sector", plate: { code: "801225", name: "并购重组" } }) }, "更多")),
                        React.createElement("div", { className: "kpl-mood-cards" },
                            wv.top.map((r, i) => React.createElement("div", {
                                key: "t" + i, className: "card",
                                onClick: () => go && go({ page: "stock", stock: { code: r[0], name: r[1] } }),
                            },
                                React.createElement("div", { className: "plate" }, r[3]),
                                React.createElement("div", { className: "nm" }, r[1]),
                                React.createElement("div", { className: "pct up" }, Number(r[2]).toFixed(2) + "%"))),
                            wv.bottom.map((r, i) => React.createElement("div", {
                                key: "b" + i, className: "card",
                                onClick: () => go && go({ page: "stock", stock: { code: r[0], name: r[1] } }),
                            },
                                React.createElement("div", { className: "plate" }, r[3]),
                                React.createElement("div", { className: "nm" }, r[1]),
                                React.createElement("div", { className: "pct down" }, Number(r[2]).toFixed(2) + "%"))))) : null,
                    // ⑨ 权重表现
                    weightCards.length ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "权重表现",
                            React.createElement("span", { className: "more lnk", onClick: () => go({ page: "mood_weights", day: d.day }) }, "更多")),
                        React.createElement("div", { className: "kpl-mood-cards" },
                            weightCards.map((r, i) => React.createElement("div", { key: i, className: "card big" },
                                React.createElement("div", { className: "plate" }, r[1]),
                                React.createElement("div", { className: "pct " + (r[2] >= 0 ? "up" : "down") }, Number(r[2]).toFixed(2) + "%"),
                                React.createElement("div", { className: "leader" },
                                    r[4], " ",
                                    React.createElement("b", { className: r[5] >= 0 ? "up" : "down" }, Number(r[5]).toFixed(2) + "%")))))) : null,
                    // ⑩ 北向资金（App 同款隐藏规则：status==0 或 "88" 哨兵 → 不渲染）
                    nbShow ? React.createElement("div", { className: "kpl-mood-sec" },
                        React.createElement("div", { className: "sec-t" }, "北向资金"),
                        React.createElement("div", { className: "cap-row2" }, "北向资金：",
                            React.createElement("b", null, String(nb.totalB) + "亿"),
                            React.createElement("span", { className: "tip" }, " " + (nb.sign || "")))) : null),
                // 悬浮"历史数据"（App 右下同款，◀▶ 切交易日）
                React.createElement("div", { className: "kpl-mood-histbar" },
                    React.createElement("span", { className: "nav", onClick: () => setDay(stepDay(curDay, -1)) }, "◀"),
                    React.createElement("span", { className: "d" }, "📅 " + dayLbl),
                    curDay >= todayStr ? React.createElement("span", { className: "nav dis" }, "▶")
                        : React.createElement("span", { className: "nav", onClick: () => setDay(stepDay(curDay, 1)) }, "▶")));
        }

        function KplSentimentPage({ go }) {
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "市场情绪", onBack: () => go({ page: "back" }) }),
                React.createElement(KplMoodBody, { go }));
        }

        function KplSentimentSub({ go }) {
            // App 行情·情绪 tab = MarketMoodFragment·数据分析单页（双 tab 仅独立 Activity 场景）
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplMoodBody, { go }));
        }



        /* ---- 情绪页下钻（2026-10-03 逆向 App 三下钻页）----
         * 涨停表现=ZhangTingExpressionActivity（梯头 DailyLimitIndex+MarketStockZDNum；明细通道 2120/DailyLimitPerformance ⏸10-08 校准）
         * 大幅回撤=MaximumRetreatActivity（SharpWithdrawalList 已实测）
         * 权重表现=WeightPerformanceListActivity（全行业表；涨速/成交额列 ⏸10-08 抓包） */

        function KplMoodDayNav({ day, onPrev, onNext, nextDis }) {
            return React.createElement("div", { className: "kpl-mdd-daynav" },
                React.createElement("span", { className: "nav", onClick: onPrev }, "◀"),
                React.createElement("span", { className: "d" }, day || "--"),
                nextDis ? React.createElement("span", { className: "nav dis" }, "▶")
                    : React.createElement("span", { className: "nav", onClick: onNext }, "▶"));
        }

        function KplZtePage({ go, day: initDay }) {
            const [d, setD] = useState(null);
            const [error, setError] = useState(null);
            const [day, setDay] = useState(initDay || "");
            const [tab, setTab] = useState("1");
            const load = useCallback(async (dd) => {
                try { setError(null); setD(await api("/api/kpl/mood/ztdetail" + (dd ? "?day=" + encodeURIComponent(dd) : ""))); }
                catch (e) { setError(e && e.message ? e.message : String(e)); }
            }, []);
            useEffect(() => { load(day); }, [load, day]);
            const today = new Date();
            const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
            const step = (n) => {
                const t = new Date((d && d.day || day || todayStr) + "T00:00:00");
                t.setDate(t.getDate() + n);
                setDay(t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"));
            };
            const ladder = (d && d.ladder) || [];
            const tabNames = [["1", "一板"], ["2", "二板"], ["3", "三板"], ["4", "四板"], ["5", "更高"]];
            const rows = (d && d.lists && d.lists[tab]) || [];
            const children = [React.createElement(KplPageHeader, { key: "h", title: "涨停表现", onBack: () => go({ page: "back" }) })];
            children.push(React.createElement("div", { key: "top", className: "kpl-mdd-head" },
                React.createElement("div", { className: "sj" },
                    React.createElement("span", { className: "lbl" }, "涨停"),
                    React.createElement("b", { className: "up" }, d && d.sjzt != null ? d.sjzt : "--")),
                React.createElement("span", { className: "sl" }, "/"),
                React.createElement("div", { className: "sj" },
                    React.createElement("span", { className: "lbl" }, "跌停"),
                    React.createElement("b", { className: "down" }, d && d.sjdt != null ? d.sjdt : "--")),
                React.createElement(KplMoodDayNav, { day: d && d.day, onPrev: () => step(-1), onNext: () => step(1), nextDis: (d && d.day || "") >= todayStr })));
            children.push(React.createElement("div", { key: "tabs", className: "kpl-mdd-tabs" },
                tabNames.map((tn, i) => React.createElement("span", {
                    key: tn[0], className: "ttab" + (tab === tn[0] ? " on" : ""),
                    onClick: () => setTab(tn[0]),
                }, tn[1],
                    ladder[i] != null ? React.createElement("i", { className: "badge" }, ladder[i]) : null))));
            children.push(React.createElement("div", { key: "tbl", className: "kpl-lhb-scroll" },
                React.createElement("div", { className: "kpl-lhb-table stk" },
                    React.createElement("div", { className: "kpl-lhb-head zte" },
                        React.createElement("span", { className: "sticky" }, "股票名称"),
                        React.createElement("span", null, "涨停时间"),
                        React.createElement("span", null, "涨停原因"),
                        React.createElement("span", { className: "r" }, "封单")),
                    rows.length ? rows.map((r, i) => React.createElement("div", {
                        key: r[0] + i, className: "kpl-lhb-row zte",
                        onClick: () => go({ page: "stock", stock: { code: r[0], name: r[1] } }),
                    },
                        React.createElement("div", { className: "nm sticky" },
                            React.createElement("b", null, r[1]),
                            React.createElement("span", { className: "cd" }, r[0])),
                        React.createElement("div", { className: "numcol" }, r[4] ? fmtTs(Number(r[4])) : "--"),
                        React.createElement("div", { className: "concept" }, r[5] || "--"),
                        React.createElement("div", { className: "moneycol" }, r[6] != null ? fmtAmount(r[6]) : "--")))
                        : React.createElement("div", { className: "kpl-mdd-empty" },
                            d ? (d.note || "暂无数据") : "加载中…"))));
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(ErrorBox, { error }),
                children);
        }

        function KplWithdrawPage({ go, day: initDay }) {
            const [d, setD] = useState(null);
            const [error, setError] = useState(null);
            const [day, setDay] = useState(initDay || "");
            const load = useCallback(async (dd) => {
                try { setError(null); setD(await api("/api/kpl/mood/withdrawlist" + (dd ? "?day=" + encodeURIComponent(dd) : ""))); }
                catch (e) { setError(e && e.message ? e.message : String(e)); }
            }, []);
            useEffect(() => { load(day); }, [load, day]);
            const today = new Date();
            const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
            const step = (n) => {
                const t = new Date((d && d.day || day || todayStr) + "T00:00:00");
                t.setDate(t.getDate() + n);
                setDay(t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"));
            };
            const rows = (d && d.rows) || [];
            const children = [React.createElement(KplPageHeader, { key: "h", title: "大幅回撤", onBack: () => go({ page: "back" }) })];
            children.push(React.createElement("div", { key: "top", className: "kpl-mdd-head" },
                React.createElement("div", { className: "sj" },
                    React.createElement("span", { className: "lbl" }, "回撤股"),
                    React.createElement("b", null, d && d.num != null ? d.num : (rows.length || "--"))),
                React.createElement(KplMoodDayNav, { day: d && d.day, onPrev: () => step(-1), onNext: () => step(1), nextDis: (d && d.day || "") >= todayStr })));
            children.push(React.createElement("div", { key: "tbl", className: "kpl-lhb-scroll" },
                React.createElement("div", { className: "kpl-lhb-table stk" },
                    React.createElement("div", { className: "kpl-lhb-head wdd" },
                        React.createElement("span", { className: "sticky" }, "股票名称"),
                        React.createElement("span", null, "当日涨幅"),
                        React.createElement("span", { className: "hl" }, "当日回撤"),
                        React.createElement("span", { className: "r" }, "高点涨幅")),
                    rows.length ? rows.map((r, i) => React.createElement("div", {
                        key: r.code + i, className: "kpl-lhb-row wdd",
                        onClick: () => go({ page: "stock", stock: { code: r.code, name: r.name } }),
                    },
                        React.createElement("div", { className: "nm sticky" },
                            React.createElement("b", null, r.name),
                            React.createElement("span", { className: "cd" }, r.code)),
                        React.createElement("div", { className: "pctcol" },
                            React.createElement("b", { className: r.pct >= 0 ? "up" : "down" }, Number(r.pct).toFixed(2) + "%")),
                        React.createElement("div", { className: "moneycol hl" },
                            React.createElement("b", { className: "down" }, Number(r.drawdown).toFixed(2) + "%")),
                        React.createElement("div", { className: "pctcol" },
                            React.createElement("b", { className: "up" }, Number(r.high).toFixed(2) + "%"))))
                        : React.createElement("div", { className: "kpl-mdd-empty" }, d ? "暂无数据" : "加载中…"))));
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(ErrorBox, { error }),
                children);
        }

        function KplWeightsPage({ go, day: initDay }) {
            const [d, setD] = useState(null);
            const [error, setError] = useState(null);
            const [day, setDay] = useState(initDay || "");
            const load = useCallback(async (dd) => {
                try { setError(null); setD(await api("/api/kpl/mood/weightslist" + (dd ? "?day=" + encodeURIComponent(dd) : ""))); }
                catch (e) { setError(e && e.message ? e.message : String(e)); }
            }, []);
            useEffect(() => { load(day); }, [load, day]);
            const today = new Date();
            const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
            const step = (n) => {
                const t = new Date((d && d.day || day || todayStr) + "T00:00:00");
                t.setDate(t.getDate() + n);
                setDay(t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"));
            };
            const rows = ((d && d.rows) || []).slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0));
            const children = [React.createElement(KplPageHeader, { key: "h", title: "权重表现", onBack: () => go({ page: "back" }) })];
            children.push(React.createElement("div", { key: "top", className: "kpl-mdd-head" },
                React.createElement(KplMoodDayNav, { day: d && d.day, onPrev: () => step(-1), onNext: () => step(1), nextDis: (d && d.day || "") >= todayStr })));
            children.push(React.createElement("div", { key: "tbl", className: "kpl-lhb-scroll" },
                React.createElement("div", { className: "kpl-lhb-table stk" },
                    React.createElement("div", { className: "kpl-lhb-head wtl" },
                        React.createElement("span", { className: "sticky" }, "板块名称"),
                        React.createElement("span", { className: "hl" }, "涨幅"),
                        React.createElement("span", null, "涨速"),
                        React.createElement("span", { className: "r" }, "成交额")),
                    rows.length ? rows.map((r, i) => React.createElement("div", { key: r.id + i, className: "kpl-lhb-row wtl" },
                        React.createElement("div", { className: "nm sticky" },
                            React.createElement("b", null, r.name),
                            React.createElement("span", { className: "cd" }, r.id)),
                        React.createElement("div", { className: "pctcol hl" },
                            React.createElement("b", { className: r.pct >= 0 ? "up" : "down" }, Number(r.pct).toFixed(2) + "%")),
                        React.createElement("div", { className: "pctcol" }, r.speed != null ? Number(r.speed).toFixed(2) + "%" : "--"),
                        React.createElement("div", { className: "moneycol" }, r.amount != null ? fmtAmount(r.amount) : "--")))
                        : React.createElement("div", { className: "kpl-mdd-empty" }, d ? "暂无数据" : "加载中…"))));
            if (d && d.note) children.push(React.createElement("div", { key: "note", className: "kpl-mkt-tips", style: { padding: "8px 12px" } }, d.note));
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(ErrorBox, { error }),
                children);
        }

        /* ---- 功能宫格页（App 搜索功能宫格 40 项官方配置 1:1，kpl_func_grid.json）---- */

        function KplFuncGridPage({ go }) {
            const [items, setItems] = useState(null);
            useEffect(() => { api("/api/kpl/funcgrid").then(setItems).catch(() => setItems([])); }, []);
            // 官方 ID→插件下钻分发（复用已有页；app_only=App 账号功能不适用）
            const route = (it) => {
                const id = it.id;
                if (id === "1" || id === "6") return go({ page: "lhb" });
                if (id === "2") return go({ page: "market", sub: "live" });
                if (id === "3") return go({ page: "sentiment" });
                if (id === "4") return go({ page: "tika" });
                if (id === "5") return go({ page: "func_grid_notice" });
                if (id === "7") return go({ page: "func_pending", name: "复盘啦" });
                if (id === "8") return go({ page: "func_pending", name: "商品现货" });
                if (id === "9") return go({ page: "func_pending", name: "区间统计" });
                if (id === "10") return go({ page: "func_h5", name: "机构增仓", url: "/insPosInc/incPlate.html" });
                if (id === "12") return go({ page: "func_h5", name: "股东变更", url: "/web/Shareholder.html" });
                if (id === "13") return go({ page: "func_pending", name: "股东追踪" });
                if (id === "14") return go({ page: "func_pending", name: "大宗交易" });
                if (id === "16") return go({ page: "func_north" });
                if (id === "18") return go({ page: "func_pending", name: "百日新高" });
                if (id === "19") return go({ page: "func_pending", name: "互动易" });
                if (id === "20") return null;   // 我的版面=首页本体
                if (id === "21") return go({ page: "themes" });
                if (id === "23") return go({ page: "qiangdu" });
                if (id === "24") return go({ page: "daban" });
                if (id === "25") return go({ page: "fengkou" });
                if (id === "26") return go({ page: "poprank" });
                if (id === "27") return go({ page: "lhb", sub: "yizi" });
                if (id === "28") return go({ page: "func_pending", name: "涨停委买" });
                if (id === "29") return go({ page: "func_pending", name: "板块竞价异动" });
                if (id === "30") return go({ page: "func_radar" });
                if (id === "31") return go({ page: "func_pending", name: "尾盘抢筹" });
                if (id === "32") return go({ page: "func_pending", name: "板块叠加" });
                if (id === "33") return go({ page: "market", sub: "global" });
                if (id === "34") return go({ page: "func_zte" });
                if (id === "35") return go({ page: "func_pending", name: "严重异动提醒" });
                if (id === "40") return go({ page: "func_pending", name: "ETF基金" });
                if (id === "41") return go({ page: "func_pending", name: "业绩披露" });
                if (id === "42") return go({ page: "avoid" });
                return null;
            };
            const items2 = (items || []).filter((it) => !it.app_only);
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "全部功能", onBack: () => go({ page: "back" }) }),
                React.createElement("div", { className: "kpl-fg-grid" },
                    (items2 || []).map((it) => React.createElement("div", {
                        key: it.id, className: "kpl-fg-cell",
                        onClick: () => { const r = route(it); if (r) r(); },
                    },
                        React.createElement("img", { className: "ic", src: it.icon, loading: "lazy", onError: (e) => { e.target.style.visibility = "hidden"; } }),
                        React.createElement("div", { className: "nm" }, it.name)))));
        }

        // 宫格下钻：市场雷达（marketfeed 2101 已订阅）
        function KplRadarPage({ go }) {
            const [d, setD] = useState(null);
            const load = useCallback(async () => {
                try { setD(await api("/api/kpl/marketfeed")); } catch (e) { /* */ }
            }, []);
            useEffect(() => { load(); }, [load]);
            usePolling(load, 20000, []);
            const items = ((d || {}).radar || {}).data && d.radar.data.items || [];
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "市场雷达", onBack: () => go({ page: "back" }) }),
                items.length ? React.createElement("div", { className: "kpl-fg-radar" },
                    items.map((r, i) => React.createElement("div", { key: i, className: "rw" },
                        React.createElement("span", { className: "tm" }, r.ts ? fmtTs(Number(r.ts)) : "--"),
                        React.createElement("span", { className: "st", style: { color: r.color == 1 ? "#e03131" : "#2f9e44" } }, r.status || ""),
                        React.createElement("span", { className: "nm" }, r.name || ""),
                        r.incRate != null ? React.createElement("b", { className: r.incRate >= 0 ? "up" : "down" }, Number(r.incRate).toFixed(2) + "%") : null)))
                    : React.createElement("div", { className: "kpl-mdd-empty" }, "雷达为盘中推送，下一交易日 9:30 起自动更新"));
        }

        // 宫格下钻：沪深港通·北向资金历史（NorthboundFundsB Day 序列）
        function KplNorthPage({ go }) {
            const [d, setD] = useState(null);
            const load = useCallback(async () => {
                try { setD(await api("/api/kpl/mood")); } catch (e) { /* */ }
            }, []);
            useEffect(() => { load(); }, [load]);
            const nb = (d || {}).northbound || null;
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "沪深港通", onBack: () => go({ page: "back" }) }),
                nb ? React.createElement("div", { className: "kpl-fg-north" },
                    React.createElement("div", { className: "r1" },
                        "北向资金（", d.day, "）:",
                        React.createElement("b", null, " " + String(nb.totalB) + "亿")),
                    React.createElement("div", { className: "r2" }, nb.sign || ""),
                    Number(nb.status) > 0 ? React.createElement("div", { className: "kpl-mkt-tips", style: { padding: "8px 0" } },
                        "盘中分钟走势与沪股通/深股通分项见 App；北向自 2024-08 起盘中停发实时值，App 同口径") : null,
                    React.createElement("div", { className: "kpl-mkt-tips", style: { padding: "8px 0" } },
                        "历史单日序列接口（NorthwardCapital 系）待逆向（10-08 抓包）"))
                    : React.createElement("div", { className: "kpl-mdd-empty" }, "加载中…"));
        }

        // 宫格下钻：公告中心（CompanyNotice 列表复用）
        function KplNoticeCenterPage({ go }) {
            const [list, setList] = useState(null);
            const [err, setErr] = useState(null);
            const load = useCallback(async () => {
                try { const d = await api("/api/kpl/funcgrid_notice"); setList(d.list || []); setErr(null); }
                catch (e) { setErr(e.message); }
            }, []);
            useEffect(() => { load(); }, [load]);
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "公告中心", onBack: () => go({ page: "back" }) }),
                React.createElement(ErrorBox, { error: err }),
                (list || []).length ? React.createElement("div", { className: "kpl-sd-news" },
                    list.map((r, i) => React.createElement("a", {
                        key: i, className: "nw lnk", href: r.pdf || "#", target: "_blank", rel: "noreferrer",
                    },
                        React.createElement("div", { className: "nt" }, r.title || ""),
                        React.createElement("div", { className: "ns" }, r.date || "",
                            React.createElement("i", null, " " + (r.src || "") + " PDF ▸")))))
                    : React.createElement("div", { className: "kpl-mdd-empty" }, list ? "暂无公告" : "加载中…"));
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

        /* ---- 龙虎榜（App 底部导航同源 LongHuBang 控制器：股票/机构/营业部+订阅） ---- */

        function fmtMoneyWan(v) {   // 元 → x.x亿 / xxx万（净买入列；截断取整与 App 显示一致）
            const n = Number(v);
            if (!isFinite(n) || n === 0) return "0";
            if (Math.abs(n) >= 1e8) {
                const t = Math.trunc(Math.abs(n) / 1e8 * 100) / 100;
                return (n > 0 ? "" : "-") + t.toFixed(2) + "亿";
            }
            return (n > 0 ? "" : "-") + Math.trunc(Math.abs(n) / 1e4) + "万";
        }

        function KplLhbPage({ go }) {
            const [data, setData] = useState(null);
            const [tab, setTab] = useState("stock");     // state 只存 id 字符串
            const [day, setDay] = useState("");
            const [yixian, setYixian] = useState(null);
            const [subData, setSubData] = useState(null);
            const [subView, setSubView] = useState("today");   // 订阅 tab 三子页
            const [error, setError] = useState(null);
            const load = useCallback(async (d) => {
                try {
                    const r = await api("/api/kpl/lhb" + (d ? "?day=" + d : ""));
                    setData(r); setError(null);
                } catch (e) { setError(e.message); }
            }, []);
            useEffect(() => { load(day); }, [load, day]);
            usePolling(load, 60000, [day]);
            // 订阅 tab 数据（今日分组动态+我的订阅营业部+官方组合）
            useEffect(() => {
                if (tab !== "sub" || subData) return;
                api("/api/kpl/lhb/sub" + (day ? "?day=" + day : ""))
                    .then(setSubData).catch(() => setSubData({}));
            }, [tab, subData, day]);
            const cal = window.__kplTradeCal;
            const today = new Date().toISOString().slice(0, 10);
            const curDay = (data && data.day) || day || today;
            const shiftDay = (dir) => {
                // ±1 自然日点击，非交易日（周末/法定节假日）由后端按深交所日历
                // 归一到最近前一交易日（响应 day 回显实际交易日）
                const d = new Date(curDay + "T12:00:00");
                d.setDate(d.getDate() + dir);
                setDay(d.toISOString().slice(0, 10));
            };
            const canNext = curDay < today;   // App 同款：今日无 ▶
            const counts = (data && data.counts) || {};
            const stocks = (data && data.stocks) || [];
            const agencies = (data && data.agencies) || [];
            const business = (data && data.business) || [];
            const adays = (data && data.agency_days) || [];
            // 股票榜列头排序（App 同款点击列头切换；默认=服务端序）
            const [sortKey, setSortKey] = useState(null);
            const [sortDir, setSortDir] = useState(1);
            const toggleSort = (key) => {
                if (sortKey === key) setSortDir(-sortDir);
                else { setSortKey(key); setSortDir(1); }
            };
            const sortNum = (v) => { const n = parseFloat(String(v).replace(/[%,]/g, "")); return isFinite(n) ? n : -Infinity; };
            const sortVal = (s, key) => sortNum(
                key === "pct" ? s.pct : key === "buy" ? s.buy_in
                : key === "turn_ratio" ? s.turnover_ratio
                : key === "turnover" ? s.turnover : s.amplitude);
            const stockRows = React.useMemo(() => {
                if (!sortKey) return stocks;
                return [...stocks].sort((a, b) => (sortVal(a, sortKey) - sortVal(b, sortKey)) * sortDir);
            }, [stocks, sortKey, sortDir]);
            const sortArrow = (key) => sortKey === key ? (sortDir === 1 ? "▼" : "▲") : "↕";
            const tabs = [["stock", "股票"], ["agency", "机构"], ["biz", "营业部"], ["sub", "订阅"]];
            const dateText = (data && data.day) || day || "--";
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-lhb-top" },
                    React.createElement("span", { className: "cnt" },
                        "今日上榜数:", React.createElement("b", null,
                            tab === "agency" ? (counts.agency ?? "-") :
                            tab === "biz" ? (counts.business ?? "-") : (counts.stock ?? "-"))),
                    React.createElement("span", { className: "dnav" },
                        React.createElement("span", { className: "arrow", onClick: () => shiftDay(-1) }, "◀"),
                        React.createElement("span", { className: "d" }, dateText),
                        React.createElement("span", {
                            className: "arrow" + (canNext ? "" : " dis"),
                            onClick: () => canNext && shiftDay(1),
                        }, "▶"))),
                React.createElement("div", { className: "kpl-subtabs" },
                    tabs.map(([id, label]) => React.createElement("span", {
                        key: id, className: "kpl-subtab " + (tab === id ? "on" : ""),
                        onClick: () => setTab(id),
                    }, label))),
                error && React.createElement("div", { className: "kpl-empty" }, "加载失败：" + error),
                !data && !error && React.createElement("div", { className: "kpl-empty" }, "正在加载…"),
                tab === "stock" && data && React.createElement("div", { className: "kpl-lhb-scroll" },
                    React.createElement("div", { className: "kpl-lhb-table stk" },
                        React.createElement("div", { className: "kpl-lhb-head stk" },
                            React.createElement("span", { className: "sticky" }, "股票名称"),
                            React.createElement("span", null, "风口概念"),
                            React.createElement("span", { className: "r sort", onClick: () => toggleSort("pct") },
                                "涨幅 ", React.createElement("span", { className: "arr" }, sortArrow("pct"))),
                            React.createElement("span", { className: "r sort", onClick: () => toggleSort("buy") },
                                "净买入 ", React.createElement("span", { className: "arr" }, sortArrow("buy"))),
                            React.createElement("span", { className: "r sort", onClick: () => toggleSort("turn_ratio") },
                                "换手率 ", React.createElement("span", { className: "arr" }, sortArrow("turn_ratio"))),
                            React.createElement("span", { className: "r sort", onClick: () => toggleSort("turnover") },
                                "成交额 ", React.createElement("span", { className: "arr" }, sortArrow("turnover"))),
                            React.createElement("span", { className: "r sort", onClick: () => toggleSort("amp") },
                                "振幅 ", React.createElement("span", { className: "arr" }, sortArrow("amp"))),
                            React.createElement("span", { className: "r" }, "流通市值"),
                            React.createElement("span", { className: "r" }, "总市值")),
                        stockRows.map((s, i) => React.createElement("div", {
                            key: s.id + i, className: "kpl-lhb-row stk",
                            onClick: () => go && go({ page: "lhbStock", code: s.id, day: dateText }),
                        },
                            React.createElement("div", { className: "nm sticky" },
                                React.createElement("b", null, s.name),
                                React.createElement("span", { className: "cd" }, s.id),
                                Number(s.d3) > 0 ? React.createElement("span", { className: "d3tag" }, "3日") : null),
                            React.createElement("div", { className: "concept" },
                                (s.concept ? s.concept.split("/") : ["--"]).map((c, ci) =>
                                    React.createElement("div", { key: ci }, c))),
                            React.createElement("div", { className: "pctcol" },
                                React.createElement("span", { className: String(s.pct || "").indexOf("-") === 0 ? "down" : "up" }, s.pct || "--")),
                            React.createElement("div", { className: "buycol " + (s.buy_in >= 0 ? "up" : "down") },
                                fmtMoneyWan(s.buy_in)),
                            React.createElement("div", { className: "numcol" }, (s.turnover_ratio ?? "--") + "%"),
                            React.createElement("div", { className: "numcol" }, fmtAmount(s.turnover)),
                            React.createElement("div", { className: "numcol" }, (s.amplitude ?? "--") + "%"),
                            React.createElement("div", { className: "numcol" }, fmtAmount(s.circ_cap)),
                            React.createElement("div", { className: "numcol" }, fmtAmount(s.total_cap)))))),
                tab === "agency" && data && React.createElement("div", { className: "kpl-lhb-agency" },
                    React.createElement("div", { className: "kpl-lhb-agsum" },
                        "机构净买入: ",
                        React.createElement("b", { className: (data.agency_net || 0) >= 0 ? "up" : "down" },
                            fmtMoneyWan((data.agency_net || 0) * 1) )),
                    adays.length > 1 && React.createElement(KplLhbBars, { days: adays }),
                    React.createElement("div", { className: "kpl-lhb-head ag" },
                        React.createElement("span", null, "股票名称"),
                        React.createElement("span", { className: "r hl" }, "机构净买"),
                        React.createElement("span", { className: "r" }, "涨幅"),
                        React.createElement("span", { className: "r" }, "概念")),
                    agencies.map((a, i) => React.createElement("div", {
                        key: a.id + i, className: "kpl-lhb-row ag",
                        onClick: () => go && go({ page: "lhbStock", code: a.id, day: a.day || dateText }),
                    },
                        React.createElement("div", { className: "nm" },
                            React.createElement("b", null, a.name),
                            React.createElement("span", { className: "cd" }, a.id)),
                        React.createElement("div", { className: "buycol hl " + (a.buy_in >= 0 ? "up" : "down") },
                            fmtMoneyWan(a.buy_in)),
                        React.createElement("div", { className: "pctcol" },
                            React.createElement("span", { className: String(a.pct || "").indexOf("-") === 0 ? "down" : "up" }, a.pct || "--")),
                        React.createElement("div", { className: "concept sm" }, a.concept || "--")))),
                tab === "biz" && data && React.createElement("div", { className: "kpl-lhb-table" },
                    React.createElement("div", { className: "kpl-lhb-head biz" },
                        React.createElement("span", null, "营业部"),
                        React.createElement("span", { className: "r hl" }, "买入"),
                        React.createElement("span", { className: "r" }, "卖出"),
                        React.createElement("span", { className: "r" }, "关联数")),
                    business.map((b, i) => React.createElement("div", {
                        key: b.id + i, className: "kpl-lhb-row biz",
                        onClick: () => go && go({ page: "lhbBiz", id: b.id, name: b.name }),
                    },
                        React.createElement("div", { className: "nm wide" }, b.name),
                        React.createElement("div", { className: "buycol hl up" }, fmtMoneyWan(b.buy)),
                        React.createElement("div", { className: "sellcol down" }, fmtMoneyWan(b.sell)),
                        React.createElement("div", { className: "pctcol" }, b.join_num ?? "-")))),
                tab === "sub" && React.createElement(KplLhbSubTab, { subData, subView, go, dateText }));
        }

        // 龙虎榜·订阅 tab 三子页（今日=GetDay 分组动态 / 官方组合=GetYiXianByDay / 我的订阅=GetOfficev2）
        function KplLhbSubTab({ subData, subView, go, dateText }) {
            const groups = (subData && subData.groups) || [];
            const official = (subData && subData.official) || [];
            const offices = (subData && subData.offices) || [];
            const renderStockRow = (s, i, clickable) => React.createElement("div", {
                key: i, className: "kpl-lhb-row stk",
                onClick: clickable ? (() => go && go({ page: "lhbStock", code: s.id, day: dateText })) : undefined,
            },
                React.createElement("div", { className: "nm" },
                    React.createElement("b", null, s.name),
                    React.createElement("span", { className: "cd" }, s.id)),
                React.createElement("div", { className: "concept" }, "上榜 " + (s.num || "-") + " 次"),
                React.createElement("div", { className: "pctcol" },
                    React.createElement("span", { className: String(s.pct || "").indexOf("-") === 0 ? "down" : "up" }, s.pct || "--")),
                React.createElement("div", { className: "buycol up" }, fmtMoneyWan(s.money)));
            if (!subData) return React.createElement("div", { className: "kpl-empty" }, "正在加载…");
            if (subView === "today") {
                return React.createElement("div", { className: "kpl-lhb-sub" },
                    groups.map((g, gi) => React.createElement("div", { key: gi, className: "kpl-lhb-yxg" },
                        React.createElement("div", { className: "kpl-lhb-yxt" }, g.name),
                        (g.stocks || []).map((s, i) => renderStockRow(s, i, false)),
                        !(g.stocks || []).length && React.createElement("div", { className: "kpl-mkt-empty sm" }, "暂无动态"))));
            }
            if (subView === "official") {
                return React.createElement("div", { className: "kpl-lhb-sub" },
                    official.map((g, gi) => React.createElement("div", { key: gi, className: "kpl-lhb-yxg" },
                        React.createElement("div", { className: "kpl-lhb-yxt" }, g.name),
                        (g.stocks || []).map((s, i) => renderStockRow(s, i, true)))));
            }
            if (!offices.length) {
                return React.createElement("div", { className: "kpl-mkt-empty" },
                    "暂无订阅", React.createElement("br"),
                    "在开盘啦 App 龙虎榜·订阅页订阅营业部/游资后，此处同步显示");
            }
            return React.createElement("div", { className: "kpl-lhb-sub" },
                offices.map((o, i) => React.createElement("div", {
                    key: i, className: "kpl-lhb-row biz",
                    onClick: () => go && go({ page: "lhbBiz", id: o.id, name: o.name }),
                },
                    React.createElement("div", { className: "nm wide" }, o.name),
                    React.createElement("div", { className: "buycol up" }, o.buy != null ? fmtMoneyWan(o.buy) : "--"),
                    React.createElement("div", { className: "sellcol down" }, o.sell != null ? fmtMoneyWan(o.sell) : "--"),
                    React.createElement("div", { className: "pctcol" }, "--"))));
        }

        // 机构净买入历史柱状（canvas：红正绿负，日期轴 4-5 个刻度）
        function KplLhbBars({ days }) {
            const ref = useRef(null);
            useEffect(() => {
                const cv = ref.current;
                if (!cv || !days || days.length < 2) return;
                const dpr = window.devicePixelRatio || 1;
                const W = cv.clientWidth || 320, H = 110;
                cv.width = W * dpr; cv.height = H * dpr;
                const ctx = cv.getContext("2d");
                ctx.scale(dpr, dpr);
                ctx.clearRect(0, 0, W, H);
                const vals = days.map(d => d.net);
                const hi = Math.max(...vals, 1), lo = Math.min(...vals, -1);
                const mid = H * (hi / (hi - lo));        // 零轴位置
                const bw = Math.max(2, W / days.length - 2);
                ctx.strokeStyle = "#ddd";
                ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
                days.forEach((d, i) => {
                    const x = (i + 0.5) * W / days.length;
                    const h = Math.max(1, Math.abs(d.net) / Math.max(hi, -lo) * (H / 2 - 6));
                    ctx.fillStyle = d.net >= 0 ? "#e03131" : "#2f9e44";
                    ctx.fillRect(x - bw / 2, d.net >= 0 ? mid - h : mid, bw, h);
                });
                ctx.fillStyle = "#999"; ctx.font = "10px sans-serif";
                ctx.fillText(days[0].day.slice(5).replace("-", "/"), 2, H - 2);
                const last = days[days.length - 1].day.slice(5).replace("-", "/");
                ctx.fillText(last, W - 42, H - 2);
            }, [days]);
            return React.createElement("canvas", { ref, className: "kpl-lhb-bars", style: { height: "110px" } });
        }

                // 龙虎榜个股日 K（GetStockChart 收盘线，App 下钻 K 线区同源）
        function KplLhbKline({ code }) {
            const [k, setK] = useState(null);
            const [show, setShow] = useState(false);
            useEffect(() => {
                if (!show || k) return;
                api("/api/kpl/kline/" + code).then(setK).catch(() => { });
            }, [show, k, code]);
            return React.createElement("div", { className: "kpl-mkt-sec" },
                React.createElement("div", { className: "kpl-mkt-sec-t" }, "日 K 走势",
                    React.createElement("span", { className: "kpl-mkt-tips kpl-dswitch", onClick: () => setShow(!show) },
                        show ? "收起 ▲" : "展开 ▼")),
                show ? (k && k.dates && k.dates.length ?
                    React.createElement(KplTrendCanvas, {
                        points: k.close.map(c => ({ v: Array.isArray(c) ? c[3] : Number(c) })),
                        preClose: null, height: 130 })
                    : React.createElement("div", { className: "kpl-mkt-empty sm" }, "K 线数据加载中…"))
                    : React.createElement("div", { className: "kpl-mkt-tips" }, "点击展开近两年收盘走势"));
        }

        /* ---- 龙虎榜下钻：营业部详情/* ---- 龙虎榜下钻：营业部详情（近三月上榜/关联营业部/历史操作表） ---- */

        function KplLhbBizDetail({ id, name, go }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const load = useCallback(async () => {
                try { setData(await api("/api/kpl/lhb/business/" + id)); setError(null); }
                catch (e) { setError(e.message); }
            }, [id]);
            useEffect(() => { load(); }, [load]);
            const logs = (data && data.logs) || [];
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: name || (data && data.name) || "营业部详情",
                    onBack: () => go({ page: "back" }) }),
                React.createElement("div", { className: "kpl-lhb-bdstat" },
                    React.createElement("span", null, "近三个月上榜次数 ",
                        React.createElement("b", { className: "up" }, data ? (data.up_num ?? "-") : "…")),
                    React.createElement("span", null, "关联营业部 ",
                        React.createElement("b", null, data ? (data.assoc_num ?? "-") : "…"))),
                error && React.createElement("div", { className: "kpl-empty" }, "加载失败：" + error),
                React.createElement("div", { className: "kpl-lhb-table" },
                    React.createElement("div", { className: "kpl-lhb-head log5" },
                        React.createElement("span", null, "股票名称"),
                        React.createElement("span", null, "日期"),
                        React.createElement("span", { className: "r" }, "涨幅"),
                        React.createElement("span", { className: "r" }, "类别"),
                        React.createElement("span", { className: "r" }, "金额(万)")),
                    logs.map((l, i) => React.createElement("div", {
                        key: (l.LogID || i) + "_" + i, className: "kpl-lhb-row log5" + (i < 2 ? " hot" : ""),
                        onClick: () => go && go({ page: "lhbStock", code: l.stock_id, day: l.time }),
                    },
                        React.createElement("div", { className: "nm" },
                            React.createElement("b", { className: "blue" }, l.name),
                            React.createElement("span", { className: "cd" }, l.stock_id)),
                        React.createElement("div", { className: "datecol" },
                            React.createElement("div", null, (l.time || "").slice(0, 4)),
                            React.createElement("div", null, (l.time || "").slice(5))),
                        React.createElement("div", { className: "pctcol" },
                            React.createElement("span", { className: String(l.pct || "").indexOf("-") === 0 ? "down" : "up" }, l.pct || "--")),
                        React.createElement("div", { className: "typecol " + (l.type === 1 ? "up" : "down") },
                            l.type === 1 ? "买入" : "卖出"),
                        React.createElement("div", { className: "moneycol " + (l.type === 1 ? "up" : "down") },
                            l.money != null ? Number(l.money / 1e4).toFixed(2) : "--")))),
                data && !logs.length && React.createElement("div", { className: "kpl-empty" }, "近三月无 500 万以上操作记录"));
        }

        /* ---- 龙虎榜下钻：个股龙虎榜详情（买卖席位表+历史上榜日） ---- */

        function KplLhbStockDetail({ code, day, go }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const load = useCallback(async () => {
                try {
                    setData(await api("/api/kpl/lhb/stock/" + code + (day ? "?day=" + day : "")));
                    setError(null);
                } catch (e) { setError(e.message); }
            }, [code, day]);
            useEffect(() => { load(); }, [load]);
            const seats = (data && data.seats) || [];
            const pctStr = String((data && data.pct) || "");
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: (data && data.name) || code,
                    onBack: () => go({ page: "back" }) }),
                React.createElement("div", { className: "kpl-lhb-sdhead" },
                    React.createElement("span", null, "上榜日 ",
                        React.createElement("b", null, (data && data.day) || "--")),
                    React.createElement("span", null,
                        React.createElement("b", { className: pctStr.indexOf("-") === 0 ? "down" : "up" }, pctStr || "--")),
                    React.createElement("span", null, "净买 ",
                        React.createElement("b", { className: (data && data.buy_in || 0) >= 0 ? "up" : "down" },
                            data ? fmtMoneyWan(data.buy_in) : "--")),
                    React.createElement("span", null, "换手 ",
                        React.createElement("b", null, (data && data.turnover_ratio) || "--"))),
                error && React.createElement("div", { className: "kpl-empty" }, "加载失败：" + error),
                seats.map((g, gi) => React.createElement("div", { key: gi, className: "kpl-lhb-seatgrp" },
                    [["buy", "买入席位", "buy"], ["sell", "卖出席位", "sell"]].map(([key, label, cls]) =>
                        React.createElement("div", { key: key, className: "kpl-lhb-seats" },
                            React.createElement("div", { className: "kpl-lhb-seats-t " + cls }, label),
                            (g[key] || []).map((s, i) => React.createElement("div", { key: i, className: "kpl-lhb-seatrow" },
                                React.createElement("span", { className: "px" }, s.px || (i + 1)),
                                React.createElement("span", { className: "nm" }, s.name),
                                React.createElement("span", { className: "v " + cls },
                                    fmtMoneyWan(key === "buy" ? s.buy : s.sell)))))))),
                React.createElement(KplLhbKline, { code: code }),
                data && data.on_times && data.on_times.length > 1 && React.createElement("div", { className: "kpl-lhb-ontime" },
                    "历史上榜: ", data.on_times.slice(0, 10).join("、"),
                    data.on_times.length > 10 ? " 等" + data.on_times.length + " 次" : ""));
        }

        /* ---- 市场风口下钻页（GetFengKList：按股票/按概念双视图+日期回看） ---- */

        function KplFengkouPage({ go }) {
            const [data, setData] = useState(null);
            const [day, setDay] = useState("");
            const [view, setView] = useState("stock");   // state 只存 id 字符串
            const [error, setError] = useState(null);
            const load = useCallback(async (d) => {
                try {
                    const r = await api("/api/kpl/fengkou" + (d ? "?day=" + d : ""));
                    setData(r); setError(null);
                } catch (e) { setError(e.message); }
            }, []);
            useEffect(() => { load(day); }, [load, day]);
            usePolling(() => load(day), 30000, [day]);
            const rows = (data && data.rows) || [];
            const dayArr = (data && data.day_arr) || [];
            const curDay = (data && data.day) || day || "";
            // 概念聚合：净额合计降序（App"按概念"视图口径为插件推导，有实拍后校准）
            const byConcept = React.useMemo(() => {
                const m = {};
                rows.forEach((r) => {
                    const cs = String(r.concept || "").split("/").filter(Boolean);
                    cs.forEach((c) => {
                        m[c] = m[c] || { name: c, net: 0, n: 0 };
                        m[c].net += Number(r.net) || 0;
                        m[c].n += 1;
                    });
                });
                return Object.values(m).sort((a, b) => b.net - a.net);
            }, [rows]);
            const fmtNet = (v) => {
                const n = Number(v);
                if (!isFinite(n)) return "--";
                if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + "亿";
                return (n / 1e4).toFixed(0) + "万";
            };
            const shiftDay = (dir) => {
                // App 日期回看：在服务端 DayArr（可用交易日数组）内步进，缺省端点当日
                if (!dayArr.length) return;
                let idx = dayArr.indexOf(curDay);
                if (idx < 0) idx = 0;
                idx = Math.min(Math.max(idx + dir, 0), dayArr.length - 1);
                const d = dayArr[idx];
                if (d && d !== curDay) setDay(d);
            };
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "市场风口", onBack: () => go({ page: "back" }) }),
                React.createElement("div", { className: "kpl-fk-tip" },
                    "主力资金风口榜（净买入口径） · 上榜时间见行标"),
                React.createElement("div", { className: "kpl-qd2-daynav" },
                    React.createElement("span", { className: "arrow", onClick: () => shiftDay(-1) }, "◀"),
                    React.createElement("span", { className: "d" }, curDay || "--"),
                    React.createElement("span", {
                        className: "arrow" + (curDay && dayArr.length && curDay !== dayArr[0] ? "" : " dis"),
                        onClick: () => shiftDay(1),
                    }, "▶")),
                React.createElement("div", { className: "kpl-subtabs" },
                    [["stock", "按股票"], ["concept", "按概念"]].map(function (pair) {
                        return React.createElement("span", {
                            key: pair[0], className: "kpl-subtab " + (view === pair[0] ? "on" : ""),
                            onClick: function () { setView(pair[0]); },
                        }, pair[1]);
                    })),
                error && React.createElement("div", { className: "kpl-empty" }, "加载失败：" + error),
                !data && !error && React.createElement("div", { className: "kpl-empty" }, "正在加载…"),
                view === "stock" && rows.length ? React.createElement("div", { className: "kpl-lhb-scroll" },
                    React.createElement("div", { className: "kpl-lhb-table stk" },
                        React.createElement("div", { className: "kpl-lhb-head fk" },
                            React.createElement("span", { className: "sticky" }, "股票名称"),
                            React.createElement("span", { className: "r hl" }, "主力净额"),
                            React.createElement("span", { className: "r" }, "涨跌幅"),
                            React.createElement("span", null, "风口概念")),
                        rows.map((r, i) => React.createElement("div", {
                            key: r.code + i, className: "kpl-lhb-row fk",
                            onClick: () => go && go({ page: "stock", stock: { code: r.code, name: r.name } }),
                        },
                            React.createElement("div", { className: "nm sticky" },
                                React.createElement("b", null, r.name),
                                React.createElement("span", { className: "cd" }, r.code),
                                r.tag ? React.createElement("span", { className: "d3tag" }, r.tag) : null),
                            React.createElement("div", { className: "buycol hl " + (Number(r.net) >= 0 ? "up" : "down") },
                                fmtNet(r.net)),
                            React.createElement("div", { className: "pctcol" },
                                React.createElement("span", { className: Number(r.rate) >= 0 ? "up" : "down" },
                                    r.rate != null ? Number(r.rate).toFixed(2) + "%" : "--")),
                            React.createElement("div", { className: "concept" }, r.concept || "--")))))
                    : (view === "stock" && data ? React.createElement("div", { className: "kpl-empty" },
                        curDay && curDay !== (dayArr[0] || "") ? "该日无风口数据" : "暂无数据（交易时段 9:30 起实时更新）") : null),
                view === "concept" && byConcept.length ? React.createElement("div", { className: "kpl-lhb-scroll" },
                    React.createElement("div", { className: "kpl-lhb-table stk" },
                        React.createElement("div", { className: "kpl-lhb-head fk2" },
                            React.createElement("span", null, "概念"),
                            React.createElement("span", { className: "r hl" }, "净额合计"),
                            React.createElement("span", { className: "r" }, "入榜家数")),
                        byConcept.map((c, i) => React.createElement("div", { key: i, className: "kpl-lhb-row fk2" },
                            React.createElement("div", { className: "nm" }, React.createElement("b", null, c.name)),
                            React.createElement("div", { className: "buycol hl " + (c.net >= 0 ? "up" : "down") }, fmtNet(c.net)),
                            React.createElement("div", { className: "numcol" }, c.n + " 家")))))
                    : (view === "concept" && data ? React.createElement("div", { className: "kpl-empty" }, "暂无数据") : null));
        }

        /* ---- 板块详情下钻页（801/803 体系：2501 股票池+概要条） ---- */

        function KplSectorDetailPage({ plateId, name, go }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const [ex, setEx] = useState(null);
            const [ptab, setPtab] = useState("pool");
            const [cview, setCview] = useState("fs");
            const load = useCallback(async () => {
                try {
                    const d = await api("/api/kpl/sector/" + plateId);
                    setData(d); setError(null);
                } catch (e) { setError(e.message); }
            }, [plateId]);
            useEffect(() => { load(); }, [load]);
            usePolling(load, 20000, [plateId]);
            useEffect(() => {
                let alive = true;
                api("/api/kpl/plate/extras/" + plateId).then((x) => { if (alive) setEx(x); }).catch(() => { });
                return () => { alive = false; };
            }, [plateId]);
            usePolling(() => { api("/api/kpl/plate/extras/" + plateId).then((x) => setEx(x)).catch(() => { }); }, 60000, [plateId]);
            const stocks = (data && data.stocks) || [];
            const sum = (data && data.summary) || null;
            const pending = data && (data.pool_pending || data.quotes_pending);
            const title = (data && data.name) || name || plateId;
            const qj = (ex && ex.qj) || null;
            const bkr = (ex && ex.bkr) || {};
            const bkrList = (bkr.List || []).concat(bkr.List_Special || []);
            const fenshi = (ex && ex.fenshi) || {};
            const children = [React.createElement(KplPageHeader, { key: "h", title: title, onBack: () => go({ page: "back" }) })];
            if (sum) {
                children.push(React.createElement("div", { key: "sum", className: "kpl-sdp-sum eight" },
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "强度"),
                        React.createElement("div", { className: "v up" }, qj && qj.strength != null ? qj.strength : "--")),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "排名"),
                        React.createElement("div", { className: "v" }, qj && qj.rank != null ? qj.rank : "--")),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "涨停数"),
                        React.createElement("div", { className: "v up" }, qj && qj.zt_num != null ? qj.zt_num : (sum.zt_num != null ? sum.zt_num : "--"))),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "涨停封单"),
                        React.createElement("div", { className: "v" }, qj && qj.zt_seal != null ? qj.zt_seal + "亿" : "--")),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "涨幅"),
                        React.createElement("div", { className: "v " + (Number(sum.rate) >= 0 ? "up" : "down") },
                            sum.rate != null ? Number(sum.rate).toFixed(2) + "%" : "--")),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "主力净额"),
                        React.createElement("div", { className: "v " + (Number(qj && qj.main_net) >= 0 ? "up" : "down") },
                            qj && qj.main_net != null ? qj.main_net + "亿" : (sum.main_net != null ? sum.main_net + "亿" : "--"))),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "成交额"),
                        React.createElement("div", { className: "v" }, qj && qj.amount != null ? fmtAmount(qj.amount) : (sum.amount_sum != null ? sum.amount_sum + "亿" : "--"))),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "大单封单"),
                        React.createElement("div", { className: "v" }, qj && qj.big_seal != null ? qj.big_seal + "亿" : "--"))));
            }
            children.push(React.createElement("div", { key: "chart", className: "kpl-sdp-chart" },
                React.createElement("div", { className: "cvtabs" },
                    React.createElement("span", { className: cview === "fs" ? "on" : "", onClick: () => setCview("fs") }, "分时"),
                    React.createElement("span", { className: cview === "k" ? "on" : "", onClick: () => setCview("k") }, "K线")),
                cview === "fs"
                    ? ((fenshi.list || []).length
                        ? React.createElement(KplTrendCanvas, {
                            points: fenshi.list.map((p) => ({ v: Number(p && (p.value != null ? p.value : p[1])) || 0 })),
                            preClose: null, height: 160 })
                        : React.createElement("div", { className: "kpl-mdd-empty" },
                            "分时为盘中直播推送，盘后无数据（App 同款读本地缓存）；下一交易日盘中自动更新"))
                    : React.createElement("div", { className: "kpl-mdd-empty" },
                        "板块K线走 socket 2400/2402（盘后静默），10-08 盘中接入")));
            children.push(React.createElement("div", { key: "ptabs", className: "kpl-mdd-tabs" },
                React.createElement("span", { className: ptab === "pool" ? "ttab on2" : "ttab", onClick: () => setPtab("pool") }, "股票池"),
                React.createElement("span", { className: ptab === "bkr" ? "ttab on2" : "ttab", onClick: () => setPtab("bkr") }, "机构纪要")));
            if (ptab === "pool") {
                if (error) {
                    children.push(React.createElement("div", { key: "err", className: "kpl-empty" }, "加载失败：" + error));
                }
                if (pending) {
                    children.push(React.createElement("div", { key: "pend", className: "kpl-empty" },
                        "行情连接建立中，数据稍后自动补全…"));
                }
                if (!error && data && !stocks.length && !pending) {
                    children.push(React.createElement("div", { key: "none", className: "kpl-empty" }, "暂无成分股数据"));
                }
                if (stocks.length) {
                    children.push(React.createElement("div", { key: "tbl", className: "kpl-lhb-scroll" },
                        React.createElement("div", { className: "kpl-lhb-table stk" },
                            React.createElement("div", { className: "kpl-lhb-head sdp" },
                                React.createElement("span", { className: "sticky" }, "股票名称"),
                                React.createElement("span", { className: "r" }, "现价"),
                                React.createElement("span", { className: "r hl" }, "涨幅"),
                                React.createElement("span", { className: "r" }, "成交额"),
                                React.createElement("span", { className: "r" }, "主力净额"),
                                React.createElement("span", { className: "r" }, "涨停封单")),
                            stocks.map((r, i) => React.createElement("div", {
                                key: r.code + i, className: "kpl-lhb-row sdp" + (Number(r.rate) >= 9.8 ? " zt" : ""),
                                onClick: () => go && go({ page: "stock", stock: { code: r.code, name: r.name } }),
                            },
                                React.createElement("div", { className: "nm sticky" },
                                    React.createElement("b", null, r.name || "--"),
                                    React.createElement("span", { className: "cd" }, r.code)),
                                React.createElement("div", { className: "numcol" }, r.price || "--"),
                                React.createElement("div", { className: "pctcol" },
                                    React.createElement("span", { className: Number(r.rate) >= 0 ? "up" : "down" },
                                        r.rate != null ? Number(r.rate).toFixed(2) + "%" : "--")),
                                React.createElement("div", { className: "numcol" }, r.amount || "--"),
                                React.createElement("div", { className: "numcol " + (String(r.mainNet).indexOf("-") === 0 ? "down" : "up") }, r.mainNet || "--"),
                                React.createElement("div", { className: "numcol up" }, r.ztSeal || "--"))))));
                }
            } else {
                children.push(bkrList.length
                    ? React.createElement("div", { key: "bkr", className: "kpl-sdp-bkr" },
                        bkrList.map((it, i) => React.createElement("div", { key: i, className: "bkr-item" },
                            React.createElement("div", { className: "bt" }, it.title || it.Title || ""),
                            React.createElement("div", { className: "bc", dangerouslySetInnerHTML: { __html: it.content || it.Content || "" } }))))
                    : React.createElement("div", { key: "bkrnone", className: "kpl-mdd-empty" },
                        ex ? "暂无机构纪要（该板块无纪要内容）" : "加载中…"));
            }
            return React.createElement("div", { className: "kpl-page" }, children);
        }



        /* ---- 闪电避雷（3011 潜在风险 + 3012 ST/退市股，App LightningProtection 同源） ---- */

        function KplAvoidPage({ go }) {
            const [data, setData] = useState(null);
            const [tab, setTab] = useState("illegal");
            const [error, setError] = useState(null);
            const load = useCallback(async () => {
                try { setData(await api("/api/kpl/avoid-risks")); setError(null); }
                catch (e) { setError(e.message); }
            }, []);
            useEffect(() => { load(); }, [load]);
            usePolling(load, 120000, []);
            const risks = (data && data.risks) || {};
            const RISK_TABS = [
                ["illegal", "违规披露", "illegal"], ["audit", "审计风险", "audit"],
                ["netAsset", "净资产", "netAsset"], ["revenue", "营收", "revenue"],
                ["business", "经营能力", "business"],
            ];
            const cur = risks[tab] || [];
            const stStocks = (data && data.st_stocks) || [];
            const tsStocks = (data && data.ts_stocks) || [];
            const row = (r, i) => React.createElement("div", {
                key: r.code + "_" + i, className: "kpl-lhb-row stk",
                onClick: () => go && go({ page: "stock", stock: { code: r.code, name: r.name || r.code } }),
            },
                React.createElement("div", { className: "nm" },
                    React.createElement("b", null, r.name || "--"),
                    React.createElement("span", { className: "cd" }, r.code || "")),
                React.createElement("div", { className: "concept" }, r.date || "--"),
                React.createElement("div", { className: "pctcol" },
                    React.createElement("span", { className: Number(r.pct) >= 0 ? "up" : "down" },
                        r.pct != null ? Number(r.pct).toFixed(2) + "%" : "--")),
                React.createElement("div", { className: "concept sm" }, r.reason || "--"));
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "闪电避雷", onBack: () => go({ page: "back" }) }),
                (data && data.excelName) ? React.createElement("div", { className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-mkt-sec-t" }, "每日避雷清单"),
                    React.createElement("div", { className: "kpl-mkt-broadcast" }, data.excelName),
                    data.excelUrl ? React.createElement("a", {
                        href: data.excelUrl, target: "_blank", rel: "noreferrer",
                        style: { color: "#1c5fbb", fontSize: "12px" },
                    }, "下载 Excel 附件 ›") : null) : null,
                error && React.createElement("div", { className: "kpl-empty" }, "加载失败：" + error),
                !data && !error && React.createElement("div", { className: "kpl-empty" }, "正在加载…"),
                data && React.createElement("div", { className: "kpl-subtabs" },
                    RISK_TABS.map(function (pair) {
                        const n = (risks[pair[2]] || []).length;
                        return React.createElement("span", {
                            key: pair[0], className: "kpl-subtab " + (tab === pair[0] ? "on" : ""),
                            onClick: function () { setTab(pair[0]); },
                        }, pair[1], n ? "(" + n + ")" : "");
                    })),
                data && cur.length ? React.createElement("div", { className: "kpl-lhb-scroll" },
                    React.createElement("div", { className: "kpl-lhb-table stk" },
                        React.createElement("div", { className: "kpl-lhb-head av" },
                            React.createElement("span", { className: "sticky" }, "股票名称"),
                            React.createElement("span", null, "风险日期"),
                            React.createElement("span", { className: "r" }, "至今涨跌"),
                            React.createElement("span", null, "风险原因")),
                        cur.map(row)))
                    : (data ? React.createElement("div", { className: "kpl-empty" }, "该类暂无风险股票") : null),
                data && React.createElement("div", { className: "kpl-mkt-sec" },
                    React.createElement("div", { className: "kpl-mkt-sec-t" },
                        "ST 股(", stStocks.length, ") / 退市整理(", tsStocks.length, ")"),
                    React.createElement("div", { className: "kpl-mkt-wplates" },
                        stStocks.slice(0, 40).map(function (x, i) {
                            return React.createElement("span", {
                                key: i, className: "wp down",
                                onClick: function () { go && go({ page: "stock", stock: { code: x.code, name: x.code } }); },
                            }, x.code);
                        }),
                        tsStocks.map(function (x, i) {
                            return React.createElement("span", {
                                key: "t" + i, className: "wp up",
                                onClick: function () { go && go({ page: "stock", stock: { code: x.code, name: x.code } }); },
                            }, x.code);
                        }))));
        }

        /* ---- 推荐菜单（App 底部导航推荐：栏目 tab+文章卡片流，ForumsMsgColumn 同源） ---- */

        /* ---- 推荐菜单（App 底部导航推荐：栏目 tab 横滑+更多弹层+专栏页，ForumsMsgColumn 同源） ---- */

        /* ---- 推荐菜单最终 1:1（App 实拍 m0/m1：双大 tab+栏目横滑 HOT+左文右图卡片） ---- */

        function KplRecommendPage({ go }) {
            const [bigTab, setBigTab] = useState("art");          // art=文章 / follow=关注
            const [cols, setCols] = useState(null);
            const [cur, setCur] = useState("rec");                // rec=推荐(AppNews) 或栏目 ID
            const [feed, setFeed] = useState(null);
            const [preIndex, setPreIndex] = useState(null);
            const [error, setError] = useState(null);
            const [loading, setLoading] = useState(false);
            const [allOpen, setAllOpen] = useState(false);
            const loadFeed = useCallback(async (cid, pi) => {
                setLoading(true);
                try {
                    const d = await api(`/api/kpl/column/${cid}` + (pi ? `?pre_index=${encodeURIComponent(pi)}` : ""));
                    setError(null);
                    setFeed((prev) => (pi ? (prev || []).concat(d.list || []) : (d.list || [])));
                    setPreIndex(d.pre_index != null ? String(d.pre_index) : null);
                } catch (e) { setError(e.message); }
                finally { setLoading(false); }
            }, []);
            useEffect(() => {
                (async () => {
                    try {
                        const d = await api("/api/kpl/recommend");
                        setCols(d.columns || []);
                        setFeed(await api("/api/kpl/arttab"));
                    } catch (e) { setError(e.message); }
                })();
            }, []);
            const switchCol = (cid) => {
                if (cid === cur) return;
                setCur(cid); setFeed(null); setPreIndex(null);
                if (cid !== "rec") loadFeed(cid, null);
                else (async () => {
                    try { setFeed(await api("/api/kpl/arttab")); } catch { setFeed([]); }
                })();
            };
            const relTime = (t) => {
                if (!t) return "";
                const d = new Date(t * 1000), now = new Date();
                const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                const sameDay = d.toDateString() === now.toDateString();
                const yest = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
                if (sameDay) return hm;
                if (yest) return "昨天 " + hm;
                return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
            };
            const stockChips = (stocks) => (stocks || []).slice(0, 3).map((s, i) => {
                const code = s[0], nm = s[1], pct = s[2];
                const up = String(pct).indexOf("-") !== 0;
                return React.createElement("span", { key: i, className: "chip " + (up ? "up" : "down") },
                    nm + " " + (pct != null ? pct + "%" : ""));
            });
            const cards = (list) => (list || []).map((a) => React.createElement("div", { key: a.id,
                className: "kpl-rcm-card",
                onClick: () => go({ page: "article", aid: a.aid || a.id, title: (a.title || a.content || "").slice(0, 30),
                    zhaiyao: a.zhaiyao, img: a.img, time: a.time, pay: a.is_pay }) },
                React.createElement("div", { className: "main" },
                    React.createElement("div", { className: "tt" },
                        (a.title || a.content || "--").slice(0, 50) + ((a.title || a.content || "").length > 50 ? "…" : "")),
                    (a.stocks || []).length ? React.createElement("div", { className: "chips" }, stockChips(a.stocks)) : null,
                    React.createElement("div", { className: "meta" },
                        React.createElement("span", { className: "src" }, a.account || ""),
                        React.createElement("span", null, relTime(a.time)))),
                a.img ? React.createElement("img", { className: "thumb", src: a.img,
                    onError: (e) => { e.target.style.display = "none"; } }) : null));
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-rcm-top" },
                    React.createElement("span", { className: "bt " + (bigTab === "follow" ? "on" : ""),
                        onClick: () => setBigTab("follow") }, "关注"),
                    React.createElement("span", { className: "bt " + (bigTab === "art" ? "on" : ""),
                        onClick: () => setBigTab("art") }, "文章"),
                    React.createElement("span", { className: "tools" },
                        React.createElement("i", { className: "tl", onClick: () => go({ page: "search" }) }, "🔍"))),
                bigTab === "art" && React.createElement("div", { className: "kpl-rcm-cols" },
                    React.createElement("span", { className: "c " + (cur === "rec" ? "on" : ""),
                        onClick: () => switchCol("rec") }, "推荐"),
                    (cols || []).map((c) => React.createElement("span", {
                        key: c.id, className: "c " + (cur === c.id ? "on" : ""),
                        onClick: () => switchCol(c.id),
                    }, c.name, c.hot ? React.createElement("i", { className: "hot" }, "HOT") : null))),
                bigTab === "art" && React.createElement(LoadingBar, { show: feed === null && !error }),
                bigTab === "art" && React.createElement(ErrorBox, { error }),
                bigTab === "art" && cards(feed),
                bigTab === "art" && React.createElement("div", { className: "kpl-rcm-more" },
                    loading ? React.createElement("span", { className: "ld" }, "加载中…") : null),
                bigTab === "follow" && React.createElement(FollowPane, { cols, go, cards }));
        }

        /* 关注 pane：我的关注栏目头像横滑+首个栏目文章流（App m1 实拍形态） */
        function FollowPane({ cols, go, cards }) {
            const followed = (cols || []).filter((c) => c.sub);
            const showCols = followed.length ? followed : (cols || []).slice(0, 6);
            const [curF, setCurF] = useState(null);
            const [fl, setFl] = useState(null);
            const [err, setErr] = useState(null);
            const target = curF || (showCols[0] && showCols[0].id) || null;
            useEffect(() => {
                if (!target) return;
                (async () => {
                    try {
                        const d = await api(`/api/kpl/column/${target}`);
                        setErr(null);
                        setFl(d.list || []);
                    } catch (e) { setErr(e.message); }
                })();
            }, [target]);
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-rcm-followhead" },
                    React.createElement("span", { className: "t" }, "我的关注"),
                    React.createElement("span", { className: "more", onClick: () => go({ page: "artCenter" }) }, "更多 ›"),
                    React.createElement("div", { className: "avatars" },
                        showCols.map((c) => React.createElement("span", { key: c.id, className: "av",
                            onClick: () => setCurF(c.id) },
                            React.createElement("img", { src: c.head_pic,
                                onError: (e) => { e.target.style.display = "none"; } }),
                            React.createElement("span", { className: "nm" }, c.name))))),
                React.createElement(ErrorBox, { error: err }),
                React.createElement(LoadingBar, { show: !fl && !err }),
                cards(fl));
        }

        /* ---- 栏目专栏页（ForumsMsgColumn/GetInfo：栏目头+文章流） ---- */

        function KplColumnPage({ cid, name, go }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const [list, setList] = useState([]);
            const [preIndex, setPreIndex] = useState(null);
            const [loading, setLoading] = useState(false);
            const load = useCallback(async (pi) => {
                setLoading(true);
                try {
                    const d = await api(`/api/kpl/column/${cid}` + (pi ? `?pre_index=${encodeURIComponent(pi)}` : ""));
                    setError(null);
                    setData(d);
                    setList((prev) => (pi ? prev.concat(d.list || []) : (d.list || [])));
                    setPreIndex(d.pre_index != null ? String(d.pre_index) : null);
                } catch (e) { setError(e.message); }
                finally { setLoading(false); }
            }, [cid]);
            useEffect(() => { load(null); }, [cid]);
            const col = (data && data.column) || {};
            const desc = (col.descn || "").replace(/<[^>]+>/g, "");
            const fmtT = (t) => t ? new Date(t * 1000).toLocaleString("zh-CN",
                { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: name || col.name || "专栏",
                    onBack: () => go({ page: "back" }) }),
                React.createElement(ErrorBox, { error }),
                React.createElement("div", { className: "kpl-col-head" },
                    col.head_pic ? React.createElement("img", { className: "bg", src: col.head_pic,
                        onError: (e) => { e.target.style.display = "none"; } }) : null,
                    React.createElement("div", { className: "bar" },
                        React.createElement("b", null, col.name || name || "--"),
                        React.createElement("span", null, "关注 " + (col.focus ?? "--")))),
                desc ? React.createElement("div", { className: "kpl-col-desc" }, desc) : null,
                React.createElement(LoadingBar, { show: !data && !error }),
                (list || []).map((a) => React.createElement("div", { key: a.id, className: "kpl-rcm-card",
                    onClick: () => go({ page: "article", aid: a.aid || a.id, title: a.title.slice(0, 30),
                    zhaiyao: a.zhaiyao, img: a.img, time: a.time, pay: a.is_pay }) },
                    React.createElement("div", { className: "main" },
                        React.createElement("div", { className: "tt" }, a.title),
                        a.zhaiyao ? React.createElement("div", { className: "zy" },
                            a.zhaiyao.slice(0, 46) + (a.zhaiyao.length > 46 ? "…" : "")) : null,
                        React.createElement("div", { className: "meta" },
                            React.createElement("span", null, fmtT(a.time)),
                            React.createElement("span", null, "赞 " + a.vote),
                            a.is_pay ? React.createElement("span", { className: "pay" }, "订阅") : null)),
                    a.img ? React.createElement("img", { className: "thumb", src: a.img,
                        onError: (e) => { e.target.style.display = "none"; } }) : null)),
                React.createElement("div", { className: "kpl-rcm-more" },
                    loading ? React.createElement("span", { className: "ld" }, "加载中…")
                        : preIndex ? React.createElement("button", {
                            onClick: () => load(preIndex) }, "加载更多")
                            : (list.length ? React.createElement("span", { className: "ld" }, "已显示全部") : null)));
        }

        /* ---- 文章详情（ForumsMsgJX/GetInfo，App PContent2.html 同源） ---- */

        function KplArticleDetail({ aid, title, zhaiyao, img, time: ptime, pay, go }) {
            const [art, setArt] = useState(null);
            const [error, setError] = useState(null);
            const load = useCallback(async () => {
                try { setArt(await api("/api/kpl/article/" + encodeURIComponent(aid))); setError(null); }
                catch (e) { setError(e.message); }
            }, [aid]);
            useEffect(() => { load(); }, [aid]);
            const openStk = (code, name) => {
                if (code && /^\d{6}$/.test(String(code))) go({ page: "stock", stock: { code, name: name || code } });
            };
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: title || "文章详情", onBack: () => go({ page: "back" }) }),
                React.createElement(LoadingBar, { show: !art && !error }),
                React.createElement(ErrorBox, { error }),
                art && React.createElement("div", { className: "kpl-art" },
                    React.createElement("div", { className: "kpl-art-head" },
                        React.createElement("h1", { className: "kpl-art-title" }, art.title || title || "--"),
                        React.createElement("div", { className: "kpl-art-time" },
                            "更新时间：" + ((art.time || ptime) ? new Date((art.time || ptime) * 1000).toLocaleString("zh-CN",
                                { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "--"))),
                    React.createElement("div", { className: "kpl-art-decl" },
                        React.createElement("b", null, "【重点声明】"),
                        "本文转载自网络，与开盘啦立场无关，不构成投资建议。据此操作，风险自担。"),
                    art.zhaiyao ? React.createElement("div", { className: "kpl-art-zy" }, art.zhaiyao) : null,
                    React.createElement("div", { className: "kpl-art-body",
                        dangerouslySetInnerHTML: { __html: art.content || "" } }),
                    !art.content && (zhaiyao || img) && React.createElement("div", { className: "kpl-art-deg" },
                        img ? React.createElement("img", { src: img, style: { maxWidth: "100%", borderRadius: 8, marginBottom: 10 },
                            onError: (e) => { e.target.style.display = "none"; } }) : null,
                        zhaiyao ? React.createElement("div", { className: "zy" }, zhaiyao) : null,
                        React.createElement("div", { className: "note" },
                            "该栏目文章的正文接口未开放（App 内为原生页渲染），以上为摘要；全文请在开盘啦 App 查看"),
                        pay ? React.createElement("div", { className: "paytip" }, "本文为订阅内容") : null),
                    (art.stocks || []).length > 0 && React.createElement("div", { className: "kpl-art-stks" },
                        React.createElement("div", { className: "t" }, "相关股票"),
                        art.stocks.map((s, i) => React.createElement("span", { key: i, className: "stk",
                            onClick: () => openStk(s.StockID || s.ID || s.code, s.StockName || s.Name || s.name) },
                            (s.StockName || s.Name || s.name || "") + " " + (s.StockID || s.ID || s.code || "")))),
                    React.createElement("div", { className: "kpl-art-tip" },
                        "本文不构成投资建议，据此操作风险自担")));
        }

                /* ---- 多次异动个股下钻（DeviationManyChangeActivity 1:1：沪深主板/创业科创板双 tab
                        + 分组分节表格，yd16 实拍；行字段 yidong_family_20261005.json 锚定） ---- */

        function KplYidongManyPage({ go }) {
            const [d, setData] = useState(null);
            const [error, setError] = useState(null);
            const [tab, setTab] = useState("1"); // board: 1=沪深主板 2=创业/科创板（服务端字段）
            useEffect(() => {
                api("/api/kpl/yidong/many").then(setData).catch((e) => setError(e.message));
            }, []);
            const rows = (d && d.list || []).filter((r) => String(r.board) === tab);
            const groups = [];
            rows.forEach((it) => {
                const g = groups.find((x) => x.name === it.group);
                if (g) g.items.push(it); else groups.push({ name: it.group, items: [it] });
            });
            // 列头随分组变（yd16 实拍：3次异动→预计严重异动价格；2次异动→预计3次异动价格；
            // 异动停牌后复牌→预计停牌价格；偏离值临近→预计严重异动价格）
            const estHead = (name) => name.indexOf("停牌") >= 0 ? "预计停牌价格"
                : name.indexOf("2次") >= 0 ? "预计3次异动价格" : "预计严重异动价格";
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: "多次异动个股",
                    onBack: () => go({ page: "back" }) }),
                React.createElement("div", { className: "kpl-ydm-tabs" },
                    React.createElement("div", {
                        className: "kpl-ydm-tab" + (tab === "1" ? " on" : ""),
                        onClick: () => setTab("1"),
                    }, "沪深主板"),
                    React.createElement("div", {
                        className: "kpl-ydm-tab" + (tab === "2" ? " on" : ""),
                        onClick: () => setTab("2"),
                    }, "创业/科创板")),
                React.createElement(ErrorBox, { error }),
                React.createElement(LoadingBar, { show: !d && !error }),
                d && !rows.length ? React.createElement("div", { className: "kpl-mdd-empty" }, "该板块暂无多次异动个股") : null,
                groups.map((g) => React.createElement("div", { key: g.name, className: "kpl-ydm" },
                    React.createElement("div", { className: "sec-t" },
                        React.createElement("i", { className: "bar" }), g.name),
                    React.createElement("div", { className: "hd" },
                        React.createElement("span", { className: "c1" }, "名称"),
                        React.createElement("span", { className: "c2" }, "3日内偏离值"),
                        React.createElement("span", { className: "c3" }, estHead(g.name)),
                        React.createElement("span", { className: "c4" }, "当前价格")),
                    g.items.map((a) => React.createElement("div", { key: a.code + g.name, className: "row",
                        onClick: () => go({ page: "stock", stock: { code: a.code, name: a.name } }) },
                        React.createElement("div", { className: "c1" },
                            React.createElement("b", null, a.name),
                            React.createElement("span", { className: "cd" }, a.code,
                                a.day_n ? React.createElement("i", { className: "dn" }, "第" + a.day_n + "日") : null)),
                        React.createElement("div", { className: "c2" },
                            React.createElement("b", { className: Number(a.dev3) >= 0 ? "up" : "down" },
                                ydPct2(a.dev3))),
                        React.createElement("div", { className: "c3" },
                            React.createElement("b", { className: "up" }, a.est_price != null ? a.est_price : "--"),
                            React.createElement("span", { className: "up" }, ydPct2(a.est_pct))),
                        React.createElement("div", { className: "c4" },
                            React.createElement("b", null, a.price != null ? a.price : "--"),
                            React.createElement("span", { className: Number(a.day_pct) >= 0 ? "up" : "down" },
                                a.day_pct != null ? ydPct2(a.day_pct) : "")))))));
        }

        /* ---- 异动提醒页（AbnormalAlertActivity 1:1：概览头（指数卡+全市场量能+涨跌家数+大盘直播）
                + 日期导航/预警开关 + 三 tab 严重异动/热门股偏离值/重点监控；yd17/yd30/31/32 实拍） ---- */

        function KplYdAlertPage({ go, initTab }) {
            const [tab, setTab] = useState(initTab === "zdjk" ? "zdjk" : "severe");
            const [day, setDay] = useState(""); // ""=最新交易日；历史=YYYY-MM-DD
            const [warn, setWarn] = useState(() => localStorage.getItem("kpl_yd_warn") !== "0");
            const [trend, setTrend] = useState(null);
            const feed = useMarketFeed(30000);
            const zdstat = feedData(feed, "zdstat").data || {};
            const energy = feedData(feed, "energy").data || {};
            const [sev, setSev] = useState(null);
            const [hot, setHot] = useState(null);
            const [hisFilter, setHisFilter] = useState("all");
            const [zdjk, setZdjk] = useState(null);
            const [zdjkHis, setZdjkHis] = useState(null);
            const [error, setError] = useState(null);
            useEffect(() => {
                api("/api/kpl/mkttrend").then(setTrend).catch(() => { /* */ });
            }, []);
            useEffect(() => {
                if (tab !== "severe") return undefined;
                setSev(null);
                api("/api/kpl/yidong/severe" + (day ? `?day=${day}` : ""))
                    .then(setSev).catch((e) => setError(e.message));
                return undefined;
            }, [tab, day]);
            useEffect(() => {
                if (tab !== "hot") return undefined;
                setHot(null);
                api("/api/kpl/yidong/hot" + (day ? `?day=${day}` : ""))
                    .then(setHot).catch((e) => setError(e.message));
                return undefined;
            }, [tab, day]);
            useEffect(() => {
                if (tab !== "zdjk") return undefined;
                Promise.all([
                    api("/api/kpl/yidong/zdjk").then(setZdjk).catch(() => setZdjk([])),
                    day
                        ? api(`/api/kpl/yidong/zdjk?his=1&day=${day}`).then(setZdjkHis).catch(() => setZdjkHis([]))
                        : api("/api/kpl/yidong/zdjk?his=1").then(setZdjkHis).catch(() => setZdjkHis([])),
                ]).catch((e) => setError(e.message));
                return undefined;
            }, [tab, day]);
            const idxes = (trend && trend.indexes) || [];
            const cur = idxes[0] || null;
            // 导航展示日：未选历史时=数据实际日（sev.day 服务端返回），无数据再退日历今天
            const shownDay = day || (sev && sev.day) || (window.__kplTradeCal && window.__kplTradeCal.today) || "";
            // 近期严重异动三档筛选（App pill：全部/触发严重异动/被停牌；行内状态+停牌标本地过滤）
            const hisRows = ((sev && sev.his && sev.his.list) || []).filter((r) =>
                hisFilter === "all" ? true
                    : hisFilter === "trigger" ? r.status_today === "触发严重异动"
                        : !!r.suspended);
            const sevRow = (r) => React.createElement("div", { key: r.code + r.action_date,
                className: "kpl-yda-row" + (r.status_today === "触发严重异动" ? " trig" : ""),
                onClick: () => go({ page: "stock", stock: { code: r.code, name: r.name } }) },
                React.createElement("div", { className: "c nm" },
                    React.createElement("div", { className: "nm2" }, r.name),
                    React.createElement("div", { className: "cd" }, r.code,
                        r.concept ? React.createElement("i", { className: "otag" }, r.concept) : null)),
                React.createElement("div", { className: "c v" },
                    React.createElement("b", { className: "org" }, ydPct2(r.need)),
                    React.createElement("span", null, r.trigger_price != null ? r.trigger_price : "--")),
                React.createElement("div", { className: "c v" },
                    r.status_today === "触发严重异动"
                        ? React.createElement("b", { className: "red" }, "触发严重异动")
                        : React.createElement("b", null, ydPct2(r.space_today)),
                    React.createElement("span", { className: "rl" }, r.rule_short || "")),
                React.createElement("div", { className: "c v" },
                    React.createElement("b", null,
                        r.status_today === "触发严重异动" ? "--" : ydPct2(r.space_next)),
                    React.createElement("span", { className: "rl" }, "\u00A0")));
            const tabBtn = (id, label) => React.createElement("div", {
                className: "kpl-yda-tab" + (tab === id ? " on" : ""),
                onClick: () => setTab(id),
            }, label);
            return React.createElement("div", { className: "kpl-page kpl-yda" },
                React.createElement(KplPageHeader, {
                    title: "异动提醒",
                    onBack: () => go({ page: "back" }),
                    extra: React.createElement("span", { className: "kpl-yda-q",
                        title: "涨幅偏离值累计达到阈值触发交易所严重异动；本页数据与开盘啦 App 同源" }, "?"),
                }),
                // 日期导航 + 预警开关（App：◀ 日期 📅 ▶ | 预警 ⓘ 开关；预警=分时/K线严重异动预警线，插件本地记忆）
                React.createElement("div", { className: "kpl-yda-datenav" },
                    React.createElement("div", { className: "idx" },
                        cur ? React.createElement(React.Fragment, null,
                            React.createElement("b", { className: cur.points && cur.points.length && cur.points[cur.points.length - 1].v >= cur.preClose ? "up" : "down" },
                                cur.points && cur.points.length ? cur.points[cur.points.length - 1].v.toFixed(2) : "--"),
                            React.createElement("span", null, shownDay)) : null),
                    React.createElement("div", { className: "nav" },
                        React.createElement("i", { className: "ar", onClick: () => setDay(ydStepDay(shownDay, -1)) }, "◀"),
                        React.createElement("span", { className: "dt" }, shownDay || "--"),
                        React.createElement("i", {
                            className: "ar" + (day ? "" : " dis"),
                            onClick: () => { if (day) setDay(""); },
                        }, "▶")),
                    React.createElement("div", { className: "warn" },
                        React.createElement("span", null, "预警"),
                        React.createElement("i", {
                            className: "tg" + (warn ? " on" : ""),
                            onClick: () => { setWarn(!warn); localStorage.setItem("kpl_yd_warn", warn ? "0" : "1"); },
                        })),
                ),
                // 三 tab
                React.createElement("div", { className: "kpl-yda-tabs" },
                    tabBtn("severe", "严重异动"),
                    tabBtn("hot", "热门股偏离值"),
                    tabBtn("zdjk", "重点监控")),
                React.createElement(ErrorBox, { error }),
                // ===== 严重异动 tab（W46：明日/今日两节 + 近期严重异动） =====
                tab === "severe" && React.createElement("div", null,
                    React.createElement(LoadingBar, { show: !sev }),
                    sev && React.createElement("div", { className: "kpl-yda-sec" },
                        React.createElement("div", { className: "sec-t blue" },
                            React.createElement("i", { className: "bar" }),
                            "明日涨幅至涨停，能触发严重异动的个股"),
                        React.createElement("div", { className: "hd" },
                            React.createElement("span", { className: "c1" }, "股票名称"),
                            React.createElement("span", { className: "c2" }, "次日涨幅"),
                            React.createElement("span", { className: "c3" }, "触发异动涨幅股票价格"),
                            React.createElement("span", { className: "c4" }, "次日触发异动偏离值空间")),
                        (sev.tomorrow || []).map(sevRow)),
                    sev && React.createElement("div", { className: "kpl-yda-sec" },
                        React.createElement("div", { className: "sec-t blue" },
                            React.createElement("i", { className: "bar" }),
                            "今日涨幅至涨停，能触发严重异动的个股"),
                        React.createElement("div", { className: "hd" },
                            React.createElement("span", { className: "c1" }, "股票名称"),
                            React.createElement("span", { className: "c2" }, "触发异动涨幅股票价格"),
                            React.createElement("span", { className: "c3" }, "当日触发异动偏离值空间"),
                            React.createElement("span", { className: "c4" }, "次日触发异动偏离值空间")),
                        (sev.today || []).map(sevRow)),
                    sev && React.createElement("div", { className: "kpl-yda-sec" },
                        React.createElement("div", { className: "sec-t blue" },
                            React.createElement("i", { className: "bar" }), "近期严重异动"),
                        React.createElement("div", { className: "kpl-yda-pills" },
                            [["all", "全部"], ["trigger", "触发严重异动"], ["susp", "被停牌"]].map(([k, label]) =>
                                React.createElement("span", {
                                    key: k, className: "pill" + (hisFilter === k ? " on" : ""),
                                    onClick: () => setHisFilter(k),
                                }, label))),
                        React.createElement("div", { className: "hd" },
                            React.createElement("span", { className: "c1" }, "股票名称"),
                            React.createElement("span", { className: "c2" }, "异动日期"),
                            React.createElement("span", { className: "c3" }, "异动状态"),
                            React.createElement("span", { className: "c4" }, "次日涨幅")),
                        hisRows.map((r) => React.createElement("div", { key: r.code + r.action_date, className: "kpl-yda-row",
                            onClick: () => go({ page: "stock", stock: { code: r.code, name: r.name } }) },
                            React.createElement("div", { className: "c nm" },
                                React.createElement("div", { className: "nm2" }, r.name),
                                React.createElement("div", { className: "cd" }, r.code,
                                    r.concept ? React.createElement("i", { className: "otag" }, r.concept) : null)),
                            React.createElement("div", { className: "c v dt" },
                                React.createElement("b", null, (r.action_date || "").replace(/^\d{2}/, ""))),
                            React.createElement("div", { className: "c v" },
                                r.status_today === "触发严重异动"
                                    ? React.createElement("b", { className: "red" }, "触发严重异动")
                                    : React.createElement("b", null, r.status_today || "--"),
                                React.createElement("span", { className: "rl" }, r.rule_short || "")),
                            React.createElement("div", { className: "c v" },
                                React.createElement("b", { className: Number(r.next_day_pct) >= 0 ? "up" : "down" },
                                    ydPct2(r.next_day_pct)),
                                React.createElement("span", null, "\u00A0")))))),
                // ===== 热门股偏离值 tab（GetPianLiZhi_Hot，涨幅偏离值降序） =====
                tab === "hot" && React.createElement("div", null,
                    React.createElement(LoadingBar, { show: !hot }),
                    hot && React.createElement("div", { className: "kpl-yda-sec" },
                        React.createElement("div", { className: "hd" },
                            React.createElement("span", { className: "c1" }, "股票名称"),
                            React.createElement("span", { className: "c2" }, "涨幅"),
                            React.createElement("span", { className: "c3" }, "涨幅偏离值"),
                            React.createElement("span", { className: "c4" }, "当日触发异动偏离值空间")),
                        (hot.list || []).map((r) => React.createElement("div", { key: r.code, className: "kpl-yda-row",
                            onClick: () => go({ page: "stock", stock: { code: r.code, name: r.name } }) },
                            React.createElement("div", { className: "c nm" },
                                React.createElement("div", { className: "nm2" }, r.name),
                                React.createElement("div", { className: "cd" }, r.code,
                                    r.concept ? React.createElement("i", { className: "otag" }, r.concept) : null)),
                            React.createElement("div", { className: "c v" },
                                React.createElement("b", { className: Number(r.pct) >= 0 ? "up" : "down" }, ydPct2(r.pct)),
                                React.createElement("span", { className: "blue" }, r.zt_text || "\u00A0")),
                            React.createElement("div", { className: "c v" },
                                React.createElement("b", { className: "up" }, ydPct2(r.dev)),
                                React.createElement("span", { className: "rl" }, r.days || "")),
                            React.createElement("div", { className: "c v" },
                                React.createElement("b", null, ydPct2(r.space)),
                                React.createElement("span", { className: "rl" }, r.tag || "\u00A0")))))),
                // ===== 重点监控 tab（监管期证券/历史监管期证券，yd17 实拍） =====
                tab === "zdjk" && React.createElement("div", null,
                    React.createElement(LoadingBar, { show: zdjk === null || zdjkHis === null }),
                    [["监管期证券", zdjk], ["历史监管期证券", zdjkHis]].map(([label, rows]) =>
                        React.createElement("div", { key: label, className: "kpl-yda-sec" },
                            React.createElement("div", { className: "sec-t blue" },
                                React.createElement("i", { className: "bar" }), label),
                            React.createElement("div", { className: "hd" },
                                React.createElement("span", { className: "c1" }, "股票名称"),
                                React.createElement("span", { className: "c2 dt2" }, "监控开始日期(9:00)"),
                                React.createElement("span", { className: "c3 dt2" }, "监控结束日期(15:00)")),
                            (rows || []).map((r) => React.createElement("div", { key: r.code, className: "kpl-yda-row",
                                onClick: () => go({ page: "stock", stock: { code: r.code, name: r.name } }) },
                                React.createElement("div", { className: "c nm" },
                                    React.createElement("div", { className: "nm2" }, r.name),
                                    React.createElement("div", { className: "cd" }, r.code)),
                                React.createElement("div", { className: "c v dt" },
                                    React.createElement("b", null, r.start)),
                                React.createElement("div", { className: "c v dt" },
                                    React.createElement("b", null, r.end))))))),
                // ===== 概览尾块：指数分时卡 + 全市场量能 + 涨跌家数 + 大盘直播（App 概览头 1:1，插件置底避免挤压列表） =====
                React.createElement("div", { className: "kpl-yda-ov" },
                    energy && energy.text ? React.createElement("div", { className: "kpl-yda-energy" },
                        React.createElement("span", { className: "lb" }, "全市场量能"),
                        React.createElement("b", { className: "org" }, energy.text)) : null,
                    zdstat && (zdstat.rise != null) ? React.createElement("div", { className: "kpl-yda-zd" },
                        [["上涨家数", zdstat.rise, "up"], ["涨停家数", zdstat.zt, "up"],
                            ["下跌家数", zdstat.down, "down"], ["跌停家数", zdstat.dt, "down"]].map(([lb, v, cls]) =>
                            React.createElement("div", { key: lb, className: "cell" },
                                React.createElement("span", null, lb),
                                React.createElement("b", { className: cls }, v != null ? v : "--")))) : null));
        }

        /* ---- 板块详情（下钻 1:1） ---- */  function KplSectorDetail({ plate, list, go }) {
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

        // 涨停大单深度块（cmd 2014：连板状态+大单封单序列；非涨停静默不显示）
        function KplZtBigOrderSec({ code }) {
            const [d, setD] = useState(null);
            useEffect(() => {
                api("/api/kpl/ztbig/" + code).then(setD).catch(() => { });
            }, [code]);
            const series = (d && d.series) || [];
            if (!d || !d.lbText || !series.length) return null;
            const last = series[series.length - 1];
            return React.createElement("div", { className: "kpl-mkt-sec" },
                React.createElement("div", { className: "kpl-mkt-sec-t" }, "涨停深度",
                    React.createElement("span", { className: "kpl-mkt-tips" }, d.lbText)),
                React.createElement("div", { className: "kpl-mkt-duo" },
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "最新封单"),
                        React.createElement("div", { className: "val up" }, fmtAmount(last.seal))),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "大单笔数"),
                        React.createElement("div", { className: "val" }, d.bigN != null ? d.bigN : "--"))),
                React.createElement(KplTrendCanvas, {
                    points: series.map(x => ({ v: Number(x.seal) || 0 })),
                    preClose: null, height: 70 }));
        }

        // 分时成交列表（GetStockFenBi2）
        function KplFenBiSec({ code }) {
            const [d, setD] = useState(null);
            const [open, setOpen] = useState(false);
            useEffect(() => {
                api("/api/kpl/fenbi/" + code).then(setD).catch(() => { });
            }, [code]);
            const rows = (d && d.rows) || [];
            if (!rows.length) return null;
            return React.createElement("div", { className: "kpl-mkt-sec" },
                React.createElement("div", { className: "kpl-mkt-sec-t" }, "分时成交",
                    React.createElement("span", { className: "kpl-mkt-tips kpl-dswitch", onClick: () => setOpen(!open) },
                        open ? "收起 ▲" : "展开 ▼")),
                React.createElement("div", { className: "kpl-mkt-ztlist" },
                    rows.slice(0, open ? 60 : 8).map((r, i) =>
                        React.createElement("div", { key: i, className: "row" },
                            React.createElement("div", { className: "nm" },
                                React.createElement("b", null, r.time)),
                            React.createElement("div", { className: "pct " + (r.dir === 1 ? "up" : "down") },
                                Number(r.px).toFixed(2)),
                            React.createElement("div", { className: "price" }, r.vol + " 手"),
                            React.createElement("div", { className: "why" }, r.n + " 笔")))));
        }

        // F10 完整版（公司资料+财务表+主要指标图表）
        function KplF10Sec({ code, exTick }) {
            // App F10 tab 1:1（2026-10-03 实拍 f10_4~f10_13）：六宫格 chips + 各子页。
            // 数据=StockF10Basic/GetIndex 全家桶（Concept/Topic/Company/Finance/Record/YJPL）+extras 大事提醒。
            const [sub, setSub] = useState("操控必读");
            const [expanded, setExpanded] = useState({});
            const ex0 = window.__kplSdEx && window.__kplSdEx[code];
            void exTick;   // extras 到达时父组件重渲染传入新值，触发本组件重渲染读取 window 缓存
            const f10 = ex0 && ex0.f10index;
            const pill = (name) => React.createElement("span", {
                key: name, className: sub === name ? "on" : "", onClick: () => setSub(name),
            }, name);
            const pills = React.createElement("div", { className: "kpl-f10-pills" },
                pill("操控必读"), pill("大事提醒"), pill("概念题材"),
                pill("公司资料"), pill("股本股东"), pill("财务分析"));
            if (!f10) return React.createElement("div", { className: "kpl-f10" },
                pills, React.createElement("div", { className: "kpl-mdd-empty" }, "加载中…"));
            const concepts = f10.Concept || [];
            const topics = f10.Topic || [];
            const comp = f10.Company || {};
            const fin = f10.Finance || {};
            const rec = f10.Record || null;
            const yjpl = f10.YJPL || {};
            const trim = (t, k) => {
                const s = String(t || "");
                if (expanded[k] || s.length <= 90) return s;
                return s.slice(0, 90) + "…";
            };
            const expLink = (k, s) => String(s || "").length > 90 ? React.createElement("a", {
                className: "exp", onClick: () => setExpanded(Object.assign({}, expanded, { [k]: !expanded[k] })),
            }, expanded[k] ? " 收起 ▲" : " 展开 ▼") : null;
            let body = null;
            if (sub === "操控必读") {
                // 操控必读=概念+要点+业绩预告 摘要卡（App 同源内容，红选默认）
                body = React.createElement("div", null,
                    concepts.slice(0, 3).map((c2, i) => React.createElement("div", { key: "c" + i, className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, c2.CName || ""),
                        React.createElement("div", { className: "tx" },
                            trim(c2.Analysis, "c" + i),
                            expLink("c" + i, c2.Analysis)))),
                    rec ? React.createElement("div", { className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, "业绩预告 ",
                            React.createElement("em", { className: "tagi" }, rec.Type || "")),
                        React.createElement("div", { className: "tx" }, rec.Descn || ""),
                        React.createElement("div", { className: "ns" }, "发布于 " + (rec.Date || ""))) : null,
                    yjpl && yjpl.Mess ? React.createElement("div", { className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, "业绩点评"),
                        React.createElement("div", { className: "tx", dangerouslySetInnerHTML: { __html: yjpl.Mess.Conts || "" } })) : null);
            } else if (sub === "大事提醒") {
                const rem = (ex0 && ex0.reminder) || [];
                body = rem.length ? React.createElement("div", { className: "kpl-f10-rem" },
                    rem.map((r, i) => React.createElement("div", { key: i, className: "rw" },
                        React.createElement("div", { className: "dt" },
                            React.createElement("b", null, r.Date ? String(r.Date).slice(5) : ""),
                            React.createElement("i", null, r.Date ? String(r.Date).slice(0, 4) : "")),
                        React.createElement("div", { className: "ct" },
                            React.createElement("div", { className: "tt" }, r.title || (r.type === 2 ? "龙虎榜" : "发布公告")),
                            r.content ? React.createElement("div", { className: "tx" }, r.content) : null,
                            r.Buy != null ? React.createElement("div", { className: "tx" },
                                "上榜净额：", React.createElement("b", { className: "up" },
                                    formatYi((Number(r.Buy) || 0) - (Number(r.Sell) || 0) / 1e8 >= 0 ? (Number(r.Buy) - Number(r.Sell)) : (Number(r.Buy) - Number(r.Sell))))) : null))))
                    : React.createElement("div", { className: "kpl-mdd-empty" }, "暂无大事提醒");
            } else if (sub === "概念题材") {
                body = React.createElement("div", null,
                    concepts.map((c2, i) => React.createElement("div", { key: i, className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, c2.CName || ""),
                        React.createElement("div", { className: "tx" },
                            trim(c2.Analysis, "cc" + i),
                            expLink("cc" + i, c2.Analysis)))),
                    topics.map((t, i) => React.createElement("div", { key: "t" + i, className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, t.CName || ""),
                        React.createElement("div", { className: "tx" },
                            trim(t.Analysis, "tt" + i),
                            expLink("tt" + i, t.Analysis)))));
            } else if (sub === "公司资料") {
                const zl = comp.ZL || [];
                const cp = comp.CP || [];
                body = React.createElement("div", { className: "kpl-f10-co" },
                    React.createElement("div", { className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, "详细资料"),
                        [["办公地址", zl[0]], ["所属行业", zl[1]], ["主营业务", zl[2]]].map((p, i) =>
                            React.createElement("div", { key: i, className: "row" },
                                React.createElement("span", { className: "k" }, p[0]),
                                React.createElement("span", { className: "v" }, p[1] || "--")))),
                    cp.length ? React.createElement("div", { className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, "主营构成"),
                        React.createElement("div", { className: "hd" },
                            React.createElement("span", null, "构成"), React.createElement("span", null, "收入"),
                            React.createElement("span", null, "占比")),
                        cp.map((r, i) => React.createElement("div", { key: i, className: "row3" },
                            React.createElement("span", null, r.Constitute || "--"),
                            React.createElement("span", null, r.InCome || "--"),
                            React.createElement("span", { className: "up" }, r.Rate || "--")))) : null);
            } else if (sub === "股本股东") {
                // 股东人数序列（App 柱线图同源数据未单独下发——由 Finance 侧无，留时间线；实际通道⏸10-08）
                body = React.createElement("div", { className: "kpl-f10-sec" },
                    React.createElement("div", { className: "st" }, "股本股东"),
                    React.createElement("div", { className: "kpl-mkt-tips", style: { padding: "6px 0" } },
                        "股东人数序列通道待接入（10-08 盘中抓包），分红方案见下"),
                    React.createElement("div", { className: "hd" },
                        React.createElement("span", null, "方案"), React.createElement("span", null, "进度"),
                        React.createElement("span", null, "报告期")));
            } else {
                // 财务分析：GJZB 主要指标 序列（App 柱线图同源：营收/净利/同比）
                const keys = Object.keys(fin);
                body = React.createElement("div", { className: "kpl-f10-fin" },
                    React.createElement("div", { className: "st" }, "主要指标"),
                    React.createElement("div", { className: "chips" },
                        keys.map((k2) => React.createElement("span", { key: k2 }, k2))),
                    keys.map((k2) => React.createElement("div", { key: k2, className: "kpl-f10-sec" },
                        React.createElement("div", { className: "st" }, k2),
                        (fin[k2] || []).slice(0, 6).map((r, i) => React.createElement("div", { key: i, className: "row3" },
                            React.createElement("span", null, "第" + (i + 1) + "期"),
                            React.createElement("span", null, r[0] || "--"),
                            React.createElement("span", { className: Number(String(r[2]).replace("%", "")) >= 0 ? "up" : "down" }, r[2] || "--"))))));
            }
            return React.createElement("div", { className: "kpl-f10" }, pills, body);
        }



        // 个股分时区块（GetStockTrend：现价线+均价线+昨收基准）
        function KplStockTrendSec({ code }) {
            const [t, setT] = useState(null);
            const load = useCallback(async () => {
                try { setT(await api("/api/kpl/trend/" + code)); } catch (e) { /* */ }
            }, [code]);
            useEffect(() => { load(); }, [load]);
            usePolling(load, 30000, [code]);
            const trend = (t && t.trend) || [];
            if (!trend.length) return null;
            const pre = Number(t.preClose) || 0;
            const pts = trend.map(r => ({ v: Number(r[1]) || 0 }));
            const avgPts = trend.map(r => ({ v: Number(r[2]) || 0 }));
            const last = pts[pts.length - 1].v;
            const pct = pre ? (last - pre) / pre * 100 : 0;
            const up = last >= pre;
            return React.createElement("div", { className: "kpl-mkt-sec" },
                React.createElement("div", { className: "kpl-mkt-idxhead" },
                    React.createElement("b", { className: up ? "up" : "down" }, last.toFixed(2)),
                    React.createElement("span", { className: up ? "up" : "down" },
                        (up ? "+" : "") + (last - pre).toFixed(2) + "  " + (up ? "+" : "") + pct.toFixed(2) + "%"),
                    React.createElement("span", { className: "kpl-mkt-tips" },
                        "均价 " + avgPts[avgPts.length - 1].v.toFixed(2) + " · 最高 " + t.high + " / 最低 " + t.low)),
                React.createElement(KplTrendCanvas, { points: pts, preClose: pre || null, height: 130 }),
                React.createElement("div", { className: "kpl-mkt-tips" }, "— 现价　┈ 昨收 " + (pre ? pre.toFixed(2) : "--")));
        }

        function KplStockDetail({ stock, go }) {
            // App StockQuotationActivity 1:1（2026-10-03 实拍 sd3~sd13）：报价头+左右横移两页
            //（页1 分时+五档/分布/委托+分时成交；页2 K线周期）+六大 tab（盘口/盯盘/F10/涨停原因/新闻）+底部工具栏。
            const [q, setQ] = useState(null);
            const [error, setError] = useState(null);
            const [inWatch, setInWatch] = useState(null);
            const [pageNo, setPageNo] = useState(1);        // 横移页 1|2
            const [sideTab, setSideTab] = useState("五档"); // 五档|分布|委托
            const [bigTab, setBigTab] = useState("盘口");   // 盘口|盯盘|F10|涨停原因|新闻
            const [news, setNews] = useState(null);
            const [idxPx, setIdxPx] = useState(null);       // 底栏上证指数
            const touchX = useRef(null);
            const klineRef = useRef(null);
            const chartRef = useRef(null);
            const [kErr, setKErr] = useState(null);

            useEffect(() => {
                let alive = true;
                api("/api/kpl/watchlist").then((d) => {
                    if (!alive) return;
                    const all = Object.values(d.stocks || {}).reduce((a, l) => a.concat(l || []), []);
                    setInWatch(all.some((c) => String(c) === String(stock.code)));
                }).catch(() => { });
                return () => { alive = false; };
            }, [stock.code]);
            const load = useCallback(async () => {
                try { const d = await api(`/api/kpl/quote/${stock.code}`); setError(null); setQ(d); }
                catch (e) { setError(e.message); }
            }, [stock.code]);
            usePolling(load, 10000, [stock.code]);
            // 大 tab 数据（涨停原因历史/新闻/公告/研报/F10 三件套，HIS 域 HTTP 已实锤）
            const [ex, setEx] = useState(null);
            useEffect(() => {
                let alive = true;
                api("/api/kpl/stockdetail/extras/" + stock.code).then((x) => {
                    if (!alive) return;
                    setEx(x);
                    window.__kplSdEx = window.__kplSdEx || {};
                    window.__kplSdEx[stock.code] = x;
                }).catch(() => { });
                return () => { alive = false; };
            }, [stock.code]);
            useEffect(() => {
                let alive = true;
                api("/api/kpl/home").then((h) => {
                    if (!alive) return;
                    const fl = (h && h.flash) || [];
                    setNews(fl.filter((f) => (f.stocks || []).some((s) => String(s.code) === String(stock.code))));
                }).catch(() => { });
                return () => { alive = false; };
            }, [stock.code]);
            // 底栏上证指数（mkttrend SH 最新价）
            useEffect(() => {
                api("/api/kpl/mkttrend").then((t) => {
                    const sh = ((t && t.indexes) || []).find((x) => x.num === "SH");
                    if (sh && sh.points && sh.points.length) setIdxPx(sh.points[sh.points.length - 1].v);
                }).catch(() => { });
            }, []);
            // K线（页2，KPL 源 Stock/GetStockChart 日K 530 根）
            useEffect(() => {
                if (pageNo !== 2) return undefined;
                let cancelled = false;
                (async () => {
                    try {
                        setKErr(null);
                        const kc = await loadKlineChart();
                        const k = await api("/api/kpl/kline/" + stock.code);
                        if (cancelled) return;
                        const candles = (k.dates || []).map((dt, i) => ({
                            timestamp: new Date(dt.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")).getTime(),
                            open: k.close[i][0], close: k.close[i][1],
                            high: k.close[i][2], low: k.close[i][3], volume: k.vol[i],
                        }));
                        if (!chartRef.current && klineRef.current) {
                            chartRef.current = kc.init(klineRef.current);
                            chartRef.current.createIndicator("MA", false, { id: "candle_pane" });
                            chartRef.current.createIndicator("VOL");
                        }
                        if (chartRef.current) chartRef.current.applyNewData(candles);
                    } catch (e) { if (!cancelled) setKErr(e.message); }
                })();
                return () => { cancelled = true; };
            }, [pageNo, stock.code]);
            useEffect(() => () => {
                if (chartRef.current && klineRef.current) {
                    chartRef.current.dispose(); chartRef.current = null;
                }
            }, []);
            const toggleWatch = async () => {
                try {
                    if (inWatch) await post("/api/kpl/watchlist/del", { code: stock.code });
                    else await post("/api/kpl/watchlist/add", { code: stock.code });
                    setInWatch(!inWatch);
                } catch (e) { setError(e.message); }
            };
            const up = q && q.change >= 0;
            const lst = stock.list || null;
            const idx = stock.idx != null ? stock.idx : (lst ? lst.findIndex((x) => String(x.code) === String(stock.code)) : -1);
            const jump = (d) => {
                if (!lst || lst[idx + d] == null) return;
                const nx = lst[idx + d];
                go({ page: "stock", stock: { code: nx.code, name: nx.name, list: lst, idx: idx + d } });
            };
            const kids = [];
            // 红头：◀ 开盘 股票名 ▶ 搜索（App 同款，◀▶=同列表切股）
            kids.push(React.createElement("div", { key: "hd", className: "kpl-sd-head" },
                React.createElement("span", { className: "bk", onClick: () => go({ page: "back" }) }, "‹"),
                lst && idx > 0 ? React.createElement("span", { className: "nav", onClick: () => jump(-1) }, "◀") : React.createElement("span", { className: "nav dis" }, "◀"),
                React.createElement("div", { className: "tt" },
                    React.createElement("b", null, (q && q.name) || stock.name || stock.code),
                    React.createElement("div", { className: "tags" },
                        React.createElement("span", { className: "tag r" }, "融"),
                        q && q.group_tag ? React.createElement("span", { className: "tag o" }, String(q.group_tag).split("、")[0]) : null,
                        React.createElement("span", { className: "cd" }, stock.code))),
                lst && idx < lst.length - 1 ? React.createElement("span", { className: "nav", onClick: () => jump(1) }, "▶") : React.createElement("span", { className: "nav dis" }, "▶"),
                React.createElement("span", { className: "sch", onClick: () => go({ page: "search" }) }, "🔍")));
            const netIn = q ? (q.amount_in || 0) - (q.amount_out || 0) : 0;
            if (q) {
                // 报价头（App：左大价+右侧 3×4 字段）
                kids.push(React.createElement("div", { key: "q", className: "kpl-stock-quote" },
                    React.createElement("div", { className: "kpl-stock-price" },
                        React.createElement("div", { className: "big " + (up ? "up" : "down") }, formatNum(q.last)),
                        React.createElement("div", { className: "chg " + (up ? "up" : "down") },
                            `${q.change >= 0 ? "+" : ""}${formatNum(q.change)}  ${formatPct(q.change_pct)}`)),
                    React.createElement("div", { className: "kpl-stock-grid" },
                        [["高", formatNum(q.high)], ["换手", formatNum(q.turnover_ratio) + "%"], ["振幅", formatNum(q.amplitude) + "%"],
                         ["低", formatNum(q.low)], ["市值", formatYi((q.market_cap || 0) / 1e8)], ["金额", formatYi((q.amount || 0) / 1e8)],
                         ["开", formatNum(q.open)], ["流通", formatYi((q.float_cap || 0) / 1e8)], ["市盈TTM", formatNum(q.pe_ttm)],
                         ["量", formatNum(q.vol_ratio)], ["总手", formatNum((q.amount || 0) / 100)], ["委比", formatNum(q.entrust_rate) + "%"]]
                            .map(([k2, v], i) => React.createElement("div", { key: i, className: "kpl-sg-item" },
                                React.createElement("span", { className: "k" }, k2),
                                React.createElement("span", { className: "v" }, v))))));
                // 主力净/买/卖 行
                kids.push(React.createElement("div", { key: "zl", className: "kpl-sd-mainrow" },
                    React.createElement("span", null, "主力净：", React.createElement("b", { className: cls(netIn) }, formatYi(netIn / 1e8))),
                    React.createElement("span", null, "主力买：", React.createElement("b", { className: "up" }, formatYi((q.amount_in || 0) / 1e8))),
                    React.createElement("span", null, "主力卖：", React.createElement("b", { className: "down" }, formatYi((q.amount_out || 0) / 1e8)))));
                if (q.zt_reason) {
                    kids.push(React.createElement("div", { key: "zx", className: "kpl-sd-flash" },
                        React.createElement("b", { className: "lab" }, "消息速递"),
                        React.createElement("div", { className: "txt" },
                            React.createElement("em", null, "涨停原因 "),
                            q.zt_reason)));
                }
            }
            // 横移两页（触摸滑动+指示条）
            const page1Kids = [];
            page1Kids.push(React.createElement("div", { key: "p1wrap", className: "kpl-sd-p1" },
                React.createElement("div", { className: "lft" },
                    React.createElement(KplStockTrendSec, { code: stock.code })),
                React.createElement("div", { className: "rgt" },
                    React.createElement("div", { className: "kpl-sd-sidetabs" },
                        ["五档", "分布", "委托"].map((t) => React.createElement("span", {
                            key: t, className: sideTab === t ? "on" : "", onClick: () => setSideTab(t),
                        }, t))),
                    sideTab === "五档" && React.createElement(KplLadder, { asks: q ? q.asks : [], bids: q ? q.bids : [], totalAsk: q && q.total_ask, totalBid: q && q.total_bid }),
                    sideTab !== "五档" && React.createElement("div", { className: "kpl-mdd-empty" },
                        sideTab === "分布" ? "筹码分布数据通道待接入（socket，10-08 盘中样本）" : "逐笔委托走分时成交近似，见下方明细")),
                React.createElement("div", { className: "fenbi" },
                    React.createElement(KplFenBiSec, { code: stock.code }))));
            const page2Kids = [];
            page2Kids.push(React.createElement("div", { key: "p2", className: "kpl-sd-p2" },
                React.createElement("div", { className: "periods" },
                    ["日", "周", "月", "年", "60分", "30分", "15分", "5分"].map((t, i) => React.createElement("span", {
                        key: t, className: i === 0 ? "on" : "",
                        title: i === 0 ? "" : "该周期通道待接入（socket 2400/2402）",
                    }, t))),
                kErr ? React.createElement("div", { className: "kpl-mdd-empty" }, "K线加载失败：" + kErr)
                    : React.createElement("div", { ref: klineRef, className: "kpl-sd-kline" })));
            const onTouchStart = (e) => { touchX.current = e.touches && e.touches[0] ? e.touches[0].clientX : null; };
            const onTouchEnd = (e) => {
                if (touchX.current == null) return;
                const x = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : null;
                if (x == null) return;
                const dx = x - touchX.current;
                if (dx < -60 && pageNo === 1) setPageNo(2);
                if (dx > 60 && pageNo === 2) setPageNo(1);
                touchX.current = null;
            };
            kids.push(React.createElement("div", {
                key: "vp", className: "kpl-sd-vp", onTouchStart: onTouchStart, onTouchEnd: onTouchEnd,
            },
                pageNo === 1 ? page1Kids : page2Kids,
                React.createElement("div", { className: "kpl-sd-dots" },
                    React.createElement("span", { className: pageNo === 1 ? "on" : "", onClick: () => setPageNo(1) }),
                    React.createElement("span", { className: pageNo === 2 ? "on" : "", onClick: () => setPageNo(2) }))));
            // 关联板块卡（group_tag 拆分）
            if (q && q.group_tag) {
                kids.push(React.createElement("div", { key: "bk", className: "kpl-sd-plates" },
                    String(q.group_tag).split("、").filter((x) => x).slice(0, 4).map((p, i) =>
                        React.createElement("div", { key: i, className: "pk" }, p))));
            }
            // 六大 tab
            const f10blk = React.createElement(KplF10Sec, { code: stock.code, exTick: ex ? 1 : 0 });
            const ztrs = ex && ex.ztrs;
            const newsRows = (ex && ex.news) || [];
            const noticeRows = (ex && ex.notices) || [];
            const researchRows = (ex && ex.research) || [];
            const reminderRows = (ex && ex.reminder) || [];
            const bigBody = {
                "盘口": q ? React.createElement("div", { className: "kpl-sd-pk3" },
                    [["开盘", formatNum(q.open)], ["最高", formatNum(q.high)], ["量比", formatNum(q.vol_ratio)],
                     ["均价", formatNum(q.avg)], ["最低", formatNum(q.low)], ["换手", formatNum(q.turnover_ratio) + "%"],
                     ["涨停", formatNum(q.up_limit)], ["总手", formatNum((q.amount || 0) / 100)], ["振幅", formatNum(q.amplitude) + "%"],
                     ["跌停", formatNum(q.down_limit)], ["金额", formatYi((q.amount || 0) / 1e8)], ["委比", formatNum(q.entrust_rate) + "%"],
                     ["内盘", formatYi((q.amount_out || 0) / 1e4) + "万"], ["市盈率", formatNum(q.pe)], ["总市值", formatYi((q.market_cap || 0) / 1e8)],
                     ["外盘", formatYi((q.amount_in || 0) / 1e4) + "万"], ["市净率", "--"], ["流通值", formatYi((q.float_cap || 0) / 1e8)],
                     ["流通股", formatYi((q.float_cap || 0) / 1e8)], ["市盈TTM", formatNum(q.pe_ttm)], ["实际流通", "--"]]
                        .map(([k2, v], i) => React.createElement("div", { key: i, className: "cell" },
                            React.createElement("span", { className: "k" }, k2), React.createElement("span", { className: "v" }, v))))
                    : null,
                "盯盘": q ? React.createElement("div", { className: "kpl-sd-dp" },
                    React.createElement("div", { className: "r1" },
                        React.createElement("span", null, "成交额：", formatYi((q.amount || 0) / 1e8)),
                        React.createElement("span", null, "实际换手率：", formatNum(q.turnover_ratio) + "%")),
                    React.createElement("div", { className: "hd" },
                        React.createElement("span", null, "交易方"), React.createElement("span", null, "成交占比"), React.createElement("span", null, "金额")),
                    React.createElement("div", { className: "row" },
                        React.createElement("span", null, "主力买入"),
                        React.createElement("span", { className: "up" },
                            (q.amount || 0) > 0 ? ((q.amount_in || 0) / q.amount * 100).toFixed(2) + "%" : "--"),
                        React.createElement("span", { className: "up" }, formatYi((q.amount_in || 0) / 1e8))),
                    React.createElement("div", { className: "row" },
                        React.createElement("span", null, "主力卖出"),
                        React.createElement("span", { className: "down" },
                            (q.amount || 0) > 0 ? (-((q.amount_out || 0) / q.amount * 100)).toFixed(2) + "%" : "--"),
                        React.createElement("span", { className: "down" }, formatYi((q.amount_out || 0) / 1e8))),
                    React.createElement("div", { className: "net" }, "主力净额：",
                        React.createElement("b", { className: cls(netIn) }, formatYi(netIn / 1e8))),
                    React.createElement("div", { className: "kpl-mkt-tips", style: { padding: "6px 0 0" } },
                        "主力监控逐笔明细为 App VIP 订阅功能（errcode 1018），插件如实标注")) : null,
                "F10": f10blk,
                "涨停原因": React.createElement("div", { className: "kpl-sd-ztrs" },
                    q && q.zt_reason ? React.createElement("div", { className: "card" },
                        React.createElement("em", { className: "lab" }, "当日"),
                        q.zt_reason) : null,
                    ztrs ? React.createElement("div", { className: "card" },
                        React.createElement("div", { className: "ztd" },
                            React.createElement("span", { className: "blue" }, ztrs.reason || ""),
                            React.createElement("i", { className: "tagi" }, "日内龙"),
                            React.createElement("span", { className: "dt" }, ex.day)),
                        ztrs.reason ? React.createElement("div", { className: "quote" }, ztrs.reason) : null,
                        ztrs.bfreason ? React.createElement("div", { className: "bf" },
                            React.createElement("em", { className: "lab o" }, "概念解析"),
                            ztrs.bfreason) : null)
                        : React.createElement("div", { className: "kpl-mdd-empty" }, ex ? "该日无涨停原因记录" : "加载中…")),
                "新闻": newsRows.length ? React.createElement("div", { className: "kpl-sd-news" },
                    newsRows.slice(0, 20).map((r, i) => React.createElement("div", { key: i, className: "nw" },
                        React.createElement("div", { className: "nt" }, r[2] || ""),
                        React.createElement("div", { className: "ns" },
                            r[1] ? new Date(Number(r[1]) * 1000).toISOString().slice(5, 10) : "",
                            React.createElement("i", null, " " + (r[3] || "")))))) 
                    : React.createElement("div", { className: "kpl-mdd-empty" }, ex ? "暂无公司新闻" : "加载中…"),
                "公告": noticeRows.length ? React.createElement("div", { className: "kpl-sd-news" },
                    noticeRows.slice(0, 20).map((r, i) => React.createElement("a", {
                        key: i, className: "nw lnk", href: r[4] || r[3] || "#", target: "_blank", rel: "noreferrer",
                    },
                        React.createElement("div", { className: "nt" }, r[2] || ""),
                        React.createElement("div", { className: "ns" },
                            r[1] ? new Date(Number(r[1]) * 1000).toISOString().slice(0, 10) : "",
                            React.createElement("i", null, " PDF ▸"))))) 
                    : React.createElement("div", { className: "kpl-mdd-empty" }, ex ? "暂无公告" : "加载中…"),
                "研报": researchRows.length ? React.createElement("div", { className: "kpl-sd-news" },
                    researchRows.slice(0, 20).map((r, i) => React.createElement("div", { key: i, className: "nw" },
                        React.createElement("div", { className: "nt" }, r[2] || ""),
                        React.createElement("div", { className: "ns" },
                            r[1] ? new Date(Number(r[1]) * 1000).toISOString().slice(0, 10) : "",
                            React.createElement("i", null, " " + (r[3] || "券商研报")))))) 
                    : React.createElement("div", { className: "kpl-mdd-empty" }, ex ? "暂无研报" : "加载中…"),
            };
            kids.push(React.createElement("div", { key: "bt", className: "kpl-sd-bigtabs" },
                React.createElement("div", { className: "tabs" },
                    ["盘口", "盯盘", "F10", "涨停原因", "新闻", "公告", "研报"].map((t) => React.createElement("span", {
                        key: t, className: bigTab === t ? "on" : "", onClick: () => setBigTab(t),
                    }, t))),
                React.createElement("div", { className: "body" }, bigBody[bigTab] || null)));
            // 底部工具栏
            kids.push(React.createElement("div", { key: "bar", className: "kpl-sd-bar" },
                React.createElement("div", { className: "it" },
                    React.createElement("i", { className: "ico" }, "▲"),
                    React.createElement("span", null, "上证指数"),
                    idxPx != null ? React.createElement("b", { className: idxPx >= 0 ? "up" : "down" }, idxPx.toFixed(2)) : null),
                React.createElement("div", { className: "it" }, React.createElement("i", { className: "ico" }, "⏰"), React.createElement("span", null, "预警")),
                React.createElement("div", { className: "it", onClick: () => go({ page: "lhb_stock", stock: { code: stock.code, name: (q && q.name) || stock.name } }) },
                    React.createElement("i", { className: "ico" }, "👑"), React.createElement("span", null, "龙虎榜")),
                React.createElement("div", { className: "it", onClick: toggleWatch },
                    React.createElement("i", { className: "ico star" }, inWatch ? "✓" : "＋"),
                    React.createElement("span", { className: inWatch ? "star on" : "star" }, inWatch ? "移出自选" : "加自选"))));
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(LoadingBar, { show: !q && !error }),
                React.createElement(ErrorBox, { error }),
                kids);
        }



        /* ---- 搜索页（App 搜索 1:1：5 tab + 历史 + 热搜 + 联想 + 更多结果） ---- */

        function KplSearch({ go }) {
            const TABS = [
                ["c", "综合", "搜索个股/板块/题材库/功能"],
                ["lhb", "龙虎榜", "请输入股票简称/代码"],
                ["fund", "基金", "请输入基金名称/基金经理"],
                ["biz", "营业部", "请输入营业部名称"],
                ["zt", "涨停原因", "请输入涨停关键词/所属板块"],
            ];
            const [tab, setTab] = useState("c");
            const [q, setQ] = useState("");
            const [hot, setHot] = useState(null);
            const [sug, setSug] = useState(null);
            const [fundRes, setFundRes] = useState(null);
            const [combine, setCombine] = useState(null);
            const [showMore, setShowMore] = useState(false);
            const [hist, setHist] = useState(() => {
                try { return JSON.parse(localStorage.getItem("kpl_sp_hist") || "[]"); }
                catch { return []; }
            });
            const loadHot = useCallback(async () => {
                try { setHot(await api("/api/kpl/search/hot")); } catch { /* */ }
            }, []);
            useEffect(() => { loadHot(); }, []);
            useEffect(() => {
                setCombine(null); setShowMore(false);
                if (!q.trim()) { setSug(null); setFundRes(null); return; }
                const kw = q.trim();
                const t = setTimeout(async () => {
                    if (tab === "fund") {
                        try { setFundRes(await api(`/api/kpl/search/fund?kw=${encodeURIComponent(kw)}`)); }
                        catch { setFundRes([]); }
                        return;
                    }
                    try { setSug(await api(`/api/kpl/search/suggest?q=${encodeURIComponent(kw)}`)); }
                    catch { setSug([]); }
                }, 280);
                return () => clearTimeout(t);
            }, [q, tab]);
            const saveHist = (item) => {
                setHist((prev) => {
                    const next = [item, ...prev.filter((x) => !(x.code && x.code === item.code) && !(x.kw && x.kw === item.kw))].slice(0, 12);
                    try { localStorage.setItem("kpl_sp_hist", JSON.stringify(next)); } catch { /* */ }
                    return next;
                });
            };
            const openStock = (code, name) => {
                if (!code) return;
                saveHist({ code, name: name || "" });
                go({ page: "stock", stock: { code, name: name || code } });
            };
            const doSearch = () => {
                const kw = q.trim();
                if (kw) saveHist({ kw });
                if (tab === "fund") return;
                (async () => {
                    try { setCombine(await api(`/api/kpl/search/combine?kw=${encodeURIComponent(kw)}`)); setShowMore(true); }
                    catch { setCombine(null); }
                })();
            };
            const pctSpan = (pct) => React.createElement("span",
                { className: "pct " + (String(pct || "").indexOf("-") === 0 ? "down" : "up") },
                pct != null && pct !== "" ? pct + "%" : "--");
            const rankCls = (i) => i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : "rn";
            const stockRow = (s, i) => React.createElement("div", { key: s.code + i, className: "kpl-sp-row",
                    onClick: () => s.market === "A" ? openStock(s.code, s.name) : undefined,
                    style: s.market && s.market !== "A" ? { opacity: 0.75 } : undefined },
                React.createElement("span", { className: "rank " + rankCls(i) }, i + 1),
                React.createElement("div", { className: "mid" },
                    React.createElement("b", null, (s.name || "--") +
                        (s.market && s.market !== "A" ? React.createElement("span", { className: "mk" }, s.market) : null)),
                    React.createElement("span", { className: "cd" }, s.code)),
                s.reason ? React.createElement("span", { className: "reason" }, s.reason) : null,
                s.market === "A" ? pctSpan(s.pct) : null,
                s.market === "A" ? React.createElement("button", { className: "addbtn",
                    onClick: (e) => { e.stopPropagation(); post("/api/kpl/watchlist/add", { code: s.code }).catch(() => {}); } }, "＋") : null);

            const kids = [];
            if (!q.trim()) {
                if (tab === "c") {
                    if (hist.length) kids.push(React.createElement("div", { key: "hh", className: "kpl-sp-sechist" },
                        React.createElement("span", { className: "t" }, "搜索历史"),
                        React.createElement("span", { className: "clr", onClick: () => {
                            setHist([]); try { localStorage.removeItem("kpl_sp_hist"); } catch { /* */ }
                        } }, "🗑"),
                        React.createElement("div", { className: "chips" },
                            hist.map((h, i) => React.createElement("span", { key: i, className: "chip",
                                onClick: () => h.code ? openStock(h.code, h.name) : setQ(h.kw || "") },
                                h.code ? (h.name || h.code) : h.kw)))));
                    if (hot && hot.stocks && hot.stocks.length) {
                        kids.push(React.createElement("div", { key: "hs", className: "kpl-sp-sec" },
                            React.createElement("div", { className: "sec-t" },
                                React.createElement("span", { className: "fire" }, "🔥"),
                                "热搜股票")));
                        hot.stocks.forEach((s, i) => kids.push(stockRow(s, i)));
                    }
                } else if (tab === "lhb") {
                    const rows = (hot && hot.lhb_hot) || [];
                    if (rows.length) kids.push(React.createElement("div", { key: "lh", className: "kpl-sp-sec" },
                        React.createElement("div", { className: "sec-t" }, "热门搜索")));
                    kids.push(React.createElement("div", { key: "lg", className: "kpl-sp-grid" },
                        rows.map((s, i) => React.createElement("div", { key: s.code + i, className: "cell",
                            onClick: () => openStock(s.code, s.name) },
                            React.createElement("span", { className: "rank " + rankCls(i) }, i + 1),
                            React.createElement("div", { className: "mid" },
                                React.createElement("b", null, s.name || "--"),
                                React.createElement("span", { className: "cd" }, s.code))))));
                } else if (tab === "fund") {
                    const rows = (hot && hot.fund_hot) || [];
                    kids.push(React.createElement("div", { key: "fh", className: "kpl-sp-sec" },
                        React.createElement("div", { className: "sec-t" }, "热门搜索")));
                    rows.forEach((f, i) => kids.push(React.createElement("div", { key: i, className: "kpl-sp-fund",
                        onClick: () => setQ(f.name) }, f.name)));
                } else if (tab === "biz") {
                    const rows = (hot && hot.biz_hot) || [];
                    kids.push(React.createElement("div", { key: "bh", className: "kpl-sp-sec" },
                        React.createElement("div", { className: "sec-t" }, "热门搜索")));
                    rows.forEach((f, i) => kids.push(React.createElement("div", { key: i, className: "kpl-sp-biz" },
                        React.createElement("span", { className: "nm" }, f.name),
                        React.createElement("span", { className: "sub" }, "订阅"))));
                } else if (tab === "zt") {
                    const words = (hot && hot.zt_words) || [];
                    kids.push(React.createElement("div", { key: "zh", className: "kpl-sp-sec" },
                        React.createElement("div", { className: "sec-t" }, "热门搜索")));
                    kids.push(React.createElement("div", { key: "zg", className: "kpl-sp-grid" },
                        words.map((wd, i) => React.createElement("div", { key: i, className: "cell word",
                            onClick: () => setQ(wd) }, wd))));
                }
            } else if (tab === "fund") {
                (fundRes || []).forEach((f, i) => kids.push(React.createElement("div", { key: i, className: "kpl-sp-fund" },
                    React.createElement("span", { className: "nm" }, f.Name),
                    React.createElement("span", { className: "cd" }, f.ID))));
            } else {
                const rows = sug || [];
                rows.forEach((s, i) => kids.push(stockRow(s, i)));
                if (sug !== null && rows.length === 0 && !showMore) {
                    kids.push(React.createElement("div", { key: "none", className: "kpl-sp-none" }, "无匹配结果"));
                }
                if (tab === "c" && q.trim()) {
                    kids.push(React.createElement("div", { key: "more", className: "kpl-sp-more",
                        onClick: () => { if (!combine) doSearch(); else setShowMore(!showMore); } },
                        React.createElement("div", null,
                            React.createElement("div", { className: "t" }, "搜索：" + q.trim()),
                            React.createElement("div", { className: "d" }, "查看资讯、互动易、机构纪要等更多结果")),
                        React.createElement("span", { className: "arr" }, "›")));
                    if (showMore && combine) {
                        const groups = [["Article", "资讯"], ["Flash", "快讯"], ["Interact", "互动易"],
                            ["Theme", "题材"], ["Manage", "管理"]];
                        groups.forEach(([k, label]) => {
                            const list = combine[k] || [];
                            if (!list.length) return;
                            kids.push(React.createElement("div", { key: k, className: "kpl-sp-grp" },
                                React.createElement("div", { className: "grp-t" }, label),
                                list.map((it, i) => React.createElement("div", { key: i, className: "grp-it" },
                                    React.createElement("div", { className: "tt" },
                                        it.Title || it.AskMess || it.Name || it.KeyWord || "--"),
                                    React.createElement("div", { className: "dd" },
                                        it.Source || it.Account || it.UserName || "",
                                        it.CreateTime ? " " + new Date(it.CreateTime * 1000).toLocaleDateString() : "")))));
                        });
                    }
                }
            }

            const ph = (TABS.find((t) => t[0] === tab) || TABS[0])[2];
            return React.createElement("div", { className: "kpl-page kpl-sp" },
                React.createElement("div", { className: "kpl-sp-top" },
                    React.createElement("span", { className: "back", onClick: () => go({ page: "back" }) }, "‹"),
                    React.createElement("div", { className: "box" },
                        React.createElement("span", { className: "ico" }, "🔍"),
                        React.createElement("input", { value: q, placeholder: ph,
                            onChange: (e) => setQ(e.target.value),
                            onKeyDown: (e) => { if (e.key === "Enter") doSearch(); } })),
                    React.createElement("span", { className: "go", onClick: doSearch }, "搜索")),
                React.createElement("div", { className: "kpl-sp-tabs" },
                    TABS.map(([id, label]) => React.createElement("span", {
                        key: id, className: "t " + (tab === id ? "on" : ""),
                        onClick: () => { setTab(id); setSug(null); setFundRes(null); setShowMore(false); },
                    }, label))),
                kids);
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
                else if (drill.page === "article") content = React.createElement(KplArticleDetail, { aid: drill.aid, title: drill.title, go });
                else if (drill.page === "colPage") content = React.createElement(KplColumnPage, { cid: drill.cid, name: drill.name, go });
                else if (drill.page === "yidongMany") content = React.createElement(KPL_YD_MANY_G, { go });
                else if (drill.page === "zdjk") content = React.createElement(KPL_YD_ALERT_G, { go, initTab: "zdjk" });
                else if (drill.page === "ydAlert") content = React.createElement(KPL_YD_ALERT_G, { go });
                else if (drill.page === "artCenter") content = React.createElement(KplRecommendPage, { go });
                else if (drill.page === "stock") content = React.createElement(KPL_STOCK_DETAIL_G, { stock: drill.stock, go });
                else if (drill.page === "search") content = React.createElement(KplSearch, { go });
                else if (drill.page === "lhb") content = React.createElement(KplLhbPage, { go });
                else if (drill.page === "lhbBiz") content = React.createElement(KplLhbBizDetail, { id: drill.id, name: drill.name, go });
                else if (drill.page === "lhbStock") content = React.createElement(KplLhbStockDetail, { code: drill.code, day: drill.day, go });
                else if (drill.page === "themes") content = React.createElement(KplThemesPage, { go });
                else if (drill.page === "themeDetail") content = React.createElement(KplThemeDetailPage, { id: drill.id, go });
                else if (drill.page === "tika") content = React.createElement(KplTikaPage, { go });
                else if (drill.page === "tikaDetail") content = React.createElement(KplTikaDetailPage, { id: drill.id, name: drill.name, go });
                else if (drill.page === "sectorDetail") content = React.createElement(KplSectorDetailPage, { plateId: drill.plateId, name: drill.name, go });
                else if (drill.page === "fengkou") content = React.createElement(KplFengkouPage, { go });
                else if (drill.page === "market") content = React.createElement(KplMarketPage, { go, initialSub: drill.sub });
                else if (drill.page === "avoid") content = React.createElement(KplAvoidPage, { go });
                else if (drill.page === "sentiment") content = React.createElement(KplSentimentPage, { go });
                else if (drill.page === "poprank") content = React.createElement(KplPopRankPage, { go });
                else if (drill.page === "qiangdu") content = React.createElement(KplQiangduPage, { go });
                else if (drill.page === "mood_zte") content = React.createElement(KplZtePage, { go, day: drill.day });
                else if (drill.page === "mood_withdraw") content = React.createElement(KplWithdrawPage, { go, day: drill.day });
                else if (drill.page === "mood_weights") content = React.createElement(KplWeightsPage, { go, day: drill.day });
                else if (drill.page === "funcgrid") content = React.createElement(KplFuncGridPage, { go });
                else if (drill.page === "func_radar") content = React.createElement(KplRadarPage, { go });
                else if (drill.page === "func_north") content = React.createElement(KplNorthPage, { go });
                else if (drill.page === "func_grid_notice") content = React.createElement(KplNoticeCenterPage, { go });
                else if (drill.page === "func_pending") content = React.createElement("div", { className: "kpl-page" },
                    React.createElement(KplPageHeader, { title: drill.name || "功能页", onBack: () => go({ page: "back" }) }),
                    React.createElement("div", { className: "kpl-mdd-empty" },
                        (drill.name || "该功能") + " 页面骨架已就位，数据通道待 10-08 盘中抓包后点亮"));
                else if (drill.page === "daban") content = React.createElement(KplDabanPage, { go });
                else content = React.createElement(KplOverview, { go });
            } else if (activeNav === "home") {
                content = React.createElement(KplHomePage, { go, status, reloadStatus: loadStatus });
            } else if (activeNav === "market") {
                content = React.createElement(KplMarketPage, { go });
            } else if (activeNav === "search") {
                content = React.createElement(KplSearch, { go });
            } else if (activeNav === "watchlist") {
                content = React.createElement(KplWatchPage, { go });
            } else if (activeNav === "lhb") {
                content = React.createElement(KplLhbPage, { go });
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
        /* ---- 通达信 Tab：PC 客户端自选分组直读（T0002/blocknew = 云同步状态）+ 实盘持仓（二期 trade.dll 桥） ---- */

        function TdxTab({ openStock }) {
            const W_LS = "kpl_tdx_watch_v1", P_LS = "kpl_tdx_pos_v1";
            const lsJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } };
            const [data, setData] = useState(() => lsJson(W_LS));   // localStorage 秒显（SWR：旧数据立即显示，网络回来后覆盖）
            const [err, setErr] = useState(null);
            const [gid, setGid] = useState("");   // 交互 state 只存 id 字符串，派生对象 find 按值查
            const [pos, setPos] = useState(() => lsJson(P_LS));        // 实盘持仓（tdxw.exe 内存直读）
            const [posBusy, setPosBusy] = useState(false);
            const [aliasVal, setAliasVal] = useState("");
            const [aliasMsg, setAliasMsg] = useState("");
            const [regOnly, setRegOnly] = useState(() => { try { return localStorage.getItem("kpl_tdx_regonly") !== "0"; } catch { return true; } });
            const gidRef = useRef(gid); gidRef.current = gid;   // 闭包读最新 gid（切组立即按新组刷行情）

            const load = useCallback(async () => {
                try {
                    const qg = gidRef.current || "zxg";   // 只刷当前显示组（后端只对该组收集行情，其余组用缓存价）
                    const d = await api(`/api/tdx/watchlist?quotes=1&quotes_group=${encodeURIComponent(qg)}&t=${Date.now()}`);
                    setData(d);
                    setErr(null);
                    try { localStorage.setItem(W_LS, JSON.stringify(d)); } catch { }
                } catch (e) { setErr(e.message); }
            }, []);
            const loadPos = useCallback(async (refresh) => {
                setPosBusy(true);
                try {
                    const d = await api("/api/tdx/positions?t=" + Date.now() + (refresh ? "&refresh=1" : ""));
                    setPos(d);
                    try { localStorage.setItem(P_LS, JSON.stringify(d)); } catch { }
                } catch (e) { /* 保留旧数据，下轮轮询重试 */ }
                setPosBusy(false);
            }, []);
            usePolling(() => load(), 10000, []);
            usePolling(() => loadPos(false), 60000, []);
            useEffect(() => { load(); }, [gid]);   // 切组立即拉一次（行情+该组股票秒级到位，不等下轮轮询）

            const f2 = (v) => (v == null ? "--" : Number(v).toFixed(2));
            const fi = (v) => (v == null ? "--" : Math.round(Number(v)).toLocaleString("en-US"));
            const fSign = (v) => (v > 0 ? "+" : "") + Number(v).toFixed(2);
            const pctCls = (v) => (v == null || v === 0 ? "" : v < 0 ? "down" : "up");

            // ---- 实盘持仓区 ----
            const plist = (pos && pos.positions) || [];
            const sumMv = plist.reduce((a, p) => a + (p.mv || 0), 0);
            const sumPl = plist.reduce((a, p) => a + (p.pl || 0), 0);
            const sumCost = plist.reduce((a, p) => a + (p.cost || 0) * (p.qty || 0), 0);
            const sumPct = sumCost > 0 ? (sumPl / sumCost) * 100 : 0;

            let posBody;
            if (!pos) {
                posBody = React.createElement("div", { className: "kpl-tdx-empty" },
                    posBusy ? "⏳ 正在扫描通达信进程内存（首次约 5~15 秒）…" : "实盘持仓待加载…");
            } else if (!pos.ok) {
                posBody = React.createElement("div", { className: "kpl-tdx-empty" },
                    "⚠️ " + (pos.error === "tdxw not running"
                        ? "未检测到通达信客户端——请打开 PC 通达信并完成交易登录（委托登录），打开过一次「持仓」页后回来点「刷新」"
                        : "内存读取失败：" + (pos.error || "未知")),
                    React.createElement("div", { className: "kpl-tdx-note" },
                        "只读直读 tdxw.exe 进程内存中的持仓结构体，不写任何数据、不下单"));
            } else {
                posBody = React.createElement("div", { className: "kpl-tdx-rows" },
                    React.createElement("div", { className: "kpl-tdx-posrow h" },
                        React.createElement("span", { className: "nm" }, "名称"),
                        React.createElement("span", { className: "cd" }, "代码"),
                        React.createElement("span", { className: "v" }, "持仓"),
                        React.createElement("span", { className: "v" }, "可用"),
                        React.createElement("span", { className: "v" }, "成本"),
                        React.createElement("span", { className: "v" }, "现价"),
                        React.createElement("span", { className: "v" }, "市值"),
                        React.createElement("span", { className: "v" }, "盈亏"),
                        React.createElement("span", { className: "v" }, "盈亏%")),
                    plist.map((p) => React.createElement("div", {
                        key: p.code_digits,
                        className: "kpl-tdx-posrow",
                        onClick: () => openStock && openStock({ code: p.code_digits, name: p.name || p.code_digits }),
                    },
                        React.createElement("span", { className: "nm" }, p.name || "--"),
                        React.createElement("span", { className: "cd" }, p.code_digits),
                        React.createElement("span", { className: "v" }, fi(p.qty)),
                        React.createElement("span", { className: "v dim" }, fi(p.avail)),
                        React.createElement("span", { className: "v" }, f2(p.cost)),
                        React.createElement("span", { className: "v" }, f2(p.price)),
                        React.createElement("span", { className: "v" }, fi(p.mv)),
                        React.createElement("span", { className: "v " + pctCls(p.pl) }, fSign(p.pl)),
                        React.createElement("span", { className: "v b " + pctCls(p.plpct) }, fSign(p.plpct) + "%"))),
                    React.createElement("div", { className: "kpl-tdx-posrow sum" },
                        React.createElement("span", { className: "nm" }, "合计"),
                        React.createElement("span", { className: "cd" }, plist.length + " 只"),
                        React.createElement("span", { className: "v" }),
                        React.createElement("span", { className: "v" }),
                        React.createElement("span", { className: "v" }),
                        React.createElement("span", { className: "v" }),
                        React.createElement("span", { className: "v" }, fi(sumMv)),
                        React.createElement("span", { className: "v " + pctCls(sumPl) }, fSign(sumPl)),
                        React.createElement("span", { className: "v b " + pctCls(sumPct) }, fSign(sumPct) + "%")));
            }

            // ---- 自选分组区 ----
            const groups = data ? (data.groups || []) : [];
            const orphanN = groups.filter((g) => g.registered === false).length;
            const shown = regOnly ? groups.filter((g) => g.registered !== false) : groups;
            const cur = shown.find((g) => g.id === gid) || shown[0] || null;
            const rows = (cur && data && data.stocks && data.stocks[cur.id]) || [];
            const flipRegOnly = () => {
                const v = !regOnly;
                setRegOnly(v);
                try { localStorage.setItem("kpl_tdx_regonly", v ? "1" : "0"); } catch { }
            };

            useEffect(() => { setAliasVal(cur ? (cur.alias || "") : ""); setAliasMsg(""); },
                [cur && cur.id, cur && cur.alias]);
            const saveAlias = async (clear) => {
                if (!cur) return;
                const nm = clear ? "" : aliasVal.trim();
                try {
                    await post("/api/tdx/group-alias", { id: cur.id, name: nm });
                    setAliasMsg(nm ? "已保存：" + nm : "已恢复默认");
                    await load();
                } catch (e) { setAliasMsg("保存失败：" + e.message); }
            };

            return React.createElement("div", { className: "kpl-tdx-wrap" },
                React.createElement("div", { className: "kpl-tdx-head" },
                    React.createElement("b", null, "💼 实盘持仓"),
                    React.createElement("span", { className: "kpl-tdx-head-r" },
                        React.createElement("span", { className: "kpl-tdx-tag" }, "内存直读·只读"),
                        pos && pos.ts ? React.createElement("span", { className: "sync" },
                            " " + new Date(pos.ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }) + (pos.stale ? " (缓存·后台更新中)" : "")) : null,
                        React.createElement("button", {
                            className: "kpl-tdx-btn", disabled: posBusy,
                            onClick: () => loadPos(true),
                        }, posBusy ? "扫描中…" : "刷新"))),
                posBody,
                React.createElement("div", { className: "kpl-tdx-head" },
                    React.createElement("b", null, "🎯 自选分组"),
                    React.createElement("span", { className: "kpl-tdx-head-r" },
                        data && orphanN > 0 ? React.createElement("span", {
                            className: "kpl-tdx-toggle",
                            onClick: flipRegOnly,
                            title: regOnly ? "当前仅显示通达信客户端「自定义板块」里注册的分组；点击显示目录里全部成员文件（含外部工具导入、客户端不显示的）" : "点击恢复仅显示客户端注册组",
                        }, regOnly ? "☑ 仅客户端注册组" : "☐ 全部分组（含未注册 " + orphanN + "）") : null,
                        React.createElement("span", { className: "sync" },
                            err ? "⚠️ " + err : (data && data.synced_at ? "云同步于 " + data.synced_at : "")))),
                data && shown.length ? React.createElement("div", { className: "kpl-tdx-chips" },
                    shown.map((g) => React.createElement("span", {
                        key: g.id,
                        className: "kpl-tdx-chip" + (cur && cur.id === g.id ? " on" : ""),
                        onClick: () => setGid(g.id),
                    }, g.name + " " + g.count))) : null,
                cur && data && shown.length ? React.createElement("div", { className: "kpl-tdx-aliasrow" },
                    React.createElement("span", { className: "lab" }, "别名"),
                    React.createElement("input", {
                        value: aliasVal,
                        placeholder: cur.alias ? "当前别名：" + cur.alias : "为「" + cur.name + "」自定义显示名",
                        onChange: (e) => setAliasVal(e.target.value),
                        onKeyDown: (e) => { if (e.key === "Enter") saveAlias(false); },
                    }),
                    React.createElement("button", { className: "kpl-tdx-btn", onClick: () => saveAlias(false) }, "保存"),
                    cur.alias ? React.createElement("button", { className: "kpl-tdx-btn", onClick: () => saveAlias(true) }, "恢复默认") : null,
                    aliasMsg ? React.createElement("span", { className: "msg" }, aliasMsg) : null) : null,
                cur && rows.length ? React.createElement("div", { className: "kpl-tdx-rows" },
                    rows.map((s) => React.createElement("div", {
                        key: s.market + "_" + s.code,
                        className: "kpl-tdx-row",
                        onClick: () => openStock && s.market !== 2 && openStock({ code: s.code, name: s.name || s.code }),
                    },
                        React.createElement("span", { className: "nm" }, s.name || "--"),
                        React.createElement("span", { className: "cd" }, s.code),
                        React.createElement("span", { className: "px" }, s.price != null ? Number(s.price).toFixed(2) : "--"),
                        React.createElement("span", {
                            className: "pc " + (s.change_pct == null ? "" : s.change_pct < 0 ? "down" : s.change_pct > 0 ? "up" : ""),
                        }, s.change_pct != null ? (s.change_pct > 0 ? "+" : "") + Number(s.change_pct).toFixed(2) + "%" : "--"))))
                    : React.createElement("div", { className: "kpl-tdx-empty" },
                        data && data.available === false
                            ? "⚠️ " + (data.message || "未找到通达信 blocknew 目录") + "——请在 ⚙️ 系统 Tab 配置通达信安装目录（如 D:\\app\\tdx）"
                            : (cur ? "分组「" + cur.name + "」为空" : "暂无分组")),
                React.createElement("div", { className: "kpl-tdx-note" },
                    "默认仅显示通达信客户端「自定义板块」注册的分组（与客户端一致）；目录里还有客户端不显示的外部导入成员文件，点「全部分组」可查看。显示为短码的组可在选中后用「别名」行起名，只存插件不影响通达信。点击个股看K线；仅监控不交易。"));
        }

        const TDX_TAB_G = kplGuard(TdxTab, "通达信");

        const TABS = [
            { id: "timing", label: "⏱ 择时" },
            { id: "sentiment", label: "🔥 情绪风格" },
            { id: "sector", label: "🧩 板块" },
            { id: "position", label: "💼 持仓仓位" },
            { id: "alert", label: "⚠️ 预警" },
            { id: "screen", label: "🔍 选股" },
            { id: "news", label: "🌐 舆情联动" },
            { id: "kpl", label: "🚀 开盘啦" },
            { id: "tdx", label: "🎯 通达信" },
            { id: "system", label: "⚙️ 系统" },
        ];

        /* ---- 悬浮按钮：AI 投资分析（选定股票 → DSH 会话分析） ---- */

        function StockAnalysisFab() {
            const [open, setOpen] = useState(false);
            const [q, setQ] = useState("");
            const [results, setResults] = useState([]);
            const [hot, setHot] = useState([]);            // KPL 综合热搜股票（搜索默认态）
            const [picked, setPicked] = useState(null);   // {code, name}
            const [busy, setBusy] = useState(false);
            const [msg, setMsg] = useState(null);          // {ok, text}
            const [tab, setTab] = useState("search");      // search | watchlist | holdings
            const [tdxw, setTdxw] = useState(null);        // 通达信自选 {available, groups, stocks}
            const [wGid, setWGid] = useState("zxg");       // 自选组 chips（默认自选股）
            const [pos, setPos] = useState(null);          // 通达信实盘持仓

            // 搜索防抖：开盘啦搜索页同款联想（App 全量 STOCK 表 + 拼音首字母/全拼，gzmt→贵州茅台）
            useEffect(() => {
                if (!open || tab !== "search" || !q.trim()) { setResults([]); return; }
                const t = setTimeout(async () => {
                    try {
                        const d = await api("/api/kpl/search/suggest?q=" + encodeURIComponent(q.trim()));
                        const list = Array.isArray(d) ? d : (d.results || []);
                        setResults(list.filter((r) => /^\d{6}$/.test(String(r.code || ""))).slice(0, 8));
                    } catch { setResults([]); }
                }, 300);
                return () => clearTimeout(t);
            }, [q, tab, open]);

            // 列表懒加载：自选/持仓 = 通达信（T0002 分组直读 + 实盘内存持仓）
            useEffect(() => {
                if (!open) return;
                if (tab === "search" && !hot.length) {
                    api("/api/kpl/search/hot").then((d) => {
                        setHot((d.stocks || []).slice(0, 10));
                    }).catch(() => setHot([]));
                }
                if (tab === "watchlist" && !tdxw) {
                    api("/api/tdx/watchlist").then((d) => {
                        setTdxw(d);
                        const first = (d.groups || []).find((g) => g.id === "zxg") || (d.groups || [])[0];
                        setWGid(first ? first.id : "");
                    }).catch(() => setTdxw({ available: false }));
                }
                if (tab === "holdings" && !pos) {
                    api("/api/tdx/positions").then((d) => setPos(d)).catch(() => setPos({ ok: false, error: "请求失败" }));
                }
            }, [open, tab, hot.length, tdxw, pos]);

            const start = async () => {
                if (!picked || busy) return;
                setBusy(true); setMsg(null);
                try {
                    const resp = await fetch("/stock-plugin/analyze", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ code: picked.code, name: picked.name }),
                    });
                    const d = await resp.json().catch(() => ({}));
                    if (resp.ok && d.ok) {
                        setMsg({ ok: true, text: "已创建分析会话「" + (d.title || picked.name) + "」，请在 DSH 会话列表查看" });
                        try { window.__DSH_NOTIFY__ && window.__DSH_NOTIFY__({ type: "info", title: "AI 分析已发起", message: d.title || picked.name }); } catch (e) { /* */ }
                    } else {
                        setMsg({ ok: false, text: d.error || ("HTTP " + resp.status) });
                    }
                } catch (e) {
                    setMsg({ ok: false, text: "请求失败：" + e.message });
                }
                setBusy(false);
            };

            const row = (it, i) => React.createElement("div", {
                key: it.code + "_" + i,
                className: "dsh-fab-row" + (picked && picked.code === it.code ? " on" : ""),
                onClick: () => setPicked({ code: it.code, name: it.name }),
            },
                React.createElement("b", null, it.name),
                React.createElement("span", { className: "cd" }, it.code),
                it.right != null ? React.createElement("span", {
                    className: "rt" + (Number(it.right) < 0 ? " down" : Number(it.right) > 0 ? " up" : ""),
                }, (Number(it.right) > 0 ? "+" : "") + Number(it.right).toFixed(2) + "%") : null);

            const wRows = (tdxw && tdxw.available && tdxw.stocks && tdxw.stocks[wGid]) || [];
            const wGroups = ((tdxw && tdxw.groups) || []).filter((g) => g.registered !== false);
            const posRows = (pos && pos.ok && pos.positions) || [];

            return React.createElement(React.Fragment, null,
                React.createElement("div", {
                    className: "dsh-fab-btn", title: "AI 投资分析",
                    onClick: () => { setOpen(!open); setMsg(null); },
                }, "🤖"),
                open && React.createElement("div", { className: "dsh-fab-mask", onClick: () => setOpen(false) },
                    React.createElement("div", { className: "dsh-fab-panel", onClick: (e) => e.stopPropagation() },
                        React.createElement("div", { className: "dsh-fab-head" },
                            React.createElement("b", null, "🤖 AI 投资分析"),
                            React.createElement("span", { className: "x", onClick: () => setOpen(false) }, "×")),
                        React.createElement("div", { className: "dsh-fab-tabs" },
                            [["search", "搜索"], ["watchlist", "自选股"], ["holdings", "持仓"]].map(function (pair) {
                                return React.createElement("span", {
                                    key: pair[0], className: "dsh-fab-tab" + (tab === pair[0] ? " on" : ""),
                                    onClick: function () { setTab(pair[0]); setPicked(null); },
                                }, pair[1]);
                            })),
                        tab === "search" && React.createElement("input", {
                            className: "dsh-fab-search", placeholder: "输入代码/名称/拼音简写，如 000678 / xyzc",
                            value: q, onChange: function (e) { setQ(e.target.value); },
                        }),
                        tab === "watchlist" && wGroups.length > 1 ? React.createElement("div", { className: "dsh-fab-chips" },
                            wGroups.map((g) => React.createElement("span", {
                                key: g.id, className: "dsh-fab-chip" + (wGid === g.id ? " on" : ""),
                                onClick: () => { setWGid(g.id); setPicked(null); },
                            }, g.name + " " + g.count))) : null,
                        React.createElement("div", { className: "dsh-fab-list" },
                            tab === "search" && (q.trim() ? (results.length ? results.map(row)
                                : React.createElement("div", { className: "dsh-fab-tip" }, "无匹配结果"))
                                : (hot.length ? hot.map((s) => row({ code: s.code, name: s.name || s.code, right: s.pct }, s.code))
                                    : React.createElement("div", { className: "dsh-fab-tip" }, "输入关键词搜索（开盘啦全市场 A 股）"))),
                            tab === "watchlist" && (!tdxw ? React.createElement("div", { className: "dsh-fab-tip" }, "加载通达信自选…")
                                : !tdxw.available ? React.createElement("div", { className: "dsh-fab-tip" }, "未找到通达信 blocknew 目录（系统 Tab 配置安装目录）")
                                    : (wRows.length ? wRows.map((s) => row({ code: s.code, name: s.name || s.code }, s.market + s.code))
                                        : React.createElement("div", { className: "dsh-fab-tip" }, "该分组为空"))),
                            tab === "holdings" && (!pos ? React.createElement("div", { className: "dsh-fab-tip" }, "加载通达信实盘持仓…")
                                : !pos.ok ? React.createElement("div", { className: "dsh-fab-tip" },
                                    pos.error === "tdxw not running"
                                        ? "未检测到通达信客户端——打开 PC 通达信并交易登录、看过一次持仓页后重试"
                                        : "实盘持仓读取失败：" + (pos.error || "未知"))
                                    : posRows.map((p) => row({ code: p.code_digits, name: p.name || p.code_digits, right: p.plpct }, p.code_digits)))),
                        picked && React.createElement("div", { className: "dsh-fab-picked" },
                            "已选：", React.createElement("b", null, picked.name), "（", picked.code, "）"),
                        React.createElement("button", {
                            className: "dsh-fab-go", disabled: !picked || busy,
                            onClick: start,
                        }, busy ? "创建分析会话中…" : "开始 AI 分析"),
                        msg && React.createElement("div", { className: "dsh-fab-msg " + (msg.ok ? "ok" : "err") }, msg.text),
                        React.createElement("div", { className: "dsh-fab-foot" },
                            "分析由 DSH 会话执行（开盘啦数据源：行情/K线/择时/情绪/龙虎榜 + 通达信实盘持仓）"))));
        }

        function WatchlistPanel(props) {
            const [tab, setTab] = useState("timing");
            const [liveAlerts, setLiveAlerts] = useState([]);
            const [connected, setConnected] = useState(false);
            const [selectedStock, setSelectedStock] = useState(null);
            const [backendStatus, setBackendStatus] = useState({ state: "starting", error: null, retrying: false });
            const [refreshTick, setRefreshTick] = useState(0);
            // 权威交易日历（深交所官方）：拉到后存 window.__kplTradeCal 并触发一次重渲染，
            // 各处"盘中/复盘"判定统一读 isTradingNowCal()
            const [calTick, setCalTick] = useState(0);
            const sockRef = useRef(null);
            const statusPollRef = useRef(null);

            useEffect(() => {
                let alive = true;
                const load = async () => {
                    try {
                        const c = await api("/api/trade-calendar");
                        if (alive && c && c.today) {
                            window.__kplTradeCal = c;
                            setCalTick(t => t + 1);
                        }
                    } catch { /* 后端未就绪时下轮再取 */ }
                };
                load();
                const t = setInterval(load, 10 * 60 * 1000);
                return () => { alive = false; clearInterval(t); };
            }, []);

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
                tdx: React.createElement(TDX_TAB_G, { openStock }),
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
                }),
                React.createElement(StockAnalysisFab, null),
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
                /* ---- 悬浮按钮 AI 分析（dsh-fab-* 显式色值） ---- */
                .dsh-fab-btn { position: fixed; right: 28px; bottom: 34px; z-index: 9000; width: 52px; height: 52px; border-radius: 50%; background: #e03131; color: #fff; font-size: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 14px rgba(224,49,49,.4); user-select: none; }
                .dsh-fab-btn:hover { background: #c92a2a; transform: scale(1.05); }
                .dsh-fab-mask { position: fixed; inset: 0; z-index: 9500; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
                .dsh-fab-panel { width: 400px; max-width: 92vw; max-height: 82vh; overflow-y: auto; background: #fff; border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; color: #111; font-size: 13px; }
                .dsh-fab-head { display: flex; justify-content: space-between; align-items: center; font-size: 15px; }
                .dsh-fab-head .x { cursor: pointer; color: #999; font-size: 20px; padding: 0 4px; }
                .dsh-fab-tabs { display: flex; gap: 14px; border-bottom: 1px solid #eee; padding-bottom: 6px; }
                .dsh-fab-tab { cursor: pointer; color: #999; padding: 2px 4px; }
                .dsh-fab-tab.on { color: #e03131; font-weight: 700; border-bottom: 2px solid #e03131; }
                .dsh-fab-search { border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; font-size: 13px; outline: none; }
                .dsh-fab-search:focus { border-color: #e03131; }
                .dsh-fab-list { min-height: 120px; max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; }
                .dsh-fab-row { display: flex; gap: 8px; align-items: baseline; padding: 8px 6px; border-bottom: 1px solid #f5f5f5; cursor: pointer; border-radius: 6px; }
                .dsh-fab-row:hover { background: #f7f7f7; }
                .dsh-fab-row.on { background: #fdecec; }
                .dsh-fab-row b { font-size: 13px; color: #111; }
                .dsh-fab-row .cd { color: #999; font-size: 11px; flex: 1; }
                .dsh-fab-row .rt { font-size: 11px; color: #666; font-variant-numeric: tabular-nums; }
                .dsh-fab-row .rt.up { color: #e0333a; }
                .dsh-fab-row .rt.down { color: #0aa858; }
                .dsh-fab-chips { display: flex; gap: 5px; flex-wrap: wrap; max-height: 52px; overflow-y: auto; margin-bottom: 6px; }
                .dsh-fab-chip { padding: 2px 9px; border-radius: 10px; background: #f2f2f2; color: #666; font-size: 10px; cursor: pointer; white-space: nowrap; border: 1px solid transparent; }
                .dsh-fab-chip:hover { background: #e7e7e7; }
                .dsh-fab-chip.on { background: #e0333a; color: #fff; font-weight: 600; }
                .dsh-fab-tip { color: #999; text-align: center; padding: 24px 0; }
                .dsh-fab-picked { background: #f7f7f7; border-radius: 8px; padding: 8px 10px; color: #333; }
                .dsh-fab-go { border: none; border-radius: 8px; background: #e03131; color: #fff; font-size: 14px; font-weight: 700; padding: 10px 0; cursor: pointer; }
                .dsh-fab-go:disabled { background: #ccc; cursor: not-allowed; }
                .dsh-fab-msg { border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.6; }
                .dsh-fab-msg.ok { background: #ebfbee; color: #2b8a3e; }
                .dsh-fab-msg.err { background: #fff0f0; color: #c92a2a; }
                .dsh-fab-foot { font-size: 11px; color: #999; line-height: 1.6; }
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
                /* ---- 行情菜单订阅面（kpl-mkt-*：显式色值白底，KPL CSS 铁律） ---- */
                .kpl-mkt-wrap { display: flex; flex-direction: column; gap: 8px; }
                .kpl-dtabs { display: flex; gap: 18px; border-bottom: 1px solid #eee; padding-bottom: 6px; }
                .kpl-dtab { font-size: 14px; color: #666; cursor: pointer; position: relative; padding: 2px 2px 6px; }
                .kpl-dtab.on { color: #e03131; font-weight: 700; border-bottom: 2px solid #e03131; }
                .kpl-dt-badge { position: absolute; top: -8px; right: -22px; background: #e03131; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; line-height: 15px; }
                .kpl-dswitch { cursor: pointer; color: #999; }
                .kpl-dswitch.on { color: #e03131; font-weight: 700; }
                .kpl-mkt-cards { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
                /* ---- 板块 tab 1:1（App stareplate/PlateFragment） ---- */
                .kpl-plt-cards { display: flex; gap: 8px; overflow-x: auto; padding: 10px 10px 4px; scroll-snap-type: x proximity; }
                .kpl-plt-cards > div { scroll-snap-align: start; }
                /* 折叠行横向轮播（App ViewPager 同款：卡片 92% 宽露出邻卡边，左右滑切换） */
                .kpl-tk-wrap { display: flex; gap: 8px; overflow-x: auto; scroll-snap-type: x mandatory; margin: 10px 10px 0; }
                .kpl-tk-card { flex: 0 0 92%; scroll-snap-align: center; background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.06); padding: 0 12px; }
                .kpl-tk-card .hd { display: flex; align-items: center; gap: 8px; padding: 12px 0; cursor: pointer; }
                .kpl-tk-card .hd .t { font-size: 16px; font-weight: 700; color: #111; }
                .kpl-tk-card .hd .rt { flex: 1; display: flex; align-items: center; gap: 8px; justify-content: flex-end; overflow: hidden; }
                .kpl-tk-card .hd .rt i, .kpl-tk-card .col { font-style: normal; font-size: 13px; white-space: nowrap; }
                .kpl-tk-card .hd .tm { color: #e0333a; }
                .kpl-tk-card .hd .nm { color: #2f6bff; }
                .kpl-tk-card .hd .st { color: #e0333a; }
                .kpl-tk-card .col { color: #999; }
                .kpl-tk-card .bd { border-top: 1px solid #f5f5f5; padding: 4px 0 8px; max-height: 240px; overflow-y: auto; }
                .kpl-tk-card .bd .it { display: flex; gap: 8px; padding: 6px 0; font-size: 13px; align-items: baseline; overflow: hidden; }
                .kpl-tk-card .bd .tm { color: #e0333a; flex: none; }
                .kpl-tk-card .bd .nm { color: #2f6bff; flex: none; }
                .kpl-tk-card .bd .st { color: #e0333a; flex: none; }
                .kpl-tk-card .bd .tx { color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-tk-card .bd .tx .rd, .kpl-tk-card .bd b.rd { color: #e0333a; font-weight: 700; }
                .kpl-plt-card { flex: 0 0 auto; min-width: 168px; border-radius: 8px; padding: 10px 14px 8px; text-align: center; }
                .kpl-plt-card.upbg { background: #fdf1f0; }
                .kpl-plt-card.dnbg { background: #effaf3; }
                .kpl-plt-ilbl { display: flex; justify-content: center; gap: 14px; margin-bottom: 4px; }
                .kpl-plt-ilbl span { font-size: 13px; color: #999; cursor: pointer; }
                .kpl-plt-ilbl span.on { color: #111; font-weight: 700; }
                .kpl-plt-lbl { font-size: 13px; color: #666; margin-bottom: 4px; }
                .kpl-plt-big { font-size: 22px; font-weight: 700; line-height: 1.2; }
                .kpl-plt-mid { font-size: 20px; font-weight: 700; }
                .kpl-plt-mid .up { color: #e0333a; }
                .kpl-plt-mid .dn { color: #0aa858; }
                .kpl-plt-sub .up { color: #e0333a; }
                .kpl-plt-sub .dn { color: #0aa858; }
                .kpl-plt-sub .rd { color: #e0333a; }
                .kpl-plt-sub .gn { color: #0aa858; }
                .kpl-plt-mid .sep { color: #bbb; margin: 0 6px; font-weight: 400; }
                .kpl-plt-sub { font-size: 12px; margin-top: 3px; }
                .kpl-plt-big.up, .kpl-plt-sub.up { color: #e0333a; }
                .kpl-plt-big.dn, .kpl-plt-sub.dn { color: #0aa858; }
                .kpl-plt-big.rd, .kpl-plt-sub.rd, .kpl-plt-sub .rd { color: #e0333a; }
                .kpl-plt-sub .gn { color: #0aa858; }
                .kpl-plt-dots { display: flex; justify-content: center; gap: 4px; margin-top: 6px; }
                .kpl-plt-dots i { width: 5px; height: 5px; border-radius: 50%; background: #d8d8d8; }
                .kpl-plt-dots i.on { background: #999; }
                .kpl-plt-radar { background: #fff; margin: 10px 10px 0; border-radius: 8px; padding: 0 12px; }
                .kpl-plt-radar .hd { display: flex; align-items: center; gap: 8px; padding: 12px 0; cursor: pointer; }
                .kpl-plt-radar .hd .t { font-size: 16px; font-weight: 700; color: #111; }
                .kpl-plt-radar .hd .rt { flex: 1; display: flex; align-items: center; gap: 8px; justify-content: flex-end; overflow: hidden; }
                .kpl-plt-radar .hd .rt i { font-style: normal; font-size: 13px; white-space: nowrap; }
                .kpl-plt-radar .hd .tm { color: #e0333a; }
                .kpl-plt-radar .hd .nm { color: #2f6bff; }
                .kpl-plt-radar .hd .st { color: #e0333a; }
                .kpl-plt-radar .hd .ar { color: #bbb; font-style: normal; }
                .kpl-plt-radar .bd { border-top: 1px solid #f5f5f5; padding: 4px 0 8px; max-height: 260px; overflow-y: auto; }
                .kpl-plt-radar .bd .it { display: flex; gap: 8px; padding: 6px 0; font-size: 13px; align-items: baseline; }
                .kpl-plt-radar .bd .tm { color: #e0333a; flex: none; }
                .kpl-plt-radar .bd .nm { color: #2f6bff; flex: none; }
                .kpl-plt-radar .bd .st { color: #e0333a; flex: none; }
                .kpl-plt-radar .bd .tx { color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-plt-filter { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
                .kpl-plt-filter .pill { font-size: 15px; padding: 6px 22px; border-radius: 6px; border: 1px solid #e5e5e5; background: #fff; color: #333; cursor: pointer; }
                .kpl-plt-filter .pill.on { background: #e0333a; border-color: #e0333a; color: #fff; font-weight: 700; }
                .kpl-plt-filter .tools { margin-left: auto; display: flex; gap: 10px; }
                .kpl-plt-filter .tools i { font-style: normal; font-size: 12px; color: #666; cursor: pointer; }
                .kpl-plt-table { background: #fff; margin: 0 0 8px; }
                .kpl-plt-thead, .kpl-plt-trow { display: grid; grid-template-columns: 1.25fr 0.75fr 0.95fr 1.25fr; align-items: center; padding-left: 12px; padding-right: 12px; }
                .kpl-plt-trow.sub { padding-top: 8px; padding-bottom: 8px; background: #fbfdff; }
                .kpl-plt-trow.sub .c.nm { padding-left: 18px; position: relative; }
                .kpl-plt-trow.sub .c.nm .ln { position: absolute; left: 2px; top: 50%; width: 12px; height: 1px; background: #d0d7e2; }
                .kpl-plt-trow.sub .c.nm b { font-size: 14px; font-weight: 600; color: #333; }
                .kpl-plt-trow.sub .c { font-size: 14px; }
                .kpl-plt-thead { padding-top: 10px; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0; }
                .kpl-plt-thead .c { font-size: 14px; color: #666; text-align: right; }
                .kpl-plt-thead .c.nm { text-align: left; }
                .kpl-plt-thead .c.hl { background: #eef4fd; color: #2f6bff; align-self: stretch; display: flex; align-items: center; justify-content: flex-end; gap: 2px; padding-top: 8px; padding-bottom: 8px; margin-top: -10px; margin-bottom: -8px; }
                .kpl-plt-thead .srt { font-style: normal; font-size: 10px; color: #bbb; }
                .kpl-plt-thead .srt.dn { color: #e0333a; }
                .kpl-plt-trow { padding-top: 11px; padding-bottom: 11px; border-bottom: 1px solid #f7f7f7; cursor: pointer; }
                .kpl-plt-trow .c { font-size: 15px; font-weight: 700; text-align: right; }
                .kpl-plt-trow .c.nm { text-align: left; font-weight: 400; }
                .kpl-plt-trow .c.nm b { display: block; font-size: 16px; color: #111; font-weight: 600; }
                .kpl-plt-trow .c.nm .cd { font-size: 11px; color: #999; }
                .kpl-plt-trow .c.hl { background: #eef4fd; color: #111; align-self: stretch; display: flex; align-items: center; justify-content: flex-end; margin-top: -11px; margin-bottom: -11px; padding-top: 11px; padding-bottom: 11px; }
                .kpl-plt-trow .c.hl.dim { color: #bbb; font-weight: 400; }
                .kpl-plt-trow .c.up { color: #e0333a; }
                .kpl-plt-trow .c.dn { color: #0aa858; }
                .kpl-plt-tips { font-size: 12px; color: #999; padding: 8px 12px 12px; }
                .kpl-plt-timeline { position: sticky; bottom: 0; background: rgba(40,40,40,.92); border-radius: 10px 10px 0 0; margin: 6px 10px 0; padding: 30px 14px 12px; }
                .kpl-plt-timeline .bar { position: relative; height: 2px; background: #666; margin: 0 10px; }
                .kpl-plt-timeline .dot { position: absolute; top: -7px; width: 16px; height: 16px; border-radius: 50%; background: #ddd; border: 3px solid #888; }
                .kpl-plt-timeline .tick { position: absolute; top: -24px; font-size: 12px; color: #ccc; transform: translateX(-50%); }
                .kpl-plt-timeline .tk1 { left: 4%; }
                .kpl-plt-timeline .tk2 { left: 40%; }
                .kpl-plt-timeline .tk3 { left: 90%; }
                .kpl-plt-timeline .his { position: absolute; right: 12px; bottom: 12px; color: #eee; font-size: 13px; cursor: pointer; }
                .kpl-mkt-card { min-width: 128px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; text-align: center; }
                .kpl-mkt-card .lbl { font-size: 11px; color: #999; }
                .kpl-mkt-card .big { font-size: 18px; font-weight: 700; margin: 2px 0; color: #111; }
                .kpl-mkt-card .sm { font-size: 11px; }
                .kpl-mkt-card .sep { color: #ccc; margin: 0 3px; }
                .kpl-mkt-sec { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
                .kpl-mkt-sec-t { font-size: 13px; font-weight: 700; color: #111; display: flex; align-items: baseline; gap: 8px; }
                .kpl-mkt-tips { font-size: 11px; color: #999; font-weight: 400; }
                .kpl-mkt-empty { background: #fff; border: 1px dashed #e5e5e5; border-radius: 10px; padding: 22px 14px; text-align: center; color: #999; font-size: 12px; line-height: 1.8; }
                .kpl-mkt-empty.sm { border: none; padding: 10px 0; background: transparent; }
                .kpl-mkt-up { color: #e03131; } .kpl-mkt-down { color: #0ca678; }
                .kpl-mkt-mood3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
                .kpl-mkt-mood3 .cell { text-align: center; }
                .kpl-mkt-mood3 .lbl { font-size: 11px; color: #999; }
                .kpl-mkt-mood3 .val { font-size: 15px; margin: 2px 0; }
                .kpl-mkt-mood3 .sub { font-size: 10px; color: #bbb; }
                .kpl-mkt-radar { display: flex; gap: 8px; align-items: baseline; font-size: 12px; line-height: 1.5; }
                .kpl-mkt-radar .t { color: #999; font-size: 11px; white-space: nowrap; }
                .kpl-mkt-radar .chip { font-size: 10px; border-radius: 4px; padding: 0 4px; white-space: nowrap; }
                .kpl-mkt-radar .chip.up { color: #e03131; background: #fdecec; }
                .kpl-mkt-radar .chip.down { color: #0ca678; background: #e6f7f1; }
                .kpl-mkt-radar .txt { color: #333; }
                .kpl-mkt-ladder { display: flex; gap: 10px; font-size: 12px; align-items: baseline; }
                .kpl-mkt-ladder .h { font-weight: 700; white-space: nowrap; color: #e03131; }
                .kpl-mkt-ladder .names { color: #333; }
                .kpl-mkt-ztlist { display: flex; flex-direction: column; }
                .kpl-mkt-ztlist .row { display: grid; grid-template-columns: 1.3fr .8fr .7fr 1.2fr; gap: 6px; padding: 7px 0; border-bottom: 1px solid #f5f5f5; align-items: center; font-size: 12px; }
                .kpl-mkt-ztlist .row:last-child { border-bottom: none; }
                .kpl-mkt-ztlist .nm b { font-size: 13px; color: #111; }
                .kpl-mkt-ztlist .nm .cd { color: #999; font-size: 10px; margin-left: 6px; }
                .kpl-mkt-ztlist .pct { text-align: right; font-weight: 700; }
                .kpl-mkt-ztlist .price { text-align: right; color: #333; }
                .kpl-mkt-ztlist .why { text-align: right; color: #e03131; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-mkt-wind { display: flex; flex-direction: column; }
                .kpl-mkt-wind .wrow { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; font-size: 12px; align-items: center; }
                .kpl-mkt-wind .wrow:last-child { border-bottom: none; }
                .kpl-mkt-wind .nm { font-weight: 600; color: #111; min-width: 64px; }
                .kpl-mkt-wind .plate { color: #1c7ed6; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-mkt-wind .pct { font-weight: 700; }
                .up { color: #e03131; } .down { color: #0ca678; }
                .kpl-mkt-idxtabs { display: flex; gap: 12px; }
                .kpl-mkt-idxtabs .itab { font-size: 13px; color: #999; cursor: pointer; padding: 2px 10px; border-radius: 12px; }
                .kpl-mkt-idxtabs .itab.on { color: #fff; background: #e03131; font-weight: 700; }
                .kpl-mkt-idxhead { display: flex; align-items: baseline; gap: 10px; margin: 4px 0; }
                .kpl-mkt-idxhead b { font-size: 22px; }
                .kpl-mkt-idxhead span { font-size: 12px; }
                .kpl-mkt-trend { width: 100%; display: block; }
                .kpl-mkt-four { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
                .kpl-mkt-four .cell { text-align: center; background: #fafafa; border-radius: 8px; padding: 8px 2px; }
                .kpl-mkt-four b { font-size: 17px; display: block; }
                .kpl-mkt-four .lbl { font-size: 10px; color: #999; }
                .kpl-mkt-sign { font-size: 12px; color: #e03131; text-align: center; }
                .kpl-mkt-dist { display: flex; align-items: flex-end; gap: 3px; height: 74px; padding-top: 4px; }
                .kpl-mkt-dist .col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
                .kpl-mkt-dist .bar { width: 100%; max-width: 14px; border-radius: 2px 2px 0 0; }
                .kpl-mkt-dist .bar.up { background: #e03131; }
                .kpl-mkt-dist .bar.down { background: #0ca678; }
                .kpl-mkt-dist .lbl { font-size: 9px; color: #999; margin-top: 2px; height: 12px; }
                .kpl-mkt-duo { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
                .kpl-mkt-duo .cell { text-align: center; }
                .kpl-mkt-duo .lbl { font-size: 11px; color: #999; }
                .kpl-mkt-duo .val { font-size: 14px; font-weight: 700; color: #111; margin-top: 2px; }
                .kpl-mkt-duo .val.sm { font-size: 12px; }
                .kpl-mkt-broadcast { font-size: 12px; color: #333; line-height: 1.8; }
                .kpl-mkt-comment { font-size: 12px; color: #666; line-height: 1.6; }
                .kpl-mkt-wplates { display: flex; flex-wrap: wrap; gap: 6px; }
                .kpl-mkt-wplates .wp { font-size: 11px; border-radius: 4px; padding: 2px 6px; }
                .kpl-mkt-wplates .wp.up { color: #e03131; background: #fdecec; }
                .kpl-mkt-wplates .wp.down { color: #0ca678; background: #e6f7f1; }
                .kpl-mkt-north { display: flex; align-items: baseline; gap: 8px; font-size: 14px; }
                .kpl-mkt-stkhead, .kpl-mkt-stkrow { display: grid; grid-template-columns: 1.4fr .8fr .7fr .9fr; gap: 6px; padding: 7px 4px; font-size: 12px; align-items: center; }
                .kpl-mkt-stkhead { color: #999; font-size: 11px; border-bottom: 1px solid #eee; background: #fff; border-radius: 8px 8px 0 0; padding-top: 9px; }
                .kpl-mkt-stkhead .pct, .kpl-mkt-stkhead .price, .kpl-mkt-stkhead .net { text-align: right; }
                .kpl-mkt-stkrow { background: #fff; border-bottom: 1px solid #f5f5f5; }
                .kpl-mkt-stkrow .nm b { font-size: 13px; color: #111; }
                .kpl-mkt-stkrow .nm .cd { color: #999; font-size: 10px; margin-left: 6px; }
                .kpl-mkt-stkrow .pct { text-align: right; font-weight: 700; }
                .kpl-mkt-stkrow .price { text-align: right; color: #333; }
                .kpl-mkt-stkrow .net { text-align: right; }
                /* ---- 龙虎榜（kpl-lhb-* 显式色值白底，KPL CSS 铁律） ---- */
                .kpl-lhb-top { display: flex; justify-content: space-between; align-items: center; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
                .kpl-lhb-top .cnt { font-size: 13px; color: #111; }
                .kpl-lhb-top .cnt b { color: #e03131; margin-left: 4px; }
                .kpl-lhb-top .dnav { display: flex; align-items: center; gap: 10px; }
                .kpl-lhb-top .arrow { color: #999; cursor: pointer; font-size: 13px; padding: 2px 6px; }
                .kpl-lhb-top .arrow.dis { color: #ccc; }
                .kpl-lhb-top .d { font-size: 14px; font-weight: 600; color: #1c5fbb; }
                .kpl-lhb-scroll { overflow-x: auto; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 4px 10px; }
                .kpl-lhb-table { background: #fff; }
                .kpl-lhb-table:not(.stk) { border: 1px solid #f0f0f0; border-radius: 10px; padding: 6px 10px; }
                .kpl-lhb-table.stk { min-width: 760px; }
                .kpl-lhb-head { display: grid; gap: 6px; padding: 8px 2px; font-size: 11px; color: #999; border-bottom: 1px solid #eee; }
                .kpl-lhb-head .sort { cursor: pointer; user-select: none; white-space: nowrap; }
                .kpl-lhb-head .sort:hover { color: #e03131; }
                .kpl-lhb-head .arr { font-size: 9px; }
                .kpl-lhb-head.stk, .kpl-lhb-row.stk { grid-template-columns: 1.3fr 1fr .75fr .85fr .7fr .8fr .65fr 1fr 1fr; }
                .kpl-lhb-head.ag { grid-template-columns: 1.15fr .9fr .7fr 1fr; }
                .kpl-lhb-head.biz { grid-template-columns: 1.4fr .8fr .8fr .6fr; }
                .kpl-lhb-head.log5 { grid-template-columns: 1.1fr .7fr .7fr .6fr .9fr; }
                .kpl-lhb-row .numcol { text-align: right; color: #333; font-size: 11px; white-space: nowrap; }
                .kpl-lhb-head .r { text-align: right; }
                .kpl-lhb-head .hl { color: #111; font-weight: 700; background: #eef4fb; border-radius: 3px; padding: 1px 4px; }
                .kpl-lhb-row { display: grid; gap: 6px; padding: 9px 2px; border-bottom: 1px solid #f5f5f5; font-size: 12px; align-items: center; cursor: pointer; }
                .kpl-lhb-row:last-child { border-bottom: none; }
                .kpl-lhb-row.stk { grid-template-columns: 1.15fr 1fr .7fr .8fr; }
                .kpl-lhb-row.ag { grid-template-columns: 1.15fr .9fr .7fr 1fr; }
                .kpl-lhb-row.biz { grid-template-columns: 1.4fr .8fr .8fr .6fr; }
                .kpl-lhb-row.log5 { grid-template-columns: 1.1fr .7fr .7fr .6fr .9fr; }
                .kpl-lhb-row.log5.hot { background: #fffbeb; }
                                .kpl-qd2-daynav { display: flex; align-items: center; justify-content: center; gap: 14px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
                .kpl-qd2-daynav .arrow { color: #999; cursor: pointer; font-size: 14px; padding: 2px 8px; user-select: none; }
                .kpl-qd2-daynav .arrow.dis { color: #ccc; }
                .kpl-qd2-daynav .d { font-size: 15px; font-weight: 700; color: #1c5fbb; }
                .kpl-lhb-head.av, .kpl-lhb-row.av { grid-template-columns: 1.2fr .8fr .7fr 1.3fr; }
                .kpl-lhb-head.hk, .kpl-lhb-row.hk { grid-template-columns: 1.4fr 1fr .7fr; }
                .kpl-lhb-head.pr, .kpl-lhb-row.pr { grid-template-columns: 1.3fr .7fr .7fr .9fr; }
                .kpl-lhb-head.fk, .kpl-lhb-row.fk { grid-template-columns: 1.3fr .9fr .7fr 1.2fr; }
                .kpl-lhb-head.fk2, .kpl-lhb-row.fk2 { grid-template-columns: 1.4fr 1fr .8fr; }
                .kpl-lhb-head.sdp, .kpl-lhb-row.sdp { grid-template-columns: 1.3fr .7fr .75fr .8fr .9fr .9fr; }
                .kpl-lhb-row.sdp.zt { background: #fff5f5; }
                .kpl-sdp-sum { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
                .kpl-sdp-sum.eight { grid-template-columns: repeat(4, 1fr); gap: 8px 4px; }
                .kpl-sdp-chart { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
                /* 直播页 kpl-lv-*（App MarketLiveFragment 1:1） */
                .kpl-lv-fs { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 10px 6px; }
                .kpl-lv-fshead { display: flex; align-items: baseline; gap: 8px; padding: 0 4px; }
                .kpl-lv-fshead b { font-size: 17px; }
                .kpl-lv-fshead span { font-size: 12px; }
                .kpl-lv-item { display: flex; gap: 8px; }
                .kpl-lv-item .tl { width: 46px; display: flex; flex-direction: column; align-items: center; flex-shrink: 0; padding-top: 2px; }
                .kpl-lv-item .tl .tm { color: #e03131; font-size: 12px; font-weight: 700; white-space: nowrap; }
                .kpl-lv-item .tl .dot { width: 6px; height: 6px; border-radius: 3px; background: #e03131; margin: 5px 0 3px; }
                .kpl-lv-item .tl .ln { width: 1px; flex: 1; background: #eee; }
                .kpl-lv-item:last-child .tl .ln { background: transparent; }
                .kpl-lv-item .card { flex: 1; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; min-width: 0; }
                .kpl-lv-item .txt { font-size: 14px; color: #111; line-height: 1.75; word-break: break-all; }
                .kpl-lv-item .chips { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
                .kpl-lv-item .chip { display: flex; justify-content: space-between; align-items: center; background: #f5f6f8; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
                .kpl-lv-item .chip i { font-style: normal; font-size: 13px; color: #111; }
                .kpl-lv-item .chip b { font-size: 13px; font-weight: 700; }
                .kpl-lv-item .chip.plate i { color: #1c5fbb; }
                /* 个股详情 kpl-sd-*（App StockQuotationActivity 1:1） */
                .kpl-sd-head { display: flex; align-items: center; background: #e03131; color: #fff; padding: 10px 8px; gap: 6px; }
                .kpl-sd-head .bk { font-size: 24px; padding: 0 6px; cursor: pointer; }
                .kpl-sd-head .nav { font-size: 15px; padding: 4px 6px; cursor: pointer; }
                .kpl-sd-head .nav.dis { color: rgba(255,255,255,.4); cursor: default; }
                .kpl-sd-head .tt { flex: 1; text-align: center; min-width: 0; }
                .kpl-sd-head .tt b { font-size: 17px; display: block; }
                .kpl-sd-head .tt .tags { display: flex; justify-content: center; gap: 4px; align-items: center; }
                .kpl-sd-head .tag { font-size: 10px; border-radius: 2px; padding: 0 3px; }
                .kpl-sd-head .tag.r { background: #ffd43b; color: #c92a2a; }
                .kpl-sd-head .tag.o { background: #fff; color: #e8590c; }
                .kpl-sd-head .cd { font-size: 12px; opacity: .9; }
                .kpl-sd-head .sch { font-size: 16px; padding: 0 6px; cursor: pointer; }
                .kpl-sd-mainrow { display: flex; justify-content: space-between; background: #fff; border: 1px solid #f0f0f0; padding: 7px 12px; font-size: 12px; color: #666; border-top: none; }
                .kpl-sd-mainrow b { font-weight: 700; }
                .kpl-sd-flash { background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; margin: 8px 0; padding: 9px 12px; display: flex; gap: 8px; align-items: flex-start; }
                .kpl-sd-flash .lab { font-style: normal; color: #e03131; font-weight: 800; font-size: 12px; flex-shrink: 0; line-height: 1.6; }
                .kpl-sd-flash .txt { font-size: 13px; color: #333; line-height: 1.6; }
                .kpl-sd-flash .txt em { font-style: normal; color: #e03131; font-weight: 700; }
                .kpl-sd-vp { position: relative; }
                .kpl-sd-p1 { background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; padding: 6px; }
                .kpl-sd-p1 .lft { display: block; }
                .kpl-sd-p1 .rgt { margin-top: 6px; }
                .kpl-sd-sidetabs { display: flex; gap: 2px; border-bottom: 1px solid #eee; margin-bottom: 6px; }
                .kpl-sd-sidetabs span { padding: 6px 14px; font-size: 13px; color: #666; cursor: pointer; border-bottom: 2px solid transparent; }
                .kpl-sd-sidetabs span.on { color: #e03131; font-weight: 700; border-bottom-color: #e03131; }
                .kpl-sd-p1 .fenbi { margin-top: 6px; }
                .kpl-sd-p2 { background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; padding: 8px; }
                .kpl-sd-p2 .periods { display: flex; gap: 2px; border-bottom: 1px solid #eee; margin-bottom: 6px; }
                .kpl-sd-p2 .periods span { flex: 1; text-align: center; padding: 7px 0; font-size: 13px; color: #666; cursor: pointer; }
                .kpl-sd-p2 .periods span.on { color: #e03131; font-weight: 700; border-bottom: 2px solid #e03131; }
                .kpl-sd-kline { height: 320px; }
                .kpl-sd-dots { display: flex; justify-content: center; gap: 6px; padding: 8px 0 2px; }
                .kpl-sd-dots span { width: 18px; height: 3px; background: #ddd; border-radius: 2px; cursor: pointer; }
                .kpl-sd-dots span.on { background: #e03131; }
                .kpl-sd-plates { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 8px 0; }
                .kpl-sd-plates .pk { background: #fff; border: 1px solid #f0f0f0; border-radius: 6px; text-align: center; padding: 8px 2px; font-size: 12px; color: #1c5fbb; }
                .kpl-sd-bigtabs { background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; margin: 8px 0; }
                .kpl-sd-bigtabs .tabs { display: flex; border-bottom: 1px solid #eee; overflow-x: auto; }
                .kpl-sd-bigtabs .tabs span { flex: 1; text-align: center; padding: 11px 0; font-size: 14px; color: #333; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; }
                .kpl-sd-bigtabs .tabs span.on { color: #e03131; font-weight: 700; border-bottom-color: #e03131; }
                .kpl-sd-bigtabs .body { padding: 10px 12px; }
                .kpl-sd-pk3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px 8px; }
                .kpl-sd-pk3 .cell { display: flex; justify-content: space-between; font-size: 12px; border-bottom: 1px dashed #f5f5f5; padding-bottom: 4px; }
                .kpl-sd-pk3 .cell .k { color: #999; }
                .kpl-sd-pk3 .cell .v { color: #111; font-weight: 600; }
                .kpl-sd-dp .r1 { display: flex; justify-content: space-between; color: #666; font-size: 13px; margin-bottom: 8px; }
                .kpl-sd-dp .hd, .kpl-sd-dp .row { display: grid; grid-template-columns: 1.2fr 1fr 1fr; padding: 9px 4px; border-bottom: 1px solid #f5f5f5; font-size: 13px; }
                .kpl-sd-dp .hd { color: #999; }
                .kpl-sd-dp .hd span:not(:first-child), .kpl-sd-dp .row span:not(:first-child) { text-align: right; }
                .kpl-sd-dp .net { text-align: right; padding-top: 10px; font-size: 13px; color: #666; }
                .kpl-sd-ztrs .card { background: #f7f8fa; border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #333; line-height: 1.7; margin-bottom: 8px; }
                .kpl-sd-ztrs .lab { font-style: normal; color: #e8590c; font-weight: 700; margin-right: 6px; }
                .kpl-sd-ztrs .ztd { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
                .kpl-sd-ztrs .ztd .blue { color: #1c5fbb; font-weight: 700; font-size: 13px; flex: 1; }
                .kpl-sd-ztrs .ztd .tagi { font-style: normal; font-size: 10px; color: #e8590c; border: 1px solid #e8590c; border-radius: 2px; padding: 0 3px; }
                .kpl-sd-ztrs .ztd .dt { color: #999; font-size: 11px; }
                .kpl-sd-ztrs .quote { background: #f0f3f7; border-radius: 6px; padding: 8px 10px; font-size: 12px; color: #555; line-height: 1.6; margin-bottom: 8px; }
                .kpl-sd-ztrs .bf { font-size: 13px; color: #333; line-height: 1.7; }
                .kpl-sd-ztrs .lab.o { color: #e8590c; }
                .kpl-sd-news .nw.lnk { display: block; text-decoration: none; }
                .kpl-sd-news .nt { font-size: 13px; color: #111; line-height: 1.5; margin-bottom: 3px; }
                .kpl-sd-news .ns { font-size: 11px; color: #999; }
                .kpl-sd-news .ns i { font-style: normal; color: #1c5fbb; }
                .kpl-sd-news .nw { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f5f5f5; font-size: 12px; }
                .kpl-sd-news .tm { color: #999; flex-shrink: 0; }
                .kpl-sd-news .nw > div { color: #333; line-height: 1.5; }
                .kpl-sd-bar { position: sticky; bottom: 0; display: grid; grid-template-columns: repeat(4, 1fr); background: #fff; border-top: 1px solid #eee; margin: 10px -8px -8px; padding: 8px 4px calc(8px + env(safe-area-inset-bottom)); }
                .kpl-sd-bar .it { display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 11px; color: #333; cursor: pointer; }
                .kpl-sd-bar .it .ico { font-style: normal; font-size: 17px; color: #e03131; }
                .kpl-sd-bar .it .ico.star { color: #e03131; }
                .kpl-sd-bar .it b { font-weight: 700; }
                /* 功能宫格 kpl-fg-* */
                .kpl-fg-entry { display: flex; align-items: center; gap: 8px; cursor: pointer; }
                .kpl-fg-entry .ic { font-style: normal; color: #e03131; font-size: 16px; }
                .kpl-fg-entry .t { font-size: 14px; font-weight: 700; color: #111; }
                .kpl-fg-entry .more { margin-left: auto; color: #999; }
                .kpl-fg-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 6px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 12px 8px; }
                .kpl-fg-cell { display: flex; flex-direction: column; align-items: center; gap: 5px; cursor: pointer; }
                .kpl-fg-cell .ic { width: 40px; height: 40px; border-radius: 10px; object-fit: cover; background: #f7f8fa; }
                .kpl-fg-cell .nm { font-size: 11px; color: #333; text-align: center; }
                .kpl-fg-radar { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 4px 12px; }
                .kpl-fg-radar .rw { display: flex; gap: 8px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid #f5f5f5; font-size: 12px; }
                .kpl-fg-radar .rw:last-child { border-bottom: none; }
                .kpl-fg-radar .tm { color: #999; flex-shrink: 0; }
                .kpl-fg-radar .st { font-weight: 700; }
                .kpl-fg-radar .nm { color: #111; flex: 1; }
                .kpl-fg-north { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 12px; }
                .kpl-fg-north .r1 { font-size: 14px; color: #111; margin-bottom: 6px; }
                .kpl-fg-north .r2 { font-size: 12px; color: #666; }
                /* F10 六宫格 kpl-f10-* */
                .kpl-f10-pills { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }
                .kpl-f10-pills span { text-align: center; padding: 9px 2px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; color: #333; cursor: pointer; background: #fff; }
                .kpl-f10-pills span.on { background: #e03131; border-color: #e03131; color: #fff; font-weight: 700; }
                /* 首页 1:1 新块 */
                .kpl-flash2 { background: #1a1a1a; border-radius: 12px; padding: 12px 14px; color: #fff; }
                .kpl-flash2-head { display: flex; align-items: center; gap: 5px; margin-bottom: 8px; }
                .kpl-flash2-head .t { font-size: 15px; font-weight: 700; color: #fff; }
                .kpl-flash2-head .arr { color: #fff; }
                .kpl-flash2-head .robot { margin-left: auto; font-size: 15px; }
                .kpl-flash2-line { font-size: 14px; line-height: 1.7; color: #fff; margin-bottom: 6px; }
                .kpl-flash2-line.sm { font-size: 12px; color: #ddd; margin-bottom: 4px; }
                .kpl-flash2-line .tm { color: #ff6b6b; font-weight: 700; }
                .kpl-flash2-body .ft { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #333; padding-top: 7px; margin-top: 4px; }
                .kpl-flash2-body .src { color: #999; font-size: 11px; }
                .kpl-flash2-body .ai { color: #4dabf7; font-size: 12px; font-weight: 700; }
                .kpl-theme2-row { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f5f5f5; cursor: pointer; }
                .kpl-theme2-row:last-child { border-bottom: none; }
                .kpl-theme2-badge { width: 86px; height: 76px; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 15px; font-weight: 700; text-align: center; flex-shrink: 0; line-height: 1.3; padding: 4px; }
                .kpl-theme2-badge.red { background: linear-gradient(135deg, #e03131, #c92a2a); }
                .kpl-theme2-badge.gold { background: linear-gradient(135deg, #f0a02a, #e8890c); }
                .kpl-theme2-main { flex: 1; min-width: 0; }
                .kpl-theme2-title { font-size: 14px; color: #111; line-height: 1.5; margin-bottom: 7px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .kpl-theme2-stocks { display: flex; gap: 8px; }
                .kpl-theme2-stock { display: inline-flex; gap: 5px; align-items: center; background: #f5f6f8; border-radius: 4px; padding: 4px 8px; font-size: 12px; }
                .kpl-theme2-stock i { font-style: normal; color: #333; }
                .kpl-theme2-stock b { font-weight: 700; }
                .kpl-sec-head .date { color: #1c5fbb; font-size: 13px; font-weight: 600; }
                .kpl-qd3 { display: flex; flex-direction: column; }
                .kpl-qd3 .hd, .kpl-qd3 .rw { display: grid; grid-template-columns: 1.4fr .8fr .8fr 1fr; padding: 9px 0; border-bottom: 1px solid #f5f5f5; font-size: 13px; align-items: center; }
                .kpl-qd3 .hd { color: #999; font-size: 12px; }
                .kpl-qd3 .rw { cursor: pointer; }
                .kpl-qd3 .nm b { display: block; font-size: 14px; color: #111; }
                .kpl-qd3 .nm i { font-style: normal; color: #999; font-size: 11px; }
                .kpl-qd3 .st { font-weight: 700; color: #111; }
                .kpl-qd3 .pct { text-align: right; }
                .kpl-qd3 .pct b { font-size: 14px; }
                .kpl-qd3 .pl { color: #1c5fbb; font-size: 12px; text-align: right; line-height: 1.4; }
                .kpl-qd3 .lock { text-align: center; padding: 10px 0 2px; color: #e03131; font-size: 13px; font-weight: 600; }
                .kpl-pop3-card { padding: 10px 0; border-bottom: 1px solid #f5f5f5; cursor: pointer; }
                .kpl-pop3-card:last-child { border-bottom: none; }
                .kpl-pop3-card .r1 { display: flex; align-items: center; gap: 7px; }
                .kpl-pop3-card .rk { width: 22px; height: 22px; border-radius: 4px; color: #fff; font-weight: 800; font-size: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
                .kpl-pop3-card .rk.c1 { background: #e03131; }
                .kpl-pop3-card .rk.c2 { background: #f08c00; }
                .kpl-pop3-card .rk.c3 { background: #e8b40c; }
                .kpl-pop3-card .nm { font-size: 15px; color: #111; }
                .kpl-pop3-card .cd { color: #999; font-size: 12px; }
                .kpl-pop3-card .sp { flex: 1; }
                .kpl-pop3-card .pct { font-size: 15px; }
                .kpl-pop3-card .fire { color: #e03131; font-size: 12px; display: inline-flex; gap: 2px; align-items: center; }
                .kpl-pop3-card .fire b { color: #e03131; }
                .kpl-pop3-card .r2 { display: flex; gap: 7px; align-items: center; margin-top: 5px; font-size: 12px; }
                .kpl-pop3-card .rc.up { color: #e03131; }
                .kpl-pop3-card .rc.down { color: #2f9e44; }
                .kpl-pop3-card .zr { font-style: normal; color: #e8590c; border: 1px solid #e8590c; border-radius: 3px; padding: 0 4px; }
                .kpl-pop3-card .tg { font-style: normal; color: #1c5fbb; border: 1px solid #1c5fbb; border-radius: 3px; padding: 0 4px; }
                .kpl-pop3-card .desc { margin-top: 6px; font-size: 12px; color: #888; line-height: 1.65; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
                .kpl-f10-sec { margin-bottom: 12px; }
                .kpl-f10-sec .st { font-size: 14px; font-weight: 700; color: #111; margin-bottom: 5px; }
                .kpl-f10-sec .st .tagi { font-style: normal; font-size: 10px; color: #fff; background: #e8590c; border-radius: 2px; padding: 0 3px; margin-left: 6px; vertical-align: 1px; }
                .kpl-f10-sec .tx { font-size: 13px; color: #333; line-height: 1.75; }
                .kpl-f10-sec .tx .exp { color: #1c5fbb; cursor: pointer; }
                .kpl-f10-sec .ns { font-size: 11px; color: #999; margin-top: 3px; }
                .kpl-f10-rem .rw { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
                .kpl-f10-rem .rw:last-child { border-bottom: none; }
                .kpl-f10-rem .dt { text-align: center; flex-shrink: 0; width: 48px; }
                .kpl-f10-rem .dt b { display: block; font-size: 14px; color: #111; }
                .kpl-f10-rem .dt i { font-style: normal; font-size: 10px; color: #999; }
                .kpl-f10-rem .ct { flex: 1; min-width: 0; }
                .kpl-f10-rem .ct .tt { font-size: 14px; font-weight: 700; color: #111; }
                .kpl-f10-rem .ct .tx { font-size: 12px; color: #666; line-height: 1.6; margin-top: 2px; }
                .kpl-f10-co .row { display: flex; padding: 8px 0; border-bottom: 1px dashed #f0f0f0; font-size: 13px; }
                .kpl-f10-co .row .k { color: #999; width: 72px; flex-shrink: 0; }
                .kpl-f10-co .row .v { color: #333; flex: 1; line-height: 1.5; }
                .kpl-f10-co .hd, .kpl-f10-co .row3 { display: grid; grid-template-columns: 2fr 1fr .8fr; padding: 7px 0; font-size: 12px; border-bottom: 1px solid #f5f5f5; }
                .kpl-f10-co .hd { color: #999; }
                .kpl-f10-co .row3 span:not(:first-child) { text-align: right; }
                .kpl-f10-fin .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
                .kpl-f10-fin .chips span { font-size: 11px; color: #666; background: #f5f6f8; border-radius: 3px; padding: 3px 8px; }
                .kpl-sdp-chart .cvtabs { display: flex; gap: 4px; margin-bottom: 8px; }
                .kpl-sdp-chart .cvtabs span { padding: 4px 14px; border-radius: 12px; font-size: 12px; color: #666; background: #f5f5f5; cursor: pointer; }
                .kpl-sdp-chart .cvtabs span.on { background: #e03131; color: #fff; font-weight: 700; }
                .kpl-mdd-tabs .ttab.on2 { color: #e03131; font-weight: 700; border-bottom: 2px solid #e03131; }
                .kpl-sdp-bkr { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 6px 12px; }
                .kpl-sdp-bkr .bkr-item { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
                .kpl-sdp-bkr .bkr-item:last-child { border-bottom: none; }
                .kpl-sdp-bkr .bt { font-size: 14px; font-weight: 700; color: #111; margin-bottom: 4px; }
                .kpl-sdp-bkr .bc { font-size: 12px; color: #444; line-height: 1.7; word-break: break-all; }
                .kpl-sdp-sum .cell { text-align: center; }
                .kpl-sdp-sum .lbl { font-size: 11px; color: #999; }
                .kpl-sdp-sum .v { font-size: 14px; font-weight: 700; color: #111; margin-top: 2px; }
.kpl-lhb-row .nm b { font-size: 13px; color: #111; }
                .kpl-lhb-head .sticky, .kpl-lhb-row .nm.sticky { position: sticky; left: 0; background: #fff; z-index: 1; }
                .kpl-lhb-row .nm .cd { color: #999; font-size: 10px; margin-left: 5px; }
                .kpl-lhb-row .nm.wide { font-size: 12px; color: #111; line-height: 1.4; }
                .kpl-lhb-row .nm .d3tag { font-size: 9px; color: #fff; background: #e03131; border-radius: 3px; padding: 0 3px; margin-left: 4px; vertical-align: 1px; }
                .kpl-lhb-row .concept { color: #1c5fbb; font-size: 11px; line-height: 1.5; }
                .kpl-lhb-row .concept.sm { font-size: 10px; }
                .kpl-lhb-row .pctcol { text-align: right; font-weight: 600; }
                .kpl-lhb-row .buycol, .kpl-lhb-row .sellcol { text-align: right; font-weight: 700; }
                .kpl-lhb-row .buycol.hl { background: #eef4fb; border-radius: 3px; padding: 4px 2px; }
                .kpl-lhb-row .typecol { text-align: center; font-size: 11px; }
                .kpl-lhb-row .moneycol { text-align: right; font-weight: 600; }
                .kpl-lhb-row .datecol { font-size: 10px; color: #666; line-height: 1.3; }
                .kpl-lhb-row .nm .blue { color: #1c5fbb; }
                .kpl-lhb-agency { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
                /* ==== 搜索页 kpl-sp-*（App 搜索 1:1，显式白底） ==== */
                .kpl-sp { padding-bottom: 46px; }
                .kpl-sp-top { display: flex; align-items: center; gap: 8px; background: #e03131; padding: 8px 10px; position: sticky; top: 0; z-index: 5; }
                .kpl-sp-top .back { color: #fff; font-size: 26px; line-height: 1; padding: 0 4px; cursor: pointer; }
                .kpl-sp-top .box { flex: 1; display: flex; align-items: center; gap: 6px; background: #fff; border-radius: 17px; padding: 7px 12px; }
                .kpl-sp-top .box .ico { font-size: 13px; }
                .kpl-sp-top .box input { flex: 1; border: none; outline: none; font-size: 13px; color: #111; background: transparent; }
                .kpl-sp-top .go { color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; padding: 0 2px; }
                .kpl-sp-tabs { display: flex; background: #fff; border-bottom: 1px solid #f0f0f0; position: sticky; top: 44px; z-index: 4; }
                .kpl-sp-tabs .t { flex: 1; text-align: center; padding: 9px 0; font-size: 13px; color: #333; cursor: pointer; border-bottom: 2px solid transparent; }
                .kpl-sp-tabs .t.on { color: #e03131; font-weight: 700; border-bottom-color: #e03131; }
                .kpl-sp-sec { padding: 10px 12px 2px; }
                .kpl-sp-sec .sec-t { font-size: 14px; font-weight: 700; color: #111; margin-bottom: 4px; }
                .kpl-sp-sec .sec-t .fire { font-style: normal; margin-right: 3px; }
                .kpl-sp-sechist { padding: 10px 12px 2px; border-bottom: 6px solid #f5f6f8; }
                .kpl-sp-sechist .t { font-size: 14px; font-weight: 700; color: #111; }
                .kpl-sp-sechist .clr { float: right; color: #999; cursor: pointer; font-size: 13px; }
                .kpl-sp-sechist .chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0; }
                .kpl-sp-sechist .chips .chip { font-size: 12px; color: #333; background: #f5f6f8; border-radius: 14px; padding: 5px 12px; cursor: pointer; }
                .kpl-sp-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #f7f7f7; cursor: pointer; background: #fff; }
                .kpl-sp-row:last-child { border-bottom: none; }
                .kpl-sp-row .rank { width: 18px; height: 18px; border-radius: 4px; font-size: 11px; color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: #ccc; }
                .kpl-sp-row .rank.r1 { background: #e03131; }
                .kpl-sp-row .rank.r2 { background: #f08c00; }
                .kpl-sp-row .rank.r3 { background: #f5c000; }
                .kpl-sp-row .mid { flex: 1; min-width: 0; }
                .kpl-sp-row .mid b { display: block; font-size: 14px; color: #111; }
                .kpl-sp-row .mid .cd { font-size: 11px; color: #999; }
                .kpl-sp-row .mid .mk { font-style: normal; font-size: 9px; color: #fff; background: #1c5fbb; border-radius: 3px; padding: 0 4px; margin-left: 5px; vertical-align: 1px; }
                .kpl-sp-row .reason { font-size: 11px; color: #1c5fbb; border: 1px solid #c9def7; border-radius: 3px; padding: 1px 5px; flex-shrink: 0; }
                .kpl-sp-row .pct { width: 56px; text-align: right; font-size: 14px; font-weight: 600; flex-shrink: 0; }
                .kpl-sp-row .pct.up, .kpl-sp-grid .pct.up { color: #e03131; }
                .kpl-sp-row .pct.down, .kpl-sp-grid .pct.down { color: #2f9e44; }
                .kpl-sp-row .addbtn { width: 26px; height: 26px; border-radius: 50%; border: 1px solid #e03131; background: #fff; color: #e03131; font-size: 15px; line-height: 1; flex-shrink: 0; cursor: pointer; }
                .kpl-sp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; padding: 4px 12px; }
                .kpl-sp-grid .cell { display: flex; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid #f7f7f7; cursor: pointer; }
                .kpl-sp-grid .cell.word { font-size: 13px; color: #333; }
                .kpl-sp-grid .rank { width: 18px; height: 18px; border-radius: 4px; font-size: 11px; color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: #ccc; }
                .kpl-sp-grid .rank.r1 { background: #e03131; }
                .kpl-sp-grid .rank.r2 { background: #f08c00; }
                .kpl-sp-grid .rank.r3 { background: #f5c000; }
                .kpl-sp-grid .mid { min-width: 0; }
                .kpl-sp-grid .mid b { display: block; font-size: 13px; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .kpl-sp-grid .mid .cd { font-size: 10px; color: #999; }
                .kpl-sp-fund { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-bottom: 1px solid #f7f7f7; font-size: 13px; color: #111; cursor: pointer; background: #fff; }
                .kpl-sp-fund .nm { flex: 1; }
                .kpl-sp-fund .cd { color: #999; font-size: 11px; }
                .kpl-sp-biz { display: flex; align-items: center; padding: 11px 12px; border-bottom: 1px solid #f7f7f7; cursor: pointer; background: #fff; }
                .kpl-sp-biz .nm { flex: 1; font-size: 13px; color: #111; }
                .kpl-sp-biz .sub { color: #e03131; font-size: 12px; }
                .kpl-sp-none { text-align: center; color: #999; font-size: 13px; padding: 28px 0; }
                .kpl-sp-more { display: flex; align-items: center; justify-content: space-between; margin: 10px 12px; padding: 11px 12px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; cursor: pointer; }
                .kpl-sp-more .t { font-size: 13px; color: #1c5fbb; font-weight: 600; }
                .kpl-sp-more .d { font-size: 11px; color: #999; margin-top: 2px; }
                .kpl-sp-more .arr { color: #ccc; font-size: 18px; }
                .kpl-sp-grp { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; margin: 0 12px 10px; padding: 4px 12px; }
                .kpl-sp-grp .grp-t { font-size: 13px; font-weight: 700; color: #111; padding: 8px 0 2px; }
                .kpl-sp-grp .grp-it { padding: 8px 0; border-bottom: 1px solid #f7f7f7; }
                .kpl-sp-grp .grp-it:last-child { border-bottom: none; }
                .kpl-sp-grp .grp-it .tt { font-size: 13px; color: #222; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .kpl-sp-grp .grp-it .dd { font-size: 11px; color: #999; margin-top: 3px; }
                /* ==== 推荐菜单/文章详情 kpl-rcm-*/ /*kpl-art-*（App 文章 H5 同源，显式白底） ==== */
                                .kpl-rcm-top { display: flex; align-items: center; gap: 16px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; }
                .kpl-rcm-top .bt { font-size: 18px; color: #999; cursor: pointer; }
                .kpl-rcm-top .bt.on { color: #111; font-weight: 800; }
                .kpl-rcm-top .tools { margin-left: auto; }
                .kpl-rcm-top .tools .tl { font-style: normal; font-size: 15px; cursor: pointer; }
                .kpl-rcm-cols { display: flex; gap: 4px; overflow-x: auto; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 4px 6px; margin-bottom: 8px; scrollbar-width: none; }
                .kpl-rcm-cols .c { position: relative; flex-shrink: 0; font-size: 13px; color: #444; padding: 6px 12px; border-radius: 14px; cursor: pointer; white-space: nowrap; }
                .kpl-rcm-cols .c.on { background: #e03131; color: #fff; font-weight: 700; }
                .kpl-rcm-cols .c .hot { font-style: normal; position: absolute; top: -4px; right: -2px; font-size: 8px; color: #fff; background: #e03131; border-radius: 5px 5px 5px 0; padding: 0 3px; font-weight: 700; }
                .kpl-rcm-card .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; }
                .kpl-rcm-card .chips .chip { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: #f5f6f8; }
                .kpl-rcm-card .chips .chip.up { color: #e03131; }
                .kpl-rcm-card .chips .chip.down { color: #2f9e44; }
                .kpl-rcm-card .meta .src { color: #666; }
                .kpl-rcm-followhead { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
                .kpl-rcm-followhead .t { font-size: 14px; font-weight: 700; color: #111; }
                .kpl-rcm-followhead .more { float: right; font-size: 12px; color: #999; cursor: pointer; }
                .kpl-rcm-followhead .avatars { display: flex; gap: 12px; overflow-x: auto; padding-top: 10px; scrollbar-width: none; }
                .kpl-rcm-followhead .avatars::-webkit-scrollbar { display: none; }
                .kpl-rcm-followhead .av { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; flex-shrink: 0; width: 56px; }
                .kpl-rcm-followhead .av img { width: 46px; height: 46px; border-radius: 50%; object-fit: cover; background: #f0f2f5; }
                .kpl-rcm-followhead .av .nm { font-size: 10px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 56px; }
                .kpl-rcm-cols::-webkit-scrollbar { display: none; }
                .kpl-rcm-cols .c { flex-shrink: 0; font-size: 13px; color: #444; padding: 6px 12px; border-radius: 14px; cursor: pointer; white-space: nowrap; }
                .kpl-rcm-cols .c.on { background: #e03131; color: #fff; font-weight: 700; }
                .kpl-rcm-card { display: flex; gap: 10px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 11px 12px; margin-bottom: 8px; cursor: pointer; }
                .kpl-rcm-card .main { flex: 1; min-width: 0; }
                .kpl-rcm-card .tt { font-size: 15px; color: #111; font-weight: 600; line-height: 1.5; }
                .kpl-rcm-card .zy { font-size: 12px; color: #666; line-height: 1.6; margin-top: 4px; }
                .kpl-rcm-card .meta { font-size: 11px; color: #999; margin-top: 6px; display: flex; gap: 12px; }
                .kpl-rcm-card .meta .pay { font-style: normal; color: #f08c00; border: 1px solid #f08c00; border-radius: 3px; padding: 0 4px; font-size: 10px; }
                .kpl-rcm-card .thumb { width: 96px; height: 68px; object-fit: cover; border-radius: 8px; flex-shrink: 0; background: #f5f6f8; }
                .kpl-rcm-cols .c.more { color: #999; background: #f5f6f8; }
                .kpl-rcm-allmask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 30; display: flex; align-items: flex-start; justify-content: center; }
                .kpl-rcm-all { background: #fff; border-radius: 12px; margin-top: 80px; padding: 14px; width: 86%; max-width: 420px; max-height: 70vh; overflow-y: auto; }
                .kpl-rcm-all .t { font-size: 14px; font-weight: 700; color: #111; margin-bottom: 10px; }
                .kpl-rcm-all .grid { display: flex; flex-wrap: wrap; gap: 8px; }
                .kpl-rcm-all .g { font-size: 12px; color: #333; background: #f5f6f8; border-radius: 14px; padding: 6px 14px; cursor: pointer; }
                .kpl-rcm-all .g.on { color: #e03131; background: #fdecec; font-weight: 700; }
                .kpl-col-head { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid #f0f0f0; margin-bottom: 8px; min-height: 86px; background: #fff; }
                .kpl-col-head .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.35; }
                .kpl-col-head .bar { position: relative; padding: 20px 14px 14px; display: flex; align-items: baseline; gap: 10px; }
                .kpl-col-head .bar b { font-size: 20px; color: #111; }
                .kpl-col-head .bar span { font-size: 12px; color: #555; }
                .kpl-col-desc { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; font-size: 12px; color: #666; line-height: 1.7; margin-bottom: 8px; }
                .kpl-rcm-row { display: flex; gap: 10px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 11px 12px; margin-bottom: 8px; cursor: pointer; }
                .kpl-rcm-row .main { flex: 1; min-width: 0; }
                .kpl-rcm-row .tt { font-size: 14px; color: #111; line-height: 1.5; }
                .kpl-rcm-row .meta { font-size: 11px; color: #999; margin-top: 5px; }
                .kpl-rcm-row .meta .stk { color: #1c5fbb; }
                .kpl-rcm-row .meta .tag { font-style: normal; color: #e03131; border: 1px solid #e03131; border-radius: 3px; padding: 0 4px; margin-left: 6px; font-size: 10px; }
                .kpl-rcm-row .thumb { width: 34px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
                .kpl-rcm-more { text-align: center; padding: 12px 0 20px; }
                .kpl-rcm-more button { border: 1px solid #ddd; background: #fff; color: #333; border-radius: 15px; padding: 6px 22px; font-size: 13px; cursor: pointer; }
                .kpl-rcm-more .ld { color: #999; font-size: 12px; }
                .kpl-art-card { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 14px 14px 10px; margin-bottom: 8px; }
                .kpl-art-title { font-size: 19px; color: #111; line-height: 1.45; margin: 0 0 8px; }
                .kpl-art-head { padding: 2px 0 10px; }
                .kpl-art-time { font-size: 12px; color: #999; margin-top: 6px; }
                .kpl-art-decl { background: #f7f7f7; border-radius: 6px; padding: 8px 10px; font-size: 12px; color: #888; line-height: 1.7; margin-bottom: 10px; }
                .kpl-art-decl b { color: #666; }
                .kpl-art-meta { display: flex; gap: 12px; font-size: 12px; color: #999; padding-bottom: 10px; border-bottom: 1px solid #f5f5f5; }
                .kpl-art-zy { background: #f7f9fc; border-left: 3px solid #1c6ef2; border-radius: 6px; padding: 9px 11px; font-size: 13px; color: #444; line-height: 1.7; margin-bottom: 8px; }
                .kpl-art-body { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 12px 14px; font-size: 15px; color: #222; line-height: 1.85; word-break: break-word; }
                .kpl-art-body p { margin: 0 0 12px; }
                .kpl-art-body img { max-width: 100% !important; height: auto !important; border-radius: 6px; }
                .kpl-art-body iframe { width: 100% !important; max-width: 100%; border: none; border-radius: 8px; min-height: 200px; }
                .kpl-art-body strong { color: #111; }
                .kpl-art-stks { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; margin-top: 8px; }
                .kpl-art-stks .t { font-size: 13px; font-weight: 700; color: #111; margin-bottom: 7px; }
                .kpl-art-stks .stk { display: inline-block; font-size: 12px; color: #1c5fbb; background: #eef4fb; border-radius: 6px; padding: 4px 10px; margin: 0 8px 6px 0; cursor: pointer; }
                .kpl-art-tip { text-align: center; font-size: 11px; color: #bbb; padding: 14px 0 20px; }
                .kpl-art-deg { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 12px 14px; }
                .kpl-art-deg .zy { font-size: 14px; color: #333; line-height: 1.8; }
                .kpl-art-deg .note { font-size: 12px; color: #999; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eee; }
                .kpl-art-deg .paytip { display: inline-block; font-size: 11px; color: #f08c00; border: 1px solid #f08c00; border-radius: 3px; padding: 1px 6px; margin-top: 8px; }
                /* ==== 情绪页 kpl-mood-*（App MarketMoodFragment 1:1，显式白底） ==== */
                .kpl-mood { display: flex; flex-direction: column; gap: 10px; padding-bottom: 46px; position: relative; }
                .kpl-mood-sec { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
                .kpl-mood-sec.plain { background: transparent; border: none; }
                .kpl-mood-sec .sec-t { font-size: 14px; font-weight: 700; color: #111; border-left: 3px solid #1c6ef2; padding-left: 7px; margin-bottom: 9px; display: flex; align-items: baseline; gap: 7px; }
                .kpl-mood-sec .sec-t .day { color: #1c5fbb; font-size: 13px; font-weight: 600; }
                .kpl-mood-sec .sec-t .cnt { color: #2f9e44; font-size: 12px; font-weight: 600; }
                .kpl-mood-sec .sec-t .more { margin-left: auto; color: #999; font-size: 12px; font-weight: 400; }
                .kpl-mood-sec .note { color: #999; font-size: 11px; margin-top: 7px; }
                .kpl-mood-sec .note.row { display: flex; justify-content: space-between; align-items: center; }
                .kpl-mood-sec .note .sw { color: #999; font-size: 12px; white-space: nowrap; }
                .kpl-mood-sec .note .sw .on { color: #1c5fbb; font-weight: 700; }
                .kpl-mood-sec .note .ovl { float: right; color: #666; }
                .kpl-mood-sec .axis-x { display: flex; justify-content: space-between; color: #bbb; font-size: 10px; margin-top: 3px; }
                .kpl-mood-sec .tip { color: #999; font-weight: 400; font-size: 11px; }
                /* 温度计 */
                .kpl-mood-thermo { display: flex; align-items: center; gap: 14px; padding: 8px 4px; }
                .kpl-mood-thermo .lft { flex: 1; }
                .kpl-mood-thermo .tube { height: 30px; border: 1px solid #e5e5e5; border-radius: 16px; background: linear-gradient(90deg, #b3e04a 0%, #ffe94a 45%, #ffa63e 70%, #d9d9d9 70%); background-size: 100% 100%; position: relative; overflow: hidden; }
                .kpl-mood-thermo .tube .fill { position: absolute; right: 0; top: 0; bottom: 0; background: #d9d9d9; }
                .kpl-mood-thermo .scale { display: flex; justify-content: space-between; color: #999; font-size: 10px; padding: 4px 8px 0; }
                .kpl-mood-thermo .num { text-align: center; min-width: 64px; }
                .kpl-mood-thermo .num b { font-size: 34px; color: #f08c00; font-weight: 800; line-height: 1.1; }
                .kpl-mood-thermo .num .lbl { color: #666; font-size: 13px; }
                /* 涨跌统计 11 档 */
                .kpl-mood-zdbars .row { display: flex; align-items: flex-end; gap: 3px; }
                .kpl-mood-zdbars .col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; }
                .kpl-mood-zdbars .col .v { font-size: 11px; font-weight: 700; }
                .kpl-mood-zdbars .col .v.up { color: #e03131; }
                .kpl-mood-zdbars .col .v.down { color: #2f9e44; }
                .kpl-mood-zdbars .col .v.flat { color: #868e96; }
                .kpl-mood-zdbars .col .bar { width: 70%; max-width: 26px; border-radius: 2px; }
                .kpl-mood-zdbars .col .bar.up { background: #e03131; }
                .kpl-mood-zdbars .col .bar.down { background: #2f9e44; }
                .kpl-mood-zdbars .col .bar.flat { background: #ced4da; }
                .kpl-mood-zdbars .col .lbl { font-size: 10px; color: #666; white-space: nowrap; }
                .kpl-mood-zdbars .sjzt { color: #333; font-size: 14px; margin-bottom: 8px; }
                .kpl-mood-zdbars .sjzt b.up { font-size: 16px; }
                .kpl-mood-zdbars .sjzt b.down { font-size: 16px; }
                .kpl-mood-zdbars .ratio { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin-top: 10px; gap: 6px; }
                .kpl-mood-zdbars .ratio .red { background: #e03131; }
                .kpl-mood-zdbars .ratio .green { background: #2f9e44; }
                .kpl-mood-zdbars .ratio .mid { width: 26px; background: #dee2e6; clip-path: polygon(0 0, 100% 0, 78% 100%, 22% 100%); }
                .kpl-mood-zdbars .rn { display: flex; justify-content: space-between; font-size: 15px; font-weight: 700; margin-top: 4px; }
                .kpl-mood-zdbars .rn .up { color: #e03131; }
                .kpl-mood-zdbars .rn .down { color: #2f9e44; }
                .kpl-mood-sjzt-line { color: #333; font-size: 14px; margin-bottom: 6px; }
                /* 量能 */
                .kpl-mood-sec .cap-row1 { font-size: 14px; color: #111; font-weight: 600; }
                .kpl-mood-sec .cap-row1 b { font-weight: 800; }
                .kpl-mood-sec .cap-row2 { font-size: 14px; color: #111; font-weight: 600; margin: 6px 0; }
                .kpl-mood-sec .cap-row2 .dot { display: inline-block; width: 12px; height: 12px; background: #e03131; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
                .kpl-mood-sec .cap-row2 b { color: #e03131; }
                .kpl-mood-sec .cap-lg { display: flex; gap: 16px; align-items: baseline; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
                .kpl-mood-sec .cap-lg .lg.red { color: #e03131; }
                .kpl-mood-sec .cap-lg .lg.red b { color: #111; }
                .kpl-mood-sec .cap-lg .lg.green { color: #2f9e44; }
                .kpl-mood-sec .cap-lg .lg.green b { color: #111; }
                .kpl-mood-sec .cap-lg .rt { margin-left: auto; color: #666; font-weight: 400; }
                .kpl-mood-hi, .kpl-mood-lo { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 3px; margin: 3px 6px 0 0; }
                .kpl-mood-hi { background: #e03131; color: #fff; }
                .kpl-mood-lo { background: #2f9e44; color: #fff; }
                /* 涨停表现 */
                .kpl-mood-three { display: flex; }
                .kpl-mood-three .cell { flex: 1; text-align: center; padding: 4px 0; }
                .kpl-mood-three .cell + .cell { border-left: 1px solid #eee; }
                .kpl-mood-three .lbl { font-size: 13px; color: #333; }
                .kpl-mood-three .vv { font-size: 15px; margin: 3px 0; color: #999; }
                .kpl-mood-three .vv b { font-size: 19px; }
                .kpl-mood-three .vv .old { color: #999; }
                .kpl-mood-three .sub { display: flex; justify-content: center; gap: 18px; color: #999; font-size: 11px; }
                .kpl-mood-ladder { border: 1px solid #eee; border-radius: 6px; margin-top: 10px; overflow: hidden; }
                .kpl-mood-ladder .lr { display: flex; text-align: center; }
                .kpl-mood-ladder .lr > span { flex: 1; padding: 7px 2px; border-left: 1px solid #f0f0f0; font-size: 12px; }
                .kpl-mood-ladder .lr > span:first-child { border-left: none; }
                .kpl-mood-ladder .lr.head { background: #fafafa; color: #666; }
                .kpl-mood-ladder .lr.nums span { font-size: 22px; font-weight: 700; color: #111; }
                .kpl-mood-ladder .lr.rates span { color: #666; }
                .kpl-mood-ladder .lr.rates .g i { font-style: normal; margin-left: 2px; }
                .kpl-mood-rows { margin-top: 4px; }
                .kpl-mood-rows .mrow { display: flex; justify-content: space-between; align-items: center; padding: 13px 2px; border-bottom: 1px solid #f5f5f5; font-size: 14px; color: #111; }
                .kpl-mood-rows .mrow:last-child { border-bottom: none; }
                .kpl-mood-rows .mrow .val b { font-weight: 700; }
                .kpl-mood-rows .mrow .val .g { font-style: normal; color: #999; font-size: 13px; }
                .kpl-mood-rows .mrow .arr { color: #ccc; font-style: normal; margin-left: 8px; }
                /* 播报条 */
                .kpl-mood-broadcast { background: #eef3fb; border-radius: 8px; padding: 10px 12px; color: #333; font-size: 13px; line-height: 1.6; margin-top: 10px; }
                .kpl-mood-broadcast b { color: #111; }
                /* 大幅回撤表 */
                .kpl-mood-wd { display: flex; flex-direction: column; }
                .kpl-mood-wd .wr { display: grid; grid-template-columns: 1.5fr .8fr .9fr 1.3fr; align-items: center; padding: 9px 4px; border-bottom: 1px solid #f5f5f5; }
                .kpl-mood-wd .wr:last-child { border-bottom: none; }
                .kpl-mood-wd .wr.head { color: #999; font-size: 12px; padding: 4px; }
                .kpl-mood-wd .nm b { font-size: 14px; color: #111; display: block; }
                .kpl-mood-wd .nm .cd { font-style: normal; color: #999; font-size: 11px; }
                .kpl-mood-wd .pct, .kpl-mood-wd .dd { font-size: 14px; font-weight: 700; text-align: center; }
                .kpl-mood-wd .hl { background: #e7f1ff; border-radius: 4px; padding: 7px 2px; text-align: center; }
                .kpl-mood-wd .wr.head .hl { background: #e7f1ff; }
                .kpl-mood-wd .plates { text-align: center; font-size: 11px; line-height: 1.5; }
                .kpl-mood-wd .plates span { display: block; color: #1c5fbb; }
                /* 风向标/权重 2×3 卡片 */
                .kpl-mood-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
                .kpl-mood-cards .card { border: 1px solid #eee; border-radius: 8px; text-align: center; padding: 9px 2px; cursor: pointer; }
                .kpl-mood-cards .card .plate { color: #999; font-size: 11px; }
                .kpl-mood-cards .card .nm { color: #1c5fbb; font-size: 13px; font-weight: 600; margin: 3px 0; }
                .kpl-mood-cards .card .pct { font-size: 15px; font-weight: 700; }
                .kpl-mood-cards .card .pct.up { color: #e03131; }
                .kpl-mood-cards .card .pct.down { color: #2f9e44; }
                .kpl-mood-cards .card.big .plate { font-size: 13px; color: #333; }
                .kpl-mood-cards .card.big .leader { font-size: 11px; color: #666; margin-top: 2px; }
                .kpl-mood-cards .card.big .leader b { font-weight: 700; }
                /* 悬浮历史数据条 */
                .kpl-mood-histbar { position: sticky; bottom: 8px; align-self: flex-end; display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid #e5e5e5; border-radius: 18px; box-shadow: 0 2px 10px rgba(0,0,0,.10); padding: 6px 12px; z-index: 5; }
                .kpl-mood-histbar .nav { color: #1c5fbb; font-size: 14px; cursor: pointer; user-select: none; padding: 0 2px; }
                .kpl-mood-histbar .nav.dis { color: #ccc; cursor: default; }
                .kpl-mood-histbar .d { color: #1c5fbb; font-size: 13px; font-weight: 700; }
                .kpl-mood-retry { color: #1c5fbb; cursor: pointer; text-decoration: underline; }
                .kpl-mood-sec .sec-t .filter { color: #1c5fbb; font-size: 12px; font-weight: 600; cursor: pointer; }
                .kpl-mood-sec .sec-t .more.lnk { cursor: pointer; }
                .kpl-mood-capdrop { display: flex; flex-wrap: wrap; gap: 6px; background: #f7f9fc; border: 1px solid #e5e9f2; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
                .kpl-mood-capdrop span { padding: 4px 12px; border-radius: 14px; background: #fff; border: 1px solid #e5e5e5; color: #333; font-size: 12px; cursor: pointer; }
                .kpl-mood-capdrop span.on { background: #e03131; border-color: #e03131; color: #fff; }
                /* 下钻页 kpl-mdd-* */
                .kpl-mdd-head { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
                .kpl-mdd-head .sj { text-align: center; }
                .kpl-mdd-head .sj .lbl { display: block; color: #666; font-size: 12px; }
                .kpl-mdd-head .sj b { font-size: 22px; font-weight: 800; }
                .kpl-mdd-head .sl { color: #ccc; font-size: 16px; }
                .kpl-mdd-head .kpl-mdd-daynav { margin-left: auto; display: flex; align-items: center; gap: 10px; background: #f5f8fd; border: 1px solid #dbe6f5; border-radius: 8px; padding: 6px 10px; }
                .kpl-mdd-daynav .nav { color: #1c5fbb; font-size: 13px; cursor: pointer; user-select: none; }
                .kpl-mdd-daynav .nav.dis { color: #ccc; cursor: default; }
                .kpl-mdd-daynav .d { color: #1c5fbb; font-size: 14px; font-weight: 700; }
                .kpl-mdd-tabs { display: flex; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px 10px 0 0; border-bottom: none; padding: 0 6px; }
                .kpl-mdd-tabs .ttab { position: relative; flex: 1; text-align: center; padding: 11px 2px; font-size: 14px; color: #333; cursor: pointer; border-bottom: 2px solid transparent; }
                .kpl-mdd-tabs .ttab.on { color: #e03131; font-weight: 700; border-bottom-color: #e03131; }
                .kpl-mdd-tabs .ttab .badge { position: relative; top: -8px; margin-left: 2px; font-style: normal; font-size: 10px; color: #fff; background: #e03131; border-radius: 9px; padding: 0 5px; }
                .kpl-lhb-head.zte, .kpl-lhb-row.zte { grid-template-columns: 1.5fr .9fr 1.1fr .9fr; }
                .kpl-lhb-head.wdd, .kpl-lhb-row.wdd { grid-template-columns: 1.5fr .8fr .9fr .8fr; }
                .kpl-lhb-head.wtl, .kpl-lhb-row.wtl { grid-template-columns: 1.5fr .8fr .8fr .9fr; }
                .kpl-lhb-head .hl { background: #e7f1ff; }
                .kpl-lhb-row .hl { background: #e7f1ff; border-radius: 3px; padding: 4px 2px; }
                .kpl-mdd-empty { padding: 26px 12px; text-align: center; color: #999; background: #fff; font-size: 12px; }
                .kpl-lhb-agsum { font-size: 13px; color: #111; margin-bottom: 6px; }
                .kpl-lhb-agsum b { margin-left: 4px; }
                .kpl-lhb-bars { width: 100%; display: block; margin-bottom: 6px; }
                .kpl-lhb-bdstat { display: flex; justify-content: space-between; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 12px 14px; font-size: 13px; color: #333; }
                .kpl-lhb-bdstat b { margin-left: 4px; }
                .kpl-lhb-sdhead { display: flex; gap: 14px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 12px 14px; font-size: 12px; color: #666; flex-wrap: wrap; }
                .kpl-lhb-sdhead b { margin-left: 3px; }
                .kpl-lhb-seatgrp { display: flex; flex-direction: column; gap: 8px; }
                .kpl-lhb-seats { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 8px 12px; }
                .kpl-lhb-seats-t { font-size: 12px; font-weight: 700; padding-bottom: 4px; border-bottom: 1px solid #eee; }
                .kpl-lhb-seats-t.buy { color: #e03131; }
                .kpl-lhb-seats-t.sell { color: #0ca678; }
                .kpl-lhb-seatrow { display: flex; gap: 8px; padding: 7px 0; border-bottom: 1px solid #f7f7f7; font-size: 12px; align-items: center; }
                .kpl-lhb-seatrow:last-child { border-bottom: none; }
                .kpl-lhb-seatrow .px { width: 18px; color: #999; font-size: 11px; }
                .kpl-lhb-seatrow .nm { flex: 1; color: #1c5fbb; }
                .kpl-lhb-seatrow .v { font-weight: 700; }
                .kpl-lhb-seatrow .v.buy { color: #e03131; }
                .kpl-lhb-seatrow .v.sell { color: #0ca678; }
                .kpl-lhb-ontime { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; font-size: 11px; color: #666; line-height: 1.7; }
                .kpl-lhb-sub { display: flex; flex-direction: column; gap: 8px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 6px 10px; }
                .kpl-lhb-yxg { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 4px 10px; }
                .kpl-lhb-yxt { font-size: 13px; font-weight: 700; color: #e03131; padding: 8px 2px 2px; }
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
                .kpl-sent3 { background: #fff; border-radius: 8px; margin: 6px 8px; padding: 14px 12px 10px; }
                .kpl-sent3-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
                .kpl-sent3-head .t { font-size: 17px; font-weight: 800; color: #111; }
                .kpl-sent3-head .more { font-size: 12px; color: #999; cursor: pointer; }
                .kpl-sent3-grid { display: grid; grid-template-columns: repeat(3, 1fr); text-align: center; }
                .kpl-sent3-grid .cell { padding: 2px 0 6px; }
                .kpl-sent3-grid .lbl { font-size: 14px; color: #333; font-weight: 600; margin-bottom: 6px; }
                .kpl-sent3-grid .val b { font-size: 22px; margin-right: 2px; }
                .kpl-sent3-grid .val b.up { color: #e0333a; }
                .kpl-sent3-grid .val b.down { color: #0aa858; }
                .kpl-sent3-grid .val .yest { font-size: 13px; color: #999; }
                .kpl-sent3-grid .lbl2 { display: flex; justify-content: center; gap: 14px; font-size: 11px; color: #999; margin-top: 4px; }
                .kpl-sent3-zd { margin: 10px 0 8px; }
                .kpl-sent3-zd .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; }
                .kpl-sent3-zd .bar .red { background: #e0333a; }
                .kpl-sent3-zd .bar .green { background: #0aa858; }
                .kpl-sent3-zd .cnt { display: flex; justify-content: space-between; font-size: 12px; margin-top: 4px; }
                .kpl-sent3-zd .cnt .up { color: #e0333a; }
                .kpl-sent3-zd .cnt .down { color: #0aa858; }
                .kpl-sent3-ln { border-top: 1px solid #f5f5f5; padding-top: 8px; }
                .kpl-sent3-ln .ln { display: flex; align-items: baseline; gap: 8px; font-size: 13px; color: #333; padding: 3px 0; }
                .kpl-sent3-ln .ln .k { color: #666; width: 84px; flex: none; }
                .kpl-sent3-ln .ln b { color: #e0333a; }
                .kpl-sent3-ln .ln .arr { color: #e0333a; }
                .kpl-sent3-ln .ln .yest { color: #999; margin-left: 6px; }
                .kpl-sent2-thermo { display: flex; align-items: center; gap: 14px; background: #fff; border-radius: 8px; padding: 16px 14px; margin: 6px 8px; }
                .kpl-sent2-thermo .bar { flex: 1; height: 26px; border-radius: 13px; background: linear-gradient(to right, #d9e3f5, #f0f0f0); position: relative; overflow: hidden; }
                .kpl-sent2-thermo .fill { height: 100%; border-radius: 13px; background: linear-gradient(to right, #b7f00d, #f5e642, #f5a623); }
                .kpl-sent2-thermo .num { text-align: center; min-width: 90px; }
                .kpl-sent2-thermo .num b { font-size: 34px; color: #f5a623; }
                .kpl-sent2-thermo .num .lbl { font-size: 12px; color: #666; }
                .kpl-sent2-card { background: #fff; border-radius: 8px; padding: 12px 14px; margin: 6px 8px; }
                .kpl-sent2-card .t { font-size: 15px; font-weight: 800; color: #111; border-left: 4px solid #e0333a; padding-left: 8px; margin-bottom: 10px; }
                .kpl-sent2-card .r { font-size: 14px; color: #333; margin-bottom: 10px; }
                .kpl-sent2-card .r .lab { color: #666; }
                .kpl-sent2-card .r b.up { color: #e0333a; } .kpl-sent2-card .r b.down { color: #0aa858; }
                .kpl-sent2-card .r2 { display: flex; gap: 18px; font-size: 12px; color: #666; margin-top: 8px; }
                .kpl-sent2-card .r3 { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #333; }
                .kpl-sent2-card .r3 b { color: #111; }
                .kpl-sent2-bar { display: flex; height: 26px; border-radius: 4px; overflow: hidden; margin: 8px 0; }
                .kpl-sent2-bar .red { background: #e0333a; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; min-width: 70px; }
                .kpl-sent2-bar .green { background: #0aa858; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; min-width: 70px; }
                .kpl-sent2-card .hrow { display: flex; gap: 14px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; font-size: 13px; color: #333; }
                .kpl-sent2-card .hrow .day { color: #888; width: 84px; }
                .kpl-sent2-card .hrow .strong { color: #f5a623; font-weight: 700; }
                .kpl-sent-ln { font-size: 12px; color: #666; padding: 4px 10px 0; }
                .kpl-active-plates { display: grid; grid-template-columns: repeat(4, 1fr); background: #fff; border-radius: 8px; padding: 14px 4px; margin: 6px 8px; }
                .kpl-active-plate { text-align: center; cursor: pointer; border-right: 1px solid #f0f0f0; padding: 2px 4px; }
                .kpl-active-plate:last-child { border-right: none; }
                .kpl-active-plate:hover { background: #f7f9ff; }
                .kpl-active-plate .n { font-size: 16px; color: #2f6bff; font-weight: 700; }
                .kpl-active-plate .r { font-size: 14px; font-weight: 700; margin-top: 8px; }
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
                .kpl-qd2-idx { display: flex; align-items: baseline; gap: 10px; background: #fff; border-radius: 6px; padding: 10px 14px; margin: 6px 8px; }
                .kpl-qd2-idx .nm { font-size: 14px; font-weight: 800; color: #333; }
                .kpl-qd2-idx b { font-size: 20px; }
                .kpl-qd2-idx b.up { color: #e0333a; } .kpl-qd2-idx b.down { color: #0aa858; }
                .kpl-qd2-idx .chg { font-size: 13px; }
                .kpl-qd2-idx .chg.up { color: #e0333a; } .kpl-qd2-idx .chg.down { color: #0aa858; }
                .kpl-qd2-day { text-align: center; font-size: 12px; color: #999; padding: 10px 0 14px; }
                .kpl-qd2-stat { display: flex; gap: 12px; background: #fff; border-radius: 6px; padding: 10px 14px; margin: 6px 8px; }
                .kpl-qd2-stat .cell { flex: 1; text-align: center; }
                .kpl-qd2-stat .lbl { font-size: 12px; color: #8a8a8a; }
                .kpl-qd2-stat b { font-size: 20px; margin-right: 2px; }
                .kpl-qd2-stat b.up { color: #e0333a; }
                .kpl-qd2-stat b.down { color: #0aa858; }
                .kpl-qd2-stat .yest { font-size: 12px; color: #999; }
                .kpl-qd2-head, .kpl-qd2-row { display: grid; grid-template-columns: 34px 1.2fr 64px 76px 1fr; gap: 6px; align-items: center; padding: 10px 10px; }
                .kpl-qd2-head { color: #999; font-size: 12px; border-bottom: 1px solid #f0f0f0; }
                .kpl-qd2-row { border-bottom: 1px solid #f0f0f0; cursor: pointer; background: #fff; }
                .kpl-qd2-row .rk { color: #999; font-weight: 700; }
                .kpl-qd2-row .nm { font-weight: 800; font-size: 14px; color: #111; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-qd2-row .nm .cd { display: flex; gap: 5px; align-items: center; font-size: 11px; font-weight: 400; color: #8a8a8a; margin-top: 2px; }
                .kpl-qd2-row .nm .cd .tm { font-style: normal; color: #d97706; border: 1px solid #f59e0b; border-radius: 4px; padding: 0 4px; font-size: 10px; }
                .kpl-qd2-row .st { color: #e0333a; text-align: right; background: #f3f7fd; align-self: stretch; display: flex; align-items: center; justify-content: flex-end; padding: 0 6px; }
                .kpl-qd2-row .pl { font-size: 12px; color: #2f6bff; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-qd2-row .pl .pl-item { display: block; color: #e0333a; line-height: 1.5; }
                .kpl-qd2-row:hover { background: #f7f9ff; }
                /* ---- 严重异动提醒（App 同款 4 列表格，显式白底） ---- */
                .kpl-yd2 { background: #fff; padding: 0 12px; }
                .kpl-yd2-row { display: grid; grid-template-columns: 1.5fr 1fr 1fr 1.2fr; align-items: center; padding: 9px 0; border-bottom: 1px solid #f5f5f5; cursor: pointer; }
                .kpl-yd2-row:last-child { border-bottom: none; }
                .kpl-yd2-row .c { text-align: center; }
                .kpl-yd2-row .c.nm { text-align: left; font-size: 15px; color: #111; font-weight: 600; }
                .kpl-yd2-row .c.v b { display: block; font-size: 16px; color: #111; font-weight: 700; }
                .kpl-yd2-row .c.v span { display: block; font-size: 12px; color: #999; margin-top: 2px; }
                .kpl-yd2-row .c.v.org b { color: #f08c00; }
                .kpl-yd2-row .c.v .rl { color: #999; }
                .kpl-yd2-links { background: #fff; padding: 0 12px; }
                .kpl-yd2-links .ln { padding: 13px 0; font-size: 15px; color: #111; cursor: pointer; }
                .kpl-yd2-row .nm { font-size: 14px; font-weight: 800; color: #111; }
                .kpl-yd2-row .cd { font-size: 11px; color: #8a8a8a; margin-top: 2px; display: flex; gap: 5px; align-items: center; }
                .kpl-yd2-row .cd i { font-style: normal; background: rgba(245,158,11,.14); color: #b45309; border-radius: 3px; padding: 0 4px; }
                .kpl-yd2-row .c2, .kpl-yd2-row .c3, .kpl-yd2-row .c4 { text-align: right; line-height: 1.4; }
                .kpl-yd2-row .c2 b, .kpl-yd2-row .c3 b, .kpl-yd2-row .c4 b { display: block; font-size: 14px; }
                .kpl-yd2-row .c2 span, .kpl-yd2-row .c3 span, .kpl-yd2-row .c4 span { display: block; font-size: 11px; color: #999; }
                .kpl-yd2-row b.up { color: #e0333a; } .kpl-yd2-row b.down { color: #0aa858; }
                .kpl-yd2-row .org { color: #f59e0b; }
                /* ===== 通达信 Tab（自选分组直读；显式色值，勿用 dsw 变量） ===== */
                .kpl-tdx-wrap { display: flex; flex-direction: column; gap: 8px; }
                .kpl-tdx-head { display: flex; justify-content: space-between; align-items: baseline; }
                .kpl-tdx-head b { font-size: 13px; color: #111; }
                .kpl-tdx-head .sync { font-size: 10px; color: #999; }
                .kpl-tdx-chips { display: flex; gap: 6px; flex-wrap: wrap; }
                .kpl-tdx-chip { padding: 3px 10px; border-radius: 12px; background: #f0f0f0; color: #666; font-size: 11px; cursor: pointer; border: 1px solid transparent; white-space: nowrap; }
                .kpl-tdx-chip:hover { background: #e5e5e5; }
                .kpl-tdx-chip.on { background: #e0333a; color: #fff; font-weight: 600; }
                .kpl-tdx-aliasrow { display: flex; align-items: center; gap: 6px; padding: 4px 2px; }
                .kpl-tdx-aliasrow .lab { font-size: 11px; color: #999; white-space: nowrap; }
                .kpl-tdx-aliasrow input { flex: 1; min-width: 0; font-size: 11px; padding: 3px 8px; border: 1px solid #e0e0e0; border-radius: 8px; outline: none; background: #fff; color: #111; }
                .kpl-tdx-aliasrow input:focus { border-color: #e0333a; }
                .kpl-tdx-aliasrow .msg { font-size: 10px; color: #0aa858; white-space: nowrap; }
                .kpl-tdx-toggle { font-size: 10px; color: #666; background: #f7f7f7; border: 1px solid #e8e8e8; border-radius: 10px; padding: 2px 8px; cursor: pointer; white-space: nowrap; user-select: none; }
                .kpl-tdx-toggle:hover { background: #efefef; color: #111; }
                .kpl-tdx-rows { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; overflow: hidden; }
                .kpl-tdx-row { display: flex; align-items: center; padding: 8px 12px; border-bottom: 1px solid #f5f5f5; cursor: pointer; }
                .kpl-tdx-row:last-child { border-bottom: none; }
                .kpl-tdx-row:hover { background: #fafafa; }
                .kpl-tdx-row .nm { flex: 1; font-weight: 600; color: #111; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-tdx-row .cd { color: #999; font-size: 11px; margin-right: 10px; font-variant-numeric: tabular-nums; }
                .kpl-tdx-row .px { width: 72px; text-align: right; color: #111; font-size: 13px; font-variant-numeric: tabular-nums; }
                .kpl-tdx-row .pc { width: 78px; text-align: right; font-weight: 600; font-size: 13px; font-variant-numeric: tabular-nums; }
                .kpl-tdx-row .pc.up { color: #e0333a; }
                .kpl-tdx-row .pc.down { color: #0aa858; }
                .kpl-tdx-note { font-size: 10px; color: #999; line-height: 1.6; }
                .kpl-tdx-empty { padding: 24px 16px; text-align: center; color: #999; background: #fff; border: 1px dashed #e0e0e0; border-radius: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
                .kpl-tdx-head-r { display: flex; align-items: center; gap: 8px; }
                .kpl-tdx-tag { font-size: 10px; color: #e0333a; background: #fdeeee; border-radius: 8px; padding: 1px 8px; white-space: nowrap; }
                .kpl-tdx-btn { font-size: 10px; color: #e0333a; background: #fff; border: 1px solid #f0c8ca; border-radius: 10px; padding: 2px 10px; cursor: pointer; }
                .kpl-tdx-btn:hover { background: #fdeeee; }
                .kpl-tdx-btn:disabled { color: #bbb; border-color: #eee; background: #fafafa; cursor: default; }
                .kpl-tdx-posrow { display: grid; grid-template-columns: minmax(0, 1fr) 54px 62px 62px 54px 54px 74px 76px 62px; gap: 4px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #f5f5f5; cursor: pointer; font-size: 12px; }
                .kpl-tdx-posrow:last-child { border-bottom: none; }
                .kpl-tdx-posrow:hover { background: #fafafa; }
                .kpl-tdx-posrow .nm { font-weight: 600; color: #111; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .kpl-tdx-posrow .cd { color: #999; font-size: 11px; font-variant-numeric: tabular-nums; }
                .kpl-tdx-posrow .v { text-align: right; color: #111; font-variant-numeric: tabular-nums; white-space: nowrap; }
                .kpl-tdx-posrow .v.dim { color: #999; font-size: 11px; }
                .kpl-tdx-posrow .v.b { font-weight: 600; }
                .kpl-tdx-posrow .v.up { color: #e0333a; }
                .kpl-tdx-posrow .v.down { color: #0aa858; }
                .kpl-tdx-posrow.h { cursor: default; background: #fafafa; border-bottom: 1px solid #f0f0f0; }
                .kpl-tdx-posrow.h .nm, .kpl-tdx-posrow.h .cd, .kpl-tdx-posrow.h .v { color: #999; font-weight: 400; font-size: 10px; }
                .kpl-tdx-posrow.sum { cursor: default; background: #fffdf5; }
                .kpl-tdx-posrow.sum .nm { color: #333; }
                /* ---- 严重异动提醒块补齐（yd8 实拍：列头行 + 蓝色「次日评估」+ 概念 tag 橙底白字） ---- */
                .kpl-yd2-eval { font-size: 14px; color: #3b82f6; font-weight: 600; margin-left: 2px; }
                .kpl-yd2-hd { display: grid; grid-template-columns: 1.5fr 1fr 1fr 1.2fr; background: #fff; padding: 10px 12px 2px; }
                .kpl-yd2-hd span { font-size: 11px; color: #999; text-align: center; line-height: 1.3; }
                .kpl-yd2-hd span:first-child { text-align: left; }
                .kpl-yd2 .nm2 { font-size: 15px; font-weight: 700; color: #111; }
                .kpl-yd2 .cd i { font-style: normal; background: #f59e0b; color: #fff; border-radius: 3px; padding: 0 4px; font-size: 10px; }
                .kpl-yd2-links .ln.has-arr { display: flex; align-items: center; justify-content: space-between; }
                .kpl-yd2-links .ln .ar { font-style: normal; color: #bbb; font-size: 16px; }
                /* ---- 多次异动个股页（yd16 实拍：双 tab + 分组分节表） ---- */
                .kpl-ydm-tabs { display: flex; background: #fff; border-bottom: 1px solid #f0f0f0; }
                .kpl-ydm-tab { flex: 1; text-align: center; font-size: 16px; color: #333; padding: 13px 0 11px; cursor: pointer; position: relative; }
                .kpl-ydm-tab.on { color: #e0333a; font-weight: 700; }
                .kpl-ydm-tab.on::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%); bottom: 0; width: 56px; height: 3px; background: #e0333a; border-radius: 2px; }
                .kpl-ydm { background: #fff; margin-top: 8px; }
                .kpl-ydm .sec-t { display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 700; color: #111; padding: 12px 12px 4px; }
                .kpl-ydm .sec-t .bar { width: 4px; height: 16px; background: #3b82f6; border-radius: 2px; }
                .kpl-ydm .hd { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; padding: 8px 12px; border-bottom: 1px solid #f5f5f5; }
                .kpl-ydm .hd span { font-size: 12px; color: #999; text-align: center; line-height: 1.3; }
                .kpl-ydm .hd span.c1 { text-align: left; }
                .kpl-ydm .row { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; align-items: center; padding: 10px 12px; border-bottom: 1px solid #f7f7f7; cursor: pointer; }
                .kpl-ydm .row:last-child { border-bottom: none; }
                .kpl-ydm .row .c1 b { display: block; font-size: 16px; color: #111; }
                .kpl-ydm .row .c1 .cd { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #999; margin-top: 3px; }
                .kpl-ydm .row .c1 .cd .dn { font-style: normal; background: #f59e0b; color: #fff; border-radius: 3px; padding: 0 4px; font-size: 10px; }
                .kpl-ydm .row .c2, .kpl-ydm .row .c3, .kpl-ydm .row .c4 { text-align: center; line-height: 1.4; }
                .kpl-ydm .row .c2 b, .kpl-ydm .row .c3 b, .kpl-ydm .row .c4 b { display: block; font-size: 17px; font-weight: 700; }
                .kpl-ydm .row .c2 span, .kpl-ydm .row .c3 span, .kpl-ydm .row .c4 span { display: block; font-size: 12px; margin-top: 2px; }
                .kpl-ydm .row b.up, .kpl-ydm .row span.up { color: #e0333a; }
                .kpl-ydm .row b.down, .kpl-ydm .row span.down { color: #0aa858; }
                /* ---- 异动提醒页（AbnormalAlertActivity 1:1） ---- */
                .kpl-yda-q { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1.5px solid rgba(255,255,255,.9); border-radius: 50%; color: #fff; font-size: 12px; margin-right: 8px; cursor: help; }
                .kpl-yda-datenav { display: flex; align-items: center; justify-content: space-between; background: #fff; padding: 8px 12px; border-bottom: 1px solid #f5f5f5; }
                .kpl-yda-datenav .idx b { display: block; font-size: 17px; }
                .kpl-yda-datenav .idx span { font-size: 11px; color: #999; }
                .kpl-yda-datenav .nav { display: flex; align-items: center; gap: 8px; }
                .kpl-yda-datenav .nav .ar { font-style: normal; color: #e0333a; font-size: 13px; cursor: pointer; padding: 4px 6px; }
                .kpl-yda-datenav .nav .ar.dis { color: #ccc; cursor: default; }
                .kpl-yda-datenav .nav .dt { font-size: 16px; color: #2f6bff; border: 1px solid #e5e5e5; border-radius: 6px; padding: 4px 12px; font-weight: 600; }
                .kpl-yda-datenav .warn { display: flex; align-items: center; gap: 6px; font-size: 15px; color: #111; }
                .kpl-yda-datenav .warn .tg { width: 40px; height: 22px; border-radius: 999px; background: #ddd; position: relative; cursor: pointer; transition: background .15s; }
                .kpl-yda-datenav .warn .tg.on { background: #e0333a; }
                .kpl-yda-datenav .warn .tg::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left .15s; }
                .kpl-yda-datenav .warn .tg.on::after { left: 20px; }
                .kpl-yda-tabs { display: flex; background: #fff; border-bottom: 1px solid #f0f0f0; position: sticky; top: 0; z-index: 5; }
                .kpl-yda-tab { flex: 1; text-align: center; font-size: 16px; color: #666; padding: 13px 0 11px; cursor: pointer; position: relative; }
                .kpl-yda-tab.on { color: #111; font-weight: 700; }
                .kpl-yda-tab.on::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%); bottom: 0; width: 40px; height: 3px; background: #e0333a; border-radius: 2px; }
                .kpl-yda-sec { background: #fff; margin-top: 8px; padding-bottom: 4px; }
                .kpl-yda-sec .sec-t { display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 700; color: #111; padding: 12px 12px 4px; }
                .kpl-yda-sec .sec-t .bar { width: 4px; height: 16px; background: #3b82f6; border-radius: 2px; }
                .kpl-yda-pills { display: flex; gap: 8px; padding: 8px 12px; }
                .kpl-yda-pills .pill { font-size: 14px; color: #333; border: 1px solid #e5e5e5; border-radius: 6px; padding: 6px 18px; cursor: pointer; }
                .kpl-yda-pills .pill.on { color: #e0333a; border-color: #e0333a; }
                .kpl-yda-sec .hd { display: grid; grid-template-columns: 1.5fr 1fr 1.2fr 1.1fr; padding: 8px 12px; border-bottom: 1px solid #f5f5f5; }
                .kpl-yda-sec .hd span { font-size: 12px; color: #999; text-align: center; line-height: 1.3; }
                .kpl-yda-sec .hd span.c1 { text-align: left; }
                .kpl-yda-sec .hd span.dt2 { font-size: 11px; }
                .kpl-yda-row { display: grid; grid-template-columns: 1.5fr 1fr 1.2fr 1.1fr; align-items: center; padding: 10px 12px; border-bottom: 1px solid #f7f7f7; cursor: pointer; }
                .kpl-yda-row:last-child { border-bottom: none; }
                .kpl-yda-row.trig { background: #fdf4f4; }
                .kpl-yda-row .nm2 { font-size: 16px; font-weight: 700; color: #111; }
                .kpl-yda-row .cd { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #999; margin-top: 3px; }
                .kpl-yda-row .cd .otag { font-style: normal; background: #fff; color: #f59e0b; border: 1px solid #f59e0b; border-radius: 3px; padding: 0 4px; font-size: 10px; }
                .kpl-yda-row .c.v { text-align: center; line-height: 1.4; }
                .kpl-yda-row .c.v.dt b { font-size: 15px; }
                .kpl-yda-row .c.v b { display: block; font-size: 16px; font-weight: 700; color: #111; }
                .kpl-yda-row .c.v span { display: block; font-size: 11px; color: #999; margin-top: 2px; }
                .kpl-yda-row .c.v b.org { color: #f59e0b; }
                .kpl-yda-row .c.v b.red { color: #e0333a; }
                .kpl-yda-row .c.v b.up, .kpl-yda-row .c.v span.up { color: #e0333a; }
                .kpl-yda-row .c.v b.down, .kpl-yda-row .c.v span.down { color: #0aa858; }
                .kpl-yda-row .c.v span.blue { color: #2f6bff; }
                .kpl-yda-ov { background: #fff; margin-top: 10px; padding: 10px 12px 14px; }
                .kpl-yda-energy { display: flex; align-items: center; gap: 10px; padding: 12px 0 4px; font-size: 15px; }
                .kpl-yda-energy .lb { color: #999; }
                .kpl-yda-energy b { color: #e0333a; font-weight: 700; }
                .kpl-yda-zd { display: grid; grid-template-columns: repeat(4, 1fr); background: #f7f7f7; border-radius: 8px; padding: 10px 0; margin-top: 8px; }
                .kpl-yda-zd .cell { text-align: center; }
                .kpl-yda-zd .cell span { display: block; font-size: 12px; color: #666; margin-bottom: 4px; }
                .kpl-yda-zd .cell b { font-size: 17px; font-weight: 700; }
                .kpl-yda-zd .cell b.up { color: #e0333a; }
                .kpl-yda-zd .cell b.down { color: #0aa858; }
                .kpl-tika2-child { padding: 6px 12px 6px 44px; font-size: 13px; color: #3b82f6; border-left: 2px solid var(--dsw-alias-border-l2); margin: 2px 0 2px 26px; cursor: pointer; }
                .kpl-fx-cards { display: flex; gap: 8px; padding: 2px 8px 8px; }
                .kpl-fx-card { flex: 1; background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; padding: 12px 8px; text-align: center; cursor: pointer; }
                .kpl-fx-card:hover { border-color: #e0333a; }
                .kpl-fx-card .plate { font-size: 12px; color: #8a8a8a; margin-bottom: 6px; }
                .kpl-fx-card .sname { font-size: 15px; font-weight: 800; color: #2f6bff; margin-bottom: 4px; }
                .kpl-fx-card .srate { font-size: 14px; font-weight: 800; }
                .kpl-fx-card .srate.up { color: #e0333a; }
                .kpl-fx-card .srate.down { color: #0aa858; }
                /* 市场风口（散布 pill + 下钻页） */
                .kpl-fk-scatter { position: relative; height: 150px; background: #fff; border-radius: 8px; margin: 4px 8px 8px; overflow: hidden; }
                .kpl-fk-pill { position: absolute; color: #fff; border-radius: 999px; padding: 7px 16px; font-size: 14px; font-weight: 700; cursor: pointer; }
                .kpl-fk-pill.red { background: #e0333a; }
                .kpl-fk-pill.green { background: #0aa858; }
                .kpl-fk-pill:hover { opacity: .85; }
                .kpl-fk-tip { background: #fdf6e3; color: #7c5e00; font-size: 12px; line-height: 1.6; padding: 10px 12px; margin: 6px 8px; border-radius: 6px; }
                .kpl-tabs2-row { display: flex; background: #fff; margin: 6px 8px 0; border-radius: 6px 6px 0 0; }
                .kpl-tabs2-item { flex: 1; text-align: center; font-size: 15px; color: #333; padding: 12px 0; cursor: pointer; border-bottom: 2px solid transparent; }
                .kpl-tabs2-item.on { color: #e0333a; font-weight: 700; border-bottom-color: #e0333a; }
                .kpl-fk-head { display: grid; grid-template-columns: 1.1fr 70px 90px 1fr; gap: 6px; padding: 10px 10px; font-size: 12px; color: #999; border-bottom: 1px solid #f0f0f0; }
                .kpl-fk-head .st { text-align: right; background: #eef4fd; padding: 2px 6px; }
                .kpl-fk-row { display: grid; grid-template-columns: 1.1fr 70px 90px 1fr; gap: 6px; align-items: center; padding: 10px; border-bottom: 1px solid #f0f0f0; cursor: pointer; background: #fff; }
                .kpl-fk-row:hover { background: #f7f9ff; }
                .kpl-fk-row .nm { font-weight: 700; font-size: 14px; color: #111; }
                .kpl-fk-row .nm .cd { display: flex; gap: 5px; align-items: center; font-size: 11px; font-weight: 400; color: #8a8a8a; margin-top: 2px; }
                .kpl-fk-row .nm .cd .tm { font-style: normal; color: #d97706; border: 1px solid #f59e0b; border-radius: 4px; padding: 0 4px; font-size: 10px; }
                .kpl-fk-row .rt { text-align: right; }
                .kpl-fk-row .rt.up { color: #e0333a; } .kpl-fk-row .rt.down { color: #0aa858; }
                .kpl-fk-row .st { text-align: right; color: #e0333a; font-weight: 700; background: #f3f7fd; align-self: stretch; display: flex; align-items: center; justify-content: flex-end; padding: 0 6px; }
                .kpl-fk-row .pl { font-size: 12px; color: #2f6bff; text-align: right; }
                .kpl-sd-arrow { background: #fff; border: 1px solid #e5e5e5; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; color: #666; }
                .kpl-sd-arrow:hover { border-color: #e0333a; color: #e0333a; }
                .kpl-sd-date { border: 1px solid #d8d8d8; border-radius: 6px; padding: 6px 10px; font-size: 14px; color: #333; background: #fff; }
                .kpl-sd-summary { display: flex; gap: 10px; background: #fff; border-radius: 6px; padding: 12px 10px; margin: 6px 8px; }
                .kpl-sd-summary .cell { flex: 1; text-align: center; }
                .kpl-sd-summary .lbl { font-size: 12px; color: #8a8a8a; margin-bottom: 4px; }
                .kpl-sd-summary b { font-size: 17px; }
                .kpl-sd-summary b.up { color: #e0333a; }
                .kpl-sd-summary b.down { color: #0aa858; }
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





