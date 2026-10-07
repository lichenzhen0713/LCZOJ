'use strict';

/* ============================ 讨论板块 / 文章分类的可配置管理 ============================
 * 后台「板块与分类管理」的服务端实现（v2.7.0，仅超级管理员可写，公开可读）。
 *
 * 设计要点
 *  1) **key 与显示名分离**：discussions.board / editorials.category 存的是配置表的 key；
 *     name 只用于显示。重命名（rename）只改 name，key 永远不变 —— 已有讨论 / 文章因此
 *     不会失联；前端所有展示位都按 key → name 映射，映射不到时回退显示原始值（优雅降级）。
 *  2) **删除保护**：目标下仍有内容时默认拒绝删除并返回数量；带 move_to 参数时，先把内容
 *     批量改到目标 key，再删除配置行 —— 两步在**同一事务**内完成（失败整体回滚）。
 *  3) **系统项**：is_system = 1 的内置项允许改名；删除时**必须**显式指定迁移目标
 *     （避免误删掉被代码逻辑引用的 key 之后行为悄悄变化）。其中两个 key 被代码硬依赖，
 *     属于「不可删除」级别：
 *       · 板块 academic —— discussions.board 的列默认值（兜底板块，未指定板块时的归属）；
 *       · 分类 solution —— 题解流程按这个 key 判断（src/editorial.js 的 resolveStatus /
 *                         validateCategoryProblem / createEditorial 与前端表单分支都写死了
 *                         SOLUTION_CATEGORY），因此它**既不可删除也不可改名**。
 *     分类 uncategorized 同样是流程里的保留值（提交审核时禁止使用），可改名但删除需迁移目标。
 *     v2.7.0 起**所有内置项的内部 key 都是英文 slug**（见 src/db.js 的迁移与 seed），
 *     显示名保持中文；key 与显示名彻底分离。
 *  4) **审计**：每次增删改都写 admin_audit（主，含来源 IP）+ moderation_logs（镜像，后台
 *     「社区管理」直接可见），动作名 board_create / board_rename / board_delete /
 *     category_create / category_rename / category_delete。
 */

const crypto = require('crypto');
const { db } = require('./db');

/** 兜底板块 key（discussions.board 的列默认值），不可删除、可改名 */
const FALLBACK_BOARD = 'academic';
/** 系统分类 key（题解流程硬依赖），不可删除、不可改名。英文 slug，显示名为「题解」 */
const SOLUTION_CATEGORY = 'solution';
/** 保留分类 key（提交审核时禁止作为分类），可改名、删除需迁移目标。英文 slug，显示名为「未分类」 */
const UNCATEGORIZED = 'uncategorized';

/** 内部 key 允许的字符：中英文、数字、下划线、连字符、间隔号「·」，最长 32 字符 */
const KEY_RE = /^[A-Za-z0-9_\u4e00-\u9fa5·-]{1,32}$/;

/* 两类配置的唯一差异都收在这张表里：表名 / 内容表与列名 / 中文文案 / 受保护的 key / 审计动作名。
 * 表名与列名只来自这里的常量（不接受外部输入），因此拼进 SQL 是安全的。 */
const KINDS = {
  board: {
    key: 'board',
    table: 'discussion_boards',
    contentTable: 'discussions',
    contentColumn: 'board',
    label: '板块',
    contentLabel: '讨论',
    keyLabel: '板块 key',
    protectedKey: FALLBACK_BOARD,
    protectedReason: '「学术版」是讨论区的系统默认兜底板块（未指定板块时的归属），不允许删除；如需调整展示名称可以直接改名',
    actions: { create: 'board_create', rename: 'board_rename', delete: 'board_delete' },
  },
  category: {
    key: 'category',
    table: 'article_categories',
    contentTable: 'editorials',
    contentColumn: 'category',
    label: '分类',
    contentLabel: '文章',
    keyLabel: '分类 key',
    protectedKey: SOLUTION_CATEGORY,
    protectedReason: '「题解」（内部 key = solution）是题解流程的系统分类（关联题目的文章必须是它），不允许删除；其 key 与显示名被题解工作流判断使用，也不允许改名',
    actions: { create: 'category_create', rename: 'category_rename', delete: 'category_delete' },
  },
};

