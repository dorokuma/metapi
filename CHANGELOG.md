# 变更日志 / Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本约定。
更早的历史变更见 [docs/change-log.md](docs/change-log.md)。

## [Unreleased]

## [1.4.11] - 2026-09-29

### 修复

- token 路由 dump 清理锁改用内核 `flock(2)`：废弃伪 CAS/陈旧锁接管；进程崩溃后由内核即时释放锁、活进程持有期间不被抢占；非 Linux / 无 flock 环境 fail-closed 跳过清理（warn）。

### 变更

- `scripts/deploy-painless.sh` 人工清单补充「存量裁剪」提醒（DB 快照留最新 7 个、镜像只留当前发版版本）。

## [1.4.10] - 2026-09-29

### 修复

- 多 key 轮换修复：单 key 瞬态失败（502/429/超时）不再连坐同站其它 key（token 级隔离、模型级熔断仅按模型级失败门控）；全部候选被挡时才判死（返回空候选，不再回退放行）；恢复逐 key 独立生效。

## [1.4.9] - 2026-09-28

### 变更

- 使用日志（ProxyLogs）表格新增速度列并压缩列宽。

## [1.4.8] - 2026-09-28

### 修复

- 生产依赖漏洞清零：`npm audit --omit=dev --audit-level=high` 由 13 项（其中 11 项 high）归零，覆盖 nodemailer 的 SSRF / 头注入 / TLS 校验类与 fastify / undici / ws 的 SSRF 绕过与 DoS。

### 变更

- 依赖升级：11 项补丁/次版本（`fastify` 5.12.5、`undici` 6.29.0、`ws` 8.22.0、`js-yaml` 4.3.2、`mysql2` 3.24.4、`ip-address` 10.7.2、`electron-updater` 6.8.9 等）。
- 依赖升级：`@fastify/static` ^10.1.5、`nodemailer` ^10.0.12（均为大版本）。`@fastify/static` v10 的 `setHeaders` 首参由 `ServerResponse` 变为 `FastifyReply`，缓存头改用等价的 `reply.header`。

## [1.4.7] - 2026-09-28

### 新增

- 站点分布与趋势图新增「词元」维度：`site_day_usage.totalTokens` 接入站点级分布/趋势 API 与前端图表，支持「词元趋势」「词元分布」切换展示。

### 修复

- MySQL 长文本列不再生成 DEFAULT 子句（TEXT 列带 DEFAULT 违反 MySQL 约束致 schema 门禁必红），并修 live 测试方言兼容（`.returning()`）与 BIGINT 断言类型。

### 变更

- CI：未配置 Docker Hub secrets 时发布 job 自动跳过（guard job 模式）；`npm audit` 在 push 路径降级为报告输出，不再阻断（跟进责任已登记 .agents/notes）。

## [1.4.6] - 2026-09-28

### 新增

- 词元用量重建与聚合投影：`proxy_logs` 用量列语义重构，presence 化解析与六写入点归一接线；聚合投影层落地，支持站点级用量统计。
- 单站点守卫收紧、快照 backup 七键三态、SQLite 哨兵 -1 自增语义断言、站点序列三方言矩阵 live 接线。

### 修复

- SQLite bootstrap 缺失 `AUTOINCREMENT`：`sqlite` 引擎初始化时未加 `AUTOINCREMENT` 导致 ID 不自增，现已修复。
- Drizzle journal 0005 断档与快照链头刷新：journal 序号跳号致 migrate 断档，0005 补齐；快照链头未刷新致 upgrade 误判，已修正。
- Upgrade 产物空步归正：upgrade 生成器在空迁移步骤时输出空文件，现归正为跳过空步。

### 变更

- 集成 main 分支 1h 缓存列（cc1h）：`cache_creation_tokens_1h` 列贯通四调用点（completions 流式/非流式、embeddings、sharedSurface），保持既有口径。

## [1.4.5] - 2026-09-27

### 修复

