---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: proxy-core # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 上游观测 ↔ 代理日志硬关联（`proxy_log_id` 钉扎）：三态写入、硬命中优先、窗排除已钉行

## 一句话结论

成功日志写入结果收敛为三态 `ProxyLogWriteResult`（`{written:true, proxyLogId:number|null}` /
`{written:false}`）：只有 `written === true` 才 persist 观测（`written:false` 时观测 0 行，**行为变更**，
兑现 C4、去掉「只能被邻居窗命中」的 NULL 孤儿）；观测钉上该次插入的正整数 id，读侧先按
`proxy_log_id = id` 硬命中，未钉上（`IS NULL`）才走 ±2s 窗且窗内排除已钉给别人的行；存量不回填。
`logSuccess` 的 rejection 仍向上抛，**不收成三态**。websocket 回放「finalize 之后 return 之前」的结构
隐患留在 backlog #2（本次不动控制流）。

## 背景

v1 设计稿被 reviewer/oracle 指出阻断项：`writeSurfaceProxyLog` 吞掉 `insertProxyLog` 异常后
`recordSurfaceSuccess` 照常返回，两个面的 persist 无条件执行 → 日志没写成也会落 1 条 `proxy_log_id = NULL`
的孤儿观测，只能被邻居的成功日志按 ±2s 窗借走（纯错配源）。同时 `insertProxyLog` 丢弃 `.run()` 返回值，
硬关联拿不到 id。设计定稿为 `/tmp/obs-hardlink-plan-v2.1-20260926.md`（v2 底本 + 两轮复核裁定），
本笔记记录落地决策与留痕项。

## 决策

### 1. 三态取代「null 即失败」

- 类型 `ProxyLogWriteResult` 定义在 `src/server/services/proxyLogStore.ts`（`sharedSurface`、两个
  surface、`upstreamProviderDetect/store.ts` 都只做 `import type`，不引入运行时环）。
- `writeSurfaceProxyLog`：try 内 `const proxyLogId = await insertProxyLog(...)`，正整数 →
  `{written:true, proxyLogId}`，否则 → `{written:true, proxyLogId:null}`（**「日志写成、方言没给 id」
  仍要 persist**，列保持 NULL，读侧回退窗）；catch 保留原 warn 后 `return {written:false}`，不 rethrow。
- 写侧唯一判据是纯函数 `shouldPersistUpstreamObservation(write) === write.written === true`
  （`upstreamProviderDetect/store.ts`）；两个 persist 闭包**第一行**只认它，
  **禁止**用 `proxyLogId == null` 判失败。store 再挡一层非正整数（0/负数/NaN/小数/字符串 → NULL）。
- `recordSurfaceSuccess` 返回值新增 `proxyLogWrite`；`await input.logSuccess(...)` **留在 billing
  try/catch 之外**，且**明令不加 catch**：`logSuccess` reject 继续向上抛（异常不是三态；生产
  `failureToolkit.log` 因 `writeSurfaceProxyLog` 内 catch 而永不 reject）。仅对 **resolve 的坏形状**
  （旧测试桩 resolve `undefined`）归一成 `{written:false}`（fail-closed，不影响合法
  `{written:true, proxyLogId:null}`）。
- `insertProxyLog` 返回 `Promise<number | null>`，id 只来自**该次** `.run()` 的
  `getInsertedRowId`；禁止 `SELECT MAX(id)` / `last_insert_rowid()`（SQLite 连接级函数并发会串号）。
  缺列重试循环里只有成功路径 return，失败尝试不产生返回值。
- 三方言证据分级（不写成「都实测过」）：SQLite 已实测；Postgres 是靠 `TABLES_WITH_NUMERIC_ID`
  含 `proxy_logs` + `pgProxyQuery` 注入 `returning id` 的单测覆盖（本次补了 `proxy_logs` 点名
  用例，防止有人把它从集合里拿掉后全站静默 NULL）；MySQL 是读码 + `wrapQueryLike` run shim →
  `normalizeRunResult` 把 `insertId` 映射成 `lastInsertRowid` 的单测，不接真库。

### 2. 读侧：硬命中优先，窗只认 NULL 行

- `findUpstreamProviderObservationForProxyLog`：status 门槛（`skipped`，不计指标）→ `proxyLogId`
  为正整数时硬查（`orderBy id limit 2`）→ 0 行才进 ±2s 窗（`isNull(proxyLogId)` 额外谓词）→
  窗键不完整才 `incompleteKey`（硬查已先跑，硬命中不要求键齐全）。
- 硬命中 1 行且四键无冲突：直接返回，`matchKind:'hard'`、`candidateCount:1`、`hardHits++`，
  **不进 `evaluated`**。
