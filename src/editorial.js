'use strict';

const { db } = require('./db');
const { markdownToHtml, linkifyTextNodes, stripControlChars } = require('./markdown');
const { parsePagination, escapeHtml } = require('./util');
// 文章分类已改为数据库配置表（v2.7.0 后台「板块与分类管理」），见 src/taxonomy.js
const taxonomy = require('./taxonomy');

const STATUS_LABEL = { draft: '草稿', pending: '待审核', approved: '已通过', rejected: '已驳回' };

/** 专栏文章分类（提交审核时必须选择；保存草稿可不选）。
 *  v2.7.0 起分类来自配置表 article_categories（后台可新增 / 改名 / 删除 / 调序），
 *  这里保留同名导出（值为加载时的 key 快照，兼容既有引用）；运行时校验一律走 isCategory()。 */
const CATEGORIES = taxonomy.categoryKeys();

function isCategory(c) {
  const s = String(c || '').trim();
  return !!s && taxonomy.categoryExists(s);
}

function likeCount(id) {
  return db.prepare('SELECT COUNT(*) AS c FROM editorial_likes WHERE editorial_id = ?').get(id).c;
}

function hasLiked(id, userId) {
  if (!userId) return false;
  return !!db.prepare('SELECT user_id FROM editorial_likes WHERE editorial_id = ? AND user_id = ?').get(id, userId);
}

function canView(editorial, viewer) {
  if (editorial.status === 'approved') return true;
  if (!viewer) return false;
  if (viewer.id === editorial.user_id) return true;
  return viewer.is_admin;
}

