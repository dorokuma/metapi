---
status: active
superseded_by: ""
supersedes: "20260929-token-router-dump-lock-takeover.md"
模块: server
---

# Token Router Dump Retention Lock — flock fd 内核锁方案

## 一句话结论

**废弃**伪 CAS/unlink/rename 陈旧锁接管方案，改用同步内核 `flock(2)` 锁：
Node `fs.openSync(lockPath,'a+')` 持 fd → `child_process.spawnSync('/usr/bin/flock',['-x','-n','3'],{stdio:['ignore','ignore','pipe',fd]})` 尝试排他锁 → 成功才进同步清理流程 → `finally` 关闭 fd 释放。崩溃恢复靠内核：进程 SIGKILL 后内核同步关闭所有 fd，锁即时可获取，无需陈旧判定、无需 pid 轮询、无需超时等待。活进程持有 fd 再久都不抢占；锁文件永久保留，获取与释放都 **不 unlink**（避免 split-inode）。

## 背景

`src/server/services/tokenRouterDumpRetentionService.ts` 使用全局单例锁防止并发清理。旧方案（伪 CAS/unlink/rename）存在以下问题：
1. 锁文件内容含 pid+timestamp，需陈旧判定（>10 分钟或 pid 不存在）才可接管；
2. 陈旧锁判定依赖 `process.kill(pid,0)`，在容器/权限变化场景下不可靠；
3. 进程被 SIGKILL/OOM 打断后残留锁文件，需等 10 分钟超时才可恢复；
4. CAS 重校验 + rename 微秒级交错窗口内可能双赢，导致双清理；
5. 锁释放时 inode+内容所有权校验代码复杂，维护负担高。

## 决策

### 新锁方案（flock fd 内核锁）

1. **锁路径**：由 `options.rootDir ?? tmpdir()` 派生，默认 `join(tmpdir(), '.metapi-token-router-dump-retention.lock')`；`deps.lockPath` 可覆盖。保留 main 版 `rootDir` 语义，测试用私有根隔离。

2. **获取流程**：
   ```
   fd = openSync(lockPath, 'a+')        // 持 fd
   spawnSync('/usr/bin/flock', ['-x','-n','3'], {stdio:['ignore','ignore','pipe',fd]})
   // status==0 → 获取成功 → ftruncateSync(fd,0) → 写入 `${pid}\t${now()}\n` 供诊断
   // status!=0 → 另一进程持锁 → warn + skip
   // error   → flock 不可用 → warn + skip
   ```

3. **释放流程**：`finally { closeSync(fd) }` — 内核同步关闭 fd → 锁即时释放。**不 unlink 锁文件**。

4. **非 Linux / 无 flock 二进制**：`spawnSync` 返回 error 或 `/usr/bin/flock` 不存在 → warn + skip cleanup（fail-closed，绝不回退 CAS）。

5. **跨平台说明**：互斥与崩溃恢复依赖 flock(2) 的 open file description 语义；生产与 CI 均为 Linux（已验证）。其它平台若缺 `/usr/bin/flock` 或语义不符，一律 fail-closed（warn + 跳过清理），不回退不可靠方案。

6. **SIGKILL 恢复**：Linux 父进程被 SIGKILL 时处于用户态（Node.js 事件循环），不进入 D-state；内核同步关闭所有 fd → 锁即时释放 → 新请求立刻成功（phaseB 证明，见证据文件）。

7. **inode 一致性校验**：flock 成功后，比对 `fstatSync(fd).ino` 与 `statSync(lockPath).ino`；不一致 → fail-closed + warn + closeSync(fd) + return null（不重试）。防止 open 与 flock 之间锁文件被外部替换导致锁住孤儿 inode。

### Deps 接口变更

- **新增**：`lockPath`、`now` 可注入（main 版已有 `rootDir` 选项，保留）。
- **废弃**：`isProcessAlive` 不再使用（旧方案 pid 轮询用）。
- **公共接口**：`retainTokenRouterDumps(options, deps)` 签名与返回 `{deletedExpired, deletedExcess, remaining}` 不变。

## 隔离验证（/tmp/retention-lock-evidence/）

详见 `flock-fd-proof.txt`：

| 步骤 | 操作 | 结果 |
|------|------|------|
| 1 | 父 openSync + fstatSync | PASS — fd 存活 |
| 2 | 父 closeSync + 重新 open | PASS — 立即可访问 |
| 3a | fork 子进程持 fd，父 socketpair 发信号 | phaseA_acquired=true（BSD 继承锁） |
| 3b | 父 process.kill(-pid,'SIGKILL') 杀整棵进程组 | phaseB_acquired=true — 父死后锁立即可获取 |
| 3c | watcher parentAliveAfterWait=false | 父进程已退出 |

