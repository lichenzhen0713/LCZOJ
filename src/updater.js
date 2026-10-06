'use strict';
/**
 * 版本更新引擎（供「管理后台 → 系统设置 → 版本更新」与 `node deploy/update.js` 共用）
 *
 * 能力：
 *   1) 查询官方最新版本（复用 src/version.js，GitHub 失败自动回退 Gitee）
 *   2) 备份数据库 data/oj.db 到 data/backup/
 *   3) 更新代码：git 仓库走 git pull，否则下载官方源码包并**只覆盖代码文件**
 *      —— data/、logs/、.git、node_modules/、deploy/panel.env 一律不动
 *   4) 重启服务：优先交给进程守护（PM2 / systemd），否则由 deploy/restart-helper.js 拉起新进程
 *   5) 全过程记录日志与阶段，前端可轮询查看进度
 *
 * 说明：更新只会覆盖程序文件，站点数据（数据库、题库测试数据、附件、头像）保存在 data/ 中，不受影响。
 * 可用环境变量覆盖下载源（内网镜像 / 自建源 / 测试）：
 *   OJ_UPDATE_URL      版本号检查地址（返回 package.json 的 JSON）
 *   OJ_UPDATE_ZIP_URL  源码包地址（zip）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('node:child_process');
const { parseZip } = require('./zip');
const { CURRENT, checkLatest, compareVersion } = require('./version');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.OJ_DATA_DIR ? path.resolve(ROOT, process.env.OJ_DATA_DIR) : path.join(ROOT, 'data');
const PANEL_ENV = path.join(ROOT, 'deploy', 'panel.env');
const PID_FILE = path.join(ROOT, 'deploy', 'panel.pid');
const LOG_FILE = path.join(ROOT, 'logs', 'lczoj.log');

/** 更新时绝对不覆盖的目录 / 文件 */
const KEEP_TOP = new Set(['data', 'logs', '.git', 'node_modules']);
const KEEP_REL = new Set(['deploy/panel.env']);

/**
 * 源码包来源：默认 **Gitee 优先**（国内网络可达性更好），GitHub 作为备用。
 * 可用环境变量 OJ_UPDATE_ZIP_URL 覆盖（多个地址用英文逗号分隔，按顺序尝试）。
 */
const ZIP_SOURCES = [
  { label: 'Gitee（默认）', url: 'https://gitee.com/lichenzhen0713/LCZOJ/repository/archive/master.zip' },
  { label: 'GitHub（备用）', url: 'https://github.com/lichenzhen0713/LCZOJ/archive/refs/heads/master.zip' },
];

/* ------------------------------ 运行状态 ------------------------------ */
const state = {
  running: false,
  phase: 'idle',        // idle | checking | backing-up | downloading | applying | restarting | done | error
  message: '',
  log: [],
  before: CURRENT,
  after: '',
  restarted: false,
  error: '',
  startedAt: 0,
  finishedAt: 0,
  // 更新包完整性校验结果（M14）：verified=false 表示本次更新包**未经校验**
  integrity: null,
};

