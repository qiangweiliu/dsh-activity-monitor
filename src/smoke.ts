// 冒烟测试（协议 v2 护栏）：真实 cordis 服务环境 → 模拟工具调用 → 断言快照端点仍然「轻」，
// 并且正文、轮次标记、配置、自检都能按需拿到。
//
// 这个文件是 P0（轻行/重体分层）的护栏，断言的都是「改错了会静默变慢/变空」的地方：
//   1. 快照里绝不能出现正文（detail/sections）—— 出现就说明白名单漏了
//   2. hasBody 标记与 /row 取回的正文必须对得上（少了前端点开就是空白）
//   3. 快照体积必须远小于正文体积（分层是否真的生效）
//   4. /history?light=1 也不带正文；/config、/selfcheck 可用
// 历史目录指向临时目录：冒烟不再往用户真实库里写 sess-test-1234.jsonl 这类残渣。
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

// 必须在 import ./index.js 之前设好：配置在插件 apply 时解析（含历史目录）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'am-smoke-'))

const ctx = new Context()
await ctx.plugin(SystemPrompt, { personaPrefix: '' })
await ctx.plugin(ToolRuntime, {})

// ── 手动加载监控插件逻辑 ──
const monitor = await import('./index.js')

// 模拟 webServer 服务（真实环境由 dsh-host-webserver 提供）：
// 通过插件形式安装，让 inject 依赖解析正常
const captured: any[] = []
const fakeWebServer = {
  register(route: any) {
    captured.push(route)
    return () => {}
  },
}
await ctx.plugin(class FakeWebServer extends Service {
    static inject = [] as const
    constructor(c: any) { super(c, 'webServer'); c.webServer = fakeWebServer }
  } as any)

// 挂载监控插件
const fiber = ctx.plugin(monitor as any)
await fiber
console.log('monitor state:', fiber.state, '(2=ACTIVE)')
assert.equal(fiber.state, 2, '插件未进入 ACTIVE 状态')

// 注册一个假工具并调用，触发 tools/execute
ctx.tools.register(defineTool({
  name: 'bash',
  description: 'fake bash',
  parameters: { command: { type: 'string', required: true } },
  output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ok' }] },
  async execute(args: any) {
    return { output: 'file list...' }
  },
}))

ctx.tools.register(defineTool({
  name: 'skill',
  description: 'fake skill loader',
  parameters: { name: { type: 'string', required: true } },
  output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ok' }] },
  async execute(args: any): Promise<never> {
    return { name: args.name, content: '# skill body' } as never
  },
}))

// 模拟调用：走注册表的 execute（会触发 tools/execute waterfall）
const dispatch = async (name: string, args: any) => {
  const json = JSON.parse(JSON.stringify(args))
  Object.freeze(json)
  const r = await (ctx.tools as any).execute({
    callId: 'c-' + name + '-' + Math.random().toString(36).slice(2, 7),
    name, arguments: json,
    signal: new AbortController().signal,
    agent: { session: { id: 'sess-test-1234' } },
  })
  console.log('  execute result:', JSON.stringify(r)?.slice(0, 120))
}

await dispatch('bash', { command: 'ls -la /home/wu/work' })
await dispatch('skill', { name: 'some-skill' })

// ── 端点工具 ──
console.log('\nregistered routes:', captured.map((r) => r.path))
const routeOf = (path: string) => {
  const r = captured.find((x) => x.path === path)
  assert.ok(r, `路由未注册: ${path}`)
  return r!
}
const call = async (path: string, query = ''): Promise<any> => {
  const res = { head: null as any, body: '', writeHead(c: number, h: any) { this.head = { code: c, headers: h } }, end(b: string) { this.body = b } }
  await routeOf(path).handler({ url: path + query }, res)
  const text = (res as any).body
  assert.ok(text, `${path} 无响应体`)
  return { json: JSON.parse(text), bytes: text.length, status: (res as any).head?.code }
}

// ── 1) 快照：轻行（不含正文）+ 增量游标 ──
const snap = await call('/api/activity-monitor/snapshot', '?since=0')
const snapshot = snap.json
console.log('\nsnapshot rows:', snapshot.rows.length, '· total:', snapshot.total, '· lastSeq:', snapshot.lastSeq, '· markGen:', snapshot.markGen)
assert.ok(Array.isArray(snapshot.rows) && snapshot.rows.length > 0, '快照没有行')
assert.ok(typeof snapshot.runId === 'string' && snapshot.runId.length > 0, '快照缺少 runId（客户端无法判断宿主重启）')
assert.ok(typeof snapshot.lastSeq === 'number' && snapshot.lastSeq > 0, '快照缺少 lastSeq 游标')
assert.ok(Array.isArray(snapshot.marks), '快照缺少 marks 增量日志')
// 协议 v2 的核心护栏：快照里不许出现正文
for (const row of snapshot.rows) {
  assert.equal(row.detail, undefined, `轻行带上了 detail（seq=${row.seq}）`)
  assert.equal(row.sections, undefined, `轻行带上了 sections（seq=${row.seq}）`)
  assert.ok(typeof row.hasBody === 'boolean', `轻行缺少 hasBody 标记（seq=${row.seq}）`)
  console.log(`  [${row.tag}] ${row.name} → ${row.summary} (${row.durationMs}ms, ok=${row.ok}, hasBody=${row.hasBody}, runId=${row.runId ?? '-'})`)
}

