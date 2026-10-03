---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "proxy-core, server, db" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 客户端可见失败语义（#5–#8）：网络异常归一 / SSE in-band 错误帧 / client_http_status 观测列 / 路由刷新埋点

## 一句话结论

四条改动把「metapi 自己判失败」的路径变得对客户端**可区分**：网络层异常归一到与上游失败同一条路径（502 + `upstream_error` + `final_upstream_path` 落库），已 `reply.hijack()` 的 SSE 断流补一帧标准 in-band 错误（**绝不**追加终结帧），`proxy_logs` 新增**可空观测列** `client_http_status` 区分「`http_status`（metapi 判定的状态）」与「客户端实收状态码」，路由刷新补耗时/命中次数埋点。

## 背景（取证）

客户端报 `failed to fetch` 只来自「拿不到完整 HTTP 响应」的路径，本次处理其中三类：

1. 上游静默黑洞 ≈300s（`proxy_first_byte_timeout_sec=0`，只剩 undici 300s 兜底）。
2. 响应头已到、body 中途断（`terminated`）。SSE 已 `reply.hijack()` ⇒ 只能 in-band 处理；改前客户端看到**无终结的流**（既无终结帧也无错误帧）。
3. 请求内路由刷新挂起 140–182s，且**零观测**（无法回答「刷了几次、每次多久」）。

## 决策

### #8 路由刷新最小埋点（纯观测）

`refreshRoutesForFirstAttempt`（`src/server/proxy-core/channelSelection.ts`）在既有刷新门禁处加**耗时 + 累计命中/成功/失败计数**，并以结构化日志 `console.info('[proxy/route-refresh]', { trigger, requestedModel, outcome, durationMs, attempts, successes, failures })` 落点，复用仓内既有日志设施（不引入新指标依赖）。计数通过 `getRouteRefreshObservation()` 暴露给测试。**不改变选择语义**：刷新门禁、`selectChannel` 调用次数、返回值均不变。

### #5 `endpointFlow` 网络异常归一

`dispatchAttempt` 里**直接 throw** 的网络类异常（fetch reject / body 读取异常）改为规范成与 `!response.ok` 同路径的 `{ ok: false, status: 502, errText: formatErrorCause(err) }`：

- 客户端可见状态码**保持 502 不变**；
- 错误 `type` 由 `server_error` 变为 `upstream_error`——**属预期纠正**（网络层拿不到上游 HTTP 响应，语义同上游失败，不是本仓服务端错误）；
- attempt 记录与 `final_upstream_path` 现在也会落库（改前 throw 绕过这两者）；
- 重试/轮换语义不变：仍按 `retryable` / `rotateToNextEndpoint` 走。

### #6 SSE 断流写 in-band 错误帧

已 hijack 时**不能**再 `reply.code().send()`（`ERR_HTTP_HEADERS_SENT`），改为写一帧标准错误后 `end()`（`buildSurfaceInBandStreamErrorFrame` / `writeSurfaceInBandStreamError`，`src/server/proxy-core/surfaces/sharedSurface.ts`）：

- OpenAI 面：`data: {"error":{"message":"…","type":"upstream_error","code":502}}\n\n`
- Claude 面：`event: error\ndata: {"type":"error","error":{"type":"api_error","message":"…"}}\n\n`
- **绝不**在错误后追加 `data: [DONE]` / `message_stop`——那等于告诉客户端「成功结束」，错误会被当正常收尾吞掉；未 hijack 的出口保持既有 `reply.code(502).send(...)`。

覆盖面：`chatSurface.ts`（终态出口统一走 `respondTerminalFailure` + 流生命周期 `streamResponse.end()` 的终结帧观测）与 `openAiResponsesSurface.ts`（终态出口统一走 `respondTerminalFailure` + `streamSink.end()`：写过帧但没写过终结事件 ⇒ 补错误帧），两处都断言「有帧但无终结帧」才补，避免把「一帧都没写过」的失败改成流内错误；两处的补帧都**只写一次**（`writableEnded`/`destroyed`/`closed` 门禁去重：流生命周期 `end()` 与终态出口都会尝试写，后者被门禁挡下）。

responses 面的终态出口（共 5 处：流式路径 `if (failure)` 出口、非流式路径 `if (failure)` 出口、外层 catch 的 `siteConcurrencyTimeout` / `siteApiEndpointFailure` / 执行失败三个出口）已全部改为 `respondTerminalFailure`；其中 **3 处 catch 出口原本会 `reply.code(status).send(payload)`——已 hijack 时 Fastify 5 只 `log.warn(FST_ERR_REP_ALREADY_SENT)` 后**丢弃**（`node_modules/fastify/lib/reply.js:161-164`），客户端拿不到任何失败信号**。

### #7 `proxy_logs.client_http_status`（仅观测、可空）

- `src/server/db/schema.ts` 加 `clientHttpStatus: integer('client_http_status')`（**可空、无破坏性默认**）；sqlite 侧由新的 drizzle 迁移 `drizzle/0032_proxy_logs_client_http_status.sql` 落库；三方言产物（`schemaContract.json` + mysql/postgres bootstrap）由 `npm run schema:contract` 重新生成。
- **写入口径**（现有 `http_status` 语义不动，`0` 与客户端实收 503/502 仍是两件事）：

  | 出口 | `http_status` | `client_http_status` |
  | --- | --- | --- |
  | 成功（JSON / 已 hijack 的 SSE） | 200 | 200 |
  | 未 hijack 的失败出口 | 出口状态码 | 同出口状态码（客户端实收） |
  | 执行异常（`handleExecutionError` 出口） | 0 | 未 hijack ⇒ 502（合成状态码，即客户端实收）；已 hijack 后断流 ⇒ 200（客户端实收 200 + 流内错误帧，同下一行口径） |
  | 已 hijack 的流式失败 | 调用方口径（缺省 200） | 200（客户端实收 200 + 流内错误帧） |
  | 无法判定（非 surface toolkit 的直写日志） | 原样 | NULL（**不写猜测值**） |

- 取值实现细节：chat 面「是否已 hijack」只有 surface 自己知道（`streamStarted`），且日志发生在出口**之前**，故 `createSurfaceFailureToolkit` 接受 `resolveClientHttpStatus?: () => number | null` 取值器，`streamStarted` 提升到 handler 作用域、每轮轮首重置（跨重试轮次必须重置，否则会沿用上一轮「已 hijack」的事实）。
- **缺列兜底（防御位，不是老库的常态路径）**：写侧 `hasProxyLogClientHttpStatusColumn()` 门禁 + `isMissingProxyLogClientHttpStatusColumnError` 重试（丢这一列、**不丢整条日志**）。**老库不会停在缺列**：sqlite 老库由启动期 `runSqliteRuntimeMigrations()` 应用 `drizzle/0032_proxy_logs_client_http_status.sql` 补列（`src/server/runtimeDatabaseBootstrap.ts:9-15` → `db/migrate.ts:104` 按 `meta/_journal.json` 的 tag 定位该 SQL），MySQL/PG 老库由启动期 runtime bootstrap 按 schema contract 差分补列（见「被放弃的方案」第 5 条，本轮订正）。门禁只在「迁移 / bootstrap 还没跑过或失败」时才生效，此时值落 NULL——绝不让一个观测列弄丢代理日志。
- 跨库迁移（sqlite → mysql/postgres）拷贝字段清单同步加 `client_http_status`。

## 被放弃的方案（必填）

1. **gemini 原生流不补自制 in-band 错误帧——有意为之（not a TODO）**：`src/server/proxy-core/surfaces/geminiSurface.ts` 的流式 catch 分支（hijack 之后）不写任何错误帧，只在 `finally` 里 `reply.raw.end()`（`geminiSurface.ts:1100` 附近）——客户端拿到的是「干净截断」的流。**不给它补帧是决定，不是遗漏**，依据：
   - 本面走的是 Google **generateContent 族**（gemini-cli/antigravity 的 `/v1internal:streamGenerateContent?alt=sse`，见 `geminiSurface.ts:102`）。该族的错误语义只在**响应头之前**用 HTTP 状态码 + gRPC 风格 JSON error body（`{error:{code,message,status,details}}`）表达（`ai.google.dev/gemini-api/docs/generate-content/api-errors`）；官方文档里**没有**任何「SSE 流内错误帧」规约，也**没有** `[DONE]` 那种统一终结帧，SDK 对中途故障按连接中断/传输错误处理。
   - Google API 设计规范 AIP-193（`cloud.google.com/apis/design/errors`）要求错误必须是 `google.rpc.Status` 响应，并明确「APIs should not support partial errors」——「流已 200 开始后再塞一帧错误」正是它劝阻的 partial error。
   - 仓内也确实不存在 gemini 帧形构造器（`[DONE]` / `RESOURCE_EXHAUSTED` 等关键字在 gemini 面 0 命中）：**自造帧形等于把失败变成客户端不认识的另一种东西**，比「干净截断」更糟。
   - 反面证据已核对：Gemini **Interactions API**（另一族，`stream: true`）确实定义了流内 `event_type: "error"` 事件（`ai.google.dev/gemini-api/docs/api-errors`）——但本面不属于该族，故不适用；若将来本面改走 Interactions，再按那份规范补帧。
