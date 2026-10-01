/**
 * 历史落盘与读取（按会话分文件 JSONL + 归档 + 索引）。
 *
 * 为什么单独成模块：v1 把这些逻辑散在 index.ts 里，有三个实测问题：
 *   1. persist 用 appendFileSync 在 llm/stream 的收尾里同步写盘 —— 每定稿一行阻塞一次
 *      事件循环，而一行的体积平均 15KB、最坏 265KB（含提示词与上下文正文）。
 *   2. 会话列表端点为统计行数/末次时间把**每个**文件整篇读完；切会话时又把整个文件
 *      一次性读进内存再 split —— 都是 O(全库字节)。
 *   3. 没有任何保留策略：两天就 2.16MB / 15 个文件，线性增长无上限。
 * 这里给出一套可单测的实现：异步串行写入队列、按 (mtime,size) 校验的解析缓存、
 * 索引文件（行数/末次时间/字节数只统计一次）、超过阈值自动 gzip 归档（原文不丢，
 * .jsonl.gz 仍可读）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import * as path from 'node:path'
import type { ActivityRow } from './types.js'

/** 会话 id → 文件名安全键（纯函数，可单测） */
export function safeSessionKey(sessionId: string | undefined | null): string {
  return String(sessionId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** JSONL 文本 → 行数组（坏行计数而不是抛错；纯函数，可单测） */
export function parseJsonl(text: string): { rows: ActivityRow[]; badLines: number } {
  const rows: ActivityRow[] = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as ActivityRow)
    } catch {
      badLines++
    }
  }
  return { rows, badLines }
}

/** 单个会话文件的状态 */
export interface SessionInfo {
  /** 面板上的会话 id（global.jsonl → null） */
  sessionId: string | null
  /** 文件名安全键（不含扩展名） */
  key: string
  /** 已落盘行数（-1 = 尚未统计，首次 list() 时会补齐） */
  rows: number
  lastTs: number
  bytes: number
  /** 已归档为 .jsonl.gz */
  archived: boolean
  updatedAt: number
}

export interface HistoryStats {
  appended: number
  written: number
  bytesWritten: number
  pendingBytes: number
  errors: number
  lastError?: string
  lastFlushAt: number
  lastArchiveAt?: number
  lastArchive?: ArchiveResult
  badLines: number
}

export interface ArchiveResult {
  scanned: number
  archived: number
  skipped: number
  errors: number
  lastError?: string
  at: number
}

/** 单个文件解析结果的内存缓存（按 mtime+size 校验，避免重复解析几百 KB） */
interface ParsedFile {
  file: string
  mtimeMs: number
  size: number
  rows: ActivityRow[]
  badLines: number
}

/** 超过该体积的历史文件不整篇读进内存（防 OOM；归档策略会让正常文件远小于它） */
const MAX_READ_BYTES = 128 * 1024 * 1024
/** 写入缓冲达到该体积就立刻 flush（而不是等去抖窗口） */
const FLUSH_THRESHOLD_BYTES = 1024 * 1024
/** 写入去抖窗口：同一次工具/模型回调里连续定稿的多行合并成一次 appendFile */
const FLUSH_DEBOUNCE_MS = 200

export interface HistoryStoreOptions {
  dir: string
  archiveAfterDays?: number
  maxCachedSessions?: number
}

export class HistoryStore {
  readonly dir: string
  private archiveAfterDays: number
  private maxCached: number

  private index = new Map<string, SessionInfo>()
  private cache: ParsedFile[] = []          // LRU：命中的放末尾
  private pending = new Map<string, string[]>()
  private pendingBytes = new Map<string, number>()
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private indexDirty = false
  private closed = false

  private counters = {
    appended: 0,
    written: 0,
    bytesWritten: 0,
    errors: 0,
    lastError: undefined as string | undefined,
    lastFlushAt: 0,
    lastArchiveAt: undefined as number | undefined,
    lastArchive: undefined as ArchiveResult | undefined,
    badLines: 0,
  }

