---
status: active
superseded_by: ""
supersedes: ""
模块: server
---

# 切片 16 站点单条 id 守卫 + batch 语义验证 + 锚点事实登记

> 日期：2026-09-27
> 切片：切片 16（站点单条守卫 T7 收紧 + batch 语义验证 + 锚点事实登记）
> 目标：单条 `PUT/DELETE /api/sites/:id` 对 `id<=0`（含 NaN）返回 400 `'Invalid site id'`，先于 select/写；batch 含 0/负 id 维持契约层整包 400 `'Invalid ids. Expected number[].'`；公共契约不改、batch 循环不加守卫、相邻路由不碰。另登记三组锚点事实（不改码，只核实）。

## 一句话结论

`sites.ts` 单条 PUT（:661）与 DELETE（:818，补 `reply` 参数）守卫收紧为 `Number.isNaN(id) || id <= 0` → 400；batch 语义由契约 `positive()` 保证整包 400，测试锁死「整包 400、无 failedItems/successIds、正 id 站点不被误删」；三组锚点事实均按当前树行号核实登记，未改任何产品代码语义。

## 改动文件与落点（文件:行号）

| 文件 | 改动 | 行号 |
|---|---|---|
| `src/server/routes/api/sites.ts` | PUT 守卫 `Number.isNaN(id)` → `Number.isNaN(id) \|\| id <= 0` | handler :659，守卫 :661 |
| `src/server/routes/api/sites.ts` | DELETE 补 `reply` 参数 + 新增同名守卫（先于 `db.delete`） | handler :816，守卫 :818 |
| `src/server/routes/api/sites.idGuard.test.ts` | **新增**单条守卫测试（6 例） | 新文件 |
| `src/server/routes/api/sites.batch.test.ts` | **新增** batch 0/负 id 整包 400 语义（3 例，循环参数化） | 追加于既有用例后 |

## 行为不变映射

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| PUT `id` NaN → 400 `'Invalid site id'` | 400（`isNaN`） | 不变，仍 400（`isNaN \|\| <=0`） |
| PUT `id<=0` 非 NaN（0 / -1） | 进 `select` → 无行 404（有行则更新） | **400**，不查库、不写（先于 :666 select） |
| PUT `id>0` 不存在 → 404；存在 → 更新 | 同上 | 不变（守卫之后仍走既有 select/404/更新） |
| DELETE 任意 parse 结果直接 delete | 无校验，直接 `db.delete` | `id` NaN 或 `<=0` → 400；`id>0` 仍 delete + `invalidateSiteCaches` + `{ success: true }` |
| DELETE `id>0` 无行 | `{ success: true }`（不改成 404） | 不变（现语义保留） |
| batch `ids` 含 0/负 | zod 整包 400 `'Invalid ids. Expected number[].'`（`failedItems` 收不到非正 id） | 不变（契约层，不到循环）；测试显式锁死 |
| batch 全正 id、缺站点/抛错 | `failedItems` + 其余 `successIds` | 不变 |

## 未改动（明确声明）

- `siteRoutePayloads.ts:42` `ids: z.array(z.number().int().positive()).optional()` 未改；`:79` 文案 `'Invalid ids. Expected number[].'` 未改。
- `sites.ts:458` `normalizeBatchIds` 未改（helper 维持，非第二套契约）。
- `sites.ts:826` batch 循环未加 `id<=0` 守卫（契约下不可达，防御性检查非必需项）。
- 相邻路由一律不碰：`disabled-models` GET :887 / PUT :904（仍仅 `isNaN`），`available-models` / `probe-now` / `probe-stream` 均未动。

## 锚点事实登记（当前树核实，不改码）

### (a) `updatedAt` 语义 — `src/server/db/schema.ts`

