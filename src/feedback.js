'use strict';

const { db } = require('./db');
const { parsePagination } = require('./util');
const notifications = require('./notifications');

const FEEDBACK_TYPES = ['feedback', 'bug', 'suggestion', 'report', 'submission'];
const FEEDBACK_TYPE_LABEL = { feedback: '反馈', bug: 'Bug 报告', suggestion: '建议', report: '举报', submission: '投稿' };
const FEEDBACK_STATUS_LABEL = { pending: '待处理', resolved: '已处理', closed: '已关闭' };

/** 用户提交反馈 / 举报 */
function createFeedback(userId, username, type, content) {
  const t = FEEDBACK_TYPES.includes(type) ? type : 'feedback';
  const c = String(content || '').trim();
  if (!c) return { error: '内容不能为空' };
  if (c.length > 5000) return { error: '内容过长（最多 5000 字）' };
  const info = db.prepare(
    'INSERT INTO feedbacks (user_id, username, type, content, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?)'
  ).run(userId, username, t, c, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

function serialize(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    type: row.type,
    type_label: FEEDBACK_TYPE_LABEL[row.type] || row.type,
    content: row.content,
    status: row.status,
    status_label: FEEDBACK_STATUS_LABEL[row.status] || row.status,
    reply: row.reply,
    // v2.8.3：处理次数 / 处理人 —— 后台据此显示「第 N 次处理」并支持「再次处理」
    handle_count: Number(row.handle_count) || 0,
    handled_by: row.handled_by || 0,
    handled_by_name: row.handled_by_name || '',
    created_at: row.created_at,
    handled_at: row.handled_at,
  };
}

/** 我的反馈列表（可选 id：只取某一条，供「处理结果通知」直接跳转并高亮） */
function listMyFeedbacks(userId, query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const onlyId = parseInt(query.get('id') || '', 10);
  if (Number.isFinite(onlyId) && onlyId > 0) {
    const row = db.prepare('SELECT * FROM feedbacks WHERE user_id = ? AND id = ?').get(userId, onlyId);
    return { items: row ? [serialize(row)] : [], total: row ? 1 : 0, page: 1, size };
  }
  const total = db.prepare('SELECT COUNT(*) AS c FROM feedbacks WHERE user_id = ?').get(userId).c;
  const rows = db.prepare('SELECT * FROM feedbacks WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, size, offset);
  return { items: rows.map(serialize), total, page, size };
}

/** 全部反馈（后台，仅超级管理员） */
function listAllFeedbacks(query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const status = (query.get('status') || '').trim();
  const search = (query.get('search') || '').trim();
  const where = [];
  const params = [];
  if (status === 'pending' || status === 'resolved' || status === 'closed') {
    where.push('f.status = ?'); params.push(status);
  }
  if (search) {
    // 按内容 / 用户ID / 用户名搜索
    where.push('(f.content LIKE ? OR f.user_id = ? OR u.username LIKE ?)');
    params.push(`%${search}%`, parseInt(search, 10) || -1, `%${search}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM feedbacks f LEFT JOIN users u ON u.id = f.user_id ${whereSql}`).get(...params).c;
  // 同时带出「上一次的处理人」，便于后台在再次处理时展示可追溯信息
  const rows = db.prepare(`
    SELECT f.*, COALESCE(u.username, f.username) AS username, COALESCE(hu.username, '') AS handled_by_name
    FROM feedbacks f
    LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN users hu ON hu.id = f.handled_by
    ${whereSql} ORDER BY f.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  return { items: rows.map(serialize), total, page, size };
}

/** 处理反馈审计：admin_audit（主，含来源 IP）+ moderation_logs（镜像，与 src/taxonomy.js 同一套写法）
 *  v2.8.3：每次处理（含再次处理）都写一条，detail 里带「第 N 次处理」，保证可追溯。 */
function auditFeedbackHandle(fb, actor, ip, detail, action) {
  const now = Date.now();
  const actorId = Number(actor && actor.id) || 0;
  const actorName = String((actor && actor.username) || '').slice(0, 80);
  const text = String(detail || '').slice(0, 500);
  const target = `反馈 #${fb.id}`;
  try {
    db.prepare('INSERT INTO admin_audit (created_at, actor_id, actor_name, target_id, target_name, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now, actorId, actorName, Number(fb.id) || 0, target, action, text, String(ip || '').slice(0, 80));
  } catch (e) { console.warn('[LCZOJ] 写入反馈处理审计失败（admin_audit）：' + (e && e.message)); }
  try {
    db.prepare('INSERT INTO moderation_logs (admin_id, admin_name, user_id, username, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(actorId, actorName, Number(fb.user_id) || 0, String(fb.username || '').slice(0, 80), action, text, now);
  } catch (e) { console.warn('[LCZOJ] 镜像反馈处理审计到社区管理记录失败：' + (e && e.message)); }
}

/** 审核反馈（仅超级管理员）：首次处理「待处理」，再次处理「已处理 / 已关闭」（回复 / 状态 / 处理人 / 处理时间全部可改写）
 *  v2.8.3：① 已处理 / 已关闭的反馈允许**再次处理**（handle_count 累加 + 审计写「第 N 次处理」）；
 *          ② 每次处理都给提交者发一条站内通知（复用 src/notifications.js 的 notify，失败不影响处理本身）。
 *  @param {object} [actor] 处理人（超级管理员），缺省时仍可处理，只是不记录处理人
 *  @param {string} [ip]    来源 IP（审计用） */
function handleFeedback(id, data, actor, ip) {
  const row = db.prepare('SELECT id, user_id, username, type, content, status, reply, handle_count FROM feedbacks WHERE id = ?').get(id);
  if (!row) return { error: '反馈不存在' };
  const status = data.status === 'resolved' ? 'resolved' : (data.status === 'closed' ? 'closed' : 'resolved');
  const reply = String(data.reply || '').trim().slice(0, 2000);
  // 「待处理」→ 首次处理；已处理 / 已关闭（含升级前遗留的、handle_count 仍为 0 的老记录）→ 再次处理
  const first = row.status === 'pending';
  const count = (Number(row.handle_count) || 0) + 1;
  const now = Date.now();
  db.prepare('UPDATE feedbacks SET status = ?, reply = ?, handled_by = ?, handle_count = ?, handled_at = ? WHERE id = ?')
    .run(status, reply, Number(actor && actor.id) || 0, count, now, id);

  // 审计（可追溯）：admin_audit + moderation_logs，detail 里写明这是第几次处理
  const statusLabel = FEEDBACK_STATUS_LABEL[status] || status;
  const replyBrief = reply ? `回复：${reply.slice(0, 120)}` : '未填写回复';
  auditFeedbackHandle(row, actor, ip,
    `第 ${count} 次处理${first ? '' : '（再次处理）'}，状态：${statusLabel}（原状态：${FEEDBACK_STATUS_LABEL[row.status] || row.status}），${replyBrief}`,
    first ? 'feedback_handle' : 'feedback_rehandle');

  // 通知提交者：标题 = 反馈摘要 + 处理结果，内容 = 状态 + 回复摘要，点击跳回该反馈。
  // 自己处理自己提交的反馈也照常发（只发这一条，不重复）。
  try {
    const brief = String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 40) || `#${row.id}`;
    const actorName = String((actor && actor.username) || '管理员');
    const replySummary = reply ? reply.replace(/\s+/g, ' ').trim().slice(0, 200) : '管理员未填写回复';
    notifications.notify(
      row.user_id,
      'feedback',
      `${first ? '' : '再次处理 · '}你的反馈「${brief}」${first ? '已处理' : '已再次处理'}：${statusLabel}`,
      `处理人：${actorName}｜状态：${statusLabel}｜回复：${replySummary}`,
      '/feedback?id=' + row.id,
      'system'
    );
  } catch (e) {
    console.warn('[LCZOJ] 反馈处理通知发送失败：' + (e && e.message));
  }

  return { ok: true, rehandled: !first, handle_count: count, status, handled_at: now };
}

module.exports = {
  createFeedback, listMyFeedbacks, listAllFeedbacks, handleFeedback,
  FEEDBACK_TYPES, FEEDBACK_TYPE_LABEL, FEEDBACK_STATUS_LABEL,
};
