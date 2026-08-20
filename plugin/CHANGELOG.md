# 更新日志

所有重要的变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
本项目遵循 [语义化版本](](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- 持仓复盘报告（每日/每周）
- 多账户支持
- 龙虎榜集成
- 自选股导入导出

## [0.3.1] - 2026-08-20

### 修复
- **后端启动被健康检查杀死**（DSH 显示"正在启动后端/等待后端响应"死循环）：旧逻辑在 lifespan 中同步执行通达信连接探测（串行实测多台服务器，网络差时可达数十秒），uvicorn 在探测完成前不监听端口，而 BackendManager 健康检查窗口只有 15 秒，超时即 SIGTERM 杀进程。现在连接移入后台 keepalive 线程（每 30s 检查重连），端口 1-2 秒内即可监听
- 行情类接口（quote/quotes/index-quotes/kline/holdings-refresh）的 pytdx 同步调用改到线程执行，避免探测期间阻塞事件循环
- 连接探测提速：8 台 × 2.5s 超时，加并发锁防止多个请求同时触发探测堆积
- 网络层面：白天时段大量通达信服务器 TCP 通但不返回数据，探测式连接（实测拉行情验证）天然规避；通达信完全不可达时东财系功能（情绪/风格/板块/两融）不受影响

## [0.3.0] - 2026-08-20

从"行情监控"升级为**完整交易体系辅助系统**（择时/选股/仓位/止盈止损四大模块）。

### 新增 - 后端
- **择时引擎**（`market_timing.py` + `GET /api/market/timing`）："跌无可跌"7因子清单（RSI超卖/MACD底背离/回撤深度/价格分位/成交萎缩/跌停>涨停/两融连降）、"企稳信号"4项确认（缩量止跌/放量反包/跳空缺口/多板块联动）、市场阶段判定（主升/震荡/下跌/主跌）→ 建议仓位区间 + 金字塔操作节奏
- **情绪+风格识别**（`market_sentiment.py` + `GET /api/market/sentiment`）：涨停/跌停/炸板池统计与炸板率、连板梯队（高度分布+个股清单）、全市场涨跌家数与两市成交额（东财代码表+pytdx批量行情）、风格打分（机构抱团期⇄题材妖股期，0-100）含因子明细与适配策略
- **板块监控+龙头**（`sector_monitor.py` + `GET /api/sectors`、`/api/sectors/{bk}/leaders`）：行业/概念排行（涨幅/成交额/换手/5日动量），板块阶段标签（启动/发酵/高潮/退潮/盘整，基于板块指数30日K线+盘中实时bar合成），板块内龙头候选打分（涨幅/涨停/换手10-25%/流通50-300亿/量比）附理由
- **仓位管理**（`position_manager.py` + `GET/PUT /api/account`、`GET /api/position/overview`）：总资金账户、当前仓位vs择时建议区间、现金比例、单票≤25%、同行业≤40%（东财个股行业接口）、持仓数3-6只建议、每只持仓金字塔加减仓建议
- **止盈止损 2.0**（alert_engine.py 重写）：三种模式 `fixed`（固定百分比，默认）/ `trailing`（移动止损：盈利>5%保本+高点回撤阈值触发）/ `ladder`（阶梯止盈：+20%卖1/3、+50%再卖1/3，尾仓移动保护）；时间止损提醒（买入超5个交易日无涨幅）；预警规则增删启停（`DELETE/PUT /api/alerts/{id}`）；触发历史持久化（200条，`GET /api/alerts/history`）；`PUT /api/holdings/{code}` 修改参数
- **东财免费接口客户端**（`eastmoney.py`）：涨停/跌停/炸板池、板块排行与成分股、板块/个股K线（push2his 多镜像轮询）、两融余额、全市场代码表（push2→push2delay 自动切换、禁用 keep-alive 防断连）
- **全市场选股池**（screener.py MarketPool + `GET /api/screen/pool-status`）：后台线程逐只预热全市场日K（约20分钟一轮、60分钟保鲜），`POST /api/screen` 传 `pool:"market"` 全市场扫描；4种选股策略升级为返回命中理由

### 新增 - 页面（client.js 整版改版为 6 Tab 仪表盘）
- ⏱ 择时：5指数卡（点位+涨跌幅）、阶段徽章、建议仓位、跌无可跌/企稳信号双清单（逐项✓/✗）、操作节奏
- 🔥 情绪风格：涨跌停/炸板/涨跌家数/成交额统计、连板梯队、风格滑块（抱团⇄妖股）+因子+适配策略
- 🧩 板块：行业/概念切换排行表（动量+阶段标签），点击展开龙头候选（含理由），可点开K线
- 💼 持仓仓位：总资金设置、仓位进度条（当前vs建议+现金）、风险提示、持仓增删改+止损模式下拉（固定/移动/阶梯）、个股行业与建议
- ⚠️ 预警：规则增删启停 + 持久化历史；实时预警 WS 推送全Tab可见
- 🔍 选股：4策略一键扫描 + 全市场池开关 + 预热进度显示 + 命中理由

### 新增 - AI 工具（4→8个）
- `stock_market_timing`：择时诊断（问"能不能入场/抄底"时必调）
- `stock_sentiment`：情绪+风格判定
- `stock_sectors`：板块排行+龙头候选（支持 leaders_of）
- `stock_position`：仓位体检
- `stock_holdings` 升级：支持 stop_mode/trail_drawdown_pct
- systemPrompt 注入"择时→风格→板块→选股→仓位→止损"分析链路

### 修复（原有隐藏 bug）
- **pytdx 连接从未成功过**：`hq_hosts` 条目是元组，旧代码 `host["ip"]` 必抛 TypeError；且前5台是僵尸站（TCP通但无数据）。改为实际拉行情验证的探测（`data_source.connect`）
- **行情涨跌幅永远是 0**：pytdx 行情不含 `change_percent` 字段，改为从昨收价计算（个股和指数一致）
- **指数行情取错标的**：沪深300/上证指数等沪市指数被 `normalize_stock_code` 误判为深市（000300→平安银行类错误）。指数市场代码显式指定
- **个股K线数据损坏**：pytdx 1.72 `get_security_bars` 在新版服务器返回数据上解析错位（约27%乱码记录）。个股K线改走东财；指数K线走 `get_index_bars`（协议干净）+ 单次800根自动分页
- client.js `PLUGIN_API_BASE` 硬编码端口：支持 `localStorage['dsh-plugin-stock:port']` 覆盖
- requirements.txt 清理死依赖（sqlalchemy/aiosqlite/apscheduler/python-dotenv/requests），新增 httpx

## [0.2.5] - 2026-08-19

### 修复
- **修复 `cannot get property "tools" without inject`**：Cordis 插件契约要求模块导出 `name` 和 `inject` 数组才能访问 `ctx.tools` 等服务；补充导出 `inject = ["tools", "systemPrompt"]`（与 dsh-mnemon 同款做法）

## [0.2.4] - 2026-08-19

### 修复
- **修复插件加载失败**（`parameters.type must be a value schema object`）：不再使用 `@deepseek-ai/dsh-tools` 的 `defineTool()`（其 parameters 走 property-map DSL，拒绝标准 JSON Schema），改为与 dsh-mnemon 相同的做法——直接把原始工具对象传给 `ctx.tools.register()`，parameters 使用完整 JSON Schema（type/properties/required）
- output.schema 改用 `{ type: "object", additionalProperties: true }`（与 dsh-mnemon 的 JSON_OBJECT_OUTPUT 一致，通过 register 的 assertSupportedJsonSchema 校验）
- 移除全部 npm dependencies（插件只用 node 内置模块，@deepseek-ai 包由 DSH 运行时提供），安装更轻、不再有解析风险

## [0.2.3] - 2026-08-19

### 修复
- 修复 dependencies 中包名错误：`@deepseek-ai/dsh-schemastery` → `@deepseek-ai/schemastery`（DSH 2.0.1 装的是后者）

## [0.2.2] - 2026-08-19

### 修复
- 修复 package.json 中 3 处 `your-name` 占位符（repository / bugs / homepage URL）
- 重命名 catalog-submission 文件：`your-name--dsh-plugin-stock.json` → `yllyx--dsh-plugin-stock.json`
- 同步更新 catalog 内容（id、repository）
- 改进 `publish-and-submit.js`：支持新旧两种模板文件名查找

## [0.2.1] - 2026-08-19

### 新增
- 📦 `publish.js` 一键发布脚本：
  - 自动运行测试、版本管理、安全检查、打包预览
  - 支持 `--bump patch|minor|major` 自动升级版本
  - 默认 dry-run，加 `--publish` 才实际发布
  - CI 模式 `--yes` 跳过确认
  - 支持发布到私有 registry
  - 发布后可选 git tag + push
- 📚 `PUBLISHING.md` 完整发布指南
- 📜 `CHANGELOG.md` 语义化版本历史
- 🚫 `.npmignore` 排除敏感文件和构建产物
- `npm run` 脚本：
  - `npm run publish` - 干运行
  - `npm run publish:patch` - 发布补丁
  - `npm run publish:minor` - 发布次版本
  - `npm run test` - 运行所有测试

## [0.2.0] - 2026-08-19

### 新增
- 🎯 **自动管理后端**：插件首次加载自动启动 Python 后端（无需用户手动 `launch.bat`）
  - 自动检测 Python 3.10+
  - 自动 `pip install` 依赖
  - 健康检查 + 自动重启
  - Sidebar 显示后端状态 + 一键重启按钮
- 📊 Sidebar 后端状态卡片：启动失败时显示错误原因
- 🔄 `BackendManager` 模块：独立的后端进程管理

### 改进
- npm 包结构更紧凑（22.9kB，14 文件）
- 后端代码内置到 plugin/，跟随 npm 包发布
- 测试更完善（test_apply.js + test_backend.js）

### 修复
- pytdx 导入路径 `pytdx.exhq` → `pytdx.hq`

## [0.1.0] - 2026-08-19

### 新增
- 📈 Sidebar 自选股面板：实时行情 WebSocket 推送
- 📊 大盘指数快览（上证、深证、创业板）
- 🔍 点击股票弹出 K线详情（klinecharts）
- 🎯 K线多周期切换：日/周/月 + 5/15/30/60 分
- 🎯 K线技术指标：MA、VOL、MACD
- ✋ 自选股拖拽排序（localStorage 持久化）
- 🤖 4 个 AI 助手工具：
  - `stock_quote`：查询实时行情
  - `stock_kline`：查询 K线数据
  - `stock_screen`：执行选股策略
  - `stock_holdings`：管理持仓
- ⚠️ 止盈/止损预警推送：Sidebar + 可选浏览器通知
- 🐍 Python 后端（FastAPI + pytdx）：
  - 11 个 REST API
  - WebSocket 实时推送
  - 4 种选股策略
  - 持仓监控
- 🔧 11 个通达信公式（兼容独立使用）

### 文档
- 完整 README + 使用文档 5 篇
- 安装、配置、扩展指南
