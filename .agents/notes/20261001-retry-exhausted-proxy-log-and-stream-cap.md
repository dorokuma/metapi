---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "proxy-core, routes, docs"
---

# 重试耗尽运维标记迁到 `events` 独立 title（最终方案 A）+ chat 流式失败 502 出口封顶

## 一句话结论

两项独立变更，同批落地（方案 A 是**用户拍板的根治方案**，取代本批初稿的「补写 `proxy_logs`」路线）：

1. **判别器——方案 A：`events` 独立 title 直查**。两条 surface（chat / responses）的**重试耗尽出口**（`!selected && lastRetryFailure`）除回传真实状态码外，**再直插一条自己的 `events` 行**，title 用模块级常量 `RETRY_EXHAUSTED_EVENT_TITLE = '代理重试耗尽'`（`src/server/shared/eventTitles.ts:14`；`sharedSurface.ts` 改为从该中性模块导入）。⇒ 「重试耗尽」从「只能读 `events` 正文串（有时效性 + 上游可伪造）」升级为**按 title 1:1 直查**：

   ```sql
   -- 可直接粘贴：按 title 直查（含可选时间窗；events.created_at 是 UTC 'YYYY-MM-DD HH:MM:SS'）
   SELECT * FROM events WHERE title = '代理重试耗尽' ORDER BY id DESC LIMIT 100;
   SELECT * FROM events
    WHERE title = '代理重试耗尽'
      AND created_at >= datetime('now', '-1 day')   -- 可选时间窗
    ORDER BY id DESC;
   ```

   **A 形态（首轮真无通道、`lastRetryFailure` 为 null）不写**；每轮重试耗尽**只写一条**；且该行**已从通知面板与未读徽标/计数中摘除（服务端按 title 排除）**——**标记行仍落库、仍可 SQL 直查**（曾短暂存在「占最近 30 行窗口 1 个位次、可能把真告警挤出面板列表、并使徽标计数窗口被占」的挤占风险，**已由本片排除修复**）。
2. **不做 `proxy_logs` 标记（本批初稿已拆除）**：`proxy_logs` 是 **attempt / 请求级表**，任何新增行都会被 6 类既有统计消费方计入（失败数 / 请求数 / 延迟样本 / 成功率分母，逐条 file:line 见 §2），且该表**不存在任何「可忽略位」**（无 `internal`/`exclude_from_stats` 这类列，`status` 只有 `'success' | 'failed' | 'retried'`，而所有消费方都按 `status <> 'success'` 计失败）⇒ **无法在不污染统计的前提下新增行**。`events` 则**没有任何统计消费方**（§3），且**直插不推送**、不经聚合器。原路的 `logContext` / `siteId` 管道随之**整条拆除**，不留死代码。
3. **A 组（流式失败 502 出口封顶）保留不动**：`chatSurface.ts` 主 handler 的 4 处 `!streamStarted` 流式失败 502 出口仍统一套用共享的 `truncateUpstreamErrorMessage`（≤1000 + `...(truncated)`），本片**未改一行**（唯一变化是应用点行号随上方出口代码增删而移位：`chatSurface.ts:971`/`:1031`/`:1136`/`:1214`）。

## 背景

- **触发规则**：本片改了观测口径（判别器载体从 `proxy_logs` 改为 `events`）且跨 `proxy-core` + `routes` + `docs`（跨界变更），按 `.agents/notes/README.md` 必写笔记。
- **来源是片 1 留下的两个决定**：`20261001-retry-exhaustion-real-upstream-error.md` §5 第 5 条「判别器升级备选」列了 **(a)** 给重试耗尽出口独立 events `title`、**(b)** 由重试耗尽出口补写自己的 `proxy_logs` 行。本批初稿按用户当时选的 (b) 实现；**用户随后拍板改走根治方案 A ⇒ 回到 (a)**：标记落在 `events` 独立 title，`proxy_logs` 一侧**全部拆除**。
- 片 1 的 O3/O1/O2 三条限定（覆盖面、时效性、伪造面）与 A 组「未封顶遗留」中属于 chat 主 handler 的 4 处流式失败 502，是本片的两条直接输入。

## 决策

### 1. 方案 A：重试耗尽运维标记 = `events` 独立 title 直插

- **title（模块级常量）**：`export const RETRY_EXHAUSTED_EVENT_TITLE = '代理重试耗尽';`——定义在**中性模块** `src/server/shared/eventTitles.ts:14`（本片从 `sharedSurface.ts:697` 迁出）；`sharedSurface.ts` 改为从新家 `import { RETRY_EXHAUSTED_EVENT_TITLE } from '../../shared/eventTitles.js'`。**迁家理由（订正）**：`repo:drift-check` 的 `proxy-core-routes-proxy-import` 规则**只匹配 `src/server/proxy-core/` 内对 `routes/proxy/` 的 import（单向）**，本场景两边都不命中 ⇒ **该规则并不覆盖本场景**；迁家的真实理由是**避免 routes 层 ← proxy-core 的反向耦合**（常量若留在 `routes/api/events.ts`、再由 proxy-core 反向引用即违反分层精神）与**缩小 `sharedSurface.ts` 的依赖面**；`npm run repo:drift-check` 的 **0 违规是回归门槛（结果陈述）**，不是迁家理由。
  - 命名与文案按仓库 `events` 既有体例（名词短语、中文，如 `'代理全部失败'`、`'令牌已失效'`、`'站点已禁用'`），与 `reportProxyAllFailed` 的 **`'代理全部失败'` 明确区分**：聚合器的分组签名是 `level||title`（`buildAggregatedSignature`，`src/server/services/notificationAggregator.ts:117-119`，`level||title`），新 title **自成一组**，即便日后被聚合也不会与既有告警合并。