2. **不追加 sqlite legacy 补列通道**：不为新列加 `ensureProxyLogClientHttpStatusSchema()` + `legacySchemaCompat.ts` 白名单条目（既有 `is_stream` / `client_*` 那一套）。理由：那些列是 bootstrap-owned 老库的补列通道，需要同时改白名单 + 架构检查面；而本列的老库补列**已由既有通道覆盖**（sqlite 走启动期 drizzle 迁移 `0032_*`，MySQL/PG 走启动期 runtime bootstrap 的 contract 差分，见第 5 条），`has*` 门禁 + 缺列降级只是「迁移 / bootstrap 未跑过或失败」时的防御位，故不需要再开一条 legacy 白名单通道。
3. **不逐点传 `clientHttpStatus`**：chat 面有 8 处流式失败调用点，逐点传会散落同样的判断；改为 toolkit 的取值器（1 处构造 + `streamStarted` 提升），判断只有一份。
4. **不用 `http_status` 代替、不写猜测值**：无法判定的写 NULL。`http_status=0` 与客户端实收 502/503 是两件事，本列的意义正在于此。
5. **MySQL/PG 老库不经 `mysql.upgrade.sql` / `postgres.upgrade.sql` 产物补列——但启动期 runtime bootstrap 会按 schema contract 差分补列（本条本轮订正）**：`npm run schema:contract` 首次运行会把新列写进 `mysql.upgrade.sql` / `postgres.upgrade.sql`（`ALTER TABLE … ADD COLUMN`），但**二次/后续运行会自比差归正为空步**（generator 以盘上现有 `schemaContract.json` 作 previous），而 `schemaParity.test.ts` 现有断言**要求 upgrade 产物保持空步**（「锁定空步：不得含任何 ADD COLUMN（防回潮）」）。既有笔记（`20260928-journal-0005-and-upgrade-normalization.md`）已把「空步」定为归正终态，故本片服从该约定：**盘上 upgrade 产物**保持空步。
   **订正（原文写「MySQL/PG 老库缺列走降级 NULL」，与事实不符）**：老库的补列走的是**启动期 runtime bootstrap**，与盘上 upgrade 产物是两条独立路径——`src/server/index.ts:158` → `src/server/runtimeDatabaseBootstrap.ts:24-43`（`ensureRuntimeDatabaseReady` 的非 sqlite 分支）→ `src/server/db/runtimeSchemaBootstrap.ts:475`（`bootstrapRuntimeDatabaseSchema`）→ 同文件 `:445` `ensureRuntimeDatabaseSchema`：非 sqlite 方言先 `introspectLiveSchema` 取 live contract，再 `buildCompatibleRuntimeBaseline`（`:192-237`，live ∩ contract）与 `generateUpgradeSql` 差分，把「contract 有、live 缺」的列生成为 `ALTER TABLE … ADD COLUMN` 并执行（幂等：重复建对象的错误由 `isExistingSchemaObjectError` 吞掉，用例 `runtimeSchemaBootstrap.test.ts:103-141`）。结论：**MySQL/PG 老库启动后就有 `client_http_status`**（sqlite 老库同理，由启动期 `drizzle/0032_proxy_logs_client_http_status.sql` 迁移补列），`has*` 门禁只是「迁移 / bootstrap 未跑过或失败」的防御位。故本条不再是「约定优先于交付面」的取舍：交付面由 runtime bootstrap 覆盖，**不需要**改 `schemaParity.test.ts` 的空步断言。

## 产物命名与清理（本次顺带）

- `drizzle-kit generate` 产出的迁移文件重命名为语义化名称 `drizzle/0032_proxy_logs_client_http_status.sql`，同步改 `drizzle/meta/_journal.json` 的 tag 与快照文件名（`drizzle/meta/0032_snapshot.json`）——仓内既有迁移即语义化命名（如 `0031_proxy_logs_usage_columns.sql`），且 `migrate.ts` 按 journal tag 定位 `drizzle/<tag>.sql`。改完再跑一次 `npx drizzle-kit generate` 得 `No schema changes, nothing to migrate`（journal/snapshot 自洽的证据）。
- HEAD 里那个被跟踪的 `drizzle/meta/0033_snapshot.json` 是**陈旧快照**（当时 journal 末条 tag 是 `0031_*`，快照名前缀与 tag 不符）；本次由新迁移取代，故显示为删除 + 新增 `0032_snapshot.json`。

## 客户端可区分性判据（本次「成功」的定义）

客户端在下列三种失败下**不再**只看到 `failed to fetch` / 无终结的流：

1. 上游网络层异常/上游 5xx：HTTP **502 + JSON `error.type=upstream_error`**（未 hijack）或
2. 已 hijack 的流断流：HTTP 200 + **一帧 `upstream_error` / `api_error` 错误帧**，且其后**没有** `[DONE]` / `message_stop`（可区分「错误」与「成功收尾」）；
3. 观测面：`proxy_logs.client_http_status` 能回答「客户端实收几」，与 `http_status` 不一致的用例正是本次要暴露的（如 `http_status=502` + `client_http_status=200`）。

## 来源

任务 `MARK-CLIENTVIS-IMPL-W9`（#5–#8「客户端可见失败语义」，本会话需求，无 GitHub Issue）；验证与补齐轮 `MARK-VERIFY-CLIENTVIS-W9`。

## 验证（本轮 `MARK-VERIFY-CLIENTVIS-W9` 补跑，未 commit）

- 行号证据（改后）：`respondTerminalFailure` 定义 `openAiResponsesSurface.ts:386`，5 处终态出口接线 `:1205 / :1487 / :1566 / :1605 / :1635`（改前 5 处仍为 `reply.code().send()`，即上一轮定义的封套是**零调用点的死代码**，本轮才接上）；`streamStarted` `:331`（声明）/`:339`（取值器）/`:408`（轮首重置）/`:1021`（`reply.hijack()` 于 `:1020` 之后置真）；`writeSurfaceInBandStreamError` 在 `sharedSurface.ts:707`（三态门禁 `:720`、`try/catch` `:721-731`）。
- 新增用例：`sharedSurface.test.ts` 的 `writeSurfaceInBandStreamError > returns false without touching a destroyed hijacked socket`；`chat.stream.test.ts` 的 `…when a hijacked /v1/responses stream breaks mid-flight`（响应用例：只写一帧、无 `[DONE]`、无 `response.completed`、未退化成 JSON 失败体）。
- 计数：`npm run typecheck` 四段绿；聚焦 12 文件 / **307 passed**；`npm test` 全量 **3361 passed / 3378**，唯一失败 `src/server/routes/api/upstreamObservations.test.ts:133` 为**预存夹具时间炸弹**（夹具 `2026-09-25T07:00:00Z` 被默认「now-7d」窗口排出；把夹具整体后移 6 天后同一文件 6/6 绿，已还原）——与本改动无关；`npm run repo:drift-check` = 0 violations（5 条预存 debt）；`git diff --stat` 与 `--ignore-cr-at-eol --stat` 逐字相同（已将 `drizzle/meta/_journal.json` 末尾多余换行去掉）；`git diff --check` 无输出。

## 验证（本轮 `MARK-FIX-S1S2-1790926523`，未 commit）

- **S1 回归测试（先红后绿）**：`src/server/proxy-core/surfaces/sharedSurface.test.ts` 新增 `selectSurfaceChannelForAttempt > logs the client-visible 200 for an execution error that happened after the SSE was hijacked`（夹具：取值器返回 200；断言 `insertProxyLogMock` 收到 `httpStatus: 0` + `clientHttpStatus: 200`）；同文件既有用例 `returns a terminal 502 for exhausted network failures…` 补一行「未 hijack ⇒ `clientHttpStatus: 502`」的护栏断言（防一行修复把另一头弄丢）。同一测试文件只改这一处、未新开文件。同时把本文「写入口径」表中该出口那一行同步为「未 hijack ⇒ 502 / 已 hijack ⇒ 200」（超出 S2 点名范围的 1 处文档同步，已在回报里单独标注，可单独回退）。
  - 红（修复前，`sharedSurface.ts` 仍硬编码 502）：`Tests 1 failed | 33 passed (34)`，失败信息正是落库值 `clientHttpStatus: 502` ≠ 期望 200。
  - 绿（修复后 `clientHttpStatus: resolveStreamClientHttpStatus(502)`）：`Tests 34 passed (34)`。
- **typecheck**：`npx tsc --noEmit -p tsconfig.server.json` → exit 0。
- **全量**：`npm test -- --no-file-parallelism` → exit 0，`Test Files 508 passed | 2 skipped (510)`、`Tests 3363 passed | 16 skipped (3379)`、耗时 214.59s（对比上一轮 `3361 passed / 3378` + 1 失败：新增 1 例 + 上一轮那例夹具时间炸弹已修，见遗留 **O7**；计数自洽）。

## 验证（本轮 `MARK-B4-INBAND-1790927244`，未 commit）

实现 A/B/C/D（上游带内错误帧的识别与原样透传；口径：原样透传，不实现内部退避/重试），落点：

- **A 判据扩展**：`proxyStream.ts:59` `classifyInBandFailure`（三分类：`legacy` 逐字保持老判据 / `new` 本轮新增形 / `null`），`new` 覆盖「顶层带 `error` 对象」（含 `error.type=stream_error`、`error.code=stream_initialization_failed`）、`type` 为 `stream_error`、SSE 帧名 `event: error`；接线 `:383-386`（`consumed.handled` 分支只补既有 `markFailed`，不改已写出的字节）、`:403-416`（新形⇒原样透传出口）、`:419 / :430`（`legacy` 继续走归一化 + `force`，行为不变——**此句已由 `MARK-B4-R3-LEGACY-GATE-1790933` 改写：仅「已写字节」时如此，未写字节的 legacy 帧改走 HTTP 502，见下方 R3 小节**）、`:453-456`（非 SSE 的纯 JSON 体路径）。
- **B 原样透传 + 上游原文**：`formatRawSseBlock` `:72`（`event:` 名存在即保留，`data:` 原文不改）；`emitInBandFailureFrame` `:275`（openai 下游写上游原始字节；claude 下游用本仓既有 claude 带内错误帧形承载同一份原文）；失败原因补充器 `appendFailureIdentifiers` `:82`（`error.message` 原文 + 尾部 `(code=…, request_id=…)`，原文不被覆盖）。
- **C 失败出口保留上游字节**：`chatSurface.ts:441` `finalizeDebugFailure` 增第 4 参 `capturedUpstreamText`，`:447` 在 `captureStreamChunks === true` 且已读到字节时以**上游原文**作 `finalResponseBody`；4 处流式失败出口接线 `:1090 / :1150 / :1255 / :1336`。
- **D 诊断字段**：`chatSurface.ts:320` `payloadHasVisibleContent`（认 `content` / `delta.content` / `choices[].content` / `choices[].delta.content` / `choices[].message.content`），接 `:1007`（上游流事件日志）与 `:1413`（终态载荷诊断）。

