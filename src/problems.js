'use strict';

const fs = require('fs');
const path = require('path');
const { db, writeTestcases, readTestcases, readCaseLimits, readSubtaskScores, readSubtaskTypes, testcaseCount, checkerPath, problemDir,
  interactorPath, graderPath, listInteractiveHeaders, writeInteractiveAssets, isValidInteractiveHeaderName,
  readCommunicationConfig } = require('./db');
const { difficultyByLevel, parsePagination, decodeText } = require('./util');
const { markdownToHtml } = require('./markdown');
const { DIFFICULTIES } = require('./config');
const { buildZip } = require('./zip');

function parseTags(raw) {
  try {
    const t = JSON.parse(raw || '[]');
    return Array.isArray(t) ? t.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseSamples(raw) {
  try {
    const s = JSON.parse(raw || '[]');
    return Array.isArray(s) ? s : [];
  } catch {
    return [];
  }
}

/* ---------------- 题目类型（problem_type） ----------------
 *   standard         普通题（默认）
 *   output_only      提交答案题（与遗留的 output_only 列同步：problem_type==='output_only' ⇔ output_only=1）
 *   interactive_io   IO 交互题（题目带 interactor.cpp，与选手程序双向管道对接）
 *   interactive_func 函数式交互题（题目带 grader.cpp + 头文件，与选手提交一起编译链接）
 *   communication    通信题（**两个选手程序**合作完成任务：程序一的输出经评测端（可选中转程序 grader.cpp）
 *                    处理后作为程序二的输入；连接方式 relay / direct 见 src/communication.js 与 USAGE.md）。
 *                    通信题是**独立题型**，与 interactive_io / interactive_func 的语义与评测实现互不复用。
 * 另有独立开关 spj（Special Judge），五种类型都可以再叠加 SPJ。
 */
const PROBLEM_TYPES = ['standard', 'output_only', 'interactive_io', 'interactive_func', 'communication'];
/** 交互题配套源码（交互器 / grader / 单个头文件）的大小上限 */
const INTERACTIVE_SRC_MAX = 200 * 1024;
/** 交互说明（Markdown）的大小上限 */
const INTERACTIVE_HINT_MAX = 20 * 1024;

/** 规范化题目类型：非法值一律回退为 standard */
function normalizeProblemType(v) {
  const t = String(v == null ? '' : v).trim();
  return PROBLEM_TYPES.includes(t) ? t : 'standard';
}

/**
 * 由请求体与「数据库中的现有行」共同确定最终题目类型（兼容旧客户端）。
 *   · 请求里给了合法的 problem_type → 以它为准；
 *   · 只给了遗留的 output_only 布尔/数字 → 映射成 output_only / standard；
 *   · 两者都没给 → 保持数据库现有值（老数据的历史类型不丢）。
 * 返回值同时保证 `problem_type === 'output_only'` ⇔ `output_only 列为 1`。
 */
function resolveProblemType(data, current) {
  const has = (k) => data && Object.prototype.hasOwnProperty.call(data, k);
  const cur = normalizeProblemType(current && current.problem_type);
  let type = null;
  if (has('problem_type')) {
    type = normalizeProblemType(data.problem_type);
  }
  if (has('output_only')) {
    const legacy = data.output_only === true || data.output_only === 1 || data.output_only === '1';
    if (type == null) {
      type = legacy ? 'output_only' : cur;
    } else if (legacy && type === 'standard') {
      // 老客户端只传 output_only: true 时会同时带上被前端默认成 standard 的 problem_type，
      // 这种情况下以 output_only 为准（避免把「提交答案题」误存成普通题）。
      type = 'output_only';
    }
  }
  if (type == null) type = cur;
  return { problem_type: type, output_only: type === 'output_only' ? 1 : 0 };
}

/** 是否交互题（IO 交互或函数式交互；通信题是独立题型，不算在这里） */
function isInteractiveType(v) {
  const t = normalizeProblemType(v);
  return t === 'interactive_io' || t === 'interactive_func';
}

/** 是否通信题（两个选手程序合作完成任务的独立题型） */
function isCommunicationType(v) {
  return normalizeProblemType(v) === 'communication';
}

/** 是否需要「题目目录里的 grader.cpp」：函数式交互题（与选手代码链接）与通信题（评测端中转程序，可选） */
function needsGraderFile(v) {
  const t = normalizeProblemType(v);
  return t === 'interactive_func' || t === 'communication';
}

/** 头文件名称规范化：非法时尝试补 .h；仍非法则返回 null */
function normalizeHeaderName(raw) {
  let name = String(raw == null ? '' : raw).trim().replace(/^.*[\\/]/, '');
  if (!name) return null;
  if (!/\.h$/i.test(name)) name += '.h';
  if (!isValidInteractiveHeaderName(name)) return null;
  return name;
}

/** 规范化交互题头文件列表：过滤非法名称、去重（同名后者覆盖）、限制大小 */
function normalizeHeaders(raw) {
  if (!Array.isArray(raw)) return [];
  const map = new Map();
  for (const h of raw) {
    const name = normalizeHeaderName(h && h.name);
    if (!name) continue;
    let content = String((h && h.content) || '');
    if (content.length > INTERACTIVE_SRC_MAX) content = content.slice(0, INTERACTIVE_SRC_MAX);
    map.set(name, content);
  }
  return Array.from(map, ([name, content]) => ({ name, content }));
}

/**
 * 保存题目携带的交互题配套文件。
 * 只有请求里**显式出现**的字段才会被修改（未出现 = 保持原样）；传空字符串表示删除该文件；
 * headers 一旦出现即整体替换（清空旧头文件后写入新列表）。
 * 返回 { error } 或 { results }。
 */
function saveInteractiveAssets(id, data) {
  const has = (k) => Object.prototype.hasOwnProperty.call(data || {}, k);
  const pick = { };
  if (has('interactor_source')) {
    const v = String(data.interactor_source || '');
    if (v.length > INTERACTIVE_SRC_MAX) return { error: 'interactor.cpp 内容过长（最多 200KB）' };
    pick.interactor = v;
  }
  if (has('grader_source')) {
    const v = String(data.grader_source || '');
    if (v.length > INTERACTIVE_SRC_MAX) return { error: 'grader.cpp 内容过长（最多 200KB）' };
    pick.grader = v;
  }
  if (has('interactive_headers')) {
    pick.headers = normalizeHeaders(data.interactive_headers);
  }
  if (pick.interactor === undefined && pick.grader === undefined && pick.headers === undefined) {
    return { results: null };
  }
  try {
    const results = writeInteractiveAssets(id, pick);
    return { results };
  } catch (e) {
    return { error: `写入交互题配套文件失败：${e.message}` };
  }
}

function serializeProblemBrief(row) {
  const diff = difficultyByLevel(row.difficulty);
  return {
    id: row.id,
    title: row.title,
    difficulty: row.difficulty,
    difficulty_label: diff.label,
    difficulty_color: diff.color,
    tags: parseTags(row.tags),
    source: row.source || '',
    submit_count: row.submit_count,
    accepted_count: row.accepted_count,
    time_limit_ms: row.time_limit_ms,
    memory_limit_mb: row.memory_limit_mb,
    show_score: row.show_score === undefined ? true : !!row.show_score,
    created_at: row.created_at,
    is_public: !!row.is_public,
  };
}

/**
 * v2.5.3：题目**实际生效**的时限 / 内存区间（题目级 + 各测试点点级，点级留空 = 继承题目级）。
 * 只回 4 个数字的派生值，不给题目详情接口塞测试点列表（避免无谓负载与泄题风险）；
 * 前端据此显示：全部相同 → 单个值；存在不同 → 「最小值 ~ 最大值」。
 * 只读派生字段，不参与判题（判题仍是逐点「点级 ?? 题目级」）。
 */
function limitsRangeOf(row) {
  const gTl = Number(row && row.time_limit_ms) > 0 ? Number(row.time_limit_ms) : 0;
  const gMem = Number(row && row.memory_limit_mb) > 0 ? Number(row.memory_limit_mb) : 0;
  let cases = [];
  try { cases = readCaseLimits(row.id); } catch { cases = []; }
  const tls = [];
  const mems = [];
  if (!cases.length) {
    // 还没有测试数据：区间就是题目级本身
    tls.push(gTl);
    mems.push(gMem);
  } else {
    for (const c of cases) {
      tls.push(c.time_limit_ms != null ? c.time_limit_ms : gTl);
      mems.push(c.memory_limit_mb != null ? c.memory_limit_mb : gMem);
    }
  }
  return {
    time_limit_min_ms: Math.min(...tls),
    time_limit_max_ms: Math.max(...tls),
    memory_limit_min_mb: Math.min(...mems),
    memory_limit_max_mb: Math.max(...mems),
  };
}

/**
 * 通信题（communication）在题目详情里额外带出的题目侧开关：
 *   pipe_mode                  'relay'（评测端中转，默认）/ 'direct'（双向管道直连）
 *   pipe_mode_label            给前端直接显示的中文说明
 *   prog1_output_limit_bytes   程序一输出（= 通信量）上限；0 = 不限（仅受系统输出上限约束）
 *   duplex                     direct 模式下是否把程序二的输出回传给程序一的 stdin
 * 这些值都存在题目数据目录的 meta.json 里（见 src/db.js 的 readCommunicationConfig），
 * 非通信题也返回默认值，前端只在题型为 communication 时展示。
 */
function communicationInfoOf(row) {
  let cfg = { pipe_mode: 'relay', prog1_output_limit_bytes: 0, duplex: false };
  try { cfg = readCommunicationConfig(row.id); } catch { /* ignore */ }
  return {
    pipe_mode: cfg.pipe_mode,
    pipe_mode_label: cfg.pipe_mode === 'direct' ? 'direct（双向管道直连）' : 'relay（评测端中转）',
    prog1_output_limit_bytes: cfg.prog1_output_limit_bytes,
    duplex: !!cfg.duplex,
  };
}

function serializeProblemDetail(row, includeAdmin = false) {
  const brief = serializeProblemBrief(row);
  const obj = {
    ...brief,
    // v2.5.3：实际生效的限额区间（题目级 + 各测试点点级），供题目页显示「1000 ms ~ 2000 ms」
    ...limitsRangeOf(row),
    description: row.description,
    description_html: markdownToHtml(row.description),
    background: row.background || '',
    background_html: markdownToHtml(row.background || ''),
    input_format: row.input_format,
    input_format_html: markdownToHtml(row.input_format),
    output_format: row.output_format,
    output_format_html: markdownToHtml(row.output_format),
    samples: parseSamples(row.samples),
    hint: row.hint,
    hint_html: markdownToHtml(row.hint),
    created_by: row.created_by,
    editorial_closed: !!row.editorial_closed,
    enable_o2: row.enable_o2 === undefined ? true : !!row.enable_o2,
    spj: !!row.spj,
    output_only: !!row.output_only,
    problem_type: normalizeProblemType(row.problem_type),
    interactive_hint: row.interactive_hint || '',
    interactive_hint_html: markdownToHtml(row.interactive_hint || ''),
    has_checker: fs.existsSync(checkerPath(row.id)),
    has_interactor: fs.existsSync(interactorPath(row.id)),
    has_grader: fs.existsSync(graderPath(row.id)),
    // 通信题：连接方式（relay / direct）与通信量上限等题目侧开关都存在于 meta.json 里；
    // 非通信题也照常返回默认值（pipe_mode='relay'、limit=0），前端只在题型为 communication 时使用它。
    ...communicationInfoOf(row),
  };
  if (includeAdmin) {
    obj.testcase_count = testcaseCount(row.id);
    // 交互题的配套源码与头文件只在管理端返回（题目页不展示，避免每次浏览都传大段源码）
    obj.interactor_source = readFileIfExists(interactorPath(row.id));
    obj.grader_source = readFileIfExists(graderPath(row.id));
    obj.interactive_headers = listInteractiveHeaders(row.id);
  }
  return obj;
}

function listProblems(query, userId, isAdmin, canManage = false) {
  const { page, size, offset } = parsePagination(query);
  const search = (query.get('search') || '').trim();
  // 多选标签/来源：逗号分隔（tag=a,b 或 source=洛谷,Codeforces），任一命中即可（OR）
  const tagList = (query.get('tag') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const sourceList = (query.get('source') || '').split(',').map((s) => s.trim()).filter(Boolean);
  let difficulty = parseInt(query.get('difficulty') || '-1', 10);
  // 拥有「题目管理」权限的用户在前台也能看到未公开题目（管理员仍可用 all=1 控制）
  const showAll = canManage || (isAdmin && query.get('all') === '1');

  const where = showAll ? [] : ['p.is_public = 1'];
  const params = [];
  if (search) {
    where.push('(p.title LIKE ? OR p.tags LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (tagList.length) {
    where.push('(' + tagList.map(() => 'p.tags LIKE ?').join(' OR ') + ')');
    for (const t of tagList) params.push(`%"${t}"%`);
  }
  if (sourceList.length) {
    where.push('(' + sourceList.map(() => 'p.source = ?').join(' OR ') + ')');
    for (const s of sourceList) params.push(s);
  }
  if (difficulty >= 0 && difficulty <= 7) {
    where.push('p.difficulty = ?');
    params.push(difficulty);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM problems p ${whereSql}`).get(...params).c;
  // 排序：默认题号升序（前台题库），后台题目管理传 sort=id_desc 走倒序（新题在最上面）
  const orderSql = (query.get('sort') || '').toLowerCase() === 'id_desc' ? 'ORDER BY p.id DESC' : 'ORDER BY p.id ASC';
  const rows = db.prepare(`
    SELECT p.* FROM problems p ${whereSql}
    ${orderSql} LIMIT ? OFFSET ?
  `).all(...params, size, offset);

  const items = rows.map(serializeProblemBrief);

  if (userId) {
    // 提交过（任意）与已 AC 的题目集合，供列表状态列显示 ✓/✗。
    // 仅统计题库提交（contest_id IS NULL），赛时提交与题库完全独立、不同步。
    const subRows = db.prepare('SELECT DISTINCT problem_id FROM submissions WHERE user_id = ? AND contest_id IS NULL').all(userId);
    const subSet = new Set(subRows.map((r) => r.problem_id));
    const acRows = db.prepare(
      `SELECT DISTINCT problem_id FROM submissions WHERE user_id = ? AND verdict = 'Accepted' AND contest_id IS NULL`
    ).all(userId);
    const acSet = new Set(acRows.map((r) => r.problem_id));
    for (const it of items) {
      it.user_submitted = subSet.has(it.id);
      it.user_ac = acSet.has(it.id);
    }
  }

  return { items, total, page, size };
}

function getProblem(id, userId, isAdmin, allowHidden = false) {
  const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
  if (!row) return null;
  if (!row.is_public && !isAdmin && !allowHidden) return { forbidden: true };
  const obj = serializeProblemDetail(row, isAdmin);
  // 上传者用户名
  const creator = row.created_by
    ? db.prepare('SELECT username FROM users WHERE id = ?').get(row.created_by)
    : null;
  obj.created_by_username = creator ? creator.username : '';
  if (userId) {
    obj.is_favorite = !!db.prepare('SELECT user_id FROM favorites WHERE user_id = ? AND problem_id = ?').get(userId, id);
    // 我的历史提交（右侧栏「历史分数」；题目设置不显示分数时 score 置 null，前端显示 AC/WA）。
    // 这里**只取最近 8 条**用于展示/算历史最高分；页面上的「提交记录 N 次」必须用下面的真实总数
    // （此前前端直接把本数组长度当次数，导致提交 ≥9 次时永远显示 8 次）。
    const mine = db.prepare(`
      SELECT id, verdict, score, time_ms, created_at FROM submissions
      WHERE user_id = ? AND problem_id = ? AND contest_id IS NULL
      ORDER BY id DESC LIMIT 8
    `).all(userId, id);
    // 真实统计（按 用户 + 题目，只统计题库提交，与 my_submissions / 提交记录页的口径一致）：
    //   total = 提交次数（页面「提交记录 N 次」，不能再用被 LIMIT 8 截断的数组长度）
    //   best  = 历史最高分（同样不能被最近 8 条截断）
    //   ac    = 是否有过 Accepted（题目不显示分数时前端据此显示 AC/WA）
    const agg = db.prepare(`
      SELECT COUNT(*) AS total, MAX(score) AS best,
             MAX(CASE WHEN verdict = 'Accepted' THEN 1 ELSE 0 END) AS ac
      FROM submissions
      WHERE user_id = ? AND problem_id = ? AND contest_id IS NULL
    `).get(userId, id);
    obj.my_submission_count = agg.total;
    obj.my_best_score = agg.best == null ? null : agg.best;
    obj.my_accepted = !!agg.ac;
    // 列表只保留最近若干条：明确告诉前端保留条数，避免再次把数组长度当次数
    obj.my_submissions_limit = 8;
    obj.my_submissions = mine.map((s) => ({
      id: s.id,
      verdict: s.verdict,
      score: obj.show_score ? s.score : null,
      time_ms: s.time_ms,
      created_at: s.created_at,
    }));
  } else {
    obj.is_favorite = false;
    obj.my_submissions = [];
    obj.my_submission_count = 0;
    obj.my_best_score = null;
    obj.my_accepted = false;
    obj.my_submissions_limit = 8;
  }
  return obj;
}

function createProblem(data, adminId) {
  const title = String(data.title || '').trim();
  if (!title) return { error: '题目标题不能为空' };
  const difficulty = Math.max(0, Math.min(7, parseInt(data.difficulty, 10) || 0));
  const timeLimit = Math.max(100, Math.min(10000, parseInt(data.time_limit_ms || '1000', 10) || 1000));
  const memLimit = Math.max(16, Math.min(1024, parseInt(data.memory_limit_mb || '256', 10) || 256));
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t)).filter(Boolean).slice(0, 10) : [];
  const samples = Array.isArray(data.samples) ? data.samples.filter((s) => s && (s.input != null || s.output != null)) : [];
  const t = resolveProblemType(data, null);

  const info = db.prepare(`
    INSERT INTO problems (id, slug, title, description, background, input_format, output_format, samples, hint, tags, source, difficulty, time_limit_ms, memory_limit_mb, show_score, is_public, enable_o2, spj, output_only, problem_type, interactive_hint, created_by, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    require('./db').nextFreeId('problems'),
    title,
    String(data.description || ''),
    String(data.background || ''),
    String(data.input_format || ''),
    String(data.output_format || ''),
    JSON.stringify(samples),
    String(data.hint || ''),
    JSON.stringify(tags),
    String(data.source || '').slice(0, 50),
    difficulty, timeLimit, memLimit,
    data.show_score === false ? 0 : 1,
    data.is_public === false ? 0 : 1,
    data.enable_o2 === false ? 0 : 1,
    data.spj === true ? 1 : 0,
    t.output_only,
    t.problem_type,
    String(data.interactive_hint || '').slice(0, INTERACTIVE_HINT_MAX),
    adminId,
    Date.now()
  );
  const newId = Number(info.lastInsertRowid);
  // 交互题：保存交互器 / grader / 头文件（字段缺省则不动）
  const assets = saveInteractiveAssets(newId, data);
  if (assets.error) return { error: assets.error };
  return { id: newId };
}

function updateProblem(id, data) {
  const row = db.prepare('SELECT id, problem_type FROM problems WHERE id = ?').get(id);
  if (!row) return { error: '题目不存在' };
  const difficulty = Math.max(0, Math.min(7, parseInt(data.difficulty, 10) || 0));
  const timeLimit = Math.max(100, Math.min(10000, parseInt(data.time_limit_ms || '1000', 10) || 1000));
  const memLimit = Math.max(16, Math.min(1024, parseInt(data.memory_limit_mb || '256', 10) || 256));
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t)).filter(Boolean).slice(0, 10) : [];
  const samples = Array.isArray(data.samples) ? data.samples.filter((s) => s && (s.input != null || s.output != null)) : [];
  // 类型与遗留 output_only 列的同步：读取现有行，兼容「只想改类型」或「只传旧字段」的调用
  const t = resolveProblemType(data, row);

  db.prepare(`
    UPDATE problems SET title=?, description=?, background=?, input_format=?, output_format=?, samples=?, hint=?, tags=?, source=?, difficulty=?, time_limit_ms=?, memory_limit_mb=?, show_score=?, is_public=?, editorial_closed=?, enable_o2=?, spj=?, output_only=?, problem_type=?, interactive_hint=? WHERE id=?
  `).run(
    String(data.title || '').trim(),
    String(data.description || ''),
    String(data.background || ''),
    String(data.input_format || ''),
    String(data.output_format || ''),
    JSON.stringify(samples),
    String(data.hint || ''),
    JSON.stringify(tags),
    String(data.source || '').slice(0, 50),
    difficulty, timeLimit, memLimit,
    data.show_score === false ? 0 : 1,
    data.is_public === false ? 0 : 1,
    data.editorial_closed === true ? 1 : 0,
    data.enable_o2 === false ? 0 : 1,
    data.spj === true ? 1 : 0,
    t.output_only,
    t.problem_type,
    String(data.interactive_hint || '').slice(0, INTERACTIVE_HINT_MAX),
    id
  );
  // 交互题：保存交互器 / grader / 头文件（请求里未出现的字段保持原样）
  const assets = saveInteractiveAssets(id, data);
  if (assets.error) return { error: assets.error };
  return { id: Number(id), assets: assets.results || undefined };
}

/** 删除题目：连带删除测试数据目录、附件目录、收藏行（提交记录由外键 CASCADE 处理） */
function deleteProblem(id) {
  const pid = parseInt(id, 10);
  if (!Number.isFinite(pid)) return { error: '题目不存在' };
  const row = db.prepare('SELECT id FROM problems WHERE id = ?').get(pid);
  if (!row) return { error: '题目不存在' };
  const info = db.prepare('DELETE FROM problems WHERE id = ?').run(pid);
  // L12：收藏表（favorites）没有指向 problems 的外键，删除题目时必须按 (item_type,item_id) 清理，
  // 否则残留收藏行会在题号复用后「串号」到新题目上（收藏数与收藏页 JOIN 结果也会不一致）。
  try { db.prepare("DELETE FROM favorites WHERE item_type = 'problem' AND item_id = ?").run(pid); } catch { /* ignore */ }
  try { db.prepare('DELETE FROM favorites WHERE problem_id = ?').run(pid); } catch { /* 旧结构兼容 */ }
  // 磁盘清理：测试数据 / 附件（失败不影响删除结果）
  try { fs.rmSync(problemDir(pid), { recursive: true, force: true }); } catch { /* ignore */ }
  try { require('./attachments').removeAll(pid); } catch { /* ignore */ }
  return info.changes > 0;
}

/**
 * 重算某题的提交数 / 通过数（L11）。
 * 与 judge.js 的 bumpProblemStats 口径一致（都由 submissions 表推导，不做累加），
 * 但放在本模块便于「删提交」的路径直接调用——不改变判题语义。
 */
function recomputeProblemStats(problemId) {
  const pid = parseInt(problemId, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { error: '题目不存在' };
  const total = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE problem_id = ?').get(pid).c;
  const ac = db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE problem_id = ? AND verdict = 'Accepted'").get(pid).c;
  db.prepare('UPDATE problems SET submit_count = ?, accepted_count = ? WHERE id = ?').run(total, ac, pid);
  return { id: pid, submit_count: total, accepted_count: ac };
}

/** 设置某题题解提交通道开关（仅管理员） */
function setEditorialClosed(id, closed) {
  const row = db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
  if (!row) return { error: '题目不存在' };
  db.prepare('UPDATE problems SET editorial_closed = ? WHERE id = ?').run(closed ? 1 : 0, id);
  return { id: Number(id), editorial_closed: !!closed };
}

/* ============================ 题目导出 / 题号迁移 ============================ */

/** 把题目行转成导入格式的 spec（与 src/problem-import.js 的字段一一对应，可再次导入） */
function problemToSpec(row) {
  const cases = getTestcases(row.id);
  const scores = getSubtaskScores(row.id);
  const types = getSubtaskTypes(row.id);
  const checker = getChecker(row.id);
  const spec = {
    title: row.title,
    description: row.description || '',
    background: row.background || '',
    input_format: row.input_format || '',
    output_format: row.output_format || '',
    samples: parseSamples(row.samples),
    hint: row.hint || '',
    tags: parseTags(row.tags),
    source: row.source || '',
    difficulty: row.difficulty,
    time_limit_ms: row.time_limit_ms,
    memory_limit_mb: row.memory_limit_mb,
    is_public: !!row.is_public,
    // show_score / editorial_closed 也必须进清单，否则整库导出→导入会把这几个开关重置成默认值（M11）
    show_score: row.show_score === undefined ? true : !!row.show_score,
    editorial_closed: !!row.editorial_closed,
    spj: !!row.spj,
    output_only: !!row.output_only,
    enable_o2: row.enable_o2 === undefined ? true : !!row.enable_o2,
    problem_type: normalizeProblemType(row.problem_type),
    interactive_hint: row.interactive_hint || '',
    // 测试数据内联在清单里：ZIP 目录形式导入会把所有测试点并成一个子任务，
    // 内联才能完整保留子任务分组与分数（同时也会把 1.in/1.out 作为文件放进包内便于人工查看）
    // v2.5.3：点级限额（time_limit_ms / memory_limit_mb）一并内联，null = 继承题目级
    testcases: cases.map((c) => ({
      input: c.input, output: c.output, subtask: c.subtask,
      time_limit_ms: c.time_limit_ms != null ? c.time_limit_ms : null,
      memory_limit_mb: c.memory_limit_mb != null ? c.memory_limit_mb : null,
    })),
    subtask_scores: scores,
    subtask_types: types,
  };
  if (checker) spec.checker = checker;
  // 交互题：把交互器 / grader / 头文件也写进导出清单（便于整库导出后再次导入还原）
  const interactor = readFileIfExists(interactorPath(row.id));
  const grader = readFileIfExists(graderPath(row.id));
  const headers = listInteractiveHeaders(row.id);
  if (interactor) spec.interactor = interactor;
  if (grader) spec.grader = grader;
  if (headers.length) spec.interactive_headers = headers;
  return { spec, cases };
}

/** 导出单个题目：返回 { filename, buffer, count }（ZIP：import.json + testdata/*.in|out + checker） */
function exportProblem(id) {
  const pid = parseInt(id, 10);
  const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(pid);
  if (!row) return { error: '题目不存在' };
  const { spec, cases } = problemToSpec(row);
  const entries = [
    { name: 'import.json', data: JSON.stringify([spec], null, 2) },
    {
      name: 'README.txt',
      data: [
        `LCZOJ 题目导出包： #${pid} ${row.title}`,
        '',
        '· import.json          题目清单（可直接用「题目导入」再次导入，含测试数据与子任务分数）',
        '· testdata/<n>.in|out  每个测试点的输入 / 期望输出（与清单内容一致，便于人工查看）',
        '· testdata/checker.cpp Special Judge 的 checker（仅 spj 题目）',
        '· testdata/meta.json   子任务分组 / 分数 / 计分方式',
        '',
        `导出时间：${new Date().toISOString()}`,
      ].join('\n'),
    },
  ];
  for (const c of cases) {
    entries.push({ name: `testdata/${c.id}.in`, data: c.input });
    entries.push({ name: `testdata/${c.id}.out`, data: c.output });
  }
  const checker = getChecker(pid);
  if (checker) entries.push({ name: 'testdata/checker.cpp', data: checker });
  // 交互题配套文件（IO 交互的交互器 / 函数式交互的 grader 与头文件）
  const interactorSrc = readFileIfExists(interactorPath(pid));
  if (interactorSrc) entries.push({ name: 'testdata/interactor.cpp', data: interactorSrc });
  const graderSrc = readFileIfExists(graderPath(pid));
  if (graderSrc) entries.push({ name: 'testdata/grader.cpp', data: graderSrc });
  for (const h of listInteractiveHeaders(pid)) entries.push({ name: `testdata/${h.name}`, data: h.content });
  entries.push({
    name: 'testdata/meta.json',
    data: JSON.stringify({
      subtask_of_case: cases.map((c) => c.subtask),
      subtask_scores: getSubtaskScores(pid),
      subtask_types: getSubtaskTypes(pid),
      // v2.5.3：点级限额（按测试点顺序；null = 继承题目级）
      case_limits: cases.map((c) => ({
        time_limit_ms: c.time_limit_ms != null ? c.time_limit_ms : null,
        memory_limit_mb: c.memory_limit_mb != null ? c.memory_limit_mb : null,
      })),
    }, null, 2),
  });
  const safeTitle = String(row.title || ('problem-' + pid)).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return { filename: `problem-${pid}-${safeTitle}.zip`, buffer: buildZip(entries), count: cases.length, title: row.title };
}

/**
 * 批量导出：把指定题号（`ids` 为数组）或**全部题目**（`ids` 为空）打包成一个 ZIP。
 * 结构：
 *   import.json        题目清单（测试数据内联，可整体再次导入；每题的 dir 指向自己的数据目录）
 *   data/<题号>/n.in|out   各题测试数据文件（便于人工查看）
 *   data/<题号>/checker.cpp  Special Judge 的 checker（仅 spj 题目）
 *   README.txt         包内说明
 * @param {number[]|null} ids 题号数组；传 null / 空数组表示导出全部
 */
function exportProblemsZip(ids) {
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const clean = [...new Set(ids.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n)))];
    if (!clean.length) return { error: '没有指定要导出的题目' };
    const holders = clean.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM problems WHERE id IN (${holders}) ORDER BY id ASC`).all(...clean);
    if (!rows.length) return { error: '指定的题目都不存在' };
  } else {
    rows = db.prepare('SELECT * FROM problems ORDER BY id ASC').all();
    if (!rows.length) return { error: '题库里还没有题目' };
  }

  const specs = [];
  const entries = [];
  let caseCount = 0;
  for (const row of rows) {
    const { spec, cases } = problemToSpec(row);
    const dir = `data/${row.id}`;
    spec.dir = dir;                 // 导入端也能按目录读取测试数据；内联 testcases 仍会保留子任务分组
    specs.push(spec);
    caseCount += cases.length;
    for (const c of cases) {
      entries.push({ name: `${dir}/${c.id}.in`, data: c.input });
      entries.push({ name: `${dir}/${c.id}.out`, data: c.output });
    }
    if (spec.checker) entries.push({ name: `${dir}/checker.cpp`, data: spec.checker });
    if (spec.interactor) entries.push({ name: `${dir}/interactor.cpp`, data: spec.interactor });
    if (spec.grader) entries.push({ name: `${dir}/grader.cpp`, data: spec.grader });
    for (const h of (spec.interactive_headers || [])) entries.push({ name: `${dir}/${h.name}`, data: h.content });
  }

  entries.unshift({
    name: 'README.txt',
    data: [
      `LCZOJ 题库导出包：共 ${rows.length} 道题目、${caseCount} 个测试点`,
      '',
      '· import.json          题目清单数组（用「题目导入」可整体再次导入，含测试数据与子任务分数）',
      '· data/<题号>/         各题测试数据文件与 checker（便于人工查看）',
      '',
      `导出题目：${rows.map((r) => '#' + r.id).join(', ')}`,
      `导出时间：${new Date().toISOString()}`,
    ].join('\n'),
  });
  entries.splice(1, 0, { name: 'import.json', data: JSON.stringify(specs, null, 2) });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = (Array.isArray(ids) && ids.length)
    ? `lczoj-problems-${rows.length}-${stamp}.zip`
    : `lczoj-problems-all-${rows.length}-${stamp}.zip`;
  return { filename, buffer: buildZip(entries), count: rows.length, testcases: caseCount, title: rows.length === 1 ? rows[0].title : undefined };
}

/** 导出全部题目：返回 { filename, buffer, count }（一个 ZIP，含所有题目的清单与测试数据） */
function exportAllProblems() {
  return exportProblemsZip(null);
}

/** 只导出题目清单（JSON 数组，测试数据内联）：便于脚本处理或只做备份 */
function exportProblemsJson(ids) {
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const clean = [...new Set(ids.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n)))];
    if (!clean.length) return { error: '没有指定要导出的题目' };
    const holders = clean.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM problems WHERE id IN (${holders}) ORDER BY id ASC`).all(...clean);
  } else {
    rows = db.prepare('SELECT * FROM problems ORDER BY id ASC').all();
  }
  if (!rows.length) return { error: '没有可导出的题目' };
  const specs = rows.map((row) => problemToSpec(row).spec);
  const stamp = new Date().toISOString().slice(0, 10);
  return { filename: `lczoj-problems-${rows.length}-${stamp}.json`, problems: specs, count: rows.length };
}

