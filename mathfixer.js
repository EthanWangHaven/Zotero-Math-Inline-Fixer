/* global Zotero, Services, Components */
"use strict";

/**
 * Zotero Math Inline Fixer - mathfixer.js
 *
 * 功能：把笔记中被粘贴进来、却未被解析成公式的「单字符行内公式」$X$ 修复成
 *      真正的 math_inline 节点。
 *
 * 背景：
 *   Zotero 的笔记编辑器（ProseMirror）只在「手动输入」时通过 input rule 解析 $...$，
 *   粘贴（paste）时完全不解析 Markdown / 数学（官方原话：
 *   "Zotero doesn't parse Markdown or math on paste right now."）。
 *   而单字符 $f$ 因为要防误触（例如 "$400 to $500"）最容易被漏掉。
 *
 * 做法：
 *   1. 拿到编辑器 ProseMirror 的 EditorView / EditorState / schema；
 *   2. 扫描文档所有 text 节点，用正则找出 $X$（X 为单个字符）；
 *   3. 用 transaction 把这几个字符替换为 math_inline 节点（内联公式），
 *      不碰 math_display、不碰 codeBlock、不碰已经渲染好的 math_inline。
 */

var MathFixer = {
  id: null,
  version: null,
  rootURI: null,
  _windows: new Set(),

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    Zotero.MathFixer = this;
    Zotero.debug("[MathFixer] init v" + version + "，开始监听编辑器");
    this.startAutoAttach();
  },

  uninit() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // 尽力清理所有打开编辑器 iframe 上的监听与标志，
    // 否则「禁用 → 启用」或升级后旧标志会阻止重新挂载。
    try {
      let instances = (Zotero.Notes && Zotero.Notes._editorInstances) || [];
      for (let e of instances) {
        try {
          if (e && e._iframeWindow && !Components.utils.isDeadWrapper(e._iframeWindow)) {
            this._teardownListeners(e._iframeWindow.wrappedJSObject);
          }
        } catch (err) {
          /* ignore */
        }
      }
    } catch (e) {
      /* ignore */
    }
    delete Zotero.MathFixer;
  },

  /** 拆除某个 iframe 上由本插件挂载的全部监听与标志（兼容旧版本残留） */
  _teardownListeners(wj) {
    if (!wj) {
      return;
    }
    try {
      if (wj.__mathFixerTimerId) {
        wj.clearInterval(wj.__mathFixerTimerId);
      }
    } catch (e) {
      /* ignore */
    }
    try {
      let doc = wj.document;
      if (wj.__mathFixerOnPaste) {
        doc.removeEventListener("paste", wj.__mathFixerOnPaste, true);
        let pm = wj.__mathFixerPmDom;
        if (pm) {
          try {
            pm.removeEventListener("paste", wj.__mathFixerOnPaste, true);
          } catch (e2) {
            /* ignore */
          }
        }
      }
      if (wj.__mathFixerOnInput) {
        doc.removeEventListener("keyup", wj.__mathFixerOnInput, true);
        doc.removeEventListener("input", wj.__mathFixerOnInput, true);
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (wj.__mathFixerObserver) {
        wj.__mathFixerObserver.disconnect();
      }
    } catch (e) {
      /* ignore */
    }
    try {
      delete wj.__mathFixerTimerId;
      delete wj.__mathFixerOnPaste;
      delete wj.__mathFixerOnInput;
      delete wj.__mathFixerPmDom;
      delete wj.__mathFixerObserver;
      delete wj.__mathFixerAttached;
      delete wj.__mathFixerAttachedBy;
      delete wj.__mathFixerBusy;
    } catch (e) {
      /* ignore */
    }
  },

  /* ======================= 窗口注入 ======================= */

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

    // 工具菜单入口
    let toolsPopup =
      doc.getElementById("menu_ToolsPopup") || doc.getElementById("menu_toolsPopup");
    if (toolsPopup && !toolsPopup.querySelector("#mathfixer-tools-menuitem")) {
      try {
        let mi = doc.createXULElement
          ? doc.createXULElement("menuitem")
          : doc.createElement("menuitem");
        mi.id = "mathfixer-tools-menuitem";
        mi.setAttribute("label", "Math Fixer");
        mi.addEventListener("command", () => this.fixActiveEditor(win, true));
        toolsPopup.appendChild(mi);
      } catch (e) {
        /* ignore */
      }
    }

    // 快捷键 Ctrl+Shift+M
    // event.repeat 过滤系统按键自动重复；800ms 防抖兜底，
    // 避免按住按键或多次触发时连环弹窗。
    let onKeyDown = (event) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        (event.key === "M" || event.key === "m")
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) {
          return;
        }
        let now = Date.now();
        if (now - (win.__mathFixerLastManualFix || 0) < 800) {
          return;
        }
        win.__mathFixerLastManualFix = now;
        this.fixActiveEditor(win, true);
      }
    };
    win.addEventListener("keydown", onKeyDown, true);

    this._windows.add(win);
    win.__mathFixerKeyDown = onKeyDown;
  },

  removeFromWindow(win) {
    if (!win) {
      return;
    }
    try {
      let doc = win.document;
      doc
        .querySelectorAll("#mathfixer-tools-menuitem")
        .forEach((el) => el.remove());
    } catch (e) {
      /* ignore */
    }
    if (win.__mathFixerKeyDown) {
      win.removeEventListener("keydown", win.__mathFixerKeyDown, true);
      delete win.__mathFixerKeyDown;
    }
    this._windows.delete(win);
  },

  /* ======================= 编辑器获取 ======================= */

  /** 找到当前活动的笔记编辑器实例 */
  findActiveEditor() {
    try {
      let instances = Zotero.Notes._editorInstances || [];
      for (let e of instances) {
        try {
          if (
            e &&
            e._iframeWindow &&
            !Components.utils.isDeadWrapper(e._iframeWindow)
          ) {
            return e;
          }
        } catch (err) {
          /* ignore */
        }
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  },

  /** 拿到编辑器核心 { view, state, schema }（跨 realm 安全） */
  getEditorCore(editor) {
    try {
      let wj = editor._iframeWindow.wrappedJSObject;
      if (!wj) {
        return null;
      }
      let inst = wj._currentEditorInstance;
      if (!inst || !inst._editorCore) {
        return null;
      }
      let core = inst._editorCore;
      if (!core.view) {
        return null;
      }
      return core;
    } catch (e) {
      return null;
    }
  },

  /** 非阻塞提示：角落弹出，点击或超时自动消失，不抢焦点不排队 */
  _notifyTransient(message) {
    try {
      let pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Math Fixer");
      pw.addLines(message);
      pw.show();
      pw.startCloseTimer(2500);
    } catch (e) {
      try {
        Zotero.alert(null, "Math Fixer", message);
      } catch (e2) {
        /* ignore */
      }
    }
  },

  /* ======================= 核心修复逻辑 ======================= */

  /**
   * 修复指定编辑器中的单字符行内公式。
   * @param {object} editor Zotero.EditorInstance
   * @param {boolean} notify 是否弹提示
   * @returns {number} 修复数量
   */
  fixEditor(editor, notify) {
    let core = this.getEditorCore(editor);
    if (!core) {
      if (notify) {
        this._notifyTransient("未找到可用的笔记编辑器，请先打开一个笔记");
      }
      return 0;
    }

    let view = core.view;
    let state = view.state;
    let schema = state.schema;

    // 确认 schema 里有 math_inline
    if (!schema.nodes.math_inline) {
      if (notify) {
        Zotero.alert(null, "Math Fixer", "当前编辑器 schema 中没有 math_inline 节点，无法修复。");
      }
      return 0;
    }

    // 收集所有需要修复的位置：{ from, to, latex }
    // 注意：这里 from/to 是「整段 $X$ 在文档中的绝对位置」
    let targets = [];
    this._collectTargets(state.doc, targets);

    if (!targets.length) {
      if (notify) {
        this._notifyTransient("没有发现需要修复的公式");
      }
      return 0;
    }

    // 统计两类公式数量：单字符 vs 坐标/多字符（含 $$...$$ 块）
    let nSingle = 0;
    let nCoord = 0;
    for (let t of targets) {
      if (t.kind === "single") {
        nSingle++;
      } else {
        nCoord++;
      }
    }

    // 从后往前替换，避免位置偏移
    targets.sort((a, b) => b.from - a.from);

    let tr = state.tr;
    let mathType = schema.nodes.math_inline;
    for (let t of targets) {
      let node = mathType.create({}, schema.text(t.latex));
      tr.replaceWith(t.from, t.to, node);
    }

    // 一次性提交，作为单个可撤销的编辑。
    // 期间置 busy 标记，避免 MutationObserver 因我们自己的改动再次触发。
    try {
      editor._iframeWindow.wrappedJSObject.__mathFixerBusy = true;
    } catch (e) {
      /* ignore */
    }
    try {
      view.dispatch(tr.setMeta("addToHistory", true));
    } catch (e) {
      view.dispatch(tr);
    }
    try {
      let wj2 = editor._iframeWindow.wrappedJSObject;
      wj2.setTimeout(
        Components.utils.exportFunction(
          function () {
            wj2.__mathFixerBusy = false;
          },
          wj2,
          { defineAs: "__mathFixerUnbusy" },
        ),
        60,
      );
    } catch (e) {
      /* ignore */
    }

    // 焦点还给编辑器
    try {
      editor._iframeWindow.wrappedJSObject.focus();
    } catch (e) {
      /* ignore */
    }

    if (notify) {
      let lines = ["共修复 " + targets.length + " 处公式："];
      if (nSingle > 0) {
        lines.push("  单字符行内公式：" + nSingle + " 处");
      }
      if (nCoord > 0) {
        lines.push("  坐标/多字符公式：" + nCoord + " 处");
      }
      Zotero.alert(null, "Math Fixer", lines.join("\n"));
    }
    return targets.length;
  },

  /**
   * 扫描文档，收集所有「需要修复的、粘贴后未渲染的公式」。
   *
   * 支持三种形态：
   *   A. 独占一个段落的 $$...$$（单行）——粘贴时被 Zotero 当成块级公式
   *      却未渲染，整段就是一个 text 节点 `$$ (11,20) $$`。
   *      修复：把整个段落内容替换为一个 math_inline（行内公式）。
   *   B. 行内的 $X$（X 为单个非空白、非 $ 字符）——单字符公式。
   *   C. 行内的 $(...)$ 等多字符公式（内容只含"数学安全字符"，不含中文）。
   *
   * 规则尽量保守，避免误伤：
   *   - 只处理 text 节点（不在 math 节点、image、citation 里）
   *   - 跳过 codeBlock 内部的文本
   *   - B/C 的前后不与其他 $ 相连（不是 $$ 或 $$$）
   *   - C 的内容禁止含中文/CJK，禁止含换行
   *
   * 注意：这里不能使用 doc.descendants + node.isText。
   *   在 Zotero 的跨 realm（Xray wrapper / iframe）环境下，
   *   descendants 遍历中 `node.isText` 会失效，导致遍历到 0 个文本节点，
   *   正则永远命中 0。因此改用手工递归 + node.type.name === "text"。
   */
  _collectTargets(doc, out) {
    // 单字符：$X$（X 为单个非空白、非 $ 字符）
    let reSingle = /(?<!\$)\$([^\s$])\$(?!\$)/g;
    // 多字符行内：$(内容)$，内容只允许"数学安全字符"，不含 $、不含换行
    // 典型：$(11,20)$、$(x,y)$、$t-1$、$a_{i}$ 等
    let reInline = /(?<!\$)\$([^\s$][^$\n]*[^\s$])\$(?!\$)/g;

    // 判断内容是否为「数学安全表达式」：不含 CJK、不含全角标点
    let isSafeMath = (s) => {
      if (!s || s.indexOf("\n") >= 0) {
        return false;
      }
      // 只允许 ASCII 可见字符里的数学常见符号
      // 字母数字 _ ^ { } ( ) [ ] , . + - * / = \ ' | 空格
      if (!/^[A-Za-z0-9_{}^()[\],.+\-*/=\\'\s|]+$/.test(s)) {
        return false;
      }
      // 必须至少含一个字母/数字，避免匹配 $$、$ $、$,$ 之类
      if (!/[A-Za-z0-9]/.test(s)) {
        return false;
      }
      return true;
    };

    let visitChildren = (node, contentStart, inCode) => {
      let offset = 0;
      for (let i = 0; i < node.childCount; i++) {
        let child = node.child(i);
        let childPos = contentStart + offset;
        let name = child.type.name;

        if (name === "codeBlock") {
          // 跳过整个 codeBlock 的内容
        } else if (name === "text") {
          if (!inCode) {
            let text = child.text || "";
            if (text.indexOf("$") >= 0) {
              scanTextNode(child, childPos, text);
            }
          }
        } else if (name === "paragraph") {
          // 规则 A：整段只有一个 text 节点，且形如 $$...$$（单行）
          if (
            child.childCount === 1 &&
            child.child(0).type.name === "text"
          ) {
            let inner = child.child(0).text || "";
            let mA = /^\s*\$\$\s*([^$\n]+?)\s*\$\$\s*$/.exec(inner);
            if (mA && isSafeMath(mA[1])) {
              // 替换范围 = 段落内容（从 childPos+1 到末尾）
              let from = childPos + 1;
              let to = childPos + 1 + inner.length;
              out.push({ from, to, latex: mA[1], kind: "coord" });
              // 该段落已整体处理，不再递归其内部
              offset += child.nodeSize;
              continue;
            }
          }
          // 普通段落：进去扫行内公式
          if (child.childCount > 0) {
            visitChildren(child, childPos + 1, inCode);
          }
        } else if (child.childCount > 0) {
          // 其它非叶子节点：内容起点 = childPos + 1
          visitChildren(child, childPos + 1, inCode);
        }

        offset += child.nodeSize;
      }
    };

    // 扫描单个 text 节点内的 $...$（规则 B / C），并去重避免单字符被多字符重复匹配
    let scanTextNode = (node, nodePos, text) => {
      let consumed = []; // 记录已被匹配的字符区间，避免重叠
      let takenBy = (s, e) => consumed.some((c) => !(e <= c.s || s >= c.e));

      // 先用"多字符行内"匹配，再用"单字符"补齐未覆盖的部分
      let tryMatch = (re, allowSingle) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          let s = m.index;
          let e = m.index + m[0].length;
          let content = m[1];
          if (takenBy(s, e)) {
            continue;
          }
          if (!allowSingle && content.length === 1) {
            continue; // 多字符规则不处理单字符，交给单字符规则
          }
          if (!isSafeMath(content)) {
            continue;
          }
          consumed.push({ s, e });
          out.push({
            from: nodePos + s,
            to: nodePos + e,
            latex: content,
            kind: content.length === 1 ? "single" : "coord",
          });
        }
      };

      tryMatch(reInline, false);
      tryMatch(reSingle, true);
    };

    visitChildren(doc, 0, false);
  },

  /* ======================= 自动监听粘贴 ======================= */

  /**
   * 给编辑器挂上 paste 监听（幂等）。
   * 因为编辑器在 iframe 里，要在 iframe 的 document 上挂。
   */
  attachPasteListener(editor) {
    let core = this.getEditorCore(editor);
    if (!core) {
      return false;
    }
    let wj;
    try {
      wj = editor._iframeWindow.wrappedJSObject;
    } catch (e) {
      return false;
    }
    if (!wj) {
      return false;
    }
    // 当前版本已挂载：跳过
    if (wj.__mathFixerAttached && wj.__mathFixerAttachedBy === this.version) {
      return true;
    }
    // 由旧版本挂载过（升级场景）：先拆旧监听与标志，再重新挂载
    if (wj.__mathFixerAttached) {
      Zotero.debug(
        "[MathFixer] 发现旧版本监听残留（attachedBy=" +
          (wj.__mathFixerAttachedBy || "未知") + "），拆除后重挂",
      );
      this._teardownListeners(wj);
    }

    let outer = this;

    // 在一次「触发」后，连续扫描若干轮，把该期间内落地的所有公式
    // （单字符 / 坐标 / $$块）都修复掉。跨 realm 下递归引用 exportFunction
    // 的自身不可靠，因此用「外层 setInterval 驱动 + 内层只做一次扫描」的朴素结构。
    let startBurst = function (tag) {
      Zotero.debug("[MathFixer] 触发=" + tag + "，准备扫描");
      try {
        wj.setTimeout(
          Components.utils.exportFunction(
            function () {
              let rounds = 0;
              let idle = 0;
              let lastTotal = 0;
              try {
                wj.clearInterval(wj.__mathFixerTimerId);
              } catch (e) {
                /* ignore */
              }
              let step = Components.utils.exportFunction(
                function () {
                  rounds++;
                  let n = 0;
                  try {
                    n = outer.fixEditor(editor, false) || 0;
                  } catch (e) {
                    Zotero.debug(
                      "[MathFixer][" + tag + "] 第 " + rounds + " 轮扫描出错: " +
                        (e && e.message ? e.message : e),
                    );
                  }
                  if (n > 0) {
                    lastTotal += n;
                    idle = 0;
                    Zotero.debug("[MathFixer][" + tag + "] 第 " + rounds + " 轮修复 " + n + " 处");
                  } else {
                    idle++;
                  }
                  if (rounds >= 30 || idle >= 3) {
                    try {
                      wj.clearInterval(wj.__mathFixerTimerId);
                    } catch (e) {
                      /* ignore */
                    }
                    wj.__mathFixerTimerId = null;
                    Zotero.debug("[MathFixer][" + tag + "] 结束，共 " + lastTotal + " 处");
                  }
                },
                wj,
                { defineAs: "__mathFixerStep" },
              );
              wj.__mathFixerTimerId = wj.setInterval(step, 90);
            },
            wj,
            { defineAs: "__mathFixerStart" },
          ),
          150,
        );
      } catch (e) {
        Zotero.debug(
          "[MathFixer][" + tag + "] 定时器调用失败: " + (e && e.message ? e.message : e),
        );
      }
    };

    let doc;
    try {
      doc = wj.document;
    } catch (e) {
      doc = null;
    }
    if (!doc) {
      return false;
    }
    // ProseMirror 真正承载内容的 DOM 节点（真正的变动发生在这里，
    // 而不是外层 document.body）。跨 realm 环境下通过 core.view.dom 拿到。
    let pmDom = null;
    try {
      pmDom = core.view && core.view.dom ? core.view.dom : null;
    } catch (e) {
      pmDom = null;
    }

    Zotero.debug(
      "[MathFixer] 挂载目标：doc=" + (doc.URL || "?") +
        "，pmDom=" + (pmDom ? "." + pmDom.className : "未找到"),
    );

    // 触发 1：paste（捕获阶段）。同时挂在 document 与 ProseMirror 节点上，
    // 避免事件在某些嵌套结构下不冒泡到 document。
    let pasteHandler = function () {
      startBurst("paste");
    };
    let exportedPaste = Components.utils.exportFunction(pasteHandler, wj, {
      defineAs: "__mathFixerPasteHandler",
    });
    doc.addEventListener("paste", exportedPaste, true);
    if (pmDom) {
      try {
        pmDom.addEventListener("paste", exportedPaste, true);
      } catch (e) {
        /* ignore */
      }
    }
    wj.__mathFixerPmDom = pmDom || null;

    // 触发 1b：keyup / input —— 兜底。即使 paste 被编辑器内部吞掉，
    // 只要内容发生改动，input/keyup 仍会到达。用同一 cooldown 去重。
    let exportedInput = Components.utils.exportFunction(
      function () {
        startBurst("input");
      },
      wj,
      { defineAs: "__mathFixerInputHandler" },
    );
    doc.addEventListener("keyup", exportedInput, true);
    doc.addEventListener("input", exportedInput, true);

    wj.__mathFixerOnPaste = exportedPaste;
    wj.__mathFixerOnInput = exportedInput;

    // 触发 2：MutationObserver —— 兜底。即使上面事件都没捕获，
    // 只要 ProseMirror 把内容插入 DOM，就会触发这里。
    // 优先观察 ProseMirror 节点本身（变动就发生在它内部）。
    // 用防抖 + 冷却，避免高频 DOM 变动导致 burst 堆积。
    let lastBurst = 0;
    let debounceTimer = null;
    let onMutate = function () {
      if (wj.__mathFixerBusy) {
        return; // 自己刚做的修复改动，忽略
      }
      if (debounceTimer) {
        wj.clearTimeout(debounceTimer);
      }
      debounceTimer = wj.setTimeout(
        Components.utils.exportFunction(
          function () {
            debounceTimer = null;
            let now = Date.now();
            if (now - lastBurst < 200) {
              return; // 冷却中
            }
            lastBurst = now;
            startBurst("mutation");
          },
          wj,
          { defineAs: "__mathFixerDebounced" },
        ),
        200,
      );
    };
    let exportedMutate = Components.utils.exportFunction(onMutate, wj, {
      defineAs: "__mathFixerMutateHandler",
    });
    let observer = new wj.MutationObserver(exportedMutate);
    observer.observe(pmDom || doc.body || doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    wj.__mathFixerObserver = observer;

    wj.__mathFixerAttached = true;
    wj.__mathFixerAttachedBy = this.version;
    Zotero.debug("[MathFixer] 已在编辑器 iframe 挂上 paste/input + MutationObserver 监听");
    return true;
  },

  /** 对当前活动编辑器执行修复（手动入口） */
  fixActiveEditor(win, notify) {
    let editor = this.findActiveEditor();
    if (!editor) {
      if (notify) {
        this._notifyTransient("未找到打开的笔记编辑器，请先打开一个笔记");
      }
      return;
    }
    this.fixEditor(editor, notify);
  },

  /* ======================= 定期扫描新编辑器 ======================= */

  /** 周期性地为所有活动编辑器挂上 paste 监听（处理新打开的笔记） */
  startAutoAttach() {
    if (this._timer) {
      return;
    }
    let loggedOnce = false;
    this._timer = setInterval(() => {
      try {
        let instances = (Zotero.Notes && Zotero.Notes._editorInstances) || [];
        if (!loggedOnce) {
          Zotero.debug("[MathFixer] 轮询中，当前编辑器实例数=" + instances.length);
        }
        for (let e of instances) {
          try {
            if (e && e._iframeWindow && !Components.utils.isDeadWrapper(e._iframeWindow)) {
              let ok = this.attachPasteListener(e);
              if (ok && !loggedOnce) {
                loggedOnce = true;
                Zotero.debug("[MathFixer] 已完成首次 paste 监听挂载");
              }
            }
          } catch (err) {
            Zotero.debug(
              "[MathFixer] 挂载单个编辑器出错: " + (err && err.message ? err.message : err),
            );
          }
        }
      } catch (e) {
        Zotero.debug("[MathFixer] startAutoAttach 轮询出错: " + (e && e.message ? e.message : e));
      }
    }, 1500);
  },
};