// ── 2) 正文：/row 按需取回，且与 hasBody 对得上 ──
let bodyBytes = 0
let bodies = 0
for (const row of snapshot.rows.filter((r: any) => r.hasBody)) {
  const body = await call('/api/activity-monitor/row', `?seq=${row.seq}&ts=${row.ts}`)
  assert.ok(body.json.row, `hasBody=true 的行取不到正文（seq=${row.seq}）`)
  const sections = body.json.row.sections
  const detail = body.json.row.detail
  assert.ok((Array.isArray(sections) && sections.length > 0) || typeof detail === 'string',
    `正文既没有 sections 也没有 detail（seq=${row.seq}）`)
  if (Array.isArray(sections)) {
    assert.equal(sections.length, row.sectionCount ?? sections.length, `sectionCount 与正分段数不一致（seq=${row.seq}）`)
  }
  bodyBytes += body.bytes
  bodies++
}
console.log(`\n/row 取回正文 ${bodies} 行，共 ${bodyBytes} 字节`)
assert.ok(bodies > 0, '没有任何行带正文，护栏没验到东西')
// 分层的效果：轻行必须有界。这里只做「每行字节上限 + 原始 JSON 无 sections」的强断言 ——
// 本冒烟的正文是假工具输出（几百字节），整体比例说明不了问题；真正体现分层收益的是
// 带系统提示词的 llm 行，体积比在 smoke-llm.js 里断言（那边正文是十几 KB 量级）。
const perRow = snap.bytes / snapshot.rows.length
console.log(`快照 ${snap.bytes} 字节 / ${snapshot.rows.length} 行 = ${perRow.toFixed(0)} 字节/行；正文合计 ${bodyBytes} 字节`)
assert.ok(perRow < 2048, `轻行过大（${perRow.toFixed(0)} 字节/行）—— 正文可能漏进快照`)
assert.ok(!JSON.stringify(snapshot).includes('"sections"'), '快照 JSON 里出现了 sections 字段')
assert.ok(!JSON.stringify(snapshot).includes('"detail"'), '快照 JSON 里出现了 detail 字段')

// ── 3) 增量：since=lastSeq 之后不再重发老行（v1 是回看尾 30 行，会重复下发） ──
await dispatch('bash', { command: 'cat /tmp/second.txt' })
const inc = await call('/api/activity-monitor/snapshot', `?since=${snapshot.lastSeq}`)
console.log('\nincremental rows since', snapshot.lastSeq, ':', inc.json.rows.length)
assert.ok(inc.json.rows.length >= 1, '增量没有拿到新行')
assert.ok(inc.json.rows.every((r: any) => r.seq > snapshot.lastSeq), '增量里出现了游标之前的老行')
assert.ok(inc.bytes < snap.bytes * 2, `增量体积异常膨胀（${inc.bytes}）`)

// ── 4) 历史：异步落盘 → light=1 不带正文，但有行 ──
// 落盘改成串行队列 + 去抖（不再在 llm/stream 收尾里同步写盘），这里给它一点时间；
// 这条断言同时验证「异步落盘真的落了」——落盘路径改动最容易出现的回归是静默不写。
await new Promise((r) => setTimeout(r, 300))
const hist = await call('/api/activity-monitor/history', '?sessionId=sess-test-1234&light=1&limit=10')
console.log('history rows:', hist.json.rows?.length, '· total:', hist.json.total, '· truncated:', hist.json.truncated)
assert.ok(Array.isArray(hist.json.rows) && hist.json.rows.length > 0, '异步落盘后历史仍为空')
for (const r of hist.json.rows) {
  assert.equal(r.sections, undefined, '历史轻行带上了 sections')
}

// ── 5) 配置与自检端点（面板与排查入口） ──
const cfg = await call('/api/activity-monitor/config')
assert.ok(cfg.json.client, '/config 缺少 client 子对象（浏览器侧没有旋钮可读）')
assert.ok(typeof cfg.json.client.pollActiveMs === 'number' && typeof cfg.json.client.maxRows === 'number',
  '/config.client 缺少轮询/行数上限字段')
console.log('config.client:', JSON.stringify(cfg.json.client))

const self = await call('/api/activity-monitor/selfcheck')
assert.ok(self.json.runId && typeof self.json.rowsInBuffer === 'number' && self.json.history, '/selfcheck 字段不全')
console.log('selfcheck:', JSON.stringify({ runId: self.json.runId, rowsInBuffer: self.json.rowsInBuffer, lastSeq: self.json.lastSeq, markGen: self.json.markGen, history: self.json.history?.appended ?? null }))

await fiber.dispose()
console.log('\nALL SMOKE CHECKS PASSED')
process.exit(0)