- new-api 站点 token 级模型发现合并用户级模型列表：token 实际可调用但 `/v1/models` 不暴露的模型（经 `/api/user/models` 用户级列表发现）现会写入 token 可用模型并参与路由，修复此类模型无法被路由选择的问题。

### 变更

- 依赖升级：`better-sqlite3` 13、`electron-builder` 26.15。
- Node 最低版本要求调整为 22.15（engines >=22.15.0，CI NODE_VERSION 为 22.15）。

## [1.4.4] - 2026-09-27

### 修复

- 首字节超时清理改为有界取消：`reader.cancel()` 在 body 来自 `tee()` 分支时可能永不 settle，清理路径原先无界等待会把合成 408 响应一并挂住；现统一经 `settleReaderCancelQuietly`（默认 250ms 上限，并吞掉取消失败与迟到的 rejection）。

## [1.4.3] - 2026-09-27

### 修复

- 启动横幅不再回显令牌明文：`startupInfo` 的 Admin/Proxy curl 示例此前把 `AUTH_TOKEN` / `PROXY_TOKEN` 明文写进 stdout 与 `docker logs`，现改为 `$AUTH_TOKEN` / `$PROXY_TOKEN` 占位，并新增「横幅不含 Bearer 明文」回归断言。

### 变更

- 通知设置页：全局模板标签由「全局（兜底）」精简为「全局」。
- 通知设置页：全局模板上下文不再显示「已定制」圆点——该层本无覆盖语义，「已定制」字样会误导；代价是全局层不再逐渠道标注是否已配置，需点开渠道查看。

## [1.4.2] - 2026-09-27

### 修复

- 计费修复：支持上游 `tiered_expr` 表达式计费，新增安全表达式求值器替代占位 `model_ratio` 平铺多计；`billing_details` 增加 `pricingSource` 标记与可审计回退。

## [1.4.1] - 2026-09-27

### 修复

- 修复 pi（OpenAI 流）thinking 签名回传：`reasoning_details` 闭环，消除 thinking 模式 `The content[].thinking ... must be passed back` 类 400。上游 Anthropic 流的 `signature_delta` 缓冲后随 thinking 文本以一条流式 `reasoning_details` chunk 下发（先于 `finish_reason`/`[DONE]`），pi 存储并回传，入站还原为 `thinking.signature`；涉及 transformers：`chatFormatsCore` / `openai/chat/proxyStream` / `anthropic/messages/conversion`。

## [1.4.0] - 2026-09-24

### 新增

- 通知模板支持按事件类型定制：新增 `notification_templates` 表（主键 `(event_type, channel)`，字段 `title` / `body` / `parse_mode`），替换原先存放在 `settings.notification_templates_v1` 的扁平 JSON。
- 新增 `daily_summary`（每日总结）事件类型及专属模板变量：`local_day`、`generated_at_local`、`total_accounts`、`active_accounts`、`low_balance_accounts`、`checkin_total`、`checkin_success`、`checkin_skipped`、`checkin_failed`、`proxy_total`、`proxy_success`、`proxy_failed`、`proxy_total_tokens`、`today_spend`、`today_reward`、`today_net`。
- 模板解析顺序调整为：`(eventType, channel)` 精确匹配 → `(__global__, channel)` 兜底行 → 各渠道原有硬编码默认渲染。

### 变更

- `GET` / `PUT /api/settings/runtime` 的 `notificationTemplates` 由「渠道 → 模板」改为「事件类型 → 渠道 → 模板」两层结构；新增 `notificationTemplateVariablesByEvent` 字段说明各事件类型可用变量。
- `sendNotification()` 新增必填 `eventType` 参数（无静默默认值），全部调用点显式传值：`alertService`（token / proxy）、`siteAnnouncementService`（site_notice）、`checkinService`（checkin）、`checkinScheduler` 每日总结（daily_summary）、`updateCenterPollingService` 与 `backgroundTaskService`（status）、设置页测试通知（`__global__`）。
- 通知设置页的模板编辑从「渠道 Tab」改为「事件类型 × 渠道」矩阵：未单独定义的类型/渠道直接展示并编辑全局模板，支持一键继承全局与恢复继承，保留变量说明与实时预览；`daily_summary` 下额外提供专属变量。
- `events.type` 白名单扩展 `daily_summary`（事件筛选与标签同步更新）。

