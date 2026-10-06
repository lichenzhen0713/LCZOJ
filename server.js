'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { PORT, HOST, DATA_DIR, PUBLIC_DIR, DOCS_DIR, VERDICTS, DIFFICULTIES, ensureDirs } = require('./src/config');
const { db, getAdminInitInfo } = require('./src/db');
const {
  currentUser, createSession, destroySession, registerUser, loginUser, setSessionCookie, clearSessionCookie,
  hasPerm, PERMISSION_LABELS, clientIp, throttleStatus, throttleFail, throttleReset, throttleMessage,
  resendLimitStatus, resendLimitHit, resendLimitMessage,
} = require('./src/auth');
const { readJsonBody, ok, fail, sendJson, escapeHtml, contentDisposition } = require('./src/util');
const { markdownToHtml } = require('./src/markdown');
const problems = require('./src/problems');
const submissions = require('./src/submissions');
const ranking = require('./src/ranking');
const discussion = require('./src/discussion');
const users = require('./src/users');
const contest = require('./src/contest');
const editorial = require('./src/editorial');
const taxonomy = require('./src/taxonomy');
const attachments = require('./src/attachments');
const notifications = require('./src/notifications');
const messages = require('./src/messages');

const { JudgeQueue, availableLanguages, cleanJudgeWorkDirs, pruneSpjCache, pruneGoCache, pruneInteractorCache } = require('./src/judge');

ensureDirs();
const queue = new JudgeQueue();
// 并行判题数：优先取系统设置里的 judge_concurrency，其次环境变量 / 默认值
try {
  const settings = require('./src/settings');
  const saved = parseInt(settings.getSetting('judge_concurrency', ''), 10);
  if (Number.isFinite(saved) && saved > 0) queue.setConcurrency(saved);
} catch { /* ignore */ }

/**
 * 定期清理评测缓存与临时文件（启动时执行一次，之后每 10 分钟一次）：
 *   1) data/judge 下超过 30 分钟的评测工作目录与散落临时文件（正常评测结束已即时删除，这里处理崩溃残留）
 *   2) data/spj_cache 里 SPJ checker 编译缓存：**只做过期/超量淘汰**（保留最近使用的若干个，不整目录清空），
 *      这样同一道题的 checker 只需编译一次，后续评测直接复用
 *   3) data/gocache 里超过 1 天 / 总量超过 100MB 的 Go 构建缓存
 *   4) data/interactor_cache 里交互器 / grader 编译缓存：同样只做过期 / 超量淘汰（M8）
 * 只清理缓存与临时产物；题库测试数据、附件、头像、数据库等数据一律不动。
 */
function maintainJudgeCaches(label) {
  const parts = [];
  try {
    const r = cleanJudgeWorkDirs(label === 'startup' ? 0 : 30 * 60 * 1000);
    if (r && r.removed) parts.push(`判题工作目录 ${r.removed} 个/${(r.freedBytes / 1024 / 1024).toFixed(1)}MB`);
  } catch { /* ignore */ }
  try {
    const s = pruneSpjCache();
    if (s && s.removed) parts.push(`SPJ 编译缓存淘汰 ${s.removed} 个（保留 ${s.kept} 个）`);
  } catch { /* ignore */ }
  try {
    // M8：交互器 / grader 编译缓存此前只在编译未命中时清理，缓存目录不参与定期维护
    const i = pruneInteractorCache();
    if (i && i.removed) parts.push(`交互器编译缓存淘汰 ${i.removed} 个（保留 ${i.kept} 个）`);
  } catch { /* ignore */ }
  try {
    const g = pruneGoCache(100, 1);
    if (g && g.removed) parts.push(`Go 构建缓存 ${g.removed} 个/${(g.freedBytes / 1024 / 1024).toFixed(1)}MB`);
  } catch { /* ignore */ }
  if (parts.length) console.log(`[OJ] 评测缓存清理（${label}）：` + parts.join('，'));
}

maintainJudgeCaches('startup');
setInterval(() => maintainJudgeCaches('定期'), 10 * 60 * 1000);

// 重启后重新入队未完成的提交
function requeueStale() {
  db.prepare("UPDATE submissions SET status = 'Pending', verdict = 'Pending' WHERE status = 'Judging'").run();
  const stale = db.prepare("SELECT id FROM submissions WHERE status = 'Pending'").all();
  for (const r of stale) queue.submit(r.id);
  if (stale.length) console.log(`[OJ] 重新入队 ${stale.length} 条未完成提交`);
}
requeueStale();

// v2.5.0：启动自愈坏掉的头像文件（0 字节 / 截断 / 非图片但数据库里已写着本站头像地址）。
// 这样 admin 这类「文件存在但内容无效」的账号在服务启动后立刻恢复出可解码的头像，
// 而不必等到第一次请求；外链头像与从未设置头像的用户不受影响。
try {
  const healed = require('./src/avatars').healBrokenFiles(db);
  if (healed) console.log(`[OJ] 已重建 ${healed} 个损坏/缺失的头像文件`);
} catch { /* ignore */ }

/* ==================== 全站积分结算调度器（随服务启动） ====================
 * 背景：「全站积分结算」（users.settleAllPoints）把某一时刻**全部用户**的四维积分落库成快照
 * （points_settlement 表），供排行榜 / 个人中心一次性读取，并留下可追溯的历史。
 * 结算方式由管理员在「系统设置 → 功能设置 → 全站积分结算」里选：
 *   · realtime 实时（**默认**，v2.7.8 起）：每次 tick 都执行一轮（等效每分钟一次；
 *              快照只作历史，读取侧仍走实时计算）；
 *   · manual   手动结算：调度器**什么也不做**（零副作用，连 last_run 都不写），
 *              只有管理员点「立即结算全站积分」按钮才执行一次；
 *   · interval 定时自动：距上次结算超过 points_settle_interval_minutes
 *              （**1 小时 ~ 30 天** = 60 ~ 43200 分钟，界面按小时/天录入）才执行一轮。
 * 设计要点：
 *   1) 每 60 秒一个 tick，timer.unref() —— 不阻止进程退出；启动后延迟 5 秒先试跑一次；
 *   2) **每个 tick 现读设置**（不缓存）→ 后台改完保存即生效，不需要重启服务；
 *   3) 结算内部先逐场预热榜单缓存、再按固定批大小（POINTS_SETTLE_CHUNK 人 / 批）执行，
 *      批间用 setImmediate 让出事件循环（见 users.settleAllPoints）—— 单次连续阻塞远小于整轮全量；
 *   4) 防重入锁 + 整体 try/catch：任何异常只写日志，绝不影响 HTTP 服务；
 *   5) 执行完写一条 admin_audit（action = auto_settle_points，含模式 / 覆盖人数 / 耗时）；
 *   6) OJ_DISABLE_POINTS_SETTLE=1 可整体关闭（测试 / 迁移时用）。
 */
let pointsSettleRunning = false;

/** 写一条全站积分结算审计（admin_audit；不参与 clear_all，只增不删） */
function auditPointsSettle(action, info, actor) {
  const detail = `全站积分结算：模式 ${info.mode}，覆盖 ${info.users} 人，耗时 ${info.ms}ms`
    + (info.failed ? `，失败 ${info.failed} 批` : '');
  try {
    db.prepare('INSERT INTO admin_audit (created_at, actor_id, actor_name, target_id, target_name, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), (actor && actor.id) || 0, (actor && actor.name) || '', 0, '全站', action, detail, (actor && actor.ip) || '');
  } catch (e) {
    console.warn('[OJ] 写入全站积分结算审计失败：' + (e && e.message));
  }
}

/** 执行一轮全站积分结算：落库快照 → 推进 last_run → 写审计 → 打印日志（手动按钮与调度器共用）。
 *  全局防重入：同一时刻只允许一轮（手动按钮与自动 tick 共用同一把锁），
 *  否则两个结算会在批间 await 处交错，互相抢 SQLite 事务。异常一律向上抛给调用方处理，这里不吞。 */
async function runPointsSettle(mode, reason, actor) {
  if (pointsSettleRunning) throw new Error('已有一次全站积分结算正在进行，请稍后再试');
  pointsSettleRunning = true;
  try {
    const settings = require('./src/settings');
    const r = await users.settleAllPoints();
    // 整轮没有失败批才推进「上次结算时间」；有失败 → 保持原值，下个 tick 自然重试
    if (!r.failed) {
      settings.setSetting('points_settle_last_run', String(Date.now()));
      settings.setSetting('points_settle_last_ms', String(r.ms));
      settings.setSetting('points_settle_last_users', String(r.ok));
    }
    const action = mode === 'manual' ? 'manual_settle_points' : 'auto_settle_points';
    auditPointsSettle(action, { mode: `${mode}/${reason}`, users: r.ok, ms: r.ms, failed: r.failed },
      actor || { id: 0, name: 'system', ip: '' });
    console.log(`[OJ] 全站积分结算（${mode}/${reason}）：${r.ok}/${r.users} 人，耗时 ${r.ms}ms，`
      + `单批最长 ${r.max_chunk_ms}ms，批大小 ${r.chunk_size}` + (r.failed ? `，${r.failed} 批失败` : ''));
    if (r.failed) for (const f of r.failures) console.warn(`[OJ] 全站积分结算失败批次 ${f.from}~${f.to}：${f.error}`);
    return { ...r, action };
  } finally {
    pointsSettleRunning = false;
  }
}

/** 一个 tick：按当前设置决定是否执行一轮全站积分结算 */
function runPointsSettleTick(reason = 'tick') {
  if (String(process.env.OJ_DISABLE_POINTS_SETTLE || '') === '1') return;
  if (pointsSettleRunning) return;                                   // 上一轮还没跑完 → 跳过本 tick（防重入）
  try {
    const mode = users.getPointsSettleMode();
    if (mode === 'manual') return;                                   // 手动：零副作用，连 last_run 都不动
    const last = users.getPointsSettleLastRun();
    const interval = users.getPointsSettleIntervalMinutes();
    if (mode === 'interval' && last && Date.now() - last < interval * 60000) return;
    Promise.resolve()
      .then(() => runPointsSettle(mode, reason, null))
      .catch((e) => console.error('[OJ] 全站积分结算异常：', (e && e.stack) || e));
  } catch (e) {
    console.error('[OJ] 全站积分结算调度异常：', (e && e.stack) || e);
  }
}

let pointsSettleTimer = null;
function startPointsSettleScheduler(tickMs = users.POINTS_SETTLE_TICK_MS) {
  if (pointsSettleTimer) return pointsSettleTimer;
  if (String(process.env.OJ_DISABLE_POINTS_SETTLE || '') === '1') {
    console.log('[OJ] 全站积分结算调度器已关闭（OJ_DISABLE_POINTS_SETTLE=1）');
    return null;
  }
  try {
    const first = setTimeout(() => runPointsSettleTick('startup'), 5000);
    if (first.unref) first.unref();
    pointsSettleTimer = setInterval(() => runPointsSettleTick('tick'), tickMs);
    if (pointsSettleTimer.unref) pointsSettleTimer.unref();
  } catch (e) {
    pointsSettleTimer = null;
    console.warn('[OJ] 全站积分结算调度器启动失败：' + (e && e.message));
  }
  return pointsSettleTimer;
}
startPointsSettleScheduler();

// ---------------- 中间件 ----------------

/* ============================ 安全响应头 + CSRF（M15） ============================
 * 所有响应统一带 nosniff / X-Frame-Options / Referrer-Policy / CSP frame-ancestors，
 * 防止 MIME 嗅探、点击劫持与 Referer 泄漏；写接口校验同源（Origin → Sec-Fetch-Site → Referer），
 * 三者都缺失时（curl / 运维脚本等非浏览器调用）放行，避免破坏既有脚本调用。
 */
function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
}

function hostOfUrl(value) {
  try { return new URL(String(value)).host; } catch { return ''; }
}

/** 写接口同源校验：返回 { ok } 或 { ok:false, reason } */
function csrfCheck(req) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true };
  // 逃生阀：极端反代场景（Host 被改写导致同源判定失败）可用 OJ_DISABLE_CSRF=1 关闭
  if (String(process.env.OJ_DISABLE_CSRF || '') === '1') return { ok: true };
  const host = String(req.headers.host || '');
  const origin = String(req.headers.origin || '');
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  const referer = String(req.headers.referer || '');
  if (origin) {
    if (origin === 'null' || !host) return { ok: false, reason: '跨源请求被拒绝（Origin 不合法）' };
    return hostOfUrl(origin) === host
      ? { ok: true }
      : { ok: false, reason: '跨源请求被拒绝（Origin 与本站不一致）' };
  }
  if (site === 'same-origin' || site === 'none') return { ok: true };
  if (site) return { ok: false, reason: `跨源请求被拒绝（Sec-Fetch-Site: ${site}）` };
  if (referer) {
    return (!host || hostOfUrl(referer) === host)
      ? { ok: true }
      : { ok: false, reason: '跨源请求被拒绝（Referer 与本站不一致）' };
  }
  return { ok: true };
}

/** L3：先按 Content-Length 预检请求体大小，超限回 413（util.readJsonBody 内部还有一层兜底，二者兼容） */
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`请求体过大（上限 ${(limit / 1024 / 1024).toFixed(limit % (1024 * 1024) === 0 ? 0 : 1)}MB）`);
    this.http413 = true;
    this.status = 413;
  }
}

async function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  const raw = req.headers['content-length'];
  const len = parseInt(raw == null ? '' : String(raw), 10);
  if (Number.isFinite(len) && len > limit) throw new BodyTooLargeError(limit);
  return readJsonBody(req, limit);
}

/** 读取**原始字节**请求体（v2.7.9：网站图标上传支持 curl --data-binary 直传图片）。
 *  与 readBody 一样先按 Content-Length 预检，边收边累加，超限即抛 413；
 *  只在 Content-Type 不是 JSON 时使用，JSON 路径仍走 readBody 的解析。 */
async function readRawBody(req, limit = 1024 * 1024) {
  const raw = req.headers['content-length'];
  const len = parseInt(raw == null ? '' : String(raw), 10);
  if (Number.isFinite(len) && len > limit) throw new BodyTooLargeError(limit);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new BodyTooLargeError(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 解析图标上传的 data URL（仅 image/png|jpeg|svg+xml|x-icon|webp；非法返回 null） */
function parseFaviconDataUrl(s) {
  const m = /^data:(image\/(?:png|jpe?g|svg\+xml|x-icon|vnd\.microsoft\.icon|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!buf.length) return null;
    return { buf, mime: m[1].toLowerCase() };
  } catch { return null; }
}

/** 413 响应：先把剩余请求体丢弃再回状态码。
 *  注意不要加 Connection: close 后立刻销毁 socket —— 客户端还在上传时会收到 RST，
 *  fetch 报 ECONNRESET、curl/浏览器都看不到状态码。Node 会在请求体收完后自行结束连接。 */
function respond413(req, res, err) {
  if (res.headersSent) return;
  try { req.resume(); } catch { /* ignore */ }
  fail(res, 413, (err && err.message) || '请求体过大');
}

/** 按 UID 或用户名解析用户（用户标识统一为 uid，兼容用户名） */
function resolveUserIdent(ident) {
  // 个人中心统一以 UID 为标识，不再支持用户名访问
  const s = String(ident || '').trim();
  if (!/^\d+$/.test(s)) return null;
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(parseInt(s, 10));
}

/** 路径段解码：板块 / 分类的 key 可能含中文（例如系统分类「题解」被编码成 %E9%A2%98%E8%A7%A3），
 *  畸形编码（如裸 %）时回退原值，交给上层按「不存在」处理，绝不让 URL 解析异常冒泡成 500。 */
function decodeSeg(v) {
  const s = String(v == null ? '' : v);
  try { return decodeURIComponent(s); } catch { return s; }
}

function requireAuth(req, res) {
  const user = currentUser(req);
  if (!user) { fail(res, 401, '请先登录'); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.is_admin) { fail(res, 403, '需要管理员权限'); return null; }
  return user;
}

function requireSuperAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.is_superadmin) { fail(res, 403, '需要超级管理员权限'); return null; }
  return user;
}

