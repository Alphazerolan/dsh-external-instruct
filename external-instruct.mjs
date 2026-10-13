/**
 * external-instruct —— 让别的软件/模型通过本机 HTTP 给 GUI 下达指令的宿主侧插件。
 *
 * 为什么是「宿主侧 + HTTP」：会话必须由 GUI 自己的运行时创建，才会被写进
 * workspace 登记表，从而出现在左侧栏的工作区树下（外部进程另起 home 写文件
 * 是不行的——实测过）。
 *
 * 路由（只允许回路请求：socket 地址 + Host 头 + 同源标记三重围栏）：
 *   GET  /dsh-instruct/health
 *        → { ok: true, instance, tools }
 *   POST /dsh-instruct/ask        { text, title?, workspacePath?, agentPreset?,
 *                                   permissionPreset?, provider?, model?, wait? }
 *        → 默认等到整轮结束：{ ok, sessionId, finalResponse, finishReason }
 *        → wait:false 立即返回：{ ok, sessionId, queued: true }
 *   GET  /dsh-instruct/session?sessionId=...
 *        → { ok, sessionId, status: 'idle'|'running'|..., finalResponse }
 *
 * 会话由本插件创建并 `workspace.attachSession(...)`，所以左侧栏直接可见；
 * 模型回复用 GUI 自带能力生成标题，与手工开的会话无异。
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** 本插件的插件名。 */
export const name = 'external-instruct'

/**
 * 需要的既有服务。缺任何一个都会让插件加载失败（fail-closed），
 * 因为少一个就无法完成「创建会话 → 挂进工作区 → 起标题 → 等回复」这条链。
 */
export const inject = [
  'webServer',
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
  'sessionTitle',
  'workspaceRegistry',
  'sessions',
]

const PREFIX = '/dsh-instruct'
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_AGENT_PRESET = 'standard'
const DEFAULT_PERMISSION_PRESET = 'workspace-write'

/** 每个会话记住最近一次回复状态，供 /session 查询。 */
const registry = new Map()

/**
 * sessionId → agent：由 `agent/created` 事件建立。
 * 这是"续发到已有会话"最可靠的来源——它覆盖**所有**活会话（含 GUI 里手工开的、
 * 以及重启前后由其它路径创建的），不依赖某个服务 getter 的具体形状。
 */
const liveAgents = new Map()

// ---------------------------------------------------------------- HTTP 基础

/** RFC 5735 127/8 判定。 */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** socket 地址是否回路（含 ::1 与 IPv4-mapped）。 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Host 头是否回路主机名。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 请求级信任围栏：socket 地址（权威，绝不信任 X-Forwarded-For）+ Host 头
 * + 浏览器同源标记。与 dsh-pet / dsh-webhook 用的是同一套语义。
 */
