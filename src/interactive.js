'use strict';

/**
 * 交互题评测（仿洛谷）
 *
 * 支持两种模式，均由 judge.js 的 judgeCase() 按 problem.problem_type 分流调用：
 *   1) IO 交互题（interactive_io）
 *      题目携带一个 testlib 风格的交互器 interactor.cpp：它从 argv[1] 读取测试输入文件，
 *      通过 stdout 向选手程序提问、从 stdin 读取选手回答。评测时把交互器与选手程序用**双向管道**对接
 *      （interactor.stdout → solution.stdin，solution.stdout → interactor.stdin），
 *      并以交互器的退出码判定结果（testlib 约定）。
 *   2) 函数式交互题（interactive_func）
 *      题目携带 grader.cpp（含 main()）与若干头文件（如 problem.h），评测时把
 *      grader + 头文件目录 + 选手提交一起编译链接成一个可执行文件再运行，以测试输入文件作 stdin。
 *
 * 设计要点：
 *   · 编译产物按「源码内容哈希」缓存（data/interactor_cache），与 SPJ 的 checker 缓存同一套思路，
 *     同一道题没改动就复用已编译的可执行文件，省去每次评测的 g++ 开销；
 *   · 复用 judge.js 已导出的底层能力（编译执行、进程测量、内存采样、输出归一化），
 *     避免在 judge.js 里塞进交互题细节；
 *   · 普通题与 SPJ 题的评测路径**完全不受影响**（本模块只在交互题分支被调用）。
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// 注意：本模块**不** require('./judge')——judge.js 会 require 本模块，互相 require 会形成循环依赖。
// 归一化输出（normalizeOutput）、判定常量（VERDICTS）与底层执行能力（runShell / runMeasured / resolveTool）
// 全部由 judge.js 通过参数注入。
const { DATA_DIR, VERDICTS } = require('./config');
// M17：交互题编译超时可在系统设置「评测设置」里调整（judge_interactive_compile_timeout_ms）
const { getIntSetting } = require('./settings');
// v2.6.3（待办 #16）：交互器 / grader 的输出与编译日志同样按「UTF-8 优先 + GBK 回退」解码，
// 避免 GBK 判题消息在提交详情里变成 U+FFFD 乱码（也用于函数式交互的 grader 消息）。
const { decodeText, readTextFile } = require('./util');

/** 交互器 / grader 的编译缓存目录（与 SPJ 的 data/spj_cache 分开管理） */
const INTERACTOR_CACHE_DIR = path.join(DATA_DIR, 'interactor_cache');
/** 缓存上限：最多保留多少个可执行文件、多久未使用即清理（按最近使用时间计） */
const CACHE_MAX_ENTRIES = 60;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_TMP_MAX_AGE_MS = 5 * 60 * 1000;

/** 正在被评测使用的交互题可执行文件：judgeDir -> Set<绝对路径>（清理缓存时跳过它们） */
const inUse = new Map();

/** 内置 testlib 头文件目录（testlib/testlib.h），交互器可直接 #include "testlib.h" */
const BUNDLED_TESTLIB = path.join(__dirname, '..', 'testlib');

/** 交互器 / grader 的编译参数（与仓库既有 checker 保持一致：-fno-asm -std=c++14 -O2） */
const BASE_FLAGS = '-fno-asm -std=c++14 -O2';

/** 编译的硬性墙钟超时（秒级兜底，避免 g++ 卡死把提交永远留在 Judging）
 *  M17：可在系统设置「评测设置」里用 judge_interactive_compile_timeout_ms 调整（默认 60s = 历史行为）；
 *  每次编译现读，改完立即生效。 */
const COMPILE_TIMEOUT_MS = 60000;
function compileTimeoutMs() { return getIntSetting('judge_interactive_compile_timeout_ms', COMPILE_TIMEOUT_MS, 10000, 600000); }
/** M7：POSIX（Linux）交互题内存采样——轮询 /proc/<pid>/status 的 VmHWM（峰值 RSS）。
 *  Windows 走 MemSampler，POSIX 以前完全没有交互题内存数据（MLE 静默失效），这里补上。
 *  采样不到时返回 null（由调用方标 memory_sampled:false），绝不静默当成 0 分/AC。 */
function startLinuxMemPoller(pid, intervalMs = 25) {
  if (process.platform !== 'linux' || !pid) return null;
  let peakKb = 0;
  let reads = 0;
  let timer = null;
  const readOnce = () => {
    try {
      const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = s.match(/VmHWM:\s*(\d+)\s*kB/) || s.match(/VmRSS:\s*(\d+)\s*kB/);
      if (m) { reads++; const v = parseInt(m[1], 10); if (Number.isFinite(v) && v > peakKb) peakKb = v; }
    } catch { /* 进程已退出 / 无 /proc */ }
  };
  readOnce();
  timer = setInterval(readOnce, intervalMs);
  if (timer.unref) timer.unref();
  return {
    /** 结束轮询并返回峰值 KB；一次都没读到返回 null（=未采样） */
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      readOnce();
      return reads > 0 ? peakKb : null;
    },
  };
}

/** 选手先退出后，留给交互器读完最后回答并自行退出（给出结论）的宽限时间（毫秒）；超时才强杀。
 *  M9：固定 1500ms 对长时限题目偏短（交互器可能还在读/校验大量数据就被杀掉，正确提交被判 RE），
 *  因此改成「与题目时限相关」：max(1500, 题目时限)，上限 30s。 */
const SOLUTION_EXIT_GRACE_MIN_MS = 1500;
const SOLUTION_EXIT_GRACE_MAX_MS = 30000;
function solutionExitGraceMs(timeLimitMs) {
  const tl = Math.max(0, Math.round(Number(timeLimitMs) || 0));
  return Math.max(SOLUTION_EXIT_GRACE_MIN_MS, Math.min(SOLUTION_EXIT_GRACE_MAX_MS, tl));
}
/**
 * IO 交互题的「冷启动宽限」：进程创建 + 首次输出的这段时间不计入题目时限。
 * Windows 上首次执行一个新编译出来的 exe 可能被杀毒软件扫描数百毫秒到数秒，
 * 若直接按题目时限计时，会把完全正确的交互程序误判成 TLE。
 * 宽限结束后只要超过 time_limit_ms 没有任何推进（两侧都没数据流动）就判超时，
 * 因此死循环 / 不配合的选手仍然会被正常判成 TLE。
 */
const WARMUP_GRACE_MS = 5000;
/** 函数式交互题：可观测的运行时间只有「跑完」这一刻，无法像 IO 交互那样按空闲计时，
 *  因此给一整段固定的冷启动宽限（同样只影响启动阶段，不影响死循环被判 TLE）。 */
const FUNC_RUN_GRACE_MS = 4000;

