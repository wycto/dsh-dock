// dsh-dock · 功能模块【图片理解代理】· 宿主半部（v0.3.1 迁自 index.js，行为不变）
//
// 纯文本模型收到图片时，自动调用配置的视觉模型识别图片，
// 把识别文本替换进请求（多模态模型不受影响，原样自识别）。
// 拦截点：官方 llm/stream 瀑布流不允许改写 frozen 请求、registerAdapter 拒绝重复注册，
// 故对 llm.stream / llm.prepareCall 做方法级包装（保存原函数，dispose 恢复）。
// 配置存自有 settings 命名空间 dsh-dock（visionProxy: enabled/provider/model），
// 其编辑 UI 在模型设置页内（见 features/modelconfig/view.js）。
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { DOCK_NS } from '../../src/host-core.js'
import { readModelDirectory } from '../modelconfig/host.js'

/** 递归判断内容块里是否有图片（含 tool-result 嵌套，与官方 contentHasImage 同构）。 */
function contentHasImageDeep(content) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block && block.type === 'image') return true
    if (block && block.type === 'tool-result' && contentHasImageDeep(block.content)) return true
  }
  return false
}

/**
 * 用户在 dsh-dock 模型设置里勾选「图片」后的声明。
 * 这不是联网探测结果，而是明确让用户决定端点能力：声明后原图直发，
 * 未声明时才继续参考运行时目录或走图片理解代理。
 */
function hasUserDeclaredImage(directory, provider, model) {
  const p = (directory.providers || []).find((x) => x && x.id === provider)
  const m = p && Array.isArray(p.models) ? p.models.find((x) => x && x.id === model) : undefined
  return !!(m && Array.isArray(m.input) && m.input.includes('image'))
}

/** 让视觉模型描述一张图片，返回识别文本（失败抛错）。 */
async function describeImage(deps, cfg, block, signal) {
  const prompt = '请用中文详细描述这张图片的内容：主体、文字（若有则逐字转写）、数据/图表要点、与编码任务相关的细节。控制在 300 字以内，直接输出描述，不要客套。'
  // 单次识别调用：返回文本（可为空串，由调用方决定重试），失败抛错。
  // ⚠️ 不带 sessionId：llm/stream 的会话检查点监听对带 sessionId 的调用先做检查点，
  // 回合进行中会 fail-closed 短路适配器。
  // ⚠️ 走 prepareCall 通道而非 llm.stream：llm/stream 公共路径对带图请求实测会被
  // 截断（单 block-start 后静默结束，两种适配器均然，端点直连正常）；agent-loop 的
  // 带图请求全部经 prepareCall().stream() 且工作正常，此处同通道。
  // prepareCall(config).stream(options) 要求 options 与 config 在 provider/model/
  // reasoningEffort/maxTokens 等请求控制字段上完全一致，故两处同源构造。
  const run = async (effort) => {
    const config = { provider: cfg.provider, model: cfg.model, maxTokens: 4096 }
    if (effort) config.reasoningEffort = effort
    const prepared = await deps.prepareCall(config, signal)
    // options 必须与 resolvedConfig 完全一致（callConfigEquals），以 prepared.config 为底
    const options = Object.assign({}, prepared.config, {
      messages: [{
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-dock' },
        content: [block, { type: 'text', text: prompt }],
      }],
      // 递归保护：本请求由代理发起，包装层直接放行
      dockVisionProxy: true,
    })
    if (signal) options.signal = signal
    const assembler = new BlockAssembler()
    for await (const chunk of prepared.stream(options)) {
      assembler.push(chunk)
      // ⚠️ BlockAssembler.finish 是 getter，未收到 finish chunk 时也返回 {kind:'stop'}
      // （恒真值）——只能用 chunk.type 判断，用 assembler.finish 当条件会在第一个
      // chunk 后就 break，识别永远为空（2026-08-22 排查一下午的根因）。
      if (chunk && chunk.type === 'finish') break
    }
    if (assembler.finish && assembler.finish.kind === 'error') {
      throw new Error(String(assembler.finish.failure?.message || '视觉模型调用失败'))
    }
    return assembler.blocks()
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
  }
  // 识别是辅助调用，求快：先试关思考（off）；报不支持或返回空内容都回退默认档重试
  let text
  try {
    text = await run('off')
  } catch (e) {
    if (!(e instanceof Error && /does not support reasoning effort|UNSUPPORTED_REASONING_EFFORT/i.test(e.message))) {
      throw e
    }
  }
  if (!text) text = await run(undefined)
  if (!text) throw new Error('视觉模型没有返回文本')
  return text
}

/**
 * 识别结果缓存（attachmentId + 视觉模型 → 文本）。
 * 端点对连续识图有节流（实测第 ~6 次起掐流成单个 block-start）；agent 每轮
 * 重试/多步都会带着历史图片重发请求，逐图重识别既慢又会撞限流——同一张图
 * 10 分钟内只识别一次，失败不缓存。
 */