/**
 * 迁移题号：把题目整体搬到新的 ID 下。
 * 会一并迁移：提交记录 / 题解 / 讨论 / 收藏 / 比赛关联（数据库）与测试数据、附件目录（磁盘）。
 * 实现方式：先在目标题号下复制题目行 → 把所有引用改到新题号 → 再删除原行，
 * 这样即使外键是 ON DELETE CASCADE 也不会误删子表中的数据。
 */
function migrateProblem(id, newId) {
  const from = parseInt(id, 10);
  const to = parseInt(newId, 10);
  if (!Number.isFinite(from) || from <= 0) return { error: '题目不存在' };
  if (!Number.isFinite(to) || to <= 0) return { error: '新题号必须是正整数' };
  if (to > 1000000) return { error: '新题号过大（上限 1000000）' };
  if (to === from) return { error: '新题号与当前题号相同' };
  const src = db.prepare('SELECT * FROM problems WHERE id = ?').get(from);
  if (!src) return { error: '题目不存在' };
  if (db.prepare('SELECT id FROM problems WHERE id = ?').get(to)) return { error: `题号 ${to} 已被占用` };

  // 磁盘：测试数据目录 + 附件目录（先移，失败就整个中止，避免库与磁盘不一致）
  const dirFrom = problemDir(from);
  const dirTo = problemDir(to);
  let movedTestdata = false;
  try {
    if (fs.existsSync(dirFrom)) {
      fs.rmSync(dirTo, { recursive: true, force: true });
      fs.renameSync(dirFrom, dirTo);
      movedTestdata = true;
    }
  } catch (e) {
    return { error: '迁移测试数据目录失败：' + e.message };
  }
  let movedAttachments = false;
  try {
    const att = require('./attachments');
    if (typeof att.moveAll === 'function') movedAttachments = att.moveAll(from, to);
  } catch { /* 附件迁移失败不影响题目本体 */ }

  const cols = db.prepare('PRAGMA table_info(problems)').all().map((c) => c.name).filter((n) => n !== 'id');
  const quoted = cols.map((c) => '"' + c + '"').join(', ');
  try {
    db.exec('BEGIN');
    db.prepare(`INSERT INTO problems (id, ${quoted}) SELECT ?, ${quoted} FROM problems WHERE id = ?`).run(to, from);
    const moved = {
      submissions: db.prepare('UPDATE submissions SET problem_id = ? WHERE problem_id = ?').run(to, from).changes,
      editorials: db.prepare('UPDATE editorials SET problem_id = ? WHERE problem_id = ?').run(to, from).changes,
      discussions: db.prepare('UPDATE discussions SET problem_id = ? WHERE problem_id = ?').run(to, from).changes,
      favorites: db.prepare('UPDATE favorites SET problem_id = ? WHERE problem_id = ?').run(to, from).changes,
      contest_problems: db.prepare('UPDATE contest_problems SET problem_id = ? WHERE problem_id = ?').run(to, from).changes,
    };
    db.prepare('DELETE FROM problems WHERE id = ?').run(from);
    db.exec('COMMIT');
    return { id: to, from, moved, moved_testdata: movedTestdata, moved_attachments: movedAttachments };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    // 回滚磁盘上的目录移动，保持「要么都成功、要么都不动」
    if (movedTestdata) {
      try {
        fs.rmSync(dirFrom, { recursive: true, force: true });
        fs.renameSync(dirTo, dirFrom);
      } catch { /* ignore */ }
    }
    if (movedAttachments) {
      try { require('./attachments').moveAll(to, from); } catch { /* ignore */ }
    }
    return { error: '迁移失败：' + e.message };
  }
}

