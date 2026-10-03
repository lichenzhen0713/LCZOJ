# 🏆 LCZOJ 在线评测系统

> **零依赖 · 一键部署 · 开箱即用**的在线评测系统（Online Judge），交互风格参考洛谷等知名 OJ。
> 仅使用 Node.js 内置模块构建：**无需 `npm install`、无需编译、无需数据库服务**，拷贝即运行。

<p align="center">
  <a href="https://github.com"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.5-brightgreen" alt="Node.js ≥ 22.5"></a>
  <img src="https://img.shields.io/badge/Dependencies-Zero-orange" alt="零依赖">
  <img src="https://img.shields.io/badge/%E8%AF%84%E6%B5%8B%E8%AF%AD%E8%A8%80-10-blueviolet" alt="10 种评测语言">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-lightgrey" alt="跨平台">
</p>

---

## 📖 目录

- [✨ 功能特性](#-功能特性)
- [🚀 快速开始（3 分钟上手）](#-快速开始3-分钟上手)
- [🖥️ 一键部署脚本](#️-一键部署脚本)
- [🔧 手动部署](#-手动部署)
- [🧩 功能详解](#-功能详解)
- [💬 支持的评测语言](#-支持的评测语言)
- [⚙️ 配置与自定义](#️-配置与自定义)
- [📁 项目结构](#-项目结构)
- [📚 文档](#-文档)
- [❓ 常见问题](#-常见问题)
- [🤝 社区与贡献](#-社区与贡献)
- [📄 许可证](#-许可证)

---

## ✨ 功能特性

| 模块 | 特性 |
| --- | --- |
| 👤 **用户系统** | 注册 / 登录 / 会话保持、`scrypt` 密码哈希、唯一数字 UID、邮箱验证（SMTP，失败自动回退页面展示验证码）、忘记密码找回 |
| 🔐 **权限模型** | 8 项权限位（题目 / 用户 / 题解审核 / 专栏审核 / 比赛 / 讨论 / 专栏管理 / 题解管理），全部勾选即超级管理员；操作全程留痕并通知 |
| 📝 **题库与评测** | Markdown + LaTeX 题面、标签/难度筛选、子任务捆绑评测、O2 优化（题目级 + 提交级）、Special Judge、提交答案题、**大数据包评测**（>16KB 不预览、完整评测） |
| 🧪 **评测语言** | Python 3、JavaScript、C++（98/11/14）、C (C11)、Java、Pascal、PHP、Go、Rust —— 工具链自动探测，未安装自动标记 |
| 🏁 **比赛** | ACM / IOI / OI 三赛制、报名制、私有赛题、OI 赛中隐藏成绩、Rated/Unrated、Codeforces 风格等级分结算 |
| 📚 **题解与专栏** | 分类、草稿、审核流、评论与 @提及、点赞、自动分页 |
| 💬 **社区** | 讨论区（学术 / 灌水 / 站务 / 题目）、置顶、积分、等级分、排行榜、棕名处罚、反馈与举报 |
| 🔔 **通知中心** | 被@ / 回复 / 系统三类独立页面 + 铃铛未读角标 |
| 🎨 **个性化** | 暗黑模式（定时 + 手动）、侧边栏折叠、头像、Markdown 实时预览、页脚公开页 |
| 📱 **其它** | 移动端适配、标题随路由变化、面包屑、首页搜索、新标签页打开 |

---

## 🚀 快速开始（3 分钟上手）

**你会用鼠标双击文件、会打开浏览器吗？会就够了。**

### ⭐ 最省事：一行命令部署到服务器

项目开源在 **GitHub** 与 **Gitee（码云）**。在**全新 Linux 服务器**上执行**一条命令**即可完成部署（自动识别发行版、安装 Node.js 与全部编译器、开机自启、放行防火墙 80 端口、输出外网访问地址）：

```bash
# 仓库在 GitHub（所有发行版通用这一条）
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/bootstrap.sh | sudo bash

# 仓库在 Gitee（码云）
curl -fsSL https://gitee.com/Carter_Zane/LCZOJ/raw/master/bootstrap.sh | sudo bash
```

> 部署完成后浏览器打开脚本输出的 **http://服务器IP**（80 端口无需写），用 **admin / admin123** 登录（首次自动创建，请尽快修改）。

### Windows 用户

1. 把整个项目文件夹拷到电脑上（比如 `D:\LCZOJ`）；
2. **双击 `install.bat`** —— 自动安装 Node.js 并启动网站；
3. 浏览器打开 **http://localhost**，用 **admin / admin123** 登录。

### Linux 用户（项目已在服务器上）

```bash
cd /path/to/LCZOJ
sudo bash install-ubuntu.sh      # Ubuntu / Debian
# 或
sudo bash install-centos.sh      # CentOS / RHEL（7/8/9）
# 或（其它发行版）
sudo ./install.sh --daemon
```

### 手动启动

```bash
node server.js   # 环境要求：Node.js ≥ 22.5（推荐 24.x LTS）
```

打开 **http://localhost**（默认端口 80；改端口：`set PORT=8080 && node server.js`）。

> 🎯 首次启动自动创建管理员 **admin / admin123**，内置 3 道示例题（A+B Problem、SPJ 测试题、提交答案测试题）开箱即可评测。
> 🔄 想清空所有数据、恢复到刚部署时的默认状态？运行 `./reset.sh`（Linux）或 `reset.bat`（Windows）：停止服务 → 删除全部数据 → 可选 `--start` 立即重新启动（自动重建 admin 账号与 3 道示例题）。
> 📖 图文新手教程见 [docs/新手教程.md](docs/BEGINNERS.md)。

---

## 🖥️ 一键部署脚本

脚本**全自动**：识别发行版 → 拉取项目 → 安装 Node.js 与全部编译器 → 注册 systemd 开机自启 → 放行防火墙 80 端口 → 启动网站。

### 一行命令（推荐，全新服务器直接可用）

```bash
# GitHub 源（所有发行版通用，脚本自动区分）
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/bootstrap.sh | sudo bash

# Gitee 源
curl -fsSL https://gitee.com/Carter_Zane/LCZOJ/raw/master/bootstrap.sh | sudo bash
```

`bootstrap.sh` 自动完成：安装基础工具 → 下载项目到 `/opt/lczoj`（GitHub 失败自动回退 Gitee）→ **识别发行版**并执行对应脚本：

| 发行版 | 自动调用的脚本 | 说明 |
| --- | --- | --- |
| Ubuntu / Debian | `install-ubuntu.sh` | NodeSource 装 Node 24、全部编译器、ufw 放行 80、systemd 自启 |
| CentOS / RHEL 7/8/9 | `install-centos.sh` | dnf/yum 装 Node 24（7 自动回退官方二进制）、firewalld 放行 80、systemd 自启 |
| 其它（Arch/Alpine 等） | `install.sh --daemon` | 通用安装 + 后台运行 |

> 仓库地址可用环境变量覆盖：`sudo LCZOJ_REPO=https://github.com/你的账号/LCZOJ bash -c "$(curl -fsSL <脚本地址>)"`

### 专用脚本（项目已在服务器上）

```bash
# Ubuntu / Debian
cd /path/to/LCZOJ && sudo bash install-ubuntu.sh

# CentOS / RHEL（7/8/9）
cd /path/to/LCZOJ && sudo bash install-centos.sh

# 其它发行版（Fedora/Arch/Alpine/openSUSE 等）
cd /path/to/LCZOJ && sudo ./install.sh --daemon
```

### 通用脚本参数（install.sh）

| 参数 | 作用 |
| --- | --- |
| `./install.sh` | 一键安装全部依赖并启动 |
| `./install.sh --daemon` | 后台运行（关掉终端也不停，日志 `logs/lczoj.log`） |
| `./install.sh --port 8080` | 指定端口 |
| `./install.sh --no-start` | 仅安装依赖，不启动 |

自动识别 `apt / dnf / yum / pacman / apk / zypper`：

1. **Node.js**：已有且 ≥22.5 直接使用；否则包管理器安装，仍不满足则自动下载官方 Node.js 24 LTS 二进制（x64 / arm64）到 `/opt` 并建立软链；
2. **全部评测语言工具链**：GCC/G++、Python3、Free Pascal、PHP、Go、Rust、OpenJDK（个别发行版缺失的包自动跳过，不影响其它语言）；
3. **启动**：默认前台；`--daemon` 用 `nohup` 后台运行。

### Windows

```bat
install.bat            # 双击即可：自动安装 Node.js 并启动
install.bat --daemon   # 后台运行（最小化窗口作为服务控制台）
```

> 💡 Windows 上 C/C++ 也可使用 Dev-Cpp 自带的 MinGW64——系统会自动从 `C:\Program Files (x86)\Dev-Cpp\MinGW64\bin` 发现编译器。

---

## 🔧 手动部署

### Windows

```bat
node server.js
```

- 默认端口 80；改端口：`set PORT=8080 && node server.js`
- 数据目录 `data/`（可设环境变量 `OJ_DATA_DIR` 指向其它路径）

### Linux（推荐 systemd 常驻）

先安装 Node.js ≥ 22.5 与需要的编译器（示例为 Debian/Ubuntu）：

```bash
sudo apt install -y nodejs npm python3 gcc g++ fp-compiler php-cli golang-go rustc default-jdk-headless
node server.js
```

systemd 服务 `/etc/systemd/system/oj.service`：

```ini
[Unit]
Description=OJ Online Judge
After=network.target

[Service]
WorkingDirectory=/opt/oj
ExecStart=/usr/bin/node server.js
Environment=PORT=8080   # 默认 80 直连；改 8080 交由 Nginx 转发时使用
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now oj
```

反向代理（Nginx）示例：

```nginx
server {
  listen 80;
  server_name oj.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;   # Nginx 在 80，LCZOJ 用 8080
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 300s;
  }
}
```

### 数据与备份

所有数据保存在 `data/`：`oj.db`（SQLite）、`testdata/`（测试数据）、`judge/`（判题临时目录）。

- **备份**：直接复制 `data/` 目录即可；
- **重置**：删除 `data/` 后重启自动重建（恢复出厂数据）。

---

## 🧩 功能详解

### 📝 题库与评测

- **题面**：Markdown + LaTeX（内置零依赖数学渲染，多 CDN 依次尝试 KaTeX 增强，页面与实时预览渲染管线一致）；
- **筛选**：按难度、标签筛选；支持显示/隐藏分数；
- **测试数据**：逐测试点文件上传、**ZIP 测试数据包**（覆盖 / 合并两种模式）、子任务分组与分数、**四种子任务计分方式**（加和 / 最小值 / 最大值 / 捆绑）；
- **大数据包**：单文件超过 16 KB 不在编辑页预览（避免浏览器卡死），但判题机始终读取**完整**数据，几十 MB 数据包可正常评测；
- **O2 优化**：题目级默认 + 提交级可单独选择（仅 C/C++）；
- **Special Judge**：Testlib 标准 `checker.cpp`（自动编译、支持部分分）；
- **提交答案题**：用户上传答案文件（单文件或 ZIP）。

### 🏁 比赛

- 三种赛制：**ACM**（通过数 + 罚时）、**IOI**（每测试点即时给分）、**OI**（赛中隐藏成绩，赛后公布）；
- 报名制、私有赛题、Rated/Unrated 标识；
- 等级分后台手动结算（Codeforces 风格期望排名算法）。

### 📚 题解与专栏

- 分类：题解 / 科技·工程 / 算法·理论 / 生活·游记 / 学习·文化课 / 休闲·娱乐；
- 草稿、审核流（题解 / 专栏分开）、评论与 @提及通知、点赞；
- 评论超过 10 条自动分页。

### 💬 社区

- 讨论区：学术版 / 灌水区 / 站务版 / 题目讨论；
- 积分、等级分、排行榜、棕名处罚；
- **反馈与举报**：用户提交，后台仅超级管理员审核。

---

## 💬 支持的评测语言

| 语言 | 工具链 | 编译/运行 | 备注 |
| --- | --- | --- | --- |
| Python 3 | `python` / `python3` | 直接运行 | 开箱可用 |
| JavaScript | `node` | 直接运行 | 开箱可用 |
| C++ 14 / 11 / 98 | `g++` | `-O2 -std=c++XX -static` | 静态链接 |
| C (C11) | `gcc` | `-O2 -std=c11 -lm -static` | 静态链接 |
| Java 8+ | `javac` / `java` | 编译后 `java -cp dir Main` | 需 JDK |
| Pascal | `fpc` | `fpc src -oexe` | 需安装 |
| PHP | `php` | 直接运行 | 需安装 |
| Go | `go` | `go build -o exe` | 需安装 |
| Rust | `rustc` | `rustc -O src -o exe` | 需安装 |

> 🔧 **新增 / 修改语言**：在 `src/config.js` 的 `LANGUAGES` 中增加定义（名称、扩展名、编译命令、运行命令、高亮类型），并在 `TOOLCHAIN_CANDIDATES` 声明工具链候选路径即可。详见 [docs/LANGUAGES.md](docs/LANGUAGES.md)。

---

## ⚙️ 配置与自定义

| 配置项 | 说明 |
| --- | --- |
| 站点名称 / Logo | 管理后台 → 系统设置（仅 admin 账号），侧边栏 / 首页 / 浏览器标题联动 |
| 页脚与公开页 | 系统设置 → 站点页面与版权：帮助中心 / 用户协议 / 联系我们 / 关于网站 / 社区规则（Markdown + 实时预览） |
| 功能开关 | 系统设置可关闭讨论区、题解与专栏、积分系统（关闭后全站隐藏入口） |
| SMTP / 邮箱验证 | 系统设置配置 SMTP（如 `smtp.126.com:465` SSL），发送验证码；开启后可启用「忘记密码」 |
| 管理员权限 | 用户管理页为每个用户勾选 8 项权限（全部 = 超级管理员），操作写入记录并通知 |
| 暗黑模式 | 默认按时间自动（19:00–06:59），可手动切换 |
| 数学渲染 | 内置 LaTeX 渲染器 + 多 CDN 尝试 KaTeX 增强 |
| 端口 / 数据目录 | 环境变量 `PORT`、`OJ_DATA_DIR` |

> 📖 完整的权限模型、积分系统二开、SPJ 配置等见 [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md)。

---

## 📁 项目结构

```
server.js             HTTP 服务与 API 路由（零依赖）
src/
  config.js           端口、语言定义、工具链候选、难度、判定常量
  db.js               SQLite 建表/迁移/种子数据、测试数据读写
  auth.js             会话、登录注册、权限位解析
  password.js         scrypt 密码哈希
  markdown.js         Markdown → HTML（含内置 LaTeX 数学渲染）
  judge.js            判题引擎 + 队列 + 工具链自动发现
  runner.ps1          Windows 判题包装器（内存采样、超时强杀）
  smtp.js             零依赖 SMTP 客户端（node:net/node:tls）
  zip.js              极简 ZIP 解析器
  problems.js / submissions.js / contest.js / editorial.js
  discussion.js / users.js / rating.js / ranking.js / notifications.js / settings.js / util.js
public/
  index.html / css/style.css
  js/app.js           路由与页面（原生 SPA）
  js/api.js / editor.js
install.sh / install.bat   一键部署脚本（Linux / Windows）
reset.sh / reset.bat       恢复默认状态脚本（停止服务 → 清空数据 → 可选重启）
docs/                 详细文档（使用说明、部署、多语言、自定义、FAQ 等）
data/                 运行时数据（自动生成）
```

> API 接口可直接阅读 `server.js` 中的路由（中文注释），常用接口：`/api/problems`、`/api/contests`、`/api/submissions`、`/api/editorials`、`/api/discussions`、`/api/notifications`、`/api/admin/*`、`/api/settings`、`/api/site-pages`、`/api/preview` 等。

---

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | **功能使用说明**：普通用户与管理员功能详解（题目数据配置、子任务计分、ZIP 覆盖/合并、大数据包、SPJ 等） |
| [docs/BEGINNERS.md](docs/BEGINNERS.md) | **新手教程**：小白三步部署、常见问题（第一次使用先看这里） |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署详解：systemd、Nginx 反向代理、HTTPS、防火墙、备份恢复 |
| [docs/LANGUAGES.md](docs/LANGUAGES.md) | 多语言配置：各平台工具链安装、候选路径、新增语言、判题参数 |
| [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) | 自定义指南：站点信息、公开页、权限模型、功能开关、积分系统二开、SPJ |
| [docs/FAQ.md](docs/FAQ.md) | 常见问题解答（忘记密码、提交记录、后台权限等） |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 贡献指南：开发环境、代码风格、提交流程 |

> 🌐 部署后，网站页脚「使用说明」也会直接链接到这些文档（带左侧目录导航）。

---

## ❓ 常见问题

**Q1：网站打不开？**

- 确认部署脚本执行成功、没有报错；Windows 防火墙拦截时选择「允许访问」；云服务器记得在**安全组 / 防火墙**放行 **80 端口**。

**Q2：提交代码后一直「等待评测 / Judging」？**

- 看日志（`journalctl -u lczoj -f`）有没有报错；对应语言未安装时会显示「未安装」，安装对应编译器即可（如 `apt install fp-compiler`）。

**Q3：数据都在哪？怎么备份？**

- 全部数据在 `/opt/lczoj/data`（数据库 + 测试数据）。**备份 = 复制整个 `data` 文件夹**；恢复初始状态 = 删掉 `data` 后重启服务。

**Q4：想让网站走 HTTPS / 用自己的域名？**

- 见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)（Nginx 反向代理 + Let's Encrypt 免费证书）。

> 更多问答见 [docs/FAQ.md](docs/FAQ.md)。

---

## 🤝 社区与贡献

欢迎提交 Issue 与 Pull Request！开发前请阅读 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) 与 `server.js`、`src/` 下的模块注释。

- **代码风格**：CommonJS、零依赖、中文注释；
- **技术栈**：Node.js 内置模块（`node:http` / `node:sqlite` / `node:crypto` / `node:child_process` / `node:net` / `node:tls` / `node:zlib`），前端为原生 SPA（无框架、无构建工具）。

---

## 📄 许可证

[MIT](LICENSE) © OJ Contributors

---

> **⚠️ 免责声明**：评测会执行用户提交的任意代码，当前未做操作系统级隔离（时间限制 + 进程树终止为基本防护）。请勿直接暴露到公网，建议本地或可信内网使用。
