// 诊断：验证后台 assembly 缓存是否生效
import { Context, Service } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
const monitor = await import('./index.js')

const ctx = new Context()
await ctx.plugin(SystemPrompt, { personaPrefix: '' })
ctx.systemPrompt.section({ name: 'my-plugin:conduct', order: 4000, text: '## 守则' })
const captured: any[] = []
class FakeWS extends Service {
  static inject = [] as const
  constructor(c: any) { super(c, 'webServer'); c.webServer = { register: (r: any) => { captured.push(r); return () => {} } } }
}
await ctx.plugin(FakeWS as any)
await ctx.plugin(monitor as any)

// 手动延迟 assemble 测试是否死锁只影响挂载期
await new Promise((r) => setTimeout(r, 1100))
try {
  const a = await (ctx as any).systemPrompt.assemble()
  console.log('POST-MOUNT assemble OK, sections:', a.sections.map((s: any) => s.name))
} catch (e: any) {
  console.log('POST-MOUNT assemble FAILED:', e.message)
}

function* fakeStream() { yield { type: 'text-delta', index: 0, text: '回复内容' } }
const messages: any = [
  { role: 'system', content: [{ type: 'text', text: 'SYSPROMPT-RENDERED-TEXT 守则' }] },
  { role: 'user', content: [{ type: 'text', text: '问' }] },
]
const options: any = { provider: 'p', model: 'm', messages, tools: [] }
const run = (ctx as any).waterfall('llm/stream', options, async function* () { yield* fakeStream() })
for await (const c of run) { void c }
await new Promise((r) => setTimeout(r, 100))

const route = captured.find((x) => x.path === '/api/activity-monitor/snapshot')!
const fakeRes: any = { writeHead() {}, end(b: string) { this.body = b } }
await route.handler({ url: '/?since=0' }, fakeRes)
const snap = JSON.parse(fakeRes.body)
const row = snap.rows[0]
console.log('sections:')
for (const s of row.sections ?? []) console.log('  TITLE:', s.title)
// 判定路径
const named = (row.sections ?? []).some((s: any) => s.title.includes('my-plugin:conduct'))
console.log(named ? '>>> assemble 命名路径生效' : '>>> 回退分段路径生效' )
process.exit(0)
