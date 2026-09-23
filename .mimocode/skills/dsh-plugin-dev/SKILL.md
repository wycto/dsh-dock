---
name: dsh-plugin-dev
description: DeepSeek Harness / dsh 插件开发与宿主版本兼容自查。新增功能、改配置/持久化、改打包安装、对接 settings/webServer/llm 等宿主 API 前必须先读本 skill；覆盖官方 develop 文档入口、SettingsForms 换代事实（Config 导出 + volatile + ns=条目 id）、本仓库约定与提交前检查。
---

# dsh 插件开发与兼容自查

> 本 skill 管「**怎么改**」的规则与已踩过的宿主换代坑。官方文档入口与本机安装格局见
> `docs/dsh-compat.md`（事实快照）；两者独立，动手前先查本 skill。

## 一、动手前必查官方文档

**唯一权威入口：** <https://deepseek-harness.github.io/deepseek-harness/develop/basic/>

| 改动类型 | 先读章节 |
|---|---|
| 新插件 / 生命周期 / inject | 「第一个插件」+ `/develop/framework/` 插件与生命周期、服务与依赖 |
| 新 Tool | 「开发一个 Tool」 |
| **配置字段、schema、面板保存** | **「插件配置」**（Export Config、cordis.yml config、volatile） |
| 打包 / `dsh plugin add` / profile | 「打包与安装插件」 |
| 事件订阅 | `/develop/framework/events` |
| 活编辑表单 | 还要读 `/docs/cookbook/adding-a-settings-card` 与 Cordis tutorial `05-config` 的 volatile 节 |

文档是静态站，WebFetch 全文读，不要只摘片段。**README/skill 里的命令是本机实测快照，不是长期承诺。**

本机源码 checkout（对照实现、查报错字符串）：`E:\dev_env\deepseek-harness`  
安装版 settings 实现：`packages/settings/settings/src/index.ts`（错误 `No configurable plugin entry` 出自 `write()`）。

## 二、宿主接口换代事实（≥ 0.1.7-alpha.1）

### SettingsForms（2026-09 实测）

| 旧（≤ 0.1.5-rc.x） | 新（≥ 0.1.7-alpha.1） |
|---|---|
| `ctx.settings.register(ns, schema, { base })` | **已移除**。继续调用 → `apply` TypeError → 整条 entry 不激活 |
| `settings.get(ns)` | **已移除**。读自己的 Config：`apply(ctx, config)` + `.get()`；或 `settings.describe()` |
| `settings.mutate(ns, ops, revision)` | **仍在**，但：① 插件必须 **`export const Config`**；② `ns` = **profile 条目 id**（cordis.patch.yml 的 `id`，不是随意命名空间）；③ 路径必须落在 **`.volatile()`** 字段上 |
| 插件自选 ns（如 `dsh-dock`） | 条目 id 必须与 mutate 的 ns 一致（本仓库 patch：`id: dsh-dock`） |

**本仓库适配（v0.11.x 起）：**

- `index.js`：`export const Config = DockConfig`；`apply(ctx, config)` 里 `bindDockConfig(config)` + `ctx.on('loader/volatile-update', …)` 重绑。
- `src/host-core.js`：`DockConfig` 各顶层段 `.volatile()`；统一 **`readDockRoot` / `mutateDockSection`**（禁止再直接 `settings.get(DOCK_NS)`）。
- 官方 ns（如 `llm-pi-ai`）读：`settings.describe({ redactSecrets: true }).find(d => d.ns === …)`。
- 旧 `settings.yaml` 功能开关：`migrateImportedFeatures` 从 `settings.yaml.imported` 补写。

### 报错速查

| 日志/面板 | 含义 | 先查 |
|---|---|---|
| `No configurable plugin entry "dsh-dock"` | 未导出 Config，或 patch `id` 与 ns 不一致 | `export const Config`、`cordis.patch.yml` 的 `id` |
| `Config field … is not volatile` | mutate 路径不在 volatile 字段上 | schema 顶层段是否 `.volatile()` |
| `ctx.settings.register is not a function` | 仍在调旧 API | 删掉 register，改 Config 导出 |
| `1 entry did not activate` | apply 阶段 TypeError（常见即 register） | 启动日志第一条 error |
| 路由全 404 /「读取状态失败」 | entry 未激活，外观像没装插件 | 对照上表，勿当网络问题 |

### 其它易换代点（改前对照源码）

- **Session 事件**：`session.events` 取值器 → `ownEvents()` / `snapshotEvents()`（0.1.2+，硬切换）。
- **`@deepseek-ai/*` 依赖**：`dependencies` **禁止写版本号**（会装副本 → cordis Service 类身份分裂 → 路由 404）。只放第三方包；`@deepseek-ai/*` 走 `peerDependencies: "*"` + `scripts/dev-link-deps.mjs` 链到宿主闭包。
- **profile link 路径**：`~/.dsh/profiles/web/package.json` 的 `dsh-dock: link:…` 必须指向真实仓库路径；junction 断了插件就加载旧代码或加载失败。

## 三、本仓库开发约定（细节以 `docs/workflow.md` 为准）

1. 开发期不改 `version` / `DOCK_VERSION`（只在明确说「发版」时改）。
2. 改动范围 → 跑对应测试：
   - 客户端：`npm run build:client` → `npm run test:client`
   - 宿主：`npm run test:host`
   - 两者都改：三条都跑
3. 配置读写一律走 `readDockRoot` / `mutateDockSection`，不要绕开 host-core。
4. 新功能模块：`features/<id>/{host.js,view.js(x)}`，默认 `defaultEnabled: false`。
5. 首次在本机开发：`node scripts/dev-link-deps.mjs`（缺 `.devdeps` 先 `cd .devdeps && pnpm install`）。

## 四、提交前自查

- [ ] 是否用到 `settings.register` / `settings.get`？（新宿主非法）
- [ ] 若用 `mutate`：是否 `export Config`？ns 是否等于 patch `id`？路径是否 volatile？
- [ ] 是否新增了带版本的 `@deepseek-ai/*` 依赖？
- [ ] 行为变了，README / CHANGELOG / session-notes / 面板文案是否同步？
- [ ] 对应范围的 `test:host` / `test:client` 是否全绿？
- [ ] **失败外观能否与「本来就没配」区分？** 不能区分 = 静默失效，必须改。

## 五、已知坑（别重复踩）

1. **宿主公开 API 会整代换掉**；换代当天改不完 → 插件静默失效（entry 不激活），不是单功能降级。
2. **profile link 指错路径** → Junction 断链，跑的可能是 npm 旧包或根本没加载。
3. **marker 断言**要用「只有真实渲染才出现」的字符串，功能名会把降级提示也断言成通过。
4. **读路径不许有副作用**（备份/写盘/网络）；高频轮询会放大。
5. **新字段四段贯通**：schema → resolve/默认值 → 传输 → 消费端；只改 schema = 静默丢字段。
