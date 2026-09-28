export const name = 'activity-monitor';
export const inject = ['webServer', 'systemPrompt'];
const MAX_ROWS = 500;
export function apply(ctx) {
    ctx.logger.info('[activity-monitor] starting');
    let seq = 0;
    const rows = [];
    const push = (row) => {
        rows.push({ ...row, seq: ++seq, ts: Date.now() });
        if (rows.length > MAX_ROWS)
            rows.splice(0, rows.length - MAX_ROWS);
    };
    /** skill name → 文件路径缓存（skill 工具调用时填充；也定期刷新清单） */
    const skillPaths = new Map();
    async function refreshSkillPaths() {
        try {
            const skills = ctx.skills;
            if (!skills?.list)
                return;
            for (const s of await skills.list()) {
                if (s.path)
                    skillPaths.set(s.name, s.path);
            }
        }
        catch { /* skills 服务不可用时静默 */ }
    }
    void refreshSkillPaths();
    const skillsTimer = setInterval(() => { void refreshSkillPaths(); }, 10_000);
    ctx.effect(() => () => clearInterval(skillsTimer), 'activity-monitor: skill path refresher');
    /** 最新一次 assemble 的结果缓存（后台定期刷新，避免在 waterfall 栈内死锁） */
    let cachedSections;
    let cachedContexts;
    // 关键：捕获 systemPrompt 服务的直接引用（fiber 上下文在插件卸载后失效）
    const sp = ctx.systemPrompt;
    async function cacheAssembly() {
        try {
            const assembly = await sp?.assemble?.();
            if (assembly?.sections) {
                cachedSections = assembly.sections;
                cachedContexts = assembly.contexts;
            }
        }
        catch { /* 静默 */ }
    }
    // 首次刷新延迟到挂载完成后（apply 内同步 assemble 会死锁）
    const firstRefresh = setTimeout(() => { void cacheAssembly(); }, 500);
    const assemblyTimer = setInterval(() => { void cacheAssembly(); }, 2000);
    ctx.effect(() => () => { clearTimeout(firstRefresh); clearInterval(assemblyTimer); }, 'activity-monitor: assembly cache refresher');
    /** 从注册名推断 section 来源描述 */
    function describeSectionSource(name) {
        // dsh 官方 section：harness:identity / deployment:persona-prefix / dsh-tool-bash:…
        if (name.startsWith('harness:'))
            return '（dsh 内置）';
        if (name.startsWith('deployment:'))
            return '（部署 persona 配置）';
        const m = name.match(/^dsh-([a-z-]+):/);
        if (m)
            return `（dsh 官方插件 @deepseek-ai/dsh-${m[1]}）`;
        const skill = name.match(/^skill:(.+)$/);
        if (skill) {
            const p = skillPaths.get(skill[1]);
            return p ? `（skill 文件 ${p}）` : `（skill ${skill[1]}）`;
        }
        return '';
    }
    /** 从工具名+参数归类出活动标签和摘要 */
    function classify(toolName, args) {
        const a = args ?? {};
        switch (toolName) {
            case 'skill':
                return { tag: 'skill', summary: `skill: ${a.name ?? '?'}` };
            case 'read':
            case 'view':
            case 'view_file':
            case 'view_file_range':
                return { tag: 'file-read', summary: String(a.path ?? a.file_path ?? a.abs_path ?? '?') };
            case 'write':
            case 'str_replace_editor':
            case 'str_replace_based_edit_tool':
            case 'edit':
            case 'write_file':
                return { tag: 'file-write', summary: String(a.path ?? a.file_path ?? '?') };
            case 'bash':
            case 'bash_persistent':
            case 'pwsh':
            case 'pwsh_persistent':
                return { tag: 'command', summary: String(a.command ?? a.cmd ?? '').split('\n')[0].slice(0, 160) };
            default: {
                const pathLike = a.path ?? a.file_path ?? a.abs_path;
                if (typeof pathLike === 'string')
                    return { tag: 'file-read', summary: `${toolName}: ${pathLike}` };
                return { tag: 'tool', summary: toolName };
            }
        }
    }
    // ── 工具调用监控 ──
    ctx.on('tools/execute', async (exec, next) => {
        const args = exec.arguments ?? exec.args ?? {};
        const { tag, summary } = classify(exec.name, args);
        // 工具调用所属会话（agent loop 执行时携带）
        const sessionId = exec.agent?.session?.id
            ? String(exec.agent.session.id)
            : undefined;
        const start = Date.now();
        try {
            const result = await next();
            // 提取结果文本：result.content 里 TextBlock 的 text
            const content = result?.content;
            let resultText = '';
            if (Array.isArray(content)) {
                resultText = content
                    .filter((b) => b?.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
            }
            if (!resultText) {
                const v = result?.value;
                if (v != null)
                    resultText = typeof v === 'string' ? v : JSON.stringify(v);
            }
            if (result?.isError) {
                resultText = resultText || String(result?.error?.message ?? 'tool error');
            }
            push({
                kind: 'tool',
                sessionId,
                name: exec.name,
                tag,
                summary,
                durationMs: Date.now() - start,
                ok: !result?.isError,
                // 默认折叠；空结果就只显示参数
                detail: [
                    '── 参数 ──',
                    JSON.stringify(args, null, 2),
                    '── 结果 ──',
                    resultText ? truncateText(resultText, 3000) : '（工具未返回文本结果）',
                ].join('\n'),
            });
            return result;
        }
        catch (err) {
            push({
                kind: 'tool',
                sessionId,
                name: exec.name,
                tag,
                summary,
                durationMs: Date.now() - start,
                ok: false,
                detail: [
                    '── 参数 ──',
                    JSON.stringify(args, null, 2),
                    '── 异常 ──',
                    String(err?.message ?? err).slice(0, 2000),
                ].join('\n'),
            });
            throw err;
        }
    });
    // ── 模型请求监控 ──
    ctx.on('llm/stream', async function* (options, next) {
        const start = Date.now();
        let usage = '';
        let replyText = '';
        let failed = false;
        // 提取 system prompt（提示词本体）
        const systemMsg = options.messages?.find((m) => m?.role === 'system');
        const systemText = systemMsg?.content
            ? (Array.isArray(systemMsg.content)
                ? systemMsg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
                : String(systemMsg.content))
            : '';
        // 最后一条用户消息（对话内容）
        const userMessages = options.messages?.filter((m) => m?.role === 'user') ?? [];
        const lastUser = userMessages[userMessages.length - 1];
        const lastUserText = lastUser?.content
            ? (Array.isArray(lastUser.content)
                ? lastUser.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
                : String(lastUser.content))
            : '';
        // 使用后台缓存的 assembly（不在 waterfall 栈内 assemble，会死锁）
        let assemblySections = cachedSections;
        let assemblyContexts = cachedContexts;
        try {
            const stream = next();
            for await (const chunk of stream) {
                const u = chunk?.usage;
                if (u)
                    usage = `${u.inputTokens ?? '?'}in / ${u.outputTokens ?? '?'}out`;
                // 累积助手回复文本
                if (chunk?.type === 'text-delta')
                    replyText += chunk.text ?? '';
                yield chunk;
            }
        }
        catch (err) {
            failed = true;
            push({
                kind: 'llm',
                sessionId: options.sessionId ? String(options.sessionId) : undefined,
                name: `${options.provider}/${options.model}`,
                tag: 'llm',
                summary: `模型调用失败`,
                durationMs: Date.now() - start,
                ok: false,
                detail: String(err?.message ?? err).slice(0, 1500),
            });
            throw err;
        }
        finally {
            if (!failed) {
                // 用流开始前缓存的 assembly（带注册名），每段标注来源
                let promptSections = [];
                if (assemblySections?.length) {
                    promptSections = assemblySections
                        .filter((s) => (s.text ?? '').trim().length > 0)
                        .map((s, i) => {
                        const src = describeSectionSource(s.name);
                        const title = src
                            ? `${i + 1}. ${s.name} ${src}`
                            : `${i + 1}. ${s.name}（第三方插件注册）`;
                        return { title, body: truncateText(s.text, 2500) };
                    });
                    for (const c of assemblyContexts ?? []) {
                        if ((c.text ?? '').trim()) {
                            promptSections.push({ title: `runtime-context: ${c.name}`, body: truncateText(c.text, 1500) });
                        }
                    }
                }
                // 回退：没有 assemble 结果时，从渲染文本按空行拆分（无名段落）
                if (promptSections.length === 0 && systemText) {
                    promptSections = splitSystemPrompt(systemText);
                }
                const sections = [];
                if (lastUserText) {
                    sections.push({ title: '用户消息（最近一条）', body: truncateText(lastUserText, 2000) });
                }
                if (replyText) {
                    sections.push({ title: '助手回复', body: truncateText(replyText, 3000) });
                }
                if (promptSections.length > 0) {
                    sections.push({ title: `系统提示词（${promptSections.length} 个 section，按生效顺序）`, body: '' });
                    sections.push(...promptSections);
                }
                push({
                    kind: 'llm',
                    sessionId: options.sessionId ? String(options.sessionId) : undefined,
                    name: `${options.provider}/${options.model}`,
                    tag: 'llm',
                    summary: `${usage || '流式完成'} · 回复 ${replyText.length} 字 · ${options.messages?.length ?? 0} 条消息 · ${options.tools?.length ?? 0} 个工具 · ${promptSections.length} 段提示词`,
                    durationMs: Date.now() - start,
                    ok: true,
                    sections,
                });
            }
        }
    });
    // ── 快照端点 ──
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/api/activity-monitor/snapshot',
        handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const since = Number(url.searchParams.get('since') ?? 0);
            const fresh = rows.filter((r) => r.seq > since);
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({
                now: Date.now(),
                rows: fresh,
                total: rows.length,
            }));
        },
    }), 'activity-monitor: snapshot route');
    ctx.logger.info('[activity-monitor] ready');
}
/** 把渲染后的 system prompt 按 dsh section 之间的空行分段，识别常见 section 标题 */
function splitSystemPrompt(text) {
    const blocks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    if (blocks.length === 0)
        return [];
    return blocks.map((block, i) => {
        const firstLine = block.split('\n')[0];
        // Markdown 标题或 skill 正文特征（"# 开头"）作为段落标题
        const title = firstLine.startsWith('#')
            ? `段落 ${i + 1}: ${firstLine.replace(/^#+\s*/, '').slice(0, 60)}`
            : firstLine.length <= 70
                ? `段落 ${i + 1}: ${firstLine}`
                : `段落 ${i + 1}`;
        return { title, body: truncateText(block, 2500) };
    });
}
function truncateText(s, max) {
    return s.length > max ? s.slice(0, max) + `\n…(截断，共 ${s.length} 字符)` : s;
}
