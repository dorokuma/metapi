---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "server, services, routes" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 失败驱动的冷却总开关（`disable_failure_driven_cooldown`）

## 一句话结论

新增 settings 键 `disable_failure_driven_cooldown`（默认 **false** = 冷却照旧）；开启后
**端点级与通道级的「失败驱动」冷却窗口一律不再写入**（`last_failed_at` / `last_failure_reason` /
`fail_count` 等观测字段照旧落库），但**上游指令驱动的冷却保留**（配额/限流 reset hint 与
provider-directed 窗口）。由于端点轮换原本**借冷却**实现「同一请求内不重选失败端点」，
关掉冷却必须同时把「本请求已尝试端点」提升为选择层的排除集，否则开启后同一请求会重打同一端点。

**第三层（2026-10-01 于同分支追加，worker）**：开关同时覆盖**运行时熔断**
（`SITE_RUNTIME_BREAKER_LEVELS_MS` = `[0, 60s, 5min, 30min]`，连续 3 次瞬时失败触发）——
开启后该熔断**不再排除候选**。因为它的候选排除正是「多候选全熔断 ⇒ 候选清空」这条**硬挡**
路径的唯一入口（见背景第三条与决策 6）；熔断状态本身（`breakerLevel` / `breakerUntilMs`）
照旧写入与清零，只是不再挡人。

**第四层（2026-10-01 于同分支追加，worker；修 M1 致命项）**：前三层只关**写入点**，
**已经落库的失败驱动窗口仍会在读侧硬挡**（通道级上限 24h，实测可挡到窗口过期）——
与「开关打开就不再被挡」直接矛盾。故同层**必须同时改读侧**：开关开启时读侧忽略
「**失败驱动形状**」的窗口（渠道级 / route-unit 成员级 `cooldownUntil`、端点级 `cooldownUntil`），
**上游指令型（配额/限流 reset hint）窗口照旧挡人**；窗口值不删不改，仍留库里做观测（可回退）。
详见决策 7。

## 背景

- 用户诉求原话：「我不想要冷却，无限打对我没什么坏处，我自己发现循环就停了，比硬等 60s 强太多」
  ——使用者要的是「失败可见 + 自己观察循环」，不要「被窗口硬挡」。
- 现状（改动前）存在三条**失败驱动**的冷却/熔断链（第 3 条由 2026-10-01 的第三层纳入开关）：
  - 端点级：`recordSiteApiEndpointFailure` 对 5xx/网络失败写 `site_api_endpoints.cooldown_until`
    （`site_api_endpoint_cooldown_sec`，默认 60s）。
  - 通道级：`TokenRouter.recordFailure` 的 weighted fibonacci 退避
    （`resolveEffectiveFailureCooldownMs`，上限 `token_router_failure_cooldown_max_sec`）与
    round_robin 冷却阶梯（`ROUND_ROBIN_COOLDOWN_LEVELS_SEC = [0, 10min, 1h, 24h]`，写死在代码里）；
    route unit 成员级同一套逻辑。
  - 运行时熔断（**第三层**，`tokenRouter.ts`，file:line 以改动后工作区为准）：
    写入 = `applyRuntimeHealthFailure`（`:766-791`，升级点 `:781`）在连续 3 次瞬时失败
    （阈值 `SITE_RUNTIME_BREAKER_STREAK_THRESHOLD` `:113`，阶梯 `SITE_RUNTIME_BREAKER_LEVELS_MS` `:114`）后写 `breakerUntilMs`；
    调用方 `recordSiteRuntimeFailure`（`:944-962`），来自 `TokenRouter.recordFailure`（成员级 `:2826` / 通道级 `:2891`），
    同时作用于站点全局态、站点模型态、令牌态。
    读取/过滤 = `filterSiteRuntimeBrokenCandidatesByModel`（`:1073` 起）：`blocked = tokenBreakerOpen || details.modelBreakerOpen`（`:1110`），
    被挡的候选从候选集移除，**全被挡时返回空集**（`:1125-1128`）⇒ 调度层选不出通道（`本次未选出通道`）⇒ 实际硬挡。
    7 个过滤调用点（含函数定义共 8 处匹配）：`:2138`（round_robin 解释）、`:2209`（stable_first 解释）、`:2392`（weighted 解释）、
    `:2938`/`:2958`/`:3013`（选路）、`:3073`（preferred）。
    注意：**站点全局熔断不进该判定**，它只把权重压到 `SITE_RUNTIME_MIN_MULTIPLIER`（`getRuntimeHealthMultiplier` `:722-738`，下限常量 `:108`），
    是软性降权而非硬挡；模型级熔断在现行代码里只对「模型作用域失败」升级
    （`recordSiteRuntimeFailure` `:951`），而 `isTransientSiteRuntimeFailure` 又把模型作用域失败排除在瞬时失败之外
    （`:554-570`），所以真实触发硬挡的通常是**令牌级**熔断（同一阶梯同一阈值）。
  - **读侧硬挡（第四层修的 M1）**：前三层只堵写入点，**已落库的失败驱动窗口仍在读侧挡人**，
    与「打开开关即不被挡」矛盾（决策 7 记录了判据与依据）。
