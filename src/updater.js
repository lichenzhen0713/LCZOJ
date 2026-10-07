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
 *      （命令行更新时会先结束占着端口的旧服务进程，否则新进程绑不上端口、更新等于没生效）
 *   5) 全过程记录日志与阶段，前端可轮询查看进度
 *
 * 稳健性（v2.7.5 加固）：
 *   · 下载后先按 ZIP 魔数校验响应内容——更新源可能用 HTTP 200 返回 HTML 登录页（Gitee 归档地址
 *     对自定义 User-Agent 就是这样），不是 zip 就换 UA / 换下一个源，绝不把网页当源码包；
 *   · 覆盖前做写权限预检：Linux 上 ProtectSystem=strict 的部署会直接得到「EROFS + 怎么做」的指引
 *     （不会再白下载一遍，也不会误提示 chown）；
 *   · 写入中途失败（权限 / 文件被占用）会把已写入的文件回滚，尽量不留半新半旧的代码。
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
const KEEP_REL = new Set(['deploy/panel.env', 'deploy/panel.pid']);

/**
 * 源码包来源：默认 **Gitee 优先**（国内网络可达性更好），GitHub 作为备用。
 * 可用环境变量 OJ_UPDATE_ZIP_URL 覆盖（多个地址用英文逗号分隔，按顺序尝试）。
 */
const ZIP_SOURCES = [
  { label: 'Gitee（默认）', url: 'https://gitee.com/lichenzhen0713/LCZOJ/repository/archive/master.zip' },
  { label: 'GitHub（备用）', url: 'https://github.com/lichenzhen0713/LCZOJ/archive/refs/heads/master.zip' },
];

/**
 * 下载源码包时的 User-Agent 候选（按顺序尝试）。
 *
 * ⚠ 实测（v2.7.5）：Gitee 的归档下载接口对「浏览器 UA / 自定义 UA / undici 默认 UA」会返回
 *   **HTTP 200 + 一张『该操作需登录 Gitee 帐号』的 HTML 页面**，只有不设 UA（Node 默认 `node`）
 *   或 curl/wget 这类短标识 UA 才会真正返回 zip。所以这里第一轮**不主动设置 UA**，
 *   第二轮用 curl 兜底；千万不要把这里改成 `LCZOJ/<版本>` 之类的自定义 UA —— 那会让 Gitee 源必然失败。
 *   同时 downloadSource() 会校验响应的 ZIP 魔数，不是 zip 就换下一个 UA / 下一个源，绝不把网页当源码包应用。
 */
const UA_CANDIDATES = [null, 'curl/8.4.0'];

/** ZIP 文件魔数：本地文件头 PK\x03\x04 / 空归档 PK\x05\x06 / 分卷标记 PK\x07\x08 */
const ZIP_SIGNATURES = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]];

/** 响应体是否是 ZIP（Gitee 等源可能用 HTTP 200 返回 HTML 登录页，必须按内容判断） */
function isZipBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  return ZIP_SIGNATURES.some((sig) => sig.every((b, i) => buf[i] === b));
}

/** 非 ZIP 响应的可读原因（用于日志与错误提示，避免只抛「不是有效的 ZIP 文件」） */
function describeNonZip(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const head = Buffer.isBuffer(buf) ? buf.slice(0, 2048).toString('utf8') : String(buf || '');
  const size = Buffer.isBuffer(buf) ? (buf.length / 1024).toFixed(1) + ' KB' : '未知大小';
  if (/gitee/.test(head) && /(登录|需登录|帐号|账号)/.test(head)) {
    return `更新源返回的是 Gitee「该操作需登录」页面（HTTP 200 + ${ct || 'text/html'}，${size}），不是源码包`;
  }
  if (/(html|xml)/.test(ct) || /^\s*<(!doctype|html|\?xml)/i.test(head)) {
    return `更新源返回的是网页（HTTP 200 + ${ct || 'text/html'}，${size}），不是源码包（可能是登录页 / 反爬页 / 404 页面）`;
  }
  return `更新源返回的内容不是 ZIP（HTTP 200，前 4 字节 ${Buffer.isBuffer(buf) ? buf.slice(0, 4).toString('hex') : '—'}，${size}）`;
}

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
  /** 错误分类码（如 EROFS / EACCES / UPDATE_HASH_MISMATCH / UPDATE_NOT_ZIP），供界面区分提示 */
  errorCode: '',
  /** 写权限受阻时给出的可操作指引（{ title, message, commands, note }），供后台直接展示 */
  writeBlock: null,
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
    // 写权限受阻时的可操作指引（前端用它渲染命令块；无阻碍时为 null）
    write_block: state.writeBlock || null,
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
 * 查询正在监听指定端口的进程号（查不到返回 0）。
 * 用途：命令行 `node deploy/update.js` 更新时，服务本身是**另一个进程**（不是执行更新的进程），
 * 它仍然占着端口；重启助手必须先让它退出，新进程才起得来。
 */
