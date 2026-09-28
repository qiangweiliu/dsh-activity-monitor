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

export const inject = ['slots'] as const

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
  sections?: { title: string; body: string; key?: string }[]
  durationMs?: number
  ok?: boolean
}

// ── 简易外部 store（useSyncExternalStore）──
let rows: Row[] = []
let expanded = new Set<number>()
let paused = false
let filterTag = 'all'
let lastSeq = 0
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

let pollTimer: number | undefined
/** 当前活跃 session id（从最新事件推断） */
let currentSessionId: string | undefined
/** 二级折叠：提示词段落 id 集合（默认不展开） */
const expandedSecs = new Set<string>()
function toggleSec(id: string): void {
  if (expandedSecs.has(id)) expandedSecs.delete(id)
  else expandedSecs.add(id)
  notify()
}

async function refresh(): Promise<void> {
  if (paused) return
  try {
    const res = await fetch(`/api/activity-monitor/snapshot?since=${lastSeq}`)
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data.rows) && data.rows.length > 0) {
      // 正序追加：最新的排在列表末尾（时间升序）
      rows = [...rows, ...data.rows].slice(-500)
      lastSeq = data.rows[data.rows.length - 1].seq
      // 从最新事件推断当前会话
      for (let i = data.rows.length - 1; i >= 0; i--) {
        if (data.rows[i].sessionId) { currentSessionId = data.rows[i].sessionId; break }
      }
      notify()
    }
  } catch { /* 服务未就绪时静默 */ }
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

function ActivityRowView({ row }: { row: Row }) {
  // 默认一律折叠：只有用户点击过的行才展开
  const isOpen = expanded.has(row.seq)
  const hasDetail = Boolean(row.detail) || (row.sections?.length ?? 0) > 0
  const time = new Date(row.ts).toLocaleTimeString()
  return h('div', { key: row.seq, style: { borderBottom: '1px solid var(--dsw-alias-border-subtle, #e5e7eb)' } },
    h('div', {
      onClick: () => { if (hasDetail) toggleExpand(row.seq) },
      style: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        cursor: hasDetail ? 'pointer' : 'default',
        userSelect: 'none' as const,
      },
    },
      hasDetail && h('span', { style: { fontSize: 10, color: '#9ca3af', width: 10 } }, isOpen ? '▾' : '▸'),
      h(Badge, { tag: row.tag }),
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
      h('span', { style: { fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' } }, time),
    ),
    // 展开区：llm 行渲染分段（用户消息/助手回复/提示词段落），tool 行渲染单块 detail
    // 提示词分段（sec.key 存在的）是二级折叠：点击段落标题单独展开正文
    isOpen && row.sections && row.sections.length > 0 && h('div', { style: { margin: '0 12px 8px 40px' } },
      row.sections.map((sec, i) => {
        const secId = `${row.seq}:${i}`
        const secOpen = sec.key ? expandedSecs.has(secId) : true // 无 key 的（用户消息/回复）默认展开
        return h('div', { key: i, style: { marginBottom: 6 } },
          h('div', {
            onClick: sec.key ? () => { toggleSec(secId); } : undefined,
            style: {
              fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #6b7280)',
              padding: '3px 8px', background: 'var(--dsw-alias-bg-subtle, #eceff3)',
              border: '1px solid var(--dsw-alias-border-subtle, #e5e7eb)', borderBottom: secOpen ? 'none' : '1px solid',
              borderRadius: secOpen ? '4px 4px 0 0' : 4,
              cursor: sec.key ? 'pointer' : 'default', userSelect: 'none' as const,
            },
          }, (sec.key ? (expandedSecs.has(secId) ? '▾ ' : '▸ ') : '') + sec.title),
          secOpen && h('pre', {
            style: {
              margin: 0, padding: 8, fontSize: 11, lineHeight: 1.5,
              background: 'var(--dsw-alias-bg-subtle, #f3f4f6)', borderRadius: sec.key ? '0 0 4px 4px' : 4,
              border: '1px solid var(--dsw-alias-border-subtle, #e5e7eb)',
              overflow: 'auto', maxHeight: 220, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            },
          }, sec.body),
        )
      }),
    ),
    isOpen && row.detail && h('pre', {
      style: {
        margin: '0 12px 8px 40px', padding: 8, fontSize: 11, lineHeight: 1.5,
        background: 'var(--dsw-alias-bg-subtle, #f3f4f6)', borderRadius: 6,
        overflow: 'auto', maxHeight: 260, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      },
    }, row.detail),
  )
}

function Toolbar() {
  const tags = ['all', ...Object.keys(TAG_STYLE)]
  return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', flexWrap: 'wrap' } },
    h('button', {
      onClick: () => { paused = !paused; notify() },
      style: buttonStyle(paused),
    }, paused ? '▶ 恢复' : '⏸ 暂停'),
    h('button', {
      onClick: () => { rows = []; expanded.clear(); notify() },
      style: buttonStyle(false),
    }, '清空'),
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
    border: '1px solid ' + (active ? '#2563eb' : 'var(--dsw-alias-border-subtle, #d1d5db)'),
    background: active ? 'rgba(37,99,235,.1)' : 'transparent',
    color: active ? '#2563eb' : 'var(--dsw-alias-label-secondary, #4b5563)',
  }
}

function MonitorPanel(): React.ReactElement {
  // 关键：订阅 store。notify() 变化 version，组件随 version 重渲染。
  // 之前的版本没有任何订阅，点击展开后 React 不知道需要重渲染。
  const [version, setVersion] = useState(0)
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), [])
  void version // 仅作为渲染依赖

  const listRef = useRef<HTMLDivElement | null>(null)
  // 新数据到达时自动滚动到底部（时间正序，最新在下面）
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [version])

  const visible = filterTag === 'all' ? rows : rows.filter((r) => r.tag === filterTag)
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    h(Toolbar),
    h('div', { ref: listRef, style: { flex: 1, overflowY: 'auto' } },
      visible.length === 0
        ? h('div', { style: { padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 } },
            '暂无活动 —— 发起一段对话后这里会实时显示提示词、skill、工具、文件和命令的使用情况')
        : visible.map((row) => h(ActivityRowView, { key: row.seq, row })),
    ),
    h('div', { style: { padding: '4px 12px', fontSize: 11, color: '#9ca3af', borderTop: '1px solid var(--dsw-alias-border-subtle, #e5e7eb)', display: 'flex', justifyContent: 'space-between' } },
      h('span', null, `共 ${visible.length} 条 · ${paused ? '已暂停' : '实时刷新中'} · 最新在底部`),
      currentSessionId && h('span', null, `session: ${currentSessionId.slice(0, 12)}…`),
    ),
  )
}

// ── 插件入口 ──

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tick = () => { void refresh() }
    pollTimer = window.setInterval(tick, 1000)
    void refresh()
    return () => { if (pollTimer) window.clearInterval(pollTimer) }
  }, 'activity-monitor: polling')

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
