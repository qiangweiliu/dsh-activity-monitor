import type { Context } from '@deepseek-ai/cordis';
export declare const name = "activity-monitor";
export declare const inject: readonly ["webServer", "systemPrompt"];
/** `sections` 中的一段详情：key 非空 → 前端二级折叠（提示词段落），无 key 的默认展开（用户消息/回复） */
export interface ActivitySection {
    title: string;
    body: string;
    /** 分段标识；非空表示前端默认折叠、点击标题才展开 */
    key?: string;
    /** 分组标题行：它下面 parent 指向本段 key 的子段在界面上缩进，且整组默认收起 */
    isGroup?: boolean;
    /** 所属分组标题的 key（配合 isGroup 使用） */
    parent?: string;
    /** 正文里各消息块在 body 中的起始偏移（渲染时按它切分，供组内按「第 n 条消息」跳转定位；正文本身不加标记） */
    anchorOffsets?: number[];
}
/** 单条活动记录 */
export interface ActivityRow {
    readonly seq: number;
    readonly ts: number;
    /** 所属会话 id（dsh SessionId），便于区分多会话 */
    readonly sessionId?: string;
    /** llm | tool */
    readonly kind: 'llm' | 'tool';
    /** 模型名或工具名 */
    readonly name: string;
    /** 归类标签：skill / file-read / file-write / command / tool / llm */
    readonly tag: string;
    /** 单行摘要（文件名、命令行、skill 名等） */
    readonly summary: string;
    /** 详情：前端一律默认折叠，点开才显示（不再自动展开） */
    detail?: string;
    /** 多段详情：key 非空的段在前端二级折叠（提示词段落），无 key 的默认展开（用户消息/回复） */
    sections?: ActivitySection[];
    /**
     * 本次请求所在轮次号（该会话内 agent 发起的第 N 次模型请求，从 1 起）。
     * 一个轮次 = 一次模型请求（agent 发消息给大模型 → 大模型回复完成）；
     * 工具执行发生在两轮之间，归属下一次请求所在轮次。
     * 不属于任何请求行的（理论上没有；标题生成等无 sessionId 的也按最近会话发号）
     */
    turn?: number;
    /**
     * 本次请求里模型发起的工具调用及其在「完整上下文」中的位置：
     * msgIndex = 第几条消息（0 基，与界面上 [n] 一致）、callIndex = 该消息内第几个 tool-call（1 起）、
     * resultMsgIndex = 对应工具结果所在消息下标（工具结果还没回来时缺省）。
     * 前端据此把「工具行」对回消息序列里的位置。
     */
    calls?: {
        name: string;
        msgIndex: number;
        callIndex: number;
        resultMsgIndex?: number;
    }[];
    /** 定稿标记：缺省/true = 已结束；false = 该行仍在进行中（调用还没结束） */
    readonly settled?: boolean;
    durationMs?: number;
    ok?: boolean;
    /** 原始 token 用量（llm 行；缺省 = provider 未回报） */
    usageIn?: number;
    usageOut?: number;
    /** 发给模型的上下文规模（llm 行）：上下文字节数 / 消息条数 / 工具清单字节 */
    contextBytes?: number;
    contextMessages?: number;
    toolBytes?: number;
    /** 该请求因超预算被整条省略的消息数（>0 = 模型没看到完整上下文） */
    contextOmitted?: number;
    /**
     * 行版本：同 seq/ts 的行在「进行中 → 定稿」之间原地刷新，rev 随每次刷新递增；
     * 前端用它判断该行是否真的变了（变了才重渲染），不再依赖字段对比。
     */
    rev?: number;
    /**
     * 所属进程运行 id：每个 dsh 进程 boot 时生成一个唯一号，随 JSONL 落盘。
     * seq / turn 都是「每进程」计数器，进程一重启就归零，历史 JSONL 跨重启合并后
     * 不同运行的编号会重叠（旧片段 seq 8/7 撞上新片段 seq 1/3）。runId 用来把
     * 数据按运行切分：agent 报告据此区分「本运行」与「跨重启的历史运行」，绝不混算。
     */
    runId?: string;
}
export declare function apply(ctx: Context): void;
/**
 * 面向 agent 的监控统计报告。给 agent 提供「自查信号」：
 * 调用量 / token / 耗时、各工具调用频次与失败、上下文压力（相对预算、是否截断），
 * 以及一组**陈述性**信号（signals）——只陈述观察到的事实与阈值判断，不替 agent 决策，
 * agent 据此自行判断是否换路 / 压缩 / 重开会话 / 降低重复。
 */
