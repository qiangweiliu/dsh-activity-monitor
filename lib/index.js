import { resolveConfig } from './config.js';
import { HistoryStore } from './history.js';
import { MarkLog, PROTOCOL, applyMarks, computeMarks, mergeActivityRows, toLight, turnKey } from './wire.js';
import { failureSig, normalizeErrorText } from './sig.js';
import { effectiveProposalStatus } from './derive.js';
import { join } from 'node:path';
import { SummaryCache, collectCrossSessions } from './cross.js';
// 失败签名/归一化是纯函数，单独成模块（sig.ts）以便单测直接引 lib/sig.js；
// 这里再导出一份，维持「index.js 是宿主半身唯一出口」的既有约定。
export { failureSig, normalizeErrorText } from './sig.js';
// cordis 读的配置声明（Standard Schema；解析/默认值/失败软着陆都在 config.ts）
export { Config } from './config.js';
export const name = 'activity-monitor';
export const inject = ['webServer', 'systemPrompt'];
// 数据结构（ActivityRow / ActivitySection）已移到 types.ts，见文件头的 re-export
/**
 * 本进程运行 id：boot 时生成一次（时间戳 + 随机后缀，足以区分同机不同实例）。
 * 随每行落盘，agent 报告据此把「本运行」与「跨重启的历史运行」切开，避免把
 * 两个进程里各自 1..N 的 seq/turn 编号当成一套连续编号。历史 JSONL 里没有
 * 该字段的旧行视为「未知/重启前」运行。
 * 面板侧也用它判断宿主是否重启过 —— 重启后 seq 从头开始，客户端若继续拿旧游标
 * 拉增量会永远拉不到新行（表现为「面板卡住不动」）。
 */
