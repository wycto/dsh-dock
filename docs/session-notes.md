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
### 8.13 事故复盘：误勾「图片」输入致模型瞎折腾 14 分钟 + PyYAML 二次事故（已修复）

- **用户现象**：给 deepseek-v4-flash-0731 发图问「图中有什么」，模型 87 步 / 14 分钟用
  bash+tesseract+swift OCR 自己折腾图片文件，而非走视觉模型。
- **根因 1（配置语义）**：此前「批量输入全选」把 qwen 路由 4 个模型全勾了「图片」——
  其中 glm-5.2 / deepseek-v4-flash-0731 / deepseek-v4-pro-0813 在 pi-ai 内置目录里是**纯文本**
  （GLM-5.x 全系纯文本；qwen 编程套餐目录里多模态的只有 kimi-k2.5+、qwen3.6+/3.7-plus/3.8-max-preview）。
  代理规则「多模态模型自己识别」→ 跳过；图片原样发端点 → 端点不认 → 模型只拿到附件文本引用 → 工具瞎找。
- **修复 1**：治愈 settings（4 处 input 删除、留空继承目录=纯文本；qwen3.8-max 真多模态保留）。
  语义已在面板写明：勾「图片」= 端点原生支持、原图直发；不确定勿勾，交给代理。
- **根因 2（判定源不一致）**：代理此前用**插件目录副本**判多模态——条目留空时副本显示路由默认
  （纯文本），但运行时解析链是 `entry.input ?? 内置目录 ?? 路由默认`：kimi-k2.7（qwen 路由）条目
  留空却靠目录继承 [text,image]，会被误拦。
  **修复 2**：判定改用 `llm.resolveModelInfo(provider, model)`（dsh-llm 运行时公开方法，与官方
  投影同源）；旧宿主无此方法/单次解析失败时回退插件目录。GET 目录逐模型附 `runtimeInput`，
  面板「图片理解代理」区展示「原图直发（多模态）/ 走视觉代理（纯文本）」分组。
- **提速**：识别调用先试 `reasoningEffort: 'off'`（关思考求快）；报 UNSUPPORTED_REASONING_EFFORT
  则回退默认档重试一次。
- **二次事故（自查自纠）**：治愈脚本用 PyYAML load/dump 转储 settings.yaml——PyYAML 是 YAML 1.1，
  把 `off:` 键解析成布尔 False 再写回成 `false: null`（**键名腐蚀**）；且全新启动时 llm-pi-ai
  schema 校验不过 → **全部 pi-ai Provider 消失**（热加载进程不重启则无感，极具迷惑性）。
  补救：从备份做**纯文本手术**（只删 input 行、不动其他字节）。
  **教训：绝不用 PyYAML 转储用户 settings.yaml**（YAML 1.1 布尔陷阱 off/yes/on/no）；要改就文本级
  手术，或让 settings 服务自己写（settings.mutate）。
- **验证**：双实例（3080 线上 / 3999 隔离）全新启动后 5 Provider 齐全；runtime 判定
  治愈模型=text（走代理）、qwen3.8-max=text,image（直发+当视觉模型）；Host 冒烟新增 5 断言
  （runtimeInput 附带 / 目录继承多模态不误拦 / 解析失败回退 / off 被拒自动重试 / off 先行尝试）全绿。
- GLM-5.3（fangzhou 自定义路由）：未进内置目录 → 运行时默认纯文本 → 收图自动走视觉代理 ✓。

### 8.14 终局复盘：图片理解代理「配了还是不能识别」三层根因（已修复，真实全链路验证通过）

用户反馈配好了代理仍不能识图（模型抱怨"sha256 不是文件路径"）。隔离实例 + API 注图复现，
探针矩阵二分定位，共三层根因（一次比一次深）：

1. **官方带图准入拦截**（首层）：apiproxy 的 `session.prompt` 收到图片先查
   `ctx.llm.resolveModelInfo(provider, model)` 的 inputModalities，纯文本模型直接拒绝
   `MODEL_DOES_NOT_SUPPORT_IMAGES`——请求根本进不到 llm.stream 包装层。
   **修复**：安装时同时包装 `resolveModelInfo`（虚拟多模态）：代理启用且目标≠视觉模型时，
   纯文本模型的 inputModalities 对外补 'image'（浅拷贝，不改 truth）；改写判定继续用原函数。
   副作用勘察：其余调用方（模型选择器目录只用 reasoning 字段；mcp-client/tool-fs 的图片
   声明检查——放行反而正确，工具产图也走代理）；官方内部投影不走此公共方法。