export interface AgentReport {
    readonly sessionId: string | null;
    readonly generatedAt: number;
    /** 取数范围描述（全量 / 最近 N 轮；跨重启时标注「本运行」） */
    readonly scope: string;
    /** 本运行 id（进程 boot 生成）；历史 JSONL 里重启前的行带各自的旧 runId 或无 */
    readonly runId: string;
    /** 数据是否跨多个进程运行（重启前后合并）；true 时 totals/tools/context 只反映本运行，历史单列于 history */
    readonly crossRun: boolean;
    readonly totals: {
        llmCalls: number;
        toolCalls: number;
        failedCalls: number;
        /** 本运行内的轮次数（seq/turn 都是每进程计数器，跨重启不续号，故只数本运行） */
        turns: number;
        inFlight: number;
        inputTokens: number;
        outputTokens: number;
        /** 活跃调用耗时之和（已定稿 llm+tool 行 durationMs 累加；进行中调用未定稿不计入） */
        durationMs: number;
        /** 本运行首→末事件的墙钟跨度（含空闲等待，≈ 会话实际时间轴；与 durationMs 口径不同） */
        spanMs: number;
    };
    readonly tools: {
        byName: {
            name: string;
            count: number;
            failed: number;
            avgMs: number;
            lastMs: number;
        }[];
        /** 达到重复阈值的工具（按次数降序） */
        duplicated: {
            name: string;
            count: number;
            failed: number;
        }[];
    };
    readonly failures: {
        seq: number;
        ts: number;
        kind: string;
        name: string;
        summary: string;
    }[];
    readonly context: {
        lastTurn?: number;
        lastContextBytes?: number;
        lastContextMessages?: number;
        budgetBytes: number;
        /** 预算口径说明：这是「监控截断预算」，不是模型真实上下文窗口 */
        budgetLabel: string;
        /** 最后请求上下文占监控预算比（可 >1 = 已超）；只反映监控缓冲，不代表真实余量 */
        pressure?: number;
        truncated: boolean;
        note?: string;
    };
    /** 进行中（未定稿）调用；本报告的生成调用（activity_report）自身已剔除。startedAt=该调用发起时刻 */
    readonly inFlight: {
        seq: number;
        ts: number;
        kind: string;
        name: string;
        summary: string;
        startedAt: number;
    }[];
    readonly signals: {
        severity: 'info' | 'warn';
        text: string;
    }[];
    /** 说明本次 activity_report 调用本身在取数时进行中，已从 inFlight 计数中剔除 */
    readonly selfNote?: string;
    /** 跨重启的历史运行数据（本运行之外的片段），单列不并入 totals；无历史则缺省 */
    readonly history?: {
        runs: {
            runId: string;
            rows: number;
            firstTs: number;
            lastTs: number;
            llmCalls: number;
            toolCalls: number;
            failedCalls: number;
        }[];
    };
    /** 本运行范围内最近若干条行（按时间倒序），供 agent 看明细 */
    readonly latest: {
        seq: number;
        ts: number;
        kind: string;
        name: string;
        tag: string;
        summary: string;
        ok?: boolean;
        turn?: number;
    }[];
}
/**
 * 纯聚合：从活动行生成 agent 报告。只陈述事实 + 阈值判断，不替 agent 下决策。
 * 阈值可调（dupThreshold / failingThreshold / pressureThreshold），缺省 3 / 2 / 0.8。
 */
export declare function buildAgentReport(input: {
    rows: ActivityRow[];
    sessionId: string | null;
    contextBudgetBytes: number;
    /** 只统计最近 N 个轮次（按 turn 分组取编号最大的 N）；缺省 = 全量 */
    recentTurns?: number;
    dupThreshold?: number;
    failingThreshold?: number;
    pressureThreshold?: number;
}): AgentReport;
