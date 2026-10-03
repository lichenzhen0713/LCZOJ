#!/usr/bin/env node
'use strict';
/**
 * LCZOJ 面板一键准备 + 一键启动（宝塔面板 / 小皮面板 / 任何服务器都能用）
 *
 *   node deploy/panel-install.js                # 一键准备 + 启动（推荐，照提示做即可）
 *   node deploy/panel-install.js --check        # 只看环境、什么都不改（安全）
 *   node deploy/panel-install.js --start        # 只启动服务（后台运行，不用再建 Node 项目）
 *   node deploy/panel-install.js --stop         # 停止后台服务
 *   node deploy/panel-install.js --port 8080    # 换端口
 *   node deploy/panel-install.js --no-compilers # 不装评测语言编译器
 *
 * 它会依次帮你做完这些事：
 *   1. 检查 Node.js 版本够不够（不够就告诉你怎么装）
 *   2. 建好数据目录 data/ 并确认能写
 *   3. 生成 deploy/panel.env（端口、监听地址、并行判题数）
 *   4. 安装评测语言编译器（可选，能装就装，装不了给出命令）
 *   5. 启动服务并等它就绪（deploy/panel.pid 记录进程号，日志在 logs/lczoj.log）
 *   6. 生成可直接粘贴的站点反向代理配置（deploy/panel-nginx.conf）
 *   7. 跑一遍环境自检，并把「面板上接下来点哪里」一步一步列出来
 *
 * 只做准备工作，不会删除任何数据；数据目录里已有 oj.db 时会明确提示不会覆盖。
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('node:child_process');
const { internalIp, publicIp, initialAdminPassword } = require('./net-info');

const ROOT = path.join(__dirname, '..');
const isWin = process.platform === 'win32';

/* ---------------- 命令行参数 ---------------- */
const args = process.argv.slice(2);
function argValue(name, dflt) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : dflt;
}
const has = (name) => args.includes(name);

if (has('--help') || has('-h')) {
  console.log(`
LCZOJ 面板一键准备 / 一键启动

  node deploy/panel-install.js                 一键准备 + 后台启动（默认端口 3000，只监听本机）
  node deploy/panel-install.js --check         只检查环境，不做任何修改
  node deploy/panel-install.js --start         只启动服务（后台运行）
  node deploy/panel-install.js --stop          停止后台服务
  node deploy/panel-install.js --port 8080     指定端口
  node deploy/panel-install.js --host 0.0.0.0  允许直接访问端口（不用 Nginx 反代时）
  node deploy/panel-install.js --user www      数据目录属主（默认自动判断：宝塔用 www）
  node deploy/panel-install.js --no-compilers  跳过评测语言编译器安装
  node deploy/panel-install.js --help          显示本帮助
`);
  process.exit(0);
}

const CHECK_ONLY = has('--check');
const SKIP_COMPILERS = has('--no-compilers');
const PORT = parseInt(argValue('--port', '3000'), 10);
const HOST = argValue('--host', '127.0.0.1');
const MAX_JUDGES = argValue('--judges', String(Math.max(2, Math.min(4, (os.cpus() || []).length - 1 || 2))));
const DATA_DIR = path.resolve(ROOT, process.env.OJ_DATA_DIR || 'data');

const out = (s = '') => console.log(s);
const step = (n, total, title) => { out(''); out(`【${n}/${total}】${title}`); };
const okLine = (s) => out('   ✓ ' + s);
const warnLine = (s) => out('   ! ' + s);
const infoLine = (s) => out('   · ' + s);

function run(cmd, cmdArgs, opts = {}) {
  try {
    const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', timeout: opts.timeout || 600000, windowsHide: true, stdio: opts.inherit ? 'inherit' : 'pipe' });
    return { code: r.status == null ? 1 : r.status, out: String((r.stdout || '') + (r.stderr || '')) };
  } catch {
    return { code: 1, out: '' };
  }
}
const which = (cmd) => run(isWin ? 'where' : 'which', [cmd]).code === 0;

