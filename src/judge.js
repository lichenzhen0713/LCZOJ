'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, readTestcases, readSubtaskTypes } = require('./db');
const { encodeDetail } = require('./judgecodec');
const { LANGUAGES, TOOLCHAIN_CANDIDATES, TOOL_VERSION_FLAGS, TOOL_MIN_MAJOR, VERDICTS, DEFAULTS, JUDGE_DIR, DATA_DIR } = require('./config');

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
    tool = resolveTool(lang.toolName);
    available = !!tool;
    if (lang.runToolName && lang.runToolName !== lang.toolName) {
      if (!resolveTool(lang.runToolName)) available = false;
    }
    map[key] = { ...lang, available, tool };
  }
  languageCache = map;
  return map;
}

// ---------------- 底层命令执行（文件重定向，避免命名管道） ----------------

const RUNNER = path.join(__dirname, 'runner.ps1');
const MEM_SAMPLER = path.join(__dirname, 'memsampler.ps1');

/**
 * 通过 shell 执行命令（用于编译），输入/输出/错误都走文件重定向（不用管道）。
 * 返回 { code, timedOut, durationMs, error }。
 */
function runShell(command, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile, env }) {
  return new Promise((resolve) => {
    let full = command;
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

    const finish = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: obj.code == null ? -1 : obj.code, timedOut: !!timedOut, durationMs: Number(process.hrtime.bigint() - start) / 1e6, error: obj.error || '' });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child && child.pid) {
        try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
      }
      if (child && !child.killed) { try { child.kill(); } catch { /* ignore */ } }
      finish({});
    }, timeoutMs);

    try {
      child = spawn(full, { cwd, shell: true, stdio: 'ignore', windowsHide: true, env: env || process.env });
    } catch (e) { finish({ error: e.message }); return; }
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

/**
 * 运行用户程序并测量峰值内存。
 * Windows：用 PowerShell 包装器（src/runner.ps1）启动进程、采样 WorkingSet64 峰值、强制超时。
 * 其它平台：用 /usr/bin/time -v 采样最大驻留内存；不可用时退回纯 shell 运行（内存记 0）。
 * 返回 { code, timedOut, durationMs, memoryKb, error }。
 */
function runMeasured(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile }) {
  if (process.platform === 'win32') return runMeasuredWindows(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile });
  return runMeasuredUnix(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile });
}

