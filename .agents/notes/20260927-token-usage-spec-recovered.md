# 精确词元消耗统计（用量拆分）设计规范恢复稿

> **性质**：已丢失工作的设计材料恢复稿，供复盘与重新实现参考。  
> **恢复日期**：2026-09-27  
> **来源材料**：/tmp 残稿、/tmp/herdr-role-sessions/default/**/*.jsonl、/tmp/git_show_full.txt（全部只读，未改动任何源码）。  
> **工作目录**：/root/workspace/metapi-usage-rebuild

---

## 1. 目标与口径

### 1.1 总体目标

在保留期内把 token 记成可审计的正式拆分；删站造成的历史聚合收进 FK 桶（id=-1）。v10–v19 已锁定六条单义、排除集、O 系列与其余 §12 条目维持。v19 定论：无方向性开放问题。（来源：`/tmp/plan-token-stats-v19.md`「Goal」节；`/tmp/planner-v10-recovered.txt`「## Goal」）

### 1.2 五列新增（proxy_logs 用量拆分）

commit `80dbf21` 引入五列纯加法：

- `cache_read_tokens`（可空 int）
- `cache_creation_tokens`（可空 int）
- `reasoning_tokens`（可空 int）
- `prompt_tokens_include_cache`（可空 boolean）
- `usage_source`（可空 text）

手工迁移 `0031_proxy_logs_usage_columns.sql` + journal idx 31；再生成 5 个契约产物。`schemaParity`：新列 bootstrap 连续断言 + upgrade 五列守卫。（来源：`/tmp/msg1.txt`；`/tmp/plan-token-stats-v19.md`「Goal / §3 / §16」）

### 1.3 三列站点归属（proxy_logs 站点拆分）

随五列同一切片或更晚落地：

- `site_id`
- `model_site_id`
- `credential_site_id`

三列与 `(site_id, id)` 索引同一切片落地、同一切片验收。不加 FK。（来源：`/tmp/plan-token-stats-v19.md`「§3 / §6 / 6A / 6B / S7」）

### 1.4 六写入点与统一归一

六个写入点全部走 `resolveFinalUsage` 统一归一，不得各自再减一次。images/search 没有上游 usage，调用时传入「全字段 presence=false、显式 zeros=true」，得到真 0 而不是 NULL，且 usageSource 不因此变成 unknown。（来源：`/tmp/plan-token-stats-v19.md`「附录 A-1（1.1–1.5）/ §6 / D5」；`/tmp/oracle-normalize-backup.ts` 全文）

### 1.5 计费与 usage_source 口径

- `usage_source`：`upstream` / `self-log` / `unknown`
- 计费只消费归一后的数。归一后 flag 已是 false 或 null，`promptTokensIncludeCache === false` 分支不减；flag===null 且 cache 分量存在时维持现状（减一次），因为 parser 不再先减。（来源：`/tmp/plan-token-stats-v19.md`「附录 A-1 1.3 / 1.4」；`/tmp/oracle-normalize-backup.ts`「export function resolveFinalUsage」）

---

## 2. proxy_logs 五列的定义与语义

### 2.1 列定义

| 列名 | 类型 | 语义 | 来源键（上游字段族） |
| --- | --- | --- | --- |
| `cache_read_tokens` | 可空 int | 本次请求从缓存读取的 prompt 词元数 | OpenAI: `prompt_tokens_details.cached_tokens`；Anthropic: `cache_read_input_tokens`；DeepSeek: `prompt_cache_hit_tokens`；Gemini: `cachedContentTokenCount` |
| `cache_creation_tokens` | 可空 int | 本次请求为缓存新创建的 prompt 词元数 | OpenAI: `cache_creation_tokens`；Anthropic: `cache_creation_input_tokens` / `ephemeral_5m/1h_input_tokens`；DeepSeek: 无（不写入） |
| `reasoning_tokens` | 可空 int | 推理/思维链词元数 | OpenAI: `completion_tokens_details.reasoning_tokens`；Gemini: `thoughtsTokenCount`；Anthropic: 本字段族通常无，不反推 |
| `prompt_tokens_include_cache` | 可空 boolean | 归一后的 flag：已减则为 false；无证据则为 null，不减、不猜 | 由字段形状决定，不按平台名猜 |
| `usage_source` | 可空 text | 用量数据来源：`upstream` / `self-log` / `unknown` | 见 §1.5 |

（来源：`/tmp/plan-token-stats-v19.md`「附录 A-1 1.1–1.2」；`/tmp/oracle-parser-backup.ts`「PROMPT_TOKEN_KEYS / COMPLETION_TOKEN_KEYS / TOTAL_TOKEN_KEYS / GEMINI_CANDIDATES_KEYS / GEMINI_THOUGHTS_KEYS / CACHE_READ_* / CACHE_CREATION_* / REASONING_*」）

### 2.2 语义规则（归一后）

- **flag === true**：prompt 已含缓存，归一时减一次（`prompt = max(0, prompt - cacheRead - cacheCreation)`），写出 `prompt_tokens_include_cache=false`。
- **flag === false**：prompt 不含缓存，不减，flag 保持 false。
- **flag === null**：无形状证据，cache 列写 NULL（不是 0），prompt 不减，flag 列写 null。（来源：`/tmp/plan-token-stats-v19.md`「附录 A-1 1.3 / 1.3a」；`/tmp/oracle-normalize-backup.ts`「function normalizeUsageFields」）

### 2.3 缓存、推理、flag、用量来源各自含义

- **缓存**：`cache_read_tokens` 与 `cache_creation_tokens` 不另加进 total；total 合成时只加一次。
- **推理**：`reasoning_tokens` 已含在 completion 内，不另加进 total。
- **flag**：唯一写入物是 `prompt_tokens_include_cache`，值为 false 或 null；true 只存在于历史未迁移行，读侧按「未归一」防御。
- **用量来源**：`upstream`（上游观测）、`self-log`（文本/旧 meta 补缺）、`unknown`（全 absent）。（来源：`/tmp/plan-token-stats-v19.md`「附录 A-1 1.1 / 1.3」；`/tmp/oracle-normalize-backup.ts`「export type ProxyUsageSource / function resolveFinalUsage」）

