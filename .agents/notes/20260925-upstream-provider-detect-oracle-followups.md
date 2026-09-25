---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: services
---

# Cline 上游探测提交前整改（oracle 观察项）：详情索引退化 / responses E2E 缺口 / 采样错配残余 / prune 语义

## 一句话结论

「Cline 上游探测」提交前按 oracle 复核意见完成 4 项整改（responses persist 移入 try、
详情匹配加 `status === 'success'` 门槛、成本视图逐字段合并、面板采样率/「观测数」列名），
本笔记留痕 4 条不阻塞提交但必须跟踪的观察项：详情 ±2s 查询吃不到复合索引（后续小迁移候选
`(account_id, channel_id, requested_model, created_at)`）、responses 面零「落 1 行」端到端测试
（含 websocket 回放分支双写结构风险）、采样率 <1 时「唯一但错行」残余面与 `hardLinkSuggested`
阈值折算、prune 主开关关闭时仍跑 DELETE 的语义待定。

## 背景

本轮为「Cline 上游探测」全部未提交改动的提交前整改（oracle 报告 `/tmp/cline-detect-code-oracle.md`，
2026-09-25）。oracle 结论为「有条件可提交」：核心链路（转发零改动、开关默认关、解析/收集/落库/
聚合/UI 正确性、测试隔离）独立复算通过，无致命问题；4 项应修（responses persist 位置、详情匹配
status 门槛、成本视图逐字段合并、面板采样率/列名）本轮已落地，另顺手节流了 prune 失败 warn。

`npm run repo:drift-check`、detect 全链路（11 文件 122 测试）、全量 `npm test`、`typecheck`、`build`
均为本轮门禁（见「来源」）。

## 决策

### 本轮已落地（提交前整改）

1. **responses 面对齐 chat 的「同生共死」语义（C4）**：`openAiResponsesSurface.ts`
   `finalizeStreamSuccess`（流式，~:924）与非流式成功出口（~:1386）的
   `persistUpstreamObservation(...)` 移入 try、紧接 `await recordSurfaceSuccess(...)` 之后。
   成功日志写失败时不再产生观测行（此前 catch 吞错后仍 persist，孤儿观测可被「另一个请求的
   成功日志」按 ±2s 唯一命中 → 静默错配）。persist 自身仍不抛（store 内部 catch + warn 一次），
   不淹外层。
2. **详情匹配加成功门槛**：`findUpstreamProviderObservationForProxyLog` 前置
   `status === 'success'`（`stats.ts` 详情 handler 传入 `row.proxy_logs.status`），
   失败/retried/未知状态直接 `observation: null` 且不进入 F2 ±2s 统计（skipped 不计 hit/miss/
   incompleteKey，单独语义见函数注释）。测试：`query.test.ts`「non-success log even when a unique
   observation sits in the window」+ `upstreamObservations.test.ts` 详情路由 failed-log 用例。
3. **成本视图逐字段合并**：`collect.ts` `observe` 不再整帧替换 `latestUsageCosts`，改为
   `mergeUsageCostViews`（非空优先、最新覆盖）。修掉「先 `{choices:[],usage:{cost:7}}`、后带
   `gateway.cost` 无 usage 的 routing 帧 → usageCost 丢 null」的潜伏缺陷；既有「freshest usage」
   语义不回归（相关用例全绿）。测试：`collect.test.ts`「merges cost views per field …(oracle repro)」。
4. **面板采样率与列名（设计明文要求）**：`ProxyLogs.tsx`「上游分布」面板头部显示
   「采样率 x（数值为观测数，非全量请求数）」；「请求数」列与「按请求数排序」改为「观测数」
   「按观测数排序」（桌面表格 + 移动端 MobileField）。测试：`ProxyLogs.upstream-observations.test.tsx`
   断言采样率文案 + `th` 列名；mobile 用例断言 `mobile-field-label` 为「观测数」且不含「请求数」。
5. **顺手项：prune 失败 warn 节流**：`pruneScheduler.ts` 失败 warn 改为每进程一次
   （与 `persistWarningLogged`/`parseWarningLogged` 同模式），避免表缺失/DB 抖动时每周期刷一条。
   测试：`pruneScheduler.test.ts`「warns at most once per process when prune keeps failing」。

