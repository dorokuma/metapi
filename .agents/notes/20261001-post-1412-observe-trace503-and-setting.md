---
status: active
superseded_by: ""
supersedes: ""
模块: "services, proxy-core, routes, docs"
---
# 1.4.12 上线后真实流量验证：503 观测口径与遗留

## 一句话结论
事故症状类 503（`No available channels after retries`）**不写它自己的 `proxy_logs` 行**，只在 `proxy_debug_traces` 与 `events` 留证。本记录**撤回初版签名** `final_http_status=503 AND selected_channel_id IS NULL`——生产 6 条 503 trace 的 `selected_channel_id` 全是 1811，该组合命中 **0 行**，照着它核对会把每一次真实症状读成「干净」；**正确签名 = `proxy_debug_traces.final_http_status=503`**（不再筛 selected），并分两形态：**A** 首轮就选不到通道（`selected_channel_id` 为 NULL）、**B** 首轮选中通道→attempt 失败→重试把该通道加入排除集→单通道路由无其它通道（trace 里 `selected_channel_id` **保留该通道**，**生产实际发生的就是 B**）。按修正签名核对：**24h 保留窗内 503 共 6 条、全部在 1.4.12 切换前**（09-30，见第 5 节；**截至 2026-10-01 03:47Z 查询快照**，其中最早一条（05:55:23）将于 10-01 05:55 滑出 24h 窗，此后该计数会自然递减），上线后 0 条；但这个 0 **只证明口径可用**（口径能命中切换前已知的 6 条），**不构成对修复的检验**——首稿撰写时约 15 分钟；本版复核于 2026-10-01 03:48Z（约 +27 分钟），窗内 0 个失败请求，触发样本为零。「4xx 不再拉黑端点」由「生产可观测且符合预期」**降级为生产未验证**：上线后两次上游 404 走的是 `/v1/responses`→`/v1/chat/completions` **降级路径**，流程返回 ok，从未进入 `recordSiteApiEndpointFailure`。「冷却窗口保持 / 通道与成员级复用已有窗口」同列**生产未验证**（无触发机会）。另外，**1.4.12 并未消除「单通道 + 重试耗尽 ⇒ 同一 503」**：6 条 trace 正是该形态，其中 15:45 簇是旧机制（网络类失败→写死 5 分钟端点冷却→无通道 503）的完整复现，只是端点冷却从写死 5 分钟变为默认 60s 且不再被续期。

## 背景
1.4.12 于 **2026-10-01 03:21:35Z** 起服务：容器 `metapi:1.4.12`、`restarts=0`、4000 端口监听进程经 cgroup 核对属该容器；deploy 日志 `/var/lib/metapi/deploy-logs/deploy-20261001-112007-1.4.12.log` 六阶段齐全、无 FAIL/rollback。

本记录要解决的问题是「上线后怎么证明事故症状没再出现」：按 `proxy_logs` 的关键词检索 503 会得到 0 命中，但这个 0 **不是**「没发生」的证据——该分支不写它自己的 `proxy_logs` 行。若不先固定观测口径，后续任何 503 回归排查都会得出错误的「干净」结论。同时，本轮上线涉及的两条冷却语义（4xx 不拉黑端点；冷却窗口保持）在生产上的可观测性并不相同，必须分开写清「已验证」与「不可观测」。

本版记录相对初版的改动：初版把签名写成 `final_http_status=503 AND selected_channel_id IS NULL`，据此得出「上线后 0 行、24h 窗内亦 0 行」。按「不筛 `selected_channel_id`」重查后，**窗内实为 6 条、全部在切换前**——那个「0 行」是签名错误造出来的假证据。本版据此重写第 1/2/3/5 节，并补第 6 节（观测与采集的覆盖盲区）。

## 决策

