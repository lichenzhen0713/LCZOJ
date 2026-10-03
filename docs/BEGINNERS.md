# LCZOJ 使用指南（新手版）

本指南面向**完全没接触过服务器 / 编程环境**的小白。你只需要会「复制粘贴一条命令」和「打开浏览器」。

LCZOJ 是一个**在线做题网站**（Online Judge），类似洛谷 / Codeforces。部署好后你可以：自己出题让别人提交评测、举办比赛（ACM/OI/IOI）、拥有讨论区、题解专栏、积分等级分、反馈举报等完整功能。**不需要装数据库、不需要 npm install**。

---

## 一、最快方式：一条命令部署到服务器（推荐）

项目已开源在 **GitHub** 与 **Gitee（码云）**。在**全新 Linux 服务器**（云服务器 / VPS）上，复制下面**一条命令**回车即可：

```bash
# 仓库在 GitHub：
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/bootstrap.sh | sudo bash
```

```bash
# 仓库在 Gitee（码云）：
curl -fsSL https://gitee.com/Carter_Zane/LCZOJ/raw/master/bootstrap.sh | sudo bash
```

> 把 `<你的账号>` 替换成你的 GitHub / Gitee 账号名。

这条命令会自动完成（通常 3~10 分钟）：

1. 自动识别你的系统（Ubuntu / CentOS / 其它发行版）；
2. 从 GitHub（失败自动改用 Gitee）下载 LCZOJ 到 `/opt/lczoj`；
3. 安装 Node.js 24 与全部评测语言编译器（C/C++、Python、Pascal、PHP、Go、Rust、Java）；
4. 注册成系统服务（systemd），**开机自启**；
5. 放行防火墙 **80 端口**；
6. 启动网站，并自动显示**外网访问地址**（如 `http://123.45.67.89`）。

**部署完成后**：浏览器打开脚本输出的地址 → 用 **admin** 登录，初始密码是**首次启动时随机生成的**（脚本输出的启动日志里有，也写在数据目录的 `admin-password.txt`），请尽快修改密码。

---

## 二、项目已在服务器上（其它方式）

把整个 LCZOJ 文件夹上传到服务器后（例如 `/opt/lczoj`）：

```bash
# Ubuntu / Debian
cd /opt/lczoj && sudo bash install-ubuntu.sh

# CentOS / RHEL（7/8/9）
cd /opt/lczoj && sudo bash install-centos.sh

# 其它发行版（Fedora / Arch / Alpine / openSUSE 等）
cd /opt/lczoj && sudo ./install.sh --daemon
```

---

## 三、Windows 部署（双击完成）

1. 把整个 LCZOJ 文件夹拷到电脑上（路径不要有中文和空格，如 `D:\LCZOJ`）；
2. **双击 `install.bat`** —— 自动安装 Node.js（缺失时自动下载）并启动网站；
3. 浏览器打开 **http://localhost**，用 **admin** + 启动日志里打印的随机初始密码登录。

> 闪一下就没了 → 右键「以管理员身份运行」；端口 80 被占用 → `set PORT=8080 && install.bat`，访问 `http://localhost:8080`。

---

## 四、部署完成后，先做这三件事

1. **改管理员密码**：右上角头像 → 编辑资料 → 修改密码；
2. **改站点名称 / Logo**：管理后台 → 系统设置 → 站点信息；
3. **加题目**：管理后台 → 题目管理 → 新建题目（填标题、题面，再上传测试数据）。

---

## 五、日常管理

| 操作 | 命令 |
| --- | --- |
| 查看服务状态 | `systemctl status lczoj` |
| 查看日志（实时） | `journalctl -u lczoj -f` |
| 停止服务 | `systemctl stop lczoj` |
| 启动服务 | `systemctl start lczoj` |
| 更新到最新版 | `cd /opt/lczoj && git pull && sudo systemctl restart lczoj` |
| 查看外网地址 | 部署脚本会直接输出；或云控制台查看公网 IP |

---

## 六、常见问题（FAQ）

### 网站打不开？

- 确认部署脚本执行成功、没有报错；
- Windows 防火墙拦截时选择「允许访问」；
- 云服务器记得在**安全组 / 防火墙**放行 **80 端口**（脚本已尽量自动处理，云厂商安全组需在控制台手动放行）。

### 提交代码后一直「等待评测 / Judging」？

- 看日志（`journalctl -u lczoj -f`）有没有报错；
- 对应语言未安装时会显示「未安装」，安装对应编译器即可（如 `apt install fp-compiler`）。

### 数据都在哪？怎么备份？

全部数据在 `/opt/lczoj/data`（数据库 + 测试数据）。**备份 = 复制整个 `data` 文件夹**；恢复初始状态 = 删掉 `data` 后重启服务。

### 想让网站走 HTTPS / 用自己的域名？

见 [DEPLOYMENT.md](DEPLOYMENT.md)（Nginx 反向代理 + Let's Encrypt 免费证书）。

### 使用 Docker 或宝塔 / 小皮面板部署

- **Docker**：全新服务器执行一行命令 `curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/docker-bootstrap.sh | sudo bash`，脚本会自动安装 Docker、下载项目、构建镜像并启动服务；项目已在服务器上时执行 `node deploy/docker-onekey.js`。详见 [DOCKER.md](DOCKER.md)；
- **宝塔面板 / 小皮面板**：在面板中安装 Node.js v24 → 上传项目 → 执行 `node deploy/panel-install.js`（准备环境、后台启动服务、生成反向代理配置）→ 在面板中合并 `deploy/panel-nginx.conf` 并申请证书。详见 [PANEL.md](PANEL.md)。

### 升级到新版本

```bash
node deploy/update.js            # 自动备份数据库 → 更新代码 → 重启（数据不受影响）
node deploy/update.js --docker   # Docker 部署使用此项
```

也可在「管理后台 → 系统设置 → 版本更新」中一键完成。详见 [UPDATE.md](UPDATE.md)。

> 部署完成后如不确定环境是否正确，在项目目录执行 `node deploy/check-env.js`，
> 该脚本会输出 Node.js 版本是否满足要求、端口是否被占用、数据目录是否可写、各语言编译器是否就绪。

---

## 七、想深入了解？

- [功能使用说明](USAGE.md) —— 普通用户与管理员功能详解（题目数据配置、子任务计分、ZIP 覆盖/合并、SPJ 等）
- [部署详解](DEPLOYMENT.md) —— 部署方式对照、反向代理、HTTPS、备份恢复、systemd
- [Docker 部署](DOCKER.md) —— 一条命令起站、数据卷备份恢复、资源限制、安全提示
- [面板部署](PANEL.md) —— 宝塔面板 / 小皮面板逐步操作与排错
- [自定义指南](CUSTOMIZATION.md) —— 站点信息、权限、积分系统二开、Special Judge、提交答案题
- [多语言配置](LANGUAGES.md) —— 安装 / 新增评测语言
- [常见问题](FAQ.md) —— 更多问答
