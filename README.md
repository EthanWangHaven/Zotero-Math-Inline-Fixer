# Zotero Math Inline Fixer（Zotero 数学公式修复 & 笔记格式转换插件）

把 AI 对话（ChatGPT / 豆包 / DeepSeek 等）复制进 Zotero Better Notes 时常见的「公式不渲染、格式错乱」问题一次解决。Zotero 7+ 插件，实测环境：**Zotero 10.0.6 / Windows 11 / Better Notes 3.3.3**。

三条功能线：

1. **笔记格式转换窗口**（粘贴前清洗）——把 AI 输出的 Markdown/LaTeX 重写成 Better Notes 兼容格式，双栏实时预览，一键/自动复制
2. **笔记格式修复**（粘贴后兜底）——自动把编辑器里未渲染的 `$f$`、`$(11,20)$`、`$$...$$` 变成真正的公式节点
3. **裸字母转公式**（手动）——把笔记里"裸奔"的单英文字母包上 `$...$`，渲染成数学斜体

---

## 问题背景

- Zotero 的笔记编辑器（ProseMirror）只在**手动输入**时通过 input rule 解析 `$...$`，**粘贴时完全不解析** Markdown 和数学公式，单字符公式（`$f$`）因防误触设计最容易漏掉。
- AI 网页"复制按钮"常会剥离 Markdown 标记，剪贴板只剩残缺文本；且复制来的富文本带 HTML flavor——**Better Notes 检测到剪贴板含 HTML 时会原样插入、跳过 Markdown 全量转换**。

## 功能 1：笔记格式转换窗口

**入口**：主工具栏「笔记格式转换」图标 / 工具菜单 / `Ctrl+Alt+A`

```
复制豆包回答 → 打开转换窗口 → 窗口内 Ctrl+V → 复制转换结果 → 笔记里 Ctrl+V
```

- 双栏布局：左侧粘贴原始内容，右侧 **150ms 防抖实时预览**转换结果
- 「复制转换结果」：XPCOM setData + 选区复制（`execCommand("copy")`）**双通道写入**，确保 OS 剪贴板生效；剪贴板**只写纯文本**（这是 Better Notes 触发 Markdown 全量转换的关键条件）
- **自动复制**：勾选后，识别到输入新内容、转换完成即自动写入剪贴板，无需点按钮（开关状态持久记忆，开窗恢复旧内容时不误触发）
- 内容与窗口大小/位置自动记忆（内容上限 200KB）
- 工作流中插件**不监听任何 paste 事件、不在事件派发期间碰剪贴板**（此前的原生崩溃教训，见更新日志 1.3.x）

### 转换规则（移植自 [MdClear](https://github.com/EthanWangHaven/md2txt_gui_tool) 并增强）

