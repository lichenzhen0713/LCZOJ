'use strict';

/**
 * 通信题评测（problem_type = 'communication'）—— 与 interactive_io / interactive_func **完全独立**的第三种题型。
 *
 * 定义（站长口径）：通信题需要**两个选手程序**进行通信、合作完成某项任务：
 *   · **程序一**接收问题的输入并产生某些输出；
 *   · **程序二**的输入与程序一的输出相关（有时原封不动作为一个参数，有时由评测端处理得到），
 *     它需要产生问题的解。
 * 例子：UOJ #178 新年的贺电、UOJ #454【UER #8】打雪仗；本地测试常见做法是「用双向管道把两个程序的标准输入输出连起来」。
 *
 * 评测端支持两种连接方式（题目侧在 `data/testdata/<题号>/meta.json` 里用 `pipe_mode` 选择）：
 *
 *   1) `relay`（**默认**，评测端中转）—— 逐测试点顺序执行，完全可测、可采样、可复现：
 *        a. 用 `N.in` 跑**程序一**，收下它的 stdout（受通信量上限 prog1_output_limit_bytes 约束）；
 *        b. 若题目提供 `grader.cpp`（评测端中转程序），则以程序一的输出为 stdin 运行它，
 *           把它的 stdout 作为程序二的输入；（grader 是评测设施，不计入选手时限/内存，
 *           它退出码非 0 表示「程序一的输出未通过校验」，判 WA 并回传它的结论）
 *        c. 以（a 或 b 的）结果作为 stdin 跑**程序二**，比较程序二的 stdout 与 `N.out`
 *           （或交给 checker.cpp 判分，支持部分分）；
 *        d. 两个程序**各自**受题目时限/内存约束（沿用 meta.json 的 case_limits 点级限额）。
 *
 *   2) `direct`（双向管道直连）—— 程序一的 stdout 直接接到程序二的 stdin，两者**并行运行、边跑边传**，
 *        并把程序二的 stdout 收集到文件用于判定；`meta.json` 里的 `duplex: true` 时再把程序二的 stdout
 *        回传给程序一的 stdin（用于需要双向对话的合作任务）。该模式下不执行 grader.cpp（中转本身就是管道）。
 *        注意：直连模式下**内存采样只覆盖程序二**（评测机只有一个内存采样通道），
 *        程序一只受时限约束；relay 模式则两个程序都会被采样（见 judge.js 的说明）。
 *
 * 本模块只负责「进程怎么接、结果怎么收」；编译、判定、点位限额、SPJ、采样器都由 judge.js 注入/驱动，
 * 避免与 judge.js 形成循环依赖（与 src/interactive.js 同一套做法）。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

/** 直连模式的硬性兜底：两侧都还活着时，整体墙钟最多允许超过单程序时限的余量（毫秒） */
const DIRECT_TOTAL_GRACE_MS = 5000;
/** 采集程序输出的上限（字节）：只用于「统计 + 判超限」，实际落盘由调用方给的文件描述符负责 */
const CAPTURE_MAX = 1 << 20;

/** 结束一个进程及其子进程（Windows 需要 /T 才能连带子进程；与 interactive.js 的 killTree 同口径） */
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

/** 只结束「确实还活着」的进程（exitCode/signalCode 都已落地的进程跳过，避免误杀被复用的 pid） */
function killIfAlive(child) {
  if (!child || !child.pid) return;
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  if (child.signalCode !== null && child.signalCode !== undefined) return;
  killTree(child);
}

/**
 * direct（双向管道直连）模式：把程序一的 stdout 接到程序二的 stdin，两者并行运行。
 *
 * @param {object} opts
 *   - exe1/args1        程序一的可执行文件与参数（由 judge.js 的 buildRunCommand 组装）
 *   - exe2/args2        程序二的可执行文件与参数
 *   - cwd               两个选手程序的工作目录（可写，不含判分私有物）
 *   - inputFile         题目输入（`N.in`），作为程序一的 stdin **文件**（非 duplex 时读到 EOF 即关闭）
 *   - outFile           程序二的 stdout 落盘文件（判定用）
 *   - errFile1/errFile2 两个程序的 stderr 落盘文件（排查用）
 *   - timeoutMs1/2      两个程序各自的时限闸门（毫秒，已含进程创建基线与余量）
 *   - duplex            true = 把程序二的 stdout 再回传给程序一的 stdin（双向对话）
 *   - outputLimitBytes  系统输出上限（程序二 stdout 超过即杀进程并标记 outputExceeded）
 *   - commLimitBytes    程序一输出（通信量）上限；0 = 不限（仍受 outputLimitBytes 约束）
 *   - spawnOpts         额外的 spawn 选项（H1：选手进程按降权选项启动）
 *   - sampler           内存采样器（可为 null）；**只用于程序二**（见文件头说明）
 * @returns {Promise<object>} { code1, code2, durationMs1, durationMs2, timedOut, timeoutProgram,
 *                              outputExceeded, commExceeded, outBytes1, outBytes2, memoryKb, memorySampled, error }
 */
