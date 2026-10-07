'use strict';

/**
 * 「清理多余数据」（系统设置子页面 #/settings/cleanup；旧地址 #/admin/cleanup 自动重定向）—— **白名单式**安全清理
 *
 * 只允许删除下面这些「缓存 / 临时 / 孤儿 / 过期」数据，且每一项都：
 *   1) 先给数量与占用空间预览（preview()），再由管理员确认后执行（run()）；
 *   2) 执行结果逐项返回「删除条数 / 释放字节数 / 失败项」；
 *   3) 写入审计（admin_audit + moderation_logs，action = cleanup_data）。
 *
 * ============================ 安全红线（务必保持） ============================
 *   · 允许触碰的**全部**根目录只有五个，且都在本文件顶部常量里写死：
 *       data/judge（评测临时目录）、data/spj_cache、data/interactor_cache、
 *       data/testdata（仅「problems 表里没有该 id」的**数字命名**子目录）、
 *       data/avatars（仅「users 表里没有该 uid」的图片文件）、logs/（仅 *.log 的尾部保留）。
 *   · 每个候选路径都必须通过 safeChild()：是根目录的**直接子项**、名字里不含路径分隔符、
 *     解析后的绝对路径仍在根目录之内、且不是符号链接 / junction。任何不满足的条目一律跳过。
 *   · users / problems / contests / submissions / editorials / discussions / notifications 这些
 *     **用户内容表一行都不删**；数据库里唯一的删除动作是「已过期」的 sessions /
 *     pending_registrations / auth_failures（这三张表不是内容数据，且过期后本就不可用）。
 *   · data/ 下不认识的路径（附件、gocache、gopath、oj.db 及其备份……）一律不碰。
 */

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { DATA_DIR, TESTDATA_DIR, JUDGE_DIR, BASE_DIR } = require('./config');
const judge = require('./judge');
const interactive = require('./interactive');

/** 允许清理的根目录（白名单，仅用于自检/说明；实际删除都走下面的 safeChild） */
const ALLOWED_ROOTS = [
  JUDGE_DIR,
  judge.SPJ_CACHE_DIR,
  interactive.INTERACTOR_CACHE_DIR,
  TESTDATA_DIR,
  path.join(DATA_DIR, 'avatars'),
  path.join(BASE_DIR, 'logs'),
];

/** 判题目录里的临时文件名前缀（与 src/judge.js 的 JUDGE_TEMP_PATTERN 保持一致） */
const JUDGE_TEMP_PATTERN = /^(_batch|_mem_req|_mem_res|_job\.json|_result\.json|_time\.log)/;
/** 头像文件名：<uid>.<ext>，扩展名限定在 avatars.js 支持的范围内 */
const AVATAR_FILE_PATTERN = /^(\d+)\.(png|jpg|jpeg|gif|webp)$/i;
/** 交互器 / grader 缓存文件名 */
const INTERACTOR_FILE_PATTERN = /^interactor_[0-9a-f]{6,}\.exe$/;
const GRADER_FILE_PATTERN = /^grader_[0-9a-f]{6,}\.exe$/;
const CHECKER_FILE_PATTERN = /^checker_[0-9a-f]{6,}\.exe$/;
/** *.tmp 是编译中断残留：module 自身的淘汰策略是「5 分钟未变动即删」 */
const TMP_MIN_AGE_MS = 5 * 60 * 1000;

/* ---------------------------------- 工具 ---------------------------------- */

function dirSize(p) {
  let sum = 0;
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const q = path.join(p, e.name);
    try {
      const st = fs.lstatSync(q);
      if (st.isSymbolicLink()) continue;              // 不跟随链接，避免统计到目录之外
      if (st.isDirectory()) sum += dirSize(q);
      else sum += st.size;
    } catch { /* ignore */ }
  }
  return sum;
}

/**
 * 白名单校验：把 name 解析为 root 下的**直接子项**绝对路径。
 * 任何可疑情况（含分隔符、. / ..、解析后不在 root 内）返回 null —— 调用方必须跳过该条目。
 */