/** 需要指定权限（超级管理员拥有全部权限） */
function requirePerm(key) {
  return (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return null;
    if (!hasPerm(user, key)) {
      fail(res, 403, `你没有「${PERMISSION_LABELS[key] || key}」权限`);
      return null;
    }
    return user;
  };
}

/** 需要任一权限 */
function requireAnyPerm(keys) {
  return (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return null;
    if (!keys.some((k) => hasPerm(user, k))) {
      fail(res, 403, '你没有执行该操作的权限');
      return null;
    }
    return user;
  };
}

// ---------------- 静态文件 ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// 站点版本号（与 package.json / CHANGELOG.md 保持一致，系统设置页会显示）
const VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

// v2.8.0：SMTP 授权码的「回显掩码」机制已整体移除（SMTP_PASS_MASK 常量删除）。
// 现在 GET /api/settings 回真实值、PUT 提交什么就存什么，授权码在管理态始终可见可改。

// 静态资源缓存：
//  - fileCache：文件内容按「路径 + mtime + 大小」缓存，命中时不再读磁盘（每次请求只做一次 statSync）
//  - staticGzipCache：gzip 结果缓存（键含 mtime，避免"等长修改"发出旧内容）
const staticFileCache = new Map();
const staticGzipCache = new Map();

/** 读取静态文件：优先内存缓存，文件变更（mtime/大小）后自动失效 */
function readStaticFile(filePath, cb) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { cb(null); return; }
    const key = filePath;
    const stamp = st.mtimeMs + ':' + st.size;
    const hit = staticFileCache.get(key);
    if (hit && hit.stamp === stamp) { cb(hit.data, stamp); return; }
    fs.readFile(filePath, (e2, data) => {
      if (e2) { cb(null); return; }
      if (staticFileCache.size > 120) staticFileCache.clear();
      staticFileCache.set(key, { stamp, data });
      cb(data, stamp);
    });
  });
}

/** 弱 ETag（mtime+size），用于 If-None-Match 判断，让重复访问直接回 304 */
function etagOf(stamp) {
  return '"' + require('crypto').createHash('sha1').update(String(stamp)).digest('hex').slice(0, 20) + '"';
}

/* ---------------- 网站图标（favicon）统一响应 ----------------
 * /api/favicon 与根目录兜底 /favicon.ico 共用本函数，保证两个地址**永远是同一份字节**。
 * 已上传自定义图标 → 回自定义图；未上传 / 文件损坏或丢失 / 恢复默认 → 站点默认 Logo（SVG）。
 * 任何情况下都是 200 + 正确 Content-Type，绝不 404；带 ETag 支持 304。
 * 为什么需要 /favicon.ico 兜底：老标签页、书签、部分浏览器与爬虫在 <link rel="icon">
 * 不被认时会直接请求站点根目录的 /favicon.ico；此前它落到静态目录并 404（实测），
 * 这正是「站点看起来没有图标」的另一条失效路径。 */
