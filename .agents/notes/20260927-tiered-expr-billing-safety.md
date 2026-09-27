---
status: active
superseded_by: ""
supersedes: ""
模块: services, web
---

# 上游 tiered_expr 表达式计费：修复占位 ratio 平铺多计

## 一句话结论

上游 `billing_mode="tiered_expr"` 模型的 `billing_expr`（真正的 $/M 公式）此前从未被解析，代码只用 `model_ratio` 占位符（如 37.5）走 ratio×2 路径，导致计费与真实价目严重不符。本次新增一个安全表达式求值器，让 expr 模型按真实公式计费，并对解析/求值失败做**可审计**的 ratio 回退。

## 背景

实测锚定（happycoding `gpt-5.6-sol`）：占位 `model_ratio=37.5` 走 ratio 路径 → 每 M 输入 $75；而真实公式 `p*5+c*30+cr*0.5+cc*6.25` → 每 M 输入仅 $5。占位 ratio 平铺把单价放大了十几倍，且缓存/1h 缓存等维度完全丢失。

## 决策

1. **安全求值器 `billingExpr.ts`**：递归下降解析 + AST 求值，**不用 `eval`/`Function`**。变量仅 `p/c/cr/cc/cc1h/len`，函数仅 `tier(name, body)` / `hour(utcOffset)`，覆盖标准算术/比较/逻辑/三元。未知标识符、未知函数、非法结构在**解析阶段**即拒绝，安全回退。
2. **系数分解**：对（线性的）expr，每个 token 维度单独求值（其余变量=0）隔离出各自的 $/M 系数，成本分项精确可加并等于总额。这样能捕获 `cc1h`（1h 缓存创建）独立维度——四变量推导会丢。
3. **len 合成**：选档用上下文长度。当 `promptTokensIncludeCache===false`（Claude 系缓存独立统计）时 `len = prompt + cacheRead + cacheCreation`，否则 `len = prompt`，prompt 缺失时回退 `totalTokens`。避免独立统计缓存的请求选档被低估。
4. **cc1h 追踪**：`proxyUsageParser` 提取 `cache_creation.ephemeral_1h_input_tokens` / `claude_cache_creation_1_h_tokens`（含驼峰变体）为 `cacheCreationTokens1h`，贯穿到求值上下文 `cc1h` 并作为独立计费维度。`billing_details` 中 `usage.cacheCreationTokens1h` + `breakdown.cc1hCost/cc1hPerMillion` 可审计。
5. **可审计回退**：归一化阶段记录 `pricingFallbackReason`（unparseable / unsupported billing_mode）；`calculateModelUsageBreakdown` 在"有 billing_expr 却走 ratio"（含 eval 运行时异常）时输出 `pricing.exprFallback=true` + `exprFallbackReason`。ratio 正常路径（无 billing_expr）不带标记。保留 `console.warn`。目标：占位值失真不再悄无声息。
6. **catalog 口径**：`/api/pricing/catalog` 是静态 per-group 概览、无具体用量，expr 模型取**最低档**（`len=0`）代表价，并显式打 `exprEstimate: true` 标记，避免前端把基档当定价。真实计费仍按每次请求的 `len` 选档（`billingDetails` 精确）。

## 被放弃的方案（必填）

- **用 `eval`/`new Function` 求值 billing_expr**：表达式来自上游（不受信），直接 eval 是注入风险。改用自研受限求值器。
- **把 cc1h 并入标准 cacheCreation 维度**：无法区分 1h/5m 时确实保持 0（并入），但**能区分时**必须独立计费，否则 1h 溢价（如 cc1h*8 vs cc*5）会算错。
- **catalog 用代表档而非基档**：概览无具体用量，任何"代表档"都是猜。基档（最低）+ 显式 `exprEstimate` 标记最诚实，把精确值留给每次请求的 `billingDetails`。
- **expr 失败时静默回退 ratio**：占位 ratio 平铺正是本次要修的多计根因，静默回退会复发且无法发现。改为显式 `exprFallback` + 原因 + warn。

## 来源

- 上游 new-api 模型配置：`billing_mode="tiered_expr"` + `billing_expr`（实测 happycoding `gpt-5.6-sol` / `gpt-5.2-pro` / `gpt-5.3-codex` / `gpt-5.4`，glm-5.3 / gpt-6-sol / claude-opus-5-5 等）。
- `src/server/services/billingExpr.ts`（新增求值器）、`modelPricingService.ts`（归一化/分解/catalog）、`proxyUsageParser.ts`（cc1h 提取）。
- 测试：`billingExpr.test.ts`（求值器）、`modelPricingService.tieredExpr.test.ts`（端到端）、`proxyUsageParser.test.ts`（cc1h 提取）。
