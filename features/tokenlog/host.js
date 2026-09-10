// dsh-dock · 功能模块【用量记录】· 宿主半部（v0.4.0，移植自 @wycto/dsh-token-usage lib/index.js）
//
// 记录 DSH 会话日志中的每次 LLM 调用（assistant/message 的 usage），
// 支持历史全量扫描 + 实时 session/event 增量；RPC 经 webServer HTTP 路由
//   POST /dsh-dock/tokenlog/query|export|scan|hello|pricing|setpricing
// 向浏览器半部提供查询/统计/导出，以及单价的读取与保存。
//
// 数据模型（标量，无 Host 对象引用）：
// {
//   id, time, sessionId, provider, model, apiKey(掩码),
//   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
//   billedInput, totalTokens, cacheHitPercent, cost, pricingSource, effort, status, llmMs, turn, step
// }
//
// 单价配置保存在 settings 的 dsh-dock 命名空间 tokenlog 段（schema 见 src/host-core.js）：
//   dsh-dock:
//     tokenlog:
//       usdCnyRate: 7.2
//       fetchOfficial: true
//       pricing:
//         - { match: deepseek-v4-flash, input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0,
//             peaks: [{ start: 9, end: 14, input: 3, output: 9, cacheRead: 0.1, cacheWrite: 0 }] }
// 定价优先级：用户自定义单价 > 官网抓取刊例价 > 内置默认表 > 兜底单价。
// 分时段价支持多段（start>end 跨零点、start=end 全天、小数小时表示半点）；旧单段 peak 自动归一。
// 费用在查询/导出时按当前单价即时重算，因此改价无需重扫历史。
import { DOCK_NS, sendJson, readBody } from '../../src/host-core.js'

