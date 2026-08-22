# 会话总结与决策记录（2026-08-21）

> 给后续 DSH 会话的交接文档：新会话继续完善本项目前，先读本文件 + README。
> **2026-08-22 更新**：0.2.0 模型余额已接入，见文末「八、续作会话（2026-08-22）」；
> 其中 8.7 记录了「CSS 全局名冲突致 dsh 启动崩溃」事故与修复，改 client 半部前必读。

## 一、本项目是什么

`dsh-dock`（中文名：**功能坞**）—— DeepSeek Harness 功能坞插件。一张管理面板统一注册、开关所有小功能（模型余额、Token 用量记录、任务动画，以及未来任意新功能）。已发布 npm：**dsh-dock@0.1.0**（maintainer: wycto），0.2.0（模型余额 + 侧栏入口按钮 + 功能弹层）代码完成待发布。

## 二、本会话做了什么

1. **架构咨询结论**：个人工具集用"单中枢 + 注册表 + 独立功能模块"（即当前实现），而非拆成互不相识的多个插件；只有信任级别不同或需要独立生命周期的功能才拆单独包。三个既有功能包（`@wycto/dsh-balance-panel` / `dsh-token-usage` / `dsh-task-pulse`）后续按路线图吸收或注册进中枢。
2. **命名决策**：无作用域名 `dsh-dock`（初选 `dsh-hub` 已被他人占位；作用域备选 `@wycto/dsh-hub` 保留）。2026-08-21 已发布 npm 占用（0.1.0，latest）。
3. **基础框架落地**：继承本地已安装原型 `feature-hub`（静态 bundle 路线），正式化为可发布 npm 包。
4. **本项目初始化**：本仓库从 `/Users/weiyi/develop/test/dsh-dock`（发布源，2 commit）复制代码并整理 README + 本文档。

## 三、关键决策与原因（不要推翻）

| 决策 | 原因 |
|---|---|
| 静态 bundle 路线（`cordis.patch.yml` + `dsh.bundle.patch` + `exports["./client"]`） | 本部署的模型网关会把对象类型工具参数序列化为字符串，`cordis_define` 动态插件路径被阻塞；静态包才是一致、常驻、长期使用的形态 |
| Client half 手写 lazy-CJS 工厂（`window.__ModuleLoader__.load`） | 无需构建器，改完直接生效（profile 里是 link 依赖，重启 `dsh web` 即加载新代码） |
| 每功能 = 注册表一条 + 视图一个 + 独立开关（内存态） | 与 feature-hub 原型一致；个人工具集足够，拒绝过度设计 |
| Host↔Client 数据通道用 webServer 回环路由 + 同源 fetch，不走 typert | 见 8.3：`@wycto/dsh-balance-panel@0.1.1` 同部署实测可用，无需 typert/connection RPC |
| 余额策略表吸收 `dsh-balance-panel` 实现（外人视角即"复用"，非重写） | 同作者 MIT 代码，官方计费接口，已被生产验证；避免重复造轮子 |
| npm 包名 `dsh-dock`（无作用域） | 用户拍板；已发布即占用，勿改 |

## 四、当前状态快照（2026-08-22 更新）

- npm：`dsh-dock@0.1.0` latest（待 0.2.0 发布后 latest 更新）
- 代码：0.2.0 模型余额已接入并本地验证通过（本仓库 `main`，待发布）
- 运行环境：web profile 已换为 `dsh-dock`（link 本仓库，隔离实例验证 ✅）；线上 `dsh web`（端口 3080）仍是旧组合，用户重启后生效（重启会中断会话）
- 代码源：本仓库（gitea `main`）+ 发布源副本 `/Users/weiyi/develop/test/dsh-dock`
- 发布脚本：`scripts/publish.sh`（含登录检查、--cache 绕坑）

## 五、下一步（按顺序）

> 2026-08-22 更新：前两项已完成，最新清单见「八、续作会话」8.5。

