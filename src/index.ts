/**
 * dsh-activity-monitor — node 半（Host 侧）
 *
 * 监控对话运行时的所有操作，内存里维护一个活动环形缓冲：
 *  - llm/stream waterfall      → 每轮模型请求：模型名、耗时、token 用量，
 *    以及 system prompt 全文（从 messages 的 system 角色消息提取）+ 助手回复文本
 *  - tools/execute waterfall   → 每次工具调用（skill 加载、文件读写、命令执行……）
 *    从工具名+参数中归类出：skill 文件、读写文件、执行命令
 *
 * 展示约定（与浏览器半配合）：
 *  - detail 默认折叠；除非行内有 collapsed: false 标记，前端默认全部折叠
 *  - system prompt 按来源 section 拆分展示（从 systemMessageSections 记录）
 *
 * 通过 webServer 注册 /api/activity-monitor/snapshot 端点，浏览器侧板轮询读取。
 */
import { mkdirSync, appendFileSync, readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
// 引入类型以触发 declaration merge（Events 的 tools/* 键）
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'activity-monitor'

export const inject = ['webServer', 'systemPrompt'] as const

/** 简化版 skills 服务接口（避免强依赖 dsh-skill 类型） */
interface SkillsLike {
  list(options?: any): Promise<Array<{ name: string; path?: string; description: string; source: string }>>
  get(name: string, options?: any): Promise<{ name: string; path?: string; content?: string } | undefined>
}

/** `sections` 中的一段详情：key 非空 → 前端二级折叠（提示词段落），无 key 的默认展开（用户消息/回复） */
export interface ActivitySection {
  title: string
  body: string
  /** 分段标识；非空表示前端默认折叠、点击标题才展开 */
  key?: string
  /** 分组标题行：它下面 parent 指向本段 key 的子段在界面上缩进，且整组默认收起 */
  isGroup?: boolean
  /** 所属分组标题的 key（配合 isGroup 使用） */
  parent?: string
}

/** 单条活动记录 */
export interface ActivityRow {
  readonly seq: number
  readonly ts: number
  /** 所属会话 id（dsh SessionId），便于区分多会话 */
  readonly sessionId?: string
  /** llm | tool */
  readonly kind: 'llm' | 'tool'
  /** 模型名或工具名 */
  readonly name: string
  /** 归类标签：skill / file-read / file-write / command / tool / llm */
  readonly tag: string
  /** 单行摘要（文件名、命令行、skill 名等） */
  readonly summary: string
  /** 详情：前端一律默认折叠，点开才显示（不再自动展开） */
  detail?: string
  /** 多段详情：key 非空的段在前端二级折叠（提示词段落），无 key 的默认展开（用户消息/回复） */
  sections?: ActivitySection[]
  /**
   * dsh 轮次号（该 session 内从 1 开始）。取自运行时自身的 turn 事件，
   * 与界面「Jump to turn N」同口径：turn/start = 用户消息进来开始一轮，
   * turn/end = 本轮的模型回答结束。不属于任何轮次的调用（如会话标题生成）为空。
   */
  turn?: number
  /**
   * 本次请求里模型发起的工具调用及其在「完整上下文」中的位置：
   * msgIndex = 第几条消息（0 基，与界面上 [n] 一致）、callIndex = 该消息内第几个 tool-call（1 起）、
   * resultMsgIndex = 对应工具结果所在消息下标（工具结果还没回来时缺省）。
   * 前端据此把「工具行」对回消息序列里的位置。
   */
  calls?: { name: string; msgIndex: number; callIndex: number; resultMsgIndex?: number }[]
  durationMs?: number
  ok?: boolean
}

const MAX_ROWS = 500

/** 历史存储目录：$DSH_HOME（默认 ~/.dsh）/activity-monitor，按 session 分文件（JSONL） */
const HISTORY_DIR = path.join(
  process.env.DSH_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.dsh'),
  'activity-monitor',
)
const historyFiles = new Map<string, string>() // sessionId → 文件路径（启动时扫描）

export function apply(ctx: Context) {
  ctx.logger.info('[activity-monitor] starting')

  let seq = 0
  const rows: ActivityRow[] = []
  try { mkdirSync(HISTORY_DIR, { recursive: true }) } catch { /* ignore */ }

  // ── 轮次跟踪 ──
  // 轮次口径直接取运行时自己的 turn 事件，不自己猜边界：
  //   turn/start → 用户消息进来，一轮开始；turn/end → 本轮的模型回答结束（工具步都算在本轮内）。
  // 面板因此与界面「Jump to turn N」「N turns N steps」同源同号。
  const currentTurn = new Map<string, number>()       // sessionId → 当前轮次号
  const closedTurns = new Map<string, Set<number>>()  // sessionId → 已结束的轮次号集合
  let lastTurnSession: string | undefined             // 兜底：行没有 sessionId 时沿用最近一轮所属会话
  /** 该行归属的轮次号；行没带 sessionId 时退回最近一轮所属会话 */
  function turnFor(sessionId?: string): number | undefined {
    if (sessionId) return currentTurn.get(sessionId)
    return lastTurnSession ? currentTurn.get(lastTurnSession) : undefined
  }
  // session/event 是 emit 型事件（this: Scoped<Session>）：根上下文监听可收到所有会话的事件。
  // 事件形状：{ type: 'turn/start' | 'turn/end' | 'step/start' | ..., data: { turn, ... } }
  ;(ctx as any).on('session/event', (session: any, event: any) => {
    const sid = session?.id ? String(session.id) : undefined
    const turn = Number(event?.data?.turn)
    if (!sid || !turn) return
    if (event.type === 'turn/start') {
      currentTurn.set(sid, turn)
      lastTurnSession = sid
    } else if (event.type === 'turn/end') {
      let set = closedTurns.get(sid)
      if (!set) { set = new Set(); closedTurns.set(sid, set) }
      set.add(turn)
    }
  })

  /** 追加内存行 + 落盘历史（按 session 分文件） */
  function record(row: Omit<ActivityRow, 'seq' | 'ts'>): void {
    const full: ActivityRow = { ...row, turn: row.turn ?? turnFor(row.sessionId), seq: ++seq, ts: Date.now() }
    rows.push(full)
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS)
    try {
      const file = path.join(HISTORY_DIR, `${(full.sessionId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`)
      appendFileSync(file, JSON.stringify(full) + '\n')
    } catch { /* 磁盘异常不影响主流程 */ }
  }

  /**
   * 补轮次边界标记（读出时算，不改写已落盘的行）：
   * turnStart = 该 (session, turn) 的第一行（用户消息触发的第一次模型调用）
   * turnEnd   = 该轮最后一行且该轮已结束（历史数据视为已结束）
   */
  function withTurnMarks(list: ActivityRow[], historical: boolean): any[] {
    const first = new Map<string, number>()
    const last = new Map<string, number>()
    for (const r of list) {
      if (!r.turn) continue
      const k = `${r.sessionId ?? ''}|${r.turn}`
      if (!first.has(k)) first.set(k, r.seq)
      last.set(k, r.seq)
    }
    return list.map((r) => {
      if (!r.turn) return r
      const k = `${r.sessionId ?? ''}|${r.turn}`
      const closed = historical || (closedTurns.get(r.sessionId ?? '')?.has(r.turn) ?? false)
      return { ...r, turnStart: first.get(k) === r.seq, turnEnd: closed && last.get(k) === r.seq }
    })
  }

  /** skill name → 文件路径缓存（skill 工具调用时填充；也定期刷新清单） */
  const skillPaths = new Map<string, string>()
  async function refreshSkillPaths() {
    try {
      const skills = (ctx as any).skills as SkillsLike | undefined
      if (!skills?.list) return
      for (const s of await skills.list()) {
        if (s.path) skillPaths.set(s.name, s.path)
      }
    } catch { /* skills 服务不可用时静默 */ }
  }
  void refreshSkillPaths()
  const skillsTimer = setInterval(() => { void refreshSkillPaths() }, 10_000)
  ctx.effect(() => () => clearInterval(skillsTimer), 'activity-monitor: skill path refresher')

  /** 最新一次 assemble 的结果缓存（后台定期刷新，避免在 waterfall 栈内死锁） */
  let cachedSections: any[] | undefined
  let cachedContexts: any[] | undefined
  // 关键：捕获 systemPrompt 服务的直接引用（fiber 上下文在插件卸载后失效）
  const sp = (ctx as any).systemPrompt
  async function cacheAssembly() {
    try {
      const assembly = await sp?.assemble?.()
      if (assembly?.sections) {
        cachedSections = assembly.sections
        cachedContexts = assembly.contexts
      }
    } catch { /* 静默 */ }
  }
  // 首次刷新延迟到挂载完成后（apply 内同步 assemble 会死锁）
  const firstRefresh = setTimeout(() => { void cacheAssembly() }, 500)
  const assemblyTimer = setInterval(() => { void cacheAssembly() }, 2000)
  ctx.effect(() => () => { clearTimeout(firstRefresh); clearInterval(assemblyTimer) }, 'activity-monitor: assembly cache refresher')

  /** 从注册名推断 section 来源描述 */
  function describeSectionSource(name: string): string {
    // dsh 官方 section：harness:identity / deployment:persona-prefix / dsh-tool-bash:…
    if (name.startsWith('harness:')) return '（dsh 内置）'
    if (name.startsWith('deployment:')) return '（部署 persona 配置）'
    const m = name.match(/^dsh-([a-z-]+):/)
    if (m) return `（dsh 官方插件 @deepseek-ai/dsh-${m[1]}）`
    const skill = name.match(/^skill:(.+)$/)
    if (skill) {
      const p = skillPaths.get(skill[1])
      return p ? `（skill 文件 ${p}）` : `（skill ${skill[1]}）`
    }
    return ''
  }

  /** 从工具名+参数归类出活动标签和摘要 */
  function classify(toolName: string, args: any): { tag: string; summary: string } {
    const a = args ?? {}
    switch (toolName) {
      case 'skill':
        return { tag: 'skill', summary: `skill: ${a.name ?? '?'}` }
      case 'read':
      case 'view':
      case 'view_file':
      case 'view_file_range':
        return { tag: 'file-read', summary: String(a.path ?? a.file_path ?? a.abs_path ?? '?') }
      case 'write':
      case 'str_replace_editor':
      case 'str_replace_based_edit_tool':
      case 'edit':
      case 'write_file':
        return { tag: 'file-write', summary: String(a.path ?? a.file_path ?? '?') }
      case 'bash':
      case 'bash_persistent':
      case 'pwsh':
      case 'pwsh_persistent':
        return { tag: 'command', summary: String(a.command ?? a.cmd ?? '').split('\n')[0].slice(0, 160) }
      default: {
        const pathLike = a.path ?? a.file_path ?? a.abs_path
        if (typeof pathLike === 'string') return { tag: 'file-read', summary: `${toolName}: ${pathLike}` }
        return { tag: 'tool', summary: toolName }
      }
    }
  }

  // ── 工具调用监控 ──
  ctx.on('tools/execute', async (exec, next) => {
    const args = (exec as any).arguments ?? (exec as any).args ?? {}
    const { tag, summary } = classify(exec.name, args)
    // 工具调用所属会话（agent loop 执行时携带）
    const sessionId: string | undefined = (exec as any).agent?.session?.id
      ? String((exec as any).agent.session.id)
      : undefined
    const start = Date.now()
    try {
      const result = await next()
      // 提取结果文本：result.content 里 TextBlock 的 text
      const content = (result as any)?.content
      let resultText = ''
      if (Array.isArray(content)) {
        resultText = content
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
      }
      if (!resultText) {
        const v = (result as any)?.value
        if (v != null) resultText = typeof v === 'string' ? v : JSON.stringify(v)
      }
      if ((result as any)?.isError) {
        resultText = resultText || String((result as any)?.error?.message ?? 'tool error')
      }
      record({
        kind: 'tool',
        sessionId,
        name: exec.name,
        tag,
        summary,
        durationMs: Date.now() - start,
        ok: !(result as any)?.isError,
        // 默认折叠；参数与结果都不再按 3000 字截断，只受总量上限保护（超出会标注）
        detail: [
          '── 参数 ──',
          clampText(JSON.stringify(args, null, 2), TOOL_DETAIL_BUDGET_BYTES),
          '── 结果 ──',
          resultText
            ? clampText(resultText, TOOL_DETAIL_BUDGET_BYTES)
            : '（工具未返回文本结果）',
        ].join('\n'),
      })
      return result
    } catch (err: any) {
      record({
        kind: 'tool',
        sessionId,
        name: exec.name,
        tag,
        summary,
        durationMs: Date.now() - start,
        ok: false,
        detail: [
          '── 参数 ──',
          JSON.stringify(args, null, 2),
          '── 异常 ──',
          String(err?.message ?? err).slice(0, 2000),
        ].join('\n'),
      })
      throw err
    }
  })

  // ── 模型请求监控 ──
  ctx.on('llm/stream', async function* (options, next) {
    const start = Date.now()
    let usage = ''
    let replyText = ''
    let failed = false

    // 提取 system prompt（提示词本体）
    const systemMsg = options.messages?.find((m: any) => m?.role === 'system')
    const systemText: string = systemMsg?.content
      ? (Array.isArray(systemMsg.content)
          ? systemMsg.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
          : String(systemMsg.content))
      : ''

    // 最后一条用户消息（对话内容）
    const userMessages = options.messages?.filter((m: any) => m?.role === 'user') ?? []
    const lastUser = userMessages[userMessages.length - 1]
    const lastUserText: string = lastUser?.content
      ? (Array.isArray(lastUser.content)
          ? lastUser.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
          : String(lastUser.content))
      : ''

    // 使用后台缓存的 assembly（不在 waterfall 栈内 assemble，会死锁）
    let assemblySections = cachedSections
    let assemblyContexts = cachedContexts

    try {
      const stream = next()
      for await (const chunk of stream) {
        const u = (chunk as any)?.usage
        if (u) usage = `${u.inputTokens ?? '?'}in / ${u.outputTokens ?? '?'}out`
        // 累积助手回复文本
        if ((chunk as any)?.type === 'text-delta') replyText += (chunk as any).text ?? ''
        yield chunk
      }
    } catch (err: any) {
      failed = true
      record({
        kind: 'llm',
        sessionId: options.sessionId ? String(options.sessionId) : undefined,
        name: `${options.provider}/${options.model}`,
        tag: 'llm',
        summary: `模型调用失败`,
        durationMs: Date.now() - start,
        ok: false,
        detail: String(err?.message ?? err).slice(0, 1500),
      })
      throw err
    } finally {
      if (!failed) {
        // 用流开始前缓存的 assembly（带注册名），每段标注来源
        let promptSections: ActivitySection[] = []
        if (assemblySections?.length) {
          promptSections = assemblySections
            .filter((s: any) => (s.text ?? '').trim().length > 0)
            .map((s: any, i: number) => {
              const src = describeSectionSource(s.name)
              const title = src
                ? `${i + 1}. ${s.name} ${src}`
                : `${i + 1}. ${s.name}（第三方插件注册）`
              // key 非空 → 前端二级折叠（提示词正文默认不展开）；正文不截断
              return { title, body: s.text, key: `sec:${s.name}` }
            })
          for (const c of assemblyContexts ?? []) {
            if ((c.text ?? '').trim()) {
              promptSections.push({ title: `runtime-context: ${c.name}`, body: c.text, key: `ctx:${c.name}` })
            }
          }
        }

        // 回退：没有 assemble 结果时，从渲染文本按空行拆分（无名段落）
        if (promptSections.length === 0 && systemText) {
          promptSections = splitSystemPrompt(systemText).map((s, i) => ({ ...s, key: `fb:${i}` }))
        }

        // 展开区的段落顺序 = 一次请求的自然阅读顺序：
        // 用户消息（触发这轮的东西） → 系统提示词（分组，默认收起） → 助手回复（这轮的产物，放最后）
        const PROMPT_GROUP_KEY = 'group:prompt'
        const sections: ActivitySection[] = []
        if (lastUserText) {
          sections.push({ title: '用户消息（最近一条）', body: lastUserText })
        }
        if (promptSections.length > 0) {
          sections.push({
            title: `系统提示词（${promptSections.length} 个 section，按生效顺序）`,
            body: '',
            key: PROMPT_GROUP_KEY,
            isGroup: true,
          })
          for (const s of promptSections) sections.push({ ...s, parent: PROMPT_GROUP_KEY })
        }
        // 另外两套视图：真正发给模型的完整消息序列 + 工具清单（与上面「按注册来源分段」并列）
        const ctx = buildContextSections(options.messages ?? [], options.tools ?? [])
        for (const s of ctx.sections) sections.push(s)
        // 本次请求里发起的工具调用及其在消息序列里的位置（前端把工具行对回上下文用）
        const calls = collectToolCalls(options.messages ?? [])
        if (replyText) {
          sections.push({ title: '助手回复', body: replyText })
        }
        record({
          kind: 'llm',
          sessionId: options.sessionId ? String(options.sessionId) : undefined,
          name: `${options.provider}/${options.model}`,
          tag: 'llm',
          summary: `${usage || '流式完成'} · 回复 ${replyText.length} 字 · ${ctx.messageCount} 条消息 · `
            + `${options.tools?.length ?? 0} 个工具 · 上下文 ${fmtBytes(ctx.contextBytes)} + 工具 ${fmtBytes(ctx.toolBytes)}`
            + `${ctx.omitted ? `（${ctx.omitted} 项超预算已省略）` : ''} · ${promptSections.length} 段提示词`
            + `${calls.length ? ` · 本轮发起 ${calls.length} 个调用` : ''}`,
          durationMs: Date.now() - start,
          ok: true,
          sections,
          calls,
        })
      }
    }
  })

  // ── 快照端点 ──
  // 历史会话列表 + 会话监控历史查询
  ctx.effect(() => (ctx as any).webServer.register({
    kind: 'exact' as const,
    path: '/api/activity-monitor/history',
    handler: async (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sid = url.searchParams.get('sessionId')
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      if (!sid) {
        // 列出所有有监控历史的 session
        try {
          const files = readdirSync(HISTORY_DIR)
          const sessions = files
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => {
              const id = f.replace(/\.jsonl$/, '')
              let count = 0
              let lastTs = 0
              try {
                const content = readFileSync(path.join(HISTORY_DIR, f), 'utf8')
                for (const line of content.split('\n')) {
                  if (!line.trim()) continue
                  count++
                  try { lastTs = Math.max(lastTs, JSON.parse(line).ts ?? 0) } catch { /* skip */ }
                }
              } catch { /* ignore */ }
              return { sessionId: id === 'global' ? null : id, count, lastTs }
            })
            .sort((a, b) => b.lastTs - a.lastTs)
          res.end(JSON.stringify({ sessions }))
        } catch {
          res.end(JSON.stringify({ sessions: [] }))
        }
      } else {
        // 读取指定 session 的完整监控历史（时间正序）
        const file = path.join(HISTORY_DIR, `${sid.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`)
        const out: any[] = []
        try {
          const content = readFileSync(file, 'utf8')
          for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try { out.push(JSON.parse(line)) } catch { /* skip */ }
          }
        } catch { /* 无历史 */ }
        res.end(JSON.stringify({ sessionId: sid, rows: withTurnMarks(out, true), total: out.length }))
      }
    },
  }), 'activity-monitor: history route')

  ctx.effect(() => (ctx as any).webServer.register({
    kind: 'exact' as const,
    path: '/api/activity-monitor/snapshot',
    handler: async (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const since = Number(url.searchParams.get('since') ?? 0)
      const fresh = rows.filter((r) => r.seq > since)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        now: Date.now(),
        rows: withTurnMarks(fresh, false),
        total: rows.length,
      }))
    },
  }), 'activity-monitor: snapshot route')

  ctx.logger.info('[activity-monitor] ready')
}

