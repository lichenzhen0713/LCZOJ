'use strict';

const crypto = require('crypto');
const { db, nextFreeId, passwordPolicyError, PASSWORD_MIN_LENGTH, removeAdminPasswordFile, auditAdminPasswordChange } = require('./db');
const { randomToken, parseCookies } = require('./util');
const { DEFAULTS } = require('./config');
const { hashPassword, verifyPassword } = require('./password');

const COOKIE_NAME = 'oj_session';

/* ============================ Cookie 解析（M19） ============================
 * util.parseCookies 的 decodeURIComponent 对非法百分号编码（如 oj_session=%）会抛异常，
 * 而 currentUser 位于请求入口，异常会让连接一直挂到超时。这里先 try/catch 包一层，
 * 任何非法 cookie 直接跳过（视为未登录），不抛异常、不刷堆栈。
 */
function safeParseCookies(req) {
  try {
    return parseCookies(req) || {};
  } catch {
    const out = {};
    const raw = (req && req.headers && req.headers.cookie) || '';
    for (const part of String(raw).split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      if (!key) continue;
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    }
    return out;
  }
}

/** 是否 HTTPS 场景：反向代理的 X-Forwarded-Proto 或 OJ_SECURE=1（L1，用于 Cookie Secure） */
function isHttpsRequest(req) {
  if (String(process.env.OJ_SECURE || '') === '1') return true;
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function createSession(userId) {
  const token = randomToken();
  const now = Date.now();
  const expires = now + DEFAULTS.sessionTtlDays * 24 * 3600 * 1000;
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, expires);
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (row.session_expires < Date.now()) {
    destroySession(token);
    return null;
  }
  // 封禁/撤销权限到期自动恢复（惰性检查）
  require('./users').checkUserExpiry(row.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
  // 封禁用户的会话立即失效
  if (fresh.banned) {
    destroySession(token);
    return null;
  }
  return sanitizeUser(fresh);
}

/** 从请求中解析当前登录用户 */
function currentUser(req) {
  const cookies = safeParseCookies(req);
  return getUserByToken(cookies[COOKIE_NAME]);
}

/** 删除某用户的全部会话（改密 / 重置密码后调用）；keepToken 用于「保留当前会话」的场景 */
function destroyUserSessions(userId, keepToken) {
  const id = parseInt(userId, 10);
  if (!Number.isFinite(id)) return 0;
  if (keepToken) return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(id, keepToken).changes;
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
}

/* ============================ 认证限流 / 临时锁定（H4） ============================
 * 登录、注册、找回密码、验证码校验统一按「IP + 账号」双维度失败计数，但两个维度的策略不同：
 *   - **账号维度（acct:）硬锁**：连续失败达到阈值（默认 5 次）临时锁定，逐次翻倍（10 → 20 → … → 60 分钟封顶）；
 *   - **IP 维度（ip:）默认只做渐进退避、不硬锁**：避免共享出口 IP（校园网 / NAT / 反向代理）下
 *     「某个账号被爆破」把整栋楼甚至管理员一起锁在门外；确需 IP 硬锁时设
 *     OJ_AUTH_IP_LOCK_THRESHOLD（例如 20 = 同一 IP 累计 20 次失败才锁）；
 *   - 连续失败 3 次起叠加指数退避延迟（0.5s → 1s → 2s → 4s 封顶，取两个维度较大者）；
 *   - 锁定期间的请求直接拒绝且**不再累加计数**（避免攻击者把受害者永久锁死）；
 *   - 认证成功立即清零；长时间（默认 2 小时）无失败自动衰减清零；计数落库（auth_failures），重启不清零。
 * 可用环境变量调整：OJ_AUTH_LOCK_THRESHOLD / OJ_AUTH_LOCK_MINUTES / OJ_AUTH_LOCK_MAX_MINUTES /
 * OJ_AUTH_IP_LOCK_THRESHOLD / OJ_AUTH_BACKOFF_START / OJ_AUTH_BACKOFF_MAX_MS / OJ_AUTH_DECAY_MINUTES /
 * OJ_DISABLE_AUTH_LOCK=1（只保留退避延迟、不做任何硬锁）。
 * 返回的提示不区分账号是否存在（避免账号枚举，配合 L2）。
 */
function envInt(name, def, min, max) {
  const raw = process.env[name] == null ? '' : String(process.env[name]);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

const THROTTLE = {
  accountThreshold: envInt('OJ_AUTH_LOCK_THRESHOLD', 5, 1, 100000),         // 账号维度硬锁阈值
  ipThreshold: envInt('OJ_AUTH_IP_LOCK_THRESHOLD', 0, 0, 100000),           // IP 维度硬锁阈值（0 = 只退避不硬锁）
  baseLockMs: envInt('OJ_AUTH_LOCK_MINUTES', 10, 1, 10080) * 60 * 1000,     // 首次锁定 10 分钟
  maxLockMs: envInt('OJ_AUTH_LOCK_MAX_MINUTES', 60, 1, 40320) * 60 * 1000,  // 锁定时长上限 60 分钟
  disabled: String(process.env.OJ_DISABLE_AUTH_LOCK || '') === '1',         // 应急：整体关闭硬锁
  backoffStartFails: envInt('OJ_AUTH_BACKOFF_START', 3, 1, 1000),           // 从第 3 次失败起加退避延迟
  backoffBaseMs: 500,
  maxBackoffMs: envInt('OJ_AUTH_BACKOFF_MAX_MS', 4000, 0, 120000),
  decayMs: envInt('OJ_AUTH_DECAY_MINUTES', 120, 1, 40320) * 60 * 1000,      // 2 小时无失败 → 计数衰减清零
};

/** 该标识的硬锁阈值：账号维度用 OJ_AUTH_LOCK_THRESHOLD，IP 维度用 OJ_AUTH_IP_LOCK_THRESHOLD（默认 0=不锁） */
function identThreshold(ident) {
  return String(ident || '').startsWith('acct:') ? THROTTLE.accountThreshold : THROTTLE.ipThreshold;
}

/** 客户端 IP：仅在「本机 / 内网反向代理」时才信任 X-Forwarded-For，避免伪造头绕过 IP 限流 */
function clientIp(req) {
  const sock = String((req && req.socket && req.socket.remoteAddress) || '') || 'unknown';
  const raw = sock.replace(/^::ffff:/i, '');
  const isPrivate = raw === '::1' || raw === 'unknown'
    || /^127\./.test(raw) || /^10\./.test(raw) || /^192\.168\./.test(raw)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(raw) || /^fc00:|^fe80:/i.test(raw);
  if (isPrivate) {
    const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    if (xff) return xff.slice(0, 80);
  }
  return raw.slice(0, 80);
}

/** 构造失败计数用的标识：IP 维度 + 账号维度（账号为空时只统计 IP） */
function throttleIdents(ip, account) {
  const list = ['ip:' + String(ip || 'unknown')];
  const acct = String(account || '').trim().toLowerCase().slice(0, 120);
  if (acct) list.push('acct:' + acct);
  return list;
}

/** 连续失败次数 + 该维度阈值 → 锁定时长（0 表示不锁；阈值 0 或全局关闭时永不硬锁） */
function lockMsForFails(fails, threshold) {
  if (THROTTLE.disabled) return 0;
  const limit = Number.isFinite(threshold) ? threshold : THROTTLE.accountThreshold;
  if (!limit || limit <= 0) return 0;
  if (fails < limit) return 0;
  const steps = fails - limit;
  return Math.min(THROTTLE.baseLockMs * Math.pow(2, steps), THROTTLE.maxLockMs);
}

function readFailureRow(scope, ident) {
  return db.prepare('SELECT fails, locked_until, first_fail_at, last_fail_at FROM auth_failures WHERE scope = ? AND ident = ?').get(scope, ident);
}

/** 查询当前限流状态：{ locked, retryAfterMs, delayMs, fails } */
function throttleStatus(scope, ip, account) {
  const now = Date.now();
  let retryAfterMs = 0;
  let fails = 0;
  for (const ident of throttleIdents(ip, account)) {
    const row = readFailureRow(scope, ident);
    if (!row) continue;
    if (now - (row.last_fail_at || 0) > THROTTLE.decayMs) continue; // 长期无失败 → 计数已衰减
    fails = Math.max(fails, row.fails || 0);
    // 只有「当前策略下可硬锁」的维度才认 locked_until：IP 维度默认不锁，
    // 历史遗留的 IP 锁定（旧策略写入）不再继续拦截请求。
    if (row.locked_until > now && identThreshold(ident) > 0) retryAfterMs = Math.max(retryAfterMs, row.locked_until - now);
  }
  let delayMs = 0;
  if (!retryAfterMs && fails >= THROTTLE.backoffStartFails) {
    delayMs = Math.min(THROTTLE.backoffBaseMs * Math.pow(2, fails - THROTTLE.backoffStartFails), THROTTLE.maxBackoffMs);
  }
  return { locked: retryAfterMs > 0, retryAfterMs, delayMs, fails };
}

/** 记录一次失败：累加计数，达到阈值后临时锁定并按次加倍 */
function throttleFail(scope, ip, account) {
  const now = Date.now();
  pruneAuthFailures();
  let lockedMs = 0;
  let fails = 0;
  for (const ident of throttleIdents(ip, account)) {
    const row = readFailureRow(scope, ident);
    const decayed = !row || (now - (row.last_fail_at || 0) > THROTTLE.decayMs);
    const nextFails = (decayed ? 0 : (row.fails || 0)) + 1;
    // 账号维度按账号阈值硬锁；IP 维度默认阈值 0（不硬锁，只参与退避延迟）
    const lockMs = lockMsForFails(nextFails, identThreshold(ident));
    const lockedUntil = lockMs ? now + lockMs : 0;
    if (row) {
      db.prepare('UPDATE auth_failures SET fails = ?, locked_until = ?, first_fail_at = ?, last_fail_at = ? WHERE scope = ? AND ident = ?')
        .run(nextFails, lockedUntil, decayed ? now : (row.first_fail_at || now), now, scope, ident);
    } else {
      db.prepare('INSERT INTO auth_failures (scope, ident, fails, locked_until, first_fail_at, last_fail_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(scope, ident, nextFails, lockedUntil, now, now);
    }
    fails = Math.max(fails, nextFails);
    lockedMs = Math.max(lockedMs, lockMs);
  }
  return { fails, locked: lockedMs > 0, lockedMs };
}

/** 认证成功：清零该 IP 与账号的失败计数。返回被清掉的记录条数（调用方可用于审计/验收）。 */
function throttleReset(scope, ip, account) {
  const del = db.prepare('DELETE FROM auth_failures WHERE scope = ? AND ident = ?');
  let cleared = 0;
  for (const ident of throttleIdents(ip, account)) {
    try { cleared += del.run(scope, ident).changes || 0; } catch { /* ignore */ }
  }
  return cleared;
}

/** 把剩余锁定时间转成中文提示（不区分账号是否存在） */
function throttleMessage(retryAfterMs) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `操作过于频繁或失败次数过多，请在约 ${minutes} 分钟后重试`;
}

/* ---------------- 重发验证码频率上限（v2.5.0） ----------------
 * 背景：验证码「连续错 5 次」会按 H4 策略把「IP + 邮箱」锁定约 10 分钟；为了让用户重发拿到新验证码后
 * **立刻**能完成验证，重发成功后会把 verify 场景的限流清零（见 server.js 的 /api/verify-email/resend）。
 * 为免「重置限流」变成可无限刷的入口，重发本身另给一个**宽松**上限：
 *   同一个 IP + 邮箱，每分钟最多 OJ_RESEND_MAX_PER_MINUTE 次（默认 3 次，可调 1~1000）。
 * 只统计「成功的重发」（确实换发了新验证码 / 发了信），失败的请求继续由上面 H4 的 resend 失败锁定负责。
 * 计数沿用 auth_failures 表（scope = 'resend_rl'），不新增表，幂等。
 */
const RESEND_LIMIT = {
  maxPerWindow: envInt('OJ_RESEND_MAX_PER_MINUTE', 3, 1, 1000),
  windowMs: 60 * 1000,
};

function resendLimitIdent(ip, email) {
  return 'resend:' + String(ip || 'unknown').slice(0, 80) + '|' + String(email || '').trim().toLowerCase().slice(0, 120);
}

/** 查看当前窗口内已成功重发几次：{ limited, count, retryAfterMs } */
function resendLimitStatus(ip, email) {
  const ident = resendLimitIdent(ip, email);
  const row = db.prepare("SELECT fails, first_fail_at, last_fail_at FROM auth_failures WHERE scope = 'resend_rl' AND ident = ?").get(ident);
  const now = Date.now();
  if (!row) return { limited: false, count: 0, retryAfterMs: 0 };
  const startedAt = row.first_fail_at || row.last_fail_at || 0;
  if (!startedAt || now - startedAt >= RESEND_LIMIT.windowMs) return { limited: false, count: 0, retryAfterMs: 0 };
  const count = row.fails || 0;
  return { limited: count >= RESEND_LIMIT.maxPerWindow, count, retryAfterMs: Math.max(0, startedAt + RESEND_LIMIT.windowMs - now) };
}

/** 记一次「成功的重发」，返回记完之后的窗口状态 */
function resendLimitHit(ip, email) {
  const ident = resendLimitIdent(ip, email);
  const now = Date.now();
  pruneAuthFailures();
  const row = db.prepare("SELECT fails, first_fail_at, last_fail_at FROM auth_failures WHERE scope = 'resend_rl' AND ident = ?").get(ident);
  const sameWindow = !!(row && row.first_fail_at && now - row.first_fail_at < RESEND_LIMIT.windowMs);
  const startedAt = sameWindow ? row.first_fail_at : now;
  const count = (sameWindow ? (row.fails || 0) : 0) + 1;
  if (row) {
    db.prepare("UPDATE auth_failures SET fails = ?, first_fail_at = ?, last_fail_at = ? WHERE scope = 'resend_rl' AND ident = ?")
      .run(count, startedAt, now, ident);
  } else {
    db.prepare("INSERT INTO auth_failures (scope, ident, fails, locked_until, first_fail_at, last_fail_at) VALUES ('resend_rl', ?, ?, 0, ?, ?)")
      .run(ident, count, startedAt, now);
  }
  return { limited: count > RESEND_LIMIT.maxPerWindow, count, retryAfterMs: Math.max(0, startedAt + RESEND_LIMIT.windowMs - now) };
}

/** 重发过频的中文提示 */
function resendLimitMessage(retryAfterMs) {
  const sec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `验证码重发过于频繁（同一邮箱每分钟最多 ${RESEND_LIMIT.maxPerWindow} 次），请在约 ${sec} 秒后再试`;
}

/** 清理 2 小时前的失败计数记录（每次失败时顺带做，时间闸门 10 分钟） */
let lastThrottlePrune = 0;
function pruneAuthFailures() {
  const now = Date.now();
  if (now - lastThrottlePrune < 10 * 60 * 1000) return;
  lastThrottlePrune = now;
  try {
    db.prepare('DELETE FROM auth_failures WHERE last_fail_at < ?').run(now - THROTTLE.decayMs);
  } catch { /* ignore */ }
}

// 启动时清理一次历史残留
try { db.prepare('DELETE FROM auth_failures WHERE last_fail_at < ?').run(Date.now() - THROTTLE.decayMs); } catch { /* ignore */ }

const ROLE_ADMIN = 'admin';
const ROLE_SUPERADMIN = 'superadmin';

/** 全部权限位（拥有全部 = 超级管理员） */
const ALL_PERMISSIONS = ['problem', 'user', 'editorial_review', 'article_review', 'contest', 'discussion', 'article', 'editorial'];
const PERMISSION_LABELS = {
  problem: '题目管理',
  user: '用户管理',
  editorial_review: '题解审核',
  article_review: '专栏审核',
  contest: '比赛管理',
  discussion: '讨论管理',
  article: '专栏管理',
  editorial: '题解管理',
};

/** 解析权限字符串 → 权限数组 */
function parsePermissions(raw) {
  const set = new Set(String(raw || '').split(',').filter(Boolean));
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}

/** 是否拥有指定权限（超级管理员拥有全部） */
function hasPerm(user, key) {
  if (!user) return false;
  if (user.is_superadmin) return true;
  return Array.isArray(user.permissions) && user.permissions.includes(key);
}

function sanitizeUser(u) {
  if (!u) return null;
  const role = u.role || 'user';
  const permissions = parsePermissions(u.permissions);
  const isSuper = permissions.length === ALL_PERMISSIONS.length;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: isSuper ? ROLE_SUPERADMIN : (permissions.length > 0 ? ROLE_ADMIN : 'user'),
    is_admin: permissions.length > 0,
    is_superadmin: isSuper,
    permissions,
    can_speak: u.can_speak === undefined ? true : !!u.can_speak,
    can_discuss: u.can_speak === undefined ? !!u.can_discuss : !!u.can_speak,
    can_reply: u.can_speak === undefined ? (u.can_reply === undefined ? true : !!u.can_reply) : !!u.can_speak,
    can_editorial: !!u.can_editorial,
    banned: !!u.banned,
    nickname: u.nickname || '',
    avatar: u.avatar || '',
    bio: u.bio,
    uid: u.id,
    rating: u.rating || 0,
    brown_name: !!u.brown_name,
    brown_type: u.brown_type || '',
    email_verified: u.email_verified === undefined ? 1 : !!u.email_verified,
    must_change_password: !!u.must_change_password,
    created_at: u.created_at,
  };
}

/* ============================ 内置管理员口令变更防护（v2.5.0 安全加固） ============================
 * 内置 admin 是唯一持有全部权限的超级管理员（「用户管理」接口明令禁止改动它的权限与资料），
 * 因此它的口令一旦被非本人改掉，站内就没有任何账号能再把它改回来 —— 只能上服务器改数据库。
 * 规则（唯一判据，**所有**改口令的代码路径都必须先过这里）：
 *   · 目标不是内置 admin（username !== 'admin'）→ 放行，能力与以前完全一致；
 *   · 目标是内置 admin → 只有「内置超管会话」（is_superadmin 且 username === 'admin'）放行，
 *     其余（无会话 / 仅持 user 权限的普通管理员 / 任何第三方）一律拒绝，返回 403 与明确中文提示。
 * 放行与拒绝都会落一条 admin_audit 审计（见 src/db.js 的 auditAdminPasswordChange）。
 */
const BUILTIN_ADMIN_USERNAME = 'admin';

/** 该用户行是否内置管理员（以 username 为唯一判据，与全站既有口径一致） */
function isBuiltinAdminUser(u) {
  return !!u && String(u.username == null ? '' : u.username) === BUILTIN_ADMIN_USERNAME;
}

/** 是否「内置超管会话」：账号是内置 admin，且确实持有全部权限（is_superadmin） */
function isBuiltinSuperAdminSession(actor) {
  return isBuiltinAdminUser(actor) && !!actor.is_superadmin;
}

const BUILTIN_ADMIN_DENY_NO_SESSION = '内置管理员账号（admin）的口令只能由该账号本人在登录状态下变更；当前请求没有有效登录会话，已被拒绝';
const BUILTIN_ADMIN_DENY_NOT_SUPER = '内置管理员账号（admin）的口令只能由内置超级管理员本人变更，你没有该权限';

/**
 * 内置 admin 口令变更守卫：所有改口令路径在真正写库之前都必须先过这里。
 * @param {object|null} actor 当前会话用户（无会话传 null）需含 { id, username, is_superadmin }
 * @param {object} target 口令将被修改的用户行，需含 { id, username }
 * @param {string} path 路径标识（self_change / superadmin_reset / forgot_reset / …），仅用于审计
 * @param {string} [ip] 来源 IP
 * @returns {{ok:true, builtin:boolean}|{ok:false, error:string, status:number}}
 */
function guardBuiltinAdminPasswordChange(actor, target, path, ip) {
  if (!isBuiltinAdminUser(target)) return { ok: true, builtin: false };
  const base = {
    actorId: actor ? actor.id : 0,
    actorName: actor ? actor.username : '',
    targetId: target.id,
    targetName: target.username,
    ip: ip || '',
  };
  if (!actor) {
    auditAdminPasswordChange(Object.assign({}, base, {
      action: 'admin_password_change_denied',
      detail: `拦截内置管理员口令变更（路径 ${path}）：请求未携带有效登录会话`,
    }));
    return { ok: false, status: 403, error: BUILTIN_ADMIN_DENY_NO_SESSION };
  }
  if (!isBuiltinSuperAdminSession(actor)) {
    auditAdminPasswordChange(Object.assign({}, base, {
      action: 'admin_password_change_denied',
      detail: `拦截内置管理员口令变更（路径 ${path}）：操作者 ${actor.username}(uid=${actor.id}) 不是内置超级管理员会话`,
    }));
    return { ok: false, status: 403, error: BUILTIN_ADMIN_DENY_NOT_SUPER };
  }
  return { ok: true, builtin: true };
}

/** 内置 admin 口令「成功变更」后的审计；目标不是内置 admin 时直接跳过（不产生审计噪音） */
function auditBuiltinAdminChanged(actor, target, action, detail, ip) {
  if (!isBuiltinAdminUser(target)) return false;
  return auditAdminPasswordChange({
    actorId: actor ? actor.id : 0,
    actorName: actor ? actor.username : '',
    targetId: target.id,
    targetName: target.username,
    action: action,
    detail: detail,
    ip: ip || '',
  });
}

function setSessionCookie(res, token, expires, req) {  // L1：HTTPS 场景（X-Forwarded-Proto: https 或 OJ_SECURE=1）追加 Secure，避免会话在明文链路上被嗅探复用
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${new Date(expires).toUTCString()}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : [cookie]);
}