// 题目页面/编辑器的测试数据展示上限：超过该大小的数据不在页面预览（评测仍使用完整数据）
const TESTDATA_DISPLAY_CAP = 16 * 1024;

function readFileIfExists(p) {
  // v2.6.3（待办 #16）：题目数据目录里的 checker.cpp / interactor.cpp / grader.cpp / 头文件
  // 与测试数据预览都可能是 GBK 编码（中文 Windows 按 ANSI 保存），统一「UTF-8 优先 + GBK 回退」解码，
  // 避免后台编辑器里显示成乱码、以及保存时把乱码固化下来。
  try { return decodeText(fs.readFileSync(p)); } catch { return ''; }
}

function setTestcases(id, cases, meta) {
  // spj 也要读出来：pruneStaleAssets 以「题目身份标记」决定 checker 是否保留（SPJ 题的 checker 必须留住）
  const row = db.prepare('SELECT id, problem_type, spj FROM problems WHERE id = ?').get(id);
  if (!row) return { error: '题目不存在' };
  if (!Array.isArray(cases) || cases.length === 0) return { error: '至少需要一个测试点' };
  const dir = problemDir(id);
  const clean = cases.map((c, i) => {
    const n = i + 1;
    // keep_input / keep_output：数据过大未在页面预览，保存时复用磁盘上的原文件
    // keep_from：该行在页面加载时的原始文件编号（删除测试点后行号会变化，必须按原始编号取文件）
    let input = String(c.input ?? '');
    let output = String(c.output ?? '');
    if (c.keep_input) {
      const src = c.keep_from != null ? parseInt(c.keep_from, 10) : n;
      input = readFileIfExists(path.join(dir, `${src}.in`));
    }
    if (c.keep_output) {
      const src = c.keep_from != null ? parseInt(c.keep_from, 10) : n;
      output = readFileIfExists(path.join(dir, `${src}.out`));
    }
    return {
      input,
      output,
      subtask: c.subtask != null ? parseInt(c.subtask, 10) : undefined,
      // v2.5.3 点级限额：留空（'' / null / undefined）→ null = 继承题目级；
      // 具体限幅与非法值处理由 db.writeTestcases 的 normalizeCaseLimit 统一负责。
      time_limit_ms: c.time_limit_ms != null && c.time_limit_ms !== '' ? c.time_limit_ms : null,
      memory_limit_mb: c.memory_limit_mb != null && c.memory_limit_mb !== '' ? c.memory_limit_mb : null,
    };
  });
  const r = writeTestcases(id, clean, meta || {});
  // M12：writeTestcases 会「备份 → 清空 → 恢复」目录里的 checker / interactor / grader / *.h，
  // 该行为本身是为了「保存测试数据不弄丢配套文件」，但恢复必须**以当前题目的身份标记为准**：
  // 普通题不应保留上一份数据（或上一个同号题目）留下的 checker / 交互文件。
  pruneStaleAssets(id, row, {});
  return { id: Number(id), count: r.count, subtasks: r.subtasks };
}