function runMeasuredWindows(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile }) {
  return new Promise((resolve) => {
    const jobFile = path.join(cwd, '_job.json');
    const resultFile = path.join(cwd, '_result.json');
    fs.writeFileSync(jobFile, JSON.stringify({ exe, args, cwd, timeoutMs, stdinFile, stdoutFile, stderrFile }));
    try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }

    const start = process.hrtime.bigint();
    let child = null;
    let settled = false;

    const finish = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(failsafe);
      resolve({
        code: obj.code == null ? -1 : obj.code,
        timedOut: !!obj.timedOut,
        durationMs: obj.durationMs != null ? obj.durationMs : Number(process.hrtime.bigint() - start) / 1e6,
        memoryKb: Math.round((obj.peakMemoryBytes || 0) / 1024),
        error: obj.error || '',
      });
    };

    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RUNNER, jobFile, resultFile], { stdio: 'ignore', windowsHide: true });
    } catch (e) { finish({ error: e.message }); return; }

    // 兜底：包装器本身卡死时强制结束（非程序超时）。
    // 这里只是"包装器彻底没反应"的保护：Windows 上 powershell 冷启动在负载高时可能超过 10 秒，
    // 因此留出 30 秒余量（程序本身的超时仍由包装器按 timeoutMs 精确控制，不会因此放过 TLE）。
    const failsafe = setTimeout(() => {
      if (child && child.pid) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
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
  constructor(dir) {
    this.dir = dir;
    this.reqFile = path.join(dir, '_mem_req.json');
    this.resFile = path.join(dir, '_mem_res.json');
    this.child = null;
    this.ok = false;
    this.lastPeak = new Map();
  }

  /** 启动并自检（用当前服务进程自身的 pid 试采一次，确认协议可用）。机器负载高时启动较慢，允许重试。 */
  async start() {
    if (process.platform !== 'win32') return false;
    if (!fs.existsSync(MEM_SAMPLER)) return false;
    for (let attempt = 0; attempt < 2 && !this.ok; attempt++) {
      try {
        this.child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', MEM_SAMPLER, this.reqFile, this.resFile, '20000'], { stdio: 'ignore', windowsHide: true });
      } catch { this.child = null; }
      if (!this.child || !this.child.pid) return false;
      this.child.on('error', () => { this.ok = false; });
      // 自检：请求采样服务进程自己（一定存活）
      this.begin(process.pid, Date.now() + 2000);
      const peak = await this.peakFor(process.pid, 12000);
      this.ok = peak > 0;
      if (!this.ok) {
        try { this.child.kill(); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return this.ok;
  }

  begin(pid, untilMs) {
    try { fs.writeFileSync(this.reqFile, JSON.stringify({ pid, untilMs })); } catch { /* ignore */ }
    this.lastPeak.delete(pid);
  }

  /** 等待该 pid 的采样结果（进程退出后采样器会写回应答）。
   *  等待窗口要覆盖「程序运行时长 + 采样器收尾」，否则长跑用例会取不到内存。 */
  async peakFor(pid, timeoutMs = 3000) {
    if (this.lastPeak.has(pid)) return this.lastPeak.get(pid);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const raw = fs.readFileSync(this.resFile, 'utf8').replace(/^\uFEFF/, '');
        const r = JSON.parse(raw);
        if (Number(r.pid) === Number(pid)) {
          const peak = Number(r.peakBytes) || 0;
          this.lastPeak.set(pid, peak);
          return peak;
        }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 15));
    }
    return 0;
  }

  stop() {
    try { if (this.child) this.child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(this.reqFile, { force: true }); fs.rmSync(this.resFile, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Node 直跑（Windows 快速通道）：由 Node 直接启动用户程序并做文件重定向，
 * 退出码 / 超时由 Node 精确控制；峰值内存由 MemSampler 采样。
 * 相比「每个测试点一个 PowerShell 进程 + WMI 子进程查询」，单点开销从数秒降到百毫秒级。
 */
async function runBatchNode(jobs, sampler) {
  const out = [];
  for (const j of jobs) {
    const t0 = process.hrtime.bigint();
    let fdIn = null;
    let fdOut = null;
    let fdErr = null;
    try {
      fdIn = fs.openSync(j.stdinFile, 'r');
      fdOut = fs.openSync(j.stdoutFile, 'w');
      fdErr = fs.openSync(j.stderrFile, 'w');
    } catch (e) {
      out.push({ code: -1, timedOut: false, durationMs: 0, memoryKb: 0, error: '无法准备输入输出文件：' + e.message });
      continue;
    }
    let child = null;
    let timedOut = false;
    try {
      child = spawn(j.exe, j.args || [], { cwd: j.cwd, stdio: [fdIn, fdOut, fdErr], windowsHide: true });
    } catch (e) {
      fs.closeSync(fdIn); fs.closeSync(fdOut); fs.closeSync(fdErr);
      out.push({ code: -1, timedOut: false, durationMs: 0, memoryKb: 0, error: '启动失败：' + e.message });
      continue;
    }
    if (sampler && sampler.ok) sampler.begin(child.pid, Date.now() + (j.timeoutMs || 1000) + 2500);
    const timer = setTimeout(() => {
      timedOut = true;
      try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    }, Math.max(100, j.timeoutMs || 1000));
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c == null ? -1 : c));
    });
    clearTimeout(timer);
    const runMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // 采样器在进程退出后才写回应答：等待窗口按本用例实际运行时长放大
    const peak = (sampler && sampler.ok) ? await sampler.peakFor(child.pid, Math.max(3000, runMs + 2500)) : 0;
    try { fs.closeSync(fdIn); } catch { /* ignore */ }
    try { fs.closeSync(fdOut); } catch { /* ignore */ }
    try { fs.closeSync(fdErr); } catch { /* ignore */ }
    out.push({
      code,
      timedOut,
      durationMs: runMs,
      memoryKb: Math.round(peak / 1024),
      error: '',
    });
  }
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

function runMeasuredUnix(exe, args, { cwd, timeoutMs, stdinFile, stdoutFile, stderrFile }) {  return new Promise((resolve) => {
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
      resolve({ code: obj.code == null ? -1 : obj.code, timedOut: !!timedOut, durationMs: Number(process.hrtime.bigint() - start) / 1e6, memoryKb, error: obj.error || '' });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child && child.pid) { try { spawnSync('kill', ['-9', String(child.pid)], { stdio: 'ignore' }); } catch { /* ignore */ } }
      finish({});
    }, timeoutMs);
    try { child = spawn(full, { cwd, shell: true, stdio: 'ignore', windowsHide: true }); } catch (e) { finish({ error: e.message }); return; }
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

function compile(lang, dir, srcFile, o2 = true) {
  const tool = resolveTool(lang.toolName);
  if (!tool) {
    return Promise.resolve({ ok: false, log: `未找到编译器 ${lang.toolName}（${lang.name}），无法评测` });
  }
  const exeFile = path.join(dir, 'main.exe');
  const logFile = path.join(dir, 'compile.log');
  let tpl = lang.compile;
  // O2 开关：题目关闭 O2 时去掉编译参数中的 -O2（仅影响 C/C++ 类）
  if (!o2) tpl = tpl.replace(/-O2/g, '');
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
    timeoutMs: 120000,
    stdoutFile: logFile,
    stderrFile: logFile,
    env: goEnv,
  }).then((r) => {
    let log = '';
    try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* ignore */ }
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
const SPJ_CACHE_DIR = path.join(DATA_DIR, 'spj_cache');
/** 缓存上限：最多保留多少个 checker 可执行文件、以及多久未使用即清理（按最近使用时间计） */
const SPJ_CACHE_MAX_ENTRIES = 30;
const SPJ_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SPJ_TMP_MAX_AGE_MS = 5 * 60 * 1000;

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

async function compileChecker(problemId, judgeDir, checkerSrcFile) {
  const tool = resolveTool('g++');
  if (!tool) return { ok: false, log: '未找到 g++，无法编译 Special Judge' };
  const logFile = path.join(judgeDir, 'checker_compile.log');
  const srcDir = path.dirname(checkerSrcFile);
  const bundledTestlib = path.join(__dirname, '..', 'testlib');

  // 缓存键：checker 源码内容 + 所用 testlib.h 内容（bundled 与数据包内同名文件取其一）
  const hashInput = [];
  try { hashInput.push(fs.readFileSync(checkerSrcFile, 'utf8')); } catch (e) { hashInput.push('?src'); }
  const dataTestlib = path.join(srcDir, 'testlib.h');
  const usedTestlib = fs.existsSync(dataTestlib) ? dataTestlib : bundledTestlib;
  try { hashInput.push(fs.readFileSync(path.join(usedTestlib), 'utf8')); } catch (e) { hashInput.push('?testlib'); }
  hashInput.push('flags:-fno-asm -std=c++14 -O2');           // 编译参数变化时同样重新编译
  const h = crypto.createHash('sha1').update(hashInput.join('\n---\n')).digest('hex');
  const cachedExe = path.join(SPJ_CACHE_DIR, 'checker_' + h + '.exe');

  // 命中缓存：直接复用（更新访问时间以便按「最近使用」淘汰），跳过 g++ 编译
  try {
    const st = fs.statSync(cachedExe);
    if (st.size > 0) {
      try { const t = new Date(); fs.utimesSync(cachedExe, t, t); } catch { /* ignore */ }
      console.log(`[OJ] SPJ checker 命中编译缓存（题目 #${problemId}），跳过编译：${path.basename(cachedExe)}`);
      return { ok: true, exeFile: trackChecker(judgeDir, cachedExe), cached: true };
    }
    fs.rmSync(cachedExe, { force: true });                   // 空文件视为无效，重新编译
  } catch { /* 未命中缓存 */ }

  // 编译到缓存路径（先写临时文件再改名，避免并发重复编译时读到半成品）
  try { fs.mkdirSync(SPJ_CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const tmpExe = cachedExe + '.' + process.pid + '.tmp';
  const cmd = `"${tool}" -fno-asm -std=c++14 -O2 -I"${srcDir}" -I"${bundledTestlib}" "${checkerSrcFile}" -o "${tmpExe}"`;
  const t0 = Date.now();
  const r = await runShell(cmd, { cwd: srcDir, timeoutMs: 120000, stdoutFile: logFile, stderrFile: logFile });
  let log = '';
  try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* ignore */ }
  if (r.error) return { ok: false, log: `checker 编译执行失败: ${r.error}\n${log}` };
  if (r.timedOut) return { ok: false, log: 'checker 编译超时' };
  if (r.code !== 0) {
    try { fs.rmSync(tmpExe, { force: true }); } catch { /* ignore */ }
    return { ok: false, log: log || `checker 编译失败（退出码 ${r.code}）` };
  }
  try { fs.renameSync(tmpExe, cachedExe); } catch (e) { /* 改名失败（并发）则以现有缓存为准 */ }
  console.log(`[OJ] SPJ checker 编译完成并写入缓存（题目 #${problemId}，${Date.now() - t0}ms）：${path.basename(cachedExe)}`);
  // 每次新增缓存条目后做一次轻量淘汰，避免目录无限增长
  try { pruneSpjCache(); } catch { /* ignore */ }
  return { ok: true, exeFile: trackChecker(judgeDir, cachedExe) };
}

/**
 * 运行 Special Judge checker：参数顺序与 testlib 一致（in、ouf、ans）。
 * 退出码：0=AC（可能输出部分分），1=WA，2=PE（按 WA 处理），3=checker 异常。
 * 部分分：解析 checker 标准输出中的数值（0~1 视为比例，1~100 视为百分比）。
 */
async function runChecker(dir, checkerExe, inputFile, outputFile, ansFile, testcaseScore) {
  const outLog = path.join(dir, 'checker_stdout.txt');
  const errLog = path.join(dir, 'checker_stderr.txt');
  try { fs.rmSync(outLog, { force: true }); fs.rmSync(errLog, { force: true }); } catch { /* ignore */ }
  const r = await runMeasured(checkerExe, [inputFile, outputFile, ansFile], {
    cwd: dir,
    timeoutMs: 5000,
    stdoutFile: outLog,
    stderrFile: errLog,
  });
  let stdout = '';
  let stderr = '';
  try { stdout = fs.readFileSync(outLog, 'utf8'); } catch { /* ignore */ }
  try { stderr = fs.readFileSync(errLog, 'utf8'); } catch { /* ignore */ }
  if (r.error || r.timedOut) {
    return { verdict: VERDICTS.SE, fraction: 0, message: 'Special Judge 执行异常：' + (r.error || '超时') };
  }
  const code = r.code == null ? -1 : r.code;
  // 部分分：解析 stdout 中的数字
  let fraction = 1;
  if (code === 0) {
    const m = String(stdout).match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= 0 && v <= 1) fraction = v;
      else if (v > 1 && v <= 100) fraction = v / 100;
    }
    const msg = String(stdout).trim().slice(0, 200) || 'Special Judge 判定通过';
    return { verdict: VERDICTS.AC, fraction, message: msg, spj_msg: msg };
  }
  if (code === 1 || code === 2) {
    return { verdict: VERDICTS.WA, fraction: 0, message: '答案错误（Special Judge）' + (String(stdout).trim() ? `：${String(stdout).trim().slice(0, 150)}` : '') };
  }
  return { verdict: VERDICTS.SE, fraction: 0, message: 'Special Judge 自身异常（exit ' + code + '）' + (stderr ? `：${stderr.slice(0, 150)}` : '') };
}

/** 组装用户程序的运行命令（批量执行与单点执行共用同一套逻辑） */
function buildRunCommand(lang, dir, srcFile, exeFile) {
  const runTool = lang.runToolName ? resolveTool(lang.runToolName) : null;
  const runCmd = lang.run
    .replace(/\{tool\}/g, `"${resolveTool(lang.toolName) || lang.toolName}"`)
    .replace(/\{runTool\}/g, `"${runTool || lang.runToolName}"`)
    .replace(/\{src\}/g, `"${srcFile}"`)
    .replace(/\{exe\}/g, `"${exeFile}"`)
    .replace(/\{dir\}/g, `"${dir}"`);
  const tokens = tokenizeCommand(runCmd);
  return { exe: tokens[0], args: tokens.slice(1) };
}

/** 为一个测试点准备输入文件与运行任务（供批量执行使用） */
function prepareCaseJob(lang, dir, srcFile, exeFile, testcase, problem) {
  const inputFile = path.join(dir, `input_${testcase.id}.txt`);
  const outputFile = path.join(dir, `output_${testcase.id}.txt`);
  const errorFile = path.join(dir, `error_${testcase.id}.txt`);
  fs.writeFileSync(inputFile, testcase.input ?? '');
  const { exe, args } = buildRunCommand(lang, dir, srcFile, exeFile);
  return {
    job: {
      exe,
      args,
      cwd: dir,
      timeoutMs: problem.time_limit_ms + 500,
      stdinFile: inputFile,
      stdoutFile: outputFile,
      stderrFile: errorFile,
    },
    files: { inputFile, outputFile, errorFile },
  };
}

/** 判单个测试点（opts: { spj: checker 可执行文件, answerFile: 提交答案题的用户答案文件, preRun: 批量执行已得到的结果 }） */
async function judgeCase(lang, dir, srcFile, exeFile, testcase, problem, opts = {}) {
  const pre = opts.preRun || null;
  const inputFile = pre ? pre.files.inputFile : path.join(dir, 'input.txt');
  const outputFile = pre ? pre.files.outputFile : path.join(dir, 'output.txt');
  const errorFile = pre ? pre.files.errorFile : path.join(dir, 'error.txt');
  if (!pre) fs.writeFileSync(inputFile, testcase.input ?? '');

  let stdout = '';
  let runInfo = { time_ms: 0, memory_kb: 0, code: 0, error: '' };

  if (lang.outputOnly) {
    // 提交答案题：不运行程序，直接使用用户提交的答案文件
    if (opts.answerFile && fs.existsSync(opts.answerFile)) {
      try { stdout = fs.readFileSync(opts.answerFile, 'utf8'); } catch { /* ignore */ }
    }
  } else {
    const { exe, args } = buildRunCommand(lang, dir, srcFile, exeFile);
    const r = pre || await runMeasured(exe, args, {
      cwd: dir,
      timeoutMs: problem.time_limit_ms + 500,
      stdinFile: inputFile,
      stdoutFile: outputFile,
      stderrFile: errorFile,
    });
    runInfo = { time_ms: Math.round(r.durationMs), memory_kb: r.memoryKb || 0, code: r.code, error: r.error, timedOut: r.timedOut };
    try { stdout = fs.readFileSync(outputFile, 'utf8'); } catch { /* ignore */ }
    let stderr = '';
    try { stderr = fs.readFileSync(errorFile, 'utf8'); } catch { /* ignore */ }

    if (r.error) {
      return { verdict: VERDICTS.SE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, message: r.error };
    }
    if (r.timedOut) {
      return { verdict: VERDICTS.TLE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, message: '运行超时' };
    }
    // 输出大小限制
    if (Buffer.byteLength(stdout, 'utf8') > DEFAULTS.outputLimitBytes) {
      return { verdict: VERDICTS.RE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, message: '输出过大' };
    }
    // 内存限制
    if (problem.memory_limit_mb > 0 && runInfo.memory_kb > problem.memory_limit_mb * 1024) {
      return { verdict: VERDICTS.MLE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, message: `内存超限（${runInfo.memory_kb} KB > ${problem.memory_limit_mb * 1024} KB）` };
    }
    if (r.code !== 0) {
      return { verdict: VERDICTS.RE, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, message: `运行时错误（退出码 ${r.code}）` + (stderr ? `\n${stderr.slice(0, 500)}` : '') };
    }
  }

  // 判定：Special Judge 优先
  if (opts.spj) {
    // 写入标准答案文件供 checker 读取
    const ansFile = path.join(dir, 'answer.txt');
    fs.writeFileSync(ansFile, testcase.output ?? '');
    // 将用户输出（程序 stdout 或提交的答案）写入 output.txt
    fs.writeFileSync(outputFile, stdout);
    const cres = await runChecker(dir, opts.spj, inputFile, outputFile, ansFile, testcase.subtask_score);
    return { ...cres, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb };
  }

  const expected = normalizeOutput(testcase.output);
  const actual = normalizeOutput(stdout);
  if (expected === actual) {
    return { verdict: VERDICTS.AC, time_ms: runInfo.time_ms, memory_kb: runInfo.memory_kb, message: '正确', fraction: 1 };
  }
  return {
    verdict: VERDICTS.WA,
    time_ms: runInfo.time_ms,
    memory_kb: runInfo.memory_kb,
    message: '答案错误',
    fraction: 0,
    expected: expected.slice(0, 200),
    actual: actual.slice(0, 200),
  };
}

// ---------------- 主判题流程 ----------------

const verdictPriority = {
  [VERDICTS.SE]: 6,
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
      return { error: '答案 ZIP 解析失败：' + e.message };
    }
  }
  // 单个答案文件：写入第 1 个测试点的答案（多测试点时其余为空）
  for (let i = 1; i <= testcaseCount; i++) {
    fs.writeFileSync(path.join(dir, `ans_${i}.txt`), i === 1 ? buf : Buffer.from(''));
  }
  return { zip: false };
}