### 1. 503 的观测口径（本记录核心发现，含一次签名更正）
- 事故症状类 503 **不写它自己的 `proxy_logs` 行**：完整短语 `%No available channels%` 在 `proxy_logs` 全表命中 **0**（撰写时 82990 行，复核时约 83213 行，均 0）。
- 原因：该分支只调用 `finalizeDebugFailure(503, …)` 写 `proxy_debug_traces`（`src/server/proxy-core/surfaces/chatSurface.ts:424-437`，以及 count_tokens 侧同款 `:1545-1556`），**从不写 `proxy_logs`**；且 `proxy_debug_capture_bodies=false` 使响应体不入库，故也拿不到 body 佐证。
- **签名更正（初版口径已撤回）**：初版签名 = `final_http_status=503` **且** `selected_channel_id IS NULL`。实测该组合在生产命中 **0 行**（6 条 503 trace 的 `selected_channel_id` 全为 1811），用它会得出「永远干净」的假结论。
- **正确签名** = `proxy_debug_traces` 中 `final_http_status=503`（**不再筛 `selected_channel_id`**），并二分形态：
  - **A 形态**：首轮就选不到通道 ⇒ `selected_channel_id` 为 NULL（trace 在请求入口即创建，未选到通道时必然留下这一行）。
  - **B 形态（生产实际发生的那种）**：首轮选中通道（如 1811）→ 该 attempt 失败 → 重试把该通道加入排除集（`excludeChannelIds.push(selected.channel.id)`，`chatSurface.ts:439`）→ 单通道路由已无其它通道 ⇒ 下一轮 `selected` 为空、走**同一个 503 分支**；此时 trace 里 `selected_channel_id` **保留首轮那个通道**，因此 `selected_channel_id IS NULL` 这一筛法会把 B 形态全部漏掉。
- 该分支的完整落库面：**写 `proxy_debug_traces`（failed/503）与 `events`（`reportProxyAllFailed` → `代理全部失败`）**，不写它自己的 `proxy_logs` 行。补充口径（易误读）：同一个请求里**导致**它进入该分支的那次失败 attempt **会**写 `proxy_logs`（本次 81458 `fetch failed`、81459/81460「当前站点的 API 请求地址均不可用」就是），所以排查时既不能把 `proxy_logs` 的 0 行当作分支未发生的证据，也不能把「均不可用」这类行当成 503 本身。
- **第二条独立观测线**：`events.message LIKE '%No available channels after retries%'`。本次 6 条 503 trace 正是靠它与 trace 交叉证实。注意 events 是**聚合 + 延迟**视角，不与 trace 一一对应：6 条 trace 只对应 4 条 event 行，滞后逐组不同（前三组分别 **2m35s / 2m39s / 5m12s**，15:45 簇仅 **12 秒**）、必要时被折叠成 `[风暴聚合]`（event 2674@05:57:58 ↔ trace 7070@05:55:23；2675@09:24:56 ↔ 8153@09:22:17；2676@15:01:46 ↔ 8659@14:56:34；2677@15:45:54 ↔ 8781@15:45:42 / 8782@15:45:57）。**用 events 可以证实「发生过」，聚合计数也可以作佐证**（2677 文本含「已累计 3 次」，与 15:45 簇 3 条 trace 吻合），**但不能还原逐条时间。**
- **检索陷阱**：关键词必须用完整短语 `%No available channels after retries%`。短词 `%No available%` 会命中上游自带文案——`proxy_logs` 中 `%No available%` 命中 **91** 行，其中 **90** 行是上游返回体透传的 `No available channel for model … under group free`（另 1 行是 id 66434 的上游 500 报错），只有 1 行与无通道无关却极易被读成「无通道 503 有记录」；`events` 表则 87 = 87 无此差异。

