/**
 * 线协议（宿主 ↔ 浏览器半身）：轻行 / 重体拆分 + 轮次边界标记的增量日志。
 *
 * 为什么需要 v2：一次模型请求的行里带着 system prompt 全文 + 完整上下文正文 ——
 * 实测单行最大 265KB、平均 15KB，其中约 85% 是 sections 正文。而快照是高频通道
 * （流式期间 300ms 一次、每次回看尾部 30 行），等于每 300ms 重传几百 KB **定稿后
 * 几乎不再变化**的数据。协议 v2 因此把行拆成两层：
 *
 *   - 轻行（LightRow）：轮次/标签/摘要/耗时/token/上下文计数等标量字段 + hasBody 标记
 *   - 重体（body）：detail / sections，只在用户真正展开某一行时用 /row 端点按需取回
 *
 * 另一处 v1 的将就：轮次边界标记（turnStart/turnEnd）是**事后**补到已经下发过的
 * 行上的（轮次结束才给末行打 turnEnd），纯 `since` 增量拿不到这类「旧行变了」，
 * 所以 v1 客户端只能每次回看尾部 30 行。v2 改用一条 marks 日志：宿主每次改动标记
 * 就追加一条带代数（gen）的记录，客户端用 markGen 游标增量取并套用到本地行 —— 于是
 * 轮询可以退化成真正的纯增量（只发新行 + 新标记）。
 */
import type { ActivityRow } from './types.js';
/** 当前协议版本。宿主在响应里回带；客户端凭它决定能否走轻行/按需正文路径。 */
export declare const PROTOCOL = 2;
/**
 * 线协议上的轻行：能画出行、能排序、能算轮次，但没有正文。
 * 前端要正文时用 `GET /row?sessionId=&seq=&ts=` 取（hasBody=true 才有）。
 */
export interface LightRow {
    seq: number;
    ts: number;
    sessionId?: string;
    /** 产出该行的宿主进程 id（RUN_ID）：客户端用它区分本进程的行与历史文件里的行 */
    runId?: string;
    kind: 'llm' | 'tool' | 'verdict' | 'proposal';
    name: string;
    tag: string;
    summary: string;
    /** 失败签名（仅失败调用行），与 activity_report 的聚类口径一致 */
    failSig?: string;
    /** 验收结论行（kind === 'verdict'）的载荷；结论行本身轻量，不走 /row */
    verdict?: {
        status: 'pass' | 'fail' | 'partial' | 'unknown';
        basis: string;
        evidenceSeqs?: number[];
        verifyCommand?: string;
        verifySeqs?: number[];
        by: 'agent' | 'user';
        at: number;
    };
    /** 进化提案行（kind === 'proposal'）的载荷；同样不走 /row */
    proposal?: {
        pkind: 'skill' | 'plugin' | 'automation';
        action: 'create' | 'install' | 'enable' | 'disable' | 'remove' | 'other';
        target: string;
        rationale: string;
        evidenceSeqs?: number[];
        expectedEffect?: string;
        /** 验收命令原文 —— 只记录文本，本插件**不执行** */
        verifyCommands?: string[];
        rollbackPlan?: string;
        /** 只能由人造/工具显式推进：agent 侧工具永远只写 'proposed'（不允许自证已执行） */
        status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'rolled-back';
        by: 'agent' | 'user';
        at: number;
    };
    turn?: number;
    settled?: boolean;
    rev?: number;
    durationMs?: number;
    ok?: boolean;
    usageIn?: number;
    usageOut?: number;
    contextBytes?: number;
    contextMessages?: number;
    toolBytes?: number;
    contextOmitted?: number;
    promptSections?: number;
    calls?: {
        name: string;
        msgIndex: number;
        callIndex: number;
        resultMsgIndex?: number;
    }[];
    turnStart?: boolean;
    turnEnd?: boolean;
    /** 该行有可折叠正文（detail 或 sections），前端展开时才去 /row 拉 */
    hasBody: boolean;
    /** 正文分段数（展开前提示「有几段」） */
    sectionCount?: number;
}
/** 把完整行压成轻行。调用前应先合并轮次标记（标记会被原样带出）。 */
export declare function toLight(row: ActivityRow): LightRow;
/** 一段行正文（重体）：只在展开某一行时传输 */
export interface RowBody {
    seq: number;
    ts: number;
    rev?: number;
    detail?: string;
    sections?: ActivityRow['sections'];
}
/** 轮次边界标记的一条记录（gen = 第几次标记变更，客户端按它做增量游标） */
export interface MarkEntry {
    gen: number;
    seq: number;
    turnStart?: boolean;
    /** false = 清除该行的 turnEnd（标记是事后补的，撤销也必须能表达） */
    turnEnd?: boolean;
}
/** 一个 (session, turn) 的定位键 */
export declare function turnKey(sessionId: string | undefined, turn: number): string;
/**
 * 静态计算一组行的轮次边界标记（历史数据、或一次性全量响应）。
 * `isClosed(sessionId, turn)` 决定该轮是否已结束 —— 历史数据一律视为已结束。
 */
export declare function computeMarks(rows: ActivityRow[], isClosed: (sessionId: string, turn: number) => boolean): MarkEntry[];
/** 把标记套到行上（返回新对象，不改原行） */
export declare function applyMarks<T extends {
    seq: number;
    turnStart?: boolean;
    turnEnd?: boolean;
}>(rows: T[], marks: MarkEntry[]): T[];
/**
 * 轮次标记的追加日志。
 *
 * v1 的问题：标记补在已经下发过的行上，纯增量拿不到 → 客户端每轮都回看尾部 30 行。
 * 这里给每次「标记变更」发一个代数（gen），客户端回报自己见过的 gen，宿主只回增量。
 * 容量溢出时最旧的记录被丢弃；客户端发现自己的 gen 太旧（tooOld）就整段重载。
 */
export declare class MarkLog {
    private entries;
    private gen;
    private cap;
    constructor(cap?: number);
    get generation(): number;
    /** 追加一次标记变更（同一代数下可含多条） */
    bump(marks: {
        seq: number;
        turnStart?: boolean;
        turnEnd?: boolean;
    }[]): void;
    /**
     * 取 gen 之后的增量。`tooOld` = 客户端游标落在了已被丢弃的区间（它必须整段重载），
     * `reset` = 客户端游标比宿主还新（例如宿主重启过），此时要求它重开一轮增量。
     */
    since(gen: number): {
        entries: MarkEntry[];
        markGen: number;
        tooOld: boolean;
        reset: boolean;
    };
}
