/**
 * dsh-activity-monitor — node 半（Host 侧）
 *
 * 监控对话运行时的所有操作，内存里维护一个活动环形缓冲：
 *  - llm/stream waterfall      → 每轮模型请求：模型名、耗时、token 用量，
 *    以及 system prompt 全文（从 messages 的 system 角色消息提取）+ 助手回复文本
 *  - tools/execute waterfall   → 每次工具调用（skill 加载、文件读写、命令执行……）
 *    从工具名+参数中归类出：skill 文件、读写文件、执行命令
 *
 * 展示约定（与浏览器半配合）：
 *  - detail 默认折叠；除非行内有 collapsed: false 标记，前端默认全部折叠
 *  - system prompt 按来源 section 拆分展示（从 systemMessageSections 记录）
 *
 * 通过 webServer 注册 /api/activity-monitor/snapshot 端点，浏览器侧板轮询读取。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "activity-monitor";
export declare const inject: readonly ["webServer", "systemPrompt"];
/** 单条活动记录 */
export interface ActivityRow {
    readonly seq: number;
    readonly ts: number;
    /** 所属会话 id（dsh SessionId），便于区分多会话 */
    readonly sessionId?: string;
    /** llm | tool */
    readonly kind: 'llm' | 'tool';
    /** 模型名或工具名 */
    readonly name: string;
    /** 归类标签：skill / file-read / file-write / command / tool / llm */
    readonly tag: string;
    /** 单行摘要（文件名、命令行、skill 名等） */
    readonly summary: string;
    /** 详情：前端一律默认折叠，点开才显示（不再自动展开） */
    detail?: string;
    /** 多段详情：每段一个小标题+内容（用于 prompt section 拆分展示） */
    sections?: {
        title: string;
        body: string;
    }[];
    durationMs?: number;
    ok?: boolean;
}
export declare function apply(ctx: Context): void;
