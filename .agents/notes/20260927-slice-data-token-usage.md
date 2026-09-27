# 切片 data：精确词元消耗统计数据层（2026-09-27）

> 本切片仅覆盖数据层（schema / 迁移 / 契约产物 / 迁移服务列清单）。  
> 不做解析、写入点、聚合、导入导出、哨兵等其它切片。

---

## 一、改动清单

### 1. `src/server/db/schema.ts`（proxy_logs 表 + 索引）

- 新增 8 列（全部可空，不加 FK）：
  - 用量五列：`cache_read_tokens`（int）、`cache_creation_tokens`（int）、`reasoning_tokens`（int）、`prompt_tokens_include_cache`（boolean）、`usage_source`（text）
  - 站点归属三列：`site_id`（int）、`model_site_id`（int）、`credential_site_id`（int）
- 新增索引：`proxy_logs_site_id_idx` on `(site_id, id)`
- 依据规范：§1.2（五列语义）、§1.3（三列+索引）、§2.1（列定义）

### 2. `drizzle/0031_proxy_logs_usage_columns.sql`（新建迁移）

- 8 条 ALTER TABLE ADD COLUMN + 1 条 CREATE INDEX
- 风格与现有 SQLite 迁移一致（`--> statement-breakpoint` 分隔）
- 三方言升级 SQL 由 `schema:generate` 从 schema contract 自动生成

### 3. `drizzle/meta/_journal.json`

- 新增 idx 31：`0031_proxy_logs_usage_columns`
- 清理误生成的 0032 条目（drizzle-kit 在无数据库文件时生成的快照式迁移，含重复 CREATE TABLE，已删除）

### 4. `src/server/db/schemaMetadata.ts`

- `isBooleanLikeColumn` 增加 `prompt_tokens_include_cache` 匹配规则
- 使 schema contract 生成器正确将该列分类为 `boolean`（SQLite 原生无 boolean 类型，依赖名称启发式）

### 5. 契约产物（`npm run schema:contract` 再生）

- `src/server/db/generated/schemaContract.json`：含 8 新列 + 1 新索引
- `src/server/db/generated/mysql.bootstrap.sql` / `postgres.bootstrap.sql`：proxy_logs 含 8 新列 + site_id 索引
- `src/server/db/generated/mysql.upgrade.sql` / `postgres.upgrade.sql`：

  > **根因说明**：首次运行时，生成器以盘上现有 `schemaContract.json` 作为 `previousContract` 自比；若合同文件已包含新列，则 diff 为空，输出 `-- no schema changes detected`。这不是「无 previous contract 可 diff」，而是「previous contract 与 current contract 一致」。
  >
  > **正确再生成步骤**：
  > 1. 确认 `src/server/db/schema.ts` 中 proxy_logs 已含 8 新列 + 1 索引（当前已满足）；
  > 2. 将 `src/server/db/generated/schemaContract.json` 临时还原为不含这 8 列 + 1 索引的上一发布基准版本（HEAD 版本），作为 `previousContract`；
  > 3. 执行 `npm run schema:contract`（只跑契约生成，不触发 `db:generate`；`schema:generate` 内含 drizzle-kit 快照生成，而 drizzle-kit 快照仍停在 0028，有按旧结构重放的风险；参见 `.agents/notes/20260925-drizzle-kit-stale-snapshot-0030.md` 的既有判定）；
  > 4. 生成器会读取还原后的 `schemaContract.json` 作为 previousContract，与由 schema.ts 生成的 currentContract 做 diff，输出正确的 ADD COLUMN / CREATE INDEX 增量；
  > 5. 验证两份 upgrade.sql 含 8 条 ADD COLUMN 与 `proxy_logs_site_id_idx`；
  > 6. 将 `schemaContract.json` 恢复为含新列的终态（直接写回终态内容），并确保 bootstrap.sql 也保持终态。
  >
  > 注意：0030 的增量（上游观测表及相关索引）已由 commit `10bc02d` 发布，不在本次 upgrade 产物中；previousContract 应取 0030 发布后的状态，不是更早。
  >
  > **语义约束**：upgrade 产物现含本次增量（8 条 ADD COLUMN + `proxy_logs_site_id_idx` 索引）；其语义是「相对上一发布基准（HEAD）的滚动增量」，不得改成累计、不得允许为空；二次生成会自比差清空（生成器以盘上现有契约为 previous）。

### 6. `src/server/services/databaseMigrationService.ts`

