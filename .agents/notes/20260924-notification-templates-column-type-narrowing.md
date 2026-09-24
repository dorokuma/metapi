---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: db
---

# 通知模板列型整改（第三轮）：VARCHAR(191) 规则收窄 + 显式长文本标记

## 一句话结论

第三轮只修二轮 oracle 提出的唯一阻塞：`mapColumnType` 的 MySQL text 规则从「仅主键 → VARCHAR(191)」
回退为「主键，或历史 DDL 确有 VARCHAR(191) 定义（带默认值）的列 → VARCHAR(191)」，
`notification_templates.title/body/parse_mode` 通过生成器内的显式长文本标记白名单保持 TEXT。
既有表 bootstrap 产物与 HEAD 逐字节一致，仅多出 notification_templates 表相关行。

## 背景

二轮把规则放宽成「text 一律 TEXT（除主键）」后，既有表（sites.status、accounts.status、
account_tokens.source/value_status、events.level、site_announcements.level、
token_routes.routing_strategy/route_mode、oauth_route_units.strategy、
analytics_projection_checkpoints.time_zone、sites.post_refresh_probe_* 等非主键带默认值 text 列）
在 mysql.bootstrap.sql 里从 VARCHAR(191) 变成 TEXT，与存量库定义分叉，oracle 判定阻塞。

## 决策

1. **规则收窄回 HEAD 语义 + 显式例外**：`mapColumnType` 对 mysql text 列恢复
   `primaryKey || defaultValue != null ? VARCHAR(191) : TEXT`，与存量 DDL 逐字节一致；
   模板表三列不进该分支，由 `MYSQL_LONG_TEXT_COLUMNS` 按 table.column 白名单显式登记，
   命中即强制 TEXT。新增长文本列必须在白名单登记，无法隐式生效，防止误伤其他表列型。
2. **tableName 下传**：`mapColumnType` / `buildColumnDefinition` 增加 tableName 参数
   （bootstrap 与 upgrade 的 ADD COLUMN 两条路径都传），标记判定需要表名。
3. **产物再生成必须以上一个已发布契约为 previous**：先 `git checkout HEAD -- generated/schemaContract.json`，
   再 `npm run schema:contract`。若直接重跑，previous 已是含 notification_templates 的工作区契约，
   upgrade.sql 会退化成 `-- no schema changes detected`，真实升级路径丢失（二轮踩坑同款）。
4. **测试断言三分**：既有表带默认值 text 列仍为 VARCHAR(191)（合成契约 + 真实契约两类断言）、
   模板表 title/body/parse_mode 为 TEXT、非主键带默认值且无长文本标记的列仍为 VARCHAR(191)。
5. **CHANGELOG 措辞**：不得声称「所有 text 列改为 TEXT」；改为「仅 notification_templates 三列
   经长文本标记保持 TEXT，既有表列型不变」。

## 被放弃的方案（必填）

- **继续用「text 一律 TEXT（除主键）」**：废弃。虽语义更干净，但会改掉存量库列型，oracle 阻塞。
- **在 Drizzle schema.ts 列定义处加注释注记并由生成器解析**：废弃。契约生成走的是
  SQLite migration → PRAGMA table_info 的内省链路，schema.ts 注记到不了生成器；
  SQLite 也不保留列注释。生成器白名单是唯一能把标记送到 mapColumnType 的链路。
- **在 SchemaContract 增加 longText 字段**：废弃。契约由 migration 内省生成，
  内省结果里没有该信息，字段只能由生成器侧兜底写入，等于把白名单换个位置，没有额外收益。

## 影响与验证

- `npm run build` / `npm test` / `npm run typecheck` / `npm run repo:drift-check` 全部通过。
- `npm run test:schema:unit`、`npm run test:schema:parity`、`npm run test:schema:upgrade` 全部通过。
- git diff 证据：mysql/postgres.bootstrap.sql 相对 HEAD 仅 +1 行 notification_templates；
  mysql/postgres.upgrade.sql 仅把 HEAD 单行换成 notification_templates 建表行；
  schemaContract.json 仅新增 notification_templates 段落。
