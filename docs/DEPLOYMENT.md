# 部署详解

本文说明 LCZOJ 的部署方式、常驻运行配置、反向代理、HTTPS、备份与版本更新。

四种部署方式的对照如下，可按服务器实际情况选择；部署完成后的管理员账号均为 **admin**，**初始密码在首次启动时随机生成**（启动日志打印一次，并写入数据目录的 `admin-password.txt`；也可用环境变量 `OJ_ADMIN_PASSWORD` 预先指定），登录后请立即修改密码。

| 服务器情况 | 推荐方式 | 入口命令 |
| --- | --- | --- |
| Linux 服务器（常规场景） | Linux 一键脚本 | `curl -fsSL …/bootstrap.sh \| sudo bash` |
| 不希望安装 Node.js 与编译器 | Docker（未安装 Docker 时自动安装） | `curl -fsSL …/docker-bootstrap.sh \| sudo bash` |
| 已使用宝塔 / 小皮面板 | 面板部署 | `node deploy/panel-install.js` |
| 本机或内网试用（Windows） | 双击运行 | `install.bat` |

部署前后均建议执行环境自检，用于确认 Node.js 版本、端口占用、数据目录权限与各语言编译器：

```bash
node deploy/check-env.js
```

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22.5（必须，内置 `node:sqlite`；**推荐 24**；用 Docker 则不用自己装） |
| 磁盘 | ≥ 100MB（不含测试数据与判题临时文件） |
| 内存 | ≥ 256MB（判题并发默认 2） |
| 系统 | Windows 10+ / Linux（kernel 3.10+） |

评测工具链（可选，按需安装）：Python3、GCC/G++、Free Pascal、PHP、Go、Rust、OpenJDK。未安装的语言在评测面板中显示「未安装」，**不影响站点运行**。
用 Docker、`bootstrap.sh` 或 `node deploy/panel-install.js` 都会自动把编译器装好。

> 面板 / 容器部署的 4 个要点：
> - 面板上 80/443 已被 Nginx 占用，**本站请用 `PORT=3000` + 站点反向代理**（见 [PANEL.md](PANEL.md)）；
> - `OJ_HOST=127.0.0.1` 让服务只监听本机，避免别人绕过 Nginx 直接访问端口；
> - `OJ_DATA_DIR=/绝对/路径` 可把数据目录放到数据盘（默认项目下 `data/`）；
> - `OJ_MAX_JUDGES=4` 显式指定并行判题数（Docker 里自动探测到的是宿主机核数，建议显式设置）；
> - `OJ_ADMIN_PASSWORD=你的密码` 可指定初始管理员密码（不设置则**首次启动时随机生成 12 位密码**，写入数据目录的 `admin-password.txt`）；
> - `LCZOJ_PUBLIC_IP=你的公网IP` 可指定部署脚本输出的访问地址（默认自动识别公网 IP）。

## 2. Linux 服务器部署（推荐）

### 2.1 一行命令（全新服务器）

```bash
# GitHub 源（所有发行版通用）
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/bootstrap.sh | sudo bash
# Gitee（码云）源，国内更快
curl -fsSL https://gitee.com/Carter_Zane/LCZOJ/raw/master/bootstrap.sh | sudo bash
```

脚本会自动：安装基础工具 → 下载项目到 `/opt/lczoj`（GitHub 失败自动回退 Gitee）→ 识别发行版 →
安装 Node.js 与全部评测语言 → 注册 systemd 开机自启 → 放行防火墙 80 端口 → 启动并打印**外网访问地址**。

| 发行版 | 实际调用的脚本 | 说明 |
| --- | --- | --- |
| Ubuntu / Debian | `install-ubuntu.sh` | NodeSource 装 Node 24、全部编译器、ufw 放行 80、systemd 自启 |
| CentOS / RHEL 7/8/9 | `install-centos.sh` | dnf/yum 装 Node 24（7 自动回退官方二进制）、firewalld 放行 80 |
| 其它（Arch / Alpine / openSUSE…） | `install.sh --daemon` | 通用安装 + 后台运行 |

### 2.2 项目已在服务器上

```bash
chmod +x install.sh
./install.sh                # 安装依赖并启动（前台）
./install.sh --port 8080    # 指定端口
./install.sh --no-start     # 仅安装依赖
```

脚本会识别 `apt / dnf / yum / pacman / apk / zypper` 并安装 Node.js 与全部语言编译器。Node.js 版本过低（< 22.5）时会给出安装 24.x LTS 的提示并退出。

### 2.3 手动安装（Debian/Ubuntu 示例）

```bash
# 1) 安装 Node.js 24 LTS（nodesource 官方源）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2) 安装评测工具链
sudo apt-get install -y python3 gcc g++ fp-compiler php-cli golang-go rustc default-jdk-headless

# 3) 拷贝项目并启动
cd /opt/oj
node server.js
```

