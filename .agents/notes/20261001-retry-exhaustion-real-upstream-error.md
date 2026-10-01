---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "proxy-core, routes, services, docs"
---

# 重试耗尽回传真实原因（片 1）：类型分流与 503 观测口径收窄

## 一句话结论

`/v1/chat/completions`、`/v1/messages`、`/v1/responses` 三面在**重试耗尽**（本轮失败后重试仍可继续、但下一轮已选不出通道）时，不再一律回 **503 `No available channels for this model`**，而是回传**最后一轮失败的真实信息**（真实状态码 + 真实报错 message，message 截断 ≤1000 字符）。错误 `type` 按「**有无真实上游 HTTP 响应**」分流：**有** ⇒ `upstream_error` + 真实状态码（含上游 401/403，原样回传为**显式决定**）；**无** ⇒ `server_error` + 合成 502/503。**首轮真无可用通道仍保持原 503 原文案**。随之外溢的一个后果是**观测口径必须收窄**：`proxy_debug_traces.final_http_status=503` 已不再等价于「无通道」，trace 侧无法区分「重试耗尽」与「普通终态上游失败」，唯一干净的判别器变成 `events.message LIKE '%retry exhausted: HTTP%'`（它只覆盖**重试耗尽**形态：租约忙/并发超时的**直终态**只写 trace、不写 events；且受聚合器保留集「[第 1, 第 2, 最新]」的顶替与 200 字符截断约束，判别是**时间窗内**的）；`%No available channels after retries%` **只在 chat/responses 主 handler 内**等于「首轮真无通道」；该串在**全仓仍有另外 8 处**写入（`count_tokens` 分支、6 个其它 route 的 events reason、`rerank` 的客户端 503 体），故 events 命中该串**不能反推** A 形态（逐处 file:line 见 §5）。

## 背景

- **原症状**：网络层失败（`fetch failed`、端点池全冷却、站点并发忙）在单通道路由下会走「重试把失败通道排除 → 下一轮选不出通道」的出口，最终被统一改写为 503 `No available channels for this model`，把真实原因（429/500/网络错误原文）掩盖掉；下游只能看到「无通道」，运维也无法从客户端侧归因。本片让该出口回传真实原因。
- **类型分流规则（用户已定）**：**有**真实上游 HTTP 响应 ⇒ `upstream_error` + 真实状态码；**无** ⇒ `server_error` + 合成 502/503。
- **与既有笔记的关系（本记录只做**部分收窄**，不整篇取代）**：受影响的旧条目是 `20261001-post-1412-observe-trace503-and-setting.md` §1 的两条观测口径（「正确签名 = `final_http_status=503`」「第二条独立观测线 = `%No available channels after retries%`」）与 `20261001-canary-controlled-4xx-endpoint-cooldown-verified.md` §4.1（实测实例的客户端形态）、§6（「单通道路由 + 重试耗尽仍产出同一 503」跟进项）。旧笔记的其余条目（不写自己的 `proxy_logs` 行、events 是聚合+延迟视角、覆盖盲区等）**仍然有效**。依据 `.agents/notes/README.md`「只在旧笔记**被新方案取代**时才挂 `superseded`/`superseded_by`，且禁止改写或删除旧笔记内容」：本片属部分收窄，给旧笔记挂整篇 `superseded` 会把仍有效的条目一并标死（误标），故**旧笔记一字未改（含 frontmatter）**，收窄内容一律以本记录为准，逐条对照见第 3 节。

## 决策

### 1. 变更本身（已实现，有用例锁）

**覆盖面（三面）**：
- `/v1/chat/completions` 与 `/v1/messages` 共用 `handleChatSurfaceRequest`（`src/server/proxy-core/surfaces/chatSurface.ts:302`，路由接线 `src/server/routes/proxy/chat.ts:9` / `:11` / `:16`）；
- `/v1/responses`（含 `/v1/responses/compact`）走 `handleOpenAiResponsesSurfaceRequest`（`src/server/proxy-core/surfaces/openAiResponsesSurface.ts:268`，路由接线 `src/server/routes/proxy/responses.ts:29` / `:38` / `:41` / `:47`）。

**机制**：每轮把「仍可重试的终态失败」留存下来，等到下一轮选不出通道时用它回传，而不是用 503 掩盖。
- 留存变量：`chatSurface.ts:420`、`openAiResponsesSurface.ts:374`（`SurfaceRetryTerminalFailure`，类型定义 `src/server/proxy-core/surfaces/sharedSurface.ts:678-687`）；chat 主 handler 内共 **6 个赋值点**：`chatSurface.ts:754`（通道租约忙）、`:1070` / `:1300`（上游内容判定失败，流式/非流式）、`:1373`（站点并发超时）、`:1425`（端点池/上游失败）、`:1455`（执行失败兜底）；responses 面同样 6 个：`openAiResponsesSurface.ts:889` / `:1108` / `:1390` / `:1472` / `:1508` / `:1538`。
- 出口（重试耗尽）：`chatSurface.ts:435-444`、`openAiResponsesSurface.ts:389-398`——命中时按留存值回传真实**状态码 + payload + upstreamPath**（`chatSurface.ts:442` / `:443`），并把 `events` 原因写成 `retry exhausted: HTTP <status>: <message>`（`chatSurface.ts:440`、`openAiResponsesSurface.ts:394`）；留存值为 `null` 时才落到原来的 503 分支（`chatSurface.ts:445-457` / `openAiResponsesSurface.ts:399-410`）。

**截断口径（≤1000 字符）**：`sharedSurface.ts:648`（`UPSTREAM_ERROR_MESSAGE_MAX_LENGTH = 1000`）、`:651`（`UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER = '...(truncated)'`）、`:657-673`（`truncateUpstreamErrorMessage`，按 **Unicode 码点**截断，代理对整体取舍、不切出孤立代理对；纯 ASCII 场景长度正好等于上限）。应用点（共 **7 处** = 两条 surface 各自的 finalize 两档 + 工具包三个终态出口；初稿写「共 5 处」且声称「覆盖**全部**客户端可见的末轮失败 message 出口」，数量与范围都不准，已改正）：`chatSurface.ts:278`（`finalizeRetryAsUpstreamFailure`，有上游响应档）、`chatSurface.ts:295`（`finalizeRetryAsExecutionFailure`，无上游响应档）、`openAiResponsesSurface.ts:229` / `:246`（同两函数）、**工具包三个终态 respond 出口**（`handleUpstreamFailure` `sharedSurface.ts:821`、`handleDetectedFailure` `:878`、`handleExecutionError` `:927`）。**这 7 处不等于「全部客户端可见的末轮失败出口」**（初稿的「覆盖全部」主张过宽，已改正）：至少还有 in-domain 的 `chatSurface.ts` **4 处流式失败 502 出口**（`:947` / `:1007` / `:1112` / `:1190`，message 取自上游 SSE 帧 / 流会话 failed 结果，**未封顶**）与范围外的 `geminiSurface.ts:1434-1437`（`endpointResult.errText`）、`:807`（`readRuntimeResponseText`，原样透传）**未封顶**，逐条见 §5 与「遗留与跟进」。⇒ 不再存在「工具包出口整段回传、只有重试耗尽出口封顶」的过时说法（`handleUpstreamFailure` 的 `errText` 来自 `readRuntimeResponseText`，无大小上限，是本片封顶的重点）。

