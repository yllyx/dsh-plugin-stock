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
                                React.createElement("div", { className: "numcol up" }, r.ztSeal || "--")))));
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
