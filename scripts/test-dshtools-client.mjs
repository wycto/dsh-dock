// dsh-dock · 【DSH功能】客户端接管契约测试
//
// 直接加载构建产物 client.js（与浏览器运行的是同一份代码），锁住：
//   1. 右键菜单贡献：target=file、id=dsh-dock.dshtools.file；>32 MiB 的文件返回「下载（大文件）」，
//      小文件返回空（不占位）；
//   2. 下载接管：宿主探针通过后，DSH 自带的 fileActions.save(download) 改为跳转
//      dsh-dock/download?path=…（不再走 32 MiB 的整文件 RPC）；非 /api/file 来源（如 data:）原样回调；
//   3. 探针失败（宿主旧版本 404）时不接管：调用原 save，行为与升级前一致。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'client.js'), 'utf8')

const LARGE = 45582474 // 与用户实际失败的 zip 同量级（43.5 MiB）
const ORIGIN = 'http://127.0.0.1:32100'
const FILE_URL = `${ORIGIN}/api/file?path=${encodeURIComponent('/www/data/x.zip')}`

function makeReact() {
	const createElement = (type, props, ...children) => ({ type, props: props || {}, children })
	return {
		createElement,
		Fragment: Symbol('Fragment'),
		Component: class Component { constructor(props) { this.props = props } render() { return null } },
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useReducer: (_r, init) => [init, () => {}],
		useEffect: () => {},
		useLayoutEffect: () => {},
		useRef: (value) => ({ current: value }),
		useMemo: (factory) => factory(),
		useCallback: (fn) => fn,
		memo: (component) => component,
		forwardRef: (component) => component,
		createContext: () => ({ Provider: null, Consumer: null }),
	}
}

