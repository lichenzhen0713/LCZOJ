'use strict';

const crypto = require('crypto');

const { db, nextFreeId, passwordPolicyError, removeAdminPasswordFile } = require('./db');
const { parsePagination } = require('./util');
const { hashPassword, verifyPassword } = require('./password');
const { hasPerm, destroyUserSessions, sanitizeUser, isBuiltinAdminUser, guardBuiltinAdminPasswordChange, auditBuiltinAdminChanged } = require('./auth');
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

  /* 个人中心「提交记录」区块的数据口径（v2.5.4 修复）：
   * 此前 recent 查询漏了与「提交记录」页一致的过滤条件——它无条件把最近 10 条**全部**提交（含赛时）
   * 取出来，而页面顶部「提交数」/「查看全部 →」只统计题库提交（contest_id IS NULL），
   * 于是只有赛时提交的用户会出现「提交数 0 + 列表有 10 条 + 查看全部 0 条」的自相矛盾。
   * 现在统一为「含赛时提交」口径，并套用与 src/submissions.js listSubmissions 相同的可见性规则
   * （公开题目的提交未登录可看、进行中比赛的他人提交不可见、管理员不受限），
   * 保证预览列表 ≤「查看全部」列表，绝不会多露出任何一条。 */
  const now = Date.now();
  const isAdminViewer = !!(viewer && viewer.is_admin);
  const ownId = viewer && viewer.id ? viewer.id : 0;
  const recentConds = ['s.user_id = ?'];
  const recentParams = [u.id];
  if (!isAdminViewer) {
    recentConds.push('(p.is_public = 1 AND (s.contest_id IS NULL OR cc.end_time <= ?)' + (ownId ? ' OR s.user_id = ?' : '') + ')');
    recentParams.push(now);
    if (ownId) recentParams.push(ownId);
  }
  const recent = db.prepare(`
    SELECT s.id, s.problem_id, p.title AS problem_title, s.verdict, s.score, s.language, s.created_at,
      s.contest_id, cc.title AS contest_title, cc.type AS contest_type
    FROM submissions s
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN contests cc ON cc.id = s.contest_id
    WHERE ${recentConds.join(' AND ')}
    ORDER BY s.id DESC LIMIT 10
  `).all(...recentParams);

  // 全部提交数（含赛时，口径与上面的预览列表、与「查看全部 →」一致，同样遵守可见性规则）
  const submitsAll = db.prepare(`
    SELECT COUNT(*) AS c
    FROM submissions s
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN contests cc ON cc.id = s.contest_id
    WHERE ${recentConds.join(' AND ')}
  `).get(...recentParams).c;

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

  // 本请求内的「比赛实时榜单」缓存：computePoints 与 getPointsRankOf 共用，避免重复计算
  const ptsCache = new Map();
  /* 读取规则（见文件末尾「全站积分结算」）：manual / interval 模式**优先读快照**，
   * 该用户没有快照行时**回退实时计算**；realtime 模式**始终实时计算**。
   * 因此任何模式下个人中心都有积分与四维可显示，不会出现空白 / 0 分。 */
  const snapMap = pointsEnabled && pointsUseSnapshot() ? readPointsSnapshots() : null;
  const snap = snapMap ? (snapMap.get(u.id) || null) : null;
  const pts = pointsEnabled ? (snap ? { total: snap.total, breakdown: snap.breakdown } : computePoints(u.id, ptsCache)) : null;
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
    points_rank: pointsEnabled ? getPointsRankOf(u.id, ptsCache, snapMap) : null,
    points_enabled: pointsEnabled,
    stats: {
      solved,
      submits,
      submits_all: submitsAll,
      accepted: ac,
      ac_rate: submits > 0 ? ((ac / submits) * 100).toFixed(1) + '%' : '0%',
    },
    recent_submissions: recent,
    solved_problems: solvedProblems,
    attempted_problems: attemptedProblems,
    favorite_count: favoriteCount,
  };
}

/** 全站积分排名（1-based；竞赛排名：积分相同并列，如 1,1,3）
 *  standingsCache：可选的「本场比赛实时榜单」请求内缓存（见 computePoints），
 *  传入后同一请求里 132 次积分计算只算 13 次榜单；不传则行为与以前完全一致。
 *  snapshotMap：可选的积分快照 Map（见「全站积分结算」）。传 undefined = 按当前模式自动决定
 *  （manual / interval 优先快照，realtime 始终实时）；传 null = 强制全部实时计算。
 *  排名与显示的积分**同源**，避免出现「积分对不上名次」的矛盾。 */
function getPointsRankOf(userId, standingsCache, snapshotMap) {
  const cache = standingsCache || new Map();
  let snap = snapshotMap;
  if (snap === undefined) snap = pointsUseSnapshot() ? readPointsSnapshots() : null;
  const totalOf = (id) => {
    const s = snap ? snap.get(id) : null;
    return s ? s.total : computePoints(id, cache).total;
  };
  const mine = totalOf(userId);
  const all = db.prepare('SELECT id FROM users').all();
  let rank = 1;
  for (const r of all) {
    if (r.id === userId) continue;
    if (totalOf(r.id) > mine) rank++;
  }
  return rank;
}

/* ---------------- 积分权重（v2.6.0：比赛降权、社区提权；纯代码常量） ----------------
 * 为什么改：原口径下「13 场全勤」账号的比赛分**未封顶值**中位 273、最高 1192，而单项满分只有 100 ——
 * 结果是全站 132 个账号的比赛分**全部被打满 100**、毫无区分度；同时社区分只统计「已审核的题解 / 专栏」，
 * 绝大多数账号只有 1~2 分。现在把比赛项整体调小、社区项整体调大，并把「发帖 / 回复 / 被赞」纳入社区分。
 * 这些数字是**纯代码常量**（按用户要求不做成后台可调、不留 settings 开关）：
 * 积分始终是**推导值**（users 表没有 points 列、也没有任何积分缓存表），
 * 因此改完重启服务即全站生效，无需任何「重算写库」动作。每一项都标注了历史值，便于对照与回滚。 */
const POINTS_WEIGHTS = {
  contestScale: 0.15,      // 比赛分整体系数：0.15（新）← 1.0（旧，人人打满 100）
  contestTopFactor: 1.8,   // 比赛排名前 1% 场次的加成：1.8（新）← 3.0（旧，固定值）
  communityScale: 1.6,     // 社区分整体系数：1.6（新）← 1.0（旧）
  // v2.7.8：单篇文章的社区贡献此前偏少（单篇封顶 8 分 × 1.6 = 12.8 分），上调到 12 分（×1.6 = 19.2 分）；
  // 同时把"越靠后越递减"的系数从 0.1 放缓到 0.08，让持续创作的第 2、3 篇不至于掉得太快。
  articleWeight: 12,       // 每篇题解 / 专栏的基础权重（单篇上限同值）：12（v2.7.8）← 8 ← 4（更早）
  discussionWeight: 2.0,   // 每个讨论主题帖贡献：2.0（新）← 0（旧，完全不计分）
  replyWeight: 0.6,        // 每条讨论回复贡献：0.6（新）← 0（旧，完全不计分）
  likeWeight: 0.5,         // 题解 / 专栏每被赞一次贡献：0.5（新）← 0（旧），自赞不计
  likeScoreCap: 20,        // 「被赞」部分的整体上限（分）：防互刷
  // v2.7.8：社区互动单次加分上限（分）。点赞 / 讨论主题帖 / 讨论回复**每次最多 1 分**，
  // 在乘 communityScale 之前先把单次贡献夹到 1/communityScale，保证最终得分里每次 ≤ 1 分。
  communityPerItemCap: 1,
};

/** 积分系统（四维：基础/练习/比赛/社区；基础、练习、社区满分各 100，比赛满分 100 但被
 *  POINTS_WEIGHTS.contestScale（0.15）压缩，实际范围约 20~100；总分上限仍按 400 计）。
 *  计算规格见 docs/CUSTOMIZATION.md「积分系统」章节。二次开发直接改本函数与 POINTS_WEIGHTS。
 *  各维度均带衰减：长时间不活跃不会归零（练习/比赛保留 10%，社区保留 20%）。
 *  standingsCache：可选 Map，用于在**同一请求**内复用每场比赛的实时榜单（纯只读、同一同步批次；
 *  不传 = 与历史行为完全一致），避免「全站积分排名」这种批量计算重复算上百次榜单。 */
