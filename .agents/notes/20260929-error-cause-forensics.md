---
status: active
superseded_by: ""
supersedes: ""
模块: "services, proxy-core"
---
# 错误 cause 链取证（fix/proxy-error-cause-logging 切片 1）

## 一句话结论
新增 src/server/services/errorChain.ts 把 Error.cause 链摊平成一行文本，用于失败日志与失败分类；因为分类器吃的是同一份文案，这条链会真实改变站点健康惩罚与熔断计数，是有意为之，不是副作用。

## 背景
上游网络失败常只留下笼统的外层 message（fetch failed / unknown error），真正有用的 errno（ECONNRESET 等）在 .cause 里。切片 1 在 siteApiEndpointService 的失败记录路径改用 formatErrorCause(error)，另在 errorChain.ts 统一实现「摊平 + 防环 + 限深」。

## 决策
1. 失败原因文案同时是失败分类器的输入，改变分类是有意为之。recordSiteApiEndpointFailure 写入的 lastFailureReason 与 classifySiteApiEndpointFailure 判定用的是同一个字符串，因此把 .cause 拼进 message 会让原先「看不出是网络失败」的失败被 NETWORK_FAILURE_PATTERNS（/econnreset/i 等）命中，后果有二：站点健康惩罚量级变化（1.2 -> 2.5 量级）；瞬时报文与熔断计数变化。这两点是有意为之：上游网关瞬时抖动本应被更早识别并轮换端点。副作用是误判成本上升（例如上游自己返回的文本里含 ECONNRESET 字样会被当网络失败），已知情接受。
2. 原始类型 cause 作为叶子节点纳入：throw 'boom' / new Error('outer', { cause: 'socket hang up' }) 原先被直接丢弃，现收成 { message: String(value) }（code 留空）后终止。返回结构不变，formatErrorCause 对既有输入的输出逐字不变。
3. DEFAULT_ERROR_CAUSE_MAX_DEPTH = 8：与 db/migrate.ts:314 的 while (cursor && typeof cursor === 'object' && depth < 8) 对齐——仓库内既有的 cause 链遍历口径就是 8；真实链通常 <=3 层。
4. seen 集合防环：自引用/互换 cause 不死循环，截断到首次重复节点。
5. 注释承诺据实收缩：siteApiEndpointService.ts 原注释称 NETWORK_FAILURE_PATTERNS 能吃到 ETIMEDOUT，但该 pattern 集（RETRYABLE_TIMEOUT_PATTERNS）不含裸码 ETIMEDOUT，故删去该字样；proxyRetryPolicy 的 pattern 未改（外溢面大，另案处理）。

## 被放弃的方案
- 继续只取 .message：丢 errno，端点轮换与失败日志都看不出实因。
- 把 .cause 拆成独立字段（如 lastFailureCode）传给分类器、文案保持纯 message：需改 schema 与下游读取方，改动面远超切片 1。
- 无上限摊平 cause 链：异常深链/环会造成超长文案与潜在停机风险。
- 顺带修 proxyRetryPolicy 让 ETIMEDOUT 命中：该 pattern 集被重试/通道逻辑共用，外溢面大，须单独立案评估。

## 遗留
- A：chatSurface.ts 的 559 / 756 / 1742 三处 SiteApiEndpointRequestError 构造点无底层 Error 对象（只有 result.errText / payload.error.message 文本），栈里已无 cause 可摊平，故未补 cause。要真正修复需在这三处向上游透传原始 Error 对象。
- B：仍只取 .message 的入口清单：siteApiEndpointService 的调用方；openAiResponsesSurface.ts:1482/1490；images.ts:184/404；videos.ts:168；embeddings.ts:207；search.ts；chatSurface.ts 的 SiteApiEndpoint 分支 1372/1373/1382 与 count_tokens 的 1841/1842/1850。
- C：siteApiEndpointService.ts:219 注释仍含 ETIMEDOUT 字样（陈述 .cause 里可能藏 errno，非 pattern 覆盖承诺），按不扩范围保留。
- D：既有 flake（与本改动无关）：tokenRouterDumpRetentionService.test.ts:431 在并行全量跑时偶发 expected 0 to be >= 1；本轮两次全量均未复现，单跑 10/10 绿。
- 遗留 E（consider，来自 delta 复审）：src/server/services/errorChain.ts:105-107 的 `if (chain.length === 0) return String(error).trim();` 属不可达兜底（前面已拦 null，且原始类型已作为叶子节点处理），后续重构可顺手清除。

## 来源
- 分支 fix/proxy-error-cause-logging 切片 1 + 双审 should-fix 清单（reviewer / oracle）+ delta 复审。
- src/server/services/errorChain.ts / errorChain.test.ts / siteApiEndpointService.ts / siteApiEndpointService.test.ts。
- 深度口径依据：src/server/db/migrate.ts:314。
