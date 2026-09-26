---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: services # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 上游供应商钉选注入（预埋）：按站点 + 下游请求模型注入 provider only/order

## 一句话结论

新增「上游供应商钉选注入」能力：用户在系统设置页配置「站点 + 下游请求模型（精确或 `*` 全串通配）→
供应商列表 + only/order 模式」规则后，代理链路在构造上游 JSON 请求体时将规则翻译为两类字段——
嵌套 `providerOptions.gateway.{only|order}` 与顶层 `provider.{only|order}`——同时写入 chat 面与
responses 默认路径；默认关闭、无配置零行为变化。**当前 Cline 网关对这两类字段静默丢弃（注入无害）；
本功能首先是「预埋语义」**：为 Cline 恢复读取参数（或 OpenRouter、New API 等聚合商）时零代码激活做准备。
上游一旦恢复解释，已配置规则将**立即改变实际路由、无需 metapi 变更**（R2 休眠激活风险已写入 UI 文案）。

## 背景

- 上游探测链路已能观测每笔请求实际命中的提供方（gate → collect → store → query → UI）；下一步要
  让用户能把某站点某模型的请求「钉」到指定供应商（only = 严格、order = 优先+回退），先预埋字段。
- 实测注入姿势（/tmp/cline-detect-spec.md）：两类字段可并存注入；Cline 当前静默丢弃；
  OpenRouter 读 `provider.order`、New API 走 `X-Channel-Id`（非本功能范围）。
- 注入点必须覆盖 chat 面与 responses 面：两面共用构造器 `buildUpstreamEndpointRequest`，
  在构造器内注入即可全覆盖，且天然只作用于 JSON 请求体。

## 决策

1. **配置模型**：settings 键 `upstream_provider_pin_enabled`（boolean，默认 false）+
   `upstream_provider_pin_rules`（JSON 数组，默认 `[]`），无 DB schema 变更；
   env 变量 `UPSTREAM_PROVIDER_PIN_ENABLED` / `UPSTREAM_PROVIDER_PIN_RULES_JSON` 对齐探测先例。
   双保险：总开关关闭 **或** 规则数组为空任一成立即不注入（空选择 = 不开启，支持一键急停）。
2. **规则四字段形状**：`{ siteId, model, providers, mode }`。`siteId` 正整数（数字/数字字符串归一，
   复用探测同款思路、新模块自带 normalizeSiteId 不跨模块 import）；`model` 精确或 `*` 通配、
   **全串锚定、大小写敏感**；`providers` 非空字符串数组（trim/去空/去重）；`mode` ∈ {only, order}。
   多规则命中时数组顺序首个生效；PUT 严格校验对完全相同 `siteId + model` 的重复项返回 400
   「存在重复规则」；UI 提供上移/下移调整顺序。
3. **匹配键 = 下游请求模型**（`resolveRequestedModelForPayloadRules` 的 fallback 链结果：
   responsesOriginalBody.model → claudeOriginalBody.model → openaiBody.model → input.modelName），
   不是 actualModel。用户配置时只知道请求模型，文档与 UI 文案均按此表述。
4. **规则双形态约定（写死）**：存储形态 = settings 表/PUT/GET 永远为四字段原始 JSON 数组、
   不含 matcher/正则编译产物；内存形态 = `config.upstreamProviderPinRules` 持有预编译 `match`
   的编译形态。编译只在 hydration / config 初始化各做一次，运行期热路径禁止 `new RegExp`。
   GET 回显经 `toUpstreamProviderPinStoredRules` 收敛回四字段，PUT 落库直接把原始数组交
   `upsertSetting`（内部已 JSON.stringify，禁止手工双重编码）。
5. **注入点与优先级**：注入在 `buildUpstreamEndpointRequest` 内部、payloadRules 之后
   （钉选胜出用户规则）、sanitize/normalize 之后（不会被剥）。写两个位置返回浅拷贝；
   only/order 兄弟键互斥（写 only 删 order，反之亦然），避免历史残留字段冲突；
   顶层 `provider` 为对象时浅合并保留 `allow_fallbacks` 等其他键；`providerOptions` / `gateway` /
   `provider` 存在但非普通对象时保守跳过对应位置注入；空 providers 原样返回。
6. **接线范围（W-1/W-2）**：chat 默认路径与 responses **默认路径**注入（responses 注入代码写在
   `sitePlatform === 'codex'` 分支之后，codex responses 请求体严格不注入）；匹配键复用构造器内
   预计算的 `requestedModelForPayloadRules`，勿直取 `responsesOriginalBody?.model`；
   两个调用点（chatSurface、openAiResponsesSurface）传 `siteId: selected.site.id`；
   messages / gemini-native / internal-gemini / codex profile 分支不加代码；geminiSurface、
   responsesWebsocket、runtimeModelProbe 不传 siteId = 自然不注入（WS 与测活是 codex 场景，
   测活请求不应被钉选污染）。**明确不注入**：非 JSON 体、WS、gemini-native、anthropic-messages 端点。
7. **claude 回退为设计预期**：downstreamFormat=claude 经 chatSurface 回退到 `chat` 端点会注入
   （Cline 场景实际端点即 chat）；回退到 `messages` 不注入——有意为之，已在 UI 文案标注。
8. **无 proxy_logs 改动**（定案）：可观测性走既有旁路——注入是否发生由 metapi debug 链路
   requestBody 断言（E2E fetchMock 固化）+ 线上 debug 页人工核对；注入是否生效由站点侧人工证据
   （上游网关路由元数据/控制台记录）确认，二者结合缺一不作数。
