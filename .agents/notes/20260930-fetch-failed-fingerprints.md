---
status: active
superseded_by: ""
supersedes: ""
模块: "services, proxy-core, docs"
---
# `fetch failed` 指纹表与生产归因（E1~E6 实测）

## 一句话结论
`TypeError: fetch failed` 只是一个统一外壳，真实原因全在 `err.cause`：对端 FIN → `UND_ERR_SOCKET / other side closed`，对端 RST → `ECONNRESET`（errno −104, syscall read），链路静默黑洞 → `UND_ERR_HEADERS_TIMEOUT`（实测 ≈300 s，undici 默认 headersTimeout），响应中途断流是 `TypeError: terminated`（不是 fetch failed），客户端自身超时是 `DOMException: TimeoutError`（不是 fetch failed）；生产真实 cause 最可能是「请求在途（含响应期间）连接被对端或中间设备断开」，而非「复用空闲死连接」——后者在本仓 undici 默认配置下几乎不可能（默认 `keepAliveTimeout=4s`，60 s 以上空闲必然新连接）。

## 背景
一次稀有的上游 429（边缘返回的 HTML 页，非应用层配额响应）被判成端点级可重试失败并写入 5 分钟端点冷却；站点只有 1 个端点，于是「换端点重试」退化成「拉黑唯一端点」，全站秒回 503「No available channels for this model」，proxy_logs 无记录；窗口内的重试全被 503 挡在门口、不产生失败记录，窗口一过期客户端的下一次重试又拿到同一个边缘 429 并重新写入 5 分钟冷却，事故无法自愈。修这条链路（端点/通道冷却策略切片 2）需要先确定：日志里的 `fetch failed` 到底对应哪些真实网络事件，以及「连接被复用后已死」是不是高频根因。本记录是该实验（E1/E2/E3/E4/E5/E6）的结论文档。

## 决策

### 1. `fetch failed` 指纹表（本机确定性复现，`err.cause` 实测）

| 真实原因 | `err.name` / message | `err.cause.code` | `err.cause.message` | 耗时量级 |
|---|---|---|---|---|
| 请求**在途**时对端发 FIN | `TypeError: fetch failed` | `UND_ERR_SOCKET` | `other side closed` | 毫秒级 |
| 请求**在途**时对端发 RST | `TypeError: fetch failed` | `ECONNRESET`（errno `-104`，syscall `read`） | `read ECONNRESET` | 毫秒级 |
| 链路静默黑洞（无 FIN/RST，写入后无任何响应） | `TypeError: fetch failed` | `UND_ERR_HEADERS_TIMEOUT` | `Headers Timeout Error` | **300 771 ms**（= undici 默认 headersTimeout 300 s） |
| **响应中途**断流（已收到响应头，body 中断） | `TypeError: terminated`（**不是** `fetch failed`） | `UND_ERR_SOCKET` | `other side closed` | 百毫秒级 |
| 连接被拒 | `TypeError: fetch failed` | `ECONNREFUSED` | `connect ECONNREFUSED <ip:port>` | 毫秒级 |
| 客户端自身超时（= metapi firstByteTimeout） | `DOMException: TimeoutError`（**不是** `fetch failed`） | —（code 23） | `The operation was aborted due to timeout` | 等于设定值 |

- GET 与 POST+8 KB body 的指纹一致（不因请求体而分叉）。
- **用耗时二分「静默黑洞」与其余情形**：静默黑洞没有 FIN/RST，客户端只能等自己的 headersTimeout，实测稳定落在 ≈300 s（undici 默认值）这一档；其余情形（FIN/RST/连接被拒/客户端超时）都在毫秒级～设定值级完成，且响应中途断流会以 `terminated` + 已收到状态码与其它情形区分。因此「耗时 ≈300 s 且 cause 为 `UND_ERR_HEADERS_TIMEOUT`」= 链路静默丢流；「毫秒级 `UND_ERR_SOCKET`/`ECONNRESET`」= 对端主动断开在途连接。
- 经 metapi 切片 1 的 `formatErrorCause` 渲染后的真实日志形态（E6，用真实捕获的错误对象喂给该函数）：`fetch failed (cause: UND_ERR_SOCKET other side closed)`、`fetch failed (cause: -104 read ECONNRESET)`、`fetch failed (cause: UND_ERR_HEADERS_TIMEOUT Headers Timeout Error)`、`terminated (cause: UND_ERR_SOCKET other side closed)`、`fetch failed (cause: -111 connect ECONNREFUSED 127.0.0.1:36289)`。

