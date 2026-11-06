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

	/**
	 * ask_user_question 的调用参数 → 快照里够用的提问摘要。
	 * 解析失败不报错：参数拿不到就当「有一问在等人答」，标题留空由客户端兜底
	 * （宁可少说一句，也不要因为解析异常把整条任务追踪打断）。
	 * @param {unknown} rawArguments 工具调用的 arguments（JSON 字符串）
	 * @param {number} askedAt 提问时间（事件时间，不用本地钟）
	 * @returns {{header: string, question: string, count: number, askedAt: number}}
	 */
	function describeQuestion(rawArguments, askedAt) {
		const summary = { header: '', question: '', count: 1, askedAt }
		try {
			const parsed = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments
			const list = parsed && Array.isArray(parsed.questions) ? parsed.questions : []
			if (list.length > 0) summary.count = list.length
			const first = list[0]
			if (first && typeof first === 'object') {
				if (typeof first.header === 'string') summary.header = truncate(first.header, 60)
				if (typeof first.question === 'string') summary.question = truncate(first.question, 200)
			}
		} catch { /* 参数不是合法 JSON：留空摘要，提问本身照样算「等人答」 */ }
		return summary
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

	/**
	 * 会话标题 + 主/子任务归属：优先 readTitleSnapshot（一次观测同时拿到标题与会话头），
	 * 会话头里的 origin === 'subagent' / delegationDepth 是权威的子任务标记（见 dsh-session
	 * SessionHeader），fallback 路径只拿标题、按主任务处理。取不到头不报错——播报退化为
	 * 不带归属的旧口径，功能不受影响（测试桩只需实现 readTitle/readSession 也能跑）。
	 * @returns {Promise<{ title: string, header: object|null }>}
	 */
	async function readSessionFacts(sessionId, sessionQuery) {
		const facts = { title: '', header: null }
		if (!sessionQuery) return facts
		try {
			if (typeof sessionQuery.readTitleSnapshot === 'function') {
				const obs = await sessionQuery.readTitleSnapshot(sessionId)
				if (obs) {
					const t = obs.title
					if (typeof t === 'string') facts.title = t
					else if (t && typeof t.title === 'string') facts.title = t.title
					if (obs.session && typeof obs.session === 'object') facts.header = obs.session
					if (facts.title || facts.header) return facts
				}
			}
		} catch { /* 换下一种读法 */ }
		facts.title = await getSessionTitle(sessionId, sessionQuery)
		return facts
	}

	function addActiveSession(sid, sessionQuery, extra = {}) {
		if (activeSessions.has(sid)) return activeSessions.get(sid)
		// 不在终端打「任务开始」日志：开始/结束状态界面（运行状态页）已实时可见
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
			// 主/子任务归属 + 最近一次调用的工具：卡住播报与卡住卡要说清「哪里卡住、最后在干什么」
			//（isSubtask 由会话头 origin/delegationDepth 异步判定，判定前按主任务处理）
			isSubtask: false,
			parentSessionId: '',
			// 主任务标题：子任务结束通知要点名「哪个主任务的哪个子任务」（卡片/语音/群推送共用）
			parentTitle: '',
			lastToolName: '',
			// 工具等待用户确认（dsh 会话流 approval/asked）：浏览器侧据此弹"需确认"通知
			approvals: new Map(), // approvalId -> { toolName, reason, askedAt }
			// 用户提问等待回答（dsh 会话流 tool/call ask_user_question → tool/result）：
			// 与 approvals 同属「等人介入」。不记它的后果是实测过的（2026-11-01 用户反馈：
			// 会话在等用户选答案，界面却报「主任务卡住了」）——提问期间会话天然零事件，
			// 18 秒安静被卡住判定当成停滞。提问是**等回答**，不是卡住。
			questions: new Map(), // callId -> { header, question, count, askedAt }
			// 在飞的工具调用（tool/call → tool/result）：长命令（构建/全量测试）期间会话零事件，
			// 但任务确实在跑。客户端靠它区分「正在跑长命令」与「真卡住」。
			pendingTool: '',
			toolStartedAt: 0,
			// 上下文压缩（compaction/start → compaction/end）：压缩全程同样零事件，
			// 实测 2026-11-02 的 25 分钟会话里 25 次长停顿有 18 次落在压缩窗口内
			// （最长 96.7 秒），全被卡住判定误报。压缩是**正在干活**，不是卡住。
			compacting: false,
			compactStartedAt: 0,
			compactId: '',
			// PTC（Programmatic Tool Calling / run_code）程序执行状态：一次 run_code 会包住若干子调用
			// （wait_agent 等子代理 / job_output 等后台任务 / bash 长命令 / ask_user_question 等人），
			// 子调用执行期间本会话可能长时间零事件——那是在干活/等人，不是卡住。卡住判定据此豁免。
			ptcProgram: false,
			ptcTool: '',
			ptcStartedAt: 0,
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
		readSessionFacts(sid, sessionQuery).then((facts) => {
			const s = activeSessions.get(sid)
			if (!s) return
			if (facts.title) s.title = facts.title
			const h = facts.header
			if (h) {
				s.isSubtask = h.origin === 'subagent'
					|| (typeof h.delegationDepth === 'number' && h.delegationDepth > 0)
				s.parentSessionId = typeof h.parentSession === 'string' && h.parentSession ? h.parentSession : ''
				// 子任务：顺手解析主任务标题。优先内存里的父会话（常见：主任务还在跑），
				// 没有再问标题服务；都拿不到就留空，结束时 finishSession 还会再兜一次。
				if (s.isSubtask && s.parentSessionId) {
					const liveParent = activeSessions.get(s.parentSessionId)
					if (liveParent && (liveParent.title || liveParent.firstPrompt)) {
						s.parentTitle = liveParent.title || truncate(liveParent.firstPrompt, 60)
					} else {
						readSessionFacts(s.parentSessionId, sessionQuery).then((pf) => {
							if (activeSessions.get(sid) === s && pf.title) s.parentTitle = pf.title
						}).catch(() => { /* 主任务标题读不到：通知退化为不带主任务名 */ })
					}
				}
			}
		}).catch(() => { /* 标题/归属读失败：title 走 firstPrompt 兜底，归属按主任务 */ })
		return record
	}

	// 任务结束：归档 + 通知订阅者（浏览器侧通知/群机器人推送都由各自消费方决定怎么用）
	function finishSession(sid) {
		const session = activeSessions.get(sid)
		if (!session) return
		activeSessions.delete(sid)
		const endTime = Date.now()
		const duration = endTime - session.startTime
		// 主任务标题三级兜底：还在跑的父会话（标题可能比子任务晚到，以结束时最新值为准）
		// → 已归档的父会话 → 子任务开始时解析到的标题。都没有就留空（消费方显示「未知」）。
		const liveParent = session.parentSessionId ? activeSessions.get(session.parentSessionId) : null
		const archivedParent = session.parentSessionId && !liveParent
			? completedSessions.find((r) => r.sessionId === session.parentSessionId) : null
		const parentTitle = liveParent
			? (liveParent.title || truncate(liveParent.firstPrompt, 60))
			: (archivedParent ? archivedParent.title : (session.parentTitle || ''))
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
			// 主/子归属进完成记录：结束通知（卡片/语音/系统通知/群推送）据此区分
			// 「任务完成」与「子任务完成」，并点名是哪个主任务的哪个子任务
			isSubtask: !!session.isSubtask,
			parentSessionId: session.parentSessionId || '',
			parentTitle: parentTitle || '',
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
			// 记下最后调用的工具名：卡住播报/卡住卡要回答「最后在干什么」
			const called = event.data && typeof event.data.name === 'string' ? event.data.name : ''
			if (called) s.lastToolName = called
			// 记下在飞调用：长命令跑起来后到结果落地之间没有事件，靠它别误报卡住
			s.pendingTool = called || 'tool'
			s.toolStartedAt = now
			// ask_user_question 是**阻塞式等人回答**：调用发出后到用户提交答案之间，会话
			// 一条事件都不会有（实测 2026-11-01：提问挂起 66 秒，其间零事件）。把它记成
			// 「等人介入」的一种，卡住判定才不会把这段安静误判成停滞。
			if (called === 'ask_user_question') {
				const callId = typeof event.data.callId === 'string' ? event.data.callId : ''
				if (callId) s.questions.set(callId, describeQuestion(event.data.arguments, now))
			}
			// 工具启动是稀疏事件，给一个更明显的短促动作，检索/写文件也不会显得停住。
			s.motionTicks += s.phase === 'search' ? 7 : 9
			s.lastMotionAt = now
		} else if (event.type === 'tool/result') {
			// 提问的回答（或超时/取消）落地 → 提问结束，恢复普通追踪。
			// 时间字段用事件时间，保证「答完那一刻」就是新的活动起点。
			const msg = event.data && event.data.message
			const callId = msg && typeof msg.toolCallId === 'string' ? msg.toolCallId : ''
			if (callId) s.questions.delete(callId)
			// 调用落地 → 不再有在飞的调用（同一时刻只会有一个工具在跑）
			s.pendingTool = ''
			s.toolStartedAt = 0
			// run_code（PTC 程序）整体落地：程序结束，清掉 PTC 忙标记。
			s.ptcProgram = false
			s.ptcTool = ''
			s.ptcStartedAt = 0
		} else if (event.type === 'tool/ptc-dispatch-start' && event.data) {
			// PTC 子调用开始：run_code 程序正在执行某个子工具（wait_agent / job_output / bash /
			// ask_user_question…）。这些子调用可阻塞数分钟（等子代理、等后台任务、等用户回答），
			// 期间本会话零事件——但任务在干活/等人，不是卡住。标记整段 PTC 程序为「在忙」。
			s.ptcProgram = true
			const subName = typeof event.data.name === 'string' ? event.data.name : ''
			s.ptcTool = subName
			s.ptcStartedAt = now
			s.lastMotionAt = now
			// PTC 内的 ask_user_question：与直接 tool/call 一样要能弹「需回答」而不是「卡住」。
			if (subName === 'ask_user_question') {
				const subId = typeof event.data.subCallId === 'string' ? event.data.subCallId : ''
				if (subId) s.questions.set(subId, describeQuestion(event.data.arguments, now))
			}
		} else if (event.type === 'tool/ptc-dispatch' && event.data) {
			// PTC 子调用结束：清掉对应提问挂起项；程序本身可能还有后续子调用（ptcProgram 保持到
			// 外层 run_code 的 tool/result 再清）。
			const subId2 = typeof event.data.subCallId === 'string' ? event.data.subCallId : ''
			if (subId2) s.questions.delete(subId2)
			s.ptcTool = ''
			s.ptcStartedAt = 0
			s.lastMotionAt = now
		} else if (event.type === 'compaction/start' && event.data) {
			// 压缩上下文开始：期间会话零事件，但这是**正在干活**。记成在忙，别按停滞算。
			s.compacting = true
			s.compactStartedAt = now
			s.compactId = typeof event.data.compactionId === 'string' ? event.data.compactionId : ''
			s.lastActivityAt = now
		} else if (event.type === 'compaction/summary' && event.data) {
			// 压缩出摘要：仍在压缩中（llmStreamCall 表示还在等模型），只刷活动时间
			s.lastActivityAt = now
		} else if (event.type === 'compaction/end' && event.data) {
			// 压缩收尾：解除在忙状态；compactionId 不一致说明是另一个窗口的迟到事件，不误清
			const endId = typeof event.data.compactionId === 'string' ? event.data.compactionId : ''
			if (!endId || !s.compactId || endId === s.compactId) {
				s.compacting = false
				s.compactStartedAt = 0
				s.compactId = ''
			}
			s.lastActivityAt = now
		} else if (event.type === 'compaction/prune' && event.data) {
			// 修剪历史（不产摘要的轻量压缩）：也算在忙，但很快结束，只刷活动时间
			s.lastActivityAt = now
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
					// 「在忙」信号：有在飞的工具调用 / 正在压缩上下文。卡住判定据此豁免
					//（客户端口径见 src/shared.js 的 taskBusy / taskStalled）
					pendingTool: s.pendingTool || '',
					toolStartedAt: s.toolStartedAt || 0,
					compacting: !!s.compacting,
					compactStartedAt: s.compactStartedAt || 0,
					// 卡住播报/卡住卡专用：主/子归属（会话头判定）与最后调用的工具
					isSubtask: !!s.isSubtask,
					parentSessionId: s.parentSessionId || '',
					parentTitle: s.parentTitle || '',
					lastToolName: s.lastToolName || '',
					approvals: [...s.approvals.entries()].map(([id, v]) => ({ id, ...v })),
					// 等人回答的提问（ask_user_question 挂起中）：与 approvals 同属「等人介入」，
					// 客户端据此显示「等待回答」而不是「卡住」。
					questions: [...s.questions.entries()].map(([id, v]) => ({ id, ...v })),
					// PTC（run_code 程序）执行状态：客户端据此把整段程序当「在忙」，避免等待子代理 /
					// 后台任务 / 用户回答期间被误判成「卡住」（见 src/shared.js 的 taskBusy）。
					ptcProgram: !!s.ptcProgram,
					ptcTool: s.ptcTool || '',
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