---

## 3. presence 化解析与 resolveFinalUsage 归一规则

### 3.1 presence 化解析（parse 层）

旧实现用 `firstPositiveInt` 把「键缺失」「显式 0」折叠成同一个 0，导致缺失无法与观测 0 区分。presence 化后：

- 键缺失 → presence=false、值 0；列写 NULL。
- 键在且值为 0 → presence=true、值 0；列写 0。
- 禁止 all-or-nothing，禁止「缺失返回 0」。（来源：`/tmp/oracle-parser-backup.ts`「interface ParsedProxyUsage / function createEmptyProxyUsage / function parseUsageRecord」；`/tmp/plan-token-stats-v19.md`「附录 A-1 1.3」）

### 3.2 字段抽取规则

parse 层按 `hasOwn` 逐键读取，任一别名键存在且值可解析为有限数 → present。多个别名同时存在时取最大值（与旧 `firstPositiveInt` 的「第一个正值」语义近似，且不丢显式 0）。（来源：`/tmp/oracle-parser-backup.ts`「function readUsageField / function readNestedUsageField」）

### 3.3 四步管道

1. **parse**：按字段 hasOwn 抽原始 prompt / completion / cache / reasoning / total，带每字段 presence，不减。
2. **merge**：逐帧取 max + presence OR；禁止对已减帧和未减帧取 max。
3. **合成来源**：hasUpstreamUsage 时保持 upstream 的 parsedUsage；三字段都缺才用 self-log；全缺写 NULL + unknown。
4. **归一一次**（`resolveFinalUsage`）：在合成之后，flag===true 时减一次并写成 false；flag===null 时 cache 列写 NULL、prompt 不减。（来源：`/tmp/plan-token-stats-v19.md`「附录 A-1 1.3 第 1–4 步」；`/tmp/oracle-normalize-backup.ts`「export function resolveFinalUsage」）

### 3.4 resolveFinalUsage 归一规则（唯一入口）

```ts
// 归一后的列里不会再出现 flag=true 的新行：true 只存在于历史未迁移行，读侧按「未归一」防御。
export function resolveFinalUsage(input: ProxyUsageNormalizeInput): ResolveFinalUsageResult {
  if (input.zeros === true) {
    // images/search：显式真 0，不是 NULL；usageSource 不因此变 unknown（写 NULL）。
    return buildResult(zerosColumns(), null);
  }
  const upstream = normalizeUpstreamUsage(input.upstream);
  if (hasUsageObservation(upstream)) {
    return normalizeUsageFields(upstream, 'upstream');
  }
  if (input.selfLog) {
    // D6：upstream 完全缺观测时才用 self-log 的 token/cache/flag 做合成，随后同一次归一。
    return normalizeUsageFields(toSelfLogUsage(input.selfLog), 'self-log');
  }
  return buildResult(emptyColumns(), 'unknown');
}
```

归一后返回三件套：
- `columns`：六个写入点把这一组数写进 proxy_logs 五列 + 既有三列。
- `billing`：与列值同一组数（NULL 分量按 0 交给计费）。
- `usageSource`：`upstream` / `self-log` / `unknown`。（来源：`/tmp/oracle-normalize-backup.ts`「export function resolveFinalUsage / function buildResult / function emptyColumns / function zerosColumns」；`/tmp/plan-token-stats-v19.md`「§6 / 6A / 6B / D5」）

### 3.5 平台映射要点

- **OpenAI Chat / Responses / embeddings**：输入 prompt_tokens 含 `prompt_tokens_details.cached_tokens`，flag=true；cache read=details.cached_tokens；cache creation 通常无。
- **Anthropic Messages**：input_tokens 不含缓存，flag=false；cache read=`cache_read_input_tokens`；cache creation=`cache_creation_input_tokens` 否则 ephemeral_5m+1h。
- **Gemini API usageMetadata**：promptTokenCount 含 cachedContentTokenCount，flag=true；cache read=cachedContentTokenCount；completion=candidatesTokenCount + thoughtsTokenCount；reasoning=thoughtsTokenCount。
- **DeepSeek**：prompt_tokens 含 prompt_cache_hit_tokens，flag=true；cache read=prompt_cache_hit_tokens；cache creation 不写入。
- **网关混写**（new-api / one-hub / done-hub / anyrouter / sub2api）：按实际字段形状走上表，不按平台名。（来源：`/tmp/plan-token-stats-v19.md`「附录 A-1 1.2」；`/tmp/oracle-parser-backup.ts`「PROMPT_TOKEN_KEYS / COMPLETION_TOKEN_KEYS / TOTAL_TOKEN_KEYS / GEMINI_CANDIDATES_KEYS / GEMINI_THOUGHTS_KEYS / CACHE_READ_* / CACHE_CREATION_* / REASONING_*」）

---

## 4. 六写入点清单

六个调用点全部只消费 `resolveFinalUsage`，不各自再减一次：

| 写入点 | 位置（基线锚点） | 说明 |
| --- | --- | --- |
| sharedSurface | `sharedSurface.ts:278` | chat/responses/rerank surfaces 共用 |
| geminiSurface | `geminiSurface.ts:276` | Gemini 原生回调 |
| completions | `completions.ts:404` | OpenAI Completions |
| embeddings | `embeddings.ts:249` | Embeddings |
| images | `images.ts:487` | Images |
| search | `search.ts:233` | Search |

images/search 没有上游 usage，调用时传入 zeros=true，得到显式真 0，usageSource 不因此变成 unknown。（来源：`/tmp/plan-token-stats-v19.md`「§6 / 6A / 6B / D5」；`/tmp/planner-v10-recovered.txt`「## 6 / 6A / 6B」）