**类型分流（逐出口）**：

| 场景 | 出口（真实 file:line） | 状态码 | `error.type` |
| --- | --- | --- | --- |
| **有**真实上游响应（含 401/403、429、5xx），重试耗尽 | `finalizeRetryAsUpstreamFailure`：`chatSurface.ts:272-284`、`openAiResponsesSurface.ts:223-235` | 上游真实状态码 | `upstream_error` |
| **有**真实上游响应（真实状态码） | `handleUpstreamFailure` `sharedSurface.ts:760-827`（message `:821`） | 上游真实状态码 | `upstream_error`（**类型本片不动**） |
| 上游内容判定失败（**状态码由检测逻辑合成，非上游真实码**） | `handleDetectedFailure` `sharedSurface.ts:828-884`（message `:878`；`detectProxyFailure` 恒返回 `status: 502`，`src/server/services/proxyFailureJudge.ts:170-201`） | 合成 **502** | `upstream_error`（**类型本片不动**） |
| **无**真实上游响应（网络层执行失败） | `finalizeRetryAsExecutionFailure`：`chatSurface.ts:289-301`、`openAiResponsesSurface.ts:240-252`；工具包终态 `sharedSurface.ts:922-932` | 合成 502 | `server_error` |
| **无**真实上游响应（通道/站点租约忙） | 租约忙出口 `chatSurface.ts:762-773`、`openAiResponsesSurface.ts:897-908` | 合成 503 | `server_error` |
| **无**真实上游响应（站点并发超时） | `chatSurface.ts:1381-1383`、`openAiResponsesSurface.ts:1480-1482` | 合成 503（真值来自 `getSurfaceRequestFailure`，`sharedSurface.ts:221-247`；其前 `:213-219` 是 `runWithSurfaceSiteConcurrency`，勿把 `:215` 当本函数起点） | `server_error` |

**上游 401/403 原样回传是显式决定**：401/403 属**可重试**状态（`shouldRetryProxyRequest` 对 401/403 返回 `true`，`src/server/services/proxyRetryPolicy.ts:87-96`，401/403 在 `:90`）——语义是「这条通道的凭据/权限有问题，换通道还有机会」；换完仍全部 401/403 时，若改写成 503/`server_error`，就把「上游账号权限问题」误读成「网关无通道」，归因直接失真。故显式选择原样回传真实 401/403 + 上游原文。**已知风险（须知情）**：OpenAI 兼容客户端常把 401 直译成「你的 API key 失效」，而这里的 401 来自上游站点而非下游调用方，客户端可能给出误导性提示。**风险接受与否属产品判断，本片只记录；未做客户端行为实验。**

**首轮真无可用通道**：`!selected && !lastRetryFailure` 时保持原 503 + `No available channels for this model`（`chatSurface.ts:445-457`、`openAiResponsesSurface.ts:399-410`；文案来源 `src/server/proxy-core/channelSelection.ts:71-77`——**`:74` 是 null 档（非固定通道）文案**，**固定通道模式文案在 `:76`**；旧笔记 / canary §4.1 引用的 `:74` 指的正是 null 档那句（其自身语境无误），本笔记初稿把 `:74` 误标成固定通道档，已改正）。

**同批的范围外一致性修复（1 处）**：工具包执行失败终态（网络层失败，无真实上游响应）原本产出 `type: 'upstream_error'` + 502，与两条 surface 侧出口（`finalizeRetryAsExecutionFailure`）同场景不同型，属「同一网络层失败因出口不同而类型不一致」。已核对其全部 **3 个调用点**——`chatSurface.ts:1440`、`chatSurface.ts:1909`、`openAiResponsesSurface.ts:1523`——三者都在「排除掉站点并发超时（`chatSurface.ts:1360` / `:1843`、`openAiResponsesSurface.ts:1459`）与端点池失败（`isSiteApiEndpointFailure`：`chatSurface.ts:1385-1391` / `:1863-1869`、`openAiResponsesSurface.ts:1484-1489`）之后」的 catch 兜底分支里，即**均无真实上游 HTTP 响应**；确认为真后改为 `server_error`（状态码沿用 502，`sharedSurface.ts:922-932`，`type` 在 `:928`）。为通过类型检查，`SurfaceFailureResponse` 的 `type` 由字面量放宽为 `'upstream_error' | 'server_error'`（`sharedSurface.ts:35-45`，`:42`）。`handleUpstreamFailure` / `handleDetectedFailure` 的**类型保持 `upstream_error` 未动**（它们承载真实状态码/真实上游内容判定）；但本片对**三者的 message 一并做了 ≤1000 封顶**（`:821` / `:878` / `:927`，见上文「截断口径」），只改长度、不改类型与文案前缀。

### 2. 观测口径收窄（本节是重点）

改后 **chat/responses 主 handler 仍能产出 503 的只剩四类**（`count_tokens` 是第三个 handler，见第 5 节未覆盖面），逐类来源与证据行号：

