// dsh-dock · 宿主半部【DSH功能】契约测试
//
// 锁住四件事：
//   1. 信任栅栏：connection 拒绝（401）时，设置与下载路由都原样返回，不落到业务逻辑；
//   2. 设置读写：GET 返回「分组 × 勾选项」清单（含默认值），POST 单项切换后落库并回读一致，
//      未知分组/键、非布尔值一律 400；
//   3. 下载路由：流式分块发送（Content-Length 与拼回的字节一致）、Content-Disposition 的
//      RFC 5987 中文文件名编码、HEAD 只回头、fs 的 FS_NOT_FOUND/非普通文件映射成 404/403；
//   4. 生命周期：setup 返回的 disposer 必须把两条路由都摘掉。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { feature, LARGE_FILE_BYTES, readDshtoolsValues } from '../features/dshtools/host.js'
import { seedDockConfig } from '../src/host-core.js'

// ---------- 桩：最小 ctx + req/res（与 test-balance-host.mjs 同款） ----------
function makeRes() {
	const res = {
		status: 0,
		headers: null,
		chunks: [],
		headersSent: false,
		ended: false,
		destroyed: false,
		writeHead(status, headers) { this.status = status; this.headers = headers || null; this.headersSent = true; return this },
		write(chunk) { this.chunks.push(Buffer.from(chunk)); return true },
		end(body) { if (body) this.chunks.push(Buffer.from(body)); this.ended = true; return this },
		on() { return this },
		once() { return this },
		off() { return this },
		resume() {},
		destroy() { this.destroyed = true },
	}
	return res
}

/** Node 风格 req：POST 体经 data/end 事件异步送到（readBody 是事件读取）。 */
function makeReq(url, method = 'GET', body) {
	const req = new EventEmitter()
	req.url = url
	req.method = method
	req.headers = {}
	req.resume = () => {}
	req.destroy = () => {}
	if (body !== undefined) {
		setImmediate(() => {
			req.emit('data', Buffer.from(JSON.stringify(body)))
			req.emit('end')
		})
	}
	return req
}

/** 触发路由并等 res.end（处理函数自身不 await）。 */
function callRoute(handler, req) {
	return new Promise((resolve) => {
		const res = makeRes()
		const end = res.end.bind(res)
		res.end = (value) => { end(value); resolve(res) }
		handler(req, res)
	})
}

function jsonOf(res) {
	return JSON.parse(Buffer.concat(res.chunks).toString('utf8'))
}

/** 假文件系统：内容为 Buffer，按窗口切片返回。 */
function makeFs(content, overrides = {}) {
	const target = { key: 'target' }
	return {
		async resolve(path) {
			if (path === '/missing') {
				const error = new Error('cannot resolve "/missing": not found')
				error.code = 'FS_NOT_FOUND'
				throw error
			}
			if (path === '/denied') {
				const error = new Error('permission denied')
				error.code = 'FS_PERMISSION_DENIED'
				throw error
			}
			return target
		},
		async stat() {
			if (overrides.stat) return overrides.stat()
			return { type: 'file', size: content.length, version: 'v1' }
		},
		async readByteRange(_target, { offset, length }) {
			return content.subarray(offset, offset + length)
		},
	}
}