function findListenerPid(port, runner = run) {
  const p = parseInt(port, 10);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (process.platform === 'win32') {
    const r = runner('netstat', ['-ano', '-p', 'tcp'], { timeout: 15000 });
    if (r.code !== 0) return 0;
    for (const line of String(r.out).split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && parseInt(m[1], 10) === p) return parseInt(m[2], 10);
    }
    return 0;
  }
  // Linux：/proc/net/tcp{,6} 里 state=0A(LISTEN) 的行取 inode，再在 /proc/*/fd 中反查持有该 socket 的进程
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n').slice(1)) {
      const cols = String(line).trim().split(/\s+/);
      if (cols.length < 10) continue;
      const localPort = parseInt(String(cols[1]).split(':')[1], 16);
      if (String(cols[3]) !== '0A' || localPort !== p) continue;
      inodes.add(String(cols[9]));
    }
  }
  if (!inodes.size) return 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return 0; }
  for (const pidDir of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pidDir}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`/proc/${pidDir}/fd/${fd}`); } catch { continue; }
      const m = String(link).match(/^socket:\[(\d+)\]$/);
      if (m && inodes.has(m[1])) return parseInt(pidDir, 10);
    }
  }
  return 0;
}

/** 读取进程命令行（linux 读 /proc/<pid>/cmdline，windows 走 CIM；查不到返回空串） */
function describeProcess(pid, runner = run) {
  const p = parseInt(pid, 10);
  if (!Number.isFinite(p) || p <= 0) return '';
  if (process.platform === 'win32') {
    const r = runner('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${p}").CommandLine`], { timeout: 15000 });
    return r.code === 0 ? String(r.out).trim() : '';
  }
  try {
    return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').join(' ').trim();
  } catch { return ''; }
}

/**
 * 该进程是否「像本项目的 node server.js」。
 * 拿不到命令行时一律返回 false —— 宁可不自动重启、提示人工处理，也不误杀别人的进程。
 */
function looksLikeOurServer(pid, runner = run) {
  const cmd = describeProcess(pid, runner);
  if (!cmd) return false;
  const isNode = /(^|[\\/\s"])node(\.exe)?(["'\s]|$)/i.test(cmd) || /node\.exe/i.test(cmd);
  return isNode && /server\.js/i.test(cmd);
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
    let sawNonZip = false;
    for (const src of list) {
      const errors = [];
      for (const ua of UA_CANDIDATES) {
        try {
          logLine(`下载源码包（${src.label}）：${src.url}` + (ua ? `（UA: ${ua}）` : ''));
          const headers = { 'Cache-Control': 'no-cache' };
          if (ua) headers['User-Agent'] = ua;
          const res = await fetch(src.url, { redirect: 'follow', headers, signal: AbortSignal.timeout(180000) });
          if (!res.ok) {
            logLine(`下载失败（HTTP ${res.status}）`);
            errors.push(`HTTP ${res.status}`);
            break; // 4xx/5xx 换 UA 也一样，直接换下一个源
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const ct = res.headers.get('content-type');
          // 关键：HTTP 200 不等于拿到源码包（Gitee 会返回 HTML 登录页）；先按 ZIP 魔数校验
          if (!isZipBuffer(buf)) {
            const why = describeNonZip(buf, ct);
            logLine('该地址没有返回源码包：' + why);
            errors.push(why);
            sawNonZip = true;
            continue; // 换下一个 UA 候选再试同一个地址
          }
          logLine(`下载完成：${(buf.length / 1024 / 1024).toFixed(2)} MB（${src.label}）`);
          // M14：确认是完整 zip 之后再校验哈希，避免把「拿到网页」误报成「哈希不匹配」
          const integrity = verifySourceBuffer(buf);
          return { buf, from: src.url, label: src.label, integrity };
        } catch (err) {
          if (err && err.code === 'UPDATE_HASH_MISMATCH') throw err; // 完整性失败必须中止，不再尝试其它源
          const msg = (err && err.name === 'TimeoutError') ? '连接超时' : ((err && err.message) || String(err));
          logLine(`下载失败（${src.label}）：${msg}`);
          errors.push(msg);
          break; // 网络层异常换 UA 也救不回来，换下一个源
        }
      }
      tried.push(`${src.label}（${src.url}）：${errors[0] || '失败'}`);
    }
    const nonZipTip = sawNonZip
      ? '注意：上面的源返回的是网页而不是源码包（Gitee 的归档地址对部分 User-Agent 只给登录页）。'
        + '可把 OJ_UPDATE_ZIP_URL 指向 GitHub 归档地址或自建镜像（多个地址用英文逗号分隔，按顺序尝试），'
        + '也可以手动下载源码包覆盖代码（务必保留 data/ 目录）。'
      : '可在环境变量 OJ_UPDATE_ZIP_URL 中指定可用的镜像地址，或手动下载源码包覆盖代码（保留 data 目录）。';
    return {
      error: '无法下载源码包（已尝试 ' + tried.length + ' 个源）——' + tried.join('；') + '。' + nonZipTip,
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

/**
 * 计算源码包的顶层目录前缀。
 * GitHub / Gitee 的归档包都是「一个顶层目录 + 文件」，但自建镜像、手工压缩的包
 * 常常是「文件直接在根」。此前直接用 entries[0] 推导前缀，遇到根目录扁平包会把
 * 全部文件都当「不在前缀内」跳过，最终只报「源码包里没有可用的代码文件」。
 * 这里改为：只有**所有条目都同属一个顶层目录**时才剥掉该目录，否则按根目录处理。
 */
function detectZipPrefix(entries) {
  const names = entries.map((e) => String(e.name || '').replace(/^\.\//, '')).filter((n) => n && !n.startsWith('/'));
  if (!names.length) return '';
  const top = names[0].split('/')[0];
  const allUnderTop = names.every((n) => n === top || n.startsWith(top + '/'));
  if (!allUnderTop) return '';
  // 全是根目录文件（名称里没有 '/'）时不存在前缀
  return names.some((n) => n.includes('/')) ? top + '/' : '';
}

/** 覆盖前记录的原文件内容上限：超过则不记录（无法回滚，如实告知，不假装可回滚） */
const ROLLBACK_MAX_FILE_BYTES = 8 * 1024 * 1024;
const ROLLBACK_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * 回滚已写入的文件：有原始快照的写回原内容，本次新建的删除。
 * @returns {{restored:number, removed:number, failed:string[], noSnapshot:string[]}}
 */
function rollbackWritten(written, snapshots, created) {
  const out = { restored: 0, removed: 0, failed: [], noSnapshot: [] };
  for (const rel of written) {
    const dest = path.join(ROOT, rel);
    try {
      if (snapshots.has(rel)) { fs.writeFileSync(dest, snapshots.get(rel)); out.restored++; continue; }
      if (created.has(rel)) { fs.unlinkSync(dest); out.removed++; continue; }
      out.noSnapshot.push(rel);
    } catch {
      out.failed.push(rel);
    }
  }
  return out;
}

/** 把回滚结果拼成一句可读的说明 */
function rollbackNote(rb) {
  const parts = [];
  if (rb.restored) parts.push(`已还原 ${rb.restored} 个原文件`);
  if (rb.removed) parts.push(`已删除 ${rb.removed} 个新增文件`);
  if (rb.noSnapshot.length) parts.push(`${rb.noSnapshot.length} 个大文件无法回滚（${rb.noSnapshot.slice(0, 3).join('、')}）`);
  if (rb.failed.length) parts.push(`${rb.failed.length} 个文件回滚失败（${rb.failed.slice(0, 3).join('、')}）`);
  if (!parts.length) return '未写入任何文件';
  return parts.join('、');
}

/** 把源码包里的代码文件写入项目目录（跳过数据与本地配置）
 *  **先整体检查，通过后才写入**；检查失败时不修改任何文件。
 *  写入阶段若中途失败（权限 / 文件被占用 / 磁盘错误），会把**已经写入的文件回滚**，
 *  尽量不留下半新半旧的代码（大文件无快照时如实说明无法回滚）。
 *  注意：这里只做「内容可用性」检查（冲突标记 / JSON 合法性 / server.js 语法），
 *  **不是安全校验**——源码包完整性由 verifySourceBuffer()（OJ_UPDATE_SHA256）负责（M14）。 */
function applyZip(buf) {
  if (!isZipBuffer(buf)) throw zipShapeError(buf);
  const entries = parseZip(buf);
  const check = validateEntries(entries);
  if (check.errors.length) {
    const err = new Error('源码包内容检查未通过，已中止更新（未修改任何文件）：' + check.errors.join('；')
      + '。请先在代码仓库中修复后再执行更新。');
    err.validation = check;
    throw err;
  }

  const prefix = detectZipPrefix(entries);
  const skipped = new Set();
  const written = [];
  const plan = [];
  for (const e of entries) {
    const name = String(e.name || '').replace(/^\.\//, '').replace(/\\/g, '/');
    if (!name || name.endsWith('/')) continue;
    if (prefix && !name.startsWith(prefix)) continue;
    const rel = prefix ? name.slice(prefix.length) : name;
    if (!rel) continue;
    const top = rel.split('/')[0];
    if (KEEP_TOP.has(top) || KEEP_REL.has(rel)) { skipped.add(KEEP_TOP.has(top) ? top : rel); continue; }
    const dest = path.resolve(ROOT, rel);
    if (!dest.startsWith(ROOT + path.sep)) continue;   // 防路径穿越
    plan.push({ rel, dest, data: e.data });
  }
  if (!plan.length) {
    const sample = entries.slice(0, 3).map((e) => String(e.name || '')).join('、');
    throw new Error('源码包里没有可覆盖的代码文件（顶层目录「' + (prefix || '（无）') + '」，条目示例：' + sample + '）');
  }

  // 覆盖前先确认所有目标目录可写：避免写到一半才发现无权限（Docker 容器内 /app 属主为 root、普通用户不可写）
  assertWritableDirs([...new Set(plan.map((p) => path.dirname(p.dest)))]);

  // 写入前记录原文件内容（用于失败回滚）
  const snapshots = new Map();
  const created = new Set();
  let snapshotBytes = 0;
  for (const p of plan) {
    try {
      if (!fs.existsSync(p.dest)) { created.add(p.rel); continue; }
      const st = fs.statSync(p.dest);
      if (st.size > ROLLBACK_MAX_FILE_BYTES || snapshotBytes + st.size > ROLLBACK_MAX_TOTAL_BYTES) continue;
      const data = fs.readFileSync(p.dest);
      snapshots.set(p.rel, data);
      snapshotBytes += data.length;
    } catch { /* 读不到就不记快照：回滚时会如实报出 */ }
  }

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
    const rb = rollbackWritten(written, snapshots, created);
    logLine(`覆盖代码时出现 ${failed.length} 个文件写入失败，已执行回滚：${rollbackNote(rb)}`);
    const perm = failed.filter((f) => /EACCES|EPERM|EROFS/.test(f.code));
    if (perm.length) {
      const hint = writeBlockHint({ codes: perm.map((f) => f.code), dirs: [...new Set(perm.map((f) => f.rel))].slice(0, 5), docker: inDocker() });
      const err = new Error('无写入权限：有 ' + perm.length + ' 个文件无法写入（例如 ' + perm.slice(0, 3).map((f) => f.rel).join('、') + '）。'
        + '本次更新已中止，' + rollbackNote(rb) + '。' + hint.message);
      err.code = hint.code || perm[0].code;
      err.hint = hint;
      err.failed = failed;
      err.partial = written.length;
      err.rollback = rb;
      throw err;
    }
    const err = new Error('覆盖代码失败（' + failed.length + ' 个文件）：' + failed.slice(0, 3).map((f) => f.rel + '（' + f.message + '）').join('；')
      + '。本次更新已中止，' + rollbackNote(rb) + '。');
    err.code = 'UPDATE_WRITE_FAILED';
    err.failed = failed;
    err.partial = written.length;
    err.rollback = rb;
    throw err;
  }
  return { written, skipped: [...skipped], validated: true, snapshot_ok: written.filter((r) => snapshots.has(r)).length };
}

/** 非 ZIP 内容（多为源返回的 HTML 登录页）对应的错误：给出可理解的说明与处理建议 */
function zipShapeError(buf) {
  const why = describeNonZip(buf, '');
  const err = new Error('下载到的内容不是源码包 zip：' + why + '。'
    + '更新已中止，未修改任何文件。请在环境变量 OJ_UPDATE_ZIP_URL 中改指可用的源码包地址（可写多个，英文逗号分隔），'
    + '或手动下载源码包覆盖代码（保留 data 目录）。');
  err.code = 'UPDATE_NOT_ZIP';
  return err;
}

/**
 * 依据写入错误码给出**可操作**的指引。
 * 重点区分 EROFS（只读文件系统，例如 systemd `ProtectSystem=strict` / `ReadOnlyPaths` 把项目目录挂成只读）
 * 与 EACCES/EPERM（属主/权限问题）——两者的处理办法完全不同，此前一律提示 `chown`，
 * 在只读挂载下是无效指引（chown 改不了只读挂载），会让人一直修不好。
 * @returns {{code:string,title:string,message:string,commands:string[],note:string}}
 */
function writeBlockHint({ codes = [], dirs = [], docker = false, root = ROOT, details = [] } = {}) {
  const set = new Set(codes.map((c) => String(c || '').toUpperCase()));
  const shown = dirs.slice(0, 5).join('、') + (dirs.length > 5 ? ` 等 ${dirs.length} 处` : '');
  if (docker) {
    return {
      code: 'EACCES',
      title: 'Docker 部署请在宿主机更新',
      message: '容器内的 /app 由 root 拥有、服务以普通用户 node 运行，容器内无法覆盖代码（且重建容器会回到镜像里的版本）。'
        + '请在**宿主机**执行下面一条命令更新。',
      commands: [
        'node deploy/docker-onekey.js --rebuild',
        'docker compose up -d --build',
      ],
      note: '数据库、题库测试数据、附件、头像都在数据卷（默认 lczoj-data）里，重建容器不会丢失。',
    };
  }
  if (process.platform === 'win32') {
    const me = process.env.USERNAME || process.env.USER || '（未知）';
    const first = details[0];
    return {
      code: set.has('EROFS') ? 'EROFS' : 'EACCES',
      title: '当前 Windows 账户对项目目录没有写权限',
      message: '更新需要的写入操作被拒绝（不可写位置：' + (shown || '项目目录') + '）。'
        + '服务进程账户：' + me + (first ? '，首个错误 ' + first.code : '') + '。'
        + 'Windows 上不适用 chown/sudo，常见原因有三种：'
        + '① 服务是由**受限权限的会话启动的**（例如从沙箱、受限计划任务、或低完整性级别进程启动）——'
        + '请用同一个账户在**普通终端（必要时「以管理员身份运行」）**重启服务；'
        + '② 目录/文件带**只读属性**（去掉只读，或执行 attrib -R）；'
        + '③ 目录被安全软件或其它进程占用锁定。'
        + '本次更新已中止，未修改任何文件。',
      commands: [
        'attrib -R "' + root + '\\*" /S /D',
        'taskkill /IM node.exe /F & node server.js    # 在普通/管理员终端重启服务',
      ],
      note: '若服务由计划任务或包装器启动，请确认它使用的账户，以及是否启用了沙箱/低完整性级别（那会让写入被拒，即使目录属主就是你）。',
    };
  }
  if (set.has('EROFS')) {
    return {
      code: 'EROFS',
      title: '当前部署把项目目录挂成了只读（EROFS），后台无法覆盖代码',
      message: '更新需要的写入操作被文件系统拒绝（EROFS：Read-only file system，不可写位置：' + (shown || '项目目录') + '）。'
        + '这通常是 systemd 加固造成的：单元里配了 ProtectSystem=strict（或 ReadOnlyPaths），而项目目录不在 ReadWritePaths 中——'
        + 'LCZOJ 自带的 deploy/lczoj.service 正是这种加固配置，属于预期行为，不是权限属主问题（chown 无效）。'
        + '本次更新已中止，未修改任何文件。',
      commands: [
        'sudo node deploy/update.js        # 在宿主机普通终端执行（不受该单元只读命名空间限制），推荐',
        'sudo systemctl restart lczoj      # 更新完成后重启服务生效',
      ],
      note: '若确实想让网页端自助更新：把项目目录加进单元的 ReadWritePaths（例如 ReadWritePaths=/www/wwwroot/lczoj），'
        + '再执行 sudo systemctl daemon-reload && sudo systemctl restart lczoj。'
        + '代价：服务运行账户从此可以改写站点代码，ProtectSystem=strict 的加固被削弱（服务被攻陷后可持久化篡改站点）。'
        + '也可以把部署改成 Docker，或让服务以可写目录运行。',
    };
  }
  return {
    code: 'EACCES',
    title: '服务进程对项目目录没有写权限',
    message: '更新需要的写入操作被拒绝（不可写位置：' + (shown || '项目目录') + '）。'
      + (ownerNote(dirs) ? ownerNote(dirs) + ' ' : '')
      + '请把项目目录属主改为服务运行用户后重试（例如：chown -R <运行用户>:<运行用户> ' + root + '），'
      + '或用 sudo 运行服务 / 执行 sudo node deploy/update.js。',
    commands: ['sudo node deploy/update.js'],
    note: '提示：如果确认属主正确但仍报错，请检查是否启用了只读挂载（ProtectSystem=strict / ReadOnlyPaths / mount -o ro）。',
  };
}

/** POSIX 上把"服务以哪个 uid 运行、目标目录属主是谁"写进报错里，便于直接看出属主不匹配（Windows 无 uid，返回空串） */
function ownerNote(dirs = []) {
  try {
    if (typeof process.getuid !== 'function') return '';
    const parts = [];
    for (const rel of dirs.slice(0, 3)) {
      const p = rel === '.' ? ROOT : path.join(ROOT, rel);
      try { const st = fs.statSync(p); parts.push(rel + ' 属主 uid=' + st.uid + ' gid=' + st.gid); } catch { /* 忽略 */ }
    }
    if (!parts.length) return '';
    return '服务以 uid=' + process.getuid() + '（gid=' + process.getgid() + '）运行；目标：' + parts.join('，') + '。';
  } catch { return ''; }
}

/**
 * 覆盖代码前检查目标目录是否可写（写一个探针文件再删掉）。
 * 任一目录不可写即抛出带指引的错误——避免更新写到一半失败、留下半新半旧的代码。
 * 错误里带 `code`（EROFS / EACCES）与 `hint`（可操作指引），供界面直接展示。
 */
function assertWritableDirs(dirs) {
  const bad = [];
  const details = [];
  const codes = new Set();
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      const probe = path.join(d, '.lczoj-write-test-' + process.pid);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch (err) {
      const rel = path.relative(ROOT, d) || '.';
      const code = String((err && err.code) || 'EACCES').toUpperCase();
      bad.push(rel);
      codes.add(code);
      details.push({ rel, code, message: (err && err.message) || String(err) });
    }
  }
  if (bad.length) {
    const hint = writeBlockHint({ codes: [...codes], dirs: bad, docker: inDocker(), details });
    // 把**每个目录的真实 errno** 附在末尾：报错里能直接看出是 EPERM/EACCES/EROFS/ENOTDIR 哪一种，
    // 以及是不是同一进程账户问题，不必再猜（此前只给目录名，看不出原因）。
    const detailText = details.slice(0, 5).map((x) => x.rel + '（' + x.code + '）').join('、')
      + (details.length > 5 ? ' 等 ' + details.length + ' 处' : '');
    const err = new Error(hint.message + ' 具体错误：' + detailText + '。');
    err.code = hint.code;
    err.dirs = bad;
    err.details = details;
    err.hint = hint;
    throw err;
  }
}

/**
 * 更新前的写权限预检：不下载、不备份，先确认项目目录可写。
 * Linux 上 ProtectSystem=strict 的部署会在这一步直接得到「EROFS + 怎么修」的明确指引，
 * 而不是白下载几十 MB、备份完数据库后才失败。
 * @returns {{ok:true} | {ok:false, code:string, message:string, dirs:string[], hint:object}}
 */
function preflightWriteCheck() {
  const dirs = [ROOT];
  for (const name of ['src', 'public', 'deploy', 'docs', 'testlib']) {
    const d = path.join(ROOT, name);
    if (fs.existsSync(d)) dirs.push(d);
  }
  try {
    assertWritableDirs(dirs);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code || 'EACCES', message: (err && err.message) || String(err), dirs: err.dirs || [], hint: err.hint };
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
    const port = parseInt(require('./config').PORT, 10) || 80;
    // 本次更新是不是跑在「正在对外服务的那个进程」里？
    //   后台「一键更新」→ 是（HTTP 请求由服务进程处理）；命令行 node deploy/update.js → 否（服务是另一个进程）。
    const selfServing = overrides.selfServing === true || findListenerPid(port) === process.pid;
    // 关键：命令行更新时，真正占着端口的是**另一个** node server.js 进程。
    // 重启助手只等「更新进程」退出是不够的——端口一直被旧服务占着，新进程永远绑不上（EADDRINUSE），
    // 旧代码继续对外服务，而界面/命令行却显示「已重启」，属于典型的「更新了但没生效」。
    // 因此找出端口监听者，确认它确实是本项目的 node server.js 后交给助手结束它。
    const listenerPid = findListenerPid(port);
    let killPid = 0;
    if (!selfServing && listenerPid && listenerPid !== process.pid) {
      if (looksLikeOurServer(listenerPid)) {
        killPid = listenerPid;
        logLine(`端口 ${port} 由旧服务进程 ${listenerPid} 占用，将在新进程启动前结束它`);
      } else {
        logLine(`端口 ${port} 被进程 ${listenerPid} 占用，且无法确认它是本项目的 node server.js，未做任何结束操作`);
        return {
          how: 'none',
          manual: true,
          command: process.platform === 'win32' ? 'node server.js' : 'sudo systemctl restart lczoj',
          detail: `端口 ${port} 被其它进程（PID ${listenerPid}）占用，无法自动重启，请人工确认后重启服务`,
        };
      }
    }
    // 助手需要等待「还占着端口/马上要让位」的那个进程退出：
    //   · 更新跑在服务进程里（后台更新）→ 等本进程退出（本进程 1 秒后自行 exit）
    //   · 命令行更新 → 等被结束的旧服务进程退出；命令行进程本身可以继续跑（用于确认服务是否恢复）
    const waitPid = selfServing ? process.pid : killPid;
    // 助手的输出重定向到 logs/lczoj.log：此前用 stdio:'ignore'，助手失败（例如端口始终没释放）时
    // 什么都没留下，管理员只看到「已重启」，无从排查。
    let helperStdio = 'ignore';
    try {
      const fd = fs.openSync(LOG_FILE, 'a');
      helperStdio = ['ignore', fd, fd];
    } catch { /* 日志打不开就退回 ignore，不影响重启本身 */ }
    const child = spawn(process.execPath, [
      helper,
      '--pid', String(waitPid || 0),
      '--port', String(port),
      '--host', String(require('./config').HOST),
      '--cwd', ROOT,
      '--kill', String(killPid),
    ], { detached: true, stdio: helperStdio, cwd: ROOT, env: process.env });
    child.unref();
    return { how: result.how, helperPid: child.pid, takeoverPid: killPid || undefined, selfExit: selfServing };
  }

  logLine('重启命令执行成功：' + result.cmd);
  return { how: result.how, cmd: result.cmd };
}

/* ------------------------------ 主流程 ------------------------------ */
/**
 * 执行一次更新。
 * @param {{backup?:boolean, restart?:boolean, force?:boolean, selfServing?:boolean, allowDocker?:boolean}} opts
 *        selfServing：本次更新是否跑在「正在对外服务的进程」里（后台一键更新为 true，命令行 update.js 不传）。
 *        它决定重启助手等待谁退出：等本进程（自己就是服务）还是等被结束的旧服务进程。
 * @returns {Promise<{ok?:boolean, error?:string}>}
 */
async function start(opts = {}) {
  if (state.running) return { error: '已有更新任务正在进行中' };
  const backup = opts.backup !== false;
  const restart = opts.restart !== false;

  state.running = true;
  state.error = '';
  state.errorCode = '';
  state.writeBlock = null;
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
      state.errorCode = 'UPDATE_IN_DOCKER';
      state.writeBlock = { ...hint, message: hint.reason };
      return { error: msg, inDocker: true, hint };
    }
    // 写权限预检（Linux ProtectSystem=strict 下项目目录只读会在这里就得到 EROFS 指引）
    const pre = preflightWriteCheck();
    if (!pre.ok) {
      logLine('写权限预检未通过：' + pre.message);
      for (const c of ((pre.hint && pre.hint.commands) || [])) if (c) logLine(c);
      state.running = false;
      state.finishedAt = Date.now();
      state.error = pre.message;
      state.errorCode = pre.code;
      state.writeBlock = pre.hint || null;
      setPhase('error', pre.message);
      return { error: pre.message, code: pre.code, hint: pre.hint };
    }
    state.writeBlock = null;
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
    const rs = restartService({ selfServing: opts.selfServing === true });
    state.running = false;
    state.finishedAt = Date.now();

    // 权限不足等情况下无法自动重启：代码已更新成功，只需人工执行一条命令
    if (rs.manual) {
      state.restarted = false;
      state.restartRequired = true;
      state.restartCommand = rs.command;
      setPhase('done', `代码已更新：v${state.before} → v${after}${unverifiedNote}；自动重启未成功，请手动执行：${rs.command}`
        + (rs.detail ? `（原因：${rs.detail}）` : ''));
      return { ok: true, after, how: rs.how, restartRequired: true, command: rs.command, detail: rs.detail, integrity };
    }

    state.restarted = true;
    state.restartRequired = false;
    const howLabel = rs.how === 'systemd-exit' ? 'systemd 自动拉起' : rs.how;
    logLine('重启指令已发出（' + howLabel + '）' + (rs.takeoverPid ? `，接管端口 ${rs.takeoverPid}` : '') + '，页面将在服务恢复后自动刷新');
    setPhase('done', `更新完成：v${state.before} → v${after}${unverifiedNote}，服务正在重启`);

    // 由 deploy/restart-helper.js 接管、且「本进程就是对外服务的进程」（后台一键更新）时，
    // 当前进程必须退出，端口才能释放、新进程才能启动（PM2 / systemd 由守护进程负责，无需退出）。
    // 命令行更新时 rs.selfExit 为 false：执行更新的进程不是服务进程，它还要跑完后面的健康检查。
    if (rs.how === 'helper' && rs.selfExit) {
      logLine('当前进程将在 1 秒后退出，由重启助手拉起新进程');
      setTimeout(() => {
        try { process.exit(0); } catch { /* ignore */ }
      }, 1000).unref?.();
    }
    return { ok: true, after, how: rs.how, integrity, helperPid: rs.helperPid, takeoverPid: rs.takeoverPid };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    state.running = false;
    state.finishedAt = Date.now();
    state.error = msg;
    state.errorCode = (err && err.code) || 'UPDATE_FAILED';
    if (err && err.hint) state.writeBlock = err.hint;
    setPhase('error', '更新失败：' + msg);
    return { error: msg, code: state.errorCode, hint: state.writeBlock || undefined };
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
  preflightWriteCheck,
  writeBlockHint,
  detectZipPrefix,
  isZipBuffer,
  describeNonZip,
  rollbackWritten,
  restartService,
  start,
  getState,
  compareVersion,
};