1. ✅ **本地替换验证**（profile 已替换并在隔离实例验证通过；用户重启 `dsh web` 即生效）。
2. ✅ **0.2.0 模型余额**（2026-08-22 完成代码 + 本地验证，待发布）。
3. **0.3.0 Token 用量**：`hostSetups.tokenlog` 监听事件记账 + 统计视图。
4. **0.4.0 任务动画**：纯 Client 模块，可注册对话区 slot。
5. **0.5.0 持久化**：开关状态落盘。
6. **GitHub 发版**：建 `wycto/dsh-dock`（GitHub）→ `package.json` repository 改实际地址 → 发布 → tag 发 Release。

## 六、环境备忘（踩过的坑）

- **npm 缓存 EPERM**：`~/.npm` 有 root 属主历史文件。绕过：`CACHE_DIR=/tmp/dsh-dock-npm-cache ./scripts/publish.sh`；根治：`sudo chown -R 501:20 ~/.npm`。
- **registry 读取一致延迟**：`npm publish` 成功后立刻 curl 可能 404，等几秒重试即 200，非失败。
- **沙箱**：gitea 目录在会话工作区外，本会话已由用户开放全权限写入。
- **git 身份**：本仓库需设置 `user.name`/`user.email`（本机无全局身份），用 wycto。
- ~~**typert 联通**~~（已推翻，见 8.3）：静态 bundle 下 Client↔Host 的私有 RPC 原假设走 typert 服务；实测采用 webServer 回环路由 + 同源 fetch 即可。

## 七、命名与生态备忘

- 现有功能包家族：`@wycto/dsh-balance-panel`、`@wycto/dsh-token-usage`、`@wycto/dsh-task-pulse`
- 面板包：`dsh-dock`；后续新功能包建议 `@wycto/dsh-<功能名>` 或吸收为 dock 内模块
- `dsh-hub` 无作用域名已被他人占位（0.0.1），勿用

## 八、续作会话（2026-08-22）

### 8.1 本会话做了什么

1. **0.2.0 模型余额接入完成**（代码 + README + 本文档；发布与本地安装另行确认）：
   - `index.js`：新增 `hostSetups.balance`，在回环 webServer 注册 `GET /dsh-dock/balance` 路由；
     Provider 枚举（`llm.listConfigurableProviders` + `settings.describe(redactSecrets)` + `agentDefaultModel.currentSelection`）、
     余额策略表、凭证解析全部沿用 `@wycto/dsh-balance-panel@0.1.1`（MIT，同作者）——策略覆盖
     DeepSeek / StepFun / Kimi Coding / OpenRouter / MiniMax / xAI，另含 `qwen-token-plan-*` 等登录跳转与控制台链接。
   - **补上 `export const inject = ['webServer']`**（0.1.0 框架从未声明 inject；balance 是第一个真实 Host 功能，
     实测发现 apply 在 webServer 就绪前执行导致路由注册失败，补齐后与 `@wycto/dsh-balance-panel` 一致）。
   - `client.js`：balance 占位移除 `planned`，新增真实视图（`fetch('/dsh-dock/balance')`，5 分钟自动刷新 + 手动刷新，
     每 Provider 卡片带独立主题色、余额/配额/登录跳转/不支持等状态），开关默认启用。
   - `package.json`：版本 0.2.0，新增依赖 `@deepseek-ai/dsh-credentials@^0.1.0-rc.6`（与 web profile 已装版本一致）。
2. **环境验证**：Node v26（全局 fetch + AbortSignal.timeout 可用）；`webServer.register` 返回 disposer；
   `@deepseek-ai/dsh-credentials` 在 web profile node_modules 已就位（0.1.0-rc.6）。
3. **本地验证全绿**（详见 8.6）：
   - 冒烟测试：以真实部署配置桩驱动 `apply()`，Provider 分类正确；
   - Client SSR：以真实 react/react-dom 渲染整个面板（五个功能卡片 + 余额视图初始态 + 规划占位）全过；
   - **真实实例验证**：用 `DSH_HOME=/tmp/dsh-verify-home` 隔离起一个同组合 `dsh web`（端口 3999），
     `GET /dsh-dock/balance` 返回 200，分类正确（qwen-token-plan-cn→需登录带百炼链接、fangzhou/jiyuanlvdong→不支持、
     deepseek 系→未配置密钥不发网络请求）；`/dsh-balance-panel`（旧包）仍 200，两包并存无冲突。