2. **`BlockAssembler.finish` 是 getter，恒真值**（最深的根因）：`finish` 未收到 finish chunk
   时返回 `{kind:'stop'}`——`if (assembler.finish) break` 会在**第一个 chunk 后就 break**，
   识别永远只消费 1 个块（block-start）→ 空文本 → "视觉模型没有返回文本"。
   ~350ms 秒败 + 位置相关曾误导出"端点限流"假说（探针 A-E 用 `c.type==='finish'` 恰好成功，
   F-J 用 `asm.finish` 恰好失败，与调用次序重合）。**修复**：`if (chunk.type === 'finish') break`。
   教训：**消费官方对象先核对属性语义**（getter/方法/默认值），冒烟的 fake 流第一个 chunk
   就带文本所以测不出该 bug。
3. **识别调用通道**：改走原 `prepareCall().stream()`（与 agent-loop 带图请求同通道，被验证
   路径）；options 以 `prepared.config`（resolved）为底构造，否则 `callConfigEquals` 拒绝。
   不带 sessionId（llm/stream 的会话检查点监听对带 sessionId 的调用先做检查点）。

**识别结果缓存**（防真实限流）：`attachmentId+视觉模型 → 文本`，TTL 10 分钟、上限 64 条。
agent 每轮重试/多步都带历史图片重发，逐图重识别既慢又易撞端点节流；失败不缓存。
导出 `__clearDescribeCache()` 供冒烟隔离。

**验证**（隔离实例 3999 真实全链路，API 注图）：
- deepseek-official/deepseek-v4-flash-vision-exp 视觉模型：识别 168 字，主模型
  deepseek-v4-flash-0731 正确答出"蓝底+黄方块+绿长条"（与测试图一致），无工具折腾；
- qwen-token-plan-cn/qwen3.8-max 视觉模型（用户实际配置）：识别 174 字，同样正确。
Host 冒烟新增：虚拟多模态（启用宣称/停用保真/多模态不重复加）、识别缓存命中断言。

### 8.15 v0.4.0：模块化架构 + 用量记录（2026-08-22 深夜）

**需求**：①新功能【用量记录】放第二个菜单，功能与页面参照 `/Users/weiyi/develop/gitea/wycto/dsh-token-usage`
（仅作参照，不动那个仓库与 npm 包）；②dsh-dock 像dsh 一样由一个个独立功能模块组成，任何模块可拎出单独打包发布，又能装回面板。

**架构落地（feature 模块化）**：

- 仓库重构：`features/<id>/host.js`（宿主半部，纯 ESM 零构建）+ `features/<id>/view.js(x)`（客户端视图）+ `src/client.jsx`（外壳组装）+ `src/host-core.js`（共享内核）；`index.js` 只 import 组装（1359 行 → ~90 行）。
- **客户端放弃零构建**（本版唯一推翻的历史决策，见三、表格 8.7 条上下文）：esbuild bundle 成单文件 `client.js`（react 系外部化走运行时 seed，`@wycto/dsh-token-usage` 同款线上已验证模式）。理由：650 行 JSX 视图手写 createElement 不可维护、真实源码文件无从模块化。**宿主半部保持零构建**。改客户端后必须 `node scripts/build-client.mjs`。
- 模块契约：视图导出 `{ id, name, order, accent, description, css, View, HomeStat?, Chip? }`（order 定菜单次序，当前：modelconfig=100/tokenlog=110/balance=120/animation=130/heartbeat=140/theme=150）；宿主导出 `{ id, name, description, defaultEnabled, setup(ctx)→disposer }`；视图收到 `{ ctx, feature, params }` props（params 来自导航总线）。
- **会话区 chips（0.4.0 追加）**：外壳注册 `conversation.input.left`（模型选择器左侧工具行，官方文档指定可点击小控件的座位），渲染各已启用且「会话页显示」功能的 `Chip` 组件；余额 chip 显示当前选中 Provider 余额（agentDefaultModel 快照），点击 openPanel('balance', {provider}) 定位并高亮行；用量 chip 显示当前会话总 Token（query sessionId，10s 刷新），点击 openPanel('tokenlog', {sessionId}) 按会话筛选。开关状态经 shared.js 总线（面板导航 + 功能开关 + chip 显隐，localStorage 持久化 `dsh-dock/chips/v1`），避免外壳↔模块循环依赖。
- **dockBridge 回装通道**：`client.js` 导出 `dockBridge.register(def)`；独立功能包（`scripts/extract-feature.mjs` 生成的骨架）在浏览器端 `ctx.modules.import('dsh-dock')` 成功→注册进功能坞（独立入口隐藏），失败→自己独立面板。跨插件 import 是 DSH client-modules 官方机制（懒 CJS 注册表 + boot 图，已读 `dsh-client-modules` 源码验证），非 hack。外部视图有 FeatureBoundary 错误边界 + 「外部」徽章 + package 标注。
- 提取脚手架 `scripts/extract-feature.mjs <id>`：镜像仓库布局生成独立包（宿主入口/双形态客户端入口/构建脚本/patch/package.json），脚手架性质、发布前需裁剪实测。

