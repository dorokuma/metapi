# 变更日志 / Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本约定。
更早的历史变更见 [docs/change-log.md](docs/change-log.md)。

## [Unreleased]

## [1.4.19] - 2026-10-03

### 修复

- **`token-router-dump-retention` 区分 flock 真争锁与环境错误，不再把环境类失败误报成「锁被他人持有」**（`src/server/services/tokenRouterDumpRetentionService.ts`）：`acquireCleanupLock` 此前对 `flock` 的**任何非零退出**都打印同一句 `cleanup lock held by another process`，且**从不读取 stderr** ⇒ 环境类错误（坏 fd、锁文件不可用、文件系统不支持等）被误报为「有其它进程持锁」，把运维引向一个并不存在的持锁进程。
  - **按 stderr 是否非空分类**：stderr 为空 ＝ 真争锁，**原措辞逐字保留**；stderr 非空 ＝ 环境错误，改用新措辞 `flock failed before it could test the lock (not lock contention)`，并把 **stderr 首行**（`split('\n')[0].trim()`，常量 `FLOCK_STDERR_EXCERPT_LIMIT = 120` 字符上限截断、超长补 `…`）透出到同一条 warn。
  - **fail-closed 与返回值语义零变化**：两条分支都 `closeSync(fd); return null;`（跳过本轮清理），只是诊断口径不同；锁的获取 / 释放、调用方 `finally` 里的 `closeSync(fd)` 与清理跳过语义一字未改。
  - **判据依据**：上游 util-linux `sys-utils/flock.c` —— 争锁路径 `case EWOULDBLOCK: case EACCES:` 在非 `--verbose` 时**静默** `exit(conflict_exit_code)`（默认 `1`）；其余所有出口都先 `warn()`/`err()` 到 stderr 再退出，故「stderr 非空 ⇒ 非争锁」成立。并按本服务的实际调用形态（fd 模式 `flock -x -n 3`）在 **util-linux 2.41** 上实测：真争锁 exit 1 且 stderr 空、坏 fd exit 65 且 stderr 非空、`locale` 遍历结论一致。
  - **测试**（改既有文件 `src/server/services/tokenRouterDumpRetentionService.test.ts`）：**先红后绿**——红态失败原文即那句误报；并新增 **stub 命中计数自检**（`flockFailureStub.hits`），一旦调用形态漂移（例如 `-n` 变成 `-xn`）stub 便不再命中，用例必须变红（已实测复现）。
  - **范围与未宣称**：本条只改诊断口径，未改动任何决策 / 重试 / 路由 / 计费语义；**未观测到生产环境出现该误报**，此修复是依据上游机制与实测的分类订正，不声称线上已触发。

## [1.4.18] - 2026-10-03

### 修复

- **失败出口观测列三列收口：`is_stream` / `first_byte_latency_ms` / `client_http_status` 补齐 20 处出口（列级 23 格）**。1.4.16 / 1.4.17 两轮只补了降级出口、8 处流式失败出口与 `handleDetectedFailure` 的 `first_byte_latency_ms`；本轮把 `.agents/notes/20261002-client-visible-failure-semantics.md`「出口 × 三列 全量扫描」表里剩余的 `待补` 项一次性补齐（`is_stream` 5 处、`client_http_status` 15 处、`first_byte_latency_ms` 3 处，其中 3 处出口同补两列）。全部是**纯观测列**：响应码、重试条件、路由选择与计费语义零改动。
  - **外层失败出口 4 处**（`chatSurface.ts` 流式非 SSE 单块出口 / 非流式出口，`openAiResponsesSurface.ts` 同两处）的 `handleDetectedFailure` 调用点补 `first_byte_latency_ms`（取与各自成功出口同源的 `getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null`，语义＝上游响应首字节延迟；未观测到即 `NULL`、**不编造**）与 `is_stream`（取本轮请求解析结果变量，未写死字面量）。
  - **站点并发超时失败行 3 处**（`chatSurface.ts` / `openAiResponsesSurface.ts` / claude count-tokens 处理器）补 `client_http_status = failure.status`（与本出口 respond 同码）与 `is_stream`。
  - **`first_byte_latency_ms` 跨轮次不串值**：四面（chat / responses / rerank / gemini）该变量均提升到 handler 作用域并**每轮轮首重置**，避免上一轮的观测值被下一轮的失败出口写成假延迟；rerank 与 gemini 面新增 / 接上 `onAttemptFailure` **纯观测捕获**（不参与任何选择 / 重试 / 路由 / 计费决策），与 chat / responses 同法。
  - **6 个路由级 `logProxy` helper 追加可选参数**：`geminiSurface.ts` / `embeddings.ts` / `completions.ts` / `images.ts` / `search.ts` 各新增可选参数 `clientHttpStatus`（缺省 `null`）。**成功行调用点一个未改**（不传即行为逐字不变），只有失败行传**真实下发码**：gemini 三处＝本出口 respond 的 `lastStatus`、流式中途失败出口＝`200`（该出口在 `reply.hijack()` 之后、客户端 HTTP 层已收到 200）；embeddings / search / images 两处 catch ＝ `status || 502`（网络类失败 `status = 0`，respond 兜底 502）；completions 一处＝`failure.status`、一处＝`status || 502`；images 两处 malformed 出口＝`502`（结构性无法解析，固定码）。**未使用 `-1` 哨兵**——该哨兵只属 `onDowngrade` 的非终态行。
  - **`is_stream` 5 处**：3 处租约忙（busy 503）行取本轮请求解析真值；count-tokens 与 rerank 端点**结构上非流式**（真值即 `false`，注释说明后传 `false`）。
  - **gemini 端点层失败行的 `first_byte_latency_ms` 补上（口径订正）**：compat 路径的 `!endpointResult.ok` 出口此前写死 `NULL`，理由写作「无 upstream 响应对象」——**不成立**：该 flow 的每次派发都经 `fetchWithObservedFirstByte`（无条件打点），失败响应本身带着观测 meta。现由该面**既有**的 `onAttemptFailure` 钩子按 rerank 同法捕获（handler 作用域变量 + 每轮轮首重置，纯观测、不参与任何决策），端点层失败行落真实首字节延迟；同轮的后续失败行不会沿用上一轮的值。
  - **有意为 `NULL` 的口径（设计如此，不是漏传）**：count-tokens 路径（`handleUpstreamFailure` / `handleExecutionError` 与站点并发超时行）**直接 `dispatchRequest`、不经 `fetchWithObservedFirstByte`** ⇒ 响应上没有观测 meta，该列保持 `NULL`；gemini 外层 catch（`handleGenerateContent` 的 catch）**该处没有 response 对象**（`endpointFlow` 的网络类异常已在内部归一、不冒泡到此；能拿到 response 的端点层失败已由上一条出口落库）⇒ 同列 `NULL`；4 处租约忙行（chat / responses / count-tokens / rerank）未发出上游请求 ⇒ 该列与 `client_http_status` 维持既有 `NULL` 口径。
