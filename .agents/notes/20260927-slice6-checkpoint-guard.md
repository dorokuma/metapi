# Slice 6 投影检查点守护修复笔记

> 日期：2026-09-27
> 切片：投影检查点守护（Slice 6）
> 目标：P1/P2/P3 写入加 leaseToken 守护、P4 改单条 MIN-merge UPDATE、A/B 错误分类、lastError 口径统一。

## 改动概览

1. **usageAggregationService.ts**：
   - 新增 `ProjectionCheckpointResetError`（code=`checkpoint_reset`）和 `ProjectionLeaseLostError`（code=`lease_lost`）。
   - 新增 `readProjectionCheckpointRow()`（行缺失返回 `undefined`）；`readProjectionCheckpoint()` 改为委托它。
   - 新增 `classifyZeroRowAbort(leaseToken)`：守护 UPDATE 0 行时裸读 checkpoint → 行缺失 = A（reset），token 不匹配 = B（lost）。
   - 新增 `handleUsageProjectionPassFailure(error)`：A/B 只 warn，意外错误才 error。
   - P1 `applyProjectionBatch`：checkpoint UPDATE 加 `eq(leaseToken)` 守护；0 行 → `classifyZeroRowAbort`。
   - P2 `applyPendingRecompute`（missing-row）：裸 UPDATE 改带 `eq(leaseToken)` 守护；0 行 → `classifyZeroRowAbort`。
   - P3 `applyPendingRecompute`（restart）：checkpoint UPDATE 加 `eq(leaseToken)` + `recomputeFromId` CAS 条件；0 行 → `classifyZeroRowAbort`。
   - P4 `requestUsageAggregatesRecompute`：upsert 改单条 MIN-merge UPDATE（行缺失 = no-op，消灭 check-then-act 窗口）。
   - 三处 `leaseToken` 在事务前断言非空（`if (!leaseToken) throw`），窄化 `string | null` → `string` 以过 `eq()` 重载。

2. **adminSnapshotWarmService.ts**：`startAdminSnapshotWarmScheduler` 中 `warmAdminSnapshotsOnce()` 已挂 `.catch(handleUsageProjectionPassFailure)`，A/B 错误不会 unhandled rejection。

3. **databaseMigrationService.ts**：GREATEST setval 公式更新（配合 P4 MIN-merge 语义）。

## 旧→新锚点对照表

| 写入点 | 旧锚点（改动前特征） | 新锚点（reviewer 核对值） |
|-------|-------------------|------------------------|
| `writeProjectionCheckpoint`（upsert） | 独立函数，被 P1/P2/P3 三处调用 | **已删除**；行 343 留注释 `// writeProjectionCheckpoint (upsert) removed` |
| P1 `applyProjectionBatch` | 调用 `writeProjectionCheckpoint`（upsert） | 行 635 定义；行 649 `if (!leaseToken) throw`；行 684 `classifyZeroRowAbort(leaseToken ?? '')`；WHERE 含 `eq(leaseToken)` |
| P2 missing-row `applyPendingRecompute` | 裸 `db.update`（无守护） | 行 701 定义；行 719 `if (!leaseToken) throw`；行 749 `classifyZeroRowAbort(leaseToken ?? '')`；WHERE 含 `eq(leaseToken)` |
| P3 restart `applyPendingRecompute` | 调用 `writeProjectionCheckpoint`（upsert） | 行 773 `if (!leaseToken) throw`；行 819 `classifyZeroRowAbort(leaseToken ?? '')`；WHERE 含 `eq(leaseToken)` + `recomputeFromId` CAS |
| P4 `requestUsageAggregatesRecompute` | `upsert`（`onConflictDoUpdate`） | 行 906 定义；单条 `db.update` + `CASE WHEN` MIN-merge；行缺失 = 0 行 = no-op |

## A/B 分类与 lastError 口径

