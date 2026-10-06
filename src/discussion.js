'use strict';

const { db } = require('./db');
const { markdownToHtml, linkifyTextNodes, stripControlChars } = require('./markdown');
const { parsePagination, escapeHtml } = require('./util');
// 板块白名单已改为数据库配置表（v2.7.0 后台「板块与分类管理」），见 src/taxonomy.js
const taxonomy = require('./taxonomy');

/** 将渲染后 HTML 中的 @uid 转为用户名超链接（链接以 UID 为标识）。
 *  只遍历**文本节点**：href / class / data-* 等属性，以及 <a>/<code>/<pre> 内部一律不动
 *  （旧实现直接对 HTML 正则替换，会把 <a> 片段塞进 href、代码块 class 与公式 data-latex 里）。 */
function linkifyMentions(html) {
  return linkifyTextNodes(html, (m, uid) => {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(parseInt(uid, 10));
    return u ? `<a href="#/user/${u.id}" style="font-weight:600;color:var(--accent)">@${escapeHtml(u.username)}</a>` : null;
  });
}

function listDiscussions(query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const problemId = parseInt(query.get('problem') || '0', 10);
  const board = (query.get('board') || '').trim();
  const where = ['1=1'];
  const params = [];
  if (problemId > 0) {
    // 按具体题目筛选：只看该题的讨论（不再叠加板块默认条件）
    where.push('d.problem_id = ?'); params.push(problemId);
  } else if (board) {
    // 指定板块：题目总版只显示不关联具体题目的帖（各题讨论通过输入题号进入）；
    // 其余板块同样排除关联具体题目的帖（它们统一归入题目总版）。
    // v2.7.0：板块改为配置表后不再写死白名单 —— 任何后台新建的板块 key 都能正常筛选。
    where.push('d.board = ?'); params.push(board);
    where.push('d.problem_id IS NULL');
  } else {
    // 全部板块：显示所有帖文（含题目分板块内容）
  }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM discussions d WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = db.prepare(`
    SELECT d.*, u.username, p.title AS problem_title,
      (SELECT COUNT(*) FROM discussion_replies r WHERE r.discussion_id = d.id) AS reply_count
    FROM discussions d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN problems p ON p.id = d.problem_id
    WHERE ${where.join(' AND ')}
    ORDER BY d.pinned DESC, d.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);

  return {
    items: rows.map((r) => ({
      id: r.id,
      problem_id: r.problem_id,
      problem_title: r.problem_title,
      user_id: r.user_id,
      username: r.username,
      title: r.title,
      board: r.board,
      pinned: !!r.pinned,
      reply_count: r.reply_count,
      created_at: r.created_at,
    })),
    total, page, size,
  };
}

/** 首页展示：置顶讨论 + 最近讨论 */
function listHomeDiscussions(limit = 6) {
  const rows = db.prepare(`
    SELECT d.*, u.username, p.title AS problem_title,
      (SELECT COUNT(*) FROM discussion_replies r WHERE r.discussion_id = d.id) AS reply_count
    FROM discussions d JOIN users u ON u.id = d.user_id
    LEFT JOIN problems p ON p.id = d.problem_id
    ORDER BY d.pinned DESC, d.id DESC LIMIT ?
  `).all(limit);
  return rows.map((r) => ({
    id: r.id,
    problem_id: r.problem_id,
    problem_title: r.problem_title,
    username: r.username,
    title: r.title,
    board: r.board,
    pinned: !!r.pinned,
    reply_count: r.reply_count,
    created_at: r.created_at,
  }));
}

/** 置顶 / 取消置顶（仅超级管理员） */
function pinDiscussion(id, actor, pinned) {
  if (!actor.is_superadmin) return { error: '仅超级管理员可置顶讨论' };
  const row = db.prepare('SELECT id FROM discussions WHERE id = ?').get(id);
  if (!row) return { error: '讨论不存在' };
  db.prepare('UPDATE discussions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  return { ok: true };
}

function createDiscussion(userId, title, content, username) {
  const t = stripControlChars(String(title || '')).trim();
  if (!t) return { error: '标题不能为空' };
  if (!String(content || '').trim()) return { error: '内容不能为空' };
  // 入库前剥离 C0 控制字符（H7：\u0001javascript: 这类载荷不得落库；渲染层同样会剥离）
  const body = stripControlChars(String(content));
  const info = db.prepare(
    'INSERT INTO discussions (id, problem_id, user_id, title, content, created_at) VALUES (?, NULL, ?, ?, ?, ?)'
  ).run(require('./db').nextFreeId('discussions'), userId, t, body, Date.now());
  notifyMentions(body, Number(info.lastInsertRowid), username, 'discussion');
  return { id: Number(info.lastInsertRowid) };
}

/** 扫描 @uid 并通知被提及用户 */
function notifyMentions(content, linkId, commenterName, kind) {
  const re = /@(\d{1,9})/g;
  let m;
  const seen = new Set();
  const notifications = require('./notifications');
  while ((m = re.exec(content)) !== null) {
    const uid = parseInt(m[1], 10);
    if (seen.has(uid)) continue;
    seen.add(uid);
    if (db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) {
      notifications.notify(uid, 'mention', `${commenterName} 在${kind === 'discussion' ? '讨论' : '回复'}中提到了你`,
        String(content).slice(0, 80), `/discussion/${linkId}`);
    }
  }
}

function createDiscussionWithProblem(userId, problemId, title, content, username, board, isAdmin) {
  const t = stripControlChars(String(title || '')).trim();
  if (!t) return { error: '标题不能为空' };
  if (!String(content || '').trim()) return { error: '内容不能为空' };
  const body = stripControlChars(String(content));
  const pid = parseInt(problemId || '0', 10) || null;
  // 板块 key 一律以配置表 discussion_boards 为准（管理员可新增 / 改名 / 调序，见 src/taxonomy.js）：
  // 这里只校验「这个 key 是否存在」，不再维护代码里的固定白名单；
  // 「题目总版(problem) / 站务版(site)」这两个被既有逻辑引用的 key 保持原语义（改名不影响 key）。
  const want = String(board || '').trim();
  let b;
  if (pid) {
    // 关联具体题目的讨论统一归入题目总版；若该板块已被删除，退回系统兜底板块，避免写入孤立 key
    b = taxonomy.boardExists('problem') ? 'problem' : taxonomy.defaultBoardKey();
  } else if (want === 'site' && taxonomy.boardExists('site')) {
    if (!isAdmin) return { error: '站务版仅管理员可发帖' };
    b = 'site';
  } else if (want && taxonomy.boardExists(want)) {
    b = want;
  } else {
    b = taxonomy.defaultBoardKey();
  }
  if (!b) return { error: '站点尚未配置任何讨论板块，请联系管理员在后台添加' };
  const info = db.prepare(
    'INSERT INTO discussions (id, problem_id, user_id, title, content, pinned, board, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
  ).run(require('./db').nextFreeId('discussions'), pid, userId, t, body, b, Date.now());
  notifyMentions(body, Number(info.lastInsertRowid), username, 'discussion');
  return { id: Number(info.lastInsertRowid) };
}

/** 管理员（具备讨论管理权限）编辑讨论：标题 / 内容 / 板块 */
function updateDiscussion(id, data) {
  const row = db.prepare('SELECT id, board FROM discussions WHERE id = ?').get(id);
  if (!row) return { error: '讨论不存在' };
  const title = stripControlChars(String(data.title || '')).trim();
  if (!title) return { error: '标题不能为空' };
  // 板块以配置表为准（key 存在即接受）；非法 / 缺失时保留该讨论原有板块，不再静默改成默认板块
  const want = String(data.board || '').trim();
  const board = taxonomy.boardExists(want) ? want : (row.board || taxonomy.defaultBoardKey());
  db.prepare('UPDATE discussions SET title = ?, content = ?, board = ? WHERE id = ?')
    .run(title, stripControlChars(String(data.content || '')), board, id);
  return { ok: true };
}

function getDiscussion(id, query = null) {
  const row = db.prepare(`
    SELECT d.*, u.username, p.title AS problem_title
    FROM discussions d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN problems p ON p.id = d.problem_id
    WHERE d.id = ?
  `).get(id);
  if (!row) return null;
  // 回复分页：默认每页 10 条
  const { page, size, offset } = parsePagination(query || {}, 10, 50);
  const total = db.prepare('SELECT COUNT(*) AS c FROM discussion_replies WHERE discussion_id = ?').get(id).c;
  const replies = db.prepare(`
    SELECT r.*, u.username FROM discussion_replies r
    JOIN users u ON u.id = r.user_id
    WHERE r.discussion_id = ? ORDER BY r.id ASC LIMIT ? OFFSET ?
  `).all(id, size, offset);
  return {
    id: row.id,
    problem_id: row.problem_id,
    problem_title: row.problem_title,
    user_id: row.user_id,
    username: row.username,
    title: row.title,
    board: row.board,
    pinned: !!row.pinned,
    content: row.content,
    content_html: linkifyMentions(markdownToHtml(row.content)),
    created_at: row.created_at,
    replies: replies.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      username: r.username,
      content: r.content,
      content_html: linkifyMentions(markdownToHtml(r.content)),
      created_at: r.created_at,
    })),
    reply_total: total,
    reply_page: page,
    reply_size: size,
  };
}

function createReply(userId, discussionId, content, username) {
  const d = db.prepare('SELECT id, user_id, title FROM discussions WHERE id = ?').get(discussionId);
  if (!d) return { error: '讨论不存在' };
  if (!String(content || '').trim()) return { error: '内容不能为空' };
  const body = stripControlChars(String(content));
  const info = db.prepare(
    'INSERT INTO discussion_replies (discussion_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(discussionId, userId, body, Date.now());
  notifyMentions(body, discussionId, username, 'reply');
  // 回复我的：回复者不是楼主时通知楼主
  if (d.user_id !== userId) {
    const notifications = require('./notifications');
    notifications.notify(d.user_id, 'reply', `${username} 回复了你的讨论`,
      `《${d.title}》：${body.slice(0, 80)}`, '/discussion/' + discussionId);
  }
  return { id: Number(info.lastInsertRowid) };
}

function deleteDiscussion(id, userId, isAdmin) {
  const row = db.prepare('SELECT id, user_id FROM discussions WHERE id = ?').get(id);
  if (!row) return { error: '讨论不存在' };
  if (!isAdmin && row.user_id !== userId) return { error: '无权删除他人讨论' };
  db.prepare('DELETE FROM discussions WHERE id = ?').run(id);
  // L12：收藏表没有外键，删除讨论后必须按 (item_type,item_id) 清理，避免残留行在编号复用后「串号」
  try { db.prepare("DELETE FROM favorites WHERE item_type = 'discussion' AND item_id = ?").run(id); } catch { /* 表结构异常时不影响删除 */ }
  return { ok: true };
}

function deleteReply(replyId, userId, isAdmin) {
  const row = db.prepare('SELECT id, user_id FROM discussion_replies WHERE id = ?').get(replyId);
  if (!row) return { error: '回复不存在' };
  if (!isAdmin && row.user_id !== userId) return { error: '无权删除他人回复' };
  db.prepare('DELETE FROM discussion_replies WHERE id = ?').run(replyId);
  return { ok: true };
}

/** 管理端讨论列表（分页） */
/** 管理端讨论列表（分页，支持标题/作者搜索） */
function listAllDiscussions(query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const search = (query.get('search') || '').trim();
  const board = (query.get('board') || '').trim();
  const where = ['1=1'];
  const params = [];
  if (search) {
    // 支持按标题、作者名、作者 ID、题目 ID 搜索
    where.push('(d.title LIKE ? OR u.username LIKE ? OR d.user_id = ? OR d.problem_id = ?)');
    params.push(`%${search}%`, `%${search}%`, parseInt(search, 10) || -1, parseInt(search, 10) || -1);
  }
  if (board) { where.push('d.board = ?'); params.push(board); }
  const problemId = parseInt(query.get('problem') || '0', 10);
  if (problemId > 0) { where.push('d.problem_id = ?'); params.push(problemId); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS c FROM discussions d JOIN users u ON u.id = d.user_id ${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT d.*, u.username, p.title AS problem_title,
      (SELECT COUNT(*) FROM discussion_replies r WHERE r.discussion_id = d.id) AS reply_count
    FROM discussions d JOIN users u ON u.id = d.user_id
    LEFT JOIN problems p ON p.id = d.problem_id
    ${whereSql}
    ORDER BY d.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      username: r.username,
      title: r.title,
      board: r.board,
      problem_id: r.problem_id,
      problem_title: r.problem_title,
      reply_count: r.reply_count,
      created_at: r.created_at,
    })),
    total, page, size,
  };
}

/** 管理端评论列表（分页） */
function listAllReplies(query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const total = db.prepare('SELECT COUNT(*) AS c FROM discussion_replies').get().c;
  const rows = db.prepare(`
    SELECT r.id, r.discussion_id, r.user_id, r.content, r.created_at, u.username, d.title AS discussion_title
    FROM discussion_replies r JOIN users u ON u.id = r.user_id
    JOIN discussions d ON d.id = r.discussion_id
    ORDER BY r.id DESC LIMIT ? OFFSET ?
  `).all(size, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      discussion_id: r.discussion_id,
      discussion_title: r.discussion_title,
      user_id: r.user_id,
      username: r.username,
      content: r.content.slice(0, 120),
      created_at: r.created_at,
    })),
    total, page, size,
  };
}

module.exports = {
  listDiscussions, createDiscussion, createDiscussionWithProblem, getDiscussion, createReply,
  deleteDiscussion, deleteReply, listAllDiscussions, listAllReplies,
  pinDiscussion, updateDiscussion, listHomeDiscussions,
};
