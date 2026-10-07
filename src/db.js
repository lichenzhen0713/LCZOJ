'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB_PATH, TESTDATA_DIR, DATA_DIR, ensureDirs } = require('./config');
const { hashPassword } = require('./password');

/** 初始管理员密码落盘位置（仅首次初始化时写入一次；任何口令变更后即失效并删除） */
const ADMIN_PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');

/** 首次初始化结果：{ created, username, password, source:'env'|'random', file } */
let adminInit = null;

/* ---------------- 初始密码文件的生命周期（M17） ----------------
 * data/admin-password.txt 只是「首次登录用的初始口令」记录，一旦任何口令被成功修改就应立即删除：
 *   - 本人改密 users.changePassword / 管理员重置 users.adminSetPassword / 找回重置 auth.resetPassword
 *     （批量生成用户只新建账号、批量删除用户明确拒绝删除内置 admin，二者不会改到 admin 的口令，故不涉及）；
 *   - 删除失败只记日志，绝不影响口令变更本身的返回结果；
 *   - 启动时若该文件仍存在，尝试把权限收紧到 0600（Windows 的 chmod 只影响只读位，属尽力而为）。
 */
function removeAdminPasswordFile(reason) {
  try {
    if (!fs.existsSync(ADMIN_PASSWORD_FILE)) return false;
    fs.rmSync(ADMIN_PASSWORD_FILE, { force: true });
    console.log(`[LCZOJ] 口令已变更（${reason || '未知路径'}），已删除初始密码文件 ${ADMIN_PASSWORD_FILE}`);
    return true;
  } catch (e) {
    console.warn('[LCZOJ] 删除初始密码文件失败（不影响本次口令变更）：' + (e && e.message));
    return false;
  }
}

/** 启动时收紧初始密码文件权限到 0600（不存在则跳过；Windows 上 mode 语义有限，失败静默） */
function hardenAdminPasswordFile() {
  try {
    if (!fs.existsSync(ADMIN_PASSWORD_FILE)) return false;
    fs.chmodSync(ADMIN_PASSWORD_FILE, 0o600);
    return true;
  } catch (e) {
    console.warn('[LCZOJ] 收紧初始密码文件权限失败（' + (e && e.message) + '）');
    return false;
  }
}

/**
 * 生成随机初始管理员密码：默认 14 位，字符集去掉容易混淆的 0/O/1/l/I。
 * 用 crypto.randomInt 取随机值，避免 Math.random / 取模偏差带来的可预测性。
 * 生成结果必然包含「字母 + 数字 + 符号」三类字符，符合下方 passwordPolicyError 的强度要求。
 */
function generateAdminPassword(len = 14) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_=+';
  const all = letters + digits + symbols;
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = [pick(letters), pick(digits), pick(symbols)];
  while (chars.length < len) chars.push(pick(all));
  // Fisher–Yates 洗牌，让保底字符不出现在固定位置
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
  }
  return chars.join('');
}

/* ============================ 口令强度策略（安全审计 H3） ============================
 * 统一由这里提供，供注册 / 改密 / 管理员重置 / 找回重置 / OJ_ADMIN_PASSWORD 复用。
 * 规则：最短 10 位 + 常见弱口令黑名单（不区分大小写，含常见后缀变体）+ 至少两类字符（字母/数字/符号）。
 * 只做「设置新口令时」的校验，登录时不校验，避免把已有弱口令的老账号锁在门外。
 */
const PASSWORD_MIN_LENGTH = 10;
const WEAK_PASSWORDS = new Set([
  'admin', 'admin123', 'admin1234', 'admin12345', 'admin888', 'administrator', 'root', 'toor',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910', '111111', '1111111',
  '11111111', '000000', '00000000', '666666', '888888', 'abc123', 'abc123456', 'abcd1234',
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty', 'qwerty123', 'qwertyuiop',
  'letmein', 'welcome', 'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'lczoj', 'lczoj123', 'oj123456', 'test123', 'test1234', 'test123456', 'guest', 'changeme',
  '1q2w3e4r', '1qaz2wsx', 'zxcvbnm', 'asdfghjkl', '123qwe', 'a123456', 'a1234567', 'woaini',
  'zhangwei', 'wangwei', 'xiaoming', 'woaini1314', '5201314', 'a1b2c3d4',
]);

/** 校验口令强度：通过返回 ''，不通过返回中文错误文案 */
function passwordPolicyError(password) {
  const pw = String(password == null ? '' : password);
  if (pw.length > 200) return '密码长度不能超过 200 位';
  if (/^\s|\s$/.test(pw)) return '密码首尾不能是空白字符';
  const lower = pw.toLowerCase();
  // 先判黑名单，让 admin123 / password 这类典型弱口令得到更准确的提示
  if (WEAK_PASSWORDS.has(lower)) return '该密码属于常见弱口令，请更换更复杂的密码';
  if (pw.length < PASSWORD_MIN_LENGTH) return `密码长度至少 ${PASSWORD_MIN_LENGTH} 位`;
  for (const w of WEAK_PASSWORDS) {
    if (w.length >= 6 && lower.startsWith(w)) return '该密码包含常见弱口令，请更换更复杂的密码';
  }
  // 至少两类字符：字母（不分大小写算一类）/ 数字 / 符号
  const kinds = (/[a-zA-Z]/.test(pw) ? 1 : 0) + (/\d/.test(pw) ? 1 : 0) + (/[^a-zA-Z0-9]/.test(pw) ? 1 : 0);
  if (kinds < 2) return '密码需至少包含字母、数字、符号中的两类';
  return '';
}

/** 首次初始化信息（供启动横幅 / 安装脚本显示），未初始化过则为 null */
function getAdminInitInfo() {
  return adminInit;
}

/**
 * 加载 Node.js 内置的 node:sqlite。
 * Node 22.5 ~ 23.3 需要加 --experimental-sqlite 参数才能 require；
 * 面板（宝塔 / 小皮）与 Docker 用户通常直接执行 `node server.js`，
 * 这里在检测到这种情况时自动带参数重启一次，避免出现
 * “Cannot find module 'node:sqlite'” 这种看不懂的报错；
 * 确实不可用时给出明确的中文处理办法后退出。
 */
function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (err) {
    const [maj, min] = String(process.versions.node).split('.').map((n) => parseInt(n, 10));
    const flagSupported = (maj === 22 && min >= 5) || maj === 23;
    if (flagSupported && process.env.OJ_SQLITE_REEXEC !== '1' && !process.execArgv.includes('--experimental-sqlite')) {
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(
        process.execPath,
        ['--experimental-sqlite', ...process.execArgv, path.join(__dirname, '..', 'server.js'), ...process.argv.slice(2)],
        { stdio: 'inherit', env: { ...process.env, OJ_SQLITE_REEXEC: '1' } }
      );
      process.exit(r.status == null ? 1 : r.status);
    }
    console.error('');
    console.error('[LCZOJ] 无法加载 Node.js 内置数据库模块 node:sqlite。');
    console.error(`        当前 Node.js 版本：v${process.versions.node}（需要 v22.5.0 及以上，推荐 v24 LTS）`);
    console.error('        两种解决办法：');
    console.error('          ① 升级 Node.js 到 v24（推荐，install.sh / 面板里装 Node 24 即可）；');
    console.error('          ② 或改用旧版启动命令：node --experimental-sqlite server.js');
    console.error('        查看环境自检报告：node deploy/check-env.js');
    console.error('');
    process.exit(1);
  }
}

const { DatabaseSync } = loadSqlite();

ensureDirs();