**用量记录（tokenlog）**：宿主移植 `dsh-token-usage/lib/index.js`（session/event 实时 + 启动全量扫描、sessionId:seq 去重、turn/end 两遍回填、峰谷定价 + 官网价目 24h 抓取 + `dsh-dock-tokenlog` 命名空间覆盖），RPC `POST /dsh-dock/tokenlog/query|export|scan`；视图移植其 client v6（筛选/KPI/分组/明细/CSV/5s 自刷新/localStorage 暂存），CSS 前缀 `dtok-`，dock 内自适应（无 overlay 壳，全屏用弹窗最大化）。顺带修了原版分组按钮一次旧维度过期查询（runQuery 带 dimOverride）。

**验证**：`node --check` 全绿；构建产物含 ModuleLoader 壳/`exports.dockBridge`/仅 react 系外部依赖（bundle 纯度断言，8.7/8.12 教训延续）；`/tmp/dock-smoke-v040/smoke.cjs` 全绿——假 react（手搓 hooks 派发）渲染整棵弹层树断言菜单次序（首页/用量记录/模型设置…）、外部桥注册排序与徽章、错误边界；宿主假 ctx 装配断言三路由注册、tokenlog 摄取→查询→分组→CSV 闭环（含 token 桶/派生字段/llmMs/状态回填/金额非零）。浏览器实测见后续补充。

**注意**：
- 冒烟假 ctx 的 `effect(fn)` 必须立即执行 fn（cordis 语义），否则 tokenlog 路由注册不到——曾在此误判路由缺失。
- Node 26 有实验性全局 localStorage，冒烟里 `typeof localStorage` 不再是 undefined（try/catch 兜底无碍）。
- visionproxy 依赖 modelconfig 的 `readModelDirectory`（模块间 import），提取时两个模块要一起拎。

### 8.16 v0.5.0：任务动画（2026-08-23）

**需求**：参照 `/Users/weiyi/develop/gitea/wycto/dsh-task-pulse` 做任务动画功能，但动效不要花哨、要克制高级；支持单独开启动画 / 单独开启通知；所有配置持久化。

**实现（features/animation/ 模块，占位转正）**：

