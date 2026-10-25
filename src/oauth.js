'use strict';

/* ============================================================================
 * LCZOJ OAuth 2.0 授权服务器（Authorization Code）
 *
 * 目的：让 Lith Tools 这类可信站点使用 LCZOJ 的登录状态完成「授权登录」，
 *      全程不接触 LCZOJ 的密码，也不共享 LCZOJ 的会话 Cookie。
 *
 * 流程：
 *   1) 第三方把浏览器送到 GET /api/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&state=…
 *      · 未登录 → 302 到 /#/login?redirect=<本授权地址>，登录后自动回到授权页；
 *      · 已登录 → 渲染「同意授权」页面（用户可拒绝）。
 *   2) 用户同意 → 302 回 redirect_uri?code=…&state=…（授权码 5 分钟有效、一次性）。
 *   3) 第三方服务器 POST /api/oauth/token 用 code + client_secret 换 access_token（1 小时有效）。
 *   4) 第三方服务器 GET /api/oauth/userinfo（Bearer token）拿到 sub / username / email 等资料。
 *
 * 配置（环境变量，改动后重启生效）：
 *   OJ_OAUTH_CLIENT_ID       客户端标识，例如 lith-tools
 *   OJ_OAUTH_CLIENT_SECRET   客户端密钥（只存 sha256，不下发、不落日志）
 *   OJ_OAUTH_CLIENT_NAME     授权页展示的应用名，默认 Lith Tools
 *   OJ_OAUTH_REDIRECT_URIS   允许的回调地址，多个用逗号 / 空格 / 换行分隔（必须精确匹配）
 * 未同时配置 ID / SECRET / 回调地址时，所有 OAuth 接口返回「未启用」，不影响原有登录。
 * ========================================================================== */

const crypto = require('crypto');
const { db } = require('./db');
const { escapeHtml } = require('./util');

const CLIENT_ID = String(process.env.OJ_OAUTH_CLIENT_ID || '').trim().slice(0, 120);
const CLIENT_SECRET = String(process.env.OJ_OAUTH_CLIENT_SECRET || '').trim();
const CLIENT_NAME = String(process.env.OJ_OAUTH_CLIENT_NAME || 'Lith Tools').trim().slice(0, 80) || 'Lith Tools';
const REDIRECT_URIS = String(process.env.OJ_OAUTH_REDIRECT_URIS || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, 20);

const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

function now() { return Date.now(); }

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function enabled() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URIS.length);
}

/** 把环境变量里的客户端同步进数据库（幂等；密钥只存哈希）。 */
function seedClient() {
  if (!enabled()) return;
  try {
    db.prepare(`
      INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        secret_hash = excluded.secret_hash,
        name = excluded.name,
        redirect_uris = excluded.redirect_uris
    `).run(CLIENT_ID, sha256(CLIENT_SECRET), CLIENT_NAME, REDIRECT_URIS.join('\n'), now());
  } catch (e) {
    console.warn('[LCZOJ] OAuth 客户端初始化失败：' + ((e && e.message) || e));
  }
}

function getClient(clientId) {
  const id = String(clientId || '').trim().slice(0, 120);
  if (!id) return null;
  const row = db.prepare('SELECT client_id, secret_hash, name, redirect_uris FROM oauth_clients WHERE client_id = ?').get(id);
  if (!row) return null;
  return {
    id: row.client_id,
    secretHash: row.secret_hash,
    name: row.name || row.client_id,
    redirectUris: String(row.redirect_uris || '').split(/\s+/).filter(Boolean),
  };
}

