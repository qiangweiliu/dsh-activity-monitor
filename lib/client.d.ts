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
/**
 * 客户端 cordis 上下文的最小形状。
 *
 * 为什么不用 `@deepseek-ai/dsh-client-runtime` 的 ClientContext：
 * 那个包声明了 `@deepseek-ai/dsh-agent@^0.1.1-rc.2` 之类的传递 peer，与本项目
 * 的 0.1.5-rc.3 系列冲突 —— 引入它会 `npm install` ERESOLVE 失败，连带 git 安装路径
 * （`dsh plugin add <git-url>`）也装不上。所以本项目**不依赖该包**（devDeps 里也已移除），
 * 客户端构建只 external react。这里只用两个成员，
 * 就地声明即可，安装面就少一个会打架的依赖。
 */
export interface ClientContext {
    /** cordis 的副作用注册：回调返回清理函数（面板的轮询与订阅都挂在这上面） */
    effect(fn: () => any, label?: string): any;
    /** dsh 客户端会话服务（未注入时取属性会抛，调用处一律 try 包住） */
    sessions?: any;
    [key: string]: any;
}
export declare const inject: readonly ["slots", "sessions"];
export declare function apply(ctx: ClientContext): void;
