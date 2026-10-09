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

### ⭐ 推荐菜单+文章详情（2026-10-04 复刻完成，H5 JS 同源逆向）

- **文章详情协议**（决定性突破口：App 文章=webview H5 `apppage.longhuvip.com/w45/community/PContent2.html?AID=xxx`，**读 H5 页面 JS 源码** PContent2.js 直接解出数据接口——比抓包/字节码都快）：`ForumsMsgJX/GetInfo {MsgID, Tag:1}` @**ART** → `Msg{ID, Title, Content(HTML 正文), CreateTime, Account, MsgType, ZhaiYao, Stock[相关股票], Column{栏目}, VoteCount, ShareCount, SpecType, Pay(付费墙)}`。同文件还有：快讯详情 `PCNewsFlash/GetTopInfo {ID}`、阅读计数 `ForumsMsgJX/AddReadCount`、关注栏目 `ForumsMsgColumn/AddFocusUser`、付费扩读（同 GetInfo）
- **推荐流** = `UserInfo/AppNews {st, Index}` @LHB（j00.r1 字节码参数；首页推荐文章同源；Type=39 大盘解读剔除）。证伪：GetArticle/GetOneArticle（j00.l1 **无业务参数**，取最新一篇）；GlobalIndex/GetSearchList=全球指数
- **DiscoveryRecommendFragment（底部推荐 tab）结构**（字节码）：顶部分类 tab=ArticleTagBean 列表（首 tab"栏目详情列表"=ForumsMsgColumn/GetInfo，ColumnID 写死 8,11,4,3），feed=ox0.d0（c/a **来自 Tag 对象动态下发**+ColumnID/st/Index/Select/PreIndex @ART），精选=ox0.u3（ForumsMsgJX/GetSelList）
- **✅ 推荐页落地为栏目 tab 体系（2026-10-04 二版）**：栏目 tab=`ForumsMsgColumn/GetList {Index:0, st:50}` @ART（50 个栏目，"热门"=27 固定首位，其余 Recommend=1 优先）；卡片流=`ForumsMsgColumn/GetInfo {ColumnID, PreIndex}` @ART（List:[{ID,Title,**ZhaiYao 摘要**,**img.List 缩略图**,VoteCount,ShareCount,IsPay,Stock}], Base=栏目信息, PreIndex=分页游标）。实测热门栏目 9 条（一图复盘/涨停板复盘/商品现货涨价榜/盘中教程），二页分页正常。端点：/api/kpl/recommend（栏目+首 feed）、/api/kpl/column/{cid}?pre_index=（分页）。前端栏目横滑 tab+图片卡片流。**App UI 实拍仍被模拟器阻塞（镜像退化 ANR 循环）——tabs 名称与卡片布局按数据结构+栏目流通用形态落地，用户实拍有差异时回到 SOP①**
- **端点**：/api/kpl/article/{aid}（详情）、/api/kpl/recommend?st=&index=（流）。前端：KplArticleDetail（正文 HTML 渲染+相关股票 chip+风险提示，kpl-art-*）、KplRecommendPage 整页重写（feed+加载更多）、首页推荐块点击→go({page:"article"})（原 window.open 外跳废弃）、"更多›"→artCenter
- **✅✅✅ 首页推荐块同款根因（2026-10-05）**：首页 AppNews 条目的 `id`（33303 系）是**推荐位 ID** 而非文章 ID——GetInfo 同样不认。真正文章 ID 在条目 `url` 参数里（`PContent2.html?AID=42660`）。前端点击时 `AID=(\d+)` 提取跳插件详情；无 AID 条目（活动 H5 页）按 App 行为 window.open 外开。**AppNews/栏目 feed/IndexPlate 三处列表全部统一为"提取 AID→GetInfo{MsgID:AID}"链路**
- **✅✅ 栏目文章详情三度实锤（2026-10-05 终版，AID 才是唯一正确 MsgID）**：IndexPlate/GetIndexList 转载条目**双 ID**——`ID`=ForumsMsgColumn 表系（1243152 等，**GetInfo 不认**）、`AID`=文章表系（240/273/4196，**GetInfo {MsgID: AID} 返回正文**，实测 AID=273→4334B）。之前传 feed ID 或 TopicID 全 1130 的根因即此。注意 AID 并非每篇都有正文（部分老文 1130=服务端清理）。TopicID（Mz..==..;2;1 后缀串）**不是** MsgID
- **✅ 栏目文章详情已通（2026-10-04 晚二度实锤，推翻"原生专用通道"误判）**：栏目 feed 条目是**双重 ID**——`ID`=ForumsMsgColumn 表系（1254244）、`AID`=文章体系（3504）。**详情=ForumsMsgJX/GetInfo {MsgID: AID, Tag:1}**（PC 站 www.kaipanhong.com/article/{AID} 的 Nuxt chunk pcjs_CKnecJjc.js 同款参数佐证：`MsgID=m.params.id`）。实测医药栏目 8 篇：5 篇有正文（872~4824B），3 篇 1130 为服务端已清理的 2016/2020 老文章（App 同样无正文）。**此前"原生专用通道"是误判**——真因是详情传了 feed ID 而非 AID。修复：get_column_feed 增 aid 字段，前端卡片点击 `aid: a.aid || a.id`
：栏目 feed 条目 ID 属 ForumsMsgColumn 表，`ForumsMsgJX/GetInfo` 对其一律 1130（穷举 MsgID/AID/ID/ArticleID×Tag{0,1,2,13}×longhuvip/kaipanhong 双域全 1130/1020）；字节码链：DiscoveryRecommendAdapter 列表卡内**直接内嵌正文 webview**（`ArticleBean.getConts()`→loadDataWithBaseURL+JS 桥 returnAndroid，getContent()→ExpandTextView 展开正文）——**App 列表卡自带正文**，正文数据在 qg.N 解析器的响应里（字段名 `Conts`，伴随 IsJX/IsTop）；qg.N 的上游请求经 DataRepository 消息分发（n6/m6/p6），混淆层数过深未定位到 c/a。**kpl_analysis 模拟器镜像已报废**（tmpfs CA 搞挂 framework→系统 ANR 循环→冷启动 boot 卡死 40min+ offline），重建 AVD+mitm 抓包后可定位
- **列表卡与详情的当前形态**：卡片=标题+摘要(ZhaiYao 有则显，医药栏目服务端本就不带)+缩略图+时间+赞+订阅角标（与 App 同字段同源）；点卡片→文章详情（AppNews 类=全文；栏目类=降级卡：标题+摘要+图+"正文请在 App 查看"，点卡片时 zhaiyao/img/time 经路由传入）
- **✅ 坑（组件重写后分发处未同步）：重写 KplRecommendPage({ go }) 后，主分发 else 分支仍是旧占位时代的无参调用 `React.createElement(KplRecommendPage)`** → 底部导航进推荐页点文章报 `go is not a function`（console 实锤 client.js:4859）。用户报的"点击不跳详情"即此。教训：重写组件签名（新增 props）时，必须 grep 全部 createElement 调用点同步传参
- **坑**：模拟器装 mitm CA 的 tmpfs overlay 法- **坑**：模拟器装 mitm CA 的 tmpfs overlay 法会把 Android framework 搞挂（System UI ANR 循环，需整机重启恢复）——该镜像只能 remount 法；remount 失败时 H5 JS 源码逆向（静态资源直接 curl）常常更快

### ⭐ 搜索页（App 搜索 1:1，2026-10-04 复刻完成）

- **UI 结构**（实拍 s2/s5-s12）：顶部红条（返回+搜索框+搜索按钮）；5 子 tab 综合/龙虎榜/基金/营业部/涨停原因（placeholder 随 tab 变化）；默认态综合=搜索历史(localStorage)+🔥热搜股票(名次方块 1红2橙3黄+名称+代码+涨幅%+⊕加自选)；龙虎榜/基金/营业部/涨停原因=各自"热门搜索"（龙虎榜两列、营业部带订阅、涨停原因热词两列）；输入中=本地联想列表+底部"搜索：xxx 查看资讯、互动易、机构纪要等更多结果 ›"入口（点击展开 CombineSearch 分组）
- **接口协议**（全部实测，SOP 穷举+字节码双验证）：
  - 综合热搜股票 = `Search/ZongHeHotList` @LHB（StockList:[{ID,IsDY,Reason}]，**Name 空→本地名称表补**；第 1 名闽东电力 4.98% 与 App 逐位一致）
  - 涨停原因热词 = `HisLimitResumption/GetHotSearch` @HIS（word 数组，已有 get_hot_words 复用）
  - 龙虎榜 tab 热门 = `DaZongJiaoYi/GetHotSearch` @LHB（StockID/Name；与 App 龙虎榜 tab 热搜列表的差异待盘中对拍）
  - 基金 tab 搜索 = `Search/JiJinQuery` @LHB {keyword, Index, st}（ox0.H3 字节码解参数；list:[{ID,Name,NETNAV}]）
  - 综合"更多结果" = `APPComplexData/GetCombineSearch` @ART {search}（ox0.q2 解参数；Combines:{Article,Flash,Interact,Theme,Manage}）
  - **股票联想 = App 本地库过滤**（KPL_CACHE STOCK 表）——插件用打包 kpl_stock_names.json + pypinyin 首字母/全拼前缀匹配（gzmt→贵州茅台），非服务端接口
  - 证伪：GlobalIndex/GetSearchList=全球指数专用（HKTime/USTime 参数），非通用搜索
- **端点**：/api/kpl/search/{suggest,hot,combine,fund}；前端 KplSearch 整页重写（kpl-sp-* 显式白底），底部导航新增"🔍 搜索"入口，历史 localStorage key kpl_sp_hist
- **坑**：模拟器装 mitm CA 的 tmpfs overlay 法（mount tmpfs 到 cacerts 目录）会导致 Android framework 起不来（黑屏 activity 服务丢失）——该镜像只能 writable-system/remount 法，remount 失败时**别硬来**，改走协议穷举+字节码（本次即穷举破案，抓包非必需）


**目标达成**：`sign(challenge, device_id, conn_type, server_time)` 为后端纯 Python 函数（`backend/kpl_sign_whitebox.py`），无 JVM/unicorn/子进程，**单次签名 6.9ms**（Java 暖进程 0.14s、冷 1.8s）。两组不同输入（golden + 随机第二组）与 unicorn 金标整签逐位一致。

**算法全案（后续 App 升级再提取时按此流程）**：
1. **用 unicorn（kpl_signer_py.py，开发仪器不发布）跑通 so**：修 SHT_DYNSYM=11、R_ARM_RELATIVE(23) 重定位（12201 个，读 emu 内存）、停用 _fix_bare_vaddrs（会把表内小整数 +base 污染 core dispatch 表）、pthread_once/pthread_key_* 真 TLS 语义（UC_ARM_REG_C13_C0_3）、__errno 返回真指针、OpenSSL3 初始化链 OPENSSL_init_crypto(0)→OSSL_PROVIDER_add_builtin(default, ossl_default_provider_init@0x234ae4)→try_load（ADD_ALL 标志会鸡生蛋失败）、std::string 家族模拟器（libc++ 32 位 SSO；Get*ArrayElements 返回原生指针非句柄；method id 存 name+sig）、AAsset 分块续读（list 可变）、零页 mem_map(0,0x1000)、.init_array 执行、_call(arm=True)（BoringSSL 内核是 ARM 模式，JNI 入口才是 thumb）。
2. **EVP 边界 dump**（hook EncryptInit_ex/EncryptUpdate/EncryptFinal/CTX_ctrl@固定偏移）：拿 key（恒定 d6c8a0bcf7b472eb34751af6471877f4）、IV=challenge[:12]、明文（67B，格式见下）、密文、tag。
3. **白盒表固化**：initBaxPwd 后 ctx=283KB（=middle_new.bin 变换后常量）→ dump `wb_ctx_dump.bin`；轮表序列 168 项（从 affineU32 参数的表内容反查 ctx 偏移）→ `tbl_seq.json`（各 CTR 块相同）；affine 真值表 TAB_A[256]（so 偏移 0xd6178）→ `tab_a.bin`；GHASH 魔改域乘矩阵 128×16B（对 gcm_ghash_4bit@0x1a2d30 做 128 次单位向量观测，GF(2) 线性）→ `ghash_matrix.json`。
4. **算法结构**：wb_block=头 4 仿射(表 0x5280/0x5304/0x5388/0x540c, mask=BE word)→32 轮[4 通道仿射+S 盒(ctx+0x66a0+轮*0x2000, byte 子表偏移 {+0x804,+4,-0x7fc,-0xffc})+第 5 仿射(S 输出)→新状态 d^e]→尾 4 仿射(Q3,Q0,Q1,Q2)；队列轮转 Q'=(q1,q2,new,q0)。affine=out_bit[i]=TAB_A[fold(tbl_w[i]&mask)] 压缩基。
5. **GCM 管线**：明文=`kp26`+deviceId+`1`+`6.3.20.0`+`129`+connType+serverTime+`w48`（67B）；sig(95B)=challenge[:12]+密文+tag(16)；密文块 n=明文⊕word反转(wb_block(IV‖n+2))（首块 IV‖2）；H=wb_block(0^16)、E(J0)=wb_block(IV‖1)（两者经 CTR/finish 用于 tag）；tag=魔改GHASH(密文5块+len块大端(0,536))⊕word反转(E(J0))。
6. **验证**：`python kpl_sign_whitebox.py` 自校验（golden.json 全对比）；换 challenge/serverTime 第二组 unicorn 金标对拍整签一致。

**数据文件**（backend/ 下随包）：wb_ctx_dump.bin(280KB)、tab_a.bin、tbl_seq.json、ghash_matrix.json、golden.json。
**✅ 阶段三/四已完成（2026-10-02）**：kpl_socket.py 的 sign_local 改调 white_box_sign（返回 hex，线程安全无锁）、socket_signer_available 恒 True、Java 全家（_find_java/_WarmSigner/_sign_lock/SIGNER_DIR）删除；package.json files 剔除 `backend/signer/**`（26MB）改收 5 个常量文件（**包体 26MB→837KB**）；热改部署+重启后端实测：/api/kpl/tika（socket 3009+610 鉴权）与 /api/kpl/poprank（3008）均正常出数据，日志无签名报错。signer/ 目录仅开发机保留（kpl_signer_py.py 探针链在 git 历史 probe27-42），不进发布包。

**App 升级再提取 SOP**：新版 APK 出包后→重跑 unicorn 探针链（probe 流程见 git 历史 probe27-40）→重新 dump wb_ctx_dump.bin（表会变）→tbl_seq 反查→TAB_A/ghash_matrix 重观测→golden 对拍→换常量。骨架代码全部可复用。

### ⭐ 纯 Python 签名（算法级白盒逆向，2026-10-02 全部完成，逐位对拍验证）




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
| 近期活跃板块 | **✅ 已复刻（2026-09-27 mitmproxy 实锤）**：数据=apphwhq `Index/GetInfo` 的 **BaceFaceList**（恒 4 条 [板块名,涨幅,801/803板块id]，与 App 逐项一致；旧记录"走3009/GetIndexList"均错）；点击进板块详情 /api/kpl/sector/{plate_id}。**板块详情 v2（同日，用户反馈对齐）**：2501 股票池**按涨幅降序本地排序**（App 默认同）+名称两级兜底（插件缓存→market_pool.get_name 全A股表）零缺名+概要条对齐 App（**quotas 列锚定自校准法：用 App 概要显示值对池内 quotas 逐列求和反推列号——q9=主力净额(6.69亿≈App6.71亿)、q21=涨停封单(2.05亿✓)、q3=成交额(103.49亿✓)、涨停数=池内涨幅≥9.8 计数(3✓ 与 App 一致)**；强度/排名/大单封单无数据源如实缺席）。**App 分时图/机构纪要/要闻/股票筛选=socket 专属协议未逆向（二期）**，页面占位"开发中"；mitmproxy 抓包证实板块详情页无任何 HTTP 请求（全 socket） |
| 风向标/人气榜 | Socket 2126 QxWindVane / 未定位到 HTTP | 二期 |

- **排查工具**：App 全量接口注册表已提取到 `kanpan_spec/captures/api_registry.json`（1015 对 c/a，从 ox0/j00 dump 按"相邻 const-string 对"解析）；多域轮询探测脚本 `tools/probe_home2.py`（Token 从 `stock-data/config.json` 读，5 域轮询找 class 所在域）
- **主题机会页**（`GET /api/kpl/themes?tab=themes|calendar&index=&st=`）：双Tab同端点 `ThemeNews/GetList`（apparticle），**Type=-1=最新主题、Type=3=投资日历**（mitmproxy 代理对 apparticle 域有效——ART/LHB 域无 pinning 可抓，apphwshhq 域有 pinning 抓不到）。主题条目 `Stocks` 按 `SetTop=1` 优先展示前4只（2×2）；日历条目 `ColorType` 1红=事件 2橙=会议。分页用 Index（0,1,2…st=30/页）；`dex 里 bj 类` = ForumsTuyere 论坛仓库（GetEvnArt/AddFocus 等，主题收藏/关注用）
- **主题详情页**（`GET /api/kpl/themes/{news_id}`）：`ThemeNews/GetInfo`（apparticle，参数 `NewsID`+`Type=0`）。Info 含 `Content`(HTML正文)、`ZSCode/ZSName/ZSDesc`(主题介绍卡)、`Stocks[{Code,Name,Rate,Desn公司简介,IsSel}]`；`TiCai/ReaderCount`(appres) 是阅读计数上报可忽略。前端 KplTab 下钻用**栈(drills)**实现逐级返回，底部导航切换时清栈