function logLine(text) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${text}`;
  state.log.push(line);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  console.log('[update] ' + text);
}

function setPhase(phase, message) {
  state.phase = phase;
  state.message = message || '';
  if (message) logLine(message);
}

/** 是否运行在 Docker 容器中（容器内更新只对当前容器有效，重建容器会被镜像覆盖） */
function inDocker() {
  if (String(process.env.OJ_IN_DOCKER || '') === '1') return true;
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

/**
 * Docker 部署下的更新指引（容器内的 /app 由 root 拥有，且重建容器会回到镜像里的版本，
 * 因此容器内**不支持**覆盖代码；必须在宿主机上重建镜像 / 重建容器）。
 */
function dockerHint() {
  return {
    title: 'Docker 部署请在宿主机更新',
    reason: '容器内的代码来自镜像（/app 属主 root，进程以 node 运行），容器内改不动、重建也会丢；在宿主机执行下面一行即可。',
    commands: [
      'node deploy/docker-onekey.js --rebuild     # 最简单：自动拉取新版本 + 重建镜像 + 重启容器',
      'docker compose pull && docker compose up -d  # 只想换官方镜像、不重建时用这行',
    ],
    dataSafe: '数据库、题库测试数据、附件、头像都在数据卷（默认 lczoj-data）里，重建容器不会丢失。',
  };
}

/** 数据目录的展示用路径（L14）：对外不回显绝对路径，只回相对项目根目录的路径 */
function dataDirDisplay() {
  const rel = path.relative(ROOT, DATA_DIR).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : '.';
}

function getState() {
  return {
    ...state,
    current: CURRENT,
    log: state.log.slice(-120),
    // L14：绝对路径属于部署指纹，不回显；只给出相对路径（与项目根目录的关系）
    data_dir: dataDirDisplay(),
    data_dir_is_default: path.resolve(DATA_DIR) === path.resolve(path.join(ROOT, 'data')),
    supervisor: detectSupervisor(),
    in_docker: inDocker(),
    docker_hint: inDocker() ? dockerHint() : null,
  };
}

/* ------------------------------ 辅助 ------------------------------ */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 600000,
    windowsHide: true,
  });
  return { code: r.status == null ? 1 : r.status, out: String((r.stdout || '') + (r.stderr || '')).trim() };
}

function hasCmd(cmd) {
  return run(process.platform === 'win32' ? 'where' : 'which', [cmd]).code === 0;
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * 纯函数：根据探测结果决定重启方式（便于单元测试）。
 * @param {{pid:number, isRoot:boolean,
 *          pm2?:{managed:boolean,pid:number},
 *          systemd?:{unitExists:boolean,active:boolean,mainPid:number,restartPolicy?:string},
 *          pidfile?:boolean, hasHelper?:boolean}} p
 * @returns {{how:'pm2'|'systemd'|'systemd-exit'|'pidfile'|'helper', needsSudo?:boolean, reason:string}}
 */
function decideRestart(p) {
  // PM2：必须是「当前进程就是这个 PM2 应用」，否则说明服务是别的方式启动的
  if (p.pm2 && p.pm2.managed && p.pm2.pid === p.pid) {
    return { how: 'pm2', reason: '当前进程由 PM2 应用 lczoj 托管' };
  }
  // systemd：单元处于激活状态，且当前进程就是该单元的主进程
  if (p.systemd && p.systemd.unitExists && p.systemd.active) {
    if (!p.systemd.mainPid || p.systemd.mainPid === p.pid) {
      const policy = String(p.systemd.restartPolicy || '').trim();
      // 单元配置了自动重启（Restart=always / on-failure 等）时，即使没有 root 权限，
      // 也可以直接退出进程让 systemd 把它拉起来，无需 sudo
      const autoByPolicy = /^(always|on-failure|on-abnormal|on-abort|on-watchdog)$/.test(policy);
      if (!p.isRoot && autoByPolicy) {
        return { how: 'systemd-exit', autoByPolicy: true, restartPolicy: policy, reason: `systemd 服务 lczoj 托管（Restart=${policy}），由 systemd 自动拉起` };
      }
      return { how: 'systemd', needsSudo: !p.isRoot, restartPolicy: policy, reason: '当前进程由 systemd 服务 lczoj 托管' };
    }
    // 单元在跑，但主进程不是我们（例如手工启动了一个实例）→ 不能交给 systemd 重启
  }
  if (p.pidfile) return { how: 'pidfile', reason: '检测到 deploy/panel.pid（面板脚本后台启动）' };
  return { how: 'helper', reason: '未检测到进程守护，使用重启助手拉起新进程' };
}

/** 收集探测信息（真实环境） */
function gatherProbe() {
  const info = { pid: process.pid, isRoot: isRoot(), pidfile: fs.existsSync(PID_FILE), hasHelper: fs.existsSync(path.join(ROOT, 'deploy', 'restart-helper.js')) };

  if (hasCmd('pm2')) {
    const j = run('pm2', ['jlist']);
    if (j.out.includes('lczoj')) {
      let appPid = 0;
      try {
        const arr = JSON.parse(j.out);
        const app = Array.isArray(arr) ? arr.find((a) => a && a.name === 'lczoj') : null;
        appPid = app && app.pid ? app.pid : 0;
      } catch { appPid = 0; }
      info.pm2 = { managed: true, pid: appPid };
    } else {
      info.pm2 = { managed: false, pid: 0 };
    }
  }

  if (process.platform !== 'win32' && hasCmd('systemctl')) {
    const unitExists = run('systemctl', ['list-unit-files', 'lczoj.service']).out.includes('lczoj.service');
    let active = false;
    let mainPid = 0;
    let restartPolicy = '';
    if (unitExists) {
      active = run('systemctl', ['is-active', 'lczoj']).out.trim() === 'active';
      const pidOut = run('systemctl', ['show', '-p', 'MainPID', '--value', 'lczoj']).out.trim();
      mainPid = parseInt(pidOut, 10) || 0;
      restartPolicy = run('systemctl', ['show', '-p', 'Restart', '--value', 'lczoj']).out.trim();
    }
    info.systemd = { unitExists, active, mainPid, restartPolicy };
  }
  return info;
}

/** 当前服务的启动方式（供界面展示）：pm2 / systemd / pidfile / none */
function detectSupervisor() {
  const d = decideRestart(gatherProbe());
  if (d.how === 'helper') return 'none';
  if (d.how === 'systemd-exit') return 'systemd';
  return d.how;
}

/* ------------------------------ 1) 检查更新 ------------------------------ */
async function check({ force = true } = {}) {
  return checkLatest({ force });
}

/* ------------------------------ 2) 备份数据库 ------------------------------ */
function backupDatabase() {
  const dbFile = path.join(DATA_DIR, 'oj.db');
  if (!fs.existsSync(dbFile)) return { skipped: true, reason: '数据目录里还没有 oj.db（首次部署无需备份）' };
  const dir = path.join(DATA_DIR, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dest = path.join(dir, `oj-${CURRENT}-${stamp}.db`);
  fs.copyFileSync(dbFile, dest);
  // 顺带清理：只保留最近 10 份备份
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
    while (files.length > 10) {
      const old = files.shift();
      fs.unlinkSync(path.join(dir, old));
    }
  } catch { /* ignore */ }
  return { file: dest, rel: path.relative(ROOT, dest) };
}

/* ------------------------------ 源码包完整性校验（M14） ------------------------------ */
/**
 * 期望的源码包 sha256：环境变量 OJ_UPDATE_SHA256，可写多个可接受值（逗号/分号/空格分隔），
 * 允许 `sha256:` 前缀与大写。配置了就**必须**匹配，否则拒绝应用。
 */
function expectedUpdateHashes() {
  return String(process.env.OJ_UPDATE_SHA256 || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^sha256:/i, '').toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验源码包完整性（**可校验**，而不是只查冲突标记/语法）：
 *   · 配置了 OJ_UPDATE_SHA256 → 哈希必须命中，否则抛错并拒绝应用；
 *   · 未配置 → 打印显著警告，并把「本次更新包未经校验」写进更新日志与状态（不谎称已做安全校验）。
 */
function verifySourceBuffer(buf) {
  const actual = sha256Hex(buf);
  const expected = expectedUpdateHashes();
  if (!expected.length) {
    logLine('⚠⚠ 安全警告：未配置 OJ_UPDATE_SHA256，无法校验源码包完整性——本次更新包【未经校验】，请自行确认下载来源可信。');
    logLine('   建议：设置环境变量 OJ_UPDATE_SHA256=<官方源码包的 sha256> 后重启服务，此后哈希不匹配的包会被直接拒绝。');
    state.integrity = { verified: false, unverified: true, sha256: actual, expected: '', source_count: 1 };
    return state.integrity;
  }
  if (!expected.includes(actual)) {
    const err = new Error(`源码包完整性校验失败：下载文件的 sha256 为 ${actual}，与 OJ_UPDATE_SHA256（${expected.join('、')}）不一致，已拒绝应用（未修改任何文件）。`);
    err.code = 'UPDATE_HASH_MISMATCH';
    err.sha256 = actual;
    state.integrity = { verified: false, unverified: false, sha256: actual, expected: expected.join('、'), mismatch: true };
    throw err;
  }
  logLine(`源码包 sha256 校验通过：${actual}`);
  state.integrity = { verified: true, unverified: false, sha256: actual, expected: expected.join('、') };
  return state.integrity;
}

/* ------------------------------ 3) 更新代码 ------------------------------ */
function downloadSource() {
  const custom = String(process.env.OJ_UPDATE_ZIP_URL || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const list = custom.length
    ? custom.map((url) => ({ label: '自定义源', url }))
    : ZIP_SOURCES;
  return (async () => {
    const tried = [];
    for (const src of list) {
      try {
        logLine(`下载源码包（${src.label}）：${src.url}`);
        const res = await fetch(src.url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
        if (!res.ok) { logLine(`下载失败（HTTP ${res.status}）`); tried.push(`${src.label} HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        logLine(`下载完成：${(buf.length / 1024 / 1024).toFixed(2)} MB（${src.label}）`);
        // M14：先校验完整性，再交给 applyZip（哈希不匹配直接抛错终止本次更新）
        const integrity = verifySourceBuffer(buf);
        return { buf, from: src.url, label: src.label, integrity };
      } catch (err) {
        if (err && err.code === 'UPDATE_HASH_MISMATCH') throw err; // 完整性失败必须中止，不再尝试其它源
        const msg = (err && err.name === 'TimeoutError') ? '连接超时' : ((err && err.message) || String(err));
        logLine(`下载失败（${src.label}）：${msg}`);
        tried.push(`${src.label} ${msg}`);
      }
    }
    return {
      error: '无法下载源码包（已尝试的源：' + tried.join('；') + '）。'
        + '可在环境变量 OJ_UPDATE_ZIP_URL 中指定可用的镜像地址，或手动下载源码包覆盖代码（保留 data 目录）。',
    };
  })();
}