- **调试库脱敏补齐「长形变体授权头名」词元**（`src/server/services/proxyDebugTraceStore.ts`）：敏感头名**词元**表新增 `authorization` / `authentication`。裸 `authorization` 早在精确名单里，但 `x-authorization` / `authentication` / `x-authentication` 这类**长形变体**切词后得到的是 `authorization` / `authentication`，而 `auth` 词元按**整个短横段**匹配、盖不住它们 ⇒ 这类头名的值此前仍明文落库。**已知过掩码（宁多勿漏）**：`x-authentication-method`（典型值 `basic` / `bearer` / `oauth2`，本身不是凭据）现也替换为 `[redacted]`；不为它加例外表——例外表自身会成为新的漏网面。
- **部署脚本的切换注释改为有界，且 compose 改写窗口纳入恢复路径**（`scripts/deploy-painless.sh`）：脚本每次部署会往 compose 的 `image:` 行上方写两行切换记录（含回滚提示），历次累积后注释块无限增长；现改为**恒 ≤2 条**（含本次新写这条，保留最近的那条旧记录），并且只识别、只删除**本脚本自己生成的两种注释行**——人工手写注释与空行永远不动；插入位置（紧贴 `image:` 上方）、条目文案、以及「找不到 `image:` 行即报错退出」的行为都与改动前一致。另修一处既有缺口：`SWITCHED=1` 提前到**备份成功之后、改写之前**——python 改写与改后的 `compose config -q` 都落在「已备份、未 `up -d`」窗口内，此前若改后校验失败就退出，而 `SWITCHED=0` ⇒ `trap` 不恢复备份，**改写后的 compose 会留在盘上**（容器仍是旧镜像，下次任何人 `up -d` 就静默换镜像）；现该窗口由 trap 走既有回滚路径（恢复 `.pre-*` 备份 → `compose up -d`），**正常路径的步骤顺序、验收与退出码逐字不变**。

## [1.4.17] - 2026-10-03

### 修复

- **流式失败出口补齐 `is_stream` / `first_byte_latency_ms` 观测列**。`recordStreamFailure` 的 **8 处**调用点（`src/server/proxy-core/surfaces/chatSurface.ts` 4 处 + `openAiResponsesSurface.ts` 4 处）此前都没传 `isStream` / `firstByteLatencyMs` ⇒ 这类流式失败写下的 `proxy_logs` 行这两列恒为 `NULL`。现 8 处均按**真实取值**传参：`isStream` 传本轮请求解析结果（chat 面 `requestEnvelope.parsed.isStream` / responses 面 `requestEnvelope.stream`；8 处都在 `if (isStream)` 块内，故运行期恒 `true`，但写法与既有 `onDowngrade` 出口一致、未写死字面量）；`firstByteLatencyMs` 传与各自成功出口同源的 `getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null`（语义 = 上游响应首字节延迟）。**首字节未观测到 ⇒ 保持 `NULL`（不编造）**；8 处上游响应均已在首字节之后，故实际落真实延迟值。
- **已知限制（如实记录）**：上游中途断流路径（body 读取抛异常 → 外层 catch → `handleExecutionError`）的 `first_byte_latency_ms` 仍为 `NULL`（登记项 O8，真因是该变量声明在 `try` 内、catch 作用域取不到），不在本次范围，待后续单独处理。

## [1.4.16] - 2026-10-03

### 修复

