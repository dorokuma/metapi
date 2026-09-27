# Slice 10 词元消耗统计归一修复笔记

> 日期：2026-09-27
> 切片：词元消耗统计（Slice 10）
> 评审结论：3 项致命 + 2 项应修，已逐条修复。

## 改动概览

1. **proxyUsageParser.ts**：删除 `parseUsageRecord` 中 legacy 的 details 求和合成 prompt/completion、total 合成/反推/钳制逻辑；`getReasoningTokens` 补充 OpenAI 嵌套 `completion_tokens_details.reasoning_tokens` / `output_tokens_details.reasoning_tokens` 读取。
2. **sharedSurface.ts**：删除 `recordSurfaceSuccess` 中 `isSelfLogRecovered` 三元分支，统一使用 `updatedResolve.columns / updatedResolve.billing / updatedResolve.usageSource`；`selfLogUsage` 构造改为 `?? null` 以保持缺失字段为 NULL。
3. **geminiSurface.ts / completions.ts / embeddings.ts**：`logProxy` 入参类型改为 `number | null`，调用点去除 `?? 0` 抹平；`completions.ts` 补传 `siteId: selected?.site?.id ?? null`。
4. **images.ts / search.ts**：`logProxy` 接入 `resolveFinalUsage({ zeros: true })`（images.ts:479、search.ts:234），写出显式 0 拆分列 + `usageSource: NULL`，并补齐 `promptTokensIncludeCache` / `siteId` 字段。
5. **proxyUsageNormalize.test.ts**（新建）：覆盖 `resolveFinalUsage` 四分支（zeros / upstream / self-log / unknown）与 flag 转移、total 钳制与合成。
6. **proxyUsageParser.test.ts**：更新遗留测试、补覆盖键缺失/显式 0/多别名取最大、OpenAI reasoning 字段读取。
7. **sharedSurface.test.ts**：补 unknown 分支断言，修正 self-log 用例上游缺观测条件。

## 六写入点旧锚点→新锚点对照表

| 写入点文件 | 写入函数/位置 | 旧锚点（改动前特征） | 新锚点（reviewer 核对值） |
|-----------|-------------|-------------------|------------------------|
| sharedSurface.ts | `writeSurfaceProxyLog` → `insertProxyLog` | 旧：三元分支绕过归一，`promptTokensIncludeCache: true` 直落 | 246（`writeSurfaceProxyLog` 定义）/ 289（`insertProxyLog` 调用点）/ 669（调用点：failure toolkit log 包装）；`recordSurfaceSuccess` 内两个 `resolveFinalUsage` 调用点 458/514 |
| geminiSurface.ts | `logProxy` → `insertProxyLog` | 旧：参数默认 0，调用点 `?? 0` 抹平 | 289（`logProxy` 定义），调用点 964/1032/1121/1482 |
| completions.ts | `logProxy` → `insertProxyLog` | 旧：参数默认 0，缺少 `siteId`，调用点 `?? 0` 抹平 | 478（`logProxy` 定义），调用点 249/294（stream）/ 394/429（非 stream） |
| embeddings.ts | `logProxy` → `insertProxyLog` | 旧：参数默认 0，调用点 `?? 0` 抹平 | 264（`logProxy` 定义），调用点 190/213 |
| images.ts | `logProxy` → `insertProxyLog` | 旧：硬编码 0、缺拆分列；本次接入 `resolveFinalUsage({ zeros: true })` | 489（`insertProxyLog` 调用点），调用点 479 |
| search.ts | `logProxy` → `insertProxyLog` | 旧：硬编码 0、缺拆分列；本次接入 `resolveFinalUsage({ zeros: true })` | 235（`insertProxyLog` 调用点），调用点 234 |

> 注：images.ts / search.ts 本次已修改：`logProxy` 接入 `resolveFinalUsage({ zeros: true })`（images.ts:479、search.ts:234），显式 0 列与 `usageSource: NULL` 写出与 normalize 模块对齐。

## 登记项

- **self-log 恢复不含 reasoning → 列保持 NULL**：`resolveProxyUsageWithSelfLogFallback` 返回的 `ProxyUsageFallbackResult` 不含 `reasoningTokens` 字段；`sharedSurface.ts` 构造 `selfLogUsage` 时使用 `(resolvedSelfLog as any).reasoningTokens ?? null`，确保归一后 `reasoningTokens` 列保持 NULL。规范已明确，未额外扩范围。
- **数据库迁移列清单历史六列缺口不修**：本次切片不碰 schema.ts / drizzle 产物 / 契约产物，历史六列缺口（`promptTokensIncludeCache` 等）不在本次修复范围。

## 门禁结果

| 门禁 | 结论 | 耗时/备注 |
|-----|------|---------|
| `npm run typecheck:server` | ✅ PASS | 0 错误 |
| `npm run repo:drift-check` | ✅ PASS | Violations: 0（Tracked debt 5 条，均为既有，无新增） |
| `proxyUsageParser.test.ts` | ✅ PASS | 15 测试 |
| `proxyUsageNormalize.test.ts`（新） | ✅ PASS | 12 测试 |
| `proxyBilling.test.ts` | ✅ PASS | 1 测试 |
| `proxyUsageFallbackService.sub2api.test.ts` | ✅ PASS | 3 测试 |
| `sharedSurface.test.ts` | ✅ PASS | 原有测试全过 |
| `completions.usage-source.test.ts` | ✅ PASS | 1 测试 |
| `embeddings.siteApiEndpoint.test.ts` | ✅ PASS | 1 测试 |
| `chat.siteApiEndpoint.test.ts` | ✅ PASS | 1 测试 |
| `upstreamProviderDetect.test.ts` | ✅ PASS | 10 测试 |

## 未 commit

本次改动未执行 `git commit` / `git push` / 部署，仅在工作区盘上修改并验证。
