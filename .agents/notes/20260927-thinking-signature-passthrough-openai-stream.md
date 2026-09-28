---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "transformers" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# pi thinking 签名经 OpenAI 流回传修复（`reasoning_details` 闭环）

## 一句话结论

thinking 模式下 Anthropic 上游的签名在「上游流 → OpenAI 下游」格式边界被丢弃，pi 回传时缺 `content[].thinking.signature` 触发 400（`The content[].thinking ... must be passed back`）；现在把上游 `signature_delta` 缓冲后以一条流式 `reasoning_details` chunk 下发，pi 存储/回传，入站还原成 `thinking.signature`，闭环打通。

## 背景

- 现象：pi（走 OpenAI chat surface 的 thinking 请求）多轮对话时上游 400，文案 `The content[].thinking ... must be passed back`。thinking 块必须把上一轮的 `signature` 原样带回，否则 Anthropic 拒绝。
- 根因（属回归）：签名回传链在 **OpenAI 格式边界断裂**。上游 Anthropic 流用 `signature_delta` 增量下发签名，但 metapi 的 openai chat 下游没有承载签名的字段——OpenAI chat 协议没有「签名」概念，签名既没被缓冲、也没被下发，pi 因此拿不到、回传时缺失。
- 链路：`normalizeUpstreamStreamEvent`（`chatFormatsCore.ts`）→ `proxyStream.ts`（openai chat 下游）→ pi（消费 `reasoning_details`、存储并回传）。
- 关键约束：签名必须随 thinking 文本**同一块**到达 pi，且要在 `finish_reason` / `[DONE]` 之前落到下游，否则 pi 拿不到。

## 决策

- 改动范围（commit `14a3b07`，分支 `fix/thinking-signature-passthrough`，父 `2507cce`，6 files +851/-14）：
  - `transformers/shared/chatFormatsCore.ts`：
    - `StreamTransformContext` 新增签名状态 `pendingThinkingText` / `pendingSignature` / `signatureDetailsSent` 与回调 `onThinkingBlockStopped`；`createStreamTransformContext` 初始化默认值。
    - 上游 `thinking_delta` / `signature_delta`（Anthropic 流）与 openai `reasoning_content`+`reasoning_signature` 统一缓冲进 `pendingThinkingText` / `pendingSignature`；`content_block_start(type=thinking)` 时 reset 缓冲。
    - 新增 `buildPendingSignatureFlushEvent()`：块停止 / 流收尾时把缓冲合成**单条** `reasoning_details`（`type=reasoning.text` + 全文 + 签名），`signatureDetailsSent` 防重复下发。
    - `buildOpenAiStreamChunk` 在 `finish_reason`/`done` 时触发 flush；`serializeStreamDone` 的 openai 分支在 `terminalUsageChunk`/`[DONE]` 之前再兜底 flush 一次（确保签名永远先于终态）。
  - `transformers/openai/chat/proxyStream.ts`：openai 下游注册 `onThinkingBlockStopped`，flush chunk **直接 writeLines**（不走 pendingWrites 队列），并置 `forwardedDownstreamOutput=true`，保证 `reasoning_details` 先于 `finish_reason`/`[DONE]`；空内容拦截器对「纯签名响应」不再误判为空。
  - `transformers/anthropic/messages/conversion.ts`：入站还原。`resolveAnthropicThinkingSignature` 收紧为**只认 `signature` 字段**（`reasoning_signature` 是 pi 回传的 OpenAI 侧字段，raw UUID 会误判为 null 丢块）；`convertOpenAiBodyToAnthropicMessagesBody` 按优先级（`reasoning_details[reasoning.text]` > `reasoning_content/reasoning` > `signature`）取签名载体，并对「同文本的 content thinking 块」去重，避免双发。
  - 测试：`conversion.test.ts` +266、`proxyStream.test.ts` +163、`normalized.test.ts` +201。
- 发布策略：行为不变优先——非 thinking / 非 openai 下游路径完全不变；只有 openai 下游 + 存在缓冲签名时多一条 `reasoning_details` chunk。

## 被放弃的方案（必填）

- **content 块 `thinkingSignature` 的 v1**：早期把签名挂在 content 块的 `thinkingSignature` 字段上，但 pi 对 content 块的该字段不做签名回传（pi 认的是 `reasoning_details`/签名载体），回传链仍断。改为走 `reasoning_details` 签名。
- **照抄成功样本形状**：直接复现某条已知 200 响应的字段排列，但样本形状对 pi 的存储/回传语义无约束力，换个上游/模型又断。改为让签名随 thinking 文本同块、在终态前下发这一确定性不变量。
- **站点特判**：按具体站点/模型加 if 绕过，维护面发散且漏站即复发。否决，走通用格式边界修复。

## 未决观察项（后续盯）

- **多 thinking 块**：当前 reset 发生在 `content_block_start(type=thinking)`，单次响应内多个 thinking 块的「后续块签名」是否被正确分块下发，需在多块场景（如长思维链拆块）补验证。
- **跨 attempt reset**：重试 / recover 跨 attempt 时签名缓冲的清理边界尚未专门覆盖，若上游在 attempt 间下发残缺签名块，可能残留旧签名。

## 验证结果

- 部署后 canary：thinking 模式 400（`must be passed back`）= **0**；签名闭环 **41 个 UUID** 全量对上（上游下发的签名 = pi 回传还原的 `thinking.signature`）。
- 行为不变：非 thinking / 非 openai 下游路径回归无异常。

## 来源

- commit `14a3b07`（`fix(transformers): 打通 pi thinking 签名经 OpenAI 流的回传闭环`），分支 `fix/thinking-signature-passthrough`；双审 + 应修补丁已过。
- 涉及文件：`src/server/transformers/shared/chatFormatsCore.ts`、`src/server/transformers/openai/chat/proxyStream.ts`、`src/server/transformers/anthropic/messages/conversion.ts` 及对应测试。
