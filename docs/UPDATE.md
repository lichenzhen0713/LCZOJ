# 版本更新指南

本文说明 LCZOJ 的版本更新（升级）方式：更新内容、四种更新途径的具体操作步骤、按部署方式对应的重启命令、更新后的确认项、回滚方法与常见问题。

> **管理后台更新入口**：登录 `admin` 账号 → 管理后台 → 系统设置 → **版本更新**，可在网页上完成「检查更新 / 一键更新」。

---

## 1. 更新影响范围

| 项目 | 是否受影响 | 说明 |
| --- | --- | --- |
| 程序代码（`server.js`、`src/`、`public/`、`docs/`、`deploy/`、`Dockerfile` 等） | **会被覆盖** | 更新即用新版本文件替换旧版本文件 |
| 数据库 `data/oj.db` | 不受影响 | 表结构由程序启动时的迁移逻辑自动升级，无需手工处理 |
| 题库测试数据 `data/testdata/`、题目附件 `data/attachments/`、用户头像 `data/avatars/` | 不受影响 | 更新脚本显式跳过整个 `data/` 目录 |
| 本地配置 `deploy/panel.env` | 不受影响 | 更新脚本显式跳过该文件 |
| 日志 `logs/`、版本库元数据 `.git/`、`node_modules/` | 不受影响 | 同样在跳过列表中 |
| Docker 数据卷 `lczoj-data` | 不受影响 | 重建容器不会删除数据卷 |

更新前的备份：更新脚本会先把 `data/oj.db` 复制到 `data/backup/oj-<旧版本>-<时间>.db`（最多保留最近 10 份）；`data/` 下的题库数据、附件、头像在此次更新中没有变动，无需额外备份。

---

## 2. 四种更新方式对照

| 方式 | 适用场景 | 入口 | 是否自动重启 |
| --- | --- | --- | --- |
| **管理后台一键更新** | 管理员希望全程在网页上完成 | 管理后台 → 系统设置 → 版本更新 | 是 |
| **命令行一键更新** | 有服务器终端权限，需要脚本化/无人值守 | `node deploy/update.js` | 是 |
| **Docker 更新** | 使用 Docker / Compose 部署 | `node deploy/update.js --docker` 或重新构建镜像 | 是 |
| **手动更新** | 服务器无法访问外网，或需要精确控制每一步 | 手工下载并覆盖代码 | 否（手动重启） |

四种方式最终效果一致：**用新版本的程序文件替换旧文件，然后重启服务**。

---

## 3. 方式一：管理后台一键更新（推荐）

### 3.1 前置条件

- 使用最高管理员账号 `admin` 登录（其他管理员即使拥有「系统设置」权限也无法看到该功能）；
- 服务器能够访问 **Gitee**（默认更新源，`https://gitee.com/Carter_Zane/LCZOJ`）；Gitee 不可达时会自动回退 GitHub；
- 如需使用自建仓库或内网镜像，可通过环境变量指定（支持多个地址，按顺序尝试，用英文逗号分隔）：

  | 环境变量 | 用途 | 默认值 |
  | --- | --- | --- |
  | `OJ_UPDATE_URL` | 版本号检查地址（返回 `package.json` 的 JSON） | `https://gitee.com/Carter_Zane/LCZOJ/raw/master/package.json` |
  | `OJ_UPDATE_ZIP_URL` | 源码包下载地址（zip） | `https://gitee.com/Carter_Zane/LCZOJ/repository/archive/master.zip` |

  这两个变量在启动服务前设置（面板部署写入 `deploy/panel.env`，systemd 写入 `Environment=`，Docker 写入 compose 的 `environment`）。

### 3.2 操作步骤

1. 登录后台 → **管理后台 → 系统设置**，页面顶部显示当前版本号；
2. 在「**版本更新**」区块中查看当前版本与官方最新版本（区块内会同时显示服务的启动方式，例如 PM2、systemd 或面板脚本后台进程）；
3. 需要时点击「**重新检查**」重新获取最新版本号；
4. 勾选「更新前备份数据库」（默认勾选），点击「**立即更新到 vX.Y.Z**」，在确认框中确认；
5. 页面显示实时进度日志，阶段依次为：检查最新版本 → 备份数据库 → 下载新版本代码 → 覆盖代码文件 → 重启服务；
6. 进入「重启服务」阶段后页面提示「服务正在重启，N 秒后自动刷新」，倒计时结束后自动刷新，刷新后版本号应变为新版本。

### 3.3 更新源与更新包校验

**更新源**：默认 **Gitee 优先**，失败自动回退 GitHub；每个源的连接超时为 8 秒。检查结果中会记录本次实际使用的来源（Gitee / GitHub / 自定义源）以及每个源的尝试结果，界面与接口都会展示，便于定位网络或仓库问题。

