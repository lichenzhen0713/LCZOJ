#!/usr/bin/env node
'use strict';
/**
 * LCZOJ Docker 一键部署（构建镜像 → 启动容器 → 等它健康 → 告诉你网址）
 *
 *   node deploy/docker-onekey.js                # 默认映射到宿主机 80 端口（被占用时自动改用 8080）
 *   node deploy/docker-onekey.js --port 8080    # 指定宿主机端口
 *   node deploy/docker-onekey.js --rebuild      # 重新构建镜像（代码更新后用）
 *   node deploy/docker-onekey.js --stop         # 停止并删除容器（数据卷保留，数据不会丢）
 *   node deploy/docker-onekey.js --logs         # 查看实时日志
 *
 * 也可以用等价的 compose 命令：docker compose up -d --build
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'lczoj';
const VOLUME = 'lczoj-data';
const isWin = process.platform === 'win32';

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
LCZOJ Docker 一键部署

  node deploy/docker-onekey.js                 构建并启动（没装 Docker 会自动装好）
  node deploy/docker-onekey.js --port 8080     指定宿主机端口
  node deploy/docker-onekey.js --rebuild       强制重新构建镜像
  node deploy/docker-onekey.js --stop          停止并删除容器（数据卷保留）
  node deploy/docker-onekey.js --logs          查看实时日志
  node deploy/docker-onekey.js --no-install-docker  不自动安装 Docker
  node deploy/docker-onekey.js --help          显示本帮助

  全新服务器更省事的一条命令（连项目一起下载，自动装 Docker）：
    curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/docker-bootstrap.sh | sudo bash

  等价命令：docker compose up -d --build  /  docker compose logs -f  /  docker compose down
`);
  process.exit(0);
}

const out = (s = '') => console.log(s);
const okLine = (s) => out('   ✓ ' + s);
const warnLine = (s) => out('   ! ' + s);
const infoLine = (s) => out('   · ' + s);

function docker(dockerArgs, opts = {}) {
  const r = spawnSync('docker', dockerArgs, {
    encoding: 'utf8',
    timeout: opts.timeout || 1800000,
    windowsHide: true,
    stdio: opts.inherit ? 'inherit' : 'pipe',
    cwd: ROOT,
  });
  return { code: r.status == null ? 1 : r.status, out: String((r.stdout || '') + (r.stderr || '')), error: r.error };
}

function appVersion() {
  try { return require('../package.json').version || '0.0.0'; } catch { return '0.0.0'; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, '0.0.0.0'); } catch { resolve(false); }
  });
}

async function pickPort(wanted) {
  if (wanted) return { port: wanted, auto: false };
  for (const p of [80, 8080, 8888, 18080]) {
    if (await portFree(p)) return { port: p, auto: p !== 80 };
  }
  return { port: 0, auto: false };
}

async function waitHealthy(port, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/* ---------------- Docker 检测 / 自动安装 ---------------- */
function dockerUsable() {
  const r = docker(['version', '--format', '{{.Server.Version}}']);
  return r.code === 0 && !!r.out.trim();
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
const hasSudo = () => !isWin && (isRoot() || spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', windowsHide: true }).status === 0);

/** 没有 Docker 时：Linux 上尝试一键装好；Windows / macOS 只能装 Docker Desktop */
function installDocker() {
  if (isWin || process.platform === 'darwin') {
    warnLine('这个系统需要手动安装 Docker Desktop（装完重启终端再运行本脚本）：');
    infoLine('下载地址：https://www.docker.com/products/docker-desktop/');
    infoLine('Windows 安装时请勾选 WSL2，装完打开 Docker Desktop（托盘出现鲸鱼图标）');
    return false;
  }
  if (!hasSudo()) {
    warnLine('没有 root / sudo 权限，无法自动安装 Docker。请用管理员执行下面两条命令后重试：');
    out('     curl -fsSL https://get.docker.com | sudo sh');
    out('     sudo systemctl enable --now docker');
    return false;
  }
  infoLine('正在自动安装 Docker（官方脚本，约 1~3 分钟）……');
  const prefix = isRoot() ? [] : ['sudo'];
  const cmd = 'curl -fsSL https://get.docker.com | ' + (isRoot() ? '' : 'sudo ') + 'sh';
  const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    warnLine('Docker 自动安装失败，请手动安装后重试：curl -fsSL https://get.docker.com | sh');
    return false;
  }
  spawnSync(prefix[0] || 'systemctl', prefix.length ? ['systemctl', 'enable', '--now', 'docker'] : ['enable', '--now', 'docker'], { stdio: 'inherit', windowsHide: true });
  if (!dockerUsable()) {
    warnLine('Docker 装好了但当前终端还连不上它，请重新登录服务器（或执行 newgrp docker）后重试');
    return false;
  }
  okLine('Docker 安装完成：' + docker(['--version']).out.trim().split('\n')[0]);
  return true;
}

(async () => {
  out('');
  out('============================================================');
  out(`  LCZOJ Docker 部署（站点版本 v${appVersion()}）`);
  out('============================================================');

  /* ---- 0. 检查 Docker（没有就自动装） ---- */
  if (!dockerUsable()) {
    if (docker(['--version']).code === 0) {
      warnLine('检测到 docker 命令，但连不上 Docker 服务（Docker 没启动？）');
      if (!isWin) infoLine('启动一下：sudo systemctl start docker');
      else infoLine('Windows / macOS：打开 Docker Desktop，等托盘图标变成运行中再试');
      process.exit(1);
    }
    warnLine('没有检测到 Docker');
    if (has('--no-install-docker')) {
      infoLine('已指定 --no-install-docker，不自动安装。手动安装后重试即可');
      process.exit(1);
    }
    if (!installDocker()) process.exit(1);
  }
  okLine('Docker 可用：' + docker(['--version']).out.trim().split('\n')[0]);

  /* ---- --stop / --logs 快捷操作 ---- */
  if (has('--stop')) {
    infoLine('停止并删除容器（数据卷 ' + VOLUME + ' 保留，题库与提交都还在）');
    docker(['rm', '-f', CONTAINER], { inherit: true });
    out('');
    out('  已停止。想重新启动：node deploy/docker-onekey.js');
    out('  想彻底清空数据：docker volume rm ' + VOLUME + '（危险，会删除全部题库与提交）');
    out('');
    process.exit(0);
  }
  if (has('--logs')) {
    infoLine('按 Ctrl+C 退出日志（不会停止容器）');
    docker(['logs', '-f', '--tail', '200', CONTAINER], { inherit: true });
    process.exit(0);
  }

  const image = `lczoj:${appVersion()}`;

  /* ---- 1. 构建镜像 ---- */
  out('');
  out('【1/4】构建镜像 ' + image);
  const hasImage = docker(['image', 'inspect', image]).code === 0;
  if (hasImage && !has('--rebuild')) {
    infoLine('镜像已存在，跳过构建（代码有更新时请加 --rebuild，或用 docker compose up -d --build）');
  } else {
    infoLine('首次构建需要下载基础镜像并安装评测语言，约 3~10 分钟，请耐心等待……');
    const r = docker(['build', '-t', image, '.'], { inherit: true });
    if (r.code !== 0) {
      warnLine('镜像构建失败，请把上面的报错发出来（常见原因：网络无法访问镜像源）');
      process.exit(1);
    }
    okLine('镜像构建完成：' + image);
  }

  /* ---- 2. 选端口 ---- */
  out('');
  out('【2/4】选择访问端口');
  const picked = await pickPort(argValue('--port', ''));
  if (!picked.port) {
    warnLine('80 / 8080 / 8888 / 18080 都被占用了，请手动指定：node deploy/docker-onekey.js --port 9000');
    process.exit(1);
  }
  const HOST_PORT = picked.port;
  if (picked.auto) infoLine(`宿主机的 80 端口被占用（多半是 Nginx），自动改用 ${HOST_PORT}`);
  okLine(`将使用 http://服务器IP${HOST_PORT === 80 ? '' : ':' + HOST_PORT}/`);

  const judges = Math.max(2, Math.min(4, (os.cpus() || []).length - 1 || 2));

  /* ---- 3. 启动容器 ---- */
  out('');
  out('【3/4】启动容器');
  const exists = docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.Names}}']).out.trim();
  if (exists) {
    infoLine('已存在同名容器，先移除旧的（数据卷 ' + VOLUME + ' 不受影响）');
    docker(['rm', '-f', CONTAINER], { inherit: true });
  }
  const runArgs = [
    'run', '-d',
    '--name', CONTAINER,
    '--restart', 'unless-stopped',
    '-p', `${HOST_PORT}:80`,
    '-v', `${VOLUME}:/app/data`,
    '-e', `OJ_MAX_JUDGES=${judges}`,
    '-e', 'TZ=Asia/Shanghai',
    image,
  ];
  infoLine('docker ' + runArgs.join(' '));
  const runRes = docker(runArgs, { inherit: true });
  if (runRes.code !== 0) {
    warnLine('容器启动失败：端口被占用请换 --port，权限问题请确认当前用户在 docker 组内');
    process.exit(1);
  };
  okLine('容器已启动（并行判题数 ' + judges + '）');

  /* ---- 4. 等它健康 ---- */
  out('');
  out('【4/4】等待服务就绪（首次启动要初始化数据库，通常 10~30 秒）');
  const health = await waitHealthy(HOST_PORT);
  if (!health) {
    warnLine('等了 2 分钟还没就绪，看看日志：node deploy/docker-onekey.js --logs');
    process.exit(1);
  }
  okLine(`服务已就绪：版本 v${health.version}，可用评测语言 ${(health.languages || []).length} 种`);

  out('');
  out('============================================================');
  out('  部署完成！');
  out('============================================================');
  out(`  网址：http://服务器IP${HOST_PORT === 80 ? '' : ':' + HOST_PORT}/`);
  out('  账号：admin　密码：admin123（登录后请立刻修改）');
  out('');
  out('  常用命令：');
  out('    node deploy/docker-onekey.js --logs     看日志');
  out('    node deploy/docker-onekey.js --stop     停止（数据保留）');
  out('    node deploy/docker-onekey.js --rebuild  代码更新后重新构建启动');
  out('    备份数据：docker run --rm -v ' + VOLUME + ':/d -v "$PWD:/b" alpine tar czf /b/lczoj-data.tar.gz -C /d .');
  out('');
  out('  想用域名 + HTTPS：把域名解析到本机，再用 Nginx 反向代理到 127.0.0.1:' + HOST_PORT);
  out('  （配置示例见 deploy/nginx-lczoj.conf，或面板里的「反向代理」功能）');
  out('');
})();
