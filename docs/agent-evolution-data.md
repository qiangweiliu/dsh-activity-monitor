# activity-monitor 作为 agent 进化数据源：评审 + 落地设计

范围声明：**只做评审与设计，不改代码**。本文所有结论锚定到仓库里现存的
`file:line`，实现时按此施工；文中标注「现缺」的才是要做的增量。

前提（已确认）：契约**只加不删**；一切能力落在**本插件内**，不新增插件；
本插件的定位是「行为面数据源」，不做执行者。

---

## 0. 摘要

- 提议方向对，但**六条现状描述里有三条与代码不符**（下节逐条给出）。
- 真正要补的只有 5 件，且全部可在本仓库内完成：
  1. 失败签名聚类（L1，P0）
  2. verdict 任务结果 + 证据行关联（L2，P0）
  3. 工具级「同现」统计（L3，P1，依赖 L2）
  4. 技能加载前后窗口对比（L4，P1）
  5. 跨会话聚合与摘要缓存（L5，P2）
- `acp_cache`（经济面）、`lingshu_cg`（记忆面）、`find_dsh_plugin`/`automation_create`
  （能力面）在本仓库**零命中**，不属本插件责任田；闭环的「状态机」也不该放在这里。
- 两个必须写进实现的坑：`durationMs` 跨 kind 求和、`failed` 匹配任意 kind 的
  `ok === false`（见 §4.2），新增行类型若处理不当会**静默算错**。

---

## 1. 评审：提议 vs 代码现状

| 提议的说法 | 代码现状 | 判定 |
|---|---|---|
| 工具级只有「调用次数」 | `tools.byName = {name,count,failed,avgMs,lastMs}` + `tools.duplicated`（`index.ts:1202-1206`），每行带 `turn`（`types.ts:48`）与 `calls[]` 调用位置（`types.ts:55`） | **部分不准**：频次/失败/耗时/轮次归属已有；缺的是「调用 → 该轮是否收敛」的关联 |
| 失败是平铺列表，缺签名聚类 | `failures = {seq,ts,kind,name,summary≤160}`，`.slice(0,20)`（`index.ts:1207,1330`）；失败判据只有 `ok = !result.isError`（`index.ts:378`） | **成立**：无签名、无退出码、无聚类，且**上限 20 无任何提示** |
| skill/插件使用无追踪 | `tag:'skill'` 行 + `summary:'skill: <name>'`（`index.ts:302-303`），`skillPaths` 缓存 + 定期刷新（`index.ts:249-258`） | **部分不准**：加载事件有；缺的是加载前/后的对照口径 |
| 缺「任务验收是否通过」 | 全仓库搜 `verdict` **零命中** | **成立** |
| `activity_report` 只有按 session | `scope` 支持会话/全量（`index.ts:1280-1288`）、`recentTurns`（`index.ts:282-287`）、跨重启历史单列（`index.ts:1366-1385`）；历史库有 `index.json` 会话索引 `{rows,lastTs,bytes,archived}`（`history.ts:48-52,140`） | **部分不准**：缺的是**跨会话按类别聚合**，不是「完全没有」 |
| PUA 说的 SPINNING/EXPLORING 无数据源支撑 | 本仓库无该词汇 | **不该复刻**：那是别的插件的命名体系，本插件只陈述事实（重复次数/跨轮次数），避免两套词汇表打架 |

另一处边界必须说清：`failures` 里那条「本运行范围内 N 条调用处于失败状态」的
signal（`index.ts:1361`）已经用了「事实 + 阈值」口径，后续新增信号沿用它，
不要写成因果结论。

---

## 2. 设计原则（由用户要求倒推）

1. **只陈述事实**：沿用现有 signals 口径（事实 + 阈值），不替 agent 下决策
   （`index.ts:1354-1363` 的写法就是范本）。
2. **只加不删**：`failures` 保留原样，新字段并行存在；截断处补标记。
3. **不新增插件**：包括新增的写入工具（`task_verdict`）也注册在本插件里
   （本插件已用 `ctx.inject(['tools','webServer'])` 懒注册工具，`index.ts:795-921`，可直接复用该模式）。
