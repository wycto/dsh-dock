# MCP 管理模块（features/mcpconfig）

面板里统一管理 DSH 使用的 MCP 服务器。DSH 自身没有 MCP 配置界面（只有 YAML 配置项 +
`plugin_manager`），此前要加一台 MCP 服务器只能手改 `cordis.patch.yml` 或让 agent 走
plugin_manager。本模块补上这块。

## 真相源与边界

- **真相源**：当前 profile 的 `cordis.patch.yml`（`ctx.get('profileContext').patchPath`）。
- **托管块**：本模块只在文件末尾维护一段带标记的机器块：

  ```yaml
  # >>> dsh-dock MCP manager (machine-managed; do not edit by hand)
  - insert:
      - id: dock-mcp-<serverName>
        name: '@deepseek-ai/dsh-mcp-client'
        config: { serverName, transport, … }
  # <<< dsh-dock MCP manager
  ```

  用户手写的行、注释、`!!js` 表达式一律不动（解析用带 `!!js` 自定义 tag 的 YAML schema，
  写盘只替换托管块文本；空列表时整块移除）。
- **只认自己写的行**：其它区段里手写的 `@deepseek-ai/dsh-mcp-client` 行不受影响；若
  serverName / 行 id 与其冲突，保存时报错而不是覆盖。

## 生效链路

1. 校验整份服务器列表（serverName 正则/唯一、transport 必填项、env 名、url 协议、与手写行冲突）；
2. 同目录临时文件 + `rename` 原子写（0600），写后自检解析与行数；
3. `ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile(ids))` 原地重组合：
   - 新增行 → import 并启动，工具以 `mcp__<serverName>__<tool>` 出现；
   - 修改行 → 只重启该行（工具短暂消失后回来）；
   - 删除/停用 → dispose 工具、关子进程。
4. **失败回滚**：把写盘前的文本写回并再 reconcile 一次；回滚失败会在面板明说需要人工检查。
5. 无 HMR 的 profile：只保存并返回 `restartRequired`，面板提示「需重启 DSH 生效」。

启停用行上的 `disabled: true`（loader 原生语义），不删除行——下次启用直接改回来。

## 接口

`GET /dsh-dock/mcpconfig`

```json
{ "ok": true, "patchPath": "…", "hmrAvailable": true,
  "servers": [{ "serverName": "xiaomi_ocr", "transport": "stdio", "enabled": true,
                "state": "active", "error": null,
                "tools": ["mcp__xiaomi_ocr__ocr_image"], "toolCount": 1 }],
  "warnings": [] }
```

`POST /dsh-dock/mcpconfig`（`{ action: "save", servers: [...] }`，全量列表）→
`{ ok, changed, applied, restartRequired?, warnings? }`；失败 4xx + `{ error, rolledBack?, needsRestart? }`。

状态来自 `ctx.get('loader').entries()`（disabled / fiber 状态）与 `ctx.get('tools').definitions()`
（按 `mcp__<server>__` 前缀数工具），不重新解析文件。

## 自测

```bash
node scripts/test-mcpconfig-host.mjs     # 托管块读写/校验/回滚/无 HMR/冲突
node scripts/test-client-views.mjs       # 含「MCP 管理渲染正常」烟测
```

## 已知边界

- profile 未启用 HMR 时不能即时生效（只能保存 + 提示重启）。
- 修改 serverName 等于删旧建新：模型看到的工具名会整组变化。
- 本模块不管理其它区段里手写的 mcp-client 行（也不会删它们）。
- 服务器配置（含 env）明文写在 profile patch 里（文件 0600）；密钥建议仍走 `!!js process.env.*`。
