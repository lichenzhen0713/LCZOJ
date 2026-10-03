'use strict';

const { db, nextFreeId } = require('./db');
const { parsePagination } = require('./util');
const { hashPassword, verifyPassword } = require('./password');
const { hasPerm } = require('./auth');
const { markdownToHtml } = require('./markdown');
const notifications = require('./notifications');

/** 按用户名或 UID 查找用户（标识统一为 uid，兼容用户名） */
function getProfile(ident, viewer) {
  // 个人中心统一以 UID 为标识，不再支持用户名访问
  const idNum = parseInt(String(ident || '').trim(), 10);
  const u0 = Number.isFinite(idNum) && idNum > 0 ? db.prepare('SELECT * FROM users WHERE id = ?').get(idNum) : null;
  if (!u0) return null;
  checkUserExpiry(u0.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(u0.id);
  const settings = require('./settings');
  const pointsEnabled = settings.getSetting('points_enabled', '1') === '1';
  // 练习统计仅计题库提交（contest_id IS NULL）：赛时提交与题库完全独立
  const solved = db.prepare(
    "SELECT COUNT(DISTINCT problem_id) AS c FROM submissions WHERE user_id = ? AND verdict = 'Accepted' AND contest_id IS NULL"
  ).get(u.id).c;
  const submits = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE user_id = ? AND contest_id IS NULL').get(u.id).c;
  const ac = db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE user_id = ? AND verdict = 'Accepted' AND contest_id IS NULL").get(u.id).c;

  const recent = db.prepare(`
    SELECT s.id, s.problem_id, p.title AS problem_title, s.verdict, s.score, s.language, s.created_at
    FROM submissions s JOIN problems p ON p.id = s.problem_id
    WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 10
  `).all(u.id);

  const solvedProblems = db.prepare(`
    SELECT DISTINCT p.id, p.title, p.difficulty FROM submissions s
    JOIN problems p ON p.id = s.problem_id
    WHERE s.user_id = ? AND s.verdict = 'Accepted' AND s.contest_id IS NULL ORDER BY p.id ASC
  `).all(u.id);

  // 尝试过的题目（全部：含已通过与未通过），带是否通过标记与尝试次数；仅计题库提交
  const attemptedProblems = db.prepare(`
    SELECT p.id, p.title, p.difficulty,
      EXISTS(SELECT 1 FROM submissions s2 WHERE s2.user_id = s.user_id AND s2.problem_id = s.problem_id AND s2.verdict = 'Accepted' AND s2.contest_id IS NULL) AS ac,
      (SELECT COUNT(*) FROM submissions s2 WHERE s2.user_id = s.user_id AND s2.problem_id = s.problem_id AND s2.contest_id IS NULL) AS attempt_count
    FROM submissions s JOIN problems p ON p.id = s.problem_id
    WHERE s.user_id = ? AND s.contest_id IS NULL GROUP BY p.id ORDER BY p.id ASC
  `).all(u.id);

  const favoriteCount = db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?').get(u.id).c;

  const pts = pointsEnabled ? computePoints(u.id) : null;
  return {
    uid: u.id,
    id: u.id,
    username: u.username,
    avatar: u.avatar || '',
    bio: u.bio,
    bio_html: markdownToHtml(u.bio || ''),
    role: u.role || 'user',
    banned: !!u.banned,
    rating: u.rating || 0,
    rated_games: u.rated_games || 0,
    brown_name: !!u.brown_name,
    brown_name_until: u.brown_name_until || 0,
    brown_type: u.brown_type || '',
    created_at: u.created_at,
    is_self: !!(viewer && viewer.id === u.id),
    username_changes: u.username_changes || 0,
    username_changed_at: u.username_changed_at || 0,
    points: pts,
    points_rank: pointsEnabled ? getPointsRankOf(u.id) : null,
    points_enabled: pointsEnabled,
    stats: {
      solved,
      submits,
      accepted: ac,
      ac_rate: submits > 0 ? ((ac / submits) * 100).toFixed(1) + '%' : '0%',
    },
    recent_submissions: recent,
    solved_problems: solvedProblems,
    attempted_problems: attemptedProblems,
    favorite_count: favoriteCount,
  };
}

/** 全站积分排名（1-based；竞赛排名：积分相同并列，如 1,1,3） */
function getPointsRankOf(userId) {
  const mine = computePoints(userId).total;
  const all = db.prepare('SELECT id FROM users').all();
  let rank = 1;
  for (const r of all) {
    if (r.id === userId) continue;
    const p = computePoints(r.id).total;
    if (p > mine) rank++;
  }
  return rank;
}

/** 积分系统（四维：基础/练习/比赛/社区；基础满分 100、其余三项满分 100，总分上限 400）。
 *  计算规格见 docs/CUSTOMIZATION.md「积分系统」章节。二次开发可直接修改本函数。
 *  各维度均带衰减：长时间不活跃不会归零（练习/比赛保留 10%，社区保留 20%）。 */
function computePoints(userId) {
  const now = Date.now();
  const DAY = 86400000;

  // ============ 一、基础分（默认 100，扣分不随时间恢复，仅随禁用权利恢复） ============
  let base = 100;
  const u = db.prepare('SELECT banned, banned_until, can_speak, can_speak_until, can_editorial, can_editorial_until, brown_type FROM users WHERE id = ?').get(userId);
  // 作弊级别（brown_type：plagiarism=抄题解、cheat=比赛作弊）→ 基础分 -50
  if (u && u.brown_type) base -= 50;
  // 封禁 → 基础分 0
  if (u && u.banned) base = 0;
  // 权利禁用恢复：每项禁用 -20；恢复速度 90 天恢复 50%、一年恢复 93%（线性插值）
  if (u && base > 0) {
    const disabled = [];
    if (!u.can_speak) disabled.push({ until: u.can_speak_until, revokeAt: null });
    if (!u.can_editorial) disabled.push({ until: u.can_editorial_until, revokeAt: null });
    // 从日志找撤销时间
    const logs = db.prepare(`
      SELECT action, created_at FROM moderation_logs
      WHERE user_id = ? AND action IN ('revoke_speak', 'revoke_editorial', 'ban')
      ORDER BY created_at ASC
    `).all(userId);
    const revokeTimes = {};
    for (const l of logs) revokeTimes[l.action] = l.created_at;
    for (const d of disabled) d.revokeAt = revokeTimes[d.until === u.can_speak_until ? 'revoke_speak' : 'revoke_editorial'] || null;
    for (const d of disabled) {
      const penalty = 20;
      const revokedAt = d.revokeAt || now - 30 * DAY;
      const elapsed = Math.max(0, (now - revokedAt) / DAY);
      // 恢复进度：90 天 → 50%，365 天 → 93%（线性插值）
      let recovered;
      if (elapsed <= 90) recovered = 0.5 * (elapsed / 90);
      else if (elapsed <= 365) recovered = 0.5 + (0.93 - 0.5) * ((elapsed - 90) / (365 - 90));
      else recovered = 0.93;
      base -= Math.round(penalty * (1 - Math.min(1, recovered)));
    }
    base = Math.max(0, base);
  }

  // ============ 二、练习分（满分 100；仅计题库提交，赛时提交不计入） ============
  // 输入：总解题数、连续刷题天数、近7天解题数、平均难度
  const allAcs = db.prepare("SELECT problem_id, created_at FROM submissions WHERE user_id = ? AND verdict = 'Accepted' AND contest_id IS NULL GROUP BY problem_id").all(userId);
  const totalSolved = allAcs.length;
  const recent7 = allAcs.filter((a) => now - a.created_at <= 7 * DAY).length;
  // 连续刷题天数：从今天往前数，每天至少 1 道 AC
  let continuousDays = 0;
  const acSet = new Set(allAcs.map((a) => new Date(a.created_at).toISOString().slice(0, 10)));
  {
    let d = new Date();
    for (let i = 0; i < 3650; i++) {
      const key = d.toISOString().slice(0, 10);
      if (acSet.has(key)) { continuousDays++; d = new Date(d.getTime() - DAY); }
      else break;
    }
  }
  // 平均难度（近 7 天解题的平均难度系数；difficulty 4 视为 1.0）
  const recentSubs = db.prepare(`
    SELECT p.difficulty FROM submissions s JOIN problems p ON p.id = s.problem_id
    WHERE s.user_id = ? AND s.verdict = 'Accepted' AND s.created_at >= ? AND s.contest_id IS NULL
  `).all(userId, now - 7 * DAY);
  const diffMap = { 1: 0.4, 2: 0.6, 3: 0.8, 4: 1.0, 5: 1.2, 6: 1.5, 7: 2.0 };
  let avgDiffFactor = 1.0;
  if (recentSubs.length) {
    let sum = 0;
    for (const r of recentSubs) sum += diffMap[r.difficulty] != null ? diffMap[r.difficulty] : 1.0;
    avgDiffFactor = sum / recentSubs.length;
  }
  // 1. 基础刷题分（对数边际递减）
  let basePractice = 0;
  for (let i = 1; i <= totalSolved; i++) basePractice += 1 / (1 + 0.05 * (i - 1));
  basePractice = Math.min(basePractice, 100);
  // 2. 连续性系数（S 型，半衰期 14 天）
  const continuity = continuousDays === 0 ? 0.5 : 0.5 + 0.5 * (1 - Math.exp(-continuousDays / 14));
  // 4. 难度惩罚（平均难度 < 1.0 打折）
  const difficultyPenalty = Math.min(1.0, avgDiffFactor / 1.0);
  let practice = basePractice * continuity * difficultyPenalty;
  // 3. 衰减：近 7 天解题数为 0 开始衰减（2 周宽限，S 型，最高扣 85%）
  if (recent7 === 0 && totalSolved > 0) {
    const lastAc = allAcs.reduce((m, a) => (a.created_at > m ? a.created_at : m), 0);
    const inactiveWeeks = Math.max(0, (now - lastAc) / DAY / 7);
    if (inactiveWeeks > 2) {
      const decay = Math.min(1 - 1 / (1 + Math.exp(inactiveWeeks - 4)), 0.85);
      practice = practice * (1 - decay);
    }
  }
  practice = Math.min(practice, 100);
  // 长期不活跃：保留最低 10%
  const longIdlePractice = (now - (allAcs.reduce((m, a) => (a.created_at > m ? a.created_at : m), 0) || now)) / DAY;
  if (longIdlePractice > 365) practice = Math.max(practice, 10);

  // ============ 三、比赛分（满分 100；仅计入有提交记录的有效场次；被判定作弊的场次不计） ============
  const contestRows = db.prepare(`
    SELECT cr.rank, c.id AS contest_id, c.end_time, c.start_time, c.signup_required,
      (SELECT COUNT(*) FROM contest_registrations r WHERE r.contest_id = c.id) AS total_participants
    FROM contest_registrations cr JOIN contests c ON c.id = cr.contest_id
    WHERE cr.user_id = ? AND c.end_time <= ?
      AND NOT EXISTS (SELECT 1 FROM contest_penalties cp WHERE cp.contest_id = c.id AND cp.user_id = cr.user_id)
    ORDER BY c.end_time ASC
  `).all(userId, now);
  // 有效场次：必须有提交记录（赛时窗口内有提交）才计入
  const validContests = [];
  for (const r of contestRows) {
    const hasSub = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE user_id = ? AND contest_id = ? AND created_at >= ? AND created_at <= ?')
      .get(userId, r.contest_id, r.start_time, r.end_time).c > 0;
    if (hasSub) {
      validContests.push({ rank: r.rank, total_participants: Math.max(1, r.total_participants), end_time: r.end_time });
    }
  }
  // 近 30 天参赛场次（有提交）
  const recent30dContests = validContests.filter((c) => now - c.end_time <= 30 * DAY).length;
  let contestScore = 0;
  for (let idx = 0; idx < validContests.length; idx++) {
    const con = validContests[idx];
    const base = 2 / (1 + Math.exp(-(idx + 1) / 10)) - 1;
    // 排名系数（百分位）
    const totalP = Math.max(1, con.total_participants);
    const percentile = Math.min(1, con.rank / totalP);
    let rankFactor;
    if (percentile <= 0.01) rankFactor = 3.0;
    else if (percentile <= 0.05) rankFactor = 2.5;
    else if (percentile <= 0.10) rankFactor = 2.0;
    else if (percentile <= 0.25) rankFactor = 1.5;
    else if (percentile <= 0.50) rankFactor = 1.0;
    else if (percentile <= 0.75) rankFactor = 0.6;
    else rankFactor = 0.3;
    const freqFactor = 0.5 + 0.5 * Math.min(1, recent30dContests / 5);
    contestScore += base * rankFactor * freqFactor;
  }
  // 比赛分 = 各有效场次贡献之和 × 100（满分 100）：使“名次越好、场次越多”产生可见积分，
  // 避免单场小系数被取整成 0 导致“比赛积分无法计算”。
  let contest = Math.min(contestScore * 100, 100);
  // 衰减：距最近有效参赛 > 30 天（幂律，最高扣 90%）
  if (validContests.length) {
    const lastC = validContests[validContests.length - 1].end_time;
    const inactiveMonths = Math.max(0, (now - lastC) / DAY / 30);
    if (inactiveMonths > 1) {
      const decay = Math.min(1 - 1 / (1 + 0.3 * Math.pow(inactiveMonths, 1.5)), 0.90);
      contest = contest * (1 - decay);
    }
  }
  if (validContests.length && (now - validContests[validContests.length - 1].end_time) / DAY > 365) contest = Math.max(contest, 10);

  // ============ 四、社区分（满分 100） ============
  const articles = db.prepare(`
    SELECT id, created_at, LENGTH(content) AS word_count FROM editorials
    WHERE user_id = ? AND status = 'approved'
    ORDER BY created_at ASC
  `).all(userId);
  let communityScore = 0;
  // 连续发布数（间隔 <= 7 天）
  let continuousArticleCount = 0;
  if (articles.length) {
    continuousArticleCount = 1;
    for (let i = 1; i < articles.length; i++) {
      if (articles[i].created_at - articles[i - 1].created_at <= 7 * DAY) continuousArticleCount++;
      else continuousArticleCount = 1;
    }
  }
  const contFactor = continuousArticleCount === 0 ? 0.5 : 0.5 + 0.5 * (1 - Math.exp(-continuousArticleCount / 5));
  for (let idx = 0; idx < articles.length; idx++) {
    const art = articles[idx];
    const base = 4 / (1 + 0.1 * idx);
    const wc = art.word_count || 0;
    let lengthFactor;
    if (wc < 500) lengthFactor = 0.3;
    else if (wc < 1000) lengthFactor = 0.6;
    else if (wc < 2000) lengthFactor = 0.8;
    else if (wc < 5000) lengthFactor = 1.0;
    else lengthFactor = 1.2;
    let single = base * contFactor * lengthFactor;
    single = Math.min(single, 4.0);
    communityScore += single;
  }
  let community = Math.min(communityScore, 100);
  // 衰减：距最近投稿 > 30 天（比比赛更平缓，最高扣 80%）
  if (articles.length) {
    const lastArt = articles[articles.length - 1].created_at;
    const inactiveMonths = Math.max(0, (now - lastArt) / DAY / 30);
    if (inactiveMonths > 1) {
      const decay = Math.min(1 - 1 / (1 + 0.2 * Math.pow(inactiveMonths, 1.5)), 0.80);
      community = community * (1 - decay);
    }
  }
  if (articles.length && (now - articles[articles.length - 1].created_at) / DAY > 365) community = Math.max(community, 20);

  // 四舍五入
  base = Math.round(base);
  practice = Math.round(practice);
  contest = Math.round(contest);
  community = Math.round(community);
  return { total: Math.round(base + practice + contest + community), breakdown: { base, practice, contest, community } };
}

// ---------------- 打卡 ----------------

/** 本地日期 YYYY-MM-DD：打卡按服务器本地时区每日 00:00 重置（不能用 UTC，否则会偏移时区） */
function localDateString(d) {
  const dt = d || new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getCheckinStatus(userId) {
  const today = localDateString();
  const checked = !!db.prepare('SELECT user_id FROM checkins WHERE user_id = ? AND date = ?').get(userId, today);
  const rows = db.prepare('SELECT date FROM checkins WHERE user_id = ? ORDER BY date DESC').all(userId);
  const set = new Set(rows.map((r) => r.date));
  let streak = 0;
  let d = checked ? new Date() : new Date(Date.now() - DAY_MS);
  while (set.has(localDateString(d))) { streak++; d = new Date(d.getTime() - DAY_MS); }
  return { checked, streak, total: rows.length };
}

function doCheckin(userId) {
  const today = localDateString();
  const exists = db.prepare('SELECT user_id FROM checkins WHERE user_id = ? AND date = ?').get(userId, today);
  if (exists) return { error: '今日已打卡' };
  db.prepare('INSERT INTO checkins (user_id, date, created_at) VALUES (?, ?, ?)').run(userId, today, Date.now());
  return { ok: true, ...getCheckinStatus(userId) };
}

const DAY_MS = 86400000;

/** 全量用户名 → 积分/角色/棕名 映射（前端统一上色） */
function getUserColors() {
  const rows = db.prepare('SELECT id, username, nickname, role, brown_name FROM users').all();
  const map = {};
  for (const r of rows) {
    const pts = computePoints(r.id);
    map[r.username] = { points: pts.total, role: r.role, brown_name: !!r.brown_name, nickname: r.nickname || '' };
  }
  return map;
}

/** 最近 N 天做题趋势（每天提交数 / AC 数） */
function getActivity(userId, days = 180) {
  const since = Date.now() - days * 86400000;
  const rows = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch') AS d, COUNT(*) AS c,
      SUM(CASE WHEN verdict = 'Accepted' THEN 1 ELSE 0 END) AS ac
    FROM submissions WHERE user_id = ? AND created_at >= ? AND contest_id IS NULL
    GROUP BY d
  `).all(userId, since);
  const map = {};
  for (const r of rows) map[r.d] = { count: r.c, ac: r.ac || 0 };
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: key, count: (map[key] || {}).count || 0, ac: (map[key] || {}).ac || 0 });
  }
  return out;
}

/** 用户发布的题解/专栏文章列表（题目关联可为空，含草稿） */
function getUserEditorials(userId, limit = 50) {
  const rows = db.prepare(`
    SELECT e.id, e.problem_id, p.title AS problem_title, e.title, e.status, e.category, e.created_at,
      (SELECT COUNT(*) FROM editorial_likes l WHERE l.editorial_id = e.id) AS like_count,
      (SELECT COUNT(*) FROM editorial_comments c WHERE c.editorial_id = e.id) AS comment_count
    FROM editorials e LEFT JOIN problems p ON p.id = e.problem_id
    WHERE e.user_id = ? ORDER BY e.id DESC LIMIT ?
  `).all(userId, limit);
  return rows.map((r) => ({
    id: r.id,
    problem_id: r.problem_id,
    problem_title: r.problem_title || '',
    title: r.title,
    status: r.status,
    category: r.category || '',
    is_article: !r.problem_id,
    like_count: r.like_count,
    comment_count: r.comment_count,
    created_at: r.created_at,
  }));
}

// ---------------- 收藏（题目 / 讨论 / 比赛 / 文章） ----------------

const FAV_TYPES = ['problem', 'discussion', 'contest', 'article'];
const FAV_TYPE_LABEL = { problem: '题目', discussion: '讨论', contest: '比赛', article: '文章' };

function addFavorite(userId, type, itemId) {
  const t = FAV_TYPES.includes(type) ? type : 'problem';
  const id = parseInt(itemId, 10);
  if (!Number.isFinite(id) || id <= 0) return { error: '参数错误' };
  if (t === 'problem' && !db.prepare('SELECT id FROM problems WHERE id = ?').get(id)) return { error: '题目不存在' };
  if (t === 'discussion' && !db.prepare('SELECT id FROM discussions WHERE id = ?').get(id)) return { error: '讨论不存在' };
  if (t === 'contest' && !db.prepare('SELECT id FROM contests WHERE id = ?').get(id)) return { error: '比赛不存在' };
  if (t === 'article' && !db.prepare('SELECT id FROM editorials WHERE id = ?').get(id)) return { error: '文章不存在' };
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, problem_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, t === 'problem' ? id : null, t, id, Date.now());
  return { ok: true };
}

function removeFavorite(userId, type, itemId) {
  const t = FAV_TYPES.includes(type) ? type : 'problem';
  const id = parseInt(itemId, 10);
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_type = ? AND item_id = ?').run(userId, t, Number.isFinite(id) ? id : -1);
  return { ok: true };
}

function isFavorite(userId, type, itemId) {
  if (!userId) return false;
  const t = FAV_TYPES.includes(type) ? type : 'problem';
  const id = parseInt(itemId, 10);
  return !!db.prepare('SELECT user_id FROM favorites WHERE user_id = ? AND item_type = ? AND item_id = ?').get(userId, t, Number.isFinite(id) ? id : -1);
}

/** 收藏列表（type=problem|discussion|contest|article 过滤，未指定返回全部并附类型） */
function getFavorites(userId, query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const type = (query.get('type') || '').trim();
  const filterType = FAV_TYPES.includes(type) ? type : '';
  const where = filterType ? 'WHERE f.item_type = ? AND f.user_id = ?' : 'WHERE f.user_id = ?';
  const totalParams = filterType ? [filterType, userId] : [userId];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM favorites f ${where}`).get(...totalParams).c;
  let rows;
  if (!filterType) {
    rows = db.prepare(`SELECT f.item_type, f.item_id, f.created_at FROM favorites f WHERE f.user_id = ? ORDER BY f.created_at DESC, f.item_id DESC LIMIT ? OFFSET ?`).all(userId, size, offset);
  } else if (filterType === 'problem') {
    rows = db.prepare(`
      SELECT f.item_type, f.item_id, f.created_at, p.title, p.difficulty, p.accepted_count, p.submit_count
      FROM favorites f JOIN problems p ON p.id = f.item_id
      WHERE f.user_id = ? AND f.item_type = 'problem' ORDER BY f.created_at DESC, f.item_id DESC LIMIT ? OFFSET ?
    `).all(userId, size, offset);
  } else if (filterType === 'discussion') {
    rows = db.prepare(`
      SELECT f.item_type, f.item_id, f.created_at, d.title, u.username, d.problem_id, p.title AS problem_title
      FROM favorites f JOIN discussions d ON d.id = f.item_id JOIN users u ON u.id = d.user_id
      LEFT JOIN problems p ON p.id = d.problem_id
      WHERE f.user_id = ? AND f.item_type = 'discussion' ORDER BY f.created_at DESC, f.item_id DESC LIMIT ? OFFSET ?
    `).all(userId, size, offset);
  } else if (filterType === 'article') {
    rows = db.prepare(`
      SELECT f.item_type, f.item_id, f.created_at, e.title, e.category, e.status, e.user_id, u.username,
        (SELECT COUNT(*) FROM editorial_likes l WHERE l.editorial_id = e.id) AS like_count,
        (SELECT COUNT(*) FROM editorial_comments c WHERE c.editorial_id = e.id) AS comment_count
      FROM favorites f JOIN editorials e ON e.id = f.item_id JOIN users u ON u.id = e.user_id
      WHERE f.user_id = ? AND f.item_type = 'article' ORDER BY f.created_at DESC, f.item_id DESC LIMIT ? OFFSET ?
    `).all(userId, size, offset);
  } else {
    rows = db.prepare(`
      SELECT f.item_type, f.item_id, f.created_at, c.title, c.type, c.start_time, c.end_time,
        (SELECT COUNT(*) FROM contest_registrations r WHERE r.contest_id = c.id) AS signup_count
      FROM favorites f JOIN contests c ON c.id = f.item_id
      WHERE f.user_id = ? AND f.item_type = 'contest' ORDER BY f.created_at DESC, f.item_id DESC LIMIT ? OFFSET ?
    `).all(userId, size, offset);
  }
  const nowMs = Date.now();
  return {
    items: rows.map((r) => {
      const item = {
        type: r.item_type,
        type_label: FAV_TYPE_LABEL[r.item_type] || r.item_type,
        id: r.item_id,
        title: r.title || '',
        extra: r.username || r.type || '',
        created_at: r.created_at,
      };
      if (r.difficulty != null) item.difficulty = r.difficulty;
      if (r.accepted_count != null) item.accepted_count = r.accepted_count;
      if (r.submit_count != null) item.submit_count = r.submit_count;
      if (r.problem_id != null) item.problem_id = r.problem_id;
      if (r.problem_title != null) item.problem_title = r.problem_title;
      if (r.category != null) item.category = r.category;
      if (r.status != null) item.status = r.status;
      if (r.like_count != null) item.like_count = r.like_count;
      if (r.comment_count != null) item.comment_count = r.comment_count;
      if (r.signup_count != null) item.signup_count = r.signup_count;
      if (r.start_time != null && r.end_time != null) {
        item.status = r.start_time > nowMs ? 'upcoming' : (r.end_time < nowMs ? 'ended' : 'running');
        item.status_label = { upcoming: '未开始', running: '进行中', ended: '已结束' }[item.status];
      }
      return item;
    }),
    total, page, size,
  };
}

/** 用户各类收藏数量 */
function favoriteCounts(userId) {
  const rows = db.prepare("SELECT item_type AS type, COUNT(*) AS c FROM favorites WHERE user_id = ? GROUP BY item_type").all(userId);
  const counts = { problem: 0, discussion: 0, contest: 0, article: 0 };
  rows.forEach((r) => { counts[r.type] = r.c; });
  return counts;
}

/** 用户等级分变化记录总数（用于「共 N 场」展示） */
function getRatingHistoryCount(userId) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM rating_history WHERE user_id = ?').get(userId);
  return (row && row.c) || 0;
}