async function judgeSubmission(submissionId) {
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

  const dir = path.join(JUDGE_DIR, String(submissionId));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Special Judge：编译 checker.cpp（测试数据目录）
  let checkerExe = null;
  const isSpj = !!problem.spj;
  if (isSpj) {
    const { checkerPath: cp } = require('./db');
    const checkerSrc = cp(problem.id);
    if (fs.existsSync(checkerSrc)) {
      const cres = await compileChecker(problem.id, dir, checkerSrc);
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

  // 提交答案题：提取答案文件
  let answerFiles = {};
  if (lang.outputOnly) {
    const testcases0 = readTestcases(problem.id);
    const ext = extractAnswers(sub.code, dir, Math.max(1, testcases0.length));
    if (ext.error) {
      db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ?, judge_detail = ? WHERE id = ?")
        .run('Done', VERDICTS.SE, ext.error, JSON.stringify([]), submissionId);
      bumpProblemStats(problem.id, false);
      return;
    }
    for (let i = 1; i <= Math.max(1, testcases0.length); i++) answerFiles[i] = path.join(dir, `ans_${i}.txt`);
  }

  // 源文件名：Java 等语言要求公共类名与文件名一致（srcName 大写 Main.java），其余默认 main.ext
  const srcName = lang.srcName || 'main';
  const srcFile = path.join(dir, `${srcName}.${lang.ext}`);
  if (!lang.outputOnly) fs.writeFileSync(srcFile, sub.code);

  // Go：module 模式需要 go.mod；共享 GOCACHE 目录（见 compile 内注释）
  if (lang.key === 'go' && !lang.outputOnly) {
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module lczoj\n\ngo 1.21\n');
      fs.mkdirSync(path.join(DATA_DIR, 'gocache'), { recursive: true });
      fs.mkdirSync(path.join(DATA_DIR, 'gopath'), { recursive: true });
    } catch { /* ignore */ }
  }

  // 编译
  let exeFile = srcFile;
  if (lang.compiled && !lang.outputOnly) {
    // O2：优先使用本次提交的选择（sub.enable_o2），否则回退题目设置
    const o2 = sub.enable_o2 == null ? (problem.enable_o2 !== 0 && problem.enable_o2 !== false) : (sub.enable_o2 !== 0);
    const cres = await compile(lang, dir, srcFile, o2);
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

  // Windows：先把全部测试点的「运行」阶段批量执行，再逐点做输出比对。
  // 优先走「Node 直跑 + 单进程内存采样」（每点约百毫秒）；不可用时回退到 PowerShell 包装器批量执行。
  let preRuns = null;
  if (process.platform === 'win32' && !lang.outputOnly) {
    const jobs = [];
    try {
      for (const tc of testcases) jobs.push(prepareCaseJob(lang, dir, srcFile, exeFile, tc, problem));
    } catch (e) {
      console.warn('[judge] 准备运行任务失败：' + (e && e.message ? e.message : e));
    }
    if (jobs.length && process.env.OJ_JUDGE_RUNNER !== 'ps') {
      const sampler = new MemSampler(dir);
      let samplerOk = false;
      try { samplerOk = await sampler.start(); } catch { samplerOk = false; }
      if (samplerOk) {
        try {
          const results = await runBatchNode(jobs.map((j) => j.job), sampler);
          preRuns = jobs.map((j, i) => Object.assign({}, results[i], { files: j.files }));
        } catch (e) {
          preRuns = null;
          console.warn('[judge] Node 直跑失败，回退包装器：' + (e && e.message ? e.message : e));
        } finally {
          sampler.stop();
        }
      } else {
        sampler.stop();
        console.warn('[judge] 内存采样器不可用，回退 PowerShell 包装器执行');
      }
    }
    if (!preRuns && jobs.length) {
      try {
        const results = await runMeasuredBatch(jobs.map((j) => j.job));
        preRuns = jobs.map((j, i) => Object.assign({}, results[i], { files: j.files }));
      } catch (e) {
        preRuns = null; // 批量执行异常时回退到逐点执行，保证判题可用
        console.warn('[judge] 批量执行失败，回退逐测试点执行：' + (e && e.message ? e.message : e));
      }
    }
  }

  for (let idx = 0; idx < testcases.length; idx++) {
    const tc = testcases[idx];
    const opts = { spj: checkerExe };
    if (lang.outputOnly) opts.answerFile = answerFiles[tc.id];
    if (preRuns && preRuns[idx]) opts.preRun = preRuns[idx];
    const res = await judgeCase(lang, dir, srcFile, exeFile, tc, problem, opts);
    details.push({ id: tc.id, subtask: tc.subtask, subtask_score: tc.subtask_score, ...res });
    // 增量写入：每判完一个测试点就落库，前端可实时看到测试点逐个点亮（评测中剩余显示转圈）
    try {
      db.prepare('UPDATE submissions SET judge_detail = ? WHERE id = ?').run(JSON.stringify(details), submissionId);
    } catch { /* ignore */ }
    if (res.time_ms > maxTime) maxTime = res.time_ms;
    if (res.memory_kb > maxMem) maxMem = res.memory_kb;
    if ((verdictPriority[res.verdict] || 0) > (verdictPriority[worst] || 0)) {
      worst = res.verdict;
    }
    // 系统错误立即终止，避免浪费
    if (res.verdict === VERDICTS.SE) break;
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
    try {
      await judgeSubmission(id);
    } catch (e) {
      db.prepare("UPDATE submissions SET status = ?, verdict = ?, compile_error = ? WHERE id = ?")
        .run('Done', VERDICTS.SE, String(e && e.stack ? e.stack : e).slice(0, 2000), id);
    } finally {
      // 评测结束立即删除该提交的临时工作目录（源码/编译中间产物/输入输出）。
      // SPJ checker 的编译产物**不删除**：它按源码哈希缓存在 data/spj_cache，供后续提交直接复用。
      const workDir = path.join(JUDGE_DIR, String(id));
      try { releaseSubmissionCheckers(workDir); } catch { /* ignore */ }
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
  normalizeOutput,
  JudgeQueue,
  judgeSubmission,
  cleanJudgeWorkDirs,
  cleanSpjCache,
  pruneSpjCache,
  SPJ_CACHE_DIR,
  releaseSubmissionCheckers,
  pruneGoCache,
};