### 8.2 未做（留给后续会话/用户）

- **重启线上实例看面板**：web profile 已替换为 `dsh-dock`（link 本仓库）并验证通过（8.6），
  但当前跑着的 `dsh web`（PID 66740，端口 3080）还是旧组合——**需用户手动重启 `dsh web` 才会加载 dsh-dock**；
  重启会中断当前 DSH 会话，故本会话没有动它。
- **npm 发布 0.2.0**：`npm publish` 需用户确认（wycto 账号），用 `CACHE_DIR=/tmp/dsh-dock-npm-cache ./scripts/publish.sh`。
  ⚠️ 发布前注意：`package.json` 的 `dependencies` 只在**非 link 安装**（npm 安装）时生效；
  本地 link 模式需要仓库内 shim（见 8.4/8.6），那是 gitignored 的，不随包发布。

### 8.3 重要决策更正：**Client↔Host 联通不走 typert，用 webServer 回环路由**

旧文档（第六节）假设"静态 bundle 下私有 RPC 走 typert"。实测并经 `@wycto/dsh-balance-panel@0.1.1`
（同部署已安装可用）验证：**Host 在回环 webServer 注册同源 HTTP 路由、Client 直接 `fetch` 即可**，
无需 typert、无需 connection RPC、任何回环部署都能工作。0.2.0 采纳该路线：

- 路由路径 `GET /dsh-dock/balance`（与余额面板包的 `/dsh-balance-panel` 错开，两包并存不冲突）；
- 数据是纯 JSON 归一化视图（generatedAt / default / providers[]），不是内部对象；
- 密钥只在 Host 进程内 `credentials.resolve(credentialRef(apiKeyEnv))` 取用，绝不下发浏览器。

### 8.4 环境备忘（延续）

- git 身份：本仓库仍需 wycto 的 user.name/user.email（本机无全局身份）。
- 本部署 settings（~/.dsh/settings.yaml）Provider 清单见 8.1 第 3 条；新增 Provider 只要 profile 配了
  `baseURL`/`apiKeyEnv` 就会被自动枚举。
- **link 模式依赖坑**：profile 里 `dsh-dock: link:本仓库`，Node 按真实路径解析 `@deepseek-ai/dsh-credentials`，
  仓库内必须有 `node_modules/@deepseek-ai/dsh-credentials`（-> symlink profile 已装版本，gitignored）。
  否则插件行 import 失败（boot 不报错但功能静默缺失）。npm 真实安装后不需要 shim。

### 8.5 下一步（按顺序）

0. **v0.2.0 追加（本次会话）**：中文名定为「功能坞」；新增侧栏入口按钮
   （`sidebar.footer.action` id `dsh-dock`，order 1，靠右端 = 设置旁） + 功能弹层（仿 dsh 设置：居中模态、左导航 + 右内容区）
   （`shell.overlay` id `dsh-dock-panel`，order 21）；
   CSS 由页内 `<style>` 改为 apply 时全局注入（`ensureCss`/`data-plugin-css="dsh-dock"`）。
   **首页总揽（2026-08-22 追加）**：导航首项「首页」为默认选中页，网格卡片总揽全部子功能
   （状态徽章 + 运行概要 + 快捷开关，点卡片跳对应功能页）；为此把余额数据提升为模块级共享快照
   `balanceStore`（首页概要与余额视图共用一份请求/5 分钟刷新），心跳改用模块级 `loadedAt` 运行时长基准。
   位置对齐：设置 button 在宽栏是满宽 42px 行（`margin:4px -2px`，行带 50px）、窄栏
   36px 居中（`margin:8px 0 10px`，行带 54px）→ 入口按钮用
   `transform: translateY(46px)`（宽）/`44px`（窄）+ `zIndex:1` 下移进设置行右端空白区，
   与设置按钮同底对齐（transform 不动布局、不遮齿轮图标）。
   注意：设置面板的 open/select 是 `ui-settings-general` 内部 useState，**无公开 API**——
   入口按钮只能打开自己的弹层，无法编程式打开设置页并选中 section（若未来需要，得给
   `ui-settings-general` 加服务或事件）。
   ⚠️ 2026-08-22 修复：弹层 JSX 链尾部缺一个右括号（`client.js` 曾处于语法非法状态，
   页面能跑是 HMR 缓存的旧有效版本）；已补齐并以 `node --check` + SSR 冒烟把关。
   状态：用户已重启 `dsh web`，静态版生效（动态预览随之清空）；重启后曾发生启动崩溃事故，
   根因与修复见 8.7。