/** 用户等级分变化曲线（按时间升序返回；recent > 0 时取最近 recent 场，0 表示全部） */
function getRatingHistory(userId, recent = 0) {
  const limit = Number.isFinite(recent) && recent > 0 ? Math.min(2000, Math.floor(recent)) : 0;
  // 限制条数时先按 id 倒序取最近 N 条，再反转为升序，保证曲线上是「最近 N 场」而不是「最早 N 场」
  const rows = limit
    ? db.prepare(`
        SELECT h.contest_id, h.rating_before, h.rating_after, h.delta, h.created_at, c.title AS contest_title
        FROM rating_history h LEFT JOIN contests c ON c.id = h.contest_id
        WHERE h.user_id = ? ORDER BY h.id DESC LIMIT ?
      `).all(userId, limit).reverse()
    : db.prepare(`
        SELECT h.contest_id, h.rating_before, h.rating_after, h.delta, h.created_at, c.title AS contest_title
        FROM rating_history h LEFT JOIN contests c ON c.id = h.contest_id
        WHERE h.user_id = ? ORDER BY h.id ASC
      `).all(userId);
  return rows.map((r) => ({
    contest_id: r.contest_id,
    rating_before: r.rating_before,
    rating_after: r.rating_after,
    delta: r.delta,
    contest_title: r.contest_title || '',
    created_at: r.created_at,
  }));
}