回归测试（先红后绿）：`chat.stream.test.ts` 新增 5 例（`recognizes an upstream in-band 429 error frame and forwards it to the client verbatim` `:5395` / `recognizes an SSE event: error frame as an in-band failure and forwards it verbatim` `:5429` / `keeps the existing failure judgments: {type:"error"} frames and pure empty content` `:5446` / `claude downstream: recognizes an SSE event: error frame …` `:5474` / `reports has_content=true for the real text carriers …` `:5501`），并把既有 `serves an oversized upstream error frame as a 200 SSE stream …` `:5193` 的断言由「正文不下发（不含 y×50）」改为「正文逐字节下发（不封顶、不截断）」；`chat.singleChannelFailure.test.ts:545` 新增 1 例锁 C（trace body == 上游原文，且 `finalUpstreamPath` 落库）。

- **红**（`proxyStream.ts` 还原到 HEAD + `chatSurface.ts` 的 C/D 两族改动逐条还原）：`Tests 6 failed | 117 passed (123)`、exit 1。6 例 = `chat.stream.test.ts` 新增 5 例里的 4 例（A/B 三例 + D 一例）+ 改判据后的既有 oversized 例 + `chat.singleChannelFailure.test.ts` 的 C 新例；新增 5 例里的 `keeps the existing failure judgments` 两侧全绿——它是**非回归**护栏，按设计不该红。证据：`/tmp/b4/red/focused-red.txt`。
- **绿**（改动还原后）：`Tests 123 passed (123)`、exit 0。证据：`/tmp/b4/green/focused-green.txt`（聚焦两文件）；旁证 `proxy-transformers-green.txt`（`routes/proxy` + `transformers` 80 文件 / 914 例全绿）、`proxycore-services-green.txt`（`proxy-core` + `services` 154 通过 | 1 跳过文件、1228 通过 | 8 跳过例）。
- **typecheck**：`npm run typecheck` 四段（web / web:test / server / desktop）exit 0（含任务点名的 `tsc --noEmit -p tsconfig.server.json`）；证据 `/tmp/b4/green/typecheck.txt`。
- **全量**：`npm test -- --no-file-parallelism` → exit 0，`Test Files 508 passed | 2 skipped (510)`、`Tests 3369 passed | 16 skipped (3385)`、耗时 214.18s（上一轮基线 3363 passed ⇒ +6 例 = 本轮新增 5 + 1，计数自洽）；证据 `/tmp/b4/green/full-green.txt`。
- **口径与后果（供 reviewer 核）**：① 上游帧现在是**客户端可见字节**，故共享截断上限（1000 字符）不再作用于带内错误帧——原 oversized 用例据此改判据；封顶仍适用于本仓自写的出口 JSON 与落库/文案；② claude 下游不是字节级原样（上游帧非 Anthropic 形），改以本仓既有 claude 带内错误帧形承载：`error.message` 仍为上游原文，帧壳为本仓的；③ C 仅在采集开关开启时保留原文，关采集时维持既有 502 JSON 出口 payload；④ C 保留 SSE 原文时 `final_response_headers` 仍写 `content-type: application/json`（既有体例，本片未动，可另开片修）。

## 验证（本轮 `MARK-B4-FIX-R1-1790928`，未 commit）

用户口径（本轮定性）：**任何路径都不得让客户端以为「正常结束但空」**；能走 HTTP 层就走 HTTP 层（状态码 + 上游原文），已写过字节才走带内错误帧。实现 M1/M2/M3 + S1/S2/S3 + 落库守卫；**未引入任何内部重试/退避**。

- **M1（claude 下游双错误帧）**：把「已交付带内失败信号」做成事实——`proxyStream.ts:290` `noteInBandFailureDelivered()`（三处触发：`:434` 上游原生 Anthropic 错误帧、`:464` 新形带内失败帧、`:488` legacy `finish_reason:"error"` 块）→ 调用方 `chatSurface.ts:953` `sseInBandFailureDelivered` → 补帧门禁 `:975` `if (!sseTerminalFrameSeen && !sseInBandFailureDelivered)`。已知原因绝不补第二帧（不再出现自写的 `Upstream stream interrupted before a terminal event`）。
- **M2（带内失败帧的客户端可见性，混合）**：`proxyStream.ts:285` `hasStartedDownstreamWrite()`（调用方传 `() => streamStarted`，`chatSurface.ts:999`）；新形失败帧在 `:462` 只有「已写过字节」才写帧，未写过字节只 `markFailed(上游原文)`，交给既有 4 处 `!streamStarted` 的 502 出口（`chatSurface.ts:1102/1162/1267/1348` 之前的 `reply.code(502).send({error:{message:truncateStreamFailureMessage(streamResult.errorMessage),type:'upstream_error'}})`）。`finalize()` `:347` 失败终态 early-return：不 flush `pendingWrites`（否则会把 502 出口 hijack 成 200 SSE）。**（同一门禁已由 R3-A 施加到 `legacy` 失败帧，见下方 R3 小节。）**
- **M3（终结帧，统一不补）**：`proxyStream.ts:347-362` 失败终态下本仓不再生成终结帧；上游自己带的 `[DONE]`（`:406` `upstreamDoneSeen`）在已写字节时原样透传（`:358`），未写字节时也不透传（否则又 hijack）。**legacy（`type:error`/`response.failed`）一并改变**：失败终态不再补 `[DONE]`。
- **S1**：新增 claude 下游用例（`chat.stream.test.ts:5257` `claude downstream: an in-band stream_error frame produces exactly one error frame…`）——断言错误帧恰好一帧、含上游原文与 code/request_id、无 `message_stop`，同时覆盖 M1。
- **S2**：`proxyStream.ts:90` `formatRawSseBlock` 改为**逐行**加 `data: `（与 `anthropic/messages/streamBridge.ts:168` `serializeAnthropicRawSseEvent` 同口径）；多行 data 帧不再产出非法 SSE；用例 `chat.stream.test.ts:5290`。
- **S3 措辞**：统一改为「**上游 payload 原文 + 本仓重建的 SSE 信封**」（`proxyStream.ts:264-272` 注释 / 用例名与注释 / 本笔记本节）；上一轮写的「字节级原样」在 openai 下游指『上游 payload 原文逐字 + 本仓重建信封』，不等于上游整帧字节（`[DONE]` 由本仓按上游是否带来回放）。
- **落库守卫**：`sharedSurface.ts:665` `UPSTREAM_ERROR_MESSAGE_LOG_MAX_LENGTH = 64KB`，`:709` `guardUpstreamErrorMessageForLog`（接在 `handleExecutionError:1109` 与 `recordStreamFailure:1156` 的 `proxy_logs.error_message` 写入上）；截断实现 `:691` `truncateUpstreamErrorMessageWithLimit`——**尾部 `(code=…, request_id=…)` 标识后缀不受截断影响**（它总在末尾，普通头截第一个切掉它）。下发仍封顶 1000（同函数），客户端可见**带内帧**不封顶。
- **配置形态（写入口径，防验收读错）**：`PROXY_EMPTY_CONTENT_FAIL`（`config.proxyEmptyContentFailEnabled`）**自 `MARK-B4-R2-DEFAULT-ON-1790931` 起默认 true**（`src/server/config.ts:189-190`：`parseBoolean(env.PROXY_EMPTY_CONTENT_FAIL, true)`）：**开＝上游空内容判为失败**——纯空内容流记 **failed** + 自写 `Upstream returned empty content` 文案（502 JSON），**客户端不会收到空成功**。仅显式 `PROXY_EMPTY_CONTENT_FAIL=false`（env）或 UI/库值写成 false 时才回到旧形态：走 `finalize()` 正常收尾、记 **success**（客户端看到空流 + `[DONE]`）——旧形态同样不是「客户端拿到可用结果」。验收前先确认该开关取值；本实例的生产库值亦为 true，两种口径现已统一为「默认开」。
- **行号漂移更正**：上一轮笔记写的「判据接线 `:403-416`」在 reviewer 复核时实际为 `proxyStream.ts:404-416`；本轮改动后整体位移，**当前（M1/M2/M3 落地后）判据与接线在 `proxyStream.ts:451-468`**，`consumed.handled` 支线在 `:423-436`。后续引用一律以本节行号为准。
- 红转绿证据（逐项，日志 `/tmp/b4r1/red/*.txt`）：M1/S1 `expected 2 to be 1`（双错误帧）、M2 `expected 200 to be 502`、M3 `expected 'data: {"id":"chatcmpl-pre"…' not to contain '[DONE]'`、S2 `expected '…' to contain 'data: {"error":…'`；每项都是「只回退该项修复、保留用例」跑出的红，回退后逐文件 `diff -q` 校验按快照还原。
- 计数：`npx tsc --noEmit -p tsconfig.server.json` exit 0（`npm run typecheck` 四段 exit 0）；聚焦（改动落点 + chat 转换器）**210 passed**（8 文件，含既有 `transformers/openai/chat/proxyStream.test.ts`）；`npm test -- --no-file-parallelism` 全量 exit 0、`Test Files 508 passed | 2 skipped (510)`、`Tests 3376 passed | 16 skipped (3392)`（上一轮 3369 ⇒ +7 = chat.stream 净 +4 + sharedSurface.test.ts 新增 3）；`npm run repo:drift-check` exit 0（仅列预存 debt）。证据：`/tmp/b4r1/red/*.txt`、`/tmp/b4r1/green-full.txt`、`/tmp/b4r1/green-typecheck.txt`、`/tmp/b4r1/green-drift.txt`。

