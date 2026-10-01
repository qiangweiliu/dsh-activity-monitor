/**
 * 面板的派生数据（纯函数，无 React、无 DOM）—— 单独成模块是为了可单测。
 *
 * 这些计算原本散在客户端组件里，只能靠肉眼看界面验证；抽出来之后 node:test 直接跑
 * （tests/derive.test.js 引 lib/derive.js），信号 / 跨轮差异 / 导出的口径也就钉住了。
 * 所有函数只吃「行」这一种数据，宿主行与浏览器本地行的结构一致（见 types.ts / wire.ts）。
 */
/** 这些派生函数实际用到的字段（结构化类型：宿主 ActivityRow 与客户端本地 Row 都满足） */
export interface DerivedRow {
    seq: number;
    ts: number;
    sessionId?: string;
    kind: 'llm' | 'tool' | 'verdict' | 'proposal';
    name: string;
    failSig?: string;
    verdict?: {
        status: string;
        basis: string;
        evidenceSeqs?: number[];
        by?: string;
    };
    proposal?: {
        pkind: string;
        action: string;
        target: string;
        status: string;
        evidenceSeqs?: number[];
        id?: string;
        transitionOf?: number;
    };
    tag: string;
    summary: string;
    turn?: number;
    durationMs?: number;
    ok?: boolean;
    settled?: boolean;
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
}
/** 字节数的可读形式（与宿主侧同口径：>=1KB 用 KB 保留一位） */
export declare function fmtBytes(n: number): string;
/**
 * 「与上一轮相比」的一行差异摘要（上下文膨胀 / 提示词变多 / 工具变多）。
 * 只比较轻行上就有的字段：消息数、上下文字节、提示词分段数、本轮发起的调用数。
 */
export declare function contextDiff(prev: DerivedRow | undefined, cur: DerivedRow): string;
/** 轮次级信号（面板上直接可见的告警，口径与 agent 侧 activity_report 的 signals 一致） */
export interface TurnSignal {
    severity: 'info' | 'warn';
    text: string;
}
/** 一个轮次的信号：重复调用 / 失败 / 上下文被截断 / 长耗时 / 仍在进行 */
export declare function turnSignals(rows: DerivedRow[]): TurnSignal[];
/** 会话级汇总（顶栏/底栏与导出用） */
export interface SessionTotals {
    turns: number;
    llmCalls: number;
    toolCalls: number;
    failedCalls: number;
    inFlight: number;
    inputTokens: number;
    outputTokens: number;
    maxContextBytes: number;
    maxContextTurn?: number;
    contextOmitted: number;
    /** 工具频次（按次数降序） */
    toolFrequency: {
        name: string;
        count: number;
    }[];
    /** skill 加载次数（按 name 聚合） */
    skills: {
        name: string;
        count: number;
    }[];
}
export declare function sessionTotals(rows: DerivedRow[]): SessionTotals;
/**
 * 把一批行导出成 Markdown（面板上「复制本轮 / 复制会话」用）。
 * 只导出轻行上就有的信息：时间、类型、名称、摘要、耗时、token、上下文规模与信号。
 * 正文（提示词 / 工具输出）不导出 —— 那是另一件事（体积大、也可能含敏感内容），
 * 需要时在界面上展开逐行看。
 */
export declare function rowsToMarkdown(rows: DerivedRow[], title?: string): string;
/** 导出的会话 JSON（保持与宿主落盘行一致的结构，便于二次处理） */
export declare function rowsToJson(rows: DerivedRow[], meta?: Record<string, unknown>): string;
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
export declare function effectiveProposalStatus(rows: {
    seq: number;
    ts: number;
    sessionId?: string;
    proposal?: any;
}[]): Map<string, {
    status: string;
    ts: number;
    seq: number;
    by: string;
}>;
