/**
 * L5 跨会话聚合 + `summaries.json` 缓存（宿主侧模块，不进客户端 bundle）。
 *
 * 要解决的两个问题：
 *  1. **成本**：聚合要读每个会话的整份 JSONL（O(全库字节)），而 `activity_report` 是 agent 高频
 *     调用的工具；不缓存的话每次调用都把全库扫一遍（本机历史 2MB+、15 会话起）。
 *     缓存键 = `(行数, lastTs)`：文件没长、末次时间没变 → 直接复用上次的汇总。
 *  2. **失败软着陆**：缓存文件损坏、缺字段、目录不存在，一律当作「没有缓存」重建 ——
 *     缓存是加速层，绝不能变成新的失败源（读写全部 try/catch，错误只计数不外抛）。
 *
 * 缓存非权威：权威数据永远是会话 JSONL 本身。删掉 summaries.json 只是下次慢一点，
 * 不会丢任何事实（重建完全幂等）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { recurringFailSigs, summarizeSession, type DerivedRow, type SessionSummary } from './derive.js'
import { mergeActivityRows } from './wire.js'
import type { HistoryStore } from './history.js'

/** 缓存文件格式版本（形状变更时递增；版本不符 = 当作没有缓存重建） */
export const SUMMARIES_VERSION = 1

/** 缓存的可观测状态（进 /selfcheck 与报告，避免缓存成为黑盒） */
export interface SummaryCacheStats {
  hits: number
  misses: number
  errors: number
  entries: number
  savedAt: number
  lastError?: string
}

/**
 * 会话汇总的磁盘缓存。键 = 会话文件安全键（`SessionInfo.key`）。
 * 内存上限 maxEntries：超了按 lastTs 丢最旧的（本机 15 会话量级，纯属兜底）。
 */
export class SummaryCache {
  private entries = new Map<string, { rows: number; lastTs: number; sum: SessionSummary }>()
  private hits = 0
  private misses = 0
  private errors = 0
  private lastError: string | undefined
  private dirty = false
  private savedAt = 0
  private loaded = false

  constructor(
    /** 缓存文件绝对路径（与历史 JSONL 同目录） */
    readonly file: string,
    private readonly maxEntries = 64,
  ) {}

  /** 从磁盘载入（可重复调用；只在首次真正读盘）。坏文件/缺文件 = 空缓存，不抛。 */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as any
      if (!raw || raw.v !== SUMMARIES_VERSION || typeof raw.entries !== 'object' || raw.entries === null) return
      for (const [k, e] of Object.entries<any>(raw.entries)) {
        if (e && typeof e.rows === 'number' && typeof e.lastTs === 'number' && e.sum) {
          this.entries.set(k, { rows: e.rows, lastTs: e.lastTs, sum: e.sum as SessionSummary })
        }
      }
      this.savedAt = typeof raw.savedAt === 'number' ? raw.savedAt : 0
    } catch {
      // 文件不存在 / JSON 坏 / 权限问题：当作没有缓存（下次聚合重建并覆盖）
    }
  }

  /** 命中返回汇总；未命中返回 undefined 并记一次 miss（调用方去读文件重算） */
  get(key: string, rows: number, lastTs: number): SessionSummary | undefined {
    const e = this.entries.get(key)
    if (e && e.rows === rows && e.lastTs === lastTs) {
      this.hits++
      return e.sum
    }
    this.misses++
    return undefined
  }

  set(key: string, sum: SessionSummary, rows: number, lastTs: number): void {
    this.entries.set(key, { rows, lastTs, sum })
    this.dirty = true
    if (this.entries.size > this.maxEntries) {
      const ordered = [...this.entries.entries()].sort((a, b) => a[1].sum.lastTs - b[1].sum.lastTs)
      for (const [k] of ordered.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(k)
    }
  }

  /** 原子写盘（临时文件 + rename，读者只会看到完整文件）；只在有变更时写，失败只计数 */
  save(): boolean {
    if (!this.dirty) return false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({
        v: SUMMARIES_VERSION,
        savedAt: Date.now(),
        entries: Object.fromEntries(this.entries),
      }))
      renameSync(tmp, this.file)
      this.savedAt = Date.now()
      this.dirty = false
      return true
    } catch (e: any) {
      this.errors++
      this.lastError = String(e?.message ?? e)
      return false
    }
  }

  stats(): SummaryCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      entries: this.entries.size,
      savedAt: this.savedAt,
      lastError: this.lastError,
    }
  }

  /** 清空内存（单测用；不动磁盘文件） */
  clear(): void {
    this.entries.clear()
    this.dirty = false
  }
}