4. **每条自我修改必须可验收**：verdict 必须能**引用证据行**（seq），且证据行本身
   是 agent 用普通 `bash` 工具跑验收命令留下的真实工具行。
5. **本插件不做执行者**：不获得执行权、不跑验收命令、不存技能状态机。执行由
   agent 用 `bash` 完成，本插件只记录与关联。

---

## 3. L1 失败签名聚类（P0）

### 3.1 捕获点（关键：必须在钩子内抓）

结构化错误只在 `tools/execute` 钩子内可得：

- `result.isError === true` → 错误文本取 `result.content` 的各 TextBlock，
  兜底 `result.error.message`（`index.ts:372-374`）
- 抛异常路径 → `catch (err)`（`index.ts:390-399`）
- 两者都写进 `detail` 的「── 结果 ── / ── 异常 ──」段（散文形态）

**不要在 `buildAgentReport` 里事后从 `detail` 正则反解签名** —— 参数段和结果段
混在一起、且被预算截断（`clampText`，`index.ts:948-952`），必然脆。
签名在钩子里当场算，作为**行字段**落盘。

### 3.2 签名定义

```
sig = `${toolName}|${errClass}|${normalize(firstLine(errorText))}`
```

- `errClass`：`exception`（catch 分支）/ `error`（isError）/ `no-output`（结果为空）
- `normalize`（幂等，可单测）：
  1. 去 ANSI 转义
  2. 绝对路径 → `<path>`（`/x/y/z`、`C:\...`）
  3. 数字/十六进制/时间戳/行号 → `<n>`
  4. 折叠空白 → 单空格
  5. 小写化、截断 120 字符

### 3.3 改动清单（只加）

| 位置 | 增量 |
|---|---|
| `types.ts:ActivityRow` | `failSig?: string`（仅失败行有） |
| `wire.ts` `LIGHT_KEYS`/`LightRow` | 加 `failSig`（列表要能显示聚类键，否则面板与报告口径不一致） |
| `index.ts:1330` 附近 | 保留 `failures`；新增 `failureClusters`、`failuresTruncated` |
| `activity_report` parameters | 加 `maxFailures?:number`（默认 20）、`clusterMinCount?:number`（默认 2） |
| `render`（`index.ts:846-883`） | 增一行「失败聚类：`sig` ×N（工具 X，最近 seq）」，**并在 `failures` 被截断时显式说明** |

新增报告字段：

```ts
readonly failureClusters: {
  sig: string; tool: string; errClass: string;
  count: number; turns: number[]; firstSeq: number; lastSeq: number;
  exampleSeqs: number[];        // 最多 3 条，供 agent 回查 /row 正文
}[]
readonly failuresTruncated?: { total: number; shown: number }
```

### 3.4 验收断言

- 单测：归一化幂等（同文本两次 → 同 sig）；路径/数字脱敏；同签名跨轮聚合；
  不同签名不合并；`failures` 上限触发时 `failuresTruncated.shown === 20`。
- smoke：构造 3 次相同错误的工具调用 → `failureClusters.length === 1 &&
  count === 3`，且 `failures` 仍存在（只加不删的回归锚）。

---

## 4. L2 verdict 任务结果 + 证据关联（P0）

### 4.1 存储：新增行类型 `kind:'verdict'`

复用 `record()`（`index.ts:182-187`）落进**同一份会话 JSONL**，于是免费获得：
面板时间轴、`/history`、`/row`、跨重启读取、gzip 归档、保留策略。

改动清单：

