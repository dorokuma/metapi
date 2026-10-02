/**
 * 失败驱动的冷却总开关（settings 键 `disable_failure_driven_cooldown`）。
 *
 * 背景：端点/通道的失败冷却是按失败次数合成的（端点窗口、weighted fibonacci 退避、
 * round_robin 冷却阶梯）。用户诉求原话是「我不想要冷却，无限打对我没什么坏处，我自己
 * 发现循环就停了，比硬等 60s 强太多」——即宁可把失败暴露出来自己观察，也不要被窗口
 * 硬挡。该开关只关「失败驱动」的冷却，**不动上游指令驱动的冷却**：
 * 配额/限流 reset hint（`shortWindowLimitCooldownUntil`，即 provider-directed 窗口）
 * 与由此派生的 provider-directed 冷却不受影响。
 *
 * 归一化口径与 `normalizeSiteApiEndpointCooldownSec` 一致：非布尔值返回 null
 * （调用方各自决定「保留旧值」或「回落默认值」），布尔值原样返回。
 * 默认 false = 完全保持既有行为（冷却照旧）。
 *
 * 覆盖范围（三层，均属「失败驱动」）：① 端点冷却窗口；② 通道/成员冷却窗口；
 * ③ 运行时熔断的候选排除（`tokenRouter.filterSiteRuntimeBrokenCandidatesByModel`，
 * 否则「多候选全熔断 ⇒ 候选清空」等价硬挡）。第三层只停硬挡，不停熔断状态的写入与清零。
 *
 * **读侧与写侧都要关**（决策 F，2026-10-01 追加）：只改写入点堵不住旧窗口——已经落库的
 * 失败驱动窗口仍会把请求硬挡到窗口过期（通道级上限 24h / 30min 两处阶梯），与「开关打开就
 * 不再被挡」的诉求矛盾。因此读侧（`tokenRouter.isOauthRouteUnitMemberCoolingDown` /
 * 通道级「冷却中」判定、`siteApiEndpointService.isEndpointCoolingDown`）在开关开启时
 * 忽略「失败驱动形状」的窗口（`shouldIgnoreFailureDrivenCooldownWindow`），窗口值仍留在
 * 库里做观测；写入点的既有语义（含「冷却中不推窗」）不改。
 */
export const DISABLE_FAILURE_DRIVEN_COOLDOWN_DEFAULT = false;

export function normalizeDisableFailureDrivenCooldown(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * 一条冷却状态行（`route_channels` / `oauth_route_unit_members`）的「失败计数三件套」。
 * 三列在两张表上同名同义，故共用这一份形状描述。
 */
export interface FailureCooldownCounters {
  failCount?: number | null;
  consecutiveFailCount?: number | null;
  cooldownLevel?: number | null;
}

/**
 * 「上游指令型窗口形状」判据：失败计数三件套全为 0。
 *
 * 依据（写入侧不变式，`tokenRouter.recordFailure` 是通道/成员冷却窗口的唯一写入点）：
 * - 配额/限流分支（`shortWindowLimitCooldownUntil` 非空，即 429 用量限制文案 +
 *   `parseCodexQuotaResetHint` 的 reset hint）⇒ `cooldownUntil` = 上游给的窗口，
 *   且 `failCount` / `consecutiveFailCount` / `cooldownLevel` **一律置 0**；
 * - 失败驱动分支（weighted fibonacci / round_robin 阶梯）⇒ `failCount = 旧值 + 1 ≥ 1`，
 *   三件套不可能全为 0。
 *
 * 与 `channelRecoveryProbeService.isProviderDirectedCooldown` 同一判据（那边再叠加
 * 「`cooldownUntil` 非空」）。调用方需自行判断 `cooldownUntil` 是否仍在未来。
 */
export function isProviderDirectedCooldownShape(counters: FailureCooldownCounters): boolean {
  return (counters.failCount ?? 0) <= 0
    && (counters.consecutiveFailCount ?? 0) <= 0
    && (counters.cooldownLevel ?? 0) <= 0;
}

/**
 * 读侧放行判定：开关开启时，只忽略**失败驱动形状**的冷却窗口，上游指令型窗口照旧挡人。
 *
 * - `switchDisabled === false`（默认）⇒ 恒返回 false，读侧逐字节等价于既有
 *   `!!cooldownUntil && cooldownUntil > nowIso`。
 * - `switchDisabled === true` ⇒ 失败驱动形状的窗口不再挡人（「从这一刻起我不被挡」），
 *   但窗口值照旧留在库里做观测，开关关回去即恢复旧行为（可回退）。
 *
 * 调用方负责先确认窗口仍在未来（本函数只看「形状」）。
 */
export function shouldIgnoreFailureDrivenCooldownWindow(
  counters: FailureCooldownCounters,
  switchDisabled: boolean,
): boolean {
  return switchDisabled && !isProviderDirectedCooldownShape(counters);
}
