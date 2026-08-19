# 上线清单 - 从本地到公网

> 把 DSH 股票插件发布到 npm 公网 + 提交到插件市场
>
> **预计时间**：15 分钟（其中 14 分钟是 npm 安装依赖 + 你手动 `npm login`）

## 🎯 总览：4 步完成上线

```
本地准备 (已完成) → 创建 GitHub 仓库 → 发布 npm → 提交插件市场
```

---

## 第 1 步：把代码推到 GitHub（10 分钟）

### 1.1 创建仓库

1. 访问 https://github.com/new
2. 填写：
   - **Repository name**: `dsh-plugin-stock`
   - **Description**: `DSH 股票监控插件 - 实时行情、K线、持仓监控、AI 对话式查询（仅监控）`
   - **Public**（必须，插件市场只能收录公开仓库）
   - ⚠️ 不要勾选 "Add a README" / "Add .gitignore"（我们自己有）
3. 点击 **Create repository**

### 1.2 添加 `dsh-plugin` topic（关键）

1. 在仓库主页 → 右侧 **About** 旁的 ⚙️ 齿轮
2. 在 **Topics** 输入 `dsh-plugin` 回车
3. 再加几个：`stock`, `china-stock`, `pytdx`
4. 保存

### 1.3 推送代码

```bash
cd dsh-stock-plugin

git init
git add .
git commit -m "feat: DSH 股票监控插件初始发布

- 自动管理 Python 后端（pytdx 行情 + FastAPI）
- 4 个 AI 工具（stock_quote/kline/screen/holdings）
- Sidebar 自选股 + K线（klinecharts）+ 拖拽排序
- 止盈止损预警推送（仅监控，不自动交易）
- 一键发布脚本 + 完整文档"

# 替换 your-name 为你的 GitHub 用户名
git remote add origin https://github.com/your-name/dsh-plugin-stock.git
git branch -M main
git push -u origin main

# 创建第一个 tag（插件市场会读）
git tag -a v0.2.1 -m "v0.2.1"
git push origin v0.2.1
```

### 1.4 验证仓库

- 访问 `https://github.com/your-name/dsh-plugin-stock`
- 确认 `cordis.patch.yml` 和 `dsh.plugin.json` 存在
- 确认 topic `dsh-plugin` 已添加

---

## 第 2 步：发布到 npm 公网（5 分钟）

### 2.1 注册/登录 npm

```bash
# 已有账号：
npm login

# 没账号：
npm adduser
```

按提示输入：
- Username
- Password
- Email
- One-time password（如果开了 2FA）

### 2.2 更新 package.json 的仓库地址

`plugin/package.json` 第 57 行：
```json
"url": "https://github.com/your-name/dsh-plugin-stock.git"
```

同样改 `bugs.url` 和 `homepage` 的 `your-name`。

### 2.3 干运行一次

```bash
cd dsh-stock-plugin/plugin
node publish.js
```

应看到所有 ✓ 通过，包大小 ~27kB。

### 2.4 实际发布

```bash
npm run publish:patch
```

按提示输入 `y` 确认。完成后会显示：
```
📦 dsh-plugin-stock@0.2.1 已发布到 latest
用户安装方式：
  npm install dsh-plugin-stock
  pnpm add dsh-plugin-stock
```

### 2.5 验证

```bash
npm view dsh-plugin-stock
```

应看到你的包信息和描述。

---

## 第 3 步：提交到 DSH 插件市场（5 分钟）

### 3.1 Fork 插件市场仓库

访问 https://github.com/imsai-sh/awesome-deepseek-harness-plugins → 点击右上角 **Fork**

### 3.2 复制并修改提交文件

```bash
# 克隆你的 fork
git clone https://github.com/your-name/awesome-deepseek-harness-plugins.git
cd awesome-deepseek-harness-plugins

# 创建分支
git checkout -b add-dsh-plugin-stock

# 复制预制文件（已经准备好）
cp /path/to/dsh-stock-plugin/catalog-submission/your-name--dsh-plugin-stock.json \
   catalog/plugins/your-name--dsh-plugin-stock.json
```

### 3.3 修改提交文件

打开 `catalog/plugins/your-name--dsh-plugin-stock.json`，把所有 `your-name` 替换为你的 GitHub 用户名（共 3 处）：

```json
{
  "id": "<你的用户名>/dsh-plugin-stock",
  "name": "dsh-plugin-stock",
  "repository": "https://github.com/<你的用户名>/dsh-plugin-stock",
  ...
}
```