1. 用户在页面确认：入口按钮与设置按钮同底对齐不再悬空；功能弹层默认打开「首页」总揽
   （卡片网格：状态/概要/快捷开关，点击进入模块页），下方菜单为各子功能；设置页「功能坞」面板有样式。
2. 确认后：`CACHE_DIR=/tmp/dsh-dock-npm-cache ./scripts/publish.sh` 发布 0.2.0 → 本仓库提交/推送。
3. **0.3.0 Token 用量记录**：`hostSetups.tokenlog` 监听 LLM API 事件记账 + 面板统计视图，参考 `@wycto/dsh-token-usage`。
4. **0.4.0 任务动画**：纯 Client 模块。
5. **0.5.0 持久化 + 双侧注册表打通**：开关状态落盘；Host 侧 `setEnabled` 现在只在 load 时按
   `defaultEnabled` 执行一次，届时接上 Client 面板开关同步（可把数据通道升级为同一路由体系下的
   POST 控制接口，或沿用 8.3 的 fetch 模式）。

### 8.6 本地验证怎么做（可复用）

1. **组合层**：`dsh web --dump-config` → 应看到 `# == dsh-dock / - id: dsh-dock` 行。
2. **Host 冒烟**：`/tmp/dock-smoke/smoke.mjs`（stub ctx + 真实部署配置形状）→ 路由输出分类断言全绿。
3. **Client SSR**：`/tmp/dock-smoke/client-ssr.mjs`（真实 react + react-dom 渲染整个面板）→ 五卡片全渲染。
4. **真实实例**（不碰线上）：`DSH_HOME=/tmp/dsh-verify-home` 拷贝 profile（node_modules 里
   `dsh-dock` 改回绝对链接指向本仓库）+ settings.yaml，起 `dsh web --port 3999`，
   curl `/dsh-dock/balance` 断言 200 与分类。⚠️ 别用真实 home 起第二实例，避免与线上进程争存储。

### 8.7 事故复盘：`CSS.join is not a function` 导致 dsh 整页启动崩溃（务必读）

- **现象**：重启 `dsh web` 后页面报 `Failed to load plugins / dsh-dock / failed to apply loader
  entry <rev> (dsh-dock): CSS.join is not a function`，整个 GUI 起不来。
- **根因**：bundle 的样式数组被命名为 `CSS`，与浏览器全局 `window.CSS`（命名空间对象，无 `.join`）
  同名。在浏览器执行环境里标识符解析歧义，`ensureCss()` 里的 `CSS.join("\n")` 实际调到了全局
  命名空间 → 插件 apply 抛错 → 该 entry 加载失败 → **整页启动失败**。
- **为什么本地验证没拦住**：SSR 冒烟里 `typeof document === "undefined"` 让 `ensureCss()`
  提前 return，`CSS.join` 那行根本没执行；`node --check` 只查语法。即：**只在浏览器端炸的
  环境相关 bug，纯 Node 冒烟查不出**。
- **修复（已落地）**：
  1. 变量改名 `DOCK_CSS`（唯一命名，任何作用域都解析不到全局）；
  2. 恢复 `tag.textContent = DOCK_CSS.join("\n")` 正确注入（注意：事故后他人先用
     `textContent = CSS`（数组直接赋值）止血，那会让 CSS 被逗号拼接成碎样式，已一并修正）；
  3. `ensureCss()` 整体 try/catch + `Array.isArray` 防御：**注入永不抛错，坏了只降级不炸页**。
- **验证升级（防复发）**：`client-ssr.mjs` 增加「浏览器模拟」段：注入毒化的全局
  `CSS`（无 join 的命名空间）+ 假 `document`，让 `ensureCss()` 真实执行，断言样式按行 join、
  幂等、且带 `data-plugin-css`。今后任何把样式数组命名为 CSS/作用域错位的改动，测试当场红。