- **A 首轮真无通道**（含固定通道模式）：`chatSurface.ts:445-457`、`openAiResponsesSurface.ts:399-410`。trace = failed/503；`events` 原因 = `No available channels after retries`（`chatSurface.ts:448`、`openAiResponsesSurface.ts:402`）。**这类没有「导致它进入分支的那次失败 attempt」**，`proxy_logs` 里也不会有对应行。
- **B 并发租约忙**（通道/站点会话槽）：`chatSurface.ts:738-773`（忙文案 `:743`，503 留存 `:754-758`，终态 `:762-773`）、`openAiResponsesSurface.ts:873-908`。文案 = `Channel busy: waited …ms for an available session slot`（`buildSurfaceChannelBusyMessage`，`sharedSurface.ts:195-199`）或 `Site busy: …`（`buildSurfaceConcurrencyBusyMessage` 的 site 档，`sharedSurface.ts:201-208`）。仍可重试 ⇒ 下一轮选不出通道 ⇒ 由**重试耗尽出口**以 503 + 该文案回传（`chatSurface.ts:435-444`）。**改前的行为是回 A 的文案（`No available channels for this model`）**，即把一个「自己租约忙」说成「没有通道」；改后文案变为 `Channel busy: …`。
- **C 站点并发超时**：错误源头 `src/server/services/siteApiEndpointService.ts:429-434`（构造 `SiteApiEndpointRequestError`，`status: 503` + `siteConcurrencyTimeout: true`）；surface 出口 `chatSurface.ts:1360-1384`、`openAiResponsesSurface.ts:1459-1483`；文案经 `getSurfaceRequestFailure`（`sharedSurface.ts:221-247`）取 `rawErrText || err.message`，实际形如 `Site busy: waited …ms for an available concurrency slot`（`siteApiEndpointService.ts:97-101`）。
- **D 上游真的返回 503**：真实响应档 ⇒ `upstream_error` + 503。路径一：`handleUpstreamFailure`（`sharedSurface.ts:760-827`；调用点 `chatSurface.ts:1408` / `:1886`、`openAiResponsesSurface.ts:1491`）；路径二：重试耗尽时 `finalizeRetryAsUpstreamFailure(503, …)`。**⇒ 同样是 503 可以用 `error.type` 分真假：真上游 503 = `upstream_error`，A/B/C 三类 = `server_error`。**

**trace 侧已无法区分「重试耗尽」与「普通终态上游失败」**：重试耗尽出口写进 trace 的是**真实状态码**（429/500/502，甚至 503）与真实 payload（`chatSurface.ts:442` / `openAiResponsesSurface.ts:396`），而普通终态上游失败的 trace 形态是同样的「failed + 真实状态码 + `selected_channel_id` 保留」；两张脸的形状一致，签名 `final_http_status=503` 因此不再等价于「无通道」。
- **唯一干净判别器**：`events.message LIKE '%retry exhausted: HTTP%'`（只有重试耗尽出口写这串，`chatSurface.ts:440` / `openAiResponsesSurface.ts:394`）。`events` 行的形态由 `reportProxyAllFailed` 决定（`src/server/services/alertService.ts:53-64`，`message = \`模型=${model}, 原因=${reason}\```，reason 即上面那串）。
  - **只覆盖「重试耗尽」形态（O3）**：B/C 两类除经重试耗尽出口外还有**直终态**形态——`retryCount == maxRetries` 的最后一轮（`canRetryChannelSelection` 为假）与固定通道模式（`channelSelection.ts:79` 使其恒假）都**不会**写 `retry exhausted:` 串：租约忙/并发超时的直终态只写 trace（`chatSurface.ts:762-773`、`:1381-1383` 走 `finalizeDebugFailure`）、**不写 events**；固定通道的 `!selected` 分支即便写 events 也是旧原文案（`chatSurface.ts:445-457`）。⇒ 拿 events 判别器只能证明「发生过重试耗尽」，**不能反证**「没发生过租约忙/并发超时」。
  - **时效性限定（O1）**：`reason` 进聚合器时经 `normalizeText(input.reason, 200)` 截断（`src/server/services/notificationAggregator.ts:418`）——**「前缀安全」的前提是该出口的 message 由本地代码打前缀**（本片覆盖面成立：`retry exhausted: HTTP ` 由 `chatSurface.ts:440` / `openAiResponsesSurface.ts:394` 本地拼出，位于报文最前 22 字符内，远小于 200 上限、不会被截掉；未覆盖面根本不写这串，不存在这层）。但聚合器 `MAX_TRACKED_REASONS = 3`（`:33`）只留 **3 条 reason**，且满 3 后由最新**顶替末位**（`:490-493`：`reasons[len-1] = reason`）⇒ 保留集恒为 **[第 1 条, 第 2 条, 最新一条]**（**不是**「最近 3 条」滑动窗，第 3 条会被第 4 条起逐次挤掉）。并且 `buildStormMessage`（`:238-252`）里 `原因=` 段恒为**本段风暴首次**的 reason（`storm.meta.baseMessage` 只在首次建 storm 时写定，之后不再改），后续 reason 只出现在 `最近原因：${storm.reasons[last]}` 行（`:244`）。⇒ 混合故障（重试耗尽与其它 `代理全部失败` 原因交替）下，`retry exhausted:` 可能既不在 `原因=` 段、也已不在保留集里——判别是**时间窗内**的，不是「有 events 就一定有、查不到就一定无」。
  - **伪造面（低概率，O2）**：`%retry exhausted: HTTP%` 命中**不一定**等于走了重试耗尽出口——凡是把**上游可控文本**写进 events `reason` 的出口，都会把该字样带进 events。两条真实通道：① **覆盖面自身**：重试耗尽 reason = `retry exhausted: HTTP <status>: <payload.error.message>`（`chatSurface.ts:440` / `openAiResponsesSurface.ts:394`），**前缀**由本地代码拼出，但**尾部 `payload.error.message` 就是上游报错体**（上游可自行构造 `retry exhausted: HTTP ...` 字样）；② **未覆盖 route 的失败分支**：`images.ts:218` / `:440`、`completions.ts:327` / `:469`、`search.ts:203`、`embeddings.ts:250`、`videos.ts:186` 都以 `reportProxyAllFailed({ reason: errorText })` 把**上游响应体整段**写进 events reason（`errorText` 即 `err.message`，来自 `SiteApiEndpointRequestError(responseText, …)`，如 `images.ts:184` / `images.ts:117`），**不带任何前缀**，纯上游文本即可命中判别串。⇒ 原稿的「叠加 route 与 `error.type` 交叉核对」**在 events 上不可执行**：`events` 表只有 `type/title/message/level/read/related_id/related_type/created_at`（`src/server/db/schema.ts:627-641`），本类行 `type` 恒为 `'proxy'`、`related_type` 恒为 `'route'`（`alertService.ts:53-64`），**既无 route 也无 `error.type`**；未覆盖 route 更没有 trace 可对照。**可行替代**：把谓词锚到只可能由本地代码拼出的位置——`reportProxyAllFailed` 的 message 恒为 `模型=<M>, 原因=<reason>`（`alertService.ts:53-64`），故 `events.message LIKE '%原因=retry exhausted: HTTP%'` 只在本地前缀处命中；风暴聚合行的后续 reason 只出现在 `最近原因：` 段（`buildStormMessage` `:238-252`），故需连 `%最近原因：retry exhausted: HTTP%` 一起查。未覆盖 route 的上游文本不带这两个锚，因此被排除。
- **`%No available channels after retries%` 只剩 A 形态——仅在 chat/responses 主 handler 内成立**（初稿写成「改后全仓只有两处写它」，是**范围量化错误**，已改正）：主 handler 内确实只剩 `chatSurface.ts:448`、`openAiResponsesSurface.ts:402` 两处、都在 `!selected && !lastRetryFailure` 分支内；但**全仓还有另外 8 处**写这同一串——`chatSurface.ts:1599`（`count_tokens` 的 503 分支）、`images.ts:66`/`:271`、`completions.ts:72`、`videos.ts:77`、`search.ts:94`、`embeddings.ts:69`（6 个 route 的 **events reason**）、`rerankSurface.ts:184`（当其**客户端 503 体**下发，不写 events）。⇒ **拿 events 命中该串不能反推 A 形态**，逐处 file:line 与落库面见 §5。
- **B 形态改后的落库面**（与旧笔记 §1 的「完整落库面」并列读）：trace = failed + **真实状态码（B 为 503）** + `selected_channel_id` **保留首轮选中的通道**（末轮耗尽出口不再重写它，最后一次 selection 写入发生在 `chatSurface.ts:459` / `openAiResponsesSurface.ts:413`）；`events` = `retry exhausted: HTTP 503: Channel busy: …`；**终态出口自己不写 `proxy_logs`**。`proxy_logs` 里能看到的只有**导致进入该分支的那次 busy attempt** 的行（`chatSurface.ts:744-752` 的 `failureToolkit.log`，`http_status=503`、`error_message=\`Channel busy: …\``）。⇒ 依旧不能拿 `proxy_logs` 的行数判断「重试耗尽」是否发生。
- **trace↔events 交叉时间窗的读法**：两表**非 1:1**（events 是聚合 + 延迟视角，冷却窗口内折叠为 `[风暴聚合]`；旧笔记 §1 记录的滞后为 12 秒~5 分 12 秒不等）。做法：① 先在 `events` 里按 `%retry exhausted: HTTP%`（或 A 形态用 `%No available channels after retries%`）定位「发生过」及其**发生时刻**；② 再在该时刻**前后一个时间窗内**到 `proxy_debug_traces` 找 failed 行（按 `final_http_status` + `selected_channel_id` 比对），**不要按事件 ID/时间精确对齐**；③ 聚合计数可作旁证（`已累计 N 次`），但不能还原逐条时间。
- **同状态码 ≠ 同成因（一处边角，代码推得、未实测）**：「有上游响应但状态码缺失」也会落到合成 502（`result.status || 502`，`chatSurface.ts:781-785` / `openAiResponsesSurface.ts:916-920`），此时是 `upstream_error` + 502；而「没有上游响应」是 `server_error` + 502。⇒ **下游要分真假，必须看 `error.type`（与 message），不能只看状态码。**