- 另一条链是**上游指令驱动**的：`resolveShortWindowLimitCooldown`（429 配额/限流文案 +
  `parseCodexQuotaResetHint` 的 `reset_at` hint，兜底 `SHORT_WINDOW_LIMIT_COOLDOWN_MS`）。
  它的落库特征是 `failCount=0 / consecutiveFailCount=0 / cooldownLevel=0`，也正是
  `channelRecoveryProbeService.isProviderDirectedCooldown` 认的 provider-directed 形状
  （即「上游告诉我们别打」，不是「我们自己数失败数」）。

## 决策

1. **只关「失败驱动」，不碰「上游指令驱动」**：开关判定只加在两处失败驱动写入点
   （`siteApiEndpointService.recordSiteApiEndpointFailure` 的窗口赋值、
   `tokenRouter.recordFailure` 的成员级/通道级加权与阶梯分支）。`shortWindowLimitCooldownUntil`
   分支（配额/限流/provider-directed）逐字节不动——上游明确说「别打」，那是可用性事实，
   不是管理员的耐心问题。
   > 第三层修订（2026-10-01，同分支 worker 追加）：判定点现在是**四处**——上面两处写入点，
   > 运行时熔断的候选**过滤点**（见决策 6），以及第四层新增的**读侧放行点**（见决策 7）；
   > 原文只写「两处写入点」已不完整，故在此注明。
2. **失败照样留痕**：`fail_count` / `last_failed_at` / `last_failure_reason` / 代理日志全部保留，
   这正是用户「自己发现循环」的依据；开关只停「窗口」，不停「观测」。
3. **默认 false = 逐字节保持现行为**：默认路径不传新的选择层排除集（见 4），
   端点/通道写入点只是多一个恒假的条件分支。开关生效范围用「严格布尔」判定（`=== true`），
   非布尔取值（env 非法串、库内的脏值）一律回落到「冷却照旧」这一侧。
4. **关冷却必须同时改端点轮换**：`runWithSiteApiEndpointPool` 原本靠「失败端点在冷却中被
   `isEndpointCoolingDown` 过滤掉」来实现同请求内的 A→B 轮换；冷却一关，A 会立刻重新被
   `selectSiteApiEndpointTarget` 选中并被 `attemptedEndpointIds` 兜底抛错（**不轮换**）。
   因此给选择函数加了 `excludeEndpointIds` 参数，**只在总开关开启时**把「本请求已尝试端点」
   集合传进去；默认（开关关闭）不传，既有「冷却兜轮换」路径不变。
5. **round_robin 阶梯整体停摆**：开关开启时跳过阈值分支（不写窗口 / 不递增 `cooldownLevel` /
   不清零 `consecutiveFailCount`），只更新 `failCount` / `lastFailAt`——阶梯本身是冷却状态机的一部分，
   半开（推进等级但窗口置空）会在开关关回去时留下更长的窗口。
6. **第三层（2026-10-01 追加）：运行时熔断只停「硬挡」，不停「状态」**。开关开启时
   `filterSiteRuntimeBrokenCandidatesByModel` 整段放行（`tokenRouter.ts:1086-1091`，判定在最前、
   早于 `candidates.length <= 1` 与 `blocked` 计算），不再排除任何候选 ⇒ 单候选 / 全候选场景都不会被硬挡。
   选「改过滤」而不是「改写入」的理由：
   - **只堵写入点堵不住硬挡**：熔断状态会随 settings 键 `token_router_site_runtime_health_v1`（`:127`）持久化
     （`shouldPersistSiteRuntimeHealthState` `:809` 把 breaker open 列为持久化条件 `:820`），
     且令牌级熔断是内存态；只要过滤点还认 open，开关打开那一刻仍会拿旧窗口硬挡最长 30 分钟，
     不满足「保证不会被硬挡」。
   - **语义一致**：开关既有口径是「失败不再产生硬挡」（决策 2、5），观测与计分全部保留；
     熔断状态照旧推进 / 清零，开关关回去时状态是诚实的（没抹掉历史失败）。
   - **保留 provider-directed 语义**：`resolveSiteRuntimeFailurePenalty`（`:515-537`，配额/限流的 0.4 在 `:520`）里配额/限流的 0.4 惩罚、
     以及 `SITE_TRANSIENT_FAILURE_PATTERNS`（`:172-184`）本身全部不动——它们决定**权重排序**而非硬挡，
     抹掉它们等于把「上游说别打」的证据一起抹掉，超出开关范围。
   - **残留说明（如实记录）**：开启时熔断状态仍被写入，因此熔断期站点的权重仍被 `SITE_RUNTIME_MIN_MULTIPLIER`（`:108`，0.08）
     压低——这是软性排序偏好，不是硬挡；用户诉求是「不被硬挡」，故未把降权一起关掉（关掉需另开一个开关）。