- **降级出口观测列补齐：降级行不再两列俱空**。端点降级出口（`onDowngrade`）写下的 `proxy_logs` 行此前 `client_http_status` 与 `is_stream` 都为空，看不出这一行到底是不是终态行。现补写两列：`is_stream` 按本轮实际形态写（流式 `true` / 非流式 `false`）；`client_http_status` 写新增哨兵 **`-1`**（`CLIENT_HTTP_STATUS_NON_TERMINAL`，`src/server/proxy-core/surfaces/sharedSurface.ts`）——降级出口返回后 `executeEndpointFlow` 会 `continue` 去试下一个端点（`src/server/proxy-core/orchestration/endpointFlow.ts`，该分支要求 `!isLastEndpoint`），降级行**永远不是**本请求的终态行，客户端实收状态码由同一请求的终态行给出，故不写猜测值、也不写会与「无法判定」混叠的 `NULL`。**语义边界（已同步进代码注释与笔记）**：该哨兵**只约束降级出口写入的行**，不是整列不变量——降级出口之外的中间/非终态来源各按自己既有口径落库：预重试出口（`handleUpstreamFailure` / `handleDetectedFailure` / `handleExecutionError` 的落库发生在 `maybeRetry` 之前）与 8 处流式失败出口 `recordStreamFailure` 写各自真实状态码；3 处租约超时 busy 出口（`chatSurface.ts` / `openAiResponsesSurface.ts`）与缺列兜底写 `NULL`。列的三取值语义另写入 `src/server/db/schema.ts` 列注释与 `.agents/notes/20261002-client-visible-failure-semantics.md`。
- **调试表 header 落库前对敏感头做值脱敏**。`proxy_debug_traces` / `proxy_debug_attempts` 的 `request_headers_json` / `final_response_headers_json` / `response_headers_json` 此前明文保存 `Authorization` 等凭据（上游 key、下游客户端 token）。现于四条列的唯一落库咽喉 `serializeHeaders`（`src/server/services/proxyDebugTraceStore.ts`）把敏感头的**值**替换为固定占位 `[redacted]`：头名、头次序、非敏感头一字不改；不写定长哈希、也不保留任何原文派生取值（避免弱凭据可离线爆破）。敏感判定 = 精确名单（`authorization` / `proxy-authorization` / `cookie` / `set-cookie` / `x-api-key` / `api-key` / `x-goog-api-key`）+ **词元判定**（`key` / `apikey` / `api-key` / `token` / `secret` / `password` / `passwd` / `credential` / `signature` / `auth`；下划线与空白先归一成 `-` 再按 `-` 切词，**任一词元**命中即敏感）+ 保底子串规则；`x-monkey` / `x-request-id` / `content-type` / `x-client` 等名字不被误伤。调试排障信息（头名、次序与对应关系）不受影响。

## [1.4.15] - 2026-10-02

### 修复

- **客户端可见失败语义（CVF）：带内失败帧不再被静默丢弃**。上游把 provider 失败包成 HTTP 200 + `text/event-stream` 时，失败只写在帧里（实测形 `data: {"error":{"code":"stream_initialization_failed","message":"…status 429…","request_id":"…"},"type":"stream_error"}`），旧判据只认 `type` 为 `response.failed` / `error` ⇒ 认不到 ⇒ 归一化无匹配 ⇒ 上游文本被静默丢弃。判据改为三分类 `classifyInBandFailure`（`src/server/transformers/openai/chat/proxyStream.ts:73`）：`legacy`（改动前就认得的形，逐字保持原判据与原路径）、`new`（顶层 `error` 对象 / `type` 为 `stream_error` / SSE 帧名 `error`）、`null`。`new` 形改走带内失败出口：客户端拿到**上游 payload 原文 + 本仓重建的 SSE 信封**（`event:` 名保留、`data:` 原文逐行前缀）——openai 下游；claude 下游上游帧非 Anthropic 形，改用本仓既有 claude 带内错误帧形（`event: error` + `{"type":"error","error":{"type":"api_error","message":"<上游原文>"}}`）承载同一份原文，**恰好一帧**。失败原因另在**不覆盖原文**的前提下补尾部标识后缀 `(code=…, request_id=…)`（`appendFailureIdentifiers`，取顶层 `error.code` 与顶层 `request_id` / `error.request_id`）。
- **未写字节走 HTTP 层，失败终态不生成终结帧**。`new` / `legacy` 失败帧在「本轮尚未向下游写出任何字节」时不再 hijack 成 200 SSE，只记 `markFailed(上游原文)`，把「状态码 + 上游原文」交给既有 HTTP 层失败出口（**502** + `error.type='upstream_error'` + 上游原文，codex 系据此自行退避）；已写过字节才走带内透传。失败终态下本仓**不再生成终结帧**（openai 的 `data: [DONE]` / claude 的 `message_stop`），仅 **openai 下游**在已写字节时原样回放上游自带的 `[DONE]`（回放条件 `proxyStream.ts:355`）。
- **claude 下游 legacy 老形失败改发 `event: error`（R4）**。`response.failed` + 已写字节 + claude 下游原先经归一化块渲染成 `message_delta{stop_reason:'end_turn'}` + `message_stop`（客户端读作「正常结束（带部分内容）」、服务端记 failed），现改为**恰好一帧 `event: error`**（message = 上游原文 + 后缀）、不含本仓终结帧，已写出的内容原样保留在前（`proxyStream.ts:487-502`）。openai 下游一字未动。
- **网络类异常归一（`endpointFlow`）**：`dispatchAttempt` 里直接 throw 的网络类异常（fetch reject / body 读取异常）归一成与 `!response.ok` 同路径的 `{ok:false,status:502,errText:formatErrorCause(err)}`——客户端可见状态码保持 502，错误 `type` 由 `server_error` 纠正为 `upstream_error`，attempt 记录与 `final_upstream_path` 现在也会落库；重试 / 端点轮换语义不变。
- **已 `reply.hijack()` 的流式失败补 in-band 错误帧**：hijack 后不能再 `reply.code().send(...)`（`ERR_HTTP_HEADERS_SENT`，Fastify 5 只 warn 后丢弃 ⇒ 客户端拿不到任何失败信号），改为写一帧标准错误后 `end()`（openai `data: {"error":{…,"type":"upstream_error","code":502}}` / claude `event: error` + `{"type":"error",…}`，**绝不**追加 `[DONE]` / `message_stop`），且只在「写过帧但无终结事件」时补、只补一帧；未 hijack 出口保持 `reply.code(502).send(...)`。
- **修掉依赖真实时钟的夹具时间炸弹**：`src/server/routes/api/upstreamObservations.test.ts` 的时间锚点由硬编码 `Date.UTC(2026, 8, 25, 7, 0, 0)` 改为由 `Date.now()` 派生（秒精度，`BASE_UTC === BASE_MS` 语义不变）——聚合路由的默认窗口按墙上时钟算（`to = now`、`from = to - 7d`），锚点一旦过期，整组夹具被排出默认窗口，断言不再测它要测的东西。

