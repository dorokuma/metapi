---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: services # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 上游钉选注入升级为通用多家族适配器体系（Phase 1：框架 + generic-dual / openrouter / vercel-ai-gateway / none）

> 前序笔记：[20260926-upstream-provider-pin-injection.md](20260926-upstream-provider-pin-injection.md)（本笔记是其升级，不取代其决策）。
> 设计稿：/tmp/pin-generic-plan-v3.1-20260926.md（全文）；权威增量：/tmp/pin-generic-plan-v3.2-delta-20260926.md；
> oracle 二审：/tmp/pin-generic-oracle-v31-report-20260926.md；双审放行：/tmp/upstream-pin-generic-review-results-20260926.md。

## 一句话结论

把「固定双姿势注入」升级为「按站点选择注入适配器」：**规则语义层零改动**（四字段规则 + resolve 不变），
注入姿势由「站点级适配器」决定——OpenRouter 直映射其原生 `provider.only` / `provider.order`，Vercel AI
Gateway 只写嵌套位，无机制者（Cloudflare/直连）显式 no-op；默认适配器 `generic-dual` = 既有
`inject.ts` 原函数（零 diff）；未配置映射 = 逐字节回基线；**未注册 id = 零注入（M2），绝不回落双姿势**。

## 背景

- 前置「上游钉选注入」（站点+请求模型 → providers+mode 四字段规则，双姿势写入 chat/responses 默认路径）已上线，
  默认关闭、无配置零行为变化；本阶段按 v3.1/v3.2 设计把注入姿势从「写死」升级为「适配器体系」。
- 支持面矩阵初判（/tmp/pin-support-matrix-results-20260926.md）曾把 OpenRouter 判为「严格语义需 order +
  allow_fallbacks:false 表达」，**该结论已被官方文档证伪**（见下方勘误）。
- 关键约束：默认零行为变化（三重保证）、拒绝「假通用」（未实现/未核实机制不得出现在 UI 与 PUT 白名单）。

## 决策

1. **架构分层**：规则语义层（rules.ts，零改动）→ 适配器层（新 `services/upstreamProviderPin/adapters/**` +
   共享目录 `src/shared/upstreamPinAdapters.{js,d.ts}`）→ 注入执行层（`upstreamRequestBuilder.ts` 两处调用点改调
   `upstreamProviderPin/apply.ts` 统一门禁）。适配器按**站点**选择（一个站点指向一个网关），不进规则字段，
   保住四字段形状与既有测试语义。
2. **S1（不搬移 inject）**：`generic-dual.applyBody` **就是** `injectUpstreamProviderPin` 原函数引用
   （adapters/genericDual.ts 直接别名，inject.ts 零 diff、inject.test.ts 零改动），registry 单测用
   `toBe` 钉死该引用——「搬移漂移」风险归零。
3. **M2（未解析 id → 零注入）**：合法 id 集合唯一事实源 = 注册表键集（`UPSTREAM_PIN_ADAPTER_IDS`），
   PUT 严格校验与热路径 resolve 共用；`resolveUpstreamPinAdapter` **total 不抛**。热路径解析：
   未配置站点 / 畸形 siteId → `generic-dual`；命中且已注册 → 该适配器；**命中但未注册（版本回滚残留、
   已下线适配器）→ 零注入适配器（等同 none）**。为此 `normalizeUpstreamPinAdapterMap`（宽松）**保留未注册
   字符串值**（只丢非法键与非法值），使其能存活到热路径被兜底——否则回滚后未知 id 会静默回落双姿势，
   向未知网关（如 LiteLLM 透传未知 body 参数）写入双姿势 body。
4. **M3（目录落 src/shared）**：`src/shared/upstreamPinAdapters.{js,d.ts}`（形态对齐
   siteInitializationPresets 先例）= `{id,label,mechanism,capabilities,notes}` 四家；服务端 registry 以目录为
   元数据源并挂 `applyBody/applyHeaders` 实现；Settings.tsx 与行内提示读同一目录；**web 侧零 `../server` 引用**。
5. **M1（PUT 无部分应用）**：`upstream_provider_pin_adapter_map` 严格校验并入 R-A pending 段（与 rules 并列
   pre-validate），应用区在 rules 之后统一应用；「enabled 合法 + rules 合法 + map 非法」一次提交 → 400 且
   三处 config 与落库全部不变（对称测试已补）。
6. **统一门禁**（采纳 reviewer 建议 #5）：新增 `upstreamProviderPin/apply.ts`——
   `applyUpstreamProviderPin({body, headers, siteId, requestedModel})` 完成命中判定→适配器解析→**能力协商**
   （mode 查 `capabilities`，不足即 body 与 header 都不写，**跳过而非降级**）→分发 `applyBody/applyHeaders`；
   两个调用点各一句，header 挂点预留在同一函数（Phase 1 无 header 族 = 空操作，Phase 2 接入无需再改调用点）。
