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
  sections?: { title: string; body: string; key?: string }[]
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

  /** 追加内存行 + 落盘历史（按 session 分文件） */
  function record(row: Omit<ActivityRow, 'seq' | 'ts'>): void {
    const full: ActivityRow = { ...row, seq: ++seq, ts: Date.now() }
    rows.push(full)
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS)
    try {
      const file = path.join(HISTORY_DIR, `${(full.sessionId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`)
      appendFileSync(file, JSON.stringify(full) + '\n')
    } catch { /* 磁盘异常不影响主流程 */ }
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
        // 默认折叠；空结果就只显示参数
        detail: [
          '── 参数 ──',
          JSON.stringify(args, null, 2),
          '── 结果 ──',
          resultText ? truncateText(resultText, 3000) : '（工具未返回文本结果）',
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
        let promptSections: { title: string; body: string }[] = []
        if (assemblySections?.length) {
          promptSections = assemblySections
            .filter((s: any) => (s.text ?? '').trim().length > 0)
            .map((s: any, i: number) => {
              const src = describeSectionSource(s.name)
              const title = src
                ? `${i + 1}. ${s.name} ${src}`
                : `${i + 1}. ${s.name}（第三方插件注册）`
              // key 非空 → 前端二级折叠（提示词正文默认不展开）
              return { title, body: truncateText(s.text, 2500), key: `sec:${s.name}` }
            })
          for (const c of assemblyContexts ?? []) {
            if ((c.text ?? '').trim()) {
              promptSections.push({ title: `runtime-context: ${c.name}`, body: truncateText(c.text, 1500), key: `ctx:${c.name}` })
            }
          }
        }

        // 回退：没有 assemble 结果时，从渲染文本按空行拆分（无名段落）
        if (promptSections.length === 0 && systemText) {
          promptSections = splitSystemPrompt(systemText).map((s, i) => ({ ...s, key: `fb:${i}` }))
        }

        const sections: { title: string; body: string }[] = []
        if (lastUserText) {
          sections.push({ title: '用户消息（最近一条）', body: truncateText(lastUserText, 2000) })
        }
        if (replyText) {
          sections.push({ title: '助手回复', body: truncateText(replyText, 3000) })
        }
        if (promptSections.length > 0) {
          sections.push({ title: `系统提示词（${promptSections.length} 个 section，按生效顺序）`, body: '' })
          sections.push(...promptSections)
        }
        record({
          kind: 'llm',
          sessionId: options.sessionId ? String(options.sessionId) : undefined,
          name: `${options.provider}/${options.model}`,
          tag: 'llm',
          summary: `${usage || '流式完成'} · 回复 ${replyText.length} 字 · ${options.messages?.length ?? 0} 条消息 · ${options.tools?.length ?? 0} 个工具 · ${promptSections.length} 段提示词`,
          durationMs: Date.now() - start,
          ok: true,
          sections,
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
        res.end(JSON.stringify({ sessionId: sid, rows: out, total: out.length }))
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
        rows: fresh,
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