- **写入点（2 处，各一条）与调用形式**：出口处直接调共享 helper（**直插 `events`**，形态同仓库既有先例）：
  - `chatSurface.ts:455`（出口 `:444-466` 内，紧跟 `reportProxyAllFailed` 之后、`finalizeDebugFailure` 之前）
  - `openAiResponsesSurface.ts:401`（出口 `:390-412` 内，同上位置）
  - helper：`insertRetryExhaustedEvent(...)`，定义在 `src/server/proxy-core/surfaces/sharedSurface.ts:711-744`；落库语句 `sharedSurface.ts:731`：
    ```ts
    await db.insert(schema.events).values({
      type: 'proxy',
      title: RETRY_EXHAUSTED_EVENT_TITLE,
      message: `${input.reason}; ${context}`,
      level: 'error',
      // 已从通知中心口径摘除（服务端排除该 title）；标记行仍可 SQL 直查。
      read: true,
      relatedType: 'route',
      createdAt: formatUtcSqlDateTime(new Date()),
    }).run();
    ```
  - **先例对照（本片采用的形式是哪一个）**：仓库里直插 `events` 的有两族——`routes/api/sites.ts:409-416` / `:429-437`（`applySiteStatusSideEffects`，`try { db.insert(schema.events) } catch { }`）与 `services/checkinService.ts:187-195` / `:317-325`（`await db.insert(schema.events)`，**不捕获**）；`services/alertService.ts:24`（`reportTokenExpired`）同后者。三者**都不触发推送**（推送只发生在 `reportProxyAllFailed` → `evaluateAggregatedNotification` → `sendNotification` 这条链上）。本片取**「直插 + 显式 catch」**：`db.insert(schema.events).values({...}).run()` 包在 `try/catch` 里，失败只 `console.warn('[proxy] failed to write retry-exhausted event', error)`（`sharedSurface.ts:734-736`）。**为何要包**：`checkinService` / `alertService` 那两处不捕获、DB 出错会向调用方抛；本出口在客户端响应路径上，任务要求「不得因 events 写入失败而影响客户端响应路径」，故捕获（`sites.ts` 先例是空 `catch {}`，本片多打一条 warn，与同文件 `writeSurfaceProxyLog` 的错误处理风格一致）。
  - **确认不经 `evaluateAggregatedNotification`**：该函数全仓只有 `alertService.ts:56`（`reportProxyAllFailed` 内）一个调用点（已核 `codegraph` 检索）；本 helper 直接 `db.insert`，**不经过它** ⇒ 不受聚合器的 `normalizeText` 截断与 `MAX_TRACKED_REASONS = 3` 保留集影响，也不会 `sendNotification`。`notificationAggregator` 对 `events` 的操作是**按自己记录的 `eventId` 单行 UPDATE / 按 id SELECT / 缺行重插**（`notificationAggregator.ts:283-285`、`:295-297`、`:307`），不会触碰本片新增的行。
- **message 内容（`events` 无结构化列，上下文只能进文本）**：`<reason>; model=<模型>; upstream=<上游路径或 `-`>; stream=<true|false>; attempt=<出口处轮次>; tried_channels=[<已试通道 id>]; forced_channel=<固定通道 id 或 `-`>`。
  - `reason` = 出口喂 `reportProxyAllFailed` 的**同一串**（`retry exhausted: HTTP <真实状态码>: <payload.error.message>`，`chatSurface.ts:447` / `openAiResponsesSurface.ts:393`）⇒ 真实状态码与判别串都在 message 里，且**与告警事件同源**，不存在两套口径。
  - 实测落库原文（本工作区真跑 `chat.singleChannelFailure.test.ts`）：
    `retry exhausted: HTTP 429: [upstream:/v1/responses] Upstream returned HTTP 429: rate limited: upstream quota exceeded; model=gpt-4o-mini; upstream=-; stream=false; attempt=1; tried_channels=[11]; forced_channel=-`
    （该形态的 `retryFailure.upstreamPath` 为 `null`——上游 429 经 `SiteApiEndpointRequestError` 分支进来，该分支只写 `upstreamPath: null`，故落 `upstream=-`；上游路径仍在 payload message 自带的 `[upstream:…]` 前缀里。）
  - **长度受控**：`reason` 尾部复用**已被截断封顶**的 `payload.error.message`（≤ `UPSTREAM_ERROR_MESSAGE_MAX_LENGTH` = 1000，`sharedSurface.ts:650` / `:659-675`），再加固定短后缀（≤ 约 150 字符）⇒ 整串**有界**（不会出现无界 HTML/JSON 正文）；不叠加二次截断，避免出现两个 `...(truncated)` 标记。
  - **`relatedId` / `relatedType`**：按体例挂 `relatedType: 'route'`、**不写 `relatedId`**——与 `reportProxyAllFailed` 完全一致（`alertService.ts:56-64` 也只给 `relatedType: 'route'`，不传 id；前端 `buildEventNavigationPath` 对 `relatedType==='route'` 且无 id 的结论是 `/routes`，见 `src/web/pages/helpers/navigationFocus.ts:104-106` 与其用例 `:73-77`）。**注**：出口处已**没有 route/站点/账号 id 可用**——它们原先只存在于本批将被拆除的 `logContext` 快照里（见「遗留与跟进」第 2 条）。
  - **落库即置已读（`read: true`，用户拍板，「SQL 运维标记」）**：本行是**纯 SQL 运维标记**（唯一用途是 `title` 直查），**不面向通知面板** ⇒ 写入时**显式** `read: true`（`sharedSurface.ts:737`）。`schema.events.read` 是 `integer('read', { mode: 'boolean' }).default(false)`（`src/server/db/schema.ts:633`）⇒ 显式置真即「已读」。
    **已解决（本片）**：该行**已从通知面板与未读徽标/计数中摘除（服务端按 title 排除）**——不出现在通知面板列表、不计入未读徽标/计数；**标记行仍落库、仍可 SQL 直查**（落库仍显式 `read: true`）。**曾短暂存在挤占风险**（旧口径：落库即已读 ⇒ 不计入未读数，但**仍占最近 30 行窗口的 1 个位次**，高频风暴下可能把真告警挤出面板列表、并使徽标计数窗口被占，真告警仍未读却显示 0），**已由本片排除修复**。
    **精确口径（按源码复核，本片已按「服务端排除」修订）**：①**前端未读徽标** = 「最近 30 行」里 `!read` 的条数（`src/web/App.tsx:537-542`：`api.getEvents('limit=30')` + `filter(r => !r.read)`）；服务端 `/api/events/count` 则是**全表未读**（只数 `read = false`、不限 30 行窗口）——两者**口径不同**（前端按最近 30 行、服务端全表），且现**都在服务端按 title 排除本行** ⇒ **不抬高未读数、也不占窗口位次**；②通知面板的**列表**取「最近 30 行**全量**」、**不带 `read` 过滤**（`src/web/components/NotificationPanel.tsx:44-58`），现因服务端排除 ⇒ **本行不再出现在面板列表里、不再占该 30 行窗口的 1 个位次**（此前「高频风暴下可能把真告警挤出该窗口」的挤占风险已消除）；③**副作用（实际影响面）**：`/api/events` 是**同一个**列表接口，`src/web/pages/ProgramLogs.tsx:117`（程序日志页）也走它 ⇒ 本行同样**不再出现在程序日志页**，**唯一入口是 SQL 直查**（判别器 SQL 见 §1）。读接口的**写侧**（`/api/events/:id/read`、`/read-all`、`DELETE`）**未改**，标记行仍可被正常清理/置读。
    **体例说明**：仓库既有 **11 个直插点都不写 `read`**（靠 DB 默认 `false` ⇒ 默认落「未读」），**本处是第一个显式置已读的落库点**；`alertService.ts:24-32` 等告警落库的体例**保持原样**（仍不写 `read`）。
  - **不含凭据/密钥**：**除 `reason` 尾段（上游报错体，即 `payload.error.message`）外**，其余字段均为本地元数据（状态码、模型名、上游路径、轮次、通道 id）；该尾段与片 1 既有出口**同口径**（同一串本来就在客户端响应体与告警事件里）。