- **A（checkpoint_reset）**：守护 UPDATE 0 行 → 裸读 checkpoint 行缺失 → `throw ProjectionCheckpointResetError`。release 也 0 行（行已删）→ lastError 不写。
- **B（lease_lost）**：守护 UPDATE 0 行 → 裸读 checkpoint 行存在但 token 不匹配 → `throw ProjectionLeaseLostError`。release 也 0 行（token 不匹配）→ lastError 不写。
- **意外错误**：非 A/B 的异常 → `handleUsageProjectionPassFailure` 打 `console.error`；release 可能 1 行（token 仍匹配）→ lastError 写入。
- **`handleUsageProjectionPassFailure` 不 rethrow**：A/B 打 `console.warn` 后 return；意外错误打 `console.error` 后 return。调度层 `void ... .catch(handleUsageProjectionPassFailure)` 吞掉错误，下一轮 tick 继续。

## setval GREATEST 公式

P4 `requestUsageAggregatesRecompute` 的 `recomputeFromId` 用 `CASE WHEN` 实现 MIN-merge：

```sql
CASE
  WHEN recompute_from_id IS NULL OR recompute_from_id <= 0 THEN ${normalizedFromId}
  WHEN recompute_from_id <= ${normalizedFromId} THEN recompute_from_id
  ELSE ${normalizedFromId}
END
```

语义：新请求 id ≤ 当前水位 → 保持当前（已覆盖更旧区间）；新请求 id > 当前水位 → 取新值（需重算更宽区间）。行缺失时 UPDATE 0 行 = no-op，不创建行。

## 登记项

- **batch id<=0 守卫仅登记**：`applyProjectionBatch` 中 `lastRow.id` 理论上 > 0（来自 `proxyLogs.id`），但 `normalizeNonNegativeInt` 兜底后若为 0 会导致 `nextLastProxyLogId = 0`。当前不做额外守卫，登记备查。
- **live 测试为手动件不入 CI**：`usageAggregationService.live.test.ts` 系 `DB_PARITY_*` gated 的手动集成测试，不在 `npm test` 范围内，不覆盖 CASE 评估。
- **Mock 不模拟 WHERE 子句**：MySQL mock 的 `makeUpdateChain` 不检查 WHERE 条件，A/B 测试仅断言错误类型，不断言最终 checkpoint 状态。
- **形状断言锁 `IS NULL OR` 双语义安全形**：P2/P3 的 `recomputeRequestedAt` CASE 含 `IS NULL OR` 分支。删掉该分支会静默复现旧 F1（`recompute_from_id` 为 NULL 时 `recompute_requested_at` 不被清除）。三分盲区：SQLite 用例读的是旧值、MySQL mock 不评估 CASE、live 测试为手动件不评估——三者都测不出。形状断言（`usageAggregationService.mysql.test.ts` 的 `P2 CAS shape` / `P3 CAS shape` 测试）在 mock `.set()` 处捕获 SQL 模板对象，对 `recomputeRequestedAt` 的 SQL 文本断言含 `IS NULL`（及 `OR`），非 gated，默认套件即跑。变异验证已确认：删 `IS NULL OR` → 断言必红。
- **「镜像 SQL / 列序与生产脱钩」在重建树不存在**：live 清理走 drizzle 调用，无手写镜像 SQL，不存在脱钩风险。

## 门禁结果

| 门禁 | 结论 | 备注 |
|-----|------|------|
| `npm run typecheck:server` | ✅ PASS | 0 错误 |
| `npm run repo:drift-check` | ✅ PASS | Violations: 0（Tracked debt 5 条，均为既有） |
| `usageAggregationService.test.ts` | ✅ PASS | 7 测试 |
| `usageAggregationService.mysql.test.ts` | ✅ PASS | 6 测试（含 P2/P3 形状断言） |
| `databaseMigrationService.test.ts` | ✅ PASS | 28 测试 |

## 未 commit

本次改动未执行 `git commit` / `git push` / 部署，仅在工作区盘上修改并验证。