- **硬规矩（勿违反）**：bundle 顶层变量一律避开浏览器全局名（`CSS`、`window`、`document`、
  `fetch`、`AbortSignal` 等直接用但**自定义变量不要占这些名字**）；改 client 半部后
  SSR 冒烟 + 浏览器模拟段必须全绿，且真实 `dsh web` 启动验收前不允许发布/提交收尾。

### 8.9 续作会话（2026-08-22 下午）：0.3.0 模型设置 + 弹层窗口化

1. **0.3.0 模型设置（集成官方链路，不改内核）**：
   - 官方链路勘察结论（勿重复探索）：会话模型选择器（`ui-model-selection`，slot `conversation.input.model`）
     按 `model.reasoning.efforts` 展示强度档；档位源自 Provider 配置——
     pi-ai 每模型 `reasoningEfforts`（**键=档位，值=wire 值**；`off: null` = 支持关闭不发参数；`false` = 不支持思考；
     档位全集 off/minimal/low/medium/high/xhigh/max）；
     deepseek 官方连接级 `thinking`（enabled/disabled）+ `reasoningEffort` 默认档（off/low/high/max，全模型共享）。
   - 输入模态：官方 schema 仅收 `text`/`image`（pi-ai `input`、deepseek `inputModalities`）；
     **schemastery 保留未知字段（实测）**→「视频/音频/文档」以 `dockTags` 标注随官方配置持久化，不参与请求路由。
   - Host（index.js）：`GET/POST /dsh-dock/models`——GET 枚举目录（deepseek 官方始终可编辑，schema 默认兜底；
     其余按"已配置"口径）；POST 经 `settings.mutate(ns, ops, revision)` 写回（revision 乐观锁，冲突 409）。
   - Client（client.js）：`modelconfig` 模块（FEATURES 首位 = 导航第二项，紧跟「首页」）：
     Provider chips + 模型行编辑（id/名称/上下文/最大输出/输入类型/标注/思考强度三态）+ 添加/删除 + 保存/重新拉取；
     `modelsStore` 共享快照（首页总揽概要 "N 个 Provider · M 个模型"）。
   - 验证：Host 冒烟 `/tmp/dock-smoke/models-smoke.mjs`（读分类/写回 ops/拒绝用例/409）全绿；
     隔离实例（`/tmp/dsh-verify-home3`，端口 3999，profile link 仓库 + `@deepseek-ai/dsh-credentials` 软链）
     浏览器实测：GET 5 Provider；编辑 qwen `glm-5.2` 为自定义档（off/low/high）+ 视频标注 → 保存 →
     隔离 settings.yaml 出现 `reasoningEfforts: {off: null, low: low, high: high}` + `dockTags: [video]` ✅。
2. **弹层窗口化**：默认 `min(1080px, vw-32) × min(700px, vh-32)`；标题栏 ─ ▢ ✕ 三键
   （最小化折叠内容、最大化 inset 10px 铺满、双击标题栏切换）；标题栏 pointer 拖动（视口钳制）、
   右下角 16px 手柄缩放（≥640×420）；`lastGeom` 页面生命周期内记忆几何。实测拖动/缩放/最大化/最小化/还原全过。
3. **版本**：package.json 0.3.0；路线图顺延（0.4.0 tokenlog、0.5.0 动画、0.6.0 持久化）。
   ⚠️ 线上 `dsh web`（3080）需**用户手动重启**才会加载新 Host 半部（/dsh-dock/models 路由在 Host 进程内注册）。

### 8.10 事故复盘：开思考后 qwen 请求 400「developer is not one of …」（2026-08-22 晚，已修复）

- **现象**：用户给 qwen 路由模型开思考档后，选强度发消息即 400：
  `developer is not one of ['system','assistant','user','tool','function']`（百炼端点）。
  且只要模型 `reasoning=true`，**不选强度也 400**（system 一直被改写为 developer 角色）。
