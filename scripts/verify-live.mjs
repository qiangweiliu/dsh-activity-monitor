#!/usr/bin/env node
/**
 * 对着**正在运行的 dsh** 验证 activity-monitor 的活体行为（不是冒烟，不造假数据）。
 *
 *   node scripts/verify-live.mjs                       # 默认 http://127.0.0.1:3080
 *   node scripts/verify-live.mjs --base http://127.0.0.1:3080
 *   node scripts/verify-live.mjs --session session-xxx  # 指定会话（缺省挑行数最多的历史会话）
 *   node scripts/verify-live.mjs --verbose              # 打印每行明细
 *
 * 断言的是协议 v2 的硬契约（改错了会静默变慢/变空的地方）：
 *   1. /selfcheck /config 活着，配置与端点统计合理
 *   2. /history?light=1 与 /snapshot 的行**不含正文**，且带 hasBody 标记
 *   3. hasBody=true 的行能用 /row 取回正文，正文体积远大于轻行（分层确实生效）
 *   4. 增量游标：since=lastSeq 不再重发老行
 * 退出码非 0 = 有断言失败（可直接接进 CI 或人工排查）。
 */
const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const BASE = argOf('--base', 'http://127.0.0.1:3080').replace(/\/$/, '')
const VERBOSE = args.includes('--verbose')
const API = `${BASE}/api/activity-monitor`

const failures = []
const checks = []
const ok = (name, cond, detail = '') => {
  checks.push({ name, pass: Boolean(cond), detail })
  if (!cond) failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

/** 带字节数的请求（用 text 而不是 json，方便核对 payload 体积） */
const get = async (path) => {
  const res = await fetch(API + path)
  const text = await res.text()
  return { status: res.status, bytes: Buffer.byteLength(text, 'utf8'), json: JSON.parse(text) }
}
const hasBodyKeys = (row) => row.detail !== undefined || row.sections !== undefined

console.log(`verify-live → ${API}\n`)

// ── 1) 自检 ──
const self = await get('/selfcheck')
ok('/selfcheck 200', self.status === 200, `status=${self.status}`)
ok('协议版本 v2', self.json.v === 2, `v=${self.json.v}`)
ok('宿主 runId 存在', typeof self.json.runId === 'string' && self.json.runId.length > 0, self.json.runId)
ok('端点无错误累计', (self.json.endpoint?.errors ?? 1) === 0, `errors=${self.json.endpoint?.errors}`)
const sessions = self.json.history?.sessions ?? []
ok('历史库可读（至少 1 个会话）', sessions.length > 0, `sessions=${sessions.length}, badLines=${self.json.history?.badLines}`)
ok('归档巡检已执行过', self.json.history?.lastArchiveAt > 0,
  `lastArchive=${JSON.stringify(self.json.history?.lastArchive)}`)

// ── 2) 配置 ──
const cfg = await get('/config')
ok('/config 200', cfg.status === 200)
ok('client 旋钮齐全（浏览器侧读档用）',
  typeof cfg.json.client?.pollActiveMs === 'number' && typeof cfg.json.client?.maxRows === 'number',
  JSON.stringify(cfg.json.client))

// ── 3) 选一个会话（缺省挑行数最多的历史会话）──
let sessionId = argOf('--session', '')
if (!sessionId) {
  const best = [...sessions].sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0)).filter((s) => s.sessionId)[0]
  sessionId = best?.sessionId ?? ''
}
ok('选中一个会话做验证', Boolean(sessionId), sessionId)
if (!sessionId) {
  console.log('\n没有可用会话，无法继续')
  process.exit(1)
}

// ── 4) 历史：light=1 必须不含正文 ──
const hist = await get(`/history?sessionId=${encodeURIComponent(sessionId)}&light=1&limit=200`)
const hRows = hist.json.rows ?? []
ok('/history?light=1 有行', hRows.length > 0, `rows=${hRows.length}, total=${hist.json.total}, ${hist.bytes} 字节`)
ok('历史轻行不含正文（detail/sections）', hRows.every((r) => !hasBodyKeys(r)),
  `带正文的行=${hRows.filter(hasBodyKeys).length}`)
