// dsh-dock · 功能模块【语音朗读】· 宿主半部
//
// 职责：只做**配置持久化**。朗读本身发生在浏览器——Web Speech API 的
// speechSynthesis 是宿主页面（浏览器）的能力，声音从用户那台设备的扬声器出来；
// Node 侧既没有 speechSynthesis，也不该把会话正文搬到服务端绕一圈。
//
// RPC（webServer HTTP 路由，前缀 /dsh-dock/tts/）：
//   POST /status —— 当前朗读配置 + 会话级任务追踪快照（客户端据此触发自动朗读）
//   POST /config —— 增量更新配置字段并持久化到 settings（dsh-dock 命名空间 tts 段）
//
// 配置模型（schema 见 src/host-core.js DockConfig.tts）：
//   autoPlay / autoPlayOnFinish / interruptOnNew / rate / pitch / volume /
//   voiceURI / lang / skipCode / skipTables / maxChars / maxSentences
//
// ⚠️ voiceURI 是**设备相关**的：同一份配置在另一台机器上可能没有那个音色。
//    客户端使用前会用本机 getVoices() 校验，取不到就按语言回落（见 features/tts/view.jsx），
//    所以这里只负责原样存取，不做存在性校验（宿主也拿不到浏览器的音色表）。
import { sendJson, readBody, rejectUntrustedRequest, readDockRoot, mutateDockSection } from '../../src/host-core.js'
import { acquireTaskTracker } from '../../src/task-track.js'

/** 朗读配置字段清单（schema、默认值、增量合并三处共用同一份键名）。 */
export const TTS_FIELDS = [
  'autoPlay', 'autoPlayOnFinish', 'interruptOnNew',
  'rate', 'pitch', 'volume', 'voiceURI', 'lang',
  'skipCode', 'skipTables', 'maxChars', 'maxSentences',
]

/** 数值字段的合法区间（越界钳制，不拒绝：面板滑块与手工 POST 都可能给到边界值）。 */
const NUMERIC_RANGE = {
  rate: [0.1, 10], // 规范区间是 0.1~10，面板只开放 0.5~2
  pitch: [0, 2],
  volume: [0, 1],
  maxChars: [0, 200000],
  maxSentences: [0, 200],
}

const BOOLEAN_FIELDS = [
  'autoPlay', 'autoPlayOnFinish', 'interruptOnNew', 'skipCode', 'skipTables',
]

const STRING_FIELDS = ['voiceURI', 'lang']

function defaultConfig() {
  return {
    autoPlay: false,
    autoPlayOnFinish: true,
    interruptOnNew: true,
    rate: 1,
    pitch: 1,
    volume: 1,
    voiceURI: '',
    lang: '',
    skipCode: true,
    skipTables: true,
    maxChars: 0,
    maxSentences: 0,
  }
}

/** 读本地 Config 镜像里的 tts 配置（schema 默认值已含在 resolved 里），异常回退默认。 */
export function readTtsConfig(ctx) {
  const cfg = defaultConfig()
  try {
    const v = readDockRoot(ctx)
    const t = v && typeof v === 'object' && v.tts && typeof v.tts === 'object' ? v.tts : null
    if (t) {
      for (const key of Object.keys(cfg)) {
        if (t[key] !== undefined) cfg[key] = t[key]
      }
    }
  } catch { /* settings 未挂载，用默认 */ }
  return cfg
}

/**
 * 增量合并请求体到配置：只接受白名单字段，类型不符忽略，数值越界钳制。
 * 非法 JSON 由 readBody 抛错（400），未知字段静默忽略（面板与宿主版本可能不同步）。
 */
export function mergeTtsConfig(cfg, patch) {
  const p = patch && typeof patch === 'object' ? patch : {}
  for (const key of BOOLEAN_FIELDS) {
    if (typeof p[key] === 'boolean') cfg[key] = p[key]
  }
  for (const key of Object.keys(NUMERIC_RANGE)) {
    if (typeof p[key] === 'number' && Number.isFinite(p[key])) {
      const [lo, hi] = NUMERIC_RANGE[key]
      cfg[key] = Math.min(hi, Math.max(lo, key === 'maxSentences' || key === 'maxChars' ? Math.round(p[key]) : p[key]))
    }
  }
  for (const key of STRING_FIELDS) {
    if (typeof p[key] === 'string') {
      // voiceURI/lang 是浏览器给的标识串，限长即可；不解析、不访问网络
      cfg[key] = p[key].trim().slice(0, 200)
    }
  }
  return cfg
}

export const feature = {
  id: 'tts',
  name: '语音朗读',
  description: '把会话回复读出来（浏览器语音合成 TTS）：回合结束在会话下方点喇叭播放，也可设置自动朗读',
  defaultEnabled: false,
  setup(ctx) {
    const disposers = []
    const dispose = () => {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        try { if (typeof fn === 'function') fn() } catch { /* 停用清理失败不阻断 */ }
      }
    }

    // 会话级任务追踪（与【任务动画】【任务通知】【运行状态】共享一份）：
    // 自动朗读的触发源——浏览器侧轮询 /status，看到新出现的结束记录（带 lastText）就读。
    const lease = acquireTaskTracker(ctx)
    disposers.push(() => lease.release())
    const tracker = lease.tracker

    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/tts',
        async handler(req, res) {
          if (rejectUntrustedRequest(ctx, req, res)) return
          try {
            const url = new URL(req.url || '/', 'http://dsh.internal')
            const method = url.pathname.replace(/^\/dsh-dock\/tts\/?/, '').split('/')[0] || ''
            const payload = await readBody(req)

            if (method === 'status') {
              return sendJson(res, 200, {
                ok: true,
                data: Object.assign({}, tracker.snapshot(Date.now()), { config: readTtsConfig(ctx) }),
              })
            }

            if (method === 'config') {
              const cfg = mergeTtsConfig(readTtsConfig(ctx), payload)
              try {
                await mutateDockSection(ctx, ['tts'], cfg)
              } catch (e) {
                const err = new Error('保存配置被拒绝：' + ((e && e.message) || String(e)))
                err.statusCode = 400
                throw err
              }
              return sendJson(res, 200, { ok: true, data: { config: cfg, savedAt: Date.now() } })
            }

            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } })
          } catch (e) {
            const status = e && e.statusCode ? e.statusCode : 500
            console.error('[dsh-dock] tts HTTP error:', status, e && e.message)
            return sendJson(res, status, {
              ok: false,
              error: { code: status >= 500 ? 'internal' : 'bad-request', message: (e && e.message) || String(e) },
            })
          }
        },
      }), 'dsh-dock tts: /dsh-dock/tts HTTP route')
    }))

    return dispose
  },
}
