# dsh-dock · 功能坞

[![npm version](https://img.shields.io/npm/v/dsh-dock)](https://www.npmjs.com/package/dsh-dock)
[![license](https://img.shields.io/npm/l/dsh-dock)](LICENSE)

**DeepSeek Harness 功能坞插件（dsh-dock）**：用一张管理面板，统一注册、开关所有小功能。

模型余额、Token 用量记录、任务动画……这些散落的小功能，全部收进一个「功能坞」：
每个功能是独立模块，有注册表、有开关、有错误隔离。新功能按注册表模式追加，老功能互不牵连。

> 前身：本地原型 `feature-hub`（已安装验证），本包为其正式发布的 npm 版本。
> 相关功能包：`@wycto/dsh-balance-panel`、`@wycto/dsh-token-usage`、`@wycto/dsh-task-pulse`
> （余额功能已于 0.2.0 吸收为中枢内模块；其余按路线图继续吸收或保持独立包注册进中枢）。
> 开发背景与决策见 [docs/session-notes.md](docs/session-notes.md)。

---

## 当前状态（v0.2.0 · 模型余额已接入）

- ✅ 设置页新增一整页「功能坞」面板（侧栏底部 → 设置 → 功能坞）
- ✅ **侧栏入口按钮**：侧栏底部动作区右端（设置按钮同一区域）出现「功能坞」按钮，点击弹出**功能面板**（仿 dsh 设置：居中模态 = 遮罩 + 对话框；左侧导航首项为**「首页」总揽**（默认选中，所有子功能的状态/概要/快捷开关卡片一览，点击卡片进入对应功能），下方为各功能模块导航；点遮罩或 ✕ 关闭）
- ✅ 功能注册表：`FEATURES` 一处登记，面板自动渲染
- ✅ 每功能独立开关 + 错误隔离：单个功能出错只降级自己
- ✅ 示例功能：心跳监视、主题信息（纯 Client，开箱可用）
- ✅ **模型余额（0.2.0）**：Host 半部枚举全部已配置 Provider，按内置策略表查询余额/配额/控制台链接；面板内实时展示，5 分钟自动刷新 + 手动刷新
- 🚧 示例功能与余额开关为浏览器内存态，刷新重置（持久化在 0.5.0）
- 🚧 两个真实功能（Token 用量记录、任务动画）已登记为规划占位，面板可见但显示"规划中"

### 模型余额支持情况（0.2.0）

内置余额策略表覆盖：**DeepSeek**（官方余额接口）、**StepFun**、**Kimi Coding**（配额）、**OpenRouter**、**MiniMax**、**xAI/grok**；
按 provider id（含别名）或 baseURL 家族自动匹配；`qwen-token-plan-*`（阿里云百炼）等无 API 余额接口的 Provider 显示"需登录"并提供控制台跳转链接；
其余未知 Provider 显示"不支持"。自定义余额接口可在 Provider profile 里配 `balance.endpoint` 覆盖（沿用 `dsh-balance-panel` 约定）。

密钥全程留在 Host 进程内：只按 `apiKeyEnv` 解析凭证使用，不出 Host、不下发到浏览器。
数据经回环 webServer 路由 `GET /dsh-dock/balance` 同源下发（Client `fetch` 拉取，不依赖 typert RPC，详见 [docs/session-notes.md](docs/session-notes.md)）。

## 面板入口

```
① 快捷入口：侧栏底部「功能坞」按钮（与设置按钮同底对齐）→ 弹出功能面板（首页总揽 + 模块导航 + 内容区）
② 完整面板：设置（侧栏底部）→ 功能坞
```

入口按钮与功能弹层挂载在 shell 的 `sidebar.footer.action` / `shell.overlay` 座位；
按钮状态为浏览器内存态；弹层与完整面板共用同一份 `/dsh-dock/balance` 数据（模块级共享快照，首页总揽概要与余额视图同源）与各功能视图。

## 目录结构

```
dsh-dock/
├── index.js          # Host 半部：功能注册表 + 每功能生命周期（setup/dispose）+ 错误隔离 + 模型余额拉取（/dsh-dock/balance）
├── client.js         # Client 半部：功能坞面板（settings.section）+ 侧栏入口按钮（sidebar.footer.action）+ 功能弹层（shell.overlay，模块导航 + 内容）+ 各功能视图，浏览器 bundle，无需构建器
├── cordis.patch.yml  # 组合层：insert 一行 dsh-dock
├── package.json      # 双面程序包清单（dsh.bundle.patch + dsh.client）
├── scripts/publish.sh # 一键发布（登录检查 + 预览 + publish）
└── docs/session-notes.md # 会话总结与决策记录（新会话续作前先读）
```

## 路线图（后面要干嘛）

| 版本 | 内容 | 状态 |
| --- | --- | --- |
| **0.2.0** | 接入**模型余额**：拉取所有模型 Provider 账户余额并展示（含配额/控制台跳转，策略表覆盖 DeepSeek/StepFun/Kimi/OpenRouter/MiniMax/xAI）；侧栏「功能坞」入口按钮 + 功能弹层（模块导航列表 + 内容区） | ✅ 已接入（v0.2.0 代码，待发布） |
| **0.3.0** | 接入 **Token 用量记录**：记录全部 LLM API 调用，支持时间范围/维度筛选与统计 | `hostSetups.tokenlog` 监听事件记账；面板加统计视图 |
| **0.4.0** | 接入**任务动画**：任务进度动画、完成/卡住通知 | 纯 Client 功能模块；如需挂对话区，在模块内注册对应 slot（如 `conversation.composer.dock`） |
| **0.5.0** | 开关状态**持久化**、Host↔Client 双侧注册表打通 | 状态写入持久化服务；Host 侧开关与 Client 面板同步；可选依赖注册（面板不在，功能照跑） |

后续新增功能遵循同一模式：**注册表加一条 + 视图加一个**，即插即用。

## 新增一个功能（三步）

1. `client.js` 的 `FEATURES` 加一条 `{ id, name, description, defaultEnabled }`；
2. `featureViews` 加同名组件（`react.createElement` 写法，可用 `ctx.get(...)` 取 Client 服务）；
3. 需要 Host 侧逻辑的，在 `index.js` 的 `hostSetups` 加一个返回 disposer 的函数。

需要从 Host 拿数据的功能（如模型余额）：Host 在 `hostSetups.<id>` 里用 `webServer.register`
注册一条同源路由（纯 JSON），Client 视图 `fetch('/dsh-dock/<id>')` 拉取——密钥只进 Host，
绝不下发浏览器。详见 [docs/session-notes.md](docs/session-notes.md) 8.3。

## 安装

开发期（link 模式）：

```sh
dsh plugin --profile web add dsh-dock   # npm 版安装
# 或本地路径：dsh plugin --profile web add /path/to/dsh-dock
```

查看/卸载：

```sh
dsh web --dump-config                    # 查看合成层（含 dsh-dock）
dsh plugin --profile web remove dsh-dock # 卸载
```

### 从 feature-hub 迁移

本包是 feature-hub 原型的正式发布版，面板与功能几乎一致：

```sh
dsh plugin --profile web remove dsh-feature-hub
dsh plugin --profile web add dsh-dock
```

（两个插件共存亦可，只是面板重复；建议迁移后移除旧版。）

## 开发与发布

- **开发提交**：Gitea 开发仓库（本仓库）
  `ssh://git@172.18.99.124:9022/wycto/dsh-dock.git`
- **发版**：GitHub 仓库（`github.com/wycto/dsh-dock`，待建）打 tag 发 Release
- **npm 发布**（无作用域名先到先得，已占用后归本账号所有）：

```sh
cd dsh-dock
npm login          # 首次：登录你的 npm 账号（wycto）
scripts/publish.sh # 预览 → 登录检查 → 发布
```

> 若发布时报 `EPERM`（npm 缓存目录里有 root 属主文件的历史 bug）：
> 修复一次 `sudo chown -R 501:20 ~/.npm`，或临时绕过
> `CACHE_DIR=/tmp/dsh-dock-npm-cache ./scripts/publish.sh`。

> 注：`package.json` 中 repository 指向 GitHub（发版仓库），Gitea 建好后
> 建议把两个地址都确认一遍。

## License

MIT