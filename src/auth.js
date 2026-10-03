'use strict';

const { db, nextFreeId } = require('./db');
const { randomToken, parseCookies } = require('./util');
const { DEFAULTS } = require('./config');
const { hashPassword, verifyPassword } = require('./password');

const COOKIE_NAME = 'oj_session';

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
  const cookies = parseCookies(req);
  return getUserByToken(cookies[COOKIE_NAME]);
}

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
    created_at: u.created_at,
  };
}

function setSessionCookie(res, token, expires) {
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expires).toUTCString()}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : [cookie]);
}

function clearSessionCookie(res) {
  const cookie = `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  res.setHeader('Set-Cookie', cookie);
}

// ---------------- 用户增删改查 ----------------

/** 6 位数字邮箱验证码 */
function emailCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 尝试通过 SMTP 发送验证码邮件；未配置 SMTP 时静默失败（前端回退展示验证码） */
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
    return { sent: false, reason: String(e.message || 'send_failed') };
  }
}

function registerUser(username, email, password) {
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(name)) {
    return { error: '用户名需为 2-20 位字母、数字、下划线或中文' };
  }
  if (String(password || '').length < 6) {
    return { error: '密码长度至少 6 位' };
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (exists) return { error: '用户名已被占用' };
  const settings = require('./settings');
  const verifyRequired = settings.getSetting('email_verify_required', '0') === '1';
  const emailStr = String(email || '').trim();
  if (verifyRequired && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) {
    return { error: '邮箱验证已开启，请填写有效邮箱' };
  }
  const verifyToken = verifyRequired ? emailCode() : '';
  // 用户编号：取最小的空闲 uid（删除用户后其 uid 会被释放并复用，与题目/比赛等内容表一致）
  const uid = nextFreeId('users');
  const info = db.prepare(
    "INSERT INTO users (id, username, email, password_hash, is_admin, role, can_speak, can_discuss, can_reply, can_editorial, banned, nickname, avatar, bio, rating, email_verified, email_verify_token, created_at) VALUES (?, ?, ?, ?, 0, 'user', 1, 1, 1, 1, 0, '', '', '', 0, ?, ?, ?)"
  ).run(uid, name, emailStr, hashPassword(password), verifyRequired ? 0 : 1, verifyToken, Date.now());
  const id = Number(info.lastInsertRowid) || uid;
  // 已配置 SMTP 时尝试发送验证码邮件（不阻塞注册响应）；未配置或发送失败时前端回退展示验证码
  const smtpConfigured = !!settings.getSetting('smtp_host', '');
  const emailSent = verifyRequired && emailStr && smtpConfigured;
  if (emailSent) {
    sendVerifyEmail(emailStr, verifyToken).then((r) => {
      if (!r.sent) console.log(`[OJ] 验证码邮件发送失败（${r.reason}），验证码将直接展示`);
    }).catch(() => {});
  }
  return { id, email_verify_required: verifyRequired, email_verify_token: verifyToken, email_sent: emailSent };
}

/** 重新发送验证码（按邮箱查找未验证用户） */
async function resendVerifyCode(email) {
  const emailStr = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) return { error: '请填写有效邮箱' };
  const row = db.prepare('SELECT id, email FROM users WHERE email = ? AND email_verified = 0').get(emailStr);
  if (!row) return { error: '该邮箱没有待验证的注册记录' };
  const code = emailCode();
  db.prepare('UPDATE users SET email_verify_token = ? WHERE id = ?').run(code, row.id);
  const r = await sendVerifyEmail(emailStr, code);
  return { ok: true, verify_code: code, email_sent: r.sent };
}

function verifyEmail(token) {
  const row = db.prepare('SELECT id FROM users WHERE email_verify_token = ?').get(String(token || '').trim());
  if (!row) return { error: '验证码无效' };
  db.prepare("UPDATE users SET email_verified = 1, email_verify_token = '' WHERE id = ?").run(row.id);
  return { ok: true };
}

/** 编辑资料更换邮箱：校验新邮箱合法且未被占用，生成验证码并通过 SMTP 发送（未配置时前端回退展示验证码）。
 *  验证码有效前不修改邮箱；用户提交验证码时才真正更新。 */
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
  const code = emailCode();
  db.prepare('UPDATE users SET email_change_token = ? WHERE id = ?').run(code, userId);
  // 发送验证码（异步，不阻塞响应）
  const r = await sendVerifyEmail(email, code);
  return { ok: true, email_sent: r.sent, reason: r.reason || '', verify_code: r.sent ? undefined : code };
}

/** 校验更换邮箱验证码并正式更新邮箱（新邮箱已验证）。 */
function confirmEmailChange(userId, newEmail, code) {
  const email = String(newEmail || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: '请填写有效邮箱' };
  const u = db.prepare('SELECT id, email, email_change_token FROM users WHERE id = ?').get(userId);
  if (!u) return { error: '用户不存在' };
  if (u.email === email) return { error: '新邮箱与当前邮箱相同' };
  const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
  if (dup) return { error: '该邮箱已被其他账号绑定' };
  if (!u.email_change_token || u.email_change_token !== String(code || '').trim()) {
    return { error: '验证码错误或已过期，请重新获取' };
  }
  db.prepare("UPDATE users SET email = ?, email_verified = 1, email_change_token = '' WHERE id = ?").run(email, userId);
  return { ok: true };
}

/** 忘记密码：向注册邮箱发送找回验证码（仅开启邮箱验证时可用） */
async function forgotPassword(email) {
  const settings = require('./settings');
  if (settings.getSetting('email_verify_required', '0') !== '1') {
    return { error: '未开启邮箱验证，无法使用密码找回功能' };
  }
  const emailStr = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) return { error: '请填写有效邮箱' };
  const row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(emailStr);
  if (!row) return { error: '该邮箱未注册' };
  const code = emailCode();
  db.prepare('UPDATE users SET password_reset_token = ? WHERE id = ?').run(code, row.id);
  const smtpConfigured = !!settings.getSetting('smtp_host', '');
  if (smtpConfigured) {
    sendVerifyEmail(emailStr, code).then((r) => {
      if (!r.sent) console.log(`[OJ] 找回密码邮件发送失败（${r.reason}）`);
    }).catch(() => {});
  }
  return { ok: true, email_sent: smtpConfigured, verify_code: smtpConfigured ? undefined : code };
}

/** 使用找回验证码重置密码 */
function resetPassword(email, code, newPassword) {
  if (String(newPassword || '').length < 6) return { error: '新密码长度至少 6 位' };
  const row = db.prepare('SELECT id FROM users WHERE email = ? AND password_reset_token = ?').get(String(email || '').trim(), String(code || '').trim());
  if (!row) return { error: '验证码错误或已过期' };
  db.prepare("UPDATE users SET password_hash = ?, password_reset_token = '' WHERE id = ?").run(hashPassword(newPassword), row.id);
  return { ok: true };
}

function loginUser(identifier, password) {
  const id = String(identifier || '').trim();
  if (!id) return { error: '用户名或邮箱错误' };
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
  if (fresh.email_verified === 0) {
    return { error: '邮箱尚未验证，请先完成邮箱验证' };
  }
  return { user: sanitizeUser(fresh) };
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
  getUserByToken,
  currentUser,
  setSessionCookie,
  clearSessionCookie,
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
