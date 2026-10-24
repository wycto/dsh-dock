// dsh-dock · 宿主半部【模型余额】契约测试
//
// 2026-10-24 新增「DeepSeek 账号」余额来源：这条官方 Provider 没有 API Key 余额接口，
// 余额在官网站内（设置 → 模型 →「DeepSeek 账号 · 已登录」的同一份登录态）。
// 宿主半部改走 ctx.get('deepseekAccount') 服务（getState + getBalance），
// 本用例锁住它的投影与错误语义：
//   ready      → ok + currency infos（充值/赠送分列，多币种按 CNY→USD 排序，全零币种隐藏）
//   signed-out → login-required + 官网控制台链接
//   null       → login-required（登录失效，平台 401 时账号服务会清掉 grant）
//   failed     → error（失败绝不伪装成 0 余额）
//   服务未挂载 → unsupported（提示去设置里登录），而不是笼统的「无余额接口」
// 以及传给账号服务的 client metadata 形状（Platform 用它生成 x-client-* 请求头）。
import assert from 'node:assert/strict'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { feature as balanceFeature } from '../features/balance/host.js'

// ---------- 桩：最小 ctx + req/res（与 test-route-trust-host.mjs 同款） ----------
function makeRes() {
	return {
		status: 0,
		body: null,
		headers: null,
		writeHead(status, headers) { this.status = status; this.headers = headers || null; return this },
		end(text) { this.body = text ? JSON.parse(text) : null; return this },
	}
}
function makeReq(url, method) {
	return {
		url,
		method,
		headers: {},
		resume() {},
		destroy() {},
		on() { return this },
	}
}
function makeCtx(services = {}) {
	const routes = new Map()
	const ctx = {
		get(name) {
			if (name === 'connection') return { requestRejection: () => undefined }
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
async function callRoute(handler, url) {
	const res = makeRes()
	const req = makeReq(url, 'GET')
	await handler(req, res)
	return res
}

const ACCOUNT = {
	provider: 'deepseek-account',
	displayName: 'DeepSeek Account',
	settingsNs: 'llm-deepseek-account',
	settingsPath: [],
}

/**
 * 架一个「默认 provider 是 DeepSeek 账号」的宿主桩。
 * account 为 undefined 表示宿主没挂账号服务；account === 'throw' 表示 get() 抛错。
 */
function makeHost({ account, providers = [ACCOUNT], selection = { provider: 'deepseek-account', model: 'deepseek-flash' }, describe } = {}) {
	const services = {
		llm: { listConfigurableProviders() { return providers } },
		settings: {
			describe() {
				if (describe) return describe
				return [{ ns: 'llm-deepseek-account', revision: 0, user: {}, base: {}, value: {} }]
			},
		},
		agentDefaultModel: { currentSelection() { return selection } },
		credentials: { async describe() { return { configured: true } } },
	}
	if (account !== undefined) services.deepseekAccount = account
	const { ctx, routes } = makeCtx(services)
	balanceFeature.setup(ctx)
	return { ctx, routes, services }
}

async function queryBalance(host) {
	const res = await callRoute(host.routes.get('/dsh-dock/balance'), '/dsh-dock/balance')
	assert.equal(res.status, 200)
	assert.ok(Array.isArray(res.body.providers))
	const account = res.body.providers.find((p) => p.id === 'deepseek-account')
	return { res, account, providers: res.body.providers }
}

// ================= ① ready：钱包投影与 client metadata =================
{
	const seenClients = []
	const host = makeHost({
		account: {
			async getState() {
				return { status: 'credential-stored', links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' }, attempt: undefined }
			},
			async getBalance(client) {
				seenClients.push(client)
				return {
					status: 'ready',
					value: [{ currency: 'CNY', balance: '123.45' }],
					bonusWallets: [{ currency: 'CNY', balance: '10' }, { currency: 'USD', balance: '0' }],
				}
			},
		},
	})
	const { account, providers } = await queryBalance(host)
	assert.equal(providers.length, 1)
	assert.equal(account.displayName, 'DeepSeek 账号', '账号 Provider 应显示中文名，而不是宿主的 DeepSeek Account')
	assert.equal(account.apiKeyEnv, null, '账号 Provider 不使用 API Key')
	assert.deepEqual(account.models, ['deepseek-flash'])
	assert.equal(account.balance.status, 'ok')
	assert.equal(account.balance.kind, 'currency')
	assert.deepEqual(account.balance.infos, [
		{ currency: 'CNY', totalBalance: '133.45', grantedBalance: '10', toppedUpBalance: '123.45' },
	], '充值钱包→toppedUp、赠送钱包→granted；0 美元的币种应隐藏')

	assert.equal(seenClients.length, 1)
	const client = seenClients[0]
	assert.equal(client.version, APP_IDENTITY.version, 'client version 取宿主 APP_IDENTITY.version')
	assert.equal(client.locale, 'zh-CN')
	assert.equal(Number.isInteger(client.timezoneOffsetSeconds), true, '时区必须是整数秒')
	assert.ok(Math.abs(client.timezoneOffsetSeconds) <= 14 * 3600, '时区偏移应在 ±14h 内')
	assert.equal(client.timezoneOffsetSeconds, -new Date().getTimezoneOffset() * 60, '时区正值=东经秒')
	console.log('balance account ready: ok（充值/赠送分列、零币种隐藏、metadata 形状正确）')
}

// ================= ② 未登录 → login-required（带官网链接） =================
{
	const host = makeHost({
		account: {
			async getState() {
				return { status: 'signed-out', links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }
			},
			async getBalance() { throw new Error('未登录时不应调用 getBalance') },
		},
	})
	const { account } = await queryBalance(host)
	assert.equal(account.balance.status, 'login-required')
	assert.equal(account.balance.consoleUrl, 'https://platform.deepseek.com/usage')
	assert.match(account.balance.message, /未登录/)
	console.log('balance account signed-out: ok（login-required + 控制台链接，未调用 getBalance）')
}

// ================= ③ getBalance 返回 null（登录失效）→ login-required =================
{
	const host = makeHost({
		account: {
			async getState() { return { status: 'credential-stored', links: {} } },
			async getBalance() { return null },
		},
	})
	const { account } = await queryBalance(host)
	assert.equal(account.balance.status, 'login-required')
	assert.match(account.balance.message, /失效/)
	assert.equal(account.balance.consoleUrl, 'https://platform.deepseek.com/usage', '缺 links.usageUrl 时用兜底地址')
	console.log('balance account expired: ok（null → login-required，兜底控制台地址）')
}

// ================= ④ 平台失败 → error（不是 ok / 0 余额） =================
{
	const host = makeHost({
		account: {
			async getState() { return { status: 'credential-stored', links: {} } },
			async getBalance() { return { status: 'failed' } },
		},
	})
	const { account } = await queryBalance(host)
	assert.equal(account.balance.status, 'error')
	assert.match(account.balance.message, /平台接口返回失败/)
	console.log('balance account failed: ok（失败不投影成 0 余额）')
}

// ================= ⑤ 宿主未挂载账号服务 → unsupported（明确提示登录） =================
{
	const host = makeHost({ account: undefined })
	const { account } = await queryBalance(host)
	assert.equal(account.balance.status, 'unsupported')
	assert.match(account.balance.message, /未挂载 DeepSeek 账号服务/)
	console.log('balance account missing service: ok（unsupported 且提示登录）')
}

// ================= ⑥ 账号服务自身抛错 → error（带原因） =================
{
	const host = makeHost({
		account: {
			async getState() { throw new Error('storage broken') },
			async getBalance() { return null },
		},
	})
	const { account } = await queryBalance(host)
	assert.equal(account.balance.status, 'error')
	assert.match(account.balance.message, /读取 DeepSeek 账号状态失败：storage broken/)

	const host2 = makeHost({
		account: {
			async getState() { return { status: 'credential-stored', links: {} } },
			async getBalance() { throw new Error('network down') },
		},
	})
	const second = await queryBalance(host2)
	assert.equal(second.account.balance.status, 'error')
	assert.match(second.account.balance.message, /查询官网余额失败：network down/)
	console.log('balance account errors: ok（getState / getBalance 抛错都转 error 并带原因）')
}

// ================= ⑦ 全零钱包兜底 & 非零优先排序 =================
{
	const host = makeHost({
		account: {
			async getState() { return { status: 'credential-stored', links: {} } },
			async getBalance() {
				return {
					status: 'ready',
					value: [{ currency: 'USD', balance: '0E-16' }, { currency: 'CNY', balance: '0' }],
					bonusWallets: [],
				}
			},
		},
	})
	const { account } = await queryBalance(host)
	assert.equal(account.balance.status, 'ok')
	assert.deepEqual(account.balance.infos, [
		{ currency: 'CNY', totalBalance: '0', grantedBalance: '0', toppedUpBalance: '0' },
	], '全零钱包只留一张 CNY 0 兜底卡，并保持 CNY 在前')
	console.log('balance account zero wallets: ok（全零兜底一张 CNY 0，顺序仍 CNY→USD）')
}

// ================= ⑧ 账号分支不影响普通 Provider =================
{
	const host = makeHost({
		account: undefined,
		providers: [
			ACCOUNT,
			{ provider: 'mystery-provider', displayName: 'Mystery', settingsNs: 'llm-mystery', settingsPath: [] },
		],
		describe: [
			{ ns: 'llm-mystery', revision: 0, user: {}, base: {}, value: {} },
		],
	})
	const { providers } = await queryBalance(host)
	const mystery = providers.find((p) => p.id === 'mystery-provider')
	assert.ok(mystery, '非账号 Provider 仍应出现在列表里')
	assert.equal(mystery.balance.status, 'unsupported')
	assert.equal(mystery.balance.message, '该 Provider 没有已知的余额查询接口')
	assert.equal(providers.find((p) => p.id === 'deepseek-account').balance.status, 'unsupported')
	console.log('balance account isolation: ok（账号分支只拦截 deepseek-account）')
}

console.log('balance host: 全部通过')