function computePoints(userId, standingsCache) {
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

  // ============ 三、比赛分（满分 100；仅计入「已积分结算」且有提交记录的有效场次；被判定作弊的场次不计） ============
  const contestRows = db.prepare(`
    SELECT cr.rank, c.id AS contest_id, c.end_time, c.start_time, c.signup_required,
      (SELECT COUNT(*) FROM contest_registrations r WHERE r.contest_id = c.id) AS total_participants
    FROM contest_registrations cr JOIN contests c ON c.id = cr.contest_id
    WHERE cr.user_id = ? AND c.end_time <= ?
      AND NOT EXISTS (SELECT 1 FROM contest_penalties cp WHERE cp.contest_id = c.id AND cp.user_id = cr.user_id)
    ORDER BY c.end_time ASC
  `).all(userId, now);
  // 有效场次：必须有提交记录（赛时窗口内有提交）才计入。
  // M13：名次以 src/contest.js 的实时排行榜（computeStandings 纯函数）为准，
  // contest_registrations.rank 只当缓存——否则「没人看过榜单 / 还没结算」时 rank=0 会被当成第一名（系数 3.0）。
  const contestApi = require('./contest');
  // 「有赛时提交」的场次集合：一次查询取全部（等价于逐场 COUNT(*) > 0），
  // 避免「132 个用户 × 13 场」在批量算积分时打出 1700+ 次单场计数查询。
  // 比赛积分口径：只统计「已结算等级分」的 Rated 比赛（ratings_applied = 1）；
  // 不评级（rated = 0）的比赛没有等级分，结束后即计入（条件里的 OR 分支）。
  // 这里**只看等级分结算状态**，与任何「积分快照 / 全站积分结算」无关 —— 快照只影响读取，
  // computePoints 本身永远按当前真实数据实时推导。
  const submittedContests = new Set(db.prepare(`
    SELECT DISTINCT s.contest_id AS cid
    FROM submissions s JOIN contests c ON c.id = s.contest_id
    WHERE s.user_id = ? AND s.contest_id IS NOT NULL
      AND s.created_at >= c.start_time AND s.created_at <= c.end_time
      AND (c.rated = 0 OR c.ratings_applied = 1)
  `).all(userId).map((r) => r.cid));
  const validContests = [];
  for (const r of contestRows) {
    if (!submittedContests.has(r.contest_id)) continue;
    let rank = 0;
    let totalP = Math.max(1, r.total_participants);
    try {
      // 同一请求内复用同一场比赛的实时榜单：computeStandings 是**纯只读函数**，而「算某用户积分」
      // /「算全站积分排名」会在一次同步计算里对同一场比赛重复调用上百次（132 人 × 场次）。
      // standingsCache（可选参数，默认不传 = 行为与以前完全一致）只在单次同步批次内存活，
      // 不跨请求、不设过期，因此不会读到旧数据，只是把重复计算收敛为每场一次。
      let st;
      if (standingsCache && standingsCache.has(r.contest_id)) st = standingsCache.get(r.contest_id);
      else {
        st = contestApi.computeStandings(r.contest_id, { is_admin: true });
        if (standingsCache) standingsCache.set(r.contest_id, st);
      }
      const rowsAll = st && !st.hidden && Array.isArray(st.allRows) ? st.allRows : null;
      if (rowsAll) {
        const mine = rowsAll.find((x) => x.user_id === userId);
        if (mine && mine.rank != null) rank = mine.rank;
        // 参数人数取「报名人数」与「实时榜单中实际占名次人数」的较大值，避免 rank > total 导致百分位失真
        totalP = Math.max(totalP, rowsAll.filter((x) => x.rank != null).length, 1);
      }
    } catch { /* 实时计算失败 → 回退下面的缓存值 */ }
    if (!rank) rank = parseInt(r.rank, 10) || 0;                      // 回退：缓存名次
    if (!rank) rank = totalP;                                          // 仍不可知 → 按末位计（不再误当第一名）
    validContests.push({ rank, total_participants: totalP, end_time: r.end_time });
  }
  // 近 30 天参赛场次（有提交）
  const recent30dContests = validContests.filter((c) => now - c.end_time <= 30 * DAY).length;
  // v2.6.0：比赛降权——排名加成阶梯整体收紧 + 最后再乘 POINTS_WEIGHTS.contestScale（0.15）。
  // 前 1% 名次加成 3.0 → 1.8；百分位 5%/10%/25%/50%/75% 各档同步下调一档，
  // 使「名次好」依然明显优于「名次差」（阶梯单调），但不再人人把 100 分打满。
  const topFactor = POINTS_WEIGHTS.contestTopFactor;
  let contestScore = 0;
  for (let idx = 0; idx < validContests.length; idx++) {
    const con = validContests[idx];
    const base = 2 / (1 + Math.exp(-(idx + 1) / 10)) - 1;
    // 排名系数（百分位）
    const totalP = Math.max(1, con.total_participants);
    const percentile = Math.min(1, con.rank / totalP);
    let rankFactor;
    if (percentile <= 0.01) rankFactor = topFactor;
    else if (percentile <= 0.05) rankFactor = 1.5;
    else if (percentile <= 0.10) rankFactor = 1.2;
    else if (percentile <= 0.25) rankFactor = 1.0;
    else if (percentile <= 0.50) rankFactor = 0.8;
    else if (percentile <= 0.75) rankFactor = 0.5;
    else rankFactor = 0.3;
    const freqFactor = 0.5 + 0.5 * Math.min(1, recent30dContests / 5);
    contestScore += base * rankFactor * freqFactor;
  }
  // 比赛分 = 各有效场次贡献之和 × 100 × contestScale（0.15，满分仍为 100）：使“名次越好、场次越多”产生可见积分，
  // 避免单场小系数被取整成 0 导致“比赛积分无法计算”。
  let contest = Math.min(contestScore * 100 * POINTS_WEIGHTS.contestScale, 100);
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

  // ============ 四、社区分（满分 100；M18 提权 + 计分来源扩充为「文章 / 发帖 / 回复 / 被赞」） ============
  const articles = db.prepare(`
    SELECT id, created_at, LENGTH(content) AS word_count FROM editorials
    WHERE user_id = ? AND status = 'approved'
    ORDER BY created_at ASC
  `).all(userId);
  // 历史版本只统计「已审核的题解 / 专栏」，导致社区分极低；
  // 现在把讨论主题帖、讨论回复、题解/专栏收到的赞一并计入，并统一乘社区系数（默认 1.6）。
  const discussionPosts = db.prepare('SELECT id, created_at FROM discussions WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  const discussionReplies = db.prepare('SELECT id, created_at FROM discussion_replies WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  const likesReceived = db.prepare(`
    SELECT l.created_at FROM editorial_likes l
    JOIN editorials e ON e.id = l.editorial_id
    WHERE e.user_id = ? AND e.status = 'approved' AND l.user_id != e.user_id
    ORDER BY l.created_at ASC
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
    // v2.6.0：单篇基础权重从 4 提到 8（POINTS_WEIGHTS.articleWeight），单篇上限同值
    const artWeight = POINTS_WEIGHTS.articleWeight;
    const base = artWeight / (1 + 0.05 * idx);   // v2.7.8 二次改良：递减系数 0.1 → 0.08 → 0.05（第 5、6 篇仍有 ~80% 权重）
    const wc = art.word_count || 0;
    let lengthFactor;
    // v2.7.8 二次改良：篇幅系数的"下限"从 0.3 提到 0.6 —— 原来很短的正常文章只拿 30%，
    // 导致"写得多但每篇不长"的用户反而低于"写得少但篇幅长"的用户（站长实测反馈）。
    // 现在最短也有 60%，长篇仍额外奖励到 1.2，兼顾"数量"与"质量"。
    if (wc < 500) lengthFactor = 0.6;
    else if (wc < 1000) lengthFactor = 0.75;
    else if (wc < 2000) lengthFactor = 0.9;
    else if (wc < 5000) lengthFactor = 1.0;
    else lengthFactor = 1.2;
    let single = base * contFactor * lengthFactor;
    single = Math.min(single, artWeight);
    communityScore += single;
  }
  // 讨论主题帖：权重 2.0（POINTS_WEIGHTS.discussionWeight，历史版本完全不计分），越靠后的帖子贡献越小（1/(1+0.15·idx)）——防刷
  // v2.7.8：单次最多 1 分（communityPerItemCap），避免社区分被少量帖子迅速推高
  const perItemCapRaw = POINTS_WEIGHTS.communityPerItemCap / POINTS_WEIGHTS.communityScale;
  for (let idx = 0; idx < discussionPosts.length; idx++) {
    communityScore += Math.min(POINTS_WEIGHTS.discussionWeight / (1 + 0.15 * idx), perItemCapRaw);
  }
  // 讨论回复：权重 0.6（POINTS_WEIGHTS.replyWeight，历史版本完全不计分），同样递减（1/(1+0.2·idx)），单次最多 1 分
  for (let idx = 0; idx < discussionReplies.length; idx++) {
    communityScore += Math.min(POINTS_WEIGHTS.replyWeight / (1 + 0.2 * idx), perItemCapRaw);
  }
  // 题解/专栏被赞：每次 0.5（POINTS_WEIGHTS.likeWeight），**自赞不计**，单次最多 1 分，且整体上限 20 分（防互刷）
  const likeScore = Math.min(likesReceived.length * Math.min(POINTS_WEIGHTS.likeWeight, perItemCapRaw), POINTS_WEIGHTS.likeScoreCap);
  communityScore += likeScore;
  let community = Math.min(communityScore * POINTS_WEIGHTS.communityScale, 100);
  // 衰减：距最近一次社区活动（发文章 / 发帖 / 回复 / 被赞）> 30 天（比比赛更平缓，最高扣 80%）
  const lastCommunityAt = [
    articles.length ? articles[articles.length - 1].created_at : 0,
    discussionPosts.length ? discussionPosts[discussionPosts.length - 1].created_at : 0,
    discussionReplies.length ? discussionReplies[discussionReplies.length - 1].created_at : 0,
    likesReceived.length ? likesReceived[likesReceived.length - 1].created_at : 0,
  ].reduce((a, b) => Math.max(a, b), 0);
  if (lastCommunityAt) {
    const inactiveMonths = Math.max(0, (now - lastCommunityAt) / DAY / 30);
    if (inactiveMonths > 1) {
      const decay = Math.min(1 - 1 / (1 + 0.2 * Math.pow(inactiveMonths, 1.5)), 0.80);
      community = community * (1 - decay);
    }
    // 长期不活跃：保留最低 20 分（与历史口径一致，只是「活跃」的定义从文章扩展到全部社区行为）
    if ((now - lastCommunityAt) / DAY > 365) community = Math.max(community, 20);
  }

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

/** 全量用户名 → 积分/角色/棕名 映射（前端统一上色）
 *  与排行榜 / 个人中心同一读取规则：manual / interval 优先读快照（无快照回退实时），
 *  realtime 始终实时 —— 保证「用户名颜色」与页面显示的积分永远出自同一口径。
 *
 *  性能（v2.9.0 优化）：每人对 computePoints 要做数次查询，实测 1371 人 **约 2.6 秒**；
 *  而前端（public/js/api.js）**每次页面加载都会请求一次** —— 于是首页每次都被这个接口拖住
 *  （实测首页 5.6 秒的长尾就是它，favicon 也一起被同一连接堵住）。
 *  这里改为 stale-while-revalidate 缓存：TTL 内直接返回；过期后**先返回旧值**、后台异步重算，
 *  请求路径上不再出现 2.6 秒的同步全量计算。积分变化最多滞后 USER_COLORS_TTL_MS（默认 60 秒），
 *  对"用户名配色"这种展示信息足够；需要完全实时可把 TTL 调小。 */
const USER_COLORS_TTL_MS = 60000;
let userColorsCache = null;
let userColorsAt = 0;
let userColorsRefreshing = false;

function buildUserColors() {
  const rows = db.prepare('SELECT id, username, nickname, role, brown_name FROM users').all();
  const map = {};
  const ptsCache = new Map();                 // 同一请求内复用比赛实时榜单（见 computePoints）
  const snap = pointsUseSnapshot() ? readPointsSnapshots() : null;
  for (const r of rows) {
    const s = snap ? snap.get(r.id) : null;
    const pts = s ? { total: s.total } : computePoints(r.id, ptsCache);
    map[r.username] = { points: pts.total, role: r.role, brown_name: !!r.brown_name, nickname: r.nickname || '' };
  }
  return map;
}

/** 后台重算（不阻塞请求）；失败保留旧值，下个请求再触发 */
function refreshUserColors(immediate = false) {
  if (userColorsRefreshing) return;
  userColorsRefreshing = true;
  const run = () => setImmediate(() => {
    try { userColorsCache = buildUserColors(); userColorsAt = Date.now(); }
    catch (e) { console.warn('[OJ] 刷新用户名配色缓存失败：' + ((e && e.message) || e)); }
    finally { userColorsRefreshing = false; }
  });
  if (immediate) run(); else setTimeout(run, 0).unref?.();
}

function getUserColors() {
  if (userColorsCache && Date.now() - userColorsAt < USER_COLORS_TTL_MS) return userColorsCache;
  if (userColorsCache) { refreshUserColors(true); return userColorsCache; }   // 过期：先给旧值，后台刷新
  userColorsCache = buildUserColors();                                      // 冷启动仅第一击付出全量计算
  userColorsAt = Date.now();
  return userColorsCache;
}

/** 启动后预热（unref：不影响进程退出），让第一个访客也不必等那 2.6 秒 */
setTimeout(() => { try { refreshUserColors(true); } catch { /* 忽略 */ } }, 8000).unref?.();

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
    SELECT id, username, nickname, email, role, is_admin, can_speak, can_speak_until, can_editorial, can_editorial_until, banned, banned_until, rating, brown_name, brown_name_until, brown_type, bio, permissions, created_at
    FROM users ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  const { parsePermissions, ALL_PERMISSIONS } = require('./auth');
  // 惰性到期检查会改库：命中到期时重读一次该行，避免本页仍显示已过期的封禁 / 撤销权限 / 棕名
  const reRead = db.prepare(`SELECT banned, banned_until, can_speak, can_speak_until, can_editorial, can_editorial_until, brown_name, brown_name_until, brown_type FROM users WHERE id = ?`);
  return {
    items: rows.map((r) => {
      // 到期自动恢复
      if (checkUserExpiry(r.id)) r = Object.assign({}, r, reRead.get(r.id));
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
        brown_name_until: r.brown_name_until || 0,
        brown_type: r.brown_type || '',
        created_at: r.created_at,
      };
    }),
    total, page, size,
  };
}

/* 社区管理记录：动作 → 中文标签 + 色调（good=授予/解除（绿），bad=撤销/封禁/处罚（红），info=其它变更（蓝））。
   所有动作用户可见文案必须为中文：此前 edit_profile / brown_name / unbrown 未登记，页面会直接显示英文动作名。
   注：v2.8.6 起社区管理页只展示 MOD_PERMISSION_ACTIONS 白名单内的动作，本表仍保留全部登记项
   （其它页面 / 历史数据若引用到这些标签，行为不变）。 */
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
  // 棕名处罚：不再在标签里写处罚类型（plagiarism / cheat 两种类型共用这条标签，原因与期限写在 detail 里）
  brown_name: { label: '棕名处罚', tone: 'bad' },
  unbrown: { label: '解除棕名处罚', tone: 'good' },
  // v2.5.0：内置管理员口令变更审计（admin_audit 的记录同时镜像到这里，后台「社区管理」可直接看到）
  admin_password_seed: { label: '初始化内置管理员口令', tone: 'info' },
  admin_password_self_change: { label: '内置管理员本人修改口令', tone: 'info' },
  admin_password_reset_by_superadmin: { label: '内置管理员重置自己的口令', tone: 'info' },
  admin_password_forgot_reset: { label: '内置管理员找回并重置口令', tone: 'info' },
  admin_password_change_denied: { label: '拦截内置管理员口令变更', tone: 'bad' },
  // v2.7.0：讨论板块 / 文章分类配置管理（后台「板块与分类管理」，仅超级管理员）
  board_create: { label: '新建讨论板块', tone: 'good' },
  board_rename: { label: '重命名讨论板块', tone: 'info' },
  board_delete: { label: '删除讨论板块', tone: 'bad' },
  category_create: { label: '新建文章分类', tone: 'good' },
  category_rename: { label: '重命名文章分类', tone: 'info' },
  category_delete: { label: '删除文章分类', tone: 'bad' },
  // v2.8.3：反馈处理（含已处理 / 已关闭反馈的再次处理）
  feedback_handle: { label: '处理反馈', tone: 'good' },
  feedback_rehandle: { label: '再次处理反馈', tone: 'info' },
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
  if (key.startsWith('admin_password')) return { label: '内置管理员口令变更', tone: key.endsWith('denied') ? 'bad' : 'info' };
  if (key.startsWith('board')) return { label: '讨论板块配置', tone: 'info' };
  if (key.startsWith('category')) return { label: '文章分类配置', tone: 'info' };
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
  // M1 越权加固：
  //   1) 禁止通过该接口修改操作者自己的权限（不能自我提权，也不能自我降权）；
  //   2) 只能授予「操作者自身已有的权限」子集（分权管理员无法越权扩张）；
  //   3) 权限全集（= 超级管理员）只允许内置 admin 账号持有 / 授予；
  //   4) 无「用户管理」权限者？前面已拦截。
  if (Array.isArray(data.permissions)) {
    if (Number(targetId) === Number(actor.id)) {
      return { error: '不能通过该接口修改自己的权限' };
    }
    const permSet = new Set(data.permissions.filter((p) => ALL_PERMISSIONS.includes(p)));
    const nextPerms = ALL_PERMISSIONS.filter((p) => permSet.has(p));
    const isBuiltinAdmin = actor.username === 'admin';
    // 权限全集（= is_superadmin）只允许内置 admin 账号拥有：这里一律拒绝授予全集（含 admin 操作者）
    if (nextPerms.length === ALL_PERMISSIONS.length) {
      return { error: '超级管理员权限（全部权限）仅内置 admin 账号可持有，请改为授予具体的权限子集' };
    }
    if (!isBuiltinAdmin) {
      const exceeding = nextPerms.filter((p) => !hasPerm(actor, p));
      if (exceeding.length) {
        const label = (k) => PERMISSION_LABELS[k] || k;
        return { error: `只能授予自己已拥有的权限，缺少：${exceeding.map(label).join('、')}` };
      }
    }
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

/** 到期自动恢复：封禁 / 撤销权限 / 棕名 带时长到期后自动解除（惰性检查）。
 *
 *  v2.7.0 修复：此前这里只处理 banned / can_speak / can_editorial，**漏了棕名** ——
 *  brown_name_until 写了却从来没有被读过，于是「棕名 14 天」实际上永远不会到期：
 *  用户名会一直显示棕色，直到管理员手动点「解除棕名」。现在把棕名一起纳入惰性到期检查。 */
function checkUserExpiry(userId) {
  const now = Date.now();
  const u = db.prepare('SELECT id, banned, banned_until, can_speak, can_speak_until, can_editorial, can_editorial_until, brown_name, brown_name_until FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  let changed = false;
  if (u.banned === 1 && u.banned_until > 0 && now >= u.banned_until) {
    db.prepare('UPDATE users SET banned = 0, banned_until = 0 WHERE id = ?').run(userId);
    changed = true;
  }
  if (u.can_speak === 0 && u.can_speak_until > 0 && now >= u.can_speak_until) {
    db.prepare('UPDATE users SET can_speak = 1, can_speak_until = 0 WHERE id = ?').run(userId);
    changed = true;
  }
  if (u.can_editorial === 0 && u.can_editorial_until > 0 && now >= u.can_editorial_until) {
    db.prepare('UPDATE users SET can_editorial = 1, can_editorial_until = 0 WHERE id = ?').run(userId);
    changed = true;
  }
  if (u.brown_name === 1 && u.brown_name_until > 0 && now >= u.brown_name_until) {
    db.prepare("UPDATE users SET brown_name = 0, brown_name_until = 0, brown_type = '' WHERE id = ?").run(userId);
    changed = true;
  }
  return changed;
}

// ---------------- 个人资料 / 密码 ----------------

/** 用户名唯一性校验 + 改名次数限制（普通用户一年 3 次；isAdmin 不受限） */
function applyUsernameChange(target, newUsername, isAdmin) {
  const name = String(newUsername || '').trim();
  if (!name) return { error: '用户名不能为空' };
  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(name)) return { error: '用户名需 2~20 位，仅限中英文、数字、下划线、连字符' };
  if (name === target.username) return { ok: true, changed: false };
  // v2.5.0：内置管理员账号的用户名不可修改 —— 「内置 admin」全站以 username 为唯一判据，
  // 若允许改名，既会让内置保护失效，也会把这个受保护的账号名释放给其它管理员占用。
  if (isBuiltinAdminUser(target)) return { error: '内置管理员账号（admin）的用户名不可修改' };
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
  let avatar = avatars.normalize(userId, avatarRaw);
  if (avatar && typeof avatar === 'object' && avatar.error) return avatar;
  // 清除头像时不留下空白：回落到按用户名自动生成的像素画头像（与 GitHub 的做法一致）
  if (!avatar) avatar = avatars.ensureIdenticon(userId, u.username || ('user' + userId)) || '';
  const bio = String(data.bio || '').trim().slice(0, 500);
  if (data.username !== undefined) {
    const r = applyUsernameChange(u, data.username, false);
    if (r.error) return r;
  }
  db.prepare('UPDATE users SET nickname = ?, avatar = ?, bio = ? WHERE id = ?').run(nickname, avatar, bio, userId);
  return { ok: true, avatar };
}

/** 用户自己修改密码。
 *  H3：新口令走统一强度策略；M2：修改成功后吊销该用户其它会话（保留当前会话，前端据此提示「其他设备已退出」）。
 *  v2.5.0：内置 admin 的口令只允许「内置超管会话本人」变更 —— 这里的目标就是会话本人，
 *  守卫仍然照常执行（拒绝即 403 且不写库），并给成功的变更落审计。
 *  @param {string} [ip] 来源 IP（仅用于审计） */
function changePassword(userId, oldPassword, newPassword, keepToken, ip) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return { error: '用户不存在' };
  // 先过内置管理员守卫（授权先于凭据校验）：拒绝时返回 403 且不消耗任何东西
  const guard = guardBuiltinAdminPasswordChange(sanitizeUser(u), u, 'self_change', ip);
  if (!guard.ok) return guard;
  // 空字段单独给出准确文案：留空却提示「当前密码错误」会让人以为是自己记错了口令
  // （v2.5.0 可用性修复：改密表单曾因为只把原因弹 3 秒 toast、文案又不准确，用户表现为「改不动也不知道为什么」）
  if (!String(oldPassword == null ? '' : oldPassword)) return { error: '请输入当前密码', field: 'old_password' };
  if (!String(newPassword == null ? '' : newPassword)) return { error: '请输入新密码', field: 'new_password' };
  if (!verifyPassword(oldPassword, u.password_hash)) return { error: '当前密码错误，请重新输入', field: 'old_password' };
  const policyError = passwordPolicyError(newPassword);
  if (policyError) return { error: policyError, field: 'new_password' };
  if (verifyPassword(newPassword, u.password_hash)) return { error: '新密码不能与当前密码相同', field: 'new_password' };
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword), userId);
  // M17：口令一旦被修改，data/admin-password.txt 里的「初始口令」立即失效，删除该文件（失败不影响改密结果）
  removeAdminPasswordFile(`用户 ${u.username || userId} 自行修改密码`);
  // M2：吊销该用户其它设备的会话；被窃会话 / 丢失设备改密后立即失效
  const revoked = destroyUserSessions(userId, keepToken || null);
  if (guard.builtin) {
    auditBuiltinAdminChanged(sanitizeUser(u), u, 'admin_password_self_change',
      `内置管理员本人在登录状态下修改口令（路径 self_change，已吊销其它会话 ${revoked} 个）`, ip);
  }
  return { ok: true, sessions_revoked: revoked };
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

/** 管理员重置用户密码。
 *  H3：新口令走统一强度策略；M2：重置成功后吊销该用户全部会话（对方需重新登录）。
 *  v2.5.0：内置 admin 的口令只允许内置超管会话（is_superadmin 且 username==='admin'）变更 ——
 *  仅持「用户管理」权限的普通管理员重置 admin 会被 403 拒绝并写审计；普通用户之间能力不变。
 *  @param {string} [ip] 来源 IP（仅用于审计） */
function adminSetPassword(actor, targetId, newPassword, ip) {
  if (!hasPerm(actor, 'user')) return { error: '你没有「用户管理」权限', status: 403 };
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return { error: '用户不存在' };
  // v2.5.0：内置管理员口令变更守卫（唯一判据；拒绝 → 403 + 明确中文提示 + 审计）
  const guard = guardBuiltinAdminPasswordChange(actor, target, 'superadmin_reset', ip);
  if (!guard.ok) return guard;
  const { parsePermissions } = require('./auth');
  if (!isBuiltinAdminUser(target)) {
    // M1 关联加固：重置管理员口令等同于接管其账号，因此不能重置「权限高于自己」的账号
    if (actor.username !== 'admin') {
      const exceeding = parsePermissions(target.permissions).filter((p) => !hasPerm(actor, p));
      if (exceeding.length) return { error: '不能重置权限高于自己的管理员账号的密码' };
    }
  } else if (!isBuiltinAdminUser(actor)) {
    // 双保险：走到这里说明 target 是内置 admin 而 actor 不是内置 admin（正常已被上面的守卫拦下）
    return { error: '内置管理员账号（admin）的口令只能由内置超级管理员本人变更', status: 403 };
  }
  const policyError = passwordPolicyError(newPassword);
  if (policyError) return { error: policyError };
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(newPassword), targetId);
  // M17：任何口令变更都让初始密码文件失效并删除
  removeAdminPasswordFile(`管理员 ${actor.username} 重置用户 ${target.username || targetId} 的密码`);
  // M2：管理员重置口令后，该用户全部会话立即失效
  const revoked = destroyUserSessions(targetId);
  if (guard.builtin) {
    auditBuiltinAdminChanged(actor, target, 'admin_password_reset_by_superadmin',
      `内置管理员口令由内置超管会话重置（路径 superadmin_reset，操作者 ${actor.username}(uid=${actor.id})，已吊销会话 ${revoked} 个）`, ip);
  }
  return { ok: true, sessions_revoked: revoked };
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
  const randomPw = data.random_password === true || data.random_password === 'true' || String(data.password_mode || '') === 'random';
  // 用户要求：批量生成时口令不再受强度策略限制（这些账号创建后仍带 must_change_password=1，首次登录会被要求改密）；
  // 也可以选择「每个账号随机生成密码」。
  if (!randomPw && !password) return { error: '请填写默认密码，或勾选「每个账号随机生成密码」' };
  const emailDomain = String(data.email_domain || '').trim().replace(/^@/, '');
  if (emailDomain && !/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(emailDomain)) return { error: '邮箱域名格式不正确（如 example.com）' };
  if (!prefix && !suffix) return { error: '请至少填写用户名前缀或后缀，以便区分批量用户' };

  const now = Date.now();
  const created = [];
  const skipped = [];
  const insert = db.prepare(`
    INSERT INTO users (id, username, email, password_hash, is_admin, role, can_speak, can_discuss, can_reply, can_editorial, banned, nickname, avatar, bio, rating, email_verified, email_verify_token, permissions, created_at, must_change_password)
    VALUES (?, ?, ?, ?, 0, 'user', 1, 1, 1, 1, 0, '', '', '', 0, 1, '', '', ?, 1)
  `);
  for (let n = start; n <= end; n++) {
    const num = String(n).padStart(digits, '0');
    const username = `${prefix}${num}${suffix}`;
    // 双保险：批量生成的名字里必含数字，永远不可能等于内置 admin；这里再显式挡一次，
    // 避免以后有人改动命名规则后意外覆盖到内置管理员账号名。
    if (isBuiltinAdminUser({ username })) { skipped.push({ username, reason: '内置管理员账号名不可占用' }); continue; }
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) { skipped.push({ username, reason: '不符合用户名规则' }); continue; }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) { skipped.push({ username, reason: '已存在' }); continue; }
    const email = emailDomain ? `${username}@${emailDomain}` : '';
    // 用户编号复用已释放的 uid（与单个注册保持一致）
    const uid = nextFreeId('users');
    const pw = randomPw ? randomBatchPassword() : password;
    insert.run(uid, username, email, hashPassword(pw), now);
    // 与单个注册一致：按用户名生成 GitHub 风格像素画头像
    try {
      const url = require('./avatars').ensureIdenticon(uid, username);
      if (url) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, uid);
    } catch { /* 头像生成失败不影响建号 */ }
    created.push({ username, password: pw, uid });
  }
  return { ok: true, created, skipped, total: created.length, random: randomPw };
}

/** 批量建号用随机口令：保证含字母 / 数字 / 符号各至少一个（长度 12），便于分发后首次登录改密 */
function randomBatchPassword(len = 12) {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#%^&*-_';
  const all = letters + digits + symbols;
  const pick = (s) => s[crypto.randomBytes(1)[0] % s.length];
  const out = [pick(letters), pick(digits), pick(symbols)];
  const buf = crypto.randomBytes(Math.max(0, len - out.length));
  for (let i = 0; i < buf.length; i++) out.push(all[buf[i] % all.length]);
  // 洗牌，避免前三位固定为「字母+数字+符号」
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomBytes(1)[0] % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

// ---------------- 社区管理公布页（只公示「用户权限变更」） ----------------

/**
 * 社区管理页**只**展示「用户权限变更（含棕名处罚）」类记录（站长要求，v2.8.6）。
 *
 * 为什么用白名单而不是黑名单：moderation_logs 同时被当作多套审计的镜像表使用
 *   · 板块 / 分类配置：src/taxonomy.js → board_create / board_rename / board_delete /
 *     category_create / category_rename / category_delete
 *   · 反馈处理：src/feedback.js → feedback_handle / feedback_rehandle
 *   · 数据清理：src/cleanup.js → cleanup_data
 *   · 内置管理员口令：src/db.js → admin_password_*
 *   · 编辑用户资料：src/users.js → edit_profile（本就不展示）
 * 这些都不属于用户权限变更，一律不查询、不展示；黑名单一旦漏掉某个新动作就会重新漏出来，
 * 因此这里写**白名单**：只有下列动作能出现在该页。新增权限动作时必须同步加进这个列表。
 * 注意：这些动作的**写入**（logModeration / 各处审计镜像）完全不变，只是本页查询口径收敛，
 * 通知、审计追溯与其它后台页面（「板块与分类管理」「反馈审核」「群组清理」）都不受影响。
 */
const MOD_PERMISSION_ACTIONS = Object.freeze([
  'ban', 'unban', // 封禁 / 解除封禁
  'grant_speak', 'revoke_speak', // 自由发言
  'grant_discuss', 'revoke_discuss', // 发布讨论
  'grant_reply', 'revoke_reply', // 参与讨论
  'grant_editorial', 'revoke_editorial', // 发布题解
  'grant_permissions', 'revoke_permissions', 'set_permissions', 'set_role', // 权限位 / 权限等级
  'brown_name', 'unbrown', // 棕名处罚 / 解除棕名（含处罚原因与期限，写在 detail 里）
]);

function getModerationLogs(query = {}) {
  const { page, size, offset } = parsePagination(query, 30, 100);
  // 只查白名单内的权限变更动作：kind / action / category / type 等分类参数一律不参与查询，
  // 请求方无法通过 URL 参数把其它分类（板块、分类、反馈、清理、口令…）的记录捞出来。
  const inList = MOD_PERMISSION_ACTIONS.map(() => '?').join(', ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM moderation_logs WHERE action IN (${inList})`)
    .get(...MOD_PERMISSION_ACTIONS).c;
  const rows = db.prepare(`
    SELECT id, admin_id, admin_name, user_id, username, action, detail, created_at
    FROM moderation_logs WHERE action IN (${inList}) ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...MOD_PERMISSION_ACTIONS, size, offset);
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

// ---------------- 棕名处罚（需要「用户管理」权限） ----------------

const BROWN_DAYS = 14;

/**
 * 棕名处罚（plagiarism = 抄题解 / cheat = 比赛作弊）。
 *
 * v2.7.0 修复（**先校验、后写入**）：
 *   此前 4 行代码的顺序是「先 UPDATE users 打上棕名 → 再校验比赛场次」，于是当管理员输入了
 *   一个不存在的比赛场次（前端只校验「必须是数字」，不校验场次是否存在）时：
 *     · 接口返回 400「请选择作弊的比赛场次」，管理员以为没执行；
 *     · 但用户**已经被静默棕名 14 天**（brown_name=1 / brown_name_until / brown_type='cheat'）；
 *     · 既没有 contest_penalties 行、也没有 moderation_logs 审计、没有站内通知；
 *     · 前端收到错误后不会重新渲染，后台连「解除棕名」按钮都不出现 —— 处罚对管理员完全不可见。
 *   现在把**所有校验前置**（权限 → 目标用户 → 内置 admin → 处罚类型 → 比赛场次存在性），
 *   校验全部通过后才在**同一事务**里写 users + contest_penalties / 清练习分，任一步失败整体回滚，
 *   保证「要么完整生效、要么什么都没发生」，并且不会再出现「报了错却已经处罚」的静默状态。
 */
function brownName(actor, targetId, type, contestId) {
  if (!hasPerm(actor, 'user')) return { error: '你没有「用户管理」权限' };
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return { error: '用户不存在' };
  if (target.username === 'admin') return { error: '不能处罚内置管理员' };
  if (!['plagiarism', 'cheat'].includes(type)) return { error: '无效的处罚类型' };

  // ---- 校验阶段：这里任何一步失败都直接返回，数据库一行都不会被改动 ----
  let cid = 0;
  if (type === 'cheat') {
    cid = parseInt(contestId, 10);
    const c = Number.isFinite(cid) && cid > 0 ? db.prepare('SELECT id FROM contests WHERE id = ?').get(cid) : null;
    if (!c) return { error: `比赛场次 #${Number.isFinite(cid) && cid > 0 ? cid : '?'} 不存在，请核对后重试（本次未做任何修改）`, status: 400 };
  }

  // ---- 写入阶段：同一事务，要么全成、要么全回滚 ----
  const until = Date.now() + BROWN_DAYS * 86400000;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET brown_name = 1, brown_name_until = ?, brown_type = ? WHERE id = ?').run(until, type, targetId);
    if (type === 'plagiarism') {
      // 抄题解：清空练习积分（删除其所有 AC 提交），棕名 14 天
      db.prepare("DELETE FROM submissions WHERE user_id = ? AND verdict = 'Accepted'").run(targetId);
    } else {
      // 比赛作弊：该场比赛判 -1 分参与排名与等级分计算，棕名 14 天，不清空练习积分
      db.prepare('INSERT OR IGNORE INTO contest_penalties (contest_id, user_id) VALUES (?, ?)').run(cid, targetId);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return { error: '棕名处罚失败（已回滚，数据未改动）：' + (e && e.message), status: 500 };
  }

  const detail = type === 'plagiarism'
    ? '抄题解处罚：清空练习积分并将所有题目置为未通过，棕名 14 天'
    : `比赛作弊处罚（场次 #${cid}）：该场判 -1 分参与排名与等级分计算，棕名 14 天`;

  logModeration(actor, target, 'brown_name', detail);
  notifications.notify(targetId, 'permission', '棕名处罚', `你已被管理员 ${actor.username} 棕名处罚（${type === 'plagiarism' ? '抄题解' : '比赛作弊'}），棕名期 14 天。${detail}`, '/user/' + targetId);
  return { ok: true, detail, brown_name_until: until };
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

/**
 * 排行榜展示上限（v2.5.5）：站点排行榜只展示**前 500 名**（与 src/ranking.js 的 RANKING_CAP 同源）。
 * 用户数不足 500 时行为不变（total = 真实用户数）。
 */
const RANKING_CAP = require('./ranking').RANKING_CAP;

/** 等级分排行榜（最多前 500 名） */
function getRatingRanking(query = {}) {
  // size 上限同样夹到 RANKING_CAP：请求 size=1000 时最多返回 500 行
  const { page, size, offset } = parsePagination(query, 30, RANKING_CAP);
  const total = Math.min(RANKING_CAP, db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
  // 已越过第 500 名（或超出总人数）：不再返回任何行，翻页到此为止
  if (offset >= total) return { items: [], total, page, size, cap: RANKING_CAP };
  // LIMIT 同样按「距第 500 名还剩多少」夹一次：否则 user > 500 时最后一页会返回 rank > 500 的行
  const limit = Math.min(size, total - offset);
  const rows = db.prepare(`
    SELECT id, username, nickname, role, avatar, rating, rated_games, brown_name, brown_type, banned
    FROM users ORDER BY rating DESC, id ASC LIMIT ? OFFSET ?
  `).all(limit, offset);
  return {
    items: rows.map((r, i) => ({ rank: offset + i + 1, id: r.id, username: r.username, nickname: r.nickname, role: r.role, avatar: r.avatar || '', rating: r.rating, rated_games: r.rated_games, brown_name: !!r.brown_name, banned: !!r.banned })),
    total, page, size, cap: RANKING_CAP,
  };
}

/** 积分排行榜（分页：先取全量排序计算名次，再切片当前页；上限前 500 名） */
function getPointsRanking(query = {}) {
  const settings = require('./settings');
  if (settings.getSetting('points_enabled', '1') !== '1') {
    return { items: [], total: 0, page: 1, size: 30, cap: RANKING_CAP };
  }
  const { page, size } = parsePagination(query, 30, RANKING_CAP);
  const total = Math.min(RANKING_CAP, db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
  // 已越过第 500 名：直接空列表（省掉全量积分计算）
  if ((page - 1) * size >= total) return { items: [], total, page, size, cap: RANKING_CAP };
  const rows = db.prepare('SELECT id, username, nickname, role, avatar, brown_name, banned, can_speak, can_editorial FROM users ORDER BY id ASC').all();
  const ptsCache = new Map();                 // 同一请求内复用比赛实时榜单（见 computePoints）
  // 读取规则（见「全站积分结算」）：manual / interval 优先读快照，无快照的用户回退实时计算；realtime 全部实时
  const snap = pointsUseSnapshot() ? readPointsSnapshots() : null;
  const items = rows.map((r) => {
    const s = snap ? snap.get(r.id) : null;
    const pts = s ? { total: s.total, breakdown: s.breakdown } : computePoints(r.id, ptsCache);
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
  return { items: capped.slice((page - 1) * size, page * size), total, page, size, cap: RANKING_CAP };
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
  // L11：删除提交会改变题目的提交数 / 通过数，先把「受影响的题目」记下来，删完后统一重算统计
  // （与单条删除口径一致；判定口径由 problems.recomputeProblemStats 从 submissions 表推导，不做累加）
  const affectedProblems = new Set();
  const collectProblems = (rows) => { for (const r of rows) if (r.problem_id) affectedProblems.add(r.problem_id); };
  try {
    if (type === 'users') {
      collectProblems(db.prepare(`SELECT DISTINCT problem_id FROM submissions WHERE user_id IN (${placeholders})`).all(...ids));
    } else if (type === 'contests') {
      collectProblems(db.prepare(`SELECT DISTINCT problem_id FROM submissions WHERE contest_id IN (${placeholders})`).all(...ids));
    } else if (type === 'problems') {
      for (const pid of ids) affectedProblems.add(pid);
    }
  } catch { /* ignore */ }
  // M12：批量删除与单条删除口径一致——先把「没有外键级联」与「磁盘残留」的关联数据清干净，
  // 再删主记录，避免编号复用后新对象继承旧数据（头像 / 赛时提交 / 测试数据 / 收藏等）。
  if (type === 'users') {
    // 头像文件先删（数据库里 rows 还在也不影响）
    try {
      const avatars = require('./avatars');
      for (const uid of ids) { try { avatars.remove(uid); } catch { /* ignore */ } }
    } catch { /* ignore */ }
    // 显式清理：提交（含比赛提交）、收藏、会话、私信、等级分、报名、处罚等
    for (const t of ['submissions', 'favorites', 'sessions', 'rating_history', 'contest_registrations',
      'contest_penalties', 'editorial_likes', 'editorial_comments', 'discussion_replies',
      'discussions', 'editorials', 'notifications', 'feedbacks', 'checkins']) {
      try { db.prepare(`DELETE FROM ${t} WHERE user_id IN (${placeholders})`).run(...ids); } catch { /* 表不存在则跳过 */ }
    }
    // 私信会话：user_a / user_b 任一命中都要清（messages 由会话外键级联）
    try { db.prepare(`DELETE FROM conversations WHERE user_a IN (${placeholders}) OR user_b IN (${placeholders})`).run(...ids, ...ids); } catch { /* ignore */ }
  }
  if (type === 'problems') {
    // 测试数据目录 / 附件目录（提交记录由外键 CASCADE 处理）
    try {
      const { problemDir } = require('./db');
      const fs = require('fs');
      for (const pid of ids) { try { fs.rmSync(problemDir(pid), { recursive: true, force: true }); } catch { /* ignore */ } }
    } catch { /* ignore */ }
    try {
      const attachments = require('./attachments');
      for (const pid of ids) { try { attachments.removeAll(pid); } catch { /* ignore */ } }
    } catch { /* ignore */ }
    try { db.prepare(`DELETE FROM favorites WHERE item_type = 'problem' AND item_id IN (${placeholders})`).run(...ids); } catch { /* ignore */ }
  }
  if (type === 'contests') {
    // 赛时提交没有外键，必须显式清理（否则编号复用后旧提交会归入新比赛）
    db.prepare(`DELETE FROM submissions WHERE contest_id IN (${placeholders})`).run(...ids);
    try { db.prepare(`DELETE FROM favorites WHERE item_type = 'contest' AND item_id IN (${placeholders})`).run(...ids); } catch { /* ignore */ }
  }
  if (type === 'discussions') {
    try { db.prepare(`DELETE FROM favorites WHERE item_type = 'discussion' AND item_id IN (${placeholders})`).run(...ids); } catch { /* ignore */ }
  }
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
  // L11：删完提交后重算受影响题目的提交数 / 通过数（列表与详情页的通过率不再虚高）。
  // 题目本身已被删除时跳过（该行已不存在，无需重算）。
  let statsUpdated = 0;
  try {
    const problems = require('./problems');
    for (const pid of affectedProblems) {
      if (!db.prepare('SELECT id FROM problems WHERE id = ?').get(pid)) continue;
      try { problems.recomputeProblemStats(pid); statsUpdated++; } catch { /* 单题失败不影响删除 */ }
    }
  } catch { /* ignore */ }
  return { ok: true, count, stats_updated: statsUpdated };
}

/* ==================== 全站积分结算（v2.7.8） ====================
 * 为什么需要：积分是**纯推导值**（users 表没有 points 列），排行榜 / 个人中心 / 用户名上色
 * 每次请求都要为全站用户跑一遍 computePoints —— 1371 人实测约 2.6 s，随用户数线性变慢。
 * 「全站积分结算」把某一时刻的全站四维积分**落库成快照**（points_settlement 表），
 * 读取侧一次查询即可取回全部积分，同时留下可追溯的历史。
 *
 * 三种模式（settings.points_settle_mode）与**读取规则**（务必与代码保持一致）：
 *   · realtime 实时（**默认**，v2.7.8 起）：调度器每次 tick 都执行一轮（快照仍然写，但**只作历史**）；
 *              读取侧**始终实时计算**（computePoints），显示值与不开本功能时逐位一致。
 *   · manual   手动结算：只有管理员点「立即结算全站积分」才写快照；
 *              读取侧**优先读快照**，某用户没有快照行时**回退实时计算**（所以永远不会有空白 / 0 分）。
 *   · interval 定时自动：后台调度器每 60 秒 tick 一次，距上次结算超过
 *              points_settle_interval_minutes（**1 小时 ~ 30 天** = 60 ~ 43200 分钟）才执行一轮；
 *              读取侧同 manual（优先快照，缺失回退实时）。界面按「小时 / 天」录入与展示，
 *              存储仍统一用分钟（保持既有键 points_settle_interval_minutes 兼容）。
 * 关键：computePoints 本身**从不读快照** —— 快照只影响「读取」这一步，
 * 因此不存在「结算一次就把数据写错」的问题，快照随时可由下一次结算整体覆盖。
 */
const POINTS_SETTLE_MODES = ['manual', 'interval', 'realtime'];
const POINTS_SETTLE_DEFAULT_MODE = 'realtime';   // v2.7.8：默认实时结算（新装站点即实时）
const POINTS_SETTLE_MIN_MINUTES = 60;          // 1 小时（界面下限；单位下拉只有「小时 / 天」）
const POINTS_SETTLE_MAX_MINUTES = 43200;       // 30 天（界面上限）
const POINTS_SETTLE_DEFAULT_MINUTES = 360;     // 6 小时（界面留空时的默认间隔）
const POINTS_SETTLE_TICK_MS = 60 * 1000;      // 调度器 tick 周期（server.js 共用）

/** 分钟 → 最自然的「小时 / 天」单位（界面与中文提示共用口径）。
 *  整除 1 天 → 天；整除 1 小时 → 小时；否则折算成小数小时（如 90 → 1.5 小时），**永不出现「分钟」字样**。 */
function minutesToSettleUnit(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m > 0 && m % 1440 === 0) return { value: m / 1440, unit: 'day', label: '天' };
  if (m > 0 && m % 60 === 0) return { value: m / 60, unit: 'hour', label: '小时' };
  return { value: Math.round((m / 60) * 100) / 100, unit: 'hour', label: '小时' };
}

/** 分钟 → 中文「小时 / 天」文案（如 360 → 「6 小时」、2880 → 「2 天」、30 → 「0.5 小时」）。
 *  用于服务端 400 校验提示与状态行，保证界面口径统一（**不出现「分钟」字样**）。 */
function formatSettleIntervalText(minutes) {
  const u = minutesToSettleUnit(minutes);
  return `${u.value} ${u.label}`;
}

/** 每批结算的用户数：computePoints 是同步函数，分批 + 批间让出事件循环，
 *  使「单次连续阻塞」远小于整轮全量（1371 人整轮约 3 s，单批实测约 0.2 s）。 */
const POINTS_SETTLE_CHUNK = 100;

/** 当前结算模式（未设置 / 非法值 → realtime 默认实时） */
function getPointsSettleMode() {
  try {
    const m = String(require('./settings').getSetting('points_settle_mode', POINTS_SETTLE_DEFAULT_MODE) || POINTS_SETTLE_DEFAULT_MODE).trim();
    return POINTS_SETTLE_MODES.includes(m) ? m : POINTS_SETTLE_DEFAULT_MODE;
  } catch { return POINTS_SETTLE_DEFAULT_MODE; }
}

/** 定时间隔（分钟；现读设置并夹到 1 小时 ~ 30 天，未设置 → 6 小时 = 360） */
function getPointsSettleIntervalMinutes() {
  try { return require('./settings').getIntSetting('points_settle_interval_minutes', POINTS_SETTLE_DEFAULT_MINUTES, POINTS_SETTLE_MIN_MINUTES, POINTS_SETTLE_MAX_MINUTES); }
  catch { return POINTS_SETTLE_DEFAULT_MINUTES; }
}

/** 上次结算时间戳；0 = 从未结算 */
function getPointsSettleLastRun() {
  try { return parseInt(require('./settings').getSetting('points_settle_last_run', '0'), 10) || 0; }
  catch { return 0; }
}

/** 读取侧是否优先使用快照：`realtime` 模式始终实时计算，其余模式优先快照 */
function pointsUseSnapshot() { return getPointsSettleMode() !== 'realtime'; }

/** 全站积分快照：Map<user_id, {total, breakdown, settled_at}>；从未结算 = 空 Map（全部回退实时计算） */
function readPointsSnapshots() {
  const map = new Map();
  try {
    for (const r of db.prepare('SELECT user_id, total, base, practice, contest, community, settled_at FROM points_settlement').all()) {
      map.set(r.user_id, {
        total: r.total,
        breakdown: { base: r.base, practice: r.practice, contest: r.contest, community: r.community },
        settled_at: r.settled_at,
      });
    }
  } catch { /* 表不存在（极旧库）→ 空 Map → 全部走实时计算 */ }
  return map;
}

/** 单个用户的积分快照（null = 没有 → 调用方回退实时计算） */
function readPointsSnapshot(userId) {
  try {
    const r = db.prepare('SELECT total, base, practice, contest, community, settled_at FROM points_settlement WHERE user_id = ?').get(userId);
    if (!r) return null;
    return { total: r.total, breakdown: { base: r.base, practice: r.practice, contest: r.contest, community: r.community }, settled_at: r.settled_at };
  } catch { return null; }
}

/** 快照行数（= 上次结算覆盖的用户数；0 = 从未结算） */
function countPointsSnapshots() {
  try { return db.prepare('SELECT COUNT(*) AS c FROM points_settlement').get().c; } catch { return 0; }
}

/** 快照里最新的 settled_at（用于状态行显示「快照时间」） */
function pointsSnapshotAt() {
  try { return db.prepare('SELECT MAX(settled_at) AS m FROM points_settlement').get().m || 0; } catch { return 0; }
}

/** 一轮全站积分结算：对**全部用户**调用 computePoints（同一批次复用榜单缓存）并落库快照。
 *  · **先逐场预热榜单缓存**（每场一次 setImmediate 让出）：否则第一个用户批次会独自承担
 *    全部 13 场比赛的 computeStandings 计算（实测一次约 2.2 秒，正是要避免的长阻塞）；
 *  · 再分批执行（POINTS_SETTLE_CHUNK 人 / 批），批间用 setImmediate 让出事件循环；
 *  · 每批一个事务（BEGIN / COMMIT），某批失败只回滚该批并记录，不影响其它批（调用方整体 try/catch）；
 *  · 返回实测数据（含「单次最长阻塞」max_chunk_ms），供审计与状态行使用。
 *  @returns {Promise<{users:number, ok:number, failed:number, failures:Array, ms:number, max_chunk_ms:number, chunk_size:number}>} */
async function settleAllPoints(opts = {}) {
  const chunk = Math.max(1, parseInt(opts.chunkSize, 10) || POINTS_SETTLE_CHUNK);
  const now = Date.now();
  const started = now;
  const ids = db.prepare('SELECT id FROM users ORDER BY id ASC').all().map((r) => r.id);
  const standingsCache = new Map();        // 同一批次复用每场比赛的实时榜单（见 computePoints）
  const contestApi = require('./contest');
  let maxChunkMs = 0;
  const mark = (t0) => { const dt = Date.now() - t0; if (dt > maxChunkMs) maxChunkMs = dt; };

  // 1) 预热：逐场算榜单并缓存（每场之间让出事件循环 → 单次阻塞 ≈ 一场榜单的计算时间）
  const contestIds = db.prepare('SELECT id FROM contests ORDER BY id ASC').all().map((r) => r.id);
  for (const cid of contestIds) {
    const t0 = Date.now();
    try {
      if (!standingsCache.has(cid)) standingsCache.set(cid, contestApi.computeStandings(cid, { is_admin: true }));
    } catch { /* 单场失败 → 不写缓存，computePoints 内部按缓存名次回退 */ }
    mark(t0);
    await new Promise((r) => setImmediate(r));
  }

  // 2) 分批结算全站用户
  const upsert = db.prepare(`
    INSERT INTO points_settlement (user_id, total, base, practice, contest, community, settled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total = excluded.total, base = excluded.base, practice = excluded.practice,
      contest = excluded.contest, community = excluded.community, settled_at = excluded.settled_at
  `);
  let ok = 0;
  const failures = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const t0 = Date.now();
    let inTx = false;
    let lastErr = null;
    // v2.7.9：批事务加 **SQLITE_BUSY 指数退避重试**（80/160/320ms，最多 4 次）。
    // 背景：实测日志出现 19 次「database is locked」，最近一轮 0/1371 全失败——
    // 判题/提交写入与结算事务并发时，SQLite 会直接抛 busy；旧实现一次失败就丢整批。
    // 另外把 ok 的累加移到 COMMIT 成功之后：旧实现在事务内 ok++，失败批次也会被计入成功数。
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        db.exec('BEGIN');
        inTx = true;
        for (const uid of slice) {
          const p = computePoints(uid, standingsCache);
          upsert.run(uid, p.total, p.breakdown.base, p.breakdown.practice, p.breakdown.contest, p.breakdown.community, now);
        }
        db.exec('COMMIT');
        inTx = false;
        ok += slice.length;
        lastErr = null;
        break;
      } catch (e) {
        if (inTx) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } inTx = false; }
        lastErr = e;
        const msg = (e && e.message) || String(e);
        if (!/locked|busy|SQLITE_BUSY/i.test(msg) || attempt === 3) break;
        await new Promise((r) => setTimeout(r, 80 * Math.pow(2, attempt)));
      }
    }
    if (lastErr) failures.push({ from: slice[0], to: slice[slice.length - 1], error: (lastErr && lastErr.message) || String(lastErr) });
    const dt = Date.now() - t0;
    if (dt > maxChunkMs) maxChunkMs = dt;
    // 让出事件循环：批间的 await 让 HTTP 请求 / 其它事务有机会插进来
    await new Promise((r) => setImmediate(r));
  }
  return { users: ids.length, ok, failed: failures.length, failures, ms: Date.now() - started, max_chunk_ms: maxChunkMs, chunk_size: chunk };
}
/** 「功能设置」页状态行所需的全部数据：模式 / 间隔 / 上次结算（时间 + 耗时 + 覆盖人数）/ 下次预计 / 快照时间 */
function getPointsSettleStatus(now = Date.now()) {
  const s = require('./settings');
  const mode = getPointsSettleMode();
  const interval = getPointsSettleIntervalMinutes();
  const last = getPointsSettleLastRun();
  let next = 0;
  if (mode === 'realtime') next = now + POINTS_SETTLE_TICK_MS;
  else if (mode === 'interval') {
    const due = last + interval * 60000;
    next = due > now ? due : now + POINTS_SETTLE_TICK_MS;
  }
  let lastMs = 0;
  let lastUsers = 0;
  try {
    lastMs = parseInt(s.getSetting('points_settle_last_ms', '0'), 10) || 0;
    lastUsers = parseInt(s.getSetting('points_settle_last_users', '0'), 10) || 0;
  } catch { /* ignore */ }
  return {
    mode,
    interval_minutes: interval,
    last_run: last,
    last_ms: lastMs,
    last_users: lastUsers,
    next_run: next,
    snapshot_users: countPointsSnapshots(),
    snapshot_at: pointsSnapshotAt(),
  };
}

module.exports = {
  getProfile,
  computePoints,
  POINTS_WEIGHTS,
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
  MOD_PERMISSION_ACTIONS, // 社区管理页允许展示的动作白名单（供自检 / 测试断言用）
  brownName,
  unBrown,
  getRatingRanking,
  getPointsRanking,
  getCheckinStatus,
  doCheckin,
  getUserColors,
  batchDelete,
  batchCreateUsers,
  POINTS_SETTLE_MODES,
  POINTS_SETTLE_DEFAULT_MODE,
  POINTS_SETTLE_MIN_MINUTES,
  POINTS_SETTLE_MAX_MINUTES,
  POINTS_SETTLE_DEFAULT_MINUTES,
  POINTS_SETTLE_TICK_MS,
  minutesToSettleUnit,
  formatSettleIntervalText,
  getPointsSettleMode,
  getPointsSettleIntervalMinutes,
  getPointsSettleLastRun,
  getPointsSettleStatus,
  pointsUseSnapshot,
  readPointsSnapshots,
  readPointsSnapshot,
  countPointsSnapshots,
  pointsSnapshotAt,
  settleAllPoints,
};
