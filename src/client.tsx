/**
 * dsh-activity-monitor — 浏览器半（Web 侧板）
 *
 * 在 dsh web 左侧栏注册一个面板项（非浮动，主面板形态）：
 * 点击侧栏图标 → 主区域显示监控面板，实时轮询活动流。
 * 
 * 展示形态：
 *  - 每条活动一行：标签徽章 + 名字/摘要 + 时间
 *  - 点击行展开详情（参数/结果）
 *  - 顶部工具栏：暂停/恢复、清空（本地过滤）、标签筛选
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'

// 客户端 cordis 要求：没写进 inject 的服务，取属性会直接抛
// "cannot get property \"sessions\" without inject"。follow 当前会话要用 sessions 服务。
export const inject = ['slots', 'sessions'] as const

interface Row {
  seq: number
  ts: number
  sessionId?: string
  kind: 'llm' | 'tool'
  name: string
  tag: string
  summary: string
  detail?: string
  /** 多段详情（模型调用的用户消息/回复/提示词分段）；key 非空的段二级折叠 */
  sections?: Section[]
  /** dsh 轮次号（会话内从 1 开始；不属于任何轮次的调用为空） */
  turn?: number
  /**
   * 该模型行本次请求里发起的工具调用及其在「完整上下文」里的位置
   * （msgIndex = 第几条消息，与界面 [n] 一致；callIndex = 该消息内第几个调用，1 起）
   */
  calls?: { name: string; msgIndex: number; callIndex: number; resultMsgIndex?: number }[]
  /** 该轮第一行（turn/start 之后的第一条活动） */
  turnStart?: boolean
  /** 该轮最后一行且该轮已结束（模型回答完成） */
  turnEnd?: boolean
  durationMs?: number
  ok?: boolean
  /** 缺省/true = 已结束；false = 该行还在进行中（模型生成中 / 工具执行中） */
  settled?: boolean
  /** 行版本：宿主侧「进行中 → 定稿」原地刷新时递增；前端靠它判断该行是否真的变了 */
  rev?: number
  // ── 数值化字段（宿主随快照一并下发；面板将来可直接渲染 token/上下文压力，当前仅补齐类型） ──
  /** 原始 token 用量（llm 行；provider 未回报则缺省） */
  usageIn?: number
  usageOut?: number
  /** 发给模型的上下文规模（llm 行） */
  contextBytes?: number
  contextMessages?: number
  toolBytes?: number
  /** 该请求因超预算被整条省略的消息数（>0 = 模型没看到完整上下文） */
  contextOmitted?: number
}

/** 详情分段：isGroup 的段是分组标题，parent 指向它的段是分组子段（缩进 + 整组默认收起） */
interface Section {
  title: string
  body: string
  key?: string
  isGroup?: boolean
  parent?: string
  /** 正文里各消息块的起始偏移（宿主算好）：渲染时按它把正文切成可定位的块，块带 data-am-msg */
  anchorOffsets?: number[]
}

// ── 简易外部 store（useSyncExternalStore）──
let rows: Row[] = []
/** 行级折叠：展开了详情的行（存行的 seq —— 同一会话内唯一） */
let expanded = new Set<number>()
/** 手动收起过的「进行中」行：进行中行默认自动展开看流式输出，用户点掉才记这里；定稿后不再自动展开 */
let collapsedInFlight = new Set<number>()
/** 轮次折叠：展开了的轮次分组 key（默认收起，轮次是最大一级折叠标签） */
const expandedTurns = new Set<string>()
let paused = false
let filterTag = 'all'
let lastSeq = 0
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/**
 * 面板绑定的会话 = dsh 客户端 sessions 服务的当前选中会话。
 * 切换会话 → 面板切到该会话的监控数据；切换模型不属于会话变化，不影响这里。
 */
let activeSessionId: string | undefined
/** 二级折叠：提示词段落 id 集合（默认不展开） */
const expandedSecs = new Set<string>()
function toggleSec(id: string): void {
  if (expandedSecs.has(id)) expandedSecs.delete(id)
  else expandedSecs.add(id)
  notify()
}

/** 工具行在「完整上下文（发给模型的消息序列）」里的位置 */
interface CallLoc { rowSeq: number; msgIndex: number; callIndex: number; resultMsgIndex?: number }

/**
 * 把工具行对回「完整上下文」里的位置。
 * 宿主在每条模型行上记了本次请求发起的调用（calls：工具名 + 消息序号 + 该消息内第几个调用），
 * 这里按「同名调用 + 出现顺序」一一配对——模型行里列出的顺序就是真实发起顺序。
 * 只在同一会话内配对；用未筛选的会话行算，标签筛选不影响这张表。
 */
function callLocations(all: Row[]): Map<number, CallLoc> {
  const out = new Map<number, CallLoc>()
  const pending = new Map<string, Row[]>()
  for (const r of all) {
    const sid = r.sessionId ?? ''
    if (r.kind === 'tool') {
      const list = pending.get(sid) ?? []
      list.push(r)
      pending.set(sid, list)
      continue
    }
    if (!r.calls || r.calls.length === 0) continue
    const list = pending.get(sid) ?? []
    for (const c of r.calls) {
      const idx = list.findIndex((t) => t.name === c.name)
      if (idx < 0) continue
      const tool = list[idx]
      list.splice(idx, 1)
      out.set(tool.seq, { rowSeq: r.seq, msgIndex: c.msgIndex, callIndex: c.callIndex, resultMsgIndex: c.resultMsgIndex })
    }
  }
  return out
}

