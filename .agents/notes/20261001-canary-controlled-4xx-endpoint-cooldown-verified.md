---
status: active
superseded_by: ""
supersedes: ""
模块: "services, proxy-core, docs"
---

# 隔离 canary 受控 4xx 实测：端点冷却「429 不写（实测）、窗口内不续期」已获直接证据

## 一句话结论

在隔离**影子容器**（`metapi-4xx-canary`、`--network host`、`PORT=4101`、镜像 `metapi:1.4.12`、库为生产 `hub.db` 的**只读一致性快照副本**）上，用本地 mock 上游（`127.0.0.1:18791`）打受控失败，把既有笔记 `20261001-post-1412-observe-trace503-and-setting.md` 第 3、4 节的**两条「生产未验证」推进为「已在隔离 canary 中验证」**：

- **S1 — 已验证（429 实测）**：429 失败**写 `last_failed_at` 但不写 `cooldown_until`**（两次 429 后 `cooldown_until` 两次均为 NULL，且该端点**仍被后续请求选中**）。本条**只实测了 429**：它依据的判据（`isClientErrorStatus` = 400–499）对全部 4xx 一致，但本实验**未逐档实测**；其它 4xx 档（含 408 这类虽在 `RETRYABLE_STATUS_CODES` 但仍属 4xx 的）只有代码判据与单测覆盖，见「来源」节的单测清单（单测实际取 429 / 402 / 401）。
- **S2 — 已验证**：**触发型失败（会写冷却的那一类）在既有冷却窗口内到账时，窗口未被重算/延长**——`last_failed_at` 被刷新（证明 `recordSiteApiEndpointFailure` 确实为这次失败执行过），而 `cooldown_until` **实测未重算**（若重算会得到可区分的不同值）。
- **对照 C — 已验证（仪器有效性）**：同一环境里 500 会正常写下 `last_failed_at + 120s` 的窗口并把端点拉黑（此后请求不再触达上游）。⇒ S1 的「429 没写冷却」**不是「没观测到」**。

**边界（不得夸大）**：这是**隔离 canary**（影子容器 `metapi-4xx-canary` + 生产 `hub.db` 的**只读快照副本** + 本地 mock 上游 + 非生产旋钮 `DISABLE_CROSS_PROTOCOL_FALLBACK=true` / `SITE_API_ENDPOINT_COOLDOWN_SEC=120`），**单次运行、无原始留档、不可重查**，不是生产真实流量；只覆盖**端点级**语义（**通道级语义不在本实验范围**）；客户端可见的 **503 在本实验中仍会因通道级机制出现**（见第 4 节）。

## 背景

1. **为什么要做**：旧笔记 §3/§4 的判定是「生产未验证」，原因是生产**没有触发机会**——上线后两次上游 404 走的是 `/v1/responses` → `/v1/chat/completions` **降级路径**（判据 `downgrade_decision=1`），流程返回 ok，**从未进入 `recordSiteApiEndpointFailure`**；且生产当时无未来冷却、无「窗口内到账失败」样本。旧笔记「被放弃的方案」已写明备选：用发版 canary 的隔离副本 + 受控 4xx 替代「在生产注入故障」。本记录即该备选的落地。
2. **环境与隔离手法**：
   - 影子容器 `metapi-4xx-canary`：`--network host`、`PORT=4101`、`DATA_DIR=/var/lib/metapi/shadow-4xx-canary/data`、镜像 `metapi:1.4.12`（与生产现役同 tag）。
   - 库来源：`sqlite3 "file:/var/lib/metapi/data/hub.db?mode=ro" ".backup …"` 一致性快照 + `PRAGMA quick_check=ok` 通过；**所有写入只落在副本**。
   - mock 上游：python3 监听 `127.0.0.1:18791`，可切 429 / 500、可按时间窗注入延迟。
   - 靶点：端点 `site_api_endpoints.id=67`（site 49 Cline，该站点**仅 1 个端点**，单通道路由）；路由 `token_routes.id=1377` → 唯一通道 `route_channels.id=1811`（account 38 → site 49）。
   - 旋钮（**仅 canary 容器 env**）：`SITE_API_ENDPOINT_COOLDOWN_SEC=120`（便于把窗口放大到肉眼可判读）、`DISABLE_CROSS_PROTOCOL_FALLBACK=true`（关掉降级路径，否则 4xx 会像生产那样被降级吃掉、根本走不到端点冷却记录）。
   - **出网隔离（仅改副本库）**：site 49 与端点 67 的 `url` 均指向 mock，其余 **18 个 active 站点置 disabled**（生产 active 19 个，减去 site 49）⇒ 实测中**通道恢复探测被导向 mock，无任何真实站点外呼**。