/** 题目下的题解列表：公开仅展示已通过；作者可见自己全部；管理员可见全部（草稿仅作者/管理员可见） */
function listEditorials(problemId, viewer) {
  let where = 'e.problem_id = ?';
  const params = [problemId];
  if (!viewer || !viewer.is_admin) {
    where += ' AND (e.status = ? OR e.user_id = ?)';
    params.push('approved', viewer ? viewer.id : -1);
  }
  const rows = db.prepare(`
    SELECT e.id, e.problem_id, e.user_id, e.title, e.status, e.category, e.created_at, e.updated_at, u.username,
      (SELECT COUNT(*) FROM editorial_likes l WHERE l.editorial_id = e.id) AS like_count,
      (SELECT COUNT(*) FROM editorial_comments c WHERE c.editorial_id = e.id) AS comment_count
    FROM editorials e JOIN users u ON u.id = e.user_id
    WHERE ${where} ORDER BY e.id DESC
  `).all(...params);
  return rows.map((r) => ({
    id: r.id,
    problem_id: r.problem_id,
    user_id: r.user_id,
    username: r.username,
    title: r.title,
    status: r.status,
    status_label: STATUS_LABEL[r.status] || r.status,
    category: r.category || '',
    like_count: r.like_count,
    comment_count: r.comment_count,
    liked: hasLiked(r.id, viewer && viewer.id),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/** 题目页仅展示点赞最高的 N 篇题解（同赞按时间先后），供列表页分页使用 */
function listTopEditorials(problemId, viewer, limit = 3) {
  const all = listEditorials(problemId, viewer).filter((e) => e.status === 'approved');
  return all
    .sort((a, b) => b.like_count - a.like_count || a.created_at - b.created_at)
    .slice(0, limit);
}

/** 题目题解列表（分页，用于独立列表页） */
function listEditorialsPaged(problemId, viewer, query) {
  const { page, size, offset } = parsePagination(query, 10, 50);
  const all = listEditorials(problemId, viewer).filter((e) => e.status === 'approved');
  const total = all.length;
  return { items: all.slice(offset, offset + size), total, page, size };
}

// ---------------- 题解评论区（类似讨论区） ----------------

/** 扫描 @uid 提及并发送通知 */
function notifyMentions(content, editorialId, commenterName) {
  const re = /@(\d{1,9})/g;
  let m;
  const notified = new Set();
  while ((m = re.exec(content)) !== null) {
    const uid = parseInt(m[1], 10);
    if (notified.has(uid)) continue;
    notified.add(uid);
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
    if (target) {
      const notifications = require('./notifications');
      notifications.notify(uid, 'mention', `${commenterName} 在题解评论中提到了你`,
        `题解评论：${String(content).slice(0, 80)}`, '/editorial/' + editorialId);
    }
  }
}

function listComments(editorialId, query = null) {
  const { page, size, offset } = parsePagination(query || {}, 10, 50);
  const total = db.prepare('SELECT COUNT(*) AS c FROM editorial_comments WHERE editorial_id = ?').get(editorialId).c;
  const rows = db.prepare(`
    SELECT c.id, c.user_id, c.content, c.created_at, u.username
    FROM editorial_comments c JOIN users u ON u.id = c.user_id
    WHERE c.editorial_id = ? ORDER BY c.id ASC LIMIT ? OFFSET ?
  `).all(editorialId, size, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      username: r.username,
      content: r.content,
      content_html: linkifyMentions(markdownToHtml(r.content)),
      created_at: r.created_at,
    })),
    total,
    page,
    size,
  };
}

/** 将渲染后 HTML 中的 @uid 转为用户名超链接（链接以 UID 为标识）。
 *  只遍历**文本节点**，不再改动 href / class / data-* 属性（L9）。 */
function linkifyMentions(html) {
  return linkifyTextNodes(html, (m, uid) => {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(parseInt(uid, 10));
    return u ? `<a href="#/user/${u.id}" style="font-weight:600;color:var(--accent)">@${escapeHtml(u.username)}</a>` : null;
  });
}

function createComment(editorialId, userId, content, commenterName) {
  const e = db.prepare('SELECT id, user_id, problem_id FROM editorials WHERE id = ?').get(editorialId);
  if (!e) return { error: '题解不存在' };
  const c = stripControlChars(String(content || '')).trim();
  if (!c) return { error: '评论内容不能为空' };
  if (c.length > 2000) return { error: '评论过长' };
  const info = db.prepare(
    'INSERT INTO editorial_comments (editorial_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(editorialId, userId, c, Date.now());
  notifyMentions(c, editorialId, commenterName);
  // 回复我的：评论者不是作者时通知作者
  if (e.user_id !== userId) {
    const notifications = require('./notifications');
    const t = db.prepare('SELECT title FROM editorials WHERE id = ?').get(editorialId);
    notifications.notify(e.user_id, 'reply', `${commenterName} 评论了你的${e.problem_id ? '题解' : '文章'}`,
      `《${t ? t.title : ''}》：${c.slice(0, 80)}`, '/editorial/' + editorialId);
  }
  return { id: Number(info.lastInsertRowid) };
}

function deleteComment(commentId, userId, isAdmin) {
  const row = db.prepare('SELECT id, user_id FROM editorial_comments WHERE id = ?').get(commentId);
  if (!row) return { error: '评论不存在' };
  if (!isAdmin && row.user_id !== userId) return { error: '无权删除他人评论' };
  db.prepare('DELETE FROM editorial_comments WHERE id = ?').run(commentId);
  return { ok: true };
}

function getEditorial(id, viewer) {
  const row = db.prepare(`
    SELECT e.*, u.username, p.title AS problem_title
    FROM editorials e JOIN users u ON u.id = e.user_id
    LEFT JOIN problems p ON p.id = e.problem_id
    WHERE e.id = ?
  `).get(id);
  if (!row) return null;
  if (!canView(row, viewer)) return { forbidden: true };
  return {
    id: row.id,
    problem_id: row.problem_id,
    problem_title: row.problem_title || '',
    is_article: !row.problem_id,
    user_id: row.user_id,
    username: row.username,
    title: row.title,
    content: row.content,
    content_html: markdownToHtml(row.content),
    status: row.status,
    status_label: STATUS_LABEL[row.status] || row.status,
    category: row.category || '',
    like_count: likeCount(id),
    liked: hasLiked(id, viewer && viewer.id),
    is_favorite: !!(viewer && require('./users').isFavorite(viewer.id, 'article', id)),
    is_owner: !!(viewer && viewer.id === row.user_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 校验并返回提交状态：submit=true → pending（必须选择有效分类，未分类不允许提交）；否则 → draft */
function resolveStatus(category, submit) {
  if (submit === true || submit === '1') {
    const cat = String(category || '').trim();
    if (!isCategory(cat) || cat === taxonomy.UNCATEGORIZED) return { error: '提交审核前请选择有效文章分类（不能为「未分类」）' };
    return { status: 'pending', category: cat };
  }
  return { status: 'draft', category: String(category || '').trim() };
}

/** 分类与关联题目互斥规则：分类「题解」必须关联题目；其它分类不得关联题目。
 *  注意：这里比较的是**内部 key**（taxonomy.SOLUTION_CATEGORY = 'solution'，显示名为「题解」），
 *  该 key 永远不变（后台不允许改名 / 删除它），因此题解流程不受分类改名影响。 */
function validateCategoryProblem(category, problemId) {
  const cat = String(category || '').trim();
  const hasProblem = !!(problemId && String(problemId).trim() && String(problemId).trim() !== '0');
  if (cat === taxonomy.SOLUTION_CATEGORY && !hasProblem) return { error: '分类「题解」必须关联题目（填写题目 ID）' };
  if (cat !== taxonomy.SOLUTION_CATEGORY && hasProblem) return { error: '只有「题解」分类可以关联题目' };
  return { ok: true };
}

function createEditorial(problemId, userId, title, content, category, submit) {
  const problem = db.prepare('SELECT id, editorial_closed FROM problems WHERE id = ?').get(problemId);
  if (!problem) return { error: '题目不存在' };
  if (problem.editorial_closed) return { error: '该题目的题解提交通道已关闭' };
  const t = stripControlChars(String(title || '')).trim();
  if (!t) return { error: '标题不能为空' };
  if (!String(content || '').trim()) return { error: '内容不能为空' };
  const rs = resolveStatus(category, submit);
  if (rs.error) return rs;
  // 关联题目的文章分类必须为「题解」
  if (rs.category && rs.category !== taxonomy.SOLUTION_CATEGORY) return { error: '关联题目的文章分类必须为「题解」' };
  const exists = db.prepare('SELECT id FROM editorials WHERE problem_id = ? AND user_id = ?').get(problemId, userId);
  if (exists) return { error: '你已发布过本题题解，请直接编辑' };
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO editorials (id, problem_id, user_id, title, content, status, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(require('./db').nextFreeId('editorials'), problemId, userId, t, stripControlChars(String(content)), rs.status, rs.category, now, now);
  return { id: Number(info.lastInsertRowid), status: rs.status };
}

/** 发布专栏文章（默认不关联题目；分类「题解」时必须关联题目，其它分类不得关联） */
function createArticle(userId, title, content, category, submit, problemId) {
  const t = stripControlChars(String(title || '')).trim();
  if (!t) return { error: '标题不能为空' };
  if (!String(content || '').trim()) return { error: '内容不能为空' };
  const rs = resolveStatus(category, submit);
  if (rs.error) return rs;
  let pid = null;
  if (problemId && String(problemId).trim() && String(problemId).trim() !== '0') {
    pid = parseInt(problemId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return { error: '关联题目 ID 无效' };
    const p = db.prepare('SELECT id, editorial_closed FROM problems WHERE id = ?').get(pid);
    if (!p) return { error: '关联题目不存在' };
    if (p.editorial_closed) return { error: '该题目的题解提交通道已关闭' };
    const dup = db.prepare('SELECT id FROM editorials WHERE problem_id = ? AND user_id = ?').get(pid, userId);
    if (dup) return { error: '你已发布过该题的题解，请直接编辑' };
  }
  const vp = validateCategoryProblem(rs.category, pid);
  if (vp.error) return vp;
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO editorials (id, problem_id, user_id, title, content, status, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(require('./db').nextFreeId('editorials'), pid, userId, t, stripControlChars(String(content)), rs.status, rs.category, now, now);
  return { id: Number(info.lastInsertRowid), status: rs.status };
}

/** 题解与专栏：全站最新文章/题解（公开仅展示已通过；作者可见自己除草稿外全部；管理员可见全部非草稿） */
function listArticles(query, viewer) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  let where = "e.status != 'draft'";
  const params = [];
  // 分类筛选（题解与专栏页）
  const cat = (query.get('category') || '').trim();
  if (cat) {
    where += ' AND e.category = ?';
    params.push(cat);
  }
  if (!viewer || !viewer.is_admin) {
    where += ' AND (e.status = ? OR e.user_id = ?)';
    params.push('approved', viewer ? viewer.id : -1);
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM editorials e WHERE ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT e.id, e.problem_id, e.user_id, e.title, e.status, e.category, e.created_at, u.username, p.title AS problem_title,
      (SELECT COUNT(*) FROM editorial_likes l WHERE l.editorial_id = e.id) AS like_count,
      (SELECT COUNT(*) FROM editorial_comments c WHERE c.editorial_id = e.id) AS comment_count
    FROM editorials e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN problems p ON p.id = e.problem_id
    WHERE ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      problem_id: r.problem_id,
      problem_title: r.problem_title || '',
      is_article: !r.problem_id,
      user_id: r.user_id,
      username: r.username,
      title: r.title,
      status: r.status,
      status_label: STATUS_LABEL[r.status] || r.status,
      category: r.category || '',
      like_count: r.like_count,
      comment_count: r.comment_count,
      created_at: r.created_at,
    })),
    total, page, size,
  };
}

function updateEditorial(id, userId, isAdmin, title, content, category, submit, problemId) {
  const row = db.prepare('SELECT id, user_id, status, problem_id FROM editorials WHERE id = ?').get(id);
  if (!row) return { error: '题解不存在' };
  if (!isAdmin && row.user_id !== userId) return { error: '无权修改他人题解' };
  const t = stripControlChars(String(title || '')).trim();
  if (!t) return { error: '标题不能为空' };
  if (!String(content || '').trim()) return { error: '内容不能为空' };
  const rs = resolveStatus(category, submit);
  if (rs.error) return rs;
  // 关联题目：仅在请求中显式给出时才变更（'' / null / 0 表示清除关联，成为独立专栏文章）
  let newPid = row.problem_id;
  if (problemId !== undefined) {
    const raw = String(problemId == null ? '' : problemId).trim();
    if (raw === '' || raw === '0') {
      newPid = null;
    } else {
      newPid = parseInt(raw, 10);
      if (!Number.isFinite(newPid) || newPid <= 0) return { error: '关联题目 ID 无效' };
      const p = db.prepare('SELECT id, editorial_closed FROM problems WHERE id = ?').get(newPid);
      if (!p) return { error: '关联题目不存在' };
      if (p.editorial_closed) return { error: '该题目的题解提交通道已关闭' };
      const dup = db.prepare('SELECT id FROM editorials WHERE problem_id = ? AND user_id = ? AND id != ?').get(newPid, userId, id);
      if (dup) return { error: '你已发布过该题的题解，请直接编辑' };
    }
  }
  // 分类与关联题目互斥规则
  const vp = validateCategoryProblem(rs.category, newPid);
  if (vp.error) return vp;
  // 作者修改后重新进入待审核/草稿；管理员修改保持原状态（仅更新分类）
  const nextStatus = isAdmin ? row.status : rs.status;
  db.prepare('UPDATE editorials SET title = ?, content = ?, status = ?, category = ?, problem_id = ?, updated_at = ? WHERE id = ?')
    .run(t, stripControlChars(String(content)), nextStatus, rs.category, newPid, Date.now(), id);
  return { id: Number(id), status: nextStatus };
}

function deleteEditorial(id, userId, isAdmin) {
  const row = db.prepare('SELECT id, user_id FROM editorials WHERE id = ?').get(id);
  if (!row) return { error: '题解不存在' };
  if (!isAdmin && row.user_id !== userId) return { error: '无权删除他人题解' };
  db.prepare('DELETE FROM editorials WHERE id = ?').run(id);
  // L12：收藏表没有外键，删除题解/文章后按 (item_type,item_id) 清理，避免残留收藏行串到新文章
  try { db.prepare("DELETE FROM favorites WHERE item_type = 'article' AND item_id = ?").run(id); } catch { /* ignore */ }
  return { id: Number(id) };
}

function toggleLike(id, userId) {
  const row = db.prepare('SELECT id FROM editorials WHERE id = ?').get(id);
  if (!row) return { error: '题解不存在' };
  const existing = db.prepare('SELECT user_id FROM editorial_likes WHERE editorial_id = ? AND user_id = ?').get(id, userId);
  if (existing) {
    db.prepare('DELETE FROM editorial_likes WHERE editorial_id = ? AND user_id = ?').run(id, userId);
  } else {
    db.prepare('INSERT INTO editorial_likes (editorial_id, user_id, created_at) VALUES (?, ?, ?)').run(id, userId, Date.now());
  }
  return { id: Number(id), liked: !existing, like_count: likeCount(id) };
}

/** 管理员审核：通过 / 驳回（驳回需填写原因）；草稿不可审核；已通过/已驳回均可再次操作（允许重复审核） */
function reviewEditorial(id, admin, status, reason) {
  if (!admin.is_admin) return { error: '需要管理员权限' };
  const row = db.prepare('SELECT id, user_id, title, status, problem_id FROM editorials WHERE id = ?').get(id);
  if (!row) return { error: '题解不存在' };
  if (!['approved', 'rejected'].includes(status)) return { error: '无效的审核状态' };
  if (row.status === 'draft') return { error: '草稿不能审核，请作者先提交审核' };
  if (row.status === status) return { error: `已是「${STATUS_LABEL[status]}」状态` };
  if (status === 'rejected' && !String(reason || '').trim()) return { error: '驳回需填写原因' };
  db.prepare('UPDATE editorials SET status = ? WHERE id = ?').run(status, id);
  // 通知作者（题目关联的题解以 #N 为基准，专栏文章直接引用标题）
  const notifications = require('./notifications');
  const approved = status === 'approved';
  const reasonText = status === 'rejected' ? `，原因：${String(reason).trim()}` : '';
  const kind = row.problem_id ? `题目 #${row.problem_id}` : '专栏文章';
  notifications.notify(row.user_id, 'editorial', approved ? '题解已通过审核' : '题解未通过审核',
    `你的《${row.title}》（${kind}）已被管理员 ${admin.username} ${approved ? '通过审核' : '驳回'}${reasonText}`,
    '/editorial/' + id);
  return { id: Number(id), status };
}

/** 管理端题解/专栏列表（可按状态筛选；草稿不参与审核；kind=article 只看专栏、editorial 只看题解）。
 *  v2.7.0：专栏与题解**严格互不混入** —— kind=article 在「未关联题目」之外再排除分类「题解」，
 *  题解（kind=editorial）仍旧只看关联了题目的文章；两边口径独立，total 与分页用同一份 conds。 */
function listAllEditorials(query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const status = (query.get('status') || '').trim();
  const kind = (query.get('kind') || '').trim();
  const search = (query.get('search') || '').trim();
  const category = (query.get('category') || '').trim();
  const problemId = parseInt(query.get('problem') || '0', 10);
  const conds = ["e.status != 'draft'"];
  const params = [];
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    conds.push('e.status = ?');
    params.push(status);
  }
  // 专栏管理：未关联题目 + 排除系统分类「题解」（内部 key = taxonomy.SOLUTION_CATEGORY = 'solution'，
  // 显示名仍是「题解」；该分类只属于题解管理页）
  if (kind === 'article') {
    conds.push('e.problem_id IS NULL');
    conds.push('e.category != ?');
    params.push(taxonomy.SOLUTION_CATEGORY);
  } else if (kind === 'editorial') conds.push('e.problem_id IS NOT NULL');
  if (category) { conds.push('e.category = ?'); params.push(category); }
  if (problemId > 0) { conds.push('e.problem_id = ?'); params.push(problemId); }
  if (search) {
    // 按标题 / 作者名 / 作者 ID / 题目 ID 搜索
    conds.push('(e.title LIKE ? OR u.username LIKE ? OR e.user_id = ? OR e.problem_id = ?)');
    params.push(`%${search}%`, `%${search}%`, parseInt(search, 10) || -1, parseInt(search, 10) || -1);
  }
  const where = 'WHERE ' + conds.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM editorials e JOIN users u ON u.id = e.user_id ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT e.id, e.problem_id, p.title AS problem_title, e.user_id, u.username, e.title, e.status, e.category, e.created_at
    FROM editorials e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN problems p ON p.id = e.problem_id
    ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      problem_id: r.problem_id,
      problem_title: r.problem_title || '',
      is_article: !r.problem_id,
      user_id: r.user_id,
      username: r.username,
      title: r.title,
      status: r.status,
      status_label: STATUS_LABEL[r.status] || r.status,
      category: r.category || '',
      created_at: r.created_at,
    })),
    total, page, size,
  };
}

