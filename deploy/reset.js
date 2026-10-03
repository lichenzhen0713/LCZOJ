#!/usr/bin/env node
'use strict';
/**
 * LCZOJ 恢复默认状态（跨平台：Windows / Linux / macOS 通用）
 *
 *   node deploy/reset.js              停止服务并清空数据（会先询问确认）
 *   node deploy/reset.js --yes        不询问，直接执行（脚本化场景）
 *   node deploy/reset.js --check      只显示将要执行的操作，不做任何修改
 *   node deploy/reset.js --start      清空后前台启动（Ctrl+C 停止）
 *   node deploy/reset.js --daemon     清空后后台启动（日志 logs/lczoj.log）
 *   node deploy/reset.js --port 8080  指定端口（默认取 PORT 环境变量，否则 80）
 *   node deploy/reset.js --clear-logs 同时清空 logs/ 下的日志文件
 *
 * 根目录下的 reset.bat / reset.sh 只是本脚本的快捷入口，行为完全一致。
 *
 * 说明：
 *   · 只会删除**数据目录**（默认 <项目目录>/data，可用 OJ_DATA_DIR 指定）中的
 *     数据库、题库测试数据、附件、头像与判题缓存；程序代码与配置不动。
 *   · 删除前会按 systemd → PM2 → deploy/panel.pid → 端口监听 → server.js 残留进程
 *     的顺序停止服务，避免服务被守护进程重新拉起或数据文件被占用。
 *   · 清空后首次启动会自动重建默认数据：管理员 admin（**初始密码随机生成**，写在 data/admin-password.txt）与 3 道示例题。
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const isWin = process.platform === 'win32';
const DATA_DIR = process.env.OJ_DATA_DIR ? path.resolve(ROOT, process.env.OJ_DATA_DIR) : path.join(ROOT, 'data');
const PID_FILE = path.join(ROOT, 'deploy', 'panel.pid');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'lczoj.log');

/* ---------------------------------- 参数 ---------------------------------- */
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
function argValue(name, dflt) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : dflt;
}

const CHECK_ONLY = has('--check');
const ASSUME_YES = has('--yes') || has('-y');
const MODE = has('--start') ? 'start' : (has('--daemon') ? 'daemon' : 'stop');
const CLEAR_LOGS = has('--clear-logs');
const KILL_ALL = has('--all');
const PORT = parseInt(argValue('--port', process.env.PORT || '80'), 10) || 80;

if (has('--help') || has('-h')) {
  console.log(`
LCZOJ 恢复默认状态

  node deploy/reset.js              停止服务并清空数据（询问确认）
  node deploy/reset.js --yes        不询问，直接执行
  node deploy/reset.js --check      只显示将要执行的操作，不做任何修改
  node deploy/reset.js --start      清空后前台启动
  node deploy/reset.js --daemon     清空后后台启动（日志 logs/lczoj.log）
  node deploy/reset.js --port 8080  指定端口
  node deploy/reset.js --all        同时结束其它疑似残留的 node server.js 进程
  node deploy/reset.js --clear-logs 同时清空日志文件
  node deploy/reset.js --help       显示本帮助

  等价入口：Windows 双击 reset.bat；Linux / macOS 执行 ./reset.sh

  默认只会停止「本端口上的服务 / systemd 单元 / PM2 应用 / panel.pid 记录的进程」，
  不会误杀同一台机器上其它目录里的 LCZOJ 实例；确实需要时再加 --all。
`);
  process.exit(0);
}

/* ---------------------------------- 工具 ---------------------------------- */
const out = (s = '') => console.log(s);
const step = (n, total, title) => { out(''); out(`【${n}/${total}】${title}`); };
const okLine = (s) => out('   ✓ ' + s);
const warnLine = (s) => out('   ! ' + s);
const infoLine = (s) => out('   · ' + s);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    timeout: opts.timeout || 60000,
    windowsHide: true,
  });
  return { code: r.status == null ? 1 : r.status, out: String((r.stdout || '') + (r.stderr || '')).trim() };
}
const hasCmd = (cmd) => run(isWin ? 'where' : 'which', [cmd]).code === 0;

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, '0.0.0.0'); } catch { resolve(false); }
  });
}

/** 结束进程：先温和，超时再强制 */
async function killPid(pid, label) {
  if (!alive(pid)) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  for (let i = 0; i < 12 && alive(pid); i++) await sleep(300);
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    await sleep(300);
  }
  const gone = !alive(pid);
  if (gone) okLine(`已结束进程 PID ${pid}${label ? '（' + label + '）' : ''}`);
  else warnLine(`无法结束进程 PID ${pid}${label ? '（' + label + '）' : ''}（可能由其他用户或管理员启动，请在任务管理器 / sudo 下结束）`);
  return gone;
}

