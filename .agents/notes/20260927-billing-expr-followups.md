# 20260927-billing-expr-followups

## 背景

fix/tiered-expr-billing（5dc85f0）合并后，oracle 提出 4 项跟进建议。本笔记记录实现过程的关键决策。

## 改动范围

- server: `proxyUsageParser.ts`、`modelPricingService.ts`、`billingExpr.test.ts`
- web: `ProxyLogs.tsx`

## 关键决策

### 1. 历史回算采用当前上游表达式

在只读分析中，用当前上游 `/api/pricing` 返回的 `billing_expr` 对历史 ratio 路径记录进行回算。

**前提**：历史计费期间的表达式与当前一致，或差异在可接受范围内。

**取舍**：无法从 `billing_details` 反查历史表达式（未持久化），只能使用当前值。已显式写在报告限制条款中。

### 2. 回算排除已走 expr 路径的记录

2026-09-27 修复部署后，部分新请求已通过 expr 路径计费（`pricingSource: expr`）。分析时显式排除这些记录，避免将已正确的计费结果混入“多计”统计。

### 3. `len` 近似前提说明补在代码注释

`buildExprBreakdown` 中 `promptTokensIncludeCache === true` 时直接用 `promptTokens` 作为 `len`。代码注释中补充了该近似的前提（非 Anthropic 上游 prompt 通常已包含 cache）和已知偏差（部分上游可能只部分包含 cache）。

### 4. 前端显式展示计费路径

`ProxyLogs.tsx` 日志详情增加“计费路径”行，直接展示 `pricingSource`（expr/ratio）及 `exprFallback` 状态，便于运维与用户审计。

## 历史回算结论（oracle 补充）

- 回算范围：`proxy_logs` 中 `billing_details` 含 `"modelRatio":37.5` 且 `status='success'`、**非 expr 路径**的历史记录，共 **1256 条**。
- 口径说明：
  - 排除 `pricingSource: expr` 的新修复记录，只聚焦 ratio 多计样本。
  - `groupRatio` 取默认值 **1.0**；历史分组倍率若与当前不同，差额会相应变化，但 magnitude 不影响“ratio 多计”定性结论。
  - `len` 重建逻辑与 `buildExprBreakdown` 当前代码一致。
- 结果：
  - ratio 路径已计成本：**$2,426.83**
  - expr 路径估算成本：**$50.05**
  - 差额：**-$2,376.78（-97.9%）**
  - **结论：ratio 路径多计约 97.9%，属于严重多计。**

### 待办

- **真执行回算需脚本 + DB 备份 + 用户批准**：
  - 当前报告基于当前上游 `/api/pricing` 表达式做只读估算；
  - 如需对生产数据执行任何回滚/修正/重算写入，必须先：
    1. 备份 `hub.db`；
    2. 经用户明确批准；
    3. 使用独立脚本（如 `scripts/analyze-billing.ts` 类似结构）并在 dry-run 后验证。

## 待后续验证

- 历史回算的总差额（~$2376.78）是否需要在客服或财务侧做进一步确认。
- `groupRatio` 历史值若与当前不同，回算差额会有偏差。
