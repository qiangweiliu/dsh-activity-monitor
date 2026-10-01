# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；协议版本见 `src/wire.ts` 的 `PROTOCOL`
（轻行/按需正文的分层契约，变更时递增）。

## [0.6.1] - 2026-10-01

### 文档（git 安装面实跑后补齐）

- README 补「安装」章节：`dsh plugin add github:…` 在 **pnpm 12** 下会先失败一次 ——
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（pnpm 默认拒绝对依赖跑构建脚本，本包要用 `prepare` 核对产物）。
  修法是把 dsh 打印的精确键（含 commit sha）加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，再重跑。
- 实跑事实：pnpm 拉该 commit 的 tarball → 临时目录 `npm install` + `prepare`（**就地重编译**，日志见
  `client bundle written: lib/client.js`）→ 按 `files` 装进 profile；装出来的 `lib/` 17 个产物齐全、
  无中间产物/冒烟脚本、运行时依赖 0 个；重启后三工具与全部端点照常（含 `POST /proposal` 的 404/405/415 守卫）。
- 本地开发仍推荐路径安装（`link:`，不需要放行、build 即生效）。


### 修复（冒烟断言依赖真实数据目录，CI 上必挂）

- `smoke-tools` 原先跑在**用户真实历史目录**里，L5 的缓存断言（第二次命中 / 复用数）只有在磁盘上
  「还有别的会话」时才成立 —— 本地真实库里有十几个老会话所以恒过，干净机器上只有当前会话，复用与命中恒为 0。
  现在与另两个冒烟一致：整个冒烟跑在临时 `$DSH_HOME` 里，退出时整目录删掉（不再往用户库里写东西）。
- 缓存断言改为**显式夹具**驱动并确定化：造两个「磁盘-only」夹具会话（各 2 行、1 次失败、共享同一失败签名），
  断言 `汇总 = 1 活 + 2 夹具`、`首次读盘 2 / 未命中 2`、`第二次读盘 0 / 复用 2`、`命中计数递增`，
  并顺带断言 `recurring` 认出夹具的共享签名（sessions=2）。断言不再依赖运行环境里恰好有多少历史。
- 根因同上一节：**只在别人机器上成立**。CI 首跑第二次失败就是它先暴露出来的。

### 修复（CI 在 Node 22 上必挂）

- `test:unit` 从 `node --test tests/`（传目录）改为 `node --test tests/*.test.js`（显式文件）。
  **根因**：Node 22 把 `node --test <目录>` 的参数当模块路径去 `require` → `Cannot find module '.../tests'`，
  一个测试都没跑到就退出（CI 首次运行 21s 挂在这步）；本地开发机是 Node 26，它会把目录当测试目录扫描，
  所以本地一直全绿。这类「只在 CI 的 Node 版本上炸」的问题肉眼看不出来，是 CI 首跑抓到的。

### 修复（git 安装会缺文件）

- `package.json` 的 `files` 漏了 `lib/cross.js` / `lib/cross.d.ts`（L5 新增的模块）。
  本地用 `link:` 安装直接读工作目录，**永远测不出来**；git 安装（`dsh plugin add github:…`）按 `files`
  打包 → 装出来的包在 import 阶段就会 `Cannot find module './cross.js'`。
- 根因是**两份手写清单**（`files` 与 prepare 的产物清单）各漏一次。现在清单只保留一处（`files`），
  新增 `scripts/check-artifacts.js` 机器核对：① `files` 条目在磁盘上都在；② 从 `lib/index.js` 出发的
  相对 import 闭包全部在 `files` 里；③ 磁盘产物要么在 `files`、要么在显式声明的开发期产物清单里
  （`client.raw.js` / `client.d.ts` / smoke / diag 这些故意不发布）。
- 同一段逻辑在三个地方跑：`prepare`（安装期）、CI、`npm test`。这次就是它先跑起来、当场报出 5 处不一致。
- 验证方式：`npm pack` 出真实产物 → 解包到无 `node_modules` 的树里跑 `prepare` → 确认 `lib/cross.js` 在位
  且宿主入口可 import（git 安装走的正是这条路径）。

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
