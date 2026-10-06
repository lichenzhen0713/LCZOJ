#!/usr/bin/env node
'use strict';
/**
 * LCZOJ 环境自检脚本（面板 / Docker / 裸机都能用）
 *
 * 用途：部署完（或部署失败时）先跑一次，一眼看清环境到底缺什么：
 *   node deploy/check-env.js
 *
 * 检查项：
 *   1) Node.js 版本与 node:sqlite 是否可用（低于 22.5 / 未带参数会直接报错）
 *   2) 端口是否被占用、监听地址配置
 *   3) 数据目录是否可写、剩余磁盘空间
 *   4) 各评测语言编译器是否存在、版本是否够用
 * 只做检查，不会修改任何数据。
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
let config;
try {
  config = require('../src/config');
} catch (err) {
  console.error('[自检] 无法加载 src/config.js：' + (err && err.message));
  process.exit(1);
}

const VERSION_ARGS_EXTRA = {
  python: ['--version'], python3: ['--version'], py: ['--version'],
  node: ['--version'], nodejs: ['--version'], php: ['--version'], rustc: ['--version'],
};
function versionArgs(name) {
  return (config.TOOL_VERSION_FLAGS && config.TOOL_VERSION_FLAGS[name]) || VERSION_ARGS_EXTRA[name] || ['--version'];
}

/** 与 src/judge.js 完全一致的版本号解析：取整段输出里第一个 x.y 形式的主版本号 */
function parseMajor(text) {
  const m = String(text || '').match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : null;
}

function line(char = '-') { console.log(char.repeat(60)); }
function title(t) { console.log(''); console.log('== ' + t + ' ' + '-'.repeat(Math.max(0, 56 - t.length))); }

function appVersion() {
  try { return require('../package.json').version || '未知'; } catch { return '未知'; }
}

function sqliteCheck() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (typeof DatabaseSync !== 'function') return { ok: false, note: 'node:sqlite 导出异常' };
    return { ok: true, note: '可用' };
  } catch (err) {
    return { ok: false, note: (err && err.message) || String(err) };
  }
}

function toolVersion(name) {
  const args = versionArgs(name);
  try {
    const r = spawnSync(name, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
    if (r.error) return null;
    const out = String((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
    if (!out.length) return null;
    return out[0].trim().slice(0, 80);
  } catch {
    return null;
  }
}

/**
 * 按候选顺序解析工具，**与判题侧 src/judge.js 的 resolveTool 行为一致**：
 * 逐个候选跑版本命令，版本低于最低要求的会被跳过并继续试下一个候选
 * （本机 PATH 上的 gcc 是 Free Pascal 自带的 2.95，判题会跳过它改用 MinGW64 里的 4.9.2）。
 * 返回 { path, version } 或 { rejected: [{path, version, major}] }。
 */
function resolveToolLike(name) {
  const minMajor = (config.TOOL_MIN_MAJOR || {})[name];
  const cands = (config.TOOLCHAIN_CANDIDATES[name] || [name])
    .map((c) => c.replace('{user}', process.env.USERNAME || process.env.USER || ''));
  const rejected = [];
  for (const c of cands) {
    const v = toolVersion(c);
    if (!v) continue;
    const major = parseMajor(v);
    // 与判题一致：版本号解析不出来时保守放行
    if (minMajor != null && major != null && major < minMajor) {
      rejected.push({ path: c, version: v, major });
      continue;
    }
    return { path: c, version: v, rejected };
  }
  return { rejected };
}

/** 端口状态探测：
 *  先尝试「连一下」——能连上说明已经有服务在监听（Windows 上重复 bind 不会报错，只看 bind 会误判）；
 *  连不上再尝试 bind，用来验证端口权限是否够（Linux 上非 root 绑 80 会失败）。 */
function probePort(port, host) {
  return new Promise((resolve) => {
    const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const sock = net.connect({ port, host: target });
    const done = (state) => { try { sock.destroy(); } catch { /* ignore */ } resolve(state); };
    sock.setTimeout(1500);
    sock.once('connect', () => done({ state: 'occupied' }));
    sock.once('timeout', () => done({ state: 'unknown' }));
    sock.once('error', () => {
      const srv = net.createServer();
      srv.once('error', (err) => resolve({ state: 'denied', note: (err && err.code) || String(err) }));
      srv.once('listening', () => srv.close(() => resolve({ state: 'free' })));
      try { srv.listen(port, host); } catch (err) { resolve({ state: 'denied', note: (err && err.code) || String(err) }); }
    });
  });
}

/** 端口被占用时，顺便看看占用者是不是 LCZOJ 自己（/api/health） */
async function identifyOccupier(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    if (data && data.status === 'up') {
      return `已被 LCZOJ 占用（版本 v${data.version || '?'}，已运行 ${data.uptime || 0}s，队列 ${data.queue || 0}）`;
    }
    return '已被其它服务占用（/api/health 有响应但不是 LCZOJ）';
  } catch {
    return '已被其它服务占用（不是 LCZOJ，或未开放 /api/health）';
  }
}

function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '.lczoj-write-test');
    fs.writeFileSync(f, 'ok');
    fs.unlinkSync(f);
    return { ok: true, note: '' };
  } catch (err) {
    return { ok: false, note: (err && err.message) || String(err) };
  }
}