### ⭐ 行情菜单二期（2026-09-30 全 tab 数据源逆向+订阅器落地）

**App 行情菜单 7 tab（板块/个股/港股/打板/情绪/直播/全球）数据源全部 socket**（mitmproxy 双重实锤：板块/个股 tab 停留+下拉刷新 HTTP 零流量）。行情页类图（dex 实锤）：`newindex/stareplate/` 包 = StarePlateFragment(容器)/StockFragment(个股)/HKFragment+HKStockListFragment(港股)/PlateFragment+PlateListPresenter(板块)/PatternFragment(打板)/MarketLiveFragment(直播)/MarketMoodFragment(情绪)。

**订阅面架构（`backend/kpl_marketfeed.py` 新模块）**：
- `kpl_socket.Session` 增 `sub_cmds/sub_latest/_feed_push/_feed_frames`：drain 线程与 RPC 接收路径把**订阅 cmd 的帧**入库（3 秒窗口内同 cmd 帧归入同组 parts——大快照分帧到达，旧实现只留最后一帧导致 items 只剩尾段）；其余推送仍丢弃防缓冲堆满。`KplSocketAPI.subscribe/ensure_session/get_push/push_ages`；会话重建时自动重发 desired_subs（订阅随连接走）
- pb.Empty 订阅族 **2100-2126 全家族 13 cmd + 3004/3007 带参订阅**：订阅后服务端持续推全量快照（**盘后也推**，18:4x 实测）；`GET /api/kpl/marketfeed` 一次返回全部语义化快照（20s 缓存）；keepalive 线程 25s 巡检数据龄，停滞自动重发订阅帧
- **⭐ ASCII 前缀剥离必须用 mini 头 bytes[2:4] 长度（权威）**：2106 前缀=`hqDaban|133:20010/2106-0/0`（26 字符，尾部多参数回显"0"），regex 剥到斜杠会错 1 字节整帧报废
- **⭐ 3003 主指数分时 time 格式=HMMSSmmm**（93000000=9:30:00.000，1 位小时+2 分+3 毫秒），//10^5=930→09:30

**各 cmd 定案（字段号经 2026-09-30 样本逐个解析）**：2100=打板情绪条(涨停52/昨57·封板率81.25/87.69·跌停9/10)；2101=市场雷达(items: 状态"封涨大减"+内容"涨停封单大幅减少1574万元…"+个股+时间戳)；2106=量能(f9 总额/f5 汇总文字"14379亿(2.04%,增量287亿)"/f10 分钟序列)；2107=涨停形势(11 数值+文字)；2108=权重表现(拖累股/评语/领涨跌行业)；2109=北向(净额/评语/披露口径)；2110=涨跌统计(zt/dt/realZt/realDt/rise 2567/down 2823/sign"市场人气较好"+zdList 分布——与 App 直播 tab 数字逐位一致)；2111=温度提示(f6 文字"情绪指标过高(75)…")；2114=涨跌分布今昨双快照(±11 档)；2115=总览(沪深成交 1.437 万亿/情绪 0.41"不活跃"/预估 14502 亿)；**2116=涨停家数分钟序列(f10)+分时收益曲线(f12/f21)+盘面播报文字(f20 "15:00 三大指数全天分化…"——直播 tab 播报源)**；2117=连板天梯(7板新华传媒/4板襄阳轴承/3板×4/2板×6)；2126=风向标 up3+down3(涨幅+板块)；2121=涨停股票列表(带参 QxZtSituationStockReq{bsType1,orderType2,sortType3}，参数枚举待盘中校准)

**个股 tab（StockFragment→common/quota/StockRangeListFragment+RealTimeChartsPresenter）**：数据=**3004 HQList.SubRealtimeLHB 订阅**（LHB=LeaderBoard 非龙虎榜！）+**3101 GetRealtimeLHBRangeData 区间拉取（时间轴回放，startTime/endTime=HHMM 整数如 925/1500——App 从时间轴控件字符串 replace(":","") 解析）**。Req{quotaType1,sortType2,cxType3,limitType4,stType5(沪),zbType6,cybType7,kcbType8,bjsType9(北交,App 取反=过滤开关),indexType10,start20,count21}；Resp items41=GroupStockQuotasResp.Item(quotas f100 动态列)。**实测盘后：初次订阅推一次头部(total=3403 全市场✓)无 items——items 为盘中增量推送**；App 盘后显示=KPL_CACHE 本地缓存，插件从下一交易时段起积累（前端已如实提示，勿造数据）。参数枚举（DynamicQuotaBean.getServerType/getServerSort 从本地 DB 读）待盘中用 App 截图锚定

**板块 tab 表格（PlateListPresenter 字节码实锤）**：数据=**3007 HQList.SubPlateTypeQuotasList 订阅**，Req{quotaType1,sortType2,plateType3(精选/行业),start4,count5(30)}；Resp Item{plateId1,plateName2,**strength3(强度)**,incRate4,incSpeed5,tur6,**mainNetAmount7(主力净额)**,mainBuy8}——强度/主力净额列就在这（盘后静默待盘中验证）。~~RealRankingInfo 是板块强度表~~已证伪：HTTP `ZhiShuRanking/RealRankingInfo`(apphwshhq) Type=12/13/14 只返回 801 板块的市值/PE 静态列（Title="第二季度机构增仓/2026PE/2027PE" 是**滑动附加列**），无强度/主力净额；j00.Y 签名=(Type,ZSType,Index,st,Order+RStart/REnd/Date)

**直播 tab（2026-10-03 1:1 重推翻旧合成版）**：App MarketLiveFragment 实拍（kpl_ref/mood/lv2~lv6）=**全宽上证分时图 + 全天播报时间轴流**，无统计模块（旧版拼的 2110/2114/2115 模块删除）。播报条=时间(红)+竖线+正文+**关联标的 chips 两列**（板块+个股混合，App 端无此数据——LiveNewsEntity 字节码实锤仅 {time,comment}，chips 是**客户端文本匹配**本地 STOCK 表 13843 名称+板块名，涨跌幅取内存快照）。插件同机制：`/api/kpl/livenews`（get_live_news_feed）——名称反向索引=market_pool._names(5247)→**兜底打包表 backend/static/kpl_stock_names.json**（从 App KPL_CACHE STOCK 表导出 13690 条随插件发布，key={code:name} ⚠️需反转；market_pool 依赖东财名称接口限流期恒空故必须兜底）+kpl_plate_names.json(names 键下 1568 板块)；匹配 nm in comment；匹配股**并发 6 拉 GetStockPanKou**（App 同源，绕 _rate_wait；09-30 实测善水+20.01/大金+7.83/万科+4.41 与 App chips 逐位）只收 `^\d{6}$` A 股（"风电"误命中港股简称已滤）；板块涨幅仅 WeightPerformance SZ/XD 有的补。**坑实录**：①勿持 market_pool._lock 遍历（pytdx 重连循环持锁死等 60s+）→dict() 快照；②空索引 [{}] truthy 缓存致永远匹配落空→非空才缓存；③mood/缓存结构变更须版本校验（zdtj.raw 键）；④构建异常走 debug 不可见→提级 INFO+format_exc（f-string 内勿写 
，会成真换行语法错误——坑①再现）。休市当日数据不变→kpl_livenews_cache.json 磁盘缓存；盘中 TTL 120s 重建（PanKou ~100 只 6 并发 10-20s，后台线程 building 标志前端 3s 重拉×6）。前端 KplLiveSub 整重写（kpl-lv-* CSS：时间线+白卡+chips grid 2 列）

**港股 tab**：HKFragment/HKStockListFragment/GetHKIndustry_Ranking/GetHKSubject_Ranking 已定位（api_registry），协议未逆向（三卡恒指/国企/恒生科技疑=3006 传 HK 指数 id），页面骨架占位

**坑（本轮实锤）**：① 3004/3007/3101 带参 cmd **盘后完全静默**（连 110 错误都不回）但**不踢线**——勿把静默当参数错反复盲扫；2100-2126 pb.Empty 族盘后照推；② 曾误判"会话 1s 被踢"为 3004 帧触发——实为 8765 后端进程同 device 互踢残留，**排查互踢先杀 8765 再测**；③ ~~服务端对同一会话重复订阅 3004 只推一次~~ **已推翻（2026-10-08）：同会话重订换参数立即生效**（2121 换 bsType 秒回新列表），此前"只推一次"是参数没变服务端推同内容；④ DSH 看门狗杀进程后可能不自动拉起（状态卡 running）——手动 DETACHED_PROCESS 拉起 uvicorn 后 DSH 经 isAlreadyRunning 复用

### ⭐⭐ 行情菜单零数据排障（2026-10-08 盘中，两个根因全修+观测/自愈体系落地）