const RUN_ID = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
export function apply(ctx, rawConfig) {
    // 配置解析（失败软着陆：非法项退回默认值并记进 cfg.issues，绝不因此拒绝加载）
    const cfg = resolveConfig(rawConfig);
    // 把预算推给模块级纯函数（buildContextSections / buildAgentReport 不持有 ctx，理由见该常量注释）
    CONTEXT_BUDGET_BYTES = cfg.contextBudgetBytes;
    ctx.logger.info('[activity-monitor] starting');
    if (cfg.issues.length) {
        ctx.logger.warn(`[activity-monitor] 配置有 ${cfg.issues.length} 项被修正/忽略：${cfg.issues.join('；')}`);
    }
    let seq = 0;
    const rows = [];
    /** 轮次边界标记的增量日志（协议 v2：客户端按 markGen 游标取增量，不再回看尾部 N 行） */
    const markLog = new MarkLog(cfg.markLogCap);
    /** 历史落盘：异步串行队列 + 索引 + 归档（见 history.ts 文件头的三个实测动机） */
    const store = new HistoryStore({
        dir: cfg.history.dir,
        archiveAfterDays: cfg.history.archiveAfterDays,
        maxCachedSessions: cfg.history.maxCachedSessions,
    });
    // 卸载兜底：待写缓冲里可能还有几百 KB 没落盘，close() 会同步刷出去
    ctx.effect(() => () => { store.close(); }, 'activity-monitor: history store');
    /**
     * L5 跨会话汇总缓存（summaries.json，与历史同目录）。
     * 缓存键 = (行数, lastTs)：文件没长就直接复用 —— 否则每次 activity_report(crossSessions) 都要
     * 把全库 JSONL 读一遍。缓存坏了/缺了只当「没有缓存」重建，绝不影响报告本身（见 cross.ts 文件头）。
     */
    const summaryCache = new SummaryCache(join(cfg.history.dir, 'summaries.json'));
    const self = { startedAt: Date.now(), requests: 0, badRequests: 0, endpointErrors: 0, rowBodyHits: 0, rowBodyMisses: 0 };
    function noteError(e) {
        self.endpointErrors++;
        self.lastError = e instanceof Error ? e.message : String(e);
    }
    // ── 轮次跟踪（面板自维护，不取运行时 turn 事件） ──
    // 轮次口径：一个轮次 = agent 向模型发起的一次请求。
    //   轮次开始 = 请求发出（llm 占位行落下，发号 turnsIssued+1）；
    //   轮次结束 = 该次模型回复完成（llm 行定稿，closedTurns 记一笔）。
    // 工具执行发生在两轮请求之间（上一轮回复里的 tool-call 被执行完，结果追加进消息后
    // 才发起下一次请求），所以工具行归属「下一次」请求的轮次号（upcoming = turnsIssued+1），
    // 作为该轮的前置步骤。
    const turnsIssued = new Map(); // sessionId → 已发出的请求（轮次）数
    const closedTurns = new Map(); // sessionId → 已结束（模型回复完成）的轮次号
    let lastTurnSession; // 兜底：行没有 sessionId 时沿用最近一次请求所属会话
    /** 每个 (session, turn) 的首/末行 seq —— 给轮次边界标记定位用（不必每次全表扫） */
    const turnFirst = new Map();
    const turnLast = new Map();
    /** upcoming 轮次号：工具行（在请求之间执行）归属的轮次 */
    function turnFor(sessionId) {
        const sid = sessionId ?? lastTurnSession;
        if (!sid)
            return undefined;
        return (turnsIssued.get(sid) ?? 0) + 1;
    }
    /** 该轮是否已结束（模型回复已定稿） */
    function isTurnClosed(sessionId, turn) {
        return closedTurns.get(sessionId)?.has(turn) ?? false;
    }
    /**
     * 记「一行进了某个轮次」，并按需补/搬 turnEnd 标记：
     *  - 该轮第一次出现 → 补 turnStart
     *  - 该轮已结束却又来了一行（工具结果、兜底发号等）→ 末行标记搬到新行，旧行显式清除
     * 这正是协议 v2 用 marks 日志取代「每次回看尾部 30 行」的地方：标记是**事后**补的，
     * 纯增量轮询拿不到「已下发过的旧行变了」，所以每次变更都发一个代数（gen）给客户端增量取。
     */
    function noteRowInTurn(sessionId, turn, rowSeq) {
        if (!turn)
            return;
        const k = turnKey(sessionId, turn);
        const prevLast = turnLast.get(k);
        const isFirst = !turnFirst.has(k);
        if (isFirst)
            turnFirst.set(k, rowSeq);
        turnLast.set(k, rowSeq);
        const patch = [];
        if (isFirst)
            patch.push({ seq: rowSeq, turnStart: true });
        if (isTurnClosed(sessionId ?? '', turn) && prevLast !== undefined && prevLast !== rowSeq) {
            patch.push({ seq: rowSeq, turnEnd: true });
            patch.push({ seq: prevLast, turnEnd: false });
        }
        markLog.bump(patch);
    }
    /** 给某 (session, turn) 记「已结束」，并把 turnEnd 标到该轮末行 */
    function closeTurn(sessionId, turn) {
        let set = closedTurns.get(sessionId);
        if (!set) {
            set = new Set();
            closedTurns.set(sessionId, set);
        }
        if (set.has(turn))
            return;
        set.add(turn);
        const last = turnLast.get(turnKey(sessionId, turn));
        if (last !== undefined)
            markLog.bump([{ seq: last, turnEnd: true }]);
    }
    /**
     * 已落盘的逻辑行键（首次 record 时的 seq:ts）：同一逻辑行只写一次 JSONL。
     * 挤出缓冲后 updateRow 会重排 seq（新 seq 作内存键），但逻辑键不变 —— 去重按逻辑键。
     * 集合只增不减会在长会话里单调泄漏，超过上限就整批清掉（最坏情形是同一行重复落盘一次，
     * 客户端按 seq:ts 去重后无感）。
     */
    const persistedKeys = new Set();
    const PERSIST_KEY_CAP = 20_000;
    function persist(full, logicKey) {
        const k = logicKey ?? `${full.seq}:${full.ts}`;
        if (persistedKeys.has(k))
            return;
        persistedKeys.add(k);
        if (persistedKeys.size > PERSIST_KEY_CAP)
            persistedKeys.clear();
        // 异步串行队列落盘（history.ts）：v1 在这里 appendFileSync，一行的体积平均 15KB、
        // 最坏 265KB，等于每次模型回复收尾都同步阻塞一次事件循环。
        store.append(full);
    }
    /**
     * 追加内存行 + 落盘历史（按 session 分文件）。
     * 两段式「进行中 → 定稿」：
     *  - 进行中占位行（settled: false）只进内存缓冲（snapshot 端点可读到「进行中」状态），
     *    不写 JSONL —— 进行中的内容持续增长，逐次落盘既撑爆文件，也会让历史端点读到半成品行。
     *  - 定稿行（settled 非 false）进缓冲并写 JSONL 历史。
     * 调用方拿回生成的行（带 seq/ts/rev），结束时交给 updateRow() 原地刷新同一行。
     */
    function record(row) {
        const settled = row.settled !== false;
        const base = { ...row, turn: row.turn ?? turnFor(row.sessionId), seq: 0, ts: 0 };
        base.seq = ++seq;
        base.ts = Date.now();
        base.settled = settled;
        base.rev = 0;
        base.runId = RUN_ID;
        const full = base;
        rows.push(full);
        if (rows.length > cfg.maxRows)
            rows.splice(0, rows.length - cfg.maxRows);
        noteRowInTurn(full.sessionId, full.turn, full.seq);
        if (settled)
            persist(full);
        return full;
    }
    /**
     * 原地刷新一个进行中的占位行（进行中 → 定稿，或占位行内容增量更新）：
     * seq/ts 保持不变、rev+1、settled/其余字段覆盖。若该行已被环形缓冲挤出（超长会话），
     * 定稿版本按新行补一条（seq 重排没关系，ts 仍是真实时间戳）。
     */
    function updateRow(existing, patch) {
        const settled = patch.settled !== false;
        const idx = rows.findIndex((r) => r.seq === existing.seq && r.ts === existing.ts);
        const base = idx >= 0 ? rows[idx] : existing;
        const next = { ...base, ...patch, settled };
        if (idx >= 0) {
            ;
            next.rev = (base.rev ?? 0) + 1;
            rows[idx] = next;
        }
        else {
            ;
            next.seq = ++seq;
            next.rev = 0;
            rows.push(next);
            if (rows.length > cfg.maxRows)
                rows.splice(0, rows.length - cfg.maxRows);
            // 被挤出后又补一条：这条新行也要重新进轮次的首次/末次登记
            noteRowInTurn(next.sessionId, next.turn, next.seq);
        }
        if (settled)
            persist(next);
        return next;
    }
    /**
     * 给要下发的行补轮次边界标记并压成轻行（协议 v2）。
     * 标记先在**全量**行上算（all），再套到目标行（target）—— 首/末行的判定不能被会话过滤
     * 或分页截断改变：末行可能根本不在这批里，而它的标记已经进了 marks 日志。
     * v1 的做法是直接把 turnStart/turnEnd 写进每条下发行的 `any[]` 里，且必须整表重算。
     */
    function lightRows(all, target) {
        return applyMarks(target.map(toLight), computeMarks(all, isTurnClosed));
    }
    /** 历史行的标记：历史一律视为「已结束」，同一套计算保证与实时口径一致 */
    function historyLightRows(all, target) {
        return applyMarks(target.map(toLight), computeMarks(all, () => true));
    }
    /** 统一 JSON 响应（快照/详情/配置/自检共用） */
    function sendJson(res, body, code = 200) {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }
    /** 参数不合法：记进 self.badRequests（排查客户端与我方协议不一致） */
    function sendBadRequest(res, text) {
        self.badRequests++;
        sendJson(res, { v: PROTOCOL, error: text }, 400);
    }
    /** skill name → 文件路径缓存（skill 工具调用时填充；也定期刷新清单） */
    const skillPaths = new Map();
    async function refreshSkillPaths() {
        try {
            const skills = ctx.skills;
            if (!skills?.list)
                return;
            for (const s of await skills.list()) {
                if (s.path)
                    skillPaths.set(s.name, s.path);
            }
        }
        catch { /* skills 服务不可用时静默 */ }
    }
    void refreshSkillPaths();
    const skillsTimer = setInterval(() => { void refreshSkillPaths(); }, 10_000);
    ctx.effect(() => () => clearInterval(skillsTimer), 'activity-monitor: skill path refresher');
    /** 最新一次 assemble 的结果缓存（后台定期刷新，避免在 waterfall 栈内死锁） */
    let cachedSections;
    let cachedContexts;
    // 关键：捕获 systemPrompt 服务的直接引用（fiber 上下文在插件卸载后失效）
    const sp = ctx.systemPrompt;
    async function cacheAssembly() {
        try {
            const assembly = await sp?.assemble?.();
            if (assembly?.sections) {
                cachedSections = assembly.sections;
                cachedContexts = assembly.contexts;
            }
        }
        catch { /* 静默 */ }
    }
    // 首次刷新延迟到挂载完成后（apply 内同步 assemble 会死锁）
    const firstRefresh = setTimeout(() => { void cacheAssembly(); }, 500);
    const assemblyTimer = setInterval(() => { void cacheAssembly(); }, 2000);
    ctx.effect(() => () => { clearTimeout(firstRefresh); clearInterval(assemblyTimer); }, 'activity-monitor: assembly cache refresher');
    /** 从注册名推断 section 来源描述 */
    function describeSectionSource(name) {
        // dsh 官方 section：harness:identity / deployment:persona-prefix / dsh-tool-bash:…
        if (name.startsWith('harness:'))
            return '（dsh 内置）';
        if (name.startsWith('deployment:'))
            return '（部署 persona 配置）';
        const m = name.match(/^dsh-([a-z-]+):/);
        if (m)
            return `（dsh 官方插件 @deepseek-ai/dsh-${m[1]}）`;
        const skill = name.match(/^skill:(.+)$/);
        if (skill) {
            const p = skillPaths.get(skill[1]);
            return p ? `（skill 文件 ${p}）` : `（skill ${skill[1]}）`;
        }
        return '';
    }
    /** 从工具名+参数归类出活动标签和摘要 */
    function classify(toolName, args) {
        const a = args ?? {};
        switch (toolName) {
            case 'skill':
                return { tag: 'skill', summary: `skill: ${a.name ?? '?'}` };
            case 'read':
            case 'view':
            case 'view_file':
            case 'view_file_range':
                return { tag: 'file-read', summary: String(a.path ?? a.file_path ?? a.abs_path ?? '?') };
            case 'write':
            case 'str_replace_editor':
            case 'str_replace_based_edit_tool':
            case 'edit':
            case 'write_file':
                return { tag: 'file-write', summary: String(a.path ?? a.file_path ?? '?') };
            case 'bash':
            case 'bash_persistent':
            case 'pwsh':
            case 'pwsh_persistent':
                return { tag: 'command', summary: String(a.command ?? a.cmd ?? '').split('\n')[0].slice(0, 160) };
            default: {
                const pathLike = a.path ?? a.file_path ?? a.abs_path;
                if (typeof pathLike === 'string')
                    return { tag: 'file-read', summary: `${toolName}: ${pathLike}` };
                return { tag: 'tool', summary: toolName };
            }
        }
    }
    // ── 工具调用监控 ──
    // 两段式：开始执行就落「进行中」占位行（只有参数、无结果），
    // 结束后 updateRow 原地刷成定稿（补结果/耗时/ok）。长命令执行中面板就能看见它。
    ctx.on('tools/execute', async (exec, next) => {
        const args = exec.arguments ?? exec.args ?? {};
        const { tag, summary } = classify(exec.name, args);
        // 工具调用所属会话（agent loop 执行时携带）
        const sessionId = exec.agent?.session?.id
            ? String(exec.agent.session.id)
            : undefined;
        const start = Date.now();
        const common = {
            kind: 'tool',
            sessionId,
            name: exec.name,
            tag,
            summary,
        };
        // 占位：进行中（参数已可见；结果未回）。seq/ts 由 record 生成，定稿时原样传回
        const pending = record({
            ...common,
            settled: false,
            detail: [
                '── 参数 ──',
                clampText(JSON.stringify(args, null, 2), cfg.toolDetailBudgetBytes),
                '── 结果 ──',
                '（执行中…）',
            ].join('\n'),
        });
        try {
            const result = await next();
            // 提取结果文本：result.content 里 TextBlock 的 text
            const content = result?.content;
            let resultText = '';
            if (Array.isArray(content)) {
                resultText = content
                    .filter((b) => b?.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
            }
            if (!resultText) {
                const v = result?.value;
                if (v != null)
                    resultText = typeof v === 'string' ? v : JSON.stringify(v);
            }
            const isErr = !!result?.isError;
            if (isErr) {
                resultText = resultText || String(result?.error?.message ?? '');
            }
            updateRow(pending, {
                ...common,
                durationMs: Date.now() - start,
                ok: !isErr,
                // 失败签名在钩子内当场算：这里才拿得到结构化错误（isError / error.message）。
                // 事后从 detail 那段「参数 + 结果」散文里反解会脆（还带预算截断），见 docs §3.1。
                ...(isErr ? { failSig: failureSig(exec.name, resultText ? 'error' : 'no-output', resultText) } : {}),
                // 默认折叠；参数与结果都不再按 3000 字截断，只受总量上限保护（超出会标注）
                detail: [
                    '── 参数 ──',
                    clampText(JSON.stringify(args, null, 2), cfg.toolDetailBudgetBytes),
                    '── 结果 ──',
                    resultText
                        ? clampText(resultText, cfg.toolDetailBudgetBytes)
                        : '（工具未返回文本结果）',
                ].join('\n'),
            });
            return result;
        }
        catch (err) {
            updateRow(pending, {
                ...common,
                durationMs: Date.now() - start,
                ok: false,
                // 抛异常与 isError 是两类失败：用 errClass 区分，别把两类失败聚成一簇
                failSig: failureSig(exec.name, 'exception', String(err?.message ?? err)),
                detail: [
                    '── 参数 ──',
                    JSON.stringify(args, null, 2),
                    '── 异常 ──',
                    String(err?.message ?? err).slice(0, 2000),
                ].join('\n'),
            });
            throw err;
        }
    });
    // ── 模型请求监控 ──
    // 两段式：请求发起就落「进行中」占位行（模型名 + 请求规模可见）；
    // 流式 delta 到达时按 ~150ms 节流原地刷新（摘要里的字数控件 + 回复预览实时增长）；
    // 流结束时 updateRow 定稿（完整分段 + 真实耗时 + usage + 工具调用位置）。
    ctx.on('llm/stream', async function* (options, next) {
        const start = Date.now();
        let usage = '';
        /** 原始 token 用量（供 agent 报告聚合求和） */
        let usageTokens;
        let replyText = '';
        let reasoningText = '';
        let failed = false;
        let lastLiveUpdate = 0;
        // 提取 system prompt（提示词本体）
        const systemMsg = options.messages?.find((m) => m?.role === 'system');
        const systemText = systemMsg?.content
            ? (Array.isArray(systemMsg.content)
                ? systemMsg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
                : String(systemMsg.content))
            : '';
        // 最后一条用户消息（对话内容）
        const userMessages = options.messages?.filter((m) => m?.role === 'user') ?? [];
        const lastUser = userMessages[userMessages.length - 1];
        const lastUserText = lastUser?.content
            ? (Array.isArray(lastUser.content)
                ? lastUser.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
                : String(lastUser.content))
            : '';
        // 进行中的占位行：请求还没出结果，先给一行「模型生成中」让面板立刻可见。
        // 发号：一次请求 = 一个轮次。有 sessionId 的记在该会话名下（面板按会话分组）；
        // 没有的（如会话标题生成）沿用最近一次请求所属会话发号，与旧行为一致。
        const modelLabel = `${options.provider}/${options.model}`;
        const sid = options.sessionId ? String(options.sessionId) : (lastTurnSession ?? undefined);
        let turnNo;
        if (sid) {
            turnNo = (turnsIssued.get(sid) ?? 0) + 1;
            turnsIssued.set(sid, turnNo);
            lastTurnSession = sid;
        }
        const pending = record({
            kind: 'llm',
            sessionId: options.sessionId ? String(options.sessionId) : undefined,
            name: modelLabel,
            tag: 'llm',
            summary: `模型生成中… · ${options.messages?.length ?? 0} 条消息 · ${options.tools?.length ?? 0} 个工具`,
            settled: false,
            turn: turnNo,
        });
        /** 流进行中的原地刷新（节流）：摘要 + 已回文字预览 */
        function touchLive(now) {
            if (now - lastLiveUpdate < 150)
                return;
            lastLiveUpdate = now;
            const parts = ['模型生成中…'];
            if (replyText)
                parts.push(`已回 ${replyText.length} 字`);
            if (reasoningText)
                parts.push(`思考 ${reasoningText.length} 字`);
            if (usage)
                parts.push(usage);
            const live = {
                kind: 'llm',
                sessionId: pending.sessionId,
                name: modelLabel,
                tag: 'llm',
                summary: parts.join(' · '),
                settled: false,
                // usage chunk 一到就挂上数值字段：进行中行的行内 ⚡token 计数也能实时上屏
                ...(usageTokens ? { usageIn: usageTokens.input, usageOut: usageTokens.output } : {}),
            };
            if (replyText) {
                live.sections = [{ title: '助手回复（生成中…）', body: replyText }];
            }
            updateRow(pending, live);
        }
        try {
            const stream = next();
            for await (const chunk of stream) {
                const c = chunk;
                if (c?.type === 'usage' && c.usage) {
                    usage = `${c.usage.inputTokens ?? '?'}in / ${c.usage.outputTokens ?? '?'}out`;
                    usageTokens = { input: c.usage.inputTokens ?? 0, output: c.usage.outputTokens ?? 0 };
                    touchLive(Date.now());
                }
                else if (c?.type === 'text-delta') {
                    replyText += c.text ?? '';
                    touchLive(Date.now());
                }
                else if (c?.type === 'reasoning-delta') {
                    reasoningText += c.text ?? '';
                    touchLive(Date.now());
                }
                yield chunk;
            }
        }
        catch (err) {
            failed = true;
            updateRow(pending, {
                kind: 'llm',
                sessionId: options.sessionId ? String(options.sessionId) : undefined,
                name: modelLabel,
                tag: 'llm',
                summary: '模型调用失败',
                durationMs: Date.now() - start,
                ok: false,
                detail: String(err?.message ?? err).slice(0, 1500),
            });
            // 模型回复失败 = 该轮结束（不会有后续），同样记「已结束」
            if (sid && turnNo)
                closeTurn(sid, turnNo);
            throw err;
        }
        finally {
            if (!failed) {
                // 模型回复完成 = 该轮结束
                if (sid && turnNo)
                    closeTurn(sid, turnNo);
                // 使用流开始前缓存的 assembly（带注册名），每段标注来源（不在 waterfall 栈内 assemble，会死锁）
                let promptSections = [];
                const assemblySections = cachedSections;
                const assemblyContexts = cachedContexts;
                if (assemblySections?.length) {
                    promptSections = assemblySections
                        .filter((s) => (s.text ?? '').trim().length > 0)
                        .map((s, i) => {
                        const src = describeSectionSource(s.name);
                        const title = src
                            ? `${i + 1}. ${s.name} ${src}`
                            : `${i + 1}. ${s.name}（第三方插件注册）`;
                        // key 非空 → 前端二级折叠（提示词正文默认不展开）；正文不截断
                        return { title, body: s.text, key: `sec:${s.name}` };
                    });
                    for (const c of assemblyContexts ?? []) {
                        if ((c.text ?? '').trim()) {
                            promptSections.push({ title: `runtime-context: ${c.name}`, body: c.text, key: `ctx:${c.name}` });
                        }
                    }
                }
                // 回退：没有 assemble 结果时，从渲染文本按空行拆分（无名段落）
                if (promptSections.length === 0 && systemText) {
                    promptSections = splitSystemPrompt(systemText).map((s, i) => ({ ...s, key: `fb:${i}` }));
                }
                // 展开区的段落顺序 = 一次请求的自然阅读顺序：
                // 用户消息（触发这轮的东西） → 系统提示词（分组，默认收起） → 助手回复（这轮的产物，放最后）
                const PROMPT_GROUP_KEY = 'group:prompt';
                const sections = [];
                if (lastUserText) {
                    sections.push({ title: '用户消息（最近一条）', body: lastUserText });
                }
                if (promptSections.length > 0) {
                    sections.push({
                        title: `系统提示词（${promptSections.length} 个 section，按生效顺序）`,
                        body: '',
                        key: PROMPT_GROUP_KEY,
                        isGroup: true,
                    });
                    for (const s of promptSections)
                        sections.push({ ...s, parent: PROMPT_GROUP_KEY });
                }
                // 另外两套视图：真正发给模型的完整消息序列 + 工具清单（与上面「按注册来源分段」并列）
                const ctx = buildContextSections(options.messages ?? [], options.tools ?? []);
                for (const s of ctx.sections)
                    sections.push(s);
                // 本次请求里发起的工具调用及其在消息序列里的位置（前端把工具行对回上下文用）
                const calls = collectToolCalls(options.messages ?? []);
                if (replyText) {
                    sections.push({ title: '助手回复', body: replyText });
                }
                updateRow(pending, {
                    kind: 'llm',
                    sessionId: options.sessionId ? String(options.sessionId) : undefined,
                    name: modelLabel,
                    tag: 'llm',
                    summary: `${usage || '流式完成'} · 回复 ${replyText.length} 字 · ${ctx.messageCount} 条消息 · `
                        + `${options.tools?.length ?? 0} 个工具 · 上下文 ${fmtBytes(ctx.contextBytes)} + 工具 ${fmtBytes(ctx.toolBytes)}`
                        + `${ctx.omitted ? `（${ctx.omitted} 项超预算已省略）` : ''} · ${promptSections.length} 段提示词`
                        + `${calls.length ? ` · 本轮发起 ${calls.length} 个调用` : ''}`,
                    durationMs: Date.now() - start,
                    ok: true,
                    sections,
                    calls,
                    // 数值化字段：供 agent 报告工具聚合求和（token / 上下文规模）
                    ...(usageTokens ? { usageIn: usageTokens.input, usageOut: usageTokens.output } : {}),
                    contextBytes: ctx.contextBytes,
                    contextMessages: ctx.messageCount,
                    toolBytes: ctx.toolBytes,
                    contextOmitted: ctx.omitted,
                    // 提示词分段数：轻行也带它（前端做跨轮差异与「提示词膨胀」信号用）
                    promptSections: promptSections.length,
                });
            }
        }
    });
    // ── HTTP 端点（协议 v2） ──
    // 一屏说明：快照只传「轻行」（**不含正文**）。实测单行平均 15KB、最坏 265KB，其中约 85%
    // 是 system prompt 与完整上下文正文 —— 那是高频通道里最重、定稿后最不变的数据。
    // 正文改为展开某一行时才用 /row 取；轮次边界标记走 marks 日志增量。
    if (cfg.endpoints)
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: '/api/activity-monitor/history',
            handler: async (req, res) => {
                try {
                    self.requests++;
                    const url = new URL(req.url ?? '/', 'http://localhost');
                    const sid = url.searchParams.get('sessionId');
                    if (!sid) {
                        // 会话列表：读索引（v1 是每个文件整篇读一遍，只为数行数与取末次时间 —— O(全库字节)）
                        return sendJson(res, {
                            v: PROTOCOL,
                            sessions: store.list().map((s) => ({ sessionId: s.sessionId, rows: s.rows, count: s.rows, lastTs: s.lastTs, bytes: s.bytes, archived: s.archived })),
                        });
                    }
                    const read = store.rows(sid);
                    const all = read.rows;
                    const light = url.searchParams.get('light') === '1';
                    const limit = Math.max(1, Math.min(20_000, Number(url.searchParams.get('limit') ?? cfg.client.backfillRows) || cfg.client.backfillRows));
                    const before = Number(url.searchParams.get('before') ?? 0) || 0;
                    // before = 面板已有行里最旧的 ts：往更早翻一页（分页，避免一次把整段历史搬进浏览器）
                    const win = before > 0 ? all.filter((r) => (r.ts ?? 0) < before) : all;
                    const slice = win.length > limit ? win.slice(-limit) : win;
                    sendJson(res, {
                        v: PROTOCOL,
                        sessionId: sid,
                        total: all.length,
                        returned: slice.length,
                        truncated: win.length > slice.length,
                        archived: read.archived,
                        badLines: read.badLines,
                        // light=1（v2 客户端）：轻行 + 本页涉及的轮次标记；
                        // 缺省继续保持 v1 的整行下发（带 turnStart/turnEnd），让旧客户端不至于打不开面板。
                        rows: light
                            ? historyLightRows(all, slice)
                            : applyMarks(slice, computeMarks(all, () => true)),
                    });
                }
                catch (e) {
                    noteError(e);
                    sendJson(res, { v: PROTOCOL, error: String(e?.message ?? e) }, 500);
                }
            },
        }), 'activity-monitor: history route');
    if (cfg.endpoints)
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: '/api/activity-monitor/snapshot',
            handler: async (req, res) => {
                try {
                    self.requests++;
                    const url = new URL(req.url ?? '/', 'http://localhost');
                    const since = Number(url.searchParams.get('since') ?? 0) || 0;
                    const markSince = Number(url.searchParams.get('markSince') ?? 0) || 0;
                    const sessionId = url.searchParams.get('sessionId');
                    // 会话过滤在服务端做：面板只关心当前会话（与无会话归属的行），别的会话的行不必下发
                    const scoped = sessionId ? rows.filter((r) => r.sessionId === sessionId || !r.sessionId) : rows;
                    const delta = scoped.filter((r) => r.seq > since);
                    const log = markLog.since(markSince);
                    sendJson(res, {
                        v: PROTOCOL,
                        runId: RUN_ID,
                        now: Date.now(),
                        total: scoped.length,
                        /** 全局发号游标：客户端用它推进 since（跨会话共享同一个计数器） */
                        lastSeq: seq,
                        markGen: log.markGen,
                        /** 客户端游标落在已被容量丢弃的区间 → 它应整段重载 */
                        marksTooOld: log.tooOld,
                        /** 客户端游标比宿主还新（宿主重启过）→ 让它重开一轮增量 */
                        marksReset: log.reset,
                        marks: log.entries,
                        rows: lightRows(scoped, delta),
                    });
                }
                catch (e) {
                    noteError(e);
                    sendJson(res, { v: PROTOCOL, error: String(e?.message ?? e) }, 500);
                }
            },
        }), 'activity-monitor: snapshot route');
    // 单行正文（重体）端点：前端展开某一行时才调用。先查内存环形缓冲（进行中的行只有内存里
    // 有），未命中再回落到历史文件（含 .jsonl.gz，走 HistoryStore 的解析缓存）。
    if (cfg.endpoints)
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: '/api/activity-monitor/row',
            handler: async (req, res) => {
                try {
                    self.requests++;
                    const url = new URL(req.url ?? '/', 'http://localhost');
                    const sessionId = url.searchParams.get('sessionId');
                    const wantSeq = Number(url.searchParams.get('seq') ?? 0);
                    const ts = Number(url.searchParams.get('ts') ?? 0);
                    if (!wantSeq || !ts)
                        return sendBadRequest(res, 'seq 与 ts 必填（seq 可能被环形缓冲重排，用 ts 消歧）');
                    const live = rows.find((r) => r.seq === wantSeq && r.ts === ts);
                    if (live && (live.detail || (live.sections?.length ?? 0) > 0)) {
                        self.rowBodyHits++;
                        return sendJson(res, { v: PROTOCOL, row: { seq: live.seq, ts: live.ts, rev: live.rev, detail: live.detail, sections: live.sections } });
                    }
                    // 内存里没有（已被挤出缓冲 / 是历史行）：走磁盘。
                    // 命中口径：hits = 真的取回了正文（内存或磁盘）；misses = 真的没有（404）。
                    // 之前的写法把「磁盘成功」也计进 misses，/selfcheck 上看着像全失败，误导排查。
                    const fromDisk = store.row(sessionId, wantSeq, ts);
                    if (!fromDisk) {
                        self.rowBodyMisses++;
                        return sendJson(res, { v: PROTOCOL, row: null }, 404);
                    }
                    self.rowBodyHits++;
                    sendJson(res, { v: PROTOCOL, row: { seq: wantSeq, ts, ...fromDisk } });
                }
                catch (e) {
                    noteError(e);
                    sendJson(res, { v: PROTOCOL, error: String(e?.message ?? e) }, 500);
                }
            },
        }), 'activity-monitor: row route');
    // 生效配置（客户端据此决定轮询节奏与保留行数；缺省值与 host 完全同源，避免两边各写一份）
    // client 子对象单独摊平发出去：浏览器侧只用这几个旋钮，不必理解宿主侧的完整配置结构
    if (cfg.endpoints)
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: '/api/activity-monitor/config',
            handler: async (_req, res) => {
                sendJson(res, { v: PROTOCOL, config: cfg, client: cfg.client });
            },
        }), 'activity-monitor: config route');
    // 人工批准 / 否决端点（POST）：**状态变更追加成一行 proposal 行**（append-only —— 跨重启可查、
    // 不需要改写历史 JSONL），创建行本身不动。有效状态 = 同一 id 上最新那行（见 derive.effectiveProposalStatus）。
    // 边界：只绑环回（webServer 的 host 就是 127.0.0.1），并要求 application/json
    // —— 浏览器对 application/json 会先发 preflight，跨站表单打不进来。
    if (cfg.endpoints)
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: '/api/activity-monitor/proposal',
            handler: async (req, res) => {
                try {
                    if (req.method !== 'POST') {
                        sendJson(res, { v: PROTOCOL, error: '只接受 POST（人工状态变更）' }, 405);
                        return;
                    }
                    if (!String(req.headers?.['content-type'] ?? '').includes('application/json')) {
                        sendJson(res, { v: PROTOCOL, error: '需要 Content-Type: application/json' }, 415);
                        return;
                    }
                    const input = parseProposalTransition(await readJsonBody(req, 16 * 1024));
                    // 找目标提案：先看本进程缓冲，再扫历史库；找不到就 404（绝不写一条指不到人的变更）
                    const hit = (rs) => rs.find((r) => !!r.proposal && ((!!input.id && String(r.proposal?.id ?? '') === input.id)
                        || (input.seq != null && r.seq === input.seq)));
                    let target = hit(rows);
                    if (!target) {
                        for (const s of store.list()) {
                            target = hit(loadHistoryRows(store, s.key));
                            if (target)
                                break;
                        }
                    }
                    if (!target) {
                        sendJson(res, { v: PROTOCOL, error: '找不到对应提案（id/seq 不匹配）' }, 404);
                        return;
                    }
                    const prev = (target.proposal ?? {});
                    const at = Date.now();
                    const row = record({
                        kind: 'proposal',
                        sessionId: target.sessionId,
                        name: 'proposal_transition',
                        tag: 'proposal',
                        summary: `${input.status} · ${prev.pkind}/${prev.action} ${prev.target}`.trim(),
                        detail: [
                            '── 状态变更 ──',
                            `${String(prev.status ?? 'proposed')} → ${input.status}`,
                            '── 提案 ──',
                            `${prev.pkind} / ${prev.action}`,
                            String(prev.target ?? ''),
                            '── 说明 ──',
                            input.note ?? '（未填写）',
                            '── 来源 ──',
                            'user（面板人工批准；本插件不执行变更，执行由人走 dshmarket / skills-manager）',
                        ].join('\n'),
                        proposal: {
                            pkind: prev.pkind,
                            action: prev.action,
                            target: String(prev.target ?? ''),
                            rationale: input.note ?? `人工状态变更：${String(prev.status ?? 'proposed')} → ${input.status}`,
                            evidenceSeqs: prev.evidenceSeqs,
                            id: prev.id,
                            transitionOf: target.seq,
                            status: input.status,
                            by: 'user',
                            at,
                        },
                    });
                    ctx.logger?.info?.(`[activity-monitor] 提案状态变更 ${String(prev.status ?? '')} → ${input.status}（变更行 seq ${row.seq}，原提案 seq ${target.seq}）`);
                    // 回带变更行的**轻行**：面板直接并进本地，不用等下一次快照
                    sendJson(res, { v: PROTOCOL, ok: true, seq: row.seq, transitionOf: target.seq, status: input.status, id: prev.id ?? null, row: toLight(row) });
                }
                catch (e) {
                    noteError(e);
                    sendJson(res, { v: PROTOCOL, error: String(e?.message ?? e) }, 400);
                }
            },
        }), 'activity-monitor: proposal route');
    // 自检端点：排查「面板没数据 / 历史没落盘 / 归档没跑」时的第一入口
    if (cfg.endpoints)
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: '/api/activity-monitor/selfcheck',
            handler: async (_req, res) => {
                try {
                    const sessions = store.list();
                    sendJson(res, {
                        v: PROTOCOL,
                        runId: RUN_ID,
                        uptimeMs: Date.now() - self.startedAt,
                        rowsInBuffer: rows.length,
                        inFlight: rows.filter((r) => r.settled === false).length,
                        lastSeq: seq,
                        markGen: markLog.generation,
                        sessions: sessions.length,
                        history: {
                            dir: cfg.history.dir,
                            sessions: sessions.slice(0, 20),
                            ...store.stats(),
                        },
                        summaries: summaryCache.stats(),
                        endpoint: {
                            requests: self.requests,
                            badRequests: self.badRequests,
                            errors: self.endpointErrors,
                            rowBodyHits: self.rowBodyHits,
                            rowBodyMisses: self.rowBodyMisses,
                            lastError: self.lastError,
                        },
                        config: {
                            maxRows: cfg.maxRows,
                            contextBudgetBytes: cfg.contextBudgetBytes,
                            toolDetailBudgetBytes: cfg.toolDetailBudgetBytes,
                            archiveAfterDays: cfg.history.archiveAfterDays,
                            endpoints: cfg.endpoints,
                            client: cfg.client,
                            issues: cfg.issues,
                        },
                    });
                }
                catch (e) {
                    noteError(e);
                    sendJson(res, { v: PROTOCOL, error: String(e?.message ?? e) }, 500);
                }
            },
        }), 'activity-monitor: selfcheck route');
    // ── 历史归档（保留策略） ──
    // 超过 archiveAfterDays 的会话文件自动 gzip 归档（0 = 关闭）。原文不丢：内容完整地在
    // .jsonl.gz 里，读取路径（/history、/row、activity_report）对归档文件透明。
    const runArchive = () => {
        try {
            const r = store.archiveOld();
            if (r.archived > 0) {
                ctx.logger.info(`[activity-monitor] 已归档 ${r.archived} 个历史文件（超过 ${cfg.history.archiveAfterDays} 天的会话）`);
            }
        }
        catch (e) {
            noteError(e);
        }
    };
    const firstArchive = setTimeout(runArchive, 10_000);
    const archiveTimer = setInterval(runArchive, Math.max(1, cfg.history.archiveCheckHours) * 3_600_000);
    ctx.effect(() => () => { clearTimeout(firstArchive); clearInterval(archiveTimer); }, 'activity-monitor: history archiver');
    // ── agent 侧：activity_report 工具（agent 自查监控数据） ──
    // 懒注册：仅当 tools 服务存在时才装载（子 fiber 延迟注入；缺服务则停留 PENDING，
    // 监控核心照常跑，bare-Context 冒烟测试不受影响）。工具读「内存环形缓冲 + 该会话
    // 历史 JSONL」聚合成结构化报告，供 agent 在运行中自查 token/工具/失败/上下文压力，
    // 自行决定换路 / 压缩 / 重开 / 降低重复。信号只陈述事实，不替 agent 决策。
    // defineTool 动态引入（dsh-tools 是可选 peer）：顶层模块不硬依赖，
    // 没有 tools 服务的部署里插件照常加载，只是不暴露这个工具。
    // 同时注册一个只读端点 /api/activity-monitor/registered-tools：
    // 实时列出本实例里 dsh-tools 注册表中的工具名（含 activity_report 自身），
    // 既是本工具的端到端验证器，也是「agent 侧到底挂没挂上」的排障入口。
    const subFiber = ctx.inject(['tools', 'webServer'], (subCtx) => {
        const tools = subCtx.tools;
        if (!tools?.register)
            return;
        // 已注册工具清单端点（在真实组合树里读 dsh-tools 注册表）
        const ws = subCtx.webServer;
        ws?.register?.({
            kind: 'exact',
            path: '/api/activity-monitor/registered-tools',
            handler: async (_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                let names = [];
                try {
                    names = (tools.schemas() ?? []).map((s) => s.name).sort();
                }
                catch { /* 注册表未就绪 */ }
                res.end(JSON.stringify({
                    tools: names,
                    activityReportRegistered: names.includes('activity_report'),
                }));
            },
        });
        let disposer;
        let verdictDisposer;
        let proposalDisposer;
        /** 提案 id 的本地序号（只用于同一毫秒内区分，稳定性靠 RUN_ID + ts） */
        let proposalLocal = 0;
        void (async () => {
            const { defineTool } = await import('@deepseek-ai/dsh-tools');
            // parameters 用 spec 形式（编译器生成给模型看的 JSON Schema）；
            // output.schema 用 author spec（type:'json' = 不校验具体形状，注册表只要求可无失真 JSON），
            // render 负责把报告投成文本块（要点 + 完整 JSON，agent 可直接解析）。
            const def = defineTool({
                name: 'activity_report',
                description: '查询本次会话（或指定会话）的活动监控报告：模型/工具调用量、token 用量、耗时、' +
                    '各工具调用频次与失败、失败聚类（同一失败签名重复几次）、任务验收结论（verdict）、' +
                    '上下文相对预算的压力与是否被截断、近期明细，以及一组陈述性 signals。' +
                    '只陈述观察到的事实与阈值判断，不替你决策——你据此自行判断是否换路 / 压缩 / 重开会话 / 降低重复。' +
                    '在长任务、批量重试、上下文逼近上限时调用它自查。',
                parameters: {
                    sessionId: {
                        type: 'string',
                        description: '要查询的会话 id。缺省 = 当前 agent 正在运行的会话；无会话时统计全量内存缓冲。',
                    },
                    recentTurns: {
                        type: 'number',
                        description: '只统计最近 N 个轮次（按轮次号取最大的 N）；缺省 = 该范围全量。',
                    },
                    maxFailures: {
                        type: 'number',
                        description: 'failures 明细最多返回多少条（默认 20）。聚类 failureClusters 不受它影响，始终覆盖全部失败。',
                    },
                    clusterMinCount: {
                        type: 'number',
                        description: '失败聚类的最小重复次数（默认 2，下限 2）：同一失败签名达到该次数才进 failureClusters。',
                    },
                    skillWindowTurns: {
                        type: 'number',
                        description: '技能前后对比的窗口轮数（默认 3）：取该技能首次加载轮次的前后各 N 轮做指标对比。',
                    },
                    crossSessions: {
                        type: 'number',
                        description: '跨会话聚合（L5）：统计最近 N 个会话的汇总与「跨会话复现的失败签名」'
                            + `（缺省不聚合；不传时的默认值取配置 crossSessionLimit=${cfg.crossSessionLimit}，上限 50）。`,
                    },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            report: { type: 'json' },
                        },
                    },
                    render: (_args, value) => {
                        // 一段人类/agent 可读文本：要点 + 完整 JSON（agent 可直接解析 JSON）
                        const r = value?.report;
                        if (!r)
                            return [{ type: 'text', text: '（activity_report 无数据可报）' }];
                        const lines = [];
                        lines.push(`活动监控报告（${r.scope}） 会话 ${r.sessionId ?? '(全量)'}`);
                        const t = r.totals;
                        lines.push(`合计：模型请求 ${t.llmCalls} 次 / 工具 ${t.toolCalls} 次 / 失败 ${t.failedCalls} 次 · ` +
                            `轮次 ${t.turns} 个 · 进行中 ${t.inFlight} 条`);
                        lines.push(`耗时：活跃调用合计 ${t.durationMs}ms（已定稿调用之和）· 墙钟跨度 ${t.spanMs}ms（本运行首→末事件，含空闲等待）`);
                        if (t.inputTokens || t.outputTokens) {
                            lines.push(`token：输入 ${t.inputTokens} / 输出 ${t.outputTokens}`);
                        }
                        if (r.tools.byName.length) {
                            lines.push('工具频次：' + r.tools.byName.map((e) => `${e.name}×${e.count}${e.failed ? `(失败${e.failed})` : ''}`).join('，'));
                        }
                        if (r.failureClusters?.length) {
                            lines.push('失败聚类（同一签名按次数降序）：');
                            for (const c of r.failureClusters.slice(0, 8)) {
                                lines.push(`  ${c.count}× ${c.tool}/${c.errClass} · ${c.turns.length} 个轮次 · 样本 seq ${c.exampleSeqs.join(',')} — ${c.sig}`);
                            }
                        }
                        if (r.failuresTruncated) {
                            lines.push(`注：failures 明细只列前 ${r.failuresTruncated.shown} 条（共 ${r.failuresTruncated.total} 条）`);
                        }
                        if (r.lastVerdict) {
                            lines.push(`验收结论：${r.lastVerdict.status} — ${r.lastVerdict.basis}（seq ${r.lastVerdict.seq}）`);
                        }
                        else if (r.likelyOutcome) {
                            lines.push(`验收结论：无（过程推断 ${r.likelyOutcome.label}，置信度 low，非验收结论）`);
                        }
                        if (r.toolOutcome?.length) {
                            // 只列「有问题」或「有结论可依」的行，避免把报告撑成工具清单
                            const notable = r.toolOutcome.filter((e) => e.failed > 0 || e.retriedInTurn > 0 || e.inTurnWithVerdictFail > 0).slice(0, 6);
                            if (notable.length) {
                                lines.push('工具同现统计（不是因果：只说该工具出现在哪类轮次里）：');
                                for (const e of notable) {
                                    lines.push(`  ${e.name}：调用 ${e.calls} · 失败 ${e.failed} · 同轮重试 ${e.retriedInTurn} · 末轮 ${e.inFinalTurn} · 带 pass 验收 ${e.inTurnWithVerdictPass} · 带 fail 验收 ${e.inTurnWithVerdictFail}`);
                                }
                            }
                        }
                        if (r.skillEffect?.length) {
                            const fmtWin = (w) => w ? `轮 ${w.turns}/工具 ${w.toolCalls}/失败 ${w.failedCalls}/输入 ${w.inputTokens}` : '（无数据）';
                            lines.push('技能加载前后窗口对比（无对照组，只能当线索）：');
                            for (const s of r.skillEffect.slice(0, 6)) {
                                lines.push(`  ${s.name}（加载 ${s.loads} 次）：前 ${fmtWin(s.windowBefore)} → 后 ${fmtWin(s.windowAfter)}`);
                            }
                        }
                        if (r.proposals?.length) {
                            lines.push(`进化提案：共 ${r.proposals.length} 条，待人工批准 ${r.pendingProposals} 条（本插件只写提案，不执行任何变更）`);
                            for (const p of r.proposals.slice(-5)) {
                                const ev = p.evidenceSeqs.length ? ` · 证据行 ${p.evidenceSeqs.join(',')}` : '';
                                const changed = p.effectiveStatus !== p.status ? `（原 ${p.status}）` : '';
                                lines.push(`  #${p.seq} ${p.pkind}/${p.action} ${p.target} · ${p.effectiveStatus}${changed}${ev}${p.id ? ` · id ${p.id}` : ''}`);
                            }
                        }
                        if (r.crossSessions) {
                            const cs = r.crossSessions;
                            lines.push(`跨会话汇总（最近 ${cs.scanned.sessions} 个会话，上限 ${cs.limit}；`
                                + `本次读盘 ${cs.scanned.read} · 复用缓存 ${cs.scanned.reused}）：`);
                            for (const s of cs.sessions.slice(0, 10)) {
                                const top = s.topFailSig ? ` · 首要失败 ${s.topFailSig.count}× ${s.topFailSig.sig}` : '';
                                lines.push(`  ${s.sessionId ?? '(global)'}：${s.rows} 行 · 轮 ${s.turns} · `
                                    + `模型 ${s.llmCalls} / 工具 ${s.toolCalls} · 失败 ${s.failedCalls} · `
                                    + `in ${s.inputTokens} / out ${s.outputTokens}${top}`);
                            }
                            if (cs.recurring.length) {
                                lines.push('跨会话复现的失败签名（同现统计，不是因果）：');
                                for (const x of cs.recurring.slice(0, 8)) {
                                    lines.push(`  ${x.sessions} 个会话 / ${x.failures} 次 · ${x.sig}`);
                                }
                            }
                            else {
                                lines.push(`没有跨会话复现的失败签名（阈值：≥${cs.minSessions} 个会话）`);
                            }
                            if (cs.scanned.badLines > 0)
                                lines.push(`跨会话读取坏行：${cs.scanned.badLines}`);
                        }
                        if (r.context.lastContextBytes != null) {
                            lines.push(`上下文：${r.context.note}`);
                        }
                        if (r.selfNote)
                            lines.push(`注：${r.selfNote}`);
                        if (r.history) {
                            const h = r.history.runs
                                .map((x) => `${x.runId}（${x.rows} 行 · 模型 ${x.llmCalls} / 工具 ${x.toolCalls}）`)
                                .join('；');
                            lines.push(`历史（跨重启，未并入合计）：${h}`);
                        }
                        if (r.signals.length) {
                            lines.push('信号：');
                            for (const s of r.signals)
                                lines.push(`  [${s.severity}] ${s.text}`);
                        }
                        lines.push('完整 JSON：');
                        lines.push(JSON.stringify(r, null, 2));
                        return [{ type: 'text', text: lines.join('\n') }];
                    },
                },
                async execute(args, exec) {
                    const a = (args ?? {});
                    const agentSid = exec?.agent?.session?.id != null ? String(exec.agent.session.id) : undefined;
                    const explicit = typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : undefined;
                    let rowsAll;
                    if (explicit === undefined && agentSid !== undefined) {
                        // 当前会话：内存过滤 + 该会话历史行合并（补回被环形缓冲挤出的旧行）
                        rowsAll = mergeActivityRows(rows.filter((rr) => rr.sessionId === agentSid), loadHistoryRows(store, agentSid));
                    }
                    else if (explicit) {
                        rowsAll = mergeActivityRows(rows.filter((rr) => rr.sessionId === explicit), loadHistoryRows(store, explicit));
                    }
                    else {
                        rowsAll = rows; // 无会话：统计全量内存缓冲
                    }
                    // L5 跨会话聚合：只在显式传参时做（默认不聚合 —— 全库扫描不该混进每次取数）
                    const crossWant = typeof a.crossSessions === 'number' && Number.isFinite(a.crossSessions) && a.crossSessions > 0
                        ? Math.floor(a.crossSessions)
                        : undefined;
                    const cross = crossWant != null
                        ? collectCrossSessions(store, summaryCache, {
                            limit: Math.min(crossWant, 50),
                            // 带上内存行：落盘是异步的，不带的话当前会话的汇总会滞后（未 flush 的行看不到）
                            liveRows: rows,
                        })
                        : undefined;
                    return {
                        // 报告对象是可 JSON 化的普通数据（运行时满足 JsonValue）；AgentReport 接口
                        // 因 readonly + 缺索引签名无法被 TS 直接证明，故断言。
                        report: buildAgentReport({
                            rows: rowsAll,
                            sessionId: explicit ?? agentSid ?? null,
                            contextBudgetBytes: CONTEXT_BUDGET_BYTES,
                            cross,
                            recentTurns: typeof a.recentTurns === 'number' && a.recentTurns > 0 ? Math.floor(a.recentTurns) : undefined,
                            maxFailures: typeof a.maxFailures === 'number' && a.maxFailures > 0 ? Math.floor(a.maxFailures) : undefined,
                            clusterMinCount: typeof a.clusterMinCount === 'number' && a.clusterMinCount > 0 ? Math.floor(a.clusterMinCount) : undefined,
                            skillWindowTurns: typeof a.skillWindowTurns === 'number' && a.skillWindowTurns > 0 ? Math.floor(a.skillWindowTurns) : undefined,
                        }),
                    };
                },
            });
            disposer = tools.register(def);
            subCtx.logger?.info?.('[activity-monitor] agent 报告工具 activity_report 已注册（agent 可自查 token/工具/失败/上下文压力）');
            // ── 第二个工具：task_verdict —— 本插件唯一的「写」入口（agent 写入验收结论） ──
            // 它只记录、不执行任何命令：验收命令请用普通工具（bash 等）跑，再用 evidenceSeqs/verifySeqs
            // 引用那几条工具行的 seq 当证据 —— 于是「验收结论 → 证据行 → 命令」可追，而插件不获得执行权。
            // 记录成一行 kind:'verdict'（与普通调用同一份 JSONL / 时间轴 / 归档），刻意不带 durationMs、
            // 不打 ok：报告侧 failedCalls 的口径是「任意 kind 的 ok === false」，用 ok 表达验收失败会污染失败统计。
            const VERDICT_STATUSES = ['pass', 'fail', 'partial', 'unknown'];
            const verdictDef = defineTool({
                name: 'task_verdict',
                description: '记录一次任务/子任务的验收结论（pass|fail|partial|unknown）与依据，作为 agent 自我进化的结果数据。' +
                    '只记录事实、不执行任何命令：验收命令请用普通工具（如 bash）执行，再用 evidenceSeqs/verifySeqs ' +
                    '引用那几条工具行的 seq 当证据。任务自认为收敛、验收失败需要留痕、长任务阶段性收尾时调用它。',
                parameters: {
                    status: {
                        type: 'string',
                        enum: VERDICT_STATUSES,
                        required: true,
                        description: '验收结论：pass 通过 | fail 未通过 | partial 部分通过 | unknown 无法判定',
                    },
                    basis: {
                        type: 'string',
                        required: true,
                        description: '结论依据（一句话事实，≤500 字）：凭什么判定，例如「npm test 全绿」或「类型检查报 3 处错误」。',
                    },
                    evidenceSeqs: {
                        type: 'array',
                        items: { type: 'number' },
                        description: '作为证据的工具行 seq 列表（可选）：验收命令那条行、或失败的工具行。',
                    },
                    verifyCommand: {
                        type: 'string',
                        description: '本次使用的验收命令原文（可选）—— 只记录文本，本插件不执行它。',
                    },
                    verifySeqs: {
                        type: 'array',
                        items: { type: 'number' },
                        description: '上述验收命令对应的工具行 seq（可选）。',
                    },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            verdict: { type: 'json' },
                        },
                    },
                    render: (_args, value) => {
                        const v = value?.verdict;
                        return [{ type: 'text', text: v ? `已记录验收结论：${v.status} — ${v.basis}（行 seq ${v.seq}）` : '（未记录）' }];
                    },
                },
                // 必须 async：dsh-tools 的 execute 约定返回 Promise（同步返回会被类型拒绝）
                async execute(args, exec) {
                    const a = (args ?? {});
                    const status = String(a.status ?? '');
                    if (!VERDICT_STATUSES.includes(status)) {
                        // 编译后的参数 schema 已用 enum 拦过一次，这里是兜底：非法值绝不落盘
                        throw new Error(`task_verdict: status 必须是 ${VERDICT_STATUSES.join('|')} 之一，收到 ${JSON.stringify(a.status)}`);
                    }
                    const basis = String(a.basis ?? '').trim().slice(0, 500);
                    if (!basis)
                        throw new Error('task_verdict: basis 不能为空（写清依据什么判定）');
                    const seqsOf = (v) => {
                        if (!Array.isArray(v))
                            return undefined;
                        const out = v.filter((n) => typeof n === 'number' && Number.isFinite(n)).map((n) => Math.floor(n));
                        return out.length ? out : undefined;
                    };
                    const evidenceSeqs = seqsOf(a.evidenceSeqs);
                    const verifySeqs = seqsOf(a.verifySeqs);
                    const verifyCommand = typeof a.verifyCommand === 'string' && a.verifyCommand.trim()
                        ? a.verifyCommand.trim().slice(0, 500)
                        : undefined;
                    const sessionId = exec?.agent?.session?.id != null ? String(exec.agent.session.id) : undefined;
                    const row = record({
                        kind: 'verdict',
                        sessionId,
                        name: 'task_verdict',
                        tag: 'verdict',
                        summary: basis.slice(0, 120),
                        detail: [
                            '── 结论 ──',
                            status,
                            '── 依据 ──',
                            basis,
                            '── 证据行 ──',
                            evidenceSeqs ? evidenceSeqs.join(', ') : '（未指定）',
                            '── 验收命令 ──',
                            verifyCommand ?? '（未指定）',
                            verifySeqs ? `（命令所在行：${verifySeqs.join(', ')}）` : '',
                        ].filter((x) => x !== '').join('\n'),
                        verdict: { status: status, basis, evidenceSeqs, verifyCommand, verifySeqs, by: 'agent', at: Date.now() },
                    });
                    subCtx.logger?.info?.(`[activity-monitor] 已记录验收结论 ${status}（seq ${row.seq}）`);
                    return {
                        verdict: {
                            seq: row.seq, ts: row.ts, sessionId: sessionId ?? null, status, basis,
                            evidenceSeqs: evidenceSeqs ?? [], verifyCommand: verifyCommand ?? null, verifySeqs: verifySeqs ?? [],
                        },
                    };
                },
            });
            verdictDisposer = tools.register(verdictDef);
            // ── 第三个工具：evolution_proposal —— 进化提案入口（L6） ──
            // 纪律：**只写提案，不执行任何变更**（不装插件、不建 skill、不重启进程）。
            // 执行由人批准后走既有执行器（dshmarket 的安装/热停用、skills-manager 的创建），
            // 见 docs/agent-evolution-data.md §10 —— 本插件不获得执行权。
            // status 刻意不是参数：agent 只能写 'proposed'，绝不接受 'applied'/'approved'，
            // 否则等于允许模型自己伪造「已执行」记录。
            const PROPOSAL_KINDS = ['skill', 'plugin', 'automation'];
            const PROPOSAL_ACTIONS = ['create', 'install', 'enable', 'disable', 'remove', 'other'];
            const proposalDef = defineTool({
                name: 'evolution_proposal',
                description: '把一条「该学什么 / 该装什么 / 该停用什么」写成可审阅的提案，作为自我进化的动作面入口。' +
                    '**只记录提案、不执行任何变更**（不装插件、不建技能、不重启）：执行需人工批准后走既有执行器。' +
                    '提案要能指回证据（evidenceSeqs 引用真实工具行），并给出可测的期望效果与回滚方案。',
                parameters: {
                    pkind: {
                        type: 'string',
                        enum: PROPOSAL_KINDS,
                        required: true,
                        description: '提案类别：skill 技能 | plugin 插件 | automation 自动化',
                    },
                    action: {
                        type: 'string',
                        enum: PROPOSAL_ACTIONS,
                        required: true,
                        description: '建议动作：create 新建 | install 安装 | enable 启用 | disable 停用 | remove 卸载 | other',
                    },
                    target: {
                        type: 'string',
                        required: true,
                        description: '目标：技能名 / 插件包名 / 仓库（≤200 字）。',
                    },
                    rationale: {
                        type: 'string',
                        required: true,
                        description: '为什么提这条（≤500 字）：必须来自可指回的证据（失败簇 / 验收结论 / 工具同现统计）。',
                    },
                    evidenceSeqs: {
                        type: 'array',
                        items: { type: 'number' },
                        description: '支撑本提案的工具行 seq 列表（可选但强烈建议）—— 便于人核对依据。',
                    },
                    expectedEffect: {
                        type: 'string',
                        description: '期望改善的**可测**指标（可选），例如「同一失败签名 7 天内归零」。',
                    },
                    verifyCommands: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '验收命令原文列表（可选）—— 只记录文本，本插件不执行它。',
                    },
                    rollbackPlan: {
                        type: 'string',
                        description: '回滚方案（可选）：怎么撤回这次变更（本插件不执行回滚，只记录方案）。',
                    },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            proposal: { type: 'json' },
                        },
                    },
                    render: (_args, value) => {
                        const p = value?.proposal;
                        return [{
                                type: 'text',
                                text: p
                                    ? `已记录提案 #${p.seq}：${p.pkind}/${p.action} ${p.target} —— status=proposed（待人工批准；本插件不执行变更）`
                                    : '（未记录）',
                            }];
                    },
                },
                // 必须 async：dsh-tools 的 execute 约定返回 Promise
                async execute(args, exec) {
                    const a = (args ?? {});
                    const pkind = String(a.pkind ?? '');
                    if (!PROPOSAL_KINDS.includes(pkind)) {
                        throw new Error(`evolution_proposal: pkind 必须是 ${PROPOSAL_KINDS.join('|')} 之一，收到 ${JSON.stringify(a.pkind)}`);
                    }
                    const action = String(a.action ?? '');
                    if (!PROPOSAL_ACTIONS.includes(action)) {
                        throw new Error(`evolution_proposal: action 必须是 ${PROPOSAL_ACTIONS.join('|')} 之一，收到 ${JSON.stringify(a.action)}`);
                    }
                    const target = String(a.target ?? '').trim().slice(0, 200);
                    if (!target)
                        throw new Error('evolution_proposal: target 不能为空');
                    const rationale = String(a.rationale ?? '').trim().slice(0, 500);
                    if (!rationale)
                        throw new Error('evolution_proposal: rationale 不能为空（写清依据）');
                    const seqsOf = (v) => {
                        if (!Array.isArray(v))
                            return undefined;
                        const out = v.filter((n) => typeof n === 'number' && Number.isFinite(n)).map((n) => Math.floor(n));
                        return out.length ? out : undefined;
                    };
                    const strsOf = (v) => {
                        if (!Array.isArray(v))
                            return undefined;
                        const out = v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 500));
                        return out.length ? out : undefined;
                    };
                    const trimmed = (v) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined;
                    const sessionId = exec?.agent?.session?.id != null ? String(exec.agent.session.id) : undefined;
                    const proposal = {
                        pkind: pkind,
                        action: action,
                        target,
                        rationale,
                        evidenceSeqs: seqsOf(a.evidenceSeqs),
                        expectedEffect: trimmed(a.expectedEffect),
                        verifyCommands: strsOf(a.verifyCommands),
                        rollbackPlan: trimmed(a.rollbackPlan),
                        // 稳定 id：seq 是每进程计数器（跨重启重复），所以用 RUN_ID + 时间 + 本地序号
                        id: `p-${RUN_ID}-${Date.now()}-${++proposalLocal}`,
                        status: 'proposed',
                        by: 'agent',
                        at: Date.now(),
                    };
                    const row = record({
                        kind: 'proposal',
                        sessionId,
                        name: 'evolution_proposal',
                        tag: 'proposal',
                        summary: `${pkind}/${action} ${target} · ${proposal.status}`,
                        detail: [
                            '── 提案 ──',
                            `${pkind} / ${action}`,
                            target,
                            '── 理由 ──',
                            rationale,
                            '── 期望效果 ──',
                            proposal.expectedEffect ?? '（未指定）',
                            '── 回滚方案 ──',
                            proposal.rollbackPlan ?? '（未指定）',
                            '── 证据行 ──',
                            proposal.evidenceSeqs ? proposal.evidenceSeqs.join(', ') : '（未指定）',
                            '── 验收命令（仅记录，不执行） ──',
                            proposal.verifyCommands ? proposal.verifyCommands.join('\n') : '（未指定）',
                            '── 状态 ──',
                            `${proposal.status}（本插件只写提案、不执行变更：批准与执行由人通过 dshmarket / skills-manager 完成）`,
                        ].join('\n'),
                        proposal,
                    });
                    subCtx.logger?.info?.(`[activity-monitor] 已记录进化提案 #${row.seq}：${pkind}/${action} ${target}`);
                    // 返回值必须全是「已定义」的值：dsh-tools 的 JsonValue 不接受 undefined（与 task_verdict 同风格）
                    return {
                        proposal: {
                            seq: row.seq,
                            ts: row.ts,
                            sessionId: sessionId ?? null,
                            pkind: proposal.pkind,
                            action: proposal.action,
                            target: proposal.target,
                            rationale: proposal.rationale,
                            evidenceSeqs: proposal.evidenceSeqs ?? [],
                            expectedEffect: proposal.expectedEffect ?? null,
                            verifyCommands: proposal.verifyCommands ?? [],
                            rollbackPlan: proposal.rollbackPlan ?? null,
                            status: proposal.status,
                            by: proposal.by,
                            at: proposal.at,
                        },
                    };
                },
            });
            proposalDisposer = tools.register(proposalDef);
            subCtx.logger?.info?.('[activity-monitor] 进化提案工具 evolution_proposal 已注册（只写提案，不执行变更）');
        })().catch((err) => {
            // dsh-tools 缺失或注册失败：监控核心不受影响，仅不暴露工具；留痕便于排查
            subCtx.logger?.warn?.('[activity-monitor] activity_report 工具未注册：' + String(err?.message ?? err));
        });
        // 子 fiber 卸载时反注册：setup 无动作，把 unregister 放进 teardown（disposer 由闭包持有，
        // 异步注册完成前卸载则为 undefined，跳过即可；disposer 幂等，可安全重复调用）
        subCtx.effect(() => () => {
            disposer?.();
            verdictDisposer?.();
            proposalDisposer?.();
        }, 'activity-monitor: agent_report + task_verdict + evolution_proposal tools');
    });
    void subFiber;
    ctx.logger.info('[activity-monitor] ready');
}
/** 把渲染后的 system prompt 按 dsh section 之间的空行分段，识别常见 section 标题 */
function splitSystemPrompt(text) {
    const blocks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    if (blocks.length === 0)
        return [];
    return blocks.map((block, i) => {
        const firstLine = block.split('\n')[0];
        // Markdown 标题或 skill 正文特征（"# 开头"）作为段落标题
        const title = firstLine.startsWith('#')
            ? `段落 ${i + 1}: ${firstLine.replace(/^#+\s*/, '').slice(0, 60)}`
            : firstLine.length <= 70
                ? `段落 ${i + 1}: ${firstLine}`
                : `段落 ${i + 1}`;
        return { title, body: truncateText(block, 2500) };
    });
}
function truncateText(s, max) {
    return s.length > max ? s.slice(0, max) + `\n…(截断，共 ${s.length} 字符)` : s;
}
/** 只受总量上限保护：未超上限就原样返回，超了才截断并标注真实大小 */
function clampText(s, maxBytes) {
    const size = byteLen(s);
    if (size <= maxBytes)
        return s;
    return `${s.slice(0, maxBytes)}\n…（超出 ${fmtBytes(maxBytes)} 上限，共 ${fmtBytes(size)}，已截断）`;
}
// ── 发给模型的完整上下文（消息序列 + 工具清单） ──
/**
 * 单条请求里「完整上下文 + 工具清单」的总字节预算的**进程级默认值**。
 * 正文不截断，但总量封顶；超出时按「最旧优先」整条省略并标注（尾部才是本次真正生效的上下文）。
 * 这也是 activity_report 工具判断「上下文是否逼近/超出监控预算」的依据。
 *
 * 为什么是模块级可变：buildContextSections / buildAgentReport 都是纯函数（可单测、不持有 ctx），
 * 预算由 apply() 在挂载时用 config 覆盖一次（config.contextBudgetBytes）。dsh 一个进程只挂一份
 * profile，所以「进程级」在实践中等价于「实例级」；同一进程挂多份（测试场景）时以最后挂载者为准。
 */