function secretMatches(client, provided) {
  if (!client || !provided) return false;
  const given = Buffer.from(sha256(provided), 'utf8');
  const expected = Buffer.from(String(client.secretHash || ''), 'utf8');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function isAllowedRedirect(client, redirectUri) {
  return Boolean(client && redirectUri && client.redirectUris.includes(redirectUri));
}

function normalizeScope(raw) {
  // 目前只开放「读取公开资料」一个范围；未知范围忽略（不报错），避免客户端因 scope 细节失败。
  const requested = String(raw || '').split(/\s+/).filter(Boolean);
  const allowed = requested.filter((s) => s === 'profile');
  return (allowed.length ? allowed : ['profile']).join(' ');
}

/** 永久 sub：每个 LCZOJ 用户第一次被授权时生成，删除用户即级联删除；绝不复用 users.id。 */
function getSub(userId) {
  const row = db.prepare('SELECT sub FROM oauth_identities WHERE user_id = ?').get(userId);
  if (row && row.sub) return row.sub;
  const sub = 'u_' + randomToken(18);
  try {
    db.prepare('INSERT INTO oauth_identities (user_id, sub, created_at) VALUES (?, ?, ?)').run(userId, sub, now());
    return sub;
  } catch (e) {
    // 并发下可能已被另一个请求写入：重读一次
    const again = db.prepare('SELECT sub FROM oauth_identities WHERE user_id = ?').get(userId);
    if (again && again.sub) return again.sub;
    throw e;
  }
}

/* ------------------------------------------------------------------ HTTP 小工具 */

function sendHtml(res, status, html, extraHeaders = {}) {
  if (!res || res.headersSent || res.writableEnded) return;
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, extraHeaders));
  res.end(body);
}

function sendJson(res, status, data, extraHeaders = {}) {
  if (!res || res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
  }, extraHeaders));
  res.end(body);
}

function redirect(res, location) {
  if (!res || res.headersSent || res.writableEnded) return;
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readRawBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = parseInt((req.headers && req.headers['content-length']) || '', 10);
    if (Number.isFinite(declared) && declared > limit) {
      try { req.resume(); } catch { /* ignore */ }
      reject(Object.assign(new Error('请求体过大'), { status: 413 }));
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > limit) {
        done = true;
        try { req.resume(); } catch { /* ignore */ }
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => { if (!done) reject(e); });
  });
}

async function readParams(req) {
  const raw = await readRawBody(req);
  const text = raw.toString('utf8');
  const type = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  if (type.includes('application/json')) {
    if (!text.trim()) return {};
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error('JSON 解析失败'), { status: 400 }); }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  const out = {};
  for (const [key, value] of new URLSearchParams(text)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function parseBasicAuth(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  const match = /^Basic\s+([A-Za-z0-9+/=._-]+)$/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index < 0) return null;
    return { id: decoded.slice(0, index), secret: decoded.slice(index + 1) };
  } catch {
    return null;
  }
}

function redirectWithError(res, redirectUri, state, error, description) {
  try {
    const target = new URL(redirectUri);
    target.searchParams.set('error', error);
    if (description) target.searchParams.set('error_description', description);
    if (state) target.searchParams.set('state', state);
    redirect(res, target.toString());
  } catch {
    sendHtml(res, 400, layout('无法跳转', '<p class="muted">回调地址无效，授权已中止。</p>'));
  }
}