  constructor(opts: HistoryStoreOptions) {
    this.dir = opts.dir
    this.archiveAfterDays = opts.archiveAfterDays ?? 0
    this.maxCached = Math.max(1, opts.maxCachedSessions ?? 4)
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch (e) {
      this.recordError(e)
    }
    this.loadIndex()
    this.scan()
  }

  // ── 索引 ──
  private get indexPath(): string {
    return path.join(this.dir, 'index.json')
  }

  private loadIndex(): void {
    try {
      if (!existsSync(this.indexPath)) return
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as { sessions?: SessionInfo[] }
      for (const s of raw.sessions ?? []) {
        if (s && typeof s.key === 'string') this.index.set(s.key, s)
      }
    } catch (e) {
      // 索引损坏不是致命问题：忽略即可，scan() 会重建
      this.recordError(e)
    }
  }

  /** 目录扫描：登记文件的存在/字节/mtime（行数沿用索引里统计过的值，缺省 -1 = 未知） */
  private scan(): void {
    let files: string[] = []
    try {
      files = readdirSync(this.dir)
    } catch (e) {
      this.recordError(e)
      return
    }
    const seen = new Set<string>()
    for (const f of files) {
      const m = /^(.+)\.jsonl(\.gz)?$/.exec(f)
      if (!m) continue
      const key = m[1]
      const archived = Boolean(m[2])
      seen.add(key)
      let size = 0
      let mtimeMs = 0
      try {
        const st = statSync(path.join(this.dir, f))
        size = st.size
        mtimeMs = st.mtimeMs
      } catch { /* 文件刚被并发删除：忽略 */ }
      const prev = this.index.get(key)
      if (prev && prev.archived && !archived) {
        // 归档后又写入（文件重新出现）：转回未归档态，行数沿用累计值
        prev.archived = false
        prev.bytes = size
        prev.updatedAt = mtimeMs || Date.now()
        this.indexDirty = true
        continue
      }
      this.index.set(key, {
        sessionId: key === 'global' ? null : (prev?.sessionId ?? key),
        key,
        rows: prev?.rows ?? -1,
        lastTs: prev?.lastTs ?? 0,
        bytes: size,
        archived,
        updatedAt: mtimeMs || Date.now(),
      })
    }
    for (const key of [...this.index.keys()]) {
      if (!seen.has(key)) {
        // 文件被删（用户手工清理）：从索引里摘掉，避免列表出现幽灵会话
        this.index.delete(key)
        this.indexDirty = true
      }
    }
    if (this.indexDirty) this.saveIndexNow()
  }

  private saveIndexSoon(): void {
    this.indexDirty = true
    this.scheduleFlush(FLUSH_DEBOUNCE_MS)
  }

  private saveIndexNow(): void {
    if (!this.indexDirty) return
    try {
      const payload = JSON.stringify({ version: 2, savedAt: Date.now(), sessions: [...this.index.values()] })
      const tmp = `${this.indexPath}.tmp`
      writeFileSync(tmp, payload)
      renameSync(tmp, this.indexPath)
      this.indexDirty = false
    } catch (e) {
      this.recordError(e)
    }
  }

  // ── 写入 ──
  private fileOf(key: string): { raw: string; gz: string } {
    return { raw: path.join(this.dir, `${key}.jsonl`), gz: path.join(this.dir, `${key}.jsonl.gz`) }
  }

  /** 入队一行（异步落盘；调用方在 llm/stream 的关键路径上，不能被磁盘阻塞） */
  append(row: ActivityRow): void {
    if (this.closed) return
    const key = safeSessionKey(row.sessionId)
    const { raw } = this.fileOf(key)
    const line = `${JSON.stringify(row)}\n`
    const bytes = Buffer.byteLength(line)
    const arr = this.pending.get(raw)
    if (arr) arr.push(line)
    else this.pending.set(raw, [line])
    this.pendingBytes.set(raw, (this.pendingBytes.get(raw) ?? 0) + bytes)
    this.counters.appended++

    const info = this.index.get(key)
    const ts = typeof row.ts === 'number' ? row.ts : Date.now()
    if (info) {
      info.rows = Math.max(0, info.rows) + 1
      info.lastTs = Math.max(info.lastTs, ts)
      info.bytes += bytes
      info.archived = false
      info.updatedAt = Date.now()
    } else {
      this.index.set(key, { sessionId: key === 'global' ? null : key, key, rows: 1, lastTs: ts, bytes, archived: false, updatedAt: Date.now() })
    }
    this.indexDirty = true
    this.scheduleFlush(this.pendingTotalBytes() >= FLUSH_THRESHOLD_BYTES ? 0 : FLUSH_DEBOUNCE_MS)
  }