function diskFree(dir) {
  try {
    const st = fs.statfsSync(dir);
    return (st.bavail * st.bsize) / 1024 / 1024 / 1024;
  } catch {
    return null;
  }
}

(async () => {
  line('=');
  console.log('  LCZOJ 环境自检 · 站点版本 v' + appVersion());
  line('=');

  /* ---------------- 系统与 Node ---------------- */
  title('1. 系统与 Node.js');
  console.log('  操作系统 : ' + `${os.type()} ${os.release()} (${process.platform}/${process.arch})`);
  console.log('  CPU / 内存: ' + `${(os.cpus() || []).length} 核 / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
  const major = parseInt(process.versions.node.split('.')[0], 10);
  const minor = parseInt(process.versions.node.split('.')[1] || '0', 10);
  console.log('  Node.js  : v' + process.versions.node + (major >= 24 ? '（推荐版本 ✓）' : major === 22 && minor >= 5 ? '（可用，需要 --experimental-sqlite，程序会自动加）' : '（版本过低 ✗ 需要 ≥ 22.5，推荐 v24）'));
  console.log('  执行文件 : ' + process.execPath);
  const sq = sqliteCheck();
  console.log('  node:sqlite: ' + (sq.ok ? '可用 ✓' : '不可用 ✗ ' + sq.note));
  if (!sq.ok) {
    console.log('    → 处理办法：升级到 Node.js v24，或用 `node --experimental-sqlite server.js` 启动');
  }

  /* ---------------- 环境变量与目录 ---------------- */
  title('2. 启动参数与数据目录');
  console.log('  PORT        = ' + config.PORT + '（环境变量 PORT，默认 80）');
  console.log('  OJ_HOST     = ' + config.HOST + '（环境变量 OJ_HOST，默认 0.0.0.0 = 所有网卡）');
  console.log('  OJ_DATA_DIR = ' + config.DATA_DIR + (process.env.OJ_DATA_DIR ? '（来自环境变量）' : '（默认 data/）'));
  console.log('  并行判题数  = ' + config.DEFAULTS.maxConcurrentJudges + '（环境变量 OJ_MAX_JUDGES）');
  console.log('  时区        = ' + (process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || '未知'));
  const w = dirWritable(config.DATA_DIR);
  console.log('  数据目录可写: ' + (w.ok ? '是 ✓' : '否 ✗ ' + w.note));
  if (!w.ok) {
    console.log('    → 面板部署常见原因：目录属主/权限不对（宝塔用 www 用户，小皮用站点用户），');
    console.log('      执行（最小权限，M16）：chown -R <服务账户>:<服务账户> ' + config.DATA_DIR
      + ' && chmod 711 ' + config.DATA_DIR + ' && chmod -R go-rwx ' + config.DATA_DIR + '/testdata');
console.log('      说明：data/ 用 711（降权后的选手要穿过去执行自己的程序），testdata 必须 700（隐藏测试数据）。');
    console.log('      Docker 部署：确认挂载卷权限（入口脚本会自动 chown 给容器内 oj 用户）');
  }
  const free = diskFree(config.DATA_DIR);
  if (free != null) {
    console.log('  剩余磁盘    : ' + free.toFixed(2) + ' GB' + (free < 2 ? ' ⚠ 建议至少保留 2GB（题库测试数据 + 判题缓存）' : ''));
  }
  const sub = ['judge', 'testdata', 'avatars', 'attachments'];
  const missing = sub.filter((d) => !fs.existsSync(path.join(config.DATA_DIR, d)));
  console.log('  子目录      : ' + (missing.length ? '缺少 ' + missing.join(', ') + '（启动服务时会自动创建）' : '齐全 ✓'));

  /* ---------------- 端口 ---------------- */
  title('3. 端口占用');
  const portState = await probePort(config.PORT, config.HOST);
  let portOk = true;
  if (portState.state === 'free') {
    console.log(`  ${config.HOST}:${config.PORT} 空闲 ✓ 可以启动`);
  } else if (portState.state === 'occupied') {
    portOk = false;
    console.log(`  ${config.HOST}:${config.PORT} 已被占用：` + await identifyOccupier(config.PORT));
    console.log('    → 若占用者就是 LCZOJ，说明服务已在运行（重复启动会失败，属正常）。');
    console.log('    → 若前面已有 Nginx（宝塔/小皮站点），请把站点反向代理到本服务，并给本服务换一个端口：');
    console.log('      PORT=3000 OJ_HOST=127.0.0.1 node server.js');
  } else if (portState.state === 'denied') {
    portOk = false;
    console.log(`  ${config.HOST}:${config.PORT} 无法绑定 ✗（${portState.note}）`);
    console.log('    → Linux 上普通用户不能直接绑 80/443：改用 3000 等高位端口（PORT=3000），');
    console.log('      或授予绑定权限：sudo setcap cap_net_bind_service=+ep "$(command -v node)"');
  } else {
    console.log(`  ${config.HOST}:${config.PORT} 状态未知（探测超时，可能是防火墙丢包，可忽略）`);
  }

  /* ---------------- 评测语言 ---------------- */
  title('4. 评测语言工具链');
  const langs = Object.values(config.LANGUAGES).filter((l) => !l.outputOnly);
  let okCount = 0;
  const badLangs = [];
  for (const lang of langs) {
    const tools = [lang.toolName].concat(lang.runToolName ? [lang.runToolName] : []);
    const parts = [];
    let allOk = true;
    for (const t of tools) {
      // 与判题侧同样的规则：逐个候选试，版本过低的跳过并继续试下一个（运行时工具如 java 同样处理）
      const found = resolveToolLike(t);
      const skipped = (found.rejected && found.rejected.length)
        ? '（已跳过 ' + found.rejected.map((r) => r.path + ' ' + r.version).join('、') + '：版本过低）'
        : '';
      if (!found.path) {
        allOk = false;
        const min = (config.TOOL_MIN_MAJOR || {})[t];
        parts.push(`${t} 不可用 ✗` + (skipped || (min != null ? `（未找到，或用主版本 < ${min} 的旧版本）` : '（未找到）')));
      } else {
        parts.push(`${found.path} → ${found.version}${skipped}`);
      }
    }
    if (allOk) okCount++;
    else badLangs.push(lang.name);
    console.log('  ' + (allOk ? '✓' : '✗') + ' ' + lang.name.padEnd(22, ' ') + parts.join('　|　'));
  }
  console.log('');
  console.log(`  可用语言：${okCount} / ${langs.length}`);
  if (okCount < langs.length) {
    console.log('  不可用语言：' + badLangs.join('、') + '（不影响站点运行，只影响对应语言的提交，前端会标「未安装」）');
    console.log('  Debian/Ubuntu 补装：apt-get install -y build-essential python3 default-jdk php-cli fp-compiler rustc');
    console.log('  Go 需 ≥ 1.21（判题写入的 go.mod 声明 go 1.21）：https://go.dev/dl/');
    console.log('  Docker 部署：官方镜像已预装全部工具链，直接用镜像即可。');
  }

  /* ---------------- 结论 ---------------- */
  title('5. 结论');
  const fatal = !sq.ok || !w.ok;
  if (fatal) {
    console.log('  ✗ 存在阻断项（node:sqlite 不可用 / 数据目录不可写），请先按上面的提示处理。');
  } else if (!portOk) {
    console.log('  ⚠ 环境基本可用，但当前端口不可用；换端口或停掉占用进程后即可启动。');
  } else if (okCount < langs.length) {
    console.log('  ✓ 站点可以启动，但部分评测语言缺少编译器（见第 4 节）。');
    console.log('    启动：node server.js　或　pm2 start deploy/ecosystem.config.js');
  } else {
    console.log('  ✓ 环境检查通过，可直接启动：node server.js');
    console.log('    或使用守护进程：pm2 start deploy/ecosystem.config.js');
  }
  console.log('');
  process.exit(fatal ? 1 : 0);
})();