/**
 * 交互题**总时长上限**：除「空闲超时」（两侧都没有新数据流动才 TLE）之外，再加一道墙钟闸门。
 * 只有空闲计时时，一个「一直有数据流动、但整体拖很久」的选手可以无限期占用评测机，
 * 因此总时长按 max(题目时限 × TOTAL_TIME_FACTOR, TOTAL_TIME_FLOOR_MS) 截断，超过即判 TLE。
 * 例：题目时限 2000 ms → max(16000, 15000) = 16000 ms；时限 100 ms → 15000 ms（下限兜底）。
 */
const TOTAL_TIME_FACTOR = 8;
const TOTAL_TIME_FLOOR_MS = 15000;

/** 题目时限 → 交互题总时长上限（毫秒） */
function totalTimeLimitMs(timeLimitMs) {
  const t = Math.max(1, Math.round(Number(timeLimitMs) || 0));
  return Math.max(t * TOTAL_TIME_FACTOR, TOTAL_TIME_FLOOR_MS);
}

/** 判题消息（交互器 / grader 结论）单条硬上限：300 字，避免 judge_detail 被刷屏内容撑爆 */
const MESSAGE_MAX_LEN = 300;
/**
 * 「完整消息」message_full 的硬上限：6000 字。
 * 与 MESSAGE_MAX_LEN 不同，message_full 是给前端**折叠展示**用的，默认不显示，
 * 因此不按「只留结论行」精简，只在超过上限时才丢中间部分（见 fullInteractorMessage）。
 */
const FULL_MESSAGE_MAX_LEN = 6000;
/** 超长时保留的头部字数（其余配额留给尾部，保证「结论行」（一般在最后）一定还在） */
const FULL_MESSAGE_HEAD_LEN = 4000;
/** 中间截断标记：单独占一行，便于前端一眼看出中间被截掉了 */
const FULL_MESSAGE_ELISION = '\n…（消息过长，中间部分已截断）…\n';
/** 交互器输出采集：头部 / 尾部各留一段，中间省略（尾部必须留——结论一般打印在最后一行） */
const CAPTURE_HEAD_LEN = 2048;
const CAPTURE_TAIL_LEN = 8192;

/** 「没有结论价值」的行：单个 yes/no、数字、问号等交互流水，不能当作结论行 */
const NOISE_LINE_RE = /^(yes|no|y|n|0|1|-1|\?|!|…|\.\.\.)$/i;

/**
 * 交互器消息精简（IO 交互 / 函数式交互 / SPJ 回退三处统一复用）。
 *   1) 去掉空白行，并把连续空白（含换行、制表符）压缩成单个空格；
 *   2) 只保留最后一条有意义的结论行（通常是 `ok, x = ...` / `wrong answer: ...` / `FAIL ...`）；
 *      整段都是 yes/no 之类的流水行时退回最后一行；
 *   3) 原本行数 > 1 时，在结论后补一句「（交互过程共 N 行，已省略）」；
 *   4) 单条消息总长硬上限 maxLen（默认 300 字），超出即截断并加「…」；
 *      clipped = true 表示来源本身已被截断（结论行可能不完整），同样补「…」。
 * 注意：只处理**消息文本**；交互器 argv[2]（输出文件）的内容不属于消息，不在这里读取。
 */
function tidyInteractorMessage(text, { maxLen = MESSAGE_MAX_LEN, clipped = false } = {}) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const lines = raw.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l !== '');
  if (lines.length === 0) return '';
  let conclusion = lines[lines.length - 1];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!NOISE_LINE_RE.test(lines[i])) { conclusion = lines[i]; break; }
  }
  let msg = conclusion + (clipped ? '…' : '');
  if (lines.length > 1) msg += `（交互过程共 ${lines.length} 行，已省略）`;
  const limit = Math.max(16, Math.round(Number(maxLen) || MESSAGE_MAX_LEN));
  if (msg.length > limit) msg = msg.slice(0, limit - 1) + '…';
  return msg;
}

/**
 * 带前缀 / 后缀的判题消息：前缀 + 精简后的结论 + 后缀，整体不超过 MESSAGE_MAX_LEN 字。
 * 用于「答案错误（交互器 _wa）：<结论>」这类拼接，避免前缀把结论挤出 300 字硬上限之外。
 */
function composeInteractorMessage(prefix, body, { suffix = '', clipped = false } = {}) {
  const head = String(prefix == null ? '' : prefix);
  const tail = String(suffix == null ? '' : suffix);
  const room = Math.max(80, MESSAGE_MAX_LEN - head.length - tail.length);
  return head + tidyInteractorMessage(body, { maxLen: room, clipped }) + tail;
}

/**
 * 交互器 / grader 的**完整**输出（前端折叠展示用，字段名 message_full）。
 *
 * 与 tidyInteractorMessage（只留最后一条结论行 + 300 字上限）相反，这里默认**不丢任何过程**：
 *   1) \r\n 与 \r 统一成 \n；去掉每行行尾空白；去掉首尾空行——
 *      **中间**的问答行（yes / no / ? / ! 等交互流水）一行都不删，前后顺序保持原样；
 *   2) 长度硬上限 FULL_MESSAGE_MAX_LEN（6000 字）：超出时保留头部 4000 字 + 尾部约 2000 字，
 *      中间插入一行「…（消息过长，中间部分已截断）…」——这是**唯一**允许丢内容的情形；
 *   3) clipped === true 表示来源采集本身已被截断（见 makeCapture / CAPTURE_HEAD_LEN / CAPTURE_TAIL_LEN，
 *      即全文在采集阶段就只留了头尾），此时在末尾补一个「…」提示「中间内容在采集阶段已丢失」。
 * 只做文本规范化，不解析结论、不参与判定——判定消息（message）仍由 tidyInteractorMessage 生成。
 */
function fullInteractorMessage(text, { clipped = false } = {}) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const lines = raw.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  let out = lines.slice(start, end).join('\n');
  // 把截断标记与结尾那个「…」也算进 6000 字预算，保证返回值总长严格不超过硬上限
  const budget = FULL_MESSAGE_MAX_LEN - (clipped ? 1 : 0);
  if (out.length > budget) {
    const tailRoom = budget - FULL_MESSAGE_HEAD_LEN - FULL_MESSAGE_ELISION.length;
    out = out.slice(0, FULL_MESSAGE_HEAD_LEN) + FULL_MESSAGE_ELISION + out.slice(out.length - tailRoom);
  }
  return clipped ? out + '…' : out;
}

/** 内存超限消息（交互题统一口径，按 MB 展示）：超出内存限制：峰值 512 MB > 限制 256 MB */
function memoryLimitMessage(memKb, limitMb) {
  return `超出内存限制：峰值 ${Math.round((Number(memKb) || 0) / 1024)} MB > 限制 ${Math.round(Number(limitMb) || 0)} MB`;
}

