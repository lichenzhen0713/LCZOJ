# 常见问题 FAQ

## 运行与部署

### Q1. 启动报错 `node:sqlite` 找不到 / 需要 Node 22.5+？

Node.js 版本过低。`node:sqlite` 内置模块要求 **Node.js ≥ 22.5**，推荐 24.x LTS。

- Windows：https://nodejs.org/zh-cn/download 下载安装包
- Debian/Ubuntu：`curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`

> 如果当前正好是 Node 22.5 ~ 23.3，程序会**自动带 `--experimental-sqlite` 重启一次**；实在不可用会打印中文处理办法。
> 想先看环境到底缺什么，跑一条命令：`node deploy/check-env.js`（Node 版本、端口占用、数据目录权限、各语言编译器一次看清）。

### Q1.5 如何用 Docker 部署？如何用宝塔 / 小皮面板部署？

- **Docker**：全新服务器使用一行脚本（未安装 Docker 时会自动安装）：
  `curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/docker-bootstrap.sh | sudo bash`；
  项目已在服务器上时执行 `node deploy/docker-onekey.js`（未安装 Docker 时同样会自动安装，随后构建、启动并等待就绪）。
  也可使用 `docker compose up -d --build`。详见 [DOCKER.md](DOCKER.md)；
- **宝塔面板 / 小皮面板**：先安装 Node.js v24，再执行 `node deploy/panel-install.js` ——
  该命令会准备环境、后台启动服务并生成可直接粘贴的反向代理配置 `deploy/panel-nginx.conf`；
  随后在面板中将该配置合并到站点配置（或使用「反向代理」指向 `http://127.0.0.1:3000`）并申请 SSL 证书。详见 [PANEL.md](PANEL.md)。

### Q1.55 如何更新到新版本？

推荐在管理后台操作：登录 `admin` 账号 → 管理后台 → 系统设置 → **版本更新** → 勾选「更新前备份数据库」→ 点击「立即更新」，页面会显示各阶段进度并自动重启服务。

也可使用命令行：

```bash
node deploy/update.js            # 检查 → 备份数据库 → 覆盖代码 → 自动重启
node deploy/update.js --docker   # Docker 部署使用此项（重建镜像与容器，数据卷保留）
node deploy/update.js --check    # 仅检查是否有新版本
```

数据保存在 `data/`（Docker 为数据卷）中，更新仅覆盖程序文件，题库与提交记录不受影响。
完整的更新方式、回滚方法与常见问题见 [UPDATE.md](UPDATE.md)。

### Q1.6 部署完不确定环境对不对？

跑一条命令：`node deploy/check-env.js`。它会逐项告诉你：Node 版本够不够、端口被谁占用（能认出是不是 LCZOJ 自己）、数据目录能不能写、剩余磁盘、每种评测语言的编译器是否就绪，并直接给出修复命令。

### Q2. 端口 80 被占用？

```bash
PORT=8080 node server.js     # Linux
set PORT=8080 && node server.js   # Windows CMD
```

面板部署时这是**正常现象**（面板 Nginx 占着 80），让本站改用 3000 端口并做反向代理即可，见 [PANEL.md](PANEL.md)。

### Q3. 如何让服务开机自启 / 常驻？

- Linux：systemd（见 [DEPLOYMENT.md](DEPLOYMENT.md) 第 2.3 节，或直接用 `deploy/lczoj.service` 模板）；
- 面板：宝塔「Node 项目」/ PM2 管理器，小皮「计划任务 / PM2」，见 [PANEL.md](PANEL.md)；
- Windows：NSSM 注册服务，或用 `deploy\panel-start.bat` 配合「任务计划程序」；
- 容器：`restart: unless-stopped`（compose 已默认开启）。

### Q3.5 进入管理后台需要什么条件？

登录后侧边栏底部会显示「管理后台」入口（`#/admin`）。需要：

1. 账号具备至少一项管理权限（由超级管理员在用户管理中授予）；
2. 无权限时会提示「你没有管理后台权限」。

若刷新后整个页面（含侧边栏）无法操作，多为浏览器缓存了旧版前端脚本，请强制刷新（Ctrl+F5）或清除站点缓存。

### Q3.6 讨论 / 题解评论区只显示 10 条？

回复 / 评论**超过 10 条自动分页**（每页 10 条），在评论区下方翻页查看。

## 评测相关

### Q4. 答案与标准输出只有行末空格 / 末尾换行不同，会被判错吗？

不会。评测时自动忽略每行行末的空格与 Tab、文件末尾多余的换行（`\r\n` 与 `\n` 均统一处理），与洛谷行为一致；只有非空白字符不同才判 WA。

### Q4.5 提交后一直 Pending？

1. 查看服务端控制台是否有报错；
2. 确认对应语言工具链已安装（`install.sh` 启动时会打印检测结果；或运行 `python3 --version`、`g++ --version` 等验证）；
3. 未安装的语言在提交面板中显示「未安装」，不可选。

### Q5. 评测结果为 SE（System Error）？

通常是工具链执行异常（如编译器崩溃、工作目录不可写）。查看服务端日志定位。

### Q6. C++ 编译报错找不到库？