- 四键 anomaly（保守）：只有「双方都有值且不等」才算冲突（null/空串/非 boolean `is_stream`/
  非正整数 id 一律当缺值）；命中则**不展示**（`observation:null`）、`candidateCount:1`
  （与「没采到/0 行」区分，仅内部）、`hardAnomaly++`、进程内一次 warn、**不回退窗**（回退=猜邻居）。
  正常请求两个写入点同源，此分支纯探测 id 链路错钉。
- 同一 `proxy_log_id` ≥2 行：`hardAmbiguous`、`candidateCount>=2`、不回退窗、进程内一次 warn；
  **纯防御**（websocket 真双写得到的是两个不同自增 id，不会触发它，不能拿它当 backlog #2 的监控）。
- `hardHits` **排除** anomaly 与 hardAmbiguous；`evaluated` 只统计窗的 hit/ambiguous/miss；
  `ambiguousRate` 因此仍是「窗兜底健康度」。`hardLinkSuggested` 公式不变但 hint 改写为
  「窗兜底歧义率 >5%（只统计 `IS NULL` 匹配）；硬关联已上线，这不是『去做硬关联』的信号」。
  文件头写明：采样率=1 且硬关联健康时 `evaluated→0`、该标志自然恒 false，**这是预期不是故障**
  （`getUpstreamProviderObservationMatchMetrics` 无生产读者，只影响每 60s 一条 `console.info`）。
- API 不露 `matchKind` / `candidateCount`：`stats.ts` 详情只取 `.observation`，把已校验的路由 id
  作为 `proxyLogId` 传入（不再从行里二次读取）。测试断言了响应无这两个字段。

### 3. 存量不回填

不写 UPDATE、不加脚本：旧行与日志之间没有 request id，只有会歧义或「唯一但错」的窗键；把
「唯一窗」回填成永久 id 会把错配固化（硬命中优先后 `IS NULL` 过滤不会再纠正它）。观测默认
保留期（14 天）短于日志（30 天），NULL 行自然过期；过期前窗行为与今天逐字相同（含「多条 NULL →
不猜」的既有 ambiguous 子断言，测试保留）。

### 4. 空态文案与出口接线

- `ProxyLogs.tsx` 空观测句并列「或与相邻请求撞窗无法唯一关联」，`i18n.supplement.ts` 同步英文，
  测试补「撞窗」半句。
- chat 四个流式臂共用 `recordStreamSuccess`、responses 五个流式臂共用 `finalizeStreamSuccess`，
  只改函数体即全覆盖；非流式两处就地解构。不给 responsesWebsocket 直连路径、count_tokens、
  gemini/search/images/completions/embeddings/rerank 加 persist。
- `endpointFlow.ts` 三个钩子（`onDowngrade`/`onAttemptFailure`/`onAttemptSuccess`）返回类型由
  `void | Promise<void>` 放宽为 `void | Promise<unknown>`：失败/降级调用点现在接到
  `failureToolkit.log` 的三态返回值，语义仍「忽略返回值」；`returnAttemptSuccess` 的
  `upstreamPath` 不变量是 **`ctx.request.path`（真正成功那次 attempt 的路径）**，不得被任何钩子
  返回值/三态结果改写，否则观测 `upstream_path` 会与日志不一致（后续改动注意）。

### 5. 留痕项（不阻塞本次，后续跟踪）

- **backlog #2 websocket 回放结构隐患仍在**：合成回放成功臂是
  `try { finalizeStreamSuccess(); bindSurfaceStickyChannel(); return; } catch { fall through }`，
  今天不双写**只因为** `bindSurfaceStickyChannel` 不抛、`finalizeStreamSuccess` 记账错被自身
  try/catch 吞、debug finalize 走 `safeFinalize*`——一旦有人在 finalize 与 return 之间加会抛的语句，
  fall-through 会二次 `finalizeStreamSuccess` → 双写（两条不同 id 的成功日志 + 两条各自钉住的观测）。
  本次**不**把 `bind` 移出 try（控制流敏感、不在本特性范围）；真双写时详情各自硬命中，不是
  `hardAmbiguous`。
- 硬关联只关闭「新的、已钉 id 的观测被别的成功日志借走」。**仍有**「有成功日志但详情走窗/无观测」
  三类：(a) 未采样；(b) 采中但上游无 routing 元数据（`snapshot()` 为 null，很多站点影响面大于
  采样<1）；(c) 日志写成但方言拿不到正整数 id。日志 insert 抛错不再产生第 4 类孤儿行。
- 详情 ±2s 查询的索引退化（既有观察项 #1）与 `prune` 开关语义仍按先前笔记跟踪，本次未动。

### 6. 双审② S1 收口（仅测试）：websocket 回放用例名实不符

