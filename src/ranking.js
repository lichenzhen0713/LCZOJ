'use strict';

const { db } = require('./db');
const { parsePagination } = require('./util');

/** 题库 AC 排行榜（分页） */
function getRanking(query = {}) {
  const { page, size, offset } = parsePagination(query, 30, 100);
  const total = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.bio, u.created_at,
      (SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.verdict = 'Accepted' AND s.contest_id IS NULL) AS solved,
      (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id AND s.contest_id IS NULL) AS submits,
      (SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.verdict = 'Accepted' AND s.contest_id IS NULL) * 1.0 /
        NULLIF((SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.contest_id IS NULL), 0) AS ac_rate
    FROM users u
    ORDER BY solved DESC, submits ASC, u.id ASC
    LIMIT ? OFFSET ?
  `).all(size, offset);

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
    total, page, size,
  };
}

module.exports = { getRanking };
