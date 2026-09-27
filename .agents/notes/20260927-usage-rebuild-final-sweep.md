---
status: active
superseded_by: ""
supersedes: ""
模块: db
---

# 终检：登记项盘点 + 验收核对 + 全量回归

> 日期：2026-09-27
> 角色：worker（[MARK-TOKENUSAGE-FINALSWEEP-20260928]）
> HEAD：`e96ebe1f532568a14ea3a560e6d56fbc22a78784`
> 性质：只读终检，未改任何已提交文件

## 1. INDEX 刷新

`scripts/notes-index.sh` 执行成功：26 note(s) → `.agents/notes/INDEX.md`。
INDEX.md 在 `.gitignore:31`，`git status`（写本笔记前）仍干净（`## feat/usage-rebuild`，无 untracked/modified）。

## 2. 登记项汇总表

> 状态口径：已修 = 树内已兑现或已核实（含来源笔记明确不改码的登记）；观察 = 登记不改码；开放 = 待处理。

| # | 来源笔记 | 登记项 | 状态 | 落点 | 实况一致性 |
|---|---------|--------|------|------|-----------|
| G1 | slice11 | sqlite AUTOINCREMENT 语义守护 | **已修** | `src/server/db/sqliteAutoincrementSemantic.test.ts`（4 用例） | ✅ 文件存在，随 `npm test` 无条件执行（本次 3216/3216 含） |
| G4 | slice11 | repo:drift-check 无 schema 产物同步规则 | **观察** | `scripts/dev/repo-drift-check.ts`（仅 4 条规则，均不触 `generated/`） | ✅ 本次 drift-check 输出 0 条 schema 相关 violation，与登记一致 |
| G5 | slice11 | AUTO_INCREMENT/IDENTITY 推断硬编码 `columnName === 'id'` | **观察** | `schemaArtifactGenerator.ts:100`（MySQL）/`:124`（PG）/`:170-171`（sqlite） | ✅ 三处均为 `column.primaryKey && columnName === 'id'`；仓内全部自增主键列名为 `id`，当前无实害 |
| (a) | live-wiring | drizzle journal 缺 `0005_proxy_log_billing_details` → generate 误产 0032（已回滚） | **开放（既有漂移）** | `drizzle/meta/_journal.json`：idx 4 = `0004_sorting_preferences`，idx 5 = `0006_site_disabled_models`，**无 0005** | ✅ 确认缺失。0032 已回滚，当前 `schema:generate` 不应整跑 |
| (b) | live-wiring | upgrade SQL 与 schemaContract.json 漂移（9 条 proxy_logs 语句 vs 契约 8 列 delta） | **开放（既有漂移）** | `mysql.upgrade.sql`/`postgres.upgrade.sql`：8 ALTER + 1 CREATE INDEX = 9 条语句（live-wiring 笔记「9 条 proxy_logs ALTER」口径含 CREATE INDEX，以实际文件 8+1 为准）；`schemaContract.json` 含全部 8 列 | ✅ 确认漂移态保绿。`schema:contract` 重跑会归正 upgrade SQL 为空 → `schemaParity.test.ts` 反红，故不跑 |
| S6-1 | slice6 | batch `id<=0` 守卫仅登记（applyProjectionBatch lastRow.id 理论 >0） | **观察** | `usageAggregationService.ts` `applyProjectionBatch` 内 `normalizeNonNegativeInt` | ✅ 登记不改码，现状安全 |
| S6-2 | slice6 | live 测试为手动件不入 CI（`usageAggregationService.live.test.ts` gated） | **观察** | `package.json` `test:live:usage-aggregation`；ci.yml 挂 `schema-mysql`/`schema-postgres` job | ✅ 本地无 DB URL 时 skip；CI live 环境实跑 |
| S6-3 | slice6 | Mock 不模拟 WHERE 子句（A/B 仅断言错误类型） | **观察** | `usageAggregationService.mysql.test.ts` mock 层 | ✅ 登记不改码 |
| S6-4 | slice6 | 形状断言锁 `IS NULL OR` 双语义安全形（P2/P3 CAS） | **已修** | `usageAggregationService.mysql.test.ts` `P2 CAS shape` / `P3 CAS shape` 测试 | ✅ 随 `npm test` 无条件执行 |
| S10-1 | slice10 | self-log 恢复不含 reasoning → 列保持 NULL | **已修** | `sharedSurface.ts` 构造 `selfLogUsage` 时 `?? null` | ✅ 与 §1.4 规格一致 |
| S10-2 | slice10 | 数据库迁移列清单历史六列缺口不修 | **开放（既有，不修）** | `databaseMigrationService.ts` 列清单 vs schema `proxyLogs` | ✅ 登记不改码，明确不在本批范围 |
| S12-1 | slice12/13 | 「导出对象不含裸 id」三层守护（直测 + round-trip + Omit 类型） | **已修** | `backupService.test.ts` 4 条新增 + TS `Omit` | ✅ 本次 npm test 3216 全绿含此 |
| S12-2 | slice12/13 | checkpoint 无 FK 级联，导入显式 DELETE + 重建 | **已修** | `backupService.ts:2022-2038`（事务内） | ✅ 随 npm test 覆盖 |
| S12-3 | slice12/13 | encode/decode 未命中走 console.debug 不抛错 | **已修** | `backupService.ts:416-455` | ✅ 与 §9 规格一致 |
| S16-a | slice16 | `updatedAt` 语义锚点校正（检查点 :496，非 v17 误记 :434） | **已修** | `schema.ts:496` | ✅ 当前树确认 |
| S16-b | slice16 | backup 四 map 后写覆盖 vs siteIdByKey min-id 胜（不对称） | **观察** | `backupService.ts:471-485`（min）/`:503/:511/:517/:528`（LWW） | ✅ 与登记一致 |
| S16-c | slice16 | MySQL `affectedRows` 对象/数组分支归一化等值 | **已修（确认无功能疑点）** | `db/index.ts:1238-1243` / `:1255-1260` | ✅ 两分支 `Number(affectedRows \|\| 0)` 等值 |

