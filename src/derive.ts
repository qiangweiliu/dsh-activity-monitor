/**
 * 面板的派生数据（纯函数，无 React、无 DOM）—— 单独成模块是为了可单测。
 *
 * 这些计算原本散在客户端组件里，只能靠肉眼看界面验证；抽出来之后 node:test 直接跑
 * （tests/derive.test.js 引 lib/derive.js），信号 / 跨轮差异 / 导出的口径也就钉住了。
 * 所有函数只吃「行」这一种数据，宿主行与浏览器本地行的结构一致（见 types.ts / wire.ts）。
 */

/** 这些派生函数实际用到的字段（结构化类型：宿主 ActivityRow 与客户端本地 Row 都满足） */
export interface DerivedRow {
  seq: number
  ts: number
  sessionId?: string
  kind: 'llm' | 'tool' | 'verdict' | 'proposal'
  name: string
  failSig?: string
  verdict?: { status: string; basis: string; evidenceSeqs?: number[]; by?: string }
  proposal?: {
    pkind: string; action: string; target: string; status: string; evidenceSeqs?: number[]
    id?: string; transitionOf?: number
  }
  tag: string
  summary: string
  turn?: number
  durationMs?: number
  ok?: boolean
  settled?: boolean
  usageIn?: number
  usageOut?: number
  contextBytes?: number
  contextMessages?: number
  toolBytes?: number
  contextOmitted?: number
  promptSections?: number
  calls?: { name: string; msgIndex: number; callIndex: number; resultMsgIndex?: number }[]
}

/** 字节数的可读形式（与宿主侧同口径：>=1KB 用 KB 保留一位） */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '-'
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

/** `x +2（3→5）` 这种增量文本；任一侧缺省则返回空串（不显示没意义的差异） */
function delta(cur: number | undefined, prev: number | undefined, unit = ''): string {
  if (cur == null || prev == null) return ''
  const d = cur - prev
  if (d === 0) return `不变（${cur}${unit}）`
  return `${d > 0 ? '+' : ''}${d}${unit}（${prev}→${cur}）`
}

/**
 * 「与上一轮相比」的一行差异摘要（上下文膨胀 / 提示词变多 / 工具变多）。
 * 只比较轻行上就有的字段：消息数、上下文字节、提示词分段数、本轮发起的调用数。
 */
export function contextDiff(prev: DerivedRow | undefined, cur: DerivedRow): string {
  if (!prev) return ''
  const parts: string[] = []
  const msgs = delta(cur.contextMessages, prev.contextMessages)
  if (msgs) parts.push(`消息 ${msgs}`)
  if (cur.contextBytes != null && prev.contextBytes != null) {
    const d = cur.contextBytes - prev.contextBytes
    parts.push(`上下文 ${d === 0
      ? `不变（${fmtBytes(cur.contextBytes)}）`
      : `${d > 0 ? '+' : '-'}${fmtBytes(Math.abs(d))}（${fmtBytes(prev.contextBytes)}→${fmtBytes(cur.contextBytes)}）`}`)
  }
  const prompts = delta(cur.promptSections, prev.promptSections, ' 段提示词')
  if (prompts) parts.push(prompts)
  const calls = delta(cur.calls?.length, prev.calls?.length)
  if (calls) parts.push(`调用 ${calls}`)
  if ((cur.contextOmitted ?? 0) > 0 && (prev.contextOmitted ?? 0) === 0) parts.push('本轮开始出现超预算省略')
  return parts.length > 0 ? `与上一轮相比：${parts.join(' · ')}` : ''
}

/** 轮次级信号（面板上直接可见的告警，口径与 agent 侧 activity_report 的 signals 一致） */
export interface TurnSignal {
  severity: 'info' | 'warn'
  text: string
}

