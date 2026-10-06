'use strict';

const { db } = require('./db');
const { parsePagination } = require('./util');

const CATEGORY_ALIASES = {
  mention: 'mention', // 被@
  '@': 'mention',
  system: 'system',   // 系统
  reply: 'reply',     // 回复我的
  comment_reply: 'reply',
  editorial_reply: 'reply',
};

/** 创建通知；category 缺省时根据 type 推断（mention → 被@，reply* → 回复我的，其余为系统） */
function notify(userId, type, title, content = '', link = '', category = '') {
  if (!userId) return;
  let cat = CATEGORY_ALIASES[String(category).toLowerCase()];
  if (!cat) {
    cat = CATEGORY_ALIASES[String(type).toLowerCase()] || 'system';
  }
  db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, link, category, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(userId, type, title, content, link, cat, Date.now());
}

function unreadCount(userId) {
  if (!userId) return 0;
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).c;
}

function list(userId, query) {
  const { page, size, offset } = parsePagination(query, 15, 50);
  const category = CATEGORY_ALIASES[String(query.get('category') || '').toLowerCase()] || '';
  const where = ['user_id = ?'];
  const params = [userId];
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE ${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT id, type, title, content, link, category, is_read, created_at
    FROM notifications WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      category: r.category,
      title: r.title,
      content: r.content,
      link: r.link,
      is_read: !!r.is_read,
      created_at: r.created_at,
    })),
    total, page, size,
    unread: unreadCount(userId),
  };
}

function markRead(userId, id) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?').run(userId, id);
  return { ok: true };
}

function markAllRead(userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
  return { ok: true };
}

module.exports = { notify, unreadCount, list, markRead, markAllRead };
