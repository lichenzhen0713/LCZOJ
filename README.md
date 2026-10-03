# 🏆 LCZOJ 在线评测系统

> 零外部依赖的在线评测系统（Online Judge），交互风格参考洛谷等主流 OJ。
> 全部功能基于 Node.js 内置模块实现：**无需 `npm install`、无需编译、无需独立数据库服务**，拷贝即可运行。

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.0.9-blue.svg" alt="Version 2.0.9">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.5-brightgreen" alt="Node.js ≥ 22.5"></a>
  <img src="https://img.shields.io/badge/Dependencies-Zero-orange" alt="零依赖">
  <img src="https://img.shields.io/badge/%E8%AF%84%E6%B5%8B%E8%AF%AD%E8%A8%80-10-blueviolet" alt="10 种评测语言">
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/%E9%9D%A2%E6%9D%BF-%E5%AE%9D%E5%A1%94%20%7C%20%E5%B0%8F%E7%9A%AE-4CAF50" alt="宝塔 / 小皮面板">
</p>

---

## 目录

- [部署方式](#部署方式)
  - [方式一：Linux 服务器](#方式一linux-服务器)
  - [方式二：Docker](#方式二docker)
  - [方式三：宝塔 / 小皮面板](#方式三宝塔--小皮面板)
  - [方式四：Windows](#方式四windows)
  - [部署后的初始操作](#部署后的初始操作)
- [版本更新](#版本更新)
- [功能特性](#功能特性)
- [快速上手](#快速上手)
- [支持的评测语言](#支持的评测语言)
- [常用配置](#常用配置)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [文档索引](#文档索引)
- [版本日志](#版本日志)
- [许可证](#许可证)

---

## 部署方式

四种方式任选其一，部署完成后的初始账号均为 **admin / admin123**，登录后请立即修改密码。

| 方式 | 适用场景 | 操作概要 | 参考耗时 |
| --- | --- | --- | --- |
| **Linux 服务器**（推荐） | 具备 Linux 服务器的常规场景 | 执行一条命令 | 3~5 分钟 |
| **Docker** | 不希望安装 Node.js 与编译器，或需要便捷迁移 | 执行一条命令（未安装 Docker 时自动安装） | 5~10 分钟 |
| **宝塔 / 小皮面板** | 服务器已使用面板管理 | 执行一条命令并在面板完成两步配置 | 3 分钟 |
| **Windows** | 本机或内网试用 | 双击 `install.bat` | 3 分钟 |

部署前后均建议执行环境自检，用于确认 Node.js 版本、端口占用、数据目录权限与各语言编译器是否就绪：

```bash
node deploy/check-env.js
```

### 方式一：Linux 服务器

全新 Linux 服务器（Ubuntu / Debian / CentOS / RHEL / Fedora / Arch / Alpine / openSUSE 等）执行以下命令，脚本会识别发行版、安装 Node.js 与全部评测语言编译器、注册 systemd 开机自启、放行 80 端口，并输出外网访问地址：

```bash
# GitHub 源
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/bootstrap.sh | sudo bash

# Gitee 源（国内网络环境更快）
curl -fsSL https://gitee.com/Carter_Zane/LCZOJ/raw/master/bootstrap.sh | sudo bash
```

项目已在服务器上时，也可在项目目录直接执行：

```bash
sudo bash install-ubuntu.sh      # Ubuntu / Debian
sudo bash install-centos.sh      # CentOS / RHEL 7/8/9
sudo ./install.sh --daemon       # 其它发行版，后台常驻
```

详细参数（systemd、Nginx 反向代理、HTTPS、防火墙、备份）见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

### 方式二：Docker

服务器无需预先安装任何组件（未安装 Docker 时脚本会自动安装 Docker 并设为开机自启）：

```bash
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/docker-bootstrap.sh | sudo bash
```

脚本执行内容：安装基础工具 → 安装并启动 Docker → 下载项目至 `/opt/lczoj` → 构建镜像（镜像内已包含全部评测语言）→ 启动容器（数据保存于数据卷）→ 等待服务就绪并输出访问地址。

项目已在服务器上时，可使用一键脚本或 Compose：

```bash
node deploy/docker-onekey.js    # 未安装 Docker 时自动安装，随后构建、启动并等待就绪
docker compose up -d --build    # 等价方式（服务器未安装 Node.js 时使用此项）
```

数据保存在数据卷 `lczoj-data` 中，删除容器不影响数据。详细说明（备份恢复、端口调整、HTTPS、排错）见 [docs/DOCKER.md](docs/DOCKER.md)。

### 方式三：宝塔 / 小皮面板

面板的 80/443 端口由站点（Nginx）使用，LCZOJ 监听 3000 端口，由站点反向代理转发。

1. 在面板中安装 **Node.js v24**（宝塔：软件商店 → Node.js 版本管理器 或 PM2管理器；小皮：软件商店或官方安装包）；
2. 将项目上传至站点目录（宝塔 `/www/wwwroot/你的域名`，小皮 `C:\phpstudy_pro\WWW\lczoj`），在面板终端执行：

   ```bash
   cd /www/wwwroot/你的域名        # Windows：cd /d C:\phpstudy_pro\WWW\lczoj
   node deploy/panel-install.js     # 准备环境、后台启动服务、生成反向代理配置
   ```

   该命令完成：检查 Node.js 版本 → 创建数据目录并修正属主 → 写入启动参数 `deploy/panel.env` → 安装评测语言编译器 → 后台启动服务并等待就绪 → 生成 `deploy/panel-nginx.conf`；
3. 将 `deploy/panel-nginx.conf` 的内容合并到站点配置中（修改 `server_name` 为实际域名），或在宝塔中使用「反向代理」功能指向 `http://127.0.0.1:3000`；
4. 在面板中申请 SSL 证书并开启 HTTPS。

服务管理命令：`node deploy/panel-install.js --start` / `--stop`，环境自检 `node deploy/check-env.js`。
完整步骤与排错见 [docs/PANEL.md](docs/PANEL.md)。

### 方式四：Windows

1. 将项目目录复制到本机（例如 `D:\LCZOJ`）；
2. 双击 `install.bat`（自动安装 Node.js 与可选评测语言并启动服务）；
3. 浏览器访问 **http://localhost**，使用 **admin / admin123** 登录。

已安装 Node.js ≥ 22.5 时，也可在项目目录执行 `node server.js`（默认 80 端口，如需修改：`set PORT=8080 && node server.js`）。

### 部署后的初始操作

1. **修改密码**：登录后进入「编辑资料」修改密码；
2. **确认评测语言**：管理后台 → 系统设置 → 评测性能，或执行 `node deploy/check-env.js`（未安装的语言会标记为「未安装」，不影响站点运行）；
3. **确认数据目录**：站点数据位于项目下的 `data/` 目录（Docker 部署位于数据卷 `lczoj-data`），备份即复制该目录。

恢复到初始状态（清空全部数据、重建 admin 与 3 道示例题）：Windows 双击 `reset.bat`，Linux / macOS 执行 `./reset.sh`；两者行为一致，等价于 `node deploy/reset.js`。建议先执行 `node deploy/reset.js --check` 预览将要删除的内容，加 `--yes` 可跳过确认，`--start` / `--daemon` 可在清空后立即重启。

---

## 版本更新

程序代码更新不会影响站点数据：数据库、题库测试数据、附件与头像保存在 `data/`（Docker 为数据卷），更新仅覆盖程序文件。

### 方式一：管理后台一键更新（推荐）

使用内置 `admin` 账号登录 → 管理后台 → **系统设置 → 版本更新**：

1. 区块内显示当前版本、官方最新版本与服务启动方式（PM2 / systemd / 面板后台进程）；
2. 勾选「更新前备份数据库」（默认勾选），点击「立即更新到 vX.Y.Z」并确认；
3. 页面实时显示进度：检查最新版本 → 备份数据库 → 下载新版本代码 → 覆盖代码文件 → 重启服务；
4. 进入重启阶段后页面提示「服务正在重启，N 秒后自动刷新」，刷新后版本号即为新版本。

前置条件：使用 `admin` 账号；服务器可访问 GitHub 或 Gitee，或已通过 `OJ_UPDATE_URL` / `OJ_UPDATE_ZIP_URL` 指定自建更新源。
Docker 部署请勿在容器内更新（容器重建后会回到镜像内版本），应在宿主机执行下文的 Docker 更新命令。

### 方式二：命令行一键更新

```bash
node deploy/update.js             # 检查 + 更新 + 重启（更新前自动备份数据库）
node deploy/update.js --check     # 仅检查是否有新版本
node deploy/update.js --docker    # Docker 部署：重新构建镜像并重建容器
node deploy/update.js --help      # 查看全部参数
```

脚本按以下顺序执行：检查最新版本 → 备份 `data/oj.db` 到 `data/backup/` → 更新代码（git 仓库执行 `git pull`，否则下载官方源码包并只覆盖代码文件）→ 重启服务（PM2 → systemd → 面板后台进程，均自动识别）。

### 更新源与安全校验

- 更新源默认使用 **Gitee**（`https://gitee.com/Carter_Zane/LCZOJ`），失败自动回退 GitHub；可通过
  `OJ_UPDATE_URL`（版本号）与 `OJ_UPDATE_ZIP_URL`（源码包）指定自建仓库或内网镜像。
- 源码包在写入前会做**整体校验**，任一项不通过即中止更新且**不修改任何文件**：
  ① 代码与文本文件中不得残留 Git 合并冲突标记（`<<<<<<<` / `=======` / `>>>>>>>`）；
  ② `package.json` 必须是合法 JSON；③ `server.js` 必须通过语法检查。
- 更新源返回的内容不是合法 JSON 时，版本检查会尽力解析出版本号并在界面给出提示，便于定位仓库文件问题。

### 方式三：手动更新

停止服务 → 备份 `data/` 目录 → 用新版本程序文件覆盖（保留 `data/`、`logs/`、`deploy/panel.env`、`.git/`）→ 启动服务 → 访问 `/api/health` 确认版本号。

### 更新后的确认项

1. `GET /api/health` 返回的 `version` 为新版本号；
2. 管理后台版本号、`package.json` 的 `version`、启动日志三处一致；
3. 浏览器强制刷新（`Ctrl+F5`）后页面正常，题库、题面公式、代码提交与评测均可用；
4. 提交记录与题库数据完整。

完整的参数说明、各部署方式的重启命令对照、回滚方法（代码 / 数据库 / Docker 镜像）与常见问题见 **[docs/UPDATE.md](docs/UPDATE.md)**。

---

## 功能特性

| 模块 | 特性 |
| --- | --- |
| **用户系统** | 注册 / 登录 / 会话保持、`scrypt` 密码哈希、唯一数字 UID（**删除后编号释放复用**）、邮箱验证（SMTP，未配置时验证码在页面显示）、忘记密码 |
| **权限模型** | 8 项权限位（题目 / 用户 / 题解审核 / 专栏审核 / 比赛 / 讨论 / 专栏 / 题解），全部勾选即超级管理员；操作留痕并通知本人 |
| **题库与评测** | Markdown + LaTeX 题面（内置渲染 + KaTeX 增强）、标签与难度筛选、子任务计分（sum / min / max / bundle）、题目级与提交级 O2 开关、Special Judge、提交答案题、大数据包评测（超过 16KB 不预览但完整评测）；**题目批量导出 / 导入**（勾选导出、导入预检、同名冲突策略、跨站点迁移） |
| **提交方式** | 在线代码编辑器（长代码粘贴与渲染优化）、上传源码文件或拖拽文件并自动识别语言；提交答案题支持上传答案文件或 ZIP |
| **评测性能** | 并行判题 1~16 路（默认按 CPU 自适应，后台可调且即时生效）；单测试点约 0.4 秒；Windows 下由 Node 直接执行配合常驻内存采样器 |
| **题目重判** | 仅超级管理员可用：比赛某题、某题全部（可区分普通与比赛提交）、自定义提交 ID 区间，先预览数量再执行 |
| **比赛** | ACM / IOI / OI 三种赛制、报名制、私有赛题、OI 赛中隐藏成绩、Rated / Unrated、Codeforces 风格等级分结算 |
| **题解与专栏** | 分类、草稿、审核流、评论与 @提及、点赞、自动分页 |
| **社区** | 讨论区（学术 / 灌水 / 站务 / 题目）、置顶、积分与等级分、排行榜、棕名处罚、反馈与举报 |
| **私信与通知** | 一对一私信（会话列表与未读标记）、被 @ / 回复 / 系统三类通知与未读角标 |
| **网站外观** | 8 套主题预设与完全自定义（12 项配色、圆角、字号、字体）、全站与首页宽度分别设置、站名与标题样式、独立夜间配色；修改即时预览，未保存的改动自动回滚 |
| **个性化** | 暗黑模式（定时 + 手动）、侧边栏折叠、移动端快捷按钮、头像、Markdown 实时预览、可自定义的页脚公开页 |
| **运维** | 评测缓存定期自动清理（仅清理缓存，不动题库与数据）、环境自检脚本、版本更新、一键重置、批量生成用户 |
| **部署方式** | Linux 一键脚本、Docker（自动安装 Docker）、宝塔 / 小皮面板、Windows 双击；提供 PM2 与 systemd 配置、环境自检、健康检查与版本更新提示 |

---

## 快速上手

1. **进入管理后台**：登录后点击侧边栏底部「管理后台」；
2. **创建题目**：管理后台 → 题目管理 → 新建题目，填写题面（支持 Markdown + LaTeX），上传测试数据（可逐点上传或上传 ZIP 包）；
3. **验证评测**：返回前台 → 题库 → 打开题目 → 提交一份代码，查看评测结果与提交记录。

全新安装自带 3 道示例题（**A+B Problem**、**SPJ 测试题**、**提交答案测试题**），分别覆盖普通评测、Special Judge 与提交答案题三种形态，安装后即可试用；其余题目可通过「导入题目」批量导入。

---

## 支持的评测语言

| 语言 | 工具链 | 编译 / 运行 | 说明 |
| --- | --- | --- | --- |
| Python 3 | `python` / `python3` | 直接运行 | 开箱可用，强制 UTF-8 输入输出 |
| JavaScript | `node` | 直接运行 | 开箱可用 |
| C++ 14 / 11 / 98 | `g++` | `-O2 -std=c++XX -static` | 静态链接；支持题目级与提交级关闭 O2 |
| C (C11) | `gcc` | `-O2 -std=c11 -lm -static` | 自动跳过版本过旧的 gcc |
| Java 8+ | `javac` / `java` | 编译后 `java -cp dir Main` | 需 JDK，强制 UTF-8 |
| Pascal | `fpc` | `fpc src -oexe` | 需安装 |
| PHP | `php` | 直接运行 | 需安装 |
| Go | `go` | `go build -o exe` | 需 ≥ 1.21，使用独立构建缓存 |
| Rust | `rustc` | `rustc -O src -o exe` | 需安装 |

新增语言或修改编译参数：编辑 `src/config.js` 中的 `LANGUAGES` 与 `TOOLCHAIN_CANDIDATES`，详见 [docs/LANGUAGES.md](docs/LANGUAGES.md)。

---

## 常用配置

网页端配置（管理后台 → 系统设置）：

| 配置项 | 内容 |
| --- | --- |
| 网站外观 | 站名与 Logo、标题样式、8 套主题预设与自定义配色、圆角、字号、字体、页面宽度 |
| 评测性能 | 并行判题数 1~16，修改后即时生效 |
| 站点页面与版权 | 帮助中心 / 用户协议 / 联系我们 / 关于网站 / 社区规则（Markdown 与实时预览） |
| 功能开关 | 可整体关闭讨论区、题解与专栏、积分系统等模块 |
| SMTP / 邮箱验证 | 配置邮箱后启用注册验证与「忘记密码」 |
| 用户管理 | 授予 8 项权限、重置密码、批量生成与批量删除用户 |
| 版本更新 | 检查并一键更新程序代码（仅 `admin` 账号） |

环境变量（面板部署写入 `deploy/panel.env`，Docker 写入 compose）：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `80` | 服务端口（面板部署通常使用 `3000`） |
| `OJ_HOST` | `0.0.0.0` | 监听地址；面板反向代理场景建议设为 `127.0.0.1` |
| `OJ_DATA_DIR` | 项目下 `data/` | 数据目录（数据库、测试数据、附件、头像） |
| `OJ_MAX_JUDGES` | 按 CPU 自适应 | 并行判题数 1~16 |
| `TZ` | 系统时区 | 页面时间显示，例如 `Asia/Shanghai` |
| `OJ_UPDATE_URL` | Gitee（官方仓库） | 版本检查地址（默认 `https://gitee.com/Carter_Zane/LCZOJ/raw/master/package.json`，失败回退 GitHub；多个地址用逗号分隔） |
| `OJ_UPDATE_ZIP_URL` | Gitee（官方仓库） | 源码包下载地址（默认 Gitee 归档包，失败回退 GitHub；多个地址用逗号分隔） |

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动报 `Cannot find module 'node:sqlite'` | Node.js 版本低于 22.5，请安装 v24；或临时使用 `node --experimental-sqlite server.js` |
| 无法访问网站 | 执行 `node deploy/check-env.js` 检查端口与数据目录；确认云服务器安全组或防火墙已放行对应端口 |
| 端口被占用 | 更换端口：`PORT=8080 node server.js`；面板部署修改 `deploy/panel.env` 并同步调整反向代理目标 |
| 502 Bad Gateway | 后端进程未启动或端口不一致，查看进程日志（`pm2 logs lczoj` 或面板日志） |
| 上传答案 ZIP 报 413 | 站点 Nginx 配置中增加 `client_max_body_size 64m;` |
| 题库保存失败 / 数据库写入失败 | `data` 目录权限不足：`chown -R www:www 项目目录/data` |
| 某语言显示「未安装」 | 安装对应编译器：`apt-get install -y build-essential python3 default-jdk php-cli fp-compiler rustc`；Go 需 ≥ 1.21（https://go.dev/dl/） |
| 提交后长期处于「判题中」 | 缺少编译器，或重启服务时打断了评测；重新提交即可，超级管理员可对题目执行重判 |
| 更新后仍显示旧版本 | 浏览器缓存，强制刷新（`Ctrl+F5`）；Docker 部署请确认使用 `--docker` 方式重建容器 |
| 数学公式显示为源代码 | 浏览器无法访问 CDN，系统自动回退到内置渲染器（效果略有差异但可用） |

更多问答见 [docs/FAQ.md](docs/FAQ.md)，初次部署请参阅 [docs/BEGINNERS.md](docs/BEGINNERS.md)。

---

## 项目结构

```
server.js              HTTP 服务与全部 API 路由（零依赖）
src/                   后端模块（约 20 个）
  config.js            端口 / 语言定义 / 工具链候选与最低版本 / 判定常量
  db.js                SQLite 建表迁移、种子数据、测试数据读写
  judge.js             判题引擎与队列（并行数可调）、工具链探测
  markdown.js          Markdown 转 HTML（含内置 LaTeX 数学渲染）
  version.js           版本号比较与最新版本查询
  updater.js           更新引擎：备份、下载、覆盖代码、重启
  其余                 用户 / 权限 / 题目 / 提交 / 比赛 / 题解 / 讨论 / 私信 / 附件等
public/                前端（原生 SPA，无框架）
  index.html  css/style.css  js/app.js  js/editor.js  js/api.js
deploy/                部署配套（面板 / Docker / systemd 通用）
  check-env.js         环境自检：Node 版本、端口占用、数据目录权限、各语言编译器
  panel-install.js     面板部署：环境准备、后台启停、生成反向代理配置
  docker-onekey.js     Docker 一键部署（未安装 Docker 时自动安装）
  update.js            命令行一键更新
  reset.js             恢复默认状态：停止服务、清空数据、可选重启（跨平台）
  restart-helper.js    无进程守护时负责拉起新进程
  grant-restart-permission.sh  （Linux/systemd）为服务用户配置重启权限
  panel-start.sh/.bat  面板前台启动脚本（读取 panel.env）
  docker-entrypoint.sh Docker 入口（修正数据卷属主、降权、转发停止信号）
  ecosystem.config.js  PM2 进程守护配置
  lczoj.service        systemd 服务单元模板
  nginx-lczoj.conf     站点反向代理示例（含 64MB 上传上限）
Dockerfile / docker-compose.yml / .dockerignore   Docker 部署
docker-bootstrap.sh    全新服务器 Docker 一行部署（自动安装 Docker）
bootstrap.sh           全新服务器一行部署（自动安装 Node.js 与编译器）
install.sh / install.bat / install-ubuntu.sh / install-centos.sh  一键部署脚本
reset.sh / reset.bat   恢复初始状态（快捷入口，实际逻辑见 deploy/reset.js）
docs/                  详细文档
data/                  运行时数据（自动生成）
```

常用接口：`/api/home`、`/api/problems`、`/api/problems/:id/submit`、`/api/submissions`、`/api/contests`、`/api/editorials`、`/api/discussions`、`/api/messages/*`、`/api/notifications`、`/api/settings`、`/api/rejudge`、`/api/admin/*`、`/api/health`（健康检查）、`/api/version`（版本检查）、`/api/admin/update`（后台更新）。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/BEGINNERS.md](docs/BEGINNERS.md) | 新手教程：面向无服务器经验的部署与使用引导 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署详解：部署方式对照、systemd、Nginx、HTTPS、防火墙、备份 |
| [docs/DOCKER.md](docs/DOCKER.md) | Docker 部署：一行脚本、数据卷备份恢复、端口与 HTTPS、排错 |
| [docs/PANEL.md](docs/PANEL.md) | 面板部署：宝塔 / 小皮操作步骤与排错 |
| [docs/UPDATE.md](docs/UPDATE.md) | **版本更新指南**：四种更新方式、重启命令对照、回滚、常见问题 |
| [docs/USAGE.md](docs/USAGE.md) | 使用说明：普通用户与管理员功能详解 |
| [docs/LANGUAGES.md](docs/LANGUAGES.md) | 多语言配置：工具链安装、新增语言、判题参数 |
| [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) | 自定义指南：外观、权限、积分扩展、Special Judge |
| [docs/FAQ.md](docs/FAQ.md) | 常见问题解答 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 贡献指南 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 版本日志：每次更新的记录 |

部署后，网站页脚的「使用说明」与系统设置页右上角的「版本日志」可直接打开这些文档。

---

## 版本日志

当前版本 **v2.0.9**（`package.json`、系统设置页、启动日志三处一致）。完整版本线 **v0.1.0 → v2.0.9** 见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

- **v2.0.9** 修复 Windows 一键部署脚本 install.bat 调用 winget 时使用不存在的 --progress-bar 参数导致编译器全部安装失败的问题（改为 --exact --disable-interactivity），并新增 install.bat --check 干跑模式；题目管理页的「导入题目」入口移至页面右上角。
- **v2.0.8** 修复 reset 脚本在 Windows 与 Linux 下均无法使用的问题：Windows 端 .bat 内含中文导致 cmd 解析错乱（现改为纯 ASCII 包装脚本），Linux 端脚本不定位项目目录且无法停止被守护的服务；重置逻辑统一重写为跨平台的 deploy/reset.js（按 systemd → PM2 → panel.pid → 端口监听顺序停服、删除失败自动退避重试并列出占用文件、支持 --check/--yes/--start/--daemon）。
- **v2.0.7** 修复 systemd 部署下后台更新无法重启网站的问题（单元配置 Restart=always 时**无需 root 权限**：程序退出后由 systemd 自动拉起）；题目「导入」入口合并为一个（单题 JSON 与整包 ZIP 同一入口）；《使用说明》与站内功能全面对齐并大幅扩充。
- **v2.0.6** 新增**题目批量导出与批量导入**：题目管理页可勾选任意题目导出（或按当前筛选结果、整库、仅清单 JSON 导出），导入页支持本站导出包直接整体还原，并新增**导入预检**（只解析不写入，列出题目、测试点数与同名冲突）与**同名冲突策略**（跳过 / 覆盖 / 允许重复）。
- **v2.0.5** 修复 Linux（systemd）部署下自动更新无法重启服务的问题：重启方式判定改为核对进程号，非 root 时自动回退免密 sudo，权限不足时不再报「更新失败」而是提示手动执行 sudo systemctl restart lczoj（代码已更新完成）；新增 deploy/grant-restart-permission.sh 一键配置最小权限重启规则。
- **v2.0.4** 修复题目编辑器无法把题目设置为「提交答案题」的问题（该开关此前只在题目已是提交答案题时才显示）：现在新建与编辑题目时始终可切换该开关；提交页对普通题目仍不显示「提交答案」选项。
- **v2.0.3** 更新源默认改为 **Gitee**（`https://gitee.com/Carter_Zane/LCZOJ`，失败自动回退 GitHub，可用 `OJ_UPDATE_URL` / `OJ_UPDATE_ZIP_URL` 覆盖）；**修复管理后台「重新检查」无反馈的问题**（点击后立即显示「正在检查…」，并展示最后检查时间、实际来源与每个源的失败原因）；版本检查支持从格式异常（如仓库文件含合并冲突标记）的内容中尽力解析版本号并给出提示；新增**更新包预检**：含合并冲突标记、`package.json` 非法 JSON 或 `server.js` 语法错误的源码包会被直接拒绝，**不覆盖任何文件**。
- **v2.0.2** 新增**管理后台一键更新**（管理后台 → 系统设置 → 版本更新：检查最新版本、备份数据库、覆盖代码、自动重启，全程显示进度）；新增 [docs/UPDATE.md](docs/UPDATE.md) 版本更新指南（四种更新方式、重启命令对照、回滚方法、常见问题）；命令行更新脚本与后台共用同一套更新逻辑（`src/updater.js`）；文档风格调整为中性技术表述。
- **v2.0.1** 部署顺序调整（Linux 优先）；新增 `docker-bootstrap.sh`（未安装 Docker 时自动安装）与 `deploy/update.js`；面板一键脚本支持后台启动并生成反向代理配置；设置页显示版本更新提示。
- **v2.0.0** 新增 Docker 部署与宝塔 / 小皮面板部署支持；新增环境自检脚本与健康检查接口；修复 Markdown 渲染死循环、引用块与表格转义竖线渲染问题。
- **v1.20.x** 提交语言默认取上次提交所用语言、自动识别语言在提交时判定；提交代码框重写（长代码粘贴与渲染优化）；提交代码与提交代码文件分离；新增题目导出与题号迁移。
- **v1.19.x** 公式渲染管线重写（修复 `\log`、分式、根式等渲染问题）；O2 开关修复；题目背景区块。
- **v1.17.0 ~ v1.18.0** 支持上传与拖拽源码文件提交、并行判题可配置、Windows 判题性能优化。
- 更早版本（v0.1.0 ~ v1.16.x）记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

---

## 许可证

[MIT](LICENSE)。可自由使用、修改与商用，请保留版权声明。