---

## 5. 迁移与三方言生成器

### 5.1 迁移 0031

手工迁移 `0031_proxy_logs_usage_columns.sql` + journal idx 31；再生成 5 个契约产物（SQLite/MySQL/PostgreSQL bootstrap + upgrade）。`schemaParity`：新列 bootstrap 连续断言 + upgrade 五列守卫（滚动 diff 机制）。（来源：`/tmp/msg1.txt`；`/tmp/plan-token-stats-v19.md`「Goal / §3」）

### 5.2 三方言生成器

- **schema:generate** = `db:generate` + `schema:contract`（`generate-schema-contract.ts`）。
- 跨 dialect bootstrap 和 upgrade SQL 必须从 schema contract 生成，禁止手写新 MySQL/Postgres schema patch。
- 迁移列清单（`databaseMigrationService.ts:596-599`）现 18 列，无三列；补拷贝 `site_id`、`model_site_id`、`credential_site_id`（values 同步 camel/snake）。（来源：`/tmp/plan-token-stats-v19.md`「§3 / §16 / S5 / T3」；`/tmp/tok_v16.txt`「## 改动文件 / databaseMigrationService.ts」）

### 5.3 setval（Postgres 序列）

`sites` 表写死：

```sql
SELECT setval(
  pg_get_serial_sequence('sites', 'id'),
  GREATEST(
    COALESCE((SELECT MAX(id) FROM "sites" WHERE id > 0), 0),
    1
  ),
  TRUE
)
```

空表、仅哨兵、仅 `id=0`、MAX 为负：内层 MAX 都是 NULL → COALESCE 0 → GREATEST 1。正 id 存在则为 `max(MAX, 1)`。其它表维持现码 `COALESCE(MAX(id), 1)`，不顺手改。（来源：`/tmp/plan-token-stats-v19.md`「§16.2 / T3 / U9」；`/tmp/tok_v16.txt`「## 16 / setval（T3）」）

---

## 6. 历史回填 runner

### 6.1 触发与 marker

- 表：`settings`（`schema.ts:380-383`，主键 `key`，`value` 为 JSON 文本）。
- 行：`key='usage_site_backfill_v1'`。value：`{"state":"pending"}` 或 `{"state":"done"}`。
- 该 key 加入 `EXCLUDED_SETTING_KEYS`（`backupService.ts:236-244`）。`exportPreferencesSection` 因此不导出。`importPreferencesSection` 只写备份里出现且 `isSettingValueAcceptable` 的行；排除集还要在导入循环显式 `continue`，防止旧备份已带此 key 时写回。
- `toBackupSnapshot` 全量复制 settings，不走排除集。`buildStatements` 在 `:715` 旁把 marker 与 `RUNTIME_DATABASE_SETTING_KEYS` 一并跳过。源库 marker 不得进目标。目标值只由目标事务自己的 pending/done 决定。（来源：`/tmp/plan-token-stats-v19.md`「§5 F6 marker」）

### 6.2 pending / done 写点

- **pending 写点**：`insertAllRows`（`:744`，调用处在 commit 之前）之后、`commit`（`:807`）之前。仅当目标库存在三列皆 NULL 的 `proxy_logs` 时写。三列未落地时不写 pending。
- **done 写点**：必须同时满足三列 NULL 计数都为 0。任一列仍有 NULL 不得标 done。（来源：`/tmp/plan-token-stats-v19.md`「§5 F6 marker / P3b 边界」）

### 6.3 回填 runner 调用点

生产调用点全枚举（v15 S1 / v19 更新）：

1. 删站单条/批量事务内 CASE（历史行收进 -1）。
2. 导入收口 `requestUsageAggregatesRecompute(1)`（`usageAggregationService.ts:855`）。
3. 回填批内 CASE，把 `recomputeFromId` 降到受影响行。

不调用：工厂重置（只删 checkpoint）；迁移（M3 后不做提交后重算，只在目标库事务内 DELETE 聚合行）。（来源：`/tmp/plan-token-stats-v19.md`「§5 / 9.1」；`/tmp/planner-v10-recovered.txt`「## 5」）

### 6.4 requestUsageAggregatesRecompute（P4）

v19 最终形态（单条 MIN-merge UPDATE）：

```ts
export async function requestUsageAggregatesRecompute(fromLogId = 1): Promise<void> {
  const raw = Number(fromLogId);
  const n = Math.trunc(raw);
  const normalizedFromId = Number.isFinite(n) ? Math.max(1, Math.min(n, 2147483647)) : 1;
  const nowIso = new Date().toISOString();

  await db
    .update(schema.analyticsProjectionCheckpoints)
    .set({
      recomputeFromId: sql<number>`CASE
        WHEN ${schema.analyticsProjectionCheckpoints.recomputeFromId} IS NULL
          OR ${schema.analyticsProjectionCheckpoints.recomputeFromId} <= 0
          THEN ${normalizedFromId}
        WHEN ${schema.analyticsProjectionCheckpoints.recomputeFromId} <= ${normalizedFromId}
          THEN ${schema.analyticsProjectionCheckpoints.recomputeFromId}
        ELSE ${normalizedFromId}
      END`,
      recomputeRequestedAt: nowIso,
      updatedAt: nowIso,
    })
    .where(eq(schema.analyticsProjectionCheckpoints.projectorKey, USAGE_PROJECTOR_KEY))
    .run();
}
```

行为变化：行缺失 → no-op（不建行、静默丢弃）。当前无生产调用方（仅测试直接调用）。（来源：`/tmp/plan-token-stats-v19.md`「§9.5 P4」；`/tmp/tok_v16.txt`「## 9.5 P4」）

---

## 7. 聚合侧口径（含未知站点哨兵 -1）

### 7.1 哨兵行定义（F1）

