# DSH 股票监控插件

> 把通达信行情和持仓监控集成到 DeepSeek Harness 中。**插件自动管理后端，无需手动启动。**

## ⚠️ 定位声明

本插件是**纯监控工具**：
- ✅ 查看行情、K线（集成 klinecharts）
- ✅ 自选股拖拽排序（localStorage 持久化）
- ✅ 维护持仓记账、计算盈亏
- ✅ 触发止盈/止损**预警推送**（弹窗、声音、浏览器通知）
- ✅ AI 对话式查询（"查一下茅台现在多少"、"我今天盈亏"）
- ❌ **不做任何下单、自动调仓、条件单执行**
- ❌ **不接入券商账户、不读取资金**
- ❌ **不替代用户决策**

所有买卖仍由用户在**券商 App / 通达信客户端**手动执行。

## 📦 项目结构

```
dsh-stock-plugin/
├── README.md
└── plugin/                         # 一个 npm 包包含一切
    ├── package.json                # 包名：dsh-plugin-stock
    ├── lib/
    │   ├── index.js                # Host 端：自动启动后端 + 注册 4 个 AI 工具
    │   ├── client.js               # Client 端：Sidebar 面板（含 K线 + 拖拽 + 状态卡）
    │   └── backend-manager.js      # Python 后端进程管理器
    ├── backend/                    # Python 后端代码（跟随 npm 包发布）
    │   ├── main.py
    │   ├── data_source.py
    │   ├── screener.py
    │   ├── alert_engine.py
    │   ├── ws_manager.py
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
| Python 后端 | ✅ 11 个 API 端点 |
| 自动启动 | ✅ 检测 Python / 安装依赖 / spawn uvicorn |
| 进程生命周期 | ✅ 启动健康检查 / 优雅停止 / 失败重启 |
| 插件 npm 包 | ✅ 22.9kB 压缩包，含后端代码 |
| AI 工具 | ✅ 4 个（stock_quote/kline/screen/holdings） |
| Sidebar 面板 | ✅ 实时行情 + 后端状态卡 + K线 + 拖拽 |

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

### 1. Sidebar 面板

DSH 左侧栏点击「📈 股票」：
- **后端状态卡**（仅启动失败时显示）
- **大盘指数**：上证、深成、创业板
- **自选股**：实时 WebSocket 推送
- **拖动排序**：拖拽手柄重新排列
- **点击股票**：弹出 K线详情
- **K线周期**：日/周/月 + 5/15/30/60 分
- **持仓盈亏**：成本、现价、盈亏百分比
- **预警历史**：止盈止损触发记录

### 2. AI 对话

```
"查一下 600519 现在多少钱"
"茅台最近 60 天的 K 线发我看看"
"现在市场上有什么启动股"
"我的持仓盈亏"
"添加持仓 600519 茅台 100股 1500元"
"删除持仓 000001"
```

### 3. 预警推送

`alert_engine.py` 默认每 30 秒检查持仓：
- 触发止损线（默认 -7%）→ 推送预警
- 触发止盈线（默认 +15%）→ 推送预警
- WebSocket 实时推送到 Sidebar
- 可选浏览器通知、企业微信/钉钉 webhook

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
