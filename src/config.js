'use strict';

const path = require('path');
const fs = require('fs');

const BASE_DIR = path.join(__dirname, '..');
// 数据目录可通过环境变量 OJ_DATA_DIR 覆盖（相对路径基于项目根目录），便于隔离旧数据
const DATA_DIR = process.env.OJ_DATA_DIR ? path.resolve(BASE_DIR, process.env.OJ_DATA_DIR) : path.join(BASE_DIR, 'data');
const JUDGE_DIR = path.join(DATA_DIR, 'judge');
const TESTDATA_DIR = path.join(DATA_DIR, 'testdata');
const DB_PATH = path.join(DATA_DIR, 'oj.db');
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const DOCS_DIR = path.join(BASE_DIR, 'docs');

// 默认端口 80（部署即访问 http://服务器IP，无需端口号；无权限时可用 PORT=8080 覆盖）
const PORT = parseInt(process.env.PORT || '80', 10);

// 监听地址：默认监听全部网卡（0.0.0.0），面板 / 容器可直接访问。
// 用宝塔、小皮等面板的 Nginx 反向代理时，建议设 OJ_HOST=127.0.0.1，只允许本机连接。
const HOST = process.env.OJ_HOST || '0.0.0.0';

// 判题默认限制（题目可覆盖）
const DEFAULTS = {
  timeLimitMs: 1000,      // 默认时间限制 1s
  memoryLimitMb: 256,     // 默认内存限制 256MB
  outputLimitBytes: 16 * 1024 * 1024, // 单测试点输出上限 16MB
  judgeTimeoutMs: 30 * 1000, // 判题整体兜底超时（S2：judge.js 用它给单次判题加总兜底）
  // 并行判题数：默认按 CPU 核数自适应（2~4，可用系统设置「评测性能」调整，或用环境变量 OJ_MAX_JUDGES 覆盖）
  maxConcurrentJudges: Math.max(1, Math.min(16, parseInt(process.env.OJ_MAX_JUDGES, 10)
    || Math.max(2, Math.min(4, (require('node:os').cpus() || []).length - 1)))),
  sessionTtlDays: 14,     // 会话有效期
};

/* ---------------- 内存采样（M7/M8：让「内存」真的采得到） ----------------
 * 采样分三层，全部只影响 memory_kb / memory_sampled，**任何一层失败都不改变判定结果**：
 *   1) 预热：提交一进入判题就在后台把采样器启动/自检好（准备目录 + 编译要 2~5 秒，
 *      足够 PowerShell 冷启动）；每个测试点开始前还会再试一次，池就绪后本提交剩余测试点
 *      与后续提交都能用；
 *   2) 主采样器：Windows 常驻 PowerShell 采样器（src/memsampler.ps1），池化复用 + 后台保活，
 *      能拿到进程的 PeakWorkingSet64（进程退出后仍可读，短命进程也不会漏）；
 *   3) 兜底：**不依赖 PowerShell** 的常驻 cscript + WMI 采样器（协议与 memsampler.ps1 一致，
 *      一个常驻进程覆盖所有 pid，不为每个采样点 spawn 进程）。tasklist / wmic 在本机实测不可用
 *      （tasklist 单次 1.2~4.8 秒、wmic 已从系统移除），故不采用。
 * 所有数字都可用环境变量覆盖，便于在别的机器上重新调参。 */