// ---------------- 用户管理（需要「用户管理」权限） ----------------

function listUsers(query) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const search = (query.get('search') || '').trim();
  const where = [];
  const params = [];
  if (search) {
    where.push('(username LIKE ? OR email LIKE ? OR nickname LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM users ${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT id, username, nickname, email, role, is_admin, can_speak, can_speak_until, can_editorial, can_editorial_until, banned, banned_until, rating, brown_name, brown_type, bio, permissions, created_at
    FROM users ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  const { parsePermissions, ALL_PERMISSIONS } = require('./auth');
  return {
    items: rows.map((r) => {
      // 到期自动恢复
      checkUserExpiry(r.id);
      return {
        id: r.id,
        username: r.username,
        nickname: r.nickname || '',
        email: r.email,
        role: r.role,
        permissions: parsePermissions(r.permissions),
        is_superadmin: parsePermissions(r.permissions).length === ALL_PERMISSIONS.length,
        can_speak: r.can_speak === undefined ? true : !!r.can_speak,
        can_speak_until: r.can_speak_until || 0,
        can_editorial: !!r.can_editorial,
        can_editorial_until: r.can_editorial_until || 0,
        banned: !!r.banned,
        banned_until: r.banned_until || 0,
        rating: r.rating || 0,
        brown_name: !!r.brown_name,
        brown_type: r.brown_type || '',
        created_at: r.created_at,
      };
    }),
    total, page, size,
  };
}

/* 社区管理记录：动作 → 中文标签 + 色调（good=授予/解除（绿），bad=撤销/封禁/处罚（红），info=其它变更（蓝））。
   所有动作用户可见文案必须为中文：此前 edit_profile / brown_name / unbrown 未登记，页面会直接显示英文动作名。 */
const ACTION_META = {
  ban: { label: '封禁用户', tone: 'bad' },
  unban: { label: '解除封禁', tone: 'good' },
  grant_speak: { label: '授予自由发言权限', tone: 'good' },
  revoke_speak: { label: '撤销自由发言权限', tone: 'bad' },
  grant_discuss: { label: '授予发布讨论权限', tone: 'good' },
  revoke_discuss: { label: '撤销发布讨论权限', tone: 'bad' },
  grant_reply: { label: '授予参与讨论权限', tone: 'good' },
  revoke_reply: { label: '撤销参与讨论权限', tone: 'bad' },
  grant_editorial: { label: '授予发布题解权限', tone: 'good' },
  revoke_editorial: { label: '撤销发布题解权限', tone: 'bad' },
  grant_permissions: { label: '授予管理员权限', tone: 'good' },
  revoke_permissions: { label: '撤销管理员权限', tone: 'bad' },
  set_permissions: { label: '变更管理员权限', tone: 'info' },
  set_role: { label: '变更权限等级', tone: 'info' },
  edit_profile: { label: '编辑用户资料', tone: 'info' },
  brown_name: { label: '棕名处罚（抄题解）', tone: 'bad' },
  unbrown: { label: '解除棕名处罚', tone: 'good' },
};

/** 兜底：未登记的动作也给出中文标签与色调（页面上不出现英文动作名） */
function actionMeta(action) {
  const key = String(action || '');
  if (ACTION_META[key]) return ACTION_META[key];
  if (key.startsWith('grant')) return { label: '授予权限', tone: 'good' };
  if (key.startsWith('revoke')) return { label: '撤销权限', tone: 'bad' };
  if (key.startsWith('unbrown')) return { label: '解除棕名处罚', tone: 'good' };
  if (key.startsWith('brown')) return { label: '棕名处罚', tone: 'bad' };
  if (key.startsWith('unban')) return { label: '解除封禁', tone: 'good' };
  if (key.startsWith('ban')) return { label: '封禁用户', tone: 'bad' };
  return { label: '社区管理操作', tone: 'info' };
}

const ACTION_LABELS = Object.fromEntries(Object.entries(ACTION_META).map(([k, v]) => [k, v.label]));

function logModeration(actor, target, action, detail) {
  db.prepare(`
    INSERT INTO moderation_logs (admin_id, admin_name, user_id, username, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(actor.id, actor.username, target.id, target.username, action, detail, Date.now());
}

/**
 * 更新用户权限（需要「用户管理」权限）。
 * 支持设置权限位（permissions 数组，拥有全部权限 = 超级管理员）；
 * 可管理任意用户（含其他管理员），但内置 admin 账号除外。
 */
function updateUserPermissions(actor, targetId, data) {
  if (!hasPerm(actor, 'user')) return { error: '你没有「用户管理」权限' };
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return { error: '用户不存在' };
  if (target.username === 'admin') return { error: '不能修改内置超级管理员账号' };

  const reason = String(data.reason || '').trim();
  const { parsePermissions, ALL_PERMISSIONS, PERMISSION_LABELS } = require('./auth');
  // 时长（天）：>0 按天，0/空 = 永久
  const days = parseInt(data.days, 10);
  const until = Number.isFinite(days) && days > 0 ? Date.now() + days * 86400000 : 0;

  // 权限位（数组 → 逗号分隔存储）；拥有全部权限 = 超级管理员
  if (Array.isArray(data.permissions)) {
    const permSet = new Set(data.permissions.filter((p) => ALL_PERMISSIONS.includes(p)));
    const nextPerms = ALL_PERMISSIONS.filter((p) => permSet.has(p));
    const prevPerms = parsePermissions(target.permissions);
    if (prevPerms.join(',') !== nextPerms.join(',')) {
      const isSuper = nextPerms.length === ALL_PERMISSIONS.length;
      db.prepare('UPDATE users SET permissions = ?, role = ?, is_admin = ? WHERE id = ?')
        .run(nextPerms.join(','), isSuper ? 'superadmin' : (nextPerms.length > 0 ? 'admin' : 'user'), nextPerms.length > 0 ? 1 : 0, targetId);
      const label = (k) => PERMISSION_LABELS[k] || k;
      const prevLabel = prevPerms.length === ALL_PERMISSIONS.length ? '全部（超级管理员）' : (prevPerms.map(label).join('、') || '无');
      const nextLabel = nextPerms.length === ALL_PERMISSIONS.length ? '全部（超级管理员）' : (nextPerms.map(label).join('、') || '无');
      const detail = `管理员权限: ${prevLabel} → ${nextLabel}` + (reason ? `（原因：${reason}）` : '');
      // 权限增加 → 授予（绿），权限减少 → 撤销（红），仅换项不增减 → 变更（蓝）
      const permAction = nextPerms.length > prevPerms.length ? 'grant_permissions'
        : (nextPerms.length < prevPerms.length ? 'revoke_permissions' : 'set_permissions');
      logModeration(actor, target, permAction, detail);
      notifications.notify(targetId, 'permission', '管理员权限变更', `你的管理权限已变更为：${nextLabel}` + (reason ? `（原因：${reason}）` : ''), '/user/' + targetId);
    }
  }

  if (data.banned !== undefined && !!data.banned !== !!target.banned) {
    const untilText = until ? `${days} 天` : '永久';
    db.prepare('UPDATE users SET banned = ?, banned_until = ? WHERE id = ?').run(data.banned ? 1 : 0, data.banned ? until : 0, targetId);
    const action = data.banned ? 'ban' : 'unban';
    const detail = (data.banned ? `封禁账号（${untilText}）` : '解除封禁') + (reason ? `（原因：${reason}）` : '');
    logModeration(actor, target, action, detail);
    notifications.notify(targetId, 'permission', data.banned ? '账号已封禁' : '账号已解封',
      (data.banned ? `你的账号已被管理员 ${actor.username} 封禁${untilText}` : `你的账号已被管理员 ${actor.username} 解封`) + (reason ? `（原因：${reason}）` : ''), '/user/' + targetId);
  }

  if (data.can_speak !== undefined && !!data.can_speak !== !!target.can_speak) {
    const untilText = until ? `${days} 天` : '永久';
    db.prepare('UPDATE users SET can_speak = ?, can_speak_until = ? WHERE id = ?').run(data.can_speak ? 1 : 0, data.can_speak ? 0 : until, targetId);
    const action = data.can_speak ? 'grant_speak' : 'revoke_speak';
    const detail = (data.can_speak ? '恢复自由发言权限' : `撤销自由发言权限（${untilText}）`) + (reason ? `（原因：${reason}）` : '');
    logModeration(actor, target, action, detail);
    notifications.notify(targetId, 'permission', data.can_speak ? '已恢复自由发言权限' : '自由发言权限已被撤销',
      `管理员 ${actor.username} ${data.can_speak ? '恢复' : '撤销'}了你的自由发言权限（发布/参与讨论）${data.can_speak ? '' : untilText}` + (reason ? `（原因：${reason}）` : ''), '/user/' + targetId);
  }

  if (data.can_editorial !== undefined && !!data.can_editorial !== !!target.can_editorial) {
    const untilText = until ? `${days} 天` : '永久';
    db.prepare('UPDATE users SET can_editorial = ?, can_editorial_until = ? WHERE id = ?').run(data.can_editorial ? 1 : 0, data.can_editorial ? 0 : until, targetId);
    const action = data.can_editorial ? 'grant_editorial' : 'revoke_editorial';
    const detail = (data.can_editorial ? '恢复发布题解权限' : `撤销发布题解权限（${untilText}）`) + (reason ? `（原因：${reason}）` : '');
    logModeration(actor, target, action, detail);
    notifications.notify(targetId, 'permission', data.can_editorial ? '已恢复发布题解权限' : '发布题解权限已被撤销',
      `管理员 ${actor.username} ${data.can_editorial ? '恢复' : '撤销'}了你的发布题解权限${data.can_editorial ? '' : untilText}` + (reason ? `（原因：${reason}）` : ''), '/user/' + targetId);
  }

  return { ok: true };
}

/** 到期自动恢复：封禁/撤销权限带时长到期后自动解除（惰性检查） */
function checkUserExpiry(userId) {
  const now = Date.now();
  const u = db.prepare('SELECT id, banned, banned_until, can_speak, can_speak_until, can_editorial, can_editorial_until FROM users WHERE id = ?').get(userId);
  if (!u) return;
  if (u.banned === 1 && u.banned_until > 0 && now >= u.banned_until) {
    db.prepare('UPDATE users SET banned = 0, banned_until = 0 WHERE id = ?').run(userId);
  }
  if (u.can_speak === 0 && u.can_speak_until > 0 && now >= u.can_speak_until) {
    db.prepare('UPDATE users SET can_speak = 1, can_speak_until = 0 WHERE id = ?').run(userId);
  }
  if (u.can_editorial === 0 && u.can_editorial_until > 0 && now >= u.can_editorial_until) {
    db.prepare('UPDATE users SET can_editorial = 1, can_editorial_until = 0 WHERE id = ?').run(userId);
  }
}

// ---------------- 个人资料 / 密码 ----------------

/** 用户名唯一性校验 + 改名次数限制（普通用户一年 3 次；isAdmin 不受限） */
function applyUsernameChange(target, newUsername, isAdmin) {
  const name = String(newUsername || '').trim();
  if (!name) return { error: '用户名不能为空' };
  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(name)) return { error: '用户名需 2~20 位，仅限中英文、数字、下划线、连字符' };
  if (name === target.username) return { ok: true, changed: false };
  const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(name, target.id);
  if (dup) return { error: '该用户名已被占用' };
  if (!isAdmin) {
    const YEAR = 365 * 86400000;
    const now = Date.now();
    // 距上次改名超过一年则重置计数
    let changes = target.username_changes || 0;
    let lastAt = target.username_changed_at || 0;
    if (now - lastAt > YEAR) { changes = 0; lastAt = now; }
    if (changes >= 3) return { error: '一年内最多修改 3 次用户名（下次可用时间：' + new Date(lastAt + YEAR).toLocaleDateString('zh-CN') + '）' };
    db.prepare('UPDATE users SET username = ?, username_changes = ?, username_changed_at = ? WHERE id = ?')
      .run(name, changes + 1, now, target.id);
  } else {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, target.id);
  }
  return { ok: true, changed: true };
}

function updateProfile(userId, data) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return { error: '用户不存在' };
  const nickname = String(data.nickname || '').trim().slice(0, 20);
  // 头像：base64 图片落盘保存（数据库只存短 URL），外链原样保留，空值清除
  const avatarRaw = String(data.avatar || '').trim().slice(0, 800 * 1024);
  const avatars = require('./avatars');
  const avatar = avatars.normalize(userId, avatarRaw);
  if (avatar && typeof avatar === 'object' && avatar.error) return avatar;
  const bio = String(data.bio || '').trim().slice(0, 500);
  if (data.username !== undefined) {
    const r = applyUsernameChange(u, data.username, false);
    if (r.error) return r;
  }
  db.prepare('UPDATE users SET nickname = ?, avatar = ?, bio = ? WHERE id = ?').run(nickname, avatar, bio, userId);
  return { ok: true, avatar };
}

function changePassword(userId, oldPassword, newPassword) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return { error: '用户不存在' };
  if (!verifyPassword(oldPassword, u.password_hash)) return { error: '当前密码错误' };
  if (String(newPassword || '').length < 6) return { error: '新密码长度至少 6 位' };
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  return { ok: true };
}

/** 管理员编辑用户资料（用户名 / 昵称 / 邮箱 / 简介；用户名修改不受限） */
function adminUpdateProfile(actor, targetId, data) {
  if (!hasPerm(actor, 'user')) return { error: '你没有「用户管理」权限' };
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return { error: '用户不存在' };
  if (target.username === 'admin') return { error: '不能修改内置超级管理员账号' };
  const nickname = String(data.nickname || '').trim().slice(0, 20) || target.nickname;
  const email = String(data.email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: '邮箱格式不正确' };
  if (email && email !== target.email) {
    const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, targetId);
    if (dup) return { error: '该邮箱已被占用' };
  }
  const bio = String(data.bio || '').trim().slice(0, 500);
  if (data.username !== undefined) {
    const r = applyUsernameChange(target, data.username, true);
    if (r.error) return r;
  }
  db.prepare('UPDATE users SET nickname = ?, email = ?, bio = ? WHERE id = ?')
    .run(nickname, email || target.email, bio, targetId);
  // 说明：编辑用户资料属于日常资料维护，**不写入社区管理记录**，因此社区管理页面不会出现该操作。
  return { ok: true };
}

/** 管理员重置用户密码 */
function adminSetPassword(actor, targetId, newPassword) {
  if (!hasPerm(actor, 'user')) return { error: '你没有「用户管理」权限' };
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return { error: '用户不存在' };
  if (target.username === 'admin') return { error: '不能修改内置超级管理员账号' };
  if (String(newPassword || '').length < 6) return { error: '新密码长度至少 6 位' };
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), targetId);
  return { ok: true };
}

/**
 * 批量生成用户（管理员）。data: { prefix, suffix, start, end, digits, password, email_domain }
 * 用户名规则：prefix + 编号(按 digits 补零) + suffix；跳过已存在的用户名。
 * 返回生成结果 [{ username, password }]，供前端展示 / 导出。
 */
function batchCreateUsers(actor, data) {
  if (!hasPerm(actor, 'user')) return { error: '你没有「用户管理」权限' };
  const prefix = String(data.prefix || '').trim().slice(0, 20);
  const suffix = String(data.suffix || '').trim().slice(0, 20);
  const start = parseInt(data.start, 10);
  const end = parseInt(data.end, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
    return { error: '编号范围无效（起始 ≥ 1 且 结束 ≥ 起始）' };
  }
  const count = end - start + 1;
  if (count > 500) return { error: '单次最多生成 500 个用户' };
  const digits = Math.max(1, Math.min(6, parseInt(data.digits, 10) || 1));
  const password = String(data.password || '');
  if (password.length < 6) return { error: '默认密码长度至少 6 位' };
  const emailDomain = String(data.email_domain || '').trim().replace(/^@/, '');
  if (emailDomain && !/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(emailDomain)) return { error: '邮箱域名格式不正确（如 example.com）' };
  if (!prefix && !suffix) return { error: '请至少填写用户名前缀或后缀，以便区分批量用户' };

  const now = Date.now();
  const created = [];
  const skipped = [];
  const insert = db.prepare(`
    INSERT INTO users (id, username, email, password_hash, is_admin, role, can_speak, can_discuss, can_reply, can_editorial, banned, nickname, avatar, bio, rating, email_verified, email_verify_token, permissions, created_at)
    VALUES (?, ?, ?, ?, 0, 'user', 1, 1, 1, 1, 0, '', '', '', 0, 1, '', '', ?)
  `);
  for (let n = start; n <= end; n++) {
    const num = String(n).padStart(digits, '0');
    const username = `${prefix}${num}${suffix}`;
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) { skipped.push({ username, reason: '不符合用户名规则' }); continue; }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) { skipped.push({ username, reason: '已存在' }); continue; }
    const email = emailDomain ? `${username}@${emailDomain}` : '';
    // 用户编号复用已释放的 uid（与单个注册保持一致）
    insert.run(nextFreeId('users'), username, email, hashPassword(password), now);
    created.push({ username, password });
  }
  return { ok: true, created, skipped, total: created.length };
}

// ---------------- 社区管理公布页 ----------------

function getModerationLogs(query = {}) {
  const { page, size, offset } = parsePagination(query, 30, 100);
  // 编辑用户资料（edit_profile）不进入社区管理页面：既不再写入新记录，也过滤历史遗留记录
  const total = db.prepare("SELECT COUNT(*) AS c FROM moderation_logs WHERE action != 'edit_profile'").get().c;
  const rows = db.prepare(`
    SELECT id, admin_id, admin_name, user_id, username, action, detail, created_at
    FROM moderation_logs WHERE action != 'edit_profile' ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(size, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      admin_id: r.admin_id,
      admin_name: r.admin_name,
      user_id: r.user_id,
      username: r.username,
      action: r.action,
      action_label: actionMeta(r.action).label,
      tone: actionMeta(r.action).tone,
      detail: r.detail,
      created_at: r.created_at,
    })),
    total, page, size,
  };
}

