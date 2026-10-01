/**
 * dsh-activity-monitor — node 半（Host 侧）
 *
 * 监控对话运行时的所有操作，内存里维护一个活动环形缓冲：
 *  - llm/stream waterfall      → 每次模型请求（一个"轮次"）：模型名、耗时、token 用量，
 *    以及 system prompt 全文（从 messages 的 system 角色消息提取）+ 助手回复文本
 *  - tools/execute waterfall   → 每次工具调用（skill 加载、文件读写、命令执行……）
 *    从工具名+参数中归类出：skill 文件、读写文件、执行命令
 *
 * 轮次口径（面板自己维护，不取运行时的 turn 事件）：
 *   一个轮次 = 一次 agent 向模型发起的请求。轮次开始 = 请求发出（llm 占位行落下），
 *   轮次结束 = 该次模型回复完成（llm 行定稿）。轮次号 = 该会话内第 N 次模型请求。
 *   工具执行发生在两轮模型请求之间（上一轮回复里的 tool-call 被执行、结果追加进消息后
 *   才发起下一次请求），因此工具行归属「下一次」请求所在轮次（N+1），作为该轮的前置步骤。
 *
 * 所有行都走「进行中 → 定稿」两段式：调用一开始就落行（ok 缺省 = 进行中，
 * 前端按 rev 递增原地刷新）；结束时同一行补全耗时/详情/完整分段（seq/ts 不变、不新增行），
 * 定稿版本此时才写入按 session 分文件的 JSONL 历史。
 *
 * 展示约定（与浏览器半配合）：
 *  - detail 默认折叠；除非行内有 collapsed: false 标记，前端默认全部折叠
 *  - system prompt 按来源 section 拆分展示（从 systemMessageSections 记录）
 *
 * 通过 webServer 注册 /api/activity-monitor/snapshot 端点，浏览器侧板轮询读取。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ActivityRow } from './types.js';
import { type CrossSessions } from './cross.js';
export type { ActivityRow, ActivitySection } from './types.js';
export type { LightRow, MarkEntry } from './wire.js';
export { failureSig, normalizeErrorText } from './sig.js';
export { Config } from './config.js';
export declare const name = "activity-monitor";
export declare const inject: readonly ["webServer", "systemPrompt"];
export declare function apply(ctx: Context, rawConfig?: unknown): void;
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
    /**
     * 失败聚类（L1，只加不删）：按 failSig 把同类失败聚成一簇；failures 原样保留。
     * 历史行没有 failSig（那时还没这个字段），归到 `${name}|legacy|…` 的单列簇，
     * 不与真签名混算 —— 否则会凭空造出一个「重复失败」的假信号。
     */
    readonly failureClusters: {
        sig: string;
        tool: string;
        errClass: string;
        count: number;
        /** 出现过的轮次号（升序） */
        turns: number[];
        firstSeq: number;
        lastSeq: number;
        /** 最多 3 条样本 seq，供 agent 用 /row 回查正文 */
        exampleSeqs: number[];
        /** 该签名首条样本的摘要（≤120 字） */
        sampleSummary: string;
    }[];
    /** failures 被上限截断时的提示；未截断则缺省（聚类不受上限影响，始终覆盖全部失败） */
    readonly failuresTruncated?: {
        total: number;
        shown: number;
    };
    /** 验收结论行（kind === 'verdict'），按时间升序，最多 20 条 */
    readonly verdicts: {
        seq: number;
        ts: number;
        status: string;
        basis: string;
        evidenceSeqs: number[];
    }[];
    /** 最近一条验收结论；没有则缺省 */
    readonly lastVerdict?: {
        seq: number;
        ts: number;
        status: string;
        basis: string;
    };
    /**
     * 过程推断的「可能结果」——**只在没有任何验收结论时**给出，置信度固定 low。
     * 它不是验收结论：有 verdict 时字段缺省（不猜），signals 里也会显式声明这一点。
     */
    readonly likelyOutcome?: {
        label: 'likely-pass' | 'likely-fail';
        confidence: 'low';
        reasons: string[];
    };
    /**
     * 工具级「同现」统计（L3）：某工具的调用出现在**什么样的轮次**里 —— 收敛轮（该会话本范围内
     * 最后一轮）、重试轮（同轮内再次调用）、带验收结论的轮次（pass / fail）。
     * **这是同现统计、不是因果推断**（没有对照组）：只能说「工具 X 出现在通过验收的轮次 N 次」，
     * 不能说「工具 X 带来成功」。带 pass/fail 的两项依赖验收结论，没有 verdict 时恒为 0。
     * 已剔除本插件自身工具（见自我观测剔除）。
     */
    readonly toolOutcome: {
        name: string;
        calls: number;
        failed: number;
        /** 该工具行所在轮次 = 该会话（本范围内）的最后一轮 */
        inFinalTurn: number;
        /** 同一轮内该工具被再次调用（第 2 次起累加） */
        retriedInTurn: number;
        inTurnWithVerdictPass: number;
        inTurnWithVerdictFail: number;
    }[];
    /** 技能加载（tag === 'skill' 的行）；名称取自 `summary: 'skill: <name>'` */
    readonly skillLoads: {
        name: string;
        seq: number;
        ts: number;
        turn: number;
    }[];
    /**
     * 技能加载前后窗口对比（L4）。**只做前后对比，不是 A/B**：没有对照组，且窗口内任务难度
     * 也不同 —— 只能当「值得进一步验证」的线索。窗口内没有行时该项缺省（不填 0，
     * 否则看起来像「这段时间没有任何活动」）。
     */
    readonly skillEffect: {
        name: string;
        loads: number;
        windowBefore?: {
            turns: number;
            toolCalls: number;
            failedCalls: number;
            inputTokens: number;
        };
        windowAfter?: {
            turns: number;
            toolCalls: number;
            failedCalls: number;
            inputTokens: number;
        };
    }[];
    /**
     * 进化提案（L6）：agent 用 evolution_proposal 写下的提案行。**本插件只报数、不执行**：
     * 批准与执行由人通过既有执行器（dshmarket / skills-manager）完成，见 docs §10。
     * 提案状态只可能由人或显式写入推进，agent 侧工具永远只写 `proposed`。
     */
    readonly proposals: {
        seq: number;
        ts: number;
        pkind: string;
        action: string;
        target: string;
        rationale: string;
        status: string;
        by: string;
        /** 提案稳定 id（人工端点按它指回；跨重启唯一） */
        id: string;
        /** 有效状态：把追加的状态变更行算进来之后的最终状态（见 derive.effectiveProposalStatus） */
        effectiveStatus: string;
        evidenceSeqs: number[];
    }[];
    /** 待人工批准（**有效状态** === 'proposed'）的提案数 —— 只报数，不自动执行 */
    readonly pendingProposals: number;
    /**
     * L5 跨会话聚合（只在 `crossSessions` 参数下出现）：最近 N 个会话的汇总 + 跨会话复现的失败签名。
     * 缺省字段不存在 —— 没请求就不说，避免报告里出现一堆无关的空壳。
     */
    readonly crossSessions?: CrossSessions;
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
 * 人工状态变更的入参校验（纯函数，单测覆盖）：**只接受白名单状态**。
 * 状态推进是「人的动作」：agent 侧的 evolution_proposal 工具永远只写 proposed，
 * 想改状态只能走这个解析过的入口（HTTP）或显式写入。
 */
