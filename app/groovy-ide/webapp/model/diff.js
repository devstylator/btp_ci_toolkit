sap.ui.define([], function () {
  "use strict";

  const MAX_CELLS = 4000000; // LCS table limit (e.g. 2000 x 2000 lines)

  const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

  /** Line diff (LCS). Returns [{ type: " " | "-" | "+", text }] from `before` to `after`. */
  function diffLines(before, after) {
    const a = (before || "").replace(/\r\n?/g, "\n").split("\n");
    const b = (after || "").replace(/\r\n?/g, "\n").split("\n");
    if (a.length * b.length > MAX_CELLS) {
      return [...a.map((text) => ({ type: "-", text })), ...b.map((text) => ({ type: "+", text }))];
    }
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        out.push({ type: " ", text: a[i++] });
        j++;
      } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
        out.push({ type: "-", text: a[i++] });
      } else {
        out.push({ type: "+", text: b[j++] });
      }
    }
    return out;
  }

  /** HTML for sap.ui.core.HTML (single root element, escaped text). */
  function toHtml(lines) {
    const rows = lines.map(({ type, text }) => {
      const cls = type === "+" ? "gideDiffAdd" : type === "-" ? "gideDiffDel" : "";
      return `<div class="${cls}">${type} ${escape(text) || "&nbsp;"}</div>`;
    });
    return `<div class="gideDiff">${rows.join("")}</div>`;
  }

  return { diffLines, toHtml };
});