- **A 形态不写**：写入位于 `if (retryFailure)` 内（`chatSurface.ts:445` / `openAiResponsesSurface.ts:391`）；首轮真无通道时 `lastRetryFailure === null`，走原分支、不写、503 文案不变。
- **每轮重试耗尽只写一条**：写入发生在「下一轮已选不出通道」这一次循环迭代的出口处，不在每次 attempt 落库。既有的 attempt 失败行（各自出口的 `failureToolkit.log`）**行为不变**。
- **写失败不影响响应路径**：见上「先例对照」的 `try/catch`。

### 2. 为何不走 `proxy_logs`（本批初稿路线被否的实测依据）

`proxy_logs` 的新增行会被**既有 6 类统计消费方**计入，逐条 file:line（本工作区已复核）：

| # | 消费方 | file:line | 计入方式 |
|---|---|---|---|
| 1 | 失败数 / 成功数（近 24h，按站点） | `services/dashboardSnapshotService.ts:138-139` | `failed = sum(case when status='success' then 0 else 1 end)` ⇒ 非 success **全算失败** |
| 2 | 请求数（近 1 分钟） | `services/dashboardSnapshotService.ts:155-170` | `total: count(*)` over `proxy_logs` |
| 3 | 延迟样本 + 站点/小时/模型投影 | `services/usageAggregationService.ts:347-360`（投影 `status`/`latencyMs`/`siteId`）、`:387-388`（`latencyCount = latencyMs > 0 ? 1 : 0`）、`:424`/`:447`/`:469`（`totalLatencyMs` 累加进 `site_day` / `site_hour` / `model_day`） | 逐行取 `status` / `latencyMs` |
| 4 | 可用率分母 / 失败分子 | `services/statsShared.ts:179`、`:229`（`buildSiteAvailabilitySummaries` / `buildSiteAvailabilitySummariesFromHourlyAggregates` ← `siteHourUsage`） | 用上面的投影 |
| 5 | 每日总结失败数 | `services/dailySummaryService.ts:87` | `proxyFailed = todayProxyLogs.filter(status === 'failed').length` |
| 6 | 模型日志统计 | `routes/api/stats.ts:1205-1215` | `modelLogStats[m].total++`、`totalLatency += latencyMs`，且 `status !== 'success'` 不计 success |
| 7 | 下游 key 失败数（两处，同口径） | `routes/api/downstreamApiKeys.ts:289`、`:377`；`services/downstreamApiKeyTrendService.ts:195`、`:287` | `failedRequests = sum(case when status='success' then 0 else 1 end)` |

**不存在既有可忽略位**（本工作区已核 `src/server/db/schema.ts:246-289`）：`proxy_logs` 的列里**没有** `internal` / `is_synthetic` / `exclude_from_stats` 一类标记；`status` 的取值空间是 `'success' | 'failed' | 'retried'`（注释亦然），而**上面每一个消费方都只按 `status`（外加 `created_at` / 站点 / 账号）判成败**——即便新行写 `'retried'`，也会落进 `status='success' then 0 else 1` 的「非成功」桶。⇒ 除非改所有聚合代码（本片范围外，且属「为观测改动统计语义」），否则**无法在 `proxy_logs` 里加一条不被计数的行**。

### 3. `events` 无任何统计消费方（方案 A 成立的依据）

`src/server` 全部非测试的 `schema.events` 引用（已逐一核对，无遗漏）：

- **写入（直插，不推送）**：`services/alertService.ts:24`、`services/checkinService.ts:187`、`:317`、`services/siteAnnouncementService.ts:143`、`services/backgroundTaskService.ts:158`、`services/updateCenterPollingService.ts:47`、`routes/api/sites.ts:409`、`:429`、`routes/api/auth.ts:53`、`routes/api/settings.ts:208`、`routes/api/accountTokens.ts:382`。
- **聚合器自有行**：`services/notificationAggregator.ts:283-285`（按 `eventId` UPDATE）、`:295-297`（按 id SELECT）、`:307`/`:425`/`:503`（缺行重插）——**只碰它自己建的行**。
- **保留期清理 / 复位 / 时间戳修复 / 迁移**（非统计）：`services/logCleanupService.ts:76-77`（按 `createdAt < cutoff` 删除）、`services/factoryResetService.ts:41`（清空）、`services/storedTimestampRepairService.ts:12-27`（规范化 `created_at`）、`services/databaseMigrationService.ts:277`（迁移时整表搬行）。
- **读侧**：只有 `GET /api/events`（列表）、`GET /api/events/count`（未读数）、`POST /api/events/:id/read` 与 `POST /api/events/read-all`（标记已读）、`DELETE /api/events`（清空）——均在 `src/server/routes/api/events.ts`——运维视图，**没有任何 `sum` / `count(*)` 按 status 之类** 的统计聚合；`GET /api/events/count` 提供「未读数」（前端徽标实取最近 30 行的 `!read` 计数，见 §1）。
- **`backupService.ts` 实际不涉及 `events`**（更正任务书里的举例）：其备份清单是 11 张表（`services/backupService.ts:553-566`：sites / accounts / accountTokens / tokenRoutes / routeChannels / proxyLogs / checkinLogs / siteAnnouncements / modelAvailability / tokenModelAvailability / downstreamApiKeys），**不含 `events`**⇒ 本片新增行不进备份，也不受恢复影响。

⇒ 新增的 `events` 行**不参与任何统计口径**，只出现在运维事件列表里；且**直插不推送** ⇒ 不影响告警。

**保留期与「直查窗口」**（已核 `logCleanupService` 与 `config`）：

- `events` 的清理口径 = `cleanupProgramLogs`（`services/logCleanupService.ts:60-86` 调 `:76` 的删除），**开关默认关闭**：`config.logCleanupProgramLogsEnabled` 默认 `false`（`config.ts:97`），保留期 `config.logCleanupRetentionDays` 默认 **30 天**（`config.ts:98`）。
  ⇒ **默认配置下本片新增的 `events` 行不会被定期清理**；若运维打开了程序日志清理，则按 **30 天**（可配）随同其它 `events` 行一起被删。
  - **精确口径（“才能起 cron”那半句要按源码读）**：清理 cron **本身总会注册**（`checkinScheduler.ts:257` 调 `createLogCleanupTask`），但**每次触发先看 `config.logCleanupConfigured`（默认 `false`，`config.ts:95`；由 `index.ts:204` 的 `hasExplicitLogCleanupSettings` 决定）**，不为真就直接跳过（`checkinScheduler.ts:195-198`）；即便为真，还要 `logCleanupProgramLogsEnabled` 为真才会真的删 `events`（`logCleanupService.ts:90` / `:99-110`）。⇒ 「默认永不清理本行」成立。
