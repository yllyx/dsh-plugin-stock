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
                            : null));
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
