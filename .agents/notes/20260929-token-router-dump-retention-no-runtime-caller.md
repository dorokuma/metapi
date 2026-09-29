---
status: active
superseded_by: ""
supersedes: ""
模块: server
---

# token 路由 dump 保留清理当前无生产调用方

## 一句话结论

`retainTokenRouterDumps`（`src/server/services/tokenRouterDumpRetentionService.ts`）目前**只在测试/CI 中被调用**，生产运行路径上没有调用点：该清理路径在线上不可达，因此 `adfaf9c3` 引入的 flock(2) 锁修复无法用生产真实流量复现验证，只能做测试级与隔离级验证；生产侧可验证的仅是「代码在镜像内 + `/usr/bin/flock` 存在」。

## 背景

2026-09-29 发版收尾（metapi:1.4.11 重建重切后）执行「按本次改动做真实流量验证」时核验到以下事实（均可复现）：

1. `rg -n "retainTokenRouterDumps" -g '!node_modules' -g '!dist' .`：仅命中该服务自身与其测试文件；`src/server/services/tokenRouter.selection.test.ts` 通过动态 `import` 调用它做测试临时目录清理。
2. `git log --all --oneline -S "retainTokenRouterDumps("`：历史上从未出现过生产调用点（命中的提交都是测试与笔记）。
3. 生产代码中 `tmpdir()` 的使用者只有 `src/server/db/index.ts`（vitest worker 的库路径）与本服务自身；`metapi-token-router-` 前缀常量也只存在于本服务，未见生产侧写入该前缀临时目录的一方。
4. 运行实例侧：容器内 `/tmp` 无 dump 目录、无 `.metapi-token-router-dump-retention.lock`；`docker logs metapi` 中 `[token-router-dump-retention]` 计数为 0（该服务仅在异常/降级分支打 warn，0 表示无释放失败与降级跳过）。

即：dump 保留策略被抽取成纯函数（`83f3714c`）后，清理入口只由测试触发；生产中既没有写入 `metapi-token-router-*` 临时目录的一方，也没有触发清理的一方。

## 决策

记录该现状，不在发版收尾中改动主链路接线：

- 锁修复（任务 A）的生产验证口径：以单元/集成测试（目标用例 10/10、5 连稳）与隔离 flock 语义证明为准；生产侧只验证镜像内容与 `/usr/bin/flock` 存在。
- 若将来把该 retention 接入生产运行路径（例如由 dump 写入方在写完目录后调用，或由启动/定时任务调用），必须重新按真实流量验证三项：双清理窗口不再出现、持锁进程 SIGKILL 后锁即时可恢复、非 Linux / 缺 `flock` 时 fail-closed 跳过。
- 本次不接线：属功能/行为变更而非锁修复，需独立设计与审查。

## 被放弃的方案（必填）

- **直接在本次发版收尾里接上调用方**（如在 token 路由主链路或启动任务中调用 `retainTokenRouterDumps`）：放弃原因是这属于功能/行为变更，会改变生产运行时行为并需要独立双审；本次任务是修锁，不得借机扩范围。
- **不记录这条现状**：放弃原因是它直接影响后续「本次改动需真实流量验证」的判断——不写下来，下一个 agent 会在生产里反复找不到触发路径。

## 来源

- 2026-09-29 发版收尾核验（主代理只读命令）：`rg` / `git log -S` / `docker exec metapi ls -la /tmp` / `docker logs metapi | grep -c '[token-router-dump-retention]'`。
- 相关提交：`83f3714c`（抽取纯函数）、`adfaf9c3`（flock fd 锁）、`81abc1fa`（chore(release): 1.4.11）。
- 相关记录：`.agents/notes/20260929-token-router-dump-lock-takeover.md`（锁方案与遗留清单）。