let CONTEXT_BUDGET_BYTES = 300 * 1024;
const byteLen = (s) => Buffer.byteLength(s, 'utf8');
const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
/** 取首个非空行做摘要 */
function firstLine(s, max = 70) {
    const line = (s.split('\n').find((l) => l.trim() !== '') ?? '').trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
}
/** 一块内容 → 可读文本（text / reasoning / image / file / tool-call / tool-result） */
function blockText(b) {
    if (b == null)
        return '';
    if (typeof b === 'string')
        return b;
    if (typeof b !== 'object')
        return String(b);
    switch (b.type) {
        case 'text':
            return String(b.text ?? '');
        case 'reasoning':
            return `[思考] ${String(b.text ?? '')}`;
        case 'image':
            return `[图片 ${b.attachment?.name ?? b.attachment?.id ?? ''}]`.trim();
        case 'file':
            return `[文件 ${b.attachment?.name ?? b.attachment?.path ?? ''}]`.trim();
        case 'tool-call':
            return `→ 调用工具 ${b.name}(${String(b.arguments ?? '')})`;
        case 'tool-result': {
            const inner = Array.isArray(b.content)
                ? b.content.map(blockText).filter((t) => t !== '').join('\n')
                : String(b.content ?? '');
            return `${b.isError ? '[工具报错] ' : ''}${inner}`;
        }
        default:
            if (typeof b.text === 'string')
                return b.text;
            return JSON.stringify(b);
    }
}
/** 一条请求消息 → 全文（reasoning 单独抽出；完整上下文正文里不加任何角色小标签） */
function messagePart(m, i, callNames) {
    void i;
    const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: m?.content ?? '' }];
    const pieces = [];
    const reason = [];
    let toolName = m?.source?.toolName ?? m?.name ?? undefined;
    for (const b of blocks) {
        if (b?.type === 'tool-call') {
            if (!toolName)
                toolName = String(b.name ?? '');
            pieces.push(blockText(b));
        }
        else if (b?.type === 'tool-result') {
            // 工具名回填：tool 结果消息只带 toolCallId，名称来自前面那条 assistant 的 tool-call
            if (!toolName && b.toolCallId)
                toolName = callNames.get(String(b.toolCallId));
            pieces.push(blockText(b));
        }
        else if (b?.type === 'reasoning') {
            // 推理内容单独抽出（保留全文，正文按「思考在前、回复在后」排开）
            const t = String(b.text ?? '');
            if (t.trim() !== '')
                reason.push(t);
        }
        else {
            const t = blockText(b);
            if (t.trim() !== '')
                pieces.push(t);
        }
    }
    // 兼容 wire 形态（tool_calls / tool_call_id）
    if (Array.isArray(m?.tool_calls)) {
        for (const c of m.tool_calls) {
            const n = c?.function?.name ?? c?.name ?? '?';
            if (!toolName)
                toolName = String(n);
            pieces.push(`→ 调用工具 ${n}(${String(c?.function?.arguments ?? c?.arguments ?? '')})`);
        }
    }
    for (const key of ['tool_call_id', 'toolCallId']) {
        if (m?.[key]) {
            if (!toolName)
                toolName = callNames.get(String(m[key]));
        }
    }
    return { i, text: pieces.join('\n'), reasoning: reason.join('\n') };
}
/**
 * 收集本次请求里模型发起的 tool-call 及其位置（第几条消息、该消息内第几个调用），
 * 并把 tool-result 回填到对应调用的 resultMsgIndex。
 */
