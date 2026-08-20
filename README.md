# DSH 股票监控插件

> A 股**交易体系助手**：择时（跌无可跌+企稳信号）、情绪与风格判定（抱团 vs 妖股）、板块监控与龙头候选、仓位体检、移动/阶梯止盈止损预警。**插件自动管理后端，无需手动启动。**

## ⚠️ 定位声明

本插件是**分析+监控工具，不是自动交易系统**：
- ✅ 大盘择时：阶段判定（主升/震荡/下跌/主跌）、"跌无可跌"7因子清单、"企稳信号"4项确认、建议仓位区间
- ✅ 情绪与风格：涨停/跌停/炸板/连板梯队，机构抱团期 ⇄ 题材妖股期判定与适配策略
- ✅ 板块与龙头：行业/概念排行、板块阶段（启动/发酵/高潮/退潮）、龙头候选打分
- ✅ 仓位体检：总仓位 vs 建议区间、单票≤25%、同行业≤40%、现金比例
- ✅ 止盈止损预警：固定/移动止损/阶梯止盈三模式 + 时间止损提醒（弹窗+浏览器通知）
- ✅ 行情、K线（klinecharts）、持仓记账盈亏、全市场选股（4策略）
- ✅ AI 对话式查询（"现在能入场吗"、"哪个板块要启动"、"我仓位重不重"）
- ❌ **不做任何下单、自动调仓、条件单执行**
- ❌ **不接入券商账户、不读取真实资金**（总资金由用户手动录入用于仓位计算）
- ❌ **不替代用户决策**

所有买卖仍由用户在**券商 App / 通达信客户端**手动执行。

## 🧭 交易体系工作流（六大 Tab / AI 工具链）

```
择时 stock_market_timing   → 能不能做（阶段/跌无可跌/企稳/建议仓位）
  ↓
风格 stock_sentiment       → 怎么做（抱团趋势跟随 or 妖股打板低吸）
  ↓
板块 stock_sectors         → 做什么方向（启动期板块 + 龙头候选）
  ↓
选股 stock_screen          → 买什么（4策略 + 全市场预热池）
  ↓
仓位 stock_position        → 买多少（总仓位/单票/行业集中度体检）
  ↓
风控 stock_holdings        → 怎么保护（fixed/trailing/ladder + 时间止损）
```

## 📦 项目结构

```
dsh-stock-plugin/
├── README.md
└── plugin/                         # 一个 npm 包包含一切
    ├── package.json                # 包名：dsh-plugin-stock
    ├── lib/
    │   ├── index.js                # Host 端：自动启动后端 + 注册 8 个 AI 工具
    │   ├── client.js               # Client 端：6 Tab 交易体系仪表盘
    │   └── backend-manager.js      # Python 后端进程管理器
    ├── backend/                    # Python 后端代码（跟随 npm 包发布）
    │   ├── main.py                 # FastAPI 入口（20+ REST + WebSocket）
    │   ├── data_source.py          # pytdx 行情 + K线路由（指数index_bars/个股东财）
    │   ├── eastmoney.py            # 东财免费接口（涨跌停池/板块/两融/全市场表）
    │   ├── market_timing.py        # 择时引擎（跌无可跌/企稳/阶段/建议仓位）
    │   ├── market_sentiment.py     # 情绪统计 + 风格判定
    │   ├── sector_monitor.py       # 板块排行/阶段标签/龙头候选
    │   ├── position_manager.py     # 资金账户 + 仓位体检
    │   ├── alert_engine.py         # 止盈止损2.0 + 预警规则 + 历史
    │   ├── screener.py             # 4策略选股 + 全市场预热池
    │   ├── ws_manager.py           # WebSocket 推送
    │   ├── requirements.txt
    │   ├── launch.bat / launch.sh  # 备用：用户手动启动入口
    │   └── test_smoke.py
    ├── test_apply.js               # 插件加载测试
    └── test_backend.js             # 后端管理测试
```

## 🎯 核心改进：自动管理后端

**之前**：用户需要手动 `cd backend && launch.bat`
**现在**：插件首次加载时**自动**：
1. 检测 Python 3.10+ 是否安装
2. 检测依赖是否已装（首次运行自动 `pip install`）
3. 启动 uvicorn 后端
4. 健康检查通过后激活 AI 工具
5. DSH 关闭时优雅终止后端