/** 下一篇待审核文章（同类型：专栏/题解），用于审核后自动跳转；无则返回 null。
 *  专栏侧与列表口径一致：排除系统分类「题解」，避免跳到题解管理页的内容。 */
function nextPendingId(kind, afterId) {
  const after = parseInt(afterId, 10) || 0;
  if (kind === 'article') {
    const row = db.prepare("SELECT id FROM editorials e WHERE e.status = 'pending' AND e.problem_id IS NULL AND e.category != ? AND e.id > ? ORDER BY e.id ASC LIMIT 1").get(taxonomy.SOLUTION_CATEGORY, after);
    return row ? row.id : null;
  }
  const kindCond = kind === 'editorial' ? "AND e.problem_id IS NOT NULL" : '';
  const row = db.prepare(`SELECT id FROM editorials e WHERE e.status = 'pending' ${kindCond} AND e.id > ? ORDER BY e.id ASC LIMIT 1`).get(after);
  return row ? row.id : null;
}

module.exports = {
  STATUS_LABEL,
  CATEGORIES,
  listEditorials,
  listTopEditorials,
  listEditorialsPaged,
  getEditorial,
  createEditorial,
  createArticle,
  listArticles,
  updateEditorial,
  deleteEditorial,
  toggleLike,
  reviewEditorial,
  listAllEditorials,
  nextPendingId,
  listComments,
  createComment,
  deleteComment,
};
