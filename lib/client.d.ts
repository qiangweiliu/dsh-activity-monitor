/**
 * dsh-activity-monitor — 浏览器半（Web 侧板）
 *
 * 在 dsh web 左侧栏注册一个面板项（非浮动，主面板形态）：
 * 点击侧栏图标 → 主区域显示监控面板，实时轮询活动流。
 *
 * 展示形态：
 *  - 每条活动一行：标签徽章 + 名字/摘要 + 时间
 *  - 点击行展开详情（参数/结果）
 *  - 顶部工具栏：暂停/恢复、清空（本地过滤）、标签筛选
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
export declare const inject: readonly ["slots", "sessions"];
export declare function apply(ctx: ClientContext): void;
