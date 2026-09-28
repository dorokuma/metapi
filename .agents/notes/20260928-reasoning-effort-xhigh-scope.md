---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: transformers
---

# reasoning_effort=xhigh 支持的范围边界与遗留观察（canonical 层）

## 一句话结论

canonical 层（`CanonicalReasoningEffort` 联合类型 + `normalizeReasoningEffort`）新增接受 `reasoning_effort=xhigh`，并沿 OpenAI chat/responses 链路原样透传上游；Anthropic 与 Gemini 表面维持现状（Anthropic 在 adaptive 思考下对白名单外 effort 返回 400、非 adaptive 下静默忽略；Gemini 未知档位归一为 medium）——经双审与用户评估，本轮有意不动这两个表面，遗留观察项见「来源」。

## 背景

- 动机：下游平台与 Qwen 系模型对外契约接受 `reasoning_effort` 的 low/medium/xhigh 三档；metapi 此前白名单为 none/low/medium/high/max，`xhigh` 在归一阶段被静默丢弃，该档位无法透传。
- 改动面：`src/server/transformers/canonical/types.ts`（联合类型追加 `'xhigh'`）与 `reasoning.ts`（`normalizeReasoningEffort` switch 增加 `case 'xhigh'`）；出站回写（`openAiRequestBridge` 直接赋值 `body.reasoning_effort`）与入站（openai chat/responses 不做值域校验）经审查确认无需改动。
- 测试：`reasoning.test.ts` 新增「xhigh 原样保留」用例；canonical 目录 25/25、transformers 全目录 451/451、`repo:drift-check` 0 违规。

## 决策

1. canonical 层放行 `xhigh`，OpenAI 链路端到端透传；未知值仍按原语义丢弃（`default: undefined`）。
2. 范围边界（本轮裁决）：Anthropic/Gemini 表面不随之扩展。
   - Anthropic 入站校验（`anthropic/messages/conversion.ts` 的 `VALID_ANTHROPIC_EFFORTS`）在 adaptive 思考下对白名单外 effort 返回 400 `invalid_request_error`；非 adaptive 时静默忽略；出站转换对白名单外值不映射。
   - Gemini 入站删除未知 `thinkingLevel`、归一 `medium`（`gemini/generate-content/inbound.ts` / `convert.ts`）。
   - 以上均为存量行为（本改动前后一致，非本次引入）；「Claude 表面是否接受非 Anthropic 词汇表的 effort 值、各出站方向如何映射」属独立设计决策，需另行立项。

## 被放弃的方案（必填）

- 方案 A：本轮一并把 Anthropic（及 Gemini）表面放行 xhigh（oracle 提交前复核主张）。未采纳理由：该行为系存量、本改动未触碰；「放行」并非单点改动——入站白名单、出站映射、上游契约三层需各自定语义，且会改动 Claude 表面的对外校验契约，属需要拍板的范围取舍；用户裁决为「维持范围、记录遗留、照常提交」。
- 方案 B：canonical 放行但不作任何留档。未采纳：Anthropic 400 与 Gemini 降级同本改动的组合效应需留档供后续检索。

## 来源

- reviewer：PASS（独立复跑 canonical 25/25、transformers 451/451、`repo:drift-check` 0；核验基线 TS2339 与本次无关）。
- oracle：REQUEST-CHANGES（主张 Anthropic 侧一并放行；事实核实属实但均系存量行为）。
- 用户裁决：维持范围、记录遗留、照常提交（豁免记录见「被放弃的方案」）。
- 遗留观察项：
  1. Anthropic 表面 `xhigh` 语义（入站 400 / 出站不映射）与 Gemini 降级——将来需要时单独设计。
  2. 可选测试增强：`reasoning.test.ts` 可补「大写/带空白」变体用例（reviewer consider，非阻断）。
  3. 基线观察：`src/server/index.ts:271,275` 两条 TS2339（@fastify/static 升级提交 `98942bd0` 遗留），与本改动无关，值得单独跟进。
