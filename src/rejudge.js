'use strict';

/**
 * 题目重判（仅超级管理员）。
 *
 * 三种范围：
 *   1. contest_problem —— 一次比赛中某一道题目的全部提交记录
 *   2. problem         —— 某道题目的全部提交记录（可只重判普通提交 / 含比赛提交）
 *   3. range           —— 自定义提交 ID 区间（可再按题目／比赛／用户过滤）
 *
 * 重判会把提交重置为 Pending 并重新入队判题；题目通过数/提交数在判题结束后由
 * judge.js 的 bumpProblemStats 依据 submissions 表重算，不会重复累加。
 */

const { db } = require('./db');

const MAX_IDS = 5000;        // 单次重判上限
const IDS_RETURN_LIMIT = 200; // 接口回显的 id 数量上限（避免响应过大）

function parseIntOrNull(v) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 解析重判范围 → { sql 条件与参数 } */
function buildFilter(body) {
  const scope = String((body && body.scope) || '').trim();
  const where = [];
  const args = [];
  let label = '';

  if (scope === 'contest_problem') {
    const cid = parseIntOrNull(body.contest_id);
    const pid = parseIntOrNull(body.problem_id);
    if (!cid) return { error: '请选择比赛' };
    if (!pid) return { error: '请选择该比赛中的题目' };
    const contest = db.prepare('SELECT id, title FROM contests WHERE id = ?').get(cid);
    if (!contest) return { error: '比赛不存在' };
    const problem = db.prepare('SELECT id, title FROM problems WHERE id = ?').get(pid);
    if (!problem) return { error: '题目不存在' };
    where.push('contest_id = ?', 'problem_id = ?');
    args.push(cid, pid);
    label = `比赛「${contest.title}」中题目 #${pid} ${problem.title} 的全部提交`;
  } else if (scope === 'problem') {
    const pid = parseIntOrNull(body.problem_id);
    if (!pid) return { error: '请选择题目' };
    const problem = db.prepare('SELECT id, title FROM problems WHERE id = ?').get(pid);
    if (!problem) return { error: '题目不存在' };
    where.push('problem_id = ?');
    args.push(pid);
    const mode = String(body.contest_mode || 'all').trim();
    if (mode === 'normal') where.push('contest_id IS NULL');
    else if (mode === 'contest') where.push('contest_id IS NOT NULL');
    label = `题目 #${pid} ${problem.title} 的${mode === 'normal' ? '普通' : (mode === 'contest' ? '比赛' : '全部')}提交`;
  } else if (scope === 'range') {
    const from = parseIntOrNull(body.from_id);
    const to = parseIntOrNull(body.to_id);
    if (!from) return { error: '请输入起始提交 ID' };
    if (!to || to < from) return { error: '结束提交 ID 需不小于起始 ID' };
    if (to - from + 1 > MAX_IDS) return { error: `单次重判最多 ${MAX_IDS} 条提交` };
    where.push('id BETWEEN ? AND ?');
    args.push(from, to);
    const pid = parseIntOrNull(body.problem_id);
    if (pid) { where.push('problem_id = ?'); args.push(pid); }
    const cid = parseIntOrNull(body.contest_id);
    if (cid) { where.push('contest_id = ?'); args.push(cid); }
    const uid = parseIntOrNull(body.user_id);
    if (uid) { where.push('user_id = ?'); args.push(uid); }
    label = `提交 ID ${from} ~ ${to}${pid ? `（题目 #${pid}）` : ''}${cid ? `（比赛 #${cid}）` : ''}${uid ? `（用户 #${uid}）` : ''}`;
  } else {
    return { error: '无效的重判范围' };
  }

  return { where, args, label, scope };
}

/** 统计 / 执行重判。dryRun=true 只统计数量（用于二次确认）。 */
function runRejudge(body, dryRun = true) {
  const f = buildFilter(body);
  if (f.error) return { error: f.error };
  const whereSql = f.where.join(' AND ');
  const rows = db.prepare(`SELECT id FROM submissions WHERE ${whereSql} ORDER BY id ASC`).all(...f.args);
  if (rows.length === 0) return { error: '该范围内没有提交记录' };
  if (rows.length > MAX_IDS) return { error: `匹配到 ${rows.length} 条提交，超过单次上限 ${MAX_IDS} 条，请缩小范围` };

  const ids = rows.map((r) => r.id);
  const summary = {
    scope: f.scope,
    label: f.label,
    count: ids.length,
    ids: ids.slice(0, IDS_RETURN_LIMIT),
    truncated: ids.length > IDS_RETURN_LIMIT,
    dry_run: !!dryRun,
  };
  if (dryRun) return summary;

  // 重置为待评测：状态 / 判定 / 分数 / 用时 / 内存 / 详情 / 编译错误全部清空
  // （judge_detail 是 NOT NULL 列，重置为空数组而不是 NULL）
  const reset = db.prepare(
    "UPDATE submissions SET status = 'Pending', verdict = 'Pending', score = 0, time_ms = 0, memory_kb = 0, judge_detail = '[]', compile_error = '' WHERE id = ?"
  );
  db.exec('BEGIN');
  try {
    for (const id of ids) reset.run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { error: '重判重置失败：' + e.message };
  }

  // 涉及的题目统计先按现有数据重算一次（评测结束后判题器会再次重算）
  const problems = db.prepare(`SELECT DISTINCT problem_id FROM submissions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const p of problems) {
    const total = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE problem_id = ?').get(p.problem_id).c;
    const ac = db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE problem_id = ? AND verdict = 'Accepted'").get(p.problem_id).c;
    db.prepare('UPDATE problems SET submit_count = ?, accepted_count = ? WHERE id = ?').run(total, ac, p.problem_id);
  }
  return Object.assign(summary, { dry_run: false, all_ids: ids });
}

/** 当前排队 / 评测中的提交数量（用于前端显示重判进度） */
function progress() {
  const pending = db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'Pending'").get().c;
  const judging = db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'Judging'").get().c;
  return { pending, judging, total: pending + judging };
}

module.exports = { runRejudge, progress, MAX_IDS };
