/**
 * 插件配置：解析、默认值、校验。
 *
 * 为什么不用 schemastery 声明 `Config`：本包的生产依赖是零（标准安装路径
 * `dsh plugin add <git-url>` 只装生产依赖，而 tsc/esbuild 都是 devDeps），
 * 引入 schemastery 会让安装面多一个必须联网解析的运行时依赖。
 * cordis 需要的只是 `runtime.Config["~standard"].validate(config)` 这个
 * Standard Schema 接口，手写十几行就能满足，且完全可单测。
 *
 * 校验策略是**失败软着陆**：任何非法值退回默认值并把问题记进 `issues`，
 * 绝不让 cordis 抛 ValidationError —— 监控插件不该因为一个配置项写错就拒绝加载。
 * `issues` 会出现在 GET /api/activity-monitor/config 与 /selfcheck 里，便于排查。
 */
import * as os from 'node:os'
import * as path from 'node:path'

export interface AMConfig {
  /** 内存环形缓冲保留的最大行数（超出后最旧的行被挤出） */
  maxRows: number
  /** 「完整上下文」正文的截断预算（字节）：超出的消息整条省略并计数 */
  contextBudgetBytes: number
  /** 工具参数/结果正文的截断预算（字节） */
  toolDetailBudgetBytes: number
  history: {
    /** 历史 JSONL 目录；缺省 $DSH_HOME（默认 ~/.dsh）/activity-monitor */
    dir: string
    /** 超过该天数的会话文件自动 gzip 归档（0 = 关闭；归档不丢原文，.jsonl.gz 仍可读） */
    archiveAfterDays: number
    /** 归档巡检周期（小时） */
    archiveCheckHours: number
    /** 解析后的历史文件在内存里缓存的会话数（LRU） */
    maxCachedSessions: number
  }
  client: {
    /** 有「进行中」行时的轮询间隔（毫秒） */
    pollActiveMs: number
    /** 全部定稿时的轮询间隔（毫秒） */
    pollIdleMs: number
    /** 浏览器侧保留的最大行数 */
    maxRows: number
    /** 切会话时回填的历史行数上限（分页每次取的行数） */
    backfillRows: number
  }
  /** marks 日志的容量（超过后最旧的标记被丢弃，客户端会用 tooOld 触发整段重载） */
  markLogCap: number
  /** 是否注册 HTTP 端点（关掉 = 只采集不暴露） */
  endpoints: boolean
  /** 配置里被忽略/被修正的项（失败软着陆的可观测出口） */
  issues: string[]
}

/** 默认历史目录：$DSH_HOME（默认 ~/.dsh）/activity-monitor */
export function defaultHistoryDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.DSH_HOME ?? path.join(env.HOME ?? home, '.dsh'), 'activity-monitor')
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env, home?: string): AMConfig {
  return {
    maxRows: 500,
    contextBudgetBytes: 300 * 1024,
    toolDetailBudgetBytes: 300 * 1024,
    history: {
      dir: defaultHistoryDir(env, home),
      archiveAfterDays: 30,
      archiveCheckHours: 6,
      maxCachedSessions: 4,
    },
    client: {
      pollActiveMs: 300,
      pollIdleMs: 1000,
      maxRows: 800,
      backfillRows: 500,
    },
    markLogCap: 2000,
    endpoints: true,
    issues: [],
  }
}

function asInt(v: unknown, def: number, min: number, max: number, name: string, issues: string[]): number {
  if (v === undefined || v === null) return def
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    issues.push(`${name}: 期望数字，收到 ${JSON.stringify(v)}，已用默认值 ${def}`)
    return def
  }
  const i = Math.floor(n)
  if (i < min || i > max) {
    issues.push(`${name}: ${i} 超出允许范围 [${min}, ${max}]，已钳到边界`)
    return Math.min(max, Math.max(min, i))
  }
  return i
}

