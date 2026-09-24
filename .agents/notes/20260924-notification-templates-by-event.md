---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: services
---

# 通知模板按事件类型定制：notification_templates 表化与复合主键产物

## 一句话结论

推送模板从「渠道维度」升级为「事件类型 × 渠道」：新增 `notification_templates` 表（复合主键 `(event_type, channel)`），
`settings.notification_templates_v1` 旧 JSON 由启动期幂等迁移拆成 `__global__` 行，`sendNotification` 增加必填 `eventType`；
顺带给 schema 产物生成器补上复合主键支持，否则契约生成的 MySQL/Postgres/SQLite bootstrap DDL 全是非法的。

## 背景

原实现把模板存在 `settings` 的 JSON 里，一个渠道一套模板，所有事件（Token 失效、代理告警、站点公告、签到、每日总结……）
只能共用同一份格式。需求要求按事件类型定制，并新增 `daily_summary` 类型与其专属变量。

## 决策

1. **表结构**：`notification_templates(event_type, channel, title, body, parse_mode, created_at, updated_at)`，
   主键 `(event_type, channel)`，`__global__` 作为兜底行（不是特殊枚举值之外的魔法串，而是事件类型域内的一个合法取值）。
   没有用「单列自增 id + unique index」：那样需要额外一次查询约束语义，且 `(event_type, channel)` 本身就是自然键。
2. **复合主键必须改生成器**：sqlite `PRAGMA table_info` 对复合主键的每个成员都返回 `pk > 0`，
   `schemaArtifactGenerator.buildCreateTableStatement()` 原本逐列内联 `PRIMARY KEY`，会生成
   `(event_type TEXT ... PRIMARY KEY, channel TEXT ... PRIMARY KEY)` 这种 SQLite / MySQL / Postgres 都拒绝的 DDL。
   改为：主键列数为 1 时保持内联（字节级兼容已有产物），> 1 时输出表级 `PRIMARY KEY (a, b)`，列顺序取契约里的声明顺序。
3. **老数据迁移放应用层而非 SQL**：legacy 数据是 `settings.value` 里的 JSON，拆行需要解析 JSON 并写入新表；
   SQLite 迁移文件若用 `json_extract` 会让「迁移即契约来源」这条链路依赖 JSON1 扩展，且 MySQL/Postgres 根本没有这条迁移路径。
   因此迁移实现为 `ensureLegacyNotificationTemplatesMigrated()`（drizzle 查询、方言无关），在 `src/server/index.ts` 启动期调用，
   并在每次 `loadNotificationTemplates()` 前惰性兜底；成功后删除 legacy setting，天然幂等。
4. **回退顺序单点实现**：`loadNotificationTemplatesForEvent(eventType)` 用一条
   `event_type IN (eventType, '__global__')` 查询同时取出精确与兜底两组，`pickEventChannelTemplate()` 只做
   `exact ?? global`，第三级回退（渠道硬编码默认渲染）仍留在 `notifyService` 的 fallback 参数里，职责不混。
5. **`eventType` 设为必填且不给默认值**：静默默认值会让调用点永远漂移到全局模板。7 个调用点全部显式传值，
   测试里也全部显式传，便于用类型系统兜住新增调用点。
6. **daily_summary 专属变量集中在 `dailySummaryService.ts`**（`DAILY_SUMMARY_TEMPLATE_VARIABLES` /
   `buildDailySummaryTemplateVars()`），通过 `SendNotificationOptions.extraVars` 注入 `NotificationTemplateVars.extra`；
   渲染时专属变量与通用变量同一套 `{{name}}` 替换与转义逻辑，不引入第二套模板引擎。命名全部 snake_case，与
   `local_time` / `utc_time` 等保持一致。

## 被放弃的方案（必填）

- **扁平结构改成 `(event, channel)` 后仍保留一个 `notificationTemplatesByEvent` 内存缓存**：废弃。加载是一次
  `IN (...)` 查询，量极小，加缓存只会引入失效问题。
- **迁移写进 SQLite migration 文件**：废弃。见决策 3，会让契约链路依赖 `json_extract`，且 MySQL/Postgres 无从执行。
- **`__global__` 用 `null`/空串表示**：废弃。空串在 SQLite 主键里语义模糊，`null` 会被 `NOT NULL` 挡下；
  用一个显式的、人类可读的常量更利于前端展示与排障。
- **前端把 `__global__` 当成隐藏概念、非全局类型一律只读**：废弃。用户无法预知非全局类型实际会发出什么。
  最终做法是未单独定义时直接展示并编辑全局模板（读写落到 `__global__`），额外提供「一键继承全局」生成独立覆盖与
  「恢复继承全局」删除覆盖，两个方向都可逆。

## 影响与验证

- `npm run build` / `npm test` / `npm run typecheck` / `npm run repo:drift-check` 全部通过。
- `npm run test:schema:unit`、`npm run test:schema:parity`、`npm run test:schema:upgrade` 全部通过
  （MySQL / Postgres live 用例因无连接串按既有机制 skip）。
- 新增/更新测试：`notificationTemplates.test.ts`（双层校验、回退顺序、legacy 迁移、扁平结构兼容、按事件隔离）、
  `notifyService.test.ts`（eventType 路由）、`schemaContract.test.ts` / `schemaArtifactGenerator.test.ts`
  （复合主键契约与产物）、`NotificationSettings.templates.test.tsx`（矩阵、继承全局、专属变量）。
- 老数据迁移路径有测试覆盖：测试先 `upsertSetting('notification_templates_v1', {...})`，再
  `loadNotificationTemplates()` 断言 `__global__` 行内容与 legacy 键被删除，并验证二次加载幂等。