| 位置 | 增量 |
|---|---|
| `types.ts:31` | `kind: 'llm' \| 'tool' \| 'verdict'` |
| `types.ts` | `verdict?: { status:'pass'\|'fail'\|'partial'\|'unknown'; basis:string; evidenceSeqs?:number[]; verifyCommand?:string; verifySeqs?:number[]; by:'agent'\|'user'; at:number }` |
| `wire.ts` `LIGHT_KEYS` | 加 `verdict`（列表/面板需要 status 与依据首行） |
| `client.tsx` | 渲染 verdict 行（tag 配色 + status 徽标）；**不加会显示 undefined** |
| `index.ts:1290-1298` | 确认 kind 过滤不会把它算进 `llm`/`toolRows`（现均为显式 `kind ===`，安全） |

### 4.2 两个必须规避的静默错算（实现注记）

1. `durationMs` 是**跨 kind** 求和：`scope.filter(settled !== false).reduce(durationMs)`
   （`index.ts:1309-1310`，没有 kind 过滤）→ **verdict 行不要带 `durationMs`**。
2. `failed` 是**任意 kind** 的 `ok === false`（`index.ts:1292`），并驱动
   `totals.failedCalls` 与「N 条调用处于失败状态」信号（`index.ts:1396,1361`）
   → **verdict 行不得用 `ok:false` 表达验收失败**，`ok` 一律缺省，
   验收结果只放在 `verdict.status`。

### 4.3 写入通道：本插件第二个工具 `task_verdict`（write 类）

用 `ctx.inject(['tools','webServer'])` 的既有懒注册模式（`index.ts:795-921`）注册。

```
task_verdict(
  status: 'pass'|'fail'|'partial'|'unknown',
  basis: string(≤500),
  evidenceSeqs?: number[],       // 指向真实工具行 seq
  verifyCommand?: string,        // 仅记录文本，本插件不执行
  verifySeqs?: number[],         // 该命令对应的工具行 seq
)
```

- **不执行任何命令**：agent 用普通 `bash` 工具跑验收命令，那一行就是证据，
  再由 `evidenceSeqs`/`verifySeqs` 引用 → 得到「验收结论 → 证据行 → 命令」的
  可追链条，而插件不获得执行权。这是「数据源」与「执行者」的分界。
- 幂等：同一会话允许多次 verdict，报告给**最新一条**；全部保留在时间轴上。
- 权限面注记：这是本插件**第一个由 agent 主动写入**的入口（此前只读+自监控写），
  需在 README 写明落盘位置（会话 JSONL）与保留/归档策略的连带影响。

### 4.4 报告新增（只加）

```ts
readonly verdicts: { seq:number; ts:number; status:string; basis:string; evidenceSeqs:number[] }[]
readonly lastVerdict?: { status:string; ts:number; basis:string; seq:number }
readonly likelyOutcome?: {                 // 仅在「没有任何 verdict」时给
  label: 'likely-pass'|'likely-fail'; confidence: 'low'; reasons: string[]
}
```

- `lastVerdict.status === 'fail'` → 新增一条 `warn` 信号（附依据，不带因果结论）。
- `likelyOutcome` 必须在 signals 里显式声明「**非验收结论，仅为过程推断**」，
  置信度固定 `low`；有 verdict 时该字段**缺省**（不猜）。

### 4.5 外部验收命令（可选，默认关）

若要「验收命令退出码为准」的强口径，只能做成**配置门控的 opt-in**
（默认关闭、带超时与白名单），因为那等于把执行权交给监控插件。属可选项，
不进 P0。

### 4.6 状态机的边界

「试用期 → 数据达标转正 → 回滚」是**技能/插件管理层**的状态机，
本插件只提供输入事实：`skillLoads`（L4）、`verdicts`、`failureClusters`、
以及命令行的 `ok`/退出码与否。不要把技能状态存进本插件。

### 4.7 验收断言

- `task_verdict` 调用后：`report.verdicts.length === 1`；
  `totals.failedCalls` **未增加**；`totals.durationMs` **未变化**（两条注记的回归锚）。
- 跨重启（进程重启后读同一会话）：verdict 行仍可读（走 `history.ts.rows()`）。
- 面板：verdict 行渲染出 status 与依据首行，且不参与「模型/工具」计数。

---

## 5. L3 工具级「同现」统计（P1，依赖 L2）

