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

/** 通信题（problem_type = 'communication'）的提交校验：**必须**给出两个程序。
 *  语言限制与评测机一致（评测时两个程序分别用 g++/gcc 编译成两个可执行文件，见 judge.js COMM_LANGS）。 */
const COMM_LANGS = ['cpp', 'cpp11', 'cpp98', 'c'];
/** 单份代码长度上限（64KB，与普通题一致） */
const CODE_MAX = 64 * 1024;

function createSubmission(userId, problemId, language, code, contestId = null, answerFile = null, enableO2 = null, code2 = null) {
  const problem = db.prepare('SELECT id, is_public, output_only, enable_o2, problem_type FROM problems WHERE id = ?').get(problemId);
  if (!problem) return { error: '题目不存在' };
  if (!problem.is_public) {
    // 未公开题目仅允许在所属比赛上下文中提交（比赛校验已在路由层完成）
    if (!contestId) return { error: '题目不可提交' };
    const cp = db.prepare('SELECT id FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contestId, problemId);
    if (!cp) return { error: '该题目不在本比赛中，不可提交' };
  }
  const lang = LANGUAGES[language];
  if (!lang) return { error: '不支持该语言' };
  // 通信题：必须提交**两个程序**（程序一 code / 程序二 code2），且两者都要能编译
  const isComm = String(problem.problem_type || '') === 'communication';
  if (isComm) {
    if (language === 'output') return { error: '通信题需要提交两个程序，不能使用「提交答案」语言' };
    if (!COMM_LANGS.includes(String(language))) {
      return { error: '通信题需要把两个程序分别编译后对接运行，目前仅支持 C / C++ 提交（当前语言：' + lang.name + '）' };
    }
    const c1 = String(code || '');
    const c2 = String(code2 == null ? '' : code2);
    if (c1.trim().length === 0) return { error: '程序一（程序一代码）不能为空' };
    if (c2.trim().length === 0) return { error: '程序二（程序二代码）不能为空：通信题需要两个程序合作完成任务' };
    if (c1.length > CODE_MAX) return { error: '程序一代码长度超出限制（64KB）' };
    if (c2.length > CODE_MAX) return { error: '程序二代码长度超出限制（64KB）' };
    const available2 = require('./judge').availableLanguages()[language];
    if (!available2 || !available2.available) return { error: `当前环境未安装 ${available2 ? available2.toolName : lang.toolName} 工具链，无法评测 ${lang.name}` };
    const o2c = enableO2 == null ? (problem.enable_o2 !== 0 && problem.enable_o2 !== false) : !!enableO2;
    const infoC = db.prepare(`
      INSERT INTO submissions (user_id, problem_id, language, code, code2, enable_o2, status, verdict, score, time_ms, memory_kb, compile_error, judge_detail, contest_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Pending', 'Pending', 0, 0, 0, '', '[]', ?, ?)
    `).run(userId, problemId, language, c1, c2, o2c ? 1 : 0, contestId, Date.now());
    return { id: Number(infoC.lastInsertRowid) };
  }
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

/**
 * 内存是否「真的采样到」（而不是「没采到」）：
 * judge.js 会在判题明细里写 memory_sampled（false = 采样器不可用/退避中，memory_kb=0 只是没采到）。
 * 历史提交没有该字段：此时按 memory_kb > 0 反推（有值必然采到了；0 无法区分，按未采样处理并显示 '—'）。
 * 注意：只做**返回值补全**，不参与任何判定（MLE 判定仍在 judge.js，用的是 memory_kb 本身）。
 */
function normalizeMemorySampled(flag, memoryKb) {
  if (flag === true) return true;
  if (flag === false) return false;
  return Number(memoryKb) > 0;
}

/** 提交级 memory_sampled：行上有内存值就一定是采到了，否则看判题明细里有没有任一测试点采到 */
function memorySampledOfRow(row, details) {
  if (Number(row && row.memory_kb) > 0) return true;
  try {
    const detail = details || decodeRowDetail(row);
    return Array.isArray(detail) && detail.some((d) => d && d.memory_sampled === true);
  } catch { return false; }
}

/** 解码提交的逐测试点明细（列表与详情共用；任何异常一律当空数组） */
function decodeRowDetail(row) {
  try {
    const d = JSON.parse(decodeDetail(row && row.judge_detail != null ? row.judge_detail : '[]'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/** 各子任务内**最慢测试点**的用时：子任务编号 → 该子任务里最慢那个测试点的用时（未采到用时的测试点按 0 计） */
function subtaskSlowest(details) {
  const slow = new Map();
  for (const d of (details || [])) {
    const k = d && d.subtask != null ? d.subtask : 0;
    const v = Number(d && d.time_ms);
    const t = Number.isFinite(v) && v > 0 ? v : 0;
    if (!slow.has(k) || t > slow.get(k)) slow.set(k, t);
  }
  return slow;
}

/** 各测试点用时之和（**仅供参照**，不再作为「用时」展示；v2.7.6 起详情页不再并列这个数） */
function testcaseTimeSum(details) {
  let sum = 0;
  for (const d of (details || [])) {
    const v = Number(d && d.time_ms);
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

/**
 * 提交「用时」的**唯一口径**（提交记录列表 / 详情侧栏 / 详情横幅 / 详情卡片标题共用这一个函数）：
 *   用时 = **最慢测试点**的用时，与库里的 submissions.time_ms（judge.js 判定时写入的最慢测试点用时）
 *   完全一致 —— 这正是用户要求的「列表用时、详情主用时口径一致」。
 *   · 题目**有**子任务（明细落在多个子任务编号上）→ kind='subtask'，time_ms = 全局最慢测试点用时，
 *     subtask 指出最慢测试点所在的子任务（= **用时最长的那个子任务**，子任务用时取该子任务内最慢测试点），
 *     此时「用时最长的子任务的用时」恒等于本次提交用时；
 *   · 题目**没有**子任务（明细只落在一个分组里）→ kind='total'，time_ms = 该分组（= 全部测试点）里最慢的那个；
 *   · 完全没有可用的逐点用时（历史 / 导入数据 judge_detail='[]'，或所有测试点都没采到用时）→
 *     kind='slowest'，退回提交行上的 time_ms（没有逐点依据时只能用它）。
 * 返回 { time_ms, kind: 'subtask' | 'total' | 'slowest', subtask, sum_ms }。
 * 注意：只做**展示口径**计算，不改判定、不改库里的 submissions.time_ms。
 */
function displayTimeOf(details, rowTimeMs) {
  const slow = subtaskSlowest(details);
  const sum = testcaseTimeSum(details);
  if (slow.size === 0) {
    const raw = Number(rowTimeMs);
    return { time_ms: Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0, kind: 'slowest', subtask: null, sum_ms: 0 };
  }
  let bestKey = null;
  let best = 0;
  for (const [k, v] of slow) if (v > best) { best = v; bestKey = k; }
  if (best <= 0) {
    // 有逐点明细但一个用时都没采到：同样退回库里存档的最慢测试点用时
    const raw = Number(rowTimeMs);
    return { time_ms: Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0, kind: 'slowest', subtask: null, sum_ms: sum };
  }
  return { time_ms: best, kind: slow.size > 1 ? 'subtask' : 'total', subtask: bestKey, sum_ms: sum };
}

/**
 * 提交摘要序列化（列表与详情共用）：
 *   time_ms 是**展示用时**（= displayTimeOf 的口径 = 最慢测试点用时，与库里的 submissions.time_ms 同值）；
 *   同时给出 time_ms_kind / time_ms_subtask / testcase_time_sum_ms，前端据此显示「用时」标签与口径说明。
 *   problem_type：列表/详情据此标注「通信题（两程序）」等题型（旧数据缺失时为 ''，前端按普通题处理）。
 */
function serializeBrief(row, details) {
  const det = details || decodeRowDetail(row);
  const dt = displayTimeOf(det, row.time_ms);
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    problem_id: row.problem_id,
    problem_title: row.problem_title,
    problem_type: String(row.problem_type || ''),
    language: row.language,
    status: row.status,
    verdict: row.verdict,
    score: row.score,
    time_ms: dt.time_ms,
    time_ms_kind: dt.kind,
    time_ms_subtask: dt.subtask,
    // 各测试点用时合计（**仅供参照**，v2.7.6 起前端不再把它当「用时」展示；无子任务时旧口径就是它）
    testcase_time_sum_ms: dt.sum_ms,
    memory_kb: row.memory_kb,
    // 未采样（memory_kb=0 只是没采到）时前端显示 '—'，不显示 0 KB
    memory_sampled: memorySampledOfRow(row, det),
    contest_id: row.contest_id,
    contest_title: row.contest_title || null,
    contest_type: row.contest_type || null,
    enable_o2: row.enable_o2 == null ? 1 : !!row.enable_o2,
    created_at: row.created_at,
  };
}

/**
 * 提交记录的可见性（M10）：
 *   - 管理员：全部可见；
 *   - 本人：自己的提交始终可见；
 *   - 其它用户 / 未登录：仅当「题目已公开」且「非比赛提交，或比赛已结束」时可见。
 * 这样匿名访客无法枚举全站提交，比赛进行中（无论 ACM / OI / IOI）也不会提前泄漏他人提交。
 */
function canViewSubmission(viewer, row) {
  // 按用户要求：提交记录详细信息允许**未登录**查看（仅限公开题目、且不在进行中的比赛里）；
  // 代码可见性仍按 canViewCode 单独控制（本人 / 管理员 / 该题有 AC 的用户），匿名看不到源码。
  const p = db.prepare('SELECT is_public FROM problems WHERE id = ?').get(row.problem_id);
  if (!p || !p.is_public) {
    if (!viewer) return false;
    if (viewer.is_admin) return true;
    return viewer.id === row.user_id;
  }
  if (row.contest_id) {
    const c = db.prepare('SELECT end_time FROM contests WHERE id = ?').get(row.contest_id);
    if (!c || Date.now() < c.end_time) {
      // 比赛未结束：只有本人与管理员可见
      if (!viewer) return false;
      return viewer.is_admin || viewer.id === row.user_id;
    }
  }
  return true;
}

/** 判定一条提交是否处于「OI 赛制比赛进行中」状态（遮蔽成绩只与该行自己的 contest_id 有关，与查询参数无关） */
function isOiRunning(row, now) {
  if (!row.contest_id) return false;
  const c = db.prepare('SELECT type, start_time, end_time FROM contests WHERE id = ?').get(row.contest_id);
  if (!c) return false;
  return c.type === 'OI' && now >= c.start_time && now <= c.end_time;
}

/** OI 遮蔽：比赛进行中只暴露编译情况（编译成功 / 失败），隐藏分数、用时与测试点明细 */
function maskOiRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    problem_id: row.problem_id,
    problem_title: row.problem_title,
    // 题型不属于「成绩」：OI 遮蔽期间照常带出，前端仍能标注「通信题（两程序）」
    problem_type: String(row.problem_type || ''),
    language: row.language,
    status: row.status,
    verdict: row.verdict === 'Compile Error' ? 'Compile Error' : 'Compiled',
    score: 0,
    time_ms: 0,
    // 遮蔽口径：用时被隐藏（前端据此不显示「总用时 / 用时」的具体数值说明）
    time_ms_kind: 'masked',
    time_ms_subtask: null,
    testcase_time_sum_ms: 0,
    memory_kb: 0,
    memory_sampled: false,
    contest_id: row.contest_id,
    contest_title: row.contest_title || null,
    contest_type: row.contest_type || null,
    oi_masked: true,
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
  const now = Date.now();

  // 「只看我的提交」必须登录：否则 mine=1 会被下面「无任何筛选条件」的兜底逻辑当成
  // "已有筛选"而跳过，导致未登录访客能看到全站提交记录。
  if (mine && !currentUserId) {
    return { error: '请先登录后查看自己的提交记录', items: [], total: 0, page, size };
  }
  if (userNotFound) {
    return { error: `找不到用户「${userParam}」`, items: [], total: 0, page, size };
  }
  // 未登录不得浏览任何提交记录（入口在 server.js 也会拦一层，这里是纵深防御）
  if (!currentUserId && !isAdmin) {
    return { error: '请先登录后查看提交记录', login_required: true, items: [], total: 0, page, size };
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
  // 非管理员：只能看自己的提交，或「公开题目 + 赛后 / 非比赛」的提交（M10）
  if (!isAdmin) {
    where.push('(s.user_id = ? OR (p.is_public = 1 AND (s.contest_id IS NULL OR cc.end_time <= ?)))');
    params.push(currentUserId, now);
  }
  // 默认只显示自己的提交记录；完全未指定过滤条件时禁止展示全站提交
  if (!isAdmin && !mine && !userId && !problemId) {
    if (!currentUserId) {
      return { error: '请先登录后查看自己的提交记录', items: [], total: 0, page, size };
    }
    where.push('s.user_id = ?'); params.push(currentUserId);
  }
  // 比赛提交记录与普通提交记录独立（v2.6.3 起三种「来源」口径，缺省语义一行未变）：
  //   缺省 / contest=0 → 仅题库提交（contest_id IS NULL）
  //   contest=all      → 全部（题库 + 比赛提交）
  //   contest=only     → 仅比赛提交（contest_id IS NOT NULL）
  //   contest=<id>     → 仅某一场比赛的提交
  if (contestParam === 'all') {
    // 不过滤（但上面的可见性条件仍然生效，比赛进行中的他人提交不会因此泄漏）
  } else if (contestParam === 'only') {
    // 仅比赛提交：新增取值，'only' 不是数字，必须放在下面 parseInt 分支之前，
    // 否则会被当成「无法识别的 contest」而落回 contest_id IS NULL（退化成仅题库）
    where.push('s.contest_id IS NOT NULL');
  } else if (contestParam && contestParam !== '0') {
    const cid = parseInt(contestParam, 10);
    if (Number.isFinite(cid) && cid > 0) { where.push('s.contest_id = ?'); params.push(cid); }
    else { where.push('s.contest_id IS NULL'); }
  } else {
    where.push('s.contest_id IS NULL');
  }

  const total = db.prepare(`
    SELECT COUNT(*) AS c
    FROM submissions s
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN contests cc ON cc.id = s.contest_id
    WHERE ${where.join(' AND ')}
  `).get(...params).c;

  const rows = db.prepare(`
    SELECT s.*, u.username, p.title AS problem_title, p.problem_type AS problem_type, cc.title AS contest_title, cc.type AS contest_type
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN contests cc ON cc.id = s.contest_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.id DESC LIMIT ? OFFSET ?
  `).all(...params, size, offset);

  // OI 赛制：只要该行属于比赛（contest_id IS NOT NULL）且比赛进行中，非管理员一律只看到编译情况，
  // 赛后恢复完整结果。此前只在 contest=<具体 id> 时判定，用 contest=all 即可绕过（M10）。
  const items = rows.map((r) => (!isAdmin && isOiRunning(r, now) ? maskOiRow(r) : serializeBrief(r)));
  return { items, total, page, size };
}

/**
 * L13：compile_error 里可能含服务端堆栈（judge.js 在 SE 时写入 e.stack，含绝对路径）。
 * 非管理员只保留人类可读的错误摘要，剥离调用栈与绝对路径。
 */
function stripServerStack(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  const out = [];
  for (const line of raw.split('\n')) {
    if (/^\s*at\s/.test(line)) continue;                       // JS 调用栈行
    if (/node:internal|\(internal\//.test(line)) continue;      // Node 内部帧
    // 绝对路径（Windows / POSIX）替换为占位符，避免泄漏服务器目录结构
    const cleaned = line
      .replace(/[A-Za-z]:\\[^\s'")]+/g, '[路径已隐藏]')
      .replace(/\/(?:home|root|Users|var|opt|srv|tmp)\/[^\s'")]*/g, '[路径已隐藏]');
    out.push(cleaned);
  }
  return out.join('\n').slice(0, 4000);
}

function getSubmission(id, viewer) {
  const row = db.prepare(`
    SELECT s.*, u.username, p.title AS problem_title, p.problem_type AS problem_type, cc.title AS contest_title, cc.type AS contest_type
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN contests cc ON cc.id = s.contest_id
    WHERE s.id = ?
  `).get(id);
  if (!row) return null;
  // M10：未登录 / 他人提交只在「管理员 或 该题公开且赛后」时可见
  if (!canViewSubmission(viewer, row)) return { forbidden: '该提交不可见（未公开 / 比赛尚未结束 / 无权查看）' };

  const isOwner = viewer && viewer.id === row.user_id;
  const isAdmin = viewer && viewer.is_admin;
  const canViewCode = isOwner || isAdmin || hasAccepted(viewer && viewer.id, row.problem_id);

  let judgeDetail = decodeRowDetail(row);
  // 返回值补全（不改判题逻辑）：历史明细没有 memory_sampled 时按 memory_kb > 0 反推，
  // 前端据此把「没采到」显示成 '—'，而不是 '0 KB'。
  if (Array.isArray(judgeDetail)) {
    judgeDetail = judgeDetail.map((d) => (d && typeof d === 'object'
      ? { ...d, memory_sampled: normalizeMemorySampled(d.memory_sampled, d.memory_kb) }
      : d));
  }

  // brief 里的 time_ms / time_ms_kind / time_ms_subtask / testcase_time_sum_ms 就是列表用的那一份
  // （同一个 displayTimeOf 算出来的），详情直接沿用 → 列表与详情永远显示同一个用时。
  const brief = serializeBrief(row, judgeDetail);

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

  // 该题是否**配置了子任务**（提交详情里测试点是否按子任务分组展示）：
  //   · 测试数据 meta 里配了多个子任务分数，或
  //   · 测试点实际落在多个子任务编号上
  // 满足任一即为「有子任务」→ 详情按子任务分组；否则整题一组。
  const subtaskScores = (() => {
    try { return require('./db').readSubtaskScores(row.problem_id) || []; } catch { return []; }
  })();
  const hasSubtasks = subtaskScores.length > 1 || new Set(testcaseMeta.map((t) => t.subtask)).size > 1;

  if (oiMasked) {
    const compileFailed = brief.verdict === 'Compile Error';
    return {
      ...brief,
      verdict: compileFailed ? 'Compile Error' : 'Compiled',
      score: 0,
      time_ms: 0,
      time_ms_kind: 'masked',
      time_ms_subtask: null,
      memory_kb: 0,
      memory_sampled: false,
      testcase_time_sum_ms: 0,
      has_subtasks: hasSubtasks,
      code: canViewCode ? row.code : null,
      // 通信题的第二份程序（程序二）：可见性与代码一致（本人 / 管理员 / 该题已 AC 的用户）
      code2: canViewCode ? String(row.code2 || '') : null,
      code_locked: !canViewCode,
      // L13：服务端堆栈只对管理员可见
      compile_error: compileFailed && (isOwner || isAdmin) ? (isAdmin ? row.compile_error : stripServerStack(row.compile_error)) : '',
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
    // 只保留判定结果，不显示分数与答案比对详情（内存采样标记同样保留，前端要据此显示 '—'）
    detail = judgeDetail.map((d) => ({
      id: d.id,
      verdict: d.verdict,
      time_ms: d.time_ms,
      memory_kb: d.memory_kb,
      memory_sampled: d.memory_sampled,
      message: d.verdict === 'Accepted' ? '正确' : d.message,
    }));
  }

  return {
    ...brief,
    score: hideScore ? 0 : brief.score,
    hide_score: hideScore,
    code: canViewCode ? row.code : null,
    // 通信题的第二份程序（程序二）：可见性与程序一（code）保持一致
    code2: canViewCode ? String(row.code2 || '') : null,
    code_locked: !canViewCode,
    // L13：compile_error 中的服务端堆栈 / 绝对路径只对管理员可见
    compile_error: isAdmin ? row.compile_error : (isOwner || canViewCode ? stripServerStack(row.compile_error) : ''),
    judge_detail: detail,
    // testcase_time_sum_ms / time_ms_kind / time_ms_subtask 都来自上面的 brief（同一个 displayTimeOf）
    has_subtasks: hasSubtasks,
    testcase_count: testcaseCount,
    testcase_meta: testcaseMeta,
  };
}

module.exports = { createSubmission, listSubmissions, getSubmission, hasAccepted, canViewSubmission, stripServerStack };