**更新包校验**：源码包在写入前会做整体校验，任一项不通过即**中止更新且不修改任何文件**：

| 校验项 | 说明 |
| --- | --- |
| 合并冲突标记 | 代码与文本文件中不得残留 `<<<<<<<` / `=======` / `>>>>>>>`（仓库未正确合并时最常见） |
| `package.json` | 必须是合法 JSON（否则版本号无法读取） |
| `server.js` | 必须通过语法检查（`vm` 编译，不执行） |

校验失败时，界面与命令行都会给出具体文件与原因；数据库备份已完成、程序文件保持原状，修复仓库后重新执行更新即可。
版本检查阶段若源返回内容不是合法 JSON，会尽力从文本中解析版本号，并在界面提示「源内容格式异常」，提示管理员检查仓库文件。

### 3.4 说明与限制

- 更新过程中网站不可用约 5~20 秒（取决于重启速度）；
- 若当前版本已是最新，界面只显示「已是最新版本」；如需强制重新拉取代码，可点击「**强制重新拉取代码**」；
- **Docker 部署注意**：容器内执行更新只对当前容器有效，容器被重建（`docker compose up` 创建新容器）后会回到镜像内的版本。Docker 部署请在宿主机执行 `node deploy/update.js --docker`，界面也会显示相应提示；
- 更新失败时区块内显示错误信息与完整日志，可按本文第 9 节排查；此时程序文件可能处于部分覆盖状态，建议按第 8 节回滚后再重试。

---

## 4. 方式二：命令行一键更新

在项目目录执行：

```bash
node deploy/update.js             # 检查 + 更新 + 重启（更新前自动备份数据库）
node deploy/update.js --check     # 只检查有没有新版本，不做任何修改
node deploy/update.js --yes       # 不询问，直接更新（适合脚本化）
node deploy/update.js --no-backup # 跳过数据库备份
node deploy/update.js --no-restart# 只更新代码，不自动重启
node deploy/update.js --force     # 已是最新版本时也强制重新拉取代码
node deploy/update.js --docker    # Docker 部署：重新构建镜像 + 重建容器
```

执行流程：

1. **检查最新版本**：依次请求 GitHub、Gitee（或 `OJ_UPDATE_URL` 指定的地址），比较版本号；已是最新且未加 `--force` 时直接结束；
2. **备份数据库**：复制 `data/oj.db` 到 `data/backup/`；
3. **更新代码**：项目是 git 仓库时执行 `git pull --ff-only`；否则下载官方源码包并只覆盖代码文件（跳过 `data/`、`logs/`、`.git/`、`node_modules/`、`deploy/panel.env`）；
4. **重启服务**：按检测到的启动方式执行重启（见下一节）。

命令行输出以 `[信息] / [注意] / [完成]` 标注，并列出更新前后的版本号。

### 4.1 重启行为对照

| 检测到的启动方式 | 判断依据 | 重启动作 |
| --- | --- | --- |
| PM2 | 存在名为 `lczoj` 的应用，且该应用进程号与当前进程一致 | `pm2 restart lczoj --update-env` |
| systemd（有自动重启策略） | 存在 `lczoj.service`、处于激活状态、单元主进程号与当前进程一致，且 `Restart=always / on-failure` 等 | 程序直接退出，由 systemd 自动拉起（**不需要 root 权限**） |
| systemd（无自动重启策略） | 同上但 `Restart=no` | `systemctl restart lczoj`；非 root 时自动回退 `sudo -n systemctl restart lczoj`，均失败则提示手动执行 |
| 面板脚本后台进程 | 存在 `deploy/panel.pid` | 由 `deploy/restart-helper.js` 等待旧进程退出后，用相同参数在后台拉起新进程，并更新 `deploy/panel.pid` |
| 直接运行（无守护） | 以上均不满足 | 同上，由重启助手拉起新进程（日志追加到 `logs/lczoj.log`） |

> 判定会核对进程号：如果只是**存在**同名 PM2 应用或 `lczoj.service` 单元，但当前进程并非由它们启动（例如手工执行过 `node server.js`），则不会交给它们重启，避免出现两个实例争抢端口。

**无需任何权限的自动重启（推荐）**：若 systemd 单元配置了 `Restart=always`（`on-failure` 等亦可），更新完成后程序会直接退出，由 systemd 自动拉起新进程 —— 这是系统内置部署脚本的默认配置，因此 Linux 一键脚本 / 手动 systemd 部署通常都能自动重启，无需 sudo。

### 4.2 systemd 部署：重启权限

systemd 托管的服务通常以普通用户（如 `www`）运行，该用户默认无权执行 `systemctl restart`。更新流程按以下顺序处理：

