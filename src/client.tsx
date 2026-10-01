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
/**
 * 客户端 cordis 上下文的最小形状。
 *
 * 为什么不用 `@deepseek-ai/dsh-client-runtime` 的 ClientContext：
 * 那个包声明了 `@deepseek-ai/dsh-agent@^0.1.1-rc.2` 之类的传递 peer，与本项目
 * 的 0.1.5-rc.3 系列冲突 —— 引入它会 `npm install` ERESOLVE 失败，连带 git 安装路径
 * （`dsh plugin add <git-url>`）也装不上。所以本项目**不依赖该包**（devDeps 里也已移除），
 * 客户端构建只 external react。这里只用两个成员，
 * 就地声明即可，安装面就少一个会打架的依赖。
 */
export interface ClientContext {
  /** cordis 的副作用注册：回调返回清理函数（面板的轮询与订阅都挂在这上面） */
  effect(fn: () => any, label?: string): any
  /** dsh 客户端会话服务（未注入时取属性会抛，调用处一律 try 包住） */
  sessions?: any
  [key: string]: any
}
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
// 派生数据（跨轮差异 / 轮次信号 / 会话汇总 / 导出）是纯函数，单独放在 derive.ts 里可单测
import { contextDiff, effectiveProposalStatus, fmtBytes, rowsToJson, rowsToMarkdown, sessionTotals, turnSignals } from './derive.js'

// 客户端 cordis 要求：没写进 inject 的服务，取属性会直接抛
// "cannot get property \"sessions\" without inject"。follow 当前会话要用 sessions 服务。
export const inject = ['slots', 'sessions'] as const

/**
 * 本地行 = 宿主下发的**轻行**（协议 v2）+ 按需补齐的**重体**。
 *
 * 为什么分两层：宿主的快照是高频通道（流式期间 300ms 一次），而一行里的正文
 * （detail/sections）实测平均 15KB、最坏 265KB，其中约 85% 是 system prompt 与完整上下文，
 * 且定稿后几乎不再变化 —— 把最重、最不变的数据放进高频通道是 v1 最大的开销来源。
 * 现在快照只带标量字段 + `hasBody` 标记，用户真正展开某行时才用 /row 拉正文：
 *   bodyLoaded=true 已有正文；bodyStale=true 宿主原行刷新过（rev 变大）正文可能过期；
 *   bodyLoading=true 正在拉；bodyError 记录失败原因（不静默）。
 */
