---
status: active
superseded_by: ""
supersedes: ""
模块: "dependencies, server"
---

# 生产依赖漏洞清零：audit fix + 两个大版本升级

## 一句话结论

生产依赖 `npm audit --omit=dev --audit-level=high` 从 13（11 high）清零：非破坏性
`npm audit fix` 消掉 11 个，剩余 `@fastify/static` 与 `nodemailer` 两个大版本升级消掉，
其中 fastify/static 10 的 `setHeaders` 签名变化需把裸 `ServerResponse.setHeader` 换成
`FastifyReply.header`。

## 背景

20260928 的 CI 门禁修复（见 20260928-ci-gate-repair-decisions.md）把 push 路径的
audit 从硬失败降级为报告，但 13 个漏洞本身未处理，其中 nodemailer 涉及 SSRF /
header 注入 / TLS 校验类，fastify/undici/ws 涉及 SSRF 绕过与 DoS，均在生产运行。

## 决策

1. **先 `npm audit fix`（非破坏）**：11 个漏洞全部由 patch/minor 升级消掉
   （fastify 5.12.5、undici 6.29.0、ws 8.22.0、js-yaml 4.3.2、mysql2 3.24.4、
   ip-address 10.7.2、find-my-way 9.9.0、fast-uri、brace-expansion 5.0.12、
   electron-updater 6.8.9、builder-util-runtime 9.7.0 等），package.json 不变，
   仅 lock 更新。
2. **两个大版本显式升级**：`@fastify/static` ^9→^10.1.5、`nodemailer` ^8→^10.0.12。
   nodemailer 8 条 GHSA 在 9.x 内无修复版（npm audit 建议 10.x），只能跳大版本。
3. **代码适配点仅一处**：`src/server/index.ts` 的 `setHeaders` 回调在 v10 中首参
   类型从 `ServerResponse` 变为 `FastifyReply`，`res.setHeader(...)` 改为
   `reply.header(...)`；运行时行为等价（v10 文档明确同字段）。
4. **验证**：typecheck / build:server / build:web / build:desktop 全过；完整测试
   503 文件 / 3267 用例全过；nodemailer 10 用 `jsonTransport` 真实调用
   createTransport+sendMail 冒烟通过（测试套件里 nodemailer 被 mock，无法覆盖真实
   大版本 API 面，故单独冒烟）。

## 被放弃的方案（必填）

- nodemailer 只升到 9.1.1（补丁线内最低修复版）：弃用原因：audit 数据表明部分
  GHSA 仅 10.x 修复，9.x 会留尾巴。
- 用 `npm audit fix --force` 一次到位：弃用原因：force 会连锁文件里所有包按
  最新解析，超出安全修复面，回归风险不可控。

## 来源

- 本次会话（eqi12，worktree metapi-dep-audit，分支 fix/prod-dep-audit）
- npm audit --omit=dev --audit-level=high（升级后 found 0 vulnerabilities）