> **状态：已落地（0.3.0）** —— `toolOutcome` + `activity_report` 渲染 + 单测 + smoke 断言。
> 实现口径：`inFinalTurn` = 该工具行所在轮次 = 该会话（本范围内）的最后一轮；
> 无 verdict 时 `inTurnWithVerdict*` 恒为 0（不是缺省）；已剔除本插件自身工具。

只用已有数据，不新增采集。可计算的量：

- `inFinalTurn`：该工具行所在 `turn` 之后，该会话再无后续行（收敛迹象）
- `retriedInTurn`：同一 `turn` 内同名工具再次调用
- `inTurnWithVerdict`：该 turn 内是否存在 `pass` / `fail` 的 verdict（L2 落地后才有）

```ts
readonly toolOutcome: {
  name:string; calls:number; failed:number;
  inFinalTurn:number; retriedInTurn:number;
  inTurnWithVerdictPass:number; inTurnWithVerdictFail:number;
}[]
```

**口径纪律**：这是**同现统计**，不是因果推断（无对照组）。文案必须写成
「工具 X 的调用出现在通过验收的轮次 N 次 / 失败轮次 M 次」，
不能写成「工具 X 造成成功/失败」。

验收断言：单测构 3 轮（工具 A 出现在 pass 轮、工具 B 出现在 fail 轮）→ 计数正确；
无 verdict 时后两个字段为 0（不是缺省）。

---

## 6. L4 技能加载前后窗口对比（P1）

> **状态：已落地（0.3.0）** —— `skillLoads` + `skillEffect` + `skillWindowTurns` 参数 + 单测 + smoke 断言。
> 实现口径：锚点 = 该技能**首次**加载所在轮次（同技能多次加载只做一次对比，次数记在 `loads`）；
> 窗口内一行都没有 → 该侧缺省。

锚点已有：`tag:'skill'` 行 + `summary:'skill: <name>'`（`index.ts:302-303`）。

```ts
readonly skillLoads: { name:string; seq:number; ts:number; turn:number }[]
readonly skillEffect: {
  name:string; loads:number;
  windowBefore: { turns:number; toolCalls:number; failedCalls:number; inputTokens:number };
  windowAfter:  { turns:number; toolCalls:number; failedCalls:number; inputTokens:number };
}[]
```

- 窗口默认各 3 轮（可配），缺前后窗口时该字段缺省而非填 0。
- **命名纪律**：这是「前后对比」，不是 A/B —— 没有对照组、窗口内任务难度不同。
  文案只陈述差值，并标注「不构成因果」。真正对照要么同一类任务跑两次（影子 A/B），
  要么人工抽查；那是流程问题，不是本插件的字段问题。

验收断言：单测构造加载前 3 轮 + 加载后 3 轮 → 窗口数值正确；仅一侧有数据 → 缺省。

---

## 7. L5 跨会话聚合（P2）

底座已有：`index.json`（`history.ts:140`）每会话 `{rows,lastTs,bytes,archived}`（`history.ts:48-52`），
`.jsonl.gz` 读取透明（`history.ts:381-388`）。

设计：

1. 新增轻量**会话摘要缓存** `summaries.json`（与 `index.json` 同目录）：
   每会话 `{turns, llmCalls, toolCalls, failedCalls, verdicts:{pass,fail,partial,unknown},
   topFailureSigs:[{sig,count}], skillsLoaded:[name], firstTs, lastTs}`；
   随写入增量更新，避免每次跨会话查询重parse 全量正文（当前本机 15 会话 / 2.16MB）。
2. `activity_report` 增加跨会话参数（只加）：
   `crossSessions?: { limit?:number; sinceTs?:number }`
   → 返回 `sessionSummaries[]` 与 `recurringFailureSigs:[{sig, sessions:n, total:n}]`。
3. 这一步才可能出现「在哪类任务上反复低效」：按 `sig` / 工具 / verdict 分布跨会话聚合。

