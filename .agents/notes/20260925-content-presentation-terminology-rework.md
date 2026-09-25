---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "web, server" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 内容展示返工：中文文案三术语规范（词元 / 令牌 / 密钥）与上游探测文案中文化

## 一句话结论

中文界面里凡是「用量」语境一律用「词元」、「认证凭据」一律用「令牌」、「Key 类凭据」一律用「密钥」；上游探测（ProxyLogs 观测块 / 分布面板 / Settings 分区）此前完全未入 i18n 字典的文案本次补齐并中文化，`usage.gateway_cost` 与 `gateway.cost` 的去重展示按「网关成本」单行口径收敛。

## 背景

- 上一轮（HEAD 1b130c4）把「上游探测」从调试弹层迁到系统设置页并做了去品牌化，但观测块 / 分布面板 / 设置分区仍夹带英文（`hit` / `miss` / `fingerprint` / `resolved` / `clientSession` / `Fallback` / `Attempts` / `Generation` / `usage.cost` / `gateway_cost` 等），且这些中文串完全没有 zh→en 映射，英文模式下会落到 `enforceStrictEnglish` 兜底。
- 全仓中文文案对 `Token` / `Key` / `tokens` 的用法不统一（同一功能在「令牌」与 `Token` 之间摇摆），需要一次性收敛。
- 上游自报成本同时存在 `usage.cost` / `usage.gateway_cost` / `usage.market_cost`（结构化数值）与 `gateway.cost` / `gateway.inferenceCost`（网关原始文本），原先 5 项平铺展示，语义重复且难读。

## 决策

1. **三术语规范**（仅中文界面文案，identifier / 协议字段 / 英文模式不动）：
   - 用量类 `tokens` → **词元**（`1M 词元`、`{n} 词元`、缓存词元…）。
   - 认证域 `Token`（含 `Session Token`、`Telegram Bot Token`、`代理访问 Token`）→ **令牌**（保留限定词，如 `Session 令牌`）。
   - `Key` / `Keys` / `API Key` / `下游 Key` / `默认 API Key` → **密钥**（`API 密钥`、`下游密钥`）。
   - 例外（明确保留）：`PROXY_TOKEN` / `refresh_token` / `access_token` / `change-me-admin-token` / `sk-` / 事件键 `'token'` / `default_api_key` 等字段与协议名；纯英文 API 错误（如 403 `Invalid token`）；上游报错原文匹配串（`alertRules.ts` 的 `access token 无效`、`failureReasonService.ts` 的 `turnstile token 为空`）；对象键语义的 `key`（如自定义请求头 `按键/值逐条填写`，`模型映射的键`）。
2. **上游探测观测块文案中文化**（`renderUpstreamObservationBody`，移动端抽屉与桌面展开唯一共用出口）：`命中/未命中/指纹`、`（解析为 x）`、`客户端会话`、`回退`、`尝试`、`生成记录`、`{n} 次提供方尝试`、`（尝试记录已截断存储）`。
3. **上游成本去重（方案①）**：行1 `实际成本`(usage.cost) / `网关成本`(usage.gateway_cost，缺失回退 gateway.cost) / `市场成本`(usage.market_cost)；行2 `网关推理成本`(gateway.inferenceCost)；`gateway.cost` 不再单独成项，原始字段名与两处原始值只放在 `title` 悬停里；数值格式沿用 `formatUpstreamCostNumber` / `formatUpstreamCostText`。
4. **回退口径统一**：`当前渠道清单` → `当前回退清单`，移动端 `渠道数`/`渠道` → `回退数`/`回退`，空态 `暂无回退清单（观测未携带回退数据）。`。
5. **i18n 同步策略**：key 已在主表（`i18n.tsx`）的改主表，其余追加到 `i18n.supplement.ts`（手改安全、无生成器）；被改/新增的中文串逐字符与运行时字符串对齐（全角标点、占位符保持一致），由英文改中文的文案补 en 映射还原原英文。
6. **server 侧中文提示同步**：能在 UI 中出现的服务端中文消息（账号/令牌/下游密钥校验、通知标题与每日总结）一并按三术语改名，测试断言同步更新；通知事件键（`token`/`proxy`…）保持不变。