### 2. 判定与依据强度
- **最可能的 cause（推论，中）**：请求在途（含响应期间）连接被对端或中间设备断开——上游/LB 重启摘节点、上游按自身超时 RST 在途连接、CGNAT/防火墙踢长连。LLM 长响应把「在途窗口」放大到数十秒，使这类断开从低频变成高频根因。「指纹映射 / 业务 5xx 不伪装成 fetch failed / 默认无连接复用」三条是实测（强）；生产环境的具体 cause 属推论（中，因为不能在生产上复现或注入）。
- 支撑实测（E2）：业务 500 50/50 全部 resolve 且 `status===500`，**0 次** `fetch failed`；真实上游 401×26 + 429×24，**0 次** `fetch failed`——即上游返回的 5xx/4xx 不会伪装成网络失败。只有注入 50% RST 时才 25/25 全部 `fetch failed(ECONNRESET)`。
- 下一步定论只需一条生产样本：从生产侧取一条真实 `fetch failed`（含 `cause.code` 与耗时）与本表比对即可。

### 3. 已排除的负结论（实测）
- **「复用空闲死连接」假设不成立**：metapi 使用 undici 全局默认 dispatcher，`keepAliveTimeout=4s` 且确实执行——实测响应后约 4005 ms 客户端主动关 socket（把 keepAlive 设为 1000 ms → 1001 ms 关闭；设为 600000 ms → 不关闭）。因此 **60 s 以上空闲必然新建连接**，跨 300 s 空闲强制复用（keepAlive=600 s 的 arm）20/20 成功。E1 对照：默认 arm 每轮（60 s×10、120 s×5、300 s×5）20/20 成功、复用 0 / 新建 20（每次含 TLS 握手，p50 854 ms）；强制 keepAlive=600 s 的 arm 20/20 成功、复用 20（跨 300 s 空闲复用同一条 TCP，仍 440 ms 返回）。
- **竞态实验（E5）**：请求恰落在对端关闭时刻（Δ=0/1/2/5/10/20/50/100/200 ms × 2 模式 × 5 次）**90/90 成功、0 次复用死连接**。
- 一处自纠（记录偏差用的陷阱）：本机 Node http server 会回 `Keep-Alive: timeout=600` 覆盖客户端设置，导致最初误判「keepAliveTimeout 不生效」；改用裸 TCP 服务复测才得到 4005 ms / 1001 ms / 不关闭的正确结论（相关源码位置 `client-h1.js:551-563`）。

### 4. 与本次冷却策略改动的关系
指纹表解释了为什么「429/4xx 不得拉黑端点」是必要的：429 是应用层/边缘的显式响应（可重试、应轮换），与「网络在途被断开」是两类事件；把前者写进端点冷却，等于让唯一端点自我拉黑。反过来，网络类失败（`UND_ERR_SOCKET`/`ECONNRESET`/`UND_ERR_HEADERS_TIMEOUT`）仍保留端点冷却语义，但冷却期内的重复失败不再续期窗口。

同源的**成员级**遗漏已在本次切片一并修复：oauth 路由单元成员（`oauth_route_unit_members`）的成员级冷却此前会无条件重写 `cooldownUntil`，现已与端点级/通道级同口径——成员已在冷却中（`cooldownUntil > nowIso`）时，冷却期内到账的失败只更新 `failCount`/`lastFailAt` 等观测字段并原样复用已有窗口；不在冷却中时保持原行为（round robin 阶梯与 fibonacci 递增不变），配额型分支（`shortWindowLimitCooldownUntil` / `USAGE_LIMIT_RATE_LIMIT_PATTERNS`）语义不变。回归测试：`src/server/services/tokenRouter.oauth-route-units.test.ts` 的「keeps the existing member cooldown when a failure lands during member cooldown」。

## 被放弃的方案
- **不实验、直接按 `fetch failed` 文案猜 cause**：本表证明同一文案至少对应 4 种互斥原因，猜必然误判（例如把 300 s 静默黑洞当成对端 RST）。
- **只测无鉴权上游就下结论**：无鉴权请求在上游很快 401/429，测不到「长响应放大在途窗口」这一关键变量。该缺口已由 E4 补齐（真实鉴权直连 55 次全 200，加生产 5521 例流式历史基线，见遗留），首字节超时的结论按实测数字给出，不再靠无鉴权替代观测推断。
- **沿用「空闲连接被复用后已死」的解释**：与 `keepAliveTimeout=4s` 的实测行为直接冲突，且竞态实验 90/90 成功，证据不支持。