风险与纪律：`summaries.json` 与 `index.json` 是**双写一致性**问题 →
必须幂等、可重建，坏行沿用 `badLines` 计数口径（`history.ts` 已有该计数器）。

验收断言：单测 3 个假会话文件 → 摘要数值正确；smoke：跨会话查询的响应体积有界
（不得随正文增长），即断言输出不含 `sections`/`detail`。

---

## 8. 分期、边界与顺序

顺序：**L1 → L2 → L3 → L4 → L5**（L3 依赖 L2 的 verdict；L5 依赖前四者的口径稳定）。

**当前进度**：L1–L4 **已落地（0.3.0）**，L5 未做；L6（主动配置提案层）架构已定 → 见 §10。

**明确不做（写下来防止漂移）**：

- 不执行验收命令（本插件不获得执行权）
- 不在本插件里存技能/插件的状态机（属技能管理层）
- 不复刻经济面/记忆面指标（`acp_cache` / `lingshu_cg` 的田）
- 不做跨会话全量正文聚合（体积无界）
- 不引入别的插件的词汇（SPINNING/PUA 等）

每期「完成」的定义：**单测 + smoke 断言 + README 段**，沿用现有工程质量线
（`npm test` = build + `node --test tests/` + 三个 smoke）。

---

## 9. 风险清单

1. **契约**：只加不删前提下，消费者要对新字段缺失容错（`failures` 原样保留即锚点）。
2. **体积**：`failSig` 增加约 40–80B/失败行；报告侧聚类需封顶（20 个聚类 × 固定字段）。
3. **隐私**：`verdict.basis` 与 `detail` 同级敏感（可能含路径/命令），README 需明确
   落盘位置与保留策略（30 天 gzip 归档）。
4. **静默错算**：§4.2 两条（`durationMs` 跨 kind、`failed` 匹配任意 kind）——
   实现时必须按注记处理，并各留一条回归断言。
5. **词汇污染**：见 §8 最后一条。
6. **索引一致性**：`summaries.json` / `index.json` 双写要幂等可重建。

---

## 10. 建议的第一步

只做 **L1 + L2** 一起交付（它们是进化决策的两件输入，缺一不可；L3 无 verdict 无意义）。
预计改动面：`types.ts` / `wire.ts` / `index.ts`（钩子 + 报告 + 一个工具）/
`client.tsx`（verdict 行渲染）/ `tests/unit.test.js` / `src/smoke.ts` / README 一段。

---

## 10. L6 主动配置提案层（数据层已落地 0.3.0；执行侧未做）

> **状态（0.5.0）**：提案行（`kind:'proposal'`）+ 工具 `evolution_proposal` + 报告字段
> `proposals` / `pendingProposals` + 面板「提案」标签 + **交互式待批队列（批准 / 否决）与人工端点**
> 均已落地 —— 单测 + 冒烟端点断言（405/415/400/404/200 全路径）+ 活体 HTTP 实测。
> **未做**：执行侧接线（把 approved 的提案交给 `dshmarket` / `skills-manager` 去装 / 建 / 停用）——
> 这一步刻意留给人，见 §10.3 红线。
> 运行时边界（哪些变更热生效、哪些必须重启）见 §11 —— 那是本节的设计前提。

**定案（2026-10）**：执行权归属 = **提案 + 人工批准**。本插件只写「提案」与「待批队列」，
执行交给已有执行器 —— **本插件不获得执行权**（与 §8「明确不做」一致）。

### 10.1 本机现成的执行器（实测）

| 面 | 执行器 | 能力 |
| --- | --- | --- |
| 插件 | `dshmarket` 1.66.1 | 安装 / 卸载 / 更新 / **热禁用**（写 `cordis.patch.yml` 的 `disabled`，约 1s HMR 重组合、无需重启）/ 备份恢复 / 更新 API v1（beta，供插件调用） |
| 插件 | `dsh-find-plugin` 0.4.0 | **只搜索**（GitHub topic + star 排序），不负责安装 |
| 技能 | `@michengai/dsh-skills-manager` 1.1.4 | 创建 / 导入 ZIP·文件夹·SKILL.md / 启停 / 回收站 / GitHub 技能仓库安装 / **更新前备份 + 恢复上一版** |

