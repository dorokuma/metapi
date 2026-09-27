---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "server" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# new-api 站点 token 级模型发现合并用户级模型列表（非探活）

## 一句话结论

new-api 站点「token 实际可调用但 `/v1/models` 不暴露」的模型（经 `/api/user/models` 用户级列表发现），每账号每轮 refresh 合并一次入该 token 的可用模型并参与路由。机制是平台级（覆盖 new-api 全族），非站点特判；只用列表级接口，禁止逐模型探活 / 模型试调。

## 背景

- pangmao 站点案例：某 token 走 token 级 `/v1/models` 只发现 59/61 个模型，而同一账号走 `/api/user/models`（用户级）能列出 199 个，差集里包含 `Qwen3.8-27B`——该模型用此 token 可正常调通，但因不在 `/v1/models` 里，`token_model_availability` 没有它的记录，路由永远选不到它（可调不可路由）。
- 根因：new-api 的 token 级 `/v1/models` 只回「该 token 当前已绑定 / 已暴露」的模型，而用户级 `/api/user/models` 回「该账号可用」的全量模型。token 能调但 token 级列表不暴露的模型，落在两者差集里。
- 硬约束：上游对「逐模型试调 / 探活」有封禁风险，不能把试调当作补全手段。

## 决策

- **只用列表级接口**：补全模型一律走 `/api/user/models` 用户级列表接口，一次拿全，不触发对单一模型的高频试调；禁止逐模型探活 / 模型试调（上游封禁风险硬约束）。
- **平台判断收敛在适配器，服务层保持通用**：
  - `PlatformAdapter` 新增 `getUserLevelModels(baseUrl, accessToken, platformUserId?): Promise<string[] | null>` 接口（`base.ts:233`）。
  - `Base` 默认返回 `null`（= 平台不支持用户级发现），`null` 语义即「无此能力」，服务层据此不合并。
  - `NewApiAdapter` override（`newApi.ts:1313`），首行 `if (this.platformName !== 'new-api') return null;` 守卫：只有原生 new-api 走 `/api/user/models`（`newApi.ts:1319`）；继承子类（如 AnyRouter）保持 Base 的 `null`。
  - 服务层合并逻辑（`modelService.ts`）零平台判断：拿到 `accountUserLevelModels` 后只做 `length > 0 ? normalizeModels(tokenModels.concat(userLevel)) : tokenModels`，不 `if platform === 'new-api'`——平台差异全部由适配器的「`null` / 列表」表达，服务层不感知具体平台。
- **继承子类保守返回 `null`**：AnyRouter 等子类未验证其 `/api/user/models` 行为，安全默认不合并（继承 Base 的 `null`），避免把不适用的列表灌进 token 模型。
- **去重防唯一键冲突**：合并用 `normalizeModels` 去重（`modelService.ts:1309`），保证 `(token_id, model_name)` 唯一键不被脏上游数据（重复 / 大小写 / 空白变体）打穿。
- **失败静默降级、不记失败**：用户级发现超时 / 异常时 `console.warn`（`modelService.ts:1277`）并把列表置 `[]`，当轮退化为仅 token 级发现结果；**不 `recordFailure`**——对齐既有静默降级先例（该路径是补充性数据，失败不应污染账号失败计数 / 告警）。

## 被放弃的方案（必填）

- **逐模型探活预筛**（对差集模型逐个试调确认可用性）：上游封禁风险硬约束，直接否决；列表接口已足够，无需试调。
- **静态白名单**（把「已知会被 `/v1/models` 漏掉」的模型名写死）：维护成本高、随上游变动失准，且违背「单一事实来源」。
- **启用 probe / 探活机制**：与既有「禁用 probe」策略冲突，同样触发上游封禁风险。
- **在 `modelService` 内做平台分支**（`if platform === 'new-api'` 再拉用户级）：把平台特判泄漏进服务层，未来新增平台要改服务层；收敛到适配器的 `getUserLevelModels`（Base `null` + 子类 override）后服务层保持通用。

## 来源

- 适配器接口与默认值：`src/server/services/platforms/base.ts:233`（`getUserLevelModels` → `null`）
- new-api override 与守卫：`src/server/services/platforms/newApi.ts:1313`（`platformName !== 'new-api'` 守卫）、`:1319`（`/api/user/models`）
- 服务层合并：`src/server/services/modelService.ts:1267`（`accountUserLevelModels`，每账号每轮 refresh 取一次）、`:1277`（`console.warn` 降级）、`:1309`（`normalizeModels` 合并入 `persistedModels`）
- 失败不计记录对照：`modelService.ts` token 级 / 凭据级发现失败走 `recordFailure`（`:1195` / `:1248` / `:1298`），用户级失败只 `console.warn` 不 `recordFailure`
- 测试：`src/server/services/modelService.discovery.test.ts`
- 生效范围与上线验证：覆盖本库全部 13 个 new-api 站点；上线 1.4.5（`CHANGELOG.md`「[1.4.5]」条目）后验证 token55 合并后 = 199 且含 `Qwen3.8-27B`，路由通道出现该模型，探测（probe）开关保持关闭