### 3. 逐条收窄旧口径 + 行号漂移表

**（1）旧笔记 `20261001-post-1412-observe-trace503-and-setting.md` §1「正确签名 = `proxy_debug_traces.final_http_status=503`」**
- 原写法 → 新写法：该签名**只对 A 形态（首轮真无通道）继续成立**；旧笔记 §1/§5 用该签名认定的 B 形态（§5 的「6 条 09-30 的 503 trace」与 15:45–15:49 簇）在改后**不再产出 503**，而是按真实原因分流（网络类失败/端点池全不可用 ⇒ 502 + `server_error`；上游 4xx/5xx ⇒ 原样状态码 + `upstream_error`）。
- 仍然成立、不受本片影响的部分：**「该分支不写它自己的 `proxy_logs` 行」**（A/B 都成立，终态出口只写 trace + events）、**「events 是聚合 + 延迟视角、不与 trace 一一对应」**、§6 的**覆盖盲区**（只有 3 个 surface 建 trace；trace 写入失败被静默吞；采集按模型过滤）。

**（2）旧笔记 §1「第二条独立观测线 = `events.message LIKE '%No available channels after retries%'`」**
- 原写法 → 新写法：该串**只在 chat/responses 主 handler 内**只剩 A 形态（全仓仍有多处写它，见 §2 与 §5，故 events 命中**不能反推** A 形态）；「重试耗尽」的独立观测线改为 **`events.message LIKE '%retry exhausted: HTTP%'`**（判别局限见第 2 节：只覆盖重试耗尽形态、受聚合器「保留集 = [第 1, 第 2, 最新]」与 200 字符截断约束、是时间窗内的、且存在上游文本伪命中面）。旧笔记 §1 的「易误读」提醒（客户端可见串 `No available channels for this model` 与 events 里的 `No available channels after retries` 不是同一串）**仍然成立**，本片未改这两个字符串。

**（3）旧笔记 §1「该分支的完整落库面：写 `proxy_debug_traces`（failed/503）与 `events`（`代理全部失败`）、不写它自己的 `proxy_logs` 行」**
- 对 A 形态仍成立；对 B 形态按第 2 节的新落库面读（status 变真、events 串变 `retry exhausted:`）。旧笔记 §1 的补充口径（**导致进入该分支的那次失败 attempt 会写 `proxy_logs`**）**更加重要了**：改后 B 形态的 `proxy_logs` 只剩这一条 busy attempt 行。