7. **第四层（2026-10-01 追加，M1 修复）：读侧也必须放行，否则前三层等于没关**。
   前三层只堵写入点：**开关关闭时已经写下的失败驱动窗口仍在读侧硬挡**，且窗口上限很长
   （通道级 round_robin 阶梯 10min / 1h / 24h，weighted 上限 `token_router_failure_cooldown_max_sec`；
   oracle 实测 min 级窗口即可把单渠道挡到过期）。矛盾点：本层决策口径是「打开开关即不再被挡」，
   而只改写入点的实现做不到（决策 F 否决过「只改过滤/只堵写入」的同类做法，第三层因此改的过滤点）。
   **开关开启时，读侧忽略「失败驱动形状」的窗口**：
   - 读侧改动点（`tokenRouter.ts`）：`isFailureCooldownWindowBlocking`（`:377-383`，新）→
     route-unit 成员级 `isOauthRouteUnitMemberCoolingDown`（`:1607-1613`，成员 eligibility 的「冷却中」`：3195`）
     与渠道级「冷却中」（`getCandidateEligibilityReasons` `:3443`，改动前是裸的 `cooldownUntil > nowIso` 比较，位于 `:3419`）；
   - 端点级（`siteApiEndpointService.ts`）：`isEndpointCoolingDown`（`:243-253`，开关开启时整段不挡，`:252`）；
   - 窗口值**不删、不改写**，写入点语义（含「冷却中不推窗」的复用逻辑）逐字节不动 ⇒ 开关关回去即恢复旧行为（可回退）；
     `failCount` / `lastFailAt` / `lastFailureReason` 等观测字段照旧落库。
   **判据与依据（必须先核实写入形状，已核实）**：
   -「失败驱动形状」= 失败计数三件套**有任意一项 > 0**；对应地，**上游指令型（provider-directed）形状** =
     `failCount` / `consecutiveFailCount` / `cooldownLevel` **全为 0**。判据收敛在
     `shared/failureDrivenCooldownSwitch.isProviderDirectedCooldownShape`，与
     `channelRecoveryProbeService.isProviderDirectedCooldown` 同源（那边再叠加「`cooldownUntil` 非空」，
     现已改为调用同一个函数，避免两份判据漂移）。
   - **写入侧不变式（`TokenRouter.recordFailure` 是通道/成员冷却窗口的唯一写入点）**：
     配额/限流分支（`shortWindowLimitCooldownUntil` 非空，来自 `resolveShortWindowLimitCooldown` `:572`：
     429 用量限制文案 + `parseCodexQuotaResetHint` reset hint，兜底 `SHORT_WINDOW_LIMIT_COOLDOWN_MS`）
     写入时 `cooldownUntil` = 上游给的窗口，并且 `failCount` / `consecutiveFailCount` / `cooldownLevel`
     **一律置 0**（`failCount = shortWindowLimitCooldownUntil ? 0 : 旧值+1`）；
     失败驱动分支（weighted fibonacci / round_robin 阶梯）则 `failCount = 旧值 + 1 ≥ 1`，
     三件套不可能全为 0 ⇒ 判据在写入时刻是确定的。
   - 端点级：**全部窗口都是失败驱动形状，无 provider-directed 写入点**（已核实）：
     `site_api_endpoints.cooldown_until` 的全库写入点只有 `siteApiEndpointService.recordSiteApiEndpointFailure`
     （失败驱动）与 `recordSiteApiEndpointSuccess`（置 null）；`classifySiteApiEndpointFailure` 对
     429/408 等 4xx 一律 `triggersEndpointCooldown=false`（站点只有一个端点时写冷却等于把唯一出口拉黑），
     故无配额/限流 reset hint 写入口；站点编辑（`PUT /api/sites/:id` 重建 `api_endpoints` 行）只会把窗口重置为空。
   - **已知残留（如实记录，见「遗留与观察项」）**：形状是**当下**计数，不是「窗口来源」的持久标记。
     若一条 provider-directed 窗口在途期间恰好又有非配额失败落库（并发在途请求），
     该行三件套会被抬到 > 0，读侧就会把残留的上游窗口也一起忽略（fail-open）。
     彻底消除需给窗口加「来源」列（schema 迁移），超出本层范围。