### 变更

- **空内容判失败默认开启**：`PROXY_EMPTY_CONTENT_FAIL` 默认值 `false → true`（`src/server/config.ts:189-190`，仅显式 `PROXY_EMPTY_CONTENT_FAIL=false` 可关）。开启时上游空内容判为失败（502 JSON + 自写 `Upstream returned empty content`），客户端不会收到「空的成功」；UI 预加载占位值与勾选项文案（`src/web/pages/UpstreamSettings.tsx`）、`.env.example`、`docs/configuration.md` 同步。
- **`proxy_logs` 新增可空观测列 `client_http_status`**（客户端实收状态码）：与 `http_status` 语义分离——`http_status` 是「本轮上游/逻辑状态」（网络层执行失败为 `0`），客户端实收却是出口状态码（同上情形 502/503），SSE 已 hijack 时实收 200 + 流内错误帧。落点为 `src/server/db/schema.ts` + sqlite 迁移 `drizzle/0032_proxy_logs_client_http_status.sql` + 三方言产物与 `schemaContract.json`（可空、无破坏性默认）；写侧 `src/server/services/proxyLogStore.ts`（`has*` 门禁 + 缺列降级只丢该列、绝不丢整条日志；无法判定写 NULL，不写猜测值）、跨库迁移 `src/server/services/databaseMigrationService.ts`。上游原文**落库**另有 64KB 守卫（`guardUpstreamErrorMessageForLog`），且尾部 `(code=…, request_id=…)` 标识后缀**不受截断影响**（`truncateUpstreamErrorMessageWithLimit`）；下发给客户端的 1000 封顶口径不变，带内透传的上游帧不封顶。
- **路由刷新补纯观测埋点**：`[proxy/route-refresh]` 结构化日志 + `getRouteRefreshObservation()`（耗时 / 命中 / 成功 / 失败计数），不改变刷新门禁与选择语义（`src/server/proxy-core/channelSelection.ts`）。

## [1.4.14] - 2026-10-02

### 新增

- 新增「失败不写冷却」总开关 `disable_failure_driven_cooldown`（默认 `false` ＝ 现行为零变化；按严格布尔判定 `=== true`，非布尔取值一律回落到冷却照旧）。开关开启后失败不再产生硬挡，覆盖**四层**：端点级冷却（`site_api_endpoints.cooldown_until` 写入点与读侧判定）、渠道级与 oauth route-unit 成员级冷却（weighted fibonacci 退避 + 写死在代码里的 round_robin 阶梯）、运行时熔断（`SITE_RUNTIME_BREAKER_LEVELS_MS` 阶梯的候选过滤点整段放行，含「多候选全熔断 ⇒ 候选清空」这条硬挡路径）；熔断状态与 `cooldownLevel` 照旧推进/清零，开关关回去时状态诚实。
- **读侧同步放行**：开关开启时**已落库**的失败驱动窗口立即不再挡人（渠道级 / 成员级 `cooldownUntil`、端点级 `cooldownUntil`）；窗口值不删不改写、写入点语义逐字节不动，关回开关即恢复原行为。
- **端点轮换修正**：开关开启时把「本请求已尝试端点」作为选择层排除集（`selectSiteApiEndpointTarget(excludeEndpointIds)`），避免因不再写冷却而丢失同请求内的端点故障转移；默认关闭时不传该集合，既有「冷却兜轮换」路径不变（4xx/429 今天不轮换的行为也不变）。
- **上游指令型冷却保留**：配额 / 限流 reset hint 与 provider-directed 窗口照旧生效（判据收敛在 `shared/failureDrivenCooldownSwitch.isProviderDirectedCooldownShape`，与 `channelRecoveryProbeService.isProviderDirectedCooldown` 同源，避免两份判据漂移）；失败观测照旧落库（`fail_count` / `last_failed_at` / `last_failure_reason` / 代理日志 / 熔断状态），软性排序权重（`SITE_RUNTIME_MIN_MULTIPLIER` 等）不动。
- **已知残留（如实记录）**：读侧判据用「当下」失败计数（`failCount` / `consecutiveFailCount` / `cooldownLevel` 全为 0 才算上游指令型），未加窗口来源列 ⇒ 若一条配额窗口在途期间恰有非配额失败落库，该残留上游窗口也会被一并忽略（fail-open，下一次同渠道配额 429 即自愈）；彻底消除需 schema 加「来源」列，超出本次范围。详见 `.agents/notes/20261001-failure-cooldown-master-switch.md`。

### 变更

- 运行时设置接线：env `DISABLE_FAILURE_DRIVEN_COOLDOWN`（默认 false）、`PUT /api/settings` 的校验与落库、库值水合（非布尔保留现值）与运行时回显。