**（4）canary 笔记 `20261001-canary-controlled-4xx-endpoint-cooldown-verified.md` §4.1（实测实例的客户端形态）**
- 原文（实测，照抄）：「本实验中客户端最终**仍收到 503 `No available channels for this model`**——触发点在**通道级**（通道重试/冷却把请求拦下），而**端点并未被拉黑**（S1 已证）。」⇒ 该场景的关键是**通道级触发、端点并未被拉黑**（与端点池无关）。
- 原写法（实测）→ 新写法（改后同类场景**应**为）：单通道 + **通道级**触发（重试/冷却把请求拦下）⇒ 客户端**不再**收到统一的 503 `No available channels for this model`，而是按**该轮真实失败**分流：真实 4xx/5xx（如 429）⇒ 原样状态码 + `upstream_error`；网络类失败/端点池不可用 ⇒ 502 + `server_error`。
- **边界（补；原文未区分，原文的「不再收到统一 503」不可无条件套用）**：改后是否走 A 分支，取决于**本次请求内有没有发生过可重试失败**：① 若**首轮**就被通道冷却/排除拦下（`!selected && !lastRetryFailure`，本次请求内**一个 attempt 都没有**），仍走 A 分支、**改后文案与改前完全一致**（`No available channels for this model`，`chatSurface.ts:445-457` / `openAiResponsesSurface.ts:399-410`）；② 只有「请求内**至少一次**可重试失败 → 该轮把通道加入排除集 → 下一轮选不出通道」才回传真实原因（回传的是**最后一轮**的真实状态码与 message）。canary §4.1 的场景**两者都可能**（到底是哪一种，原文未区分、本次也未复现），故“不再收到统一 503”只对②成立。
- **纠正（防两条场景被混用）**：本片初稿曾把该场景写成「单通道 + 端点池被拉黑 ⇒ 502 + `当前站点的 API 请求地址均不可用`」，属**场景映射错误**。按 canary §4.1 原文，端点**并未被拉黑**，改后**不会是**「均不可用」那条文案；「502 + `当前站点的 API 请求地址均不可用`」属于**旧笔记 §5 的 15:45–15:49 簇（端点池）场景**——真发生了网络类失败（`fetch failed`@15:45:54）→ 1.4.11 写死 5 分钟端点冷却拉黑唯一端点 → `81459/81460`「均不可用」@15:48:59 → 无通道 503（trace 8781/8782/8783）。该端点池场景的改后形态已在第 (1) 条写对。
- **端点池场景的改后形态（归属第 (1) 条，非 §4.1）**：该错误由端点池抛出（`src/server/services/siteApiEndpointService.ts:445` / `:449`，均**不是** `SiteApiEndpointRequestError`）⇒ 落到 chat 面的 `handleExecutionError` 兜底（`chatSurface.ts:1440`）⇒ 重试耗尽时回传 `finalizeRetryAsExecutionFailure` 的 502/`server_error`，message 含该原文（`chatSurface.ts:289-301`）；本地集成用例 `chat.singleChannelFailure.test.ts`「returns 502 + server_error carrying the local endpoint-pool failure when the retries are exhausted」锁住该形态（同时断言 `fetchMock` 从未被调用，即全程没有上游响应）。
- **诚实标注**：canary 那一次的具体请求**没有重跑**，本条是「按原文 + 代码与用例推得的改后形态」，**不是该次实验的复现**；canary §4.1 的附带结论（这类 503 不写自己的 `proxy_logs` 行）在新形态下**仍然成立**。

**（5）canary 笔记 §6 跟进项「单通道路由 + 重试耗尽仍产出同一 503：1.4.12 未覆盖」**
- 标记为**已覆盖（本片）**：单通道路由下重试耗尽不再产出同一 503，改为回传真实原因。该条目的候选动作（「是否应给出可区分的错误语义/告警」）就此落地为「真实状态码 + 类型分流 + events 专门串」。
- **未覆盖面**见第 5 节（`count_tokens` 与其它 route 仍是旧口径）。
- 注：canary 笔记里该跟进项在 **§6**（本任务说明中写作 §5），本记录按真实章节号引用；canary 笔记正文**未改动**。

**行号漂移表**（旧引用 → 新行号；所有新行号均在**本片定稿后的工作区**实测，含本片与片 1 的未提交改动）：

| 旧引用（旧笔记 / canary 笔记） | 新行号 | 说明 |
| --- | --- | --- |
| `chatSurface.ts:424-437` | `chatSurface.ts:445-457` | chat 面「无通道」503 分支（现为 A 形态；文件头插入了留存变量与新分支） |
| `chatSurface.ts:439` | `chatSurface.ts:459` | `excludeChannelIds.push(selected.channel.id)`（B 形态成因） |
| `chatSurface.ts:1545-1556` | `chatSurface.ts:1595-1607` | `count_tokens` 侧同款 503 分支（**逻辑未改**，仅位置漂移） |
| `chatSurface.ts:377` | `chatSurface.ts:384` | chat 面 trace 起点 `startSurfaceProxyDebugTrace` |
| `chatSurface.ts:1499` | `chatSurface.ts:1549` | `count_tokens` 侧 trace 起点 |
| `chatSurface.ts:713` | `chatSurface.ts:733` | chat 面 `let startTime = Date.now()`（旧笔记 §5 用它判 `latency≈0`） |
| `openAiResponsesSurface.ts:379-390` | `openAiResponsesSurface.ts:399-410` | responses 面 503 分支（现为 A 形态） |
| `openAiResponsesSurface.ts:380-383` | `openAiResponsesSurface.ts:400-403` | 该分支 `reportProxyAllFailed` 的 reason 行 |
| `openAiResponsesSurface.ts:332` | `openAiResponsesSurface.ts:339` | responses 面 trace 起点 |
| `sharedSurface.ts:248-330` | `sharedSurface.ts:249-…` | `writeSurfaceProxyLog`（其前仅新增了 1 行类型联合注释，起行 +1） |
| `sharedSurface.ts:611` | `sharedSurface.ts:612` | `siteId: input.selected.site.id ?? null`（旧笔记 §5 用它判「`site_id` 全表 NULL 不是被清空」） |
| `channelSelection.ts:71-77`（null 档 `:74`、固定通道档 `:76`）/ `:110` | 不变 | 本片未触碰该文件（`canRetryChannelSelection` 在 `:79`；初稿把固定通道档写成 `:74`，实为 `:76`） |
| `siteApiEndpointService.ts:371` / `:443` / `:445` / `:447` / `:449` | 不变 | 本片未触碰该文件（新增可用锚点：站点并发忙的构造在 `:429-434`） |
| `geminiSurface.ts:333` / `:556` | 不变 | 本片未触碰该文件 |

### 4. 表述纪律（已实测 / 未实测）

- **已实测（本地，有用例锁）**：重试耗尽出口回传真实状态码与原文；有/无上游响应的类型分流；上游 502→最后 429 的「取最后一轮」语义；端点池全冷却 ⇒ 502 + `server_error` + 原文；**B 类（租约忙）重试耗尽 ⇒ 503 + `server_error` + `Channel busy: …` 文案，且 `reportProxyAllFailed` 的入参 `reason` 以 `retry exhausted: HTTP 503: ` 开头**（**口径说明**：该 `reason` 断言打在 `reportProxyAllFailedMock` 的**入参**上、`alertService` 被 mock，**没有**「已在 events 落库并实测观察到」这层含义；events 落库形态属第 2 节的**推断**，见 §6 与「遗留与跟进」③）；截断 1000 与代理对不切半；A 形态与固定通道模式的 503 文案不变。对应用例：`src/server/routes/proxy/chat.singleChannelFailure.test.ts`（**10 条**，见第 6 节）与 `src/server/proxy-core/surfaces/sharedSurface.test.ts`（30 条，含新增 `truncateUpstreamErrorMessage` 2 条与更新后的 toolkit 终态断言 `:746-752`）。
- **推断 / 未实测（不得写成已验证）**：① 生产侧 503 数量与分布的变化；② 下游客户端行为（尤其**上游 401/403 是否被误报为「你的 key 失效」**）；③ canary §4.1 形态的复现（只按代码与用例推得）；④ `%retry exhausted: HTTP%` 在生产 events 里的聚合/延迟表现（含保留集「[第 1, 第 2, 最新]」顶替造成的窗口性）；⑤「同状态码不同成因」的 502 边角在实际流量中的占比。
- **本片未做生产实验**：未启停容器、未写生产库、未制造失败流量；因此**生产侧影响一律标注为未知**。

