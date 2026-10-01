// llm/stream 监听逻辑单测（协议 v2 版）：模拟 agent loop 发起带 system prompt 的请求，
// 断言「提示词正文不再随快照下发，而是展开时用 /row 按需取回」。
//
// 这里是分层收益的主战场：真实会话里一轮的系统提示词正文十几 KB，占单行体积约 85%。
// 所以断言钉在体积比上（正文 >> 快照），并检查 hasBody/sectionCount 与 /row 取回的内容
// 一致 —— 前端就是靠这两个标记决定「点开哪行时去取什么」。
import { Context, Service } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
// 隔离历史目录：冒烟不往用户真实库里写测试会话
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'am-smoke-llm-'));
const monitor = await import('./index.js');
const ctx = new Context();
await ctx.plugin(SystemPrompt, { personaPrefix: '' });
ctx.systemPrompt.section({
    name: 'my-plugin:conduct',
    order: 4000,
    text: '## 额外行为守则\n- 回答保持简洁。',
});
// 故意塞一段大正文，模拟真实会话里十几 KB 的上下文/规则段落：
// 小正文下快照与正文都在几百字节，测不出分层收益，这条断言就会变成噪声
const BIG = 'x'.repeat(12_000);
ctx.systemPrompt.section({ name: 'my-plugin:bigcontext', order: 4100, text: `# 大段上下文\n${BIG}` });
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
assert.equal(fiber.state, 2, '插件未进入 ACTIVE 状态');
// 验证 assemble 在监听器环境可用
try {
    const asm = await ctx.systemPrompt.assemble();
    console.log('direct assemble sections:', asm.sections.map((s) => s.name));
}
catch (e) {
    console.log('direct assemble FAILED:', e.message);
}
function* fakeStream() {
    yield { type: 'text-delta', index: 0, text: '当前目录包含 ' };
    yield { type: 'text-delta', index: 0, text: '12 个文件。' };
    yield { type: 'block-end', index: 0 };
}
const messages = [
    { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.\n\n## 额外行为守则\n- 保持简洁。\n\n当前时间：2026-09-28' }] },
    { role: 'user', content: [{ type: 'text', text: '帮我看看当前目录有什么文件' }] },
    { role: 'assistant', content: [
            { type: 'reasoning', text: '先看目录结构，再决定要不要读文件。' },
            { type: 'text', text: '我先列一下目录。' },
            { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}' },
        ] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'total 12\n-rw-r--r-- 1 wu wu 512 package.json' }] }] },
];
const options = { provider: 'deepseek', model: 'v3.2', messages, tools: [
        { name: 'bash', description: '在持久 shell 里执行命令' },
        { name: 'read', description: '读取文件内容' },
        { name: 'write', description: '写入文件' },
    ] };