**Sidebar 面板会显示后端状态**：
- 🟢 实时 - 正常
- ⏳ 启动中 - 等待后端响应
- ❌ 失败 - 显示错误原因 + 重试按钮
- 启动失败时一键重启（插件侧按钮）

## ✅ 当前状态

| 项 | 状态 |
|----|------|
| Python 后端 | ✅ 20+ API 端点（择时/情绪/板块/仓位/持仓/预警/选股） |
| 自动启动 | ✅ 检测 Python / 安装依赖 / spawn uvicorn |
| 进程生命周期 | ✅ 启动健康检查 / 优雅停止 / 失败重启 |
| 插件 npm 包 | ✅ 含全部后端代码 |
| AI 工具 | ✅ 8 个（行情/K线/择时/情绪/板块/选股/持仓/仓位） |
| 页面 | ✅ 6 Tab 仪表盘（择时/情绪风格/板块/持仓仓位/预警/选股） |
| 数据源 | ✅ pytdx（行情+指数K线）+ 东财免费接口（涨跌停池/板块/两融/K线） |

## 🚀 安装（标准 DSH 插件模式）

> 插件就是 npm 包，被 DSH 启动时自动发现并加载。**不需要修改 DSH 源码。**

### 步骤 1：前置要求

**必须**：系统已安装 **Python 3.10+** 并加入 PATH
```bash
python --version    # 应输出 Python 3.10 或更高
```

如未安装：https://www.python.org/downloads/（安装时勾选 "Add to PATH"）

### 步骤 2：把插件接入 DSH

#### 方式 A：本地依赖（推荐）

如果你有 DSH 源码仓库：

```bash
cd ~/deepseek-harness-desktop

# 把 plugin/ 复制到 packages/ 目录下
cp -r ../dsh-stock-plugin/plugin packages/dsh-plugin-stock

# 编辑根 package.json 加依赖
# "@deepseek-ai/dsh-plugin-stock": "workspace:*"

pnpm install
pnpm run build
```

#### 方式 B：发布到 npm（推荐用发布脚本）

```bash
cd dsh-stock-plugin/plugin

# 干运行（推荐先跑）
node publish.js

# 实际发布 + 自动升级补丁版本
npm run publish:patch
```

发布脚本会自动：
- ✅ 运行测试（test_apply.js）
- ✅ 验证 package.json 必填字段
- ✅ 检查敏感文件
- ✅ 预览打包内容
- ✅ 版本号管理（`--bump patch|minor|major`）
- ✅ npm login 检查
- ✅ 发布后可选 git tag

详见 `plugin/PUBLISHING.md`。

#### 方式 C：软链接

```bash
ln -s /path/to/dsh-stock-plugin/plugin \
   /path/to/dsh/node_modules/@deepseek-ai/dsh-plugin-stock
# 重启 DSH
```

> ⚠️ 当前 DSH 是已编译的桌面版，最干净方式是：
> 1. 克隆 DSH 源码
> 2. 用方式 A 集成
> 3. `pnpm run build` 重新打包

### 步骤 3：重启 DSH

DSH 启动时会：
1. 扫描 `node_modules/@deepseek-ai/` 发现 `dsh-plugin-stock`
2. 自动启动 Python 后端（首次运行约 1-2 分钟）
3. Sidebar 出现「📈 股票」入口
4. AI 助手工具列表新增 4 个工具

**首次启动日志**（DSH 控制台可见）：
```
[plugin] [dsh-plugin-stock] 后端状态: starting
[plugin] [backend] [dsh-plugin-stock:backend] 使用 Python: python (Python 3.11.13)
[plugin] [backend] [dsh-plugin-stock:backend] 首次运行，安装依赖中...
[plugin] [backend] [dsh-plugin-stock:backend] running
[plugin] dsh-plugin-stock: 已注册 stock_quote / stock_kline / stock_screen / stock_holdings 工具
```

## 🎯 使用

### 1. 股票监控面板（6 Tab 仪表盘）

DSH 侧边栏点击「📈 股票监控」：

