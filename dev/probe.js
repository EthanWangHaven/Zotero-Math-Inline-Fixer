/* global Zotero, Services, Components */
"use strict";

/**
 * Better Notes Editor Probe - probe.js
 *
 * 目标：不做任何修改，只把「当前笔记编辑器」的真实结构打印出来。
 *
 * 输出位置：
 *   1. Zotero 调试输出（Tools -> Developer -> Error Console，或 Help -> Debug Output Logging）
 *   2. 一个可复制的弹窗（Zotero.alert 不方便复制，这里用一个自建窗口 / 文本框）
 *
 * 需要确认的关键信息：
 *   - 编辑器是「Better Notes 编辑器」还是「Zotero 原生笔记编辑器」
 *   - editor 实例对象上的关键属性（_item / _iframeWindow / _editorCore ...）
 *   - ProseMirror EditorView：view.dom / view.state
 *   - schema 中的 node 类型（是否有 math_inline / math_display）
 *   - 当前文档中 $f$ 一类单字符公式被解析成了什么（text 还是 math_inline 节点）
 */

var EditorProbe = {
  id: null,
  version: null,
  rootURI: null,
  _windows: new Set(),

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    Zotero.EditorProbe = this; // 方便在 Run JavaScript 里手动调用
  },

  uninit() {
    delete Zotero.EditorProbe;
  },

  /* ---------------- 窗口注入：菜单 + 快捷键 ---------------- */

  addToAllWindows() {
    for (let win of Zotero.getMainWindows()) {
      this.addToWindow(win);
    }
  },

  removeFromAllWindows() {
    for (let win of Zotero.getMainWindows()) {
      this.removeFromWindow(win);
    }
  },

  addToWindow(win) {
    if (!win || !win.document || this._windows.has(win)) {
      return;
    }
    let doc = win.document;

    // 1) 注册菜单：Zotero 的笔记编辑器右键菜单是「动态创建」的，
    //    启动时 doc.getElementById 找不到，必须在每次菜单弹出时再挂载。
    //    这里监听整个 document 的 popupshowing（捕获阶段），覆盖所有弹出菜单。
    let onPopupShowing = (event) => {
      let popup = event.target;
      if (!popup || !popup.id) {
        return;
      }
      // 只处理我们关心的几个菜单
      if (
        ![
          "zotero-note-editor-menu",
          "zotero-itemmenu",
          "zotero-collectionmenu",
          "note-editor-menu",
        ].includes(popup.id)
      ) {
        return;
      }
      this._ensureMenuItem(win, popup);
    };
    doc.addEventListener("popupshowing", onPopupShowing, true);

    // 2) 快捷键 Ctrl+Shift+Alt+P（避免和 Zotero 原生冲突）
    let onKeyDown = (event) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.altKey &&
        (event.key === "P" || event.key === "p")
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.probeActiveEditor(win);
      }
    };
    win.addEventListener("keydown", onKeyDown, true);

    // 3) 工具菜单（Tools -> Probe 编辑器结构）——最可靠的入口
    this._addToolsMenuItem(win);

    // 4) 主工具栏按钮
    this._addToolbarButton(win);

    this._windows.add(win);
    win.__editorProbeKeyDown = onKeyDown;
    win.__editorProbePopupShowing = onPopupShowing;
  },

  /** 工具菜单项：Tools -> Probe 编辑器结构 */
  _addToolsMenuItem(win) {
    let doc = win.document;
    let toolsPopup =
      doc.getElementById("menu_ToolsPopup") || doc.getElementById("menu_toolsPopup");
    if (!toolsPopup || toolsPopup.querySelector("#editorprobe-tools-menuitem")) {
      return;
    }
    try {
      let mi = doc.createXULElement
        ? doc.createXULElement("menuitem")
        : doc.createElement("menuitem");
      mi.id = "editorprobe-tools-menuitem";
      mi.setAttribute("label", "Probe 编辑器结构（Editor Probe）");
      mi.addEventListener("command", () => this.probeActiveEditor(win));
      toolsPopup.appendChild(mi);
    } catch (e) {
      Zotero.debug("[EditorProbe] 添加 Tools 菜单失败: " + e.message);
    }
  },

  /** 主工具栏按钮（zotero-tb-add 附近） */
  _addToolbarButton(win) {
    let doc = win.document;
    let toolbar = doc.getElementById("zotero-toolbar");
    if (!toolbar || toolbar.querySelector("#editorprobe-toolbarbutton")) {
      return;
    }
    try {
      let btn = doc.createXULElement
        ? doc.createXULElement("toolbarbutton")
        : doc.createElement("toolbarbutton");
      btn.id = "editorprobe-toolbarbutton";
      btn.setAttribute("label", "Probe");
      btn.setAttribute("tooltiptext", "Probe 编辑器结构（Ctrl+Shift+Alt+P）");
      btn.setAttribute("class", "toolbarbutton-1");
      btn.addEventListener("command", () => this.probeActiveEditor(win));
      toolbar.appendChild(btn);
    } catch (e) {
      Zotero.debug("[EditorProbe] 添加工具栏按钮失败: " + e.message);
    }
  },

  /**
   * 在指定菜单里确保存在我们的菜单项（幂等）。
   * 由于 ProseMirror 编辑器的右键菜单可能是它在 iframe 内自建的，
   * 这里同时尝试：XUL menuitem 与 XUL/HTML menu（带子菜单）。
   */
  _ensureMenuItem(win, popup) {
    let doc = win.document;
    if (popup.querySelector && popup.querySelector("#editorprobe-menuitem")) {
      return;
    }
    try {
      let isXUL = typeof doc.createXULElement === "function";
      let mi = isXUL
        ? doc.createXULElement("menuitem")
        : doc.createElementNS("http://www.w3.org/1999/xhtml", "menuitem");
      mi.id = "editorprobe-menuitem";
      mi.setAttribute("label", "⚠ Probe 编辑器结构（Editor Probe）");
      mi.addEventListener("command", (e) => {
        e.preventDefault();
        this.probeActiveEditor(win);
      });
      // 放到菜单最前面，避免被 Zotero 的动态填充覆盖
      popup.insertBefore(mi, popup.firstChild);
    } catch (e) {
      Zotero.debug("[EditorProbe] 添加菜单项失败: " + e.message);
    }
  },

  removeFromWindow(win) {
    if (!win) {
      return;
    }
    let doc = win.document;
    try {
      doc
        .querySelectorAll(
          "#editorprobe-menuitem, #editorprobe-tools-menuitem, #editorprobe-toolbarbutton",
        )
        .forEach((el) => el.remove());
    } catch (e) {
      /* ignore */
    }
    if (win.__editorProbePopupShowing) {
      doc.removeEventListener("popupshowing", win.__editorProbePopupShowing, true);
      delete win.__editorProbePopupShowing;
    }
    if (win.__editorProbeKeyDown) {
      win.removeEventListener("keydown", win.__editorProbeKeyDown, true);
      delete win.__editorProbeKeyDown;
    }
    this._windows.delete(win);
  },

  /* ---------------- 核心：定位编辑器实例 ---------------- */

  /**
   * 尝试从多个来源找到「当前打开的笔记编辑器」实例。
   * 返回 { editor, source }
   */
  findActiveEditor(win) {
    let candidates = [];

    // A. Zotero 原生笔记编辑器实例列表（Better Notes 也复用这套机制）
    try {
      let instances = Zotero.Notes._editorInstances || [];
      for (let e of instances) {
        candidates.push({ editor: e, source: "Zotero.Notes._editorInstances" });
      }
    } catch (e) {
      /* ignore */
    }

    // B. 当前活动窗口中的笔记编辑器（如果 Zotero 提供）
    try {
      let zp = win.ZoteroPane;
      if (zp && zp.getSelectedItems) {
        // 某些版本会有 item.getNoteEditorInstance()
      }
    } catch (e) {
      /* ignore */
    }

    // 优先选择「非 dead wrapper 且带 iframe」的实例
    for (let c of candidates) {
      try {
        if (
          c.editor &&
          c.editor._iframeWindow &&
          !Components.utils.isDeadWrapper(c.editor._iframeWindow)
        ) {
          return c;
        }
      } catch (e) {
        /* ignore */
      }
    }
    return candidates[0] || null;
  },

  /**
   * 从 editor 实例中提取 EditorCore（ProseMirror）。
   * 兼容 Better Notes 与 Zotero 原生两种内部结构。
   */
  getEditorCore(editor) {
    let results = [];

    // 1) Better Notes 曾经使用的路径
    try {
      let win = editor._iframeWindow;
      if (win && !Components.utils.isDeadWrapper(win)) {
        let w = win.wrappedJSObject || win;
        if (w._currentEditorInstance && w._currentEditorInstance._editorCore) {
          results.push({
            core: w._currentEditorInstance._editorCore,
            path: "_iframeWindow.wrappedJSObject._currentEditorInstance._editorCore",
          });
        }
      }
    } catch (e) {
      /* ignore */
    }

    // 2) Zotero 原生笔记编辑器常见路径
    for (let path of [
      "_editorCore",
      "_currentEditorInstance",
      "_iframeWindow.wrappedJSObject",
      "_iframeWindow",
    ]) {
      try {
        let core = this._resolvePath(editor, path);
        if (core) {
          if (core._editorCore) {
            results.push({ core: core._editorCore, path: path + "._editorCore" });
          } else if (core.view) {
            results.push({ core, path });
          }
        }
      } catch (e) {
        /* ignore */
      }
    }

    return results;
  },

  _resolvePath(obj, path) {
    let parts = path.split(".");
    let cur = obj;
    for (let p of parts) {
      if (cur == null) {
        return undefined;
      }
      cur = cur[p];
    }
    return cur;
  },

  /* ---------------- 采集报告 ---------------- */

  probeActiveEditor(win) {
    let report = [];
    let push = (line) => {
      report.push(line);
    };

    push("================ Better Notes Editor Probe ================");
    push("时间: " + new Date().toISOString());
    push(
      "Zotero 版本: " +
        (Zotero.version || (Zotero.AppData && Zotero.AppData.version) || "未知"),
    );
    push("插件版本: " + this.version);

    // Better Notes 是否存在
    let bn = Zotero.BetterNotes;
    push(
      "Better Notes 已安装: " +
        (!!bn) +
        (bn && bn.api ? "（api 可用）" : "（但 api 不可用）"),
    );
    if (bn && bn.data && bn.data.version) {
      push("  Better Notes 版本: " + bn.data.version);
    }

    let found = this.findActiveEditor(win);
    if (!found) {
      push("");
      push(">>> 未找到任何笔记编辑器实例。");
      push(
        ">>> 请先打开一个笔记（双击条目下的笔记，或打开 Better Notes 工作区），再执行探针。",
      );
      this._output(report);
      return;
    }

    push("");
    push("--- 编辑器实例来源: " + found.source + " ---");
    this._dumpInstance(found.editor, push);

    let cores = this.getEditorCore(found.editor);
    this._lastCores = cores;
    push("");
    push("--- 找到的 EditorCore 候选: " + cores.length + " 个 ---");
    for (let { core, path } of cores) {
      push("");
      push("### EditorCore 路径: " + path);
      this._dumpEditorCore(core, push);
    }

    push("");
    push("--- 单字符公式正则测试（与 Math Fixer 插件使用同一正则）---");
    try {
      this._testMathRegex(cores, push);
    } catch (e) {
      push("  测试失败: " + e.message);
    }

    push("");
    push("================= END Editor Probe =================");

    this._output(report);
  },

  /** 用与 Math Fixer 相同的正则扫描当前文档，报告匹配数（不修改文档） */
  _testMathRegex(cores, push) {
    if (!cores || !cores.length) {
      push("  无 core，跳过。");
      return;
    }
    let core = cores[0].core;
    if (!core || !core.view) {
      push("  无 view，跳过。");
      return;
    }
    let doc = core.view.state.doc;
    let re = /(?<!\$)\$([^\s$])\$(?!\$)/g;
    let total = 0;
    let samples = [];
    this._walkDoc(doc, (node, pos) => {
      if (node.type.name === "text") {
        let text = node.text || "";
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          total++;
          if (samples.length < 15) {
            samples.push(
              "pos=" + (pos + m.index) + " 匹配 " + JSON.stringify(m[0]) + " (latex=" + JSON.stringify(m[1]) + ")",
            );
          }
        }
      }
    });
    push("  正则命中数: " + total);
    for (let s of samples) {
      push("    " + s);
    }
    push("  math_inline 是否存在: " + !!(core.view.state.schema.nodes.math_inline));
  },

  _dumpInstance(editor, push) {
    push("editor 对象类型: " + Object.prototype.toString.call(editor));
    let keys = [];
    try {
      keys = Object.keys(editor);
    } catch (e) {
      push("  无法枚举 editor 属性: " + e.message);
    }
    push("editor 自有属性（" + keys.length + "）:");
    for (let k of keys) {
      let v;
      try {
        v = editor[k];
      } catch (e) {
        push("  " + k + " = <getter 抛错: " + e.message + ">");
        continue;
      }
      let t = typeof v;
      if (v == null) {
        push("  " + k + " = " + v);
      } else if (t === "object" || t === "function") {
        push(
          "  " +
            k +
            " : " +
            t +
            " (" +
            (v.constructor && v.constructor.name ? v.constructor.name : "?") +
            ")",
        );
      } else {
        push("  " + k + " = " + String(v));
      }
    }
    // 笔记信息
    try {
      if (editor._item) {
        push("");
        push("笔记条目: id=" + editor._item.id + ", libraryID=" + editor._item.libraryID);
        push("  是笔记: " + editor._item.isNote());
      }
    } catch (e) {
      /* ignore */
    }
  },

  _dumpEditorCore(core, push) {
    if (!core) {
      push("  <core 为空>");
      return;
    }
    push("core 属性: " + this._safeKeys(core).join(", "));

    let view = core.view;
    if (!view) {
      push("  core.view 不存在！这一步非常关键，说明编辑器结构不同。");
      // 尝试其他可能的名字
      for (let k of this._safeKeys(core)) {
        let v = core[k];
        if (v && v.state && v.dispatch) {
          push("  发现疑似 EditorView: core." + k);
          view = v;
          break;
        }
      }
      if (!view) {
        return;
      }
    }

    push("");
    push("--- ProseMirror EditorView ---");
    push("view.dom: " + this._describeDom(view.dom));
    try {
      let contenteditable =
        view.dom && view.dom.getAttribute
          ? view.dom.getAttribute("contenteditable")
          : "?";
      push("view.dom.contenteditable = " + contenteditable);
      push("view.dom.className = " + (view.dom && view.dom.className));
    } catch (e) {
      /* ignore */
    }

    let state = view.state;
    if (!state) {
      push("  view.state 不存在！");
      return;
    }

    push("");
    push("--- schema nodes（节点类型，关注是否有 math_inline / math_display）---");
    try {
      let nodes = state.schema.nodes;
      push("  " + Object.keys(nodes).join(", "));
    } catch (e) {
      push("  读取 schema.nodes 失败: " + e.message);
    }
    push("");
    push("--- schema marks ---");
    try {
      push("  " + Object.keys(state.schema.marks).join(", "));
    } catch (e) {
      push("  读取 schema.marks 失败: " + e.message);
    }

    push("");
    push("--- 文档顶层结构（line / block）---");
    try {
      let doc = state.doc;
      push("  顶层子节点数（行数）: " + doc.childCount);
      let i = 0;
      for (let node of doc.children) {
        push(
          "  [" +
            i +
            "] <" +
            node.type.name +
            "> size=" +
            node.content.size +
            "  text=" +
            this._short(node.textContent, 80),
        );
        i++;
        if (i > 40) {
          push("  ...（省略更多行）");
          break;
        }
      }
    } catch (e) {
      push("  读取 doc 失败: " + e.message);
    }

    push("");
    push("--- 内联节点扫描（找出所有 math 相关节点 & 含 $ 的文本）---");
    try {
      this._scanInline(state.doc, push);
    } catch (e) {
      push("  扫描失败: " + e.message);
    }

    push("");
    push("--- 文档内联结构详解（只看前 15 个块，逐个 inline 子节点）---");
    try {
      this._dumpInlineStructure(core, push);
    } catch (e) {
      push("  结构 dump 失败: " + e.message);
    }

    push("");
    push("--- 专用诊断：裸的 $$...$$ 文本节点（未渲染的块级公式）---");
    try {
      this._dumpDollarBlockNodes(state.doc, push);
    } catch (e) {
      push("  诊断失败: " + e.message);
    }

    push("");
    push("--- 当前选区 ---");
    try {
      let sel = state.selection;
      push(
        "  from=" +
          sel.from +
          ", to=" +
          sel.to +
          ", empty=" +
          sel.empty +
          ", 类型=" +
          (sel.constructor && sel.constructor.name),
      );
    } catch (e) {
      /* ignore */
    }
  },

  _scanInline(doc, push) {
    let mathCount = 0;
    let dollarTexts = [];
    let suspectChars = new Map(); // 字符 -> 出现次数（疑似 $ 的变体）
    this._walkDoc(doc, (node, nodePos) => {
      if (node.type.name === "text") {
        let text = node.text || "";
        if (text.indexOf("$") >= 0) {
          dollarTexts.push({ pos: nodePos, text });
        }
        // 统计所有「非 ASCII」字符，找出可能的全角 ＄ / 其他变体
        for (let ch of text) {
          let cp = ch.codePointAt(0);
          if (cp > 127 && cp < 0xff00 + 0x100) {
            // 只关心看起来像符号的：全角区 0xFF00-0xFFEF，以及常见中文标点
            if (
              (cp >= 0xff00 && cp <= 0xffef) ||
              cp === 0xfeff ||
              cp === 0x200b ||
              cp === 0x00a0
            ) {
              suspectChars.set(ch, (suspectChars.get(ch) || 0) + 1);
            }
          }
        }
      } else if (
        node.type.name === "math_inline" ||
        node.type.name === "math_display"
      ) {
        mathCount++;
        if (mathCount <= 30) {
          push(
            "  [MATH] <" +
              node.type.name +
              "> pos=" +
              nodePos +
              " attrs=" +
              this._short(JSON.stringify(node.attrs), 200),
          );
        }
      }
    });
    push("  math 节点总数: " + mathCount);
    push("  包含 '$' 的文本节点数: " + dollarTexts.length);
    let n = 0;
    for (let t of dollarTexts) {
      push("  [TEXT$] pos=" + t.pos + " " + JSON.stringify(this._short(t.text, 200)));
      // 打印每个 $ 的码点，确认是不是真正的 U+0024
      let codes = [];
      for (let i = 0; i < t.text.length && codes.length < 12; i++) {
        if (t.text[i] === "$" || t.text.codePointAt(i) > 127) {
          codes.push(
            JSON.stringify(t.text[i]) + "=U+" + t.text.codePointAt(i).toString(16).toUpperCase(),
          );
        }
      }
      push("           码点: " + codes.join("  "));
      if (++n >= 40) {
        push("  ...（省略更多）");
        break;
      }
    }
    if (suspectChars.size) {
      push("");
      push("  >>> 可疑字符（可能是全角/零宽变体，导致 $ 匹配失败）:");
      for (let [ch, cnt] of suspectChars) {
        push(
          "      " +
            JSON.stringify(ch) +
            " = U+" +
            ch.codePointAt(0).toString(16).toUpperCase() +
            "  出现 " +
            cnt +
            " 次",
        );
      }
    }
  },

  /* ---------------- 输出 ---------------- */

  /**
   * 跨 realm 安全的文档遍历器。
   *
   * 为什么不用 doc.descendants：
   *   在 Zotero 的 Xray wrapper / iframe 跨 realm 环境下，
   *   ProseMirror 节点的 `node.isText` getter 在 descendants 遍历中会失效
   *   （实测 descendants 里 text 节点被当成非文本，遍历到 0 个 text 节点），
   *   导致基于 isText 的扫描（正则、$ 统计）全部漏掉文本。
   *
   * 因此这里手工递归 node.children，并用跨 realm 可靠的
   *   node.type.name === "text"
   * 判断文本节点，同时自行累加 pos（子节点的起始位置）。
   *
   * @param {Node} root 起始节点（通常是 doc）
   * @param {(node, pos) => void} cb 对每个节点回调；pos 为该节点在文档中的绝对位置
   */
  _walkDoc(root, cb) {
    // 与 ProseMirror 的 descendants 位置语义保持一致：
    //   - 对 doc（根）：第一个子节点位于 pos=0
    //   - 对普通节点：其内容从 pos+1 开始，第一个子节点位于 pos+1
    // 用显式栈避免递归过深。
    let visitChildren = (node, contentStart) => {
      let offset = 0;
      for (let i = 0; i < node.childCount; i++) {
        let child = node.child(i);
        let childPos = contentStart + offset;
        cb(child, childPos, node);
        if (child.childCount > 0) {
          // 非叶子节点：其内容起点 = childPos + 1
          visitChildren(child, childPos + 1);
        }
        offset += child.nodeSize;
      }
    };
    visitChildren(root, 0);
  },

  /**
   * 专门诊断「裸的 $$...$$ 文本节点」：找出形如 `$$ (11,20) $$` 的
   * 未渲染块级公式文本，打印它自己、父节点、以及同父的所有兄弟节点，
   * 用于确定 Math Fixer 该用什么范围替换。
   */
  _dumpDollarBlockNodes(doc, push) {
    let found = 0;
    let self = this;
    // 先收集所有 text 节点的父链信息
    let texts = [];
    this._walkDoc(doc, (node, pos, parent) => {
      if (node.type.name === "text") {
        texts.push({ node, pos, parent });
      }
    });

    for (let t of texts) {
      let text = t.node.text || "";
      // 只看「整块就是 $$...$$（单行、不含换行）」的文本节点
      if (!/^\s*\$\$.+\$\$\s*$/.test(text) || text.indexOf("\n") >= 0) {
        continue;
      }
      found++;
      let p = t.parent;
      push("  [DOLLAR-BLOCK] pos=" + t.pos + " " + JSON.stringify(this._short(text, 80)));
      push("      自身类型: " + t.node.type.name + " marks=" + self._marksDesc(t.node));
      // 父节点信息（用遍历时传入的 parent，跨 realm 比 node.parent 可靠）
      push(
        "      父节点: <" +
          (p ? p.type.name : "?") +
          "> childCount=" +
          (p ? p.childCount : "?") +
          " 内容=" +
          JSON.stringify(this._short(p ? p.textContent : "", 80)),
      );
      // 同父的兄弟
      if (p) {
        let sib = [];
        for (let i = 0; i < p.childCount; i++) {
          let c = p.child(i);
          sib.push("<" + c.type.name + ">" + JSON.stringify(this._short(c.text || c.textContent, 30)));
        }
        push("      同父兄弟(" + p.childCount + "): " + sib.join(" | "));
        // 祖父：p 在 doc 顶层的位置
        for (let i = 0; i < doc.childCount; i++) {
          if (doc.child(i) === p) {
            push("      祖父: doc（该父节点是顶层第 " + i + " 块）");
            break;
          }
        }
      }
      push("");
    }
    if (!found) {
      push("  （没有形如 $$...$$ 的裸文本节点）");
    }
  },

  _marksDesc(node) {
    try {
      let marks = node.marks || [];
      return "[" + marks.map((m) => m.type.name).join(",") + "]";
    } catch (e) {
      return "[?]";
    }
  },

  /**
   * 逐块 dump 内联子节点结构，重点标出：
   *   - text 节点中是否含半角 $ (U+24)
   *   - text 节点中是否含全角 ＄ (U+FF04) 或其他类 $ 字符
   *   - math_inline / math_display 节点
   *   - 每个 text 节点的 marks 和所有非 ASCII 字符的码点
   */
  _dumpInlineStructure(core, push) {
    if (!core || !core.view) {
      push("  无 view");
      return;
    }
    let doc = core.view.state.doc;

    // 先做一次「全局 text 节点普查」：统计 半角$ / 全角＄ / 其它类$变体 的总数
    let stat = { half: 0, full: 0, otherDollarLike: 0, textNodes: 0, mathNodes: 0 };
    // 记录所有「裸的类公式文本」：不含 $ 但含 _{} 或 _{...} 或 \ 命令的 text 节点
    let nakedFormulaTexts = [];
    this._walkDoc(doc, (node, pos) => {
      if (node.type.name === "text") {
        stat.textNodes++;
        let t = node.text || "";
        for (let ch of t) {
          let cp = ch.codePointAt(0);
          if (cp === 0x24) stat.half++;
          else if (cp === 0xff04) stat.full++;
          else if (
            cp === 0xfe69 || // ﹩ small dollar
            cp === 0x1f4b2 || // 💲
            cp === 0x20ac
          ) {
            stat.otherDollarLike++;
          }
        }
        // 裸公式特征：含下划线、^{...}、\命令，或 A'_{...} 之类，且不含 $
        // 这些是「$ 被吞」后残留的典型形态，例如 Q_p / B'_{t-1} / p=(x,y)
        if (
          t.indexOf("$") < 0 &&
          (/[A-Za-z]_[A-Za-z0-9]/.test(t) ||
            /_\{/.test(t) ||
            /\^\{/.test(t) ||
            /[A-Za-z]'[_^\{]/.test(t) ||
            /\\[a-zA-Z]{2,}/.test(t)) &&
          nakedFormulaTexts.length < 40
        ) {
          nakedFormulaTexts.push({ pos, text: t });
        }
      } else if (node.type.name === "math_inline" || node.type.name === "math_display") {
        stat.mathNodes++;
      }
      return true;
    });

    push("  【全局普查】text节点=" + stat.textNodes + " math节点=" + stat.mathNodes);
    push(
      "    半角$ U+0024 出现 " +
        stat.half +
        " 次；全角＄ U+FF04 出现 " +
        stat.full +
        " 次；其它类$符号 " +
        stat.otherDollarLike +
        " 次",
    );

    push("");
    push("  【裸公式文本】（不含 $ 但疑似公式残留的 text 节点，前 40 个）:");
    if (!nakedFormulaTexts.length) {
      push("    （无）");
    } else {
      for (let n of nakedFormulaTexts) {
        push("    pos=" + n.pos + " " + JSON.stringify(this._short(n.text, 80)));
      }
    }

    push("");
    push("  【逐块结构】前 15 块，逐个 inline 子节点:");
    let blockIdx = 0;
    for (let block of doc.children) {
      if (blockIdx >= 15) {
        push("  ...（只显示前 15 块）");
        break;
      }
      push("  [" + blockIdx + "] <" + block.type.name + ">");
      this._walkInline(block, push, "      ");
      blockIdx++;
    }
  },

  _walkInline(node, push, indent) {
    if (node.isText) {
      let t = node.text || "";
      let hasHalf = t.indexOf("$") >= 0;
      let hasFull = t.indexOf("\uFF04") >= 0;
      // 列出所有非 ASCII 字符的码点，确认有没有隐藏变体
      let cps = [];
      for (let i = 0; i < t.length; i++) {
        let cp = t.codePointAt(i);
        if (cp > 127) {
          cps.push(
            JSON.stringify(t[i]) + "=U+" + cp.toString(16).toUpperCase(),
          );
          if (cps.length >= 16) {
            cps.push("…");
            break;
          }
        }
      }
      push(
        indent +
          "TEXT " +
          JSON.stringify(this._short(t, 60)) +
          "  [半角$:" +
          hasHalf +
          " 全角＄:" +
          hasFull +
          "]",
      );
      if (cps.length) {
        push(indent + "     码点: " + cps.join(" "));
      }
      return;
    }
    if (node.type.name === "math_inline" || node.type.name === "math_display") {
      push(
        indent +
          "<" +
          node.type.name +
          "> latex=" +
          JSON.stringify(this._short(node.textContent, 40)),
      );
      return;
    }
    if (node.childCount > 0 && node.type.name !== "paragraph" && node.type.name !== "heading") {
      // 对于列表/引用等容器，继续递归
      if (
        [
          "bulletList",
          "orderedList",
          "listItem",
          "blockquote",
          "highlight",
          "underline_annotation",
        ].includes(node.type.name)
      ) {
        for (let c of node.children) {
          this._walkInline(c, push, indent + "  ");
        }
        return;
      }
    }
    // 段落/标题：逐 inline 子节点
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      for (let c of node.children) {
        this._walkInline(c, push, indent + "  ");
      }
    }
  },

  _output(report) {
    let text = report.join("\n");
    // 1) 调试日志
    try {
      Zotero.debug(text);
    } catch (e) {
      /* ignore */
    }
    try {
      // 便于在错误控制台一眼看到
      Services.console.logStringMessage(text);
    } catch (e) {
      /* ignore */
    }

    // 2) 弹出窗口显示，方便复制
    this._showWindow(text);
  },

  _showWindow(text) {
    try {
      let win = Zotero.getMainWindow();
      let doc = win.document;
      let existing = doc.getElementById("editorprobe-window");
      if (existing) {
        existing.remove();
      }

      let panel = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      );
      panel.id = "editorprobe-window";
      panel.setAttribute(
        "style",
        [
          "position:fixed",
          "right:16px",
          "top:16px",
          "width:720px",
          "height:80vh",
          "z-index:99999",
          "background:#1e1e1e",
          "color:#d4d4d4",
          "border:1px solid #444",
          "border-radius:6px",
          "box-shadow:0 8px 32px rgba(0,0,0,.5)",
          "display:flex",
          "flex-direction:column",
          "font-family:monospace",
        ].join(";"),
      );

      let bar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      bar.setAttribute(
        "style",
        "display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid #444;",
      );
      let title = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      title.textContent = "Editor Probe 报告";
      bar.appendChild(title);

      let btnWrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      let copyBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      copyBtn.textContent = "复制全部";
      copyBtn.setAttribute("style", "margin-right:8px;");
      btnWrap.appendChild(copyBtn);

      let closeBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      closeBtn.textContent = "关闭";
      btnWrap.appendChild(closeBtn);
      bar.appendChild(btnWrap);
      panel.appendChild(bar);

      let ta = doc.createElementNS("http://www.w3.org/1999/xhtml", "textarea");
      ta.setAttribute(
        "style",
        "flex:1;width:100%;box-sizing:border-box;background:#1e1e1e;color:#d4d4d4;border:none;padding:10px;font-family:monospace;font-size:12px;resize:none;",
      );
      ta.value = text;
      panel.appendChild(ta);

      copyBtn.addEventListener("click", () => {
        ta.select();
        doc.execCommand("copy");
      });
      closeBtn.addEventListener("click", () => panel.remove());

      doc.documentElement.appendChild(panel);
      ta.focus();
    } catch (e) {
      // 兜底：用 alert
      try {
        Zotero.alert(null, "Editor Probe", text.slice(0, 4000));
      } catch (e2) {
        /* ignore */
      }
    }
  },

  /* ---------------- 工具函数 ---------------- */

  _safeKeys(obj) {
    try {
      return Object.keys(obj);
    } catch (e) {
      return ["<无法枚举>"];
    }
  },

  _describeDom(dom) {
    if (!dom) {
      return "<无>";
    }
    try {
      let tag = dom.tagName ? dom.tagName.toLowerCase() : "?";
      let id = dom.id ? "#" + dom.id : "";
      let cls = dom.className ? "." + String(dom.className).split(" ").join(".") : "";
      return tag + id + cls;
    } catch (e) {
      return "<无法描述>";
    }
  },

  _short(s, n) {
    if (s == null) {
      return String(s);
    }
    s = String(s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  },
};

/* 兼容某些 Zotero 版本在 bootstrap 内直接引用全局 */
if (typeof globalThis !== "undefined") {
  globalThis.EditorProbe = EditorProbe;
}