## [1.4.13] - 2026-10-01

### 修复

- 重试耗尽不再一律回 503 `No available channels for this model`，改为回传最后一轮失败的真实原因（真实状态码 + 上游/本地报错原文，message 截断至 1000 字符并附 `...(truncated)`，按码点截断；截断应用于 **7 处**末轮 message 出口——两条 surface 各自的 finalize 两档（`chatSurface.ts:278`/`:295`，改后 `:279`/`:296`；`openAiResponsesSurface.ts:229`/`:246`，改后 `:230`/`:247`）与共享工具包三个终态 respond 出口（`handleUpstreamFailure`/`handleDetectedFailure`/`handleExecutionError`，`sharedSurface.ts:821`/`:878`/`:927`，改后 `:878`/`:935`/`:984`）；**这一枚举不等于「全部客户端可见末轮出口」**：`chat` 面 4 处流式失败 502（`chatSurface.ts:947`/`:1007`/`:1112`/`:1190`；**已由同批补上封顶，见下条**）与 `geminiSurface.ts:1434-1437`/`:807` 当时仍原样透传、未封顶（详见笔记第 5 节与「遗留与跟进」））：覆盖 `/v1/chat/completions`、`/v1/messages`、`/v1/responses`。错误 `type` 按「有无真实上游 HTTP 响应」分流——有 ⇒ `upstream_error` + 真实状态码（上游 401/403 原样回传），无 ⇒ `server_error` + 合成 502/503；首轮即无可用通道仍保持原 503 文案。
- 无真实上游响应时的错误类型统一：共享故障工具包的执行失败终态（网络层失败）由 `upstream_error` 改为 `server_error`（状态码沿用 502），与两条 surface 出口同口径。
- 补齐流式失败 502 出口的 message 封顶：`chatSurface.ts` 主 handler 的 4 处 `!streamStarted` 流式失败出口（改后 `:971`/`:1031`/`:1136`/`:1214`）此前原样下发 `streamResult.errorMessage`，现统一套用共享的 `truncateUpstreamErrorMessage`（≤1000 + `...(truncated)`；为不把 `null` 改成空串，改用保留空值的包装 `truncateStreamFailureMessage`）。状态码 502、`error.type=upstream_error` 与响应结构不变。**说明**：这 4 处出口的封顶在**集成夹具内不可构造**（上游 `error`/`response.failed` 帧被 `force` 写成 200 SSE 流 ⇒ `streamStarted=true` ⇒ 4 处 `!streamStarted` 出口不可达；夹具唯一可达源是本地 `Upstream returned empty content`）；**生产未证实可达、也未证实不可达**（2xx + JSON + `type:'error'` 体在 `PROXY_EMPTY_CONTENT_FAIL` **当时默认 false**（**该默认值已于 2026-10-02 改为开**：`src/server/config.ts:189-190` 默认 `true`，仅 `PROXY_EMPTY_CONTENT_FAIL=false` 可关闭；开＝空内容判失败、客户端不会收到空成功）且 `proxyErrorKeywords` 默认空时会走 `consumeUpstreamFinalPayload → markFailed(上游 payload)`，其 message 为上游原文）。封顶保留；新增用例锁的是出口不变量而非「上游超长被截断」（详见笔记「遗留与跟进」第 1 条）。⇒ **未封顶的客户端出口只剩 `geminiSurface.ts:1434-1437`/`:807` 两处与 6 个 route（embeddings / images / completions / videos / search / rerank）的错误体**，本片未动。

### 变更