export declare function parseProposalTransition(body: unknown): {
    id?: string;
    seq?: number;
    status: 'approved' | 'rejected' | 'applied' | 'rolled-back';
    note?: string;
};
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
    /** failures 明细最多返回多少条（默认 20）；聚类不受它影响 */
    maxFailures?: number;
    /** 失败聚类的最小重复次数（默认 2，下限 2）：单次失败不成簇，避免把偶发当模式 */
    clusterMinCount?: number;
    /** 技能前后对比的窗口轮数（默认 3，下限 1）：取加载轮前后各 N 轮做指标对比 */
    skillWindowTurns?: number;
    /**
     * 「本运行」的判定基准，缺省 = 本进程 RUN_ID。
     * 报告的 totals/tools/failures/verdicts 只统计这个 runId 的行，其余单列于 history ——
     * 所以聚合别的运行（或单测里造数据）必须显式指定它，否则会被当成历史片段。
     */
    runId?: string;
    /**
     * L5 跨会话聚合结果（由宿主侧 `cross.collectCrossSessions` 算好传入 —— 本函数保持纯函数，
     * 不做任何 IO）。缺省 = 本次没有请求跨会话聚合，报告里就不出现 `crossSessions` 字段。
     */
    cross?: CrossSessions;
}): AgentReport;