function envInt(name, def, min, max) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}
const MEM_SAMPLER = {
  /** 借采样器时评测线程最多等多久（预热后通常直接命中池，不必等） */
  acquireBudgetMs: envInt('OJ_MEMSAMPLER_ACQUIRE_MS', 800, 0, 10000),
  /** 单个测试点开始前「再试一次借采样器」的等待上限（毫秒；0 = 只看池里有没有现成的，绝不空等） */
  caseAcquireMs: envInt('OJ_MEMSAMPLER_CASE_ACQUIRE_MS', 400, 0, 5000),
  /** 提交一进入判题就预热的采样器个数（并发判题时每个槽各一个） */
  prewarmCount: envInt('OJ_MEMSAMPLER_PREWARM', 2, 0, 8),
  /** 后台自检第一段等待：正常负载下几百毫秒就有应答 */
  selfCheckFastMs: envInt('OJ_MEMSAMPLER_SELFCHECK_MS', 3000, 200, 60000),
  /** 后台自检第二段等待：覆盖满载时 10~15 秒的 PowerShell 冷启动 */
  selfCheckWarmMs: envInt('OJ_MEMSAMPLER_WARM_MS', 20000, 1000, 120000),
  /** 自检失败后的退避：这段时间内不再反复起 PowerShell（避免每个提交都白等一轮） */
  failBackoffMs: envInt('OJ_MEMSAMPLER_BACKOFF_MS', 20000, 0, 600000),
  /** 常驻采样器空闲多久自我退出（毫秒）：太短会在两次提交之间死掉（而这里的 PowerShell 冷启动要 10~20 秒，
   *  池一空就必然有一段「采不到」的空窗），太长会常驻占内存 */
  idleMs: envInt('OJ_MEMSAMPLER_IDLE_MS', 180000, 5000, 3600000),
  /** 池空时后台保活预热的间隔（毫秒；0 = 关闭保活） */
  keepWarmMs: envInt('OJ_MEMSAMPLER_KEEPWARM_MS', 30000, 0, 600000),
  /** 是否启用「不依赖 PowerShell」的兜底采样（Windows only；1=启用，0=关闭） */
  fallbackEnabled: envInt('OJ_MEMSAMPLER_FALLBACK', 1, 0, 1) === 1,
  /** 兜底通道取值的等待上限（毫秒）：单次取值最多等这么久，绝不拖慢判定 */
  fallbackWaitMs: envInt('OJ_MEMSAMPLER_FALLBACK_WAIT_MS', 250, 0, 5000),
  /** 进程已退出后，再等兜底采样落地的一次性时间（毫秒） */
  fallbackSettleMs: envInt('OJ_MEMSAMPLER_FALLBACK_SETTLE_MS', 400, 0, 5000),
};

/* ---------------- 判题降权（H1） ----------------
 * POSIX：选手程序（以及「grader + 选手源码」链接后的可执行文件）以低权限账户运行，
 *   从而读不到 data/oj.db、data/testdata（隐藏测试数据）与评测私有目录 .priv。
 *   账户用 OJ_JUDGE_USER（用户名，默认 nobody，装脚本会创建 lczoj-judge）或 OJ_JUDGE_UID/OJ_JUDGE_GID 指定；
 *   解析失败或无权降权时**自动回退为当前行为**并打印警告，绝不因此让判题失败。
 * Windows：Node 无法直接创建受限令牌/Job Object，保持同账户运行（隔离只到「目录与路径」层面），
 *   生产环境请用 Docker/Linux 部署以获得真正的降权隔离。
 */
function resolveJudgeUser() {
  const out = { uid: null, gid: null, name: '', why: '' };
  if (process.platform === 'win32') { out.why = 'Windows 不支持 spawn 降权'; return out; }
  // 只有 root 才能 setuid 到别的账户：容器里服务以 node(1000) 运行时强行降权会让每次 spawn 都 EPERM，
  // 因此这里先判权限，拿不到就回退（由容器自身提供隔离）。
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    out.why = `服务以非 root 运行（uid=${process.getuid()}），无法降权到 ${process.env.OJ_JUDGE_USER || 'nobody'}（容器内请依赖容器隔离）`;
    return out;
  }
  const explicitUid = parseInt(process.env.OJ_JUDGE_UID, 10);
  const explicitGid = parseInt(process.env.OJ_JUDGE_GID, 10);
  const name = (process.env.OJ_JUDGE_USER || 'nobody').trim();
  if (Number.isFinite(explicitUid)) { out.uid = explicitUid; out.gid = Number.isFinite(explicitGid) ? explicitGid : explicitUid; out.name = name || String(explicitUid); return out; }
  try {
    const { execFileSync } = require('node:child_process');
    const line = String(execFileSync('id', ['-u', name], { encoding: 'utf8', timeout: 5000 })).trim();
    const uid = parseInt(line, 10);
    if (!Number.isFinite(uid)) { out.why = `无法解析用户 ${name} 的 uid`; return out; }
    let gid = uid;
    try { gid = parseInt(String(execFileSync('id', ['-g', name], { encoding: 'utf8', timeout: 5000 })).trim(), 10) || uid; } catch { /* ignore */ }
    out.uid = uid; out.gid = gid; out.name = name;
  } catch (e) {
    out.why = `未找到低权限账户 ${name}（${e && e.message ? e.message : e}）`;
  }
  return out;
}
const JUDGE_USER = resolveJudgeUser();

