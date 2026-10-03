'use strict';

const { db } = require('./db');
const { parsePagination } = require('./util');
const { decodeDetail } = require('./judgecodec');
const { LANGUAGES, VERDICTS } = require('./config');

function hasAccepted(userId, problemId) {
  if (!userId) return false;
  // 仅题库 AC（contest_id IS NULL）：赛时 AC 不算作「本题已通过」，保持与题库状态独立
  const r = db.prepare(
    "SELECT id FROM submissions WHERE user_id = ? AND problem_id = ? AND verdict = 'Accepted' AND contest_id IS NULL LIMIT 1"
  ).get(userId, problemId);
  return !!r;
}

function createSubmission(userId, problemId, language, code, contestId = null, answerFile = null, enableO2 = null) {
  const problem = db.prepare('SELECT id, is_public, output_only, enable_o2 FROM problems WHERE id = ?').get(problemId);
  if (!problem) return { error: '题目不存在' };
  if (!problem.is_public) {
    // 未公开题目仅允许在所属比赛上下文中提交（比赛校验已在路由层完成）
    if (!contestId) return { error: '题目不可提交' };
    const cp = db.prepare('SELECT id FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contestId, problemId);
    if (!cp) return { error: '该题目不在本比赛中，不可提交' };
  }
  const lang = LANGUAGES[language];
  if (!lang) return { error: '不支持该语言' };
  // 提交答案题：必须使用 output 语言并上传答案文件
  if (problem.output_only) {
    if (language !== 'output') return { error: '本题为提交答案题，请选择「提交答案」语言并上传答案文件' };
    if (!answerFile) return { error: '请上传答案文件' };
    let sizeOk = false;
    try { sizeOk = Buffer.from(String(answerFile), 'base64').length > 0 && Buffer.from(String(answerFile), 'base64').length <= 32 * 1024 * 1024; } catch { sizeOk = false; }
    if (!sizeOk) return { error: '答案文件无效或超过 32MB 限制' };
    const info = db.prepare(`
      INSERT INTO submissions (user_id, problem_id, language, code, enable_o2, status, verdict, score, time_ms, memory_kb, compile_error, judge_detail, contest_id, created_at)
      VALUES (?, ?, 'output', ?, 1, 'Pending', 'Pending', 0, 0, 0, '', '[]', ?, ?)
    `).run(userId, problemId, String(answerFile), contestId, Date.now());
    return { id: Number(info.lastInsertRowid) };
  }
  if (language === 'output') return { error: '本题不是提交答案题，无需上传答案文件' };
  const available = require('./judge').availableLanguages()[language];
  if (!available || !available.available) return { error: `当前环境未安装 ${available ? available.toolName : lang.toolName} 工具链，无法评测 ${lang.name}` };
  const codeStr = String(code || '');
  if (codeStr.trim().length === 0) return { error: '代码不能为空' };
  if (codeStr.length > 64 * 1024) return { error: '代码长度超出限制（64KB）' };
  // O2：提交时可选，默认跟随题目设置
  const o2 = enableO2 == null ? (problem.enable_o2 !== 0 && problem.enable_o2 !== false) : !!enableO2;

  const info = db.prepare(`
    INSERT INTO submissions (user_id, problem_id, language, code, enable_o2, status, verdict, score, time_ms, memory_kb, compile_error, judge_detail, contest_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'Pending', 'Pending', 0, 0, 0, '', '[]', ?, ?)
  `).run(userId, problemId, language, codeStr, o2 ? 1 : 0, contestId, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

function serializeBrief(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    problem_id: row.problem_id,
    problem_title: row.problem_title,
    language: row.language,
    status: row.status,
    verdict: row.verdict,
    score: row.score,
    time_ms: row.time_ms,
    memory_kb: row.memory_kb,
    contest_id: row.contest_id,
    contest_title: row.contest_title || null,
    contest_type: row.contest_type || null,
    enable_o2: row.enable_o2 == null ? 1 : !!row.enable_o2,
    created_at: row.created_at,
  };
}

function listSubmissions(query, viewer) {
  const { page, size, offset } = parsePagination(query, 20, 100);
  const problemId = parseInt(query.get('problem') || '0', 10);
  const mine = query.get('mine') === '1';
  // 用户筛选：数字按 UID，其它按用户名解析（前端第二个框写的是「用户名 / 用户 ID」，
  // 此前只 parseInt，输入用户名会被当成"没有筛选条件"——管理员看到全站提交、
  // 普通用户看到自己的提交，与预期不符）。
  const userParam = (query.get('user') || '').trim();
  let userId = parseInt(userParam, 10);
  if (!Number.isFinite(userId) && userParam) {
    const hit = db.prepare('SELECT id FROM users WHERE username = ?').get(userParam);
    userId = hit ? hit.id : 0;
  }
  if (!Number.isFinite(userId)) userId = 0;
  const userNotFound = !!userParam && userId <= 0;
  const verdict = (query.get('verdict') || '').trim();
  const contestParam = (query.get('contest') || '').trim();
  const currentUserId = viewer && viewer.id;
  const isAdmin = viewer && viewer.is_admin;

  // 「只看我的提交」必须登录：否则 mine=1 会被下面「无任何筛选条件」的兜底逻辑当成
  // "已有筛选"而跳过，导致未登录访客能看到全站提交记录。
  if (mine && !currentUserId) {
    return { error: '请先登录后查看自己的提交记录', items: [], total: 0, page, size };
  }
  if (userNotFound) {
    return { error: `找不到用户「${userParam}」`, items: [], total: 0, page, size };
  }

  const where = ['1=1'];
  const params = [];
  if (problemId > 0) { where.push('s.problem_id = ?'); params.push(problemId); }
  if (userId > 0) { where.push('s.user_id = ?'); params.push(userId); }
  if (mine && currentUserId) { where.push('s.user_id = ?'); params.push(currentUserId); }
  // 状态筛选：Unaccepted = 所有非 Accepted 的已评测结果（提交记录列表只展示 Accepted / Unaccepted 两种状态）
  if (verdict === 'Unaccepted') {
    where.push("s.verdict NOT IN ('Accepted', 'Pending', 'Judging')");
  } else if (verdict) {
    where.push('s.verdict = ?'); params.push(verdict);
  }
  // 默认只显示自己的提交记录；完全未指定过滤条件时禁止展示全站提交
  if (!isAdmin && !mine && !userId && !problemId) {
    if (!currentUserId) {
      return { error: '请先登录后查看自己的提交记录', items: [], total: 0, page, size };
    }
    where.push('s.user_id = ?'); params.push(currentUserId);
  }
  // 比赛提交记录与普通提交记录独立：默认只显示普通提交；contest=<id> 显示某场比赛；contest=all 显示全部
  if (contestParam === 'all') {
    // 不过滤
  } else if (contestParam && contestParam !== '0') {
    const cid = parseInt(contestParam, 10);
    if (Number.isFinite(cid) && cid > 0) { where.push('s.contest_id = ?'); params.push(cid); }
    else { where.push('s.contest_id IS NULL'); }
  } else {
    where.push('s.contest_id IS NULL');
  }

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM submissions s WHERE ${where.join(' AND ')}
  `).get(...params).c;

  const rows = db.prepare(`
    SELECT s.*, u.username, p.title AS problem_title, cc.title AS contest_title, cc.type AS contest_type
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN contests cc ON cc.id = s.contest_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);

  // OI 赛制：比赛进行中普通用户只能看到编译情况（编译成功/失败），赛后恢复完整结果
  if (contestParam && contestParam !== 'all' && contestParam !== '0') {
    const cid = parseInt(contestParam, 10);
    if (Number.isFinite(cid) && cid > 0 && !isAdmin) {
      const c = db.prepare('SELECT type, start_time, end_time FROM contests WHERE id = ?').get(cid);
      const now = Date.now();
      if (c && c.type === 'OI' && now >= c.start_time && now <= c.end_time) {
        return {
          items: rows.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            username: r.username,
            problem_id: r.problem_id,
            problem_title: r.problem_title,
            language: r.language,
            status: r.status,
            verdict: r.verdict === 'Compile Error' ? 'Compile Error' : 'Compiled',
            score: 0,
            time_ms: 0,
            memory_kb: 0,
            contest_id: r.contest_id,
            contest_title: r.contest_title || null,
            contest_type: r.contest_type || null,
            oi_masked: true,
            created_at: r.created_at,
          })),
          total, page, size,
        };
      }
    }
  }

  return { items: rows.map(serializeBrief), total, page, size };
}

