# dsh-dock · 功能坞

[![npm version](https://img.shields.io/npm/v/dsh-dock)](https://www.npmjs.com/package/dsh-dock)
[![license](https://img.shields.io/npm/l/dsh-dock)](LICENSE)

**DeepSeek Harness 功能坞插件（dsh-dock）**：用一张管理面板，统一注册、开关所有小功能。

模型余额、用量记录、任务动画……这些散落的小功能，全部收进一个「功能坞」：
每个功能是独立模块，有注册表、有开关、有错误隔离。新功能按模块追加，老功能互不牵连。

> **v0.4.0 起为模块化架构**：功能坞 = hub + 一个个独立功能模块（像 dsh 本身由小包组成）。
> 每个功能是一个 `features/<id>/` 目录（宿主半部 + 客户端视图），**可整体拎出单独打包发布**
> （`scripts/extract-feature.mjs` 生成独立包骨架）；独立发布的功能包装回后，经
> **dockBridge** 注册进功能坞菜单——「单独成包」与「完美集成」两全。
>
> 前身：本地原型 `feature-hub`（已安装验证），本包为其正式发布的 npm 版本。
> 相关功能包：`@wycto/dsh-balance-panel`、`@wycto/dsh-token-usage`、`@wycto/dsh-task-pulse`
> （余额功能已于 0.2.0 吸收为中枢内模块；用量记录已于 0.4.0 以模块化方式重吸收）。
> 开发背景与决策见 [docs/session-notes.md](docs/session-notes.md)。

---

## 当前状态（v0.4.0 · 模块化架构 + 用量记录已接入）

- ✅ **模块化架构（0.4.0）**：功能代码从两个大文件拆进 `features/<id>/` 模块目录；
  宿主半部 `index.js` 与客户端外壳 `src/client.jsx` 只做组装，不含功能逻辑；
  每个模块可单独提取成包（见下文「提取一个功能成独立包」）
- ✅ **用量记录（0.4.0，第二菜单）**：记录全部 LLM API 调用并统计——
  - 秒级时间范围 + 会话/提供商/模型（联动）/状态/推理强度筛选，条件本地暂存（下次打开恢复）；
  - 9 张 KPI 卡（调用次数 / 总 Token / 输入 / 缓存命中 / 命中率 / 输出 / 金额($) / 金额(¥) / 累计耗时）；
  - 分组统计（无/provider/model/status/effort 维度切换）；
  - 明细表 15 列可排序、100 行/页上下双分页、会话 ID 点击即筛选、行详情弹窗、CSV 导出；
  - 定价引擎：内置 DeepSeek 峰谷价目 + 官网价目每日自动抓取 + `dsh-dock-tokenlog` 命名空间覆盖；
  - 首页总揽「今日调用/Token/花费」卡片；面板打开期间每 5 秒自动刷新
- ✅ 设置页「功能坞」面板（侧栏底部 → 设置 → 功能坞）
- ✅ **侧栏入口按钮**：侧栏底部动作区右端「功能坞」按钮，弹出**功能面板**（居中模态：左导航 = 首页总揽 + 各功能模块按 order 排序，右内容区）
- ✅ **弹层窗口化**：默认大窗（1080×700 自适应），最大化/最小化/还原、标题栏拖动、右下角缩放；几何页内记忆
- ✅ **模型设置（0.3.0，集成官方链路）**：编辑各 Provider 模型目录（输入类型 + 思考强度档位），`settings.mutate` 写回官方配置热生效
- ✅ **模型余额（0.2.0）**：枚举全部已配置 Provider，内置策略表查询余额/配额/控制台链接，5 分钟自动刷新
- ✅ 每功能独立开关 + 错误隔离：单个功能出错只降级自己（外部包视图另有错误边界保护）
- ✅ 示例功能：心跳监视、主题信息（纯 Client，开箱可用）
- 🚧 功能开关为浏览器内存态，刷新重置（持久化在 0.6.0）
- 🚧 任务动画已登记为规划占位（0.5.0）

### 模块化架构（0.4.0）

```
dsh-dock/
├── index.js                  # 宿主半部入口（纯 ESM，零构建）：import 各模块组装注册表与生命周期
├── client.js                 # 客户端 bundle（构建产物，提交仓库；源码见 src/ + features/）
├── src/
│   ├── client.jsx            # 客户端外壳：入口按钮/弹层/设置页/首页总揽/slots 注册/外部功能桥
│   ├── shared.js             # 共享工具（外部视图错误边界等）
│   └── host-core.js          # 宿主共享内核（DOCK_NS 命名空间、sendJson/readBody/walkPath）
├── features/                 # ★ 一个目录 = 一个功能模块（整体可拎出单独打包）
│   ├── balance/              #   host.js + view.js
│   ├── modelconfig/          #   host.js + view.js（含图片理解代理配置面板）
│   ├── visionproxy/          #   host.js（纯宿主功能，UI 在 modelconfig 页内）
│   ├── tokenlog/             #   host.js + view.jsx（用量记录）
│   ├── heartbeat/            #   view.js（纯客户端功能）
│   └── theme/                #   view.js（纯客户端功能）
├── scripts/
│   ├── build-client.mjs      # esbuild bundle → client.js（改视图后需重跑）
│   ├── extract-feature.mjs   # 功能提取脚手架：features/<id> → 独立包目录
│   └── publish.sh            # 一键发布
└── docs/session-notes.md     # 会话总结与决策记录
```

**模块契约**：

- 宿主模块 `features/<id>/host.js` 导出 `feature = { id, name, description, defaultEnabled, setup(ctx) → disposer }`；
- 视图模块 `features/<id>/view.js(x)` 导出 `feature = { id, name, order, accent, description, css, View, HomeStat? }`；
  `order` 决定菜单次序（首页固定第一；tokenlog=10 → 第二菜单，存量功能 100 起）；
  视图收到 `{ ctx, feature }` props（需要 timer/theme 等 Client 服务的模块自行取用）；
  每模块自带 `css`（类名前缀隔离：dkb-/dkm-/dtok- …），外壳统一注入；
- 客户端外壳 `src/client.jsx`：import 模块 → 组装导航/首页/设置页；导出
  `apply` / `inject` / **`dockBridge`**（外部功能回装通道）。

**为什么客户端引入了构建**（v0.4.0 决策，宿主半部仍是零构建纯 ESM）：
功能模块用真实源码文件 + JSX 组织，esbuild 打成单文件 `client.js`
（`react`/`react/jsx-runtime` 由运行时 seed，外部化；与 `@wycto/dsh-token-usage`
已在线上验证的构建模式同款）。改客户端代码后跑 `node scripts/build-client.mjs`。

## 面板入口

```
① 快捷入口：侧栏底部「功能坞」按钮（与设置按钮同底对齐）→ 弹出功能面板（首页总揽 + 模块导航 + 内容区，窗口可最大化/最小化/拖动/缩放）
② 完整面板：设置（侧栏底部）→ 功能坞
```

入口按钮与功能弹层挂载在 shell 的 `sidebar.footer.action` / `shell.overlay` 座位；
弹层与完整面板共用各功能的模块级共享快照
（余额 `/dsh-dock/balance`、模型目录 `/dsh-dock/models`、用量 `/dsh-dock/tokenlog/*`，首页总揽概要与各视图同源）。

### 用量记录（0.4.0）

- **数据源**：DSH 会话日志（`sessionQuery` 服务）。宿主实时监听 `session/event` 增量记账，
  启动时全量扫描历史（`sessionId:seq` 幂等去重，实时与扫描重叠不双计）；
  记录含五类 token 桶、状态/错误码（`turn/end` 两遍式回填）、耗时（step/start → assistant/message）。
- **定价与金额（估算）**：内置 DeepSeek-V4 峰谷刊例（高峰每日 9:00–14:00 双倍）等；
  每 24h 自动抓取官网价目页（失败静默回退内置）；汇率与价目可在 settings.yaml 覆盖：

  ```yaml
  dsh-dock-tokenlog:
    usdCnyRate: 7.2
    pricingUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
    pricingFetchIntervalHours: 24
    pricing:
      deepseek-v4-flash: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 }
  ```

  改价即时生效（查询/导出时按当前价目重算历史）。
- **RPC**：`POST /dsh-dock/tokenlog/query|export|scan`（同源 webServer 路由）。
- 已知口径：金额为估算；失败调用（无 `assistant/message`）不产生 token 行，状态反映回合结局。

### 模型余额支持情况（0.2.0）

内置余额策略表覆盖：**DeepSeek**（官方余额接口）、**StepFun**、**Kimi Coding**（配额）、**OpenRouter**、**MiniMax**、**xAI/grok**；
按 provider id（含别名）或 baseURL 家族自动匹配；`qwen-token-plan-*`（阿里云百炼）等无 API 余额接口的 Provider 显示"需登录"并提供控制台跳转链接；
其余未知 Provider 显示"不支持"。自定义余额接口可在 Provider profile 里配 `balance.endpoint` 覆盖（沿用 `dsh-balance-panel` 约定）。

密钥全程留在 Host 进程内：只按 `apiKeyEnv` 解析凭证使用，不出 Host、不下发到浏览器。
数据经回环 webServer 路由同源下发（Client `fetch` 拉取，不依赖 typert RPC，详见 [docs/session-notes.md](docs/session-notes.md)）。

### 模型设置怎么生效（0.3.0）

面板保存 → Host 经 `settings.mutate` 写入官方配置（`llm-pi-ai.providers.<route>.models[].reasoningEfforts/input/dockTags`
或 `llm-deepseek.models[]/thinking/reasoningEffort`）→ 适配器热加载（无需重启）→
**会话窗口的模型选择器重新打开后，每个模型即可选择配置的强度档**（官方链路按 `model.reasoning.efforts` 展示）。
输入类型中仅文本/图片为官方真实模态（请求路由生效）；视频/音频/文档为面板标注（持久化但不参与路由）。

> **思考兼容兜底（0.3.0 修复）**：不在 pi-ai 内置目录里的模型（如部分第三方路由模型）启用思考后，
> 适配器默认会把 system 改写成 `developer` 角色，百炼等 OpenAI 兼容端点直接 400。面板在启用思考档时
> 自动写入 `compat.supportsDeveloperRole: false`；qwen/百炼家族再补 `thinkingFormat: qwen`，与官方目录内模型一致。
> 保存时原条目上的未知字段（含用户自配 compat）原样保留，不会被面板清掉。

### 图片理解代理（0.3.1）

纯文本模型也能"看图"：在 设置 → 功能坞 → 模型设置 顶部（或弹层同页）启用**图片理解代理**并点选一个
**视觉模型**（候选 = 模型目录中支持图片输入的全部模型，跨 Provider）后：

- 发给**纯文本模型**的消息带图片时，自动先调用所选视觉模型识别，识别文本以 `[图片内容（由视觉模型 … 识别）：…]` 注入请求；
- **多模态模型不受影响**，按官方链路原样自识别；
- 识别失败自动降级（注入说明文本，不影响主请求）；同一张图 10 分钟识别缓存；
- 配置存插件自有 `dsh-dock` 命名空间，保存即热生效。

## 新增一个功能（两步）

1. 建 `features/<id>/`：
   - `view.js(x)` 导出 `feature = { id, name, order, accent, description, css, View, HomeStat? }`
     （纯客户端功能到这就够了）；
   - 需要宿主逻辑的加 `host.js` 导出 `feature = { id, name, description, defaultEnabled, setup(ctx) → disposer }`；
2. 在 `src/client.jsx` 的 `BUILTIN_FEATURES` import 一行；宿主功能再在 `index.js` 的 `FEATURES` import 一行；
   改完跑 `node scripts/build-client.mjs`。

需要从 Host 拿数据的功能：在模块 `setup(ctx)` 里用 `ctx.get('webServer').register`
注册同源路由（纯 JSON），视图 `fetch('/dsh-dock/<id>')` 拉取——密钥只进 Host，
绝不下发浏览器。详见 [docs/session-notes.md](docs/session-notes.md) 8.3。

## 提取一个功能成独立包

```sh
node scripts/extract-feature.mjs tokenlog --out ../dsh-dock-tokenlog
```

生成独立包骨架（镜像本仓库布局，模块内相对导入不变）：宿主入口、独立客户端入口
（**双形态**：装了 dsh-dock → `ctx.modules.import('dsh-dock')` 成功 → `dockBridge.register`
注册进功能坞菜单；没装 → 自己的侧栏入口 + 全屏面板）、构建脚本、`cordis.patch.yml`、`package.json`。
发布前裁剪依赖 → 构建 → 实测两种形态（含与功能坞共存时的菜单合并，独立入口应隐藏）。

## 路线图（后面要干嘛）

| 版本 | 内容 | 状态 |
| --- | --- | --- |
| **0.2.0** | 接入**模型余额**：策略表查询各 Provider 余额/配额；侧栏入口 + 功能弹层 | ✅ 已接入 |
| **0.3.0** | 接入**模型设置**：官方目录链路集成，写回热生效；弹层窗口化 | ✅ 已接入 |
| **0.4.0** | **模块化架构**（features/ 模块目录 + 客户端构建 + dockBridge 回装通道）+ 接入**用量记录**（第二菜单） | ✅ 已接入（本版） |
| **0.5.0** | 接入**任务动画**：任务进度动画、完成/卡住通知 | 纯 Client 功能模块；如需挂对话区，在模块内注册对应 slot（如 `conversation.composer.dock`） |
| **0.6.0** | 开关状态**持久化**、Host↔Client 双侧注册表打通 | 状态写入持久化服务；Host 侧开关与 Client 面板同步；外部功能包的可选依赖注册（面板不在，功能照跑） |

后续新增功能遵循同一模式：**模块目录 + 注册表一行 import**，即插即用。

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
