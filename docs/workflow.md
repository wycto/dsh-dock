# dsh-dock 开发与发版流程

本文件是 dsh-dock 插件开发流程与发版流程的唯一真源。人读它，agent 也读它。
（配套的 agent 预设 `dsh-dock` 只承载硬规则摘要，细节一律以本文件为准。）

## 1. 仓库与远端

| 远端 | 地址 | 用途 |
|---|---|---|
| `origin` | `ssh://git@172.18.99.124:9022/wycto/dsh-dock.git`（自建 Gitea） | **开发库**：日常提交只推这里 |
| `github` | `git@github.com:wycto/dsh-dock.git` | **发版库**：只在发版时同步（每次一条发版提交）+ 打 tag，npm 也以它为主页 |

- 开发阶段**绝不推 `github`**；它只反映已发布的版本。
- **github 不收分批的开发提交**：每次发版把自上次发版以来的代码**压成一条**「发版」提交
  （主标题写发版，正文汇总本版功能内容）推上去（见第 3 节第 8 步）；**既有历史原样保留，
  不重写不删**——历史记录必须一直可见。
- 本地 `release` 分支跟踪 `github/main`，只随发版脚本前移，**不要推 `origin`**。
- 发版后两个远端的**代码内容**一致（树相同），提交历史不同：origin 是完整开发史；
  github 在新规起点（v0.10.0）之前的完整历史保留，之后每次发版只多一条发版提交。

## 2. 开发阶段（默认状态）

1. **不改 `package.json` 的 `version`**。版本号只在用户明确说「发版」时才动（见第 3 节）。
   同理不改 `src/client.jsx` 的 `DOCK_VERSION`——两者必须始终一致。
2. **提交备注不写「发版」**。用类型前缀开头，一行说清做了什么，正文写清需求 / 根因 / 改法 / 验证：
   - `功能：…`（新功能、新模块）
   - `修复：…`（缺陷修复）
   - `文档：…` / `杂项：…`（文档、脚本、仓库杂务）
   - 反例：`发版 v0.10.0：…`——这是发版提交的写法，开发阶段不要用。
3. **只推 `origin`**。推之前先跑测试（见下），推完确认 `git status` 干净。
4. **`CHANGELOG.md` 记在「未发布」段**：开发期的变更写在顶部 `## 未发布（下一版）— 开发中`
   段落里，发版时整段改名为 `## vX.Y.Z — YYYY-MM-DD`。
5. **代码注释不写未定版本号**。说「本次拆分」「通知拆分后」这类描述，不要写「v0.10.0 起…」——
   版本号没定，写死会在发版改号时全变成错的。
6. **文档同步**（每次改动都要看一遍）：
   - `README.md`：功能一览表 + 该功能的使用说明（注意该文件里「界面/安装/使用方法」整段存在重复副本，
     两处都要改）；
   - `CHANGELOG.md`：未发布段；
   - `docs/session-notes.md`：追加一节（日期 · 标题 · 现象/根因/改法/验证/部署）。

### 每次改动必须跑的检查

| 改动范围 | 必须做 |
|---|---|
| 客户端（`features/*/view.jsx`、`src/client.jsx`、`src/shared.js`） | `npm run build:client` → `npm run test:client` |
| 宿主（`index.js`、`src/host-core.js`、`src/task-track.js`、`features/*/host.js`） | `npm run test:host` |
| 两者都改 | 三条都跑 |
| 新增/改动功能模块 | 上面三条 + 在 `scripts/test-client-views.mjs` 的 `FEATURES` 里补一行断言 |

- `client.js` 是**构建产物**（提交进仓库、随包发布），改完客户端源码必须重建，不要手改产物。
- 宿主半部的改动要**重启 `dsh web`** 才生效；纯客户端改动刷新页面即可。

### 线上自检（宿主改动后）

```powershell
Invoke-WebRequest http://127.0.0.1:3080/dsh-dock/features -UseBasicParsing            # 各功能 enabled/error
Invoke-WebRequest http://127.0.0.1:3080/dsh-dock/<feature>/status -Method POST `
  -ContentType 'application/json' -Body '{}' -UseBasicParsing                        # 该功能路由是否活着
