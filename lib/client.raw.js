"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/derive.ts
function fmtBytes(n) {
  if (!Number.isFinite(n)) return "-";
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}
function delta(cur, prev, unit = "") {
  if (cur == null || prev == null) return "";
  const d = cur - prev;
  if (d === 0) return `\u4E0D\u53D8\uFF08${cur}${unit}\uFF09`;
  return `${d > 0 ? "+" : ""}${d}${unit}\uFF08${prev}\u2192${cur}\uFF09`;
}
function contextDiff(prev, cur) {
  if (!prev) return "";
  const parts = [];
  const msgs = delta(cur.contextMessages, prev.contextMessages);
  if (msgs) parts.push(`\u6D88\u606F ${msgs}`);
  if (cur.contextBytes != null && prev.contextBytes != null) {
    const d = cur.contextBytes - prev.contextBytes;
    parts.push(`\u4E0A\u4E0B\u6587 ${d === 0 ? `\u4E0D\u53D8\uFF08${fmtBytes(cur.contextBytes)}\uFF09` : `${d > 0 ? "+" : "-"}${fmtBytes(Math.abs(d))}\uFF08${fmtBytes(prev.contextBytes)}\u2192${fmtBytes(cur.contextBytes)}\uFF09`}`);
  }
  const prompts = delta(cur.promptSections, prev.promptSections, " \u6BB5\u63D0\u793A\u8BCD");
  if (prompts) parts.push(prompts);
  const calls = delta(cur.calls?.length, prev.calls?.length);
  if (calls) parts.push(`\u8C03\u7528 ${calls}`);
  if ((cur.contextOmitted ?? 0) > 0 && (prev.contextOmitted ?? 0) === 0) parts.push("\u672C\u8F6E\u5F00\u59CB\u51FA\u73B0\u8D85\u9884\u7B97\u7701\u7565");
  return parts.length > 0 ? `\u4E0E\u4E0A\u4E00\u8F6E\u76F8\u6BD4\uFF1A${parts.join(" \xB7 ")}` : "";
}
function turnSignals(rows2) {
  const out = [];
  const tools = rows2.filter((r) => r.kind === "tool");
  const byName = /* @__PURE__ */ new Map();
  for (const t of tools) byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
  const dup = [...byName.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of dup) out.push({ severity: "warn", text: `${name} \u91CD\u590D\u8C03\u7528 ${n} \u6B21` });
  const failed = rows2.filter((r) => r.ok === false);
  if (failed.length > 0) {
    const names = [...new Set(failed.map((f) => f.name))].join(" / ");
    out.push({ severity: "warn", text: `${failed.length} \u6B21\u8C03\u7528\u5931\u8D25\uFF08${names}\uFF09` });
  }
  const omitted = rows2.reduce((n, r) => Math.max(n, r.contextOmitted ?? 0), 0);
  if (omitted > 0) out.push({ severity: "warn", text: `\u4E0A\u4E0B\u6587\u8D85\u9884\u7B97\uFF0C${omitted} \u6761\u6D88\u606F\u88AB\u6574\u6761\u7701\u7565` });
  const slow = rows2.filter((r) => (r.durationMs ?? 0) >= 3e4);
  if (slow.length > 0) out.push({ severity: "info", text: `${slow.length} \u6B21\u8C03\u7528\u8D85\u8FC7 30s` });
  const running = rows2.filter((r) => r.settled === false);
  if (running.length > 0) out.push({ severity: "info", text: `${running.length} \u4E2A\u8C03\u7528\u4ECD\u5728\u8FDB\u884C\u4E2D` });
  return out;
}
function sessionTotals(rows2) {
  const llm = rows2.filter((r) => r.kind === "llm");
  const tools = rows2.filter((r) => r.kind === "tool");
  const byName = /* @__PURE__ */ new Map();
  for (const t of tools) byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
  const skills = /* @__PURE__ */ new Map();
  for (const r of rows2.filter((x) => x.tag === "skill")) {
    const name = r.summary.replace(/^skill:\s*/, "");
    skills.set(name, (skills.get(name) ?? 0) + 1);
  }
  let maxContextBytes = 0;
  let maxContextTurn;
  for (const r of llm) {
    if ((r.contextBytes ?? 0) > maxContextBytes) {
      maxContextBytes = r.contextBytes ?? 0;
      maxContextTurn = r.turn;
    }
  }
  return {
    turns: new Set(rows2.map((r) => r.turn).filter((t) => t != null)).size,
    llmCalls: llm.length,
    toolCalls: tools.length,
    failedCalls: rows2.filter((r) => r.ok === false).length,
    inFlight: rows2.filter((r) => r.settled === false).length,
    inputTokens: llm.reduce((n, r) => n + (r.usageIn ?? 0), 0),
    outputTokens: llm.reduce((n, r) => n + (r.usageOut ?? 0), 0),
    maxContextBytes,
    maxContextTurn,
    contextOmitted: llm.reduce((n, r) => Math.max(n, r.contextOmitted ?? 0), 0),
    toolFrequency: [...byName.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    skills: [...skills.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  };
}
function timeOf(ts) {
  return new Date(ts).toLocaleTimeString();
}
function rowsToMarkdown(rows2, title = "\u6D3B\u52A8\u8BB0\u5F55") {
  const lines = [`## ${title}`, ""];
  const totals = sessionTotals(rows2);
  lines.push(`- \u8F6E\u6B21 ${totals.turns} \xB7 \u6A21\u578B\u8BF7\u6C42 ${totals.llmCalls} \xB7 \u5DE5\u5177\u8C03\u7528 ${totals.toolCalls} \xB7 \u5931\u8D25 ${totals.failedCalls}`);
  if (totals.inputTokens || totals.outputTokens) {
    lines.push(`- token\uFF1A\u8F93\u5165 ${totals.inputTokens} / \u8F93\u51FA ${totals.outputTokens}`);
  }
  if (totals.maxContextBytes) {
    lines.push(`- \u6700\u5927\u4E0A\u4E0B\u6587 ${fmtBytes(totals.maxContextBytes)}${totals.maxContextTurn ? `\uFF08\u7B2C ${totals.maxContextTurn} \u8F6E\uFF09` : ""}`);
  }
  if (totals.toolFrequency.length > 0) {
    lines.push(`- \u5DE5\u5177\u9891\u6B21\uFF1A${totals.toolFrequency.slice(0, 10).map((t) => `${t.name}\xD7${t.count}`).join("\uFF0C")}`);
  }
  const sigByTurn = /* @__PURE__ */ new Map();
  for (const t of new Set(rows2.map((r) => r.turn))) {
    sigByTurn.set(t, turnSignals(t == null ? rows2 : rows2.filter((x) => x.turn === t)));
  }
  let currentTurn = null;
  for (const r of rows2) {
    if (r.turn !== currentTurn) {
      currentTurn = r.turn;
      lines.push("", `### ${r.turn ? `\u7B2C ${r.turn} \u8F6E` : "\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u8F6E\u6B21"}`, "");
    }
    const bits = [`\`${timeOf(r.ts)}\``, `**${r.name}**`, r.tag];
    if (r.kind === "tool") bits.push(r.ok === false ? "\u5931\u8D25" : "\u6210\u529F");
    if (r.kind === "verdict" && r.verdict) bits.push(`\u9A8C\u6536 ${r.verdict.status}`);
    if (r.durationMs != null) bits.push(r.durationMs >= 1e3 ? `${(r.durationMs / 1e3).toFixed(1)}s` : `${r.durationMs}ms`);
    if (r.usageIn != null && r.usageOut != null) bits.push(`token ${r.usageIn}\u2192${r.usageOut}`);
    if (r.contextBytes != null) bits.push(`\u4E0A\u4E0B\u6587 ${fmtBytes(r.contextBytes)}`);
    const sig = r.kind === "llm" ? sigByTurn.get(r.turn) ?? [] : [];
    lines.push(`- ${bits.join(" \xB7 ")} \u2014 ${r.summary}` + (sig.length > 0 ? `  
  - \u4FE1\u53F7\uFF1A${sig.map((s) => s.text).join("\uFF1B")}` : ""));
  }
  return lines.join("\n");
}
function rowsToJson(rows2, meta = {}) {
  return JSON.stringify({
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...meta,
    totals: sessionTotals(rows2),
    rows: rows2
  }, null, 2);
}

// src/client.tsx
var inject = ["slots", "sessions"];
var rows = [];
var rowKey = (r) => `${r.seq}:${r.ts}`;
var expanded = /* @__PURE__ */ new Set();
var collapsedInFlight = /* @__PURE__ */ new Set();
var expandedTurns = /* @__PURE__ */ new Set();
var paused = false;
var filterTag = "all";
var lastSeq = 0;
var markGen = 0;
var hostRunId;
var clientCfg = { pollActiveMs: 300, pollIdleMs: 1e3, maxRows: 800, backfillRows: 500 };
var pollStat = { ms: 0, bytes: 0, at: 0 };
var listeners = /* @__PURE__ */ new Set();
var notify = () => listeners.forEach((l) => l());
var subscribe = (l) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
var activeSessionId;
var expandedSecs = /* @__PURE__ */ new Set();
function toggleSec(id) {
  if (expandedSecs.has(id)) expandedSecs.delete(id);
  else expandedSecs.add(id);
  notify();
}
function callLocations(all) {
  const out = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  for (const r of all) {
    const sid = r.sessionId ?? "";
    if (r.kind === "tool") {
      const list2 = pending.get(sid) ?? [];
      list2.push(r);
      pending.set(sid, list2);
      continue;
    }
    if (!r.calls || r.calls.length === 0) continue;
    const list = pending.get(sid) ?? [];
    for (const c of r.calls) {
      const idx = list.findIndex((t) => t.name === c.name);
      if (idx < 0) continue;
      const tool = list[idx];
      list.splice(idx, 1);
      out.set(rowKey(tool), {
        rowKey: rowKey(r),
        rowSeq: r.seq,
        msgIndex: c.msgIndex,
        callIndex: c.callIndex,
        resultMsgIndex: c.resultMsgIndex
      });
    }
  }
  return out;
}
async function jumpToContext(loc) {
  await ensureBody(loc.rowKey);
  expanded.add(loc.rowKey);
  expandedSecs.add(`${loc.rowKey}:group:context`);
  notify();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.querySelector(`[data-am-row="${loc.rowSeq}"] [data-am-msg="${loc.msgIndex}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      ;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }));
}
var clientCtx;
function readActiveSession() {
  try {
    const current = clientCtx?.sessions?.list?.getSnapshot?.()?.current;
    return current ? String(current) : void 0;
  } catch {
    return void 0;
  }
}
function scalarSig(r) {
  return [
    r.seq,
    r.ts,
    r.rev ?? 0,
    r.settled === false ? "live" : "done",
    r.ok === false ? "fail" : "ok",
    r.summary,
    r.name,
    r.tag,
    r.durationMs ?? "",
    r.usageIn ?? "",
    r.usageOut ?? "",
    r.contextBytes ?? "",
    r.contextMessages ?? "",
    r.contextOmitted ?? "",
    r.toolBytes ?? "",
    r.promptSections ?? "",
    r.calls?.length ?? ""
  ].join("|");
}
function mergeRows(incoming) {
  if (incoming.length === 0) return false;
  const known = /* @__PURE__ */ new Map();
  for (const r of rows) known.set(rowKey(r), r);
  const merged = new Map(known);
  let changed = false;
  for (const r of incoming) {
    const k = rowKey(r);
    const prev = known.get(k);
    if (!prev) {
      merged.set(k, r);
      changed = true;
      continue;
    }
    const revGrew = (r.rev ?? 0) > (prev.rev ?? 0);
    const next = {
      ...prev,
      ...r,
      detail: prev.detail,
      sections: prev.sections,
      bodyLoaded: prev.bodyLoaded,
      bodyStale: prev.bodyStale === true || revGrew && prev.bodyLoaded === true,
      turnStart: prev.turnStart === true || r.turnStart === true ? true : void 0,
      turnEnd: prev.turnEnd === true || r.turnEnd === true ? true : void 0
    };
    const markChanged = next.turnStart === true !== (prev.turnStart === true) || next.turnEnd === true !== (prev.turnEnd === true);
    if (revGrew || markChanged || scalarSig(next) !== scalarSig(prev)) {
      merged.set(k, next);
      changed = true;
    }
  }
  if (!changed) return false;
  rows = [...merged.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq).slice(-clientCfg.maxRows);
  return true;
}
function applyMarkEntries(entries) {
  if (entries.length === 0) return false;
  const bySeq = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const cur = bySeq.get(e.seq) ?? {};
    if (e.turnStart !== void 0) cur.turnStart = e.turnStart;
    if (e.turnEnd !== void 0) cur.turnEnd = e.turnEnd;
    bySeq.set(e.seq, cur);
  }
  let changed = false;
  rows = rows.map((r) => {
    if (hostRunId && r.runId !== hostRunId) return r;
    const m = bySeq.get(r.seq);
    if (!m) return r;
    const next = { ...r };
    if (m.turnStart !== void 0) next.turnStart = m.turnStart === true ? true : void 0;
    if (m.turnEnd !== void 0) next.turnEnd = m.turnEnd === true ? true : void 0;
    if (next.turnStart !== r.turnStart || next.turnEnd !== r.turnEnd) changed = true;
    return next;
  });
  return changed;
}
var bodyFetches = /* @__PURE__ */ new Map();
function setRowBody(k, patch) {
  let hit = false;
  rows = rows.map((r) => {
    if (rowKey(r) !== k) return r;
    hit = true;
    return { ...r, ...patch };
  });
  if (hit) notify();
}
function ensureBody(k) {
  const row = rows.find((r) => rowKey(r) === k);
  if (!row || !row.hasBody) return Promise.resolve();
  if (row.bodyLoaded === true && row.bodyStale !== true) return Promise.resolve();
  const inflight = bodyFetches.get(k);
  if (inflight) return inflight;
  const p = (async () => {
    setRowBody(k, { bodyLoading: true, bodyError: void 0 });
    try {
      const url = `/api/activity-monitor/row?seq=${row.seq}&ts=${row.ts}` + (row.sessionId ? `&sessionId=${encodeURIComponent(row.sessionId)}` : "");
      const res = await fetch(url);
      if (res.status === 404) {
        setRowBody(k, { bodyLoading: false, bodyLoaded: true, hasBody: false });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const body = data?.row;
      if (!body) {
        setRowBody(k, { bodyLoading: false, bodyLoaded: true, hasBody: false });
        return;
      }
      setRowBody(k, {
        bodyLoading: false,
        bodyLoaded: true,
        bodyStale: false,
        detail: body.detail,
        sections: body.sections
      });
    } catch (e) {
      setRowBody(k, { bodyLoading: false, bodyError: String(e?.message ?? e) });
    } finally {
      bodyFetches.delete(k);
    }
  })();
  bodyFetches.set(k, p);
  return p;
}
var historyTotal = 0;
var historyTruncated = false;
async function loadHistory(sessionId) {
  try {
    const res = await fetch(`/api/activity-monitor/history?sessionId=${encodeURIComponent(sessionId)}&light=1&limit=${clientCfg.backfillRows}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.rows) && mergeRows(data.rows)) notify();
    if (typeof data.total === "number") historyTotal = data.total;
    historyTruncated = data.truncated === true;
  } catch {
  }
}
async function loadOlder() {
  if (!activeSessionId || rows.length === 0) return;
  const oldest = Math.min(...rows.map((r) => r.ts));
  try {
    const res = await fetch(`/api/activity-monitor/history?sessionId=${encodeURIComponent(activeSessionId)}&light=1&limit=${clientCfg.backfillRows}&before=${oldest}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.rows)) {
      mergeRows(data.rows);
      historyTruncated = data.truncated === true;
      notify();
    }
  } catch {
  }
}
function clearSessionUIState() {
  expanded.clear();
  collapsedInFlight.clear();
  expandedSecs.clear();
  expandedTurns.clear();
}
function resetIncremental() {
  rows = [];
  lastSeq = 0;
  markGen = 0;
  historyTotal = 0;
  historyTruncated = false;
}
function syncSession() {
  const next = readActiveSession();
  if (next === activeSessionId) return;
  activeSessionId = next;
  resetIncremental();
  clearSessionUIState();
  if (next) void loadHistory(next);
  notify();
}
var pollTick = 0;
async function refresh() {
  if (paused) return;
  syncSession();
  const t0 = Date.now();
  try {
    const params = new URLSearchParams({ since: String(lastSeq), markSince: String(markGen) });
    if (activeSessionId) params.set("sessionId", activeSessionId);
    const res = await fetch(`/api/activity-monitor/snapshot?${params.toString()}`);
    const text = await res.text();
    pollStat = { ms: Date.now() - t0, bytes: text.length, at: Date.now() };
    if (!res.ok) return;
    const data = JSON.parse(text);
    if (data.runId && hostRunId && data.runId !== hostRunId) {
      hostRunId = data.runId;
      resetIncremental();
      if (activeSessionId) await loadHistory(activeSessionId);
      notify();
      return;
    }
    hostRunId = data.runId ?? hostRunId;
    if (data.marksTooOld === true || data.marksReset === true) {
      resetIncremental();
      if (activeSessionId) await loadHistory(activeSessionId);
      notify();
      return;
    }
    let changed = Array.isArray(data.rows) ? mergeRows(data.rows) : false;
    if (Array.isArray(data.marks)) changed = applyMarkEntries(data.marks) || changed;
    if (typeof data.markGen === "number") markGen = data.markGen;
    if (typeof data.lastSeq === "number") lastSeq = Math.max(lastSeq, data.lastSeq);
    pollTick++;
    if (changed || pollTick % 10 === 0) notify();
  } catch {
  }
}
function sessionRows() {
  return activeSessionId ? rows.filter((r) => r.sessionId === activeSessionId || !r.sessionId) : rows;
}
function scopedRows() {
  const bySession = sessionRows();
  return filterTag === "all" ? bySession : bySession.filter((r) => r.tag === filterTag);
}
function turnMeta(list) {
  const out = /* @__PURE__ */ new Map();
  for (const r of list) {
    const key = r.turn ? `turn-${r.turn}` : "turn-none";
    let m = out.get(key);
    if (!m) {
      m = { ended: false, firstTs: r.ts, lastTs: r.ts, total: 0, byTag: /* @__PURE__ */ new Map(), failed: 0 };
      out.set(key, m);
    }
    m.total++;
    m.firstTs = Math.min(m.firstTs, r.ts);
    m.lastTs = Math.max(m.lastTs, r.ts);
    if (r.turnEnd) m.ended = true;
    if (r.ok === false) m.failed++;
    m.byTag.set(r.tag, (m.byTag.get(r.tag) ?? 0) + 1);
  }
  return out;
}
async function toggleExpand(row) {
  const k = rowKey(row);
  if (expanded.has(k)) {
    expanded.delete(k);
    notify();
    return;
  }
  expanded.add(k);
  notify();
  await ensureBody(k);
}
var TAG_STYLE = {
  llm: { label: "\u6A21\u578B", color: "#7c3aed", bg: "rgba(124,58,237,.12)" },
  skill: { label: "skill", color: "#0e7490", bg: "rgba(14,116,144,.12)" },
  "file-read": { label: "\u8BFB\u6587\u4EF6", color: "#1d4ed8", bg: "rgba(29,78,216,.12)" },
  "file-write": { label: "\u5199\u6587\u4EF6", color: "#b45309", bg: "rgba(180,83,9,.12)" },
  command: { label: "\u547D\u4EE4", color: "#be123c", bg: "rgba(190,18,60,.12)" },
  tool: { label: "\u5DE5\u5177", color: "#4b5563", bg: "rgba(75,85,99,.12)" },
  // 验收结论（agent 写入的 task_verdict）：墨绿 —— 与「工具」灰、「命令」红一眼可分。
  // 这个键同时驱动工具栏的标签筛选按钮（tags 由 TAG_STYLE 的键生成）。
  verdict: { label: "\u9A8C\u6536", color: "#047857", bg: "rgba(4,120,87,.12)" },
  // 进化提案（agent 写入的 evolution_proposal）：橙 —— 「待人工批准」的行要一眼能挑出来
  proposal: { label: "\u63D0\u6848", color: "#ea580c", bg: "rgba(234,88,12,.12)" }
};
var BLOCK_STYLE = {
  // 系统提示词分段 / 运行时上下文（冷·靛蓝）
  prompt: { tint: "rgba(99,102,241,.16)", soft: "rgba(99,102,241,.07)", border: "rgba(99,102,241,.50)" },
  // 用户消息 / 助手回复（冷·青）
  dialog: { tint: "rgba(34,211,238,.14)", soft: "rgba(34,211,238,.06)", border: "rgba(34,211,238,.45)" },
  // 工具参数与结果（暖·琥珀）
  tool: { tint: "rgba(245,158,11,.14)", soft: "rgba(245,158,11,.06)", border: "rgba(245,158,11,.50)" }
};
var overlay = (color, base) => `linear-gradient(${color}, ${color}), ${base}`;
function Badge({ tag }) {
  const s = TAG_STYLE[tag] ?? TAG_STYLE.tool;
  return (0, import_react.createElement)("span", {
    style: {
      display: "inline-block",
      padding: "1px 8px",
      borderRadius: 10,
      fontSize: 11,
      lineHeight: "16px",
      color: s.color,
      background: s.bg,
      whiteSpace: "nowrap"
    }
  }, s.label);
}
var TURN_COLORS = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899", "#6366f1"];
function turnColor(turn) {
  return TURN_COLORS[(turn - 1) % TURN_COLORS.length];
}
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${alpha})`;
}
function groupByTurn(list) {
  const groups = [];
  const index = /* @__PURE__ */ new Map();
  for (const r of list) {
    const key = r.turn ? `turn-${r.turn}` : "turn-none";
    let i = index.get(key);
    if (i === void 0) {
      i = groups.length;
      index.set(key, i);
      groups.push({ key, turn: r.turn, rows: [] });
    }
    groups[i].rows.push(r);
  }
  return groups;
}
function toggleTurn(key) {
  if (expandedTurns.has(key)) expandedTurns.delete(key);
  else expandedTurns.add(key);
  notify();
}
function clockOf(ts) {
  return new Date(ts).toLocaleTimeString();
}
var STEP_GLYPHS = "\u2460\u2461\u2462\u2463\u2464\u2465\u2466\u2467\u2468\u2469\u246A\u246B\u246C\u246D\u246E\u246F\u2470\u2471\u2472\u2473";
function stepGlyph(n) {
  return n >= 1 && n <= STEP_GLYPHS.length ? STEP_GLYPHS[n - 1] : `${n}.`;
}
function preview(text, max = 60) {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const t = first.trim();
  return t.length > max ? `${t.slice(0, max)}\u2026` : t;
}
function rowSecIds(row) {
  return (row.sections ?? []).map((sec, i) => sec.key ? `${row.seq}:${sec.key}` : `${row.seq}:${i}`);
}
async function openFully(opts) {
  if (opts.turnKey) expandedTurns.add(opts.turnKey);
  for (const r of opts.rows ?? []) expanded.add(rowKey(r));
  for (const id of opts.secIds ?? []) expandedSecs.add(id);
  notify();
  for (const r of opts.rows ?? []) {
    const k = rowKey(r);
    await ensureBody(k);
    const cur = rows.find((x) => rowKey(x) === k);
    if (cur) for (const id of rowSecIds(cur)) expandedSecs.add(id);
  }
  notify();
}
function TurnGroupHeader({ group, meta, open }) {
  const list = group.rows;
  const isNone = !group.turn;
  const c = isNone ? "var(--dsw-alias-label-tertiary, #9ca3af)" : turnColor(group.turn);
  const ended = meta ? meta.ended : list.some((r) => r.turnEnd);
  const firstTs = meta ? meta.firstTs : list[0].ts;
  const lastTs = meta ? meta.lastTs : list[list.length - 1].ts;
  const total = meta ? meta.total : list.length;
  const failed = list.filter((r) => r.ok === false).length;
  const signals = turnSignals(list);
  const hasWarn = signals.some((s) => s.severity === "warn");
  const span = lastTs - firstTs;
  const spanText = span >= 1e3 ? `${(span / 1e3).toFixed(1)}s` : `${span}ms`;
  const byTag = /* @__PURE__ */ new Map();
  for (const r of list) byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1);
  const parts = [...byTag.entries()].map(([tag, n]) => `${TAG_STYLE[tag]?.label ?? tag}\xD7${n}`);
  const countText = list.length === total ? `${total} \u6761` : `${list.length}/${total} \u6761\uFF08\u7B5B\u9009\u540E\uFF09`;
  const title = isNone ? "\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u8F6E\u6B21\u7684\u8C03\u7528\uFF08\u6CA1\u6709\u5BF9\u5E94\u7684 turn/start\uFF0C\u4F8B\u5982\u4F1A\u8BDD\u6807\u9898\u751F\u6210\uFF09" : `\u7B2C ${group.turn} \u8F6E \xB7 ${ended ? "\u5DF2\u7ED3\u675F\uFF08\u6A21\u578B\u56DE\u7B54\u5B8C\u6210\uFF09" : "\u8FDB\u884C\u4E2D"} \xB7 \u5171 ${total} \u6761`;
  return (0, import_react.createElement)(
    "div",
    {
      onClick: () => toggleTurn(group.key),
      // 双击：这一轮下全部展开（轮次 + 该轮每行 + 行内每个分段）
      onDoubleClick: (e) => {
        e.stopPropagation?.();
        openFully({ turnKey: group.key, rows: group.rows });
      },
      title,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        userSelect: "none",
        padding: "6px 12px",
        background: isNone ? "var(--dsw-alias-bg-layer-1)" : overlay(hexToRgba(c, 0.12), "var(--dsw-alias-bg-layer-1)"),
        borderTop: "1px solid var(--dsw-alias-border-l1)",
        borderBottom: "1px solid var(--dsw-alias-border-l1)",
        borderLeft: `3px solid ${c}`
      }
    },
    (0, import_react.createElement)("span", { style: { fontSize: 10, color: c, width: 10 } }, open ? "\u25BE" : "\u25B8"),
    (0, import_react.createElement)("span", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: c,
        whiteSpace: "nowrap",
        padding: "1px 8px",
        borderRadius: 10,
        background: isNone ? "transparent" : hexToRgba(c, 0.16),
        border: isNone ? "1px dashed var(--dsw-alias-border-l1)" : `1px solid ${hexToRgba(c, 0.45)}`
      }
    }, isNone ? "\u8F6E\u6B21\u5916" : `\u8F6E\u6B21 #${group.turn}`),
    (0, import_react.createElement)("span", {
      style: { fontSize: 11, color: c, fontWeight: 600, whiteSpace: "nowrap" }
    }, isNone ? `${list.length} \u6761` : ended ? "\u25A0 \u5DF2\u7ED3\u675F" : "\u25CF \u8FDB\u884C\u4E2D"),
    (0, import_react.createElement)("span", {
      style: {
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: 11,
        color: "var(--dsw-alias-label-secondary, #4b5563)"
      }
    }, `${countText} \xB7 ${parts.join(" \xB7 ")}${failed ? ` \xB7 ${failed} \u6761\u5931\u8D25` : ""}`),
    // 轮次信号：把「重复调用 / 失败 / 上下文被整条省略 / 长耗时」直接摆在轮次头上（悬停看全）
    signals.length > 0 && (0, import_react.createElement)("span", {
      style: {
        fontSize: 11,
        whiteSpace: "nowrap",
        fontWeight: 600,
        color: hasWarn ? "#dc2626" : "var(--dsw-alias-label-secondary, #4b5563)"
      },
      title: signals.map((s) => `${s.severity === "warn" ? "\u26A0" : "\u24D8"} ${s.text}`).join("\n")
    }, `${hasWarn ? "\u26A0" : "\u24D8"} ${signals[0].text}${signals.length > 1 ? `\uFF08\u7B49 ${signals.length} \u9879\uFF09` : ""}`),
    (0, import_react.createElement)(
      "span",
      { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #9ca3af)", whiteSpace: "nowrap" } },
      `${clockOf(firstTs)} \u2192 ${clockOf(lastTs)} \xB7 ${spanText}`
    ),
    // 复制本轮 Markdown 摘要（只含时间/类型/摘要/耗时/token/上下文与信号，不含正文）
    (0, import_react.createElement)("span", {
      onClick: (e) => {
        e.stopPropagation?.();
        void navigator.clipboard?.writeText(rowsToMarkdown(group.rows, isNone ? "\u8F6E\u6B21\u5916\u7684\u6D3B\u52A8" : `\u7B2C ${group.turn} \u8F6E`));
      },
      style: {
        fontSize: 11,
        color: "#0ea5e9",
        cursor: "pointer",
        whiteSpace: "nowrap",
        border: "1px solid rgba(14,165,233,.45)",
        borderRadius: 3,
        padding: "0 4px"
      },
      title: "\u590D\u5236\u672C\u8F6E\u7684\u6D3B\u52A8\u6458\u8981\uFF08Markdown\uFF1B\u4E0D\u542B\u63D0\u793A\u8BCD\u4E0E\u5DE5\u5177\u8F93\u51FA\u6B63\u6587\uFF09"
    }, "\u590D\u5236")
  );
}
function ActivityRowView({ row, step, stepColor, loc, stepOf, prevModel }) {
  const inFlight = row.settled === false;
  const k = rowKey(row);
  const isOpen = inFlight ? !collapsedInFlight.has(k) : expanded.has(k);
  const hasDetail = row.hasBody === true || Boolean(row.detail) || (row.sections?.length ?? 0) > 0;
  const time = new Date(row.ts).toLocaleTimeString();
  const tagColor = (TAG_STYLE[row.tag] ?? TAG_STYLE.tool).color;
  const targetStep = loc ? stepOf?.get(loc.rowSeq) : void 0;
  const locTip = loc ? `\u53D1\u8D77\u4E8E\u300C\u5B8C\u6574\u4E0A\u4E0B\u6587\u300D\u7B2C ${loc.msgIndex} \u6761\u6D88\u606F\u7684\u7B2C ${loc.callIndex} \u4E2A\u8C03\u7528` + (loc.resultMsgIndex != null ? `\uFF0C\u7ED3\u679C\u5728\u7B2C ${loc.resultMsgIndex} \u6761\u6D88\u606F` : "\uFF08\u7ED3\u679C\u8FD8\u6CA1\u56DE\u5230\u6D88\u606F\u91CC\uFF09") + (targetStep != null ? `\uFF1B\u5728\u8BF7\u6C42 ${stepGlyph(targetStep)} \u91CC\u53D1\u51FA` : "") + " \u2014\u2014 \u70B9\u51FB\u8DF3\u8F6C" : void 0;
  const diff = row.kind === "llm" && prevModel ? contextDiff(prevModel, row) : "";
  const onRowClick = () => {
    if (!hasDetail) return;
    if (inFlight) {
      if (!collapsedInFlight.has(k)) {
        collapsedInFlight.add(k);
      } else {
        collapsedInFlight.delete(k);
        expanded.add(k);
        void ensureBody(k);
      }
    } else {
      void toggleExpand(row);
    }
    notify();
  };
  return (0, import_react.createElement)(
    "div",
    {
      key: k,
      style: {
        borderBottom: "1px solid var(--dsw-alias-border-l1)",
        borderLeft: `3px solid ${tagColor}`
      }
    },
    (0, import_react.createElement)(
      "div",
      {
        onClick: onRowClick,
        // 双击这一行：这一行连详情一次性全部展开
        onDoubleClick: (e) => {
          if (hasDetail) {
            e.stopPropagation?.();
            openFully({ rows: [row] });
          }
        },
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          cursor: hasDetail ? "pointer" : "default",
          userSelect: "none"
        }
      },
      // 进行中（模型生成中 / 工具执行中）：结果列前加一个闪烁标记，扫一眼就知道这行还活着
      inFlight && (0, import_react.createElement)("span", {
        style: { fontSize: 10, color: "#f59e0b", whiteSpace: "nowrap", animation: "am-pulse 1s ease-in-out infinite" },
        title: "\u8FDB\u884C\u4E2D\uFF1A\u7ED3\u679C\u8FD8\u5728\u8DEF\u4E0A"
      }, "\u22EF"),
      // 本轮的调用顺序：① ② ③ …（一眼看出用户消息之后底层按什么顺序被调用）
      step != null && (0, import_react.createElement)("span", {
        style: {
          fontSize: 12,
          fontWeight: 700,
          lineHeight: "16px",
          minWidth: 16,
          textAlign: "center",
          color: stepColor ?? "#9ca3af",
          whiteSpace: "nowrap"
        },
        title: `\u7B2C ${step} \u6B65\uFF08\u672C\u8F6E\u7684\u8C03\u7528\u987A\u5E8F\uFF09`
      }, stepGlyph(step)),
      hasDetail && (0, import_react.createElement)("span", { style: { fontSize: 10, color: "#9ca3af", width: 10 } }, isOpen ? "\u25BE" : "\u25B8"),
      // 只标活动类型（模型/命令/读文件…）；轮次标识已上移到轮次块头
      (0, import_react.createElement)(Badge, { tag: row.tag }),
      // 具体工具名当主标题（read / bash / skill / glob …）——分类标签只说明性质，看不出到底调的是哪个工具
      (row.kind === "tool" || row.kind === "verdict") && (0, import_react.createElement)("span", {
        style: {
          fontSize: 13,
          fontWeight: 600,
          color: tagColor,
          whiteSpace: "nowrap",
          textDecoration: row.ok === false ? "line-through" : "none"
        },
        title: row.kind === "verdict" ? `\u9A8C\u6536\u7ED3\u8BBA\u884C\uFF1A${row.name}` : `\u5DE5\u5177\u540D\uFF1A${row.name}`
      }, row.name),
      // 验收结论的状态徽标：pass 绿 / fail 红 / partial·unknown 琥珀；依据在后面的摘要位
      row.kind === "verdict" && row.verdict && (0, import_react.createElement)("span", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: "nowrap",
          borderRadius: 3,
          padding: "0 4px",
          color: row.verdict.status === "pass" ? "#047857" : row.verdict.status === "fail" ? "#b91c1c" : "#b45309",
          background: row.verdict.status === "pass" ? "rgba(4,120,87,.12)" : row.verdict.status === "fail" ? "rgba(185,28,28,.12)" : "rgba(180,83,9,.12)"
        },
        title: `\u9A8C\u6536\u7ED3\u8BBA ${row.verdict.status}\uFF08\u7531 ${row.verdict.by} \u5199\u5165\uFF09\xB7 \u5C55\u5F00\u53EF\u89C1\u4F9D\u636E\u4E0E\u8BC1\u636E\u884C`
      }, row.verdict.status),
      // 这次调用在「发给模型的消息序列」里的位置：第 n 条消息的第 m 个调用（点击跳过去）
      loc && (0, import_react.createElement)("span", {
        onClick: (e) => {
          e.stopPropagation?.();
          jumpToContext(loc);
        },
        style: {
          fontSize: 11,
          color: "#0ea5e9",
          whiteSpace: "nowrap",
          cursor: "pointer",
          border: "1px solid rgba(14,165,233,.45)",
          borderRadius: 3,
          padding: "0 4px"
        },
        title: locTip
      }, `\u21A9 \u4E0A\u4E0B\u6587 [${loc.msgIndex}] \u7B2C ${loc.callIndex} \u4E2A\u8C03\u7528`),
      (0, import_react.createElement)("span", {
        style: {
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 13,
          color: "var(--dsw-alias-label-primary, #111827)",
          textDecoration: row.ok === false ? "line-through" : "none",
          opacity: row.ok === false ? 0.6 : 1
        },
        title: row.summary
      }, row.summary),
      row.durationMs != null && (0, import_react.createElement)(
        "span",
        { style: { fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" } },
        row.durationMs >= 1e3 ? `${(row.durationMs / 1e3).toFixed(1)}s` : `${row.durationMs}ms`
      ),
      // 直观信号①：单次模型请求的 token 消耗（provider 回报 usage 后行内可见，缺省不占位）
      row.usageIn != null && row.usageOut != null && (0, import_react.createElement)("span", {
        style: { fontSize: 11, color: "#7c3aed", whiteSpace: "nowrap" },
        title: "\u672C\u6B21\u8BF7\u6C42 token \u7528\u91CF\uFF1A\u8F93\u5165 / \u8F93\u51FA"
      }, `\u26A1${row.usageIn}\u2192${row.usageOut}`),
      // 直观信号②：上下文超监控预算、最旧消息被整条省略（模型没看到完整上下文）——红色预警
      (row.contextOmitted ?? 0) > 0 && (0, import_react.createElement)("span", {
        style: { fontSize: 11, color: "#dc2626", fontWeight: 600, whiteSpace: "nowrap" },
        title: `\u56E0\u8D85\u51FA\u4E0A\u4E0B\u6587\u9884\u7B97\uFF0C\u6700\u65E9\u7684 ${row.contextOmitted} \u6761\u6D88\u606F\u88AB\u6574\u6761\u7701\u7565\uFF0C\u6A21\u578B\u6CA1\u6709\u770B\u5230\u5B83\u4EEC`
      }, `\u26A0${row.contextOmitted} \u6761\u88AB\u7701\u7565`),
      (0, import_react.createElement)("span", { style: { fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" } }, time)
    ),
    // 展开区：llm 行渲染分段（用户消息/助手回复/提示词段落），tool 行渲染单块 detail
    // 提示词分段（sec.key 存在的）是二级折叠：点击段落标题单独展开正文
    // 配色口径：提示词/对话 = 冷色系（段落靛蓝、对话青），工具参数与结果 = 暖色系（琥珀）
    // 正文是协议 v2 按需拉取的：先把「加载中 / 失败」渲染出来，否则点开是一片空白
    isOpen && row.bodyLoading && (0, import_react.createElement)("div", {
      style: { margin: "0 12px 8px 40px", fontSize: 11, color: "#9ca3af" }
    }, "\u22EF \u6B63\u5728\u53D6\u6B63\u6587\uFF08v2\uFF1A\u6B63\u6587\u6309\u9700\u62C9\u53D6\uFF0C\u4E0D\u5360\u8F6E\u8BE2\u901A\u9053\uFF09"),
    isOpen && row.bodyError && (0, import_react.createElement)("div", {
      style: { margin: "0 12px 8px 40px", fontSize: 11, color: "#dc2626" },
      title: "\u6B63\u6587\u62C9\u53D6\u5931\u8D25\uFF1A\u6536\u8D77\u518D\u5C55\u5F00\u4F1A\u91CD\u8BD5"
    }, `\u6B63\u6587\u62C9\u53D6\u5931\u8D25\uFF1A${row.bodyError}`),
    // 与上一轮的差异（上下文/提示词是否在膨胀）—— 一眼看出，不必逐轮点开对比
    isOpen && diff !== "" && (0, import_react.createElement)("div", {
      style: { margin: "0 12px 6px 40px", fontSize: 11, color: "var(--dsw-alias-label-secondary, #4b5563)" }
    }, diff),
    isOpen && row.sections && row.sections.length > 0 && (0, import_react.createElement)(
      "div",
      { "data-am-row": String(row.seq), style: { margin: "0 12px 8px 40px" } },
      row.sections.map((sec, i) => {
        const secId = sec.key ? `${k}:${sec.key}` : `${k}:${i}`;
        const isGroup = sec.isGroup === true;
        const isChild = sec.parent !== void 0;
        if (isChild && !expandedSecs.has(`${k}:${sec.parent}`)) return null;
        const selfOpen = expandedSecs.has(secId);
        const bs = isGroup || isChild ? BLOCK_STYLE.prompt : BLOCK_STYLE.dialog;
        const bodyOpen = selfOpen && sec.body !== "";
        const clickable = isGroup || sec.body !== "";
        const pv = preview(sec.body);
        const showPreview = !bodyOpen && sec.body !== "" && pv !== "" && !sec.title.includes(pv.replace(/…$/, ""));
        const childIds = (row.sections ?? []).map((s, j) => ({ s, id: s.key ? `${k}:${s.key}` : `${k}:${j}` })).filter((x) => x.s.parent !== void 0 && x.s.parent === sec.key).map((x) => x.id);
        return (0, import_react.createElement)(
          "div",
          {
            key: i,
            // 供「工具行 → 上下文消息」的跳转定位用（jumpToContext 按这个属性找元素）
            "data-am-sec": secId,
            style: { marginBottom: 6, marginLeft: isChild ? 18 : 0 }
          },
          (0, import_react.createElement)(
            "div",
            {
              onClick: clickable ? () => {
                toggleSec(secId);
              } : void 0,
              onDoubleClick: clickable ? (e) => {
                e.stopPropagation?.();
                openFully({ secIds: [secId, ...childIds] });
              } : void 0,
              style: {
                fontSize: 11,
                fontWeight: 600,
                color: "var(--dsw-alias-label-primary)",
                padding: "3px 8px",
                background: overlay(bs.tint, "var(--dsw-alias-bg-layer-1)"),
                border: `1px solid ${bs.border}`,
                borderBottom: bodyOpen ? "none" : `1px solid ${bs.border}`,
                borderLeft: `3px solid ${bs.border}`,
                borderRadius: bodyOpen ? "4px 4px 0 0" : 4,
                cursor: clickable ? "pointer" : "default",
                userSelect: "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }
            },
            (clickable ? selfOpen ? "\u25BE " : "\u25B8 " : "") + sec.title,
            showPreview && (0, import_react.createElement)("span", {
              style: { fontWeight: 400, color: "var(--dsw-alias-label-secondary, #4b5563)" }
            }, "  " + pv)
          ),
          bodyOpen && (sec.anchorOffsets && sec.anchorOffsets.length > 0 ? sec.anchorOffsets.map((o, k2) => {
            const end = k2 + 1 < sec.anchorOffsets.length ? sec.anchorOffsets[k2 + 1] : sec.body.length;
            const text = sec.body.slice(o, end).replace(/\n\n$/, "");
            return (0, import_react.createElement)("pre", {
              key: k2,
              "data-am-msg": k2,
              style: {
                margin: 0,
                marginBottom: k2 + 1 < sec.anchorOffsets.length ? 12 : 0,
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--dsw-alias-label-primary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all"
              }
            }, text);
          }) : (0, import_react.createElement)("pre", {
            style: {
              margin: 0,
              padding: 8,
              fontSize: 11,
              lineHeight: 1.5,
              background: overlay(bs.soft, "var(--dsw-alias-bg-layer-2)"),
              borderRadius: clickable ? "0 0 4px 4px" : 4,
              color: "var(--dsw-alias-label-primary)",
              border: `1px solid ${bs.border}`,
              borderTop: "none",
              borderLeft: `3px solid ${bs.border}`,
              overflow: "auto",
              maxHeight: 220,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all"
            }
          }, sec.body))
        );
      })
    ),
    isOpen && row.detail && (0, import_react.createElement)("pre", {
      style: {
        margin: "0 12px 8px 40px",
        padding: 8,
        fontSize: 11,
        lineHeight: 1.5,
        background: overlay(BLOCK_STYLE.tool.soft, "var(--dsw-alias-bg-layer-2)"),
        borderRadius: 6,
        color: "var(--dsw-alias-label-primary)",
        border: `1px solid ${BLOCK_STYLE.tool.border}`,
        borderLeft: `3px solid ${BLOCK_STYLE.tool.border}`,
        overflow: "auto",
        maxHeight: 260,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all"
      }
    }, row.detail)
  );
}
function Toolbar() {
  const tags = ["all", ...Object.keys(TAG_STYLE).filter((t) => t !== "llm")];
  const exportRows = () => scopedRows();
  const mkTitle = () => activeSessionId ? `\u4F1A\u8BDD ${activeSessionId.slice(0, 8)} \u6D3B\u52A8` : "\u6D3B\u52A8\u8BB0\u5F55";
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", gap: 6, alignItems: "center", padding: "8px 12px", flexWrap: "wrap" } },
    (0, import_react.createElement)("button", {
      onClick: () => {
        paused = !paused;
        notify();
      },
      style: buttonStyle(paused)
    }, paused ? "\u25B6 \u6062\u590D" : "\u23F8 \u6682\u505C"),
    // 「重载」= 丢掉本地游标与本地行，重新从宿主拉一遍（协议 v2 是增量同步，
    // 对不上时——换会话、宿主重启——靠重新同步而不是靠刷新整个页面）
    (0, import_react.createElement)("button", {
      onClick: () => {
        resetIncremental();
        clearSessionUIState();
        notify();
        if (activeSessionId) void loadHistory(activeSessionId);
      },
      style: buttonStyle(false),
      title: "\u4E22\u6389\u672C\u5730\u6E38\u6807\uFF0C\u91CD\u65B0\u62C9\u4E00\u6B21\u5386\u53F2\u4E0E\u5B9E\u65F6\u884C\uFF08\u4E0D\u5BF9\u9F50\u65F6\u7528\uFF09"
    }, "\u91CD\u8F7D"),
    // 轮次默认收起，给一个一键展开/收起全部的开关（只影响轮次块，不动行内详情）
    (0, import_react.createElement)("button", {
      onClick: () => {
        const gs = groupByTurn(scopedRows());
        const allOpen = gs.length > 0 && gs.every((g) => expandedTurns.has(g.key));
        expandedTurns.clear();
        if (!allOpen) for (const g of gs) expandedTurns.add(g.key);
        notify();
      },
      style: buttonStyle(false)
    }, "\u5C55\u5F00/\u6536\u8D77\u8F6E\u6B21"),
    ...tags.map(
      (t) => (0, import_react.createElement)("button", {
        key: t,
        onClick: () => {
          filterTag = t;
          notify();
        },
        style: buttonStyle(filterTag === t)
      }, t === "all" ? "\u5168\u90E8" : TAG_STYLE[t]?.label ?? t)
    ),
    (0, import_react.createElement)("span", { style: { flex: 1 } }),
    // 导出：Markdown 摘要（贴给人看）与 JSON（给脚本处理）—— 都只含轻行字段，不含正文
    (0, import_react.createElement)("button", {
      onClick: () => {
        void navigator.clipboard?.writeText(rowsToMarkdown(exportRows(), mkTitle()));
      },
      style: buttonStyle(false),
      title: "\u590D\u5236\u5F53\u524D\u89C6\u89D2\u7684\u6D3B\u52A8\u6458\u8981\uFF08Markdown\uFF1B\u4E0D\u542B\u63D0\u793A\u8BCD\u4E0E\u5DE5\u5177\u8F93\u51FA\u6B63\u6587\uFF09"
    }, "\u590D\u5236\u6458\u8981"),
    (0, import_react.createElement)("button", {
      onClick: () => {
        const json = rowsToJson(exportRows(), { sessionId: activeSessionId });
        const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `activity-${(activeSessionId ?? "all").slice(0, 8)}-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
      style: buttonStyle(false),
      title: "\u5BFC\u51FA\u5F53\u524D\u89C6\u89D2\u4E3A JSON\uFF08\u8F7B\u884C\u5B57\u6BB5 + \u4F1A\u8BDD\u6C47\u603B\uFF1B\u6B63\u6587\u6309\u9700\u62C9\u53D6\uFF0C\u4E0D\u5728\u8FD9\u91CC\u5BFC\u51FA\uFF09"
    }, "\u5BFC\u51FA JSON")
  );
}
function buttonStyle(active) {
  return {
    padding: "2px 10px",
    fontSize: 12,
    borderRadius: 6,
    cursor: "pointer",
    border: "1px solid " + (active ? "var(--dsw-alias-brand-primary, #2563eb)" : "var(--dsw-alias-border-l1)"),
    background: active ? "rgba(37,99,235,.1)" : "transparent",
    color: active ? "var(--dsw-alias-brand-primary, #2563eb)" : "var(--dsw-alias-label-secondary, #4b5563)"
  };
}
function MonitorPanel() {
  const [version, setVersion] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => subscribe(() => setVersion((v) => v + 1)), []);
  const listRef = (0, import_react.useRef)(null);
  const stickRef = (0, import_react.useRef)(true);
  const sessionRef = (0, import_react.useRef)(activeSessionId);
  (0, import_react.useEffect)(() => {
    if (typeof document === "undefined") return;
    const STYLE_ID = "am-pulse-style";
    if (!document.getElementById(STYLE_ID)) {
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = "@keyframes am-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }";
      document.head.appendChild(el);
    }
  }, []);
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const dataSig = `${activeSessionId ?? ""}|${rows.length}|${lastSeq}`;
  (0, import_react.useEffect)(() => {
    const el = listRef.current;
    const switched = sessionRef.current !== activeSessionId;
    if (switched) {
      sessionRef.current = activeSessionId;
      stickRef.current = true;
    }
    if (el && (stickRef.current || switched)) el.scrollTop = el.scrollHeight;
  }, [dataSig, activeSessionId]);
  const visible = scopedRows();
  const groups = groupByTurn(visible);
  const groupCount = groups.filter((g) => g.turn).length;
  const metas = turnMeta(sessionRows());
  const locs = callLocations(sessionRows());
  const stats = sessionTotals(visible);
  const stepOf = /* @__PURE__ */ new Map();
  for (const g of groups) g.rows.forEach((r, i) => stepOf.set(r.seq, i + 1));
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", flexDirection: "column", height: "100%" } },
    (0, import_react.createElement)(Toolbar),
    (0, import_react.createElement)(
      "div",
      { ref: listRef, onScroll: onListScroll, style: { flex: 1, overflowY: "auto" } },
      // 历史是分页载入的（协议 v2 的 /history 只回最近 N 行，正文不随行下发）：
      // 还要更早的就点这里向前翻页，而不是一次性把整份历史灌进面板
      historyTruncated && (0, import_react.createElement)(
        "div",
        { style: { padding: "6px 12px", textAlign: "center" } },
        (0, import_react.createElement)("button", {
          onClick: () => {
            void loadOlder();
          },
          style: {
            fontSize: 11,
            padding: "3px 10px",
            cursor: "pointer",
            border: "1px solid var(--dsw-alias-border-l2, #d1d5db)",
            borderRadius: 4,
            background: "transparent",
            color: "var(--dsw-alias-label-secondary, #4b5563)"
          },
          title: "\u5411\u66F4\u65E9\u7684\u5386\u53F2\u7FFB\u9875\uFF08\u6BCF\u6B21\u4E00\u5C4F\uFF0C\u6B63\u6587\u4ECD\u6309\u9700\u62C9\u53D6\uFF09"
        }, `\u2191 \u8F7D\u5165\u66F4\u65E9\u7684\u6D3B\u52A8\uFF08\u5DF2\u8F7D\u5165 ${visible.length} \u884C\uFF09`)
      ),
      visible.length === 0 ? (0, import_react.createElement)(
        "div",
        { style: { padding: 24, textAlign: "center", color: "#9ca3af", fontSize: 13 } },
        activeSessionId ? "\u5F53\u524D\u4F1A\u8BDD\u6682\u65E0\u6D3B\u52A8 \u2014\u2014 \u53D1\u4E00\u6761\u6D88\u606F\uFF0C\u8FD9\u91CC\u4F1A\u5B9E\u65F6\u663E\u793A\u8F6E\u6B21\u3001\u63D0\u793A\u8BCD\u3001skill\u3001\u5DE5\u5177\u3001\u6587\u4EF6\u548C\u547D\u4EE4\u7684\u4F7F\u7528\u60C5\u51B5" : "\u6682\u65E0\u6D3B\u52A8 \u2014\u2014 \u53D1\u8D77\u4E00\u6BB5\u5BF9\u8BDD\u540E\u8FD9\u91CC\u4F1A\u5B9E\u65F6\u663E\u793A\u8F6E\u6B21\u3001\u63D0\u793A\u8BCD\u3001skill\u3001\u5DE5\u5177\u3001\u6587\u4EF6\u548C\u547D\u4EE4\u7684\u4F7F\u7528\u60C5\u51B5"
      ) : groups.map((group) => {
        const open = expandedTurns.has(group.key);
        const c = group.turn ? turnColor(group.turn) : "var(--dsw-alias-label-tertiary, #9ca3af)";
        const isHex = typeof c === "string" && c.startsWith("#");
        return (0, import_react.createElement)(
          "div",
          { key: group.key },
          (0, import_react.createElement)(TurnGroupHeader, { group, meta: metas.get(group.key), open }),
          // 展开后：该轮的活动按调用顺序排成一条流程 —— 左侧竖线 + 每行 ① ② ③ 序号
          // （行内详情仍是二级折叠；顺序就是宿主记录到的真实顺序）
          open && (0, import_react.createElement)(
            "div",
            { style: { display: "flex", marginLeft: 12 } },
            (0, import_react.createElement)("div", { style: { flex: "0 0 14px", width: 14, borderRight: `2px solid ${isHex ? hexToRgba(c, 0.35) : c}` } }),
            (0, import_react.createElement)(
              "div",
              { style: { flex: 1, minWidth: 0 } },
              group.rows.map((row, i) => (0, import_react.createElement)(ActivityRowView, {
                key: rowKey(row),
                row,
                step: i + 1,
                stepColor: isHex ? c : void 0,
                loc: locs.get(rowKey(row)),
                stepOf,
                // 跨轮差异的基准：同会话里 ts 更小的最近一条模型行（第一轮没有基准 → 不显示差异）
                prevModel: row.kind === "llm" ? [...rows].filter((r) => r.kind === "llm" && (r.sessionId ?? "") === (row.sessionId ?? "") && r.ts < row.ts).sort((a, b) => b.ts - a.ts)[0] : void 0
              }))
            )
          )
        );
      })
    ),
    (0, import_react.createElement)(
      "div",
      { style: { padding: "4px 12px", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #9ca3af)", borderTop: "1px solid var(--dsw-alias-border-l1)", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" } },
      (0, import_react.createElement)(
        "span",
        { title: "\u8F6E\u6B21 / \u6D3B\u52A8\u6761\u6570 / \u5DF2\u5C55\u5F00\u8F6E\u6570 / \u5237\u65B0\u72B6\u6001" },
        `${groupCount} \u8F6E \xB7 ${visible.length} \u6761\u6D3B\u52A8 \xB7 ${stats.turns} \u8F6E\u6709\u6570\u636E \xB7 ${expandedTurns.size} \u8F6E\u5DF2\u5C55\u5F00 \xB7 ${paused ? "\u5DF2\u6682\u505C" : "\u5B9E\u65F6\u5237\u65B0\u4E2D"} \xB7 \u6700\u65B0\u5728\u5E95\u90E8`
      ),
      // 会话级汇总：token / 工具调用 / 失败 / 最大上下文 —— v1 收了这些字段却没展示
      (0, import_react.createElement)(
        "span",
        { style: { whiteSpace: "nowrap" }, title: "\u672C\u4F1A\u8BDD\u6C47\u603B\uFF08\u53E3\u5F84\u4E0E agent \u4FA7 activity_report \u7684 signals \u4E00\u81F4\uFF09" },
        `\u6A21\u578B ${stats.llmCalls} \xB7 \u5DE5\u5177 ${stats.toolCalls}${stats.failedCalls > 0 ? ` \xB7 \u5931\u8D25 ${stats.failedCalls}` : ""}` + (stats.inputTokens || stats.outputTokens ? ` \xB7 token ${stats.inputTokens}\u2192${stats.outputTokens}` : "") + (stats.maxContextBytes > 0 ? ` \xB7 \u6700\u5927\u4E0A\u4E0B\u6587 ${fmtBytes(stats.maxContextBytes)}${stats.maxContextTurn ? `\uFF08\u7B2C ${stats.maxContextTurn} \u8F6E\uFF09` : ""}` : "") + (stats.contextOmitted > 0 ? ` \xB7 \u26A0\u7701\u7565 ${stats.contextOmitted} \u6761` : "")
      ),
      // 协议 v2 的效果指纹：一次快照的耗时与响应体积（v1 回看尾 30 行，最坏 530KB）
      (0, import_react.createElement)(
        "span",
        { style: { whiteSpace: "nowrap" }, title: "\u6700\u8FD1\u4E00\u6B21\u5FEB\u7167\uFF1A\u8017\u65F6 / \u54CD\u5E94\u4F53\u79EF\uFF08v2 \u6539\u7EAF\u589E\u91CF\u540E\u5E94\u5728 KB \u7EA7\uFF09" },
        pollStat.at ? `\u5FEB\u7167 ${pollStat.ms}ms \xB7 ${fmtBytes(pollStat.bytes)}` : "\u5FEB\u7167 \u2014"
      ),
      (0, import_react.createElement)(
        "span",
        { style: { whiteSpace: "nowrap" }, title: activeSessionId ? `\u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD ${activeSessionId}` : "\u672A\u9009\u4E2D\u4F1A\u8BDD\uFF0C\u663E\u793A\u5168\u90E8" },
        activeSessionId ? `\u4F1A\u8BDD ${activeSessionId.slice(0, 16)}\u2026` : "\u672A\u9009\u4F1A\u8BDD\uFF08\u8DDF\u968F\u4E2D\uFF09"
      )
    )
  );
}
function apply(ctx) {
  clientCtx = ctx;
  ctx.effect(() => {
    let unsubscribe;
    try {
      const list = ctx.sessions?.list;
      if (typeof list?.subscribe === "function") {
        unsubscribe = list.subscribe(() => {
          syncSession();
          notify();
        });
      }
    } catch {
    }
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, "activity-monitor: follow current session");
  ctx.effect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/activity-monitor/config");
        if (!res.ok) return;
        const data = await res.json();
        const c = data?.client ?? data?.config ?? {};
        if (typeof c.pollActiveMs === "number") clientCfg.pollActiveMs = c.pollActiveMs;
        if (typeof c.pollIdleMs === "number") clientCfg.pollIdleMs = c.pollIdleMs;
        if (typeof c.maxRows === "number") clientCfg.maxRows = c.maxRows;
        if (typeof c.backfillRows === "number") clientCfg.backfillRows = c.backfillRows;
      } catch {
      }
    })();
    return () => {
    };
  }, "activity-monitor: read config");
  ctx.effect(() => {
    let timer;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await refresh();
      } finally {
        busy = false;
      }
      const busyLive = rows.some((r) => r.settled === false && (!activeSessionId || r.sessionId === activeSessionId || !r.sessionId));
      timer = window.setTimeout(tick, busyLive ? clientCfg.pollActiveMs : clientCfg.pollIdleMs);
    };
    void tick();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, "activity-monitor: polling");
  window.__activityMonitor = {
    debug: () => {
      const list = clientCtx?.sessions?.list;
      const snap = (() => {
        try {
          return list?.getSnapshot?.();
        } catch {
          return void 0;
        }
      })();
      return {
        hasCtx: Boolean(clientCtx),
        serviceNames: clientCtx ? Object.keys(clientCtx).filter((k) => /session/i.test(k)) : [],
        hasSessions: Boolean(clientCtx?.sessions),
        hasList: Boolean(list),
        snapshotKeys: snap ? Object.keys(snap) : null,
        current: snap?.current ? String(snap.current) : null,
        activeSessionId: activeSessionId ?? null,
        /** 缓冲里的行数（含其它会话） */
        rows: rows.length,
        /** 面板真正显示的行数（= scopedRows()，底栏「共 N 条」用的就是它） */
        visible: scopedRows().length,
        visibleTurns: new Set(scopedRows().filter((r) => r.turn).map((r) => r.turn)).size,
        turns: new Set(rows.filter((r) => r.turn).map((r) => r.turn)).size,
        // ── 协议 v2 同步状态：增量游标 / 正文按需拉取 / 快照体积指纹 ──
        protocol: {
          lastSeq,
          markGen,
          hostRunId: hostRunId ?? null,
          pollStat,
          loadingBodies: bodyFetches.size,
          bodiesLoaded: rows.filter((r) => r.bodyLoaded === true).length,
          bodiesStale: rows.filter((r) => r.bodyStale === true).length,
          clientCfg
        }
      };
    },
    /** 列出当前已知会话 id */
    sessionIds: () => {
      try {
        return (clientCtx?.sessions?.list?.getSnapshot?.()?.ids ?? []).map(String);
      } catch {
        return [];
      }
    },
    /**
     * 走 dsh 自己的会话选择 API（侧栏点击内部用的就是它）。
     * 必须 await：会话 id 不存在时 dsh 是**异步拒绝**的，不 await 就把失败当成功返回，
     * 表现为「调了 openSession 但面板没变」，容易被误判成跟随逻辑的问题。
     * 注意只对 dsh 已知的会话有效：历史文件里的会话 id 未必还在会话列表里。
     */
    openSession: async (id) => {
      try {
        await clientCtx?.sessions?.open?.(id);
        return "ok";
      } catch (e) {
        return String(e?.message ?? e);
      }
    }
  };
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: "activity-monitor"
  }, MonitorPanel));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: "activity-monitor",
    order: 60,
    label: () => "\u76D1\u63A7"
  }, SidebarIcon));
}
function SidebarIcon() {
  return (0, import_react.createElement)("span", { style: { fontSize: 15, lineHeight: 1 } }, "\u{1F4CA}");
}