// 等待后台 assembly 缓存刷新（2 秒周期）
await new Promise((r) => setTimeout(r, 2600));
// 触发 waterfall（模拟 dsh-llm 的调用方式：waterfall(name, options, rootNext)）
const rootNext = async function* () { yield* fakeStream(); };
const run = ctx.waterfall('llm/stream', options, rootNext);
for await (const chunk of run) {
    void chunk;
}
await new Promise((r) => setTimeout(r, 100));
const routeOf = (p) => {
    const r = captured.find((x) => x.path === p);
    assert.ok(r, `路由未注册: ${p}`);
    return r;
};
const call = async (path, query = '') => {
    const res = { writeHead() { }, end(b) { this.body = b; } };
    await routeOf(path).handler({ url: path + query }, res);
    return { json: JSON.parse(res.body), bytes: res.body.length };
};
const snap = await call('/api/activity-monitor/snapshot', '?since=0');
console.log('\nrows:', snap.json.rows.length, '· lastSeq:', snap.json.lastSeq, '· markGen:', snap.json.markGen);
assert.ok(snap.json.rows.length > 0, '快照没有行');
const llmRow = snap.json.rows.find((r) => r.kind === 'llm');
assert.ok(llmRow, '没有模型行');
// v2 护栏：快照里的模型行不能带提示词正文
assert.equal(llmRow.sections, undefined, '快照里的模型行仍带着 sections（分层没生效）');
assert.equal(llmRow.detail, undefined, '快照里的模型行仍带着 detail');
assert.equal(llmRow.hasBody, true, '模型行应标记 hasBody=true（有提示词正文可按需取）');
assert.ok(Number(llmRow.promptSections) > 0, '模型行缺少 promptSections（轻行字段，供跨轮差异用）');
assert.ok(typeof snap.json.markGen === 'number' && Array.isArray(snap.json.marks), '快照缺少轮次标记增量字段');
console.log(`  模型行: turn=${llmRow.turn} settled=${llmRow.settled} hasBody=${llmRow.hasBody} sectionCount=${llmRow.sectionCount} promptSections=${llmRow.promptSections}`);
console.log(`  轮次标记: 行内 turnStart=${llmRow.turnStart} turnEnd=${llmRow.turnEnd} · marks 增量 ${snap.json.marks.length} 条`);
// /row 按需取回提示词正文
const body = await call('/api/activity-monitor/row', `?seq=${llmRow.seq}&ts=${llmRow.ts}`);
const sections = body.json.row?.sections ?? [];
console.log(`\n/row 取回 ${sections.length} 段，共 ${body.bytes} 字节`);
for (const s of sections) {
    console.log(`  - ${s.title}（${s.body.length} 字节）`);
}
assert.ok(sections.length > 0, '/row 没取回任何分段');
assert.equal(sections.length, llmRow.sectionCount, 'sectionCount 与 /row 实际分段数不一致');
const reply = sections.find((s) => s.title === '助手回复');
assert.ok(reply && reply.body.includes('当前目录包含'), '/row 没有取回助手回复正文');
// 用户消息与工具结果都在「完整上下文」段里（按 anchorOffsets 切成消息块，前端靠它做跳转定位）
const ctxSec = sections.find((s) => s.title.startsWith('完整上下文'));
assert.ok(ctxSec, '/row 没有取回「完整上下文」段');
assert.ok(ctxSec.body.includes('帮我看看当前目录'), '「完整上下文」段里没有用户消息');
assert.ok(Array.isArray(ctxSec.anchorOffsets) && ctxSec.anchorOffsets.length > 0, '「完整上下文」段缺少 anchorOffsets（前端无法定位到第 n 条消息）');
const promptSec = sections.find((s) => s.body.includes('大段上下文'));
assert.ok(promptSec && promptSec.body.length > 10_000, '/row 没有取回大段提示词正文');
// ── 分层收益的硬断言：快照（高频通道）远小于正文（低频通道） ──
console.log(`\n快照 ${snap.bytes} 字节  vs  正文 ${body.bytes} 字节（正文/快照 = ${(body.bytes / snap.bytes).toFixed(1)}x）`);
assert.ok(body.bytes > snap.bytes * 2, `正文没有明显大于快照（${body.bytes} vs ${snap.bytes}）—— 分层收益不成立或正文没生成`);
// ── 二次请求：增量不该重发老行（v1 回看尾 30 行，会把同样的正文一遍遍重发） ──
const inc = await call('/api/activity-monitor/snapshot', `?since=${snap.json.lastSeq}`);
console.log(`增量：rows=${inc.json.rows.length} · ${inc.bytes} 字节`);
assert.ok(inc.json.rows.every((r) => r.seq > snap.json.lastSeq), '增量里出现了游标之前的老行');
await fiber.dispose();
try {
    rmSync(process.env.DSH_HOME, { recursive: true, force: true });
}
catch { /* 清不掉不影响结论 */ }
console.log('\nLLM SMOKE CHECKS PASSED');
process.exit(0);