/**
 * 更新包预检：**先校验、后写入**，避免把损坏的源码包覆盖到正在运行的站点上。
 * 校验内容：
 *   1) 代码/文本文件中不能残留 Git 合并冲突标记（<<<<<<< / ======= / >>>>>>>）
 *   2) package.json 必须是合法 JSON
 *   3) server.js 必须能通过语法编译（vm 编译但不执行）
 * @returns {{errors: string[], markers: Array<{file:string, line:number}>}}
 */
function validateEntries(entries) {
  const vm = require('node:vm');
  const TEXT_EXT = /\.(js|mjs|cjs|json|md|html|css|sh|bat|ps1|yml|yaml|txt|conf|service)$/i;
  const errors = [];
  const markers = [];

  for (const e of entries) {
    const name = String(e.name || '');
    if (!name || name.endsWith('/') || !TEXT_EXT.test(name)) continue;
    const text = Buffer.isBuffer(e.data) ? e.data.toString('utf8') : String(e.data || '');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^<{7}( |>)/.test(lines[i]) || /^={7}$/.test(lines[i]) || /^>{7}( |>)/.test(lines[i])) {
        markers.push({ file: name, line: i + 1, text: lines[i].slice(0, 60) });
      }
    }
  }
  if (markers.length) {
    const byFile = {};
    for (const m of markers) byFile[m.file] = (byFile[m.file] || 0) + 1;
    const list = Object.entries(byFile).map(([f, n]) => `${f}（${n} 处）`).join('、');
    errors.push(`源码包中仍有未解决的合并冲突标记：${list}`);
  }

  const pkg = entries.find((e) => String(e.name).endsWith('/package.json') || String(e.name) === 'package.json');
  if (pkg) {
    try { JSON.parse(Buffer.isBuffer(pkg.data) ? pkg.data.toString('utf8') : String(pkg.data)); }
    catch (err) { errors.push('package.json 不是合法 JSON：' + ((err && err.message) || err)); }
  }

  const srv = entries.find((e) => String(e.name).endsWith('/server.js') || String(e.name) === 'server.js');
  if (srv) {
    try {
      const src = Buffer.isBuffer(srv.data) ? srv.data.toString('utf8') : String(srv.data);
      new vm.Script(src, { filename: 'server.js' });
    } catch (err) {
      errors.push('server.js 语法检查未通过：' + ((err && err.message) || err));
    }
  }

  return { errors, markers };
}

