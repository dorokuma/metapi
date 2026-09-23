---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "transformers" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# openai chat 流式 usage 丢帧：终态 choices:[] usage chunk 补发

## 一句话结论

`stream_options.include_usage` 之前只被解析、没有传进流式会话，usage 在 4 个丢弃点被吞掉；现在把该布尔值一路传到流上下文，并在 `[DONE]` 之前补一条 `choices: []` 的终态 usage chunk（仅 `include_usage=true` 时），失败/空内容流永不补帧。

## 背景

- 现象：Pi 侧（走 openai chat surface 的流式请求）拿不到 usage，guardian footer 的 `▸ TPS` 显示 `n/a`（`pi-cache-guardian` 在 assistant 消息缺 `usage` 时即判 n/a）。
- 链路：`chatSurface.ts` → `proxyStream` → `streamBridge` → `chatFormatsCore`。
- 根因：`openai/chat/helpers.ts` 把 `stream_options.include_usage` 解析成了 `streamOptionsIncludeUsage`，但该值没有进入 `StreamTransformContext`；同时
  1. `StreamTransformContext` 无 usage 字段；
  2. `serializeStreamDone` 的 openai 分支只发 `[DONE]`；
  3. `streamBridge` 只在中间帧贴回 usage，upstream 只带 usage 的 `choices: []` 帧（`parsedEvents<=0`）被丢；
  4. `proxyStream` 的 session 入参没有 `includeUsage`。
- 上游/客户端的 usage 携带方式并不统一：部分 upstream 在每帧附带 usage，部分只在收尾的 `choices: []` 帧给出。后者在旧实现下等于彻底丢光。

## 决策

- 改动范围（commit `a21e8d5`，分支 `fix/stream-usage-chunk`，父 `1517355`，6 files +457/-4）：
  - `transformers/shared/chatFormatsCore.ts`：context 增加 usage 字段 + `serializeStreamDone` 的 openai 分支在 `[DONE]` 前补 `choices: []` usage chunk；
  - `transformers/openai/chat/streamBridge.ts`：记住最后一条确凿 usage（覆盖，不累加）；
  - `transformers/openai/chat/proxyStream.ts`：接收 `includeUsage`，JSON fallback 记 usage，`markFailed` 内同步置 `includeUsage = false`（与 `finalize` 的抑制互为备份，锁住「失败流不得补 usage」这个不变量，不依赖 return 时序）；
  - `proxy-core/surfaces/chatSurface.ts`：仅在 openai chat 且 `include_usage=true` 时下传布尔值（计费路径独立，不受影响）。
  - 测试：`streamBridge.test.ts` 补用例 + 新增 `proxyStream.test.ts`（含「空内容失败 + 已捕获 usage → 不得补 usage」）。
- 发布策略：中间帧 usage 保留 + 终态再补一条（不改既有中间帧行为，避免下游解析器回归）。
- 镜像与切换：
  - 新增 tag `metapi:local-usage-fix`（**不覆盖**线上 `metapi:local-oauth-off`），并预打回滚 tag `metapi:local-oauth-off-rollback-20260923`（= `sha256:3382d5ed6cb7`）。
  - 切换方式（本次为有意偏离原 plan）：容器被中断的流程删除 + 主机重启后已完全不存在，故改用声明式来源 `/var/lib/metapi/docker-compose.yml` 把 `image:` 改为 `metapi:local-usage-fix` 后 `docker compose up -d`；除镜像外参数与原容器一致（host 网络、`127.0.0.1:4000`、`/var/lib/metapi/data:/app/data`、`env_file` 不变、`restart: unless-stopped`、json-file 日志限流），并因此获得重启自愈能力。backup：`docker-compose.yml.bak-20260923-160929-pre-usage-fix`。
  - 回滚：把 `image:` 改回 `metapi:local-oauth-off-rollback-20260923`（或恢复上述 backup）后 `docker compose up -d`。

## 踩坑（本次实操必须记住的三条）

1. **镜像 ≠ commit 不能靠时间猜**：Stage 1 曾用同名 tag 先构建过一版镜像（补丁尚未落地）。最终验证方式是在镜像内取证：候选镜像 `dist/` 中 `includeUsage` 命中 6 个补丁产物共 10 处，旧镜像 **0 处**（阴性对照）。生产切换前必须做这个 A/B。
2. **canary 判据不能只看「有没有 usage」**：upstream 常在中间帧就带 usage，只统计「带 usage 的帧」会把旧镜像判成通过（本次首轮 canary 就误判 PASS）。正确判据 = 是否存在 `choices: []` 且 `completion_tokens > 0` 的终态 chunk，且它出现在 `[DONE]` 之前；并补一条「不带 include_usage 时不得出现该终态 chunk」的负向门。
3. **metapi 不在 systemd 里，重启不会自愈**：它是 `/var/lib/metapi/` 的 compose 栈，容器一旦被删除，主机重启后不会回来（dangling 时 `sync-metapi-models.py` 会刷 `Connection refused`，`metapi-sync-watchdog.sh` 再告警）。救活方式就是 `cd /var/lib/metapi && docker compose up -d`。Docker 与 prism 均为 enabled，因此改由 compose 托管后重启可自动恢复。

## 被放弃的方案（必填）

- **不覆盖线上 tag**：直接重建 `metapi:local-oauth-off` 会失去回滚点；改为新 tag + 独立回滚 tag。
- **全流只发一次 usage**：更贴近「一份数据一份帧」，但会改变既有中间帧行为、可能打到已有下游解析器；改为保留中间帧 + 终态补一条。
- **在 upstream 帧到达处就地 synthesize**：曾考虑在 `streamBridge` 内直接补帧，但终态帧必须发生在 `[DONE]` 之前且与失败抑制同源，故统一放在 `serializeStreamDone`（单一出口）。
- **手动 `docker run` 复刻容器参数**：原 plan 要求如此（避免 compose 影响），但容器已不存在、主机刚重启，手抄参数不可验证；改用同参数的 compose 声明 + 文件级备份，偏离已在上一节记录。
- **只靠 `docker inspect` 确认镜像来源**：inspect 只给 ID/时间，无法证明「镜像就是这条 commit」，故改为镜像内 `dist` 取证 + 行为 canary 双证。

## 来源

- commit `a21e8d5`（`fix(openai-chat): emit terminal usage chunk when stream include_usage is set`），分支 `fix/stream-usage-chunk`；双审 + 应修补丁已过。
- 编排会话：`/root/.pi/agent/sessions/--root--/2026-09-22T14-50-08-277Z_01a0c998-...jsonl`（planner plan → 主代理逐条审 → Stage 1 → 双审 → 补丁 → commit → Stage 2 被打断）。
- 镜像：`metapi:local-usage-fix` = `sha256:2184c8e882b4a210611cea80798db4fcbad4af732a03e7d41a79d97ef972dc26`（built 2026-09-23 15:55:31）；旧 `metapi:local-oauth-off` = `sha256:3382d5ed6cb7`。
- canary 证据（2026-09-23 换前 A/B/C）：4000 旧镜像 + `include_usage=true` → 终态 chunk 0 条（复现 bug）；14001 候选 + `include_usage=true` → 1 条（`completion_tokens=24`，位于 `[DONE]` 前）；候选不带 `include_usage` → 0 条。换后同一组在 4000 复测一致，非流式 usage 与 `/v1/models`、同步脚本 dry-run 无回归。
- 打断溯源：dockerd 日志 2026-09-23 15:56 创建 `metapi-usage-fix-dryrun2`、15:58:08 停止容器 `26de8972`，16:00:20 daemon 优雅退出并重启。