/** 跨会话聚合结果（进 activity_report 的 `crossSessions` 字段） */
export interface CrossSessions {
  /** 本次生效的会话数上限 */
  limit: number
  /** 至少出现在几个会话里才算「跨会话复现」 */
  minSessions: number
  /** 按末次时间倒序的会话汇总（每个会话一条，字段与面板口径一致） */
  sessions: SessionSummary[]
  /** 跨会话复现的失败签名（≥ minSessions 个会话；最多 20 条） */
  recurring: { sig: string; sessions: number; failures: number }[]
  cache: SummaryCacheStats
  /** 本次实际读盘 / 复用情况（证明缓存真的生效，而不是嘴上说缓存） */
  scanned: { sessions: number; read: number; reused: number; live: number; badLines: number }
  note: string
}

/**
 * 收集跨会话汇总。
 *
 * 只读**最近 limit 个会话**（`store.list()` 已按末次时间倒序）：全库聚合对「最近在哪类任务上
 * 反复低效」没有增益，却要付全部 IO。缓存命中即跳过文件读取。
 */
export function collectCrossSessions(
  store: HistoryStore,
  cache: SummaryCache,
  opts: {
    limit: number
    minSessions?: number
    /**
     * 本进程内存缓冲里的行（宿主传 `rows`）。
     * 为什么要传：落盘是异步的，刚发生的行还在内存里 —— 只看磁盘会让**当前会话**的汇总滞后
     * （冒烟实测到过：会话明明有失败，汇总却报 0 行 0 失败）。传入后按 `seq:ts` 合并（内存优先）。
     */
    liveRows?: DerivedRow[]
  },
): CrossSessions {
  const minSessions = opts.minSessions ?? 2
  const limit = Math.max(0, Math.floor(opts.limit))
  cache.load()
  // 按会话分组内存行：有内存行的会话 = 正在跑的那个会话
  const liveBySession = new Map<string, DerivedRow[]>()
  for (const r of opts.liveRows ?? []) {
    const sid = (r as { sessionId?: string | null }).sessionId
    if (sid == null) continue
    const list = liveBySession.get(String(sid)) ?? []
    list.push(r)
    liveBySession.set(String(sid), list)
  }
  const infos = store.list().slice(0, limit)
  const sessions: SessionSummary[] = []
  let read = 0
  let reused = 0
  let live = 0
  let badLines = 0
  for (const info of infos) {
    const liveRows = info.sessionId != null ? liveBySession.get(String(info.sessionId)) : undefined
    if (liveRows && liveRows.length > 0) {
      // 正在跑的会话：**不走缓存**。缓存键是磁盘文件的 (行数, lastTs)，而它的汇总还在变，
      // 用缓存就会给出滞后的数字；而且这样的会话只有一个，这点读盘成本无关紧要。
      live++
      const disk = store.rows(info.sessionId)
      badLines += disk.badLines
      sessions.push(summarizeSession(mergeActivityRows(liveRows, disk.rows as DerivedRow[]), info.sessionId))
      continue
    }
    let sum = cache.get(info.key, info.rows, info.lastTs)
    if (!sum) {
      read++
      const r = store.rows(info.sessionId)
      badLines += r.badLines
      sum = summarizeSession(r.rows as DerivedRow[], info.sessionId)
      cache.set(info.key, sum, info.rows, info.lastTs)
    } else {
      reused++
    }
    sessions.push(sum)
  }
  cache.save()
  return {
    limit,
    minSessions,
    sessions,
    recurring: recurringFailSigs(sessions, minSessions).slice(0, 20),
    cache: cache.stats(),
    scanned: { sessions: infos.length, read, reused, live, badLines },
    note: '跨会话汇总只覆盖最近 limit 个会话（按末次时间倒序）；recurring 是**同现统计**：'
      + `同一签名出现在 ≥${minSessions} 个会话里，不等于因果，也不代表任务难度相同。`,
  }
}
