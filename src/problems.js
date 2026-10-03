'use strict';

const fs = require('fs');
const path = require('path');
const { db, writeTestcases, readTestcases, readSubtaskScores, readSubtaskTypes, testcaseCount, checkerPath, problemDir } = require('./db');
const { difficultyByLevel, parsePagination } = require('./util');
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

function serializeProblemDetail(row, includeAdmin = false) {
  const brief = serializeProblemBrief(row);
  const obj = {
    ...brief,
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
    has_checker: fs.existsSync(checkerPath(row.id)),
  };
  if (includeAdmin) {
    obj.testcase_count = testcaseCount(row.id);
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
  const rows = db.prepare(`
    SELECT p.* FROM problems p ${whereSql}
    ORDER BY p.id ASC LIMIT ? OFFSET ?
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
    // 我的历史提交（右侧栏「历史分数」；题目设置不显示分数时 score 置 null，前端显示 AC/WA）
    const mine = db.prepare(`
      SELECT id, verdict, score, time_ms, created_at FROM submissions
      WHERE user_id = ? AND problem_id = ? AND contest_id IS NULL
      ORDER BY id DESC LIMIT 8
    `).all(userId, id);
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

  const info = db.prepare(`
    INSERT INTO problems (id, slug, title, description, background, input_format, output_format, samples, hint, tags, source, difficulty, time_limit_ms, memory_limit_mb, show_score, is_public, enable_o2, spj, output_only, created_by, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    data.output_only === true ? 1 : 0,
    adminId,
    Date.now()
  );
  return { id: Number(info.lastInsertRowid) };
}

function updateProblem(id, data) {
  const row = db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
  if (!row) return { error: '题目不存在' };
  const difficulty = Math.max(0, Math.min(7, parseInt(data.difficulty, 10) || 0));
  const timeLimit = Math.max(100, Math.min(10000, parseInt(data.time_limit_ms || '1000', 10) || 1000));
  const memLimit = Math.max(16, Math.min(1024, parseInt(data.memory_limit_mb || '256', 10) || 256));
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t)).filter(Boolean).slice(0, 10) : [];
  const samples = Array.isArray(data.samples) ? data.samples.filter((s) => s && (s.input != null || s.output != null)) : [];

  db.prepare(`
    UPDATE problems SET title=?, description=?, background=?, input_format=?, output_format=?, samples=?, hint=?, tags=?, source=?, difficulty=?, time_limit_ms=?, memory_limit_mb=?, show_score=?, is_public=?, editorial_closed=?, enable_o2=?, spj=?, output_only=? WHERE id=?
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
    data.output_only === true ? 1 : 0,
    id
  );
  return { id: Number(id) };
}

/** 删除题目：连带删除测试数据目录、附件目录（提交记录由外键 CASCADE 处理） */
function deleteProblem(id) {
  const pid = parseInt(id, 10);
  if (!Number.isFinite(pid)) return { error: '题目不存在' };
  const row = db.prepare('SELECT id FROM problems WHERE id = ?').get(pid);
  if (!row) return { error: '题目不存在' };
  const info = db.prepare('DELETE FROM problems WHERE id = ?').run(pid);
  // 磁盘清理：测试数据 / 附件（失败不影响删除结果）
  try { fs.rmSync(problemDir(pid), { recursive: true, force: true }); } catch { /* ignore */ }
  try { require('./attachments').removeAll(pid); } catch { /* ignore */ }
  return info.changes > 0;
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
    spj: !!row.spj,
    output_only: !!row.output_only,
    enable_o2: row.enable_o2 === undefined ? true : !!row.enable_o2,
    // 测试数据内联在清单里：ZIP 目录形式导入会把所有测试点并成一个子任务，
    // 内联才能完整保留子任务分组与分数（同时也会把 1.in/1.out 作为文件放进包内便于人工查看）
    testcases: cases.map((c) => ({ input: c.input, output: c.output, subtask: c.subtask })),
    subtask_scores: scores,
    subtask_types: types,
  };
  if (checker) spec.checker = checker;
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
  entries.push({
    name: 'testdata/meta.json',
    data: JSON.stringify({ subtask_of_case: cases.map((c) => c.subtask), subtask_scores: getSubtaskScores(pid), subtask_types: getSubtaskTypes(pid) }, null, 2),
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
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function setTestcases(id, cases, meta) {
  const row = db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
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
    };
  });
  const r = writeTestcases(id, clean, meta || {});
  return { id: Number(id), count: r.count, subtasks: r.subtasks };
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
  const row = db.prepare('SELECT id, spj FROM problems WHERE id = ?').get(id);
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
    // 合并模式：保留现有数据，同编号覆盖（沿用原 subtask），新编号追加
    const existing = readTestcases(id).map((c) => ({ id: c.id, input: c.input, output: c.output, subtask: c.subtask }));
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
      });
      if (!old) maxSubtask += 1;
    }
    cases = Array.from(map.values())
      .sort((a, b) => a.id - b.id)
      .map((c) => ({ input: c.input, output: c.output, subtask: c.subtask }));
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
  return {
    id: Number(id), count: r.count, pairs: zipCases.length, subtasks: r.subtasks,
    has_checker: !!parsed.checker, overwrite, merged_count: mergedCount,
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
  getSubtaskTypes,
  getChecker,
  saveChecker,
  uploadTestdataZip,
  exportProblem,
  exportProblemsZip,
  exportProblemsJson,
  exportAllProblems,
  migrateProblem,
  allTags,
  listSources,
  DIFFICULTIES,
};
