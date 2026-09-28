---
status: active
superseded_by: ""
supersedes: "20260925-drizzle-kit-stale-snapshot-0030.md"
模块: db
---

# journal 0005 补录 + upgrade SQL 归正 + drizzle-kit 误产隐患消除

## 一句话结论

drizzle journal 缺 0005 与 upgrade SQL 漂移态已联动修复；快照链头刷新到
0033（含 0029/0030/0031 全部对象）使 `drizzle-kit generate` 不再误产；
upgrade SQL 归正为空步，`schemaParity.test.ts` 改为断言空步标记。

## 背景

usage-rebuild 终检（20260927-usage-rebuild-final-sweep §5）列出两条既有漂移并
设操作禁令：

- **(a)** `drizzle/meta/_journal.json` 缺 `0005_proxy_log_billing_details`：
  idx 4（0004）直接跳 idx 5（0006）。0005 迁移 SQL 文件存在但 journal 未登记，
  导致 `drizzle-kit generate` 以 0028 快照为基线误产 0032（重复 0029/0030/0031 对象）。
- **(b)** `mysql.upgrade.sql` / `postgres.upgrade.sql` 锁定 8 ADD COLUMN + 1 index
  的旧漂移态，而 `schemaContract.json` 已含全部 8 列。重跑 `schema:contract`
  会归正 upgrade 为空步 → `schemaParity.test.ts` 反红。

操作禁令：修复前不整跑 `schema:generate`、不单独跑 `schema:contract`。

## 决策

### 步骤 1：journal 插入 0005

- 在 idx 4（0004_sorting_preferences）后插入 `{idx:5, tag:"0005_proxy_log_billing_details",
  when:1772900000000, version:"6", breakpoints:true}`。
- when 值 1772900000000 严格落在 0004（1772320800000）与 0006（1773500331000）之间。
- 后续条目 idx 顺移 +1（原 idx 5–31 → 6–32）。
- 不动任何 `.sql`、不新增快照。

### 步骤 2：快照链头刷新（消除 generate 误产）

- 跑 `npx drizzle-kit generate --name probe_snapshot_refresh` → 产出
  `0033_probe_snapshot_refresh.sql`（含 0029/0030/0031 对象）+ `0033_snapshot.json`。
- **删除** `0033_probe_snapshot_refresh.sql`（绝不保留/提交），**保留**
  `0033_snapshot.json` 作新链头。
- 移除 journal 中 drizzle-kit 自动追加的 0033 条目。
- 二次 `npx drizzle-kit generate` 验证：输出 "No schema changes, nothing to migrate"，
  无新文件产生。

### 步骤 3：upgrade SQL 归正

- 跑 `npm run schema:contract`（仅 contract，不含 db:generate）。
- 结果：`mysql.upgrade.sql` / `postgres.upgrade.sql` 归正为
  `-- no schema changes detected for {mysql|postgres}`（generator 空步分支）。
- `schemaContract.json` 零变更（盘上契约已是最新态）。

### 步骤 4：schemaParity.test.ts 改写

- 原 "keeps upgrade artifacts reflecting the current slice delta against the previous
  contract" 断言锁定 8 ADD COLUMN + 1 index → 改为
  "keeps upgrade artifacts in the normalized empty-step state"：
  - 断言两份 upgrade.sql 含空步标记 `-- no schema changes detected for {dialect}`
    （标记字符串取自 `schemaArtifactGenerator.ts` 空步分支源码）。
  - 断言不含 `ADD COLUMN`（防回潮）。
  - 保留 `not.toContain('upstream_provider_observations')` 守护。
- "keeps generated schema artifacts present"（:24-36）保留不动；空步标记非空，
  `trim().length > 0` 仍满足。

## 存量库安全论证

| 场景 | 行为 |
|------|------|
| 全新库（无 `__drizzle_migrations`） | 按 journal idx 0→32 顺序应用；0005 单语句 ALTER 干净插入 |
| 已有库（migrations 已含 0000–0004，缺 0005 记录） | `backfillMissingRecordedMigrations` replay 0005 →
  duplicate column → `findMatchingMigrationByStatement` 单语句精确匹配 → 标记完成，不崩 |
| 已有库（0005 已手动应用过） | 同上 recovery 路径；后续条目 hash 对得上 → skip |

0005 与 0031 零重叠：0005 仅 `ALTER TABLE proxy_logs ADD billing_details text;`，
0031 添加 8 列 + 1 索引（cache_read_tokens 等），`proxy_logs` 建于 0000，
位置 idx 5 可干净应用。

## 被放弃的方案（必填）

- **补写 0005 快照 JSON 手动对齐链头**：快照为 drizzle-kit 内部格式（含
  `version`/`dialect`/`tables` 完整状态），手写极易漂移；用 probe generate
  让工具自产更可靠。
- **保留 0033 probe 迁移 SQL 作正式迁移**：内容是重复 0029/0030/0031 对象，
  对已应用这些迁移的库重跑会报 duplicate；无意义。
- **保留 upgrade.sql 漂移态 + 测试锁旧态**：漂移态是错误终态，归正后测试应
  守护正确终态（空步）；锁旧态会让未来 `schema:contract` 重跑永远反红。

## 闭环声明

本笔记解除 20260927-usage-rebuild-final-sweep §5 第 1/2 条操作禁令：

1. ~~修复前避免整跑 `schema:generate`~~ → journal 已含 0005 + 快照链头已刷新，
   `drizzle-kit generate` 不再误产，整跑安全。
2. ~~与 (a) 联动修复；修复前不单独跑 `schema:contract`~~ → upgrade SQL 已归正，
   测试已改，单独重跑 `schema:contract` 安全。

## 来源

- `drizzle/meta/_journal.json`（本次 diff：+0005 条目，idx 顺移）；
- `drizzle/meta/0033_snapshot.json`（新链头，118116 bytes）；
- `drizzle/meta/0028_snapshot.json`（旧链头，105507 bytes）；
- `src/server/db/schemaArtifactGenerator.ts`（空步分支：`-- no schema changes detected for ${dialect}`）；
- `scripts/dev/generate-schema-contract.ts`（previous 契约 = 盘上 schemaContract.json）；
- `src/server/db/migrate.ts`（`backfillMissingRecordedMigrations` + `findMatchingMigrationByStatement`）；
- 终检笔记：`.agents/notes/20260927-usage-rebuild-final-sweep.md` §5 表格行 1/2。
