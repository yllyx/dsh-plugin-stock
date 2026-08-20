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

        // ============= 后端状态卡片 =============
        function BackendStatus({ status, onRetry }) {
            const { state, error, retrying } = status;
            if (state === "running") return null;

            const config = {
                starting: { icon: "⏳", title: "正在启动后端", tone: "info", showRetry: false },
                failed: { icon: "❌", title: "后端启动失败", tone: "error", showRetry: true },
                stopped: { icon: "⹂", title: "后端未运行", tone: "warn", showRetry: true },
            }[state] || { icon: "❓", title: state, tone: "warn", showRetry: true };

            return React.createElement("div", { className: `dsh-stock-backend ${config.tone}` },
                React.createElement("div", { className: "dsh-stock-backend-title" },
                    React.createElement("span", null, config.icon + " " + config.title)
                ),
                error && React.createElement("div", { className: "dsh-stock-backend-error" }, error),
                config.showRetry && React.createElement("button", {
                    className: "dsh-stock-btn",
                    disabled: retrying,
                    onClick: onRetry,
                }, retrying ? "启动中..." : "🔄 重启后端"),
                React.createElement("div", { className: "dsh-stock-backend-hint" },
                    "首次启动可能需要 1-2 分钟（下载并安装 Python 依赖）。")
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
                            "trailing：盈利>5%后保本+高点回撤触发；ladder：+20%卖1/3、+50%再卖1/3"))),
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
                                    React.createElement("span", null, `${STOP_MODE_LABEL[h.stop_mode] || h.stop_mode}${h.industry ? ` · ${h.industry}` : ""}`),
                                    React.createElement("span", { className: "dsh-stock-holding-advice" }, h.advice)),
                                React.createElement("div", { className: "dsh-stock-holding-ops" },
                                    React.createElement("select", {
                                        className: "dsh-stock-select",
                                        value: h.stop_mode || "fixed",
                                        onChange: (e) => changeMode(h.code, e.target.value),
                                    }, Object.entries(STOP_MODE_LABEL).map(([v, l]) =>
                                        React.createElement("option", { key: v, value: v }, l))),
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

        // ============= Tab 7: 系统 =============
        const PROBE_STATUS = { ok: "✓ 可用", no_data: "⊘ 无数据", timeout: "✗ 超时" };

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
                try { setStatus(await api("/api/system/status")); } catch (e) { setError(e.message); }
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

        // ============= 主面板 =============
        const TABS = [
            { id: "timing", label: "⏱ 择时" },
            { id: "sentiment", label: "🔥 情绪风格" },
            { id: "sector", label: "🧩 板块" },
            { id: "position", label: "💼 持仓仓位" },
            { id: "alert", label: "⚠️ 预警" },
            { id: "screen", label: "🔍 选股" },
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

            async function handleRetry() {
                setBackendStatus((s) => ({ ...s, retrying: true }));
                if (window.__DSH_STOCK_RESTART__) {
                    try { await window.__DSH_STOCK_RESTART__(); }
                    catch (e) {
                        setBackendStatus({ state: "failed", error: e.message, retrying: false });
                        return;
                    }
                }
                setTimeout(() => setBackendStatus((s) => ({ ...s, retrying: false })), 5000);
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
                system: React.createElement(SystemTab),
            }[tab];

            return React.createElement("div", { className: "dsh-stock-panel" },
                React.createElement("div", { className: "dsh-stock-header" },
                    React.createElement("span", null, "📈 股票监控"),
                    React.createElement("span", { className: `dsh-stock-status ${connected ? "ok" : "off"}` },
                        backendOk ? (connected ? "● 实时" : "○ 连接中") : "○ 后端未启动")),
                !backendOk && React.createElement(BackendStatus, { status: backendStatus, onRetry: handleRetry }),
                backendOk && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "dsh-stock-tabs" },
                        TABS.map((t) =>
                            React.createElement("button", {
                                key: t.id,
                                className: `dsh-stock-tab ${tab === t.id ? "active" : ""}`,
                                onClick: () => setTab(t.id),
                            }, t.label))),
                    React.createElement("div", { className: "dsh-stock-tab-content" }, tabContent)),
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
                .dsh-stock-backend { padding: 16px; border-radius: 8px; margin-bottom: 12px; background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); }
                .dsh-stock-backend.error { border-color: #ef4444; }
                .dsh-stock-backend.warn { border-color: #f59e0b; }
                .dsh-stock-backend-title { font-weight: 600; margin-bottom: 8px; }
                .dsh-stock-backend-error { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; word-break: break-all; }
                .dsh-stock-backend-hint { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
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
