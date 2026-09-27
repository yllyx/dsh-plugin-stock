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
| 未发版 | **🚀 开盘啦登录协议逆向完成并实现**（详见下方「开盘啦登录协议」小节）：短信验证码登录+账号密码登录+自动重登，前端三模式登录卡 |

## 开盘啦登录协议（逆向自 App 6.3.20.0，mitmproxy 抓包+字节码双重验证）

- **RSA 加密**：用 APK `assets/pub.key`（**RSA-2048** X.509 SPKI），PKCS#1 v1.5，输出 Java `Base64.encode(bytes,0)` 风格（76字符/行+\n，URL 编码后 349 字符/手机号）。⚠️ `assets/PublicKey`+`PrivateKey` 是另一对（服务端下发数据的解密对），**不是**加密钥对——曾误用 PrivateKey 解请求密文得 93B 乱码，走上弯路
- **发验证码（登录页用）**：`c=PwlMob a=PwlSendVerify`（免登录态），参数 `Phone=RSA(手机号)`、`CheckCode=md5(DeviceID+手机号+"kaipanla")小写hex`（公式已对照抓包实值逐字节匹配）、`SType=1`；响应 `{"Phone":"明文","errcode":"0"}`。⚠️ `Verify/SendVerify` 是换绑手机/注销场景（**需登录**，未登录报"登录状态失效！"，别用错）
- **短信登录**：`c=Login a=LoginPhone`，`Phone=RSA`、`Verify=明文验证码`、`InviteCode`、`DeviceToken=md5(did)`、`ClientID=3`
- **密码登录**：`c=Login2 a=LoginDo`，`Phone=RSA(账号)`、`Password=RSA(密码)`（>50字符原样传）、`EncryptType=RSA`；密码规则限字母数字（含下划线报"密码格式有误"）
- **登录响应**：`{Phone:RSA密文, UserID, Token, EndTime(unix), UserName, Name, ...}`
- **域名**：登录/用户走 `applhb.longhuvip.com`（即 HOST_LHB）
- **插件实现**：`kpl.py` 的 `kpl_rsa_encrypt`（纯 Python modexp，零依赖）+ `/api/kpl/send-code|login-sms|login-pwd|logout`；`config.py` 增 `kpl_phone`/`kpl_password`（明文存，同通达信先例）用于 Token 失效自动重登（60s 节流）
- **已实测**：假手机号 LoginDo 返回"手机号码未注册!"，证明服务端成功解密 RSA、协议全通；真实发码待用户收码验证
- 逆向工具链沉淀在 `E:\zcode-projects\kanpan_spec\`（dex 字节码 dump 用 `tools/dump_class.py`，androguard 走 `py` 启动器）

### 开盘啦首页模块接口（2026-09-22 逆向+实测，聚合在 `GET /api/kpl/home`）

| 首页模块 | 接口（域） | 关键参数/说明 |
|---|---|---|
| 大盘解读弹窗+推荐文章 | `UserInfo/AppNews`（applhb） | `Type=39`=盘面解读文案；其余条目=文章(Title/Content/URL/Time) |
| AI快讯 | `PCNewsFlash/GetList`（apparticle） | `st/Type/Index/Date`；含 `Stocks`关联板块涨跌幅、`Source`来源 |
| 最新主题 | `ThemeNews/GetSearch`（apparticle） | `KeyWord`**必须非空**(空报参数错,用"AI")、`st/Index`；含 ZSName 主题+Stocks |
| 最强风口 | `ZhiShuRanking/QiangDu_Article`（apphwshhq） | 无参；**盘中才有数据**，收盘后 List 空 |
| 市场风口热词 | `ForumsTuyere/GetHotSearch`（apparticle） | 无参；KeyWord+num |
| 市场情绪(涨停/封板率/跌停) | `HisHomeDingPan/ChangeStatistics`（已有） | info[]字段：`ztjs`=涨停家数、`strong`=封板率%、`df_num`=跌停、`lbgd`=连板高度 |
| 近期活跃板块 | **走 Socket 3009 题材列表（二期）** | HTTP 无对应端点，`IndexPlate/GetIndexList` 返回的是文章非板块 |
| 风向标/人气榜 | Socket 2126 QxWindVane / 未定位到 HTTP | 二期 |

- **排查工具**：App 全量接口注册表已提取到 `kanpan_spec/captures/api_registry.json`（1015 对 c/a，从 ox0/j00 dump 按"相邻 const-string 对"解析）；多域轮询探测脚本 `tools/probe_home2.py`（Token 从 `stock-data/config.json` 读，5 域轮询找 class 所在域）
- **主题机会页**（`GET /api/kpl/themes?tab=themes|calendar&index=&st=`）：双Tab同端点 `ThemeNews/GetList`（apparticle），**Type=-1=最新主题、Type=3=投资日历**（mitmproxy 代理对 apparticle 域有效——ART/LHB 域无 pinning 可抓，apphwshhq 域有 pinning 抓不到）。主题条目 `Stocks` 按 `SetTop=1` 优先展示前4只（2×2）；日历条目 `ColorType` 1红=事件 2橙=会议。分页用 Index（0,1,2…st=30/页）；`dex 里 bj 类` = ForumsTuyere 论坛仓库（GetEvnArt/AddFocus 等，主题收藏/关注用）
- **主题详情页**（`GET /api/kpl/themes/{news_id}`）：`ThemeNews/GetInfo`（apparticle，参数 `NewsID`+`Type=0`）。Info 含 `Content`(HTML正文)、`ZSCode/ZSName/ZSDesc`(主题介绍卡)、`Stocks[{Code,Name,Rate,Desn公司简介,IsSel}]`；`TiCai/ReaderCount`(appres) 是阅读计数上报可忽略。前端 KplTab 下钻用**栈(drills)**实现逐级返回，底部导航切换时清栈

### 题材库（Socket 通道已独立化：内置 unidbg 签名器，无模拟器/无网关/无 frida，2026-09-23 全链路实测）

- **架构**：`kpl.py` → `kpl_socket.get_kpl_socket()`（KplSocketAPI：3009/3010/2501/3001/3006）→ `KplSocketSession.connect()`（TLS mTLS + 260挑战 + **`sign_local()`** + 610鉴权 + 心跳7s）
- **内置签名器**：`backend/signer/`（kplsigner.jar + lib/*.jar + kpl_min.apk 裁剪版 1.2MB + libauthSign_armv7_patched.so，~30MB 随插件分发）。原理 = unidbg 模拟 armeabi-v7a 的 libauthSign.so：VM 传真 APK（包名/签名证书/assets 自动解析），mock `currentApplication`/`getAssets`/`Config.channelID("129")`/`versionName("6.3.20.0")`/`ApiConfig.apiVersion("w48")`，so 内 unidbg/frida 检测字符串已 patch（等长破坏 9 处）。**依赖系统 Java 8+**（`_find_java` 自动定位并执行校验，规避 Oracle java8path 存根——该存根 `java -version` 直接失败）
- **签名性能（暖进程）**：`sign_local` 走 `_WarmSigner` 常驻子进程（stdin/stdout 行协议），首签 1.8s（含 JVM 启动）、续签 0.14s；进程死自动重启，失败回退单次调用
- **纯 Python 签名器（雏形）**：`backend/kpl_signer_py.py`——unicorn 模拟 so（ELF32 加载/JNIEnv vtable 分发/libc 子集桩/数据重定位分配内存/NEON 启用 CPACR+FPEXC）。已跑进 initBaxPwd 但输出空：Ollvm 混淆深层对抗（执行偏离/anti-tamper）未完，**勿删**；完成后可彻底去 Java。关键经验：thumb 函数偏移不带 thumb 位（verbose 显示的 0x...431 实际偏移 0x...430）、CPACR=0xF00000+FPEXC=0x40000000 启用 NEON、数据符号（__stack_chk_guard）须分配真实内存而非函数跳板
- **build_frame 的 total 字段 = len(inner)（不含 kind1B+total4B 头）**——App 同款；多算 5B 服务器会静默丢弃帧（鉴权"无响应"假象，曾误导为签名被毒化，实际是帧格式 bug）
- **服务器端口特性**：getIPList 下发多台多端口，**只有部分端口（如 124.71.166.244:8080）主动推 260 挑战**，80/14000 端口 TLS 可连但无挑战 → connect 对每台完整走"挑战→签名→鉴权"，失败换下一台
- **签名含时间成分**：同挑战不同时刻输出不同（勿做签名缓存对照），服务器均接受；挑战与连接绑定且时效数秒
- **⭐ 帧头真实布局（2026-09-23 字节级对账实锤，修大 bug）**：kind2(挑战)=`[kind1][total4][cmd2][保留3]` body@10；kind4(业务)=`[kind1][total4][seq2][cmd2][flags1][extCount1]` body@11，3009 响应 body=`1b 03 00 18`mini头(00 18=ASCII前缀长24)+"global|..."前缀+protobuf。旧 try_parse_frame 把 extCount 按 2 字节读，3009 帧把 extCount(00)+body首字节(1b) 拼成 0x001b=27 → 按"每TLV跳4字节"错跳 135B → **body 最前的置顶题材(AI硬件/地方国资)被整段吞掉**，题材库恒比 App 少两条。consumed 必须返回 5+total（帧实际长度）。置顶题材带 f10="1" 标记 + f11=入榜时间戳 + 内联概念子记录（f1/f2/f3 重复出现=概念，f4 float=概念涨幅）
- **已验证 cmd**：3009 题材库全列表（~248题材：id/名称/拼音/热度/涨停数/涨幅/isHot/upNum/isNew，ASCII头剥除用偏移扫描找 field10 密集区）；3010 题材统计（**只认题材id，801开头板块id无响应**）；2501 板块股票池（plateId=801xxx 有效、题材id无效；quotas=[细分标签,现价,涨跌%,成交额,换手率,...]）
- **题材名→801板块id 映射**：`Index/GetInfo`（apphwhq，**View 必须含 2,3,4,5**）响应的 `BaceFaceList`=[[题材名,涨幅,801xxx],...]（仅热门4条）；详情页个股行情 2501 匹配用
- **插件端点**：`GET /api/kpl/tika`（题材库列表，热度降序+30s缓存）、`GET /api/kpl/tika/{id}?name=`（题材详情）
- **题材详情 = HTTP `Theme/InfoGet`**（applhb，**需登录态**，ID 与 3009 同体系）一个接口全量：`Table`（小表格分类矩阵 Level1→Level2→Stocks，分类中文名/入选理由/IsZz主板标——3010 分类 id 的中文名就在此）、`StockList`（成分股+Tag）、`BriefIntro`/`Introduction`、`Create/UpdateTime`、`ZT`（涨停股 map）；个股实时涨幅经 BaceFaceList 映射板块后 2501 匹配（BaceFaceList 仅热门4条，多数题材无实时涨幅属数据现实，且热门榜每日变化——昨日有映射今日可能没有）
- **⭐ 题材详情秒开架构（2026-09-27，"点更多等半天"修复）**：详情链路含 2501 池+3010 统计两个 socket 调用，旧实现全部内联在关键路径 → 会话死时 40-80s 重连扫描+3010 服务端实算 9-15s → 前端白屏"等半天"。现架构：**SWR 双层缓存**（30s 新鲜+7天陈旧兜底秒回+后台刷新，磁盘 `kpl_theme_cache.json` 防抖5min原子写）+ **socket 短路**（`session_alive()` False 时跳过 2501/3010，标 `quotes_pending/stat_pending` 秒回，bg 线程等会话就绪（最多90s）后补全写缓存）+ **3010 恒后台**（服务端实算太慢不进关键路径，由 `_themedet_refresh_bg` 单独拉取合并写缓存）+ **启动预热 Top5 热门详情**（main.py `_kpl_prewarm` 线程：poprank 六视图→题材列表→Top5详情串行）。前端：收到 pending 标记自动 3s 重拉（最多2次）——体验=秒开列表、数秒后行情/统计自动补上（App 同款）。**3010 响应也带 ASCII 前缀**（`global|N:20020/3010-0/{id}`），解析前必须 regex 剥离（`3010-0/\d+`），且 timeout ≥15s——已修（曾无前缀剥离+6s超时=stat 永远失败）
- **首页题材库 3 条**：3009 hotVal 降序前 3（与 App 同源同序）；`isHot(f5)`=红底"持续火爆"标签；**App 列表置顶的订阅题材**（如 AI硬件/地方国资，含子题材树 f13 concepts）来自用户订阅态，登录态 3009 也未见全量置顶逻辑——订阅接口（题材级，区别于股票级 Theme/InfoGR）待逆向；排名变化箭头=前端快照对比
- **3009 列表是动态的**：服务器会盘后/盘前增删题材（昨日在榜的题材今晨可能被移出），快照只反映当下——与 App"显示昨日收盘缓存"存在天然时点差，盘中实时对比两侧一致
- **首页性能**：home feed 7 模块并行拉取（ThreadPoolExecutor）+ **按域限速**（`_rate_wait(host)`：同域串行≥2.5s、跨域并行——App 即每域独立连接，原全局限速器会把并行请求重新串行化）；并行后首次 ~13s（apparticle 域 3 请求×2.5s 为下限）、缓存 5ms
- **历史（已废弃）**：模拟器+frida 竞速签名网关（kanpan_spec/tools/kpl_gateway.py 归档）——壳进程结构（frida 视图真身名"开盘啦"/com.aiyu.kaipanla 为 ptrace 看护）、adb root 依赖等经验见 git 历史；模拟器 frida 抓包在 pm clear 后失效（App 看门狗杀注入进程）
- **坑**：报 `errcode:9999 "class not exists mothod"` = **域名不对**（同一控制器类只存在于特定域）；`1020 参数出错`=参数缺失/为空
- 模拟器 frida 运行时抓包在 pm clear 后失效（App 看门狗 2.8s 内杀被注入进程，status_hide 也压不住）；**静态 dex 逆向 + 多域探测**是当前有效路线

## 关键经验（踩过的坑，勿再犯）1. **AI 工具 `output.render` 必须返回 `[{type:"text", text:"..."}]` content block 数组**——返回字符串/字符串数组会报 `content.some is not a function`（DSH Agent 按 pi-ai 内容块处理）
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
23. **DSH 新版删除了 `@deepseek-ai/dsh-client-runtime` 包**——第三方皮肤 `dsh-client-ui-aqua@1.3.1` peer依赖它，新版启动必报 `missed the module table ... build-time externals drift`（连带 bundle 全部插件 "Failed to load plugins"，殃及股票插件但非其问题）。解法：web profile 的 package.json 移除 aqua 依赖+bundle条目、pnpm-workspace.yaml 删其 patchedDependencies 与 minimumReleaseAgeExclude 条目、删 patches/*.patch 后重装。新版自带官方皮肤。
23. **DSH 更新器安装插件报 `Invalid time value` 崩溃**：崩溃发生在 `detectMinReleaseAgeViolation`（pnpm 11.8 supply-chain 时间校验，`new Date(undefined).toISOString()`）。**已实锤的机制链**：npmjs 的精简元数据（abbreviated，pnpm resolve 实际用的格式）**不含 time 字段**（npmmirror 的含），DSH 更新器上下文中 resolve 到无 time 元数据即崩；exclude 白名单救不了（time 读取在校验函数内）。**复现要点**：CLI 传 `--config.minimum-release-age` 无效（被静默忽略，导致复现实验全假），必须写进 `.npmrc` 或 `pnpm-workspace.yaml` 才生效。**解法（实测可靠）：退出 DSH 或直接在 web profile 手动 `"D:\Program Files\nodejs\pnpm.cmd" install 包名@版本`**（系统 pnpm 11.7 不崩），把更新器想装的目标版本手动装到位后，DSH 重启时无事可做即不再触发该路径。装新包（目录不存在）时甚至无需退 DSH。另：官方源解析 DSH 自家包（@deepseek-ai/*）常报 NO_MATCHING_VERSION，DSH 生态装包务必走 npmmirror
24. **冷开机后插件后端被健康检查误杀**（2026-09-23）：重启电脑后首次启动 DSH，后端光 import 就要 ~25s（冷文件缓存+杀软扫描刚热改写入的 .py），HEALTH_TIMEOUT_MS=30s 的窗口在 uvicorn 即将 bind 端口前就把进程 SIGTERM（日志特征：lifespan 各子系统日志齐全但 8765 无监听 → `failed - 健康检查超时` → `SIGTERM`）。已把 backend-manager.js 窗口提到 90s；热改 .py/lib 后若赶着重启 DSH，可先让杀软扫完或手动跑一次 import 预热缓存
   - **配套修复（同日）**：index.js 加健康看门狗（每20s探 /health，不在 running/starting 且不可达就 b.start() 重新拉起）——否则后端一死，系统Tab接口全 `Failed to fetch`、「重启后端」按钮跟着 status 卡片一起消失，形成只能重启DSH的死循环；系统Tab 后端不可达时显示降级说明卡。另：分离拉起的后端 DSH 重启时会经 isAlreadyRunning「直接复用」
25. **⭐ 事件循环阻塞=后端"批量加载失败"的真凶（2026-09-27 py-spy 实锤，勿再犯）**：三处把**同步阻塞调用跑在 asyncio 事件循环上**，pytdx 断连时（周末/夜间必现）每次触发串行扫描全部服务器（10-50s/次，每 30-60s 一波），整个后端冻结、所有请求超时——前端表现为各页面间歇性"加载失败"。三处已全修（asyncio.to_thread / connected 短路）：① `alert_engine.check_holdings/check_custom_alerts` 的 `get_security_quotes`（**主根因**，run_loop 是 asyncio 定时任务）② `ws_manager._run` 广播循环 ③ keepalive 循环另加"仅交易时段重试 pytdx"。**排查手法**：间歇冻结但单发难复现时，用 `py-spy dump --pid <8765进程>` 在冻结瞬间抓主线程栈，一次定位（`pip install py-spy`）。"周期性冻结"特征=async def 里裸调同步网络/磁盘 IO
26. **⭐ Socket 会话频繁死亡的三大根因（2026-09-27 题材详情"等半天"排查中逐一实锤，已全修）**：症状=鉴权日志反复出现（17-100s 一次）、拉取动辄 40s+。① **心跳线程与 RPC 线程并发 sendall** 同一 socket → 帧交错损坏 → 服务端解析失败断线（修：`_send_lock` 发送锁）② **订阅式 cmd（3008/3009/3001）服务端持续推送无人读** → 内核接收缓冲堆满 → 服务端踢线（修：`_drain_loop` 清理线程，每 1.5s 与 RPC 接收互斥清缓冲；⚠️ "发送→收响应"必须原子持 `_recv_lock`(RLock)，否则 drain 会在间隙把响应帧当推送吃掉→RPC 永远超时→死得更快——首版教训）③ **`_session_rpc` 失败后 `_session=None` 重建但旧 socket 未 close** → 旧心跳线程在死连接上继续发心跳 → 服务端视为同 device 双活连接互踢 → 新会话必死循环（修：重建前 `close()` 旧会话杀掉心跳/drain 线程）。**配套**：`session_alive()` 供调用方短路决策（死会话跳过内联 socket 拉取，标 pending 后台补全）；⚠️ 它曾误加到 Session 类（读不存在的 `self._session` → AttributeError 被 except 吞 → **恒 False** → 短路逻辑永远生效、行情永远补不上）——**except 吞异常的方法必须验证"正常路径真的走得通"，不能只测异常路径**。归因手法：心跳/drain 线程加退出日志（存活时长+原因），配合 py-spy 看线程是否存活

## 开盘啦(KPL)集成状态（2026-09-23）

### 已完成（独立运行，无模拟器/无网关/无frida依赖）
- **Socket 通道已复活并内置**（kanpan_spec 探索 + unidbg 离线签名）：kpl_socket.py 直连服务器（多服务器轮换，8080/80/14000/443 探测挑战），TLS1.3 mTLS（kgT.p12），cmd260 挑战 → cmd610 登录态鉴权（UserID/Token 同 HTTP 面）→ 心跳 kind1 cmd13；签名 = backend/signer/ 内 Java(unidbg) 离线模拟 libauthSign.so（warm 进程，subprocess JSON 协议，需 Java 8+）
- **帧格式（2026-09-23 字节级对账修正）**：`[kind<<4|sub:1B][totalLen:4B][seq:2B 仅kind3/4/5][cmd:2B]` 之后**各 kind 头长不同**（kind2 挑战帧再 3 字节保留、kind4 业务帧再 flags1+extCount1，extCount 是 **1 字节**）；totalLen=inner 长度不含 5B 头，**consumed 必须返回 5+totalLen**；业务 RPC kind4，鉴权 kind3
- **已验证 cmd**：3009 题材库全列表(pb.Empty 请求；响应=ASCII前缀`global|...`+protobuf，f10 每项=一题材{id1,name2,pinyin4,isHot5,hot6,zt7,up8,f10?,f11会话meta,f12 pct,f13 概念{id1,name2,pinyin3,pct4}})、3010 题材个股统计、2501 板块股票池、3001 组合行情、3002 主指数
- **题材库数据已与 App 逐项对齐**（2026-09-23 同时对比实测：AI硬件3板/持续火爆/└CPU、地方国资7板、财经媒体1板、云计算2板25↑、端侧AI 11↑、地产链5板 全一致；250 题材=248 普通+2 置顶）
- **⭐ 置顶题材是常驻的**：AI硬件/地方国资带 f10="1" 置顶标记 + f11=入榜时间戳，**始终在 3009 响应 body 最前面**。曾误判为"分钟级动态轮换/时点快照差异"——已证伪，"时有时无"的真凶是下方帧解析 bug 吞掉了 body 前段。勿再为"缺题材"找替代源或客户端合并方案（kpl_focus 置顶补数据已移除）。插件 30s 缓存已对齐 App 下拉刷新
- kpl.py: get_themes_socket(3009)/get_theme_detail_socket(InfoGet+腾讯行情+3010)；main.py /api/kpl/tika
- 前端 KplTikaPage：App 同款布局（搜索框/排序表头 按热度|按涨幅/名次三色1红2橙3黄/涨停chip/持续火爆徽标/上涨家数↑/概念子行CPU）；30s 静默刷新；首页题材库3条+概念子行
- 首页提速：overview+home 并行拉取 + 模块级 SWR 缓存（秒开旧数据后台刷新）；后端 _cached_swr(20s)+启动预热

### 凭据与设备
- config.json: kpl_user_id/kpl_token/kpl_device_id=**插件自有自动生成 ID（2026-09-27 起，勿再用模拟器的 cff05554）**。曾克隆模拟器设备号以"与 App 同设备"，但同 device_id 的模拟器 App 与后端 socket 会**持续互踢**（拉取 20-45s、表现为各视图"无数据"），2026-09-27 应用户要求改回 `_device_id()` 自动生成并固定；Token 是账号绑定而非设备绑定——换设备后用 config 里的账号密码重登一次即拿到同样 Token（`/api/kpl/login-pwd`），socket 610 鉴权正常。改 device_id 的正确姿势：**先杀 8765 后端进程再清空 config.json 的 kpl_device_id**（顺序反了会被运行中进程的 config 整体回写覆盖），重启后 `_device_id()` 自动生成并持久化

### ⭐ Socket 帧解析问题排查 SOP（2026-09-23 题材库破案实战总结，后续帧解析问题按此处理）
背景：题材库恒比 App 少置顶两条，数轮误判（订阅假说/设备假说/时点快照假说）全被推翻，最终靠**字节级对账**破案（帧解析器吞 body 前段 135B）。标准手段：
1. **同时对比定性**：同一时刻 `adb exec-out screencap -p` 截 App 界面 + `curl DSH接口` 拉数据，逐行对比数值（含上涨家数等细粒度字段）。数值全同仅缺行 → 解析层丢数据；数值不同 → 才是数据源/时点问题。**切勿错时对比**（App 手点 vs 我们拉取差几分钟，盘中数据一直在变，会误判）。
2. **模拟人操作驱动 App**（反调试不感知系统级输入）：`adb shell input tap/swipe` 导航、下拉刷新；冷启动 ANR 弹窗点 Wait、营销弹窗逐个关；webview 卡住点重新加载。**全程不 attach 进程**，App 无感。
3. **原始字节落盘，绕开自己的解析器**：新建裸 socket 会话（TLS 后 sendall 请求帧 + 循环 recv 到超时），把**全部原始字节**写 .bin，再独立分析。若裸收的数据完整而走 KplSocketSession.rpc 的不完整 → 就是自家解析器 bug（本案实锤）。回归测试也用历史 .bin 喂 try_parse_frame。
4. **字节级对账定布局**（核心）：a) 帧头 total 声明 vs 实收字节数对账（差 0 = 单帧完整）；b) 找**锚点**反推 body 真实起点——ASCII 前缀（"global|"）、pb 字段合法性（`08` 开头=field1 varint）、数值合理性（serverTime=当天秒级时间戳、涨停数与 App 界面一致）；c) **不同 kind 帧分别抓样本**（本案 kind2 与 kind4 头长不同），勿假设统一布局；d) 对每种候选起点验证"pb 恰好干净消费到帧尾 + 关键字段值合理"。
5. **警惕并发会话互踢**：同 device_id 第二条 socket 连接会被服务端拒（所有端口"无挑战"）。测试脚本连不上时，先确认 8765 后端的会话是否活着（可 /api/system/restart 释放），勿误判为服务端故障。服务端对短时间频繁建连也限流（同样表现为"无挑战"），歇几分钟再试。**模拟器里常驻的开盘啦 App 同样会持续互踢后端会话**（2026-09-26 实证：单次拉取被拖到 40s+，插件端表现为各视图"无数据"），联调/对比完记得 `adb shell am force-stop com.aiyu.kaipanla`。
6. **修完必须双验证**：历史抓包 .bin 回归 + 线上接口（/api/kpl/tika）实测与 App 同时刻对比。

### ⭐ App 功能复刻标准 SOP（2026-09-25 人气榜/最强风口/严重异动复刻实战总结，后续复刻任何 App 功能按此流程）
五步流程，从 UI 到数据到落地：
1. **UI 探索（adb 系统级驱动 + 截屏）**：`adb shell input tap/swipe` 模拟人操作导航到目标页面（首页模块→更多→下钻页→各 tab/排序逐个点开），每步 `adb exec-out screencap -p > x.png` 截屏并**亲眼读图**记录：模块结构、行布局、字段、颜色、徽标、tab/排序项。App 页面路径线索：首页模块在"我的版面"（左缘把手 tap 75,720）各版面页里，或功能宫格第二/三屏（横向滑动）。注意冷启动 ANR 点 Wait、新手引导遮罩按提示操作、营销弹窗逐个关。
2. **接口定位（三条线并行）**：a) **反编译 dex_strings.txt** 搜界面文案（如"人气榜"）定位所属控制器/Action（api_registry.json 查 `控制器/Action` → ox0/j00 方法引用）；b) **cmd_table.md / proto_fields.txt** 查 socket cmd 与 proto 消息字段（`grep -an "消息名" dex_strings.txt` 后 sed 打行号区间 od -t x1z 看 descriptor，字段号+类型直接可读，如 `18 01 20 01 28 0d` = f1 int32）；c) **activity/presenter 字节码 dump**：`py tools/dump_class.py unpacked2/classesN.dex "类名" out.txt`（androguard 走 py 启动器；先 grep -qa 定位类在哪个 dex），从 Fragment 的 Bundle 常量（如 type=1/2→tab）、Presenter 的请求构造（newBuilder→setType/setOrder）读出参数枚举。
3. **协议实测（自带客户端直发）**：用插件 kpl_socket 直发目标 cmd，扫参数枚举——⚠️ **枚举空间必须先从字节码读全，切勿拍脑袋设范围**（人气榜血案：真实 type 是 tab+排序联合编码 1/2/16/13/14/17，当年拍脑袋只扫 1-10×order 0-6，把拉取式实时序列误判成"瞬态推送"，白造了一套收盘捕获循环）。每组合解析 items 并用 **App 截屏数值做锚点**（App 第 N 名的名字+热度值精确匹配哪个组合）。响应解析统一 regex 定位 `3008-0/\d+:\d+` 式 ASCII 前缀尾（与生产 get_pop_rank 同款），勿裸 pb_flat 全 body。订阅式 cmd（响应只有 ASCII 前缀 ack）需**保持连接长时收推送**，盘后/非交易时段可能无推送（如 3001）。
4. **数据机制判定**：区分拉取式/订阅推送式/瞬态（⚠️ 复盘人气榜曾被误判为"收盘瞬态推送、需收盘窗口捕获循环"，实为拉取式——参数盲区+错时对比双重误导，见人气榜条目）。对照 App 数值**持续监测**（盘前/盘中/盘后/次日各拉一次），数值会衰减/变化的序列须判定服务端算法。缺名/缺字段先查 App 本地 KPL_CACHE 库（STOCK 表=全市场名称，DYNAMIC_QUOTA_BEAN=动态列配置）与名称持久缓存合并层（kpl_names_cache.json）。
5. **插件落地 + 三重验证**：
   - 工具路径速查：adb=`C:\Users\mark\AppData\Local\Android\Sdk\platform-tools\adb.exe`（Git Bash 下写 `/c/Users/mark/...`，命令含 `/sdcard` 等路径时必须 `export MSYS_NO_PATHCONV=1`，本地路径又要保留 Windows 形式）；模拟器启动=`emulator -avd kpl_analysis -no-snapshot -no-boot-anim -gpu auto [-writable-system]`（writable-system 用于装系统 CA；装 CA 流程=root→disable-verity→reboot→remount→push `~/.mitmproxy/mitmproxy-ca-cert.pem` 到 `/system/etc/security/cacerts/c8750f0d.0`→chmod 644；多次强杀 qemu 会损坏镜像致 boot 挂起，须耐心等 fsck 或普通模式启动）；mitmdump 启动=`python -c "from mitmproxy.tools.main import mitmdump; mitmdump()"` + sys.argv 法传参（`-p 8888 --set block_global=false --ignore-hosts '^\d+\.\d+\.\d+\.\d+$'` = IP 直连的 socket 流量透传、域名 HTTP 解密）；guest 代理指向宿主用 `10.0.2.2:8888`；frida 勿用（反调试+版本坑多）
   - 插件落地 + 三重验证：后端（kpl_socket 业务封装 → kpl.py 合并名称缓存+TTL 缓存 → main.py 端点）→ 前端（独立页 KplXxxPage + 首页模块 + go({page}) 路由 + CSS 唯一前缀显式白底）→ `node --check` + `node test_apply.js` + 热改部署 + /api/system/restart + 接口实测 + **与 App 同时刻逐项核对**。UI 复刻以实拍截图为准（我们早期版本与 App 行为有差异时，用户会指出，须回到第 1 步重新实拍）。

### ⭐ 人气榜复刻全案例复盘（2026-09-24~27 四天全记录，方法论模板——后续复刻/排查任何功能先通读此节）

数据面最终形态：cmd 3008 六视图全部与 App 逐项一致（2026-09-27 用户确认"终于解决了人气榜所有问题"）。详细字段/type 语义见上方"人气榜"条目，此处只沉淀**方法与教训**。

**一、复刻流程实录（SOP 五步的真实执行版本）**
1. UI 探索：adb input 逐层导航（首页模块→更多→下钻页→双 tab×三排序逐个点），每步 screencap 亲眼读图。坑：①元素坐标用 `uiautomator dump /sdcard/ud.xml` 查 bounds（"更多"按钮凭目测 tap 落空过）；②**横幅/弹窗会挤压布局使固定坐标失效**——盘中榜切出来"停止更新"横幅把排序胶囊从 y=421 挤到 y=558，按旧坐标点全是空点，切视图前必须重新截图确认布局。
2. 接口定位（胜负手=字节码 dump）：dex_strings 搜"复盘人气榜"→ 定位 `StockPopularityListFragment`/`IntradayPopularityListFragment`/`IntradayPopularityListPresenter` 三个类 → `dump_class.py` 逐个 dump → 容器 Fragment：Bundle type 1/2=tab（两 tab **共用同一子 Fragment 类**——UI 两个页签，协议上是同一 cmd 的不同 type 编码）；子 Fragment `Jg()/Kg()`：tab→请求编码 L（盘中 1/2/16、复盘 13/14/17）；Presenter `j()`：`StockPopRankReq{(L), (order), startIndex, count}`，初始 (L,2)、点胶囊 `N(L,1)`，实测 order 1/2 等价。**教训：请求参数的真实枚举必须从字节码读，猜出来的范围必有盲区**。
3. 协议实测：kpl_socket 直发 3008 逐 type 验证，App 截屏当锚点；UI 细节同步核对（排名飙升视图名次方块=原排名、热度飙升=飙升后新位次——num 字段天然正确无需处理；热度飙升右列显示 hot_change+↑）。
4. 数据机制判定：复盘榜=拉取式实时序列（盘后/节假日仍分钟级成组更新），f5 timestamp=最后刷新时刻。曾被误判"收盘瞬态推送"并造了捕获循环——**判定机制前先确认参数空间读全+同刻对比**（见坑 1/2）。
5. 落地+三重验证：同刻对比要逐项核（数值/排名/涨跌幅/排名变化箭头/名次方块/提示条），六个视图各自对比，勿只验默认视图。

**二、问题定位工具箱（症状→第一动作）**
- 数据与 App 对不上 → **同刻对比**：同一时刻 `adb exec-out screencap` + `curl DSH接口`，逐行比数值。⚠️ 错时对比=头号陷阱：这序列分钟级在变，曾把"错时对不上"误判为"该序列不存在"。
- 某参数怎么都对不上 → 先怀疑**编码空间没读全**（字节码再读一遍），其次才是机制假说。每提出一个假说先找反例（本案"瞬态推送"假说与"App 随时打开都有数据"矛盾，却无人质疑，拖了三天）。
- 前端"加载失败/无数据" → **第一动作：看后端访问日志里实际收到的 URL 与状态码**。`type=undefined`+422=前端组装参数 bug；无请求=前端没发；请求 200 但 items 空=数据层问题。
- 后端间歇性整体超时/冻结 → **`py-spy dump --pid <8765进程>`** 在冻结瞬间抓主线程栈，一次定位（本案主线程挂在 pytdx connect：async def 里裸调同步网络 IO）。装法 `pip install py-spy`。
- 接口只在重启后正常、之后永远旧数据 → 查后台刷新链路（签名器 readline 无超时坑，见性能铁律条），"无日志的永久挂起"=同步 IO 卡死特征。
- socket 拉取突然全部变慢 20-45s → 查同 device_id 并发互踢（模拟器里的开盘啦 App，见 SOP 第 5 条）。

**三、坑清单（本轮全部实锤，按发现顺序）**
1. **参数盲区**：type 联合编码只扫 1-10 → 误判复盘榜机制 → 白造捕获循环（已删）。教训已写进 SOP 第 3 条。
2. **错时对比**：序列分钟级在变，所有"数值对不上"的结论必须同刻复核。
3. **device_id 互踢**：模拟器 App 与后端同 device_id 持续互踢 → 拉取 20-45s → 前端"无数据"。插件已改自有自动生成 ID（见凭据与设备条）；联调完 `adb shell am force-stop com.aiyu.kaipanla`。
4. **签名器 readline 无超时**：Java 子进程卡死 → connect 永久挂起且持锁 → 全部拉取饿死、零日志（详见性能铁律条）。通用教训：**子进程行协议必须带读超时+写单飞锁**。
5. **事件循环阻塞**（py-spy 实锤，详见经验 #25）：alert_engine/broadcaster 在 async 里裸调同步 pytdx → 断连时每波冻结 10-50s → 前端批量"加载失败"。三处全改 to_thread/短路。
6. **磁盘高频写盘触发杀软扫描**：SWR 缓存每 30-60s 落盘 132KB → 每 60s 一波进程挂起。改 5 分钟防抖+tmp+rename 原子写。教训：**高频数据落盘必须防抖**，本机杀软对写入敏感（同经验 #24）。
7. **React 对象 state 引用失配**：组件每次渲染重建常量数组，useState 存对象 + indexOf 按引用查 → 切换后 `types[-1]=undefined` → 请求 `type=undefined` 422。**规则：交互型 state 只存 id 字符串，派生对象 find/findIndex 按值查**。此坑"进页正常、一切换就坏"，极难直觉定位，靠日志定案。
8. **uvicorn 事件循环停顿的连带**：前端 fetch 无超时会挂满；已在前端加 3 次重试+递增退避兜底。

**四、性能模式（复刻高频实时数据页照抄）**
后端：30s 新鲜缓存 → SWR 陈旧兜底（内存+磁盘双层，stale=true 标记）秒回 + 后台刷新线程（_pop_refreshing 去重）→ 启动预热全部视图（冷 socket 首连要扫 6 台服务器 ~40s，被预热+磁盘缓存完全掩盖）。前端：进入页即拉、失败自动重试、服务端序直出勿本地重排。效果：任意视图任意时刻 100-200ms 且有数据。

### 二期未完成
- 我的订阅（App"我的订阅"页）：走用户真实订阅接口，勿用 kpl_focus 硬编码
- App 反调试实证（2026-09-23）：守卫子进程 ptrace 主进程+主进程 waitpid 守卫 → 杀守卫后主进程毫秒级自杀，frida attach 竞速窗口 <1s 基本不可行；frida 会话保持期间 App 存活，**一旦 detach 秒死**；spawn 模式启动期即被检出。**探索 App 的正确姿势 = 系统级手段**：adb input 模拟人操作 + 截屏/UI dump 对比（本题材库破案即靠此）+ mitmproxy(HTTP) / tcpdump(SNI) / DEX 静态分析，勿再恋战 frida
- kanpan_spec 目录：抓包(flows*.jsonl)、cmd_table.md、proto_fields.txt、工具(tools/)
- **⭐ 题材详情个股行情数据通道（2026-09-23）**：数值列 = socket 2501 板块股票池（App 同款），quotas(f100 repeated string) 锚定映射：q0=板块标签文本、q1=现价、q2=涨跌%、q3=成交额、q4=换手率（q16≈涨速、q17≈振幅待验证）。plateId 来自 BaceFaceList(Index/GetInfo，**必须带 View=2,3,4,5..** 否则空) 名字映射+双向包含模糊匹配，覆盖窄（当日精选板块），未命中题材数值列显示 --。2501 响应 f11=total 在 items 前、count 上限 500、**start>0 分页被服务端断连**（市值序 quotaType=1 单页 500 覆盖约 83/159，含全部活跃股）
- **3001 GroupStockQuotas 是订阅式**（proto 实测字段：quotaType1/sortType2/start3/count4/addPrices5/stockIds10(repeated string)）：请求后只回 ASCII 前缀确认帧，全量数据靠服务端推送——**盘中**订阅推全量快照（r3001.bin 9.7KB），**盘后无推送**（不可用）；带额外字段会回 cmd110"连接错误：1002"
- **_wait_cmd 分帧拼接（关键修复）**：大响应（2501 23KB/3009 13KB）流式多帧到达，旧逻辑收到首帧即返回导致数据截断；现改为"首帧命中后再收 0.8s 静默窗口，同 cmd 帧按序拼接"。get_sector_pool 剥前缀改为 f22 密集起点扫描（旧 marker-2 切法在拼接体上失效）
- **⭐ App 数据缓存机制（2026-09-23 从模拟器 /data/data/com.aiyu.kaipanla/databases/ 实证）**：App 用 **KPL_CACHE 库**做本地合并层——`STOCK` 表 13824 行=全市场代码→名称库（socket 响应只带 id 时从表查名，TYPE 列区分市场）；`DYNAMIC_QUOTA_BEAN` 表=服务端下发的动态列配置（FUNCTION 区分页面，0x7FFFFFFF=通用 21 列：涨幅/价格/主力净额/涨速/成交额/总市值/流通市值/板块/换手率/量比…含 CLICKABLE/SERVER_TYPE/COLOR_STYLE，UI 按 ARRAY_POSITION 渲染——**列不是硬编码的**）。已实测当前 3009/2501/InfoGet 响应零缺名（"硅"为单字题材名非缺失）；缺名场景=服务端对已同步设备下发增量响应时省略字段。
- **⭐ 插件名称持久缓存合并层（复刻上述机制）**：kpl.py KplClient 增加 `_remember_name/_flush_names` + 数据目录 `kpl_names_cache.json`（themes/stocks 两表）。三处接入：3009 题材名、InfoGet StockList/详情股票名、2501 池股票名——新名登记防抖落盘、缺名用缓存补。按需积累（每个拉过的题材/股票都进缓存），与 App KPL_CACHE 等效
- **⭐ 人气榜（2026-09-24 复刻并按用户实测反馈修正，cmd 3008 AppGlobal.SubStockPopRank）**：请求 `StockPopRankReq{type1,order2,startIndex3,count4}`；响应 `StockPopRankResp{...items10(f10), fiveMinuteItems11(f11), f5=timestamp(uint64最后更新秒), f6=day(string 排名基准日)...}`，Item 字段=stockId1/stockName2/ratio3(float涨幅)/rankChange4(uint64,>2^63 为负下溢)/num5(当前排名)/isPop6/isContinuous7/ztReason8/lbStatus9(连板状态)/desc10/fullText11/tag12/tagList13{value1,color2}/hotChange14/hotVal15(人气值)/tagListV2_16。早期插件曾用 type=3 当主榜（App 真实编码里没有 3，已弃）。**App 下钻页实拍（2026-09-24 17:0x）**：页面=「盘中人气榜(默认)/复盘人气榜」双 tab + 「热度排名/排名飙升/热度飙升」三排序胶囊（红框选中）；行卡片=名次方块(1红2橙3黄)+名称+代码+涨幅大字+🔥人气值 / 第二行=排名变化↑↓+橙色chip(ztReason/lbStatus)+蓝色描边chip(tagList) / 第三行(可选)=desc 消息折叠(点击展开)；底部提示条="排名上升 XX ｜ 5分钟人气上升 N 位"(fiveMinuteItems)。**热度飙升=服务端按 hot_change 降序**（09-24 实测 新华传媒16524↑>新华文轩14324↑>大亚圣象13948↑）。盘中榜非交易时段提示"当前时段停止更新，最后更新时间为 xxx"（timestamp）。**⭐⭐ type 语义彻底破解（2026-09-26 字节码实锤+同刻实测，推翻 09-25"复盘榜未破解"结论）**：盘中/复盘共用同一 Fragment——容器 StockPopularityListFragment 传 Bundle type 1=盘中 tab / 2=复盘 tab（复盘 tab 仅非交易时段且 jm1.n().l(32) 开关为真时添加），两 tab 都实例化 IntradayPopularityListFragment；Fragment 把 Bundle type 映射为请求参数 L：**盘中→1/2/16、复盘→13/14/17**（对应 热度排名/排名飙升/热度飙升 三胶囊）；Presenter 构造 (L, order)——初始 (L,2)、点胶囊后 N(L,1)，实测 order 1/2 返回内容一致，插件固定用 1。**type<=3 响应才带 fiveMinuteItems**（复盘榜无急升条的根因）。**复盘榜 13/14/17 = 服务端实时序列**：盘后/节假日仍成组更新（分钟级，f5 timestamp=最后成组刷新时刻），短连接 RPC 直拉即与 App 完全一致——2026-09-26 22:41 同刻对比 13/14/17 三视图数值+排名+排名变化箭头逐项全同。**旧结论证伪教训（勿重蹈）**："复盘榜=收盘结算瞬态推送、错过后拿不到、需收盘窗口捕获循环"是错的——真因：①当年扫参数只试 type 1-10×order 0-6，13-17 是盲区；②"衰减序列不存在"叠加了错时对比（违反 SOP 第1条，序列分钟级在变）。收盘捕获循环/kpl_pop_replay.json/captured 兜底/前端 captured 提示条已全部删除。App 首页人气榜模块与下钻页同源同序列（首页快照可能滞后——App 首页不即时刷新，下钻页/重进即最新）。插件实现：/api/kpl/poprank type 透传（盘中 1/2/16、复盘 13/14/17，30s 缓存）；KplPopRankPage 双 tab+三排序胶囊=切换请求 type、服务端序直出勿本地重排；热度飙升视图右列显示 hot_change+↑（App 同款）；首页 home feed poprank 交易时段 type=1 / 其余 type=13（急升条仅盘中 type<=3 有）；名称入 kpl_names_cache。**09-26 晚六视图与 App 全部逐项核验一致**（盘中·排名飙升=type2：粤传媒原排名39↑482/吉鑫47↑364/雷科18↑267；盘中·热度飙升=type16：内蒙新华hotchg19918↑/新华传媒18638↑，名次方块=飙升后新位次；排名飙升视图名次方块=原排名，热度飙升视图名次方块=新位次）。**前端交互（App 同款）**：下钻页默认 tab 按交易时段（盘中→盘中榜、非交易→复盘榜·热度排名），首页徽标同样动态。**性能铁律（2026-09-26/27 实战）**：socket 会话被同 device_id 连接互踢/重连时单次拉取 20-45s，前端表现即"无数据"——已加 SWR 陈旧缓存（30s 新鲜窗+陈旧兜底秒回+后台刷新线程，**另落盘 `kpl_pop_cache.json` 后端重启不丢**，7 天有效期）+ main.py 启动预热六视图（13/1/14/17/2/16 顺序拉取）。**冷连接成本**：新进程 connect 按序扫 6 台服务器（每台 dial 8s+挑战 6s），只有部分端口（8080）发挑战，首连固定 ~40s，`_last_good_server` 缓存后走快路。**⭐ 签名器致命坑（2026-09-27 修复）**：`_WarmSigner.sign()` 的 `stdout.readline()` 原本**无超时**（传参 timeout_s 未被使用）——Java 子进程偶发卡死时 connect 永久挂起且持有 socket 锁，全部拉取饿死、零日志（后端"永远只有 stale 数据"的根因）；已改为读线程+queue 超时（超时 kill 暖进程回退单次调用），并加 `_sign_lock` 单飞（行协议非线程安全，并发会串包）。排查"人气榜只有 stale 不更新"先看日志有无"已鉴权连接"。响应解析起点=regex 定位 `3008-0/{type}:{order}` 前缀尾
- **⭐ 严重异动提醒（2026-09-24 复刻，App 同源 `StockBidYiDong/GetPianLiZhi_Index`@apphwshhq）**：涨幅偏离值监控列表——距触发交易所"严重异动"的进度。List 项（数组）：[0]code [1]name [2]口径(1盘中/0收盘，同股双条取盘中) [3]规则(如"连续10个交易日内涨幅偏离值累计达到 100%") [4]当日涨幅 [5]已交易天数 [6]累计偏离值% [7]触发提示("涨幅达到5.25%将触发严重异动") [8]触发所需涨幅 [11]现价 [12]状态。App 首页模块 UI（2026-09-24 实拍对齐）=标题+日期徽标(09-24)+更多›；4 列表：股票名称(代码+板块chip) | 涨幅%+现价 | 触发异动涨幅%(橙)+触发价 | 当日触发异动偏离值空间%+规则简称；派生字段：触发价=昨收×(1+触发涨幅)、偏离空间=触发涨幅-当日涨幅、规则简称="10日100%"式。前端首页模块（人气榜下方）按此 4 列表格复刻（kpl-yd2 显式白底）；/api/kpl/yidong 端点（60s缓存）；home_feed.yidong 带 8 条+yidong_day。GetBidYiDong(竞价异动列表)同控制器可用（盘中数据）
- **⭐ 最强风口页（2026-09-24 复刻，App"我的版面"打板页·风向标同源）**：数据=HTTP `ZhiShuRanking/QiangDu_Article`（无参数，**盘中才有 List**，项为数组[?,名称,强度,涨幅,板块]）；盘后回退当日快照 `kpl_qd_snapshot.json`（复刻 App 盘后仍显示当日数据的行为）。页面=情绪指标条(涨停板/封板率/跌停股 今日/昨日，来自 get_sentiment_history) + 名称/强度/涨幅/板块 列表；/api/kpl/qiangdu 端点（30s缓存）；首页"最强风口"模块加"更多›"入口。**注意**：App 风向标 socket 2103 DaBanStockList 盘后同样无数据（订阅式）；proto=pidType1/orderType2/sortType3/index4/count5+市场开关6-10
- 题材详情页深色主题黑字黑底踩坑（2026-09-24）：kpl-tikad2 白底卡片设计配硬编码 #111 深色文字，容器背景透明继承深色主题 → 名称隐身。修复=整个详情内容区显式 background:#fff 卡片化（App 本就白底），涨跌/边框/hover 全部显式色。**经验：复刻 App 白底组件时容器必须显式白底，禁用主题变量兜底**（经验 #7 的反向变体）
- 题材详情 UI v2（kpl-tikad2-* 前缀）：小表格=红色边框表格（红头条/左列一级分类/二级分类+股票流式/涨停股红色高亮 ZT map/免责声明）；描述区 2 行截断+"查看全文▼"弹窗（kpl-explain 模式渲染 Introduction HTML，反编译证实 App 同款 ThemeDescDialogFragment(Content)）；个股行情=统计条(3010 或前端现算)+"隐藏简介"开关+右侧数值列(价格/涨幅/人气值/成交额/换手率)点击排序（默认人气值降序）+左块 sticky 固定/整体横滑+涨停行红色
- frida 17 的坑：`script.on_message = fn` 无效必须 `script.on("message", fn)`；Java bridge 需 frida≤16（设备端 fs16=16.7.19）；Module.enumerateExports 静态方法已删，用模块实例 .enumerateExports()；Java TLS 走 libjavacrypto.so 静态 BoringSSL，hook libssl.so 的 SSL_write 抓不到 conscrypt 流量