function clearSessionCookie(res, req) {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  const cookie = `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
  res.setHeader('Set-Cookie', cookie);
}

/* ============================ 验证码 / 重置码（H5） ============================
 * 统一规则：crypto.randomInt 生成 6 位数字；入库带 10 分钟过期时间与尝试次数；
 * 最多尝试 5 次，超限即作废；校验成功（一次性消费）即清空。
 * 任何情况下都不得把验证码写进 HTTP 响应体。
 */
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;

/** 验证码类型 → users 表中的三个列（令牌 / 过期时间 / 尝试次数） */
const TOKEN_COLUMNS = {
  email_verify: { token: 'email_verify_token', expires: 'email_verify_token_expires', attempts: 'email_verify_token_attempts' },
  email_change: { token: 'email_change_token', expires: 'email_change_token_expires', attempts: 'email_change_token_attempts' },
  password_reset: { token: 'password_reset_token', expires: 'password_reset_token_expires', attempts: 'password_reset_token_attempts' },
};

/** 生成一次性验证码并入库（10 分钟有效、尝试次数归零） */
function issueCode(kind, userId) {
  const col = TOKEN_COLUMNS[kind];
  if (!col) throw new Error('未知验证码类型：' + kind);
  const code = emailCode();
  db.prepare(`UPDATE users SET ${col.token} = ?, ${col.expires} = ?, ${col.attempts} = 0 WHERE id = ?`)
    .run(code, Date.now() + CODE_TTL_MS, userId);
  return code;
}

/** 作废验证码（过期 / 用完 / 校验成功） */
function clearCode(kind, userId) {
  const col = TOKEN_COLUMNS[kind];
  if (!col) return;
  db.prepare(`UPDATE users SET ${col.token} = '', ${col.expires} = 0, ${col.attempts} = 0 WHERE id = ?`).run(userId);
}

/**
 * 校验验证码：过期 / 超过尝试上限 / 不匹配都返回同一条模糊提示（不泄漏账号信息）。
 * 成功时默认一次性消费（清空令牌）。
 */
function checkCode(kind, userId, code, { consume = true } = {}) {
  const col = TOKEN_COLUMNS[kind];
  if (!col) return { error: '验证码无效或已过期，请重新获取' };
  const row = db.prepare(`SELECT ${col.token} AS token, ${col.expires} AS expires, ${col.attempts} AS attempts FROM users WHERE id = ?`).get(userId);
  if (!row || !row.token) return { error: '验证码无效或已过期，请重新获取' };
  if (!row.expires || row.expires < Date.now()) { clearCode(kind, userId); return { error: '验证码无效或已过期，请重新获取' }; }
  if ((row.attempts || 0) >= CODE_MAX_ATTEMPTS) { clearCode(kind, userId); return { error: '验证码无效或已过期，请重新获取' }; }
  if (String(code == null ? '' : code).trim() !== String(row.token)) {
    const attempts = (row.attempts || 0) + 1;
    if (attempts >= CODE_MAX_ATTEMPTS) {
      clearCode(kind, userId);
      return { error: `验证码错误次数已达上限（${CODE_MAX_ATTEMPTS} 次），本次验证码已作废，请重新获取` };
    }
    db.prepare(`UPDATE users SET ${col.attempts} = ? WHERE id = ?`).run(attempts, userId);
    return { error: `验证码错误，还可尝试 ${CODE_MAX_ATTEMPTS - attempts} 次` };
  }
  if (consume) clearCode(kind, userId);
  return { ok: true };
}

// ---------------- 用户增删改查 ----------------

/** 6 位数字邮箱验证码（CSPRNG：crypto.randomInt，避免 Math.random 可预测） */
function emailCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/** 尝试通过 SMTP 发送验证码邮件；未配置 SMTP 时静默失败（验证码只写服务端日志，绝不进响应体） */
async function sendVerifyEmail(email, code) {
  const settings = require('./settings');
  const smtp = require('./smtp');
  const host = settings.getSetting('smtp_host', '');
  if (!host) return { sent: false, reason: 'smtp_not_configured' };
  try {
    await smtp.sendMail({
      host,
      port: settings.getSetting('smtp_port', '465'),
      secure: settings.getSetting('smtp_secure', '1') === '1',
      user: settings.getSetting('smtp_user', ''),
      pass: settings.getSetting('smtp_pass', ''),
      fromName: settings.getSetting('site_name', 'LCZOJ'),
    }, {
      to: email,
      subject: '邮箱验证码',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e5e5;border-radius:8px">
        <h2 style="margin:0 0 12px">邮箱验证</h2>
        <p>你的验证码是：</p>
        <p style="font-size:28px;font-weight:800;letter-spacing:6px;color:#1890ff">${code}</p>
        <p>验证码 10 分钟内有效，请勿泄露给他人。</p>
        <p style="color:#999;font-size:12px">本邮件由系统自动发送，请勿回复。</p>
      </div>`,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: String((e && e.message) || 'send_failed') };
  }
}