字段（锁死）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `id` | `-1` | 显式写入 |
| `name` | `未知站点` | 与 `ProxyLogs.tsx:3187` 同一词 |
| `status` | `disabled` |
| `platform` | `reserved-unattributed` | `schema.ts:9` NOT NULL |
| `url` | `metapi-reserved://unattributed-site` | 保留 scheme |

`platform` 保持 NOT NULL。禁止再写 `platform=null`（列是 NOT NULL，可空会让 SQLite 唯一索引对 NULL 失效）。「platform=null」只保留为 §4.1 聚合口径含义（规则 3 的结果），不作为 sites 行值。（来源：`/tmp/plan-token-stats-v19.md`「§1–2 F1 哨兵行最终字段」）

### 7.2 未归因单入口（F2b）

权威定义是六条单义的解析结果，不是 join 出来的 `sites.id`：

- 存储列 `site_id` 非 NULL — 解析：用该列；列值 ≤0 或非有限按 -1
- 存储列 NULL，且账号存在、`accounts.site_id` > 0 — 解析：用账号站点
- 存储列 NULL，且 `account_id` 空、账号已删、或账号 `site_id` 非有限/≤0 — 解析：-1

**存储列口径**：非 NULL 且有限且 `> 0` → 该正 id；非 NULL 且（非有限或 `≤ 0`）→ -1；NULL 走账号兜底，兜底失败 → -1。

**-1 筛选语义（落地版）**：`proxy_logs.site_id <= 0 OR (proxy_logs.site_id IS NULL AND (accounts.id IS NULL OR NOT (accounts.site_id > 0)))`。（来源：`/tmp/plan-token-stats-v19.md`「§1–2 F2b 未归因单入口」；`/tmp/planner-v10-recovered.txt`「## 4.1」）

### 7.3 聚合维度

聚合纳入 `active ∪ {-1}`；排除集维持；`stats.ts` 站点列表保留 -1（meta 现为 `select id,name,status from sites`，哨兵行会自然出现）。（来源：`/tmp/plan-token-stats-v19.md`「§7–8」；`/tmp/planner-v10-recovered.txt`「## 7–8」）

### 7.4 platform 取源（S8）

聚合与展示的 platform 取**解析站点对应行**。解析为 -1 ⇒ `platform=null`（只聚合口径）。解析为正 id X ⇒ 取 sites 中 id=X 的 `platform`。禁止在解析 site 与账号站点不同时继续取账号 join 的 platform。（来源：`/tmp/plan-token-stats-v19.md`「§1–2 F2b platform 取源 / §4 S8 platform」）

### 7.5 筛选列口径与聚合桶口径并存（O9）

筛选是**列值口径**，聚合是 §4.1 口径。已删站点 42 的行若按 §4.1 进聚合 -1 桶，但列上仍是 42：筛 `-1` 不返回该行，筛 `42` 返回。二者并存不是缺陷。（来源：`/tmp/plan-token-stats-v19.md`「§7–8 O9 双口径并存」；`/tmp/planner-v10-recovered.txt`「## 7–8 O9」）

---

## 8. checkpoint 写点守卫与 A/B 中止分类

### 8.1 四写点总则（v18 R1 + v19 实施注记）

删除 `writeProjectionCheckpoint`（现码 `:312-384`）。调用点 `:710/:744/:780/:865` 四点改为**显式列清单的守卫 UPDATE**（`:710/:744/:780`：guard=`projectorKey` + `leaseToken`，0 行 → A/B；`:865`：**单条 MIN-merge UPDATE**，行缺失 → no-op）；**绝不 INSERT**（建行仅归 `ensureProjectionCheckpointExists`）；三类聚合表（siteDay/siteHour/modelDay）upsert 语义照旧、不得误改；四点 SET 仅含该点原意列 + `updatedAt`，禁 spread 回写。（来源：`/tmp/plan-token-stats-v19.md`「§9.2 四写点总则」；`/tmp/notes_bak.md`「## 决策 1」）

### 8.2 四张逐点白名单（§9.3）

| 写点 | 位置 | guard | SET 列（+`updatedAt`） | 0 行处置 |
| --- | --- | --- | --- | --- |
| P1 批投影 | `:710` | `projectorKey` + `leaseToken` | `lastProxyLogId`, `watermarkCreatedAt`, `leaseExpiresAt`, `lastProjectedAt`, `lastSuccessfulAt`, `lastError` | A/B 抛错回滚 |
| P2 重算·行缺失 | `:744` | `projectorKey` + `leaseToken` | `recomputeFromId`(→null，CAS), `recomputeRequestedAt`(→null，CAS), `leaseExpiresAt`, `lastProjectedAt` | A/B 抛错回滚 |
| P3 重算·重启 | `:780` | `projectorKey` + `leaseToken` | `lastProxyLogId`(=restartFromId-1), `watermarkCreatedAt`(→null), `recomputeFromId`(→null，CAS), `recomputeRequestedAt`(→null，CAS), `leaseExpiresAt`, `lastProjectedAt` | A/B 抛错回滚 |
| P4 重算请求 | `:865` | `projectorKey` | `recomputeFromId`(MIN-merge), `recomputeRequestedAt`(nowIso) | 行缺失 → no-op（不抛错） |

统一剔除列：`projectorKey`（WHERE 承载）、`timeZone`、`leaseOwner`/`leaseToken`、`recomputeReason`/`recomputeStartedAt`/`recomputeCompletedAt`、`createdAt`。（来源：`/tmp/plan-token-stats-v19.md`「§9.3 四张逐点白名单」；`/tmp/tok_v16.txt`「## 9.3 四张逐点白名单」）

### 8.3 P2/P3 清除写 CAS（v16 T1）

