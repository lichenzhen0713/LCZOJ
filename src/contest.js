'use strict';

const { db } = require('./db');
const { markdownToHtml } = require('./markdown');
const { parsePagination } = require('./util');

// ACM：通过题数+罚时；IOI：每题取最高分；OI：每题取最后一次提交的成绩（NOI 风格）
const CONTEST_TYPES = ['ACM', 'IOI', 'OI'];

function contestStatus(c, now = Date.now()) {
  if (now < c.start_time) return 'upcoming';
  if (now > c.end_time) return 'ended';
  return 'running';
}

const STATUS_LABEL = { upcoming: '未开始', running: '进行中', ended: '已结束' };

function serializeBrief(c, now) {
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    status: contestStatus(c, now),
    status_label: STATUS_LABEL[contestStatus(c, now)],
    start_time: c.start_time,
    end_time: c.end_time,
    signup_required: !!c.signup_required,
    rated: !!c.rated,
    rating_threshold: c.rating_threshold || 0,
    ratings_applied: !!c.ratings_applied,
    is_public: !!c.is_public,
    problem_count: c.problem_count || 0,
    participant_count: c.participant_count || 0,
  };
}

function listContests(query, isAdmin) {
  const { page, size, offset } = parsePagination(query, 20, 50);
  const now = Date.now();
  const search = (query.get('search') || '').trim();
  const conds = isAdmin && query.get('all') === '1' ? [] : ['is_public = 1'];
  const params = [];
  if (search) { conds.push('c.title LIKE ?'); params.push(`%${search}%`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM contests c ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
      CASE WHEN c.signup_required = 1
        THEN (SELECT COUNT(*) FROM contest_registrations r WHERE r.contest_id = c.id)
        ELSE (SELECT COUNT(DISTINCT s.user_id) FROM submissions s WHERE s.contest_id = c.id)
      END AS participant_count
    FROM contests c
    ${where}
    ORDER BY c.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  return { items: rows.map((r) => serializeBrief(r, now)), total, page, size };
}

function getContest(id, userId, isAdmin) {
  const row = db.prepare('SELECT * FROM contests WHERE id = ?').get(id);
  if (!row) return null;
  if (!row.is_public && !isAdmin) return { forbidden: true };
  const now = Date.now();
  const cps = db.prepare(`
    SELECT cp.letter, cp.problem_id, p.title
    FROM contest_problems cp JOIN problems p ON p.id = cp.problem_id
    WHERE cp.contest_id = ? ORDER BY cp.sort_order ASC, cp.id ASC
  `).all(id);

  const problems = cps.map((cp) => {
    let user_ac = false;
    let submitted = false;
    let bestScore = 0;
    if (userId) {
      // 独立于题库：仅统计本场比赛窗口内的提交（与排行榜口径一致）
      const rows = db.prepare(
        'SELECT verdict, score FROM submissions WHERE user_id = ? AND problem_id = ? AND contest_id = ? AND created_at >= ? AND created_at <= ?'
      ).all(userId, cp.problem_id, id, row.start_time, row.end_time);
      submitted = rows.length > 0;
      user_ac = rows.some((r) => r.verdict === 'Accepted');
      bestScore = rows.reduce((m, r) => Math.max(m, r.score || 0), 0);
    }
    return { letter: cp.letter, problem_id: cp.problem_id, title: cp.title, user_ac, submitted, score: bestScore };
  });

  const status = contestStatus(row, now);
  const signupCount = db.prepare('SELECT COUNT(*) AS c FROM contest_registrations WHERE contest_id = ?').get(id).c;
  const signedUp = userId ? isSignedUp(id, userId) : false;
  const ratedOpt = userId ? (db.prepare('SELECT rated FROM contest_registrations WHERE contest_id = ? AND user_id = ?').get(id, userId) || {}).rated : null;
  // 题目可见性：需报名的比赛——未报名用户只能看到比赛描述（题目一律锁定），
  // 已报名用户也在比赛开始后才能看到题目；管理员不受限
  let canViewProblems = isAdmin || (signedUp && status !== 'upcoming');
  // 本场我的等级分变化：已结算且有记录（计分且实际参与）时返回
  let my_rating_change = null;
  if (userId && row.ratings_applied) {
    const rh = db.prepare('SELECT rating_before, rating_after, delta FROM rating_history WHERE user_id = ? AND contest_id = ?').get(userId, id);
    if (rh) my_rating_change = { before: rh.rating_before, after: rh.rating_after, delta: rh.delta };
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    description_html: markdownToHtml(row.description),
    type: row.type,
    status,
    status_label: STATUS_LABEL[status],
    start_time: row.start_time,
    end_time: row.end_time,
    signup_required: !!row.signup_required,
    rated: !!row.rated,
    rating_threshold: row.rating_threshold || 0,
    ratings_applied: !!row.ratings_applied,
    signup_count: signupCount,
    signed_up: signedUp,
    my_rated: ratedOpt,
    my_rating_change,
    is_public: !!row.is_public,
    can_submit: ((status === 'running' || isAdmin) && canViewProblems) && !!userId && signedUp,
    can_signup: !!row.signup_required && status !== 'ended',
    can_view_problems: canViewProblems,
    problems: canViewProblems ? problems : [],
  };
}

function createContest(data, adminId) {
  const title = String(data.title || '').trim();
  if (!title) return { error: '比赛名称不能为空' };
  const type = CONTEST_TYPES.includes(data.type) ? data.type : 'ACM';
  const start = parseInt(data.start_time, 10);
  const end = parseInt(data.end_time, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: '开始/结束时间无效' };
  if (end <= start) return { error: '结束时间必须晚于开始时间' };
  const info = db.prepare(`
    INSERT INTO contests (id, title, description, start_time, end_time, type, signup_required, rated, rating_threshold, is_public, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(require('./db').nextFreeId('contests'), title, String(data.description || ''), start, end, type,
    1, // 比赛必须报名（signup_required 恒为 1）
    data.rated === true ? 1 : 0,
    Math.max(0, parseInt(data.rating_threshold || '0', 10) || 0),
    data.is_public === false ? 0 : 1, adminId, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

function updateContest(id, data) {
  const row = db.prepare('SELECT id FROM contests WHERE id = ?').get(id);
  if (!row) return { error: '比赛不存在' };
  const type = CONTEST_TYPES.includes(data.type) ? data.type : 'ACM';
  const start = parseInt(data.start_time, 10);
  const end = parseInt(data.end_time, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: '开始/结束时间无效' };
  if (end <= start) return { error: '结束时间必须晚于开始时间' };
  db.prepare(`
    UPDATE contests SET title=?, description=?, start_time=?, end_time=?, type=?, signup_required=?, rated=?, rating_threshold=?, is_public=? WHERE id=?
  `).run(String(data.title || '').trim(), String(data.description || ''), start, end, type,
    1, // 比赛必须报名（signup_required 恒为 1）
    data.rated === true ? 1 : 0,
    Math.max(0, parseInt(data.rating_threshold || '0', 10) || 0),
    data.is_public === false ? 0 : 1, id);
  return { id: Number(id) };
}

/** 删除比赛：连带删除赛题关联、报名记录与赛时提交
 *  （contest_problems / contest_registrations 有外键级联，submissions.contest_id 没有外键，需显式清理） */
function deleteContest(id) {
  const cid = parseInt(id, 10);
  if (!Number.isFinite(cid)) return { error: '比赛不存在' };
  const row = db.prepare('SELECT id FROM contests WHERE id = ?').get(cid);
  if (!row) return { error: '比赛不存在' };
  db.prepare('DELETE FROM submissions WHERE contest_id = ?').run(cid);
  db.prepare('DELETE FROM contest_registrations WHERE contest_id = ?').run(cid);
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(cid);
  const info = db.prepare('DELETE FROM contests WHERE id = ?').run(cid);
  return info.changes > 0;
}

/** 一键切换比赛公开可见性 */
function toggleContestPublic(id) {
  const row = db.prepare('SELECT id, is_public FROM contests WHERE id = ?').get(id);
  if (!row) return { error: '比赛不存在' };
  const next = row.is_public ? 0 : 1;
  db.prepare('UPDATE contests SET is_public = ? WHERE id = ?').run(next, id);
  return { ok: true, is_public: !!next };
}

function setContestProblems(id, problemIds) {
  const row = db.prepare('SELECT id FROM contests WHERE id = ?').get(id);
  if (!row) return { error: '比赛不存在' };
  const ids = Array.isArray(problemIds) ? problemIds.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x)) : [];
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(id);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const insert = db.prepare('INSERT INTO contest_problems (contest_id, problem_id, letter, sort_order) VALUES (?, ?, ?, ?)');
  ids.forEach((pid, i) => {
    const letter = i < letters.length ? letters[i] : String(i + 1);
    insert.run(id, pid, letter, i);
  });
  return { id: Number(id), count: ids.length };
}

// ---------------- 报名 ----------------

function isSignedUp(contestId, userId) {
  if (!userId) return false;
  return !!db.prepare('SELECT user_id FROM contest_registrations WHERE contest_id = ? AND user_id = ?').get(contestId, userId);
}

function signup(contestId, userId, rated) {
  const c = db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId);
  if (!c) return { error: '比赛不存在' };
  if (!c.signup_required) return { error: '该比赛无需报名' };
  if (Date.now() >= c.end_time) return { error: '比赛已结束，报名截止' };
  if (isSignedUp(contestId, userId)) return { error: '你已报名该比赛' };
  let ratedFlag = rated === false ? 0 : 1;
  let note = null;
  // 等级分阈值：高于阈值的用户即使勾选「计算等级分」也强制不计等级分（本场不参与等级分结算）
  if (c.rated && c.rating_threshold > 0 && ratedFlag === 1) {
    const u = db.prepare('SELECT rating FROM users WHERE id = ?').get(userId);
    if (u && (u.rating || 0) >= c.rating_threshold) {
      ratedFlag = 0;
      note = `你的等级分（${u.rating || 0}）已达本场阈值 ${c.rating_threshold}，报名后不计等级分`;
    }
  }
  db.prepare('INSERT INTO contest_registrations (contest_id, user_id, rated, created_at) VALUES (?, ?, ?, ?)').run(contestId, userId, ratedFlag, Date.now());
  return { ok: true, rated: ratedFlag === 1, note };
}

function unsignup(contestId, userId) {
  const c = db.prepare('SELECT id FROM contests WHERE id = ?').get(contestId);
  if (!c) return { error: '比赛不存在' };
  db.prepare('DELETE FROM contest_registrations WHERE contest_id = ? AND user_id = ?').run(contestId, userId);
  return { ok: true };
}

// 校验比赛提交：题目在赛题中、比赛窗口内、且已报名（报名为硬性要求——无论是否管理员，未报名一律不能提交）
function validateContestSubmit(contestId, problemId, userId, isAdmin) {
  const c = db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId);
  if (!c) return { error: '比赛不存在' };
  const cp = db.prepare('SELECT id FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contestId, problemId);
  if (!cp) return { error: '该题目不在本比赛中' };
  const now = Date.now();
  if (!isAdmin && (now < c.start_time || now > c.end_time)) {
    return { error: now < c.start_time ? '比赛尚未开始' : '比赛已结束' };
  }
  if (!isSignedUp(contestId, userId)) {
    return { error: '请先报名该比赛后再提交' };
  }
  return { ok: true };
}

/**
 * 比赛私有题目访问校验：题目属于该比赛，且观众可查看该比赛题目
 * （未开始 / 需报名未报名时不可见；管理员不受限）。用于「未公开题目只能从比赛进入」。
 */
function canViewProblemInContest(contestId, problemId, userId, isAdmin) {
  if (isAdmin) return { ok: true };
  const c = db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId);
  if (!c || !c.is_public) return { error: '比赛不存在或不可见' };
  const cp = db.prepare('SELECT id FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contestId, problemId);
  if (!cp) return { error: '该题目不属于本比赛' };
  const status = contestStatus(c);
  if (status === 'upcoming') return { error: '比赛尚未开始' };
  if (c.signup_required && !isSignedUp(contestId, userId)) {
    return { error: '请先报名该比赛后查看题目' };
  }
  return { ok: true };
}

// ---------------- 排行榜 ----------------

function getStandings(id, viewer) {
  const c = db.prepare('SELECT * FROM contests WHERE id = ?').get(id);
  if (!c) return null;
  const isAdmin = !!(viewer && viewer.is_admin);
  // 未报名用户只能看到比赛描述：排行榜一并锁定（含已结束的比赛；管理员不受限）
  const signedUpViewer = viewer && viewer.id ? isSignedUp(id, viewer.id) : false;
  if (c.signup_required && !isAdmin && !signedUpViewer) {
    return {
      contest_id: id,
      type: c.type,
      hidden: true,
      hidden_reason: 'signup',
      problems: [],
      rows: [],
    };
  }
  // OI 赛制：比赛中不公布排行榜与成绩，赛后（及管理员）可见
  if (c.type === 'OI' && contestStatus(c) === 'running' && !isAdmin) {
    const cps = db.prepare(`
      SELECT cp.letter, cp.problem_id, p.title
      FROM contest_problems cp JOIN problems p ON p.id = cp.problem_id
      WHERE cp.contest_id = ? ORDER BY cp.sort_order ASC
    `).all(id);
    return {
      contest_id: id,
      type: c.type,
      hidden: true,
      problems: cps.map((p) => ({ letter: p.letter, problem_id: p.problem_id, title: p.title })),
      rows: [],
    };
  }
  const cps = db.prepare(`
    SELECT cp.letter, cp.problem_id, p.title
    FROM contest_problems cp JOIN problems p ON p.id = cp.problem_id
    WHERE cp.contest_id = ? ORDER BY cp.sort_order ASC
  `).all(id);
  const letters = cps.map((p) => p.letter);
  const lettersByProblem = {};
  for (const cp of cps) lettersByProblem[cp.problem_id] = cp.letter;

  const subs = db.prepare(`
    SELECT s.user_id, u.username, s.problem_id, s.verdict, s.score, s.created_at
    FROM submissions s JOIN users u ON u.id = s.user_id
    WHERE s.contest_id = ? AND s.created_at >= ? AND s.created_at <= ?
    ORDER BY s.created_at ASC
  `).all(id, c.start_time, c.end_time);

  // 各题「首个通过」（首杀）：ACM=首次 AC；IOI/OI=首次满分（100 分）。subs 已按时间升序。
  const firstSolvers = {};
  for (const s of subs) {
    const letter = lettersByProblem[s.problem_id];
    if (!letter || (letter in firstSolvers)) continue;
    const isFirst = c.type === 'ACM' ? s.verdict === 'Accepted' : s.score >= 100;
    if (isFirst) firstSolvers[letter] = s.user_id;
  }

  // 按用户分组；若需要报名则包含全部报名用户（即使未提交）
  const users = {};
  const ensureUser = (uid, uname) => {
    if (!users[uid]) users[uid] = { user_id: uid, username: uname, subs: [] };
  };
  for (const s of subs) ensureUser(s.user_id, s.username);
  if (c.signup_required) {
    const regs = db.prepare(`
      SELECT r.user_id, u.username FROM contest_registrations r JOIN users u ON u.id = r.user_id WHERE r.contest_id = ?
    `).all(id);
    for (const r of regs) ensureUser(r.user_id, r.username);
  }
  for (const s of subs) users[s.user_id].subs.push(s);

  const rows = Object.values(users).map((u) => {
    const problemResults = {};
    let solved = 0;
    let penalty = 0;
    let totalScore = 0;
    let totalTime = 0;

    for (const cp of cps) {
      const listAll = u.subs.filter((s) => s.problem_id === cp.problem_id);
      // 编译错误（CE）不计入任何统计：不算错误提交、不计罚时
      const list = listAll.filter((s) => s.verdict !== 'Compile Error');
      const acSubs = list.filter((s) => s.verdict === 'Accepted');
      const res = { attempts: list.length, accepted: acSubs.length > 0, score: 0, time_min: 0, time_ms: 0 };

      if (c.type === 'IOI') {
        // IOI：取最高分
        let best = null;
        for (const s of list) if (!best || s.score > best.score) best = s;
        if (best) {
          res.score = best.score;
          res.time_ms = Math.max(0, best.created_at - c.start_time);
          res.time_min = Math.floor(res.time_ms / 60000);
          totalScore += best.score;
        }
      } else if (c.type === 'OI') {
        // OI：取最后一次提交的成绩（NOI 风格），部分分
        const last = list.length ? list[list.length - 1] : null;
        if (last) {
          res.score = last.score;
          res.time_ms = Math.max(0, last.created_at - c.start_time);
          res.time_min = Math.floor(res.time_ms / 60000);
          totalScore += last.score;
        }
      } else {
        // ACM：首次提交直接 AC 完全不计罚时（排行榜显示对号 ✓）；
        // 否则 AC 前 n 次错误提交（CE 不计入）罚时 = 20 * n，排行榜显示 +n
        // 未通过的提交不计算用时（time_ms 保持 0）
        if (acSubs.length > 0) {
          const firstAC = acSubs[0];
          const wrongBefore = list.filter((s) => s.created_at < firstAC.created_at && s.verdict !== 'Accepted').length;
          res.score = 1;
          res.time_ms = Math.max(0, firstAC.created_at - c.start_time);
          res.time_min = Math.floor(res.time_ms / 60000);
          res.wrong_before = wrongBefore;
          solved++;
          res.first_ac = wrongBefore === 0;
          res.penalty_wrong = wrongBefore;
          penalty += 20 * wrongBefore;
        }
      }
      // 总用时 = 所有已提交题目的用时之和（格式统一为 (MM:SS)）
      totalTime += res.time_ms;
      problemResults[cp.letter] = res;
      res.first_solver = firstSolvers[cp.letter] === u.user_id;
    }

    return {
      user_id: u.user_id,
      username: u.username,
      solved,
      penalty,
      total_score: totalScore,
      // 总用时：IOI/OI = 各已提交题目用时之和；ACM = 各通过题目用时之和 + 罚时（20 分钟 × AC 前错误次数）
      total_time_ms: c.type === 'ACM' ? totalTime + penalty * 60000 : totalTime,
      problem_results: problemResults,
      // 是否参与（赛时窗口内有提交）：未提交者不占名次，排名显示 —
      participated: u.subs.length > 0,
    };
  });

  // 棕名判处 -1 分：被处罚用户在该场比赛以 -1 分排最后（用于等级分计算）
  const penalties = db.prepare('SELECT user_id FROM contest_penalties WHERE contest_id = ?').all(id);
  const penaltyIds = new Set(penalties.map((p) => p.user_id));
  if (penaltyIds.size) {
    for (const r of rows) {
      if (penaltyIds.has(r.user_id)) {
        r.total_score = -1;
        r.penalty = -1;
        r.solved = 0;
        r.total_time_ms = 0;
        r.cheat_penalty = true;
      }
    }
  }

  if (c.type === 'IOI' || c.type === 'OI') {
    rows.sort((a, b) => b.total_score - a.total_score || a.total_time_ms - b.total_time_ms || a.user_id - b.user_id);
  } else {
    // ACM：先按解题数，分数相同按总用时（含罚时）排序
    rows.sort((a, b) => b.solved - a.solved || a.total_time_ms - b.total_time_ms || a.user_id - b.user_id);
  }
  // 并列排名（竞赛排名 1,1,3）：ACM 按 解题数+总用时 相同并列；IOI/OI 按 总分+总用时 相同并列。
  // 仅参与者（赛时窗口内有提交）占名次并连续编号；未提交者排名置空（前端显示 —）。
  let lastKey = null;
  let lastRank = 0;
  let idx = 0;
  rows.forEach((r) => {
    if (!r.participated) { r.rank = null; return; }
    idx++;
    const key = c.type === 'IOI' || c.type === 'OI'
      ? r.total_score + '|' + r.total_time_ms
      : r.solved + '|' + r.total_time_ms;
    if (key !== lastKey) {
      r.rank = idx;
      lastRank = r.rank;
      lastKey = key;
    } else {
      r.rank = lastRank;
    }
  });

  // 回写报名表中的排名（供积分比赛分与等级分使用；未提交者 rank 置空 → 写入 0）
  const updRank = db.prepare('UPDATE contest_registrations SET rank = ? WHERE contest_id = ? AND user_id = ?');
  for (const r of rows) updRank.run(r.rank == null ? 0 : r.rank, id, r.user_id);

  // 排行榜只展示有提交记录（有排名）的选手；未提交的报名者（排名为 —）一律不出现在榜单中
  const visibleRows = rows.filter((r) => r.participated);

  return {
    contest_id: id,
    type: c.type,
    rated: !!c.rated,
    rating_threshold: c.rating_threshold || 0,
    ratings_applied: !!c.ratings_applied,
    problems: cps.map((p) => ({ letter: p.letter, problem_id: p.problem_id, title: p.title })),
    rows: visibleRows,
  };
}

/** 管理员结算 / 重新结算等级分与比赛积分（比赛结束后可重复操作）。
 *  Rated 比赛：计算并写入等级分，同时通过 getStandings 持久化排名供比赛积分使用；
 *  非 Rated 比赛：仅持久化排名（比赛积分据此计算），不产生等级分变化。
 *  已结算过再次结算 = 重新计算：先把上次结算的等级分回滚（恢复 before、清除历史），再按当前名次重算。 */
function applyRatings(id) {
  const c = db.prepare('SELECT * FROM contests WHERE id = ?').get(id);
  if (!c) return { error: '比赛不存在' };
  if (contestStatus(c) !== 'ended') return { error: '比赛尚未结束，不能结算' };
  const st = getStandings(id, { is_admin: true });
  if (!st) return { error: '比赛不存在' };
  // 必须提交过才能参与结算（未提交的报名者不计入等级分；比赛积分仅按有提交的场次计算）
  const submitted = db.prepare('SELECT DISTINCT user_id FROM submissions WHERE contest_id = ? AND created_at >= ? AND created_at <= ?')
    .all(id, c.start_time, c.end_time)
    .map((r) => r.user_id);
  const submittedSet = new Set(submitted);
  // getStandings 已把全部排名写回 contest_registrations，比赛积分（computePoints）据此计算
  if (!c.rated) {
    db.prepare('UPDATE contests SET ratings_applied = 1 WHERE id = ?').run(id);
    return { ok: true, count: 0, skipped: true, points_only: true, recomputed: !!c.ratings_applied };
  }
  // 重新结算：回滚该场已生效的等级分
  if (c.ratings_applied) {
    const hist = db.prepare('SELECT user_id, rating_before FROM rating_history WHERE contest_id = ?').all(id);
    const upd = db.prepare('UPDATE users SET rating = ?, rated_games = MAX(0, rated_games - 1) WHERE id = ?');
    for (const h of hist) upd.run(h.rating_before, h.user_id);
    db.prepare('DELETE FROM rating_history WHERE contest_id = ?').run(id);
    db.prepare('UPDATE contests SET ratings_applied = 0 WHERE id = ?').run(id);
  }
  const rating = require('./rating');
  // 报名时勾选「不计等级分」（rated = 0，含高于阈值被强制不计分者）不参与本场等级分结算
  const ratedSet = new Set(db.prepare('SELECT user_id FROM contest_registrations WHERE contest_id = ? AND rated = 1').all(id).map((r) => r.user_id));
  const participants = st.rows
    .filter((r) => submittedSet.has(r.user_id) && ratedSet.has(r.user_id))
    .map((r) => ({ user_id: r.user_id, rank: r.rank, score: r.total_score }));
  if (participants.length === 0) {
    db.prepare('UPDATE contests SET ratings_applied = 1 WHERE id = ?').run(id);
    return { ok: true, count: 0, skipped: true };
  }
  const r = rating.applyContestRatings(id, participants, c.rating_threshold || 0);
  db.prepare('UPDATE contests SET ratings_applied = 1 WHERE id = ?').run(id);
  return { ok: true, count: r.count, skipped: !!r.skipped, rating_applied: true, recomputed: true };
}

module.exports = {
  CONTEST_TYPES,
  contestStatus,
  listContests,
  getContest,
  createContest,
  updateContest,
  deleteContest,
  setContestProblems,
  signup,
  unsignup,
  isSignedUp,
  validateContestSubmit,
  canViewProblemInContest,
  getStandings,
  applyRatings,
  toggleContestPublic,
};
