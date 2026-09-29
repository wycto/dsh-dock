// dsh-dock · settings.yaml.imported 全量恢复（migrateImportedSections）单测
//
// 背景：dsh 升级会把 ~/.dsh/settings.yaml 改名为 settings.yaml.imported 并尝试把各段
// 导入 profile——当时 dsh-dock 还没导出 Config → 整段导入失败，账号（remoteAuth）等
// 配置停在 imported 文件里；此前只补迁 features，远程访问因此「账号丢失、网关开不起来」。
//
// 本用例锁死恢复语义：
//   ① 现网仍等于 schema 缺省的段 → 整段恢复；
//   ② 现网有用户改动的段（如单价 tokenlog）→ 一律不覆盖；
//   ③ features 逐键补缺，已有键不覆盖；
//   ④ 置 importedRestored 标记，第二次执行零写入（幂等）；
//   ⑤ 旧 animation 段里的 notify 字段原样搬回（随后 migrateNotifyConfig 才能接得住）。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DockConfig, migrateImportedSections, readDockRoot, DOCK_NS } from '../src/host-core.js'

// DSH_HOME 指到临时目录（绝不触碰真实 ~/.dsh）。
const home = mkdtempSync(join(tmpdir(), 'dsh-dock-import-test-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
writeFileSync(join(home, 'settings.yaml.imported'), [
  `${DOCK_NS}:`,
  '  visionProxy:',
  '    enabled: true',
  '    provider: motai',
  '    model: Qwen/Qwen3.8-27B',
  '  animation:',
  '    animationEnabled: true',
  '    effectMode: space',
  '    robotScale: 1.77',
  '    notifyOnComplete: true',
  '    dingtalkEnabled: true',
  '  remoteAuth:',
  '    username: alice',
  '    salt: deadbeef',
  '    passwordHash: cafebabe',
  '  notify:',
  '    notifyOnComplete: true',
  '    dingtalkEnabled: true',
  '    migratedFromAnimation: true',
  '  features:',
  '    modelconfig: true',
  '    tokenlog: true',
  '    mobile-relay: true',
  '    balance: true',
  '  tokenlog:',
  '    usdCnyRate: 7.2',
  '    pricing:',
  '      - match: stale-model',
  '        input: 1',
  '        output: 2',
  '',
].join('\n'), 'utf8')

// settings 桩：现网（live）已带一份「用户后来改过」的 tokenlog 与一个已有 features 键。
const live = {
  features: { modelconfig: false, balance: true },
  tokenlog: { usdCnyRate: 6.5, pricing: [{ match: 'live-model', input: 3, output: 4 }] },
}
let writes = 0
const ctx = {
  get(key) {
    if (key !== 'settings') return undefined
    return {
      get(ns) { return ns === DOCK_NS ? JSON.parse(JSON.stringify(live)) : undefined },
      async mutate(ns, ops) {
        assert.equal(ns, DOCK_NS)
        for (const op of ops) {
          assert.equal(op.op, 'set')
          live[op.path[0]] = JSON.parse(JSON.stringify(op.value))
          writes++
        }
      },
    }
  },
}

await migrateImportedSections(ctx)

// ① 现网缺省段整体恢复
assert.equal(readDockRoot(ctx).remoteAuth.username, 'alice')
assert.equal(readDockRoot(ctx).remoteAuth.passwordHash, 'cafebabe')
assert.equal(readDockRoot(ctx).visionProxy.model, 'Qwen/Qwen3.8-27B')
assert.equal(readDockRoot(ctx).notify.dingtalkEnabled, true)
assert.equal(readDockRoot(ctx).animation.effectMode, 'space')
assert.equal(readDockRoot(ctx).animation.robotScale, 1.77)
// ⑤ animation 段里的旧通知字段按 schema 白名单丢弃（整段写会被 mutate 校验拒绝），
//    完整通知配置由 notify 段恢复承接——断言两边一丢一得。
assert.equal(readDockRoot(ctx).animation.notifyOnComplete, undefined, 'animation 段不再携带旧通知字段')
assert.equal(readDockRoot(ctx).notify.notifyOnComplete, true)

// ② 现网有改动的段不被覆盖
assert.equal(readDockRoot(ctx).tokenlog.usdCnyRate, 6.5)
assert.equal(readDockRoot(ctx).tokenlog.pricing[0].match, 'live-model')

// ③ features 逐键补缺（现网改过的 modelconfig 不回退，缺的补上）
assert.equal(readDockRoot(ctx).features.modelconfig, false, '现网已有键不得被覆盖')
assert.equal(readDockRoot(ctx).features.tokenlog, true, '缺失键从 imported 补齐')
assert.equal(readDockRoot(ctx).features['mobile-relay'], true)

// ④ 标记落盘
assert.equal(readDockRoot(ctx).importedRestored, true)

// 幂等：第二次执行零写入
const before = writes
await migrateImportedSections(ctx)
assert.equal(writes, before, '第二次执行必须零写入（importedRestored 标记生效）')

console.log('legacy import: ok (缺省段恢复 + 现网段保护 + features 补缺 + 幂等标记)')
