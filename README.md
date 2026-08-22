# dsh-dock · 功能坞

[![npm version](https://img.shields.io/npm/v/dsh-dock)](https://www.npmjs.com/package/dsh-dock)
[![license](https://img.shields.io/npm/l/dsh-dock)](LICENSE)

**DeepSeek Harness 功能坞插件**：用一张管理面板，统一注册、开关所有小功能。

模型余额、用量记录、模型设置、图片理解代理……这些散落的小功能，全部收进一个「功能坞」：
每个功能是独立模块，有注册表、有开关、有错误隔离。新功能按模块追加，老功能互不牵连。

![功能坞首页总揽](screenshots/dock-home.png)

---

## 功能一览

| 功能 | 说明 |
|---|---|
| **用量记录** | 记录全部 LLM API 调用：秒级时间筛选、Token/费用统计（峰谷计价 + 官网价目自动同步）、分组汇总、明细检索与 CSV 导出 |
| **模型设置** | 编辑各 Provider 模型目录：输入类型（文本/图片 + 标注）与思考强度档位；写回官方配置热生效 |
| **模型余额** | 展示所有模型 Provider 账户余额（5 分钟自动刷新） |
| **图片理解代理** | 图片识别等（visionproxy） |
| **心跳监视 / 主题信息** | 示例功能（纯 Client） |

**会话区随身小控件**：启用后，在会话输入区工具行（模型选择器左侧）显示——

- **模型余额**：当前选中 Provider 的账户余额（跟随模型切换实时更新），点击打开功能坞并定位到该 Provider 的余额详情；
- **用量记录**：当前会话的总 Token 与估算花费（10 秒静默刷新），点击打开功能坞并跳转到该会话的用量记录。

![会话区余额/用量小控件](screenshots/dock-chips.png)

勾选「启用」即显示，点芯片跳转；每个功能可在面板页脚或设置页单独设置「会话页显示/隐藏」。

## 界面

点击侧栏底部「功能坞」按钮，弹出功能面板：左侧导航 = 首页总揽 + 各功能模块，右侧内容区。

![用量记录页](screenshots/dock-tokenlog.png)

面板支持最大化 / 最小化 / 还原、标题栏拖动、右下角缩放。

---

## 安装

dsh-dock 是 DeepSeek Harness（dsh）的插件，通过 dsh 的插件市场安装：

```bash
# 在 dsh 配置中启用插件（或通过 dsh 插件命令）
npx @deepseek-ai/dsh plugin add dsh-dock
```

或手动在 dsh 的 `cordis.patch.yml` 中声明后重启。

要求：DeepSeek Harness 环境（dsh），Node.js 18+。

## 使用方法

1. 启动 dsh：`npx @deepseek-ai/dsh web`
2. 打开左侧边栏底部的 **功能坞** 按钮
3. 在 **设置 → 功能坞** 面板中启用/停用各功能模块
4. 每个功能页内可进行具体操作（余额查询、用量统计、模型目录编辑等）

> 功能开关为浏览器内存态，刷新页面后重置（持久化在规划中）。

## 开发：新增一个功能模块

每个功能是一个 `features/<id>/` 目录，由两部分组成：

```
features/<id>/
  host.js        # 宿主半部：注册 RPC 路由 / 定时任务（纯 ESM，零构建）
  view.js(x)     # 客户端视图：渲染面板内容（自带样式，CSS 类名带前缀隔离）
```

在视图模块导出功能描述符：

```js
export const feature = {
  id: "my-feature",
  name: "我的功能",
  order: 160,              // 菜单排序（首页固定第一，数值越大越靠后）
  accent: "#22c55e",       // 品牌色
  description: "…",
  css: "…",
  View: MyView,            // 面板内容组件，收到 { ctx, feature, params }
  HomeStat: MyStat,        // 可选：首页总揽卡片统计
  Chip: MyChip,            // 可选：会话输入区小控件
};
```

外壳只做组装：宿主半部在 `index.js` 注册，客户端在外壳 `src/client.jsx` 装配。
每个模块可整体拎出单独打包发布（`scripts/extract-feature.mjs` 生成独立包骨架，
独立包装回后经 **dockBridge** 注册回功能坞菜单）。

## 许可

[MIT](LICENSE)