function asBool(v: unknown, def: boolean, name: string, issues: string[]): boolean {
  if (v === undefined || v === null) return def
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  issues.push(`${name}: 期望布尔，收到 ${JSON.stringify(v)}，已用默认值 ${def}`)
  return def
}

function asStr(v: unknown, def: string, name: string, issues: string[]): string {
  if (v === undefined || v === null || v === '') return def
  if (typeof v !== 'string') {
    issues.push(`${name}: 期望字符串，收到 ${JSON.stringify(v)}，已用默认值`)
    return def
  }
  return v
}

function asObj(v: unknown, name: string, issues: string[]): Record<string, unknown> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) {
    issues.push(`${name}: 期望对象，收到 ${JSON.stringify(v)}，该节全部使用默认值`)
    return {}
  }
  return v as Record<string, unknown>
}

/**
 * 解析用户配置：缺省字段取默认值，非法值退回默认并记录 issue。
 * 纯函数（env/home 可注入），单测直接覆盖。
 */
export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env, home?: string): AMConfig {
  const base = defaultConfig(env, home)
  const issues: string[] = []
  const src = asObj(raw, 'config', issues)
  const history = asObj(src.history, 'history', issues)
  const client = asObj(src.client, 'client', issues)

  const cfg: AMConfig = {
    maxRows: asInt(src.maxRows, base.maxRows, 10, 100_000, 'maxRows', issues),
    contextBudgetBytes: asInt(src.contextBudgetBytes, base.contextBudgetBytes, 1_000, 200 * 1024 * 1024, 'contextBudgetBytes', issues),
    toolDetailBudgetBytes: asInt(src.toolDetailBudgetBytes, base.toolDetailBudgetBytes, 1_000, 200 * 1024 * 1024, 'toolDetailBudgetBytes', issues),
    history: {
      dir: asStr(history.dir, base.history.dir, 'history.dir', issues),
      archiveAfterDays: asInt(history.archiveAfterDays, base.history.archiveAfterDays, 0, 3650, 'history.archiveAfterDays', issues),
      archiveCheckHours: asInt(history.archiveCheckHours, base.history.archiveCheckHours, 1, 720, 'history.archiveCheckHours', issues),
      maxCachedSessions: asInt(history.maxCachedSessions, base.history.maxCachedSessions, 1, 64, 'history.maxCachedSessions', issues),
    },
    client: {
      pollActiveMs: asInt(client.pollActiveMs, base.client.pollActiveMs, 100, 60_000, 'client.pollActiveMs', issues),
      pollIdleMs: asInt(client.pollIdleMs, base.client.pollIdleMs, 200, 600_000, 'client.pollIdleMs', issues),
      maxRows: asInt(client.maxRows, base.client.maxRows, 50, 100_000, 'client.maxRows', issues),
      backfillRows: asInt(client.backfillRows, base.client.backfillRows, 10, 20_000, 'client.backfillRows', issues),
    },
    markLogCap: asInt(src.markLogCap, base.markLogCap, 100, 200_000, 'markLogCap', issues),
    endpoints: asBool(src.endpoints, base.endpoints, 'endpoints', issues),
    issues,
  }
  // 端点关掉时不必校验轮询间隔的下限关系；开着时保证 idle ≥ active，否则高频档位会来回跳
  if (cfg.client.pollIdleMs < cfg.client.pollActiveMs) {
    issues.push(`client.pollIdleMs(${cfg.client.pollIdleMs}) < client.pollActiveMs(${cfg.client.pollActiveMs})，已把 idle 抬到 active`)
    cfg.client.pollIdleMs = cfg.client.pollActiveMs
  }
  return cfg
}

/**
 * cordis 的 Config 声明：只需要 Standard Schema（`~standard.validate`）。
 * 永远返回 `{ value }` 而不返回 issues —— 见文件头的「失败软着陆」说明。
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-activity-monitor',
    validate(input: unknown): { value: AMConfig } {
      return { value: resolveConfig(input) }
    },
  },
}