## 被放弃的方案（必填）

- **只改 web、不改服务端中文消息**：toast 直接展示服务端 `message`，会立刻在同一个界面里同时出现「API 密钥」与「API Key」，术语规范形同虚设。
- **保留 `gateway.cost` 单独一行**：与 `usage.gateway_cost` 语义重复，用户无法判断该看哪个；改为「网关成本」单行 + 悬停展示两处原始值。
- **把成本缺失值统一显示成 `--`**：`usage.gateway_cost` 缺失但网关原始文本存在时仍应给出参考值，故保留 `formatUpstreamCostText` 回退（该回退值不带 `$` 前缀，属既有格式约定）。
- **把 `Session Token` 译成「会话令牌」**：与页面既有「Session 连接 / Session 凭证 / Session 令牌」命名不一致；`Session` 只在 `/logs` 追踪面板按「会话」处理（表头、详情标签、目标会话 ID）。
- **给短词（词元/令牌/密钥/回退/命中…）只加整句 key**：DOM 文本节点多为「标签 + 数值」拼接，无法整句命中，必须补短词短语映射，否则英文模式会落到 `enforceStrictEnglish` 把中文整段剥掉。

## 来源

- 用户 2026-09-25 派发：「内容展示」全量返工（特性文案中文化 + 全项目术语三规范 + i18n 同步 + 测试同步），清单 A–H。
- 前序笔记：`.agents/notes/20260925-upstream-provider-detect-settings-relocation.md`、`.agents/notes/20260925-upstream-provider-detect-oracle-followups.md`。

## 值层映射（follow-up：会话亲和行英文值词漏网）

- 背景：术语返工后观测块仍有两处英文「值词」原样渲染：`结果 confirmed`、`客户端会话 sess-…（explicit）`；`deepseek` / `sess-…` 为标识符，保留。
- 修复（仅渲染层，桌面 / 移动共用的 `renderUpstreamObservationBody`；服务端解析与 DB 存值不动）：
  - `affinityOutcome`：`confirmed` → 「已确认」，未知值原样透传；
  - `clientSessionIdSource`：`explicit` → 「显式」，未知值原样透传。
- 映射策略：精确匹配（大小写敏感）→中文、未知值与大小写变体原样透传、上游新增枚举值出现时补充映射。
- i18n：`i18n.supplement.ts` 补 `'已确认': 'confirmed'`、`'显式': 'explicit'`，英文模式还原原英文；含「显式」的既有长句键按最长匹配整句命中，不回归。
- 测试：桌面 / 移动观测块用例断言中文值词 + 未知值透传用例；变异验证：撤掉值映射→桌面 / 移动两处用例失败，撤掉 i18n 键→en 模式用例失败。曾出现的副作用：未入字典的 `显式群组…`（tokens 服务端消息）与 Sites 页 `关闭时请求本身显式传入…` 的 en 兜底文本从「整段 Untranslated」变为保留 `explicit` 词干——该副作用已由下方 en 补键覆盖。
- 顺扫结论（上游探测展示面）：除上述两值词外，观测块 / 分布面板 / 设置分区的其余值均为标识符 / 品牌 / 协议字段 / 原始 ID（finalProvider、resolvedProvider、canonicalSlug、originalModelId、affinityPinnedProvider、fallbacks、systemFingerprint、gatewayGenerationId、clientSessionId、provider），按保留类不动。
- en 补键（跟随本次值层短键）：`i18n.supplement.ts` 为含「显式」的未映射整句补 6 条键——tokens 接口 5 条（「显式群组至少需要选择一个来源模型」「显式群组不能引用自身作为来源模型」「显式群组只能选择精确模型路由作为来源模型」「显式群组不支持直接维护通道」「显式群组必须填写对外模型名」）+ Sites 页开关说明 1 条（「关闭时请求本身显式传入的请求头优先级更高。」）；`i18n.test.ts` 补 en 整句探针，短键「显式」不再命中长句前缀。
