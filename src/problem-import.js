'use strict';

/* 题目导入：把 JSON / ZIP 里的题目批量建到题库（零依赖）。
 *
 * JSON 结构（单个对象或数组均可）：
 * {
 *   "title": "题目标题",              // 必填
 *   "description": "题面（Markdown，支持 $公式$）",
 *   "background": "题目背景（Markdown，留空则不显示该区块）",
 *   "input_format": "输入格式", "output_format": "输出格式",
 *   "samples": [{ "input": "1 2", "output": "3" }],
 *   "hint": "提示", "tags": ["数学"], "source": "来源",
 *   "difficulty": 1,                  // 0~7（0 暂未评级、1 入门 … 7 NOI）
 *   "time_limit_ms": 1000, "memory_limit_mb": 128,
 *   "is_public": true, "spj": false, "output_only": false, "enable_o2": true,
 *   "testcases": [{ "input": "1 2\n", "output": "3\n", "subtask": 0 }],
 *   "subtask_scores": [100], "subtask_types": ["sum"],
 *   "checker": "…checker.cpp 源码（spj=true 时可选）"
 * }
 *
 * ZIP 结构：根目录（或任意目录）放 import.json / problems.json 作为清单，
 * 每个题目用 "dir" 指定自己的数据目录，目录内放 1.in、1.out、2.in、2.out…（也支持 .ans/.txt），
 * 目录内的 checker.cpp 会作为该题的特判程序。
 */
const { db } = require('./db');
const problems = require('./problems');
const { parseZip } = require('./zip');
// v2.6.3（待办 #16 根因）：压缩包内的代码类文件（checker / interactor / grader / *.h）走稳健解码
const { decodeText } = require('./util');

const MAX_PROBLEMS = 200;
const MAX_TESTCASES = 200;

function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** 校验并规范化一条题目描述。
 *  返回 { spec, present }：present 是**清单里显式出现过的键**，
 *  覆盖导入时只改这些键（M11：未出现的字段不得被重置成默认值）。 */
function normalizeSpec(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return { error: `第 ${index + 1} 项不是合法的题目对象` };
  const title = String(raw.title || '').trim();
  if (!title) return { error: `第 ${index + 1} 项缺少 title（题目标题）` };
  if (title.length > 200) return { error: `标题过长：${title.slice(0, 40)}…` };
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined && raw[k] !== null;
  const present = Object.keys(raw).filter(has);
  const samples = Array.isArray(raw.samples)
    ? raw.samples.filter((s) => s && (s.input != null || s.output != null)).slice(0, 20).map((s) => ({ input: String(s.input ?? ''), output: String(s.output ?? '') }))
    : [];
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [];
  let testcases = Array.isArray(raw.testcases) ? raw.testcases.slice(0, MAX_TESTCASES) : [];
  testcases = testcases
    .filter((c) => c && (c.input != null || c.output != null))
    .map((c) => ({
      input: String(c.input ?? ''),
      output: String(c.output ?? ''),
      subtask: c.subtask != null ? toInt(c.subtask, 0) : 0,
      // v2.5.3 点级限额：清单里缺失 / 留空 / 非法 → null = 继承题目级（旧清单导入不报错）
      time_limit_ms: c.time_limit_ms != null && c.time_limit_ms !== '' && toInt(c.time_limit_ms, 0) > 0 ? toInt(c.time_limit_ms, 0) : null,
      memory_limit_mb: c.memory_limit_mb != null && c.memory_limit_mb !== '' && toInt(c.memory_limit_mb, 0) > 0 ? toInt(c.memory_limit_mb, 0) : null,
    }));
  return {
    present,
    spec: {
      title,
      description: String(raw.description || ''),
      background: String(raw.background || raw.background_story || ''),
      input_format: String(raw.input_format || ''),
      output_format: String(raw.output_format || ''),
      samples,
      hint: String(raw.hint || ''),
      tags,
      source: String(raw.source || '').slice(0, 50),
      difficulty: Math.max(0, Math.min(7, toInt(raw.difficulty, 0))),
      time_limit_ms: Math.max(100, Math.min(10000, toInt(raw.time_limit_ms, 1000))),
      memory_limit_mb: Math.max(16, Math.min(1024, toInt(raw.memory_limit_mb, 128))),
      is_public: raw.is_public !== false,
      spj: raw.spj === true,
      output_only: raw.output_only === true,
      enable_o2: raw.enable_o2 !== false,
      // M11：以下字段原先不在白名单里，导出后再次导入会丢失（交互题退化成普通题、开关被重置）
      show_score: raw.show_score !== false,
      editorial_closed: raw.editorial_closed === true,
      problem_type: problems.normalizeProblemType(raw.problem_type),
      interactive_hint: String(raw.interactive_hint || '').slice(0, 20 * 1024),
      interactor: typeof raw.interactor === 'string' ? raw.interactor : '',
      grader: typeof raw.grader === 'string' ? raw.grader : '',
      interactive_headers: problems.normalizeHeaders(raw.interactive_headers),
      testcases,
      subtask_scores: Array.isArray(raw.subtask_scores) ? raw.subtask_scores.map((n) => toInt(n, 0)) : null,
      subtask_types: Array.isArray(raw.subtask_types) ? raw.subtask_types.map((t) => String(t)) : null,
      checker: typeof raw.checker === 'string' ? raw.checker : '',
    },
  };
}

