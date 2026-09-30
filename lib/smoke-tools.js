// 集成测试：真实 dsh-tools ToolRuntime 下，activity_report 工具注册 + 经注册表 execute + 输出 schema 校验
// 用唯一 session id 隔离历史 JSONL，保证每次运行计数干净、可断言；退出前清理自己写的历史文件。
import { unlinkSync } from 'node:fs';
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
if (fails > 0) {
    console.error(`FAIL: ${fails} 项未过`);
    finish(1);
}
console.log('ACTIVITY_REPORT SMOKE PASSED');
finish(0);
