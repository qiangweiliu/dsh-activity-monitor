/**
 * 活动行的数据结构（宿主半身与浏览器半身共用的词汇表）。
 *
 * 单独成文件的原因：wire.ts / history.ts / index.ts / client.tsx 都要引用它，
 * 而 index.ts 会 import 前两者 —— 类型若留在 index.ts 会形成循环依赖。
 * index.ts 仍然把它们 re-export 出去（`export type { ActivityRow, ActivitySection }`），
 * 对外 API 不变。
 */
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
    /** llm | tool | verdict | proposal（verdict = 验收结论行；proposal = 进化提案行，见下方对应字段） */
    readonly kind: 'llm' | 'tool' | 'verdict' | 'proposal';
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
    /**
     * 失败签名（仅失败调用行）：`工具名|错误类别|归一化错误首行`。
     * 必须在 `tools/execute` 钩子内当场算 —— 那里才拿得到结构化错误
     * （result.isError / err.message）；事后从 detail 那段「参数+结果」散文里反解会脆。
     * 供 activity_report 把同类失败聚成一簇。历史行没有该字段，报告侧单列 legacy 簇。
     */
    failSig?: string;
    /**
     * 任务验收结论（kind === 'verdict' 的行）：由 agent 通过本插件的 task_verdict 工具写入。
     *
     * 两个刻意的取舍（改动前先读 docs/agent-evolution-data.md §4.2）：
     *  - 不用 `ok:false` 表达「验收失败」：报告与面板的 failedCalls 口径是
     *    「任意 kind 的 ok === false」，复用 ok 会把失败计数与失败告警一起污染。
     *  - verdict 行不带 durationMs：报告的 durationMs 是跨 kind 求和的（只过滤 settled）。
     */
    verdict?: {
        status: 'pass' | 'fail' | 'partial' | 'unknown';
        /** 结论依据（一句话事实，agent 自述；可能含路径/命令，敏感度同 detail） */
        basis: string;
        /** 作为证据的工具行 seq（agent 用普通工具跑验收命令时留下的那些行） */
        evidenceSeqs?: number[];
        /** 验收命令原文 —— 只记录文本，本插件不执行任何命令 */
        verifyCommand?: string;
        /** 上述验收命令对应的工具行 seq */
        verifySeqs?: number[];
        /** 结论来源：agent 自报 / 人工回填 */
        by: 'agent' | 'user';
        at: number;
    };
    /**
     * 进化提案（kind === 'proposal' 的行）：由 agent 通过本插件的 evolution_proposal 工具写入。
     *
     * 定位（docs/agent-evolution-data.md §10）：**本插件只写提案，不执行任何变更** —— 不装插件、
     * 不建 skill、不重启。执行由人批准后走既有执行器（dshmarket / skills-manager）。
     * 与 verdict 同样的两条纪律：不用 `ok:false` 表达「提案被否决」，不带 durationMs。
     */
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
    /** 原始 token 用量（llm 行；缺省 = provider 未回报） */
    usageIn?: number;
    usageOut?: number;
    /** 发给模型的上下文规模（llm 行）：上下文字节数 / 消息条数 / 工具清单字节 */
    contextBytes?: number;
    contextMessages?: number;
    toolBytes?: number;
    /** 该请求因超预算被整条省略的消息数（>0 = 模型没看到完整上下文） */
    contextOmitted?: number;
    /** 本次请求的提示词分段数（llm 行；前端做跨轮差异与信号展示用） */
    promptSections?: number;
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