**抽样核对证据**（本次终检实跑）：
- `schemaArtifactGenerator.ts:170-171`：`const autoincrement = emitPrimaryKey && dialect === 'sqlite' && column.primaryKey && columnName === 'id' ? ' AUTOINCREMENT' : '';` ✅
- `package.json:62-63`：`"test:live:usage-aggregation"` / `"test:live:site-sequences"` ✅
- `ci.yml:250-254`（mysql job +2 步骤）/ `:300-304`（postgres job +2 步骤）✅
- `sites.ts:661`：`if (Number.isNaN(id) || id <= 0) { return reply.code(400).send({ error: 'Invalid site id' }); }` ✅
- `sites.ts:818`：同上（DELETE handler）✅
- `usageAggregationService.ts:906`：`requestUsageAggregatesRecompute` MIN-merge CASE + INT32 钳位 ✅
- `usageAggregationService.ts:684/:749/:819`：三处 `classifyZeroRowAbort(leaseToken ?? '')` 调用 ✅
- `backupService.ts:416`：`function encodeIdentityKey(` 定义 ✅
- `drizzle/meta/_journal.json`：idx 4 → `0004_sorting_preferences`，idx 5 → `0006_site_disabled_models`（0005 缺失）✅

## 3. 验收核对

依据：`/tmp/plan-token-stats-v19.md` §16/验证命令 + `20260927-token-usage-spec-recovered.md` §10/§11

| 切片 | 验收条件 | 结论 | 证据 |
|------|---------|------|------|
| 6 | P1/P2/P3 守卫 UPDATE 0 行 → A/B 分类 → 事务内抛错回滚 | **已交付** | `classifyZeroRowAbort` def :249，调用 :684/:749/:819；`npm test` 3216 绿含 A/B 用例 |
| 6 | P4 单条 MIN-merge，行缺失 → no-op | **已交付** | `requestUsageAggregatesRecompute` :906，CASE 结构完整，无 INSERT 路径 |
| 6 | 调度器/warm `.catch(handleUsageProjectionPassFailure)`；A/B warn、其它 error、不退出 | **已交付** | `handleUsageProjectionPassFailure` :931 起；`adminSnapshotWarmService.ts` `.catch` 已挂 |
| 6 | lastError 仅 release 命中时写入 | **已交付** | P1/P2/P3 A/B 路径 release WHERE 必 0 行 |
| 8 | backupService 注释 + reconciliation + 门禁 | **已交付** | 不在本批新增文件范围；backupService.test.ts 20/20 随全量绿 |
| 10 | parser 不用 firstPositiveInt；缺失 NULL / 显式 0 写 0 | **已交付** | `proxyUsageNormalize.ts` + `proxyUsageNormalize.test.ts`（12 测试）存在且随 npm test 绿 |
| 10 | resolveFinalUsage 是唯一归一入口；六写入点全消费 | **已交付** | 六锚点对照表（slice10 笔记）全部实存；本次 npm test 绿 |
| 10 | images/search zeros=true → 显式 0，usageSource 不因此变 unknown | **已交付** | slice10 笔记锚点 images.ts:479 / search.ts:234 |
| 11 | schema 契约 / 产物 / upgrade SQL 三件套同步 | **已交付（漂移态保绿）** | `test:schema:unit` 20/20 绿；(b) 漂移态有意保持 |
| 11 | AUTOINCREMENT 语义正确 | **已交付** | `sqliteAutoincrementSemantic.test.ts` 4/4 绿 |
| 12 | 列清单含三站点向列 | **已交付** | `databaseMigrationService.ts:605` 26 列含三列 |
| 12 | clearTargetData 含 checkpoint | **已交付** | `databaseMigrationService.ts:316` 含 `analytics_projection_checkpoints` |
| 12 | toBackupSnapshot 不运聚合表与 checkpoint | **已交付** | `databaseMigrationService.ts:255-287` 固定表清单不含四表 |
| 12/14 | 三方言 setval 夹具 | **sqlite 已交付 / mysql+pg gated** | `databaseMigrationService.sequences.live.test.ts` sqlite 3/3 绿；mysql/pg 需 CI 环境（`DB_PARITY_*_URL`） |
| 13 | 导入事务内 DELETE checkpoint + 哨兵 + min-id 胜 | **已交付** | `backupService.ts:2022-2038`；min-id 逻辑 :471-485；roundtrip 测试含 |
| 13 | 导出对象不含裸 id；七键全查 | **已交付** | `Omit` 类型 + 直测断言 + roundtrip 测试 |
| 14 | 空表 / 仅哨兵 / 仅 id=0 三情形 → 新站点 id ≥ 1 | **sqlite 已交付 / mysql+pg gated** | 9 用例文件存在；sqlite 3 通过；mysql/pg 6 skip（无 URL） |
| 15 | 四写点列集合 + CAS + void + setval + lastError + batch 哨兵守卫 | **已交付** | P1/P2/P3 CAS 列白名单；P4 MIN-merge；`.catch` 收口；setval GREATEST 公式 |
| 16 | PUT/DELETE `id<=0` → 400，不查库不写 | **已交付** | `sites.ts:661`（PUT）/ `:818`（DELETE）；`sites.idGuard.test.ts` 6 例绿 |
| 16 | batch 含 0/负 → 整包 400 `'Invalid ids. Expected number[].'` | **已交付** | `sites.batch.test.ts` 3 例参数化（`[0]`/`[-1]`/`[1,-2]`）绿 |
| §10.1 | live-gated 开关（`DB_PARITY_*_URL` 缺省 skip） | **已交付** | `usageAggregationService.live.test.ts` 2/2 skip（无 URL）；sequences 6/6 skip |
| §10.2 | CI 渠道：schema-mysql / schema-postgres job 挂 live 步骤 | **已交付** | `ci.yml:250-254` / `:300-304` 各 +2 步骤 |
| §10.3 | 三方言 setval 完成条件 | **sqlite 已交付 / mysql+pg 待 CI** | 本地无目标库凭据，`it.skip` ≠ 通过；完成判定以 CI live 环境为准 |

