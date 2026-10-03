'use strict';

const { escapeHtml } = require('./util');

/** 读取平衡花括号组。s 以 '{' 开头，返回 { content, used } */
function readBraced(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return { content: s.slice(1, i), used: i + 1 };
    }
  }
  return { content: s.slice(1), used: s.length };
}

/** 读取一个"组"：花括号组或单个字符 */
function readGroup(s) {
  if (s[0] === '{') return readBraced(s);
  return { content: s[0] || '', used: 1 };
}

const MATH_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', times: '×', cdot: '·',
  pm: '±', mp: '∓', infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Rightarrow: '⇒', ldots: '…', dots: '…', cdots: '⋯',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  equiv: '≡', land: '∧', lor: '∨', sim: '∼', simeq: '≃', ll: '≪', gg: '≫', prec: '≺', succ: '≻',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', forall: '∀', exists: '∃',
  partial: '∂', nabla: '∇', perp: '⊥', angle: '∠', degree: '°', circ: '°', prime: '′',
  mid: '|', parallel: '∥', approx: '≈', propto: '∝', emptyset: '∅', cup: '∪', cap: '∩',
  langle: '⟨', rangle: '⟩', vert: '|', Vert: '‖', star: '⋆', ast: '∗', bullet: '•',
  sum: '∑', prod: '∏', int: '∫', oint: '∮', coprod: '∐', bigcup: '⋃', bigcap: '⋂',
  log: 'log', ln: 'ln', lg: 'lg', sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan', exp: 'exp', lim: 'lim', sup: 'sup', inf: 'inf',
  det: 'det', ker: 'ker', dim: 'dim', deg: 'deg', arg: 'arg',
  neg: '¬', dagger: '†', ddagger: '‡', hbar: 'ℏ', ell: 'ℓ', wp: '℘', Re: 'ℜ', Im: 'ℑ',
  // 常见补充（此前缺失会导致命令名被当成普通文字显示）
  div: '÷', oplus: '⊕', otimes: '⊗', odot: '⊙', setminus: '∖', varnothing: '∅',
  therefore: '∴', because: '∵', iff: '⇔', implies: '⇒', impliedby: '⇐',
  leqslant: '⩽', geqslant: '⩾', neq: '≠', triangle: '△', square: '□', checkmark: '✓',
  vdots: '⋮', ddots: '⋱', uparrow: '↑', downarrow: '↓', rightleftharpoons: '⇌',
  mapsto: '↦', longrightarrow: '⟶', longleftarrow: '⟵', longleftrightarrow: '⟷',
  iint: '∬', iiint: '∭',
  overbrace: '⏞', underbrace: '⏟', sqsubseteq: '⊑', sqsupseteq: '⊒', nmid: '∤', mid: '|',
};

/**
 * 「算子名」命令：这类命令名必须用**正体**（roman）排版，并且与后面的参数之间留一个细空格。
 * 早前它们混在 MATH_SYMBOLS 里当普通文本输出，于是 \log 会被渲染成斜体，看起来就是「log 渲染错了」。
 */
const MATH_OPERATORS = {
  log: 'log', ln: 'ln', lg: 'lg', exp: 'exp',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
  lim: 'lim', limsup: 'lim sup', liminf: 'lim inf', max: 'max', min: 'min', sup: 'sup', inf: 'inf',
  gcd: 'gcd', lcm: 'lcm', det: 'det', dim: 'dim', ker: 'ker', deg: 'deg', arg: 'arg', hom: 'hom',
  mod: 'mod', bmod: 'mod', Pr: 'Pr',
};

/** 读取一个参数：跳过前导空白；花括号组或单个字符 */
function readArg(s) {
  let j = 0;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] === '{') {
    const b = readBraced(s.slice(j));
    return { content: b.content, used: j + b.used };
  }
  return { content: s[j] || '', used: j + (s[j] ? 1 : 0) };
}

