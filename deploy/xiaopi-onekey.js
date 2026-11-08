#!/usr/bin/env node
'use strict';
/**
 * 小皮面板「三步部署」极简入口（Windows 双击即可）
 * ---------------------------------------------------------------------------
 * 用法：
 *   deploy\xiaopi-onekey.bat                 # 双击：检查 + 一键准备 + 后台启动 + 打印三步指引
 *   node deploy/xiaopi-onekey.js --check     # 只看环境，什么都不改
 *   node deploy/xiaopi-onekey.js --port 8080 # 换端口
 *   node deploy/xiaopi-onekey.js --no-compilers
 *
 * 它做什么：
 *   1) 调 deploy/panel-install.js（已存在的一键脚本）做完所有重活：
 *      Node 版本检查 → data/ → panel.env → 编译器 → 启动 → 环境自检
 *   2) 额外生成**只含 9 行**的反代配置 deploy/xiaopi.conf（面板里直接粘贴）
 *   3) 最后只打印「三步」（其余细节一律不刷屏）
 *
 * 为什么单独写一个：panel-install.js 同时服务宝塔 / systemd / PM2 等多种场景，
 * 输出的指引比较全；小皮站长只需要最短路径，所以这里在外面包一层，不动主脚本。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const passthrough = args.filter((a) => a !== '--quiet');
const checkOnly = args.includes('--check');

function out(s) { process.stdout.write(s + '\n'); }
function line() { out('─'.repeat(64)); }

function readPort() {
  try {
    const env = fs.readFileSync(path.join(ROOT, 'deploy', 'panel.env'), 'utf8');
    const m = env.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch { /* 没有 panel.env 就用默认 */ }
  const i = args.indexOf('--port');
  if (i >= 0 && args[i + 1]) return parseInt(args[i + 1], 10);
  try {
    const env2 = fs.readFileSync(path.join(ROOT, 'deploy', 'panel.env'), 'utf8');
    const m2 = env2.match(/PORT=(\d+)/);
    if (m2) return parseInt(m2[1], 10);
  } catch { /* ignore */ }
  return 3000;
}

function writeXiaopiSnippet(port) {
  const f = path.join(ROOT, 'deploy', 'xiaopi.conf');
  const body = `# ===== LCZOJ × 小皮面板：把这 9 行粘到站点配置的 server { } 里 =====
# 面板：网站 → 你的站点 → 配置文件（或「反向代理」目标填 http://127.0.0.1:${port}）
# 注意：${port} 必须与 deploy/panel.env 里的 PORT 一致
client_max_body_size 64m;
location / {
    proxy_pass http://127.0.0.1:${port};
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
`;
  try { fs.writeFileSync(f, body, 'utf8'); return f; } catch { return null; }
}

/* ---------------- 1) 调用主脚本 ---------------- */
line();
out('  LCZOJ × 小皮面板 · 极简部署（三步）');
line();
out('  [1/3] 正在检查并准备环境（Node → 数据目录 → 启动参数 → 启动服务）…');
out('');

const child = spawnSync(process.execPath, [path.join(ROOT, 'deploy', 'panel-install.js'), ...passthrough], {
  cwd: ROOT,
  // --check 只想要结论：捕获输出后只挑关键行，不刷屏；正常部署则实时透传进度
  stdio: checkOnly ? 'pipe' : 'inherit',
  encoding: 'utf8',
});

if (checkOnly) {
  const text = String((child.stdout || '') + (child.stderr || ''));
  const all = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keep = all.filter((l) => /^[✓✗]/.test(l));                    // 只留结论行
  const key = all.filter((l) => /^计划端口|^项目目录/.test(l));         // 两行上下文
  out('');
  for (const l of key) out('  ' + l);
  for (const l of keep) out('  ' + l);
  out('');
  out('  ' + (child.status === 0 ? '✓ 环境没问题，可以正式部署了：双击 deploy\\xiaopi-onekey.bat' : '✗ 环境有问题，见上面的 ✗ 行'));
  process.exit(child.status || 0);
}

if (child.status !== 0) {
  out('');
  out('  ✗ 准备失败（见上面的错误信息）。常见原因：');
  out('    · 没装 Node.js 或版本 < 22.5 → 装 v24 后重开终端再运行');
  out('    · 端口被占用 → 换成 --port 8080 重试');
  process.exit(child.status || 1);
}

if (checkOnly) {
  out('');
  out('  （--check 模式：以上只是检查，没有修改任何文件、也没有启动服务）');
  process.exit(0);
}

/* ---------------- 2) 生成极简反代配置 ---------------- */
const port = readPort();
const conf = writeXiaopiSnippet(port);

/* ---------------- 3) 只打印三步 ---------------- */
line();
out('  只差三步，站点就能上线：');
out('');
out('  ① 小皮面板 → 网站 → 创建网站（填域名，PHP 随便选；本站不用 PHP）');
out('');
out('  ② 该站点 → 配置文件，把下面这段粘进 server { } 里（或「反向代理」目标填');
out('     http://127.0.0.1:' + port + '）：');
out('');
try {
  const body = fs.readFileSync(conf, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join('\n');
  for (const l of body.split('\n')) out('     ' + l);
} catch { out('     （见 deploy/xiaopi.conf）'); }
out('');
out('     然后点「重载配置」/ 重启 Nginx。');
out('');
out('  ③ 浏览器打开 http://你的域名/ → 用 admin + 首次启动打印的初始密码登录 → 改密码。');
out('');
if (conf) out('  （这段配置也已存到 deploy/xiaopi.conf，随时可再复制；端口 ' + port + '）');
out('');
out('  验证：http://你的域名/api/health 应返回 {"success":true,"status":"up"}');
out('  开机自启：面板 → 计划任务 → cmd /c "cd /d ' + ROOT + ' && deploy\\panel-start.bat"（触发=开机启动）');
line();