// client.js 通过 window.__ModuleLoader__.load 暴露工厂；先装好加载器再执行 bundle。
function loadDock(options = {}) {
	const clicks = []
	const menus = []
	const originalSaveCalls = []
	const document = {
		baseURI: `${ORIGIN}/`,
		head: { appendChild() {} },
		body: { append() {}, appendChild() {} },
		querySelector: () => null,
		createElement(tag) {
			if (tag === 'style') return { dataset: {}, textContent: '', isConnected: false }
			return { href: '', download: '', rel: '', click() { clicks.push(this.href) }, remove() {} }
		},
	}
	const location = { origin: ORIGIN, href: `${ORIGIN}/` }
	const probeStatus = options.probeStatus ?? 204
	const fileBytes = options.fileBytes ?? LARGE
	const fetch = async (input) => {
		const url = String(input)
		if (url.startsWith('dsh-dock/download?probe=1')) return { ok: probeStatus < 400, status: probeStatus, json: async () => ({}) }
		if (url.startsWith('dsh-dock/dshtools')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					groups: [{
						id: 'fileContextMenu', name: '文件右键', description: '',
						items: [{ key: 'streamingDownload', name: '大文件下载（流式）', description: '', value: true }],
					}],
				}),
			}
		}
		if (url.startsWith('dsh-dock/features')) return { ok: true, status: 200, json: async () => ({ ok: true, data: { persisted: {} } }) }
		return { ok: true, status: 200, json: async () => ({ ok: true }) }
	}
	const stored = new Map()
	const localStorage = {
		getItem: (k) => (stored.has(k) ? stored.get(k) : null),
		setItem: (k, v) => { stored.set(k, String(v)) },
		removeItem: (k) => { stored.delete(k) },
		clear: () => stored.clear(),
	}
	const fileActions = {
		canSaveAs: false,
		async save(source, mode) {
			originalSaveCalls.push({ source, mode })
			return { status: 'saved', path: 'original-path' }
		},
	}
	const services = {
		fileActions,
		contextMenus: { register(def) { menus.push(def); return () => {} } },
		remote: {
			workspaceFiles: {
				async stat(_sessionId, path) { return { ok: true, value: { absolutePath: path, version: 'v', bytes: fileBytes } } },
			},
		},
		slots: { inject(_name, cb) { cb(); return () => {} }, register() { return () => {} } },
	}
	const scope = {
		get: (name) => services[name],
		effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {} },
		...services,
	}
	const ctx = {
		get: (name) => services[name],
		inject(names, cb) { cb(scope); return () => {} },
		effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {} },
		interval: () => () => {},
	}
	const sandbox = {
		document, location, fetch, localStorage,
		setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
		console, URL, URLSearchParams, AbortController,
		navigator: { clipboard: { write: async () => {} } },
		queueMicrotask,
		__moduleFactories: {},
	}
	let factory = null
	sandbox.window = sandbox
	sandbox.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
	sandbox.globalThis = sandbox
	vm.createContext(sandbox)
	vm.runInContext(bundle, sandbox, { filename: 'client.js' })
	if (!factory) throw new Error('client.js 没有向 __ModuleLoader__ 注册工厂')
	const react = makeReact()
	const dock = factory((id) => {
		if (id === 'react') return react
		if (id === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment }
		throw new Error(`bundle 请求了未提供的模块：${id}`)
	})
	dock.apply(ctx)
	return { dock, ctx, menus, clicks, fileActions, originalSaveCalls }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function main() {
	// 1) 大文件：接管生效，save 走流式路由
	{
		const { menus, clicks, fileActions, originalSaveCalls } = loadDock()
		await tick(); await tick()
		const provider = menus.find((m) => m && m.id === 'dsh-dock.dshtools.file')
		assert.ok(provider, '必须注册 target=file 的右键菜单贡献')
		assert.equal(provider.target, 'file')
		const actions = await provider.resolve({ sessionId: 's1', path: '/www/data/x.zip' }, new AbortController().signal)
		assert.equal(actions.length, 1, '>32 MiB 的文件应出现「下载（大文件）」')
		assert.equal(actions[0].label, '下载（大文件）')

		const result = await fileActions.save({ url: FILE_URL, name: 'x.zip' }, 'download')
		// VM 内创建的对象跨 realm，不能 deepStrictEqual；按字段断言
		assert.equal(result && result.status, 'requested', '接管后返回 requested')
		assert.equal(originalSaveCalls.length, 0, '接管后不得调用原来的整文件读取')
		assert.equal(clicks.length, 1)
		assert.ok(clicks[0].includes('/dsh-dock/download?path='), '跳转的是本模块下载路由：' + clicks[0])
		assert.ok(clicks[0].includes(encodeURIComponent('/www/data/x.zip')), '路径必须编码后带上')
	}

	// 2) 小文件：菜单不占位；非 /api/file 来源原样回调
	{
		const { menus, fileActions, originalSaveCalls } = loadDock({ fileBytes: 1024 })
		await tick(); await tick()
		const provider = menus.find((m) => m && m.id === 'dsh-dock.dshtools.file')
		assert.ok(provider, '菜单贡献仍应注册')
		const actions = await provider.resolve({ sessionId: 's1', path: '/www/data/small.txt' }, new AbortController().signal)
		assert.equal(actions.length, 0, '小文件不出现额外条目')
		const result = await fileActions.save({ url: 'data:image/png;base64,AAAA' }, 'download')
		assert.equal(result && result.status, 'saved')
		assert.equal(originalSaveCalls.length, 1)
	}

	// 3) 探针失败（宿主旧版本）：不接管，调用原 save
	{
		const { fileActions, originalSaveCalls, clicks } = loadDock({ probeStatus: 404 })
		await tick(); await tick()
		const result = await fileActions.save({ url: FILE_URL, name: 'x.zip' }, 'download')
		assert.equal(result && result.status, 'saved', '探针失败时保持原行为')
		assert.equal(originalSaveCalls.length, 1)
		assert.equal(clicks.length, 0)
	}

	console.log('dshtools client: ok')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
