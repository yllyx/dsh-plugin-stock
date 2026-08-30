# 项目记忆 — dsh-plugin-stock

DSH (DeepSeek Harness Desktop) 股票交易体系插件。本文件记录项目结构、本地安装、发布、提交流程与关键经验，供后续会话直接使用。

## 项目结构

```
dsh-stock-plugin/                  # 开发仓库（git, main 分支）
├── AGENTS.md                      # 本文件（项目记忆）
├── README.md
├── catalog-submission/            # deepseek1024.com 市场收录清单
│   └── yllyx--dsh-plugin-stock.json
└── plugin/                        # npm 包本体（npm name: dsh-plugin-stock）
    ├── package.json               # 版本号、files 清单（含 backend/*.py、backend/static/*）
    ├── dsh.plugin.json            # DSH 插件清单（版本号需与 package.json 同步）
    ├── CHANGELOG.md               # 每版本必写
    ├── cordis.patch.yml
    ├── lib/
    │   ├── index.js               # 宿主端：注册 8 个 stock_* AI 工具 + 拉起 Python 后端
    │   ├── client.js              # 前端：8 Tab 仪表盘（择时/情绪风格/板块/持仓仓位/预警/选股/舆情联动/系统）
    │   └── backend-manager.js     # Python 后端进程管理（健康检查 30s）
    ├── backend/                   # Python FastAPI 后端（随 npm 包发布）
    │   ├── main.py                # 入口，70+ REST 端点
    │   ├── data_source.py         # pytdx 行情 + K线路由（指数 index_bars / 个股东财→腾讯回退）
    │   ├── eastmoney.py / tencent.py   # 双网络源（互为灾备）
    │   ├── tdx_local.py           # 本地通达信 vipdoc .day 读取（全市场日线）
    │   ├── market_timing.py / market_sentiment.py / sector_monitor.py
    │   ├── position_manager.py / alert_engine.py / screener.py
    │   ├── storage.py / config.py / system_api.py
    │   ├── sentiment_monitor.py   # 🌐舆情三源抓取（东财7×24快讯/新浪滚动/美联储RSS，5分钟循环）
    │   ├── sentiment_db.py / news_filter.py / sentiment_keywords.py / user_keywords.py
    │   ├── keyword_learner.py     # AI推荐关键词（高频新词分析）
    │   ├── event_rules.py / event_calendar.py / event_impact_analyzer.py  # 事件日历（含时区换算）
    │   ├── sector_mapper.py / stock_matcher.py / investment_advisor.py    # 板块/个股关联+投资建议
    │   ├── impact_analyzer.py / impact_history.py / impact_predictor.py   # 历史影响预测
    │   ├── position_priority.py / user_preference.py    # 持仓优先+偏好学习（个性化推送）
    │   ├── system_validator.py    # 系统自检
    │   └── static/klinecharts.min.js  # K线库 9.8.12 本地打包（勿删，勿依赖 CDN）
    └── test_apply.js / test_backend.js / publish.js / publish-and-submit.js
```

## 关键路径与端口（本机 mark 的环境）

| 项 | 值 |
|---|---|
| DSH 安装 | `D:\app\DSH Desktop\`（v2.0.1，Electron） |
| DSH web profile | `C:\Users\mark\.dsh\profiles\web\`（插件装在它的 node_modules 下） |
| 插件安装位置 | `C:\Users\mark\.dsh\profiles\web\node_modules\dsh-plugin-stock\` |
| 后端端口 | 127.0.0.1:8765（uvicorn，DSH 加载插件时自动 spawn） |
| 数据目录 | `C:\Users\mark\.dsh\stock-data\`（alerts/account/config.json/market.db，插件包外，升级不丢） |
| 本地通达信 | `D:\app\tdx`（vipdoc 全市场日线；分钟线目录默认空，需客户端盘后下载勾选） |
| DSH 日志 | `C:\Users\mark\AppData\Roaming\DSH Desktop\logs\dsh-YYYY-MM-DD.log` |
| pnpm | `D:\Program Files\nodejs\pnpm.cmd` |
| npm 账号 | longmark（token 在 `~/.npmrc`，指向官方 registry） |

## Registry 策略（重要）

- **全局** `~/.npmrc` = `https://registry.npmjs.org/` + authToken → **仅用于 npm publish**
- **DSH web profile** `C:\Users\mark\.dsh\profiles\web\.npmrc` = `https://registry.npmmirror.com/` → DSH 装插件走国内镜像（单包 56ms vs 官方 2s）
- 二者隔离，互不影响

## 本地安装（同步到 DSH）

**正式安装（推荐，走 pnpm）**：
1. **必须先完全退出 DSH**（托盘退出/Ctrl+Q）——DSH 运行时占用 node_modules 目录，pnpm 报 `EPERM rename`
2. `cd C:\Users\mark\.dsh\profiles\web && "D:\Program Files\nodejs\pnpm.cmd" install dsh-plugin-stock@latest`
3. 若报 supply-chain 错误：把报错的包加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 再重试
4. 重新打开 DSH → 系统 Tab 确认版本号