### 2. 上线后验证（均为实测）
- 新容器启动后 `proxy_logs` **41 行**（区间 03:21:39→03:25:07Z）：**39×200、2×404、0×5xx、0×503**（撰写时快照；见下复核补记）。
- 用**修正签名**核对 503 trace：**24h 保留窗内共 6 条、全部在切换前**（09-30 05:55:23 → 15:46:39，逐条见第 5 节；该计数为 03:47Z 快照，会随时窗自然递减）；**上线后 0 条**。
- 因此「症状未复现」必须限定：**首稿撰写时约 15 分钟；本版复核于 2026-10-01 03:48Z（约 +27 分钟）；窗内 0 个失败请求（触发样本为零）⇒「0 行」只证明口径可用，不构成对修复的检验**。口径本身是可用的：同一口径在切换前命中已知的 6 条。
- 采集开启且精确命中该模型（`proxy_debug_target_model='cline-pass/deepseek-v4.1-flash'`；撰写时 03 时该模型 95 条 trace，用于证明「0 不是没有数据」）。
- 复核补记（同日 UTC 03:48 复测）：上线后 `proxy_logs` 已增至 **约 221 行**（219×200 + 2×404，仍 0×5xx、0×503；该计数为 **03:47:05 查询时刻**值），03 时该模型 trace 已增至 **约 280 条**（**03:47:00 查询时刻**值）。上面 41 行 / 95 条为撰写时快照，同属动态计数，勿当作固定基线。
- 历史对照：最近 5xx 日为 **09-29（503×62）**；429 历史计数 09-30=2、09-29=12、09-28=50、09-27=38、09-26=4，最近一次 429 为 **2026-09-30 04:15:34**（上线前后窗口内均 0；上线后 5xx/429 = 0）。

### 3. 「4xx 不再拉黑端点」：生产未验证（初版「可观测且符合预期」已撤回）
- 上线后 03:21:39 两次上游 404（`Upstream returned HTTP 404`）**走的是降级路径**，判据在 `proxy_debug_attempts`：trace 10298/10299 的 attempt_index 0 对 `/v1/responses` 得 **404 且 `downgrade_decision=1`**（`downgrade_reason` = `[upstream:/v1/responses] Upstream returned HTTP 404: {"error":"Not Found","success":false}`），紧接 attempt_index 1 降级到 `/v1/chat/completions` 得 **200** ⇒ 整个流程返回 ok。
- ⇒ **本轮从未进入 `recordSiteApiEndpointFailure`**（`src/server/services/siteApiEndpointService.ts:374`），被改的那条代码路径根本没有被触发。所谓「4xx 不写冷却」在生产**没有观测样本**。
- 端点 67 三字段（`cooldown_until` / `last_failed_at` / `last_failure_reason`）全 NULL 的正确读法：它 **自创建（`created_at=2026-09-30 15:49:08`）以来从未记录过失败**，而不是「记录了失败但没写冷却」。⇒ 该 NULL 对「4xx 不拉黑端点」不构成任何证据（初版把它当作证据，是本条降级的直接原因）。
- 通道侧同理只是「无异常」而非「已验证」：通道 1811 `fail_count=0`、`consecutive_fail_count=0`、`cooldown_until=NULL`，上线后仍在被正常选中。
- **所需补充证据（待验证项）**：捕到一次**真正进入 `recordSiteApiEndpointFailure`** 的 4xx——例如 429/401/403，或**最终协议路径上**的 404（不是降级探测路径上的 404）——核对 `last_failed_at` 被写入而 `cooldown_until` 保持 NULL / 旧值。在拿到该样本前，本条与第 4 条并列为「生产未验证」。
- （保留的局限）即便将来捕到，也只是单边证据：未做旧构建 A/B，见「被放弃的方案」。