```sql
UPDATE analytics_projection_checkpoints
SET
  recompute_from_id = CASE
    WHEN recompute_from_id = <seen> THEN NULL
    ELSE recompute_from_id END,
  recompute_requested_at = CASE
    WHEN recompute_from_id = <seen> THEN NULL
    ELSE recompute_requested_at END,
  updated_at = <now>,
  -- 水位/last_proxy_log_id/lease_expires_at 仍按 v15 该写点原意更新
WHERE projector_key = <USAGE_PROJECTOR_KEY>
  AND lease_token = <pass token>
```

CASE 的比较列与赋值列必须是**更新前**的 `recompute_from_id`。并发 `request` 若已把 100 改成 50，`WHEN` 失败，50 与其 `requested_at` 保留。（来源：`/tmp/plan-token-stats-v19.md`「§9.4 P2/P3 清除写 CAS」；`/tmp/tok_v16.txt`「## 9.4 P2/P3 清除写 CAS」）

### 8.4 0 行分类 A/B（v19 替换文本）

触发：守卫 UPDATE 返回 0 行时：

1. **复读必须用裸读**：`db.select().from(schema.analyticsProjectionCheckpoints).where(eq(projectorKey, USAGE_PROJECTOR_KEY)).get()`。**不得复用 `readProjectionCheckpoint`**：行缺失时它返回 `emptyCheckpoint()`，其中 `leaseToken: null`，会把 **A 误归 B**。
2. **分类**：
   - **A = 裸读无行** → `checkpoint_reset`（行被外部删除）。
   - **B = 裸读有行但 `leaseToken !== 本次租约 token`** → `lease_lost`（租约丢失）。
   - A/B 均以可识别错误抛出，经 scheduler 侧 `.catch` 降级为 warn/error 日志、进程不退出。
3. **防御分支**：裸读有行 + 令牌相符 + 0 行——理论可能，不为其新增分支语义，保守按 B 抛错。（来源：`/tmp/plan-token-stats-v19.md`「§9.6 0 行分类」；`/tmp/notes_bak.md`「## 0 行分类（A/B）」）

### 8.5 lastError 口径

- A/B：**仅 warn**，不要求 lastError 落库。
- lastError：**仅** release 命中（token 匹配、`changes>0`）时写入。
- **禁止**为写 lastError 另插一行或放宽 WHERE。`ensure` 保持唯一插入。（来源：`/tmp/plan-token-stats-v19.md`「§9.8 lastError 口径」；`/tmp/notes_bak.md`「## 决策 6」；`/tmp/tok_v16.txt`「## 9.8 / S3 lastError」）

### 8.6 .changes 归一与 FOUND_ROWS

`db/index.ts:1227-1271` 归一 `.changes`：MySQL 取 `affectedRows`（对象分支 `:1238-1243`、数组分支 `:1255-1259`），PG 取 `rowCount`（`:1196`/`:1212`），SQLite 取 `changes`。v19 核实：mysql2 默认 flags 含 `FOUND_ROWS` → `affectedRows=matched`；PG `rowCount=matched`；SQLite `changes=命中行`。守卫 UPDATE 的必变列设计在 matched 与 changed-rows 两种语义下均保证 `changes>0`、不误判 A/B。（来源：`/tmp/plan-token-stats-v19.md`「§9.8 / §9.6 / 归并裁定 2026-09-25 第 2 条」；`/tmp/tok_v16.txt`「## 9.8 / T5」）

---

## 9. 备份导入导出的五列接线

### 9.1 导出分流（v13 维持）

导出（`backupService.ts:586-599`）三条分流：

- `siteId===-1` → 键字段直通 `-1`。不调用 `buildSiteIdentityKey`。
- `siteId==null` → 键字段 `null`。
- 真实正 id → `siteKeyById.get(id)`；无键或站点已删 → `null`，并 `console.debug` 一条。

**裸值清除**：`{...row}` 会带出裸 id 列。机制写死为解构剔除，不是事后覆盖碰运气：

```ts
const { accountId, routeId, channelId, downstreamApiKeyId, siteId, modelSiteId, credentialSiteId, ...rest } = row;
导出对象 = { ...rest, accountKey, routeKey, channelKey, downstreamApiKeyKey, siteKey, modelSiteKey, credentialSiteKey };
```

（来源：`/tmp/plan-token-stats-v19.md`「§3.1 导出三条分流 / 3.4 键名表」；`/tmp/tok_v15.txt`「## 3 / F5 键名表」）

### 9.2 导入分流（v13 维持）

- 键 `=== -1` → 列写 -1。
- 键 `== null`（含旧备份无该字段）→ 列写 null。
- 其它 → `siteIdByKey.get(key)`；命中写目标 id；未命中写 null，并 `console.debug`。（来源：`/tmp/plan-token-stats-v19.md`「§3.2 导入分流」）

### 9.3 导入 identity 索引（F5）

`buildRuntimeIdentityIndexesFromSection`（`:388` 起，sites 循环 `:399-403`，set `:401-402`）**首胜＝最小 id 胜**，比较已存 id 与当前 id，保留较小者；不依赖 `section.sites` 行序。同键第二次命中打 debug。同一循环跳过 `id<=0`，且**跳过必须发生在比较之前**（防哨兵 -1「赢过」正 id）。（来源：`/tmp/plan-token-stats-v19.md`「§3.3 F5 重复键与循环跳过 / 归并裁定 2026-09-25 第 1 条」；`/tmp/tok_v15.txt`「## 3 / F5」）

### 9.4 三态编码（七个站点向键同一套）

| 存储值 | 快照值 | 说明 |
| --- | --- | --- |
| `-1` | 字面 `-1` | 哨兵直通，不查 `siteKeyById` |
| `null` | `null` | |
| 正 id | 身份键 | `siteKeyById` 未命中 → `null` + debug |
| 其它非正（0、负且 ≠ -1） | `null` + debug | 按 F2b 写入域本不该出现；不编码成 -1 |

（来源：`/tmp/plan-token-stats-v19.md`「§3.4 键名表 / 三态编码」；`/tmp/tok_v15.txt`「## 3 / 三态编码」）

---