C/C++ 使用 `-static` 静态链接；若系统缺少 32 位库或静态库（如某些发行版未安装 `libstdc++-static`），可去掉 `-static` 或安装对应包（Debian: `libstdc++-dev`）。

## 功能相关

### Q7. 为什么页面数学公式显示为源代码？

浏览器无法加载 KaTeX CDN（jsdelivr/unpkg/cdnjs/bootcdn 均不可达）时会使用内置渲染器；仍显示源码说明内容并非标准 LaTeX 写法，请使用 `$...$`（行内）或 `$$...$$`（块级）。

### Q8. 如何修改首页 / 帮助中心等页面内容？

管理后台 → 系统设置 → 站点页面与版权（仅 admin 账号），全部支持 Markdown 与实时预览。

### Q9. 如何给普通用户管理员权限？

管理后台 → 用户管理 → 点击该用户的「管理权限」按钮，勾选所需权限；勾选全部 8 项即为超级管理员。
「题解审核 / 专栏审核」权限**只能审核**；「题解管理 / 专栏管理」权限**可审核且可编辑、删除**。

### Q9.5 管理员如何修改用户资料或重置密码？

管理后台 → 用户管理 → 该行「编辑资料」按钮：可修改昵称 / 邮箱 / 简介，并可选重置密码（内置 admin 账号不可修改）。

### Q9.6 提交记录页为什么看不到别人的提交？

提交记录列表**默认只看自己的**（后端强制，未登录时提示先登录）。想查看某位用户或某道题的提交，在筛选栏输入「用户名 / 用户 ID」或「题目 ID」后点筛选即可（含比赛提交记录）；系统不提供未过滤的全站提交列表。

### Q10. 比赛 Rating 不结算？

Rated 比赛结束后，需管理员在比赛详情页点击「结算 Rating」（需要 `contest` 权限）。若参赛人数不足 2 人，会标记为已结算但跳过（记为 `skipped`）。

### Q10.5 忘记密码怎么办？

登录页 → 「忘记密码？」→ `#/forgot-password`。**前提**：管理员已在系统设置中开启「邮箱验证」；输入注册邮箱获取验证码（未配置 SMTP 时页面直接展示验证码），验证后设置新密码。

### Q10.6 如何反馈问题 / 举报用户？

页脚「反馈与举报」（`#/feedback`）：选择类型（反馈 / Bug 报告 / 建议 / 举报）并填写内容。超级管理员在「管理后台 → 反馈审核」中处理，回复会展示在你的反馈记录中。

### Q11. 邮箱验证收不到邮件？

1. 确认 SMTP 配置正确（126/QQ 邮箱需使用「授权码」而非登录密码）；
2. 使用「发送测试邮件」验证；
3. 未配置 SMTP 时，验证码会直接显示在注册页面，不影响流程。

## 数据

### Q12. 忘记管理员密码？

执行重置脚本清空数据并重建管理员账号（**会丢失全部数据**，请先备份 `data/`）；重建后**初始密码会在下次启动时随机生成**，启动日志会打印，并写入 `data/admin-password.txt`：

```bash
node deploy/reset.js --check     # 先预览将要执行的操作（不做修改）
node deploy/reset.js --yes       # 停止服务 → 清空数据 → 完成
node deploy/reset.js --daemon --yes   # 清空后立即后台启动
```

Windows 双击 `reset.bat`、Linux / macOS 执行 `./reset.sh` 效果相同（都是 `deploy/reset.js` 的入口）。
若希望保留数据只重置密码，可联系维护者手动写入密码哈希，或直接修改 `data/oj.db` 中该用户的 `password_hash`。

### Q12.5 重置脚本（reset）执行后数据没被清空？

常见原因：服务仍被守护进程托管并立即拉起（systemd `Restart=always` / PM2 / 面板 Node 项目），数据目录被重新创建。当前脚本会自动处理这些情况：按 **systemd → PM2 → `deploy/panel.pid` → 端口监听** 的顺序停止服务，并确认端口已释放后再删除数据。若仍失败：

1. 先执行 `node deploy/reset.js --check` 查看它识别到的启动方式与将要结束的进程；
2. systemd 部署且提示权限不足时，先 `sudo systemctl stop lczoj`；
3. 面板托管时先在面板中停止对应的 Node 项目；
4. 删除失败会在输出中列出**被占用的文件**（例如杀毒软件、编辑器、资源管理器预览占用），关闭后重试。

### Q13. 如何备份 / 迁移？

直接复制 `data/` 目录到新机器对应位置即可（SQLite 单文件 + 测试数据目录）。

### Q14. 添加新语言需要改代码吗？

是的，但只需编辑 `src/config.js` 的 `LANGUAGES` 与 `TOOLCHAIN_CANDIDATES`，详见 [LANGUAGES.md](LANGUAGES.md) 第 4 节。

## 安全

### Q15. 可以部署到公网吗？

评测会执行用户提交的任意代码，当前仅做了时间限制与进程树终止，**未做操作系统级隔离**。请勿直接暴露公网；如确需公网，建议：
- 部署在 Docker / VM 中，仅映射 HTTP 端口；
- 限制注册（邮箱验证 + 管理员审核）；
- 定期备份数据并监控日志。