/**
 * 按题目身份标记清理目录里「不该存在」的配套文件（M12）。
 * provided 里的键表示本次操作已经显式提供了对应文件（此时不清理）：
 *   checker / interactor / grader / headers
 * 身份规则：checker 只属于 SPJ 题；interactor 只属于 IO 交互题；
 *          grader 与头文件属于函数式交互题与**通信题**（通信题的 grader.cpp 是可选的评测端中转程序）。
 */
function pruneStaleAssets(id, row, provided = {}) {
  const type = normalizeProblemType(row && row.problem_type);
  const isSpj = !!(row && row.spj);
  const keepGrader = needsGraderFile(type);
  const dir = problemDir(id);
  const removeIfStale = (file, keep, label) => {
    if (provided[label]) return false;   // 本次已写入新内容
    if (keep) return false;              // 身份标记要求保留
    try {
      if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); return true; }
    } catch { /* ignore */ }
    return false;
  };
  const removed = [];
  if (removeIfStale(checkerPath(id), isSpj, 'checker')) removed.push('checker.cpp');
  if (removeIfStale(interactorPath(id), type === 'interactive_io', 'interactor')) removed.push('interactor.cpp');
  if (removeIfStale(graderPath(id), keepGrader, 'grader')) removed.push('grader.cpp');
  if (!provided.headers && !keepGrader) {
    for (const h of listInteractiveHeaders(id)) {
      try { fs.rmSync(path.join(dir, h.name), { force: true }); removed.push(h.name); } catch { /* ignore */ }
    }
  }
  if (removed.length) console.log(`[problems] 题目 #${id}（${type}${isSpj ? '+SPJ' : ''}）已清理不适用的配套文件：${removed.join('、')}`);
  return removed;
}

