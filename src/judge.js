'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, readTestcases, readSubtaskTypes, readCommunicationConfig } = require('./db');
const { encodeDetail } = require('./judgecodec');
const { LANGUAGES, TOOLCHAIN_CANDIDATES, TOOL_VERSION_FLAGS, TOOL_MIN_MAJOR, VERDICTS, DEFAULTS, JUDGE_DIR, DATA_DIR, TESTDATA_DIR, JUDGE_USER, MEM_SAMPLER: MEM_CFG } = require('./config');
// v2.6.3（待办 #16）：checker / 交互器 / grader 的输出与编译日志一律走「UTF-8 优先、GBK 回退」解码，
// 避免中文 Windows 下 GBK 判题消息被按 UTF-8 解码成 U+FFFD（提交详情乱码）。详见 src/util.js。
const { decodeText, readTextFile } = require('./util');
// M17：评测可调项（系统设置「评测设置」分区）——判题侧每次**现读**，后台改完立即对下一条提交生效
const { getIntSetting, getNumSetting, getBoolSetting, getStrSetting } = require('./settings');

// 统一子进程输出编码为 UTF-8：否则在中文 Windows 上，Python/Java 等会按本地编码（GBK）
// 写 stdout，而标准答案与读取端都是 UTF-8，中文输出会被判为答案错误。
process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING || 'utf-8';
process.env.PYTHONUTF8 = process.env.PYTHONUTF8 || '1';
process.env.PHP_OUTPUT_ENCODING = process.env.PHP_OUTPUT_ENCODING || 'UTF-8';

// ---------------- 工具链探测 ----------------

let toolPathCache = {};

// 版本探测参数（TOOL_VERSION_FLAGS）与最低主版本号（TOOL_MIN_MAJOR）统一定义在 src/config.js，
// 供部署自检脚本 deploy/check-env.js 复用同一份判断标准。

/** 解析工具版本输出中的第一个版本号（如 "gcc (MinGW.org) 2.95" → 2） */
function parseToolMajor(text) {
  const m = String(text || '').match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : null;
}

/** 在候选路径中解析某个工具（编译器/解释器），返回可执行路径或 null。结果缓存。 */
function resolveTool(toolName) {
  if (toolPathCache[toolName] !== undefined) return toolPathCache[toolName];
  const candidates = (TOOLCHAIN_CANDIDATES[toolName] || [toolName]).map((c) =>
    c.includes('{user}') ? c.replace(/\{user\}/g, os.homedir()) : c
  );
  const flags = TOOL_VERSION_FLAGS[toolName] || ['--version'];
  const minMajor = TOOL_MIN_MAJOR[toolName];
  let result = null;
  for (const c of candidates) {
    try {
      const r = spawnSync(c, flags, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (r.status !== 0) continue;
      if (minMajor) {
        const major = parseToolMajor((r.stdout || '') + (r.stderr || ''));
        // 版本号解析不出来时保守放行（不同工具输出格式差异较大）
        if (major != null && major < minMajor) {
          console.warn(`[judge] 跳过版本过旧的 ${toolName}：${c}（版本 ${major} < ${minMajor}）`);
          continue;
        }
      }
      result = c;
      break;
    } catch { /* ignore */ }
  }
  toolPathCache[toolName] = result;
  return result;
}

let languageCache = null;

function availableLanguages() {
  if (languageCache) return languageCache;
  const map = {};
  for (const key of Object.keys(LANGUAGES)) {
    const lang = LANGUAGES[key];
    let available = true;
    let tool = null;
    // M17：后台可指定解释器/编译器命令（judge_python_cmd），优先于自动探测
    tool = overriddenTool(lang) || resolveTool(lang.toolName);
    available = !!tool;
    if (lang.runToolName && lang.runToolName !== lang.toolName) {
      if (!resolveTool(lang.runToolName)) available = false;
    }
    map[key] = { ...lang, available, tool };
  }
  languageCache = map;
  return map;
}

/** 清空语言可用性缓存：后台改了解释器/编译参数后调用，使 /api/languages 立刻反映最新配置 */
function resetLanguageCache() { languageCache = null; }

// ---------------- 底层命令执行（文件重定向，避免命名管道） ----------------

const RUNNER = path.join(__dirname, 'runner.ps1');
const MEM_SAMPLER = path.join(__dirname, 'memsampler.ps1');

/* ---------------- 编译期资源上限（M5） ---------------- */
/** 编译日志硬上限：超过就强制结束编译器（防止海量报错打满磁盘） */
const COMPILE_LOG_HARD_CAP = 4 * 1024 * 1024;
/** 编译日志最多回读多少字节（判定 CE 只需要开头） */
const COMPILE_LOG_READ_BYTES = 16 * 1024;

/* ---------------- 评测可调项（M17：后台「评测设置」可调，改完立即生效） ----------------
 * 全部来自系统设置（GET/PUT /api/settings），**未配置时返回的默认值与历史行为逐项一致** ——
 * 也就是说「不动设置 = 行为完全不变」。每项都在使用点现读一次，不需要重启服务。
 *   judge_compile_timeout_ms        选手代码编译超时（ms，默认 120000）
 *   judge_checker_timeout_base_ms   SPJ/checker 单次判定基础超时（ms，默认 5000）
 *   judge_checker_timeout_max_ms    SPJ/checker 单次判定超时上限（ms，默认 60000）
 *   judge_compile_log_limit_kb      编译日志硬上限（KB，默认 4096）
 *   judge_output_limit_mb           单测试点输出上限（MB，默认 16）
 *   judge_time_extra_ms             TLE 判定余量（ms，默认 0）
 *   judge_memory_tolerance_pct      内存判定百分比（默认 100 = 严格按题面限制）
 *   judge_total_timeout_ms          判题总兜底超时（ms，默认 30000）
 *   judge_mem_sample_enabled        是否开启内存采样（默认开）
 *   judge_mem_sample_interval_ms    采样轮询间隔（ms，默认 1；传给 memsampler.ps1）
 *   judge_cpp_flags / judge_c_flags 追加编译参数（默认空，追加在语言模板之后）
 *   judge_python_cmd                Python 解释器覆盖（默认空 = 自动探测）
 *   judge_time_factor               每测试点时限系数（默认 1.2；无点级配置时 该点时限 = round(题目时限 × 系数)）
 */
function compileTimeoutMs() { return getIntSetting('judge_compile_timeout_ms', 120000, 10000, 600000); }
function compileLogHardCapBytes() { return getIntSetting('judge_compile_log_limit_kb', Math.round(COMPILE_LOG_HARD_CAP / 1024), 64, 65536) * 1024; }
function outputLimitBytes() { return getIntSetting('judge_output_limit_mb', Math.round(DEFAULTS.outputLimitBytes / (1024 * 1024)), 1, 1024) * 1024 * 1024; }
function timeExtraMs() { return getIntSetting('judge_time_extra_ms', 0, 0, 5000); }
function memoryTolerancePct() { return getIntSetting('judge_memory_tolerance_pct', 100, 50, 200); }
function judgeTotalTimeoutMs() { return getIntSetting('judge_total_timeout_ms', DEFAULTS.judgeTimeoutMs, 5000, 600000); }

/* ---------------- 每测试点时限系数（judge_time_factor） ----------------
 * 规则：单个测试点若在 data/testdata/<pid>/meta.json 的 case_limits 里**显式配置**了 time_limit_ms，
 * 该点以配置值为准；否则该点时限 = round(题目 time_limit_ms × 系数)。
 * 默认 1.2（= 在题目时限上给 20% 余量），允许 1.0 ~ 3.0，步进 0.05；读不到 / 非法一律回退 1.2。
 * 内存不受影响：仍按点级 ?? 题目级内存判定。 */
const TIME_FACTOR_DEFAULT = 1.2;
const TIME_FACTOR_MIN = 1.0;
const TIME_FACTOR_MAX = 3.0;
function judgeTimeFactor() {
  // 注意：这里**不用** getNumSetting 的「越界夹取」，而是「非法即回退默认」——
  // 直接写库的 0.5 / 5 属于非法值，必须回退 1.2，而不是静默变成 1.0 / 3.0。
  const raw = getStrSetting('judge_time_factor', '', 32).trim();
  if (raw === '') return TIME_FACTOR_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < TIME_FACTOR_MIN || n > TIME_FACTOR_MAX) return TIME_FACTOR_DEFAULT;
  // 步进 0.05：四舍五入到 2 位小数，避免 1.2000000000000002 这类浮点噪声进入判定
  return Math.round(n * 100) / 100;
}
/** 是否开启内存采样：关闭后不再借/启采样器，memory_kb 记 0（memory_sampled=false，不判 MLE） */
function memSampleEnabled() { return getBoolSetting('judge_mem_sample_enabled', true); }
/** 内存采样轮询间隔（ms）：传给 memsampler.ps1；0 = 让出 CPU 的最密集轮询 */
function memSampleIntervalMs() { return getIntSetting('judge_mem_sample_interval_ms', 1, 0, 50); }
/** 语言附加编译参数（仅 C/C++ 系生效；空串 = 不追加任何参数） */
function extraCompileFlags(langKey) {
  if (langKey === 'c') return getStrSetting('judge_c_flags', '', 200);
  if (langKey === 'cpp' || langKey === 'cpp11' || langKey === 'cpp98') return getStrSetting('judge_cpp_flags', '', 200);
  return '';
}
/** Python 解释器覆盖（空 = 用内置候选表 resolveTool 自动探测） */
function overriddenTool(lang) {
  if (!lang) return null;
  if (lang.key === 'python') {
    const cmd = getStrSetting('judge_python_cmd', '', 200).trim();
    if (cmd) return cmd;
  }
  return null;
}

/** 当前**生效**的评测可调项（供系统设置页回显）：与判题侧读到的是同一份现读逻辑，
 *  因此页面上显示什么，判题时就用什么（未配置的项显示默认值）。 */
function judgeTuning() {
  return {
    judge_compile_timeout_ms: compileTimeoutMs(),
    judge_checker_timeout_base_ms: checkerTimeoutBaseMs(),
    judge_checker_timeout_max_ms: checkerTimeoutMaxMs(),
    judge_compile_log_limit_kb: Math.round(compileLogHardCapBytes() / 1024),
    judge_output_limit_mb: Math.round(outputLimitBytes() / (1024 * 1024)),
    judge_time_extra_ms: timeExtraMs(),
    judge_time_factor: judgeTimeFactor(),
    judge_memory_tolerance_pct: memoryTolerancePct(),
    judge_total_timeout_ms: judgeTotalTimeoutMs(),
    judge_mem_sample_enabled: memSampleEnabled(),
    judge_mem_sample_interval_ms: memSampleIntervalMs(),
    judge_cpp_flags: extraCompileFlags('cpp'),
    judge_c_flags: extraCompileFlags('c'),
    judge_python_cmd: getStrSetting('judge_python_cmd', '', 200),
    judge_interactive_compile_timeout_ms: interactiveCompileTimeoutMs(),
  };
}

/**
 * 通过 shell 执行命令（用于编译），输入/输出/错误都走文件重定向（不用管道）。
 * M5：编译日志**有硬上限**——后台看门狗轮询日志大小，超过 COMPILE_LOG_HARD_CAP 就结束整棵编译进程树
 *（避免 -Wall 海量报错或恶意输出把磁盘/内存打满）；调用方随后只回读开头若干 KB。
 * POSIX 还会加 ulimit（CPU 时间 / 文件大小）作为编译期的资源限制。
 * 返回 { code, timedOut, durationMs, error, logExceeded }。
 */
function runShell(command, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile, env }) {
  return new Promise((resolve) => {
    let full = command;
    // M5：POSIX 编译期资源限制（CPU 120s、单文件 256MB）；ulimit 不可用时整条命令仍然可执行
    if (process.platform !== 'win32') full = `ulimit -t 120 -f 262144 2>/dev/null; ${full}`;
    if (stdinFile) full += ` < "${stdinFile}"`;
    if (stdoutFile && stderrFile === stdoutFile) {
      full += ` > "${stdoutFile}" 2>&1`;
    } else {
      if (stdoutFile) full += ` > "${stdoutFile}"`;
      if (stderrFile) full += ` 2> "${stderrFile}"`;
    }

    const start = process.hrtime.bigint();
    let child = null;
    let timedOut = false;
    let settled = false;
    let stopWatch = null;

    const finish = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopWatch) stopWatch();
      resolve({
        code: obj.code == null ? -1 : obj.code,
        timedOut: !!timedOut,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        error: obj.error || '',
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTreeAsync(child);           // L7：编译超时要杀整棵进程树
      finish({});
    }, timeoutMs);

    try {
      child = spawn(full, { cwd, shell: true, stdio: 'ignore', windowsHide: true, env: env || process.env, detached: process.platform !== 'win32' });
    } catch (e) { finish({ error: e.message }); return; }
    // M5：日志看门狗——超过硬上限立即结束编译器，只保留开头部分
    // M17：硬上限来自系统设置 judge_compile_log_limit_kb（默认 4096KB = 4MB，与历史一致）
    const logTarget = stdoutFile || stderrFile;
    if (logTarget) {
      const logCap = compileLogHardCapBytes();
      stopWatch = startOutputWatch(logTarget, logCap, () => {
        timedOut = false;
        killTreeAsync(child);
        finish({ code: -2, error: `编译输出超过 ${Math.round(logCap / 1024 / 1024)}MB，已强制结束编译器` });
      }, 200);
    }
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

/** 将命令行字符串切分为 [exe, ...args]，尊重引号 */
function tokenizeCommand(cmd) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return tokens;
}

/* ---------------- 进程/输出控制（L7 / M4 / M5） ---------------- */

/**
 * 选手进程的 spawn 选项（H1）：POSIX 下降权到低权限账户（uid/gid），读不到 data/oj.db、data/testdata、
 * .priv 这些判题私有物。返回 { opts, warning }：**拿不到降权能力时原样返回**（回退为当前行为），
 * 由调用方打印一次警告，绝不让判题因此失败。
 */
let judgeDropWarned = false;
function judgeSpawnOpts(base = {}, dropPriv = true) {
  const o = { ...base };
  if (!dropPriv) return o;                                   // checker 等受信任设施保持原权限
  if (process.platform === 'win32') return o;                 // Windows：不硬造受限令牌
  if (JUDGE_USER && Number.isFinite(JUDGE_USER.uid)) {
    o.uid = JUDGE_USER.uid;
    if (Number.isFinite(JUDGE_USER.gid)) o.gid = JUDGE_USER.gid;
    return o;
  }
  if (!judgeDropWarned) {
    judgeDropWarned = true;
    console.warn('[judge] 未能降权运行选手程序（H1）：' + (JUDGE_USER && JUDGE_USER.why ? JUDGE_USER.why : '未知原因')
      + '；评测将以服务账户身份执行。生产环境请用 Docker/Linux 部署，或设置 OJ_JUDGE_USER / OJ_JUDGE_UID');
  }
  return o;
}

/** 结束一个进程及其子进程。
 *  · 先判断是否还活着（exitCode/signalCode 都为 null），避免 PID 已被系统复用时误杀无关进程；
 *  · Windows 用**异步** taskkill（spawnSync 在满载机器上会阻塞事件循环数秒，实测一次 3 秒）；
 *  · POSIX 依赖 spawn 时的 detached:true 建独立进程组，用 kill(-pid) 整组结束（否则子进程会漏）。
 */
function killTreeAsync(child) {
  if (!child || !child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;   // 已经退出
  try {
    if (process.platform === 'win32') {
      const t = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      t.on('error', () => { /* ignore */ });
      if (t.unref) t.unref();
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/** 输出大小看门狗（M4）：轮询重定向文件大小，超过上限立即结束进程并回报，
 *  不再"先把整份输出读进内存再比大小"。返回停止函数。 */
function startOutputWatch(file, limitBytes, onExceed, intervalMs = 40) {
  const t = setInterval(() => {
    try {
      if (fs.statSync(file).size > limitBytes) { clearInterval(t); onExceed(); }
    } catch { /* 文件还没建好 */ }
  }, intervalMs);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

/** 只读取文件开头至多 maxBytes（M5：编译日志可能极大，不能整份读进内存）。
 *  v2.6.3（#16）：编译器（g++ 等）在中文 Windows 下的诊断信息可能是 GBK 字节，
 *  这里经 decodeText 做「UTF-8 优先 + GBK 回退」解码，CE 详情不再出现乱码。 */
function readFileHead(file, maxBytes = 16384) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const n = Math.min(st.size, maxBytes);
    const buf = Buffer.allocUnsafe(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return decodeText(buf.subarray(0, read));
  } catch {
    return '';
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * 实测「进程创建 + IO 重定向」的额外耗时（L6）：判题走文件重定向，`durationMs` 里必然包含
 * 创建进程与打开文件的时间。测出这段基线并**从实测用时里扣除**，宽限就只覆盖进程创建，
 * 不会把「程序本身超时」也一并放过（也不会因为创建慢而误判 TLE）。
 * 注意：测量在**后台异步**做（`spawnSync` 在满载机器上会阻塞事件循环数秒），
 * 用默认值兜底，绝不占用判题路径。结果缓存 5 分钟。
 */
const spawnOverhead = { ms: process.platform === 'win32' ? 500 : 50, at: 0, measuring: false };
function measureSpawnOverheadMs() {
  const now = Date.now();
  if (!spawnOverhead.at || now - spawnOverhead.at > 5 * 60 * 1000) {
    if (!spawnOverhead.measuring) {
      spawnOverhead.measuring = true;
      const cmd = process.platform === 'win32' ? (process.env.ComSpec || 'cmd') : '/bin/true';
      const args = process.platform === 'win32' ? ['/c', 'exit'] : [];
      let best = Infinity;
      let left = 3;
      const next = () => {
        if (left-- <= 0) {
          if (Number.isFinite(best)) { spawnOverhead.ms = Math.max(0, Math.min(5000, Math.round(best))); spawnOverhead.at = Date.now(); }
          spawnOverhead.measuring = false;
          return;
        }
        const t0 = process.hrtime.bigint();
        try {
          const c = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
          c.on('error', next);
          c.on('close', () => {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            if (ms < best) best = ms;
            next();
          });
        } catch { next(); }
      };
      next();
    }
  }
  return spawnOverhead.ms;
}

/** 判定是否 TLE：被看门狗/超时杀掉，或者「实测用时 − 进程创建基线」超过题目时限（L6）
 *  M17：可在系统设置里给一个额外余量 judge_time_extra_ms（默认 0 = 与历史判定完全一致）。
 *  余量同时用于「超时闸门」（见 prepareCaseJob / judgeCase 的 timeoutMs），
 *  因此放宽的是「机器抖动容忍度」，而不是把真 TLE 放过去（超时仍由同一闸门结束进程）。 */
function isTimeLimitExceeded(timedOut, durationMs, timeLimitMs) {
  if (timedOut) return true;
  const overhead = measureSpawnOverheadMs();
  return Number(durationMs) - overhead > Number(timeLimitMs) + timeExtraMs();
}

/* ---------------- v2.5.3 点级限额：点级优先，未设置则继承题目级 ---------------- */

/** 该测试点是否**显式设置**了对应限额（null / '' / 非法 / 非正数 → 未设置 = 继承） */
function caseLimitValue(testcase, key) {
  if (!testcase) return null;
  const v = testcase[key];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 该测试点实际生效的时限（ms）：点级显式配置 ?? round(题目级 × judge_time_factor)。
 *  · 点级 time_limit_ms **显式配置**时优先（不受系数影响）；
 *  · 否则 = round(题目 time_limit_ms × 系数)，系数默认 1.2、范围 1.0~3.0（见 judgeTimeFactor）；
 *  · 题目级缺失 / 非法 → 以全局默认时限（DEFAULTS.timeLimitMs）乘系数兜底。
 *  这是**唯一**的时限收敛点：普通题、SPJ、交互题、通信题都经它取时限（interactive.js 侧
 *  由 problemWithCaseLimits 把折算后的值写进 problem.time_limit_ms 传进去）。 */
function effectiveTimeLimitMs(problem, testcase) {
  const own = caseLimitValue(testcase, 'time_limit_ms');
  if (own != null) return own;
  const g = Number(problem && problem.time_limit_ms);
  const base = Number.isFinite(g) && g > 0 ? g : DEFAULTS.timeLimitMs;
  return Math.round(base * judgeTimeFactor());
}

/** 该测试点实际生效的内存限额（MB）：点级 ?? 题目级；返回 0 表示不判内存（与题目级口径一致） */
function effectiveMemoryLimitMb(problem, testcase) {
  const own = caseLimitValue(testcase, 'memory_limit_mb');
  if (own != null) return own;
  const g = Number(problem && problem.memory_limit_mb);
  return Number.isFinite(g) && g > 0 ? g : 0;
}

/** 把测试点的点级限额叠加到题目对象上（用于交互题：interactive.js 只认 problem.time_limit_ms / memory_limit_mb）。
 *  时限一律写入**该点实际生效值**（点级显式配置 ?? 题目级 × 系数），因此交互题 / 通信题与普通题遵循同一口径；
 *  内存只叠加点级配置（系数不影响内存）。
 *  未配置点级限额且折算后与题面完全一致时原样返回同一对象（系数为 1 时行为与改动前逐字节一致）。 */
function problemWithCaseLimits(problem, testcase) {
  const tl = caseLimitValue(testcase, 'time_limit_ms');
  const ml = caseLimitValue(testcase, 'memory_limit_mb');
  const origTl = Number(problem && problem.time_limit_ms);
  const effTl = effectiveTimeLimitMs(problem, testcase);
  if (tl == null && ml == null && (!Number.isFinite(origTl) || origTl === effTl)) return problem;
  const out = Object.assign({}, problem);
  // 题目级时限本身缺失 / 非法时保持原样传下去（沿用历史行为），其余情况写入折算后的生效时限
  if (Number.isFinite(origTl)) out.time_limit_ms = effTl;
  else if (tl != null) out.time_limit_ms = tl;
  if (ml != null) out.memory_limit_mb = ml;
  return out;
}


/**
 * 运行用户程序并测量峰值内存。
 * Windows：用 PowerShell 包装器（src/runner.ps1）启动进程、采样 WorkingSet64 峰值、强制超时。
 * 其它平台：用 /usr/bin/time -v 采样最大驻留内存；不可用时退回纯 shell 运行（内存记 0）。
 * 返回 { code, timedOut, durationMs, memoryKb, error }。
 */
function runMeasured(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile, dropPriv }) {
  if (process.platform === 'win32') return runMeasuredWindows(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile });
  return runMeasuredUnix(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile, dropPriv });
}

function runMeasuredWindows(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile, outputLimitBytes }) {
  return new Promise((resolve) => {
    const jobFile = path.join(cwd, '_job.json');
    const resultFile = path.join(cwd, '_result.json');
    fs.writeFileSync(jobFile, JSON.stringify({ exe, args, cwd, timeoutMs, stdinFile, stdoutFile, stderrFile }));
    try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }

    const start = process.hrtime.bigint();
    let child = null;
    let settled = false;
    let outputExceeded = false;
    let stopWatch = null;

    const finish = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(failsafe);
      if (stopWatch) stopWatch();
      resolve({
        code: obj.code == null ? -1 : obj.code,
        timedOut: !!obj.timedOut,
        durationMs: obj.durationMs != null ? obj.durationMs : Number(process.hrtime.bigint() - start) / 1e6,
        memoryKb: Math.round((obj.peakMemoryBytes || 0) / 1024),
        // M7/明细：包装器确实采到了内存才标记为已采样
        memorySampled: obj.peakMemoryBytes != null,
        outputExceeded,
        error: obj.error || '',
      });
    };

    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RUNNER, jobFile, resultFile], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) { finish({ error: e.message }); return; }

    // M4：流式输出上限——轮询重定向文件大小，超限立即杀掉整棵进程树
    if (stdoutFile && outputLimitBytes) {
      stopWatch = startOutputWatch(stdoutFile, outputLimitBytes, () => { outputExceeded = true; killTreeAsync(child); });
    }

    // 兜底：包装器本身卡死时强制结束（非程序超时）。
    // 这里只是"包装器彻底没反应"的保护：Windows 上 powershell 冷启动在负载高时可能超过 10 秒，
    // 因此留出 30 秒余量（程序本身的超时仍由包装器按 timeoutMs 精确控制，不会因此放过 TLE）。
    const failsafe = setTimeout(() => {
      killTreeAsync(child);
      finish({ error: '判题包装器超时（系统错误）' });
    }, timeoutMs + 30000);

    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', () => {
      let r = null;
      try {
        const raw = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '');
        r = JSON.parse(raw);
      } catch { /* ignore */ }
      if (!r) { finish({ error: '判题包装器未返回结果' }); return; }
      finish({ code: r.exitCode, timedOut: !!r.timedOut, durationMs: r.durationMs, peakMemoryBytes: r.peakMemoryBytes, error: r.errMsg || r.error });
    });
  });
}