interface Row {
  seq: number
  ts: number
  sessionId?: string
  /** 产出该行的宿主进程 id（RUN_ID）：轮次标记只作用于本进程的行（不同 run 的 seq 会重复） */
  runId?: string
  kind: 'llm' | 'tool' | 'verdict' | 'proposal'
  name: string
  tag: string
  summary: string
  /** 失败签名（宿主下发；面板展示的聚类键与 activity_report 同口径） */
  failSig?: string
  /** 验收结论行（kind === 'verdict'）：宿主随轻行下发，不需要 /row */
  verdict?: {
    status: 'pass' | 'fail' | 'partial' | 'unknown'
    basis: string
    evidenceSeqs?: number[]
    verifyCommand?: string
    verifySeqs?: number[]
    by: 'agent' | 'user'
    at: number
  }
  /** 进化提案行（kind === 'proposal'）：同样随轻行下发 */
  proposal?: {
    pkind: 'skill' | 'plugin' | 'automation'
    action: 'create' | 'install' | 'enable' | 'disable' | 'remove' | 'other'
    target: string
    rationale: string
    evidenceSeqs?: number[]
    expectedEffect?: string
    /** 验收命令原文 —— 只记录文本，本插件**不执行** */
    verifyCommands?: string[]
    rollbackPlan?: string
    /**
     * 提案稳定 id（`p-<runId>-<ts>-<n>`）：状态变更行靠它指回原提案。
     * 不用 seq 做 id —— seq 是每进程计数器，跨重启会重复。
     */
    id?: string
    /** 状态变更行的标记：指向被变更的提案（创建行没有该字段） */
    transitionOf?: number
    /** 只能由人造/工具显式推进：agent 侧工具永远只写 'proposed'（不允许自证已执行） */
    status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'rolled-back'
    by: 'agent' | 'user'
    at: number
  }
  detail?: string
  /** 多段详情（模型调用的用户消息/回复/提示词分段）；key 非空的段二级折叠 */
  sections?: Section[]
  /** 宿主侧是否有可折叠正文（轻行只带这个标记，正文按需拉） */
  hasBody?: boolean
  /** 正文分段数（展开前就能提示「有几段」） */
  sectionCount?: number
  /** 正文已拉到本地 */
  bodyLoaded?: boolean
  /** 宿主原行刷新过、本地正文可能已过期（展开时会重拉一次） */
  bodyStale?: boolean
  /** 正在按需拉取正文 */
  bodyLoading?: boolean
  /** 拉取失败原因（渲染出来，便于排查；v1 这类失败全是静默的） */
  bodyError?: string
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
  // ── 数值化字段（宿主随轻行一并下发，全都在，供面板直接渲染 token / 上下文压力 / 截断告警） ──
  /** 原始 token 用量（llm 行；provider 未回报则缺省） */
  usageIn?: number
  usageOut?: number
  /** 发给模型的上下文规模（llm 行） */
  contextBytes?: number
  contextMessages?: number
  toolBytes?: number
  /** 该请求因超预算被整条省略的消息数（>0 = 模型没看到完整上下文） */
  contextOmitted?: number
  /** 本次请求的提示词分段数（跨轮差异 / 提示词膨胀信号用） */
  promptSections?: number
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
/**
 * 行键统一用 seq:ts —— 宿主进程重启后 seq 会从头开始，裸 seq 作键会把旧行的折叠态
 * 贴到新行上（v1 里 expanded / collapsedInFlight 用的就是裸 seq，只有去重用了 seq:ts）。
 */
const rowKey = (r: { seq: number; ts: number }): string => `${r.seq}:${r.ts}`
/** 行级折叠：展开了详情的行（存 rowKey） */
let expanded = new Set<string>()
/** 手动收起过的「进行中」行：进行中行默认自动展开看流式输出，用户点掉才记这里；定稿后不再自动展开 */
let collapsedInFlight = new Set<string>()
/** 轮次折叠：展开了的轮次分组 key（默认收起，轮次是最大一级折叠标签） */
const expandedTurns = new Set<string>()
let paused = false
let filterTag = 'all'
/** 增量游标：lastSeq = 已见到的最大行号（宿主全局发号）；markGen = 已应用的轮次标记代数 */
let lastSeq = 0
let markGen = 0
/** 宿主运行 id：变了说明宿主重启过（seq 从头开始）→ 必须整段重载，否则增量永远拉不到新行 */
let hostRunId: string | undefined
/** 客户端可调项：挂载时从 /config 拉一次（与宿主同源），拉不到就用这里的默认值 */
const clientCfg = { pollActiveMs: 300, pollIdleMs: 1000, maxRows: 800, backfillRows: 500 }
/** 最近一次快照往返的耗时与字节数（底栏展示；也是「快照真的变轻了」的现场证据） */
let pollStat = { ms: 0, bytes: 0, at: 0 }
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
interface CallLoc {
  /** 目标模型行的 rowKey（折叠态与段落 id 都用它；裸 seq 在宿主重启后会撞车） */
  rowKey: string
  /** 目标模型行的 seq（只用于 DOM 定位属性 data-am-row） */
  rowSeq: number
  msgIndex: number
  callIndex: number
  resultMsgIndex?: number
}

/**
 * 把工具行对回「完整上下文」里的位置。
 * 宿主在每条模型行上记了本次请求发起的调用（calls：工具名 + 消息序号 + 该消息内第几个调用），
 * 这里按「同名调用 + 出现顺序」一一配对——模型行里列出的顺序就是真实发起顺序。
 * 只在同一会话内配对；用未筛选的会话行算，标签筛选不影响这张表。
 */
function callLocations(all: Row[]): Map<string, CallLoc> {
  const out = new Map<string, CallLoc>()
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
      out.set(rowKey(tool), {
        rowKey: rowKey(r), rowSeq: r.seq,
        msgIndex: c.msgIndex, callIndex: c.callIndex, resultMsgIndex: c.resultMsgIndex,
      })
    }
  }
  return out
}

/**
 * 点工具行上的位置标记：展开目标模型行的「完整上下文」并跳到发起该调用的那条消息。
 * 正文是按需拉取的，所以必须先 await ensureBody 再滚动 —— 否则目标元素还没被渲染出来。
 */
async function jumpToContext(loc: CallLoc): Promise<void> {
  await ensureBody(loc.rowKey)
  expanded.add(loc.rowKey)
  expandedSecs.add(`${loc.rowKey}:group:context`)
  notify()
  // 等两帧让 React 把正文渲染出来再定位（带提示词全文的行渲染需要一点时间）
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // 后代选择器（中间空格）：data-am-row 在外层容器、data-am-msg 在其内部的消息块 pre 上
    const el = document.querySelector(`[data-am-row="${loc.rowSeq}"] [data-am-msg="${loc.msgIndex}"]`)
    if (el && typeof (el as any).scrollIntoView === 'function') {
      ;(el as any).scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }))
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

/**
 * 一行里参与「变了没」判断的标量字段（正文与轮次标记单独处理）。
 * 用签名比较而不是手写逐字段 diff：字段一旦增加，漏判会退化成「面板不刷新」，很难发现。
 */
function scalarSig(r: Row): string {
  return [
    r.seq, r.ts, r.rev ?? 0, r.settled === false ? 'live' : 'done', r.ok === false ? 'fail' : 'ok',
    r.summary, r.name, r.tag, r.durationMs ?? '', r.usageIn ?? '', r.usageOut ?? '',
    r.contextBytes ?? '', r.contextMessages ?? '', r.contextOmitted ?? '', r.toolBytes ?? '',
    r.promptSections ?? '', r.calls?.length ?? '',
  ].join('|')
}

/**
 * 合并宿主下发的行（协议 v2 的**轻行**）到本地。
 *
 * 两条容易写错的不变量：
 *  1. 轻行不含正文（detail/sections）—— 直接 `{...prev, ...r}` 会把用户已经展开的正文抹掉。
 *     所以正文一律保留本地值；宿主刷新过（rev 变大）时只标记 bodyStale，展开时再重拉。
 *  2. turnStart/turnEnd 只能被 true 覆盖：清除必须走 marks 日志（宿主搬移末行标记时会发
 *     turnEnd:false）。「轻行没带标记」不等于「这行没有标记」。
 */