export const feature = {
  id: 'tokenlog',
  name: '用量记录',
  description: '记录全部 LLM API 调用并统计 Token 用量与花费',
  defaultEnabled: false,
  setup(ctx) {
    const disposers = []
    const dispose = () => {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        try { if (typeof fn === 'function') fn() } catch { /* 停用清理失败不阻断 */ }
      }
    }

    // 用 Map<id, record> 存记录: id = sessionId:seq 天然唯一。
    // 实时监听与历史扫描存在重叠窗口(活跃会话既被实时 push 又被扫描全量读),
    // 用 set 幂等去重, 避免同一条 LLM 调用被统计两次(此前用数组 push 导致"两倍")。
    const records = new Map()
    let scannedSessions = new Set()
    const headerCache = new Map()
    const turnError = new Map()
    const turnStatus = new Map()
    const stepStart = new Map()

    function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

    // ===== 定价与金额估算 =====
    // 定价表以「人民币元 / 百万 tokens」为基准(DeepSeek/智谱官方刊例即人民币), 金额先算 CNY,
    // 对外记录的 cost 保持 USD，供旧版客户端兼容；当前客户端和 CSV 统一展示人民币。
    // 单价来源与优先级(resolvePricing):
    //   1) 用户在面板「单价设置」保存的自定义单价(settings dsh-dock.tokenlog.pricing)——最高优先;
    //   2) 官网抓取刊例价(fetchOfficial 关闭时不参与);
    //   3) 内置默认表 DEFAULT_PRICING;
    //   4) 兜底单价(settings dsh-dock.tokenlog.fallback)。
    // 费用在查询/导出时即时重算(见 withCost), 所以改价立即生效、无需重扫历史。
    const DEFAULT_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
    const DEFAULT_FETCH_INTERVAL_HOURS = 24
    const DEFAULT_FALLBACK = { input: 2.16, output: 6.48, cacheRead: 0.43, cacheWrite: 4.32 }
    /** 计价来源标签(随记录下发, 供界面标注)。 */
    const PRICING_SOURCE_LABELS = { custom: '自定义', official: '官网', builtin: '内置', fallback: '兜底' }
    let usdCnyRate = 7.2
    let fallbackPricing = { match: '*', ...DEFAULT_FALLBACK }
    // 内置定价表(人民币元 / 百万 tokens), 按 model 子串匹配; 未匹配走 fallback。
    // 支持分时段定价: 条目可带 peaks=[{start,end,input,output,cacheRead,cacheWrite}, ...],
    // 命中某段(插件运行机器本地时间)用该段价, 其余时段用基准价; 支持多段与跨零点(start>end)。
    // 官方来源: DeepSeek-V4 系列 2026-08-17 生效的分时段刊例(高峰每日 9:00-14:00, 空闲为高峰一半)。
    const DEFAULT_PRICING = [
      { match: 'deepseek-v4-flash', input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0,
        peaks: [{ start: 9, end: 14, input: 3.0, output: 9.0, cacheRead: 0.10, cacheWrite: 0 }] },
      { match: 'deepseek-v4-pro', input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0,
        peaks: [{ start: 9, end: 14, input: 9.0, output: 27.0, cacheRead: 0.30, cacheWrite: 0 }] },
      { match: 'deepseek-v3', input: 3.6, output: 7.2, cacheRead: 0.72, cacheWrite: 7.2 },
      { match: 'deepseek-chat', input: 1.94, output: 7.92, cacheRead: 0.5, cacheWrite: 7.92 },
      { match: 'deepseek-reasoner', input: 3.96, output: 15.77, cacheRead: 1.01, cacheWrite: 7.92 },
      { match: 'nemotron', input: 1.08, output: 2.88, cacheRead: 0.22, cacheWrite: 2.16 },
      { match: 'glm', input: 2.88, output: 8.64, cacheRead: 0.58, cacheWrite: 7.2 },
    ]
    let pricingTable = DEFAULT_PRICING
    // 用户自定义单价(最高优先)与官网抓取开关/地址——均由 loadPricingConfig() 从 settings 刷新。
    let userPricing = []
    let fetchOfficialEnabled = true
    let pricingUrl = DEFAULT_PRICING_URL
    let fetchIntervalMs = DEFAULT_FETCH_INTERVAL_HOURS * 3600000

    function normalizePricing(match, e) {
      const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
      const row = { match, input: n(e.input), output: n(e.output), cacheRead: n(e.cacheRead), cacheWrite: n(e.cacheWrite) }
      // 分时段价支持多段: peaks=[{start,end,input,output,cacheRead,cacheWrite}, ...]。
      // 兼容旧的单段写法 peak={...}(以及旧版本存盘数据), 统一归一到 peaks。
      const src = Array.isArray(e.peaks) && e.peaks.length ? e.peaks : (e.peak && typeof e.peak === 'object' ? [e.peak] : [])
      const peaks = []
      for (const s of src) {
        if (!s || typeof s !== 'object') continue
        peaks.push({
          start: n(s.start), end: n(s.end),
          input: n(s.input), output: n(s.output),
          cacheRead: n(s.cacheRead), cacheWrite: n(s.cacheWrite),
        })
      }
      if (peaks.length) row.peaks = peaks
      return row
    }

    /** 浅拷贝分时段数组（RPC 下发与落盘都用它，避免调用方改到内存态）。 */
    function clonePeaks(peaks) {
      return Array.isArray(peaks) ? peaks.map((s) => Object.assign({}, s)) : []
    }

    // 读 settings 的 dsh-dock.tokenlog 段并刷新模块级定价状态。幂等, 可重复调用。
    // 取值做防御性归一(schema 已给默认, 但 settings 未挂载/异常时仍需兜底)。
    function loadPricingConfig() {
      try {
        const settings = ctx.get('settings')
        const root = settings && typeof settings.get === 'function' ? settings.get(DOCK_NS) : null
        const t = root && typeof root === 'object' && root.tokenlog && typeof root.tokenlog === 'object' ? root.tokenlog : null
        if (!t) return
        if (typeof t.usdCnyRate === 'number' && t.usdCnyRate > 0) usdCnyRate = t.usdCnyRate
        if (typeof t.fetchOfficial === 'boolean') fetchOfficialEnabled = t.fetchOfficial
        if (typeof t.pricingUrl === 'string' && t.pricingUrl) pricingUrl = t.pricingUrl
        if (typeof t.pricingFetchIntervalHours === 'number' && t.pricingFetchIntervalHours > 0) {
          fetchIntervalMs = t.pricingFetchIntervalHours * 3600000
        }
        userPricing = Array.isArray(t.pricing)
          ? t.pricing
            .filter((e) => e && typeof e === 'object' && typeof e.match === 'string' && e.match)
            .map((e) => normalizePricing(String(e.match).toLowerCase(), e))
          : []
        if (t.fallback && typeof t.fallback === 'object') fallbackPricing = normalizePricing('*', t.fallback)
      } catch (e) {
        console.error('[dsh-dock] tokenlog read pricing config failed', e && e.message)
      }
    }

    // 分时段命中: start<end 为普通区间 [start,end); start>end 表示跨零点(如 23~7 点);
    // start===end 视为全天。多段命中时取第一段(按配置顺序)。
    function pickPeakSegment(peaks, hour) {
      if (!Array.isArray(peaks) || hour < 0) return null
      for (const s of peaks) {
        const a = Number(s.start), b = Number(s.end)
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue
        const hit = a === b ? true : (a < b ? (hour >= a && hour < b) : (hour >= a || hour < b))
        if (hit) return s
      }
      return null
    }

    // 命中定价行: 用户自定义 → 官网抓取(可关闭) → 内置表 → 兜底; 再按调用时刻取分时价。
    // 官网获取的数据若为 USD 则自动折成 CNY(内置表已是 CNY)。返回单价(元/百万 tokens)与来源标签。
    function resolvePricing(model, timeMs) {
      const m = String(model || '').toLowerCase()
      let row = null
      let source = 'fallback'
      // 1) 用户自定义单价: 最高优先(官网抓取价常与实际计费不符, 用户填了就以其为准)
      for (const r of userPricing) {
        if (m.includes(r.match)) { row = r; source = 'custom'; break }
      }
      // 2) 官网自动获取的定价(48h 内有效, 超时回退内置; 可在设置里关闭抓取)
      if (!row && fetchOfficialEnabled) {
        const fetched = fetchedPricing
        if (fetched && fetched.length > 0 && (Date.now() - lastFetchTime < fetchIntervalMs * 2)) {
          for (const r of fetched) {
            if (m.includes(r.match)) { row = r; source = 'official'; break }
          }
        }
      }
      const fromFetch = source === 'official'
      // 3) 内置表
      if (!row) {
        for (const r of pricingTable) {
          if (m.includes(r.match)) { row = r; source = 'builtin'; break }
        }
      }
      // 4) 兜底
      if (!row) { row = fallbackPricing; source = 'fallback' }
      // 分时段判断(本地时间, 支持多段与跨零点; 用小数小时以便 08:30 这类半点边界); 未命中用基准价
      let h = -1
      if (typeof timeMs === 'number' && Number.isFinite(timeMs)) {
        const d = new Date(timeMs)
        h = d.getHours() + d.getMinutes() / 60
      }
      const seg = pickPeakSegment(row.peaks, h)
      const prices = seg
        ? { input: seg.input, output: seg.output, cacheRead: seg.cacheRead, cacheWrite: seg.cacheWrite }
        : { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite }
      // 币种转换: 官网抓取的数据若是 USD 则折成 CNY(内置表已是 CNY, 无需转换)
      if (fromFetch && row.currency === 'usd') {
        prices.input *= usdCnyRate
        prices.output *= usdCnyRate
        prices.cacheRead *= usdCnyRate
        prices.cacheWrite *= usdCnyRate
      }
      return { ...prices, source }
    }

    // 金额估算: 表为人民币价 → 先算 CNY, 再折成 USD(= CNY / usdCnyRate) 供客户端/CSV 使用。
    // 返回 { cost(USD), source(计价来源) }。
    function costOf(usage, model, timeMs) {
      const p = resolvePricing(model, timeMs)
      const cny = (
        num(usage.inputTokens) * p.input +
        num(usage.cacheReadTokens) * p.cacheRead +
        num(usage.cacheWriteTokens) * p.cacheWrite +
        num(usage.outputTokens) * p.output
      ) / 1e6
      return { cost: cny / usdCnyRate, source: p.source }
    }

    // 按当前单价重算一条记录的费用(浅拷贝)：面板改价后无需重扫历史即可即时生效。
    function withCost(r) {
      const c = costOf(r, r.model, r.time)
      return Object.assign({}, r, { cost: c.cost, pricingSource: c.source })
    }

    // 面板「单价设置」读取：返回当前生效的单价表 + 兜底/汇率/抓取开关 + 已出现过的模型
    // (含已配置 Provider 的模型, 供用户按模型逐条配置单价; 未配置的模型可手输匹配串)。
    function readPricingConfig() {
      const cfg = readConfiguredProviders()
      const seen = new Set()
      for (const r of records.values()) if (r.model) seen.add(r.model)
      for (const ids of Object.values(cfg)) for (const id of ids) if (id) seen.add(id)
      // 每个模型的当前计价来源(供面板提示哪些模型走了兜底价, 提示用户去配单价)
      const sourcesByModel = {}
      for (const m of seen) sourcesByModel[m] = PRICING_SOURCE_LABELS[resolvePricing(m, Date.now()).source] || ''
      return {
        usdCnyRate,
        fetchOfficial: fetchOfficialEnabled,
        pricingUrl,
        pricingFetchIntervalHours: Math.round(fetchIntervalMs / 3600000),
        pricing: userPricing.map((r) => Object.assign({}, r, { peaks: clonePeaks(r.peaks) })),
        fallback: Object.assign({}, fallbackPricing),
        builtin: pricingTable.map((r) => ({ match: r.match, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, peaks: clonePeaks(r.peaks) })),
        models: [...seen].sort(),
        sourcesByModel,
      }
    }

    // 保存面板提交的单价配置: 校验 → 合并进 dsh-dock.tokenlog(保留 pricingUrl 等未在面板暴露
    // 的字段) → 落盘。保存后由调用方 loadPricingConfig() 刷新内存, 使改价立即影响费用估算。
    async function savePricingConfig(input) {
      const settings = ctx.get('settings')
      if (!settings || typeof settings.get !== 'function' || typeof settings.mutate !== 'function') {
        throw new Error('settings 服务不可用，单价无法持久化')
      }
      const bad = (msg) => { const err = new Error(msg); err.statusCode = 400; return err }
      const nonNeg = (v, label) => {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) throw bad(`「${label}」需为不小于 0 的数字`)
        return n
      }
      const root = settings.get(DOCK_NS)
      const current = root && typeof root === 'object' && root.tokenlog && typeof root.tokenlog === 'object' ? root.tokenlog : {}
      const next = Object.assign({}, current)
      if (input.usdCnyRate !== undefined) {
        const r = Number(input.usdCnyRate)
        if (!Number.isFinite(r) || r <= 0 || r > 1000) throw bad('「USD→CNY 汇率」需为 0~1000 的正数')
        next.usdCnyRate = r
      }
      if (input.fetchOfficial !== undefined) next.fetchOfficial = !!input.fetchOfficial
      if (input.pricing !== undefined) {
        if (!Array.isArray(input.pricing)) throw bad('「模型单价」需为数组')
        const rows = []
        for (const raw of input.pricing) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('模型单价条目格式不符')
          const match = String(raw.match || '').trim().toLowerCase()
          if (!match) throw bad('模型单价条目的「模型匹配」不能为空')
          if (match === '*') throw bad('模型匹配不能是 *；未匹配模型请填「兜底单价」')
          const row = {
            match,
            input: nonNeg(raw.input, `${match} 输入单价`),
            output: nonNeg(raw.output, `${match} 输出单价`),
            cacheRead: nonNeg(raw.cacheRead, `${match} 缓存命中单价`),
            cacheWrite: nonNeg(raw.cacheWrite, `${match} 缓存写入单价`),
          }
          // 分时段价(可多段): 每段 start/end 为 0~24 的本地小时(支持 8.5 表示 08:30);
          // start>end 表示跨零点, start===end 表示全天。
          const rawPeaks = Array.isArray(raw.peaks) ? raw.peaks : []
          const peaks = []
          for (const seg of rawPeaks) {
            if (!seg || typeof seg !== 'object' || Array.isArray(seg)) throw bad(`「${match}」分时段条目格式不符`)
            const start = Number(seg.start), end = Number(seg.end)
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > 24 || end < 0 || end > 24) {
              throw bad(`「${match}」分时段时刻需为 0~24 的小时数`)
            }
            peaks.push({
              start, end,
              input: nonNeg(seg.input, `${match} 分时段输入单价`),
              output: nonNeg(seg.output, `${match} 分时段输出单价`),
              cacheRead: nonNeg(seg.cacheRead, `${match} 分时段缓存命中单价`),
              cacheWrite: nonNeg(seg.cacheWrite, `${match} 分时段缓存写入单价`),
            })
          }
          if (peaks.length) row.peaks = peaks
          rows.push(row)
        }
        next.pricing = rows
      }
      if (input.fallback !== undefined) {
        const f = input.fallback
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('「兜底单价」格式不符')
        next.fallback = {
          input: nonNeg(f.input, '兜底输入单价'),
          output: nonNeg(f.output, '兜底输出单价'),
          cacheRead: nonNeg(f.cacheRead, '兜底缓存命中单价'),
          cacheWrite: nonNeg(f.cacheWrite, '兜底缓存写入单价'),
        }
      }
      try {
        await settings.mutate(DOCK_NS, [{ op: 'set', path: ['tokenlog'], value: next }])
      } catch (e) {
        const err = new Error('保存单价被拒绝：' + ((e && e.message) || String(e)))
        err.statusCode = 400
        throw err
      }
      console.log('[dsh-dock] tokenlog pricing saved: rows=' + (Array.isArray(next.pricing) ? next.pricing.length : 0) +
        ', fetchOfficial=' + next.fetchOfficial)
      return next
    }

    // ===== 官网定价自动获取 =====
    // 每 N 小时(默认 24)从官网抓取最新定价并解析 HTML 表格; 抓取/解析失败时使用内置默认值。
    // 用户在面板配置的单价优先于抓取价, 因此抓取仅作兜底; 也可在面板关闭抓取。
    let fetchedPricing = null  // Array<{ match, input, output, cacheRead, cacheWrite, currency }>
    let lastFetchTime = 0

    function getPricingFetchConfig() {
      return { url: pricingUrl, intervalMs: fetchIntervalMs }
    }

    // 服务端出站请求前的 URL 校验(SSRF 防护): 仅 http/https, 且拒绝本机/环回/私有/保留地址。
    function isPrivateOrReservedHost(host) {
      const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
      if (!h) return true
      if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
      if (h.includes(':')) { // IPv6 字面量
        return h === '::' || h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')
      }
      const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (m) {
        const a = Number(m[1]), b = Number(m[2])
        return a === 0 || a === 10 || a === 127
          || (a === 169 && b === 254)          // link-local
          || (a === 172 && b >= 16 && b <= 31) // 私网
          || (a === 192 && b === 168)          // 私网
          || a >= 224                          // 组播/保留
      }
      return false
    }

    function assertAllowedFetchUrl(raw) {
      let u
      try { u = new URL(String(raw)) } catch { throw new Error('价格页地址不是合法 URL：' + raw) }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('价格页地址仅支持 http/https')
      if (isPrivateOrReservedHost(u.hostname)) throw new Error('价格页地址不允许指向本机/内网/保留地址')
      return u.toString()
    }

    // 从 HTML 中提取所有 <table> 的行列数据
    function extractHTMLTables(html) {
      const tables = []
      const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi
      let tm
      while ((tm = tableRe.exec(html)) !== null) {
        const rows = []
        const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
        let tr
        while ((tr = trRe.exec(tm[1])) !== null) {
          const cells = []
          const tdRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi
          let td
          while ((td = tdRe.exec(tr[1])) !== null) {
            cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim())
          }
          if (cells.length > 0) rows.push(cells)
        }
        if (rows.length >= 2) tables.push(rows)
      }
      return tables
    }

    // 从价格字符串提取数字(支持 "$0.27", "0.27", "¥1.5", "1.5元", "1,500" 等格式)
    function parsePrice(s) {
      if (!s) return null
      const cleaned = String(s).replace(/,/g, '').replace(/￥|¥|元|\/.*$/g, '').trim()
      const m = cleaned.match(/(\d+\.?\d*)/)
      return m ? parseFloat(m[1]) : null
    }

    // 识别定价表列: 通过表头关键词定位各列
    function identifyPricingColumns(headers) {
      const h = headers.map(x => x.toLowerCase())
      const find = (...patterns) => {
        for (const p of patterns) {
          const idx = h.findIndex(x => x.includes(p))
          if (idx >= 0) return idx
        }
        return -1
      }
      return {
        model: find('模型', 'model', '名称', 'name'),
        inputMiss: find('缓存未命中', '未缓存', 'cache miss', 'uncached'),
        inputHit: find('缓存命中', 'cache hit', 'cached'),
        output: find('输出', 'output'),
        peak: find('高峰', 'peak', 'busy', 'on-peak'),
      }
    }

    // 从 HTML 解析 DeepSeek 官网定价
    // 策略: 提取所有 <table>, 找到含"价格/缓存/输入/输出"关键词的表, 逐行提取模型名+价格;
    // 识别 $ 标记区分 USD/CNY 币种; 无法解析时返回空数组(回退内置默认)。
    function parsePricingFromHTML(html) {
      const tables = extractHTMLTables(html)
      const results = []
      for (const rows of tables) {
        const headers = rows[0]
        const cols = identifyPricingColumns(headers)
        // 至少需要模型名 + 一个价格列
        if (cols.model < 0) continue
        if (cols.inputMiss < 0 && cols.output < 0 && cols.inputHit < 0) continue
        // 表头需与定价相关
        const headerText = headers.join(' ')
        if (!/价格|price|缓存|cache|输入|input|输出|output|tokens/i.test(headerText)) continue
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i]
          const name = (row[cols.model] || '').trim()
          if (!name || /^(模型|model|名称|合计|total|---)/i.test(name)) continue
          const input = cols.inputMiss >= 0 ? parsePrice(row[cols.inputMiss]) : null
          const output = cols.output >= 0 ? parsePrice(row[cols.output]) : null
          const cacheHit = cols.inputHit >= 0 ? parsePrice(row[cols.inputHit]) : null
          if (input === null && output === null && cacheHit === null) continue
          // 判断币种
          const allText = row.join(' ')
          const isUSD = /\$|USD|dollar/i.test(allText)
          results.push({
            match: name.toLowerCase(),
            input: input || 0,
            output: output || 0,
            cacheRead: cacheHit || 0,
            cacheWrite: 0, // DeepSeek 官方不收取缓存写入
            currency: isUSD ? 'usd' : 'cny',
          })
        }
      }
      return results
    }

    // 从官网获取最新定价(异步, 失败静默回退内置默认)
    async function fetchOfficialPricing() {
      try {
        const { url } = getPricingFetchConfig()
        const safeUrl = assertAllowedFetchUrl(url)
        console.log('[dsh-dock] tokenlog fetching official pricing from:', safeUrl)
        const res = await fetch(safeUrl, {
          headers: { 'User-Agent': 'dsh-dock-tokenlog/0.4', 'Accept': 'text/html,*/*' }
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const html = await res.text()
        console.log('[dsh-dock] tokenlog pricing page fetched, size:', html.length)
        if (html.length < 500) {
          console.warn('[dsh-dock] tokenlog page too small, likely SPA shell — using defaults')
          return
        }
        const parsed = parsePricingFromHTML(html)
        if (parsed.length > 0) {
          fetchedPricing = parsed
          lastFetchTime = Date.now()
          console.log('[dsh-dock] tokenlog parsed', parsed.length, 'models from official pricing')
        } else {
          console.warn('[dsh-dock] tokenlog parsed 0 models from pricing page — check page structure, using defaults')
        }
      } catch (e) {
        console.error('[dsh-dock] tokenlog fetch official pricing failed:', e && e.message, '— using built-in defaults')
      }
    }

    // 读取 settings.yaml 的 llm-pi-ai 命名空间, 返回「现有提供商」路由名 -> [模型 id]。
    // 用途: 前端提供商/模型下拉 = 现有配置 ∪ 历史记录, 去重合并 ——
    //   - 没有任何记录时仍可选现有提供商;
    //   - 提供商/模型已从配置删除时, 因有历史记录仍可选中(兼容两者)。
    function readConfiguredProviders() {
      const out = {}
      try {
        const settings = ctx.get('settings')
        if (!settings || typeof settings.get !== 'function') return out
        const sec = settings.get('llm-pi-ai')
        const providers = sec && typeof sec === 'object' && sec.providers ? sec.providers : {}
        for (const pid of Object.keys(providers || {})) {
          const p = providers[pid]
          if (!p || typeof p !== 'object') { out[pid] = []; continue }
          const models = Array.isArray(p.models) ? p.models : []
          const ids = []
          for (const m of models) {
            const id = m && typeof m === 'object' ? m.id : m
            if (typeof id === 'string' && id) ids.push(id)
          }
          out[pid] = ids
        }
      } catch (e) {
        console.error('[dsh-dock] tokenlog read configured providers failed', e && e.message)
      }
      return out
    }

    // ---------- 事件采集 ----------

    // 预扫描 turn/end: 先建立 turn -> status/error 映射, 再生成记录
    // (解决顺序处理导致的状态缺失: assistant/message 先于 turn/end 到达)
    function preScanTurnEnds(sessionId, events) {
      for (const e of events) {
        if (e.type !== 'turn/end') continue
        const t = e.data && e.data.turn
        const r = e.data && e.data.reason
        let status = 'completed'
        if (r && typeof r === 'object') status = r.kind || 'completed'
        else if (typeof r === 'string') status = r
        turnStatus.set(sessionId + ':' + t, status)
        let errInfo = null
        if (r && typeof r === 'object' && r.error) {
          const er = r.error
          errInfo = {
            statusCode: typeof er.status === 'number' ? er.status : 0,
            errorCode: er.code || '',
            errorMsg: er.message || '',
          }
        }
        turnError.set(sessionId + ':' + t, errInfo)
      }
    }

    function ingestEvent(sessionId, event) {
      if (event.type === 'request/header') {
        const h = event.data && event.data.header
        if (h && h.config) {
          headerCache.set(sessionId, {
            provider: h.config.provider || '',
            model: h.config.model || '',
            effort: h.config.reasoningEffort || '',
          })
        }
      }
      if (event.type === 'turn/end') {
        const t = event.data && event.data.turn
        const r = event.data && event.data.reason
        let status = 'completed'
        if (r && typeof r === 'object') status = r.kind || 'completed'
        else if (typeof r === 'string') status = r
        turnStatus.set(sessionId + ':' + t, status)
        let errInfo = null
        if (r && typeof r === 'object' && r.error) {
          const e = r.error
          errInfo = {
            statusCode: typeof e.status === 'number' ? e.status : 0,
            errorCode: e.code || '',
            errorMsg: e.message || '',
          }
        }
        turnError.set(sessionId + ':' + t, errInfo)
      }
      if (event.type === 'step/start') {
        stepStart.set(sessionId + ':' + event.data.turn + ':' + event.data.step, event.time)
      }
      if (event.type !== 'assistant/message') return null
      const d = event.data || {}
      let usage = d.usage
      if (!usage || typeof usage !== 'object') usage = { inputTokens: 0, outputTokens: 0 }
      const head = headerCache.get(sessionId) || { provider: '', model: '', effort: '' }
      const turn = num(d.turn)
      const step = num(d.step)
      const startK = sessionId + ':' + turn + ':' + step
      const startMs = stepStart.get(startK)
      const llmMs = typeof startMs === 'number' ? Math.max(0, event.time - startMs) : null
      const status = turnStatus.get(sessionId + ':' + turn) || 'in-progress'
      const ei = turnError.get(sessionId + ':' + turn) || null
      const input = num(usage.inputTokens)
      const output = num(usage.outputTokens)
      const cacheRead = num(usage.cacheReadTokens)
      const cacheWrite = num(usage.cacheWriteTokens)
      const reasoning = num(usage.reasoningTokens)
      const priced = costOf(usage, head.model, event.time)
      stepStart.delete(startK)
      return {
        id: sessionId + ':' + event.seq,
        time: event.time,
        sessionId,
        provider: head.provider || '',
        model: head.model || '',
        apiKey: '',
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning,
        billedInput: input + cacheRead + cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cacheHitPercent: (input + cacheRead) > 0 ? Math.round((cacheRead / (input + cacheRead)) * 100) : 0,
        cost: priced.cost,
        pricingSource: priced.source,
        effort: head.effort || '',
        status,
        statusCode: ei ? ei.statusCode : 0,
        errorCode: ei ? ei.errorCode : '',
        errorMsg: ei ? ei.errorMsg : '',
        llmMs,
        turn,
        step,
      }
    }

    function ingestEvents(sessionId, events) {
      const out = []
      for (const e of events) {
        const r = ingestEvent(sessionId, e)
        if (r) out.push(r)
      }
      return out
    }

    // 历史扫描: 遍历所有会话, 读取完整日志, 重建索引
    // 说明: 读取失败的多是旧版(v0→v1 迁移)、中途损坏或缺 seq 的会话——这类日志无法解码是常态,
    // 不应视为异常。若逐条 console.error 会把终端刷屏, 改为统计失败数并只打印少量样例明细。
    async function scanHistory() {
      if (!sessionQuery) return
      const failures = [] // { sid, msg } 保留前 MAX 条明细供排查
      const MAX_FAIL_SAMPLES = 3
      let failCount = 0
      try {
        const sessions = await sessionQuery.listSessions()
        let added = 0
        for (const s of sessions) {
          const sid = s && s.header ? s.header.id : (s && s.id)
          if (!sid || scannedSessions.has(sid)) continue
          scannedSessions.add(sid)
          try {
            const snap = await sessionQuery.readSession(sid)
            const events = snap && snap.events ? snap.events : []
            // 两遍: 先建 turn/end 映射, 再生成记录
            preScanTurnEnds(sid, events)
            const recs = ingestEvents(sid, events)
            for (const r of recs) records.set(r.id, r)
            added += recs.length
          } catch (e) {
            failCount += 1
            if (failures.length < MAX_FAIL_SAMPLES) failures.push(sid + ': ' + ((e && e.message) || String(e)))
          }
        }
        // 失败会话统一汇总为一行(仅列前几条样例), 不逐条刷屏。
        if (failCount > 0) {
          console.warn('[dsh-dock] tokenlog 历史扫描: ' + failCount + ' 个会话未能读取' +
            (failCount > MAX_FAIL_SAMPLES ? ', 前 ' + MAX_FAIL_SAMPLES + ' 条如下:' : ':') )
          for (const f of failures) console.warn('  - ' + f)
        }
        console.log('[dsh-dock] tokenlog history scanned: +' + added + ' records, total ' + records.size)
      } catch (e) {
        console.error('[dsh-dock] tokenlog scanHistory failed', e && e.message)
      }
    }

    function buildQuery(args) {
      const q = args || {}
      const from = typeof q.from === 'number' ? q.from : 0
      const to = typeof q.to === 'number' ? q.to : Infinity
      const provider = (q.provider || '').trim()
      const model = (q.model || '').trim()
      const status = (q.status || '').trim()
      const effort = (q.effort || '').trim()
      const sessionId = (q.sessionId || '').trim()
      return [...records.values()].filter((r) => {
        if (r.time < from || r.time > to) return false
        if (provider && r.provider !== provider) return false
        if (model && r.model !== model) return false
        if (status && r.status !== status) return false
        if (effort && r.effort !== effort) return false
        if (sessionId && r.sessionId !== sessionId) return false
        return true
      })
    }

    function summarize(list, dim) {
      const map = new Map()
      for (const r of list) {
        const key = r[dim] || '(none)'
        const e = map.get(key)
        if (e) {
          e.calls += 1
          e.inputTokens += r.inputTokens
          e.outputTokens += r.outputTokens
          e.cacheReadTokens += r.cacheReadTokens
          e.cacheWriteTokens += r.cacheWriteTokens
          e.reasoningTokens += r.reasoningTokens
          e.billedInput += r.billedInput
          e.totalTokens += r.totalTokens
          e.cost += r.cost
          if (typeof r.llmMs === 'number') { e.llmMs += r.llmMs; e.timed += 1 }
        } else {
          map.set(key, {
            key, calls: 1,
            inputTokens: r.inputTokens, outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens,
            reasoningTokens: r.reasoningTokens, billedInput: r.billedInput,
            totalTokens: r.totalTokens, cost: r.cost,
            llmMs: typeof r.llmMs === 'number' ? r.llmMs : 0,
            timed: typeof r.llmMs === 'number' ? 1 : 0,
          })
        }
      }
      return [...map.values()]
        .map((e) => ({ ...e, cacheHitPct: e.billedInput > 0 ? Math.round((e.cacheReadTokens / e.billedInput) * 100) : 0 }))
        .sort((a, b) => b.calls - a.calls)
    }

    function totals(list) {
      const t = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, billedInput: 0, totalTokens: 0, cost: 0, llmMs: 0, timed: 0 }
      for (const r of list) {
        t.calls += 1
        t.inputTokens += r.inputTokens
        t.outputTokens += r.outputTokens
        t.cacheReadTokens += r.cacheReadTokens
        t.cacheWriteTokens += r.cacheWriteTokens
        t.reasoningTokens += r.reasoningTokens
        t.billedInput += r.billedInput
        t.totalTokens += r.totalTokens
        t.cost += r.cost
        if (typeof r.llmMs === 'number') { t.llmMs += r.llmMs; t.timed += 1 }
      }
      t.cacheHitPct = t.billedInput > 0 ? Math.round((t.cacheReadTokens / t.billedInput) * 100) : 0
      return t
    }

    // ---------- RPC（webServer HTTP 路由，前缀 /dsh-dock/tokenlog/） ----------

    // 实时监听 + 历史扫描: 必须等 sessionQuery 服务就绪。
    // 注意: 不能在 setup 时用 ctx.get('sessionQuery') 软获取——profile 插件无 inject 声明,
    // 可能早于 sessionQuery 提供方激活, 拿到 undefined 会让 监听+扫描 整条采集链路静默失效。
    // 改用 ctx.inject(['sessionQuery'], ...): 服务已就绪则立即执行, 否则挂起等待。
    let sessionQuery = null
    disposers.push(ctx.inject(['sessionQuery'], (sqCtx) => {
      sessionQuery = sqCtx.sessionQuery
      // 服务就绪后加载 settings 单价配置(汇率 + 自定义单价 + 抓取开关), 供采集/重扫/导出使用
      loadPricingConfig()
      // 从官网获取最新定价(启动时 + 每 N 小时自动刷新; 面板关闭抓取时不发起请求)
      if (fetchOfficialEnabled) fetchOfficialPricing()
      const fetchTimer = setInterval(() => { if (fetchOfficialEnabled) fetchOfficialPricing() }, getPricingFetchConfig().intervalMs)
      sqCtx.effect(() => () => clearInterval(fetchTimer))
      // 实时监听: session/event (root scope 可收到所有 session 事件, 与官方 persistence 同款订阅)
      disposers.push(sqCtx.on('session/event', (session, event) => {
        try {
          const sid = typeof session === 'object' && session ? (session.id || '') : String(session || '')
          const rec = ingestEvent(sid, event)
          if (rec) records.set(rec.id, rec)
          // turn/end 到达后回填该 turn 已有记录的状态/错误(实时增量场景)
          if (event.type === 'turn/end') {
            const t = event.data && event.data.turn
            const key = sid + ':' + t
            const st = turnStatus.get(key)
            const ei = turnError.get(key) || null
            if (st) {
              for (const r of records.values()) {
                if (r.sessionId === sid && String(r.turn) === String(t)) {
                  r.status = st
                  r.statusCode = ei ? ei.statusCode : 0
                  r.errorCode = ei ? ei.errorCode : ''
                  r.errorMsg = ei ? ei.errorMsg : ''
                }
              }
            }
          }
        } catch (err) {
          console.error('[dsh-dock] tokenlog ingest error', err)
        }
      }))
      // 服务就绪后立即做一次历史全量扫描
      scanHistory()
    }))

    // webServer 就绪后注册 /dsh-dock/tokenlog 前缀路由(ctx.inject 保证就绪后再执行)
    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/tokenlog',
        async handler(req, res) {
          try {
            const url = new URL(req.url || '/', 'http://dsh.internal')
            const method = url.pathname.replace(/^\/dsh-dock\/tokenlog\/?/, '').split('/')[0] || ''
            const payload = await readBody(req)
            if (method === 'query') {
              loadPricingConfig()
              // 费用按当前单价即时重算(withCost): 面板改价后立即反映到统计与明细, 无需重扫历史。
              const list = buildQuery(payload || {}).map(withCost)
              const rows = [...list].sort((a, b) => b.time - a.time)
              const all = [...records.values()]
              const cfg = readConfiguredProviders()
              // 提供商/模型下拉 = 现有配置(llm-pi-ai.providers) ∪ 历史记录, 去重排序。
              // 兼容两种场景: 无记录时仍可选现有提供商; 提供商/模型已删除时因记录仍可选中。
              const providerSet = new Set(all.map((r) => r.provider).filter(Boolean))
              const modelSet = new Set(all.map((r) => r.model).filter(Boolean))
              for (const pid of Object.keys(cfg)) if (pid) providerSet.add(pid)
              for (const ids of Object.values(cfg)) for (const id of ids) modelSet.add(id)
              // 提供商 -> 模型 映射(供前端联动筛选: 选中提供商后模型下拉只显示其下模型)
              const modelsByProvider = {}
              const initMbp = (p) => { if (!modelsByProvider[p]) modelsByProvider[p] = [] }
              for (const p of providerSet) initMbp(p)
              for (const r of all) {
                if (!r.model) continue
                const p = r.provider || '(none)'
                initMbp(p)
                if (!modelsByProvider[p].includes(r.model)) modelsByProvider[p].push(r.model)
              }
              for (const [pid, ids] of Object.entries(cfg)) {
                initMbp(pid)
                for (const id of ids) if (!modelsByProvider[pid].includes(id)) modelsByProvider[pid].push(id)
              }
              for (const p of Object.keys(modelsByProvider)) modelsByProvider[p].sort()
              return sendJson(res, 200, {
                ok: true,
                data: {
                  records: rows,
                  counts: { total: records.size, matching: rows.length },
                  providers: [...providerSet].sort(),
                  models: [...modelSet].sort(),
                  modelsByProvider,
                  statuses: [...new Set(all.map((r) => r.status).filter(Boolean))],
                  efforts: [...new Set(all.map((r) => r.effort).filter(Boolean))],
                  sessionIds: [...new Set(all.map((r) => r.sessionId).filter(Boolean))].sort(),
                  rateUsdCny: usdCnyRate,
                  pricingInfo: {
                    hasCustom: userPricing.length > 0,
                    customCount: userPricing.length,
                    fetchOfficial: fetchOfficialEnabled,
                    sources: [...new Set(list.map((r) => r.pricingSource).filter(Boolean))].map((s) => PRICING_SOURCE_LABELS[s] || s),
                  },
                  totals: totals(list),
                  summary: payload && payload.dim ? summarize(list, payload.dim) : [],
                }
              })
            }
            if (method === 'pricing') {
              loadPricingConfig()
              return sendJson(res, 200, { ok: true, data: readPricingConfig() })
            }
            if (method === 'setpricing') {
              await savePricingConfig(payload || {})
              loadPricingConfig()
              return sendJson(res, 200, { ok: true, data: readPricingConfig() })
            }
            if (method === 'export') {
              loadPricingConfig()
              const list = buildQuery(payload || {}).map(withCost)
              const header = ['time', 'provider', 'model', 'apiKey', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'billedInput', 'cacheHitPercent', 'totalTokens', 'costCny', 'effort', 'status', 'statusCode', 'errorCode', 'errorMsg', 'llmMs', 'sessionId', 'turn', 'step']
              const esc = (v) => {
                const s = String(v === undefined || v === null ? '' : v)
                return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
              }
              const lines = [header.map(esc).join(',')]
              for (const r of list) lines.push(header.map((h) => esc(h === 'costCny' ? ((Number(r.cost) || 0) * usdCnyRate) : r[h])).join(','))
              return sendJson(res, 200, { ok: true, data: { csv: lines.join('\n'), count: list.length } })
            }
            if (method === 'scan') {
              await scanHistory()
              return sendJson(res, 200, { ok: true, data: { total: records.size } })
            }
            if (method === 'hello') {
              return sendJson(res, 200, { ok: true, data: { ok: true, records: records.size, scanned: scannedSessions.size } })
            }
            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method, details: {} } })
          } catch (e) {
            // 参数校验类错误按 4xx 返回(如单价非法), 其余为 500
            const status = e && e.statusCode ? e.statusCode : 500
            return sendJson(res, status, { ok: false, error: { code: status === 500 ? 'internal' : 'bad-request', message: (e && e.message) || String(e), details: {} } })
          }
        }
      }), 'dsh-dock tokenlog: /dsh-dock/tokenlog HTTP route')
    }))

    return dispose
  },
}