/* ------------------------------------------------------------------ 页面 */

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · LCZOJ</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f6fb; --card:#fff; --text:#0f172a; --muted:#64748b; --line:#e2e8f0; --brand:#4f46e5; --brand2:#06b6d4; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b1120; --card:#111827; --text:#e5e7eb; --muted:#9ca3af; --line:#1f2937; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:linear-gradient(135deg,#eef2ff 0%,var(--bg) 45%,#ecfeff 100%); color:var(--text);
         font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  @media (prefers-color-scheme: dark) { body { background:linear-gradient(135deg,#0b1120 0%,#0f172a 45%,#082f49 100%); } }
  .card { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:18px;
          padding:28px; box-shadow:0 24px 60px -28px rgba(15,23,42,.35); }
  .brand { display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:-.02em; }
  .mark { width:34px; height:34px; border-radius:10px; display:grid; place-items:center; color:#fff;
          background:linear-gradient(135deg,var(--brand),var(--brand2)); font-weight:900; }
  h1 { font-size:20px; margin:20px 0 6px; letter-spacing:-.02em; }
  .sub { margin:0 0 18px; color:var(--muted); }
  .user { display:flex; align-items:center; gap:10px; padding:12px; border:1px solid var(--line); border-radius:12px; margin:14px 0; }
  .avatar { width:36px; height:36px; border-radius:50%; display:grid; place-items:center; color:#fff; font-weight:700;
            background:linear-gradient(135deg,#6366f1,#06b6d4); }
  .user small { display:block; color:var(--muted); }
  .perm { background:var(--bg); border-radius:12px; padding:12px 14px; margin:16px 0; color:var(--muted); }
  .perm b { color:var(--text); }
  .row { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; border:0; border-radius:11px; padding:11px 16px; font:inherit; font-weight:600; cursor:pointer; }
  .approve { color:#fff; background:linear-gradient(135deg,var(--brand),var(--brand2)); }
  .deny { color:var(--text); background:var(--bg); border:1px solid var(--line); }
  .deny:hover { background:var(--line); }
  .muted { color:var(--muted); }
  .err { color:#e11d48; background:#fff1f2; border:1px solid #fecdd3; border-radius:10px; padding:10px 12px; }
  @media (prefers-color-scheme: dark) { .err { background:#4c0519; border-color:#881337; color:#fecdd3; } }
  a { color:var(--brand); }
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="mark">L</span> LCZOJ</div>
    ${body}
  </main>
</body>
</html>`;
}

function consentPage({ client, viewer, params, redirectUri, error }) {
  const displayName = viewer.nickname || viewer.username || '用户';
  const initial = String(displayName).trim().slice(0, 1).toUpperCase() || '?';
  let targetHost = '';
  try { targetHost = new URL(redirectUri).host; } catch { /* ignore */ }
  const hidden = (name, value) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value == null ? '' : String(value))}" />`;
  return layout('授权登录', `
    <h1>授权 ${escapeHtml(client.name)} 登录</h1>
    <p class="sub">${escapeHtml(client.name)} 请求使用你的 LCZOJ 账号登录。</p>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
    <div class="user">
      <span class="avatar">${escapeHtml(initial)}</span>
      <div><b>${escapeHtml(displayName)}</b><small>@${escapeHtml(viewer.username)} · UID ${escapeHtml(String(viewer.id))}</small></div>
    </div>
    <div class="perm">
      <div>授权后，<b>${escapeHtml(client.name)}</b> 将获得：</div>
      <div>· 你的公开资料（用户名、昵称、头像、角色、积分）</div>
      <div>· 你的邮箱地址与邮箱验证状态</div>
      <div class="muted" style="margin-top:8px">不会获得你的密码、会话 Cookie，也不会获得提交记录或管理权限。</div>
    </div>
    <form method="post" action="/api/oauth/authorize">
      ${hidden('response_type', params.get('response_type') || 'code')}
      ${hidden('client_id', client.id)}
      ${hidden('redirect_uri', redirectUri)}
      ${hidden('state', params.get('state') || '')}
      ${hidden('scope', params.get('scope') || 'profile')}
      <div class="row">
        <button class="deny" type="submit" name="decision" value="deny">取消</button>
        <button class="approve" type="submit" name="decision" value="approve">同意授权</button>
      </div>
    </form>
    <p class="muted" style="margin:14px 0 0;text-align:center;font-size:12px">授权后将返回 ${escapeHtml(targetHost || client.name)}</p>
  `);
}

function errorPage(title, message) {
  return layout('授权失败', `
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">${escapeHtml(message)}</p>
    <p class="muted">你可以关闭此页面，或返回 <a href="/">LCZOJ 首页</a>。</p>
  `);
}

/* ------------------------------------------------------------------ 路由 */

function handleAuthorize(req, res, url, viewer) {
  if (!enabled()) {
    return sendHtml(res, 503, errorPage('授权登录未启用', '站点管理员尚未配置 OAuth 客户端。'));
  }
  const params = url.searchParams;
  const client = getClient(params.get('client_id'));
  if (!client) {
    return sendHtml(res, 400, errorPage('无效的客户端', 'client_id 未在本站登记。'));
  }
  const redirectUri = String(params.get('redirect_uri') || '');
  if (!isAllowedRedirect(client, redirectUri)) {
    return sendHtml(res, 400, errorPage('无效的回调地址', 'redirect_uri 与登记值不一致，授权已中止。'));
  }
  const state = String(params.get('state') || '').slice(0, 500);
  if (String(params.get('response_type') || '') !== 'code') {
    return redirectWithError(res, redirectUri, state, 'unsupported_response_type', '仅支持 response_type=code');
  }
  if (!viewer) {
    // 登录后回到当前这个授权地址（登录页支持站内绝对路径跳转）
    const back = '/api/oauth/authorize?' + params.toString();
    return redirect(res, '/#/login?redirect=' + encodeURIComponent(back));
  }
  if (viewer.banned) {
    // 扩展错误码：让第三方能区分「用户主动取消」与「账号被封禁」，而不是都提示成取消授权。
    return redirectWithError(res, redirectUri, state, 'account_banned', '该账号已被封禁');
  }
  return sendHtml(res, 200, consentPage({ client, viewer, params, redirectUri }));
}

async function handleDecision(req, res, viewer) {
  let params;
  try {
    params = await readParams(req);
  } catch (e) {
    return sendHtml(res, e.status === 413 ? 413 : 400, errorPage('请求无效', '无法读取授权请求。'));
  }

  const client = getClient(params.client_id);
  const redirectUri = String(params.redirect_uri || '');
  if (!client || !isAllowedRedirect(client, redirectUri)) {
    return sendHtml(res, 400, errorPage('无效的授权请求', '客户端或回调地址校验失败。'));
  }
  const state = String(params.state || '').slice(0, 500);
  if (!viewer) {
    // 会话过期：让用户重新登录后手动重试，避免把 POST 参数拼回 GET 造成意外
    return sendHtml(res, 401, errorPage('登录已过期', '请返回 Lith Tools 重新点击「使用 LCZOJ 账号登录」。'));
  }
  if (String(params.decision || '') !== 'approve') {
    return redirectWithError(res, redirectUri, state, 'access_denied', '用户取消了授权');
  }

  const code = randomToken(24);
  db.prepare(`
    INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, scope, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(sha256(code), client.id, viewer.id, redirectUri, normalizeScope(params.scope), now(), now() + CODE_TTL_MS);

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return redirect(res, target.toString());
}

async function handleToken(req, res) {
  if (!enabled()) {
    return sendJson(res, 503, { error: 'temporarily_unavailable', error_description: '授权登录未启用' });
  }
  let params;
  try {
    params = await readParams(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid_request', error_description: '无法读取请求体' });
  }

  const basic = parseBasicAuth(req);
  const clientId = String(params.client_id || (basic && basic.id) || '');
  const clientSecret = String(params.client_secret || (basic && basic.secret) || '');
  const client = getClient(clientId);
  if (!client || !secretMatches(client, clientSecret)) {
    return sendJson(res, 401, { error: 'invalid_client', error_description: 'client_id 或 client_secret 不正确' }, {
      'WWW-Authenticate': 'Basic realm="LCZOJ OAuth"',
    });
  }
  if (String(params.grant_type || '') !== 'authorization_code') {
    return sendJson(res, 400, { error: 'unsupported_grant_type', error_description: '仅支持 authorization_code' });
  }

  const code = String(params.code || '');
  const redirectUri = String(params.redirect_uri || '');
  if (!code) return sendJson(res, 400, { error: 'invalid_request', error_description: '缺少 code' });

  const codeHash = sha256(code);
  const row = db.prepare(`
    SELECT code_hash, client_id, user_id, redirect_uri, scope, expires_at, used_at
    FROM oauth_authorization_codes WHERE code_hash = ?
  `).get(codeHash);
  if (!row || row.client_id !== client.id || row.used_at || row.expires_at <= now() || row.redirect_uri !== redirectUri) {
    return sendJson(res, 400, { error: 'invalid_grant', error_description: '授权码无效、已过期或已被使用' });
  }

  const consumed = db.prepare('UPDATE oauth_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at = 0').run(now(), codeHash);
  if (consumed.changes !== 1) {
    return sendJson(res, 400, { error: 'invalid_grant', error_description: '授权码已被使用' });
  }

  const accessToken = randomToken(32);
  db.prepare(`
    INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, created_at, expires_at, revoked)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(sha256(accessToken), client.id, row.user_id, row.scope || 'profile', now(), now() + TOKEN_TTL_MS);

  return sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    scope: row.scope || 'profile',
  });
}

function handleUserInfo(req, res) {
  const header = String((req.headers && req.headers.authorization) || '');
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  if (!match) {
    return sendJson(res, 401, { error: 'invalid_token', error_description: '缺少 Bearer 令牌' }, {
      'WWW-Authenticate': 'Bearer realm="LCZOJ OAuth"',
    });
  }

  const row = db.prepare(`
    SELECT t.user_id, t.expires_at, t.revoked,
           u.id, u.username, u.nickname, u.email, u.avatar, u.role, u.is_admin,
           u.rating, u.email_verified, u.banned, u.created_at
      FROM oauth_access_tokens t
      JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?
  `).get(sha256(match[1].trim()));

  if (!row || row.revoked || row.expires_at <= now()) {
    return sendJson(res, 401, { error: 'invalid_token', error_description: '令牌无效或已过期' }, {
      'WWW-Authenticate': 'Bearer realm="LCZOJ OAuth", error="invalid_token"',
    });
  }
  if (row.banned) {
    return sendJson(res, 403, { error: 'access_denied', error_description: '该账号已被封禁' });
  }

  return sendJson(res, 200, {
    sub: getSub(row.user_id),
    id: row.id,
    username: row.username,
    nickname: row.nickname || '',
    email: row.email || '',
    email_verified: !!row.email_verified,
    avatar: row.avatar || '',
    role: row.role || 'user',
    is_admin: !!row.is_admin,
    rating: row.rating || 0,
    created_at: row.created_at,
  });
}

/** 供 server.js 的 handleApi 分发；返回 true 表示已处理。 */
async function handleApi(req, res, url, method, viewer, seg) {
  if (!seg || seg[0] !== 'oauth') return false;
  if (seg.length === 2 && seg[1] === 'authorize') {
    if (method === 'GET') { handleAuthorize(req, res, url, viewer); return true; }
    if (method === 'POST') { await handleDecision(req, res, viewer); return true; }
    fail(res, 405, '请求方法不支持');
    return true;
  }
  if (seg.length === 2 && seg[1] === 'token' && method === 'POST') {
    await handleToken(req, res);
    return true;
  }
  if (seg.length === 2 && seg[1] === 'userinfo' && method === 'GET') {
    handleUserInfo(req, res);
    return true;
  }
  fail(res, 404, '接口不存在');
  return true;
}

function fail(res, status, message) {
  return sendJson(res, status, { success: false, message });
}

// 启动时同步客户端配置，并清理过期的授权码 / 令牌（只删过期 1 天以上的，保留排障现场）
seedClient();
try {
  db.prepare('DELETE FROM oauth_authorization_codes WHERE expires_at < ?').run(now() - 24 * 3600 * 1000);
  db.prepare('DELETE FROM oauth_access_tokens WHERE expires_at < ?').run(now() - 24 * 3600 * 1000);
} catch { /* ignore */ }

module.exports = {
  handleApi,
  enabled,
  getSub,
  // 暴露给测试 / 运维脚本
  _private: { sha256, getClient, secretMatches },
};