- **行数增长模式（必与直查口径一起读）**：
  - 出口是**每个失败请求 1:1 写一行、无合并、无去重窗**（直插 `events`，不经聚合器）⇒ 行数增长 **≤ 失败请求速率**（仅本出口 1:1；末轮直终态 / 固定通道 / `count_tokens` / `geminiSurface` / 6 route **不写**本标记 ⇒ 实际低于该速率）；在「单通道 + 不触发冷却的 4xx 形态」下即「每请求一行」（重试耗尽本身可反复发生的形态）。
  - `events` 侧**默认永不清理**（上一段：开关默认关 + 需 `logCleanupConfigured` 才会真跑）；**`proxy_logs` 另有独立保留服务**（与 `events` 不同源）⇒ 两者的增长/保留不能混谈。
  - **边际成本**：同一请求本就会写一条 `proxy_logs` 失败行（触发本次重试耗尽的那次失败 attempt 自己的行）⇒ 本标记是 **+1 行 / 失败请求**，**非新量级**；且它**不进任何统计口径**（§2/§3），只是 `events` 表多一行。
  - **明确标注（防误用为容量上限）**：此前文档里出现的「**≈42 行/周**」是**低频观测值，不是上限**——它只反映观测期内的失败速率（本仓库文档中未检索到该数字，属审查方引述口径）；本标记的**技术上界就是失败请求速率**（严重故障期可短时远高于该观测值），不能拿它当容量/增长上限用。
- 与 `proxy_debug_traces` 的交叉核对：traces 只留 **24 小时**（`config.proxyDebugRetentionHours` 默认 24，`config.ts:156`；`proxyDebugTraceStore.ts:153-161` 的 `deleteExpiredProxyDebugTraces`）⇒ **「按事件回查 trace」的窗口是 24 小时**，不是 30 天。
- **`proxy_logs` 那行从未发版**：本批初稿的 `proxy_logs` 写入只存在于工作区（未 commit）⇒ 生产库中**不存在**该类行，**无需任何数据迁移 / 回填**；反过来，历史上的重试耗尽只可能在 `events` 的 `'代理全部失败'` 行正文里（按片 1 §2 的 `%原因=retry exhausted: HTTP%` 口径查，且受 O1 时效性限制）。

### 4. 拆除清单（本批初稿新增的 `proxy_logs` 标记与管道，逐项→已全拆）

| 项 | 初稿位置 | 处置 |
|---|---|---|
| chat 出口的 `proxy_logs` 写入 | `chatSurface.ts` 出口内 `failureToolkit.log({...})` | **已删除**；出口保留 `reportProxyAllFailed` → **新增 events 直插** → `finalizeDebugFailure` → 客户端响应，顺序与语义不变 |
| responses 出口的 `proxy_logs` 写入 | `openAiResponsesSurface.ts` 出口内 `failureToolkit.log({...})` | **已删除**（同上） |
| `SurfaceRetryLogContext` 类型 | `sharedSurface.ts:683-691`（初稿） | **已删除** |
| `buildSurfaceRetryLogContext()` | `sharedSurface.ts:713-727`（初稿） | **已删除** |
| `SurfaceRetryTerminalFailure.logContext` 字段 | `sharedSurface.ts`（初稿必填） | **已删除**，恢复片 1 的 `{ status, payload, upstreamPath }` 形状 |
| 12 个留存点的 `logContext: buildSurfaceRetryLogContext({...})` | chat 6 + responses 6 | **已全删**（`rg logContext src/` = 0 命中） |
| `writeSurfaceProxyLog` 可选入参 `siteId` | `sharedSurface.ts:273`（初稿） | **已删除**（核全仓调用点：新增使用者只有上面两个出口；`sharedSurface.test.ts` 的两处 `writeSurfaceProxyLog` 调用**都没传过** `siteId`） |
| 故障工具包 `log` 可选入参 `siteId` | `sharedSurface.ts:746`（初稿） | **已删除**（同理无使用者） |
| `SurfaceSelectedChannel.site.id` 加宽 | `sharedSurface.ts:31`（初稿） | **已回退**为 `site: { name?: string | null }`（加宽的唯一用途就是 `buildSurfaceRetryLogContext`；其它 `selected.site.id` 用法来自 `selectSurfaceChannelForAttempt` 的 `SelectedChannel` 返回类型，与它无关） |
| `db.delete(schema.events)` 之外的测试夹具 | `chat.singleChannelFailure.test.ts` | **已改**：两条 `proxy_logs` 落库用例 → 两条等价的 `events` 落库用例；`beforeEach` 增删 `events` 表 |

**副作用提示（供后续切片，非本片范围）**：「可选 `siteId`」在初稿里是**共享写入口**上的加宽，因此**成功行**也经由 `recordSurfaceSuccess` 的 `logSuccess({... siteId: input.selected.site.id ?? null ...})`（**实测行号 `sharedSurface.ts:614`**——行号漂移已按真实源码订正：旧稿记作 `:615`）被带上 —— 即初稿实际把**所有** surface 日志行的 `site_id` 从 NULL 改成了实值（片 1 笔记把该处记作「`recordSurfaceSuccess` 直调 `logProxy` 带 `siteId`」，与源码不符：那行是喂给 `logSuccess` 入参）。本片按任务要求**整条回退** ⇒ surface 失败行/成功行的 `site_id` 回到 NULL（= HEAD 行为，行为不变优先）。若将来要整体对齐 `site_id`，应作为独立切片。

### 5. A 组：4 处流式失败 502 出口的 message 封顶（**保留不动**）

- 初稿新增的同文件私有包装 `truncateStreamFailureMessage`（`chatSurface.ts:307-309`，**空值保持 `null`**、不把 `null` 改写成空串）与 4 处出口的 `message: truncateStreamFailureMessage(streamResult.errorMessage)`（`chatSurface.ts:971`/`:1031`/`:1136`/`:1214`）**本片未改**；状态码 502、`type: 'upstream_error'`、响应结构不变。
- 可达性结论（**已按审查意见收窄，不再写「恒不生效/防御性」**）：
  - **夹具内不可构造**：上游 `error` / `response.failed` 帧被 `force` 成 SSE ⇒ `streamStarted = true` ⇒ 4 处 `!streamStarted` 出口不可达；夹具里唯一可达的失败源是本地生成的 `Upstream returned empty content`（且需 `proxyEmptyContentFailEnabled=true`，`proxyStream.ts:200-226`）。
  - **生产未证实可达、也未证实不可达**：2xx + JSON + `type:'error'` 体在 `PROXY_EMPTY_CONTENT_FAIL` 默认 `false`（`config.ts:186`）且 `proxyErrorKeywords` 默认空（`config.ts:185`）时会走 `consumeUpstreamFinalPayload → markFailed(上游 payload)`（`proxyStream.ts:344-355`，`markFailed` 在 `:353`），其 message 即**上游原文**（`extractFailureMessage`，`:86-102`：优先取 `payload.error.message`，无长度封顶）。⇒ 本条不能用作「该出口在生产永不可达」的证据。
  - **封顶保留**（回退成本高于价值：它只影响 message 长度，不改状态码/类型/结构）。

## 与片 1 笔记的关系：**收窄它两条主张**（不改旧笔记一字）