3. **与既有笔记的关系（本记录对旧笔记采取「完全不动」）**：旧笔记 §1/§2/§5/§6（503 观测口径、上线后观测、遗留、覆盖盲区）**仍然有效并继续以其为准**，本记录只推进 §3/§4 的两条判定——属**部分推进**，不是整篇取代。依据 `.agents/notes/README.md`「记录规范」：只在「旧笔记**被新方案取代**时」允许在旧笔记 frontmatter 加 `superseded` / `superseded_by` 链接，且**禁止直接改写或删除旧笔记内容**；本篇属部分推进，给旧笔记挂整篇 `superseded` 会把仍然有效的 §1/§2/§5/§6 一并标死，属**误标**，故不加；正文与来源节亦无规范依据可加，故**一字未改**（含行号）。另：旧笔记的两处行号引用经复核**本身准确**——`src/server/proxy-core/surfaces/chatSurface.ts:424-437`（chat 侧 503 分支）、`:439`（`excludeChannelIds.push`）、`:1545-1556`（count_tokens 侧 503 分支，`:1557` 是该 `if` 块的闭合大括号），**不存在需要更正的行号**，勘误亦无事实必要。

## 决策

### 1. S1：429 在**无既有冷却时**不写端点冷却 — 已在隔离 canary 验证

- 手法：mock 连返两次 429（`04:32:06`、`04:32:44`，UTC）。
- 观测（副本库 `site_api_endpoints.id=67`）：
  - `last_failed_at` **两次均被写入**（`…T04:32:06.954Z`、`…T04:32:44.039Z`）；
  - `cooldown_until` **两次均保持 NULL**。
- **主证（两侧对齐到「落库行 + 时间戳」）**：上一条的字段观测 ＋ `proxy_logs` **83620 / 83621** ＝ route 1377 / channel 1811 / **http 429** ⇒ 端点**仍被后续请求选中**，既不是「写不进去」也不是「写进去又立刻被清」。
- **旁证（降级使用）**：mock 上 `POST /v1/responses` 的计数 n=3 / n=5 递增。该计数**不能单独作证**——**通道恢复探测 / 运行时模型探测会绕开端点池、同样计入这一计数**（见第 4.3 条），故只作辅助。
- 请求确实走完了路由：`proxy_logs` id **83620 / 83621** = route 1377 / channel 1811 / **http 429**；`proxy_debug_traces` **10939 / 10940** = site 49 / platform openai；对应 attempt 的 `target_url=http://127.0.0.1:18791/v1/responses`。
- 代码侧对应语义：`triggersEndpointCooldown` 在可重试状态码分支上取 `!isClientErrorStatus(status)`（`src/server/services/siteApiEndpointService.ts:281`），而 `429` 属 `RETRYABLE_STATUS_CODES`（`:14`）、`isClientErrorStatus` = 400–499（`:238-240`）⇒ 429 的 `triggersEndpointCooldown=false`；`last_failed_at` 恒写、`cooldown_until` 只在 triggered 时才重算（`:397` vs `:390-393`）。
- **对照旧笔记 §3**：生产当时拿不到样本是因为 4xx 走了降级路径；本次用 `DISABLE_CROSS_PROTOCOL_FALLBACK=true` 把该干扰去掉，样本才真正落到 `recordSiteApiEndpointFailure`（`:374`）上。
- **措辞限定（防误读）**：本档证明的是**「无既有冷却时：不写」**——端点当时**没有生效中的窗口**，「延长」无从谈起。**「已有冷却不被解除」这一档未在本次实验覆盖**：代码在 `triggersEndpointCooldown=false` 时**保留已有冷却**（含已过期时间戳）⇒ 4xx 不会提前解除已有端点冷却（取舍见 `:381-384` 注释、沿用条件见 `:390-393`，即旧笔记所指遗留 K）；该行为只有单测覆盖，见「来源」节的单测清单。