// 语言定义。compiled=true 表示需要先编译。
// run / compile 中的 {tool} {src} {exe} {dir} {runTool} 会被替换为实际路径。
const LANGUAGES = {
  python: {
    key: 'python',
    name: 'Python 3',
    ext: 'py',
    compiled: false,
    compile: null,
    run: '{tool} {src}',
    highlight: 'python',
    toolName: 'python',
  },
  javascript: {
    key: 'javascript',
    name: 'JavaScript (Node.js)',
    ext: 'js',
    compiled: false,
    compile: null,
    run: '{tool} {src}',
    highlight: 'javascript',
    toolName: 'node',
  },
  cpp: {
    key: 'cpp',
    name: 'C++ 14 (G++)',
    ext: 'cpp',
    compiled: true,
    compile: '{tool} {src} -o {exe} -O2 -std=c++14 -static',
    run: '{exe}',
    highlight: 'cpp',
    toolName: 'g++',
  },
  cpp11: {
    key: 'cpp11',
    name: 'C++ 11 (G++)',
    ext: 'cpp',
    compiled: true,
    compile: '{tool} {src} -o {exe} -O2 -std=c++11 -static',
    run: '{exe}',
    highlight: 'cpp',
    toolName: 'g++',
  },
  cpp98: {
    key: 'cpp98',
    name: 'C++ 98 (G++)',
    ext: 'cpp',
    compiled: true,
    compile: '{tool} {src} -o {exe} -O2 -std=c++98 -static',
    run: '{exe}',
    highlight: 'cpp',
    toolName: 'g++',
  },
  c: {
    key: 'c',
    name: 'C 11 (GCC)',
    ext: 'c',
    compiled: true,
    compile: '{tool} {src} -o {exe} -O2 -std=c11 -lm -static',
    run: '{exe}',
    highlight: 'c',
    toolName: 'gcc',
  },
  java: {
    key: 'java',
    name: 'Java 21',
    ext: 'java',
    compiled: true,
    // 公共类名与文件名必须一致：源文件固定命名为 Main.java（见 judge.js srcName）
    srcName: 'Main',
    compile: '{tool} -encoding UTF-8 {src}',
    // -Dfile.encoding=UTF-8：JDK 18 起 System.out 默认跟随平台编码（中文 Windows 为 GBK），
    // 会导致中文输出与 UTF-8 标准答案比对不一致，这里强制 UTF-8
    run: '{runTool} -cp {dir} -Xss64m -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 Main',
    highlight: 'java',
    toolName: 'javac',
    runToolName: 'java',
  },
  pascal: {
    key: 'pascal',
    name: 'Pascal (Free Pascal)',
    ext: 'pas',
    compiled: true,
    compile: '{tool} {src} -o{exe}',
    run: '{exe}',
    highlight: 'pascal',
    toolName: 'fpc',
  },
  php: {
    key: 'php',
    name: 'PHP 8',
    ext: 'php',
    compiled: false,
    compile: null,
    run: '{tool} {src}',
    highlight: 'php',
    toolName: 'php',
  },
  go: {
    key: 'go',
    name: 'Go',
    ext: 'go',
    compiled: true,
    // Linux 服务环境可能缺少 GOCACHE/GOPATH（HOME 不可写），编译前由 judge.js 准备 go.mod 与缓存目录
    compile: '{tool} build -o {exe} {src}',
    run: '{exe}',
    highlight: 'go',
    toolName: 'go',
  },
  rust: {
    key: 'rust',
    name: 'Rust',
    ext: 'rs',
    compiled: true,
    // Windows：rustc 自带 rust-lld 链接，避免依赖外部 MinGW/MSVC；Linux：用系统默认链接器（cc）
    compile: process.platform === 'win32'
      ? '{tool} -O {src} -o {exe} -C linker=rust-lld'
      : '{tool} -O {src} -o {exe}',
    run: '{exe}',
    highlight: 'rust',
    toolName: 'rustc',
  },
  output: {
    key: 'output',
    name: '提交答案',
    ext: 'txt',
    compiled: false,
    compile: null,
    run: null,
    highlight: 'text',
    toolName: 'node', // 占位工具：提交答案题不运行程序
    outputOnly: true,
  },
};