function sendFavicon(req, res) {
  const favicon = require('./src/favicon');
  const cur = favicon.load();
  const etag = '"' + require('crypto').createHash('sha1').update(cur.buf).digest('hex').slice(0, 20) + '"';
  const headers = {
    'Content-Type': cur.mime,
    'Content-Length': cur.buf.length,
    'ETag': etag,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (String(req.headers['if-none-match'] || '') === etag) {
    delete headers['Content-Length'];
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(cur.buf);
}

function serveStatic(req, res, pathname) {  let rel = pathname === '/' ? '/index.html' : pathname;
  // 文档目录（docs/）：仅允许 Markdown 文件，渲染为带左侧目录导航的 HTML 页面，供站内「使用说明」等链接访问
  if (rel.startsWith('/docs/')) {
    const docRel = rel.slice(5);
    if (!docRel.toLowerCase().endsWith('.md')) { res.writeHead(404); res.end('Not Found'); return; }
    const docPath = path.resolve(DOCS_DIR, '.' + docRel);
    const docSafe = docPath === DOCS_DIR || docPath.startsWith(DOCS_DIR + path.sep);
    if (!docSafe) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(docPath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
      const title = path.basename(docRel, '.md');
      const mdText = data.toString('utf8');
      const body = markdownToHtml(mdText, { headingIds: true });
      // 左侧目录：解析 Markdown 标题（#~###）生成锚点，当前文档高亮
      const toc = buildDocToc(mdText, docRel);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - LCZOJ 文档</title><style>
        *{box-sizing:border-box}
        body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#333;background:#fafafa}
        a{color:#3498db;text-decoration:none}a:hover{text-decoration:underline}
        .layout{display:flex;max-width:1200px;margin:0 auto;min-height:100vh}
        .sidebar{width:230px;flex-shrink:0;background:#fff;border-right:1px solid #eee;padding:18px 12px 40px;position:sticky;top:0;height:100vh;overflow-y:auto}
        .sidebar .brand{font-size:16px;font-weight:700;padding:2px 10px 12px;border-bottom:1px solid #eee;margin-bottom:8px;display:block}
        .sidebar .docs-link{display:block;padding:6px 10px;font-size:13px;color:#555}
        .sidebar .docs-link:hover{color:#3498db;text-decoration:none}
        .sidebar .docs-link.active{color:#fff;background:#3498db;border-radius:6px}
        .sidebar .toc{margin-top:6px}
        .sidebar .toc a{display:block;padding:4px 10px;font-size:13px;color:#555;border-left:2px solid transparent}
        .sidebar .toc a.lv2{margin-left:0;font-weight:600}
        .sidebar .toc a.lv3{margin-left:16px;font-size:12.5px}
        .sidebar .toc a:hover{color:#3498db;border-left-color:#3498db;text-decoration:none}
        .main{flex:1;min-width:0;padding:24px 32px 80px}
        .main h1{font-size:26px;border-bottom:1px solid #eee;padding-bottom:10px}.main h2{font-size:20px;margin-top:36px;border-bottom:1px solid #eee;padding-bottom:6px}.main h3{font-size:17px;margin-top:26px}
        .main h1,.main h2,.main h3{scroll-margin-top:16px}
        .main code{background:#f5f5f5;padding:2px 5px;border-radius:3px;font-size:13px}
        .main pre{background:#f7f7f9;padding:12px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
        .main table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ddd;padding:8px 10px;text-align:left}th{background:#f5f5f5}
        .main blockquote{border-left:4px solid #ddd;margin:12px 0;padding:2px 14px;color:#666}
        .back-home{display:inline-block;font-size:13px;color:#888;margin-bottom:10px}
        @media(max-width:820px){.layout{display:block}.sidebar{position:static;width:100%;height:auto;border-right:none;border-bottom:1px solid #eee}}
      </style></head><body><div class="layout"><aside class="sidebar">
        <a class="brand" href="/">← ${'返回首页'}</a>
        ${buildDocsList(docRel)}
        <div class="toc">${toc}</div>
      </aside><main class="main">${body}</main></div></body></html>`);
    });
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  const safe = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (!safe) { res.writeHead(403); res.end('Forbidden'); return; }
  readStaticFile(filePath, (data, stamp) => {
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // 带 ?v= 版本号的静态资源可长期缓存；其余 HTML/JS/CSS 仍 no-cache 以便及时更新
    const versioned = /[?&]v=/.test(req.url || '');
    const cacheControl = (ext === '.html')
      ? 'no-cache'
      : (versioned && ['.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff2', '.woff', '.ttf'].includes(ext)
        ? 'public, max-age=31536000, immutable'
        : ([ '.js', '.css', '.json' ].includes(ext) ? 'no-cache' : 'public, max-age=3600'));
    const etag = stamp ? etagOf(stamp) : '';
    // 命中协商缓存：直接 304，不再传输正文（首屏 HTML 与未加版本号的 CSS/JS 受益最大）
    if (etag && String(req.headers['if-none-match'] || '').split(',').map((s) => s.trim()).includes(etag)) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl, 'Vary': 'Accept-Encoding' });
      res.end();
      return;
    }
    const baseHeaders = { 'Cache-Control': cacheControl, 'Vary': 'Accept-Encoding' };
    if (etag) baseHeaders['ETag'] = etag;
    const compressible = ['.js', '.css', '.html', '.json', '.svg', '.txt', '.map'].includes(ext);
    const accept = String(req.headers['accept-encoding'] || '');
    if (compressible && /\bgzip\b/.test(accept) && data.length >= 1024) {
      const key = filePath + '|' + stamp;
      let gz = staticGzipCache.get(key);
      if (!gz) {
        try {
          gz = require('zlib').gzipSync(data, { level: 6 });
          if (staticGzipCache.size > 60) staticGzipCache.clear(); // 简单容量控制
          staticGzipCache.set(key, gz);
        } catch { gz = null; }
      }
      if (gz) {
        res.writeHead(200, Object.assign({
          'Content-Type': type,
          'Content-Encoding': 'gzip',
          'Content-Length': gz.length,
        }, baseHeaders));
        res.end(gz);
        return;
      }
    }
    res.writeHead(200, Object.assign({
      'Content-Type': type,
      'Content-Length': data.length,
    }, baseHeaders));
    res.end(data);
  });
}

/** docs/ 文档列表（侧边栏导航） */
function buildDocsList(current) {
  const docs = [
    ['USAGE.md', '使用说明'],
    ['BEGINNERS.md', '新手教程'],
    ['DEPLOYMENT.md', '部署详解'],
    ['DOCKER.md', 'Docker 部署'],
    ['PANEL.md', '面板部署（宝塔 / 小皮）'],
    ['UPDATE.md', '版本更新指南'],
    ['LANGUAGES.md', '多语言配置'],
    ['CUSTOMIZATION.md', '自定义指南'],
    ['POINTS.md', '积分系统说明'],
    ['FAQ.md', '常见问题'],
    ['CONTRIBUTING.md', '贡献指南'],
    ['CHANGELOG.md', '版本日志'],
  ];
  return docs.map(([file, label]) => {
    const href = `/docs/${file}`;
    const active = file === current;
    return `<a class="docs-link${active ? ' active' : ''}" href="${href}">${label}</a>`;
  }).join('');
}

/** 从 Markdown 提取 #~### 标题生成左侧目录（锚点与 markdownToHtml 的 slugify 一致） */
function buildDocToc(md, currentFile) {
  const { slugify } = require('./src/markdown');
  const lines = String(md).split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (!m) continue;
    const level = m[1].length;
    const titleText = m[2].replace(/[*_`~]/g, '');
    // S4：标题文本来自 docs/*.md，直接拼进 <a> 存在注入面（当前文档无危险标题，属预防），统一 HTML 转义
    items.push(`<a class="lv${level}" href="#${slugify(titleText)}">${escapeHtml(titleText)}</a>`);
  }
  return items.join('');
}

// ---------------- 路由 ----------------

const server = http.createServer(async (req, res) => {
  // M15：所有响应统一安全头（setHeader 会与后续 writeHead 的头部合并）
  applySecurityHeaders(req, res);
  res.__req = req; // 供 ok/fail 判断是否支持 gzip
  let pathname = '/';
  try {
    // M19：URL 解析与 Cookie 解析都在 try 内，畸形请求行 / 畸形 Cookie 不再让连接挂死
    let url = null;
    let method = String(req.method || 'GET').toUpperCase();
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = url.pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    // M15：所有非 GET/HEAD 的写接口做同源校验（不破坏同源前端与运维脚本调用）
    if (pathname.startsWith('/api/')) {
      const csrf = csrfCheck(req);
      if (!csrf.ok) { fail(res, 403, csrf.reason); return; }
    }

    // M19：畸形 Cookie（如 oj_session=%）在这里被安全跳过，视为未登录
    let viewer = null;
    try { viewer = currentUser(req); } catch (e) { console.warn('[OJ] 解析登录状态失败（按未登录处理）：' + (e && e.message)); }

    // API
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, url, method, viewer, pathname);
      return;
    }
    // 静态资源
    if (method === 'GET') {
      // 兜底：站点根目录的 /favicon.ico（老标签页 / 书签 / 未声明 <link rel="icon"> 的抓取）
      // 回与 /api/favicon 完全相同的字节，不再 404（改前实测 404 text/plain）
      if (pathname === '/favicon.ico') { sendFavicon(req, res); return; }
      serveStatic(req, res, pathname);
      return;
    }
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (e) {
    // L3：请求体超限 → 回 413（util.js 的兜底 413 会带 status=413/handled，此时只需静默返回）
    if (e && (e.http413 || e.status === 413)) { respond413(req, res, e); return; }
    console.error('[OJ] 请求处理异常:', e);
    if (res.headersSent) { try { req.destroy(); } catch { /* ignore */ } return; }
    if (pathname.startsWith('/api/')) fail(res, 500, '服务器内部错误');
    else { res.writeHead(500); res.end('Internal Server Error'); }
  }
});

async function handleApi(req, res, url, method, viewer, pathname) {
  const seg = pathname.slice(5).split('/').filter(Boolean); // 去掉 /api/

  // 认证相关
  if (seg.length === 1) {
    // H4：注册按 IP + 账号限流；H3：弱口令在这里被拒绝；H5：验证码不再随响应下发
    if (seg[0] === 'register' && method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      const gate = throttleStatus('register', ip, body.username);
      if (gate.locked) return fail(res, 429, throttleMessage(gate.retryAfterMs));
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      const r = await registerUser(body.username, body.email, body.password, ip);
      if (r.error) { throttleFail('register', ip, body.username); return fail(res, 400, r.error); }
      throttleReset('register', ip, body.username);
      if (r.pending) {
        // v2.5.0：开启邮箱验证时注册**只写待验证记录**，users 表里没有该账号，
        // 只有验证码校验通过才会真正建号。验证码只通过邮件发送，任何情况下都不写进响应体；
        // 邮件发不出去时验证码只记录在服务端日志，用户可点「重新发送」。
        return ok(res, {
          pending: true,
          email_verify_required: true,
          email_sent: !!r.email_sent,
          email_reason: r.email_reason || '',
          message: r.email_sent
            ? '验证码已发送，请完成邮箱验证后账号才会创建'
            : '验证码邮件发送失败，请联系管理员（完成邮箱验证前不会创建账号）',
        });
      }
      const user = require('./src/auth').getUserById(r.id);
      const sess = createSession(user.id);
      setSessionCookie(res, sess.token, sess.expires, req);
      return ok(res, { user });
    }
    // H4 + H5：验证码校验按 IP + 邮箱限流；v2.5.0：校验通过才创建账号
    if (seg[0] === 'verify-email' && method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      const gate = throttleStatus('verify', ip, body.email);
      if (gate.locked) return fail(res, 429, throttleMessage(gate.retryAfterMs));
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      const r = require('./src/auth').verifyEmail(body.code, body.email);
      if (r.error) { throttleFail('verify', ip, body.email); return fail(res, 400, r.error); }
      throttleReset('verify', ip, body.email);
      // created=true 表示这次验证顺带创建了账号（新流程）；老账号补验证时为 false
      return ok(res, { created: !!r.created, username: r.username || '' });
    }
    // 忘记密码（仅开启邮箱验证时可用）；H4 限流；L2 模糊提示；H5 不下发验证码
    // v2.5.0：内置 admin 的找回验证码只发给「持内置超管会话」的请求（无会话 / 普通管理员一律不下发，对外文案不变）
    if (seg[0] === 'forgot-password' && method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      const gate = throttleStatus('forgot', ip, body.email);
      if (gate.locked) return fail(res, 429, throttleMessage(gate.retryAfterMs));
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      const r = await require('./src/auth').forgotPassword(body.email, ip, currentUser(req));
      if (r.error) { throttleFail('forgot', ip, body.email); return fail(res, 400, r.error); }
      return ok(res, { email_sent: r.email_sent, message: r.message || '如果该邮箱已注册，重置验证码已发送，请查收邮件' });
    }
    // 反馈 / 举报
    if (seg[0] === 'feedback' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const r = require('./src/feedback').createFeedback(user.id, user.username, body.type, body.content);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'feedback' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, require('./src/feedback').listMyFeedbacks(user.id, url.searchParams));
    }
    // H4：登录按 IP + 账号做失败计数、指数退避与临时锁定；成功即清零
    if (seg[0] === 'login' && method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      const account = String(body.username == null ? '' : body.username);
      const gate = throttleStatus('login', ip, account);
      if (gate.locked) return fail(res, 429, throttleMessage(gate.retryAfterMs));
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      const r = loginUser(account, body.password);
      if (r.error) {
        const st = throttleFail('login', ip, account);
        if (st.locked) {
          return fail(res, 429, `${r.error}；失败次数过多，账号已临时锁定，${throttleMessage(st.lockedMs)}`);
        }
        return fail(res, 400, r.error);
      }
      throttleReset('login', ip, account);
      const sess = createSession(r.user.id);
      setSessionCookie(res, sess.token, sess.expires, req);
      return ok(res, {
        user: r.user,
        must_change_password: !!r.must_change_password,
        password_warning: r.password_warning || '',
      });
    }
    if (seg[0] === 'logout' && method === 'POST') {
      const cookies = req.headers.cookie || '';
      const m = cookies.match(/oj_session=([^;]+)/);
      if (m) { try { destroySession(decodeURIComponent(m[1].trim())); } catch { destroySession(m[1].trim()); } }
      clearSessionCookie(res, req);
      return ok(res);
    }
    if (seg[0] === 'me' && method === 'GET') {
      return ok(res, { user: viewer });
    }
    if (seg[0] === 'me' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      // 更换邮箱：body 携带 email + email_code 时才走邮箱验证流程（见 requestEmailChange / confirmEmailChange）
      if (body.email !== undefined) {
        const auth = require('./src/auth');
        if (body.email_code !== undefined && body.email_code !== '') {
          const r = auth.confirmEmailChange(user.id, body.email, body.email_code);
          if (r.error) return fail(res, 400, r.error);
        } else if (body.request_email_code === true) {
          const r = await auth.requestEmailChange(user.id, body.email);
          if (r.error) return fail(res, 400, r.error);
          // 验证码仅通过邮件发送，不在接口返回
          return ok(res, { email_code_sent: r.email_sent, message: r.email_sent ? '验证码已发送至新邮箱' : ('验证码邮件发送失败：' + r.reason) });
        }
      }
      const r = users.updateProfile(user.id, body);
      if (r.error) return fail(res, 400, r.error);
      // 用户名可能已修改，改用 ID 重新获取
      return ok(res, { user: users.getProfile(user.id, user) });
    }
    if (seg[0] === 'notifications' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = notifications.list(user.id, url.searchParams);
      return ok(res, r);
    }
    // 合并未读徽标（通知 + 私信），减少导航时的请求数
    if (seg[0] === 'badges' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      // 私信功能关闭时不再返回私信未读数（前台也不显示私信入口）
      const pmOn = require('./src/settings').getSetting('pm_enabled', '1') === '1';
      return ok(res, { notifications: notifications.unreadCount(user.id), messages: pmOn ? messages.unreadCount(user.id) : 0 });
    }
    if (seg[0] === 'health' && method === 'GET') {
      // L14：健康检查只回 status，不再回版本号 / 平台 / Node 版本 / 语言列表 / data 目录可写性，
      // 避免未认证的指纹识别与运行环境信息泄漏（Docker healthcheck / 监控探针只需 status）。
      return ok(res, { status: 'up' });
    }

    /* 网站图标（favicon）—— **单段路径 /api/favicon 必须在这里分发**：
       之前该路由被写在 handleApi 的 `seg.length >= 2` 块里，单段请求永远走不到
       （与 `seg.length >= 2` 块开头的注释所描述的坑正好相反），表现为 /api/favicon 恒 404。
       公开可读；已上传回自定义图，未上传/文件丢失回默认站点 Logo；带 ETag 支持 304。
       响应体由 sendFavicon() 统一生成（根目录 /favicon.ico 兜底走同一函数，字节完全一致）。 */
    if (seg[0] === 'favicon' && method === 'GET') {
      return sendFavicon(req, res);
    }

    // 版本更新检查：站点设置页显示「已是最新 / 发现新版本」，deploy/update.js --check 复用同一逻辑
    if (seg[0] === 'version' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = await require('./src/version').checkLatest({ force: url.searchParams.get('force') === '1' });
      return ok(res, r);
    }
    if (seg[0] === 'stats' && method === 'GET') {
      const pc = db.prepare('SELECT COUNT(*) AS c FROM problems WHERE is_public = 1').get().c;
      const sc = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
      const uc = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      return ok(res, { problems: pc, submissions: sc, users: uc });
    }
    if (seg[0] === 'tags' && method === 'GET') {
      return ok(res, { tags: problems.allTags(), sources: problems.listSources(), difficulties: DIFFICULTIES });
    }
    if (seg[0] === 'languages' && method === 'GET') {
      const langs = availableLanguages();
      return ok(res, { languages: Object.values(langs).map((l) => ({ key: l.key, name: l.name, available: l.available, highlight: l.highlight })) });
    }
    if (seg[0] === 'problems' && method === 'GET') {
      // 拥有「题目管理」权限的用户在前台也能看到未公开题目
      const r = problems.listProblems(url.searchParams, viewer && viewer.id, viewer && viewer.is_admin, hasPerm(viewer, 'problem'));
      return ok(res, r);
    }
    if (seg[0] === 'problems' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = problems.createProblem(body, admin.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'submissions' && method === 'GET') {
      // M10：入口鉴权——未登录不允许浏览提交记录（防止匿名枚举全站提交、用 contest=all 绕过 OI 遮蔽）。
      // 这里仍返回 200 + 空列表（total=0），让既有前端按空列表渲染并展示提示，而不是整页报错。
      if (!viewer) {
        return ok(res, {
          items: [],
          total: 0,
          page: Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1),
          size: 0,
          login_required: true,
          error: '请先登录后查看提交记录',
        });
      }
      const r = submissions.listSubmissions(url.searchParams, viewer);
      return ok(res, r);
    }
    if (seg[0] === 'discussions' && method === 'GET') {
      const r = discussion.listDiscussions(url.searchParams);
      return ok(res, r);
    }
    if (seg[0] === 'discussions' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_speak) return fail(res, 403, '你已被撤销自由发言权限');
      const settings = require('./src/settings');
      if (settings.getSetting('discussion_enabled', '1') !== '1') {
        return fail(res, 403, '讨论功能已关闭');
      }
      const body = await readBody(req);
      const r = discussion.createDiscussionWithProblem(user.id, body.problem_id, body.title, body.content, user.username, body.board, user.is_admin);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'ranking' && method === 'GET') {
      return ok(res, ranking.getRanking(url.searchParams));
    }
    if (seg[0] === 'points-ranking' && method === 'GET') {
      return ok(res, users.getPointsRanking(url.searchParams));
    }
    if (seg[0] === 'rating-ranking' && method === 'GET') {
      return ok(res, users.getRatingRanking(url.searchParams));
    }
    if (seg[0] === 'settings' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      // 系统设置仅最高管理员（admin 账号）可访问
      if (admin.username !== 'admin') return fail(res, 403, '系统设置仅最高管理员可访问');
      const settings = require('./src/settings');
      // 全站积分结算的状态行（模式 / 间隔 / 上次结算时间·耗时·覆盖人数 / 下次预计 / 快照）
      const ps = users.getPointsSettleStatus();
      return ok(res, {
        version: VERSION,
        email_verify_required: settings.getSetting('email_verify_required', '0') === '1',
        site_name: settings.getSetting('site_name', 'LCZOJ'),
        site_logo: settings.getSetting('site_logo', ''),
        // 网站图标（favicon）：值为 data/favicon 下的文件名（空 = 使用默认图标）；
        // 前端据此显示「已自定义 / 默认」状态，并用 favicon_v 拼 ?v= 让标签页图标即时更新。
        site_favicon: settings.getSetting('site_favicon', ''),
        favicon_v: settings.getSetting('site_favicon_v', ''),
        // 侧边栏 Logo（图标 / 图片）大小（px，空=默认 28，范围 18~60）与站名字号（px，空=默认 24，范围 12~40）
        site_logo_size: settings.getSetting('site_logo_size', ''),
        site_title_size: settings.getSetting('site_title_size', ''),
        smtp_host: settings.getSetting('smtp_host', ''),
        smtp_port: settings.getSetting('smtp_port', '465'),
        smtp_user: settings.getSetting('smtp_user', ''),
        // v2.8.0：SMTP 授权码改为回真实值（本接口仅最高管理员 admin 可访问，见上方 requireSuperAdmin
        // + username !== 'admin' 拦截），管理态「邮箱与验证」里的授权码因此始终显示已保存的值；
        // /api/home 不下发该字段，非管理员拿不到。
        smtp_pass: settings.getSetting('smtp_pass', ''),
        smtp_secure: settings.getSetting('smtp_secure', '1') === '1',
        discussion_enabled: settings.getSetting('discussion_enabled', '1') === '1',
        article_enabled: settings.getSetting('article_enabled', '1') === '1',
        points_enabled: settings.getSetting('points_enabled', '1') === '1',
        // 全站积分结算（**realtime 实时（默认）** / interval 定时自动 / manual 手动结算）与状态行；
        // interval_minutes 以分钟下发（界面自行换算成「小时 / 天」展示）
        points_settle_mode: ps.mode,
        points_settle_interval_minutes: ps.interval_minutes,
        points_settle_last_run: ps.last_run,
        points_settle_last_ms: ps.last_ms,
        points_settle_last_users: ps.last_users,
        points_settle_next_run: ps.next_run,
        points_snapshot_users: ps.snapshot_users,
        points_snapshot_at: ps.snapshot_at,
        // 私信功能开关（默认开启）
        pm_enabled: settings.getSetting('pm_enabled', '1') === '1',
        footer_text: settings.getSetting('footer_text', ''),
        help_content: settings.getSetting('help_content', ''),
        agreement_content: settings.getSetting('agreement_content', ''),
        contact_content: settings.getSetting('contact_content', ''),
        about_content: settings.getSetting('about_content', ''),
        rules_content: settings.getSetting('rules_content', ''),
        // 网站标题自定义样式（侧栏站名 / 首页大标题）
        site_title_sidebar_size: settings.getSetting('site_title_sidebar_size', ''),
        site_title_hero_size: settings.getSetting('site_title_hero_size', ''),
        site_title_weight: settings.getSetting('site_title_weight', ''),
        site_title_color: settings.getSetting('site_title_color', ''),
        site_title_spacing: settings.getSetting('site_title_spacing', ''),
        site_title_font: settings.getSetting('site_title_font', ''),
        // 正文内容最大宽度（px，空=默认 1320）
        content_max_width: settings.getSetting('content_max_width', ''),
        // 首页宽度（px，空=保持原始宽度，不受全站页面宽度影响）
        home_max_width: settings.getSetting('home_max_width', ''),
        // 各页面宽度（JSON 字符串：{ ranking: 1000, article: 860, … }，空=使用内置默认值）
        page_widths: settings.getSetting('page_widths', ''),
        // 网站外观自定义（颜色 / 圆角 / 字号 / 字体，空=使用默认样式）
        theme_accent: settings.getSetting('theme_accent', ''),
        theme_accent_hover: settings.getSetting('theme_accent_hover', ''),
        theme_bg: settings.getSetting('theme_bg', ''),
        theme_card: settings.getSetting('theme_card', ''),
        theme_sidebar: settings.getSetting('theme_sidebar', ''),
        theme_text: settings.getSetting('theme_text', ''),
        theme_text_light: settings.getSetting('theme_text_light', ''),
        theme_border: settings.getSetting('theme_border', ''),
        theme_radius: settings.getSetting('theme_radius', ''),
        theme_font_size: settings.getSetting('theme_font_size', ''),
        theme_font: settings.getSetting('theme_font', ''),
        theme_code_font: settings.getSetting('theme_code_font', ''),
        theme_dark_bg: settings.getSetting('theme_dark_bg', ''),
        theme_dark_card: settings.getSetting('theme_dark_card', ''),
        theme_dark_sidebar: settings.getSetting('theme_dark_sidebar', ''),
        theme_dark_text: settings.getSetting('theme_dark_text', ''),
        // 评测性能：并行判题数（1~16）
        judge_concurrency: String(queue.stats().concurrency),
        // M17：评测设置的可调项（编译超时 / checker 超时 / 总兜底 / 输出上限 / 编译日志上限 /
        // 时限余量 / 内存判定百分比 / 内存采样开关与间隔 / C、C++ 追加编译参数 / Python 解释器）。
        // 回显的是**当前生效值**（未配置即默认值），与判题侧读到的完全同源。
        ...require('./src/judge').judgeTuning(),
      });
    }
    if (seg[0] === 'settings' && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '系统设置仅最高管理员可访问');
      const body = await readBody(req);
      const settings = require('./src/settings');
      if (body.email_verify_required !== undefined) settings.setSetting('email_verify_required', body.email_verify_required ? '1' : '0');
      if (body.site_name !== undefined) settings.setSetting('site_name', String(body.site_name).slice(0, 40));
      if (body.site_logo !== undefined) settings.setSetting('site_logo', String(body.site_logo).slice(0, 2 * 1024 * 1024));
      // 侧边栏 Logo 大小（px，18~60）：留空 / 非数字 = 默认 28，其余夹到范围内；等于默认 28 时存空值（等价「恢复默认」）
      if (body.site_logo_size !== undefined) {
        const raw = String(body.site_logo_size == null ? '' : body.site_logo_size).trim();
        const n = parseFloat(raw);
        let v = (raw && Number.isFinite(n)) ? String(Math.max(18, Math.min(60, Math.round(n)))) : '';
        if (v === '28') v = '';
        settings.setSetting('site_logo_size', v);
      }
      // 侧栏站名字号（px，12~40）：留空 / 非数字 = 默认 24，其余夹到范围内；等于默认 24 时存空值
      if (body.site_title_size !== undefined) {
        const raw = String(body.site_title_size == null ? '' : body.site_title_size).trim();
        const n = parseFloat(raw);
        let v = (raw && Number.isFinite(n)) ? String(Math.max(12, Math.min(40, Math.round(n)))) : '';
        if (v === '24') v = '';
        settings.setSetting('site_title_size', v);
      }
      if (body.smtp_host !== undefined) settings.setSetting('smtp_host', String(body.smtp_host).slice(0, 200));
      if (body.smtp_port !== undefined) settings.setSetting('smtp_port', String(Math.max(1, parseInt(body.smtp_port, 10) || 465)));
      if (body.smtp_user !== undefined) settings.setSetting('smtp_user', String(body.smtp_user).slice(0, 200));
      // v2.8.0：smtp_pass 提交什么就存什么（空串 = 清空），不再有掩码「未修改则保持」的判断，
      // 因此「打开设置页 → 直接保存」也不会把真实授权码覆盖成掩码。
      if (body.smtp_pass !== undefined) settings.setSetting('smtp_pass', String(body.smtp_pass).slice(0, 200));
      if (body.smtp_secure !== undefined) settings.setSetting('smtp_secure', body.smtp_secure ? '1' : '0');
      if (body.discussion_enabled !== undefined) settings.setSetting('discussion_enabled', body.discussion_enabled ? '1' : '0');
      if (body.article_enabled !== undefined) settings.setSetting('article_enabled', body.article_enabled ? '1' : '0');
      if (body.points_enabled !== undefined) settings.setSetting('points_enabled', body.points_enabled ? '1' : '0');
      /* 全站积分结算（「功能设置」页）：
       *   points_settle_mode：**realtime 实时（默认）** / interval 定时自动 / manual 手动结算；
       *   points_settle_interval_minutes：定时间隔 —— **存储仍统一用分钟**（保持既有键兼容），
       *     界面按「小时 / 天」录入（数值输入 + 单位下拉），范围 **1 小时 ~ 30 天**（60 ~ 43200 分钟），
       *     留空 = 默认 6 小时（360 分钟）。
       * 非法值一律 **400 + 中文「小时 / 天」提示**（不静默夹取、提示里不出现「分钟」单位口径），
       * 避免管理员以为改成了别的数字。 */
      if (body.points_settle_mode !== undefined) {
        const mode = String(body.points_settle_mode == null ? '' : body.points_settle_mode).trim();
        if (!users.POINTS_SETTLE_MODES.includes(mode)) {
          return fail(res, 400, '结算模式无效：只能是「实时（默认）/ 定时自动 / 手动结算」之一');
        }
        settings.setSetting('points_settle_mode', mode);
      }
      if (body.points_settle_interval_minutes !== undefined) {
        const raw = String(body.points_settle_interval_minutes == null ? '' : body.points_settle_interval_minutes).trim();
        if (raw === '') {
          // 留空 = 默认间隔（6 小时）；前端「数值为空」也走这里，不让它落成 0 / 空串
          settings.setSetting('points_settle_interval_minutes', String(users.POINTS_SETTLE_DEFAULT_MINUTES));
        } else {
          const range = `${users.formatSettleIntervalText(users.POINTS_SETTLE_MIN_MINUTES)} ~ ${users.formatSettleIntervalText(users.POINTS_SETTLE_MAX_MINUTES)}`;
          // 只接受整数分钟（界面按整数小时 / 天录入；小数换算后必须是整分钟，如 1.5 小时 = 90）
          if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isInteger(Number(raw))) {
            return fail(res, 400, `请输入整数（定时间隔单位可选「小时 / 天」，范围 ${range}，如 6 小时、2 天）`);
          }
          const minutes = Number(raw);
          if (minutes < users.POINTS_SETTLE_MIN_MINUTES || minutes > users.POINTS_SETTLE_MAX_MINUTES) {
            const side = minutes < users.POINTS_SETTLE_MIN_MINUTES ? '小于下限 1 小时' : '超过上限 30 天';
            return fail(res, 400, `定时间隔需在 ${range} 之间：当前为 ${users.formatSettleIntervalText(minutes)}，${side}`);
          }
          settings.setSetting('points_settle_interval_minutes', String(minutes));
        }
      }
      // 私信功能开关（默认开启；关闭后仅隐藏入口并拦截接口，不删除任何私信数据）
      if (body.pm_enabled !== undefined) settings.setSetting('pm_enabled', body.pm_enabled ? '1' : '0');
      if (body.footer_text !== undefined) settings.setSetting('footer_text', String(body.footer_text).slice(0, 500));
      if (body.help_content !== undefined) settings.setSetting('help_content', String(body.help_content).slice(0, 50000));
      if (body.agreement_content !== undefined) settings.setSetting('agreement_content', String(body.agreement_content).slice(0, 50000));
      if (body.contact_content !== undefined) settings.setSetting('contact_content', String(body.contact_content).slice(0, 50000));
      if (body.about_content !== undefined) settings.setSetting('about_content', String(body.about_content).slice(0, 50000));
      if (body.rules_content !== undefined) settings.setSetting('rules_content', String(body.rules_content).slice(0, 50000));
      // 网站标题样式：数值类限制范围，颜色/字体只允许安全字符
      const numOrEmpty = (v, min, max) => {
        const s = String(v == null ? '' : v).trim();
        if (!s) return '';
        const n = parseFloat(s);
        if (!Number.isFinite(n)) return '';
        return String(Math.max(min, Math.min(max, Math.round(n))));
      };
      if (body.site_title_sidebar_size !== undefined) settings.setSetting('site_title_sidebar_size', numOrEmpty(body.site_title_sidebar_size, 10, 48));
      if (body.site_title_hero_size !== undefined) settings.setSetting('site_title_hero_size', numOrEmpty(body.site_title_hero_size, 16, 96));
      if (body.site_title_spacing !== undefined) settings.setSetting('site_title_spacing', numOrEmpty(body.site_title_spacing, -2, 20));
      if (body.site_title_weight !== undefined) {
        const w = String(body.site_title_weight || '').trim();
        settings.setSetting('site_title_weight', /^\d{3}$/.test(w) ? w : '');
      }
      if (body.site_title_color !== undefined) {
        const c = String(body.site_title_color || '').trim();
        settings.setSetting('site_title_color', /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '');
      }
      if (body.site_title_font !== undefined) {
        const f = String(body.site_title_font || '').trim().slice(0, 200);
        settings.setSetting('site_title_font', /^[-\w\s,'"()\u4e00-\u9fa5]+$/.test(f) ? f : '');
      }
      if (body.content_max_width !== undefined) {
        const w = String(body.content_max_width == null ? '' : body.content_max_width).trim();
        const n = parseFloat(w);
        settings.setSetting('content_max_width', (w && Number.isFinite(n)) ? String(Math.max(760, Math.min(2600, Math.round(n)))) : '');
      }
      // 首页宽度：与全站页面宽度各自独立（留空=保持原始宽度）
      if (body.home_max_width !== undefined) {
        const w = String(body.home_max_width == null ? '' : body.home_max_width).trim();
        const n = parseFloat(w);
        settings.setSetting('home_max_width', (w && Number.isFinite(n)) ? String(Math.max(760, Math.min(2600, Math.round(n)))) : '');
      }
      // 各页面宽度：{ 页面标识: 宽度 }，留空或非法值表示该页面使用内置默认宽度
      if (body.page_widths !== undefined) {
        let obj = body.page_widths;
        if (typeof obj === 'string') { try { obj = JSON.parse(obj || '{}'); } catch { obj = null; } }
        const clean = {};
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if (!/^[a-z][a-z0-9-]{0,30}$/.test(k)) continue;
            const n = parseFloat(String(v == null ? '' : v).trim());
            if (Number.isFinite(n) && n > 0) clean[k] = Math.max(600, Math.min(2600, Math.round(n)));
          }
        }
        settings.setSetting('page_widths', Object.keys(clean).length ? JSON.stringify(clean) : '');
      }
      // 网站外观：颜色只接受 #RRGGBB / #RGB 形式，数值与字体做范围与字符校验
      const colorKeys = ['theme_accent', 'theme_accent_hover', 'theme_bg', 'theme_card', 'theme_sidebar',
        'theme_text', 'theme_text_light', 'theme_border', 'theme_dark_bg', 'theme_dark_card', 'theme_dark_sidebar', 'theme_dark_text'];
      for (const key of colorKeys) {
        if (body[key] === undefined) continue;
        const c = String(body[key] || '').trim();
        settings.setSetting(key, /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '');
      }
      const fontOk = (f) => /^[-\w\s,'"()\u4e00-\u9fa5]+$/.test(f);
      if (body.theme_radius !== undefined) settings.setSetting('theme_radius', numOrEmpty(body.theme_radius, 0, 40));
      if (body.theme_font_size !== undefined) settings.setSetting('theme_font_size', numOrEmpty(body.theme_font_size, 12, 20));
      if (body.theme_font !== undefined) {
        const f = String(body.theme_font || '').trim().slice(0, 200);
        settings.setSetting('theme_font', fontOk(f) ? f : '');
      }
      if (body.theme_code_font !== undefined) {
        const f = String(body.theme_code_font || '').trim().slice(0, 200);
        settings.setSetting('theme_code_font', fontOk(f) ? f : '');
      }
      // 评测性能：并行判题数（1~16），改完立即作用于判题队列
      if (body.judge_concurrency !== undefined) {
        const n = Math.max(1, Math.min(16, parseInt(body.judge_concurrency, 10) || 0));
        if (n > 0) {
          settings.setSetting('judge_concurrency', String(n));
          queue.setConcurrency(n);
        }
      }
      /* ---------------- 评测设置（M17）：类型 + 范围校验 ----------------
       * 与既有设置项「非法值夹取」不同，这里的每一项都会**先全部校验、再统一落库**：
       *   · 非法值 → 400 + 中文提示（不做静默夹取，避免管理员以为改了其实没改）；
       *   · 空串 / null → 清除该设置（恢复默认值，等价「行为与历史一致」）；
       *   · 任何一项不合法时**整批不写入**，不会出现「一半生效」。
       * 所有项都由 src/judge.js / src/interactive.js 在使用点现读，因此改完立即生效、无需重启。 */
      const judgeWrites = [];
      const judgeErrors = [];
      const addInt = (key, label, min, max) => {
        if (body[key] === undefined) return;
        const raw = String(body[key] == null ? '' : body[key]).trim();
        if (raw === '') { judgeWrites.push([key, '']); return; }
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) { judgeErrors.push(`${label}必须是整数`); return; }
        if (n < min || n > max) { judgeErrors.push(`${label}必须在 ${min}~${max} 之间（当前填的是 ${raw}）`); return; }
        judgeWrites.push([key, String(n)]);
      };
      const addNum = (key, label, min, max) => {
        if (body[key] === undefined) return;
        const raw = String(body[key] == null ? '' : body[key]).trim();
        if (raw === '') { judgeWrites.push([key, '']); return; }
        const n = Number(raw);
        if (!Number.isFinite(n)) { judgeErrors.push(`${label}必须是数字`); return; }
        if (n < min || n > max) { judgeErrors.push(`${label}必须在 ${min}~${max} 之间（当前填的是 ${raw}）`); return; }
        judgeWrites.push([key, String(n)]);
      };
      // 编译参数：只允许常见 flag 字符（字母数字、- _ = + . , : / 空格与引号），禁止 ; | & $ ` < > ( ) 等 shell 元字符
      const FLAGS_RE = /^[-\w\s=+.,:/"']{0,200}$/;
      const addFlags = (key, label) => {
        if (body[key] === undefined) return;
        const v = String(body[key] == null ? '' : body[key]).trim();
        if (v === '') { judgeWrites.push([key, '']); return; }
        if (!FLAGS_RE.test(v)) { judgeErrors.push(`${label}含有不允许的字符（只支持常见编译参数，如 -O2 -std=c++17）`); return; }
        judgeWrites.push([key, v]);
      };
      addInt('judge_compile_timeout_ms', '编译超时', 10000, 600000);
      addInt('judge_interactive_compile_timeout_ms', '交互题编译超时', 10000, 600000);
      addInt('judge_checker_timeout_base_ms', 'SPJ/checker 基础超时', 1000, 60000);
      addInt('judge_checker_timeout_max_ms', 'SPJ/checker 超时上限', 5000, 600000);
      addInt('judge_total_timeout_ms', '判题总兜底超时', 5000, 600000);
      addInt('judge_output_limit_mb', '单测试点输出上限', 1, 1024);
      addInt('judge_compile_log_limit_kb', '编译日志上限', 64, 65536);
      addInt('judge_time_extra_ms', 'TLE 判定余量', 0, 5000);
      /* judge_time_factor：每测试点时限系数（默认 1.2，范围 1.0 ~ 3.0，步进 0.05）。
       *   · 留空 → 落库默认 1.2（而不是清空，页面上留空等价于「用默认 1.2」）；
       *   · 非数字 / 越界（0.5、5、abc、-1 …）→ 400 + 中文提示，整批不写入；
       *   · 合法值四舍五入到 2 位小数落库。 */
      if (body.judge_time_factor !== undefined) {
        const raw = String(body.judge_time_factor == null ? '' : body.judge_time_factor).trim();
        if (raw === '') {
          judgeWrites.push(['judge_time_factor', '1.2']);
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 1.0 || n > 3.0) {
            judgeErrors.push(`评测时限系数需在 1.0 ~ 3.0 之间（当前填的是 ${raw}）`);
          } else {
            judgeWrites.push(['judge_time_factor', String(Math.round(n * 100) / 100)]);
          }
        }
      }
      addInt('judge_memory_tolerance_pct', '内存判定百分比', 50, 200);
      addInt('judge_mem_sample_interval_ms', '内存采样间隔', 0, 50);
      if (body.judge_mem_sample_enabled !== undefined) {
        judgeWrites.push(['judge_mem_sample_enabled', body.judge_mem_sample_enabled ? '1' : '0']);
      }
      addFlags('judge_cpp_flags', 'C++ 追加编译参数');
      addFlags('judge_c_flags', 'C 追加编译参数');
      if (body.judge_python_cmd !== undefined) {
        const v = String(body.judge_python_cmd == null ? '' : body.judge_python_cmd).trim().slice(0, 200);
        // 解释器只允许「命令名或路径」，禁止引号与 shell 元字符（会被拼进命令行）
        if (v && !/^[\w./:\\ -]{1,200}$/.test(v)) judgeErrors.push('Python 解释器只能是命令名或路径（不含引号与特殊字符）');
        else judgeWrites.push(['judge_python_cmd', v]);
      }
      if (judgeErrors.length) return fail(res, 400, judgeErrors[0]);
      for (const [k, v] of judgeWrites) settings.setSetting(k, v);
      // 解释器 / 编译参数变化后，语言可用性缓存要失效，/api/languages 立刻反映最新配置
      if (judgeWrites.some(([k]) => k === 'judge_python_cmd' || k === 'judge_cpp_flags' || k === 'judge_c_flags')) {
        try { require('./src/judge').resetLanguageCache(); } catch { /* ignore */ }
      }
      return ok(res);
    }
    if (seg[0] === 'contests' && method === 'GET') {
      const r = contest.listContests(url.searchParams, viewer && viewer.is_admin);
      return ok(res, r);
    }
    if (seg[0] === 'contests' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = contest.createContest(body, admin.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'preview' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      return ok(res, { html: markdownToHtml(body.content) });
    }
    if (seg[0] === 'checkin' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = users.doCheckin(user.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'checkin' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, users.getCheckinStatus(user.id));
    }
    // 收藏（列表 / 添加）
    if (seg[0] === 'favorites' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, users.getFavorites(user.id, url.searchParams));
    }
    if (seg[0] === 'favorites' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const r = users.addFavorite(user.id, body.type, body.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // 题解与专栏：全站文章流
    if (seg[0] === 'articles' && method === 'GET') {
      return ok(res, editorial.listArticles(url.searchParams, viewer));
    }
    if (seg[0] === 'articles' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_editorial) return fail(res, 403, '你已被撤销发布文章的权限');
      const settings = require('./src/settings');
      if (settings.getSetting('article_enabled', '1') !== '1') return fail(res, 403, '专栏文章功能已关闭');
      const body = await readBody(req);
      const r = editorial.createArticle(user.id, body.title, body.content, body.category, body.submit, body.problem_id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id, status: r.status });
    }
    if (seg[0] === 'home' && method === 'GET') {
      const settings = require('./src/settings');
      const pc = db.prepare('SELECT COUNT(*) AS c FROM problems WHERE is_public = 1').get().c;
      const uc = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      // 评测数（含比赛提交）与比赛数量
      const sc = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
      const cc = db.prepare('SELECT COUNT(*) AS c FROM contests WHERE is_public = 1').get().c;
      // 首页「最近比赛」最多 6 场（v2.6.0：5 → 6，前端还有一次 slice(0, 6) 兜底）
      const recentContests = db.prepare('SELECT id, title, type, start_time, end_time, signup_required, rated FROM contests WHERE is_public = 1 ORDER BY id DESC LIMIT 6').all();
      const now = Date.now();
      return ok(res, {
        site_name: settings.getSetting('site_name', 'LCZOJ'),
        site_logo: settings.getSetting('site_logo', ''),
        // 网站图标（favicon）：前台启动时把 <link rel="icon"> 指向 /api/favicon（带版本号），
        // 这样后台换过图标后，访客下一次打开页面看到的就是新图标（而不是构建时的默认图）。
        favicon: settings.getSetting('site_favicon', ''),
        favicon_v: settings.getSetting('site_favicon_v', ''),
        // 侧边栏 Logo 大小（px，空=默认 28）与站名字号（px，空=默认 24）：前台据此写 --brand-logo-size / --brand-title-size
        site_logo_size: settings.getSetting('site_logo_size', ''),
        site_title_size: settings.getSetting('site_title_size', ''),
        // 网站标题自定义样式（前台启动时套用到侧栏站名与首页大标题）
        title_style: {
          sidebar_size: settings.getSetting('site_title_sidebar_size', ''),
          hero_size: settings.getSetting('site_title_hero_size', ''),
          weight: settings.getSetting('site_title_weight', ''),
          color: settings.getSetting('site_title_color', ''),
          spacing: settings.getSetting('site_title_spacing', ''),
          font: settings.getSetting('site_title_font', ''),
        },
        content_max_width: settings.getSetting('content_max_width', ''),
        home_max_width: settings.getSetting('home_max_width', ''),
        // 各页面宽度（JSON：{ ranking: 1000, article: 860, … }，空=使用内置默认值）
        page_widths: settings.getSetting('page_widths', ''),
        // 网站外观（颜色 / 圆角 / 字号 / 字体），前台启动时注入样式
        appearance: {
          accent: settings.getSetting('theme_accent', ''),
          accent_hover: settings.getSetting('theme_accent_hover', ''),
          bg: settings.getSetting('theme_bg', ''),
          card: settings.getSetting('theme_card', ''),
          sidebar: settings.getSetting('theme_sidebar', ''),
          text: settings.getSetting('theme_text', ''),
          text_light: settings.getSetting('theme_text_light', ''),
          border: settings.getSetting('theme_border', ''),
          radius: settings.getSetting('theme_radius', ''),
          font_size: settings.getSetting('theme_font_size', ''),
          font: settings.getSetting('theme_font', ''),
          code_font: settings.getSetting('theme_code_font', ''),
          dark_bg: settings.getSetting('theme_dark_bg', ''),
          dark_card: settings.getSetting('theme_dark_card', ''),
          dark_sidebar: settings.getSetting('theme_dark_sidebar', ''),
          dark_text: settings.getSetting('theme_dark_text', ''),
        },
        discussion_enabled: settings.getSetting('discussion_enabled', '1') === '1',
        article_enabled: settings.getSetting('article_enabled', '1') === '1',
        points_enabled: settings.getSetting('points_enabled', '1') === '1',
        pm_enabled: settings.getSetting('pm_enabled', '1') === '1',
        stats: { problems: pc, users: uc, submissions: sc, contests: cc },
        recent_contests: recentContests.map((c) => ({
          id: c.id,
          title: c.title,
          type: c.type,
          start_time: c.start_time,
          end_time: c.end_time,
          signup_required: !!c.signup_required,
          rated: !!c.rated,
          status: contest.contestStatus(c, now),
          status_label: contest.contestStatus(c, now) === 'upcoming' ? '未开始' : (contest.contestStatus(c, now) === 'running' ? '进行中' : '已结束'),
        })),
        discussions: discussion.listHomeDiscussions(6),
      });
    }
    // 站点公开页（帮助中心/用户协议/联系我们/关于网站/社区规则）与页脚版权
    if (seg[0] === 'site-pages' && method === 'GET') {
      const settings = require('./src/settings');
      return ok(res, {
        site_name: settings.getSetting('site_name', 'LCZOJ'),
        footer_text: settings.getSetting('footer_text', ''),
        help: markdownToHtml(settings.getSetting('help_content', '')),
        agreement: markdownToHtml(settings.getSetting('agreement_content', '')),
        contact: markdownToHtml(settings.getSetting('contact_content', '')),
        about: markdownToHtml(settings.getSetting('about_content', '')),
        rules: markdownToHtml(settings.getSetting('rules_content', '')),
      });
    }
    if (seg[0] === 'user-colors' && method === 'GET') {
      return ok(res, { colors: users.getUserColors() });
    }
    // 题目重判（仅超级管理员）：比赛某题全部 / 某题全部 / 自定义提交 ID 区间
    if (seg[0] === 'rejudge' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const dryRun = body.dry_run !== false; // 默认只预览数量，需显式 dry_run:false 才真正重判
      const r = require('./src/rejudge').runRejudge(body, dryRun);
      if (r.error) return fail(res, 400, r.error);
      if (!dryRun) {
        const allIds = r.all_ids || r.ids;
        delete r.all_ids;
        for (const id of allIds) queue.submit(id);
      }
      return ok(res, r);
    }
  }

  // 二级路径
  if (seg.length >= 2) {
    /* 手动「立即结算全站积分」：对**全部用户**跑一遍 computePoints 并落库快照
     * （users.settleAllPoints，内部逐场预热榜单缓存后分批让出事件循环）。
     * 与自动调度器共用同一段逻辑，只是 action 记为 manual_settle_points。
     * 权限：与「计算等级分」一致，需要 contest 权限。
     * 注意：必须放在 seg.length >= 2 这个块里 —— 放进上面的 `seg.length === 1` 块会永远 404。 */
    if (seg[0] === 'points' && seg[1] === 'settle' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      try {
        const r = await runPointsSettle('manual', 'button', { id: admin.id, name: admin.username, ip: clientIp(req) });
        return ok(res, {
          users: r.users, settled: r.ok, failed: r.failed, ms: r.ms,
          max_chunk_ms: r.max_chunk_ms, chunk_size: r.chunk_size,
          last_run: users.getPointsSettleLastRun(),
          snapshot_users: users.countPointsSnapshots(),
        });
      } catch (e) {
        console.error('[OJ] 手动全站积分结算异常：', (e && e.stack) || e);
        return fail(res, 500, '全站积分结算失败：' + ((e && e.message) || e));
      }
    }
    // 忘记密码：使用验证码重置密码（二级路径）；H4 限流；H3 新口令强度；M2 吊销全部会话
    // v2.5.0：该接口本身不需要登录态（普通用户自助找回不受影响），但如果目标是内置 admin，
    // 则必须持内置超管会话，否则 403 + 明确中文提示（拒绝时同样不消耗验证码，并写审计）。
    if (seg[0] === 'forgot-password' && seg[1] === 'reset' && method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      const gate = throttleStatus('reset', ip, body.email);
      if (gate.locked) return fail(res, 429, throttleMessage(gate.retryAfterMs));
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      const r = require('./src/auth').resetPassword(body.email, body.code, body.new_password, ip, currentUser(req));
      if (r.error) { throttleFail('reset', ip, body.email); return fail(res, r.status || 400, r.error); }
      throttleReset('reset', ip, body.email);
      return ok(res, { sessions_revoked: r.sessions_revoked || 0 });
    }
    if (seg[0] === 'settings' && seg[1] === 'test-email' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '系统设置仅最高管理员可访问');
      const body = await readBody(req);
      const settings = require('./src/settings');
      // 测试前先保存表单中的 SMTP 配置
      if (body.smtp_host !== undefined) settings.setSetting('smtp_host', String(body.smtp_host).slice(0, 200));
      if (body.smtp_port !== undefined) settings.setSetting('smtp_port', String(Math.max(1, parseInt(body.smtp_port, 10) || 465)));
      if (body.smtp_user !== undefined) settings.setSetting('smtp_user', String(body.smtp_user).slice(0, 200));
      // v2.8.0：测试邮件同样「提交什么就存什么」（空串 = 清空），不再把掩码当特殊值
      if (body.smtp_pass !== undefined) settings.setSetting('smtp_pass', String(body.smtp_pass).slice(0, 200));
      if (body.smtp_secure !== undefined) settings.setSetting('smtp_secure', body.smtp_secure ? '1' : '0');
      const smtp = require('./src/smtp');
      const user = settings.getSetting('smtp_user', '');
      try {
        await smtp.sendMail({
          host: settings.getSetting('smtp_host', ''),
          port: settings.getSetting('smtp_port', '465'),
          secure: settings.getSetting('smtp_secure', '1') === '1',
          user,
          pass: settings.getSetting('smtp_pass', ''),
          fromName: settings.getSetting('site_name', 'LCZOJ'),
        }, {
          to: user,
          subject: 'SMTP 测试邮件',
          html: `<p>这是一封来自 ${escapeHtml(settings.getSetting('site_name', 'LCZOJ'))} 的测试邮件，说明 SMTP 配置可用。</p>`,
        });
        return ok(res, { sent: true });
      } catch (e) {
        return ok(res, { sent: false, reason: String(e.message || 'send_failed') });
      }
    }
    // ---------------- 题目导出：单个 / 指定若干（批量）/ 全部（ZIP，可直接用「题目导入」还原） ----------------
    if (seg[0] === 'problems' && seg[1] === 'export' && seg[2] === 'all' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const r = problems.exportAllProblems();
      if (r.error) return fail(res, 400, r.error);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': r.buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(r.buffer);
    }
    // 只导出题目清单（JSON，测试数据内联）：/api/problems/export/json?ids=1,2,3
    if (seg[0] === 'problems' && seg[1] === 'export' && seg[2] === 'json' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const raw = url.searchParams.get('ids');
      const ids = raw ? String(raw).split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)) : null;
      const r = problems.exportProblemsJson(ids && ids.length ? ids : null);
      if (r.error) return fail(res, 400, r.error);
      const buf = Buffer.from(JSON.stringify({ version: require('./package.json').version, exported_at: new Date().toISOString(), problems: r.problems }, null, 2), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }
    // 批量导出指定题号：/api/problems/export?ids=1,2,3（不传 ids 时等同于导出全部）
    if (seg[0] === 'problems' && seg[1] === 'export' && seg.length === 2 && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const raw = url.searchParams.get('ids');
      let ids = null;
      if (raw) {
        ids = String(raw).split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
        if (!ids.length) return fail(res, 400, 'ids 参数无效（示例：?ids=1,2,3）');
        if (ids.length > 500) return fail(res, 400, '单次最多导出 500 道题目');
      }
      const r = problems.exportProblemsZip(ids);
      if (r.error) return fail(res, 400, r.error);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': r.buffer.length,
        'Cache-Control': 'no-store',
        'X-Exported-Count': String(r.count),
        'X-Exported-Testcases': String(r.testcases || 0),
      });
      return res.end(r.buffer);
    }
    if (seg[0] === 'problems' && seg[2] === 'export' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const r = problems.exportProblem(parseInt(seg[1], 10));
      if (r.error) return fail(res, 404, r.error);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': r.buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(r.buffer);
    }
    // ---------------- 题号迁移：把题目整体搬到新题号 ----------------
    if (seg[0] === 'problems' && seg[2] === 'migrate' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = problems.migrateProblem(parseInt(seg[1], 10), parseInt(body && body.new_id, 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    // ---------------- 题号占用查询（迁移前检查） ----------------
    if (seg[0] === 'problems' && seg[2] === 'exists' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const pid = parseInt(seg[1], 10);
      const row = Number.isFinite(pid) ? db.prepare('SELECT id, title FROM problems WHERE id = ?').get(pid) : null;
      return ok(res, { exists: !!row, title: row ? row.title : null });
    }
    if (seg[0] === 'problems' && seg.length === 2 && method === 'GET') {
      const pid = parseInt(seg[1], 10);
      // 比赛上下文：未公开的赛题只能通过比赛进入查看
      let allowHidden = false;
      let contestCtx = null;
      const cidParam = parseInt(url.searchParams.get('contest') || '0', 10);
      if (Number.isFinite(cidParam) && cidParam > 0) {
        const v = contest.canViewProblemInContest(cidParam, pid, viewer && viewer.id, viewer && viewer.is_admin);
        if (v.ok) {
          allowHidden = true;
          const c = db.prepare('SELECT id, title, type FROM contests WHERE id = ?').get(cidParam);
          contestCtx = c ? { id: c.id, title: c.title, type: c.type } : null;
        }
      }
      // 拥有「题目管理」权限的用户可直接查看未公开题目（不必从比赛进入）
      const p = problems.getProblem(pid, viewer && viewer.id, viewer && viewer.is_admin, allowHidden || hasPerm(viewer, 'problem'));
      if (!p) return fail(res, 404, '题目不存在');
      if (p.forbidden) return fail(res, 403, '题目不可见（未公开的赛题请从对应比赛进入）');
      if (contestCtx) p.contest_context = contestCtx;
      return ok(res, { problem: p });
    }
    if (seg[0] === 'problems' && seg.length === 2 && method === 'PUT') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = problems.updateProblem(parseInt(seg[1], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // ---------------- 题目批量导入（JSON / ZIP） ----------------
    // 导入预检：只解析、不写入，返回将导入的题目列表与同名冲突情况
    if (seg[0] === 'problems' && seg[1] === 'import' && seg[2] === 'preview' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req, 128 * 1024 * 1024);
      const importer = require('./src/problem-import');
      let list = null;
      if (body.zip_base64) {
        const parsed = importer.problemsFromZip(body.zip_base64);
        if (parsed.error) return fail(res, 400, parsed.error);
        list = parsed.problems;
      } else if (Array.isArray(body.problems)) {
        list = body.problems;
      } else if (body.problems && typeof body.problems === 'object') {
        list = [body.problems];
      } else if (body.json) {
        try {
          const parsed = typeof body.json === 'string' ? JSON.parse(body.json) : body.json;
          list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.problems) ? parsed.problems : [parsed]);
        } catch (e) { return fail(res, 400, 'JSON 解析失败：' + e.message); }
      }
      if (!list || !list.length) return fail(res, 400, '没有可导入的题目（请提供 problems 数组或 zip_base64）');
      const items = importer.previewProblems(list);
      return ok(res, {
        items,
        total: items.length,
        new_count: items.filter((it) => !it.error && !it.exists).length,
        conflict_count: items.filter((it) => !it.error && it.exists).length,
        error_count: items.filter((it) => it.error).length,
        testcases: items.reduce((n, it) => n + (it.testcases || 0), 0),
      });
    }
    if (seg[0] === 'problems' && seg[1] === 'import' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req, 128 * 1024 * 1024);
      const importer = require('./src/problem-import');
      let list = null;
      if (body.zip_base64) {
        const parsed = importer.problemsFromZip(body.zip_base64);
        if (parsed.error) return fail(res, 400, parsed.error);
        list = parsed.problems;
      } else if (Array.isArray(body.problems)) {
        list = body.problems;
      } else if (body.problems && typeof body.problems === 'object') {
        list = [body.problems];
      } else if (body.json) {
        try {
          const parsed = typeof body.json === 'string' ? JSON.parse(body.json) : body.json;
          list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.problems) ? parsed.problems : [parsed]);
        } catch (e) { return fail(res, 400, 'JSON 解析失败：' + e.message); }
      }
      if (!list || !list.length) return fail(res, 400, '没有可导入的题目（请提供 problems 数组或 zip_base64）');
      const r = importer.importProblems(list, {
        overwrite: body.overwrite === true,
        onConflict: typeof body.on_conflict === 'string' ? body.on_conflict : '',
        adminId: admin.id,
      });
      return ok(res, {
        created: r.created,
        skipped: r.skipped || [],
        errors: r.errors,
        count: r.created.length,
        skipped_count: (r.skipped || []).length,
      });
    }
    if (seg[0] === 'problems' && seg.length === 2 && method === 'DELETE') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const r = problems.deleteProblem(parseInt(seg[1], 10));
      if (r && r.error) return fail(res, 404, r.error);
      return ok(res);
    }
    if (seg[0] === 'problems' && seg[2] === 'editorial-closed' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = problems.setEditorialClosed(parseInt(seg[1], 10), body.closed === true);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { editorial_closed: r.editorial_closed });
    }
    if (seg[0] === 'problems' && seg[2] === 'testcases' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      return ok(res, {
        testcases: problems.getTestcases(parseInt(seg[1], 10)),
        subtask_scores: problems.getSubtaskScores(parseInt(seg[1], 10)),
        subtask_types: problems.getSubtaskTypes(parseInt(seg[1], 10)),
        // 通信题的连接方式 / 通信量上限（存在 meta.json 里，后台编辑页用来回显）
        communication: problems.getCommunicationConfig(parseInt(seg[1], 10)),
      });
    }
    if (seg[0] === 'problems' && seg[2] === 'checker' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      return ok(res, { content: problems.getChecker(parseInt(seg[1], 10)) });
    }
    if (seg[0] === 'problems' && seg[2] === 'checker' && method === 'PUT') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = problems.saveChecker(parseInt(seg[1], 10), body.content);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { has_checker: r.has_checker });
    }
    if (seg[0] === 'problems' && seg[2] === 'testdata' && seg[3] === 'upload' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readBody(req, 256 * 1024 * 1024); // 测试数据包可达数百 MB
      const r = problems.uploadTestdataZip(parseInt(seg[1], 10), body.zip_base64, body.meta, { overwrite: body.overwrite !== false });
      if (r.error) return fail(res, 400, r.error);
      return ok(res, {
        count: r.count, pairs: r.pairs, subtasks: r.subtasks, overwrite: r.overwrite, merged_count: r.merged_count,
        has_checker: r.has_checker,
        // 交互题：数据包内若含 interactor.cpp / grader.cpp / *.h 会一并写入，这里回读当前状态
        has_interactor: !!r.has_interactor, has_grader: !!r.has_grader, interactive_headers: r.interactive_headers || [],
      });
    }
    if (seg[0] === 'problems' && seg[2] === 'testcases' && method === 'PUT') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      // 测试数据可达数百 MB（大数据包评测），放宽请求体上限
      const body = await readBody(req, 256 * 1024 * 1024);
      const r = problems.setTestcases(parseInt(seg[1], 10), body.testcases, body.meta);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { count: r.count, subtasks: r.subtasks });
    }
    // ---------------- 题目附件：管理员上传 / 所有人下载 ----------------
    if (seg[0] === 'problems' && seg[2] === 'attachments') {
      const pid = parseInt(seg[1], 10);
      const isAdmin = !!(viewer && viewer.is_admin);
      // 可见性：公开题目任何人可看；未公开题目仅题目管理权限用户（或通过比赛上下文）可见
      const canManageProblem = isAdmin || hasPerm(viewer, 'problem');
      const p = problems.getProblem(pid, viewer && viewer.id, isAdmin, canManageProblem);
      if (!p || p.forbidden) return fail(res, canManageProblem ? 404 : 403, '题目不可见');
      if (seg.length === 3 && method === 'GET') {
        return ok(res, { items: attachments.list(pid), max_bytes: attachments.MAX_BYTES });
      }
      if (seg.length === 4 && method === 'GET') {
        let name;
        try { name = decodeURIComponent(seg[3]); } catch { name = seg[3]; }
        const file = attachments.filePath(pid, name);
        if (!file) return fail(res, 404, '附件不存在');
        const stat = require('fs').statSync(file);
        const safeAscii = String(name).replace(/[^\x20-\x7e]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'no-store',
        });
        require('fs').createReadStream(file).pipe(res);
        return;
      }
      if (seg.length === 3 && method === 'POST') {
        const admin = requirePerm('problem')(req, res);
        if (!admin) return;
        const body = await readBody(req, 64 * 1024 * 1024);
        const r = attachments.save(pid, body.name, body.data_base64);
        if (r.error) return fail(res, 400, r.error);
        return ok(res, { name: r.name, size: r.size, items: attachments.list(pid) });
      }
      if (seg.length === 4 && method === 'DELETE') {
        const admin = requirePerm('problem')(req, res);
        if (!admin) return;
        let name;
        try { name = decodeURIComponent(seg[3]); } catch { name = seg[3]; }
        const r = attachments.remove(pid, name);
        if (r.error) return fail(res, 400, r.error);
        return ok(res, { items: attachments.list(pid) });
      }
    }
    if (seg[0] === 'problems' && seg[2] === 'submit' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      // 提交答案题的答案文件上限 32MB（base64 后约 43MB），因此这里放宽请求体上限
      const body = await readBody(req, 64 * 1024 * 1024);
      const problemId = parseInt(seg[1], 10);
      let contestId = null;
      if (body.contest_id) {
        const cid = parseInt(body.contest_id, 10);
        const v = contest.validateContestSubmit(cid, problemId, user.id, user.is_admin);
        if (v.error) return fail(res, 400, v.error);
        contestId = cid;
      }
      // 通信题（problem_type = 'communication'）：body.code2 是第二个选手程序（程序二）的源码
      const r = submissions.createSubmission(user.id, problemId, body.language, body.code, contestId, body.answer_file, body.enable_o2, body.code2);
      if (r.error) return fail(res, 400, r.error);
      queue.submit(r.id);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'submissions' && seg.length === 2 && method === 'GET') {
      const s = submissions.getSubmission(parseInt(seg[1], 10), viewer);
      if (!s) return fail(res, 404, '提交不存在');
      // M10：未登录 / 他人提交只在「管理员 或 该题公开且赛后」时可见
      if (s.forbidden) return fail(res, 403, s.forbidden);
      return ok(res, { submission: s });
    }
        // ---------------- 站内信（私信）----------------
        // 功能开关「私信」关闭时：相关接口一律返回 403「私信功能已关闭」（不删除任何数据，重新开启即恢复）
if (seg[0] === 'messages') {
  if (require('./src/settings').getSetting('pm_enabled', '1') !== '1') return fail(res, 403, '私信功能已关闭');
}
if (seg[0] === 'messages' && seg[1] === 'conversations' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, { items: messages.listConversations(user.id) });
    }
    if (seg[0] === 'messages' && seg[1] === 'unread-count' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, { count: messages.unreadCount(user.id) });
    }
    if (seg[0] === 'messages' && seg[1] === 'conversation' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const other = parseInt(url.searchParams.get('with') || '0', 10);
      if (!other) return fail(res, 400, '缺少会话对象');
      const r = messages.getConversation(user.id, other, parseInt(url.searchParams.get('before') || '0', 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'messages' && seg[1] === 'send' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const r = messages.send(user.id, body.to, body.content);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'users' && seg[1] === 'lookup' && method === 'GET') {
      // 仅用于「发私信」弹窗查找用户：私信关闭时一并拦截
      if (require('./src/settings').getSetting('pm_enabled', '1') !== '1') return fail(res, 403, '私信功能已关闭');
      const user = requireAuth(req, res);
      if (!user) return;
      const r = messages.lookupUser(url.searchParams.get('q'));
      if (r.error) return fail(res, 404, r.error);
      return ok(res, { user: r });
    }
if (seg[0] === 'users' && seg.length === 2 && method === 'GET') {
      let username;
      try { username = decodeURIComponent(seg[1]); } catch { username = seg[1]; }
      const p = users.getProfile(username, viewer);
      if (!p) return fail(res, 404, '用户不存在');
      return ok(res, { user: p });
    }
    if (seg[0] === 'users' && seg[2] === 'activity' && method === 'GET') {
      const u = resolveUserIdent(seg[1]);
      if (!u) return fail(res, 404, '用户不存在');
      const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get('days') || '180', 10)));
      return ok(res, { items: users.getActivity(u.id, days) });
    }
    if (seg[0] === 'users' && seg[2] === 'editorials' && method === 'GET') {
      const u = resolveUserIdent(seg[1]);
      if (!u) return fail(res, 404, '用户不存在');
      return ok(res, { editorials: users.getUserEditorials(u.id) });
    }
    if (seg[0] === 'users' && seg[2] === 'rating-history' && method === 'GET') {
      const u = resolveUserIdent(seg[1]);
      if (!u) return fail(res, 404, '用户不存在');
      // recent 省略 / 0 = 返回全部参加过的 Rated 比赛记录；显式给正整数则只取最近 N 场
      const raw = parseInt(url.searchParams.get('recent') || '0', 10);
      const recent = Number.isFinite(raw) && raw > 0 ? raw : 0;
      return ok(res, { items: users.getRatingHistory(u.id, recent), total: users.getRatingHistoryCount(u.id) });
    }

    /* ---------------- 网站图标（favicon，v2.7.9） ----------------
     * 注意：GET /api/favicon 是**单段路径**，已在 handleApi 顶部的 `seg.length === 1` 块里
     *   分发（见该文件上方 "网站图标（favicon）—— 单段路径 /api/favicon 必须在这里分发"）。
     *   放在本块（两段及以上路径）里会永远匹配不到，表现为 /api/favicon 恒 404 —— 这里不再重复实现。
     * 本处只保留两段路径的写接口：POST / DELETE /api/admin/favicon。 */

    /* POST /api/admin/favicon：上传网站图标（仅超级管理员）。两种提交方式都支持：
     *   · Content-Type: application/json + { data: 'data:image/png;base64,...' }（后台设置页用）；
     *   · 原始字节（Content-Type: image/png 等，便于 curl --data-binary @icon.png 直传）。
     *   { reset: true } 等价于「恢复默认」。落盘前一律走 src/favicon.js 的魔数校验
     *   （只信文件头，不信声明的 MIME / 扩展名）；只允许 png/jpg/svg/ico/webp 且 ≤ 512KB。 */
    if (seg[0] === 'admin' && seg[1] === 'favicon' && seg.length === 2 && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const favicon = require('./src/favicon');
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      let buf = null;
      let declared = '';
      if (ctype.includes('application/json')) {
        const body = await readBody(req);
        if (body && body.reset) { favicon.reset(); return ok(res, { favicon: favicon.status() }); }
        const parsed = parseFaviconDataUrl(body && body.data);
        if (!parsed) return fail(res, 400, '图标数据无效（需要 data:image/... 的 base64 数据）');
        buf = parsed.buf;
        declared = parsed.mime;
      } else {
        buf = await readRawBody(req, favicon.MAX_BYTES + 1024);
        declared = ctype.split(';')[0].trim();
      }
      const r = favicon.save(buf, declared);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { favicon: favicon.status(), message: '网站图标已更新' });
    }
    /* DELETE /api/admin/favicon：恢复默认图标（清空 site_favicon 键并删除已上传文件） */
    if (seg[0] === 'admin' && seg[1] === 'favicon' && seg.length === 2 && method === 'DELETE') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const favicon = require('./src/favicon');
      const r = favicon.reset();
      return ok(res, { favicon: favicon.status(), message: '已恢复默认图标' });
    }

    // 用户头像文件（头像不再以 base64 存库；带 ?v= 版本号可长期缓存）
    // v2.5.0 修复：以前只判「文件是否存在」，一个 0 字节 / 截断的 <uid>.png 会让兜底
    //   生成永远不再触发，浏览器拿到解不开的图（admin 的 1.png = 72 字节全 0，裂图）。
    //   现在按「文件是否存在 + 内容是否真的是完整图片」双条件判断，坏文件一律重新生成。
    if (seg[0] === 'avatars' && seg.length === 2 && method === 'GET') {
      const uid = parseInt(seg[1], 10);
      const avatars = require('./src/avatars');
      const numeric = Number.isFinite(uid) && String(seg[1]).trim() !== '';
      let img = numeric ? avatars.load(uid) : null;
      // 兜底 1：文件缺失 / 0 字节 / 截断 / 非图片（历史账号、文件被清理、写入中断）时按
      //   用户名即时生成像素头像，并把带新版本号的地址回写数据库 —— 浏览器据此换新 URL，
      //   不会继续命中旧的坏图缓存。注意：外链头像（http(s)://）的用户绝不覆盖。
      if (!img && numeric) {
        try {
          const u = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(uid);
          if (u) {
            const url = avatars.ensureIdenticon(u.id, u.username);
            img = avatars.load(uid);
            const stored = String(u.avatar || '');
            if (img && url && (!stored || stored.startsWith('/api/avatars/'))) {
              try { db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatars.urlFor(uid, Date.now()), uid); } catch { /* ignore */ }
            }
          }
        } catch { /* 生成失败 → 走下面的内置默认头像兜底 */ }
      }
      // 兜底 2：连生成都失败（磁盘不可写 / 生成器异常）→ 回内置默认头像图，
      //   状态码仍是 200 + image/*，绝不 404 / 500 / 裂图。
      if (!img && numeric) img = { file: null, buf: avatars.defaultAvatar(), mime: 'image/png' };
      if (!img) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
      const etag = '"' + require('crypto').createHash('sha1').update(img.buf).digest('hex').slice(0, 20) + '"';
      const cacheControl = /[?&]v=/.test(req.url || '') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
      const headers = {
        'Content-Type': img.mime,
        'Content-Length': img.buf.length,
        'ETag': etag,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
      };
      if (img.file) { try { headers['Last-Modified'] = new Date(fs.statSync(img.file).mtimeMs).toUTCString(); } catch { /* ignore */ } }
      if (String(req.headers['if-none-match'] || '') === etag) {
        delete headers['Content-Length'];
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(img.buf);
      return;
    }

    // 收藏
    if (seg[0] === 'favorites' && seg.length === 3 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      users.removeFavorite(user.id, seg[1], seg[2]);
      return ok(res);
    }
    // 兼容旧路径 /api/favorites/:problemId
    if (seg[0] === 'favorites' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      users.removeFavorite(user.id, 'problem', seg[1]);
      return ok(res);
    }
    // 重发邮箱验证码。
    // v2.5.0（任务 2）：重发成功后把 **verify 场景**（IP + 邮箱）的失败计数与临时锁定清零，
    //   让用户拿到新验证码就能立刻验证，不必干等 H4 的约 10 分钟锁定；登录 / 注册 / 找回等
    //   其它 scope 的防爆破策略完全不动（throttleReset 只按 scope='verify' 删除）。
    //   为避免「重置限流」变成无限刷的入口，重发本身另加一个宽松上限：
    //   同一 IP + 邮箱每分钟最多 RESEND_LIMIT.maxPerWindow 次（默认 3，OJ_RESEND_MAX_PER_MINUTE 可调）。
    if (seg[0] === 'verify-email' && seg[1] === 'resend' && method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      // 1) 重发频率上限（只统计成功的重发；失败请求仍由下面 H4 的 resend 失败锁定负责）
      const rl = resendLimitStatus(ip, body.email);
      if (rl.limited) return fail(res, 429, resendLimitMessage(rl.retryAfterMs));
      // 2) H4：重发的失败计数（连续失败同样按 IP + 邮箱临时锁定）
      const gate = throttleStatus('resend', ip, body.email);
      if (gate.locked) return fail(res, 429, throttleMessage(gate.retryAfterMs));
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      const r = await require('./src/auth').resendVerifyCode(body.email);
      if (r.error) { throttleFail('resend', ip, body.email); return fail(res, 400, r.error); }
      if (r.reissued) {
        resendLimitHit(ip, body.email);
        // 3) 换发了新验证码 → 立刻清掉该 IP + 邮箱的 verify 限流（含 5 次错误后的 10 分钟锁定）
        const cleared = throttleReset('verify', ip, body.email);
        if (cleared) console.log(`[OJ] 重发验证码成功，已重置 verify 限流（IP ${ip} / 邮箱 ${body.email}，清除 ${cleared} 条记录）`);
      }
      // H5：验证码只走邮件，绝不下发响应体；L2：不区分「邮箱是否存在待验证记录」
      return ok(res, {
        email_sent: !!r.email_sent,
        email_reason: r.reason || '',
        message: r.message || '如果该邮箱有待验证的注册，验证码已重新发送，请查收邮件',
      });
    }

    // 题解与专栏（全站文章流）
    if (seg[0] === 'me' && seg[1] === 'password' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      // M2：保留当前会话，吊销该用户其它设备的会话；前端提示「其他设备已退出登录」
      let keepToken = null;
      const m = String(req.headers.cookie || '').match(/oj_session=([^;]+)/);
      if (m) { try { keepToken = decodeURIComponent(m[1].trim()); } catch { keepToken = m[1].trim(); } }
      const r = users.changePassword(user.id, body.old_password, body.new_password, keepToken, clientIp(req));
      if (r.error) return fail(res, r.status || 400, r.error);
      return ok(res, {
        sessions_revoked: r.sessions_revoked || 0,
        message: r.sessions_revoked ? `密码已更新，其他 ${r.sessions_revoked} 个设备的登录已失效` : '密码已更新',
      });
    }
    if (seg[0] === 'notifications' && seg[1] === 'read-all' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      notifications.markAllRead(user.id);
      return ok(res);
    }
    if (seg[0] === 'notifications' && seg.length === 2 && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      notifications.markRead(user.id, parseInt(seg[1], 10));
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg.length === 2 && method === 'GET') {
      const d = discussion.getDiscussion(parseInt(seg[1], 10), url.searchParams);
      if (!d) return fail(res, 404, '讨论不存在');
      if (viewer) d.is_favorite = users.isFavorite(viewer.id, 'discussion', d.id);
      return ok(res, { discussion: d });
    }
    if (seg[0] === 'discussions' && seg[2] === 'pin' && method === 'POST') {
      const user = requirePerm('discussion')(req, res);
      if (!user) return;
      const body = await readBody(req);
      const r = discussion.pinDiscussion(parseInt(seg[1], 10), user, body.pinned);
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg.length === 2 && method === 'PUT') {
      const user = requirePerm('discussion')(req, res);
      if (!user) return;
      const body = await readBody(req);
      const r = discussion.updateDiscussion(parseInt(seg[1], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = discussion.deleteDiscussion(parseInt(seg[1], 10), user.id, hasPerm(user, 'discussion'));
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussion-replies' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = discussion.deleteReply(parseInt(seg[1], 10), user.id, hasPerm(user, 'discussion'));
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg[2] === 'replies' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_speak) return fail(res, 403, '你已被撤销自由发言权限');
      const settings = require('./src/settings');
      if (settings.getSetting('discussion_enabled', '1') !== '1') {
        return fail(res, 403, '讨论功能已关闭');
      }
      const body = await readBody(req);
      const r = discussion.createReply(user.id, parseInt(seg[1], 10), body.content, user.username);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }

    // 比赛
    if (seg[0] === 'contests' && seg.length === 2 && method === 'GET') {
      const c = contest.getContest(parseInt(seg[1], 10), viewer && viewer.id, viewer && viewer.is_admin);
      if (!c) return fail(res, 404, '比赛不存在');
      if (c.forbidden) return fail(res, 403, '比赛不可见');
      if (viewer) c.is_favorite = users.isFavorite(viewer.id, 'contest', c.id);
      return ok(res, { contest: c });
    }
    if (seg[0] === 'contests' && seg.length === 2 && method === 'PUT') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = contest.updateContest(parseInt(seg[1], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'contests' && seg.length === 2 && method === 'DELETE') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const r = contest.deleteContest(parseInt(seg[1], 10));
      if (r && r.error) return fail(res, 404, r.error);
      return ok(res);
    }
    if (seg[0] === 'contests' && seg[2] === 'standings' && method === 'GET') {
      const s = contest.getStandings(parseInt(seg[1], 10), viewer);
      if (!s) return fail(res, 404, '比赛不存在');
      return ok(res, { standings: s });
    }
    if (seg[0] === 'contests' && seg[2] === 'signup' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const r = contest.signup(parseInt(seg[1], 10), user.id, body.rated);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { rated: !!r.rated, note: r.note || null });
    }
    if (seg[0] === 'contests' && seg[2] === 'unsignup' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      contest.unsignup(parseInt(seg[1], 10), user.id);
      return ok(res);
    }
    if (seg[0] === 'contests' && seg[2] === 'problems' && method === 'PUT') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = contest.setContestProblems(parseInt(seg[1], 10), body.problem_ids);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { count: r.count });
    }
    if (seg[0] === 'contests' && seg[2] === 'end' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      db.prepare('UPDATE contests SET end_time = ? WHERE id = ?').run(Date.now(), parseInt(seg[1], 10));
      return ok(res);
    }
    if (seg[0] === 'contests' && seg[2] === 'apply-ratings' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const r = contest.applyRatings(parseInt(seg[1], 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { count: r.count, skipped: !!r.skipped, rating_applied: !!r.rating_applied });
    }
    if (seg[0] === 'contests' && seg[2] === 'toggle-public' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const r = contest.toggleContestPublic(parseInt(seg[1], 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { is_public: r.is_public });
    }

    // 题解
    if (seg[0] === 'problems' && seg[2] === 'editorials' && seg.length === 3 && method === 'GET') {
      const list = editorial.listEditorials(parseInt(seg[1], 10), viewer);
      return ok(res, { editorials: list });
    }
    if (seg[0] === 'problems' && seg[2] === 'editorials' && seg[3] === 'top' && method === 'GET') {
      const list = editorial.listTopEditorials(parseInt(seg[1], 10), viewer, 3);
      return ok(res, { editorials: list });
    }
    if (seg[0] === 'problems' && seg[2] === 'editorials' && seg[3] === 'all' && method === 'GET') {
      const r = editorial.listEditorialsPaged(parseInt(seg[1], 10), viewer, url.searchParams);
      return ok(res, r);
    }
    if (seg[0] === 'problems' && seg[2] === 'editorials' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_editorial) return fail(res, 403, '你已被撤销发布题解的权限');
      const settings = require('./src/settings');
      if (settings.getSetting('article_enabled', '1') !== '1') {
        return fail(res, 403, '题解与专栏功能已关闭');
      }
      const body = await readBody(req);
      const r = editorial.createEditorial(parseInt(seg[1], 10), user.id, body.title, body.content, body.category, body.submit);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id, status: r.status });
    }
    if (seg[0] === 'editorials' && seg.length === 2 && method === 'GET') {
      const e = editorial.getEditorial(parseInt(seg[1], 10), viewer);
      if (!e) return fail(res, 404, '题解不存在');
      if (e.forbidden) return fail(res, 403, '题解未通过审核，暂不可查看');
      return ok(res, { editorial: e });
    }
    if (seg[0] === 'editorials' && seg.length === 2 && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_editorial && !user.is_admin) return fail(res, 403, '你已被撤销发布题解的权限');
      // 管理员编辑他人文章需要对应「题解管理/专栏管理」权限
      const edRow = db.prepare('SELECT problem_id FROM editorials WHERE id = ?').get(parseInt(seg[1], 10));
      const canManage = edRow ? hasPerm(user, edRow.problem_id ? 'editorial' : 'article') : false;
      const body = await readBody(req);
      const r = editorial.updateEditorial(parseInt(seg[1], 10), user.id, canManage, body.title, body.content, body.category, body.submit, body.problem_id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { status: r.status });
    }
    if (seg[0] === 'editorials' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const edRow = db.prepare('SELECT problem_id FROM editorials WHERE id = ?').get(parseInt(seg[1], 10));
      const canManage = edRow ? hasPerm(user, edRow.problem_id ? 'editorial' : 'article') : false;
      const r = editorial.deleteEditorial(parseInt(seg[1], 10), user.id, canManage);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'editorials' && seg[2] === 'comments' && method === 'GET') {
      return ok(res, { comments: editorial.listComments(parseInt(seg[1], 10), url.searchParams) });
    }
    if (seg[0] === 'editorials' && seg[2] === 'comments' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_speak) return fail(res, 403, '你已被撤销自由发言权限');
      const body = await readBody(req);
      const r = editorial.createComment(parseInt(seg[1], 10), user.id, body.content, user.username);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'editorial-comments' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      // 管理员删除评论需对应「题解管理/专栏管理」权限
      const cRow = db.prepare(`
        SELECT e.problem_id FROM editorial_comments c JOIN editorials e ON e.id = c.editorial_id WHERE c.id = ?
      `).get(parseInt(seg[1], 10));
      const canManage = cRow ? hasPerm(user, cRow.problem_id ? 'editorial' : 'article') : false;
      const r = editorial.deleteComment(parseInt(seg[1], 10), user.id, canManage);
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'editorials' && seg[2] === 'like' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = editorial.toggleLike(parseInt(seg[1], 10), user.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'editorials' && seg[2] === 'review' && method === 'POST') {
      // 审核权限与对应管理权限均可审核（审核权限不能编辑/删除，管理权限可编辑且可审核）
      const edRow = db.prepare('SELECT problem_id FROM editorials WHERE id = ?').get(parseInt(seg[1], 10));
      if (!edRow) return fail(res, 404, '题解不存在');
      const isEditorial = !!edRow.problem_id;
      const admin = requireAnyPerm(isEditorial ? ['editorial_review', 'editorial'] : ['article_review', 'article'])(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = editorial.reviewEditorial(parseInt(seg[1], 10), admin, body.status, body.reason);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { status: r.status });
    }

    // 管理端：下一篇待审核文章（审核后自动跳转）
    if (seg[0] === 'admin' && seg[1] === 'editorials' && seg[2] === 'next-pending' && method === 'GET') {
      const admin = requireAnyPerm(['editorial_review','article_review','editorial','article'])(req, res);
      if (!admin) return;
      const kind = url.searchParams.get('kind') || '';
      const after = url.searchParams.get('after') || '0';
      return ok(res, { id: editorial.nextPendingId(kind, after) });
    }
    // 管理端：题解 / 专栏管理列表（kind=article 只看专栏且不含分类「题解」，kind=editorial 只看题解）
    if (seg[0] === 'admin' && seg[1] === 'editorials' && seg.length === 2 && method === 'GET') {
      const admin = requireAnyPerm(['editorial_review','article_review','editorial','article'])(req, res);
      if (!admin) return;
      const r = editorial.listAllEditorials(url.searchParams);
      return ok(res, r);
    }

    // 管理端：讨论管理（仅超级管理员）
    if (seg[0] === 'admin' && seg[1] === 'discussions' && method === 'GET') {
      const admin = requirePerm('discussion')(req, res);
      if (!admin) return;
      return ok(res, discussion.listAllDiscussions(url.searchParams));
    }
    if (seg[0] === 'admin' && seg[1] === 'replies' && method === 'GET') {
      const admin = requirePerm('discussion')(req, res);
      if (!admin) return;
      return ok(res, discussion.listAllReplies(url.searchParams));
    }

    // 管理端：用户管理（仅超级管理员）
    if (seg[0] === 'admin' && seg[1] === 'users' && method === 'GET') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const r = users.listUsers(url.searchParams);
      return ok(res, r);
    }
    if (seg[0] === 'admin' && seg[1] === 'users' && seg.length === 3 && method === 'PUT') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = users.updateUserPermissions(admin, parseInt(seg[2], 10), body);
      if (r.error) return fail(res, 403, r.error);
      return ok(res, r);
    }
    // 管理端：编辑用户资料（昵称/邮箱/简介）
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'profile' && method === 'PUT') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = users.adminUpdateProfile(admin, parseInt(seg[2], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // 管理端：重置用户密码
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'password' && method === 'PUT') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = users.adminSetPassword(admin, parseInt(seg[2], 10), body.new_password, clientIp(req));
      if (r.error) return fail(res, r.status || 400, r.error);
      // M2：管理员重置口令后该用户全部会话已失效，返回提示供后台展示
      return ok(res, {
        sessions_revoked: r.sessions_revoked || 0,
        message: r.sessions_revoked ? `密码已重置，该用户的 ${r.sessions_revoked} 个登录会话已失效` : '密码已重置，该用户需重新登录',
      });
    }
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'brown' && method === 'POST') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const r = users.brownName(admin, parseInt(seg[2], 10), body.type, body.contest_id);
      // v2.7.0：brownName 现在「先校验、后写入」，校验失败返回 400 且数据库零改动；
      // 事务写入失败返回 500（已回滚）。两者都不允许出现「报了错却已经处罚」的静默状态。
      if (r.error) return fail(res, r.status || 400, r.error);
      return ok(res, { detail: r.detail, brown_name_until: r.brown_name_until || 0 });
    }
    // 管理端：解除棕名
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'unbrown' && method === 'POST') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const r = users.unBrown(admin, parseInt(seg[2], 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { ok: true });
    }
    // 题目重判进度（仅超级管理员）
    if (seg[0] === 'rejudge' && seg[1] === 'progress' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      return ok(res, require('./src/rejudge').progress());
    }
    // 管理端：反馈 / 举报审核（仅超级管理员）
    if (seg[0] === 'admin' && seg[1] === 'feedbacks' && seg.length === 2 && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '反馈审核仅最高管理员可访问');
      return ok(res, require('./src/feedback').listAllFeedbacks(url.searchParams));
    }
    if (seg[0] === 'admin' && seg[1] === 'feedbacks' && seg.length === 3 && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '反馈审核仅最高管理员可访问');
      const body = await readBody(req);
      // v2.8.3：已处理 / 已关闭的反馈同样允许再次处理（handleFeedback 内累加 handle_count 并写审计 + 通知提交者）
      const r = require('./src/feedback').handleFeedback(parseInt(seg[2], 10), body, admin, clientIp(req));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    // 管理端：批量删除 / 重置（仅 admin 账号，隐藏入口在系统设置）
    if (seg[0] === 'admin' && seg[1] === 'batch-delete' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '仅最高管理员可操作');
      const body = await readBody(req);
      const r = users.batchDelete(admin.id, body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    // 管理端：批量生成用户（仅 admin，系统设置入口）
    if (seg[0] === 'admin' && seg[1] === 'batch-users' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '仅最高管理员可操作');
      const body = await readBody(req);
      const r = users.batchCreateUsers(admin, body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    /* ---------------- 清理多余数据（仅 admin；白名单式，详见 src/cleanup.js） ----------------
     * GET  /api/admin/cleanup/preview  只读预览：每个分类的数量 / 占用空间（不删任何东西）
     * POST /api/admin/cleanup          执行清理：body = { categories: [...], params: {...} }
     * 二者都要求超级管理员（且仅内置 admin 账号），写接口还走全局 CSRF 同源校验。
     * 允许清理的分类由 src/cleanup.js 的 CATEGORY_DEFS 白名单决定，请求里给别的 key 一律忽略。 */
    if (seg[0] === 'admin' && seg[1] === 'cleanup' && seg[2] === 'preview' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '清理数据仅最高管理员可操作');
      return ok(res, require('./src/cleanup').preview({
        log_max_kb: url.searchParams.get('log_max_kb'),
        log_keep_kb: url.searchParams.get('log_keep_kb'),
        min_age_min: url.searchParams.get('min_age_min'),
        grader_stale_days: url.searchParams.get('grader_stale_days'),
        // 强制全清（默认关闭）：勾选后预览也按「连被题目引用的缓存一起清」的口径统计，
        // 这样管理员在点「清理」之前就能看到真正会被删除的条数与空间。
        force: url.searchParams.get('force'),
      }));
    }
    if (seg[0] === 'admin' && seg[1] === 'cleanup' && seg.length === 2 && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '清理数据仅最高管理员可操作');
      const body = await readBody(req);
      const r = require('./src/cleanup').run(
        Array.isArray(body.categories) ? body.categories : [],
        body.params && typeof body.params === 'object' ? body.params : {},
        admin,
        clientIp(req)
      );
      return ok(res, r);
    }
    // ---------------- 版本更新（仅最高管理员，可在后台直接更新程序代码） ----------------
    // 检查更新：返回最新版本、当前运行状态与进程守护方式
    if (seg[0] === 'admin' && seg[1] === 'update' && seg.length === 2 && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '版本更新仅最高管理员可操作');
      const updater = require('./src/updater');
      const v = await updater.check({ force: url.searchParams.get('force') === '1' });
      return ok(res, { ...v, state: updater.getState(), supervisor: updater.detectSupervisor() });
    }
    // 更新进度：前端轮询这个接口显示阶段与日志
    if (seg[0] === 'admin' && seg[1] === 'update' && seg[2] === 'status' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '版本更新仅最高管理员可操作');
      return ok(res, { state: require('./src/updater').getState() });
    }
    // 开始更新：先返回 200，再在后台执行（更新会覆盖代码并重启服务，不能阻塞响应）
    if (seg[0] === 'admin' && seg[1] === 'update' && seg[2] === 'start' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '版本更新仅最高管理员可操作');
      const updater = require('./src/updater');
      if (updater.getState().running) return fail(res, 409, '已有更新任务正在进行中');
      const body = await readBody(req).catch(() => ({}));
      setTimeout(() => {
        updater.start({
          backup: body.backup !== false,
          restart: body.restart !== false,
          force: body.force === true,
          // 本次更新跑在对外服务的进程里：重启助手需要等本进程退出才能接管端口
          selfServing: true,
        }).catch((e) => console.error('[update] 执行异常：', e));
      }, 80);
      return ok(res, {
        started: true,
        backup: body.backup !== false,
        restart: body.restart !== false,
        supervisor: updater.detectSupervisor(),
      });
    }
  }

  /* ---------------- 讨论板块 / 文章分类配置（v2.7.0 后台「板块与分类管理」） ----------------
   * 读接口公开（匿名可读）：前端启动与讨论页 / 文章页 / 编辑器都从这里取板块与分类，
   *   不再硬编码；旧内容里不在配置表的取值由前端回退显示原始 key，不会出现 undefined / 空白。
   * 写接口仅超级管理员：requireSuperAdmin → 匿名 401、普通管理员 403；沿用全局 CSRF 同源校验；
   *   每次写都落审计（admin_audit + moderation_logs，动作名 board_* / category_*）。
   * DELETE 支持 ?move_to=<key>：先把该板块 / 分类下的内容批量迁移到目标，再删除配置行，
   *   两步在同一事务内完成；仍有内容且未给 move_to 时拒绝删除并返回条数。
   * 注意：这些路由必须放在 handleApi 顶部的 `if (seg.length === 1)` 块**之外**
   *   （PUT / DELETE 的路径带 key，seg.length 为 2，放进那个块会永远匹配不到而为 404）。 */
  if (seg[0] === 'discussion-boards' && seg.length === 1 && method === 'GET') {
    return ok(res, taxonomy.listBoards());
  }
  if (seg[0] === 'discussion-boards' && seg.length === 1 && method === 'POST') {
    const admin = requireSuperAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    const r = taxonomy.createBoard(body, admin, clientIp(req));
    if (r.error) return fail(res, r.status || 400, r.error);
    return ok(res, r);
  }
  if (seg[0] === 'discussion-boards' && seg.length === 2 && method === 'PUT') {
    const admin = requireSuperAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    const r = taxonomy.updateBoard(decodeSeg(seg[1]), body, admin, clientIp(req));
    if (r.error) return fail(res, r.status || 400, r.error);
    return ok(res, r);
  }
  if (seg[0] === 'discussion-boards' && seg.length === 2 && method === 'DELETE') {
    const admin = requireSuperAdmin(req, res);
    if (!admin) return;
    const r = taxonomy.deleteBoard(decodeSeg(seg[1]), url.searchParams.get('move_to'), admin, clientIp(req));
    if (r.error) return fail(res, r.status || 400, r.error);
    return ok(res, r);
  }
  if (seg[0] === 'article-categories' && seg.length === 1 && method === 'GET') {
    return ok(res, taxonomy.listCategories());
  }
  if (seg[0] === 'article-categories' && seg.length === 1 && method === 'POST') {
    const admin = requireSuperAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    const r = taxonomy.createCategory(body, admin, clientIp(req));
    if (r.error) return fail(res, r.status || 400, r.error);
    return ok(res, r);
  }
  if (seg[0] === 'article-categories' && seg.length === 2 && method === 'PUT') {
    const admin = requireSuperAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    const r = taxonomy.updateCategory(decodeSeg(seg[1]), body, admin, clientIp(req));
    if (r.error) return fail(res, r.status || 400, r.error);
    return ok(res, r);
  }
  if (seg[0] === 'article-categories' && seg.length === 2 && method === 'DELETE') {
    const admin = requireSuperAdmin(req, res);
    if (!admin) return;
    const r = taxonomy.deleteCategory(decodeSeg(seg[1]), url.searchParams.get('move_to'), admin, clientIp(req));
    if (r.error) return fail(res, r.status || 400, r.error);
    return ok(res, r);
  }

  // 社区管理公布页（v2.8.6 站长要求：**只**公示「用户权限变更（含棕名）」类记录）
  //   · 鉴权：未登录 401 / 非管理员 403（该页是后台页，不再匿名可读）；分页参数不变。
  //   · 口径：动作白名单写死在 src/users.js 的 MOD_PERMISSION_ACTIONS，这里只透传 page/size，
  //     kind / action / category / type 等任何分类参数都被丢弃，无法用 URL 参数绕过看到其它分类。
  if (seg.length === 1 && seg[0] === 'moderation-logs' && method === 'GET') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const safeQuery = new URLSearchParams();
    for (const k of ['page', 'size']) {
      const v = url.searchParams.get(k);
      if (v != null) safeQuery.set(k, v);
    }
    return ok(res, users.getModerationLogs(safeQuery));
  }

  fail(res, 404, '接口不存在');
}