/** 子进程输出采集：头部 + 尾部，中间用「…」占位（避免刷屏内容撑爆内存与判题消息） */
function makeCapture(headLen = CAPTURE_HEAD_LEN, tailLen = CAPTURE_TAIL_LEN) {
  let head = '';
  let tail = '';
  let elided = false;
  return {
    push(chunk) {
      let s = String(chunk);
      if (head.length < headLen) {
        const take = s.slice(0, headLen - head.length);
        head += take;
        s = s.slice(take.length);
      }
      if (!s) return;
      tail += s;
      if (tail.length > tailLen) { tail = tail.slice(tail.length - tailLen); elided = true; }
    },
    value() { return (elided ? head + '\n…\n' : head) + tail; },
    /** 采集过程中是否发生过「中间内容被丢弃」（供 fullInteractorMessage 的 clipped 判断） */
    elided() { return elided; },
  };
}

function trackAsset(judgeDir, exeFile) {
  let set = inUse.get(judgeDir);
  if (!set) { set = new Set(); inUse.set(judgeDir, set); }
  set.add(exeFile);
  return exeFile;
}

/** 一次评测结束：解除本次评测对交互题可执行文件的占用，并清理编译中断残留的 *.tmp */
function releaseInteractiveAssets(judgeDir) {
  inUse.delete(judgeDir);
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(INTERACTOR_CACHE_DIR)) {
      if (!name.endsWith('.tmp')) continue;
      const p = path.join(INTERACTOR_CACHE_DIR, name);
      try {
        if (now - fs.statSync(p).mtimeMs > CACHE_TMP_MAX_AGE_MS) { fs.rmSync(p, { force: true }); removed++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}

/** 清理交互题编译缓存：只做过期 / 超量淘汰（不整目录清空），正在使用的文件跳过 */
function pruneInteractorCache({ maxEntries = CACHE_MAX_ENTRIES, maxAgeMs = CACHE_MAX_AGE_MS } = {}) {
  const used = new Set();
  for (const set of inUse.values()) for (const p of set) used.add(p);
  let names = [];
  try { names = fs.readdirSync(INTERACTOR_CACHE_DIR); } catch { return { removed: 0, kept: 0 }; }
  const now = Date.now();
  let removed = 0;
  const exes = [];
  for (const name of names) {
    const p = path.join(INTERACTOR_CACHE_DIR, name);
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    if (name.endsWith('.tmp')) {
      if (now - st.mtimeMs > CACHE_TMP_MAX_AGE_MS && !used.has(p)) {
        try { fs.rmSync(p, { force: true }); removed++; } catch { /* ignore */ }
      }
      continue;
    }
    if (!/^(interactor|grader)_[0-9a-f]{6,}\.exe$/.test(name)) continue;  // 只管理本模块生成的缓存文件
    exes.push({ p, mtime: st.mtimeMs });
  }
  exes.sort((a, b) => b.mtime - a.mtime);
  exes.forEach((e, i) => {
    const tooOld = now - e.mtime > maxAgeMs;
    if ((i >= maxEntries || tooOld) && !used.has(e.p)) {
      try { fs.rmSync(e.p, { force: true }); removed++; } catch { /* 文件被占用时留待下次清理 */ }
    }
  });
  return { removed, kept: exes.length - removed };
}

/* ---------------- 编译（带内容哈希缓存） ---------------- */

/**
 * 把若干源码 / 头文件与编译参数一起做内容哈希，得到缓存键。
 * files: [{ file, optional }]，optional 的文件不存在时以占位串参与哈希。
 */
function hashSources(files, extra) {
  const h = crypto.createHash('sha1');
  for (const f of files) {
    h.update('=== ' + f.file + ' ===\n');
    let content = null;
    try { content = fs.readFileSync(f.file, 'utf8'); } catch { content = null; }
    if (content == null) {
      if (!f.optional) return null;
      h.update('?missing');
    } else {
      h.update(content);
    }
    h.update('\n');
  }
  h.update('flags:' + extra);
  return h.digest('hex');
}

/** 某题 IO 交互器的缓存键（算法与 compileInteractor 完全一致）；源码缺失 → null。
 *  供「清理多余数据」页面判断 interactor_<hash>.exe 是否仍被题目引用
 *  （与编译时用的同一份 hashSources + BASE_FLAGS，保证不会把仍在用的缓存判成孤儿）。 */
function interactorCacheKey(problemId, interactorSrc) {
  try { if (!fs.statSync(interactorSrc).isFile()) return null; } catch { return null; }
  const dir = path.dirname(interactorSrc);
  let headers = [];
  try {
    headers = fs.readdirSync(dir).filter((f) => /\.h$/i.test(f)).map((f) => path.join(dir, f));
  } catch { /* ignore */ }
  return hashSources(
    [{ file: interactorSrc },
      ...headers.map((f) => ({ file: f, optional: true })),
      { file: path.join(BUNDLED_TESTLIB, 'testlib.h'), optional: true }],
    BASE_FLAGS + '|' + [dir, BUNDLED_TESTLIB].join(';')
  );
}

/**
 * 编译交互题配套源码（交互器 / grader）到缓存目录。
 * @param {'interactor'|'grader'} kind
 * @param {number} problemId
 * @param {string} judgeDir 本次评测的工作目录（用于放编译日志、登记占用）
 * @param {object} opts
 *   - srcFile     主源码（interactor.cpp / grader.cpp）
 *   - includeDirs 额外的 -I 目录（数据目录 / 内置 testlib）
 *   - extraFiles  参与哈希的其它文件（头文件、选手源码）
 *   - o2          是否开启 O2（题目 / 提交的 enable_o2）
 *   - runShell / resolveTool  由 judge.js 注入的底层能力（避免循环依赖）
 * @returns {Promise<{ok:boolean, exeFile?:string, log:string, cached?:boolean}>}
 */
async function compileAsset(kind, problemId, judgeDir, opts) {
  const { srcFile, includeDirs = [], extraFiles = [], o2 = true, runShell, resolveTool } = opts;
  const tool = resolveTool('g++');
  if (!tool) return { ok: false, log: '未找到 g++，无法编译' + (kind === 'grader' ? ' grader' : '交互器') };
  const flags = o2 ? BASE_FLAGS : BASE_FLAGS.replace(/-O2/g, '');
  const logFile = path.join(judgeDir, `${kind}_compile.log`);

  const hash = hashSources([{ file: srcFile }, ...extraFiles.map((f) => ({ file: f, optional: true }))], flags + '|' + includeDirs.join(';'));
  if (!hash) return { ok: false, log: `无法读取${kind === 'grader' ? ' grader' : '交互器'}源码：${srcFile}` };
  try { fs.mkdirSync(INTERACTOR_CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
  const cachedExe = path.join(INTERACTOR_CACHE_DIR, `${kind}_${hash}.exe`);

  // 命中缓存：直接复用
  try {
    const st = fs.statSync(cachedExe);
    if (st.size > 0) {
      try { const t = new Date(); fs.utimesSync(cachedExe, t, t); } catch { /* ignore */ }
      console.log(`[OJ] 交互题 ${kind} 命中编译缓存（题目 #${problemId}），跳过编译：${path.basename(cachedExe)}`);
      return { ok: true, exeFile: trackAsset(judgeDir, cachedExe), log: '', cached: true };
    }
    fs.rmSync(cachedExe, { force: true });
  } catch { /* 未命中缓存 */ }

  const tmpExe = cachedExe + '.' + process.pid + '.tmp';
  const inc = includeDirs.filter(Boolean).map((d) => `-I"${d}"`).join(' ');
  const cmd = `"${tool}" ${flags} ${inc} "${srcFile}" -o "${tmpExe}"`;
  const t0 = Date.now();
  // 编译只用文件重定向（不用管道），并带硬性墙钟超时：超时后 runShell 会 taskkill /F /T 整棵进程树
  const r = await runShell(cmd, { cwd: path.dirname(srcFile), timeoutMs: compileTimeoutMs(), stdoutFile: logFile, stderrFile: logFile });
  let log = '';
  try { log = readTextFile(logFile, ''); } catch { /* ignore */ }
  if (r.error) return { ok: false, log: `${kind} 编译执行失败: ${r.error}\n${log}` };
  if (r.timedOut) {
    try { fs.rmSync(tmpExe, { force: true }); } catch { /* ignore */ }
    return { ok: false, log: `${kind} 编译超时（超过 ${compileTimeoutMs() / 1000} 秒，已强制结束编译器）\n${log}` };
  }
  if (r.code !== 0) {
    try { fs.rmSync(tmpExe, { force: true }); } catch { /* ignore */ }
    return { ok: false, log: log || `${kind} 编译失败（退出码 ${r.code}）` };
  }
  try { fs.renameSync(tmpExe, cachedExe); } catch { /* 改名失败（并发）则以现有缓存为准 */ }
  console.log(`[OJ] 交互题 ${kind} 编译完成并写入缓存（题目 #${problemId}，${Date.now() - t0}ms）：${path.basename(cachedExe)}`);
  try { pruneInteractorCache(); } catch { /* ignore */ }
  return { ok: true, exeFile: trackAsset(judgeDir, cachedExe) };
}

/** 编译 IO 交互题的交互器（argv[1] = 测试输入文件，stdout/stdin 与选手程序对话）
 *  M8：缓存键要包含**实际参与编译的所有头文件**——数据目录里的 *.h 与内置 testlib.h，
 *  否则题目作者改了头文件（或内置 testlib 升级）后仍会命中旧缓存。 */
function compileInteractor(problemId, judgeDir, interactorSrc, opts = {}) {
  let headers = [];
  try {
    headers = fs.readdirSync(path.dirname(interactorSrc))
      .filter((f) => /\.h$/i.test(f))
      .map((f) => path.join(path.dirname(interactorSrc), f));
  } catch { /* ignore */ }
  return compileAsset('interactor', problemId, judgeDir, {
    srcFile: interactorSrc,
    includeDirs: [path.dirname(interactorSrc), BUNDLED_TESTLIB],
    // 内置 testlib.h 也参与哈希（数据目录里若有同名 testlib.h 会同时参与，两者任一变化都重编译）
    extraFiles: [...headers, path.join(BUNDLED_TESTLIB, 'testlib.h')],
    o2: true,   // 交互器统一开 O2（它是题目自带的评测设施，与选手的 O2 选择无关）
    runShell: opts.runShell,
    resolveTool: opts.resolveTool,
  });
}

/**
 * 编译「函数式交互题」的可执行文件：grader.cpp + 选手源码一起编译链接。
 * 头文件目录（题目数据目录）通过 -I 提供，选手与 grader 都可 #include "problem.h"。
 */
function compileFuncInteractive(problemId, judgeDir, graderSrc, submissionSrc, opts = {}) {
  const { runShell, resolveTool, o2 = true, headerFiles = [] } = opts;
  const tool = resolveTool('g++');
  if (!tool) return Promise.resolve({ ok: false, log: '未找到 g++，无法编译函数式交互题' });
  const flags = o2 ? BASE_FLAGS : BASE_FLAGS.replace(/-O2/g, '');
  const dataDir = path.dirname(graderSrc);
  const logFile = path.join(judgeDir, 'grader_compile.log');

  // 把题目数据目录里的头文件复制到编译目录：`#include "problem.h"` 会先在源文件所在目录查找，
  // 这样即使 -I 的引号在某些 shell 包装下失效，头文件也一定能被找到。
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (!/\.(h|hpp)$/i.test(name)) continue;
      try { fs.copyFileSync(path.join(dataDir, name), path.join(judgeDir, name)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  const hash = hashSources(
    [{ file: graderSrc }, { file: submissionSrc }, ...headerFiles.map((f) => ({ file: f, optional: true }))],
    flags + '|func'
  );
  if (!hash) return Promise.resolve({ ok: false, log: '无法读取 grader.cpp 或选手源码' });
  try { fs.mkdirSync(INTERACTOR_CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
  const cachedExe = path.join(INTERACTOR_CACHE_DIR, `grader_${hash}.exe`);
  try {
    const st = fs.statSync(cachedExe);
    if (st.size > 0) {
      try { const t = new Date(); fs.utimesSync(cachedExe, t, t); } catch { /* ignore */ }
      console.log(`[OJ] 函数式交互题命中编译缓存（题目 #${problemId}），跳过编译：${path.basename(cachedExe)}`);
      return Promise.resolve({ ok: true, exeFile: trackAsset(judgeDir, cachedExe), log: '', cached: true });
    }
    fs.rmSync(cachedExe, { force: true });
  } catch { /* 未命中缓存 */ }

  const tmpExe = cachedExe + '.' + process.pid + '.tmp';
  const cmd = `"${tool}" ${flags} -I"${dataDir}" -I"${BUNDLED_TESTLIB}" "${graderSrc}" "${submissionSrc}" -o "${tmpExe}"`;
  const t0 = Date.now();
  return runShell(cmd, { cwd: judgeDir, timeoutMs: compileTimeoutMs(), stdoutFile: logFile, stderrFile: logFile }).then((r) => {
    let log = '';
    try { log = readTextFile(logFile, ''); } catch { /* ignore */ }
    if (r.error) return { ok: false, log: `编译执行失败: ${r.error}\n${log}` };
    if (r.timedOut) {
      try { fs.rmSync(tmpExe, { force: true }); } catch { /* ignore */ }
      return { ok: false, log: `编译超时（超过 ${compileTimeoutMs() / 1000} 秒，已强制结束编译器）\n${log}` };
    }
    if (r.code !== 0) {
      try { fs.rmSync(tmpExe, { force: true }); } catch { /* ignore */ }
      return { ok: false, log: log || `编译失败（退出码 ${r.code}）` };
    }
    try { fs.renameSync(tmpExe, cachedExe); } catch { /* ignore */ }
    console.log(`[OJ] 函数式交互题编译完成并写入缓存（题目 #${problemId}，${Date.now() - t0}ms）：${path.basename(cachedExe)}`);
    try { pruneInteractorCache(); } catch { /* ignore */ }
    return { ok: true, exeFile: trackAsset(judgeDir, cachedExe) };
  });
}

/* ---------------- 进程控制 ---------------- */

/** 强制结束一个进程及其子进程（Windows 上需要 /T 才能连带子进程） */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      spawnSync('kill', ['-9', String(child.pid)], { stdio: 'ignore' });
    }
  } catch { /* ignore */ }
  try { if (!child.killed) child.kill(); } catch { /* ignore */ }
}

/* ---------------- IO 交互题 ---------------- */

/**
 * 运行一次 IO 交互：交互器与选手程序双向管道对接。
 *
 * 时限策略（**两道闸门**）：
 *   1) 空闲时限：进程启动 + 首次输出的这段时间允许额外的宽限（WARMUP_GRACE_MS），
 *      之后按题目的 time_limit_ms 计时；每次「交互仍在推进」（任一侧有数据流动）都会重置计时。
 *      这样既能杀掉死循环 / 不配合的选手，又不会因为 Windows 首次执行新 exe 时的杀毒扫描、
 *      进程创建开销把正解误判成超时。
 *   2) 总时长上限（totalMs，默认由题目时限推导，见 totalTimeLimitMs）：
 *      即使两侧一直有数据流动，整体墙钟也不能超过它，否则判 TLE——
 *      避免「一直推进但整体拖很久」的提交长期占用评测机。
 * 两道闸门都会在判定后同时结束交互器与选手进程（killTree），不会把提交停在 Judging。
 *
 * @param {object} opts cwd / inputFile / interactorOutFile / sampler / outputLimitBytes
 *   - timeoutMs 空闲时限（毫秒，judgeInteractiveIO 传题目时限 + 500 余量）
 *   - totalMs   总时长上限（毫秒，缺省按 timeoutMs 推导）
 * @returns {Promise<{timedOut:boolean, timeoutKind:'idle'|'total'|'', idleWindowMs:number, totalMs:number,
 *                    durationMs:number, memoryKb:number,
 *                    interactorCode:number, solutionCode:number,
 *                    interactorOut:string, interactorErr:string, solutionErr:string,
 *                    solutionOutBytes:number, error:string}>}
 */
function runInteractiveIO(interactorExe, solutionExe, solutionArgs, opts) {
  const { cwd, timeoutMs, inputFile, interactorOutFile, sampler, outputLimitBytes = Infinity, solutionSpawnOpts } = opts;
  const totalMs = Math.max(1000, Math.round(Number(opts.totalMs) || totalTimeLimitMs(timeoutMs)));
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let settled = false;
    let timedOut = false;
    let timeoutKind = '';     // 'idle' = 空闲超时；'total' = 总时长超限
    let idleWindowMs = 0;     // 触发空闲超时时实际使用的窗口（含冷启动宽限）
    let solutionOutBytes = 0;
    let lastActivity = Date.now();
    let idleTimer = null;
    let totalTimer = null;

    let itr = null;
    let sol = null;
    let memPoller = null;    // M7：POSIX 交互题内存采样（/proc VmHWM）
    let itrCode = null;
    let solCode = null;
    let itrDone = false;
    let solGrace = null;   // 选手先退出后的宽限计时器（等交互器给出结论）
    let solDone = false;
    // 头部 + 尾部采集：交互器可能把每一次问答都打到 stdout（几百行 yes/no），
    // 只留头会把最后的结论行丢掉，因此尾部必须完整保留。
    const itrOut = makeCapture();
    const itrErr = makeCapture();
    let solErr = '';

    // 交互器退出即定论；但选手的退出码还要在 judge_detail 里展示，
    // 因此这里最多再等 150ms 让 sol 的 exit 事件落地（正常 <5ms，不会拖慢评测）。
    const finish = async (err, waitSolutionMs = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      if (solGrace) { clearTimeout(solGrace); solGrace = null; }
      if (waitSolutionMs > 0 && !solDone) {
        await new Promise((r) => {
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; r(); } }, waitSolutionMs);
          sol.once('exit', (c) => {
            if (typeof c === 'number') solCode = c;
            solDone = true;
            if (!done) { done = true; clearTimeout(t); r(); }
          });
        });
      }
      // 判定结论在拿到的这一刻就固定下来（交互器退出码 / 选手退出码），
      // 之后无论杀进程、采样内存发生什么都不得改写它——否则会把 AC/WA 误判成 JE。
      const result = {
        timedOut,
        timeoutKind,
        idleWindowMs,
        totalMs,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        memoryKb: 0,
        interactorCode: itrCode == null ? -1 : itrCode,
        solutionCode: solCode == null ? -1 : solCode,
        interactorOut: itrOut.value(),
        interactorErr: itrErr.value(),
        // 采集阶段是否已丢弃过中间内容（true 时 message_full 末尾补「…」）
        interactorOutClipped: itrOut.elided(),
        interactorErrClipped: itrErr.elided(),
        solutionErr: solErr,
        solutionOutBytes,
        error: err || '',
      };
      // 一方结束时另一方可能还在跑：一起收掉，避免残留进程
      killTree(itr);
      killTree(sol);
      // 内存采样绝不能改写判定结论：durationMs / 退出码在上面的 result 里已经固定，
      // 这里等待的只是采样器把「峰值工作集」写进应答文件（pid 匹配就立刻返回）。
      // 窗口取 600ms：进程刚被杀掉，采样器最多一个轮询周期（~12ms）就能发现并落盘，
      // 留足余量是为了机器负载高时不至于读不到内存（此前 250ms 偶发读不到 → memory_kb 记 0）。
      if (sampler && sampler.ok && sol && sol.pid) {
        try {
          const peak = await sampler.peakFor(sol.pid, 600);
          // M7：只有真的采到正值才算采到（peak=0 表示进程已经没了、什么也没读到，
          // 不能算成「内存 0 KB」）；memory_kb 也只在采到时填真实值。
          result.memorySampled = peak > 0;
          result.memoryKb = peak > 0 ? Math.max(1, Math.round(peak / 1024)) : 0;
        } catch { /* 采样失败绝不影响判定 */ }
      } else if (memPoller) {
        // M7：POSIX 用 /proc VmHWM 峰值；采样不到（或读到 0）则标 memorySampled=false（不是 0）
        const peakKb = memPoller.stop();
        result.memorySampled = peakKb > 0;
        result.memoryKb = peakKb > 0 ? Math.max(1, Math.round(peakKb)) : 0;
      }
      resolve(result);
    };

    /**
     * 重置空闲计时：超过 timeLimit + 宽限仍没有任何推进 → 判定超时（timeoutKind='idle'）。
     * 判定结论（退出码）在触发时先固定，再杀进程，最后 resolve——
     * 这样 killTree 的同步开销不会算进 durationMs。
     */
    const armIdleTimer = (graceMs) => {
      clearTimeout(idleTimer);
      const windowMs = Math.max(100, (timeoutMs || 1000) + (graceMs || 0));
      idleTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        timeoutKind = 'idle';
        idleWindowMs = windowMs;
        finish('');
      }, windowMs);
    };
    /** 每次「交互在推进」都重新计时（宽限期只对最开始的进程启动阶段生效） */
    const tick = () => {
      if (settled) return;
      lastActivity = Date.now();
      armIdleTimer(0);
    };

    // 首次计时带宽限：覆盖进程创建 + 首次输出（Windows 上首次执行新 exe 还可能有杀毒扫描）
    let timer = setTimeout(() => {}, 0);
    clearTimeout(timer);
    armIdleTimer(WARMUP_GRACE_MS);
    // 总时长闸门：从进程启动开始计，不受「有没有数据流动」影响（宽限只给空闲计时用）
    totalTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timeoutKind = 'total';
      idleWindowMs = totalMs;
      finish('');
    }, totalMs);
    if (totalTimer.unref) totalTimer.unref();

    try {
      // 交互器参数约定：argv[1] = 测试输入文件（必须）。
      // 再多传一个 argv[2] = 交互器输出文件，这样使用 testlib 的
      // registerInteraction(argc, argv) 的交互器也能直接跑（它要求 argc >= 3）；
      // 自写的交互器只用 argv[1]、把交互内容写到 stdout，多出来的参数会被忽略。
      itr = spawn(interactorExe, [inputFile, interactorOutFile || path.join(cwd, '_interactor_out.txt')], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      // H1：选手进程按调用方给的降权选项启动（交互器保持受信任设施的原权限）
      sol = spawn(solutionExe, solutionArgs || [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(opts.solutionSpawnOpts || {}) });
    } catch (e) {
      return finish('启动交互进程失败：' + e.message);
    }
    // 采样窗口要覆盖总时长上限（而不是只覆盖空闲时限）：否则交互拖到中后段才申请大内存就读不到峰值
    if (sampler && sampler.ok && sol.pid) {
      try { sampler.begin(sol.pid, Date.now() + totalMs + 2500); } catch { /* ignore */ }
    } else if (!sampler) {
      memPoller = startLinuxMemPoller(sol.pid);   // M7：POSIX 走 /proc VmHWM
    }

    // 交叉接线：交互器 stdout → 选手 stdin，选手 stdout → 交互器 stdin
    itr.stdout.pipe(sol.stdin);
    sol.stdout.pipe(itr.stdin);

    // 采集交互器输出（判定依据）与双方 stderr（写入 judge_detail）；每读到数据都视为「交互在推进」
    // 编码：交互器 / checker 在中文 Windows 上可能输出 GBK 字节（待办 #16），这里统一做
    // 「UTF-8 优先 + GBK 回退」解码；**转发给选手的字节流仍走上面的 pipe（原样二进制）**，判定口径不变。
    itr.stdout.on('data', (d) => { itrOut.push(decodeText(d)); tick(); });
    itr.stderr.on('data', (d) => { itrErr.push(decodeText(d)); tick(); });
    sol.stderr.on('data', (d) => { if (solErr.length < 8192) solErr += decodeText(d); tick(); });
    // 统计选手输出量，超过上限时立即结束（防刷屏）
    sol.stdout.on('data', (d) => {
      solutionOutBytes += d.length;
      tick();
      if (solutionOutBytes > outputLimitBytes && !settled) {
        killTree(itr);
        killTree(sol);
        finish('');
      }
    });

    itr.on('error', (e) => finish('交互器启动失败：' + e.message));
    sol.on('error', (e) => finish('选手程序启动失败：' + e.message));
    // 判定以**交互器**的退出码为准：交互器一退出就定论（此时选手是否还在跑都无所谓）。
    itr.on('exit', (code) => {
      itrCode = code; itrDone = true;
      if (solGrace) { clearTimeout(solGrace); solGrace = null; }
      if (!settled) finish('', 150);
    });
    itr.on('close', (code) => { if (itrCode == null && typeof code === 'number') itrCode = code; });
    // 选手先退出时不立刻杀掉交互器：它可能还要读完选手最后的回答再给出结论
    //（此前这里直接等 itrDone，一旦交互器被提前收掉，交互器的正确判定就会丢失 → 误判为系统错误）
    sol.on('exit', (code) => {
      solCode = code; solDone = true;
      // 交互器已经给出结论（无论它是否先退出）→ 直接用它的退出码定论
      if (itrCode != null) { if (!settled) finish(''); return; }
      // M9：宽限与题目时限相关（见 solutionExitGraceMs），避免长时限题目把正确提交判成 RE
      solGrace = setTimeout(() => { solGrace = null; if (!settled) finish(''); }, solutionExitGraceMs(timeoutMs));
    });

    // 兜底：两侧都未触发 exit 时（例如管道被对方持有）超时后强杀。
    // 这里必须按**总时长上限**兜底：否则空闲兜底会提前（题目时限 + 2s）把还在正常交互的进程杀掉。
    const grace = setTimeout(() => { if (!settled) { killTree(itr); killTree(sol); } }, Math.max(100, timeoutMs || 1000) + 2000 + totalMs);
    if (grace.unref) grace.unref();
  });
}

