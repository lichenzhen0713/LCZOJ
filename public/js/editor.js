'use strict';

/* ============================================================================
   代码编辑器（零依赖）
   ----------------------------------------------------------------------------
   结构：
     <div class="editor">
       <div class="editor-head">语言 · 字符数 ·（必要时的提示）</div>
       <div class="editor-body">
         <div class="editor-gutter">行号</div>
         <div class="editor-wrap">
           <pre aria-hidden="true">高亮层（不接收事件，只负责上色）</pre>
           <textarea>输入层（文字透明，只显示光标与选区）</textarea>
         </div>
       </div>
     </div>

   ★ 这次重写解决的三个卡顿（都是实测出来的，不是猜的）
   1) 粘贴长代码卡死：
      浏览器的「插入文本」是**逐字符**走的（execCommand/IME 路径），实测把 71KB 插进
      一个**最普通的 textarea** 就要 5.7 秒，1200 行提交框里一次粘贴 6.8 秒、6000 行直接卡死。
      而 `textarea.value = 文本` 只要 4.2ms —— 所以现在**拦截 paste 事件**，
      自己拼好新内容一次性赋值，粘贴 71KB 从 ~6 秒降到 ~10 毫秒。
      （同时维护自己的撤销/重做栈，粘贴后 Ctrl+Z 仍能撤回；光标自动滚进可视区。）
   2) 一整份代码都塞进 <pre>：浏览器要为 71KB 不换行文本做整体排版与绘制。
      现在超过阈值（20000 字符 / 800 行）后**只渲染可视区那几十行**（高亮层与行号都虚拟化），
      并带上这一屏开头的词法状态，跨行注释/长字符串颜色依旧正确；渲染开销与文件大小无关。
   3) 每次输入都强制同步重排：`clientHeight` / `scrollWidth` 之类的读取夹在写 DOM 之间会
      触发「读写交替」的强制重排。现在可视高度用 ResizeObserver 缓存、行号列宽只在位数变化时写、
      滚动渲染还会做签名比对跳过无变化的重复写入。
   ========================================================================== */

/* --- 语法高亮规则：Python / JS / C / C++ / Java --- */
const KEYWORDS = {
  python: ['False','None','True','and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield','print','range','len','int','str','float','list','dict','set','input','map','sorted','min','max','sum','abs'],
  javascript: ['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','typeof','instanceof','class','extends','super','this','try','catch','finally','throw','async','await','of','in','null','undefined','true','false','import','export','default','console','Math','JSON','Promise','async'],
  cpp: ['alignas','alignof','auto','bool','break','case','catch','char','class','const','constexpr','continue','default','delete','do','double','else','enum','explicit','false','float','for','friend','if','inline','int','long','namespace','new','nullptr','operator','private','protected','public','return','short','signed','sizeof','static','struct','switch','template','this','throw','true','try','typedef','typename','union','unsigned','using','virtual','void','volatile','while','include','define','std','vector','string','map','set','queue','stack','pair','printf','scanf','cin','cout','endl','using'],
  c: ['auto','bool','break','case','char','const','continue','default','do','double','else','enum','extern','false','float','for','if','inline','int','long','register','return','short','signed','sizeof','static','struct','switch','true','typedef','union','unsigned','void','volatile','while','include','define','printf','scanf','NULL','malloc','free','FILE'],
  java: ['abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','if','implements','import','instanceof','int','interface','long','native','new','null','package','private','protected','public','return','short','static','super','switch','synchronized','this','throw','throws','true','try','void','volatile','while','String','System','out','println','main','class'],
};