### 修复

- 数据库 schema 生成器支持复合主键：多列主键输出表级 `PRIMARY KEY (a, b)`，避免逐列内联产生非法的 "more than one primary key" DDL。
- **双审整改（推送模板按事件定制）**：
  - legacy 模板迁移（`settings.notification_templates_v1` → `notification_templates`）不再「事务内全表 delete 再 insert」，改为只补齐缺失的 `__global__` 行的幂等写入（SQLite/Postgres `ON CONFLICT DO NOTHING`，MySQL `ON DUPLICATE KEY UPDATE` 等价写法）：任何情况下都不会删除或覆盖已有的事件覆盖行，多实例并发下也不会丢行；迁移成功后删除 legacy 键的逻辑保持幂等。
  - 模板热路径（每条通知一次）新增进程内迁移标记：启动迁移成功后不再查询 settings，只有备份导入 / 恢复出厂入口会重置该标记，导入旧版备份后重迁移只补 `__global__`、不删事件行。
  - 通知设置页状态机修复：未定制的事件上输入或点击专属变量 chip 时，会先在该事件上创建独立覆盖（不再静默写回全局模板）；「全局为空 + 一键继承全局」不再死锁，覆盖行的判据改为「该事件在 payload 中存在覆盖行」而不再凭模板内容判空；保存后本地状态与服务端语义一致（空覆盖行视为继承）。
  - 备份（`exportBackup` / `importBackup` 的 preferences 段落）纳入 `notification_templates` 表：导出全部行（含事件覆盖），导入按「恢复备份中的行」处理；恢复出厂已清表的逻辑保持一致。
  - MySQL 侧 `notification_templates` 的 `title` / `body` / `parse_mode` 三列通过显式长文本标记保持 `TEXT`（不再因为带默认值被映射成 `VARCHAR(191)`），模板正文不再有 191 字截断；仅主键或历史 DDL 确有 `VARCHAR(191)` 定义（带默认值）的列保持 `VARCHAR(191)`，既有表（如 `sites.status`、`events.level`、`token_routes.routing_strategy` 等）列型与存量库逐字节一致、不受影响；`mysql/postgres.bootstrap.sql`、`mysql/postgres.upgrade.sql`、`schemaContract.json` 已同步重新生成。
  - `parseNotificationTemplatesInput` 上提历史扁平格式兼容（顶层为渠道键时归一化成 `__global__` 层），`PUT /api/settings/runtime` 收到扁平 payload 返回 200；`saveNotificationTemplates` 与解析共用同一处扁平兼容实现。
  - `sendNotification` 的必填 `eventType` 前置到 `level` 之前，全部调用点同步更新；移除 `loadNotificationTemplatesForEvent` 对非法 `eventType` 静默降级为 `__global__` 的行为，改为显式报错。
  - 模板回退改为字段级：事件行只定义 `body` 时，`title` / `parseMode` 从 `__global__` 行继承，两级都缺省时才走渠道硬编码默认渲染。
- 流式响应补发终态 usage chunk（`a21e8d5`）：`stream_options.include_usage` 在 openai chat 流式会话中此前只被解析、没有下传到流上下文，上游只在收尾帧（`choices: []` 单帧）给出 usage 时该帧会被整体丢弃；现在该标记随流会话传递，并在 `[DONE]` 之前补发一条 `choices: []` 的终态 usage chunk，失败流与空内容流不会补帧。

### 迁移说明

- 升级时自动把 `settings.notification_templates_v1` 的旧 JSON 拆分为 `(__global__, channel)` 行并删除旧键，老用户推送模板行为不变；迁移幂等，重复执行无副作用。
- Schema 变更三处同步：Drizzle schema（`src/server/db/schema.ts`）、SQLite migration（`drizzle/0029_notification_templates.sql`）、checked-in schema artifacts（`src/server/db/generated/*`）。