- **现象**：10-08 复市开盘 个股/板块/打板（情绪/直播也波及）全空。`_meta.ages={}`、drain 收到字节但 `try_parse_frame` 一帧都啃不动、磁盘 kpl_marketfeed_cache.json 从未落盘
- **根因一（主）：服务端推流帧格式变了（新 0x60 格式）**。drain_buf 头采样实锤：`60 0000005f 00 19 "hqDaban|134:20010/2115-0/" + protobuf`——新推帧=`[0x60][total4 大端][0x00][前缀长1B][ASCII前缀][protobuf]`，total=0x60/total 域之后全部字节数，**cmd 从前缀 `/(\d{3,5})-/` 提取**（2115），不再有 kind4 的 seq/cmd 头；旧解析器把 0x60 当 kind6 也不会匹配→一帧不解析→全流报废（曾累计 1.3MB 全废）。**修法**：`_feed_frames` 双格式解析（0x60 魔数优先，防旧解析器 kind6 误吞）+ body 合成 mini头（`1b03`+BE16 前缀长+前缀+proto，与旧 kind4 body 布局一致 parse_cmd 零改动）+ 失步重同步（双格式都败→`find(0x60)` 跳字节）。离线单测全过（净流/垃圾前缀/半帧续读）
- **根因二：会话"可鉴权但不推送"形态 + 同账号单推送槽**。独立探针对照实验：探针会话订阅秒回（首推<1s，25s 收 55KB），后端会话同服务器同账号却零推送——**同账号服务端只给一个会话推流，后鉴权者抢走，输家 TCP 保持可 RPC 但被静音**；半开会话（进程被杀服务端未察觉）也占槽。10:09 的探针把后端顶哑、后端重建又抢回来，交替拉锯。**修法（自愈三件套）**：① keepalive 盘中（trade_calendar 判定）订阅集已发但 sub_latest 全空连续 3 轮（75s，新会话 60s 首推宽限）→ `recycle_session`（close+`_last_good_server=None` 强制全表重扫换节点）；② keepalive 发现会话缺失时自动 `ensure_subscribed()` 重建（勿用裸 ensure_session——带参订阅只在这里发）；③ `/api/kpl/feeddebug` 观测端点（remote/收帧量/drain 线程/订阅集/推送龄/seen_cmds 直方图/err110/drain_buf 头部 hex 采样）+ `?sub=cmd&bodyhex=&wait=` 在线标定动作（在活会话上发订阅帧等推送——**标定必须走后端自己的会话，独立探针会同账号抢槽**）
- **根因三（3004 个股表专项）：RealtimeLHBReq 字段号错**。hq.proto 全字段表从 dex 内嵌描述符提取（`Hq;<clinit>` const-string 串）：`quotaType1 sortType2 cxType3 limitType4 stType5 zbType6 cybType7 kcbType8 bjsType9 indexType10 **start14 count15 startTime16 endTime17**`——旧版 start/count 用了 20/21（臆造），服务端静默丢弃。改为 14/15 后 feeddebug 标定 `0801100170007832` 立即回 302B 头部（total=340）。**items 仍不增量下发**（头部到了行不来，待续）；
- **标定结论（盘中实测）**：2102 filter 全 0 ✓ 推；2121 `{bsType1,orderType2,sortType3}` bsType=1..6 全推（bs1/bs2 ~12K、bs3 6.6K，打板页竞价/即将涨停疑=bs2/bs3，换订后 parse items=0 待查载荷形态）；**3007 PlateTypeQuotasList 字段号虽对（1/2/3/4/5）但 quotaType/plateType/sortType 全值域扫描（0/1/2/3）+ 邻号 3005/2104/2105 全静默**——板块强度表仍无解；2103 DaBanStockListReq pidType 0-5 全静默（字段号经 proto 表核对无误）——打板竞价/即将涨停列表仍无解。hq.proto 全消息字段表已落 kanpan_spec/tools/out_shq.txt（从 classes2 dex 内嵌 descriptor 提取，后续任何 socket 请求体构造先查此表勿再臆字段号）
- **排障方法论新增**：① 推流问题先看 drain_buf 头部 hex（观测端点直出）再猜；② "会话活但零推送"≠会话死——先 feeddebug 对照独立会话；③ 同账号多会话（自己的探针/模拟器 App）会互相抢推送槽，**联调期别开第二个同账号会话**；④ dex 内嵌 proto descriptor（socket/data/ServiceXxx 类 <clinit>）是字段号权威源
- **⭐ 3007 专项（10-08 下午，结论：从未工作过+非参数问题）**：① 查旧记录"盘后静默待盘中验证"——**3007 在插件史上从未成功收过数据，今天不是回归**；② 从 PlateListPresenter/PlateQuotationChildPresenter 字节码还原 App 请求构造：`{quotaType:1, sortType:1, plateType:<ctor 参 1精选/2行业>, start:0, count:30}` → `0801100118012000281e`，**与我们发送的逐字节一致**，App 实测盘中出强度表（锂电池 4441/33.60亿…）；③ 服务端对我们同账号同服务器的会话**任何形式的 3007 帧都不回应**：kind4 订阅/RPC、flags=0/1（App f(true)=1 已试）、0x60 新格式请求（raw60）、全值域、邻号 3005/2104/2105、3101 RPC、device_id 换成 App 的、AuthReq 补 curTime——全排除；④ 剩余唯一可观测差异在 App 会话内部状态（App 主进程对 frida 隐藏——attach 报 process not found，看门狗杀注入），破案需 App wire 抓包：frida-gadget 重打包 / LSPosed 模块 / root 真机 hook 三选一；⑤ **板块 tab 回退已接真数据**：/api/kpl/active-plates（Index/GetInfo BaceFaceList，与首页块同源）行内点击下钻板块详情；⑥ 顺带实锤：3004 RPC 形式响应前缀=**`hqList|134:20030/3004-0/...`**（各族前缀标签不同，0x60 解析器已放宽为任意 `|` 前缀）
- **⭐⭐⭐ 强度表数据源破局（10-08 晚，3007 绕过，HTTP 组装同源数值）**：App 强度表全字段在 HTTP `ZhiShuRanking/RealRankingInfo Type=12 {ZSType:3, Order:1}` 里——**Index 参数=行偏移**（st=80，Index 0..~52 逐页推进每页 +1 新行，~52 请求抓全 132 行）；行字段与 App 截图逐位对拍：**f2=强度**（锂电池 6290✓ 石油石化 3210✓ 并购重组 1377✓）、f3=涨幅%、**f6=主力净额**（锂电池 34.49亿✓）、**f14=第二季度机构增仓**（-204.86亿✓）、f15/f16=2026/2027PE。默认序=强度降序。子板块=**SonPlate_Info{PlateID}**（[id,名,强度]，固态电池 5956.958≈App 5956），父行下嵌缩进子行。落地：`get_plate_strength()`（直连批量绕限速+磁盘缓存 5min+SWR+top8 父板块并发拉子板块嵌行）端点 /api/kpl/plate-strength；折叠行频道化：**盘中=盘中雷达（2101）/盘后=尾盘抢筹（`StockBidYiDong/GetWPQCIndex`@HQ，List=[打码代码,打码名,0,0,金额,0,ts]，App 文案「尾盘抢筹 10-08 **** 挂单抢筹5317万」=max(金额)/1e4，端点 /api/kpl/wpqc）**；表格第四列=第二季度机构增仓。**坑：分页 Index 不是页号是行偏移；st>80 服务端异常截断为 8 行；批量抓取必须绕 _rate_wait（92 请求×2.5s=4 分钟）**。遗留：行业 tab（plateType=2）数据源、子板块行主力净额列、3007 本体（已无必要，HTTP 通道同源等效）
- **⭐ 板块 tab UI 1:1（10-08 晚，布局全量重写 07ec016）**：KplPlateSub 按实拍 app_plate.png 重建——顶部横滑卡（沪深创可点切换+卡底圆点/沪深京预测量能卡/涨跌家数+涨跌停比卡，涨跌染色底）→**折叠频道行**（盘中雷达/尾盘抢筹，点击展开全量）→精选/行业 pill（红底选中态）+多日统计/板块叠加/历史三入口（func_pending 占位）→强度表（**强度列浅蓝 #eef4fd 高亮+红▼排序箭头**，主列 强度/主力净额/机构增仓，子板块缩进树）→**底部历史统计时间轴**（深色 sticky 条 09:25/11:30/15:00 刻度+双滑点+⇄历史统计入口，回放协议未逆向占位）。删掉 App 没有的涨停板/封板率/跌停板灰卡行。坑：**实拍导航必须每步 dumpsys window 验焦点**——模拟器多次发现焦点在桌面（kill 守卫后主进程重启把 App 掉后台，tap 全点空）
- **⭐⭐ 模拟器抓包环境实录（10-08 傍晚，两条关键环境坑+frida 对抗现状）**：① **遗留全局代理坑**：模拟器 global http_proxy 一直指着宿主 8888 的旧 mitmdump（10-04 遗留），App 全部 HTTPS 走代理且 CA 不被信=请求全失败吃缓存——`settings put global http_proxy :0` 清除后 App 直连恢复（124.71.166.244:**17000** socket+多条 443 即现）。**以后 App 数据异常先查 `settings get global http_proxy`**；② **frida 对抗演进**：同日清晨 attach 真身（frida 视图名"开盘啦"）尚可成功（0.21s），傍晚起 enumerate 返回的 pid 变蜜罐（attach 恒 process not found），ps 真实 pid 也 hidden，仅守卫子进程（ppid=main）可 attach；杀守卫后主进程 0.2s 窗口可 attach 但随即自杀；spawn 法被壳换进程绕过。**当前结论：该镜像 frida 动态分析已被看门狗封死，App wire 抓包走 frida-gadget 重打包/LSPosed/root 真机三选一**；③ NativeCrypto.SSL_write/read 与 SocketHelper.sendPacket 均 hook 成功但零调用——TLS 在 App 自有 native 层（libssl.so 静态符号不可见），protobuf parseFrom 全族 hook 亦零命中（导航失败期），下轮重试需以 dumpsys 焦点验证导航有效性后重测
- **⭐ 板块 tab 轮播行实测（10-09 盘中，模拟器滑动探索实锤）**：折叠行=**横向轮播 4 卡**（ViewPager 式，默认第 1 张，左右滑切卡）：①盘中雷达（收起态=标题+最新一条 时间红/股名蓝/状态红）②市场雷达（展开明细列表：时间+股名+状态红+正文灰，如「10:04:42 向日葵 涨停回封 当前封单3.08亿」=2101 同源）③尾盘抢筹（展开列表「10-08 **** 挂单抢筹5317.76万/3663.83万/3123.80万」=GetWPQCIndex List 逐位）④竞价异动板块（展开列表「通信 竞价爆量 8倍 异动金额3.94亿」=GetBKJJSearch，竞价时段数据、盘后 List 空）。顶部卡区=横滑指数卡流：沪深创/沪深京预测量能/涨跌家数/**微盘股/科创50/北证50/上证50/沪深300**（指数卡点位源待接：GetStockPanKou 指数 id 返回 ETF 级价位，指数点位需另源）。前端 KplPlateTicker 4 卡 scroll-snap 轮播已落地（7f9c059）。**坑：模拟器滑动探索时 swipe 手势会被 tab 页横滑容器吃掉切到隔壁 tab（滑距过长），短距滑+每步截图验焦点**
- **⭐ 顶部指数卡数据源攻坚（10-09，未破，记录全部排除项）**：App 顶部 8 卡后 5 张（微盘股/科创50/北证50/上证50/沪深300）=指数点位卡。已定位消息：**ServiceAppGlobal/SubMainIndexQuotas (pb.Empty) → MainIndexQuotasResp{items:[{id,name,price,incPrice,incRate}]}**（appglobal 族，同族实锤 3008 PopRank/3009 ThemeList/3011-3012 避雷）。qn0.w 分发器 sparse-switch payload 含 3001-3012 全 case（androguard get_raw 拿不到 targets，cmd 未最终定位）；**3010 探测无响应**（会话健康+订阅已发条件下，feeddebug sub/rpc 双模式）。3002 RPC=指数快照但仅固定回 沪深创 3 条（global| 前缀，f1=SH000001 f3=点位×1e4），传参不支持。3003 currNums 只认 [0,1,2]，扩展无响应。GetStockChart/GetStockPanKou 指数 id 返回 ETF 级数据。结论：与 3007 同症（服务器拒答本插件会话的特定 cmd），需 App wire 抓包定 cmd 后接入。插件已渲染 5 卡槽位（名称+--）
- **✅✅ 指数卡真数据落地（10-09 午后，破案）**：**数据源=socket 3006 `ServiceHqList/SubIndexSimpleQuotas`：HQStockIdListReq{stockIds[] repeated string} → IndexSimpleQuotasResp**（`hqList|133:20030/3006-0/` 前缀）——此前只试过 pb.Empty 空参所以无响应！传 `SH000688/SH000016/SH000300/BJ899050` 一次拿全 4 指数。Item 字段：f1 id(str) f2 name(str) **f3 点位×1e4(varint)** **f4 涨跌点×1e4(varint，int64 溢出需转符号)** f5 涨跌幅%(float，proto3 缺省 0 不序列化)。实测 1401.24/-55.08/-3.78% 全字段实时。落地 `get_index_cards()`（30s SWR）端点 /api/kpl/index-cards，前端 5→4 张指数卡真数据+涨跌染色（微盘股指数 id 待定保持占位）。**方法论：带参订阅接口空参试出来"无响应"≠拒答——先从 proto descriptor 找 Req 定义带对参数再下结论**

### ⭐ AI 投资分析（悬浮按钮 → 选股 → DSH 会话，2026-10-01；2026-10-07 三源换通达信/KPL同款）

- **交互流**：插件每页右下角 🤖 悬浮按钮（StockAnalysisFab，挂 WatchlistPanel 根覆盖全部 Tab）→ 选股浮层 → `POST /stock-plugin/analyze {code,name}` → 服务端创建独立 DSH 会话（出现在会话列表，标题"股票分析：名称(代码)"）→ AI 按引导 prompt 逐个调 kpl_* 工具 → 输出 ①评级(可买/观望/回避) ②理由与风险 ③建议仓位与止损
- **三源定案（2026-10-07 用户指定）**：①搜索=开盘啦搜索页同款 `/api/kpl/search/suggest`（App 全量 STOCK 表+拼音首字母/全拼，实测 xyzc→襄阳轴承；正则过滤只留 `^\d{6}$` A 股防选出港股/板块），默认态=综合热搜 `/api/kpl/search/hot` 的 stocks（带腾讯涨幅%）；②自选股=`/api/tdx/watchlist`（组 chips 只列 registered 组、默认 zxg，不再用 KPL 自选逐只 quote 补名）；③持仓=`/api/tdx/positions` 实盘内存直读（行右侧显盈亏%；tdxw 未运行显示引导提示，不再降级记账）。**kpl_position 工具同步改**：优先 TDX 实盘持仓（聚合总市值/总成本/总盈亏+positions 明细，cash=null+cash_note 防臆造），失败降级 /api/position/overview；analyze prompt 第 6 步文案同步
- **会话创建机制（dsh-better-sidebar 实战验证的宿主公共 API）**：`ctx.get("agents").create({sessionId, agentOptions:{}})` + `handle.agent.followup(createUserMessage({content:[{type:"text",text}], source:{kind:"user"}}))`（唤醒 AI 产生首回合）+ `ctx.get("sessionTitle").rename(handle.agent.session, 标题)`；`createUserMessage` import 自 `@deepseek-ai/dsh-llm`（宿主 node_modules 提供，插件无需声明依赖）。**inject 数组加 "webServer"**（property 访问必须声明；ctx.get 动态获取不需要）
- **⭐ 宿主破坏性变更（2026-10-07/08 实锤，三条硬约束——`agents.create` 插件建会话的完整姿势）**：①不传 origin——传 `meta:{origin:"plugin"}` 报 **`session header origin must be "subagent"`**（dsh-session 头校验只允许 origin='subagent' 或不传，types/index.js:55）；且 origin='subagent' 是**带父会话地址的子代理会话专用**（api-session-controller:1578 无父地址拒 followup）。②必传 `meta.cwd`（绝对路径）——header.cwd 空的会话**创建成功但历史加载报 `session/not-found`**（api-session-controller:158/396），落 `.dsh/sessions/_no-cwd` 分片 UI 打不开。③`agentOptions` 必带 `{provider, model}`——**persona 前缀引用 `{{model}}/{{provider}}`，变量取自 agent.options（agent-loop:1535），缺失时首个请求 prompt 组装抛 `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`**；UI 建的会话由宿主自动应用默认模型选择，插件必须自己带（installModelSelection 的 variables 注入只在 selected≠undefined 时生效，dsh-agent/lib/index.js:132）。**最终形态：`create({sessionId, meta:{cwd:"E:\\deepseek-proj\\stock-all"}, agentOptions:{provider, model}, })`**——cwd=股票工作区（决定会话归属工作区分片/列表，`STOCK_ANALYZE_CWD` 可覆盖）；provider/model=`readDefaultModel()` 运行时解析 `~/.dsh/settings.yaml` 的 `agent-default-model` 段（正则提取，失败 fallback 深度求值当前值），用户在 DSH 设置换默认模型无需改插件。宿主自身会话头实拍（.dsh/sessions/--工作区slug--/session.jsonl.zstd）= 无 origin + cwd 工作区绝对路径 + delegationDepth:0 + agentPreset:"standard"。**排障经验：改 index.js 后报错纹丝不动 → 先查 DSH 主进程启动时间（Get-Process StartTime，10/5 启动的进程跑的永远是 10/5 的代码）；报错串在宿主源码 grep 定位唯一抛点，坏值来源看变量/头字段是谁传的；一条链上的错误会逐层暴露（origin→cwd→model 三连），每次重启只 reveal 下一层**
- **桥 = 宿主 webServer 路由**（无需自建端口）：`ctx.webServer.register({kind:"prefix", path:"/stock-plugin/analyze", handler:(req,res)=>{...}})`（Node 原语 req/res，effect 生命周期自动 dispose）；前端**同源相对路径** fetch（client.js 跑在宿主 web server origin）
- **kpl_* 分析工具 6 个**（14 工具=8 基础+6 分析，test_apply 已同步）：kpl_quote(/api/kpl/quote) / kpl_kline(/api/kpl/kline，Stock/GetStockChart@applhb 日K 530 根含 OHLC 均线量，前复权) / kpl_timing(/api/kpl/timing，2100 情绪条+2110 涨跌+2115 总览+2117 天梯聚合) / kpl_sentiment(/api/kpl/sentiment，综合强度+风向标+风口) / kpl_lhb_seat(/api/kpl/lhb/stock 席位) / kpl_position(TDX 实盘优先/记账降级)
- **⚠️ index.js 是服务端插件：改动必须重启 DSH 才生效**（前端 FAB 只需刷新页面）；本地测试 @deepseek-ai/dsh-llm 用仓库根 node_modules junction 指向宿主包（test_apply 的 rmSync 只清 plugin/node_modules 不冲突）
- **坑**：① bash heredoc 里的 `
` 经 JSON 转义吃掉一层变成真换行写入文件——跨语言脚本注入换行转义需用 Edit 工具修正；② 宿主 API 探路先看 dsh-better-sidebar（唯一大量使用 agents/webServer 的第三方插件）

### ⭐ 全面逆向工程（2026-10-02 开工：先逆向全部功能→再按 App 复刻；纪要 kanpan_spec/docs/reverse_session_*.md）

- **方法论**：apk-reverse 技能（C:/Users/mark/.zcode/skills/apk-reverse）门禁制——G1 交付句先行、observed/inferred/unverified 证据标签、两击规则。工具链：jadx 1.5.1（**必须用 D:/Program Files/Java/jdk-17.0.2 跑，系统 java8 存根与 jadx 不兼容**；-r --no-src 仅解码资源）+ androguard dump_class.py + adb 系统级 + 自有 socket 客户端直发
- **类图资产**（ui_map/）：pages.md 页面清单（10887 类枚举，Activity245/Fragment217/Presenter105）；class_buckets.json；**DataBinding 类名=布局文件名**（78 个，避雷页 FragmentLightningProtection* 实锤）
- **⭐ socket 请求体 AES-GCM 加密机制（重大）**：`SocketRepository` native 方法（libauthSign.so）`initBaxPwd(AssetManager)`=白盒密码表初始化（unidbg 签名器当年已能跑进它，"输出空"=无返回值仅初始化，勿当失败）；`encodeAESGCMMsg/decodeAESGCMMsg` 加解密 body；开关=SR.d==1（`l(I)` 设置）；ux0.x() 加密失败回退明文有日志。**我们明文通道可用=常规 cmd 未启用加密；港股族静默的候选原因是要求加密会话**——突破路径=unidbg 里调 encodeAESGCMMsg
- **SocketRepository 请求构造全集（observed）**：2029=HKHisHQReq{stockId1,date2} 港股历史K线；2007/2024=HisHQItemReq 历史/超级历史分笔；2251=HisHQReq；402=UnsubIdReq 退订；602=LoginStateReq；610 AuthReq 多 appType9 字段。ux0$b builder：c(cmd)/d(proto)/e(kind)/f(Z)/b(Z)/g(I)
- **港股 tab（进行中）**：UI=指数卡(恒指/国企/恒生科技横滑)+题材/行业/个股三子 tab+历史+时间轴 09:25-16:10；**HK 板块 id=820xxx 体系**（820246 AI营销…）；指数卡=2106/2107 订阅+IndexSimpleQuotasResp(3006 族)（HKWithStockIndicesPresenter observed）；板块表走 socket（mitm delta=0），3007 plateType≥3 回落 A 股行业 881xxx（实测）→港股表专用 cmd 未定；HTTP GetHKSubject/Industry_Ranking {Type,Index,st,Order}（j00.P，controller=Index）五域探测未中（200 空体/9999）；新域名 appkh/vip 无路由
- **行情子 tab 自绘**：uiautomator 无 text，坐标 板块81/个股260/港股419/打板570/情绪725/直播880 y=148（1080p）
- **⭐ apktool 资源解码成功（jadx 卡死换 apktool 2.9.3）**：1322 个 layout XML 全量在 kanpan_spec/apktool_out/res/（public.xml id 映射；"资源混淆"是早期误判）。**工具链定案：资源用 apktool、字节码用 androguard dump_class.py、全 cmd↔类映射用 tools/cmd_class_map.py**
- **⭐⭐ 港股表格破解成功（2026-10-02 深夜，cmd_class_map 反查法）**：未收录 **cmd 2304**（AttachAppTimerTask.updateHKList）=港股列表 **CDN 文件下发**：请求 pb.Empty → 响应 {type=3, timestamp, url="appbimgcdn.../plate/N_hk_<ts>"} → **真实下载需补 .data 后缀** → JSON{timestamp, items:["HK:代码,名称,1,拼音,板块组,标记"]} 2932 只。已进插件：get_hk_stockfile_url+get_hk_stocks（磁盘缓存版本免重下）+/api/kpl/hk-stocks+KplHkSub 列表页。表格实时行情列（强度/成交额/市值）订阅链待盘中样本（2018-2027 族或 3006 变体）。**方法论：cmd↔类映射反查（updateHKList 方法名即语义）完胜域扫描**；前端嵌套括号错误→children 数组扁平重写
- **加密/tcpdump/港股 Type 三线进展（2026-10-02 晚）**：①App socket 会话实锤=1.94.128.64:**17000**（getsockip 动态端口）且为 TLS 包裹——tcpdump 只见心跳不可读 cmd，明文帧判定靠服务端响应行为；②加密开关 SR.l(I) 调用者=qn0.m(Ey0)（响应分发器）→证实"服务端下发信令开启"模型；③**港股 Type 枚举 4 值定案**（ALL_HK_STOCK/24H_HOT/HK_STOCK_CONNECT/AH_STOCK，getList=Type.getPidType()+ServerType+OrderBy 与 A 股同构）——港股列表极大概率是带 pidType 的同族 cmd，下轮提取 clinit pidType 值+按 2103/3004 模板扫描（港股今日开市可实时锚定）。**战略修正：服务端对明文会话不吝数据（2100-2126/2102/2014/2501 全通），港股表格静默更可能是参数未对而非加密壁垒**
- **F10 完整版进插件（2026-10-02）**：GetMainIndicators **Type 参数破解**（1142"报告类型为空"→Type=1）→ 12 指标键含年报+季度序列；/api/kpl/f10full + KplF10Sec 三子 tab（财务 38 行/主要指标/公司资料）。**个股新闻 ⏸**：CompanyNotice/CorporateNewsStockList @apparticle 六参数组全 null、GetPlateNewsList 需 PlateID 非个股——下轮从 apktool_out 反编译 StockNewsActivity
- **⭐ 个股详情三项深挖进插件（2026-10-02 晚）**：①分时成交逐笔=HTTP `StockL2Data/GetStockFenBi2 {StockID,Index,st,Type}`（fb=[[时间,价,方向,手,笔,?,?,金额]]，一次通）→ /api/kpl/fenbi + KplFenBiSec；②涨停深度块=cmd **2014** StockZTBigOrderDetailReq{stockId,type=1,count} → f3=连板文字("3连板"与 App 逐字)/f4=大单笔数/f5=封单时间序列（lbText/bigN/series 已实测）→ /api/kpl/ztbig + KplZtBigOrderSec（封单曲线）；③F10=**StockF10Basic 控制器域=apparticle**（apphwshhq 全 null——五域轮询定位）GetCompanyInfo(主营构成 ZYGCList)+GetFinanceInfo(财务行列表)，GetMainIndicators 需报告类型参数(1142) → /api/kpl/f10 + KplF10Sec。封单=买1量×价可从 quote tick 推导；"板上成交"=FenBi2 涨停价聚合（下轮）
- **⭐ 首页速度对齐 App（2026-10-02，审计 H3/M4 落地+三层缓存）**：①`_rate_wait` 锁内只记账锁外 sleep（旧持锁 sleep 2.5s 使全客户端串行，home feed 12 请求 38s）②homefeed 磁盘缓存层 kpl_home_cache.json（重启/冷启动 0.14s 秒显上次数据，App 同款本地缓存行为）③homefeed 线程池单例（旧每次新建）④prewarm 加 home 预热 ⑤前端 localStorage 秒显（刷新页面零等待）。实测：重启后 0.14s 秒回 12 模块全量、缓存命中 0.09s。App 快的本质=数据常驻内存+本地缓存，现已对齐
- **⭐ "已逆向未复刻"清单清零（2026-10-02）**：①板块强度真表（3007 platerank 槽位驱动，休市回落 BaceFaceList 活跃板块+说明，KPL_SECTORS 硬编码表已删）②直播量能今昨对比双线图（2106 series）③涨跌分布今/昨切换（2114）④龙虎榜个股席位详情+日 K 走势（GetStockChart 收盘线折叠展开）。仍开放的尾巴（协议未逆向，非"已逆向未复刻"）：港股表格（⏸AES-GCM 深坑）、悬浮球 VIP（2112）、个股详情底部五 tab（盯盘/F10/新闻协议未逆）、分时成交逐笔（GetStockFenBi2 未逆）、板块详情机构纪要（socket 未逆）
- **个股分时图已进插件（2026-10-02）**：HTTP `StockL2Data/GetStockTrend {StockID}`（App 分时图同源）→ /api/kpl/trend/{code} + KplStockDetail 顶部 KplStockTrendSec（现价/均价线+昨收虚线）。**港股表格 cmd 四轮挖掘暂挂**（ya0=Lazy 抽象/$e=协程壳/2501 对 820xxx 只回壳响应——剩余假设=独立 socket 服务器或 AES-GCM 加密通道，需 unidbg 加密突破；港股个股报价页 2017-2023 协议已在 cmd_class_map）
- **⭐ 闪电避雷已进插件（2026-10-02）**：3011 AvoidRisksReq{type1,isKph2}（type=1 开盘红实测）→ excel 附件+stWarning 五类风险(净资产/营收/经营能力/违规披露/审计)+delistingWarning(面值/市值)；3012 pb.Empty→{st,ts} 81 只 ST+退市股。使用者 LightningProtection{List,}ViewModel；端点 /api/kpl/avoid-risks + KplAvoidPage 五类 tab+excel 下载+宫格"⚡闪电避雷"入口（App 真实入口待实拍校正）。**坑：kpl_socket 里用 kpl_marketfeed.pb_tree 必须函数内延迟导入（循环依赖）**
- **⭐ 打板页四子 tab 已进插件（2026-10-02）**：前端 KplDabanSub 四子 tab（竞价/即将涨停/风向标/涨停）+2102 徽标；后端 PARAM_CMDS+2102/2103、`get_daban_lists()` 拉取式三 pidType（端点 /api/kpl/dabanlists，休市 silent）、解析器（DaBanListCountResp counts/DaBanStockListResp items20）。休市验证：2102 空计数✓、2121 涨停缓存✓、2103/3004/3007 静默=App 同款。**⭐ ensure_subscribed 并发互踢坑（新）**：prewarm 线程与首个端点请求并发进入 → 双建会话同 device 互踢 → 存活会话 sub_cmds 缺带参 cmd（ages 只有 13 个 pb.Empty）——已加 _es_lock 全程锁。**pidType 枚举 ⏸ 盘中锚定**（当前推定 1=竞价 2=即将涨停 3=风向标）
- **⭐ 2102/2103 非死代码（推翻旧结论）**：打板页四子 tab=竞价/即将涨停/风向标/涨停（ui_map/pattern/）；2102=DaBanListCountReq{filterType,filterCX,filterZB,filterCYB,filterKCB} 计数徽标（休市有响应实测）；2103=DaBanStockListReq{pidType1,sortType2,orderType3,index4,count5,cxType6,stType7,zbType8,cybType9,kcbType10}（filter=布尔 0/1，**旧"110 错误"真因=filter 全填 1 全过滤**）；2120=涨停列表（ZhangTingStockListPresenterImpl）、2121=昨日涨停——cmd_table 标注修正；2103 pidType 枚举 ⏸ 待盘中
- **域名全集**（dex 提取）见 reverse_session 文档；appkh（港股?）/vip（悬浮球?）暂无路由

### ⭐ 龙虎榜（2026-09-30 全套复刻，App 底部导航·龙虎榜菜单同源）

**数据面 = HTTP `LongHuBang`/`Business`/`Stock`/`UserBusiness` 控制器 @applhb.kaipanla.com（ApiConfig.API_LHB，App 龙虎榜下钻页是 H5：appage/w48/web/DepkDetails.html、StockDetails.html、MySub.html——抓包实锤全部请求参数）**。主列表为原生页但数据同走 HTTP（mitmproxy 324 流量全解）：

| 功能 | 接口 | 关键参数/锚定 |
|---|---|---|
| 股票榜 | `LongHuBang/GetStockList` {Day} | 万科Ａ 4.41%/净买 71384560=7138万 ✓；字段 ID/Name/IncreaseAmount/D3(1=3日榜标)/BuyIn/JoinNum/Turnover/CircPrice/Amplitude/TurnoverRatio/Capitalization；服务端序直出 |
| 机构榜 | `LongHuBang/GetAgencyListV2` {Time, Index:0, st:500}（App 参数，字节码 j00.D；Day 亦被接受） | Item 含 **FengKou=801板块id 数组（App 概念列来源）**；本地 BuyIn 降序；华是科技 2.14亿 ✓ |
| 营业部榜 | `LongHuBang/GetBusinessList` {Day} | 245 席位（自然人 75.79/73.57 ✓）；中信上海分公司 5.03亿/4.73亿/21 ✓；本地 Buy 降序 |
| 机构净买历史柱状 | `LongHuBang/GetAgencyDayList` {SDay, EDay}（字节码 ox0.U 实锤） | 按日聚合 BuyIn；App"机构净买入 10.71亿"顶部汇总口径**未复现**（候选实测 ΣV2=5.25亿/Σ\|BuyIn\|=10.36亿/DayList当日=4.04亿——插件显示 ΣV2，待与 App 同刻锚定） |
| 营业部详情 | `Business/GetOneBusinessInfo` {BusinessID} + `Business/GetNewDoStockLog` {BusinessID, Time:12, st:30, Index:0, SDay:0, Day:3, Money:5000000, Order:2}（App 抓包原参数） | Info: AssocNum 关联营业部/UpNum 上榜次数；Log 条目 money/1e4 与 App"金额(万)"逐位一致（近岸蛋白 433992.44 ✓） |
| 个股龙虎榜详情 | `Stock/GetNewOneStockInfo` {Type:0, Time, StockID} | **List[].BuyList/SellList=买卖席位**（名称/买卖额/PX 排名）；OnTimeList 历史上榜日；Time 缺省回最近上榜日 |
| 一线游资（订阅·官方组合） | `LongHuBang/GetYiXianByDay` {Day} | 分组[{Name 一线游资, stocks{Money,Num 上榜次数}}] |
| 上榜代码清单 | `LongHuBang/UpdateList` {Day} | 增量刷新判定用 |
| 我的订阅 | `UserBusiness/GetOfficev2` | 空列表=无订阅（与 App 空白一致）；订阅写=`LongHuBang/Add`（二期） |

- **历史回看（✅ 2026-10-01 实锤打通）**：三榜历史参数名是 **Time**（App 字节码 j00.G：GetStockList={Type:"2", Time, Index:"0", st:"500"}；~~Day~~ 被服务端静默忽略恒返最新——曾据此误判"历史无接口"）。实测 Time=2026-09-29：超声电子 10.01%/42228421 与 App 切日期实拍逐位一致；GetBusinessList/GetAgencyListV2/GetYiXianByDay 的 Time 同样有效（机构榜 09-29=36 只 vs 09-30=31）。App 切历史日期零 HTTP=读本地缓存（当日在线拉取、历史读缓存），插件直拉服务端等价。**get_lhb(day) 非交易日自动归一到最近前一交易日**（深交所日历，国庆请求 10-05 → 返回 09-30）；前端 ◀▶ ±1 自然日点击+后端归一，▶ 今日禁用（App 同款）
- **插件端点**：`/api/kpl/lhb?day=`（三榜合一+counts+agency_days，60s 缓存，非交易日归一）、`/api/kpl/lhb/business/{bid}`、`/api/kpl/lhb/stock/{code}?day=`、`/api/kpl/lhb/yixian?day=`、`/api/kpl/lhb/sub?day=`
- **前端**：KplLhbPage（上榜数+◀▶交易日历跳日+股票/机构/营业部/订阅四子 tab+机构柱状 canvas KplLhbBars）+ KplLhbBizDetail（近三月上榜/关联营业部/历史操作表，前两行高亮=App 同款米黄底）+ KplLhbStockDetail（买卖席位表+历史上榜日）；CSS kpl-lhb-* 显式白底。入口=KPL_NAV "龙虎榜"（原有占位已实装）
- **概念列口径（✅ 已解决，2026-09-30 深夜）**：App 用 GetAgencyListV2 的 FengKou 801 板块 id 数组 + **KPL_CACHE STOCK 表翻译**。实锤：从模拟器 KPL_CACHE 导出 STOCK 表 TYPE=1 板块行 **1568 条官方名表**（801159=机器人概念、801199=汽车零部件、801004=锂电池），落盘 `data_dir/kpl_plate_names.json`（板块名稳定不过期）；华是科技"机器人概念/AI应用"与 App 逐位一致。**FengKou 数组顺序≠App 显示顺序**（App 按当日概念强度挑前 2，插件按数组原序——同集可能异序，待盘中校准排序规则）。**801159≠AI应用**（插件旧 KPL_SECTORS 猜错）。接口源：`ZhiShuRanking/SonPlate_Info {PlateID}` 返回子概念 [id,名,强度]（可遍历补新板块，行业种子 × 一层 ~200s，种子版在 _build_plate_names）；⚠️ PlateTCConfig 的 58 个 id 是无子板块另一族不可作种子；⚠️ GetFengKList 概念串口径不同弃用；RefreshStockList_W8 等同步接口已不存在（9999），官方名表只能 App DB 导出或遍历构建
- **订阅 tab（✅ 三子页已实现）**：`UserBusiness/GetDay {Day}` = **游资分组体系**（TList: 3顶级游资/2一线游资/4知名游资/5机构/1庄股 + List 分组成员=订阅对象当日动态，无订阅全空=App 同款）；`UserBusiness/GetOfficev2` = 我的订阅营业部；官方组合=GetYiXianByDay。端点 `/api/kpl/lhb/sub`，前端 KplLhbSubTab 独立组件（修括号教训：深层三元嵌套改抽独立组件早 return 扁平写）。**LongHuBang/Add {StockID}** = 订阅个股龙虎榜提醒（errcode=0 实测；**取消接口不存在**——Del/Delete/Cancel/Remove 均 9999，测试账号 000678 订阅无法程序化撤销）
- **待办（剩余）**：①机构净买入汇总口径锚定（同刻对 App）②概念排序规则（App 按强度挑前 2）③悬浮球"会不会上龙虎榜"（LhbWillItGoUp 包，VIP 预测）④个股 K线/分时叠加（GetStockChart/GetBusinessChart）⑤订阅写 UI（App 内操作）



### ⭐ 首页宫格体系 1:1（2026-10-04 逆向：功能位配置表=权威源，映射文档 kanpan_spec/docs/home_page_map.md）

- **功能宫格 40 项官方配置实锤**：App 本地 KPL_CACHE 库 `SEARCH_FUNC_STOCK_BEAN` 表（root 导出）=搜索页/宫格的权威配置：ID/FUNC_NAME/FUNC_IMG(CDN 图标)/ANDVID(0=H5 webview，>0=原生 Activity)/ANDVURL/JUMP_TITLE/ALIAS(搜索别名)。40 项全列落盘 `backend/static/kpl_func_grid.json`（app_only 标记 6 项 App 账号功能：功能介绍/我的客服/兑换码/消息提示/积分商城/我的特权）。`GET /api/kpl/funcgrid` 直出。
- **下钻分发改前端 route(id)**：复用已有 13 页（实时龙虎榜/市场情绪/题材库/快讯/最强风口/风向标/市场风口/人气榜/严重异动/避雷啦/我的版面/全球指数/大盘直播=直播页），新增 5 页：**KplFuncGridPage**（4 列宫格 40 项 CDN 图标）、**KplRadarPage**（市场雷达=marketfeed 2101 items 时间线）、**KplNorthPage**（沪深港通=NorthboundFundsB+停发口径说明）、**KplNoticeCenterPage**（公告中心=快讯聚合 50 条；⚠️ CompanyNewsReportList 实测 StockID 必填无全市场流）、**func_pending** 占位页（大宗交易/百日新高/互动易/涨停委买/板块竞价异动/尾盘抢筹/板块叠加/复盘啦/商品现货/区间统计/ETF/业绩披露/股东追踪——ANDVID 原生页协议未逆向，骨架+空态）。
- **首页新增「全部功能」入口卡**（风向标模块前）→ funcgrid 下钻。
- **⭐ 首页 12 信息块 1:1 精修（2026-10-04，历史实拍 home_s1~s9 逐块对照）**：①最新主题=左色块大卡（红/金渐变 badge+标题两行 clamp+2 股价 chip 灰底）②最强风口=标题+蓝日期徽标+四列表头(股票名称/强度/涨跌幅/板块)+3 行+「🔓解锁查看更多数据」红字行（qd 返回补 day 字段）③**AI快讯=深色大卡**（黑底#1a1a1a 白字+时间红+首条全文+底部「来源：xx｜AI解读」，次 2 条摘要行）④人气榜=大卡×3（名次方块红/橙/黄+名称代码+涨幅+🔥人气值+排名变化↑↓+板块 chips+desc 全文灰字 clamp3）⑤情绪量能行接真数据：**MarketCapacity Type=1(上证)/Type=4(沪深京)，trends 末条 [cur,yes]=今日/昨日此时，昨日总计=HIS 单日 last**（home feed 新增 capln 字段异步计算）⑥明天炒什么=H5 热更页不在 dex（同最强风口旧案），⏸10-08 抓包。
- **184 个原生 Activity 全清单**已解（androguard manifest，见 docs/home_page_map.md 附带 grep 命令）；App 首页 webview 本轮持续 ANR（互踢+主线程卡死）动态实拍受阻，首页模块顺序以默认版面（此前各模块已逐一复刻）为准；「我的版面」抽屉（PagerManagerFragment 排序管理）待 App 恢复后补实拍。

### ⭐ 个股详情页 1:1（2026-10-03 实拍 sd3~sd13，App=readtab/ui/activity/StockQuotationActivity）

- **页面结构（实拍定案）**：红头（◀开盘 logo + ◀▶ 同列表切股 + 融/板块 tag + 代码 + 🔍）→报价头（左大价+右 3×4 字段）→主力净/买/卖行→消息速递（涨停原因）→**左右横移两页**（页1=分时+右栏五档/分布/委托 tabs+分时成交；页2=K线：日/周/月/年/60/30/15/5 分周期+MA+成交量副图+主力净额副图+筹码+区间统计手势）→关联板块卡（group_tag）→**大 tab 区：盘口/盯盘/F10/涨停原因/新闻**（可横滑出 公告/机构纪要/研报/机构持仓——接口未逆向）→底部工具栏（▲/上证指数/预警/龙虎榜/笔记/加自选）。
- **数据源映射**：报价头+盘口+盯盘=**GetStockPanKou**（已有 get_pankou：high/low/open/avg/换手/量比/振幅/涨跌停/内外界/市盈/市值/流通/amount_in/out——盯盘主力买卖占比即 amount_in/amount，实拍净额 1.45 亿与插件计算一致）；分时=GetStockTrend（已有）；K线=Stock/GetStockChart（已有 /api/kpl/kline，close[i]=[open,close,high,low] 530 根）；分时成交=GetStockFenBi（已有）；F10=StockF10Basic@apparticle（已有 f10full）；涨停原因当日=PanKou.ZTReason（已有）。**缺口第二轮逆向（2026-10-03 晚，ox0 全 action 扫描+批量实测 8 接口一次通）**：
  - **涨停原因历史**=`LimitResumption(HisLimitResumption 历史)/KLineZhangTingReason{StockID,Date}`（HQ=今日/HIS=历史；info={reason 概念串,bfreason 概念解析,autoLt,tiCai,group,sonTiCai}）——09-30 康希诺 reason 与 App 涨停原因 tab 逐字同；
  - **新闻**=`CompanyNotice/CorporateNewsStockList{StockID,Index,st}`@HIS（List=["id_时间戳_标题_来源"]）；
  - **公告**=`CompanyNotice/CompanyNewsReportList{StockID,Index,st,Type:0}`@HIS（…_PDF 链接 appdata.kaipanla.com）；
  - **研报**=`CompanyNotice/ResearchFieldList{StockID,Type,Index,st}`@HIS（…_券商名_评级）+ResearchFieldGrades/ResearchFieldExcel；
  - **F10 子接口族**=`StockF10Basic`@apparticle：BigReminderW43(大事提醒)/GetCompanyInfo(公司资料 ZYGCList 主营构成)/GetFinanceInfo{StockID,State:1,Type:1,DL}(财务 10 期)/GetDividends/GetValuation{StockID,year,key}/GetConceptw23+GetConceptTopic(概念)/GetIndex；
  - **⭐ F10 全家桶定案（2026-10-03 深夜二轮）**：`StockF10Basic/GetIndex{StockID}` **一个接口返回全部六宫格数据**={Concept 概念+解析, ConceptOther, Topic 要点, Company{ZL:[地址,行业,主营]/CP 主营构成}, Finance{GJZB_YYSR 营收/GJZB_KFJLR 扣非/GJZB_JLR 净利/YLNL_JZCSYL 盈利能力+Date/YuQiType}, Record 业绩预告, YJPL 业绩点评(含 HTML)}——**数据在顶层无 info 包裹**（实测；⚠️ 与同控制器其它接口相反，首测误读 info 层致全空）。实拍 f10_4~f10_13：六宫格=操控必读(红选默认)/大事提醒/概念题材/公司资料/股本股东/财务分析；大事提醒=时间线(日期+标题+内容，龙虎榜蓝字+净额)；公司资料=详细资料行+主营构成表；财务分析=指标 chips+各指标序列；股本股东=股东人数柱线图（**序列通道未在 GetIndex 中，⏸10-08 抓包**）。落地：KplF10Sec 整重写（kpl-f10-* 六宫格 pills+五子页；extras 经 window.__kplSdEx 传递+exTick 触发重渲染）；GetConceptw23/GetConceptTopic 为单接口版（已并入 GetIndex 不再单独调）；
  - **主力监控**（盯盘子 tab）=`StockYiDongKanPan/StockMainMonitor{StockID,Money:300000,Sort,Type,Order,Index,st}`@HQ——**errcode 1018 未订阅=App VIP 功能如实标注**；趋势版 GetMainMonitor_w30/GetMainMonitor_Trend_w30{StockID,Money,IsBS,(Time),Date}；
  - **机构持仓**=HisHomeDingPan/InstitutionalPositionsInfo 系（StockInstitutionalPositions/InstitutionalShowDate/StockHoldingFund/FundManagerDetails{MGRID}）——实测需正确 Season 参数（盲试 null，⏸10-08 抓包 Season 格式）；
  - **落地**：`/api/kpl/stockdetail/extras/{code}`（8 路并行 300s 缓存）+前端大 tab 扩为 盘口/盯盘/F10/涨停原因/新闻/公告/研报 七个（涨停原因=当日 PanKou+历史 reason/bfreason 双卡；新闻/公告(可点 PDF)/研报=列表）；
  - **仍缺（HTTP 层未定位，10-08 抓包）**：筹码分布（StockChip/StockChipDetail/StockChipRealTime 实体在 readtab 但无 ox0 方法——可能客户端算法或独立控制器）、逐笔委托、K线分钟周期（GetStockChart Type=2/3/4 响应变 x/y 结构但数据空）、区间统计（RangeVolTur 实体）、机构纪要（个股版）。
- **插件落地**：KplStockDetail 整函数重写（kpl-sd-* CSS 显式色值）：红头 ◀▶ 切股（stock.list/idx 上下文）、横移 touch swipe+双指示条、右栏 tabs、大 tab 区、底栏（上证指数=mkttrend、龙虎榜=go lhb_stock、加自选=watchlist）；K线页=loadKlineChart+/api/kpl/kline（日K 周期可用，其余周期空态待 socket）；新闻 tab=AI快讯按股票过滤（App 新闻源待逆向的过渡方案，标如实）。
### ⭐ App 本地存储全景 + 非交易日展示机制（2026-10-03 root 枚举实拍，全文 kanpan_spec/docs/local_storage_map.md）

- **App 数据库存清单**：KPL_CACHE（STOCK 13843 行名称库/DYNAMIC_QUOTA_BEAN 动态列/**HolidayList 316 行节假日本地表**/PhoneList 登录凭据/搜索浏览历史）、Goods.db（商品标的）、StockGroup.db（自选分组+分时缓存）、UserRelate.db（用户/token/签到）、LHBUpdateTips/Record/TrackRecord（埋点）、cg/dim/gtc3/push*（推送 SDK）；SP=KPL_PREFS（app_switch_cache 服务端开关）+PARAMS_INFO（节假日更新戳/自选板块）；files/ 1079 个=ELF so+埋点缓存，**行情快照不落盘**。
- **关键实测定案**：①socket pb.Empty 族"盘后照推"**仅限当日盘后**（09-30 18:4x 实测），**跨天休市零推送**（10-03 marketfeed 全空实测）——行情 7 tab 休市全空的根因；②App 非交易日有数据=进程内存快照+HTTP HIS 域任意时刻可拉，非本地快照库。
- **插件落地（非交易日与 App 同款展示）**：①**marketfeed 磁盘快照层**（kpl_marketfeed_cache.json，有推送 30s 防抖落盘 7 天有效；零推送时磁盘补槽 source=disk → HTTP 合成补槽 source=http）+**`_http_fallback_slots` 合成器**（复用 get_mood_page 缓存链，与 parse_cmd 输出严格同构：dabanhead←HisDaBanHeadInfo/zdstat+zddist←MarketZDTJ(±11 桶)/windvane←HisWeatherVane/weights←WeightPerformance/ladder←DailyLimitIndex/energy←MarketSCLN trends/overview←strong+cap/zdtip←ChangeStatistics.tip/ztseries←GetLiveNews 播报/north←NorthboundFundsB）——**休市实测 11/18 槽有数据，marketfeed 4.2s 返回**；radar/ztsitu/ztlist/stockrank/platerank/dabancount/dabanlist=订阅增量类无 HTTP 同源保持空（前端空态，盘中自动恢复）；②题材库列表磁盘层 kpl_tika_cache.json；③mood 磁盘缓存 v2 结构校验（zdtj.raw 键，旧缓存弃用重拉）。至此磁盘层覆盖：首页/人气榜/题材详情/题材列表/情绪页/行情订阅面/港股/名称库/交易日历。