### 4. 「冷却窗口保持 / 通道与成员级复用已有窗口」：生产未验证（待验证项 + 触发条件）
- 触发该语义需要「**先存在未来冷却 → 窗口内到账一次不触发冷却的失败**」的事件组合。当前生产无触发机会：`site_api_endpoints` 全表仅 8 行、**未来冷却 0 条**（唯一非 NULL 的 id=43 是 09-26 的已过期陈旧残留）、`route_channels.cooldown_until` **全表非 NULL 0 行**、`oauth_route_unit_members` **空表**（本实例未配置 oauth 路由单元）。
- 该语义的证据目前只在**单元层面**：通道级 3 条 + 成员级 3 条用例，在完整回退下 **6/6 变红**。
- **改为待验证项（写明触发条件）**：出现任一未来冷却（端点级 / 通道级 / 成员级任一）后，核查**该窗口内到账的失败是否原地复用已有窗口**——即 `cooldown_until` **不被重算为更晚的值**（不续期）；同时记录该失败本身是否触发了端点冷却（`triggersEndpointCooldown`），以便与第 3 条合并取证。
- **新旧语义对照素材（留用）**：09-30 15:45 簇里 1.4.11 写出的 5 分钟端点冷却（写死 300s，见第 5 节「6 条 09-30 的 503 trace」条），可用作「旧：写死窗口 + 可续期」与「新：默认 60s + 窗口内失败不续期」的对照；端点 43 的陈旧残留（`last_failed_at` → `cooldown_until` 恰 +300s，旧写死值）是同类的静态对照组，它同时也是遗留 G 的生产实例（见第 5 节）。

### 5. 遗留与观察
- **遗留 G 在生产中的实例（陈旧端点冷却残留）**：端点 43（site 11，`asia.zerocat.cc`）`cooldown_until=2026-09-26T08:55:45.759Z`、`last_failed_at=2026-09-26T08:50:45.759Z`、reason=`fetch failed`，写入时距恰 **+300s**（旧的写死 5 分钟）⇒ 1.4.12 之前留下的陈旧残留，即既有遗留 G（UI 会显示「冷却至 <过去时间>」）在生产中的实例；当前未来冷却 0 条。
- **`site_api_endpoint_cooldown_sec` 未显式配置**：该键在 settings 表与 `/var/lib/metapi/.env` 中**均不存在**（.env 仅查键名与权限 600，未读值）⇒ 生效值 = **代码默认 60s**（`DEFAULT=60` / `CEILING=3600` / 归一化 [1,3600]，`src/server/shared/siteApiEndpointCooldownSec.ts:11-12`/`:14-20`；`src/server/config.ts:135-136` 非法值回落 60）。**用户决定：不显式写入生产 settings**，保持静默默认；若将来要在设置页可见/可调，需写一次。
- **6 条 09-30 的 503 trace（本版改判，原「成因不明的另一类现象」作废）**：7070@05:55:23、8153@09:22:17、8659@14:56:34、8781@15:45:42、8782@15:45:57、8783@15:46:39，全部 `final_http_status=503`、全部 `selected_channel_id=1811`/`selected_route_id=1377`/`selected_site_id=49`、全部 `/v1/chat/completions`、全部 09-30、全部由 **1.4.11** 产出（部署日志 `deploy-20260929-175240-1.4.11.log`，本机 09-29 17:52:40 / 09:52:40Z），**早于 1.4.12 切换（10-01 03:21:35Z）**。
  - **改判**：它们与本次事故是**同一客户端可见症状（无通道 503）、不同触发（网络类失败 → 重试耗尽）**，属 **B 形态**（首轮选中 1811 → attempt 失败 → 排除该通道 → 单通道路由无其它通道 → 503），不是「成因不明的另一类现象」。
  - 证据：3 条（7070/8153/8659）各有 1 条 attempt 记录且 `response_status=200`（上游已应答，随后失败/中断），3 条（8781/8782/8783）**0 条 attempt**（请求在拿到上游应答前就已失败）；6 条的 `final_response_body_json` 均 NULL（`capture_bodies=false`）。
  - **15:45–15:49 簇 = 旧机制的完整复现**（8781/8782/8783）：81458 `fetch failed`@15:45:54（proxy_logs，真发生了网络类失败）→ 1.4.11 的**写死 5 分钟**端点冷却把 site 49 的唯一端点拉黑 → 81459/81460「当前站点的 API 请求地址均不可用」@15:48:59（`siteApiEndpointService.ts:445` / `:449` 抛出，两处判空分别在 `:443` / `:447`；`:371` 是需 baseUrl 的独立 helper `requireSiteApiBaseUrl`，chatSurface 未引用）→ 无通道 503（trace 8781/8782/8783 finalize 503；8781 那条在 15:45:54，8782/8783 两条拖到 15:48:59 才 finalize）→ 15:50:21 起恢复 200。
  - **一处未定论（留作跟进）**：8782/8783 创建于 15:45:57/15:46:39，却在 15:48:59 才 finalize（在途 ≈3 分钟），与 81459/81460 同一秒落库——说明这两条请求先被挂住、到 15:48:59 才落定为无通道 503；**主嫌疑 = 请求内路由刷新（待验证）**：retry-0 空选择触发（`channelSelection.ts:106-153` → `routeRefreshWorkflow` → `modelService.refreshModelsAndRebuildRoutes`），且 `modelService.ts:1722-1735` 为 **single-flight**（并发的空选择请求共享同一个 in-flight 刷新 Promise），可解释 8782/8783 同一秒落定；排除依据：81459/81460 的 `latency=2ms/0ms` ⇒ `chatSurface.ts:713` 的 `startTime` 之后没有任何等待（站点租约排队 / 端点池等待均不成立），客户端重试会新建 trace，故也不成立。另：恢复始于 15:50:21，**自然到期解释不了**（15:45:54 + 5 分钟 = 15:50:54，最早才到期），能放行的只有 15:49:08 的**新端点行**（`id=67`，`created_at=2026-09-30 15:49:08`）⇒ 属**端点配置变更**；变更细节不可查（旧行已删）。
  - **该机制在 1.4.12 并未被消除**：单通道 + 重试耗尽仍会产出同一 503，只是端点冷却从写死 5 分钟变为**默认 60s 且不再被续期**。跟进项据此改写为：**「单通道路由下重试耗尽仍产出同一 503，1.4.12 未覆盖」**。
