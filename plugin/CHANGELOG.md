# 更新日志

所有重要的变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
本项目遵循 [语义化版本](](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- 持仓复盘报告（每日/每周）
- 多账户支持
- 龙虎榜/北向资金集成
- 自选股导入导出

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