## 验证（本轮 `MARK-B4-R2-DEFAULT-ON-1790931`，未 commit）

用户原话「改那个设置，打开，绝不能静默」：**空内容判失败的代码默认值由 false 改为 true**，除显式 `PROXY_EMPTY_CONTENT_FAIL=false` 外，空内容一律判失败，客户端不会收到空成功。

- **代码**：`src/server/config.ts:189-190` 默认值 `false → true`（附一行注释写清语义与关闭方式）；`src/web/pages/UpstreamSettings.tsx:326` UI 预加载占位值 `false → true`（加载失败/未加载时不再显示成「关」，避免用户顺手保存把开关写回 false）；`:1363` 勾选项文案补「（默认开启）」。
- **文档同步**（把「默认关」的表述改成「默认 true；`PROXY_EMPTY_CONTENT_FAIL=false` 可关」）：本笔记 `:138` 本条、`.agents/notes/20261001-retry-exhausted-proxy-log-and-stream-cap.md:138`/`:165`、`CHANGELOG.md:28`、`docs/change-log.md:355`（后两处是**已发布版本的历史记录**，改写成「当时默认 false（现已改为默认开，见本条）」以免被读成现状）、`.env.example:15-16`（该开关此前未在样例中登记，补一条带注释的 `PROXY_EMPTY_CONTENT_FAIL=true`）、`docs/configuration.md:46`（设置表行补「空内容判失败默认开」）。已查无默认值声明而未动的：`src/server/routes/api/settings.ts`（仅校验与落库、无注释声明默认值）、`src/server/runtimeSettingsHydration.ts`（库值水合、无默认值声明）、`src/web/api.ts`（纯类型）。
- **测试**：新增 `src/server/config.test.ts:69-82` 两条——「未设 env ⇒ `proxyEmptyContentFailEnabled === true`」与「`PROXY_EMPTY_CONTENT_FAIL=false` ⇒ false」。**先红后绿**：改默认之前该用例 FAIL（`expected false to be true`，`/tmp/b4r2/red/config-default.txt`），改默认后 PASS（`/tmp/b4r2/green/config-default.txt`）。原「依赖默认 false」的用例（各 proxy 集成用例在 `beforeEach` 里显式 `config.proxyEmptyContentFailEnabled = false`）**本身就是显式设置**，断言未放宽、未删除。
- 计数与证据见本轮回报（`/tmp/b4r2/*`）。

## 验证（本轮 `MARK-B4-R3-LEGACY-GATE-1790933`，未 commit）

oracle 独立复核 R1 后指出**一条仍可静默的路径**：`legacy` 失败帧（`type:'error'` / `response.failed`）此前**没有** M2 门禁——它用 `emitLines(..., { force: true })` 无条件 hijack ⇒ 未写字节时客户端拿到 200 SSE + 归一化块，而 codex 系对 `finish_reason:'error'` 与优雅 EOF 都发 Completed ⇒「正常结束但空」。本轮把同一门禁施加到 legacy 分支，并把「为什么保留上游 `[DONE]`」写死在注释里。

- **R3-A（门禁扩到 legacy）**：`proxyStream.ts:476-487`——`failureKind === 'legacy'` 且 `!hasStartedDownstreamWrite()` ⇒ 只 `markFailed(parsedPayload, eventBlock.data)`（原因＝上游原文：`extractFailureMessage` 取 `error.message` / `message` / `response.error.message`，取不到才回落原始 `data`）并立即 `return`，**不写帧、不 hijack**，交给既有 HTTP 层 502 出口；已写字节 ⇒ 维持原行为（归一化块 + `force` + M1 上报）。语义边界与 `new` 形完全对齐（new 形的门禁在 `:467`，整个分支 `:457-472`）。
- **R3-B（保留上游 `[DONE]` + 写死原因）**：`proxyStream.ts:355-363` 的回放保留不删，注释写明依据——codex 系（`chat_completions.rs:415-416`）对**优雅 EOF** 同样 Emit Completed，`:313-340` 只在 HTTP 429/5xx 才重试 ⇒ 删 `[DONE]` 既治不了病，又破坏「本仓不生成终结帧、只回放上游自带的那一个」口径（真正治病的是 R3-A）。
- **R3-C**：对照表见下节（第 1/4/6/9 行按本轮与 R2 口径改写）。
- **R3-D**：遗留清单新增 R3-①..R3-⑤（见下）。
- **受影响的既有用例（2 处，均为“形态变了”而非放宽断言）**：
  - `chat.stream.test.ts:4491`（原 `emits finish_reason stop when … response.failed …`）⇒ 断言改为 **502 + 上游原文 `tool execution failed`**：该形是**未写字节**，旧口径客户端看到 `finish_reason:"stop"` + `[DONE]`（正是本轮要杀的「正常结束但空」）。`response.failed → finish_reason:"stop"` 的归一化映射仍有单元级覆盖：`transformers/openai/chat/index.test.ts:623`、`transformers/shared/chatFormatsCore.test.ts:371`。
  - `chat.stream.test.ts:5567`（`keeps the existing failure judgments`）的 legacy 半边补前置内容帧（`openAiPreContentFrame`）⇒ 继续锁「既有归一化/序列化路径不变」，同时反映新门禁。
  - **口径更正（重要）**：R3 指令所引「既有用例 `chat.stream.test.ts:5527` 锁定的『已写字节』语义」——该用例的 legacy 半边实际是**未写字节**形（无前置内容帧，改后见 `:5567` 注释）；真正的「已写字节 legacy ⇒ 200 SSE 归一化块」锁在 M3 用例 ②（`chat.stream.test.ts:5261`，带 `openAiPreContentFrame`）与本轮新用例 ②（`:5240`），两者都未改语义。
- **新增用例（先红后绿）**：`chat.stream.test.ts:5240` `gates the legacy failure frames the same way: 502 before any byte, normalized block afterwards`——① 未写字节 ⇒ 502 + `error.type='upstream_error'` + 上游原文 `boom`、落库 `failed`；② 已写字节 ⇒ 200 SSE + `finish_reason:"error"` + 无自写断流帧。
- **行号基线（防验收读错）**：本节所有 `proxyStream.ts` 行号为 R3 落地后的工作树行号；R1 小节里三处 `noteInBandFailureDelivered()` 触发点已位移到 `:439`（上游原生 Anthropic 帧）/ `:469`（新形帧）/ `:502`（legacy 归一化块，仅已写字节），定义仍在 `:290`；`handleEventBlock` 的判据与 `new` 出口在 `:456-472`，legacy 门禁在 `:476-505`。
- **红/绿证据**：只回退 R3-A 门禁、保留本轮全部用例 ⇒ `Tests 2 failed | 113 passed (115)`，两处均 `expected 200 to be 502`（新用例 ① `:5251`、responses 用例 `:4533`）｜`/tmp/b4r3/red/r3a-reverted.txt`；改前（用例已更新、门禁未上）⇒ 同样 2 红｜`/tmp/b4r3/red/r3a-chatstream.txt`；还原后 `Tests 115 passed (115)`｜`/tmp/b4r3/green/r3a-chatstream-final.txt`（`diff -q` 校验还原逐字节一致）。聚焦广度：`routes/proxy + transformers + proxy-core + services` ⇒ **234 files / 2150 passed**｜`/tmp/b4r3/green/focused.txt`。

### 「失败形态 → 客户端看到什么」对照表（R3 更新版）

