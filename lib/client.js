window.__ModuleLoader__.load({
	id: "dsh-activity-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		;(function(module, exports, require){
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
var inject = ["slots", "sessions"];
var rows = [];
var expanded = /* @__PURE__ */ new Set();
var collapsedInFlight = /* @__PURE__ */ new Set();
var expandedTurns = /* @__PURE__ */ new Set();
var paused = false;
var filterTag = "all";
var lastSeq = 0;
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
      out.set(tool.seq, { rowSeq: r.seq, msgIndex: c.msgIndex, callIndex: c.callIndex, resultMsgIndex: c.resultMsgIndex });
    }
  }
  return out;
}
function jumpToContext(loc) {
  expanded.add(loc.rowSeq);
  expandedSecs.add(`${loc.rowSeq}:group:context`);
  notify();
  setTimeout(() => {
    const el = document.querySelector(`[data-am-row="${loc.rowSeq}"] [data-am-msg="${loc.msgIndex}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      ;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, 120);
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
var rowKey = (r) => `${r.seq}:${r.ts}`;
function mergeRows(incoming) {
  if (incoming.length === 0) return false;
  const known = /* @__PURE__ */ new Map();
  for (const r of rows) known.set(rowKey(r), r);
  let changed = false;
  const merged = new Map(known);
  for (const r of incoming) {
    const k = rowKey(r);
    const prev = known.get(k);
    const newer = !prev || (r.rev ?? 0) > (prev.rev ?? 0) || (prev.turnEnd !== r.turnEnd || prev.turnStart !== r.turnStart);
    if (newer) {
      changed = true;
      merged.set(k, r);
    }
  }
  if (!changed) return false;
  rows = [...merged.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq).slice(-800);
  for (const r of incoming) if (r.seq > lastSeq) lastSeq = r.seq;
  return true;
}
async function loadHistory(sessionId) {
  try {
    const res = await fetch(`/api/activity-monitor/history?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.rows) && mergeRows(data.rows)) notify();
  } catch {
  }
}
function clearSessionUIState() {
  expanded.clear();
  collapsedInFlight.clear();
  expandedSecs.clear();
  expandedTurns.clear();
}
function syncSession() {
  const next = readActiveSession();
  if (next === activeSessionId) return;
  activeSessionId = next;
  rows = [];
  lastSeq = 0;
  clearSessionUIState();
  if (next) void loadHistory(next);
  notify();
}
async function refresh() {
  if (paused) return;
  syncSession();
  try {
    const since = Math.max(0, lastSeq - 30);
    const res = await fetch(`/api/activity-monitor/snapshot?since=${since}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.rows) && mergeRows(data.rows)) notify();
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
function toggleExpand(seq) {
  if (expanded.has(seq)) expanded.delete(seq);
  else expanded.add(seq);
  notify();
}
var TAG_STYLE = {
  llm: { label: "\u6A21\u578B", color: "#7c3aed", bg: "rgba(124,58,237,.12)" },
  skill: { label: "skill", color: "#0e7490", bg: "rgba(14,116,144,.12)" },
  "file-read": { label: "\u8BFB\u6587\u4EF6", color: "#1d4ed8", bg: "rgba(29,78,216,.12)" },
  "file-write": { label: "\u5199\u6587\u4EF6", color: "#b45309", bg: "rgba(180,83,9,.12)" },
  command: { label: "\u547D\u4EE4", color: "#be123c", bg: "rgba(190,18,60,.12)" },
  tool: { label: "\u5DE5\u5177", color: "#4b5563", bg: "rgba(75,85,99,.12)" }
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
function openFully(opts) {
  if (opts.turnKey) expandedTurns.add(opts.turnKey);
  for (const r of opts.rows ?? []) {
    expanded.add(r.seq);
    for (const id of rowSecIds(r)) expandedSecs.add(id);
  }
  for (const id of opts.secIds ?? []) expandedSecs.add(id);
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
    (0, import_react.createElement)(
      "span",
      { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #9ca3af)", whiteSpace: "nowrap" } },
      `${clockOf(firstTs)} \u2192 ${clockOf(lastTs)} \xB7 ${spanText}`
    )
  );
}
function ActivityRowView({ row, step, stepColor, loc, stepOf }) {
  const inFlight = row.settled === false;
  const isOpen = inFlight ? !collapsedInFlight.has(row.seq) : expanded.has(row.seq);
  const hasDetail = Boolean(row.detail) || (row.sections?.length ?? 0) > 0;
  const time = new Date(row.ts).toLocaleTimeString();
  const tagColor = (TAG_STYLE[row.tag] ?? TAG_STYLE.tool).color;
  const targetStep = loc ? stepOf?.get(loc.rowSeq) : void 0;
  const locTip = loc ? `\u53D1\u8D77\u4E8E\u300C\u5B8C\u6574\u4E0A\u4E0B\u6587\u300D\u7B2C ${loc.msgIndex} \u6761\u6D88\u606F\u7684\u7B2C ${loc.callIndex} \u4E2A\u8C03\u7528` + (loc.resultMsgIndex != null ? `\uFF0C\u7ED3\u679C\u5728\u7B2C ${loc.resultMsgIndex} \u6761\u6D88\u606F` : "\uFF08\u7ED3\u679C\u8FD8\u6CA1\u56DE\u5230\u6D88\u606F\u91CC\uFF09") + (targetStep != null ? `\uFF1B\u5728\u8BF7\u6C42 ${stepGlyph(targetStep)} \u91CC\u53D1\u51FA` : "") + " \u2014\u2014 \u70B9\u51FB\u8DF3\u8F6C" : void 0;
  const onRowClick = () => {
    if (!hasDetail) return;
    if (inFlight) {
      if (!collapsedInFlight.has(row.seq)) {
        collapsedInFlight.add(row.seq);
      } else {
        collapsedInFlight.delete(row.seq);
        expanded.add(row.seq);
      }
    } else {
      toggleExpand(row.seq);
    }
    notify();
  };
  return (0, import_react.createElement)(
    "div",
    {
      key: row.seq,
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
      row.kind === "tool" && (0, import_react.createElement)("span", {
        style: {
          fontSize: 13,
          fontWeight: 600,
          color: tagColor,
          whiteSpace: "nowrap",
          textDecoration: row.ok === false ? "line-through" : "none"
        },
        title: `\u5DE5\u5177\u540D\uFF1A${row.name}`
      }, row.name),
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
    isOpen && row.sections && row.sections.length > 0 && (0, import_react.createElement)(
      "div",
      { "data-am-row": String(row.seq), style: { margin: "0 12px 8px 40px" } },
      row.sections.map((sec, i) => {
        const secId = sec.key ? `${row.seq}:${sec.key}` : `${row.seq}:${i}`;
        const isGroup = sec.isGroup === true;
        const isChild = sec.parent !== void 0;
        if (isChild && !expandedSecs.has(`${row.seq}:${sec.parent}`)) return null;
        const selfOpen = expandedSecs.has(secId);
        const bs = isGroup || isChild ? BLOCK_STYLE.prompt : BLOCK_STYLE.dialog;
        const bodyOpen = selfOpen && sec.body !== "";
        const clickable = isGroup || sec.body !== "";
        const pv = preview(sec.body);
        const showPreview = !bodyOpen && sec.body !== "" && pv !== "" && !sec.title.includes(pv.replace(/…$/, ""));
        const childIds = (row.sections ?? []).map((s, j) => ({ s, id: s.key ? `${row.seq}:${s.key}` : `${row.seq}:${j}` })).filter((x) => x.s.parent !== void 0 && x.s.parent === sec.key).map((x) => x.id);
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
          bodyOpen && (sec.anchorOffsets && sec.anchorOffsets.length > 0 ? sec.anchorOffsets.map((o, k) => {
            const end = k + 1 < sec.anchorOffsets.length ? sec.anchorOffsets[k + 1] : sec.body.length;
            const text = sec.body.slice(o, end).replace(/\n\n$/, "");
            return (0, import_react.createElement)("pre", {
              key: k,
              "data-am-msg": k,
              style: {
                margin: 0,
                marginBottom: k + 1 < sec.anchorOffsets.length ? 12 : 0,
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
    (0, import_react.createElement)("button", {
      onClick: () => {
        rows = [];
        clearSessionUIState();
        notify();
      },
      style: buttonStyle(false)
    }, "\u6E05\u7A7A"),
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
    )
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
  const stepOf = /* @__PURE__ */ new Map();
  for (const g of groups) g.rows.forEach((r, i) => stepOf.set(r.seq, i + 1));
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", flexDirection: "column", height: "100%" } },
    (0, import_react.createElement)(Toolbar),
    (0, import_react.createElement)(
      "div",
      { ref: listRef, onScroll: onListScroll, style: { flex: 1, overflowY: "auto" } },
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
                key: `${row.seq}:${row.ts}`,
                row,
                step: i + 1,
                stepColor: isHex ? c : void 0,
                loc: locs.get(row.seq),
                stepOf
              }))
            )
          )
        );
      })
    ),
    (0, import_react.createElement)(
      "div",
      { style: { padding: "4px 12px", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #9ca3af)", borderTop: "1px solid var(--dsw-alias-border-l1)", display: "flex", justifyContent: "space-between", gap: 8 } },
      (0, import_react.createElement)("span", null, `${groupCount} \u8F6E \xB7 ${visible.length} \u6761\u6D3B\u52A8 \xB7 ${expandedTurns.size} \u8F6E\u5DF2\u5C55\u5F00 \xB7 ${paused ? "\u5DF2\u6682\u505C" : "\u5B9E\u65F6\u5237\u65B0\u4E2D"} \xB7 \u6700\u65B0\u5728\u5E95\u90E8`),
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
      timer = window.setTimeout(tick, busyLive ? 300 : 1e3);
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
        turns: new Set(rows.filter((r) => r.turn).map((r) => r.turn)).size
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
    /** 走 dsh 自己的会话选择 API（侧栏点击内部用的就是它） */
    openSession: (id) => {
      try {
        clientCtx?.sessions?.open?.(id);
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

		})(module, exports, (name) => require(name));
		return module.exports;
	}
});