### ⭐ 首页严重异动提醒块+下钻页（2026-10-05 全套 1:1 复刻完成：协议逆向+协议实测+三页落地，App newindex/deviation 包）

- **页面关系（字节码+实拍定案）**：首页块「严重异动提醒 次日评估 更多›」→ **更多/重点监控都进 AbnormalAlertActivity（异动提醒页）**=概览头（指数卡4chip+全市场量能+涨跌家数+大盘直播）+日期导航（◀ 2026-09-30 📅 ▶）+预警开关 + **3 tab：严重异动/热门股偏离值/重点监控**（N8(pos)：SevereAbnormalFragment/HotStockDeviationFragment/MonitorListFragment）；「查看多次异动个股(N)」→ DeviationManyChangeActivity（沪深主板/创业科创板双 tab）。问询函件（InquiryListFragment）在独立 MonitorAndInquiryActivity（"重点监控与问询函件"），插件本轮未做页面只留了接口
- **接口族（c=StockBidYiDong，全部实测 errcode=0，样本 captures/yidong_family_20261005.json，字节码=tools/out_deviation*.txt）**：
  - **GetPianLiZhi_W46 @HQ**（严重异动 tab 今日）/ **GetYDTPZFPL_W46 {Day}@HIS**（历史）：**List_Tormorow（明日评估节，服务端拼写就是 Tormorow）+ List_Today**。行 20 字段：[0]code [1]name [2]规则简称(10日100%/30日200%/停牌核查) [3]当日涨幅(明日节=0) [4]连板文字(3连板/昨日首板) [5]触发所需涨幅% [6]预计触发价 [7]当日偏离空间% [8]当日状态(触发严重异动/未触发异动) [9]次日偏离空间% [10]概念串(、分隔) [18]异动日期 [19]现价。**首页块=List_Tormorow 前5行**（yd8 实拍：块列头=次日涨幅/触发异动涨幅股票价格/次日触发异动偏离值空间；块 tag 橙底白字、异动页 tag 橙描边）
  - **GetYDTPZFPL_W46_HisAll {Day,IsZT,Index,st[,Status]}@HIS**：近期严重异动节（List_His+List_His_Total 分页）。实测 Status=1→total 35（过滤生效）但 2/3 无效——**App 三档筛选 pill（全部/触发严重异动/被停牌）插件用行内 status_today+suspended 前端本地过滤**
  - **GetPianLiZhi_Hot @HQ / _Hot_His {Day}@HIS**：热门股偏离值 tab（16条，涨幅偏离值降序）。行 12 字段：[3]当日涨幅 [4]涨幅偏离值% [5]连板文字 [6]当日触发偏离空间% [8]概念串 [10]统计日数("10日") [11]标签(10日100%/同向异动)
  - **GetPianLiZhi_Index {ZDJK_Type:1}@HQ / _W32 {Day,IsZT}@HIS**：严重异动提醒独立页（DeviationValueActivity，筛选"全部/只看严重异动"=IsZT）。行 13 字段 [11]=**预计触发价不是现价**（yd8：善水 [11]=36.29=列头触发价，现价 35.93=[11]/(1+need%)×(1+day_pct%)——**旧 get_yidong_alert 把 [11] 当现价再乘 (1+need%) 是错的，已删**）。响应带 **Many_Num=16**（多次异动角标数）+ **ZDJKList/WXHJList**（新增重点监控/问询个股）
  - **GetPianLiZhi_Many @HQ**：多次异动页。行 11 字段：[2]**板块族 1=沪深主板/2=创业科创（双 tab 数据源，与 00·60/30·68 前缀完全相关）** [4]下一触发次数 [5]第N日 [6]3日内偏离值% [7]预计价格 [8]预计价格对应涨幅% [9]当前价格。**旧映射把 [8] 当现价是错的**（yd16 南华生物 est=13.52/estpct=8.86/px=12.42 逐位锚定）。现价下副行=当日实时涨幅（App 走 RefreshStockList_price 已 9999，插件 _pankou_batch 并发补齐）
  - **GetYDTP_ZDJK_Today/His{Day}@HQ**：重点监控 tab ✓（天普股份 09-24~10-15 与 yd17 逐位）。**GetYDTP_WXHJ_His @HQ 无参/{Index,st}@HIS**：问询函件 [code,name,日期,PDF链接]（appdata.longhuvip.com/SupPDFs/）
