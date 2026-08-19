# 上线清单 - 从本地到公网

> 把 DSH 股票插件发布到 npm 公网 + 提交到插件市场
>
> **预计时间**：15-20 分钟

## 🎯 总览：3 步完成上线

```
第 1 步：在 npm 网站注册账号 + 命令行登录（5 分钟）
第 2 步：把代码推到 GitHub（10 分钟）
第 3 步：发布 npm + 提交插件市场（5 分钟）
```

---

## 第 1 步：注册 npm 账号（5 分钟）

### ⚠️ 重要：npm 已禁用 `npm adduser` 创建新账号

npm 公网 registry **关闭了命令行创建新账号的能力**。所有新账号必须通过**网页**创建。

报错 `Public registration is not allowed` 就是这个原因。

### 1.1 在 npm 网站注册

1. 打开 **https://www.npmjs.com/signup**
2. 填写：
   - **Username** — 一旦设置**不可改**，慎选（会成为 `@your-name/...` 形式）
   - **Email** — 必须能收件
   - **Password** — 建议 16+ 字符
3. 点击 **Create Account**
4. **去邮箱点验证链接**

### 1.2 关于 2FA（可选，但强烈推荐）

npm 的 2FA **不是强制要求**——你可以选择启用或不启用：

- **不启用 2FA**：`npm login` → 输入用户名密码 → 直接发布
- **启用 2FA**：`npm login` 多一步输 6 位验证码 → 每次发布要输 OTP
- **用 Token 代替**：Settings → Tokens → 创建 Automation Token → 发布时无需验证码

**建议**：本地偶尔发布可以不开 2FA（最省事）；如果你担心账号安全或经常发布包，启用 2FA 或用 Trusted Publishing（OIDC，CI 场景）。