### 3.4 提交 PR

```bash
git add catalog/plugins/your-name--dsh-plugin-stock.json
git commit -m "Add dsh-plugin-stock"
git push origin add-dsh-plugin-stock
```

GitHub 上点击 **Compare & pull request** → 写标题：
> Add dsh-plugin-stock - A 股监控插件（实时行情/K线/持仓/AI 对话）

描述可以写：
> Auto-managed pytdx backend, 4 AI tools, K-line charts, screener, holdings monitor. Read-only.

### 3.5 等待审核

CI 会自动：
- 验证 `dsh.bundle.patch` 存在
- 读取你的 GitHub 仓库
- 确认 `cordis.patch.yml` 文件存在
- 校验所有必填字段
- 通过后自动合并（约 5-30 分钟）

合并后：
- 自动同步到 https://deepseek1024.com/
- 出现在 `catalog/README.md`
- 通过 API 可被搜索：`https://api.deepseek1024.com/v1/plugins/search?q=stock`

---

## 第 4 步：安装验证（2 分钟）

### 4.1 通过市场安装

```bash
# 方式 A：DSH 命令
dsh plugin --profile web add your-name/dsh-plugin-stock

# 方式 B：手动
pnpm add dsh-plugin-stock
```

### 4.2 重启 DSH

DSH 自动加载插件，Sidebar 出现「📈 股票」入口。

### 4.3 首次启动会自动：

1. 检测 Python 3.10+
2. `pip install` 依赖（约 1-2 分钟）
3. 启动 uvicorn 后端
4. Sidebar 显示「● 实时」

---

## 📋 完整命令清单（按顺序）

```bash
# === 第 1 步：GitHub ===
cd dsh-stock-plugin
git init
git add .
git commit -m "feat: DSH 股票监控插件初始发布"
git remote add origin https://github.com/YOUR-USERNAME/dsh-plugin-stock.git
git branch -M main
git push -u origin main
git tag -a v0.2.1 -m "v0.2.1"
git push origin v0.2.1

# 访问 GitHub 添加 topic：dsh-plugin, stock, china-stock, pytdx

# === 第 2 步：npm ===
# 编辑 plugin/package.json，改 your-name 为你的 GitHub 用户名
npm login
cd plugin
node publish.js                    # 干运行
npm run publish:patch              # 实际发布

# === 第 3 步：插件市场 ===
git clone https://github.com/YOUR-USERNAME/awesome-deepseek-harness-plugins.git
cd awesome-deepseek-harness-plugins
git checkout -b add-dsh-plugin-stock
mkdir -p catalog/plugins
cp ../dsh-stock-plugin/catalog-submission/your-name--dsh-plugin-stock.json \
   catalog/plugins/
# 编辑该文件，把 your-name 替换成你的 GitHub 用户名
git add catalog/plugins/
git commit -m "Add dsh-plugin-stock"
git push origin add-dsh-plugin-stock

# 在 GitHub 网页点击 "Compare & pull request"
# 标题：Add dsh-plugin-stock
# 提交，等待 CI 自动合并
```

---

## 🆘 故障排查

### publish.js 报错 "未登录 npm"

```bash
npm whoami   # 验证登录状态
npm logout   # 重新登录
npm login
```

### 插件市场 CI 报错 "package.json 缺少 dsh.bundle.patch"

确认 `plugin/package.json` 包含：
```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

### 插件市场 CI 报错 "patch file not found"

确认仓库根目录（或 plugin/ 目录，取决于 id 路径）有 `cordis.patch.yml` 文件。

### 插件市场 CI 报错 "category invalid"

目前支持的 category（参考现有插件）：`tools`, `dev`, `ui`, `data`, `integration`, `language`, `media`

我们用了 `tools`（AI 工具类）。

### npm publish 报错 "402 Payment Required"

包名已被占用。改名方案：
```json
"name": "@your-name/dsh-plugin-stock"
```

同时把 `publishConfig.access` 改为 `"public"`，然后重试。

---

## ✅ 上线完成标志

- [ ] GitHub 仓库可见：`https://github.com/your-name/dsh-plugin-stock`
- [ ] npm 包可见：`npm view dsh-plugin-stock` 有输出
- [ ] 插件市场收录：在 https://deepseek1024.com/ 搜索"stock"能找到
- [ ] 安装测试：`pnpm add dsh-plugin-stock` 后 DSH Sidebar 出现「📈 股票」

全部勾选 = 上线成功 🎉