### 5. 覆盖与未覆盖

**已覆盖**：`handleChatSurfaceRequest`（chat 主 handler，`chatSurface.ts:302-1473`）与 `handleOpenAiResponsesSurfaceRequest`（`openAiResponsesSurface.ts:268-1556`）。

**未覆盖（仍是旧口径：重试耗尽 ⇒ 503 `No available channels for this model`）**：
- **`count_tokens` 分支**：`handleClaudeCountTokensSurfaceRequest`（`chatSurface.ts:1498-1933`）全程**没有** `lastRetryFailure`（全文件 `lastRetryFailure` 只出现在 `:420` 起的 chat 主 handler 内），故**重试耗尽出口不动**；其出口：503 分支 `:1595-1607`（events 原因仍在 `:1599`）、租约忙 `:1677-1711`、站点并发超时 `:1843-1862`、端点/上游失败 `:1886-1908`、执行失败兜底 `:1909-1929`、`Claude count_tokens compatibility is not implemented` 的 501 在 `:1658-1669`。
  - **count_tokens 的连带变化（D2，须知情，勿读成「完全没变」）**：其**最后一轮执行失败终端** `chatSurface.ts:1909` 调用的正是共享工具包的 `handleExecutionError`，故该终端的 `error.type` 随本批由 `upstream_error` 变为 **`server_error`**（状态码沿用 502，`sharedSurface.ts:922-932`，`type` 在 `:928`）——与本片对主 handler 的一致化修复是**同一处代码**。⇒ `count_tokens` 的**重试耗尽口径不变**，但**「无真实上游响应的执行失败终态」类型已变**；其 503 分支本就已是 `server_error`（未变）。
- **其它 route（`No available channels after retries` 在全仓的逐处落库面，逐个核对）**：
  - `embeddings.ts:69`、`images.ts:66` 与 `:271`、`completions.ts:72`、`videos.ts:77`、`search.ts:94`：各自 handler 的 `!selected` 分支，`reportProxyAllFailed({ reason: forcedChannelId ? noChannelMessage : 'No available channels after retries' })` ⇒ **以 events reason 落库**；同分支发给客户端的体是 `buildForcedChannelUnavailableMessage(...)` 的 `No available channels for this model`（两串不同，见旧笔记 §1「易误读」）。
  - `src/server/proxy-core/surfaces/rerankSurface.ts:184`：**loop 之后的终态 503 体**（`reply.code(503).send({ error: { message: 'No available channels after retries', type: 'server_error' } })`），**不写 events、不写 trace**——这是该串**唯一以「客户端 503 体」形态下发**的地方；rerank 的 `!selected` 分支（`:67-72`）写 events 用的是**另一个**串（`buildForcedChannelUnavailableMessage(...)` = `No available channels for this model`）。

  | 文件:行 | 该串的形态 | 落库面 |
  | --- | --- | --- |
  | `chatSurface.ts:448` | events reason（A 形态，主 handler） | trace + events |
  | `openAiResponsesSurface.ts:402` | events reason（A 形态，主 handler） | trace + events |
  | `chatSurface.ts:1599` | events reason（`count_tokens` 旧口径） | trace + events |
  | `embeddings.ts:69`、`images.ts:66`/`:271`、`completions.ts:72`、`videos.ts:77`、`search.ts:94` | events reason（6 个 route 旧口径） | **events**（失败 attempt 另有 `proxy_logs`，无 trace） |
  | `rerankSurface.ts:184` | **客户端 503 体**（loop 终态） | 无（不写 events、不写 trace） |

  ⇒ 主 handler 内那两处（A 形态）与这 8 处**写法相同、含义不同**，故 events 命中该串**不能反推** A 形态。
- **「零证据」的准确说法（初稿写「既不写 trace 也不写它自己的 `proxy_logs` ⇒ 零证据」，不准确，已改正）**：这些面**不写 trace**（只有 3 个 surface 建 trace），**但会写 events**（上表：与 A 形态**同串**）；其中 embeddings / images / completions / search 的**失败 attempt 还写 `proxy_logs`**（`logProxy`：`embeddings.ts:191`/`:214`、`images.ts:120`/`:166`/`:191`/`:340`/`:386`/`:411`、`completions.ts:251`/`:296`/`:397`/`:432`、`search.ts:153`/`:177`），**videos 与 rerank 则完全没有**（两文件里既无 `logProxy` 也无 trace）。⇒ 准确表述是**「唯一无 trace 的形态」＋「events 里与 A 形态同串」**，而不是「零证据」。

### 6. 测试与反向对照