- **buildStatements 列清单**（proxy_logs）：补 `site_id`、`model_site_id`、`credential_site_id` 三列及对应 values
- **clearTargetData**：并入 `analytics_projection_checkpoints`（规范 §11.5）
- **toBackupSnapshot**：确认三聚合表（site_day_usage / site_hour_usage / model_day_usage）与 checkpoint 均不在快照中（已满足，无需改动）

### 7. `src/server/db/schemaParity.test.ts`

- 在现有 proxy_logs bootstrap 断言块中新增：
  - 五列 contract logicalType 断言
  - 三列 contract logicalType 断言
  - `proxy_logs_site_id_idx` 索引断言
  - bootstrap 三方言连续断言（8 列 + 1 索引均存在于 mysql/postgres bootstrap SQL）

### 8. `src/server/db/migrate.test.ts`

- `recovers sequential duplicate-column migrations` 测试：该测试模拟存量库已通过兼容 SQL 写入部分列的场景；
- **journal when 重复机制**：drizzle sqlite migrator 使用 `created_at < ?` 的严格小于比较来判断迁移是否已应用。若两条迁移的 `when` 完全相同，已应用 0030（`created_at = 1790320000000`）的存量库在执行 0031（`when = 1790320000000`）时，条件 `1790320000000 < 1790320000000` 为 false，故 0031 的 SQL **静默跳过**，列不会被创建。修复方法是将 0031 的 `when` 改为严格大于 0030 的值（如 `1790320000001`），确保 `<` 比较能正确识别 0031 尚未应用。
- 2026-09-27 修复后，已移除 0031 过滤，测试在全量 journal 下直接通过。

---

## 二、门禁结果

| 门禁 | 命令 | 结果 |
|------|------|------|
| 类型检查 | `npm run typecheck:server` | ✅ PASS（exit 0） |
| Schema 单元测试 | `npm run test:schema:unit` | ✅ 19/19 PASS |
| 迁移单元测试 | `npx vitest run src/server/db/migrate.test.ts` | ✅ 11/11 PASS |
| 迁移服务测试 | `npx vitest run src/server/services/databaseMigrationService.test.ts` | ✅ 27/27 PASS |
| 仓库漂移检查 | `npm run repo:drift-check` | ✅ 0 violations |
| 全量 db 测试 | `npx vitest run src/server/db/` | ✅ 108/108 PASS（6 skipped：live 门控） |

> 注：`schemaParity.live.test.ts` / `schemaUpgrade.live.test.ts` / `runtimeSchemaBootstrap.live.test.ts` 在无外部 MySQL/PG 时 skip，符合现有 live-gated 设计（规范 §10.1）。

---

## 三、旧锚点 → 新锚点对照表

> 规范材料中的行号锚点指向已不存在的 `metapi-token-stats` 工作树。  
> 以下按当前工作树 `/root/workspace/metapi-usage-rebuild` 重新锚定。

| 旧锚点（metapi-token-stats） | 新锚点（metapi-usage-rebuild） | 说明 |
|------------------------------|-------------------------------|------|
| `databaseMigrationService.ts:596-599`（proxy_logs 18 列清单） | `src/server/services/databaseMigrationService.ts:598-601`（columns 数组） | 列清单位置，现 20 列，补 3 列后 23 列 |
| `databaseMigrationService.ts:292-316`（clearTargetData） | `src/server/services/databaseMigrationService.ts:292-316` | 路径相同，并入 `analytics_projection_checkpoints` |
| `databaseMigrationService.ts:250-273`（toBackupSnapshot） | `src/server/services/databaseMigrationService.ts:250-273` | 路径相同，三聚合表与 checkpoint 已不在快照中 |
| `databaseMigrationService.ts:773`（syncPostgresSequences sites setval） | `src/server/services/databaseMigrationService.ts:773` | 路径相同， GREATEST 公式已存在 |
| `schema.ts` proxy_logs 表起始 | `src/server/db/schema.ts:246` | `export const proxyLogs = sqliteTable('proxy_logs', {` |
| `schema.ts` proxy_logs 索引区 | `src/server/db/schema.ts:272-279`（现 8 个索引 + site_id_idx） | 新增 `siteIdIdx` 在 `:279` |
| `schemaParity.test.ts` proxy_logs 断言块 | `src/server/db/schemaParity.test.ts:85-115` | 扩展为 8 新列 + 1 索引 + bootstrap 连续断言 |
| `schemaMetadata.ts` boolean 启发式 | `src/server/db/schemaMetadata.ts:11-26` | `isBooleanLikeColumn` 增加 `prompt_tokens_include_cache` |