- **未收尾 trace**：撰写时 1 条（`created_at=2026-10-01 03:21:11Z`，`final_status` / `final_http_status` 均 NULL，`selected_channel_id=1811`），位于切换前 24s ⇒ 容器切换瞬间在途请求被截断的**预期产物**，非缺陷。**该计数是动态值**：复核时另有一条「创建时刻 = 查询时刻」的同形态行（在途请求的正常瞬时态），故不要把该计数当异常指标。
- **`proxy_logs.site_id` 全表 NULL 的精确读法**：不是「有 siteId 但落库丢失」这一笼统说法——三个 site 列（`site_id` / `model_site_id` / `credential_site_id`）非 NULL 计数**均为 0**（上线后约 221 行、上线前均如此）；而成功路径**确实采集了 siteId**（`sharedSurface.ts:611` 把 `input.selected.site.id` 交给 `logSuccess`），但真正落到 `insertProxyLog` 的那一层（`writeSurfaceProxyLog`，`sharedSurface.ts:291`）**没有把它转发进去**（`insertProxyLog` 自身是支持 `siteId`/`modelSiteId`/`credentialSiteId` 的，`proxyLogStore.ts:82`）。⇒ **更像「未接线」而非「被清空」**，排查时勿误判为数据回归，也不要用这三个列做站点维度取证。
- **待用户决策的跟进项（尚未立项）**：**空选择触发的请求内路由刷新耗时是否需要埋点**——若上面「主嫌疑 = 请求内路由刷新」成立，该等待目前**没有任何可观测记录**（`refreshModelsAndRebuildRoutes` 不写 trace、不写 `proxy_logs`、不写 `events`），「在途 ≈3 分钟」这类现象只能靠 trace 的 `created_at` 与 finalize 时间差倒推。