### 2.4 systemd 常驻运行

项目自带模板 `deploy/lczoj.service`（改一下路径与用户即可用），也可以手写 `/etc/systemd/system/oj.service`：

```ini
[Unit]
Description=OJ Online Judge
After=network.target

[Service]
WorkingDirectory=/opt/oj
ExecStart=/usr/bin/node server.js
Environment=PORT=8080   # 默认 80 直连；Nginx 转发时用 8080
Environment=OJ_DATA_DIR=/var/lib/oj
Restart=always
RestartSec=3
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now oj
sudo systemctl status oj          # 查看状态
sudo journalctl -u oj -f          # 查看日志
```

> 注意：判题会创建临时目录并执行用户代码，请确保 `WorkingDirectory` 与 `OJ_DATA_DIR` 对运行用户可写。

### 2.5 Nginx 反向代理

```nginx
server {
  listen 80;
  server_name oj.example.com;

  # 提交大代码 / 文件上传需要较长的代理超时与请求体上限
  # （服务端请求体上限 64MB，答案文件允许 32MB）
  client_max_body_size 64m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 必须大于服务端 keepAliveTimeout（65s），否则长连接会被提前掐断
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
  }
}
```

> 完整示例（含健康检查）见 `deploy/nginx-lczoj.conf`；面板部署时可直接粘贴到宝塔 / 小皮的站点配置里（`node deploy/panel-install.js` 还会自动按你的端口生成一份 `deploy/panel-nginx.conf`）。

### 2.6 HTTPS（Let's Encrypt）

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d oj.example.com
```

certbot 会自动改写 Nginx 配置并续期。

### 2.7 防火墙

```bash
# UFW（Debian / Ubuntu）
sudo ufw allow 22/tcp
sudo ufw allow 80,443/tcp
sudo ufw enable

# firewalld（CentOS / RHEL）
sudo firewall-cmd --permanent --add-port=80/tcp && sudo firewall-cmd --reload
```

云服务器还要在控制台的**安全组**里放行 80 / 443。

## 3. Docker 部署

### 3.1 一行命令（服务器上什么都没有也能用）

```bash
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/docker-bootstrap.sh | sudo bash
```

它会自动装基础工具 → **没装 Docker 就把 Docker 装好并设为开机自启** → 下载项目到 `/opt/lczoj` →
构建镜像（内含全部评测语言）→ 启动容器 → 等就绪并打印**公网访问地址**（自动识别公网 IP，失败时回退内网地址）与随机生成的初始管理员密码。可用环境变量覆盖：
`LCZOJ_PORT=8080`、`LCZOJ_DIR=/opt/lczoj`、`LCZOJ_JUDGES=4`。

### 3.2 项目已在服务器上

```bash
node deploy/docker-onekey.js      # 一键：没装 Docker 会自动装（Linux），构建 + 启动 + 等就绪
```

等价的手动方式：

```bash
docker compose up -d --build          # 用仓库自带的 compose（默认映射到 80 端口）
# 或不用 compose：
docker build -t lczoj:2.1.0 .
docker run -d --name lczoj --restart unless-stopped -p 80:80 \
  -v lczoj-data:/app/data -e OJ_MAX_JUDGES=4 -e TZ=Asia/Shanghai lczoj:2.1.0
```

完整说明（备份恢复、换端口、资源限制、HTTPS、镜像内容、安全提示、排错）见 [DOCKER.md](DOCKER.md)。

## 4. 面板部署（宝塔 / 小皮）

一句话：**面板的 80/443 留给 Nginx，本站跑 3000 端口，由站点反向代理转过去。**

```bash
cd /www/wwwroot/你的域名      # 小皮 Windows：cd /d C:\phpstudy_pro\WWW\lczoj
node deploy/panel-install.js   # 装环境 + 后台启动 + 生成反代配置（一条命令搞定）
```

然后在面板上做两件事：① 站点里粘贴 `deploy/panel-nginx.conf` 的内容（或宝塔「反向代理」指向 `http://127.0.0.1:3000`）；② SSL 一键申请证书。

日常管理：`node deploy/panel-install.js --start` / `--stop`，环境体检 `node deploy/check-env.js`。
逐步点击教程与排错表见 [PANEL.md](PANEL.md)。

## 5. Windows 部署

**最简单**：双击 `install.bat`（自动安装 Node.js 与可选评测语言，然后启动网站）。

手动跑起来：

```bat
node server.js            :: 默认 80 端口
set PORT=8080 && node server.js   :: 想换端口
```