/** 把源码包里的代码文件写入项目目录（跳过数据与本地配置）
 *  **先整体检查，通过后才写入**；检查失败时不修改任何文件。
 *  注意：这里只做「内容可用性」检查（冲突标记 / JSON 合法性 / server.js 语法），
 *  **不是安全校验**——源码包完整性由 verifySourceBuffer()（OJ_UPDATE_SHA256）负责（M14）。 */
function applyZip(buf) {
  const entries = parseZip(buf);
  const check = validateEntries(entries);
  if (check.errors.length) {
    const err = new Error('源码包内容检查未通过，已中止更新（未修改任何文件）：' + check.errors.join('；')
      + '。请先在代码仓库中修复后再执行更新。');
    err.validation = check;
    throw err;
  }

  const prefix = entries.length ? String(entries[0].name).split('/')[0] + '/' : '';
  const skipped = new Set();
  const written = [];
  const plan = [];
  for (const e of entries) {
    const name = String(e.name || '');
    if (!name || name.endsWith('/')) continue;
    if (!name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (!rel) continue;
    const top = rel.split('/')[0];
    if (KEEP_TOP.has(top) || KEEP_REL.has(rel)) { skipped.add(KEEP_TOP.has(top) ? top : rel); continue; }
    const dest = path.resolve(ROOT, rel);
    if (!dest.startsWith(ROOT + path.sep)) continue;   // 防路径穿越
    plan.push({ rel, dest, data: e.data });
  }
  if (!plan.length) throw new Error('源码包里没有可用的代码文件');

  // 覆盖前先确认所有目标目录可写：避免写到一半才发现无权限（Docker 容器内 /app 属主为 root、普通用户不可写）
  assertWritableDirs([...new Set(plan.map((p) => path.dirname(p.dest)))]);

  const failed = [];
  for (const p of plan) {
    try {
      fs.mkdirSync(path.dirname(p.dest), { recursive: true });
      fs.writeFileSync(p.dest, p.data);
      written.push(p.rel);
    } catch (err) {
      failed.push({ rel: p.rel, code: (err && err.code) || 'ERROR', message: (err && err.message) || String(err) });
    }
  }
  if (failed.length) {
    const perm = failed.filter((f) => /EACCES|EPERM|EROFS/.test(f.code));
    if (perm.length) {
      const err = new Error('无写入权限：有 ' + perm.length + ' 个文件无法写入（例如 ' + perm.slice(0, 3).map((f) => f.rel).join('、') + '）。'
        + (inDocker()
          ? '容器内的 /app 由 root 拥有，Docker 部署请在宿主机执行 node deploy/docker-onekey.js --rebuild（或 docker compose up -d --build）来更新。'
          : '请把项目目录属主改为服务运行用户后重试（例如：chown -R <运行用户>:<运行用户> ' + ROOT + '）。'));
      err.code = perm[0].code;
      err.failed = failed;
      err.partial = written.length;
      throw err;
    }
    const err = new Error('覆盖代码失败（' + failed.length + ' 个文件）：' + failed.slice(0, 3).map((f) => f.rel + '（' + f.message + '）').join('；'));
    err.failed = failed;
    err.partial = written.length;
    throw err;
  }
  return { written, skipped: [...skipped], validated: true };
}

/**
 * 覆盖代码前检查目标目录是否可写（写一个探针文件再删掉）。
 * 任一目录不可写即抛出带指引的错误——避免更新写到一半失败、留下半新半旧的代码。
 */
function assertWritableDirs(dirs) {
  const bad = [];
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      const probe = path.join(d, '.lczoj-write-test-' + process.pid);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch {
      bad.push(path.relative(ROOT, d) || '.');
    }
  }
  if (bad.length) {
    const shown = bad.slice(0, 5).join('、') + (bad.length > 5 ? ' 等 ' + bad.length + ' 个目录' : '');
    const err = new Error('无写入权限：无法覆盖程序代码（不可写目录：' + shown + '）。'
      + (inDocker()
        ? '容器内的 /app 由 root 拥有、服务以普通用户 node 运行，因此 Docker 部署请在宿主机更新：'
          + 'node deploy/docker-onekey.js --rebuild 或 docker compose up -d --build（数据卷不受影响）。'
        : '请把项目目录属主改为服务运行用户后重试（例如：chown -R <运行用户>:<运行用户> ' + ROOT + '），或用 sudo 运行服务。'));
    err.code = 'EACCES';
    err.dirs = bad;
    throw err;
  }
}

