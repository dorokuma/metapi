/**
 * Gate for upstream-provider detection: master switch, participating-site
 * selection and request-level sampling. All three must pass before any payload
 * is parsed, so disabled/non-selected traffic costs nothing on the hot path.
 *
 * Site selection deliberately matches `sites.id` (the proxy already knows the
 * selected site per attempt) instead of a host suffix: one site changing its
 * URL can never silently enable collection for another site that happens to
 * share the host, and an empty selection means "collect nothing".
 */

import { config } from '../../config.js';
import { isUpstreamProviderDetectSiteSelected } from './siteIds.js';

export function normalizeUpstreamProviderDetectSampleRate(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
}

/** FNV-1a 32-bit -> [0, 1); stable for the same request id. */
function hashToUnitInterval(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

export function resolveUpstreamProviderDetectSampleHit(requestId: unknown, sampleRate: unknown): boolean {
  const rate = normalizeUpstreamProviderDetectSampleRate(sampleRate);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const key = typeof requestId === 'string' && requestId.length > 0 ? requestId : '';
  return hashToUnitInterval(key) < rate;
}

export function shouldCollectUpstreamProviderObservation(input: {
  requestId?: string | null;
  siteId?: number | string | null;
}): boolean {
  if (config.upstreamProviderDetectEnabled !== true) return false;

  const siteIds = config.upstreamProviderDetectSiteIds;
  if (!Array.isArray(siteIds) || siteIds.length === 0) return false;
  if (!isUpstreamProviderDetectSiteSelected(input.siteId, siteIds)) return false;

  return resolveUpstreamProviderDetectSampleHit(input.requestId, config.upstreamProviderDetectSampleRate);
}