**临时热改（开发调试用，DSH 重装插件会被覆盖）**：直接 `cp` 文件到插件安装位置对应路径；改 `lib/client.js`（前端）需刷新 DSH 页面（Ctrl+R）；改 `backend/*.py` 调 `POST http://127.0.0.1:8765/api/system/restart`（即系统 Tab「⚡重启后端」）即可生效，**无需重启 DSH**（杀进程手动重启会脱离 DSH 进程管理，不推荐）。

## 发布流程（npm publish）

```bash
cd plugin/
# 1. 版本号三处同步：package.json、dsh.plugin.json（PLUGIN_VERSION 已自动从 package.json 读，无需改代码）
# 2. plugin/CHANGELOG.md 写本版本条目
# 3. 测试
node test_apply.js          # 必须 PASS（校验 8 个工具注册）
# 4. 打包预览（确认 backend/static/klinecharts.min.js 在内）
npm pack --dry-run
# 5. 发布（走全局 ~/.npmrc = npmjs + token）
npm publish
# 6. 验证
npm view dsh-plugin-stock version
```

## 提交与推送（git）

```bash
# 在仓库根目录 E:\deepseek-proj\stock-all\dsh-stock-plugin
git add -A
git commit -m "feat|fix: X.Y.Z 一句话说明"
git tag -a vX.Y.Z -m "Release vX.Y.Z: ..."
git push origin main --tags
```

- 直接推 main（个人仓库，无 PR 流程）
- push 偶发 403 为网络瞬时问题，重试一次即成功
- tag 与 npm 版本号保持一致

## 版本历史摘要

| 版本 | 要点 |
|---|---|
| 0.3.0 | 交易体系四大模块（择时/情绪风格/板块龙头/仓位/止盈止损2.0）、6 Tab 页面、AI 工具 4→8 |
| 0.3.1 | 启动健康检查修复（连接探测移后台线程，端口秒级监听） |
| 0.3.2 | 通达信本地数据源、腾讯备选源、SQLite K线持久化、可配置数据目录、系统管理 Tab、K线库本地打包 |
| 0.3.3 | AI 工具 render 返回 content block 数组（修 content.some 报错）、持仓 6 类预警独立开关、止盈止损模式 tooltip、K线红涨绿跌 |
| 0.3.4 | **健康检查误杀修复**（status() 去锁 + DataFrame 构建移出锁 + 窗口 15s→30s）、前端删除 backendOk 门禁（后端启动不阻塞页面） |
| 0.4.0 | **🌐 舆情联动监控系统**：三源抓取（东财7×24快讯/新浪滚动/美联储RSS）、智能过滤+用户/AI关键词、舆情-板块-个股关联+投资建议弹窗、事件日历（规则库+时区换算）、历史影响预测、个性化推送；新增第 8 Tab、19 个后端模块、40+ API |
| 0.4.1 | **投资建议具体化+自动进化闭环+真实日历**：建议接入东财实时板块/龙头（SECTOR_BRIDGE桥接+148词库）、百度股市通真实日历（前值/预期/公布值，替换mock）、FOMC官方日期修正（原编造8错5）、事件→板块映射、进化循环（回填/学习/验证/日历，每日盘后自动） |

## 关键经验（踩过的坑，勿再犯）

