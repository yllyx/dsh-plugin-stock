# 发布指南

> 把 DSH 股票插件发布到 npm 的完整流程

## 🚀 快速发布

```bash
cd dsh-stock-plugin/plugin

# 1. 干运行 - 检查一切是否就绪（不实际发布）
node publish.js

# 2. 实际发布（自动升级补丁版本号 0.1.0 → 0.1.1）
node publish.js --bump patch --publish

# 3. 发布新功能（次版本号 0.1.1 → 0.2.0）
node publish.js --bump minor --publish

# 4. 重大更新（主版本号 0.2.0 → 1.0.0）
node publish.js --bump major --publish
```

## 📋 发布脚本功能

`publish.js` 是为 DSH 股票插件定制的一键发布工具，包含：

| 步骤 | 检查内容 |
|------|---------|
| 1 | 当前目录正确（plugin/） |
| 2 | 版本号升级（--bump） |
| 3 | package.json 必填字段 |
| 4 | 运行 `test_apply.js` |
| 5 | 检查敏感文件 |
| 6 | `npm pack --dry-run` 预览 |
| 7 | `npm publish` 实际发布 |
| 8 | 可选 git tag + push |

## 🎯 典型场景

### 场景 1：首次发布

```bash
# 1. 注册 npm 账号（如果还没有）
npm adduser

# 2. 登录
npm login

# 3. 干运行
node publish.js
# 输出：所有检查通过，包大小、文件列表

# 4. 实际发布
node publish.js --publish
# 输出：版本号、确认、发布、安装说明
```

### 场景 2：日常小更新（bug fix）

```bash
# 修改了代码...
git add .
git commit -m "fix: 修复某问题"

# 发布补丁版本
node publish.js --bump patch --publish

# 自动创建 git tag v0.1.1
git push origin main --tags
```

### 场景 3：发布 beta 预览版

```bash
node publish.js --bump minor --publish --tag beta

# 用户安装 beta 版：
npm install dsh-plugin-stock@beta
```

### 场景 4：发布到私有 registry（公司内网）

```bash
# 启动本地 verdaccio
npx verdaccio

# 发布到本地
node publish.js --publish --registry http://localhost:4873 --yes
```

## 🔐 安全检查清单

发布前 `publish.js` 会自动检查：

- [x] package.json 必填字段完整
- [x] DSH 插件声明 (`dsh.client.inject`)
- [x] 测试通过 (`test_apply.js`)
- [x] 没有 `.env`、`config.json` 等敏感文件
- [x] 没有 `__pycache__`、`*.pyc`
- [x] 没有 `node_modules`、`*.tgz`
- [x] npm 用户已登录
- [x] 用户确认发布（除非 `--yes`）

`.npmignore` 已经处理：
- ✅ `backend/config.json`（用户运行时生成）
- ✅ `backend/test_smoke.py`（开发用）
- ✅ `__pycache__/`
- ✅ 所有 Python 编译缓存
- ✅ IDE/日志/环境配置

## 📦 包内容（0.2.0）

```
dsh-plugin-stock-0.2.0.tgz  (22.9 kB 压缩，86.6 kB 解压)
├── package.json
├── lib/
│   ├── index.js           (12.1 kB - AI 工具)
│   ├── client.js          (26.6 kB - Sidebar UI)
│   └── backend-manager.js (7.4 kB - 后端管理)
├── backend/
│   ├── main.py            (9.4 kB)
│   ├── alert_engine.py    (7.8 kB)
│   ├── screener.py        (7.0 kB)
│   ├── data_source.py     (4.4 kB)
│   ├── ws_manager.py      (3.9 kB)
│   ├── requirements.txt   (368 B)
│   ├── launch.bat         (备用)
│   ├── launch.sh          (备用)
│   └── config.example.json
```

## 🔄 版本策略

| 版本类型 | 何时使用 |
|---------|---------|
| **patch** (0.0.1) | bug 修复、文案修正 |
| **minor** (0.1.0) | 新功能、新 API、不破坏兼容性 |
| **major** (1.0.0) | 破坏性变更（API 重构、配置变更） |

当前版本：`0.2.0`（还在 0.x → 1.0 之前，可以自由迭代）

## 🧪 在 CI/CD 中使用

```yaml
# GitHub Actions 示例
- name: Publish to npm
  run: |
    cd plugin
    echo "${{ secrets.NPM_TOKEN }}" | npm login --auth-type=legacy --registry=https://registry.npmjs.org/
    node publish.js --bump patch --publish --yes
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## ❓ 常见问题

**Q: 包名被占用怎么办？**
A: 在 `package.json` 修改 `name` 字段，使用 scoped package：`@your-name/dsh-plugin-stock`

**Q: 发布后如何撤回？**
A: `npm unpublish dsh-plugin-stock@0.2.0`（npm 政策：发布 72 小时内可撤回）

**Q: 如何发布 alpha 版本？**
A: `node publish.js --bump minor --publish --tag alpha`

**Q: 私有 registry 的认证？**
A: `npm login --registry <url>` 登录一次即可

**Q: 包太大怎么办？**
A: 当前 22.9kB 已经是极限压缩。如需进一步：把 Python 依赖移出（让用户 pip install）

## 📚 相关文档

- [npm publish 官方文档](https://docs.npmjs.com/cli/v10/commands/npm-publish)
- [语义化版本](https://semver.org/lang/zh-CN/)
- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)
- [DSH 插件开发指南](README.md)
