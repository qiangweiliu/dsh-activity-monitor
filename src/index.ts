/**
 * dsh-activity-monitor — node 半（Host 侧）
 *
 * 监控对话运行时的所有操作，内存里维护一个活动环形缓冲：
 *  - llm/stream waterfall      → 每次模型请求（一个"轮次"）：模型名、耗时、token 用量，
 *    以及 system prompt 全文（从 messages 的 system 角色消息提取）+ 助手回复文本
 *  - tools/execute waterfall   → 每次工具调用（skill 加载、文件读写、命令执行……）
 *    从工具名+参数中归类出：skill 文件、读写文件、执行命令
 *
 * 轮次口径（面板自己维护，不取运行时的 turn 事件）：
 *   一个轮次 = 一次 agent 向模型发起的请求。轮次开始 = 请求发出（llm 占位行落下），
 *   轮次结束 = 该次模型回复完成（llm 行定稿）。轮次号 = 该会话内第 N 次模型请求。
 *   工具执行发生在两轮模型请求之间（上一轮回复里的 tool-call 被执行、结果追加进消息后
 *   才发起下一次请求），因此工具行归属「下一次」请求所在轮次（N+1），作为该轮的前置步骤。
 *
 * 所有行都走「进行中 → 定稿」两段式：调用一开始就落行（ok 缺省 = 进行中，
 * 前端按 rev 递增原地刷新）；结束时同一行补全耗时/详情/完整分段（seq/ts 不变、不新增行），
 * 定稿版本此时才写入按 session 分文件的 JSONL 历史。
 *
 * 展示约定（与浏览器半配合）：
 *  - detail 默认折叠；除非行内有 collapsed: false 标记，前端默认全部折叠
 *  - system prompt 按来源 section 拆分展示（从 systemMessageSections 记录）
 *
 * 通过 webServer 注册 /api/activity-monitor/snapshot 端点，浏览器侧板轮询读取。
 */
import { mkdirSync, appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
  /** 正文里各消息块在 body 中的起始偏移（渲染时按它切分，供组内按「第 n 条消息」跳转定位；正文本身不加标记） */
  anchorOffsets?: number[]
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
   * 本次请求所在轮次号（该会话内 agent 发起的第 N 次模型请求，从 1 起）。
   * 一个轮次 = 一次模型请求（agent 发消息给大模型 → 大模型回复完成）；
   * 工具执行发生在两轮之间，归属下一次请求所在轮次。
   * 不属于任何请求行的（理论上没有；标题生成等无 sessionId 的也按最近会话发号）
   */
  turn?: number
  /**
   * 本次请求里模型发起的工具调用及其在「完整上下文」中的位置：
   * msgIndex = 第几条消息（0 基，与界面上 [n] 一致）、callIndex = 该消息内第几个 tool-call（1 起）、
   * resultMsgIndex = 对应工具结果所在消息下标（工具结果还没回来时缺省）。
   * 前端据此把「工具行」对回消息序列里的位置。
   */
  calls?: { name: string; msgIndex: number; callIndex: number; resultMsgIndex?: number }[]
  /** 定稿标记：缺省/true = 已结束；false = 该行仍在进行中（调用还没结束） */
  readonly settled?: boolean
  durationMs?: number
  ok?: boolean
  /** 原始 token 用量（llm 行；缺省 = provider 未回报） */
  usageIn?: number
  usageOut?: number
  /** 发给模型的上下文规模（llm 行）：上下文字节数 / 消息条数 / 工具清单字节 */
  contextBytes?: number
  contextMessages?: number
  toolBytes?: number
  /** 该请求因超预算被整条省略的消息数（>0 = 模型没看到完整上下文） */
  contextOmitted?: number
  /**
   * 行版本：同 seq/ts 的行在「进行中 → 定稿」之间原地刷新，rev 随每次刷新递增；
   * 前端用它判断该行是否真的变了（变了才重渲染），不再依赖字段对比。
   */
  rev?: number
  /**
   * 所属进程运行 id：每个 dsh 进程 boot 时生成一个唯一号，随 JSONL 落盘。
   * seq / turn 都是「每进程」计数器，进程一重启就归零，历史 JSONL 跨重启合并后
   * 不同运行的编号会重叠（旧片段 seq 8/7 撞上新片段 seq 1/3）。runId 用来把
   * 数据按运行切分：agent 报告据此区分「本运行」与「跨重启的历史运行」，绝不混算。
   */
  runId?: string
}

const MAX_ROWS = 500

/**
 * 本进程运行 id：boot 时生成一次（时间戳 + 随机后缀，足以区分同机不同实例）。
 * 随每行落盘，agent 报告据此把「本运行」与「跨重启的历史运行」切开，避免把
 * 两个进程里各自 1..N 的 seq/turn 编号当成一套连续编号。历史 JSONL 里没有
 * 该字段的旧行视为「未知/重启前」运行。
 */