- **Host（features/animation/host.js）**：会话级任务追踪移植自 task-pulse（agent/status 驱动开始/结束、session/event 补回合/步骤/工具/Token/结束原因/首条输入与末条摘要、agent/disposed 兜底；readTitle 异步回填标题），去掉钉钉推送。RPC `POST /dsh-dock/animation/status|config`；配置经 `settings.get/mutate(DOCK_NS)` 持久化到 settings.yaml `dsh-dock.animation` 段（schema 在 host-core.js DockConfig 扩展：animationEnabled/effectMode/notifyEnabled/notifyOnComplete/notifyOnError/notifyStayMs/systemNotify）。config 增量合并、逐字段类型校验（未知 effectMode 忽略、stayMs 钳 0~600000）。
- **Client（features/animation/view.jsx）**：
  - 新模块契约 **Overlay**：功能描述符可挂全局浮层组件（props {ctx, feature}），外壳新增 shell.overlay 注册 `dsh-dock-feature-overlays`（order 22）统一渲染已启用功能的 Overlay（FeatureBoundary 包裹；dockBridge 外部功能同样支持）——与 Chip（会话区小控件）互补，Overlay 是常驻整页 UI。
  - 动效（全部走 dsw 主题变量、暗/亮自适应）：任务进行中右下角玻璃拟态状态徽标（任务数+计时，点击 openPanel("animation")）；三选一动效模式 flow=顶部 2px 流光细线（默认）/breathe=徽标圆点呼吸/ring=圆点细环匀速旋转；任务结束徽标与细线自动消失，完成瞬间一缕一次性流光掠过（成功绿/异常红，onAnimationEnd 清场）。
  - 通知：右上角 toast 卡片栈（标题/模型/耗时区间/回合步骤工具/Token/摘要/错误），完成与异常可分别开关、停留时长 4s~30s 或常驻、最多叠 4 张、out 动画后卸载；可选浏览器系统通知（仅 document.hidden 时推送，开关点击时 requestPermission——用户手势）。结束检测靠轮询 diff（2s 活跃/6s 空闲/15s 出错自适应，visibilitychange 立即刷新）。
  - 面板页：动画/通知两组独立开关 + 模式选择卡（缩微实时预览）+ 进行中/最近完成列表；每个开关即时 RPC 保存（乐观更新，回包经 animationStore.applyConfig 对齐）。共享 animationStore（浮层轮询驱动，View/HomeStat 只读）。
- **功能开关持久化（0.5.0 路线图项顺手落地）**：shared.js `dsh-dock/features/v1` localStorage（与 chips 显隐同模式）；Host↔Client 开关双向同步仍未做（面板停用只影响浏览器侧，Host 侧 defaultEnabled 为准——见 index.js 注释）。

**验证**：`node --check` 全绿；构建产物仅 react 系外部依赖；冒烟 `/tmp/dock-smoke-v050/smoke.cjs` 全绿（bundle 契约/5 slot/导航次序/浮层渲染、动画追踪闭环 running→事件→idle→status、config 合并→mutate 落盘→status 反映、非法值钳制、tokenlog 双监听共存无回归）；隔离实例（/tmp/dsh-verify-home3，端口 3998）真实 RPC：status 默认配置 ✓、config 写入 settings.yaml animation 段 ✓、status 反映新值 ✓、`/plugins/dsh-dock/client.js` 服务的就是新构建（字节数一致）✓。

**注意**：
- 冒烟假 react 曾把 useEffect(fn) 的 fn 当 useState 初始化函数**立即执行**（v040 遗留），撞上 overlay effect 里的 document 才暴露；已改为 effect 只存不执行（React 语义）。
- 会话标题是异步回填：毫秒级结束的任务可能落到 firstPrompt 兜底标题（task-pulse 同款行为，可接受）。
- 线上 3080 旧宿主对 /dsh-dock/animation 返回 405（无路由）；**用户需手动重启 dsh web** 后动画路由与新 client bundle（rev 模块映射在 boot 时生成）才生效。
- v040 冒烟脚本 7 项"失败"均为预期变化（slot 4→5、动画转正无规划徽章、单监听器假 ctx 被 animation 覆盖 tokenlog），非产品回归；v050 冒烟已断言双监听共存。

### 8.17 事故复盘：任务动画页排版全乱（2026-08-23，已修复 + 防复发断言）

