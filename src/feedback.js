'use strict';

const { db } = require('./db');
const { parsePagination } = require('./util');

const FEEDBACK_TYPES = ['feedback', 'bug', 'suggestion', 'report', 'submission'];
const FEEDBACK_TYPE_LABEL = { feedback: '反馈', bug: 'Bug 报告', suggestion: '建议', report: '举报', submission: '投稿' };

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
    status_label: row.status === 'pending' ? '待处理' : (row.status === 'resolved' ? '已处理' : '已关闭'),
    reply: row.reply,
    created_at: row.created_at,
    handled_at: row.handled_at,
  };
}

/** 我的反馈列表 */
function listMyFeedbacks(userId, query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
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
  const rows = db.prepare(`SELECT f.*, COALESCE(u.username, f.username) AS username FROM feedbacks f LEFT JOIN users u ON u.id = f.user_id ${whereSql} ORDER BY f.id DESC LIMIT ? OFFSET ?`).all(...params, size, offset);
  return { items: rows.map(serialize), total, page, size };
}

/** 审核反馈（仅超级管理员）：处理（回复）或关闭 */
function handleFeedback(id, data) {
  const row = db.prepare('SELECT id FROM feedbacks WHERE id = ?').get(id);
  if (!row) return { error: '反馈不存在' };
  const status = data.status === 'resolved' ? 'resolved' : (data.status === 'closed' ? 'closed' : 'resolved');
  const reply = String(data.reply || '').trim().slice(0, 2000);
  db.prepare('UPDATE feedbacks SET status = ?, reply = ?, handled_at = ? WHERE id = ?')
    .run(status, reply, Date.now(), id);
  return { ok: true };
}

module.exports = { createFeedback, listMyFeedbacks, listAllFeedbacks, handleFeedback, FEEDBACK_TYPES, FEEDBACK_TYPE_LABEL };