**重要趋势**：npm 计划在 2026-2027 年逐步收紧 token 政策，最终强制使用 OIDC Trusted Publishing。详细见 [npm 官方公告](https://github.com/orgs/community/discussions/201329)。

### 1.3 命令行登录

```bash
npm login
```

按提示输入：
- Username
- Password
- Email

（如果启用了 2FA，会再要求 6 位 OTP）

成功后看到：
```
Logged in as your-username on https://registry.npmjs.org/
```

验证：
```bash
npm whoami
```

应输出你的用户名。

### 1.4（可选）使用 Token 绕过 2FA

如果启用了 2FA 但发布时不想输 OTP：

1. 访问 **https://www.npmjs.com/settings/tokens**
2. **Generate New Token** → **Classic Token**（推荐 Publish 权限）
3. 复制 token（**只显示一次**）
4. 用 token 当密码登录：

```bash
npm login --auth-type=legacy
# Username: your-username
# Password: <粘贴 token>
# Email: (直接回车)
```

或者写到 `~/.npmrc`：
```bash
echo '//registry.npmjs.org/:_authToken=YOUR_TOKEN' >> ~/.npmrc
```

### 1.5 更新 package.json 仓库地址

`plugin/package.json` 中三处 `your-name` 替换为你的 GitHub 用户名：

```json
"repository": {
  "url": "https://github.com/your-name/dsh-plugin-stock.git"  // ← 改这里
},
"bugs": {
  "url": "https://github.com/your-name/dsh-plugin-stock/issues"  // ← 改这里
},
"homepage": "https://github.com/your-name/dsh-plugin-stock#readme"  // ← 改这里
```

---

## 第 2 步：把代码推到 GitHub（10 分钟）

### 2.1 创建仓库

1. 访问 https://github.com/new
2. 填写：
   - **Repository name**: `dsh-plugin-stock`
   - **Description**: `DSH 股票监控插件 - 实时行情、K线、持仓监控、AI 对话式查询（仅监控）`
   - **Public**（必须）
   - ⚠️ 不要勾选 "Add a README" / "Add .gitignore"
3. **Create repository**

### 2.2 添加 `dsh-plugin` topic（必须）

1. 仓库主页 → 右侧 **About** ⚙️ 齿轮
2. **Topics** 输入 `dsh-plugin` 回车
3. 再加：`stock`, `china-stock`, `pytdx`
4. 保存

### 2.3 推送代码

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

git remote add origin https://github.com/your-name/dsh-plugin-stock.git
git branch -M main
git push -u origin main

git tag -a v0.2.1 -m "v0.2.1"
git push origin v0.2.1
```

---

## 第 3 步：发布 npm + 提交插件市场（5 分钟）

### 3.1 干运行检查

```bash
cd dsh-stock-plugin/plugin
node publish.js
```

应看到所有 ✓ 通过，包大小 ~27kB。

### 3.2 实际发布到 npm

```bash
npm run publish:patch
```

按 `y` 确认（如启用了 2FA 会要求 OTP）。完成后：

```
📦 dsh-plugin-stock@0.2.1 已发布到 latest
```

### 3.3 验证

```bash
npm view dsh-plugin-stock
```

应看到你的包信息。

### 3.4 提交到 DSH 插件市场

#### 3.4.1 Fork 市场仓库

https://github.com/imsai-sh/awesome-deepseek-harness-plugins → **Fork**

#### 3.4.2 生成并复制提交文件

```bash
cd dsh-stock-plugin/plugin
node publish-and-submit.js --owner=your-github-username

# 然后提交到 fork
git clone https://github.com/your-name/awesome-deepseek-harness-plugins.git
cd awesome-deepseek-harness-plugins
git checkout -b add-dsh-plugin-stock

# 复制生成的提交文件
cp ../dsh-stock-plugin/catalog-submission/your-username--dsh-plugin-stock.json \
   catalog/plugins/

git add catalog/plugins/
git commit -m "Add dsh-plugin-stock"
git push origin add-dsh-plugin-stock
```

#### 3.4.3 创建 PR

GitHub 上点 **Compare & pull request**：

> 标题：`Add dsh-plugin-stock - A 股监控插件`

CI 自动校验 `cordis.patch.yml` 和 `dsh.bundle.patch` 字段，约 5-30 分钟自动合并。

合并后同步到 https://deepseek1024.com/ 。

---

## 第 4 步：安装验证

```bash
# 方式 A：通过市场
dsh plugin --profile web add your-name/dsh-plugin-stock

# 方式 B：手动
pnpm add dsh-plugin-stock
```

重启 DSH，Sidebar 出现「📈 股票」入口。首次启动会自动下载 Python 依赖并启动后端。

---

## 📋 完整命令清单

```bash
# === 第 1 步：npm 注册 ===
# 浏览器：https://www.npmjs.com/signup 注册 + 邮箱验证
# （可选）启用 2FA 或创建 Token

npm login                     # 输入用户名/密码/email
npm whoami                    # 验证登录

# === 第 2 步：GitHub ===
cd dsh-stock-plugin
git init
git add .
git commit -m "feat: DSH 股票监控插件初始发布"
git remote add origin https://github.com/YOUR-USERNAME/dsh-plugin-stock.git
git branch -M main
git push -u origin main
git tag -a v0.2.1 -m "v0.2.1"
git push origin v0.2.1

# GitHub 添加 topic：dsh-plugin, stock, china-stock, pytdx

# === 第 3 步：发布 ===
cd plugin
node publish.js              # 干运行
npm run publish:patch        # 实际发布

# === 第 3.4 步：插件市场 ===
git clone https://github.com/YOUR-USERNAME/awesome-deepseek-harness-plugins.git
cd awesome-deepseek-harness-plugins
git checkout -b add-dsh-plugin-stock
mkdir -p catalog/plugins
cp ../dsh-stock-plugin/catalog-submission/YOUR-USERNAME--dsh-plugin-stock.json \
   catalog/plugins/
git add catalog/plugins/
git commit -m "Add dsh-plugin-stock"
git push origin add-dsh-plugin-stock

# 在 GitHub 网页点击 "Compare & pull request"
```

---

## 🆘 故障排查

### `Public registration is not allowed`

去 https://www.npmjs.com/signup 网页注册 → 邮箱验证 → `npm login`

### `npm login` 提示 `code required` / `EOTP`

启用了 2FA 但 OTP 错误。等 Authenticator 自动刷新（30 秒/次），输入最新的 6 位数。

### `npm publish` 报错 `ENEEDAUTH`

```bash
npm logout && npm login
```

### `npm publish` 报错 `402 Payment Required`

包名已被占用。改 scoped：
```json
"name": "@your-name/dsh-plugin-stock"
```
同时把 `publishConfig.access` 改为 `"public"`。

### `npm publish` 报错 `403 Forbidden`

邮箱未验证。查邮箱点验证链接。

### publish.js 报错 "未登录 npm"

```bash
npm whoami    # 验证
npm logout && npm login
```

### 插件市场 CI 报错 "缺少 dsh.bundle.patch"

确认 `plugin/package.json` 有：
```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

### 插件市场 CI 报错 "patch file not found"

确认仓库根目录或 `plugin/` 下有 `cordis.patch.yml`。

### 插件市场 CI 报错 "category invalid"

支持的 category：`tools`, `dev`, `ui`, `data`, `integration`, `language`, `media`。我们用 `tools`。

### 误操作：撤回已发布的包

72 小时内：
```bash
npm unpublish dsh-plugin-stock@0.2.1 --force
```

72 小时后只能 deprecate：
```bash
npm deprecate dsh-plugin-stock@0.2.1 "version replaced by 0.2.2"
```

---

## ✅ 上线完成标志

- [ ] npm 网站注册成功：`https://www.npmjs.com/~your-username` 能看到 profile
- [ ] 邮箱已验证
- [ ] `npm whoami` 输出你的用户名
- [ ] GitHub 仓库可见：`https://github.com/your-name/dsh-plugin-stock`
- [ ] npm 包可见：`npm view dsh-plugin-stock` 有输出
- [ ] 插件市场收录：在 https://deepseek1024.com/ 搜 "stock" 能找到
- [ ] 安装测试：`pnpm add dsh-plugin-stock` 后 DSH Sidebar 出现「📈 股票」

全部勾选 = 上线成功 🎉

---

## 📚 关键链接

| 用途 | 链接 |
|------|------|
| npm 注册 | https://www.npmjs.com/signup |
| npm 个人设置 | https://www.npmjs.com/settings/profile |
| npm Tokens | https://www.npmjs.com/settings/tokens |
| npm 状态 | https://status.npmjs.org/ |
| npm 2FA 文档 | https://docs.npmjs.com/about-two-factor-authentication |
| npm Token 政策变更 | https://github.com/orgs/community/discussions/201329 |
| DSH 插件市场 | https://github.com/imsai-sh/awesome-deepseek-harness-plugins |
| 在线市场 | https://deepseek1024.com/ |