/** 一个 PowerShell 进程里最多跑多少个测试点（分批执行：兼顾"测试点逐个点亮"的实时感与启动开销） */
const BATCH_CHUNK = 5;

/**
 * Windows 内存采样器：整个提交只启动一个 PowerShell 进程，通过两个小文件与 Node 通信
 * （请求 { pid, untilMs } / 应答 { pid, peakBytes }），避免每个测试点都付一次进程启动开销。
 */
class MemSampler {
  /** @param {string} dir 通信文件所在目录
   *  @param {string} tag 文件名后缀，用于让**并发**判题的多个采样器各用一组文件（互不覆盖） */
  constructor(dir, tag = '') {
    this.dir = dir;
    this.tag = tag ? `_${tag}` : '';
    this.reqFile = path.join(dir, `_mem_req${this.tag}.json`);
    this.resFile = path.join(dir, `_mem_res${this.tag}.json`);
    this.child = null;
    this.ok = false;
    this.lastPeak = new Map();
  }

  /** 采样器进程是否仍可用（常驻复用前必须确认，否则会读到上一次评测的陈旧结果） */
  isAlive() { return !!(this.ok && this.child && this.child.exitCode === null && this.child.signalCode === null); }

  /**
   * 启动采样器（**只起进程，不等自检**）。
   * 自检单独走 selfCheck()：满载时 PowerShell 冷启动可达 10~15 秒，
   * 把「启动」和「自检等待」拆开后，评测线程就不必为冷启动买单（见 startSamplerAsync）。
   */
  launch() {
    if (process.platform !== 'win32') return false;
    if (!fs.existsSync(MEM_SAMPLER)) return false;
    this.exited = false;
    try {
      // M17：采样轮询间隔由系统设置 judge_mem_sample_interval_ms 决定（默认 1ms，与历史一致）
      const intervalMs = memSampleIntervalMs();
      this.child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', MEM_SAMPLER, this.reqFile, this.resFile, String(MEM_CFG.idleMs), '-SampleIntervalMs', String(intervalMs)], { stdio: 'ignore', windowsHide: true });
    } catch { this.child = null; }
    if (!this.child || !this.child.pid) return false;
    this.child.on('error', () => { this.ok = false; this.exited = true; });
    // 采样器自行空闲退出（20s 无请求）后标记为不可用，避免后续误用
    this.child.on('exit', () => { this.ok = false; this.exited = true; });
    return true;
  }

  /** 用本进程自己的 pid 做一次协议自检；成功返回 true（true 才允许进池复用）。
   *  目标进程常驻，因此 untilMs 给 150ms 就够——采样器会立刻写回应答；
   *  真正影响成败的是 PowerShell 冷启动耗时，所以这里由调用方给等待窗口。
   *  分片轮询：**采样器进程一退出就立刻失败**（脚本缺失/被杀软拦下时不再空等整个窗口）；
   *  且一次只做一次自检（原先失败会重试 2 次 × 12 秒 ≈ 24 秒白等，是实测 30 秒卡顿的来源）。 */
  async selfCheck(waitMs) {
    if (!this.child || !this.child.pid) return false;
    this.begin(process.pid, Date.now() + 150);
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (this.exited) return false;
      const peak = await this.peakFor(process.pid, Math.min(500, Math.max(50, waitMs - (Date.now() - t0))));
      if (peak > 0) { this.ok = true; return true; }
    }
    return false;
  }

  begin(pid, untilMs) {
    // 每次请求都换一个随机 nonce（H2）：采样器会把它回显在应答里，只有带上本次 nonce 的应答才算数，
    // 这样选手进程即使猜到通道文件也无法伪造「内存很小」的采样结果。
    this.nonce = crypto.randomBytes(12).toString('hex');
    // 先清掉上一轮的应答：目标 pid 被系统复用时，陈旧应答会被误当成本次结果（可能造成误判 MLE）
    try { fs.rmSync(this.resFile, { force: true }); } catch { /* ignore */ }
    try { fs.writeFileSync(this.reqFile, JSON.stringify({ pid, untilMs, nonce: this.nonce })); } catch { /* ignore */ }
    this.lastPeak.delete(pid);
  }

  /** 等待该 pid 的采样结果（进程退出后采样器会写回应答）。
   *  等待窗口要覆盖「程序运行时长 + 采样器收尾」，否则长跑用例会取不到内存。
   *  @returns {Promise<number|null>} 采样到的峰值字节数；**null 表示没采到**（超时/进程不存在），
   *           与「采样到 0」区分开，调用方据此在判题明细里标注 memory_sampled。 */
  async peakFor(pid, timeoutMs = 3000) {
    if (this.lastPeak.has(pid)) return this.lastPeak.get(pid);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const raw = fs.readFileSync(this.resFile, 'utf8').replace(/^\uFEFF/, '');
        const r = JSON.parse(raw);
        // 必须同时匹配 pid 与本次请求的 nonce（H2：通道认证，防伪造）
        if (Number(r.pid) === Number(pid) && String(r.nonce || '') === this.nonce) {
          const peak = Number(r.peakBytes) || 0;
          this.lastPeak.set(pid, peak);
          // 采样器采样结束后停在「等一个不同 pid 的请求」上；发一个 pid=0 的哨兵让它回到空闲循环，
          // 这样即使下一次请求复用了同一个 pid 也不会卡住。
          try { fs.writeFileSync(this.reqFile, JSON.stringify({ pid: 0, untilMs: 0 })); } catch { /* ignore */ }
          return peak;
        }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 15));
    }
    return null;
  }

  stop() {
    // 只有**确实还活着**的进程才需要杀：进程已经退出时还去 taskkill，在满载机器上会同步阻塞数秒
    //（实测一次 releaseSampler 卡 3022ms），而且 pid 可能已被系统复用，误杀别人的进程。
    const alive = !!(this.child && this.child.pid && this.child.exitCode === null && this.child.signalCode === null);
    if (alive) {
      try { this.child.kill(); } catch { /* ignore */ }
      // 采样器是常驻 PowerShell 进程：kill() 只是发信号，若它仍活着会一直占 CPU，这里补一次强制结束整棵进程树
      try {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(this.child.pid)], { stdio: 'ignore', windowsHide: true });
      } catch { /* ignore */ }
    }
    try { fs.rmSync(this.reqFile, { force: true }); fs.rmSync(this.resFile, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 常驻内存采样器池。
 *
 * 背景（实测）：**每次评测都新建并等待一个 PowerShell 采样器**是 SPJ 提交里最贵的一步之一。
 * 采样器本身是按「请求文件 → 应答文件」工作的常驻进程（脚本内置空闲自退），可以跨提交复用。
 * 这里按「借出 / 归还」的方式复用：并发判题时每个并发槽各持一个（各自的 req/res 文件互不干扰）。
 *
 * **关键约束（实测踩过的坑）**：满载（CPU 97~99%）时 PowerShell 冷启动要 10~15 秒，
 * 而原来的「起进程 + 12 秒自检 × 最多 2 次」会让**每一次评测白等 24~30 秒**，
 * 单次提交因此从 3.6 秒劣化到 38~50 秒。现在的策略：
 *   1) 启动与自检分离，自检放到**后台**（startSamplerAsync），评测单次最多只等 acquireBudgetMs；
 *   2) 自检失败后退避 failBackoffMs，避免每个提交都往火坑里跳；
 *   3) **提交一进入判题就预热**（prewarmSamplers，见 judgeSubmission 开头）：编译要 2~5 秒，
 *      正好覆盖 PowerShell 冷启动，绝大多数提交在第一个测试点之前池就已经就绪；
 *   4) **每个测试点开始前再试一次**（runBatchNode / 交互题逐点循环）：池一就绪，本提交剩余测试点
 *      与后续提交都能用，不会因为「进判题那一刻池还没好」整份提交放弃采样；
 *   5) 空闲保活：池空时按 keepWarmMs 周期补一个，避免两次提交之间采样器自退后又要冷启动。
 * 池不可用时**不是记 0 了事**：Windows 上会退到不依赖 PowerShell 的兜底轮询（MemFallbackSampler），
 * 只有主采样器与兜底都拿不到时才标 memory_sampled=false（前端显示 —）。
 * 任何一层采样失败都**绝不影响判定**：不判 MLE、不改变 AC/WA/TLE 口径、不拖慢评测。
 */
const SAMPLER_DIR = path.join(os.tmpdir(), 'lczoj-memsampler');
/** 评测线程最多为「借采样器」等多久（超出就先不采样，后台起好后下次直接命中） */
const SAMPLER_ACQUIRE_BUDGET_MS = MEM_CFG.acquireBudgetMs;
/** 后台自检的第一段等待：正常负载下 0.3~0.6 秒内就有应答 */
const SAMPLER_SELFCHECK_MS = MEM_CFG.selfCheckFastMs;
/** 后台自检的第二段等待：覆盖满载时 10~15 秒的 PowerShell 冷启动 */
const SAMPLER_WARM_WAIT_MS = MEM_CFG.selfCheckWarmMs;
/** 自检失败后的退避时间：这段时间内不再尝试（避免每个提交白等一轮） */
const SAMPLER_FAIL_BACKOFF_MS = MEM_CFG.failBackoffMs;
/** 单个测试点开始前「再试一次」的等待上限（0 = 只看池里有没有现成的） */
const SAMPLER_CASE_ACQUIRE_MS = MEM_CFG.caseAcquireMs;
/** 池里同时保活的采样器个数（并发判题时每个槽一个） */
const SAMPLER_PREWARM_COUNT = MEM_CFG.prewarmCount;
const samplerPool = { seq: 0 };
/** 主采样器池（PowerShell）与兜底采样器池（cscript + WMI），结构相同、互不干扰 */
function makePool() { return { idle: [], warming: null, pending: 0, lastFailAt: 0 }; }
const psPool = makePool();
const jsPool = makePool();
const poolOf = (kind) => (kind === 'js' ? jsPool : psPool);

function samplerSupported() {
  return process.platform === 'win32' && fs.existsSync(MEM_SAMPLER);
}

/* ---------------- 兜底采样：常驻 cscript + WMI（完全不依赖 PowerShell） ----------------
 * 为什么不是 tasklist / wmic（本机实测，2026-10-04）：
 *   · tasklist /FI "PID eq <pid>" /FO CSV /NH ：1249~1391 ms/次；tasklist /FO CSV /NH 全量 3686~4848 ms/次；
 *   · wmic：本机（Windows 11 24H2 类环境）已不存在，spawn 直接 ENOENT；
 *   · cscript（Windows 自带，非 PowerShell）：常驻 + WMI 查询，一个进程覆盖所有 pid，
 *     不需要为每个采样点 spawn 进程，实测能抓到 60~180 ms 的短命程序（#1 A+B 12 次抓 9 次有非零值）。
 * 因此兜底做成「协议与 memsampler.ps1 完全一致」的常驻 JScript 采样器：
 *   reqFile: {"pid":N,"untilMs":T,"nonce":"..."} → resFile: {"pid":N,"peakBytes":B,"seen":0|1,"nonce":"..."}
 * 采样值同为工作集口径（PeakWorkingSetSize 只在进程存活时有效，故进程存活期间连续查询取最大值）。
 * 这样 judge.js 的采样器池可以原样复用（同一套借出/归还/自检逻辑），失败则退避、绝不影响判定。
 * 源码在运行时写到 os.tmpdir()，仓库里不新增文件；系统禁用 WSH 时 spawn 失败 → 退避 → 不采样。 */
const JS_SAMPLER_PATH = path.join(os.tmpdir(), 'lczoj-memsampler.js');
const JS_SAMPLER_SRC = [
  '// LCZOJ fallback memory sampler (resident JScript + WMI; no PowerShell). ASCII only.',
  '// argv: <reqFile> <resFile> <idleMs>',
  'var args = WScript.Arguments;',
  'var reqFile = args.length > 0 ? String(args(0)) : "";',
  'var resFile = args.length > 1 ? String(args(1)) : "";',
  'var idleMs = args.length > 2 ? parseInt(args(2), 10) : 45000;',
  'var fso = new ActiveXObject("Scripting.FileSystemObject");',
  'var wmi = null;',
  'try { wmi = GetObject("winmgmts:\\\\\\\\.\\\\root\\\\cimv2"); } catch (e) { wmi = null; }',
  'if (!wmi || !reqFile || !resFile) { WScript.Quit(3); }',
  'function nowMs() { return (new Date()).getTime(); }',
  'function readText(p) {',
  '  try { var f = fso.OpenTextFile(p, 1, false, 0); var s = f.ReadAll(); f.Close(); return s; }',
  '  catch (e) { return ""; }',
  '}',
  'function writeText(p, t) {',
  '  try { var f = fso.CreateTextFile(p, true, false); f.Write(t); f.Close(); return true; }',
  '  catch (e) { return false; }',
  '}',
  'function writeRes(pid, peak, seen, nonce) {',
  '  writeText(resFile, \'{"pid":\' + pid + \',"peakBytes":\' + peak + \',"seen":\' + seen + \',"nonce":"\' + nonce + \'"}\');',
  '}',
  '// Warm the WMI service up front: the very first query costs 1~2.5 s on a cold service.',
  'try { new Enumerator(wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=4")).atEnd(); } catch (e) { }',
  'var lastNonce = "";',
  'var idleStart = nowMs();',
  'var maxWaitMs = 8000;',
  'while (true) {',
  '  var raw = readText(reqFile);',
  '  var req = null;',
  '  if (raw) {',
  '    var mp = /"pid"\\s*:\\s*(\\d+)/.exec(raw);',
  '    if (mp) {',
  '      var mn = /"nonce"\\s*:\\s*"([^"]*)"/.exec(raw);',
  '      var mu = /"untilMs"\\s*:\\s*(\\d+)/.exec(raw);',
  '      req = { pid: parseInt(mp[1], 10), nonce: mn ? mn[1] : "", untilMs: mu ? parseInt(mu[1], 10) : 0 };',
  '    }',
  '  }',
  '  if (!req || req.pid <= 0 || req.nonce === lastNonce) {',
  '    if (idleMs > 0 && (nowMs() - idleStart) > idleMs) break;',
  '    WScript.Sleep(1);',
  '    continue;',
  '  }',
  '  lastNonce = req.nonce;',
  '  idleStart = nowMs();',
  '  var pid = req.pid;',
  '  var peak = 0;',
  '  var seen = 0;',
  '  var waitMs = maxWaitMs;',
  '  if (req.untilMs > 0) { var left = req.untilMs - nowMs(); if (left < waitMs) { waitMs = left + 500; } }',
  '  if (waitMs < 200) { waitMs = 200; }',
  '  var deadline = nowMs() + waitMs;',
  '  var polls = 0;',
  '  var lastGrow = nowMs();',
  '  var sent = 0;',
  '  while (true) {',
  '    var got = false;',
  '    try {',
  '      var col = wmi.ExecQuery("SELECT WorkingSetSize,PeakWorkingSetSize FROM Win32_Process WHERE ProcessId=" + pid);',
  '      var en = new Enumerator(col);',
  '      if (!en.atEnd()) {',
  '        var pr = en.item(); got = true; seen = 1;',
  '        var pk = 0, ws = 0;',
  '        try { pk = pr.PeakWorkingSetSize; } catch (e2) { pk = 0; }',
  '        try { ws = pr.WorkingSetSize; } catch (e3) { ws = 0; }',
  '        if (pk > peak) { peak = pk; lastGrow = nowMs(); }',
  '        if (ws > peak) { peak = ws; lastGrow = nowMs(); }',
  '        // Answer as soon as anything was measured: the caller only waits a few hundred ms',
  '        // (a ~70 ms program is gone long before a slower answer could arrive), we keep tracking',
  '        // afterwards and overwrite the response with the final (never smaller) peak.',
  '        if (peak > 0 && !sent) { writeRes(pid, peak, seen, req.nonce); sent = 1; }',
  '      }',
  '    } catch (e4) { got = false; }',
  '    if (!got) break;',
  '    polls++;',
  '    var n2 = nowMs();',
  '    if (n2 >= deadline) break;',
  '    if (polls > 400) break;',
  '    // Process already gone: WMI may keep returning the cached instance. Stop shortly after the',
  '    // peak stops growing so the next request (next test case) is served without a long delay.',
  '    if (peak > 0 && (n2 - lastGrow) > 150) break;',
  '    if (peak > 0 && (n2 - idleStart) > 150) { WScript.Sleep(10); } else { WScript.Sleep(0); }',
  '  }',
  '  writeRes(pid, peak, seen, req.nonce);',
  '}',
  '',
].join('\r\n');

/** 解析 Windows 自带的 cscript.exe（不是 PowerShell）；找不到返回 null */
function resolveCscript() {
  if (process.platform !== 'win32') return null;
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  try {
    const p = path.join(root, 'System32', 'cscript.exe');
    if (fs.existsSync(p)) return p;
  } catch { /* ignore */ }
  return 'cscript';   // 退到 PATH 查找（找不到时 spawn 报错，池会退避）
}

/** 把兜底采样器脚本写到临时目录（内容变化才重写）；返回路径或 null */
function ensureJsSamplerFile() {
  if (process.platform !== 'win32' || !MEM_CFG.fallbackEnabled) return null;
  try {
    let cur = '';
    try { cur = fs.readFileSync(JS_SAMPLER_PATH, 'utf8'); } catch { /* ignore */ }
    if (cur !== JS_SAMPLER_SRC) fs.writeFileSync(JS_SAMPLER_PATH, JS_SAMPLER_SRC, 'utf8');
    return JS_SAMPLER_PATH;
  } catch { return null; }
}

function fallbackSupported() {
  return process.platform === 'win32' && MEM_CFG.fallbackEnabled
    && !!resolveCscript() && !!ensureJsSamplerFile();
}

/** 兜底采样器是否可用（sync，仅用于判断「拿不拿得到」） */
function isFallbackSampler(s) {
  return !!(s && s.kind === 'js');
}

/** 起一个采样器并在**后台**完成自检；成功时结果会进入对应池的 idle 备用。返回 Promise<MemSampler|null> */
function startSamplerAsync(kind = 'ps') {
  const pool = poolOf(kind);
  const tag = `${kind}${++samplerPool.seq}`;
  try { fs.mkdirSync(SAMPLER_DIR, { recursive: true }); } catch { /* ignore */ }
  const s = kind === 'js' ? new MemSamplerJS(SAMPLER_DIR, tag) : new MemSampler(SAMPLER_DIR, tag);
  pool.pending++;
  const done = () => { pool.pending = Math.max(0, pool.pending - 1); };
  if (!s.launch()) {
    try { s.stop(); } catch { /* ignore */ }
    pool.lastFailAt = Date.now();
    done();
    return Promise.resolve(null);
  }
  const p = (async () => {
    if (await s.selfCheck(SAMPLER_SELFCHECK_MS)) return s;
    if (await s.selfCheck(SAMPLER_WARM_WAIT_MS)) return s;
    try { s.stop(); } catch { /* ignore */ }
    pool.lastFailAt = Date.now();
    console.warn(`[judge] 内存采样器（${kind === 'js' ? 'cscript+WMI 兜底' : 'PowerShell'}）启动/自检失败：未来 `
      + Math.round(SAMPLER_FAIL_BACKOFF_MS / 1000) + ' 秒内不再尝试该通道'
      + (kind === 'ps' ? '，这段时间内的提交改用不依赖 PowerShell 的兜底采样' : '')
      + '；采样不到时 memory_sampled 记 false（不判 MLE、不影响判定结果）');
    return null;
  })();
  p.then((r) => { done(); if (r) pool.idle.push(r); }, () => { done(); });
  return p;
}

/**
 * 预热常驻采样器：提交一进入判题就调用（此时离真正的测试点运行还有准备目录 + 编译的 2~5 秒），
 * 把 PowerShell 冷启动的成本藏进这段时间；池就绪后本提交与后续提交都能直接借用。
 * 若此刻池里**没有现成的** PowerShell 采样器（刚自退或还在冷启动），额外预热一个兜底
 * （cscript+WMI，1~3.5 秒就绪）：这样「池正要重建」的空窗期也不会又变成一片「—」。
 * PowerShell 通道彻底不可用（脚本缺失 / 退避中）时，同样只预热兜底通道。
 * 完全后台执行，不阻塞判题，也绝不抛错。
 */