### 2. 对照 C：仪器有效性 — 已在隔离 canary 验证（同环境 500 会写窗口）

- 把 mock 改为返 500 一次 ⇒ `cooldown_until = …T04:35:12.751Z = last_failed_at(04:33:12.751Z) + 120s`：**`SITE_API_ENDPOINT_COOLDOWN_SEC=120` 确实生效**（说明「窗口」这条通道本身是活的）。
- 再打一次 500（落在上面的冷却窗内）⇒ **客户端收到 503**、且 **mock 请求计数 12→12 不变**（旁证；口径见第 1 节——探测类外呼亦会计入该计数，故只作辅助），主证仍是数据侧：端点被拉黑、请求不再触达上游，`proxy_logs` **83625** 记录「**当前站点的 API 请求地址均不可用**」。
- ⇒ 与 S1 形成**强对照**：同一套环境、同一端点，500 能写窗口并拉黑，429 不写也不拉黑。**S1 的 NULL 是「4xx 语义」的结果，不是「观测失效」**。
- 附带确认：这次 503 的**客户端可见形态**与旧笔记描述一致——它同样**不写自己的 `proxy_logs` 行**（该行 83625 是「均不可用」这条**导致**进入 503 分支的记录，不是 503 本身），观测仍要靠 `proxy_debug_traces` / `events`。

### 3. S2：**触发型失败**在既有冷却窗口内到账时，窗口未被重算/延长 — 已在隔离 canary 验证

- **为什么不用「预置一个未来冷却」的直白手法**：冷却中的端点会在**选择期**被 `isEndpointCoolingDown` 过滤掉（`:234-236`，用点 `:335`），预置「生效中」的冷却会让请求根本走不到 `recordSiteApiEndpointFailure`，构造不出目标事件。⇒ 改用**并发在途的等价手法**。
- 手法：慢请求 S（状态码 **500**，属**触发型失败**＝会写冷却的那一类）在 mock 上睡 12s、**仍在途时**打快请求 F 先失败、把窗口写下来；随后观察 S 的失败到账时窗口是否被改写。
- 结果：
  - F 的失败写下 `cooldown_until = …T04:40:39.516Z`（= F 的 `last_failed_at` `04:38:39.516Z` + 120s）；
  - S 的失败随后到账 ⇒ `last_failed_at` 被**刷新为 `…T04:38:42.872Z`**（⇒ **证明该次失败确实执行过 `recordSiteApiEndpointFailure`**，否则这个字段不会动）；
  - S 到账后 `cooldown_until` **实测未重算**（若按新失败重算应为 `04:38:42.872 + 120s ≈ 04:40:42.872Z`，**实测保持 `…T04:40:39.516Z`**），两者相差 **≈3.4s**（可明确区分「原地保留」与「重算」）。
  - 注：任务简报里把该差值写作「差约 23s」，与这三个时间戳的算术不符（实测差 ≈3.4s）；本记录按**实测时间戳及其算术**书写。
  - `last_failure_reason` 的取值**不可得**：影子容器与副本快照已按收尾要求删除（第 5 节），本记录未留该字段当时的文本；可确定的是它按 `:395-400` 随该次失败**无条件刷新**，但具体值事后不可重查。
