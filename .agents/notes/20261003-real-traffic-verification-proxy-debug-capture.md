---
status: active
superseded_by: ""
supersedes: ""
模块: "proxy-core, docs" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 发版「真实流量验证」配方：用代理调试抓取核对上游出站请求体

## 一句话结论

发版 SOP 的「真实流量验证」在默认 `proxy_debug_capture_bodies=false` 下**没有现成的上游出站体读取通路**；可复用配方是：经用户批准后临时把代理调试抓取开到仅覆盖本次唯一 session（`proxy_debug_trace_enabled=true` + `proxy_debug_capture_bodies=true` + `proxy_debug_target_session_id=<本次唯一值>`），发最小真请求后读 `proxy_debug_attempts.request_body_json` 核对出站体，验证完**立即回写执行前记录的原值，并按唯一 session 精确删除本次抓取产物**（该 session 残留 0 行、两表无越界新行、`count(*)` 回落）。

## 背景

- 触发场景：1.4.20 的改动是 reasoning_effort 的 xhigh 归一与透传（canonical 联合类型接受 `xhigh`，`normalizeReasoningEffort` 不再丢弃，OpenAI chat/responses 链路出站回写 `body.reasoning_effort`；范围边界见 `.agents/notes/20260928-reasoning-effort-xhigh-scope.md`）。单测只能证明 canonical 层保留该值，**证明不了 OpenAI 形态上游收到的出站体真的带着 `"reasoning_effort": "xhigh"`**——这正是 SOP 要求上线后跑真实流量验证的原因。
- 通路缺口：默认配置下调试抓取整体关闭（`config.ts`：`proxyDebugTraceEnabled=false` / `proxyDebugCaptureBodies=false` / `proxyDebugCaptureStreamChunks=false`，headers 默认 true，三个 target 均为空串，retention 24h，max_body_bytes 262144）。即使只开 trace 也只落结构/决策列；`hub.db` 里没有任何别的表常态化保存上游出站请求体 ⇒ **默认设置下出站体无通路可读**，只能临时开调试抓取。

## 决策

可复用配方（第 1 步只读确认；第 2 步起是生产写操作，**须先经用户批准**）：

1. **通路与字段（只读确认，先弄清「读哪里」）**：
   - `settings`（key/value）里的调试抓取键：`proxy_debug_trace_enabled` / `proxy_debug_capture_bodies` / `proxy_debug_capture_headers` / `proxy_debug_capture_stream_chunks` / `proxy_debug_target_session_id` / `proxy_debug_target_client_kind` / `proxy_debug_target_model` / `proxy_debug_retention_hours` / `proxy_debug_max_body_bytes`（默认值见 `src/server/config.ts`；校验与热生效见 `src/server/routes/api/settings.ts` 的 `proxy_debug_*` case 与 `src/server/runtimeSettingsHydration.ts`，改设置不需要重启）。
   - 抓取落两张表：`proxy_debug_traces`（一次下游请求一行）与 `proxy_debug_attempts`（**每跳上游一行**，`trace_id + attempt_index` 唯一）。**要核对的上游出站体在 attempt 行的 `request_body_json`**；traces 行的 `request_body_json` 是**下游入站体**（且仅 `capture_bodies=true` 时才写），别读错表。
   - 已知坑（看数前先知道）：四条 headers 列的入口统一做敏感头掩码（`proxyDebugTraceStore.ts` 的 `serializeHeaders`，值替换为固定占位、保留头名）——**只有这四列掩码，body 各列不掩码**；body/headers 超过 `max_body_bytes` 时不落原文而是写 `__metapiTruncated` 预览对象，核对长体先看有没有这个标记；流式响应的 `response_body_json` 不落（`isStream` 直接返回 null），但**出站请求体不受影响**。
2. **临时开启（生产写操作，须用户批准）**：只改必要的值——`proxy_debug_trace_enabled=true`、`proxy_debug_capture_bodies=true`、`proxy_debug_target_session_id=<本次唯一值>`；`proxy_debug_target_client_kind` / `proxy_debug_target_model` / `proxy_debug_retention_hours` / `proxy_debug_max_body_bytes` 一律不动。收窄到唯一 session 的目的是让捕获面恰好等于本次验证请求。
   - **唯一值防撞**：session 值带随机后缀，形如 `<用途>-<YYYYMMDD-HHMMSS>-<4位随机>`。只按日期/用途取名可能与历史真实 session id 撞名，撞名会误删他人抓取行。
   - **headers 可顺手收窄**：本次验证只要出站体、不需要 headers，可把 `proxy_debug_capture_headers` 一并置 `false`（默认 `true`）进一步缩小暴露面；置过就要把它也记进原值、一并恢复。
3. **发最小真请求**：`POST /v1/chat/completions`，带 `session_id` 头（值 = 第 2 步的唯一值），挑便宜小模型，`max_tokens` 取 512 一档。
   - 收窄为何生效：`isCodexPath` 含 `/v1/chat/completions`，`getCodexSessionId` 认 `session_id` / `session-id` / `conversation_id` / `conversation-id` 头 ⇒ 该请求被识别为 codex profile 且 `clientContext.sessionId` 等于该头值，`shouldTraceProxyDebugRequest` 才放行（不带头则 sessionId 为空、与 target 不匹配，整条不会被捕获）。
   - **陷阱：`max_tokens` 太小会被 xhigh 推理预算吃光**——上游拿到「空 content」判失败回 500，且回退跳同样失败，看起来像改动回归。本次实测 `max_tokens=16` 失败、`max_tokens=512` 成功（200，`id=chatcmpl-meta-1791039889148`）。