- 重试耗尽运维标记改为 `events` **独立 title 直查**（方案 A，本批**不再新增任何 `proxy_logs` 行**）：chat / responses 两条 surface 的「重试耗尽」出口（`chatSurface.ts:455`、`openAiResponsesSurface.ts:401`）在既有 `reportProxyAllFailed` 之后、`finalizeDebugFailure` 之前，**直插一条自己的 `events` 行**（`db.insert(schema.events)`，形态同 `routes/api/sites.ts:409-416` / `services/checkinService.ts:187-195` 先例；**不经 `evaluateAggregatedNotification`、不推送**），title 为模块级常量 `'代理重试耗尽'`（`RETRY_EXHAUSTED_EVENT_TITLE`，定义在 `src/server/shared/eventTitles.ts:14`；与「代理全部失败」各自成组——聚合签名是 `level||title`），`type='proxy'`、`level='error'`、`relatedType='route'`（同 `reportProxyAllFailed` 体例、不挂 id）。⇒ 「重试耗尽」从此可 `SELECT * FROM events WHERE title = '代理重试耗尽'` 1:1 直查（可加 `AND created_at >= datetime('now','-1 day')` 时间窗）；`events` 无结构化列，状态码 / 模型 / 轮次 / 已试通道等上下文进 `message` 文本（实测原文见笔记 §1）。**每轮重试耗尽只写一条**；**A 形态**（首轮真无通道、`lastRetryFailure` 为空）**不写**；写入失败只 warn ⇒ **不影响客户端响应路径**。**该行已从通知中心口径摘除**：服务端 `routes/api/events.ts` 的两个读接口（列表 `GET /api/events`、未读计数 `GET /api/events/count`）按 title 排除本行 ⇒ **不出现在通知面板列表、不计入未读徽标/计数**；**标记行仍照常落库、仍可 `SELECT * FROM events WHERE title = '代理重试耗尽'` SQL 直查**（写侧未改，落库仍显式 `read: true`，`/api/events/:id/read`、`/read-all`、`DELETE` 也不改）。**曾短暂存在挤占风险**（此前口径：落库即已读 ⇒ 不计入未读数，但**仍占最近 30 行窗口的 1 个位次**，高频风暴下可能把真告警挤出面板列表、并使徽标计数窗口被占），**已由本片按 title 排除修复**；⇒ 原「**发版后观察**：盯占比、若挤占再决定排除」这一待办**已闭环、不再需要**。**副作用**：`/api/events` 是同一列表接口，程序日志页（`ProgramLogs.tsx:117`）也不再显示本行——唯一入口是 SQL 直查。精确口径见笔记 §1。
- **为何不走 `proxy_logs`（本批初稿路线已整条拆除）**：`proxy_logs` 是 attempt / 请求级表，任何新增行都会被既有统计消费方计入——失败数（`dashboardSnapshotService.ts:138-139`、`dailySummaryService.ts:87`、`downstreamApiKeys.ts:289`/`:377`、`downstreamApiKeyTrendService.ts:195`/`:287`）、请求数（`dashboardSnapshotService.ts:155-170`、`stats.ts:1205-1215`）、延迟样本与站点/小时/模型投影（`usageAggregationService.ts:347-360`/`:387-388`/`:424`/`:447`/`:469`）、可用率分母（`statsShared.ts:179`/`:229`）；而该表**没有**可忽略位（无 `internal`/`exclude_from_stats` 一类列，`schema.ts:246-289`；`status` 只有 `success|failed|retried`，消费方一律按「非 success 即失败」计）⇒ 无法在不改聚合代码的前提下新增行。**`events` 则无任何统计消费方**（消费方全清单见笔记 §3：只有写入 / 按 `eventId` 维护自己的行 / 保留期清理 / 复位 / 迁移 / 运维列表读），故方案 A 既满足「可直查」又不污染统计。初稿为它加的 `SurfaceRetryLogContext` / `buildSurfaceRetryLogContext` / `SurfaceRetryTerminalFailure.logContext`（12 个留存点）与 `writeSurfaceProxyLog` / 工具包 `log` 的可选 `siteId`（已无使用者）**全部删除**，`git diff` 中不再有任何 `proxy_logs` 标记写入或 `logContext`/`siteId` 管道。
- **未覆盖（已知）**：判别器只覆盖「本轮失败可重试、下一轮已选不出通道」这一形态——末轮直终态（`retryCount == maxRetries`，多通道下「最后一个通道也失败」是常态）、固定通道模式、`count_tokens` handler、`geminiSurface` 与 6 个 route 均**不写**该行（措辞沿用片 1 笔记 §2 的 O3 形态划分，未改动片 1 笔记）；**出口处拿不到 route / 站点 / 延迟**（它们原先只存在于本批已拆除的上下文快照里），故 `message` 只带出口当时确实可得的上下文（模型 / 上游路径 / 流式标记 / 轮次 / 已试通道 id / 固定通道 id）——**若产品要这三项进 message 需显式拍板**（见笔记「遗留」2）；responses 面落库只由类型检查兜底（无 responses 侧落库用例）。`events` **默认不被定期清理**（程序日志清理默认关闭，`config.ts:97`；打开则按 30 天，`config.ts:98`）而 `proxy_debug_traces` 只留 **24 小时**（`config.ts:156`）⇒ **按事件回查 trace 的窗口是 24h**；**行数增长 ≤ 失败请求速率**（仅本出口 1:1 写一行、无合并/去重；末轮直终态/固定通道/`count_tokens`/`geminiSurface`/6 route 不写本标记；`events` 默认永不清理）⇒ 边际成本 **+1 行/失败请求**（同一请求本就会写一条 `proxy_logs` 失败行）；此前「≈42 行/周」是低频观测、**不是上限**；**查不到时**（A 形态等不写本标记）的下一步与 `tried_channels` join 指引见笔记「遗留与跟进」第 4 条。初稿的 `proxy_logs` 行**从未发版**（只存在于未提交工作区），无需数据迁移 / 回填。详见笔记「遗留与跟进」。

## [1.4.12] - 2026-10-01

### 修复

- 端点冷却：任何 4xx（含边缘返回的 429/408）不再写端点冷却，且不触发冷却的失败改为保留已有冷却而非清空——单端点站点不再被一次 4xx 拉黑成整站 503 且无法自愈。
- 通道级与 oauth 成员级路由：冷却期内到账的失败复用已有窗口，不再把 cooldown_until 写成 NULL；round_robin 未跨阈值时同样保留已有窗口。
- 新增设置 site_api_endpoint_cooldown_sec（默认 60s，上限 3600s）。
- 上游失败记录保留 Error.cause 链，便于归因 fetch failed 的真实原因。

## [1.4.11] - 2026-09-29

### 修复

- token 路由 dump 清理锁改用内核 `flock(2)`：废弃伪 CAS/陈旧锁接管；进程崩溃后由内核即时释放锁、活进程持有期间不被抢占；非 Linux / 无 flock 环境 fail-closed 跳过清理（warn）。

### 变更

- `scripts/deploy-painless.sh` 人工清单补充「存量裁剪」提醒（DB 快照留最新 7 个、镜像只留当前发版版本）。

## [1.4.10] - 2026-09-29

### 修复

- 多 key 轮换修复：单 key 瞬态失败（502/429/超时）不再连坐同站其它 key（token 级隔离、模型级熔断仅按模型级失败门控）；全部候选被挡时才判死（返回空候选，不再回退放行）；恢复逐 key 独立生效。