// 连接保活：站内频繁跳转/轮询时复用同一条 TCP 连接，避免反复握手（默认 5s 太短，切换页面常需重连）
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 300000;

server.listen(PORT, HOST, () => {
  const langs = availableLanguages();
  const avail = Object.values(langs).filter((l) => l.available).map((l) => l.name);
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  const inDocker = fs.existsSync('/.dockerenv') || String(process.env.OJ_IN_DOCKER || '') === '1';
  const admin = getAdminInitInfo();
  console.log('==============================================');
  console.log(`  LCZOJ 在线评测系统 v${VERSION} 已启动`);
  console.log(`  监听地址: ${HOST}:${PORT}（本机访问 http://${shown}${PORT === 80 ? '' : ':' + PORT}）`);
  if (inDocker) {
    // 容器内的 localhost 对用户没有意义，直接说明该用宿主机的地址
    console.log('  当前运行在 Docker 容器中：请在浏览器用「宿主机公网 IP」访问，');
    console.log(`    例如 http://<服务器公网IP>${PORT === 80 ? '' : ':' + PORT}/（端口映射 ${PORT}，云服务器还需在安全组放行）`);
  }
  console.log(`  数据目录: ${DATA_DIR}`);
  if (admin && admin.created) {
    // 首次初始化：把随机生成的初始密码直接打印出来（仅这一次），并告知落盘位置
    console.log(`  管理员账号: ${admin.username}　初始密码: ${admin.password}`);
    console.log(`    （${admin.source === 'env' ? '密码来自环境变量 OJ_ADMIN_PASSWORD' : '密码为随机生成，仅在本次启动显示'}；已保存到 ${path.relative(process.cwd(), admin.file) || admin.file}）`);
    console.log('    请登录后立即在「系统设置」中修改密码。');
  } else {
    const pwdFile = path.join(DATA_DIR, 'admin-password.txt');
    const hasPwdFile = fs.existsSync(pwdFile);
    console.log('  管理员账号: admin　密码：沿用数据库中已有的密码'
      + (hasPwdFile ? `（初始密码记录：${path.relative(process.cwd(), pwdFile) || pwdFile}）` : '（若已遗忘，见 docs/FAQ.md 的重置方法）'));
  }
  console.log(`  可用评测语言: ${avail.join(', ') || '(无)'}`);
  console.log(`  健康检查: GET /api/health　环境自检: node deploy/check-env.js`);
  console.log('==============================================');
});

/* ============================ 优雅退出（面板 / Docker 必需） ============================
 * 宝塔、小皮的「停止 / 重启」以及 `docker stop` 都会先发 SIGTERM，
 * 默认行为会直接杀掉进程、正在评测的提交会变成“判题中”残留。
 * 这里先停止接收新连接、等正在处理的请求结束（最多 8 秒）再退出。
 */
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[OJ] 收到 ${signal}，正在安全退出（等待进行中的请求，最多 8 秒）……`);
  const timer = setTimeout(() => {
    console.log('[OJ] 退出等待超时，强制结束进程。');
    process.exit(0);
  }, 8000);
  if (typeof timer.unref === 'function') timer.unref();
  try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch { /* ignore */ }
  try {
    server.close(() => {
      clearTimeout(timer);
      console.log('[OJ] 已安全退出。');
      process.exit(0);
    });
  } catch {
    clearTimeout(timer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));   // Windows 控制台 Ctrl+Break
process.on('uncaughtException', (err) => {
  console.error('[OJ] 未捕获异常：', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[OJ] 未处理的 Promise 拒绝：', err && err.stack || err);
});

module.exports = server;
