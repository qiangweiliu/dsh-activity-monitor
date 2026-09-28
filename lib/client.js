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
var inject = ["slots"];
var rows = [];
var expanded = /* @__PURE__ */ new Set();
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
var pollTimer;
var currentSessionId;
async function refresh() {
  if (paused) return;
  try {
    const res = await fetch(`/api/activity-monitor/snapshot?since=${lastSeq}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.rows) && data.rows.length > 0) {
      rows = [...rows, ...data.rows].slice(-500);
      lastSeq = data.rows[data.rows.length - 1].seq;
      for (let i = data.rows.length - 1; i >= 0; i--) {
        if (data.rows[i].sessionId) {
          currentSessionId = data.rows[i].sessionId;
          break;
        }
      }
      notify();
    }
  } catch {
  }
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
function ActivityRowView({ row }) {
  const isOpen = expanded.has(row.seq);
  const hasDetail = Boolean(row.detail) || (row.sections?.length ?? 0) > 0;
  const time = new Date(row.ts).toLocaleTimeString();
  return (0, import_react.createElement)(
    "div",
    { key: row.seq, style: { borderBottom: "1px solid var(--dsw-alias-border-subtle, #e5e7eb)" } },
    (0, import_react.createElement)(
      "div",
      {
        onClick: () => {
          if (hasDetail) toggleExpand(row.seq);
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
      hasDetail && (0, import_react.createElement)("span", { style: { fontSize: 10, color: "#9ca3af", width: 10 } }, isOpen ? "\u25BE" : "\u25B8"),
      (0, import_react.createElement)(Badge, { tag: row.tag }),
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
      (0, import_react.createElement)("span", { style: { fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" } }, time)
    ),
    // 展开区：llm 行渲染分段（用户消息/助手回复/提示词段落），tool 行渲染单块 detail
    isOpen && row.sections && row.sections.length > 0 && (0, import_react.createElement)(
      "div",
      { style: { margin: "0 12px 8px 40px" } },
      row.sections.map((sec, i) => (0, import_react.createElement)(
        "div",
        { key: i, style: { marginBottom: 6 } },
        (0, import_react.createElement)("div", {
          style: {
            fontSize: 11,
            fontWeight: 600,
            color: "var(--dsw-alias-label-secondary, #6b7280)",
            padding: "3px 8px",
            background: "var(--dsw-alias-bg-subtle, #eceff3)",
            borderRadius: "4px 4px 0 0",
            border: "1px solid var(--dsw-alias-border-subtle, #e5e7eb)",
            borderBottom: "none"
          }
        }, sec.title),
        (0, import_react.createElement)("pre", {
          style: {
            margin: 0,
            padding: 8,
            fontSize: 11,
            lineHeight: 1.5,
            background: "var(--dsw-alias-bg-subtle, #f3f4f6)",
            borderRadius: "0 0 4px 4px",
            border: "1px solid var(--dsw-alias-border-subtle, #e5e7eb)",
            overflow: "auto",
            maxHeight: 220,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all"
          }
        }, sec.body)
      ))
    ),
    isOpen && row.detail && (0, import_react.createElement)("pre", {
      style: {
        margin: "0 12px 8px 40px",
        padding: 8,
        fontSize: 11,
        lineHeight: 1.5,
        background: "var(--dsw-alias-bg-subtle, #f3f4f6)",
        borderRadius: 6,
        overflow: "auto",
        maxHeight: 260,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all"
      }
    }, row.detail)
  );
}
function Toolbar() {
  const tags = ["all", ...Object.keys(TAG_STYLE)];
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
        expanded.clear();
        notify();
      },
      style: buttonStyle(false)
    }, "\u6E05\u7A7A"),
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
    border: "1px solid " + (active ? "#2563eb" : "var(--dsw-alias-border-subtle, #d1d5db)"),
    background: active ? "rgba(37,99,235,.1)" : "transparent",
    color: active ? "#2563eb" : "var(--dsw-alias-label-secondary, #4b5563)"
  };
}
function MonitorPanel() {
  const [version, setVersion] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => subscribe(() => setVersion((v) => v + 1)), []);
  const listRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [version]);
  const visible = filterTag === "all" ? rows : rows.filter((r) => r.tag === filterTag);
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", flexDirection: "column", height: "100%" } },
    (0, import_react.createElement)(Toolbar),
    (0, import_react.createElement)(
      "div",
      { ref: listRef, style: { flex: 1, overflowY: "auto" } },
      visible.length === 0 ? (0, import_react.createElement)(
        "div",
        { style: { padding: 24, textAlign: "center", color: "#9ca3af", fontSize: 13 } },
        "\u6682\u65E0\u6D3B\u52A8 \u2014\u2014 \u53D1\u8D77\u4E00\u6BB5\u5BF9\u8BDD\u540E\u8FD9\u91CC\u4F1A\u5B9E\u65F6\u663E\u793A\u63D0\u793A\u8BCD\u3001skill\u3001\u5DE5\u5177\u3001\u6587\u4EF6\u548C\u547D\u4EE4\u7684\u4F7F\u7528\u60C5\u51B5"
      ) : visible.map((row) => (0, import_react.createElement)(ActivityRowView, { key: row.seq, row }))
    ),
    (0, import_react.createElement)(
      "div",
      { style: { padding: "4px 12px", fontSize: 11, color: "#9ca3af", borderTop: "1px solid var(--dsw-alias-border-subtle, #e5e7eb)", display: "flex", justifyContent: "space-between" } },
      (0, import_react.createElement)("span", null, `\u5171 ${visible.length} \u6761 \xB7 ${paused ? "\u5DF2\u6682\u505C" : "\u5B9E\u65F6\u5237\u65B0\u4E2D"} \xB7 \u6700\u65B0\u5728\u5E95\u90E8`),
      currentSessionId && (0, import_react.createElement)("span", null, `session: ${currentSessionId.slice(0, 12)}\u2026`)
    )
  );
}
function apply(ctx) {
  ctx.effect(() => {
    const tick = () => {
      void refresh();
    };
    pollTimer = window.setInterval(tick, 1e3);
    void refresh();
    return () => {
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }, "activity-monitor: polling");
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