// ---------------- 棕名处罚（仅超级管理员） ----------------

const BROWN_DAYS = 14;

function brownName(actor, targetId, type, contestId) {
  if (!hasPerm(actor, 'user')) return { error: '你没有「用户管理」权限' };
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return { error: '用户不存在' };
  if (target.username === 'admin') return { error: '不能处罚内置管理员' };
  if (!['plagiarism', 'cheat'].includes(type)) return { error: '无效的处罚类型' };
  const until = Date.now() + BROWN_DAYS * 86400000;
  db.prepare('UPDATE users SET brown_name = 1, brown_name_until = ?, brown_type = ? WHERE id = ?').run(until, type, targetId);

  let detail = '';
  if (type === 'plagiarism') {
    // 抄题解：清空练习积分（删除其所有 AC 提交），棕名 14 天
    db.prepare("DELETE FROM submissions WHERE user_id = ? AND verdict = 'Accepted'").run(targetId);
    detail = '抄题解处罚：清空练习积分并将所有题目置为未通过，棕名 14 天';
  } else {
    // 比赛作弊：该场比赛判 -1 分参与排名与等级分计算，棕名 14 天，不清空练习积分
    const cid = parseInt(contestId, 10);
    const c = cid ? db.prepare('SELECT id FROM contests WHERE id = ?').get(cid) : null;
    if (!c) return { error: '请选择作弊的比赛场次' };
    db.prepare('INSERT OR IGNORE INTO contest_penalties (contest_id, user_id) VALUES (?, ?)').run(cid, targetId);
    detail = `比赛作弊处罚（场次 #${cid}）：该场判 -1 分参与排名与等级分计算，棕名 14 天`;
  }

  logModeration(actor, target, 'brown_name', detail);
  notifications.notify(targetId, 'permission', '棕名处罚', `你已被管理员 ${actor.username} 棕名处罚（${type === 'plagiarism' ? '抄题解' : '比赛作弊'}），棕名期 14 天。${detail}`, '/user/' + targetId);
  return { ok: true, detail };
}