### 6. 观测与采集的覆盖盲区（补记）
- **只有 3 个 surface 会创建 trace**：`chatSurface.ts`（两处：`:377` chat 主 handler（`/v1/messages` 与 `/v1/chat/completions` 共用，见 `src/server/routes/proxy/chat.ts:16`）与 `:1499` count_tokens 侧）、`openAiResponsesSurface.ts:332`、`geminiSurface.ts`（`:333` 与 `:556`）。除这 3 个之外，请求走的是「无 trace」路径。
- `src/server/routes/proxy/{embeddings,images,completions,videos,search}.ts` 与 `src/server/proxy-core/surfaces/rerankSurface.ts` 的**同文案 503**（`No available channels after retries`，如 `embeddings.ts:69`、`images.ts:66/271`、`completions.ts:72`、`videos.ts:77`、`search.ts:94`、`rerankSurface.ts:184`）**既不写 `proxy_logs` 也不写 trace**——这些形态下「无通道 503」是**零证据**的。
- **采集按模型过滤**：`proxy_debug_target_model='cline-pass/deepseek-v4.1-flash'`（`proxy_debug_trace_enabled=true`、`proxy_debug_capture_bodies=false`、`proxy_debug_retention_hours=24`）。⇒ **其它模型复发不可见**；「窗内 0 条」只对该模型成立，不能推广为「全局无症状」。
- **trace 写入失败被静默吞**：`safeInsertSurfaceProxyDebugAttempt` / `safeFinalizeSurfaceProxyDebugTrace` / `safeUpdateSurfaceProxyDebugAttempt` 全部只 `console.warn`（`src/server/services/proxyDebugTraceRuntime.ts:~40-135`），不抛、不计数、不落库。⇒ 该请求**零证据**，观测面缺失无法从数据侧察觉。
- 结论：本记录的「有/无 503」是**在「3 个 surface + 单模型 + trace 写入成功」三重前提下**的观测，泛化到全站 503 之前必须先过这三道筛。

## 被放弃的方案
- **不做旧构建 A/B 对照**：在生产运行旧镜像会重新引入事故路径（唯一端点被拉黑 → 全站 503），代价与风险不可接受。后果是「4xx 不再拉黑端点」只有上线后单边证据，且如第 3 节所示本轮**连单边证据都没拿到**（走的降级路径）。**补充备选（待用户决策）**：与其等生产自然触发，可考虑用**发版 canary**（`scripts/deploy-painless.sh` 第 3 步快照副本 + `PORT=4100` 一次性容器）替代——在隔离副本上用**受控 4xx**（或受控网络类失败）打一次真实请求，既不改生产数据也不引事故路径；代价是扩写/复用 canary 步骤并承担一次性容器的运维面。
- **不制造受控故障流量去触发「窗口内失败」路径**：需要在生产主动注入失败（4xx/网络类）才能制造「先有未来冷却 → 窗口内到账一次不触发冷却的失败」的事件，有生产代价且会污染真实数据；该语义已有单元级 6/6 变红 + 完整回退实测证据，足以支撑当前决策，故不在生产复现（若采纳上面的 canary 方案，可在副本上顺带覆盖）。
- **不把 `site_api_endpoint_cooldown_sec` 显式写进生产 settings**：用户选择保持**静默默认**（生效值即代码默认 60s）。显式写入会让该键进入生产配置面，带来后续「配置与默认值双份真相」与漂移风险；代价是该值在设置页不可见、不可调，需要时再显式写一次。