- 需要 Node.js ≥ 22.5（推荐 24）：https://nodejs.org/zh-cn/download
- C/C++ 建议安装 Dev-Cpp（自带 MinGW64），系统会自动探测
- 常驻运行三选一：NSSM 注册成 Windows 服务 / 面板的「计划任务」+ `deploy\panel-start.bat` / PM2（`pm2 start deploy/ecosystem.config.js`）
- 面板方式（宝塔 Windows 版 / 小皮面板）见 [PANEL.md](PANEL.md)
- 环境体检：`node deploy\check-env.js`

## 6. 版本更新

程序代码的更新不影响站点数据：数据库、题库测试数据、附件与头像保存在 `data/` 中（Docker 为数据卷），更新仅覆盖程序文件。

```bash
node deploy/update.js            # 检查新版本 → 自动备份数据库 → 更新代码 → 重启并自检
node deploy/update.js --check    # 仅检查是否有新版本
node deploy/update.js --docker   # Docker 部署：重新构建镜像并重建容器
```

脚本自动识别安装方式与启动方式：

| 情况 | 处理方式 |
| --- | --- |
| git 仓库 | 执行 `git pull` |
| 压缩包解压安装 | 下载官方源码包，仅覆盖代码文件；`data/`、`logs/`、`deploy/panel.env`、`.git/` 保持不变 |
| Docker 容器运行中 | 重新构建镜像并重建容器（数据卷保留） |
| PM2 / systemd / `deploy/panel.pid` | 使用对应方式重启，并等待 `/api/health` 通过后输出结果 |

> systemd 部署时，若服务运行用户不是 root，重启需要相应权限：更新流程会先尝试 systemctl restart lczoj，失败后回退 sudo -n systemctl restart lczoj；仍无权限时不会判定更新失败，而是提示手动执行该命令（此时代码已更新完成）。如需今后自动重启，执行一次 sudo bash deploy/grant-restart-permission.sh 配置最小权限 sudo 规则。
| 以上均未识别 | 提示手动重启方式 |

使用内置 `admin` 账号登录后，也可在「管理后台 → 系统设置 → 版本更新」中完成更新，界面会显示各阶段进度；该功能同样会先备份数据库，并在完成后自动重启服务。

完整的更新说明（各部署方式的重启命令对照、手动更新步骤、回滚方法、常见问题）见 [UPDATE.md](UPDATE.md)。

## 7. 数据与备份

所有数据位于 `data/`（或 `OJ_DATA_DIR` 指定目录）：

| 文件/目录 | 说明 |
| --- | --- |
| `oj.db` | SQLite 主数据库（用户、题目、提交、比赛、设置等） |
| `testdata/` | 题目的测试数据（.in/.out 与子任务分数） |
| `attachments/` `avatars/` | 题目附件与用户头像 |
| `judge/` | 判题临时目录（评测结束即清理） |

**备份**：

```bash
# 停止服务后复制（SQLite 热备也可用 sqlite3 .backup）
cp -r data backup_$(date +%Y%m%d)
```

Docker 部署的备份/恢复命令见 [DOCKER.md](DOCKER.md) 第五节。

**恢复**：将备份目录放回原位置后重启即可。

**重置系统**：删除 `data/` 后重启，自动重建数据库并写入种子数据（admin 账号与内置题库）。

## 8. 常见问题

- **端口被占用**：`PORT=8080 node server.js` 更换端口；或跑 `node deploy/check-env.js` 看占用者是谁（能识别出是不是 LCZOJ 自己）。
- **评测一直 Pending**：查看服务端控制台日志，确认对应语言的工具链已安装（`install.sh` / `check-env.js` 会打印工具链检测结果）。
- **启动报 `Cannot find module 'node:sqlite'`**：Node 版本低于 22.5。装 Node 24；或临时用 `node --experimental-sqlite server.js`（22.5~23.3 适用，程序也会自动带上这个参数重试）。
- **数据目录不可写 / 题库保存失败**：面板部署常见（目录属主不是运行用户），`chown -R www:www data && chmod -R 755 data`。
- **反代后面板停止服务导致提交卡在「判题中」**：确认进程是用 `exec` 前台启动的（`deploy/panel-start.sh` 已如此处理），服务端会收到 SIGTERM 并等评测收尾后再退出。
- **更新后页面还是旧版**：前端有缓存，`Ctrl+F5` 强制刷新；Docker 用户请确认用 `--docker` 方式重建了容器。
- **数学公式显示为源代码**：确认浏览器能访问 CDN（jsdelivr/unpkg/cdnjs/bootcdn）；无法访问时自动使用内置渲染器（效果略差但可用）。
- **无法注册**：检查是否开启了邮箱验证（系统设置 → SMTP）；未配置 SMTP 时验证码会直接显示在页面。