  private pendingTotalBytes(): number {
    let n = 0
    for (const v of this.pendingBytes.values()) n += v
    return n
  }

  private scheduleFlush(delay: number): void {
    if (this.closed) return
    if (this.timer !== undefined) return // 已有 flush 在排队
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.chain = this.chain.then(() => this.flushNow()).catch((e) => this.recordError(e))
    }, delay)
    // 别让一个待写的 timer 拖住进程退出（Node 里 unref 可用时用上）
    const t = this.timer as unknown as { unref?: () => void }
    t.unref?.()
  }

  private async flushNow(): Promise<void> {
    this.saveIndexNow()
    if (this.pending.size === 0) return
    const batch = [...this.pending.entries()]
    this.pending = new Map()
    this.pendingBytes = new Map()
    for (const [file, lines] of batch) {
      const text = lines.join('')
      try {
        await appendFile(file, text)
        this.counters.written += lines.length
        this.counters.bytesWritten += Buffer.byteLength(text)
        this.counters.lastFlushAt = Date.now()
      } catch (e) {
        // 写失败：把这一批塞回待写队列，下一次 flush 再试（磁盘满/权限问题不该丢数据）
        const back = this.pending.get(file) ?? []
        this.pending.set(file, [...lines, ...back])
        this.pendingBytes.set(file, (this.pendingBytes.get(file) ?? 0) + Buffer.byteLength(text))
        this.recordError(e)
      }
    }
  }

  /** 同步刷出待写内容（进程退出/插件卸载兜底；正常路径不应调用） */
  flushSync(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.saveIndexNow()
    for (const [file, lines] of this.pending) {
      const text = lines.join('')
      try {
        appendFileSync(file, text)
        this.counters.written += lines.length
        this.counters.bytesWritten += Buffer.byteLength(text)
      } catch (e) {
        this.recordError(e)
      }
    }
    this.pending = new Map()
    this.pendingBytes = new Map()
  }

  /** 等待待写内容落盘（测试与优雅关闭用） */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.chain
    await this.flushNow()
    await this.chain
  }

  close(): void {
    this.flushSync()
    this.closed = true
    this.cache = []
  }

  // ── 读取 ──
  private parseCached(file: string): { rows: ActivityRow[]; badLines: number; tooLarge: boolean } {
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(file)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      return { rows: [], badLines: 0, tooLarge: false }
    }
    const hit = this.cache.find((c) => c.file === file && c.mtimeMs === mtimeMs && c.size === size)
    if (hit) {
      this.touch(file)
      return { rows: hit.rows, badLines: hit.badLines, tooLarge: false }
    }
    if (size > MAX_READ_BYTES) {
      this.recordError(new Error(`历史文件过大（${size} 字节），跳过读取：${file}`))
      return { rows: [], badLines: 0, tooLarge: true }
    }
    let text = ''
    try {
      const buf = readFileSync(file)
      text = file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
    } catch (e) {
      this.recordError(e)
      return { rows: [], badLines: 0, tooLarge: false }
    }
    const parsed = parseJsonl(text)
    this.counters.badLines += parsed.badLines
    this.cache.push({ file, mtimeMs, size, rows: parsed.rows, badLines: parsed.badLines })
    while (this.cache.length > this.maxCached) this.cache.shift()
    return { rows: parsed.rows, badLines: parsed.badLines, tooLarge: false }
  }

  private touch(file: string): void {
    const i = this.cache.findIndex((c) => c.file === file)
    if (i >= 0 && i !== this.cache.length - 1) {
      const [c] = this.cache.splice(i, 1)
      this.cache.push(c)
    }
  }

  /** 读整个会话的行（按文件内顺序；优先未归档文件，其次 .jsonl.gz） */
  rows(sessionId: string | null): { rows: ActivityRow[]; archived: boolean; badLines: number; tooLarge: boolean } {
    const key = safeSessionKey(sessionId)
    const { raw, gz } = this.fileOf(key)
    if (existsSync(raw)) {
      const r = this.parseCached(raw)
      return { ...r, archived: false }
    }
    if (existsSync(gz)) {
      const r = this.parseCached(gz)
      return { ...r, archived: true }
    }
    return { rows: [], archived: false, badLines: 0, tooLarge: false }
  }

  /** 取某一行的重体（detail/sections）—— 前端展开时才调用 */
  row(sessionId: string | null, seq: number, ts: number): { rev?: number; detail?: string; sections?: ActivityRow['sections'] } | undefined {
    const r = this.rows(sessionId)
    const hit = r.rows.find((x) => x.seq === seq && x.ts === ts)
    if (!hit) return undefined
    return { rev: hit.rev, detail: hit.detail, sections: hit.sections }
  }

  // ── 会话列表 ──
  /** 列表（按末次时间倒序；行数未知的会话在此补齐一次并写回索引） */
  list(): SessionInfo[] {
    for (const info of this.index.values()) {
      if (info.rows >= 0) continue
      const r = this.rows(info.sessionId)
      info.rows = r.rows.length
      const last = r.rows.length > 0 ? Math.max(...r.rows.map((x) => (typeof x.ts === 'number' ? x.ts : 0))) : info.lastTs
      info.lastTs = Math.max(info.lastTs, last)
      this.indexDirty = true
    }
    if (this.indexDirty) this.saveIndexNow()
    return [...this.index.values()].sort((a, b) => b.lastTs - a.lastTs)
  }

  // ── 归档 ──
  /**
   * 超过 archiveAfterDays 的会话文件自动 gzip 归档：写 .jsonl.gz（临时文件 + rename，
   * 保证读者只会看到完整文件）后删除原文 —— 原文并没有丢，内容完整地在 .gz 里，
   * 读取路径（rows/row）对 .jsonl.gz 透明。0 天 = 关闭。
   */
  archiveOld(now: number = Date.now()): ArchiveResult {
    const res: ArchiveResult = { scanned: 0, archived: 0, skipped: 0, errors: 0, at: now }
    if (!this.archiveAfterDays || this.archiveAfterDays <= 0) {
      this.counters.lastArchive = res
      this.counters.lastArchiveAt = now
      return res
    }
    const cutoff = now - this.archiveAfterDays * 86_400_000
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'))
    } catch (e) {
      this.recordError(e)
      res.errors++
      res.lastError = this.counters.lastError
      return res
    }
    for (const f of files) {
      const raw = path.join(this.dir, f)
      const gz = `${raw}.gz`
      res.scanned++
      try {
        const st = statSync(raw)
        if (st.mtimeMs >= cutoff) continue
        if (existsSync(gz)) {
          // 归档目标已存在：保守起见不删原文（可能是上次归档留下的一致性状态）
          res.skipped++
          continue
        }
        const gzText = gzipSync(readFileSync(raw))
        const tmp = `${gz}.tmp`
        writeFileSync(tmp, gzText)
        renameSync(tmp, gz)
        unlinkSync(raw)
        const key = f.replace(/\.jsonl$/, '')
        const info = this.index.get(key)
        if (info) {
          info.archived = true
          info.bytes = gzText.length
          info.updatedAt = now
          this.indexDirty = true
        }
        // 缓存里的旧解析结果指向已删除的文件，清掉
        this.cache = this.cache.filter((c) => c.file !== raw)
        res.archived++
      } catch (e) {
        res.errors++
        this.recordError(e)
      }
    }
    if (this.indexDirty) this.saveIndexNow()
    res.lastError = this.counters.lastError
    this.counters.lastArchive = res
    this.counters.lastArchiveAt = now
    return res
  }

  // ── 统计 ──
  stats(): HistoryStats {
    return {
      ...this.counters,
      pendingBytes: this.pendingTotalBytes(),
    }
  }

  private recordError(e: unknown): void {
    this.counters.errors++
    this.counters.lastError = e instanceof Error ? e.message : String(e)
  }
}