function collectToolCalls(messages) {
    const calls = [];
    const byId = new Map() // toolCallId → calls 下标
    ;
    (messages ?? []).forEach((m, i) => {
        const blocks = Array.isArray(m?.content) ? m.content : [];
        let n = 0;
        for (const b of blocks) {
            if (b?.type === 'tool-call') {
                n++;
                calls.push({ name: String(b.name ?? '?'), msgIndex: i, callIndex: n, id: b.id ? String(b.id) : undefined });
                if (b.id)
                    byId.set(String(b.id), calls.length - 1);
            }
            else if (b?.type === 'tool-result' && b.toolCallId != null) {
                const at = byId.get(String(b.toolCallId));
                if (at !== undefined)
                    calls[at].resultMsgIndex = i;
            }
        }
        // OpenAI 兼容形态
        if (Array.isArray(m?.tool_calls)) {
            for (const c of m.tool_calls) {
                n++;
                const id = c?.id ?? c?.function?.id;
                calls.push({ name: String(c?.function?.name ?? c?.name ?? '?'), msgIndex: i, callIndex: n, id: id ? String(id) : undefined });
                if (id)
                    byId.set(String(id), calls.length - 1);
            }
        }
        if (m?.tool_call_id != null || m?.toolCallId != null) {
            const id = String(m.tool_call_id ?? m.toolCallId);
            const at = byId.get(id);
            if (at !== undefined)
                calls[at].resultMsgIndex = i;
        }
    });
    return calls.map(({ name, msgIndex, callIndex, resultMsgIndex }) => ({ name, msgIndex, callIndex, resultMsgIndex }));
}
/**
 * 组装「完整上下文」分组：里面只放一条正文 = 真正发给模型的完整消息序列原文（含思考、
 * 工具调用、工具结果，全文不截断；超预算仍按「最旧优先」整条省略并标注，尾部才是生效上下文）。
 * 不再拆成「每条消息一个分段 + 标题上的 [n] [角色] 小标签」，也不再另列「工具清单」——
 * 完整显示本身就是目的，小标签是多余的。
 * 组内跳转（工具行 → 某条消息）靠分组段的 anchorOffsets：前端把正文按消息块切分渲染，
 * 每块带 data-am-msg 属性可定位；偏移在宿主侧算好，正文本身不加任何标记字符。
 */
