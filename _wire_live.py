import io
p = "plugin/lib/client.js"
s = io.open(p, encoding="utf-8").read()
old = 'sub === "live" && React.createElement(KPL_G.live, null),'
new = 'sub === "live" && React.createElement(KPL_G.live, { go }),'
assert s.count(old) == 1
s = s.replace(old, new)
old_css = "                .kpl-sdp-chart { background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }"
new_css = old_css + '''
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
                .kpl-lv-item .chip.plate i { color: #1c5fbb; }'''
assert s.count(old_css) == 1
s = s.replace(old_css, new_css)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("wire+css ok")
