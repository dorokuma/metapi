/**
 * Gate for upstream-provider detection: master switch, host suffix allowlist
 * and request-level sampling. All three must pass before any payload is
 * parsed, so disabled/non-matching traffic costs nothing on the hot path.
 *
 * Host matching deliberately uses the site URL host suffix (not
 * `sites.platform`), so enabling `cline.bot` never turns on collection for
 * every OpenAI-compatible site.
 */

import { config } from '../../config.js';

function normalizePlatformSuffix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
  const withoutWildcard = authority.replace(/^\*?\.?/, '');
  const withoutPort = withoutWildcard.replace(/:\d+$/, '');
  const normalized = withoutPort.toLowerCase().replace(/\.+$/, '');
  return normalized || null;
}

export function normalizeUpstreamProviderDetectPlatforms(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of rawItems) {
    const suffix = normalizePlatformSuffix(item);
    if (!suffix || seen.has(suffix)) continue;
    seen.add(suffix);
    result.push(suffix);
  }
  return result;
}

export function extractUpstreamProviderDetectHostname(siteUrl: unknown): string | null {
  if (typeof siteUrl !== 'string') return null;
  const raw = siteUrl.trim();
  if (!raw) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const hostname = new URL(withScheme).hostname.trim().toLowerCase();
    const normalized = hostname.replace(/\.+$/, '');
    return normalized || null;
  } catch {
    return null;
  }
}

/** `api.cline.bot` matches suffix `cline.bot`; boundary-safe (no `evilcline.bot`). */
export function matchUpstreamProviderDetectHost(siteUrl: unknown, platforms: readonly unknown[]): boolean {
  if (!Array.isArray(platforms) || platforms.length === 0) return false;
  const hostname = extractUpstreamProviderDetectHostname(siteUrl);
  if (!hostname) return false;

  return platforms.some((platform) => {
    const suffix = normalizePlatformSuffix(platform);
    if (!suffix) return false;
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
}

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
  siteUrl?: string | null;
}): boolean {
  if (config.upstreamProviderDetectEnabled !== true) return false;

  const platforms = config.upstreamProviderDetectPlatforms;
  if (!Array.isArray(platforms) || platforms.length === 0) return false;
  if (!matchUpstreamProviderDetectHost(input.siteUrl, platforms)) return false;

  return resolveUpstreamProviderDetectSampleHit(input.requestId, config.upstreamProviderDetectSampleRate);
}
