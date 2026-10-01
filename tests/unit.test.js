// 纯函数与存储逻辑的单测（node:test，零新依赖）。
//
// 为什么要有这一层：冒烟跑的是「真插件 + 假 webServer」，能覆盖集成路径但很慢、
// 且难以构造边界数据（游标跨代丢失、超预算截断、30 天归档、坏行……）。
// 这里直接对 lib/ 里的纯函数与 HistoryStore 下手，跑得快、能造边界。
// 约定：测试只读 lib/*.js（先 npm run build），断言口径与面板/宿主一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  contextDiff, effectiveProposalStatus, fmtBytes, recurringFailSigs, rowsToJson, rowsToMarkdown,
  sessionTotals, summarizeSession, turnSignals,
} from '../lib/derive.js'
import { MarkLog, applyMarks, computeMarks, toLight, turnKey } from '../lib/wire.js'
import { failureSig, normalizeErrorText } from '../lib/sig.js'
// 宿主半身入口：index.ts 顶层只有 type-only 依赖（会被擦除），所以单测里可以直接引 lib/index.js
import { buildAgentReport, parseProposalTransition } from '../lib/index.js'
import { defaultConfig, resolveConfig } from '../lib/config.js'
import { HistoryStore, parseJsonl, safeSessionKey } from '../lib/history.js'
import { SummaryCache, SUMMARIES_VERSION, collectCrossSessions } from '../lib/cross.js'

// ── 造数据的小工具 ──
const llm = (over = {}) => ({
  seq: 1, ts: 1000, sessionId: 's1', runId: 'r1', kind: 'llm', name: 'deepseek/v3.2', tag: 'llm',
  summary: '模型请求', turn: 1, settled: true, rev: 1, durationMs: 900,
  detail: 'PROMPT-BODY', sections: [{ title: '助手回复', body: 'REPLY-BODY' }],
  usageIn: 100, usageOut: 20, contextBytes: 3000, contextMessages: 12, promptSections: 3, ...over,
})
const tool = (over = {}) => ({
  seq: 2, ts: 1100, sessionId: 's1', runId: 'r1', kind: 'tool', name: 'bash', tag: 'command',
  summary: 'ls -la', turn: 1, settled: true, rev: 1, durationMs: 5, ok: true, detail: 'TOOL-OUT', ...over,
})

// ── derive：跨轮差异 ──
test('contextDiff 只报变化项，且用人类可读单位', () => {
  const prev = llm({ seq: 1, ts: 1000, contextBytes: 40_000, contextMessages: 20, promptSections: 3, calls: [{ name: 'bash', msgIndex: 1, callIndex: 1 }] })
  const cur = llm({ seq: 5, ts: 9000, contextBytes: 45_000, contextMessages: 23, promptSections: 3, calls: [{ name: 'bash', msgIndex: 1, callIndex: 1 }, { name: 'read', msgIndex: 2, callIndex: 1 }] })
  const d = contextDiff(prev, cur)
  assert.match(d, /消息 \+3（20→23）/)
  assert.match(d, /上下文 \+4\.9 KB/)
  assert.match(d, /不变（3 段提示词）/)
  assert.match(d, /调用 \+1（1→2）/)
  assert.equal(contextDiff(undefined, cur), '', '没有基准（第一轮）不该凭空造差异')
})

test('contextDiff 在「本轮开始出现超预算省略」时给出提示', () => {
  const prev = llm({ contextOmitted: 0 })
  const cur = llm({ contextOmitted: 7 })
  assert.match(contextDiff(prev, cur), /本轮开始出现超预算省略/)
})

test('fmtBytes 的 KB 口径', () => {
  assert.equal(fmtBytes(512), '512 B')
  assert.equal(fmtBytes(2048), '2.0 KB')
  assert.equal(fmtBytes(Number.NaN), '-')
})

// ── derive：轮次信号与会话汇总 ──
test('turnSignals 抓重复调用 / 失败 / 截断 / 长耗时', () => {
  const rows = [
    llm({ seq: 1, contextOmitted: 3 }),
    tool({ seq: 2, name: 'bash', ok: false }),
    tool({ seq: 3, name: 'bash' }),
    tool({ seq: 4, name: 'bash' }),
    tool({ seq: 5, name: 'grep', durationMs: 31_000 }),
    tool({ seq: 6, name: 'tail', settled: false }),
  ]
  const texts = turnSignals(rows).map((s) => s.text)
  assert.ok(texts.some((t) => t.includes('bash 重复调用 3 次')), `缺少重复调用信号：${texts.join(' | ')}`)
  assert.ok(texts.some((t) => t.includes('1 次调用失败（bash）')))
  assert.ok(texts.some((t) => t.includes('3 条消息被整条省略')))
  assert.ok(texts.some((t) => t.includes('1 次调用超过 30s')))
  assert.ok(texts.some((t) => t.includes('1 个调用仍在进行中')))
})

