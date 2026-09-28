---
status: active
superseded_by: ""
supersedes: ""
模块: "scripts, docs"
---

# 发版合并形态与第③条分支清理门禁的冲突

## 一句话结论

用 GitHub「rebase 合并」把 PR 并进 main，会产生与分支 tip **内容相同、SHA 不同**的新提交；
于是 AGENTS.md「发版与无痛上线」第③条的两项前置（分支 tip 是 `origin/main` 祖先、远端 SHA 等于
冻结值）对本次分支**同时不成立**，按红线远程分支不删，只回收 worktree 与本地分支并上报。

## 背景

1.4.8 的依赖修复在 `fix/prod-dep-audit` 上完成并开 PR #1（fork 首个 PR，同时验证
`pull_request` 触发）。分支与 `origin/main` 当时线性（领先 1、落后 0），但 PR 用的是 rebase
合并：main 得到 `98942bd0`，分支 tip 仍是 `2d0fcb39`——两者树内容逐字节相同（`git diff` 空），
父提交同为 `3ebf7b74`，是兄弟关系而非祖先关系。

## 决策

1. **上线**：唯一路径 `scripts/deploy-painless.sh --version 1.4.8 --yes`（旁路构建 → 只读快照 →
   canary → 改 compose `image:` → 验收），现役 `metapi:1.4.7` 全程在线，切换后 `restarts=0`。
2. **release 提交落在哪**：1.4.7 及更早的发版提交都直接落 main，本次沿用同一形态——把本地分支
   rebase 到 `origin/main`（patch 等值的重复提交被自动丢弃）后加 `chore(release): 1.4.8`，
   再 `git push origin HEAD:main`（显式 origin，纯 ff：`98942bd0..6d7bc461`）。
3. **清理只做能过前置的部分**：回收 worktree → 删本地分支（tip 已是 `origin/main` 祖先）。
   远程分支**不删**：远端 tip `2d0fcb39` 既不等于冻结值 `6d7bc461`，也不是 `origin/main`
   的祖先，两项前置均不成立；按「对不上就放弃并报告」处理，交人工决定。
4. **判定依据写死在流程里**：删除前先 `git fetch origin`，再 `git merge-base --is-ancestor`；
   远端删除只拿冻结值比对 `git ls-remote`，不用「内容看起来一样」代替 SHA 校验。

## 被放弃的方案（必填）

- **`gh pr merge --merge` / `--squash`**：弃用原因：前者引入 merge commit，后者压缩历史，
  都与本仓库线性、逐提交可追溯的历史形态不一致。
- **`git push origin fix/prod-dep-audit:main` 直推分支**：弃用原因：不可行——main 已被 rebase
  合并推进到 `98942bd0`，分支 tip 是其兄弟提交，非 ff 会被拒（红线禁 force）。
- **用 `git branch -D` / 强制删远程分支来「收干净」**：弃用原因：红线明令只用 `-d` 与
  `worktree remove`，且 SHA 前置不成立时正确动作是停下上报而非绕过校验。
- **把 `chore(release)` 单独开 PR**：弃用原因：发版提交直接落 main 是本仓库既有形态，
  为发版号开 PR 只会增加一次无内容的往返。

## 来源

- 本次会话（eqi12，worktree `metapi-dep-audit`，分支 `fix/prod-dep-audit`）
- PR #1（`dorokuma/metapi`，rebase 合并 → `98942bd0`）；发版提交 `6d7bc461`
- 生产验收：`/api/stats/dashboard` 200、`/v1/models` 200、`/assets/*.js` 缓存头
  `public, max-age=31536000, immutable`、`index.html` `no-cache`、切换后 8 分钟 164 次
  `/v1/chat/completions` 200
- AGENTS.md「发版与无痛上线」节「脚本跑完还要做的」第③条
