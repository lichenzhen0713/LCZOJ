# 面板部署（宝塔面板 / 小皮面板）

本文说明在宝塔面板与小皮面板上部署 LCZOJ 的步骤。

**部署模型**：面板站点（Nginx）占用 80 / 443 端口，LCZOJ 监听 3000 端口，由站点以反向代理转发请求。

---

## 1. 部署流程概览

| 步骤 | 操作 | 执行方 |
| --- | --- | --- |
| ① 安装 Node.js | 在面板软件商店安装 **v24** | 手动，约 1 分钟 |
| ② 执行准备命令 | `node deploy/panel-install.js`：准备环境、后台启动服务、生成反向代理配置 | 脚本自动 |
| ③ 配置站点 | 将生成的 `deploy/panel-nginx.conf` 内容合并到站点配置，并申请 SSL 证书 | 手动，约 1 分钟 |

命令执行完成后会输出服务就绪状态与后续操作清单。

---

## 2. 宝塔面板（Linux）

### 2.1 安装 Node.js v24

1. 左侧「软件商店」→ 搜索并安装 **Node.js 版本管理器**（部分版本名为 **PM2管理器**）；
2. 打开该插件 → 安装 **Node 版本 v24** → 设为默认版本。

注意事项：LCZOJ 使用 Node.js 内置的 `node:sqlite` 模块，要求 Node.js ≥ 22.5（推荐 v24）；版本过低时启动会报 `Cannot find module 'node:sqlite'`。

### 2.2 上传项目并执行准备命令

1. 左侧「文件」→ 进入 `/www/wwwroot/` → 新建目录（建议以域名命名，例如 `oj.example.com`）；
2. 上传项目压缩包并解压，解压后该目录下应直接包含 `server.js`、`src`、`public`、`deploy`；
3. 打开左侧「终端」，依次执行：

```bash
cd /www/wwwroot/oj.example.com     # 替换为实际目录
chown -R www:www .
node deploy/panel-install.js       # 准备环境 + 后台启动服务 + 生成反向代理配置
```

该命令依次执行：检查 Node.js 版本 → 创建数据目录并修正属主 → 写入启动参数 `deploy/panel.env` → 安装评测语言编译器 → 后台启动服务并等待健康检查通过 → 生成 `deploy/panel-nginx.conf`。

常用附加参数：`--check`（仅检查环境，不修改文件）、`--start` / `--stop`（启动 / 停止后台服务）、`--port`（指定端口）。

### 2.3 配置站点反向代理

方式 A（使用面板的反向代理功能）：进入目标站点 → 「反向代理」→「添加反向代理」，填写：

| 字段 | 值 |
| --- | --- |
| 代理名称 | `lczoj` |
| 目标 URL | `http://127.0.0.1:3000` |
| 发送域名 | `$host` |

方式 B（直接编辑站点配置）：进入目标站点 → 「配置文件」，将 `deploy/panel-nginx.conf` 的内容合并到 `server { }` 中，并修改 `server_name` 为实际域名。该配置已包含 `client_max_body_size 64m;`（缺少此项时上传较大答案包会返回 413）。

保存后通过域名访问站点。

> 还没有域名时可以先直接用 `http://服务器公网IP:端口/` 访问（脚本会打印公网地址；自动识别失败时用 `LCZOJ_PUBLIC_IP=你的IP` 指定）。
> 管理员账号为 `admin`，**初始密码在首次启动时随机生成**：启动日志会打印一次，也写在数据目录的 `admin-password.txt`。

### 2.4 申请 SSL 证书

站点 → 「SSL」→ 「Let's Encrypt」→ 勾选域名 → 申请 → 开启「强制 HTTPS」。

### 2.5 交由面板托管进程（可选）

`panel-install.js` 已在后台启动服务，进程号记录于 `deploy/panel.pid`。如需由面板托管并提供开机自启：

```bash
node deploy/panel-install.js --stop       # 先停止脚本启动的进程
```

随后在「网站 → Node 项目 → 添加」中填写：项目目录为站点目录，启动命令为 `bash deploy/panel-start.sh`，端口 `3000`，运行用户 `www`。也可使用 PM2：

```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup
```

---

## 3. 小皮面板（phpStudy 面板）

小皮面板以 PHP 环境为主，部署 Node.js 应用同样采用「面板管理域名与证书，应用监听 3000 端口」的方式。

### 3.1 安装 Node.js v24

1. 打开面板「软件商店」，如存在 **Node.js / Node 版本管理**，直接安装 **v24**；
2. 否则手动安装：
   - Windows：从 <https://nodejs.org/zh-cn/download> 下载 v24 的 `.msi` 安装包，安装时勾选 Add to PATH，安装完成后重新打开面板终端；
   - Linux：执行 `curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`。

验证：在面板终端执行 `node -v`，输出 `v24.x` 即安装成功。

### 3.2 上传项目并执行准备命令

1. 将项目解压至站点目录（Windows 默认 `C:\phpstudy_pro\WWW\lczoj`，Linux 默认 `/www/wwwroot/lczoj`）；
2. 在面板终端执行：