async function applySourceUpdate() {
  const isGit = fs.existsSync(path.join(ROOT, '.git'));
  if (isGit && hasCmd('git')) {
    setPhase('applying', '检测到 git 仓库，执行 git pull');
    logLine('说明：git pull 路径不做源码包哈希校验（信任远端仓库与 HTTPS 传输）；如需可校验的更新，请用源码包 + OJ_UPDATE_SHA256。');
    const r = run('git', ['pull', '--ff-only']);
    if (r.code === 0) {
      logLine('git pull 完成');
      state.integrity = { verified: false, unverified: true, how: 'git', reason: 'git pull 未做哈希校验' };
      return { how: 'git', written: [] };
    }
    logLine('git pull 未成功（可能存在本地改动），改用源码包覆盖：' + (r.out || '').split('\n')[0]);
  } else {
    logLine('未检测到 git 仓库，使用源码包覆盖方式');
  }
  setPhase('downloading', '正在下载新版本代码');
  const dl = await downloadSource();
  if (dl.error) throw new Error(dl.error);
  setPhase('applying', '正在覆盖代码文件（数据目录不受影响）');
  const r = applyZip(dl.buf);
  logLine(`已覆盖 ${r.written.length} 个文件` + (r.skipped.length ? `，保留 ${r.skipped.join('、')}` : ''));
  return { how: 'zip', written: r.written, from: dl.from, integrity: dl.integrity };
}