## 被放弃的方案（必填）

- **方案 A：把两个时长配置压到最小值（1s）近似「无冷却」，不改代码。**
  否决理由（都是可核对的现状）：
  - 口径下限就是 1s，压不到 0：`SITE_API_ENDPOINT_COOLDOWN_SEC_CEILING` 归一为 `[1, ceiling]`，
    通道侧 `resolveConfiguredFailureCooldownMaxMs` 有 `Math.max(1_000, …)` 下限 → 「无限打」仍被 1s 挡一次。
  - round_robin 冷却阶梯（10min / 1h / 24h）**写死在代码里**，不受任何 settings 影响 →
    走这条路由策略的通道，失败冷却根本压不掉，用户场景（含 route unit 池）依旧被硬挡。
  - 该值要落进生产 settings 才有用，会引入「配置与默认值双份真相」——旧笔记
    `.agents/notes/20261001-post-1412-observe-trace503-and-setting.md` 已明确记过用户「不显式写入生产 settings」的决定。
  - 语义上也不对：「把窗口调小」= 冷却还在；用户要的是「别写冷却」。
- **方案 B（开关的极性）：`failureDrivenCooldownEnabled`（默认 false = 关掉冷却）。**
  否决：默认 false 会**改变现行为**（现存行为是冷却开着），与「默认零变化」冲突；
  最终采用仓内已有的 `disable*` 负向布尔命名先例（`disable_cross_protocol_fallback`）。
- **方案 C：总是把已尝试端点集合传给选择层（不判开关）。**
  否决：4xx/429（`triggersEndpointCooldown=false`）今天**不轮换**（选回同一端点后被
  `attemptedEndpointIds` 兜底抛错）；无条件排除会把它变成「继续打下一个端点」——
  默认路径行为变化，违反「默认零变化 + 不改无关行为」。
- **方案 D：开关开启时顺手清空已有 `cooldown_until`。**
  否决：清空是**写冷却列**（把上游指令型窗口也一起解除），且会与「不写冷却」的语义混淆；
  开关只管「不再产生失败驱动窗口」，历史窗口按原值回写、自然过期。
- **方案 E（第三层）：只放行「全熔断」那一支，有健康候选时照旧避让熔断候选。**
  否决：这仍是「因失败排除候选」（混合场景下失败站点被系统性移出候选集），与「不再因失败挡候选」
  口径不一致，也与第一层（端点/通道冷却一关即完全回池）不一致；用户的诉求是「宁愿无限打」。
- **方案 F（第三层）：只堵写入点（`applyRuntimeHealthFailure` 不升级 `breakerLevel`），不动过滤。**
  否决见决策 6 第一条：已持久化 / 已在内存的熔断窗口仍会被过滤点认，开关打开后最长 30 分钟内仍被硬挡，
  单靠写入点无法满足「保证不会被硬挡」；且会让 `breakerLevel` 与 `breakerUntilMs` 变成半开状态。
- **方案 G（第三层）：把开关判定加在 7 个过滤调用点上（逐个跳过调用）。**
  否决：同一条语义要重复 7 次、漏一处就等于没关；过滤函数是唯一入口，改一处即可覆盖全部策略
  （weighted / round_robin / stable_first / preferred）。
- **方案 H（第四层）：翻开关的那一刻清库——把已有 `cooldown_until` / `failCount` 一律置 0/null。**
  否决（四条，均可核对）：
  - **竞态**：清库是**一次性写**，而翻开关那一刻仍有并发在途请求：它们会在清完之后继续
    `recordFailure` 落库（甚至把清掉的行重新写成冷却中）；想堵住就得加锁/双重检查，
    而读侧判定是无状态、天然无竞态的（「从这一刻起我不被挡」不依赖写入时序）。
  - **不可回退**：清库把历史窗口抹掉，开关关回去不能恢复「刚才还在冷却」的事实，
    与决策 2（观测不丢）和「可回退」相宜；读侧放行则开关一关即原样恢复。
  - **越权解除上游指令**：清 `cooldown_until` 无法区分窗口来源，会把 provider-directed
    （配额/限流 reset hint）窗口一并解除，超出开关范围（决策 1、决策 7 判据）。
  - **多进程/重启不提**：本服务单实例（host 网络单容器），但清库与「开关值本身也要落库
    并在水合后生效」是两件事，清库还要额外处理「水合前就已有旧窗口」的时序。
