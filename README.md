# Zotero Math Inline Fixer

Fix math formulas that were **pasted** into Zotero notes but never got rendered, by converting them into real ProseMirror math nodes — automatically, right after the paste.

> **The problem.** Zotero's note editor (ProseMirror) only parses `$...$` math when you **type** it manually (input rules). When you **paste** text, Zotero does not parse Markdown or math at all — so formulas copied from AI chat answers (ChatGPT / DeepSeek / Doubao / …) stay as literal text like `$$ (11,20) $$` or `$f$` forever. Single-character formulas (`$f$`, `$t$`, `$V$`) are the most frequent victims.

---

## Features

- **Automatic fix on paste** — no hotkey needed. The moment pasted content lands in the note editor, the plugin scans it and converts unparsed formulas.
- **Multi-layered trigger pipeline** (so it works even if one channel is swallowed by the editor):
  - `paste` event, captured on both the editor iframe document and the ProseMirror content node
  - `MutationObserver` watching the actual ProseMirror DOM (`view.dom`)
  - `input` / `keyup` fallback listeners
  - Debounce + cooldown + busy-guard, so nothing double-fires or loops
- **Multi-round scan** — ProseMirror inserts pasted content asynchronously; after each trigger the plugin keeps scanning (up to 30 rounds × 90 ms) until everything has landed.
- **One-step undo** — all fixes in one paste are applied as a **single ProseMirror transaction**, so `Ctrl+Z` reverts them all at once.
- **Manual trigger** — `Tools → Math Fixer` menu item, or `Ctrl+Shift+M` anywhere in Zotero.
- **Friendly notifications** — "nothing to fix" shows as a non-blocking toast (auto-dismisses in ~2.5 s); a modal dialog appears only when something was actually fixed, with a breakdown by category.
- **Robust attach logic** — listeners are version-stamped; upgrading the plugin with a note open automatically tears down old listeners and re-attaches the new ones.

### What gets fixed

| Pasted literal text | Converted to |
| --- | --- |
| `$f$`, `$x$`, `$t$` (single char) | inline math node (`math_inline`) |
| `$(11,20)$`, `$t-1$`, `$a_{i}$`, `$Q_p$` | inline math node (`math_inline`) |
| `$$ (11,20) $$` alone in a paragraph | inline math node (block math pasted as plain text) |

### What is never touched

- Already-rendered math (`math_inline` / `math_display` nodes)
- Code blocks
- Text without `$`
- Anything with CJK/full-width characters inside the formula
- Currency-like text such as `$400 to $500` (contents must be a conservative "math-safe" ASCII set: letters, digits, `_ ^ { } ( ) [ ] , . + - * / = \ ' |` and spaces, with at least one letter/digit)

---

## Installation

1. Download [`mathfixer.xpi`](mathfixer.xpi) (prebuilt, in this repo).
2. In Zotero: **Tools → Plugins** (插件管理器) → gear icon ⚙ → **Install Plugin From File…** → pick the `.xpi`.
3. Restart Zotero if prompted.

