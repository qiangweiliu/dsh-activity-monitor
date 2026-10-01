# dsh-activity-monitor
dsh运行状态监控插件

## agent 侧工具（自我进化的结果数据）

本插件在 `tools` 服务就绪时懒注册两个工具（没有 tools 服务的部署里监控核心照常跑，只是不暴露工具）：

- `activity_report` —— **读**：调用量 / token / 耗时、工具频次与失败、**失败聚类**（同一失败签名重复几次）、
  **任务验收结论**、上下文压力、一组陈述性 signals。
  参数：`sessionId` / `recentTurns` / `maxFailures`（默认 20）/ `clusterMinCount`（默认 2）/
  `skillWindowTurns`（默认 3）。
- `task_verdict` —— **写**：记录一次任务或子任务的验收结论（`pass|fail|partial|unknown`）与依据，
  可选 `evidenceSeqs` / `verifyCommand` / `verifySeqs` 引用**真实工具行**当证据。
  **本插件不执行任何验收命令**：验收命令请用普通工具（如 `bash`）跑，再用 seq 做关联 ——
  这样「验收结论 → 证据行 → 命令」可追，而监控插件不获得执行权。
- `evolution_proposal` —— **提案（不执行）**：把「该学什么 / 该装什么 / 该停用什么」写成可审阅的提案，
  必须能指回证据（`evidenceSeqs` 引用真实工具行），并给出期望效果、验收命令与回滚方案。
  **状态固定 `proposed`** —— agent 不能自证「已执行」；批准与执行由人通过既有执行器
  （`dshmarket` 安装/热停用、`@michengai/dsh-skills-manager` 建技能）完成。
  设计依据（含实测的运行时边界：补丁层热生效、新增条目需重启、boot 全有全无）见
  `docs/agent-evolution-data.md` §10/§11。

### 新增字段（契约只加不删，旧消费者不受影响）

- 行字段：`failSig`（失败签名：`工具名|错误类别|归一化错误首行`）、`verdict`（验收结论对象）、
  `proposal`（进化提案对象）。行类型：`llm | tool | verdict | proposal`。
  签名在 `tools/execute` 钩子内当场算 —— 只有那里拿得到结构化错误（`result.isError` / `error.message`）；
  事后从 `detail` 那段「参数 + 结果」散文里反解会脆。
- 报告字段：`failureClusters`、`failuresTruncated`、`verdicts`、`lastVerdict`、`likelyOutcome`、
  `toolOutcome`、`skillLoads`、`skillEffect`、`proposals`、`pendingProposals`。`failures` 原样保留。

- 工具级「同现」统计（`toolOutcome`）：该工具出现在**哪类轮次**里 —— 收敛轮（该会话本范围内末轮）、
  同轮重试、带 `pass` / `fail` 验收结论的轮次。**是同现统计不是因果推断**（没有对照组）：
  只能说「它出现在通过验收的轮次 N 次」，不能说「它带来成功」。
- 技能加载前后窗口（`skillLoads` / `skillEffect`）：以该技能**首次加载**所在轮次为锚点，
  对比前后各 `skillWindowTurns`（默认 3）轮的轮数 / 工具数 / 失败数 / 输入 token。
  **是前后对比不是 A/B**（窗口内任务难度不同），只能当「值得进一步验证」的线索；
  窗口内没有行时该项**缺省而非填 0**（否则看起来像那段时间没有任何活动）。
- 两个**刻意的取舍**（改之前先读文档）：`verdict` 行不打 `ok`、不带 `durationMs` ——
  报告里 `failedCalls` 的口径是「任意 kind 的 `ok === false`」、`durationMs` 是跨 kind 求和的，
  复用它们会把失败统计与耗时统计一起污染。
- 没有任何验收结论时，报告给出 `likelyOutcome`（置信度固定 `low`，signals 里显式声明「非验收结论」）；
  有验收结论时该字段缺省 —— 不猜。
- 本插件自身的工具调用（`activity_report` / `task_verdict`）不计入工具频次与耗时合计（见 selfNote）：
  那是监控的记账，不是任务活动。

设计与边界（为什么本插件不做执行者、哪些信号属于别的插件、后续 L3–L5 的计划）：见
[`docs/agent-evolution-data.md`](docs/agent-evolution-data.md)。