- 新增集成用例文件 `src/server/routes/proxy/chat.singleChannelFailure.test.ts`（488 行，10 条，describe = `chat proxy retry exhaustion surfaces the real upstream failure`）：真实 429（非 503）、真实 500、网络失败 ⇒ 502/`server_error`、端点池全冷却 ⇒ 502/`server_error` + `当前站点的 API 请求地址均不可用`、**B 类租约忙重试耗尽 ⇒ 503 + `server_error` + `Channel busy: …`，reason 以 `retry exhausted: HTTP 503: ` 开头**、多通道取**最后一轮**真实状态码（502 → 429）、A 形态原文案不变（`No available channels for this model`）、固定通道模式 503 文案不变、`/v1/responses` 面真实 429、超长报错截断到 1000 + `...(truncated)`。10 条用例名（按文件顺序）：`returns the real 429 (not 503) when a single-channel upstream rate limit exhausts the retries`、`returns the real 500 when a single-channel upstream server error exhausts the retries`、`returns 502 (not 503) when a single-channel network failure exhausts the retries`、`returns 502 + server_error carrying the local endpoint-pool failure when the retries are exhausted`、`returns the real channel-busy 503 under the retry-exhausted reason when the lease never frees`、`returns the last round real status when every channel fails (502 then 429)`、`keeps the original 503 wording when the first round has no available channel at all`、`keeps the fixed-channel 503 wording when the forced channel is unavailable`、`returns the real 429 on /v1/responses when the retries are exhausted`、`truncates an oversized upstream error message to the shared 1000-char cap`。
- `src/server/proxy-core/surfaces/sharedSurface.test.ts` 新增 `truncateUpstreamErrorMessage` 2 条（ASCII 封顶、代理对不切半）；并更新 toolkit 终态断言（`:746-752`）为 `server_error`。
- **反向对照（真做过，已还原）**：① 把两个 surface 的出口条件改成 `if (false && retryFailure)`（`chatSurface.ts:437` / `openAiResponsesSurface.ts:391`）⇒ `chat.singleChannelFailure.test.ts` **8/10 失败**（失败的 8 条正是「要回真实状态码/走重试耗尽出口」的，含新增 B 类；通过的 2 条是 A 形态两条）；② 把 `sharedSurface.ts:928` 的 `type` 还原成 `upstream_error` ⇒ `sharedSurface.test.ts` **1/30 失败**（断言位置 `:746`），其余全绿；两处均已还原。
- **覆盖面边界（由一次定位实验得到）**：给 toolkit 终态 message 打上临时前缀后，集成用例**仍通过** ⇒ 说明集成用例走的是 **surface 侧**重试耗尽出口（`chatSurface.ts:435-444`），而第 1 节那处一致性修复（**toolkit 侧**终态出口 `sharedSurface.ts:922-932`）**只由单测覆盖**——在该集成夹具里它到不了（`selectNextChannelMock` 第二次即返回 `null`，循环到不了 `retryCount == maxRetries` 的 toolkit 终态）。生产侧要走到它需要「最后一个重试轮仍有通道可选」（例如 ≥3 条通道连续网络失败）。

## 遗留与跟进（本片未做，逐条带 file:line 与理由）

1. **未封顶的客户端可见出口**（本片截断口径只覆盖 7 处，其余仍整段回传）：
   - in-domain：`chatSurface.ts:947` / `:1007` / `:1112` / `:1190` 四处**流式失败 502 出口**——`if (!streamStarted) return reply.code(502).send({ error: { message: streamResult.errorMessage, type: 'upstream_error' } })`，message 取自上游 SSE 帧 / 流会话 failed 结果（`streamResult.errorMessage`），**未过 `truncateUpstreamErrorMessage`**，上游可整段塞入。**同型核对结论：`openAiResponsesSurface.ts` 没有同型出口**——全文件没有任何 `reply.code(502)`；它的 4 处流式失败分支（`:1030` / `:1126` / `:1219` / `:1281`）都只做 `recordStreamFailure` + `finalizeDebugFailure(502, …)` 后直接 `return`，**不发客户端错误体**（那些 message 只进 trace/日志）。
   - 范围外：`geminiSurface.ts:1434-1437`（`lastText = JSON.stringify({ error: { message: endpointResult.errText, type: 'upstream_error' } })`）与 `:807`（`lastText = await readRuntimeResponseText(upstream)`）——两处都**原样下发**，`errText` / `readRuntimeResponseText` 均无大小上限。
   - 范围外（已在 §5 登记）：embeddings / images / completions / videos / search / rerank 的错误体（如 `images.ts:224` 的 `Upstream error: ${errorText}`、`rerankSurface.ts:176-185`）。
2. **`Site busy:` 档无用例**：`sharedSurface.ts:201-208` 的 `buildSurfaceConcurrencyBusyMessage` 的 site 分支（`Site busy: …`）与 `Channel busy:` 同族，但集成用例只锁了 `Channel busy:`（`chat.singleChannelFailure.test.ts` 第 5 条），**没有一条用例断言「站点并发超时」回传 `Site busy:` 文案**（C 类的客户端可见形态因此只有代码推得、未实测）。
3. **「重试耗尽出口不写自己的 `proxy_logs` 行」是落库结论，却只有入参断言**：本片与 §4 引用的 `proxy_logs` 断言都打在 mock 的入参上（`reportProxyAllFailedMock`、`failureToolkit` 被替身），**没有**在真实落库层断言「终态出口不产生自己的 `proxy_logs` 行」；该结论目前来自旧笔记 §1 的生产观测 + 代码阅读，本片**未重新落库验证**。
4. **`truncateUpstreamErrorMessage` 缺「短文本原样、不产生尾标」用例**：现有 2 条（`sharedSurface.test.ts:1495-1526`）只覆盖「ASCII 超限封顶」「代理对不切半」，**没有**「长度 ≤ 上限时原样返回、不追加 `...(truncated)`」的断言——该分支（`sharedSurface.ts:659`）目前只有代码阅读为证。
5. **判别器升级备选（待决，属产品/告警语义决定）**：现判别器 `events.message LIKE '%retry exhausted: HTTP%'` 同时受**时效性**（聚合器保留集 = [第 1, 第 2, 最新]、风暴行 `原因=` 段恒为首次 reason，见 §2 O1）与**伪造面**（上游报错体可含该字样，见 §2 O2）双重约束。可一次消掉两者的两条备选：**(a)** 给重试耗尽出口独立的 events `title`——现全部走 `代理全部失败`（`alertService.ts:53-64`），拆 title 需产品决定告警语义；**(b)** 由重试耗尽出口**补写自己的 `proxy_logs` 行**——需决定它是否该进入「每次请求一条 `proxy_logs`」的既有口径（现口径是「不写自己的」）。两者都超出本片范围，**未做**。
6. **旧口径的排期（待定）**：`count_tokens`（`chatSurface.ts:1599`）与 6 个 route（`embeddings.ts:69`、`images.ts:66`/`:271`、`completions.ts:72`、`videos.ts:77`、`search.ts:94`、`rerankSurface.ts:184`）的「重试耗尽 ⇒ 503 `No available channels for this model`」仍是旧口径，本片未改，**排期未定**（改动面更大、且这些面无 trace）。

## 被放弃的方案