**Requirements:** Zotero 7 or newer (tested with Zotero 10.0.6 on Windows 11). Works with the stock note editor and with [Better Notes](https://github.com/windingwind/zotero-better-notes).

---

## Usage

**Automatic:**

1. Open any note.
2. Paste text containing `$...$` / `$$...$$` formulas (e.g. copied from an AI chat).
3. Within ~1 second the formulas render. Watch for the toast/dialog if you want confirmation.

**Manual:**

- Press `Ctrl+Shift+M`, or use the **Tools → Math Fixer** menu item.
- A dialog reports how many formulas were fixed (single-char vs. multi-char).
- If there was nothing to fix, a small toast appears instead — no popup spam, even if the key auto-repeats.

**Undo:** `Ctrl+Z` — one press reverts an entire paste's fixes.

---

## How It Works (technical notes)

### Reaching the editor

Zotero keeps one `EditorInstance` per open note. The plugin walks:

```
Zotero.Notes._editorInstances[i]
  ._iframeWindow.wrappedJSObject
  ._currentEditorInstance._editorCore
  → { view, state, schema }   // a ProseMirror EditorView
```

### Cross-realm pitfalls (Zotero 7+ / Firefox chrome code)

- `doc.descendants()` + `node.isText` is **unreliable across Xray wrappers** — the traversal can silently yield zero text nodes. The plugin therefore does its own recursion and checks `node.type.name === "text"`.
- Event handlers installed inside the editor iframe must be exported via `Components.utils.exportFunction(...)` into the iframe's realm.
- The listener-attach flag is stamped with the plugin version (`__mathFixerAttachedBy`); on upgrade, stale listeners from the previous version are torn down and re-attached, and `shutdown()` cleans everything up.

### Detection rules

```js
// single-char inline: $f$
/(?<!\$)\$([^\s$])\$(?!\$)/g

// multi-char inline: $(11,20)$, $t-1$, $a_{i}$ …
/(?<!\$)\$([^\s$][^$\n]*[^\s$])\$(?!\$)/g

// standalone $$…$$ occupying a whole paragraph
/^\s*\$\$\s*([^$\n]+?)\s*\$\$\s*$/
```

All matches must additionally pass the "math-safe" charset test (no CJK, no newlines, at least one letter/digit) to avoid false positives.

### Replacement

Targets are sorted back-to-front and replaced with `schema.nodes.math_inline` nodes in **one** transaction (`addToHistory` enabled), then a short busy-flag suppresses the plugin's own MutationObserver so the burst doesn't retrigger itself.

---

## Build from source

The plugin is plain JavaScript — no bundler, no dependencies:

```bash
# macOS / Linux
cd mathfixer-src
zip -r -X ../mathfixer.xpi manifest.json bootstrap.js mathfixer.js icons
```

```powershell
# Windows PowerShell (from the source folder)
Compress-Archive -Path manifest.json, bootstrap.js, mathfixer.js, icons -DestinationPath ..\mathfixer.zip
Rename-Item ..\mathfixer.zip mathfixer.xpi
```

(`bootstrap.js` and `mathfixer.js` must sit at the root of the archive, not inside a subfolder.)

---

## Project structure

```
Zotero-Math-Inline-Fixer/
├── manifest.json      # plugin metadata (Zotero 7+ bootstrap plugin)
├── bootstrap.js       # lifecycle: startup / shutdown / main-window hooks
├── mathfixer.js       # all logic: detection, ProseMirror transactions, triggers
├── icons/             # 48px / 96px icons
├── mathfixer.xpi      # prebuilt, install-ready
└── README.md
```

---

## Compatibility & Limitations

- Formula content must be ASCII "math-safe" — CJK inside `$…$` is intentionally not converted.
- `$$…$$` is fixed only when the entire paragraph consists of that single line.
- The plugin does **not** render LaTeX itself; it creates native Zotero math nodes and lets Zotero (KaTeX) do the rendering. Anything Zotero's math parser can't handle will still show as-is inside the math node.
- Developed and tested against Zotero 10.0.6 + Better Notes 3.3.3 on Windows 11. Use on other versions at your own discretion — and keep backups / rely on `Ctrl+Z`.

---

## 中文快速上手

**这是什么：** 从 ChatGPT / 豆包等复制笔记到 Zotero（或 Better Notes）时，`$f$`、`$(11,20)$`、`$$…$$` 这类公式会保持纯文本、不渲染。本插件在**粘贴后自动**把它们转换成 Zotero 原生公式节点。

**安装：** 下载本仓库的 `mathfixer.xpi` → Zotero 菜单 **工具 → 插件** → 右上角齿轮 → **从文件安装插件** → 选中 xpi。

**使用：**

- 正常粘贴即可，公式会在约 1 秒内自动渲染；
- 也可随时按 `Ctrl+Shift+M`（或菜单 **工具 → Math Fixer**）手动修复当前笔记；
- 修复是**一步撤销**的：`Ctrl+Z` 一次撤销整次粘贴的所有修改；
- "没有可修复内容"只会在右下角弹一个小提示，不会反复弹窗。

**不会动的内容：** 已渲染的公式、代码块、含中文的 `$…$`、`$400 to $500` 这类非公式文本。