test('sessionTotals 汇总 token / 频次 / 最大上下文轮次', () => {
  const rows = [
    llm({ seq: 1, ts: 1, turn: 1, contextBytes: 1000, usageIn: 10, usageOut: 1 }),
    tool({ seq: 2, ts: 2, turn: 1, name: 'bash' }),
    llm({ seq: 3, ts: 3, turn: 2, contextBytes: 9000, usageIn: 20, usageOut: 2, contextOmitted: 4 }),
    tool({ seq: 4, ts: 4, turn: 2, name: 'bash' }),
    { seq: 5, ts: 5, sessionId: 's1', kind: 'tool', name: 'skill', tag: 'skill', summary: 'skill: code-review', turn: 2, ok: true },
  ]
  const t = sessionTotals(rows)
  assert.equal(t.turns, 2)
  assert.equal(t.llmCalls, 2)
  assert.equal(t.toolCalls, 3)
  assert.equal(t.inputTokens, 30)
  assert.equal(t.outputTokens, 3)
  assert.equal(t.maxContextBytes, 9000)
  assert.equal(t.maxContextTurn, 2)
  assert.equal(t.contextOmitted, 4)
  assert.deepEqual(t.toolFrequency[0], { name: 'bash', count: 2 })
  assert.deepEqual(t.skills[0], { name: 'code-review', count: 1 })
})

test('rowsToMarkdown 导出不含正文（只导出轻行字段）', () => {
  const rows = [llm({ seq: 1, ts: 1_700_000_000_000, turn: 1 }), tool({ seq: 2, ts: 1_700_000_001_000, turn: 1 })]
  const md = rowsToMarkdown(rows, '测试会话')
  assert.match(md, /^## 测试会话/)
  assert.match(md, /### 第 1 轮/)
  assert.ok(!md.includes('PROMPT-BODY'), 'Markdown 不应包含提示词正文')
  assert.ok(!md.includes('TOOL-OUT'), 'Markdown 不应包含工具输出正文')
  const json = JSON.parse(rowsToJson(rows, { sessionId: 's1' }))
  assert.equal(json.totals.llmCalls, 1)
  assert.equal(json.rows.length, 2)
  assert.ok(json.exportedAt)
})

// ── wire：轻行分层 ──
test('toLight 剥掉正文，只留标量 + hasBody/sectionCount', () => {
  const light = toLight(llm({ seq: 7, ts: 700 }))
  assert.equal(light.detail, undefined, 'detail 不该出现在轻行里')
  assert.equal(light.sections, undefined, 'sections 不该出现在轻行里')
  assert.equal(light.hasBody, true)
  assert.equal(light.sectionCount, 1)
  assert.equal(light.runId, 'r1')
  assert.equal(light.seq, 7)
  assert.equal(light.promptSections, 3)
  assert.equal(JSON.stringify(light).includes('PROMPT-BODY'), false)
  const noBody = toLight(tool({ detail: undefined }))
  assert.equal(noBody.hasBody, false)
})

// ── wire：轮次标记 ──
test('computeMarks 标出每轮首行与已结束轮的末行', () => {
  const rows = [
    llm({ seq: 1, ts: 1, turn: 1 }),
    tool({ seq: 2, ts: 2, turn: 1 }),
    llm({ seq: 3, ts: 3, turn: 2 }),
    tool({ seq: 4, ts: 4, turn: 2 }),
    tool({ seq: 5, ts: 5, turn: undefined }),   // 轮次外的行（如标题生成）不参与标记
  ]
  const marks = computeMarks(rows, (sid, turn) => turn === 1)   // 只认为第 1 轮已结束
  assert.deepEqual(marks, [
    { gen: 0, seq: 1, turnStart: true },
    { gen: 0, seq: 2, turnEnd: true },
    { gen: 0, seq: 3, turnStart: true },
  ])
  const applied = applyMarks(rows, marks)
  assert.equal(applied[0].turnStart, true)
  assert.equal(applied[1].turnEnd, true)
  assert.equal(applied[3].turnEnd, undefined)
  assert.equal(rows[0].turnStart, undefined, 'applyMarks 不应改原行')
})

test('MarkLog 增量游标：gen 之后只回增量，容量丢弃后置 tooOld', () => {
  const log = new MarkLog(100)
  log.bump([{ seq: 1, turnStart: true }])
  log.bump([{ seq: 2, turnEnd: true }])
  const inc = log.since(1)
  assert.equal(inc.markGen, 2)
  assert.equal(inc.entries.length, 1, '只该回 gen=2 之后的记录')
  assert.equal(inc.entries[0].seq, 2)
  assert.equal(inc.tooOld, false)
  // 客户端游标比宿主新（宿主重启过）→ reset
  assert.equal(log.since(99).reset, true)
  // 游标正好在最前 → 无增量
  assert.deepEqual(log.since(2).entries, [])
})

test('MarkLog 容量溢出后，太旧的游标会被判 tooOld（要求整段重载）', () => {
  const log = new MarkLog(100)   // 构造函数把 cap 抬到至少 100
  for (let i = 0; i < 150; i++) log.bump([{ seq: i, turnStart: true }])
  assert.equal(log.since(0).tooOld, false, 'gen=0 是全新客户端，不算 tooOld')
  assert.equal(log.since(10).tooOld, true, 'gen=10 的记录已被挤掉，必须让它重载')
  assert.ok(log.since(10).entries.length > 0)
})

test('turnKey 用 session+turn 定位（不同会话的同一轮次互不干扰）', () => {
  assert.equal(turnKey('a', 1), 'a|1')
  assert.notEqual(turnKey('a', 1), turnKey('b', 1))
  assert.equal(turnKey(undefined, 3), '|3')
})

// ── config：失败软着陆 ──
test('resolveConfig 无配置时用默认值，且默认值口径正确', () => {
  const cfg = resolveConfig(undefined)
  const def = defaultConfig()
  assert.equal(cfg.maxRows, def.maxRows)
  assert.equal(cfg.client.pollActiveMs, 300)
  assert.equal(cfg.client.pollIdleMs, 1000)
  assert.equal(cfg.history.archiveAfterDays, 30, '默认 30 天自动归档')
  assert.deepEqual(cfg.issues, [], '合法默认配置不该产生 issues')
})

test('resolveConfig 非法值退回默认并把问题记进 issues', () => {
  const cfg = resolveConfig({
    maxRows: 'not-a-number',
    contextBudgetBytes: 10,               // 低于允许下界 → 钳到边界
    client: { pollActiveMs: 'fast', pollIdleMs: 5 },
    history: { archiveAfterDays: -3 },
    endpoints: 'yes',
  })
  assert.ok(cfg.issues.length >= 3, `应记录多条被修正的配置：${JSON.stringify(cfg.issues)}`)
  assert.equal(cfg.client.pollActiveMs, 300, '非法轮询间隔应退回默认')
  assert.ok(cfg.issues.some((i) => i.includes('contextBudgetBytes')))
  assert.ok(cfg.issues.some((i) => i.includes('pollActiveMs')))
  // 钳制而不是丢弃：预算被抬到允许的下界（不能是 10）
  assert.ok(cfg.contextBudgetBytes > 10)
})

// ── history：落盘 / 读回 / 归档 / 坏行 ──
const tmpStore = (opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'am-unit-'))
  return { dir, store: new HistoryStore({ dir, ...opts }) }
}

