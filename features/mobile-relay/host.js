// dsh-dock · 功能模块【手机接力】· 宿主半部
//
// 「服务器模式」（单实例架构）：所有设备访问同一个 DSH 进程，会话、任务进度、
// 设置、功能坞完全一致——这就是"dsh 装在服务器上，任何设备打开都一样"的形态。
//
//   - 开启：插件把 `- id: webserver / config: {host:'0.0.0.0', port}` 写进用户的
//     profile 补丁层（~/.dsh/profiles/web/cordis.patch.yml，DSH 官方补丁语义），
//     重启 `dsh web` 后主实例直接绑定 0.0.0.0。绑定后 DSH 自身派生局域网信任
//     （connection 行 trustedHosts = 局域网 IPv4），目录选择器自动切浏览模式；
//     手机接力的网关上游也直接指向主实例——不再有第二个进程，自然不存在
//     任务状态在不同实例间不同步的问题。
//   - 兼容兜底：局域网 http 非安全上下文，部分浏览器缺 crypto.randomUUID（DSH
//     客户端生成消息/RPC ID 直接调用）。通过 webServer.tapIndex 在 index.html
//     内联注入 ES5 兜底；回环/安全上下文下脚本自我短路零副作用。
//
// 配对状态、在线设备与接力备注只存内存；会话数据始终只有 ~/.dsh 这一份。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { DOCK_NS, readBody, sendJson } from '../../src/host-core.js'
import { lanAddresses, startProtectedLanGateway } from './gateway.js'

const DEFAULT_GATEWAY_PORT = 3081

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
/** 远程访问开关所在的用户补丁层（web profile 专属；测试可用环境变量指到临时文件）。 */
function serverPatchFile() {
  return process.env.DSH_DOCK_PATCH_FILE || join(dshHome(), 'profiles', 'web', 'cordis.patch.yml')
}

// 与 DSH include 插件同款的 !!js 表达式标签：用户补丁层可能含 !!js 表达式，
// 读写必须无损往返，否则一次开关操作就会破坏用户手工配置。
const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data['__jsExpr'],
})
const patchYamlSchema = yaml.JSON_SCHEMA.extend(JsExprType)