/** 发送验证码邮件，并限制总等待时间（邮件服务器不通时不至于让注册请求长时间挂住） */
async function sendVerifyEmailBounded(email, code, timeoutMs = 12000) {
  let timer = null;
  try {
    return await Promise.race([
      sendVerifyEmail(email, code),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ sent: false, reason: 'smtp_timeout' }), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ============================ 待验证注册（v2.5.0） ============================
 * 开启邮箱验证时，注册只写 pending_registrations（**绝不写 users**）：
 *   · 邮箱验证通过前账号完全不存在，不会留下「未验证的半成品账号」；
 *   · 验证码用 sha256 哈希存储（库里没有明文验证码），同样的 10 分钟过期 / 最多 5 次尝试 / 一次性消费；
 *   · 同一邮箱（或同一用户名）重复注册只保留最新一条记录，旧验证码随之失效；
 *   · 校验通过时在事务里创建 users 行并删除待验证记录。
 * 关闭邮箱验证（email_verify_required=0）时完全不走这条路径，注册直接建号（保持原有行为）。
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PENDING_KEEP_EXPIRED_MS = 24 * 3600 * 1000; // 验证码过期 24 小时后的待验证记录可清理

/** 验证码哈希（库中不保存明文验证码） */
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** 清理已过期很久的待验证记录（每次注册 / 重发顺带做一次，避免表无限增长）。
 *  注意 verify_token_expires = 0 表示「验证码已作废 / 已消费」，不能直接按过期时间清理，
 *  否则用户连错 5 次或校验成功后想「重新发送验证码」时，刚读到的记录会被自己顺手删掉。
 *  因此作废态改用 created_at 兜底：只有创建时间也超过 24 小时才清理。 */
function prunePendingRegistrations() {
  try {
    const cutoff = Date.now() - PENDING_KEEP_EXPIRED_MS;
    db.prepare('DELETE FROM pending_registrations WHERE (verify_token_expires > 0 AND verify_token_expires < ?) OR (verify_token_expires = 0 AND created_at < ?)').run(cutoff, cutoff);
  } catch { /* ignore */ }
}

/** 生成待验证注册的验证码并入库（哈希存储、10 分钟有效、尝试次数归零）。
 *  同时把 created_at 刷新为当前时间，作为这条记录的「最后活跃时间」（清理超期记录时按它判断）。
 *  返回明文验证码，仅用于发信与「邮件发不出去时只写服务端日志」，绝不进 HTTP 响应体。 */
function issuePendingCode(pendingId) {
  const code = emailCode();
  db.prepare('UPDATE pending_registrations SET verify_token_hash = ?, verify_token_expires = ?, verify_token_attempts = 0, created_at = ? WHERE id = ?')
    .run(hashCode(code), Date.now() + CODE_TTL_MS, Date.now(), pendingId);
  return code;
}

/** 作废待验证注册的验证码（过期 / 次数用尽 / 校验成功） */
function clearPendingCode(pendingId) {
  db.prepare("UPDATE pending_registrations SET verify_token_hash = '', verify_token_expires = 0, verify_token_attempts = 0 WHERE id = ?").run(pendingId);
}

/** 校验待验证注册的验证码（与 checkCode 同一套规则与文案：过期 / 5 次上限 / 一次性 / 模糊提示） */
function checkPendingCode(pendingId, code) {
  const invalid = '验证码无效或已过期，请重新获取';
  const row = db.prepare('SELECT verify_token_hash AS hash, verify_token_expires AS expires, verify_token_attempts AS attempts FROM pending_registrations WHERE id = ?').get(pendingId);
  if (!row || !row.hash) return { error: invalid };
  if (!row.expires || row.expires < Date.now()) { clearPendingCode(pendingId); return { error: invalid }; }
  if ((row.attempts || 0) >= CODE_MAX_ATTEMPTS) { clearPendingCode(pendingId); return { error: invalid }; }
  const given = hashCode(String(code == null ? '' : code).trim());
  const match = given.length === row.hash.length && crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(row.hash, 'utf8'));
  if (!match) {
    const attempts = (row.attempts || 0) + 1;
    if (attempts >= CODE_MAX_ATTEMPTS) {
      // 5 次用尽：验证码作废（待验证记录本身保留，用户可「重新发送验证码」再试）
      clearPendingCode(pendingId);
      return { error: `验证码错误次数已达上限（${CODE_MAX_ATTEMPTS} 次），本次验证码已作废，请重新获取` };
    }
    db.prepare('UPDATE pending_registrations SET verify_token_attempts = ? WHERE id = ?').run(attempts, pendingId);
    return { error: `验证码错误，还可尝试 ${CODE_MAX_ATTEMPTS - attempts} 次` };
  }
  clearPendingCode(pendingId); // 一次性消费
  return { ok: true };
}

/** 真正写入 users 行（关闭验证时直接建号 / 邮箱验证通过后建号共用），返回新用户 id */
function insertUserRow(name, emailStr, passwordHash, verified) {
  // 用户编号：取最小的空闲 uid（删除用户后其 uid 会被释放并复用，与题目/比赛等内容表一致）
  const uid = nextFreeId('users');
  const info = db.prepare(
    "INSERT INTO users (id, username, email, password_hash, is_admin, role, can_speak, can_discuss, can_reply, can_editorial, banned, nickname, avatar, bio, rating, email_verified, email_verify_token, created_at) VALUES (?, ?, ?, ?, 0, 'user', 1, 1, 1, 1, 0, '', '', '', 0, ?, '', ?)"
  ).run(uid, name, emailStr, passwordHash, verified ? 1 : 0, Date.now());
  const id = Number(info.lastInsertRowid) || uid;
  // 新用户默认头像：按用户名生成像素画头像（同一用户名永远得到同一张图）
  try {
    const url = require('./avatars').ensureIdenticon(id, name);
    if (url) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, id);
  } catch (e) {
    console.warn('[auth] 生成默认头像失败：' + (e && e.message));
  }
  return id;
}