- **把「无真实上游响应」的终态做成 503**：会让「上游不可达 / 端点池全冷却」与「上游真的返回 503」在下游完全不可区分；故选**合成 502 + `server_error`**，把真假 503 的区分交给 `error.type`。
- **为了「兼容既有客户端」继续写 `upstream_error`**：那是把类型当兼容层，让网络层失败永远伪装成上游失败、归因永久失真；代价是下游若按 `type` 分支需要适配（影响未知，未实测）。
- **在 trace 上新增「重试耗尽」标记字段**：要改 schema 与写入面，超出本片范围；改用 `events` 的 `retry exhausted:` 判别器，零 schema 变更。
- **把 `handleUpstreamFailure` / `handleDetectedFailure` 也一并改类型**：它们承载**真实**状态码与真实上游内容判定，改了会把真实上游 5xx/4xx 说成网关侧错误，违反分流规则本身；故明确不动。
- **本片顺手改 `count_tokens` 与其它 route**：面更大、回归面更宽（且这些面没有 trace 证据；events 里与 A 形态同串，见 §5），留待后续切片；未覆盖面已在第 5 节逐条列明。
- **给旧笔记挂 `superseded` / 改写旧笔记**：属部分收窄（旧口径里仍有效的条目多于被收窄的条目），整篇标死是误标；且 README 明确禁止改写旧笔记内容，故旧笔记一字未改。
- **做生产侧实验（观察 503 数量变化 / 客户端行为）**：需要制造失败流量并可能污染真实数据，代价高；本片证据止于代码 + 本地用例。

## 来源

- 代码（行号均按本片定稿后的工作区复核）：`src/server/proxy-core/surfaces/chatSurface.ts`（`:272-301` 两个 finalize、`:302` 主 handler、`:420` 留存变量、`:435-457` 出口、`:459` 排除通道、`:733-773` 租约忙、`:1360-1459` catch 分类、`:1498-1933` count_tokens）；`src/server/proxy-core/surfaces/openAiResponsesSurface.ts`（`:223-252` 两个 finalize、`:268` handler、`:374` 留存变量、`:389-410` 出口、`:413` 排除通道、`:873-908` 租约忙、`:1459-1538` catch 分类）；`src/server/proxy-core/surfaces/sharedSurface.ts`（`:35-45` 类型联合、`:195-208` 忙文案、`:221-247` `getSurfaceRequestFailure`、`:648-673` 截断、`:678-687` 留存类型、`:760-827` / `:828-884` / `:885-933` 三个工具（截断应用点 `:821` / `:878` / `:927`）、`:922-932` 本次修复并封顶的终态）；`src/server/proxy-core/channelSelection.ts:71-77`、`:79`；`src/server/services/siteApiEndpointService.ts:97-101`、`:429-434`、`:445`、`:449`；`src/server/services/proxyRetryPolicy.ts:87-96`；`src/server/services/alertService.ts:53-64`；路由接线 `src/server/routes/proxy/chat.ts:9/11/16/18`、`responses.ts:29/38/41/47`。**覆盖面之外本次复核到的面**：`src/server/routes/proxy/embeddings.ts:69/191/214`、`images.ts:66/117/120/184/218/271`、`completions.ts:72/327`、`search.ts:94/203`、`videos.ts:77/186`、`src/server/proxy-core/surfaces/rerankSurface.ts:67-72`/`:184`、`src/server/proxy-core/surfaces/geminiSurface.ts:807`/`:1434-1437`、`src/server/services/notificationAggregator.ts:33`/`:238-252`/`:418`/`:490-493`、`src/server/db/schema.ts:627-641`（`events` 列，无 route / `error.type`）。
- 测试：`src/server/routes/proxy/chat.singleChannelFailure.test.ts`（10 条）、`src/server/proxy-core/surfaces/sharedSurface.test.ts`（30 条，含新增 2 条）。
- 验证命令与计数（本片实跑）：`npm run typecheck` 全绿（web / web:test / server / desktop 四段均无输出）；`npx vitest run --root . src/server/routes/proxy/ src/server/proxy-core/` = **54 文件 / 579 用例全绿**；`npm run repo:drift-check` = **0 违规**（另有 5 条 `tracked_debt`，均为既有白名单项，非本次新增）；另跑 `.agents/notes/INDEX.md` 刷新脚本（本地生成，不入 git）。新增笔记后复跑上述命令同样全绿。
- 反向对照：① `if (retryFailure)` → `if (false && retryFailure)` ⇒ 集成用例 8/10 失败；② `sharedSurface.ts:928` 的 `type` 还原 `upstream_error` ⇒ 单测 1/30 失败（`:746`）；均已还原，并 `grep -rn "false && retryFailure" src/` 核为空。
- **文档修正轮（只改文档、未动代码与测试）**：逐条核对后改正——⑴ 范围量化（「全仓只有两处」 → 主 handler 两处 + 全仓另 8 处，逐处 file:line 入 §5 表）；⑵ `channelSelection` 固定通道档 `:74` → **`:76`**；⑶ 「覆盖全部客户端可见末轮出口」→ 准确列举 7 处 + 未封顶遗留（新增「遗留与跟进」）；⑷ canary §4.1 补「首轮无 attempt 仍走 A 分支、文案不变」的边界；⑸ O1 精确为「保留集 = [第 1, 第 2, 最新]」并补前缀安全前提；⑹ O2 改指覆盖面自身 reason 的尾部（`payload.error.message`）、删掉在 events 上不可执行的「route × `error.type` 交叉核对」、改为前缀锚定可行写法（并保留**未覆盖 route `reason: errorText`** 这条经代码核实的伪命中通道，见 `images.ts:218`）；⑺ §4 B 类改为 `reportProxyAllFailed` **入参**断言口径；⑻ §5「零证据」→「唯一无 trace 的形态」＋「与 A 形态同串」；⑼ 「应用点共 5 处」→ **7 处**；⑽ 忙文案 `sharedSurface.ts:195-199`/`:201-208` 补函数名（`getSurfaceRequestFailure` `:221-247` 经复核本就正确，任务给出的 `:215-247`/`:195-204` 与真实代码不符，未采用）；⑾ 遗留清单 6 条。回写后复跑 `npm run repo:drift-check` = 0 违规、`git diff --check` 干净、`git status --porcelain -uall` 仍 8 项且全为文档。
- 相关笔记：`.agents/notes/20261001-post-1412-observe-trace503-and-setting.md`（本记录收窄其 §1 的两条观测口径与 §5 里 6 条 09-30 trace 的成因判定；其 §1 的「不写自己的 `proxy_logs` 行」「events 聚合视角」与 §6 的覆盖盲区仍以其为准）；`.agents/notes/20261001-canary-controlled-4xx-endpoint-cooldown-verified.md`（本记录收窄其 §4.1 的客户端可见形态与 §6 的「单通道路由 + 重试耗尽」跟进项，两条均以本记录为准）；`.agents/notes/20260930-fetch-failed-fingerprints.md`（端点/通道冷却策略与遗留项的机制说明）；`.agents/notes/20260929-error-cause-forensics.md`（`formatErrorCause` 的 `.cause` 链口径，本次沿用）。