/**
 * 将 LaTeX 数学片段渲染为 HTML（零依赖内置实现，仿 KaTeX 风格）。
 * 支持：\frac \sqrt \sum \prod \int、\text \operatorname、上下标、花括号分组、
 * 常用希腊字母与运算符符号、\binom、\left/\right、\over。
 */
function mathToHtml(src) {
  const s = String(src == null ? '' : src);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      // 转义符号（\% \$ \& \# \_ \{ \}）与 LaTeX 间距命令（\, \; \: \! \ 空格）
      const nx = s[i + 1];
      if (nx != null && '%$&#_{}'.indexOf(nx) >= 0) { out += escapeHtml(nx); i += 2; continue; }
      if (nx != null && ',;:! '.indexOf(nx) >= 0) { i += 2; continue; }
      const m = s.slice(i).match(/^\\([a-zA-Z]+)/);
      if (m) {
        const cmd = m[1];
        const rest = s.slice(i + m[0].length);
        // 仅作排版提示、不影响内容的命令：直接忽略
        if (cmd === 'displaystyle' || cmd === 'textstyle' || cmd === 'scriptstyle' ||
            cmd === 'limits' || cmd === 'nolimits' || cmd === 'smallskip' || cmd === 'medskip') {
          i += m[0].length;
          continue;
        }
        // 正体算子名（\log \ln \lim \sin \max \bmod …）：必须正体 + 与参数之间留细空格，
        // 且允许带上下限（\lim_{x \to 0}、\max_{1 \le i \le n}）——必须排在 MATH_SYMBOLS 之前判断。
        if (MATH_OPERATORS[cmd] !== undefined) {
          const rest2 = s.slice(i + m[0].length);
          let k = 0;
          let sub = '';
          let sup = '';
          if (rest2[k] === '_') { const a = readArg(rest2.slice(k + 1)); sub = mathToHtml(a.content); k += 1 + a.used; }
          if (rest2[k] === '^') { const a = readArg(rest2.slice(k + 1)); sup = mathToHtml(a.content); k += 1 + a.used; }
          out += `<span class="mm-opname">${escapeHtml(MATH_OPERATORS[cmd])}</span>`;
          if (sub) out += `<sub>${sub}</sub>`;
          if (sup) out += `<sup>${sup}</sup>`;
          i += m[0].length + k;
          continue;
        }
        // 字体类命令：\mathbb{R} / \mathcal{A} 等（没有对应字体时按普通文本渲染，避免出现命令名）
        if (cmd === 'mathbb' || cmd === 'mathcal' || cmd === 'mathfrak' || cmd === 'mathscr' || cmd === 'bm') {
          const a = readArg(rest);
          out += `<span class="mm-text">${escapeHtml(a.content)}</span>`;
          i += m[0].length + a.used;
          continue;
        }
        // \pmod{n} → (mod n)
        if (cmd === 'pmod' || cmd === 'pod') {
          const a = readArg(rest);
          out += `<span class="mm-text">(mod ${mathToHtml(a.content)})</span>`;
          i += m[0].length + a.used;
          continue;
        }
        // \begin{cases} … \end{cases} / \begin{aligned} … \end{aligned} / \begin{array}
        if (cmd === 'begin') {
          const envArg = readArg(rest);
          const env = envArg.content.trim();
          const endTag = '\\end{' + env + '}';
          const endPos = s.indexOf(endTag, i + m[0].length + envArg.used);
          if (endPos >= 0 && ['cases', 'aligned', 'align', 'array', 'matrix', 'pmatrix', 'bmatrix', 'gathered', 'split'].indexOf(env) >= 0) {
            const bodySrc = s.slice(i + m[0].length + envArg.used, endPos);
            const rows = bodySrc.split(/\\\\/).map((r) => r.trim()).filter((r) => r.length);
            const rendered = rows.map((r) => {
              const cells = r.split('&').map((c) => mathToHtml(c.trim()));
              return `<span class="mm-row">${cells.join('<span class="mm-sep"></span>')}</span>`;
            }).join('');
            out += `<span class="mm-table mm-table-${escapeHtml(env)}">${rendered}</span>`;
            i = endPos + endTag.length;
            continue;
          }
        }
        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac' || cmd === 'over') {
          const a = readArg(rest);
          const rest2 = rest.slice(a.used);
          const b = readArg(rest2);
          out += `<span class="mm-frac"><span class="mm-frac-top">${mathToHtml(a.content)}</span><span class="mm-frac-bot">${mathToHtml(b.content)}</span></span>`;
          i += m[0].length + a.used + b.used;
          continue;
        }
        if (cmd === 'binom' || cmd === 'choose') {
          const a = readArg(rest);
          const rest2 = rest.slice(a.used);
          const b = readArg(rest2);
          out += `<span class="mm-bin">(<span class="mm-frac"><span class="mm-frac-top">${mathToHtml(a.content)}</span><span class="mm-frac-bot">${mathToHtml(b.content)}</span></span>)</span>`;
          i += m[0].length + a.used + b.used;
          continue;
        }
        if (cmd === 'sqrt') {
          // 可选根指数 \sqrt[n]{...}
          let a = readArg(rest);
          if (rest[0] === '[') {
            const close = rest.indexOf(']');
            const idx = rest.slice(1, close);
            const restAfter = rest.slice(close + 1);
            a = readArg(restAfter);
            out += `<span class="mm-sqrt"><span class="mm-sqrt-idx">${mathToHtml(idx)}</span><span class="mm-sqrt-sig">√</span><span class="mm-sqrt-ovl">${mathToHtml(a.content)}</span></span>`;
            i += m[0].length + (close + 1) + a.used;
            continue;
          }
          out += `<span class="mm-sqrt"><span class="mm-sqrt-sig">√</span><span class="mm-sqrt-ovl">${mathToHtml(a.content)}</span></span>`;
          i += m[0].length + a.used;
          continue;
        }
        if (cmd === 'sum' || cmd === 'prod' || cmd === 'int' || cmd === 'oint' || cmd === 'coprod' || cmd === 'bigcup' || cmd === 'bigcap') {
          const symbol = { sum: '∑', prod: '∏', int: '∫', oint: '∮', coprod: '∐', bigcup: '⋃', bigcap: '⋂' }[cmd];
          const rest2 = s.slice(i + m[0].length);
          let k = 0;
          let under = '', over = '';
          if (rest2[k] === '_') { const a = readArg(rest2.slice(k + 1)); under = mathToHtml(a.content); k += 1 + a.used; }
          if (rest2[k] === '^') { const a = readArg(rest2.slice(k + 1)); over = mathToHtml(a.content); k += 1 + a.used; }
          const limits = (under || over) ? `<span class="mm-op-lim"><span class="mm-op-over">${over}</span><span class="mm-op-under">${under}</span></span>` : '';
          out += `<span class="mm-op">${symbol}${limits}</span>`;
          i += m[0].length + k;
          continue;
        }
        if (cmd === 'text' || cmd === 'operatorname' || cmd === 'mathrm' || cmd === 'mathbf' || cmd === 'textit' || cmd === 'textbf' || cmd === 'mathsf' || cmd === 'mathtt') {
          const a = readArg(rest);
          out += `<span class="mm-text">${escapeHtml(a.content)}</span>`;
          i += m[0].length + a.used;
          continue;
        }
        if (cmd === 'left' || cmd === 'right' || cmd === 'big' || cmd === 'Big' || cmd === 'bigg' || cmd === 'Bigg') {
          // 定界符：忽略尺寸命令本身，直接处理其后的分隔符（含 \{ \} \| \langle 这类转义写法）
          const delim = { '(': '(', ')': ')', '[': '[', ']': ']', '{': '{', '}': '}', '|': '|', '.': '', langle: '⟨', rangle: '⟩', vert: '|', Vert: '‖' };
          let used = 0;
          let text = '';
          // 先处理 \X 形式的分隔符
          const esc = rest.match(/^\s*\\([{}|]|langle|rangle|vert|Vert)/);
          if (esc) {
            const name = esc[1];
            text = delim[name] != null ? delim[name] : '';
            used = esc[0].length;
          } else {
            const a = readArg(rest);
            text = delim[a.content] != null ? delim[a.content] : mathToHtml(a.content);
            used = a.used;
          }
          out += text;
          i += m[0].length + used;
          continue;
        }
        if (cmd === 'underline' || cmd === 'overline') {
          const a = readArg(rest);
          out += `<span style="${cmd === 'underline' ? 'text-decoration:underline' : 'text-decoration:overline'}">${mathToHtml(a.content)}</span>`;
          i += m[0].length + a.used;
          continue;
        }
        if (cmd === 'vec' || cmd === 'hat' || cmd === 'bar' || cmd === 'dot' || cmd === 'ddot' || cmd === 'tilde') {
          const a = readArg(rest);
          const mark = { vec: '→', hat: '^', bar: '¯', dot: '˙', ddot: '¨', tilde: '˜' }[cmd];
          out += `<span class="mm-accent"><span class="mm-accent-top">${mark}</span>${mathToHtml(a.content)}</span>`;
          i += m[0].length + a.used;
          continue;
        }
        // \overset{上}{下} / \underset{下}{上} / \stackrel{上}{下}
        if (cmd === 'overset' || cmd === 'stackrel' || cmd === 'underset') {
          const a = readArg(rest);
          const rest2 = rest.slice(a.used);
          const b = readArg(rest2);
          const top = mathToHtml(a.content);
          const base = mathToHtml(b.content);
          out += (cmd === 'underset')
            ? `<span class="mm-accent"><span class="mm-accent-top">${base}</span>${top}</span>`
            : `<span class="mm-accent"><span class="mm-accent-top">${top}</span>${base}</span>`;
          i += m[0].length + a.used + b.used;
          continue;
        }
        if (cmd === 'quad' || cmd === 'qquad') { out += cmd === 'quad' ? ' ' : '  '; i += m[0].length; continue; }
        if (cmd === '\\') { out += ' '; i += m[0].length; continue; }
        if (MATH_SYMBOLS[cmd] !== undefined) {
          out += MATH_SYMBOLS[cmd];
          i += m[0].length;
          continue;
        }
        out += escapeHtml(cmd);
        i += m[0].length;
        continue;
      }
      out += '\\';
      i++;
      continue;
    }
    if (ch === '^') {
      const a = readArg(s.slice(i + 1));
      out += `<sup>${mathToHtml(a.content)}</sup>`;
      i += 1 + a.used;
      continue;
    }
    if (ch === '_') {
      const a = readArg(s.slice(i + 1));
      out += `<sub>${mathToHtml(a.content)}</sub>`;
      i += 1 + a.used;
      continue;
    }
    if (ch === '{') {
      const a = readBraced(s.slice(i));
      out += mathToHtml(a.content);
      i += a.used;
      continue;
    }
    if (ch === '}') { i++; continue; }
    if (ch === '~') { out += ' '; i++; continue; }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