## 遗留
- **E4 已完成（真实鉴权长尾已取到；结论：不设首字节超时）**：凭据取自 metapi 生产配置（只读 `hub.db` 的 `accounts.api_token`），直连 `https://api.cline.bot/api/v1/chat/completions`（Bearer 鉴权；上游模型名与路由别名一致 `cline-pass/deepseek-v4.1-flash`，无映射）。**55 次请求全部 HTTP 200，0 个 401/403/429/超时**：非流式 25 例 TTFB p50/p90/p95/max = 1197/1445/1494/1650 ms、总时长 1403/1611/1651/1652 ms；流式 30 例（小请求 24 + ≈30k tokens 大上下文 6）TTFB p50/p90/p95/max = 836/980/1114/1827 ms、总时长 1344/1847/2056/2137 ms，其中流式大上下文 6 例 TTFB p50/p90/max = 1254/1993/1993 ms。生产历史（`proxy_logs` route 1377，5521 例流式，prompt p50≈96k tokens）TTFB p50/p90/p95/p99/max = 2371/3229/3543/5100/199432 ms，其中 >60s 4 例（0.072%）、>120s 2 例（0.036%）、>255s 0 例；那 4 例均为 HTTP 200、`retry_count=0`、大上下文（49k/183k/85k/116k tokens）。**要点：120s 会误杀 2 例最终成功的慢请求，255s 历史零误杀；但我们不据此设置首字节超时**——静默黑洞已被 undici 自身 300s `headersTimeout` 兜住，设 255s 只多省 45 秒却引入新的失败路径，故 `firstByteTimeout` 维持 0（此前把 60s 写进生产又回滚，正因为它会把本来成功的慢请求变成 408）。数字来源：`/tmp/metapi-e4/results/summary.json`、`/tmp/metapi-e4/results/production-baseline.json`、`/tmp/metapi-e4/README.md`（与本任务书给出的数字一致）。上一轮（E3 同批）因无上游凭据而做的替代观测（无鉴权 POST 401/429、`httpbin delay/3`、`delay/8`、ALPN=h2）仅作旁证，不再作为「是否需要首字节超时」的依据。
- **遗留 G（端点冷却残留时间戳导致 UI 陈旧展示）**：端点冷却从「非重试失败即清空」改成「保留已有值」后，库里可能留下已过期但非 NULL 的 `site_api_endpoints.cooldown_until` 历史时间戳；而 `src/web/pages/Sites.tsx` 只要 `cooldownUntil` 存在就渲染（`Sites.tsx:1520` 的 `冷却至 {formatDateTimeLocal(...)}`），UI 可能出现「冷却至 <过去时间>」的陈旧展示。展示层是否改为「仅当 `cooldownUntil` > 当前时间才渲染」属独立小改，未在本次切片处理。
- **遗留 H（端点冷却上限是默认假设值）**：端点冷却上限 3600s（`SITE_API_ENDPOINT_COOLDOWN_SEC_CEILING`）是本次的默认假设值，仓内没有同类先例可参照；如需调整，只改 `src/server/shared/siteApiEndpointCooldownSec.ts` 的该常量，归一化口径（非法值返回 null、合法值夹在 [1, ceiling]）会自动跟随。
- **遗留 F（切片 1 配套问题）**：`formatErrorCause` 的去重规则会吞掉与 message 重复的 code token（真实样本：`ECONNRESET` 只剩 `-104 read ECONNRESET`，原样 code 不再出现）。`NETWORK_FAILURE_PATTERNS` 仍能命中，但按 `code` 精确匹配的消费方会看不到原样 code；后续可考虑保留原始 code 字段（独立立案，不在切片 1/2 范围内）。
- **未覆盖边界**：本表来自本机确定性复现（loopback/受控服务），未在生产链路上抓过真实样本；HTTP/2（h2）路径、代理（CONNECT）路径下的指纹未逐项复测。冷却策略侧（切片 2）的「冷却期内到账的失败不续期」目前只由单元测试覆盖——端点级 `src/server/services/siteApiEndpointService.test.ts`、通道级 `src/server/services/tokenRouter.cache.test.ts`、oauth 成员级 `src/server/services/tokenRouter.oauth-route-units.test.ts`——生产链路上还没有真实流量验证（事故复现所需的「唯一端点被拉黑 + 客户端持续重试」场景未在线上重演）。
- **遗留 I（配额型 429 窗口仍会「越重试越久」）**：通道级与成员级配额分支（`shortWindowLimitCooldownUntil`，命中 `USAGE_LIMIT_RATE_LIMIT_PATTERNS` 时平推 5 分钟，`SHORT_WINDOW_LIMIT_COOLDOWN_MS = 5 * 60 * 1000`）每次失败都会把窗口重算为 `now + 5min`。**续期的前提是「冷却期内有失败到账」，而冷却中的通道/成员在【选择期已被排除】**，因此**只有并发在途重叠**才可能续期——首发的失败请求还在途、尚未写入冷却时并发到达的请求也失败，二者各自重算窗口。原表述「客户端持续重试」并不准确：客户端重试会在门口被 503「No available channels for this model」直接挡掉，不产生失败记录，根本走不到写冷却的代码；事故里看到的「越重试越久」实际是**窗口过期后下一次重试重新拉黑**（重新写一个 5 分钟窗口），不是窗口内的续期。生产实测 155 条 429 中有 65 条命中该 pattern（如 `Rate limit exceeded`、`您已达到请求数限制`、`You have reached the request limit`），而本次事故那条边缘 HTML 429（`HTTP 429: 429`）不命中、走 15s×fib。语义上该分支代表「配额确实未恢复」，且上游给出 reset 提示时会用提示，故本次未改；如需处理另立一片。
- **遗留 I 的不对称（配额型分支不受「保留已有窗口」约束）**：本次「冷却期内到账的失败复用已有窗口」只约束 fib 分支与 round_robin 阶梯分支；配额型分支（`shortWindowLimitCooldownUntil`）在 `coolingDown` 判断**之前无条件赋值**（`cooldownUntil = shortWindowLimitCooldownUntil`），因此它**既能续期**（`now + 5 分钟`，或上游 reset 提示 / oauth stored `lastLimitResetAt`），**也能把已有更长窗口缩短**（例如已被阶梯推到 24h 档的通道，一条命中 pattern 的 429 会把它改写回 5 分钟）。这是有意保留的语义：配额型 429 代表「配额确实未恢复」，按上游窗口重算比沿用旧阶梯值更接近事实。
- **遗留 J（端点排序可考虑按 `lastFailedAt` 降权）**：当前端点选择只按 `sortOrder` / `lastSelectedAt`，失败不更新 `lastSelectedAt`，故刚被 429 的端点每次仍会被优先选中；若要保留轮换收益又不拉黑端点，正解是降权而非冷却。
- **遗留 K（`triggersEndpointCooldown` 为 false 时保留已有端点冷却 ⇒ 4xx 不再提前解除已有冷却）**：端点冷却写入从「`retryable` 即写新窗口、否则置 NULL」改成「保留已有值」后，`triggersEndpointCooldown === false` 的失败（认证/校验类 4xx、非重试 5xx 等）会把已有 `site_api_endpoints.cooldown_until` **原样写回，包括已过期的时间戳**，而不是清空。取舍：好处是 4xx 不能把一个刚被网络类失败写冷却的端点「顺手放行」（否则 4xx 抖动可以绕过冷却）；代价是 **4xx 不再提前解除已有端点冷却**——4xx 期间该端点继续零流量，最多多等一个已有窗口（当前上限 3600s，见遗留 H）。若要恢复「4xx 即解除」，需显式区分「清空」与「保留」两条路径；与遗留 G（已过期时间戳会被 UI 渲染成「冷却至 <过去时间>」）是同一处改动的两个侧面。代码位置：`src/server/services/siteApiEndpointService.ts:382-391`。
- 原始实验脚本与 NDJSON 落在 `/tmp/metapi-netlab`（已按龄回收，写作本记录时目录已不存在）；本记录内容来自该轮 worker 的结论文档与回报原文，非二次推测。

## 来源
- 实验：`E1`（真实上游空闲复用/强 keepAlive 对照）、`E2`（并发与业务 5xx 伪装性）、`E3`（指纹表）、`E4`（真实鉴权直连首字节/总时长长尾 + 生产历史基线，产物在 `/tmp/metapi-e4`：`README.md`、`results/summary.json`、`results/production-baseline.json`）、`E5`（关闭竞态）、`E6`（经 metapi `formatErrorCause` 渲染），E1/E2/E3/E5/E6 产物原在 `/tmp/metapi-netlab`（`REPORT.md` / `RESULTS.md` / `results/*.ndjson`，已按龄回收）。
- 代码侧配套：`src/server/services/errorChain.ts`（切片 1 `formatErrorCause`）；`src/server/services/siteApiEndpointService.ts` 与 `src/server/services/tokenRouter.ts`（切片 2 冷却策略，见 `.agents/notes/20260929-error-cause-forensics.md` 与本记录互为配套）。
- 本记录与切片 1 的 errorChain 取证互为配套：切片 1 负责把 `cause` 链摊平进日志与失败分类，本记录负责解释这些 `cause` 各自的真实含义与依据强度。
