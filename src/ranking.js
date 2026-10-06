'use strict';

const { db } = require('./db');
const { parsePagination } = require('./util');

/**
 * 排行榜展示上限（v2.5.5）：全站排行榜（通过题数 / 等级分 / 积分）**只展示前 500 名**。
 * 三个排行榜接口共用本常量，保证口径一致：
 *   · total 一律按 min(真实用户数, 500) 返回 → 前端分页最多 500 / size 页，翻页不会越过第 500 名；
 *   · offset 达到上限时直接返回空列表，绝不会取到第 500 名之后的行；
 *   · size 上限也取本值（请求 size=1000 时夹到 500，单次响应行数恒 ≤ 500）。
 */
const RANKING_CAP = 500;

/** 题库 AC 排行榜（分页，最多前 500 名） */
function getRanking(query = {}) {
  const { page, size, offset } = parsePagination(query, 30, RANKING_CAP);
  const total = Math.min(RANKING_CAP, db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
  // 已翻到第 500 名之后：不再返回任何行（total 也不会随之增大）
  if (offset >= total) return { items: [], total, page, size, cap: RANKING_CAP };
  // LIMIT 必须按「距第 500 名还剩多少」夹一次，否则 size=30 时第 17 页会返回 rank 481..510，
  // 越过第 500 名（用户数 > 500 时才会暴露，构造 700 用户的副本可复现）。
  const limit = Math.min(size, total - offset);
  const rows = db.prepare(`
    SELECT u.id, u.username, u.bio, u.created_at,
      (SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.verdict = 'Accepted' AND s.contest_id IS NULL) AS solved,
      (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id AND s.contest_id IS NULL) AS submits,
      (SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.verdict = 'Accepted' AND s.contest_id IS NULL) * 1.0 /
        NULLIF((SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.contest_id IS NULL), 0) AS ac_rate
    FROM users u
    ORDER BY solved DESC, submits ASC, u.id ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  return {
    items: rows.map((r, i) => ({
      rank: offset + i + 1,
      id: r.id,
      username: r.username,
      bio: r.bio,
      solved: r.solved,
      submits: r.submits,
      created_at: r.created_at,
    })),
    total, page, size, cap: RANKING_CAP,
  };
}

module.exports = { getRanking, RANKING_CAP };