function nodeVersionOk() {
  const [maj, min] = process.versions.node.split('.').map((n) => parseInt(n, 10));
  return { major: maj, minor: min, ok: maj > 22 || (maj === 22 && min >= 5), best: maj >= 24 };
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function detectPanelUser() {
  const given = argValue('--user', '');
  if (given) return given;
  if (isWin) return os.userInfo().username;
  // 宝塔面板站点用户一般是 www，且站点目录在 /www/wwwroot 下
  if (fs.existsSync('/www')) return 'www';
  return os.userInfo().username;
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const target = host === '0.0.0.0' ? '127.0.0.1' : host;
    const sock = net.connect({ port, host: target });
    sock.setTimeout(1200);
    sock.once('connect', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      try { srv.listen(port, host); } catch { resolve(false); }
    });
  });
}

function pkgManager() {
  if (isWin) return null;
  // 有的精简系统连 which 都没有，所以再兜底看一眼常见路径
  const exists = (cmd) => which(cmd) || fs.existsSync('/usr/bin/' + cmd) || fs.existsSync('/bin/' + cmd);
  for (const cmd of ['apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk']) {
    if (exists(cmd)) return { cmd, list: cmd === 'apt-get' ? ['apt-get', 'update'] : null };
  }
  return null;
}

/* ---------------- 后台启停（不用面板建项目也能跑） ---------------- */
const PID_FILE = path.join(ROOT, 'deploy', 'panel.pid');
const LOG_FILE = path.join(ROOT, 'logs', 'lczoj.log');

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch { return NaN; }
}
function alive(pid) {
  if (!Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function startService() {
  const pid = readPid();
  if (alive(pid)) return { already: true, pid };
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PORT: String(PORT),
      OJ_HOST: HOST,
      OJ_MAX_JUDGES: String(MAX_JUDGES),
      TZ: process.env.TZ || 'Asia/Shanghai',
      NODE_ENV: 'production',
    },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return { pid: child.pid };
}

async function stopService() {
  const pid = readPid();
  if (!alive(pid)) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { already: true };
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 300));
  const still = alive(pid);
  if (still) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  return { pid, forced: still };
}