/**
 * 注册。开启邮箱验证时**只写待验证表**（返回 pending:true，此时 users 里没有该账号）；
 * 关闭邮箱验证时直接创建账号并返回 id（保持原有行为）。
 * @param {string} username
 * @param {string} email
 * @param {string} password
 * @param {string} [ip] 客户端 IP（仅用于待验证记录留痕）
 */
async function registerUser(username, email, password, ip) {
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(name)) {
    return { error: '用户名需为 2-20 位字母、数字、下划线或中文' };
  }
  // H3：口令强度统一校验（长度 ≥10 + 弱口令黑名单 + 至少两类字符）
  const policyError = passwordPolicyError(password);
  if (policyError) return { error: policyError };
  const settings = require('./settings');
  const verifyRequired = settings.getSetting('email_verify_required', '0') === '1';
  const emailStr = String(email || '').trim();
  if (verifyRequired && !EMAIL_RE.test(emailStr)) {
    return { error: '邮箱验证已开启，请填写有效邮箱' };
  }
  // 用户名重复判定：users 与待验证表一起看（避免同一用户名被反复占用）
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) return { error: '用户名已被占用' };

  if (!verifyRequired) {
    // 关闭邮箱验证：直接建号（保持原有行为，邮箱只作展示、不做唯一性硬约束）
    const id = insertUserRow(name, emailStr, hashPassword(password), true);
    return { id, email_verify_required: false };
  }

  // ---- 开启邮箱验证：只写待验证表，验证通过前账号不存在 ----
  // 邮箱重复判定同样看 users（已被正式账号占用 / 正在验证中都不再新建记录）
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(emailStr)) {
    return { error: '该邮箱已被注册，请直接登录或使用「忘记密码」找回' };
  }
  prunePendingRegistrations();
  const byEmail = db.prepare('SELECT id FROM pending_registrations WHERE email = ?').get(emailStr);
  const byName = db.prepare('SELECT id, email FROM pending_registrations WHERE username = ?').get(name);
  // 同一用户名挂在另一个邮箱下 → 直接拒绝，避免待验证记录被互相覆盖
  if (byName && byName.email !== emailStr) {
    return { error: '该用户名正在验证中，请稍后再试或更换用户名' };
  }
  const now = Date.now();
  const code = emailCode();
  const pwHash = hashPassword(password);
  let pendingId;
  if (byEmail) {
    // 同一邮箱重复注册：覆盖旧记录（旧验证码随之失效，只保留最新验证码）
    db.prepare('UPDATE pending_registrations SET username = ?, email = ?, password_hash = ?, verify_token_hash = ?, verify_token_expires = ?, verify_token_attempts = 0, ip = ?, created_at = ? WHERE id = ?')
      .run(name, emailStr, pwHash, hashCode(code), now + CODE_TTL_MS, String(ip || '').slice(0, 80), now, byEmail.id);
    pendingId = byEmail.id;
  } else {
    const info = db.prepare('INSERT INTO pending_registrations (username, email, password_hash, verify_token_hash, verify_token_expires, verify_token_attempts, ip, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(name, emailStr, pwHash, hashCode(code), now + CODE_TTL_MS, String(ip || '').slice(0, 80), now);
    pendingId = Number(info.lastInsertRowid);
  }
  // 发送验证码邮件。H5：验证码**任何情况下都不进 HTTP 响应体**；
  // 邮件发不出去时只把验证码写入服务端日志（仅运维可见），用户可点「重新发送」再试。
  // 注意：此时 users 表里没有任何新行 —— 收不到邮件也不会产生半成品账号。
  const sent = await sendVerifyEmailBounded(emailStr, code);
  const emailReason = sent.sent ? '' : String(sent.reason || 'send_failed');
  if (!sent.sent) {
    console.warn(`[OJ] 验证码邮件发送失败（${emailReason}）；待验证注册 ${name}（${emailStr}）的邮箱验证码：${code}（10 分钟内有效，仅记录在服务端日志；账号尚未创建）`);
  }
  return {
    pending: true,
    pending_id: pendingId,
    email_verify_required: true,
    email_sent: !!sent.sent,
    email_reason: emailReason,
  };
}