片 1 笔记（`.agents/notes/20261001-retry-exhaustion-real-upstream-error.md`）**一字未改**（含 frontmatter）——依 README，本片属**部分收窄**，不是整篇取代。两条被收窄的主张：

1. **片 1 的「终态出口自己不写 `proxy_logs`」**（其 §2「B 形态改后的落库面」、§5 表格等多处）→ **维持并加强**：终态出口**仍不写** `proxy_logs`；本片初稿一度打破它（出口补写一行），**已回退**。⇒ 「不能拿 `proxy_logs` 的行数判断重试耗尽是否发生」这条旧结论**继续成立**。
2. **片 1 的「唯一干净判别器 = `events.message LIKE '%retry exhausted: HTTP%'`」**（其 §2）→ **改为**：**主判别器 = `events` 独立 title 直查（`WHERE title = '代理重试耗尽'`）**。events 串**降级为辅助**信号，其时效性（聚合器保留集「[第 1, 第 2, 最新]」+ 200 字符规范化）与伪造面 **仍然成立**，只是不再需要它承担「唯一」的角色。

**仍然有效的片 1 条目（未被本片触碰）**：类型分流（有上游响应 ⇒ `upstream_error`；无 ⇒ `server_error`）、真实状态码回传、A 形态 503 原文案、截断器实现与「7 处应用点」枚举、`%No available channels after retries%` 的全仓 8 处写入、聚合器口径结论等。

**F1 相关表述的处置（消除「已作废的订正」）**：初稿有一处**订正**——「判别串不在 `proxy_logs.error_message` 串头，落库前 `composeProxyLogMessage` 会拼 `[client:…] [session:…] [downstream:…] [upstream:…] [usage:…]` 前缀，故串头锚定 SQL 必 0 行」。**该订正随 `proxy_logs` 路线一起作废**（该写入已不存在，没有串头可言）；本片不保留任何「基于 `error_message` 的锚定 SQL」。其中唯一仍然成立的事实（`composeProxyLogMessage` 会给 surface 侧 message 打前缀，`services/proxyLogMessage.ts:23-47`）只作为「`proxy_logs` 那行的判别串必然被前缀污染、故判别器不得建在该列上」的历史理由保留。**新方案下不存在串头/前缀问题**：判别建在 `events.title` 这一**结构化列**上，`message` 只承载上下文。

## 实测标注（哪些是实测、哪些只是代码推得）

- **已实测（本地，真跑用例）**：
  - chat 出口确实**只写一条** `events` 行：`title='代理重试耗尽'`、`type='proxy'`、`level='error'`、**`read=true`（已读）**、`relatedType='route'`，`message` 含真实状态码与判别串（实测原文见 §1，`attempt=1`、`tried_channels=[11]`、`stream=false`、`upstream=-`）；同一请求的 `proxy_logs` 里**再无**带 `retry exhausted:` 的行（只有该 attempt 自己的失败行）。
  - **A 形态不写**：`selectChannel` 直接返回 `null` ⇒ 503，且 `events` 里 title 命中数为 0。
  - **反向对照（真跑，已还原）**：把两个出口的 `insertRetryExhaustedEvent(...)` 临时改成 `if (false) await ...` ⇒ `chat.singleChannelFailure.test.ts` **1/12 FAIL**（`AssertionError: expected +0 to be 1`，即落库行数 0），A 形态用例仍通过；**还原后**同文件 **12/12 PASS**，且 `grep -rn 'if (false)' src/` **无命中**（无残留）。
  - **反向对照 2（本收边轮次新增，针对 `read: true`，均已还原）**：① 在 helper 里临时早退（`if (input.reason !== undefined) return;`）⇒ 事件落库用例 **1/12 FAIL**（`expected +0 to be 1`，落库行数 0），其余 11 条仍绿；② 把 `read: true` 临时改成 `read: false` ⇒ 同一用例 **1/12 FAIL**（`expected false to be true`，即新增的已读断言真的守护了新行为）。两次均随后还原，还原证据：`ctx_fs rg 'TEMP-RC|if \(false\)' src/` **0 命中**，且 `git diff --stat src/server/proxy-core/surfaces/sharedSurface.ts` = **+57/-0**（纯新增，与本片定稿一致），两遍全量联跑均绿。
  - A 组出口的对外形态（502 + `upstream_error` + 非 SSE + `message` 长度 ≤ 共享上限）与「上游超长 error 帧 ⇒ 200 SSE」两条结构锁仍绿（`chat.stream.test.ts`）。
- **代码推得 / 未实测**：responses 面的事件落库（本片落库用例只覆盖 chat 面；responses 出口为同构代码，由类型检查 + 同一 helper 兜住）；生产库上该 `events` 行的真实量与分布；`events` 行在真实站点上的上下文取值（用例用夹具 id）。
- **本片未做生产实验**：未启停容器、未写生产库、未制造失败流量。

## 遗留与跟进