const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user',
  can_speak INTEGER NOT NULL DEFAULT 1,
  can_discuss INTEGER NOT NULL DEFAULT 1,
  can_reply INTEGER NOT NULL DEFAULT 1,
  can_editorial INTEGER NOT NULL DEFAULT 1,
  banned INTEGER NOT NULL DEFAULT 0,
  nickname TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  rating INTEGER NOT NULL DEFAULT 0,
  rated_games INTEGER NOT NULL DEFAULT 0,
  brown_name INTEGER NOT NULL DEFAULT 0,
  brown_name_until INTEGER NOT NULL DEFAULT 0,
  brown_type TEXT NOT NULL DEFAULT '',
  email_verified INTEGER NOT NULL DEFAULT 1,
  email_verify_token TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',
  category TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS moderation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_name TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY,
  slug TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  input_format TEXT NOT NULL DEFAULT '',
  output_format TEXT NOT NULL DEFAULT '',
  samples TEXT NOT NULL DEFAULT '[]',
  hint TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  difficulty INTEGER NOT NULL DEFAULT 1,
  time_limit_ms INTEGER NOT NULL DEFAULT 1000,
  memory_limit_mb INTEGER NOT NULL DEFAULT 256,
  is_public INTEGER NOT NULL DEFAULT 1,
  show_score INTEGER NOT NULL DEFAULT 1,
  editorial_closed INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  submit_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  verdict TEXT NOT NULL DEFAULT 'Pending',
  score INTEGER NOT NULL DEFAULT 0,
  time_ms INTEGER NOT NULL DEFAULT 0,
  memory_kb INTEGER NOT NULL DEFAULT 0,
  compile_error TEXT NOT NULL DEFAULT '',
  judge_detail TEXT NOT NULL DEFAULT '[]',
  contest_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'ACM',
  signup_required INTEGER NOT NULL DEFAULT 0,
  rated INTEGER NOT NULL DEFAULT 0,
  rating_threshold INTEGER NOT NULL DEFAULT 0,
  ratings_applied INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contest_registrations (
  contest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rated INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (contest_id, user_id),
  FOREIGN KEY(contest_id) REFERENCES contests(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contest_penalties (
  contest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (contest_id, user_id),
  FOREIGN KEY(contest_id) REFERENCES contests(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* v2.7.8：全站积分结算快照（幂等迁移）
 * 每次「全站积分结算」把 computePoints(userId) 的结果按四维+总分落库一行，
 * 便于排行榜 / 个人中心快速读取（避免每请求重算 1371 人）与追溯历史。
 * 读取规则见 src/users.js 的 getPointsRanking / getProfile 与 src/points.js 的 readMode。
 * 快照只是**缓存**：没有该用户的快照行时一律回退实时计算，因此不会出现空白 / 0 分。
 * 用户被删除时随外键级联删除，不留孤儿行。 */
CREATE TABLE IF NOT EXISTS points_settlement (
  user_id INTEGER PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  base INTEGER NOT NULL DEFAULT 0,
  practice INTEGER NOT NULL DEFAULT 0,
  contest INTEGER NOT NULL DEFAULT 0,
  community INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS editorial_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  editorial_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(editorial_id) REFERENCES editorials(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS contest_problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  letter TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(contest_id) REFERENCES contests(id) ON DELETE CASCADE,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  UNIQUE(contest_id, problem_id)
);

CREATE TABLE IF NOT EXISTS editorials (
  id INTEGER PRIMARY KEY,
  problem_id INTEGER,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  category TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(problem_id, user_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, problem_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rating_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  contest_id INTEGER,
  rating_before INTEGER NOT NULL DEFAULT 0,
  rating_after INTEGER NOT NULL DEFAULT 0,
  delta INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS editorial_likes (
  editorial_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(editorial_id, user_id),
  FOREIGN KEY(editorial_id) REFERENCES editorials(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discussions (
  id INTEGER PRIMARY KEY,
  problem_id INTEGER,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  board TEXT NOT NULL DEFAULT 'academic',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discussion_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(discussion_id) REFERENCES discussions(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_problems_public ON problems(is_public);
`);

// ---------- 站内信（私信）----------
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL,
  user_b INTEGER NOT NULL,
  last_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_a, user_b),
  FOREIGN KEY(user_a) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(user_b) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_a ON conversations(user_a);
CREATE INDEX IF NOT EXISTS idx_conversations_b ON conversations(user_b);
`);

// 迁移：通知中的个人中心链接统一为 UID（旧数据以用户名为跳转目标，个人中心已改 UID 制）
db.exec(`
  UPDATE notifications
  SET link = '/user/' || (SELECT id FROM users u WHERE u.username = substr(notifications.link, 7))
  WHERE link LIKE '/user/%'
    AND (SELECT id FROM users u WHERE u.username = substr(notifications.link, 7)) IS NOT NULL
`);

// 迁移：评测明细压缩为 gzip 二进制（BLOB）存储以省空间；兼容早期 "gz:" base64 文本
try {
  const { encodeDetail, decodeDetail } = require('./judgecodec');
  const rows = db.prepare("SELECT id, judge_detail FROM submissions WHERE typeof(judge_detail) = 'text' AND judge_detail IS NOT NULL AND length(judge_detail) > 160").all();
  const upd = db.prepare('UPDATE submissions SET judge_detail = ? WHERE id = ?');
  let changed = 0;
  for (const r of rows) {
    const raw = decodeDetail(r.judge_detail); // 处理明文与 gz: 历史格式
    const enc = encodeDetail(raw);
    if (Buffer.isBuffer(enc)) { upd.run(enc, r.id); changed++; }
  }
  if (changed) console.log(`[OJ] ${changed} 条评测明细已改为 gzip 二进制存储`);
} catch (e) {
  console.warn('[OJ] 评测明细压缩迁移失败：', e.message);
}

// 迁移：兼容旧库，为 submissions 补充 contest_id 列
const subCols = db.prepare('PRAGMA table_info(submissions)').all();
if (!subCols.some((c) => c.name === 'contest_id')) {
  db.exec('ALTER TABLE submissions ADD COLUMN contest_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_contest ON submissions(contest_id)');

// 迁移：释放已删除内容的编号（去掉 AUTOINCREMENT）。
// 内容表（题目/比赛/题解/讨论）改为普通 INTEGER PRIMARY KEY 后，删除最大编号的内容，
// 新内容即可复用该编号（AUTOINCREMENT 永远不会复用）。重建表并保留数据与关联。
function releaseContentIds(tableName) {
  const meta = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
  if (!meta || !/AUTOINCREMENT/i.test(meta.sql)) return;
  const newSql = meta.sql.replace(/\bAUTOINCREMENT\b/i, '');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE ${tableName}__new (${newSql.replace(/^CREATE TABLE[^(]*\(/i, '').replace(/\);?\s*$/, '')})`);
    db.exec(`INSERT INTO ${tableName}__new SELECT * FROM ${tableName}`);
    db.exec(`DROP TABLE ${tableName}`);
    db.exec(`ALTER TABLE ${tableName}__new RENAME TO ${tableName}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.warn(`[OJ] 迁移 ${tableName} 编号释放失败：`, e.message);
  }
}
// 外键关闭，避免重建时级联检查干扰；完成后恢复
db.exec('PRAGMA foreign_keys = OFF');
try {
  for (const t of ['problems', 'contests', 'editorials', 'discussions', 'users']) releaseContentIds(t);
} finally {
  db.exec('PRAGMA foreign_keys = ON');
}

// 迁移：兼容旧库，为 contests 补充 signup_required 列
const contestCols = db.prepare('PRAGMA table_info(contests)').all();
if (!contestCols.some((c) => c.name === 'signup_required')) {
  db.exec('ALTER TABLE contests ADD COLUMN signup_required INTEGER NOT NULL DEFAULT 0');
}

// 迁移：用户权限分级（role / 发帖 / 发题解 / 封禁）
const userCols = db.prepare('PRAGMA table_info(users)').all();
const uNames = new Set(userCols.map((c) => c.name));
if (!uNames.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
if (!uNames.has('can_discuss')) db.exec('ALTER TABLE users ADD COLUMN can_discuss INTEGER NOT NULL DEFAULT 1');
if (!uNames.has('can_reply')) db.exec('ALTER TABLE users ADD COLUMN can_reply INTEGER NOT NULL DEFAULT 1');
if (!uNames.has('can_editorial')) db.exec('ALTER TABLE users ADD COLUMN can_editorial INTEGER NOT NULL DEFAULT 1');
if (!uNames.has('banned')) db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
if (!uNames.has('nickname')) db.exec('ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT \'\'');
if (!uNames.has('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT \'\'');
if (!uNames.has('can_speak')) db.exec('ALTER TABLE users ADD COLUMN can_speak INTEGER NOT NULL DEFAULT 1');
// 自由发言权限 = 旧发布讨论 & 参与讨论的合并（两者任一被撤销即视为撤销）
db.exec('UPDATE users SET can_speak = 0 WHERE can_discuss = 0 OR can_reply = 0');

// 迁移：题目显示分数开关
const pCols = db.prepare('PRAGMA table_info(problems)').all();
if (!pCols.some((c) => c.name === 'show_score')) {
  db.exec('ALTER TABLE problems ADD COLUMN show_score INTEGER NOT NULL DEFAULT 1');
}
// 迁移：题目题解提交通道开关（管理员可关闭某题题解提交）
if (!pCols.some((c) => c.name === 'editorial_closed')) {
  db.exec('ALTER TABLE problems ADD COLUMN editorial_closed INTEGER NOT NULL DEFAULT 0');
}
// 旧管理员 → admin 角色
db.exec("UPDATE users SET role = 'admin' WHERE role = 'user' AND is_admin = 1");
// 确保内置管理员为超级管理员
db.exec("UPDATE users SET role = 'superadmin' WHERE username = 'admin'");

// 迁移：题解审核状态（旧题解直接视为已通过）
const edCols = db.prepare('PRAGMA table_info(editorials)').all();
if (!edCols.some((c) => c.name === 'status')) {
  db.exec("ALTER TABLE editorials ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
}
// 迁移：文章分类（提交审核时必选；草稿可不选）
if (!edCols.some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE editorials ADD COLUMN category TEXT NOT NULL DEFAULT ''");
}

// 迁移：用户 rating / 棕名 / 邮箱验证
const uCols2 = db.prepare('PRAGMA table_info(users)').all();
const uNames2 = new Set(uCols2.map((c) => c.name));
if (!uNames2.has('rating')) db.exec('ALTER TABLE users ADD COLUMN rating INTEGER NOT NULL DEFAULT 0');
if (!uNames2.has('rated_games')) db.exec('ALTER TABLE users ADD COLUMN rated_games INTEGER NOT NULL DEFAULT 0');
if (!uNames2.has('brown_name')) db.exec('ALTER TABLE users ADD COLUMN brown_name INTEGER NOT NULL DEFAULT 0');
if (!uNames2.has('brown_name_until')) db.exec('ALTER TABLE users ADD COLUMN brown_name_until INTEGER NOT NULL DEFAULT 0');
if (!uNames2.has('brown_type')) db.exec("ALTER TABLE users ADD COLUMN brown_type TEXT NOT NULL DEFAULT ''");
if (!uNames2.has('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
if (!uNames2.has('email_verify_token')) db.exec("ALTER TABLE users ADD COLUMN email_verify_token TEXT NOT NULL DEFAULT ''");
if (!uNames2.has('email_change_token')) db.exec("ALTER TABLE users ADD COLUMN email_change_token TEXT NOT NULL DEFAULT ''");
// 迁移：管理员权限位（逗号分隔；拥有全部权限 = 超级管理员）
if (!uNames2.has('permissions')) {
  db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT ''");
}
// 旧版超级管理员/管理员自动获得全部/核心权限
db.exec("UPDATE users SET permissions = 'problem,user,editorial_review,article_review,contest,discussion,article,editorial' WHERE username = 'admin'");
db.exec("UPDATE users SET permissions = 'problem,contest,editorial_review,article_review,editorial,article' WHERE permissions = '' AND role IN ('admin','superadmin') AND username != 'admin'");

// 迁移：比赛 rated / 阈值 / ratings_applied
const cCols = db.prepare('PRAGMA table_info(contests)').all();
const cNames = new Set(cCols.map((c) => c.name));
if (!cNames.has('rated')) db.exec('ALTER TABLE contests ADD COLUMN rated INTEGER NOT NULL DEFAULT 0');
if (!cNames.has('rating_threshold')) db.exec('ALTER TABLE contests ADD COLUMN rating_threshold INTEGER NOT NULL DEFAULT 0');
if (!cNames.has('ratings_applied')) db.exec('ALTER TABLE contests ADD COLUMN ratings_applied INTEGER NOT NULL DEFAULT 0');
// 比赛必须报名：历史比赛同样统一为需报名
db.exec('UPDATE contests SET signup_required = 1');

// 迁移：报名表 rated / rank
const rCols = db.prepare('PRAGMA table_info(contest_registrations)').all();
const rNames = new Set(rCols.map((c) => c.name));
if (!rNames.has('rated')) {
  db.exec('ALTER TABLE contest_registrations ADD COLUMN rated INTEGER NOT NULL DEFAULT 1');
}
if (!rNames.has('rank')) {
  db.exec('ALTER TABLE contest_registrations ADD COLUMN rank INTEGER NOT NULL DEFAULT 0');
}

// 默认设置
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('email_verify_required', '0')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('site_name', 'LCZOJ')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('site_logo', '')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_host', '')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_port', '465')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_user', '')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_pass', '')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_secure', '1')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('discussion_enabled', '1')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('article_enabled', '1')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('points_enabled', '1')").run();
// 全站积分结算（「功能设置」页）：模式（**默认 realtime 实时** / interval 定时自动 / manual 手动结算）、
// 定时间隔（内部仍以**分钟**存储，界面按「小时 / 天」展示与校验，范围 60 ~ 43200 = 1 小时 ~ 30 天）、上次结算时间戳。
// 默认 realtime：新装站点开箱即「显示始终取实时值」，快照只作历史（不再需要管理员先手动结算一次）。
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('points_settle_mode', 'realtime')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('points_settle_interval_minutes', '360')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('points_settle_last_run', '0')").run();
// 私信功能开关（默认开启）、侧边栏 Logo 大小（px，空=默认 28）与侧栏站名字号（px，空=默认 24）
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('pm_enabled', '1')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('site_logo_size', '')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title_size', '')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('footer_text', 'Copyright © 2024 LCZOJ · 仅供学习交流使用')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('help_content', '## 帮助中心\n\n### 使用说明\n\n完整的**功能使用说明**（普通用户与管理员，含题目数据配置 / 子任务计分 / ZIP 覆盖合并 / 大数据包 / SPJ / 提交答案题等）见：\n\n- 📖 [LCZOJ 功能使用说明](/docs/USAGE.md)（新标签页打开）\n\n### 如何提交代码\n\n1. 在题库中选择题目，阅读题面后点击「提交评测」；\n2. 选择语言并粘贴代码，点击提交；\n3. 稍候刷新即可看到评测结果。\n\n### 如何参加比赛\n\n- 在「比赛」页选择比赛并报名（需报名制）；\n- 比赛进行中可在比赛界面查看题目并提交；\n- OI 赛制比赛中不公布成绩，结束后公布。\n\n### 积分与等级分\n\n- 积分四维非线性增长：刷题、比赛、社区贡献、打卡；\n- 等级分在 Rated 比赛结束后由管理员手动结算。\n\n### 遇到问题\n\n- 查看[使用说明](/docs/USAGE.md)或通过「联系我们」页面获取帮助。')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('agreement_content', '## 用户协议\n\n欢迎使用本在线评测系统。\n\n1. **合法使用**：不得利用本系统从事任何违法违规活动；\n2. **代码原创**：提交的题解应为本人原创，抄袭将受到棕名等处罚；\n3. **尊重他人**：讨论区发言请保持友善，禁止人身攻击与刷屏；\n4. **账号安全**：请妥善保管账号密码，因个人原因造成的损失由本人承担；\n5. **内容管理**：管理员有权对违规内容进行删除、封禁等处理。\n\n继续使用本系统即表示你同意以上条款。')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('contact_content', '## 联系我们\n\n如有问题或建议，欢迎通过以下方式联系我们：\n\n- **邮箱**：admin@example.com\n- **GitHub**：https://github.com/lichenzhen0713/LCZOJ\n- **QQ 群**：123456789\n\n我们会在 1-3 个工作日内回复。')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('about_content', '## 关于网站\n\n本项目是一套零依赖、可自部署的在线评测系统（Online Judge），参考洛谷等知名 OJ 的交互设计，使用 Node.js 内置模块构建，无需安装任何 npm 包。\n\n### 功能特性\n\n- 题库与评测（支持 C/C++/Java/Python/Pascal/PHP/Go/Rust）\n- 多赛制比赛（ACM / IOI / OI）与 Rating 结算\n- 讨论区、题解与专栏文章、通知与收藏\n- 积分（积分）体系、每日打卡、等级分曲线\n- 权限管理后台、站点自定义（名称 / Logo / 页脚 / 帮助文档）\n\n### 开源与许可\n\n本项目以 MIT 许可证开源，欢迎提交 Issue 与 Pull Request。')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('rules_content', '## 社区规则\n\n为了维护良好的社区氛围，请遵守以下规则：\n\n1. **文明交流**：讨论区与题解区请友善发言，禁止人身攻击、辱骂、刷屏与广告；\n2. **代码诚信**：禁止抄袭他人题解；一经发现将清空练习积分并棕名处罚 14 天；\n3. **比赛公平**：比赛期间禁止泄露题目与提交他人代码；作弊者对应场次判 -1 分并棕名 14 天；\n4. **内容合规**：不得发布违法违规、色情、政治敏感内容；\n5. **账号管理**：一个用户仅允许注册一个账号，禁止恶意注册；\n6. **违规处理**：管理员有权删除违规内容，并对违规账号进行警告、撤销权限、封禁等处理。\n\n感谢你的配合，祝刷题愉快！')").run();

// 迁移：通知分类
const nCols = db.prepare('PRAGMA table_info(notifications)').all();
if (!nCols.some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE notifications ADD COLUMN category TEXT NOT NULL DEFAULT 'system'");
}

// 迁移：讨论置顶
const dCols = db.prepare('PRAGMA table_info(discussions)').all();
if (!dCols.some((c) => c.name === 'pinned')) {
  db.exec('ALTER TABLE discussions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
}
if (!dCols.some((c) => c.name === 'board')) {
  db.exec("ALTER TABLE discussions ADD COLUMN board TEXT NOT NULL DEFAULT 'academic'");
}

// 迁移：收藏支持 题目/讨论/比赛（item_type + item_id；problem_id 允许为空）
const favCols = db.prepare('PRAGMA table_info(favorites)').all();
const favProblemCol = favCols.find((c) => c.name === 'problem_id');
const favHasType = favCols.some((c) => c.name === 'item_type');
if (!favHasType || (favProblemCol && favProblemCol.notnull === 1)) {
  db.exec('CREATE TABLE IF NOT EXISTS favorites_new (\n' +
    '  user_id INTEGER NOT NULL,\n' +
    '  problem_id INTEGER,\n' +
    '  item_type TEXT NOT NULL DEFAULT \'problem\',\n' +
    '  item_id INTEGER,\n' +
    '  created_at INTEGER NOT NULL,\n' +
    '  PRIMARY KEY (user_id, problem_id),\n' +
    '  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE\n' +
    ')');
  if (favHasType) {
    db.exec('INSERT OR IGNORE INTO favorites_new (user_id, problem_id, item_type, item_id, created_at) ' +
      'SELECT user_id, problem_id, item_type, item_id, created_at FROM favorites');
  } else {
    db.exec("INSERT OR IGNORE INTO favorites_new (user_id, problem_id, item_type, item_id, created_at) " +
      "SELECT user_id, problem_id, 'problem', problem_id, created_at FROM favorites");
  }
  db.exec('DROP TABLE favorites');
  db.exec('ALTER TABLE favorites_new RENAME TO favorites');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fav_user_item ON favorites(user_id, item_type, item_id)');
}

// 迁移：提交记录级 O2 开关
const subColsO2 = db.prepare('PRAGMA table_info(submissions)').all();
if (!subColsO2.some((c) => c.name === 'enable_o2')) {
  db.exec('ALTER TABLE submissions ADD COLUMN enable_o2 INTEGER NOT NULL DEFAULT 1');
}
/* 迁移：通信题（problem_type = 'communication'）的第二份程序源码。
 * 通信题要求选手提交**两个程序**：程序一（code，读题目输入并产生中间输出）与
 * 程序二（code2，输入来自程序一的输出，产生最终答案）。两者存在同一行提交里，
 * 因此只需给 submissions 加一列；非通信题提交 code2 恒为 ''（幂等迁移，兼容旧库）。 */
const subColsComm = db.prepare('PRAGMA table_info(submissions)').all();
if (!subColsComm.some((c) => c.name === 'code2')) {
  db.exec("ALTER TABLE submissions ADD COLUMN code2 TEXT NOT NULL DEFAULT ''");
}

// 迁移：题目 开启O2 / Special Judge / 提交答案题
const probCols = db.prepare('PRAGMA table_info(problems)').all();
if (!probCols.some((c) => c.name === 'enable_o2')) {
  db.exec('ALTER TABLE problems ADD COLUMN enable_o2 INTEGER NOT NULL DEFAULT 1');
}
if (!probCols.some((c) => c.name === 'spj')) {
  db.exec('ALTER TABLE problems ADD COLUMN spj INTEGER NOT NULL DEFAULT 0');
}
if (!probCols.some((c) => c.name === 'output_only')) {
  db.exec('ALTER TABLE problems ADD COLUMN output_only INTEGER NOT NULL DEFAULT 0');
}
// 迁移：题目来源标签（如 洛谷/Codeforces/AtCoder/原创），与算法标签（tags）区分
if (!probCols.some((c) => c.name === 'source')) {
  db.exec("ALTER TABLE problems ADD COLUMN source TEXT NOT NULL DEFAULT ''");
}
// 迁移：题目背景（洛谷风格的「题目背景」区块，Markdown，留空则不显示该区块）
if (!probCols.some((c) => c.name === 'background')) {
  db.exec("ALTER TABLE problems ADD COLUMN background TEXT NOT NULL DEFAULT ''");
}
// 迁移：交互题（仿洛谷）
//   problem_type     standard=普通题 / interactive_io=IO 交互题 / interactive_func=函数式交互题
//   interactive_hint 题目页展示的交互说明（函数签名、调用约定、注意事项等，Markdown）
// 交互器 / grader / 头文件按 SPJ 的 checker 做法**存文件**，不入库。
if (!probCols.some((c) => c.name === 'problem_type')) {
  db.exec("ALTER TABLE problems ADD COLUMN problem_type TEXT NOT NULL DEFAULT 'standard'");
}
if (!probCols.some((c) => c.name === 'interactive_hint')) {
  db.exec("ALTER TABLE problems ADD COLUMN interactive_hint TEXT NOT NULL DEFAULT ''");
}
// 历史题目统一显式标记为 standard（幂等），保证「普通题 + SPJ」路径不受交互题分流影响
db.prepare("UPDATE problems SET problem_type = 'standard' WHERE problem_type IS NULL OR problem_type = ''").run();
// 迁移：遗留的提交答案题（output_only = 1）同步为 problem_type = 'output_only'
// （两者语义等价：problem_type==='output_only' ⇔ output_only=1；新写入由 src/problems.js 统一维护）
db.prepare("UPDATE problems SET problem_type = 'output_only' WHERE output_only = 1 AND problem_type = 'standard'").run();
db.prepare("UPDATE problems SET output_only = 1 WHERE problem_type = 'output_only' AND output_only = 0").run();
db.prepare("UPDATE problems SET output_only = 0 WHERE problem_type <> 'output_only' AND output_only = 1").run();
// 迁移：封禁/撤销权限可设置时长
const userCols3 = db.prepare('PRAGMA table_info(users)').all();
if (!userCols3.some((c) => c.name === 'banned_until')) {
  db.exec('ALTER TABLE users ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0');
}
if (!userCols3.some((c) => c.name === 'can_speak_until')) {
  db.exec('ALTER TABLE users ADD COLUMN can_speak_until INTEGER NOT NULL DEFAULT 0');
}
if (!userCols3.some((c) => c.name === 'can_editorial_until')) {
  db.exec('ALTER TABLE users ADD COLUMN can_editorial_until INTEGER NOT NULL DEFAULT 0');
}

// 迁移：密码找回令牌
const uColsReset = db.prepare('PRAGMA table_info(users)').all();
if (!uColsReset.some((c) => c.name === 'password_reset_token')) {
  db.exec("ALTER TABLE users ADD COLUMN password_reset_token TEXT NOT NULL DEFAULT ''");
}
// 迁移：用户名修改次数（普通用户一年限 3 次；管理员不受限）
const uColsName = db.prepare('PRAGMA table_info(users)').all();
if (!uColsName.some((c) => c.name === 'username_changes')) {
  db.exec('ALTER TABLE users ADD COLUMN username_changes INTEGER NOT NULL DEFAULT 0');
}
if (!uColsName.some((c) => c.name === 'username_changed_at')) {
  db.exec('ALTER TABLE users ADD COLUMN username_changed_at INTEGER NOT NULL DEFAULT 0');
}

/* ---------------- 迁移：认证面加固（安全审计 H3 / H4 / H5） ----------------
 * 1) must_change_password：口令是用环境变量 / 默认弱口令建立时置 1，登录后提示并要求改密；
 * 2) 各类验证码（邮箱验证 / 换邮箱 / 找回密码）补「过期时间 + 尝试次数」列，实现 10 分钟过期、
 *    最多 5 次尝试、一次性消费；历史令牌没有这些元数据，无法判定是否过期/被猜过，一次性清空；
 * 3) auth_failures 表：登录 / 注册 / 找回 / 验证码校验的「IP + 账号」失败计数与临时锁定，
 *    落库持久化（重启不清零）。以上全部为幂等迁移，兼容已有数据库。
 */
const uColsSec = db.prepare('PRAGMA table_info(users)').all();
const uSec = new Set(uColsSec.map((c) => c.name));
if (!uSec.has('must_change_password')) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
if (!uSec.has('email_verify_token_expires')) db.exec('ALTER TABLE users ADD COLUMN email_verify_token_expires INTEGER NOT NULL DEFAULT 0');
if (!uSec.has('email_verify_token_attempts')) db.exec('ALTER TABLE users ADD COLUMN email_verify_token_attempts INTEGER NOT NULL DEFAULT 0');
if (!uSec.has('email_change_token_expires')) db.exec('ALTER TABLE users ADD COLUMN email_change_token_expires INTEGER NOT NULL DEFAULT 0');
if (!uSec.has('email_change_token_attempts')) db.exec('ALTER TABLE users ADD COLUMN email_change_token_attempts INTEGER NOT NULL DEFAULT 0');
if (!uSec.has('password_reset_token_expires')) db.exec('ALTER TABLE users ADD COLUMN password_reset_token_expires INTEGER NOT NULL DEFAULT 0');
if (!uSec.has('password_reset_token_attempts')) db.exec('ALTER TABLE users ADD COLUMN password_reset_token_attempts INTEGER NOT NULL DEFAULT 0');

db.exec(`CREATE TABLE IF NOT EXISTS auth_failures (
  scope TEXT NOT NULL,
  ident TEXT NOT NULL,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  first_fail_at INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, ident)
)`);

/* ---------------- 迁移：内置管理员口令变更审计（v2.5.0 安全加固） ----------------
 * 背景：内置 admin 是站点的最后一道「后门」，它的口令变更必须可追溯 —— 任何成功的变更
 * （本人改密 / 超管重置 / 找回重置 / seed 初始化）与任何被拦截的越权尝试都要留痕。
 * 为什么不复用 moderation_logs：那张表没有「来源 IP」列，且会被 batchDelete('clear_all') 清空，
 * 而口令变更的痕迹不该被「一键清空数据」抹掉。因此单独建 admin_audit（纯新增表，幂等迁移，
 * 兼容已有库，不改动任何既有表结构），并把每条记录同时镜像到 moderation_logs 便于后台直接查看。
 * admin_audit 不参与 clear_all，只增不删。
 */
db.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  actor_id INTEGER NOT NULL DEFAULT 0,
  actor_name TEXT NOT NULL DEFAULT '',
  target_id INTEGER NOT NULL DEFAULT 0,
  target_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at)'); } catch (e) { console.warn('[LCZOJ] admin_audit 索引创建失败：' + (e && e.message)); }

/* ---------------- 迁移：讨论板块 / 文章分类改为可配置（v2.7.0 后台「板块与分类管理」） ----------------
 * 背景：讨论板块此前是 src/discussion.js 与前端 app.js 里的固定白名单（academic / water / site / problem），
 * 文章分类此前是 src/editorial.js 的 CATEGORIES 常量 —— 管理员既不能新增，也不能改名或调整顺序。
 * 现在把两者落成两张**配置表**（纯新增表，幂等迁移，不改动任何既有表结构）：
 *   · discussion_boards.key / article_categories.key 是**稳定内部 key**：discussions.board 与
 *     editorials.category 存的就是它；name 只用于显示 —— 重命名只改 name，key 不变，
 *     已有讨论 / 文章因此永远不会与板块、分类失联。
 *   · 首次按代码里的常量**并参考现有数据取值**做 seed（INSERT OR IGNORE），保证升级后
 *     页面展示与既有行为逐项一致（板块 4 个、分类 7 个，顺序与前端原有顺序相同）。
 *   · is_system = 1 表示内置项：允许重命名；删除必须显式指定迁移目标（兜底 / 系统项见 src/taxonomy.js）。
 * 每一次增删改都由 src/taxonomy.js 写入 admin_audit（主）+ moderation_logs（镜像），动作名 board_* / category_*。
 */
db.exec(`CREATE TABLE IF NOT EXISTS discussion_boards (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS article_categories (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_discussion_boards_sort ON discussion_boards(sort_order)'); } catch (e) { console.warn('[LCZOJ] discussion_boards 索引创建失败：' + (e && e.message)); }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_article_categories_sort ON article_categories(sort_order)'); } catch (e) { console.warn('[LCZOJ] article_categories 索引创建失败：' + (e && e.message)); }

/* ---------------- 迁移：文章分类内部 key 中文 → 英文 slug（v2.7.0，幂等、可重复执行） ----------------
 * 背景：分类首次落表时用的是「key = 显示名」的中文值（未分类 / 题解 / 科技·工程 …），
 * 于是内部 key 与显示名绑在一起 —— 一旦想把显示名改成「解题报告」，key 也得跟着变，已有文章的
 * 分类引用就会失联。现在把 7 个内置分类的 key 统一改为英文 slug，显示名保持中文不变：
 *     未分类 → uncategorized   题解 → solution       科技·工程 → tech
 *     算法·理论 → algorithm    生活·游记 → life       学习·文化课 → study   休闲·娱乐 → entertainment
 * 迁移动作（对每个映射）：
 *   · 若配置表里存在旧中文 key 行：把该行 key 就地改成英文 slug（行本身、显示名、顺序、is_system 全部保留）；
 *   · 无论配置表有没有那一行，都把 editorials.category = 旧中文值的文章改到英文 slug
 *     （覆盖「配置行已被删掉、但文章仍引用旧值」的历史库）；
 *   · 极端情况（旧中文行与英文行同时存在，例如手工插过）：先把文章指到英文行，
 *     再删掉多余的中文行，避免出现两个行同时被引用。
 * **绝不删除任何文章**：只改 editorials.category 的取值与配置表 key 字段。
 * 幂等性：跑第二遍时旧中文 key 与旧中文取值都已不存在，所有 UPDATE/DELETE 命中 0 行，
 * 不写日志、不改任何数据。整段在**同一事务**内完成，失败整体回滚。
 */
const ARTICLE_CATEGORY_KEY_MAP = [
  ['未分类', 'uncategorized', '未分类'],
  ['题解', 'solution', '题解'],
  ['科技·工程', 'tech', '科技·工程'],
  ['算法·理论', 'algorithm', '算法·理论'],
  ['生活·游记', 'life', '生活·游记'],
  ['学习·文化课', 'study', '学习·文化课'],
  ['休闲·娱乐', 'entertainment', '休闲·娱乐'],
];
(function migrateArticleCategoryKeys() {
  const stat = { renamed: 0, merged: 0, deleted: 0, rewritten: 0, articles: 0 };
  try {
    db.exec('BEGIN');
    const getRow = db.prepare('SELECT key, name FROM article_categories WHERE key = ?');
    const updContent = db.prepare('UPDATE editorials SET category = ? WHERE category = ?');
    for (const [oldKey, newKey, defaultName] of ARTICLE_CATEGORY_KEY_MAP) {
      const oldRow = getRow.get(oldKey);
      let moved = updContent.run(newKey, oldKey).changes;
      if (moved) stat.rewritten++;
      stat.articles += moved;
      if (!oldRow) continue;                       // 没有旧配置行（新库 / 已迁移过）：只做内容兜底
      const newRow = getRow.get(newKey);
      if (newRow) {
        // 旧中文行与英文行同时存在：显示名以「被管理员改过的那一行」为准，然后删掉多余的中文行
        if (oldRow.name !== oldKey && newRow.name === defaultName) {
          db.prepare('UPDATE article_categories SET name = ? WHERE key = ?').run(oldRow.name, newKey);
        }
        stat.deleted += db.prepare('DELETE FROM article_categories WHERE key = ?').run(oldKey).changes;
        stat.merged++;
      } else {
        // 正常路径：就地把 key 改成英文 slug —— 行、显示名、顺序、is_system 全部保留
        stat.renamed += db.prepare('UPDATE article_categories SET key = ? WHERE key = ?').run(newKey, oldKey).changes;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.warn('[LCZOJ] 文章分类 key 英文化迁移失败（已回滚，数据未改动）：' + (e && e.message));
    return;
  }
  if (stat.renamed || stat.merged || stat.deleted || stat.articles) {
    console.log(`[LCZOJ] 文章分类 key 已英文化：重命名 ${stat.renamed} 个分类，合并 ${stat.merged} 个重复分类（删除 ${stat.deleted} 行），`
      + `改写 ${stat.articles} 篇文章的分类引用（涉及 ${stat.rewritten} 个分类）`);
  }
})();

// 首次 seed（幂等）：内置项按代码常量写入；历史库里若存在常量之外的自定义取值，也一并补进配置表，
// 这样任何老库升级后都不会出现「前台回退显示原始 key」的历史条目。
(function seedTaxonomy() {
  const now = Date.now();
  const insBoard = db.prepare('INSERT OR IGNORE INTO discussion_boards (key, name, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, ?)');
  // 顺序与讨论页侧栏原有顺序一致：学术版 → 灌水区 → 站务版 → 题目总版（「全部板块」是前端固定项，不入库）
  for (const [key, name, sort] of [['academic', '学术版', 10], ['water', '灌水区', 20], ['site', '站务版', 30], ['problem', '题目总版', 40]]) {
    insBoard.run(key, name, sort, 1, now);
  }
  const insCat = db.prepare('INSERT OR IGNORE INTO article_categories (key, name, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, ?)');
  // v2.7.0：内部 key 一律英文 slug，显示名保持中文（key 与显示名彻底分离）。
  // 顺序与前端原有顺序一致：未分类 → 题解 → 科技·工程 → 算法·理论 → 生活·游记 → 学习·文化课 → 休闲·娱乐。
  // 上面的 migrateArticleCategoryKeys() 已把老库里的中文 key 改写成这些 slug，所以这里 INSERT OR IGNORE
  // 对老库是「已存在、不改动」，对全新库才真正插入。
  for (const [key, name, sort] of [
    ['uncategorized', '未分类', 10],
    ['solution', '题解', 20],
    ['tech', '科技·工程', 30],
    ['algorithm', '算法·理论', 40],
    ['life', '生活·游记', 50],
    ['study', '学习·文化课', 60],
    ['entertainment', '休闲·娱乐', 70],
  ]) {
    insCat.run(key, name, sort, 1, now);
  }
  // 兜底：把现有内容里出现过、但不在常量里的取值补进配置表（is_system = 0，顺序排在最后）
  try {
    let extra = 0;
    let sort = db.prepare('SELECT MAX(sort_order) AS m FROM discussion_boards').get().m || 0;
    for (const r of db.prepare("SELECT DISTINCT board AS k FROM discussions WHERE board IS NOT NULL AND board <> ''").all()) {
      if (db.prepare('SELECT key FROM discussion_boards WHERE key = ?').get(r.k)) continue;
      insBoard.run(r.k, r.k, (sort += 10), 0, now);
      extra++;
    }
    sort = db.prepare('SELECT MAX(sort_order) AS m FROM article_categories').get().m || 0;
    for (const r of db.prepare("SELECT DISTINCT category AS k FROM editorials WHERE category IS NOT NULL AND category <> ''").all()) {
      if (db.prepare('SELECT key FROM article_categories WHERE key = ?').get(r.k)) continue;
      insCat.run(r.k, r.k, (sort += 10), 0, now);
      extra++;
    }
    if (extra) console.log(`[LCZOJ] 板块 / 分类配置表已补录 ${extra} 个历史取值（保证旧内容不再回退显示内部 key）`);
  } catch (e) {
    console.warn('[LCZOJ] 补录历史板块 / 分类取值失败（不影响启动）：' + (e && e.message));
  }
})();

/**
 * 写入一条「内置管理员口令变更」审计记录（唯一入口，src/auth.js 与 src/users.js 共用）。
 * 记录：时间 / 操作者 id+用户名 / 目标 id+用户名 / 动作 / 明细 / 来源 IP。
 * **绝不记录口令本身或口令哈希**，detail 只写「来源、原因、拒绝理由」这类可公开追溯的信息。
 * 任何写入失败都只打日志，绝不影响口令变更/拒绝本身的返回结果。
 * @param {{actorId?:number, actorName?:string, targetId?:number, targetName?:string, action:string, detail?:string, ip?:string}} entry
 * @returns {boolean} admin_audit 是否写入成功
 */
function auditAdminPasswordChange(entry = {}) {
  const now = Date.now();
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const actorId = num(entry.actorId);
  const actorName = str(entry.actorName, 80);
  const targetId = num(entry.targetId);
  const targetName = str(entry.targetName, 80);
  const action = str(entry.action, 60);
  const detail = str(entry.detail, 500);
  const ip = str(entry.ip, 80);
  let wrote = false;
  try {
    db.prepare('INSERT INTO admin_audit (created_at, actor_id, actor_name, target_id, target_name, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now, actorId, actorName, targetId, targetName, action, detail, ip);
    wrote = true;
  } catch (e) {
    console.warn('[LCZOJ] 写入内置管理员口令审计失败（admin_audit）：' + (e && e.message));
  }
  // 镜像到社区管理公布页（该表无 IP 列，IP 拼进 detail），便于后台「社区管理」直接看到
  try {
    db.prepare('INSERT INTO moderation_logs (admin_id, admin_name, user_id, username, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(actorId, actorName, targetId, targetName, action, detail + (ip ? `（来源 IP：${ip}）` : ''), now);
  } catch (e) {
    console.warn('[LCZOJ] 镜像内置管理员口令审计到社区管理记录失败：' + (e && e.message));
  }
  return wrote;
}

/** 读取内置管理员口令变更审计（倒序，供运维排查 / 验收取证；不做 HTTP 暴露） */
function readAdminAudit(limit = 50) {
  const n = Math.max(1, Math.min(1000, parseInt(limit, 10) || 50));
  return db.prepare('SELECT id, created_at, actor_id, actor_name, target_id, target_name, action, detail, ip FROM admin_audit ORDER BY id DESC LIMIT ?').all(n);
}

/* ---------------- 迁移：待验证注册（v2.5.0 安全加固） ----------------
 * 开启邮箱验证时，注册**只写这张表**，绝不写 users —— 邮箱验证通过前账号完全不存在，
 * 从根本上消除「未验证的半成品账号」。验证码以 sha256 哈希存储（不存明文），
 * 同样遵守 10 分钟过期、最多 5 次尝试、一次性消费的规则。
 * 同一邮箱 / 同一用户名的重复注册只保留最新一条记录（配合下方的唯一索引）。
 * 全部为幂等迁移，兼容已有数据库。
 */
db.exec(`CREATE TABLE IF NOT EXISTS pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  verify_token_hash TEXT NOT NULL DEFAULT '',
  verify_token_expires INTEGER NOT NULL DEFAULT 0,
  verify_token_attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`);
// 唯一索引：一个邮箱 / 一个用户名最多一条待验证记录（避免同一邮箱狂刷）
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_reg_email ON pending_registrations(email)'); } catch (e) { console.warn('[LCZOJ] 待验证注册邮箱唯一索引创建失败：' + (e && e.message)); }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_reg_username ON pending_registrations(username)'); } catch (e) { console.warn('[LCZOJ] 待验证注册用户名唯一索引创建失败：' + (e && e.message)); }

// 一次性迁移：历史验证码 / 重置码缺少过期时间与尝试次数，无法可信校验，统一置空
try {
  const cleared = db.prepare("SELECT value FROM settings WHERE key = 'security_legacy_tokens_cleared'").get();
  if (!cleared || cleared.value !== '1') {
    const r = db.prepare("UPDATE users SET email_verify_token = '', email_change_token = '', password_reset_token = ''").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('security_legacy_tokens_cleared', '1')").run();
    console.log(`[LCZOJ] 安全迁移：已清空历史邮箱验证码 / 找回密码令牌（影响 ${r.changes} 个账号，未验证用户需重新获取验证码）`);
  }
} catch (e) {
  console.warn('[LCZOJ] 清空历史验证码失败：' + (e && e.message));
}

// 反馈 / 举报表（后台仅超级管理员可审核）
db.exec(`CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'feedback',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reply TEXT NOT NULL DEFAULT '',
  handled_by INTEGER,
  handle_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
)`);

/* ---------------- 迁移：反馈支持「二次处理」（v2.8.3） ----------------
 * 背景：过去只有「待处理」的反馈能写回复（后台把按钮禁用了），已处理 / 已关闭的反馈无法再改。
 * 现在管理员可以「再次处理」同一条反馈，于是需要把「被处理过几次」落库：
 *   · handle_count 记录处理次数（首次 = 1，二次 = 2 …），后台据此显示「第 N 次处理」；
 *   · 每一次处理的明细（处理人 / 状态 / 回复摘要 / 第 N 次）写 admin_audit（主，含来源 IP）
 *     + moderation_logs（镜像），见 src/feedback.js 的 auditFeedbackHandle()。
 * 纯新增列、幂等迁移：老库补列后历史行 handle_count = 0（表示升级前未记录次数，不影响显示）。 */
const fbCols = db.prepare('PRAGMA table_info(feedbacks)').all();
if (!fbCols.some((c) => c.name === 'handle_count')) {
  db.exec('ALTER TABLE feedbacks ADD COLUMN handle_count INTEGER NOT NULL DEFAULT 0');
}

// 打卡表
db.exec(`CREATE TABLE IF NOT EXISTS checkins (
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
)`);

db.exec('CREATE INDEX IF NOT EXISTS idx_editorials_status ON editorials(status)');

// ---------------- 测试数据文件读写 ----------------

function problemDir(id) {
  return path.join(TESTDATA_DIR, String(id));
}

/** Special Judge checker 文件路径（测试数据目录内） */
function checkerPath(id) {
  return path.join(problemDir(id), 'checker.cpp');
}

/* ---------------- 交互题（仿洛谷）：交互器 / grader / 头文件 ----------------
 * 与 SPJ 的 checker.cpp 一样按「存文件」处理，保存在题目测试数据目录内：
 *   data/testdata/<pid>/interactor.cpp   IO 交互题的交互器（argv[1] 为测试输入文件）
 *   data/testdata/<pid>/grader.cpp       函数式交互题的 grader（含 main()，与选手提交一起编译）
 *   data/testdata/<pid>/<name>.h         函数式交互题所需的自定义头文件（可多个）
 * 这些文件必须由 writeTestcases() 在清空目录前后「备份 → 恢复」，否则保存测试数据会把他们清掉。
 */

/** 附加头文件名是否合法：`[A-Za-z0-9_.-]{1,40}` 且以 .h 结尾（禁止路径分隔符，防目录穿越） */
function isValidInteractiveHeaderName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(name) && /\.h$/i.test(name);
}

/** IO 交互题的交互器路径（测试数据目录内） */
function interactorPath(id) {
  return path.join(problemDir(id), 'interactor.cpp');
}

/** 函数式交互题的 grader 路径（测试数据目录内） */
function graderPath(id) {
  return path.join(problemDir(id), 'grader.cpp');
}

/** 某个附加头文件的路径（名称需先通过 isValidInteractiveHeaderName 校验） */
function interactiveHeaderPath(id, name) {
  if (!isValidInteractiveHeaderName(name)) return null;
  return path.join(problemDir(id), name);
}

/** 列出题目目录内已上传的附加头文件：[{ name, content }]（按名称排序，内容为 UTF-8 文本） */
function listInteractiveHeaders(id) {
  const dir = problemDir(id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!isValidInteractiveHeaderName(name)) continue;
    try {
      out.push({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') });
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * 保存题目的交互题配套文件（interactor.cpp / grader.cpp / 附加头文件）。
 * 字段为 undefined 时保持原样不动；为空字符串表示删除该文件；
 * headers 为 [{ name, content }]，采用「整体替换」语义（未列出的旧头文件会被删除）。
 */
function writeInteractiveAssets(problemId, { interactor, grader, headers } = {}) {
  const dir = problemDir(problemId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const results = { interactor: false, grader: false, headers: [] };
  if (interactor !== undefined) {
    const p = interactorPath(problemId);
    if (String(interactor).length > 0) {
      fs.writeFileSync(p, String(interactor));
      results.interactor = true;
    } else {
      try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  }
  if (grader !== undefined) {
    const p = graderPath(problemId);
    if (String(grader).length > 0) {
      fs.writeFileSync(p, String(grader));
      results.grader = true;
    } else {
      try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  }
  if (Array.isArray(headers)) {
    // 先删掉现有头文件（整体替换），再写入新的
    for (const h of listInteractiveHeaders(problemId)) {
      try { fs.rmSync(path.join(dir, h.name), { force: true }); } catch { /* ignore */ }
    }
    for (const h of headers) {
      const name = String((h && h.name) || '');
      if (!isValidInteractiveHeaderName(name)) continue;
      fs.writeFileSync(path.join(dir, name), String((h && h.content) || ''));
      results.headers.push(name);
    }
  }
  return results;
}

function metaPath(dir) { return path.join(dir, 'meta.json'); }

/* ---------------- 通信题（problem_type = 'communication'）的题目侧开关 ----------------
 * 通信题的评测需要用**两个选手程序**协作完成任务，题目侧需要选择两者的连接方式：
 *   · relay （默认）：先用 N.in 跑程序一，收下它的 stdout；若题目提供 grader.cpp（评测端中转程序），
 *                    就用它把程序一的输出处理成程序二的输入；再以该输入跑程序二，比较程序二输出与 N.out。
 *   · direct        ：把程序一的 stdout 直接接到程序二的 stdin，两者**并行运行、边跑边传**
 *                    （duplex = true 时再把程序二的 stdout 回传给程序一的 stdin，用于双向对话式合作）。
 * 这些开关随测试数据一起保存在题目目录的 meta.json 里（键名见下），与子任务分数 / 点级限额同一份文件；
 * writeTestcases() 在重写 meta.json 时会**保留**调用方未显式提供的这些键，因此「保存测试数据」不会把它们弄丢。
 */
const COMM_PIPE_MODES = ['relay', 'direct'];
/** 通信题配置项的 meta.json 键（writeTestcases 需要识别并保留它们） */
const COMM_META_KEYS = ['pipe_mode', 'prog1_output_limit_bytes', 'duplex'];

/** 规范化连接方式：非法值一律回退 relay（默认值，与文档/代码注释一致） */
function normalizePipeMode(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  return COMM_PIPE_MODES.includes(t) ? t : 'relay';
}

/**
 * 读取通信题配置（非通信题也照常返回默认值，调用方自行按 problem_type 判断是否使用）：
 *   pipe_mode                 'relay'（默认）| 'direct'
 *   prog1_output_limit_bytes  程序一输出（= 通信量）字节上限；0 = 不限（仅受系统输出上限约束）
 *   duplex                    direct 模式下是否把程序二的输出回传给程序一的 stdin
 */
function readCommunicationConfig(problemId) {
  const dir = problemDir(problemId);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')); } catch { meta = null; }
  const raw = meta && typeof meta === 'object' ? meta : {};
  const limit = parseInt(raw.prog1_output_limit_bytes, 10);
  return {
    pipe_mode: normalizePipeMode(raw.pipe_mode),
    prog1_output_limit_bytes: Number.isFinite(limit) && limit > 0 ? limit : 0,
    duplex: raw.duplex === true || raw.duplex === 1 || raw.duplex === '1',
  };
}

/** 读取 meta.json 原文（不存在 / 非法时返回 null），供 writeTestcases 保留通信题开关 */
function readMetaRaw(dir) {
  try { return JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')); } catch { return null; }
}

/**
 * 计算要写回 meta.json 的通信题开关：**请求里显式给了就用请求的，没给就沿用磁盘上的旧值**。
 * 这样「编辑测试点后保存」不会把连接方式 / 通信量上限重置回默认值。
 */
function mergeCommunicationMeta(meta, oldMeta) {
  const out = {};
  const src = meta && typeof meta === 'object' ? meta : {};
  const old = oldMeta && typeof oldMeta === 'object' ? oldMeta : {};
  for (const k of COMM_META_KEYS) {
    const has = Object.prototype.hasOwnProperty.call(src, k);
    const v = has ? src[k] : old[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'pipe_mode') { out.pipe_mode = normalizePipeMode(v); continue; }
    if (k === 'duplex') { out.duplex = (v === true || v === 1 || v === '1'); continue; }
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) out.prog1_output_limit_bytes = Math.min(n, 64 * 1024 * 1024);
  }
  return out;
}

/**
 * 点级限额归一化：测试点自定义的 time_limit_ms / memory_limit_mb。
 * 留空（null / undefined / ''）/ 非法 / 非正数 → null，表示「继承题目级限额」；
 * 有效值按 [min, max] 收敛（与题目级限额的限幅口径一致）。
 */
function normalizeCaseLimit(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(min, Math.min(max, n));
}

/** 点级时限允许范围（ms）/ 点级内存允许范围（MB）：与题目级限额保持一致 */
const CASE_TIME_LIMIT_MIN = 100;
const CASE_TIME_LIMIT_MAX = 10000;
const CASE_MEMORY_LIMIT_MIN = 16;
const CASE_MEMORY_LIMIT_MAX = 1024;

/**
 * 写入题目的测试数据。
 * cases: [{input, output, subtask, time_limit_ms, memory_limit_mb}]
 *   后两个字段为**点级限额**：留空 = 继承题目级限额（meta 里存 null）。
 * meta: {
 *   subtask_scores: [number],           —— 每个子任务的满分（子任务按出现顺序编号）
 *   subtask_types:  ['sum'|'min'|'max'|'bundle'] —— 每个子任务的计分方式（缺省 bundle）
 * }
 * 计分方式：sum=加和（各测试点均分累加）、min=取最小、max=取最大、bundle=捆绑（全对才得分）
 */
function writeTestcases(problemId, cases, meta) {
  const dir = problemDir(problemId);
  // 备份题目目录内的「代码类配套文件」：writeTestcases 会清空整个测试数据目录，须在清空前把已有 checker.cpp、
  // 交互题的 interactor.cpp / grader.cpp / *.h 暂存，写入新测试数据后恢复，
  // 避免「保存测试数据」/「上传 ZIP」把 Special Judge 的 checker 或交互题配套文件弄没。
  // M12：是否恢复由**题目身份**（problem_type / spj）决定，历史遗留的无关文件不再被塞回：
  //   非 SPJ 题不恢复 checker.cpp/checker.cc；非交互题不恢复 interactor.cpp / grader.cpp / *.h。
  const snapshot = snapshotDataFiles(dir).filter((f) => shouldRestoreDataFile(problemId, f.name));
  // 通信题开关（pipe_mode / 通信量上限 / duplex）也在这份 meta.json 里：必须在清空目录**之前**读旧值，
  // 否则「保存测试数据」会把连接方式重置回默认 relay（见 mergeCommunicationMeta）。
  const oldMeta = readMetaRaw(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const subtaskOfCase = [];
  const subtaskScores = meta && Array.isArray(meta.subtask_scores) ? meta.subtask_scores : null;
  const subtaskTypes = meta && Array.isArray(meta.subtask_types) ? meta.subtask_types : null;
  const subtaskMap = {};
  let nextSubtask = 0;
  cases.forEach((c, i) => {
    const n = i + 1;
    fs.writeFileSync(path.join(dir, `${n}.in`), c.input ?? '');
    fs.writeFileSync(path.join(dir, `${n}.out`), c.output ?? '');
    // 子任务编号仅作为分组键；未指定时全部归入子任务 0（默认题目只有一个子任务 0）
    let st = (c.subtask != null && c.subtask !== '') ? parseInt(c.subtask, 10) : 0;
    if (!Number.isFinite(st) || st < 0) st = 0;
    if (subtaskMap[st] === undefined) subtaskMap[st] = nextSubtask++;
    subtaskOfCase.push(subtaskMap[st]);
  });
  const numSubtasks = nextSubtask || 1;
  const scores = [];
  for (let i = 0; i < numSubtasks; i++) {
    scores.push(subtaskScores && subtaskScores[i] != null ? Number(subtaskScores[i]) : Math.floor(100 / numSubtasks));
  }
  // 补齐因整除造成的差值到最后一个子任务
  const sum = scores.reduce((a, b) => a + b, 0);
  if (sum !== 100 && scores.length) scores[scores.length - 1] += (100 - sum);
  // 计分方式：合法值 sum/min/max/bundle，缺省 bundle；
  // 只有一个子任务时默认 sum（整题按测试点比例给分，更符合常见 OJ 习惯）
  const types = [];
  for (let i = 0; i < numSubtasks; i++) {
    const t = subtaskTypes && subtaskTypes[i] != null ? String(subtaskTypes[i]).trim().toLowerCase() : (numSubtasks === 1 ? 'sum' : 'bundle');
    types.push(['sum', 'min', 'max', 'bundle'].includes(t) ? t : 'bundle');
  }
  // 点级限额（按测试点顺序保存，未设置的测试点存 null）：
  // 评测时「点级 ?? 题目级」——点级设置后同时约束该点的 TLE 与 MLE。
  const caseLimits = cases.map((c) => ({
    time_limit_ms: normalizeCaseLimit(c && c.time_limit_ms, CASE_TIME_LIMIT_MIN, CASE_TIME_LIMIT_MAX),
    memory_limit_mb: normalizeCaseLimit(c && c.memory_limit_mb, CASE_MEMORY_LIMIT_MIN, CASE_MEMORY_LIMIT_MAX),
  }));
  fs.writeFileSync(metaPath(dir), JSON.stringify({
    subtask_of_case: subtaskOfCase, subtask_scores: scores, subtask_types: types, case_limits: caseLimits,
    // 通信题开关：请求未提供时沿用磁盘旧值（非通信题也用不上，写了无害，且便于题目整体导出/迁移）
    ...mergeCommunicationMeta(meta, oldMeta),
  }));
  // 恢复之前备份的 checker.cpp / interactor.cpp / grader.cpp / *.h（若存在）
  restoreDataFiles(dir, snapshot);
  return { count: cases.length, subtasks: scores, types };
}

/** 测试数据目录内的「代码类配套文件」：清除目录前需备份，写入后恢复 */
const DATA_ASSET_NAMES = ['checker.cpp', 'checker.cc', 'interactor.cpp', 'grader.cpp'];

/** 需要保留 grader.cpp / *.h 的题型（函数式交互题与通信题）：与 src/problems.js 的 PROBLEM_TYPES 保持一致 */
const GRADER_PROBLEM_TYPES = ['interactive_func', 'communication'];

/**
 * M12：判断某个配套文件是否应按「题目身份」恢复。
 *   - checker.cpp / checker.cc：仅 SPJ 题（spj = 1）保留；
 *   - interactor.cpp：仅 IO 交互题（interactive_io）保留；
 *   - grader.cpp / *.h：函数式交互题（interactive_func）与通信题（communication）保留
 *     （通信题的 grader.cpp 是**可选的评测端中转程序**，与函数式交互题的 grader 同名同路径）；
 *   - 题目行查不到（异常流程）时退回旧行为，只在没有任何身份信息时才恢复；
 * 这样「标准题曾经用过 checker」之类的历史残留不会在重传测试数据后被塞回目录。
 */
function shouldRestoreDataFile(problemId, name) {
  let row = null;
  try { row = db.prepare('SELECT problem_type, spj FROM problems WHERE id = ?').get(problemId); } catch { row = null; }
  if (!row) return true; // 无法判定身份：保持既有行为，避免误删真实配套文件
  const lower = String(name || '').toLowerCase();
  const isChecker = lower === 'checker.cpp' || lower === 'checker.cc';
  const type = String(row.problem_type || '').trim();
  if (isChecker) return Number(row.spj) === 1;
  if (lower === 'interactor.cpp' || lower === 'interactor.cc') return type === 'interactive_io';
  if (lower === 'grader.cpp' || lower === 'grader.cc') return GRADER_PROBLEM_TYPES.includes(type);
  // 头文件（*.h）：只有需要「题目侧头文件」的题型才保留（函数式交互题 / 通信题）
  return GRADER_PROBLEM_TYPES.includes(type);
}

/** 备份题目测试数据目录内的代码类配套文件（checker / interactor / grader / *.h），返回 [{ name, content }] */
function snapshotDataFiles(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const keep = DATA_ASSET_NAMES.includes(name.toLowerCase()) || isValidInteractiveHeaderName(name);
    if (!keep) continue;
    try { out.push({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }); } catch { /* ignore */ }
  }
  return out;
}

/** 把 snapshotDataFiles() 备份的内容写回测试数据目录 */
function restoreDataFiles(dir, snapshot) {
  if (!Array.isArray(snapshot) || !snapshot.length) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  for (const f of snapshot) {
    try { fs.writeFileSync(path.join(dir, f.name), f.content); } catch { /* ignore */ }
  }
}

/** 读取题目的测试数据（含子任务与分数信息） */
function readTestcases(problemId) {
  const dir = problemDir(problemId);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^\d+\.in$/.test(f));
  const nums = files
    .map((f) => parseInt(f, 10))
    .sort((a, b) => a - b);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')); } catch { /* ignore */ }
  const subtaskOfCase = (meta && meta.subtask_of_case) || nums.map(() => 0);
  const subtaskScores = (meta && meta.subtask_scores) || nums.map(() => Math.floor(100 / nums.length));
  // 点级限额（v2.5.3）：meta.case_limits 按测试点顺序存 {time_limit_ms, memory_limit_mb}；
  // 旧题库 / 旧 ZIP 包没有该字段（或长度不足 / 项非法）时一律视为 null = 继承题目级限额，不报错。
  const caseLimits = caseLimitListOf(meta);
  // 子任务编号 0-based（默认题目只有一个子任务 0）
  return nums.map((n, i) => ({
    id: n,
    input: fs.readFileSync(path.join(dir, `${n}.in`), 'utf8'),
    output: fs.readFileSync(path.join(dir, `${n}.out`), 'utf8'),
    subtask: subtaskOfCase[i] != null ? subtaskOfCase[i] : 0,
    time_limit_ms: caseLimitAt(caseLimits[i], 'time_limit_ms'),
    memory_limit_mb: caseLimitAt(caseLimits[i], 'memory_limit_mb'),
  })).map((c) => ({ ...c, subtask_score: subtaskScores[c.subtask] != null ? subtaskScores[c.subtask] : 0 }));
}

/** meta.json 里的 case_limits 数组（缺失 / 非法 → 空数组，等价于「全部继承题目级」） */
function caseLimitListOf(meta) {
  return (meta && Array.isArray(meta.case_limits)) ? meta.case_limits : [];
}

/** 取某测试点的某一项点级限额（未设置 / 非法 / 越界归 null = 继承题目级） */
function caseLimitAt(item, key) {
  if (!item || typeof item !== 'object') return null;
  return key === 'time_limit_ms'
    ? normalizeCaseLimit(item.time_limit_ms, CASE_TIME_LIMIT_MIN, CASE_TIME_LIMIT_MAX)
    : normalizeCaseLimit(item.memory_limit_mb, CASE_MEMORY_LIMIT_MIN, CASE_MEMORY_LIMIT_MAX);
}

/**
 * 只读题目的**点级限额**（v2.5.3）：只解析 meta.json + 统计测试点个数，**不加载测试数据本体**，
 * 供题目页展示「实际生效的限额区间」等只读用途使用（避免为此把整份测试数据读进内存）。
 * 返回 [{ id, time_limit_ms, memory_limit_mb }]（未设置 = null = 继承题目级），按测试点编号升序。
 */
function readCaseLimits(problemId) {
  const dir = problemDir(problemId);
  let nums = [];
  try { nums = fs.readdirSync(dir).filter((f) => /^\d+\.in$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b); } catch { return []; }
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')); } catch { /* ignore */ }
  const caseLimits = caseLimitListOf(meta);
  return nums.map((n, i) => ({
    id: n,
    time_limit_ms: caseLimitAt(caseLimits[i], 'time_limit_ms'),
    memory_limit_mb: caseLimitAt(caseLimits[i], 'memory_limit_mb'),
  }));
}

/** 读取子任务分数列表 */
function readSubtaskScores(problemId) {
  const dir = problemDir(problemId);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8'));
    return meta.subtask_scores || [];
  } catch { return []; }
}

/** 读取子任务计分方式列表（sum/min/max/bundle），缺省 bundle */
function readSubtaskTypes(problemId) {
  const dir = problemDir(problemId);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8'));
    const arr = meta.subtask_types || [];
    const scores = meta.subtask_scores || [];
    const out = [];
    for (let i = 0; i < scores.length; i++) {
      // 缺省：只有一个子任务时按 sum（与写入逻辑一致），多子任务时 bundle
      const t = arr[i] != null ? String(arr[i]).trim().toLowerCase() : (scores.length === 1 ? 'sum' : 'bundle');
      out.push(['sum', 'min', 'max', 'bundle'].includes(t) ? t : 'bundle');
    }
    return out;
  } catch { return []; }
}

function testcaseCount(problemId) {
  const dir = problemDir(problemId);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => /^\d+\.in$/.test(f)).length;
}

// ---------------- 种子数据 ----------------

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    // 初始管理员密码：默认**随机生成**（不再是固定密码），也可用 OJ_ADMIN_PASSWORD 指定（便于自动化部署）
    // 环境变量同样必须通过口令强度校验（弱口令一律拒绝并退回随机生成）
    const fromEnv = String(process.env.OJ_ADMIN_PASSWORD || '').trim();
    const envPolicyError = fromEnv ? passwordPolicyError(fromEnv) : '';
    if (fromEnv && envPolicyError) {
      console.error(`[LCZOJ] 环境变量 OJ_ADMIN_PASSWORD 不符合密码强度要求（${envPolicyError}），已改为随机生成初始密码。`);
    }
    const useEnv = !!fromEnv && !envPolicyError;
    const password = useEnv ? fromEnv : generateAdminPassword();
    const info = db.prepare(
      "INSERT INTO users (username, email, password_hash, is_admin, role, permissions, bio, created_at, must_change_password) VALUES (?, ?, ?, 1, 'superadmin', ?, ?, ?, 1)"
    ).run('admin', 'cz20090521@126.com', hashPassword(password), 'problem,user,editorial_review,article_review,contest,discussion,article,editorial', '系统管理员', Date.now());
    const adminId = Number(info.lastInsertRowid) || 1;
    adminInit = { created: true, username: 'admin', password, source: useEnv ? 'env' : 'random', file: ADMIN_PASSWORD_FILE, must_change_password: true };
    // 审计：内置管理员口令由 seed 创建（服务器本地初始化，无 HTTP 来源）。
    // 只记录「口令来源」，**不记录口令本身**。
    auditAdminPasswordChange({
      actorId: 0,
      actorName: 'system(seed)',
      targetId: adminId,
      targetName: 'admin',
      action: 'admin_password_seed',
      detail: `首次初始化创建内置管理员账号，初始口令来源：${useEnv ? '环境变量 OJ_ADMIN_PASSWORD' : '服务器随机生成'}（审计不记录口令）`,
      ip: 'local',
    });
    // 明文落盘一份，便于用户稍后在服务器上查阅（权限 600，仅属主可读）
    try {
      fs.writeFileSync(ADMIN_PASSWORD_FILE, [
        'LCZOJ 初始管理员账号（首次初始化时写入，登录后请立即修改密码）',
        // 机器可读行（纯 ASCII）：安装脚本据此把初始密码打印到「部署完成」页面
        `admin-password: ${password}`,
        '',
        `用户名：${adminInit.username}`,
        `初始密码：${password}`,
        `生成方式：${useEnv ? '由环境变量 OJ_ADMIN_PASSWORD 指定' : '随机生成'}`,
        `生成时间：${new Date().toISOString()}`,
        '',
        '说明：本文件只是「首次登录用的初始密码」记录；登录后请在「系统设置」中修改密码，',
        '      修改后本文件内容即失效，可以删除。忘记密码时可用 node deploy/reset.js 重置数据后重建。',
        '',
      ].join('\n'), { mode: 0o600 });
      console.log(`[LCZOJ] 已生成初始管理员密码（${useEnv ? '来自 OJ_ADMIN_PASSWORD' : '随机'}），保存在 ${ADMIN_PASSWORD_FILE}`);
    } catch (e) {
      console.error('[LCZOJ] 写入初始密码文件失败：' + (e && e.message));
    }
  } else {
    // 若 admin 已存在但邮箱仍为早期默认值，则更新为用户指定的邮箱（幂等）
    const adm = db.prepare("SELECT id, email FROM users WHERE username = 'admin'").get();
    if (adm && (!adm.email || adm.email === 'admin@oj.local')) {
      db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run('cz20090521@126.com', adm.id);
    }
    // 注意：seed() 只在 users 表为空时创建内置 admin，**从不覆盖已存在 admin 的口令** ——
    // 因此 OJ_ADMIN_PASSWORD 只能用于「首次初始化」，无法在已有实例上改掉 admin 的口令（无需审计）。
  }

  const problemCount = db.prepare('SELECT COUNT(*) AS c FROM problems').get().c;
  if (problemCount > 0) return;

  const insert = db.prepare(`
    INSERT INTO problems (slug, title, description, input_format, output_format, samples, hint, tags, source, difficulty, time_limit_ms, memory_limit_mb, show_score, is_public, spj, output_only, problem_type, interactive_hint, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 1, ?)
  `);

  const now = Date.now();

  // 全新题库的 6 道内置演示题之 3：普通评测 A+B、Special Judge、提交答案题
  // （另外 2 道交互题 + 1 道通信题演示题由下面的 seedInteractiveDemos() 补齐，见文件末尾的调用顺序）
  const p1 = insert.run(
    'a-plus-b', 'A+B Problem',
    [
      '# A+B Problem',
      '',
      '输入两个整数 $a$ 和 $b$，输出它们的和。',
      '',
      '这是一道最基础的入门题，用于熟悉评测系统的使用。',
    ].join('\n'),
    '一行，两个整数 $a$ 和 $b$（$|a|,|b| \\le 10^9$）。',
    '一行，一个整数，表示 $a+b$ 的值。',
    JSON.stringify([{ input: '1 2', output: '3' }, { input: '-10 20', output: '10' }]),
    '注意数据范围，需要使用 64 位整数。',
    JSON.stringify(['入门', '数学']),
    '', 1, 1000, 128, 0, 0, 'standard', '', now
  );

  const p2 = insert.run(
    'spj-demo', 'SPJ 测试题',
    [
      '# Special Judge 测试题',
      '',
      '这是一道 Special Judge 题目，用于演示不唯一答案的判定。',
      '',
      '给定一个正整数 $n$，**任意**输出一个正整数 $x$，使得 $x$ 能被 $n$ 整除。',
      '',
      '答案不唯一：只要输出的数满足 $x \\bmod n = 0$ 即判为正确，由 checker 判定。',
    ].join('\n'),
    '一个正整数 $n$（$1 \\le n \\le 10^9$）。',
    '任意一个能被 $n$ 整除的正整数 $x$。',
    JSON.stringify([{ input: '3', output: '3' }, { input: '7', output: '14' }]),
    '输出任意倍数即可，例如 $n$ 本身；checker 会校验 $x \\bmod n = 0$。',
    JSON.stringify(['Special Judge', '入门']),
    '', 2, 1000, 128, 1, 0, 'standard', '', now
  );

  const p3 = insert.run(
    'output-demo', '提交答案测试题',
    [
      '# 提交答案测试题',
      '',
      '这是一道**提交答案题**：不需要编写代码，直接上传答案文件即可。',
      '',
      '题目要求：对于给定的测试点编号 $k$，输出它的平方 $k^2$。',
      '',
      '例如第 1 个测试点输出 `1`，第 2 个测试点输出 `4`，第 3 个测试点输出 `9`……',
    ].join('\n'),
    '无需输入（每个测试点对应编号 $1,2,3,\\dots$）。',
    '每个测试点输出该编号的平方。',
    JSON.stringify([{ input: '', output: '1' }]),
    '提交时打包上传 ZIP，内含 1.out、2.out、3.out…… 也可逐个测试点上传答案文件。',
    JSON.stringify(['提交答案', '入门']),
    '', 1, 1000, 128, 0, 1, 'output_only', '', now
  );

  // 写入测试数据
  writeTestcases(p1.lastInsertRowid, [
    { input: '1 2', output: '3' },
    { input: '-10 20', output: '10' },
    { input: '1000000000 1000000000', output: '2000000000' },
    { input: '-1000000000 -1000000000', output: '-2000000000' },
    { input: '0 0', output: '0' },
  ]);
  writeTestcases(p2.lastInsertRowid, [
    { input: '3', output: '3' },
    { input: '7', output: '7' },
    { input: '10', output: '10' },
  ]);
  writeTestcases(p3.lastInsertRowid, [
    { input: '', output: '1' },
    { input: '', output: '4' },
    { input: '', output: '9' },
    { input: '', output: '16' },
    { input: '', output: '25' },
  ]);
  // SPJ 题默认携带一个 testlib 风格 checker（校验输出 x 能被 n 整除）
  const spjChecker = `#include "testlib.h"\n#include <cstdlib>\nint main(int argc, char* argv[]) {\n  setName("divisible checker");\n  registerTestlibCmd(argc, argv);\n  long long n = inf.readLong();\n  long long x = ouf.readLong();\n  if (x <= 0 || x % n != 0) {\n    quitf(_wa, "expected a positive multiple of %lld, got %lld", n, x);\n  }\n  quitf(_ok, "ok: %lld is a multiple of %lld", x, n);\n}\n`;
  try {
    const dir = problemDir(p2.lastInsertRowid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(checkerPath(p2.lastInsertRowid), spjChecker);
  } catch { /* ignore */ }
}

/* ---------------- 通信题演示题（problem_type = 'communication'） ----------------
 * 任务：**程序一**读入 n 个整数，把它们**升序排序**后输出；**程序二**读入程序一输出的序列
 *（relay 模式下评测端原封不动把程序一的 stdout 作为程序二的 stdin），输出该序列的**最大子段和**。
 * 两人必须都正确才能通过：程序一不排序、程序二算错，都会判 WA。
 * 第 5 个测试点用**点级限额**（case_limits：时限 200ms / 内存 64MB）演示逐点限额同样作用于两个程序。
 */
function communicationDemoCases() {
  /** 升序排序后的最大子段和（Kadane）：与演示题程序二的正解一致 */
  const sortedKadane = (nums) => {
    const s = nums.slice().sort((a, b) => a - b);
    let best = s[0];
    let cur = s[0];
    for (let i = 1; i < s.length; i++) { cur = Math.max(s[i], cur + s[i]); best = Math.max(best, cur); }
    return best;
  };
  const fromNums = (nums, extra) => Object.assign({
    input: `${nums.length}\n${nums.join(' ')}`,
    output: String(sortedKadane(nums)),
  }, extra || {});
  const cases = [
    fromNums([5, -10, 6]),
    fromNums([-3, -1, -2, -7, -4, -9]),
    fromNums([3, -2, 5, -1, 4, -8, 2, 7]),
    fromNums([0, 7, -3, 7, -12, 4, 4, -1, 9, -9, 0, 5]),
  ];
  // 第 5 点：确定性 xorshift 生成的 2000 个数（数据较大，用来验证点级限额）。
  // 点级限额刻意与题目级（2000ms / 256MB）不同：时限 1000ms、内存 64MB。
  // 注意：不要把点级时限压到 200ms 这类过紧的值——Windows 上「创建进程 + 首次执行新 exe（杀软扫描）」
  // 在评测机繁忙时本身就要数百毫秒，过紧的点级时限会把正确程序误判成 TLE（实测 200ms 时程序一被误判）。
  const big = [];
  let x = 20261008 >>> 0;
  for (let i = 0; i < 2000; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    big.push((x % 2001) - 1000);
  }
  cases.push(fromNums(big, { time_limit_ms: 1000, memory_limit_mb: 64 }));
  return cases;
}

/* ---------------- 交互题演示题（仿洛谷） ----------------
 * 全新题库共内置 **6 道演示题**：seed() 里的 A+B（standard）、SPJ 测试题（standard + spj=1）、
 * 提交答案测试题（output_only），加上这里的 **2 道交互题**「IO 交互测试题（猜数字）」、
 * 「函数式交互测试题（不许偷看）」与 **1 道通信题**「通信题演示：两程序合作求最大子段和」
 * ——因此全新安装的题库里恰好是 6 道题。
 * 与 seed() 里的三道默认题不同，这段是**独立幂等**的：按 slug 判断是否已存在，
 * 因此老站点（题库已有题目）升级后也会自动补上这些演示题，重复执行不会重复插入；
 * 已存在的演示题会按 syncFiles 刷新随系统发布的交互器 / grader / 头文件 / 通信题开关。
 * 其中「交互 + SPJ 例题」标记 seedOnFresh: false：它是 v2.4.1 时代的演示题，
 * **已存在的站点照旧刷新其配套文件**，但全新安装不再创建它（保证内置题目数量稳定）。
 */
const INTERACTIVE_DEMOS = [
  {
    slug: 'interactive-io-demo',
    title: 'IO 交互测试题（猜数字）',
    problemType: 'interactive_io',
    syncFiles: true,
    difficulty: 2,
    tags: ['交互题', '二分', '入门'],
    description: [
      '# IO 交互测试题（猜数字）',
      '',
      '这是一道 **IO 交互题**：你的程序通过**标准输入输出**与评测机的「交互器」对话。',
      '',
      '交互器心里想了一个 $1 \\le x \\le 10^9$ 的整数，你的程序需要猜出它。',
      '',
      '每次你可以询问一个区间，交互器会告诉你 $x$ 是否落在该区间内；',
      '当你确定答案后输出 `! x` 即可。',
      '',
      '- 询问格式：`? l r`（$1 \\le l \\le r \\le 10^9$），表示询问 $l \\le x \\le r$ 是否成立；',
      '- 交互器的回答为 `yes` 或 `no`；',
      '- 输出 `! x` 表示你猜的答案是 $x$，随后程序应立即退出（退出码 0）。',
      '',
      '所有输入输出都需要**换行并刷新**，建议每次输出后 `fflush(stdout)`（C/C++ 中 `std::endl` 也会刷新）。',
      '数据保证 $x \\le 10^9$，使用 64 位整数更安全。',
    ].join('\n'),
    inputFormat: '本题没有传统意义上的输入：交互器会从测试数据文件读取 $x$，你的程序只能通过标准输入输出与它对话。',
    outputFormat: '见题目描述中的交互格式：询问输出 `? l r`，回答输出 `! x`。',
    samples: [{ input: '? 1 1000000000\nyes\n? 1 500000000\nno\n! 500000001', output: '（交互过程示例，实际由交互器逐行应答）' }],
    hint: '每次询问可以把候选区间折半：这就是二分查找（$\\lceil \\log_2 10^9 \\rceil = 30$ 次询问足够）。注意不要读写任何文件，也不要输出多余的调试信息。',
    interactiveHint: [
      '**交互方式**：本题通过标准输入输出与交互器通信，请**不要读写任何文件**。',
      '',
      '| 你的输出 | 交互器的回答 | 含义 |',
      '| --- | --- | --- |',
      '| `? l r` | `yes` / `no` | 询问 $x$ 是否满足 $l \\le x \\le r$ |',
      '| `! x` | （无） | 宣告答案为 $x$，随即结束 |',
      '',
      '询问次数上限 100 次；多余的输出（如调试信息）会被判为答案错误。每次输出后请刷新缓冲区。',
    ].join('\n'),
    // 测试数据：第一行是交互器要猜的数（同时作为答案文件，便于人工查看）
    // 注意**不要**用 1 作为测试点：那样「直接猜 1」也能通过，演示题要能区分正解与错解。
    cases: [
      { input: '1000000000', output: '1000000000' },
      { input: '500000000', output: '500000000' },
      { input: '999999999', output: '999999999' },
      { input: '123456789', output: '123456789' },
    ],
    files: {
      'interactor.cpp': [
        '// 交互器：argv[1] 为测试输入文件（第一行是待猜的整数 x），argv[2] 为 testlib 约定的输出文件（本题不用）。',
        '// 通过 stdout 向选手提问、从 stdin 读取选手回答；诊断信息一律写 stderr，保持 stdout 只有交互内容。',
        '// 退出码遵循 testlib 约定：0=_ok(AC) 1=_wa(WA) 2=_pe 3=_fail(判题失败) 4=_dirt 7=_points。',
        '#include <cstdio>',
        '#include <cstdlib>',
        '#include <string>',
        '#include <iostream>',
        '',
        'int main(int argc, char* argv[]) {',
        '  if (argc < 2) {',
        '    fprintf(stderr, "interactor: missing input file\\n");',
        '    return 3;',
        '  }',
        '  FILE* f = fopen(argv[1], "r");',
        '  if (!f) {',
        '    fprintf(stderr, "interactor: cannot open %s\\n", argv[1]);',
        '    return 3;',
        '  }',
        '  long long x = 0;',
        '  if (fscanf(f, "%lld", &x) != 1) {',
        '    fclose(f);',
        '    fprintf(stderr, "interactor: bad test data\\n");',
        '    return 3;',
        '  }',
        '  fclose(f);',
        '',
        '  const int MAXQ = 100;',
        '  int asked = 0;',
        '  for (;;) {',
        '    std::string op;',
        '    if (!(std::cin >> op)) {',
        '      fprintf(stderr, "interactor: contestant closed the pipe early\\n");',
        '      return 3;',
        '    }',
        '    if (op == "?") {',
        '      long long l = 0, r = 0;',
        '      if (!(std::cin >> l >> r)) {',
        '        fprintf(stderr, "interactor: malformed query\\n");',
        '        return 1;',
        '      }',
        '      if (++asked > MAXQ) {',
        '        fprintf(stderr, "too many queries: %d\\n", asked);',
        '        return 1;',
        '      }',
        '      if (l < 1 || r > 1000000000LL || l > r) {',
        '        fprintf(stderr, "query out of range: %lld %lld\\n", l, r);',
        '        return 1;',
        '      }',
        '      if (!(std::cout << ((l <= x && x <= r) ? "yes" : "no") << std::endl)) {',
        '        fprintf(stderr, "interactor: cannot write to contestant\\n");',
        '        return 3;',
        '      }',
        '    } else if (op == "!") {',
        '      long long y = -1;',
        '      if (!(std::cin >> y)) {',
        '        fprintf(stderr, "interactor: malformed answer\\n");',
        '        return 1;',
        '      }',
        '      if (y == x) {',
        '        fprintf(stderr, "ok, x = %lld, queries = %d\\n", x, asked);',
        '        return 0;',
        '      }',
        '      fprintf(stderr, "wrong answer: expected %lld, got %lld\\n", x, y);',
        '      return 1;',
        '    } else {',
        '      fprintf(stderr, "unknown command: %s\\n", op.c_str());',
        '      return 1;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    slug: 'interactive-func-demo',
    title: '函数式交互测试题（不许偷看）',
    problemType: 'interactive_func',
    syncFiles: true,
    difficulty: 3,
    tags: ['交互题', '函数式交互', '构造'],
    description: [
      '# 函数式交互测试题（不许偷看）',
      '',
      '这是一道 **函数式交互题**：评测时会把 grader 与你的代码**一起编译链接**成一个可执行文件运行。',
      '',
      'grader 会调用你实现的函数 `run(int n, long long k)`，你需要通过调用 grader 提供的接口来「问出」答案。',
      '',
      '- `long long ask(long long l, long long r)`：询问隐藏的 $x$ 是否满足 $l \\le x \\le r$，返回 $1$ / `0`；',
      '- `void answer(long long y)`：提交你的答案 $y$，调用后程序会立即结束（你的函数不必返回）。',
      '',
      '隐藏的 $x$ 满足 $1 \\le x \\le n$。你最多可以调用 `ask` `k` 次。',
    ].join('\n'),
    inputFormat: 'grader 从标准输入读取 $n$ 与 $k$，其余交互通过函数调用完成，**你不会直接看到输入**。',
    outputFormat: '由 grader 输出评测信息，你不需要向标准输出写任何内容。',
    samples: [{ input: '1000000000 30', output: 'OK: x = 500000000, ask = 30' }],
    hint: '二分答案：每次用 `ask` 把候选区间折半，$\\lceil \\log_2 n \\rceil$ 次就能确定 $x$。',
    interactiveHint: [
      '**需要的函数签名**（请在你的提交中**只实现函数，不要写 `main()`**）：',
      '',
      '```cpp',
      '#include "problem.h"   // 评测时会自动加上 -I，包含本头文件即可使用下列接口',
      '',
      'long long ask(long long l, long long r);  // 询问隐藏值 x 是否满足 l <= x <= r，返回 1/0',
      'void answer(long long y);                 // 提交答案 y，调用后程序立即结束',
      '',
      'void run(int n, long long k) {            // 你必须实现的函数',
      '    // ...',
      '}',
      '```',
      '',
      '评测命令等价于：`g++ -O2 -std=c++14 -I<数据目录> grader.cpp <你的代码> -o main`。',
      '因此**函数式交互题仅支持 C/C++ 提交**；提交时请勿自带 `main()`，也不要读写文件。',
      '你可以在自己的代码里 `#include "problem.h"` 使用上述接口（grader 也会包含它）。',
    ].join('\n'),
    // 答案留空：grader 的输出由隐藏值决定，评测时以 grader 退出码 0 判 AC
    // （若填了非空答案，则改为用 normalizeOutput 逐字节比对 grader 的 stdout）
    cases: [
      { input: '1000000000 30', output: '' },
      { input: '1000000000 30', output: '' },
      { input: '1000000000 30', output: '' },
    ],
    files: {
      'problem.h': [
        '// 函数式交互题的公共接口头文件：选手代码与 grader 都会包含它。',
        '#ifndef LCZOJ_PROBLEM_H',
        '#define LCZOJ_PROBLEM_H',
        '',
        '// 询问隐藏值 x 是否满足 l <= x <= r，是则返回 1，否则返回 0。',
        'long long ask(long long l, long long r);',
        '',
        '// 提交答案 y；调用后程序立即结束（不会返回）。',
        'void answer(long long y);',
        '',
        '// 选手需要实现的函数：n 为上界（1 <= x <= n），k 为 ask 的调用次数上限。',
        'void run(int n, long long k);',
        '',
        '#endif',
        '',
      ].join('\n'),
      'grader.cpp': [
        '// 函数式交互题的 grader（含 main()）：由 OJ 与选手提交一起编译链接后运行。',
        '#include "problem.h"',
        '#include <cstdio>',
        '#include <cstdlib>',
        '',
        'static long long g_x = 0;      // 隐藏答案',
        'static long long g_used = 0;   // 已使用的 ask 次数',
        'static long long g_limit = 0;  // ask 次数上限',
        'static bool g_answered = false;',
        '',
        'long long ask(long long l, long long r) {',
        '  if (g_answered) {',
        '    printf("FAIL: ask() called after answer()\\n");',
        '    exit(1);',
        '  }',
        '  if (l < 1 || r > 1000000000LL || l > r) {',
        '    printf("FAIL: invalid query [%lld, %lld]\\n", l, r);',
        '    exit(1);',
        '  }',
        '  if (++g_used > g_limit) {',
        '    printf("FAIL: too many ask() calls (limit %lld)\\n", g_limit);',
        '    exit(1);',
        '  }',
        '  return (l <= g_x && g_x <= r) ? 1 : 0;',
        '}',
        '',
        'void answer(long long y) {',
        '  g_answered = true;',
        '  if (y == g_x) {',
        '    printf("OK: x = %lld, ask = %lld\\n", g_x, g_used);',
        '    exit(0);',
        '  }',
        '  printf("WRONG: expected %lld, got %lld (ask = %lld)\\n", g_x, y, g_used);',
        '  exit(1);',
        '}',
        '',
        'int main() {',
        '  int n = 0;',
        '  long long k = 0;',
        '  if (scanf("%d %lld", &n, &k) != 2) {',
        '    printf("grader: bad input\\n");',
        '    return 1;',
        '  }',
        '  g_x = (1 + (long long)n) / 2;   // 隐藏值取区间中点：二分做法一定能问到',
        '  g_limit = k;',
        '  run(n, k);',
        '  printf("FAIL: run() returned without calling answer()\\n");',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    slug: 'interactive-spj-demo',
    title: '交互 + SPJ 例题（猜数字）',
    problemType: 'interactive_io',
    spj: 1,
    syncFiles: true,
    // 不参与「全新安装的 5 道内置题」：只对已有该题的老站点做文件同步（见上方注释）
    seedOnFresh: false,
    difficulty: 3,
    tags: ['交互题', 'Special Judge', '二分'],
    description: [
      '# 交互 + SPJ 例题（猜数字）',
      '',
      '这是一道 **IO 交互题 + Special Judge** 的例题：交互过程由交互器负责，',
      '最终答案的判定**交给 checker**（而不是看交互器的退出码）。',
      '',
      '交互器心里想了一个 $1 \\le x \\le 10^9$ 的整数：',
      '',
      '- 询问格式：`? l r`，交互器回答 `yes` / `no`，表示 $l \\le x \\le r$ 是否成立；',
      '- 确定答案后输出 `! y`，表示你的答案是 $y$；',
      '- 交互器会把你的答案 $y$ **写入评测机指定的输出文件**（即它收到的第二个命令行参数），',
      '  随后由 checker 比较 $y$ 与测试数据中的 $x$：相等判 AC，否则判 WA。',
      '',
      '因此即使交互器的退出码表示「交互正常结束」，答案是否正确仍由 checker 决定。',
    ].join('\n'),
    inputFormat: '本题没有传统意义上的输入：交互器会从测试数据文件读取 $x$，你的程序只能通过标准输入输出与它对话。',
    outputFormat: '询问输出 `? l r`，回答输出 `! y`。',
    samples: [{ input: '? 1 1000000000\nyes\n? 1 500000000\nno\n! 500000001', output: '（交互过程示例，最终由 checker 判定答案是否正确）' }],
    hint: '二分查找：每次询问把候选区间折半，30 次询问足够。注意不要读写文件，也不要输出多余的调试信息。',
    interactiveHint: [
      '**交互方式**：本题通过标准输入输出与交互器通信，请**不要读写任何文件**。',
      '',
      '| 你的输出 | 交互器的回答 | 含义 |',
      '| --- | --- | --- |',
      '| `? l r` | `yes` / `no` | 询问 $x$ 是否满足 $l \\le x \\le r$ |',
      '| `! y` | （无） | 宣告答案为 $y$，随即结束 |',
      '',
      '本题**同时使用交互器与 Special Judge**：交互器负责问答并把你的答案写进评测机的输出文件，',
      'checker 负责比较该答案与标准答案。询问次数上限 100 次；每次输出后请刷新缓冲区。',
    ].join('\n'),
    cases: [
      { input: '987654321', output: '987654321' },
      { input: '1000000000', output: '1000000000' },
    ],
    files: {
      'interactor.cpp': [
        '// 交互 + SPJ 例题的交互器：argv[1] = 测试输入文件（第一行是隐藏数 x），argv[2] = 交互器输出文件（把选手答案写进去）。',
        '// 通过 stdout 向选手提问、从 stdin 读回答；退出码仍按 testlib 约定（0 交互正常结束）。',
        '#include <cstdio>',
        '#include <cstdlib>',
        '#include <string>',
        '#include <iostream>',
        '',
        'int main(int argc, char* argv[]) {',
        '  if (argc < 3) {',
        '    fprintf(stderr, "interactor: usage: interactor <input-file> <output-file>\\n");',
        '    return 3;',
        '  }',
        '  FILE* f = fopen(argv[1], "r");',
        '  if (!f) { fprintf(stderr, "interactor: cannot open %s\\n", argv[1]); return 3; }',
        '  long long x = 0;',
        '  if (fscanf(f, "%lld", &x) != 1) { fclose(f); fprintf(stderr, "interactor: bad test data\\n"); return 3; }',
        '  fclose(f);',
        '',
        '  const int MAXQ = 100;',
        '  int asked = 0;',
        '  for (;;) {',
        '    std::string op;',
        '    if (!(std::cin >> op)) { fprintf(stderr, "interactor: contestant closed the pipe early\\n"); return 3; }',
        '    if (op == "?") {',
        '      long long l = 0, r = 0;',
        '      if (!(std::cin >> l >> r)) { fprintf(stderr, "interactor: malformed query\\n"); return 1; }',
        '      if (++asked > MAXQ) { fprintf(stderr, "too many queries: %d\\n", asked); return 1; }',
        '      if (l < 1 || r > 1000000000LL || l > r) { fprintf(stderr, "query out of range: %lld %lld\\n", l, r); return 1; }',
        '      if (!(std::cout << ((l <= x && x <= r) ? "yes" : "no") << std::endl)) {',
        '        fprintf(stderr, "interactor: cannot write to contestant\\n"); return 3;',
        '      }',
        '    } else if (op == "!") {',
        '      long long y = -1;',
        '      if (!(std::cin >> y)) { fprintf(stderr, "interactor: malformed answer\\n"); return 1; }',
        '      // 关键：把选手答案写进 argv[2] 指定的文件，交给后面的 checker 判定',
        '      FILE* g = fopen(argv[2], "w");',
        '      if (!g) { fprintf(stderr, "interactor: cannot write %s\\n", argv[2]); return 3; }',
        '      fprintf(g, "%lld\\n", y);',
        '      fclose(g);',
        '      fprintf(stderr, "answer written: %lld (queries = %d)\\n", y, asked);',
        '      return 0;',
        '    } else {',
        '      fprintf(stderr, "unknown command: %s\\n", op.c_str());',
        '      return 1;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'checker.cpp': [
        '// testlib 风格 checker：参数顺序 in / ouf / ans（与仓库既有 SPJ 一致）。',
        '// in  = 测试输入（含隐藏数 x）；ouf = 交互器写出的选手答案 y；ans = 标准答案文件。',
        '#include "testlib.h"',
        '',
        'int main(int argc, char* argv[]) {',
        '  registerTestlibCmd(argc, argv);',
        '  long long x = inf.readLong();',
        '  long long y = ouf.readLong();',
        '  if (y == x) {',
        '    quitf(_ok, "答案正确：y = %lld 与隐藏值一致", y);',
        '  }',
        '  quitf(_wa, "答案错误：期望 %lld，实际 %lld", x, y);',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    // 通信题演示题（第三种题型，与 IO 交互 / 函数式交互彼此独立）：
    // 两个选手程序合作完成任务，题目侧只放 N.in / N.out（可选 grader.cpp 中转、checker.cpp SPJ）。
    slug: 'communication-demo',
    title: '通信题演示：两程序合作求最大子段和',
    problemType: 'communication',
    syncFiles: true,
    difficulty: 2,
    tags: ['通信题', '排序', '最大子段和', '入门'],
    description: [
      '# 通信题演示：两程序合作求最大子段和',
      '',
      '这是一道 **通信题（communication）**：你需要提交**两个程序**，它们合作完成一个任务。',
      '',
      '- **程序一**：读入一个整数 $n$ 与 $n$ 个整数 $a_1, a_2, \\dots, a_n$，把这 $n$ 个数**按升序排序**后输出；',
      '- **程序二**：读入**程序一的输出**（也就是排好序的这 $n$ 个数），输出它们的**最大子段和**。',
      '',
      '也就是说，最终的答案由两个程序**接力**得到：程序一负责「整理数据」，程序二负责「计算答案」。',
      '任何一个程序出错，答案都会错。',
      '',
      '## 输入输出约定',
      '',
      '评测端按题目配置的**连接方式**把两个程序串起来（本题默认 `relay`：评测端先把题目输入喂给程序一，',
      '收下程序一的输出，原封不动作为程序二的输入，再拿程序二的输出去比对标准答案）。',
      '',
      '程序一的 stdin 是题目输入（第一行 $n$，第二行 $n$ 个整数），stdout 输出排序后的 $n$ 个整数（空格分隔，允许换行）。',
      '程序二的 stdin 是程序一的 stdout，stdout 输出一个整数，即排序后序列的最大子段和。',
      '',
      '## 什么是最大子段和',
      '',
      '最大子段和指：在序列中选出一段**连续**的区间，使其元素之和最大（区间不能为空）。',
      '例如排序后得到 $-10\\ 5\\ 6$，最大子段和是 $5 + 6 = 11$。',
      '',
      '## 注意',
      '',
      '- 两个程序**都会**受到本题时限 / 内存限制（本题第 5 个测试点单独压到 200ms / 64MB）；',
      '- 程序一的输出长度有上限（本题 64KB）：多余的调试输出会被判为**答案错误（通信量超限）**；',
      '- 两个程序都只用标准输入输出，**不要读写任何文件**，也不要输出多余的提示信息。',
    ].join('\n'),
    inputFormat: [
      '第一行一个整数 $n$（$1 \\le n \\le 2000$）。',
      '',
      '第二行 $n$ 个整数 $a_i$（$|a_i| \\le 1000$），用空格分隔。',
      '',
      '评测端只把这份输入交给**程序一**；程序二拿到的是程序一的输出。',
    ].join('\n'),
    outputFormat: [
      '**程序一**输出排序后的 $n$ 个整数（空格分隔即可）。',
      '',
      '**程序二**输出一个整数：排序后序列的最大子段和。',
    ].join('\n'),
    samples: [
      { input: '3\n5 -10 6', output: '程序一输出：-10 5 6\n程序二输出：11' },
      { input: '6\n-3 -1 -2 -7 -4 -9', output: '程序一输出：-9 -7 -4 -3 -2 -1\n程序二输出：-1' },
    ],
    hint: '程序一直接排序后输出即可；程序二用 Kadane（$O(n)$ 扫一遍：$cur = \\max(a_i, cur + a_i)$）求最大子段和。注意两个程序都要自己读入：程序二读到的是程序一的输出。',
    interactiveHint: [
      '**这是一道通信题：提交时需要填写两个程序。**',
      '',
      '| 程序 | 读入（stdin） | 输出（stdout） |',
      '| --- | --- | --- |',
      '| 程序一 | 题目输入：$n$ 与 $n$ 个整数 | 升序排序后的 $n$ 个整数 |',
      '| 程序二 | **程序一的输出** | 一个整数：最大子段和 |',
      '',
      '评测端连接方式（题目侧配置）：**relay（评测端中转，默认）** —— 先用题目输入跑程序一，收下它的输出，',
      '原封不动作为程序二的输入；若题目提供了 `grader.cpp`（评测端中转程序），则由它把程序一的输出处理成程序二的输入。',
      '另一种是 **direct（双向管道直连）** —— 程序一的 stdout 直接接到程序二的 stdin，两者并行运行、边跑边传。',
      '',
      '时限 / 内存**分别作用于两个程序**；程序一的输出还有字节数上限（通信量限制），超限判答案错误。',
      '本地测试可以用「程序一 > tmp; 程序二 < tmp」手工串起来，也可以写脚本把两者用管道对接（见使用说明「通信题」一节）。',
    ].join('\n'),
    cases: communicationDemoCases(),
    // 题目侧开关（写进 data/testdata/<题号>/meta.json）：
    //   relay = 评测端中转（默认）；prog1_output_limit_bytes = 程序一输出（通信量）上限 64KB
    meta: { pipe_mode: 'relay', prog1_output_limit_bytes: 65536 },
    files: {},
  },
];

/** 幂等补齐交互题演示题（IO 交互 / 函数式交互；交互 + SPJ 例题只刷新不新建） */
function seedInteractiveDemos() {
  const insert = db.prepare(`
    INSERT INTO problems (slug, title, description, input_format, output_format, samples, hint, tags, source, difficulty, time_limit_ms, memory_limit_mb, show_score, is_public, spj, output_only, problem_type, interactive_hint, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?, ?, ?, ?)
  `);
  // created_by 有外键约束（REFERENCES users(id)）：取一个已存在的用户，取不到就置 NULL
  const owner = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const ownerId = owner ? owner.id : null;
  const now = Date.now();
  let created = 0;
  let refreshed = 0;
  for (const d of INTERACTIVE_DEMOS) {
    const existing = db.prepare('SELECT id FROM problems WHERE slug = ?').get(d.slug);
    if (existing) {
      // 已存在：演示题的文件随系统一起发布（syncFiles），跟着版本刷新，
      // 这样升级后演示题的交互器 / grader / 头文件也能拿到最新版本；重复执行结果一致。
      if (d.syncFiles) {
        try {
          const dir = problemDir(existing.id);
          fs.mkdirSync(dir, { recursive: true });
          // 演示题的测试数据也随版本同步：只有内容确实不同才重写（避免每次启动都做无谓的磁盘写入）
          const want = (d.cases || []).map((c, i) => ({ n: i + 1, input: String(c.input ?? ''), output: String(c.output ?? '') }));
          let need = want.length !== testcaseCount(existing.id);
          if (!need) {
            for (const c of want) {
              let cur = '';
              try { cur = fs.readFileSync(path.join(dir, `${c.n}.in`), 'utf8'); } catch { cur = '\u0000'; }
              if (cur !== c.input) { need = true; break; }
            }
          }
          if (need) writeTestcases(existing.id, d.cases, d.meta || {});
          for (const [name, content] of Object.entries(d.files || {})) {
            fs.writeFileSync(path.join(dir, name), content);
          }
          refreshed++;
        } catch (e) {
          console.warn(`[db] 刷新演示题文件失败（${d.slug}）：${e && e.message}`);
        }
      }
      continue;
    }
    // 仅用于老站点的演示题（seedOnFresh: false）：全新题库不创建，保证内置题目数量稳定
    if (d.seedOnFresh === false) continue;
    const info = insert.run(
      d.slug, d.title, d.description, d.inputFormat, d.outputFormat,
      JSON.stringify(d.samples || []), d.hint || '', JSON.stringify(d.tags || []), '',
      d.difficulty, 2000, 256, d.spj ? 1 : 0, d.problemType, d.interactiveHint || '', ownerId, now
    );
    const pid = Number(info.lastInsertRowid);
    // meta 随演示题一起发布：通信题的连接方式 / 通信量上限就在 meta.json 里（见 readCommunicationConfig）
    writeTestcases(pid, d.cases, d.meta || {});
    // 写入交互器 / grader / 头文件（writeTestcases 之后写，避免被目录清空影响）
    for (const [name, content] of Object.entries(d.files || {})) {
      try {
        fs.mkdirSync(problemDir(pid), { recursive: true });
        fs.writeFileSync(path.join(problemDir(pid), name), content);
      } catch (e) {
        console.warn(`[db] 写入演示题配套文件失败（${d.slug}/${name}）：${e && e.message}`);
      }
    }
    created++;
    console.log(`[db] 已创建演示题 #${pid}「${d.title}」（${d.problemType}${d.meta && d.meta.pipe_mode ? '，pipe_mode=' + d.meta.pipe_mode : ''}）`);
  }
  if (refreshed) console.log(`[db] 已同步 ${refreshed} 道演示题的配套文件 / 测试数据 / 通信题开关`);
  return created;
}

/* 顺序很重要：**先 seed() 再 seedInteractiveDemos()**。
 * seed() 在「题库为空」时写入 3 道默认题（A+B / SPJ / 提交答案）并创建内置 admin；
 * 随后 seedInteractiveDemos() 才按 slug 幂等补齐 2 道交互题 + 1 道通信题演示题 —— 全新题库因此恰好得到 6 道内置题，
 * 且演示题的 created_by 能正确指向刚建好的 admin（此前反过来的顺序会让
 * seedInteractiveDemos() 先把题插进空库，导致 seed() 因「题库非空」而跳过那 3 道默认题）。 */
seed();

try { seedInteractiveDemos(); } catch (e) { console.warn('[db] 创建交互题演示题失败：' + (e && e.message)); }

// M17：初始密码文件若还在（尚未改过口令），启动时把权限收紧到 0600
try { hardenAdminPasswordFile(); } catch { /* ignore */ }

/* 历史头像迁移：users.avatar 里遗留的 data URL（最大 512KB）转存为 data/avatars/<uid>.<ext>，
 * 数据库只保留短 URL，避免 /api/me、排行榜、私信等接口把整段 base64 一起返回。幂等，可重复执行。 */
try {
  const moved = require('./avatars').migrateDataUrls(db);
  if (moved) console.log(`[db] 已把 ${moved} 个历史头像迁移到 data/avatars/`);
} catch (e) {
  console.warn('[db] 头像迁移失败：' + e.message);
}

/* 默认头像补齐：还没有设置头像的用户，按用户名生成 GitHub 风格的像素画头像（幂等，可重复执行）。 */
try {
  const filled = require('./avatars').backfillIdenticons(db);
  if (filled) console.log(`[db] 已为 ${filled} 个没有头像的用户生成像素头像`);
} catch (e) {
  console.warn('[db] 生成默认头像失败：' + e.message);
}

/** 返回指定内容表中「最小的可用编号」（从 1 开始找第一个未被占用的整数）。
 *  配合非 AUTOINCREMENT 主键实现「删除后编号释放、新内容复用」。 */
function nextFreeId(table) {
  const rows = db.prepare(`SELECT id FROM ${table} ORDER BY id ASC`).all();
  let n = 1;
  for (const r of rows) {
    if (r.id === n) n++;
    else if (r.id > n) break;
  }
  return n;
}

module.exports = {
  db,
  getAdminInitInfo,
  nextFreeId,
  passwordPolicyError,
  PASSWORD_MIN_LENGTH,
  WEAK_PASSWORDS,
  generateAdminPassword,
  // M17：初始密码文件的生命周期
  ADMIN_PASSWORD_FILE,
  removeAdminPasswordFile,
  hardenAdminPasswordFile,
  // v2.5.0：内置管理员口令变更审计（唯一写入入口，auth.js / users.js 共用）
  auditAdminPasswordChange,
  readAdminAudit,
  shouldRestoreDataFile,
  normalizeCaseLimit,
  CASE_TIME_LIMIT_MIN,
  CASE_TIME_LIMIT_MAX,
  CASE_MEMORY_LIMIT_MIN,
  CASE_MEMORY_LIMIT_MAX,
  writeTestcases,
  readTestcases,
  readCaseLimits,
  readSubtaskScores,
  readSubtaskTypes,
  testcaseCount,
  // 通信题（problem_type = 'communication'）：连接方式 / 通信量上限 / duplex 都在 meta.json 里
  readCommunicationConfig,
  normalizePipeMode,
  mergeCommunicationMeta,
  COMM_PIPE_MODES,
  COMM_META_KEYS,
  problemDir,
  checkerPath,
  interactorPath,
  graderPath,
  interactiveHeaderPath,
  listInteractiveHeaders,
  writeInteractiveAssets,
  isValidInteractiveHeaderName,
  snapshotDataFiles,
  restoreDataFiles,
};