/** 重新发送验证码。
 *  优先对待验证注册（pending_registrations）生效，其次兼容 v2.5.0 之前注册、
 *  仍留在 users 表里的未验证老账号；两者都没有时返回同一句模糊提示。
 *  L2：无论邮箱是否存在，都返回同一句模糊提示，避免账号枚举；H5：验证码只在邮件里，不下发响应体。 */
async function resendVerifyCode(email) {
  const emailStr = String(email || '').trim();
  const generic = { ok: true, reissued: false, email_sent: false, reason: 'ignored', message: '如果该邮箱有待验证的注册，验证码已重新发送，请查收邮件' };
  if (!EMAIL_RE.test(emailStr)) return { error: '请填写有效邮箱' };
  // 0) 先清理超期很久的记录（必须在读取记录之前，否则可能把本次要用的记录顺手删掉）
  prunePendingRegistrations();
  // 1) 新流程：待验证注册 → 换发新验证码（旧验证码立即失效）
  const pend = db.prepare('SELECT id, email, username FROM pending_registrations WHERE email = ?').get(emailStr);
  if (pend) {
    const code = issuePendingCode(pend.id);
    const r = await sendVerifyEmailBounded(emailStr, code);
    if (!r.sent) {
      console.warn(`[OJ] 验证码邮件重发失败（${r.reason}）；待验证注册 ${pend.username}（${pend.email}）的邮箱验证码：${code}（仅记录在服务端日志；账号尚未创建）`);
    }
    // reissued=true：确实换发了新验证码 —— 调用方据此把 verify 场景（IP + 邮箱）的限流清零
    return { ok: true, reissued: true, pending: true, email_sent: !!r.sent, reason: r.sent ? '' : String(r.reason || 'send_failed'), message: '如果该邮箱有待验证的注册，验证码已重新发送，请查收邮件' };
  }
  // 2) 兼容旧流程：v2.5.0 之前注册且仍未验证的老账号
  const row = db.prepare('SELECT id, email, username FROM users WHERE email = ? AND email_verified = 0').get(emailStr);
  if (!row) return generic;
  const code = issueCode('email_verify', row.id);
  const r = await sendVerifyEmailBounded(emailStr, code);
  if (!r.sent) {
    console.warn(`[OJ] 验证码邮件重发失败（${r.reason}）；账号 ${row.username}(uid=${row.id}) 的邮箱验证码：${code}（仅记录在服务端日志）`);
  }
  return { ok: true, reissued: true, email_sent: !!r.sent, reason: r.sent ? '' : String(r.reason || 'send_failed'), message: '如果该邮箱有待验证的注册，验证码已重新发送，请查收邮件' };
}

