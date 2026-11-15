# DSH 插件文档入口与兼容实测（事实）

> 2026-09-23 快照。规则见 `.mimocode/skills/dsh-plugin-dev/SKILL.md`；本文只记事实。

## 一、官方文档

| 内容 | URL |
|---|---|
| 开发总入口（第一个插件 / Tool / 插件配置 / 打包安装） | https://deepseek-harness.github.io/deepseek-harness/develop/basic/ |
| 插件配置（Config schema、cordis.yml） | https://deepseek-harness.github.io/deepseek-harness/develop/basic/config |
| 打包与安装（dsh.bundle / profile / plugin add） | https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish |
| 框架：生命周期 / 服务 / 事件 | https://deepseek-harness.github.io/deepseek-harness/develop/framework/ |
| 即时配置表单 cookbook | 仓库内 docs/cookbook/adding-a-settings-card.zh.md |
| Cordis tutorial §配置 / volatile | docs/cordis-tutorial/05-config.zh.md |

本机源码：`<你的工作区>\deepseek-harness`（与安装版对照用）。

## 二、Settings 服务代际（2026-09-22/23 实测）

安装闭包：`<用户主目录>\.dsh\profiles\node_modules\@deepseek-ai\dsh-settings`  
版本：`0.1.7-alpha.1`  
报错源：`src/index.ts` → `write()` → `No configurable plugin entry "${ns}"`

| 代际 | 接口 |
|---|---|
| 旧 ≤0.1.5-rc.x | `register` / `get` / `mutate`；插件自选 ns |
| 新 ≥0.1.7-alpha.1 | **无 register/get**。`describe` / `update` / `replace` / `mutate` / `configure`；ns=profile 条目 id；活编辑要求 `.volatile()` |

dsh-dock 对接：`export const Config = DockConfig`；读 `readDockRoot`；写 `mutateDockSection`。

## 三、本机安装格局

- Profile：`~/.dsh/profiles/web`（bundles 含 dsh-dock / dsh-memory / dsh-evolution）
- dsh-dock 应 link 到：`F:/workspace/gitea/wycto/dsh-dock`（2026-09-23 曾误为 `F:/workspace/wycto/gitea/dsh-dock` 断链，已修）
- 依赖闭包：`~/.dsh/profiles/node_modules/@deepseek-ai`；仓库内 `node_modules/@deepseek-ai` 由 `scripts/dev-link-deps.mjs` 链过去
- `@deepseek-ai/dsh-credentials` 未提升到顶层时，嵌在 `dsh-credentials-local/node_modules/@deepseek-ai/` 下（已补顶层 junction）
- 旧配置：`~/.dsh/settings.yaml.imported`（宿主启动时改名导入；dsh-dock 在无 Config 时那段会导入失败，由 `migrateImportedFeatures` 补）

## 四、Session 事件接口（dsh-memory 同源实测，勿假设兼容）

| 宿主 | 接口 |
|---|---|
| ≤0.1.1 | `session.events` 取值器 |
| ≥0.1.2 | `ownEvents()` + `snapshotEvents()`；**硬切换** |

## 五、插件路由准入代际（2026-11-14 实测）

| 宿主 | 命名路由（`webServer.register`）的准入 |
|---|---|
| ≤ 0.2.2-rc.1 | 载体**不鉴权**；插件自己问 `connection.requestRejection(req)`，返回值即状态码（401 无会话 / 403 来源不可信，`undefined` 放行） |
| ≥ 0.2.2-rc.2 | 路由项新增 `auth: 'anonymous' \\| 'required' \\| 'deny'`（**默认 required**）；载体在派发前做完 Host/Origin + 认证，handler 收 `(req, res, peer?)`、upgrade 收 `(req, socket, head, peer?)`、resource 收 `(request, peer?)`；被拒时**根本不进 handler**（401/403/503 由载体回） |

同版本 Connection 还删了：`BrowserAuth`、`authorizeIndex`、`authenticatedUrl`、
`ConnectionRequestRejection`、`peer(id)`、`createPeer.socketOwned`、`ConnectionAdmission`、
`admitConnection`。新增 `connection.admit(request) → PeerAdmission`（自行准入时用；**已准入的
路由 handler 不要再调一次**，那会另起一个 Peer）。`createPeer` 与 `browserPeer` 保留。

默认令牌登录与 HTTP 交换迁到 `@deepseek-ai/dsh-host-authentication-token`：`cookieMaxAgeDays`
从 `connection.config` 移到 `authentication-token.config`（旧位置**不生效也不报错**）；带令牌
的入口地址由该插件贡献到 `webserver/entry-url`，由 WebApp 在 loader ready 后 emit **一次**，
且只在 `printUrl` 或需要交接浏览器时 emit——**不能当可靠的令牌来源**，只能当缓存。

踩过的坑（2026-11-14，用户截图：功能坞「用量·失败 / 余额 失败」）：宿主升到 rc.3 后，
dsh-dock 的 `rejectUntrustedRequest` 因取不到 `connection.requestRejection` 走 fail-closed，
13 处 `/dsh-dock/*` 路由全数 401（用量面板显示插件自己的 401 JSON，余额面板显示
「余额接口 HTTP 401」）。修法是栅栏改成 `peer` → `requestRejection` → fail-closed 三段，
注册处显式写 `auth: 'required'` 并透传 handler 第三参。

## 六、依赖闭包与 `@deepseek-ai/*` 版本（2026-11-14 实测）

- 仓库内 `node_modules/@deepseek-ai` 由 `scripts/dev-link-deps.mjs` 链到
  `~/.dsh/profiles/node_modules/@deepseek-ai`（安装闭包）。
- 该闭包可能**远旧于**正在开发的宿主 checkout：本机闭包是 `schemastery 3.18.2`（无
  `.volatile()`），宿主 checkout 是 `vendor/schemastery 3.19.0`。直接 `npm run test:host` 会在
  `import DockConfig` 处炸 `TypeError: z.dict(...).default(...).volatile is not a function`，
  与改动无关，别误判成自己写坏了。
- 本次验证做法：把仓库拷到临时目录，令其 `node_modules/@deepseek-ai` 指向**与运行宿主同源**的
  checkout 包（`vendor/schemastery`、`packages/credentials/credentials`、`packages/llm/llm`），
  `js-yaml`/`qrcode`/`esbuild` 仍链本仓 `.devdeps/node_modules`，然后 `npm run test:host`。

## 七、依赖规则

- `package.json` 的 `dependencies` **不出现**任何 `@deepseek-ai/*` 版本号
- `peerDependencies` 声明 `@deepseek-ai/*: "*"`（宿主提供）
- 第三方仅：`js-yaml`、`qrcode` 等
