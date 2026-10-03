#!/usr/bin/env node
'use strict';
/**
 * LCZOJ 命令行一键更新（与「管理后台 → 系统设置 → 版本更新」共用同一套逻辑 src/updater.js）
 *
 *   node deploy/update.js             # 检查 + 更新 + 重启（更新前自动备份数据库）
 *   node deploy/update.js --check     # 只检查有没有新版本，不做任何修改
 *   node deploy/update.js --yes       # 不询问，直接更新
 *   node deploy/update.js --no-backup # 跳过数据库备份
 *   node deploy/update.js --no-restart# 只更新代码，不自动重启（之后手动重启）
 *   node deploy/update.js --force     # 已是最新版本时也强制重新拉取并覆盖代码
 *   node deploy/update.js --docker    # Docker 部署：重新构建镜像 + 重建容器（数据卷保留）
 *
 * 更新内容：程序代码文件。数据目录（数据库、题库测试数据、附件、头像）不会被改动。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const isWin = process.platform === 'win32';
const CONTAINER = 'lczoj';
const VOLUME = 'lczoj-data';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);

if (has('--help') || has('-h')) {
  console.log(`
LCZOJ 一键更新

  node deploy/update.js              检查 + 更新 + 重启（更新前自动备份数据库）
  node deploy/update.js --check      只检查有没有新版本
  node deploy/update.js --yes        不询问，直接更新
  node deploy/update.js --no-backup  跳过数据库备份
  node deploy/update.js --no-restart 只更新代码，不重启（之后手动重启）
  node deploy/update.js --force      已是最新版本时也强制重新拉取代码
  node deploy/update.js --docker     Docker 部署：重新构建镜像并重建容器
  node deploy/update.js --help       显示本帮助

  说明：更新只覆盖程序代码；数据目录（数据库、题库测试数据、附件、头像）不受影响。
       管理后台 → 系统设置 → 版本更新 里也能完成同样的操作。
`);
  process.exit(0);
}

const out = (s = '') => console.log(s);
const okLine = (s) => out('   [完成] ' + s);
const warnLine = (s) => out('   [注意] ' + s);
const infoLine = (s) => out('   [信息] ' + s);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    timeout: opts.timeout || 1800000,
    windowsHide: true,
    stdio: opts.inherit ? 'inherit' : 'pipe',
  });
  return { code: r.status == null ? 1 : r.status, out: String((r.stdout || '') + (r.stderr || '')).trim() };
}
const hasCmd = (cmd) => run(isWin ? 'where' : 'which', [cmd]).code === 0;

function currentVersion() {
  try { return require('../package.json').version; } catch { return '未知'; }
}

function readEnvFile() {
  const f = path.join(ROOT, 'deploy', 'panel.env');
  const env = {};
  if (!fs.existsSync(f)) return env;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function ask(question) {
  if (has('--yes')) return Promise.resolve(true);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + ' [Y/n] ', (a) => { rl.close(); resolve(!/^n/i.test(String(a).trim())); });
  });
}

function dockerRunning() {
  if (!hasCmd('docker')) return false;
  return run('docker', ['ps', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.Names}}']).out.trim() === CONTAINER;
}

/* ------------------------- Docker 方式的更新 ------------------------- */
async function updateDocker() {
  out('');
  out('【Docker 更新】重新构建镜像 + 重建容器（数据卷 ' + VOLUME + ' 不受影响）');
  const env = readEnvFile();
  const hostPort = process.env.OJ_HTTP_PORT || env.OJ_HTTP_PORT || '80';
  const judges = env.OJ_MAX_JUDGES || String(Math.max(2, Math.min(4, (os.cpus() || []).length - 1 || 2)));
  const image = `lczoj:${currentVersion()}`;

  infoLine('构建镜像 ' + image + '（约 1~5 分钟）');
  if (run('docker', ['build', '-t', image, '.'], { inherit: true }).code !== 0) return { error: '镜像构建失败' };

  infoLine('重建容器（数据卷保留）');
  run('docker', ['rm', '-f', CONTAINER], { inherit: true });
  const r = run('docker', [
    'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped',
    '-p', `${hostPort}:80`, '-v', `${VOLUME}:/app/data`,
    '-e', `OJ_MAX_JUDGES=${judges}`, '-e', `TZ=${env.TZ || 'Asia/Shanghai'}`,
    image,
  ], { inherit: true });
  if (r.code !== 0) return { error: '容器启动失败' };

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const h = await res.json();
        return { ok: true, version: h.version, hostPort };
      }
    } catch { /* 还没起来 */ }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  return { error: '容器已启动但健康检查未通过，请查看 docker logs ' + CONTAINER };
}