function buildContextSections(messages, tools) {
    // 先收集 tool-call 的 id → 工具名，供 tool 结果消息回填名称
    const callNames = new Map();
    for (const m of messages ?? []) {
        const blocks = Array.isArray(m?.content) ? m.content : [];
        for (const b of blocks) {
            if (b?.type === 'tool-call' && b.id)
                callNames.set(String(b.id), String(b.name ?? ''));
        }
        if (Array.isArray(m?.tool_calls)) {
            for (const c of m.tool_calls) {
                const id = c?.id ?? c?.function?.id;
                if (id)
                    callNames.set(String(id), String(c?.function?.name ?? c?.name ?? ''));
            }
        }
    }
    const parts = (messages ?? []).map((m, i) => messagePart(m, i, callNames));
    let used = 0;
    let omitted = 0;
    // 尾部优先：本次真正生效的上下文在后面
    for (let idx = parts.length - 1; idx >= 0; idx--) {
        const size = byteLen(parts[idx].text) + byteLen(parts[idx].reasoning);
        if (used + size > CONTEXT_BUDGET_BYTES) {
            parts[idx].text = '';
            parts[idx].reasoning = '';
            omitted++;
        }
        else {
            used += size;
        }
    }
    const contextBytes = used;
    // 拼成一篇完整正文：推理 → 正文按原顺序逐条排开，块与块之间一个空行。
    // 被预算整条省略的条目保留一行占位（标注序号），序列仍是完整的。
    // anchorOffsets[i] = 第 i 条消息块在正文里的起始偏移（渲染时按它切分成可定位的元素）。
    const blocks = [];
    for (const p of parts) {
        if (p.text !== '' || p.reasoning !== '') {
            blocks.push((p.reasoning !== '' ? `${p.reasoning}\n` : '') + (p.text !== '' ? p.text : ''));
        }
        else {
            blocks.push(`（消息 ${p.i}：超出预算，已省略）`);
        }
    }
    const anchorOffsets = [];
    let off = 0;
    for (let i = 0; i < blocks.length; i++) {
        anchorOffsets.push(off);
        off += blocks[i].length + 2; // 块间空行（join 的 '\n' + 空行）
    }
    const fullText = blocks.join('\n\n');
    // 工具清单不再单独成组：工具名在消息序列的工具调用块里可见，单独列一遍是冗余的小标签。
    const toolNames = (tools ?? []).map((t) => {
        if (typeof t === 'string')
            return t;
        const fn = t?.function ?? t;
        return String(fn?.name ?? t?.name ?? '?');
    });
    const toolBytes = toolNames.reduce((n, s) => n + byteLen(s) + 1, 0);
    const sections = [];
    sections.push({
        title: `完整上下文（${parts.length} 条消息 · ${fmtBytes(contextBytes)}`
            + `${omitted ? ` · ${omitted} 条因超 ${fmtBytes(CONTEXT_BUDGET_BYTES)} 预算已省略` : ''}`
            + ` · 工具 ${toolNames.length} 个 ${fmtBytes(toolBytes)}）`,
        body: fullText,
        key: 'group:context',
        isGroup: true,
        anchorOffsets,
    });
    return {
        sections,
        contextBytes,
        toolBytes,
        omitted,
        messageCount: parts.length,
    };
}
/**
 * 读某会话的历史行（由 HistoryStore 提供：索引 + 解析缓存 + .jsonl.gz 透明读取）。
 * 无文件 / 读失败 = 空数组；坏行由 store 计数（/selfcheck 的 history.badLines）。
 */