const RUN_ID = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

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

  // ── 轮次跟踪（面板自维护，不取运行时 turn 事件） ──
  // 轮次口径：一个轮次 = agent 向模型发起的一次请求。
  //   轮次开始 = 请求发出（llm 占位行落下，发号 turnsIssued+1）；
  //   轮次结束 = 该次模型回复完成（llm 行定稿，closedTurns 记一笔）。
  // 工具执行发生在两轮请求之间（上一轮回复里的 tool-call 被执行完，结果追加进消息后
  // 才发起下一次请求），所以工具行归属「下一次」请求的轮次号（upcoming = turnsIssued+1），
  // 作为该轮的前置步骤。
  const turnsIssued = new Map<string, number>()      // sessionId → 已发出的请求（轮次）数
  const closedTurns = new Map<string, Set<number>>() // sessionId → 已结束（模型回复完成）的轮次号
  let lastTurnSession: string | undefined            // 兜底：行没有 sessionId 时沿用最近一次请求所属会话
  /** upcoming 轮次号：工具行（在请求之间执行）归属的轮次 */
  function turnFor(sessionId?: string): number | undefined {
    const sid = sessionId ?? lastTurnSession
    if (!sid) return undefined
    return (turnsIssued.get(sid) ?? 0) + 1
  }
  /** 给某 (session, turn) 记「已结束」 */
  function closeTurn(sessionId: string, turn: number): void {
    let set = closedTurns.get(sessionId)
    if (!set) { set = new Set(); closedTurns.set(sessionId, set) }
    set.add(turn)
  }

  /**
   * 已落盘的逻辑行键（首次 record 时的 seq:ts）：同一逻辑行只写一次 JSONL。
   * 挤出缓冲后 updateRow 会重排 seq（新 seq 作内存键），但逻辑键不变 —— 去重按逻辑键。
   */
  const persistedKeys = new Set<string>()
  function persist(full: ActivityRow, logicKey?: string): void {
    const k = logicKey ?? `${full.seq}:${full.ts}`
    if (persistedKeys.has(k)) return
    try {
      const file = path.join(HISTORY_DIR, `${(full.sessionId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`)
      appendFileSync(file, JSON.stringify(full) + '\n')
      persistedKeys.add(k)
    } catch { /* 磁盘异常不影响主流程 */ }
  }

  /**
   * 追加内存行 + 落盘历史（按 session 分文件）。
   * 两段式「进行中 → 定稿」：
   *  - 进行中占位行（settled: false）只进内存缓冲（snapshot 端点可读到「进行中」状态），
   *    不写 JSONL —— 进行中的内容持续增长，逐次落盘既撑爆文件，也会让历史端点读到半成品行。
   *  - 定稿行（settled 非 false）进缓冲并写 JSONL 历史。
   * 调用方拿回生成的行（带 seq/ts/rev），结束时交给 updateRow() 原地刷新同一行。
   */
  function record(row: Omit<ActivityRow, 'seq' | 'ts' | 'rev'> & { settled?: boolean }): ActivityRow {
    const settled = row.settled !== false
    const base = { ...row, turn: row.turn ?? turnFor(row.sessionId), seq: 0, ts: 0 } as unknown as Record<string, unknown>
    base.seq = ++seq
    base.ts = Date.now()
    base.settled = settled
    base.rev = 0
    base.runId = RUN_ID
    const full = base as unknown as ActivityRow
    rows.push(full)
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS)
    if (settled) persist(full)
    return full
  }

  /**
   * 原地刷新一个进行中的占位行（进行中 → 定稿，或占位行内容增量更新）：
   * seq/ts 保持不变、rev+1、settled/其余字段覆盖。若该行已被环形缓冲挤出（超长会话），
   * 定稿版本按新行补一条（seq 重排没关系，ts 仍是真实时间戳）。
   */
  function updateRow(existing: ActivityRow, patch: Omit<ActivityRow, 'seq' | 'ts' | 'rev'> & { settled?: boolean }): ActivityRow {
    const settled = patch.settled !== false
    const idx = rows.findIndex((r) => r.seq === existing.seq && r.ts === existing.ts)
    const base = idx >= 0 ? rows[idx] : existing
    const next = { ...base, ...patch, settled } as ActivityRow
    if (idx >= 0) {
      ;(next as any).rev = (base.rev ?? 0) + 1
      rows[idx] = next
    } else {
      ;(next as any).seq = ++seq
      ;(next as any).rev = 0
      rows.push(next)
      if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS)
    }
    if (settled) persist(next)
    return next
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
  // 两段式：开始执行就落「进行中」占位行（只有参数、无结果），
  // 结束后 updateRow 原地刷成定稿（补结果/耗时/ok）。长命令执行中面板就能看见它。
  ctx.on('tools/execute', async (exec, next) => {
    const args = (exec as any).arguments ?? (exec as any).args ?? {}
    const { tag, summary } = classify(exec.name, args)
    // 工具调用所属会话（agent loop 执行时携带）
    const sessionId: string | undefined = (exec as any).agent?.session?.id
      ? String((exec as any).agent.session.id)
      : undefined
    const start = Date.now()
    const common = {
      kind: 'tool' as const,
      sessionId,
      name: exec.name,
      tag,
      summary,
    }
    // 占位：进行中（参数已可见；结果未回）。seq/ts 由 record 生成，定稿时原样传回
    const pending = record({
      ...common,
      settled: false,
      detail: [
        '── 参数 ──',
        clampText(JSON.stringify(args, null, 2), TOOL_DETAIL_BUDGET_BYTES),
        '── 结果 ──',
        '（执行中…）',
      ].join('\n'),
    })
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
      updateRow(pending, {
        ...common,
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
      updateRow(pending, {
        ...common,
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
  // 两段式：请求发起就落「进行中」占位行（模型名 + 请求规模可见）；
  // 流式 delta 到达时按 ~150ms 节流原地刷新（摘要里的字数控件 + 回复预览实时增长）；
  // 流结束时 updateRow 定稿（完整分段 + 真实耗时 + usage + 工具调用位置）。
  ctx.on('llm/stream', async function* (options, next) {
    const start = Date.now()
    let usage = ''
    /** 原始 token 用量（供 agent 报告聚合求和） */
    let usageTokens: { input: number; output: number } | undefined
    let replyText = ''
    let reasoningText = ''
    let failed = false
    let lastLiveUpdate = 0

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

    // 进行中的占位行：请求还没出结果，先给一行「模型生成中」让面板立刻可见。
    // 发号：一次请求 = 一个轮次。有 sessionId 的记在该会话名下（面板按会话分组）；
    // 没有的（如会话标题生成）沿用最近一次请求所属会话发号，与旧行为一致。
    const modelLabel = `${options.provider}/${options.model}`
    const sid = options.sessionId ? String(options.sessionId) : (lastTurnSession ?? undefined)
    let turnNo: number | undefined
    if (sid) {
      turnNo = (turnsIssued.get(sid) ?? 0) + 1
      turnsIssued.set(sid, turnNo)
      lastTurnSession = sid
    }
    const pending = record({
      kind: 'llm',
      sessionId: options.sessionId ? String(options.sessionId) : undefined,
      name: modelLabel,
      tag: 'llm',
      summary: `模型生成中… · ${options.messages?.length ?? 0} 条消息 · ${options.tools?.length ?? 0} 个工具`,
      settled: false,
      turn: turnNo,
    })

    /** 流进行中的原地刷新（节流）：摘要 + 已回文字预览 */
    function touchLive(now: number): void {
      if (now - lastLiveUpdate < 150) return
      lastLiveUpdate = now
      const parts = ['模型生成中…']
      if (replyText) parts.push(`已回 ${replyText.length} 字`)
      if (reasoningText) parts.push(`思考 ${reasoningText.length} 字`)
      if (usage) parts.push(usage)
      const live: Parameters<typeof record>[0] = {
        kind: 'llm',
        sessionId: pending.sessionId,
        name: modelLabel,
        tag: 'llm',
        summary: parts.join(' · '),
        settled: false,
        // usage chunk 一到就挂上数值字段：进行中行的行内 ⚡token 计数也能实时上屏
        ...(usageTokens ? { usageIn: usageTokens.input, usageOut: usageTokens.output } : {}),
      }
      if (replyText) {
        live.sections = [{ title: '助手回复（生成中…）', body: replyText }]
      }
      updateRow(pending, live)
    }

    try {
      const stream = next()
      for await (const chunk of stream) {
        const c = chunk as any
        if (c?.type === 'usage' && c.usage) {
          usage = `${c.usage.inputTokens ?? '?'}in / ${c.usage.outputTokens ?? '?'}out`
          usageTokens = { input: c.usage.inputTokens ?? 0, output: c.usage.outputTokens ?? 0 }
          touchLive(Date.now())
        } else if (c?.type === 'text-delta') {
          replyText += c.text ?? ''
          touchLive(Date.now())
        } else if (c?.type === 'reasoning-delta') {
          reasoningText += c.text ?? ''
          touchLive(Date.now())
        }
        yield chunk
      }
    } catch (err: any) {
      failed = true
      updateRow(pending, {
        kind: 'llm',
        sessionId: options.sessionId ? String(options.sessionId) : undefined,
        name: modelLabel,
        tag: 'llm',
        summary: '模型调用失败',
        durationMs: Date.now() - start,
        ok: false,
        detail: String(err?.message ?? err).slice(0, 1500),
      })
      // 模型回复失败 = 该轮结束（不会有后续），同样记「已结束」
      if (sid && turnNo) closeTurn(sid, turnNo)
      throw err
    } finally {
      if (!failed) {
        // 模型回复完成 = 该轮结束
        if (sid && turnNo) closeTurn(sid, turnNo)
        // 使用流开始前缓存的 assembly（带注册名），每段标注来源（不在 waterfall 栈内 assemble，会死锁）
        let promptSections: ActivitySection[] = []
        const assemblySections = cachedSections
        const assemblyContexts = cachedContexts
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
        updateRow(pending, {
          kind: 'llm',
          sessionId: options.sessionId ? String(options.sessionId) : undefined,
          name: modelLabel,
          tag: 'llm',
          summary: `${usage || '流式完成'} · 回复 ${replyText.length} 字 · ${ctx.messageCount} 条消息 · `
            + `${options.tools?.length ?? 0} 个工具 · 上下文 ${fmtBytes(ctx.contextBytes)} + 工具 ${fmtBytes(ctx.toolBytes)}`
            + `${ctx.omitted ? `（${ctx.omitted} 项超预算已省略）` : ''} · ${promptSections.length} 段提示词`
            + `${calls.length ? ` · 本轮发起 ${calls.length} 个调用` : ''}`,
          durationMs: Date.now() - start,
          ok: true,
          sections,
          calls,
          // 数值化字段：供 agent 报告工具聚合求和（token / 上下文规模）
          ...(usageTokens ? { usageIn: usageTokens.input, usageOut: usageTokens.output } : {}),
          contextBytes: ctx.contextBytes,
          contextMessages: ctx.messageCount,
          toolBytes: ctx.toolBytes,
          contextOmitted: ctx.omitted,
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

  // ── agent 侧：activity_report 工具（agent 自查监控数据） ──
  // 懒注册：仅当 tools 服务存在时才装载（子 fiber 延迟注入；缺服务则停留 PENDING，
  // 监控核心照常跑，bare-Context 冒烟测试不受影响）。工具读「内存环形缓冲 + 该会话
  // 历史 JSONL」聚合成结构化报告，供 agent 在运行中自查 token/工具/失败/上下文压力，
  // 自行决定换路 / 压缩 / 重开 / 降低重复。信号只陈述事实，不替 agent 决策。
  // defineTool 动态引入（dsh-tools 是可选 peer）：顶层模块不硬依赖，
  // 没有 tools 服务的部署里插件照常加载，只是不暴露这个工具。
  // 同时注册一个只读端点 /api/activity-monitor/registered-tools：
  // 实时列出本实例里 dsh-tools 注册表中的工具名（含 activity_report 自身），
  // 既是本工具的端到端验证器，也是「agent 侧到底挂没挂上」的排障入口。
  const subFiber = ctx.inject(['tools', 'webServer'] as const, (subCtx: Context) => {
    const tools = (subCtx as any).tools
    if (!tools?.register) return
    // 已注册工具清单端点（在真实组合树里读 dsh-tools 注册表）
    const ws = (subCtx as any).webServer
    ws?.register?.({
      kind: 'exact' as const,
      path: '/api/activity-monitor/registered-tools',
      handler: async (_req: any, res: any) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        let names: string[] = []
        try {
          names = ((tools.schemas() ?? []) as any[]).map((s) => s.name).sort()
        } catch { /* 注册表未就绪 */ }
        res.end(JSON.stringify({
          tools: names,
          activityReportRegistered: names.includes('activity_report'),
        }))
      },
    })
    let disposer: (() => void) | undefined
    void (async () => {
      const { defineTool } = await import('@deepseek-ai/dsh-tools')
      // parameters 用 spec 形式（编译器生成给模型看的 JSON Schema）；
      // output.schema 用 author spec（type:'json' = 不校验具体形状，注册表只要求可无失真 JSON），
      // render 负责把报告投成文本块（要点 + 完整 JSON，agent 可直接解析）。
      const def = defineTool({
        name: 'activity_report',
        description:
          '查询本次会话（或指定会话）的活动监控报告：模型/工具调用量、token 用量、耗时、' +
          '各工具调用频次与失败、上下文相对预算的压力与是否被截断、近期明细，以及一组陈述性 signals。' +
          '只陈述观察到的事实与阈值判断，不替你决策——你据此自行判断是否换路 / 压缩 / 重开会话 / 降低重复。' +
          '在长任务、批量重试、上下文逼近上限时调用它自查。',
        parameters: {
          sessionId: {
            type: 'string',
            description: '要查询的会话 id。缺省 = 当前 agent 正在运行的会话；无会话时统计全量内存缓冲。',
          },
          recentTurns: {
            type: 'number',
            description: '只统计最近 N 个轮次（按轮次号取最大的 N）；缺省 = 该范围全量。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              report: { type: 'json' },
            },
          },
          render: (_args: any, value: any) => {
            // 一段人类/agent 可读文本：要点 + 完整 JSON（agent 可直接解析 JSON）
            const r = value?.report as AgentReport | undefined
            if (!r) return [{ type: 'text', text: '（activity_report 无数据可报）' }]
            const lines: string[] = []
            lines.push(`活动监控报告（${r.scope}） 会话 ${r.sessionId ?? '(全量)'}`)
            const t = r.totals
            lines.push(
              `合计：模型请求 ${t.llmCalls} 次 / 工具 ${t.toolCalls} 次 / 失败 ${t.failedCalls} 次 · ` +
              `轮次 ${t.turns} 个 · 进行中 ${t.inFlight} 条`,
            )
            lines.push(
              `耗时：活跃调用合计 ${t.durationMs}ms（已定稿调用之和）· 墙钟跨度 ${t.spanMs}ms（本运行首→末事件，含空闲等待）`,
            )
            if (t.inputTokens || t.outputTokens) {
              lines.push(`token：输入 ${t.inputTokens} / 输出 ${t.outputTokens}`)
            }
            if (r.tools.byName.length) {
              lines.push('工具频次：' + r.tools.byName.map((e) => `${e.name}×${e.count}${e.failed ? `(失败${e.failed})` : ''}`).join('，'))
            }
            if (r.context.lastContextBytes != null) {
              lines.push(`上下文：${r.context.note}`)
            }
            if (r.selfNote) lines.push(`注：${r.selfNote}`)
            if (r.history) {
              const h = r.history.runs
                .map((x) => `${x.runId}（${x.rows} 行 · 模型 ${x.llmCalls} / 工具 ${x.toolCalls}）`)
                .join('；')
              lines.push(`历史（跨重启，未并入合计）：${h}`)
            }
            if (r.signals.length) {
              lines.push('信号：')
              for (const s of r.signals) lines.push(`  [${s.severity}] ${s.text}`)
            }
            lines.push('完整 JSON：')
            lines.push(JSON.stringify(r, null, 2))
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute(args: any, exec: any) {
          const a = (args ?? {}) as { sessionId?: unknown; recentTurns?: unknown }
          const agentSid = exec?.agent?.session?.id != null ? String(exec.agent.session.id) : undefined
          const explicit = typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : undefined
          let rowsAll: ActivityRow[]
          if (explicit === undefined && agentSid !== undefined) {
            // 当前会话：内存过滤 + 该会话历史 JSONL 合并（补回被环形缓冲挤出的旧行）
            rowsAll = mergeActivityRows(rows.filter((rr) => rr.sessionId === agentSid), loadHistoryRows(agentSid))
          } else if (explicit) {
            rowsAll = mergeActivityRows(rows.filter((rr) => rr.sessionId === explicit), loadHistoryRows(explicit))
          } else {
            rowsAll = rows // 无会话：统计全量内存缓冲
          }
          return {
            // 报告对象是可 JSON 化的普通数据（运行时满足 JsonValue）；AgentReport 接口
            // 因 readonly + 缺索引签名无法被 TS 直接证明，故断言。
            report: buildAgentReport({
              rows: rowsAll,
              sessionId: explicit ?? agentSid ?? null,
              contextBudgetBytes: CONTEXT_BUDGET_BYTES,
              recentTurns: typeof a.recentTurns === 'number' && a.recentTurns > 0 ? Math.floor(a.recentTurns) : undefined,
            }) as any,
          }
        },
      })
      disposer = tools.register(def)
      subCtx.logger?.info?.('[activity-monitor] agent 报告工具 activity_report 已注册（agent 可自查 token/工具/失败/上下文压力）')
    })().catch((err: any) => {
      // dsh-tools 缺失或注册失败：监控核心不受影响，仅不暴露工具；留痕便于排查
      subCtx.logger?.warn?.('[activity-monitor] activity_report 工具未注册：' + String(err?.message ?? err))
    })
    // 子 fiber 卸载时反注册：setup 无动作，把 unregister 放进 teardown（disposer 由闭包持有，
    // 异步注册完成前卸载则为 undefined，跳过即可；disposer 幂等，可安全重复调用）
    subCtx.effect(() => () => {
      disposer?.()
    }, 'activity-monitor: agent_report tool')
  })
  void subFiber

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
 * 这也是 agent_report 工具判断「上下文是否逼近/超出监控预算」的依据（CONTEXT_BUDGET_BYTES）。
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

/** 一条请求消息 → 全文（reasoning 单独抽出；完整上下文正文里不加任何角色小标签） */
function messagePart(m: any, i: number, callNames: Map<string, string>): { i: number; text: string; reasoning: string } {
  void i
  const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: m?.content ?? '' }]
  const pieces: string[] = []
  const reason: string[] = []
  let toolName: string | undefined = m?.source?.toolName ?? m?.name ?? undefined

  for (const b of blocks) {
    if (b?.type === 'tool-call') {
      if (!toolName) toolName = String(b.name ?? '')
      pieces.push(blockText(b))
    } else if (b?.type === 'tool-result') {
      // 工具名回填：tool 结果消息只带 toolCallId，名称来自前面那条 assistant 的 tool-call
      if (!toolName && b.toolCallId) toolName = callNames.get(String(b.toolCallId))
      pieces.push(blockText(b))
    } else if (b?.type === 'reasoning') {
      // 推理内容单独抽出（保留全文，正文按「思考在前、回复在后」排开）
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
      if (!toolName) toolName = String(n)
      pieces.push(`→ 调用工具 ${n}(${String(c?.function?.arguments ?? c?.arguments ?? '')})`)
    }
  }
  for (const key of ['tool_call_id', 'toolCallId']) {
    if (m?.[key]) {
      if (!toolName) toolName = callNames.get(String(m[key]))
    }
  }

  return { i, text: pieces.join('\n'), reasoning: reason.join('\n') }
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
 * 组装「完整上下文」分组：里面只放一条正文 = 真正发给模型的完整消息序列原文（含思考、
 * 工具调用、工具结果，全文不截断；超预算仍按「最旧优先」整条省略并标注，尾部才是生效上下文）。
 * 不再拆成「每条消息一个分段 + 标题上的 [n] [角色] 小标签」，也不再另列「工具清单」——
 * 完整显示本身就是目的，小标签是多余的。
 * 组内跳转（工具行 → 某条消息）靠分组段的 anchorOffsets：前端把正文按消息块切分渲染，
 * 每块带 data-am-msg 属性可定位；偏移在宿主侧算好，正文本身不加任何标记字符。
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

  // 拼成一篇完整正文：推理 → 正文按原顺序逐条排开，块与块之间一个空行。
  // 被预算整条省略的条目保留一行占位（标注序号），序列仍是完整的。
  // anchorOffsets[i] = 第 i 条消息块在正文里的起始偏移（渲染时按它切分成可定位的元素）。
  const blocks: string[] = []
  for (const p of parts) {
    if (p.text !== '' || p.reasoning !== '') {
      blocks.push((p.reasoning !== '' ? `${p.reasoning}\n` : '') + (p.text !== '' ? p.text : ''))
    } else {
      blocks.push(`（消息 ${p.i}：超出预算，已省略）`)
    }
  }
  const anchorOffsets: number[] = []
  let off = 0
  for (let i = 0; i < blocks.length; i++) {
    anchorOffsets.push(off)
    off += blocks[i].length + 2 // 块间空行（join 的 '\n' + 空行）
  }
  const fullText = blocks.join('\n\n')

  // 工具清单不再单独成组：工具名在消息序列的工具调用块里可见，单独列一遍是冗余的小标签。
  const toolNames = (tools ?? []).map((t: any) => {
    if (typeof t === 'string') return t
    const fn = t?.function ?? t
    return String(fn?.name ?? t?.name ?? '?')
  })
  const toolBytes = toolNames.reduce((n, s) => n + byteLen(s) + 1, 0)

  const sections: ActivitySection[] = []
  sections.push({
    title: `完整上下文（${parts.length} 条消息 · ${fmtBytes(contextBytes)}`
      + `${omitted ? ` · ${omitted} 条因超 ${fmtBytes(CONTEXT_BUDGET_BYTES)} 预算已省略` : ''}`
      + ` · 工具 ${toolNames.length} 个 ${fmtBytes(toolBytes)}）`,
    body: fullText,
    key: 'group:context',
    isGroup: true,
    anchorOffsets,
  })
  return {
    sections,
    contextBytes,
    toolBytes,
    omitted,
    messageCount: parts.length,
  }
}

// ── agent 侧：结构化监控报告（供 agent 工具 activity_report 聚合） ──
/**
 * 面向 agent 的监控统计报告。给 agent 提供「自查信号」：
 * 调用量 / token / 耗时、各工具调用频次与失败、上下文压力（相对预算、是否截断），
 * 以及一组**陈述性**信号（signals）——只陈述观察到的事实与阈值判断，不替 agent 决策，
 * agent 据此自行判断是否换路 / 压缩 / 重开会话 / 降低重复。
 */
export interface AgentReport {
  readonly sessionId: string | null
  readonly generatedAt: number
  /** 取数范围描述（全量 / 最近 N 轮；跨重启时标注「本运行」） */
  readonly scope: string
  /** 本运行 id（进程 boot 生成）；历史 JSONL 里重启前的行带各自的旧 runId 或无 */
  readonly runId: string
  /** 数据是否跨多个进程运行（重启前后合并）；true 时 totals/tools/context 只反映本运行，历史单列于 history */
  readonly crossRun: boolean
  readonly totals: {
    llmCalls: number
    toolCalls: number
    failedCalls: number
    /** 本运行内的轮次数（seq/turn 都是每进程计数器，跨重启不续号，故只数本运行） */
    turns: number
    inFlight: number
    inputTokens: number
    outputTokens: number
    /** 活跃调用耗时之和（已定稿 llm+tool 行 durationMs 累加；进行中调用未定稿不计入） */
    durationMs: number
    /** 本运行首→末事件的墙钟跨度（含空闲等待，≈ 会话实际时间轴；与 durationMs 口径不同） */
    spanMs: number
  }
  readonly tools: {
    byName: { name: string; count: number; failed: number; avgMs: number; lastMs: number }[]
    /** 达到重复阈值的工具（按次数降序） */
    duplicated: { name: string; count: number; failed: number }[]
  }
  readonly failures: { seq: number; ts: number; kind: string; name: string; summary: string }[]
  readonly context: {
    lastTurn?: number
    lastContextBytes?: number
    lastContextMessages?: number
    budgetBytes: number
    /** 预算口径说明：这是「监控截断预算」，不是模型真实上下文窗口 */
    budgetLabel: string
    /** 最后请求上下文占监控预算比（可 >1 = 已超）；只反映监控缓冲，不代表真实余量 */
    pressure?: number
    truncated: boolean
    note?: string
  }
  /** 进行中（未定稿）调用；本报告的生成调用（activity_report）自身已剔除。startedAt=该调用发起时刻 */
  readonly inFlight: { seq: number; ts: number; kind: string; name: string; summary: string; startedAt: number }[]
  readonly signals: { severity: 'info' | 'warn'; text: string }[]
  /** 说明本次 activity_report 调用本身在取数时进行中，已从 inFlight 计数中剔除 */
  readonly selfNote?: string
  /** 跨重启的历史运行数据（本运行之外的片段），单列不并入 totals；无历史则缺省 */
  readonly history?: {
    runs: { runId: string; rows: number; firstTs: number; lastTs: number; llmCalls: number; toolCalls: number; failedCalls: number }[]
  }
  /** 本运行范围内最近若干条行（按时间倒序），供 agent 看明细 */
  readonly latest: { seq: number; ts: number; kind: string; name: string; tag: string; summary: string; ok?: boolean; turn?: number }[]
}

/** 合并内存行 + 历史行（按 seq:ts 去重，内存优先——内存是更新版本） */
function mergeActivityRows(mem: ActivityRow[], hist: ActivityRow[]): ActivityRow[] {
  const key = (r: ActivityRow) => `${r.seq}:${r.ts}`
  const m = new Map<string, ActivityRow>()
  for (const r of hist) m.set(key(r), r)
  for (const r of mem) m.set(key(r), r)
  return [...m.values()].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))
}

/** 读某会话的历史 JSONL → ActivityRow[]（按 ts 正序）。无文件 / 读失败 = 空。 */
function loadHistoryRows(sessionKey: string): ActivityRow[] {
  const out: ActivityRow[] = []
  try {
    const file = path.join(HISTORY_DIR, `${sessionKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`)
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line) as ActivityRow) } catch { /* skip 坏行 */ }
    }
  } catch { /* 无历史 */ }
  return out
}

/**
 * 纯聚合：从活动行生成 agent 报告。只陈述事实 + 阈值判断，不替 agent 下决策。
 * 阈值可调（dupThreshold / failingThreshold / pressureThreshold），缺省 3 / 2 / 0.8。
 */
export function buildAgentReport(input: {
  rows: ActivityRow[]
  sessionId: string | null
  contextBudgetBytes: number
  /** 只统计最近 N 个轮次（按 turn 分组取编号最大的 N）；缺省 = 全量 */
  recentTurns?: number
  dupThreshold?: number
  failingThreshold?: number
  pressureThreshold?: number
}): AgentReport {
  const { rows, contextBudgetBytes } = input
  const dupT = input.dupThreshold ?? 3
  const failT = input.failingThreshold ?? 2
  const pressT = input.pressureThreshold ?? 0.8
  /** 输入行先归一排序（工具路径上已由 mergeActivityRows 排好；直调方传未排序行也安全） */
  const ordered = [...rows].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))

  // ── 按进程运行切分：seq/turn 都是每进程计数器，重启即归零 ──
  // 本进程的行带当前 RUN_ID；历史 JSONL 里重启前的行带旧 runId 或无该字段。
  // totals/tools/failures/context/latest 只在本运行上聚合，历史片段单列于
  // report.history —— 避免把两段进程里各自 1..N 的编号/轮次当成一套连续口径（#2/#3/#5）。
  const cur = ordered.filter((r) => r.runId === RUN_ID)
  const hist = ordered.filter((r) => r.runId !== RUN_ID)
  const crossRun = hist.length > 0

  // 轮次范围过滤（只作用于本运行：历史片段的 turn 编号与本轮不可比）
  let scope = cur
  let scopeLabel = '全量'
  if (input.recentTurns && input.recentTurns > 0) {
    const allTurns = [...new Set(cur.map((r) => r.turn).filter((t): t is number => t != null))]
    const keep = new Set(allTurns.sort((a, b) => b - a).slice(0, input.recentTurns))
    scope = cur.filter((r) => r.turn != null && keep.has(r.turn))
    scopeLabel = `最近 ${input.recentTurns} 轮`
  }
  if (crossRun) scopeLabel = `${scopeLabel}（仅本运行；重启前片段单列于 history）`

  const llm = scope.filter((r) => r.kind === 'llm')
  const toolRowsAll = scope.filter((r) => r.kind === 'tool')
  const failed = scope.filter((r) => r.ok === false)
  const inFlight = scope.filter((r) => r.settled === false)
  // 自我观测剔除（#4）：生成本报告的 activity_report 调用自身此刻进行中（settled:false），
  // 从 inFlight 计数 / 工具频次 / 明细里剔除，改由 selfNote 说明，避免每次调用必有的 info 噪音。
  const selfRows = inFlight.filter((r) => r.name === 'activity_report')
  const inFlightOther = inFlight.filter((r) => r.name !== 'activity_report')
  const toolRows = selfRows.length ? toolRowsAll.filter((r) => !selfRows.includes(r)) : toolRowsAll
  const selfNote = selfRows.length
    ? `本次 activity_report 调用取数时自身仍在进行中，已从 inFlight 计数与工具频次中剔除（进行中的调用没有定稿耗时）`
    : undefined

  const turnsSet = new Set(scope.map((r) => r.turn).filter((t): t is number => t != null))
  const inputTokens = llm.reduce((n, r) => n + (r.usageIn ?? 0), 0)
  const outputTokens = llm.reduce((n, r) => n + (r.usageOut ?? 0), 0)
  // 时长双口径（#1）：
  //  durationMs = 活跃调用耗时之和（仅已定稿 llm+tool 行；进行中调用未定稿、不计入）
  //  spanMs    = 本运行首→末事件的墙钟跨度（含空闲等待，≈ 会话实际时间轴）
  const settled = scope.filter((r) => r.settled !== false)
  const durationMs = settled.reduce((n, r) => n + (r.durationMs ?? 0), 0)
  const firstTs = scope.length ? Math.min(...scope.map((r) => r.ts)) : 0
  const lastTs = scope.length ? Math.max(...scope.map((r) => (r.durationMs ? r.ts + r.durationMs : r.ts))) : 0
  const spanMs = scope.length ? Math.max(0, lastTs - firstTs) : 0

  // 工具按名聚合（本运行；已剔除 selfRows）
  const byNameMap = new Map<string, { name: string; count: number; failed: number; msSum: number; lastMs: number; measured: number }>()
  for (const t of toolRows) {
    let e = byNameMap.get(t.name)
    if (!e) { e = { name: t.name, count: 0, failed: 0, msSum: 0, lastMs: 0, measured: 0 }; byNameMap.set(t.name, e) }
    e.count++
    if (t.ok === false) e.failed++
    // 只累加已定稿行的耗时（进行中行无 durationMs，不拉低均值）
    if (t.settled !== false && t.durationMs != null) { e.msSum += t.durationMs; e.measured++; e.lastMs = t.durationMs }
  }
  const byName = [...byNameMap.values()]
    .map((e) => ({ name: e.name, count: e.count, failed: e.failed, avgMs: e.measured ? Math.round(e.msSum / e.measured) : 0, lastMs: e.lastMs }))
    .sort((a, b) => b.count - a.count)
  const duplicated = byName.filter((e) => e.count >= dupT)

  const failures = failed.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, name: r.name, summary: (r.summary || '').slice(0, 160) })).slice(0, 20)

  // 上下文压力 = 本运行内最后一个带 contextBytes 的 llm 行（按 ts 最大）
  const ctxRows = llm.filter((r) => r.contextBytes != null)
  const lastCtx = ctxRows.length ? ctxRows.reduce((a, b) => (a.ts > b.ts ? a : b)) : undefined
  // 预算口径澄清（#6）：300KB 是「监控截断预算」——超过它监控会省略早期消息，
  // 与模型自身上下文窗口无关；pressure 只反映监控缓冲占用，不代表真实余量。
  const budgetLabel = `监控截断预算 ${fmtBytes(contextBudgetBytes)}（非模型真实上下文窗口）`
  const context: AgentReport['context'] = { budgetBytes: contextBudgetBytes, budgetLabel, truncated: false, note: undefined }
  if (lastCtx) {
    const cb = lastCtx.contextBytes ?? 0
    context.lastTurn = lastCtx.turn
    context.lastContextBytes = cb
    context.lastContextMessages = lastCtx.contextMessages
    context.pressure = Math.round((cb / contextBudgetBytes) * 100) / 100
    const om = lastCtx.contextOmitted ?? 0
    context.truncated = om > 0
    const pct = Math.round((cb / contextBudgetBytes) * 100)
    context.note =
      `最后一次模型请求上下文 ${fmtBytes(cb)}，占${budgetLabel}的 ${pct}%`
      + `${om ? `，其中 ${om} 条早期消息已被监控省略（模型仍可能持有完整上下文）` : ''}`
      + ` —— 该口径衡量的是监控缓冲压力，不代表模型真实上下文余量`
  }

  // 陈述性信号（只陈述事实 + 阈值判断；自我观测噪音不进 signals，走 selfNote）
  const signals: AgentReport['signals'] = []
  for (const d of duplicated) signals.push({ severity: 'info', text: `工具 ${d.name} 已被调用 ${d.count} 次（其中 ${d.failed} 次失败）` })
  for (const e of byName) if (e.failed >= failT) signals.push({ severity: 'warn', text: `工具 ${e.name} 已失败 ${e.failed} 次，最近一次耗时 ${e.lastMs}ms —— 命令/参数可能不稳定，可先单次确认再批量执行` })
  if (context.lastContextBytes != null && ((context.pressure ?? 0) >= pressT || context.truncated)) {
    signals.push({ severity: 'warn', text: `${context.note ?? ''}${context.truncated ? `，且监控侧已触发截断（早期消息被整条省略）` : ''} —— 可考虑压缩上下文或重开会话` })
  }
  if (failed.length > 0) signals.push({ severity: 'warn', text: `本运行范围内 ${failed.length} 条调用处于失败状态（详见 failures）` })
  if (inFlightOther.length > 0) signals.push({ severity: 'info', text: `当前有 ${inFlightOther.length} 条调用进行中（尚未定稿，durationMs 暂不含它们）` })
  if (crossRun) signals.push({ severity: 'info', text: `数据跨 ${1 + new Set(hist.map((r) => r.runId ?? '(unknown)')).size} 个进程运行（重启前后），totals 只统计本运行；历史片段见 history 字段` })

  // 历史运行单列（#5）：按 runId 分组（旧版无 runId 的行归 '(unknown)'），只给计数与时间轴，不并入 totals
  let history: AgentReport['history']
  if (crossRun) {
    const byRun = new Map<string, { rows: number; firstTs: number; lastTs: number; llm: number; tool: number; failed: number }>()
    for (const r of hist) {
      const key = r.runId ?? '(unknown)'
      let e = byRun.get(key)
      if (!e) { e = { rows: 0, firstTs: Infinity, lastTs: 0, llm: 0, tool: 0, failed: 0 }; byRun.set(key, e) }
      e.rows++
      e.firstTs = Math.min(e.firstTs, r.ts)
      e.lastTs = Math.max(e.lastTs, r.durationMs ? r.ts + r.durationMs : r.ts)
      if (r.kind === 'llm') e.llm++
      if (r.kind === 'tool') e.tool++
      if (r.ok === false) e.failed++
    }
    history = {
      runs: [...byRun.entries()]
        .map(([runId, e]) => ({ runId, rows: e.rows, firstTs: e.firstTs, lastTs: e.lastTs, llmCalls: e.llm, toolCalls: e.tool, failedCalls: e.failed }))
        .sort((a, b) => a.firstTs - b.firstTs),
    }
  }

  const latest = [...scope].sort((a, b) => b.ts - a.ts).slice(0, 12)
    .map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, name: r.name, tag: r.tag, summary: (r.summary || '').slice(0, 120), ok: r.ok, turn: r.turn }))

  const report: AgentReport = {
    sessionId: input.sessionId,
    generatedAt: Date.now(),
    scope: scopeLabel,
    runId: RUN_ID,
    crossRun,
    totals: { llmCalls: llm.length, toolCalls: toolRows.length, failedCalls: failed.length, turns: turnsSet.size, inFlight: inFlightOther.length, inputTokens, outputTokens, durationMs, spanMs },
    tools: { byName, duplicated },
    failures,
    context,
    inFlight: inFlightOther.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, name: r.name, summary: (r.summary || '').slice(0, 120), startedAt: r.ts })),
    signals,
    selfNote,
    history,
    latest,
  }
  // 该报告里所有字段都是可 JSON 化的普通数据，JSON round-trip 只做一件事：
  // 剔除值为 undefined 的键（context.note / context.pressure / selfNote / history /
  // latest[].ok / latest[].turn 缺省时），使其满足「无失真 JSON」（dsh-tools 输出校验的要求）。
  // 空数组（byName / failures …）原样保留。
  return JSON.parse(JSON.stringify(report)) as AgentReport
}