/** 把渲染后的 system prompt 按 dsh section 之间的空行分段，识别常见 section 标题 */
function splitSystemPrompt(text: string): { title: string; body: string }[] {
  const blocks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  if (blocks.length === 0) return []
  return blocks.map((block, i) => {
    const firstLine = block.split('\n')[0]
    // Markdown 标题或 skill 正文特征（"# 开头"）作为段落标题
    const title = firstLine.startsWith('#')
      ? `段落 ${i + 1}: ${firstLine.replace(/^#+\s*/, '').slice(0, 60)}`
      : firstLine.length <= 70
        ? `段落 ${i + 1}: ${firstLine}`
        : `段落 ${i + 1}`
    return { title, body: truncateText(block, 2500) }
  })
}

function truncateText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…(截断，共 ${s.length} 字符)` : s
}

/** 只受总量上限保护：未超上限就原样返回，超了才截断并标注真实大小 */
function clampText(s: string, maxBytes: number): string {
  const size = byteLen(s)
  if (size <= maxBytes) return s
  return `${s.slice(0, maxBytes)}\n…（超出 ${fmtBytes(maxBytes)} 上限，共 ${fmtBytes(size)}，已截断）`
}

// ── 发给模型的完整上下文（消息序列 + 工具清单） ──
/**
 * 单条请求里「完整上下文 + 工具清单」的总字节预算。
 * 正文不截断，但总量封顶；超出时按「最旧优先」整条省略并标注（尾部才是本次真正生效的上下文）。
 */
const CONTEXT_BUDGET_BYTES = 300 * 1024
/** 单条工具结果的落盘上限（命令输出可能极大，避免把 JSONL 撑爆） */
const TOOL_DETAIL_BUDGET_BYTES = 300 * 1024
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')
const fmtBytes = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
/** 取首个非空行做摘要 */
function firstLine(s: string, max = 70): string {
  const line = (s.split('\n').find((l) => l.trim() !== '') ?? '').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 一块内容 → 可读文本（text / reasoning / image / file / tool-call / tool-result） */
function blockText(b: any): string {
  if (b == null) return ''
  if (typeof b === 'string') return b
  if (typeof b !== 'object') return String(b)
  switch (b.type) {
    case 'text':
      return String(b.text ?? '')
    case 'reasoning':
      return `[思考] ${String(b.text ?? '')}`
    case 'image':
      return `[图片 ${b.attachment?.name ?? b.attachment?.id ?? ''}]`.trim()
    case 'file':
      return `[文件 ${b.attachment?.name ?? b.attachment?.path ?? ''}]`.trim()
    case 'tool-call':
      return `→ 调用工具 ${b.name}(${String(b.arguments ?? '')})`
    case 'tool-result': {
      const inner = Array.isArray(b.content)
        ? (b.content as any[]).map(blockText).filter((t: string) => t !== '').join('\n')
        : String(b.content ?? '')
      return `${b.isError ? '[工具报错] ' : ''}${inner}`
    }
    default:
      if (typeof b.text === 'string') return b.text
      return JSON.stringify(b)
  }
}

/** 一条请求消息 → 角色标签 + 全文（reasoning 抽出来单独成段，默认折叠） */
function messagePart(m: any, i: number, callNames: Map<string, string>): { i: number; label: string; text: string; reasoning: string } {
  const role = String(m?.role ?? '?')
  const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: m?.content ?? '' }]
  const pieces: string[] = []
  const reason: string[] = []
  const calls: string[] = []
  let isToolResult = false
  let toolName: string | undefined = m?.source?.toolName ?? m?.name ?? undefined

  for (const b of blocks) {
    if (b?.type === 'tool-call') {
      calls.push(String(b.name ?? '?'))
      if (!toolName) toolName = String(b.name ?? '')
      pieces.push(blockText(b))
    } else if (b?.type === 'tool-result') {
      isToolResult = true
      // 工具名回填：tool 结果消息只带 toolCallId，名称来自前面那条 assistant 的 tool-call
      if (!toolName && b.toolCallId) toolName = callNames.get(String(b.toolCallId))
      pieces.push(blockText(b))
    } else if (b?.type === 'reasoning') {
      // 推理内容单独成段（保留全文，但界面默认折叠）
      const t = String(b.text ?? '')
      if (t.trim() !== '') reason.push(t)
    } else {
      const t = blockText(b)
      if (t.trim() !== '') pieces.push(t)
    }
  }
  // 兼容 wire 形态（tool_calls / tool_call_id）
  if (Array.isArray(m?.tool_calls)) {
    for (const c of m.tool_calls) {
      const n = c?.function?.name ?? c?.name ?? '?'
      calls.push(String(n))
      if (!toolName) toolName = String(n)
      pieces.push(`→ 调用工具 ${n}(${String(c?.function?.arguments ?? c?.arguments ?? '')})`)
    }
  }
  for (const key of ['tool_call_id', 'toolCallId']) {
    if (m?.[key]) {
      isToolResult = true
      if (!toolName) toolName = callNames.get(String(m[key]))
    }
  }

  let label: string
  if (role === 'system') label = `[${i}] [system]`
  else if (isToolResult) label = `[${i}] [tool 结果${toolName ? ` ← ${toolName}` : ''}]`
  else if (calls.length > 0) label = `[${i}] [assistant → 工具调用 ${calls.join(', ')}]`
  else label = `[${i}] [${role}]`

  return { i, label, text: pieces.join('\n'), reasoning: reason.join('\n') }
}

/**
 * 收集本次请求里模型发起的 tool-call 及其位置（第几条消息、该消息内第几个调用），
 * 并把 tool-result 回填到对应调用的 resultMsgIndex。
 */
function collectToolCalls(messages: any[]): { name: string; msgIndex: number; callIndex: number; resultMsgIndex?: number }[] {
  const calls: { name: string; msgIndex: number; callIndex: number; resultMsgIndex?: number; id?: string }[] = []
  const byId = new Map<string, number>() // toolCallId → calls 下标
  ;(messages ?? []).forEach((m, i) => {
    const blocks = Array.isArray(m?.content) ? m.content : []
    let n = 0
    for (const b of blocks) {
      if (b?.type === 'tool-call') {
        n++
        calls.push({ name: String(b.name ?? '?'), msgIndex: i, callIndex: n, id: b.id ? String(b.id) : undefined })
        if (b.id) byId.set(String(b.id), calls.length - 1)
      } else if (b?.type === 'tool-result' && b.toolCallId != null) {
        const at = byId.get(String(b.toolCallId))
        if (at !== undefined) calls[at].resultMsgIndex = i
      }
    }
    // OpenAI 兼容形态
    if (Array.isArray(m?.tool_calls)) {
      for (const c of m.tool_calls) {
        n++
        const id = c?.id ?? c?.function?.id
        calls.push({ name: String(c?.function?.name ?? c?.name ?? '?'), msgIndex: i, callIndex: n, id: id ? String(id) : undefined })
        if (id) byId.set(String(id), calls.length - 1)
      }
    }
    if (m?.tool_call_id != null || m?.toolCallId != null) {
      const id = String(m.tool_call_id ?? m.toolCallId)
      const at = byId.get(id)
      if (at !== undefined) calls[at].resultMsgIndex = i
    }
  })
  return calls.map(({ name, msgIndex, callIndex, resultMsgIndex }) => ({ name, msgIndex, callIndex, resultMsgIndex }))
}

/**
 * 组装两个分组：「完整上下文（N 条消息）」与「工具清单（N 个 · 只列名）」。
 * 消息共享 CONTEXT_BUDGET_BYTES 预算，按「最新 → 最旧」分配，装不下的整条省略并标注；
 * 工具清单只保留名字（不再保留 schema），因此不占预算、也不去重。
 */
function buildContextSections(messages: any[], tools: any[]): {
  sections: ActivitySection[]
  contextBytes: number
  toolBytes: number
  omitted: number
  messageCount: number
} {
  // 先收集 tool-call 的 id → 工具名，供 tool 结果消息回填名称
  const callNames = new Map<string, string>()
  for (const m of messages ?? []) {
    const blocks = Array.isArray(m?.content) ? m.content : []
    for (const b of blocks) {
      if (b?.type === 'tool-call' && b.id) callNames.set(String(b.id), String(b.name ?? ''))
    }
    if (Array.isArray(m?.tool_calls)) {
      for (const c of m.tool_calls) {
        const id = c?.id ?? c?.function?.id
        if (id) callNames.set(String(id), String(c?.function?.name ?? c?.name ?? ''))
      }
    }
  }
  const parts = (messages ?? []).map((m, i) => messagePart(m, i, callNames))
  let used = 0
  let omitted = 0
  // 尾部优先：本次真正生效的上下文在后面
  for (let idx = parts.length - 1; idx >= 0; idx--) {
    const size = byteLen(parts[idx].text) + byteLen(parts[idx].reasoning)
    if (used + size > CONTEXT_BUDGET_BYTES) {
      parts[idx].text = ''
      parts[idx].reasoning = ''
      omitted++
    } else {
      used += size
    }
  }
  const contextBytes = used

  const sections: ActivitySection[] = []
  if (parts.length > 0) {
    sections.push({
      title: `完整上下文（${parts.length} 条消息 · ${fmtBytes(contextBytes)}`
        + `${omitted ? ` · ${omitted} 条因超 ${fmtBytes(CONTEXT_BUDGET_BYTES)} 预算已省略` : ''}）`,
      body: '',
      key: 'group:context',
      isGroup: true,
    })
    for (const p of parts) {
      const cut = p.text === '' && p.reasoning === ''
      // 推理内容单独成段：排在对应消息之前（原文顺序是先想再答），保留全文但默认折叠
      if (p.reasoning !== '') {
        sections.push({
          title: `${p.label} [思考]（${p.reasoning.length} 字）`,
          body: p.reasoning,
          key: `think:${p.i}`,
          parent: 'group:context',
        })
      }
      sections.push({
        title: cut
          ? `${p.label}（超出预算，已省略）`
          : (p.text === '' ? `${p.label}（本条只有推理内容）` : `${p.label}  ${firstLine(p.text)}`),
        body: p.text,
        key: `msg:${p.i}`,
        parent: 'group:context',
      })
    }
  }
  // 工具清单：只保留工具名，不再保留 schema（每步体积从 ~136KB 降到名称本身）。
  // 工具名不去重 —— 重名条目按出现次数原样逐条列出，key 用下标保证唯一。
  const toolNames = (tools ?? []).map((t: any, i: number) => {
    if (typeof t === 'string') return { i, name: t }
    const fn = t?.function ?? t
    return { i, name: String(fn?.name ?? t?.name ?? '?') }
  })
  const toolBytes = toolNames.reduce((n, t) => n + byteLen(t.name) + 1, 0)
  if (toolNames.length > 0) {
    sections.push({
      title: `工具清单（${toolNames.length} 个 · 名称共 ${fmtBytes(toolBytes)}）`,
      body: '',
      key: 'group:tools',
      isGroup: true,
    })
    for (const t of toolNames) {
      sections.push({ title: t.name, body: '', key: `tool:${t.i}:${t.name}`, parent: 'group:tools' })
    }
  }
  return {
    sections,
    contextBytes,
    toolBytes,
    omitted,
    messageCount: parts.length,
  }
}
