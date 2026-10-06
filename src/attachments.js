'use strict';

/* 题目附件：管理员上传、用户下载。
 * 存放于 DATA_DIR/attachments/<problemId>/，与测试数据目录分离
 * （保存测试数据会清空 testdata 目录，因此附件不能放在那里）。 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const ROOT = path.join(DATA_DIR, 'attachments');
const MAX_BYTES = 20 * 1024 * 1024; // 单个附件上限 20MB

function dirOf(problemId) {
  return path.join(ROOT, String(problemId));
}

/** 校验并规范化文件名（禁止路径穿越与非法字符） */
function safeName(name) {
  const base = path.basename(String(name == null ? '' : name).trim());
  if (!base || base === '.' || base === '..') return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(base)) return null;
  return base.slice(0, 120);
}

function list(problemId) {
  const dir = dirOf(problemId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const items = [];
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile()) items.push({ name: n, size: st.size, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return items;
}

function save(problemId, name, base64) {
  const clean = safeName(name);
  if (!clean) return { error: '文件名不合法' };
  let buf;
  try { buf = Buffer.from(String(base64 || ''), 'base64'); } catch { return { error: '文件内容解码失败' }; }
  if (!buf || buf.length === 0) return { error: '文件内容为空' };
  if (buf.length > MAX_BYTES) return { error: `附件过大（上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）` };
  try {
    fs.mkdirSync(dirOf(problemId), { recursive: true });
    fs.writeFileSync(path.join(dirOf(problemId), clean), buf);
  } catch (e) {
    return { error: '保存附件失败：' + e.message };
  }
  return { ok: true, name: clean, size: buf.length };
}

function remove(problemId, name) {
  const clean = safeName(name);
  if (!clean) return { error: '文件名不合法' };
  const p = path.join(dirOf(problemId), clean);
  if (!fs.existsSync(p)) return { error: '附件不存在' };
  try { fs.rmSync(p, { force: true }); } catch (e) { return { error: '删除失败：' + e.message }; }
  return { ok: true };
}

/** 返回可安全下载的绝对路径（校验仍在附件目录内） */
function filePath(problemId, name) {
  const clean = safeName(name);
  if (!clean) return null;
  const dir = dirOf(problemId);
  const p = path.join(dir, clean);
  if (!p.startsWith(dir + path.sep)) return null;
  if (!fs.existsSync(p)) return null;
  try { if (!fs.statSync(p).isFile()) return null; } catch { return null; }
  return p;
}

/** 删除该题目的全部附件（题目被删除时调用） */
function removeAll(problemId) {
  try { fs.rmSync(dirOf(problemId), { recursive: true, force: true }); return true; } catch { return false; }
}

/** 迁移题号时把整个附件目录搬到新题号下（返回是否确实搬了） */
function moveAll(fromId, toId) {
  const from = dirOf(fromId);
  const to = dirOf(toId);
  try {
    if (!fs.existsSync(from)) return false;
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
    return true;
  } catch { return false; }
}

module.exports = { list, save, remove, removeAll, moveAll, filePath, MAX_BYTES };