/** 一个轮次的信号：重复调用 / 失败 / 上下文被截断 / 长耗时 / 仍在进行 */
export function turnSignals(rows: DerivedRow[]): TurnSignal[] {
  const out: TurnSignal[] = []
  const tools = rows.filter((r) => r.kind === 'tool')
  const byName = new Map<string, number>()
  for (const t of tools) byName.set(t.name, (byName.get(t.name) ?? 0) + 1)
  const dup = [...byName.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
  for (const [name, n] of dup) out.push({ severity: 'warn', text: `${name} 重复调用 ${n} 次` })

  const failed = rows.filter((r) => r.ok === false)
  if (failed.length > 0) {
    const names = [...new Set(failed.map((f) => f.name))].join(' / ')
    out.push({ severity: 'warn', text: `${failed.length} 次调用失败（${names}）` })
  }
  const omitted = rows.reduce((n, r) => Math.max(n, r.contextOmitted ?? 0), 0)
  if (omitted > 0) out.push({ severity: 'warn', text: `上下文超预算，${omitted} 条消息被整条省略` })

  const slow = rows.filter((r) => (r.durationMs ?? 0) >= 30_000)
  if (slow.length > 0) out.push({ severity: 'info', text: `${slow.length} 次调用超过 30s` })

  const running = rows.filter((r) => r.settled === false)
  if (running.length > 0) out.push({ severity: 'info', text: `${running.length} 个调用仍在进行中` })
  return out
}

/** 会话级汇总（顶栏/底栏与导出用） */
export interface SessionTotals {
  turns: number
  llmCalls: number
  toolCalls: number
  failedCalls: number
  inFlight: number
  inputTokens: number
  outputTokens: number
  maxContextBytes: number
  maxContextTurn?: number
  contextOmitted: number
  /** 工具频次（按次数降序） */
  toolFrequency: { name: string; count: number }[]
  /** skill 加载次数（按 name 聚合） */
  skills: { name: string; count: number }[]
}

export function sessionTotals(rows: DerivedRow[]): SessionTotals {
  const llm = rows.filter((r) => r.kind === 'llm')
  const tools = rows.filter((r) => r.kind === 'tool')
  const byName = new Map<string, number>()
  for (const t of tools) byName.set(t.name, (byName.get(t.name) ?? 0) + 1)
  const skills = new Map<string, number>()
  for (const r of rows.filter((x) => x.tag === 'skill')) {
    const name = r.summary.replace(/^skill:\s*/, '')
    skills.set(name, (skills.get(name) ?? 0) + 1)
  }
  let maxContextBytes = 0
  let maxContextTurn: number | undefined
  for (const r of llm) {
    if ((r.contextBytes ?? 0) > maxContextBytes) {
      maxContextBytes = r.contextBytes ?? 0
      maxContextTurn = r.turn
    }
  }
  return {
    turns: new Set(rows.map((r) => r.turn).filter((t): t is number => t != null)).size,
    llmCalls: llm.length,
    toolCalls: tools.length,
    failedCalls: rows.filter((r) => r.ok === false).length,
    inFlight: rows.filter((r) => r.settled === false).length,
    inputTokens: llm.reduce((n, r) => n + (r.usageIn ?? 0), 0),
    outputTokens: llm.reduce((n, r) => n + (r.usageOut ?? 0), 0),
    maxContextBytes,
    maxContextTurn,
    contextOmitted: llm.reduce((n, r) => Math.max(n, r.contextOmitted ?? 0), 0),
    toolFrequency: [...byName.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    skills: [...skills.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  }
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/**
 * 把一批行导出成 Markdown（面板上「复制本轮 / 复制会话」用）。
 * 只导出轻行上就有的信息：时间、类型、名称、摘要、耗时、token、上下文规模与信号。
 * 正文（提示词 / 工具输出）不导出 —— 那是另一件事（体积大、也可能含敏感内容），
 * 需要时在界面上展开逐行看。
 */
export function rowsToMarkdown(rows: DerivedRow[], title = '活动记录'): string {
  const lines: string[] = [`## ${title}`, '']
  const totals = sessionTotals(rows)
  lines.push(`- 轮次 ${totals.turns} · 模型请求 ${totals.llmCalls} · 工具调用 ${totals.toolCalls} · 失败 ${totals.failedCalls}`)
  if (totals.inputTokens || totals.outputTokens) {
    lines.push(`- token：输入 ${totals.inputTokens} / 输出 ${totals.outputTokens}`)
  }
  if (totals.maxContextBytes) {
    lines.push(`- 最大上下文 ${fmtBytes(totals.maxContextBytes)}${totals.maxContextTurn ? `（第 ${totals.maxContextTurn} 轮）` : ''}`)
  }
  if (totals.toolFrequency.length > 0) {
    lines.push(`- 工具频次：${totals.toolFrequency.slice(0, 10).map((t) => `${t.name}×${t.count}`).join('，')}`)
  }
  // 每轮信号只算一次（按 turn 分组），避免在行循环里做 O(n²) 过滤
  const sigByTurn = new Map<number | undefined, TurnSignal[]>()
  for (const t of new Set(rows.map((r) => r.turn))) {
    sigByTurn.set(t, turnSignals(t == null ? rows : rows.filter((x) => x.turn === t)))
  }
  let currentTurn: number | undefined | null = null
  for (const r of rows) {
    if (r.turn !== currentTurn) {
      currentTurn = r.turn
      lines.push('', `### ${r.turn ? `第 ${r.turn} 轮` : '不属于任何轮次'}`, '')
    }
    const bits = [`\`${timeOf(r.ts)}\``, `**${r.name}**`, r.tag]
    if (r.kind === 'tool') bits.push(r.ok === false ? '失败' : '成功')
    // 验收结论行：导出里直接给结论，别让读导出的人以为它是一次「调用」
    if (r.kind === 'verdict' && r.verdict) bits.push(`验收 ${r.verdict.status}`)
    if (r.durationMs != null) bits.push(r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`)
    if (r.usageIn != null && r.usageOut != null) bits.push(`token ${r.usageIn}→${r.usageOut}`)
    if (r.contextBytes != null) bits.push(`上下文 ${fmtBytes(r.contextBytes)}`)
    const sig = r.kind === 'llm' ? (sigByTurn.get(r.turn) ?? []) : []
    lines.push(`- ${bits.join(' · ')} — ${r.summary}`
      + (sig.length > 0 ? `  \n  - 信号：${sig.map((s) => s.text).join('；')}` : ''))
  }
  return lines.join('\n')
}

/** 导出的会话 JSON（保持与宿主落盘行一致的结构，便于二次处理） */
export function rowsToJson(rows: DerivedRow[], meta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    ...meta,
    totals: sessionTotals(rows),
    rows,
  }, null, 2)
}

/**
 * 提案的有效状态（宿主报告与面板共用同一口径）：**遍历到最新一条状态变更行**。
 *
 * 为什么要有"有效状态"：状态变更不原地改历史行，而是**追加一行**带 `transitionOf` 的
 * proposal 行（append-only：跨重启可查、不需要改写 JSONL）。因此创建行的 `status`
 * 只是初始值，真正的状态是同一 `id` 上 (ts, seq) 最大的那一行的 `status`。
 *
 * @param rows - 任一顺序的行集合（函数内部自己排序，不依赖调用方）
 * @returns id → { status, ts, seq, by }；没有 id 的老行按 `session:<seq>` 兜底
 */
export function effectiveProposalStatus(
  rows: { seq: number; ts: number; sessionId?: string; proposal?: any }[],
): Map<string, { status: string; ts: number; seq: number; by: string }> {
  const out = new Map<string, { status: string; ts: number; seq: number; by: string }>()
  const keyed = rows
    .filter((r) => r.proposal)
    .map((r) => ({ key: String(r.proposal.id ?? `session:${r.seq}`), r }))
    .sort((a, b) => (a.r.ts - b.r.ts) || (a.r.seq - b.r.seq))
  for (const { key, r } of keyed) {
    const p = r.proposal
    out.set(key, { status: String(p.status), ts: r.ts, seq: r.seq, by: String(p.by ?? 'agent') })
  }
  return out
}