function loadHistoryRows(store, sessionKey) {
    return store.rows(sessionKey).rows;
}
/**
 * 人工状态变更的入参校验（纯函数，单测覆盖）：**只接受白名单状态**。
 * 状态推进是「人的动作」：agent 侧的 evolution_proposal 工具永远只写 proposed，
 * 想改状态只能走这个解析过的入口（HTTP）或显式写入。
 */
export function parseProposalTransition(body) {
    const ALLOWED = ['approved', 'rejected', 'applied', 'rolled-back'];
    const b = (body ?? {});
    const status = String(b.status ?? '');
    if (!ALLOWED.includes(status)) {
        throw new Error(`proposal: status 必须是 ${ALLOWED.join('|')} 之一，收到 ${JSON.stringify(b.status)}`);
    }
    const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim().slice(0, 200) : undefined;
    const seq = typeof b.seq === 'number' && Number.isFinite(b.seq) ? Math.floor(b.seq) : undefined;
    if (!id && seq == null)
        throw new Error('proposal: 必须给 id 或 seq（指回要变更的提案）');
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : undefined;
    return { id, seq, status: status, note };
}
/** 读小型 JSON body（有上限，避免被大 body 拖住）。只有人工状态变更端点用它。 */
function readJsonBody(req, cap) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > cap) {
                reject(new Error(`body 过大（上限 ${cap} 字节）`));
                req.destroy?.();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            }
            catch {
                reject(new Error('body 不是合法 JSON'));
            }
        });
        req.on('error', (e) => reject(e));
    });
}
/**
 * 纯聚合：从活动行生成 agent 报告。只陈述事实 + 阈值判断，不替 agent 下决策。
 * 阈值可调（dupThreshold / failingThreshold / pressureThreshold），缺省 3 / 2 / 0.8。
 */