function prewarmSamplers(count = SAMPLER_PREWARM_COUNT) {
  try {
    if (!memSampleEnabled()) return;   // M17：后台关闭内存采样时不预热任何采样进程
    const psOk = samplerSupported() && Date.now() - psPool.lastFailAt >= SAMPLER_FAIL_BACKOFF_MS;
    if (psOk) {
      const want = Math.max(0, count) - psPool.idle.length - psPool.pending;
      for (let i = 0; i < want; i++) startSamplerAsync('ps');
      // 池里没有现成的（正要重建）时才预热兜底；有现成的就不必多起一个 cscript
      if (psPool.idle.length === 0) prewarmFallback();
      return;
    }
    prewarmFallback();
  } catch { /* 采样设施问题绝不影响判题 */ }
}

/** 预热一个兜底（cscript + WMI）采样器（串行通道，一个就够） */
function prewarmFallback() {
  try {
    if (!fallbackSupported()) return;
    if (Date.now() - jsPool.lastFailAt < SAMPLER_FAIL_BACKOFF_MS) return;
    if (jsPool.idle.length > 0 || jsPool.pending > 0) return;
    startSamplerAsync('js');
  } catch { /* ignore */ }
}

/**
 * 从指定通道借一个可用采样器。**绝不让评测等太久**：池里有就直接给，否则最多等 budgetMs，
 * 拿不到就返回 null（本次评测不采样）；后台的启动会继续，起好后进池供下次使用。
 * 并发判题时每个并发槽各拿一个自己的采样器（谁先取走谁用，取不到的返回 null，不会共用同一组文件）。
 * @param {'ps'|'js'} kind 采样通道
 * @param {number} [budgetMs] 本次最多等多久（默认 acquireBudgetMs；测试点级的重试给更短的时间）
 */
async function acquireFromPool(kind, budgetMs = SAMPLER_ACQUIRE_BUDGET_MS) {
  // M17：后台关闭「内存采样」时一条也不借、一个进程也不起（memory_kb 记 0、memory_sampled=false，
  // 因此不会判 MLE）；默认开启，与历史行为一致。
  if (!memSampleEnabled()) return null;
  const pool = poolOf(kind);
  const supported = kind === 'js' ? fallbackSupported() : samplerSupported();
  if (!supported) return null;
  const take = () => {
    while (pool.idle.length) {
      const s = pool.idle.pop();
      if (s.isAlive()) return s;
      try { s.stop(); } catch { /* ignore */ }
    }
    return null;
  };
  const __t0 = Date.now();
  const hit = take();
  if (hit) { if (process.env.OJ_JUDGE_TRACE === '1') console.log(`[TIMING] acquire ${kind} 池命中 ${Date.now() - __t0}ms`); return hit; }
  if (Date.now() - pool.lastFailAt < SAMPLER_FAIL_BACKOFF_MS) { if (process.env.OJ_JUDGE_TRACE === '1') console.log(`[TIMING] acquire ${kind} 退避中 -> null`); return null; }
  if (!pool.warming) {
    const p = startSamplerAsync(kind);
    pool.warming = p;
    p.then(() => { if (pool.warming === p) pool.warming = null; },
      () => { if (pool.warming === p) pool.warming = null; });
  }
  const budget = Math.max(0, Number(budgetMs) || 0);
  const r = await Promise.race([
    pool.warming,
    new Promise((res) => { const t = setTimeout(() => res(null), budget); if (t.unref) t.unref(); }),
  ]);
  if (process.env.OJ_JUDGE_TRACE === '1') console.log(`[TIMING] acquire ${kind} 等待 ${Date.now() - __t0}ms -> ${r ? 'ok' : 'null'}`);
  if (!r) return null;                       // 还在冷启动：先不采样，后台起好后下次命中
  return take();                             // 已被并发请求取走时返回 null，本次不采样
}

/** 借主（PowerShell）采样器 */
function acquireSampler(budgetMs = SAMPLER_ACQUIRE_BUDGET_MS) {
  return acquireFromPool('ps', budgetMs);
}

/** 借兜底（cscript + WMI）采样器：主采样器不可用时的最后一道内存数据来源 */
function acquireFallbackSampler(budgetMs = SAMPLER_ACQUIRE_BUDGET_MS) {
  return acquireFromPool('js', budgetMs);
}

/** 归还采样器（仍存活则留在对应池里复用；已退出则清理） */
function releaseSampler(s) {
  if (!s) return;
  const pool = poolOf(s.kind === 'js' ? 'js' : 'ps');
  if (s.isAlive()) { pool.idle.push(s); return; }
  try { s.stop(); } catch { /* ignore */ }
}

/** 逐测试点取采样器：先试常驻池（可短等），池不可用则退到不依赖 PowerShell 的兜底通道 */
async function acquireSamplerForCase(budgetMs = SAMPLER_CASE_ACQUIRE_MS) {
  const s = await acquireSampler(budgetMs);
  if (s) return s;
  return acquireFallbackSampler(budgetMs);
}


/**
 * 兜底内存采样器：常驻 cscript + WMI，协议与 MemSampler（memsampler.ps1）完全一致。
 * 只覆盖 launch()：脚本源码由 judge.js 在运行时写到临时目录（仓库不新增文件），
 * 其余（begin / peakFor / selfCheck / stop / 池化复用）全部复用 MemSampler 的实现。
 */
class MemSamplerJS extends MemSampler {
  constructor(dir, tag) {
    super(dir, tag);
    this.kind = 'js';
    this.cscript = null;
  }

  launch() {
    if (process.platform !== 'win32') return false;
    const script = ensureJsSamplerFile();
    if (!script) return false;
    const cscript = resolveCscript();
    if (!cscript) return false;
    this.exited = false;
    this.cscript = cscript;
    try {
      this.child = spawn(cscript, ['//nologo', '//E:JScript', script, this.reqFile, this.resFile, String(MEM_CFG.idleMs)], { stdio: 'ignore', windowsHide: true });
    } catch { this.child = null; }
    if (!this.child || !this.child.pid) return false;
    this.child.on('error', () => { this.ok = false; this.exited = true; });
    this.child.on('exit', () => { this.ok = false; this.exited = true; });
    return true;
  }
}


// 服务启动后实测进程创建基线 + 预热采样器（都是后台异步，不影响进程退出）
setTimeout(() => { try { measureSpawnOverheadMs(); } catch { /* ignore */ } }, 1200).unref();
// 服务启动后主动预热采样器（unref 定时器，不影响进程退出）；正常负载下第一次评测即可直接借用
setTimeout(() => { try { prewarmSamplers(); } catch { /* ignore */ } }, 1500).unref();
// 空闲保活：池空就补一个，避免两次提交之间采样器自退（idleMs）后又要冷启动
if (MEM_CFG.keepWarmMs > 0) {
  setInterval(() => { try { prewarmSamplers(); } catch { /* ignore */ } }, MEM_CFG.keepWarmMs).unref();
}

/**
 * Node 直跑（Windows 快速通道）：由 Node 直接启动用户程序并做文件重定向，
 * 退出码 / 超时由 Node 精确控制；峰值内存由 MemSampler 采样。
 * 相比「每个测试点一个 PowerShell 进程 + WMI 子进程查询」，单点开销从数秒降到百毫秒级。
 */
async function runBatchNode(jobs, sampler) {
  const out = [];
  // 采样器可能在批量执行中途退出（常驻进程空闲自退 / 被外部结束）。
  // **每个测试点开始前都重新取一次**：池一就绪就立刻用上（不因「进判题那一刻池还没好」整份放弃），
  // 池仍然不可用就退到不依赖 PowerShell 的兜底轮询；两样都没有才标 memory_sampled=false。
  let cur = sampler && sampler.ok ? sampler : null;
  let idx = 0;
  for (const j of jobs) {
    const t0 = process.hrtime.bigint();
    if (!cur || !cur.isAlive()) {
      // 每个测试点开始前都再试一次：前几个测试点可以短等一下（预热通常已在编译期间完成），
      // 之后就只看两个池里有没有现成的，绝不空等——采样设施不可用时也绝不拖慢整份提交。
      cur = await acquireSamplerForCase(idx < 3 ? SAMPLER_CASE_ACQUIRE_MS : 0);
    } else if (isFallbackSampler(cur)) {
      // 正用着兜底通道：每个测试点都顺手看一眼主采样器是否已经就绪（就绪就换回更精确的它）
      const better = await acquireSampler(idx < 3 ? SAMPLER_CASE_ACQUIRE_MS : 0);
      if (better) { releaseSampler(cur); cur = better; }
    }
    idx++;
    let fdIn = null;
    let fdOut = null;
    let fdErr = null;
    try {
      fdIn = fs.openSync(j.stdinFile, 'r');
      fdOut = fs.openSync(j.stdoutFile, 'w');
      fdErr = fs.openSync(j.stderrFile, 'w');
    } catch (e) {
      out.push({ code: -1, timedOut: false, durationMs: 0, memoryKb: 0, memorySampled: false, error: '无法准备输入输出文件：' + e.message });
      continue;
    }
    let child = null;
    let timedOut = false;
    let outputExceeded = false;
    let stopWatch = null;
    try {
      // POSIX：独立进程组，便于整组结束（L7）；Windows 无此概念
      child = spawn(j.exe, j.args || [], judgeSpawnOpts({ cwd: j.cwd, stdio: [fdIn, fdOut, fdErr], windowsHide: true, detached: process.platform !== 'win32' }));
    } catch (e) {
      fs.closeSync(fdIn); fs.closeSync(fdOut); fs.closeSync(fdErr);
      out.push({ code: -1, timedOut: false, durationMs: 0, memoryKb: 0, memorySampled: false, error: '启动失败：' + e.message });
      continue;
    }
    if (cur && cur.ok) cur.begin(child.pid, Date.now() + (j.timeoutMs || 1000) + 2500);
    const timer = setTimeout(() => {
      timedOut = true;
      killTreeAsync(child);
    }, Math.max(100, j.timeoutMs || 1000));
    // M4：流式输出上限，超限立即杀进程（不再等跑完再把整份输出读进内存）
    if (j.outputLimitBytes) {
      stopWatch = startOutputWatch(j.stdoutFile, j.outputLimitBytes, () => { outputExceeded = true; killTreeAsync(child); });
    }
    let spawnError = '';
    const code = await new Promise((resolve) => {
      child.on('error', (e) => { spawnError = e && e.message ? e.message : String(e); resolve(-1); });
      child.on('close', (c) => resolve(c == null ? -1 : c));
    });
    clearTimeout(timer);
    if (stopWatch) stopWatch();
    const runMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // 采样器在进程退出后才写回应答：等待窗口按本用例实际运行时长放大；null/0 = 没采到。
    // 兜底轮询的窗口更短（它是在进程运行期间轮询的，值通常已经拿到），失败也绝不拖慢判题。
    let peak = null;
    if (cur && cur.ok) {
      const isFallback = isFallbackSampler(cur);
      // 兜底通道（cscript+WMI）的值来自「进程存活期间的连续查询」，进程一退出就不会再有新值，
      // 所以只需一个短窗口，绝不为它多等；主采样器是进程退出后写应答，窗口按运行时长放大。
      const waitMs = isFallback
        ? MEM_CFG.fallbackWaitMs + MEM_CFG.fallbackSettleMs
        : Math.max(3000, runMs + 2500);
      try { peak = await cur.peakFor(child.pid, waitMs); } catch { peak = null; }
    }
    try { fs.closeSync(fdIn); } catch { /* ignore */ }
    try { fs.closeSync(fdOut); } catch { /* ignore */ }
    try { fs.closeSync(fdErr); } catch { /* ignore */ }
    if (j.outputLimitBytes && !outputExceeded) {
      try { if (fs.statSync(j.stdoutFile).size > j.outputLimitBytes) outputExceeded = true; } catch { /* ignore */ }
    }
    // M7：只有**真的采到正值**才算采到（peak 为 0 说明进程已经没了、什么也没读到，
    // 不能算「内存 0 KB」）；memory_kb 也只在采到时填真实值。
    out.push({
      code,
      timedOut,
      durationMs: runMs,
      memoryKb: peak > 0 ? Math.max(1, Math.round(peak / 1024)) : 0,
      memorySampled: peak > 0,
      outputExceeded,
      error: '',
      // 进程**没能启动**时的系统错误（EPERM/ENOENT…）。与 error 分开保存，
      // 这样既有调用方的判定逻辑完全不受影响，SPJ 侧可用它给出可诊断的原因并重试。
      spawnError,
    });
  }
  // 兜底通道是**串行**的单资源：用完了要还回池里，否则下一次（下一个提交/下一个测试点）
  // 又要重新起一个 cscript（冷启动 1~3.5 秒），白等一轮。
  if (isFallbackSampler(cur)) releaseSampler(cur);
  return out;
}

/**
 * Windows 批量执行：把多个任务合并到同一个 PowerShell 包装器进程里依次执行。
 * 目的是摊薄每个测试点一次的 PowerShell 启动 + WMI 预热开销（实测每点约 1s+）。
 * jobs: [{ exe, args, cwd, timeoutMs, stdinFile, stdoutFile, stderrFile }]
 * 返回与 jobs 等长的结果数组（形状同 runMeasured）。
 */
async function runMeasuredBatch(jobs) {
  if (process.platform !== 'win32' || jobs.length === 0) {
    const out = [];
    for (const j of jobs) out.push(await runMeasured(j.exe, j.args, j));
    return out;
  }
  if (jobs.length === 1) {
    const r = await runMeasured(jobs[0].exe, jobs[0].args, jobs[0]);
    return [r];
  }
  const out = [];
  for (let i = 0; i < jobs.length; i += BATCH_CHUNK) {
    const chunk = jobs.slice(i, i + BATCH_CHUNK);
    const dir = chunk[0].cwd || JUDGE_DIR;
    const jobFile = path.join(dir, `_batch_${i}.json`);
    const resultFile = path.join(dir, `_batch_${i}_result.json`);
    fs.writeFileSync(jobFile, JSON.stringify({ jobs: chunk }));
    try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }

    const maxTimeout = chunk.reduce((m, j) => Math.max(m, j.timeoutMs || 0), 0);
    const results = await new Promise((resolve) => {
      let settled = false;
      const finish = (arr) => { if (!settled) { settled = true; clearTimeout(failsafe); resolve(arr); } };
      let child = null;
      try {
        child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RUNNER, jobFile, resultFile], { stdio: 'ignore', windowsHide: true });
      } catch (e) { finish(null); return; }
      // 兜底：整批任务最坏情况 = 各任务超时之和 + 30s 余量
      const failsafe = setTimeout(() => {
        if (child && child.pid) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
        finish(null);
      }, chunk.reduce((s, j) => s + (j.timeoutMs || 1000), 0) + 30000);
      child.on('error', () => finish(null));
      child.on('close', () => {
        let r = null;
        try { r = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* ignore */ }
        finish(r && Array.isArray(r.results) ? r.results : null);
      });
    });
    for (let k = 0; k < chunk.length; k++) {
      const r = results && results[k];
      out.push(r ? {
        code: r.exitCode == null ? -1 : r.exitCode,
        timedOut: !!r.timedOut,
        durationMs: r.durationMs != null ? r.durationMs : 0,
        memoryKb: Math.round((r.peakMemoryBytes || 0) / 1024),
        error: r.errMsg || '',
      } : { code: -1, timedOut: false, durationMs: 0, memoryKb: 0, error: '判题包装器未返回结果' });
    }
    try { fs.rmSync(jobFile, { force: true }); fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }
  }
  return out;
}

/**
 * Node 直跑单个测试点（Windows 快速通道，交互题 / grader 用）：
 * 文件重定向（不用命名管道），退出码与超时由 Node 精确控制，比 PowerShell 包装器快一个数量级
 * （实测包装器每点 1.6~2.4 秒，Node 直跑约百毫秒）。峰值内存可选采样（sampler 为 null 时记 0）。
 * 返回形状与 runMeasured 一致。
 */
async function runMeasuredNode(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile, sampler, outputLimitBytes, dropPriv }) {
  const t0 = process.hrtime.bigint();
  let fdIn = null;
  let fdOut = null;
  let fdErr = null;
  try {
    fdIn = fs.openSync(stdinFile, 'r');
    fdOut = fs.openSync(stdoutFile, 'w');
    fdErr = fs.openSync(stderrFile, 'w');
  } catch (e) {
    return { code: -1, timedOut: false, durationMs: 0, memoryKb: 0, memorySampled: false, error: '无法准备输入输出文件：' + e.message };
  }
  let child = null;
  let timedOut = false;
  let outputExceeded = false;
  let stopWatch = null;
  try {
    child = spawn(exe, args || [], judgeSpawnOpts({ cwd, stdio: [fdIn, fdOut, fdErr], windowsHide: true, detached: process.platform !== 'win32' }, dropPriv));
  } catch (e) {
    try { fs.closeSync(fdIn); fs.closeSync(fdOut); fs.closeSync(fdErr); } catch { /* ignore */ }
    return { code: -1, timedOut: false, durationMs: 0, memoryKb: 0, memorySampled: false, error: '启动失败：' + e.message };
  }
  // 采样器：**只用在调用方明确给了一个可用采样器时**。
  //  · 普通题 / 交互题的选手程序走 runBatchNode（那里会逐测试点借采样器，含兜底通道）；
  //  · SPJ checker 是评测设施、且有意传 sampler:null（它的内存不计入任何限制），
  //    这里绝不自己去借采样器——否则每个 checker 都白搭一次采样开销，还可能干扰 checker 执行。
  const useS = sampler && sampler.ok ? sampler : null;
  if (useS && child.pid) {
    try { useS.begin(child.pid, Date.now() + (timeoutMs || 1000) + 2500); } catch { /* ignore */ }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    killTreeAsync(child);
  }, Math.max(100, timeoutMs || 1000));
  // M4：流式输出上限
  if (stdoutFile && outputLimitBytes) {
    stopWatch = startOutputWatch(stdoutFile, outputLimitBytes, () => { outputExceeded = true; killTreeAsync(child); });
  }
  let spawnError = '';
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { spawnError = e && e.message ? e.message : String(e); resolve(-1); });
    child.on('close', (c) => resolve(c == null ? -1 : c));
  });
  clearTimeout(timer);
  if (stopWatch) stopWatch();
  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
  let memoryKb = 0;
  let memorySampled = false;
  if (useS && child.pid) {
    try {
      // 主采样器：进程退出后等应答（250ms 足够，交互题进程存活更久）；兜底通道：值通常已在手里
      const waitMs = isFallbackSampler(useS)
        ? MEM_CFG.fallbackWaitMs + MEM_CFG.fallbackSettleMs
        : 250;
      const peak = await useS.peakFor(child.pid, waitMs);
      // 只有采到正值才算采到（0 = 没读到进程，不能当成「内存 0 KB」）
      memorySampled = peak > 0;
      memoryKb = memorySampled ? Math.max(1, Math.round(peak / 1024)) : 0;
    } catch { /* 采样失败绝不影响判定 */ }
  }
  try { fs.closeSync(fdIn); } catch { /* ignore */ }
  try { fs.closeSync(fdOut); } catch { /* ignore */ }
  try { fs.closeSync(fdErr); } catch { /* ignore */ }
  if (outputLimitBytes && !outputExceeded) {
    try { if (fs.statSync(stdoutFile).size > outputLimitBytes) outputExceeded = true; } catch { /* ignore */ }
  }
  // spawnError：进程**没能启动**时的系统错误（EPERM/ENOENT…），与 error 分开保存，
  // 既有调用方的判定逻辑不受影响；SPJ 侧用它诊断「退出码 -1」并决定是否重试。
  return { code, timedOut, durationMs, memoryKb, memorySampled, outputExceeded, error: '', spawnError };
}