1. **A 组用例无法覆盖「上游超长 message」**（初稿即有的偏差，本片未变）：**夹具内不可构造**——能走到那 4 处 502 出口的流式失败**只有本地生成的 `Upstream returned empty content`**；上游的 `error` / `response.failed` 帧会被 `proxyStream` 以 `force` 立刻写成 SSE 帧（`streamStarted` 变 true，`src/server/transformers/openai/chat/proxyStream.ts:322-327`），响应成为 200 SSE 流，**到不了 `!streamStarted` 出口**；而 `finalize()` 里唯一用本地串 `markFailed` 的空内容分支正是这些出口唯一可达的失败源（`:200-226`）。**生产未证实可达、也未证实不可达**（2xx + JSON + `type:'error'` 体在 `PROXY_EMPTY_CONTENT_FAIL` 默认 false 且 `proxyErrorKeywords` 默认空时会走 `consumeUpstreamFinalPayload → markFailed(上游 payload)`，其 message 为上游原文）。实测 13 种上游错误形态客户端状态码**全部 200**；给 4 处出口加临时探针后，整份 `chat.stream.test.ts` 里探针只命中 **3 次、message 全是本地串**。⇒「>1000 断言」与「去掉封顶 ⇒ 新用例 FAIL」的原生反向对照**不可构造**；本片在 `chat.stream.test.ts` 加的两条用例锁的是**出口不变量**与**结构性结论**（超长上游 error 帧 ⇒ 200 SSE）。**替代对照（初稿真跑并已还原）**：在本地失败源临时注入 5031 字符 message 后两次对照——去掉封顶 ⇒ 用例 FAIL（`expected 5031 to be less than or equal to 1000`）；恢复封顶 ⇒ PASS。
2. **出口处拿不到 route / 站点 / 延迟（本片最大偏差，如实登记）**：任务书要求 message 携带「真实状态码、判别前缀、route、当轮通道/站点、延迟、retry 轮次等当时可得的上下文」，同时要求**彻底删除 `logContext` / `siteId` 管道**。出口（`!selected && retryFailure`）在作用域内只有 `lastRetryFailure`（`{status, payload, upstreamPath}`）、`requestedModel`、`isStream`、`retryCount`、`excludeChannelIds`、`forcedChannelId` —— **route / 站点 / 账号 id / 当轮延迟从未在出口可见**，它们原先只存在于将被删除的 `logContext` 快照里。⇒ 本片按「同一时间只能保一条」取舍：**服从「拆除彻底」**（完成标准的核心），message 只带**出口当时确实可得**的上下文（模型 / 上游路径 / 流式标记 / 轮次 / 已试通道 id 列表 / 固定通道 id），**未**为了 route/站点/延迟 而重新引入任何上下文管道，也未新增 DB 反查（那会新增一条失败路径上的读放大）。`relatedType` 按代理域体例挂 `'route'`、`relatedId` 留空（同 `reportProxyAllFailed`）。**若产品确实要 route/站点/延迟进 message，需要显式拍板**：要么恢复一个最小上下文载体（等于把 `logContext` 换个名字留下），要么在出口加一次按通道 id 反查。
3. **responses 面缺落库用例**：落库断言只写在 chat 面（`chat.singleChannelFailure.test.ts:472`/`:507`）；responses 出口（`openAiResponsesSurface.ts:401`）为同构代码，仅由类型检查覆盖（要落库级覆盖需一个 responses 面的「重试耗尽 + 真实 sqlite」夹具，现无）。
4. **判别器直查的覆盖面（F2，须与判别器一起读）**：`events.title = '代理重试耗尽'` **只对 B1 形态成立**——即「本轮失败可重试、且下一轮已选不出通道」。下列形态**不写该行**（⇒ 查不到**不等于**没发生；判别器只能证「有」、不能反证「无」）：
   - **末轮直终态**：`retryCount == maxRetries`（`canRetryChannelSelection` 为假）⇒ 多通道下「最后一个通道也失败」是**常态**，走各出口的终态分支、不进重试耗尽出口；
   - **固定通道模式**（`channelSelection.ts:79` 使其恒假）；
   - **`count_tokens` handler**（`chatSurface.ts` 的 503 分支，全程无 `lastRetryFailure`）；
   - **`geminiSurface`**；
   - **6 个 route**（embeddings / images / completions / videos / search / rerank）。
   措辞**沿用片 1 笔记 §2 的 O3 条（逐字引用，未改动片 1 笔记正文）**：「**只覆盖「重试耗尽」形态（O3）**：B/C 两类除经重试耗尽出口外还有**直终态**形态——`retryCount == maxRetries` 的最后一轮（`canRetryChannelSelection` 为假）与固定通道模式（`channelSelection.ts:79` 使其恒假）都**不会**写 `retry exhausted:` 串：租约忙/并发超时的直终态只写 trace（`chatSurface.ts:762-773`、`:1381-1383` 走 `finalizeDebugFailure`）、**不写 events**；固定通道的 `!selected` 分支即便写 events 也是旧原文案（`chatSurface.ts:445-457`）。⇒ 拿 events 判别器只能证明「发生过重试耗尽」，**不能反证**「没发生过租约忙/并发超时」。」（末句的「events 判别器」在方案 A 下读作「`events.title` 直查判别器」；O3 的形态划分对两者**同样成立**。引用中的行号为片 1 当时的快照，本片未据此改动。）
   - **查不到时怎么办（必读）**：
     - ① **A 形态与上述其它形态不写本标记**（首轮/末轮无通道、固定通道、`count_tokens`、`geminiSurface`、6 route）⇒ 其最典型落点恰好是**客户端 503 + `No available channels`**。**下一步**：查聚合器维护的 `title='代理全部失败'` 行（原因串里带 `No available channels after retries`，`alertService.ts:52-64`）：
       ```sql
       SELECT id, created_at, title, message FROM events
        WHERE title = '代理全部失败'
          AND message LIKE '%No available channels after retries%'
        ORDER BY id DESC LIMIT 50;
       ```
       再与 **24h 内**的 `proxy_debug_traces` 交叉（trace 只留 24 小时，`config.ts:156`）：
       ```sql
       SELECT id, created_at, final_http_status, selected_channel_id, selected_route_id, selected_site_id
         FROM proxy_debug_traces
        WHERE final_http_status = 503
          AND created_at >= datetime('now', '-1 day')
        ORDER BY id DESC LIMIT 100;
       ```
       （口径提醒：聚合器那条是**聚合 + 延迟**视角、不与 trace 一一对应，可能被折叠成「风暴聚合」；签名与陷阱见 `.agents/notes/20261001-post-1412-observe-trace503-and-setting.md`。）
     - ② **补全 route / site / account，以及延迟怎么拿**：本行 `message` 已带 `tried_channels=[…]`（= 出口时 `excludeChannelIds`，元素是 `route_channels.id`）⇒ 用它 **join 一次**即可补全：
       ```sql
       -- 把 message 里 tried_channels=[…] 的数字逐个贴进 IN (…)
       SELECT rc.id AS channel_id, rc.route_id, tr.model_pattern,
              a.id AS account_id, a.username AS account_username,
              s.id AS site_id, s.name AS site_name
         FROM route_channels rc
         LEFT JOIN token_routes tr ON tr.id = rc.route_id
         LEFT JOIN accounts      a  ON a.id  = rc.account_id
         LEFT JOIN sites         s  ON s.id  = a.site_id
        WHERE rc.id IN (11, 12);
       ```
       **延迟不在本标记里**（出口处拿不到，见「遗留」2），但**同轮 `proxy_logs` 行的 `latency_ms`** 可取（两侧 `created_at` 都是 UTC `'YYYY-MM-DD HH:MM:SS'`，用 `model=` + 时间邻近锁定）：
       ```sql
       SELECT id, created_at, status, http_status, retry_count, latency_ms, error_message
         FROM proxy_logs
        WHERE model_requested = 'gpt-4o-mini'                     -- ← 事件 message 里的 model=…
          AND created_at <= '<事件 created_at>'
          AND created_at >= datetime('<事件 created_at>', '-5 seconds')
        ORDER BY id DESC LIMIT 5;
       ```
     - ③ **反例（勿把 O3 读成「busy 形态永不写」）**：**租约忙 / 站点并发超时若发生在「仍有重试余量」的轮次，是**会写**本标记的**——该轮失败被留存为 `lastRetryFailure`（`canRetryChannelSelection` 为真 ⇒ `lastRetryFailure = { status:503, payload:{ error:{ message: 'Channel busy: …' } } }` 后 `continue`），下一轮选不出通道时即命中本出口 ⇒ `message` 形如 `retry exhausted: HTTP 503: Channel busy: …`。⇒ 区分「写」与「不写」的是**该轮是否还有重试余量**，不是失败类型；片 1 笔记 O3 说的是**直终态**（无余量）那一种不写。