技能落盘：`~/.dsh/skills`（全局）、`<project>/.dsh/skills`（项目级）。
本机 `~/.dsh/skills` **尚未创建** → 还没有任何用户级 skill（要动手先建目录、让 skills-manager 认到）。

### 10.2 提案行（本插件唯一的扩展点）

新增 `kind:'proposal'` 行 + `proposals` 报告字段 + 工具 `evolution_proposal`（**只写提案，不执行**）：

```ts
readonly proposal: {
  pkind: 'skill' | 'plugin' | 'automation'
  action: 'create' | 'install' | 'enable' | 'disable' | 'remove'
  target: string            // skill 名 / 插件包名 / 仓库
  rationale: string         // 为什么：必须能指回证据
  evidenceSeqs: number[]    // 指回真实行 seq（失败簇 / verdict / 工具统计）
  expectedEffect: string    // 期望改善的**可测**指标（如「该签名失败 7 天内归零」）
  verifyCommands: string[]  // 验收命令：由 agent 用普通工具跑，插件不执行
  rollbackPlan: string
  status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'rolled-back'
  by: 'agent' | 'user'
  at: number
  id?: string            // 稳定 id（p-<runId>-<ts>-<n>）：状态变更行靠它指回。不能用 seq（每进程计数器，跨重启会重复）
  transitionOf?: number  // 状态变更行的标记：指向被变更的提案 seq（创建行没有该字段）
}
```

状态只由人推进（面板批准 / 否决，见 §10.5）或由工具显式写入 —— **不存在自动 apply 路径**。

### 10.5 状态推进：append-only 变更行 + 人工端点（0.5.0）

**为什么不原地改历史行**：原地改要么得改写已落盘的 JSONL，要么只在当前进程内存里生效 ——
后者会在 dsh 重启后丢掉「谁在什么时候批准过」。所以状态变更**追加一行**带 `transitionOf` 的
proposal 行（同一 `id`），有效状态 = 同一 id 上 `(ts, seq)` 最大的那一行的 `status`
（纯函数 `derive.effectiveProposalStatus`，宿主报告与面板共用，单测覆盖乱序输入）。
原提案行的 `status` 永远是 `proposed`（agent 写的初始值），报告另外给 `effectiveStatus`。

| 入口 | 形状 | 守卫（活体 HTTP 实测） |
| --- | --- | --- |
| 面板按钮 | 提案行上的「批准 / 否决」 | 只在 `effectiveStatus === 'proposed'` 时出现 |
| HTTP | `POST /api/activity-monitor/proposal`，body `{id\|seq, status: 'approved'\|'rejected'\|'applied'\|'rolled-back', note?}` | 非 POST → **405**；非 `application/json` → **415**；状态不在白名单（**含 `proposed`**）→ **400**；id/seq 指不到提案 → **404**；成功 → **200 + 回带变更行轻行**（面板直接并进本地，不等下一次快照） |

- **agent 侧无法自我批准**：`evolution_proposal` 工具的 `status` 不是参数（恒 `proposed`），
  人工端点又把 `proposed` 排除在白名单外 —— 两条路都堵死（各有回归断言）。
- 端点只绑环回（`webServer` 的 host 就是 `127.0.0.1`）；要求 `application/json` 是因为浏览器对它会
  先发 preflight，跨站表单（`text/plain`）打不进来 —— 实测被 415 挡回。这是「同源 POST 但不要 CSRF」的最小把关。
- 变更行与提案行同属 `kind:'proposal'`：不增加 `failedCalls`、不带 `durationMs`、不进 `toolOutcome`
  （与 verdict 同一套口径纪律，各有回归断言）。