const describeCache = new Map()
const DESCRIBE_CACHE_TTL = 10 * 60 * 1000
const DESCRIBE_CACHE_MAX = 64

function cacheKey(cfg, block) {
  return `${cfg.provider}/${cfg.model}:${block && block.attachment ? block.attachment.attachmentId : ''}`
}

function cacheGet(key) {
  const hit = describeCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > DESCRIBE_CACHE_TTL) {
    describeCache.delete(key)
    return undefined
  }
  return hit.text
}

function cacheSet(key, text) {
  if (describeCache.size >= DESCRIBE_CACHE_MAX) {
    const oldest = describeCache.keys().next().value
    describeCache.delete(oldest)
  }
  describeCache.set(key, { text, at: Date.now() })
}

/**
 * 请求改写：目标是纯文本模型且带图片时，逐图调用视觉模型，图片块替换为识别文本。
 * 任何失败都只降级（保留原图或占位说明），绝不阻断主请求。
 * @returns 改写后的 options（无需改写时原样返回）
 */
async function transformForVisionProxy(deps, options) {
  const cfg = deps.config()
  const log = (msg) => { try { console.log('[dsh-dock] visionproxy ' + msg) } catch { /* 日志失败不影响主流程 */ } }
  try {
    if (!cfg || !cfg.enabled || !cfg.provider || !cfg.model) return options
    if (!options || typeof options !== 'object') return options
    if (options.dockVisionProxy) return options
    if (options.provider === cfg.provider && options.model === cfg.model) return options
    if (options.purpose) return options // 内部辅助调用（如会话标题）不代理
    if (!Array.isArray(options.messages)) return options
    if (!options.messages.some((m) => m && contentHasImageDeep(m.content))) return options
    log(`带图请求 ${options.provider}/${options.model}`)

    // 图片能力判定的优先级：用户在模型设置里勾选「图片」优先。
    // 运行时目录只是自动提示，无法识别或识别错误时不能覆盖用户的明确决定。
    // 这让 kimi-k2.7-code 等端点可由用户声明多模态并原图直发；若端点实际不支持，
    // 上游会返回错误，用户取消勾选即可恢复走图片理解代理。
    const directory = deps.directory()
    if (hasUserDeclaredImage(directory, options.provider, options.model)) {
      log(`跳过 ${options.provider}/${options.model}：用户已声明图片能力（原图直发）`)
      return options
    }

    // 未声明时再问运行时（llm.resolveModelInfo，与官方投影同源：
    // entry.input → 内置目录 → 路由默认）；旧宿主无此方法或单次解析失败时，
    // 保守走图片理解代理，避免猜错端点能力。
    let imageCapable
    try {
      const info = deps.resolveModelInfo ? await deps.resolveModelInfo(options.provider, options.model) : undefined
      if (info && Array.isArray(info.inputModalities)) imageCapable = info.inputModalities.includes('image')
    } catch {
      // 落到目录回退
    }
    if (imageCapable) {
      log(`跳过 ${options.provider}/${options.model}：运行时判定多模态（原图直发）`)
      return options
    }

    let changed = false
    const replaceBlocks = async (blocks) => {
      const next = []
      for (const block of blocks) {
        if (block && block.type === 'image') {
          changed = true
          const key = cacheKey(cfg, block)
          const cached = cacheGet(key)
          if (cached !== undefined) {
            log('命中识别缓存')
            next.push({ type: 'text', text: `[图片内容（由视觉模型 ${cfg.provider}/${cfg.model} 识别）：${cached}]` })
            continue
          }
          try {
            const desc = await describeImage(deps, cfg, block, options.signal)
            cacheSet(key, desc)
            log(`识别成功 ${desc.length} 字`)
            next.push({ type: 'text', text: `[图片内容（由视觉模型 ${cfg.provider}/${cfg.model} 识别）：${desc}]` })
          } catch (e) {
            // 识别失败：降级为说明文本，官方投影不会再把请求打挂
            log(`识别失败：${e instanceof Error ? e.message : String(e)}`)
            next.push({ type: 'text', text: `[图片未能识别（${e instanceof Error ? e.message : String(e)}），已省略]` })
          }
          continue
        }
        if (block && block.type === 'tool-result' && contentHasImageDeep(block.content)) {
          next.push(Object.assign({}, block, { content: await replaceBlocks(block.content) }))
          continue
        }
        next.push(block)
      }
      return next
    }
    const messages = []
    for (const msg of options.messages) {
      if (msg && contentHasImageDeep(msg.content)) {
        messages.push(Object.assign({}, msg, { content: await replaceBlocks(msg.content) }))
      } else {
        messages.push(msg)
      }
    }
    return changed ? Object.assign({}, options, { messages }) : options
  } catch {
    return options // 总兜底：代理自身异常不影响主请求
  }
}

