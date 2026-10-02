# -*- coding: utf-8 -*-
"""救火：重建丢失的 KplFengkouPage/KplSectorDetailPage + 三处交互修复（一次性脚本）"""
import io

p = 'plugin/lib/client.js'
s = io.open(p, encoding='utf-8').read()

# ============ 1) 两个丢失组件：插在 KplRecommendPage 定义前 ============
anchor = '        function KplRecommendPage() {'
assert anchor in s, 'anchor KplRecommendPage'

components = '''        /* ---- 市场风口下钻页（GetFengKList：按股票/按概念双视图+日期回看） ---- */

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
            const load = useCallback(async () => {
                try {
                    const d = await api("/api/kpl/sector/" + plateId);
                    setData(d); setError(null);
                } catch (e) { setError(e.message); }
            }, [plateId]);
            useEffect(() => { load(); }, [load]);
            usePolling(load, 20000, [plateId]);
            const stocks = (data && data.stocks) || [];
            const sum = (data && data.summary) || null;
            const pending = data && (data.pool_pending || data.quotes_pending);
            const title = (data && data.name) || name || plateId;
            return React.createElement("div", { className: "kpl-page" },
                React.createElement(KplPageHeader, { title: title, onBack: () => go({ page: "back" }) }),
                sum ? React.createElement("div", { className: "kpl-sdp-sum" },
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "板块涨幅"),
                        React.createElement("div", { className: "v " + (Number(sum.rate) >= 0 ? "up" : "down") },
                            sum.rate != null ? Number(sum.rate).toFixed(2) + "%" : "--")),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "主力净额"),
                        React.createElement("div", { className: "v " + (sum.main_net >= 0 ? "up" : "down") },
                            sum.main_net + "亿")),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "涨停数"),
                        React.createElement("div", { className: "v up" }, sum.zt_num)),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "成交额"),
                        React.createElement("div", { className: "v" }, sum.amount_sum + "亿")),
                    React.createElement("div", { className: "cell" },
                        React.createElement("div", { className: "lbl" }, "成员数"),
                        React.createElement("div", { className: "v" }, sum.stock_num)))) : null,
                error && React.createElement("div", { className: "kpl-empty" }, "加载失败：" + error),
                pending && React.createElement("div", { className: "kpl-empty" },
                    "行情连接建立中，数据稍后自动补全…"),
                !error && data && !stocks.length && !pending &&
                    React.createElement("div", { className: "kpl-empty" }, "暂无成分股数据"),
                stocks.length ? React.createElement("div", { className: "kpl-lhb-scroll" },
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
                            React.createElement("div", { className: "numcol up" }, r.ztSeal || "--"))))) : null);
        }

'''
s = s.replace(anchor, components + anchor, 1)

# ============ 2) drill 补 market 分支（首页宫格 4 按钮直达行情子 tab） ============
old_m = '''                else if (drill.page === "fengkou") content = React.createElement(KplFengkouPage, { go });'''
new_m = '''                else if (drill.page === "fengkou") content = React.createElement(KplFengkouPage, { go });
                else if (drill.page === "market") content = React.createElement(KplMarketPage, { go, initialSub: drill.sub });'''
assert old_m in s, 'fengkou route'
s = s.replace(old_m, new_m, 1)

# ============ 3) 底部导航 LHB 补传 go ============
old_nav = '''            } else if (activeNav === "lhb") {
                content = React.createElement(KplLhbPage);
            } else {'''
new_nav = '''            } else if (activeNav === "lhb") {
                content = React.createElement(KplLhbPage, { go });
            } else {'''
assert old_nav in s, 'nav lhb'
s = s.replace(old_nav, new_nav, 1)

# ============ 4) KplStockDetail 回填自选状态 ============
old_w = '''            const [inWatch, setInWatch] = useState(null);
            const load = useCallback(async () => {
                try { const d = await api(`/api/kpl/quote/${stock.code}?force=1`); setError(null); setQ(d); }
                catch (e) { setError(e.message); }
            }, [stock.code]);'''
new_w = '''            const [inWatch, setInWatch] = useState(null);
            // 挂载时查一次自选列表回填状态（不回填时首次点击会把"加自选"执行成"移出"）
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
                try { const d = await api(`/api/kpl/quote/${stock.code}?force=1`); setError(null); setQ(d); }
                catch (e) { setError(e.message); }
            }, [stock.code]);'''
assert old_w in s, 'inWatch'
s = s.replace(old_w, new_w, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('rescue OK')