1. **AI 工具 `output.render` 必须返回 `[{type:"text", text:"..."}]` content block 数组**——返回字符串/字符串数组会报 `content.some is not a function`（DSH Agent 按 pi-ai 内容块处理）
2. **`/health` 及所有被宿主健康检查调用的端点绝不能持有重锁**——曾在锁内构建 5247 个 DataFrame 导致健康检查超时、后端被 SIGTERM 误杀（DSH 重启必现）
3. **pytdx 陷阱**：`hq_hosts` 条目是元组（`host["ip"]` 必抛 TypeError）；列表前几台是"僵尸站"（TCP 通但无数据），连接必须实际拉一条行情验证（探测式连接）+ 粘性主机；`get_security_bars` 个股K线解析已损坏（约27%乱码），个股K线走东财→腾讯回退，指数K线走 `get_index_bars`（干净）+ 单次800根上限需分页；行情不含 name/change_percent 字段（涨跌幅从昨收算）
4. **东财限流**：push2his（历史K线）最敏感，触发后按 IP 封数小时，编号镜像子域共享限流桶；规避=减少请求量（本地源+SQLite缓存+双源轮换），不是换 UA
5. **东财 clist 单页上限100条**、行业板块含多级嵌套（f104/f105 求和会重复计数，涨跌家数须用代码表+批量行情统计）
6. **K线库 klinecharts 必须用本地打包的 9.8.12**（9.8.5 已全网下架；CDN 国际源在本机网络常不可达）；K线配色默认国际版绿涨红跌，需 `setStyles` 覆盖为红涨绿跌
7. **前端配置**：弹框等浮层用显式配色（勿依赖 DSH 主题变量，深色主题下文字会不可见）
8. **DSH 更新插件必须先退出 DSH**（目录占用 EPERM）；`dsh plugin add` 命令只能在 DSH Desktop 进程内执行（依赖其环境变量），等价操作=web profile 下 pnpm install
9. **pnpm supply-chain 策略**：新装包若发布时间过近会被拒，按报错提示加 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 白名单
10. **用户数据必须存数据目录**（`storage.py` 解析：`STOCK_DATA_DIR` 环境变量 > `~/.dsh/dsh-plugin-stock.dir` 指针 > 默认 `~/.dsh/stock-data/`），绝不写插件包内（重装即丢）
11. DSH 内置"插件市场"组件（dsh-community-market@0.1.0-dev.0）在 DSH 2.0.1 是坏的（前端模块表缺依赖），与本插件无关，勿修
12. **前端新组件 CSS 类名必须用唯一前缀**（如 `dsh-stock-adv-*`）——曾与 K 线加载态旧类 `dsh-stock-modal-overlay` 撞名，旧规则的 `pointer-events:none` 未被覆盖导致整个弹窗点击失效（React 逻辑无任何问题，纯 CSS 坑）
13. **改代码后必须让运行中的进程重新加载**：Python 模块在进程启动时载入内存，改 `.py` 后旧进程永远跑旧代码（症状：修复"不生效"、旧报错持续）；用 `/api/system/restart` 自重启；同理前端 `client.js` 改完要刷新页面
14. **pytz.localize 只接受 naive datetime**——传入带 tzinfo 的必抛 `Not naive datetime`；先用 `dt.replace(tzinfo=None)` 剥离再 localize
15. **SQLite 长生命周期连接必须 `check_same_thread=False`**——FastAPI 端点用 `asyncio.to_thread` 在工作线程调 DB 时，主线程创建的连接会抛 `SQLite objects created in a thread...`（影响过 keyword_learner/impact_analyzer/event_impact_analyzer）
16. **东财公告接口 `np-anotice-stock` 已失效**（返回 200+0 字节空 body）；舆情用 `np-listapi.eastmoney.com/comm/web/getFastNewsList`（7×24 快讯，实测稳定）；新浪滚动用 `feed.mix.sina.com.cn/api/roll/get`；美联储 RSS 用标准库 `xml.etree` 解析即可
17. **规则型事件日历防重复**：`day_range` 是发布窗口不是"每天都发生"，须优先取 `day_of_month`（每月一次）；`with sqlite3.connect` 短连接线程安全，`self.conn` 长连接才需要跨线程配置
18. **东财 clist 按当日涨幅降序返回**：取全量板块列表时 max_count 必须≥总数（桥接用500），否则当日跌幅靠后的板块被截掉（科技板块曾因此匹配失败）
19. **百度股市通日历** `finance.pae.baidu.com/sapi/v1/financecalendar` 免费可用（无需Cookie，AKShare同款）：支持任意日期范围含历史（进化回填冷启动拉过去14天）；星级区分度差（非农仅2星）需标题关键词加权校准
20. **数据真实性原则**：规则库的FOMC日期曾是编造的（8错5）；不定期会议（政治局/国常会/OPEC）日期官方不提前公布——一律标 `is_estimated`"预计"，真实源（百度）优先覆盖；宁可空数据不编数据
21. **AI给的接口字段要先实测**：正则/字段名要以真实响应为准（百度日历结构、KeywordSuggestion是dataclass非dict，都踩过）
22. **升级EPERM的另一个元凶：自重启拉起的分离后端**——`/api/system/restart` 用 DETACHED_PROCESS 起 uvicorn（cwd在插件目录），DSH退出后它仍存活并锁 node_modules；升级前先杀 8765 的 python 进程，再用 `mv 目录名 __probe && mv back` 探测是否解锁，解锁了就无需退出DSH可直接 pnpm install（DSH本体只经子进程占目录）
23. **npmmirror 新版本同步延迟 → DSH 内置 pnpm 11.8 崩溃**：刚发布到 npmjs 的版本，npmmirror 元数据（time 字段）同步有几分钟延迟；DSH 插件更新走镜像时，其内置 pnpm 11.8 的 supply-chain 时间校验拿到 undefined 时间报 `Invalid time value` 崩溃（exclude 白名单不救；pnpm 11.8 容错缺陷，DSH 内置版无法单独升级）。**解法：等 5-10 分钟镜像同步完再点更新**；或临时把 web profile .npmrc 切回官方源；或手动 `"D:\Program Files\nodejs\pnpm.cmd" install dsh-plugin-stock@latest`（系统 pnpm 11.7 对缺失时间有容错，实测可过）