/* ------------------------------ 4) 重启服务 ------------------------------ */
/**
 * 执行重启（可注入 runner / root / exitFn，便于测试）。
 * - systemd 场景下当前进程通常不是 root：先直接执行，失败再尝试免密 sudo；
 * - 两者都不行时，若单元配置了自动重启（Restart=always / on-failure），则**退出进程让 systemd 拉起**（无需 sudo）；
 * - 仍不可行时返回 manual（代码已更新，仅需人工执行一条命令），而不是抛错。
 */
function performRestart(decision, runner = run, root = isRoot(), exitFn = null) {
  const cmds = [];
  if (decision.how === 'pm2') {
    cmds.push(['pm2', ['restart', 'lczoj', '--update-env']]);
  } else if (decision.how === 'systemd') {
    cmds.push(['systemctl', ['restart', 'lczoj']]);
    if (!root) cmds.push(['sudo', ['-n', 'systemctl', 'restart', 'lczoj']]);
  } else if (decision.how === 'systemd-exit') {
    // 直接交给 systemd：进程以非 0 退出码结束，确保 on-failure 策略也会拉起
    return { ok: true, how: 'systemd-exit', selfExit: true, exitCode: 1, note: decision.reason };
  } else {
    return { ok: true, how: decision.how, spawnHelper: true };
  }

  const failures = [];
  for (const [cmd, args] of cmds) {
    const r = runner(cmd, args);
    if (r.code === 0) return { ok: true, how: decision.how, cmd: `${cmd} ${args.join(' ')}` };
    failures.push(`${cmd} ${args.join(' ')} → ${(r.out || '执行失败').split('\n')[0]}`);
  }

  const manualCommand = decision.how === 'pm2' ? 'pm2 restart lczoj --update-env' : 'sudo systemctl restart lczoj';
  return {
    ok: false,
    manual: true,
    how: decision.how,
    detail: failures.join('；'),
    command: manualCommand,
  };
}

