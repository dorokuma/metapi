---
status: active
superseded_by: ""
supersedes: ""
模块: server
---

# 切片 12+13 备份站点键接线与导入归因

> 日期：2026-09-27
> 切片：切片 12（迁移面 databaseMigrationService）+ 切片 13（导入归因 backupService）
> 目标：proxy_logs 三站点向列（site_id / model_site_id / credential_site_id）的备份导入导出接线——导出七键三态编码 + 裸 id 解构剔除、导入三态解码 + min-id 胜、checkpoint 导入重置；迁移面三列拷贝 + clearTargetData 并入 checkpoint + toBackupSnapshot 不运聚合。

## 一句话结论

backupService 侧七键（accountKey/routeKey/channelKey/downstreamApiKeyKey/siteKey/modelSiteKey/credentialSiteKey）三态编码/解码已落地，裸 id 经解构剔除不进快照，siteIdByKey 最小 id 胜，导入 commit 前 checkpoint 重置为零水位；databaseMigrationService 侧三列拷贝、clearTargetData 含 checkpoint、toBackupSnapshot 不运聚合均已满足。

## 已具备 vs 新增

### 已具备（基线，本切片未改）

| 项 | 文件:行号 | 说明 |
|---|---|---|
| `clearTargetData` 表清单含 `analytics_projection_checkpoints` | databaseMigrationService.ts:316 | 19 表清单，未另起 DELETE |
| `toBackupSnapshot` 固定表清单不含三聚合表与 checkpoint | databaseMigrationService.ts:255-287 | 基线即满足「不拷贝」，本切片未改 |
| proxy_logs 硬编码列清单 26 列（含三站点向列） | databaseMigrationService.ts:605 | 含 site_id / model_site_id / credential_site_id，本切片未回退 |
| `USAGE_PROJECTION_CHECKPOINT_KEY` 常量 | backupService.ts:16 | `'usage-aggregates-v1'`，基线已有 |

### 本切片新增

| 项 | 文件:行号 | 说明 |
|---|---|---|
| `EncodedIdentityKey` 类型 | backupService.ts:175 | `string \| -1 \| null`，三态编码值域 |
| `ProxyLogSnapshot` 七键 + Omit 裸 id | backupService.ts:181-197 | Omit 剔除七个裸 id，增七键字段 |
| `CheckinLogSnapshot` 单键 + Omit 裸 id | backupService.ts:199-201 | Omit 剔除裸 accountId，增 accountKey |
| `encodeIdentityKey` 三态编码 | backupService.ts:416-434 | -1→-1，null→null，正 id→键（未命中 null+debug），其它非正→null+debug |
| `decodeIdentityKey` 三态解码 | backupService.ts:442-455 | -1→-1，==null→null（含旧备份无字段），其它→idByKey 查得（未命中 null+debug） |
| `buildRuntimeIdentityIndexesFromSection` min-id 胜 | backupService.ts:457-487 | 跳过 id<=0（比较前），比较已存 id 与当前 id 保留较小者，同键 debug |
| sites 查询 `ORDER BY id` | backupService.ts:559 | collectCurrentRuntimeStateSnapshot 内，让「先见到的行」可复现 |
| 导出 siteKeyById 跳过非正 id | backupService.ts:575-576 | 与导入侧策略一致 |
| proxyLogs 导出 map 解构剔裸 id + 七键编码 | backupService.ts:680-702 | 解构剔除七裸 id，七键逐一 encodeIdentityKey |
| checkinLogs 导出 map 解构剔裸 id + 单键编码 | backupService.ts:704-710 | 解构剔除裸 accountId，encodeIdentityKey |
| `TokenModelAvailabilitySnapshot` 三态 | backupService.ts:211-213 | `Omit<TokenModelAvailabilityRow, 'tokenId'> & { tokenKey: EncodedIdentityKey }` |
| tokenAvailability 导出 map 解构剔裸 id + 三态编码 | backupService.ts:674-681 | 解构剔除裸 tokenId，encodeIdentityKey（同七键机制） |
| tokenAvailability 导入三态解码 + 守卫 | backupService.ts:1899-1911 | decodeIdentityKey + `typeof tokenId !== 'number' \|\| tokenId <= 0` 跳过，保持原跳过语义 |
| 导入回插七键解码 | backupService.ts:1969-1981 | proxyLogs 回插：七键经 decodeIdentityKey 反查 |
| checkpoint 导入重置 | backupService.ts:2022-2038 | 事务内 DELETE usage-aggregates-v1 + 重建 lastProxyLogId=0，commit 前 |