/** 点工具行上的位置标记：展开目标模型行的「完整上下文」并跳到发起该调用的那条消息 */
function jumpToContext(loc: CallLoc): void {
  expanded.add(loc.rowSeq)
  expandedSecs.add(`${loc.rowSeq}:group:context`)
  notify()
  setTimeout(() => {
    // 后代选择器（中间空格）：data-am-row 在外层容器、data-am-msg 在其内部的消息块 pre 上
    const el = document.querySelector(`[data-am-row="${loc.rowSeq}"] [data-am-msg="${loc.msgIndex}"]`)
    if (el && typeof (el as any).scrollIntoView === 'function') {
      ;(el as any).scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, 120)
}

/** 客户端 ctx（apply 时注入），用来读 sessions 服务 */
let clientCtx: any
/** 读 dsh 当前选中会话（sessions 服务不可用 / 未选会话时返回 undefined） */
function readActiveSession(): string | undefined {
  try {
    const current = clientCtx?.sessions?.list?.getSnapshot?.()?.current
    return current ? String(current) : undefined
  } catch {
    return undefined
  }
}

/** 行去重键：seq + ts（宿主进程重启后 seq 会从头开始，单靠 seq 会撞车） */
const rowKey = (r: Row): string => `${r.seq}:${r.ts}`

/**
 * 按 seq+ts 去重合并，时间正序，最多留 800 行。
 * 变化判断：新行（首次见到）、宿主侧「进行中 → 定稿」的原地刷新（seq/ts 不变、rev 递增），
 * 以及轮次边界标记（turnEnd）事后补齐的三种都算。
 * 没变化就不该 notify()，否则面板每秒白重渲染一次（还会把用户的滚动位置拽走）。
 */
function mergeRows(incoming: Row[]): boolean {
  if (incoming.length === 0) return false
  const known = new Map<string, Row>()
  for (const r of rows) known.set(rowKey(r), r)
  let changed = false
  const merged = new Map(known)
  for (const r of incoming) {
    const k = rowKey(r)
    const prev = known.get(k)
    const newer = !prev
      || (r.rev ?? 0) > (prev.rev ?? 0)
      || (prev.turnEnd !== r.turnEnd || prev.turnStart !== r.turnStart)
    // 新行 / 刷新行 / 边界标记变化：更新并通知
    if (newer) {
      changed = true
      merged.set(k, r)
    }
  }
  if (!changed) return false
  rows = [...merged.values()].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq)).slice(-800)
  for (const r of incoming) if (r.seq > lastSeq) lastSeq = r.seq
  return true
}

/** 载入该会话的落盘历史（宿主内存缓冲里已经没有的旧行） */
async function loadHistory(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`/api/activity-monitor/history?sessionId=${encodeURIComponent(sessionId)}`)
    if (!res.ok) return
    const data = await res.json()
    // 只在真有新行时通知（syncSession 清空那一步已经 notify 过了）
    if (Array.isArray(data.rows) && mergeRows(data.rows)) notify()
  } catch { /* 无历史时静默 */ }
}

/** 会话切换时清掉本会话的展开/收起状态（含「进行中」行的手动收起记录） */
function clearSessionUIState(): void {
  expanded.clear()
  collapsedInFlight.clear()
  expandedSecs.clear()
  expandedTurns.clear()
}

/** 跟随当前会话：会话变了就清空重载 */
function syncSession(): void {
  const next = readActiveSession()
  if (next === activeSessionId) return
  activeSessionId = next
  rows = []
  lastSeq = 0
  clearSessionUIState()
  if (next) void loadHistory(next)
  notify()
}

async function refresh(): Promise<void> {
  if (paused) return
  syncSession()
  try {
    // 每次都回看尾部若干行：轮次结束标记是 turn/end 事后补上的，只看增量会漏掉这一处更新
    const since = Math.max(0, lastSeq - 30)
    const res = await fetch(`/api/activity-monitor/snapshot?since=${since}`)
    if (!res.ok) return
    const data = await res.json()
    // 尾部回看会重复带回已见过的行：只在真有新行/字段更新时才通知，
    // 否则每秒一次的空轮询会把面板重渲染并强制滚到底部
    if (Array.isArray(data.rows) && mergeRows(data.rows)) notify()
  } catch { /* 服务未就绪时静默 */ }
}

/** 当前会话的行（无会话归属的行跟着显示）——不含标签筛选 */
function sessionRows(): Row[] {
  return activeSessionId
    ? rows.filter((r) => r.sessionId === activeSessionId || !r.sessionId)
    : rows
}

/** 面板要显示的行：会话范围内的行再过一层标签筛选 */
function scopedRows(): Row[] {
  const bySession = sessionRows()
  return filterTag === 'all' ? bySession : bySession.filter((r) => r.tag === filterTag)
}

/**
 * 轮次的真实元信息，取自**未被筛选**的会话行：
 * 轮次是否结束、首末时间、总条数都不能由筛选后的子集推断
 * （例如带 turnEnd 的末行被标签筛掉后，块头会误显示成「进行中」）。
 */