function unBrown(actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return { error: '用户不存在' };
  if (!target.brown_name) return { error: '该用户当前未被棕名' };
  db.prepare("UPDATE users SET brown_name = 0, brown_name_until = 0, brown_type = '' WHERE id = ?").run(targetId);
  if (actor) {
    logModeration(actor, target, 'unbrown', '解除棕名处罚');
    try { notifications.notify(targetId, 'permission', '解除棕名', `你已被管理员 ${actor.username} 解除棕名处罚。`, '/user/' + targetId); } catch { /* ignore */ }
  }
  return { ok: true };
}

// ---------------- 排行榜 ----------------

/** 等级分排行榜 */
const RANKING_CAP = 1000; // 排行榜最多展示全站前 1000 名

function getRatingRanking(query = {}) {
  const { page, size, offset } = parsePagination(query, 30, 100);
  const total = Math.min(RANKING_CAP, db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
  if (offset >= total) return { items: [], total, page, size };
  const rows = db.prepare(`
    SELECT id, username, nickname, role, avatar, rating, rated_games, brown_name, brown_type, banned
    FROM users ORDER BY rating DESC, id ASC LIMIT ? OFFSET ?
  `).all(size, offset);
  return {
    items: rows.map((r, i) => ({ rank: offset + i + 1, id: r.id, username: r.username, nickname: r.nickname, role: r.role, avatar: r.avatar || '', rating: r.rating, rated_games: r.rated_games, brown_name: !!r.brown_name, banned: !!r.banned })),
    total, page, size,
  };
}

/** 积分排行榜（分页：先取全量排序计算名次，再切片当前页；上限前 1000 名） */
function getPointsRanking(query = {}) {
  const settings = require('./settings');
  if (settings.getSetting('points_enabled', '1') !== '1') {
    return { items: [], total: 0, page: 1, size: 30 };
  }
  const { page, size } = parsePagination(query, 30, 100);
  const total = Math.min(RANKING_CAP, db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
  const rows = db.prepare('SELECT id, username, nickname, role, avatar, brown_name, banned, can_speak, can_editorial FROM users ORDER BY id ASC').all();
  const items = rows.map((r) => {
    const pts = computePoints(r.id);
    return {
      rank: 0,
      id: r.id,
      username: r.username,
      nickname: r.nickname,
      role: r.role,
      avatar: r.avatar || '',
      brown_name: !!r.brown_name,
      banned: !!r.banned,
      points: pts.total,
      breakdown: pts.breakdown,
    };
  });
  items.sort((a, b) => b.points - a.points || a.id - b.id);
  // 竞赛排名：积分相同并列（1,1,3）
  let lastPts = null;
  let lastRank = 0;
  items.forEach((r, i) => {
    if (r.points !== lastPts) {
      r.rank = i + 1;
      lastRank = r.rank;
      lastPts = r.points;
    } else {
      r.rank = lastRank;
    }
  });
  const capped = items.slice(0, RANKING_CAP);
  return { items: capped.slice((page - 1) * size, page * size), total, page, size };
}

/**
 * 批量删除 / 重置（仅 admin 账号）。
 * body: { type: 'articles'|'feedbacks'|'problems'|'contests'|'discussions'|'users', ids: [number] }
 *      或 { type: 'clear_all' } 清空全站数据（保留 admin 用户与系统设置）。
 */
function batchDelete(adminId, body) {
  const type = String(body && body.type || '').trim();
  const ids = Array.isArray(body && body.ids) ? body.ids.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0) : [];
  const map = {
    articles: ['editorials'],
    feedbacks: ['feedbacks'],
    problems: ['problems'],
    contests: ['contests'],
    discussions: ['discussions'],
    users: ['users'],
  };
  if (type === 'clear_all') {
    // 清空内容，保留 admin 用户与系统设置
    db.prepare("DELETE FROM editorials").run();
    db.prepare("DELETE FROM editorial_comments").run();
    db.prepare("DELETE FROM feedbacks").run();
    db.prepare("DELETE FROM discussions").run();
    db.prepare("DELETE FROM discussion_replies").run();
    db.prepare("DELETE FROM contests").run();
    db.prepare("DELETE FROM contest_problems").run();
    db.prepare("DELETE FROM contest_registrations").run();
    db.prepare("DELETE FROM contest_penalties").run();
    db.prepare("DELETE FROM submissions").run();
    db.prepare("DELETE FROM problems").run();
    db.prepare("DELETE FROM favorites").run();
    db.prepare("DELETE FROM checkins").run();
    db.prepare("DELETE FROM notifications").run();
    db.prepare("DELETE FROM moderation_logs").run();
    db.prepare("DELETE FROM users WHERE username != 'admin'").run();
    // 重置 problems 自增，使新题目从 1 开始
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('problems','submissions','editorials','discussions','contests','feedbacks','users')");
    return { ok: true, cleared: true };
  }
  const table = map[type];
  if (!table) return { error: '无效的删除类型' };
  if (!ids.length) return { error: '请选择要删除的项目' };
  // 用户删除：禁止删除内置超级管理员 admin（保护账号）
  if (type === 'users') {
    const adm = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    if (adm) {
      const safe = ids.filter((n) => n !== adm.id);
      if (safe.length !== ids.length) {
        // 过滤掉 admin 后若无剩余则报错
        if (!safe.length) return { error: '不能删除内置超级管理员账号 admin' };
        ids.length = 0; ids.push(...safe);
      }
    }
  }
  const placeholders = ids.map(() => '?').join(',');
  let count = 0;
  for (const t of table) {
    const r = db.prepare(`DELETE FROM ${t} WHERE id IN (${placeholders})`).run(...ids);
    count += r.changes;
  }
  // 用户删除后：其余个人数据（提交/私信/收藏/打卡/等级分/报名等）由外键 ON DELETE CASCADE 一并清理，
  // 这里补充两张没有外键的表，确保 uid 释放后不会把旧数据带给复用该编号的新用户。
  if (type === 'users') {
    for (const t of ['feedbacks', 'checkins']) {
      db.prepare(`DELETE FROM ${t} WHERE user_id IN (${placeholders})`).run(...ids);
    }
  }
  return { ok: true, count };
}

module.exports = {
  getProfile,
  computePoints,
  getPointsRankOf,
  getActivity,
  getUserEditorials,
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavorites,
  favoriteCounts,
  getRatingHistory,
  getRatingHistoryCount,
  listUsers,
  updateUserPermissions,
  checkUserExpiry,
  updateProfile,
  changePassword,
  adminUpdateProfile,
  adminSetPassword,
  getModerationLogs,
  brownName,
  unBrown,
  getRatingRanking,
  getPointsRanking,
  getCheckinStatus,
  doCheckin,
  getUserColors,
  batchDelete,
  batchCreateUsers,
};