test('HistoryStore 追加后 flushSync 落盘，rows() 读回同一批行', () => {
  const { dir, store } = tmpStore()
  store.append(llm({ seq: 1, ts: 1 }))
  store.append(tool({ seq: 2, ts: 2 }))
  store.flushSync()
  const read = store.rows('s1')
  assert.equal(read.rows.length, 2)
  assert.equal(read.badLines, 0)
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  assert.equal(files.length, 1, `应有 1 个会话文件，实为 ${files.join(',')}`)
  assert.equal(files[0], `${safeSessionKey('s1')}.jsonl`)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('HistoryStore 异步落盘（不调 flushSync 也会写盘，且能在 stats 里看到）', async () => {
  const { dir, store } = tmpStore()
  store.append(llm({ seq: 1, ts: 1 }))
  assert.equal(store.stats().written, 0, '刚 append 时还没写（去抖窗口内）')
  await new Promise((r) => setTimeout(r, 400))   // 去抖 200ms + 余量
  const stats = store.stats()
  assert.ok(stats.written >= 1, `异步落盘没有发生：${JSON.stringify(stats)}`)
  assert.equal(stats.errors, 0)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('HistoryStore 能读 gzip 归档（.jsonl.gz 原文件被删掉后仍可读回）', () => {
  const { dir, store } = tmpStore()
  const row = llm({ seq: 42, ts: 42_000 })
  writeFileSync(join(dir, `${safeSessionKey('s9')}.jsonl.gz`), gzipSync(JSON.stringify(row) + '\n'))
  const read = store.rows('s9')
  assert.equal(read.rows.length, 1)
  assert.equal(read.rows[0].seq, 42)
  assert.equal(read.archived, true, '读到的是归档文件，archived 应为 true')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('archiveOld 按 mtime 归档超期文件：原文进 .gz，行仍可读，未超期的不动', () => {
  const { dir, store } = tmpStore({ archiveAfterDays: 30 })
  store.append(llm({ seq: 1, ts: Date.now() - 60 * 86_400_000, sessionId: 'old' }))
  store.append(llm({ seq: 2, ts: Date.now(), sessionId: 'fresh' }))
  store.flushSync()
  const oldFile = join(dir, `${safeSessionKey('old')}.jsonl`)
  const past = new Date(Date.now() - 45 * 86_400_000)
  utimesSync(oldFile, past, past)   // 把「旧会话」的文件时间推回 45 天前
  const res = store.archiveOld(Date.now())
  assert.equal(res.archived, 1, `应归档 1 个超期文件：${JSON.stringify(res)}`)
  assert.equal(res.errors, 0)
  const names = readdirSync(dir)
  assert.ok(names.includes(`${safeSessionKey('old')}.jsonl.gz`), `缺 .gz：${names.join(',')}`)
  assert.ok(!names.includes(`${safeSessionKey('old')}.jsonl`), '归档后原文件应已移走')
  assert.ok(names.includes(`${safeSessionKey('fresh')}.jsonl`), '未超期文件不该被动')
  const back = store.rows('old')
  assert.equal(back.rows.length, 1, '归档后仍要能读回原文（归档不是删除）')
  assert.equal(back.archived, true)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('archiveAfterDays=0 时归档关闭（显式关闭路径）', () => {
  const { dir, store } = tmpStore({ archiveAfterDays: 0 })
  store.append(llm({ seq: 1, ts: 1, sessionId: 'x' }))
  store.flushSync()
  const f = join(dir, `${safeSessionKey('x')}.jsonl`)
  const past = new Date(Date.now() - 400 * 86_400_000)
  utimesSync(f, past, past)
  assert.equal(store.archiveOld(Date.now()).archived, 0)
  assert.ok(readdirSync(dir).includes(`${safeSessionKey('x')}.jsonl`), '关闭归档后不该动文件')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('parseJsonl 跳过坏行并计数（坏行不该让整份历史读不出来）', () => {
  const text = [JSON.stringify(llm({ seq: 1, ts: 1 })), '{not json', '', JSON.stringify(tool({ seq: 2, ts: 2 }))].join('\n')
  const parsed = parseJsonl(text)
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.badLines, 1)
})

test('safeSessionKey 把会话 id 变成安全的文件名', () => {
  assert.equal(safeSessionKey('sess-1234_ab'), 'sess-1234_ab')
  assert.ok(!safeSessionKey('a/b:c').includes('/'))
  assert.ok(!safeSessionKey('a/b:c').includes(':'))
  assert.equal(safeSessionKey(undefined), 'global')
})

// ── L1 失败签名：归一化必须幂等、抹掉易变部分、且不把不同错误合到一起 ──
test('normalizeErrorText 抹掉 ANSI/路径/数字，且幂等', () => {
  const a = normalizeErrorText('\u001b[31mError: ENOENT: no such file or directory, open /tmp/x/42/foo.txt\u001b[0m')
  assert.equal(a, 'error: enoent: no such file or directory, open <path>')
  assert.equal(normalizeErrorText(a), a, '归一化必须幂等')
  const b = normalizeErrorText('C:\\Users\\wu\\app.log:12: 0xDEADBEEF failed')
  assert.ok(!b.includes('wu'), `Windows 路径未脱敏：${b}`)
  assert.ok(!/\d/.test(b), `仍残留数字：${b}`)
  assert.ok(b.includes('<path>') && b.includes('<n>'), `应留下 <path>/<n> 占位（十六进制也要归一）：${b}`)
  // 宁可分得细：不同错误绝不能被归一化成同一个签名
  assert.notEqual(normalizeErrorText('permission denied'), normalizeErrorText('command not found'))
})

test('failureSig 同类失败同签名，工具/错误类别分开', () => {
  const s1 = failureSig('bash', 'error', 'Error: ENOENT: open /tmp/a/1.txt')
  const s2 = failureSig('bash', 'error', 'Error: ENOENT: open /tmp/b/2.txt')
  assert.equal(s1, s2, '仅路径不同 → 同签名')
  assert.notEqual(s1, failureSig('bash', 'exception', 'Error: ENOENT: open /tmp/a/1.txt'), 'isError 与抛异常分开')
  assert.notEqual(s1, failureSig('read', 'error', 'Error: ENOENT: open /tmp/a/1.txt'), '不同工具分开')
})

// ── L1 聚类：只加不删（failures 原样保留） ──
test('buildAgentReport 把同签名失败聚成一簇，failures 原样保留', () => {
  const rows = [
    llm({ seq: 1, ts: 1000, turn: 1 }),
    tool({ seq: 2, ts: 1100, turn: 1, name: 'bash', ok: false, failSig: 'bash|error|error: enoent: open <path>', summary: 'cat /tmp/a/1.txt' }),
    tool({ seq: 3, ts: 1200, turn: 1, name: 'bash', ok: false, failSig: 'bash|error|error: enoent: open <path>', summary: 'cat /tmp/a/2.txt' }),
    tool({ seq: 4, ts: 1300, turn: 1, name: 'read', ok: false, failSig: 'read|error|permission denied', summary: 'read /etc/x' }),
    tool({ seq: 5, ts: 1400, turn: 1, name: 'read', ok: false, failSig: 'read|error|permission denied', summary: 'read /etc/y' }),
  ]
  const r = buildAgentReport({ rows, contextBudgetBytes: 300 * 1024, sessionId: 's1', runId: 'r1' })
  assert.equal(r.failures.length, 4, 'failures 原样保留（只加不删的锚点）')
  // 两个签名各出现 2 次 → 两簇；单次失败不成簇（默认阈值 2）。
  // 顺便证明不同签名不会被合并：bash 的簇里不能混进 read 的行。
  assert.equal(r.failureClusters.length, 2, `两个签名各成一簇（实 ${r.failureClusters.length}）`)
  assert.deepEqual(r.failureClusters.map((c) => c.tool), ['bash', 'read'])
  const top = r.failureClusters[0]
  assert.equal(top.count, 2)
  assert.equal(top.tool, 'bash')
  assert.equal(top.errClass, 'error')
  assert.deepEqual(top.exampleSeqs, [2, 3])
  assert.deepEqual(top.turns, [1])
  assert.equal(r.failuresTruncated, undefined, '未截断时不给截断标记')
  assert.ok(r.signals.some((s) => s.text.includes('同一失败签名重复 2 次')), `缺少聚类信号：${r.signals.map((s) => s.text).join(' | ')}`)
})

test('failures 上限与截断标记：聚类不受上限影响', () => {
  const rows = [...Array(25).keys()].map((i) => tool({ seq: 10 + i, ts: 1000 + i, name: 'bash', ok: false, failSig: `bash|error|e${i}` }))
  const r = buildAgentReport({ rows, contextBudgetBytes: 300 * 1024, maxFailures: 5, clusterMinCount: 3, runId: 'r1' })
  assert.equal(r.failures.length, 5)
  assert.deepEqual(r.failuresTruncated, { total: 25, shown: 5 })
  assert.equal(r.failureClusters.length, 0, '每个签名只出现 1 次，低于下限 3')
  assert.ok(r.signals.some((s) => s.text.includes('failureClusters 覆盖全部失败')), '截断提示')
})

// ── L2 验收结论：不污染 failedCalls / durationMs；有 verdict 就不猜结果 ──
const verdictRow = (over = {}) => ({
  seq: 3, ts: 1200, sessionId: 's1', runId: 'r1', kind: 'verdict', name: 'task_verdict', tag: 'verdict',
  summary: 'fail · 类型检查没过', settled: true, rev: 1,
  verdict: { status: 'fail', basis: '类型检查报 3 处错误', evidenceSeqs: [2], by: 'agent', at: 1200 }, ...over,
})

test('verdict 行不进 failedCalls、不加 durationMs', () => {
  const rows = [llm({ seq: 1, ts: 1000, durationMs: 900 }), tool({ seq: 2, ts: 1100, durationMs: 5 }), verdictRow()]
  const r = buildAgentReport({ rows, contextBudgetBytes: 300 * 1024, sessionId: 's1', runId: 'r1' })
  assert.equal(r.totals.failedCalls, 0, 'verdict 不得用 ok:false 表达失败（否则污染 failedCalls）')
  assert.equal(r.totals.durationMs, 905, 'verdict 不带 durationMs（报告侧 durationMs 跨 kind 求和）')
  assert.equal(r.verdicts.length, 1)
  assert.equal(r.lastVerdict.status, 'fail')
  assert.deepEqual(r.verdicts[0].evidenceSeqs, [2])
  assert.equal(r.likelyOutcome, undefined, '有验收结论时不猜')
  assert.ok(r.signals.some((s) => s.text.includes('最近一次验收结论为 fail')), '验收失败信号')
})

test('没有 verdict 时才给过程推断，且固定 low 置信度、自带「非验收结论」声明', () => {
  const clean = buildAgentReport({ rows: [llm({ seq: 1 }), tool({ seq: 2 })], contextBudgetBytes: 300 * 1024, runId: 'r1' })
  assert.equal(clean.likelyOutcome.label, 'likely-pass')
  assert.equal(clean.likelyOutcome.confidence, 'low')
  assert.ok(clean.likelyOutcome.reasons.some((x) => x.includes('没有任何验收结论')))
  const bad = buildAgentReport({ rows: [llm({ seq: 1 }), tool({ seq: 2, ok: false })], contextBudgetBytes: 300 * 1024, runId: 'r1' })
  assert.equal(bad.likelyOutcome.label, 'likely-fail')
  assert.ok(bad.signals.some((s) => s.text.includes('非验收结论')), '必须自证不是结论')
})

// ── L3 工具同现统计（同现不是因果：只统计该工具出现在哪类轮次里） ──
test('toolOutcome 统计同轮重试 / 末轮 / 带验收结论的轮次，并剔除本插件自身工具', () => {
  const rows = [
    llm({ seq: 1, ts: 1000, turn: 1 }),
    tool({ seq: 2, ts: 1100, turn: 1, name: 'bash' }),
    tool({ seq: 3, ts: 1200, turn: 1, name: 'bash' }),   // 同轮第 2 次
    llm({ seq: 4, ts: 2000, turn: 2 }),
    tool({ seq: 5, ts: 2100, turn: 2, name: 'read' }),   // 末轮
    verdictRow({ seq: 6, ts: 2200, turn: 2 }),           // 同轮带 fail 验收
    tool({ seq: 7, ts: 2300, turn: 2, name: 'task_verdict' }), // 本插件自身工具
  ]
  const r = buildAgentReport({ rows, contextBudgetBytes: 300 * 1024, runId: 'r1' })
  const bash = r.toolOutcome.find((e) => e.name === 'bash')
  const read = r.toolOutcome.find((e) => e.name === 'read')
  assert.equal(bash.calls, 2)
  assert.equal(bash.retriedInTurn, 1, '同轮内两次调用 → 重试计数 1（第 2 次起算）')
  assert.equal(bash.inFinalTurn, 0, 'bash 落在第 1 轮，不是该会话末轮')
  assert.equal(read.calls, 1)
  assert.equal(read.inFinalTurn, 1, 'read 落在第 2 轮 = 末轮')
  assert.equal(read.inTurnWithVerdictFail, 1, 'read 所在轮次带 fail 验收')
  assert.equal(read.inTurnWithVerdictPass, 0)
  assert.equal(r.toolOutcome.find((e) => e.name === 'task_verdict'), undefined, '本插件自身工具不进 toolOutcome')
})

// ── L4 技能前后窗口对比 ──
test('skillEffect 给出加载前后窗口指标，窗口无边时缺省而非填 0', () => {
  const rows = [
    llm({ seq: 1, ts: 1000, turn: 1, usageIn: 100 }),
    tool({ seq: 2, ts: 1100, turn: 1, name: 'bash' }),
    llm({ seq: 3, ts: 2000, turn: 2, usageIn: 100 }),
    tool({ seq: 4, ts: 2100, turn: 2, name: 'bash', ok: false }),
    tool({ seq: 5, ts: 3000, turn: 3, name: 'skill', tag: 'skill', summary: 'skill: demo' }),  // 锚点
    llm({ seq: 6, ts: 4000, turn: 4, usageIn: 200 }),
    tool({ seq: 7, ts: 4100, turn: 4, name: 'read' }),
    llm({ seq: 8, ts: 5000, turn: 5, usageIn: 200 }),
    tool({ seq: 9, ts: 5100, turn: 5, name: 'read' }),
  ]
  const r = buildAgentReport({ rows, contextBudgetBytes: 300 * 1024, runId: 'r1', skillWindowTurns: 3 })
  assert.deepEqual(r.skillLoads.map((s) => s.name), ['demo'])
  assert.equal(r.skillLoads[0].turn, 3)
  assert.equal(r.skillEffect.length, 1)
  const e = r.skillEffect[0]
  assert.equal(e.loads, 1)
  assert.deepEqual(e.windowBefore, { turns: 2, toolCalls: 2, failedCalls: 1, inputTokens: 200 })
  assert.deepEqual(e.windowAfter, { turns: 2, toolCalls: 2, failedCalls: 0, inputTokens: 400 })

  // 锚点就在第 1 轮、且之后没有活动 → 两个窗口都缺省（不填 0，否则看起来像"这段时间没有活动"）
  const only = buildAgentReport({
    rows: [tool({ seq: 1, ts: 1000, turn: 1, name: 'skill', tag: 'skill', summary: 'skill: 只有加载' })],
    contextBudgetBytes: 300 * 1024,
    runId: 'r1',
  })
  assert.equal(only.skillEffect[0].windowBefore, undefined)
  assert.equal(only.skillEffect[0].windowAfter, undefined)
})

// ── L6 进化提案：只写提案、不执行；不污染失败/耗时/工具口径 ──
const proposalRow = (over = {}) => ({
  seq: 4, ts: 1300, sessionId: 's1', runId: 'r1', kind: 'proposal', name: 'evolution_proposal', tag: 'proposal',
  summary: 'skill/create demo · proposed', settled: true, rev: 1,
  proposal: { pkind: 'skill', action: 'create', target: 'demo', rationale: '同类失败重复 2 次', evidenceSeqs: [2], status: 'proposed', by: 'agent', at: 1300 },
  ...over,
})

test('proposals 汇总：只把 proposed 计入待批，且不进 failedCalls / durationMs / toolOutcome', () => {
  const rows = [
    llm({ seq: 1, ts: 1000, durationMs: 900 }),
    tool({ seq: 2, ts: 1100, durationMs: 5, ok: false }),
    proposalRow(),
    proposalRow({
      seq: 5, ts: 1400,
      proposal: {
        pkind: 'plugin', action: 'disable', target: '@michengai/dsh-humanizer', rationale: '热停用即可撤回',
        evidenceSeqs: [2], status: 'approved', by: 'user', at: 1400,
      },
    }),
  ]
  const r = buildAgentReport({ rows, contextBudgetBytes: 300 * 1024, sessionId: 's1', runId: 'r1' })
  assert.equal(r.proposals.length, 2)
  assert.deepEqual(r.proposals.map((p) => p.pkind), ['skill', 'plugin'])
  assert.equal(r.proposals[1].status, 'approved')
  assert.equal(r.pendingProposals, 1, '只有 proposed 计入待批')
  assert.equal(r.totals.failedCalls, 1, '提案行不进 failedCalls（不能用 ok:false 表达被否决）')
  assert.equal(r.totals.durationMs, 905, '提案行不带 durationMs（报告侧跨 kind 求和）')
  assert.equal(r.toolOutcome.find((e) => e.name === 'evolution_proposal'), undefined, '提案工具自身不进 toolOutcome')
})
// ── L6：提案状态推进（append-only 变更行 → 有效状态） ──
// 为什么要是 append-only：状态变更如果原地改历史行，跨进程重启后就没法知道「谁在什么时候改的」，
// 而且要改写已落盘的 JSONL。这里用「追加一行带 transitionOf 的 proposal 行」表达变更，
// 有效状态 = 同一 id 上 (ts, seq) 最大的那一行。
const propRow = (over = {}) => ({
  seq: 9, ts: 1500, sessionId: 's1', runId: 'r1', kind: 'proposal', name: 'evolution_proposal', tag: 'proposal',
  summary: '提案 · skill/create demo', settled: true, rev: 1,
  proposal: {
    pkind: 'skill', action: 'create', target: 'demo', rationale: '同类失败重复 3 次',
    id: 'p-r1-1-1', status: 'proposed', by: 'agent', at: 1500,
  },
  ...over,
})

test('effectiveProposalStatus：同一 id 取最新一条变更行，且不依赖输入顺序', () => {
  const created = propRow()
  const earlier = propRow({
    seq: 10, ts: 1600,
    proposal: { ...created.proposal, transitionOf: 9, status: 'approved', by: 'user', at: 1600 },
  })
  const later = propRow({
    seq: 12, ts: 1700,
    proposal: { ...created.proposal, transitionOf: 9, status: 'rejected', by: 'user', at: 1700 },
  })
  const m = effectiveProposalStatus([later, created, earlier]) // 故意乱序
  assert.equal(m.get('p-r1-1-1').status, 'rejected', '(ts, seq) 最大的那条说了算')
  assert.equal(m.get('p-r1-1-1').by, 'user')
  assert.equal(effectiveProposalStatus([created]).get('p-r1-1-1').status, 'proposed', '没有变更行时就是初始状态')
  // 没有 id 的老行按 session:<seq> 兜底，不能被算成两个键
  const legacy = propRow({ proposal: { ...created.proposal, id: undefined } })
  assert.equal(effectiveProposalStatus([legacy]).size, 1)
})

test('parseProposalTransition：只接受白名单状态，且必须指回一条提案', () => {
  assert.equal(parseProposalTransition({ id: 'p-1', status: 'approved' }).status, 'approved')
  assert.equal(parseProposalTransition({ seq: 9, status: 'rejected', note: '  证据不足  ' }).note, '证据不足')
  assert.throws(() => parseProposalTransition({ id: 'p-1', status: 'proposed' }), /status 必须是/,
    'agent 写的 proposed 不能从人工端点回灌')
  assert.throws(() => parseProposalTransition({ id: 'p-1', status: 'applied!' }), /status 必须是/)
  assert.throws(() => parseProposalTransition({ status: 'approved' }), /必须给 id 或 seq/)
  assert.throws(() => parseProposalTransition(null), /status 必须是/)
})

test('报告：状态变更行让 pendingProposals 归零，但不污染其余口径', () => {
  const base = [llm({ seq: 1, ts: 1000, durationMs: 900 }), tool({ seq: 2, ts: 1100, durationMs: 5, ok: false })]
  const created = propRow()
  const before = buildAgentReport({ rows: [...base, created], contextBudgetBytes: 300 * 1024, sessionId: 's1', runId: 'r1' })
  assert.equal(before.proposals.length, 1)
  assert.equal(before.proposals[0].effectiveStatus, 'proposed')
  assert.equal(before.pendingProposals, 1)

  const transition = propRow({
    seq: 12, ts: 1700,
    proposal: { ...created.proposal, transitionOf: 9, status: 'approved', by: 'user', at: 1700 },
  })
  const after = buildAgentReport({ rows: [...base, created, transition], contextBudgetBytes: 300 * 1024, sessionId: 's1', runId: 'r1' })
  assert.equal(after.pendingProposals, 0, '有效状态已批准 → 不再待批')
  assert.equal(after.proposals.length, 1, '变更行不单列成一条新提案')
  assert.equal(after.proposals[0].status, 'proposed', '原提案行不动（append-only）')
  assert.equal(after.proposals[0].effectiveStatus, 'approved')
  assert.equal(after.totals.failedCalls, before.totals.failedCalls, '状态变更不改变失败计数')
  assert.equal(after.totals.durationMs, before.totals.durationMs, '状态变更不带 durationMs（跨 kind 求和会虚高）')
  assert.equal(after.toolOutcome.find((e) => e.name === 'evolution_proposal'), undefined, '提案/变更行不进工具 ROI')
})
// ── L5 跨会话聚合：纯函数 / 磁盘缓存 / 聚合器 ──
test('summarizeSession 复用 sessionTotals 的口径，并按失败签名聚合', () => {
  const rows = [
    llm({ seq: 1, ts: 100, turn: 1, usageIn: 10, usageOut: 2 }),
    tool({ seq: 2, ts: 200, turn: 1, ok: false, failSig: 'bash|error|enoent' }),
    tool({ seq: 3, ts: 300, turn: 1, ok: false, failSig: 'bash|error|enoent' }),
    tool({ seq: 4, ts: 400, turn: 2, ok: true }),
    tool({ seq: 5, ts: 500, turn: 2, ok: false, failSig: 'read|error|eacces' }),
  ]
  const s = summarizeSession(rows, 's1')
  assert.equal(s.sessionId, 's1')
  assert.equal(s.rows, 5)
  assert.equal(s.firstTs, 100)
  assert.equal(s.lastTs, 500)
  assert.equal(s.turns, 2, '轮数与 sessionTotals 同口径')
  assert.equal(s.llmCalls, 1)
  assert.equal(s.toolCalls, 4)
  assert.equal(s.failedCalls, 3)
  assert.equal(s.inputTokens, 10)
  assert.equal(s.outputTokens, 2)
  assert.deepEqual(s.failSigs, [
    { sig: 'bash|error|enoent', count: 2 },
    { sig: 'read|error|eacces', count: 1 },
  ])
  assert.deepEqual(s.topFailSig, { sig: 'bash|error|enoent', count: 2 })
  assert.equal(s.topTools[0].name, 'bash')
  const empty = summarizeSession([], 'x')
  assert.equal(empty.topFailSig, null, '没有失败就不编一个签名出来')
  assert.equal(empty.turns, 0)
})

test('recurringFailSigs 只认跨会话复现：同一会话里重复多少次都只算一个会话', () => {
  const A = summarizeSession([
    tool({ seq: 1, ts: 1, ok: false, failSig: 'sig-1' }),
    tool({ seq: 2, ts: 2, ok: false, failSig: 'sig-1' }),
  ], 'A')
  const B = summarizeSession([
    tool({ seq: 3, ts: 3, ok: false, failSig: 'sig-2' }),
    tool({ seq: 4, ts: 4, ok: false, failSig: 'sig-2' }),
    tool({ seq: 5, ts: 5, ok: false, failSig: 'sig-1' }),
  ], 'B')
  const C = summarizeSession([tool({ seq: 6, ts: 6, ok: false, failSig: 'sig-3' })], 'C')
  const rec = recurringFailSigs([A, B, C], 2)
  assert.deepEqual(rec.map((x) => x.sig), ['sig-1'], 'sig-2 只在一个会话里炸过 → 不算跨会话复现')
  assert.equal(rec[0].sessions, 2)
  assert.equal(rec[0].failures, 3, 'A 两次 + B 一次 = 3 次')
  assert.deepEqual(recurringFailSigs([A, B, C], 1).map((x) => x.sig), ['sig-1', 'sig-2', 'sig-3'])
})

test('SummaryCache：键是 (行数, lastTs)，坏文件/旧版本当空缓存，写得进读得回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-cache-'))
  try {
    const file = join(dir, 'summaries.json')
    const sum = summarizeSession([tool({ seq: 1, ts: 1, ok: false, failSig: 'sig-x' })], 'A')
    const c1 = new SummaryCache(file)
    c1.load()
    assert.equal(c1.get('A', 3, 100), undefined, '空缓存一定 miss')
    c1.set('A', sum, 3, 100)
    assert.equal(c1.save(), true)
    assert.equal(c1.get('A', 3, 100).sessionId, 'A', '同键命中')
    assert.equal(c1.get('A', 4, 100), undefined, '行数变了 → 失效')
    assert.equal(c1.get('A', 3, 101), undefined, '末次时间变了 → 失效')
    assert.equal(c1.get('B', 3, 100), undefined, '没见过的会话 → 失效')
    assert.equal(c1.save(), false, '没有变更就不写盘')

    const c2 = new SummaryCache(file)
    c2.load()
    assert.equal(c2.get('A', 3, 100).rows, 1, '重启后也能读回 —— 省下的就是那次全库扫描')

    writeFileSync(file, '{ 这不是 JSON')
    const c3 = new SummaryCache(file)
    c3.load()
    assert.equal(c3.get('A', 3, 100), undefined, '坏文件 = 空缓存，不能抛')

    writeFileSync(file, JSON.stringify({ v: SUMMARIES_VERSION + 1, entries: { A: { rows: 3, lastTs: 100, sum } } }))
    const c4 = new SummaryCache(file)
    c4.load()
    assert.equal(c4.get('A', 3, 100), undefined, '版本不符 → 重建')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectCrossSessions：只读最近 limit 个会话；行数未变时全部命中缓存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-cross-'))
  try {
    const store = new HistoryStore({ dir })
    store.append(tool({ seq: 1, ts: 100, sessionId: 'CS1', runId: 'old', ok: false, failSig: 'bash|error|enoent' }))
    store.append(tool({ seq: 2, ts: 200, sessionId: 'CS2', runId: 'old', ok: false, failSig: 'bash|error|enoent' }))
    store.append(tool({ seq: 3, ts: 300, sessionId: 'CS3', runId: 'old', ok: false, failSig: 'read|error|eacces' }))
    store.flushSync()
    const cache = new SummaryCache(join(dir, 'summaries.json'))

    const r1 = collectCrossSessions(store, cache, { limit: 10 })
    assert.equal(r1.scanned.sessions, 3)
    assert.equal(r1.scanned.read, 3, '首次必须读盘')
    assert.equal(r1.scanned.reused, 0)
    assert.equal(r1.recurring.length, 1, '只有 enoent 跨了两个会话')
    assert.match(r1.recurring[0].sig, /enoent/)
    assert.equal(r1.recurring[0].sessions, 2)
    assert.equal(r1.sessions.reduce((n, s) => n + s.rows, 0), 3)

    const r2 = collectCrossSessions(store, cache, { limit: 10 })
    assert.equal(r2.scanned.read, 0, '行数/末次时间都没变 → 一次盘都不读')
    assert.equal(r2.scanned.reused, 3)
    assert.equal(r2.cache.hits >= 3, true, `缓存命中计数可见（实 ${r2.cache.hits}）`)

    const r3 = collectCrossSessions(store, cache, { limit: 2 })
    assert.equal(r3.scanned.sessions, 2, 'limit 生效（只取最近的 N 个）')

    store.append(tool({ seq: 4, ts: 400, sessionId: 'CS1', runId: 'old', ok: true }))
    store.flushSync()
    const r4 = collectCrossSessions(store, cache, { limit: 10 })
    assert.equal(r4.scanned.read, 1, '只有被追加过的那一个会话重读')
    assert.equal(r4.scanned.reused, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('collectCrossSessions：带内存行时当前会话不吃缓存的滞后值（未落盘的行也算进去）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-live-'))
  try {
    const store = new HistoryStore({ dir })
    store.append(tool({ seq: 1, ts: 100, sessionId: 'LV1', runId: 'old', ok: true }))
    store.flushSync()
    const cache = new SummaryCache(join(dir, 'summaries.json'))
    const live = [tool({ seq: 2, ts: 200, sessionId: 'LV1', runId: 'r1', ok: false, failSig: 'sig-live' })]

    const r = collectCrossSessions(store, cache, { limit: 10, liveRows: live })
    assert.equal(r.scanned.live, 1, '有内存行的会话走内存路径')
    assert.equal(r.scanned.read, 0, '走内存 → 既不吃缓存也不重读文件')
    const s = r.sessions.find((x) => x.sessionId === 'LV1')
    assert.equal(s.rows, 2, '磁盘 1 行 + 内存 1 行 = 2 行（按 seq:ts 合并）')
    assert.equal(s.failedCalls, 1, '未落盘的失败也在内 —— 这就是修掉的滞后')
    assert.equal(s.topFailSig.sig, 'sig-live')

    // 不带内存行时回到磁盘口径（另一种用法，不能被内存行污染）
    const r2 = collectCrossSessions(store, cache, { limit: 10 })
    assert.equal(r2.sessions.find((x) => x.sessionId === 'LV1').rows, 1)
    assert.equal(r2.scanned.live, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