function mergeRows(incoming: Row[]): boolean {
  if (incoming.length === 0) return false
  const known = new Map<string, Row>()
  for (const r of rows) known.set(rowKey(r), r)
  const merged = new Map(known)
  let changed = false
  for (const r of incoming) {
    const k = rowKey(r)
    const prev = known.get(k)
    if (!prev) {
      merged.set(k, r)
      changed = true
      continue
    }
    const revGrew = (r.rev ?? 0) > (prev.rev ?? 0)
    const next: Row = {
      ...prev, ...r,
      detail: prev.detail,
      sections: prev.sections,
      bodyLoaded: prev.bodyLoaded,
      bodyStale: prev.bodyStale === true || (revGrew && prev.bodyLoaded === true),
      turnStart: prev.turnStart === true || r.turnStart === true ? true : undefined,
      turnEnd: prev.turnEnd === true || r.turnEnd === true ? true : undefined,
    }
    const markChanged = (next.turnStart === true) !== (prev.turnStart === true)
      || (next.turnEnd === true) !== (prev.turnEnd === true)
    if (revGrew || markChanged || scalarSig(next) !== scalarSig(prev)) {
      merged.set(k, next)
      changed = true
    }
  }
  if (!changed) return false
  rows = [...merged.values()].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq)).slice(-clientCfg.maxRows)
  return true
}

/**
 * 应用宿主下发的轮次标记增量（协议 v2）。
 * 标记是事后补在**已经下发过**的行上的（轮次结束才给末行打 turnEnd），纯行增量拿不到，
 * 所以宿主每次变更追加一条带代数的记录，这里按 seq 套到本地行上。
 * 只套用到**本运行**的行：历史行的 seq 来自过去的宿主进程，数值会与本次运行重叠。
 */
function applyMarkEntries(entries: { seq: number; turnStart?: boolean; turnEnd?: boolean }[]): boolean {
  if (entries.length === 0) return false
  const bySeq = new Map<number, { turnStart?: boolean; turnEnd?: boolean }>()
  for (const e of entries) {
    const cur = bySeq.get(e.seq) ?? {}
    if (e.turnStart !== undefined) cur.turnStart = e.turnStart
    if (e.turnEnd !== undefined) cur.turnEnd = e.turnEnd
    bySeq.set(e.seq, cur)
  }
  let changed = false
  rows = rows.map((r) => {
    // 只给「本进程」的行打标记：历史文件里旧 run 的行 seq 会与新 run 重复，
    // 不区分就会把「本轮已结束」盖到一条历史行上（面板上表现为轮次状态错乱）
    if (hostRunId && r.runId !== hostRunId) return r
    const m = bySeq.get(r.seq)
    if (!m) return r
    const next = { ...r }
    if (m.turnStart !== undefined) next.turnStart = m.turnStart === true ? true : undefined
    if (m.turnEnd !== undefined) next.turnEnd = m.turnEnd === true ? true : undefined
    if (next.turnStart !== r.turnStart || next.turnEnd !== r.turnEnd) changed = true
    return next
  })
  return changed
}

/** 正在拉取的正文（同一行并发展开只发一次请求） */
const bodyFetches = new Map<string, Promise<void>>()

/** 就地更新某一行的本地状态（正文/加载态/错误），命中才 notify */
function setRowBody(k: string, patch: Partial<Row>): void {
  let hit = false
  rows = rows.map((r) => {
    if (rowKey(r) !== k) return r
    hit = true
    return { ...r, ...patch }
  })
  if (hit) notify()
}

/**
 * 按需拉取某行的正文 —— 协议 v2 的核心：快照不带正文，展开时才拉一行。
 * 已加载且未过期直接返回；404（该行没有正文）也记成已加载，避免反复请求。
 */
function ensureBody(k: string): Promise<void> {
  const row = rows.find((r) => rowKey(r) === k)
  if (!row || !row.hasBody) return Promise.resolve()
  if (row.bodyLoaded === true && row.bodyStale !== true) return Promise.resolve()
  const inflight = bodyFetches.get(k)
  if (inflight) return inflight
  const p = (async () => {
    setRowBody(k, { bodyLoading: true, bodyError: undefined })
    try {
      const url = `/api/activity-monitor/row?seq=${row.seq}&ts=${row.ts}`
        + (row.sessionId ? `&sessionId=${encodeURIComponent(row.sessionId)}` : '')
      const res = await fetch(url)
      if (res.status === 404) {
        setRowBody(k, { bodyLoading: false, bodyLoaded: true, hasBody: false })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const body = data?.row
      if (!body) {
        setRowBody(k, { bodyLoading: false, bodyLoaded: true, hasBody: false })
        return
      }
      setRowBody(k, {
        bodyLoading: false, bodyLoaded: true, bodyStale: false,
        detail: body.detail, sections: body.sections,
      })
    } catch (e: any) {
      // v1 这一类失败全是静默的：表现为「点不开、也不报错」，最难排查
      setRowBody(k, { bodyLoading: false, bodyError: String(e?.message ?? e) })
    } finally {
      bodyFetches.delete(k)
    }
  })()
  bodyFetches.set(k, p)
  return p
}

/** 历史分页状态：已落盘总行数 / 是否还有更早的没载入（「载入更早」按钮用） */
let historyTotal = 0
let historyTruncated = false

/** 载入该会话的落盘历史（轻行 + 标记；正文仍按需拉） */
async function loadHistory(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`/api/activity-monitor/history?sessionId=${encodeURIComponent(sessionId)}&light=1&limit=${clientCfg.backfillRows}`)
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data.rows) && mergeRows(data.rows)) notify()
    if (typeof data.total === 'number') historyTotal = data.total
    historyTruncated = data.truncated === true
  } catch { /* 无历史时静默 */ }
}