function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读一个有上限的 JSON 请求体；空体返回 {}。 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/** 取一个必填非空字符串字段。 */
function requiredString(record, field) {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

// ------------------------------------------------------------ 会话创建与等待

/**
 * 从会话事件里攒出助手文本与结束原因。
 * 事件签名沿用 dsh 的 session/event：`(session, event)`。
 */
function foldEvent(state, event) {
  if (event?.type === 'assistant/message') {
    const text = (event.data?.message?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
    if (text !== '') state.finalResponse = text
    return
  }
  if (event?.type === 'turn/end') {
    state.finishReason = event.data?.reason?.kind ?? null
    state.settled = true
  }
}

/**
 * 把调用方声明的软件名规范成可用作 id 前缀与标题标签的短 slug。
 * 「不同软件可区分」的第一层：slug 进 sessionId 前缀，标题进 [标签]。
 */
function softwareSlug(value) {
  if (typeof value !== 'string') return undefined
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return slug === '' ? undefined : slug
}

/**
 * 查一个 sessionId 是否是**活着的**会话，返回它的 agent（找不到就 undefined）。
 *
 * 只认活会话：冷会话（进程外/重启前建的）不在这里恢复——恢复是 sessionController
 * 的职责，而本插件的目标是"给正在跑的 GUI 续发消息"。查不到就按新会话处理。
 */
function tryLive(liveLookup, sessionId) {
  if (typeof liveLookup !== 'function') return undefined
  try {
    const found = liveLookup(sessionId)
    if (found === undefined || found === null) return undefined
    const agent = found.agent ?? found
    if (typeof agent?.followup !== 'function') return undefined
    return { agent, session: found.session ?? agent.session }
  } catch {
    return undefined
  }
}

/** 标题里显示的软件标签（保留调用方原始大小写，压成单行、限长）。 */
function softwareLabel(value) {
  if (typeof value !== 'string') return undefined
  const label = value.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 32)
  return label === '' ? undefined : label
}

/**
 * 创建一条 GUI 自己的会话、挂进工作区、起标题、投递提示词。
 * 步骤与 @deepseek-ai/dsh-webhook 的 createWebhookSession 对齐。
 *
 * 「不同软件可区分」三层机制：
 *   1. `software` 进 sessionId 前缀（如 `gpt-3f2a…`）——会话目录名即可辨认；
 *   2. 标题带 `[GPT] ` 标签——左侧栏一眼可辨；
 *   3. 消息 source 带 `software` 与 `workspacePath`——会话日志永久留痕，可筛选。
 * 更强的一层是「各软件用自己的 workspacePath」，那由调用方决定（见对接文档）。
 *
 * 续发：request.sessionId 命中一个**活着的**会话时，不再新建，而是把这条消息续投给
 * 同一个 agent（同会话的持久上下文继续累积）。命中不到就按新会话创建——
 * 与 SDK 的 `sessionId` 惰性语义一致，调用方无需先查存在性。
 */
async function createInstructedSession(ctx, request, liveLookup) {
  const workspacePath = requiredString(request, 'workspacePath')
  if (!isAbsolute(workspacePath)) throw new Error('workspacePath must be absolute')
  const text = requiredString(request, 'text')
  const slug = softwareSlug(request.software)
  const label = softwareLabel(request.software)
  const explicitTitle = typeof request.title === 'string' && request.title.trim() !== ''
    ? request.title.trim()
    : `外部指令 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
  const title = label === undefined ? explicitTitle : `[${label}] ${explicitTitle}`
  const agentPresetId = typeof request.agentPreset === 'string' && request.agentPreset.trim() !== ''
    ? request.agentPreset.trim()
    : DEFAULT_AGENT_PRESET
  const permissionPresetId = typeof request.permissionPreset === 'string' && request.permissionPreset.trim() !== ''
    ? request.permissionPreset.trim()
    : DEFAULT_PERMISSION_PRESET
  const requestedSessionId = typeof request.sessionId === 'string' && request.sessionId.trim() !== ''
    ? request.sessionId.trim()
    : undefined

  // ---- 续发路径：命中活会话就把消息投回去，不新建、不改标题/权限 ----
  const live = requestedSessionId === undefined ? undefined : tryLive(liveLookup, requestedSessionId)
  if (live !== undefined) {
    live.agent.followup(Object.freeze({
      id: `ext-msg-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'external-instruct',
        form: 'notice',
        ...(label === undefined ? {} : { software: label }),
        workspacePath,
        continuation: true,
      },
    }))
    const existing = registry.get(requestedSessionId)
    if (existing !== undefined) {
      // 续发打开新的一轮：重置结算状态，让等待者能等到这一轮的 turn/end。
      existing.settled = false
      existing.finalResponse = ''
      existing.finishReason = null
    } else {
      registry.set(requestedSessionId, {
        sessionId: requestedSessionId, status: 'running', finalResponse: '',
        finishReason: null, settled: false,
      })
    }
    return {
      sessionId: requestedSessionId,
      handle: undefined,
      title: undefined,
      software: label,
      workspacePath,
      workspaceTitle: undefined,
      created: false,
    }
  }

  // ---- 新建路径 ----
  // 预检：不合法就在创建任何东西之前失败。
  ctx.permissionPresets.resolve(permissionPresetId)
  const preset = await ctx.agentPresets.resolve(agentPresetId)
  const presetScope = await ctx.agentPresets.acquireScope(preset.id)

  const selected = ctx.agentDefaultModel.currentSelection()
  const agentOptions = {
    provider: typeof request.provider === 'string' && request.provider.trim() !== ''
      ? request.provider.trim()
      : selected.provider,
    model: typeof request.model === 'string' && request.model.trim() !== ''
      ? request.model.trim()
      : selected.model,
  }

  const sessionId = requestedSessionId ?? `${slug ?? 'ext'}-${randomUUID()}`
  const workspace = await ctx.workspaceRegistry.create(workspacePath)
  // 传给消息来源的软件名（用 slug 之外的原始标签，便于阅读）。
  const software = label

  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions,
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset.id)
    },
  })

  let attached = false
  try {
    await workspace.attachSession(sessionId)
    attached = true
    ctx.permissionPresets.set(handle.agent.session, permissionPresetId)
    ctx.sessionTitle.rename(handle.agent.session, title)
    // 消息形状对齐 @deepseek-ai/dsh-llm 的 createUserMessage：
    // 冻结的 { id, role:'user', content, source }。这里不 import 那个包，
    // 因为 profile 目录解析不到它（依赖在 app.asar 内）。
    // source.software 让"哪一家的软件下的指令"可被区分与筛选（会话日志里永久留痕）。
    handle.agent.followup(Object.freeze({
      id: `ext-msg-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'external-instruct',
        form: 'notice',
        ...(software === undefined ? {} : { software }),
        workspacePath: workspace.path,
      },
    }))
  } catch (error) {
    if (attached) {
      try { await workspace.detachSession(sessionId) } catch { /* 原始错误优先 */ }
    }
    try { await handle.dispose() } catch { /* 原始错误优先 */ }
    throw error
  } finally {
    try { presetScope[Symbol.dispose]?.() } catch { /* 作用域释放失败不覆盖主流程 */ }
  }

  return {
    sessionId,
    handle,
    title,
    software,
    workspacePath: workspace.path,
    workspaceTitle: workspace.title,
    created: true,
  }
}

/** 记录一条会话的投影状态并挂到全局事件流上。 */
function trackSession(ctx, sessionId) {
  const state = registry.get(sessionId) ?? {
    sessionId,
    status: 'running',
    finalResponse: '',
    finishReason: null,
    settled: false,
  }
  registry.set(sessionId, state)
  return state
}

// ------------------------------------------------------------------ 插件主体

/**
 * 挂载插件：订阅会话事件、注册三条回路路由。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  const waiters = new Map() // sessionId -> resolve()

  /** 从事件回调里取出会话 id（签名容错：session.id / session.header.id）。 */
  const idOf = (session) => {
    const id = session?.id ?? session?.header?.id
    return typeof id === 'string' ? id : undefined
  }

  // 单一事件订阅：归拢助手文本与结束原因，并唤醒等待者。
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      const sessionId = idOf(session)
      if (sessionId === undefined) return
      const state = registry.get(sessionId)
      if (state !== undefined && !state.settled) foldEvent(state, event)
      if (event?.type === 'turn/end') {
        const waiter = waiters.get(sessionId)
        if (waiter !== undefined) waiter()
      }
    })
    return () => { dispose?.() }
  })

  // 活会话索引：任何 agent 创建（本插件建的、GUI 手工开的、其它插件建的）都记下来，
  // 这样"续发到已有会话"能命中 GUI 里正在跑的任何一条会话。agent 销毁时清理。
  ctx.effect(() => {
    const disposeCreated = ctx.on('agent/created', ({ agent }) => {
      const sessionId = agent?.session?.id ?? agent?.session?.header?.id
      if (typeof sessionId === 'string') liveAgents.set(sessionId, agent)
    })
    const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = agent?.session?.id ?? agent?.session?.header?.id
      if (typeof sessionId === 'string') liveAgents.delete(sessionId)
    })
    return () => { disposeCreated?.(); disposeDisposed?.() }
  })

  /** 等一条会话本轮结束，或超时。 */
  function waitForTurn(sessionId, timeoutMs) {
    const state = registry.get(sessionId)
    if (state === undefined || state.settled) return Promise.resolve(state)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(sessionId)
        resolve(state)
      }, timeoutMs)
      waiters.set(sessionId, () => {
        clearTimeout(timer)
        waiters.delete(sessionId)
        resolve(state)
      })
    })
  }

  /**
   * 查一个 sessionId 的活会话（agent）。来源优先级：
   *   1. `agent/created` 事件建立的 liveAgents 映射（覆盖所有活会话，最可靠）；
   *   2. sessions 服务的查询接口（形状不保证，故做多路兜底）。
   */
  const lookupLiveSession = (sessionId) => {
    const mapped = liveAgents.get(sessionId)
    if (mapped !== undefined && typeof mapped.followup === 'function') {
      return { agent: mapped, session: mapped.session }
    }
    const sessions = ctx.sessions
    if (sessions !== undefined && sessions !== null) {
      let found
      try {
        found = typeof sessions.get === 'function'
          ? sessions.get(sessionId)
          : sessions.list?.getSnapshot?.()?.byId?.[sessionId]
      } catch {
        found = undefined
      }
      const agent = found?.agent
      if (agent !== undefined && typeof agent.followup === 'function') {
        return { agent, session: found.session ?? agent.session }
      }
    }
    return undefined
  }

  /** 列出本插件进程内跟踪过的会话，供外部软件发现"可以续发哪条"。 */
  const listTrackedSessions = () => [...registry.values()].map((state) => ({
    sessionId: state.sessionId,
    software: state.software ?? null,
    workspacePath: state.workspacePath ?? null,
    workspaceTitle: state.workspaceTitle ?? null,
    settled: state.settled === true,
    live: lookupLiveSession(state.sessionId) !== undefined,
    finalResponse: (state.finalResponse ?? '').slice(0, 500),
  }))

  const routes = [
    {
      kind: 'exact',
      path: `${PREFIX}/health`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback-only' })
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        writeJson(res, 200, {
          ok: true,
          instance: 'external-instruct',
          routes: [`${PREFIX}/ask`, `${PREFIX}/session`, `${PREFIX}/sessions`],
          // 「不同软件可区分」的说明：software 进会话名前缀与标题标签，source 永久留痕。
          distinguishes: {
            titleTag: '[<software>] <title>',
            sessionIdPrefix: '<software-slug>-<uuid>',
            messageSource: 'external-instruct + software + workspacePath',
            workspace: '由调用方的 workspacePath 决定；建议每个软件一个自己的工作区',
          },
          continuation: {
            how: 'POST /ask 带上已有 sessionId 即续发到该会话（活会话）；命中不到则按新会话创建',
            discover: `GET ${PREFIX}/sessions`,
            responseField: 'created: true 表示新建，false 表示续发',
          },
        })
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/sessions`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback-only' })
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        writeJson(res, 200, { ok: true, count: registry.size, sessions: listTrackedSessions() })
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/ask`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        try {
          const created = await createInstructedSession(ctx, body, lookupLiveSession)
          const sessionId = created.sessionId
          const state = trackSession(ctx, sessionId)
          if (created.software !== undefined) state.software = created.software
          if (created.workspacePath !== undefined) state.workspacePath = created.workspacePath
          if (created.workspaceTitle !== undefined) state.workspaceTitle = created.workspaceTitle
          // 回显归属，让外部软件确认自己这条指令落在哪个工作区、以什么名字登记、
          // 以及是新建还是续发（created）。
          const echo = {
            sessionId,
            created: created.created === true,
            software: state.software ?? null,
            workspacePath: state.workspacePath ?? null,
            workspaceTitle: state.workspaceTitle ?? null,
            title: created.title ?? null,
          }
          if (body.wait === false) {
            return writeJson(res, 202, { ok: true, queued: true, ...echo })
          }
          const timeoutMs = Number.isSafeInteger(body.timeoutMs) && body.timeoutMs > 0
            ? body.timeoutMs
            : 30 * 60 * 1000
          const settled = await waitForTurn(sessionId, timeoutMs)
          return writeJson(res, 200, {
            ok: true,
            ...echo,
            finalResponse: settled?.finalResponse ?? '',
            finishReason: settled?.finishReason ?? null,
          })
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/session`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback-only' })
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const url = new URL(`http://${req.headers.host}${req.url}`)
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId === '') {
          return writeJson(res, 400, { ok: false, error: 'sessionId is required' })
        }
        const state = registry.get(sessionId)
        const live = lookupLiveSession(sessionId) !== undefined
        if (state === undefined && !live) return writeJson(res, 404, { ok: false, error: 'unknown session' })
        writeJson(res, 200, {
          ok: true,
          sessionId,
          live,
          software: state?.software ?? null,
          workspacePath: state?.workspacePath ?? null,
          workspaceTitle: state?.workspaceTitle ?? null,
          finalResponse: state?.finalResponse ?? '',
          finishReason: state?.finishReason ?? null,
          settled: state?.settled === true,
        })
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  })

  ctx.logger?.info?.(`external-instruct: 已挂载 ${PREFIX}/ask（仅回路）`)
}
