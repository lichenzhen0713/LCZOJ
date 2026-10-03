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
  judgeTimeoutMs: 30 * 1000, // 判题整体兜底超时
  // 并行判题数：默认按 CPU 核数自适应（2~4，可用系统设置「评测性能」调整，或用环境变量 OJ_MAX_JUDGES 覆盖）
  maxConcurrentJudges: Math.max(1, Math.min(16, parseInt(process.env.OJ_MAX_JUDGES, 10)
    || Math.max(2, Math.min(4, (require('node:os').cpus() || []).length - 1)))),
  sessionTtlDays: 14,     // 会话有效期
};

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

function ensureDirs() {
  for (const d of [DATA_DIR, JUDGE_DIR, TESTDATA_DIR, PUBLIC_DIR]) {
    fs.mkdirSync(d, { recursive: true });
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
  LANGUAGES,
  TOOLCHAIN_CANDIDATES,
  TOOL_VERSION_FLAGS,
  TOOL_MIN_MAJOR,
  VERDICTS,
  DIFFICULTIES,
  ensureDirs,
};