5. **`events` 行的运维可见性（本片已改为「不在前端可见」）**：该行**已从通知中心口径摘除**——服务端 `routes/api/events.ts` 的列表与未读计数两个读接口按 title 排除 ⇒ **不出现在通知面板列表、不计入未读徽标/计数**。由此**运维侧也不再从前端看到它**：`/api/events` 是**同一个**列表接口，`src/web/pages/ProgramLogs.tsx:117`（程序日志页，筛选标签「代理」见 `:25-33` 的 `TYPE_OPTIONS`）同样查不到本行；**唯一入口是 SQL 直查**（判别器 SQL 见 §1）。**标记行仍照常落库**（写侧未改：仍显式 `read: true`；`/api/events/:id/read`、`/read-all`、`DELETE` 也未改）。精确口径（面板**列表**本身不带 `read` 过滤，此前仍占列表 1 个位次——现已由服务端排除）见 §1「落库即置已读」条。另：**不推送**、不进聚合器、不进任何统计（§3）。前端 `App.tsx` 的「新任务事件」轮询只挑 `relatedType === 'task'`（`src/web/App.tsx:553`），本行不会触发它。
6. **A 组之外仍有未封顶出口**：`geminiSurface.ts:1434-1437` / `:807`、6 个 route（embeddings / images / completions / videos / search / rerank）的错误体（片 1 §5 已登记，本片未动）。
   - **顺带观察（本片未改，超出本片范围、供后续切片参考）**：真跑发现上游在 SSE 流里下发的 `data: {"error":{…}}` 帧**不会**被转成客户端可见错误——客户端拿到的是 `delta:{}` + `finish_reason:"stop"` + `data: [DONE]` 的**空成功流**（`proxyStream` 吞掉错误帧、不转发其正文），且该请求被记为 **success**。⇒ 上游在 200 流里报错会**静默伪装成空成功**（与片 1 的「上游 401/403 可能被客户端误读」同类归因风险），但它是**既有行为**，非本片引入。

### 观察登记（本片未改行为，供后续切片裁决）

1. **`relatedType='route'` ⇒ 通知点击落 `/routes`，不是 `/logs`**：前端 `buildEventNavigationPath` 对 `relatedType === 'route'` 直接返回 `/routes`（`src/web/pages/helpers/navigationFocus.ts:104-106`），**先于** `eventType === 'proxy' → '/logs'`（`:107-109`）这一条。本标记与 `reportProxyAllFailed`（「代理全部失败」）**同构**、行为一致；若要让本标记跳 `/logs`（或带模型/时间过滤），属**产品决定**，本片未改。
2. **租约忙轮次会把「未真正发出请求的通道」计入 `tried_channels`**：`excludeChannelIds.push(selected.channel.id)` 发生在**选中之后、发请求之前**，而租约忙 / 站点并发超时恰在这两者之间——即该通道**从未收到本请求**，却已进入排除集并被本标记原样写进 `tried_channels=[…]`（`attempt` 也计入了这一轮）。⇒ `tried_channels` 应读作「**本轮被排除过的通道 id**」而非严格意义上的「已向上游发过请求的通道」；**语义轻微偏差**，好在同轮必有该通道自己的失败行（`failureToolkit.log`，`http_status=503` + `Channel busy: …`）可区分。
3. **（已解决，保留一行历史）曾计划「发版后盯 `代理重试耗尽` 在最近 30 行中的占比、若出现挤占真告警再决定排除」**：该观察项**已闭环**——本标记**已从通知面板与未读徽标/计数中摘除（服务端按 title 排除）**；**标记行仍落库、仍可 SQL 直查**。⇒ **不再需要「盯占比」这一发版后动作**；**曾短暂存在挤占风险**（旧口径下该行占最近 30 行窗口 1 个位次，高频风暴下可能把真告警挤出面板列表、并使徽标计数窗口被占），**已由本片排除修复**。
4. **（知情保留）`CHANGELOG.md` [Unreleased] 首条里流式四处的行号是「片 1 当时」值 `chatSurface.ts:947`/`:1007`/`:1112`/`:1190`（三值对照，均已实测复核）**：① **当时值** = `:947`/`:1007`/`:1112`/`:1190`（`rg -n '947|1007|1112|1190' CHANGELOG.md` 命中该 bullet）；② **HEAD 值** = `:949`/`:1009`/`:1114`/`:1192`（`git show HEAD:src/server/proxy-core/surfaces/chatSurface.ts | rg -n 'streamResult\.errorMessage'` 的 4 处 `message:` 行），较当时值 **+2**（片 1 出口在其上方插入所致）；③ **改后值** = `:971`/`:1031`/`:1136`/`:1214`（`rg -n 'truncateStreamFailureMessage\(' src/server/proxy-core/surfaces/chatSurface.ts` 的 4 个调用点，函数定义行 `:307` 除外），较 HEAD **+22**（本片新增 `insertRetryExhaustedEvent` 等出口代码所致）。该串属「片 1 当时」叙述，「改后」行号已在相邻 bullet（[Unreleased] 第 3 条）双标注 ⇒ 知情保留不动。**订正（本行）**：旧表述把**当前工作区值** `971`/`:1031`/`:1136`/`:1214` 误标为「HEAD 实测」并把「当时值↔HEAD 差值 2」张冠李戴到当前值上；现按上列三值分别标注，原结论（知情保留不动）不变。
5. **（知情保留）本片新增的 `src/server/routes/api/events.test.ts` 无「改前快照」**：其中「对照行 `read false→true`」只能以**构造必要性**论证（新文件无改前基线可对照），非实测对照 ⇒ 如实保留。

## 被放弃的方案（「为何被否」的记录）

- **初稿路线 (b)：重试耗尽出口补写自己的 `proxy_logs` 行**（用户先选、后改判）——**被否**，两条 scout 实测隐患（本片已**从根上避开**）：
  1. **它是 attempt / 请求级表里的又一行** ⇒ 任何新增行都会让「请求数」虚增（`dashboardSnapshotService.ts:155-170` 的 `count(*)`、`stats.ts:1215` 的 `total++`），并让「失败数 / 成功率分母」虚增（§2 表）——而 `proxy_logs` **没有可忽略位**，只能靠改所有聚合代码来豁免，等于「为观测改动统计语义」。
  2. **判别器不得不建在 `error_message` 文本列上** ⇒ 该串的**尾部是上游可控文本**（`retry exhausted: HTTP <status>: <payload.error.message>`），所以任何**基于 `error_message` 的排除**（例如「请求级成功率」要用 `error_message NOT LIKE '%] retry exhausted: HTTP%'` 把本行扣掉）都可被上游**伪造**——上游只要在自己的报错体里回显该字样，就能把一条真实请求行从统计里「扣掉」，或反向污染判别。除文本列外无结构化判据可用（`proxy_logs` 无 route/`error.type` 之外的判别列，且串头还会被 `composeProxyLogMessage` 的前缀污染，见「F1 处置」）。
  - 故改用 `events` 独立 title：判别器落在**结构化列 `title`** 上（不可被上游文本伪造），且该表**无任何统计消费方**、**直插不推送**。