| # | 失败形态 | 客户端实收 | 落库（`proxy_logs`） |
| --- | --- | --- | --- |
| 1 | **带内 error 帧（新形）且未写字节** | **HTTP 502** + `application/json`：`{error:{message:<上游原文，1000 封顶但保留 (code=…, request_id=…) 后缀>, type:'upstream_error'}}`（codex 系据此自行退避）。**注**：落库行的 `http_status=200` 只是「上游 HTTP 是 200」，它来自**调用方缺省**（`sharedSurface.ts:1173` `httpStatus: args.httpStatus ?? 200`；chatSurface 的流式失败调用只传 `runtimeFailureStatus`，不传 `httpStatus`），不代表客户端实收——客户端实收看 `client_http_status` | `status=failed`、`http_status=200`（上游 HTTP，调用方缺省）、`client_http_status=502`、`error_message=上游原文（≤64KB 守卫）` |
| 2 | **带内 error 帧且已写字节（openai 下游）** | **HTTP 200 + SSE**：已写内容 +「上游 payload 原文 + 本仓重建的 SSE 信封」+ **上游自带的 `[DONE]` 原样回放**（本仓不补） | 同上，但 `client_http_status=200` |
| 3 | **带内 error 帧且已写字节（claude 下游）** | 200 + SSE：`event: error` + `{"type":"error","error":{"type":"api_error","message":"<上游原文> (code=…, request_id=…)"}}`，**恰好一帧**、无 `message_stop` | 同上，`client_http_status=200` |
| 4 | **legacy 帧（`type:'error'` / `response.failed`）** | **未写字节 ⇒ HTTP 502** + `upstream_error` + 上游原文（legacy 分支 `proxyStream.ts:476-486`，未写字节门禁 `:483-486`，**R3-A 新增**）。**已写字节 ⇒ 200 + SSE**，但**按帧形分流**（R4 订正）：① `type:'error'` ⇒ **openai 下游**走归一化块，`finish_reason:"error"`；**claude 下游这个形到不了本分支**——它先被 `consumeAnthropicSseEvent` 的原生帧支线接手（`ANTHROPIC_RAW_SSE_EVENT_NAMES` 含 `error`，`anthropic/messages/streamBridge.ts:41-50`）逐字转发并记 failed，见本表第 8 行（**N-1 订正**：原文写「（openai 与 claude 下游皆然）」不实，且与本笔记 R4 小节口径 ② 自相矛盾）；② `response.failed` ⇒ **openai 下游维持归一化块语义**（`response.failed` 归一化成 `finish_reason:"stop"`，见 `transformers/shared/chatFormatsCore.ts:1767-1783` 与 `transformers/openai/chat/index.test.ts:623`、`transformers/shared/chatFormatsCore.test.ts:371`），**claude 下游改发 claude 错误帧 `event: error` + `{"type":"error","error":{"type":"api_error","message":"<上游原文> (code=…, request_id=…)"}}`（R4）：恰好一帧、无 `message_delta`/`message_stop`**。M3 后两种下游都不再生成终结帧（openai 的 `[DONE]` / claude 的 `message_stop`）；**上游自带的那一个 `[DONE]` 只在 openai 下游、且已写过字节时原样回放**（回放条件 `proxyStream.ts:355` 写作 `upstreamDoneSeen && hasStartedDownstreamWrite() && input.downstreamFormat === 'openai'`），claude 下游收到 `data: [DONE]` 只把它当终结信号吞掉（`proxyStream.ts:410-413`）、从不写出（**N-2 订正**：原文「（上游带了则回放）」未限定下游）。⚠️ **codex 系把这形当「正常结束但空」**：它只认 `choices`，对 `finish_reason:'error'` 与优雅 EOF 都发 Completed ⇒ 这正是 R3-A 把未写字节形改走 502 的原因 | `status=failed`，原因=上游 `error.message`；claude 下游已写字节时 `client_http_status=200` |
| 5 | **上游空流**（开关开：**当前默认**） | 502 JSON + 自写 `Upstream returned empty content` | `status=failed`、`client_http_status=502` |
| 6 | **上游空流**（仅显式关闭：`PROXY_EMPTY_CONTENT_FAIL=false`，或 UI/库值置 false） | 200 + SSE 空流 + `[DONE]`（旧行为） | **`success`**（仅在显式关闭下才会出现；R2 后默认不再走这条） |
| 7 | **真断流**（body 中途 terminated / 无终结帧） | 200 + SSE 一帧 in-band 错误（断流原因或 `Upstream stream interrupted…`）；若此前已交付过带内失败信号（M1）⇒ 只 `end()`，**不补第二帧** | `status=failed`、`client_http_status=200` |
| 8 | **claude 下游 + 上游原生 Anthropic `event: error` 帧** | 帧逐字转发 + 记 failed + 不补合成帧（M1）；未写字节时也照转（M2 边界：该帧是上游协议内的原生错误帧，改成 502 JSON 会把帧形弄丢） | 原因=上游原生 `error.message` |
| 9 | **非 SSE 200 JSON error 体**（`consumeUpstreamFinalPayload`） | **开关开（默认）时通常先被空内容判定截胡**：`chatSurface.ts:1203` 的 `detectProxyFailure` 在 `:1243` 的 `consumeUpstreamFinalPayload` **之前**判「无可见输出」⇒ 502 + 自写 `Upstream returned empty content`（**不是**上游原文）。只有显式关闭该开关、或体里有可见输出时，才会走到 O-c 的「可能先 hijack 成 200 SSE」路径（未修，只报告） | — |


## 遗留清单（未闭环观察项）

本节由 `MARK-FIX-S1S2-1790926523` 落盘。以下均为**已确认存在、但不在本次改动范围**的观察项，逐条带 `file:line` 与一句话建议，不作静默丢弃；行号为本文写作时的工作树行号。

- **O1 已 hijack 后仍可能经 `handleExecutionError` 出口继续重试（真因归正）**：`src/server/proxy-core/surfaces/sharedSurface.ts:1073-1074`（`maybeRetry` 在返回终态之前，重试未耗尽即返 `{action:'retry'}`）＋调用方 `src/server/proxy-core/surfaces/chatSurface.ts:1550-1571`、`src/server/proxy-core/surfaces/openAiResponsesSurface.ts:1607-1628`（`retryCount += 1; continue`）。**旧归因（「重试来自 `siteConcurrencyTimeout` 分支」）不准确**：该分支自己就 `respondTerminalFailure` 终结了（`chatSurface.ts:1470-1487`、`openAiResponsesSurface.ts:1553-1566`），真正会「已 hijack 还接着轮换通道」的是本出口；且下一轮轮首把 `streamStarted` 重置为 false（`chatSurface.ts:441`、`openAiResponsesSurface.ts:408`）会擦掉「已 hijack」的事实，成功路径还会再调 `startSseResponse()`（`chatSurface.ts:852-855`、`openAiResponsesSurface.ts:1019-1021`）对同一个已 hijack 的 reply 重设状态行/头。建议：后续加「`streamStarted` 即终态」护栏（已 hijack 不收 `retry`，直接走终态帧），并用回归测试锁住。
- **O2 终态帧子串匹配会被正文字面量骗过**：`src/server/proxy-core/surfaces/chatSurface.ts:909-911`（openai `/\[DONE\]/`、claude `/"type"\s*:\s*"message_stop"/`）与 `src/server/proxy-core/surfaces/openAiResponsesSurface.ts:1050`（`/response\.(completed|failed|incomplete)|\[DONE\]/`）。匹配对象是**写出的整行文本**，模型正文里出现 `[DONE]` / `response.completed` 字面量就会被当成「已终结」，本该补的 in-band 错误帧被跳过（正文假阴性）。建议：改为只对**结构化解帧**（`data:` 行的 JSON 载荷 `type`/`status` 字段）判定，不扫正文。
- **O3 responses 面 in-band 帧沿用 chat 形，codex 识别性未证实**：`src/server/proxy-core/surfaces/sharedSurface.ts:676` 的 `buildSurfaceInBandStreamErrorFrame`，openai 分支（`:690-693`）产出 `data: {"error":{"message":…,"type":"upstream_error","code":502}}`。决定：按现状提交，**发版后以真实断流验收**（codex CLI 对该帧的反应未知，需实流量确认；若不认，再按该客户端帧形补一版）。
- **O4 非 JSON 的 SSE `data:` 原样转发、不进聚合**：`src/server/transformers/openai/chat/proxyStream.ts:299-303`（`JSON.parse` 失败 ⇒ `parsedPayload = null`）→ `:333`（openai 分支 `emitRaw` 原样透传，最终走 `chatSurface.ts:982-986` / `openAiResponsesSurface.ts:1100-1103` 的 `writeRaw`）。这类帧会被转发并计入终态帧观测，但**不进** `onParsedPayload` / 聚合（用量与上游观测自证都看不到它们）。建议：把「本面只认 JSON 帧」写成不变量，或为这类帧加一条计数日志，避免上游换帧形时观测静默漏。
- **O5 gemini 面维持 AIP-193 干净截断（有意为之，不是 TODO）**：`src/server/proxy-core/surfaces/geminiSurface.ts:924`（`reply.hijack()`）→ `:1098-1100`（流式 catch 的 `finally` 只 `reader.releaseLock()` + `reply.raw.end()`）。依据见「被放弃的方案」第 1 条：该面走 generateContent 族，无 SSE 流内错误帧规约，自造帧形比干净截断更糟。
- **O6 重试耗尽出口劫持后靠 Fastify 的 `sent` 门禁丢弃**：`src/server/proxy-core/surfaces/chatSurface.ts:475` 仍是裸 `reply.code(retryFailure.status).send(retryFailure.payload)`，未走 `respondTerminalFailure`；此时 `streamStarted` 已在轮首被重置为 false（`:441`），「已 hijack」的事实压根不在判定里，真正的兜底是 Fastify 5 的 `sent` 门禁（`node_modules/fastify/lib/reply.js:161-164`：只 `log.warn(FST_ERR_REP_ALREADY_SENT)` 后 return）⇒ 客户端拿不到任何失败信号。建议：该出口改用 `respondTerminalFailure`，并把「已 hijack」做成跨轮次不重置的事实（与 O1 护栏同一处修）。
- **O7 已闭环，勿追**：`src/server/routes/api/upstreamObservations.test.ts:27` 的夹具时间炸弹（硬编码 `Date.UTC(2026, 8, 25, 7, 0, 0)` 被默认「now-7d」窗口排出）已修（改为由 `Date.now()` 派生，注释说明原因），本轮全量已全绿。
- **Q4 drizzle meta 快照链无自动化守卫**：`drizzle/meta/_journal.json` 与 `drizzle/meta/*_snapshot.json` 的 `prevId` 链没有任何守卫——`scripts/` 与 `src/` 下 `prevId` 零命中，`npm run repo:drift-check` 也不覆盖。故把不变量写死在此：① head 快照 = 字典序最大的 `drizzle/meta/NNNN_snapshot.json` 文件名；② 用新快照取代 head 时，新快照 `prevId` 必须等于**被删**快照的 `id`，重命名只改文件名、不改 `id`（本轮实测：新 `0032_snapshot.json` 的 `prevId=db396b71-1ec0-4060-9e98-5782ee95be1f` == HEAD `0033_snapshot.json` 的 `id`；`_journal.json` 末条 tag `0032_proxy_logs_client_http_status` 与之对齐）。可选后续：加一条「prevId 链自检」单测（按字典序串链，断言链头/链尾与 `_journal.json` tag 一致）。
- **O8（S1 顺带检查的观察项，按派单要求「只报告、不改」）**：`handleExecutionError` 出口除 `clientHttpStatus` 外还有三处与「已 hijack 后断流」的事实不符——① `src/server/proxy-core/surfaces/sharedSurface.ts:1060` 的 `httpStatus: 0` 及其注释（`:1081-1083`「从未拿到真实上游 HTTP 响应」）在该场景为假（上游已回 200 头，只是 body 中途断了）；② `firstByteLatencyMs` 三个调用点都没传（`chatSurface.ts:1550-1558`、`chatSurface.ts:2019`、`openAiResponsesSurface.ts:1607-1614`），真因是它声明在 `try` 内（`chatSurface.ts:848`）、catch（`:1464`）作用域取不到，故该列恒为 NULL、已 hijack 断流的首字延迟观测丢失；③ 出口 payload 的 `error.type = 'server_error'`（`:1090`，配 `status: 502` 于 `:1086`）与已 hijack 时实际写给客户端的 in-band 帧 `type=upstream_error`（`:690-693`）口径不一致（帧形由构造器固定，payload 只用到 message）。建议：另开一片处理，②可先做最小改动「把 `firstByteLatencyMs` 提升到 handler 作用域」。

