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

本机源码：`E:\dev_env\deepseek-harness`（与安装版对照用）。

## 二、Settings 服务代际（2026-09-22/23 实测）

安装闭包：`C:\Users\wzy60\.dsh\profiles\node_modules\@deepseek-ai\dsh-settings`  
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

## 五、依赖规则

- `package.json` 的 `dependencies` **不出现**任何 `@deepseek-ai/*` 版本号
- `peerDependencies` 声明 `@deepseek-ai/*: "*"`（宿主提供）
- 第三方仅：`js-yaml`、`qrcode` 等