/** 等端口上的服务真正就绪（读 /api/health） */
async function waitReady(port, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** 生成可直接粘贴到面板站点里的反向代理配置 */
function writeNginxSnippet() {
  const f = path.join(ROOT, 'deploy', 'panel-nginx.conf');
  const body = `# =============================================================================
#  LCZOJ 站点反向代理配置（由 deploy/panel-install.js 生成）
#
#  用法：
#    宝塔：网站 → 你的站点 → 配置文件 → 把下面 server { } 里的内容合并进去
#          （或直接用「反向代理」功能，目标 URL 填 http://127.0.0.1:${PORT}）
#    小皮：网站 → 站点 → 配置文件 → 同样把下面内容合并进 server { }
#
#  只需要改一处：server_name 换成你自己的域名
# =============================================================================

server {
    listen 80;
    server_name oj.example.com;          # ← 换成你的域名

    # 上传大答案包（最大 32MB）必须放宽，否则会报 413 请求体过大
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 30s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    # 健康检查（面板监控 / 负载均衡可探测）
    location = /api/health {
        proxy_pass http://127.0.0.1:${PORT}/api/health;
        access_log off;
    }
}
`;
  try {
    fs.writeFileSync(f, body, 'utf8');
    return f;
  } catch {
    return null;
  }
}

/* ---------------- 主流程 ---------------- */
(async () => {
  out('');
  out('============================================================');
  out('  LCZOJ 面板部署准备（环境准备 + 启动服务 + 生成反向代理配置）');
  out('============================================================');
  out(`  项目目录：${ROOT}`);
  out(`  计划端口：${PORT}　监听地址：${HOST}　数据目录：${DATA_DIR}`);
  if (CHECK_ONLY) out('  模式：只检查（--check），不会修改任何文件');

  const TOTAL = 6;
  const todo = [];   // 需要用户手动做的事

  /* ---- --stop / --start 快捷操作 ---- */
  if (has('--stop')) {
    const r = await stopService();
    out('');
    if (r.already) okLine('当前没有由本脚本启动的服务（没有找到 deploy/panel.pid）');
    else okLine(`已停止服务（PID ${r.pid}${r.forced ? '，超时后强制结束' : ''}），数据都保留在 ${DATA_DIR}`);
    out('');
    process.exit(0);
  }
  if (has('--start')) {
    out('');
    const s = startService();
    if (s.already) infoLine(`服务已在运行（PID ${s.pid}）`);
    else okLine(`服务已启动（PID ${s.pid}），日志：logs/lczoj.log`);
    const h = await waitReady(PORT);
    if (h) okLine(`已就绪：v${h.version}　http://127.0.0.1:${PORT}/`);
    else warnLine('还没就绪，稍等几秒；或看日志 logs/lczoj.log');
    const f = writeNginxSnippet();
    if (f) infoLine('反向代理配置已生成：' + path.relative(ROOT, f));
    out('');
    process.exit(0);
  }

  /* ---- 1. Node.js ---- */
  step(1, TOTAL, '检查 Node.js');
  const nv = nodeVersionOk();
  if (nv.ok) {
    okLine(`Node.js v${process.versions.node}${nv.best ? '（推荐版本）' : '（可用；建议升到 v24）'}`);
  } else {
    warnLine(`Node.js v${process.versions.node} 版本过低，需要 ≥ 22.5（推荐 v24）`);
    if (isWin) {
      infoLine('去 https://nodejs.org/zh-cn/download 下载 v24 安装包，双击安装后重新运行本脚本');
    } else if (pkgManager() && pkgManager().cmd === 'apt-get') {
      infoLine('Ubuntu / Debian 执行这一段（复制整行）：');
      out('     curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs');
    } else {
      infoLine('用你的包管理器安装 Node.js 24，或到 https://nodejs.org/zh-cn/download 下载');
    }
    todo.push('升级 Node.js 到 v24 后重新运行本脚本');
  }

  /* ---- 2. 数据目录 ---- */
  step(2, TOTAL, '准备数据目录（数据库和题库都放在这里）');
  const hadDb = fs.existsSync(path.join(DATA_DIR, 'oj.db'));
  if (hadDb) infoLine('检测到已有数据库 data/oj.db —— 只做权限检查，不会动里面的数据');
  if (CHECK_ONLY) {
    infoLine('（--check 模式，跳过创建）');
  } else {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const probe = path.join(DATA_DIR, '.lczoj-write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      okLine('数据目录存在且可写：' + DATA_DIR);
    } catch (err) {
      warnLine('数据目录不可写：' + ((err && err.message) || err));
      infoLine('通常是权限问题，执行（把 www 换成面板站点用户）：');
      out(`     chown -R www:www "${DATA_DIR}" && chmod -R 755 "${DATA_DIR}"`);
      todo.push('修正 data 目录权限');
    }
  }
  const panelUser = detectPanelUser();
  if (!isWin && isRoot() && !CHECK_ONLY) {
    const r = run('chown', ['-R', `${panelUser}:${panelUser}`, DATA_DIR]);
    if (r.code === 0) okLine(`数据目录属主已设为 ${panelUser}（面板站点用户）`);
    else warnLine(`chown ${panelUser} 失败，可手动执行：chown -R ${panelUser}:${panelUser} ${DATA_DIR}`);
  } else if (!isWin) {
    infoLine(`当前用户：${os.userInfo().username}，面板站点用户通常为 ${panelUser}（需要时用管理员的 sudo 执行 chown）`);
  }

  /* ---- 3. 写入启动参数 ---- */
  step(3, TOTAL, '写入启动参数 deploy/panel.env');
  const envFile = path.join(ROOT, 'deploy', 'panel.env');
  const envBody = `# LCZOJ 启动参数（由 deploy/panel-install.js 生成，可随时修改后重启服务）
# 端口：面板的 80/443 被 Nginx 占用，所以本站用高位端口，再由站点反向代理过来
PORT=${PORT}
# 监听地址：127.0.0.1 = 只允许本机（Nginx 反代）访问，最安全；要直接 IP:端口 访问就改成 0.0.0.0
OJ_HOST=${HOST}
# 并行判题数：按服务器核数调整，留 1~2 核给系统
OJ_MAX_JUDGES=${MAX_JUDGES}
# 时区（页面时间显示）
TZ=Asia/Shanghai
NODE_ENV=production
`;
  if (CHECK_ONLY) {
    infoLine(`（--check 模式，跳过写入；将要写入 PORT=${PORT} OJ_HOST=${HOST} OJ_MAX_JUDGES=${MAX_JUDGES}）`);
  } else if (fs.existsSync(envFile) && !has('--force')) {
    infoLine('deploy/panel.env 已存在，保留原有配置（想覆盖可加 --force）');
  } else {
    try {
      fs.writeFileSync(envFile, envBody, 'utf8');
      okLine('已写入 deploy/panel.env（端口 ' + PORT + '，监听 ' + HOST + '，并行判题 ' + MAX_JUDGES + '）');
    } catch (err) {
      warnLine('写入 deploy/panel.env 失败：' + ((err && err.message) || err));
    }
  }
  const free = await portFree(PORT, HOST);
  if (free) okLine(`端口 ${PORT} 目前空闲，可以启动`);
  else {
    warnLine(`端口 ${PORT} 已被占用（可能是已经启动过的 LCZOJ，也可能是别的程序）`);
    infoLine('查看占用者：node deploy/check-env.js　换端口：改 deploy/panel.env 里的 PORT 后重启');
  }

  /* ---- 4. 评测语言编译器 ---- */
  step(4, TOTAL, '安装评测语言编译器（Python / C++ / Java / PHP / Pascal / Go / Rust）');
  const pm = pkgManager();
  const PKGS = {
    'apt-get': ['build-essential', 'python3', 'default-jdk', 'php-cli', 'fp-compiler', 'rustc'],
    dnf: ['gcc-c++', 'python3', 'java-17-openjdk-devel', 'php-cli', 'fpc', 'rust'],
    yum: ['gcc-c++', 'python3', 'java-17-openjdk-devel', 'php', 'fpc', 'rust'],
  };
  if (isWin) {
    infoLine('Windows 面板：评测语言需要自己装（可略过，站点照样能跑，未安装的语言会显示「未安装」）');
    infoLine('推荐装 Python（python.org）与 Dev-Cpp（自带 g++），装完跑 node deploy\\check-env.js 复核');
  } else if (SKIP_COMPILERS) {
    infoLine('（--no-compilers，已跳过）');
  } else if (!pm || !PKGS[pm.cmd]) {
    infoLine('没找到熟悉的包管理器，请手动安装：Python3、g++、JDK、PHP、FPC、Rust、Go（Go 需 ≥ 1.21）');
  } else {
    if (pm.list && !CHECK_ONLY) run(pm.list[0], pm.list.slice(1), { inherit: false });
    const cmd = `${pm.cmd} install -y ${PKGS[pm.cmd].join(' ')}`;
    if (CHECK_ONLY) {
      infoLine('将执行：' + cmd);
    } else if (!isRoot()) {
      warnLine('当前不是 root，无法自动安装；请用管理员执行：');
      out('     sudo ' + cmd);
      todo.push('以 root 执行上面的编译器安装命令');
    } else {
      infoLine('正在安装（约 1~3 分钟，请稍等）……');
      const r = run(pm.cmd, ['install', '-y', ...PKGS[pm.cmd]], { inherit: true });
      if (r.code === 0) okLine('编译器安装完成（Go 若缺失可到 https://go.dev/dl/ 单独安装，需 ≥ 1.21）');
      else {
        warnLine('安装过程中有报错，可稍后手动执行：' + cmd);
        todo.push('手动补装编译器：' + cmd);
      }
    }
  }

  /* ---- 5. 启动服务 ---- */
  step(5, TOTAL, '启动服务（后台运行，关掉终端也不停）');
  if (CHECK_ONLY) {
    infoLine(`（--check 模式，跳过启动；启动命令：node deploy/panel-install.js --start）`);
  } else if (!nv.ok) {
    warnLine('Node 版本不满足，先升级 Node 再启动（升级后运行 node deploy/panel-install.js --start）');
  } else if (!free) {
    const h = await waitReady(PORT, 3000);
    if (h) {
      okLine(`端口上已经有一个 LCZOJ 在跑（v${h.version}），直接用它就好，不再重复启动`);
    } else {
      warnLine(`端口 ${PORT} 被别的程序占用，先改 deploy/panel.env 里的 PORT 再启动`);
      todo.push('换一个端口（改 deploy/panel.env 的 PORT）后运行 node deploy/panel-install.js --start');
    }
  } else {
    const s = startService();
    if (s.already) {
      infoLine(`服务已在运行（PID ${s.pid}）`);
    } else {
      infoLine(`已后台启动（PID ${s.pid}），日志：logs/lczoj.log`);
    }
    const h = await waitReady(PORT);
    if (h) okLine(`网站已经跑起来了：http://127.0.0.1:${PORT}/　（版本 v${h.version}，可用评测语言 ${(h.languages || []).length} 种）`);
    else {
      warnLine('启动后 40 秒内健康检查未通过，看一眼日志：logs/lczoj.log');
      todo.push('查看 logs/lczoj.log 里的报错');
    }
    infoLine('停止服务：node deploy/panel-install.js --stop　重启：--stop 后再 --start');
  }

  /* ---- 6. 生成反代配置 + 环境自检 + 面板操作清单 ---- */
  step(6, TOTAL, '生成站点反代配置 + 环境自检');
  const snippet = CHECK_ONLY ? null : writeNginxSnippet();
  if (snippet) okLine('反向代理配置已生成：' + path.relative(ROOT, snippet) + '（复制它的内容到面板站点配置里）');
  if (CHECK_ONLY) infoLine('（--check 模式，跳过自检；随时可单独运行 node deploy/check-env.js）');
  else run(process.execPath, [path.join(__dirname, 'check-env.js')], { inherit: true });

  const startCmd = isWin ? 'deploy\\panel-start.bat' : 'bash deploy/panel-start.sh';
  out('');
  out('============================================================');
  out('  准备完成。接下来在面板中完成以下两步配置（约 1 分钟）');
  out('============================================================');
  out('');
  out('  ① 让域名能访问（面板站点反向代理）');
  out(`     宝塔：网站 → 你的站点 → 反向代理 → 目标 URL 填 http://127.0.0.1:${PORT}`);
  out('           或者在「配置文件」里粘贴 deploy/panel-nginx.conf 的内容（记得改 server_name）');
  out('     小皮：网站 → 站点 → 配置文件，粘贴 deploy/panel-nginx.conf 的内容');
  out('     生成的配置已包含 client_max_body_size 64m;（缺少该项时上传较大答案包会返回 413）');
  out('');
  out('  ② 上 HTTPS');
  out('     面板站点 → SSL → Let\'s Encrypt 一键申请 → 开启强制 HTTPS');
  out('');
  out('  打开网站');
  const lan = internalIp();
  const pub = await publicIp();
  if (pub) out(`     公网地址：http://${pub}${PORT === 80 ? '' : ':' + PORT}/　← 外网访问用这个（未配置域名时）`);
  else out(`     公网地址：未能自动识别，请用服务器公网 IP 访问（也可先设置环境变量 LCZOJ_PUBLIC_IP）`);
  if (lan) out(`     内网地址：http://${lan}${PORT === 80 ? '' : ':' + PORT}/　← 同一局域网内访问`);
  if (pub || lan) out(`     提示：云服务器需在【安全组 / 防火墙】放行 ${PORT} 端口；用面板 Nginx 反代时把 OJ_HOST 设为 0.0.0.0`);
  const pwd = initialAdminPassword();
  if (pwd) out(`     账号 admin　初始密码 ${pwd}（首次启动随机生成，登录后请立刻改密码）`);
  else out('     账号 admin　初始密码：首次启动时随机生成（见启动日志或 data/admin-password.txt）');
  out('');
  out('  以后想交给面板守护进程（开机自启 / 面板里看状态）');
  out(`     先停止本脚本启动的进程：node deploy/panel-install.js --stop`);
  out(`     再在面板里建 Node 项目：启动命令 ${startCmd}　端口 ${PORT}　运行用户 ${panelUser}`);
  out('     或者用 PM2：pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup');
  out('');
  out('  常用命令');
  out('     启动：node deploy/panel-install.js --start　　停止：--stop　　环境自检：node deploy/check-env.js');
  out('     更新到新版本：node deploy/update.js（会先备份数据库，再拉取新代码并重启）');
  out('  详细教程：docs/PANEL.md（面板）　docs/DOCKER.md（Docker）');
  if (todo.length) {
    out('');
    out('  还需要你手动完成：');
    todo.forEach((t, i) => out(`     ${i + 1}. ${t}`));
  }
  out('');
})();