- **根因链**（关键代码均已核实）：
  1. pi-ai `openai-completions.js:787`：`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`；
  2. 非内置目录模型无 catalog compat → 检测默认 `supportsDeveloperRole: true`（标准端点）；
  3. **`qwen3.8-max` / `deepseek-v4-*-0731/0813` 不在 pi-ai 内置目录**（`glm-5.2` 在，自带
     `{thinkingFormat: qwen, supportsDeveloperRole: false}` 兜底，所以它没事）；
  4. 我们的模型设置让用户给非目录模型开了 `reasoningEfforts` → `reasoning=true` → 触发 2+3。
  另：qwen 路由是**纯目录路由**（用户层只有 models，api/baseURL 靠内置目录），修复时不能依赖 profile.api。
- **修复（index.js `piAiModelWrite`）**：
  1. **raw round-trip**：GET 带出原条目 `raw`，写回基于 raw 合并——未知字段（用户自配 compat/description 等）不再丢失（旧版保存会把它们清掉，这次也顺带修了）；
  2. **思考 compat 兜底**：凡启用 custom 档位，显式写 `compat.supportsDeveloperRole: false`
     （system 角色全端点通用）；目录路由（无 api）视作 openai 兼容；路由 id/baseURL 命中
     `qwen|dashscope|aliyuncs` 再补 `thinkingFormat: 'qwen'`（与目录内模型一致，实测 schema 接受）。
- **存量治愈**：直接给 `~/.dsh/settings.yaml` qwen 路由 4 个模型插入
  `compat: {thinkingFormat: qwen, supportsDeveloperRole: false}`（备份 `.bak-dock-heal`）；
  settings.yaml 被 chokidar 监听（watch:true）热生效。
- **端到端验证**（隔离实例 3999 + 治愈后配置 + 修复代码 + 拷贝凭证）：
  qwen3.8-max · High 发送成功，出现思考块且正常回复，无 400。
  （坑：隔离 home 缺 `.credentials.yaml` 会先报 MISSING_CREDENTIAL——从 ~/.dsh 拷 `.credentials.yaml` 即可。）
- **遗留提醒**：线上 3080 跑的还是旧写回代码——**在面板重复保存 qwen 模型会把 compat 再次清掉**，
  需重启 `dsh web` 加载新 Host 代码后才能安全使用面板保存。

### 8.8 数据通道（确认可行，勿改）

- 静态版本：`GET /dsh-dock/balance`（webServer 路由 + 同源 fetch）；动态预览：`harness.handle`
  + `host.call`。两者等价，静态为主。

### 8.10 续作会话（2026-08-22 晚）：模型设置一键批量操作

- **需求**：模型的输入支持（文本/图片 + 标注 视频/音频/文档）与思考强度档，支持一键全勾选和取消勾选。
- **实现（client.js `ModelsView`）**：
  - 每个模型行：输入行尾部加「全选 / 取消全选」；强度行加「全选 / 取消全选」
    （强度全选/取消 = 切 custom 并把全部档置 true/false）；
  - Provider 区工具栏（`dkm-toolbar`）：输入全选 / 输入取消全选 / 强度全选 / 强度取消全选，
    作用于该 Provider 全部模型草稿；官方 deepseek Provider 强度为 Provider 级共享，隐藏强度批量按钮；
  - 语义安全：输入取消全选 = `input: []` = 继承目录默认（Host 写回时删除 input 字段，
    见 index.js 写回逻辑，不会写坏配置）。
- 样式：`dkm-mini` / `dkm-toolbar`。验证：`node --check` + SSR（含弹层整树）+ Host 冒烟全绿。
- ⚠️ 8.9 的遗留提醒仍有效：若线上进程未重启加载新 Host 写回代码，面板保存可能清掉存量
  compat 治愈字段——保存前先确认已重启过 `dsh web`。

### 8.11 图片理解代理（2026-08-22 晚，v0.3.0 内追加）

- **需求**：纯文本模型也能"看图"——收图时自动调用配置的视觉模型识别，识别文本替换图片；
  多模态模型不受影响；视觉模型从模型目录（多模态模型）里点选。
- **官方现状**：纯文本模型收图时运行时把图片替换为 `[image omitted …]` 占位（`projectImagesForTextModel`，
  发生在 `LlmRuntime.adapterStream`，判定依据 prepareCall 返回的 `modelInfo.inputModalities`）；**没有**视觉代理机制。
