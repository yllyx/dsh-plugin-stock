/**
 * DSH 股票监控插件 - Client 端
 *
 * 功能：
 * - Sidebar 自选股面板（实时 WebSocket 推送）
 * - 后端状态显示 + 启动失败时一键重启
 * - 大盘指数快览
 * - 持仓止盈止损预警
 * - 拖拽排序（localStorage 持久化）
 * - 点击股票打开 K线详情（动态加载 klinecharts）
 *
 * 严格只读监控，所有交易由用户手动执行。
 */

const PLUGIN_API_BASE = "http://127.0.0.1:8765";
const STORAGE_KEY = "dsh-plugin-stock:order";
const KLINECHART_CDN = "https://cdn.jsdelivr.net/npm/klinecharts@9.8.5/dist/klinecharts.min.js";

window.__ModuleLoader__.load({
    id: "dsh-plugin-stock",
    factory: (require) => {
        const React = require("react");
        const { useState, useEffect, useRef } = React;

        const formatNum = (n, d = 2) => (n == null ? "-" : Number(n).toFixed(d));
        const formatPct = (n) => (n == null ? "-" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`);
        const formatTime = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

        function loadOrder() {
            try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
            catch { return []; }
        }
        function saveOrder(codes) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(codes));
        }
        function applyOrder(stocks, order) {
            if (!order.length) return stocks;
            const map = new Map(stocks.map((s) => [s.code, s]));
            const sorted = order.map((c) => map.get(c)).filter(Boolean);
            const remaining = stocks.filter((s) => !order.includes(s.code));
            return [...sorted, ...remaining];
        }

        let klineLoading = null;
        function loadKlineChart() {
            if (window.klinecharts) return Promise.resolve(window.klinecharts);
            if (klineLoading) return klineLoading;
            klineLoading = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = KLINECHART_CDN;
                script.onload = () => resolve(window.klinecharts);
                script.onerror = () => reject(new Error("加载 K线库失败"));
                document.head.appendChild(script);
            });
            return klineLoading;
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
                        const resp = await fetch(`${PLUGIN_API_BASE}/api/kline/${code}?category=${period}&count=500`);
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const data = (await resp.json()).data || [];
                        if (cancelled) return;
                        const candles = data.map((d) => ({
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
            if (state === "running") return null; // 正常时不显示

            const config = {
                starting: { icon: "⏳", title: "正在启动后端", tone: "info", showRetry: false },
                failed: { icon: "❌", title: "后端启动失败", tone: "error", showRetry: true },
                stopped: { icon: "⏹️", title: "后端未运行", tone: "warn", showRetry: true },
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

        // ============= 拖拽手柄 =============
        function DraggableRow({ stock, idx, onDragStart, onDragOver, onDrop, onClick }) {
            return React.createElement("div", {
                draggable: true,
                className: `dsh-stock-row ${stock.change_pct >= 0 ? "up" : "down"}`,
                onDragStart: (e) => onDragStart(e, idx),
                onDragOver: (e) => onDragOver(e, idx),
                onDrop: (e) => onDrop(e, idx),
                onClick: () => onClick(stock),
            },
                React.createElement("span", { className: "drag-handle" }, "⋮"),
                React.createElement("span", { className: "name" }, stock.name),
                React.createElement("span", { className: "price" }, formatNum(stock.price)),
                React.createElement("span", { className: "pct" }, formatPct(stock.change_pct)),
                stock.buy_price && React.createElement("span", { className: "profit" },
                    formatPct((stock.price - stock.buy_price) / stock.buy_price * 100))
            );
        }

        // ============= 主面板 =============
        function WatchlistPanel(props) {
            const [stocks, setStocks] = useState([]);
            const [indices, setIndices] = useState(null);
            const [alerts, setAlerts] = useState([]);
            const [loading, setLoading] = useState(true);
            const [connected, setConnected] = useState(false);
            const [selectedStock, setSelectedStock] = useState(null);
            const [dragSrc, setDragSrc] = useState(null);
            const [backendStatus, setBackendStatus] = useState({ state: "starting", error: null, retrying: false });
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
                            const data = await resp.json();
                            setBackendStatus({ state: "running", error: null, retrying: false });
                            // 后端就绪后加载数据
                            if (data.holdings_count !== undefined) loadAll();
                        } else {
                            setBackendStatus({ state: "failed", error: `HTTP ${resp.status}`, retrying: false });
                        }
                    } catch (e) {
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

            async function loadAll() {
                try {
                    const [holdingsResp, indicesResp] = await Promise.all([
                        fetch(`${PLUGIN_API_BASE}/api/holdings`),
                        fetch(`${PLUGIN_API_BASE}/api/index-quotes`),
                    ]);
                    if (!holdingsResp.ok || !indicesResp.ok) return;
                    const holdings = (await holdingsResp.json()).holdings || {};
                    const indicesData = await indicesResp.json();
                    setIndices(indicesData.indices || {});
                    const codes = Object.keys(holdings);
                    let merged = [];
                    if (codes.length) {
                        const quotesResp = await fetch(`${PLUGIN_API_BASE}/api/quotes`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(codes),
                        });
                        const quotes = (await quotesResp.json()).quotes || [];
                        merged = quotes.map((q) => ({
                            ...q,
                            buy_price: holdings[q.code]?.buy_price,
                            shares: holdings[q.code]?.shares,
                            stop_loss_pct: holdings[q.code]?.stop_loss_pct ?? -7,
                            take_profit_pct: holdings[q.code]?.take_profit_pct ?? 15,
                        }));
                    }
                    merged = applyOrder(merged, loadOrder());
                    setStocks(merged);
                    setLoading(false);
                } catch (e) {
                    console.error("[dsh-plugin-stock]", e);
                    setLoading(false);
                }
            }

            // WebSocket（仅后端运行时）
            useEffect(() => {
                if (backendStatus.state !== "running") return;
                const ws = new WebSocket(PLUGIN_API_BASE.replace("http", "ws") + "/ws");
                sockRef.current = ws;
                ws.onopen = () => setConnected(true);
                ws.onmessage = (e) => {
                    try {
                        const msg = JSON.parse(e.data);
                        if (msg.type === "quotes") {
                            setStocks((prev) => prev.map((s) => {
                                const u = msg.data.find((q) => q.code === s.code);
                                return u ? { ...s, ...u } : s;
                            }));
                        } else if (msg.type === "alert") {
                            setAlerts((prev) => [msg.data, ...prev].slice(0, 20));
                            showNotification(msg.data);
                        }
                    } catch { /* ignore */ }
                };
                ws.onclose = () => { setConnected(false); };
                ws.onerror = () => ws.close();
                return () => ws.close();
            }, [backendStatus.state]);

            function showNotification(alert) {
                const title = alert.type === "stop_loss" ? "🛑 止损预警" : alert.type === "take_profit" ? "🎯 止盈预警" : "⚠️ 行情预警";
                if (window.__DSH_NOTIFY__) window.__DSH_NOTIFY__({ type: alert.severity === "high" ? "error" : "warning", title, message: alert.message });
                if ("Notification" in window && Notification.permission === "granted") {
                    new Notification(title, { body: alert.message });
                }
            }

            async function handleRetry() {
                setBackendStatus((s) => ({ ...s, retrying: true }));
                // 通过 DSH host 调用重启（如果暴露了 IPC）
                if (window.__DSH_STOCK_RESTART__) {
                    try {
                        await window.__DSH_STOCK_RESTART__();
                    } catch (e) {
                        setBackendStatus({ state: "failed", error: e.message, retrying: false });
                        return;
                    }
                }
                // 否则等待下次轮询
                setTimeout(() => {
                    setBackendStatus((s) => ({ ...s, retrying: false }));
                }, 5000);
            }

            const onDragStart = (e, idx) => { setDragSrc(idx); e.dataTransfer.effectAllowed = "move"; };
            const onDragOver = (e, idx) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
            const onDrop = (e, idx) => {
                e.preventDefault();
                if (dragSrc == null || dragSrc === idx) return;
                setStocks((prev) => {
                    const next = [...prev];
                    const [moved] = next.splice(dragSrc, 1);
                    next.splice(idx, 0, moved);
                    saveOrder(next.map((s) => s.code));
                    return next;
                });
                setDragSrc(null);
            };

            if (props.collapsed) {
                return React.createElement("div", { className: "dsh-stock-collapsed" }, "📈");
            }
            if (loading && backendStatus.state === "running") return React.createElement("div", { className: "dsh-stock-loading" }, "加载中…");

            const backendOk = backendStatus.state === "running";

            return React.createElement("div", { className: "dsh-stock-panel" },
                React.createElement("div", { className: "dsh-stock-header" },
                    React.createElement("span", null, "📈 股票监控"),
                    React.createElement("span", { className: `dsh-stock-status ${connected ? "ok" : "off"}` },
                        backendOk ? (connected ? "● 实时" : "○ 连接中") : "○ 后端未启动")
                ),

                !backendOk && React.createElement(BackendStatus, {
                    status: backendStatus,
                    onRetry: handleRetry,
                }),

                backendOk && indices && React.createElement("div", { className: "dsh-stock-section" },
                    React.createElement("div", { className: "dsh-stock-section-title" }, "大盘"),
                    React.createElement("div", { className: "dsh-stock-indices" },
                        ["000001", "000300", "399006"].map((code) => {
                            const idx = indices[code];
                            if (!idx) return null;
                            return React.createElement("div", { key: code, className: `dsh-stock-idx ${idx.change_pct >= 0 ? "up" : "down"}` },
                                React.createElement("span", { className: "name" }, idx.display_name || idx.name),
                                React.createElement("span", { className: "pct" }, formatPct(idx.change_pct))
                            );
                        })
                    )
                ),

                backendOk && React.createElement("div", { className: "dsh-stock-section" },
                    React.createElement("div", { className: "dsh-stock-section-title" },
                        `自选股 (${stocks.length}) — 拖动排序`),
                    stocks.length === 0
                        ? React.createElement("div", { className: "dsh-stock-empty" },
                            "暂无持仓。在对话中添加：",
                            React.createElement("br", null),
                            React.createElement("code", null, "添加持仓 600519 茅台 100股 1500元"))
                        : React.createElement("div", { className: "dsh-stock-list" },
                            stocks.map((s, i) => {
                                const profit = s.buy_price ? ((s.price - s.buy_price) / s.buy_price * 100) : 0;
                                const flag = profit <= s.stop_loss_pct ? "🛑" : profit >= s.take_profit_pct ? "🎯" : "•";
                                return React.createElement(DraggableRow, {
                                    key: s.code, stock: s, idx: i,
                                    onDragStart, onDragOver, onDrop,
                                    onClick: () => setSelectedStock(s),
                                });
                            })
                        )
                ),

                backendOk && alerts.length > 0 && React.createElement("div", { className: "dsh-stock-section" },
                    React.createElement("div", { className: "dsh-stock-section-title" }, "近期预警"),
                    React.createElement("div", { className: "dsh-stock-alerts" },
                        alerts.slice(0, 5).map((a, i) =>
                            React.createElement("div", { key: i, className: `dsh-stock-alert ${a.severity}` }, a.message)
                        )
                    )
                ),

                React.createElement("div", { className: "dsh-stock-footer" },
                    `更新于 ${formatTime()} · 仅监控，不自动交易`),

                selectedStock && React.createElement(KLineModal, {
                    code: selectedStock.code,
                    name: selectedStock.name,
                    onClose: () => setSelectedStock(null),
                })
            );
        }

        // ============= 注册 sidebar 入口 =============
        const sidebar = require("@deepseek-ai/dsh-client-ui-sidebar");
        if (sidebar?.registerRegion) {
            sidebar.registerRegion("stock", {
                id: "dsh-plugin-stock-watchlist",
                label: "股票",
                icon: "📈",
                order: 50,
                render: () => React.createElement(WatchlistPanel, { collapsed: false }),
            });
        }

        const theme = require("@deepseek-ai/dsh-client-ui-theme");
        if (theme?.injectCSS) {
            theme.injectCSS(`
                .dsh-stock-panel { padding: 8px; font-size: 12px; }
                .dsh-stock-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); margin-bottom: 8px; font-weight: 600; }
                .dsh-stock-status.ok { color: #22c55e; }
                .dsh-stock-status.off { color: #f59e0b; }
                .dsh-stock-section { margin-bottom: 12px; }
                .dsh-stock-section-title { font-size: 11px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px; }
                .dsh-stock-indices { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }
                .dsh-stock-idx { display: flex; flex-direction: column; padding: 6px 4px; background: var(--dsw-alias-button-elevated-fill); border-radius: 6px; align-items: center; }
                .dsh-stock-idx.up .pct { color: #ef4444; }
                .dsh-stock-idx.down .pct { color: #22c55e; }
                .dsh-stock-idx .name { font-size: 10px; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-idx .pct { font-size: 13px; font-weight: 600; }
                .dsh-stock-list { display: flex; flex-direction: column; gap: 2px; }
                .dsh-stock-row { display: grid; grid-template-columns: 16px 1fr auto auto auto; gap: 6px; padding: 6px 4px; border-radius: 4px; cursor: pointer; align-items: center; user-select: none; }
                .dsh-stock-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
                .dsh-stock-row.up .pct { color: #ef4444; }
                .dsh-stock-row.down .pct { color: #22c55e; }
                .dsh-stock-row .drag-handle { color: var(--dsw-alias-label-secondary); cursor: grab; font-size: 10px; text-align: center; }
                .dsh-stock-row .name { font-weight: 500; }
                .dsh-stock-row .price { font-family: var(--dsh-font-mono, monospace); }
                .dsh-stock-row .profit { font-size: 10px; color: var(--dsw-alias-label-secondary); font-family: var(--dsh-font-mono, monospace); }
                .dsh-stock-empty { padding: 20px 8px; text-align: center; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-empty code { background: var(--dsw-alias-button-elevated-fill); padding: 2px 4px; border-radius: 3px; font-size: 11px; }
                .dsh-stock-alerts { display: flex; flex-direction: column; gap: 2px; }
                .dsh-stock-alert { padding: 4px 6px; border-radius: 4px; font-size: 11px; }
                .dsh-stock-alert.high { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
                .dsh-stock-alert.medium { background: rgba(245, 158, 11, 0.1); color: #f59e0b; }
                .dsh-stock-footer { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); font-size: 10px; color: var(--dsw-alias-label-secondary); text-align: center; }
                .dsh-stock-loading, .dsh-stock-collapsed { padding: 20px; text-align: center; color: var(--dsw-alias-label-secondary); }
                .dsh-stock-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999; display: flex; align-items: center; justify-content: center; }
                .dsh-stock-modal { background: var(--dsw-alias-bg, #1a1a1a); color: var(--dsw-alias-label-primary); border-radius: 12px; width: 90vw; max-width: 900px; height: 80vh; max-height: 600px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5); position: relative; }
                .dsh-stock-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 16px; font-weight: 600; }
                .dsh-stock-modal-header .close-btn { background: transparent; border: none; color: inherit; font-size: 18px; cursor: pointer; padding: 0 4px; }
                .dsh-stock-periods { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
                .dsh-stock-periods button { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: inherit; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
                .dsh-stock-periods button.active { background: var(--dsw-alias-button-elevated-fill); font-weight: 600; }
                .dsh-stock-kline { flex: 1; min-height: 0; }
                .dsh-stock-modal-overlay { position: absolute; top: 100px; left: 0; right: 0; padding: 20px; text-align: center; color: var(--dsw-alias-label-secondary); pointer-events: none; }
                .dsh-stock-modal-overlay.error { color: #ef4444; }
                .dsh-stock-backend { padding: 16px; border-radius: 8px; margin-bottom: 12px; background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); }
                .dsh-stock-backend.error { border-color: #ef4444; }
                .dsh-stock-backend.warn { border-color: #f59e0b; }
                .dsh-stock-backend-title { font-weight: 600; margin-bottom: 8px; }
                .dsh-stock-backend-error { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; word-break: break-all; }
                .dsh-stock-backend-hint { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
                .dsh-stock-btn { background: var(--dsw-alias-button-primary, #3b82f6); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
                .dsh-stock-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .dsh-stock-btn:hover:not(:disabled) { opacity: 0.85; }
            `);
        }

        return { WatchlistPanel, KLineModal };
    },
});
