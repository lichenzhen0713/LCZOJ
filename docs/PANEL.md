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

### 3.0 三步快路径（推荐，十分钟内上线）

> 下面的 3.1~3.10 是完整体（含参数、故障、验收），**首次部署照这三步就够**。

```
① 装 Node v24（面板软件商店有 Node 版本管理就一键装；否则 nodejs.org 下 .msi，勾 Add to PATH，重开终端）
     验证：node -v   →  v24.x

② 双击项目里的 deploy\xiaopi-onekey.bat
     （等价于 node deploy/xiaopi-onekey.js；想换端口加 --port 8080）
     它会自动准备数据目录、写好启动参数、后台启动、并生成 deploy/xiaopi.conf
     ★ 结束时屏幕上会打印 admin 初始密码，记下来

③ 小皮面板 → 网站 → 创建网站（填域名，PHP 随便选）→ 该站点「配置文件」→
     把屏幕上那 9 行（也存于 deploy/xiaopi.conf）粘进 server { } → 重载配置 →
     浏览器打开 http://你的域名/ ，用 admin + 初始密码登录并改密码
```

**只要记住一句**：面板管域名和证书，LCZOJ 自己跑在 `127.0.0.1:3000`，中间用反代连起来。

常用的就三个命令：

| 命令 | 作用 |
| --- | --- |
| `deploy\xiaopi-onekey.bat --check` | 只看环境（不改文件、不启动） |
| `deploy\xiaopi-onekey.bat` | 一键准备好并后台启动 |
| `node deploy\update.js` | 升级到新版本（先备份数据库） |



小皮面板以 PHP 环境为主，本站不使用 PHP —— **面板只负责域名、证书与反向代理**；LCZOJ 自己监听 `3000` 端口，由面板的 Nginx（或 Apache）转发过去。

> 为什么不用 80 端口直连：小皮面板的站点/面板本身要占用 80 与 443，把 OJ 也设成 80 会冲突。标准做法就是 `OJ_HOST=127.0.0.1` + `PORT=3000` + 反代。

### 3.1 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.5**（项目用 Node 内置的 `node:sqlite`，低于 22.5 直接起不来；推荐 **v24**） |
| 磁盘 | 代码 + 依赖 0（**无需 `npm install`**）；预留 `data/` 与判题缓存空间 |
| 端口 | 面板占 80/443；OJ 用 **3000**（可改） |
| 系统 | Windows（小皮 Windows 版）或 Linux（小皮 Linux 版），命令基本一致 |

### 3.2 安装 Node.js

1. 打开面板「软件商店」，若有 **Node.js / Node 版本管理**，直接安装 **v24**；
2. 否则手动装：
   - **Windows**：<https://nodejs.org/zh-cn/download> 下载 v24 的 `.msi`，安装时勾选 **Add to PATH**；装完**重新打开面板终端**（旧窗口读不到新的环境变量）；
   - **Linux**：`curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`。
3. 验证（必须看到 v22.5 以上）：
   ```bash
   node -v
   ```

### 3.3 上传代码

1. 解压到站点目录：
   - Windows 默认 `C:\phpstudy_pro\WWW\lczoj`
   - Linux 默认 `/www/wwwroot/lczoj`
   - 路径建议**纯英文、无空格**；
2. 解压后目录里应能看到：`server.js`、`package.json`、`public/`、`src/`、`deploy/`、`docs/`；
3. **不需要** `npm install`（零 npm 依赖）。

### 3.4 一键准备 + 启动

```bash
cd /d C:\phpstudy_pro\WWW\lczoj      # Linux: cd /www/wwwroot/lczoj
node deploy\panel-install.js --check   # 可选：只检查环境，什么都不改
node deploy\panel-install.js           # 一键准备 + 后台启动
```

它会依次完成：检查 Node 版本 → 建 `data/` 并验可写 → 写 `deploy/panel.env`（`PORT=3000`、`OJ_HOST=127.0.0.1`、`OJ_MAX_JUDGES=4`）→ 尝试安装评测语言编译器 → 启动服务（`deploy/panel.pid`，日志 `logs/lczoj.log`）→ 生成可直接粘贴的 `deploy/panel-nginx.conf` → 跑环境自检 → 列出面板上接下来点哪里。

**首次启动会打印管理员初始密码**（同时写入 `data/admin-password.txt`，仅首次生成）：

```
管理员账号: admin　初始密码: xxxxxxxx
```