4. **核对（含数据纪律）**：按该 session 定点取列读 `proxy_debug_attempts.request_body_json`，确认**出站体**含 `"reasoning_effort": "xhigh"`；有回退跳/多 attempt 时逐跳看（本次要证的是 OpenAI 形态上游那一跳）。
   - **出站体不掩码**：`request_body_json` 与各 response body 列**原样落库、没有掩码**（经 `serializeHeaders` 掩码的只有第 1 步列的那四条 headers 列）⇒ 读出内容一律按敏感数据处理。
   - **读出数据不外溢**：核对结果不得落盘、不得回传、不得写进 commit/PR/工单/日志文件；报告只贴最小必要片段（能证明字段存在的一个键值/一行足矣）。
   - **查询只取需要的列**：按 `session_id` / `trace_id` 定点取列；禁 `SELECT *` 把整行贴回。
   - **`docker logs` 只做计数/存在性判断**：启动横幅与运行日志含明文 token（仓库密钥红线），不贴原文，只用 `grep -c` 一类手段做计数/存在性判断。
5. **恢复与清理**：
   - **先记原值再改**：执行前先记录要动的每个键的当前值；恢复时**回写记录到的原值**，不要写死 `false`/`false`/空串——现场若原本就开着别的值，写死即改坏他人配置（若按上面顺手收了窄 headers，则连同它一起记、一起恢复）。
   - **删前先记基线**：执行前记录 `proxy_debug_traces` / `proxy_debug_attempts` 两表的 `count(*)` 与 `max(id)`；清理按唯一 session 精确删。
   - **清理判据（三条同时满足）**：① 按该唯一 session 计数为 0；② 两表均无 `id >` 删前 `max(id)` 的行；③ 两表 `count(*)` 回落到删前记录值。基线是空表时 `max(id)` 为 NULL——**只看 `max(id)` 发现不了「中间行被误删」**，故 ① ③ 不可省。
   - **级联依赖 FK**：运行时会开 FK（`src/server/db/index.ts` 有 `sqlite.pragma('foreign_keys = ON')`），删 traces 行级联删 attempts 有效；但 **sqlite3 CLI 默认不开 FK**，手工清理须先 `PRAGMA foreign_keys = ON;`，或显式按 `trace_id` 先删 attempts 再删 traces，且两表分别核验。
   - 抓取是临时的，不长开。
6. **记账行不清理**：两条真请求（一条失败、一条成功）会在 `proxy_logs` / `upstream_provider_observations` 留常规记账行，这是代理正常路径的产物，属预期、不清理。

## 被放弃的方案（必填）

- **跳过真实流量验证**：违发版 SOP（「脚本跑完还要做的」第①条）；单测只覆盖 canonical 归一与透传赋值，证明不了上游出站体形状。否决。
- **开抓取但不收窄（不设 `target_session_id`）**：会捕获窗口内全部生产流量的请求体，把无关客户端的出站体写进调试库（headers 列有掩码、body 列没有），扩大敏感暴露面；清理面也从「一个 session」变成「全表按时间猜」。否决。
- **用极小 `max_tokens` 做端到端判定**：xhigh 推理预算吃光 `max_tokens` 后上游以空内容 500、回退跳同样失败，会把「预算不足」误判成「改动回归」（本次 16 失败 / 512 成功即此陷阱）。否决。
- **从 `hub.db` 现有表里直接找上游出站体**：默认设置下没有表常态化保存上游出站请求体（只有调试抓取表在开关打开后才写 attempt 行），现状不可行。否决。
- **（替代路径）本机 canary/旁路容器 + 本地 echo 上游**：若只需证明出站体形状、不需真上游确认，可完全不走生产——本机 canary/旁路容器指向本地 echo 上游，零生产写、无调试表残留。本次要证的是「真上游收到并接受 xhigh」（含推理预算与 200 语义），echo 上游给不出这个证据，故未用此法。

## 来源

- 本次发版 1.4.20 收尾（ff 合并 + `scripts/deploy-painless.sh` 上线后）按 SOP 第①条执行的真实流量验证；实测证据：`max_tokens=16` 上游 500（空内容失败）、`max_tokens=512` 200（`id=chatcmpl-meta-1791039889148`），attempt 行 `request_body_json` 含 `"reasoning_effort": "xhigh"`。
- AGENTS.md「发版与无痛上线 → 脚本跑完还要做的」第①条（上线后按本次改动做真实流量验证）。
- 相关笔记：`.agents/notes/20260928-reasoning-effort-xhigh-scope.md`（1.4.20 改动的范围边界与遗留观察）。
- 代码位置：`src/server/config.ts`（默认值）、`src/server/db/index.ts`（`foreign_keys = ON`）、`src/server/routes/api/settings.ts`（`proxy_debug_*` 校验/热生效）、`src/server/runtimeSettingsHydration.ts`、`src/server/services/proxyDebugTraceStore.ts`（`shouldTraceProxyDebugRequest` / `serializeHeaders` / attempt 落库）、`src/server/services/proxyDebugTraceRuntime.ts`（surface 侧 attempt 钩子）、`src/server/db/schema.ts`（`proxy_debug_traces` / `proxy_debug_attempts`）、`src/server/proxy-core/cliProfiles/codexProfile.ts`（`session_id` 头 → `clientContext.sessionId`）。