- **方案 I（第四层）：给窗口加「来源」列（如 `cooldown_source`）区分失败驱动 / 上游指令，
  读侧只看新列。**
  否决：改了表结构就要 schema 迁移 + 契约产物（仓规：`db:generate` / `schema:contract`），
  代价远超本层范围，且只为消除一个罕见的并发残留（见「遗留与观察项」第 6 条）；
  先记为遗留，若该残留实际被观测到再升级为独立改动。

## 遗留与观察项

逐条登记，不静默丢弃（前三项来自 reviewer / oracle 复核，后三项为本层自查）：

1. **reviewer 的 consider（运维观测）**：上线后用运维面板盯 `failCount` 增长过快的渠道。开关口径是
   「失败可见 + 自己观察循环」，故 `fail_count` / `lastFailAt` / 代理日志就是唯一手段；
   若某渠道 `failCount` 高速增长但用户未察觉，需人工介入（不自动重新打冷却）。
2. **oracle O1（端点排序固定；2026-10-02 worker 措辞订正）**：开关开启后端点排序不再被冷却变化推动。
   `selectSiteApiEndpointTarget` 的排序键是 `sortOrder` → `lastSelectedAt`（升序）→ `id`
   （`siteApiEndpointService.ts:356-366`；候选查询本身也先按 `sortOrder, id`，`:342`，最终取 `eligible[0]`，`:368`）⇒
   **`sortOrder` 相同时本会按 `lastSelectedAt` 轮转（最久未选中的先打）；只有当 `sortOrder` 互不相同时，
   才会恒定先打 `sortOrder` 最小的那个坏端点**。
   （同请求内靠 `attemptedEndpointIds` 才换到下一个。）属用户明选的代价（「宁愿无限打」），本层不改。
3. **oracle O2（顺带修好的行为）**：本层使 429 也能跨端点轮换（`rotateToNextEndpoint` + 排除集），
   这是开关开启侧的附带改善，默认路径（开关 false）不受影响。
4. **oracle S1（三条软层未覆盖，按用户口径保留）**：① `filterRecentlyFailedCandidates` 软避让；
   ② route-unit failover 分支；③ 上游端点种类 6h 记忆。三者**均不硬挡**（只影响候选排序 / 选择偏好），
   按用户口径（「不被硬挡」）不动。
5. **站点权重 0.08 下限仍在**：`SITE_RUNTIME_MIN_MULTIPLIER`（`tokenRouter.ts:108`）仍会把熔断期站点
   权重压到 0.08——软性排序偏好，不是硬挡（同决策 6 残留说明）。
6. **本层新增观察项（判据残留，如实记录）**：读侧判据用的是「当下」计数而非
   「窗口来源」持久标记。若一条 provider-directed（配额/限流）窗口在途期间恰有非配额失败落库
   （并发在途请求 / 同一请求的后续失败），该行三件套会被抬到 > 0，读侧就会把残留的上游窗口也一并忽略
   （fail-open：上游说别打，但仍可能被选中）。触发概率取决于并发窗口的时序。
   - **已实测可构造（2026-10-02 worker 副本手工用例实测，非持久用例）**：`recordFailure` 在 `channelCoolingDown` 为真时
     把 `cooldownUntil` 原样复用旧窗口（通道级 `:2838` + 复用点 `:2842`（初值）/ `:2855-2859`（round_robin）/
     `:2863-2867`（weighted）；成员级同形：`:2784` / `:2786` / `:2807-2811`），
     同时把 `failCount` 抬到 ≥1（`:2834`，成员级 `:2778`：`shortWindowLimitCooldownUntil ? 0 : 旧值+1`）⇒
     「上游配额窗口 + 失败计数 > 0」的混合行可由「配额窗口在途 → 同渠道再来一次非配额失败」直接构造。
     实测序列（副本内临时用例，跑完即删）：①（开关关）429 配额失败 ⇒ 窗口在、三件套全 0，`selectChannel` 选不出；
     ②（开关关）窗口在途再来一次 502 ⇒ `cooldownUntil` 与原窗口**逐字相同**、`failCount=1`；
     ③ 翻开关 ⇒ `selectChannel` **选中该渠道**（fail-open 成立）；
     ④ 同渠道再来一次 429 ⇒ 三件套归零 ⇒ `selectChannel` 重新选不出（自愈路径成立）。
   - **自愈路径**：下一次同渠道配额/限流 429 走 `shortWindowLimitCooldownUntil` 分支时会重置三件套
     （`failCount = 0` `:2834`、`consecutiveFailCount = 0` / `cooldownLevel = 0` `:2847-2849`；
     成员级 `:2778` / `:2791-2793`）⇒ 该行回到「三件套全 0」的 provider-directed 形状，读侧**立即恢复挡人**。
     即 fail-open 只存在于「混合窗口的在途期」（窗口过期或下一次配额失败即结束）。
   - **结论仍为可接受、不加窗口来源列的理由**：① 触发需「上游配额窗口在途 + 同渠道非配额失败」同时发生，
     概率低且自愈；② 代价只是「多打一次上游已要求等待的渠道」，而本开关的整体口径就是「宁可多打、不被硬挡」
     （见背景用户原话），fail-open 与口径同侧，不会出现「比开关关闭时更差」的结果；
     ③ 彻底消除需给 `route_channels` / `oauth_route_unit_members` 加来源列 ⇒ schema 迁移 + 契约产物
     （`db:generate` / `schema:contract`），代价远超本层范围（方案 I）。

