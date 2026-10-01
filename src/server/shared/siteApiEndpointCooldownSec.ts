/**
 * 站点 API 端点（`site_api_endpoints`）失败冷却时长。
 *
 * 事故背景：边缘返回的 HTML 429 曾被判成端点级可重试失败并写入端点冷却；
 * 「可重试」与「触发端点冷却」拆分后仍需要一条冷却时长，故从写死的 5 分钟
 * 改为可配置项 `site_api_endpoint_cooldown_sec`（默认 60 秒）。
 * 归一化口径与 `normalizeTokenRouterFailureCooldownMaxSec` 一致：
 * 非法值返回 null（调用方各自决定「保留旧值」或「回落默认值」），合法值夹在 [1, ceiling]。
 */
export const SITE_API_ENDPOINT_COOLDOWN_SEC_DEFAULT = 60;
export const SITE_API_ENDPOINT_COOLDOWN_SEC_CEILING = 60 * 60;

export function normalizeSiteApiEndpointCooldownSec(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(
    SITE_API_ENDPOINT_COOLDOWN_SEC_CEILING,
    Math.max(1, Math.trunc(parsed)),
  );
}
