---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "server, services, routes, docs" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# CI 唯一红项 `recovers immediately after lock holder is SIGKILLd` 的根因（flock 锁随「最后一个 fd」释放）+ pre-push `sk-` 存量夹具误伤清理

## 一句话结论

CI run `37098506495`（main `738b1b18`）唯一红项不是生产 bug：`/usr/bin/flock` 会 **fork** 它要运行的命令，flock 进程与 fork 出的 `sleep` 共享**同一个 open file description**（fd 3），而 flock(2) 锁挂在 file description 上 ⇒ 内核只在**最后一个 fd** 关闭时释放锁；测试只等直接子进程的 `exit`，于是「锁是否已释放」变成与 `sleep` 退出顺序的竞态。空闲机二者相差 ~1–2ms 且顺序对我们有利（稳过），负载下顺序翻转 ⇒ flaky。加固方式：在断言前**有界等待「锁已可获取」（内核前置条件）**，超时即失败；断言语义未削弱（mutation 自检见下）。

## 背景（取证链）

1. **CI 日志（attempt 1）**：`gh run view 37098506495 -R dorokuma/metapi --attempt 1 --log-failed`
   - 该用例两次 `retainTokenRouterDumps` 调用**都**打出 `[token-router-dump-retention] cleanup lock held by another process; skipping`（第一次预期如此，第二次即失败原因），随后 `:431 expected 0 to be greater than or equal to 1`；
   - 同提交 attempt 2 零代码改动通过 ⇒ 时序敏感，而非逻辑错误。
2. **进程/fd 取证**：`flock -x L -c 'echo LOCKED; sleep 60'` 实际进程树是 `flock(2379355) → sleep(2379359)`（dash 把尾命令 exec 掉，无中间 sh），`ls -l /proc/<pid>/fd` 与 `lsof L` 显示**两个进程都持有 fd 3 → 同一 file description**（lsof：flock `3rW`、sleep `3r`）。因此 `process.kill(-pgid,'SIGKILL')` 之后，锁要等**两个**进程都完成 `do_exit` 才释放，而 `child.once('exit')` 只表示 flock 进程已被 reap。
3. **量化**（`/tmp/probe1.mjs` 复刻用例时序，空闲 vs 40 个 spinner 负载）：
   - 空闲：`exit` 事件观测到时，fork 出的命令 **已**释放 fd（exit→子 fd 释放 = **-0.9 ~ -2.3ms**，即先于 exit），锁已可获取 ⇒ 老版本"擦边通过"；
   - 负载：`exit` 之后锁仍被占用 **3 ~ 135ms**，紧跟 `exit` 的首次尝试失败率 **1/30 ~ 4/30**。
4. **用例级复现**：把等待方式临时还原为加固前（mutation，已回滚），6 并发 × 4 轮 = 24 次运行中 12.5% 失败，其中该用例复现出**与 CI 完全相同的断言文本与 warn 行**。

## 决策

### 测试加固（`src/server/services/tokenRouterDumpRetentionService.test.ts`，仅测试代码）

- 新增辅助：`spawnLockHolder` / `waitForLockAcquisition` / `killLockHolder` / `waitForCondition` / `isLockFree`；两个持锁用例共用。
- 时序改为：SIGKILL 整个进程组 → 等直接子进程 `exit` → **`waitForCondition(() => isLockFree(lockPath), 5s)`（超时 throw）** → 再断言「加固后首调必须 `deletedExpired>=1`”。
- 关键点：gate 只等**内核状态**（锁可获取）这一前置条件，**不是**对服务调用的重试 ⇒ 服务侧一旦不取锁/取不到锁，断言仍会红（见下）。
- 该用例显式 `{ timeout: 30_000 }`（默认 5s 在重负载 runner 上会把诊断信息变成超时噪声）。
- 两个 flock 用例的派生 `sleep` 纳入 `beforeEach`/`afterAll` 的进程组回收，避免失败用例留下"持锁 fd"的残留进程影响后续用例；`killLockHolder` 对已 reaped 的子进程**提前返回**（`exitCode`/`signalCode` 非 null）——此时 pgid 可能被无关进程组复用，再 `kill(-pgid)` 会误杀无辜进程，而且已死的持锁者无需补救。

### mutation 自检（临时改动，均已在同一轮内回滚）

| 注入 | 结果 |
| --- | --- |
| `isLockFree` 恒 `false` | 该用例以 `timed out after 5000ms waiting for the kernel to release the flock ...` **失败**（gate 会大声失败，不会静默放行） |
| 服务 `acquireCleanupLock` 恒 `null` | 该用例以 `... 第一调用必须删目录 ...: expected 0 to be greater than or equal to 1` **失败**（7/10 红），断言语义未削弱 |

生产代码**零改动**（`tokenRouterDumpRetentionService.ts` 无 diff）。

## 被放弃的方案（必填）

- **只把「一次性检查」换成「轮询到 `deletedExpired>=1` 或超时」**：会把「服务调用失败」与「锁尚未释放」混为一谈，且等于允许第二次、第三次重试 ⇒ 掩盖"恢复必须是**立即**的"这一语义。改用「等锁释放 + 首调必须成功」。
- **等进程组 ESRCH（`kill(-pgid, 0)` 抛错）**：僵尸进程（fd 已释放但未被 reap）仍算组成员，在 pid 1 不 reap 的环境里会永远不归零 ⇒ 引入新的假失败；「锁可获取」是更直接且不依赖 reap 的判据。
- **改进生产代码**（如服务侧容忍瞬时占用、加锁超时接管）：定位表明服务行为正确（持锁者死亡即由内核释放、不做 stale-pid 猜测/超时接管），错的是测试假设（"直接子进程 exit ⇒ 锁已释放"）+ 等错事件。**不动生产语义。**
- **删用例 / 放宽断言 / 给用例加 `retry`**：禁止（削弱守护、掩盖真红）。

