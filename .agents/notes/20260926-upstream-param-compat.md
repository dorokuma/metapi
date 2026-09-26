---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "services" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 严格校验上游参数兼容层（站点级剥离 + NIM 400 自愈）

## 一句话结论

为严格校验上游加两层参数兼容：已知站点在出站前按站点/模型/端点剥掉指定参数（零额外往返），
未知站点在 NIM 风格「Unsupported parameter(s): …」400 上同端点剥掉点名参数重发一次。
两层共用一份结构键拒绝表，门禁 = 总开关与自愈开关同时为真，两开关默认关、不自动激活、无 UI。

## 背景

site 9 gugugaga 的 chat 400 文案是 `Validation: Unsupported parameter(s): prompt_cache_key, prompt_cache_retention`；
同参数在其他站点 200，`/v1/messages` 能 200 是因为转换层丢掉了 `prompt_cache_key`。
既有 `proxyRetryPolicy` 把 `/validation/i` 归为不可通道重试，kimi 那次救回是跨协议降级，不是通道重试。

## 决策

- **配置形态对齐上游钉选**：新 settings 三键 `upstream_param_compat_enabled` / `_rules` / `_self_heal_enabled`，
  双形态（存储原始形状；config 编译形态带预编译 matcher），热生效五路径（config 初始化 + env、hydration、
  import switch、PUT 预校验 + 落库、GET 回显）。不扩展 payload filter，不硬编码 site 9，不靠 env-only。
- **(a) 剥离点在最终出站体上**：`upstreamRequestBuilder.ts` 的 chat / responses（codex 与默认路径共用）/
  messages 两处 return，顺序固定为「协议整形 → payload 规则 → 站点剥离 → 钉选」。只剥 `openaiBody`
  会漏掉 responses 透传（走 `responsesOriginalBody`）；放在 payload 规则之前会被 override 把键加回来。
  未命中或无键可删返回**原引用**。(a) 只看总开关，不看自愈开关；不传 `siteId` 的调用点（WS / 测活 /
  gemini 面）自然不剥。
- **(b) 自愈挂在 `executeEndpointFlow` 内**：`if (input.tryRecover)` 之内、surface recover 之后、
  `onAttemptFailure` 之前，且只用 `input.tryRecover` 存在性做 guard（rerank 不传 → 无 (b)）。
  第二次同样走 `fetchWithObservedFirstByte`（带 signal 交同一 `dispatchRequest`，保留站点代理与
  codex 请求头 / 会话字段），每个端点尝试最多一次，不再第三次 dispatch。
  三条成功路径（首次 2xx / 既有 recover / 自愈）共用局部 helper `returnAttemptSuccess`；
  自愈失败先更新 `baseContext.request/response/rawErrText/recoverApplied` 再 fall through。
- **门禁 = 总开关与自愈开关同时为真**：关总开关则 (a) 不剥、(b) 不自愈；只关自愈开关则 (a) 仍剥、(b) 不发。
  回退两档都热生效、不需要重启、不必删行。
- **(a) 与 (b) 共用同一份结构键拒绝表**（17 项，含 `system`）+ 原型污染键（`__proto__` / `constructor` /
  `prototype`）+ 标识符白名单。三层都验：PUT 严格校验 400、宽松归一（env / hydration / import）整条丢弃、
  热路径 `strip` 逐名再验。归一语义只有一种：**非法项 = 整条规则不剥离**。
- **上限语义**：PUT 32/64 超限整次三键块 400（三键原子、不半应用）；宽松路径超 32 整条丢弃、超 64 丢弃尾部。
- **`model` 大小写敏感**（`GLM-5.3` 不匹配 `glm-5.3`，编译期一次 `RegExp`，热路径不 `new RegExp`）；
  拿不准写 `*`。`endpoints` 省略 = `['chat','responses']`，messages 必须显式写入才生效。