- **批准只记录，不执行**：执行仍由人走 `dshmarket` / `skills-manager` —— 本插件不持执行权（§10.3）。
数据来源即 L1–L4 的输出：失败簇 → 「该学什么」、`toolOutcome` → 「哪个工具在空转」、
`skillEffect` → 「上次加载的技能是否真有效」。

### 10.3 三档开关与红线

- `propose-only`（默认）/ `auto-dry-run`（隔离 profile + lint）/ `auto-apply`（**按变更类别逐个授权**）
- **绝不自动重启**：dsh 启动是全有全无（一个插件加载失败 → 整个进程退出）→
  安装类变更只提示人重启；能用热禁用 / patch 表达的就别重启
- 只走可恢复的写入路径：插件用 `cordis.patch.yml` 的 `disabled` 行 + 备份恢复；
  技能只写 `~/.dsh/skills`（回收站可救）；**不碰 profile 的 `bundles`、不手改 `node_modules`**
- 白名单：插件复用 awesome-dsh-plugin 精选；技能仓库只允许人工标注过的公开仓库
- **外部评分权分离**：验收必须在独立上下文（另开会话 / 换模型跑同一批任务）或人抽查；
  agent 自评只能进 `likelyOutcome`（`confidence: 'low'`）

### 10.4 落地顺序

1. L1–L4 —— 判断依据（**已完成**）
2. 提案行 + 面板待批队列 + 人工批准端点（**只写不执行**，零风险，先看判断质量）—— **已完成 0.5.0**
3. `task_verdict` → 试用期指标窗口自动评估（变更后 N 轮 / 7 天回归）
4. `auto-dry-run`（自动搜索 + 装到隔离 profile + 跑 lint，不碰主环境）
5. 按类别开 `auto-apply` —— 建议**从「停用」这类可逆操作开始，而不是「安装」**

---

## 11. 附：dsh 运行时变更边界（2026-10 本机实测）

做 L6 执行侧之前必须先知道：**哪些变更能在运行中生效、哪些必须重启**。以下全部为实测。

| 变更类型 | 生效方式 | 实测证据 |
| --- | --- | --- |
| 已装插件的启用 / 停用（`cordis.patch.yml` 里 id 定位的 `disabled: true/false`） | **热生效**，无需重启、进程不变 | 停用 `dsh-humanizer` → 8s 后工具数 107 → 99（它注册的 `humanize_*` ×3 + `voice_*` ×5 消失）；复原 → 8s 后 107 全回来；pid 与 uptime 连续 |
| 新增条目（`insert`，含工具集本身） | **需要重启**重新组合加载 | 热插入 `cordis-tools` 后 12s 无变化、无日志；重启才出现 7 个 `cordis_*` 工具 |
| 改 `dsh.profile.bundles` / `dsh plugin add\|remove`（= pnpm 改依赖） | 需要重启（框架级依赖变化 → `loader.exit()`） | `dsh --help` 原文：`plugin` 把参数转发给 profile 目录里的 pnpm |
| 代码级 HMR（`@cordisjs/plugin-hmr`） | 框架自带，但**本 profile `disabled: true`** | `dsh --profile web --dump-config` 中该条目带 `disabled: true` |
| 纯 touch 补丁文件（内容不变、只改 mtime） | 无效果 | 6s 后工具数 107 → 107 |
| 会话内动态包（`cordis_define / run / stop / undefine`） | **进程内存**，立即生效、立即回收；DSH 重启即消失 | 真实跑通：`inspect_self → define → run → … → undefine`（17 次工具调用），`undefine` 输出 `Removed dynamic Plugin dpx-1 and all of its Packages.` |

### 11.1 启动是全有全无（实测踩过）

一条坏 patch 会让**整个 dsh 进程退出**：

```
Error: duplicate loader entry id: cordis-host-runner
  at EntryGroup.update (@cordisjs/plugin-loader/lib/index.js:91:28)
  at Include._apply (dsh-app-boot/lib/index.js:240:19)
```