/**
 * 校验邮箱验证码。
 * 新流程：命中待验证注册 → 校验通过后在**事务里创建 users 行并删除待验证记录**（返回 created:true）；
 * 旧流程（兼容）：v2.5.0 之前注册、email_verified=0 的老账号仍可用同一接口完成验证，不做迁移、不做删除。
 * H5：10 分钟过期、最多 5 次尝试、一次性消费；L2：所有失败提示统一模糊文案。
 */
function verifyEmail(token, email) {
  const genericError = '验证码无效或已过期，请重新获取';
  const code = String(token == null ? '' : token).trim();
  if (!/^\d{6}$/.test(code)) return { error: genericError };
  const mail = String(email || '').trim();
  if (!mail) return { error: '请填写注册邮箱' };

  // 1) 新流程：待验证注册 → 验证通过才创建账号
  const pend = db.prepare('SELECT id, username, email, password_hash FROM pending_registrations WHERE email = ?').get(mail);
  if (pend) {
    const check = checkPendingCode(pend.id, code);
    if (check.error) return check;
    // 兜底：等待验证期间用户名 / 邮箱可能已被占用
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(pend.username)) {
      db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pend.id);
      return { error: '该用户名已被占用，请重新注册' };
    }
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(pend.email)) {
      db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pend.id);
      return { error: '该邮箱已被注册，请直接登录或使用「忘记密码」找回' };
    }
    let id;
    db.exec('BEGIN');
    try {
      id = insertUserRow(pend.username, pend.email, pend.password_hash, true);
      db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pend.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      console.warn('[OJ] 邮箱验证通过后创建账号失败（已回滚，未产生半成品账号）：' + (e && e.message));
      return { error: '创建账号失败，请稍后重试或联系管理员' };
    }
    return { ok: true, created: true, id, username: pend.username };
  }

  // 2) 兼容旧流程：仍留在 users 表里的未验证老账号
  const row = db.prepare('SELECT id, email_verified FROM users WHERE email = ?').get(mail);
  if (!row) return { error: genericError };
  // 已完成的账号也走同一条模糊提示（不再回「该邮箱已完成验证」，避免枚举）
  if (row.email_verified === 1) return { error: genericError };
  const check = checkCode('email_verify', row.id, code);
  if (check.error) return check;
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.id);
  return { ok: true, id: row.id };
}