### 保留观察项（不阻塞提交，后续跟踪）

1. **详情查询索引退化（后续小迁移）**：详情 ±2s 查询
   `(account_id, channel_id, requested_model, created_at ±2s[, is_stream])` 实际只吃到
   `upstream_provider_obs_model_provider_created_idx` 的 `requested_model` 前缀
   （中间列 `final_provider` 无约束，`created_at` 无法作为范围推进）→ 扫该模型全量索引条目再过滤。
   实测 10 万行/模型 ≈ 6ms，但随行数线性涨。建议后续小迁移补
   `(account_id, channel_id, requested_model, created_at)`（或 `(account_id, channel_id, created_at)`）。
   本轮明确不做。
2. **responses 面端到端测试缺口**：`upstream_provider_observations` 目前只被 chat 集成测试与
   store/query/route/collect/parse 单测覆盖；responses 面 5 个流式出口、websocket 回放、
   非流式、SSE 文本扫描没有任何「每个成功出口恰好落 1 行」的回归钉子（oracle 靠读代码确认落地成对）。
   结构风险：websocket 回放分支的 try 包住 `finalizeStreamSuccess`，其后 `bindSurfaceStickyChannel`
   抛错可能 fall-through 再跑一遍 → 同请求双写（proxy log + 观测行）。建议补 e2e 用例钉住「落 1 行」。
   本轮明确不做（backlog）。
3. **采样 <1 时「唯一但错行」残余面**：status 门槛消除了「失败日志借邻居上游」；但 `sample_rate < 1`
   时，被采样排除的成功请求（无观测）仍可能唯一命中 ±2s 内邻居的采样观测（同 account/channel/model/
   is_stream）→ 静默展示错的上游。`hardLinkSuggested` 阈值（ambiguous rate > 5%）未按采样率折算，
   是否折算/改成别的判据待观察。本轮明确不做。
4. **prune 开关语义待定**：总开关 `upstreamProviderDetectEnabled=false` 但
   `upstreamProviderDetectRetentionDays>0` 时，调度器仍每 30 分钟发 DELETE
   （`pruneUpstreamProviderObservations` 只看 retentionDays）。「保留期独立于采集开关」是设计还是
   漏洞待定；另 v1 详情 index 迁移与端到端测试同样在 backlog。

## 被放弃的方案（必填）

- **硬关联 `proxy_log_id`（或详情只信硬关联）**：v1 不改 `insertProxyLog` 签名、不回填；F2 用
  ±2s + `is_stream` 降歧义 + `hardLinkSuggested` 阈值作为触发信号。放弃理由：v1 目标是不碰
  proxy_logs 写入路径；错配残余面用 status 门槛 + 后续折算收敛。
- **responses 面保留「至少留下上游痕迹」（persist 在 catch 之后）**：oracle 给了「对齐 chat」或
  「显式承认偏差写进契约」两个选项。选择对齐 chat：孤儿观测可被邻居成功日志唯一命中，错配的代价
  高于少一行观测；「没有观测」在详情页已有 F4 兜底文案。
- **成本视图「整帧替换 + 空 usage 特判」**：逐字段合并在语义上覆盖所有「部分字段帧」组合
  （routing 帧带 cost 无 usage、usage-only 帧、两者顺序任意），无需为每种组合加特判。
- **prune warn 按时间窗节流 / 失败后成功再布防（reset-on-success）**：选择与既有
  `persistWarningLogged`、`parseWarningLogged` 相同的「每进程一次」旗标，保持模块间模式一致；
  时间窗/复位语义留待真有运维需求再加。

## 来源

- oracle 代码复核报告：`/tmp/cline-detect-code-oracle.md`（独立复核：门禁复跑、真实样本探针、
  查询计划实测、坏库插入实测）。
- 涉及实现：`src/server/services/upstreamProviderDetect/{collect,query,pruneScheduler,store}.ts`、
  `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`、`src/server/routes/api/stats.ts`、
  `src/web/pages/ProxyLogs.tsx`。
- 涉及测试：`src/server/services/upstreamProviderDetect/{collect,query,pruneScheduler}.test.ts`、
  `src/server/routes/api/upstreamObservations.test.ts`、
  `src/web/pages/ProxyLogs.upstream-observations{,.mobile}.test.tsx`。