function makeCtx({ rejection, fs, settings } = {}) {
	const routes = new Map()
	const ctx = {
		get(name) {
			if (name === 'connection') return { requestRejection: () => rejection }
			if (name === 'webServer') {
				return { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
			}
			if (name === 'settings') return settings || { mutate: async () => {} }
			if (name === 'fs') return fs
			return undefined
		},
		effect(run) { const off = run(); return typeof off === 'function' ? off : () => {} },
		inject(_keys, callback) { callback(ctx); return () => {} },
	}
	return { ctx, routes }
}

const jsonReq = (body) => makeReq('/dsh-dock/dshtools', 'POST', body)

async function main() {
	// ---------- 1. 信任栅栏 + 生命周期 ----------
	seedDockConfig({})
	{
		const { ctx, routes } = makeCtx({ rejection: 401, fs: makeFs(Buffer.from('x')) })
		const dispose = feature.setup(ctx)
		assert.equal((await callRoute(routes.get('/dsh-dock/dshtools'), makeReq('/dsh-dock/dshtools'))).status, 401)
		const download = await callRoute(routes.get('/dsh-dock/download'), makeReq('/dsh-dock/download?path=%2Ftmp%2Fa'))
		assert.equal(download.status, 401)
		dispose()
		assert.equal(routes.size, 0, 'disposer 必须摘掉两条路由')
	}

	// ---------- 2. 设置读写 ----------
	seedDockConfig({})
	{
		const { ctx, routes } = makeCtx({ fs: makeFs(Buffer.from('x')) })
		const dispose = feature.setup(ctx)
		const settings = routes.get('/dsh-dock/dshtools')

		const get1 = await callRoute(settings, makeReq('/dsh-dock/dshtools'))
		assert.equal(get1.status, 200)
		const body1 = jsonOf(get1)
		assert.equal(body1.ok, true)
		const group = body1.groups.find((g) => g.id === 'fileContextMenu')
		assert.ok(group, '必须返回「文件右键」分组')
		assert.equal(group.items.find((i) => i.key === 'streamingDownload').value, true, '默认勾选')
		assert.equal(LARGE_FILE_BYTES, 32 * 1024 * 1024, '阈值与 DSH 的 maxFileBytes 默认值一致')

		const post = await callRoute(settings, jsonReq({ group: 'fileContextMenu', key: 'streamingDownload', value: false }))
		assert.equal(post.status, 200)
		const body2 = jsonOf(post)
		assert.equal(body2.groups.find((g) => g.id === 'fileContextMenu').items[0].value, false, 'POST 回读立刻反映新值')
		assert.deepEqual(readDshtoolsValues(ctx), { fileContextMenu: { streamingDownload: false } }, '写回 settings 的 dshtools 段')

		const get2 = jsonOf(await callRoute(settings, makeReq('/dsh-dock/dshtools')))
		assert.equal(get2.groups.find((g) => g.id === 'fileContextMenu').items[0].value, false)

		// 非法输入
		assert.equal((await callRoute(settings, jsonReq({ group: 'nope', key: 'streamingDownload', value: false }))).status, 400)
		assert.equal((await callRoute(settings, jsonReq({ group: 'fileContextMenu', key: 'nope', value: false }))).status, 400)
		assert.equal((await callRoute(settings, jsonReq({ group: 'fileContextMenu', key: 'streamingDownload', value: 'no' }))).status, 400)
		assert.equal((await callRoute(settings, makeReq('/dsh-dock/dshtools', 'PUT'))).status, 405)
		dispose()
	}

	// ---------- 3. 下载路由 ----------
	seedDockConfig({})
	{
		const chunk = 1024 * 1024
		const content = Buffer.alloc(chunk * 2 + 1234)
		for (let i = 0; i < content.length; i++) content[i] = i % 251
		const { ctx, routes } = makeCtx({ fs: makeFs(content) })
		const dispose = feature.setup(ctx)
		const download = routes.get('/dsh-dock/download')
		const url = '/dsh-dock/download?path=' + encodeURIComponent('/tmp/部署说明.md')

		const res = await callRoute(download, makeReq(url))
		assert.equal(res.status, 200)
		assert.equal(res.headers['content-type'], 'application/octet-stream')
		assert.equal(res.headers['content-length'], String(content.length))
		assert.equal(res.headers['cache-control'], 'private, no-store')
		assert.equal(res.headers['x-content-type-options'], 'nosniff')
		// RFC 5987：中文名必须走 filename*，ASCII 兜底只含可打印字符
		const disposition = res.headers['content-disposition']
		assert.match(disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/)
		assert.ok(disposition.includes(encodeURIComponent('部署说明.md').replace(/'/g, '%27')), 'Chinese filename UTF-8 encoded')
		assert.ok(Buffer.concat(res.chunks).equals(content), '拼回的字节必须与原文件一致')
		assert.ok(res.chunks.length >= 3, '必须分块发送，而不是整份一次写出')

		// HEAD：只回头
		const head = await callRoute(download, makeReq(url, 'HEAD'))
		assert.equal(head.status, 200)
		assert.equal(head.headers['content-length'], String(content.length))
		assert.equal(Buffer.concat(head.chunks).length, 0)

		// 客户端探针：204、无 body（路由存在且过了信任栅栏的证明）
		const probe = await callRoute(download, makeReq('/dsh-dock/download?probe=1', 'HEAD'))
		assert.equal(probe.status, 204)
		assert.equal(Buffer.concat(probe.chunks).length, 0)

		// 参数/错误映射
		assert.equal((await callRoute(download, makeReq('/dsh-dock/download'))).status, 400)
		assert.equal((await callRoute(download, makeReq('/dsh-dock/download?path=relative'))).status, 400)
		assert.equal((await callRoute(download, makeReq('/dsh-dock/download?path=%2Fmissing'))).status, 404)
		assert.equal((await callRoute(download, makeReq('/dsh-dock/download?path=%2Fdenied'))).status, 403)
		assert.equal((await callRoute(download, makeReq('/dsh-dock/download?path=%2Ftmp%2Fa', 'POST'))).status, 405)
		dispose()
	}

	// 目录不是普通文件 → 403
	seedDockConfig({})
	{
		const fs = makeFs(Buffer.from('x'), { stat: async () => ({ type: 'directory', size: 0 }) })
		const { ctx, routes } = makeCtx({ fs })
		const dispose = feature.setup(ctx)
		const res = await callRoute(routes.get('/dsh-dock/download'), makeReq('/dsh-dock/download?path=%2Ftmp'))
		assert.equal(res.status, 403)
		dispose()
	}

	// 后端不报大小时（无 content-length）：仍按块读到短读结束
	seedDockConfig({})
	{
		const content = Buffer.alloc(1024 * 1024 + 17, 7)
		const fs = makeFs(content, { stat: async () => ({ type: 'file' }) })
		const { ctx, routes } = makeCtx({ fs })
		const dispose = feature.setup(ctx)
		const res = await callRoute(routes.get('/dsh-dock/download'), makeReq('/dsh-dock/download?path=%2Ftmp%2Fa'))
		assert.equal(res.status, 200)
		assert.equal(res.headers['content-length'], undefined)
		assert.ok(Buffer.concat(res.chunks).equals(content), '无 Content-Length 时也要发完整文件')
		dispose()
	}

	console.log('dshtools host: ok')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
