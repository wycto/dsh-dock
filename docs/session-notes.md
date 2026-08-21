# 会话总结与决策记录（2026-08-21）

> 给后续 DSH 会话的交接文档：新会话继续完善本项目前，先读本文件 + README。
> **2026-08-22 更新**：0.2.0 模型余额已接入，见文末「八、续作会话（2026-08-22）」；
> 其中的 typert 假设已被推翻（见 8.3），下一会话从 0.3.0 Token 用量开始。

## 一、本项目是什么

`dsh-dock` —— DeepSeek Harness 功能中枢插件。一张管理面板统一注册、开关所有小功能（模型余额、Token 用量记录、任务动画，以及未来任意新功能）。已发布 npm：**dsh-dock@0.1.0**（maintainer: wycto），0.2.0（模型余额）代码完成待发布。

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

1. 用户重启 `dsh web` → 在设置页确认「功能中枢」新面板（心跳/主题/模型余额）与余额卡片数据。
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