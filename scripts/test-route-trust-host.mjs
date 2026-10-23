// dsh-dock · 宿主半部「浏览器信任栅栏」契约测试
//
// 背景（真实缺口，2026-10-14 修）：webServer 的命名路由由载体直接派发给 handler，
// 载体本身「不拥有认证或 Origin 策略」；`/api` 的 Host/Origin 校验与会话认证由
// Connection 在它自己的 FetchHandler 上做，**管不到插件注册的命名路由**。
// 于是不挂守卫的路由就是一扇对任何能连到端口的人都敞开的门：例如
//   POST /dsh-dock/mobile-relay {method:'auth/set'|'lan/start'}  → 改远程访问账号、开 0.0.0.0 网关
//   POST /dsh-dock/models {action:'listModels', baseURL:'<攻击者>'}+apiKeyEnv → 用本机凭据出站
// 修法：每个路由入口先调 host-core 的 rejectUntrustedRequest（内部走
// connection.requestRejection，与官方 dsh-host-open-in-app / inspector 同款）。
//
// 本用例锁两件事：
//   ① 行为：被拒绝时回 401/403 且不进入业务逻辑；放行时照常；
//   ② 静态约定：index.js 与 features/*/host.js 里每一处 webServer.register 之后
//      都必须出现 rejectUntrustedRequest —— 防新路由漏挂守卫（这是防回归的关键一条）。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feature as balanceFeature } from '../features/balance/host.js'
import { feature as providerFeature } from '../features/providerconfig/host.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 桩：最小 ctx + req/res ----------
function makeRes() {
	return {
		status: 0,
		body: null,
		headers: null,
		writeHead(status, headers) { this.status = status; this.headers = headers || null; return this },
		end(text) { this.body = text ? JSON.parse(text) : null; return this },
	}
}
function makeReq(url, method, payload) {
	const listeners = { data: [], end: [], error: [] }
	const req = {
		url,
		method,
		headers: {},
		resume() {},
		destroy() {},
		on(event, cb) { (listeners[event] || (listeners[event] = [])).push(cb); return req },
		__dispatch() {
			const raw = payload === undefined ? '' : JSON.stringify(payload)
			for (const cb of listeners.data) cb(Buffer.from(raw, 'utf8'))
			for (const cb of listeners.end) cb()
		},
	}
	return req
}

/**
 * 宿主桩：rejection 为 undefined/401/403；'absent' 表示组合里没有 connection 服务。
 * services 提供 settings/llm/credentials 等；routes 收集注册的路由 handler。
 */
function makeCtx({ rejection = undefined, services = {}, probes = {} } = {}) {
	const routes = new Map()
	const ctx = {
		get(name) {
			if (probes[name] !== undefined) probes[name] += 1
			if (name === 'connection') {
				return rejection === 'absent' ? undefined : { requestRejection: () => rejection }
			}
			if (name === 'webServer') {
				return {
					register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
				}
			}
			return services[name]
		},
		effect(run) { const off = run(); return typeof off === 'function' ? off : () => {} },
		inject(keys, callback) { callback(ctx); return () => {} },
	}
	return { ctx, routes }
}

async function callRoute(handler, url, method = 'GET', payload = undefined) {
	const res = makeRes()
	const req = makeReq(url, method, payload)
	const pending = handler(req, res)
	req.__dispatch()
	await pending
	return res
}