7. **全量偶发红（未定位；2026-10-02 00:06–00:30 worker 复跑后登记）**：`npm test` 全量偶发红 **1/14**
   （oracle 上轮实测），恰为本层两条 M1 守卫用例：`tokenRouter.selection.test.ts:907`
   （`expected '冷却中' not to contain '冷却中'`）与 `tokenRouter.oauth-route-units.test.ts:892`
   （`Received: undefined`，即 `selectChannel` 返回 null）；失败前后树内容一致（diff hash 相同），
   之后 13 次全量（workspace 5 + 副本 9，含 2 次并发、4 次带插桩）全绿。
   **本轮复跑**：干净全量 **12/12 绿**（每轮 508 文件 / 3352 用例 / 54–73s；见下「复跑记录」），
   另加定向 `--sequence.shuffle` 12 轮（两文件 50 用例，每次独立 seed）全绿；
   所有日志（含 4 份并发全量）中 **0 次**出现 `冷却中` 断言红或 `Received: undefined` ⇒ **未复现**。
   **已排除的假说与理由（均带证据）**：
   - **H-A「跨文件共享 DB」：证伪（对这两条用例）**。① 两文件各自 `beforeAll` 里先 `mkdtempSync`
     私有 DATA_DIR（`tokenRouter.selection.test.ts:51`、`tokenRouter.oauth-route-units.test.ts:22`），
     且两文件顶层只 import vitest / node 内建 / drizzle-orm，没有「先加载 config 再设 DATA_DIR」的窗口；
     插桩副本全量实测：`selection` → `/tmp/metapi-token-router-selection-*/hub.db`、
     `oauth-route-units` → `/tmp/metapi-token-router-oauth-route-units-*/hub.db`（私有、pid 各异）。
     ② 能力实验（副本内把两文件 DATA_DIR 强改为同一目录后并发跑）：两文件 `beforeEach` 互相清表 ⇒
     一次红 **21 条**，签名全是「行不见了」（`expected undefined to be 5` / `to be '<时间戳>'` 等），
     与本次的「单条断言红」完全不同 ⇒ 即便共享也不是这个红的样子。
   - **H-B「模块实例 / worker 可见性」：证伪**。探针实测（副本，vitest 2.1.9）：默认配置
     （`pool: forks` + `isolate: true`，`vitest.config.ts` 未改这两项）**每个测试文件一个独立进程**
     （两探针 pid 不同、`VITEST_POOL_ID` 不同；`--fileParallelism=false` 下仍是不同 pid）；
     只有显式 `--poolOptions.forks.isolate=false` 时两文件才同进程，且此时探针观察到
     `config.disableFailureDrivenCooldown` 跨文件可见（`sawSwitch=true`）。
     即：别的文件无法污染本文件的 `config` 与模块级缓存（`routeCacheSnapshot` / `routeMatchCache`）。
     同文件内的顺序依赖也被 12 轮 `--sequence.shuffle` 全绿排除。
   - **H-C「断言时序（缺等待 / 缺失效）」：不成立（代码级）**。两条断言只依赖「活读 `config`」+
     「await 后的 DB 读」：`invalidateTokenRouterCache()`（`tokenRouter.ts:1310-1317`）是**同步**函数，
     清空 `routeCacheSnapshot` / `routeMatchCache` / `stableFirst*`；读侧判定
     `isFailureCooldownWindowBlocking`（`:377-383`）每次现读 `config`，无快照、无 TTL；
     `recordFailure` 的落库写入全部 `await`（成员级 `:2816-2823` / 通道级 `:2872-2878`，
     两者之后紧跟 `patchCachedChannel` / `invalidateRouteScopedCache`，无未等待的后续写），
     不存在「翻开关后才回写窗口」的未等待异步写；窗口过期只会让断言更松（不挡人），不会产生该红。
   **余下最可能解释（未证实，留待复现时取证）**：① 红那一轮可能处于手工变异 / 插桩树状态
   （笔记末「第四层变异验证」记录过：把读侧判定短接后，这三条 `releases an already written …`
   用例**必然**失败；「失败前后 diff hash 相同」无法排除「运行期间短暂施加变异、随后还原」）；
   ② 未知环境级偶发。
   **复跑记录（2026-10-02 00:06–00:28）**：干净全量 12/12 绿（round 1–8、11、13–15：508 文件 / 3352 用例 / 54–73s，
   串行无额外负载）；
   **另实测到两类「负载级红」，与上述断言红签名不同，不属本次改动**：
   (a) 4 份全量并发（48 worker / 12 vCPU）时每份红 7–12 条，签名统一为 `Test timed out in 5000ms` /
   `Hook timed out in 10000ms`（两个目标文件也在其中，表现为 beforeAll 超时 ⇒ 整 suite 跳过 +
   afterAll 里 `config` undefined 抛错），串行单份跑 0 红；
   (b) 一次与 `tokenRouterDumpRetentionService.test.ts:431`（flock 持锁者被 SIGKILL 后的恢复）相关的
   单条红（`expected 0 to be greater than or equal to 1`），亦出现在带额外负载的轮次。
   ⇒ 若要消 (a) 这类红，方向是给重用例文件显式加 `hookTimeout` / `testTimeout`，**不在本次开关改动范围**。
   - **处置（当次用户豁免，随本次提交放行）**：本轮已核事实——干净全量 **12/12 绿**
     （每轮 508 文件 / 3352 用例 / 54–73s），全部日志中目标签名
     （`not.toContain('冷却中')` 与 `selectChannel` 返回 null 的 `Received: undefined`）**0 次** ⇒ 未复现。
     三条假说已实验证伪（证据见上）：**跨文件共享 DB**（两文件各自 `mkdtempSync` 私有 DATA_DIR，
     `tokenRouter.selection.test.ts:51`、`tokenRouter.oauth-route-units.test.ts:22`，插桩副本实测路径互异）、
     **worker 可见性**（默认 `pool: forks` + `isolate: true` 下每文件独立进程，仅显式 `isolate=false` 才同进程）、
     **断言时序**（`invalidateTokenRouterCache()` 同步、读侧现读 `config`、落库写入全部 `await`，无未等待的后继写）。
     最可能解释：观测到红的那一轮正处在**变异 / 插桩实验的树状态**——把读侧判定短接后这三条
     `releases an already written …` 用例**必然**失败（见「第四层变异验证」），
     「失败前后 diff hash 相同」无法排除「运行期间短暂施加变异、随后还原」；次之是未知环境级偶发。
     **用户当次明确豁免**（原话「接受并放行，已登记遗留」，主代理记录的处置日为 2026-10-01），
     同意以本条为遗留、不阻塞本次提交继续提交。豁免只覆盖本轮**未复现**的这条偶发红，
     **不改动任何代码或测试**；若后续再现，按上面 (a) 方向处理（hookTimeout / testTimeout），仍不在本开关范围内。