/** 编辑资料更换邮箱：校验新邮箱合法且未被占用，生成验证码并通过 SMTP 发送。
 *  验证码有效前不修改邮箱；用户提交验证码时才真正更新。验证码不下发响应体（H5）。 */
async function requestEmailChange(userId, newEmail) {
  const email = String(newEmail || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: '请填写有效邮箱' };
  const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!u) return { error: '用户不存在' };
  if (u.email === email) return { error: '新邮箱与当前邮箱相同' };
  const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
  if (dup) return { error: '该邮箱已被其他账号绑定' };
  const settings = require('./settings');
  const smtp = require('./smtp');
  const smtpConfigured = !!settings.getSetting('smtp_host', '');
  if (!smtpConfigured) return { error: '未配置 SMTP，无法发送验证码邮件，请联系管理员' };
  const code = issueCode('email_change', userId);
  // 发送验证码（异步，不阻塞响应）
  const r = await sendVerifyEmail(email, code);
  if (!r.sent) {
    console.warn(`[OJ] 换绑邮箱验证码发送失败（${r.reason}）；uid=${userId} 的验证码：${code}（仅记录在服务端日志）`);
  }
  return { ok: true, email_sent: !!r.sent, reason: r.reason || '' };
}

/** 校验更换邮箱验证码并正式更新邮箱（新邮箱已验证）。H5：过期 / 次数上限 / 一次性消费。 */
function confirmEmailChange(userId, newEmail, code) {
  const email = String(newEmail || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: '请填写有效邮箱' };
  const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!u) return { error: '用户不存在' };
  if (u.email === email) return { error: '新邮箱与当前邮箱相同' };
  const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
  if (dup) return { error: '该邮箱已被其他账号绑定' };
  const check = checkCode('email_change', userId, code);
  if (check.error) return check;
  db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(email, userId);
  return { ok: true };
}

/** 忘记密码：向注册邮箱发送找回验证码（仅开启邮箱验证时可用）。
 *  L2：邮箱未注册也返回同一句模糊提示；H5：验证码只在邮件里，不下发响应体。
 *  v2.5.0：内置 admin 的找回验证码只发给「持内置超管会话」的请求 —— 无会话 / 普通管理员请求一律
 *  不下发验证码（对外仍是同一句模糊提示，不泄漏该邮箱是不是 admin），并把拦截写进审计。 */
async function forgotPassword(email, ip, actor) {
  const settings = require('./settings');
  if (settings.getSetting('email_verify_required', '0') !== '1') {
    return { error: '未开启邮箱验证，无法使用密码找回功能' };
  }
  const emailStr = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) return { error: '请填写有效邮箱' };
  const generic = { ok: true, email_sent: settings.getSetting('smtp_host', '') !== '', message: '如果该邮箱已注册，重置验证码已发送，请查收邮件（10 分钟内有效）' };
  const row = db.prepare('SELECT id, email, username FROM users WHERE email = ?').get(emailStr);
  if (!row) return generic;
  if (isBuiltinAdminUser(row) && !isBuiltinSuperAdminSession(actor)) {
    // 内置 admin：不下发找回验证码（否则等于给无会话/普通管理员留了一条改 admin 口令的路）
    auditBuiltinAdminChanged(actor, row, 'admin_password_change_denied',
      `拦截内置管理员找回验证码下发（路径 forgot_request）：${actor ? `操作者 ${actor.username}(uid=${actor.id}) 不是内置超级管理员会话` : '请求未携带有效登录会话'}`,
      ip);
    return generic;
  }
  const smtpConfigured = !!settings.getSetting('smtp_host', '');
  const code = issueCode('password_reset', row.id);
  if (smtpConfigured) {
    sendVerifyEmail(emailStr, code).then((r) => {
      if (!r.sent) console.warn(`[OJ] 找回密码邮件发送失败（${r.reason}）；账号 ${row.username}(uid=${row.id}) 的重置码：${code}（仅记录在服务端日志）`);
    }).catch(() => {});
  } else {
    console.warn(`[OJ] 未配置 SMTP，账号 ${row.username}(uid=${row.id}) 的找回密码重置码：${code}（仅记录在服务端日志）`);
  }
  return { ok: true, email_sent: smtpConfigured, message: generic.message };
}