1. **单元配置了自动重启时（推荐，默认即如此）**：`deploy/lczoj.service` 与安装脚本生成的单元均为 `Restart=always`，此时**无需任何权限**——更新完成后程序直接退出，由 systemd 自动拉起新进程（`Restart=on-failure` 等策略同样适用，程序会以非 0 退出码结束以确保被拉起）。界面会显示「服务正在重启」并自动刷新页面。
2. 否则先直接执行 `systemctl restart lczoj`；
3. 失败则尝试免密 sudo：`sudo -n systemctl restart lczoj`（`-n` 表示不询问密码，无权限时立即失败，不会卡住）；
4. 以上都不可行时**不再判定为更新失败**：程序代码此时已经更新完成，界面会提示「代码已更新完成，请手动执行：`sudo systemctl restart lczoj`」，并在日志中给出具体失败原因。

**检查与配置**：

```bash
# 查看单元是否配置了自动重启（always / on-failure 均可）
systemctl show -p Restart --value lczoj

# 若为 no，可在单元中加上 Restart=always 后重载（推荐，之后更新会自动重启）
sudo sed -i 's/^Restart=.*/Restart=always/' /etc/systemd/system/lczoj.service
sudo systemctl daemon-reload && sudo systemctl restart lczoj

# 或者授予最小权限的重启 sudo 规则（同样只需执行一次）
sudo bash deploy/grant-restart-permission.sh
sudo bash deploy/grant-restart-permission.sh --user www   # 手动指定服务运行用户
sudo bash deploy/grant-restart-permission.sh --remove     # 撤销
```

`grant-restart-permission.sh` 写入 `/etc/sudoers.d/lczoj-restart`，仅授予运行用户对**本服务**的 `restart / start / stop / is-active` 权限（其它 systemctl 操作仍不允许），并用 `visudo -cf` 校验语法，校验不通过会自动回滚。

---

## 5. 方式三：Docker 部署更新

三种做法任选其一（数据卷 `lczoj-data` 均不受影响）：

```bash
# ① 在宿主机项目目录执行（重新构建镜像并重建容器）
node deploy/update.js --docker

# ② 重新执行一次 Docker 一行部署脚本（自动拉取新代码并重建）
curl -fsSL https://raw.githubusercontent.com/Carter_Zane/LCZOJ/main/docker-bootstrap.sh | sudo bash

# ③ 手动拉取代码后重建
git pull
docker compose up -d --build
```

镜像标签为 `lczoj:<版本号>`（例如 `lczoj:2.0.2`），旧标签会保留在本机，可用于回滚：

```bash
# 查看本机已有镜像
docker images lczoj

# 用旧版本镜像重新启动容器（数据卷不变）
docker rm -f lczoj
docker run -d --name lczoj --restart unless-stopped -p 80:80 \
  -v lczoj-data:/app/data lczoj:2.0.1
```

更新完成后确认：`docker compose ps` 显示 `healthy`，或访问 `/api/health` 查看版本号。

---

## 6. 方式四：手动更新（不依赖脚本）

适用于服务器无法访问外网，或希望精确控制每一步的场景。

1. **停止服务**（按部署方式选择对应命令，见第 7 节）；
2. **备份数据目录**：

   ```bash
   cp -r data ~/lczoj-data-backup-$(date +%Y%m%d)
   ```

3. **取得新版本程序文件**：在能上网的机器上下载项目压缩包，上传到服务器；
4. **覆盖程序文件**：把新版本文件复制到项目目录，**保留以下内容**：
   `data/`、`logs/`、`deploy/panel.env`、`.git/`（若使用 git 管理）；
5. **启动服务**；
6. **确认版本**：访问 `/api/health`，返回的 `version` 字段应为新版本号；管理后台 → 系统设置 的版本号也应同步变化。

使用 git 管理代码时，推荐：

```bash
git fetch --all
git checkout .          # 放弃本地对程序文件的修改（data/ 已在 .gitignore 中，不受影响）
git pull --ff-only
```

---

## 7. 各部署方式的重启命令

| 部署方式 | 重启命令 |
| --- | --- |
| systemd | `sudo systemctl restart lczoj` |
| PM2 | `pm2 restart lczoj --update-env` |
| 宝塔 / 小皮面板（Node 项目托管） | 面板内对应项目点击「重启」 |
| 面板一键脚本（后台进程） | `node deploy/panel-install.js --stop && node deploy/panel-install.js --start` |
| Docker Compose | `docker compose restart`（代码更新需 `docker compose up -d --build`） |
| Docker（不用 compose） | `docker restart lczoj` |
| 直接运行（前台） | `Ctrl+C` 后重新执行 `node server.js` |
| Windows（前台） | 关闭窗口后重新执行 `node server.js` |

---

## 8. 更新后的确认清单

