---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "scripts" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 发布收尾「先回收 worktree」使执行者丧失工作目录（cwd 陷阱）

## 一句话结论

发布收尾第③步「先回收 worktree」会删掉执行者（agent）当前所在的目录；此后该执行器 spawn 任何进程都报 `fork/exec /bin/sh: no such file or directory`（每命令独立 shell、从执行器进程自身 cwd 启动，cwd 已被删 → ENOENT），重试无效。回收 worktree 之后的步骤（删本地分支、删远端分支）必须由「不在该 worktree 内」的执行者执行。

## 背景

- 场景：按 AGENTS.md「发版与无痛上线 → 发布收尾」第③条执行分支清理，顺序写死为「先回收 worktree → 再删本地分支 → 最后删远程分支」。
- 现象：执行该流程的 agent 正运行在这个 worktree 里。`git worktree remove` 回收成功后，其执行器再 spawn 任何命令（`/bin/sh -c ...`）全部报 `fork/exec /bin/sh: no such file or directory`。
- 重试 8+ 次无效——不是偶发，是确定性失败；只读类工具（走独立执行路径、不依赖进程 cwd）不受影响，表现为「只有要跑命令的工具全挂」。

## 根因

- 每个命令都由执行器独立 spawn 一个 `/bin/sh`，并从**执行器进程自身的 cwd** 启动。worktree 回收删除的正是执行器所在目录，cwd 变成 ENOENT，于是每次 spawn 都在 fork 阶段失败。
- 工具模式下 `cd` 不跨命令持久（每条命令独立 shell），执行者无法靠「先 `cd` 到别处」自救。

## 决策 / 正确做法

- **回收 worktree 之后的步骤必须由「不在该 worktree 内」的执行者执行**（例如从主 checkout 启动）。回收这一步本身可以在 worktree 内做（做完即死无妨），但它的后续（删本地分支、删远端分支）不能由同一个已死 cwd 的执行者继续。
- **任务设计时把「回收 worktree」之前的操作与之后的操作分派给不同执行者**；或（若执行器支持持久 cwd）在回收前先迁出 cwd。工具模式下 `cd` 不可持久时，唯一可靠解法就是分执行者。
- 处置记录：本次由从主 checkout 启动的第二执行者完成剩余两步（删本地分支 + 删远端分支），两步均含 SHA 校验、零强制（`git branch -d` / `git worktree remove`，无 `-D` / `--force` / `rm -rf`）。

## 被放弃的方案（必填）

- **同一执行者回收后继续做清理**（最直觉）：cwd 已删，spawn 确定性失败，无解（工具模式 `cd` 不可持久）。
- **回收前先 `cd` 到别处自救**：工具模式下 `cd` 不跨命令持久，每条命令仍从已删的 cwd spawn，无效。
- **换顺序：先删分支再回收 worktree**：该分支正被此 worktree 检出，`git branch -d` 会因「被检出」而拒绝；且顺序本身是发布收尾流程写死的（回收 → 删本地 → 删远程），不能靠换顺序绕过——正确解法是换执行者。

## 来源

- 触发流程：AGENTS.md「发版与无痛上线 → 发布收尾」第③条（回收 worktree → 删本地分支 → 删远程分支，顺序写死）
- 错误现象：`fork/exec /bin/sh: no such file or directory`（执行器进程 cwd 已被 `git worktree remove` 删除，spawn 阶段 ENOENT）
- 处置：主 checkout 启动的第二执行者完成删本地分支 + 删远端分支（均含 `git merge-base --is-ancestor` / `git ls-remote` SHA 校验，零强制）