/** 内联元素：行内代码、加粗、斜体、链接 */
function renderInline(text) {
  // 先提取行内代码，防止其它规则污染代码内容
  const codeTokens = [];
  let s = text.replace(/`([^`]+)`/g, (m, c) => {
    codeTokens.push(c);
    return `\u0000CODE${codeTokens.length - 1}\u0000`;
  });
  // 行内数学 $...$ 已在 markdownToHtml 中先行提取（避免 HTML 转义污染 LaTeX）
  // 链接 [text](url)：允许 http(s)/mailto、锚点 #、站内相对路径（如 DEPLOYMENT.md、USAGE.md#章节），拦截危险协议
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
    let href = u;
    if (/^(javascript:|data:|vbscript:|file:)/i.test(href)) href = '#';
    const external = /^(https?:|mailto:)/i.test(href);
    return `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${renderInline(t)}</a>`;
  });
  // 图片 ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) => {
    if (!/^https?:/i.test(u)) return escapeHtml(alt);
    return `<img src="${escapeHtml(u)}" alt="${escapeHtml(alt)}" />`;
  });
  // 加粗 ** **
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体 * *
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // 删除线 ~~ ~~
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // 恢复行内代码（内容已在 markdownTextToHtml 开头整体转义过，此处不再转义，避免 & 变 &amp;amp;）
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => `<code>${codeTokens[+i]}</code>`);
  return s;
}

/** Markdown 文本（不含 $$ 块）→ HTML（安全：先转义，不支持原始 HTML）。opts.headingIds=true 时给标题加 id 锚点 */
function markdownTextToHtml(text, opts = {}) {
  const src = String(text == null ? '' : text);
  // 先转义全部 HTML，杜绝注入
  const lines = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('\n');

  const out = [];
  let i = 0;
  let inList = null; // 'ul' | 'ol'
  let inQuote = false;
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];

  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  const closePara = () => { if (out.length && out[out.length - 1].startsWith('<p>')) out.push('</p>'); };

  /**
   * 是否是「表头 + 分隔行」构成的表格起始（表格分支与段落合并共用同一判断）。
   * 注意：判断必须严格——只有下一行真的是 |---|---| 形式才算表格；
   * 否则「含 | 的一行，下一行恰好含 -」会被误判，导致段落合并一行都不消费而空转。
   */
  const isTableStart = (idx) => {
    const cur = lines[idx];
    if (cur == null || !cur.includes('|')) return false;
    const next = lines[idx + 1];
    if (next == null || !next.includes('-')) return false;
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next);
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块（允许最多 3 个空格缩进：面板/部署文档里常把代码块写在列表项内）
    if (/^ {0,3}```/.test(line)) {
      if (!inCode) {
        closeList(); closeQuote();
        codeLang = line.replace(/^ {0,3}```\s*/, '').trim();
        inCode = true; codeBuf = [];
      } else {
        const html = `<pre><code${codeLang ? ` class="lang-${escapeHtml(codeLang)}"` : ''}>${codeBuf.join('\n')}</code></pre>`;
        out.push(html);
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // 水平线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList(); closeQuote();
      out.push('<hr />');
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList(); closeQuote();
      const level = h[1].length;
      const title = h[2];
      // 标题 id：去掉 Markdown 标记后 slug 化（供文档站内锚点跳转）
      const id = opts.headingIds ? slugify(title) : '';
      out.push(`<h${level}${id ? ` id="${id}"` : ''}>${renderInline(title)}</h${level}>`);
      i++;
      continue;
    }

    // 表格：本行是表头且下一行是分隔行
    if (isTableStart(i)) {
      closeList(); closeQuote();
      const headerCells = splitRow(line);
      const alignRow = splitRow(lines[i + 1]);
      const aligns = alignRow.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : 'left'));
      out.push('<table><thead><tr>' + headerCells.map((c, idx) => `<th style="text-align:${aligns[idx] || 'left'}">${renderInline(c)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        out.push('<tr>' + cells.map((c, idx) => `<td style="text-align:${aligns[idx] || 'left'}">${renderInline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      out.push('</tbody></table>');
      continue;
    }

    // 引用块（注意：本函数入口已把 < > & 转义，所以这里要同时接受 ">" 与 "&gt;"）
    const q = line.match(/^\s*(?:&gt;|>)\s?(.*)$/);
    if (q) {
      closeList();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${renderInline(q[1])}</p>`);
      i++;
      continue;
    } else if (inQuote) {
      closeQuote();
      continue;
    }

    // 无序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      closeQuote();
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      i++;
      continue;
    }

    // 有序列表
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      closeQuote();
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${renderInline(ol[1])}</li>`);
      i++;
      continue;
    }

    // 空行：段落/列表结束
    if (/^\s*$/.test(line)) {
      closeList(); closeQuote();
      if (out.length && out[out.length - 1] === '<p>') out.pop();
      i++;
      continue;
    }

    // 普通段落（合并连续行）
    //   首行必须被消费：否则「当前行满足结束条件但又不是表格/标题」时 i 不前进，服务端会死循环
    //   （例如正文里写「a|b」下一行是「1-100」这种：含 | 且下一行含 -，但并不是表格）
    closeList(); closeQuote();
    const para = [];
    while (i < lines.length) {
      const cur = lines[i];
      const stop = /^\s*$/.test(cur)
        || /^(#{1,6}\s| {0,3}```|[-*+]\s|\d+[.)]\s|(?:&gt;|>)\s?)/.test(cur)
        || isTableStart(i);
      if (para.length && stop) break;
      para.push(cur);
      i++;
    }
    out.push(`<p>${renderInline(para.join('<br />'))}</p>`);
  }

  closeList(); closeQuote();
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);

  return out.join('\n');
}