- **O-a 上游原文进入通道失败分类判据（`MARK-B4-FIX-R1` 增）**：`src/server/services/tokenRouter.ts:399/403/407/411`（`matchesAnyPattern(USAGE_LIMIT_RATE_LIMIT_PATTERNS \| SITE_MODEL_FAILURE_PATTERNS \| SITE_PROTOCOL_FAILURE_PATTERNS \| SITE_VALIDATION_FAILURE_PATTERNS, errorText)`）与 `:517-535`（分类）/`:578-581`（`parseCodexQuotaResetHint`）。带内失败现在会把**上游原文**（含 `Retry after 29s.` 与尾部 `(code=…, request_id=…)`）送进这些子串/正则判据，直接决定「限流冷却 / 模型级失败 / 站点级失败」分流。后缀在尾部、不命中关键词，但**发版后需以真实流量确认分类未被新文本改变**。
- **O-b responses 面同形帧仍静默（`MARK-B4-FIX-R1` 增）**：`src/server/transformers/openai/responses/proxyStream.ts:167-173` 的 `isFailureEvent` 只认 `event`/`type` ∈ {`error`,`response.failed`}；`{"error":{…},"type":"stream_error"}` 这类形不认（落到 `normalizeEvent` → 无匹配 → 静默）。codex 新版只走 `/v1/responses` ⇒ **本轮的 chat 面修复对它们无效**，需另开一片把同一判据搬过去。
- **O-c 非 SSE 200 JSON error 体仍可能被 hijack（`MARK-B4-FIX-R1` 增）**：`src/server/transformers/openai/chat/proxyStream.ts:508-512`（`consumeUpstreamFinalPayload` 的 `new` 分类）只 `markFailed`，随后同函数的 openai 分支仍会把归一化 final 块 `emitLines({meaningful:true})` 写出 ⇒ 可能先 hijack 成 200 SSE，客户端拿不到 502。M2 只覆盖「带内帧」，本条不在本轮范围（只报告不改）。
- **O-d 流式失败出口缺 `is_stream`（`MARK-B4-FIX-R1` 增；计数由 `MARK-FIX-A-R2-P1` 订正为 8 处）**：**8 个** `recordStreamFailure({…})` 调用点（chat 面 4 + responses 面 4，行号为本轮快照）都没传 `isStream` / `firstByteLatencyMs` ⇒ `proxy_logs.is_stream` 与 `first_byte_latency_ms` 在这类失败下恒 NULL（观测列缺一项）。8 处清单：
  - `src/server/proxy-core/surfaces/chatSurface.ts:1091`、`:1152`、`:1256`、`:1337`；
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts:1126`、`:1222`、`:1311`、`:1377`。
  - 逐块核对过入参：8 处均**只**传 `selected` / `requestedModel` / `modelName` / `errorMessage` / `latencyMs` / `retryCount` / `promptTokens` / `completionTokens` / `totalTokens` / `upstreamPath` / `runtimeFailureStatus`，`isStream` 与 `firstByteLatencyMs` 均 **0 命中**；取值器 `sharedSurface.ts:1203` 写的是 `args.isStream ?? null` / `args.firstByteLatencyMs ?? null`。
  - **订正记录**：原文只写 chat 面那 4 处（`MARK-B4-FIX-R1` 当时只看 chat 面），漏了 responses 面同名 4 处；两者调用形完全一致，缺口同源。
- **O-e 未覆盖的带内失败形（`MARK-B4-FIX-R1` 增）**：本轮判据只认「顶层 `error` 对象 / `type` 为 `stream_error` / SSE 帧名 `error`」三类。① `choices[].finish_reason === 'error'` 但无顶层 `error` 对象；② SSE 帧名为 `response.failed` 而载荷无 `type` 字段；③ 字符串型 `error`（`{"error":"upstream failed"}`）——三者在 chat 面仍走原归一化链（静默或空内容兜底），需按实测流量决定是否补判据。
- **R3-① 失败帧之后仍可能写出内容帧（`MARK-B4-R3-LEGACY-GATE-1790933` 增）**：失败帧处理完（`markFailed`）后 `handleEventBlock` **不停止消费上游**——new 形 `proxyStream.ts:457-472`（已写字节分支写帧后 `return`）与 legacy 已写字节分支（`:486-505`）都不终结本轮；上游若在错误帧之后还发内容帧，仍会被归一化并写出。**概率极低**（上游通常在错误帧后停写）但形态存在：客户端会看到「内容帧出现在失败帧之后」，若错误帧被客户端跳过，末态可能只剩上游自带的 `[DONE]`。建议：失败终态后的后续帧只计数不写出（另开一片）。**R4 后**：新加的 claude legacy 分支同样只在帧写完后退回（`proxyStream.ts:496-502`），不终止消费 ⇒ 本观察项对 claude 下游依然成立。
- **R3-② O1 与 O6 叠加时的「静默窗口」（`MARK-B4-R3-LEGACY-GATE-1790933` 增）**：已 hijack 后走 `handleExecutionError` 仍可能进重试轮（O1：`sharedSurface.ts:1073-1074` + `chatSurface.ts:1550-1571`），而轮首会把 `streamStarted` 重置为 false（`chatSurface.ts:441`）⇒ M2/R3-A 的 `hasStartedDownstreamWrite()` 会把这个失败误判成「未写字节」而**不写帧**；同时 502 出口又因响应头已发被 Fastify `sent` 门禁丢掉（O6：`chatSurface.ts:475`）⇒ **客户端已收到上一轮字节、却拿不到任何失败信号**。与 O1/O6 同一处修复（「已 hijack 即终态、跨轮次不重置」护栏）。
- **R3-③ 已知限制：已写字节时 codex 系仍看不到失败（`MARK-B4-R3-LEGACY-GATE-1790933` 增）**：已写字节后本仓只能给带内帧（legacy 归一化块 / new 上游原文信封），而 codex 的 chat SSE 解析只认 `choices`（不经 `choices` 的错误帧不会变成 error），且它只在 HTTP 429/5xx 才重试（`chat_completions.rs:415-416` 对优雅 EOF 同样 Emit Completed、`:313-340` 仅 429/5xx 重试）⇒ codex 侧仍可能显示 Completed。**这是能力边界，不是本轮 bug**：本仓已把「未写字节」形全部改成 502（R3-A 后 legacy 也走 502），已写字节的形客户可见性取决于客户端是否解析流内错误帧。发版后按真实流量确认。
- **R3-④ 别把 oracle 临时夹具的红当回归（`MARK-B4-R3-LEGACY-GATE-1790933` 增）**：`/tmp/oracle-b4/openai-edge.test.ts:35`（`expect(written.join('')).toContain('data: [DONE]')`）编码的是 **B4 旧口径**（「本仓会给无终结帧的失败流补 `[DONE]`」），M3 之后按预期翻红；该文件在 `/tmp`、**不在仓内**（`vitest` root 为仓库、`npm test` 不含它）。
- **R3-⑤ “已写字节”的正确定位（`MARK-B4-R3-LEGACY-GATE-1790933` 增，口径更正）**：R3 指令引用的 `chat.stream.test.ts:5527` 锁的是**未写字节**的 legacy 形（无前置内容帧）；真正的「已写字节 legacy ⇒ 200 SSE 归一化块」锁在 M3 用例 ②（`chat.stream.test.ts:5261`）与 R3-A 新用例 ②（`:5240`）/ `:5577`。后续引用「已写字节语义」时以这两处为准。
- **R3-⑥ 已闭环（`MARK-B4-R4-CLAUDE-LEGACY-1790941`）**：claude 下游 + legacy 老形失败（`response.failed`）+ **已写字节**时，该帧不是 Anthropic 形，原先继续走归一化块：`response.failed` 归一化成 `finish_reason:'stop'`（`chatFormatsCore.ts:1777` `responsesStatusToChatFinishReason('failed', null, false)`），claude 序列化器把它渲染成 `message_delta{stop_reason:'end_turn'}` + `message_stop`（`anthropic/messages/streamBridge.ts:559` `buildDoneEvents` / `:758` `toClaudeStopReason`）⇒ **客户端看到「正常结束（带部分内容）」、服务端记 failed**。R4 改为复用 M1 已在用的 claude 带内错误帧出口（`emitInBandFailureFrame` 的 claude 分支）：**claude 现在收到显式错误信号**——恰好一帧 `event: error` + `{"type":"error","error":{"type":"api_error","message":"<上游原文> (code=…, request_id=…)"}}`，**不含 `message_delta`/`end_turn`/`message_stop`**；已写出的内容原样保留在前。openai 下游一字未动（维持归一化块语义，R3-A 用例 ② 仍绿）；未写字节分支（R3-A ⇒ 502）与 `consumed.handled` 支线（claude 上游原生 `event: error` 帧）也未改。
- **R4-①（登记观察项，`MARK-B4-R4-CLAUDE-LEGACY-1790941` 增；oracle R4 终局指出）：openai 下游 + `response.failed` + 已写字节的归一化块渲染 `finish_reason:"stop"`——有意保留，是否加固待定**：`response.failed` 经 `normalizeUpstreamStreamEvent`（`src/server/transformers/shared/chatFormatsCore.ts:1767-1783`）归一化为 `finish_reason:"stop"`（`responsesStatusToChatFinishReason('failed', …)` 在 `:591-593` 把 `failed` 返回 `'stop'`），openai 序列化器据此写出「正常结束」块（本仓不生成终结帧，上游带了 `[DONE]` 才回放，见 N-2）
  ⇒ **spec 型客户端（只看 `choices[].finish_reason`）把这形读作「正常结束」，而服务端记 `failed`**，与该出口的落库口径不一致。**这是有意保留、不是遗漏**：该映射有既有测试双重锁死（`src/server/transformers/openai/chat/index.test.ts:623` `serializes response.failed terminal events with stop finish_reason instead of error`、`src/server/transformers/shared/chatFormatsCore.test.ts:371` `maps response.failed to a stop finish reason instead of inventing a chat error finish reason`），本片（R4）只把 **claude 下游** 改成显式错误帧，**openai 下游一字未动**（改它等于推翻这两条既有测试锁定的语义，超出 R4 范围）。
  **后果与影响面**：① 只影响「`response.failed` + **已写字节** + openai 下游」这一形；未写字节形已被 R3-A 同一门禁改走 HTTP 502，不受影响；② **codex 系另有既有已知限制**——它只认 `choices`、且对 `finish_reason:'error'` 与优雅 EOF 都发 Completed（`chat_completions.rs:415-416`），故对 codex 而言这一形改不改 `stop` 都不改变「客户端看不到失败」的结局（见 R3-③）；③ 本仓对这一形的知情手段只剩 `proxy_logs.status=failed` 与 `client_http_status=200`。
  **是否加固待定**：与 claude R4 对称的可选方向＝「openai 下游已写字节时也先补一帧 openai 形错误帧」，但那会改动 openai 下游字节序列与上述两条既有测试，且对 codex 无效，需产品/审批拍板后才能做，本片**不做**。
- **N-3（登记，`MARK-B4-R4-CLAUDE-LEGACY-1790941` 增；继承自 R1，非本轮引入）：`(code=…)` 后缀的取值面**：`appendFailureIdentifiers`（`proxyStream.ts:101`）只读**顶层 `error.code`**（`request_id` 另从顶层 `request_id` 或 `error.request_id` 取）⇒ `response.failed` 的常见嵌套形（`response.error.message`、无顶层 `error` 对象）**拿不到 `code`**，只有上游带了顶层 `request_id` 时才会有 `request_id=` 后缀，纯嵌套形则整个后缀不出现（`if (parts.length <= 0) return message`，不写空后缀）；同一规则也适用于 `record.message` / `response.error.message` 两处出口（`:174` / `:181`）。R4 用例的夹具显式带顶层 `request_id`，故它的断言里能看到该后缀——**不要据此读成「凡失败必有 `code=`」**。

## 验证（本轮 `MARK-B4-R4-CLAUDE-LEGACY-1790941`，未 commit）

R4（R3-⑥ 闭环）：只改一处生产代码 + 一处用例 + 本文。

- **改动点（file:line）**：
  - `src/server/transformers/openai/chat/proxyStream.ts:487-502`：legacy 分支在 R3-A 的「未写字节」门禁之后、归一化块之前，新增 `if (input.downstreamFormat === 'claude')` 分流（`:496`）——`extractFailureMessage(上游原文)` → `markFailed` → **复用 M1 同一出口** `emitInBandFailureFrame`（其 claude 分支 `:306-315` 已存在，本轮未改）→ `noteInBandFailureDelivered()`（`:500`）→ `return claudeContext.doneSent`（`:501`）。整块 16 行（含 9 行注释），无新机制、无新函数、无新分支于其他下游。
  - `src/server/transformers/openai/chat/proxyStream.ts:476-482`：R3-A 注释里那句「已写过字节时维持原行为」补一行「**claude 下游例外**（R4 后改发 `event: error`）」（`:482`），防后续读成 openai/claude 同口径。
  - 未动：`emitInBandFailureFrame`（`:306`）、`classifyInBandFailure`（`:59`）、`finalize`（`:334`）、`handleEventBlock` 的 `consumed.handled` 支线（`:428`）、`new` 形出口（`:457-472`）、归一化块本身（`:503-520`）。
- **用例（先红后绿，未新开文件）**：`src/server/routes/proxy/chat.singleChannelFailure.test.ts:613` `claude downstream: an already-written legacy response.failed frame becomes one event: error frame, not end_turn/message_stop`（`/v1/messages` + stream ⇒ claude 下游；上游 `/v1/responses` SSE：`response.created` → `response.output_text.delta("partial answer")` → `response.failed("tool execution failed" + 顶层 `request_id`)` → `[DONE]`）。断言：200 + `text/event-stream`；`partial answer` 仍在；`event: error` **恰好一帧**且 message 含上游原文与 `request_id=…` 后缀；**无** `message_delta` / `end_turn` / `message_stop`；落库 `status=failed`、`client_http_status=200`、`error_message` 含上游原文与后缀。选在这里是因为该文件用的是**真实 sqlite**（已迁移 schema，`proxyLogs.clientHttpStatus` 可直读，同文件已有先例），故「落库」不是 mock 断言；为此在 `:176` 补注册 `claudeMessagesProxyRoute`（一行，其余用例走 `/v1/chat/completions`，不受影响）。
  - **红**（只把本轮的 `proxyStream.ts` 改动回退、用例保留）：`Tests 1 failed | 13 passed (14)`、exit 1，失败点 `expected +0 to be 1`（`event: error` 帧数为 0）；临时诊断打印的响应体证明旧形态正是 R3-⑥：`message_delta{"stop_reason":"end_turn"}` + `message_stop` 结尾、无任何错误帧。证据：`/tmp/r4/red/revert-only.txt`（诊断已删除，最终用例文件不含任何 `console.log`）。
  - **绿**（改动在位）：`Tests 14 passed (14)`、exit 0。证据：`/tmp/r4/green/focused-single-channel.txt`。
- **三处行为不变的自证（既有用例 + 复跑，点名 `--reporter=verbose` 输出）**：证据 `/tmp/r4/green/self-proof-behaviors-named.txt`（`Tests 5 passed | 124 skipped`）。
  1. **未写字节 R3-A ⇒ 502 + 上游原文**：`chat.stream.test.ts` `gates the legacy failure frames the same way: 502 before any byte, normalized block afterwards`（① 半边）+ `delivers an HTTP 502 with the upstream reason when /v1/chat/completions receives response.failed from /v1/responses upstream` 两条绿。
  2. **openai 下游已写字节 ⇒ 归一化块语义不变**：同一 `gates the legacy failure frames…` 用例的 ② 半边（`finish_reason:"error"`）绿——本轮的 claude 分流没有把它带走。
  3. **claude 上游原生 `event: error` 帧（`consumed.handled` 支线）**：`chat.stream.test.ts` `claude downstream: recognizes an SSE event: error frame as a failure while still forwarding it verbatim` 绿（帧逐字转发 + `markFailed`）。
  4. **新形 M1**：`chat.stream.test.ts` `claude downstream: an in-band stream_error frame produces exactly one error frame (no synthesized second one)` 绿（仍恰一帧、无第二帧）。
- **计数与证据**：`npx tsc --noEmit -p tsconfig.server.json` exit 0；`npm run typecheck` 四段 exit 0（`/tmp/r4/green/typecheck.txt`）；`npm test -- --no-file-parallelism` exit 0、`Test Files 508 passed | 2 skipped (510)`、`Tests 3380 passed | 16 skipped (3396)`、223.79s（基线 3379 ⇒ +1 = 本轮新增用例，计数自洽；`/tmp/r4/green/full.txt`）；`npm run repo:drift-check` `Violations: 0`（仅 5 条预存 debt；`/tmp/r4/green/drift.txt`）。聚焦广度：`chat.singleChannelFailure + chat.stream + transformers/openai/chat + transformers/shared + transformers/anthropic` ⇒ **14 files / 246 passed**（`/tmp/r4/green/focused-claude-family.txt`）。
- **口径（写死，防后续误读）**：① 本轮只把 **claude 下游** 的 `response.failed` 从「归一化块」改为「M1 错误帧」，**openai 下游不变**；② claude 下游的 `type:'error'` 形实际到不了这条分支（`consumeAnthropicSseEvent` 先以 `ANTHROPIC_RAW_SSE_EVENT_NAMES` 接手，见 `anthropic/messages/streamBridge.ts` 的 `event: error` 原生帧支线）⇒ 本分支在 claude 下游实际只服务 `response.failed`；③ 客户端看到的 claude 错误帧**不封顶**（与 M1/S1 同口径），落库经 64KB 守卫。

## 验证（本轮 `MARK-FIX-A-OBS-MASK-1790955`，未 commit）

两项修复：①**降级出口补齐观测列**（`onDowngrade` 落库行的 `client_http_status` / `is_stream`）；②**调试库上游凭据不再明文落库**（debug 头脱敏）。生产代码只动 4 个文件：`proxy-core/surfaces/{chatSurface,openAiResponsesSurface,sharedSurface}.ts`、`services/proxyDebugTraceStore.ts`（另改 2 个既有测试文件；无新测试文件）；**未提交、未动容器与生产库**。

### ① 降级出口（`onDowngrade`）的列语义：非终态行写哨兵

**先读清调用时机**：`onDowngrade` 由 `executeEndpointFlow` 在**中途**调用，回调返回后循环 `continue` 去试下一个端点（`src/server/proxy-core/orchestration/endpointFlow.ts:335-341`，且该分支要求 `!isLastEndpoint`）⇒ **降级行永远不是该请求的终态行**：同一请求至少还会再落一行（成功行，或终态失败出口行）。所以「客户端到底收到什么」不在这行上。

| 列 | 改前 | 改后（降级行） |
| --- | --- | --- |
| `client_http_status` | 没传 ⇒ NULL（看不出是漏写、还是本就不该有值） | `CLIENT_HTTP_STATUS_NON_TERMINAL`（= **-1**，非终态哨兵） |
| `is_stream` | 没传 ⇒ NULL | 本轮请求是否流式的真值（流式 `true` / 非流式 `false`） |
| `http_status` | 本轮上游状态（如 502） | 不变 |
| `status` | `'failed'` | 不变（仍是这一轮尝试的结果） |

- 哨兵定义（R2 后仍指同一常量）：`src/server/proxy-core/surfaces/sharedSurface.ts:276`（`export const CLIENT_HTTP_STATUS_NON_TERMINAL = -1`；语义注释 `:251-275`，R2-2 已改为「只约束本哨兵的来源行」）。
- 两个出口接线：`src/server/proxy-core/surfaces/chatSurface.ts:800`（`clientHttpStatus`）/`:802`（`isStream`）；`src/server/proxy-core/surfaces/openAiResponsesSurface.ts:909` / `:911`。

**`client_http_status` 取值口径（R2-2 订正后写死；**不是「凡非终态就写 -1」**）**：
1. `100..599`：真实下发的状态码——终态行，**以及按各自既有口径写真实码的非终态行**（预重试出口 `handleUpstreamFailure` / `handleDetectedFailure` / `handleExecutionError` 的落库发生在 `maybeRetry` **之前**；**8 处**流式失败出口 `recordStreamFailure`（chat 面 4 + responses 面 4，清单见「遗留与跟进」O-d）的调用方随后才决定 `retryCount += 1`）；
2. `-1`（`CLIENT_HTTP_STATUS_NON_TERMINAL`）：**仅表示「该行由 `onDowngrade` 出口写入的真实非终态尝试」**；
3. `NULL`：无法判定——租约超时行（**3 处** busy 出口都未传该列：`chatSurface.ts:820`（chat 面）/ `chatSurface.ts:1849`（claude count-tokens 面）/ `openAiResponsesSurface.ts:930`（responses 面））、非 toolkit 直写日志、缺列兜底。

> **R2-2 订正（oracle S-1）**：本节原文把这三类写成「全列不变量」（第 1 类还写成「客户端真实收到的终态状态码」）**不实**：降级出口之外的中间/非终态来源仍按各自既有口径写真实码或 NULL。现已同步为「只约束本哨兵的来源行」（代码侧 `sharedSurface.ts:251-275` 常量注释同改）。

**为什么不做廉价回填**：降级回调是 `executeEndpointFlow` 的内联钩子，`executeEndpointFlow` 回流只有 `{ok,status,errText,rawErrText,upstreamPath}`（`endpointFlow.ts:344-350`），**不回流任何 `proxy_log_id`**，仓内也没有「按 id 回填代理日志行」的通道；要回填就得把这一行的 id 一路带到终态出口再补一次 `UPDATE`（新增跨层管道 + 与终态写入竞争），代价远超一个观测列本身 ⇒ 选「明确标记非终态」。

**为什么哨兵取 -1（而不是 NULL / 0）**：
- 不写 NULL：NULL 在本列既有含义是「无法判定 / 缺列兜底」，写它等于**看不出这一行到底是不是终态行**（也看不出是漏写）——正是改前的状态。
- 不写 0：同表 `http_status = 0` 的既有约定是「没有真实上游 HTTP 响应」（描述**上游侧**），本列描述的是**客户端侧**；复用同一个字面值会让两件事混叠（与上文「`http_status=0` 与客户端实收 502/503 是两件事」同源）。
- 取 -1：合法状态码是 `100..599`，-1 落在值域外、不可能被误读成真实状态码；「整数列用 -1 当『不适用 / 非值』哨兵」在本仓有先例（token 用量投影把 `sites.id = -1` 当「未知站点」哨兵）。
- **影响面**：全仓**没有** `client_http_status` 的读侧消费（`src/**` 检索只有写侧、schema 契约、跨库迁移拷贝、db 列存在性门禁与用例），故新增哨兵值不动任何既有查询/统计。

**登记（本次不做）**：O-d 仍成立（**8 处**流式失败出口仍未传 `isStream` / `firstByteLatencyMs`，清单见「遗留与跟进」O-d）；gemini 面的 `onDowngrade`（`geminiSurface.ts:1421-1427`）**不写 `proxy_logs`**（只更新 debug attempt）⇒ 不存在同类缺列，无需改。

## 验证（本轮 `MARK-FIX-A-R2-1790985034`，未 commit）

oracle 第二意见落地：R2-1 掩码边界补齐（必修代码）、R2-2 哨兵口径订正（必修文档）、R2-3 列语义可见性（必修文档）。同一分支 `fix/downgrade-observability-and-secret-masking`，未提交；R2-1 只动脱敏 helper/名单与该处测试，未动其它逻辑。

> **行号基准（如实登记）**：本文件早期小节（B4/CVF 各轮）里的 `sharedSurface.ts` / `chatSurface.ts` / `openAiResponsesSurface.ts`
> 行号是**各自写入当时的快照**。之后两次改动会使这些文件的行号整体位移：R1 在 `sharedSurface.ts`
> 新增哨兵注释（约 +25 行，且各降级出口各 +1..+2 行）、R2-2 又把该注释扩写了 +6 行。本节行号为 **R2 后**
> 的当前快照；核对历史小节时请**以符号名 / 函数名（如 `handleExecutionError`、`recordStreamFailure`）为准**，
> 行号仅作定位起点（是否需要整文件重编号，留给主代理决定）。

### R2-2 哨兵口径订正（oracle S-1）

- 原注释把 `client_http_status` 的三取值写成**全列不变量**（第 1 类还写成「客户端真实收到的终态状态码」）——**不实**：同列在降级出口之外的中间/非终态来源仍按各自既有口径写真实码或 NULL。
- 代码侧（`proxy-core/surfaces/sharedSurface.ts:251-275` 常量注释）：改为**只约束本哨兵来源行**（-1 仅表示「该行由 `onDowngrade` 出口写入的真实非终态尝试」），并写明其它非终态来源的既有口径：
  - 预重试出口（落库发生在 `maybeRetry` **之前**，行号为 R2 后的当前快照）：`handleUpstreamFailure`（`sharedSurface.ts:1003` vs `:1026`）、`handleDetectedFailure`（`:1074` vs `:1087`）、`handleExecutionError`（`:1131` vs `:1140`）写各自真实状态码 / 取值器取值；**8 处** `recordStreamFailure`（chat 面 4 + responses 面 4，行号清单见「遗留与跟进」O-d）同理（调用方随后才 `retryCount += 1`，落库取值器 `:1203`）；
  - 租约超时行（**3 处** busy 出口未传 `clientHttpStatus`：`chatSurface.ts:820` / `:1849`、`openAiResponsesSurface.ts:930`）与直写日志 / 缺列兜底：落 NULL。
- 笔记侧同步：见上文「R2-2 订正」（原「三类取值」段已改写为「**不是『凡非终态就写 -1』**」句）。

### R2-3 可见性（oracle S-2）

- `src/server/db/schema.ts` 的 `clientHttpStatus` 列注释补三取值语义（100..599 终态真实码 / -1 仅 `onDowngrade` 非终态 / NULL 无法判定）＋「**不是**凡非终态就写 -1」的显式提醒。
- `docs/change-log.md` 新增 2026-10-02 的第 5、6 条（本批实现与验证统计），第 5 条含上面同一段列语义说明；`CHANGELOG.md` 的 1.4.16 条目按任务留到发版准备轮。

### 计数与证据（R2 后重跑，全绿）

- `npx tsc --noEmit -p tsconfig.server.json` exit 0（输出 0 字节）；`npm run typecheck` 四段 exit 0｜`/tmp/mark1790985034/green/typecheck.txt`、`typecheck-server.txt`。
- `npm test -- --no-file-parallelism` exit 0：`Test Files 508 passed | 2 skipped (510)`、`Tests 3383 passed | 16 skipped (3399)`、231.21s（R2 任务给定基线 508 files / **3382** passed / 16 skipped ⇒ +1 = 本轮新增的 R2-1 用例，计数自洽）｜`/tmp/mark1790985034/green/full.txt`。
- `npm run repo:drift-check`：`Violations: 0`（仅 5 条预存 tracked debt）｜`/tmp/mark1790985034/green/drift.txt`。

## 发布准备（`MARK-FIX-A-RELEASE-PREP-1790986024`，本步不 commit、不 push）

### P-1 文档订正（oracle 复核提出的两条纯文档）

1. **NULL 桶补第三处 busy 出口**：NULL 取值来源原只列 `chatSurface.ts:820` 与 `openAiResponsesSurface.ts:930`，漏了 `chatSurface.ts:1849`（同样是 lease timeout 形：`buildSurfaceConcurrencyBusyMessage` + `failureToolkit.log` 未传 `clientHttpStatus`，所在处理器 `handleClaudeCountTokensSurfaceRequest`）。已补进哨兵注释的 NULL 桶（改为「**3 处** busy 出口」并按面列举）及本节各 NULL 清单。
2. **`recordStreamFailure` 调用点 4 → 8（数字订正）**：实际为 **8 个**生产调用点（chat 面 4 + responses 面 4，行号清单见「遗留与跟进」O-d）；逐个执行块核对入参，`isStream` / `firstByteLatencyMs` **均 0 命中**。笔记内四处「4 处」（O-d 条目、三类取值段、登记段、R2-2 段）与 `docs/change-log.md` 第 5 条的遗留登记已统一订正。