function safeChild(root, name) {
  if (!name || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\u0000')) return null;
  const abs = path.resolve(path.join(root, name));
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/** 列目录并返回直接子项（失败一律返回空数组，绝不让清理页面因此 500） */
function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** 该路径是否是符号链接 / junction（是则不碰） */
function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return true; }
}

/** 删除文件或目录（先做白名单与链接校验）；返回 { ok, bytes } */
function removeEntry(p, size, root) {
  const base = path.resolve(root);
  const abs = path.resolve(p);
  if (abs === base || !abs.startsWith(base + path.sep)) return { ok: false, error: '路径不在白名单目录内' };
  if (isLink(abs)) return { ok: false, error: '符号链接 / junction，已跳过' };
  try {
    fs.rmSync(abs, { recursive: true, force: true });
    return { ok: true, bytes: size || 0 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '删除失败' };
  }
}

/* ------------------------------- 各分类扫描 ------------------------------- */

/** 1) 判题临时目录：data/judge 下「超过 minAgeMs 未改动」的工作目录与临时文件 */
function scanJudgeWorkdirs(minAgeMs) {
  const items = [];
  const now = Date.now();
  for (const e of listDir(JUDGE_DIR)) {
    const p = safeChild(JUDGE_DIR, e.name);
    if (!p) continue;
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;                       // 不碰链接
    if (now - st.mtimeMs < minAgeMs) continue;               // 可能正在评测：跳过
    if (st.isDirectory()) items.push({ p, name: e.name, bytes: dirSize(p), kind: '目录' });
    else if (JUDGE_TEMP_PATTERN.test(e.name)) items.push({ p, name: e.name, bytes: st.size, kind: '临时文件' });
  }
  return items;
}

/** problems 表里仍存在的 checker 缓存文件名（checker_<哈希>.exe） */
function referencedCheckerFiles() {
  const set = new Set();
  let rows = [];
  try { rows = db.prepare('SELECT id FROM problems').all(); } catch { return set; }
  for (const r of rows) {
    try {
      const k = judge.checkerCacheKey(r.id);
      if (k) set.add(`checker_${k}.exe`);
    } catch { /* 单题失败不影响其它题目 */ }
  }
  return set;
}

/** problems 表里仍存在的交互器缓存文件名（interactor_<哈希>.exe） */
function referencedInteractorFiles() {
  const set = new Set();
  let rows = [];
  try { rows = db.prepare('SELECT id FROM problems').all(); } catch { return set; }
  for (const r of rows) {
    try {
      const src = path.join(TESTDATA_DIR, String(r.id), 'interactor.cpp');
      const k = interactive.interactorCacheKey(r.id, src);
      if (k) set.add(`interactor_${k}.exe`);
    } catch { /* ignore */ }
  }
  return set;
}

/** 2a) SPJ 缓存：不被任何题目引用（源码/测试库/编译参数哈希对不上）的 checker 可执行文件 + 陈旧 .tmp
 *  force=true（后台「强制全清」）：**连同仍被题目引用的 checker 缓存一起删**。这些可执行文件是
 *  纯可再生产物——下次判题时 compileChecker 会命中不到缓存而重新 g++ 编译（首次判题变慢几秒），
 *  判定口径完全不变；正在评测中的 checker 由 judge.js 的「缺失即重新编译」兜底（runChecker 每点
 *  判定前会 stat 并在必要时重编译）。因此强制清理不会造成误判。 */
function scanSpjCache(minAgeMs, force = false) {
  const referenced = force ? new Set() : referencedCheckerFiles();
  const items = [];
  const now = Date.now();
  for (const e of listDir(judge.SPJ_CACHE_DIR)) {
    const p = safeChild(judge.SPJ_CACHE_DIR, e.name);
    if (!p) continue;
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    if (st.size === 0 && !e.name.endsWith('.tmp')) continue;
    if (e.name.endsWith('.tmp')) {
      if (force || now - st.mtimeMs >= TMP_MIN_AGE_MS) items.push({ p, name: e.name, bytes: st.size, kind: force ? '强制全清（编译残留）' : '编译中断残留' });
      continue;
    }
    if (!CHECKER_FILE_PATTERN.test(e.name)) continue;         // 只管理本模块生成的缓存文件
    if (!force && referenced.has(e.name)) continue;           // 仍被题目引用：保留（强制模式下删除）
    if (!force && now - st.mtimeMs < minAgeMs) continue;      // 刚用过：可能是正在判题的 checker
    items.push({ p, name: e.name, bytes: st.size, kind: force ? '强制全清（含被题目引用的缓存）' : '无题目引用' });
  }
  return items;
}