/* ------------------------------- 主流程 ------------------------------- */
(async () => {
  out('');
  out('============================================================');
  out('  LCZOJ 一键更新');
  out('============================================================');

  const updater = require('../src/updater');
  const before = currentVersion();
  infoLine('项目目录：' + ROOT);
  infoLine('数据目录：' + updater.DATA_DIR);
  infoLine('当前版本：v' + before);

  /* 1. 检查更新 */
  out('');
  out('【1/4】检查最新版本');
  const v = await updater.check({ force: true });
  if (v.error) {
    warnLine(v.error);
    if (has('--check')) { out(''); process.exit(0); }
    infoLine('继续执行：将直接尝试从官方源获取最新代码');
  } else {
    infoLine(`官方最新版本：v${v.latest}（来源：${v.source}）`);
    if (!v.has_update) {
      okLine(`当前已是最新版本 v${before}`);
      if (!has('--force')) { out(''); process.exit(0); }
      warnLine('已指定 --force，继续强制重新拉取代码');
    } else {
      okLine(`发现新版本：v${before} → v${v.latest}`);
    }
  }
  if (has('--check')) { out(''); process.exit(0); }

  /* 2. Docker 方式 */
  const dockerMode = has('--docker') || dockerRunning();
  if (dockerMode) {
    const r = await updateDocker();
    if (r.error) { warnLine(r.error); process.exit(1); }
    okLine(`Docker 更新完成：当前运行 v${r.version}（http://服务器IP${r.hostPort === 80 ? '' : ':' + r.hostPort}/）`);
    out('');
    process.exit(0);
  }

  infoLine('更新方式：' + (fs.existsSync(path.join(ROOT, '.git')) ? 'git pull（源码仓库）' : '源码包覆盖（非 git 安装）'));
  infoLine('服务启动方式：' + updater.detectSupervisor());
  if (!has('--yes')) {
    const go = await ask('现在开始更新吗？（更新只覆盖程序代码，数据不受影响）');
    if (!go) { infoLine('已取消'); out(''); process.exit(0); }
  }

  /* 3~4. 备份 / 更新 / 重启：交给共用引擎，实时打印它的日志 */
  out('');
  out('【2/4】备份数据库');
  out('【3/4】更新程序代码');
  out('【4/4】重启服务');
  const res = await updater.start({
    backup: !has('--no-backup'),
    restart: !has('--no-restart'),
    force: has('--force'),
  });
  // 引擎的日志已经在 console 中以 [update] 前缀输出，这里再补充结论
  out('');
  const st = updater.getState();
  if (res.error) {
    warnLine(res.error);
    process.exit(1);
  }
  if (res.upToDate) {
    okLine(`当前已是最新版本 v${st.current}`);
    process.exit(0);
  }
  okLine(`版本：v${st.before} → v${st.after || st.current}`);
  if (res.restartRequired) {
    warnLine('代码已更新，请手动重启服务：node server.js / 面板里重启 Node 项目 / pm2 restart lczoj');
  } else {
    okLine('服务已按新版本重启（如未使用 PM2 / systemd，会由 deploy/restart-helper.js 拉起新进程）');
    infoLine('确认运行状态：查看日志 logs/lczoj.log，或访问 /api/health');
  }
  out('');
})();