1. `GET /api/health` 返回的 `version` 为新版本号；
2. 管理后台 → 系统设置 的版本号、`package.json` 的 `version`、启动日志中的版本号三处一致；
3. 浏览器强制刷新（`Ctrl+F5`）后页面正常：题库可打开、题面公式正常、提交代码可评测；
4. 提交记录与题库数据完整（更新不影响数据）；判题队列中若原有一次提交被打断，重新提交即可，超级管理员也可对题目执行重判；
5. 服务器无异常日志：`journalctl -u lczoj -f`（systemd）或 `pm2 logs lczoj`（PM2）或 `logs/lczoj.log`（面板脚本）。

---

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 更新后页面仍是旧版本 | 浏览器缓存。强制刷新（`Ctrl+F5`）或清理站点缓存；确认 `/api/health` 已返回新版本号 |
| 点击「重新检查」后提示无法获取版本信息 | 界面会列出每个更新源的失败原因（HTTP 状态、连接超时、内容中未找到 version 字段等）。检查服务器到 Gitee 的网络，或用 `OJ_UPDATE_URL` 指定可用镜像 |
| 提示「更新源返回的内容不是合法 JSON」 | 仓库中的 `package.json` 未同步完整或存在合并冲突标记。版本号是尽力解析的结果，请先修复仓库文件 |
| 提示「源码包校验未通过，已中止更新」 | 下载到的源码包含合并冲突标记、`package.json` 非 JSON 或 `server.js` 语法错误。此时**未修改任何文件**，请在代码仓库中修复后重新更新 |
| 提示「代码已更新完成，请手动执行 `sudo systemctl restart lczoj`」 | 服务由 systemd 托管而当前进程没有重启权限。按提示执行该命令即可生效；如需今后自动重启，执行一次 `sudo bash deploy/grant-restart-permission.sh` |
| 提示「无法下载源码包」 | 服务器无法访问 Gitee 与 GitHub。可设置 `OJ_UPDATE_ZIP_URL` 指向内网镜像，或采用方式四手动更新 |
| 更新时页面 502 / 连接中断 | 重启期间属正常现象，等待 5~20 秒后刷新即可；若长时间未恢复，检查进程与日志 |
| 点击更新提示「仅最高管理员可操作」 | 该功能限定内置 `admin` 账号，其他管理员不可用 |
| 提示「已有更新任务正在进行中」 | 上一次更新尚未结束，等待其完成后重试；如确认已中断，可重启服务后重试 |
| 更新后题库或提交记录缺失 | 数据位于 `data/`，请确认启动时的工作目录与 `OJ_DATA_DIR` 未改变；必要时从 `data/backup/` 恢复数据库后重启 |
| 更新后无法启动 | 查看日志中的报错（常见为 Node 版本过低、依赖缺失、端口占用）；可从备份压缩包恢复程序文件，或按第 10 节回滚 |
| Docker 更新后版本回到旧版 | 容器被重建，读的是镜像内的代码。请用 `node deploy/update.js --docker` 在宿主机更新，或改用方式三 |
| 需要回滚到旧版本 | 见下一节 |

---

## 10. 回滚方法

| 回滚对象 | 操作 |
| --- | --- |
| 程序代码（git 安装） | `git log --oneline` 找到目标版本，执行 `git checkout <commit>` 后重启服务 |
| 程序代码（压缩包安装） | 用旧版本压缩包按方式四覆盖程序文件（保留 `data/`）后重启 |
| 数据库 | 停止服务 → 从 `data/backup/` 选择对应时间的 `oj-<版本>-<时间>.db` 覆盖 `data/oj.db`（同时删除 `data/oj.db-wal`、`data/oj.db-shm`）→ 启动服务 |
| Docker | 用旧版本镜像标签重新启动容器（见第 5 节命令） |

> 数据库回滚会丢失备份时间点之后的提交与题目改动，仅在确有必要时使用。

---

## 11. 相关文件与接口

| 名称 | 说明 |
| --- | --- |
| `src/version.js` | 版本号比较与最新版本查询（成功缓存 6 小时，失败缓存 10 分钟，连不上时静默降级） |
| `src/updater.js` | 更新引擎：备份、下载、覆盖代码、重启（命令行与后台共用） |
| `deploy/update.js` | 命令行更新入口 |
| `deploy/restart-helper.js` | 无进程守护时负责拉起新进程 |
| `deploy/grant-restart-permission.sh` | （Linux / systemd）为服务运行用户配置最小权限的重启 sudo 规则 |
| `GET /api/version` | 查询当前版本与最新版本（需登录） |
| `GET /api/admin/update` | 查询版本信息、更新状态与启动方式（仅 admin） |
| `GET /api/admin/update/status` | 查询更新进度与日志（仅 admin） |
| `POST /api/admin/update/start` | 开始更新，参数 `{ backup, restart, force }`（仅 admin） |