function readPatchList(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    const err = new Error('读取局域网服务补丁失败：' + ((error && error.message) || String(error)))
    err.statusCode = 500
    throw err
  }
  try {
    const data = yaml.load(text, { schema: patchYamlSchema })
    return Array.isArray(data) ? data : []
  } catch (error) {
    const err = new Error('局域网服务补丁不是合法的补丁列表：' + ((error && error.message) || String(error)))
    err.statusCode = 500
    throw err
  }
}
function writePatchList(file, list) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, yaml.dump(list, { schema: patchYamlSchema }), 'utf8')
  } catch (error) {
    const err = new Error('写入局域网服务补丁失败：' + ((error && error.message) || String(error)))
    err.statusCode = 500
    throw err
  }
}
function serverPatchApplied(list) {
  // 远程访问补丁：目录选择器钉死为浏览模式（远程设备不能弹本机对话框）。
  return Array.isArray(list) && list.some((row) => row && row.id === 'directory-picker-browse')
}
function legacyWebserverRowPresent(list) {
  // 旧「服务器模式」残留：0.0.0.0 的 webserver 覆盖行。账号认证架构下主实例必须回到仅本机，
  // 否则局域网设备可以绕过登录网关直连。
  return Array.isArray(list) && list.some((row) => row && row.id === 'webserver'
    && row.config && row.config.host === '0.0.0.0')
}
function upsertRemotePatches(list) {
  const cleaned = list.filter((row) => !(row && (row.id === 'webserver'
    || row.id === 'directory-picker' || row.id === 'directory-picker-browse' || row.id === 'ui-directory-picker-browse')))
  cleaned.push(
    { id: 'directory-picker', disabled: true },
    { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
  )
  return cleaned
}
function removeRemotePatches(list) {
  return list.filter((row) => !(row && (row.id === 'webserver'
    || row.id === 'directory-picker' || row.id === 'directory-picker-browse' || row.id === 'ui-directory-picker-browse')))
}

// LAN HTTP 不是浏览器安全上下文：部分浏览器在 http://<局域网IP> 下只暴露
// crypto.getRandomValues() 而省略 crypto.randomUUID()，而 DSH 的 connection /
// conversation 客户端直接调用 randomUUID() 生成消息 ID 与 RPC ID——缺失时整个
// 客户端引导失败（会话列表、工作区等全部不可用）。下面这段与手机接力网关同款、
// 局域网 http 不是浏览器安全上下文：部分浏览器（老内核/加固内核）在 http://<局域网IP>
// 下缺失 crypto.randomUUID（DSH 的 connection/conversation 客户端生成消息与 RPC ID
// 直接调用它，缺失则整个客户端瘫痪——会话列表、设置目录、工作区全不可用）。
// 这段 ES5 兜底无前置条件：randomUUID 与 getRandomValues 都补齐（实例属性 +
// Crypto.prototype 双路径）；crypto 被整体冻结的极端浏览器则替换整个对象。
// 回环/安全上下文下 randomUUID 原生存在，脚本自我短路零副作用。
const LAN_COMPAT_JS = "(function(){var g=typeof globalThis!=='undefined'?globalThis:(typeof window!=='undefined'?window:(typeof self!=='undefined'?self:undefined));if(!g)return;if(!g.crypto){try{g.crypto={}}catch(e){return}}var c=g.crypto;var nativeRng=typeof c.getRandomValues==='function'?c.getRandomValues.bind(c):null;function rng(bytes){if(nativeRng){nativeRng(bytes);return bytes}for(var i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256)&255;return bytes}function uuid(){var b=rng(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=[];for(var i=0;i<16;i++)h.push((b[i]+256).toString(16).slice(1));return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('')}function fill(array){rng(array);return array}function define(obj,name,value){if(!obj||typeof obj[name]==='function')return;try{Object.defineProperty(obj,name,{value:value,configurable:true})}catch(e){try{obj[name]=value}catch(e2){}}}define(c,'randomUUID',uuid);if(!nativeRng)define(c,'getRandomValues',fill);define(g.Crypto&&g.Crypto.prototype||null,'randomUUID',uuid);if(!nativeRng)define(g.Crypto&&g.Crypto.prototype||null,'getRandomValues',fill);if(typeof c.randomUUID!=='function'){var fresh={getRandomValues:fill,randomUUID:uuid};if(c.subtle)fresh.subtle=c.subtle;var keyOrigin=Object.create(null);for(var k in c){try{keyOrigin[k]=c[k]}catch(e3){}}for(var k2 in keyOrigin){if(typeof fresh[k2]==='undefined')fresh[k2]=keyOrigin[k2]}try{Object.defineProperty(g,'crypto',{value:fresh,configurable:true})}catch(e4){try{g.crypto=fresh}catch(e5){}}}})()"
const LAN_COMPAT_MARKER = 'data-dsh-lan-compat'
/** 把兼容脚本内联注入 index.html 的 <head> 之后（幂等）。 */
function injectLanCompat(html) {
  if (html.includes(LAN_COMPAT_MARKER)) return html
  const script = `<script ${LAN_COMPAT_MARKER}>${LAN_COMPAT_JS}</script>`
  const match = /<head(?:\s[^>]*)?>/i.exec(html)
  if (!match) return script + html
  const at = match.index + match[0].length
  return html.slice(0, at) + script + html.slice(at)
}
function routeMethod(req) {
  const url = new URL(req.url || '/', 'http://dsh.internal')
  return url.pathname.replace(/^\/dsh-dock\/mobile-relay\/?/, '').replace(/\/+$/, '')
}

export const feature = {
  id: 'mobile-relay',
  name: '远程访问',
  description: '账号密码登录的远程入口：局域网/虚拟网设备访问同一个 DSH，任务进度实时一致',
  defaultEnabled: true,
  setup(ctx) {
    const disposers = []
    let gateway = null
    let gatewayStarting = null
    let settingsCtx = null

    disposers.push(ctx.inject(['settings'], (sctx) => { settingsCtx = sctx }))

    // ── 远程访问账号（settings 持久化；密码只存加盐哈希） ──
    function hashPassword(salt, password) {
      return createHash('sha256').update(String(salt) + '\u0000' + String(password), 'utf8').digest('hex')
    }
    function sameText(a, b) {
      const ba = Buffer.from(String(a || ''))
      const bb = Buffer.from(String(b || ''))
      return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb)
    }
    function getAuth() {
      if (!settingsCtx) return null
      const value = settingsCtx.settings.get(DOCK_NS)
      const auth = value && value.remoteAuth
      return auth && auth.username && auth.passwordHash && auth.salt ? auth : null
    }
    async function saveAuth(username, password) {
      if (!settingsCtx || typeof settingsCtx.settings.mutate !== 'function') {
        const error = new Error('settings 服务未就绪，无法保存账号')
        error.statusCode = 500
        throw error
      }
      const salt = randomBytes(16).toString('hex')
      await settingsCtx.settings.mutate(DOCK_NS, [{
        op: 'set',
        path: ['remoteAuth'],
        value: { username, salt, passwordHash: hashPassword(salt, password) },
      }])
      // 账号密码变更：作废所有已登录设备，强制重新登录。
      if (gateway) gateway.revokeAllSessions()
    }
    async function verifyLogin(username, password) {
      const auth = getAuth()
      if (!auth) return false
      return sameText(username, auth.username) && sameText(hashPassword(auth.salt, password), auth.passwordHash)
    }

    /** 远程访问状态：网关、账号、浏览模式补丁、旧服务器模式残留。 */
    function lanStatus(webServer) {
      const file = serverPatchFile()
      let applied = false
      let webserverActive = false
      try {
        const list = readPatchList(file)
        applied = serverPatchApplied(list)
        webserverActive = legacyWebserverRowPresent(list)
      } catch { applied = false }
      const auth = getAuth()
      return {
        gatewayActive: Boolean(gateway),
        gatewayPort: gateway ? gateway.port : null,
        addresses: lanAddresses(),
        patchApplied: applied,
        webserverActive,
        accountSet: Boolean(auth),
        username: auth ? auth.username : '',
        patchPath: file,
      }
    }

    async function stopGateway() {
      const current = gateway
      gateway = null
      gatewayStarting = null
      if (current) await current.close()
    }

    /** 远程访问网关：上游即主实例；主实例保持仅本机，远程一律经账号登录进入。 */
    async function ensureGateway(webServer, requestedPort) {
      const port = Number(requestedPort === undefined || requestedPort === null || requestedPort === ''
        ? DEFAULT_GATEWAY_PORT : requestedPort)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        const error = new Error('局域网端口需为 1024 到 65535 之间的整数')
        error.statusCode = 400
        throw error
      }
      if (port === webServer.port) {
        const error = new Error(`局域网端口不能与 DSH 主服务端口 ${webServer.port} 相同`)
        error.statusCode = 400
        throw error
      }
      if (gateway && gateway.port === port) return gateway
      if (gateway) {
        const error = new Error(`局域网网关已在 ${gateway.port} 端口运行，请先关闭当前手机连接`)
        error.statusCode = 409
        throw error
      }
      // 上游即主实例：单实例架构下所有设备看到的就是同一个进程，任务状态天然同步。
      // 主实例保持仅本机 → 网关把 Host/Origin 改写成回环（回环恒被信任），
      // 远程设备必须先经过账号登录，不存在绕过登录的直连路径。
      if (!gatewayStarting) {
        gatewayStarting = startProtectedLanGateway({
          port,
          upstreamHost: '127.0.0.1',
          upstreamPort: webServer.port,
          spoofLoopback: true,
          verifyLogin,
        })
          .then((started) => { gateway = started; gatewayStarting = null; return started })
          .catch((error) => { gatewayStarting = null; throw error })
      }
      try { return await gatewayStarting }
      catch (cause) {
        const error = new Error(cause && cause.code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用，请换一个端口`
          : '无法开启局域网网关：' + ((cause && cause.message) || String(cause)))
        error.statusCode = 400
        throw error
      }
    }


    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      // 服务器模式下的主实例同样服务局域网浏览器：注入 crypto.randomUUID 兜底，
      // 修复非安全上下文下 DSH 客户端引导失败。回环/安全上下文下脚本自我短路，
      // 对本机使用零副作用。
      if (typeof wsCtx.webServer.tapIndex === 'function') {
        disposers.push(wsCtx.effect(() => wsCtx.webServer.tapIndex(injectLanCompat)))
      }
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/mobile-relay',
        async handler(req, res) {
          try {
            const method = routeMethod(req)
            const payload = await readBody(req)
            if (method === 'lan') {
              return sendJson(res, 200, { ok: true, data: lanStatus(wsCtx.webServer) })
            }
            if (method === 'auth/set') {
              // 设置/修改远程访问账号密码；改完作废所有已登录会话。
              const username = String((payload && payload.username) || '').trim()
              const password = String((payload && payload.password) || '')
              if (!username || username.length > 64) {
                const error = new Error('账号需为 1 到 64 个字符')
                error.statusCode = 400
                throw error
              }
              if (password.length < 6 || password.length > 128) {
                const error = new Error('密码至少 6 位、至多 128 位')
                error.statusCode = 400
                throw error
              }
              await saveAuth(username, password)
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer) } })
            }
            if (method === 'lan/start') {
              // 开启远程访问：网关监听 0.0.0.0（唯一远程入口，登录后才放行）；
              // 同时移除旧服务器模式行（主实例必须回到仅本机）并把目录选择器钉为浏览模式。
              const username = String((payload && payload.username) || '').trim()
              const password = String((payload && payload.password) || '')
              if (username && password) {
                if (!username || username.length > 64) {
                  const error = new Error('账号需为 1 到 64 个字符')
                  error.statusCode = 400
                  throw error
                }
                if (password.length < 6 || password.length > 128) {
                  const error = new Error('密码至少 6 位、至多 128 位')
                  error.statusCode = 400
                  throw error
                }
                await saveAuth(username, password)
              }
              if (!getAuth()) {
                const error = new Error('请先设置远程访问的账号和密码')
                error.statusCode = 400
                throw error
              }
              const file = serverPatchFile()
              const list = readPatchList(file) || []
              const changed = !serverPatchApplied(list) || legacyWebserverRowPresent(list)
              writePatchList(file, upsertRemotePatches(list))
              await ensureGateway(wsCtx.webServer, payload && payload.port)
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer), needsRestart: changed } })
            }
            if (method === 'lan/stop') {
              const file = serverPatchFile()
              const list = readPatchList(file)
              await stopGateway()
              if (list === null) {
                return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer), needsRestart: false } })
              }
              const changed = serverPatchApplied(list) || legacyWebserverRowPresent(list)
              if (changed) writePatchList(file, removeRemotePatches(list))
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer), needsRestart: changed } })
            }
            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } })
          } catch (error) {
            const status = error && error.statusCode ? error.statusCode : 500
            if (status >= 500) console.error('[dsh-dock] mobile relay HTTP error:', error && error.message)
            return sendJson(res, status, { ok: false, error: { code: status >= 500 ? 'internal' : 'bad-request', message: (error && error.message) || String(error) } })
          }
        },
      }), 'dsh-dock mobile relay: /dsh-dock/mobile-relay HTTP route')
    }))

    return () => {
      while (disposers.length) {
        const dispose = disposers.pop()
        try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
      }
      void stopGateway()
    }
  },
}
