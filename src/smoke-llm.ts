// llm/stream 监听逻辑单测：模拟 agent loop 发起带 system prompt 的请求，验证 sections 生成
import { Context, Service } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
const monitor = await import('./index.js')

const ctx = new Context()
await ctx.plugin(SystemPrompt, { personaPrefix: '' })
ctx.systemPrompt.section({
  name: 'my-plugin:conduct',
  order: 4000,
  text: '## 额外行为守则\n- 回答保持简洁。',
})
const captured: any[] = []
const fakeWebServer = { register: (r: any) => { captured.push(r); return () => {} } }
class FakeWS extends Service {
  static inject = [] as const
  constructor(c: any) { super(c, 'webServer'); c.webServer = fakeWebServer }
}
await ctx.plugin(FakeWS as any)
const fiber = ctx.plugin(monitor as any)
await fiber
console.log('monitor state:', fiber.state)
// 验证 assemble 在监听器环境可用
try {
  const asm = await (ctx as any).systemPrompt.assemble()
  console.log('direct assemble sections:', asm.sections.map((s: any) => s.name))
} catch (e: any) { console.log('direct assemble FAILED:', e.message) }

function* fakeStream() {
  yield { type: 'text-delta', index: 0, text: '当前目录包含 ' }
  yield { type: 'text-delta', index: 0, text: '12 个文件。' }
  yield { type: 'block-end', index: 0 }
}

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.\n\n## 额外行为守则\n- 保持简洁。\n\n当前时间：2026-09-28' }] },
  { role: 'user', content: [{ type: 'text', text: '帮我看看当前目录有什么文件' }] },
  { role: 'assistant', content: [{ type: 'text', text: '上一轮回复' }] },
]
const options = { provider: 'deepseek', model: 'v3.2', messages, tools: [{}, {}, {}] }

// 等待后台 assembly 缓存刷新（2 秒周期）
await new Promise((r) => setTimeout(r, 2600))

// 触发 waterfall（模拟 dsh-llm 的调用方式：waterfall(name, options, rootNext)）
const rootNext = async function* () { yield* fakeStream() }
const run = (ctx as any).waterfall('llm/stream', options, rootNext)
for await (const chunk of run) { void chunk }

await new Promise((r) => setTimeout(r, 100))
const route = captured.find((x) => x.path === '/api/activity-monitor/snapshot')!
const fakeRes: any = { writeHead() {}, end(b: string) { this.body = b } }
await route.handler({ url: '/?since=0' }, fakeRes)
const snap = JSON.parse(fakeRes.body)
console.log('rows:', snap.total)
for (const row of snap.rows) {
  console.log(`  [${row.tag}] ${row.name} → ${row.summary}`)
  console.log('  sections:', (row.sections ?? []).map((s: any) => s.title))
  const sysSections = (row.sections ?? []).filter((s: any) => s.title.startsWith('段落'))
  if (sysSections.length > 0) {
    console.log('  提示词第一段 body 预览:', JSON.stringify(sysSections[0].body.slice(0, 60)))
  }
  const reply = (row.sections ?? []).find((s: any) => s.title === '助手回复')
  if (reply) console.log('  助手回复 body:', JSON.stringify(reply.body))
  const user = (row.sections ?? []).find((s: any) => s.title.includes('用户消息'))
  if (user) console.log('  用户消息 body:', JSON.stringify(user.body))
}
process.exit(0)