/** 2b) 交互器缓存：不被题目引用的 interactor_*.exe + 陈旧 grader_*.exe + 陈旧 .tmp
 *  说明：grader 的缓存键里含**选手源码**（grader+选手一起链接），因此无法用题目数据静态判定「还在用」，
 *  只按模块自身的过期策略处理（超过 graderStaleDays 天未被使用即视为陈旧缓存）。
 *  force=true：无引用过滤、无最小静置时间、grader 不看天数，**整目录的编译产物全清**（同样可再生）。 */
function scanInteractorCache(minAgeMs, graderStaleDays, force = false) {
  const referenced = force ? new Set() : referencedInteractorFiles();
  const items = [];
  const now = Date.now();
  const staleMs = Math.max(1, graderStaleDays) * 86400000;
  for (const e of listDir(interactive.INTERACTOR_CACHE_DIR)) {
    const p = safeChild(interactive.INTERACTOR_CACHE_DIR, e.name);
    if (!p) continue;
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    if (e.name.endsWith('.tmp')) {
      if (force || now - st.mtimeMs >= TMP_MIN_AGE_MS) items.push({ p, name: e.name, bytes: st.size, kind: force ? '强制全清（编译残留）' : '编译中断残留' });
      continue;
    }
    if (INTERACTOR_FILE_PATTERN.test(e.name)) {
      if (!force && referenced.has(e.name)) continue;
      if (!force && now - st.mtimeMs < minAgeMs) continue;
      items.push({ p, name: e.name, bytes: st.size, kind: force ? '强制全清（含被题目引用的缓存）' : '无题目引用' });
      continue;
    }
    if (GRADER_FILE_PATTERN.test(e.name)) {
      if (!force && now - st.mtimeMs < Math.max(staleMs, minAgeMs)) continue;
      items.push({ p, name: e.name, bytes: st.size, kind: force ? '强制全清（grader 产物）' : `超过 ${graderStaleDays} 天未使用` });
    }
  }
  return items;
}

/** 3a) 过期会话（sessions.expires_at 已过）。**绝不把 token 带出**，只给「用户 #id」这样的标签。 */
function scanExpiredSessions() {
  try {
    return db.prepare('SELECT user_id, expires_at FROM sessions WHERE expires_at < ?').all(Date.now())
      .map((r) => ({ name: `用户 #${r.user_id} 的会话`, expires_at: r.expires_at }));
  } catch { return []; }
}

/** 3b) 过期待验证注册（与 src/auth.js prunePendingRegistrations 完全同一口径：过期 24h 后才清） */
const PENDING_KEEP_EXPIRED_MS = 24 * 3600 * 1000;
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at <= 1) return s ? s[0] + '***' + s.slice(at) : '';
  return s.slice(0, 1) + '***' + s.slice(at);
}
function scanExpiredPending() {
  try {
    const cutoff = Date.now() - PENDING_KEEP_EXPIRED_MS;
    return db.prepare(`SELECT id, username, email, verify_token_expires, created_at FROM pending_registrations
      WHERE (verify_token_expires > 0 AND verify_token_expires < ?) OR (verify_token_expires = 0 AND created_at < ?)`)
      .all(cutoff, cutoff)
      .map((r) => ({ id: r.id, name: `${r.username}（${maskEmail(r.email)}）`, created_at: r.created_at }));
  } catch { return []; }
}

/** 3c) 过期登录失败记录（与 src/auth.js 启动清理同一口径，且**绝不动仍在锁定期内的行**） */
const AUTH_DECAY_MS = 2 * 3600 * 1000;
function scanExpiredAuthFailures() {
  try {
    const now = Date.now();
    return db.prepare('SELECT scope, ident, fails, locked_until, last_fail_at FROM auth_failures WHERE last_fail_at < ? AND (locked_until <= ? OR locked_until = 0)')
      .all(now - AUTH_DECAY_MS, now)
      .map((r) => ({ name: `${r.scope}：${r.ident}（失败 ${r.fails} 次）`, last_fail_at: r.last_fail_at }));
  } catch { return []; }
}

