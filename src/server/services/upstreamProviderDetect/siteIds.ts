/**
 * 「上游探测」参与站点的单一配置源。
 *
 * 配置只保存站点 id（settings 键 `upstream_provider_detect_site_ids`），不再保存
 * host 后缀：站点改名 / 换域名不影响已选站点，同一 host 上的多个站点也能逐个控制。
 * 默认空数组 = 不采集任何站点（即使总开关开启），门禁在请求热路径上只做集合命中。
 */

function normalizeSiteId(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const truncated = Math.trunc(value);
    return truncated > 0 ? truncated : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    const truncated = Math.trunc(numeric);
    return truncated > 0 ? truncated : null;
  }
  return null;
}

/**
 * 接受站点 id 数组 / JSON 数组 / 逗号分隔字符串，去重并丢弃非法项。
 * 返回按出现顺序排列的正整数 id 列表。
 */
export function normalizeUpstreamProviderDetectSiteIds(value: unknown): number[] {
  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === 'string'
      ? value.split(',')
      : (value === undefined || value === null ? [] : [value]));

  const seen = new Set<number>();
  const result: number[] = [];
  for (const item of rawItems) {
    const siteId = normalizeSiteId(item);
    if (siteId === null || seen.has(siteId)) continue;
    seen.add(siteId);
    result.push(siteId);
  }
  return result;
}

/** `siteId` 命中参与集合才返回 true；数字/数字字符串都接受，非法值一律不命中。 */
export function isUpstreamProviderDetectSiteSelected(
  siteId: unknown,
  siteIds: readonly unknown[],
): boolean {
  const normalized = normalizeSiteId(siteId);
  if (normalized === null || !Array.isArray(siteIds)) return false;
  return siteIds.some((candidate) => normalizeSiteId(candidate) === normalized);
}