## 10. live 测试与 CI 接线

### 10.1 live-gated 开关

- `src/server/db/runtimeSchemaBootstrap.live.test.ts:10-11`：`DB_PARITY_MYSQL_URL` / `DB_PARITY_POSTGRES_URL` 缺省 `it.skip`。
- 同类门控：`schemaUpgrade :8-9`、`schemaParity :14-15`。
- **无 URL 时 skip ≠ 通过**，完成判定以 CI live 环境为准。（来源：`/tmp/plan-token-stats-v19.md`「§12.H / §16 / U6」；`/tmp/tok_v16.txt`「## 12.4 / 12.8 / U6」）

### 10.2 CI 渠道

- **MySQL 停手判定**：只在 CI `schema-mysql`（`mysql:8.4`）或同一镜像的运行态插入上解读；不把 sqlite parity 当依据。
- CI job：`.github/workflows/ci.yml:213` `image: mysql:8.4`，`:225` `DB_PARITY_MYSQL_URL`，`:241-242` `npm run test:schema:parity`。
- 哨兵显式 `id=-1` 不在 parity 的 schema 契约里，**不能把 parity 绿当成「-1 可插入」**。（来源：`/tmp/plan-token-stats-v19.md`「§16.1 MySQL 实测与停手语义」；`/tmp/planner-v10-recovered.txt`「## 16」）

### 10.3 三方言 setval 完成条件（live-gated）

- sqlite / mysql / postgres × {空表, 仅哨兵, 仅 `id=0`}。
- postgres 上序列 `last_value>=1` 且 `is_called=true`（`setval(..., TRUE)`）。
- sqlite/mysql 无序列，断言不插入 `id<=0` 的业务行、下一应用层 id ≥ 1。
- **禁止断言三方言首 id 都是 1**（pg 空表 `setval(1, TRUE)` → 下一 `nextval` = **2**；sqlite/mysql 空表首插入 id = **1**）。（来源：`/tmp/plan-token-stats-v19.md`「§12.E 第 8 条 / §16.2 / U9」；`/tmp/tok_v16.txt`「## 12.8 / U9」）

---

## 11. 切片清单与每片验收标准

### 11.1 切片 6：checkpoint 写点守卫与 A/B 中止

- **目标**：删除 `writeProjectionCheckpoint` upsert helper，四个写点改为显式列白名单的租约守卫 UPDATE。
- **验收**：
  - 批投影 P1、重算行缺失 P2、重算重启 P3：守卫 UPDATE 0 行时用裸读分类 A（`checkpoint_reset`）/ B（`lease_lost`），在事务内抛专用错误触发回滚。
  - 重算请求 P4 为单条原子 MIN-merge、不含租约列、行缺失 no-op。
  - 调度器与 warm 的四个 `void` 调用点统一 `.catch(handleUsageProjectionPassFailure)`（A/B → warn，其它 → error，**绝不退出进程**）。
  - lastError 口径：仅 release 命中时写入；A/B 下 release WHERE 必 0 行，lastError 写不进去。（来源：`/tmp/notes_bak.md` 全文；`/tmp/plan-token-stats-v19.md`「§9 / §14」）

### 11.2 切片 8：文档微修复核

- **目标**：复核 T-A 双落补全、debug 量级登记、两条观察登记、门禁。
- **验收**：
  - `backupService.ts:560-568` 注释两处残余句都在、语义相符。
  - 「最小 id 胜（确定）vs 其余四 map 后写覆盖」的 reconciliation 与源码事实一致。
  - 门禁：`backupService.test.ts` 32/32、typecheck 四段绿、drift 0 违规。（来源：`/tmp/task-oracle-…（slice8docrecheck-20260926T033419Z）` 全文）

### 11.3 切片 10：presence 化解析 + resolveFinalUsage 统一归一 + 六写入点接线

- **目标**：用法解析 presence 化、resolveFinalUsage 统一归一与六写入点接线。
- **验收**：
  - parser 不再用 `firstPositiveInt` 把缺失和 0 都变成 0；presence 化后缺失写 NULL、显式 0 写 0。
  - `resolveFinalUsage` 是 merge 与 self-log 合成之后的唯一归一入口。
  - 六个写入点全部只消费 `resolveFinalUsage`，不各自再减一次。
  - images/search 调用时传入 zeros=true，得到显式真 0，usageSource 不因此变成 unknown。
  - 计费只消费归一后的数；归一后 flag=false 时不再减。（来源：`/tmp/oracle-parser-backup.ts` 全文；`/tmp/oracle-normalize-backup.ts` 全文；`/tmp/oracle-slice10-probe.ts` 全文；`/tmp/plan-token-stats-v19.md`「附录 A-1 1.3 / §6 / D5」）

### 11.4 切片 11：schema 守护与发布面收口

- **目标**：sqlite 生成器合成 AUTOINCREMENT、语义守护与发布面收口。
- **验收**：schema 契约 / drift 产物 / upgrade SQL 三件套同步；AUTOINCREMENT 语义正确。（来源：`/tmp/plan-token-stats-v19.md`「§16 / 版本合并说明」；git log 提及 `42c9d43 feat(db): sqlite 生成器合成 AUTOINCREMENT、语义守护与发布面收口（切片 11）`，见 `/tmp/herdr-role-sessions/default/role-planner-a1c4021f/2026-09-26T14-05-14-629Z_01a0de08-d004-73da-ba9f-4381b1f9b602.jsonl`）

### 11.5 切片 12：迁移（databaseMigrationService）

- **目标**：proxy_logs 硬编码列清单补拷贝三列；`clearTargetData` 并入 `analytics_projection_checkpoints`；`toBackupSnapshot` 不拷贝三聚合表与 checkpoint。
- **验收**：
  - 列清单 `:596-599` 补 `site_id`、`model_site_id`、`credential_site_id`。
  - `clearTargetData` 清单含 checkpoint，不另起 DELETE。
  - `toBackupSnapshot` 不运三聚合表与 checkpoint。
  - 三方言 setval 夹具绿。（来源：`/tmp/plan-token-stats-v19.md`「§3 / §16 / S5 / S6 / T3 / 改动文件 #4」；`/tmp/tok_v15.txt`「## 改动文件 / databaseMigrationService.ts」）