/** 向前翻页：把更早的历史行也载进来（底栏「载入更早」） */
async function loadOlder(): Promise<void> {
  if (!activeSessionId || rows.length === 0) return
  const oldest = Math.min(...rows.map((r) => r.ts))
  try {
    const res = await fetch(`/api/activity-monitor/history?sessionId=${encodeURIComponent(activeSessionId)}&light=1&limit=${clientCfg.backfillRows}&before=${oldest}`)
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data.rows)) {
      mergeRows(data.rows)
      historyTruncated = data.truncated === true
      notify()
    }
  } catch { /* 静默 */ }
}

/** 会话切换时清掉本会话的展开/收起状态（含「进行中」行的手动收起记录） */
function clearSessionUIState(): void {
  expanded.clear()
  collapsedInFlight.clear()
  expandedSecs.clear()
  expandedTurns.clear()
}

/** 归零增量游标：整段重载时用（换会话 / 宿主重启 / marks 游标作废） */
function resetIncremental(): void {
  rows = []
  lastSeq = 0
  markGen = 0
  historyTotal = 0
  historyTruncated = false
}

/** 跟随当前会话：会话变了就清空重载（游标与标记代数一并归零） */
function syncSession(): void {
  const next = readActiveSession()
  if (next === activeSessionId) return
  activeSessionId = next
  resetIncremental()
  clearSessionUIState()
  if (next) void loadHistory(next)
  notify()
}

/** 轮询计数：即使没有数据变化，也让底栏的耗时/字节数定期刷新一次 */
let pollTick = 0

/**
 * 拉一次快照（协议 v2 纯增量）。
 *
 * 与 v1 的三处关键差别：
 *  - v1 每次 `since = lastSeq - 30`（回看尾部 30 行）—— 因为轮次边界标记是事后补到旧行上的，
 *    纯增量拿不到；v2 改用宿主下发的 marks 日志（带代数游标），于是轮询退化为真正的纯增量。
 *  - 会话过滤在服务端做，客户端不再收到别的会话的行。
 *  - 宿主重启（runId 变了）/ marks 游标作废 / 换会话 → 整段重载。
 */
