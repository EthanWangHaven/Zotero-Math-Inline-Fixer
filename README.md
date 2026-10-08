# Zotero Math Inline Fixer（Zotero 数学公式修复插件）

把**粘贴**进 Zotero 笔记、却始终不渲染的数学公式，自动转换成 Zotero 原生公式节点 —— 粘贴后自动完成，无需任何手动操作。

> **问题背景：** Zotero 的笔记编辑器（ProseMirror）只有在你**手动输入**时才会解析 `$...$` 数学公式（input rule 机制）；**粘贴**时完全不解析 Markdown 和数学公式。因此从 ChatGPT / DeepSeek / 豆包等 AI 对话中复制的笔记，公式会一直以纯文本形式存在，比如 `$$ (11,20) $$`、`$f$`。其中**单字符公式**（`$f$`、`$t$`、`$V$`）是最常见的重灾区。

---

## 功能特性

- **粘贴后自动修复** —— 无需快捷键。粘贴内容落进笔记编辑器的瞬间，插件自动扫描并转换未渲染的公式。
- **多层触发管道**（即使某一通道被编辑器吞掉也能兜住）：
  - `paste` 事件，同时挂在编辑器 iframe 的 document 和 ProseMirror 内容节点上（捕获阶段）
  - `MutationObserver` 监听真正的 ProseMirror DOM（`view.dom`）
  - `input` / `keyup` 兜底监听
  - 防抖 + 冷却 + busy 自激保护，绝不重复触发、绝不循环
- **多轮扫描** —— ProseMirror 插入粘贴内容是异步的；每次触发后插件会连续扫描（最多 30 轮 × 90ms），直到内容全部落地。
- **一步撤销** —— 同一次粘贴的所有修复合并为**单个 ProseMirror 事务**提交，`Ctrl+Z` 一次全部还原。
- **手动触发** —— 菜单 **工具 → Math Fixer**，或快捷键 `Ctrl+Shift+M`。
- **友好的提示方式** —— "没有可修复内容"只显示右下角非阻塞小提示（约 2.5 秒自动消失，不抢焦点、不排队弹窗）；只有真正修复了内容才弹确认框，并给出分类统计。
- **健壮的监听挂载** —— 监听带版本戳；插件升级时即使笔记编辑器开着，也会自动拆除旧监听、重新挂载新监听。

### 会被修复的

| 粘贴后的字面文本 | 转换结果 |
| --- | --- |
| `$f$`、`$x$`、`$t$`（单字符） | 行内公式节点（`math_inline`） |
| `$(11,20)$`、`$t-1$`、`$a_{i}$`、`$Q_p$` | 行内公式节点（`math_inline`） |
| `$$ (11,20) $$` 独占一个段落 | 行内公式节点（块级公式被当纯文本粘贴的情况） |

### 永远不会动的

- 已经渲染好的公式（`math_inline` / `math_display` 节点）
- 代码块
- 不含 `$` 的文本
- 公式内容里含中文 / 全角字符的
- `$400 to $500` 这类非公式文本 —— 内容必须通过保守的"数学安全字符集"检查（仅允许字母、数字、`_ ^ { } ( ) [ ] , . + - * / = \ ' |` 和空格，且至少含一个字母或数字）

---

## 安装

