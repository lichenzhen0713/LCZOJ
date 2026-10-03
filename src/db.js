'use strict';

const fs = require('fs');
const path = require('path');
const { DB_PATH, TESTDATA_DIR, ensureDirs } = require('./config');
const { hashPassword } = require('./password');

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
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('footer_text', 'Copyright © 2024 LCZOJ · 仅供学习交流使用')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('help_content', '## 帮助中心\n\n### 使用说明\n\n完整的**功能使用说明**（普通用户与管理员，含题目数据配置 / 子任务计分 / ZIP 覆盖合并 / 大数据包 / SPJ / 提交答案题等）见：\n\n- 📖 [LCZOJ 功能使用说明](/docs/USAGE.md)（新标签页打开）\n\n### 如何提交代码\n\n1. 在题库中选择题目，阅读题面后点击「提交评测」；\n2. 选择语言并粘贴代码，点击提交；\n3. 稍候刷新即可看到评测结果。\n\n### 如何参加比赛\n\n- 在「比赛」页选择比赛并报名（需报名制）；\n- 比赛进行中可在比赛界面查看题目并提交；\n- OI 赛制比赛中不公布成绩，结束后公布。\n\n### 积分与等级分\n\n- 积分四维非线性增长：刷题、比赛、社区贡献、打卡；\n- 等级分在 Rated 比赛结束后由管理员手动结算。\n\n### 遇到问题\n\n- 查看[使用说明](/docs/USAGE.md)或通过「联系我们」页面获取帮助。')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('agreement_content', '## 用户协议\n\n欢迎使用本在线评测系统。\n\n1. **合法使用**：不得利用本系统从事任何违法违规活动；\n2. **代码原创**：提交的题解应为本人原创，抄袭将受到棕名等处罚；\n3. **尊重他人**：讨论区发言请保持友善，禁止人身攻击与刷屏；\n4. **账号安全**：请妥善保管账号密码，因个人原因造成的损失由本人承担；\n5. **内容管理**：管理员有权对违规内容进行删除、封禁等处理。\n\n继续使用本系统即表示你同意以上条款。')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('contact_content', '## 联系我们\n\n如有问题或建议，欢迎通过以下方式联系我们：\n\n- **邮箱**：admin@example.com\n- **GitHub**：https://github.com/your-org/your-oj\n- **QQ 群**：123456789\n\n我们会在 1-3 个工作日内回复。')").run();
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
  created_at INTEGER NOT NULL,
  handled_at INTEGER
)`);

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

function metaPath(dir) { return path.join(dir, 'meta.json'); }

/**
 * 写入题目的测试数据。
 * cases: [{input, output, subtask}]
 * meta: {
 *   subtask_scores: [number],           —— 每个子任务的满分（子任务按出现顺序编号）
 *   subtask_types:  ['sum'|'min'|'max'|'bundle'] —— 每个子任务的计分方式（缺省 bundle）
 * }
 * 计分方式：sum=加和（各测试点均分累加）、min=取最小、max=取最大、bundle=捆绑（全对才得分）
 */
function writeTestcases(problemId, cases, meta) {
  const dir = problemDir(problemId);
  // 备份 checker.cpp：writeTestcases 会清空整个测试数据目录，须在清空前把已有 checker 暂存，
  // 写入新测试数据后恢复，避免「保存测试数据」/「上传 ZIP」把 Special Judge 的 checker 弄没。
  let oldChecker = '';
  const ck = checkerPath(problemId);
  if (fs.existsSync(ck)) {
    try { oldChecker = fs.readFileSync(ck, 'utf8'); } catch { /* ignore */ }
  }
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
  fs.writeFileSync(metaPath(dir), JSON.stringify({ subtask_of_case: subtaskOfCase, subtask_scores: scores, subtask_types: types }));
  // 恢复之前备份的 checker.cpp（若存在）
  if (oldChecker) {
    try { fs.writeFileSync(ck, oldChecker); } catch { /* ignore */ }
  }
  return { count: cases.length, subtasks: scores, types };
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
  // 子任务编号 0-based（默认题目只有一个子任务 0）
  return nums.map((n, i) => ({
    id: n,
    input: fs.readFileSync(path.join(dir, `${n}.in`), 'utf8'),
    output: fs.readFileSync(path.join(dir, `${n}.out`), 'utf8'),
    subtask: subtaskOfCase[i] != null ? subtaskOfCase[i] : 0,
  })).map((c) => ({ ...c, subtask_score: subtaskScores[c.subtask] != null ? subtaskScores[c.subtask] : 0 }));
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
    db.prepare(
      "INSERT INTO users (username, email, password_hash, is_admin, role, permissions, bio, created_at) VALUES (?, ?, ?, 1, 'superadmin', ?, ?, ?)"
    ).run('admin', 'cz20090521@126.com', hashPassword('admin123'), 'problem,user,editorial_review,article_review,contest,discussion,article,editorial', '系统管理员', Date.now());
  } else {
    // 若 admin 已存在但邮箱仍为早期默认值，则更新为用户指定的邮箱（幂等）
    const adm = db.prepare("SELECT id, email FROM users WHERE username = 'admin'").get();
    if (adm && (!adm.email || adm.email === 'admin@oj.local')) {
      db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run('cz20090521@126.com', adm.id);
    }
  }

  const problemCount = db.prepare('SELECT COUNT(*) AS c FROM problems').get().c;
  if (problemCount > 0) return;

  const insert = db.prepare(`
    INSERT INTO problems (slug, title, description, input_format, output_format, samples, hint, tags, source, difficulty, time_limit_ms, memory_limit_mb, show_score, is_public, spj, output_only, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1, ?)
  `);

  const now = Date.now();

  // 三道默认题：普通评测 A+B、Special Judge、提交答案题
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
    '', 1, 1000, 128, 0, 0, now
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
    '', 2, 1000, 128, 1, 0, now
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
    '', 1, 1000, 128, 0, 1, now
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

seed();

/* 历史头像迁移：users.avatar 里遗留的 data URL（最大 512KB）转存为 data/avatars/<uid>.<ext>，
 * 数据库只保留短 URL，避免 /api/me、排行榜、私信等接口把整段 base64 一起返回。幂等，可重复执行。 */
try {
  const moved = require('./avatars').migrateDataUrls(db);
  if (moved) console.log(`[db] 已把 ${moved} 个历史头像迁移到 data/avatars/`);
} catch (e) {
  console.warn('[db] 头像迁移失败：' + e.message);
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
  nextFreeId,
  writeTestcases,
  readTestcases,
  readSubtaskScores,
  readSubtaskTypes,
  testcaseCount,
  problemDir,
  checkerPath,
};