function restartService(overrides = {}) {
  const probe = overrides.probe || gatherProbe();
  const decision = decideRestart(probe);
  logLine('检测到服务启动方式：' + decision.reason);

  const result = performRestart(decision, overrides.runner || run, overrides.root == null ? isRoot() : overrides.root, overrides.exit);

  if (result.selfExit) {
    logLine(`当前进程无重启权限，改为直接退出，由 systemd（Restart=${decision.restartPolicy || 'always'}）自动拉起新进程`);
    const exitFn = overrides.exit || ((code) => { try { process.exit(code); } catch { /* ignore */ } });
    setTimeout(() => exitFn(result.exitCode || 1), 1200).unref?.();
    return { how: 'systemd-exit', auto: true, note: result.note };
  }

  if (result.manual) {
    logLine('自动重启未成功：' + result.detail);
    logLine('代码已更新完成，请手动重启服务：' + result.command);
    const tip = decision.how === 'systemd'
      ? '（如需今后在管理后台自动重启，可执行一次：sudo bash deploy/grant-restart-permission.sh；'
        + '或把 systemd 单元的 Restart= 设置为 always，之后更新会自动重启）'
      : '';
    if (tip) logLine(tip);
    return { how: decision.how, manual: true, command: result.command, detail: result.detail };
  }

  if (result.spawnHelper) {
    const helper = path.join(ROOT, 'deploy', 'restart-helper.js');
    if (!fs.existsSync(helper)) {
      return { how: 'none', manual: true, command: 'node server.js', detail: '缺少 deploy/restart-helper.js' };
    }
    const child = spawn(process.execPath, [
      helper,
      '--pid', String(process.pid),
      '--port', String(require('./config').PORT),
      '--host', String(require('./config').HOST),
      '--cwd', ROOT,
    ], { detached: true, stdio: 'ignore', cwd: ROOT, env: process.env });
    child.unref();
    return { how: result.how, helperPid: child.pid };
  }

  logLine('重启命令执行成功：' + result.cmd);
  return { how: result.how, cmd: result.cmd };
}

/* ------------------------------ 主流程 ------------------------------ */
/**
 * 执行一次更新。
 * @param {{backup?:boolean, restart?:boolean, target?:string}} opts
 * @returns {Promise<{ok?:boolean, error?:string}>}
 */
