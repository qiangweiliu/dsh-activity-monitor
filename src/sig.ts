/**
 * 失败签名：把「同一类失败」的不同实例压成同一个键，供 activity_report 聚类
 * （见 docs/agent-evolution-data.md §3）。单独成模块是为了可单测 —— 纯函数、无依赖。
 *
 * 为什么要在 tools/execute 钩子里当场算，而不是报告聚合时事后算：
 *   钩子内才拿得到结构化错误（result.isError / error.message）。行里落盘的 detail 是
 *   「参数 + 结果」拼成的散文且受预算截断，事后正则反解既脆、又可能把参数误当错误。
 *
 * normalize 的取向：宁可把不同错误分得细，也不要把不同错误合到一起 ——
 * 聚类错了会让 agent 误判「这是同一个反复出现的毛病」，比不聚类更糟。
 */
export type FailErrClass = 'error' | 'exception' | 'no-output'

/**
 * 归一化错误文本 → 可聚类的签名片段。必须幂等：
 * `normalizeErrorText(normalizeErrorText(x)) === normalizeErrorText(x)`。
 */
export function normalizeErrorText(input: string): string {
  let s = String(input ?? '')
  // 终端上色残留（ESC 序列）不带信息，去掉
  s = s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  // 绝对路径 → <path>：路径里往往带 tmp 名 / 随机目录 / 用户目录，逐字比对会把同类失败拆开
  s = s.replace(/(?:[A-Za-z]:\\[^\s'"]+|\/(?:[\w.@+-]+\/)+[\w.@+-]+)/g, '<path>')
  // 十六进制（哈希 / 地址）与数字（行号 / 字节数 / 耗时）都不稳定
  s = s.replace(/0x[0-9a-f]+/gi, '<n>')
  s = s.replace(/\d+/g, '<n>')
  // 错误的可辨识部分几乎都在第一行；折叠空白并小写化
  const first = (s.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return first.length > 120 ? first.slice(0, 120) : first
}

/** 失败签名 = 工具名 | 错误类别 | 归一化错误首行 */
export function failureSig(toolName: string, errClass: FailErrClass, text: string): string {
  return `${toolName}|${errClass}|${normalizeErrorText(text) || '(空错误信息)'}`
}