- **分组列头随组变（yd16）**：组名含"2次"→预计3次异动价格；含"停牌"→预计停牌价格；其余（3次/偏离值临近）→预计严重异动价格
- **插件落地（kpl.py 方法组重写，main.py 端点）**：get_yidong_home（首页块=W46明日节+many_count）/get_yidong_severe(day)（明日+今日+his 三节合一）/get_yidong_severe_his/get_yidong_hot(day)/get_yidong_wxhj/get_yidong_many（修正映射+day_pct 补齐）/get_zdjk(his,day)/get_yidong_index(day,is_zt)。端点 /api/kpl/yidong（块）/yidong/severe?day=&status=&his_index=&his_st=/yidong/hot?day=/yidong/wxhj/yidong/many/yidong/zdjk。**旧 main.py 调 kpl_api.get_yidong_many（模块函数不存在）的坏端点已修**
- **前端**：首页块恢复列头+「次日评估」蓝副标+更多›（go ydAlert）+角标 many_count；KplYidongManyPage 重写（双 tab kpl-ydm-*+第N日橙标+红字两行）；KplYdAlertPage 新页（kpl-yda-*：日期导航+预警本地开关+三 tab；**用户口径：App 异动提醒页无大盘直播条、无底部走势图卡——两块均已删**，概览尾块只留全市场量能+涨跌家数，日期导航左端小指数值=mkttrend）；路由 zdjk→异动提醒页(重点监控 tab)，两页均模块级 kplGuard
- **待办（非阻塞）**：①异动页三张表头的排序箭头交互（数据已按 App 默认序：偏离空间降序）②DeviationValueActivity（严重异动提醒独立页）未做页面（更多不进这里）③问询函件页面④历史日期节假日空列表如实展示
- **模拟器重建记录**：kpl_analysis 数据盘重置+普通模式重启成功；App 6.3.20.0 重装+账号密码登录成功（18607157160）；mitm CA 的 writable-system/remount 路线在该镜像上失败（overlayfs 不可用），tmpfs hot-mount 会搞挂 framework——**抓包路线不可用，协议实测走插件直发穷举**

### ⭐ 权威交易日历（2026-09-30 接入，深交所官方口径，法定节假日/调休全覆盖）

- **数据源**：`https://www.szse.cn/api/report/exchange/onepersistenthour/monthList?month=YYYY-MM`（深交所官方月历，`jybz=1` 交易日/`0` 休市；10-01~10-07 国庆全休、10-08 复市这类安排直接以交易所数据为准，**插件不做任何自己的节假日推断**）。模块 `backend/trade_calendar.py`（TradeCalendar：按月拉取+磁盘缓存 `trade_calendar.json` 7 天过期+过期后网络失败仍用旧缓存；完全无数据才退化周末规则）。`GET /api/trade-calendar` 返回今日状态摘要（is_trading_day/in_trading_hours/prev/next_trading_day）
- **接入点（此前全部只排周末、国庆等法定假工作日会误判"盘中"）**：① main.py pytdx keepalive"仅交易时段重试"② kpl.py home feed 人气榜 盘中 type1/复盘 type13 切换 ③ 前端首页人气榜徽标 ④ KplPopRankPage 默认 tab ⑤ 最强风口盘前提示。前端：WatchlistPanel 启动拉日历存 `window.__kplTradeCal`（10 分钟刷新+重渲染 tick），helper `isTradingNowCal()/isTradingDayToday()`（无数据退化周末规则）；个股 tab 空态显示"下一交易日: 2026-10-08"具体日期
- **遗留**：alert_engine 时间止损"5 个交易日"仍是自然日近似（TRADING_DAY_HOURS=24，与日历无关的独立简化，待后续接日历）

### ⭐ 通达信集成（2026-10-07 自选分组+实盘持仓均已上线；协议级交易逆向永久排除）