function getSubmission(id, viewer) {
  const row = db.prepare(`
    SELECT s.*, u.username, p.title AS problem_title, cc.title AS contest_title, cc.type AS contest_type
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN contests cc ON cc.id = s.contest_id
    WHERE s.id = ?
  `).get(id);
  if (!row) return null;

  const isOwner = viewer && viewer.id === row.user_id;
  const isAdmin = viewer && viewer.is_admin;
  const canViewCode = isOwner || isAdmin || hasAccepted(viewer && viewer.id, row.problem_id);

  let judgeDetail = [];
  try { judgeDetail = JSON.parse(decodeDetail(row.judge_detail || '[]')); } catch { /* ignore */ }

  const brief = serializeBrief(row);

  // 题目/赛制信息
  const problem = db.prepare('SELECT show_score FROM problems WHERE id = ?').get(row.problem_id);
  const showScore = problem ? (problem.show_score === undefined ? true : !!problem.show_score) : true;
  let contestType = null;
  let contestWindow = null;
  if (row.contest_id) {
    const c = db.prepare('SELECT type, start_time, end_time FROM contests WHERE id = ?').get(row.contest_id);
    if (c) {
      contestType = c.type;
      contestWindow = { start: c.start_time, end: c.end_time };
    }
  }

  // OI 赛制：比赛进行中不公开评测成绩，只显示编译情况（编译成功 / 编译失败）；赛后及管理员可见完整结果
  let oiMasked = false;
  let oiNote = '';
  if (contestType === 'OI' && !isAdmin && contestWindow) {
    const now = Date.now();
    if (now >= contestWindow.start && now <= contestWindow.end) {
      oiMasked = true;
      if (brief.verdict === 'Compile Error') {
        oiNote = 'OI 赛制比赛中不公开评测成绩；当前提交编译失败，详见下方编译错误信息';
      } else {
        oiNote = 'OI 赛制比赛中不公开评测成绩，仅显示编译情况；提交已编译通过，赛后公布完整结果';
      }
    }
  }

  // 测试点元信息（总数 + 每个测试点的子任务与满分）：评测中前端据此按子任务分组显示占位（转圈）
  let testcaseMeta = [];
  try {
    testcaseMeta = require('./db').readTestcases(row.problem_id)
      .map((t) => ({ id: t.id, subtask: t.subtask == null ? 0 : t.subtask, subtask_score: t.subtask_score || 0 }));
  } catch { /* ignore */ }
  const testcaseCount = testcaseMeta.length;

  if (oiMasked) {
    const compileFailed = brief.verdict === 'Compile Error';
    return {
      ...brief,
      verdict: compileFailed ? 'Compile Error' : 'Compiled',
      score: 0,
      time_ms: 0,
      memory_kb: 0,
      code: canViewCode ? row.code : null,
      code_locked: !canViewCode,
      compile_error: compileFailed && (isOwner || isAdmin) ? row.compile_error : '',
      judge_detail: [],
      testcase_count: testcaseCount,
      testcase_meta: testcaseMeta,
      oi_masked: true,
      oi_note: oiNote,
    };
  }

  // ACM 赛制 / 不显示分数的题目：隐藏得分，只显示对与错
  const hideScore = contestType === 'ACM' || !showScore;
  let detail = judgeDetail;
  if (hideScore) {
    // 只保留判定结果，不显示分数与答案比对详情
    detail = judgeDetail.map((d) => ({
      id: d.id,
      verdict: d.verdict,
      time_ms: d.time_ms,
      memory_kb: d.memory_kb,
      message: d.verdict === 'Accepted' ? '正确' : d.message,
    }));
  }

  return {
    ...brief,
    score: hideScore ? 0 : brief.score,
    hide_score: hideScore,
    code: canViewCode ? row.code : null,
    code_locked: !canViewCode,
    compile_error: isOwner || isAdmin ? row.compile_error : (canViewCode ? row.compile_error : ''),
    judge_detail: detail,
    testcase_count: testcaseCount,
    testcase_meta: testcaseMeta,
  };
}

module.exports = { createSubmission, listSubmissions, getSubmission, hasAccepted };