## [1.4.9] - 2026-09-28

### 变更

- 使用日志（ProxyLogs）表格新增速度列并压缩列宽。

## [1.4.8] - 2026-09-28

### 修复

- 生产依赖漏洞清零：`npm audit --omit=dev --audit-level=high` 由 13 项（其中 11 项 high）归零，覆盖 nodemailer 的 SSRF / 头注入 / TLS 校验类与 fastify / undici / ws 的 SSRF 绕过与 DoS。

### 变更

- 依赖升级：11 项补丁/次版本（`fastify` 5.12.5、`undici` 6.29.0、`ws` 8.22.0、`js-yaml` 4.3.2、`mysql2` 3.24.4、`ip-address` 10.7.2、`electron-updater` 6.8.9 等）。
- 依赖升级：`@fastify/static` ^10.1.5、`nodemailer` ^10.0.12（均为大版本）。`@fastify/static` v10 的 `setHeaders` 首参由 `ServerResponse` 变为 `FastifyReply`，缓存头改用等价的 `reply.header`。

## [1.4.7] - 2026-09-28

### 新增

- 站点分布与趋势图新增「词元」维度：`site_day_usage.totalTokens` 接入站点级分布/趋势 API 与前端图表，支持「词元趋势」「词元分布」切换展示。

### 修复

- MySQL 长文本列不再生成 DEFAULT 子句（TEXT 列带 DEFAULT 违反 MySQL 约束致 schema 门禁必红），并修 live 测试方言兼容（`.returning()`）与 BIGINT 断言类型。

### 变更

- CI：未配置 Docker Hub secrets 时发布 job 自动跳过（guard job 模式）；`npm audit` 在 push 路径降级为报告输出，不再阻断（跟进责任已登记 .agents/notes）。

## [1.4.6] - 2026-09-28

### 新增

- 词元用量重建与聚合投影：`proxy_logs` 用量列语义重构，presence 化解析与六写入点归一接线；聚合投影层落地，支持站点级用量统计。
- 单站点守卫收紧、快照 backup 七键三态、SQLite 哨兵 -1 自增语义断言、站点序列三方言矩阵 live 接线。

### 修复

- SQLite bootstrap 缺失 `AUTOINCREMENT`：`sqlite` 引擎初始化时未加 `AUTOINCREMENT` 导致 ID 不自增，现已修复。
- Drizzle journal 0005 断档与快照链头刷新：journal 序号跳号致 migrate 断档，0005 补齐；快照链头未刷新致 upgrade 误判，已修正。
- Upgrade 产物空步归正：upgrade 生成器在空迁移步骤时输出空文件，现归正为跳过空步。

### 变更

- 集成 main 分支 1h 缓存列（cc1h）：`cache_creation_tokens_1h` 列贯通四调用点（completions 流式/非流式、embeddings、sharedSurface），保持既有口径。

## [1.4.5] - 2026-09-27

### 修复

- new-api 站点 token 级模型发现合并用户级模型列表：token 实际可调用但 `/v1/models` 不暴露的模型（经 `/api/user/models` 用户级列表发现）现会写入 token 可用模型并参与路由，修复此类模型无法被路由选择的问题。

### 变更

- 依赖升级：`better-sqlite3` 13、`electron-builder` 26.15。
- Node 最低版本要求调整为 22.15（engines >=22.15.0，CI NODE_VERSION 为 22.15）。

## [1.4.4] - 2026-09-27

### 修复

- 首字节超时清理改为有界取消：`reader.cancel()` 在 body 来自 `tee()` 分支时可能永不 settle，清理路径原先无界等待会把合成 408 响应一并挂住；现统一经 `settleReaderCancelQuietly`（默认 250ms 上限，并吞掉取消失败与迟到的 rejection）。

## [1.4.3] - 2026-09-27

### 修复

- 启动横幅不再回显令牌明文：`startupInfo` 的 Admin/Proxy curl 示例此前把 `AUTH_TOKEN` / `PROXY_TOKEN` 明文写进 stdout 与 `docker logs`，现改为 `$AUTH_TOKEN` / `$PROXY_TOKEN` 占位，并新增「横幅不含 Bearer 明文」回归断言。

### 变更

- 通知设置页：全局模板标签由「全局（兜底）」精简为「全局」。
- 通知设置页：全局模板上下文不再显示「已定制」圆点——该层本无覆盖语义，「已定制」字样会误导；代价是全局层不再逐渠道标注是否已配置，需点开渠道查看。

## [1.4.2] - 2026-09-27

### 修复

- 计费修复：支持上游 `tiered_expr` 表达式计费，新增安全表达式求值器替代占位 `model_ratio` 平铺多计；`billing_details` 增加 `pricingSource` 标记与可审计回退。

## [1.4.1] - 2026-09-27

### 修复

- 修复 pi（OpenAI 流）thinking 签名回传：`reasoning_details` 闭环，消除 thinking 模式 `The content[].thinking ... must be passed back` 类 400。上游 Anthropic 流的 `signature_delta` 缓冲后随 thinking 文本以一条流式 `reasoning_details` chunk 下发（先于 `finish_reason`/`[DONE]`），pi 存储并回传，入站还原为 `thinking.signature`；涉及 transformers：`chatFormatsCore` / `openai/chat/proxyStream` / `anthropic/messages/conversion`。

## [1.4.0] - 2026-09-24

### 新增