7. **OpenRouter 适配器（v3.1 勘误后语义）**：只写顶层 `provider.{only|order}`；不写被其忽略的
   `providerOptions.gateway`；order 模式**不写也不动 `allow_fallbacks`**（S1 浅合并保留用户/payloadRules 值）；
   兄弟键互斥；`provider` 非普通对象跳过（S3 容错）。registry.notes 口径（O2）：**请求 only 与账号级允许列表取
   交集、交集为空返回 404**；`provider.ignore` 命中的提供方会被剔除（与 only 冲突时同样吃掉钉选）；
   provider 名为 slug、支持 Base Slug Matching（F-6 部分结案：精确格式与非法名报错留实测）。
8. **Vercel AI Gateway 适配器**：只写嵌套 `providerOptions.gateway.{only|order}`（该网关实际读取位），
   **不写顶层 `provider`**（契约外字段，避免未知字段透传；F-7 实测前不开放）。
9. **none 适配器**：显式选项 + 无 `applyBody/applyHeaders`，pin 命中也零注入；UI notes 明示
   「该网关无请求体钉选机制（路由在 URL 前缀/控制台配置），规则不会注入」。**不注册** portkey/helicone/
   litellm/new-api（Phase 1 PUT 白名单 = 已注册四家，提交即 400）——拒绝假通用。
10. **UI（S2/O1/O5）**：钉选卡内新增「网关适配器」小节（不新开卡片；站点 select + 适配器 select + 删除 +
    空表提示「未配置 = 全部站点使用默认双姿势注入」）；规则行展示解析出的适配器 label，并按 mode 查能力
    给橙色行内警告「该规则将被跳过（该请求不会受本规则约束）」（O1：诚实说明跳过 = 请求失去任何供应商约束），
    选 none 者用 O5 文案「该网关无请求体钉选机制，规则不会注入」；均不阻塞保存（服务端为最终裁决）。
    卡内静态文案补「注入仅对 chat / responses 默认路径生效（messages、gemini 原生、codex 站点与
    WebSocket、测活等路径不注入）」与 R2 补充句「选择 OpenRouter 适配器后 only / order 直对应其原生契约，
    语义即时真实生效」。适配器行对未注册 id 保留原值并提示「当前版本不支持…注入会被跳过」（不静默丢行）。
11. **回滚与急停（S1/S7 叙事修正）**：回滚杠杆 = 三层急停（总开关 / map 删行或换 none / 规则删空）+
    适配器与接线文件整段 revert；**不存在「revert inject.ts 单文件」**（inject.ts 本就零 diff）。
    整段 revert 后 **DB 残留的 map 键被旧代码完全忽略**（旧代码不认识该 settings 键）；
    保留 Phase 1 代码但 DB 含未知 id 时按 M2 零注入（不是双姿势）。
12. **O7 无冲突核对（已核对，记录备查）**：`sanitizeCompactResponsesRequestBody` 只删
    stream/stream_options/store（不触碰 provider/providerOptions）；`commonHeaders` 是 builder 内局部量
    （header 挂点不污染透传头）；`repo:drift-check` 无 settings-key 契约（新增键不会被漂移检查拦截）。
    另：PUT **不校验** siteId 是否存在于站点表（O6；备份导入全量应用链路无白名单，站点删除后 map 残留行
    保持合法）；GET 回显/落库/重启后形状一致（数值键统一归一为字符串键）。

## 勘误（旧稿/矩阵更正，O2 落地）

- **旧矩阵**（/tmp/pin-support-matrix-results-20260926.md）OpenRouter 行「严格语义由 `order` +
  `allow_fallbacks:false` 表达」**证伪**：官方现行文档明确 `provider.only` 为白名单（「Allowing Only
  Specific Providers」，与账号级允许列表取交集、交集空 404）；`allow_fallbacks` 默认 true、语义是
  order 的回退配套，**不是 only 的前提**。旧 v3 归档稿中同一前提的表述一并作废，以 v3.1 §2.2 为准。
- 据此本实现：only → `provider.only`（严格语义原生生效）；order → `provider.order` 且不写 allow_fallbacks；
  不写 `providerOptions.gateway`（被 OpenRouter 忽略的噪音位）。

## 待核实 / F 清单（Phase 2/3 前置，随实测回填）

- **F-1** Portkey `x-portkey-config` JSON schema 与 `x-portkey-provider` slug 语义（docs.portkey.ai）——未核实，
  不注册、capabilities 不开放。
- **F-2** Helicone `Helicone-Fallbacks` 值格式及单供应商「不回退」表达——未核实，不注册。
- **F-3** LiteLLM per-request 钉选机制（`x-litellm-tags` / `disable_fallbacks` / model_group）——未核实，不注册。
- **F-4** New API/One API `X-Channel-Id` 是否存在及 providers→channelId 语义鸿沟方案——未核实，不注册。
- **F-5（已就绪，O4）** auto hostname 检测的前置已满足：builder 已收 `siteUrl`
  （upstreamRequestBuilder.ts:414）；`chatSurface.ts:566` 与 `openAiResponsesSurface.ts:588` 均已实传
  `siteUrl: siteApiBaseUrl`；注意端点级解析差异，Phase 3 定策略。auto 永不命中 header 族。