// ================= ① 静态约定：每处路由注册都必须挂守卫 =================
{
	const files = [join(root, 'index.js')]
	for (const entry of readdirSync(join(root, 'features'), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		files.push(join(root, 'features', entry.name, 'host.js'))
	}
	let registrations = 0
	for (const file of files) {
		let text
		try {
			text = readFileSync(file, 'utf8')
		} catch { continue }
		let at = text.indexOf('webServer.register(')
		while (at >= 0) {
			registrations += 1
			// handler 可能内联在注册点之后，也可能先定义成 handler 再注册（balance）：
			// 前后各取一段，守卫必须出现在这段里。
			const window = text.slice(Math.max(0, at - 2500), at + 2000)
			assert.ok(
				window.includes('rejectUntrustedRequest('),
				`${file.replace(root, '')} 的路由注册未挂 rejectUntrustedRequest（任何能连到端口的人都能直接调用它）`,
			)
			at = text.indexOf('webServer.register(', at + 1)
		}
	}
	assert.ok(registrations >= 9, `路由注册点数量异常：只找到 ${registrations} 处`)
	console.log(`route trust static: ok（${registrations} 处路由注册全部挂上浏览器信任栅栏）`)
}

// ================= ② 行为：拒绝时 401/403，且不进入业务逻辑 =================
{
	for (const rejection of [401, 403]) {
		const probes = { llm: 0, settings: 0 }
		const { ctx, routes } = makeCtx({ rejection, probes })
		balanceFeature.setup(ctx)
		const res = await callRoute(routes.get('/dsh-dock/balance'), '/dsh-dock/balance')
		assert.equal(res.status, rejection, `balance 路由应以 ${rejection} 拒绝`)
		assert.equal(res.body.error.code, 'untrusted')
		assert.equal(probes.llm, 0, '被拒绝的请求不得触到 llm（业务逻辑未进入）')
	}
	// 组合里没有 connection 服务：按 fail-closed 处理
	{
		const { ctx, routes } = makeCtx({ rejection: 'absent' })
		balanceFeature.setup(ctx)
		const res = await callRoute(routes.get('/dsh-dock/balance'), '/dsh-dock/balance')
		assert.equal(res.status, 401, '缺少信任栅栏时必须拒绝（fail-closed）')
	}
	console.log('route trust behavior: ok（401 / 403 / 栅栏缺失 fail-closed，且都未进入业务逻辑）')
}

// ================= ③ 行为：放行时照常，且【模型提供商】的写接口确实带守卫 =================
{
	const mutateCalls = []
	const settingsService = {
		describe() {
			return [
				{
					ns: 'llm-deepseek', revision: 0, user: {}, base: {},
					value: { baseURL: 'https://api.deepseek.com', thinking: 'enabled', reasoningEffort: 'high', models: [{ id: 'deepseek-chat' }] },
				},
				{
					ns: 'llm-pi-ai', revision: 7,
					user: { providers: { modelscope: { displayName: '魔搭 ModelScope', api: 'openai-completions', baseURL: 'https://api.example/v1', apiKeyEnv: 'MODELSCOPE_API_KEY', models: [{ id: 'qwen-vl' }] } } },
					base: {},
					value: { providers: { modelscope: { displayName: '魔搭 ModelScope', models: [{ id: 'qwen-vl' }] } } },
				},
			]
		},
		async mutate(ns, ops) { mutateCalls.push({ ns, ops }) },
	}
	const services = {
		settings: settingsService,
		credentials: { async describe() { return { configured: true } }, async set() {}, async resolve() { return '' } },
		llm: {
			listConfigurableProviders() {
				return [
					{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
					{ provider: 'modelscope', displayName: '魔搭 ModelScope', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'modelscope'] },
				]
			},
		},
	}

	// 放行：GET 返回 Provider 列表 + 密钥状态
	const trusted = makeCtx({ services })
	providerFeature.setup(trusted.ctx)
	const list = await callRoute(trusted.routes.get('/dsh-dock/providerconfig'), '/dsh-dock/providerconfig')
	assert.equal(list.status, 200)
	assert.equal(list.body.providers.length, 2)
	const modelscope = list.body.providers.find((p) => p.id === 'modelscope')
	assert.equal(modelscope.apiKeyConfigured, true, 'apiKeyConfigured 应来自凭据库状态')
	assert.equal(list.body.revisions['llm-pi-ai'], 7)

	// 被拒绝：同一个路由下写操作一律不落地
	const denied = makeCtx({ rejection: 401, services })
	providerFeature.setup(denied.ctx)
	const deniedPost = await callRoute(denied.routes.get('/dsh-dock/providerconfig'), '/dsh-dock/providerconfig', 'POST', {
		action: 'create', route: 'acme', profile: { api: 'openai-completions', baseURL: 'https://acme.example/v1', models: [{ id: 'm1' }] },
	})
	assert.equal(deniedPost.status, 401)
	assert.equal(mutateCalls.length, 0, '被拒绝的写请求不得写 settings')

	// 放行但参数非法：4xx 且不写盘、不出站
	const badRoute = await callRoute(trusted.routes.get('/dsh-dock/providerconfig'), '/dsh-dock/providerconfig', 'POST', {
		action: 'create', route: '9 bad!', profile: { api: 'openai-completions', baseURL: 'https://acme.example/v1', models: [{ id: 'm1' }] },
	})
	assert.equal(badRoute.status, 400)
	const badList = await callRoute(trusted.routes.get('/dsh-dock/providerconfig'), '/dsh-dock/providerconfig', 'POST', {
		action: 'listModels', baseURL: 'ftp://acme.example',
	})
	assert.equal(badList.status, 400, 'baseURL 只接受 http/https，非法值不得出站')
	const delMissing = await callRoute(trusted.routes.get('/dsh-dock/providerconfig'), '/dsh-dock/providerconfig', 'POST', {
		action: 'delete', route: 'nope',
	})
	assert.equal(delMissing.status, 400)
	assert.equal(mutateCalls.length, 0, '校验失败的请求一律不写 settings')
	console.log('provider config host: ok（信任栅栏 + Provider 列表/密钥状态 + 参数校验 4xx 不落盘）')
}

console.log('route trust + provider config: 全部通过')