async function refresh(): Promise<void> {
  if (paused) return
  syncSession()
  const t0 = Date.now()
  try {
    const params = new URLSearchParams({ since: String(lastSeq), markSince: String(markGen) })
    if (activeSessionId) params.set('sessionId', activeSessionId)
    const res = await fetch(`/api/activity-monitor/snapshot?${params.toString()}`)
    const text = await res.text()
    pollStat = { ms: Date.now() - t0, bytes: text.length, at: Date.now() }
    if (!res.ok) return
    const data = JSON.parse(text)
    // 宿主重启：seq 从头开始，旧游标会让增量永远为空（表现为「面板卡住不动」）→ 整段重载
    if (data.runId && hostRunId && data.runId !== hostRunId) {
      hostRunId = data.runId
      resetIncremental()
      if (activeSessionId) await loadHistory(activeSessionId)
      notify()
      return
    }
    hostRunId = data.runId ?? hostRunId
    // marks 游标作废（代数被容量丢弃 / 客户端比宿主新）：整段重载，保证轮次状态最终一致
    if (data.marksTooOld === true || data.marksReset === true) {
      resetIncremental()
      if (activeSessionId) await loadHistory(activeSessionId)
      notify()
      return
    }
    let changed = Array.isArray(data.rows) ? mergeRows(data.rows) : false
    if (Array.isArray(data.marks)) changed = applyMarkEntries(data.marks) || changed
    if (typeof data.markGen === 'number') markGen = data.markGen
    if (typeof data.lastSeq === 'number') lastSeq = Math.max(lastSeq, data.lastSeq)
    pollTick++
    if (changed || pollTick % 10 === 0) notify()
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

/**
 * 点一行展开/收起。
 * 协议 v2 下正文是按需拉取的，所以展开前先确保正文到位，并立刻置「加载中」态 ——
 * 否则点开先看到一片空白，用户会以为功能坏了（v1 正文随快照一起来，不存在这一步）。
 */
async function toggleExpand(row: Row): Promise<void> {
  const k = rowKey(row)
  if (expanded.has(k)) {
    expanded.delete(k)
    notify()
    return
  }
  expanded.add(k)
  notify()
  await ensureBody(k)
}

const TAG_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  llm:        { label: '模型',   color: '#7c3aed', bg: 'rgba(124,58,237,.12)' },
  skill:      { label: 'skill', color: '#0e7490', bg: 'rgba(14,116,144,.12)' },
  'file-read':  { label: '读文件', color: '#1d4ed8', bg: 'rgba(29,78,216,.12)' },
  'file-write': { label: '写文件', color: '#b45309', bg: 'rgba(180,83,9,.12)' },
  command:    { label: '命令',   color: '#be123c', bg: 'rgba(190,18,60,.12)' },
  tool:       { label: '工具',   color: '#4b5563', bg: 'rgba(75,85,99,.12)' },
  // 验收结论（agent 写入的 task_verdict）：墨绿 —— 与「工具」灰、「命令」红一眼可分。
  // 这个键同时驱动工具栏的标签筛选按钮（tags 由 TAG_STYLE 的键生成）。
  verdict:    { label: '验收',   color: '#047857', bg: 'rgba(4,120,87,.12)' },
  // 进化提案（agent 写入的 evolution_proposal）：橙 —— 「待人工批准」的行要一眼能挑出来
  proposal:   { label: '提案',   color: '#ea580c', bg: 'rgba(234,88,12,.12)' },
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

/**
 * 提案状态的中文标签与配色（面板上就地显示，不弹窗）。
 * 「待批准」是唯一需要人动手的状态；其余都是终态或已推进过的历史。
 */
const PROP_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  proposed:     { label: '待批准', color: '#ea580c', bg: 'rgba(234,88,12,.14)' },
  approved:     { label: '已批准', color: '#047857', bg: 'rgba(4,120,87,.14)' },
  rejected:     { label: '已否决', color: '#be123c', bg: 'rgba(190,18,60,.14)' },
  applied:      { label: '已应用', color: '#1d4ed8', bg: 'rgba(29,78,216,.14)' },
  'rolled-back': { label: '已回滚', color: '#4b5563', bg: 'rgba(75,85,99,.14)' },
}

/** 提案状态变更的在途 / 出错标记（按 rowKey）——就地显示，避免弹窗在 webview 里被吞掉 */
const proposalBusy = new Set<string>()
const proposalErr = new Map<string, string>()

/** 有效状态缓存：rows 数组每次变更都换新对象，用引用比较当缓存键即可 */
let propStatusCache: { src: Row[]; map: ReturnType<typeof effectiveProposalStatus> } | null = null
function proposalStatusOf(list: Row[]): ReturnType<typeof effectiveProposalStatus> {
  if (!propStatusCache || propStatusCache.src !== list) {
    propStatusCache = { src: list, map: effectiveProposalStatus(list as any) }
  }
  return propStatusCache.map
}

/**
 * 人工批准 / 否决一条提案。
 *
 * 这一动作**只写一行状态变更行**（append-only）：宿主把「谁、什么时候、改成什么」追加进同一份
 * 会话日志，原提案行不动 —— 所以跨进程重启仍可追溯，也不需要改写历史文件。
 * **真正执行变更（装插件 / 建技能 / 停用）不在这里**：那是人的动作，走既有的执行器
 * （dshmarket / skills-manager），本插件不持执行权。
 */
async function transitionProposal(row: Row, status: 'approved' | 'rejected'): Promise<void> {
  const k = rowKey(row)
  if (proposalBusy.has(k)) return
  proposalBusy.add(k)
  proposalErr.delete(k)
  notify()
  try {
    const res = await fetch('/api/activity-monitor/proposal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: row.proposal?.id, seq: row.seq, status }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) throw new Error(String(data?.error ?? `HTTP ${res.status}`))
    // 宿主回带变更后的整行（轻行），直接并进本地：有效状态立刻变成 已批准 / 已否决
    if (data.row) mergeRows([data.row])
  } catch (e: any) {
    proposalErr.set(k, String(e?.message ?? e))
  } finally {
    proposalBusy.delete(k)
    notify()
  }
}

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
 * 正文按需拉取（协议 v2）：先取回正文，再按实际分段把二级折叠一起打开 ——
 * 正文没到之前 rowSecIds 是空数组，直接开会漏掉该行的所有段落。
 */
async function openFully(opts: { turnKey?: string; rows?: Row[]; secIds?: string[] }): Promise<void> {
  if (opts.turnKey) expandedTurns.add(opts.turnKey)
  for (const r of opts.rows ?? []) expanded.add(rowKey(r))
  for (const id of opts.secIds ?? []) expandedSecs.add(id)
  notify()
  for (const r of opts.rows ?? []) {
    const k = rowKey(r)
    await ensureBody(k)
    const cur = rows.find((x) => rowKey(x) === k)
    if (cur) for (const id of rowSecIds(cur)) expandedSecs.add(id)
  }
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
  // 轮次信号：与 agent 侧 activity_report 的 signals 同一套口径（重复调用/失败/上下文截断/长耗时/进行中）
  const signals = turnSignals(list)
  const hasWarn = signals.some((s) => s.severity === 'warn')
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
    // 轮次信号：把「重复调用 / 失败 / 上下文被整条省略 / 长耗时」直接摆在轮次头上（悬停看全）
    signals.length > 0 && h('span', {
      style: {
        fontSize: 11, whiteSpace: 'nowrap', fontWeight: 600,
        color: hasWarn ? '#dc2626' : 'var(--dsw-alias-label-secondary, #4b5563)',
      },
      title: signals.map((s) => `${s.severity === 'warn' ? '⚠' : 'ⓘ'} ${s.text}`).join('\n'),
    }, `${hasWarn ? '⚠' : 'ⓘ'} ${signals[0].text}${signals.length > 1 ? `（等 ${signals.length} 项）` : ''}`),
    h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', whiteSpace: 'nowrap' } },
      `${clockOf(firstTs)} → ${clockOf(lastTs)} · ${spanText}`),
    // 复制本轮 Markdown 摘要（只含时间/类型/摘要/耗时/token/上下文与信号，不含正文）
    h('span', {
      onClick: (e: any) => {
        e.stopPropagation?.()
        void navigator.clipboard?.writeText(rowsToMarkdown(group.rows, isNone ? '轮次外的活动' : `第 ${group.turn} 轮`))
      },
      style: {
        fontSize: 11, color: '#0ea5e9', cursor: 'pointer', whiteSpace: 'nowrap',
        border: '1px solid rgba(14,165,233,.45)', borderRadius: 3, padding: '0 4px',
      },
      title: '复制本轮的活动摘要（Markdown；不含提示词与工具输出正文）',
    }, '复制'),
  )
}

