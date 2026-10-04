# -*- coding: utf-8 -*-
"""重写 client.js 的 KplRecommendPage（栏目 tab+更多弹层）并新增 KplColumnPage（专栏页）"""
import io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PATH = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\lib\client.js"
lines = open(PATH, encoding="utf-8").read().split("\n")
start = next(i for i, l in enumerate(lines) if "function KplRecommendPage({ go })" in l)
end = next(i for i in range(start + 1, start + 130) if lines[i] == "        }")
print("替换行:", start + 1, "到", end + 1)

new_code = u"""        /* ---- 推荐菜单（App 底部导航推荐：栏目 tab 横滑+更多弹层+专栏页，ForumsMsgColumn 同源） ---- */

        function KplRecommendPage({ go }) {
            const [cols, setCols] = useState(null);
            const [cur, setCur] = useState(null);
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
                        const first = (d.columns || [])[0];
                        setCur(d.current || (first && first.id) || "27");
                        setFeed(d.list || []);
                        setPreIndex(d.pre_index != null ? String(d.pre_index) : null);
                    } catch (e) { setError(e.message); }
                })();
            }, []);
            const switchCol = (cid) => {
                if (cid === cur) return;
                setCur(cid); setFeed(null); setPreIndex(null);
                loadFeed(cid, null);
            };
            const fmtT = (t) => t ? new Date(t * 1000).toLocaleString("zh-CN",
                { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
            const feedCards = (list) => (list || []).map((a) => React.createElement("div", { key: a.id,
                className: "kpl-rcm-card",
                onClick: () => go({ page: "article", aid: a.id, title: a.title.slice(0, 30) }) },
                React.createElement("div", { className: "main" },
                    React.createElement("div", { className: "tt" }, a.title),
                    a.zhaiyao ? React.createElement("div", { className: "zy" },
                        a.zhaiyao.slice(0, 46) + (a.zhaiyao.length > 46 ? "…" : "")) : null,
                    React.createElement("div", { className: "meta" },
                        React.createElement("span", null, fmtT(a.time)),
                        React.createElement("span", null, "赞 " + a.vote),
                        a.is_pay ? React.createElement("span", { className: "pay" }, "订阅") : null)),
                a.img ? React.createElement("img", { className: "thumb", src: a.img,
                    onError: (e) => { e.target.style.display = "none"; } }) : null));
            const TABN = 8;
            return React.createElement("div", { className: "kpl-page" },
                React.createElement("div", { className: "kpl-rcm-cols" },
                    (cols || []).slice(0, TABN).map((c) => React.createElement("span", {
                        key: c.id, className: "c " + (cur === c.id ? "on" : ""),
                        onClick: () => switchCol(c.id),
                    }, c.name)),
                    React.createElement("span", { className: "c more", onClick: () => setAllOpen(true) }, "更多")),
                React.createElement(ErrorBox, { error }),
                React.createElement(LoadingBar, { show: feed === null && !error }),
                feedCards(feed),
                React.createElement("div", { className: "kpl-rcm-more" },
                    loading ? React.createElement("span", { className: "ld" }, "加载中…")
                        : preIndex ? React.createElement("button", {
                            onClick: () => loadFeed(cur, preIndex) }, "加载更多")
                            : (feed && feed.length ? React.createElement("span", { className: "ld" }, "已显示全部") : null)),
                allOpen && React.createElement("div", { className: "kpl-rcm-allmask", onClick: () => setAllOpen(false) },
                    React.createElement("div", { className: "kpl-rcm-all", onClick: (e) => e.stopPropagation() },
                        React.createElement("div", { className: "t" }, "全部栏目"),
                        React.createElement("div", { className: "grid" },
                            (cols || []).map((c) => React.createElement("span", {
                                key: c.id, className: "g " + (cur === c.id ? "on" : ""),
                                onClick: () => { setCur(c.id); setAllOpen(false);
                                    go({ page: "colPage", cid: c.id, name: c.name }); },
                            }, c.name))))));
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
                    onClick: () => go({ page: "article", aid: a.id, title: a.title.slice(0, 30) }) },
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
        }"""

lines[start:end + 1] = new_code.split("\n")
open(PATH, "w", encoding="utf-8").write("\n".join(lines))

# CSS：更多弹层+专栏页头
src = open(PATH, encoding="utf-8").read()
css_anchor = ".kpl-rcm-card .thumb { width: 96px; height: 68px; object-fit: cover; border-radius: 8px; flex-shrink: 0; background: #f5f6f8; }"
css_new = css_anchor + """
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
                .kpl-col-desc { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; font-size: 12px; color: #666; line-height: 1.7; margin-bottom: 8px; }"""
assert css_anchor in src
src = src.replace(css_anchor, css_new, 1)
open(PATH, "w", encoding="utf-8").write(src)
print("组件+CSS 完成")