- **拦截点勘察（勿重复探索）**：
  1. `llm/stream` 是 cordis waterfall，但 `next()` 不收参数、请求对象 frozen——**监听器无法改写请求**（只读）；
  2. `llm.registerAdapter` 对已有 provider 抛 `DUPLICATE_ADAPTER`——不能包装官方适配器；
  3. 主对话走 `llm.prepareCall` → `preparedCall.stream(request)`，其余走 `llm.stream`，两路都汇于 `streamWithRegistration`；
  4. 结论：**方法级包装 `llm.stream` + `llm.prepareCall`**（原函数存 `llm.__dockOrigStream`，own-property 覆盖，
     dispose 时 delete 恢复原型方法）——唯一的请求级拦截层。dsh 升级若改这两个方法需回归验证。
- **实现**：
  - 自有 settings 命名空间 `dsh-dock`（`settings.register` + schemastery）：`visionProxy{enabled,provider,model}`，
    写走 `settings.mutate`（revision 乐观锁），读走 `settings.get`（内存 resolved 值，热生效）；
  - `transformForVisionProxy`：目标是目录中**输入类型不含 image** 的模型且请求带图（含 tool-result 嵌套）→
    逐图调用视觉模型（`BlockAssembler` 聚合文本；maxTokens 4096——视觉模型带思考时小限额会被思考吃光，实测），
    图片块替换为 `[图片内容（由视觉模型 p/m 识别）：…]`；识别失败降级为说明文本；总兜底异常不改写不阻断；
  - 递归保护：识别调用走 `__dockOrigStream`（天然绕开包装）+ `dockVisionProxy` 标记双保险；
    `options.purpose` 存在（内部辅助调用）不代理；视觉模型自身不代理；
  - 目录判定用 `readModelDirectory` 的 10s TTL 缓存（避免每请求全量 settings.describe）；
  - GET /dsh-dock/models 附带 visionProxy 与 dsh-dock revision；POST 支持 `{visionProxy, revisions}` 分支。
- **Client**：模型设置页顶部「图片理解代理」面板——启用开关 + 视觉模型下拉
  （候选 = 目录中输入类型含 image 的全部模型，跨 Provider；当前值不在候选时保留"（当前）"选项）+ 独立保存按钮。
- **验证**：Host 冒烟（改写/多模态不改写/关闭不代理/visionProxy 读写/缺模型 400）全绿；
  隔离实例 UI 保存 → settings.yaml 持久化 → GET 反映 ✓；真实 API 验证 deepseek-v4-flash-vision-exp
  识别小图正确（答「红色」）。⚠️ in-app browser 无文件选择器，完整"发图→识别→回复"流待用户真实浏览器验证。
- **依赖新增**：@deepseek-ai/dsh-llm、@deepseek-ai/dsh-settings、@deepseek-ai/schemastery
  （package.json 声明 + 仓库 node_modules 软链 shim，同 dsh-credentials 模式）。

### 8.12 事故复盘：图片代理包装致「全模型 stream is not async iterable」（已修复）

- **现象**：重启加载图片理解代理后，**所有模型**每轮请求报 `本轮运行失败 stream is not async iterable`。
- **根因**：`prepareCall` 包装层用了 `async (options) => …` —— 返回 **Promise** 而非 AsyncIterable。
  消费方（agent-loop）`const stream = preparedCall.stream(request); for await (const chunk of stream)`
  的 `of` 表达式**不会先 await Promise**（Node 语义：直接取 Symbol.asyncIterator），Promise 上没有
  该符号 → 全量失败。（`llm.stream` 包装用的是 IIFE async generator，同步返回可迭代，没炸；
  只有 prepareCall 路径炸——主对话全走这条路。）
- **修复**：两层包装统一为 `(options) => (async function* () { … })()` —— 同步返回 async generator。
- **防复发**：Host 冒烟新增「包装契约」断言——`llm.stream(...)` 与 `prepareCall().stream(...)`
  都必须同步返回 AsyncIterable（非 Promise、有 Symbol.asyncIterator、可迭代）。
- **教训**：包装官方函数必须逐条保契约（返回类型同步性也在内）；冒烟当时只测了 llm.stream 路径，
  漏了 prepareCall 主路径——以后每个被包装的入口都要有契约断言。