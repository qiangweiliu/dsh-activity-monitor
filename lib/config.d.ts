export interface AMConfig {
    /** 内存环形缓冲保留的最大行数（超出后最旧的行被挤出） */
    maxRows: number;
    /** 「完整上下文」正文的截断预算（字节）：超出的消息整条省略并计数 */
    contextBudgetBytes: number;
    /** 工具参数/结果正文的截断预算（字节） */
    toolDetailBudgetBytes: number;
    history: {
        /** 历史 JSONL 目录；缺省 $DSH_HOME（默认 ~/.dsh）/activity-monitor */
        dir: string;
        /** 超过该天数的会话文件自动 gzip 归档（0 = 关闭；归档不丢原文，.jsonl.gz 仍可读） */
        archiveAfterDays: number;
        /** 归档巡检周期（小时） */
        archiveCheckHours: number;
        /** 解析后的历史文件在内存里缓存的会话数（LRU） */
        maxCachedSessions: number;
    };
    client: {
        /** 有「进行中」行时的轮询间隔（毫秒） */
        pollActiveMs: number;
        /** 全部定稿时的轮询间隔（毫秒） */
        pollIdleMs: number;
        /** 浏览器侧保留的最大行数 */
        maxRows: number;
        /** 切会话时回填的历史行数上限（分页每次取的行数） */
        backfillRows: number;
    };
    /** marks 日志的容量（超过后最旧的标记被丢弃，客户端会用 tooOld 触发整段重载） */
    markLogCap: number;
    /**
     * 跨会话聚合（L5）默认统计多少个会话；`activity_report` 的 `crossSessions` 参数可覆盖（上限 50）。
     * 只取最近 N 个会话：全库聚合对「最近在哪类任务上反复低效」没有增益，却要付全部 IO。
     */
    crossSessionLimit: number;
    /** 是否注册 HTTP 端点（关掉 = 只采集不暴露） */
    endpoints: boolean;
    /** 配置里被忽略/被修正的项（失败软着陆的可观测出口） */
    issues: string[];
}
/** 默认历史目录：$DSH_HOME（默认 ~/.dsh）/activity-monitor */
export declare function defaultHistoryDir(env?: NodeJS.ProcessEnv, home?: string): string;
export declare function defaultConfig(env?: NodeJS.ProcessEnv, home?: string): AMConfig;
/**
 * 解析用户配置：缺省字段取默认值，非法值退回默认并记录 issue。
 * 纯函数（env/home 可注入），单测直接覆盖。
 */
export declare function resolveConfig(raw: unknown, env?: NodeJS.ProcessEnv, home?: string): AMConfig;
/**
 * cordis 的 Config 声明：只需要 Standard Schema（`~standard.validate`）。
 * 永远返回 `{ value }` 而不返回 issues —— 见文件头的「失败软着陆」说明。
 */
export declare const Config: {
    '~standard': {
        version: 1;
        vendor: string;
        validate(input: unknown): {
            value: AMConfig;
        };
    };
};