### 11.6 切片 13：导入归因（backupService）

- **目标**：导入事务 `importAccountsSection` 内先清 `proxyLogs`，经 FK 级联清三聚合表；commit 前 DELETE checkpoint 行 + ensure 哨兵；`buildRuntimeIdentityIndexesFromSection` 最小 id 胜；导出 map 七键/三态。
- **验收**：
  - 导入事务内：DELETE checkpoint 行、确保哨兵、插不进 fail-fast。
  - `siteIdByKey` 最小 id 胜（大 id 行在前仍取小 id）。
  - 导出对象不含任一裸 id；七键全查。（来源：`/tmp/plan-token-stats-v19.md`「§3 / §9.1 / F10 / 改动文件 #5」；`/tmp/tok_v15.txt`「## 改动文件 / backupService.ts」）

### 11.7 切片 14：Postgres 与三方言序列矩阵

- **目标**：PG 哨兵序列实测；三方言「哨兵-only → 新站点 `id≥1`」。
- **验收**：
  - 空表 / 仅哨兵 / 仅 `id=0` 三情形下，下一应用层 id ≥ 1。
  - PG `setval(..., GREATEST(COALESCE(MAX(id) WHERE id>0,0),1), TRUE)` 后 `nextval` ≥2 或至少新行 id≥1。
  - 失败模式 id=0 不可见站已写进 §16。（来源：`/tmp/plan-token-stats-v19.md`「§16.2 R2」；`/tmp/planner-v10-recovered.txt`「## 16」）

### 11.8 切片 15：四写点列集合 + CAS + void + setval + lastError + batch 哨兵守卫

- **目标**：写死四写点列集合与 CAS、void 收口、setval 公式、lastError 口径，并登记删除未接线与 batch 哨兵守卫。
- **验收**：
  - `:710` 列集合去掉 recompute 五列；`:744`/`:780` CAS；`:865` 单条 MIN。
  - scheduler `:877/:879` / warm `:81/:83` `.catch`；A/B warn、其它 error、进程不退出。
  - lastError 仅 release 命中时写入；A/B 下不落库。
  - setval sites 写死 GREATEST 公式。
  - batch `id<=0` 守卫登记。（来源：`/tmp/tok_v16.txt` 全文；`/tmp/plan-token-stats-v19.md`「§9 / §12 / §14 / §16」）

### 11.9 切片 16：T7 重写（单条站点守卫） + 锚点校正

- **目标**：单条 `PUT/DELETE /api/sites/:id` 对 `id<=0` 返回 400；batch 含 0/负 id 在契约层整包 400。
- **验收**：
  - PUT `id<=0` → 400 `'Invalid site id'`，不查库、不写。
  - DELETE `id<=0` → 400 `'Invalid site id'`，不删除。
  - batch `ids` 含 0/负 → 整包 400 `'Invalid ids. Expected number[].'`，不出现 `failedItems`。
  - 锚点校正：`updatedAt→schema.ts:434`；backup 覆盖 `:418-419/:426-427/:432-433/:443-444`；MySQL affectedRows 对象分支 `:1238-1243` + 数组分支 `:1255-1259`。（来源：`/tmp/tok_v17.txt` 全文；`/tmp/plan-token-stats-v19.md`「§1–2 T7 / §15.3 v17 U3 校正」）

---

## 12. 缺口清单

以下为从当前源材料**无法恢复**或**未覆盖**的内容，恢复稿不编造、不推测填空：