function normKey(v) { return String(v == null ? '' : v).trim(); }
/** 显示名：去掉 C0/DEL 控制字符、首尾空白，限长 40（与站内其它名称字段口径一致） */
function normName(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40);
}
function normSort(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(999999, n));
}
function maxSort(table) {
  const r = db.prepare(`SELECT MAX(sort_order) AS m FROM ${table}`).get();
  return (r && Number(r.m)) || 0;
}
function kindOf(kind) { return KINDS[kind] || null; }

/** 生成内部 key：优先用显示名里的 ASCII 片段做 slug，否则退回 board_/cat_ + 随机串（保证唯一） */
function genKey(kind, name) {
  const prefix = kind === 'category' ? 'cat' : 'board';
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  const base = slug && /^[a-z]/.test(slug) ? slug : prefix;
  for (let i = 0; i < 50; i++) {
    const k = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    if (KEY_RE.test(k) && !db.prepare(`SELECT key FROM ${KINDS[kind].table} WHERE key = ?`).get(k)) return k;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

/** 审计：admin_audit（主，含来源 IP）+ moderation_logs（镜像，社区管理页可直接看到） */
function audit(kind, actor, ip, action, targetName, detail) {
  const sp = kindOf(kind);
  const now = Date.now();
  const actorId = Number(actor && actor.id) || 0;
  const actorName = String((actor && actor.username) || '').slice(0, 80);
  const text = String(detail || '').slice(0, 500);
  try {
    db.prepare('INSERT INTO admin_audit (created_at, actor_id, actor_name, target_id, target_name, action, detail, ip) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
      .run(now, actorId, actorName, String(targetName || '').slice(0, 80), action, text, String(ip || '').slice(0, 80));
  } catch (e) { console.warn(`[LCZOJ] 写入${sp.label}管理审计失败（admin_audit）：` + (e && e.message)); }
  try {
    db.prepare('INSERT INTO moderation_logs (admin_id, admin_name, user_id, username, action, detail, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(actorId, actorName, String(targetName || '').slice(0, 80), action, text, now);
  } catch (e) { console.warn(`[LCZOJ] 镜像${sp.label}管理审计到社区管理记录失败：` + (e && e.message)); }
}

/** 列表（按 sort_order → created_at → key 排序），带每项下的内容条数与可删除 / 可改名标记 */
function list(kind) {
  const sp = kindOf(kind);
  if (!sp) return { error: '未知的配置类型' };
  const rows = db.prepare(`SELECT key, name, sort_order, is_system, created_at FROM ${sp.table} ORDER BY sort_order ASC, created_at ASC, key ASC`).all();
  const counts = new Map();
  for (const r of db.prepare(`SELECT ${sp.contentColumn} AS k, COUNT(*) AS c FROM ${sp.contentTable} GROUP BY ${sp.contentColumn}`).all()) {
    counts.set(normKey(r.k), r.c);
  }
  return {
    items: rows.map((r) => ({
      key: r.key,
      name: r.name,
      sort_order: r.sort_order,
      is_system: !!r.is_system,
      count: counts.get(r.key) || 0,
      is_protected: r.key === sp.protectedKey,
      can_rename: !(sp.key === 'category' && r.key === SOLUTION_CATEGORY),
      can_delete: r.key !== sp.protectedKey,
      // 删除时是否必须给出迁移目标：受保护项永远不可删；系统内置项或仍有内容的项必须指定目标
      need_move_to: r.key !== sp.protectedKey && (!!r.is_system || (counts.get(r.key) || 0) > 0),
      created_at: r.created_at,
    })),
    total: rows.length,
  };
}

function listBoards() { return list('board'); }
function listCategories() { return list('category'); }

/** 全部 key（用于内容写入校验 / 前端下拉） */
function keys(kind) {
  const sp = kindOf(kind);
  if (!sp) return [];
  return db.prepare(`SELECT key FROM ${sp.table} ORDER BY sort_order ASC, created_at ASC, key ASC`).all().map((r) => r.key);
}
function exists(kind, key) {
  const sp = kindOf(kind);
  const k = normKey(key);
  if (!sp || !k) return false;
  return !!db.prepare(`SELECT key FROM ${sp.table} WHERE key = ?`).get(k);
}
function boardExists(key) { return exists('board', key); }
function categoryExists(key) { return exists('category', key); }
/** 兜底板块 key：优先 academic，其次表里第一个；表为空时返回空串（调用方自行决定拒绝或忽略） */
function defaultBoardKey() {
  if (boardExists(FALLBACK_BOARD)) return FALLBACK_BOARD;
  const first = db.prepare('SELECT key FROM discussion_boards ORDER BY sort_order ASC, created_at ASC, key ASC LIMIT 1').get();
  return first ? first.key : '';
}
/** key → 显示名（找不到时回退 key 本身，避免出现 undefined / 空白） */
function displayName(kind, key) {
  const sp = kindOf(kind);
  const k = normKey(key);
  if (!sp || !k) return '';
  const row = db.prepare(`SELECT name FROM ${sp.table} WHERE key = ?`).get(k);
  return row ? row.name : k;
}

/** 新建：key 可显式指定（英文 / 数字 slug 或中文），留空则自动生成 */
function create(kind, data, actor, ip) {
  const sp = kindOf(kind);
  if (!sp) return { error: '未知的配置类型', status: 400 };
  const name = normName(data && data.name);
  if (!name) return { error: `${sp.label}名称不能为空`, status: 400 };
  let key = normKey(data && data.key);
  if (key && !KEY_RE.test(key)) {
    return { error: `${sp.keyLabel}只能包含中英文、数字、下划线、连字符与间隔号「·」，长度 1~32（推荐英文 / 数字 slug）`, status: 400 };
  }
  if (!key) key = genKey(kind, name);
  if (db.prepare(`SELECT key FROM ${sp.table} WHERE key = ?`).get(key)) return { error: `${sp.keyLabel}「${key}」已存在，请换一个`, status: 409 };
  const sort = normSort(data && data.sort_order, maxSort(sp.table) + 10);
  db.prepare(`INSERT INTO ${sp.table} (key, name, sort_order, is_system, created_at) VALUES (?, ?, ?, 0, ?)`).run(key, name, sort, Date.now());
  audit(kind, actor, ip, sp.actions.create, name, `新建${sp.label}「${name}」（key=${key}，顺序 ${sort}）`);
  return { key, name, sort_order: sort, is_system: false, created: true };
}

/** 重命名 / 调序：**只改 name 与 sort_order，key 一律不变**（即使请求体里带了 key 也忽略） */
function update(kind, key, data, actor, ip) {
  const sp = kindOf(kind);
  if (!sp) return { error: '未知的配置类型', status: 400 };
  const k = normKey(key);
  const row = db.prepare(`SELECT key, name, sort_order, is_system FROM ${sp.table} WHERE key = ?`).get(k);
  if (!row) return { error: `${sp.label}「${k}」不存在`, status: 404 };
  const name = data && data.name !== undefined ? normName(data.name) : row.name;
  if (!name) return { error: `${sp.label}名称不能为空`, status: 400 };
  if (sp.key === 'category' && k === SOLUTION_CATEGORY && name !== row.name) {
    return { error: sp.protectedReason, status: 403 };
  }
  const sort = data && data.sort_order !== undefined ? normSort(data.sort_order, row.sort_order) : row.sort_order;
  db.prepare(`UPDATE ${sp.table} SET name = ?, sort_order = ? WHERE key = ?`).run(name, sort, k);
  const changed = [];
  if (name !== row.name) changed.push(`显示名「${row.name}」→「${name}」`);
  if (sort !== row.sort_order) changed.push(`顺序 ${row.sort_order} → ${sort}`);
  audit(kind, actor, ip, sp.actions.rename, name,
    `${changed.length ? '修改' : '提交'}${sp.label}「${name}」（key=${k} 保持不变${changed.length ? '；' + changed.join('；') : '，无实际变化'}）`);
  return { key: k, name, sort_order: sort, is_system: !!row.is_system, updated: changed.length > 0 };
}

/**
 * 删除（含迁移）。规则：
 *   · 受保护项（板块 academic / 分类 题解）一律拒绝；
 *   · 目标下仍有内容且未给 move_to → 拒绝并返回条数（need_move = true）；
 *   · 系统内置项即使没有内容，也要求显式给出 move_to（避免误删代码逻辑引用的 key）；
 *   · 给出 move_to 时「批量改归属 + 删除配置行」在**同一事务**内完成。
 */
function remove(kind, key, moveTo, actor, ip) {
  const sp = kindOf(kind);
  if (!sp) return { error: '未知的配置类型', status: 400 };
  const k = normKey(key);
  const row = db.prepare(`SELECT key, name, sort_order, is_system FROM ${sp.table} WHERE key = ?`).get(k);
  if (!row) return { error: `${sp.label}「${k}」不存在`, status: 404 };
  if (k === sp.protectedKey) return { error: sp.protectedReason, status: 403, protected: true };
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${sp.contentTable} WHERE ${sp.contentColumn} = ?`).get(k).c;
  const target = normKey(moveTo);
  if (!target && count > 0) {
    return { error: `该${sp.label}下仍有 ${count} 条${sp.contentLabel}，请选择迁移目标${sp.label}后再删除（或取消删除）`, need_move: true, count, status: 409 };
  }
  if (!target && row.is_system) {
    return { error: `「${row.name}」是系统内置${sp.label}，删除时必须指定迁移目标`, need_move: true, count, status: 409 };
  }
  if (target) {
    if (target === k) return { error: '迁移目标不能是被删除的自身，请另选一个目标', status: 400 };
    const t = db.prepare(`SELECT key, name FROM ${sp.table} WHERE key = ?`).get(target);
    if (!t) return { error: `迁移目标${sp.label}「${target}」不存在`, status: 400 };
  }
  let moved = 0;
  db.exec('BEGIN');
  try {
    if (target) {
      moved = db.prepare(`UPDATE ${sp.contentTable} SET ${sp.contentColumn} = ? WHERE ${sp.contentColumn} = ?`).run(target, k).changes;
    }
    db.prepare(`DELETE FROM ${sp.table} WHERE key = ?`).run(k);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return { error: `删除${sp.label}失败（已回滚，数据未改动）：` + (e && e.message), status: 500 };
  }
  const targetName = target ? displayName(kind, target) : '';
  audit(kind, actor, ip, sp.actions.delete, row.name,
    `删除${sp.label}「${row.name}」（key=${k}）`
    + (target ? `，已迁移 ${moved} 条${sp.contentLabel}到「${targetName}」（key=${target}）` : `，迁移 0 条${sp.contentLabel}`));
  return { deleted: k, deleted_name: row.name, count, moved, move_to: target || '', move_to_name: targetName };
}

function createBoard(data, actor, ip) { return create('board', data, actor, ip); }
function updateBoard(key, data, actor, ip) { return update('board', key, data, actor, ip); }
function deleteBoard(key, moveTo, actor, ip) { return remove('board', key, moveTo, actor, ip); }
function createCategory(data, actor, ip) { return create('category', data, actor, ip); }
function updateCategory(key, data, actor, ip) { return update('category', key, data, actor, ip); }
function deleteCategory(key, moveTo, actor, ip) { return remove('category', key, moveTo, actor, ip); }

module.exports = {
  FALLBACK_BOARD,
  SOLUTION_CATEGORY,
  UNCATEGORIZED,
  listBoards,
  listCategories,
  boardKeys: () => keys('board'),
  categoryKeys: () => keys('category'),
  boardExists,
  categoryExists,
  defaultBoardKey,
  boardName: (key) => displayName('board', key),
  categoryName: (key) => displayName('category', key),
  createBoard,
  updateBoard,
  deleteBoard,
  createCategory,
  updateCategory,
  deleteCategory,
};