function getTestcases(id) {
  const cases = readTestcases(id);
  return cases.map((c) => {
    const inSize = Buffer.byteLength(c.input, 'utf8');
    const outSize = Buffer.byteLength(c.output, 'utf8');
    let input = c.input, output = c.output;
    let inputTrunc = false, outputTrunc = false;
    if (inSize > TESTDATA_DISPLAY_CAP) { input = c.input.slice(0, TESTDATA_DISPLAY_CAP); inputTrunc = true; }
    if (outSize > TESTDATA_DISPLAY_CAP) { output = c.output.slice(0, TESTDATA_DISPLAY_CAP); outputTrunc = true; }
    return { ...c, input, output, input_truncated: inputTrunc, output_truncated: outputTrunc, input_size: inSize, output_size: outSize };
  });
}

function getSubtaskScores(id) {
  return readSubtaskScores(id);
}

/** 通信题的题目侧开关（后台编辑页「测试数据」卡片里编辑，随测试数据一起保存） */
function getCommunicationConfig(id) {
  try { return readCommunicationConfig(id); } catch { return { pipe_mode: 'relay', prog1_output_limit_bytes: 0, duplex: false }; }
}

/** 读取 checker.cpp 内容（未启用 SPJ 或无文件时返回空） */
function getChecker(id) {
  return readFileIfExists(checkerPath(id));
}

