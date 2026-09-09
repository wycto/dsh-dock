// dsh-dock · 宿主共享内核：会话级任务追踪（【任务动画】【任务通知】【运行状态】共用一份数据）
//
// 为什么单独成模块：动画、通知与运行状态都需要「任务什么时候开始/结束、现在在干什么」，
// 但三者是各自独立开关的功能模块（可只开其一，也可各自提取成独立包发布）。
// 追踪逻辑放这里、用引用计数共享一份实例：三个功能都开也只有一份追踪（会话事件只订阅一次），
// 全都关则立刻退订，不留下常驻开销。
//
// 用法（features/<id>/host.js）：
//   const lease = acquireTaskTracker(ctx)
//   disposers.push(() => lease.release())
//   lease.tracker.snapshot(Date.now())          // → { now, active: [...], recent: [...] }
//   const off = lease.tracker.onFinish((rec) => { ... })  // 任务结束回调（群机器人推送用）
//
// 数据形状（active/recent）由客户端各模块消费，字段改动要同时看：
//   features/runstate/view.jsx、features/animation/view.jsx、features/notify/view.jsx

/** 最近完成记录保留条数（新→旧）。 */
const MAX_COMPLETED = 30

/** 当前共享实例（引用计数 > 0 时存在）。 */
let shared = null

/**
 * 取得共享追踪器租约。返回 { tracker, release }：
 * 每个使用方在 setup 时 acquire、在 dispose 时 release（必须成对，否则追踪不会退订）。
 */
export function acquireTaskTracker(ctx) {
	if (!shared) shared = { refs: 0, tracker: createTracker(ctx) }
	const slot = shared
	slot.refs += 1
	let released = false
	return {
		tracker: slot.tracker,
		release() {
			if (released) return
			released = true
			slot.refs -= 1
			if (slot.refs > 0) return
			if (shared === slot) shared = null
			try { slot.tracker.dispose() } catch { /* 退订失败不影响功能停用 */ }
		},
	}
}