/** 使用找回验证码重置密码。H5：过期 / 次数上限 / 一次性消费；H3：新口令强度校验；M2：重置后吊销该用户全部会话。
 *  v2.5.0：内置 admin 的口令不允许经「无会话 / 普通管理员会话」变更 —— 该路径本来就不需要登录态，
 *  是唯一能绕过会话改到 admin 口令的路，因此这里要求请求方必须持内置超管会话（is_superadmin 且
 *  username === 'admin'），否则 403；普通用户的自助找回完全不受影响（无会话也能用）。
 *  @param {string} [ip] 来源 IP（仅用于审计）
 *  @param {object|null} [actor] 当前登录用户（无会话传 null）
 */
function resetPassword(email, code, newPassword, ip, actor) {
  const genericError = '验证码无效或已过期，请重新获取';
  const policyError = passwordPolicyError(newPassword);
  if (policyError) return { error: policyError };
  const mail = String(email || '').trim();
  if (!mail) return { error: genericError };
  const row = db.prepare('SELECT id, username FROM users WHERE email = ?').get(mail);
  if (!row) return { error: genericError };
  // 先过守卫：拒绝时返回 403 + 明确中文提示（并写审计），且**不消耗验证码**
  const guard = guardBuiltinAdminPasswordChange(actor, row, 'forgot_reset', ip);
  if (!guard.ok) return guard;
  const check = checkCode('password_reset', row.id, code);
  if (check.error) return check;
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword), row.id);
  // M17：找回密码重置同样让 data/admin-password.txt 里的初始口令失效
  removeAdminPasswordFile('找回密码重置口令');
  // M2：重置密码后立即吊销该用户全部会话（含被窃会话）
  const revoked = destroyUserSessions(row.id);
  if (guard.builtin) {
    auditBuiltinAdminChanged(actor, row, 'admin_password_forgot_reset',
      `内置管理员口令经「邮箱验证码找回」重置成功（操作者：${actor.username}(uid=${actor.id})，已吊销会话 ${revoked} 个）`, ip);
  }
  return { ok: true, sessions_revoked: revoked };
}

function loginUser(identifier, password) {
  const id = String(identifier || '').trim();
  if (!id) return { error: '用户名或密码错误' };
  let row;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) {
    // 邮箱登录：优先精确匹配，仅当存在多个同邮箱时按注册先后取第一个
    row = db.prepare('SELECT * FROM users WHERE email = ? ORDER BY id ASC LIMIT 1').get(id);
  } else {
    row = db.prepare('SELECT * FROM users WHERE username = ?').get(id);
  }
  if (!row || !verifyPassword(password, row.password_hash)) {
    return { error: '用户名或密码错误' };
  }
  // 封禁到期自动恢复
  require('./users').checkUserExpiry(row.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
  if (fresh.banned) {
    return { error: '该账号已被封禁，请联系管理员' };
  }
  // 兼容 v2.5.0 之前注册、仍留在 users 表里的未验证老账号（email_verified=0）：
  //   · 站点**开启**邮箱验证时不迁移、不删除，但保持既有策略 —— 完成邮箱验证前不能登录
  //     （这类账号仍可用 #/verify 或登录页提示里的「重新发送验证码」补验证，验证流程未改动）；
  //   · 站点**关闭**邮箱验证时不再拦截 —— 管理员已声明本站不需要邮箱验证，
  //     继续拦截只会让这些老账号永久锁死（用户名占着、又收不到验证码时尤其致命）；
  //   · 管理员账号豁免，避免把自己锁在门外；
  //   · v2.5.0 之后新建的账号一律 email_verified=1，因此这里不会给新流程放开任何绕过口子。
  const verifyOn = require('./settings').getSetting('email_verify_required', '0') === '1';
  const isAdmin = fresh.is_admin === 1 || fresh.role === 'admin' || fresh.role === 'superadmin';
  if (verifyOn && !isAdmin && String(fresh.email || '').trim() !== '' && fresh.email_verified !== 1) {
    return { error: '邮箱尚未验证，请先完成邮箱验证' };
  }
  // H3：登录口令本身仍被接受（避免把已有弱口令的老账号锁在门外），但若是弱口令则显著提示并要求改密。
  // 用默认 / 弱口令登录的账号会被标记 must_change_password，前端据此弹窗提示改密。
  const weak = !!passwordPolicyError(password);
  if (weak && !fresh.must_change_password) {
    db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(row.id);
    fresh.must_change_password = 1;
  }
  return {
    user: sanitizeUser(fresh),
    must_change_password: weak || !!fresh.must_change_password,
    password_warning: weak
      ? `检测到当前账号使用弱口令，请立即在「个人资料 → 修改密码」中更换为至少 ${PASSWORD_MIN_LENGTH} 位、包含字母 / 数字 / 符号中至少两类的强密码。`
      : (fresh.must_change_password ? '当前账号的密码由系统初始生成或被管理员重置，请尽快修改为自己的强密码。' : ''),
  };
}

function getUserById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return sanitizeUser(row);
}

function getUserByUsername(username) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return sanitizeUser(row);
}

module.exports = {
  COOKIE_NAME,
  ROLE_ADMIN,
  ROLE_SUPERADMIN,
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  parsePermissions,
  hasPerm,
  createSession,
  destroySession,
  destroyUserSessions,
  getUserByToken,
  currentUser,
  setSessionCookie,
  clearSessionCookie,
  // 认证限流（H4）
  clientIp,
  throttleStatus,
  throttleFail,
  throttleReset,
  throttleMessage,
  THROTTLE,
  // 重发验证码频率上限（v2.5.0）
  resendLimitStatus,
  resendLimitHit,
  resendLimitMessage,
  RESEND_LIMIT,
  // 内置管理员口令变更防护 + 审计（v2.5.0）
  BUILTIN_ADMIN_USERNAME,
  isBuiltinAdminUser,
  isBuiltinSuperAdminSession,
  guardBuiltinAdminPasswordChange,
  auditBuiltinAdminChanged,
  // 验证码（H5）
  issueCode,
  clearCode,
  checkCode,
  CODE_TTL_MS,
  CODE_MAX_ATTEMPTS,
  // 待验证注册（v2.5.0）：开启邮箱验证时注册只写待验证表，验证通过才建号
  issuePendingCode,
  clearPendingCode,
  checkPendingCode,
  prunePendingRegistrations,
  registerUser,
  verifyEmail,
  resendVerifyCode,
  forgotPassword,
  resetPassword,
  requestEmailChange,
  confirmEmailChange,
  loginUser,
  getUserById,
  getUserByUsername,
  sanitizeUser,
};
