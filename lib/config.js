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
import * as os from 'node:os';
import * as path from 'node:path';
/** 默认历史目录：$DSH_HOME（默认 ~/.dsh）/activity-monitor */
export function defaultHistoryDir(env = process.env, home = os.homedir()) {
    return path.join(env.DSH_HOME ?? path.join(env.HOME ?? home, '.dsh'), 'activity-monitor');
}
export function defaultConfig(env = process.env, home) {
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
    };
}
function asInt(v, def, min, max, name, issues) {
    if (v === undefined || v === null)
        return def;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        issues.push(`${name}: 期望数字，收到 ${JSON.stringify(v)}，已用默认值 ${def}`);
        return def;
    }
    const i = Math.floor(n);
    if (i < min || i > max) {
        issues.push(`${name}: ${i} 超出允许范围 [${min}, ${max}]，已钳到边界`);
        return Math.min(max, Math.max(min, i));
    }
    return i;
}
function asBool(v, def, name, issues) {
    if (v === undefined || v === null)
        return def;
    if (typeof v === 'boolean')
        return v;
    if (v === 'true')
        return true;
    if (v === 'false')
        return false;
    issues.push(`${name}: 期望布尔，收到 ${JSON.stringify(v)}，已用默认值 ${def}`);
    return def;
}
function asStr(v, def, name, issues) {
    if (v === undefined || v === null || v === '')
        return def;
    if (typeof v !== 'string') {
        issues.push(`${name}: 期望字符串，收到 ${JSON.stringify(v)}，已用默认值`);
        return def;
    }
    return v;
}
function asObj(v, name, issues) {
    if (v === undefined || v === null)
        return {};
    if (typeof v !== 'object' || Array.isArray(v)) {
        issues.push(`${name}: 期望对象，收到 ${JSON.stringify(v)}，该节全部使用默认值`);
        return {};
    }
    return v;
}
/**
 * 解析用户配置：缺省字段取默认值，非法值退回默认并记录 issue。
 * 纯函数（env/home 可注入），单测直接覆盖。
 */
export function resolveConfig(raw, env = process.env, home) {
    const base = defaultConfig(env, home);
    const issues = [];
    const src = asObj(raw, 'config', issues);
    const history = asObj(src.history, 'history', issues);
    const client = asObj(src.client, 'client', issues);
    const cfg = {
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
    };
    // 端点关掉时不必校验轮询间隔的下限关系；开着时保证 idle ≥ active，否则高频档位会来回跳
    if (cfg.client.pollIdleMs < cfg.client.pollActiveMs) {
        issues.push(`client.pollIdleMs(${cfg.client.pollIdleMs}) < client.pollActiveMs(${cfg.client.pollActiveMs})，已把 idle 抬到 active`);
        cfg.client.pollIdleMs = cfg.client.pollActiveMs;
    }
    return cfg;
}
/**
 * cordis 的 Config 声明：只需要 Standard Schema（`~standard.validate`）。
 * 永远返回 `{ value }` 而不返回 issues —— 见文件头的「失败软着陆」说明。
 */
export const Config = {
    '~standard': {
        version: 1,
        vendor: 'dsh-activity-monitor',
        validate(input) {
            return { value: resolveConfig(input) };
        },
    },
};