## §5 迁移面核实结论（带行号证据）

| 核实项 | 结论 | 证据 |
|---|---|---|
| `clearTargetData` 含 checkpoint | **已含**，未另起 DELETE | databaseMigrationService.ts:297-321，表清单 :316 含 `'analytics_projection_checkpoints'` |
| `toBackupSnapshot` 不运三聚合表与 checkpoint | **本就满足**（基线即固定表清单，不含四表） | databaseMigrationService.ts:255-287，select 清单无 site_day_usage / site_hour_usage / model_day_usage / analytics_projection_checkpoints |
| proxy_logs 列清单 26 列 | **本切片未回退**，含三站点向列 | databaseMigrationService.ts:605，列清单含 site_id / model_site_id / credential_site_id |

## 旧→新锚点对照

材料旧行号以方案 v15（plan-token-stats-v19.md）为基准，当前树行号以本切片改动后为准。

| 符号 | 材料旧锚点 | 当前树 符号:行号 |
|---|---|---|
| `encodeIdentityKey` | 无（新增） | backupService.ts:416 |
| `decodeIdentityKey` | 无（新增） | backupService.ts:442 |
| `collectCurrentRuntimeStateSnapshot` | `:545`（未变） | backupService.ts:545 |
| sites 查询 `ORDER BY id` | `:480` 一带（材料标注） | backupService.ts:559 |
| 导出 `siteKeyById` 跳过非正 id | `:487-490`（材料标注） | backupService.ts:575-576 |
| 导出 map 七键/三态 | `:586-592`（材料标注四键） | backupService.ts:680-702（七键） |
| `buildRuntimeIdentityIndexesFromSection` | `:388` 起（材料标注） | backupService.ts:457 |
| `siteIdByKey` min-id 胜 set | `:401-402`（材料标注后写覆盖） | backupService.ts:471-485（跳过 id<=0 + min 比较） |
| `importAccountsSection` | `:1573`（材料标注） | backupService.ts:1688 |
| 导入回插 proxyLogs 七键 | `:1860-1884`（材料标注） | backupService.ts:1969-1981 |
| checkpoint 重置段 | 无（新增） | backupService.ts:2022-2038 |
| `USAGE_PROJECTION_CHECKPOINT_KEY` | 无（新增引用） | backupService.ts:16 |

## 登记项

1. **「导出对象不含任一裸 id」三层守护**：① 直测（`__collectCurrentRuntimeStateSnapshotForTests` 快照断言）——对 `proxyLogs[0]` / `checkinLogs[0]` / `siteAnnouncements[0]` / `nonManualAvailability[0]` / `tokenAvailability[0]` 逐一断言裸 id 缺席 + 键在场；② round-trip 测试（导出→导入→验证回插 id）；③ TS `Omit` 类型约束（编译期保证快照类型不含裸 id 字段）。
2. **checkpoint 无 FK 级联**：`analytics_projection_checkpoints` 表无 FK 到 sites。导入事务内显式 DELETE + 重建（lastProxyLogId=0），不依赖 FK 级联。
3. **encode/decode 未命中走 `console.debug`**：与 §9 一致。`encodeIdentityKey` 未命中（正 id 无键/站点已删）和 `decodeIdentityKey` 未命中（键在 idByKey 中不存在）均打 `console.debug`，不抛错。

## 门禁结果

| 检查 | 结果 |
|---|---|
| backupService.test.ts | **20/20 绿**（含 4 条新增：min-id win / roundtrip sentinel / checkpoint reset / forTests 裸 id 直测） |
| databaseMigrationService.test.ts | **28/28 绿**（无回归） |
| 合计 | **48/48** |
| `tsc -p tsconfig.server.json --noEmit` | 通过 |
| `build:web` + `build:server` | 通过 |

## 来源

- 方案：`/tmp/plan-token-stats-v19.md` §3 / §9 / §11.5 / §11.6 / F10 / F12
- 规格：`.agents/notes/20260927-token-usage-spec-recovered.md` §9.1-§9.4 / §11.5 / §11.6
- 切片 6 笔记：`.agents/notes/20260927-slice6-checkpoint-guard.md`
- 切片 data 笔记：`.agents/notes/20260927-slice-data-token-usage.md`