function runMeasuredUnix(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile, dropPriv }) {  return new Promise((resolve) => {
    const timeLog = path.join(cwd, '_time.log');
    // 尝试用 /usr/bin/time -v 采样内存
    const hasTime = (() => { try { return spawnSync('/usr/bin/time', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
    let full;
    if (hasTime) {
      full = ['/usr/bin/time', '-v', '-o', `"${timeLog}"`, exe, ...args.map((a) => `"${a}"`)].join(' ');
    } else {
      full = [exe, ...args.map((a) => `"${a}"`)].join(' ');
    }
    if (stdinFile) full += ` < "${stdinFile}"`;
    if (stdoutFile) full += ` > "${stdoutFile}"`;
    if (stderrFile) full += ` 2> "${stderrFile}"`;

    const start = process.hrtime.bigint();
    let child = null;
    let timedOut = false;
    let settled = false;
    const finish = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let memoryKb = 0;
      if (hasTime) {
        try {
          const log = fs.readFileSync(timeLog, 'utf8');
          const m = log.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
          if (m) memoryKb = parseInt(m[1], 10);
        } catch { /* ignore */ }
      }
      resolve({
        code: obj.code == null ? -1 : obj.code,
        timedOut: !!timedOut,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        memoryKb,
        // M7：POSIX 用 /usr/bin/time -v 采样；拿不到就标记为「未采样」，不再静默当成 0
        memorySampled: hasTime && memoryKb > 0,
        error: obj.error || '',
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child && child.pid && child.exitCode === null && child.signalCode === null) {
        // L7：POSIX 下按进程组结束（spawn 时 detached:true），避免子进程残留
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      finish({});
    }, timeoutMs);
    // POSIX：独立进程组 + 独立跑，便于整组结束（L7）
    try { child = spawn(full, judgeSpawnOpts({ cwd, shell: true, stdio: 'ignore', windowsHide: true, detached: true }, dropPriv)); } catch (e) { finish({ error: e.message }); return; }
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

// ---------------- 判定工具 ----------------

/** 输出归一化：去行尾空白、去末尾换行、统一换行 */
function normalizeOutput(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/**
 * 编译一份选手源码。
 * @param {string} exeName 输出可执行文件名（默认 main.exe）。
 *   通信题需要把**两个**选手程序分别编译成两个可执行文件（main.exe / main2.exe），
 *   否则同一目录里第二次编译会覆盖第一次的产物；其余题型一律用默认值，行为完全不变。
 */
function compile(lang, dir, srcFile, o2 = true, exeName = 'main.exe') {
  // M17：Python 解释器可在后台覆盖（judge_python_cmd）；未配置时用内置候选表自动探测
  const tool = overriddenTool(lang) || resolveTool(lang.toolName);
  if (!tool) {
    return Promise.resolve({ ok: false, log: `未找到编译器 ${lang.toolName}（${lang.name}），无法评测` });
  }
  const exeFile = path.join(dir, exeName);
  const logFile = path.join(dir, 'compile.log');
  let tpl = lang.compile;
  // O2 开关：题目关闭 O2 时去掉编译参数中的 -O2（仅影响 C/C++ 类）
  if (!o2) tpl = tpl.replace(/-O2/g, '');
  // M17：后台配置的追加编译参数（仅 C/C++ 系；默认空 = 行为与历史一致）
  const extra = extraCompileFlags(lang.key);
  if (extra) tpl = tpl + ' ' + extra;
  const buildCmd = (t) => t
    .replace(/\{tool\}/g, `"${tool}"`)
    .replace(/\{src\}/g, `"${srcFile}"`)
    .replace(/\{exe\}/g, `"${exeFile}"`)
    .replace(/\{dir\}/g, `"${dir}"`);
  const cmd = buildCmd(tpl);
  // Go：module 模式（go.mod 由 judgeSubmission 写入）+ 共享 GOCACHE。
  // 共享缓存避免每次全新目录触发标准库全量重建（GOPATH 模式 20~30s，模块模式首次 20s+，缓存命中后 1~2s）。
  // GOCACHE 置于数据目录下跨提交复用；GOPROXY=off 禁止联网下载依赖（评测代码只允许标准库）。
  const goEnv = lang.key === 'go' ? {
    ...process.env,
    GOCACHE: path.join(DATA_DIR, 'gocache'),
    GOPATH: path.join(DATA_DIR, 'gopath'),
    GO111MODULE: 'on',
    GOPROXY: 'off',
  } : process.env;
  // 执行一次编译；失败时若是 -static 缺静态库（cannot find -l...），自动去掉 -static 用动态链接重试
  const attempt = (command) => runShell(command, {
    cwd: dir,
    timeoutMs: compileTimeoutMs(),
    stdoutFile: logFile,
    stderrFile: logFile,
    env: goEnv,
  }).then((r) => {
    // M5：只回读日志开头（最多 COMPILE_LOG_READ_BYTES），其余已在写入阶段被硬上限截断/终止
    const log = readFileHead(logFile, COMPILE_LOG_READ_BYTES);
    if (r.error) return { ok: false, log: `编译执行失败: ${r.error}\n${log}`, log };
    if (r.timedOut) return { ok: false, log: '编译超时', log };
    if (r.code !== 0) return { ok: false, log: log || `编译器退出码 ${r.code}`, log };
    return { ok: true, log, exeFile };
  });
  return attempt(cmd).then((res) => {
    if (res.ok || !/cannot find -l/i.test(res.log || '') || !/ -static\b/.test(cmd)) return res;
    // 缺静态库：回退动态链接（评测环境即运行环境，动态库可用）
    const dynCmd = buildCmd(tpl.replace(/ -static\b/g, ''));
    return attempt(dynCmd).then((res2) => {
      if (res2.ok) {
        res2.log = (res.log || '') + '\n[LCZOJ] 检测到系统缺少静态库（-static 链接失败），已自动改用动态链接编译。\n';
        res2.fallback = true;
      }
      return res2;
    });
  });
}

/** 编译 Special Judge checker（testlib 风格，洛谷参数：g++ -fno-asm -std=c++14 -O2）
 *  本机内置 testlib.h（见 testlib/ 目录），因此 checker.cpp 可直接 #include "testlib.h"，
 *  无需随测试数据包上传头文件；若数据包自带 testlib.h（与 checker.cpp 同目录），优先生效。
 *
 *  **编译产物按「源码内容哈希」长期缓存于 data/spj_cache**：同一道题的 checker 只要没改动，
 *  后续每次评测都直接复用已编译好的可执行文件，不再重复调用 g++（省去每次 0.3~2 秒的编译开销）。
 *  checker 源码 / 所用 testlib.h 任一变化，哈希随之改变 → 自动重新编译并生成新的缓存条目。 */
const crypto = require('crypto');
const { compileInteractor, compileFuncInteractive, compileRelayGrader, judgeInteractiveIO, judgeInteractiveFunc,
  pruneInteractorCache, releaseInteractiveAssets,
  // M17：交互题编译超时（系统设置可调）在设置页回显时也用它
  compileTimeoutMs: interactiveCompileTimeoutMs,
  // 消息精简：交互器 / grader 的结论在这里统一压缩（只留最后一条结论行，硬上限 300 字）
  tidyInteractorMessage, composeInteractorMessage,
  INTERACTOR_CACHE_DIR } = require('./interactive');
// 通信题（problem_type = 'communication'）：直连（direct）模式的双向管道运行器独立成模块，
// relay 模式的流程在本文件里同普通判题能力（runMeasured / compile / checker）一起实现。
const { runCommunicationDirect, readCaptured, fileSizeOf, commLimitMessage } = require('./communication');
const SPJ_CACHE_DIR = path.join(DATA_DIR, 'spj_cache');
/** 缓存上限：最多保留多少个 checker 可执行文件、以及多久未使用即清理（按最近使用时间计） */
const SPJ_CACHE_MAX_ENTRIES = 30;
const SPJ_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SPJ_TMP_MAX_AGE_MS = 5 * 60 * 1000;
/** checker 单次判定超时：5s 起步，按参与判定的文件（in/ouf/ans）总大小每 MB 追加 1s，上限 60s。
 *  固定 5s 在机器负载高时偏紧（实测 2 字节输入的 checker 单次也能跑到 1.7s，含杀软扫描）；
 *  超时只会判成系统错误（SE），不会把 WA 变成 AC，因此适当放宽只减少误判、不放宽判定。 */
const CHECKER_TIMEOUT_BASE_MS = 5000;
const CHECKER_TIMEOUT_MAX_MS = 60000;
/* M17：上面两个常量是「默认值」；实际取值来自系统设置 judge_checker_timeout_base_ms /
 * judge_checker_timeout_max_ms（未配置 = 用这两个默认值，行为与历史完全一致）。 */
function checkerTimeoutBaseMs() { return getIntSetting('judge_checker_timeout_base_ms', CHECKER_TIMEOUT_BASE_MS, 1000, 60000); }
function checkerTimeoutMaxMs() { return getIntSetting('judge_checker_timeout_max_ms', CHECKER_TIMEOUT_MAX_MS, 5000, 600000); }

/** 已在本进程内预热过的 checker 可执行文件（预热只做一次） */
const warmedCheckers = new Set();

/**
 * 预热 checker 可执行文件：**只做一次首次执行**（进程创建 + 系统/杀软首次扫描镜像），
 * 不等结果、3 秒后强制结束。调用点在「选手代码编译之前」，因此这段开销被编译时间遮住。
 * 参数故意给不存在的文件：testlib 风格的 checker 会立刻报错退出，不会真的判题。
 */
function warmChecker(exeFile) {
  if (process.platform !== 'win32' || !exeFile || warmedCheckers.has(exeFile)) return;
  if (!fs.existsSync(exeFile)) return;
  warmedCheckers.add(exeFile);
  try {
    const child = spawn(exeFile, ['?warmup', '?warmup', '?warmup'], { cwd: os.tmpdir(), stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    }, 3000);
    if (timer.unref) timer.unref();
    child.on('error', () => { /* 预热失败无所谓，正式判定时还有重试 */ });
    child.on('exit', () => clearTimeout(timer));
    if (child.unref) child.unref();
  } catch { /* ignore */ }
}

/** 正在被评测使用的 SPJ checker：judgeDir -> Set<绝对路径>。
 *  用于清理缓存时跳过正在运行的 checker，避免并发评测互相影响。 */
const spjInUse = new Map();

function trackChecker(judgeDir, exeFile) {
  let set = spjInUse.get(judgeDir);
  if (!set) { set = new Set(); spjInUse.set(judgeDir, set); }
  set.add(exeFile);
  return exeFile;
}

/** 一次评测结束：仅解除本次评测对 checker 的占用。
 *  **不再删除编译产物**（编译产物是跨提交复用的缓存，删除会导致下次评测重新编译）；
 *  只顺带清理编译中途失败 / 进程崩溃残留的 *.tmp 文件，返回清理数量。 */
function releaseSubmissionCheckers(judgeDir) {
  spjInUse.delete(judgeDir);
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(SPJ_CACHE_DIR)) {
      if (!name.endsWith('.tmp')) continue;
      const p = path.join(SPJ_CACHE_DIR, name);
      try {
        if (now - fs.statSync(p).mtimeMs > SPJ_TMP_MAX_AGE_MS) { fs.rmSync(p, { force: true }); removed++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}

/**
 * 清理 SPJ 编译缓存（启动时与定时执行）：**只做过期 / 超量淘汰，不整目录清空**，
 * 这样已编译的 checker 能持续被复用。
 *   1) 超过 5 分钟未变动的 *.tmp（编译中断残留）直接删除；
 *   2) checker_*.exe 按「最近使用时间」保留最新 SPJ_CACHE_MAX_ENTRIES 个；
 *   3) 超过 SPJ_CACHE_MAX_AGE_MS 未使用的条目删除。
 * 正在被评测使用的文件始终跳过。返回 { removed, kept }。
 */
function pruneSpjCache({ maxEntries = SPJ_CACHE_MAX_ENTRIES, maxAgeMs = SPJ_CACHE_MAX_AGE_MS } = {}) {
  const inUse = new Set();
  for (const set of spjInUse.values()) for (const p of set) inUse.add(p);
  let names = [];
  try { names = fs.readdirSync(SPJ_CACHE_DIR); } catch { return { removed: 0, kept: 0 }; }
  const now = Date.now();
  let removed = 0;
  const exes = [];
  for (const name of names) {
    const p = path.join(SPJ_CACHE_DIR, name);
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    if (name.endsWith('.tmp')) {
      if (now - st.mtimeMs > SPJ_TMP_MAX_AGE_MS && !inUse.has(p)) {
        try { fs.rmSync(p, { force: true }); removed++; } catch { /* ignore */ }
      }
      continue;
    }
    if (!/^checker_[0-9a-f]{6,}\.exe$/.test(name)) continue;   // 只管理本模块生成的缓存文件
    exes.push({ p, mtime: st.mtimeMs });
  }
  exes.sort((a, b) => b.mtime - a.mtime);                       // 最近使用的排前面
  exes.forEach((e, i) => {
    const tooOld = now - e.mtime > maxAgeMs;
    if ((i >= maxEntries || tooOld) && !inUse.has(e.p)) {
      try { fs.rmSync(e.p, { force: true }); removed++; } catch { /* 文件被占用时留待下次清理 */ }
    }
  });
  return { removed, kept: exes.length - removed };
}

/** 兼容旧调用名（语义已由「整目录清空」改为「按上限/过期淘汰」） */
const cleanSpjCache = pruneSpjCache;

/** SPJ checker 的缓存键（sha1）：checker 源码 + 实际使用的 testlib.h + 编译参数。
 *  compileChecker 与「清理多余数据」页面共用这一份逻辑，保证「引用了哪些缓存」判断与编译时一致。 */
function spjHashOf(checkerSrcFile) {
  const srcDir = path.dirname(checkerSrcFile);
  const hashInput = [];
  try { hashInput.push(fs.readFileSync(checkerSrcFile, 'utf8')); } catch (e) { hashInput.push('?src'); }
  const dataTestlib = path.join(srcDir, 'testlib.h');
  // 注意：这里参与哈希的必须是 **testlib.h 文件本身**；此前误写成内置 testlib **目录**，
  // readFileSync 抛 EISDIR 后被 catch 吞掉、退化成常量 '?testlib'，
  // 结果是「内置 testlib.h 升级后旧 checker 仍命中旧缓存」。修好后哈希会变一次（旧条目作废一次）。
  const usedTestlib = fs.existsSync(dataTestlib) ? dataTestlib : path.join(__dirname, '..', 'testlib', 'testlib.h');
  try { hashInput.push(fs.readFileSync(usedTestlib, 'utf8')); } catch (e) { hashInput.push('?testlib'); }
  hashInput.push('flags:' + CHECKER_FLAGS);           // 编译参数变化时同样重新编译
  return crypto.createHash('sha1').update(hashInput.join('\n---\n')).digest('hex');
}

/** 某题 checker 的缓存键；题目没有 checker.cpp → null（供清理页判断缓存是否仍被题目引用） */
function checkerCacheKey(problemId) {
  let src = null;
  try { src = require('./db').checkerPath(problemId); } catch { return null; }
  try { if (!fs.statSync(src).isFile()) return null; } catch { return null; }
  return spjHashOf(src);
}

async function compileChecker(problemId, judgeDir, checkerSrcFile) {
  const tool = resolveTool('g++');
  if (!tool) return { ok: false, log: '未找到 g++，无法编译 Special Judge' };
  // 编译日志属于题目作者的私有信息（可能含 checker 源码上下文）→ 放私有目录
  const logFile = privFileOf(judgeDir, 'checker_compile.log');
  const srcDir = path.dirname(checkerSrcFile);
  const bundledTestlib = path.join(__dirname, '..', 'testlib');

  // 缓存键：checker 源码内容 + 所用 testlib.h 内容（数据包内同名文件优先，否则用内置的那份）
  const h = spjHashOf(checkerSrcFile);
  const cachedExe = path.join(SPJ_CACHE_DIR, 'checker_' + h + '.exe');

  // 命中缓存：直接复用（更新访问时间以便按「最近使用」淘汰），跳过 g++ 编译
  try {
    const st = fs.statSync(cachedExe);
    if (st.size > 0) {
      try { const t = new Date(); fs.utimesSync(cachedExe, t, t); } catch { /* ignore */ }
      console.log(`[OJ] SPJ checker 命中编译缓存（题目 #${problemId}），跳过编译：${path.basename(cachedExe)}`);
      warmChecker(cachedExe);
      return { ok: true, exeFile: trackChecker(judgeDir, cachedExe), cached: true };
    }
    fs.rmSync(cachedExe, { force: true });                   // 空文件视为无效，重新编译
  } catch { /* 未命中缓存 */ }

  // 编译到缓存路径（先写临时文件再改名，避免并发重复编译时读到半成品）
  try { fs.mkdirSync(SPJ_CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const tmpExe = cachedExe + '.' + process.pid + '.tmp';
  const cmd = `"${tool}" ${CHECKER_FLAGS} -I"${srcDir}" -I"${bundledTestlib}" "${checkerSrcFile}" -o "${tmpExe}"`;
  const t0 = Date.now();
  const r = await runShell(cmd, { cwd: srcDir, timeoutMs: compileTimeoutMs(), stdoutFile: logFile, stderrFile: logFile });
  let log = readFileHead(logFile, COMPILE_LOG_READ_BYTES);   // M5：只回读开头
  if (r.error) return { ok: false, log: `checker 编译执行失败: ${r.error}\n${log}` };
  if (r.timedOut) return { ok: false, log: 'checker 编译超时' };
  if (r.code !== 0) {
    try { fs.rmSync(tmpExe, { force: true }); } catch { /* ignore */ }
    return { ok: false, log: log || `checker 编译失败（退出码 ${r.code}）` };
  }
  try { fs.renameSync(tmpExe, cachedExe); } catch (e) { /* 改名失败（并发）则以现有缓存为准 */ }
  console.log(`[OJ] SPJ checker 编译完成并写入缓存（题目 #${problemId}，${Date.now() - t0}ms）：${path.basename(cachedExe)}`);
  // 刚编译出来的可执行文件第一次运行会被杀毒软件扫描：立刻预热一次，
  // 让这段开销与后面的选手代码编译重叠（正式判定的第一次调用因此不再是冷启动）。
  warmChecker(cachedExe);
  // 每次新增缓存条目后做一次轻量淘汰，避免目录无限增长
  try { pruneSpjCache(); } catch { /* ignore */ }
  return { ok: true, exeFile: trackChecker(judgeDir, cachedExe) };
}

/** checker 编译参数（洛谷风格）：-DTESTSYS 让 testlib 把「部分分」退出码基址设为 50
 *  （见 testlib.h：PC_BASE_EXIT_CODE，未定义 TESTSYS 时为 0，会和 _wa=1/_pe=2 撞码），
 *  这样 _pc(n)（= quitf(_pc(n), ...)）的退出码就是 50+n，可以无歧义地解析成 n% 的部分分。 */
const CHECKER_FLAGS = '-fno-asm -std=c++14 -O2 -DTESTSYS';

/**
 * 运行 Special Judge checker：参数顺序与 testlib 一致（in、ouf、ans）。
 * 退出码（testlib 约定）：0=AC、1=WA、2=PE（按 WA）、3=checker 异常、
 *   7=_points（quitp 部分分）、50..150=_pc(n) 部分分（n=0..100，即 50+n）。
 * 部分分取值优先级（L8，越靠前越优先）：
 *   1) 固定格式 `points=<num>`（整行/任意位置，推荐 checker 使用）；
 *   2) testlib 消息里的 `points <num>` / 行首数字（quitp 的消息就是「<points> <message>」）；
 *   3) 兼容旧的「stdout 里第一个数字」。
 * 数值口径：0~1 视为比例，1~100 视为百分比（与既有行为一致）。
 */
function parseSpjPoints(text) {
  const s = String(text == null ? '' : text);
  const fixed = s.match(/\bpoints\s*[=:]\s*(\d+(?:\.\d+)?)/i);
  let raw = fixed ? fixed[1] : null;
  if (raw == null) {
    const tl = s.match(/\bpoints\s+(\d+(?:\.\d+)?)/i);
    raw = tl ? tl[1] : null;
  }
  if (raw == null) {
    const first = s.match(/(\d+(?:\.\d+)?)/);
    raw = first ? first[1] : null;
  }
  if (raw == null) return null;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v <= 1) return v;                    // 比例
  if (v <= 100) return v / 100;            // 百分比
  return null;
}

/** 只认**显式的分数标记** `points=<num>` / `points: <num>`（L8 固定格式）。
 *  退出码 0 的 checker 只能用这种方式给部分分——否则会把判题消息里的普通数字（如「6 是 3 的倍数」里的 6）
 *  误当成分数（实测会算出 6% 这种荒唐结果，正解被扣分）。 */
function parseExplicitPoints(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/\bpoints\s*[=:]\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v <= 1) return v;
  if (v <= 100) return v / 100;
  return null;
}
/** 本次评测的 SPJ 判定耗时累计（按评测工作目录隔离，支持并行判题）。
 *  评测结束时汇总成一行日志，便于管理员核对缓存命中与各阶段耗时。 */
const spjStats = new Map();

async function runChecker(dir, checkerExe, inputFile, outputFile, ansFile, testcaseScore, opts = {}) {
  const t0 = process.hrtime.bigint();
  try {
    return await runCheckerRun(dir, checkerExe, inputFile, outputFile, ansFile, testcaseScore, opts);
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let st = spjStats.get(dir);
    if (!st) { st = { ms: 0, runs: 0, max: 0 }; spjStats.set(dir, st); }
    st.ms += ms;
    st.runs++;
    if (ms > st.max) st.max = ms;
  }
}

/** checker 日志上限：checker 的 stdout/stderr 只用来给出判题消息，1MB 已经远超需要（超限即杀 checker） */
const CHECKER_LOG_LIMIT_BYTES = 1024 * 1024;

async function runCheckerRun(dir, checkerExe, inputFile, outputFile, ansFile, testcaseScore, opts = {}) {
  const priv = ensurePrivDir(dir);
  const outLog = path.join(priv, 'checker_stdout.txt');
  const errLog = path.join(priv, 'checker_stderr.txt');
  // 超时按 in/ouf/ans 的实际大小放大（大测试数据的 checker 需要更久；超时只会判 SE，不会放宽判定）
  let sizeSum = 0;
  for (const f of [inputFile, outputFile, ansFile]) {
    try { sizeSum += fs.statSync(f).size; } catch { /* ignore */ }
  }
  const timeoutMs = Math.min(checkerTimeoutMaxMs(),
    checkerTimeoutBaseMs() + Math.ceil(sizeSum / (1024 * 1024)) * 1000);

  let exe = checkerExe;
  let r = null;
  let retried = false;
  for (;;) {
    // 缓存文件可能被外部清理掉（实测出现过：日志刚打出「命中编译缓存」，95ms 后 spawn 就报 ENOENT）。
    // 每点判定前花一次 stat 确认，必要时先重新编译，避免把外部清理算成选手的系统错误。
    if (!fs.existsSync(exe) && typeof opts.ensure === 'function') {
      try { const p = await opts.ensure(); if (p) exe = p; } catch { /* ignore */ }
    }
    // Windows 上优先用 Node 直跑：checker 走 PowerShell 包装器时光冷启动就可能吃掉大半超时
    //（负载高时包装器自身还会触发 30 秒兜底 → 误判成系统错误）。
    r = (process.platform === 'win32')
      ? await runMeasuredNode(exe, [inputFile, outputFile, ansFile], {
        cwd: dir, timeoutMs, stdinFile: inputFile, stdoutFile: outLog, stderrFile: errLog, sampler: null,
        outputLimitBytes: CHECKER_LOG_LIMIT_BYTES, dropPriv: false,   // checker 是受信任设施：保持原权限才能读 .priv/testdata
      })
      : await runMeasured(exe, [inputFile, outputFile, ansFile], {
        cwd: dir, timeoutMs, stdoutFile: outLog, stderrFile: errLog,
      });
    // 进程没能启动（spawn 报错 / 拿不到退出码且不是超时）：这是评测设施问题，
    // 常见于「刚编译出的 exe 首次执行被杀软/系统拦下」或「缓存文件被清理」。
    // 重新确认可执行文件（必要时重新编译）后重试一次，避免偶发系统错误。
    // 注意：只有「没拿到退出码」才算启动失败；checker 一旦给出 0/1/2/3，判定立即成立，不会重试。
    const startFailed = !r.timedOut && !r.error && (!!r.spawnError || r.code === -1);
    if (!startFailed || retried) break;
    retried = true;
    console.warn(`[judge] Special Judge checker 启动失败（${r.spawnError || '未拿到退出码'}），重试一次：${path.basename(exe)}`);
    if (typeof opts.ensure === 'function') {
      try { const p = await opts.ensure(); if (p) exe = p; } catch { /* ignore */ }
    }
    await new Promise((res) => setTimeout(res, 200));
  }

  // checker 的 stdout / stderr 是「外部进程输出」：中文 Windows 下 checker.cpp 若以 ANSI(GBK) 保存，
  // 编译出来的可执行文件会把 GBK 字节直接写到 stderr —— 必须按「UTF-8 优先 + GBK 回退」解码，
  // 否则判题消息（含部分分提示）在提交详情里全是 U+FFFD（待办 #16）。
  const read = (f) => readTextFile(f, '');
  if (r.error || r.timedOut) {
    return { verdict: VERDICTS.SE, fraction: 0, message: 'Special Judge 执行异常：' + (r.error || `超时（>${timeoutMs}ms）`) };
  }
  const code = r.code == null ? -1 : r.code;
  // 拿不到退出码（进程未能启动 / 被系统结束）：给出可诊断的原因，便于排查
  if (code === -1) {
    const why = r.spawnError ? `启动失败：${r.spawnError}` : '可能是 checker 可执行文件缺失或被系统结束';
    const tail = r.spawnError ? '' : read(errLog).slice(0, 200);
    return { verdict: VERDICTS.SE, fraction: 0, message: `Special Judge 未能正常结束（退出码 -1，${why}）` + (tail ? `：${tail}` : '') };
  }
  // 注意：testlib 的 checker 把判题消息（含 quitp/_pc 的分数）写在 **stderr**，stdout 通常为空。
  // 因此分数与消息都优先从 stderr 解析，stdout 只作为兼容兜底（自写 checker 可能打在 stdout）。
  const stderrText = String(read(errLog));
  const stdoutText = String(read(outLog));
  const textForPoints = stderrText || stdoutText;
  // 部分分（M6/L8）：0=AC（可带部分分）、7=_points（quitp）、50..150=_pc(n) 部分分
  if (code === 0 || code === 7 || (code >= 50 && code <= 150)) {
    const msg = textForPoints.trim().slice(0, 200);
    let fraction;
    if (code >= 50) {
      // _pc(n)：退出码 50+n（testlib 用 -DTESTSYS 编译时 PC_BASE_EXIT_CODE=50），n 即百分制得分
      fraction = (code - 50) / 100;
      const m = textForPoints.match(/partially\s+correct\s*\((\d+(?:\.\d+)?)\)/i);
      if (m) { const p = parseSpjPoints(m[1] + ' points'); if (p != null) fraction = p; }
    } else if (code === 7) {
      // quitp(points, msg)：消息形如「<points> <message>」；解析不到就按 0 分（不放大判定）
      const p = parseSpjPoints(textForPoints);
      fraction = p == null ? 0 : p;
    } else {
      // 退出码 0：**默认满分**（与既有语义一致）。只有 checker 显式写了 `points=<num>` 才按部分分算；
      // 绝不能拿判题消息里的普通数字当分数（testlib 的 ok 消息里常有哈希/计数等数字）。
      const p = parseExplicitPoints(stdoutText) != null ? parseExplicitPoints(stdoutText) : parseExplicitPoints(stderrText);
      fraction = p == null ? 1 : p;
    }
    return {
      verdict: VERDICTS.AC, fraction,
      message: (msg || 'Special Judge 判定通过') + (fraction < 1 ? `（部分分 ${Math.round(fraction * 100)}%）` : ''),
      spj_msg: msg,
    };
  }
  if (code === 1 || code === 2) {
    const msg = textForPoints.trim();
    return { verdict: VERDICTS.WA, fraction: 0, message: '答案错误（Special Judge）' + (msg ? `：${msg.slice(0, 150)}` : '') };
  }
  const stderr = stderrText.trim();
  return { verdict: VERDICTS.SE, fraction: 0, message: 'Special Judge 自身异常（exit ' + code + '）' + (stderr ? `：${stderr.slice(0, 150)}` : '') };
}

/** 组装用户程序的运行命令（批量执行与单点执行共用同一套逻辑） */
function buildRunCommand(lang, dir, srcFile, exeFile) {
  const runTool = lang.runToolName ? resolveTool(lang.runToolName) : null;
  // M17：解释器类语言（python）可在后台覆盖可执行文件；未配置时用自动探测结果
  const toolOverride = overriddenTool(lang);
  const runCmd = lang.run
    .replace(/\{tool\}/g, `"${toolOverride || resolveTool(lang.toolName) || lang.toolName}"`)
    .replace(/\{runTool\}/g, `"${runTool || lang.runToolName}"`)
    .replace(/\{src\}/g, `"${srcFile}"`)
    .replace(/\{exe\}/g, `"${exeFile}"`)
    .replace(/\{dir\}/g, `"${dir}"`);
  const tokens = tokenizeCommand(runCmd);
  return { exe: tokens[0], args: tokens.slice(1) };
}

/* ---------------- 判题私有目录（H2） ----------------
 * 选手程序 / 交互器 / grader / checker 都在同一个评测工作目录里跑，但**判题私有物**
 *（交互器隐藏输入、交互器输出（即选手答案）、checker 的 in/ans、checker 日志、内存采样通道）
 * 一律放在 <评测目录>/priv 下，选手程序的 cwd 不指向它：
 *   · POSIX 下降权运行时（见 H1）priv 为 0700、属 OJ 服务账户，选手进程根本读不到；
 *   · Windows 无降权能力时至少做到「不在选手 cwd 内、路径不可预测」，残余风险见 README/汇报。
 * 测试数据（<id>.in / <id>.out）则**直接从只读的题目数据目录读取**（不再复制到选手可写目录）。
 */
const PRIV_DIR_NAME = '.priv';
/** 选手可写工作目录：选手的 stdin/stdout/stderr 重定向文件放这里。
 *  为什么不放 .priv：POSIX 的 shell 重定向路径（runMeasuredUnix）需要**以选手身份**打开这些文件，
 *  而 .priv 是 0700 属 OJ 账户的私有目录。判题私有物（交互器输入/输出、checker 的 in/ans/日志、
 *  内存采样通道、提交答案题的答案文件）仍然只在 .priv 里，选手进程读不到。 */
const WORK_DIR_NAME = 'work';
function privDirOf(dir) { return path.join(dir, PRIV_DIR_NAME); }
function privFileOf(dir, name) { return path.join(privDirOf(dir), name); }
function workDirOf(dir) { return path.join(dir, WORK_DIR_NAME); }
function workFileOf(dir, name) { return path.join(workDirOf(dir), name); }

/** 建私有目录（0700）、选手工作目录，并确保评测目录本身不是符号链接/重解析点 */
function ensurePrivDir(dir) {
  ensureNoReparse(dir);
  // .priv：判分私有物。默认 0700（只有评测服务账户能进；POSIX 降权后选手进程完全读不到）。
  // 若希望低权账户「能读不能写」（例如把 checker 也降权运行），可设 OJ_JUDGE_PRIV_MODE=0750/0640
  //（代价：交互题隐藏输入对该账户可读，安全性下降，见汇报说明）。
  const privMode = parseInt(process.env.OJ_JUDGE_PRIV_MODE || '', 8);
  const pm = Number.isFinite(privMode) ? privMode : 0o700;
  try { fs.mkdirSync(privDirOf(dir), { recursive: true, mode: pm }); } catch { /* ignore */ }
  try { fs.chmodSync(privDirOf(dir), pm); } catch { /* Windows 忽略 */ }
  // work：选手的 stdin/stdout/stderr 落这里，POSIX 下降权后的选手进程必须能创建/写自己的文件
  //（用 sticky 位 1777，等价于 /tmp 语义：谁都能建自己的文件，但删不掉别人的）
  try { fs.mkdirSync(workDirOf(dir), { recursive: true, mode: 0o1777 }); } catch { /* ignore */ }
  try { fs.chmodSync(workDirOf(dir), 0o1777); } catch { /* Windows 忽略 */ }
  return privDirOf(dir);
}

/**
 * 拒绝符号链接 / Windows 重解析点（junction、mount point）：评测目录必须落在 data/judge 下的真实目录里，
 * 否则「私有目录与选手可写目录分离」的隔离假设就不成立（甚至可能被指向 data/oj.db 所在目录）。
 * 用 realpath 比对即可同时覆盖 symlink 与 NTFS junction，代价只有两次系统调用。
 */
function realpathSafe(p) {
  try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return p; }
}
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function ensureNoReparse(target) {
  const base = path.resolve(JUDGE_DIR);
  const abs = path.resolve(target);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('评测目录不在 data/judge 下：' + abs);
  if (!samePath(realpathSafe(base), base)) throw new Error('data/judge 是符号链接/重解析点，拒绝在此评测：' + base);
  let st = null;
  try { st = fs.lstatSync(abs); } catch { st = null; }
  if (st && st.isSymbolicLink()) throw new Error('评测目录本身是符号链接/重解析点：' + abs);
  if (!samePath(realpathSafe(abs), abs)) throw new Error('评测目录路径经过链接解析：' + abs);
  return true;
}

/** 题目测试数据文件（只读）：<data>/testdata/<pid>/<caseId>.<ext> */
function testdataCaseFile(problemId, caseId, ext) {
  return path.join(TESTDATA_DIR, String(problemId), `${caseId}.${ext}`);
}

/** checker / 交互器要用的测试输入：优先直接用题目数据目录里的文件（零拷贝，选手不可写） */
function checkerInputFile(dir, problem, testcase, fallback) {
  const p = testdataCaseFile(problem.id, testcase.id, 'in');
  try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  return fallback || path.join(dir, `input_${testcase.id}.txt`);
}

/** checker 要用的标准答案：优先直接用题目数据目录里的 <id>.out（零拷贝），否则落到私有目录 */
function checkerAnswerFile(dir, problem, testcase) {
  const p = testdataCaseFile(problem.id, testcase.id, 'out');
  try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  const dst = privFileOf(dir, `ans_${testcase.id}.txt`);
  try { fs.writeFileSync(dst, testcase.output ?? ''); } catch { /* ignore */ }
  return dst;
}

/** 为一个测试点准备运行任务（供批量执行使用）。
 *  H2：选手的 stdin/stdout/stderr 放在**可写工作目录 work/**（fd 继承给选手，POSIX 下 shell 重定向
 *  需要以选手身份打开），判题私有物（.priv/）不在选手 cwd 内；选手 cwd 也只指向 work/。 */
function prepareCaseJob(lang, dir, srcFile, exeFile, testcase, problem) {
  ensurePrivDir(dir);
  const inputFile = workFileOf(dir, `input_${testcase.id}.txt`);
  const outputFile = workFileOf(dir, `output_${testcase.id}.txt`);
  const errorFile = workFileOf(dir, `error_${testcase.id}.txt`);
  fs.writeFileSync(inputFile, testcase.input ?? '');
  const { exe, args } = buildRunCommand(lang, dir, srcFile, exeFile);
  // v2.5.3：该测试点实际生效的时限 = 点级 ?? 题目级
  const timeoutLimitMs = effectiveTimeLimitMs(problem, testcase);
  return {
    job: {
      exe,
      args,
      // H2：选手 cwd 只指向可写工作目录（语言模板里的 {dir}/{src}/{exe} 都是绝对路径，不受影响）
      cwd: workDirOf(dir),
      // L6：超时闸门 = 时限 + 实测的进程创建基线 + 500ms 余量 + 后台配置的额外余量（M17，默认 0）。
      // 只要创建进程本身就要好几秒（满载机器常见），原来固定的「时限 + 500ms」会把正解误判成 TLE。
      timeoutMs: timeoutLimitMs + measureSpawnOverheadMs() + 500 + timeExtraMs(),
      stdinFile: inputFile,
      stdoutFile: outputFile,
      stderrFile: errorFile,
      // M4：把输出上限带进运行器，由看门狗流式累计并及时杀进程
      // M17：输出上限来自系统设置 judge_output_limit_mb（默认 16MB）
      outputLimitBytes: outputLimitBytes(),
    },
    files: { inputFile, outputFile, errorFile },
  };
}

// ---------------- 交互题（仿洛谷）----------------

/** 判定题目是否为交互题（problem_type: interactive_io / interactive_func） */
function isInteractiveProblem(problem) {
  const t = problem && problem.problem_type ? String(problem.problem_type) : 'standard';
  return t === 'interactive_io' || t === 'interactive_func';
}

/** 判定题目是否为**通信题**（problem_type: communication）——第三种、独立题型：
 *  需要两个选手程序合作完成任务，与 interactive_io / interactive_func 的语义和评测实现互不复用。 */
function isCommunicationProblem(problem) {
  const t = problem && problem.problem_type ? String(problem.problem_type) : 'standard';
  return t === 'communication';
}

/** 是否需要「逐测试点与评测设施对接」的专用流程（交互题 / 通信题）：这类题不能走批量预跑，且需要内存采样器。
 *  普通题、SPJ 题、提交答案题一律返回 false，评测路径与行为完全不变。 */
function needsPerCasePipeline(problem) {
  return isInteractiveProblem(problem) || isCommunicationProblem(problem);
}

/** 通信题的两个选手程序都用 C/C++ 编译（两个独立可执行文件；解释型语言 / Java 的单文件约束不适用） */
const COMM_LANGS = ['cpp', 'cpp11', 'cpp98', 'c'];
/** 通信题「可疑用时重跑」的时限上限：只对小时限点重试，避免长时限题把整份提交推向判题总兜底超时 */
const COMM_RETRY_MAX_TIME_LIMIT_MS = 5000;
/** direct（双向管道直连）模式的冷启动宽限（毫秒）：两程序并行 + 无法按「有无数据流动」判空闲，
 *  只有墙钟可用，因此闸门比 relay 更宽（与 IO 交互题的 WARMUP_GRACE_MS 同一思路）。
 *  relay（默认）模式两个程序各自严格按点级 / 题目时限判定，不受此宽限影响。 */
const COMM_DIRECT_COLD_START_GRACE_MS = 5000;
/** 通信题：程序二源码的文件名后缀（与程序一同名 + '2'，如 main2.cpp） */
function commSrc2Name(lang) { return `${lang.srcName || 'main'}2`; }
/** 通信题：程序二可执行文件名 */
const COMM_EXE2 = 'main2.exe';

/** 函数式交互题：只有 C/C++ 能「grader + 选手源码一起编译链接」 */
const FUNC_INTERACTIVE_LANGS = ['cpp', 'c'];

/** 交互题可执行文件（交互器 / grader）的编译缓存：同一次评测内复用，避免每个测试点重复编译 */
const assetCache = new Map();
/** 本次评测内已装载的交互器 / grader（含失败结果），key: `${dir}|${kind}` */
function assetKey(dir, kind) { return `${dir}|${kind}`; }
/** 题目的 O2 设置（用于编译缓存键；交互器统一开 O2，此处主要给 grader 用） */
function o2Flag(problem) { return problem && problem.enable_o2 === 0 ? 'noO2' : 'O2'; }

/** 写入提交的 compile_error 并结束评测（仅用于交互题的前置检查失败） */
function failSubmission(submissionId, problemId, verdict, message) {
  db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ?, judge_detail = ? WHERE id = ?")
    .run('Done', verdict, String(message || '').slice(0, 4000), JSON.stringify([]), submissionId);
  bumpProblemStats(problemId);
}

/**
 * 判一个交互题测试点：按 problem_type 分流到 src/interactive.js。
 * 交互器 / grader 的编译结果由 opts.assets 在同一次提交内缓存复用。
 */
async function judgeInteractiveCase(lang, dir, srcFile, exeFile, testcase, problem, opts = {}) {
  const t = String(problem.problem_type || 'standard');
  const { interactorPath, graderPath } = require('./db');
  const cache = opts.assets || null;
  const memSampler = opts.memSampler || null;
  const caseIndex = opts.caseIndex || 0;
  // v2.5.3：交互题（IO / 函数式）同样按「点级 ?? 题目级」取限额——
  // interactive.js 只认 problem.time_limit_ms / memory_limit_mb，这里把点级限额叠加到题目对象上再传进去；
  // 该测试点未设置点级限额时 problemWithCaseLimits 原样返回同一对象，行为与改动前一致。
  const caseProblem = problemWithCaseLimits(problem, testcase);

  // 通信题（communication）：第三种题型，实现见本文件下面的 judgeCommunicationCase。
  // 放在这里是为了复用同一套「逐测试点 + 编译缓存 + 内存采样器」的调用点，但内部流程与交互题完全独立。
  if (t === 'communication') {
    return judgeCommunicationCase(lang, dir, srcFile, exeFile, testcase, problem, opts);
  }

  if (t === 'interactive_io') {
    // ---- 前置：交互器必须存在且能编译（每个提交只编译一次）----
    const src = interactorPath(problem.id);
    const key = assetKey(dir, `interactor_io|${o2Flag(problem)}`);
    let asset = cache ? cache.get(key) : null;
    // 编译产物可能被外部清理掉：缓存里记着路径但文件已不在时，丢掉缓存重新编译（而不是让交互器启动失败）
    if (asset && asset.ok && !fs.existsSync(asset.exeFile)) {
      console.warn('[judge] 交互器缓存文件已不存在，重新编译：' + asset.exeFile);
      asset = null;
      if (cache) cache.delete(key);
    }
    if (!asset) {
      asset = { ok: false, log: '' };
      if (!fs.existsSync(src)) {
        asset.log = '题目标记为 IO 交互题，但测试数据目录中缺少 interactor.cpp（请在题库后台「测试数据」中编写或上传交互器）';
      } else {
        const r = await compileInteractor(problem.id, dir, src, { runShell, resolveTool });
        asset = r.ok ? { ok: true, exeFile: r.exeFile } : { ok: false, log: r.log };
      }
      if (cache) cache.set(key, asset);
    }
    if (!asset.ok) {
      return {
        verdict: VERDICTS.SE, time_ms: 0, memory_kb: 0,
        // 编译日志必须带进判题详情，否则管理员只能反复猜（截断到 4KB）
        message: '交互器编译失败：' + String(asset.log || '(无编译输出)').slice(0, 4000),
        compile_log: String(asset.log || '').slice(0, 4000),
      };
    }
    const { exe, args } = buildRunCommand(lang, dir, srcFile, exeFile);
    const ioRes = await judgeInteractiveIO({
      dir, priv: privDirOf(dir), inputFileForInteractor: checkerInputFile(dir, problem, testcase, ''),
      // H1：只对**选手进程**降权；交互器是受信任设施（要读隐藏输入、写私有目录）保持原权限
      solutionSpawnOpts: judgeSpawnOpts({}, true),
      interactorExe: asset.exeFile, exeFile: exe, args,
      testcase, problem: caseProblem, sampler: memSampler,
      // M17：输出上限来自系统设置 judge_output_limit_mb（默认 16MB）
      outputLimitBytes: outputLimitBytes(),
    });
    // 交互 + SPJ：交互器把选手答案写到 argv[2]（这里由 interactive.js 传成 inter_output_<id>.txt），
    // 交互结束后运行 checker：checker <input> <交互器输出文件> <答案文件>，**以 checker 判定为准**。
    // checker 缺失或自身异常时退回交互器判定，保证不会因为评测设施问题把选手判错。
    if (opts.spj) {
      const ansFile = checkerAnswerFile(dir, problem, testcase);
      const inFile = checkerInputFile(dir, problem, testcase, ioRes.inputFile);
      const cres = await runChecker(dir, opts.spj, inFile,
        ioRes.interactorOutFile || privFileOf(dir, `inter_output_${testcase.id}.txt`), ansFile, testcase.subtask_score, { ensure: opts.spjEnsure });
      if (cres.verdict !== VERDICTS.SE) {
        return {
          ...cres,
          time_ms: ioRes.time_ms,
          memory_kb: ioRes.memory_kb,
          interactor_exit: ioRes.interactor_exit,
          solution_exit: ioRes.solution_exit,
          checked_by: 'special_judge',
          // checker 只能拿到选手答案，拿不到交互器全文：
          // 这里把交互器侧的完整交互过程（message_full）一并带出，供前端折叠展示
          // （判定结论仍是 checker 的 message，message_full 不参与判定）。
          message_full: ioRes.message_full || '',
        };
      }
      // checker 自身异常：把它的消息附在交互器判定后面，便于排查
      // （两侧消息都先精简，再拼成单行；超长由 composeInteractorMessage 按 300 字硬上限截断）
      const checkerMsg = String(cres.message || '').trim();
      return {
        ...ioRes,
        message: composeInteractorMessage(
          '（Special Judge 未能给出判定，已回退为交互器判定：',
          [ioRes.message, tidyInteractorMessage(checkerMsg, { clipped: checkerMsg.length > 200 })].filter(Boolean).join('；'),
          { suffix: '）' },
        ),
      };
    }
    return ioRes;
  }

  if (t === 'interactive_func') {
    // ---- 前置：只支持 C/C++（grader 与选手源码一起编译链接）----
    if (!FUNC_INTERACTIVE_LANGS.includes(String(lang.key || '').toLowerCase())) {
      return { verdict: VERDICTS.SE, time_ms: 0, memory_kb: 0, message: '函数式交互题仅支持 C/C++ 提交（当前语言：' + (lang.name || lang.key) + '）' };
    }
    const graderSrc = graderPath(problem.id);
    if (!fs.existsSync(graderSrc)) {
      return { verdict: VERDICTS.SE, time_ms: 0, memory_kb: 0, message: '题目标记为函数式交互题，但测试数据目录中缺少 grader.cpp（请在题库后台「测试数据」中编写或上传 grader）' };
    }
    const srcDir = path.dirname(graderSrc);
    let headers = [];
    try { headers = fs.readdirSync(srcDir).filter((f) => /\.h$/i.test(f)).map((f) => path.join(srcDir, f)); } catch { /* ignore */ }
    // O2：优先使用本次提交的选择（sub.enable_o2），否则回退题目设置
    const o2 = opts.o2 === undefined ? (problem.enable_o2 === undefined ? true : !!problem.enable_o2) : !!opts.o2;
    const hkey = assetKey(dir, `grader_func|${srcFile}|${o2 ? 'O2' : 'noO2'}`);
    let asset = cache ? cache.get(hkey) : null;
    // 同理：grader 链接产物被外部清理时重新编译
    if (asset && asset.ok && !fs.existsSync(asset.exeFile)) {
      console.warn('[judge] grader 缓存文件已不存在，重新编译：' + asset.exeFile);
      asset = null;
      if (cache) cache.delete(hkey);
    }
    if (!asset) {
      const r = await compileFuncInteractive(problem.id, dir, graderSrc, srcFile, {
        runShell, resolveTool, o2, headerFiles: headers,
      });
      asset = r.ok ? { ok: true, exeFile: r.exeFile } : { ok: false, log: r.log };
      if (cache) cache.set(hkey, asset);
    }
    if (!asset.ok) {
      // 编译失败属于选手代码的问题（多为语法错误 / 未实现 run）→ 判 CE，日志写入提交详情
      return {
        verdict: VERDICTS.CE, time_ms: 0, memory_kb: 0,
        message: '与 grader 一起编译失败（请确认已实现所需函数、且没有自带 main）：\n' + String(asset.log || '').slice(0, 1200),
        compile_log: String(asset.log || '').slice(0, 4000),
      };
    }
    const funcRes = await judgeInteractiveFunc({
      dir, priv: privDirOf(dir), inputFileForFunc: checkerInputFile(dir, problem, testcase, ''),
      exeFile: asset.exeFile, testcase, problem: caseProblem, o2,
      // H1：grader+选手链接产物含选手代码 → 以低权限运行
      runMeasured: (e, a, o) => runMeasured(e, a, { ...(o || {}), dropPriv: true }),
      runMeasuredNode: (e, a, o) => runMeasuredNode(e, a, { ...(o || {}), dropPriv: true }),
      // M17：输出上限来自系统设置 judge_output_limit_mb（默认 16MB）
      outputLimitBytes: outputLimitBytes(),
      runMeasured, runMeasuredNode, normalizeOutput, caseIndex,
      // 内存采样绑在「grader + 选手源码链接后的可执行文件」进程上
      sampler: memSampler,
    });
    // 函数式交互 + SPJ：链接程序跑完后，若题目有 checker，则用它的 stdout 走
    // checker <input> <程序输出文件> <答案文件>，**有 checker 时 checker 优先于 grader 退出码**。
    if (opts.spj) {
      const outFile = funcRes.outputFile || privFileOf(dir, `func_output_${testcase.id}.txt`);
      const ansFile = checkerAnswerFile(dir, problem, testcase);
      const inFile = checkerInputFile(dir, problem, testcase, funcRes.inputFile);
      const cres = await runChecker(dir, opts.spj, inFile, outFile, ansFile, testcase.subtask_score, { ensure: opts.spjEnsure });
      if (cres.verdict !== VERDICTS.SE) {
        return {
          ...cres,
          time_ms: funcRes.time_ms,
          memory_kb: funcRes.memory_kb,
          grader_exit: funcRes.grader_exit,
          checked_by: 'special_judge',
          // 同理：checker 拿不到 grader 全文，把 grader 侧的完整输出一并带出（字段名同为 message_full）
          message_full: funcRes.message_full || '',
        };
      }
      const checkerMsg = String(cres.message || '').trim();
      return {
        ...funcRes,
        message: composeInteractorMessage(
          '（Special Judge 未能给出判定，已回退为 grader 判定：',
          [funcRes.message, tidyInteractorMessage(checkerMsg, { clipped: checkerMsg.length > 200 })].filter(Boolean).join('；'),
          { suffix: '）' },
        ),
      };
    }
    return funcRes;
  }

  return { verdict: VERDICTS.SE, time_ms: 0, memory_kb: 0, message: '未知的题目类型：' + t };
}

/* ---------------- 通信题（problem_type = 'communication'） ----------------
 * 与「交互题（IO / 函数式）」并列的第三种题型：**两个选手程序合作完成一个任务**。
 *   · 程序一：接收问题的输入（`N.in`）并产生某些输出；
 *   · 程序二：输入与程序一的输出相关，产生问题的解。
 * 两种连接方式（题目侧在 testdata/<题号>/meta.json 里用 pipe_mode 选择，默认 relay）：
 *   · relay （默认）：评测端中转。先用 N.in 跑程序一 → 收下 stdout；题目若提供 grader.cpp
 *                    （可选的评测端中转程序）就用它把程序一的输出处理成程序二的输入；
 *                    再以该输入跑程序二，比较程序二的 stdout 与 N.out（或交给 checker）。
 *                    两个程序**各自**受该测试点的时限 / 内存约束。
 *   · direct        ：双向管道直连。程序一的 stdout 直接接到程序二的 stdin，两者并行运行、边跑边传
 *                    （meta.json 的 duplex=true 时再把程序二的输出回传给程序一）；direct 模式不跑 grader。
 * 判定优先级（两个程序都适用）：编译失败 → CE（注明是哪一个程序）；运行崩溃 / 非 0 退出 → RE；
 * 超时 → TLE；超内存 → MLE；程序一输出超过通信量上限 → WA（通信量超限）；答案不符 → WA；
 * spj=1 时由 checker.cpp 判定（支持部分分）。四种既有题型的评测语义完全不受影响。
 */

/** 一个选手程序的运行结果 → 判定（两个程序共用的口径顺序） */
function verdictOfProgramRun(r, { name, memoryLimitMb, memTolPct, timeLimitMs, pointTimeSet, pointMemSet }) {
  if (r.error) return { verdict: VERDICTS.SE, message: `${name}启动失败：${r.error}` };
  if (r.outputExceeded) {
    return { verdict: VERDICTS.RE, message: `${name}输出过大（超过系统输出上限，已强制结束）` };
  }
  if (isTimeLimitExceeded(r.timedOut, r.durationMs, timeLimitMs)) {
    return {
      verdict: VERDICTS.TLE,
      message: `${name}运行超时（实测 ${Math.round(r.durationMs)} ms > ${pointTimeSet ? '该测试点时限' : '时限'} ${timeLimitMs} ms）`,
    };
  }
  const memLimitKb = Math.round(memoryLimitMb * 1024 * memTolPct / 100);
  if (memoryLimitMb > 0 && (r.memoryKb || 0) > memLimitKb) {
    return {
      verdict: VERDICTS.MLE,
      message: `${name}内存超限（峰值 ${Math.round((r.memoryKb || 0) / 1024)} MB > ${pointMemSet ? '该测试点限制' : '限制'} ${memoryLimitMb} MB）`,
    };
  }
  if (r.code !== 0) return { verdict: VERDICTS.RE, message: `${name}运行时错误（退出码 ${r.code}）` };
  return null;
}

/**
 * 判一个通信题测试点。
 * @param {object} opts 由 judgeSubmission / judgeCase 透传：assets（编译缓存）、memSampler、spj、spjEnsure、o2
 */
async function judgeCommunicationCase(lang, dir, srcFile, exeFile, testcase, problem, opts = {}) {
  // graderPath：通信题可选的**评测端中转程序** grader.cpp（与函数式交互题的 grader 同路径同文件名）
  const { graderPath } = require('./db');
  const cache = opts.assets || null;
  const memSampler = opts.memSampler || null;
  const caseProblem = problemWithCaseLimits(problem, testcase);
  const timeLimitMs = effectiveTimeLimitMs(problem, testcase);
  const memoryLimitMb = effectiveMemoryLimitMb(problem, testcase);
  const pointTimeSet = caseLimitValue(testcase, 'time_limit_ms') != null;
  const pointMemSet = caseLimitValue(testcase, 'memory_limit_mb') != null;
  const memTolPct = memoryTolerancePct();
  const o2 = opts.o2 === undefined ? (problem.enable_o2 === undefined ? true : !!problem.enable_o2) : !!opts.o2;
  // 题目侧开关：连接方式（relay / direct）、程序一输出（通信量）上限、duplex
  const cfg = readCommunicationConfig(problem.id);
  const priv = privDirOf(dir);
  try { fs.mkdirSync(priv, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }

  // ---- 前置：语言与两个源码 ----
  if (!COMM_LANGS.includes(String(lang.key || '').toLowerCase())) {
    return {
      verdict: VERDICTS.SE, time_ms: 0, memory_kb: 0,
      message: '通信题需要把两个选手程序分别编译成两个可执行文件，目前仅支持 C / C++ 提交（当前语言：'
        + (lang.name || lang.key) + '）',
    };
  }
  const srcFile2 = path.join(dir, `${commSrc2Name(lang)}.${lang.ext}`);
  let code2 = '';
  try { code2 = fs.readFileSync(srcFile2, 'utf8'); } catch { code2 = ''; }
  if (!code2.trim()) {
    // 历史数据 / 异常路径：通信题必须有第二份程序（正常提交在 src/submissions.js 已拦住）
    return {
      verdict: VERDICTS.CE, time_ms: 0, memory_kb: 0,
      message: '程序二（程序二代码）为空：通信题需要两个程序合作完成任务。请在提交时填写「程序二」的代码。',
    };
  }

  // ---- 编译两个程序（同一次提交内按源码哈希缓存复用；编译失败 → CE 并注明是哪一个） ----
  const compileOne = async (which, src, exeName) => {
    const key = assetKey(dir, `comm${which}|${src}|${o2 ? 'O2' : 'noO2'}|${lang.key}`);
    let asset = cache ? cache.get(key) : null;
    if (asset && asset.ok && !fs.existsSync(asset.exeFile)) { asset = null; if (cache) cache.delete(key); }
    if (!asset) {
      const r = await compile(lang, dir, src, o2, exeName);
      asset = r.ok ? { ok: true, exeFile: r.exeFile } : { ok: false, log: r.log };
      if (cache) cache.set(key, asset);
    }
    return asset;
  };
  const a1 = await compileOne(1, srcFile, 'main.exe');
  if (!a1.ok) {
    const log = String(a1.log || '(无编译输出)').slice(0, 4000);
    return {
      verdict: VERDICTS.CE, time_ms: 0, memory_kb: 0,
      message: '程序一编译失败：\n' + log.slice(0, 1200),
      compile_log: '【程序一】编译失败：\n' + log,
      compile_stage: 'program1',
    };
  }
  const a2 = await compileOne(2, srcFile2, COMM_EXE2);
  if (!a2.ok) {
    const log = String(a2.log || '(无编译输出)').slice(0, 4000);
    return {
      verdict: VERDICTS.CE, time_ms: 0, memory_kb: 0,
      message: '程序二编译失败：\n' + log.slice(0, 1200),
      compile_log: '【程序二】编译失败：\n' + log,
      compile_stage: 'program2',
    };
  }

  const cmd1 = buildRunCommand(lang, dir, srcFile, a1.exeFile);
  const cmd2 = buildRunCommand(lang, dir, srcFile2, a2.exeFile);
  // 每个程序各自的运行闸门：点名限额 ?? 题目限额 + 进程创建基线 + 500ms 余量 + 后台配置的额外余量
  const runTimeoutMs = timeLimitMs + measureSpawnOverheadMs() + 500 + timeExtraMs();
  const inputFile = checkerInputFile(dir, problem, testcase, workFileOf(dir, `input_${testcase.id}.txt`));
  const out2File = privFileOf(dir, `comm_out_${testcase.id}.txt`);
  const err1File = workFileOf(dir, `comm1_err_${testcase.id}.txt`);
  const err2File = workFileOf(dir, `comm2_err_${testcase.id}.txt`);

  /** 以文件为核心运行一个选手程序（relay 模式的两个步骤都用它；采样器只作用于选手进程，H1 降权运行）
   *  limitBytes：本程序的输出上限。程序一取「题目通信量上限 与 系统输出上限 的较小值」，
   *  这样写出巨量输出的程序一会被看门狗**及时结束**（写得太快、跑完时看门狗还没轮询到的情形，
   *  由跑完后的文件大小复核兜底，见下面的通信量检查）；程序二用系统输出上限。 */
  const runOne = async (exe, args, stdinFile, stdoutFile, stderrFile, limitBytes) => {
    const runOpts = {
      dropPriv: true,
      cwd: workDirOf(dir),
      timeoutMs: runTimeoutMs,
      stdinFile,
      stdoutFile,
      stderrFile,
      sampler: memSampler,
      // M17：输出上限来自系统设置 judge_output_limit_mb（默认 16MB）；程序一还会被题目通信量上限约束
      outputLimitBytes: limitBytes || outputLimitBytes(),
    };
    if (process.platform === 'win32') return runMeasuredNode(exe, args, runOpts);
    return runMeasured(exe, args, runOpts);
  };

  /**
   * 抗瞬时抖动的运行：若本次结果「疑似只是机器抖动」（跑完了但用时超过时限 / 被超时闸门结束），
   * 且该程序在这次提交里还没重试过，就**再跑一次并取更快的一次**——
   * 评测机繁忙（或新编译的 exe 首次执行被杀软扫描）时进程创建本身可达数秒（实测 5.8s 的尖峰），
   * 严格按第一次的墙钟判定会把完全正确的程序误判成 TLE；而**真正超时**的程序（死循环 / 真慢）
   * 两次都会被同一道闸门杀掉，判定仍是 TLE，不会被放过。
   * 边界：每个程序每次提交最多重试一次，且只对**时限不超过 5 秒**的测试点重试——
   *   · 重试要吸收的是「几秒的固定冷启动 / 负载开销」，这对小时限（≤5s）影响巨大，对长时限题则占比很小；
   *   · 长时限题逐点重试会把整份提交推向判题总兜底超时（judge_total_timeout_ms），得不偿失。
   * 因此最坏情况的额外开销约为「一次时限闸门」，不会让提交被判题总超时收掉。
   */
  const runResilient = async (which, run) => {
    const r = await run();
    if (r.error || r.outputExceeded) return r;              // 启动失败 / 输出超限：不是抖动，不重试
    if (timeLimitMs > COMM_RETRY_MAX_TIME_LIMIT_MS) return r;
    const suspicious = r.timedOut || isTimeLimitExceeded(false, r.durationMs, timeLimitMs);
    if (!suspicious) return r;
    const st = opts.commState;
    if (!st || !st.retried) return r;                       // 没有共享状态（单点调用）：不重试
    if (st.retried[which]) return r;                        // 本次提交里该程序已经重试过
    st.retried[which] = true;
    console.warn(`[judge] 题目 #${problem.id} 通信题程序${which}第 ${testcase.id} 点用时可疑（${Math.round(r.durationMs)} ms，时限 ${timeLimitMs} ms），重跑一次以排除评测机抖动`);
    const r2 = await run();
    // 取更快的一次：抖动造成的假超时被纠正；真超时两次都会超时，判定不变
    return Number(r2.durationMs) < Number(r.durationMs) ? r2 : r;
  };

  const runErrTail = (file) => {
    let s = '';
    try { s = readTextFile(file, ''); } catch { s = ''; }
    return String(s || '').trim().slice(-400);
  };
  /** 程序二的输出（= 最终答案）**完整**读入：它已受系统输出上限约束（超过就在前面判 RE 了），
   *  因此不能用「只读 1MB」的采集函数 readCaptured，否则大答案会被截断成答案错误。 */
  const readAnswerText = (file) => {
    const size = fileSizeOf(file);
    if (size <= 0 || size > outputLimitBytes()) return '';
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  };

  /* ================= direct：双向管道直连 ================= */
  if (cfg.pipe_mode === 'direct') {
    // 直连模式下两个程序**并行**运行，评测端无法用「有没有数据流动」判断空闲（那是 IO 交互题的判法），
    // 只有墙钟可用；而 Windows 上「创建进程 + 首次执行新 exe（杀软扫描）+ 满载时的调度延迟」本身可达数秒
    // （实测 5.8s 尖峰），因此闸门在「时限 + 进程创建基线 + 500ms」之外再给一段冷启动宽限。
    // 代价（已写入文档）：direct 模式对「略超时限」的判定比 relay 宽松；relay（默认）仍严格按两个程序各自的时限判定。
    const directTimeoutMs = runTimeoutMs + COMM_DIRECT_COLD_START_GRACE_MS;
    const r = await runCommunicationDirect({
      exe1: cmd1.exe, args1: cmd1.args, exe2: cmd2.exe, args2: cmd2.args,
      cwd: workDirOf(dir),
      inputFile,
      outFile: out2File,
      errFile1: err1File,
      errFile2: err2File,
      timeoutMs1: directTimeoutMs,
      timeoutMs2: directTimeoutMs,
      duplex: cfg.duplex,
      outputLimitBytes: outputLimitBytes(),
      commLimitBytes: cfg.prog1_output_limit_bytes,
      // H1：两个程序都是选手代码 → 都按低权限启动
      spawnOpts: judgeSpawnOpts({}, true),
      sampler: memSampler,
    });
    const timeMs = r.durationMs || 0;
    const memKb = r.memoryKb || 0;
    const detail = {
      time_ms: timeMs, memory_kb: memKb, memory_sampled: !!r.memorySampled,
      pipe_mode: 'direct', duplex: !!cfg.duplex,
      program1_time_ms: r.durationMs1, program2_time_ms: r.durationMs2,
      program1_exit: r.code1, program2_exit: r.code2,
      program1_out_bytes: r.outBytes1, program2_out_bytes: r.outBytes2,
      // direct 模式下评测机只有一个内存采样通道：只采样程序二（程序一只受时限约束，见 communication.js 说明）
      memory_note: 'direct 模式：内存采样只覆盖程序二',
    };
    const wrap = (v) => ({ ...v, time_ms: timeMs, memory_kb: memKb, ...detail });
    if (r.error) return wrap({ verdict: VERDICTS.SE, message: r.error });
    if (r.commExceeded) {
      return wrap({
        verdict: VERDICTS.WA, fraction: 0,
        message: commLimitMessage(r.outBytes1, cfg.prog1_output_limit_bytes),
      });
    }
    if (r.timedOut) {
      return wrap({
        verdict: VERDICTS.TLE,
        message: `运行超时（${r.timeoutProgram} 超过 ${directTimeoutMs} ms = 时限 ${timeLimitMs} ms + 冷启动宽限 ${COMM_DIRECT_COLD_START_GRACE_MS} ms；直连模式下两个程序并行运行，已同时结束）`,
      });
    }
    if (memoryLimitMb > 0 && memKb > Math.round(memoryLimitMb * 1024 * memTolPct / 100)) {
      return wrap({
        verdict: VERDICTS.MLE,
        message: `程序二内存超限（峰值 ${Math.round(memKb / 1024)} MB > ${pointMemSet ? '该测试点限制' : '限制'} ${memoryLimitMb} MB）`,
      });
    }
    if (r.code1 !== 0) {
      const tail = runErrTail(err1File);
      return wrap({ verdict: VERDICTS.RE, message: `程序一运行时错误（退出码 ${r.code1}）` + (tail ? `\n${tail}` : '') });
    }
    if (r.code2 !== 0) {
      const tail = runErrTail(err2File);
      return wrap({ verdict: VERDICTS.RE, message: `程序二运行时错误（退出码 ${r.code2}）` + (tail ? `\n${tail}` : '') });
    }
    return finishCommunicationAnswer({
      dir, problem, testcase, caseProblem, opts,
      outFile: out2File, timeMs, memKb, detail, programLabel: '程序二',
      stdout: readAnswerText(out2File),
    });
  }

  /* ================= relay：评测端中转（默认） ================= */
  // 步骤 1：用 N.in 跑程序一
  const out1File = privFileOf(dir, `comm1_out_${testcase.id}.txt`);
  const commLimit = cfg.prog1_output_limit_bytes;
  const sysLimit = outputLimitBytes();
  const r1 = await runResilient(1, () => runOne(cmd1.exe, cmd1.args, inputFile, out1File, err1File,
    // 程序一的输出上限 = min(题目通信量上限, 系统输出上限)：超限即被及时杀掉并判「通信量超限」
    commLimit > 0 ? Math.min(sysLimit, commLimit) : sysLimit));
  const t1 = Math.round(r1.durationMs || 0);
  const m1 = r1.memoryKb || 0;
  const bytes1 = fileSizeOf(out1File);
  const baseDetail = {
    pipe_mode: 'relay',
    program1_time_ms: t1, program1_memory_kb: m1, program1_exit: r1.code,
    program1_out_bytes: bytes1,
    memory_sampled: !!r1.memorySampled,
    program1_memory_sampled: !!r1.memorySampled,
    prog1_output_limit_bytes: commLimit || 0,
  };
  const wrap1 = (v) => ({ ...v, time_ms: t1, memory_kb: m1, ...baseDetail });

  // 通信量限制：只约束**程序一**（否则它可以把 CPU 的活全甩给程序二 / 用巨量输出拖垮评测）。
  // 看门狗按该上限提前杀掉时 bytes1 可能正好等于上限，消息里取 max(bytes1, limit+1) 保证「超了多少」读起来成立。
  if (commLimit > 0 && (r1.outputExceeded || bytes1 > commLimit)) {
    return wrap1({
      verdict: VERDICTS.WA, fraction: 0,
      message: commLimitMessage(r1.outputExceeded ? Math.max(bytes1, commLimit + 1) : bytes1, commLimit),
    });
  }
  const v1 = verdictOfProgramRun(r1, {
    name: '程序一', memoryLimitMb, memTolPct, timeLimitMs, pointTimeSet, pointMemSet,
  });
  if (v1) {
    const tail = v1.verdict === VERDICTS.RE ? runErrTail(err1File) : '';
    return wrap1({ verdict: v1.verdict, fraction: 0, message: v1.message + (tail ? `\n${tail}` : '') });
  }

  // 步骤 2：可选的中转程序 grader.cpp —— 把程序一的输出「处理」成程序二的输入
  let input2File = out1File;
  let graderNote = '';
  const graderSrc = graderPath(problem.id);
  if (fs.existsSync(graderSrc)) {
    const gkey = assetKey(dir, `commgrader|${graderSrc}`);
    let gasset = cache ? cache.get(gkey) : null;
    if (gasset && gasset.ok && !fs.existsSync(gasset.exeFile)) { gasset = null; if (cache) cache.delete(gkey); }
    if (!gasset) {
      const gr = await compileRelayGrader(problem.id, dir, graderSrc, { runShell, resolveTool });
      gasset = gr.ok ? { ok: true, exeFile: gr.exeFile } : { ok: false, log: gr.log };
      if (cache) cache.set(gkey, gasset);
    }
    if (!gasset.ok) {
      // 中转程序编译失败属于**评测设施**问题（题目作者的问题），不能算到选手头上
      return wrap1({
        verdict: VERDICTS.SE,
        message: '评测端中转程序（grader.cpp）编译失败：' + String(gasset.log || '(无编译输出)').slice(0, 2000),
        compile_log: String(gasset.log || '').slice(0, 4000),
      });
    }
    const graderOut = privFileOf(dir, `comm2_in_${testcase.id}.txt`);
    const graderErr = privFileOf(dir, `commgrader_err_${testcase.id}.txt`);
    // 中转程序是受信任的评测设施：不降权、不计入选手内存；时限给宽一些（时限 × 4，至少 10s）
    const graderTimeout = Math.max(10000, timeLimitMs * 4 + measureSpawnOverheadMs() + 500);
    const gRunOpts = {
      dropPriv: false,
      cwd: dir,
      timeoutMs: graderTimeout,
      stdinFile: out1File,
      stdoutFile: graderOut,
      stderrFile: graderErr,
      sampler: null,
      outputLimitBytes: sysLimit,
    };
    const g = (process.platform === 'win32')
      ? await runMeasuredNode(gasset.exeFile, [], gRunOpts)
      : await runMeasured(gasset.exeFile, [], gRunOpts);
    const gMsg = tidyInteractorMessage([readCaptured(graderOut), readTextFile(graderErr, '')].filter(Boolean).join('\n'));
    if (g.error || g.timedOut) {
      return wrap1({
        verdict: VERDICTS.SE,
        message: `评测端中转程序（grader.cpp）${g.timedOut ? `运行超时（超过 ${graderTimeout} ms）` : `运行失败：${g.error}`}`
          + (gMsg ? `：${gMsg}` : ''),
      });
    }
    if (g.code !== 0) {
      // 中转程序的退出码非 0 = 程序一的输出未通过校验（与交互器 / grader 的 testlib 约定一致）
      return wrap1({
        verdict: VERDICTS.WA, fraction: 0,
        message: composeInteractorMessage('答案错误（程序一的输出未通过评测端中转程序校验）：', gMsg || `grader 退出码 ${g.code}`),
      });
    }
    input2File = graderOut;
    graderNote = '（已由 grader.cpp 中转处理程序一的输出）';
  }

  // 步骤 3：跑程序二，取它的 stdout 作为最终答案
  const r2 = await runResilient(2, () => runOne(cmd2.exe, cmd2.args, input2File, out2File, err2File));
  const t2 = Math.round(r2.durationMs || 0);
  const m2 = r2.memoryKb || 0;
  const detail = {
    ...baseDetail,
    program2_time_ms: t2, program2_memory_kb: m2, program2_exit: r2.code,
    program2_in_bytes: fileSizeOf(input2File),
    memory_sampled: !!r1.memorySampled || !!r2.memorySampled,
    program2_memory_sampled: !!r2.memorySampled,
    grader_used: input2File !== out1File ? 1 : 0,
  };
  const totalTime = Math.max(t1, t2);
  const totalMem = Math.max(m1, m2);
  const wrap2 = (v) => ({ ...v, time_ms: totalTime, memory_kb: totalMem, ...detail });

  if (commLimit > 0 && (r2.outputExceeded || fileSizeOf(out2File) > sysLimit)) {
    return wrap2({ verdict: VERDICTS.RE, fraction: 0, message: '程序二输出过大（超过系统输出上限，已强制结束）' });
  }
  const v2 = verdictOfProgramRun(r2, {
    name: '程序二', memoryLimitMb, memTolPct, timeLimitMs, pointTimeSet, pointMemSet,
  });
  if (v2) {
    const tail = v2.verdict === VERDICTS.RE ? runErrTail(err2File) : '';
    return wrap2({ verdict: v2.verdict, fraction: 0, message: v2.message + (tail ? `\n${tail}` : '') });
  }

  return finishCommunicationAnswer({
    dir, problem, testcase, caseProblem, opts,
    outFile: out2File, timeMs: totalTime, memKb: totalMem, detail,
    programLabel: '程序二', stdout: readAnswerText(out2File), graderNote,
  });
}

/**
 * 通信题的最终判定：比较**程序二**的 stdout 与 N.out；题目 spj=1 时交给 checker（支持部分分）。
 * 与普通题 / 函数式交互题同一套口径：`.out` 为空时只按程序二退出码判定（AC）。
 */
async function finishCommunicationAnswer(ctx) {
  const { dir, problem, testcase, opts, outFile, timeMs, memKb, detail, stdout, graderNote = '' } = ctx;
  const base = { time_ms: timeMs, memory_kb: memKb, ...detail };

  // SPJ 优先（checker 的 in = N.in，ouf = 程序二的输出文件，ans = N.out）
  if (opts.spj) {
    const inFile = checkerInputFile(dir, problem, testcase, workFileOf(dir, `input_${testcase.id}.txt`));
    const ansFile = checkerAnswerFile(dir, problem, testcase);
    const cres = await runChecker(dir, opts.spj, inFile, outFile, ansFile, testcase.subtask_score, { ensure: opts.spjEnsure });
    if (cres.verdict !== VERDICTS.SE) {
      return { ...cres, ...base, checked_by: 'special_judge' };
    }
    const checkerMsg = String(cres.message || '').trim();
    return {
      ...base,
      verdict: cres.verdict,
      message: composeInteractorMessage(
        '（Special Judge 未能给出判定，已回退为逐字节比对：',
        [checkerMsg].filter(Boolean).join('；'),
        { suffix: '）' },
      ),
    };
  }

  const expected = normalizeOutput(testcase.output);
  const actual = normalizeOutput(stdout);
  if (expected !== '') {
    if (expected === actual) {
      return { ...base, verdict: VERDICTS.AC, fraction: 1, message: '正确' + graderNote };
    }
    return {
      ...base,
      verdict: VERDICTS.WA, fraction: 0,
      message: '答案错误（程序二的输出与标准答案不一致）',
      expected: expected.slice(0, 200),
      actual: actual.slice(0, 200),
    };
  }
  // 答案留空：按退出码判定（程序二退出码在调用方已确认是 0）
  return { ...base, verdict: VERDICTS.AC, fraction: 1, message: '正确（答案文件为空，按退出码判定）' + graderNote };
}

/** 判单个测试点（opts: { spj: checker 可执行文件, answerFile: 提交答案题的用户答案文件, preRun: 批量执行已得到的结果 }） */
async function judgeCase(lang, dir, srcFile, exeFile, testcase, problem, opts = {}) {
  const pre = opts.preRun || null;
  ensurePrivDir(dir);
  const inputFile = pre ? pre.files.inputFile : workFileOf(dir, 'input.txt');
  const outputFile = pre ? pre.files.outputFile : workFileOf(dir, 'output.txt');
  const errorFile = pre ? pre.files.errorFile : workFileOf(dir, 'error.txt');
  if (!pre) fs.writeFileSync(inputFile, testcase.input ?? '');

  // 交互题 / 通信题：按题目类型分流到 src/interactive.js / src/communication.js（普通题与 SPJ 题的路径完全不受影响）
  if (needsPerCasePipeline(problem) && !lang.outputOnly) {
    return judgeInteractiveCase(lang, dir, srcFile, exeFile, testcase, problem, opts);
  }

  // v2.5.3：该测试点的实际生效限额（点级优先，未设置继承题目级）——同时约束本点的 TLE 与 MLE
  const timeLimitMs = effectiveTimeLimitMs(problem, testcase);
  const memoryLimitMb = effectiveMemoryLimitMb(problem, testcase);
  const pointTimeSet = caseLimitValue(testcase, 'time_limit_ms') != null;
  const pointMemSet = caseLimitValue(testcase, 'memory_limit_mb') != null;

  let stdout = '';
  let runInfo = { time_ms: 0, memory_kb: 0, memorySampled: false, outputExceeded: false, code: 0, error: '' };

  if (lang.outputOnly) {
    // 提交答案题：不运行程序，直接使用用户提交的答案文件
    if (opts.answerFile && fs.existsSync(opts.answerFile)) {
      try { stdout = fs.readFileSync(opts.answerFile, 'utf8'); } catch { /* ignore */ }
    }
  } else {
    const { exe, args } = buildRunCommand(lang, dir, srcFile, exeFile);
    const r = pre || await runMeasured(exe, args, {
      dropPriv: true,   // H1：选手程序以低权限运行
      cwd: workDirOf(dir),
      // M17：闸门与 isTimeLimitExceeded 用同一个额外余量（默认 0 = 行为不变）
      timeoutMs: timeLimitMs + measureSpawnOverheadMs() + 500 + timeExtraMs(),
      stdinFile: inputFile,
      stdoutFile: outputFile,
      stderrFile: errorFile,
      // M17：输出上限来自系统设置 judge_output_limit_mb（默认 16MB）
      outputLimitBytes: outputLimitBytes(),
    });
    runInfo = {
      time_ms: Math.round(r.durationMs), memory_kb: r.memoryKb || 0,
      memorySampled: !!r.memorySampled, code: r.code, error: r.error, timedOut: r.timedOut,
      outputExceeded: !!r.outputExceeded,
    };
    // M4：只读入上限内的字节用于比对（超限的输出不再整份读进内存）
    const outLimit = outputLimitBytes();
    const outSize = (() => { try { return fs.statSync(outputFile).size; } catch { return 0; } })();
    if (outSize <= outLimit) {
      try { stdout = fs.readFileSync(outputFile, 'utf8'); } catch { /* ignore */ }
    }
    let stderr = '';
    try { stderr = readFileHead(errorFile, 4096); } catch { /* ignore */ }

    if (r.error) {
      return { verdict: VERDICTS.SE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, memory_sampled: runInfo.memorySampled, message: r.error };
    }
    // M4：输出超限（流式看门狗命中，或跑完后仍超过上限）→ RE「输出过大」，及时结束、不落盘巨量输出
    if (r.outputExceeded || outSize > outLimit) {
      return {
        verdict: VERDICTS.RE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, memory_sampled: runInfo.memorySampled,
        message: `输出过大（超过 ${Math.round(outLimit / 1024 / 1024)} MB 上限，已强制结束）`,
      };
    }
    // L6：先看实测用时（扣除进程创建基线），再看是否被超时看门狗杀掉
    // v2.5.3：时限取该测试点的实际生效值（点级 ?? 题目级），提示里给出实际生效的限额
    if (isTimeLimitExceeded(r.timedOut, r.durationMs, timeLimitMs)) {
      return {
        verdict: VERDICTS.TLE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, memory_sampled: runInfo.memorySampled,
        message: pointTimeSet
          ? `运行超时（实测 ${Math.round(r.durationMs)} ms > 该测试点时限 ${timeLimitMs} ms）`
          : `运行超时（实测 ${Math.round(r.durationMs)} ms > 时限 ${timeLimitMs} ms）`,
      };
    }
    // 内存限制（v2.5.3：同上，点级优先；memoryLimitMb=0 表示不判内存）
    // M17：判定阈值 × judge_memory_tolerance_pct/100（默认 100 = 严格按题面限制，行为与历史一致）。
    // 该系数只调整「判 MLE 的门槛」，不改变量测口径（memory_kb 始终是采样到的真实峰值）。
    const memTolPct = memoryTolerancePct();
    const memLimitKb = Math.round(memoryLimitMb * 1024 * memTolPct / 100);
    if (memoryLimitMb > 0 && runInfo.memory_kb > memLimitKb) {
      return {
        verdict: VERDICTS.MLE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, memory_sampled: runInfo.memorySampled,
        message: pointMemSet
          ? `内存超限（峰值 ${Math.round(runInfo.memory_kb / 1024)} MB > 该测试点限制 ${memoryLimitMb} MB${memTolPct === 100 ? '' : `（含 ${memTolPct}% 余量）`}）`
          : `内存超限（${runInfo.memory_kb} KB > ${memLimitKb} KB）`,
      };
    }
    if (r.code !== 0) {
      return {
        verdict: VERDICTS.RE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, memory_sampled: runInfo.memorySampled,
        message: `运行时错误（退出码 ${r.code}）` + (stderr ? `\n${stderr.slice(0, 500)}` : ''),
      };
    }
  }

  // 判定：Special Judge 优先
  if (opts.spj) {
    // checker 的 in/ans 直接用**只读的题目数据目录**里的测试数据（零拷贝，选手改不了），
    // 只有 ou（选手输出）是选手产生、位于私有目录；checker 的日志也走私有目录（见 runChecker）。
    const ansFile = checkerAnswerFile(dir, problem, testcase);
    const inFile = checkerInputFile(dir, problem, testcase, inputFile);
    // 提交答案题的输出来自用户答案文件，需要落到 output 文件交给 checker（普通题的程序输出本就直接写在那里）
    if (lang.outputOnly) fs.writeFileSync(outputFile, stdout);
    const cres = await runChecker(dir, opts.spj, inFile, outputFile, ansFile, testcase.subtask_score, { ensure: opts.spjEnsure });
    return { ...cres, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, memory_sampled: runInfo.memorySampled };
  }

  const expected = normalizeOutput(testcase.output);
  const actual = normalizeOutput(stdout);
  if (expected === actual) {
    return { verdict: VERDICTS.AC, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, memory_sampled: runInfo.memorySampled, message: '正确', fraction: 1 };
  }
  return {
    verdict: VERDICTS.WA,
    time_ms: runInfo.time_ms,
    memory_kb: runInfo.memory_kb,
    memory_sampled: runInfo.memorySampled,
    message: '答案错误',
    fraction: 0,
    expected: expected.slice(0, 200),
    actual: actual.slice(0, 200),
  };
}

// ---------------- 主判题流程 ----------------

const verdictPriority = {
  [VERDICTS.SE]: 7,
  [VERDICTS.CE]: 6,
  [VERDICTS.TLE]: 5,
  [VERDICTS.MLE]: 4,
  [VERDICTS.RE]: 3,
  [VERDICTS.WA]: 2,
  [VERDICTS.AC]: 1,
};

/** 从提交内容中提取答案文件（提交答案题）：base64 → 若是 ZIP 则按测试点编号提取，否则视为单个答案 */
function extractAnswers(codeBase64, dir, testcaseCount) {
  let buf;
  try { buf = Buffer.from(codeBase64 || '', 'base64'); } catch { return { error: '答案文件解码失败' }; }
  if (buf.length === 0) return { error: '答案文件为空' };
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // PK
  if (isZip) {
    try {
      const { parseZip } = require('./zip');
      const entries = parseZip(buf);
      const outMap = {};
      for (const e of entries) {
        if (e.name.endsWith('/')) continue;
        const base = e.name.replace(/\\/g, '/').split('/').pop().toLowerCase();
        const m = base.match(/^(?:.*?)(\d+)\.(out|ans|txt)$/);
        if (!m) continue;
        outMap[parseInt(m[1], 10)] = e.data;
      }
      let found = 0;
      for (let i = 1; i <= testcaseCount; i++) {
        if (outMap[i]) {
          fs.writeFileSync(path.join(dir, `ans_${i}.txt`), outMap[i]);
          found++;
        } else {
          fs.writeFileSync(path.join(dir, `ans_${i}.txt`), '');
        }
      }
      return { zip: true, found };
    } catch (e) {
      const msg = String((e && e.message) || e);
      // H6（zip.js 抛 ZIP_TOO_LARGE）：答案包过大属于**提交格式问题**，不是评测设施故障，
      // 映射成 CE（格式错误）并把原因写进 compile_error，不要甩成 System Error。
      if (/ZIP_TOO_LARGE/i.test(msg)) return { rejected: true, error: '答案 ZIP 过大，已被拒绝：' + msg };
      if (/ZIP_/i.test(msg)) return { rejected: true, error: '答案 ZIP 格式不受支持：' + msg };
      return { error: '答案 ZIP 解析失败：' + msg };
    }
  }
  // 单个答案文件：写入第 1 个测试点的答案（多测试点时其余为空）
  for (let i = 1; i <= testcaseCount; i++) {
    fs.writeFileSync(path.join(dir, `ans_${i}.txt`), i === 1 ? buf : Buffer.from(''));
  }
  return { zip: false };
}

async function judgeSubmission(submissionId) {
  const __T0 = process.hrtime.bigint();
  // 阶段耗时（SPJ 诊断用，评测结束时汇总成一行日志）
  // · compile 必须预置初值：函数式交互题（通信题）与提交答案题**不在这里编译选手代码**
  //   （通信题与 grader 一起编译，见 judgeInteractiveCase），此前 phases.compile 为 undefined，
  //   会让下面「SPJ 评测耗时」汇总行在读 .toFixed() 时抛异常，导致「通信题 + SPJ」的提交
  //   在已经写出正确逐点判定与分数之后被 _run 的兜底 catch 改成 System Error。
  const phases = { checker: 0, checkerCached: null, compile: 0, run: 0 };
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) return;
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(sub.problem_id);
  if (!problem) {
    db.prepare("UPDATE submissions SET status = ?, verdict = ?, judge_detail = ? WHERE id = ?")
      .run('Done', VERDICTS.SE, JSON.stringify([{ verdict: VERDICTS.SE, message: '题目不存在' }]), submissionId);
    return;
  }
  const lang = LANGUAGES[sub.language];
  if (!lang) {
    db.prepare("UPDATE submissions SET status = ?, verdict = ? WHERE id = ?")
      .run('Done', VERDICTS.SE, submissionId);
    return;
  }

  // M8：提交一进入判题就在**后台**预热内存采样器（PowerShell 冷启动 10~15s，而准备目录 + 编译
  // 通常要 2~5s，正好被这段时间盖掉）。这样绝大多数提交在第一个测试点运行之前池就已就绪，
  // 不再出现「大量提交 memory_kb = —」。预热纯后台、unref，不阻塞也不影响判定。
  prewarmSamplers();

  const dir = path.join(JUDGE_DIR, String(submissionId));
  // H2/L7：评测目录必须是 data/judge 下的真实目录（拒绝符号链接/junction），并准备 0700 的私有子目录。
  // Windows 上 rmSync 偶发 EPERM（文件被占用/杀软扫描）：退避重试，仍失败则把旧目录改名让路，
  // 绝不让一次目录清理失败把提交判成系统错误。
  try {
    ensureNoReparse(dir);
    let cleaned = false;
    for (let i = 0; i < 3 && !cleaned; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); cleaned = true; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    if (!cleaned) {
      try { fs.renameSync(dir, dir + '.stale-' + Date.now()); cleaned = true; } catch { /* ignore */ }
    }
    fs.mkdirSync(dir, { recursive: true });
    ensurePrivDir(dir);
  } catch (e) {
    db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ?, judge_detail = ? WHERE id = ?")
      .run('Done', VERDICTS.SE, '评测目录准备失败：' + (e && e.message ? e.message : e), JSON.stringify([]), submissionId);
    bumpProblemStats(problem.id, false);
    return;
  }

  // Special Judge：编译 checker.cpp（测试数据目录）
  let checkerExe = null;
  const isSpj = !!problem.spj;
  // checker 可执行文件的「重新确认」入口：进程启动失败（缓存文件被清理 / 被杀软拦下）时由
  // runChecker 调用一次。缓存键是源码内容哈希，因此重新编译得到的路径与原来一致。
  let spjEnsure = null;
  if (isSpj) {
    const { checkerPath: cp } = require('./db');
    const checkerSrc = cp(problem.id);
    if (fs.existsSync(checkerSrc)) {
      spjEnsure = () => compileChecker(problem.id, dir, checkerSrc)
        .then((r2) => (r2 && r2.ok ? r2.exeFile : null))
        .catch(() => null);
      const __c0 = process.hrtime.bigint();
      const cres = await compileChecker(problem.id, dir, checkerSrc);
      phases.checker = Number(process.hrtime.bigint() - __c0) / 1e6;
      phases.checkerCached = !!cres.cached;
      if (!cres.ok) {
        db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ?, judge_detail = ? WHERE id = ?")
          .run('Done', VERDICTS.SE, 'Special Judge 编译失败：' + cres.log.slice(0, 2000), JSON.stringify([]), submissionId);
        bumpProblemStats(problem.id, false);
        return;
      }
      checkerExe = cres.exeFile;
    } else {
      db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ?, judge_detail = ? WHERE id = ?")
        .run('Done', VERDICTS.SE, '题目标记为 Special Judge 但测试数据中缺少 checker.cpp', JSON.stringify([]), submissionId);
      bumpProblemStats(problem.id, false);
      return;
    }
  }

  // 提交答案题：提取答案文件（放进私有目录，选手进程不参与这类评测）
  let answerFiles = {};
  if (lang.outputOnly) {
    const testcases0 = readTestcases(problem.id);
    const ext = extractAnswers(sub.code, ensurePrivDir(dir), Math.max(1, testcases0.length));
    if (ext.error) {
      // 提交格式问题（如 ZIP 超限）判 CE 并给出可读原因；其余（设施异常）仍是 SE
      const v = ext.rejected ? VERDICTS.CE : VERDICTS.SE;
      db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ?, judge_detail = ? WHERE id = ?")
        .run('Done', v, ext.error, JSON.stringify([]), submissionId);
      bumpProblemStats(problem.id, false);
      return;
    }
    for (let i = 1; i <= Math.max(1, testcases0.length); i++) answerFiles[i] = privFileOf(dir, `ans_${i}.txt`);
  }

  // 源文件名：Java 等语言要求公共类名与文件名一致（srcName 大写 Main.java），其余默认 main.ext
  const srcName = lang.srcName || 'main';
  const srcFile = path.join(dir, `${srcName}.${lang.ext}`);
  if (!lang.outputOnly) fs.writeFileSync(srcFile, sub.code);
  // 通信题：第二份选手程序（程序二）写到 main2.<ext>，评测时与程序一**分别**编译成 main.exe / main2.exe。
  // 非通信题不写第二个文件（sub.code2 恒为空串），磁盘上不会多出无关文件。
  const isCommProblem = String(problem.problem_type || '') === 'communication';
  if (isCommProblem && !lang.outputOnly) {
    fs.writeFileSync(path.join(dir, `${srcName}2.${lang.ext}`), String(sub.code2 || ''));
  }

  // Go：module 模式需要 go.mod；共享 GOCACHE 目录（见 compile 内注释）
  if (lang.key === 'go' && !lang.outputOnly) {
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module lczoj\n\ngo 1.21\n');
      fs.mkdirSync(path.join(DATA_DIR, 'gocache'), { recursive: true });
      fs.mkdirSync(path.join(DATA_DIR, 'gopath'), { recursive: true });
    } catch { /* ignore */ }
  }

  // 编译
  // 函数式交互题**不在这里单独编译**：它必须和题目的 grader.cpp 一起编译链接
  // （否则选手代码 #include "problem.h" 会因为缺少 -I 数据目录而报「找不到头文件」）。
  // 真正的编译在 judgeInteractiveCase() 里逐测试点完成，结果按源码哈希缓存复用。
  // 通信题同理**不在这里编译**：它有两份程序，两个可执行文件的编译都在 judgeCommunicationCase()
  // 里完成（分别产出 main.exe / main2.exe，并注明是哪一个程序编译失败），此处只落源码。
  const funcInteractive = String(problem.problem_type || '') === 'interactive_func' && !lang.outputOnly;
  const commInteractive = isCommProblem && !lang.outputOnly;
  let exeFile = srcFile;
  if (lang.compiled && !lang.outputOnly && !funcInteractive && !commInteractive) {
    // O2：优先使用本次提交的选择（sub.enable_o2），否则回退题目设置
    const o2 = sub.enable_o2 == null ? (problem.enable_o2 !== 0 && problem.enable_o2 !== false) : (sub.enable_o2 !== 0);
    const __k0 = process.hrtime.bigint();
    const cres = await compile(lang, dir, srcFile, o2);
    phases.compile = Number(process.hrtime.bigint() - __k0) / 1e6;
    if (!cres.ok) {
      db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ?, judge_detail = ? WHERE id = ?")
        .run('Done', VERDICTS.CE, cres.log.slice(0, 4000), JSON.stringify([]), submissionId);
      bumpProblemStats(problem.id, false);
      return;
    }
    exeFile = cres.exeFile;
  }

  // 逐测试点
  const testcases = readTestcases(problem.id);
  if (testcases.length === 0) {
    db.prepare("UPDATE submissions SET status = ?, verdict = ?, judge_detail = ? WHERE id = ?")
      .run('Done', VERDICTS.SE, JSON.stringify([{ verdict: VERDICTS.SE, message: '该题暂无测试数据' }]), submissionId);
    bumpProblemStats(problem.id, false);
    return;
  }

  const details = [];
  let worst = VERDICTS.AC;
  let maxTime = 0;
  let maxMem = 0;

  // 交互题 / 通信题：交互器 / grader / 两个选手程序在逐点判题时编译一次并缓存复用；内存采样器共用（Windows）
  const interactive = needsPerCasePipeline(problem) && !lang.outputOnly;
  if (interactive && String(problem.problem_type) === 'interactive_func'
      && !FUNC_INTERACTIVE_LANGS.includes(String(lang.key || '').toLowerCase())) {
    // 非 C/C++ 的函数式交互题：直接给出清晰提示，不必逐点重试（否则每个测试点都会重复编译失败）
    failSubmission(submissionId, problem.id, VERDICTS.SE,
      '函数式交互题仅支持 C/C++ 提交（当前语言：' + (lang.name || lang.key) + '）。函数式交互题需要把 grader 与你的代码一起编译链接。');
    return;
  }
  if (interactive && String(problem.problem_type) === 'communication'
      && !COMM_LANGS.includes(String(lang.key || '').toLowerCase())) {
    // 非 C/C++ 的通信题：同样直接给出清晰提示（两个程序要分别编译成两个可执行文件）
    failSubmission(submissionId, problem.id, VERDICTS.CE,
      '通信题需要把两个选手程序分别编译成两个可执行文件，目前仅支持 C / C++ 提交（当前语言：'
      + (lang.name || lang.key) + '）。');
    return;
  }
  let interactiveAssets = null;
  let interactiveSampler = null;
  // 通信题：抗瞬时抖动的重跑预算（每个程序 / direct 组合每次提交最多重跑一次），与编译缓存一起在逐点判题间共享
  const interactiveCommState = { retried: { 1: false, 2: false, direct: false } };
  // O2 设置（提交优先，其次题目）：函数式交互题编译 grader+选手时使用
  const interactiveO2 = sub.enable_o2 == null
    ? (problem.enable_o2 !== 0 && problem.enable_o2 !== false)
    : (sub.enable_o2 !== 0);
  if (interactive) {
    // 交互器 / grader 的编译结果在同一次提交内复用
    interactiveAssets = new Map();
    // 交互题**同样判内存**：复用与普通题一致的 MemSampler（一次评测一个常驻 PowerShell 进程，
    // 按 pid 采样工作集峰值，通过两个小文件与 Node 通信）。
    //   · IO 交互题：采样对象是选手进程（交互器是题目自带的评测设施，不计入内存限制）；
    //   · 函数式交互题：采样对象是 grader + 选手源码**链接后的那个可执行文件**。
    // 采样器不可用时（非 Windows / PowerShell 不可用）：Windows 上退到不依赖 PowerShell 的兜底通道，
    // 仍然拿不到才是 memory_kb 记 0（不判 MLE，不影响判定）。
    // 采样器同样从常驻池借出（交互题的每个测试点都要采样，池化后同样省掉每提交一次冷启动）
    const sampler = await acquireSampler();
    if (sampler) {
      interactiveSampler = sampler;
    } else {
      interactiveSampler = await acquireFallbackSampler(SAMPLER_CASE_ACQUIRE_MS);
      if (!interactiveSampler) {
        console.warn('[judge] 交互题内存采样器不可用（memory_kb 将记 0，不判 MLE）');
      }
    }
  }

  // Windows：先把全部测试点的「运行」阶段批量执行，再逐点做输出比对。
  // 优先走「Node 直跑 + 单进程内存采样」（每点约百毫秒）；不可用时回退到 PowerShell 包装器批量执行。
  // 交互题必须逐点与交互器/grader 对接，不能走这套批量执行（见上面的 interactive 分支）。
  let preRuns = null;
  const __r0 = process.hrtime.bigint();
  if (process.platform === 'win32' && !lang.outputOnly && !interactive) {
    const jobs = [];
    try {
      for (const tc of testcases) jobs.push(prepareCaseJob(lang, dir, srcFile, exeFile, tc, problem));
    } catch (e) {
      console.warn('[judge] 准备运行任务失败：' + (e && e.message ? e.message : e));
    }
    if (jobs.length && process.env.OJ_JUDGE_RUNNER !== 'ps') {
      // 1) 首选「Node 直跑 + 内存采样」（每点约百毫秒）。
      //    采样器从常驻池借出复用：省掉「每次提交都新建 PowerShell 采样器」的冷启动 + 协议自检开销
      //    （实测该开销约 4.4s，而整个 SPJ 提交才 8.3s）。池不可用时返回 null → 内存记 0，不误判 MLE。
      const __s0 = process.hrtime.bigint();
      const sampler = await acquireSampler();
      const samplerOk = !!sampler;
      if (process.env.OJ_JUDGE_TRACE === '1') console.log(`[TIMING] acquireSampler ${(Number(process.hrtime.bigint() - __s0) / 1e6).toFixed(0)}ms ok=${samplerOk}`);
      if (samplerOk) {
        try {
          const __b0 = process.hrtime.bigint();
          const results = await runBatchNode(jobs.map((j) => j.job), sampler);
          if (process.env.OJ_JUDGE_TRACE === '1') console.log(`[TIMING] runBatchNode(采样) ${(Number(process.hrtime.bigint() - __b0) / 1e6).toFixed(0)}ms ${jobs.length} 点`);
          preRuns = jobs.map((j, i) => Object.assign({}, results[i], { files: j.files }));
        } catch (e) {
          preRuns = null;
          console.warn('[judge] Node 直跑失败：' + (e && e.message ? e.message : e));
        } finally {
          const __s1 = process.hrtime.bigint();
          releaseSampler(sampler);
          if (process.env.OJ_JUDGE_TRACE === '1') console.log(`[TIMING] releaseSampler ${(Number(process.hrtime.bigint() - __s1) / 1e6).toFixed(0)}ms`);
        }
      }
      // 2) 采样器不可用（或直跑异常）：仍然用 Node 直跑完成评测，只是内存记 0。
      //    **不要**在这种情况下改用 PowerShell 包装器：包装器冷启动在机器负载高时会超过
      //    30 秒兜底而被判成「判题包装器未返回结果」的系统错误（实测 #186/#188 就是这么挂的）。
      if (!preRuns) {
        try {
          const results = await runBatchNode(jobs.map((j) => j.job), null);
          preRuns = jobs.map((j, i) => Object.assign({}, results[i], { files: j.files }));
        } catch (e) {
          preRuns = null;
          console.warn('[judge] Node 直跑（无内存采样）失败，回退 PowerShell 包装器：' + (e && e.message ? e.message : e));
        }
      }
    }
    // 3) 最后兜底：PowerShell 包装器批量执行（仅在 Node 直跑完全不可用时才走到这里）
    if (!preRuns && jobs.length) {
      try {
        const results = await runMeasuredBatch(jobs.map((j) => j.job));
        preRuns = jobs.map((j, i) => Object.assign({}, results[i], { files: j.files }));
      } catch (e) {
        preRuns = null; // 批量执行异常时回退到逐点执行，保证判题可用
        console.warn('[judge] 批量执行失败，回退逐测试点执行：' + (e && e.message ? e.message : e));
      }
    }
    // 4) 个别测试点没拿到结果（包装器异常）时，用 Node 直跑补齐，避免整题判成系统错误
    if (preRuns) {
      for (let i = 0; i < preRuns.length; i++) {
        const r = preRuns[i];
        if (r && r.code === -1 && r.error) {
          try {
            const one = await runBatchNode([jobs[i].job], null);
            preRuns[i] = Object.assign({}, one[0], { files: jobs[i].files });
          } catch { /* 保留原结果 */ }
        }
      }
    }
  }

  phases.run = Number(process.hrtime.bigint() - __r0) / 1e6;

  for (let idx = 0; idx < testcases.length; idx++) {
    const tc = testcases[idx];
    // 交互题逐点判：**每个测试点开始前再试一次**借采样器（预热通常已在首个测试点的
    // 交互器/grader 编译期间完成）；先试常驻池，池不可用就用不依赖 PowerShell 的兜底通道。
    if (interactive && (!interactiveSampler || isFallbackSampler(interactiveSampler))) {
      const better = await acquireSamplerForCase(idx < 3 ? SAMPLER_CASE_ACQUIRE_MS : 0);
      if (better && better !== interactiveSampler) {
        if (interactiveSampler) releaseSampler(interactiveSampler);
        interactiveSampler = better;
      }
    }
    const opts = { spj: checkerExe, spjEnsure, caseIndex: idx, assets: interactiveAssets, memSampler: interactiveSampler, o2: interactiveO2, commState: interactiveCommState };
    if (lang.outputOnly) opts.answerFile = answerFiles[tc.id];
    if (preRuns && preRuns[idx]) opts.preRun = preRuns[idx];
    const res = await judgeCase(lang, dir, srcFile, exeFile, tc, problem, opts);
    details.push({ id: tc.id, subtask: tc.subtask, subtask_score: tc.subtask_score, ...res });
    // 增量写入：每判完一个测试点就落库，前端可实时看到测试点逐个点亮（评测中剩余显示转圈）
    try {
      db.prepare('UPDATE submissions SET judge_detail = ? WHERE id = ?').run(JSON.stringify(details), submissionId);
    } catch { /* ignore */ }
    // 交互题 / grader 的编译日志（如「与 grader 一起编译失败」）单独写到 compile_error，便于前端展示
    if (res.compile_log) {
      try {
        db.prepare('UPDATE submissions SET compile_error = ? WHERE id = ?').run(String(res.compile_log).slice(0, 4000), submissionId);
      } catch { /* ignore */ }
    }
    if (res.time_ms > maxTime) maxTime = res.time_ms;
    if (res.memory_kb > maxMem) maxMem = res.memory_kb;
    if ((verdictPriority[res.verdict] || 0) > (verdictPriority[worst] || 0)) {
      worst = res.verdict;
    }
    // 系统错误立即终止，避免浪费；交互题 / grader 的编译错误同理（后续测试点必然同样失败）
    if (res.verdict === VERDICTS.SE || (interactive && res.verdict === VERDICTS.CE)) break;
  }

  if (interactive && interactiveSampler) {
    releaseSampler(interactiveSampler);
  }

  // 计分：按每个子任务的计分方式计算（sum=加和 / min=最小值 / max=最大值 / bundle=捆绑）
  // 每个测试点的部分分比例 fraction ∈ [0,1]（普通评测 AC=1/WA=0，SPJ 可输出 0~1 部分分）。
  const subtaskTypes = readSubtaskTypes(problem.id); // 与 subtask_scores 同序（子任务编号 0-based）
  const subtaskStatus = new Map(); // subtask(0-based) -> { total, fracs:[], score, type }
  for (const d of details) {
    if (!subtaskStatus.has(d.subtask)) {
      subtaskStatus.set(d.subtask, {
        total: 0, fracs: [], score: d.subtask_score || 0,
        type: subtaskTypes[d.subtask] || 'bundle',
      });
    }
    const st = subtaskStatus.get(d.subtask);
    st.total++;
    st.fracs.push(d.fraction == null ? (d.verdict === VERDICTS.AC ? 1 : 0) : d.fraction);
  }
  let score = 0;
  for (const [sid, st] of subtaskStatus) {
    const n = st.fracs.length;
    let earned = 0;
    if (n > 0) {
      if (st.type === 'sum') {
        // 加和：每个测试点均分子任务满分，按部分分比例累加
        earned = st.fracs.reduce((a, b) => a + b, 0) * st.score / n;
      } else if (st.type === 'min') {
        // 最小值：子任务得分 = 满分 × 各测试点部分分的最小值
        earned = st.score * Math.min(...st.fracs);
      } else if (st.type === 'max') {
        // 最大值：子任务得分 = 满分 × 各测试点部分分的最大值
        earned = st.score * Math.max(...st.fracs);
      } else {
        // bundle（捆绑）：全部测试点满分才得整组分数，否则 0
        earned = st.fracs.every((f) => f >= 1) ? st.score : 0;
      }
    }
    earned = Math.round(earned);
    st.earned = earned;
    st.fully_passed = earned >= st.score && st.score > 0;
    score += earned;
    for (const d of details) if (d.subtask === sid) { d.subtask_passed = st.fully_passed; d.subtask_earned = st.earned; }
  }
  score = Math.max(0, Math.min(100, score));

  const isAC = worst === VERDICTS.AC && score === 100;
  if (isAC) {
    score = 0;
    for (const [, st] of subtaskStatus) score += st.score;
  }

  db.prepare(`
    UPDATE submissions
    SET status = ?, verdict = ?, score = ?, time_ms = ?, memory_kb = ?, judge_detail = ?
    WHERE id = ?
  `).run('Done', worst, score, maxTime, maxMem, encodeDetail(JSON.stringify(details)), submissionId);

  bumpProblemStats(problem.id, isAC);

  // SPJ 提交结束时输出一行汇总（缓存是否命中 / checker 与判定耗时），便于管理员核对与排查
  if (isSpj) {
    const st = spjStats.get(dir) || { ms: 0, runs: 0, max: 0 };
    spjStats.delete(dir);
    const total = Number(process.hrtime.bigint() - __T0) / 1e6;
    console.log('[OJ] SPJ 评测耗时（提交 #' + submissionId + '，题目 #' + problem.id + '）：'
      + '总 ' + total.toFixed(0) + 'ms = checker ' + phases.checker.toFixed(0) + 'ms'
      + (phases.checkerCached ? '（缓存命中）' : '（重新编译）')
      + ' + 选手编译 ' + phases.compile.toFixed(0) + 'ms'
      + ' + 运行/采样 ' + phases.run.toFixed(0) + 'ms'
      + ' + 判定 ' + st.ms.toFixed(0) + 'ms/' + st.runs + ' 点（单点最大 '
      + st.max.toFixed(0) + 'ms）');
  }
}

/** 重算题目的提交数 / 通过数：直接由 submissions 表推导。
 *  这样「重判」不会把计数重复累加（原实现是 +1 递增，重判一次就会多算一次）。 */
function bumpProblemStats(problemId) {
  if (!problemId) return;
  const total = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE problem_id = ?').get(problemId).c;
  const ac = db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE problem_id = ? AND verdict = 'Accepted'").get(problemId).c;
  db.prepare('UPDATE problems SET submit_count = ?, accepted_count = ? WHERE id = ?').run(total, ac, problemId);
}

// ---------------- 判题队列 ----------------

class JudgeQueue {
  constructor(concurrency = DEFAULTS.maxConcurrentJudges) {
    this.concurrency = concurrency;
    this.pending = [];
    this.running = 0;
  }

  /** 运行时调整并行判题数（系统设置里改完立即生效，并立刻尝试派发排队中的提交） */
  setConcurrency(n) {
    const v = Math.max(1, Math.min(16, parseInt(n, 10) || 1));
    this.concurrency = v;
    this._drain();
    return v;
  }

  /** 队列状态（系统设置 / 评测进度展示用） */
  stats() {
    return { concurrency: this.concurrency, running: this.running, pending: this.pending.length };
  }

  submit(id) {
    this.pending.push(id);
    this._drain();
  }

  _drain() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      this.running++;
      this._run(id).finally(() => {
        this.running--;
        this._drain();
      });
    }
  }

  async _run(id) {
    db.prepare("UPDATE submissions SET status = ?, verdict = ? WHERE id = ? AND status != 'Done'")
      .run('Judging', 'Judging', id);
    // S2：判题总兜底超时（默认 DEFAULTS.judgeTimeoutMs = 30s，后台可用 judge_total_timeout_ms 调整）。
    // 原先的兜底只覆盖单个测试点/包装器，一旦评测设施卡死，提交会永远停在 Judging。
    // 预算 = 总兜底 + 每测试点(时限 + 5s)。
    const totalFallbackMs = judgeTotalTimeoutMs();
    let budgetMs = totalFallbackMs;
    try {
      const sub = db.prepare('SELECT problem_id FROM submissions WHERE id = ?').get(id);
      const prob = sub ? db.prepare('SELECT time_limit_ms FROM problems WHERE id = ?').get(sub.problem_id) : null;
      const cases = sub ? readTestcases(sub.problem_id) : [];
      const n = sub ? Math.max(1, cases.length) : 1;
      // v2.5.3：点级时限可能大于题目级，预算按**各测试点实际生效时限的最大值**估算，
      // 否则点级大时限的提交会被兜底超时误杀。
      // judge_time_factor：各点时限已含系数，基准值同样按「题目时限 × 系数」取，避免单点放宽后总预算先到。
      const baseTl = effectiveTimeLimitMs(prob, null);
      const tl = cases.reduce((m, c) => Math.max(m, effectiveTimeLimitMs(prob, c)), baseTl);
      budgetMs = totalFallbackMs + n * (tl + 5000);
    } catch { /* 查询失败则用默认预算 */ }
    let timer = null;
    try {
      await Promise.race([
        judgeSubmission(id),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`判题总超时（超过 ${Math.round(budgetMs / 1000)} 秒，已强制收尾）`)), budgetMs);
          if (timer.unref) timer.unref();
        }),
      ]);
    } catch (e) {
      db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ? WHERE id = ?")
        .run('Done', VERDICTS.SE, String(e && e.message ? e.message : e).slice(0, 2000), id);
    } finally {
      if (timer) clearTimeout(timer);
      // 评测结束立即删除该提交的临时工作目录（源码/编译中间产物/输入输出）。
      // SPJ checker 的编译产物**不删除**：它按源码哈希缓存在 data/spj_cache，供后续提交直接复用。
      const workDir = path.join(JUDGE_DIR, String(id));
      try { releaseSubmissionCheckers(workDir); } catch { /* ignore */ }
      // 交互题的交互器 / grader 编译产物同样按源码哈希缓存，不删除，仅解除占用
      try { releaseInteractiveAssets(workDir); } catch { /* ignore */ }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      // Go 构建缓存也会随提交增长：及时回收一天前的产物并限制总量
      try { pruneGoCache(100, 1); } catch { /* ignore */ }
    }
  }

  get length() {
    return this.pending.length;
  }
}

/** 判题目录里可能残留的临时文件名（被打断的批量任务可能留下） */
const JUDGE_TEMP_PATTERN = /^(_batch|_mem_req|_mem_res|_job\.json|_result\.json|_time\.log)/;

/** 兜底清理遗留的判题工作目录与临时文件（正常情况下每次评测结束已即时删除；此函数处理进程崩溃残留）。
 *  olderThanMs=0 表示全删（仅启动时调用，此时无评测在跑）。
 *  只清理 data/judge 下的评测产物：题库测试数据（data/testdata）、附件、头像与数据库一律不动。
 *  返回 { removed, freedBytes }。 */
function cleanJudgeWorkDirs(olderThanMs = 30 * 60 * 1000) {
  let removed = 0;
  let freed = 0;
  const dirSize = (p) => {
    let sum = 0;
    try {
      for (const f of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, f.name);
        if (f.isDirectory()) sum += dirSize(q);
        else { try { sum += fs.statSync(q).size; } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    return sum;
  };
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(JUDGE_DIR)) {
      const d = path.join(JUDGE_DIR, name);
      try {
        const st = fs.statSync(d);
        const stale = now - st.mtimeMs > olderThanMs;
        if (!stale) continue;
        if (st.isDirectory()) {
          freed += dirSize(d);
          fs.rmSync(d, { recursive: true, force: true });
          removed++;
        } else if (JUDGE_TEMP_PATTERN.test(name)) {
          freed += st.size;
          fs.rmSync(d, { force: true });
          removed++;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { removed, freedBytes: freed };
}

/** 清理 Go 构建缓存（DATA_DIR/gocache，会随 Go 提交不断增大）：
 *  先删除超过 maxAgeDays 的旧文件；若总大小仍超过 maxMb，则按修改时间从旧到新删除，直到低于上限。
 *  返回 { removed, freedBytes, sizeBytes }。 */
function pruneGoCache(maxMb = 300, maxAgeDays = 7) {
  const dir = path.join(DATA_DIR, 'gocache');
  if (!fs.existsSync(dir)) return { removed: 0, freedBytes: 0, sizeBytes: 0 };
  const files = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { const st = fs.statSync(p); files.push({ p, size: st.size, mtime: st.mtimeMs }); } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  const maxBytes = Math.max(1, maxMb) * 1024 * 1024;
  const ageMs = Math.max(1, maxAgeDays) * 86400000;
  const now = Date.now();
  let removed = 0;
  let freed = 0;
  const del = (f) => { try { fs.rmSync(f.p, { force: true }); removed++; freed += f.size; return true; } catch { return false; } };
  // 1) 过期文件
  let remain = [];
  for (const f of files) {
    if (now - f.mtime > ageMs) { if (!del(f)) remain.push(f); } else remain.push(f);
  }
  // 2) 容量上限：删最旧的
  let total = remain.reduce((a, b) => a + b.size, 0);
  if (total > maxBytes) {
    remain.sort((a, b) => a.mtime - b.mtime);
    for (const f of remain) {
      if (total <= maxBytes) break;
      if (del(f)) total -= f.size;
    }
  }
  // 清理空目录
  try {
    const pruneEmpty = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) if (e.isDirectory()) pruneEmpty(path.join(d, e.name));
      try { if (fs.readdirSync(d).length === 0 && d !== dir) fs.rmdirSync(d); } catch { /* ignore */ }
    };
    pruneEmpty(dir);
  } catch { /* ignore */ }
  let sizeBytes = 0;
  walk(dir);
  try {
    const collect = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) collect(p);
        else { try { sizeBytes += fs.statSync(p).size; } catch { /* ignore */ } }
      }
    };
    collect(dir);
  } catch { /* ignore */ }
  if (removed) console.log(`[OJ] 清理 Go 构建缓存：删除 ${removed} 个文件，释放 ${(freed / 1024 / 1024).toFixed(1)} MB，剩余 ${(sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  return { removed, freedBytes: freed, sizeBytes };
}

module.exports = {
  availableLanguages,
  resetLanguageCache,
  // M17：系统设置页回显「当前生效的评测可调项」
  judgeTuning,
  normalizeOutput,
  JudgeQueue,
  judgeSubmission,
  cleanJudgeWorkDirs,
  cleanSpjCache,
  pruneSpjCache,
  SPJ_CACHE_DIR,
  // 「清理多余数据」页面用：判断哪些 checker 缓存条目仍被题目引用（与编译时同一套哈希）
  checkerCacheKey,
  spjHashOf,
  releaseSubmissionCheckers,
  pruneGoCache,
  // 交互题
  isInteractiveProblem,
  // 通信题（problem_type = 'communication'，两个选手程序合作完成任务）
  isCommunicationProblem,
  needsPerCasePipeline,
  pruneInteractorCache,
  releaseInteractiveAssets,
  INTERACTOR_CACHE_DIR,
};
