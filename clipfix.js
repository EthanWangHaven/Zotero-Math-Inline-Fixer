/* global Zotero, Services, Components */
"use strict";

/**
 * Zotero Math Inline Fixer - clipfix.js（笔记格式转换窗口 / Clip Fixer）
 *
 * 架构（1.3.0 起彻底放弃自动拦截）：
 *   过去在 paste 事件内做原生剪贴板操作导致 Gecko 原生崩溃（1.2.1/1.2.2
 *   实测进程退出），故本版本改为「独立转换窗口」方案——插件完全不监听
 *   paste 事件、不在任何事件派发期间读写系统剪贴板：
 *
 *     AI 内容 → Ctrl+V 粘贴进转换窗口输入框（浏览器原生行为，插件零参与）
 *            → 窗口内实时预览转换结果（纯 JS，复用 mdToZotero 引擎）
 *            → 点「复制」→ 写系统剪贴板（普通按钮回调上下文，
 *              与 Zotero 自家 copyTextToClipboard 同路径，安全）
 *            → 笔记里 Ctrl+V（原生粘贴，Better Notes 自动 Markdown 转换）
 *            → mathfixer.js 渲染修复兜底
 *
 * 与 mathfixer.js（粘贴后节点级兜底）职责分离，互不依赖。
 */