/** 4) 孤儿测试数据目录：data/testdata/<id> 但 problems 表里没有该 id（只认纯数字命名的目录） */
function scanOrphanTestdata() {
  const known = new Set();
  try { for (const r of db.prepare('SELECT id FROM problems').all()) known.add(String(r.id)); } catch { return []; }
  const items = [];
  for (const e of listDir(TESTDATA_DIR)) {
    if (!/^\d{1,12}$/.test(e.name)) continue;                 // 白名单：纯数字目录名
    if (known.has(e.name)) continue;                          // 题目存在：绝不动
    const p = safeChild(TESTDATA_DIR, e.name);
    if (!p) continue;
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    items.push({ p, name: e.name, bytes: dirSize(p) });
  }
  return items;
}

/** 5) 孤儿头像：data/avatars/<uid>.<ext> 但 users 表里没有该 uid */
function scanOrphanAvatars() {
  const known = new Set();
  try { for (const r of db.prepare('SELECT id FROM users').all()) known.add(String(r.id)); } catch { return []; }
  const root = path.join(DATA_DIR, 'avatars');
  const items = [];
  for (const e of listDir(root)) {
    const m = e.name.match(AVATAR_FILE_PATTERN);
    if (!m) continue;                                         // 白名单：<数字>.<受支持图片扩展名>
    if (known.has(m[1])) continue;                            // 用户存在：绝不动
    const p = safeChild(root, e.name);
    if (!p) continue;
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    items.push({ p, name: e.name, bytes: st.size, uid: Number(m[1]) });
  }
  return items;
}

/** 6) 过大的日志：logs/ 下超过 maxKb 的 *.log，截断为「保留最新 keepKb」 */
function scanLogs(maxKb, keepKb) {
  const root = path.join(BASE_DIR, 'logs');
  const items = [];
  for (const e of listDir(root)) {
    if (!/\.log$/i.test(e.name)) continue;                    // 白名单：只处理 *.log
    const p = safeChild(root, e.name);
    if (!p) continue;
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    if (st.size <= maxKb * 1024) continue;
    items.push({ p, name: e.name, bytes: st.size - Math.min(st.size, keepKb * 1024) });
  }
  return items;
}

/** 把「日志尾部保留」真正落盘：读取尾部 → 原子替换 → 失败（文件被服务进程占用）记入失败项 */
function truncateLog(p, keepKb) {
  const keepBytes = Math.max(1, keepKb) * 1024;
  const root = path.join(BASE_DIR, 'logs');
  const abs = path.resolve(p);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return { ok: false, error: '路径不在白名单目录内' };
  if (isLink(abs)) return { ok: false, error: '符号链接，已跳过' };
  let st = null;
  try { st = fs.statSync(abs); } catch (e) { return { ok: false, error: '读取文件失败：' + ((e && e.message) || e) }; }
  if (st.size <= keepBytes) return { ok: true, bytes: 0 };
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const start = st.size - keepBytes;
    const buf = Buffer.alloc(keepBytes);
    const n = fs.readSync(fd, buf, 0, keepBytes, start);
    fs.closeSync(fd);
    fd = null;
    // 直接原地重写（日志目录由服务/脚本以追加方式持有；被占用时写失败，记入失败项而不是强行删除）
    fs.writeFileSync(abs, buf.subarray(0, n));
    return { ok: true, bytes: st.size - n };
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return { ok: false, error: '日志正被服务进程占用或无写权限：' + ((e && e.message) || e) };
  }
}

/* ------------------------------- 分类定义 ------------------------------- */