- `routes/proxy/upstreamProviderDetect.test.ts` 的「hard-links the websocket replay exit of
  /v1/responses through the surface」原先 payload 未设 `stream:true`，实际落在非流式 JSON 臂（与
  同文件非流式用例同臂重复），名实不符，没有任何断言指向回放。已修真（生产代码零改动）：payload
  `stream:true` + 上游 chat 形 SSE（`[DONE]` 收尾）+ websocket transport header → 真正进入
  `openAiResponsesSurface.ts` 的合成回放臂（collect → 合成三帧 → `finalizeStreamSuccess`）；用例内
  断言仅回放臂可观测特征作为硬证据（恰好三帧 `response.created`（`status:in_progress`/空 output、空
  output_text）→ `response.completed` → `[DONE]`，无 `response.in_progress`/增量帧；负向对照：同一请求
  去掉 websocket transport header（或同一上游字节去掉 `[DONE]`）则落 generic stream session，只有终端帧
  + `[DONE]`），并保留原断言语义
  （观测行 `proxyLogId` == 该次唯一 success 日志 id）。该出口自此有直接用例兜底（backlog #2 的控制流
  改动会踩到它）。

## 被放弃的方案（必填）

- **「日志 insert 抛错仍写 NULL 观测（与今天一致）」**：oracle 给的 (a) 选项。放弃：那正是纯错配源
  （只有邻居能窗命中的孤儿行），且与 C4 同生共死矛盾；选 (b) 三态 0 行并显式申报为行为变更。
- **在 `recordSurfaceSuccess` 加 catch 把 reject 收成 `{written:false}`**：能让「mock reject 不抛」
  的断言省事变绿，但会静默改变今天「reject 上抛给外层 handler」的行为。**明令禁止**，测试拆成
  (i) resolve `{written:false}` 不抛 + (ii) reject 必须 `rejects.toThrow()` 两条契约。
- **窗不加 `IS NULL` / 用 `!== key.proxyLogId` 三元条件**：`isNull` 与 reviewer 的
  `!== null && !== key.proxyLogId` 在「窗只在硬查 0 行后执行」前提下严格等价，`isNull` 更简单；
  「不缩小错配面」的旧论据作废。
- **把 `bind` 移出 try 顺手消除双写隐患**：一行成本但控制流敏感（涉及回放/降级语义），不在本特性
  范围，留 backlog #2 专项收口。
- **把 anomaly 的 `candidateCount` 回 0 / 把 anomaly 计入 `hardHits`**：前者让「数据异常」看起来
  像「没采到」；后者让「找到了但拒绝展示」与「健康硬命中」无法从计数区分。
- **回填存量**：见决策 3。

## 来源

- 设计定稿（权威）：`/tmp/obs-hardlink-plan-v2.1-20260926.md`；底本 v2 / v1：
  `/tmp/obs-hardlink-plan-v2-20260926.md`、`/tmp/obs-hardlink-plan-20260926.md`。
- 评审：`/tmp/obs-hardlink-review-results-20260926.md`（B1/B2/B3/S1）、
  `/tmp/obs-hardlink-oracle-report-20260926.md`（F1/F2/F3 + O1~O7）、
  `/tmp/obs-hardlink-v2-review-results-20260926.md`（应修 A + 施工提示 B + C~G）。
- 涉及实现：`src/server/services/proxyLogStore.ts`、`src/server/proxy-core/surfaces/{sharedSurface,
  chatSurface,openAiResponsesSurface}.ts`、`src/server/services/upstreamProviderDetect/{store,query}.ts`、
  `src/server/routes/api/stats.ts`、`src/server/db/schema.ts`（仅行注释）、
  `src/server/proxy-core/orchestration/endpointFlow.ts`（钩子返回类型放宽）、
  `src/web/pages/ProxyLogs.tsx`、`src/web/i18n.supplement.ts`。
- 涉及测试：`proxyLogStore.test.ts`、`db/index.proxy-wrap.test.ts`、`sharedSurface.test.ts`、
  `upstreamProviderDetect/store.test.ts`、`upstreamProviderDetect/query.test.ts`、
  `routes/api/upstreamObservations.test.ts`、`routes/proxy/upstreamProviderDetect.test.ts`
  （含 websocket 合成回放出口的直接用例，S1 收口）、
  `routes/proxy/upstreamProviderDetect.logWriteFailure.test.ts`（新文件，只 `importActual` 替换
  `insertProxyLog` 成 reject）、`web/pages/ProxyLogs.upstream-observations.test.tsx`、`web/i18n.test.ts`。
- 验证：`npm run repo:drift-check`（0 违规）、`npm run typecheck`、`npm test`（501 文件通过 / 1 跳过，
  3145 用例通过 / 8 跳过）、`npm run build` 全绿；未 commit。