**核心恢复证据**：`phaseB_acquired = true` 证明内核在父进程 SIGKILL 后同步关闭 fd 并释放锁，无需陈旧锁超时。

## 测试调整

| 测试 | 变更 |
|------|------|
| does not delete matching dirs when under maxCount | 不变 |
| deletes expired directories when TTL is 0 | 不变 |
| deletes oldest directories when over maxCount | 不变 |
| ignores directories that do not match the prefix | 不变 |
| is fault-tolerant when stat fails | 不变 |
| **warns and skips when another process holds an exclusive lock** | **重写**：spawn 独立 flock -x 子进程，断言 service skip + warn |
| falls back to tmpdir lock when rootDir is not provided | 不变（main 版新增） |
| warns on rmSync failure | 不变 |
| **writes pid/timestamp into lock file during cleanup** | **新增**：断言内容含 `deps.now()` 写入值 |
| **recovers immediately after lock holder is SIGKILLd** | **新增**：spawn detached flock 子进程 → 第一次调用 skip → SIGKILL 整棵进程组 → 第二次调用成功清理 |

## 被放弃的方案

- **保留伪 CAS + 陈旧锁接管**  
  放弃原因：需陈旧判定（10 分钟超时）、pid 轮询、CAS 重校验微窗口双赢风险，崩溃恢复有等待；flock fd 方案内核原生解决全部问题。

- **保留 unlink 释放锁文件**  
  放弃原因：unlink 时若 fd 仍被其他进程继承，产生 split-inode（新锁文件 vs 旧 fd 持旧 inode）；fd 关闭时内核自动释放锁，无需 unlink。

- **pid/时间戳抢占活跃锁**  
  放弃原因：违反"活进程不抢占"铁律；flock fd 方案保证 fd 持有者存活则锁不释放，无法被内容判据抢占。

## 遗留清单

1. **非 Linux 平台 flock 可用性**：macOS/Windows 无 flock 或行为不同 → fail-closed + warn（已实现）。
2. **flock 二进制路径**：硬编码 `/usr/bin/flock`；自定义容器需确保该路径存在。
3. **D-state 极低概率**：/tmp (tmpfs) 上 sync fs syscall 偶发 D-state，子进程 SIGKILL 不即时。生产侧为父进程被 SIGKILL（用户态），不触发 D-state。测试侧用纯 CPU 自旋子进程规避。
4. **SIGKILL 测试依赖 `/usr/bin/flock`**：若 CI 环境无 flock，该测试跳过（已有隔离验证证明）。
5. **锁文件诊断内容非权威**：内容仅用于运维观察，锁获取基于 fd；不要依内容做抢占判定。
6. **rootDir 派生锁路径**：锁路径现在跟随 `options.rootDir`（测试用私有根），不再硬编码 `/tmp`；生产默认仍落在 `tmpdir()`。
7. **外部替换锁文件造成短暂双持窗口**：flock 无法防止第三方在 open 与 flock 之间 unlink/替换锁文件（已通过 inode 一致性校验缓解：若 inode 不匹配则 fail-closed）。本体承诺从不 unlink 锁文件、诊断写入刷新 mtime，降低被外部替换的概率。

8. **测试子进程清理加固**（reviewer）：两处真实 flock 子进程用例的 SIGKILL 清理位于末尾，若中间断言失败可能留置后台 sleep 1000；后续可用 try ... finally 包裹清理。
9. **时间戳注入一致性**（reviewer）：retainTokenRouterDumps 内沿用 main 的 const nowMs = Date.now()，与 deps.now（现仅用于锁诊断写入）并存；若未来需要整体冻结时间可统一。
10. **warn 断言风格统一**（reviewer）：一处手写 console.warn 替换与同文件 vi.spyOn 风格不一致，后续统一。
11. **发版要点**（oracle）：确认目标镜像含 /usr/bin/flock（缺失即 fail-closed 跳过清理）；发版时按脚本第 5 条验证存量裁剪（快照留 7、镜像留当前版本）。

## 来源

- 隔离验证：`/tmp/retention-lock-evidence/flock-fd-proof.txt`、`watcher-result.json`
- 代码：`src/server/services/tokenRouterDumpRetentionService.ts`
- 测试：`src/server/services/tokenRouterDumpRetentionService.test.ts`
- 项目约束：`AGENTS.md`（构建/测试/提交规范）
