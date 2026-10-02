# Metapi 变更日志

> 这是当前项目的持续变更记录。后续每次新增功能、修复缺陷、调整接口或修改文档，都要在本文件追加一条记录，不能只修改代码而不记录。

## 记录规则

- 每条记录使用日期、变更类型、需求来源、Issue 链接、实现范围、验证结果和交付物几个字段。
- 有 GitHub Issue 时必须附上完整链接；没有 Issue 时标记为“本会话需求”，不要虚构编号。
- 代码完成后再补充实际文件路径和测试结果，未验证的内容必须明确标记为“未验证”。
- 采用追加方式维护历史记录，不覆盖已完成记录；如果后续修复同一问题，新增一条记录并链接到原记录。
- PDF、截图、需求说明等交付物也要记录，但不能把交付物当成代码实现本身。

## 2026-08-03

### 1. 每个站点独立最大并发

- **类型**：功能实现
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：允许每个站点单独设置最大并发；`0` 表示不限制；不同站点的请求不能共享同一个并发计数器。
- **实现范围**：
  - 数据库 `sites.max_concurrency` 字段，默认值为 `0`，同步更新 schema contract 和各数据库启动产物。
  - 站点创建、更新 API 支持 `maxConcurrency`，接受 `0-100000` 的整数，并拒绝越界或非整数值。
  - 站点管理页面增加最大并发输入框和表格列，保存后可以看到每个站点自己的限制值。
  - 代理请求通过站点级 lease/队列控制并发；达到上限时只等待当前站点，不阻塞其他站点。
- **主要文件**：
  - `src/server/db/schema.ts`
  - `src/server/routes/api/sites.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/siteApiEndpointService.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/geminiSurface.ts`
  - `src/web/pages/Sites.tsx`
  - `src/web/pages/helpers/sitesEditor.ts`
- **验证**：
  - `src/server/routes/api/sites.api-endpoints.test.ts` 覆盖创建、更新和越界校验。
  - `src/server/services/proxyChannelCoordinator.test.ts` 覆盖同站点排队、不同站点隔离和 `0` 不限流。
  - 本地页面实际显示 `concurrency-site` 的最大并发为 `1`，其他站点显示“不限制”。
- **状态**：已完成并在当前本地服务中运行。

### 2. Rerank 代理接口