- **⏱ 择时**：5指数卡、市场阶段徽章、建议仓位、跌无可跌/企稳信号双清单、操作节奏
- **🔥 情绪风格**：涨停/跌停/炸板/涨跌家数/成交额、连板梯队、抱团⇄妖股风格滑块+因子+适配策略
- **🧩 板块**：行业/概念排行（涨幅/成交额/5日动量/阶段标签），点击展开龙头候选（含理由），点击个股看K线
- **💼 持仓仓位**：总资金设置、仓位进度条（当前vs建议+现金）、风险提示、持仓增删改+止损模式下拉
- **⚠️ 预警**：规则增删启停 + 触发历史（持久化）
- **🔍 选股**：4策略一键扫描 + 全市场池开关（后台预热约20分钟）+ 命中理由

### 2. AI 对话

```
"现在大盘能入场吗"           → stock_market_timing（择时诊断）
"现在是抱团行情还是题材行情"  → stock_sentiment（风格判定）
"哪个板块要启动，龙头是谁"    → stock_sectors（板块+龙头候选）
"帮我找启动股，全市场"        → stock_screen
"我仓位重不重"               → stock_position（仓位体检）
"查一下 600519 现在多少钱"
"添加持仓 600519 茅台 100股 1500元 移动止损"
"删除持仓 000001"
```

### 3. 预警推送（止盈止损 2.0）

`alert_engine.py` 每 30 秒检查持仓，三种模式：

| 模式 | 逻辑 |
|------|------|
| `fixed` 固定比例 | 止损默认 -7%、止盈默认 +15% |
| `trailing` 移动止损 | 盈利>5%后止损线上移到成本（保本）；从最高点回撤超阈值（默认10%）触发 |
| `ladder` 阶梯止盈 | +20% 提示卖1/3，+50% 再卖1/3，尾仓按移动止损保护 |

外加**时间止损**：买入超5个交易日仍无涨幅 → 提醒"判断可能出错"。

- WebSocket 实时推送到页面 + 可选浏览器通知
- 触发历史持久化（最近200条），页面"预警"Tab 可查
- 自定义规则（价格突破/跌破/涨幅）可增删启停

> 预警只是提醒，**不会自动平仓**。

## 🧪 验证

### 插件加载测试

```bash
cd plugin
node test_apply.js
# ✓ 注册 4 个工具，apply() 成功
```

### 后端管理测试

```bash
cd plugin
node test_backend.js
# ✓ 自动检测 Python/依赖/启动/健康检查/停止
```

### 后端冒烟测试（需要 Python）

```bash
cd plugin/backend
python test_smoke.py
# ✓ 7 通过, 1 失败（仅依赖 TDX 服务器的项）
```

## 🔧 配置

### 修改后端端口

```bash
# Windows
set STOCK_BACKEND_PORT=9876
# Linux/Mac
export STOCK_BACKEND_PORT=9876
```

### 关闭自动安装

如果不想自动 `pip install`，修改 `lib/backend-manager.js`:
```javascript
new BackendManager({ autoInstall: false });
```
然后手动 `pip install -r backend/requirements.txt`

### 修改止盈止损默认值

`backend/alert_engine.py` 中 `add_holding()` 函数的 `stop_loss_pct` 和 `take_profit_pct` 参数。

## 📊 vs 通达信

| 功能 | 通达信 | 本插件 |
|------|------|------|
| 实时行情 | ✅ | ✅ |
| K线 | ✅（专业） | ✅（klinecharts） |
| 拖拽排序 | ✅ | ✅ |
| 自选股 | ✅ | ✅ |
| 持仓监控 | ✅ | ✅ |
| 止盈止损预警 | ✅ | ✅ |
| 选股公式 | ✅（完整） | ⚠️（4 种核心） |
| 程序化交易 | ✅ | ❌（**不做**） |
| **自动启动** | - | ✅（首次配置 Python 后） |
| **AI 对话查询** | - | ✅（独有） |

## 📜 许可

MIT

## 🙏 致谢

- pytdx - 通达信协议 Python 实现
- klinecharts - 专业 K线图库
- FastAPI - Web 框架
- DSH - DeepSeek Harness 插件体系
