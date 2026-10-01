# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；协议版本见 `src/wire.ts` 的 `PROTOCOL`
（轻行/按需正文的分层契约，变更时递增）。

## [0.6.0] - 2026-10-01

### 新增（L5 跨会话聚合：在哪类任务上反复低效）

- `activity_report` 新增 `crossSessions` 参数（数字 = 会话数上限，上限 50；**缺省不聚合** →
  报告里不出现该字段）：返回按会话汇总（行 / 轮 / 模型 · 工具 / 失败 / in-out token / 首要失败签名）
  与**跨会话复现的失败签名**（同一签名出现在 ≥2 个会话里）。
- 配置新增 `crossSessionLimit`（默认 12，范围 1–50）。
- 汇总缓存 `summaries.json`（与历史同目录）：键 = `(文件行数, 末次时间)`，临时文件 + rename 原子写；
  坏文件 / 版本不符 = 当空缓存重建（错误只计数）。删掉它只影响速度，不影响任何事实。
- `/selfcheck` 增加 `summaries`（命中 / 未命中 / 错误 / 条目 / 保存时间）—— 缓存不是黑盒。
- 正在跑的会话**不吃缓存**（内存行按 `seq:ts` 与磁盘行合并）：修掉实测到的「未落盘的行使汇总滞后」缺口。

### 变更

- `mergeActivityRows` 从 `index.ts` 移到 `wire.ts`（宿主取数、跨会话聚合、单测共用一份规则）。
- 单测 37（+5：会话汇总、跨会话复现签名、缓存键 / 坏文件 / 版本、聚合器、内存行路径）；
  冒烟 +13 条 L5 断言（含「纯附加：不改变本会话计数口径」）。

## [0.5.0] - 2026-10-01

### 新增（提案闭环的人批侧：只记录，不执行）

- **交互式待批队列**：面板上「待批准」的提案行带「批准 / 否决」按钮，点完就地刷新状态。
- **人工端点** `POST /api/activity-monitor/proposal`，body `{id|seq, status, note?}`。
  守卫（冒烟 13 条断言 + 活体 HTTP 实测）：非 POST → 405；非 `application/json` → 415（浏览器会先发
  preflight，跨站表单打不进来）；状态不在白名单（**含 `proposed`**）→ 400；id/seq 指不到提案 → 404；
  成功 → 200 并**回带变更行轻行**（面板直接并进本地，不等下一次快照）。
- **状态变更 append-only**：追加一行带 `transitionOf` 的 proposal 行（同一稳定 `id`），原提案行不动 ——
  跨 dsh 重启仍可追溯，且不需要改写已落盘的 JSONL。有效状态 = 同一 id 上 `(ts, seq)` 最大的那行
  （纯函数 `derive.effectiveProposalStatus`，宿主报告与面板共用，单测覆盖乱序输入）。
- 报告 `proposals[]` 增加 `id` 与 `effectiveStatus`；`pendingProposals` 改按**有效状态**计数。

### 说明（刻意的边界）

- **agent 侧无法自我批准**：`evolution_proposal` 的 `status` 不是参数（恒 `proposed`），
  人工端点又把 `proposed` 排除在白名单外 —— 两条路都堵死。
- **批准不是执行**：本插件不持执行权。装 / 建 / 停用仍由人走 `dshmarket` /
  `@michengai/dsh-skills-manager`（见 `docs/agent-evolution-data.md` §10.3 红线）。
- 变更行与提案行同属 `kind:'proposal'`：不增加 `failedCalls`、不带 `durationMs`、不进 `toolOutcome`。
- 单测 32（+3）；冒烟新增 13 条端点端到端断言（405 / 415 / 400 / 404 / 200 / append-only / 有效状态推进）。

## [0.4.0] - 2026-10-01

### 新增（agent 自我进化的数据面与动作面）

- **L3 工具级「同现」统计** `toolOutcome`：某工具出现在哪类轮次里 —— 收敛轮（该会话本范围内末轮）、
  同轮重试、带 `pass` / `fail` 验收结论的轮次。**是同现统计不是因果推断**（无对照组）。
- **L4 技能加载前后窗口** `skillLoads` / `skillEffect`：以技能首次加载轮次为锚点，对比前后各
  `skillWindowTurns`（默认 3）轮的轮数 / 工具数 / 失败数 / 输入 token。**是前后对比不是 A/B**；
  窗口内无行时缺省而非填 0。
- **L6 进化提案** `evolution_proposal` 工具 + `kind:'proposal'` 行 + 报告 `proposals` /
  `pendingProposals`：把「该学什么 / 该装什么 / 该停用什么」写成可审阅的提案，必须指回证据
  （`evidenceSeqs`）。**本插件只写提案、不执行任何变更**：状态固定 `proposed`，批准与执行由人
  通过既有执行器（`dshmarket` / `@michengai/dsh-skills-manager`）完成。
- 自我观测剔除扩展到三个自身工具（`activity_report` / `task_verdict` / `evolution_proposal`）。
- `docs/agent-evolution-data.md`：新增 §10（提案层设计）与 §11（dsh 运行时变更边界实测）。

## [0.3.0] - 2026-10-01

### 新增（结果数据与失败归因）

- **L1 失败签名聚类**：`failSig` = `工具名|错误类别|归一化错误首行`（去 ANSI、路径→`<path>`、
  数字→`<n>`、120 字截断），在 `tools/execute` 钩子内当场计算；报告给出 `failureClusters` /
  `failuresTruncated`，`failures` 原样保留（只加不删）。
- **L2 验收结论**：`task_verdict` 工具 + `kind:'verdict'` 行；`verdict` 行不打 `ok`、不带
  `durationMs`（否则污染 `failedCalls` 与耗时合计）；没有 verdict 时才给 `likelyOutcome`
  （置信度固定 `low`，显式声明「非验收结论」）。
- `package.json` 的 `files` 补齐 `lib/*.js` 与 `*.d.ts`；移除死依赖 `@deepseek-ai/dsh-client-runtime`
  （修掉 `npm install` 的 ERESOLVE）。

### 修复

- `/row` 命中计数口径：hits = 真的取回正文，misses = 真的 404。
- 客户端 `openSession` 未 await（把异步失败当成功返回）。

## [0.2.0] - 2026-09-30

### 新增（分层协议与历史库）

- 协议 v2：快照只发轻行（标量 + `hasBody`），正文按需 `/row` 拉取；实测单行 346 B（轻行）
  vs 265,350 B（正文）。
- marks 增量日志（带 gen 游标），轮询为真增量（约 149 B/次）。
- `HistoryStore`：按会话 JSONL 落盘 + `index.json` 索引 + 超 30 天 gzip 归档（读取透明）。
- 配置面 `resolveConfig`（`maxRows` / 预算 / 轮询 / 保留）；`/selfcheck` 自检端点。

## [0.1.0] - 2026-09-29

- 首个可用版本：`llm/stream` 与 `tools/execute` 两个钩子、活动行模型、轮次分组面板、
  按需展开正文、`activity_report` 工具。