- **现象**：用户反馈任务动画页排版错乱——模式选择卡变成一行挤在一起的纯文本、无卡片边框、第三张卡溢出内容区、设置行间距全无。
- **根因**：`features/animation/view.jsx` 定义了 `css` 常量，但 **feature 描述符导出时漏挂 `css` 字段**——外壳 `ensureCss()` 只按 `f.css` 收集模块样式，动画模块的 28043-19507≈8.5KB 样式整体缺失，所有 `dkan-` 类裸奔（`.dkan-mode` 退化为 inline-block、`.dkan-sec`/`.dkan-row` 退化为 block）。
- **为什么冒烟没拦住**：v050 冒烟只断言了视图渲染与 RPC 闭环，**没断言注入样式内容**——又是 8.7 教训的重演（浏览器端才炸的问题，纯 Node 冒烟查不出）。
- **定位手段（可复用）**：浏览器实测 + 只读 `evaluate` 量 computed style：`style[data-plugin-css="dsh-dock"]` 里 `includes('.dkan-mode')` 为 false、标签尾部还是 balance 样式 → 直接锁定「css 没进 fullDockCss」。
- **修复**：feature 描述符补 `css,` 字段；顺带修掉系统通知说明文案的重复括号（permNote 已含「仅页面后台时推送」又拼了一次）。
- **防复发**：v050 冒烟新增 A2b——假 document 捕获注入样式，断言含 `.dkan-mode{`/`.dkan-badge{`（动画）与 `.dtok-`/`.dkb-`（存量），任何模块忘挂 css 当场红。
- **验证**：重建后浏览器实测——CSS 注入 28043 字符、三张模式卡 flex 并排各 269×93 带边框、sec/row/head 全部恢复 flex；浏览器点击「轨道光环」→ settings.yaml 即时出现 `effectMode: ring`（交互→RPC→落盘闭环）。

### 8.18 版本策略（2026-08-23 用户指示）

- 内部调试一律用小版本递增（当前 **0.4.2**）；**等用户明确说发布时再升到目标大版本**（任务动画对应 0.5.0）。
- `package.json` 与 `src/client.jsx` 的 DOCK_VERSION 保持同步 0.4.2。

### 8.19 钉钉群机器人推送（2026-08-23，0.4.2 内追加）

**需求**：任务动画的通知支持对接钉钉群机器人，参照 `/Users/weiyi/develop/gitea/wycto/dsh-task-pulse`（宿主侧 webhook 推送同款）。

**实现**：

- **配置**（schema 扩展 `dsh-dock.animation`）：`dingtalkEnabled`（默认 false）+ `dingtalkWebhook`（默认 ''）。config RPC 校验：非空 Webhook 必须以 http(s):// 开头否则 400（顺带修了路由 catch 一律 500 的问题，改按 e.statusCode 映射）。
- **宿主推送**（features/animation/host.js）：`finishSession` 归档后 `pushDingtalkIfNeeded(record)` 异步直发（不阻塞）——**宿主侧发送，浏览器关着也能推**；事件筛选跟随 `notifyOnComplete`/`notifyOnError`（完成推/异常推与页面通知共享语义，通道各自开关）。markdown 消息移植 task-pulse 版式（任务/模型/耗时区间/回合步骤工具/Token/结果/摘要/署名），**标题含「任务」二字**——钉钉自定义关键词填「任务」或「dsh」即可命中。`sendDingtalk` 判定成功 = HTTP 200 且业务 errcode===0（比 task-pulse 只看 res.ok 更严）。
- **test RPC**（`POST /dsh-dock/animation/test`）：用已保存 Webhook 发测试消息，返回 `{sent, error}`（连通失败也是 200 + sent:false，UI 内联展示错误，不当 HTTP 错误抛）。
- **客户端**（view.jsx）：通知区之后新增「钉钉推送」卡片——开关 + Webhook 输入（草稿「保存」按钮 + 「发送测试消息」按钮 + 内联测试结果）+ 机器人创建指引。**同步保护**：配置轮询回包不再覆盖乐观值/输入草稿——`pendingSavesRef`（保存进行中跳过同步）+ `editingWebhookRef`（输入中跳过同步；保存成功后手动对齐一次，因同步 effect 在编辑期被跳过不会再触发）。
- **验证**：冒烟 B4（fetch 桩）——推送格式（msgtype=markdown/标题含任务完成/含任务与模型与摘要/署名）、开关门控（关推送不再发）、事件门控（notifyOnComplete=false 完成不推）、errcode≠0 与 HTTP 非 200 两态 sent:false、非法 Webhook 400；隔离实例真实 RPC——400 状态码映射 ✓、Webhook 落盘 ✓、拒连端口 test 优雅返回 sent:false("fetch failed") ✓；浏览器实测——钉钉区渲染/输入框/按钮 ✓、点击开关落盘 ✓。

### 8.20 动画增强：错位修复 + 速度驱动 + 环屏巡航 + 桌面机器人（2026-08-23，0.4.2 内追加）

