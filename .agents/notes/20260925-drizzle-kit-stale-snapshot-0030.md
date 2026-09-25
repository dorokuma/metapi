---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: db
---

# drizzle-kit 快照陈旧（最后 snapshot 0028、journal 已含 0029）：db:generate 会产重复迁移

## 一句话结论

仓库 `drizzle/meta/` 的快照序列断档：最后一个 `*_snapshot.json` 是 `0028`，但
`_journal.json` 已经登记了 `0029_notification_templates`（以及本次新增的 `0030`）。
此时 `npm run db:generate`（drizzle-kit generate）会以 0028 快照为基线重复生成 0029/0030
已有的结构，产出**重复迁移**；正确做法是 SQLite 迁移 SQL 手写、产物只跑
`npm run schema:contract`，绝不跑 `db:generate`。

## 背景

「Cline 上游探测」阶段 2 需要新表 `upstream_provider_observations`。按常规流程本应
`npm run db:generate` 让 drizzle-kit 产出 `drizzle/0030_*.sql` + 新快照，但实际检查发现：

- `drizzle/meta/` 里最新快照为 `0028_snapshot.json`，没有 0029 的快照；
- `drizzle/meta/_journal.json` 已经包含 `0029_notification_templates` 与本次的
  `0030_upstream_provider_observations`。

drizzle-kit 从 snapshots 推导 diff，基线停在 0028，会把 0029/0030 已经手写的表（如
`notification_templates`）当作「新增」再次生成，产生重复序号/重复 DDL，且 journal 会被
再次改写。仓库的 SQLite 迁移本来就是手写 + 由迁移 SQL 构建契约
（`buildSchemaContractFromSqliteMigrations`），meta 快照不是唯一事实源。

## 决策

1. **手写 `drizzle/0030_upstream_provider_observations.sql`**：CREATE TABLE + 5 个索引，
   保留 `--> statement-breakpoint` 分隔；`created_at` 按修订单为 `text NOT NULL DEFAULT (datetime('now'))`。
2. **产物只跑 `npm run schema:contract`**：该脚本从 SQLite 迁移 SQL 重建契约，
   再生成 MySQL/Postgres bootstrap/upgrade 与 `schemaContract.json`；不调用 drizzle-kit。
3. **previous 契约必须是「上一个已发布契约」**（即 git HEAD 版本，而不是工作树里刚改过的版本）：
   `generateSchemaContract` 在读契约前先用 HEAD 版本临时覆盖
   `src/server/db/generated/schemaContract.json`，否则：
   - 若 previous 已含新表而本次只是改列（如 created_at 改 NOT NULL），
     `assertAdditiveSchemaDiff` 会直接抛 `Non-additive schema diff detected`，
     且 upgrade 产物会退化成 `-- no schema changes detected`，真实升级路径丢失。
4. 三处同步（Drizzle `schema.ts`、SQLite 0030 SQL、schema:contract 产物）由
   `test:schema:unit` / `test:schema:parity` / `test:schema:upgrade` 与 `repo:drift-check` 兜底。

## 被放弃的方案（必填）

- **跑 `npm run schema:generate`（db:generate + schema:contract）**：因 0028 快照断档会重复
  生成 0029/0030 的结构，污染迁移历史；已废弃。
- **补一份 `0029_snapshot.json` 对齐快照再 generate**：需要手工回填 drizzle-kit 内部快照格式，
  极易与真实迁移 SQL 漂移，且仓库既有流程不依赖快照；不取。
- **把 `created_at` 的 NOT NULL 只写进 Drizzle schema 不写迁移 SQL**：迁移才是 SQLite 的
  事实源（契约由迁移构建），产物与升级测试会立刻不一致；不取。

## 来源

- `drizzle/meta/_journal.json`（含 0029/0030）、`drizzle/meta/0028_snapshot.json`（最后一个快照）；
- `scripts/dev/generate-schema-contract.ts`、`src/server/db/schemaContract.ts`、
  `src/server/db/schemaArtifactGenerator.ts`（`assertAdditiveSchemaDiff`）；
- 通知模板整改笔记里的同一注意事项（decision 7）；
- 「Cline 上游探测」返工任务踩坑记录（2026-09-25）。
