/**
 * dsh-dock — 插件级「预览版说明」自动确认注入契约（node scripts/test-welcome-ack.mjs）
 *
 * 背景：dsh 的欢迎确认对远程（非回环）浏览器走 memory 模式（welcome-store.ts 设计如此），
 * 确认只存页面进程内存，刷新即丢——「预览版说明」每次刷新都重弹。该问题与任何单个功能
 * 模块的职责都不重合（关掉【远程访问】、主实例直接绑 0.0.0.0 的直连形态同样重弹），
 * 所以归插件级：index.js 无条件注册 tapIndex，不随功能开关启停。
 *
 * 本测试钉三件事：
 *   1) 注入幂等且位置正确（<head> 之后）；
 *   2) 脚本自带回环短路 + 弹窗匹配 + 按钮匹配（与 dsh 文案对齐）；
 *   3) index.js 确实注册了该 tap（插件级，不在任何 feature setup 里）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectWelcomeAck, WELCOME_ACK_MARKER } from '../src/welcome-ack.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 1) 注入幂等 + 位置：<head> 开标签之后、只注入一份。
{
  const sample = '<!doctype html><html><head><meta charset="utf-8"><title>DSH</title></head><body></body></html>'
  const once = injectWelcomeAck(sample)
  assert.match(once, new RegExp(WELCOME_ACK_MARKER), '缺少自动确认脚本标记')
  const headEnd = once.indexOf('</head>')
  const at = once.indexOf(`<script ${WELCOME_ACK_MARKER}>`)
  assert.ok(at > 0 && at < headEnd, '脚本必须注入在 <head> 之后、</head> 之前')
  const twice = injectWelcomeAck(once)
  assert.equal(twice.split(WELCOME_ACK_MARKER).length - 1, 1, '注入必须幂等（重复调用只保留一份）')
  assert.equal(twice, once, '重复注入应原样返回')

  // 无 <head> 的退化页面：前置注入，不丢内容。
  const bare = injectWelcomeAck('<html><body></body></html>')
  assert.ok(bare.startsWith(`<script ${WELCOME_ACK_MARKER}>`), '无 head 页面应前置注入')
  assert.ok(bare.endsWith('</body></html>'))
}

// 2) 脚本内容契约：回环短路、弹窗与按钮文案、观察器退场。
{
  const script = readFileSync(join(root, 'src/welcome-ack.js'), 'utf8')
  assert.match(script, /__dshDockWelcomeAck/, '缺少先到先得旗标（防与未来客户端兜底双击）')
  assert.match(script, /127\.0\.0\.1/, '回环地址必须自我短路（127.0.0.1）')
  assert.match(script, /localhost/, '回环地址必须自我短路（localhost）')
  assert.match(script, /\.localhost/, '回环地址必须自我短路（*.localhost）')
  assert.match(script, /预览版说明\|Preview Notice/, '弹窗匹配必须覆盖中英文文案')
  assert.match(script, /"继续" \|\| label === "Continue"/, '按钮匹配必须覆盖中英文文案')
  assert.match(script, /DOMContentLoaded/, '注入点在 <head> 后 body 未解析，必须推迟到 DOMContentLoaded')
  assert.match(script, /60000/, '观察器必须有兜底退场（弹窗不出现时自动断开）')
}

// 3) index.js 插件级注册：不在任何 feature setup 里，无条件生效。
{
  const entry = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(entry, /from '\.\/src\/welcome-ack\.js'/, 'index.js 必须引入 welcome-ack 注入')
  assert.match(entry, /tapIndex\(injectWelcomeAck\)/, 'index.js 必须插件级注册 tapIndex（不随功能开关启停）')

  // 【远程访问】客户端半部不得再挂 Overlay 版自动确认（归属已迁插件级）。
  const relayView = readFileSync(join(root, 'features/mobile-relay/view.jsx'), 'utf8')
  assert.doesNotMatch(relayView, /MobileRelayOverlay/, '远程访问不应再有 Overlay 版自动确认（已迁插件级）')
  assert.doesNotMatch(relayView, /Overlay:/, '远程访问描述符不应再挂 Overlay 字段')
  assert.doesNotMatch(relayView, /预览版说明\|Preview Notice/, '远程访问客户端半部不应再保留弹窗匹配逻辑')
}

console.log('welcome-ack (plugin-level index tap): ok (idempotent inject, loopback self-gate, zh/en copy, entry registration)')