**用户反馈**：①徽标/浮层与 dsh 自身 UI 错位；②动画不明显；③要更多动效（绕屏幕转圈、速度随任务）；④桌面机器人（多显示器工位、思考/写码/查资料三态同步、要逼真）；后追加：⑤机器人要侧身/背侧视角；⑥机器人可自由拖到屏幕任意位置防遮挡。

**实现**：

- **错位根因与修复**：徽标固定 `bottom:20px` 压在 dsh 输入卡（`--dsh-composer-height`，约 152px）与 Details 区上。修复：徽标/机器人默认停泊抬到 `bottom:calc(var(--dsh-composer-height,152px) + 20px)`；**功能坞面板打开时环境动效整体隐藏**（subscribePanel 驱动 ambientOn，避免与弹窗重叠）；钉钉 Webhook 行 `nowrap` 防按钮换行错位。
- **速度驱动**：overlay 每次轮询按 Token 吞吐（Δtokens/Δt）算 speed=clamp(0.7+t/45, 0.7, 3)，经 CSS 变量 `--dkan-speed` 下发；全部动效时长用 `calc(base / var(--dkan-speed))`——流光/呼吸/旋转/巡航/机器人敲击全随任务忙闲变速。
- **新动效**：
  - `orbit` 环屏巡航：12px 光点（发光+拖影光晕）沿屏幕四边转整圈（keyframes top/left 四段）。
  - `robot` 桌面伙伴：**背侧视角**纯 CSS 场景（176×108）——横贯书桌、三台显示器（侧屏 rotateY ±24° 透视内倾）、机器人见后脑勺+双耳+天线+椅背+双肩前臂。`data-phase` 三态：think=屏幕调暗+歪头+思考泡泡；code=双臂高频交替敲击+中屏代码行滚动；search=头部左右扫视+侧屏滚动。**整卡 pointer 拖拽**（≥4px 位移阈值区分点击，拖后位置写 localStorage `dsh-dock/anim/robot-pos/v1`，挂载恢复时钳回视口内），默认停泊右下输入卡上方。
- **阶段追踪（host）**：`tool/call` 事件带 `data.name`（dsh-agent-loop appendToolCall 实证：turn/step/callId/name/arguments）。分类：web|search|fetch|grep|glob|read|ls→search，其余（edit/bash…）→code；step/start 与 assistant/message→think。status RPC active 条目新增 phase/phaseAt/lastActivityAt；面板「运行状态」行显示阶段标签。
- **可见度增强**：流光细线 2px→3px、底色 16%→30%、扫光段加白端+辉光；呼吸/环加大加亮。