/* --------------------------- 各类“谁在运行服务”探测 --------------------------- */
function systemdUnitActive() {
  if (isWin || !hasCmd('systemctl')) return { exists: false, active: false };
  const files = run('systemctl', ['list-unit-files', 'lczoj.service']).out;
  const exists = files.includes('lczoj.service');
  const active = exists && run('systemctl', ['is-active', 'lczoj']).out.trim() === 'active';
  return { exists, active };
}

function pm2Managed() {
  if (!hasCmd('pm2')) return false;
  return run('pm2', ['jlist']).out.includes('lczoj');
}

/** 端口监听进程（Windows 用 PowerShell，Linux/macOS 用 lsof/ss） */
function portOwners(port) {
  const pids = new Set();
  if (isWin) {
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`]);
    for (const line of r.out.split(/\r?\n/)) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n) && n > 0) pids.add(n);
    }
    if (!pids.size) {
      // 回退：解析 netstat 输出
      const ns = run('netstat', ['-ano']);
      for (const line of ns.out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const local = parts[1] || '';
        if (!new RegExp(`[:.]${port}$`).test(local)) continue;
        const pid = parseInt(parts[parts.length - 1], 10);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    }
    return [...pids];
  }
  if (hasCmd('lsof')) {
    const r = run('lsof', ['-ti', `tcp:${port}`]);
    for (const line of r.out.split(/\r?\n/)) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n)) pids.add(n);
    }
    return [...pids];
  }
  if (hasCmd('ss')) {
    const r = run('ss', ['-lntp']);
    for (const line of r.out.split(/\r?\n/)) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      const m = line.match(/pid=(\d+)/);
      if (m) pids.add(parseInt(m[1], 10));
    }
  }
  return [...pids];
}

/** 兜底：命令行里直接运行 server.js 的 node 进程（可能是换了端口的旧服务） */
function strayServerPids() {
  const pids = new Set();
  if (isWin) {
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\\.js' } | ForEach-Object { $_.ProcessId }"]);
    for (const line of r.out.split(/\r?\n/)) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n) && n > 0 && n !== process.pid) pids.add(n);
    }
    return [...pids];
  }
  if (hasCmd('pgrep')) {
    const r = run('pgrep', ['-f', 'node(js)? .*server\\.js']);
    for (const line of r.out.split(/\r?\n/)) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n) && n > 0 && n !== process.pid) pids.add(n);
    }
  }
  return [...pids];
}

async function waitHealthy(port, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(1000);
  }
  return null;
}

/** 删除数据目录：Windows 上刚结束进程时文件句柄可能尚未释放，按退避策略重试 */
async function removeDataDir(dir) {
  const waits = [0, 400, 800, 1500, 2500, 4000, 5000];
  let lastErr = null;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await sleep(waits[i]);
    try {
      if (!fs.existsSync(dir)) return { ok: true };
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      if (!fs.existsSync(dir)) return { ok: true, retries: i };
      lastErr = new Error('目录仍然存在');
    } catch (err) {
      lastErr = err;
    }
    if (i + 1 < waits.length) infoLine(`文件仍被占用（${(lastErr && lastErr.code) || 'EBUSY'}），${waits[i + 1]}ms 后重试…`);
  }
  // 仍失败时，尽量列出被占用的文件，便于用户定位（例如杀毒软件 / 编辑器 / 资源管理器预览）
  const blocked = [];
  const scan = (d, depth = 0) => {
    if (depth > 2 || blocked.length >= 3) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { scan(p, depth + 1); continue; }
      try { fs.unlinkSync(p); } catch { if (blocked.length < 3) blocked.push(path.relative(ROOT, p)); }
    }
  };
  try { scan(dir); } catch { /* ignore */ }
  if (blocked.length) lastErr = new Error(`${(lastErr && lastErr.message) || '删除失败'}；被占用的文件：${blocked.join('、')}`);
  return { ok: false, error: lastErr };
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + ' [y/N] ', (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(a).trim()));
    });
  });
}

/* ---------------------------------- 主流程 ---------------------------------- */
(async () => {
  const supervisor = systemdUnitActive();
  const pm2 = pm2Managed();
  const pidFromFile = (() => { try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch { return NaN; } })();
  const owners = portOwners(PORT);
  const strays = strayServerPids();
  const dataExists = fs.existsSync(DATA_DIR);

  out('');
  out('============================================================');
  out('  LCZOJ 恢复默认状态');
  out('============================================================');
  out(`  项目目录：${ROOT}`);
  out(`  数据目录：${DATA_DIR}${dataExists ? '' : '（当前不存在）'}`);
  out(`  服务端口：${PORT}`);
  out(`  启动方式：${supervisor.active ? 'systemd 服务 lczoj' : (pm2 ? 'PM2 应用 lczoj' : (alive(pidFromFile) ? 'panel.pid 后台进程' : (owners.length ? '端口监听进程' : '未检测到运行中的服务')))}`);
  if (CHECK_ONLY) out('  模式：只检查（--check），不做任何修改');

  const total = MODE === 'stop' ? 3 : 4;

  /* ---------- 0. 二次确认（破坏性操作） ---------- */
  if (!CHECK_ONLY && !ASSUME_YES) {
    if (!process.stdin.isTTY) {
      warnLine('未指定 --yes 且当前不是交互终端，为避免误删数据已中止');
      infoLine('确认无误后请附加 --yes 重新执行：node deploy/reset.js --yes');
      process.exit(2);
    }
    const go = await ask(`确认停止服务并清空数据目录吗？\n  将删除：${DATA_DIR}`);
    if (!go) { out(''); out('已取消，未做任何修改。'); out(''); process.exit(0); }
    out('');
  }

  /* ---------- 1. 停止服务 ---------- */
  step(1, total, '停止服务');
  const stillRunning = [];
  if (supervisor.active) {
    infoLine('检测到 systemd 服务 lczoj，执行 systemctl stop（避免守护进程把服务重新拉起）');
    if (CHECK_ONLY) infoLine('（--check 模式，跳过执行）');
    else {
      let r = run('systemctl', ['stop', 'lczoj'], { timeout: 120000 });
      if (r.code !== 0 && !isRoot()) r = run('sudo', ['-n', 'systemctl', 'stop', 'lczoj'], { timeout: 120000 });
      if (r.code === 0) okLine('systemd 服务已停止');
      else {
        warnLine('systemctl stop 失败：' + (r.out.split('\n')[0] || '未知原因'));
        infoLine('请在服务器上执行：sudo systemctl stop lczoj，然后重新运行本脚本');
        stillRunning.push('systemd 服务 lczoj');
      }
    }
  }
  if (pm2) {
    infoLine('检测到 PM2 应用 lczoj，执行 pm2 stop');
    if (!CHECK_ONLY) {
      const r = run('pm2', ['stop', 'lczoj'], { timeout: 60000 });
      if (r.code === 0) okLine('PM2 应用已停止（清空后可用 pm2 restart lczoj 恢复）');
      else warnLine('pm2 stop 失败：' + (r.out.split('\n')[0] || '未知原因'));
    }
  }
  if (alive(pidFromFile)) {
    infoLine(`检测到 deploy/panel.pid（PID ${pidFromFile}）`);
    if (!CHECK_ONLY) await killPid(pidFromFile, 'panel.pid');
  }
  for (const pid of owners) {
    if (CHECK_ONLY) { infoLine(`将结束监听端口 ${PORT} 的进程 PID ${pid}`); continue; }
    await killPid(pid, `监听端口 ${PORT}`);
  }
  // 其它残留进程（命令行里直接跑 server.js）：默认不动，避免误杀同机其它实例
  const extraStrays = strays.filter((pid) => pid !== pidFromFile && !owners.includes(pid));
  if (extraStrays.length) {
    if (KILL_ALL) {
      for (const pid of extraStrays) {
        if (CHECK_ONLY) { infoLine(`将结束疑似残留的 node server.js 进程 PID ${pid}`); continue; }
        await killPid(pid, 'node server.js 残留进程');
      }
    } else {
      infoLine(`另有 ${extraStrays.length} 个命令行含 server.js 的进程（PID ${extraStrays.join(', ')}），默认不结束；`
        + '若确认是本项目的服务，请加 --all 一并结束');
    }
  }

  if (!CHECK_ONLY) {
    const free = await portFree(PORT);
    if (free) okLine(`端口 ${PORT} 已释放`);
    else { warnLine(`端口 ${PORT} 仍被占用，清空后可能无法启动，请检查上面的提示`); stillRunning.push(`端口 ${PORT}`); }
  }

  /* ---------- 2. 清空数据目录 ---------- */
  step(2, total, '清空数据目录');
  infoLine('将删除：' + DATA_DIR);
  if (CHECK_ONLY) {
    infoLine('（--check 模式，跳过删除）');
  } else if (!dataExists) {
    infoLine('数据目录不存在，无需删除');
  } else if (stillRunning.length && !ASSUME_YES) {
    warnLine('服务未能完全停止（' + stillRunning.join('、') + '），数据文件可能被占用');
    infoLine('请先按上面的提示停止服务，再重新运行本脚本');
    process.exit(1);
  } else {
    try {
      const del = await removeDataDir(DATA_DIR);
      if (!del.ok) throw del.error || new Error('删除失败');
      okLine('数据目录已清空（数据库、题库测试数据、附件、头像、判题缓存）');
    } catch (err) {
      warnLine('删除失败：' + ((err && err.message) || err));
      infoLine('常见原因与处理：');
      infoLine('  · 权限不足：用 sudo 重新执行，或先执行 chown -R <运行用户> "' + DATA_DIR + '"');
      infoLine('  · 文件被占用：确认服务已停止（node deploy/check-env.js 可查看端口占用），'
        + '若服务由面板 / 宝塔 Node 项目托管，请先在面板中停止该项目');
      process.exit(1);
    }
  }
  if (!CHECK_ONLY) {
    try { if (fs.existsSync(PID_FILE)) { fs.unlinkSync(PID_FILE); infoLine('已清理 deploy/panel.pid'); } } catch { /* ignore */ }
    if (CLEAR_LOGS) {
      try {
        if (fs.existsSync(LOG_DIR)) {
          for (const f of fs.readdirSync(LOG_DIR)) {
            if (/\.log$/i.test(f)) fs.unlinkSync(path.join(LOG_DIR, f));
          }
          infoLine('已清空 logs/ 下的日志文件');
        }
      } catch { /* ignore */ }
    }
  }

  /* ---------- 3. 重新启动（可选） ---------- */
  if (MODE === 'stop') {
    step(3, total, '跳过启动');
    infoLine('如需立即重新启动：node deploy/reset.js --start（前台）或 --daemon（后台）');
    infoLine('systemd 部署：sudo systemctl start lczoj　PM2 部署：pm2 restart lczoj');
  } else if (CHECK_ONLY) {
    step(3, total, MODE === 'start' ? '将前台启动服务' : '将后台启动服务');
    infoLine('（--check 模式，跳过启动）');
  } else {
    step(3, total, MODE === 'start' ? '前台启动服务' : '后台启动服务');
    if (supervisor.exists) {
      infoLine('检测到 systemd 服务 lczoj，按 systemd 方式启动');
      let r = run('systemctl', ['start', 'lczoj'], { timeout: 120000 });
      if (r.code !== 0 && !isRoot()) r = run('sudo', ['-n', 'systemctl', 'start', 'lczoj'], { timeout: 120000 });
      if (r.code === 0) okLine('systemd 服务已启动');
      else {
        warnLine('systemctl start 失败：' + (r.out.split('\n')[0] || '未知原因'));
        infoLine('请手动执行：sudo systemctl start lczoj');
      }
    } else if (pm2) {
      infoLine('检测到 PM2 应用 lczoj，按 PM2 方式启动');
      const r = run('pm2', ['restart', 'lczoj', '--update-env'], { timeout: 120000 });
      if (r.code === 0) okLine('PM2 应用已启动');
      else warnLine('pm2 restart 失败：' + (r.out.split('\n')[0] || '未知原因'));
    } else if (MODE === 'daemon') {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const logFd = fs.openSync(LOG_FILE, 'a');
      const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, PORT: String(PORT) },
      });
      child.unref();
      fs.writeFileSync(PID_FILE, String(child.pid));
      okLine(`已后台启动（PID ${child.pid}，日志 logs/lczoj.log）`);
    } else {
      out('');
      out('============================================================');
      out(`  正在前台启动（端口 ${PORT}，按 Ctrl+C 停止）`);
      out('============================================================');
      const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });
      child.on('exit', (code) => process.exit(code == null ? 0 : code));
      return;
    }

    /* ---------- 4. 等待就绪 ---------- */
    step(4, total, '等待服务就绪');
    const health = await waitHealthy(PORT);
    if (health) {
      okLine(`服务已就绪：版本 v${health.version}，可用评测语言 ${(health.languages || []).length} 种`);
      out(`  访问地址：http://localhost${PORT === 80 ? '' : ':' + PORT}/`);
    } else {
      warnLine(`等待 45 秒仍未就绪，请查看日志：logs/lczoj.log`);
      process.exit(1);
    }
  }

  out('');
  out('============================================================');
  if (CHECK_ONLY) {
    out('  检查完成（--check 模式，未做任何修改）');
    out(`  执行请去掉 --check：node deploy/reset.js${MODE === 'stop' ? '' : ' --' + MODE} --yes`);
  } else {
    out('  恢复完成。管理员账号：admin');
    out('  初始密码：下次启动时随机生成，启动日志会显示，并写入 data/admin-password.txt');
    out('  首次启动会自动重建数据库与 3 道示例题（A+B Problem、SPJ 测试题、提交答案测试题）');
  }
  out('============================================================');
  out('');
  process.exit(0);
})().catch((err) => {
  console.error('[reset] 执行异常：' + ((err && err.stack) || err));
  process.exit(1);
});