- **A 组直接内联 `truncateUpstreamErrorMessage(streamResult.errorMessage ?? '')`**：会把 `null` 变成空串，属对外行为改变（原本 `message: null`）；改用保留 null 的包装函数。
- **A 组写「上游超长 ⇒ 客户端 message ≤1000 且以 `...(truncated)` 结尾」的用例**：实测不可构造（见「遗留」1），硬写只能是假绿；改为锁出口不变量并在本笔记 + 回报里如实标注偏差。
- **在出口加一次「按已试通道 id 反查 route / site」以补齐 message 上下文**：会给失败路径新增一次 DB 读与新的失败模式，而 `logContext` 已被要求删除；本片不引入（见「遗留」2），若要补需显式拍板。
- **改片 1 笔记正文来同步口径**：README 明确禁止改写旧笔记内容；本片一律以新笔记收窄，旧笔记一字未改。

## 来源

- 代码（**关键**行号已按本片定稿工作区复核；行号易漂移，定位请以符号/端点名为准）：`src/server/shared/eventTitles.ts`（`:14` `export const RETRY_EXHAUSTED_EVENT_TITLE = '代理重试耗尽'`——title 常量**新家**，本片从 `sharedSurface.ts` 迁出，供 `routes/api/events.ts` 与 proxy-core 共用）；`src/server/routes/api/events.ts`（`:4` 导入 title 常量、`:20` 列表与 `:46` 未读计数分别用 `ne(schema.events.title, RETRY_EXHAUSTED_EVENT_TITLE)` 排除）；`src/server/proxy-core/surfaces/sharedSurface.ts`（`:24` 新增 `db, schema` 导入、**`:25` 从 `../../shared/eventTitles.js` 导入 title 常量**（原 `:697` 处的定义已迁出）、`:711-744` `insertRetryExhaustedEvent`（`:731` 的 `db.insert(schema.events)`、`:733` title、`:737` 的 `read: true`、`:742` 的 catch+warn）、`:650` 上限常量、`:659-675` `truncateUpstreamErrorMessage`、`:614` 成功行 `logSuccess` 入参里的 `siteId`（本片**未改**，仅作「初稿副作用」证据））；`src/server/proxy-core/surfaces/chatSurface.ts`（`:70` 导入、`:444-466` 出口（`:447` reason、`:455` 事件写入）、`:307-309` `truncateStreamFailureMessage`、A 组 4 处出口 `:971`/`:1031`/`:1136`/`:1214`）；`src/server/proxy-core/surfaces/openAiResponsesSurface.ts`（`:85` 导入、`:390-412` 出口（`:393` reason、`:401` 事件写入））。
- 先例与消费方（本片读过的证据）：`src/server/routes/api/sites.ts:409-416`/`:429-437`、`src/server/services/checkinService.ts:187-195`/`:317-325`、`src/server/services/alertService.ts:24`（直插 `events` 的三个先例）与 `:53-64`（`reportProxyAllFailed` 的 events 形态）、`src/server/services/notificationAggregator.ts:117-119`（`level||title` 签名）、`:283-297`（聚合器只碰自己的 `eventId`）、`:418` /`:33` `/`:238-252`（O1 的规范化与保留集）；`src/server/routes/api/events.ts`（读侧端点：`GET /api/events` / `GET /api/events/count`；写侧：`POST /api/events/:id/read` / `POST /api/events/read-all` / `DELETE /api/events`）；`src/server/services/logCleanupService.ts:60-86`；`src/server/services/factoryResetService.ts:41`；`src/server/services/databaseMigrationService.ts:277`；`src/server/services/storedTimestampRepairService.ts:12-27`；`src/server/services/backupService.ts:553-566`（备份表清单，不含 events）；`src/server/db/schema.ts:246-289`（`proxy_logs` 无「可忽略位」）、`:627-642`（`events` 列，含 `:633` 的 `read`）、`:277`（`site_id` 曾存在但本片不再使用）；`src/server/config.ts:97`/`:98`（程序日志清理开关与保留期）、`:156`（trace 保留 24h）；`src/server/services/proxyLogMessage.ts:23-47`（F1 处置引用）。
- 测试：`src/server/routes/proxy/chat.singleChannelFailure.test.ts`（12 条，含 `:472`「writes exactly one retry-exhausted events row …」与 `:507`「does not write a retry-exhausted events row for the first-round no-channel shape」——**标记行确实落库的断言仍保留**）、`src/server/routes/proxy/chat.stream.test.ts`（103 条，含 A 组两条结构锁）、`src/server/routes/api/events.test.ts`（**本片新增 2 条**：注册 events 路由插件后请求 `/api/events`（无 filters、带 filters、用例 ① 另含 `?read=true`）与 `/api/events/count`，断言`看不到该 title`、计数不含它，并以一条其它 title 的事件（`'代理全部失败'`）作对照；用例 ① 的 `?read=true` 是对「`read=true` 过滤 × 排除」的守护——标记行生产形态 `read: true`，该分支下不被 `read` 过滤遮盖，缺席只能由按 title 排除解释；该文件不在 `routes/proxy/` + `proxy-core/` 两目录内 ⇒ **单独跑**）。
- 验证命令与计数（本收边轮次实跑，见回报）：`npm run typecheck`（web / web:test / server / desktop 四段全绿）；`npx vitest run --root . src/server/routes/proxy/ src/server/proxy-core/` **连跑两遍**，两遍均 = **54 文件 / 583 用例全绿**（日志：`/tmp/vitest-run1.log` / `/tmp/vitest-run2.log`，已逐份保留）；`npm run repo:drift-check` = **0 违规**（5 条 `tracked_debt` 均既有白名单项）；`git diff --check` 无输出（exit 0）。**本片（摘除）实跑**：`npm run typecheck` 四段全绿；上列两目录 vitest **复跑一次仍 = 54 文件 / 583 用例全绿**；`npm run repo:drift-check` = **0 违规**（同上 5 条既有 `tracked_debt`——title 常量迁到 `src/server/shared/` 后**未新增** `proxy-core-routes-proxy-import` 债）；`npx vitest run --root . src/server/routes/api/events.test.ts` = **1 文件 / 2 用例全绿**；`git diff --check` 无输出。**反向对照（本片真跑并已还原）**：把 `events.ts` 两处 `ne(...)` 临时换成哨兵 title ⇒ `events.test.ts` **2/2 FAIL**（列表多出 `代理重试耗尽`；未读计数 2 而非 1）；还原后同文件 **2/2 PASS**，且 `rg 'TEMP-REVERSE-CONTROL|if \(false\)' src/` = **0 命中**。
- 相关笔记：`.agents/notes/20261001-retry-exhaustion-real-upstream-error.md`（片 1；本片收窄其「唯一干净判别器 = events 串」一条，并维持其「终态出口自己不写 `proxy_logs`」；其余条目仍以它为准）、`.agents/notes/20261001-post-1412-observe-trace503-and-setting.md`、`.agents/notes/20261001-canary-controlled-4xx-endpoint-cooldown-verified.md`（本片未改动其结论）。