interface TurnMeta {
  ended: boolean
  firstTs: number
  lastTs: number
  total: number
  byTag: Map<string, number>
  failed: number
}
function turnMeta(list: Row[]): Map<string, TurnMeta> {
  const out = new Map<string, TurnMeta>()
  for (const r of list) {
    const key = r.turn ? `turn-${r.turn}` : 'turn-none'
    let m = out.get(key)
    if (!m) { m = { ended: false, firstTs: r.ts, lastTs: r.ts, total: 0, byTag: new Map(), failed: 0 }; out.set(key, m) }
    m.total++
    m.firstTs = Math.min(m.firstTs, r.ts)
    m.lastTs = Math.max(m.lastTs, r.ts)
    if (r.turnEnd) m.ended = true
    if (r.ok === false) m.failed++
    m.byTag.set(r.tag, (m.byTag.get(r.tag) ?? 0) + 1)
  }
  return out
}

function toggleExpand(seq: number): void {
  if (expanded.has(seq)) expanded.delete(seq)
  else expanded.add(seq)
  notify()
}

const TAG_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  llm:        { label: '模型',   color: '#7c3aed', bg: 'rgba(124,58,237,.12)' },
  skill:      { label: 'skill', color: '#0e7490', bg: 'rgba(14,116,144,.12)' },
  'file-read':  { label: '读文件', color: '#1d4ed8', bg: 'rgba(29,78,216,.12)' },
  'file-write': { label: '写文件', color: '#b45309', bg: 'rgba(180,83,9,.12)' },
  command:    { label: '命令',   color: '#be123c', bg: 'rgba(190,18,60,.12)' },
  tool:       { label: '工具',   color: '#4b5563', bg: 'rgba(75,85,99,.12)' },
}

/**
 * 展开区配色：模型侧内容走冷色系，工具侧内容走暖色系 —— 扫一眼就知道
 * 这块是「提示词/对话」还是「工具参数与结果」。
 * tint=标题底色，soft=正文底色，border=该块的框线与左侧色条。
 */
const BLOCK_STYLE = {
  // 系统提示词分段 / 运行时上下文（冷·靛蓝）
  prompt: { tint: 'rgba(99,102,241,.16)', soft: 'rgba(99,102,241,.07)', border: 'rgba(99,102,241,.50)' },
  // 用户消息 / 助手回复（冷·青）
  dialog: { tint: 'rgba(34,211,238,.14)', soft: 'rgba(34,211,238,.06)', border: 'rgba(34,211,238,.45)' },
  // 工具参数与结果（暖·琥珀）
  tool:   { tint: 'rgba(245,158,11,.14)', soft: 'rgba(245,158,11,.06)', border: 'rgba(245,158,11,.50)' },
} as const

/** 把半透明色层叠在主题底色上（深/浅主题都成立，不写死黑白） */
const overlay = (color: string, base: string): string => `linear-gradient(${color}, ${color}), ${base}`

// ── 组件 ──

function Badge({ tag }: { tag: string }) {
  const s = TAG_STYLE[tag] ?? TAG_STYLE.tool
  return h('span', {
    style: {
      display: 'inline-block', padding: '1px 8px', borderRadius: 10,
      fontSize: 11, lineHeight: '16px', color: s.color, background: s.bg,
      whiteSpace: 'nowrap',
    },
  }, s.label)
}

// ── 轮次分组（最大一级折叠标签） ──
// 轮次号来自 dsh 自己的 turn 事件（会话内从 1 开始）。轮次是面板里最大的一级折叠单位：
// 每条活动归到它所属的轮次块里，块头给出该轮的摘要，点块头才展开里面的活动行。
const TURN_COLORS = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#6366f1']
function turnColor(turn: number): string {
  return TURN_COLORS[(turn - 1) % TURN_COLORS.length]
}
/** #rrggbb → rgba(r,g,b,a) */
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** 一轮活动（turn 为空 = 不属于任何轮次的调用，如会话标题生成） */
interface TurnGroup {
  key: string
  turn?: number
  rows: Row[]
}

/**
 * 按轮次分组：按每轮第一次出现的位置排序，同一轮的行合并到一块
 * （轮次外的行合成单独一块，出现在它第一次出现的位置）。
 */
