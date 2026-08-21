# 会话总结与决策记录（2026-08-21）

> 给后续 DSH 会话的交接文档：新会话继续完善本项目前，先读本文件 + README。

## 一、本项目是什么

`dsh-dock` —— DeepSeek Harness 功能中枢插件。一张管理面板统一注册、开关所有小功能（模型余额、Token 用量记录、任务动画，以及未来任意新功能）。已发布 npm：**dsh-dock@0.1.0**（maintainer: wycto）。

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
| v0.1.0 只带示例功能（心跳/主题），三个真实功能为规划占位 | 基础框架先行验证，功能接入按路线图逐步做 |
| npm 包名 `dsh-dock`（无作用域） | 用户拍板；已发布即占用，勿改 |

## 四、当前状态快照

- npm：`dsh-dock@0.1.0` latest ✔（https://www.npmjs.com/package/dsh-dock）
- 运行环境：本地 link 安装的仍是旧 `dsh-feature-hub`（设置页可见「功能中枢」，含心跳/主题示例），`dsh-dock` npm 版**尚未安装**
- 代码源：本仓库（gitea `main`）+ 发布源副本 `/Users/weiyi/develop/test/dsh-dock`
- 发布脚本：`scripts/publish.sh`（含登录检查、--cache 绕坑）

## 五、下一步（按顺序）

1. **本地替换验证**：`dsh plugin --profile web remove dsh-feature-hub` → `dsh plugin --profile web add dsh-dock`，确认 npm 版面板正常（设置 → 功能中枢）。
2. **0.2.0 模型余额**：`index.js` 的 `hostSetups.balance` 实现余额拉取；打通 Client↔Host（typert）；`client.js` balance 占位换真实视图。可参考 `@wycto/dsh-balance-panel` 的既有实现。
3. **0.3.0 Token 用量**：`hostSetups.tokenlog` 监听事件记账 + 统计视图。
4. **0.4.0 任务动画**：纯 Client 模块，可注册对话区 slot。
5. **0.5.0 持久化**：开关状态落盘。
6. **GitHub 发版**：建 `wycto/dsh-dock`（GitHub）→ `package.json` repository 改实际地址 → 发布 0.1.1+ → tag 发 Release。

## 六、环境备忘（踩过的坑）

- **npm 缓存 EPERM**：`~/.npm` 有 root 属主历史文件。绕过：`CACHE_DIR=/tmp/dsh-dock-npm-cache ./scripts/publish.sh`；根治：`sudo chown -R 501:20 ~/.npm`。
- **registry 读取一致延迟**：`npm publish` 成功后立刻 curl 可能 404，等几秒重试即 200，非失败。
- **沙箱**：gitea 目录在会话工作区外，本会话已由用户开放全权限写入。
- **git 身份**：本仓库需设置 `user.name`/`user.email`（本机无全局身份），用 wycto。
- **typert 联通**：静态 bundle 下 Client↔Host 的私有 RPC 走 typert 服务，接入 0.2.0 时先查其子系统页面签名，不要照搬动态插件的 `harness.handle`。

## 七、命名与生态备忘

- 现有功能包家族：`@wycto/dsh-balance-panel`、`@wycto/dsh-token-usage`、`@wycto/dsh-task-pulse`
- 面板包：`dsh-dock`；后续新功能包建议 `@wycto/dsh-<功能名>` 或吸收为 dock 内模块
- `dsh-hub` 无作用域名已被他人占位（0.0.1），勿用