## 附带：pre-push `sk-` 存量夹具误伤（同分支顺手清理）

- **因果**：全局 pre-push（`/root/.git-hooks/pre-push`）对**每个待推提交的完整 diff（含 3 行上下文）**跑 `grep -qiE 'sk-[a-zA-Z0-9._-]{8,}'`，命中即 `PUSH REJECTED`；存量夹具里的占位值本身就命中该式，于是任何人改到这些行的 **±3 行**内都会被误判为"提交了密钥"（1.4.18 就是被同类夹具拦下的）。
- **本次已一次性换清**（仅字符串替换，断言与语义零改动）：
  - `src/server/routes/proxy/gemini.test.ts`：33 处「`sk-` + 语义后缀」占位值 → `managed-gemini-token`（旧值见本提交 diff，**此处不重抄**以免笔记自身命中同一正则）；
  - `src/server/routes/proxy/completions.siteApiEndpoint.test.ts`、`src/server/routes/proxy/embeddings.siteApiEndpoint.test.ts`：各 1 处同类占位值 → `downstream-token`；
  - 钩子正则对这 3 个文件**零命中**；三文件合计 41 用例全绿。
- **存量规模（遗留，建议另开一轮）**：本次清理后**实测**（口径见下）仍有 **53 个文件 / 268 匹配行**命中该正则；按目录分布 `src/server` 45 文件/233 行、`src/web` 6 文件/26 行、`docs` 2 文件/9 行（`downstreamApiKeys.test.ts`(26)、`accountTokens.sync.test.ts`(23)、`backupService.test.ts`(15)、`DownstreamKeys.test.tsx`(14)、`models.test.ts`(14) 居前，另含本次点名的 `completions.usage-source.test.ts:179`）。本次按任务指令只动被点名的 3 个文件（该 3 文件现实测 0 命中），其余未碰。
  - **统计方法与口径**（自己跑一遍可复现）：正则与 pre-push 第 43 行**完全一致**（`sk-[a-zA-Z0-9._-]{8,}`）；按**匹配行数**计（钩子是逐行 `grep -qiE`，命中行 = 会被误伤的行，故行数才是风险量）；范围为仓库工作树。
  - 主口径命令与结果：`rg -c --no-heading "sk-[a-zA-Z0-9._-]{8,}" -g '!node_modules' -g '!dist' | awk -F: '{f++; n+=$2} END {print "files="f, "lines="n}'` ⇒ `files=53 lines=268`（连跑两次一致；`rg -o … | wc -l` 亦为 268 ⇒ 每命中行恰好 1 处）。
  - 补充口径（仅 tracked，不受 `.gitignore` 过滤）：`git ls-files -z | xargs -0 rg -c …` ⇒ `files=57 lines=272`；多出的 4 文件/4 行为 `docs/plans/*.md`（`.gitignore:27 docs/plans/` 命中但已被跟踪）。两者差异说明完毕，之前笔记草稿里的 “50 文件/233 行” 是未实测的推算，已按实测订正。
- **以后新增夹具请用非 `sk-` 占位**（如 `<name>-token` / `test-key`），否则改到该行 ±3 行内即触发 pre-push 误伤。
  - 补充：把命中行**删掉**也仍会被旧钩子拦下（它扫的是 `git show` 全文，含 `-` 行与 3 行上下文）——本轮 diff 里就保留了被删的旧字面量，故推送前需确认新钩子只看新增行。

## 来源

- CI：`gh run view 37098506495 -R dorokuma/metapi --attempt 1 --log-failed`（Test Core 的 `Run tests`，`tokenRouterDumpRetentionService.test.ts:431`）。
- 代码：`src/server/services/tokenRouterDumpRetentionService.ts`（`acquireCleanupLock` 持有 fd 到 `closeSync(fd)` 为止，锁生存期与 fd 一致）、`src/server/services/tokenRouterDumpRetentionService.test.ts`。
- 一次性取证脚本（不入库，`/tmp`）：`probe1.mjs`（时序/失败率）、`probe2.mjs`（fd 释放次序）、`run-count.sh`（顺序重复）、`par-count.sh`（并发重复）。
- 验证统计（分支 `fix/flaky-dump-retention-lock-test`，随本提交一并入库）：
  - 目标文件顺序重复 **30/30** 通过；40 个 CPU spinner 负载下顺序重复 **12/12** 通过（同负载下加固前 mutation 会失败）；
  - `npm test -- --no-file-parallelism`：508 passed / 2 skipped（510 files）、3409 passed / 16 skipped（3425 tests）、exit 0、233.86s；
  - 加上 `killLockHolder` 的 pgid 复用守卫后**重验**：目标文件顺序重复 **12/12** 通过；`npm test -- --no-file-parallelism` exit 0、508 passed / 2 skipped、3409 passed / 16 skipped、243.21s；
  - `npm test`（CI 同款：默认文件并行，本机 12 核）也 exit 0：508 passed / 2 skipped、3409 passed / 16 skipped、56.66s；
  - `npm run typecheck:server` 通过（CI Typecheck 作业实际使用的 server 配置，其 `exclude` 含 `*.test.ts`，即服务端测试文件本就不在 CI 类型门禁内）；
  - 补充：`tsc -p tsconfig.json`（基座配置，非 CI 门禁）全仓**既有 480 个错误**；本次改动的 4 个文件中仅剩 3 条**既有**错误——retention 用例的 `(console as { warn: … }).warn = warnSpy` 强转（TS2352，HEAD 同源行第 241 行已存在）与 `gemini.test.ts` 的 1873/2248 两处（均不在本次改动的任何 hunk 行号内），无新增错误。