> 记下它，登录后**立刻改密码**。忘了见 `docs/FAQ.md` 的重置方法。

常用参数：

| 命令 | 作用 |
| --- | --- |
| `node deploy\panel-install.js --start` / `--stop` | 只启动 / 停止后台服务 |
| `--port 8080` | 换端口（要与反代保持一致） |
| `--host 0.0.0.0` | 允许不经反代、直接用 `IP:端口` 访问 |
| `--no-compilers` | 跳过评测语言安装 |
| `node deploy\check-env.js` | 环境自检（判题语言是否可用等） |

### 3.5 建站 + 反向代理

1. 面板 →「网站」→「创建网站」，填域名，**PHP 版本任选**（本站不使用 PHP）；
2. 进入站点 →「配置文件」，把 `deploy/panel-nginx.conf` 的内容合并进 `server { }`，并把 `server_name` 改成你的域名；
   若面板提供「反向代理」入口，也可直接新建：目标 URL `http://127.0.0.1:3000`，发送域名 `$host`；
3. 三个关键项（少了会出故障）：
   ```nginx
   client_max_body_size 64m;        # 太小 → 上传答案包/提交大代码报 413
   location / { proxy_pass http://127.0.0.1:3000;
                proxy_http_version 1.1;
                proxy_read_timeout 300s;   # 必须大于服务端 keepAliveTimeout(65s)
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto $scheme; }
   ```
4. 若小皮用的是 **Apache**，启用 `mod_proxy` / `mod_proxy_http` 后改用：
   ```apache
   ProxyPreserveHost On
   ProxyPass        / http://127.0.0.1:3000/ retry=0 timeout=300
   ProxyPassReverse / http://127.0.0.1:3000/
   ```
5. **重载 Nginx / 重启 Apache** 使配置生效。

### 3.6 防火墙放行（Windows）

```powershell
netsh advfirewall firewall add rule name="LCZOJ-80"  dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="LCZOJ-443" dir=in action=allow protocol=TCP localport=443
```

云服务器还要在**安全组**里放行 80/443（不建反代、直接用端口访问时放行 3000）。

### 3.7 申请 SSL

站点 →「SSL / 证书」→ 申请 **Let's Encrypt** 免费证书（或上传已有证书）→ 开启**强制 HTTPS**。

### 3.8 开机自启（可选，二选一）

- **面板计划任务**（推荐，Windows）：面板 →「计划任务」→ 添加任务
  - 执行程序：`cmd`
  - 参数：`/c "cd /d C:\phpstudy_pro\WWW\lczoj && deploy\panel-start.bat"`
  - 触发方式：**开机启动**（或每分钟检测进程是否存活）
- **PM2**：`pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup`
  （自行用 PM2 托管时，先 `node deploy\panel-install.js --stop` 停掉脚本启动的进程，避免两份）

### 3.9 验收清单（逐项打勾）

- [ ] `http://你的域名/` 能打开首页，且 `/api/health` 返回 `{"success":true,"status":"up"}`
- [ ] 用 `admin` + 初始密码登录成功，**已修改密码**
- [ ] 后台「系统设置」→ 站点名称/Logo 能保存
- [ ] 提交一次 Python 题解并得到 AC（未装的语言在提交页显示「未安装」）
- [ ] 上传较大的答案包（>32MB）不报 **413**（`client_max_body_size 64m` 已生效）
- [ ] 页面时间显示为东八区（`TZ=Asia/Shanghai`）
- [ ] 重启机器后面能自动恢复（计划任务/PM2 生效）

### 3.10 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 站点打不开、反代 502 | 服务没起：`node deploy\panel-install.js --start`；或 `OJ_HOST` 不是 `127.0.0.1` 与反代不一致 |
| 本机 `curl 127.0.0.1:3000` 通、外网不通 | 防火墙/安全组没放行 80/443 |
| 报 `node:sqlite` / 启动即退出 | Node 版本 < 22.5，装 v24 |
| 上传报 **413** | 站点配置缺 `client_max_body_size 64m` |
| 判题一直 Pending / 语言「未安装」 | Windows 需自己装 Python / Dev-Cpp（含 g++），装完 `node deploy\check-env.js` 复核 |
| 忘记管理员密码 | 见 `docs/FAQ.md`（不会明文保存，需按文档重置） |
| 想换端口 | `node deploy\panel-install.js --port 8080`，同步改反代 `proxy_pass` |
| 更新到新版本 | `node deploy\update.js`（会先备份数据库再覆盖代码并重启） |

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