```

## 3. 发版流程（仅当用户明确说「发版」）

0. **等用户发话**。没发话就不进入本节任何一步。
1. **定版本号**：用户指定优先；没指定就按语义化提议一个并等确认。
2. **改版本号（两处，必须一致）**：`package.json` 的 `version`、`src/client.jsx` 的 `DOCK_VERSION`。
3. **`CHANGELOG.md`**：把 `## 未发布（下一版）— 开发中` 改成 `## vX.Y.Z — YYYY-MM-DD`。
4. **重建产物**：`npm run build:client`（版本号会进 `client.js`）。
5. **全量测试**：`npm run test:client` + `npm run test:host` 全绿，无跳过。
6. **复查文档**：README 里版本相关描述、`package.json` 的 description、功能一览表。
7. **提交并推 `origin`**：备注写 `发版 vX.Y.Z：<一句话要点>`，正文列本版变更（从 CHANGELOG
   未发布段提炼），保存成 message 文件（如 `.git/RELEASE_MSG.txt`）——第 8 步还要用；
   `git push origin main`（开发库收全部提交：开发提交 + 这条发版提交）。
8. **同步 `github`（一条提交，不分批）**：发版库不收开发提交——
   `./scripts/push-github-release.sh <message-file>` 把 main 的**整棵树**压成一条
   「发版 vX.Y.Z」提交推到 `github/main`：父提交是上一次发版提交，正文汇总本版功能内容
   （可直接复用第 7 步的 message 文件）。本地 `release` 分支随之前移 = `github/main`。
   正常发版是快进推送，不需要 force。
9. **打 tag 并推送**（tag 指向开发库的发版提交；在 github 上它不在 main 线上，但树一致）：
   ```bash
   git tag -a vX.Y.Z -m "dsh-dock vX.Y.Z"
   git push origin vX.Y.Z
   git push github vX.Y.Z
   ```
10. **发布 npm**：`./scripts/publish.sh`（先 `npm pack --dry-run` 预览、检查登录态，再 `npm publish`）。
    本机 `bash` 会解析到 WSL，请用 Git Bash：`& "D:\Program Files\Git\bin\bash.exe" ./scripts/publish.sh`。
    若遇到 npm 缓存目录属主导致的 `EPERM`：`CACHE_DIR=/tmp/dsh-dock-npm-cache ./scripts/publish.sh`。
11. **确认**：npm 页面版本、GitHub Release（可选）、本地 `git status` 干净。
12. 发版后**不要**顺手改版本号回开发态——下一次开发提交按第 2 节走，直到下次发版。

## 4. 模块架构约定（改代码前先看）

```
features/<id>/
  host.js     宿主半部：RPC 路由（/dsh-dock/<id>/）、settings 读写、事件订阅（纯 ESM，零构建）
  view.js(x)  客户端视图：描述符 + View/HomeStat/Chip/Overlay（自带 css，类名带模块前缀）
```

- 功能描述符字段：`id / name / order / accent / description / defaultEnabled / css / View / HomeStat? / Chip? / Overlay?`。
- **新功能默认 `defaultEnabled: false`**（v0.9.5 起的约定：默认全关、按需开启）。
- 宿主共享内核：`src/host-core.js`（settings schema、常量、`sendJson`/`readBody`）、`src/task-track.js`
  （会话级任务追踪，引用计数共享）；客户端共享：`src/shared.js`（功能开关状态、导航总线、错误边界）。
- 配置统一存在 settings 命名空间 `dsh-dock` 下，**每个功能一个段**；功能启停由
  `features.<id>` 布尔表控制，客户端开关通过 `POST /dsh-dock/features` 同步到宿主。
- 宿主路由前缀 `/dsh-dock/<featureId>/<method>`，统一 `{ ok, data }` / `{ ok, error }` 响应体。
- 独立发布：`node scripts/extract-feature.mjs <featureId>` 生成可单独发布的包骨架（会一并复制
  `src/host-core.js`、`src/task-track.js`）。

## 5. 环境备忘（本机踩过的坑）

- **esbuild**：`npx esbuild` 在本机找不到包（构建脚本里的 `--cache /tmp/npm-cache` 在 Windows 下无效）。
  把 `C:\Users\wzy60\AppData\Local\npm-cache\_npx\beb367dfa21eb3f5\node_modules\.bin` 前置到 PATH
  再跑 `node scripts/build-client.mjs`。
- **git 推送**：沙箱下 MSYS `ssh.exe` 会因 `CreateFileMapping … Win32 error 5` 起不来，
  推送需要放宽一次文件沙箱权限。
- **Git Bash**：`bash` 在本机会解析到 WSL（CRLF 脚本报 `set: -e: invalid option` 一类错），
  跑 `scripts/*.sh` 请用 `"D:\Program Files\Git\bin\bash.exe"`。
