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

    // 主工具栏按钮：点击打开/隐藏转换窗口（幂等）
    let toolbar = doc.getElementById("zotero-toolbar");
    if (toolbar && !toolbar.querySelector("#mathclipfixer-toolbarbutton")) {
      try {
        let btn = doc.createXULElement
          ? doc.createXULElement("toolbarbutton")
          : doc.createElement("toolbarbutton");
        btn.id = "mathclipfixer-toolbarbutton";
        btn.setAttribute("label", "笔记格式转换");
        btn.setAttribute("tooltiptext", "打开/隐藏 Zotero 笔记格式转换窗口（Ctrl+Alt+A）");
        btn.setAttribute("class", "toolbarbutton-1");
        btn.addEventListener("command", () => this.toggleWindow());
        toolbar.appendChild(btn);
        Zotero.debug("[MathFixer][Clip] 已（重新）挂上工具栏按钮");
      } catch (e) {
        /* ignore */
      }
    }

    // Tools 菜单：两项（幂等）
    let toolsPopup =
      doc.getElementById("menu_ToolsPopup") || doc.getElementById("menu_toolsPopup");
    if (toolsPopup) {
      try {
        if (!toolsPopup.querySelector("#mathclipfixer-tools-window")) {
          let mi = doc.createXULElement
            ? doc.createXULElement("menuitem")
            : doc.createElement("menuitem");
          mi.id = "mathclipfixer-tools-window";
          mi.setAttribute("label", "笔记格式转换窗口 (Ctrl+Alt+A)");
          mi.addEventListener("command", () => this.toggleWindow());
          toolsPopup.appendChild(mi);
        }
        Zotero.debug("[MathFixer][Clip] 已（重新）挂上 Tools 菜单项");
      } catch (e) {
        /* ignore */
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
          }
        }
      };
      win.addEventListener("keydown", onKeyDown, true);
      win.__mathClipFixerKeyDown = onKeyDown;
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
        .querySelectorAll("#mathclipfixer-toolbarbutton, #mathclipfixer-tools-window")
        .forEach((el) => el.remove());
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

};