- **类型**：功能实现
- **需求来源**：[GitHub Issue #591](https://github.com/cita-777/metapi/issues/591)
- **目标**：新增 `POST /v1/rerank`，复用现有的鉴权、模型路由、站点 API 地址池、重试、用量解析、计费和代理日志链路。
- **实现范围**：
  - 增加 Rerank 路由，校验 `model`，将请求转发到选中的上游 `/v1/rerank`。
  - 支持站点 API 地址池、首字节超时、通道重试和失败切换。
  - 成功路径解析用量并记录计费；失败路径只记录通道失败和代理失败日志，不虚构用量或费用。
  - 路由已在 proxy router 中注册。
- **主要文件**：
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/routes/proxy/rerank.test.ts`
  - `src/server/routes/proxy/router.ts`
- **验证**：
  - 缺少 `model` 返回 HTTP 400。
  - 未携带下游鉴权调用实际本地接口返回 HTTP 401，鉴权边界生效。
  - Rerank 路由单元测试覆盖上游 URL、请求体转发和成功日志。
- **状态**：已完成。要得到真实排序结果，还需要在本地配置支持 Rerank 的上游站点和下游 API Key。

### 3. 路由优先级与 P0/P1/P2

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #590](https://github.com/cita-777/metapi/issues/590)
- **目标**：新建通道进入当前路由的下一优先级；拖拽或批量更新后优先级保持连续并和页面展示一致。
- **实现范围**：
  - 创建通道时按当前路由已有最大优先级计算默认值，不再把所有新通道固定为 `P0`。
  - 批量保存时按路由压缩为连续的 `P0`、`P1`、`P2` 等层级。
  - 返回通道列表时按 `priority`、`id` 排序，确保 API 和页面顺序一致。
  - 保留优先级拖拽后的保存和路由决策刷新行为。
- **主要文件**：
  - `src/server/routes/api/tokens.ts`
  - `src/web/pages/TokenRoutes.tsx`
  - `src/web/pages/token-routes/priorityRail.ts`
  - `src/web/pages/token-routes/RouteCard.tsx`
- **验证**：
  - 前端优先级 helper 和拖拽相关测试通过。
  - 本地路由页面实际展开 `deepseek-v4-pro`，通道显示在 `P0` 优先级桶中。
  - API 返回顺序使用 `priority`、`id` 排序。
- **状态**：已完成并在当前本地服务中运行。

### 4. Coding Plan v3 URL 拼接

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #586](https://github.com/cita-777/metapi/issues/586)
- **目标**：当上游 Base URL 已经以 `/v3` 等版本段结尾时，不要把下游请求的 `/v1` 重复拼接到 URL 中。
- **实现范围**：
  - URL 拼接逻辑识别末尾 `/vN` 版本段。
  - `.../api/coding/v3` 加 `/v1/chat/completions` 后得到 `.../api/coding/v3/chat/completions`。
  - 保持已有 `/v1`、无版本后缀和其他平台路径行为不回归。
- **主要文件**：
  - `src/server/proxy-core/orchestration/upstreamRequest.ts`
- **验证**：
  - Coding Plan v3 URL 拼接单元测试覆盖 v3、v1、无版本后缀和现有特殊路径。
  - Rerank 测试中的 Coding Plan v3 上游地址实际拼接为 `https://ark.cn-beijing.volces.com/api/coding/v3/rerank`。
- **状态**：已完成。

### 5. 渠道失败隔离

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #585](https://github.com/cita-777/metapi/issues/585)
- **目标**：一个渠道失败时，只更新实际失败渠道的冷却和失败状态，不影响同凭据的其他渠道，也不误触发站点级运行时熔断。
- **实现范围**：
  - 429 用量限流只冷却本次实际失败的 channel。
  - 不再按同一凭据扩散 `cooldownUntil` 或失败状态。
  - 429 不再写入站点级运行时熔断；其他健康渠道仍可参与选择。
  - 成功恢复时只清理当前通道自身的失败状态。
- **主要文件**：
  - `src/server/services/tokenRouter.ts`
  - 相关 token router、proxy retry 和路由健康状态测试文件
- **验证**：
  - 单线程 Vitest 覆盖限流失败、普通失败、成功恢复和站点熔断边界。
  - 验证结论：失败通道进入冷却，同凭据其他通道不扩散，429 不写入站点级熔断。
- **状态**：已完成。

### 6. 需求文档和演示交付物

- **类型**：文档与交付物
- **需求来源**：本会话中提供的四个 GitHub Issue
- **实现范围**：
  - 需求说明：[docs/plans/github-issues-591-590-586-585.md](plans/github-issues-591-590-586-585.md)
  - 网页演示 PDF：`output/pdf/metapi-issues-demo-2026-08-03.pdf`
  - PDF 包含当前 run 页面截图、站点独立并发、路由 P0、Rerank 请求示例、Coding Plan v3 和渠道失败隔离说明。
- **验证**：
  - 前端 `http://127.0.0.1:5174/` 返回 HTTP 200。
  - 后端 `http://127.0.0.1:4000/health` 返回 HTTP 200。
  - PDF 已渲染检查，共 6 页，中文正文和接口示例可读。
- **状态**：已完成。

### 7. 汇总验证

- `npm run typecheck:server`：通过
- `npm run typecheck:web`：通过
- `npm run typecheck:web:test`：通过
- `npm run test:schema:unit`：通过
- `npm run repo:drift-check`：通过
- 相关 Rerank、endpoint flow、路由优先级、tokenRouter、站点并发测试：使用单线程 Vitest 通过
- 说明：本机并行 Vitest worker 曾出现 OOM/UNKNOWN，后续复测优先使用：

```powershell
npx vitest run --pool=threads --poolOptions.threads.singleThread=true <test-file>
```

### 8. 建立持续变更日志

- **类型**：文档维护
- **需求来源**：本会话需求
- **目标**：把功能、修复、测试和交付物集中记录，作为后续改动的唯一开发日志。
- **实现范围**：新增本文件 `docs/change-log.md`，并提供 Issue 链接、文件路径、验证结果和后续追加模板。
- **状态**：已完成；后续每次代码或文档变更都追加到本文件。

## 2026-08-21

### 9. 提交到上游仓库的独立分支

- **类型**：版本交付
- **需求来源**：本会话需求：[Metapi 仓库](https://github.com/cita-777/metapi)
- **目标**：将本地已完成的站点独立并发、Rerank 和四个 Issue 修复提交到上游仓库的独立分支，不直接修改 `main`。
- **实现范围**：以远程 `main` 为基线创建 `codex/metapi-issues-591-590-586-585`，迁移代码、测试、数据库迁移产物、需求文档、持续日志和演示 PDF。
- **主要文件**：
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/tokenRouter.ts`
  - `src/server/db/schema.ts`
  - `docs/change-log.md`
- **验证**：`npm run typecheck:server`、`npm run typecheck:web`、`npm run typecheck:web:test`、`npm run test:schema:unit`、`npm run repo:drift-check` 均通过；相关聚焦测试通过，`tokenRouter.selection.test.ts` 单独运行 26/26 通过。
- **提交**：本地提交 `02e2308`（`feat: add proxy fixes and per-site concurrency`）。
- **推送结果**：未推送；GitHub 返回 `403 Permission to cita-777/metapi.git denied to lengxiaouser`，当前凭据对该仓库没有写权限；远程分支尚未创建。
- **状态**：代码已验证并在本地分支就绪，等待具备该仓库写权限的凭据后重试。

### 10. 创建 Fork 并准备 Pull Request

- **类型**：版本交付
- **需求来源**：本会话需求
- **目标**：通过个人 Fork 提交变更，避免直接写入上游仓库。
- **实现范围**：已创建 [lengxiaouser/metapi](https://github.com/lengxiaouser/metapi) Fork，目标分支为 `codex/metapi-issues-591-590-586-585`，PR 基线为上游 `main`。
- **验证**：Fork 的 `main` 已通过 Git 远程读取确认，功能分支已成功推送。
- **状态**：已完成。

### 11. 创建上游 Pull Request

- **类型**：版本交付
- **需求来源**：本会话需求
- **目标**：请求上游仓库审核本次站点并发控制、Rerank 及四个 Issue 修复。
- **实现范围**：创建 [PR #609](https://github.com/cita-777/metapi/pull/609)，源分支为 `lengxiaouser:codex/metapi-issues-591-590-586-585`，目标为 `cita-777:main`。
- **验证**：GitHub API 返回 PR 编号 `609`，状态为 `open`；PR 描述已包含 Issue 链接、验证命令和变更范围。
- **状态**：已提交，等待上游审核。

## 2026-08-22

### 12. 修复 CodeRabbit PR 审查问题

- **类型**：缺陷修复与架构重构
- **需求来源**：CodeRabbit 对 [PR #609](https://github.com/cita-777/metapi/pull/609) 的审查；对应 Issue：[#591](https://github.com/cita-777/metapi/issues/591)、[#590](https://github.com/cita-777/metapi/issues/590)、[#586](https://github.com/cita-777/metapi/issues/586)、[#585](https://github.com/cita-777/metapi/issues/585)
- **目标**：修复站点并发租约释放、并发超时误判、路由通道优先级竞态、Rerank 路由职责过重和变更日志字段不完整等问题。
- **实现范围**：
  - 流式响应交接后暂停后台续租，按真实读取进度续租；读取失败先取消 reader，再释放站点租约。
  - 为本地站点排队超时增加显式 `siteConcurrencyTimeout` 标记，统一由 `sharedSurface.ts` 分类，避免把真实上游 503 当成站点排队超时。
  - 新增 `routeChannelService.ts`，用进程内串行锁和数据库事务统一处理自动通道、批量通道、单通道和批量优先级写入，并统一清理路由决策缓存。
  - 新增 `rerankSurface.ts`，通过 `executeEndpointFlow()` 承担 Rerank 的站点地址池、首字节超时、上游请求、用量计费、日志和失败重试；路由文件只保留校验与委托。
  - 修正 Rerank 记录：只有成功响应解析用量并计费，失败只写失败状态日志，费用和用量为零/未知不代表已发生计费。
- **主要文件**：
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/siteApiEndpointService.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/proxy-core/surfaces/geminiSurface.ts`
  - `src/server/proxy-core/surfaces/rerankSurface.ts`
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/services/routeChannelService.ts`
  - `src/server/routes/api/tokens.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck:server`：通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true src/server/routes/proxy/rerank.test.ts src/server/services/siteApiEndpointService.test.ts src/server/services/proxyChannelCoordinator.test.ts`：通过，24 个测试通过。
  - 路由优先级与共享 surface 回归测试：通过，`tokens.batch.test.ts`、`tokens.route-update-rebuild.test.ts` 共 21 个测试，`sharedSurface.test.ts` 与 `sharedSurface.usage-source.test.ts` 共 24 个测试。
  - Rerank 测试实际验证上游 URL 为 `https://ark.cn-beijing.volces.com/api/coding/v3/rerank`、请求体转发和成功日志；测试环境的 quota best-effort 查询因未创建 `accounts` 表输出告警，但不影响请求结果。
  - `npm run typecheck:web`：通过。
  - `npm run typecheck:web:test`：通过。
  - `npm run test:schema:unit`：通过，15 个测试通过。
  - `npm run repo:drift-check`：通过，新增违规 0 个；报告中的 5 项为既有 tracked debt。
- **交付物**：本地 checkout 中的修复代码和本变更日志；无新增 PDF 或截图。
- **状态**：已完成，等待提交并更新 PR。

### 13. 修复 CodeRabbit follow-up 审查问题

- **类型**：缺陷修复与文档修正
- **需求来源**：CodeRabbit 对 [PR #609](https://github.com/cita-777/metapi/pull/609) 的 follow-up 审查
- **目标**：修复 Issue 链接的 Markdown 空格，并确保手工通道传入的明确优先级不会被自动分配逻辑覆盖。
- **实现范围**：
  - 将 `[ #591]` 修正为 `[#591]`，并确认 PR/Issue 链接均为合法 Markdown。
  - `routeChannelService` 区分明确优先级和自动候选：手工通道传入 `priority: 0`、`priority: 3` 等值时原样归一化保留；自动候选才分配下一个优先级。
  - 自动补齐候选不再把 `priority: 0` 当成显式优先级，避免所有自动通道固定在 P0。
- **主要文件**：
  - `src/server/services/routeChannelService.ts`
  - `src/server/routes/api/tokens.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck:server`：通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true --hookTimeout=30000 src/server/routes/api/tokens.batch.test.ts`：6 个测试通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true --hookTimeout=30000 src/server/routes/api/tokens.route-update-rebuild.test.ts`：15 个测试通过。
- **交付物**：代码与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成，已推送到 PR 分支；本次日志修正随当前文档提交同步。

## 2026-09-22

### 14. 锁死 /v1/messages 兜底路径的 Bearer 认证并收紧 isClaudePlatform 类型

- **类型**：缺陷修复
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：Prism（`platform=openai` 的 OpenAI 兼容网关，同时暴露 `/v1/messages`）因收到 `x-api-key` 而非 `Authorization: Bearer` 返回 401，随后被 balance/alert 层误判为 token 永久过期并禁用账号，导致 grok-4.6 无可用通道、下游持续 503。为根因修复补齐真实生产路径的回归锁，并防止未来调用方漏传平台判断而重新触发同一条误判链。
- **实现范围**：
  - `src/server/proxy-core/providers/headerUtils.ts`：`buildClaudeRuntimeHeaders` 的 `isClaudePlatform` 从可选改为必填，并重写注释说明为何只有 Anthropic 原生 claude 平台使用 `x-api-key`、其余平台必须用 `Authorization: Bearer`。
  - `src/server/services/upstreamRequestBuilder.test.ts`：新增两条 builder 级测试。因为 `resolveProviderProfile('openai')` 返回 null，生产的 `/v1/messages` 请求走的是 builder 兜底分支而非 claude provider profile，原有 profile 级测试覆盖不到真实路径。
- **主要文件**：
  - `src/server/proxy-core/providers/headerUtils.ts`
  - `src/server/services/upstreamRequestBuilder.test.ts`
- **验证**：
  - `npx vitest run src/server/proxy-core/providers/registry.test.ts src/server/proxy-core/providers/headerUtils.test.ts src/server/services/upstreamRequestBuilder.test.ts src/server/routes/proxy/chat.stream.test.ts src/server/routes/proxy/upstreamEndpoint.test.ts src/server/services/platforms/claude.test.ts src/server/services/platforms/llmUpstream.test.ts`：7 文件 204 个测试通过（较此前 202 新增 2 条）。
  - `npm run typecheck`：web / web:test / server / desktop 四段全部通过；必填改造后 3 个生产调用点无一处漏传。
  - 本次不改运行时行为：3 个调用点在必填化之前本就显式传值，故线上行为不变。
- **交付物**：代码、测试与持续变更日志；无 PDF 或截图。
- **状态**：已完成。

## 2026-09-24

### 15. 通知模板按事件类型定制（notification_templates 表化）

- **类型**：功能实现
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：推送模板从「渠道维度」升级为「事件类型 × 渠道」矩阵，新增 `daily_summary` 事件类型与专属变量，并保证老用户升级后模板行为不变。
- **实现范围**：
  - 新增 `notification_templates` 表，主键 `(event_type, channel)`，字段 `title` / `body` / `parse_mode`；`__global__` 为兜底行。
  - `settings.notification_templates_v1` 旧 JSON 由启动期幂等迁移拆成 `(__global__, channel)` 行并删除旧键。
  - `sendNotification()` 增加必填 `eventType`，回退顺序为精确匹配 → `__global__` → 渠道原有硬编码默认渲染；7 个调用点全部显式传值。
  - `daily_summary` 支持 16 个 snake_case 专属变量（`today_spend`、`today_reward`、`today_net`、`checkin_success` 等）。
  - `GET` / `PUT /api/settings/runtime` 的 `notificationTemplates` 改为两层结构，新增 `notificationTemplateVariablesByEvent`。
  - 通知设置页改为「事件类型 × 渠道」矩阵，未单独定义时展示并编辑全局模板，支持一键继承全局与恢复继承，保留变量说明与实时预览。
  - `events.type` 白名单与前端筛选/标签扩展 `daily_summary`。
  - schema 产物生成器支持复合主键（表级 `PRIMARY KEY (a, b)`），修复逐列内联会生成非法 DDL 的问题。
- **主要文件**：
  - `src/server/db/schema.ts`、`src/server/db/schemaArtifactGenerator.ts`、`drizzle/0029_notification_templates.sql`、`drizzle/meta/_journal.json`、`src/server/db/generated/*`
  - `src/server/services/notificationTemplates.ts`、`src/server/services/notifyService.ts`、`src/server/services/dailySummaryService.ts`、`src/server/services/checkinScheduler.ts`、`src/server/index.ts`
  - `src/server/routes/api/settings.ts`、`src/web/api.ts`、`src/web/pages/NotificationSettings.tsx`、`src/web/components/NotificationPanel.tsx`、`src/web/pages/ProgramLogs.tsx`
  - `.agents/notes/20260924-notification-templates-by-event.md`、`CHANGELOG.md`
- **验证**：
  - `npm run build`、`npm test`（469 文件 / 2791 测试通过）、`npm run typecheck`、`npm run repo:drift-check`（0 违规）。
  - `npm run test:schema:unit`、`npm run test:schema:parity`、`npm run test:schema:upgrade` 全部通过（MySQL / Postgres live 用例按既有机制 skip）。
  - 老数据迁移路径有测试覆盖：先写入 legacy setting 再加载，断言 `__global__` 行内容、legacy 键被删除且二次加载幂等。
- **状态**：已完成。

### 16. 流式响应 include_usage 终态 usage chunk 补发

- **类型**：缺陷修复
- **需求来源**：本会话需求（线上现象：走 openai chat surface 的流式请求拿不到 usage，guardian footer 的 `▸ TPS` 显示 `n/a`），未提供 GitHub Issue 链接
- **目标**：修复 `stream_options.include_usage` 只被解析、没有进入流式会话，导致上游只在收尾帧（`choices: []` 单帧）给出 usage 时该帧被整帧丢弃的问题。
- **实现范围**：
  - `StreamTransformContext` 增加 usage 字段与 includeUsage 布尔标记，`chatSurface` 仅在 openai chat 且 `include_usage=true` 时下传（计费路径独立，不受影响）。
  - `serializeStreamDone` 的 openai 分支在 `[DONE]` 之前补发一条 `choices: []` 的终态 usage chunk；保留既有中间帧 usage 行为，避免下游解析器回归。
  - `streamBridge` 记住最后一条确凿 usage（覆盖，不累加）；`proxyStream` 在 JSON fallback 记录 usage，并在 `markFailed` 内同步把 `includeUsage` 置为 `false`，锁住「失败流不得补 usage」不变量。
  - 补测试：`streamBridge.test.ts` 增加终态 chunk 与负向用例，新增 `proxyStream.test.ts`（含「空内容失败 + 已捕获 usage → 不得补 usage」）。
- **主要文件**：
  - `src/server/transformers/shared/chatFormatsCore.ts`
  - `src/server/transformers/openai/chat/streamBridge.ts`
  - `src/server/transformers/openai/chat/proxyStream.ts`
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `.agents/notes/20260923-openai-chat-stream-usage-chunk.md`
- **验证**：
  - 提交 `a21e8d5` 双审与应修补丁已过。
  - 镜像 A/B 取证：候选镜像 `dist/` 中 `includeUsage` 命中补丁产物 10 处，旧镜像 0 处（阴性对照）。
  - 线上行为 canary（A/B/C）：旧镜像 + `include_usage=true` 终态 chunk 0 条（复现问题）；候选镜像 + `include_usage=true` 1 条且位于 `[DONE]` 之前；候选镜像不带 `include_usage` 0 条。非流式 usage、`/v1/models` 与同步脚本 dry-run 无回归。
- **交付物**：代码、测试、`.agents/notes` 决策记录、`CHANGELOG.md` 与本条持续变更日志。
- **状态**：已完成，随 `v1.4.0` 发布。

## 2026-10-01

### 17. 重试耗尽回传真实原因（片 1：类型分流 + 503 观测口径收窄）

- **类型**：缺陷修复
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：`/v1/chat/completions`、`/v1/messages`、`/v1/responses` 在重试耗尽（本轮失败后重试仍可继续、但下一轮已选不出通道）时不再一律回 503 `No available channels for this model`，改为回传最后一轮失败的真实信息；错误 `type` 按「有无真实上游 HTTP 响应」分流（有 ⇒ `upstream_error` + 真实状态码，无 ⇒ `server_error` + 合成 502/503）；首轮即无可用通道保持原 503 文案；报错 message 截断到 1000 字符（含 `...(truncated)`，按码点不切半）。
- **实现范围**：
  - 两个 surface（chat / responses）各自新增「本轮终态失败」留存并在选不出通道的出口回传真实状态码 + payload + upstreamPath，`events` 原因写为 `retry exhausted: HTTP <status>: <message>`；首轮无通道与固定通道模式的 503 文案不变。
  - 截断器 `truncateUpstreamErrorMessage`（上限 1000、含截断标记、按 Unicode 码点截断）与留存类型 `SurfaceRetryTerminalFailure` 落在共享工具包，避免两面各写一份；并同口径应用到共享工具包的三个终态 respond 出口（`handleUpstreamFailure` / `handleDetectedFailure` / `handleExecutionError`）的 message，使「≤1000 截断」的应用点达到 **7 处**（两条 surface 各自的 finalize 两档 + 三个工具包终态出口），而不只重试耗尽出口；**但并非「全部客户端可见末轮出口」**：`chatSurface.ts:947`/`:1007`/`:1112`/`:1190` 四处流式失败 502 与 `geminiSurface.ts:1434-1437`/`:807` 仍原样透传（未封顶），embeddings / images / completions / videos / search / rerank 的错误体同样未封顶（详见笔记 §5 与「遗留与跟进」）。
  - 范围外一致性修复（1 处）：共享工具包执行失败终态（网络层失败，无真实上游响应）由 `upstream_error` 改为 `server_error`（状态码沿用 502），与两条 surface 出口同口径；核对全部 3 个调用点确认均属「无真实上游响应」，`handleUpstreamFailure` / `handleDetectedFailure` 仅 message 做 ≤1000 封顶、`type` 保持 `upstream_error` 不动。
  - **未覆盖（已知）**：`count_tokens` 分支与其它 route（`embeddings` / `images` / `completions` / `videos` / `search` / `rerank`）的**重试耗尽口径**仍是旧 503，逐条已列入笔记「未覆盖面」。**注意 `count_tokens` 非「完全未变」**：其最后一轮执行失败终端（`chatSurface.ts:1909`）共用上述共享工具包出口，故该终端的 `error.type` 随本批由 `upstream_error` 变为 `server_error`。
- **主要文件**：
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.test.ts`
  - `src/server/routes/proxy/chat.singleChannelFailure.test.ts`（新增）
  - `.agents/notes/20261001-retry-exhaustion-real-upstream-error.md`
  - `CHANGELOG.md`、`docs/change-log.md`
- **验证**：
  - `npm run typecheck` 全绿；`npx vitest run --root . src/server/routes/proxy/ src/server/proxy-core/` = 54 文件 / 579 用例全绿；`npm run repo:drift-check` = 0 违规。
  - 反向对照（真跑并已还原）：出口条件改 `if (false && retryFailure)` ⇒ 新增集成用例 8/10 失败；工具包终态 `type` 还原 `upstream_error` ⇒ 单测 1/30 失败。
  - **未验证（如实标注）**：生产侧 503 数量/分布变化、下游客户端行为（含上游 401/403 是否被误报为「你的 key 失效」）、canary 笔记 §4.1 形态的复现——均为未知，本片未做生产实验。
- **交付物**：代码、测试、`.agents/notes` 决策记录、`CHANGELOG.md` 与本条持续变更日志。
- **状态**：已完成（未提交）；观测口径收窄与旧笔记条目的对应关系见上述笔记第 3 节。

### 18. 重试耗尽运维标记迁到 events 独立 title（方案 A）+ chat 流式失败 502 出口封顶

- **类型**：缺陷修复 / 观测口径变更
- **需求来源**：本会话需求，未提供 GitHub Issue 链接（落实片 1 留下的两个用户决定：判别器升级 + 未封顶遗留；判别器载体由用户拍板为**方案 A：events 独立 title**）
- **目标**：① 让「重试耗尽」能被 SQL **1:1 直查**（`SELECT * FROM events WHERE title = '代理重试耗尽'`；该行**落库即已读**，只作运维标记、不进未读计数），不再只能靠 events 正文串（该串有时效性与可伪造面）；② 给 chat 主 handler 的 4 处流式失败 502 出口的 message 补共享长度封顶（≤1000）。
- **实现范围**：
  - **方案 A（判别器升级）**：两条 surface 的「重试耗尽」出口（`chatSurface.ts:455`、`openAiResponsesSurface.ts:401`）在既有 `reportProxyAllFailed` 之后、`finalizeDebugFailure` 之前，**直插一条自己的 `events` 行**（`db.insert(schema.events)`，形态同 `routes/api/sites.ts:409-416` / `services/checkinService.ts:187-195` 先例；**不经 `evaluateAggregatedNotification`、不推送**）：`title='代理重试耗尽'`（模块级常量 `RETRY_EXHAUSTED_EVENT_TITLE`，定义已在 `src/server/shared/eventTitles.ts:14`——本片从 `sharedSurface.ts:697` 迁出至中性模块（真实理由是**避免 routes 层 ← proxy-core 的反向耦合**与**缩小 `sharedSurface.ts` 的依赖面**；`repo:drift-check` 的 `proxy-core-routes-proxy-import` 规则只匹配 `src/server/proxy-core/` 内对 `routes/proxy/` 的 import、**并不覆盖本场景**，其 0 违规只是回归门槛）；与「代理全部失败」各自成组——聚合签名是 `level||title`，`notificationAggregator.ts:117-119`）、`type='proxy'`、`level='error'`、`relatedType='route'`（同 `reportProxyAllFailed` 体例、不挂 id），**该行已从通知中心口径摘除（服务端按 title 排除）：`routes/api/events.ts` 的列表（`GET /api/events`）与未读计数（`GET /api/events/count`）两个读接口都用 `ne(schema.events.title, RETRY_EXHAUSTED_EVENT_TITLE)` 排除本行 ⇒ 不出现在通知面板列表、不计入未读徽标/计数**（落库仍显式 `read: true`，作为「只看未读」类筛选的第二道保险；写侧 `/api/events/:id/read`、`/read-all`、`DELETE` 未改）；**标记行仍落库、仍可 SQL 直查**。**曾短暂存在挤占风险**（旧口径：落库即已读 ⇒ 不计入未读数，但**仍占最近 30 行窗口的 1 个位次**，高频风暴下可能把真告警挤出面板列表、并使徽标计数窗口被占），**已由本片排除修复**。**副作用**：`/api/events` 是同一列表接口，程序日志页（`ProgramLogs.tsx:117`）也不再显示本行——唯一入口是 SQL 直查。`message` 携带真实状态码与判别串（`retry exhausted: HTTP <真实状态码>: …`，与 `reportProxyAllFailed` 的 `reason` **同源同一串**）以及出口当时确实可得的上下文（模型 / 上游路径 / 流式标记 / 轮次 / 已试通道 id / 固定通道 id）——`events` 无结构化列，只能进文本。**每轮重试耗尽只写一条**；**A 形态**（首轮真无通道、`lastRetryFailure` 为空）**不写**；写入失败只 warn ⇒ **不影响客户端响应路径**。helper 与判别器 SQL 见笔记 §1。
  - **为何不走 `proxy_logs`（被否的实测依据；本批初稿路线已整条拆除）**：`proxy_logs` 是 attempt / 请求级表，任何新增行都会被既有统计消费方计入——失败数（`dashboardSnapshotService.ts:138-139`、`dailySummaryService.ts:87`、`downstreamApiKeys.ts:289`/`:377`、`downstreamApiKeyTrendService.ts:195`/`:287`）、请求数（`dashboardSnapshotService.ts:155-170`、`stats.ts:1205-1215`）、延迟样本与站点/小时/模型投影（`usageAggregationService.ts:347-360`/`:387-388`/`:424`/`:447`/`:469`）、可用率分母（`statsShared.ts:179`/`:229`）；而该表**没有**可忽略位（无 `internal`/`exclude_from_stats` 一类列，`schema.ts:246-289`；`status` 只有 `success|failed|retried`，而消费方一律按「非 success 即失败」计）⇒ 不可能在不改聚合代码的前提下新增行。**`events` 则无任何统计消费方**（证据全清单见笔记 §3：只有直插写入 / 聚合器按自有 `eventId` 维护自己的行（`notificationAggregator.ts:283-297`）/ 保留期清理（`logCleanupService.ts:76`）/ 复位（`factoryResetService.ts:41`）/ 迁移（`databaseMigrationService.ts:277`）/ 运维列表读（`routes/api/events.ts` 的 `GET /api/events` / `GET /api/events/count`）；`backupService.ts:553-566` 的备份清单**不含 events**）。
  - **判别器覆盖面（必须与判别器一起读）**：`events.title` 直查**只对「本轮失败可重试、且下一轮已选不出通道」这一形态成立**。下列形态**不写该行**（⇒ 查不到**不等于**没发生）：末轮直终态（`retryCount == maxRetries`，`canRetryChannelSelection` 为假 ⇒ 多通道下「最后一个通道也失败」是**常态**）、固定通道模式（`channelSelection.ts:79` 使其恒假）、`count_tokens` handler、`geminiSurface`、6 个 route（embeddings / images / completions / videos / search / rerank）。措辞沿用片 1 笔记 §2 的 O3 条（**引用，未改动片 1 笔记正文**）：「**只覆盖『重试耗尽』形态（O3）**……⇒ 拿 events 判别器只能证明『发生过重试耗尽』，**不能反证**『没发生过租约忙/并发超时』」。
  - **本批初稿路线的两条隐患（已被方案 A 从根上避开，记为「为何被否」）**：① 新增行是 attempt / 请求级表里的又一行 ⇒ 除统计计入外，判别器也不得不建在**文本列** `error_message` 上，而该串尾部是**上游可控文本**，故任何「基于 `error_message` 的排除」（如「请求级成功率」的 `error_message NOT LIKE '%] retry exhausted: HTTP%'`）**可被上游伪造**；② 串头还会被 `composeProxyLogMessage`（`proxyLogMessage.ts:23-47`）的前缀污染，锚定位置不稳定。方案 A 把判别器落在**结构化列 `title`** 上，两个隐患均不再存在（相应的串头订正表述随之作废，见笔记 §「F1 处置」）。
  - **拆除清单（初稿新增项，已全部删除）**：两条出口里的 `failureToolkit.log({...})` 写 `proxy_logs`；`SurfaceRetryLogContext` 与 `buildSurfaceRetryLogContext`；`SurfaceRetryTerminalFailure.logContext`（恢复片 1 的 `{ status, payload, upstreamPath }` 形状）；**12 个留存点**（chat 6 + responses 6）的 `logContext: buildSurfaceRetryLogContext({...})`；`writeSurfaceProxyLog` 与故障工具包 `log` 的各一个**可选 `siteId`**（核全仓调用点后确认已无使用者）；`SurfaceSelectedChannel.site.id` 的加宽（唯一用途就是那个已删的构造器）。⇒ `git diff` 中已无任何 `proxy_logs` 标记写入与 `logContext` / `siteId` 管道（`rg logContext src/` = 0 命中）。
  - **保留期与直查窗口**：`events` 的清理走 `cleanupProgramLogs`（`logCleanupService.ts:60-86`），**开关默认关闭**（`config.ts:97`）⇒ **默认配置下新行不会被定期清理**；打开则按 **30 天**（`config.ts:98`）。`proxy_debug_traces` 只留 **24 小时**（`config.ts:156` / `proxyDebugTraceStore.ts:153-161`）⇒ **按事件回查 trace 的窗口是 24h**。**行数增长 ≤ 失败请求速率**（仅本出口 1:1；末轮直终态/固定通道/`count_tokens`/`geminiSurface`/6 route 不写本标记）：出口每失败请求 1:1 写一行、无合并/去重，`events` 默认永不清理（开关默认关；且需 `logCleanupConfigured=true` 才会真跑，`checkinScheduler.ts:195-198`）⇒ 边际成本 **+1 行/失败请求**（同一请求本就会写一条 `proxy_logs` 失败行，非新量级）；此前「≈42 行/周」是**低频观测、不是上限**；**查不到时**（A 形态/末轮直终态/固定通道/`count_tokens`/`geminiSurface`/6 route 不写本标记）的**下一步**（改查 `title='代理全部失败'` + `原因=No available channels after retries` + 24h 内 trace）与 **`tried_channels` join 指引**（补全 route/site/account）见笔记「遗留与跟进」第 4 条；反例：**租约忙/并发超时若发生在仍有重试余量的轮次是会写本标记的**（`retry exhausted: HTTP 503: Channel busy…`），不要读成「busy 形态永不写」。初稿的 `proxy_logs` 行**从未发版**（只存在于未提交工作区）⇒ **无需数据迁移 / 回填**。
  - **A 组（封顶，保留不动）**：4 处流式失败 502 出口（改后 `chatSurface.ts:971`/`:1031`/`:1136`/`:1214`）的 `message` 改为 `truncateStreamFailureMessage(streamResult.errorMessage)`——同文件私有包装（`:307-309`，**保留 `null` 语义**，不把 `null` 写成空串），内部即共享 `truncateUpstreamErrorMessage`（≤1000 + `...(truncated)`）；状态码 502、`error.type='upstream_error'`、响应结构不变。**未封顶的客户端出口还剩** `geminiSurface.ts:1434-1437`/`:807` 两处与 6 个 route（embeddings / images / completions / videos / search / rerank）的错误体——本片未动。
  - **已知偏差（如实标注）**：这 4 处出口的封顶在**集成夹具内不可构造**（上游 `error`/`response.failed` 帧被 `proxyStream` 以 `force` 写成 200 SSE 流，`streamStarted` 变 true，到不了 `!streamStarted` 出口；夹具唯一可达源是本地 `Upstream returned empty content`）；**生产未证实可达、也未证实不可达**（2xx + JSON + `type:'error'` 体在 `PROXY_EMPTY_CONTENT_FAIL` **当时默认 false**（**该默认值已于 2026-10-02 改为开**：`src/server/config.ts:189-190` 默认 `true`，仅 `PROXY_EMPTY_CONTENT_FAIL=false` 可关闭；开＝空内容判失败、客户端不会收到空成功）且 `proxyErrorKeywords` 默认空时会走 `consumeUpstreamFinalPayload → markFailed(上游 payload)`，其 message 为上游原文）。**封顶保留**；新增用例锁的是**出口不变量**（502 + `upstream_error` + 非 SSE + `message` ≤1000 且文案不变），**没有**「上游超长被截断」断言，`>`1000 形态与「去掉封顶即 FAIL」的原生反向对照不可构造（实测 13 种上游错误形态全部 200；给 4 处出口加临时探针后，当时 102 条的 `chat.stream.test.ts` 用例里探针只命中 3 次且 message 全为本地串）。替代反向对照见下。
- **主要文件**：
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/routes/proxy/chat.singleChannelFailure.test.ts`
  - `src/server/routes/proxy/chat.stream.test.ts`
  - `.agents/notes/20261001-retry-exhausted-proxy-log-and-stream-cap.md`
  - `CHANGELOG.md`、`docs/change-log.md`
- **验证**：
  - `npm run typecheck`（web / web:test / server / desktop 四段）全绿；`npx vitest run --root . src/server/routes/proxy/ src/server/proxy-core/` = **54 文件 / 583 用例全绿**（较片 1 的 579 增加 4 条 = 事件落库 2 + 流式封顶 1 + 可选结构锁 1；两条 `proxy_logs` 落库用例已 1:1 换成两条 `events` 用例，总数不变）；**收边轮次连跑两遍**，两遍均 **54 文件 / 583 全绿**（日志 `/tmp/vitest-run1.log` / `/tmp/vitest-run2.log`）；`npm run repo:drift-check` = **0 违规**（另 5 条 `tracked_debt`，均既有白名单项）；`git diff --check` 无输出。
  - **反向对照（`read: true` 收边，真跑并已还原）**：① 临时停掉 `events` 写入（helper 内早退）⇒ 事件落库用例 **1/12 失败**（`expected +0 to be 1`）；② 临时把 `read: true` 改成 `read: false` ⇒ 同一用例 **1/12 失败**（`expected false to be true`，证明新增的已读断言真的守护新行为）；两次均还原（`TEMP-RC|if (false)` 全仓 0 命中，`sharedSurface.ts` 差异回到 +57/-0）。
  - **反向对照（真跑，已还原）**：把两个出口新增的 `events` 写入临时改成 `if (false) await insertRetryExhaustedEvent({...})` ⇒ `chat.singleChannelFailure.test.ts` **1/12 失败**（断言 `expected +0 to be 1`，即 title 命中行数 0），A 形态用例仍通过；还原后同文件 **12/12 通过**，且 `grep -rn 'if (false)' src/` **无命中**（还原证据）。
  - **反向对照（A 组封顶，真跑并已还原，替代做法）**：因可达 message 恒为 31 字符短串，单去封顶不会让用例失败；改为「在失败源注入 5031 字符 message」后两次对照——**去掉封顶（`truncateStreamFailureMessage` 直通）⇒ 新增流式用例 FAIL**（`expected 5031 to be less than or equal to 1000`）；**恢复封顶 ⇒ 同用例 PASS**（⇒ 封顶端到端把该出口的 message 压到 ≤1000）。还原证据：`git diff --stat src/server/transformers/openai/chat/proxyStream.ts` 为空、`grep -rn "disabledForReverseControl\|if (false)" src/` 无命中（余下命中均为既有的 `=== false &&` 业务判断）。
  - **未验证（如实标注）**：生产库上该 `events` 行的真实量与分布、`message` 里的上下文取值（用例用夹具 id）、responses 面落库（落库用例只覆盖 chat 面）——均未知，本片未做生产实验。
  - **最大偏差（如实标注）**：任务书要求 `message` 携带「route / 当轮通道与站点 / 延迟 / 轮次等当时可得的上下文」，同时要求彻底删除 `logContext` / `siteId` 管道；出口作用域内**根本没有 route / 站点 / 延迟**（它们原先只在被删的快照里），故本片服从「拆除彻底」、`message` 只带**出口当时确实可得**的上下文，**未**为补齐它们而重新引入上下文管道或新增 DB 反查（详见笔记「遗留」2）。
- **交付物**：代码、测试、`.agents/notes` 决策记录、`CHANGELOG.md` 与本条持续变更日志。
- **状态**：已完成（未提交）；本片对片 1 笔记**一条主张的收窄**（「唯一干净判别器 = events 串」⇒ 改为 `events.title` 直查，events 串降级为辅助）与**一条主张的维持**（「终态出口不写自己的 `proxy_logs`」）见上述笔记第「与片 1 笔记的关系」节，旧笔记一字未改。
- **发版后观察（已闭环，保留一行历史）**：曾计划盯「`代理重试耗尽` 在最近 30 行中的占比」、若出现挤占真告警再决定排除——本标记**已从通知面板与未读徽标/计数中摘除（服务端按 title 排除）**；**标记行仍落库、仍可 SQL 直查**。**曾短暂存在挤占风险**（旧口径下该行占最近 30 行窗口 1 个位次，高频风暴下可能把真告警挤出面板列表、并使徽标计数窗口被占），**已由本片排除修复**；⇒ 该观察动作**不再需要**。

## 2026-10-02

### 1. 客户端可见失败语义（网络异常归一 / SSE in-band 错误帧 / `client_http_status` 观测列 / 路由刷新埋点）

- **类型**：缺陷修复 + 契约变更（`proxy_logs` 新增可空观测列）+ 观测补点
- **需求来源**：本会话需求（任务标记 `MARK-CLIENTVIS-IMPL-W9`，无 GitHub Issue 链接）
- **目标**：让「客户端拿不到完整 HTTP 响应」的三类路径对客户端可区分：① 上游静默黑洞（~300s）；② 响应头已到但 body 中途断（SSE 已 hijack ⇒ 客户端看到无终结的流）；③ 请求内路由刷新挂起且零观测。
- **实现范围**：
  - `#5` `endpointFlow` 网络类异常（fetch reject / body 异常）归一为与 `!response.ok` 同路径的 `{ok:false,status:502,errText:formatErrorCause(err)}`：客户端状态码保持 502；错误 `type` 由 `server_error` 纠正为 `upstream_error`；attempt 记录与 `final_upstream_path` 现在也会落库；重试/轮换语义不变。
  - `#6` 已 `reply.hijack()` 的流式失败改写成帧后 `end()`（OpenAI / Claude 两种帧形；**绝不**追加 `[DONE]` / `message_stop`）；未 hijack 出口保持 `reply.code(502).send(...)`。覆盖 `chatSurface` 与 `openAiResponsesSurface`（后者只在「写过帧但无终结事件」时补帧）。
  - `#7` `proxy_logs` 新增可空列 `client_http_status`（无破坏性默认）：成功出口 200；未 hijack 失败出口 = 出口状态码；执行异常 = 合成 502；已 hijack 的流式失败 = 200（客户端实收 200 + 流内错误帧）。写侧带 `has*` 门禁 + 缺列降级（丢列不丢日志）；跨库迁移拷贝字段与三方言产物同步；新迁移 `drizzle/0032_proxy_logs_client_http_status.sql`。
  - `#8` 路由刷新最小埋点：`[proxy/route-refresh]` 结构化日志 + `getRouteRefreshObservation()` 计数（耗时/命中/成功/失败），纯观测，不改选择语义。
- **主要文件**：
  - `src/server/proxy-core/channelSelection.ts`
  - `src/server/proxy-core/orchestration/endpointFlow.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/db/schema.ts`、`src/server/db/index.ts`、`src/server/db/generated/*`
  - `src/server/services/proxyLogStore.ts`、`src/server/services/databaseMigrationService.ts`
  - `drizzle/0032_proxy_logs_client_http_status.sql`、`drizzle/meta/_journal.json`
- **验证**：
  - `npx drizzle-kit generate`（新迁移、二次运行 `No schema changes`）→ `npm run schema:contract` → `npm run build:server` → `npm run typecheck`（四段）→ `npm run repo:drift-check`（0 违规）→ `npm run test:schema:unit`（21 用例）→ 三方言 live：`test:schema:parity` / `test:schema:upgrade` / `test:schema:runtime`（mysql:8.4 + postgres:16 一次性容器，跑完 `docker rm -f`）。
  - 新增/扩展用例：#5 两条（`endpointFlow.test.ts`）、#6 两条（`sharedSurface.test.ts` claude 帧 + `chat.stream.test.ts` openai 帧，均断言不含 `[DONE]` 且随后 `end()`）、#7 三条（`schemaParity.test.ts` 契约+三方言产物、`databaseMigrationService.test.ts` 跨库拷贝字段、`sharedSurface.test.ts` 写日志入参）、#8 一条（`sharedSurface.test.ts`）；另扩展 `proxyLogStore.test.ts` 缺列降级一条、`migrate.test.ts` sqlite 迁移列断言一条。
  - 既有用例按预期纠正两处（均写明理由）：`chat.singleChannelFailure.test.ts` 的「单通道网络失败重试耗尽」由 `server_error` 改断 `upstream_error`，消息由笼统 'Upstream error' 改断真实原因（网络异常归一后与上游失败同路）。
- **交付物**：代码、测试、`.agents/notes/20261002-client-visible-failure-semantics.md` 与本条持续变更日志。
- **状态**：已完成（**未提交**）。已知开放项（见笔记「被放弃的方案」）：gemini 原生流 hijack 后仍不写错误帧（仓内无 gemini 帧形构造器，不猜测）；MySQL/PG 老库不经 upgrade 产物补列（upgrade 产物按既有约定保持空步），缺列时写侧降级 NULL。

### 2. 客户端可见失败语义（CVF）收边：带内失败帧识别与原样透传 / 未写字节走 HTTP 层 / 失败终态不生成终结帧 / 空内容判失败默认开 / `client_http_status` 落库守卫 / claude 老形失败改发 `event: error`

- **类型**：缺陷修复 + 契约变更（`proxy_logs` 可空观测列，第 1 条已登记）+ 配置默认值变更
- **需求来源**：本会话需求（任务标记 `MARK-B4-INBAND-1790927244`、`MARK-B4-FIX-R1-1790928`、`MARK-B4-R2-DEFAULT-ON-1790931`、`MARK-B4-R3-LEGACY-GATE-1790933`、`MARK-B4-R4-CLAUDE-LEGACY-1790941`；无 GitHub Issue 链接）
- **目标**：任何路径都不得让客户端把失败读成「正常结束」（含「正常结束但空」）——能走 HTTP 层（状态码 + 上游原文）就走 HTTP 层，已写过字节才走带内错误帧；观测面能回答「客户端实收几」。
- **实现范围**：
  - **带内失败帧识别（A/B）**：判据改为三分类 `classifyInBandFailure`（`transformers/openai/chat/proxyStream.ts:73`）——`legacy`（逐字保持老判据：`type` 为 `response.failed` / `error`）、`new`（顶层 `error` 对象 / `type` 为 `stream_error` / SSE 帧名 `error`）、`null`；`new` 形不再进归一化链被丢弃，改走带内失败出口 `emitInBandFailureFrame`（`:306`）：**上游 payload 原文 + 本仓重建的 SSE 信封**（`event:` 名保留、`data:` 原文逐行前缀，`formatRawSseBlock:90`）；claude 下游上游帧非 Anthropic 形，用本仓既有 claude 带内错误帧形承载同一份原文（恰一帧 `event: error`）。
  - **上游原文**：失败原因改取上游原文（`extractFailureMessage:164` 取 `error.message` / `message` / `response.error.message`，取不到才回落原始 `data`），并另补尾部标识 `(code=…, request_id=…)`（`appendFailureIdentifiers:101`，不覆盖原文）。
  - **未写字节 ⇒ HTTP 层失败（M2 / R3-A）**：`new` 与 `legacy` 失败帧在「本轮尚未向下游写出任何字节」时不再 hijack 成 200 SSE，只 `markFailed(上游原文)`，由既有 HTTP 层出口下发 **502** + `error.type='upstream_error'` + 上游原文（legacy 门禁 `:476-486`、new 分支 `:457-472`）；已写字节才带内透传；`finalize()` 失败终态不 flush 缓冲（否则会把 502 出口 hijack 成 200 SSE）。
  - **失败终态不生成终结帧（M3）**：`finalize():347-362` 失败终态 early-return，本仓不再生成 openai `data: [DONE]` / claude `message_stop`；上游自带的 `[DONE]` 仅在 **openai 下游**、且已写字节时原样回放（回放条件 `:355`）。
  - **claude 下游 legacy 老形改发 `event: error`（R4）**：`response.failed` + 已写字节 + claude 下游此前渲染 `message_delta{stop_reason:'end_turn'}` + `message_stop`（客户端读作「正常结束（带部分内容）」、服务端记 failed），现改为复用 `emitInBandFailureFrame` 的 claude 分支 ⇒ **恰一帧 `event: error`**（message = 上游原文 + 后缀）、无本仓终结帧，已写出的内容原样保留在前（分支 `:487-502`）；openai 下游一字未动。
  - **空内容判失败默认开（R2）**：`src/server/config.ts:189-190` 默认 `false → true`（仅 `PROXY_EMPTY_CONTENT_FAIL=false` 可关）；UI 占位值与勾选项文案（`src/web/pages/UpstreamSettings.tsx`）、`.env.example`、`docs/configuration.md` 同步；新增 `config.test.ts` 两条（默认 true / 显式 false）。
  - **落库守卫与标识后缀（S2）**：新增 `guardUpstreamErrorMessageForLog`（64KB）与 `truncateUpstreamErrorMessageWithLimit`（`src/server/proxy-core/surfaces/sharedSurface.ts`）——**尾部 `(code=…, request_id=…)` 标识后缀不受截断影响**；下发给客户端的 1000 封顶口径不变，带内透传的上游帧不封顶。
  - **口径订正（第 1 条「状态」项）**：MySQL/PG 老库的 `client_http_status` 补列**不走盘上 upgrade 产物、由启动期 runtime bootstrap 按 schema contract 差分补列**（详见笔记「被放弃的方案」第 5 条的订正）；upgrade 产物仍按既有约定保持空步（`schemaParity.test.ts` 的空步断言未动）。原「缺列时写侧降级 NULL」是防御位（迁移/bootstrap 未跑过或失败时），不是老库常态。
- **主要文件**：
  - `src/server/transformers/openai/chat/proxyStream.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`、`chatSurface.ts`、`openAiResponsesSurface.ts`
  - `src/server/proxy-core/orchestration/endpointFlow.ts`、`src/server/proxy-core/channelSelection.ts`
  - `src/server/services/proxyLogStore.ts`、`src/server/db/index.ts`
  - `src/server/config.ts`、`src/web/pages/UpstreamSettings.tsx`
  - `src/server/routes/proxy/chat.stream.test.ts`、`chat.singleChannelFailure.test.ts`、`src/server/proxy-core/surfaces/sharedSurface.test.ts`、`src/server/routes/proxy/endpointFlow.test.ts`
  - `.agents/notes/20261002-client-visible-failure-semantics.md`
- **验证**：本批统一验证见下方第 4 条；逐轮的先红后绿证据见笔记各轮「验证」小节（日志在 `/tmp/b4*`：B4 的 6 例红 / R1 的四项单项红 / R2 的 config 默认值红 / R3-A 的两例红 / R4 的一例红，均为「只回退该项修复、保留用例」的真跑）。
- **交付物**：代码、测试、笔记与本条持续变更日志。
- **状态**：已完成（**未提交**）。已知开放项：R4-①（openai 下游 `response.failed` + 已写字节仍渲染 `finish_reason:"stop"`，**有意保留**、是否加固待定）、N-3（`(code=…)` 只读顶层 `error.code`）、O1/O2/O6、O-a..O-e、R3-①..R3-⑤，均在笔记「遗留清单」，本批不处理。

### 3. 修掉依赖真实时钟的夹具时间炸弹（`upstreamObservations.test.ts`）

- **类型**：测试修复（CI 稳定性）
- **需求来源**：本会话需求（发版准备台账，任务标记 `MARK-RELEASE-PREP-1415-1790945`；无 GitHub Issue 链接）
- **目标**：消除「用例随日期漂移变红」的预存夹具炸弹。
- **实现范围**：`BASE_MS` 由硬编码 `Date.UTC(2026, 8, 25, 7, 0, 0)` 改为 `Math.floor(Date.now() / 1000) * 1000`（秒精度，保持原有 `BASE_UTC === BASE_MS` 语义），并在文件内写明原因：聚合路由的默认窗口按墙上时钟解析（`to = now`、`from = to - 7d`），硬编码锚点一旦超过 7 天，整组夹具即被排出默认窗口，断言不再测它要测的东西。
- **主要文件**：`src/server/routes/api/upstreamObservations.test.ts`
- **偏差（如实登记）**：台账另点名 `src/server/routes/api/checkin.lock.test.ts` 与 `src/server/services/databaseMigrationService.test.ts`；逐文件核对 `git diff` 后确认这两文件本批的改动**与时钟无关**（分别为新增 `hasProxyLogClientHttpStatusColumn` mock 一行、新增 `client_http_status` 跨库拷贝用例），归属 CVF 那一块。本批真实的时间依赖修复**只有本文件一处**；仓库内其它硬编码日历夹具未在本批扩大改动面。
- **验证**：见下方第 4 条（全量测试含该文件全绿）。
- **交付物**：测试、本条持续变更日志。
- **状态**：已完成（**未提交**）。

### 4. 版本 1.4.15 与发版文档口径修正（发版准备，不含发版动作）

- **类型**：文档与版本
- **需求来源**：本会话需求（任务标记 `MARK-RELEASE-PREP-1415-1790945`；无 GitHub Issue 链接）
- **目标**：本批次（CVF 收边 + 时间炸弹修复）的版本号与日志文档就位，并修正笔记里与代码不一致的口径，供 reviewer / oracle 核验后提交与发版。
- **实现范围**：
  - 版本：`package.json` `1.4.14 → 1.4.15`。复核依据（只读）：`git log --oneline -3 origin/main` = `8c6ccd4c chore(release): 1.4.14` ⇒ 1.4.14 已发布，本批为 1.4.15。
  - `CHANGELOG.md` 顶部新增 `## [1.4.15] - 2026-10-02`（覆盖 CVF 与时间炸弹两块；空内容默认开、`client_http_status`、路由刷新埋点记入「变更」）。
  - 本文件补第 2、3、4 条。
  - `.agents/notes/20261002-client-visible-failure-semantics.md` 四处口径修正：**N-1** 对照表第 4 行「`type:'error'` …（openai 与 claude 下游皆然）」不实 ⇒ 改为「**openai 下游**走归一化块；claude 下游该形由 `consumeAnthropicSseEvent` 原生帧支线接手（同表第 8 行）」；**N-2** 「（上游带了则回放）」限定为 **openai 下游**（`proxyStream.ts:355` 的回放条件含 `downstreamFormat === 'openai'`）；**R4-①** 登记观察项「openai 下游 + `response.failed` + 已写字节 ⇒ 归一化块渲染 `finish_reason:"stop"`」（`transformers/shared/chatFormatsCore.ts:1767-1783`、`:591-593`；测试 `transformers/openai/chat/index.test.ts:623`、`transformers/shared/chatFormatsCore.test.ts:371`），**有意保留**（既有测试名 "…instead of inventing a chat error finish reason"）、是否加固待定；**N-3** 登记 `(code=…)` 后缀取值面（只读顶层 `error.code`，`response.failed` 常见嵌套形拿不到 `code`；继承自 R1）。
- **主要文件**：`package.json`、`CHANGELOG.md`、`docs/change-log.md`、`.agents/notes/20261002-client-visible-failure-semantics.md`
- **验证**：`npx tsc --noEmit -p tsconfig.server.json` exit 0；`npm run typecheck`（web / web:test / server / desktop 四段）exit 0；`npm test -- --no-file-parallelism` **连跑均 exit 0**、`Test Files 508 passed | 2 skipped (510)`、`Tests 3380 passed | 16 skipped (3396)`（其中一遍日志 `/tmp/release-prep-1415-full-test.log`；oracle 独立复跑一遍 236.12s 全绿）；`npm run repo:drift-check` `Violations: 0`（5 条预存 tracked debt）。本片未改任何 `src/**` 生产代码（`package.json` 版本号除外）。
- **交付物**：版本号、三处日志文档、笔记口径修正。
- **状态**：已完成（**未提交**）。发版动作（`scripts/deploy-painless.sh --version 1.4.15 --yes` 及之后的验收 / 收尾）不在本条范围：本片**未执行任何 git 写操作，未触碰容器 / 生产库 / 生产设置**。

## 后续记录模板

复制下面模板追加到对应日期下，先记录需求来源，再补充实际实现和验证结果：

```md
### YYYY-MM-DD - 简短标题

- **类型**：功能实现 / 缺陷修复 / 重构 / 文档
- **需求来源**：[Issue #N](https://github.com/cita-777/metapi/issues/N) 或本会话需求
- **目标**：
- **实现范围**：
- **主要文件**：
  - `path/to/file`
- **验证**：
- **交付物**：代码、文档、PDF、截图等；没有交付物时填写“无”。
- **状态**：进行中 / 已完成 / 阻塞
```