- 通知模板支持按事件类型定制：新增 `notification_templates` 表（主键 `(event_type, channel)`，字段 `title` / `body` / `parse_mode`），替换原先存放在 `settings.notification_templates_v1` 的扁平 JSON。
- 新增 `daily_summary`（每日总结）事件类型及专属模板变量：`local_day`、`generated_at_local`、`total_accounts`、`active_accounts`、`low_balance_accounts`、`checkin_total`、`checkin_success`、`checkin_skipped`、`checkin_failed`、`proxy_total`、`proxy_success`、`proxy_failed`、`proxy_total_tokens`、`today_spend`、`today_reward`、`today_net`。
- 模板解析顺序调整为：`(eventType, channel)` 精确匹配 → `(__global__, channel)` 兜底行 → 各渠道原有硬编码默认渲染。

### 变更

- `GET` / `PUT /api/settings/runtime` 的 `notificationTemplates` 由「渠道 → 模板」改为「事件类型 → 渠道 → 模板」两层结构；新增 `notificationTemplateVariablesByEvent` 字段说明各事件类型可用变量。
- `sendNotification()` 新增必填 `eventType` 参数（无静默默认值），全部调用点显式传值：`alertService`（token / proxy）、`siteAnnouncementService`（site_notice）、`checkinService`（checkin）、`checkinScheduler` 每日总结（daily_summary）、`updateCenterPollingService` 与 `backgroundTaskService`（status）、设置页测试通知（`__global__`）。
- 通知设置页的模板编辑从「渠道 Tab」改为「事件类型 × 渠道」矩阵：未单独定义的类型/渠道直接展示并编辑全局模板，支持一键继承全局与恢复继承，保留变量说明与实时预览；`daily_summary` 下额外提供专属变量。
- `events.type` 白名单扩展 `daily_summary`（事件筛选与标签同步更新）。

### 修复

- 数据库 schema 生成器支持复合主键：多列主键输出表级 `PRIMARY KEY (a, b)`，避免逐列内联产生非法的 "more than one primary key" DDL。
- **双审整改（推送模板按事件定制）**：
  - legacy 模板迁移（`settings.notification_templates_v1` → `notification_templates`）不再「事务内全表 delete 再 insert」，改为只补齐缺失的 `__global__` 行的幂等写入（SQLite/Postgres `ON CONFLICT DO NOTHING`，MySQL `ON DUPLICATE KEY UPDATE` 等价写法）：任何情况下都不会删除或覆盖已有的事件覆盖行，多实例并发下也不会丢行；迁移成功后删除 legacy 键的逻辑保持幂等。
  - 模板热路径（每条通知一次）新增进程内迁移标记：启动迁移成功后不再查询 settings，只有备份导入 / 恢复出厂入口会重置该标记，导入旧版备份后重迁移只补 `__global__`、不删事件行。
  - 通知设置页状态机修复：未定制的事件上输入或点击专属变量 chip 时，会先在该事件上创建独立覆盖（不再静默写回全局模板）；「全局为空 + 一键继承全局」不再死锁，覆盖行的判据改为「该事件在 payload 中存在覆盖行」而不再凭模板内容判空；保存后本地状态与服务端语义一致（空覆盖行视为继承）。
  - 备份（`exportBackup` / `importBackup` 的 preferences 段落）纳入 `notification_templates` 表：导出全部行（含事件覆盖），导入按「恢复备份中的行」处理；恢复出厂已清表的逻辑保持一致。
  - MySQL 侧 `notification_templates` 的 `title` / `body` / `parse_mode` 三列通过显式长文本标记保持 `TEXT`（不再因为带默认值被映射成 `VARCHAR(191)`），模板正文不再有 191 字截断；仅主键或历史 DDL 确有 `VARCHAR(191)` 定义（带默认值）的列保持 `VARCHAR(191)`，既有表（如 `sites.status`、`events.level`、`token_routes.routing_strategy` 等）列型与存量库逐字节一致、不受影响；`mysql/postgres.bootstrap.sql`、`mysql/postgres.upgrade.sql`、`schemaContract.json` 已同步重新生成。
  - `parseNotificationTemplatesInput` 上提历史扁平格式兼容（顶层为渠道键时归一化成 `__global__` 层），`PUT /api/settings/runtime` 收到扁平 payload 返回 200；`saveNotificationTemplates` 与解析共用同一处扁平兼容实现。
  - `sendNotification` 的必填 `eventType` 前置到 `level` 之前，全部调用点同步更新；移除 `loadNotificationTemplatesForEvent` 对非法 `eventType` 静默降级为 `__global__` 的行为，改为显式报错。
  - 模板回退改为字段级：事件行只定义 `body` 时，`title` / `parseMode` 从 `__global__` 行继承，两级都缺省时才走渠道硬编码默认渲染。
- 流式响应补发终态 usage chunk（`a21e8d5`）：`stream_options.include_usage` 在 openai chat 流式会话中此前只被解析、没有下传到流上下文，上游只在收尾帧（`choices: []` 单帧）给出 usage 时该帧会被整体丢弃；现在该标记随流会话传递，并在 `[DONE]` 之前补发一条 `choices: []` 的终态 usage chunk，失败流与空内容流不会补帧。

### 迁移说明

- 升级时自动把 `settings.notification_templates_v1` 的旧 JSON 拆分为 `(__global__, channel)` 行并删除旧键，老用户推送模板行为不变；迁移幂等，重复执行无副作用。
- Schema 变更三处同步：Drizzle schema（`src/server/db/schema.ts`）、SQLite migration（`drizzle/0029_notification_templates.sql`）、checked-in schema artifacts（`src/server/db/generated/*`）。
