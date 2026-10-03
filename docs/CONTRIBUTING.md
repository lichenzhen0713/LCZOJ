  贡献指南

欢迎为 LCZOJ 在线评测系统贡献代码、文档或反馈问题！本指南说明开发环境、代码风格与提交流程。

   开发环境

- **Node.js ≥ 22.5**（使用 `node:sqlite` 内置模块）
- 无需安装任何 npm 依赖，克隆后直接运行：

```bash
git clone <your-fork-url>
cd oj
node server.js
  访问 http://localhost
```

   代码风格

- **CommonJS** 模块（`require` / `module.exports`），不使用 ESM；
- **零第三方依赖**：新功能只能使用 Node.js 内置模块；
- 中文注释，函数与模块职责清晰；
- 前端为原生 SPA（`public/js/app.js`），不使用框架；
- 判题相关改动请在 Windows（`src/runner.ps1`）与 Linux（shell 重定向）双平台验证。

   目录速览

| 路径 | 内容 |
| --- | --- |
| `server.js` | HTTP 服务、路由、鉴权、权限中间件 |
| `src/db.js` | SQLite 建表 / 迁移 / 种子数据 |
| `src/judge.js` | 判题引擎（编译、运行、捆绑评分、工具链探测） |
| `src/markdown.js` | Markdown 与 LaTeX 渲染 |
| `src/*.js` | 各业务模块（问题、比赛、题解、讨论、用户、Rating 等） |
| `public/js/app.js` | 前端路由与全部页面渲染 |
| `public/css/style.css` | 样式（含暗黑模式） |

   测试

- 后端改动：`node --check <file>` 验证语法；重启服务后用 curl 或浏览器验证接口；
- 前端改动：`node --check public/js/app.js`；确认页面模板的 HTML 标签闭合；
- 判题改动：创建带测试数据的题目并实际提交验证（C++/Python 至少各一次）。

   提交流程

1. Fork 并创建特性分支：`git checkout -b feat/my-feature`；
2. 编写代码与注释，自测通过；
3. 提交信息使用中文或英文简洁描述，如 `feat: 新增 XXX` / `fix: 修复 XXX`；
4. 发起 Pull Request，在描述中说明改动内容与测试方式。

   问题反馈

- **Bug**：请说明复现步骤、系统环境（OS / Node 版本）、服务端日志；
- **功能建议**：请说明使用场景与期望行为。

   许可证

贡献即表示你同意将代码以 [MIT](../LICENSE) 许可证发布。
