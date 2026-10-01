import { type DerivedRow, type SessionSummary } from './derive.js';
import type { HistoryStore } from './history.js';
/** 缓存文件格式版本（形状变更时递增；版本不符 = 当作没有缓存重建） */
export declare const SUMMARIES_VERSION = 1;
/** 缓存的可观测状态（进 /selfcheck 与报告，避免缓存成为黑盒） */
export interface SummaryCacheStats {
    hits: number;
    misses: number;
    errors: number;
    entries: number;
    savedAt: number;
    lastError?: string;
}
/**
 * 会话汇总的磁盘缓存。键 = 会话文件安全键（`SessionInfo.key`）。
 * 内存上限 maxEntries：超了按 lastTs 丢最旧的（本机 15 会话量级，纯属兜底）。
 */
export declare class SummaryCache {
    /** 缓存文件绝对路径（与历史 JSONL 同目录） */
    readonly file: string;
    private readonly maxEntries;
    private entries;
    private hits;
    private misses;
    private errors;
    private lastError;
    private dirty;
    private savedAt;
    private loaded;
    constructor(
    /** 缓存文件绝对路径（与历史 JSONL 同目录） */
    file: string, maxEntries?: number);
    /** 从磁盘载入（可重复调用；只在首次真正读盘）。坏文件/缺文件 = 空缓存，不抛。 */
    load(): void;
    /** 命中返回汇总；未命中返回 undefined 并记一次 miss（调用方去读文件重算） */
    get(key: string, rows: number, lastTs: number): SessionSummary | undefined;
    set(key: string, sum: SessionSummary, rows: number, lastTs: number): void;
    /** 原子写盘（临时文件 + rename，读者只会看到完整文件）；只在有变更时写，失败只计数 */
    save(): boolean;
    stats(): SummaryCacheStats;
    /** 清空内存（单测用；不动磁盘文件） */
    clear(): void;
}
/** 跨会话聚合结果（进 activity_report 的 `crossSessions` 字段） */
export interface CrossSessions {
    /** 本次生效的会话数上限 */
    limit: number;
    /** 至少出现在几个会话里才算「跨会话复现」 */
    minSessions: number;
    /** 按末次时间倒序的会话汇总（每个会话一条，字段与面板口径一致） */
    sessions: SessionSummary[];
    /** 跨会话复现的失败签名（≥ minSessions 个会话；最多 20 条） */
    recurring: {
        sig: string;
        sessions: number;
        failures: number;
    }[];
    cache: SummaryCacheStats;
    /** 本次实际读盘 / 复用情况（证明缓存真的生效，而不是嘴上说缓存） */
    scanned: {
        sessions: number;
        read: number;
        reused: number;
        live: number;
        badLines: number;
    };
    note: string;
}
/**
 * 收集跨会话汇总。
 *
 * 只读**最近 limit 个会话**（`store.list()` 已按末次时间倒序）：全库聚合对「最近在哪类任务上
 * 反复低效」没有增益，却要付全部 IO。缓存命中即跳过文件读取。
 */
export declare function collectCrossSessions(store: HistoryStore, cache: SummaryCache, opts: {
    limit: number;
    minSessions?: number;
    /**
     * 本进程内存缓冲里的行（宿主传 `rows`）。
     * 为什么要传：落盘是异步的，刚发生的行还在内存里 —— 只看磁盘会让**当前会话**的汇总滞后
     * （冒烟实测到过：会话明明有失败，汇总却报 0 行 0 失败）。传入后按 `seq:ts` 合并（内存优先）。
     */
    liveRows?: DerivedRow[];
}): CrossSessions;