- **F-6（部分结案）** OpenRouter provider slug：支持 Base Slug Matching；精确格式与非法名 400 行为留实测回填。
- **F-7** Vercel 对顶层 `provider` 的透传行为——实测前 vercel 适配器不写顶层位。
- **F-8**（可选评估）OpenRouter `provider.only` 是否仍存在回退路径、是否需追加 `allow_fallbacks:false`
  冗余强化——按官方文档当前不需要，留实测。
- **F-9（O3 新增）** OpenRouter responses 面是否读取顶层 `provider`（官方文档标题限定 Chat Completions）
  ——实测项；期间 UI/notes 文案按 chat completions 口径限定。

## 测试与门禁（本阶段证据）

- 门禁四连全绿（Node v22.23.1）：`repo:drift-check`（Violations 0；tracked debt 5 为既有白名单项）、
  `typecheck`（web/web:test/server/desktop）、`npm test`（495 files / 3061 passed / 8 skipped）、`npm run build`。
- 既有 53 个钉选回归用例**测试逻辑零改动全绿**（rules/inject/builder.pin/hydration/settings 路由/E2E 四态）。
- 新增覆盖：adapterMap 三函数（含 '49.9' 丢弃、'049'/'49 ' 归一、归一冲突保留先出现、未注册 id 保留、
  PUT 重复键 400）、adapters（openrouter only/order 原生键与兄弟键互斥、allow_fallbacks 不写不动、
  vercel 仅嵌套位、registry 四家与 S1 引用等同、Phase 2 id 未注册）、apply 门禁（miss/skip/apply + header
  钩子用合成适配器覆盖）、builder 分型（openrouter only/order、vercel、none 零注入与关闭态逐字节相等、
  未注册 id 零注入）、E2E 分型 3 条（S4）、M1 对称无部分应用、S3 往返=重启等价、S6② 两键 PUT 不清空 map、
  UI（适配器小节/下拉只有四家/增删行与保存三键/规则行 label 与警告/未知 id 保留行）、W-5 /logs 防误传加断言。
- 既有回归网中两处按设计同步更新（非回归网文件）：settings.upstream-pin.test.tsx 的「保存 payload 只含两键」
  断言改为三键（Phase 1 明确提交三键）；ProxyLogs W-5 追加第三键断言。

## 被放弃的方案（必填）

- **把 inject.ts 搬移进 adapters/genericDual.ts**：会给「行为不变」承诺引入无谓的 diff 与漂移风险；
  改为原函数别名（S1），回滚面也更干净（inject.ts 永远零 diff）。
- **未注册 id 回落 generic-dual（v3.1 初稿）**：与「跳过而非降级」矛盾；向未知网关写双姿势 body 可能被
  透传给真厂商（如 LiteLLM 透传未识别 body 参数）。改为零注入（M2）。
- **hydration 丢弃未注册 id**：表面上更"干净"，实际把回滚场景变成静默双姿势注入（最危险的失败模式）。
  改为保留 + 热路径零注入兜底。
- **UI 目录 GET /api/settings 下发**（M3 备选 b）：多一条契约面；改落 src/shared 与 web 共读（与
  siteInitializationPresets 先例一致）。
- **only 能力不足时降级为 order**：会静默反转用户意图（严格锁定 → 允许回退），最恶失败模式；跳过不降级。
- **openrouter only 追加 `allow_fallbacks:false` 冗余强化**：only 本身即严格白名单；显式写会覆盖用户
  payloadRules 值（违反 S1 精神）。列为 F-8 留实测评估。
- **Phase 1 注册 portkey/helicone（header 族）**：值格式未核实（F-1/F-2），登记即「假通用」；不注册，
  PUT 提交即 400，Phase 2 核实后再扩白名单与 capabilities。

## 来源

- 设计：/tmp/pin-generic-plan-v3.1-20260926.md；权威增量：/tmp/pin-generic-plan-v3.2-delta-20260926.md
  （M1/M2/M3 决议、S1-S7、O1-O7）。
- 复核：/tmp/pin-generic-oracle-v31-report-20260926.md（OpenRouter 契约实抓、S/O 清单）、
  /tmp/upstream-pin-generic-review-results-20260926.md（双审放行）。
- 旧矩阵勘误对象：/tmp/pin-support-matrix-results-20260926.md；v3 归档稿：/tmp/pin-generic-plan-v3-20260926.md。
- 共享目录先例：`src/shared/siteInitializationPresets.{js,d.ts}`；前序笔记（见文件头链接）。