- **需求背景**：用户实际操盘用通达信手机 App，要在插件里看 TDX 的自选分组与券商真实持仓。可行性调研定案：①**协议级逆向直连券商交易服务器【永久排除】**——全网零公开先例（pytdx/TdxTradeServer 全是调官方 trade.dll 的封装，无任何纯协议实现）+ 上海 TradeX 刑事判例（破解通达信模块搭交易接口牟利，刑法285条3款，主犯获刑3年9个月）；②手机 App 云同步接口零公开先例（社区2018年尝试失败，核心通信在 .so），不走；③PC blocknew 文件直读=公开成熟格式，已落地
- **✅ 自选分组直读（已上线；2026-10-07 二轮修正 cfg 格式+别名层）**：`backend/tdx_watch.py` 解析 `tdx_install_dir/T0002/blocknew/`。**格式（本机 D:\app\tdx 实测 observed）**：`*.blk`=纯文本行"市场号+6位代码"+CRLF（'0'=深 '1'=沪 '2'=北交；旧版 7 字节二进制记录做兜底）；`blocknew.cfg`=分组索引。**⭐ cfg 格式定案（2026-10-07 修旧误）**：**严格 120B 定长记录**（云同步新版 1560B=13 条、旧版 720B=6 条，全部 120 整数倍；布局 `[0..49]=中文名GBK [50..99]=ASCII短码 其余\0`）——**旧笔记"非定长/条件预警在 592 边界"是 od 行偏移误读**，勿再引用；解析=先按 120B 切（长度非 120 倍数才退回 GBK\0 分词配对法兜底）。**⭐ cfg 位置已搬家**：云同步新版在 `T0002/blocknew/blocknew.cfg`（旧根位置 `T0002/blocknew.cfg` 被客户端移到 `T0002/gs_bak/YYYYMMDD_blocknew.cfg` 每日备份）；`zxg.blk`=自选股固定置顶；cfg 未收录的 .blk 按文件短名补充。名称兜底=打包 kpl_stock_names.json→market_pool。**数据口径=PC 最后一次云同步**（目录最新 blk mtime 显示为"云同步于"）。端点 `GET /api/tdx/watchlist?group=&quotes=1`（目录签名缓存；quotes 走 pytdx 分块60只）。前端第 10 主 Tab「🎯 通达信」（TdxTab 双段=实盘持仓区+自选分组区，CSS kpl-tdx-* 显式色值）
- **⭐ 通达信 Tab 提速（2026-10-07，用户报"自选/板块半天才显示"）**：根因=前端 10s 轮询 `watchlist?quotes=1`，后端**每次请求对全部 44 组 ~1700 只重拉 pytdx**（28 个分块），pytdx 盘后不健康时每块干等僵尸服务器扫描 20s+（实测 `get_security_quotes` 21.5s 返回空）→ 单请求 20-50s。**五层架构（照抄首页提速模式）**：①行情条目级缓存 20s（`_quotes_cache` code→{price,change_pct,ts}，全组回填=换组立即有价）②只刷当前显示组（`quotes_group` 参数，后台只收集该组过期/缺失清单）③后台单飞线程刷新（`_quotes_fetching` 标志，请求路径零 pytdx 等待）④**腾讯批量行情主源**（tencent.py 新增 `get_realtime_quotes`：qt.gtimg.cn/q=sz000066,... 0.2s/60只盘后稳定，GBK v_szXXXXXX="51~名~码~现价~昨收~...~" [32]=涨跌%；pytdx 降灾备）⑤磁盘缓存秒显（`kpl_tdx_quotes_cache.json` 5min 防抖落盘，载入 ts=0 视为过期仅兜底）。持仓区同架构：内存 60s TTL → 磁盘 `kpl_tdx_positions_cache.json`（标 stale+后台重扫）→ 冷启动首次才阻塞扫描。前端：localStorage 秒显（kpl_tdx_watch_v1/kpl_tdx_pos_v1）+ 换组 useEffect 立即拉 + stale 显示"(缓存·后台更新中)"。**实测：冷调 0.04-0.17s（原 20-50s）、6s 后行情 57/57 到位、267 只大组换组全数有价、持仓缓存命中 2.4ms**
- **⭐ 分组显示短码根因 + 别名层（2026-10-07，用户报"自定义板块显示编码"破案）**：43 组里 30 个只显示短码（51/BDT/CPO/JYC…）。**根因=磁盘上根本不存在这些组的中文名**：①2025 年各批次 .blk（02-17 一批14个/08-22/11-20 成批时间戳）是**外部工具批量导入的板块**，从未在 blocknew.cfg 注册中文名——通达信客户端自己对这些组也只显示短码（tdxw 进程内存实证：扫 QXLT 全 rw 区仅 1 处命中、周围无中文名；客户端内存组表只有旧 cfg 的 6 条有名记录）；②云只跟踪 14 个板块（CloudSvcCache.json PriChange.Status 实锤：13 板块+zxg+blocknew.cfg_2），云 cfg 里 CPO 的"中文名"就是"CPO"；③旧 cfg（gs_bak 20261007）实锤历史名 QXLT=情绪龙头/ZLT=准龙头/51=条件预警，但云同步换 cfg 后这些名字丢了。**解法=插件本地别名层**（唯一正解，任何读取方案都变不出不存在的名字）：`数据目录/tdx_group_aliases.json`（seed 播种 QXLT/ZLT 历史名）+ `GET/POST /api/tdx/group-alias`（{id,name}，name 空串=清除）+ TdxTab 选中组后「别名」行内联 input 改名（**Electron 无 window.prompt 勿用**），显示优先级=别名>cfg中文名>短码，改名只存插件不碰通达信文件。实测：设别名立即生效/清除恢复短码闭环通。**方案1 落地（同日，用户确认客户端看不到那 30 个组）**：`_parse_all` 每组标 `registered`（cfg 索引注册=True；孤儿 .blk=False），前端默认**仅显示客户端注册组**（14 个=自选股+13 云端组，与客户端 UI 完全一致），头部「☑ 仅客户端注册组 / ☐ 全部分组(含未注册 N)」开关可切（localStorage kpl_tdx_regonly），note 文案同步
- ~~**⏸ 实盘持仓（Phase 3，trade.dll 本地桥）**~~ **已被内存直读方案取代（见上 ⭐⭐ 实盘持仓已上线）**：trade.dll 路线（ctypes 官方交易模块，pytdx TdxTradeApi 同款）因门禁三条件未齐备搁置（本机无 trade.dll/需 32 位 sidecar/需通讯密码）。内存直读无需任何额外材料、零门槛，已成为生产方案。若未来内存布局因通达信升级变化（校验失败/读不到），备选：①frida 常驻 hook 固定地址（免每次全扫）②重跑 tdx_spec/tools/memscan_plaintext.py 重新定位结构体 ③trade.dll 桥（门禁材料齐时）④券商 miniQMT/xtquant 兜底
- **坑（本轮实录）**：①`python -c`/`py` 启动器在部分沙箱被判非只读拒绝——只读勘察拆成 ls/find/od/grep 组合；②tdx_watch 里函数名与缓存全局变量同名（`_packaged_names`）导致 `'function' object has no attribute 'get'`——改名 `_packaged_tbl`；③Git Bash /tmp 与 Windows Python 的 /tmp 不互通，curl -o 落盘后 python 读不到——用 cd /tmp 后相对路径

### ⭐ 通达信云同步协议考古（2026-10-06 全天，抓包工具链就绪，⛔ 只差用户登录一次）

- **用户需求升级**：自选分组要**全自动同步**（不等 PC 客户端手动同步）；持仓只要查询不要交易。路线：先云直连（不依赖 PC 客户端）→ 不行再逆向手机 App
- **✅ 云同步体系全貌（静态考古 observed，RE 工作区 E:\zcode-projects\tdx_spec\）**：
  - **tpbus.dll**（5.7MB，D:\app\tdx\tpbus.dll）= TP 账号总线，**消费 TDXToken/TPSession/RegUID**（token 明文存 `T0002/user.ini [Other]`，客户端长登录态）；源码路径字符串 `TdxDevKits\DevKits\tpbus\tpbus\{LoginProcess,OperPriData,TPDataDlg}.cpp`
  - **TP 总线 = page1/2/3.tdx.com.cn:7615 TCP 二进制 RPC**（connect.cfg `[ZDSYS] TPHost01-03`+`TdxCloudAddress_TP`；FuncID/FuncName 寻址；BlowfishCrypto+rsa_public_key 登录加密；`{"Device":"TDXW","ClientType":40,"EncrytLv":2}`）
  - **云自选数据模型（tpbus.dll 字符串实锤）**：`CCloudSvc::SetZXGData`/`SetAllZXG (GruopName=%s,ZXGList=%s)`/`CZXGSync::Notify`，载荷 `{"CodeList":[["%d","%s"]],"GroupName":"%s"}`（[市场号,代码]）；`blocknew.cfg` 同步项 `{"TotalItem":1,"DataType":2,"Title":"blocknew.cfg",...}`；增量同步 flag `UseIncrementalSync=1`/`AutoSyncPriData=1`/`AnonySync`/`UpFlag/DownFlag/IncludeZXG`；本地 RPC 名 `Local:CloudDownAll`/`Local.BlockSync`
  - **T0002/CloudSvcCache.json = 云同步状态缓存（金矿）**：每对象 `{DataID, serverver, CurServerVer, LastSyncMD5, DeviceName, LastChangeTime}`；**DataID=base64("R<TDXID>L_zxg")**（TDXID 从 datacache.json `LoninExtendSvc.TDXID`）；**用户 zxg 的 DeviceName="iPhone_AppStore"——云端状态=手机状态**（正是用户要的）；serverver 3126 vs CurServerVer 2331=云端比本地新
- **⛔ 本机网络对 TP 总线的 RST 墙（实测）**：page1-3:7615 与 calc:7616 对**任何连接**（Python 裸 TCP / Python TLS ClientHello / 客户端经代理）都是 TCP 握手成功后秒 RST；**同机 7709 行情主站/KPL 8080/tdx 443 全部正常**——非端口封锁，是 TP 服务端拒绝非自家人（首帧魔数校验：容忍 3s 静默，收到无效首帧 ~2s 内 RST；服务端不先说话=客户端先发帧）。**推论：抓到客户端首帧魔数后，Python 复刻即可通过**（墙=握手不识别，非 IP 黑名单）
- **⛔ tdxw.exe 网络层反 hook（实测）**：frida 16.7.19 spawn+attach 双模式 hook ws2_32 全家（send/recv/WSASend/WSARecv/connect/WSAConnect/ConnectEx-via-WSAIoctl/getaddrinfo）+ **ntdll NtDeviceIoControlFile AFD 层（IOCTL 0x12007/0x12017/0x1201F）全部零命中**，但客户端实际在连网（行情正常出数据）——**TDX 用直接系统调用自研网络栈**，用户态 hook 全瞎。唯一可见路径=TCP 终端（代理/netstat/kernel）
- **抓包工作区（就绪待触发）**：`E:\zcode-projects\tdx_spec\tools\{tp_proxy.py,hook_tp.js,hook_afd.js,attach_hook_tp.py,click_login.ps1}`；**代理已改 connect.cfg 重定向**（`TdxCloudAddress_TP=192.168.111.124:7615`+ZDSYS TPHost01-03=LAN IP:7615，端口保持 7615 消除变量；**还原=cp captures/connect.cfg.bak**）；tp_proxy.py 监听 0.0.0.0:7615 转发真实 page1-3（动态解析多节点尝试）双向落盘 captures/tpstream/c{n}_{S|R}.bin。**唯一待办：用户在登录框完成一次云登录**（账号密码已保存点登录即可，或手机扫码）→ 代理自动抓到 LoginByToken+云自选下发全流程 → 复刻 tdx_cloud.py。⚠️ 客户端 UI 自动化全部失败的坑：登录框是 #32770 自绘窗（位置每次启动漂移、双屏+DPI 缩放坐标换算复杂、SetForegroundWindow 被 Windows 前台锁拦、PostMessage 合成消息被自绘忽略、frida 用户态 hook 被 direct-syscall 绕过）——**别再自动化，让用户手点**
- **持仓路线 A 前置条件实锤**：connect.cfg `[WTHOST] HostNum=0`——用户从未在 PC 客户端配过券商交易（只在手机 App 交易）。持仓抓包前需用户在 PC 客户端（或弹出的「请选择券商」对话框）选券商+登录一次交易。备选=模拟器装 App+tcpdump（root 免 CA）
- **本轮其它实测**：①etrade.xmb（交易模块，887KB）= 高熵加密容器无已知魔数，静态破解难；②T0002/log/DataModule.log 显示 2025-02 客户端就有每 31s 的 Connect ERR 循环（连接问题史前就有）；③客户端启动会出「请选择券商」弹窗（用户没配过交易）与扫码/账密两种登录框（交替出现）；④zxgweb.html（39KB Vue 打包）在 D:\app\tdx\webs\cfg\，数据走原生桥不走 HTTP；⑤TDX 金融终端启动极慢（~30s 出窗口）

### ⭐ 通达信双登录完成（2026-10-07 凌晨，云账号+银河证券交易均在线，协议抓包入口已打开）