1. 从 [Releases](https://github.com/EthanWangHaven/Zotero-Math-Inline-Fixer/releases) 页面下载最新的 `mathfixer.xpi`（仓库里也有一份预编译包）。
2. Zotero 菜单：**工具 → 插件**（插件管理器）→ 右上角齿轮 ⚙ → **从文件安装插件…** → 选中 `.xpi`。
3. 如有提示则重启 Zotero。

**环境要求：** Zotero 7 及以上（实测 Zotero 10.0.6 / Windows 11）。原生笔记编辑器和 [Better Notes](https://github.com/windingwind/zotero-better-notes) 均可使用。

---

## 使用方法

**自动模式（推荐）：**

1. 打开任意笔记。
2. 正常粘贴含 `$...$` / `$$...$$` 公式的文本（比如从 AI 对话复制）。
3. 约 1 秒内公式自动渲染完成。

**手动模式：**

- 随时按 `Ctrl+Shift+M`，或菜单 **工具 → Math Fixer**。
- 若修复了内容，会弹确认框显示总数与分类（单字符 / 多字符）。
- 若没有可修复内容，只出现一个右下角小提示 —— 即使按住快捷键不放也只触发一次。

**撤销：** `Ctrl+Z` —— 一次撤销整次粘贴的全部修改。

---

## 工作原理（技术细节）

### 访问编辑器

Zotero 为每个打开的笔记维护一个 `EditorInstance`，插件按以下路径拿到 ProseMirror 的 `EditorView`：

```
Zotero.Notes._editorInstances[i]
  ._iframeWindow.wrappedJSObject
  ._currentEditorInstance._editorCore
  → { view, state, schema }   // ProseMirror EditorView
```

### 跨 realm 的坑（Zotero 7+ / Firefox chrome 代码）

- `doc.descendants()` 配合 `node.isText` 在 Xray wrapper 下**不可靠** —— 遍历可能静默返回 0 个文本节点。因此插件自己递归遍历，用 `node.type.name === "text"` 判断。
- 在编辑器 iframe 内安装的事件处理器，必须用 `Components.utils.exportFunction(...)` 导出成 iframe realm 的函数。
- 监听挂载标志带版本戳（`__mathFixerAttachedBy`）：升级时旧版本残留的监听会被拆除并重挂；插件 `shutdown()` 时彻底清理。

### 识别规则

```js
// 单字符行内：$f$
/(?<!\$)\$([^\s$])\$(?!\$)/g

// 多字符行内：$(11,20)$、$t-1$、$a_{i}$ …
/(?<!\$)\$([^\s$][^$\n]*[^\s$])\$(?!\$)/g

// 独占整个段落的 $$…$$
/^\s*\$\$\s*([^$\n]+?)\s*\$\$\s*$/
```

所有命中还必须通过"数学安全字符集"检查（不含中文、不含换行、至少一个字母/数字），避免误伤。

### 替换方式

按位置**从后往前**收集目标，替换为 `schema.nodes.math_inline` 节点，全部改动合并为**一个**事务（`addToHistory` 开启）。提交期间设置 busy 标志，抑制插件自身的 MutationObserver，防止扫描自激循环。

---

## 从源码构建

纯 JavaScript 实现 —— 无需打包器、无任何依赖：

```bash
# macOS / Linux
cd mathfixer-src
zip -r -X ../mathfixer.xpi manifest.json bootstrap.js mathfixer.js icons
```

```powershell
# Windows PowerShell（在源码目录内执行）
Compress-Archive -Path manifest.json, bootstrap.js, mathfixer.js, icons -DestinationPath ..\mathfixer.zip
Rename-Item ..\mathfixer.zip mathfixer.xpi
```

（`bootstrap.js` 和 `mathfixer.js` 必须位于压缩包根目录，不能嵌套子目录。）

---

## 项目结构

```
Zotero-Math-Inline-Fixer/
├── manifest.json      # 插件元数据（Zotero 7+ bootstrap 插件）
├── bootstrap.js       # 生命周期：startup / shutdown / 主窗口钩子
├── mathfixer.js       # 全部逻辑：识别、ProseMirror 事务、触发管道
├── icons/             # 48px / 96px 图标
├── mathfixer.xpi      # 预编译安装包
└── README.md
```

---

## 兼容性与限制

- 公式内容必须是 ASCII"数学安全字符"—— `$…$` 内含中文的不会被转换（有意为之，防误伤）。
- `$$…$$` 只在整段恰好就是这一行时才会被修复。
- 本插件**不负责** LaTeX 渲染 —— 它只生成 Zotero 原生数学节点，渲染由 Zotero（KaTeX）完成；Zotero 数学解析器不支持的语法在公式节点内仍会原样显示。
- 开发与测试环境：Zotero 10.0.6 + Better Notes 3.3.3 / Windows 11。其他版本请自行斟酌，注意备份、善用 `Ctrl+Z`。

---

## 更新日志

### v1.1.1
- 修复报告弹窗的明细行去掉项目符号 `·`

### v1.1.0
- `Ctrl+Shift+M` 过滤按键自动重复（`event.repeat`）+ 800ms 防抖，杜绝连环弹窗
- "没有可修复内容"、"未找到编辑器"改为右下角非阻塞提示

### v1.0.9
- 监听挂载标志带版本戳；升级时自动拆旧重挂；`shutdown()` 彻底清理

### v1.0.8
- `MutationObserver` 改为观察真正的 ProseMirror DOM（`view.dom`）
- `paste` 同时挂在 document 与 ProseMirror 节点；新增 `input` / `keyup` 兜底
- 挂载时输出诊断日志（目标 document 与 ProseMirror 节点）