async function start(opts = {}) {
  if (state.running) return { error: '已有更新任务正在进行中' };
  const backup = opts.backup !== false;
  const restart = opts.restart !== false;

  state.running = true;
  state.error = '';
  state.log = [];
  state.after = '';
  state.restarted = false;
  state.startedAt = Date.now();
  state.finishedAt = 0;

  try {
    setPhase('checking', '检查最新版本');
    // Docker：容器内的 /app 由 root 拥有且重建容器会回到镜像版本，因此直接给出明确指引，不再尝试写入
    if (inDocker() && opts.allowDocker !== true) {
      const hint = dockerHint();
      logLine('检测到当前运行在 Docker 容器中，已中止容器内更新。');
      logLine(hint.reason);
      for (const c of hint.commands) if (c) logLine(c);
      logLine(hint.dataSafe);
      state.running = false;
      state.finishedAt = Date.now();
      state.dockerHint = hint;
      const msg = 'Docker 部署不支持在容器内更新，请在宿主机执行：node deploy/docker-onekey.js --rebuild（或 docker compose up -d --build）';
      setPhase('error', msg);
      state.error = msg;
      return { error: msg, inDocker: true, hint };
    }
    const v = await check({ force: true });
    if (v.error) logLine('版本检查失败：' + v.error + '（继续尝试更新）');
    else {
      logLine(`当前版本 v${v.current}，最新版本 v${v.latest}`);
      if (!v.has_update && !opts.force) {
        state.running = false;
        state.finishedAt = Date.now();
        setPhase('done', `当前已是最新版本 v${v.current}，无需更新`);
        return { ok: true, upToDate: true };
      }
    }

    if (backup) {
      setPhase('backing-up', '备份数据库');
      const b = backupDatabase();
      logLine(b.skipped ? '跳过备份：' + b.reason : '数据库已备份到 ' + b.rel);
    } else {
      logLine('按请求跳过数据库备份');
    }

    const applied = await applySourceUpdate();
    // M14：把完整性结论写进日志与状态（未经校验就必须明确说出来，不能含糊成「已校验」）
    const integrity = applied.integrity || state.integrity;
    const unverifiedNote = integrity && integrity.verified ? '' : '（更新包未经哈希校验）';
    if (integrity && !integrity.verified) {
      logLine('注意：本次代码更新【未经完整性校验】' + (integrity.reason ? `（${integrity.reason}）` : '（未配置 OJ_UPDATE_SHA256）') + '。');
    }

    // 读取更新后的版本号（package.json 已被覆盖）
    delete require.cache[require.resolve('../package.json')];
    let after = CURRENT;
    try { after = require('../package.json').version || CURRENT; } catch { /* ignore */ }
    state.after = after;
    logLine(`代码更新完成：v${state.before} → v${after}` + (applied.how === 'zip' ? '（源码包覆盖' : '（git pull')
      + unverifiedNote + '）');

    if (!restart) {
      state.running = false;
      state.finishedAt = Date.now();
      setPhase('done', '代码已更新' + unverifiedNote + '，请手动重启服务使新版本生效');
      return { ok: true, restartRequired: true, after };
    }

    setPhase('restarting', '正在重启服务以启用新版本');
    const rs = restartService();
    state.running = false;
    state.finishedAt = Date.now();

    // 权限不足等情况下无法自动重启：代码已更新成功，只需人工执行一条命令
    if (rs.manual) {
      state.restarted = false;
      state.restartRequired = true;
      state.restartCommand = rs.command;
      setPhase('done', `代码已更新：v${state.before} → v${after}${unverifiedNote}；自动重启未成功，请手动执行：${rs.command}`);
      return { ok: true, after, how: rs.how, restartRequired: true, command: rs.command, integrity };
    }

    state.restarted = true;
    state.restartRequired = false;
    const howLabel = rs.how === 'systemd-exit' ? 'systemd 自动拉起' : rs.how;
    logLine('重启指令已发出（' + howLabel + '），页面将在服务恢复后自动刷新');
    setPhase('done', `更新完成：v${state.before} → v${after}${unverifiedNote}，服务正在重启`);

    // 由 deploy/restart-helper.js 接管的场景：当前进程必须退出，端口才能释放、新进程才能启动
    // （PM2 / systemd 由守护进程自己负责重启，无需退出）
    if (rs.how === 'helper') {
      logLine('当前进程将在 1 秒后退出，由重启助手拉起新进程');
      setTimeout(() => {
        try { process.exit(0); } catch { /* ignore */ }
      }, 1000).unref?.();
    }
    return { ok: true, after, how: rs.how, integrity };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    state.running = false;
    state.finishedAt = Date.now();
    state.error = msg;
    setPhase('error', '更新失败：' + msg);
    return { error: msg };
  }
}

module.exports = {
  ROOT,
  DATA_DIR,
  KEEP_TOP,
  KEEP_REL,
  check,
  backupDatabase,
  downloadSource,
  applyZip,
  validateEntries,
  applySourceUpdate,
  verifySourceBuffer,
  expectedUpdateHashes,
  sha256Hex,
  detectSupervisor,
  decideRestart,
  performRestart,
  gatherProbe,
  inDocker,
  dockerHint,
  assertWritableDirs,
  restartService,
  start,
  getState,
  compareVersion,
};
