# OAuth 2.0 授权登录（第三方使用 LCZOJ 账号）

LCZOJ 内置一个最小可用的 **OAuth 2.0 授权码（Authorization Code）服务器**，让可信的第三方站点
（默认是 Lith Tools）在不接触 LCZOJ 密码、也不共享会话 Cookie 的前提下，拿到「当前用户是谁」。

典型用途：在 Lith Tools 登录页点击「使用 LCZOJ 账号登录」→ 跳转 LCZOJ 完成登录与授权 →
回到 Lith Tools 并自动创建 / 登录本地账号。

> 不配置 OAuth 时，`/api/oauth/*` 统一返回「未启用」，原有账号密码登录、注册、找回密码完全不受影响。

## 1. 配置

在 LCZOJ 的环境变量里配置（本地可写项目根目录 `.env`；面板部署写 `deploy/panel.env` 或面板的「环境变量」）：

```ini
OJ_OAUTH_CLIENT_ID=lith-tools
OJ_OAUTH_CLIENT_SECRET=请替换为随机密钥
OJ_OAUTH_CLIENT_NAME=Lith Tools
OJ_OAUTH_REDIRECT_URIS=http://127.0.0.1:8787/api/auth/lczoj/callback
```

| 变量 | 说明 |
| --- | --- |
| `OJ_OAUTH_CLIENT_ID` | 客户端标识，需与 Lith Tools 的 `LCZOJ_CLIENT_ID` 完全一致 |
| `OJ_OAUTH_CLIENT_SECRET` | 客户端密钥，需与 `LCZOJ_CLIENT_SECRET` 完全一致；数据库只保存 sha256 |
| `OJ_OAUTH_CLIENT_NAME` | 授权页展示的应用名 |
| `OJ_OAUTH_REDIRECT_URIS` | 允许的回调地址，多个用逗号 / 空格 / 换行分隔；**精确匹配**，不做通配 |

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

配置修改后需要重启 LCZOJ（启动时会把客户端 upsert 进 `oauth_clients` 表，密钥只存哈希）。

## 2. 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/oauth/authorize` | 授权入口；未登录会跳转到 `#/login?redirect=…`，登录后回到授权页 |
| POST | `/api/oauth/authorize` | 同意 / 拒绝授权（表单字段 `decision=approve\|deny`） |
| POST | `/api/oauth/token` | 用授权码换访问令牌（`application/x-www-form-urlencoded` 或 JSON） |
| GET | `/api/oauth/userinfo` | `Authorization: Bearer <token>`，返回用户资料 |

### 授权码

- 有效期 **5 分钟**，一次性使用；
- 只保存 sha256，数据库里没有明文授权码；
- 必须与授权请求里的 `client_id`、`redirect_uri` 完全一致才能兑换。

### 访问令牌

- 有效期 **1 小时**，只保存 sha256，可在 `oauth_access_tokens.revoked` 置 1 撤销；
- 只用于 `userinfo`，不携带任何 LCZOJ 会话权限。

### userinfo 响应

```json
{
  "sub": "u_9f2c…",
  "id": 42,
  "username": "alice",
  "nickname": "Alice",
  "email": "alice@example.com",
  "email_verified": true,
  "avatar": "/data/avatars/42.png",
  "role": "user",
  "is_admin": false,
  "rating": 1500,
  "created_at": 1712345678901
}
```

`sub` 是**永久且不可复用**的第三方标识：LCZOJ 删除用户后会复用数据库 uid，因此第三方必须用
`sub`（而不是 `id` / `username`）作为账号绑定的主键。

## 3. 完整流程

```text
浏览器                 Lith Tools                     LCZOJ
  │ 点击「使用 LCZOJ 登录」 │                              │
  │ ─────────────────────> │ /api/auth/lczoj              │
  │ <───────────────────── │ 302 → /api/oauth/authorize…  │
  │ ────────────────────────────────────────────────────> │
  │                        │            未登录 → 302 /#/login?redirect=…
  │ <──────────────────────────────────────────────────── │
  │ 输入 LCZOJ 账号密码（只在 LCZOJ 域）                    │
  │ ────────────────────────────────────────────────────> │
  │ <──────────────────── 授权确认页（同意 / 取消）           │
  │ ────────────────────────────────────────────────────> │
  │ <──────────────────── 302 redirect_uri?code=…&state=…  │
  │ ─────────────────────> │ 服务端 POST /api/oauth/token │
  │                        │ ───────────────────────────> │
  │                        │ <─────────────────────────── │ access_token
  │                        │ GET /api/oauth/userinfo      │
  │                        │ ───────────────────────────> │
  │ <───────────────────── │ 建立 Lith Tools 本地会话       │
```

## 4. 安全说明

- **密码不离开 LCZOJ**：Lith Tools 只拿到授权码 / 访问令牌，永远看不到 LCZOJ 密码；
- **不共享 Cookie**：两个站点的会话 Cookie 相互独立，第三方无法冒充用户调用 LCZOJ 的写接口；
- **state 防 CSRF**：Lith Tools 每次发起授权都会生成随机 `state` 并写入 HttpOnly Cookie，回调时校验；
- **授权码一次性 + 短有效期**：即使泄漏，5 分钟后失效，且兑换后立即作废；
- **权限最小化**：只开放 `profile` 范围（公开资料 + 邮箱），不包含提交记录、题目管理、用户管理等权限；
- **封禁账号**：`banned` 用户在授权入口与 `userinfo` 都会被拒绝；
- **管理员不会自动提权**：即使 LCZOJ 账号是管理员，第三方也只能得到 `role=user` 的普通资料。

## 5. 排障

| 现象 | 排查 |
| --- | --- |
| 授权页提示「授权登录未启用」 | 检查 4 个 `OJ_OAUTH_*` 变量是否都已配置并重启 |
| 提示「无效的回调地址」 | `OJ_OAUTH_REDIRECT_URIS` 与 Lith Tools 的 `LCZOJ_REDIRECT_URI` 必须逐字符一致（含端口、末尾斜杠） |
| 提示 `invalid_client` | 两端 `CLIENT_ID` / `CLIENT_SECRET` 不一致；改完需重启两端 |
| 登录后回到 `#/home` 而不是授权页 | 浏览器阻止了跨路径跳转，或登录页 `redirect` 参数被截断；刷新后重新点击按钮 |
| `invalid_grant` | 授权码已过期 / 已使用 / `redirect_uri` 不一致；重新发起登录即可 |
