/* global window, document, fetch */
// lib/client.js — dsh-chat-import 的 Browser 侧 bundle（手写 CJS factory，供 dsh web
// 客户端 ModuleLoader 注入）。Stage 1：被动会话发现骨架——侧边栏底部「导入会话」按钮
// → 滑出面板按来源列会话（数据来自 host 的 POST /api-import/sessions，复用
// lib/discovery.mjs 的 11 格式发现 + 30s 缓存 + 持久书签）；会话项点击暂 console.log
//（续聊/导入留 Stage 2）。纯前端：不 import 任何 DSH host 模块，只消费注入的
// slots 服务与 react。结构对齐竞品 dsh-plugin-session-import（ModuleLoader.load +
// module.exports {name,inject,apply} + ctx.slots.register）。
window.__ModuleLoader__.load({
  id: "dsh-chat-import",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useState, useEffect } = React;

    // 11 个来源（下拉顺序；与 lib/discovery.mjs 的 FORMATS 对应，claude-code → claude）
    const SOURCES = [
      "claude-code", "codex", "chatgpt", "cursor", "gemini", "reasonix",
      "opencode", "zcode", "grokbuild", "openclaw", "hermes",
    ];

    // 滑入动画（一次性注入，幂等防重复）
    if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-import-slide]")) {
      const tag = document.createElement("style");
      tag.dataset.dshImportSlide = "1";
      tag.textContent = "@keyframes dsh-import-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }";
      document.head.appendChild(tag);
    }

    // 明暗主题自适应（对齐竞品：body 的 data-ds-dark-theme 属性判定）
    const isDark = () => typeof document !== "undefined" && document.body && document.body.hasAttribute("data-ds-dark-theme");
    const themeColors = () => (isDark()
      ? { bg: "#1b1f27", border: "#2a3040", field: "#14181f", text: "#e4e8ee", dim: "#9aa3b2", dimmer: "#7a8394", accent: "#4f8cff", hover: "#1f2530" }
      : { bg: "#ffffff", border: "#d8dee6", field: "#f5f6f8", text: "#1f2328", dim: "#57606a", dimmer: "#6e7781", accent: "#0969da", hover: "#eef1f5" });

    const makeStyles = (C) => ({
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9998, display: "flex", justifyContent: "flex-end" },
      panel: {
        position: "fixed", top: 0, right: 0, bottom: 0, width: "440px", maxWidth: "92vw",
        background: C.bg, borderLeft: "1px solid " + C.border, color: C.text,
        font: "13px/1.6 system-ui, sans-serif", zIndex: 9999, display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,.35)",
        animation: "dsh-import-slide-in .18s ease-out",
      },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid " + C.border },
      title: { fontSize: "14px", fontWeight: 600 },
      close: { background: "transparent", border: "none", color: C.dim, fontSize: "16px", cursor: "pointer", padding: "2px 6px", borderRadius: "4px" },
      row: { display: "flex", gap: "8px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid " + C.border },
      label: { color: C.dim, flex: "none" },
      select: {
        flex: "1", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "6px 8px", fontSize: "13px", outline: "none",
      },
      list: { flex: "1", overflowY: "auto", padding: "8px" },
      item: { padding: "8px 10px", borderRadius: "6px", cursor: "pointer", marginBottom: "4px" },
      itemTitle: { fontSize: "12.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      itemMeta: { color: C.dimmer, fontSize: "11px", marginTop: "2px", display: "flex", gap: "8px", alignItems: "center" },
      badge: { marginLeft: "auto", fontSize: "10px", padding: "1px 6px", borderRadius: "8px", border: "1px solid " + C.border, color: C.dim, flex: "none" },
      status: { padding: "40px 16px", textAlign: "center", color: C.dimmer },
      error: { padding: "16px", textAlign: "center", color: "#cf222e" },
    });

    function fmtTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    const statusLabel = (st) => (st === "imported" ? "已导入" : st === "partial" ? "部分" : "未导入");
    const statusColor = (st, colors) => (st === "imported" ? "#1a7f37" : st === "partial" ? "#9a6700" : colors.dimmer);

    /** 发现面板：来源下拉 + 会话列表（标题/消息数/时间/导入态），空态/加载态/错误态 */
    function DiscoveryPanel({ onClose, source, onSourceChange }) {
      const colors = themeColors();
      const style = makeStyles(colors);
      const [sessions, setSessions] = useState(null); // null = 加载中；[] = 空
      const [error, setError] = useState(null);

      useEffect(() => {
        let cancelled = false;
        setSessions(null);
        setError(null);
        fetch("/api-import/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, query: "" }),
        })
          .then((resp) => resp.json())
          .then((data) => {
            if (cancelled) return;
            if (data && data.ok === true) setSessions(Array.isArray(data.sessions) ? data.sessions : []);
            else setError((data && data.error) || "会话列表加载失败");
          })
          .catch((err) => { if (!cancelled) setError(String((err && err.message) || err)); });
        return () => { cancelled = true; };
      }, [source]);

      const renderList = () => {
        const items = sessions.map((s) => {
          const ts = s.lastActiveAt || s.createdAt;
          const badgeColor = statusColor(s.importStatus, colors);
          return React.createElement("div", {
            key: s.sourcePath + "|" + s.sessionId,
            style: style.item,
            title: s.sourcePath,
            onClick: () => { console.log("[dsh-chat-import] 会话点击（续聊留 Stage 2）", s); },
            onMouseEnter: (e) => { e.currentTarget.style.background = colors.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
          },
            React.createElement("div", { style: style.itemTitle }, s.title || "(无标题)"),
            React.createElement("div", { style: style.itemMeta },
              React.createElement("span", null, (typeof s.messageCount === "number" ? s.messageCount : "—") + " 条"),
              React.createElement("span", null, fmtTime(ts) || "时间未知"),
              React.createElement("span", { style: { ...style.badge, color: badgeColor, borderColor: badgeColor } }, statusLabel(s.importStatus))));
        });
        return React.createElement("div", { style: style.list }, items);
      };

      return React.createElement("div", { style: style.overlay, onClick: onClose },
        React.createElement("div", { style: style.panel, onClick: (e) => e.stopPropagation() },
          React.createElement("div", { style: style.header },
            React.createElement("span", { style: style.title }, "导入会话"),
            React.createElement("button", { style: style.close, onClick: onClose, title: "关闭" }, "✕")),
          React.createElement("div", { style: style.row },
            React.createElement("span", { style: style.label }, "来源"),
            React.createElement("select", { style: style.select, value: source, onChange: (e) => onSourceChange(e.target.value) },
              SOURCES.map((s) => React.createElement("option", { key: s, value: s }, s)))),
          sessions === null && !error && React.createElement("div", { style: style.status }, "加载中…"),
          error && React.createElement("div", { style: style.error }, error),
          sessions !== null && !error && sessions.length === 0 && React.createElement("div", { style: style.status }, "该来源没有找到会话"),
          sessions !== null && !error && sessions.length > 0 && renderList()));
    }

    /** 侧边栏底部入口按钮：图标 + 「导入会话」 */
    function ImportButton() {
      const colors = themeColors();
      const [open, setOpen] = useState(false);
      const [source, setSource] = useState(SOURCES[0]);
      const btnStyle = {
        display: "flex", alignItems: "center", gap: "6px", width: "100%",
        background: "transparent", border: "none", color: colors.dim,
        cursor: "pointer", padding: "6px 10px", borderRadius: "6px", fontSize: "12.5px",
        textAlign: "left",
      };
      return React.createElement(React.Fragment, null,
        React.createElement("button", { style: btnStyle, title: "从其他工具导入会话（被动发现）", onClick: () => setOpen(true) },
          React.createElement("span", { style: { fontSize: "14px" } }, "⇩"),
          "导入会话"),
        open && React.createElement(DiscoveryPanel, { onClose: () => setOpen(false), source, onSourceChange: setSource }));
    }

    const name = "import-claude";
    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(() =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "chat-import", order: 0 },
          ImportButton,
        ));
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});