/** 安装 llm 方法包装：stream 与 prepareCall 两条入口都过一遍图片代理改写。 */
function installVisionProxy(ctx, directory) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function' || typeof llm.prepareCall !== 'function') {
    throw new Error('llm 服务不可用，无法安装图片理解代理')
  }
  // 原函数先绑定保存：改写判定与识别调用都走原函数，不受包装影响
  const origResolve = typeof llm.resolveModelInfo === 'function' ? llm.resolveModelInfo.bind(llm) : null
  if (origResolve) llm.__dockOrigResolveModelInfo = origResolve
  const origPrepareCall = llm.prepareCall.bind(llm)
  const deps = {
    config: () => {
      try {
        const settings = ctx.get('settings')
        const v = settings && typeof settings.get === 'function' ? settings.get(DOCK_NS) : undefined
        return v && v.visionProxy ? v.visionProxy : { enabled: false, provider: '', model: '' }
      } catch {
        return { enabled: false, provider: '', model: '' }
      }
    },
    // 识别调用走保存的原函数：天然绕开包装层，无递归
    stream: (options) => llm.__dockOrigStream(options),
    // 识别调用走原 prepareCall 通道（带图请求的被验证路径）
    prepareCall: origPrepareCall,
    // 运行时模型信息查询（图片能力判定与官方投影同源）；旧宿主无此方法时为 null
    resolveModelInfo: origResolve,
    directory,
  }
  llm.__dockOrigStream = llm.stream.bind(llm)
  const origPrepare = llm.prepareCall
  llm.stream = (options) => (async function* () {
    yield* llm.__dockOrigStream(await transformForVisionProxy(deps, options))
  })()
  llm.prepareCall = async (config, signal) => {
    const prepared = await origPrepare.call(llm, config, signal)
    // prepared 是冻结对象：浅拷贝后包一层 stream，dispatched 一次性约束经原闭包保持。
    // ⚠️ stream 必须同步返回 AsyncIterable：消费方 `for await (of stream)` 不接受
    // Promise（Node 语义：of 表达式直接取 Symbol.asyncIterator），async 包装会令
    // 全部请求报 "stream is not async iterable"（2026-08-22 事故）。
    return Object.assign({}, prepared, {
      stream: (options) => (async function* () {
        yield* prepared.stream(await transformForVisionProxy(deps, options))
      })(),
    })
  }
  // 虚拟多模态：代理启用时，纯文本模型对外宣称支持图片，让官方带图准入放行——
  // apiproxy 的 prompt 收图校验、mcp-client/tool-fs 的图片声明检查都查
  // llm.resolveModelInfo 的 inputModalities；图片真正到端点前会被 stream/prepareCall
  // 包装层替换为识别文本。视觉模型自身与多模态模型不受影响；官方内部投影不走
  // 此公共方法，truth 不变。
  if (origResolve) {
    llm.resolveModelInfo = async (provider, model, signal) => {
      const info = await origResolve(provider, model, signal)
      try {
        const cfg = deps.config()
        if (!cfg || !cfg.enabled || !cfg.provider || !cfg.model) return info
        if (provider === cfg.provider && model === cfg.model) return info
        if (info && Array.isArray(info.inputModalities) && info.inputModalities.length > 0
          && !info.inputModalities.includes('image')) {
          return Object.assign({}, info, { inputModalities: info.inputModalities.concat('image') })
        }
      } catch {
        // 保真回退
      }
      return info
    }
  }
  return () => {
    delete llm.__dockOrigStream
    delete llm.stream
    delete llm.prepareCall
    delete llm.__dockOrigResolveModelInfo
    delete llm.resolveModelInfo
  }
}

/** 测试钩子：清空识别缓存（冒烟在用例间隔离）。 */
export function __clearDescribeCache() {
  describeCache.clear()
}

/** 功能注册表条目：index.js 组装 hostSetups 时使用。 */
export const feature = {
  id: 'visionproxy',
  name: '图片理解代理',
  description: '纯文本模型收图时自动调用视觉模型识别（多模态模型不受影响）',
  defaultEnabled: true,
  setup(ctx) {
    // 模型目录的 TTL 缓存：图片代理判定目标模型是否纯文本时用（避免每个请求都全量 describe）
    let dockDirCache = { at: 0, data: { providers: [] } }
    const directoryCached = () => {
      if (Date.now() - dockDirCache.at > 10000) {
        try {
          dockDirCache = { at: Date.now(), data: readModelDirectory(ctx) }
        } catch {
          // 保持旧缓存
        }
      }
      return dockDirCache.data
    }
    return installVisionProxy(ctx, directoryCached)
  },
}