- **✅ 云账号登录**：登录框（#32770 自绘窗，每次启动位置漂移）→ 组名含「金融终端V7」宽 600-1100 的可见窗 → 相对坐标 (0.343, 0.868) 点登录（凭据已保存在框内）。成功标志：`T0002/user.ini` mtime 刷新 + 客户端自动重启进登录态 + 顶部 186****7160。
- **✅ 银河证券交易登录（客户号 228800015560 / 沈云翔）**：可靠入口=**菜单栏 交易 → 内置闪电交易(F12)**（菜单是原生 Win32，合成点击可靠；顶栏「证券交易未登录」红链接点击会创建隐藏 CEF 窗 vis=False 且外部 ShowWindow 只出黑壳）。登录框字段顺序：客户号[v] 账户类型[v] 隐藏账号 / 客户号输入 / 交易密码 / 安全方式+验证码图 / 登录 脱机 取消。**银河账户类型下拉要选「z中国银河证券」**（列表按拼音排序，End 键跳底；默认「融资融券交易」会报"客户没有主资金账户"）。首登弹风险声明书：勾选框+同意后进入。**成功标志**：顶栏变「银河证券已登录」+ 底部交易坞（买入/卖出/撤单/成交/持仓）+ `netstat` 出现 **140.206.44.230:7708**（交易服务器端口 7708，行情是 7709）
- **登录自动化全套坑（勿再踩）**：①**DPI**：PowerShell 必须 `SetProcessDPIAware()`，否则 SetCursorPos 被 VirtualScreen 缩放偏移（本机 3840 物理 vs 2560 虚拟，差 1.5 倍——曾致全部点击打偏）；②**前台锁**：SetForegroundWindow 会被其它进程抢回，用 ALT 键盘事件辅助；③**截屏进程抢焦点关菜单**——点菜单和截屏必须同一个 PowerShell 进程内连做；④**CEF 黑窗**：链接点击创建的 Chrome_WidgetWin_0 外部 ShowWindow 只渲染黑壳，真正的交易登录框由 tdxw 自己 ShowWindow（light-panel 特征可扫描）；⑤**验证码**：截图裁剪放大人眼读（7036/7799 都一次过），SendKeys 输入即可；⑥**相对坐标定位法**：登录框 GetWindowRect 后按比例点按钮，比绝对坐标抗漂移；⑦弹窗三连：升级提示（ESC 可关）/新人福利广告「通达信信息」#32770（WM_CLOSE 关）/云登录框（点登录）。
- **交易会话已验证**：持仓 tab 打开（列头 证券代码/名称/当前持仓/可用余额/参考盈亏/盈亏比例/参考市值/持仓占比…），**表空=该账户当前无持仓**（或需盘中刷新）；撤单查询返回「没有相应的查询信息」——查询往返正常，会话数据通路 OK。
- **⛔⛔ 持仓协议抓包成功但撞上会话加密墙（2026-10-07 终局定论）**：pktmon 抓包链路全通（capture_trade.bat 自提权 90s→pcapng→pcap_extract.py 流重组，用户手动点资金股份触发查询，抓到 543 包/请求 40KB/响应 5.7KB）。**响应帧确认会话级加密**：帧体熵 7.10 bits/byte（无 zlib、raw-deflate 不可解、无明文结构），帧头形如 `b1cb7400 + 滚动序号(0ebd/3ebe/3ec0...) + 长度对(3b00 3b00 / a00f e400)` + 密文体；昨日小帧 zlib 解压成功但解压体尾部同为高熵（zlib 外层+内层加密）。加密算法在 tdxw.exe/tpbus.dll 内、会话级密钥协商——**纯 Python 复刻需逆向此加密 = TradeX 刑案同类工作，明确不推进**。客户端 S 流另有 21KB int32 数组上传（-2/-13 填充+少量值，用途未明，疑似对账同步）。**分析工具已沉淀**：`tdx_spec/tools/{capture_trade.bat(纯ASCII!), pcap_extract.py(pcapng解析+流重组), analyze_trade.py(zlib扫描+熵检测), socks_dump.py(SOCKS4/5落盘代理)}`。
- **⭐⭐⭐ 破局成功（2026-10-07 深夜）：持仓结构体内存明文直接可读！** frida Memory.scan 扫 GBK 股票名（'中国长城' GBK = d6d0b9fab3a4b3c7）命中 242 处 → **交易坞持仓结构体在内存中未加密常驻**。结构体布局（记录起点=股票代码 ASCII 6 字节，stride 172B）：`rel 0x00 代码[6]+\0 / 0x0b 名称GBK / 0x24 股东号[10] / 0x48 int64 持仓数量 / 0x50 float 参考成本价 / 0x54 float 参考市价 / 0x58 double 参考市值 / 0x60 double 参考盈亏 / 0x68 double 盈亏比例%`——两记录所有字段相对偏移一致，与通达信界面逐位吻合（000066 中国长城 1400@17.586/14.100/19740/-4880.56/-19.82% + 301269 华大九天 200@120.372/84.66/16932/-7142.4/-29.67% 全对上）。工具 `tdx_spec/tools/memscan_plaintext.py`（v2：dump 走 send(payload,data) 通道）。**生产方案**：frida 常驻 hook 该结构体地址（Memory.scan 定位后 Interceptor/轮询读取）→ 解析结构体数组 → 插件 API 直出。注意：frida 的 payload 内嵌 hex 字段需走 data 参数通道（v1 教训）；地址 0xa4da237 等 hit 是 GBK 字符串副本（UI 数据），结构体本体含代码+名称+数值连续排布才有效。
  - **协议库确认 = `taapi.dll`（CTA Client 5X）**：4.6MB，静态 OpenSSL（AES-NI ×96/74/23 + TEA delta + DES SP 表 + 3DES 字符串全有），CTAJob_TC50_{Login,SimpCall,FuncCall} + **QueryAns(FuncName=%s,Ans=%s)**（协议按函数名字符串寻址查询！）+ 配置键（NoEncrypt/CfgEncrypt/EncryptLv/CmdNo/FragNo/FragCount/LastCmdNo/VerifySignOfServ/LoginID/LoginPass/ClientLoginInfo）+ `CDes3`（SafeMemoryString 内存保护用 3DES，cbDes3Key 运行时设置）+ CTDXSession CommitLoginSuccess。券商列表全在内（银河证券 ✓）。taapi.dll 的 .text/.rdata 文件偏移=VA（delta 0，逆向友好）。
  - **AES-NI 函数群**：RVA 0x2bfb80-0x2c2d38 一个大汇编块（OpenSSL aesni-x86_64.pl 风格），候选函数入口 = 0x2bfb80/0x2c01f0/0x2c0380/0x2c0560/0x2c1630/0x2c2a20/0x2c2be0（ret 后 16 对齐边界法）。frida 全挂后轮询窗口**零调用**——交易数据流不走这些函数（taapi 的 AES 用于 TLS）。
  - **DES SP 表**：taapi .rdata VA 0x370ad0（00040101 特征 ✓）。MemoryAccessMonitor 监视命中 0x1714086c/78 —— 但反汇编证实 0x147e9b = `call [eax+0xc]` **COM vtable 虚调用**（Release），命中是同页 vtable 查表误报，非 DES 查表。hook 0x147877（含误报的函数）零参数价值。
  - **会话加密本体仍未定位**：排除项 = CryptoAPI（零调用）/ tdxw 软件 AES sbox（零访问）/ taapi AES-NI（零调用）/ 内存 AES key schedule（自校验扫描 44 万候选全灭=非标准 AES）/ zlib 全 FLG 集（今日大帧非 zlib）/ raw deflate（不可解）/ 剪贴板 Ctrl+A+C（CEF 不响应）/ 右键菜单（CEF 不弹）。**帧体熵 7.10 + 确定性重复密文（5 帧逐字节相同）** = 确定性加密（ECB 或固定 IV 流），算法在 tdxw.exe 本体或未扫的模块（taapi 的 TEA delta 也是候选），属 IDA Pro 级多日工程。
  - **下一步（若继续）**：①抓登录握手：杀客户端→bat 启动抓包→自动登录（全流程已验证可代操作）→登录握手帧（密钥交换）必落盘；②IDA Pro 分析 taapi.dll CTAJob_TC50_Login（capstone 线性扫不够，需要交叉引用+反编译）；③taapi.dll 的 TEA/XTEA 候选代码分析（delta 0x9e3779b9 命中处反汇编）；④**备选止血**：交易坞持仓页用户手点右键（人工右键可能弹合成点击弹不出的菜单）看有无导出；或方案 B 粘贴导入。→ 实际结局见上条 ⭐⭐⭐ 破局成功
  - **用户持仓（截图确认）**：000066 中国长城 1400 股（成本 17.586，-19.82%）+ 301269 华大九天 200 股（成本 120.372，-29.67%），资金 231.08，资产 36903.08，股东代码 0207091111。
  - **✅✅ 实盘持仓已上线（2026-10-07，内存直读进插件）**：`backend/tdx_positions_reader.py`（`get_positions(timeout)` 库函数）= frida attach tdxw.exe → `Memory.scanSync` 扫 GBK 持仓名 pattern（当前表：长城 b3a4b3c7/九天 bec5ccec，**用短名 2 字 GBK 命中结构体本体而非 UI 副本**）→ 命中后**回溯 7~0x30 字节找 `[6位数字]\0` 记录起点** → 校验 0x40 int64 持仓∈(0,1e8] + 0x50 float 成本∈(0.01,1e5) + 0x48 int64 可用∈[0,qty] → 读全字段。JS 端 GBK 字节以 `\x01`+latin1 串传回、Python 端二次解码（frida payload 通道教训的落地形态）。字段补全：**0x48 = 可用数量**（avail，实测=qty 无在途委托时相等）。去重按 code，mv≠0 优先。**接入**：`GET /api/tdx/positions?refresh=1`（main.py，threading.Lock 防 frida 并发 attach + 30s TTL 缓存，缓存命中 3.7ms/首扫 5-15s）；前端 TdxTab 双段结构=💼实盘持仓区（9列网格 kpl-tdx-posrow：名称/代码/持仓/可用/成本/现价/市值/盈亏/盈亏%+合计行+刷新按钮+60s 轮询）+🎯自选分组区（原有）。**前置条件**：tdxw.exe 运行中且已交易登录并打开过一次持仓页（未运行返回 ok=false+引导文案）。依赖：后端 python 环境（card_ocr miniconda）须有 frida 16.7.19（已装）。⚠️ 前端 client.js 改动需 DSH 页面 Ctrl+R 刷新生效。
  - **坑（本轮新增）**：①frida `Memory.scan` 异步回调在脚本里要 `setTimeout(scanAll,0)` 包裹否则 TransportError 超时；**生产版直接用 `Memory.scanSync`（更快更稳）**；②GBK 名 pattern 必须用**短名**（'长城' 而非 '中国长城'——结构体里存的名称与 UI 显示可能不同，且全名 hex 易被内存对齐截断）；③avail 未加校验前曾扫到 avail>qty 的脏记录——`0≤avail≤qty` 校验过滤噪声命中；④tasklist 查 pid 用 `tasklist /FI "IMAGENAME eq tdxw.exe"`（Git Bash 下 `//FI` 转义）。