9. **验收与风险留痕**：
   - **R7 留痕（不改设计，留实测）**：`provider.require_parameters=true` 与注入字段叠加的语义、
     以及双姿势（嵌套 + 顶层）同网关的读取优先级，均留实测后回填本笔记。
   - **oracle 留问 1（激活确认）**：当前按「立即生效」设计；首批不往生产站点预置规则；
     Cline 恢复读取后实测再决定是否加「激活确认」二次开关。
   - **oracle 留问 2（人工证据标准）**：暂定「上游侧网关路由元数据/控制台记录 + debug requestBody
     断言」双证据，具体站点证据形式实测后补。
   - **oracle 留问 3（支持面）**：除 Cline 外不对字段姿势做代码假设；UI 文案限定「仅适用同一网关」，
     新增聚合商支持前必须人工实测并记入本目录。
   - **风险 1**：未知字段可能被严格上游拒绝（New API 类原样透传 + OpenAI 官方严格实现也可能 400）；
     缓解 = 站点白名单天然限定、总开关一键急停、无配置逐字节回基线、文档提醒首批规则只配实测支持的
     聚合商站点（不往 gemini/openai 官方平台站点预置规则）。**风险 3**：注入在 payloadRules 之后，
     用户将来想用 payloadRules 剥掉 provider/providerOptions 剥不掉（注入在后会补回），如需反转改一行位置。
10. **测试与门禁**：rules/inject 单测（含 S1 浅合并、S2 兄弟键互斥四个位置、S3 边界容错表、双形态断言、
    W-4 string 输入）、构造器注入单测（W-1 codex、W-2 匹配键优先序、无配置深度相等）、
    路由测试（持久化 + 热生效 + 400 + **往返断言=重启等价** + GET 无编译残留）、
    端到端四态（命中 / 模型不命中 / 站点不命中 / 未传 siteId，②③ 与基线逐字节相等）、UI 测试
    （保存 payload 只含两键、排序、重复警告、Q3/Q4 惰性加载零预取）。真库测试沿用 `vi.hoisted`
    把 DATA_DIR 指向 `tmp/` 独立目录，绝不写工作树 data/。

## 被放弃的方案（必填）

- **注入放 routes 层调用点**：chat/responses 两个调用点各写一遍会漂移；routes 层协议转换禁令也不允许。
- **只写顶层 `provider` 或只写嵌套 `providerOptions.gateway`**：Cline/OpenRouter 读取姿势未定，
  双姿势同发最大化兼容，单姿势会漏掉未知网关语义。
- **整体替换顶层 `provider`**：会抹掉 payloadRules 写入的 `allow_fallbacks` 等同级键，属实现错误。
- **静态校验期强制拒绝「精确+通配」潜在重叠**：无法完全静态判定（如 `*` 与精确值），
  只对完全相同 `siteId + model` 字符串判重；运行期由「首个命中生效」定序。
- **按 actualModel 匹配**：用户配置时只有请求模型，actualModel 由路由层决定且可能随渠道变化；
  列为二期项。
- **proxy_logs 新增注入字段**：改动面大且语义上不属于日志；走 debug 链路 + 站点侧人工证据。

## 后续观察项 / 待办

- **R-C（ReDoS 面，可选加固）**：`model` 通配在归一化期编译为正则，连续多个 `*`
  （如 `a**b`）会展开为 `.*.*`，形成理论回溯面；当前规则仅管理员可配、长度有限，风险低。
  可选加固 = 编译前折叠连续 `*`（`**` → `*`），留观察。
- **R-D（混合形态删除不完整）**：S2 的 only/order 兄弟键清理只在**可写入位置**生效；
  当 `providerOptions` / `gateway` / 顶层 `provider` 因非普通对象被保守跳过时，其中残留的
  另一模式键不会被清理（极端混合形态）。当前判定低风险（此类 body 极罕见），留观察。
- **R-E（UI 观测面板不随编辑失效）**：Q3「最近实际上游」面板按行索引缓存，加载后修改该行
  站点/模型不会自动失效（仅增删行/移动行时清空）。只读参考面板，留作体验优化项。
- **R-F（UI 无前置校验）**：规则行允许提交空站点/空模型/空供应商，依赖服务端 400 +
  行内重复警告裁决（设计取舍：服务端为唯一裁决方）；若后续反馈不佳，可在保存前做行级提示。
- **siteId 归一沿用探测先例**：数字带小数走 `Math.trunc` 截断（如 49.9 → 49），与
  `normalizeUpstreamProviderDetectSiteIds` 完全同款，非本功能新语义。
- **R1 验收待办**：钉选**是否发生** = debug 链路 `requestBody` 人工核对（E2E fetchMock 已固化口径）；
  钉选**是否生效** = 站点侧人工证据（上游网关路由元数据/控制台记录）；首批**不预置生产站点规则**，
  Cline 恢复读取后实测再评估「激活确认」二次开关（oracle 留问 1）。

## 来源

- 设计稿 v2.1：/tmp/upstream-pin-plan-v2.1-20260926.md（v1 底本 + 双审意见 W-1~W-6 / S1~S3 / R1~R7）。
- 上游观测先例：`.agents/notes/20260925-upstream-provider-detect-settings-relocation.md`、
  `.agents/notes/20260925-upstream-provider-detect-oracle-followups.md`。
- 字段姿势实测：/tmp/cline-detect-spec.md。