- 代码侧对应语义：`cooldownUntil` = `disposition.triggersEndpointCooldown && !isCooldownActive(existingCooldownUntil, nowIso) ? now+1000*cooldownSec : existingCooldownUntil`（`:390-393`）⇒ 「已存在生效中窗口」时**沿用现值**；`last_failed_at` 与 reason 无条件刷新（`:395-400`）。注释里写明的取舍是：4xx 期间**不提前解除**已有冷却（遗留 K）。
- **本档的适用边界**：S2 证明的是**触发型失败**（500 这类会写冷却的状态码）在既有冷却窗口内到账时**窗口不被重算/延长**；**非触发型失败**（429 等 4xx）在既有窗口内到账的行为**不在本实验样本内**（第 1 节是「无既有冷却」档）。
- **覆盖关系（与单测、与旧笔记）**：S2 覆盖的是**端点级**「触发型失败在窗内不续期」；旧笔记 `20261001-post-1412-observe-trace503-and-setting.md` 第 4 节的**通道级/成员级**「窗口保持」仍**只由单测覆盖**（`tokenRouter.cache.test.ts:314/368/425`、`tokenRouter.oauth-route-units.test.ts:540/606/674`），本实验未触及该层——互引以免误读为「通道级也已实测」。

### 4. 三条**通道级**观察（与端点级正交，属**同场次附带观测**：单点、无对照，未经受控验证）

1. 本实验中客户端最终**仍收到 503 `No available channels for this model`**——触发点在**通道级**（通道重试/冷却把请求拦下），而**端点并未被拉黑**（S1 已证）。该文案即 `channelSelection.ts:71-77` 的 `buildForcedChannelUnavailableMessage(null)`（`:74`），由 `!selected` 分支经 `reply.code(503).send` 下发。**本实验存在 mock 计数的请求是 `POST /v1/responses`（platform openai）**，故发出该 503 的很可能是 `openAiResponsesSurface` 的**同构分支**：`src/server/proxy-core/surfaces/chatSurface.ts:424-437` **与** `src/server/proxy-core/surfaces/openAiResponsesSurface.ts:379-390` **两者并列**（两面同款 503 分支，本记录**无法确认**实际走了哪一个）；对应的 trace id 记录中**不可得**（副本调试库已随影子目录删除）。⇒ **端点级修好 ≠ 客户端看不到 503**，两层要分开谈。
   - **易误读（同一分支两个字符串）**：客户端可见的是 `No available channels for this model`（上引 `channelSelection.ts:74`，经 `reply.code(503).send` 下发）；而同一分支里 `reportProxyAllFailed` 写进 `events` 的 reason 却是 `No available channels after retries`（非 forced 时；`chatSurface.ts:426-429` / `openAiResponsesSurface.ts:380-383`）——**两串不是同一串**，落库面也不同（旧笔记 §1 的「正确签名 / 第二条独立观测线」用的正是后者 `events.message LIKE '%No available channels after retries%'`，勿混用）。
2. **通道级 Fibonacci 退避会随 `fail_count` 放大**：实测 `fail_count=7 → 195s` 通道冷却（**算术可复核**：`FAILURE_BACKOFF_BASE_SEC=15` × `fibonacciNumber(7)=13`，见 `src/server/services/tokenRouter.ts:94`、`:311-321`、`:327-330`；`:97` 的 `MAX_FAILURE_BACKOFF_SEC` = 30 天）。**上限不止一道**：`resolveEffectiveFailureCooldownMs`（`:343-345`）外面还有第二道 clamp —— `clampFailureCooldownMs`（`:338-341`）→ `resolveConfiguredFailureCooldownMaxMs`（`:332-336`）→ `config.tokenRouterFailureCooldownMaxSec`（`src/server/config.ts:131-133`，默认取 `TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING`，见 `config.ts:18`；可用 `TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC` 调低）⇒「上限 30 天」**只在默认配置下成立**。走 Fibonacci 分支的条件是**路由策略非 `round_robin`**（`tokenRouter.ts:2799` 的 `round_robin` 分支另走阶梯冷却，`:2810-2815` 的 else 分支才用 `resolveEffectiveFailureCooldownMs(failCount)`）；本实验路由 1377 的生产取值正是 `stable_first`（见「来源」节正面佐证），故 `fail_count=7 → 195s` **唯一可解释**。它把通道锁死，并触发 `refreshModelsAndRebuildRoutes`（旁证：mock 上看到 `GET /v1/models`）；请求内刷新的入口是 `channelSelection.ts:106-116`（`:110`）。
3. **通道恢复探测以 30s 周期扫描、主动打上游**：`CHANNEL_RECOVERY_SWEEP_INTERVAL_MS = 30_000`、探测超时 12s（`src/server/services/channelRecoveryProbeService.ts:21-22`）；**但「30s 扫一次」不等于「每 30s 每通道打一次」**——还有并发 1（`:24`）、单批 4（`:25`）的节流，以及复检窗（冷却源 30s / 活跃源 5min，`:26-27`）⇒ 单通道实际间隔 ≥ 30s 且受批量/并发限制。探测经 `probeRuntimeModel`（`runtimeModelProbe.ts:98`）出网——本实验中该探测被导向 mock，故会**计入同一份 mock 计数**（第 1/2/4.2 条的 mock 数字因而只作旁证）。⇒ 对上游而言这是**周期性外呼**，属需要知情的运行特征。

