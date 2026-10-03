'use strict';

/* 站内信（私信）：一对一私聊，仿洛谷私信交互。
 * 会话由两人组成（conversations.user_a < user_b），消息挂在会话下。
 */
const { db } = require('./db');

const MAX_LEN = 2000;

function pair(a, b) { return a < b ? [a, b] : [b, a]; }

function getConversationId(a, b) {
  const [lo, hi] = pair(a, b);
  const row = db.prepare('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?').get(lo, hi);
  if (row) return row.id;
  const now = Date.now();
  const info = db.prepare('INSERT INTO conversations (user_a, user_b, last_at, created_at) VALUES (?, ?, ?, ?)').run(lo, hi, now, now);
  return Number(info.lastInsertRowid);
}

function briefUser(id) {
  const u = db.prepare('SELECT id, username, nickname, avatar, role, brown_name FROM users WHERE id = ?').get(id);
  if (!u) return { id, username: '(已注销)', nickname: '', avatar: '', role: 'user', brown_name: false };
  return { id: u.id, username: u.username, nickname: u.nickname || '', avatar: u.avatar || '', role: u.role, brown_name: !!u.brown_name };
}

/** 我的会话列表（按最后消息时间倒序），含对方信息、未读数与最后一条消息 */
function listConversations(userId) {
  const rows = db.prepare(`
    SELECT id, user_a, user_b, last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.is_read = 0) AS unread
    FROM conversations c
    WHERE c.user_a = ? OR c.user_b = ?
    ORDER BY c.last_at DESC
  `).all(userId, userId, userId);
  return rows.map((c) => {
    const otherId = c.user_a === userId ? c.user_b : c.user_a;
    const last = db.prepare('SELECT sender_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
    return {
      id: c.id,
      other: briefUser(otherId),
      unread: c.unread,
      last_message: last
        ? { mine: last.sender_id === userId, content: last.content, created_at: last.created_at }
        : null,
      last_at: c.last_at,
    };
  });
}

/** 未读私信总条数（用于铃铛旁红点） */
function unreadCount(userId) {
  const r = db.prepare(`
    SELECT COUNT(*) AS c FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.user_a = ? OR c.user_b = ?) AND m.sender_id != ? AND m.is_read = 0
  `).get(userId, userId, userId);
  return r.c;
}

/** 与某人的会话消息（取最近的 limit 条，按时间正序返回）；拉取即标记为已读 */
function getConversation(userId, otherId, before = 0, limit = 100) {
  otherId = parseInt(otherId, 10);
  if (!Number.isFinite(otherId) || otherId <= 0) return { error: '参数错误' };
  if (otherId === userId) return { error: '不能与自己聊天' };
  const [lo, hi] = pair(userId, otherId);
  const c = db.prepare('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?').get(lo, hi);
  if (!c) {
    return { conversation_id: null, other: briefUser(otherId), messages: [], unread: 0 };
  }
  db.prepare('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id = ? AND is_read = 0').run(c.id, otherId);
  const cap = Math.min(200, Math.max(1, parseInt(limit, 10) || 100));
  const msgs = db.prepare(`
    SELECT id, sender_id, content, created_at FROM messages
    WHERE conversation_id = ? AND id < ?
    ORDER BY id DESC LIMIT ?
  `).all(c.id, before > 0 ? before : Number.MAX_SAFE_INTEGER, cap).reverse();
  return {
    conversation_id: c.id,
    other: briefUser(otherId),
    messages: msgs.map((m) => ({ id: m.id, mine: m.sender_id === userId, sender_id: m.sender_id, content: m.content, created_at: m.created_at })),
    unread: 0,
  };
}

/** 发送私信（自动创建/复用会话） */
function send(userId, toId, content) {
  toId = parseInt(toId, 10);
  if (!Number.isFinite(toId) || toId <= 0) return { error: '接收人无效' };
  if (toId === userId) return { error: '不能给自己发送私信' };
  // 存储前清理：统一换行、多余空格折叠（含全角空格）、去行首行尾空白、压缩连续空行（聊天展示更干净）
  const text = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l
      .replace(/[\u3000\u00A0]+/g, ' ')   // 全角/不断行空格 → 半角
      .replace(/[ \t]+/g, ' ')             // 连续空格折叠为一个
      .replace(/^ +/, '')
      .replace(/ +$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return { error: '内容不能为空' };
  if (text.length > MAX_LEN) return { error: `内容过长（最多 ${MAX_LEN} 字）` };
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(toId);
  if (!target) return { error: '用户不存在' };
  const me = db.prepare('SELECT can_speak FROM users WHERE id = ?').get(userId);
  if (me && me.can_speak === 0) return { error: '你已被撤销自由发言权限' };
  const cid = getConversationId(userId, toId);
  const now = Date.now();
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_id, content, is_read, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(cid, userId, text, now);
  db.prepare('UPDATE conversations SET last_at = ? WHERE id = ?').run(now, cid);
  return {
    ok: true,
    conversation_id: cid,
    message: { id: Number(info.lastInsertRowid), mine: true, sender_id: userId, content: text, created_at: now },
  };
}

/** 用户查找（发私信前选人）：精确匹配 UID 或用户名 */
function lookupUser(q) {
  const s = String(q || '').trim();
  if (!s) return { error: '请输入对方 UID 或用户名' };
  const row = /^\d+$/.test(s)
    ? db.prepare('SELECT id, username, nickname, avatar, role, brown_name FROM users WHERE id = ?').get(parseInt(s, 10))
    : db.prepare('SELECT id, username, nickname, avatar, role, brown_name FROM users WHERE username = ?').get(s);
  if (!row) return { error: '用户不存在' };
  return { id: row.id, username: row.username, nickname: row.nickname || '', avatar: row.avatar || '', role: row.role, brown_name: !!row.brown_name };
}

module.exports = { listConversations, unreadCount, getConversation, send, lookupUser };