/** 参数校验与夹取（前端可传，服务端始终重新校验） */
function normalizeParams(input = {}) {
  const num = (v, def, min, max) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };
  const logMaxKb = num(input.log_max_kb, 2048, 64, 1024 * 1024);
  const logKeepKb = Math.min(logMaxKb, num(input.log_keep_kb, 256, 16, 1024 * 1024));
  const minAgeMin = num(input.min_age_min, 10, 0, 1440);
  const graderStaleDays = num(input.grader_stale_days, 7, 1, 3650);
  // 强制全清（默认关闭）：true 时「SPJ checker 缓存」「交互器 / grader 缓存」两类连同**仍被题目引用**
  // 的编译产物一起删除（纯可再生产物，下次判题重新编译）。只接受显式的真值，其余一律按未勾选处理。
  const f = input.force;
  const force = f === true || f === 1 || f === '1' || String(f).toLowerCase() === 'true' || String(f).toLowerCase() === 'on';
  return { logMaxKb, logKeepKb, minAgeMin, graderStaleDays, minAgeMs: minAgeMin * 60000, force };
}

const CATEGORY_DEFS = [
  {
    key: 'judge_workdirs',
    name: '判题临时目录',
    desc: 'data/judge 下历史评测留下的工作目录与临时文件（正常评测结束已即时删除，这里清的是进程崩溃残留）。删除后不影响已完成的提交记录，只是下次评测重新建目录。',
  },
  {
    key: 'spj_cache',
    name: 'SPJ checker 缓存',
    desc: 'data/spj_cache 里「源码哈希对不上任何现有题目 checker」的编译产物（题目改了 checker、题目被删、或缓存超期）。删除后对应题目下次判题会重新编译 checker（慢几秒，判定口径不变）。勾选「强制全清」后连**仍被题目引用**的 checker 缓存也一并删除。',
  },
  {
    key: 'interactor_cache',
    name: '交互器 / grader 缓存',
    desc: 'data/interactor_cache 里无题目引用的交互器产物，以及超过设定天数未使用的 grader 链接产物（grader 缓存键含选手源码，无法静态判定引用，只按过期时间清）。删除后交互题下次判题重新编译，判定口径不变。勾选「强制全清」后整个缓存目录的产物全清（含仍被引用的交互器与未超期的 grader）。',
  },
  {
    key: 'expired_sessions',
    name: '过期登录会话',
    desc: 'sessions 表里 expires_at 已过的登录票据（过期后本就无法登录，服务端只在下次带该票据访问时才顺手删）。删除后这些旧票据立即失效——本来也已经失效了。',
  },
  {
    key: 'expired_pending',
    name: '过期待验证注册',
    desc: 'pending_registrations 里验证码过期超过 24 小时的待注册记录（邮箱验证未完成，从未写入 users）。删除后这些邮箱 / 用户名可重新发起注册。',
  },
  {
    key: 'expired_auth_failures',
    name: '过期登录失败记录',
    desc: 'auth_failures 里「2 小时无失败已自动衰减」且不在锁定期内的限流计数（防爆破用）。删除等于把过期计数清零，不会影响任何账号本身。',
  },
  {
    key: 'orphan_testdata',
    name: '孤儿测试数据目录',
    desc: 'data/testdata/<id> 但 problems 表里已没有该 id（题目被删除后残留的测试数据）。删除后不会再被任何评测使用；仍在题库里的题目目录一律不动。',
  },
  {
    key: 'orphan_avatars',
    name: '孤儿头像文件',
    desc: 'data/avatars/<uid>.<ext> 但 users 表里已没有该 uid（账号已删除后残留的头像图片）。删除不影响现存的任何账号头像。',
  },
  {
    key: 'logs',
    name: '过大日志文件',
    desc: 'logs/ 下超过阈值的 *.log：只保留最新 N KB，其余截断释放（这是「轮转」而不是删除整个日志）。文件被服务进程独占占用时写入会失败，失败原因会在结果里逐条列出。',
  },
];