### 5. 清理与生产零改动（已独立复核，非自述）

- 影子侧：容器 `metapi-4xx-canary` 已删（`docker ps -a --filter name=metapi-4xx-canary -q` 计数 **0**）、影子目录 `/var/lib/metapi/shadow-4xx-canary` 不存在（`ls -d` 报 No such file）、临时快照已删、mock 已停（`4101` / `18791` **均无 LISTEN**，`4000` **仍在听**；`ss -ltn` 共 24 个 LISTEN）。
- 生产侧（只读核对，**与实验前一致**）：
  - 容器 `metapi`：`image=metapi:1.4.12 restarts=0 started=2026-10-01T03:21:35.064Z status=running`（`StartedAt` 未变 ⇒ 未被重启/替换过）。
  - 生产库端点 `id=67`：`enabled=1`、`url=https://api.cline.bot/api`（**未被改成 mock**）、`cooldown_until` 与 `last_failed_at` **均为 NULL**；site 49 仍只有 **1** 个端点。
  - `sites`：总 **20** 行、**active 19**（未被 canary 的 disable 操作影响）；`route_channels.id=1811`：`fail_count=0`、`consecutive_fail_count=0`、`cooldown_level=0`、`cooldown_until=NULL`（未被实验污染）。
  - 生产配置面未动：`SITE_API_ENDPOINT_COOLDOWN_SEC=120` 只存在于 canary 容器 env；生产仍无该键（沿用旧笔记「静默默认 60s」的用户决定）。
  - **防误读（实验窗内的无关失败）**：实验窗口（04:32–04:41Z）内生产自身另有一条**与 canary 无关**的失败——`route_channels.id=1969`（route **1485** `step-3.7-flash`、account 37 → site 52）`last_fail_at=2026-10-01T04:36:47.762Z`、`cooldown_until=…T04:37:02.762Z`（+15s = `FAILURE_BACKOFF_BASE_SEC` × `fib(2)`）。它与 canary 的 route 1377 / account 38 / site 49 **既不同路由也不同账号/站点**，是生产自身流量，**不得读成实验污染**（canary 只写副本库）。

### 6. 跟进项候选（**尚未立项**，待用户决策）

- **「单通道路由 + 重试耗尽仍产出同一 503」**：1.4.12 未覆盖（旧笔记已改判为同症状、不同触发）。本实验再次复现该形态的**客户端可见结果**（第 4.1 条），且证明其与端点冷却**不是同一层**。候选动作：单通道路由下是否应给出可区分的错误语义/告警。
- **「通道级 Fibonacci 退避的上限与可观测性」**：`fail_count=7 → 195s` 会把唯一通道锁死（且上限 30 天，默认配置下；可经 `TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC` 调低，见第 4.2 条）；是否需要对通道级长冷却设**更短的封顶**或暴露为设置项。
- **「通道恢复探测的外呼行为」**：30s 周期主动打上游（第 4.3 条）——是否需要节流/开关/在统计面可见。
- 以上三条均**未立项**，属「需要用户拍板是否立项」的候选，本记录只做登记。

## 被放弃的方案