/**
 * 判定一次 IO 交互的结果（testlib 退出码约定）。
 *   0 → _ok      AC
 *   1 → _wa      WA
 *   2 → _pe      PE（本 OJ 没有 PE 判定，按 WA 处理并把消息带上）
 *   3 → _fail    判题失败（系统错误，JE）
 *   4 → _dirt    WA
 *   7 → _points  部分分（本 OJ 交互题按 WA 处理，消息中保留 points 信息）
 *   其它        以交互器 stderr 内容判断是否是 testlib 抛出的异常
 */
function verdictFromInteractor(code, message) {
  // 消息统一精简（见 tidyInteractorMessage）：交互器可能把每次问答都打到 stdout，
  // 这里只保留最后一条有意义的结论行，单条消息不超过 MESSAGE_MAX_LEN 字。
  const msg = tidyInteractorMessage(message);
  switch (code) {
    case 0:
      return { verdict: VERDICTS.AC, message: msg || '交互器返回 _ok（通过）' };
    case 1:
      return { verdict: VERDICTS.WA, message: msg ? composeInteractorMessage('答案错误（交互器 _wa）：', msg) : '答案错误（交互器 _wa）' };
    case 2:
      return { verdict: VERDICTS.WA, message: msg ? composeInteractorMessage('答案错误（格式错误 _pe，按 WA 处理）：', msg) : '答案错误（格式错误 _pe，按 WA 处理）' };
    case 4:
      return { verdict: VERDICTS.WA, message: msg ? composeInteractorMessage('答案错误（交互器 _dirt）：', msg) : '答案错误（交互器 _dirt）' };
    case 7:
      return { verdict: VERDICTS.WA, message: msg ? composeInteractorMessage('答案错误（交互器 _points，部分分不计入交互题）：', msg) : '答案错误（交互器 _points，部分分不计入交互题）' };
    case 3:
    default:
      return { verdict: VERDICTS.SE, message: msg ? composeInteractorMessage(`判题失败（交互器退出码 ${code}）：`, msg) : `判题失败（交互器退出码 ${code}）` };
  }
}