/** 预览：返回每个分类的数量 / 占用空间（不删除任何东西） */
function preview(input = {}) {
  const p = normalizeParams(input);
  const out = [];
  const put = (def, items, bytes, detail) => {
    const total = typeof bytes === 'number' ? bytes : items.reduce((a, b) => a + (b.bytes || 0), 0);
    out.push({
      key: def.key, name: def.name, desc: def.desc,
      count: items.length, bytes: total,
      detail: detail || '',
      items: items.slice(0, 50).map((it) => ({ name: it.name || (it.id != null ? '#' + it.id : ''), bytes: it.bytes || 0, kind: it.kind || '' })),
    });
  };

  try {
    const items = scanJudgeWorkdirs(p.minAgeMs);
    put(CATEGORY_DEFS[0], items, null, `只清理超过 ${p.minAgeMin} 分钟未改动的条目`);
  } catch { put(CATEGORY_DEFS[0], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[1], scanSpjCache(p.minAgeMs, p.force), null, p.force ? '强制全清：含仍被题目引用的 checker 缓存（下次判题会重新编译）' : '按「源码 + testlib + 编译参数」哈希比对，仍被题目引用的条目保留'); } catch { put(CATEGORY_DEFS[1], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[2], scanInteractorCache(p.minAgeMs, p.graderStaleDays, p.force), null, p.force ? '强制全清：交互器 / grader 产物全部删除（下次判题会重新编译）' : `grader 产物按超过 ${p.graderStaleDays} 天未使用判定`); } catch { put(CATEGORY_DEFS[2], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[3], scanExpiredSessions(), 0, ''); } catch { put(CATEGORY_DEFS[3], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[4], scanExpiredPending(), 0, ''); } catch { put(CATEGORY_DEFS[4], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[5], scanExpiredAuthFailures(), 0, ''); } catch { put(CATEGORY_DEFS[5], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[6], scanOrphanTestdata(), null, '仅处理纯数字命名的目录，且该 id 不在 problems 表中'); } catch { put(CATEGORY_DEFS[6], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[7], scanOrphanAvatars(), null, '仅处理 <数字>.<png|jpg|jpeg|gif|webp>，且该 uid 不在 users 表中'); } catch { put(CATEGORY_DEFS[7], [], 0, '扫描失败'); }
  try { put(CATEGORY_DEFS[8], scanLogs(p.logMaxKb, p.logKeepKb), null, `阈值 ${p.logMaxKb}KB，保留最新 ${p.logKeepKb}KB`); } catch { put(CATEGORY_DEFS[8], [], 0, '扫描失败'); }

  return {
    params: { log_max_kb: p.logMaxKb, log_keep_kb: p.logKeepKb, min_age_min: p.minAgeMin, grader_stale_days: p.graderStaleDays, force: p.force },
    categories: out,
    total_count: out.reduce((a, b) => a + b.count, 0),
    total_bytes: out.reduce((a, b) => a + b.bytes, 0),
  };
}

/** 写审计：admin_audit（主）+ moderation_logs（镜像，便于后台「社区管理」直接看到）
 *  注意：params 是 normalizeParams() 的结果，字段名是**驼峰**（logMaxKb / logKeepKb / minAgeMin / graderStaleDays）。 */
