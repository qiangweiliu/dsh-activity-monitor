// 集成测试：真实 dsh-tools ToolRuntime 下，activity_report 工具注册 + 经注册表 execute + 输出 schema 校验
// 用唯一 session id 隔离历史 JSONL，保证每次运行计数干净、可断言；退出前清理自己写的历史文件。
import { unlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as os from 'node:os';
import { Context, Service } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, validateJsonSchemaValue, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
const monitor = await import('./index.js');
const SID = `sess-smoke-${Date.now()}`;
// 历史目录与 index.ts 保持一致（$DSH_HOME ?? ~/.dsh）/activity-monitor/<sid>.jsonl
const histFile = path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.dsh'), 'activity-monitor', `${SID}.jsonl`);
/** 退出前清理本测试写的历史文件，保持环境干净；再退出。 */
function finish(code) {
    try {
        unlinkSync(histFile);
    }
    catch { /* 不存在或删不掉都不影响 */ }
    process.exit(code);
}
const ctx = new Context();
await ctx.plugin(SystemPrompt, { personaPrefix: '' });
await ctx.plugin(ToolRuntime);
const captured = [];
const fakeWebServer = { register: (r) => { captured.push(r); return () => { }; } };
class FakeWS extends Service {
    static inject = [];
    constructor(c) { super(c, 'webServer'); c.webServer = fakeWebServer; }
}
await ctx.plugin(FakeWS);
const fiber = ctx.plugin(monitor);
await fiber;
console.log('monitor state:', fiber.state, '(2=ACTIVE)');
await new Promise((r) => setTimeout(r, 200)); // 等子 fiber 注册 activity_report
const tools = ctx.tools;
const names = (tools.schemas() ?? []).map((s) => s.name);
console.log('registered tools:', JSON.stringify(names));
if (!names.includes('activity_report')) {
    console.error('FAIL: activity_report 未注册');
    finish(1);
}
// ── 造干净的内存数据：1 次 llm 请求 + 2 次 bash 工具调用（全部属会话 SID） ──
const fakeStream = function* () {
    yield { type: 'text-delta', index: 0, text: 'hi' };
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } };
    yield { type: 'block-end', index: 0 };
};
const options = {
    provider: 'deepseek', model: 'v3',
    messages: [
        { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
        { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    ],
    tools: [{ name: 'bash', description: 'shell' }],
    sessionId: SID,
};
const rootNext = async function* () { yield* fakeStream(); };
for await (const _ of ctx.waterfall('llm/stream', options, rootNext)) { /* drain */ }
const toolRoot = async () => ({ isError: false, content: [{ type: 'text', text: 'file a\nfile b' }], value: 'file a\nfile b' });
for (let i = 0; i < 2; i++) {
    const execCtx = { name: 'bash', arguments: { command: `ls ${i}` }, agent: { session: { id: SID } } };
    await ctx.waterfall('tools/execute', execCtx, toolRoot);
}
await new Promise((r) => setTimeout(r, 50));
// ── 走注册表完整路径：validate args → execute → output schema check → render ──
const result = await tools.execute({
    callId: 'call-ar-1',
    name: 'activity_report',
    arguments: { sessionId: SID },
    agent: { session: { id: SID } },
    signal: new AbortController().signal,
});
console.log('execute isError:', result?.isError, result?.error?.message ?? '');
if (result?.isError) {
    console.error('FAIL: activity_report 执行报错');
    finish(1);
}
// output schema 是 { report: json }，execute 返回 value = { report: AgentReport }
const report = (result?.value ?? result?.content)?.report;
console.log('report totals:', JSON.stringify(report?.totals));
console.log('report scope:', report?.scope, '· session:', report?.sessionId);
console.log('report tools.byName:', JSON.stringify(report?.tools?.byName));
console.log('report signals:', JSON.stringify(report?.signals));
console.log('report context:', JSON.stringify(report?.context));
// ── 真实断言（结构 + 关键数值） ──
let fails = 0;
const check = (cond, label) => { if (!cond) {
    fails++;
    console.error('  ✗', label);
}
else
    console.log('  ✓', label); };
check(!!report, 'report 存在');
check(report?.sessionId === SID, 'sessionId 匹配');
check(report?.scope === '全量', '默认全量范围');
check(report?.crossRun === false, '同进程运行内无跨重启片段');
check(typeof report?.runId === 'string' && report.runId.length > 0, 'runId 已随运行生成');
check(report?.totals?.llmCalls === 1, `llmCalls=1（实 ${report?.totals?.llmCalls}）`);
check(report?.totals?.inputTokens === 120 && report?.totals?.outputTokens === 8, 'token 聚合正确');
const bash = (report?.tools?.byName ?? []).find((e) => e.name === 'bash');
check(bash?.count === 2, `bash 工具频次=2（实 ${bash?.count}）`);
// 自我观测剔除：本报告的生成调用（activity_report）自身 in-flight，不进 inFlight 计数，走 selfNote 说明
check((report?.inFlight?.length ?? 0) === 0, `inFlight 不含自身（实 ${report?.inFlight?.length}）`);
check(typeof report?.selfNote === 'string', 'selfNote 说明本次调用自身已剔除');
// 时长双口径
check(typeof report?.totals?.spanMs === 'number' && report.totals.spanMs >= 0, 'spanMs 墙钟跨度存在');
check(typeof report?.totals?.durationMs === 'number', 'durationMs 活跃耗时存在');
// 无失败调用（干净会话）
check(report?.totals?.failedCalls === 0, 'failedCalls=0（干净会话）');
// 参数 schema 校验（schemas() 只回模型侧三要素，parameters 已编译为 raw JSON Schema）
const def = (tools.schemas() ?? []).find((x) => x.name === 'activity_report');
assertSupportedJsonSchema(def.parameters);
const argViolations = validateJsonSchemaValue(def.parameters, { sessionId: SID, recentTurns: 3 }, 'arguments');
check(argViolations.length === 0, `参数 schema 校验通过（violations ${argViolations.length}）`);
console.log('param schema violations:', argViolations.length === 0 ? '(none — PASS)' : JSON.stringify(argViolations));
// ── L1/L2 新增能力：失败签名聚类 + task_verdict（只加不删的集成回归锚） ──
const runReport = async (extra = {}) => {
    const r = await tools.execute({
        callId: 'call-ar-x', name: 'activity_report', arguments: { sessionId: SID, ...extra },
        agent: { session: { id: SID } }, signal: new AbortController().signal,
    });
    return (r?.value ?? r?.content)?.report;
};
// 两次「只有路径不同」的失败：归一化后应落进同一个签名簇
const failRoot = async () => ({
    isError: true,
    content: [{ type: 'text', text: `Error: ENOENT: no such file or directory, open /tmp/smoke-${Math.random()}/x.txt` }],
});
for (let i = 0; i < 2; i++) {
    const execCtx = { name: 'bash', arguments: { command: `cat /tmp/smoke/${i}.txt` }, agent: { session: { id: SID } } };
    await ctx.waterfall('tools/execute', execCtx, failRoot);
}
const repBefore = await runReport();
check(repBefore?.totals?.failedCalls === 2, `新造 2 次失败调用（实 ${repBefore?.totals?.failedCalls}）`);
check((repBefore?.failures?.[0]?.seq ?? 0) > 0, 'failures 里有行 seq 可当证据');
const durBefore = repBefore?.totals?.durationMs;
const evidenceSeq = repBefore?.failures?.[0]?.seq ?? 0;
const vdef = (tools.schemas() ?? []).find((x) => x.name === 'task_verdict');
check(!!vdef, 'task_verdict 已注册（agent 侧唯一写入口）');
if (vdef) {
    assertSupportedJsonSchema(vdef.parameters);
    check(validateJsonSchemaValue(vdef.parameters, { status: 'pass', basis: 'x' }, 'arguments').length === 0, 'task_verdict 最小合法参数通过 schema');
    check(validateJsonSchemaValue(vdef.parameters, { status: 'nope', basis: 'x' }, 'arguments').length > 0, '非法 status 被 enum 拦住');
    check(validateJsonSchemaValue(vdef.parameters, { status: 'pass', basis: 'x', evidenceSeqs: ['12'] }, 'arguments').length > 0, 'evidenceSeqs 非数字被拦住');
}
const vres = await tools.execute({
    callId: 'call-tv-1', name: 'task_verdict',
    arguments: { status: 'fail', basis: '冒烟：同类 ENOENT 重复出现', evidenceSeqs: [evidenceSeq], verifyCommand: 'node lib/smoke-tools.js' },
    agent: { session: { id: SID } }, signal: new AbortController().signal,
});
check(!!vres && !vres.isError, `task_verdict 执行成功（${vres?.isError ? vres?.error?.message : 'ok'}）`);
const repAfter = await runReport();
check(repAfter?.verdicts?.length === 1, `verdicts 记录 1 条（实 ${repAfter?.verdicts?.length}）`);
check(repAfter?.lastVerdict?.status === 'fail', `lastVerdict.status=fail（实 ${repAfter?.lastVerdict?.status}）`);
check(repAfter?.lastVerdict?.seq === vres?.value?.verdict?.seq, 'verdict 回执 seq 与报告一致');
check(repAfter?.totals?.failedCalls === repBefore?.totals?.failedCalls, `verdict 不增加 failedCalls（${repBefore?.totals?.failedCalls} → ${repAfter?.totals?.failedCalls}）`);
check(repAfter?.totals?.durationMs === durBefore, `verdict 不增加 durationMs（${durBefore} → ${repAfter?.totals?.durationMs}）`);
check((repAfter?.failureClusters?.length ?? 0) === 1, `同类失败聚成 1 簇（实 ${repAfter?.failureClusters?.length}）`);
check(repAfter?.failureClusters?.[0]?.count === 2, `簇内 2 条（实 ${repAfter?.failureClusters?.[0]?.count}）`);
check((repAfter?.failures?.length ?? 0) >= 2, `failures 原样保留（实 ${repAfter?.failures?.length}）`);
check(String(repAfter?.failureClusters?.[0]?.sig ?? '').includes('<path>'), `签名已把路径归一化：${repAfter?.failureClusters?.[0]?.sig}`);
check(repAfter?.likelyOutcome === undefined, '有验收结论时不给过程推断（不猜）');
// ── L3/L4：工具级同现统计 + 技能加载前后窗口（走真实钩子造数据） ──
const skillRoot = async () => ({ isError: false, content: [{ type: 'text', text: 'skill loaded' }], value: 'skill loaded' });
await ctx.waterfall('tools/execute', { name: 'skill', arguments: { name: 'smoke-demo' }, agent: { session: { id: SID } } }, skillRoot);
const repL34 = await runReport();
check((repL34?.skillLoads ?? []).some((s) => s.name === 'smoke-demo'), `skillLoads 记录 skill 加载（实 ${JSON.stringify(repL34?.skillLoads)}）`);
check((repL34?.skillEffect ?? []).length === 1, `skillEffect 生成 1 条对比（实 ${(repL34?.skillEffect ?? []).length}）`);
const bashOut = (repL34?.toolOutcome ?? []).find((e) => e.name === 'bash');
check(!!bashOut, 'toolOutcome 里有 bash');
check((bashOut?.failed ?? 0) >= 2, `toolOutcome 的 bash 失败数 ≥2（实 ${bashOut?.failed}）`);
check((bashOut?.retriedInTurn ?? 0) >= 1, `bash 同轮重试 ≥1（实 ${bashOut?.retriedInTurn}）`);
check((bashOut?.inTurnWithVerdictFail ?? 0) >= 1, `bash 出现在带 fail 验收的轮次里（实 ${bashOut?.inTurnWithVerdictFail}）`);
check(!(repL34?.toolOutcome ?? []).some((e) => e.name === 'task_verdict' || e.name === 'activity_report'), '本插件自身工具不进 toolOutcome');
check(Object.prototype.hasOwnProperty.call(repL34 ?? {}, 'toolOutcome'), '报告含 toolOutcome 字段（契约只加不删）');
// ── L6：进化提案（本插件只写提案，不执行任何变更） ──
const pdef = (tools.schemas() ?? []).find((x) => x.name === 'evolution_proposal');
check(!!pdef, 'evolution_proposal 已注册（进化提案入口）');
if (pdef) {
    assertSupportedJsonSchema(pdef.parameters);
    check(validateJsonSchemaValue(pdef.parameters, { pkind: 'skill', action: 'create', target: 'x', rationale: 'y' }, 'arguments').length === 0, 'evolution_proposal 最小合法参数通过 schema');
    check(validateJsonSchemaValue(pdef.parameters, { pkind: 'nope', action: 'create', target: 'x', rationale: 'y' }, 'arguments').length > 0, '非法 pkind 被 enum 拦住');
    check(validateJsonSchemaValue(pdef.parameters, { pkind: 'skill', action: 'nope', target: 'x', rationale: 'y' }, 'arguments').length > 0, '非法 action 被 enum 拦住');
}
const durBeforeProposal = (await runReport())?.totals?.durationMs;
const pres = await tools.execute({
    callId: 'call-ep-1', name: 'evolution_proposal',
    arguments: {
        pkind: 'skill', action: 'create', target: 'smoke-proposal-skill',
        rationale: '冒烟：同一 ENOENT 签名重复 2 次，建议把这条契约写成技能',
        evidenceSeqs: [evidenceSeq], expectedEffect: '该签名 7 天内归零',
        verifyCommands: ['node lib/smoke-tools.js'], rollbackPlan: '删除该技能目录',
    },
    agent: { session: { id: SID } }, signal: new AbortController().signal,
});
check(!!pres && !pres.isError, `evolution_proposal 执行成功（${pres?.isError ? pres?.error?.message : 'ok'}）`);
const repP = await runReport();
check((repP?.proposals?.length ?? 0) === 1, `proposals 记录 1 条（实 ${repP?.proposals?.length ?? 0}）`);
check(repP?.pendingProposals === 1, `pendingProposals=1（待人工批准，实 ${repP?.pendingProposals}）`);
check(repP?.proposals?.[0]?.status === 'proposed', '提案状态固定 proposed（agent 不能自证已执行）');
check(repP?.proposals?.[0]?.evidenceSeqs?.[0] === evidenceSeq, '提案能指回证据行 seq');
check(repP?.totals?.failedCalls === 2, `提案不增加 failedCalls（实 ${repP?.totals?.failedCalls}）`);
check(repP?.totals?.durationMs === durBeforeProposal, `提案不增加 durationMs（${durBeforeProposal} → ${repP?.totals?.durationMs}）`);
check(!(repP?.toolOutcome ?? []).some((e) => e.name === 'evolution_proposal'), '提案工具自身不进 toolOutcome');
check(Object.prototype.hasOwnProperty.call(repP ?? {}, 'proposals'), '报告含 proposals 字段（契约只加不删）');
// ── L6 端点：人工批准 / 否决（真实走 handler：body 解析 → 找行 → 追加变更行 → 回带轻行） ──
// 为什么在冒烟里做：「状态变更只能走人工端点」这条边界，只有把 handler 真跑一遍才算验过。
const propRoute = captured.find((r) => r.path === '/api/activity-monitor/proposal');
check(!!propRoute, 'proposal 路由已注册（人工状态变更入口）');
if (propRoute) {
    const fakeRes = () => {
        const out = { status: 0, body: null };
        out.writeHead = (code) => { out.status = code; return out; };
        out.end = (chunk) => { out.body = chunk ? JSON.parse(chunk) : null; };
        return out;
    };
    // 造一个够用的 IncomingMessage：method / headers / 可读事件
    const fakeReq = (method, ctype, payload) => {
        const r = new EventEmitter();
        r.method = method;
        r.headers = ctype ? { 'content-type': ctype } : {};
        r.destroy = () => { };
        setTimeout(() => {
            if (payload !== undefined)
                r.emit('data', Buffer.from(JSON.stringify(payload)));
            r.emit('end');
        }, 0);
        return r;
    };
    const call = async (method, ctype, payload) => {
        const res = fakeRes();
        await propRoute.handler(fakeReq(method, ctype, payload), res);
        return res;
    };
    const r405 = await call('GET', undefined);
    check(r405.status === 405, `非 POST 被拒（实 ${r405.status}）`);
    const r415 = await call('POST', 'text/plain', { seq: 1, status: 'approved' });
    check(r415.status === 415, `缺 application/json 被拒（实 ${r415.status}）`);
    const rBad = await call('POST', 'application/json', { seq: 1, status: 'proposed' });
    check(rBad.status === 400 && /status 必须是/.test(String(rBad.body?.error)), `人工端点不接受 proposed（实 ${rBad.status} / ${String(rBad.body?.error)}）`);
    const r404 = await call('POST', 'application/json', { id: 'p-不存在', status: 'approved' });
    check(r404.status === 404, `指不到提案时 404（实 ${r404.status}）`);
    // 拿冒烟自己写的那条提案，走一遍真实批准
    const before = await runReport();
    const target = (before?.proposals ?? [])[0];
    check(typeof target?.seq === 'number', `存在可批准的提案（seq ${target?.seq}）`);
    const rOk = await call('POST', 'application/json', { seq: target?.seq, status: 'approved' });
    check(rOk.status === 200 && rOk.body?.ok === true, `按 seq 批准成功（实 ${rOk.status}，变更行 seq ${rOk.body?.seq}）`);
    check(rOk.body?.row?.proposal?.transitionOf === target?.seq, '回带轻行含 transitionOf（面板可直接并进本地）');
    const after = await runReport();
    check(after?.pendingProposals === 0, `批准后 pendingProposals=0（实 ${after?.pendingProposals}）`);
    check((after?.proposals ?? [])[0]?.status === 'proposed', '原提案行不动（append-only）');
    check((after?.proposals ?? [])[0]?.effectiveStatus === 'approved', `有效状态=approved（实 ${(after?.proposals ?? [])[0]?.effectiveStatus}）`);
    check(after?.totals?.durationMs === before?.totals?.durationMs, `状态变更不带 durationMs（${before?.totals?.durationMs} → ${after?.totals?.durationMs}）`);
    // 再否决一次：同一 id 取最新一条 → 有效状态回到 rejected，且不新增提案条目
    const rRej = await call('POST', 'application/json', { id: target?.id, status: 'rejected' });
    check(rRej.status === 200, `按 id 否决成功（实 ${rRej.status}）`);
    const after2 = await runReport();
    check((after2?.proposals ?? [])[0]?.effectiveStatus === 'rejected', `最新一条说了算（实 ${(after2?.proposals ?? [])[0]?.effectiveStatus}）`);
    check((after2?.proposals ?? []).length === 1, `变更行不单列成新提案（实 ${(after2?.proposals ?? []).length}）`);
}
// ── L5 跨会话聚合（真跑：首次读盘 / 第二次命中 summaries.json） ──
// 说明：缓存文件与真实运行共用（<历史目录>/summaries.json）。它只是可重建的加速层，
// 不参与任何事实口径 —— 删掉它只是下次慢一点（单测里覆盖了坏文件/旧版本/键失效三条路径）。
const noCross = await runReport();
check(noCross?.crossSessions === undefined, '没传 crossSessions 就不给这个字段（不请求就不说）');
const l5a = await runReport({ crossSessions: 3 });
check(!!l5a?.crossSessions, 'crossSessions 字段出现（显式请求才给）');
check(l5a?.crossSessions?.limit === 3, `limit 生效（实 ${l5a?.crossSessions?.limit}）`);
check((l5a?.crossSessions?.sessions?.length ?? 0) <= 3, `会话数 ≤ limit（实 ${l5a?.crossSessions?.sessions?.length}）`);
const own = (l5a?.crossSessions?.sessions ?? []).find((s) => s.sessionId === SID);
check(!!own, `本会话出现在跨会话汇总里（${own?.sessionId}）`);
check(typeof own?.rows === 'number' && typeof own?.turns === 'number' && typeof own?.failedCalls === 'number', `会话汇总字段齐全（${own?.rows} 行 · 轮 ${own?.turns} · 失败 ${own?.failedCalls}）`);
check((own?.rows ?? 0) >= 1, `正在跑的会话走内存行：汇总不为空（${own?.rows} 行）`);
check((own?.failSigs?.length ?? 0) >= 1, `会话内失败按签名聚合（${own?.failSigs?.length} 个签名）`);
check((l5a?.crossSessions?.scanned?.live ?? 0) >= 1, `内存行路径生效（live ${l5a?.crossSessions?.scanned?.live}）`);
check(Array.isArray(l5a?.crossSessions?.recurring), 'recurring 是数组（跨会话复现的失败签名）');
check(l5a?.crossSessions?.scanned?.badLines === 0, `跨会话读取无坏行（实 ${l5a?.crossSessions?.scanned?.badLines}）`);
check(l5a?.crossSessions?.cache?.errors === 0, `缓存无错误（errors ${l5a?.crossSessions?.cache?.errors}）`);
// 第二次：文件没长 → 不该再读盘（这就是缓存存在的意义）
const l5b = await runReport({ crossSessions: 3 });
check((l5b?.crossSessions?.scanned?.reused ?? 0) >= 1, `第二次命中缓存（复用 ${l5b?.crossSessions?.scanned?.reused} · 读盘 ${l5b?.crossSessions?.scanned?.read}）`);
check(l5b?.crossSessions?.cache?.hits > l5a?.crossSessions?.cache?.hits, `命中计数在增长（${l5a?.crossSessions?.cache?.hits} → ${l5b?.crossSessions?.cache?.hits}）`);
// 纯附加：跨会话聚合不得改动本会话的计数口径。
// 只比计数，不比 spanMs —— spanMs 是墙钟跨度，两次调用之间必然变大，拿整个 totals
// 比对会得到假阳性（上一版就是这么误报的）。
const pick = (rep) => JSON.stringify([
    rep?.totals?.llmCalls, rep?.totals?.toolCalls, rep?.totals?.failedCalls, rep?.totals?.turns,
    rep?.totals?.inputTokens, rep?.totals?.outputTokens, rep?.totals?.durationMs,
]);
check(pick(l5b) === pick(noCross), `跨会话聚合不改变本会话计数口径（纯附加；${pick(noCross)}）`);
check(JSON.stringify(l5b?.toolOutcome) === JSON.stringify(noCross?.toolOutcome), '跨会话聚合不改变 toolOutcome（纯附加）');
if (fails > 0) {
    console.error(`FAIL: ${fails} 项未过`);
    finish(1);
}
console.log('ACTIVITY_REPORT SMOKE PASSED');
finish(0);