function createTracker(ctx) {
	// ===== 会话级任务追踪（agent/status 驱动开始/结束，session/event 补统计） =====
	const activeSessions = new Map() // sessionId -> 追踪记录
	const completedSessions = [] // 最近完成（新→旧）
	const finishListeners = new Set()
	const disposers = []

	function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

	function extractText(content) {
		if (!Array.isArray(content)) return ''
		const parts = []
		for (const block of content) {
			if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
		}
		return parts.join(' ').replace(/\s+/g, ' ').trim()
	}

	function truncate(str, max = 160) {
		if (!str) return ''
		return String(str).length > max ? String(str).slice(0, max) + '…' : str
	}

	// 工具名 → 阶段：检索类工具 = search，其余 = code
	function phaseOfToolName(name) {
		const n = String(name || '').toLowerCase()
		if (/web|search|fetch|grep|glob|find|read|ls$|^ls|tree|locate/.test(n)) return 'search'
		return 'code'
	}

	// 会话标题：官方标题服务，取不到回退首条用户输入（firstPrompt）
	async function getSessionTitle(sessionId, sessionQuery) {
		try {
			if (!sessionQuery) return ''
			if (typeof sessionQuery.readTitle === 'function') {
				const snap = await sessionQuery.readTitle(sessionId)
				if (snap && snap.title) return snap.title
			}
			if (typeof sessionQuery.readSession === 'function') {
				const snap = await sessionQuery.readSession(sessionId)
				if (snap && snap.header && snap.header.title) return snap.header.title
			}
		} catch { /* 标题取不到就用 firstPrompt 兜底 */ }
		return ''
	}

	function addActiveSession(sid, sessionQuery, extra = {}) {
		if (activeSessions.has(sid)) return activeSessions.get(sid)
		console.log('[dsh-dock] task-track: task started', sid.substring(0, 8))
		const record = {
			startTime: Date.now(),
			title: '',
			turns: 0,
			steps: 0,
			toolCalls: 0,
			models: new Set(),
			provider: '',
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			reasoningTokens: 0,
			cacheReadTokens: 0,
			endReason: '',
			errorMessage: '',
			lastText: '',
			firstPrompt: '',
			// 工具等待用户确认（dsh 会话流 approval/asked）：浏览器侧据此弹"需确认"通知
			approvals: new Map(), // approvalId -> { toolName, reason, askedAt }
			phase: 'think',
			phaseAt: Date.now(),
			lastActivityAt: Date.now(),
			// assistant/chunk 是实时流；用轻量活动计数给浏览器侧映射动作速度，
			// 不等最终 usage 落盘，避免任务正在输出时机器人仍慢速。
			motionTicks: 0,
			lastMotionAt: Date.now(),
			...extra,
		}
		activeSessions.set(sid, record)
		getSessionTitle(sid, sessionQuery).then((title) => {
			const s = activeSessions.get(sid)
			if (s) s.title = title
		})
		return record
	}

	// 任务结束：归档 + 通知订阅者（浏览器侧通知/群机器人推送都由各自消费方决定怎么用）
	function finishSession(sid) {
		const session = activeSessions.get(sid)
		if (!session) return
		activeSessions.delete(sid)
		const endTime = Date.now()
		const duration = endTime - session.startTime
		console.log('[dsh-dock] task-track: task finished', {
			sid: sid.substring(0, 8),
			duration,
			endReason: session.endReason || 'completed',
		})
		const record = {
			sessionId: sid,
			title: session.title || truncate(session.firstPrompt, 60) || '(无标题)',
			duration,
			turns: session.turns,
			steps: session.steps,
			toolCalls: session.toolCalls,
			models: [...session.models],
			provider: session.provider,
			inputTokens: session.inputTokens,
			outputTokens: session.outputTokens,
			totalTokens: session.totalTokens,
			reasoningTokens: session.reasoningTokens,
			cacheReadTokens: session.cacheReadTokens,
			endReason: session.endReason,
			errorMessage: session.errorMessage,
			lastText: session.lastText,
			startTime: session.startTime,
			endTime,
		}
		completedSessions.unshift(record)
		if (completedSessions.length > MAX_COMPLETED) completedSessions.pop()
		for (const fn of finishListeners) {
			try { fn(record) } catch (e) {
				console.error('[dsh-dock] task-track finish listener error:', e && e.message)
			}
		}
	}

	function handleSessionEvent(sessionQuery, session, event) {
		const sid = typeof session === 'object' && session ? (session.id || '') : String(session || '')
		if (!sid || !event || !event.type) return

		if (event.type === 'step/start') {
			const s = addActiveSession(sid, sessionQuery, { startTime: event.time || Date.now() })
			s.steps++
			s.phase = 'think' // 新步骤：模型正在推理下一步
			s.phaseAt = event.time || Date.now()
			s.lastActivityAt = s.phaseAt
			s.motionTicks += 2
			s.lastMotionAt = s.phaseAt
			if (event.data && event.data.turn !== undefined) {
				s.turns = Math.max(s.turns, num(event.data.turn) + 1)
			}
			return
		}
		const s = activeSessions.get(sid)
		if (!s) return
		const now = event.time || Date.now()
		// 流级阶段：chunk 高频到达（每 token 一条），只做最廉价的阶段切换
		if (event.type === 'assistant/chunk') {
			const chunk = event.data && event.data.chunk
			const ctype = chunk && chunk.type
			if (ctype === 'reasoning-delta') {
				s.phase = 'think'
				s.phaseAt = now
			} else if (ctype === 'text-delta') {
				s.phase = 'write'
				s.phaseAt = now
			}
			// 不同适配器的 delta 字段名并不完全一致。按可见文本量估算，
			// 无文本时每个 chunk 也记一个脉冲，保证推理流同样有动作反馈。
			if (ctype === 'reasoning-delta' || ctype === 'text-delta') {
				const delta = chunk && (chunk.text || chunk.delta || chunk.content)
				const units = typeof delta === 'string' ? Math.max(1, Math.ceil(delta.length / 24)) : 1
				s.motionTicks += units
				s.lastMotionAt = now
			}
			s.lastActivityAt = now
			return
		}
		if (event.type === 'turn/end' && event.data && event.data.reason) {
			const reason = event.data.reason
			s.endReason = (reason.kind || 'completed')
			if (reason.kind === 'error' && reason.error) {
				const msg = (reason.error && (reason.error.message || reason.error.code)) || ''
				s.errorMessage = typeof msg === 'string' ? msg : String(msg)
			}
		} else if (event.type === 'approval/asked' && event.data) {
			// 工具等待用户确认/批准：挂在会话记录上，/status 下发给浏览器弹"需确认"通知
			const id = typeof event.data.id === 'string' ? event.data.id : ''
			if (id) {
				s.approvals.set(id, {
					toolName: typeof event.data.toolName === 'string' ? event.data.toolName : '',
					reason: typeof event.data.reason === 'string' ? truncate(event.data.reason, 200) : '',
					askedAt: event.time || Date.now(),
				})
			}
			s.lastActivityAt = now
		} else if (event.type === 'approval/decided' && event.data) {
			s.approvals.delete(typeof event.data.id === 'string' ? event.data.id : '')
		} else if (event.type === 'tool/call') {
			s.toolCalls++
			s.phase = phaseOfToolName(event.data && event.data.name)
			s.phaseAt = now
			// 工具启动是稀疏事件，给一个更明显的短促动作，检索/写文件也不会显得停住。
			s.motionTicks += s.phase === 'search' ? 7 : 9
			s.lastMotionAt = now
		} else if (event.type === 'user/message') {
			if (!s.firstPrompt && event.data && event.data.content) {
				const text = extractText(event.data.content)
				if (text) s.firstPrompt = text
			}
		} else if (event.type === 'assistant/message' && event.data) {
			const usage = event.data.usage
			if (usage) {
				s.inputTokens += num(usage.inputTokens)
				s.outputTokens += num(usage.outputTokens)
				s.totalTokens += num(usage.inputTokens) + num(usage.outputTokens)
				s.reasoningTokens += num(usage.reasoningTokens)
				s.cacheReadTokens += num(usage.cacheReadTokens)
			}
			if (event.data.message && event.data.message.content) {
				const text = extractText(event.data.message.content)
				if (text) s.lastText = text
			}
			// 完整消息落盘后不改阶段：下一步要么 tool/call（code/search）要么收尾，
			// 维持 chunk 推导出的最后状态，避免"输完还显示思考中"的回跳
		} else if (event.type === 'request/context' && event.data) {
			if (event.data.provider) s.provider = event.data.provider
			if (event.data.model) s.models.add(event.data.model)
		} else if (event.type === 'request/header' && event.data && event.data.header && event.data.header.config) {
			const c = event.data.header.config
			if (c.provider) s.provider = c.provider
			if (c.model) s.models.add(c.model)
		}
		if (event.type !== 'request/header' && event.type !== 'request/context') s.lastActivityAt = now
	}

	function handleAgentStatus(sessionQuery, agent, status) {
		const sid = agent && agent.id ? String(agent.id) : ''
		if (!sid) return
		if (status === 'running') {
			const record = addActiveSession(sid, sessionQuery)
			if (agent.options) {
				if (agent.options.model) record.models.add(agent.options.model)
				if (agent.options.provider) record.provider = agent.options.provider
			}
		} else if (status === 'idle') {
			finishSession(sid)
		}
	}

	// 不能在 setup 时软获取 sessionQuery（可能早于服务激活，见 tokenlog 模块同款注释），用 inject 等就绪
	disposers.push(ctx.inject(['sessionQuery'], (sqCtx) => {
		const sessionQuery = sqCtx.sessionQuery
		disposers.push(sqCtx.on('session/event', (session, event) => {
			try {
				handleSessionEvent(sessionQuery, session, event)
			} catch (err) {
				console.error('[dsh-dock] task-track handle event error', err)
			}
		}))
		disposers.push(sqCtx.on('agent/status', (payload) => {
			try {
				handleAgentStatus(sessionQuery, payload && payload.agent, payload && payload.status)
			} catch (err) {
				console.error('[dsh-dock] task-track handle agent/status error', err)
			}
		}))
		// agent 销毁兜底归档（会话直接关闭时也产出完成记录）
		disposers.push(sqCtx.on('agent/disposed', (payload) => {
			try {
				const sid = payload && payload.agent && payload.agent.id ? String(payload.agent.id) : ''
				if (sid) finishSession(sid)
			} catch (err) {
				console.error('[dsh-dock] task-track handle agent/disposed error', err)
			}
		}))
	}))

	return {
		/** 当前快照（活跃任务 + 最近完成），供各功能模块的 /status 路由下发。 */
		snapshot(now) {
			const at = typeof now === 'number' ? now : Date.now()
			const active = []
			for (const [sid, s] of activeSessions) {
				active.push({
					sessionId: sid,
					title: s.title || truncate(s.firstPrompt, 60) || '(无标题)',
					startTime: s.startTime,
					elapsed: at - s.startTime,
					turns: s.turns,
					steps: s.steps,
					toolCalls: s.toolCalls,
					models: [...s.models],
					provider: s.provider,
					inputTokens: s.inputTokens,
					outputTokens: s.outputTokens,
					totalTokens: s.totalTokens,
					phase: s.phase,
					phaseAt: s.phaseAt,
					lastActivityAt: s.lastActivityAt,
					motionTicks: s.motionTicks,
					lastMotionAt: s.lastMotionAt,
					approvals: [...s.approvals.entries()].map(([id, v]) => ({ id, ...v })),
				})
			}
			return { now: at, active, recent: completedSessions.slice(0, 20) }
		},
		/** 任务结束订阅（返回退订函数）；异常不会打断其他订阅者。 */
		onFinish(fn) {
			if (typeof fn !== 'function') return () => {}
			finishListeners.add(fn)
			return () => { finishListeners.delete(fn) }
		},
		/** 退订会话事件（引用计数归零时由 acquireTaskTracker 调用）。 */
		dispose() {
			finishListeners.clear()
			activeSessions.clear()
			completedSessions.length = 0
			while (disposers.length > 0) {
				const fn = disposers.pop()
				try { if (typeof fn === 'function') fn() } catch { /* 退订失败不阻断 */ }
			}
		},
	}
}