ok('历史轻行带 hasBody 标记', hRows.every((r) => typeof r.hasBody === 'boolean'))
const perRow = hRows.length ? hist.bytes / hRows.length : 0
ok('历史轻行体积有界（< 2KB/行）', perRow < 2048, `${perRow.toFixed(0)} 字节/行`)

// ── 5) 快照：轻行 + 游标 + 标记 ──
const snap = await get(`/snapshot?since=0&sessionId=${encodeURIComponent(sessionId)}`)
ok('/snapshot 200', snap.status === 200)
ok('快照行不含正文', (snap.json.rows ?? []).every((r) => !hasBodyKeys(r)),
  `rows=${snap.json.rows?.length}`)
ok('快照带 lastSeq 游标', typeof snap.json.lastSeq === 'number', `lastSeq=${snap.json.lastSeq}`)
ok('快照带 marks 增量日志字段',
  typeof snap.json.markGen === 'number' && Array.isArray(snap.json.marks),
  `markGen=${snap.json.markGen}, marks=${snap.json.marks?.length}`)

// ── 6) 正文：/row 按需取回；体积比必须按**同一行**比（跨行取平均会把工具小行和带提示词的模型行混在一起，失真）──
const bodyRows = hRows.filter((r) => r.hasBody).slice(0, 5)
ok('历史里有带正文的行可验', bodyRows.length > 0, `hasBody 行=${hRows.filter((r) => r.hasBody).length}`)
let got = 0
let bodyBytes = 0
let worst = { seq: 0, name: '', light: 0, body: 0 }
for (const row of bodyRows) {
  const lightBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
  const body = await get(`/row?seq=${row.seq}&ts=${row.ts}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`)
  const payload = body.json.row
  const sections = payload?.sections ?? []
  const detail = typeof payload?.detail === 'string' ? payload.detail : ''
  if (sections.length > 0 || detail !== '') got++
  bodyBytes += body.bytes
  if (body.bytes > worst.body) worst = { seq: row.seq, name: row.name, light: lightBytes, body: body.bytes }
  if (VERBOSE) {
    console.log(`   · seq=${row.seq} ${row.name} → 轻行 ${lightBytes} 字节 / 正文 ${body.bytes} 字节，${sections.length} 段${detail ? ' + detail' : ''}`)
  }
}
ok('/row 能取回正文', got === bodyRows.length, `成功 ${got}/${bodyRows.length}`)
console.log(`\n分层体积（单行对比）：最大正文行 seq=${worst.seq} ${worst.name}`
  + ` —— 轻行 ${worst.light} 字节 vs 正文 ${worst.body} 字节（本批正文合计 ${bodyBytes} 字节）`)
if (worst.body >= 4096) {
  ok('大正文行的正文体积 ≥ 轻行的 2 倍（分层生效）', worst.body > worst.light * 2,
    `${worst.body} vs ${worst.light}`)
} else {
  console.log(`ⓘ 该会话最大正文仅 ${worst.body} 字节（纯工具行，本来就没有提示词正文），体积比不适用；`
    + ' 用 --session 指定带提示词的模型会话可验此项')
}

// ── 7) 增量：游标之后不应重发老行 ──
const inc = await get(`/snapshot?since=${snap.json.lastSeq}&sessionId=${encodeURIComponent(sessionId)}`)
ok('增量里没有游标之前的老行', (inc.json.rows ?? []).every((r) => r.seq > snap.json.lastSeq),
  `新增 rows=${inc.json.rows?.length}, ${inc.bytes} 字节`)

// ── 汇总 ──
const pass = checks.filter((c) => c.pass).length
console.log(`\n${pass}/${checks.length} 项通过`)
if (failures.length) {
  console.log('\n失败项：')
  for (const f of failures) console.log(` - ${f}`)
  process.exit(1)
}
console.log('LIVE VERIFY PASSED')