/**
 * 判一个测试点的 IO 交互题。
 * @param {object} ctx
 *   - dir            评测工作目录
 *   - interactorExe  已编译好的交互器
 *   - exeFile/args   选手程序与运行参数
 *   - testcase       当前测试点（用其 input 写测试输入文件）
 *   - problem        题目行（time_limit_ms / memory_limit_mb / enable_o2）
 *   - lang           语言配置
 *   - sampler        内存采样器（可为 null；可用时按 memory_limit_mb 判 MLE）
 *   - outputLimitBytes 选手输出上限
 * @returns {Promise<{verdict, time_ms, memory_kb, message, fraction}>}
 */
async function judgeInteractiveIO(ctx) {
  const { dir, interactorExe, exeFile, args, testcase, problem, sampler, outputLimitBytes } = ctx;
  // H2：交互器/选手的隐藏输入、交互器输出（= 选手答案）一律放**评测私有目录** priv/（选手 cwd 之外）；
  // 交互器隐藏输入优先直接读题目只读数据目录里的 <id>.in（零拷贝，选手改不了自己的评测输入）。
  const priv = ctx.priv || path.join(dir, '.priv');
  try { fs.mkdirSync(priv, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  let inputFile = ctx.inputFileForInteractor || '';
  if (!inputFile || !fs.existsSync(inputFile)) {
    inputFile = path.join(priv, `inter_input_${testcase.id}.txt`);
    fs.writeFileSync(inputFile, testcase.input ?? '');
  }
  // argv[2]：testlib 约定的交互器输出文件。交互题叠加 SPJ 时，交互器应把选手的最终答案写到这里，
  // 评测随后用 checker <input> <该文件> <答案文件> 做判定（见 judge.js 的 judgeInteractiveCase）。
  // 注意：这个文件的内容**不是**判题消息，只有 stdout / stderr 才是。
  const interactorOutFile = path.join(priv, `inter_output_${testcase.id}.txt`);
  const totalMs = totalTimeLimitMs(problem.time_limit_ms);

  const r = await runInteractiveIO(interactorExe, exeFile, args || [], {
    cwd: dir,
    timeoutMs: problem.time_limit_ms + 500,
    totalMs,
    inputFile,
    interactorOutFile,
    sampler,
    solutionSpawnOpts: ctx.solutionSpawnOpts,
    outputLimitBytes: outputLimitBytes || Infinity,
  });

  const timeMs = Math.round(r.durationMs);
  const memKb = r.memoryKb || 0;
  // M7：区分「采样到 0」与「未采样」
  // 交互器消息 = stdout（可能是几百行 yes/no 的交互流水）+ stderr（结论常写在这里）；
  // 交给 verdictFromInteractor 统一精简成「最后一条有意义的结论行」。
  const itrMsg = [r.interactorOut, r.interactorErr].filter((s) => s && s.trim()).join('\n');
  const detail = {
    time_ms: timeMs,
    memory_kb: memKb,
    // M7：memory_sampled=false 表示本次没采到内存（不是「内存为 0」）
    memory_sampled: !!r.memorySampled,
    interactor_exit: r.interactorCode,
    solution_exit: r.solutionCode,
    // 完整交互过程（前端折叠展示，默认收起）：保留每一次问答（yes/no 都在），只有超过 6000 字才丢中间部分。
    // 放在 detail 里是为了让下面每一条 return（含 judge.js 的「交互 + SPJ」分支）都带上它。
    message_full: fullInteractorMessage(itrMsg, {
      clipped: !!r.interactorOutClipped || !!r.interactorErrClipped,
    }),
    // 供 judge.js 的「交互 + SPJ」分支定位输入文件与交互器输出文件（即 argv[1] / argv[2]）
    inputFile,
    interactorOutFile,
  };

  if (r.error) {
    return { verdict: VERDICTS.SE, time_ms: timeMs, memory_kb: memKb, message: r.error, ...detail };
  }
  if (r.timedOut) {
    // 两种超时必须在消息里可区分：总时长超限 / 空闲（没有新的交互推进）
    const tleMsg = r.timeoutKind === 'total'
      ? `运行超时（总时长超过 ${r.totalMs || totalMs} ms，已同时结束交互器与选手程序）`
      : `运行超时（超过 ${r.idleWindowMs || (problem.time_limit_ms + 500)} ms 没有新的交互推进`
        + `，题目时限 ${problem.time_limit_ms} ms，已同时结束交互器与选手程序）`;
    return {
      verdict: VERDICTS.TLE, time_ms: timeMs, memory_kb: memKb, message: tleMsg,
      timeout_kind: r.timeoutKind || 'idle', ...detail,
    };
  }
  // 内存限制：与普通题同一口径（只作用于选手进程），峰值取 MemSampler 采到的工作集峰值；
  // 采样器不可用时 memKb=0，此时不会误判 MLE，只在 judge_detail 里记 0。
  if (problem.memory_limit_mb > 0 && memKb > problem.memory_limit_mb * 1024) {
    return { verdict: VERDICTS.MLE, time_ms: timeMs, memory_kb: memKb, message: memoryLimitMessage(memKb, problem.memory_limit_mb), ...detail };
  }

  // 优先看交互器退出码
  if (r.interactorCode === 0 || r.interactorCode === 1 || r.interactorCode === 2 || r.interactorCode === 3 || r.interactorCode === 4 || r.interactorCode === 7) {
    const v = verdictFromInteractor(r.interactorCode, itrMsg);
    return { ...v, time_ms: timeMs, memory_kb: memKb, fraction: v.verdict === VERDICTS.AC ? 1 : 0, ...detail };
  }

  // L17：走到这里说明交互器的退出码不在 testlib 约定内（崩溃 / 被信号杀死 / 拿不到退出码）。
  // 这属于评测设施问题 → 判 SE 并带上 interactor_exit，而不是算到选手头上判 RE。
  const itrErrMsg = String(r.interactorErr || '').trim().slice(0, 200);
  return {
    verdict: VERDICTS.SE,
    time_ms: timeMs,
    memory_kb: memKb,
    fraction: 0,
    interactor_exit: r.interactorCode,
    solution_exit: r.solutionCode,
    message: `交互器非正常退出（interactor_exit=${r.interactorCode}，未给出可识别的判定结论）`
      + (itrErrMsg ? `：${itrErrMsg}` : ''),
    ...detail,
  };
}

/* ---------------- 函数式交互题 ---------------- */

/**
 * 判一个测试点的函数式交互题：以测试输入文件为 stdin 运行 grader+选手的可执行文件。
 * 若该测试点存在答案文件（problem 数据里的 .out 非空）则规范化后比对，否则以退出码 0 判 AC。
 * 内存采样器绑在**链接后的那个可执行文件**进程上（grader + 选手源码一起编译链接的产物）。
 */
async function judgeInteractiveFunc(ctx) {
  const { dir, exeFile, testcase, problem, o2, runMeasured, runMeasuredNode, normalizeOutput, sampler } = ctx;
  // H2：grader 的输入/输出/错误文件同样放评测私有目录（选手与 grader 链接在一起，普通目录里的
  // 输出文件可能被选手代码改写后再交给 checker）
  const priv = ctx.priv || path.join(dir, '.priv');
  try { fs.mkdirSync(priv, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  let inputFile = ctx.inputFileForFunc || '';
  if (!inputFile || !fs.existsSync(inputFile)) {
    inputFile = path.join(priv, `func_input_${testcase.id}.txt`);
    fs.writeFileSync(inputFile, testcase.input ?? '');
  }
  const outputFile = path.join(priv, `func_output_${testcase.id}.txt`);
  const errorFile = path.join(priv, `func_error_${testcase.id}.txt`);

  // 总时长上限：函数式交互题没有「空闲」概念（只能看整体是否跑完），
  // 因此硬上限取 min(题目时限 + 冷启动宽限, 总时长上限)：
  // 既确保存在明确的总时长闸门，又不会放宽既有判定（时间更短的那个先起作用）。
  const totalMs = totalTimeLimitMs(problem.time_limit_ms);
  const runTimeoutMs = Math.min(Math.max(100, problem.time_limit_ms + FUNC_RUN_GRACE_MS), totalMs);
  // Windows 上优先走 Node 直跑（比 PowerShell 包装器快一个数量级，避免包装器冷启动把 grader 拖成系统错误）
  const useNode = typeof runMeasuredNode === 'function';
  const runOpts = {
    cwd: dir,
    // 冷启动宽限：Windows 首次执行新 exe 的创建/扫描开销可达数秒（实测正解 2110ms vs 后续 71ms）。
    timeoutMs: runTimeoutMs,
    stdinFile: inputFile,
    stdoutFile: outputFile,
    stderrFile: errorFile,
    // 内存采样：函数式交互题只有这一个进程（grader + 选手链接后的可执行文件），直接绑它
    sampler: sampler || null,
    // M4：grader 的输出（即交给 checker 的答案文件）同样受输出上限约束
    outputLimitBytes: ctx.outputLimitBytes,
  };
  const r = useNode
    ? await runMeasuredNode(exeFile, [], runOpts)
    : await runMeasured(exeFile, [], runOpts);
  let stdout = '';
  let stderr = '';
  // 注意：stdout 参与「与标准答案比对」（normalizeOutput）与「交给 checker 的 ouf」，
  // 其解码口径必须与测试数据（UTF-8）保持一致 → **保持原样按 UTF-8 读取**，不改。
  try { stdout = fs.readFileSync(outputFile, 'utf8'); } catch { /* ignore */ }
  // stderr 只用于判题消息展示（grader 可能输出 GBK 中文）→ 走稳健解码（待办 #16）
  try { stderr = readTextFile(errorFile, ''); } catch { /* ignore */ }

  const timeMs = Math.round(r.durationMs || 0);
  const memKb = r.memoryKb || 0;
  // grader 的 stdout / stderr 是判题消息（程序输出文件 outputFile 是给 checker 的答案，不是消息）。
  //   · message      —— 只保留最后一条有意义的结论行（OK: ... / WRONG: ... / FAIL: ...），300 字硬上限；
  //   · message_full —— 完整输出，供前端折叠展示（函数式交互的 grader 输出直接读文件，不存在采集截断）。
  const gradeSrc = [stdout, stderr].filter((s) => s && s.trim()).join('\n');
  const gradeMsg = tidyInteractorMessage(gradeSrc);
  const detail = {
    time_ms: timeMs, memory_kb: memKb, grader_exit: r.code, o2: !!o2, total_limit_ms: runTimeoutMs,
    memory_sampled: !!r.memorySampled,
    message_full: fullInteractorMessage(gradeSrc),
    // 供 judge.js 的「函数式交互 + SPJ」分支定位输入文件与程序输出文件
    inputFile, outputFile,
  };

  if (r.error) return { verdict: VERDICTS.SE, ...detail, message: r.error };
  if (r.timedOut) {
    return {
      verdict: VERDICTS.TLE, ...detail,
      message: `运行超时（总时长超过 ${runTimeoutMs} ms，含 ${FUNC_RUN_GRACE_MS} ms 冷启动宽限，已同时结束 grader 与选手程序）`,
    };
  }
  if (problem.memory_limit_mb > 0 && memKb > problem.memory_limit_mb * 1024) {
    return { verdict: VERDICTS.MLE, ...detail, message: memoryLimitMessage(memKb, problem.memory_limit_mb) };
  }

  // 有答案文件（.out 非空）时按 normalizeOutput 比对
  const expected = normalizeOutput(testcase.output);
  if (expected !== '') {
    const actual = normalizeOutput(stdout);
    if (expected === actual && r.code === 0) {
      return { verdict: VERDICTS.AC, ...detail, message: gradeMsg || '正确', fraction: 1 };
    }
    if (r.code !== 0) {
      return {
        verdict: VERDICTS.WA, ...detail,
        message: gradeMsg ? composeInteractorMessage(`答案错误（grader 退出码 ${r.code}）：`, gradeMsg) : `答案错误（grader 退出码 ${r.code}）`,
      };
    }
    return { verdict: VERDICTS.WA, ...detail, message: '答案错误（grader 输出与标准答案不一致）', expected: expected.slice(0, 200), actual: actual.slice(0, 200) };
  }

  if (r.code === 0) {
    return { verdict: VERDICTS.AC, ...detail, message: gradeMsg ? composeInteractorMessage('grader 判定通过：', gradeMsg) : '正确', fraction: 1 };
  }
  // 退出码非 0：grader 主动判错（通常是 WA），消息里带上 grader 的结论便于排查
  return {
    verdict: VERDICTS.WA,
    ...detail,
    message: gradeMsg ? composeInteractorMessage(`答案错误（grader 退出码 ${r.code}）：`, gradeMsg) : `答案错误（grader 退出码 ${r.code}）`,
  };
}

module.exports = {
  compileInteractor,
  compileFuncInteractive,
  judgeInteractiveIO,
  judgeInteractiveFunc,
  verdictFromInteractor,
  runInteractiveIO,
  pruneInteractorCache,
  releaseInteractiveAssets,
  // 消息精简工具（judge.js 的「交互 + SPJ」回退消息也复用）
  tidyInteractorMessage,
  composeInteractorMessage,
  // 完整消息（message_full）：不做「只留结论行」精简，供前端折叠展示
  fullInteractorMessage,
  totalTimeLimitMs,
  INTERACTOR_CACHE_DIR,
  BUNDLED_TESTLIB,
  // 「清理多余数据」页面用：判断哪些交互器缓存条目仍被题目引用（与编译时同一套哈希）
  interactorCacheKey,
  BASE_FLAGS,
  // M17：交互题编译超时的当前生效值（系统设置页回显用）
  compileTimeoutMs,
};