- **`sites.updatedAt`**：`schema.ts:27`（`updatedAt: text('updated_at').default(sql\`(datetime('now')\`)`)`）。TEXT 列，SQL 层默认 `datetime('now')`；路由写路径覆写为 JS ISO 串（PUT `updates.updatedAt = new Date().toISOString()`；batch 各分支 `updatedAt: new Date().toISOString()`）。
- **检查点 `analyticsProjectionCheckpoints.updatedAt`**：`schema.ts:496`（表定义起于 :479）。**校正 v17**：v17 记 :434（其树）/ 误把 :428 当 `updatedAt`；当前树 `recomputeStartedAt` = `schema.ts:490`，检查点 `updatedAt` = `schema.ts:496`，二者相差 6 行（与 v17 :428→:434 的偏移一致，整表下移约 +62 行）。

### (b) backup 重复写覆盖 — `src/server/services/backupService.ts`

函数 `buildRuntimeIdentityIndexesFromSection` 起于 `:457`（表体 :457-544）。

- **`siteIdByKey` 最小 id 胜（确定性 min-id win）**：`backupService.ts:471`（哨兵防御 `if (row.id <= 0) continue;`）+ `:476-486`（读 `existingId`，`if (row.id < existingId)` set 于 :482，否则 set 于 :485）。**与切片 12/13 笔记互引**（该笔记记 `siteIdByKey` min-id 胜 set 为 `:471-485`，一致）。
- **其余四 map 后写覆盖（last-write-wins，裸 `.set`）**：
  - `accountIdByKey.set` — `backupService.ts:503`
  - `tokenIdByKey.set` — `backupService.ts:511`
  - `routeIdByKey.set` — `backupService.ts:517`
  - `channelIdByKey.set` — `backupService.ts:528`
- **不对称**：`siteIdByKey` 保留较小 id（min-id 胜，确定性）；其余四 map 保留最后遍历到的 id（依赖导入行序）。v17 记 `:418-419/:426-427/:432-433/:443-444`（其树），当前树整体后移约 +~60 行，逐点已重锚为上述行号。

### (c) MySQL `affectedRows` 分支 — `src/server/db/index.ts`

函数 `normalizeRunResult` 起于 `:1227`（表体 :1227-1271）。

- **对象分支**：`db/index.ts:1238-1243`（`if ('affectedRows' in row || 'insertId' in row)`，`changes: Number(row.affectedRows || 0)` 于 :1240）。
- **数组分支**：`db/index.ts:1255-1260`（`if ('affectedRows' in first || 'insertId' in first)`，`changes: Number(first.affectedRows || 0)` 于 :1257）。
- **语义结论**：两分支对 `changes` 的归一化逻辑完全相同（`Number(affectedRows || 0)`）。因此**切片 6 守卫**（`classifyZeroRowAbort` 读守护 UPDATE 的 0 行 → A/B 分类）读到的 `changes` 值**不受驱动返回形态（普通对象 vs 单元素数组）影响**。对象分支先判（`typeof result === 'object' && !Array.isArray(result)`，:1230），数组分支次之（:1246）。
- **校正 v17**：对象 `:1238-1243`（当前树吻合）；数组 v17 记 `:1255-1259`，当前树实为 `:1255-1260`（`changes` 在 :1257）。
- **非 MySQL 分支不在本项**：PG `rowCount` 在数组分支 :1261 及上方独立 PG 路径（:1196、:1212）处理；sqlite 走 `changes`/`lastInsertRowid` 键（对象 :1232、数组 :1249），与 MySQL `affectedRows` 分支正交。
- **疑点**：无功能性疑点——两 MySQL 分支输出 `changes` 等值，切片 6 读值安全。唯一留注意：若驱动未来在数组分支返回 `rowCount` 而非 `affectedRows`（非 MySQL 情形），走 :1261，不属本项。

## 新旧测试计数

| 文件 | 旧 | 新 | 说明 |
|---|---|---|---|
| `sites.idGuard.test.ts` | —（无） | **6** | 新增：PUT 0/-1 → 400 不落写（非 404）；DELETE 0/-1 → 400 且正 id 站点仍在；DELETE 正 id 仍可删；PUT 正 id 缺失仍 404 |
| `sites.batch.test.ts` | 3 | **6** | +3（参数化 `ids` ∈ `[0]`/`[-1]`/`[1,-2]`）：整包 400 `'Invalid ids. Expected number[].'`，断言 `failedItems`/`successIds` 缺席，正 id 站点未被 enable |
| 全部 `sites.*`（8 文件） | 57 | **63** | api-endpoints 6 / batch 6 / disabledModels 9 / idGuard 6 / proxyUrl 33 / statusCascade 1 / subscription-summary 1 / token-router-cache 1 |

## 门禁结果

| 检查 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck:server`（`tsc --noEmit -p tsconfig.server.json`） | ✅ PASS | 0 错误 |
| `npm run repo:drift-check` | ✅ PASS | Violations: 0；Tracked debt: 5（均为既有 proxy-core/web-page 债，与本切片无关） |
| `npx vitest run` 全部 `sites.*`（8 文件） | ✅ PASS | 8 files passed / 63 tests passed |

## 工作区既有改动（非本切片，未触碰）

`git status` 显示以下改动**先于本切片存在于工作区**，本切片**未创建、未修改**（属禁止清单内文件，已遵守「不动」约束，不纳入本次提交面）：

- `package.json`（+1）：新增 npm script `test:live:usage-aggregation`（指向 `usageAggregationService.live.test.ts`）。
- `.github/workflows/ci.yml`（+6）：mysql / postgres 两个 schema job 各加一步 `npm run test:live:usage-aggregation`。
- `src/server/services/usageAggregationService.live.test.ts`（untracked）：上述 live 测试文件本体。

三者为先前切片（U6 live-gated 用量聚合）遗留的工作区改动，与站点单条守卫无代码关联。

## 未 commit

本次改动**未执行** `git commit` / `git push` / 部署，仅在工作区盘上修改并验证。提交面仅为 `sites.ts`（两处守卫）+ `sites.idGuard.test.ts`（新）+ `sites.batch.test.ts`（+3 例）。

## 来源

- 设计：`/tmp/tok_v17.txt`「T7（U1+U2 重写）」整段（现码、实现、行为不变映射、§12.7、§13/§14/§16）。
- 规格：`.agents/notes/20260927-token-usage-spec-recovered.md` §11.9。
- 互引笔记：`.agents/notes/20260927-slice12-13-backup-site-keys.md`（backup min-id 胜）、`.agents/notes/20260927-slice6-checkpoint-guard.md`（affectedRows 守卫读值）。
