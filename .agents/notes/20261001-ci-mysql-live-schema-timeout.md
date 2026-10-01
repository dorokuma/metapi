---
status: active
superseded_by: ""
supersedes: ""
模块: "db, scripts"
---

# 20261001 CI MySQL live schema 用例超时（vitest 默认 5000ms）的预算修正

## 一句话结论

`Schema Check (MySQL)` 的失败不是代码或迁移缺陷，而是 **MySQL 方言 live schema 用例常态耗时 1.2–2.4s（CI 绿 1165/1810/1870ms），vitest 默认 5000ms 预算余量只有约 2.6x**，在 runner 侧往返延迟漂移时被击穿；修复方式只对该 job 的 3 个「清库 + DDL + information_schema 内省」型 MySQL live 用例显式给 30s 用例级预算，其余用例（含 SQLite / Postgres 全族）保持 vitest 默认值。

## 背景

- 失败 run：`36853446288`（fork `dorokuma/metapi`，commit `d068df11`，main）job `Schema Check (MySQL)` step `Run mysql schema upgrade`（exit 1），其后 `runtime schema bootstrap` / `live usage aggregation` / `live site sequence matrix` 全部 skipped。
- 关键日志（原样，已去掉 ANSI）：
  - `src/server/db/schemaUpgrade.live.test.ts (3 tests | 1 failed | 2 skipped) 5010ms`
  - `× schema upgrade parity > upgrades mysql to the current contract 5009ms`
  - `→ Test timed out in 5000ms.`
- 同一 job 在 `cdbcf3aa`（10:26Z）、`65a94f22`（11:55Z）success；三者之间的 `git diff` 只涉及 `scripts/dev/repo-drift-check.*`、docs、CHANGELOG、package.json version，**`git diff --stat cdbcf3aa 65a94f22 -- src/server/db/` 为空** ⇒ db / 迁移路径逐字节相同，失败与代码变更无关。
- **失败口径（两个口径都写死，避免以后各说各话被当反例）**：
  - **最近 20 次全体工作流 run**（`gh run list -R dorokuma/metapi --branch main --limit 20`）：**4 次失败、全部本类**（`CI` / `Schema Check (MySQL)` 的 5000ms 超时），即 `36853446288`、`36818636593`、`36814885884`、`36558933991`；其余 16 次（CI / CodeQL / Docs Pages）全绿，无其他失败类。
  - **最近 20 次 CI run**（同命令加 `--workflow CI`）：**6 次失败 = 5 次本类 5000ms 超时 + 1 次 Test Core 断言**。下列 ms 均为 CI 日志 `×` 行的用例级耗时：
    - 本类 5 次：`36853446288`（10-01）`schemaUpgrade.live.test.ts > upgrades mysql to the current contract` 5009ms；`36818636593`（10-01）同文件/用例 5010ms；`36814885884`（10-01）`schemaParity.live.test.ts > live schema parity > matches the contract for mysql` 5005ms；`36558933991`（09-29）同 `36814885884` 用例 5005ms；`36552006433`（09-29）同 `36853446288` 用例 5013ms。
    - 非本类 1 次：`36521552211`（09-29）Test Core `tokenRouterDumpRetentionService > falls back to tmpdir lock when rootDir is not provided`（`AssertionError: expected true to be false`），已由 `b45179a8`（`fix(token-router): eliminate clock-granularity flake in dump retention tests`）单独修，不属本类；20 次窗口外另有 1 次本类失败（`runtimeSchemaBootstrap.live.test.ts`，见下）。
- **基线耗时带（判断「是抖动还是真变慢」的参照，用例级 ms）**：绿 run `65a94f22`（run `36858447332`，MySQL job）= parity 1165ms / upgrade 1810ms / runtime 1870ms；本机（node v22.23.1，与 CI 的 22.15 不同版本、只作相对参考）按 `ci.yml` 同参起 `mysql:8.4` 复测 4 轮 = parity 1.5–1.7s / upgrade 2.6–2.7s / runtime 2.8–2.9s，本机读数随负载明显漂移（本次复测时 `load average` ≈29 / 12 核，本笔记「来源」节更空闲时的单轮记录为 1.2 / 2.1 / 2.4s），故本机数字只作相对参考。**复核方式**：不必重跑——看 CI 日志里该用例打印的 ms（如 `✓ live schema parity > matches the contract for mysql 1165ms`）与 job 是否仍绿；落在上述带内即抖动，持续显著更高才是真变慢。
- 耗时构成（绿 run 实测）：MySQL live 用例耗时全在**串行往返**上——`mysql.bootstrap.sql` 为 119 条语句（29 `CREATE TABLE` + 90 索引），upgrade 阶段再加一批 DDL，之后 `introspectLiveSchema` 再查 `information_schema`（表/列/索引/FK 分多次查询）；契约规模 29 表 / 90 索引 / 17 unique / 20 FK（baseline 12 表 / 33 索引）。CI 绿 run 五个 MySQL live 步骤：1165 / 1810 / 1870 / 1303 / 833 ms。
- 本机复现（`mysql:8.4` 容器，与 `ci.yml` 同 env/healthcheck，端口 3306）：同一用例 3 次 2057 / 1939 / 2229ms；`--testTimeout=1500` 时以 `Test timed out in 1500ms` 失败 ⇒ **CI 的失败签名 = 预算低于真实耗时**，与逻辑无关。
- 受控复现「预算被击穿」这一形态：把该用例的真实代码（HEAD 版本，默认 5s）打到「3307 → 3306、每方向 +12ms/块」的 TCP 代理上 → `× ... 5017ms → Test timed out in 5000ms`（与 CI 完全同形）；换成修复后的文件、同一代理 → 通过（8438ms）。**注入延迟是人为手段**，用途只是证明该用例对往返延迟敏感、且失败形态是预算而非断言。