- **`dsh web` 重启**：宿主半部改动（新路由、schema、迁移）必须重启才生效；重启后浏览器刷新即可。
- **外链 watch 进程**：本机可能有外部进程在源文件变更后自动重建 `client.js`；以最新产物为准。
- **settings 文件**：`C:\Users\wzy60\.dsh\settings.yaml` 的 `dsh-dock:` 段；改坏了可对照
  `src/host-core.js` 的 `DockConfig` 恢复。

## 6. 配套 agent 预设（`dsh-dock`）

开发本插件时用 agent 预设 **`dsh-dock 插件开发`**（id `dsh-dock`），它把这套流程带进会话：

| 位置 | 内容 |
|---|---|
| `C:\Users\wzy60\.dsh\.agent-presets\dsh-dock\agent.cordis.yml` | `standard` 预设的副本；差别只有 persona 里那段 dsh-dock 开发/发版铁律 |
| `…\dsh-dock\preset.yml` | 显示名与描述 |
| `…\dsh-dock\skills\dsh-dock-release\SKILL.md` | 发版清单技能（会话内可加载，细节指向本文件） |

维护约定：

- 预设目录在 `DSH_HOME` 下，**不随仓库走**；换机/重装后按上表重建（`agentPresets.copy('standard', 'dsh-dock', 'dsh-dock 插件开发')` 再补 persona 与技能）。
- **不要改部署自带的预设**（`standard`/`ptc`/`minimal`/`cordis` 所在目录，升级会被覆盖）；
  要改就复制一份再改。
- ⚠️ **dsh 升级后必须把本预设与新版 `standard` 重新对齐**。预设是 `standard` 的副本，而 dsh 会改
  预设 schema；不对齐的后果很重——预设挂载失败会让**所有绑定该预设的会话无法 resume**
  （`agent-presets: preset "dsh-dock" failed to mount`），表现为切模型 / 打开历史会话卡住并弹
  「模型操作失败」。
- 改了预设后要重新校验能否挂载（`agentPresets.standingKeyFor('dsh-dock')`），再开一个新会话确认工具与提示词。

### 升级核对（dsh 换版本后必做）

把本预设与新版 shipped `standard` 做**结构化对比**（忽略注释与空行），只允许 persona 正文一处差异：

```bash
S="<dsh 安装目录>/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml"
diff <(grep -v '^\s*#' "$S" | grep -v '^\s*$') \
     <(grep -v '^\s*#' "$HOME/.dsh/.agent-presets/dsh-dock/agent.cordis.yml" | grep -v '^\s*$')
```

已知在 **dsh 0.1.5-rc.1** 上踩过的两处 schema 漂移：

| 行 | 旧（0.1.4 及更早） | 新（0.1.5-rc.1） |
|---|---|---|
| `persona` 配置 | `config.text: \|` 整段（自带 `{{model}}`/`{{cwd}}`） | **`config.prefix`（必填）+ `config.suffix`**；`text` 字段已删除，缺 `prefix` 直接报 `$.prefix missing required value` |
| 末尾新增行 | — | `- id: present` / `name: '@deepseek-ai/dsh-tool-present'`（每版可能新增，照抄 `standard`） |

对齐后**必须真机验证挂载**——只查 roster 不够：`agentPresets/list` 只校验 YAML 形状，**不校验
config schema**，真正会失败的是 mount：

```bash
# 用 dsh-dock 预设建一个会话；成功即说明能挂载
# （$COOKIE 为自签的 dsh-auth Cookie，做法见下方说明）
curl -sS -X POST -H 'content-type: application/json' -H "Cookie: $COOKIE" \
  --data-binary '{"type":"client-request","rpcId":"c1","method":"session/create","payload":{"args":{"request":{"cwd":"<任一目录>","agentPreset":"dsh-dock"}}}}' \
  http://127.0.0.1:3080/api/session/create
```

本机 `/api` 需要 `dsh-auth-*` Cookie：用 `~/.dsh/.credentials.yaml` 里
`client-connection/browser-session` 的 secret，按 `dsh-client-connection` 的算法现签一张
（name = `dsh-auth-` + base64url(sha256(authority))，value = `v1.<base64url(payload)>.<hmac>`）。
做法与示例见 `docs/session-notes.md` 2026-09-10 一节；或直接用浏览器开页面、在 DevTools 里拷
`document.cookie` 以外的 Cookie（`HttpOnly` 需从 Application 面板读）。