- **⭐ 双登录实操全记录（2026-10-07 凌晨，全部 agent 代操作成功）**：①**云账号登录**：登录框相对坐标 (0.343,0.868) 点登录，user.ini 刷新即成功；②**银河交易登录**：菜单 交易→内置闪电交易(F12)（原生菜单，可靠）→ 登录框 → 类型下拉点箭头+**End 键跳列表底选「z中国银河证券」+Enter**（默认融资融券报"没有主资金账户"）→ 客户号/密码/验证码（截图放大人眼读：5077/7036/0783 全一次过）→ 登录 → 风险声明书（勾选框+同意，每次进程首登必弹且位置漂移）→ 可能弹「另一个银河正在运行中」（旧会话未超时，点**切换到**接管）。成功标志：顶栏「银河证券已登录」+ 底部交易坞 + netstat **:7708 ESTABLISHED**（101.230.159.230 / 140.206.44.230 均见）。**交易服务器端口=7708**（行情 7709）。持仓查询面板：列头 证券代码/名称/当前持仓/可用余额/参考盈亏/盈亏比例/参考市值/持仓占比…，**用户账户当前无持仓（表空）**，撤单查询「没有相应的查询信息」=往返正常。
- **⛔ 抓包路线实证结果（勿重蹈）**：①**SOCKS 代理路线失败**——通讯设置里「网络设置-使用代理 SOCK5 127.0.0.1:1080」：行情连接正常走 SOCKS，但**交易栈不走代理且直接连接失败**（"通讯楼层服务器关闭"/"通讯故障或服务已关闭"）→ 已还原（**代理开关持久化在 `T0002/usercomm.ini [PROXY] HasProxy=1/0`**，改文件即开关；云登录在 HasProxy=1 时也失败"校验用户失败"，=0 恢复）；②**connect.cfg [WTHOST] 重定向无效**（银河服务器列表动态下发）；③**frida 用户态 hook 全瞎**（direct-syscall）。**唯一可行路线=pktmon 管理员抓包**：一键脚本已备好 `E:\zcode-projects\tdx_spec\captures\capture_trade.bat`（自提权，90 秒自动停并转 pcapng）——双击+UAC 点是即可，之后 UI 点持仓触发查询，解析 trade.pcapng。**解析器已备好 `tdx_spec/tools/pcap_extract.py`**（极简 pcapng 读取+TCP 流重组，按方向落盘 stream_端口_S/C.bin）。**当前卡点：等用户双击一次 bat（UAC 授权）**；交易会话存活很久（客户端过夜仍 7708 ESTABLISHED），抓包随时可做。
- **DPI/坐标坑合集（通达信 UI 自动化）**：①PowerShell 必须 SetProcessDPIAware（3840 物理/2560 虚拟 1.5 倍差致全偏）；②对话框每次启动位置漂移——必须"当次截图→测量→点击"；③点菜单/截屏必须同进程（跨进程截屏抢焦点关菜单）；④Error 弹窗用回车关（确定是默认按钮）；⑤usercomm.ini 明文可改 = 绕 UI 循环的正规入口。

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
7. **前端配置**：弹框等浮层用显式配色（勿依赖 DSH 主题变量，深色主题下文字会不可见）。**⚠️ 2026-09-27 再次踩坑强化：KplFengkouPage 新代码又在 `.nm` 用 `var(--dsw-alias-label-primary)`，深色主题下白底深字不可见——规则升级为"KPL 所有新写 CSS 一律显式色值（#111/#999/#f0f0f0 等），默认禁止 var(--dsw-alias-*)"；每次写完 grep 新类名段落里的 `var(--dsw` 应为 0 命中**
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
27. **⭐ 行情菜单整页白屏=组件"引用与定义分离"（2026-10-02 实锤）**：多步脚本改 client.js 时，插入组件**引用**的步骤成功、插入 **class 定义**的步骤因 AssertionError 中断未写盘 → 部署出"7 处 `KplErrorBoundary` 引用但定义不存在"的文件 → 点行情即 `ReferenceError`，且该错误发生在**模块顶层求值后的渲染期**，整 Tab 白屏无任何提示。**教训**：① 脚本批量改 client.js 每步后必须校验"引用数==定义数"再写盘（`grep -c 引用` vs `grep -c "function X/class X"`）；② **勿用 class ErrorBoundary**（DSH 打包环境模块执行期求值 React.Component 会失败致整模块白屏），统一用纯函数守卫 `kplGuard(Comp, name)`（渲染期 try/catch，异常显示"模块渲染异常(名称)+原因"，七行情子页已全部套用）；③ 部署前 `node --check` 只保证语法、**不保证运行时引用完整**，还须 grep 引用/定义配对；④ 重启/刷新后仍白屏时，先查 DSH 日志（`C:\Users\mark\AppData\Roaming\DSH Desktop\logs\dsh-*.log`）里的前端异常栈，勿先怀疑后端；⑤ **守卫包装只能在模块层做一次**（`const KPL_G = {...}`）——放进渲染体内每次父级重渲染（系统 Tab 有 3s 状态轮询）都生成新组件类型，React 视为不同组件把子页整页卸载重建，表现为情绪/直播等子页"每隔几秒闪一下"+丢状态重拉（2026-10-02 实锤）。通用规则：**任何 `React.createElement(Fn(...))` 式的渲染期组件工厂都是反模式**，组件引用必须稳定

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
- **⭐ 最强风口页（2026-09-24 数据复刻 + 2026-09-27 下钻页 KplQiangduPage 实现，App"我的版面"打板页·风向标同源）**：数据=**✅ 09-29 修正：Index/GetInfo 的 ZQFKList**（[代码,名称,强度,涨幅,概念串]，全时段有数据、强度盘中实时增长；**旧源 QiangDu_Article 盘后清空且与 ZQFKList 完全重叠已弃用**）；盘后回退最近快照 `kpl_qd_snapshot.json`（2026-09-27 修：不再匹配 today，直接返回最近一次快照——App 周日显示周四数据同款；快照盘中每 30s 落盘，**周末打开若无快照 list 为空属预期**，下个交易日盘中自动存）。**下钻页实拍结构（2026-09-27）**：指数条(沪 3888.37 涨跌，数据=/api/index-quotes 的 000001，与 App 逐位一致)+情绪三格(涨停板/强势股/跌停股 今/昨)+风向标表格(#/名称/强度(连板)/涨跌幅/板块)。**情绪条字段口径**：ChangeStatistics 原始仅 5 字段 strong/ztjs/lbgd/df_num/Day；ztjs 与 App"涨停板"逐位一致 ✓，App 的"封板率 84%/跌停 13"口径无法从该接口推出（strong=42/df_num=5 对不上）——按数据真实性原则如实展示字段含义（强势股/跌停股），勿硬凑 App 数字。页面=/api/kpl/qiangdu 端点（30s缓存）+ KplQiangduPage（kpl-qd2-* CSS）；首页"最强风口"模块"更多›/进入›"入口。**注意**：App 风向标 socket 2103 DaBanStockList 盘后同样无数据（订阅式）；proto=pidType1/orderType2/sortType3/index4/count5+市场开关6-10。App 打板页还有"竞价/即将涨停/涨停"三 tab（带数量徽标）+日期回看——未复刻（非最强风口范围，需时另行逆向）
- **⭐⭐ 最强风口独立下钻页 v2（2026-09-27 二次实拍修正，与打板页·风向标是两个不同页面勿混淆）**：App 首页"最强风口"模块(09-24 徽标)点"更多›"进入**独立原生页**（VIP 功能，弹"权限 N 天后到期"横幅）：指数条+**日期回看**（左右箭头切换历史交易日，实测切 09-23 数据完整）+四列表格（**名称+代码+橙色上榜时间徽标**(如 09:51=入榜时刻)+红↑绿↓方向标 | **强度↓**排序列(浅蓝高亮，App 默认按强度降序) | 涨跌幅 | **精选板块**(红色文字逐行+红"热"角标)）+**底部时间轴回放条**(09:30-11:30-15:00，可回放当日任意时刻风口)。**数据源**：下钻页默认视图与首页模块**完全同源**（QiangDu_Article，09-24 同刻逐项一致：国瓷材料3756/平潭发展3305/均胜电子2337）——插件复刻用同一数据源；**历史日期回看+时间轴回放走 socket 专属协议**（HTTP a=FengKou 全域探测失败，H5 strongestTuyere.html 为远程热更资产不在 APK），为 VIP 付费功能**未逆向（二期）**。插件 v2 实现：/api/kpl/qiangdu 增 rows 对象行（name/st/rate/plate/**time**(row[0] HH:MM 格式守卫推定=上榜时间，待周一盘中验证)/code(名称缓存反查)），前端行=名称+代码+橙色时间徽标|强度浅蓝列|涨跌幅|精选板块红色分行。**待周一盘中验证**：row[0] 是否为上榜时间+行情快照落盘
- **⭐⭐ 市场风口完整复刻（2026-09-27 mitmproxy 实锤，与"最强风口/风向标"是三个不同功能勿混淆）**：首页模块=**散布股票 pill**（红涨绿跌 6 只，点击进个股；旧实现用 GetHotSearch 热词文字=错）；下钻页（首页"更多›"）=说明条+指数条+**双 tab（按股票/按概念）**+表格（名称+代码+基金/游资标 | 涨跌幅 | 主力净额↓排序列浅蓝高亮 | 风口概念蓝字）。**数据源=`StockFengKData/GetFengKList`，✅ 09-28 修正：域=apphis.kaipanla.com（HIS 系，apphwhq 域只有当日缓存且忽略 Day 参数）**，biz={Index:0, st:500, Order:17, **Day:YYYYMMDD 无横线, Time:"1500"**}——**Day 带横线或缺 Time 返回空/参数错**；历史深度实测 ≥09-22（546 条，兆易创新 20.13 亿与 App 逐项一致）；**⚠️ 风向标数据源修正（09-28 二次实拍）：打板页四 tab+顶部情绪条的数据源=GetInfo 高频轮询**（53 次实测），**CWeatherVaneList=首页风向标 6 卡（SZ 涨 3+XD 跌 3 [代码,名称,涨幅,板块]）**、**DaBanList=打板情绪条**（tZhangTing/lZhangTing/tFengBan/lFengBan/tDieTing/lDieTing/SZJS/XDJS/szln/qscln...）；get_daban 已改用上述真数据源（3008 等效方案已移除）。**⚠️ 09-30 补充第四教训：大切片替换会误删无引用的类属性块**（_themedet_stale 等 4 个 SWR 类属性被吃 → AttributeError: no attribute _themedet_disk_loaded → 题材详情 500）；**每次大改后必须 AST 对比 git 版的 类属性+方法 双清单**（方法在但属性丢同样致命）；staticmethod 缺装饰器会在经实例调用时报 takes 0 positional arguments（同文件 grep 定义处核对）。**⚠️ 大规模字符串替换脚本的三重教训**：① `s.index()` 定位若目标顺序与预期不符会产生反向空切片→replace 静默插错位置；② 未 quoted 的 bash heredoc 会展开 JS 模板字符串 `${...}` 导致内容损坏；③ 部署必须 md5 双向校验（diff -q 曾被跳过的 && 链骗过）。**2103 DaBanStockList=死代码**（proto 类零 xref，App 未使用）；缺省 Day 时**盘中实时路径=apphwhq 域 无 Day 无 Time**（返回今日推送，09-28 盘中实测 229→268 条实时增长）；**day 参数路径=apphis 域 + Day 无横线 + Time=1500**（历史收盘快照）；客户端缺省从今天往回找最近交易日（跳周末，节假日自动落空下一天）。⚠️ 双路径分支都要先初始化 got=None（曾因 UnboundLocalError 500）。响应：List 条目=[代码,名称,"0",涨跌幅,0,主力买入,主力卖出(-负),主力净额,风口概念,0,标签(基金/游资),概念,上榜时间戳]；顶层 Day/Count/**DayArr(可回看日期数组)**。注意：**List 顺序=概念分组序非净额序**（Order=17 语义存疑），插件本地按主力净额降序重排+按代码去重（同股多概念保留首条）。插件：get_fengkou + /api/kpl/fengkou + KplFengkouPage（按股票/按概念聚合双视图，概念聚合=净额合计降序）+ 首页散布 pill（kpl-fk-* CSS）。**App 的"按概念"视图未实拍**（聚合口径为插件推导：概念净额合计降序），有差异时回到 SOP 第 1 步实拍
- **⭐ 风向标页（2026-09-27 复刻数据链，App 打板页"风向标" tab，与最强风口/市场风口是三个不同功能勿混淆）**：数据=**socket 2103 HQDaBan.SubDaBanStockList（订阅式，盘中实时推送；实测周末/盘后零响应连 ack 都没有）**。协议：Req{pidType1 orderType2 sortType3 index4 count5 + 市场开关 stType7/zbType8/cybType9/kcbType10}；Resp{回显 + items20{stockId1 name2 stockTag3(游资标?) financingTag4 backZT5(回封) warnTag6 **quotas100 动态列**} indexes21 maxSize22 date23}。**✅ 数据源最终方案（09-28 盘中实锤）**：2103 直连订阅被服务端拒（110 帧"连接错误"，前缀回显 hqDaban|133:20010/2103-0/参数——参数枚举待逆向）；**改用 3008 type=1（盘中人气榜）等效复刻**——字段与 App 风向标列高度吻合（名称/涨跌幅/连板状态/涨停原因=板块），盘中实时+盘后冻结数据都有，无需快照兜底。插件：kpl.py `get_daban`=get_pop_rank(1,1,0,50)+本地涨幅降序+行{name,code,rate,lb,plate}（⚠️ item 涨幅键是 **pct** 不是 rate）→ /api/kpl/daban → KplDabanPage + 首页"风向标"模块（**恒显示**；**App 首页同款三卡样式**：每卡=板块(zt_reason)+龙头股(蓝)+涨幅(pct)）。2103 原始尝试代码保留在 kpl_socket.get_daban_list（110 连接错误待逆向——110 帧前缀回显参数 hqDaban|133:20010/2103-0/pid:order:sort:index:?:(cx)st:zb:cyb）；2103 与 2126 SubQxWindVane（市场风向标 top3/bottom3 涨跌榜，HIS 域 HisHomeDingPan/HisWeatherVane {Day}）是两个不同接口勿混淆。**数据来源定性（2026-09-27 断网实验）**：模拟器 App 断网后数据照常显示=App 本地缓存（交易时段从服务端拉取落地）——插件快照机制与其等价，仅上线时间晚无历史存量
- **⭐⭐ 行情·情绪页 1:1 完整复刻（2026-10-02 逆向+落地，推翻 09-30 简版）**：App 行情·情绪 tab=`marketmood/MarketMoodFragment`（容器）→`stareplate/ui/fragment/MoodFragment`+`MoodPresenterImpl`（数据）。**嵌入行情菜单时 setTabStripVisibility(8) 隐藏"数据分析/股票列表"双 tab（仅独立 Activity 显示）→ 行情·情绪 tab=数据分析单页**；"股票列表"=HisPatternFragment=socket 2103（独立 Activity 场景，未做）。页面结构（实拍 s1~s10）：温度计(综合强度=ChangeStatistics strong)→涨跌统计(11 档柱状)→市场量能(实际/预测量能+今昨分时%)→涨停表现(三格+连板天梯+四行)→活跃股走势(分时情绪曲线+当日|5日)+播报条(GetLiveNews)→连板强度(strong 点线图)>大幅回撤表→风向标 2×3 卡→权重表现 2×3 卡；右下悬浮"📅历史数据"◀▶ 切交易日。**权威映射文档 `kanpan_spec/docs/mood_page_map.md`（15 接口 action/参数/锚点逐项实测）**。数据源双通道：历史/盘后=**HIS 域 HTTP**（apphis.kaipanla.com，控制器 HomeDingPan 系+MarketSentiment 系；休市 today 域只回 kaipanla.com 反爬占位串）——`MarketZDTJ{Date,FBJS:1}`(11 档：key N=(N-1,N]% 桶，1..3=3~0%、4..7=7~3%、8..10=10~7%、11=>10%、ZT/DT 涨跌停、SJZT/SJDT 实际涨跌停、SZJS/XDJS 家数)+`HisDaBanHeadInfo{Day}`(nums 封板率今昨)+`MarketSCLN{Date,Type:0}`(量能 last/yclnstr/trends 241 分钟)+`ZhangTingExpression{Day,Is_New:1}`(info[0..4] 天梯/[5..8] 连板率/[9] 破板率/[10..12] 昨今表现/[13] 评语)+`GetSentimentChart`(controller MarketSentiment/HisMarketSentiment！points 分时情绪)+`GetLiveNews`(list 播报)+`SharpWithdrawal{Day,Is_New:1}`(回撤表)+`HisWeatherVane{Day}`(top/bottom3 顶层!)+`WeightPerformance{Day}`(info.SZ/XD)+`NorthboundFundsB{Day}`(**status==0 或 "88" 哨兵→App 隐藏模块**)+`MarginDebt`(两融，数据日≠选中日隐藏)+ChangeStatistics(Index 0/st 1000 连板强度序列)。**响应层级两种**：MarketZDTJ/MarketSCLN/ZhangTingExpression/SharpWithdrawal/WeightPerformance/NorthboundFundsB 包 info；HisDaBanHeadInfo=顶层 nums、HisWeatherVane=顶层 top/bottom、GetSentimentChart=顶层 points、GetLiveNews=顶层 list。**低/中/高标签阈值（ZTExpressionEntity 字节码）**：二板连板率<15低/15~25中/≥25高；三四板/高度板率<30低/30~45中/≥45高；破板率<25低/25~37中/≥37高；昨今表现<1低/1~3.5中/≥3.5高；昨日破板今表现<-1低/±1中/≥1高。当日盘中=socket 2100/2106/2114/2118(权重)/2119(涨停表现)——**2118/2119 是 marketfeed 未订阅的两个 pb.Empty cmd，10-08 盘中补**。插件落地：`/api/kpl/mood?day=`（get_mood_page 11 接口线程池并行+60s 内存+磁盘 kpl_mood_cache.json 7 天+后台刷新，冷拉 ~25s 因 apphis 2.5s 限速→磁盘层秒开）+前端 KplMoodBody(kpl-mood-* 显式白底)替换旧 KplSentimentBody（首页情绪下钻 KplSentimentPage 与行情 KplSentimentSub 共用）。09-30 数据与 App 实拍逐位对照全通过（bars 56/17/24/284/2186/170/2306/474/26/5/12、SJZT:SJDT=52:9、天梯 40/6/4/1/1、破板率 18.75%低、回撤金辰-13.68、风向标善水科技 20.01 等）。**注意 App 涨停表现三格"涨停板 52"=实际涨停 SJZT 口径（非 tZhangTing 56 全口径），封板率=tFengBan 四舍五入**。
- **⭐⭐ 情绪页下钻全套（2026-10-03 逆向+落地）**：模块「更多/图标」跳转目标（MoodFragment onClick+JumpUtil 字节码定案）：①涨跌统计↗=**分享卡片**（红色生成图，非下钻，跳过）②市场量能筛选图标=**MarketCapacityMoreDialogFragment 指数切换**——`MarketSCLN Type 枚举实测定案：0=沪深 1=上证 2=创业板 3=北证 **4=沪深京(App 默认，量能模块已改 Type4)** 5=科创板`（Type4 last=14502.31亿 与 App 逐位、Type1 上证 6793.99=dd3 实拍、T4=T0+T3 数字闭环）③涨停表现四行+更多=`q1(type 0破板率/1昨涨停今表现/2昨连板/3/4昨破板, day)`→**ZhangTingExpressionActivity**：梯头=`DailyLimitIndex{Day}`(=[40,6,4,1,1])+实际涨跌停=`MarketStockZDNum{Date}`(SJZT/SJDT)；涨停股列表当日=**socket 2120(pb.Empty, ZhangTingStockListPresenterImpl 实锤，marketfeed 未订阅 10-08 补)**/历史=`DailyLimitPerformance{Day,PidType,Type,Order,Index,st}`（通道实测通但 PidType1 仅回 2 行≠App 一板 40 只——精确参数语义**待 10-08 盘中 mitmproxy 抓包**；子页结构=ZhangTingStockListFragment(上表 涨停时间/原因(N)/封单+融/回封徽标)+ZhangTingYesterdayStockFragment(下表 价格/涨幅/板块="未涨停的昨日X板个股"事件文案实锤)，PidType Bundle 一板1/二板2/三板3/四板4/更高5）；④大幅回撤更多=`h0`→**MaximumRetreatActivity**：`SharpWithdrawalList{Day,Type,Order,Index}`（已实测：info=[code,name,0,"",高点涨幅,回撤,当日涨幅]，顶层 num）⑤权重表现更多=`p1`→**WeightPerformanceListActivity**（实拍 dd8：指数条+全行业表 涨幅▼浅蓝高亮/涨速/成交额）；`WeightPerformanceList{Day,Type,Order,Index}`=9 权重板块族非全行业表（Order/Index 无效恒 9 条）；全行业表通道=`PlateWeightStock{ZSCode}`/`HisPlateWeightStock{Day,ZSCode}`（5 种 ZSCode 盘后全空——两击规则停止盲试，**参数值待 10-08 抓包**；涨幅列先以主页面 WeightPerformance SZ/XD 全行同源展示）；权重卡片点击=`ra(context,day,indexId,indexName,date,isFallRow)`→PlateWeightStockActivity 单行业权重股。⑥风向标"更多"=**硬编码跳「并购重组 801225」板块详情页**（MoodFragment 字节码实锤：ArrayList 只 add("801225")→JumpUtil.I→IndexQuotationActivity；与首页风向标卡共用下钻页——2026-10-03 uiautomator 精确定位实拍证实，此前误判"无跳转"系点击坐标偏移；801225 端点实测与 App 逐位：成交额 596.85亿=App 596.8亿、涨停封单 21.62亿、善水科技 20.01% 居首；**插件首页风向标与情绪页风向标"更多"均已接 sector/801225**；概要条已改 App 8 项布局（强度/排名/大单封单无源如实"--"）；App 板块详情页的股票池分组 chips+竞价动态列头+分时/K线+机构纪要——**2026-10-03 已逆向大半并落地**：
  - **概要 8 项真源=`ZhiShuRanking/GetPlate_Info_QJ{PlateID,RStart,REnd}`**@API_HQ（IndexQuotaTLinePresenter 字节码 ox0.d3；09-30 实测 List=["--",-174,59685254552,0,0.32,0,0,0]=排名/强度/成交额/涨停数/?/涨停封单/大单封单/?——**强度 -174 与 App 逐位、成交额=596.85 亿逐位**；涨停数/封单盘后归零=App 同款显示 0；[4]=0.32 语义存疑按主力净额展示待盘中锚定）；
  - **涨幅因子=`ZhiShuL2Data/GetPlateZF{StockID,Day}`**@API_HISTORY（ZF=-0.0088，语义待盘中锚定）；
  - **分时=`ConceptionPoint/BKFenShiZhiBo{PlateID}`**@API_HQ（controller/action 反转陷阱：j00.s0(控制器,action,参数名数组)——首测把 action 当 controller 得 null；list=[] 盘后空=直播分钟点，当日订阅=socket **2202**（IndexQuotaTLinePresenter w/y(2202) 实锤）10-08 接入）；
  - **机构纪要=`Theme/InfoBKR{ZSCode}`**@API_LHB（实测 errcode=0，801225 List 空=该板块无纪要；响应含 List/List_Special/Special）；
  - **K线=socket 2400/2402**（IndexQuotaKLinePresenter；盘后静默待盘中；HTTP GetStockChart 不收板块 id 已试）；
  - 板块详情页其实有 HTTP（09-27"全 socket"结论只对股票池成立）；
  - 落地：`/api/kpl/plate/extras/{plateId}`（QJ+ZF+BKFenShiZhiBo+InfoBKR 并行 60s 缓存）+KplSectorDetailPage 整体重写（概要 8 项 QJ 真值/分时-K线 tab/股票池-机构纪要双 tab/kpl-sdp-chart+kpl-sdp-bkr CSS）；
  - **仍待逆向（分组 chips 体系）**：强势题材/高弹性/人气激增🔒/连板高度=PlateFeatruedTagsBean（Filed_Type/GoodID/IsOpen/TSZB/TSZB_N/TSZB_Order/TSZB_Type）=**TSZB 特色指标配置体系**（服务端配置+App 本地 DYNAMIC_QUOTA_BEAN 联动+VIP 开关），非单接口，盘后无法锚定组员计算规则——10-08 盘中抓包）⑦播报条点击=`d0`→MarketLiveActivity（直播页已有）。⑧涨跌统计↗分享/量能"历史量能"未做（App 弹层）。插件落地：`/api/kpl/mood/capacity?type=`、`/mood/ztdetail`、`/mood/withdrawlist`、`/mood/weightslist` 四端点+前端 KplZtePage/KplWithdrawPage/KplWeightsPage（drill 路由 mood_zte/mood_withdraw/mood_weights）+量能指数切换下拉（kpl-mdd-* 显式白底 CSS）。**⭐ 题材详情个股行情数值通道定案（2026-09-30）**：App 表头默认=隐藏简介|价格|涨幅▼|人气值（可横滑出更多列）；**数值列通道=socket 3001 GroupStockQuotas 订阅式**（stockIds=f10 repeated string 传成分股代码，订阅 ack 后盘中持续推送 quotas 动态列；**盘后/周末无推送**=App 靠本地缓存显示当日收盘数据）——kpl_socket.get_stock_quotas 已实现（订阅+持 _recv_lock 收推送+capture_path 捕获原始帧供解析校准）；解析器结构待**盘中样本**校准（捕获文件 kpl_3001_capture.bin），列锚定后填充 价格/涨幅/成交额/换手率。题材详情页深色主题黑字黑底踩坑（2026-09-24）：kpl-tikad2 白底卡片设计配硬编码 #111 深色文字，容器背景透明继承深色主题 → 名称隐身。修复=整个详情内容区显式 background:#fff 卡片化（App 本就白底），涨跌/边框/hover 全部显式色。**经验：复刻 App 白底组件时容器必须显式白底，禁用主题变量兜底**（经验 #7 的反向变体）
- 题材详情 UI v2（kpl-tikad2-* 前缀）：小表格=红色边框表格（红头条/左列一级分类/二级分类+股票流式/涨停股红色高亮 ZT map/免责声明）；描述区 2 行截断+"查看全文▼"弹窗（kpl-explain 模式渲染 Introduction HTML，反编译证实 App 同款 ThemeDescDialogFragment(Content)）；个股行情=统计条(3010 或前端现算)+"隐藏简介"开关+右侧数值列(价格/涨幅/人气值/成交额/换手率)点击排序（默认人气值降序）+左块 sticky 固定/整体横滑+涨停行红色
- frida 17 的坑：`script.on_message = fn` 无效必须 `script.on("message", fn)`；Java bridge 需 frida≤16（设备端 fs16=16.7.19）；Module.enumerateExports 静态方法已删，用模块实例 .enumerateExports()；Java TLS 走 libjavacrypto.so 静态 BoringSSL，hook libssl.so 的 SSL_write 抓不到 conscrypt 流量
