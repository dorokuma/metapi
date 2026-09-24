# 变更日志 / Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本约定。
更早的历史变更见 [docs/change-log.md](docs/change-log.md)。

## [Unreleased]

### 变更

- 通知设置页：全局模板标签由「全局（兜底）」精简为「全局」。
- 通知设置页：全局模板上下文不再显示「已定制」圆点——该层本无覆盖语义，「已定制」字样会误导；代价是全局层不再逐渠道标注是否已配置，需点开渠道查看。

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
