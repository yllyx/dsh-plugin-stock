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

        /* ---- 登录绑定卡 ---- */

        function KplBindCard({ onBound }) {
            const [uid, setUid] = useState(""); const [tok, setTok] = useState("");
            const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
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
            return React.createElement("div", { className: "kpl-bind" },
                React.createElement("div", { className: "kpl-bind-h" }, "🔐 绑定开盘啦账号"),
                React.createElement("div", { className: "kpl-bind-d" }, "App登录后抓包获取 UserID+Token（约2个月有效）"),
                React.createElement("input", { className: "kpl-bind-in", placeholder: "UserID", value: uid, onChange: e => setUid(e.target.value) }),
                React.createElement("input", { className: "kpl-bind-in", placeholder: "Token", value: tok, onChange: e => setTok(e.target.value) }),
                React.createElement("button", { className: "kpl-bind-btn", disabled: busy, onClick: doBind }, busy ? "…" : "绑定"),
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

        function KplHomePage({ go, status, reloadStatus }) {
            const [ov, setOv] = useState(null);
            const load = useCallback(async () => {
                try { setOv(await api("/api/kpl/overview")); } catch { /* */ }
            }, []);
            usePolling(load, 30000, []);
            const logged = status && status.logged_in;
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
            return React.createElement("div", { className: "kpl-page" },
                !logged && React.createElement(KplBindCard, { onBound: reloadStatus }),
                logged && status.user_info && React.createElement("div", { className: "kpl-user-bar" },
                    "👤 " + (status.user_info.username || status.user_info.user_id)),
                React.createElement("div", { className: "kpl-func-grid" },
                    funcs.map(([label, fn]) =>
                        React.createElement("div", { key: label, className: "kpl-func-btn", onClick: fn }, label))),
                React.createElement("div", { className: "kpl-sec-title" }, "🔥 热搜股票"),
                React.createElement("div", { className: "kpl-hot-grid" },
                    ((ov && ov.hot_stocks) || []).slice(0, 10).map((h, i) =>
                        React.createElement("div", { key: h.ID || i, className: "kpl-hot-item",
                            onClick: () => go({ page: "stock", stock: { code: h.ID, name: h.Name || h.ID } }) },
                            React.createElement("span", { className: "rank" }, i + 1),
                            React.createElement("span", { className: "code" }, h.ID)))),
                React.createElement("div", { className: "kpl-sec-title" }, "🔥 热搜词"),
                React.createElement("div", { className: "kpl-hot-words" },
                    ((ov && ov.hot_words) || []).slice(0, 12).map((w, i) =>
                        React.createElement("span", { key: i, className: "kpl-hot-word" }, w))));
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

        function KplTab() {
            const [activeNav, setActiveNav] = useState("home");
            const [drill, setDrill] = useState(null);
            const [status, setStatus] = useState(null);
            const loadStatus = useCallback(async () => {
                try { setStatus(await api("/api/kpl/status")); } catch { /* */ }
            }, []);
            usePolling(loadStatus, 30000, []);

            const go = (r) => {
                if (r.page === "back") { setDrill(null); return; }
                setDrill(r);
            };
            const switchNav = (id) => { setDrill(null); setActiveNav(id); };

            // 下钻页面渲染
            let content;
            if (drill) {
                if (drill.page === "sector") content = React.createElement(KplSectorDetail, { plate: drill.plate, list: drill.list || KPL_SECTORS, go });
                else if (drill.page === "stock") content = React.createElement(KplStockDetail, { stock: drill.stock, go });
                else if (drill.page === "search") content = React.createElement(KplSearch, { go });
                else if (drill.page === "lhb") content = React.createElement(KplLhbPage);
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