/** 保存 checker.cpp 内容（供后台直接编辑） */
function saveChecker(id, content) {
  const row = db.prepare('SELECT id, spj FROM problems WHERE id = ?').get(id);
  if (!row) return { error: '题目不存在' };
  const c = String(content || '');
  if (c.length > 100 * 1024) return { error: 'checker.cpp 内容过长（最多 100KB）' };
  const { checkerPath, problemDir } = require('./db');
  try {
    fs.mkdirSync(problemDir(id), { recursive: true });
    fs.writeFileSync(checkerPath(id), c);
  } catch (e) {
    return { error: `写入 checker.cpp 失败：${e.message}` };
  }
  return { ok: true, has_checker: c.length > 0 };
}

/** 读取子任务计分方式（sum/min/max/bundle） */
function getSubtaskTypes(id) {
  return readSubtaskTypes(id);
}

/**
 * 上传 ZIP 测试数据包（base64），解析并写入题目测试数据。
 * opts.overwrite：true（默认）整体替换；false 合并 —— 新包同编号覆盖、新编号追加，其余保留。
 */
function uploadTestdataZip(id, zipBase64, meta, opts = {}) {
  // problem_type 也要读出来：pruneStaleAssets 以题目身份标记决定交互题配套文件是否保留
  const row = db.prepare('SELECT id, spj, problem_type FROM problems WHERE id = ?').get(id);
  if (!row) return { error: '题目不存在' };
  if (!zipBase64) return { error: '缺少测试数据包内容' };
  let buf;
  try {
    buf = Buffer.from(zipBase64, 'base64');
  } catch {
    return { error: '测试数据包编码无效' };
  }
  const { testcasesFromZip } = require('./zip');
  let parsed;
  try {
    parsed = testcasesFromZip(buf);
  } catch (e) {
    return { error: `解析 ZIP 失败：${e.message}` };
  }
  const zipCases = parsed.cases;
  if (!zipCases || zipCases.length === 0) {
    return { error: 'ZIP 中未找到测试数据（需形如 1.in / 1.out / 1.ans，可含子目录）' };
  }
  // Special Judge 题目：数据包必须含 checker.cpp（Testlib 风格）
  if (row.spj && !parsed.checker) {
    return { error: '该题已启用 Special Judge，测试数据 ZIP 内必须包含 checker.cpp（Testlib 风格）' };
  }
  const overwrite = opts.overwrite !== false;
  let mergedCount = 0; // 合并模式：原已存在的编号数
  let cases;
  let finalMeta = meta || {};
  if (overwrite) {
    // 覆盖模式：整体替换，subtask 缺省时按出现顺序 1..N
    cases = zipCases.map((c) => ({ input: c.input, output: c.output, subtask: undefined }));
  } else {
    // 合并模式：保留现有数据，同编号覆盖（沿用原 subtask 与点级限额），新编号追加
    const existing = readTestcases(id).map((c) => ({
      id: c.id, input: c.input, output: c.output, subtask: c.subtask,
      time_limit_ms: c.time_limit_ms != null ? c.time_limit_ms : null,
      memory_limit_mb: c.memory_limit_mb != null ? c.memory_limit_mb : null,
    }));
    const map = new Map(existing.map((c) => [c.id, c]));
    let maxSubtask = 0;
    for (const c of existing) if (c.subtask != null && c.subtask > maxSubtask) maxSubtask = c.subtask;
    for (const zc of zipCases) {
      const old = map.get(zc.index);
      mergedCount += old ? 1 : 0;
      map.set(zc.index, {
        id: zc.index,
        input: zc.input,
        output: zc.output,
        subtask: old && old.subtask != null ? old.subtask : (maxSubtask + 1),
        // 测试数据包本身无法携带点级限额，合并时沿用该编号原有的限额设置（无则继承题目级）
        time_limit_ms: old ? old.time_limit_ms : null,
        memory_limit_mb: old ? old.memory_limit_mb : null,
      });
      if (!old) maxSubtask += 1;
    }
    cases = Array.from(map.values())
      .sort((a, b) => a.id - b.id)
      .map((c) => ({
        input: c.input, output: c.output, subtask: c.subtask,
        time_limit_ms: c.time_limit_ms != null ? c.time_limit_ms : null,
        memory_limit_mb: c.memory_limit_mb != null ? c.memory_limit_mb : null,
      }));
    // 合并时若未显式指定子任务分数/计分方式，沿用现有配置
    if (!meta || !Array.isArray(meta.subtask_scores) || meta.subtask_scores.length === 0) {
      const oldScores = readSubtaskScores(id);
      const oldTypes = readSubtaskTypes(id);
      finalMeta = {
        ...(oldScores && oldScores.length ? { subtask_scores: oldScores } : {}),
        ...(oldTypes && oldTypes.length ? { subtask_types: oldTypes } : {}),
      };
    }
  }
  // writeTestcases 会清空测试数据目录（含旧 checker）；先备份旧 checker，便于新包无 checker 时保留 SPJ 配置
  // writeTestcases 内部会保留目录中已有的 checker.cpp（清空前备份、写后恢复）。
  // 仅 Special Judge 题目启用 checker：ZIP 内含 checker.cpp 时用新内容覆盖；
  // 非 SPJ 题目即便数据包里有 checker.cpp 也不写入（避免无谓落盘）。
  const r = writeTestcases(id, cases, finalMeta);
  if (row.spj && parsed.checker) {
    try {
      const { checkerPath, problemDir } = require('./db');
      fs.mkdirSync(problemDir(id), { recursive: true });
      fs.writeFileSync(checkerPath(id), parsed.checker);
    } catch (e) {
      return { error: `写入 checker.cpp 失败：${e.message}` };
    }
  }
  // 交互题：数据包内若含 interactor.cpp / grader.cpp / *.h 则一并写入（writeTestcases 已恢复旧文件，这里用新内容覆盖）
  const hasInteractiveFiles = !!(parsed.interactor || parsed.grader || (parsed.headers && parsed.headers.length));
  if (hasInteractiveFiles) {
    const assets = writeInteractiveAssets(id, {
      interactor: parsed.interactor || undefined,
      grader: parsed.grader || undefined,
      headers: parsed.headers && parsed.headers.length ? parsed.headers : undefined,
    });
    if (assets.interactor || assets.grader || assets.headers.length) {
      console.log(`[problems] 题目 #${id} 从测试数据包写入交互题配套文件（interactor=${assets.interactor} grader=${assets.grader} headers=${assets.headers.length}）`);
    }
  }
  // M12：配套文件以「题目身份标记」为准——数据包没带、且当前题目类型/SPJ 标记也不要求时，
  // 不能因为 writeTestcases 的备份恢复就把旧文件（可能来自上一份数据或上一个同号题目）留在题目上。
  pruneStaleAssets(id, row, {
    checker: row.spj && !!parsed.checker,
    interactor: !!parsed.interactor,
    grader: !!parsed.grader,
    headers: !!(parsed.headers && parsed.headers.length),
  });
  return {
    id: Number(id), count: r.count, pairs: zipCases.length, subtasks: r.subtasks,
    has_checker: !!parsed.checker, overwrite, merged_count: mergedCount,
    has_interactor: !!(parsed.interactor || fs.existsSync(interactorPath(id))),
    has_grader: !!(parsed.grader || fs.existsSync(graderPath(id))),
    interactive_headers: listInteractiveHeaders(id).map((h) => h.name),
  };
}

