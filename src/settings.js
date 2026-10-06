'use strict';

const { db } = require('./db');

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

/* ---------------- 类型化读取（M17：评测可调项即时生效） ----------------
 * 系统设置里的每个可调项都要「读一次、立即生效」，所以这里统一提供三个小助手：
 *   1) 值缺失 / 空串 / 非数字 → 返回默认值（= 未配置 = 与历史行为完全一致）；
 *   2) 数字一律夹到 [min, max]，避免后台写入越界值后判题侧出现异常行为；
 *   3) 布尔只认 '1'/'true'/'on'/'yes'（大小写不敏感），其余为 false。
 * 为什么每次现读而不是缓存：判题涉及的时间/内存/输出上限都是安全阈值，
 * 管理员在后台改完必须立刻作用于下一条提交（读一次 SQLite 主键查询的开销可忽略）。
 */

/** 读取数字型设置（未设置/非法 → def；越界 → 夹到 [min,max]） */
function getNumSetting(key, def, min, max) {
  const raw = getSetting(key, '');
  if (raw === '' || raw == null) return def;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  let v = n;
  if (Number.isFinite(min)) v = Math.max(min, v);
  if (Number.isFinite(max)) v = Math.min(max, v);
  return v;
}

/** 读取整数型设置（四舍五入后夹取） */
function getIntSetting(key, def, min, max) {
  const v = getNumSetting(key, def, min, max);
  return Math.round(v);
}

/** 读取布尔型设置（'1'/'true'/'on'/'yes' = true，其余 = false；未设置 → def） */
function getBoolSetting(key, def = false) {
  const raw = String(getSetting(key, '')).trim().toLowerCase();
  if (raw === '') return !!def;
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** 读取字符串型设置（未设置 → def；按 maxLen 截断） */
function getStrSetting(key, def = '', maxLen = 200) {
  const raw = getSetting(key, '');
  if (raw === '') return def;
  return String(raw).slice(0, maxLen);
}

module.exports = { getSetting, setSetting, getNumSetting, getIntSetting, getBoolSetting, getStrSetting };
