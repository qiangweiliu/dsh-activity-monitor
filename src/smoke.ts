// 冒烟测试：真实服务环境 → 模拟工具调用和模型请求 → 验证快照端点输出
import { createServer } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

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

// ── 验证快照端点 ──
console.log('\nregistered routes:', captured.map((r) => r.path))
const route = captured.find((r) => r.path === '/api/activity-monitor/snapshot')
if (!route) throw new Error('snapshot route not registered!')

const fakeRes = {
  head: null as any,
  body: '',
  writeHead(code: number, headers: any) { this.head = { code, headers } },
  end(body: string) { this.body = body },
}
await route.handler({ url: '/api/activity-monitor/snapshot?since=0' }, fakeRes)
const snapshot = JSON.parse(fakeRes.body)
console.log('snapshot rows:', snapshot.total)
for (const row of snapshot.rows) {
  console.log(`  [${row.tag}] ${row.name} → ${row.summary} (${row.durationMs}ms, ok=${row.ok}, session=${row.sessionId ?? '-'})`)
  if (row.detail) console.log('    detail 预览:', JSON.stringify(row.detail.slice(0, 200)))
}

// 增量拉取验证
await dispatch('bash', { command: 'cat /tmp/second.txt' })
const fakeRes2 = { writeHead(){}, end(b: string){ this.body = b } } as any
await route.handler({ url: `/api/activity-monitor/snapshot?since=${snapshot.total}` }, fakeRes2)
const incremental = JSON.parse(fakeRes2.body)
console.log('\nincremental rows since', snapshot.total, ':', incremental.rows.length)
console.log('  latest:', incremental.rows[0]?.summary)

await fiber.dispose()
console.log('\nALL SMOKE CHECKS PASSED')
process.exit(0)