function allTags() {
  const rows = db.prepare('SELECT tags FROM problems WHERE is_public = 1').all();
  const set = new Set();
  for (const r of rows) for (const t of parseTags(r.tags)) set.add(t);
  return Array.from(set).sort();
}

/** 全部来源标签（如 洛谷/Codeforces/AtCoder/原创），按出现频率排序 */
function listSources() {
  const rows = db.prepare('SELECT source FROM problems WHERE is_public = 1 AND source != \'\'').all();
  const count = {};
  for (const r of rows) {
    const s = String(r.source || '').trim();
    if (s) count[s] = (count[s] || 0) + 1;
  }
  return Object.entries(count)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
}

module.exports = {
  serializeProblemBrief,
  serializeProblemDetail,
  listProblems,
  getProblem,
  createProblem,
  updateProblem,
  deleteProblem,
  setEditorialClosed,
  setTestcases,
  getTestcases,
  getSubtaskScores,
  getCommunicationConfig,
  getSubtaskTypes,
  getChecker,
  saveChecker,
  normalizeProblemType,
  isInteractiveType,
  isCommunicationType,
  needsGraderFile,
  resolveProblemType,
  saveInteractiveAssets,
  uploadTestdataZip,
  exportProblem,
  exportProblemsZip,
  exportProblemsJson,
  exportAllProblems,
  migrateProblem,
  allTags,
  listSources,
  problemToSpec,
  recomputeProblemStats,
  pruneStaleAssets,
  normalizeHeaders,
  DIFFICULTIES,
};