8. **顺带发现（既有问题，非本次改动引入，仅登记待裁决）**：`db/index.ts` 的 sqlite 路径解析把
   **活的 `process.env.DATA_DIR`**（`resolveVitestSqlitePath` 的守卫，`:128`）与
   **`config` 模块加载时捕获的 `config.dataDir`**（`:90`）混用 ⇒ 若某测试文件先静态 import 了会拉进
   `config.js` 的应用模块、再在 `beforeAll` 里设 `DATA_DIR`，则守卫放行「私有目录」分支、
   实际路径却回落到 `<repo>/data/hub.db`（仓库 dev 库）。插桩副本全量实测：本次全量共 **50 个文件**
   `configDataDir=./data`，其中 **5 个**因此解析到仓库 dev 库并与其它文件并发共享：
   `siteApiEndpointService.test.ts`（**本分支改过**，新增 M1 守卫就在其中）、
   `chat.singleChannelFailure.test.ts`、`chat.siteApiEndpoint.test.ts`、`search.route.test.ts`、
   `sites.subscription-summary.test.ts`——这也正是「`npm test` 会写仓库 `data/hub.db`」的来源。
   与本次两条红无关（那两个文件用的是各自私有库，已实测），但属真实的测试隔离缺陷；
   修法在 `db/index.ts`（生产文件）而非测试小改，超出本次任务范围，故**只登记、未改**。
   另：未设 DATA_DIR 的文件按设计共享 `tmpdir()/metapi-vitest-<poolId>/hub.db`（`:133-135`）。