function groupByTurn(list: Row[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  const index = new Map<string, number>()
  for (const r of list) {
    const key = r.turn ? `turn-${r.turn}` : 'turn-none'
    let i = index.get(key)
    if (i === undefined) {
      i = groups.length
      index.set(key, i)
      groups.push({ key, turn: r.turn, rows: [] })
    }
    groups[i].rows.push(r)
  }
  return groups
}

function toggleTurn(key: string): void {
  if (expandedTurns.has(key)) expandedTurns.delete(key)
  else expandedTurns.add(key)
  notify()
}

function clockOf(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/** 步骤序号字形：①②③…（超过 20 步退回纯数字），用于轮次内的调用顺序 */
const STEP_GLYPHS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
function stepGlyph(n: number): string {
  return n >= 1 && n <= STEP_GLYPHS.length ? STEP_GLYPHS[n - 1] : `${n}.`
}

/** 段落收起时的一行摘要预览（取正文首个非空行） */
function preview(text: string, max = 60): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const t = first.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 某行内所有分段的折叠 key（含分组标题与子段） */
function rowSecIds(row: Row): string[] {
  return (row.sections ?? []).map((sec, i) => (sec.key ? `${row.seq}:${sec.key}` : `${row.seq}:${i}`))
}

/**
 * 双击标签 = 把该标签下的内容一次性完整展开（轮次 → 该轮所有行 → 行内所有分段）。
 * 只加不减：双击时前面两次单击已经把开关来回拨过一次，这里强制开到底，不会又被关掉。
 */
function openFully(opts: { turnKey?: string; rows?: Row[]; secIds?: string[] }): void {
  if (opts.turnKey) expandedTurns.add(opts.turnKey)
  for (const r of opts.rows ?? []) {
    expanded.add(r.seq)
    for (const id of rowSecIds(r)) expandedSecs.add(id)
  }
  for (const id of opts.secIds ?? []) expandedSecs.add(id)
  notify()
}

/** 轮次块头：轮次号 + 状态 + 条数 + 起止时间 + 耗时 + 该轮活动构成 */
function TurnGroupHeader({ group, meta, open }: { group: TurnGroup; meta?: TurnMeta; open: boolean }) {
  const list = group.rows
  const isNone = !group.turn
  const c = isNone ? 'var(--dsw-alias-label-tertiary, #9ca3af)' : turnColor(group.turn!)
  // 状态/起止/总条数取自未筛选的全轮（见 turnMeta），只有「构成」用当前可见的行
  const ended = meta ? meta.ended : list.some((r) => r.turnEnd)
  const firstTs = meta ? meta.firstTs : list[0].ts
  const lastTs = meta ? meta.lastTs : list[list.length - 1].ts
  const total = meta ? meta.total : list.length
  const failed = list.filter((r) => r.ok === false).length
  const span = lastTs - firstTs
  const spanText = span >= 1000 ? `${(span / 1000).toFixed(1)}s` : `${span}ms`
  // 该轮构成：各类活动各有多少条（模型 / 命令 / 读文件 …）
  const byTag = new Map<string, number>()
  for (const r of list) byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1)
  const parts = [...byTag.entries()].map(([tag, n]) => `${TAG_STYLE[tag]?.label ?? tag}×${n}`)
  const countText = list.length === total ? `${total} 条` : `${list.length}/${total} 条（筛选后）`
  const title = isNone
    ? '不属于任何轮次的调用（没有对应的 turn/start，例如会话标题生成）'
    : `第 ${group.turn} 轮 · ${ended ? '已结束（模型回答完成）' : '进行中'} · 共 ${total} 条`

  return h('div', {
    onClick: () => toggleTurn(group.key),
    // 双击：这一轮下全部展开（轮次 + 该轮每行 + 行内每个分段）
    onDoubleClick: (e: any) => { e.stopPropagation?.(); openFully({ turnKey: group.key, rows: group.rows }) },
    title,
    style: {
      display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
      userSelect: 'none' as const, padding: '6px 12px',
      background: isNone
        ? 'var(--dsw-alias-bg-layer-1)'
        : overlay(hexToRgba(c, 0.12), 'var(--dsw-alias-bg-layer-1)'),
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      borderLeft: `3px solid ${c}`,
    },
  },
    h('span', { style: { fontSize: 10, color: c, width: 10 } }, open ? '▾' : '▸'),
    h('span', {
      style: {
        fontSize: 11, fontWeight: 700, color: c, whiteSpace: 'nowrap',
        padding: '1px 8px', borderRadius: 10,
        background: isNone ? 'transparent' : hexToRgba(c, 0.16),
        border: isNone ? '1px dashed var(--dsw-alias-border-l1)' : `1px solid ${hexToRgba(c, 0.45)}`,
      },
    }, isNone ? '轮次外' : `轮次 #${group.turn}`),
    h('span', {
      style: { fontSize: 11, color: c, fontWeight: 600, whiteSpace: 'nowrap' },
    }, isNone ? `${list.length} 条` : (ended ? '■ 已结束' : '● 进行中')),
    h('span', {
      style: {
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 11, color: 'var(--dsw-alias-label-secondary, #4b5563)',
      },
    }, `${countText} · ${parts.join(' · ')}${failed ? ` · ${failed} 条失败` : ''}`),
    h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', whiteSpace: 'nowrap' } },
      `${clockOf(firstTs)} → ${clockOf(lastTs)} · ${spanText}`),
  )
}