export function buildAgentReport(input) {
    const { rows, contextBudgetBytes } = input;
    const runId = input.runId ?? RUN_ID;
    const dupT = input.dupThreshold ?? 3;
    const failT = input.failingThreshold ?? 2;
    const pressT = input.pressureThreshold ?? 0.8;
    const maxF = Math.max(1, Math.floor(input.maxFailures ?? 20));
    const clusterMin = Math.max(2, Math.floor(input.clusterMinCount ?? 2));
    /** 聚类本身也要封顶，否则报告会被大量单例签名撑大 */
    const maxClusters = 20;
    const skillWindow = Math.max(1, Math.floor(input.skillWindowTurns ?? 3));
    /** 输入行先归一排序（工具路径上已由 mergeActivityRows 排好；直调方传未排序行也安全） */
    const ordered = [...rows].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
    // ── 按进程运行切分：seq/turn 都是每进程计数器，重启即归零 ──
    // 本进程的行带当前 RUN_ID；历史 JSONL 里重启前的行带旧 runId 或无该字段。
    // totals/tools/failures/context/latest 只在本运行上聚合，历史片段单列于
    // report.history —— 避免把两段进程里各自 1..N 的编号/轮次当成一套连续口径（#2/#3/#5）。
    const cur = ordered.filter((r) => r.runId === runId);
    const hist = ordered.filter((r) => r.runId !== runId);
    const crossRun = hist.length > 0;
    // 轮次范围过滤（只作用于本运行：历史片段的 turn 编号与本轮不可比）
    let scope = cur;
    let scopeLabel = '全量';
    if (input.recentTurns && input.recentTurns > 0) {
        const allTurns = [...new Set(cur.map((r) => r.turn).filter((t) => t != null))];
        const keep = new Set(allTurns.sort((a, b) => b - a).slice(0, input.recentTurns));
        scope = cur.filter((r) => r.turn != null && keep.has(r.turn));
        scopeLabel = `最近 ${input.recentTurns} 轮`;
    }
    if (crossRun)
        scopeLabel = `${scopeLabel}（仅本运行；重启前片段单列于 history）`;
    const llm = scope.filter((r) => r.kind === 'llm');
    const toolRowsAll = scope.filter((r) => r.kind === 'tool');
    const failed = scope.filter((r) => r.ok === false);
    const inFlight = scope.filter((r) => r.settled === false);
    // 自我观测剔除（#4）：本插件自己暴露的工具（activity_report / task_verdict / evolution_proposal）是「监控自身的记账」，
    // 不是 agent 为任务干的活。统一从 inFlight 计数 / 工具频次 / 重复阈值 / 耗时合计里剔除，
    // 明细 latest 里仍保留（调用过就是事实），由 selfNote 说明剔除了几次。
    // 原实现只剔除「取数时自身 in-flight 的 activity_report」；task_verdict 落地后必须扩展 ——
    // 否则每写一次验收结论，都会往工具频次与 durationMs 里加一笔监控自己的开销。
    const MONITOR_TOOLS = new Set(['activity_report', 'task_verdict', 'evolution_proposal']);
    const selfRows = scope.filter((r) => r.kind === 'tool' && MONITOR_TOOLS.has(r.name));
    const selfRowSet = new Set(selfRows);
    const inFlightOther = inFlight.filter((r) => !MONITOR_TOOLS.has(r.name));
    const toolRows = toolRowsAll.filter((r) => !MONITOR_TOOLS.has(r.name));
    const selfNote = selfRows.length
        ? `已从 inFlight 计数 / 工具频次 / 耗时合计中剔除本插件自身的工具调用 ${selfRows.length} 次`
            + `（${[...new Set(selfRows.map((r) => r.name))].join('、')}）—— 那是监控自身的记账，不算任务活动`
        : undefined;
    const turnsSet = new Set(scope.map((r) => r.turn).filter((t) => t != null));
    const inputTokens = llm.reduce((n, r) => n + (r.usageIn ?? 0), 0);
    const outputTokens = llm.reduce((n, r) => n + (r.usageOut ?? 0), 0);
    // 时长双口径（#1）：
    //  durationMs = 活跃调用耗时之和（仅已定稿 llm+tool 行；进行中调用未定稿、不计入）
    //  spanMs    = 本运行首→末事件的墙钟跨度（含空闲等待，≈ 会话实际时间轴）
    const settled = scope.filter((r) => r.settled !== false && !selfRowSet.has(r));
    const durationMs = settled.reduce((n, r) => n + (r.durationMs ?? 0), 0);
    const firstTs = scope.length ? Math.min(...scope.map((r) => r.ts)) : 0;
    const lastTs = scope.length ? Math.max(...scope.map((r) => (r.durationMs ? r.ts + r.durationMs : r.ts))) : 0;
    const spanMs = scope.length ? Math.max(0, lastTs - firstTs) : 0;
    // 工具按名聚合（本运行；已剔除 selfRows）
    const byNameMap = new Map();
    for (const t of toolRows) {
        let e = byNameMap.get(t.name);
        if (!e) {
            e = { name: t.name, count: 0, failed: 0, msSum: 0, lastMs: 0, measured: 0 };
            byNameMap.set(t.name, e);
        }
        e.count++;
        if (t.ok === false)
            e.failed++;
        // 只累加已定稿行的耗时（进行中行无 durationMs，不拉低均值）
        if (t.settled !== false && t.durationMs != null) {
            e.msSum += t.durationMs;
            e.measured++;
            e.lastMs = t.durationMs;
        }
    }
    const byName = [...byNameMap.values()]
        .map((e) => ({ name: e.name, count: e.count, failed: e.failed, avgMs: e.measured ? Math.round(e.msSum / e.measured) : 0, lastMs: e.lastMs }))
        .sort((a, b) => b.count - a.count);
    const duplicated = byName.filter((e) => e.count >= dupT);
    const failures = failed.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, name: r.name, summary: (r.summary || '').slice(0, 160) })).slice(0, maxF);
    const failuresTruncated = failed.length > maxF ? { total: failed.length, shown: maxF } : undefined;
    // ── L1 失败聚类：按签名聚合同类失败 ──
    // 只做「同现统计」（同一签名出现几次、跨几个轮次），不推断原因 —— 因果结论不是这份数据能给的。
    const clusterMap = new Map();
    for (const r of failed) {
        // 历史行没有 failSig：单列 legacy 簇（用摘要归一化做键），绝不冒充真签名
        const sig = r.failSig ?? `${r.name}|legacy|${normalizeErrorText(r.summary || '')}`;
        const [tool = r.name, errClass = 'legacy'] = sig.split('|');
        let c = clusterMap.get(sig);
        if (!c) {
            c = { sig, tool, errClass, count: 0, turns: new Set(), firstSeq: r.seq, lastSeq: r.seq, exampleSeqs: [], sampleSummary: (r.summary || '').slice(0, 120) };
            clusterMap.set(sig, c);
        }
        c.count++;
        if (r.turn != null)
            c.turns.add(r.turn);
        c.firstSeq = Math.min(c.firstSeq, r.seq);
        c.lastSeq = Math.max(c.lastSeq, r.seq);
        if (c.exampleSeqs.length < 3 && !c.exampleSeqs.includes(r.seq))
            c.exampleSeqs.push(r.seq);
    }
    const failureClusters = [...clusterMap.values()]
        .filter((c) => c.count >= clusterMin)
        .sort((a, b) => b.count - a.count || a.firstSeq - b.firstSeq)
        .slice(0, maxClusters)
        .map((c) => ({
        sig: c.sig, tool: c.tool, errClass: c.errClass, count: c.count,
        turns: [...c.turns].sort((x, y) => x - y),
        firstSeq: c.firstSeq, lastSeq: c.lastSeq, exampleSeqs: c.exampleSeqs, sampleSummary: c.sampleSummary,
    }));
    // ── L2 验收结论：只读 kind === 'verdict' 的行 ──
    // 它与 failed / durationMs 完全解耦：不打 ok、不带 durationMs（见 types.ts 的取舍说明）
    const verdicts = scope
        .filter((r) => r.kind === 'verdict' && !!r.verdict)
        .sort((a, b) => a.ts - b.ts)
        .slice(-20)
        .map((r) => ({
        seq: r.seq,
        ts: r.ts,
        status: String(r.verdict.status),
        basis: String(r.verdict.basis ?? '').slice(0, 500),
        evidenceSeqs: r.verdict.evidenceSeqs ?? [],
    }));
    const lastVerdict = verdicts.length ? verdicts[verdicts.length - 1] : undefined;
    // 只有在「完全没有验收结论」时才给过程推断，并且自带「这不是结论」的说明
    let likelyOutcome;
    if (!lastVerdict && scope.length > 0) {
        const reasons = [];
        reasons.push(failed.length > 0 ? `${failed.length} 条调用失败` : '未见失败调用');
        if (inFlightOther.length > 0)
            reasons.push(`${inFlightOther.length} 条调用仍在进行中`);
        reasons.push('本次范围内没有任何验收结论（verdict），以下只是过程推断');
        likelyOutcome = {
            label: failed.length === 0 && inFlightOther.length === 0 ? 'likely-pass' : 'likely-fail',
            confidence: 'low',
            reasons,
        };
    }
    // ── L6 进化提案（只报数，不执行） ──
    // 创建行（transitionOf 为空）是「提案」本身；带 transitionOf 的是状态变更行，不单列。
    const effProposal = effectiveProposalStatus(scope);
    const proposals = scope
        .filter((r) => r.kind === 'proposal' && !!r.proposal && r.proposal?.transitionOf == null)
        .slice(-20)
        .map((r) => {
        const p = r.proposal;
        const key = String(p.id ?? `session:${r.seq}`);
        return {
            seq: r.seq,
            ts: r.ts,
            pkind: String(p.pkind),
            action: String(p.action),
            target: String(p.target ?? ''),
            rationale: String(p.rationale ?? ''),
            status: String(p.status),
            by: String(p.by),
            id: String(p.id ?? ''),
            effectiveStatus: effProposal.get(key)?.status ?? String(p.status),
            evidenceSeqs: Array.isArray(p.evidenceSeqs) ? p.evidenceSeqs : [],
        };
    });
    const pendingProposals = proposals.filter((p) => p.effectiveStatus === 'proposed').length;
    // ── L3 工具级「同现」统计（只用已有数据，不新增采集） ──
    const maxTurnOfSession = new Map();
    for (const r of scope) {
        if (r.turn == null)
            continue;
        const sid = r.sessionId ?? '';
        maxTurnOfSession.set(sid, Math.max(maxTurnOfSession.get(sid) ?? 0, r.turn));
    }
    /** 每个轮次里出现过哪些验收结论状态（同一轮可能有多条 verdict） */
    const verdictStatusByTurn = new Map();
    for (const r of scope) {
        if (r.kind !== 'verdict' || r.turn == null || !r.verdict)
            continue;
        const k = `${r.sessionId ?? ''}|${r.turn}`;
        const set = verdictStatusByTurn.get(k) ?? new Set();
        set.add(String(r.verdict.status));
        verdictStatusByTurn.set(k, set);
    }
    const outcomeByName = new Map();
    const seenPerTurn = new Map();
    for (const t of toolRows) {
        let e = outcomeByName.get(t.name);
        if (!e) {
            e = { calls: 0, failed: 0, inFinalTurn: 0, retriedInTurn: 0, inTurnWithVerdictPass: 0, inTurnWithVerdictFail: 0 };
            outcomeByName.set(t.name, e);
        }
        e.calls++;
        if (t.ok === false)
            e.failed++;
        if (t.turn != null) {
            const sid = t.sessionId ?? '';
            if (t.turn === maxTurnOfSession.get(sid))
                e.inFinalTurn++;
            const st = verdictStatusByTurn.get(`${sid}|${t.turn}`);
            if (st?.has('pass'))
                e.inTurnWithVerdictPass++;
            if (st?.has('fail'))
                e.inTurnWithVerdictFail++;
            // 同轮重复：第 2 次起累加（次数 - 1 的和）
            const tk = `${sid}|${t.turn}|${t.name}`;
            const n = (seenPerTurn.get(tk) ?? 0) + 1;
            seenPerTurn.set(tk, n);
            if (n > 1)
                e.retriedInTurn++;
        }
    }
    const toolOutcome = [...outcomeByName.entries()]
        .map(([name, e]) => ({ name, ...e }))
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    // ── L4 技能加载前后窗口对比 ──
    const skillLoads = scope
        .filter((r) => r.tag === 'skill')
        .map((r) => ({
        name: (r.summary || '').replace(/^skill:\s*/, '').trim() || '(未命名)',
        seq: r.seq,
        ts: r.ts,
        turn: r.turn ?? 0,
    }));
    /** 给定轮次集合的指标；窗口内一行都没有 → 缺省（不填 0） */
    const metricOfTurns = (turns) => {
        const set = new Set(turns);
        const rowsIn = scope.filter((r) => r.turn != null && set.has(r.turn));
        if (rowsIn.length === 0)
            return undefined;
        const inLlm = rowsIn.filter((r) => r.kind === 'llm');
        return {
            turns: new Set(rowsIn.map((r) => r.turn)).size,
            toolCalls: rowsIn.filter((r) => r.kind === 'tool').length,
            failedCalls: rowsIn.filter((r) => r.ok === false).length,
            inputTokens: inLlm.reduce((n, r) => n + (r.usageIn ?? 0), 0),
        };
    };
    const skillEffect = [];
    const skillSeen = new Set();
    for (const load of skillLoads) {
        if (skillSeen.has(load.name))
            continue;
        skillSeen.add(load.name);
        // 锚点 = 该技能首次加载所在轮次；同技能多次加载只做一次对比，次数记在 loads
        const anchor = load.turn;
        const beforeTurns = anchor > 1
            ? [...Array(skillWindow).keys()].map((i) => anchor - skillWindow + i).filter((t) => t >= 1)
            : [];
        const afterTurns = anchor >= 1 ? [...Array(skillWindow).keys()].map((i) => anchor + 1 + i) : [];
        skillEffect.push({
            name: load.name,
            loads: skillLoads.filter((l) => l.name === load.name).length,
            windowBefore: beforeTurns.length ? metricOfTurns(beforeTurns) : undefined,
            windowAfter: afterTurns.length ? metricOfTurns(afterTurns) : undefined,
        });
    }
    // 上下文压力 = 本运行内最后一个带 contextBytes 的 llm 行（按 ts 最大）
    const ctxRows = llm.filter((r) => r.contextBytes != null);
    const lastCtx = ctxRows.length ? ctxRows.reduce((a, b) => (a.ts > b.ts ? a : b)) : undefined;
    // 预算口径澄清（#6）：300KB 是「监控截断预算」——超过它监控会省略早期消息，
    // 与模型自身上下文窗口无关；pressure 只反映监控缓冲占用，不代表真实余量。
    const budgetLabel = `监控截断预算 ${fmtBytes(contextBudgetBytes)}（非模型真实上下文窗口）`;
    const context = { budgetBytes: contextBudgetBytes, budgetLabel, truncated: false, note: undefined };
    if (lastCtx) {
        const cb = lastCtx.contextBytes ?? 0;
        context.lastTurn = lastCtx.turn;
        context.lastContextBytes = cb;
        context.lastContextMessages = lastCtx.contextMessages;
        context.pressure = Math.round((cb / contextBudgetBytes) * 100) / 100;
        const om = lastCtx.contextOmitted ?? 0;
        context.truncated = om > 0;
        const pct = Math.round((cb / contextBudgetBytes) * 100);
        context.note =
            `最后一次模型请求上下文 ${fmtBytes(cb)}，占${budgetLabel}的 ${pct}%`
                + `${om ? `，其中 ${om} 条早期消息已被监控省略（模型仍可能持有完整上下文）` : ''}`
                + ` —— 该口径衡量的是监控缓冲压力，不代表模型真实上下文余量`;
    }
    // 陈述性信号（只陈述事实 + 阈值判断；自我观测噪音不进 signals，走 selfNote）
    const signals = [];
    for (const d of duplicated)
        signals.push({ severity: 'info', text: `工具 ${d.name} 已被调用 ${d.count} 次（其中 ${d.failed} 次失败）` });
    for (const e of byName)
        if (e.failed >= failT)
            signals.push({ severity: 'warn', text: `工具 ${e.name} 已失败 ${e.failed} 次，最近一次耗时 ${e.lastMs}ms —— 命令/参数可能不稳定，可先单次确认再批量执行` });
    if (context.lastContextBytes != null && ((context.pressure ?? 0) >= pressT || context.truncated)) {
        signals.push({ severity: 'warn', text: `${context.note ?? ''}${context.truncated ? `，且监控侧已触发截断（早期消息被整条省略）` : ''} —— 可考虑压缩上下文或重开会话` });
    }
    if (failed.length > 0)
        signals.push({ severity: 'warn', text: `本运行范围内 ${failed.length} 条调用处于失败状态（详见 failures）` });
    if (inFlightOther.length > 0)
        signals.push({ severity: 'info', text: `当前有 ${inFlightOther.length} 条调用进行中（尚未定稿，durationMs 暂不含它们）` });
    if (crossRun)
        signals.push({ severity: 'info', text: `数据跨 ${1 + new Set(hist.map((r) => r.runId ?? '(unknown)')).size} 个进程运行（重启前后），totals 只统计本运行；历史片段见 history 字段` });
    // 失败聚类信号：只陈述「同一签名重复了几次、跨几个轮次」，不写因果
    for (const c of failureClusters.slice(0, 3)) {
        signals.push({ severity: 'warn', text: `同一失败签名重复 ${c.count} 次（工具 ${c.tool} · ${c.turns.length} 个轮次）：${c.sig} —— 同类错误反复出现，先确认是不是同一个原因再重试` });
    }
    if (failureClusters.length > 3)
        signals.push({ severity: 'warn', text: `另有 ${failureClusters.length - 3} 个失败签名簇（见 failureClusters 字段）` });
    if (failuresTruncated)
        signals.push({ severity: 'info', text: `failures 明细只列了前 ${failuresTruncated.shown} 条（共 ${failuresTruncated.total} 条）；failureClusters 覆盖全部失败` });
    if (lastVerdict && lastVerdict.status !== 'pass' && lastVerdict.status !== 'unknown') {
        signals.push({ severity: 'warn', text: `最近一次验收结论为 ${lastVerdict.status}：${lastVerdict.basis}` });
    }
    if (likelyOutcome)
        signals.push({ severity: 'info', text: `过程推断（非验收结论，置信度 low）：${likelyOutcome.label} —— ${likelyOutcome.reasons.join('；')}` });
    // 历史运行单列（#5）：按 runId 分组（旧版无 runId 的行归 '(unknown)'），只给计数与时间轴，不并入 totals
    let history;
    if (crossRun) {
        const byRun = new Map();
        for (const r of hist) {
            const key = r.runId ?? '(unknown)';
            let e = byRun.get(key);
            if (!e) {
                e = { rows: 0, firstTs: Infinity, lastTs: 0, llm: 0, tool: 0, failed: 0 };
                byRun.set(key, e);
            }
            e.rows++;
            e.firstTs = Math.min(e.firstTs, r.ts);
            e.lastTs = Math.max(e.lastTs, r.durationMs ? r.ts + r.durationMs : r.ts);
            if (r.kind === 'llm')
                e.llm++;
            if (r.kind === 'tool')
                e.tool++;
            if (r.ok === false)
                e.failed++;
        }
        history = {
            runs: [...byRun.entries()]
                .map(([runId, e]) => ({ runId, rows: e.rows, firstTs: e.firstTs, lastTs: e.lastTs, llmCalls: e.llm, toolCalls: e.tool, failedCalls: e.failed }))
                .sort((a, b) => a.firstTs - b.firstTs),
        };
    }
    const latest = [...scope].sort((a, b) => b.ts - a.ts).slice(0, 12)
        .map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, name: r.name, tag: r.tag, summary: (r.summary || '').slice(0, 120), ok: r.ok, turn: r.turn }));
    const report = {
        sessionId: input.sessionId,
        generatedAt: Date.now(),
        scope: scopeLabel,
        // 与上面切分用的基准一致：指定 runId 时报告自称的就是那个运行，不能写死本进程 id
        runId,
        crossRun,
        totals: { llmCalls: llm.length, toolCalls: toolRows.length, failedCalls: failed.length, turns: turnsSet.size, inFlight: inFlightOther.length, inputTokens, outputTokens, durationMs, spanMs },
        tools: { byName, duplicated },
        failures,
        failuresTruncated,
        failureClusters,
        verdicts,
        lastVerdict,
        likelyOutcome,
        toolOutcome,
        skillLoads,
        skillEffect,
        crossSessions: input.cross,
        proposals,
        pendingProposals,
        context,
        inFlight: inFlightOther.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, name: r.name, summary: (r.summary || '').slice(0, 120), startedAt: r.ts })),
        signals,
        selfNote,
        history,
        latest,
    };
    // 该报告里所有字段都是可 JSON 化的普通数据，JSON round-trip 只做一件事：
    // 剔除值为 undefined 的键（context.note / context.pressure / selfNote / history /
    // latest[].ok / latest[].turn 缺省时），使其满足「无失真 JSON」（dsh-tools 输出校验的要求）。
    // 空数组（byName / failures …）原样保留。
    return JSON.parse(JSON.stringify(report));
}
