#!/usr/bin/env node
'use strict';
/**
 * 重启助手：等旧服务进程退出后，用相同参数把新进程拉起来。
 *
 * 由 src/updater.js 在「没有 PM2 / systemd 守护」的情况下自动调用（后台运行，不占终端）：
 *   node deploy/restart-helper.js --pid <更新进程号> --port <端口> --host <监听地址> --cwd <项目目录> [--kill <旧服务进程号>]
 *
 * 工作流程：
 *   0) 若给了 --kill（命令行更新时，真正占着端口的是另一个 node server.js 进程），先结束它
 *   1) 轮询等待旧进程退出（最多 60 秒）
 *   2) 确认端口已释放（最多再等 30 秒）
 *   3) 后台启动 `node server.js`，日志追加到 logs/lczoj.log
 *   4) 若项目里存在 deploy/panel.pid（面板脚本启动的服务），把新进程号写回去
 *   5) 自身退出（失败时退出码非 0，并把原因写进 logs/lczoj.log —— 调用方已把本进程的输出重定向到该日志）
 *
 * 说明：PM2 / systemd 守护的场景不会走这里（由它们自己负责重启）。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
function argValue(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const oldPid = parseInt(argValue('--pid', '0'), 10);
const killPid = parseInt(argValue('--kill', '0'), 10);
const port = parseInt(argValue('--port', String(process.env.PORT || 80)), 10);
const host = argValue('--host', process.env.OJ_HOST || '0.0.0.0');
const cwd = argValue('--cwd', path.join(__dirname, '..'));
const LOG_FILE = path.join(cwd, 'logs', 'lczoj.log');
const PID_FILE = path.join(cwd, 'deploy', 'panel.pid');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 结束旧的监听进程。只在调用方（src/updater.js）已确认它是本项目的 node server.js 时才会走到这里。 */
function stopOldServer(pid) {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
  if (!alive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[restart-helper] 已向旧服务进程 ${pid} 发送 SIGTERM（Windows 上为直接结束该进程）`);
  } catch (e) {
    console.error(`[restart-helper] 结束旧服务进程 ${pid} 失败：${(e && e.message) || e}`);
  }
}

function portFree() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, host); } catch { resolve(false); }
  });
}

(async () => {
  // 0) 命令行更新场景：先结束真正占着端口的旧服务进程
  stopOldServer(killPid);

  // 1) 等旧进程退出
  const t0 = Date.now();
  while (alive(oldPid) && Date.now() - t0 < 60000) await sleep(300);

  // 2) 等端口释放（旧服务进程可能还需要一点时间退出）
  const t1 = Date.now();
  while (!(await portFree()) && Date.now() - t1 < 30000) await sleep(300);
  if (!(await portFree())) {
    console.error(`[restart-helper] 端口 ${port} 在 30 秒内仍未释放（可能被其它进程占用），未启动新进程；请手动重启服务`);
    process.exit(1);
  }

  // 3) 启动新进程（若新进程立刻退出，说明端口仍被占用或启动报错，最多重试 3 次）
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch { /* ignore */ }
  let stdio = 'ignore';
  try { stdio = ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')]; } catch { /* ignore */ }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const child = spawn(process.execPath, ['server.js'], {
      cwd,
      detached: true,
      stdio,
      env: { ...process.env, PORT: String(port), OJ_HOST: host },
    });
    const diedQuickly = await new Promise((resolve) => {
      let settled = false;
      child.once('exit', (code) => { if (!settled) { settled = true; resolve(code === 0 ? false : true); } });
      setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 2500);
    });
    if (!diedQuickly) {
      child.unref();
      // 4) 面板脚本启动的场景：把新进程号写回 deploy/panel.pid
      try { if (fs.existsSync(PID_FILE)) fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* ignore */ }
      console.log(`[restart-helper] 旧进程 ${oldPid} 已退出，新进程 ${child.pid} 已启动（端口 ${port}）`);
      process.exit(0);
    }
    console.log(`[restart-helper] 第 ${attempt} 次启动失败，2 秒后重试`);
    await sleep(2000);
  }

  console.error('[restart-helper] 新进程多次启动失败，请查看 logs/lczoj.log');
  process.exit(1);
})();