| # | 缺口描述 | 能否从当前 main 源码补齐 | 说明 |
| --- | --- | --- | --- |
| 1 | v1–v9 完整规划正文 | **不能** | 仅 v19 附录中有摘录（附录 A-1 ~ A-5），非完整原文。完整原文未在源材料中出现。（来源：`/tmp/plan-token-stats-v19.md`「归并裁定 2026-09-25 第 4 条 / 附录」） |
| 2 | `metapi-usage-rebuild` 与 `metapi-token-stats` 的路径映射 | **不能（当前不扩）** | 源材料中大量行号锚点指向 `metapi-token-stats` 工作树（如 `sharedSurface.ts:278`、`usageAggregationService.ts:710` 等）。当前工作目录为 `metapi-usage-rebuild`，是否具有相同模块结构未经验证；本恢复稿不跨项目假设路径等价。（来源：任务说明「绝对工作目录：/root/workspace/metapi-usage-rebuild」） |
| 3 | 早期 oracle/planner 会话的逐字全文（未进入 v19 合并的部分） | **不能** | 约 142MB、300+ 目录的 jsonl 会话中，仅有部分被提取进 `/tmp/plan-token-stats-v19.md`。未进入合并的会话正文未在源材料中完整呈现。（来源：`/tmp/herdr-role-sessions/default/` 目录结构） |
| 4 | `git_show_full.txt` 与设计决策的逐行对照 | **部分能** | `/tmp/git_show_full.txt` 约 13MB，为早期快照仓的 git show 全文。本恢复稿仅作一般性参考，未对其中每个设计决策做逐行 diff 对照。（来源：`/tmp/git_show_full.txt` 存在但未深挖） |
| 5 | 实际最终实现代码（非设计材料） | **不能** | 源材料包含 parser/normalize 的备份代码（`oracle-parser-backup.ts`、`oracle-normalize-backup.ts`）和 slice 10 probe 测试，但不含六个写入点、checkpoint 守卫、backup 导入导出等核心模块的最终实现代码。（来源：`/tmp/oracle-parser-backup.ts`、`/tmp/oracle-normalize-backup.ts`、`/tmp/oracle-slice10-probe.ts` 仅为备份/探测文件） |
| 6 | P4 与进行中 pass 的并发覆写Race（mid-pass 请求被 pass 最终 writeProjectionCheckpoint 吞掉） | **能，但源材料仅作观察登记** | v19 计划 §16 观察 10 登记了 LWW + min 无冲突，但未明确覆盖「pass 最终写点覆写 mid-pass 的 recompute 请求」这一 race window。实现期需额外验证。（来源：`/tmp/plan-token-stats-v19.md`「§16.4 第 8 条 / 观察 10」；`/tmp/herdr-role-sessions/default/role-oracle-d14a308b/2026-09-25T14-16-28-236Z_01a0d8ec-bb4c-7107-9bd2-97d7b75e5828.jsonl` 中 oracle 对此有独立分析） |
| 7 | 哨兵常量在 `src/shared/` 的具体文件名 | **不能** | 多份材料一致写明「文件名待实现切片定」。（来源：`/tmp/plan-token-stats-v19.md`「§1–2 F1 / 改动文件 #11」；`/tmp/notes_bak.md`「## 笔记要点」） |
| 8 | 同形真实站 / platform 无白名单的具体根治方案 | **不能** | 源材料仅登记为已知风险，明确「本切片不根治」。（来源：`/tmp/plan-token-stats-v19.md`「§1–2 F1 补登记 / §16.5」；`/tmp/notes_bak.md`「## 登记与观察」） |
| 9 | `requestUsageAggregatesRecompute` 生产调用方的接线设计 | **不能** | 源材料明确「无生产调用方（仅测试直接调用）」，未来接入 API/UI 的设计未在恢复材料中展开。（来源：`/tmp/plan-token-stats-v19.md`「§9.5 P4 / §16.4 第 4 条」；`/tmp/tok_v16.txt`「## 16 / 删除未接线」） |
| 10 | `metapi-usage-rebuild` 当前源码状态与设计材料的偏差 | **不能（当前不扩）** | 任务要求「只写这一份文档，不改任何源码」。本恢复稿以源材料为唯一依据，未对当前项目源码做一致性校验。（来源：任务说明「只写这一份文档，不改任何源码」） |

---

## 13. 来源文件索引

以下为恢复稿中引用的全部源材料绝对路径：

| 文件 | 用途 |
| --- | --- |
| `/tmp/planner-v10-recovered.txt` | v10 基线计划（Goal、§1–§16、工作单、验证命令） |
| `/tmp/tok_v15.txt` | v15 增量（S1–S8、四写点、F12、setval、batch 守卫） |
| `/tmp/tok_v16.txt` | v16 增量（T1–T8、CAS、void 收口、lastError、setval 公式） |
| `/tmp/tok_v17.txt` | v17 增量（U1–U9、T7 重写、锚点校正、live-gated） |
| `/tmp/notes_bak.md` | 切片 6 笔记（checkpoint 写点守卫与 A/B 中止） |
| `/tmp/oracle-parser-backup.ts` | 用法 parser 备份（presence 化、字段抽取、merge） |
| `/tmp/oracle-normalize-backup.ts` | resolveFinalUsage 归一实现备份 |
| `/tmp/oracle-slice10-probe.ts` | 切片 10 probe 测试（parse → normalize → billing 端到端） |
| `/tmp/msg1.txt` | commit `80dbf21` 消息（proxy_logs 五列 + 0031 迁移） |
| `/tmp/task-oracle-…（slice8docrecheck-20260926T033419Z）` | 切片 8 文档微修复核任务说明 |
| `/tmp/plan-token-stats-v19.md` | **主文档**：v10–v19 合并终稿（1586 行，含 Goal、§1–§16、行为不变映射、逐条闭环对照、对抗性自查、风险与回退、笔记与运行态说明、验证命令、归并裁定、v1–v9 附录） |
| `/tmp/herdr-role-sessions/default/role-oracle-06722983/2026-09-25T09-13-07-763Z_01a0d7d7-03b1-73a2-9184-eba663d972ea.jsonl` | oracle 会话（resolveFinalUsage、六写入点、A/B 中止、平台取源、迁移列清单、live 测试） |
| `/tmp/herdr-role-sessions/default/role-planner-582ae9d5/2026-09-25T10-39-08-656Z_01a0d825-c370-7295-8038-be0c133ad453.jsonl` | planner 会话（v9 计划正文、工作单、A1–A4 定答、O-f–O-k） |
| `/tmp/herdr-role-sessions/default/role-worker-18586d89/2026-09-25T14-26-51-546Z_01a0d8f6-3e19-7769-9160-f9f18c4eaca7.jsonl` | worker 会话（v19 合并编辑过程、§15 锚点校正、§16 条目） |
| `/tmp/herdr-role-sessions/default/role-planner-a1c4021f/2026-09-26T14-05-14-629Z_01a0de08-d004-73da-ba9f-4381b1f9b602.jsonl` | planner 会话（git log 提及关键 commit：`80dbf21`、`01479bf`、`49c3334`） |
| `/tmp/git_show_full.txt` | 早期快照仓 git show 全文（约 13MB，含 proxy_logs 表结构与早期文件片段） |

---

## 14. 恢复说明与限制

1. 本恢复稿**仅作设计记录与复盘依据**，不替代真实源码，不构成实现指令。
2. 所有结论均标注来源文件路径；无法恢复处已列入 §12 缺口清单，未编造、未用推测填空。
3. 源材料中 `/tmp/plan-token-stats-v19.md` 为 v10–v19 合并终稿，是恢复稿的主干依据；v1–v9 细节仅以附录摘录形式存在。
4. 大量行号锚点指向 `metapi-token-stats` 工作树，与当前工作目录 `metapi-usage-rebuild` 的代码结构是否一致未经验证；实现前须重新锚定。
5. 恢复过程未执行任何源码修改、未 commit、未删除文件、未联网。