9. **观察项（既有行为，非本次范围）**：**provider（配额/限流）冷却窗口会被一次成功的恢复探活直接清空**。
   探活 sweep 在 `status === 'supported'` 时调用 `tokenRouter.recordProbeSuccess`
   （`channelRecoveryProbeService.ts:208-227`），该函数把 `cooldownUntil` 置 `null`
   （成员级 `tokenRouter.ts:2644-2650`；通道级 `:2656-2661`，无 oauth 池时 `:2678-2683`），且**不看窗口来源** ⇒ 上游明确要求的等待
   可能被一次成功探活提前解除（`failCount` 不在此函数的重置列表里）。这与第 6 条的「无来源列」同根：
   窗口一旦落库就丢失了来源信息。非本次开关范围，登记待后续（若做来源列可一并覆盖）。

## 来源

- 改动点（file:line 以本分支 `feature/failure-cooldown-switch` 为准）：
  - `src/server/shared/failureDrivenCooldownSwitch.ts`（新增：默认值 + 归一化口径；
    **第四层**：`isProviderDirectedCooldownShape` / `shouldIgnoreFailureDrivenCooldownWindow` 读侧判据）
  - `src/server/config.ts`（`DISABLE_FAILURE_DRIVEN_COOLDOWN` env，默认 false）
  - `src/server/routes/api/settings.ts`（`applySetting` case / 运行时回显 / PUT 校验与落库）
  - `src/server/runtimeSettingsHydration.ts`（库值水合，非布尔保留现值）
  - `src/server/services/siteApiEndpointService.ts`（端点写入点 + `selectSiteApiEndpointTarget(excludeEndpointIds)` + 轮换传参；
    **第四层**：`isEndpointCoolingDown` `:243-253` 读侧放行）
  - `src/server/services/tokenRouter.ts`（成员级/通道级 weighted + round_robin 阶梯；
    **第三层**：`filterSiteRuntimeBrokenCandidatesByModel` `:1086-1091` 开关放行；
    **第四层**：`isFailureCooldownWindowBlocking` `:377-383` + 成员级 `:1607-1613` / 渠道级 `:3443`）
  - `src/server/services/channelRecoveryProbeService.ts`（provider-directed 判据收敛到共享函数，行为不变）
- 相关旧笔记：`.agents/notes/20260930-fetch-failed-fingerprints.md`（端点冷却来源与「唯一端点被拉黑」事故）、
  `.agents/notes/20261001-canary-controlled-4xx-endpoint-cooldown-verified.md`（429 不写端点冷却的实测）、
  `.agents/notes/20261001-post-1412-observe-trace503-and-setting.md`（`site_api_endpoint_cooldown_sec` 保持静默默认的决定）。
- 回归测试：`siteApiEndpointService.test.ts`（端点不写窗口 / 开关开启时同请求 A→B /
  **第四层**：已写下的端点窗口在翻开关后立即放行）、
  `tokenRouter.selection.test.ts`（默认写窗口 + 单渠道事后仍可选 / round_robin 阶梯停摆 /
  **第三层**：`keeps runtime-breaker candidates selectable when the failure cooldown switch is on`，
  同一用例内做「默认 false ⇒ 多候选全熔断清空候选（硬挡）」↔「开关 true ⇒ 同一份熔断状态仍能选出通道」前后对照，
  并在开关开启时再失败 3 次验证仍可选；反向验证：把该过滤的开关判定短接为恒假，此用例即失败 /
  **第四层**：`releases an already written failure-driven channel cooldown as soon as the failure cooldown switch is turned on`
  与 `still blocks a provider-directed (quota) channel cooldown when the failure cooldown switch is on`）、
  `tokenRouter.oauth-route-units.test.ts`（成员级两分支 + **第四层**：已写下的成员窗口翻开关后放行 /
  provider-directed 形状的成员窗口仍挡人）、`settings.events.test.ts` +
  `runtimeSettingsHydration.test.ts`（开关接线与水合；非布尔值用例已改为「现值 false + 喂 `'true'` ⇒ 仍 false」，
  排除「保留现值」与「静默强转」混淆）。

### 第四层变异验证（手工，非持久用例）

把读侧新判定短接（`isFailureCooldownWindowBlocking` → `return true;`，
`isEndpointCoolingDown` → `return true;`）后重跑：上述
`releases an already written …` 三条用例全数失败（渠道 / 成员 / 端点）；
还原后 `diff -q` 与备份 byte-identical，用例全绿。

### fail-open 可构造性验证（手工，非持久用例，2026-10-02）

副本内临时用例（`/tmp` 副本，跑完即删，不入仓）按「①配额 429 写上游窗口 → ②窗口在途再来一次 502 →
③翻开关 → ④再来一次配额 429」四步实测：②后行状态为「原窗口 + `failCount=1`」的混合行；
③读侧放行且选中该渠道（fail-open 成立）；④三件套归零后读侧恢复挡人（自愈成立）。
即第 6 条描述的残留是**可构造的事实**，不是纯粹的理论担忧——但仍然自愈且与开关口径同侧，故仍按方案 I 保留。
