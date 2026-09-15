# 分享 dsh-dock 到官方社区 · 操作清单与文案

用途：把 dsh-dock 发到 DeepSeek Harness 官方的 **Show Your Plugins** 讨论区，让用 dsh 的人看见它。
官方不收 Issue、不收 PR，**Discussions 是唯一的分享/反馈入口**（见官方 README 的 Community and support 一节）。

---

## 一、怎么发（3 步，约 2 分钟）

1. 打开这个链接（已带好分类，别再手动选分类）：

   https://github.com/deepseek-ai/deepseek-harness/discussions/new?category=show-your-plugins

2. 标题填下面「帖子标题」，正文整段复制下面「帖子正文」（从 `dsh-dock` 那行开始到英文段结束）。

3. 点 **Start discussion** 发布。发完把链接记一下，后面 README 里可以挂「社区讨论」入口。

> 想再扩大一点曝光：官方还提到了 Discord（https://discord.gg/Ycq5dCaS4），
> 以及给仓库加 `dsh-plugin` topic（**dsh-dock 已经加了**，见文末核对表）。

---

## 二、帖子标题

```
dsh-dock · 功能坞：用一张面板把散落的 dsh 小功能收进来（用量记账 / 19 种任务动画 / 任务通知 / 远程访问 / 10 款小游戏）
```

---

## 三、帖子正文（整段复制）

**dsh-dock** 是我给 DeepSeek Harness 写的一个「功能坞」插件：侧栏底部一个入口，弹出面板，把平时散落各处的小功能统一注册、开关、隔离错误。

装它只要一条命令：

```sh
dsh plugin --profile web add dsh-dock
```

（npm 包 `dsh-dock`，仓库 https://github.com/wycto/dsh-dock，MIT）

### 它做了什么

| 功能 | 说明 |
|---|---|
| **用量记录** | 记录全部 LLM API 调用：秒级时间筛选、Token/费用统计、分组汇总、明细检索与 CSV 导出。**可以按模型填自己的真实单价**（支持多段分时价，比如跨零点的峰谷价），官网刊例价只作兜底 |
| **模型设置** | 编辑各 Provider 的模型目录：输入类型（文本/图片 + 标注）、思考强度档位，写回官方配置热生效 |
| **模型余额** | 所有 Provider 账户余额一览，5 分钟自动刷新 |
| **任务动画** | 19 种任务运行动画（星际远征、星云潮汐、曲速航道、量子雷达……），速度随任务活动联动；含一个桌面伙伴 3D 场景 |
| **任务通知** | 任务完成 / 异常 / 需确认：页内卡片、6 种提示音、浏览器系统通知、钉钉 & 飞书群机器人推送（宿主直发，浏览器关着也能推） |
| **运行状态** | 进行中任务的阶段 / 耗时 / 回合 / 步骤 / 工具 / Token，等待确认提醒，最近完成记录 |
| **图片理解代理** | 用视觉模型识图（默认关闭，需手动开启） |
| **远程访问** | 账号密码登录的网关：手机/平板/局域网设备访问同一个 DSH 实例，会话与任务进度实时一致（主实例仍只监听 127.0.0.1，不裸奔） |
| **趣味游戏** | 10 款小游戏（五子棋、中国象棋、俄罗斯方块、推箱子、贪吃蛇、打砖块、极速赛车、坦克大战、星际躲避、反应堆解谜），浮动窗口不遮挡会话 |

另外两个我自己最常用的细节：

- **会话区随身小控件**：模型选择器左侧显示当前 Provider 余额、当前会话的 Token 与花费；点一下就跳到面板对应页。
- **功能全部可单独开关、错误隔离**：一个功能炸了不影响其他功能，也不影响 dsh 本体。

### 截图

![功能坞首页](https://raw.githubusercontent.com/wycto/dsh-dock/main/screenshots/dock-home.png)

![用量记录](https://raw.githubusercontent.com/wycto/dsh-dock/main/screenshots/dock-tokenlog.png)

![任务动画与桌面伙伴](https://raw.githubusercontent.com/wycto/dsh-dock/main/screenshots/dock-animation.png)

（仓库 `screenshots/` 里还有通知、运行状态、模型设置、余额、游戏等 9 张图。）

### 一点实现说明

- 每个功能是 `features/<id>/` 下的独立模块（`host.js` 宿主半部 + `view.js(x)` 客户端视图），经插件自带的注册表挂载，**可以单独提取成包发布，也能再装回面板**；
- 宿主半部是纯 ESM，客户端视图零构建产物依赖；
- 目前跑在 dsh `0.1.5-rc.1`（Windows + WSL2 环境日常使用），版本迭代记录见 [CHANGELOG](https://github.com/wycto/dsh-dock/blob/main/CHANGELOG.md)。

### 反馈

有任何问题、想法，或者想加的功能，欢迎直接在这里回帖，也可以到仓库开 Issue：
https://github.com/wycto/dsh-dock/issues

---

**English tl;dr** — `dsh-dock` is a panel-style plugin for DeepSeek Harness that registers, toggles and error-isolates all the small features around your agent sessions: LLM usage accounting with custom per-model pricing, model config editor, account balances, 19 task-running animations, task notifications (system + DingTalk/Feishu), run-state inspector, image-understanding proxy, password-protected remote access, and 10 mini-games. Install with `dsh plugin --profile web add dsh-dock`; repo: https://github.com/wycto/dsh-dock (MIT).

---

## 四、GitHub 仓库 About 描述（可直接粘贴）

你现在仓库的简介还停留在早期版本（"0.1.0 为基础框架，功能接入按 README 路线图迭代"），和 0.11.2 的实际内容已经对不上了。改成：

**Description（About 框里那个简介）：**

```
dsh-dock · DeepSeek Harness 功能坞插件：一张面板统一注册/开关所有小功能——用量记账（自定义单价·分时价）、模型设置与余额、19 种任务动画、任务通知（钉钉/飞书）、运行状态、图片理解代理、账号密码远程访问、10 款小游戏。每个功能独立模块，可开关、错误隔离、即插即用。
```

**Website（About 右侧那个链接）：**

```
https://www.npmjs.com/package/dsh-dock
```

> 也可以留着仓库地址；但既然 npm 是安装入口，把 Website 指到 npm 页更实用。

**Topics 核对表**（点 About 右上齿轮 → Topics）：

- [x] `dsh-plugin` ← 官方 README 明确要求加这个，加了才会出现在
      https://github.com/topics/dsh-plugin 里被检索到（**你的仓库已经有了**）
- [x] `dsh`
- [x] `cordis`
- [x] `ai-agents`
- [ ] 可选再加：`deepseek-harness`、`llm`、`agent`、`plugin`

---

## 五、已经做完的部分（不用再管）

| 项目 | 状态 |
|---|---|
| npm 发布 | ✅ `dsh-dock` 已发布，`latest` = 0.11.2 |
| GitHub 仓库公开 | ✅ https://github.com/wycto/dsh-dock |
| `dsh-plugin` topic | ✅ 已加（官方指定的生态检索方式） |
| README 安装说明 + 截图 | ✅ 已有，且已去掉重复副本 |
| LICENSE | ✅ MIT |

**以后每发一个版本**，只要保持两件事：`npm publish`（版本号三处一致：`package.json` / `DOCK_VERSION` / git tag），
以及按 `docs/workflow.md` 的规矩把开发历史压成一条发版提交推到 `github` 远端。
