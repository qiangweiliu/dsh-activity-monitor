import type { ActivityRow } from './types.js';
/** 会话 id → 文件名安全键（纯函数，可单测） */
export declare function safeSessionKey(sessionId: string | undefined | null): string;
/** JSONL 文本 → 行数组（坏行计数而不是抛错；纯函数，可单测） */
export declare function parseJsonl(text: string): {
    rows: ActivityRow[];
    badLines: number;
};
/** 单个会话文件的状态 */
export interface SessionInfo {
    /** 面板上的会话 id（global.jsonl → null） */
    sessionId: string | null;
    /** 文件名安全键（不含扩展名） */
    key: string;
    /** 已落盘行数（-1 = 尚未统计，首次 list() 时会补齐） */
    rows: number;
    lastTs: number;
    bytes: number;
    /** 已归档为 .jsonl.gz */
    archived: boolean;
    updatedAt: number;
}
export interface HistoryStats {
    appended: number;
    written: number;
    bytesWritten: number;
    pendingBytes: number;
    errors: number;
    lastError?: string;
    lastFlushAt: number;
    lastArchiveAt?: number;
    lastArchive?: ArchiveResult;
    badLines: number;
}
export interface ArchiveResult {
    scanned: number;
    archived: number;
    skipped: number;
    errors: number;
    lastError?: string;
    at: number;
}
export interface HistoryStoreOptions {
    dir: string;
    archiveAfterDays?: number;
    maxCachedSessions?: number;
}
export declare class HistoryStore {
    readonly dir: string;
    private archiveAfterDays;
    private maxCached;
    private index;
    private cache;
    private pending;
    private pendingBytes;
    private chain;
    private timer;
    private indexDirty;
    private closed;
    private counters;
    constructor(opts: HistoryStoreOptions);
    private get indexPath();
    private loadIndex;
    /** 目录扫描：登记文件的存在/字节/mtime（行数沿用索引里统计过的值，缺省 -1 = 未知） */
    private scan;
    private saveIndexSoon;
    private saveIndexNow;
    private fileOf;
    /** 入队一行（异步落盘；调用方在 llm/stream 的关键路径上，不能被磁盘阻塞） */
    append(row: ActivityRow): void;
    private pendingTotalBytes;
    private scheduleFlush;
    private flushNow;
    /** 同步刷出待写内容（进程退出/插件卸载兜底；正常路径不应调用） */
    flushSync(): void;
    /** 等待待写内容落盘（测试与优雅关闭用） */
    flush(): Promise<void>;
    close(): void;
    private parseCached;
    private touch;
    /** 读整个会话的行（按文件内顺序；优先未归档文件，其次 .jsonl.gz） */
    rows(sessionId: string | null): {
        rows: ActivityRow[];
        archived: boolean;
        badLines: number;
        tooLarge: boolean;
    };
    /** 取某一行的重体（detail/sections）—— 前端展开时才调用 */
    row(sessionId: string | null, seq: number, ts: number): {
        rev?: number;
        detail?: string;
        sections?: ActivityRow['sections'];
    } | undefined;
    /** 列表（按末次时间倒序；行数未知的会话在此补齐一次并写回索引） */
    list(): SessionInfo[];
    /**
     * 超过 archiveAfterDays 的会话文件自动 gzip 归档：写 .jsonl.gz（临时文件 + rename，
     * 保证读者只会看到完整文件）后删除原文 —— 原文并没有丢，内容完整地在 .gz 里，
     * 读取路径（rows/row）对 .jsonl.gz 透明。0 天 = 关闭。
     */
    archiveOld(now?: number): ArchiveResult;
    stats(): HistoryStats;
    private recordError;
}