**验证**：冒烟全绿（新模式合法值、phase 三态断言 step/start→think / webfetch→search / str_replace_editor→code、新 CSS 注入断言 .dkan-orbit/.dkan-botcard/.dkan-bot-scene[）。隔离实例 + 真实任务 E2E：40s bash 任务运行中实测——host 侧 phase 实时流转（bash 期 code → 收尾 think）；浏览器侧五种模式元素逐一出现（orbit/line/badge+dot/badge+ring/botcard 各=1）；机器人卡片背侧结构齐全（臂x2 屏x3 椅x1 耳x2）、caption「1 个任务 · 00:07 · 编写代码」；cua.drag 拖到 (328,95) 成功、刷新页面后新挂载从 localStorage 恢复同位置；错误边界 0 触发。

**注意**：
- 会话视图的输入框 placeholder 从 "Describe what you want to build"（新会话）变为 "Message the agent"（进入会话后），自动化测试按角色名定位。
- 机器人阶段是"最近一次事件"的粗粒度推断（事件驱动，无流式细节）——assistant/message 后短暂 think、bash 长跑期稳定 code，符合直觉即可，不是精确的 token 级流式状态。
- dsh 输入卡高度走 `--dsh-composer-height`（152px 回退值），dsh 升级改高度时停泊位自适应。

### 8.21 3D 立体机器人 + 流级阶段同步（2026-08-23，0.4.2 内追加）

**用户反馈**：①机器人要 3D 立体、侧身面对镜头；②同步 bug——正文已经在输出，机器人还显示"思考中"。

**同步 bug 根因与修复**：旧阶段只靠事件级推导（step/start/assistant/message/tool/call），消息粒度太粗——模型流式输出期间没有任何事件更新阶段。**修复：接 `assistant/chunk` 流级事件**（dsh-agent-loop 每 token append 一条 `{turn, step, chunk}`，chunk.type 为 `reasoning-delta`/`text-delta` 等，dsh-llm invariant.js 实证）：reasoning-delta→think、text-delta→**write（新增阶段"输出中"）**；assistant/message 落盘后不再回跳 think（维持 chunk 末态，避免输完还闪思考）。

**3D 实现（纯 CSS，无三方库）**：Box3 组件 = 六面长方体（前/后/左/右/顶/底，backface-visibility:hidden + 面级明暗渐变出光感）；世界层统一 `rotateX(-15deg) rotateY(-30deg)` 取 3/4 视角（俯视 + 侧身面向镜头）；场景 = 书桌+桌腿、三台薄盒显示器（组内扇形微转、屏幕贴前面板）、机器人（椅背/椅座/躯干/头组/双臂肩+肘两级关节/键盘）。阶段驱动：think=仰头(rotateZ)+泡泡+屏幕调暗；write/code=低头+肘部高频敲击+中屏代码滚动；search=头部 rotateY 左右扫视+侧屏滚动。速度仍走 --dkan-speed。

**验证**：冒烟补 chunk 断言（reasoning→think / text→write / message 不回跳）全绿；隔离实例真实任务每秒采样阶段时间线：`think code×5(bash) think write×9(600字输出流) ·`——bash 期 code、输出流期 write 精确对应；3D 结构体检（15 个长方体/3 屏/2 肘/2 眼、world matrix3d 生效）。
**注意**：环境动效在功能坞面板打开时自动隐藏（8.20 防重叠设计），浏览器验证机器人必须先关面板；面板打开期间观察不到卡片是预期行为。

### 8.22 机器人换 3D 动漫人物 + 修身体被桌遮挡（2026-08-23，0.4.2 内追加）

**用户反馈**：①机器人只见头不见身子；②换成 3D 动漫真人角色；③动作要随任务切换（思考完要有写代码动作）。

**只见头的根因**：8.21 的机器人组 `translateZ(-6px)` 与书桌同深度，躯干/椅/手臂埋进桌体被遮挡，只有头探出桌面。**修复**：人物组改 `translateZ(30px)` 坐到桌前近镜头侧（侧身面对屏幕、背对镜头偏侧），桌子收窄到右侧，键盘 `z=14` 放桌前缘手边——头/躯干/腿/椅/手臂全部可见。

**换人**：机器人 → 动漫人物（仍纯 CSS 长方体）：后发+顶发（棕）、脸（肤色+深色眼睛+脖颈）、卫衣躯干、坐姿腿（大腿前伸+小腿垂下）、双臂带手（肤色手块）、椅子。配色走 dk3-skin/dk3-hair/dk3-hood/dk3-pants 面级渐变。动作语义不变（think 仰头+泡泡 / write+code 低头敲键盘 / search 扫视），阶段仍由 assistant/chunk 流级同步。

**验证**：结构体检（人物组/头/发×2/眼×2/躯干/腿×2/臂×2/手×2/椅，人物 matrix3d z=30）；真实任务时间线 `think code×8(bash) think write×8(输出流) ·`——思考→写代码→输出逐段切换。

### 8.23 人物居中布局修正（2026-08-23，0.4.2 内追加）

- **用户反馈**：人物坐在桌子左边缘外，要坐到桌子中间。
- **修正**：场景加宽 200→220px；书桌 200 宽居中（x=110 中心）；人物组 left 16→96（中心 x≈118 ≈ 桌中心）；三屏收到人物右侧扇形（x=128/166/196，ry ±20°）；键盘 x=126 在人物手边桌前缘。
- **几何验证**（面板预览卡实测）：人物中心与桌中心偏差 8px（居中）；人物 bottom 落在桌沿下（坐姿正确，腿在桌面下方）；三屏在人物右侧、键盘在手边。
- **注意**：本节验证时隔离实例的模型配额已耗尽（429 insufficient_quota，周配额 08-28 重置）——真实任务 E2E 已不可行，布局验证改走面板预览卡（静态渲染同款 RobotScene）+ getBoundingClientRect 几何测量；阶段流转逻辑未改动（8.22 已验证）。