## 来源
- 上线记录：`/var/lib/metapi/deploy-logs/deploy-20261001-112007-1.4.12.log`（六阶段齐全、无 FAIL/rollback）；1.4.11 部署日志名 `deploy-20260929-175240-1.4.11.log`（只看文件名与时间，未粘贴日志内容）。
- 验证期只读查询（`sqlite3 "file:/var/lib/metapi/data/hub.db?mode=ro"`）：
  - `proxy_debug_traces`：`final_http_status=503` 全量（6 行，全 09-30、全 `selected_channel_id=1811`）；`final_http_status=503 AND selected_channel_id IS NULL`（0 行）；24h 窗内 503（6 行，全在切换前）/ 上线后 503（0 行）；未收尾行（`final_status IS NULL AND final_http_status IS NULL`）。
  - `proxy_debug_attempts`：上线后全量（复核时约 218 行，03:21:39→03:46:52）、`/v1/responses` + 404 + `downgrade_decision=1`（2 行，trace 10298/10299）、随后的 `/v1/chat/completions` 200（同 2 条 trace）、上线后非 200/404（0 行）；6 条 503 trace 的 attempt（3 条各 1 个 200、3 条 0 个）。
  - `events`：`message LIKE '%No available channels%'`（87 行；含 2674/2675/2676/2677 四行全文）。
  - `proxy_logs`：09-30 15:45:00–15:53:00（81458 `fetch failed`@15:45:54、81459/81460「均不可用」@15:48:59、81461@15:50:21 起 200）；上线后全量（撰写时 41 行 / 复核约 221 行，按 `http_status` 分组）；`%No available channels%`（0）/ `%No available%`（91，其中 90 为上游自带文案）/ `%No available channel for model%`（90）；`http_status>=500` 与 `=429` 按日分组（09-29 503×62；429 09-30=2/09-29=12/09-28=50/09-27=38/09-26=4，最近一次 429 = 2026-09-30 04:15:34）；`site_id`/`model_site_id`/`credential_site_id` 非 NULL 计数（均 0）。
  - `site_api_endpoints`（全 8 行，含 id=67 三字段 NULL 与 `created_at=2026-09-30 15:49:08`、id=43 的 09-26 陈旧残留；未来冷却 0 条）、`route_channels`（route 1377 仅 1 条：channel 1811，`fail_count=0`/`consecutive_fail_count=0`/`cooldown_until=NULL`；全表 `cooldown_until` 非 NULL 0 行）、`oauth_route_unit_members`（空表）、`settings`（`proxy_debug_*` 与 `proxy_debug_target_model`）。
  - `/var/lib/metapi/.env` 只查键名与权限（600），未读值。
- 容器核对：`docker inspect metapi --format '{{.Config.Image}} restarts={{.RestartCount}} started={{.State.StartedAt}}'`（`metapi:1.4.12 restarts=0 started=2026-10-01T03:21:35…Z`）、`docker ps -a --filter name=metapi`（只读，未粘贴日志原文）。
- 代码侧：`src/server/proxy-core/surfaces/chatSurface.ts:424-437` 与 `:1545-1556`（503 分支：`reportProxyAllFailed` + `finalizeDebugFailure(503,…)`，不写 `proxy_logs`）、`:439`（`excludeChannelIds.push` ⇒ B 形态成因）；`src/server/routes/proxy/{embeddings,images,completions,videos,search}.ts` 与 `src/server/proxy-core/surfaces/rerankSurface.ts:184`（同文案 503，无 trace/无 proxy_logs）；`src/server/services/proxyDebugTraceRuntime.ts:~40-135`（trace 写入失败仅 `console.warn`）；`src/server/proxy-core/surfaces/sharedSurface.ts:248-330`（`writeSurfaceProxyLog`：收 `siteId` 但不转发）与 `:611`（`logSuccess` 传入 `siteId`）、`src/server/services/proxyLogStore.ts:82`/`:292-313`（`insertProxyLog` 支持 site 三列并已转发）；`src/server/services/siteApiEndpointService.ts:312-372`（冷却筛选 + `当前站点的 API 请求地址均不可用`）、`:374`（`recordSiteApiEndpointFailure`）、`:421`（`runWithSiteApiEndpointPool`）；`src/server/shared/siteApiEndpointCooldownSec.ts:11-12`/`:14-20`。
- 相关笔记：`.agents/notes/20260930-fetch-failed-fingerprints.md`（端点/通道冷却策略切片 2 与遗留 G/H/I/K 的机制说明，本记录是其上线后的生产观测补记；本记录第 5 节「6 条 09-30 的 503 trace」条与遗留 I 的「客户端重试在门口被 503 挡掉、走不到写冷却代码」互为呼应）。