```bash
cd /www/wwwroot/lczoj            # Windows：cd /d C:\phpstudy_pro\WWW\lczoj
node deploy/panel-install.js      # Windows 同样适用
```

如提示找不到 `node`，请重新打开终端窗口（环境变量需在新窗口中生效）。

### 3.3 创建站点并配置反向代理

1. 面板 → 「网站」→ 「创建网站」，填写域名，PHP 版本可任选（本站不使用 PHP）；
2. 进入该站点 → 「配置文件」，将 `deploy/panel-nginx.conf` 的内容合并到 `server { }`（修改 `server_name` 为实际域名）；如面板提供「反向代理」功能，也可直接填写目标 `http://127.0.0.1:3000`；
3. 若小皮使用 **Apache**，改用以下配置（需启用 `mod_proxy` 与 `mod_proxy_http`）：

```apache
ProxyPreserveHost On
ProxyPass        / http://127.0.0.1:3000/ retry=0 timeout=300
ProxyPassReverse / http://127.0.0.1:3000/
```

4. Windows 环境还需在系统防火墙中放行 80 与 443 端口。

### 3.4 申请 SSL 证书

站点 → 「SSL / 证书」→ 申请 Let's Encrypt 免费证书（或上传已有证书）→ 开启强制 HTTPS。

### 3.5 开机自启（可选）

- **Windows**：面板 → 计划任务 → 添加任务，执行程序 `cmd`，参数 `/c "cd /d C:\phpstudy_pro\WWW\lczoj && deploy\panel-start.bat"`，触发方式选择开机启动；
- **Linux**：`pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup`。

---

## 4. 版本更新

```bash
node deploy/update.js            # 检查新版本 → 备份数据库 → 覆盖代码 → 自动重启
node deploy/update.js --check    # 仅检查是否有新版本
```

脚本会自动识别服务启动方式（PM2 / systemd / `deploy/panel.pid`）并执行对应重启操作。数据目录 `data/` 不受影响。

使用内置 `admin` 账号登录后，也可在「系统设置（`#/settings`） → 版本更新」中完成同样的操作。
完整说明见 [UPDATE.md](UPDATE.md)。

---

## 5. 启动参数

参数保存在 `deploy/panel.env`（由 `panel-install.js` 生成），修改后执行 `--stop` 再 `--start` 生效：

```ini
PORT=3000              # 服务端口；面板站点的 80/443 由 Nginx 使用，故此处使用 3000
OJ_HOST=127.0.0.1      # 仅允许本机访问（由 Nginx 反向代理），安全性更高
OJ_MAX_JUDGES=4        # 并行判题数，按服务器核数调整，建议保留 1~2 核给系统
TZ=Asia/Shanghai       # 时区（影响页面显示时间）
```

修改 `PORT` 后需同步修改反向代理的目标地址，否则会出现 502。

---

## 6. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `Cannot find module 'node:sqlite'` | Node.js 版本过低，安装 v24；或临时将启动命令改为 `node --experimental-sqlite server.js` |
| 502 Bad Gateway | 后端未启动或端口不一致。先执行 `node deploy/panel-install.js --start` 确认就绪，再查看日志 `logs/lczoj.log`（PM2 用户：`pm2 logs lczoj`） |
| 直接访问 `IP:3000` 无响应，域名可访问 | 属正常现象：`OJ_HOST=127.0.0.1` 表示仅允许本机访问 |
| 页面样式异常 | 反向代理「目标 URL」不应包含路径，应为 `http://127.0.0.1:3000` |
| 上传答案压缩包报 413 | 站点配置中增加 `client_max_body_size 64m;`（生成的 `panel-nginx.conf` 已包含） |
| 题库保存失败或数据库报错 | `data` 目录权限不足：`chown -R www:www 项目目录/data`；Windows 在面板权限设置中为站点用户授予读写权限 |
| 页面时间相差 8 小时 | 在 `deploy/panel.env` 中设置 `TZ=Asia/Shanghai` 后重启服务 |
| 提交后长期处于「判题中」 | 缺少该语言的编译器（`node deploy/check-env.js` 会标记），或重启服务时打断了评测；重新提交即可 |
| 服务器重启后站点未启动 | 按第 2.5 / 3.5 节配置开机自启（Node 项目 / PM2 / 计划任务） |

---

## 7. 备份与迁移

- **备份**：将 `data` 目录完整下载即可（包含数据库 `oj.db`、题库测试数据、附件与头像）。建议在面板中创建定时打包任务；
- **迁移**：在新服务器按本文完成部署后，用备份的 `data` 目录覆盖即可。

---

## 8. 其它部署方式

- Docker（一键脚本，未安装 Docker 时自动安装）：[DOCKER.md](DOCKER.md)
- 普通 Linux（一键脚本 / systemd）：[DEPLOYMENT.md](DEPLOYMENT.md)
- 版本更新与回滚：[UPDATE.md](UPDATE.md)
- 环境自检：`node deploy/check-env.js`