function runCommunicationDirect(opts) {
  const {
    exe1, args1, exe2, args2, cwd, inputFile, outFile, errFile1, errFile2,
    timeoutMs1, timeoutMs2, duplex = false, outputLimitBytes = Infinity,
    commLimitBytes = 0, spawnOpts = {}, sampler = null,
  } = opts;
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let settled = false;
    let timedOut = false;
    let timeoutProgram = '';
    let outputExceeded = false;
    let commExceeded = false;
    let outBytes1 = 0;
    let outBytes2 = 0;
    let code1 = null;
    let code2 = null;
    let dur1 = 0;
    let dur2 = 0;
    let memoryKb = 0;
    let memorySampled = false;

    let p1 = null;
    let p2 = null;
    let timer1 = null;
    let timer2 = null;
    // 程序二 stdout 的内存采集缓冲（跑完后一次性写 outFile，见 finish）；
    // 与 stderr 的文件描述符一起声明在 finish 之前，避免任何早退路径读到未初始化的变量。
    const chunks = [];
    let fdErr1 = null;
    let fdErr2 = null;
    const totalGrace = Math.max(timeoutMs1 || 1000, timeoutMs2 || 1000) + DIRECT_TOTAL_GRACE_MS;
    const totalTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timeoutProgram = timeoutProgram || '程序一/程序二（总时长超出上限）';
      finish();
    }, totalGrace);
    if (totalTimer.unref) totalTimer.unref();

    /** 收尾：先固定判定结论（退出码 / 超时 / 字节数），再杀进程与采样——采样绝不能改写判定 */
    const finish = async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(totalTimer);
      // 被超时/超限杀掉的一方没有 exit 事件，用时按「从启动到收尾」的墙钟补上（判定结论早已固定）
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      if (!dur1) dur1 = elapsed;
      if (!dur2) dur2 = elapsed;
      const result = {
        code1: code1 == null ? -1 : code1,
        code2: code2 == null ? -1 : code2,
        durationMs1: Math.round(dur1),
        durationMs2: Math.round(dur2),
        durationMs: Math.round(Math.max(dur1, dur2)),
        timedOut,
        timeoutProgram,
        outputExceeded,
        commExceeded,
        outBytes1,
        outBytes2,
        memoryKb: 0,
        memorySampled: false,
        error: String(err || ''),
      };
      // 先固定结论（退出码/超时/字节数），再杀进程、落盘输出与采样——采样绝不能改写判定。
      // 只杀「确实还活着」的进程：进程已退出时再 taskkill 既浪费同步时间，也可能误杀被复用的 pid。
      killIfAlive(p1);
      killIfAlive(p2);
      // 程序二的 stdout 在内存里采集：在 resolve 之前一次性写盘（判定方读到的一定是完整输出）
      try {
        fs.writeFileSync(outFile, Buffer.concat(chunks));
      } catch (e) {
        result.error = result.error || ('直连模式写入程序二输出失败：' + (e && e.message ? e.message : e));
      }
      try { fs.closeSync(fdErr1); } catch { /* ignore */ }
      try { fs.closeSync(fdErr2); } catch { /* ignore */ }
      if (sampler && sampler.ok && p2 && p2.pid) {
        try {
          const peak = await sampler.peakFor(p2.pid, 600);
          result.memorySampled = peak > 0;
          result.memoryKb = peak > 0 ? Math.max(1, Math.round(peak / 1024)) : 0;
        } catch { /* 采样失败绝不影响判定 */ }
      }
      resolve(result);
    };

    // 打开两个程序的 stderr（落盘文件）；程序二的 stdout 走**管道**在内存里采集，
    // 跑完后由本函数写进 outFile——这样「进程退出」与「输出落盘」之间不存在异步刷盘竞态，
    // 判定方拿到的一定是完整输出（采集上限 = 系统输出上限，超限会被看门狗结束并标记 outputExceeded）。
    try {
      fdErr1 = fs.openSync(errFile1, 'w');
      fdErr2 = fs.openSync(errFile2, 'w');
    } catch (e) {
      try { if (fdErr1 != null) fs.closeSync(fdErr1); if (fdErr2 != null) fs.closeSync(fdErr2); } catch { /* ignore */ }
      settled = true;
      clearTimeout(totalTimer);
      return resolve({
        code1: -1, code2: -1, durationMs1: 0, durationMs2: 0, durationMs: 0,
        timedOut: false, timeoutProgram: '', outputExceeded: false, commExceeded: false,
        outBytes1: 0, outBytes2: 0, memoryKb: 0, memorySampled: false,
        error: '无法准备直连模式的输出文件：' + (e && e.message ? e.message : e),
      });
    }

    try {
      // stdio：程序一 stdin/stdout 走管道（与程序二对接），stderr 落盘；
      //        程序二 stdin 走管道（程序一喂）、stdout 走管道（内存采集）、stderr 落盘。
      p1 = spawn(exe1, args1 || [], { cwd, stdio: ['pipe', 'pipe', fdErr1], windowsHide: true, ...(spawnOpts || {}) });
      p2 = spawn(exe2, args2 || [], { cwd, stdio: ['pipe', 'pipe', fdErr2], windowsHide: true, ...(spawnOpts || {}) });
    } catch (e) {
      try { fs.closeSync(fdErr1); fs.closeSync(fdErr2); } catch { /* ignore */ }
      return finish('启动选手进程失败：' + (e && e.message ? e.message : e));
    }

    // 采样窗口要覆盖程序二的整个运行期
    if (sampler && sampler.ok && p2.pid) {
      try { sampler.begin(p2.pid, Date.now() + (timeoutMs2 || 1000) + 2500); } catch { /* ignore */ }
    }

    // 管道中有写入方提前退出时会产生 EPIPE：必须挂 error 处理器，否则未处理的 'error' 事件会打挂整个服务
    const ignoreErr = () => {};
    [p1.stdin, p2.stdin, p1.stdout, p2.stdout].forEach((s) => { try { s.on('error', ignoreErr); } catch { /* ignore */ } });

    // 核心接线：程序一 stdout → 程序二 stdin
    p1.stdout.pipe(p2.stdin);
    // 程序一的输出字节数（通信量限制只约束程序一；同时用于详情展示）
    p1.stdout.on('data', (d) => {
      outBytes1 += d.length;
      if (commLimitBytes > 0 && outBytes1 > commLimitBytes && !settled) {
        commExceeded = true;
        finish();
      }
    });
    // 题目输入喂给程序一：duplex 时不能因为读到 EOF 就关闭程序一的 stdin（还要收程序二的回传）
    try {
      const rs = fs.createReadStream(inputFile);
      rs.on('error', () => {});
      rs.pipe(p1.stdin, { end: !duplex });
    } catch { /* 打不开输入文件时程序一自然读到 EOF，交由判定处理 */ }

    // 程序二的 stdout：duplex 时回传给程序一；两种情况下都采集字节（用于判定 + 落盘）并做系统输出上限看门狗
    if (duplex) {
      p2.stdout.pipe(p1.stdin);
    }
    p2.stdout.on('data', (d) => {
      outBytes2 += d.length;
      if (outputLimitBytes && outBytes2 > outputLimitBytes) {
        outputExceeded = true;
        finish();
        return;
      }
      chunks.push(d);
    });

    timer1 = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timeoutProgram = '程序一';
      finish();
    }, Math.max(100, timeoutMs1 || 1000));
    timer2 = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timeoutProgram = '程序二';
      finish();
    }, Math.max(100, timeoutMs2 || 1000));

    p1.on('error', (e) => finish('程序一启动失败：' + (e && e.message ? e.message : e)));
    p2.on('error', (e) => finish('程序二启动失败：' + (e && e.message ? e.message : e)));
    p1.on('exit', (c) => {
      code1 = c == null ? -1 : c;
      dur1 = Number(process.hrtime.bigint() - start) / 1e6;
      if (timer1) clearTimeout(timer1);
      maybeDone();
    });
    p2.on('exit', (c) => {
      code2 = c == null ? -1 : c;
      dur2 = Number(process.hrtime.bigint() - start) / 1e6;
      if (timer2) clearTimeout(timer2);
      maybeDone();
    });

    function maybeDone() {
      // 两侧都退出才算跑完（一侧先退出时，另一侧可能还在把最后的数据读干净）
      if (code1 == null || code2 == null) return;
      if (settled) return;
      finish();
    }
  });
}

/** 采集程序输出文件（判定 / 消息用）：最多读 maxBytes，避免超长输出撑爆内存 */
function readCaptured(file, maxBytes = CAPTURE_MAX) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return '';
    if (st.size <= maxBytes) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** 读取文件字节数（通信量 / 输出上限的落盘复核） */
function fileSizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** 通信量超限消息（程序一输出字节数 > 题目配置上限） */
function commLimitMessage(actualBytes, limitBytes) {
  return `答案错误（通信量超限）：程序一输出 ${actualBytes} 字节 > 题目限制 ${limitBytes} 字节`;
}

module.exports = {
  runCommunicationDirect,
  killIfAlive,
  readCaptured,
  fileSizeOf,
  commLimitMessage,
  killTree,
  DIRECT_TOTAL_GRACE_MS,
};