/** 同标题题目（用于「覆盖同名题目」） */
function findExisting(title) {
  return db.prepare('SELECT id FROM problems WHERE title = ?').get(title);
}

/**
 * 预检（不写入任何数据）：列出压缩包 / JSON 里准备导入的题目，便于导入前确认。
 * 返回 [{ index, title, testcases, difficulty, spj, output_only, exists, existing_id, error }]
 */
function previewProblems(list) {
  const items = (Array.isArray(list) ? list : [list]).slice(0, MAX_PROBLEMS);
  return items.map((raw, i) => {
    const { spec, error } = normalizeSpec(raw, i);
    if (error) return { index: i, title: '', error };
    const exist = findExisting(spec.title);
    return {
      index: i,
      title: spec.title,
      testcases: spec.testcases.length,
      difficulty: spec.difficulty,
      spj: !!spec.spj,
      output_only: !!spec.output_only,
      problem_type: spec.problem_type,
      has_interactor: !!spec.interactor,
      has_grader: !!spec.grader,
      interactive_headers: spec.interactive_headers.length,
      show_score: spec.show_score !== false,
      editorial_closed: !!spec.editorial_closed,
      is_public: spec.is_public !== false,
      exists: !!exist,
      existing_id: exist ? exist.id : null,
    };
  });
}

/**
 * 把清单里的交互题字段翻译成 problems.updateProblem / createProblem 认识的键名
 * （导出清单用 interactor / grader，编辑器接口用 interactor_source / grader_source）。
 * 只翻译清单里**显式出现**的键。
 */
function interactiveBodyFrom(spec, present) {
  const has = (k) => present.includes(k);
  const out = {};
  if (has('interactor') && spec.interactor) out.interactor_source = spec.interactor;
  if (has('grader') && spec.grader) out.grader_source = spec.grader;
  if (has('interactive_headers')) out.interactive_headers = spec.interactive_headers;
  return out;
}

/** 覆盖导入用的字段：以现有题目字段为底，只覆盖清单里显式出现的键（M11：未出现的键保持原值） */
function overwriteBody(existingId, spec, present) {
  let base = {};
  try {
    const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(existingId);
    if (row) base = problems.problemToSpec(row).spec;
  } catch { /* 读不到现有字段时退化为「只有清单字段」 */ }
  const body = { ...base };
  const KEYS = ['title', 'description', 'background', 'input_format', 'output_format', 'samples', 'hint', 'tags',
    'source', 'difficulty', 'time_limit_ms', 'memory_limit_mb', 'is_public', 'spj', 'output_only', 'enable_o2',
    'show_score', 'editorial_closed', 'problem_type', 'interactive_hint'];
  for (const k of KEYS) if (present.includes(k)) body[k] = spec[k];
  Object.assign(body, interactiveBodyFrom(spec, present));
  return body;
}

