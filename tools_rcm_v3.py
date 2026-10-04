# -*- coding: utf-8 -*-
"""KplRecommendPage 最终 1:1 版：双大 tab(关注/文章)+栏目横滑(HOT)+AppNews 推荐+卡片(Stock chips/来源/相对时间)"""
import io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PATH = r"E:\deepseek-proj\stock-all\dsh-stock-plugin\plugin\lib\client.js"
lines = open(PATH, encoding="utf-8").read().split("\n")
start = next(i for i, l in enumerate(lines) if "function KplRecommendPage({ go })" in l)
end = next(i for i in range(start + 1, start + 200) if lines[i] == "        }")
print("替换行:", start + 1, "到", end + 1)

new_code = u"""        /* ---- 推荐菜单最终 1:1（App 实拍 m0/m1：双大 tab+栏目横滑 HOT+左文右图卡片） ---- */

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
                        setFeed(await api("/api/kpl/recommend_articles?st=20&index=0"));
                    } catch (e) { setError(e.message); }
                })();
            }, []);
            const switchCol = (cid) => {
                if (cid === cur) return;
                setCur(cid); setFeed(null); setPreIndex(null);
                if (cid !== "rec") loadFeed(cid, null);
                else (async () => {
                    try { setFeed(await api("/api/kpl/recommend_articles?st=20&index=0")); } catch { setFeed([]); }
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
                        React.createElement("span", null, relTime(a.time))))),
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
        }"""

lines[start:end + 1] = new_code.split("\n")
open(PATH, "w", encoding="utf-8").write("\n".join(lines))

# CSS
src = open(PATH, encoding="utf-8").read()
css_anchor = ".kpl-rcm-cols { display: flex; gap: 4px; overflow-x: auto; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 4px 6px; margin-bottom: 8px; scrollbar-width: none; }"
css_new = """                .kpl-rcm-top { display: flex; align-items: center; gap: 16px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; }
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
                .kpl-rcm-followhead .av .nm { font-size: 10px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 56px; }"""
assert css_anchor in src
src = src.replace(css_anchor, css_new, 1)
open(PATH, "w", encoding="utf-8").write(src)
print("组件+CSS 完成")
