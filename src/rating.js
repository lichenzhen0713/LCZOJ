'use strict';

const { db } = require('./db');

/**
 * 等级分计算（期望排名公式，参考公开的 Codeforces 结算方法）。
 * users: [{ id, rating, rank }]，rank 从 1 开始。
 * 返回 [{ id, delta }]。
 */
function calcRatingChanges(users) {
  const n = users.length;
  if (n < 2) return users.map((u) => ({ id: u.id, delta: 0 }));

  const P = (i, j) => 1 / (1 + Math.pow(10, (users[j].rating - users[i].rating) / 400));

  // 期望排名 seed
  const seed = users.map((u, i) => 1 + users.reduce((s, o, j) => (j !== i ? s + P(j, i) : s), 0));

  // seed 与实际排名的几何平均 m
  const m = users.map((u, i) => Math.sqrt(seed[i] * u.rank));

  // 二分查找新 rating R：使 seed(R) == m（seed 随 R 增大而减小）
  const newRating = users.map((u, i) => {
    let lo = 1, hi = 4000;
    while (hi - lo > 0.001) {
      const mid = (lo + hi) / 2;
      // P(对手 j 战胜候选 R) = 1 / (1 + 10^((R - r_j)/400))
      const s = 1 + users.reduce((acc, o, j) => (j !== i ? acc + 1 / (1 + Math.pow(10, (mid - o.rating) / 400)) : acc), 0);
      if (s >= m[i]) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  });

  // 变化值 d = (R - r) / 2
  const d = users.map((u, i) => (newRating[i] - u.rating) / 2);

  // 第一次微调：平均变化接近 0
  const sumD = d.reduce((a, b) => a + b, 0);
  const inc1 = (n - 1 - sumD) / n;
  for (let i = 0; i < n; i++) d[i] += inc1;

  // 第二次微调：取前 s 名，使其平均变化为 0（inc 限制在 [-10, 0]）
  const s = Math.min(n, Math.floor(4 * Math.sqrt(n)));
  const topD = d.slice(0, s).reduce((a, b) => a + b, 0);
  let inc2 = -topD / s;
  inc2 = Math.min(Math.max(inc2, -10), 0);
  for (let i = 0; i < s; i++) d[i] += inc2;

  return users.map((u, i) => ({ id: u.id, delta: Math.round(d[i]) }));
}

/** 新号前 6 场的加成（CF 2020 规则） */
const NEW_RATING_ADDITIONS = [500, 350, 250, 150, 100, 50];
// 第 k 场（1-based）比赛前的累计加成
const PREFIX_BEFORE = [0, 500, 850, 1100, 1250, 1350];
// 第 k 场比赛后的累计加成
const PREFIX_AFTER = [500, 850, 1100, 1250, 1350, 1400];

/**
 * 计算并应用一场 Rated 比赛的等级分变化。
 * standingsRows: [{user_id, rank, score}]（按排名升序），
 * ratingThreshold > 0 时高于阈值的用户不参与。
 */
function applyContestRatings(contestId, standingsRows, ratingThreshold) {
  const eligible = standingsRows.filter((r) => r.score >= 0 && r.rank >= 1);
  // 过滤阈值（0 表示无限制）
  let participants = eligible;
  if (ratingThreshold > 0) {
    const userRatings = db.prepare('SELECT id, rating FROM users WHERE id IN (' + eligible.map(() => '?').join(',') + ')')
      .all(...eligible.map((r) => r.user_id));
    const rm = {};
    for (const u of userRatings) rm[u.id] = u.rating;
    participants = eligible.filter((r) => (rm[r.user_id] || 0) < ratingThreshold);
  }

  // 阈值过滤后排名可能不连续，重新按原排名排序并规范化为 1..n
  participants.sort((a, b) => a.rank - b.rank);
  participants.forEach((r, i) => { r.rank = i + 1; });

  const userIds = participants.map((r) => r.user_id);
  if (userIds.length < 2) {
    // 不足 2 人无法结算，但仍标记为已结算，避免管理员反复点击
    db.prepare('UPDATE contests SET ratings_applied = 1 WHERE id = ?').run(contestId);
    return { count: userIds.length, skipped: true };
  }

  const users = db.prepare('SELECT id, rating, rated_games FROM users WHERE id IN (' + userIds.map(() => '?').join(',') + ')')
    .all(...userIds);
  const userMap = {};
  for (const u of users) userMap[u.id] = u;

  const calcInput = participants.map((r) => {
    const u = userMap[r.user_id];
    const games = u ? (u.rated_games || 0) : 0;
    // 新号（前 6 场）使用虚拟 rating
    const virtualRating = games < 6 ? 1400 + PREFIX_BEFORE[games] : (u ? u.rating : 0);
    return { id: r.user_id, rating: virtualRating, rank: r.rank };
  });
  const changes = calcRatingChanges(calcInput);

  const apply = db.prepare('UPDATE users SET rating = ?, rated_games = rated_games + 1 WHERE id = ?');
  const now = Date.now();
  const histInsert = db.prepare('INSERT INTO rating_history (user_id, contest_id, rating_before, rating_after, delta, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const ch of changes) {
    const u = userMap[ch.id];
    const games = u ? (u.rated_games || 0) : 0;
    const before = u ? (u.rating || 0) : 0;
    let newRating;
    if (games < 6) {
      newRating = PREFIX_AFTER[games] + ch.delta;
    } else {
      newRating = (u ? u.rating : 0) + ch.delta;
    }
    newRating = Math.max(0, newRating);
    apply.run(newRating, ch.id);
    histInsert.run(ch.id, contestId, before, newRating, newRating - before, now);
  }
  db.prepare('UPDATE contests SET ratings_applied = 1 WHERE id = ?').run(contestId);
  return { count: changes.length, skipped: false };
}

module.exports = { calcRatingChanges, applyContestRatings };