/**
 * 批量导入。返回 { created, skipped, errors }
 *   created: [{ id, title, testcases, overwritten }]
 *   skipped: [{ id, title }]（同名且冲突策略为 skip）
 *   errors:  [{ title, error }]
 * 冲突策略 onConflict：
 *   'skip'      同名题目跳过（默认在界面中选用，便于重复导入同一份包）
 *   'overwrite' 同名题目覆盖（更新题面 + 覆盖测试数据）
 *   'duplicate' 允许重复（同标题再建一道）
 * 兼容旧参数：overwrite=true 等价于 onConflict='overwrite'
 */
function importProblems(list, { overwrite = false, onConflict = '', adminId = 1 } = {}) {
  const mode = ['skip', 'overwrite', 'duplicate'].includes(onConflict)
    ? onConflict
    : (overwrite ? 'overwrite' : 'duplicate');
  const created = [];
  const skipped = [];
  const errors = [];
  const items = (Array.isArray(list) ? list : [list]).slice(0, MAX_PROBLEMS);
  if (items.length === 0) return { created, skipped, errors: [{ title: '', error: '没有可导入的题目' }] };
  for (let i = 0; i < items.length; i++) {
    const { spec, present, error } = normalizeSpec(items[i], i);
    if (error) { errors.push({ title: '', error }); continue; }
    try {
      const existing = findExisting(spec.title);
      if (existing && mode === 'skip') {
        skipped.push({ id: existing.id, title: spec.title });
        continue;
      }
      let id;
      let overwritten = false;
      if (existing && mode === 'overwrite') {
        // M11：覆盖导入只改清单里显式出现过的键，不再把 show_score / editorial_closed 等重置成默认值
        const body = overwriteBody(existing.id, spec, present);
        const r = problems.updateProblem(existing.id, body);
        if (r.error) { errors.push({ title: spec.title, error: r.error }); continue; }
        id = existing.id;
        overwritten = true;
      } else {
        // 新建：清单字段 + 交互题配套源码（createProblem 只认 interactor_source / grader_source）
        const r = problems.createProblem({ ...spec, ...interactiveBodyFrom(spec, present) }, adminId);
        if (r.error) { errors.push({ title: spec.title, error: r.error }); continue; }
        id = r.id;
      }
      let count = 0;
      if (spec.testcases.length) {
        const tr = problems.setTestcases(id, spec.testcases, { subtask_scores: spec.subtask_scores, subtask_types: spec.subtask_types });
        if (tr.error) { errors.push({ title: spec.title, error: '测试数据写入失败：' + tr.error }); continue; }
        count = tr.count;
      }
      if (spec.checker.trim()) {
        const cr = problems.saveChecker(id, spec.checker);
        if (cr.error) errors.push({ title: spec.title, error: 'checker 保存失败：' + cr.error });
      }
      created.push({ id, title: spec.title, testcases: count, overwritten, problem_type: spec.problem_type });
    } catch (e) {
      errors.push({ title: spec.title, error: e.message });
    }
  }
  return { created, skipped, errors };
}