// 工具链候选路径：优先用 PATH 上的命令名，找不到时回退到已知安装路径。
// 本机 Dev-Cpp 自带 MinGW64（gcc/g++ 4.9.2）。
// Windows 常见安装路径（winget / 官方安装器）：OpenJDK、FPC、WinGet PHP 包、Cargo/Rustup。
const TOOLCHAIN_CANDIDATES = {
  'python': ['python', 'python3', 'py'],
  'node': ['node', 'nodejs'],
  'g++': ['g++', 'C:\\Program Files (x86)\\Dev-Cpp\\MinGW64\\bin\\g++.exe', 'C:\\mingw64\\bin\\g++.exe', 'C:\\msys64\\mingw64\\bin\\g++.exe', 'C:\\Program Files\\mingw-w64\\mingw64\\bin\\g++.exe'],
  // 注意：Windows 上 PATH 里的 gcc 可能是 Free Pascal 自带的 GCC 2.95（没有 C 头文件），
  // 判题侧会按版本号过滤掉过旧的候选，因此这里同时列出常见的 MinGW-w64 安装位置。
  'gcc': ['gcc', 'C:\\Program Files (x86)\\Dev-Cpp\\MinGW64\\bin\\gcc.exe', 'C:\\mingw64\\bin\\gcc.exe', 'C:\\msys64\\mingw64\\bin\\gcc.exe', 'C:\\Program Files\\mingw-w64\\mingw64\\bin\\gcc.exe'],
  'javac': ['javac', '/usr/lib/jvm/java-21-openjdk-amd64/bin/javac', '/usr/lib/jvm/java-21-openjdk/bin/javac', '/usr/lib/jvm/java-17-openjdk-amd64/bin/javac', 'C:\\Program Files\\Microsoft\\jdk-21.0.7.6-hotspot\\bin\\javac.exe', 'C:\\Program Files\\Microsoft\\jdk-17.0.20.8-hotspot\\bin\\javac.exe', 'C:\\Program Files\\Eclipse Adoptium\\jdk-21*\\bin\\javac.exe', 'C:\\Program Files\\Eclipse Adoptium\\jdk-17*\\bin\\javac.exe'],
  'java': ['java', '/usr/lib/jvm/java-21-openjdk-amd64/bin/java', '/usr/lib/jvm/java-21-openjdk/bin/java', '/usr/lib/jvm/java-17-openjdk-amd64/bin/java', 'C:\\Program Files\\Microsoft\\jdk-21.0.7.6-hotspot\\bin\\java.exe', 'C:\\Program Files\\Microsoft\\jdk-17.0.20.8-hotspot\\bin\\java.exe', 'C:\\Program Files\\Eclipse Adoptium\\jdk-21*\\bin\\java.exe', 'C:\\Program Files\\Eclipse Adoptium\\jdk-17*\\bin\\java.exe'],
  'fpc': ['fpc', 'C:\\FPC\\3.2.2\\bin\\i386-win32\\fpc.exe', 'C:\\FPC\\3.2.2\\bin\\x86_64-win64\\fpc.exe', '/usr/bin/fpc', '/usr/local/bin/fpc'],
  'php': ['php', '/usr/bin/php', '/usr/local/bin/php'],
  'go': ['go', '/usr/local/go/bin/go', '/usr/bin/go'],
  'rustc': ['rustc', 'C:\\Users\\{user}\\.cargo\\bin\\rustc.exe', '/usr/bin/rustc', '/usr/local/bin/rustc'],
};

