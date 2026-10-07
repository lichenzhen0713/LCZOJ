# 多语言配置指南

OJ 的评测语言定义在 `src/config.js`，工具链自动探测、未安装自动禁用。本文说明如何配置、安装与新增语言。

## 1. 语言总览

| key | 语言 | 工具链命令 | 是否编译 |
| --- | --- | --- | --- |
| `python` | Python 3 | `python` / `python3` | 否 |
| `javascript` | JavaScript (Node.js) | `node` | 否 |
| `cpp` | C++ 14 | `g++` | 是 |
| `cpp11` | C++ 11 | `g++` | 是 |
| `cpp98` | C++ 98 | `g++` | 是 |
| `c` | C 11 | `gcc` | 是 |
| `java` | Java 21 | `javac` + `java` | 是 |
| `pascal` | Pascal (Free Pascal) | `fpc` | 是 |
| `php` | PHP | `php` | 否 |
| `go` | Go | `go` | 是 |
| `rust` | Rust | `rustc` | 是 |

## 2. 各平台安装工具链

### Debian / Ubuntu

```bash
sudo apt-get install -y python3 gcc g++ fp-compiler php-cli golang-go rustc cargo openjdk-21-jdk-headless
# 若发行版无 openjdk-21 包，可回退：sudo apt-get install -y default-jdk-headless
```

### Fedora / RHEL / CentOS Stream

```bash
sudo dnf install -y python3 gcc gcc-c++ fpc php-cli golang rust cargo java-21-openjdk-devel
# 若仓库无 java-21 包（如 RHEL 8），可回退：sudo dnf install -y java-17-openjdk-devel
```

> CentOS 7（yum）没有 rustc 包；Java 使用 `java-1.8.0-openjdk-devel`。

### Arch / Manjaro

```bash
sudo pacman -S --noconfirm python gcc fpc php go rust java-openjdk
```

### Alpine

```bash
sudo apk add --no-cache python3 gcc g++ fpc php-cli go rust cargo openjdk17-jdk
```

### openSUSE

```bash
sudo zypper install -y python3 gcc gcc-c++ fpc php-cli go rust java-17-openjdk-devel
```

### Windows

| 语言 | 安装建议 |
| --- | --- |
| Python | python.org 安装包（勾选 Add to PATH） |
| C/C++ | Dev-Cpp（自带 MinGW64）或 MSYS2 / WSL |
| Java | OpenJDK（如 Temurin / Microsoft OpenJDK），配置 `JAVA_HOME` 与 PATH |
| Pascal | Free Pascal 官方安装包 |
| PHP | winget：`winget install PHP.PHP.8.4` |
| Go | 官方安装包 / `winget install GoLang.Go`，加入 PATH |
| Rust | `winget install Rustlang.Rustup`，再 `rustup default stable-x86_64-pc-windows-gnu`；系统会自动使用 rustc 内置 `rust-lld` 链接，无需安装 VS / MinGW |

> Windows 上系统会额外探测 `C:\Program Files (x86)\Dev-Cpp\MinGW64\bin` 下的 gcc/g++，以及 OpenJDK（`C:\Program Files\Microsoft\jdk-17*`）、Free Pascal（`C:\FPC\3.2.2\bin\*`）、Cargo/Rustup（`C:\Users\<用户名>\.cargo\bin`）等常见路径。
> 运行 `install.bat` 会自动通过 winget 安装全部评测语言编译器（已安装的跳过）。

## 3. 工具链探测机制

判题时（`src/judge.js`）按 `TOOLCHAIN_CANDIDATES` 中声明的顺序寻找可执行文件：

```js
const TOOLCHAIN_CANDIDATES = {
  'python': ['python', 'python3', 'py'],
  'g++': ['g++', 'C:\\Program Files (x86)\\Dev-Cpp\\MinGW64\\bin\\g++.exe'],
  'fpc': ['fpc', '/usr/bin/fpc', '/usr/local/bin/fpc'],
  // ...
};
```

- 找到第一个可用项即使用；
- 全部找不到则该语言标记为「未安装」，评测面板中不可选；
- 将编译器放在 PATH 中即可被自动发现，无需改代码。

## 4. 新增 / 修改语言

在 `src/config.js` 的 `LANGUAGES` 中新增一条定义：

```js
kotlin: {
  key: 'kotlin',
  name: 'Kotlin',
  ext: 'kt',
  compiled: true,
  compile: '{tool} {src} -include-runtime -d {exe}',
  run: 'java -jar {exe}',
  highlight: 'kotlin',
  toolName: 'kotlinc',
},
```

命令模板变量：

| 变量 | 含义 |
| --- | --- |
| `{tool}` | 编译/运行工具路径（由探测结果决定） |
| `{runTool}` | 运行工具路径（如 Java 的 `java`） |
| `{src}` | 源码文件完整路径 |
| `{exe}` | 可执行文件路径（编译语言） |
| `{dir}` | 判题工作目录 |

同时把工具链加入 `TOOLCHAIN_CANDIDATES`：

```js
'kotlinc': ['kotlinc', '/usr/bin/kotlinc'],
```

重启服务即可在评测面板中选择新语言。

## 5. 判题限制

`src/config.js` 的 `DEFAULTS` 中可调整全局限制：

```js
timeLimitMs: 1000,          // 默认时间限制（题目可覆盖）
memoryLimitMb: 256,         // 默认内存限制（题目可覆盖）
outputLimitBytes: 16MB,     // 单测试点输出上限
judgeTimeoutMs: 30s,        // 判题整体兜底超时
maxConcurrentJudges: 2,     // 并行判题数
```

> 注意：
> - C/C++ 使用 `-static` 静态链接；
> - Java 默认主类为 `Main`（公共类必须命名为 `Main`，源文件固定为 `Main.java`）；
> - Rust 在 Windows 使用内置 `rust-lld` 链接（无需 VS / MinGW），Linux 使用系统默认链接器；
> - Go 使用共享 GOCACHE 缓存（`data/gocache`），模块模式编译、禁止联网下载依赖（仅标准库）；编译超时上限 60 秒。
> - Linux 下若 Java / Go / Rust 曾报编译错误，请确认：Java 类名是否为 `Main`、`data/` 目录是否可写（Go 缓存）、rustc 是否可用系统链接器。