/** 解析 ZIP 导入包 → 题目数组（每项自动带上该目录的测试数据与 checker） */
function problemsFromZip(base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) return { error: '压缩包为空' };
  let entries;
  try { entries = parseZip(buf); } catch (e) { return { error: e.message }; }
  const files = entries.filter((e) => !e.name.endsWith('/'));
  // 清单文件：import.json / problems.json（取路径最浅的一个）
  const manifestEntry = files
    .filter((e) => /(^|\/)(import|problems)\.json$/i.test(e.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!manifestEntry) return { error: '压缩包内未找到 import.json / problems.json 清单文件' };
  let manifest;
  try { manifest = JSON.parse(manifestEntry.data.toString('utf8')); } catch (e) { return { error: '清单 JSON 解析失败：' + e.message }; }
  const list = Array.isArray(manifest) ? manifest : (Array.isArray(manifest.problems) ? manifest.problems : [manifest]);
  if (!list.length) return { error: '清单里没有题目' };

  const byDir = {};
  let rootChecker = '';
  // v2.6.3（待办 #16 根因）：数据包内的 checker / interactor / grader / *.h 可能是 GBK(cp936) 编码，
  // 此前用 f.data.toString('utf8') 宽容解码会把中文永久烧成 U+FFFD 落盘（实测题目 #16 的 checker.cpp
  // 就是这样损坏的：文件里同时存在 U+FFFD 与被强行解释的 GBK 字节对）。现在统一走稳健解码。
  const decodeAsset = (b) => decodeText(b);
  for (const f of files) {
    if (f === manifestEntry) continue;
    const norm = f.name.replace(/\\/g, '/');
    const parts = norm.split('/');
    const base = parts.pop().toLowerCase();
    const dir = parts.join('/');
    if (/^checker\.(cpp|cc|cxx)$/.test(base)) {
      if (dir) byDir[dir] = byDir[dir] || {};
      if (dir) byDir[dir].checker = decodeAsset(f.data);
      else rootChecker = decodeAsset(f.data);
      continue;
    }
    // M11：交互题配套源码也可能以文件形式放在题目数据目录里（整库导出包就是这样），
    // 与 zip.js 的 testcasesFromZip 口径一致：interactor.cpp / grader.cpp / <name>.h
    if (/^interactor\.(cpp|cc|cxx)$/.test(base) || /^grader\.(cpp|cc|cxx)$/.test(base)) {
      byDir[dir] = byDir[dir] || {};
      byDir[dir][base.startsWith('interactor') ? 'interactor' : 'grader'] = decodeAsset(f.data);
      continue;
    }
    if (/^[a-z0-9_.-]{1,40}\.h$/.test(base) && dir) {
      byDir[dir] = byDir[dir] || {};
      byDir[dir].headers = byDir[dir].headers || [];
      byDir[dir].headers.push({ name: base, content: decodeAsset(f.data) });
      continue;
    }
    const m = base.match(/^(?:.*?)(\d+)\.(in|out|ans|txt)$/);
    if (!m) continue;
    byDir[dir] = byDir[dir] || {};
    const map = byDir[dir];
    const key = m[2] === 'in' || m[2] === 'txt' ? 'in' : 'out';
    map[m[1]] = map[m[1]] || {};
    map[m[1]][key] = f.data.toString('utf8');
  }

  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const dir = String(item.dir || item.data_dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const bucket = dir ? (byDir[dir] || {}) : {};
    const indices = Object.keys(bucket).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    const testcases = indices.map((i) => ({ input: bucket[String(i)].in ?? '', output: bucket[String(i)].out ?? '', subtask: 0 }));
    const checker = bucket.checker || (dir ? '' : rootChecker);
    const spec = { ...item, testcases: Array.isArray(item.testcases) && item.testcases.length ? item.testcases : testcases };
    if (checker && !spec.checker) { spec.checker = checker; spec.spj = true; }
    if (bucket.interactor && !spec.interactor) spec.interactor = bucket.interactor;
    if (bucket.grader && !spec.grader) spec.grader = bucket.grader;
    if (bucket.headers && bucket.headers.length && !spec.interactive_headers) spec.interactive_headers = bucket.headers;
    delete spec.dir;
    delete spec.data_dir;
    out.push(spec);
  }
  return { problems: out };
}

module.exports = { importProblems, problemsFromZip, previewProblems, normalizeSpec, MAX_PROBLEMS };