---

## 四、遗留项 / 范围外登记

| # | 遗留项 | 处置 |
|---|--------|------|
| 1 | upgrade SQL（mysql.upgrade.sql / postgres.upgrade.sql）当前为空（`-- no schema changes detected`） | **订正**：upgrade 产物现含本次增量（8 条 ADD COLUMN + `proxy_logs_site_id_idx` 索引）；其语义是「相对上一发布基准（HEAD）的滚动增量」，不得改成累计、不得允许为空；二次生成会自比差清空（生成器以盘上现有契约为 previous）。 |
| 2 | `is_stream` / `first_byte_latency_ms` / `client_*` 等既有缺列未补 | 登记（规范 §5.2 明确「不修」）。现码为旧 18 列 + 本次 8 列 = 26 列；与 `schema.ts` 的 32 列差 6 列：`is_stream`、`first_byte_latency_ms`、`client_family`、`client_app_id`、`client_app_name`、`client_confidence`——属 0016/0019 时期历史遗留，有意不在本切片修，只登记。 |
| 3 | drizzle-kit 在无数据库文件时可能生成快照式全量迁移（如本次误生 0032） | 登记。应对：确保 `data/hub.db` 存在且已应用所有迁移后再跑 `schema:generate` |
| 4 | proxy_logs 已有列 `prompt_tokens` / `completion_tokens` / `total_tokens` 在 schemaContract.json 中逻辑类型正确 | 已核：现有 contract 已正确反映 |
| 5 | `data/hub.db` 为开发辅助文件，已确保 .gitignore 排除 | 无需动作 |
| 6 | `0032_snapshot.json` 为 drizzle-kit 误生快照，已删除 | 清理完毕 |
| 7 | 迁移测试 fixture 因 0031 新增需调整过滤条件 | 已修（`migrate.test.ts:438` 过滤 0031） |

---

## 六、journal when 机制说明

drizzle sqlite migrator 使用 `created_at < ?` 的严格小于比较来判断迁移是否已应用。若两条迁移的 `when` 完全相同，已应用 0030（`created_at = 1790320000000`）的存量库在执行 0031（`when = 1790320000000`）时，条件 `1790320000000 < 1790320000000` 为 false，故 0031 的 SQL **静默跳过**，列不会被创建。

修复方法是将 0031 的 `when` 改为严格大于 0030 的值（如 `1790320000001`），确保 `<` 比较能正确识别 0031 尚未应用。

> 注：`+1ms` 是仓内已有先例（`migrate.test.ts` 里 `1772500000001` 的期望值）；取值 `1790320000001` 保持不动。

## 七、本切片不做

- 不改 `when` 值（本说明仅描述机制，不触发变更）；
- 不改 upgrade 为累计；
- 不补那 6 个旧缺口列（`is_stream`、`first_byte_latency_ms`、`client_family`、`client_app_id`、`client_app_name`、`client_confidence`）；
- 不把新列塞进 `legacySchemaCompat`；
- 不在本切片给 `clearTargetData` 加三聚合表 DELETE。

## 八、锚点校正说明（§15 映射）

| 规范锚点 | 实际位置 | 备注 |
|----------|---------|------|
| `schema.ts` proxy_logs 新增列 | `schema.ts:246-279` | 8 列插入在 `clientConfidence` 后、`createdAt` 前 |
| `schema.ts` site_id 索引 | `schema.ts:279` | `siteIdIdx: index('proxy_logs_site_id_idx').on(table.siteId, table.id)` |
| `databaseMigrationService.ts` proxy_logs 列清单 | `databaseMigrationService.ts:598-601` | columns 数组末尾补三列 |
| `databaseMigrationService.ts` clearTargetData | `databaseMigrationService.ts:292-316` | 新增 `analytics_projection_checkpoints` |
| `schemaParity.test.ts` proxy_logs 断言 | `schemaParity.test.ts:85-130` | 扩展为完整新列断言 |
| `schemaMetadata.ts` boolean 启发式 | `schemaMetadata.ts:11-26` | 增加 `prompt_tokens_include_cache` |
| `drizzle/meta/_journal.json` idx 31 | `drizzle/meta/_journal.json:233-239` | `0031_proxy_logs_usage_columns` |

---

*本笔记由 worker 角色于 2026-09-27 生成，仅记录本次切片 data 的实现结论。*