## 决策

1. 只给 `schema-mysql` job 里 3 个「重建 schema + 内省」型 MySQL live 用例加**用例级**预算 `MYSQL_LIVE_SCHEMA_TIMEOUT_MS = 30_000`（vitest `it(name, fn, timeout)` 第三参数）：
   - `src/server/db/schemaUpgrade.live.test.ts`（最近 20 次 CI run 内 3 次同签名超时：`36853446288` 5009ms / `36818636593` 5010ms / `36552006433` 5013ms）
   - `src/server/db/schemaParity.live.test.ts`（最近 20 次 CI run 内 2 次同签名超时：`36814885884` 5005ms / `36558933991` 5005ms）
   - `src/server/db/runtimeSchemaBootstrap.live.test.ts`（形态/耗时同族，绿 run 1870ms；**同样有失败历史，只是落在上面 20 次窗口之外**：2026-09-28 run `36387260031`（commit `e37ab363`）`runtime schema bootstrap live upgrade path > upgrades mysql runtime schemas from an older live contract` `5009ms → Test timed out in 5000ms`）
   取值依据：常态 1.2–2.4s、已观测最长实际需求 > 5.0s；30s = 常态约 12–25x，远小于该 job 的 `timeout-minutes: 20`，仍然有界——真挂死会在 30s 以同一条 `Test timed out in 30000ms` 失败，不会被静默放过。
2. 其余用例一律不动：SQLite 全族（41–42ms）、Postgres 全族（377–453ms）、`usageAggregationService.live.test`（898ms）与 `databaseMigrationService.sequences.live.test`（547ms）继续用 vitest 默认 5000ms，保持「默认预算是常态、显式放宽是个案例外」的形态。
3. `ci.yml`、`vitest.config.ts`、任何生产代码、断言、job/step 结构均不改；不引入重试、不 `continue-on-error`、不 skip。

## 被放弃的方案（必填）

- **在 `vitest.config.ts` 全局设 `testTimeout`**：把全仓（含 web/desktop、其余 1000+ 用例）的失败发现时间一起从 5s 拉长，属于为了 3 个 DDL 型用例牺牲整体反馈速度，且掩盖真正的卡死。弃用原因：影响面与收益不成比例。
- **把 MySQL DDL 批量化 / 并发执行以降低耗时**：`applyMySqlStatements` 逐条串行正是被测语义（运行时迁移也是逐条串行），改批量需打开 `multipleStatements` 或并行 DDL，会改变被测行为（含 FK 依赖顺序），等于削弱测试。弃用原因：为迁就超时而改变断言与语义。
- **CI 侧对该 step 加有界重试**：retry 对「真实慢」有效，但会让 runner 冷启动类抖动被吞掉，且无法区分「慢」与「挂死」；本失败不是瞬时错误而是耗时分布问题，重试只是把概率问题推迟。弃用原因：掩盖 > 治根因；仅在确无代码可改时才作为最后手段。
- **把该用例 `it.skip` / `--exclude` / 放宽断言 / `continue-on-error`**：直接放弃 MySQL 与契约的对齐校验。弃用原因：掩盖真实回归风险。
- **把 `mysqlUpgrade` 的第三次参数写到 `describe` 或按文件配置**：范围明显大于需要，且 `describe` 级配置会把同文件其它方言用例一并放宽。

## 来源

- 失败与对比日志：`gh run view 36853446288 / 36858447332 / 36387260031 -R dorokuma/metapi --log`（fork；看失败签名用 `--log-failed`）。
- 失败清单口径：`gh run list -R dorokuma/metapi --branch main --limit 20`（全体工作流：4 次失败、全部同类）与 `... --limit 20 --workflow CI`（CI：6 次失败 = 5 次同类 + 1 次 Test Core 断言）。
- 代码：`src/server/db/schemaIntrospection.ts`（`applyContractFixtureThenUpgrade` / `materializeFreshSchema` / `introspectLiveSchema` / `resetMySqlSchema`）、三个 `.live.test.ts`、`package.json` 的 `test:schema:*`、`.github/workflows/ci.yml` 的 `schema-mysql`。
- 本机验证：`mysql:8.4` + `postgres:16` 容器按 `ci.yml` 同参起；三个 MySQL 步骤改后分别 1205ms / 2096ms / 2415ms 通过，Postgres 与 SQLite 全族照常通过，`npm run typecheck` exit 0，`npm run repo:drift-check` Violations: 0。
- 相关既有笔记：`.agents/notes/20260928-ci-gate-repair-decisions.md`（上一轮 CI 门禁修复，未覆盖本次超时）。