/** 各工具的版本探测参数（go 用 `go version`，fpc 用 `-iV`，javac 用 `-version`，其余 `--version`） */
const TOOL_VERSION_FLAGS = {
  go: ['version'],
  fpc: ['-iV'],
  javac: ['-version'],
};

/** 各工具可接受的最低主版本号：防止解析到「同名但不可用」的旧工具
 *  （本机 PATH 上的 gcc 曾是 Free Pascal 自带的 GCC 2.95，找不到 stdio.h，导致 C 语言编译必然失败）
 *  判题探测（src/judge.js）与部署自检（deploy/check-env.js）共用这一份，避免两处判断不一致。 */
const TOOL_MIN_MAJOR = { gcc: 3, 'g++': 3, javac: 8, java: 8, python: 3, node: 12, fpc: 2, php: 5, go: 1, rustc: 1 };

/** 判定结果常量 */
const VERDICTS = {
  PENDING: 'Pending',
  JUDGING: 'Judging',
  AC: 'Accepted',
  WA: 'Wrong Answer',
  TLE: 'Time Limit Exceeded',
  MLE: 'Memory Limit Exceeded',
  RE: 'Runtime Error',
  CE: 'Compile Error',
  SE: 'System Error',
};

// 难度分级
const DIFFICULTIES = [
  { level: 0, label: '暂未评级', color: '#8c8c8c' },
  { level: 1, label: '入门', color: '#fe4c61' },
  { level: 2, label: '普及−', color: '#f39c11' },
  { level: 3, label: '普及/提高−', color: '#ffc116' },
  { level: 4, label: '普及+/提高', color: '#52c41a' },
  { level: 5, label: '提高+/省选−', color: '#3498db' },
  { level: 6, label: '省选/NOI−', color: '#9d3dcf' },
  { level: 7, label: 'NOI/NOI+/CTSC', color: '#0e1d69' },
];

/** 建目录并校正权限（M16）：数据/评测/测试数据目录只给属主，日志目录 0700。
 *  Windows 上 chmod 基本无效（ACL 语义不同），失败一律忽略，不影响启动。 */
function ensureDirs() {
  // data/ 与 data/judge/ 用 0711：选手（降权后的低权账户）需要**穿过**目录去执行自己的 main.exe，
  // 但不能列目录；testdata/ 用 0700：隐藏测试数据连穿都不给（checker/交互器由服务账户运行，属主可读）。
  for (const d of [DATA_DIR, JUDGE_DIR]) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o711 }); } catch { /* ignore */ }
    try { fs.chmodSync(d, 0o711); } catch { /* ignore */ }
  }
  try { fs.mkdirSync(TESTDATA_DIR, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  try { fs.chmodSync(TESTDATA_DIR, 0o700); } catch { /* ignore */ }
  try { fs.mkdirSync(PUBLIC_DIR, { recursive: true }); } catch { /* ignore */ }
  // 日志目录（若存在）：0700 + 里面的文件 0600（数据库/日志不被同机其他用户读取）
  const logDir = path.join(BASE_DIR, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  try { fs.chmodSync(logDir, 0o700); } catch { /* ignore */ }
  try {
    for (const f of fs.readdirSync(logDir)) {
      try { fs.chmodSync(path.join(logDir, f), 0o600); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // 数据库与初始密码文件：0600（存在才改）
  for (const f of ['oj.db', 'oj.db-wal', 'oj.db-shm', 'admin-password.txt']) {
    try { fs.chmodSync(path.join(DATA_DIR, f), 0o600); } catch { /* ignore */ }
  }
}

module.exports = {
  BASE_DIR,
  DATA_DIR,
  JUDGE_DIR,
  TESTDATA_DIR,
  DB_PATH,
  PUBLIC_DIR,
  DOCS_DIR,
  PORT,
  HOST,
  DEFAULTS,
  MEM_SAMPLER,
  JUDGE_USER,
  LANGUAGES,
  TOOLCHAIN_CANDIDATES,
  TOOL_VERSION_FLAGS,
  TOOL_MIN_MAJOR,
  VERDICTS,
  DIFFICULTIES,
  ensureDirs,
};