var MathClipFixer = {
  id: null,
  version: null,
  rootURI: null,
  _windows: new Set(),
  _panelWindow: null,

  // 面板状态记忆（独立于 extensions.zotero 分支，不参与同步）
  _PREF_TEXT: "extensions.mathfixer.clipPanelText",
  _PREF_GEOM: "extensions.mathfixer.clipPanelGeom",
  _PREF_AUTOCOPY: "extensions.mathfixer.clipPanelAutoCopy",
  _PREF_CAP_EXITED: "extensions.mathfixer.capsuleExited",
  _PREF_CAP_COLOR: "extensions.mathfixer.capsuleColor",
  _PREF_CAP_ONTOP: "extensions.mathfixer.capsuleOnTop",
  _PREF_CAP_POS: "extensions.mathfixer.capsulePos",
  _PREF_CAP_MODE: "extensions.mathfixer.capsuleMode",

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    Zotero.MathClipFixer = this;
    Zotero.debug("[MathFixer][Clip] init v" + version + "（转换窗口模式）");
    // 自检：探测剪贴板读取链路（结果写调试日志，不影响功能）
    try {
      let probe = this.readClipboardText();
      Zotero.debug(
        "[MathFixer][Clip] 剪贴板读取自检: " +
          (probe == null ? "失败（窗口复制按钮不受影响）" : "成功（" + probe.length + " 字符）"),
      );
    } catch (e) {
      Zotero.debug("[MathFixer][Clip] 剪贴板读取自检出错: " + (e && e.message ? e.message : e));
    }
    // 自愈轮询：主窗口 DOM 晚于插件就绪时，定时补挂工具栏图标与胶囊
    this.startSelfHeal();
  },

  /** 自愈轮询：每 2s 检查一次胶囊是否在位，缺失则补挂 */
  startSelfHeal() {
    if (this._healTimer) {
      return;
    }
    let logged = false;
    this._healTimer = setInterval(() => {
      try {
        for (let win of Zotero.getMainWindows()) {
          this.addToWindow(win);
        }
        let win = Zotero.getMainWindow();
        if (win && win.document) {
          let hasCap = !!win.document.getElementById("mathfixer-capsule");
          if (hasCap || logged) {
            return;
          }
          logged = true;
          Zotero.debug(
            "[MathFixer][Clip] 自愈检查：capsule=" + hasCap +
              "（DOM 就绪后自动补挂）",
          );
        }
      } catch (e) {
        /* ignore */
      }
    }, 2000);
  },

  uninit() {
    this.closePanel();
    delete Zotero.MathClipFixer;
  },

  /* ======================= 转换引擎（纯函数，可独立测试） ======================= */

  // 占位符：私有区字符，避免与正文冲突
  _PH_OPEN: "\ue000",
  _PH_CLOSE: "\ue001",
  _PH_RE: /\ue000(\d+)\ue001/,
  _ASCII_PUNCT: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",

  /** 公式分隔符规范化：`$ x $` → `$x$`；单独成行的 `$` → `$$` */
  _fixMathDelimiters(text) {
    text = text.replace(
      /(?<!\$)\$(?!\$)[ \t]+([^\n$]+?)[ \t]+(?<!\$)\$(?!\$)/g,
      "$$$1$$",
    );
    let out = [];
    for (let line of text.split("\n")) {
      if (/^\s*\$\s*$/.test(line)) {
        out.push(line.slice(0, line.indexOf("$")) + "$$");
      } else {
        out.push(line);
      }
    }
    return out.join("\n");
  },

  /**
   * 行内代码里包着的 $...$ 公式：去反引号按公式处理（返回不带反引号），
   * 否则粘贴后显示为原始 $Q_{ego}$ 文本。代码块整体不动；无空格或含
   * 数学研究征字符才认定是公式（避免误伤 `cost $5 and $10` 这类文本）
   */
  _unwrapCodeMathSpans(text) {
    const PH = this._PH_OPEN;
    const PHC = this._PH_CLOSE;
    let blocks = [];
    text = text.replace(/```[^\n]*\n.*?(?:\n)?```/gs, function (m0) {
      blocks.push(m0);
      return PH + "B" + (blocks.length - 1) + PHC;
    });
    text = text.replace(/`([^`\n]+)`/g, function (m0, m1) {
      let inner = m1;
      if (inner.indexOf("$") < 0) {
        return m0; // 无 $，普通代码原样保留
      }
      let changed = false;
      let nw = inner.replace(/\$([^$\n]{1,80})\$/g, function (mm0, c) {
        if (c.indexOf(" ") < 0 || /[_^{}\\]/.test(c)) {
          changed = true;
          return "\\(" + c + "\\)";
        }
        return mm0;
      });
      // 有变化 → 返回去反引号后的公式形态（后续被 \(...\) 规则接管）；
      // 无变化 → 原样保留（含反引号，按普通行内代码）
      return changed ? nw : m0;
    });
    for (let i = 0; i < blocks.length; i++) {
      text = text.split(PH + "B" + i + PHC).join(blocks[i]);
    }
    return text;
  },

  /**
   * 跨行 \(...\)/\[...\] 的内容是否像公式块：含环境或换行分隔符 \\ 即可
   * 认定；含中文叙述且无环境/\\\\ 的视为误配（防孤立 \( 吞大段正文）
   */
  _mathLikeBlock(inner) {
    if (inner.indexOf(this._PH_OPEN) >= 0) {
      return false; // 吞进了已提取的公式/代码 → 必然误配
    }
    if (inner.indexOf("\\begin{") >= 0 || inner.indexOf("\\\\") >= 0) {
      return true;
    }
    return !/[\u4e00-\u9fff]/.test(inner);
  },

  /** 把公式、代码块、行内代码替换为占位符；store 为 {kind, text, latex, display, info, fenced} */
  _protect(text) {
    const self = this;
    const PH = this._PH_OPEN;
    const PHC = this._PH_CLOSE;
    let store = [];
    let add = function (kind, whole, latex, display, info, fenced) {
      store.push({
        kind: kind,
        text: whole,
        latex: latex === undefined ? null : latex,
        display: !!display,
        info: info || "",
        fenced: !!fenced,
      });
      return PH + (store.length - 1) + PHC;
    };

    // 代码块 ```...```（内容原样保留；info 记录语言标记，输出时还原）
    text = text.replace(/```([^\n]*)\n(.*?)(?:\n)?```/gs, function (m0, info, body) {
      return add("code", body, undefined, false, info, true);
    });
    // 行内代码里包着的 $...$ 公式 → 解包为公式
    text = this._unwrapCodeMathSpans(text);
    // 行内代码
    text = text.replace(/`([^`\n]+)`/g, function (m0, m1) {
      return add("code", m1, undefined, false, "", false);
    });
    // 公式分隔符规范化
    text = this._fixMathDelimiters(text);
    // 公式：$$...$$（可跨行，块级）
    text = text.replace(/\$\$(.+?)\$\$/gs, function (m0, m1) {
      return add("math", m0, m1, true);
    });
    // 公式：\[...\]（块级）——单行直取；跨行需像公式块（防孤立 \[ 吞正文）
    text = text.replace(/\\\[([^\n]+?)\\\]/g, function (m0, m1) {
      return add("math", m0, m1, true);
    });
    text = text.replace(/\\\[(.+?)\\\]/gs, function (m0, m1) {
      return self._mathLikeBlock(m1) ? add("math", m0, m1, true) : m0;
    });
    // 公式：$...$（单行，内容不含 $、首尾不为空格）
    text = text.replace(/(?<!\\)\$([^\s$](?:[^$\n]*[^\s$])?)\$/g, function (m0, m1) {
      return add("math", m0, m1, false);
    });
    // 公式：\(...\)（行内）——单行直取；跨行需像公式块
    text = text.replace(/\\\(([^\n]+?)\\\)/g, function (m0, m1) {
      return add("math", m0, m1, false);
    });
    text = text.replace(/\\\((.+?)\\\)/gs, function (m0, m1) {
      return self._mathLikeBlock(m1) ? add("math", m0, m1, false) : m0;
    });
    return [text, store];
  },

  /**
   * 清洗 AI 生成 LaTeX 的常见噪声（MdClear _sanitize_latex 的移植）。
   * toMathrm=false 时不做 \operatorname→\mathrm 转换（KaTeX 支持前者）
   */
  _sanitizeLatex(latex, toMathrm) {
    // 先保护 \\\\（对齐/换行分隔符）：下方 "\ " → 空格 的替换会把
    // "\\\u0020"（行分隔符后跟空格）塌缩成 "\u0020\..."，破坏 aligned 环境
    const DBL = "\ue006";
    latex = latex.split("\\\\").join(DBL);
    // Unicode 变体字符还原（聊天窗口/Office 复制常见的不可见差异）
    const dashes = [
      ["\u2011", "-"], // 非断行连字符
      ["\u2212", "-"], // 数学减号
      ["\u2013", "-"], // en dash
      ["\u2014", "-"], // em dash
    ];
    for (let p of dashes) {
      latex = latex.split(p[0]).join(p[1]);
    }
    // \, \; \: \! \  等显式空格命令：Better Notes(KaTeX) 支持但部分
    // 来源会异常展开；与 MdClear 保持一致统一还原为普通空格
    latex = latex.split("\\!").join("");
    latex = latex.split("\\ ").join(" ");
    latex = latex.replace(/\\[,;:]/g, " ");
    // \kern1.5pt / {\kern1.5pt}：pandoc 生态常见间距，转成空格
    latex = latex.replace(/\{?\\kern\s*[-\d.]+(?:pt|em|cm|mm|ex|bp|mu)\}?/g, " ");
    latex = latex.split(DBL).join("\\\\");
    if (toMathrm) {
      latex = latex.split("\\operatorname").join("\\mathrm");
    }
    return latex;
  },

  /** LaTeX → Zotero Better Notes（KaTeX）兼容写法（MdClear _zotero_latex 的移植） */
  _zoteroLatex(latex) {
    latex = this._sanitizeLatex(latex, false);
    // \left/\right 修饰去除：\left\{ → \{（保留定界符前的反斜杠）、\left( → (
    latex = latex.replace(/\\left(\\?[({\[])/g, "$1");
    latex = latex.replace(/\\right(\\?[)}\]])/g, "$1");
    latex = latex.replace(/\\left\.|\\right\./g, "");
    // 嵌套 \operatorname 折叠
    let prev = null;
    while (prev !== latex) {
      prev = latex;
      latex = latex.replace(
        /\\operatorname\{\\operatorname\{([^{}]*)\}\}/g,
        "\\operatorname{$1}",
      );
      latex = latex.replace(
        /\\operatorname\{\(\\operatorname\{([^{}]*)\}\)\}/g,
        "\\operatorname{$1}",
      );
    }
    // 裸多字母函数名 → \operatorname{...}（排除反斜杠命令与已有容器内部）
    latex = latex.replace(/(?<![\\A-Za-z{])([A-Za-z]{2,})\(/g, "\\operatorname{$1}(");
    // 下标/上标不得转义（KaTeX 中 \_ 是字面下划线，不是下标）
    latex = latex.split("\\_").join("_");
    latex = latex.split("\\^").join("^");
    return latex.trim();
  },

  /** 删除独立的分隔线行（---、——— 等）；围栏代码块内的内容不动 */
  _stripHrLines(text) {
    let out = [];
    let inCode = false;
    for (let line of text.split("\n")) {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        out.push(line);
        continue;
      }
      let s = line.trim();
      if (
        !inCode &&
        s &&
        /^[\s\-*_—－─–−=~▪•]+$/.test(s) &&
        (s.match(/[\-—－─–−*_]/g) || []).length >= 3
      ) {
        continue; // 分隔线行，删除
      }
      out.push(line);
    }
    return out.join("\n");
  },

  /**
   * 行内 $...$ 公式边界为标点且紧贴文字的一侧补空格。
   * Better Notes（markdown-it-katex）按 CommonMark flanking 规则判断 $
   * 配对——公式边界是标点（如 $O(N)$ 的 `)`）且另一侧紧贴文字（如
   * `大小`）时，闭合 $ 判定失败，会把后续一段正文吞进公式。`\` 开头的
   * 命令（$\ell$…）实测可正常配对，保持无空格不动。
   */
  _fixMathFlank(res) {
    const punct = this._ASCII_PUNCT;
    let isPunct = function (c) {
      return !!c && punct.indexOf(c) >= 0;
    };
    let wordish = function (c) {
      return !!c && !/\s/.test(c) && !isPunct(c);
    };
    let out = [];
    let i = 0;
    let n = res.length;
    while (i < n) {
      let c = res[i];
      if (c !== "$") {
        out.push(c);
        i++;
        continue;
      }
      if (i && res[i - 1] === "\\") {
        // 转义 \$，按普通文本
        out.push(c);
        i++;
        continue;
      }
      if (i + 1 < n && res[i + 1] === "$") {
        // $$ 块整体跳过
        let j2 = res.indexOf("$$", i + 2);
        if (j2 === -1) {
          out.push(res.slice(i));
          break;
        }
        out.push(res.slice(i, j2 + 2));
        i = j2 + 2;
        continue;
      }
      let j = res.indexOf("$", i + 1);
      let content = j === -1 ? "" : res.slice(i + 1, j);
      // 校验为合法行内公式形态（同行、非空、首尾无空格，与 _protect 一致）
      if (
        j === -1 ||
        content.indexOf("\n") >= 0 ||
        !content ||
        /^\s/.test(content) ||
        /\s$/.test(content)
      ) {
        out.push(c);
        i++;
        continue;
      }
      let prev = i ? res[i - 1] : "";
      let nxt = j + 1 < n ? res[j + 1] : "";
      // 开头为标点且前方紧贴文字 → 前补空格（`\` 例外，实测可配对）
      if (isPunct(content[0]) && content[0] !== "\\" && wordish(prev)) {
        out.push(" ");
      }
      out.push(res.slice(i, j + 1));
      // 结尾为标点且后方紧贴文字 → 后补空格
      if (isPunct(content[content.length - 1]) && wordish(nxt)) {
        out.push(" ");
      }
      i = j + 1;
    }
    return out.join("");
  },

  /**
   * Markdown → Zotero Better Notes 兼容 Markdown 源文本（MdClear
   * md_to_zotero 的完整移植）。行内公式统一 $...$（单字母无上下标公式
   * 两侧不加空格）、独立公式统一 $$…$$ 且单独成行（前后空行）；
   * 禁止 \(…\)、\[…\]；公式不进代码块；标题/列表/表格等结构原样保留。
   */
  mdToZotero(md) {
    let text = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = this._stripHrLines(text);
    let store;
    let protectedOut = this._protect(text);
    text = protectedOut[0];
    store = protectedOut[1];
    let out = [];

    let self = this;
    let emitDisplay = function (seg) {
      let latex = self._zoteroLatex(seg.latex);
      if (out.length && out[out.length - 1].trim()) {
        out.push(""); // 与前文空行分隔
      }
      out.push("$$");
      let ls = latex.split("\n");
      for (let l of ls) {
        out.push(l);
      }
      out.push("$$");
      out.push("");
    };

    for (let line of text.split("\n")) {
      let pieces = line.split(this._PH_RE);
      let cur = "";
      for (let k = 0; k < pieces.length; k++) {
        if (k % 2 === 0) {
          cur += pieces[k];
          continue;
        }
        let seg = store[parseInt(pieces[k], 10)];
        if (seg.kind === "code") {
          // 代码原样保留：围栏块（含单行 ``` 块）→ 还原围栏与语言标记；
          // 仅真正的行内代码才输出为 `...`
          if (seg.fenced || seg.text.indexOf("\n") >= 0) {
            if (cur.trim()) {
              out.push(cur);
              cur = "";
            }
            out.push("```" + (seg.info || ""));
            for (let l of seg.text.split("\n")) {
              out.push(l);
            }
            out.push("```");
            out.push("");
          } else {
            cur += "`" + seg.text + "`";
          }
          continue;
        }
        if (seg.display) {
          if (cur.trim()) {
            out.push(cur);
            cur = "";
          }
          emitDisplay(seg);
          continue;
        }
        let latex = this._zoteroLatex(seg.latex);
        if (latex.indexOf("\\begin{") >= 0 || latex.indexOf("\n") >= 0) {
          // aligned/cases 等环境或含换行的公式按独立公式输出（$$ 块，
          // KaTeX 渲染为多行对齐）；行内输出 $...$ 会被换行拆成
          // 前后两个不成对的 $，导致后续公式定界符全部错位
          if (cur.trim()) {
            out.push(cur);
            cur = "";
          }
          if (out.length && out[out.length - 1].trim()) {
            out.push("");
          }
          out.push("$$");
          for (let l of latex.split("\n")) {
            out.push(l);
          }
          out.push("$$");
          out.push("");
          continue;
        }
        cur += "$" + latex + "$";
      }
      out.push(cur);
    }
    let res = out.join("\n");
    // 围栏代码块区域打掩码：行内空格/flanking 修复只作用于代码块之外，
    // 避免误改代码内容（MdClear 原版此处会触及代码块内文本，属缺陷）
    let maskStore = [];
    res = res.replace(/```[^\n]*\n[\s\S]*?\n```/g, function (m0) {
      maskStore.push(m0);
      return "\ue004" + (maskStore.length - 1) + "\ue005";
    });
    // 行内公式与中文之间的空格去除（与 AI 提示词输出样式一致：其中$Q_p$表示…）
    let cjk = "[\\u4e00-\\u9fff，。；：、（）【】《》“”]";
    res = res.replace(new RegExp("(?<=" + cjk + ") (\\$[^$\\n]{1,80}\\$)", "g"), "$1");
    res = res.replace(new RegExp("(\\$[^$\\n]{1,80}\\$) (?=" + cjk + ")", "g"), "$1");
    // 单字母无上下标公式：$ 与前后正文之间不加空格（Better Notes 解析兼容）
    res = res.replace(/ \$([A-Za-z])\$/g, "$$$1$$");
    res = res.replace(/\$([A-Za-z])\$ /g, "$$$1$$");
    // flanking 修复
    res = this._fixMathFlank(res);
    res = res.replace(/\n{3,}/g, "\n\n");
    // 还原代码块
    res = res.replace(/\ue004(\d+)\ue005/g, function (m0, idx) {
      return maskStore[parseInt(idx, 10)];
    });
    return res.trim();
  },

  /* ======================= 剪贴板读写（XPCOM） ======================= */

  /**
   * 读系统剪贴板纯文本；失败返回 null。
   * 分层兜底（不同 Zotero/Gecko 版本行为有差异）：
   *   1. XPCOM 多 flavor（text/unicode → text/plain，含 trans.init）
   *   2. Zotero.QuickCopy.getContentFromClipboard（Zotero 自带实现，版本自适配）
   * 每层失败都会写调试日志。仅在手动「转换剪贴板」时调用；
   * 转换窗口方案不依赖本函数（输入直接进窗口文本框）。
   */
  readClipboardText() {
    try {
      let clip = Components.classes["@mozilla.org/widget/clipboard;1"].getService(
        Components.interfaces.nsIClipboard,
      );
      let flavors = ["text/unicode", "text/plain"];
      for (let flavor of flavors) {
        try {
          let trans = Components.classes[
            "@mozilla.org/widget/transferable;1"
          ].createInstance(Components.interfaces.nsITransferable);
          try {
            trans.init(null); // 新版 Gecko 需要；旧版本会抛错，忽略即可
          } catch (e0) {
            /* ignore */
          }
          trans.addDataFlavor(flavor);
          clip.getData(trans, clip.kGlobalClipboard);
          let data = {};
          let dataLen = {};
          trans.getTransferData(flavor, data, dataLen);
          if (!data.value) {
            continue;
          }
          let text = null;
          try {
            // 宽字符串路径（text/unicode 常见）；dataLen 为字节数
            let ws = data.value.QueryInterface(Components.interfaces.nsISupportsString);
            let n = Math.floor(dataLen.value / 2);
            text = n > 0 && n <= ws.data.length ? ws.data.substring(0, n) : ws.data;
          } catch (eWide) {
            // 字节串路径（text/plain 常见）；dataLen 为字节数，按 UTF-8 解码
            try {
              let cs = data.value.QueryInterface(Components.interfaces.nsISupportsCString);
              let bytes = new Uint8Array(cs.data.length);
              for (let i = 0; i < cs.data.length; i++) {
                bytes[i] = cs.data.charCodeAt(i) & 0xff;
              }
              text = new TextDecoder().decode(bytes);
            } catch (eByte) {
              Zotero.debug(
                "[MathFixer][Clip] flavor " + flavor + " 数据类型无法解析: " +
                  (eWide && eWide.message ? eWide.message : eWide),
              );
              continue;
            }
          }
          if (text && text.length) {
            return text;
          }
        } catch (eFlavor) {
          Zotero.debug(
            "[MathFixer][Clip] 读取 flavor " + flavor + " 失败: " +
              (eFlavor && eFlavor.message ? eFlavor.message : eFlavor),
          );
        }
      }
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] XPCOM 读取剪贴板异常: " + (e && e.message ? e.message : e),
      );
    }
    // 兜底：Zotero 自带的 QuickCopy 读取（返回 string 或 {text, html}）
    try {
      if (Zotero.QuickCopy && Zotero.QuickCopy.getContentFromClipboard) {
        let qc = Zotero.QuickCopy.getContentFromClipboard();
        let t = typeof qc === "string" ? qc : qc && qc.text;
        if (t && t.length) {
          Zotero.debug("[MathFixer][Clip] 经 QuickCopy 读取剪贴板成功（" + t.length + " 字符）");
          return t;
        }
      }
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] QuickCopy 读取剪贴板失败: " + (e && e.message ? e.message : e),
      );
    }
    // 注意：不提供 execCommand 类兜底（Gecko 原生崩溃风险）
    Zotero.debug("[MathFixer][Clip] 所有剪贴板读取方式均失败");
    return null;
  },

  /**
   * 只写纯文本剪贴板。仅调 setData（内部单会话完成 EmptyClipboard +
   * SetClipboardData，与 Zotero 自家 copyTextToClipboard 完全同路径）。
   * ⚠ 不要先显式 emptyClipboard 再 setData：两次独立的 OS 剪贴板开关
   * 存在竞态，曾导致 OS 层写入静默失败（XPCOM 读回缓存假阳性、剪贴板
   * 实际为空、粘贴无反应）。仅在普通回调上下文调用。返回是否成功。
   */
  writeClipboardTextOnly(text) {
    try {
      let clip = Components.classes["@mozilla.org/widget/clipboard;1"].getService(
        Components.interfaces.nsIClipboard,
      );
      let str = Components.classes[
        "@mozilla.org/supports-string;1"
      ].createInstance(Components.interfaces.nsISupportsString);
      str.data = text;
      let trans = Components.classes[
        "@mozilla.org/widget/transferable;1"
      ].createInstance(Components.interfaces.nsITransferable);
      trans.addDataFlavor("text/unicode");
      trans.setTransferData("text/unicode", str, text.length * 2);
      clip.setData(trans, null, clip.kGlobalClipboard);
      return true;
    } catch (e) {
      try {
        Zotero.debug("[MathFixer][Clip] 写入剪贴板失败: " + (e && e.message ? e.message : e));
      } catch (e2) {
        /* ignore */
      }
      return false;
    }
  },

  /* ======================= UI（工具栏图标 + 菜单 + 快捷键） ======================= */

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
    if (!win || !win.document) {
      return;
    }
    let doc = win.document;

    // 说明：不再使用 Zotero 工具栏按钮（图标模式/节点结构不可靠），
    // 也不再用绿色唤回钮（1.7.x 的过渡方案，已按反馈移除）。
    // 入口收敛为：Tools 菜单 Math Fixer（只负责显示）+ Ctrl+Alt+F（开关）
    let toolsPopup =
      doc.getElementById("menu_ToolsPopup") || doc.getElementById("menu_toolsPopup");
    if (toolsPopup) {
      try {
        if (!toolsPopup.querySelector("#mathclipfixer-tools-capsule")) {
          let mi = doc.createXULElement
            ? doc.createXULElement("menuitem")
            : doc.createElement("menuitem");
          mi.id = "mathclipfixer-tools-capsule";
          mi.setAttribute("label", "Math Fixer");
          mi.addEventListener("command", () => this.showCapsule());
          toolsPopup.appendChild(mi);
        }
      } catch (e) {
        Zotero.debug("[MathFixer][Clip] 挂 Tools 菜单项失败: " + (e && e.message ? e.message : e));
      }
    }

    // 快捷键：Ctrl+Alt+A 开关转换窗口（幂等）
    if (!win.__mathClipFixerKeyDown) {
      let onKeyDown = (event) => {
        if (
          event.ctrlKey &&
          event.altKey &&
          !event.shiftKey &&
          !event.repeat
        ) {
          let now = Date.now();
          if (event.key === "A" || event.key === "a") {
            event.preventDefault();
            event.stopPropagation();
            if (now - (win.__mathClipFixerLastWin || 0) < 500) {
              return;
            }
            win.__mathClipFixerLastWin = now;
            this.toggleWindow();
          } else if (event.key === "F" || event.key === "f") {
            event.preventDefault();
            event.stopPropagation();
            this.toggleCapsule();
          }
        }
      };
      win.addEventListener("keydown", onKeyDown, true);
      win.__mathClipFixerKeyDown = onKeyDown;
    }

    // 构建悬浮胶囊（幂等；尊重「退出」状态）
    try {
      this.buildCapsule(win);
    } catch (eCap) {
      Zotero.debug("[MathFixer][Clip] 构建胶囊失败: " + (eCap && eCap.message ? eCap.message : eCap));
    }

    this._windows.add(win);
  },

  removeFromWindow(win) {
    if (!win) {
      return;
    }
    try {
      let doc = win.document;
      doc
        .querySelectorAll("#mathclipfixer-tools-capsule, #mathfixer-capsule-handle")
        .forEach((el) => el.remove());
      let capOld = doc.getElementById("mathfixer-capsule");
      if (capOld) {
        capOld.remove();
      }
    } catch (e) {
      /* ignore */
    }
    if (win.__mathClipFixerKeyDown) {
      win.removeEventListener("keydown", win.__mathClipFixerKeyDown, true);
      delete win.__mathClipFixerKeyDown;
    }
    this._windows.delete(win);
  },

  /** 非阻塞提示：角落弹出，超时自动消失，不抢焦点不排队 */
  _notifyTransient(message) {
    try {
      let pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Clip Fixer");
      pw.addLines(message);
      pw.show();
      pw.startCloseTimer(3000);
    } catch (e) {
      try {
        Zotero.alert(null, "Clip Fixer", message);
      } catch (e2) {
        /* ignore */
      }
    }
  },

  /* ======================= 转换窗口 ======================= */

  /** 工具栏图标 toggle：未打开则打开；已打开未聚焦则聚焦；聚焦中则隐藏 */
  toggleWindow() {
    try {
      let pw = this._panelWindow;
      let alive = false;
      let focused = false;
      try {
        alive = !!pw && !pw.closed;
        if (alive) {
          focused = pw.document.hasFocus ? pw.document.hasFocus() : false;
        }
      } catch (e) {
        alive = false; // 窗口引用已失效
      }
      if (!alive) {
        this.openWindow();
      } else if (focused) {
        pw.close();
        this._panelWindow = null;
      } else {
        pw.focus();
      }
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] toggle 窗口出错: " + (e && e.message ? e.message : e),
      );
    }
  },

  openWindow() {
    try {
      let mainWin = Zotero.getMainWindow();
      if (!mainWin) {
        this._notifyTransient("无法获取 Zotero 主窗口");
        return;
      }
      // 记忆窗口几何：恢复上次大小与位置
      let geom = this._loadPanelGeom();
      let features =
        "chrome,dialog=no,resizable=yes,centerscreen" +
        ",width=" + geom.w + ",height=" + geom.h;
      if (geom.x != null && geom.y != null) {
        features += ",left=" + geom.x + ",top=" + geom.y;
      }
      // 打开 about:blank 弹窗后由插件用 DOM API 构建整个界面：
      // 不加载任何外部文件（jar: URL 装载在部分环境下会得到空白窗口）
      let pw = mainWin.openDialog("about:blank", "mathfixer-clip-panel", features);
      this._panelWindow = pw;
      let self = this;
      let build = function () {
        try {
          self._buildPanel(pw);
          Zotero.debug("[MathFixer][Clip] 已打开转换窗口");
        } catch (e) {
          Zotero.debug(
            "[MathFixer][Clip] 构建转换窗口失败: " + (e && e.message ? e.message : e),
          );
        }
      };
      let doc = null;
      try {
        doc = pw.document;
      } catch (eDoc) {
        doc = null;
      }
      if (doc && doc.readyState === "complete" && doc.body) {
        pw.setTimeout(build, 0);
      } else {
        let onLoad = function () {
          pw.removeEventListener("load", onLoad);
          pw.setTimeout(build, 0);
        };
        pw.addEventListener("load", onLoad);
      }
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] 打开转换窗口失败: " + (e && e.message ? e.message : e),
      );
      this._notifyTransient("打开转换窗口失败，请查看调试日志");
    }
  },

  /**
   * 在 about:blank 弹窗中构建转换窗口界面（双栏：输入 | 实时预览）。
   * 全部用 createElementNS 构建 + textContent 赋值，无 innerHTML、
   * 无外部资源，杜绝加载与脚本权限问题。
   */
  _buildPanel(pw) {
    let doc = pw.document;
    const X = "http://www.w3.org/1999/xhtml";
    let self = this;

    doc.title = "Zotero 笔记格式转换 - Math Fixer";

    // 样式
    let style = doc.createElementNS(X, "style");
    style.textContent = [
      "html, body { margin:0; padding:0; height:100%;",
      '  font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
      "  font-size:13px; color:#1f2937; background:#ffffff; }",
      "body { display:flex; flex-direction:column; box-sizing:border-box; padding:10px; }",
      ".mcf-bar { display:flex; align-items:center; gap:8px; padding:6px 8px;",
      "  background:#f5f6f7; border:1px solid #d9dde1; border-radius:6px; margin-bottom:10px; }",
      ".mcf-title { font-weight:600; }",
      ".mcf-hint { color:#6b7280; font-size:12px; }",
      ".mcf-spacer { flex:1; }",
      "button { font:inherit; padding:4px 14px; border:1px solid #c4cad0;",
      "  border-radius:5px; background:#ffffff; cursor:pointer; }",
      "button:hover { background:#eef1f3; }",
      "button:active { background:#e2e7ea; }",
      "#mcf-btn-copy { font-weight:600; }",
      "#mcf-status { color:#16a34a; font-size:12px; min-width:120px; text-align:right; }",
      "#mcf-status.err { color:#b91c1c; }",
      ".mcf-panes { flex:1; display:flex; gap:10px; min-height:0; }",
      ".mcf-pane { flex:1; display:flex; flex-direction:column; min-width:0; }",
      ".mcf-pane-title { font-size:12px; color:#6b7280; margin:0 0 4px 2px; }",
      "#mcf-input, #mcf-output { flex:1; box-sizing:border-box; width:100%;",
      "  border:1px solid #c4cad0; border-radius:6px; padding:10px;",
      '  font-family:Consolas,"Courier New",monospace; font-size:13px; line-height:1.5;',
      "  color:#1f2937; background:#ffffff; }",
      "#mcf-input { resize:none; outline:none; }",
      "#mcf-input:focus { border-color:#16a34a; }",
      "#mcf-output { margin:0; white-space:pre-wrap; word-break:break-word;",
      "  overflow:auto; background:#f8f9fa; }",
      ".mcf-autolabel { display:flex; align-items:center; gap:4px; font-size:12px;",
      "  color:#374151; cursor:pointer; -moz-user-select:none; user-select:none; }",
      "#mcf-chk-auto { cursor:pointer; margin:0; }",
    ].join("\n");
    doc.head.appendChild(style);

    let mk = function (tag, cls) {
      let el = doc.createElementNS(X, tag);
      if (cls) {
        el.className = cls;
      }
      return el;
    };

    // 顶栏
    let bar = mk("div", "mcf-bar");
    let title = mk("span", "mcf-title");
    title.textContent = "笔记格式转换";
    let hint = mk("span", "mcf-hint");
    hint.textContent = "左侧粘贴 AI 原始内容 → 复制转换结果 → 到笔记 Ctrl+V";
    let spacer = mk("span", "mcf-spacer");
    let btnCopy = mk("button");
    btnCopy.id = "mcf-btn-copy";
    btnCopy.textContent = "复制转换结果";
    let autoLabel = mk("label", "mcf-autolabel");
    autoLabel.title = "勾选后：输入新内容且转换完成即自动复制，无需点按钮";
    let chkAuto = doc.createElementNS(X, "input");
    chkAuto.type = "checkbox";
    chkAuto.id = "mcf-chk-auto";
    autoLabel.appendChild(chkAuto);
    autoLabel.appendChild(doc.createTextNode("自动复制"));
    let btnClear = mk("button");
    btnClear.textContent = "清空";
    let status = mk("span");
    status.id = "mcf-status";
    bar.appendChild(title);
    bar.appendChild(hint);
    bar.appendChild(spacer);
    bar.appendChild(btnCopy);
    bar.appendChild(autoLabel);
    bar.appendChild(btnClear);
    bar.appendChild(status);

    // 双栏
    let panes = mk("div", "mcf-panes");
    let paneL = mk("div", "mcf-pane");
    let titleL = mk("div", "mcf-pane-title");
    titleL.textContent = "原始内容（在此粘贴 AI 对话 / Markdown）";
    let input = doc.createElementNS(X, "textarea");
    input.id = "mcf-input";
    input.setAttribute("spellcheck", "false");
    input.placeholder = "把 AI 回复原样粘贴到这里……";
    paneL.appendChild(titleL);
    paneL.appendChild(input);
    let paneR = mk("div", "mcf-pane");
    let titleR = mk("div", "mcf-pane-title");
    titleR.textContent = "转换结果预览（只读，Zotero Better Notes 兼容格式）";
    let output = mk("pre");
    output.id = "mcf-output";
    paneR.appendChild(titleR);
    paneR.appendChild(output);
    panes.appendChild(paneL);
    panes.appendChild(paneR);

    doc.body.appendChild(bar);
    doc.body.appendChild(panes);

    // 行为
    let timer = null;
    let lastConverted = "";
    let lastCopiedSrc = null; // 最近一次已复制（自动/手动）的原始内容
    let initialLoad = true;

    let setStatus = function (msg, isErr) {
      status.textContent = msg;
      status.className = isErr ? "err" : "";
    };

    let refresh = function () {
      try {
        let src = input.value;
        if (!src.trim()) {
          output.textContent = "";
          lastConverted = "";
          setStatus("");
          return;
        }
        let res = self.mdToZotero(src);
        lastConverted = res;
        output.textContent = res;
        // 自动复制：勾选后识别到新内容且转换成功，直接写入剪贴板
        if (chkAuto.checked && !initialLoad && src !== lastCopiedSrc && doCopy()) {
          setStatus("已自动复制（" + res.length + " 字符），可直接到笔记 Ctrl+V", false);
        } else {
          setStatus("原始 " + src.length + " 字符 → 转换 " + res.length + " 字符", false);
        }
      } catch (e) {
        lastConverted = "";
        setStatus("转换出错: " + (e && e.message ? e.message : e), true);
      }
    };

    input.addEventListener("input", function () {
      try {
        self.savePanelText(input.value);
      } catch (ePersist) {
        /* ignore */
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = pw.setTimeout(refresh, 150);
    });

    // 选区复制兜底：把文本放进隐藏 textarea 后执行 execCommand("copy")。
    // 注意：copy 是标准用户路径（与崩溃的 paste 不同），且发生在面板
    // 窗口的普通点击回调里，不在任何事件派发期间，安全。
    let copyViaSelection = function (text) {
      try {
        let ta = doc.getElementById("mcf-clip-ta");
        if (!ta) {
          ta = doc.createElementNS(X, "textarea");
          ta.id = "mcf-clip-ta";
          ta.setAttribute(
            "style",
            "position:fixed;left:-9999px;top:0;width:10px;height:10px;opacity:0;",
          );
          doc.body.appendChild(ta);
        }
        ta.value = text;
        ta.focus();
        ta.select();
        let ok = false;
        try {
          ok = doc.execCommand("copy");
        } catch (eCopy) {
          ok = false;
        }
        ta.value = "";
        input.focus();
        Zotero.debug("[MathFixer][Clip] 选区复制兜底: " + (ok ? "成功" : "失败"));
        return ok;
      } catch (e) {
        Zotero.debug(
          "[MathFixer][Clip] 选区复制兜底异常: " + (e && e.message ? e.message : e),
        );
        return false;
      }
    };

    // 统一复制入口：双通道写入（XPCOM setData + 选区复制），任一成功即可；
    // 成功后记录已复制的原始内容，供「自动复制」去重
    let doCopy = function () {
      if (!lastConverted) {
        return false;
      }
      let okXpcom = false;
      try {
        okXpcom = self.writeClipboardTextOnly(lastConverted);
      } catch (eClip) {
        okXpcom = false;
      }
      let osOk = copyViaSelection(lastConverted);
      Zotero.debug(
        "[MathFixer][Clip] 复制结果：XPCOM 写入=" + okXpcom + "，选区复制=" + osOk,
      );
      let ok = okXpcom || osOk;
      if (ok) {
        lastCopiedSrc = input.value;
      }
      return ok;
    };

    btnCopy.addEventListener("click", function () {
      if (!lastConverted) {
        setStatus("没有可复制的内容", true);
        return;
      }
      if (doCopy()) {
        let old = btnCopy.textContent;
        btnCopy.textContent = "已复制 ✓";
        setStatus("已复制，请到笔记中 Ctrl+V 粘贴", false);
        pw.setTimeout(function () {
          btnCopy.textContent = old;
        }, 1500);
      } else {
        setStatus("写入剪贴板失败，请查看调试日志", true);
      }
    });

    btnClear.addEventListener("click", function () {
      input.value = "";
      lastConverted = "";
      output.textContent = "";
      setStatus("");
      try {
        self.savePanelText("");
      } catch (eClear) {
        /* ignore */
      }
      input.focus();
    });

    // 自动复制开关：状态记忆；勾选时若存在未复制的新内容则立即复制
    try {
      chkAuto.checked = Zotero.Prefs.get(self._PREF_AUTOCOPY, true) === true;
    } catch (eAutoLoad) {
      /* ignore */
    }
    chkAuto.addEventListener("change", function () {
      try {
        Zotero.Prefs.set(self._PREF_AUTOCOPY, chkAuto.checked, true);
      } catch (eAutoSave) {
        /* ignore */
      }
      if (chkAuto.checked && input.value.trim() && input.value !== lastCopiedSrc) {
        refresh();
      }
    });

    // 关闭窗口时记忆几何
    pw.addEventListener("unload", function () {
      try {
        self.savePanelGeom(pw);
      } catch (eGeom) {
        /* ignore */
      }
    });

    // 恢复上次输入并做首次转换（首次不自动复制，避免开窗即覆盖剪贴板）
    try {
      let saved = self.loadPanelText();
      if (saved) {
        input.value = saved;
        lastCopiedSrc = saved;
      }
    } catch (eLoad) {
      /* ignore */
    }
    refresh();
    initialLoad = false;
    input.focus();
  },

  /** 关闭转换窗口（插件停用时调用） */
  closePanel() {
    try {
      if (this._panelWindow && !this._panelWindow.closed) {
        this._panelWindow.close();
      }
    } catch (e) {
      /* ignore */
    }
    this._panelWindow = null;
  },

  /* ======================= 面板状态记忆 ======================= */

  _loadPanelGeom() {
    try {
      let raw = Zotero.Prefs.get(this._PREF_GEOM, true);
      if (typeof raw === "string" && raw) {
        let g = JSON.parse(raw);
        if (g && g.w >= 500 && g.h >= 320) {
          return g;
        }
      }
    } catch (e) {
      /* ignore */
    }
    return { w: 1100, h: 680, x: null, y: null };
  },

  savePanelGeom(win) {
    try {
      let g = {
        w: Math.max(500, win.outerWidth),
        h: Math.max(320, win.outerHeight),
        x: win.screenX,
        y: win.screenY,
      };
      Zotero.Prefs.set(this._PREF_GEOM, JSON.stringify(g), true);
    } catch (e) {
      /* ignore */
    }
  },

  loadPanelText() {
    try {
      let t = Zotero.Prefs.get(this._PREF_TEXT, true);
      return typeof t === "string" ? t : "";
    } catch (e) {
      return "";
    }
  },

  savePanelText(text) {
    try {
      // 上限 200KB，避免 prefs 膨胀
      if (text.length > 200 * 1024) {
        text = text.slice(0, 200 * 1024);
      }
      Zotero.Prefs.set(this._PREF_TEXT, text, true);
    } catch (e) {
      /* ignore */
    }
  },

  /* ======================= 悬浮胶囊 ======================= */

  _CAP_THEMES: {
    glass: { label: "白色磨砂（默认）", bg: "rgba(255,255,255,0.78)", text: "#111827", border: "rgba(120,130,140,0.45)", blur: true },
    dark: { label: "深灰磨砂", bg: "rgba(32,34,38,0.82)", text: "#f2f4f6", border: "rgba(255,255,255,0.18)", blur: true },
    white: { label: "纯白", bg: "#ffffff", text: "#1f2937", border: "#e2e5e9", blur: false },
    black: { label: "纯黑", bg: "#14161a", text: "#f2f4f6", border: "#2c2f34", blur: false },
    green: { label: "墨绿", bg: "rgba(20,90,60,0.92)", text: "#ffffff", border: "rgba(255,255,255,0.25)", blur: false },
    blue: { label: "深蓝", bg: "rgba(25,70,160,0.92)", text: "#ffffff", border: "rgba(255,255,255,0.25)", blur: false },
  },

  /**
   * 图标：用 createElementNS(SVG) 逐节点构建。
   * 不用 innerHTML——Zotero 10 主窗口文档（XUL 环境）里 innerHTML
   * 写入的 svg 不进入 SVG 命名空间，会渲染成空白（1.5.4 实测）。
   * currentColor 随主题变色。
   */
  _capSvgEl(act, doc) {
    const S = "http://www.w3.org/2000/svg";
    let svg = doc.createElementNS(S, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("width", "17");
    svg.setAttribute("height", "17");
    let mk = function (t, attrs) {
      let el = doc.createElementNS(S, t);
      for (let k in attrs) {
        el.setAttribute(k, attrs[k]);
      }
      svg.appendChild(el);
    };
    if (act === "conv") {
      mk("path", { d: "M3 6h7m0 0L8 4m2 2-2 2M13 10H6m0 0 2-2m-2 2 2 2" });
    } else if (act === "fix") {
      mk("path", {
        d: "M3 13 10 6m0 0-1.6-1.6M10 6l1.6 1.6M12.5 2.5l.7.7M13.6 5.4l.9-.2M11 3.2l.2-.9",
      });
    } else if (act === "baresel") {
      mk("rect", { x: 3, y: 3, width: 10, height: 10, rx: 1.5, "stroke-dasharray": "2.6 2.2" });
    } else if (act === "bareall") {
      mk("rect", { x: 3, y: 2.5, width: 10, height: 11, rx: 1.5 });
      mk("path", { d: "M5.5 5.5h5M5.5 8h5M5.5 10.5h3" });
    } else if (act === "settings") {
      mk("circle", { cx: 8, cy: 8, r: 2.4 });
      mk("path", {
        d: "M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M12.4 3.6 11 5M5 11 3.6 12.4",
      });
    }
    return svg;
  },

  _capPref(name, defVal) {
    try {
      let v = Zotero.Prefs.get(name, true);
      return v === undefined || v === null ? defVal : v;
    } catch (e) {
      return defVal;
    }
  },

  /** 显示/隐藏胶囊（持久记忆） */
  _setCapsuleVisible(win, visible) {
    try {
      let doc = win.document;
      let cap = doc.getElementById("mathfixer-capsule");
      if (!cap) {
        this.buildCapsule(win);
        cap = doc.getElementById("mathfixer-capsule");
      }
      if (!cap) {
        return;
      }
      cap.style.display = visible ? "flex" : "none";
      try {
        Zotero.Prefs.set(this._PREF_CAP_EXITED, !visible, true);
      } catch (e) {
        /* ignore */
      }
      Zotero.debug("[MathFixer][Clip] 胶囊已" + (visible ? "显示" : "隐藏"));
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] 设置胶囊可见性失败: " + (e && e.message ? e.message : e),
      );
    }
  },

  /** 显示/隐藏胶囊（Ctrl+Alt+F 入口，开关语义） */
  toggleCapsule() {
    try {
      let win = Zotero.getMainWindow();
      if (!win || !win.document) {
        return;
      }
      let cap = win.document.getElementById("mathfixer-capsule");
      if (!cap) {
        this.buildCapsule(win);
        cap = win.document.getElementById("mathfixer-capsule");
      }
      if (!cap) {
        return;
      }
      let visible = cap.style.display !== "none";
      this._setCapsuleVisible(win, !visible);
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] 切换胶囊失败: " + (e && e.message ? e.message : e),
      );
    }
  },

  /**
   * 只显示胶囊（Tools 菜单 Math Fixer 入口）。
   * 不做开关切换：胶囊正显示时再点菜单不应该把它藏起来
   *（1.7.1 实测：toggle 语义让用户"点了菜单反而只见唤回钮"）。
   */
  showCapsule() {
    try {
      let win = Zotero.getMainWindow();
      if (!win || !win.document) {
        return;
      }
      let cap = win.document.getElementById("mathfixer-capsule");
      if (!cap) {
        this.buildCapsule(win);
        cap = win.document.getElementById("mathfixer-capsule");
      }
      if (!cap) {
        return;
      }
      this._setCapsuleVisible(win, true);
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] 显示胶囊失败: " + (e && e.message ? e.message : e),
      );
    }
  },

  /** 胶囊按钮 → 对应功能 */
  _capRun(act, win) {
    try {
      if (act === "conv") {
        this.toggleWindow();
        return;
      }
      let mf = Zotero.MathFixer;
      if (!mf) {
        this._notifyTransient("MathFixer 模块未就绪，请重启 Zotero");
        return;
      }
      if (act === "fix") {
        mf.fixActiveEditor(win, true);
      } else if (act === "baresel") {
        mf.wrapBareLettersActive(win, true, false);
      } else if (act === "bareall") {
        mf.wrapBareLettersActive(win, true, true);
      }
    } catch (e) {
      Zotero.debug(
        "[MathFixer][Clip] 胶囊按钮执行失败: " + (e && e.message ? e.message : e),
      );
    }
  },

  /** 主题与置顶应用（全内联样式，无 CSS 类依赖） */
  _applyCapTheme(cap, menu) {
    try {
      let key = this._capPref(this._PREF_CAP_COLOR, "glass");
      let th = this._CAP_THEMES[key] || this._CAP_THEMES.glass;
      let blur = th.blur ? "blur(14px) saturate(1.5)" : "none";
      cap.style.background = th.bg;
      cap.style.color = th.text;
      cap.style.border = "1px solid " + th.border;
      cap.style.backdropFilter = blur;
      if (menu) {
        menu.style.background = th.bg;
        menu.style.color = th.text;
        menu.style.border = "1px solid " + th.border;
        menu.style.backdropFilter = blur;
      }
      let onTop = this._capPref(this._PREF_CAP_ONTOP, true) === true;
      cap.style.zIndex = onTop ? "2147483647" : "9999";
    } catch (e) {
      /* ignore */
    }
  },

  /** 在主窗口构建悬浮胶囊（幂等；失败清理半成品，交由自愈轮询重建） */
  buildCapsule(win) {
    let doc = win.document;
    if (!doc || !doc.documentElement || doc.getElementById("mathfixer-capsule")) {
      return;
    }
    try {
      this._buildCapsuleInner(win, doc);
    } catch (eBuild) {
      try {
        let broken = doc.getElementById("mathfixer-capsule");
        if (broken) {
          broken.remove();
        }
      } catch (eClean) {
        /* ignore */
      }
      throw eBuild;
    }
  },

  /**
   * 构建胶囊主体。全部内联样式 + JS hover，不依赖 <style> 元素
   * （Zotero 10 主窗口对 <style>/doc.head 的支持不可靠，1.5.4 实测）。
   */
  _buildCapsuleInner(win, doc) {
    const X = "http://www.w3.org/1999/xhtml";
    let self = this;
    let suppressClick = false;
    // 布局模式："h" 横向条 / "v" 竖向条 / "mini" 最小化（只留设置圆钮）
    let mode = self._capPref(self._PREF_CAP_MODE, "h");
    if (["h", "v", "mini"].indexOf(mode) < 0) {
      mode = "h";
    }
    let funcBtns = []; // 四个功能按钮引用（最小化时隐藏）

    let cap = doc.createElementNS(X, "div");
    cap.id = "mathfixer-capsule";
    Object.assign(cap.style, {
      position: "fixed",
      display: "flex",
      alignItems: "center",
      gap: "2px",
      padding: "5px 8px",
      borderRadius: "999px",
      boxShadow: "0 4px 18px rgba(0,0,0,.18)",
      userSelect: "none",
      MozUserSelect: "none",
      cursor: "default",
      // 关键：退出 Zotero 自定义标题栏的窗口拖动接管，
      // 否则胶囊拖到顶部区域后，按住胶囊会拖动整个窗口
      MozWindowDragging: "no-drag",
    });

    let mkBtn = function (act, tip) {
      let b = doc.createElementNS(X, "div");
      b.title = tip;
      b.setAttribute("data-act", act);
      Object.assign(b.style, {
        width: "28px",
        height: "28px",
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: "inherit",
        MozWindowDragging: "no-drag",
      });
      b.appendChild(self._capSvgEl(act, doc));
      funcBtns.push(b);
      b.addEventListener("mouseenter", function () {
        b.style.background = "rgba(127,127,127,0.35)";
      });
      b.addEventListener("mouseleave", function () {
        b.style.background = "transparent";
      });
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (suppressClick) {
          return; // 拖动结束后的误触
        }
        self._capRun(act, win);
      });
      return b;
    };

    cap.appendChild(mkBtn("conv", "笔记格式转换窗口 (Ctrl+Alt+A)"));
    cap.appendChild(mkBtn("fix", "笔记格式修复 (Ctrl+Shift+M)"));
    cap.appendChild(mkBtn("baresel", "裸字母转公式（选区）(Ctrl+Alt+S)"));
    cap.appendChild(mkBtn("bareall", "裸字母转公式（全文）"));

    let sep = doc.createElementNS(X, "div");
    Object.assign(sep.style, {
      width: "1px",
      height: "18px",
      background: "rgba(127,127,127,0.4)",
      margin: "0 3px",
    });
    cap.appendChild(sep);

    let gear = doc.createElementNS(X, "div");
    gear.title = "设置";
    Object.assign(gear.style, {
      width: "28px",
      height: "28px",
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      color: "inherit",
    });
    gear.style.MozWindowDragging = "no-drag";
    gear.appendChild(self._capSvgEl("settings", doc));
    gear.addEventListener("mouseenter", function () {
      gear.style.background = "rgba(127,127,127,0.35)";
    });
    gear.addEventListener("mouseleave", function () {
      gear.style.background = "transparent";
    });
    cap.appendChild(gear);

    // 设置菜单（显示/隐藏用内联 display，不用 hidden 属性）
    let menu = doc.createElementNS(X, "div");
    // 拖动排除（mousedown 内 closest("#mcf-cap-menu")）依赖此 id，
    // 缺了它设置菜单里按下鼠标会拖走整个胶囊（1.6.0 及之前漏加）
    menu.id = "mcf-cap-menu";
    Object.assign(menu.style, {
      position: "absolute",
      bottom: "calc(100% + 10px)",
      right: "0",
      minWidth: "232px",
      borderRadius: "10px",
      padding: "6px",
      display: "none",
      flexDirection: "column",
      gap: "2px",
      boxShadow: "0 8px 28px rgba(0,0,0,.22)",
      zIndex: "2147483647",
    });

    let mkItem = function () {
      let it = doc.createElementNS(X, "div");
      Object.assign(it.style, {
        padding: "6px 10px",
        borderRadius: "7px",
        cursor: "pointer",
        fontSize: "12.5px",
        display: "flex",
        alignItems: "center",
        gap: "8px",
      });
      it.addEventListener("mouseenter", function () {
        it.style.background = "rgba(127,127,127,0.22)";
      });
      it.addEventListener("mouseleave", function () {
        it.style.background = "transparent";
      });
      return it;
    };

    // 布局切换：横向 / 竖向 / 最小化（最小化 = 只剩设置圆钮）
    let modeRow = doc.createElementNS(X, "div");
    Object.assign(modeRow.style, {
      display: "flex",
      alignItems: "center",
      flexWrap: "nowrap",
      gap: "6px",
      padding: "6px 10px",
    });
    let modeLabel = doc.createElementNS(X, "span");
    modeLabel.textContent = "布局";
    Object.assign(modeLabel.style, {
      fontSize: "12.5px",
      whiteSpace: "nowrap",
    });
    modeRow.appendChild(modeLabel);
    let modePills = {};
    let refreshModePills = function () {
      for (let k in modePills) {
        let p = modePills[k];
        if (k === mode) {
          p.style.background = "rgba(22,163,74,0.22)";
          p.style.borderColor = "#16a34a";
        } else {
          p.style.background = "transparent";
          p.style.borderColor = "rgba(127,127,127,.45)";
        }
      }
    };
    let modeDefs = [["h", "横向"], ["v", "竖向"], ["mini", "最小化"]];
    for (let md of modeDefs) {
      let pill = doc.createElementNS(X, "div");
      pill.textContent = md[1];
      pill.title =
        md[0] === "mini"
          ? "收成一个只带设置的小圆钮，点设置可展开"
          : "把胶囊排成" + md[1] + "布局";
      Object.assign(pill.style, {
        padding: "3px 8px",
        minWidth: "48px",
        boxSizing: "border-box",
        textAlign: "center",
        whiteSpace: "nowrap",
        flexShrink: "0",
        borderRadius: "999px",
        fontSize: "12px",
        cursor: "pointer",
        border: "1px solid rgba(127,127,127,.45)",
        userSelect: "none",
      });
      pill.addEventListener("click", function (e) {
        e.stopPropagation();
        mode = md[0];
        try {
          Zotero.Prefs.set(self._PREF_CAP_MODE, mode, true);
        } catch (eMode) {
          /* ignore */
        }
        refreshModePills();
        applyMode();
        placeMenu();
        if (mode === "mini" && menu.style.display === "flex") {
          armMiniAutoClose();
        } else {
          disarmMiniAutoClose();
        }
        Zotero.debug("[MathFixer][Clip] 胶囊布局切换为 " + mode);
      });
      modePills[md[0]] = pill;
      modeRow.appendChild(pill);
    }
    menu.appendChild(modeRow);

    let itemExit = mkItem();
    itemExit.textContent = "退出（Tools 菜单 Math Fixer / Ctrl+Alt+F 可唤回）";
    menu.appendChild(itemExit);

    let itemTop = mkItem();
    let chkTop = doc.createElementNS(X, "input");
    chkTop.type = "checkbox";
    let lblTop = doc.createElementNS(X, "span");
    lblTop.textContent = "始终悬浮在最上层";
    itemTop.appendChild(chkTop);
    itemTop.appendChild(lblTop);
    menu.appendChild(itemTop);

    let colorRow = doc.createElementNS(X, "div");
    Object.assign(colorRow.style, { display: "flex", gap: "6px", padding: "6px 10px 4px" });
    menu.appendChild(colorRow);

    cap.appendChild(menu);
    doc.documentElement.appendChild(cap);

    // ===== 布局应用 / 菜单定位 / 最小化自动折叠 =====
    // applyMode：按 mode 切换胶囊排布（h 横条 / v 竖条 / mini 圆钮）
    let applyMode = function () {
      try {
        if (mode === "mini") {
          for (let b of funcBtns) {
            b.style.display = "none";
          }
          sep.style.display = "none";
          cap.style.flexDirection = "row";
          cap.style.padding = "5px 6px";
        } else if (mode === "v") {
          for (let b of funcBtns) {
            b.style.display = "flex";
          }
          sep.style.display = "block";
          sep.style.width = "18px";
          sep.style.height = "1px";
          sep.style.margin = "3px 0";
          cap.style.flexDirection = "column";
          cap.style.padding = "8px 5px";
        } else {
          for (let b of funcBtns) {
            b.style.display = "flex";
          }
          sep.style.display = "block";
          sep.style.width = "1px";
          sep.style.height = "18px";
          sep.style.margin = "0 3px";
          cap.style.flexDirection = "row";
          cap.style.padding = "5px 8px";
        }
        // 模式切换后尺寸变化，把胶囊重新钳制回窗口内
        cap.style.left =
          Math.max(0, Math.min(cap.offsetLeft, win.innerWidth - 60)) + "px";
        cap.style.top =
          Math.max(0, Math.min(cap.offsetTop, win.innerHeight - 50)) + "px";
      } catch (eApply) {
        /* ignore */
      }
    };
    // placeMenu：按胶囊形态与在窗口中的位置自适应弹出方向
    //（竖条向侧边弹，横条向上下弹，靠边时自动翻面）
    let placeMenu = function () {
      try {
        if (mode === "v") {
          menu.style.top = "0";
          menu.style.bottom = "auto";
          if (cap.offsetLeft > win.innerWidth - 250) {
            menu.style.right = "calc(100% + 10px)";
            menu.style.left = "auto";
          } else {
            menu.style.left = "calc(100% + 10px)";
            menu.style.right = "auto";
          }
        } else {
          menu.style.right = "0";
          menu.style.left = "auto";
          if (cap.offsetTop > win.innerHeight - 260) {
            menu.style.bottom = "calc(100% + 10px)";
            menu.style.top = "auto";
          } else {
            menu.style.top = "calc(100% + 10px)";
            menu.style.bottom = "auto";
          }
        }
      } catch (ePlace) {
        /* ignore */
      }
    };
    // 最小化模式：菜单打开后无操作 4 秒自动折叠；胶囊上有鼠标活动即刷新
    let miniAutoTimer = null;
    let armMiniAutoClose = function () {
      if (mode !== "mini") {
        return;
      }
      if (miniAutoTimer) {
        win.clearTimeout(miniAutoTimer);
      }
      miniAutoTimer = win.setTimeout(function () {
        miniAutoTimer = null;
        menu.style.display = "none";
      }, 4000);
    };
    let disarmMiniAutoClose = function () {
      if (miniAutoTimer) {
        win.clearTimeout(miniAutoTimer);
        miniAutoTimer = null;
      }
    };
    // 菜单是胶囊子节点，其上的 mousemove 会冒泡到这里
    cap.addEventListener("mousemove", function () {
      if (mode === "mini" && menu.style.display === "flex") {
        armMiniAutoClose();
      }
    });

    // 设置按钮：开/关菜单（自适应弹出方向；最小化模式下无操作自动折叠）
    gear.addEventListener("click", function (e) {
      e.stopPropagation();
      chkTop.checked = self._capPref(self._PREF_CAP_ONTOP, true) === true;
      if (menu.style.display !== "flex") {
        placeMenu();
        menu.style.display = "flex";
        if (mode === "mini") {
          armMiniAutoClose();
        }
      } else {
        menu.style.display = "none";
        disarmMiniAutoClose();
      }
    });
    // 退出
    itemExit.addEventListener("click", function (e) {
      e.stopPropagation();
      menu.style.display = "none";
      self._setCapsuleVisible(win, false);
      self._notifyTransient("胶囊已退出：Tools 菜单 Math Fixer 或 Ctrl+Alt+F 可重新打开");
    });
    itemTop.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    chkTop.addEventListener("change", function () {
      try {
        Zotero.Prefs.set(self._PREF_CAP_ONTOP, chkTop.checked, true);
      } catch (eT) {
        /* ignore */
      }
      self._applyCapTheme(cap, menu);
    });
    // 颜色预设
    let colorKey = self._capPref(self._PREF_CAP_COLOR, "glass");
    if (!self._CAP_THEMES[colorKey]) {
      colorKey = "glass";
    }
    for (let key of Object.keys(self._CAP_THEMES)) {
      let th = self._CAP_THEMES[key];
      let sw = doc.createElementNS(X, "div");
      sw.title = th.label;
      Object.assign(sw.style, {
        width: "18px",
        height: "18px",
        borderRadius: "50%",
        cursor: "pointer",
        border: "1.5px solid rgba(127,127,127,.5)",
        background: th.bg,
      });
      if (key === colorKey) {
        sw.style.outline = "2px solid #16a34a";
        sw.style.outlineOffset = "1px";
      }
      sw.addEventListener("click", function (e) {
        e.stopPropagation();
        try {
          Zotero.Prefs.set(self._PREF_CAP_COLOR, key, true);
        } catch (eC) {
          /* ignore */
        }
        let all = colorRow.children;
        for (let i = 0; i < all.length; i++) {
          all[i].style.outline = "none";
        }
        sw.style.outline = "2px solid #16a34a";
        sw.style.outlineOffset = "1px";
        self._applyCapTheme(cap, menu);
      });
      colorRow.appendChild(sw);
    }
    // 点击胶囊外任意处关闭设置菜单
    doc.addEventListener("click", function () {
      menu.style.display = "none";
      disarmMiniAutoClose();
    });

    // 位置：记忆或默认右上角
    let pos = null;
    try {
      let raw = self._capPref(self._PREF_CAP_POS, null);
      pos = raw ? JSON.parse(raw) : null;
    } catch (eP) {
      pos = null;
    }
    // 拖动上界：工具栏（含标签页栏）下缘，防止胶囊进入窗口拖动区
    let getTopLimit = function () {
      try {
        let tb =
          doc.getElementById("zotero-toolbar") ||
          doc.querySelector('toolbar[id^="zotero"]');
        if (tb && tb.getBoundingClientRect) {
          return Math.max(0, tb.getBoundingClientRect().bottom + 2);
        }
      } catch (eLim) {
        /* ignore */
      }
      return 0;
    };
    let restoreLimit = getTopLimit();
    if (pos && typeof pos.x === "number") {
      cap.style.left = Math.max(0, Math.min(pos.x, win.innerWidth - 60)) + "px";
      cap.style.top =
        Math.max(restoreLimit, Math.min(pos.y, win.innerHeight - 50)) + "px";
    } else {
      cap.style.left = Math.max(0, win.innerWidth - 260) + "px";
      cap.style.top = Math.max(restoreLimit, 64) + "px";
    }

    // 拖动：mousedown 挂在胶囊上，mousemove/mouseup 挂在窗口（捕获阶段），
    // 5px 阈值区分点击与拖动。针对"拖着拖着突然向某个方向窜出一段"：
    //   a) 冻结-回跳：光标划到笔记编辑器等 iframe 上方时父窗口收不到
    //      mouse 事件，胶囊冻结；光标回到主窗口后按"起点+位移"一次性
    //      补位，看起来就是突然窜出一段距离。→ 拖动确立后
    //      setPointerCapture 接管指针，iframe 上方的事件也强制派发给胶囊
    //   b) 残响拉扯：在 iframe 上方或窗外松开鼠标时 mouseup 被吞，残留
    //      监听会在后续移动中继续拉扯。→ mousemove 里校验 ev.buttons，
    //      按键已不在按下状态就立即结束；且每次 mousedown 先清残留
    let lastPointerDownId = null;
    cap.addEventListener("pointerdown", function (e) {
      if (e.button === 0) {
        lastPointerDownId = e.pointerId; // pointerdown 先于 mousedown 到达
      }
    });
    let dragActive = null; // 当前一轮拖动的 {move, up}，非空说明监听仍在位
    cap.addEventListener("mousedown", function (e) {
      if (e.button !== 0) {
        return;
      }
      if (e.target.closest && e.target.closest("#mcf-cap-menu")) {
        return;
      }
      e.preventDefault(); // 阻断原生拖拽/文本选择等默认行为
      // 清理上一轮残留（mouseup 被吞时 dragActive 非空）
      if (dragActive) {
        win.removeEventListener("mousemove", dragActive.move, true);
        win.removeEventListener("mouseup", dragActive.up, true);
        win.removeEventListener("blur", dragActive.up, true);
        dragActive = null;
      }
      let startX = e.clientX;
      let startY = e.clientY;
      let ox = cap.offsetLeft;
      let oy = cap.offsetTop;
      let dragging = false;
      let topLimit = getTopLimit();
      let pid = e.pointerId != null ? e.pointerId : lastPointerDownId;
      let move = function (ev) {
        // 按键已释放却仍有移动 → 就地结束拖动（mouseup 被吞的兜底）；
        // buttons 不存在的老引擎跳过该校验
        if (ev.buttons !== undefined && !(ev.buttons & 1)) {
          up();
          return;
        }
        let dx = ev.clientX - startX;
        let dy = ev.clientY - startY;
        if (!dragging) {
          if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
            return; // 未超过阈值，视为点击前奏
          }
          dragging = true;
          // 拖动确立后接管指针：此后光标即便划过 iframe（笔记编辑器、
          // PDF 阅读器）事件也持续到达胶囊，不再"冻结-回跳"。
          // 不能在 mousedown 就 capture——capture 会把后续 click 重定向
          // 到胶囊本身，普通点击胶囊按钮就失效了
          if (pid != null && cap.setPointerCapture) {
            try {
              cap.setPointerCapture(pid);
            } catch (eCapture) {
              /* 引擎不支持时退化为纯窗口监听 */
            }
          }
        }
        cap.style.left =
          Math.max(0, Math.min(ox + dx, win.innerWidth - 60)) + "px";
        cap.style.top =
          Math.max(topLimit, Math.min(oy + dy, win.innerHeight - 50)) + "px";
      };
      let up = function () {
        win.removeEventListener("mousemove", move, true);
        win.removeEventListener("mouseup", up, true);
        win.removeEventListener("blur", up, true);
        dragActive = null;
        if (pid != null && cap.releasePointerCapture) {
          try {
            cap.releasePointerCapture(pid);
          } catch (eRelease) {
            /* pointerup 后框架会隐式释放，忽略 */
          }
        }
        if (!dragging) {
          return;
        }
        // 移动过才算拖动：抑制按钮误触并记忆位置
        suppressClick = true;
        menu.style.display = "none";
        win.setTimeout(function () {
          suppressClick = false;
        }, 60);
        try {
          Zotero.Prefs.set(
            self._PREF_CAP_POS,
            JSON.stringify({ x: cap.offsetLeft, y: cap.offsetTop }),
            true,
          );
        } catch (eSave) {
          /* ignore */
        }
      };
      dragActive = { move: move, up: up };
      win.addEventListener("mousemove", move, true);
      win.addEventListener("mouseup", up, true);
      // 窗口失焦（Alt+Tab 等）收不到 mouseup，就地结束拖动
      win.addEventListener("blur", up, true);
    });

    // 主题与初始显示状态
    this._applyCapTheme(cap, menu);
    refreshModePills();
    applyMode();
    let exited = this._capPref(this._PREF_CAP_EXITED, false) === true;
    cap.style.display = exited ? "none" : "flex";
    Zotero.debug(
      "[MathFixer][Clip] 悬浮胶囊已构建（" +
        (exited ? "退出态，Tools 菜单 Math Fixer 可唤回" : "显示") +
        "，全内联样式）",
    );
  },
};