function rulesFor(lang) {
  const kw = (KEYWORDS[lang] || KEYWORDS.cpp).slice().sort((a, b) => b.length - a.length);
  const kwRe = new RegExp('\\b(?:' + kw.join('|') + ')\\b');
  const rules = [];
  if (lang === 'python') {
    rules.push({ re: /#[^\n]*/, cls: 'tok-com' });
    rules.push({ re: /"""[\s\S]*?"""|'''[\s\S]*?'''/, cls: 'tok-str' });
  } else {
    rules.push({ re: /\/\*[\s\S]*?\*\//, cls: 'tok-com' });
    rules.push({ re: /\/\/[^\n]*/, cls: 'tok-com' });
  }
  if (lang === 'javascript') rules.push({ re: /`(?:[^`\\]|\\.)*`/, cls: 'tok-str' });
  rules.push({ re: /"(?:[^"\\\n]|\\.)*"/, cls: 'tok-str' });
  rules.push({ re: /'(?:[^'\\\n]|\\.)*'/, cls: 'tok-str' });
  rules.push({ re: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: 'tok-num' });
  rules.push({ re: kwRe, cls: 'tok-kw' });
  rules.push({ re: /\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, cls: 'tok-fn' });
  return rules;
}

/** 跨行结构状态：0 普通、1 块注释、2 Python 三引号、3 JS 模板串 */
const CLOSER_OF = { 1: '*/', 2: '"""', 3: '`' };

/** 跳过字符串字面量，返回闭合引号之后的位置（未闭合则停在行尾 / 文末） */
function skipQuoted(text, i, quote) {
  const multiline = quote === '`';
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === quote) return j + 1;
    if (!multiline && c === '\n') return j;
  }
  return text.length;
}

/** 扫描 [0, end) 前缀，返回进入 end 位置时仍处于的跨行结构（不在结构中返回 0） */
function scanMultilineState(text, end, lang) {
  const limit = Math.min(end, text.length);
  let i = 0;
  let guard = 0;
  while (i < limit && guard++ < 5e6) {
    if (lang === 'python') {
      const triple = text.startsWith('"""', i) ? '"""' : (text.startsWith("'''", i) ? "'''" : '');
      if (triple) {
        const j = text.indexOf(triple, i + 3);
        if (j < 0 || j + 3 > limit) return 2;
        i = j + 3;
        continue;
      }
      const c = text[i];
      if (c === '#') { const j = text.indexOf('\n', i); i = (j < 0 || j >= limit) ? limit : j + 1; continue; }
      if (c === '"' || c === "'") { i = skipQuoted(text, i, c); continue; }
      i++;
    } else {
      if (text.startsWith('/*', i)) {
        const j = text.indexOf('*/', i + 2);
        if (j < 0 || j + 2 > limit) return 1;
        i = j + 2;
        continue;
      }
      if (text.startsWith('//', i)) { const j = text.indexOf('\n', i); i = (j < 0 || j >= limit) ? limit : j + 1; continue; }
      const c = text[i];
      if (c === '"' || c === "'" || (lang === 'javascript' && c === '`')) {
        const next = skipQuoted(text, i, c);
        if (c === '`' && next >= limit && text.indexOf('`', i + 1) < 0) return 3;
        i = next;
        continue;
      }
      i++;
    }
  }
  return 0;
}

/**
 * 把一段代码高亮成 HTML。
 * startState：该段开头所处的跨行结构（可视区渲染时由 scanMultilineState 提供）——
 * 有它才能把「上一屏就开始的块注释 / 三引号字符串」在这一屏继续着色。
 */
function highlight(code, lang, startState = 0) {
  const rules = rulesFor(lang);
  const combined = new RegExp(rules.map((r) => '(' + r.re.source + ')').join('|'), 'g');
  let out = '';
  let last = 0;
  if (startState) {
    let stop;
    if (startState === 2) {
      const a = code.indexOf('"""');
      const b = code.indexOf("'''");
      stop = a < 0 ? b : (b < 0 ? a : Math.min(a, b));
      stop = stop < 0 ? code.length : stop + 3;
    } else {
      const closer = CLOSER_OF[startState] || '';
      const idx = closer ? code.indexOf(closer) : -1;
      stop = idx < 0 ? code.length : idx + closer.length;
    }
    out += `<span class="${startState === 1 ? 'tok-com' : 'tok-str'}">${escapeHtml(code.slice(0, stop))}</span>`;
    last = stop;
  }
  combined.lastIndex = last;
  let m;
  while ((m = combined.exec(code)) !== null) {
    out += escapeHtml(code.slice(last, m.index));
    let cls = 'tok-str';
    for (let g = 1; g <= rules.length; g++) {
      if (m[g] !== undefined) { cls = rules[g - 1].cls; break; }
    }
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) combined.lastIndex++;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

/* --- 编辑器组件 --- */
function createEditor(container, opts = {}) {
  let language = opts.language || 'cpp';
  const onChange = opts.onChange || (() => {});

  container.classList.add('editor');
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'editor-head';
  const headLang = document.createElement('span');
  headLang.textContent = (LANG_NAMES[language] || language);
  headLang.hidden = !headLang.textContent;   // 空语言名（自动识别）时整块隐藏
  const headCount = document.createElement('span');
  headCount.textContent = '0 字符';
  head.appendChild(headLang);
  head.appendChild(headCount);

  const body = document.createElement('div');
  body.className = 'editor-body';

  const gutter = document.createElement('div');
  gutter.className = 'editor-gutter';

  const wrap = document.createElement('div');
  wrap.className = 'editor-wrap';
  const pre = document.createElement('pre');
  pre.setAttribute('aria-hidden', 'true');
  const ta = document.createElement('textarea');
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.autocomplete = 'off';
  ta.setAttribute('wrap', 'off');
  wrap.appendChild(pre);
  wrap.appendChild(ta);
  // 自定义滚动条（文本框自身的滚动条被 CSS 隐藏，否则会挤窄文本并与高亮层错位）
  const scrollbar = document.createElement('div');
  scrollbar.className = 'editor-scroll';
  const scrollThumb = document.createElement('i');
  scrollbar.appendChild(scrollThumb);
  wrap.appendChild(scrollbar);
  body.appendChild(gutter);
  body.appendChild(wrap);

  container.appendChild(head);
  container.appendChild(body);

  ta.value = opts.value || '';

  /* ---- 阈值与状态 ---- */
  const FULL_HL_CHARS = 8000;    // 超过这个字符数 → 可视区渲染
  const FULL_HL_LINES = 300;     // 超过这个行数 → 可视区渲染
  const SLICE_HL_LIMIT = 20000;  // 单屏内容超过这个长度（超长单行）→ 这一屏不做高亮
  const OVERSCAN = 10;           // 可视区上下各多渲染的行数
  const UNDO_MAX = 40;

  let virtualMode = false;
  let lineStarts = [0];
  let lineCount = 1;
  let lineHeight = 20.8;         // 实测平均行高（CSS 为 13px × 1.6）
  let padTop = 12;
  let padBottom = 12;
  let viewH = 320;               // 缓存的可视高度（避免每帧读 clientHeight 触发强制重排）
  let needRemetric = true;
  let lastFullGutterLines = -1;
  let lastGutterWidth = '';
  let lastCountText = '';
  let rafId = 0;
  let scrollRafId = 0;
  let noticeEl = null;
  let contentDirty = true;       // 输入/换语言/赋值后置位，滚动渲染不必重复写 DOM
  let lastWindow = '';
  let lastGutterSig = '';
  let typingUntil = 0;           // 连续输入期间先不做语法着色（停手后补上）
  let hlTimer = 0;
  let caretJump = -1;            // 渲染后把该偏移处的光标滚进可视区
  const undoStack = [];
  const redoStack = [];

  function setNotice(text) {
    if (text && !noticeEl) {
      noticeEl = document.createElement('div');
      noticeEl.className = 'editor-notice';
      head.appendChild(noticeEl);
    }
    if (noticeEl) {
      if (text) noticeEl.textContent = text;
      else { noticeEl.remove(); noticeEl = null; }
    }
  }

  /** 实测行高：用「300 行 / 600 行」两段文本的 scrollHeight 差求平均行高。
   *  （之前用 1 行 / 2 行相减：滚动区高度不足时 scrollHeight 会返回元素高度，差值恒为 0；
   *   即便能量出来，整数取整也会带来 0.2px 误差 —— 在 6000 行处会累积成整整一行（20px）的错位。）
   *  取 300 行可以把这个误差摊薄到 1/300 以下。 */
  function measureMetrics() {
    const cs = getComputedStyle(pre);
    padTop = parseFloat(cs.paddingTop) || 12;
    padBottom = parseFloat(cs.paddingBottom) || 12;
    const keep = pre.innerHTML;
    pre.textContent = 'x\n'.repeat(300);
    const h1 = pre.scrollHeight;
    pre.textContent = 'x\n'.repeat(600);
    const h2 = pre.scrollHeight;
    pre.innerHTML = keep;
    const lh = (h2 - h1) / 300;
    if (lh > 4 && lh < 200) lineHeight = lh;
    needRemetric = false;
  }

  /** 行首偏移表：单次 O(n) 扫描，滚动时只做切窗口 */
  function rebuildIndex(v) {
    const starts = [0];
    let idx = v.indexOf('\n');
    while (idx !== -1) {
      starts.push(idx + 1);
      idx = v.indexOf('\n', idx + 1);
    }
    lineStarts = starts;
    lineCount = starts.length;
  }

  /** 二分查出某个偏移所在的行号（0 基） */
  function lineAtOffset(offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** 行号列宽度按总行数锁定（行号列是绝对定位的，宽度只影响主体左侧留白） */
  function applyGutterWidth() {
    const w = String(lineCount).length * 8 + 24;
    if (w === lastGutterWidth) return;
    lastGutterWidth = w;
    gutter.style.width = w + 'px';
    body.style.paddingLeft = w + 'px';
  }

  function renderFull(v) {
    pre.style.paddingTop = '';
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    pre.innerHTML = highlight(v, language);
    if (lineCount !== lastFullGutterLines) {
      lastFullGutterLines = lineCount;
      let html = '';
      for (let i = 1; i <= lineCount; i++) html += '<div>' + i + '</div>';
      gutter.innerHTML = html;
    }
    gutter.scrollTop = ta.scrollTop;
    lastWindow = '';
  }

  function renderVirtual(v, forceHl) {
    if (needRemetric) measureMetrics();
    const scrollTop = ta.scrollTop;
    const scrollLeft = ta.scrollLeft;

    // 内容总高度：只有真的溢出时才用它做定位（否则 scrollHeight 会返回元素自身高度）。
    // 用「比例定位」而不是 first×行高：行高只要差 0.003px，在 6000 行处就会累积成一行（20px）的错位；
    // 而 (first/lineCount)×内容高度 的误差被限制在 1px 以内，滚到多深都不会漂。
    const sh = ta.scrollHeight;
    const overflow = sh > ta.clientHeight + 8;
    const contentH = overflow ? Math.max(1, sh - padTop - padBottom) : 0;
    const lhAvg = overflow ? contentH / lineCount : lineHeight;

    const count = Math.ceil(viewH / lhAvg) + OVERSCAN * 2 + 2;
    let first = Math.floor((scrollTop - padTop) / lhAvg) - OVERSCAN;
    if (first < 0) first = 0;
    else if (first > lineCount - count) first = Math.max(0, lineCount - count);
    const last = Math.min(lineCount, first + count);
    let offset = first * lhAvg - scrollTop;                 // 行高已知时的定位
    if (overflow) {
      const byRatio = (first / lineCount) * contentH - scrollTop;
      if (Math.abs(byRatio - offset) < lineHeight * 4) offset = byRatio;   // 明显异常时保留行高算法
    }

    // 正在连续输入时先不做语法着色（只写纯文本），停手 ~130ms 后再上色：
    // 每次按键都重建几百个 <span> 会让长代码的输入明显发涩。
    const useHl = !!forceHl || Date.now() > typingUntil;

    const sig = first + ':' + last + ':' + offset + ':' + scrollLeft + ':' + (useHl ? 'h' : 'p');
    if (!contentDirty && sig === lastWindow) return;
    lastWindow = sig;
    contentDirty = false;

    const startOff = lineStarts[first];
    const endOff = last < lineCount ? lineStarts[last] : v.length;
    const slice = v.slice(startOff, endOff);

    let html;
    if (!useHl || slice.length > SLICE_HL_LIMIT) {
      html = escapeHtml(slice);
      setNotice(slice.length > SLICE_HL_LIMIT ? '超长单行代码：这一屏未做语法着色（不影响提交与评测）' : '');
    } else {
      const state = startOff > 0 ? scanMultilineState(v, startOff, language) : 0;
      html = highlight(slice, language, state);
      setNotice('');
    }
    pre.style.paddingTop = '';
    pre.scrollTop = 0;
    pre.innerHTML = '<div class="editor-slice" style="margin-top:' + offset + 'px">' + html + '</div>';

    // 行号窗口没变就不重建（输入时窗口通常不动，省掉一次 40 个 div 的布局）
    const gSig = first + ':' + last + ':' + offset;
    if (gSig !== lastGutterSig) {
      lastGutterSig = gSig;
      let gHtml = '<div class="editor-slice" style="margin-top:' + offset + 'px">';
      for (let i = first; i < last; i++) gHtml += '<div>' + (i + 1) + '</div>';
      gHtml += '</div>';
      gutter.innerHTML = gHtml;
      gutter.scrollTop = 0;
      lastFullGutterLines = -1;
    }

    // 横向对齐：文本域可能横向滚到比这一屏更宽的位置（屏幕外有超长行），必要时补占位撑开
    if (scrollLeft > 0) {
      pre.scrollLeft = scrollLeft;
      const need = scrollLeft + ta.clientWidth;
      if (pre.scrollWidth < need) {
        const spacer = document.createElement('span');
        spacer.className = 'editor-spacer';
        spacer.style.cssText = 'display:inline-block;height:0;width:' + (need - pre.scrollWidth + 8) + 'px';
        pre.firstChild.appendChild(spacer);
        pre.scrollLeft = scrollLeft;
      }
    } else {
      pre.scrollLeft = 0;
    }
  }

  /** 立即重绘（可视区或全文） */
  function render() {
    const v = ta.value;
    rebuildIndex(v);
    applyGutterWidth();
    const wantVirtual = v.length > FULL_HL_CHARS || lineCount > FULL_HL_LINES;
    if (wantVirtual !== virtualMode) {
      virtualMode = wantVirtual;
      lastFullGutterLines = -1;
      lastWindow = '';
      if (!virtualMode) { gutter.innerHTML = ''; gutter.scrollTop = ta.scrollTop; setNotice(''); }
    }
    if (virtualMode) renderVirtual(v);
    else renderFull(v);
    const ct = v.length + ' 字符';
    if (ct !== lastCountText) { lastCountText = ct; headCount.textContent = ct; }
    if (caretJump >= 0) { scrollCaretIntoView(caretJump); caretJump = -1; }
    updateScrollbar();
  }

  /** 把某个偏移处的光标滚进可视区（粘贴后要用，否则插入点可能在屏幕外） */
  function scrollCaretIntoView(offset) {
    const line = lineAtOffset(Math.max(0, Math.min(offset, ta.value.length)));
    const top = padTop + line * lineHeight;
    const bottom = top + lineHeight;
    if (top < ta.scrollTop + padTop) ta.scrollTop = Math.max(0, top - padTop);
    else if (bottom > ta.scrollTop + viewH - padTop) ta.scrollTop = bottom - viewH + padTop;
  }

  /** 输入按帧合并；同时把「语法着色」推迟到停手之后 */
  function sync() {
    contentDirty = true;
    typingUntil = Date.now() + 130;
    if (hlTimer) clearTimeout(hlTimer);
    hlTimer = setTimeout(() => {
      hlTimer = 0;
      contentDirty = true;
      if (virtualMode) renderVirtual(ta.value, true);
    }, 140);
    if (rafId) return;
    rafId = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame(() => { rafId = 0; render(); onChange(ta.value); })
      : setTimeout(() => { rafId = 0; render(); onChange(ta.value); }, 16);
  }

  /** 滚动：可视区模式下要重画窗口，同样按帧合并 */
  function syncScroll() {
    updateScrollbar();
    if (virtualMode) {
      if (scrollRafId) return;
      scrollRafId = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(() => { scrollRafId = 0; renderVirtual(ta.value); })
        : setTimeout(() => { scrollRafId = 0; renderVirtual(ta.value); }, 16);
      return;
    }
    gutter.scrollTop = ta.scrollTop;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }

  /* ---------- 自定义滚动条：内容超出视口时显示，可拖动 / 滚轮 ---------- */
  function updateScrollbar() {
    const h = viewH || ta.clientHeight || 280;
    const sh = ta.scrollHeight;
    if (sh <= h + 4) {
      scrollbar.classList.add('hidden');
      return;
    }
    scrollbar.classList.remove('hidden');
    const track = h;
    const thumbH = Math.max(28, Math.round(track * h / sh));
    const maxTop = Math.max(0, track - thumbH);
    const ratio = sh > h ? ta.scrollTop / (sh - h) : 0;
    scrollThumb.style.height = thumbH + 'px';
    scrollThumb.style.top = Math.round(maxTop * ratio) + 'px';
  }

  if (typeof scrollbar.addEventListener === 'function') {
    let dragging = false;
    let dragStartY = 0;
    let dragStartTop = 0;
    const onMove = (e) => {
      if (!dragging) return;
      const h = viewH || ta.clientHeight || 280;
      const sh = ta.scrollHeight;
      const thumbH = Math.max(28, Math.round(h * h / sh));
      const maxTop = Math.max(1, h - thumbH);
      const delta = (e.clientY - dragStartY) * ((sh - h) / maxTop);
      ta.scrollTop = Math.max(0, Math.min(sh - h, dragStartTop + delta));
      e.preventDefault();
    };
    const onUp = () => {
      dragging = false;
      scrollbar.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    scrollbar.addEventListener('pointerdown', (e) => {
      const rect = scrollThumb.getBoundingClientRect();
      const onThumb = e.clientY >= rect.top && e.clientY <= rect.bottom;
      dragging = true;
      dragStartY = e.clientY;
      if (onThumb) {
        dragStartTop = ta.scrollTop;
      } else {
        // 点空白处：直接把滑块中心移到点击位置
        const h = viewH || ta.clientHeight || 280;
        const sh = ta.scrollHeight;
        const thumbH = Math.max(28, Math.round(h * h / sh));
        const maxTop = Math.max(1, h - thumbH);
        const clickTop = e.clientY - scrollbar.getBoundingClientRect().top - thumbH / 2;
        dragStartTop = Math.max(0, Math.min(sh - h, (clickTop / maxTop) * (sh - h)));
        ta.scrollTop = dragStartTop;
      }
      scrollbar.classList.add('dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      e.preventDefault();
      e.stopPropagation();
    });
    scrollbar.addEventListener('wheel', (e) => {
      ta.scrollTop += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  /* ---------- 粘贴：一次性赋值，绕开浏览器的逐字符插入 ---------- */
  function pushUndo(value, start, end) {
    undoStack.push({ value, start, end });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  function applySnapshot(from, to) {
    const snap = from.pop();
    if (!snap) return false;
    to.push({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
    ta.value = snap.value;
    ta.setSelectionRange(Math.min(snap.start, snap.value.length), Math.min(snap.end, snap.value.length));
    caretJump = snap.start;
    sync();
    return true;
  }

  /** 在选区处一次性插入文本（与浏览器粘贴语义一致，但快得多） */
  function insertAtSelection(text) {
    const v = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    pushUndo(v, s, e);
    ta.value = v.slice(0, s) + text + v.slice(e);
    const caret = s + text.length;
    ta.setSelectionRange(caret, caret);
    caretJump = caret;
    sync();
  }

  ta.addEventListener('paste', (ev) => {
    const dt = ev.clipboardData;
    if (!dt) return;
    let text = '';
    try { text = dt.getData('text/plain') || ''; } catch { text = ''; }
    if (!text) return;                      // 图片 / 文件等非文本粘贴交给默认行为
    ev.preventDefault();
    insertAtSelection(text);
  });

  ta.addEventListener('drop', (ev) => {
    const dt = ev.dataTransfer;
    if (!dt || (dt.files && dt.files.length)) return;   // 拖入文件交给上传逻辑
    let text = '';
    try { text = dt.getData('text/plain') || ''; } catch { text = ''; }
    if (!text) return;
    ev.preventDefault();
    insertAtSelection(text);
  });

  ta.addEventListener('input', sync);
  ta.addEventListener('scroll', syncScroll, { passive: true });

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const k = (e.key || '').toLowerCase();
      if (k === 'z') {
        const ok = e.shiftKey ? applySnapshot(redoStack, undoStack) : applySnapshot(undoStack, redoStack);
        if (ok) { e.preventDefault(); return; }
      } else if (k === 'y') {
        if (applySnapshot(redoStack, undoStack)) { e.preventDefault(); return; }
      }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      if (s !== en) {
        // 多行选中：整体缩进 / 反缩进
        const v = ta.value;
        const blockStart = v.lastIndexOf('\n', s - 1) + 1;
        const blockEnd = v.indexOf('\n', en) < 0 ? v.length : v.indexOf('\n', en);
        const block = v.slice(blockStart, blockEnd);
        const shifted = block.split('\n').map((l) => (e.shiftKey ? l.replace(/^ {1,4}/, '') : '    ' + l)).join('\n');
        ta.value = v.slice(0, blockStart) + shifted + v.slice(blockEnd);
        ta.setSelectionRange(blockStart, blockStart + shifted.length);
        sync();
        return;
      }
      ta.setRangeText(e.shiftKey ? '' : '    ', s, en, 'end');
      sync();
      return;
    }
    if (e.key === 'Enter') {
      // 自动缩进：复制上一行行首空白；上一行以 : 或 { 结尾时再多缩进一层
      const s = ta.selectionStart;
      const before = ta.value.slice(0, s);
      const lineStart = before.lastIndexOf('\n') + 1;
      const indentMatch = before.slice(lineStart).match(/^[ \t]*/);
      const indent = indentMatch ? indentMatch[0] : '';
      const lastLine = before.slice(lineStart).trimEnd();
      const extra = /[:{]\s*$/.test(lastLine) ? '    ' : '';
      e.preventDefault();
      ta.setRangeText('\n' + indent + extra, s, s, 'end');
      sync();
      return;
    }
  });

  /* 可视高度缓存：只在尺寸真的变化时读，避免每帧「写 DOM → 读布局」的强制重排 */
  viewH = ta.clientHeight || viewH;
  if (typeof ResizeObserver === 'function') {
    try {
      new ResizeObserver(() => { needRemetric = true; viewH = ta.clientHeight || viewH; contentDirty = true; sync(); }).observe(ta);
    } catch { /* ignore */ }
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { needRemetric = true; viewH = ta.clientHeight || viewH; sync(); });
  }

  render();
  onChange(ta.value);
  syncScroll();

  return {
    getValue: () => ta.value,
    setValue(v) {
      ta.value = v;
      lastFullGutterLines = -1;
      lastWindow = '';
      contentDirty = true;
      needRemetric = false;
      if (rafId) { try { cancelAnimationFrame(rafId); } catch { /* ignore */ } rafId = 0; }
      render();
      onChange(ta.value);
      syncScroll();
    },
    setLanguage(lang) {
      language = lang;
      const name = (LANG_NAMES[lang] || lang);
      headLang.textContent = name;
      headLang.hidden = !name;
      lastFullGutterLines = -1; lastWindow = ''; contentDirty = true; render();
    },
    /** 自定义标题栏左侧文案（传空串则整块隐藏，只留字符数）：用于「自动识别语言」时不在代码框里显示语言 */
    setLanguageLabel(text) {
      const s = text == null ? '' : String(text);
      headLang.textContent = s;
      headLang.hidden = !s;
    },
    focus: () => ta.focus(),
  };
}