function auditCleanup(actor, keys, result, params, ip) {
  const now = Date.now();
  const actorId = Number(actor && actor.id) || 0;
  const actorName = String((actor && actor.username) || '').slice(0, 80);
  const detail = `清理多余数据：${keys.join('、') || '（无）'}${params.force ? '【强制全清：含被题目引用的缓存】' : ''}；删除 ${result.removed} 项，释放 ${result.freedBytes} 字节`
    + (result.failed.length ? `；失败 ${result.failed.length} 项` : '')
    + `（参数：日志阈值 ${params.logMaxKb}KB/保留 ${params.logKeepKb}KB，最小静置 ${params.minAgeMin} 分钟，grader 过期 ${params.graderStaleDays} 天，强制全清 ${params.force ? '开' : '关'}）`;
  try {
    db.prepare('INSERT INTO admin_audit (created_at, actor_id, actor_name, target_id, target_name, action, detail, ip) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
      .run(now, actorId, actorName, '', 'cleanup_data', detail.slice(0, 500), String(ip || '').slice(0, 80));
  } catch (e) { console.warn('[LCZOJ] 写入清理审计失败（admin_audit）：' + (e && e.message)); }
  try {
    db.prepare('INSERT INTO moderation_logs (admin_id, admin_name, user_id, username, action, detail, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(actorId, actorName, '', 'cleanup_data', detail.slice(0, 500), now);
  } catch (e) { console.warn('[LCZOJ] 镜像清理审计到社区管理记录失败：' + (e && e.message)); }
}

/**
 * 执行清理。
 * @param {string[]} keys 要清理的分类 key（空数组 = 全部）
 * @param {object} input 参数（log_max_kb / log_keep_kb / min_age_min / grader_stale_days / force）
 * @param {object} actor 当前管理员（用于审计）
 * @param {string} ip 来源 IP
 * @returns {{keys:string[], removed:number, freedBytes:number, failed:Array, results:Array, force:boolean}}
 */
function run(keys, input, actor, ip) {
  const p = normalizeParams(input);
  const all = CATEGORY_DEFS.map((d) => d.key);
  const wanted = Array.isArray(keys) && keys.length ? keys.filter((k) => all.includes(k)) : all;
  const results = [];
  const failed = [];
  let removed = 0;
  let freed = 0;

  for (const key of wanted) {
    const def = CATEGORY_DEFS.find((d) => d.key === key) || { key, name: key };
    let n = 0;
    let bytes = 0;
    const fail = (name, error) => failed.push({ category: key, name, error: error || '删除失败' });
    try {
      if (key === 'judge_workdirs') {
        for (const it of scanJudgeWorkdirs(p.minAgeMs)) {
          const r = removeEntry(it.p, it.bytes, JUDGE_DIR);
          if (r.ok) { n++; bytes += r.bytes; } else fail(it.name, r.error);
        }
      } else if (key === 'spj_cache') {
        for (const it of scanSpjCache(p.minAgeMs, p.force)) {
          const r = removeEntry(it.p, it.bytes, judge.SPJ_CACHE_DIR);
          if (r.ok) { n++; bytes += r.bytes; } else fail(it.name, r.error);
        }
      } else if (key === 'interactor_cache') {
        for (const it of scanInteractorCache(p.minAgeMs, p.graderStaleDays, p.force)) {
          const r = removeEntry(it.p, it.bytes, interactive.INTERACTOR_CACHE_DIR);
          if (r.ok) { n++; bytes += r.bytes; } else fail(it.name, r.error);
        }
      } else if (key === 'expired_sessions') {
        const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
        n = Number(r.changes) || 0;
      } else if (key === 'expired_pending') {
        const cutoff = Date.now() - PENDING_KEEP_EXPIRED_MS;
        const r = db.prepare(`DELETE FROM pending_registrations
          WHERE (verify_token_expires > 0 AND verify_token_expires < ?) OR (verify_token_expires = 0 AND created_at < ?)`)
          .run(cutoff, cutoff);
        n = Number(r.changes) || 0;
      } else if (key === 'expired_auth_failures') {
        const now = Date.now();
        const r = db.prepare('DELETE FROM auth_failures WHERE last_fail_at < ? AND (locked_until <= ? OR locked_until = 0)')
          .run(now - AUTH_DECAY_MS, now);
        n = Number(r.changes) || 0;
      } else if (key === 'orphan_testdata') {
        for (const it of scanOrphanTestdata()) {
          const r = removeEntry(it.p, it.bytes, TESTDATA_DIR);
          if (r.ok) { n++; bytes += r.bytes; } else fail(it.name, r.error);
        }
      } else if (key === 'orphan_avatars') {
        const root = path.join(DATA_DIR, 'avatars');
        for (const it of scanOrphanAvatars()) {
          const r = removeEntry(it.p, it.bytes, root);
          if (r.ok) { n++; bytes += r.bytes; } else fail(it.name, r.error);
        }
      } else if (key === 'logs') {
        for (const it of scanLogs(p.logMaxKb, p.logKeepKb)) {
          const r = truncateLog(it.p, p.logKeepKb);
          if (r.ok) { n++; bytes += r.bytes || 0; } else fail(it.name, r.error);
        }
      }
    } catch (e) {
      fail(def.name, (e && e.message) || '执行失败');
    }
    removed += n;
    freed += bytes;
    results.push({ key, name: def.name, removed: n, freedBytes: bytes, failed: failed.filter((f) => f.category === key) });
  }

  const out = { keys: wanted, removed, freedBytes: freed, failed, results, force: p.force };
  try { auditCleanup(actor, wanted, out, p, ip); } catch { /* 审计失败绝不影响清理结果 */ }
  return out;
}

module.exports = { preview, run, normalizeParams, CATEGORY_DEFS, ALLOWED_ROOTS };