/** Markdown → HTML：先提取 $$ 块级与 $ 行内数学（在 HTML 转义之前），再渲染其余文本。opts.headingIds=true 时给标题加 id 锚点 */
function markdownToHtml(md, opts = {}) {
  const raw = String(md == null ? '' : md);
  // 1) 块级数学 $$...$$（可跨行）
  const blocks = [];
  let s = raw.replace(/\$\$([\s\S]+?)\$\$/g, (m, c) => {
    blocks.push(c);
    return `\u0002B${blocks.length - 1}\u0002`;
  });
  // 1b) 独占一整行的 $...$ 同样按「行间公式」排版（洛谷等站点也这样处理）
  s = s.replace(/^[ \t]*\$([^$\n]+)\$[ \t]*$/gm, (m, c) => {
    blocks.push(c);
    return `\u0002B${blocks.length - 1}\u0002`;
  });
  // 2) 行内数学 $...$
  //    注意：独占一整行的 $...$ 已在上面按「行间公式」处理 —— 否则这类公式会被塞进段落里：
  //    \sum 的上下限挤在符号旁、分式缩水，或（加了 displaystyle 后）把整段行高撑高且不居中，观感不对。
  const inlines = [];
  s = s.replace(/\$([^$\n]+)\$/g, (m, c) => {
    inlines.push(c);
    return `\u0001M${inlines.length - 1}\u0001`;
  });
  // 3) 渲染文本（占位符不含 &<> 等字符，不受 HTML 转义影响）
  let html = markdownTextToHtml(s, opts);
  // 4) 回填行内数学（保持在段落内）
  html = html.replace(/\u0001M(\d+)\u0001/g, (m, i) => {
    const c = inlines[+i];
    return `<span class="math" data-latex="${escapeHtml(c)}">${mathToHtml(c)}</span>`;
  });
  // 5) 回填块级数学：独立成段的占位符直接替换为块；夹在段落中的拆出段落
  html = html.replace(/(<p[^>]*>)?\u0002B(\d+)\u0002(<\/p>)?/g, (m, p1, i, p3) => {
    const blockHtml = `<div class="math-block" data-latex="${escapeHtml(blocks[+i])}">${mathToHtml(blocks[+i])}</div>`;
    if (p1 && p3) return blockHtml;
    if (p1) return `</p>${blockHtml}<p>`;
    if (p3) return `${blockHtml}</p>`;
    return blockHtml;
  });
  return html;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  // 结尾的 | 是表格边框；但 \| 是「单元格里的竖线」，不能当成边框去掉
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // 按「未转义的竖线」切分单元格，再把 \| 还原成普通竖线
  // （否则表格里写 `curl … \| sh` 会被切成多个单元格，整张表错位）
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** 标题 slug：去 Markdown 标记与符号，保留中文/字母数字，用于锚点 id（如「5. 子任务计分方式（sum / min / max / bundle）」→「5-子任务计分方式summinmaxbundle」） */
function slugify(title) {
  return String(title)
    .replace(/[*_`~]/g, '')      // 去 Markdown 强调/代码标记
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // 去符号（保留字母数字中文空白与连字符）
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

module.exports = { markdownToHtml, mathToHtml, slugify };