- **不在生产注入受控故障流量来构造样本**：沿用旧笔记的立场——生产注入失败有真实代价且会污染真实数据（代理日志/调试库），而隔离副本能以同等保真度覆盖端点级语义，故生产侧保持零改动。
- **不用「预置一个未来冷却」构造 S2**：冷却中的端点会在选择期被 `isEndpointCoolingDown` 过滤（`siteApiEndpointService.ts:234-236`、用点 `:335`），预置生效中冷却会让请求根本到不了 `recordSiteApiEndpointFailure`，等于**构造不出目标事件**；改用「并发在途」（慢请求在途时让快请求先失败写下窗口）这一**等价但可达**的手法。
- **不动既有笔记（不加 frontmatter `superseded`/`superseded_by`，也不在正文/来源节加交叉引用或勘误）**：`README.md` 只在「旧笔记被新方案取代时」授权 frontmatter supersede 链接，并**禁止改写旧笔记内容**；本次是**部分推进**而非整篇取代，挂上整篇 supersede 会把仍然有效的旧笔记 §1/§2/§5/§6 一并标死；且旧笔记的行号引用经复核准确（含 `:1545-1556`）。规范未授权「部分取代/补充笔记链」的写法，故按最小动作不动，**不自行发明格式**。
- **不把 canary 的 `SITE_API_ENDPOINT_COOLDOWN_SEC=120` 带进生产**：沿用旧笔记的用户决定（保持静默默认 60s，不写生产 settings，避免「配置与默认值双份真相」）。

## 来源