**不在本批**：
- 哨兵常量文件（spec §12 缺口 7：文件名待实现切片定）
- `requestUsageAggregatesRecompute` 生产调用方接线（spec §12 缺口 9：无生产调用方）
- platform 无白名单根治（spec §12 缺口 8：登记为已知风险，不根治）
- 删除路径不触发聚合重建（§16.5 登记，不修）
- 迁移既有缺列六列（§16.5 登记，不修）

## 4. 全量回归（终态 HEAD `e96ebe1`）

| 门禁 | 结果 | 计数原文 |
|------|------|---------|
| `npm run typecheck:server` | ✅ PASS | `tsc --noEmit -p tsconfig.server.json` → 0 错误（无输出） |
| `npm run test:schema:unit` | ✅ PASS | 4 files / **20 passed** / 480ms |
| `npm run repo:drift-check` | ✅ PASS | **Violations: 0**；Tracked debt: 5（4 proxy-core-routes-proxy-import + 1 web-page-to-page-import，均既有） |
| 2 live 文件（sqlite 实跑） | ✅ PASS | `databaseMigrationService.sequences.live.test.ts` 9 tests（3 passed / 6 skipped）；`usageAggregationService.live.test.ts` 2 tests（2 skipped）；合计 3 passed / 8 skipped / 1.25s |
| `npm test`（全量） | ✅ PASS | **501 passed / 2 skipped (503) files**；**3216 passed / 16 skipped (3232) tests**；49.48s |

## 5. 未决与建议（不越权处置）

| # | 项 | 风险面 | 建议 |
|---|---|--------|------|
| 1 | journal 缺 0005（(a)） | 未来 `drizzle-kit generate` 整跑会误产 0032 | 修复前避免整跑 `schema:generate`；如需修复需同时更新 journal + 确认无 0032 产物 |
| 2 | upgrade SQL 漂移态（(b)） | `schema:contract` 重跑会抹掉 upgrade SQL → `schemaParity.test.ts` 反红 | 与 (a) 联动修复；修复前不单独跑 `schema:contract` |
| 3 | mysql/pg live 序列矩阵（§10.3） | 本地无凭据，6 skip ≠ 通过 | 以 CI `schema-mysql` / `schema-postgres` job 为准 |
| 4 | P4 无生产调用方 | 未来接入 API/UI 需先 ensure 或显式接受 no-op 丢弃语义 | 接入前读 §16.4 第 4 条登记 |
| 5 | G5 `columnName === 'id'` 硬编码 | 未来若出现自增主键列名 ≠ `id` 的表，bootstrap/upgrade SQL 会降级 | 当前无实害；出现时修三处（MySQL:100 / PG:124 / sqlite:170） |

## 6. 未 commit 声明

本次终检仅运行只读命令 + 测试 + `scripts/notes-index.sh` + 写本笔记；**未 commit、未 push、未部署、未改任何已提交文件**。工作区除本笔记（untracked）外无其它改动。`git status --porcelain` 原文：

```
?? .agents/notes/20260927-usage-rebuild-final-sweep.md
```