- **自愈失败后的分类看第二次响应**（有意的行为变更）：第二次 5xx 可换通道，第二次 403 会走既有 oauth hint，
  第二次仍 400+`unsupported` 仍可降级；第二次首字节超时按普通 408 失败分类
  （`shouldAbortSameSiteEndpointFallback` 为 true → break 换通道，不再 `continue` 到同站下一端点）。
  第一次 400 本身不单独记通道失败。

### 操作员须知

- 规则不支持剥离 `temperature` / `top_p` / `n` / `stop` / `max_tokens` / `response_format` / `instructions` /
  `system` / `model` / `messages` 一类结构键。要剥这类键请改用既有 payload 规则（filter）。这是安全优先的
  有意收口，不是配置漏项。
- `model` 通配大小写敏感，拿不准写 `*`。
- 不要给依赖 `prompt_cache_key` 的 codex 站点配规则；WS 路径既无 (a) 也无 (b)，配了也不生效。
- 激活（PUT 三键）由主代理经用户批准后执行；代码默认关，部署本身不激活，旧 400 会原样透传。

## 被放弃的方案（必填）

- **改 `proxyRetryPolicy.ts` 的 `/validation/i` 为可重试**：否决。`handleUpstreamFailure` 在判重试之前就已
  `recordFailure` + 写失败日志（`sharedSurface.ts`），`:633` 是外层换通道不是同通道再发；改成可重试会冷却健康通道、
  留失败日志、可能打到别的站点，且不会剥参数。
- **只改两个 surface 的 `tryRecover` 包装**：否决。`geminiSurface` 直接传 `endpointStrategy.tryRecover`，
  只改两处会漏掉 gemini 面的 (b)，要覆盖就得第三处包装、三处会漂；且首字节超时、成功钩子、失败前 `baseContext`
  更新都在 `endpointFlow`。
- **给 payload filter 加 `siteIds`**：否决。会改动 `payload_rules` 既有契约（校验、GET 形状、Settings UI、
  既有 filter 语义），并且仍然没有 `endpoints` 维度。反驳点只能是契约与端点维度，不是「引擎是模型×协议」。
- **自愈成功后把学到的参数写回 settings**：否决。请求路径改管理员配置，误解析会下毒，多进程不一致。不做。
- **代码里写死 site 9 / 只放 env / 一期做 Settings UI**：分别因 id 随环境变、不能热生效且导入回放接不上、
  正确性不依赖 UI 而否决。

## 风险与回退

- 坏规则剥多了：关总开关，(a)(b) 一起停；只关自愈开关则已知站点继续剥。结构键在三层都被拒绝。
- 第二次 5xx 会换通道并记失败、第二次 408 超时会中止同站后续端点再换通道：这两句是裁定过的行为变更，
  不能接受就关自愈开关，不能靠改 `proxyRetryPolicy` 偷偷抹掉。
- **`.text()` 纪律**：新目录 `src/server/services/upstreamParamCompat/` 与 `proxy-core/orchestration/` 都
  **不在 `repo:drift-check` 的 `body-read` 扫描范围内**（该规则只扫 `proxy-core/surfaces/`），所以
  「上游响应体一律用 `readRuntimeResponseText()`」这条纪律不能靠 drift-check 兜住，靠本笔记 + 评审清单人工看。
  存量 `chatEndpointStrategy.ts` / `routeCompatibility.ts` 的 `.text()` 本次不修、不扩散。

## 来源

- 设计稿（定稿）：`/tmp/param-compat-plan-v2.1-20260926.md`
- reviewer 放行 + 3 建议：`/tmp/param-compat-review-results-20260926.md`
- oracle 放行 + S1/S2/S3：`/tmp/param-compat-oracle-report-20260926.md`
- v2 复核（MUST-1 / O-A~O-F）：`/tmp/param-compat-v2-review-results-20260926.md`
- 排查证据（当数据）：`/tmp/glm53-triage-20260926.md`