| 规则 | 示例 |
| --- | --- |
| 行内定界符统一 | `\(x_t\)` → `$x_t$` |
| 独立定界符统一 | `\[ h_t = ... \]` → `$$ ... $$`（前后独立成行） |
| 内侧空格修复 | `$ x $` → `$x$`；单独成行的 `$` → `$$` |
| `\left/\right` 去修饰 | `\left\{Q\right\}` → `\{Q\}` |
| 裸多字母函数名规范化 | `tanh(x)` → `\operatorname{tanh}(x)` |
| Unicode 变体还原 | 非断行连字符 ‑、数学减号 − → `-`；`\,` `\kern` 等间距命令清理 |
| 行内代码包裹公式解包 | `` `$Q_{ego}$` `` → `$Q_{ego}$` |
| 环境块独立输出 | aligned/cases 等环境强制按 `$$` 块输出，防 `$` 定界符错位 |
| CJK 空格规则 | `其中 $Q_p$ 表示` → `其中$Q_p$表示`；单字母公式两侧不加空格 |
| flanking 修复 | `大小$O(N)$大小` → `大小$O(N)$ 大小`（防 markdown-it-katex 吞正文） |
| 代码块保护 | 围栏内容与语言标记（```python）原样保留，永不改写 |

## 功能 2：笔记格式修复（粘贴后兜底）

- **自动**：粘贴后多层触发（paste / input / keyup + MutationObserver，含编辑器 iframe 内监听）+ 30 轮 × 90ms 连续扫描，直到内容全部落地
- **手动**：`Ctrl+Shift+M` 或 工具 → 笔记格式修复
- 所有修复合并为**单个 ProseMirror 事务**，`Ctrl+Z` 一步撤销
- 监听带版本戳，插件升级自动重挂

**会被修复的**：

| 粘贴后的字面文本 | 转换结果 |
| --- | --- |
| `$f$`、`$x$`、`$t$`（单字符） | `math_inline` 节点 |
| `$(11,20)$`、`$t-1$`、`$Q_p$` | `math_inline` 节点 |
| `$$ (11,20) $$` 独占段落 | `math_inline` 节点 |

**永远不会动的**：已渲染的公式节点、代码块、含中文/全角字符的"公式"、`$400 to $500` 这类非公式文本（保守的数学安全字符集检查）。

## 功能 3：裸字母转公式（手动）

把笔记里未被包裹的裸单英文字母（大小写均可）包上 `$...$`，渲染成数学斜体。

- **选区模式**：选中文字后 `Ctrl+Alt+S`，只处理选区
- **全文模式**：工具 → 裸字母转公式（全文）
- 单事务可撤销；快捷键在编辑器 iframe 内直接生效

**防误伤规则**（必须全部满足才命中）：

- 前后都不是英文字母/数字（`ax`、`x2`、`4x` 不算）
- 前后都没有 `$` 或 `\`（公式定界符边缘不碰）
- 前面不是撇号（`it's` 的 s 不算）
- 后面不是 `. `（列表编号 `a.` / 句尾排除）或 `)` `）`（编号排除）
- 不在代码块内、不递归进 math 节点、行内代码 mark 跳过

**已知限制**：相邻字母不拆——`KV`、`BEV`、`TSA` 被视为一个整体词保留（避免拆坏缩写）。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Alt+A` | 打开/隐藏笔记格式转换窗口 |
| `Ctrl+Shift+M` | 笔记格式修复（当前笔记） |
| `Ctrl+Alt+S` | 裸字母转公式（选区） |

## 安装

Zotero → 工具 → 插件 → 右上角齿轮 → **Install Plugin From File** → 选择 `mathfixer.xpi` → 重启 Zotero。

## 构建

```bash
cd mathfixer
zip -r ../mathfixer.xpi manifest.json bootstrap.js mathfixer.js clipfix.js icons
```

## 目录说明

```
mathfixer/
├── manifest.json      # 插件清单
├── bootstrap.js       # 引导脚本（生命周期）
├── mathfixer.js       # 笔记格式修复（粘贴后节点级兜底）
├── clipfix.js         # 笔记格式转换窗口（粘贴前内容级清洗）
├── icons/             # 图标
└── dev/               # 开发期探针插件存档（editor-probe）
```

## 更新日志

### 1.4.0
- 新增「裸字母转公式」：选区（`Ctrl+Alt+S`）/ 全文两种模式，防误伤规则经 12 项用例验证
- 修复 MutationObserver 跨 realm 选项失效导致监听每 1.5s 重复挂载的问题
- 快捷键监听扩展到编辑器 iframe 内（此前在编辑器内按键无法触发）

### 1.3.x
- 新增「笔记格式转换窗口」：双栏实时预览、自动复制、内容与窗口状态记忆
- **修复 Gecko 原生崩溃**：彻底移除 paste 事件派发期间的一切原生剪贴板操作（`execCommand("paste")`、事件内 setData 等），改为独立的转换窗口方案
- 复制改为 XPCOM setData + 选区复制双通道，杜绝 OS 层写入静默失败

### 1.1.x
- 初始版本：粘贴后自动修复未渲染的数学公式

## 作者

- **作者**：wangce（[EthanWangHaven](https://github.com/EthanWangHaven)）
- 相关项目：[MdClear — Markdown 转纯文本/OneNote/Word 小工具](https://github.com/EthanWangHaven/md2txt_gui_tool)