当时我把 `cordis-host-runner` 当作「本 profile 没挂」而插入，实际它已由 `@deepseek-ai/dsh-web-app`
挂载（`--dump-config` 里可见 `cordis-host-runner` / `cordis-client-runner` / `ui-cordis`）。
**因此 §10 的红线不变**：自动动作只走 `disabled` 热路径；安装类只提示人重启；改 profile 前先
`dsh --profile web --dump-config`，并查重复 id（`dump-config | grep '^- id:' | sort | uniq -d`）。

### 11.2 动态 host 包的真实契约（agent 试出来的，可复用）

```
ctx.tools.register(harness.defineTool({ name, description, parameters, output: { schema, render }, execute }))
```

- sandbox 的 `ctx` **不暴露** `ctx.tool` → 只能用 `ctx.tools.register`
- 注册物**必须是 `harness.defineTool(...)` 的返回值**（自造 definition 会被拒）
- 键名是 `parameters`（不是 `inputSchema`），根 schema 必须开放（`additionalProperties` 省略或 true）
- `output` **必填** `{ schema, render }`

这正是「该学什么」的样板：5 次失败、5 个签名（§5 的聚类口径直接抓到了），一次摸清即可复用。
---

## 12. L5 跨会话聚合（已落地 0.6.0）

**它回答什么**：`activity_report` 默认是**按会话**的；L5 回答「**最近**这个 agent 在哪类任务上反复低效」——
按会话汇总（行 / 轮 / 工具 / 失败 / token / 首要失败签名）+ **跨会话复现的失败签名**（≥2 个会话）。

### 12.1 三条口径（都写进报告，防止被读成因果）

| 决策 | 理由 |
| --- | --- |
| 只聚合**最近 limit 个会话**（默认取配置 `crossSessionLimit`=12，上限 50） | 全库聚合对「最近反复低效」没有增益，却要付全部 IO（本机 16 会话 / 2 MB+） |
| `recurring` 是**同现统计** | 同一签名跨会话出现 ≠ 因果，也不代表任务难度相同 —— 与 L3/L4 同一套表述纪律 |
| 汇总缓存进 `summaries.json` | `activity_report` 是高频工具；不缓存则每次调用都把全库读一遍 |

### 12.2 缓存：键、失效、失败软着陆

- 键 = `(文件行数, 末次时间)`：文件没长就直接复用；写入用**临时文件 + rename**（读者只会看到完整文件）。
- 版本不符 / JSON 坏 / 文件不存在 = **当作没有缓存重建**（错误只计数、进 `/selfcheck`，不影响报告）。
- 缓存非权威：权威永远是会话 JSONL。删掉 `summaries.json` 只是下次慢一点（重建完全幂等）。

### 12.3 两次实测暴露的真问题（都是断言抓出来的，不是推理出来的）

1. **当前会话滞后**：落盘是异步的，而聚合只看磁盘 → 冒烟里会话明明有失败，汇总却报 `0 行 0 失败`。
   修法：宿主把内存缓冲（`rows`）传进聚合，按 `seq:ts` 合并（内存优先）；并且**有内存行的会话直接绕过缓存**
   —— 它的汇总还在变，用缓存会给出滞后值（这样会话只有一个，那点读盘成本无关紧要）。
   冒烟断言：修复后同一会话 `23 行 / 轮 2 / 失败 2`，且第二次调用 `读盘 0 · 复用 2`。
2. **断言口径太粗**：拿整个 `totals` 比对「纯附加」得到假阳性 —— `spanMs` 是墙钟跨度，两次调用之间必然变大。
   改成只比计数（llm / tool / failed / turns / token / durationMs）。**断言写错和实现写错要分清。**

### 12.4 合并规则只有一份

`mergeActivityRows`（按 `seq:ts` 去重、**内存优先**）从 `index.ts` 移到 `wire.ts`：宿主取数、跨会话聚合、
单测共用同一条规则 —— 两条规则一旦漂移，面板与报告就会互相打脸。
为什么不能用 seq 去重：seq 是每进程计数器，重启前的历史行会与本次运行的 seq 数值重叠，按 seq 去重会误删。