- 实验环境（canary）：影子容器 `metapi-4xx-canary`（`--network host`、`PORT=4101`、`DATA_DIR=/var/lib/metapi/shadow-4xx-canary/data`、镜像 `metapi:1.4.12`）；库 = `sqlite3 "file:/var/lib/metapi/data/hub.db?mode=ro" ".backup …"` 快照 + `PRAGMA quick_check=ok`；mock = python3 `127.0.0.1:18791`（可切 429/500、按时间窗延迟）；旋钮 `SITE_API_ENDPOINT_COOLDOWN_SEC=120`、`DISABLE_CROSS_PROTOCOL_FALLBACK=true`；出网隔离 = 副本库内 site 49 与端点 67 的 `url` 指向 mock、其余 18 个 active 站点置 disabled。**实验时刻为 2026-10-01 04:32–04:41Z**（本地 12:32–12:41）。
- canary 运行期实测（副本库 / mock 计数，属运行快照）：`site_api_endpoints.id=67` 的 `last_failed_at` / `cooldown_until` 三次取样（S1 两次 429 后均 NULL；对照 C 500 后 `…T04:35:12.751Z`；S2 后 `last_failed_at=…T04:38:42.872Z` 而 `cooldown_until` 仍 `…T04:40:39.516Z`）；`proxy_logs` **83620 / 83621**（429）、**83625**（「当前站点的 API 请求地址均不可用」）；`proxy_debug_traces` **10939 / 10940**；attempt 的 `target_url=http://127.0.0.1:18791/v1/responses`；mock 计数（`POST /v1/responses` n=3 / n=5、对照 C 第二次 500 时 12→12 不变、`GET /v1/models` 周期出现）。**影子目录与临时快照已按收尾要求删除**，故上述数值为实验当时快照，事后不可重查；可重查的是下面的生产只读核对。
- 生产只读核对（本记录撰写时重做，`sqlite3 "file:/var/lib/metapi/data/hub.db?mode=ro"` + 只读 docker 查询）：`docker inspect metapi --format 'image/restarts/started/status'` = `metapi:1.4.12 / 0 / 2026-10-01T03:21:35.064Z / running`；`docker ps -a --filter name=metapi-4xx-canary -q | wc -l` = 0；`ls -d /var/lib/metapi/shadow-4xx-canary` = 不存在；`ss -ltn` 共 24 个 LISTEN（`4000` 在听、`4101` / `18791` 均无）；`site_api_endpoints` id=67 = `49 | enabled=1 | https://api.cline.bot/api | cooldown_until NULL | last_failed_at NULL`；site 49 端点数 = 1；`sites` = 20 行 / active 19；`route_channels` id=1811 = `1377 | account 38 | fail_count 0 | consecutive_fail_count 0 | cooldown_level 0 | cooldown_until NULL`；`token_routes` id=1377 = `routing_strategy=stable_first`（非 `round_robin`）；`route_channels` id=1969 = `route 1485 | account 37 | site 52 | last_fail_at 2026-10-01T04:36:47.762Z | cooldown_until …T04:37:02.762Z`（+15s，与 canary 无关，见第 5 节防误读）。
- 代码侧（行号均经复核）：`src/server/services/siteApiEndpointService.ts:14`（`RETRYABLE_STATUS_CODES` 含 429）、`:15`（非重试集合）、`:230-240`（`isCooldownActive` / `isEndpointCoolingDown` / `isClientErrorStatus` 400–499）、`:281`（可重试分支 `triggersEndpointCooldown: !isClientErrorStatus(status)`）、`:300`（文案匹配分支显式兜底：任何 4xx 一律不写端点冷却）、`:335`（选择期过滤冷却端点）、`:374`（`recordSiteApiEndpointFailure`）、`:390-393`（`cooldownUntil` 计算：已有生效窗口则沿用）、`:395-400`（`last_failed_at` / `last_failure_reason` 无条件刷新）；`src/server/proxy-core/surfaces/chatSurface.ts:424-437`（chat 侧 503 分支，不写自己的 `proxy_logs`）、`:439`（`excludeChannelIds.push`）、`:1545-1556`（count_tokens 侧同款分支，`:1557` 为 `if` 块闭合大括号）；`src/server/proxy-core/channelSelection.ts:71-77`（`No available channels for this model`，`:74`）、`:103-116` / `:110`（空选择触发的请求内 `refreshModelsAndRebuildRoutes`）；`src/server/services/tokenRouter.ts:94`、`:97`、`:311-321`、`:327-330`、`:332-336`、`:338-341`、`:343-345`（Fibonacci 退避与两道上限 clamp）、`:2799` / `:2810-2815`（round_robin 阶梯 vs Fibonacci 分支的判定）；`src/server/config.ts:18`（ceiling 常量）、`:131-133`（读 `TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC`）；`src/server/services/channelRecoveryProbeService.ts:21-22`（30s 周期 / 12s 超时）、`:24` / `:25`（并发 1 / 单批 4）、`:26-27`（复检窗 30s / 5min）、`src/server/services/runtimeModelProbe.ts:98`（`probeRuntimeModel`）。
- 单元用例（4xx 边界与「窗内保窗」由单测覆盖，本记录只做端点级单向实测）：`src/server/services/siteApiEndpointService.test.ts:283`（429 不写冷却但写 `last_failed_at`）、`:321`（表外 4xx，用例取 402，落文案匹配分支也显式兜底不写）、`:361`（502 = 可重试触发型，在冷却窗内保窗）、`:424`（401 = 非重试，既不轮转也不清已有冷却）；通道级/成员级「窗内保窗」：`src/server/services/tokenRouter.cache.test.ts:314`（非 round_robin/Fibonacci 路径）、`:368`（round_robin 未跨阈值）、`:425`（round_robin 跨阈值只升等级）；`src/server/services/tokenRouter.oauth-route-units.test.ts:540`、`:606`、`:674`。
- 正面佐证（生产只读，本次撰写时重做）：路由 **1377** `routing_strategy=stable_first`（**非** `round_robin`）⇒ 该路由确实走 `resolveEffectiveFailureCooldownMs`（Fibonacci）分支（`tokenRouter.ts:2799` vs `:2810-2815`），故第 4.2 条的 `fail_count=7 → 195s` **唯一可解释**。
- 相关笔记：`.agents/notes/20261001-post-1412-observe-trace503-and-setting.md`（本记录**只推进**其 §3/§4 两条判定，其余各节仍以其为准；其 §1 的「正确签名 / 第二条独立观测线」用的是 `events.message LIKE '%No available channels after retries%'`——与客户端可见串 `No available channels for this model` **不是同一串**，见本记录第 4.1 条；其 §4 的**通道级/成员级**「窗口保持」仍只由单测覆盖，本记录 S2 只覆盖**端点级**，见第 3 节覆盖关系；其 §1 的 503 观测口径与 §6 的覆盖盲区在本记录的对照 C 中得到再次印证）；`.agents/notes/20260930-fetch-failed-fingerprints.md`（端点/通道冷却策略切片与遗留 K 的机制说明）。
