/** 当前协议版本。宿主在响应里回带；客户端凭它决定能否走轻行/按需正文路径。 */
export const PROTOCOL = 2;
/** 轻行里允许出现的字段（显式白名单：重字段（detail/sections）不可能漏出去） */
const LIGHT_KEYS = [
    // runId 也要下发：客户端据此把「本进程的行」与「历史文件里其它进程的行」区分开，
    // 尤其是轮次标记（marks 按 seq 定位）—— 不同 run 的 seq 会重复，不做区分会标记错行。
    'seq', 'ts', 'sessionId', 'runId', 'kind', 'name', 'tag', 'summary',
    'turn', 'settled', 'rev', 'durationMs', 'ok',
    'usageIn', 'usageOut', 'contextBytes', 'contextMessages', 'toolBytes', 'contextOmitted', 'promptSections',
    'calls', 'turnStart', 'turnEnd',
    // failSig：面板与 activity_report 用同一个聚类口径（同一签名两处可对照）
    // verdict：验收结论行的全部有效载荷（status/basis/证据 seq）。它本身就是轻量结构
    //   （不像 sections 可能几十 KB），所以随轻行下发，不走 /row 按需正文通道。
    // proposal：进化提案行同理（自述 + 证据 seq，轻量），面板要能直接看待批队列。
    'failSig', 'verdict', 'proposal',
];
/** 把完整行压成轻行。调用前应先合并轮次标记（标记会被原样带出）。 */
export function toLight(row) {
    const src = row;
    const out = {};
    for (const k of LIGHT_KEYS) {
        const v = src[k];
        if (v !== undefined)
            out[k] = v;
    }
    const hasDetail = typeof row.detail === 'string' && row.detail !== '';
    const sectionCount = row.sections?.length ?? 0;
    out.hasBody = hasDetail || sectionCount > 0;
    if (sectionCount > 0)
        out.sectionCount = sectionCount;
    return out;
}
/** 一个 (session, turn) 的定位键 */
export function turnKey(sessionId, turn) {
    return `${sessionId ?? ''}|${turn}`;
}
/**
 * 静态计算一组行的轮次边界标记（历史数据、或一次性全量响应）。
 * `isClosed(sessionId, turn)` 决定该轮是否已结束 —— 历史数据一律视为已结束。
 */
export function computeMarks(rows, isClosed) {
    const first = new Map();
    const last = new Map();
    for (const r of rows) {
        if (!r.turn)
            continue;
        const k = turnKey(r.sessionId, r.turn);
        if (!first.has(k))
            first.set(k, r.seq);
        last.set(k, r.seq);
    }
    const out = [];
    for (const r of rows) {
        if (!r.turn)
            continue;
        const k = turnKey(r.sessionId, r.turn);
        const start = first.get(k) === r.seq;
        const end = isClosed(r.sessionId ?? '', r.turn) && last.get(k) === r.seq;
        if (!start && !end)
            continue;
        out.push({ gen: 0, seq: r.seq, ...(start ? { turnStart: true } : {}), ...(end ? { turnEnd: true } : {}) });
    }
    return out;
}
/** 把标记套到行上（返回新对象，不改原行） */
export function applyMarks(rows, marks) {
    if (marks.length === 0)
        return rows;
    const bySeq = new Map();
    for (const m of marks) {
        const cur = bySeq.get(m.seq) ?? {};
        if (m.turnStart !== undefined)
            cur.turnStart = m.turnStart;
        if (m.turnEnd !== undefined)
            cur.turnEnd = m.turnEnd;
        bySeq.set(m.seq, cur);
    }
    return rows.map((r) => {
        const m = bySeq.get(r.seq);
        if (!m)
            return r;
        const next = { ...r };
        if (m.turnStart !== undefined)
            next.turnStart = m.turnStart;
        if (m.turnEnd !== undefined)
            next.turnEnd = m.turnEnd;
        return next;
    });
}
/**
 * 轮次标记的追加日志。
 *
 * v1 的问题：标记补在已经下发过的行上，纯增量拿不到 → 客户端每轮都回看尾部 30 行。
 * 这里给每次「标记变更」发一个代数（gen），客户端回报自己见过的 gen，宿主只回增量。
 * 容量溢出时最旧的记录被丢弃；客户端发现自己的 gen 太旧（tooOld）就整段重载。
 */
export class MarkLog {
    entries = [];
    gen = 0;
    cap;
    constructor(cap = 2000) {
        this.cap = Math.max(100, Math.floor(cap));
    }
    get generation() {
        return this.gen;
    }
    /** 追加一次标记变更（同一代数下可含多条） */
    bump(marks) {
        if (marks.length === 0)
            return;
        this.gen++;
        for (const m of marks)
            this.entries.push({ gen: this.gen, ...m });
        if (this.entries.length > this.cap)
            this.entries.splice(0, this.entries.length - this.cap);
    }
    /**
     * 取 gen 之后的增量。`tooOld` = 客户端游标落在了已被丢弃的区间（它必须整段重载），
     * `reset` = 客户端游标比宿主还新（例如宿主重启过），此时要求它重开一轮增量。
     */
    since(gen) {
        if (gen > this.gen)
            return { entries: [], markGen: this.gen, tooOld: false, reset: true };
        if (gen === this.gen)
            return { entries: [], markGen: this.gen, tooOld: false, reset: false };
        const dropped = this.entries.length === 0 || this.entries[0].gen > gen + 1;
        return {
            entries: this.entries.filter((e) => e.gen > gen),
            markGen: this.gen,
            // 第一条存活记录的代数 > gen+1 说明中间有代数被容量挤掉了
            tooOld: dropped && gen > 0,
            reset: false,
        };
    }
}
/**
 * 合并内存行 + 历史行（按 `seq:ts` 去重，**内存优先** —— 内存是更新版本）。
 *
 * 为什么不能只看 seq：seq 是每进程计数器，历史文件里重启前的行会与本次运行的行 seq 数值重叠，
 * 按 seq 去重会误删；`seq:ts` 才是行的真实身份。宿主（activity_report / 跨会话聚合）与单测共用这一条规则。
 */
export function mergeActivityRows(mem, hist) {
    const key = (r) => `${r.seq}:${r.ts}`;
    const m = new Map();
    for (const r of hist)
        m.set(key(r), r);
    for (const r of mem)
        m.set(key(r), r);
    return [...m.values()].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
}