function ActivityRowView({ row, step, stepColor, loc, stepOf, prevModel }: {
  row: Row
  step?: number
  stepColor?: string
  /** 工具行在「完整上下文」里的位置（点它能跳回那条消息） */
  loc?: CallLoc
  /** 行 seq → 它在轮次里的步骤序号（用于说明位置标记指向哪次请求） */
  stepOf?: Map<number, number>
  /** 同一会话里的上一轮模型行：用来算「与上一轮相比」的差异（消息/上下文/提示词/工具） */
  prevModel?: Row
}) {
  const inFlight = row.settled === false
  const k = rowKey(row)
  // 进行中行（模型生成中 / 工具执行中）默认自动展开实时看输出；
  // 用户手动点掉才记进 collapsedInFlight（点回可再打开，定稿后不再自动展开）；
  // 定稿行照旧：只有用户点开过的才展开。
  const isOpen = inFlight ? !collapsedInFlight.has(k) : expanded.has(k)
  // hasBody 是宿主下发的「有正文」标记（轻行只带它）；正文到本地后 detail/sections 才有值
  const hasDetail = row.hasBody === true || Boolean(row.detail) || (row.sections?.length ?? 0) > 0
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
  /** 与上一轮上下文的差异（仅模型行、且上一轮有数据时） */
  const diff = row.kind === 'llm' && prevModel ? contextDiff(prevModel, row) : ''
  const onRowClick = (): void => {
    if (!hasDetail) return
    if (inFlight) {
      if (!collapsedInFlight.has(k)) {
        // 自动展开中，用户点掉 → 记「手动收起」（定稿后保持收起）
        collapsedInFlight.add(k)
      } else {
        // 已手动收起，用户点回 → 打开，且定稿后保持展开
        collapsedInFlight.delete(k)
        expanded.add(k)
        void ensureBody(k)
      }
    } else {
      void toggleExpand(row)
    }
    notify()
  }
  return h('div', {
    key: k,
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
      (row.kind === 'tool' || row.kind === 'verdict') && h('span', {
        style: {
          fontSize: 13, fontWeight: 600, color: tagColor, whiteSpace: 'nowrap',
          textDecoration: row.ok === false ? 'line-through' : 'none',
        },
        title: row.kind === 'verdict' ? `验收结论行：${row.name}` : `工具名：${row.name}`,
      }, row.name),
      // 进化提案行：状态 + 人工批准 / 否决。
      // 生效状态 = 同一 id 上最新那条变更行（原行写的 proposed 只是初始值，所以两者不同时给提示）。
      row.kind === 'proposal' && (() => {
        const p = row.proposal
        const isTransition = p?.transitionOf != null
        const st = isTransition
          ? String(p?.status ?? '')
          : (proposalStatusOf(rows).get(String(p?.id ?? `session:${row.seq}`))?.status ?? String(p?.status ?? 'proposed'))
        const stale = !isTransition && st !== String(p?.status ?? '')
        const s = PROP_STYLE[st] ?? { label: st || '?', color: '#4b5563', bg: 'rgba(75,85,99,.14)' }
        return h('span', {
          style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 },
        },
          h('span', { style: { fontSize: 13, fontWeight: 600, color: tagColor, whiteSpace: 'nowrap' } },
            `${isTransition ? '状态变更' : '提案'} · ${String(p?.pkind ?? '?')}/${String(p?.action ?? '?')} ${String(p?.target ?? '')}`),
          h('span', {
            style: { fontSize: 11, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', color: s.color, background: s.bg },
            title: stale ? `有效状态（原提案行写的是 ${p?.status}）` : `提案状态：${st}`,
          }, s.label),
          !isTransition && st === 'proposed' && h('span', { style: { display: 'flex', gap: 4 } },
            ...(['approved', 'rejected'] as const).map((want) => h('button', {
              key: want,
              disabled: proposalBusy.has(k),
              title: want === 'approved'
                ? '批准：只追加一行状态变更（不执行任何变更；执行由人走执行器）'
                : '否决：只追加一行状态变更',
              onClick: (e: any) => { e.stopPropagation(); void transitionProposal(row, want) },
              style: {
                fontSize: 11, padding: '1px 8px', borderRadius: 8, cursor: proposalBusy.has(k) ? 'wait' : 'pointer',
                border: `1px solid ${want === 'approved' ? '#047857' : '#be123c'}`,
                background: 'transparent', whiteSpace: 'nowrap',
                color: want === 'approved' ? '#047857' : '#be123c',
              },
            }, want === 'approved' ? '批准' : '否决'))),
          proposalBusy.has(k) && h('span', { style: { fontSize: 11, color: '#9ca3af' } }, '提交中…'),
          proposalErr.has(k) && h('span', { style: { fontSize: 11, color: '#be123c' } }, `失败：${proposalErr.get(k)}`),
        )
      })(),
      // 验收结论的状态徽标：pass 绿 / fail 红 / partial·unknown 琥珀；依据在后面的摘要位
      row.kind === 'verdict' && row.verdict && h('span', {
        style: {
          fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', borderRadius: 3, padding: '0 4px',
          color: row.verdict.status === 'pass' ? '#047857' : row.verdict.status === 'fail' ? '#b91c1c' : '#b45309',
          background: row.verdict.status === 'pass' ? 'rgba(4,120,87,.12)' : row.verdict.status === 'fail' ? 'rgba(185,28,28,.12)' : 'rgba(180,83,9,.12)',
        },
        title: `验收结论 ${row.verdict.status}（由 ${row.verdict.by} 写入）· 展开可见依据与证据行`,
      }, row.verdict.status),
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
    // 正文是协议 v2 按需拉取的：先把「加载中 / 失败」渲染出来，否则点开是一片空白
    isOpen && row.bodyLoading && h('div', {
      style: { margin: '0 12px 8px 40px', fontSize: 11, color: '#9ca3af' },
    }, '⋯ 正在取正文（v2：正文按需拉取，不占轮询通道）'),
    isOpen && row.bodyError && h('div', {
      style: { margin: '0 12px 8px 40px', fontSize: 11, color: '#dc2626' },
      title: '正文拉取失败：收起再展开会重试',
    }, `正文拉取失败：${row.bodyError}`),
    // 与上一轮的差异（上下文/提示词是否在膨胀）—— 一眼看出，不必逐轮点开对比
    isOpen && diff !== '' && h('div', {
      style: { margin: '0 12px 6px 40px', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #4b5563)' },
    }, diff),
    isOpen && row.sections && row.sections.length > 0 && h('div', { 'data-am-row': String(row.seq), style: { margin: '0 12px 8px 40px' } },
      row.sections.map((sec, i) => {
        // 用 key 做折叠标识（分组子段要能按 parent 找到自己所属分组的开关）
        // 段落 id 以 rowKey 打头，与折叠态同一套键（宿主重启后裸 seq 会撞车）
        const secId = sec.key ? `${k}:${sec.key}` : `${k}:${i}`
        const isGroup = sec.isGroup === true
        const isChild = sec.parent !== undefined
        // 分组收起时，子段整段不渲染（默认就是收起）
        if (isChild && !expandedSecs.has(`${k}:${sec.parent}`)) return null
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
          .map((s, j) => ({ s, id: s.key ? `${k}:${s.key}` : `${k}:${j}` }))
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
  // 导出/复制用当前视角的行（同一会话 + 当前标签筛选），与面板上看到的一致
  const exportRows = (): Row[] => scopedRows()
  const mkTitle = (): string => (activeSessionId ? `会话 ${activeSessionId.slice(0, 8)} 活动` : '活动记录')
  return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', flexWrap: 'wrap' } },
    h('button', {
      onClick: () => { paused = !paused; notify() },
      style: buttonStyle(paused),
    }, paused ? '▶ 恢复' : '⏸ 暂停'),
    // 「重载」= 丢掉本地游标与本地行，重新从宿主拉一遍（协议 v2 是增量同步，
    // 对不上时——换会话、宿主重启——靠重新同步而不是靠刷新整个页面）
    h('button', {
      onClick: () => {
        resetIncremental()
        clearSessionUIState()
        notify()
        if (activeSessionId) void loadHistory(activeSessionId)
      },
      style: buttonStyle(false),
      title: '丢掉本地游标，重新拉一次历史与实时行（不对齐时用）',
    }, '重载'),
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
    h('span', { style: { flex: 1 } }),
    // 导出：Markdown 摘要（贴给人看）与 JSON（给脚本处理）—— 都只含轻行字段，不含正文
    h('button', {
      onClick: () => { void navigator.clipboard?.writeText(rowsToMarkdown(exportRows(), mkTitle())) },
      style: buttonStyle(false),
      title: '复制当前视角的活动摘要（Markdown；不含提示词与工具输出正文）',
    }, '复制摘要'),
    h('button', {
      onClick: () => {
        const json = rowsToJson(exportRows(), { sessionId: activeSessionId })
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `activity-${(activeSessionId ?? 'all').slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        a.click()
        URL.revokeObjectURL(url)
      },
      style: buttonStyle(false),
      title: '导出当前视角为 JSON（轻行字段 + 会话汇总；正文按需拉取，不在这里导出）',
    }, '导出 JSON'),
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
  // 会话级汇总（底栏）：token / 工具调用 / 失败 / 最大上下文 —— 与当前视角一致，用可见行算
  const stats = sessionTotals(visible)
  // 行 seq → 它在轮次里的步骤序号（位置标记里说明「在请求 ⑤ 里发出」用）
  const stepOf = new Map<number, number>()
  for (const g of groups) g.rows.forEach((r, i) => stepOf.set(r.seq, i + 1))
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    h(Toolbar),
    h('div', { ref: listRef, onScroll: onListScroll, style: { flex: 1, overflowY: 'auto' } },
      // 历史是分页载入的（协议 v2 的 /history 只回最近 N 行，正文不随行下发）：
      // 还要更早的就点这里向前翻页，而不是一次性把整份历史灌进面板
      historyTruncated && h('div', { style: { padding: '6px 12px', textAlign: 'center' } },
        h('button', {
          onClick: () => { void loadOlder() },
          style: {
            fontSize: 11, padding: '3px 10px', cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', borderRadius: 4,
            background: 'transparent', color: 'var(--dsw-alias-label-secondary, #4b5563)',
          },
          title: '向更早的历史翻页（每次一屏，正文仍按需拉取）',
        }, `↑ 载入更早的活动（已载入 ${visible.length} 行）`)),
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
                    key: rowKey(row),
                    row,
                    step: i + 1,
                    stepColor: isHex ? (c as string) : undefined,
                    loc: locs.get(rowKey(row)),
                    stepOf,
                    // 跨轮差异的基准：同会话里 ts 更小的最近一条模型行（第一轮没有基准 → 不显示差异）
                    prevModel: row.kind === 'llm'
                      ? [...rows]
                        .filter((r) => r.kind === 'llm' && (r.sessionId ?? '') === (row.sessionId ?? '') && r.ts < row.ts)
                        .sort((a, b) => b.ts - a.ts)[0]
                      : undefined,
                  })),
                ),
              ),
            )
          }),
    ),
    h('div', { style: { padding: '4px 12px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', borderTop: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
      h('span', { title: '轮次 / 活动条数 / 已展开轮数 / 刷新状态' },
        `${groupCount} 轮 · ${visible.length} 条活动 · ${stats.turns} 轮有数据 · ${expandedTurns.size} 轮已展开 · ${paused ? '已暂停' : '实时刷新中'} · 最新在底部`),
      // 会话级汇总：token / 工具调用 / 失败 / 最大上下文 —— v1 收了这些字段却没展示
      h('span', { style: { whiteSpace: 'nowrap' }, title: '本会话汇总（口径与 agent 侧 activity_report 的 signals 一致）' },
        `模型 ${stats.llmCalls} · 工具 ${stats.toolCalls}${stats.failedCalls > 0 ? ` · 失败 ${stats.failedCalls}` : ''}`
        + (stats.inputTokens || stats.outputTokens ? ` · token ${stats.inputTokens}→${stats.outputTokens}` : '')
        + (stats.maxContextBytes > 0
          ? ` · 最大上下文 ${fmtBytes(stats.maxContextBytes)}${stats.maxContextTurn ? `（第 ${stats.maxContextTurn} 轮）` : ''}`
          : '')
        + (stats.contextOmitted > 0 ? ` · ⚠省略 ${stats.contextOmitted} 条` : '')),
      // 协议 v2 的效果指纹：一次快照的耗时与响应体积（v1 回看尾 30 行，最坏 530KB）
      h('span', { style: { whiteSpace: 'nowrap' }, title: '最近一次快照：耗时 / 响应体积（v2 改纯增量后应在 KB 级）' },
        pollStat.at ? `快照 ${pollStat.ms}ms · ${fmtBytes(pollStat.bytes)}` : '快照 —'),
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

  // 客户端可调项：挂载时从宿主 /config 读一次（同源，口径统一），拿不到就用内置默认值。
  // 这样「轮询节奏 / 行数上限 / 历史回填行数」跟随宿主 Config，不再是两边各写一套常量。
  ctx.effect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/activity-monitor/config')
        if (!res.ok) return
        const data = await res.json()
        const c = data?.client ?? data?.config ?? {}
        if (typeof c.pollActiveMs === 'number') clientCfg.pollActiveMs = c.pollActiveMs
        if (typeof c.pollIdleMs === 'number') clientCfg.pollIdleMs = c.pollIdleMs
        if (typeof c.maxRows === 'number') clientCfg.maxRows = c.maxRows
        if (typeof c.backfillRows === 'number') clientCfg.backfillRows = c.backfillRows
      } catch { /* 拿不到配置就用默认值 */ }
    })()
    return () => { /* 一次性读取，无需清理 */ }
  }, 'activity-monitor: read config')

  ctx.effect(() => {
    // 自适应轮询：有「进行中」的行（模型生成中/工具执行中）时用 pollActiveMs（默认 300ms），
    // 流式输出实时上屏；全空闲时退回 pollIdleMs（默认 1s），避免空转。
    // 两个值都来自宿主 Config（见上），调节奏不用改代码。
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
      timer = window.setTimeout(tick, busyLive ? clientCfg.pollActiveMs : clientCfg.pollIdleMs)
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
        // ── 协议 v2 同步状态：增量游标 / 正文按需拉取 / 快照体积指纹 ──
        protocol: {
          lastSeq,
          markGen,
          hostRunId: hostRunId ?? null,
          pollStat,
          loadingBodies: bodyFetches.size,
          bodiesLoaded: rows.filter((r) => r.bodyLoaded === true).length,
          bodiesStale: rows.filter((r) => r.bodyStale === true).length,
          clientCfg,
        },
      }
    },
    /** 列出当前已知会话 id */
    sessionIds: () => {
      try { return (clientCtx?.sessions?.list?.getSnapshot?.()?.ids ?? []).map(String) } catch { return [] }
    },
    /**
     * 走 dsh 自己的会话选择 API（侧栏点击内部用的就是它）。
     * 必须 await：会话 id 不存在时 dsh 是**异步拒绝**的，不 await 就把失败当成功返回，
     * 表现为「调了 openSession 但面板没变」，容易被误判成跟随逻辑的问题。
     * 注意只对 dsh 已知的会话有效：历史文件里的会话 id 未必还在会话列表里。
     */
    openSession: async (id: string) => {
      try {
        await clientCtx?.sessions?.open?.(id)
        return 'ok'
      } catch (e: any) { return String(e?.message ?? e) }
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