function ActivityRowView({ row, step, stepColor, loc, stepOf }: {
  row: Row
  step?: number
  stepColor?: string
  /** 工具行在「完整上下文」里的位置（点它能跳回那条消息） */
  loc?: CallLoc
  /** 行 seq → 它在轮次里的步骤序号（用于说明位置标记指向哪次请求） */
  stepOf?: Map<number, number>
}) {
  const inFlight = row.settled === false
  // 进行中行（模型生成中 / 工具执行中）默认自动展开实时看输出；
  // 用户手动点掉才记进 collapsedInFlight（点回可再打开，定稿后不再自动展开）；
  // 定稿行照旧：只有用户点开过的才展开。
  const isOpen = inFlight ? !collapsedInFlight.has(row.seq) : expanded.has(row.seq)
  const hasDetail = Boolean(row.detail) || (row.sections?.length ?? 0) > 0
  const time = new Date(row.ts).toLocaleTimeString()
  // 行左侧色条：模型紫，工具行按 tag 各自颜色（skill 青 / 读文件蓝 / 写文件橙 / 命令红 / 工具灰）
  const tagColor = (TAG_STYLE[row.tag] ?? TAG_STYLE.tool).color
  const targetStep = loc ? stepOf?.get(loc.rowSeq) : undefined
  const locTip = loc
    ? `发起于「完整上下文」第 ${loc.msgIndex} 条消息的第 ${loc.callIndex} 个调用`
      + (loc.resultMsgIndex != null ? `，结果在第 ${loc.resultMsgIndex} 条消息` : '（结果还没回到消息里）')
      + (targetStep != null ? `；在请求 ${stepGlyph(targetStep)} 里发出` : '')
      + ' —— 点击跳转'
    : undefined
  const onRowClick = (): void => {
    if (!hasDetail) return
    if (inFlight) {
      if (!collapsedInFlight.has(row.seq)) {
        // 自动展开中，用户点掉 → 记「手动收起」（定稿后保持收起）
        collapsedInFlight.add(row.seq)
      } else {
        // 已手动收起，用户点回 → 打开，且定稿后保持展开
        collapsedInFlight.delete(row.seq)
        expanded.add(row.seq)
      }
    } else {
      toggleExpand(row.seq)
    }
    notify()
  }
  return h('div', {
    key: row.seq,
    style: {
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      borderLeft: `3px solid ${tagColor}`,
    },
  },
    h('div', {
      onClick: onRowClick,
      // 双击这一行：这一行连详情一次性全部展开
      onDoubleClick: (e: any) => { if (hasDetail) { e.stopPropagation?.(); openFully({ rows: [row] }) } },
      style: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        cursor: hasDetail ? 'pointer' : 'default',
        userSelect: 'none' as const,
      },
    },
      // 进行中（模型生成中 / 工具执行中）：结果列前加一个闪烁标记，扫一眼就知道这行还活着
      inFlight && h('span', {
        style: { fontSize: 10, color: '#f59e0b', whiteSpace: 'nowrap', animation: 'am-pulse 1s ease-in-out infinite' },
        title: '进行中：结果还在路上',
      }, '⋯'),
      // 本轮的调用顺序：① ② ③ …（一眼看出用户消息之后底层按什么顺序被调用）
      step != null && h('span', {
        style: {
          fontSize: 12, fontWeight: 700, lineHeight: '16px', minWidth: 16, textAlign: 'center',
          color: stepColor ?? '#9ca3af', whiteSpace: 'nowrap',
        },
        title: `第 ${step} 步（本轮的调用顺序）`,
      }, stepGlyph(step)),
      hasDetail && h('span', { style: { fontSize: 10, color: '#9ca3af', width: 10 } }, isOpen ? '▾' : '▸'),
      // 只标活动类型（模型/命令/读文件…）；轮次标识已上移到轮次块头
      h(Badge, { tag: row.tag }),
      // 具体工具名当主标题（read / bash / skill / glob …）——分类标签只说明性质，看不出到底调的是哪个工具
      row.kind === 'tool' && h('span', {
        style: {
          fontSize: 13, fontWeight: 600, color: tagColor, whiteSpace: 'nowrap',
          textDecoration: row.ok === false ? 'line-through' : 'none',
        },
        title: `工具名：${row.name}`,
      }, row.name),
      // 这次调用在「发给模型的消息序列」里的位置：第 n 条消息的第 m 个调用（点击跳过去）
      loc && h('span', {
        onClick: (e: any) => { e.stopPropagation?.(); jumpToContext(loc) },
        style: {
          fontSize: 11, color: '#0ea5e9', whiteSpace: 'nowrap', cursor: 'pointer',
          border: '1px solid rgba(14,165,233,.45)', borderRadius: 3, padding: '0 4px',
        },
        title: locTip,
      }, `↩ 上下文 [${loc.msgIndex}] 第 ${loc.callIndex} 个调用`),
      h('span', {
        style: {
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: 13, color: 'var(--dsw-alias-label-primary, #111827)',
          textDecoration: row.ok === false ? 'line-through' : 'none',
          opacity: row.ok === false ? 0.6 : 1,
        },
        title: row.summary,
      }, row.summary),
      row.durationMs != null && h('span', { style: { fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' } },
        row.durationMs >= 1000 ? `${(row.durationMs / 1000).toFixed(1)}s` : `${row.durationMs}ms`),
      // 直观信号①：单次模型请求的 token 消耗（provider 回报 usage 后行内可见，缺省不占位）
      row.usageIn != null && row.usageOut != null && h('span', {
        style: { fontSize: 11, color: '#7c3aed', whiteSpace: 'nowrap' },
        title: '本次请求 token 用量：输入 / 输出',
      }, `⚡${row.usageIn}→${row.usageOut}`),
      // 直观信号②：上下文超监控预算、最旧消息被整条省略（模型没看到完整上下文）——红色预警
      (row.contextOmitted ?? 0) > 0 && h('span', {
        style: { fontSize: 11, color: '#dc2626', fontWeight: 600, whiteSpace: 'nowrap' },
        title: `因超出上下文预算，最早的 ${row.contextOmitted} 条消息被整条省略，模型没有看到它们`,
      }, `⚠${row.contextOmitted} 条被省略`),
      h('span', { style: { fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' } }, time),
    ),
    // 展开区：llm 行渲染分段（用户消息/助手回复/提示词段落），tool 行渲染单块 detail
    // 提示词分段（sec.key 存在的）是二级折叠：点击段落标题单独展开正文
    // 配色口径：提示词/对话 = 冷色系（段落靛蓝、对话青），工具参数与结果 = 暖色系（琥珀）
    isOpen && row.sections && row.sections.length > 0 && h('div', { 'data-am-row': String(row.seq), style: { margin: '0 12px 8px 40px' } },
      row.sections.map((sec, i) => {
        // 用 key 做折叠标识（分组子段要能按 parent 找到自己所属分组的开关）
        const secId = sec.key ? `${row.seq}:${sec.key}` : `${row.seq}:${i}`
        const isGroup = sec.isGroup === true
        const isChild = sec.parent !== undefined
        // 分组收起时，子段整段不渲染（默认就是收起）
        if (isChild && !expandedSecs.has(`${row.seq}:${sec.parent}`)) return null
        // 默认一律收起：分组标题、提示词分段、用户消息、助手回复都要点开
        // （用户消息/助手回复收起时在标题行给一行正文摘要，不开也能看个大概）
        const selfOpen = expandedSecs.has(secId)
        // 提示词侧（系统提示词分组及其子段）走冷色·靛蓝；
        // 对话侧（用户消息 / 助手回复）走冷色·青 —— 与工具侧暖·琥珀一眼可分
        const bs = (isGroup || isChild) ? BLOCK_STYLE.prompt : BLOCK_STYLE.dialog
        // 分组标题本体是空串：不渲染空正文框，也不画成「开口」样式
        const bodyOpen = selfOpen && sec.body !== ''
        // 空正文的行（如工具清单里的工具名）不可点、不画箭头
        const clickable = isGroup || sec.body !== ''
        // 收起时的摘要预览：标题里已经带了同样一段（宿主生成的上下文/工具行标题）就不再重复。
        // 两边截断长度不同（标题 70 字 / 摘要 60 字）且各带省略号，比较时先去掉尾部省略号。
        const pv = preview(sec.body)
        const showPreview = !bodyOpen && sec.body !== '' && pv !== '' && !sec.title.includes(pv.replace(/…$/, ''))
        // 双击这个分段标题：本段 + 它下面所有子段一次性全部展开
        const childIds = (row.sections ?? [])
          .map((s, j) => ({ s, id: s.key ? `${row.seq}:${s.key}` : `${row.seq}:${j}` }))
          .filter((x) => x.s.parent !== undefined && x.s.parent === sec.key)
          .map((x) => x.id)
        return h('div', {
          key: i,
          // 供「工具行 → 上下文消息」的跳转定位用（jumpToContext 按这个属性找元素）
          'data-am-sec': secId,
          style: { marginBottom: 6, marginLeft: isChild ? 18 : 0 },
        },
          h('div', {
            onClick: clickable ? () => { toggleSec(secId); } : undefined,
            onDoubleClick: clickable ? (e: any) => { e.stopPropagation?.(); openFully({ secIds: [secId, ...childIds] }) } : undefined,
            style: {
              fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
              padding: '3px 8px', background: overlay(bs.tint, 'var(--dsw-alias-bg-layer-1)'),
              border: `1px solid ${bs.border}`,
              borderBottom: bodyOpen ? 'none' : `1px solid ${bs.border}`,
              borderLeft: `3px solid ${bs.border}`,
              borderRadius: bodyOpen ? '4px 4px 0 0' : 4,
              cursor: clickable ? 'pointer' : 'default', userSelect: 'none' as const,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          },
            (clickable ? (selfOpen ? '▾ ' : '▸ ') : '') + sec.title,
            showPreview && h('span', {
              style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary, #4b5563)' },
            }, '  ' + pv),
          ),
          bodyOpen && (sec.anchorOffsets && sec.anchorOffsets.length > 0
            ? sec.anchorOffsets.map((o, k) => {
                const end = k + 1 < sec.anchorOffsets!.length ? sec.anchorOffsets![k + 1] : sec.body.length
                const text = sec.body.slice(o, end).replace(/\n\n$/, '')
                return h('pre', {
                  key: k,
                  'data-am-msg': k,
                  style: {
                    margin: 0,
                    marginBottom: k + 1 < sec.anchorOffsets!.length ? 12 : 0,
                    fontSize: 11, lineHeight: 1.5,
                    color: 'var(--dsw-alias-label-primary)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  },
                }, text)
              })
            : h('pre', {
              style: {
                margin: 0, padding: 8, fontSize: 11, lineHeight: 1.5,
                background: overlay(bs.soft, 'var(--dsw-alias-bg-layer-2)'),
                borderRadius: clickable ? '0 0 4px 4px' : 4,
                color: 'var(--dsw-alias-label-primary)',
                border: `1px solid ${bs.border}`,
                borderTop: 'none',
                borderLeft: `3px solid ${bs.border}`,
                overflow: 'auto', maxHeight: 220, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              },
            }, sec.body)),
        )
      }),
    ),
    isOpen && row.detail && h('pre', {
      style: {
        margin: '0 12px 8px 40px', padding: 8, fontSize: 11, lineHeight: 1.5,
        background: overlay(BLOCK_STYLE.tool.soft, 'var(--dsw-alias-bg-layer-2)'),
        borderRadius: 6,
        color: 'var(--dsw-alias-label-primary)',
        border: `1px solid ${BLOCK_STYLE.tool.border}`,
        borderLeft: `3px solid ${BLOCK_STYLE.tool.border}`,
        overflow: 'auto', maxHeight: 260, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      },
    }, row.detail),
  )
}

function Toolbar() {
  // 模型行是提示词组合的载体、每轮必有，不需要单独筛 —— 工具栏不列「模型」
  const tags = ['all', ...Object.keys(TAG_STYLE).filter((t) => t !== 'llm')]
  return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', flexWrap: 'wrap' } },
    h('button', {
      onClick: () => { paused = !paused; notify() },
      style: buttonStyle(paused),
    }, paused ? '▶ 恢复' : '⏸ 暂停'),
    h('button', {
      onClick: () => { rows = []; clearSessionUIState(); notify() },
      style: buttonStyle(false),
    }, '清空'),
    // 轮次默认收起，给一个一键展开/收起全部的开关（只影响轮次块，不动行内详情）
    h('button', {
      onClick: () => {
        const gs = groupByTurn(scopedRows())
        const allOpen = gs.length > 0 && gs.every((g) => expandedTurns.has(g.key))
        expandedTurns.clear()
        if (!allOpen) for (const g of gs) expandedTurns.add(g.key)
        notify()
      },
      style: buttonStyle(false),
    }, '展开/收起轮次'),
    ...tags.map((t) =>
      h('button', {
        key: t,
        onClick: () => { filterTag = t; notify() },
        style: buttonStyle(filterTag === t),
      }, t === 'all' ? '全部' : (TAG_STYLE[t]?.label ?? t)),
    ),
  )
}

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '2px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
    border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-border-l1)'),
    background: active ? 'rgba(37,99,235,.1)' : 'transparent',
    color: active ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-label-secondary, #4b5563)',
  }
}

function MonitorPanel(): React.ReactElement {
  // 关键：订阅 store。notify() 变化 version，组件随 version 重渲染。
  // 之前的版本没有任何订阅，点击展开后 React 不知道需要重渲染。
  const [version, setVersion] = useState(0)
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), [])
  void version // 仅作为渲染依赖

  const listRef = useRef<HTMLDivElement | null>(null)
  // 粘底：只有用户本来就在底部时才跟着新内容滚动；用户上拉看历史后不再被拽回底部
  const stickRef = useRef(true)
  const sessionRef = useRef<string | undefined>(activeSessionId)
  // 进行中行的脉冲动画：挂载时注入一次 <style>（document 级去重），
  // 行内的「⋯ 进行中」标记用 am-pulse 闪烁，用户扫一眼就知道这行还活着。
  useEffect(() => {
    if (typeof document === 'undefined') return
    const STYLE_ID = 'am-pulse-style'
    if (!document.getElementById(STYLE_ID)) {
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = '@keyframes am-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }'
      document.head.appendChild(el)
    }
  }, [])
  const onListScroll = () => {
    const el = listRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
  // 依赖「数据签名」而不是 version：展开/收起轮次、切筛选都属于纯 UI 变化，
  // 不该触发滚动（这正是「展开后被强制下拉」的成因）
  const dataSig = `${activeSessionId ?? ''}|${rows.length}|${lastSeq}`
  useEffect(() => {
    const el = listRef.current
    // 换会话时强制回到底部（此时列表整体换了内容，用户上次的滚动位置无意义）
    const switched = sessionRef.current !== activeSessionId
    if (switched) { sessionRef.current = activeSessionId; stickRef.current = true }
    if (el && (stickRef.current || switched)) el.scrollTop = el.scrollHeight
  }, [dataSig, activeSessionId])

  const visible = scopedRows()
  // 轮次是最大一级折叠标签：先按轮次分组，再用分组渲染（筛选后只会有含匹配行的轮次）
  const groups = groupByTurn(visible)
  const groupCount = groups.filter((g) => g.turn).length
  // 轮次的真实状态/起止/总条数用未筛选的会话行算（筛选不该改变「轮次是否结束」）
  const metas = turnMeta(sessionRows())
  // 工具行 → 它在「完整上下文」里的位置（用未筛选的会话行算，筛选不影响配对）
  const locs = callLocations(sessionRows())
  // 行 seq → 它在轮次里的步骤序号（位置标记里说明「在请求 ⑤ 里发出」用）
  const stepOf = new Map<number, number>()
  for (const g of groups) g.rows.forEach((r, i) => stepOf.set(r.seq, i + 1))
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    h(Toolbar),
    h('div', { ref: listRef, onScroll: onListScroll, style: { flex: 1, overflowY: 'auto' } },
      visible.length === 0
        ? h('div', { style: { padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 } },
            activeSessionId
              ? '当前会话暂无活动 —— 发一条消息，这里会实时显示轮次、提示词、skill、工具、文件和命令的使用情况'
              : '暂无活动 —— 发起一段对话后这里会实时显示轮次、提示词、skill、工具、文件和命令的使用情况')
        : groups.map((group) => {
            const open = expandedTurns.has(group.key)
            const c = group.turn ? turnColor(group.turn) : 'var(--dsw-alias-label-tertiary, #9ca3af)'
            const isHex = typeof c === 'string' && c.startsWith('#')
            return h('div', { key: group.key },
              h(TurnGroupHeader, { group, meta: metas.get(group.key), open }),
              // 展开后：该轮的活动按调用顺序排成一条流程 —— 左侧竖线 + 每行 ① ② ③ 序号
              // （行内详情仍是二级折叠；顺序就是宿主记录到的真实顺序）
              open && h('div', { style: { display: 'flex', marginLeft: 12 } },
                h('div', { style: { flex: '0 0 14px', width: 14, borderRight: `2px solid ${isHex ? hexToRgba(c, 0.35) : c}` } }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  group.rows.map((row, i) => h(ActivityRowView, {
                    key: `${row.seq}:${row.ts}`,
                    row,
                    step: i + 1,
                    stepColor: isHex ? (c as string) : undefined,
                    loc: locs.get(row.seq),
                    stepOf,
                  })),
                ),
              ),
            )
          }),
    ),
    h('div', { style: { padding: '4px 12px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', borderTop: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', gap: 8 } },
      h('span', null, `${groupCount} 轮 · ${visible.length} 条活动 · ${expandedTurns.size} 轮已展开 · ${paused ? '已暂停' : '实时刷新中'} · 最新在底部`),
      h('span', { style: { whiteSpace: 'nowrap' }, title: activeSessionId ? `跟随当前会话 ${activeSessionId}` : '未选中会话，显示全部' },
        activeSessionId ? `会话 ${activeSessionId.slice(0, 16)}…` : '未选会话（跟随中）'),
    ),
  )
}

// ── 插件入口 ──

export function apply(ctx: ClientContext): void {
  // 面板跟随 dsh 的当前会话：拿到客户端 ctx，轮询里每秒读一次 sessions.list.current；
  // 服务存在时再订阅一次，切换会话能立刻切数据而不必等下一次轮询。
  clientCtx = ctx
  ctx.effect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      const list = (ctx as any).sessions?.list
      if (typeof list?.subscribe === 'function') {
        unsubscribe = list.subscribe(() => { syncSession(); notify() })
      }
    } catch { /* sessions 服务不可用 → 退回轮询同步 */ }
    return () => { if (unsubscribe) unsubscribe() }
  }, 'activity-monitor: follow current session')

  ctx.effect(() => {
    // 自适应轮询：有「进行中」的行（模型生成中/工具执行中）时 300ms 一档，
    // 流式输出实时上屏；全空闲时退回 1s，避免空转。
    let timer: number | undefined
    let busy = false
    const tick = async (): Promise<void> => {
      if (busy) return // 上一次还没回来（网络慢/服务卡）→ 不叠请求
      busy = true
      try {
        await refresh()
      } finally {
        busy = false
      }
      const busyLive = rows.some((r) => r.settled === false
        && (!activeSessionId || r.sessionId === activeSessionId || !r.sessionId))
      timer = window.setTimeout(tick, busyLive ? 300 : 1000)
    }
    void tick()
    return () => { if (timer) window.clearTimeout(timer) }
  }, 'activity-monitor: polling')

  // 诊断入口（排查「跟随会话」与手工切换会话时用）：
  // 控制台执行 window.__activityMonitor.debug() / .openSession(id) / .sessionIds()
  ;(window as any).__activityMonitor = {
    debug: () => {
      const list = clientCtx?.sessions?.list
      const snap = (() => { try { return list?.getSnapshot?.() } catch { return undefined } })()
      return {
        hasCtx: Boolean(clientCtx),
        serviceNames: clientCtx ? Object.keys(clientCtx).filter((k) => /session/i.test(k)) : [],
        hasSessions: Boolean(clientCtx?.sessions),
        hasList: Boolean(list),
        snapshotKeys: snap ? Object.keys(snap) : null,
        current: snap?.current ? String(snap.current) : null,
        activeSessionId: activeSessionId ?? null,
        /** 缓冲里的行数（含其它会话） */
        rows: rows.length,
        /** 面板真正显示的行数（= scopedRows()，底栏「共 N 条」用的就是它） */
        visible: scopedRows().length,
        visibleTurns: new Set(scopedRows().filter((r) => r.turn).map((r) => r.turn)).size,
        turns: new Set(rows.filter((r) => r.turn).map((r) => r.turn)).size,
      }
    },
    /** 列出当前已知会话 id */
    sessionIds: () => {
      try { return (clientCtx?.sessions?.list?.getSnapshot?.()?.ids ?? []).map(String) } catch { return [] }
    },
    /** 走 dsh 自己的会话选择 API（侧栏点击内部用的就是它） */
    openSession: (id: string) => {
      try { clientCtx?.sessions?.open?.(id); return 'ok' } catch (e: any) { return String(e?.message ?? e) }
    },
  }

  // 主面板：注册到 "main" slot（侧栏点击后主区域显示）
  ;(ctx.slots as any).inject('main', () => (ctx.slots as any).register({
    name: 'main',
    key: 'activity-monitor',
  }, MonitorPanel))

  // 侧栏面板项：图标按钮，点击切换到主面板
  ;(ctx.slots as any).inject('sidebar.panellist', () => (ctx.slots as any).register({
    name: 'sidebar.panellist',
    id: 'activity-monitor',
    order: 60,
    label: () => '监控',
  }, SidebarIcon))
}

function SidebarIcon(): React.ReactElement {
  return h('span', { style: { fontSize: 15, lineHeight: 1 } }, '📊')
}

// Fragment 保留导入（避免 esbuild tree-shake 报未使用）
void Fragment
