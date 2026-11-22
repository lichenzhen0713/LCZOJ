'use strict';

/**
 * 题目页 IDE 模式：自测运行接口（POST /api/run）的限流、参数校验与题目缺省值解析。
 * 真正的执行在 src/judge.js 的 runSelftest() —— 与正式评测同一套沙箱。
 *
 * 限流（内存态，重启清零）：
 *   · 同一用户 1 秒最多 1 次；
 *   · 同一用户每小时最多 120 次。
 */

const { db } = require('./db');
const { availableLanguages, runSelftest } = require('./judge');

const CODE_MAX_BYTES = 64 * 1024;
const INPUT_MAX_BYTES = 64 * 1024;
const MIN_INTERVAL_MS = 1000;
const HOURLY_LIMIT = 120;
const HOUR_MS = 60 * 60 * 1000;

/** userId -> { lastAt, windowStart, count } */
const rateState = new Map();

function pruneRateState(now) {
  if (rateState.size < 5000) return;
  for (const [uid, st] of rateState) {
    if (now - st.windowStart >= HOUR_MS && now - st.lastAt >= MIN_INTERVAL_MS) rateState.delete(uid);
  }
}

/** 检查并记账。返回 null 表示允许，否则返回 { retryAfterMs, message }。 */
function takeRateSlot(userId) {
  const now = Date.now();
  const uid = Number(userId) || 0;
  let st = rateState.get(uid);
  if (!st) {
    st = { lastAt: 0, windowStart: now, count: 0 };
    rateState.set(uid, st);
  }
  if (now - st.windowStart >= HOUR_MS) {
    st.windowStart = now;
    st.count = 0;
  }
  if (st.lastAt && now - st.lastAt < MIN_INTERVAL_MS) {
    return {
      retryAfterMs: MIN_INTERVAL_MS - (now - st.lastAt),
      message: `自测运行太频繁：同一用户每秒最多运行 1 次，请 ${Math.max(1, Math.ceil((MIN_INTERVAL_MS - (now - st.lastAt)) / 1000))} 秒后再试`,
    };
  }
  if (st.count >= HOURLY_LIMIT) {
    const left = Math.max(1, Math.ceil((st.windowStart + HOUR_MS - now) / 60000));
    return { retryAfterMs: st.windowStart + HOUR_MS - now, message: `本小时的自测次数已达上限（${HOURLY_LIMIT} 次），请 ${left} 分钟后再试` };
  }
  st.lastAt = now;
  st.count += 1;
  pruneRateState(now);
  return null;
}

function byteLength(s) {
  return Buffer.byteLength(String(s == null ? '' : s), 'utf8');
}

/**
 * 处理一次自测请求。返回 { status, message } 或 { data }。
 * 调用方已完成登录校验（/api/run 必须登录）。
 */
async function handleRun(user, body) {
  const payload = body && typeof body === 'object' ? body : {};
  const language = String(payload.language == null ? '' : payload.language).trim();
  const code = String(payload.code == null ? '' : payload.code);
  const input = String(payload.input == null ? '' : payload.input);

  if (!code.trim()) return { status: 400, message: '代码不能为空' };
  if (byteLength(code) > CODE_MAX_BYTES) return { status: 400, message: '代码长度超出限制（64KB）' };
  if (byteLength(input) > INPUT_MAX_BYTES) return { status: 400, message: '自测输入长度超出限制（64KB）' };
  if (!language) return { status: 400, message: '请选择语言' };

  const langs = availableLanguages();
  const lang = langs[language];
  if (!lang) return { status: 400, message: '不支持该语言' };
  if (!lang.available) {
    return { status: 400, message: `当前环境未安装 ${lang.toolName} 工具链，暂时无法运行 ${lang.name}` };
  }
  if (lang.outputOnly) return { status: 400, message: '提交答案题不支持自测运行' };

  // 题目缺省值（可选）：只对「已公开的题目 或 管理员」生效，避免通过 problem_id 探测未公开题目。
  let problem = null;
  const pid = parseInt(payload.problem_id, 10);
  if (Number.isFinite(pid) && pid > 0) {
    const row = db.prepare('SELECT id, is_public, enable_o2, time_limit_ms, output_only, problem_type FROM problems WHERE id = ?').get(pid);
    if (row && (row.is_public || (user && user.is_admin))) problem = row;
  }
  if (problem && (problem.output_only || String(problem.problem_type || '') === 'output_only')) {
    return { status: 400, message: '提交答案题不支持自测运行' };
  }

  const gate = takeRateSlot(user && user.id);
  if (gate) return { status: 429, message: gate.message };

  const o2 = payload.enable_o2 == null
    ? (problem ? problem.enable_o2 !== 0 : true)
    : !!payload.enable_o2;
  const timeLimitMs = problem && Number(problem.time_limit_ms) > 0
    ? Math.min(5000, Math.max(100, Number(problem.time_limit_ms)))
    : 5000;

  let result;
  try {
    result = await runSelftest(language, code, input, { o2, timeLimitMs });
  } catch (e) {
    return { status: 500, message: '自测运行失败：' + (e && e.message ? e.message : e) };
  }
  if (result && result.error) return { status: 500, message: result.error };
  return { data: result };
}

module.exports = { handleRun, CODE_MAX_BYTES, INPUT_MAX_BYTES, MIN_INTERVAL_MS, HOURLY_LIMIT };
