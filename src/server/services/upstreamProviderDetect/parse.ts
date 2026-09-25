/**
 * Cline gateway upstream-provider observation parser.
 *
 * This module is pure (no I/O, no config, no DB): it turns one already-parsed
 * JSON payload into an `UpstreamProviderObservation` summary, or `null` when
 * the payload carries no recognizable gateway routing information.
 *
 * Callers must keep the previous observation when the parser returns `null`
 * (intermediate stream frames, non-Cline gateways, malformed bodies, ...).
 *
 * Shape notes (verified against real Cline gateway responses):
 * - Non-stream responses are wrapped: `{ success, data }`, metadata lives at
 *   `data.choices[0].message.provider_metadata`.
 * - Stream responses are bare SSE chunks: metadata lives at
 *   `choices[].delta.provider_metadata` on one (not necessarily the last) frame.
 * - Costs come from two distinct places and must never be used to fill each
 *   other: `usage.{cost,gateway_cost,market_cost}` (numbers) and
 *   `provider_metadata.gateway.{cost,inferenceCost,generationId}` (strings).
 * - `clientSessionId` is Cline's own affinity session, not metapi's sticky key.
 */

export const UPSTREAM_PROVIDER_PARSER_ID = 'cline-gateway';
export const UPSTREAM_PROVIDER_PARSER_VERSION = 1;
export const UPSTREAM_PROVIDER_FALLBACKS_LIMIT = 64;

export type UpstreamProviderParserId = typeof UPSTREAM_PROVIDER_PARSER_ID;

export type UpstreamProviderAttemptProviderSummary = {
  provider: string | null;
  credentialType: string | null;
  statusCode: number | null;
  success: boolean | null;
};

export type UpstreamProviderModelAttemptSummary = {
  canonicalSlug: string | null;
  success: boolean | null;
  providerAttemptCount: number | null;
  /** Built from `modelAttempts[].providerAttempts` (the source field); `providers` is not read. */
  providers: UpstreamProviderAttemptProviderSummary[];
};

/**
 * Cost/text view of one payload. Kept separate from the routing observation so
 * the collector can stage routing and cost independently (B1): a final
 * usage-only frame (`choices: []`) still carries cost, while an earlier frame
 * may carry the routing metadata.
 */
export type UpstreamProviderUsageCostFields = {
  usageCost: number | null;
  usageGatewayCost: number | null;
  usageMarketCost: number | null;
  gatewayCostText: string | null;
  gatewayCostNumber: number | null;
  gatewayInferenceCostText: string | null;
  gatewayInferenceCostNumber: number | null;
  gatewayGenerationId: string | null;
};

export type UpstreamProviderObservation = {
  parserId: UpstreamProviderParserId;
  parserVersion: number;
  finalProvider: string;
  resolvedProvider: string | null;
  canonicalSlug: string | null;
  originalModelId: string | null;
  affinityOutcome: string | null;
  affinityPinnedProvider: string | null;
  clientSessionId: string | null;
  clientSessionIdSource: string | null;
  fallbacksAvailable: string[] | null;
  fallbackCount: number | null;
  modelAttemptsSummary: UpstreamProviderModelAttemptSummary[];
  modelAttemptCount: number | null;
  totalProviderAttemptCount: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  systemFingerprint: string | null;
  usageCost: number | null;
  usageGatewayCost: number | null;
  usageMarketCost: number | null;
  gatewayCostText: string | null;
  gatewayCostNumber: number | null;
  gatewayInferenceCostText: string | null;
  gatewayInferenceCostNumber: number | null;
  gatewayGenerationId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown> | null, key: string): boolean {
  return !!record && Object.prototype.hasOwnProperty.call(record, key);
}

function asTrimmedNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Finite number from a number or a numeric string; anything else is dropped.
 * String-number costs keep their raw text on the side (`gatewayCostText`), the
 * parsed number here is only a convenience view and never replaces the text.
 */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asInteger(value: unknown): number | null {
  const numeric = asFiniteNumber(value);
  return numeric == null ? null : Math.trunc(numeric);
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asCostText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asStringList(value: unknown, limit = UPSTREAM_PROVIDER_FALLBACKS_LIMIT): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result.length > 0 ? result : null;
}

/**
 * Resolves the object that carries `choices`/`usage`:
 * - `{ success: true, data: {...} }` -> `data` only (non-stream wrapped body)
 * - bare object (no `success` key) -> the object itself (stream chunk / bare body)
 * - `success` present but not `true`, or `data` not an object -> null
 */
function resolveContainer(payload: unknown): Record<string, unknown> | null {
  const root = isRecord(payload) ? payload : null;
  if (!root) return null;
  if (!hasOwn(root, 'success')) return root;
  if (root.success !== true) return null;
  return isRecord(root.data) ? root.data : null;
}

function resolveChoice(container: Record<string, unknown>): Record<string, unknown> | null {
  const choices = container.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const indexedChoice = choices.find((choice) => isRecord(choice) && choice.index === 0);
  const candidate = indexedChoice ?? choices[0];
  return isRecord(candidate) ? candidate : null;
}

/** Prefers `message.provider_metadata`, then `delta.provider_metadata`. */
function resolveProviderMetadata(choice: Record<string, unknown>): Record<string, unknown> | null {
  const message = isRecord(choice.message) ? choice.message : null;
  if (message && hasOwn(message, 'provider_metadata')) {
    return isRecord(message.provider_metadata) ? message.provider_metadata : null;
  }
  const delta = isRecord(choice.delta) ? choice.delta : null;
  if (delta && hasOwn(delta, 'provider_metadata')) {
    return isRecord(delta.provider_metadata) ? delta.provider_metadata : null;
  }
  return null;
}

function resolveProviderCacheBlock(
  metadata: Record<string, unknown>,
  finalProvider: string,
): Record<string, unknown> | null {
  const exact = metadata[finalProvider];
  if (isRecord(exact)) return exact;

  const caseInsensitiveTarget = finalProvider.toLowerCase();
  for (const [key, value] of Object.entries(metadata)) {
    if (key.toLowerCase() === caseInsensitiveTarget && isRecord(value)) {
      return value;
    }
  }
  return null;
}

function summarizeModelAttempts(value: unknown): UpstreamProviderModelAttemptSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: UpstreamProviderModelAttemptSummary[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    // Source field is `providerAttempts`; a same-named attempt list under
    // `providers` is not part of the verified Cline gateway shape and is ignored.
    const providerAttempts = Array.isArray(item.providerAttempts) ? item.providerAttempts : [];
    summaries.push({
      canonicalSlug: asTrimmedNonEmptyString(item.canonicalSlug),
      success: asBoolean(item.success),
      providerAttemptCount: asInteger(item.providerAttemptCount),
      providers: providerAttempts.filter(isRecord).map((attempt) => ({
        provider: asTrimmedNonEmptyString(attempt.provider),
        credentialType: asTrimmedNonEmptyString(attempt.credentialType),
        statusCode: asInteger(attempt.statusCode),
        success: asBoolean(attempt.success),
      })),
    });
  }
  return summaries;
}

function resolveUsageCostFields(
  container: Record<string, unknown>,
  metadata: Record<string, unknown> | null,
): UpstreamProviderUsageCostFields {
  const usage = isRecord(container.usage) ? container.usage : null;
  const gateway = metadata && isRecord(metadata.gateway) ? metadata.gateway : null;
  return {
    usageCost: asFiniteNumber(usage?.cost),
    usageGatewayCost: asFiniteNumber(usage?.gateway_cost),
    usageMarketCost: asFiniteNumber(usage?.market_cost),
    gatewayCostText: asCostText(gateway?.cost),
    gatewayCostNumber: asFiniteNumber(gateway?.cost),
    gatewayInferenceCostText: asCostText(gateway?.inferenceCost),
    gatewayInferenceCostNumber: asFiniteNumber(gateway?.inferenceCost),
    gatewayGenerationId: asTrimmedNonEmptyString(gateway?.generationId),
  };
}

function hasUsageCostValue(fields: UpstreamProviderUsageCostFields): boolean {
  return Object.values(fields).some((value) => value !== null);
}

/**
 * Extracts the cost/text view of a payload **without requiring routing**. The
 * stream shape puts usage on a final frame that has `choices: []` (no
 * metadata), so the collector stages this view separately from the routing
 * observation. Returns `null` when the payload carries no cost text at all.
 *
 * v1 stores only the text costs (`gatewayCostText` / `gatewayInferenceCostText`);
 * the numeric view exists for callers/tests and is not persisted.
 */
export function parseUpstreamProviderUsageCosts(payload: unknown): UpstreamProviderUsageCostFields | null {
  const container = resolveContainer(payload);
  if (!container) return null;

  const choice = resolveChoice(container);
  const metadata = choice ? resolveProviderMetadata(choice) : null;
  const fields = resolveUsageCostFields(container, metadata);
  return hasUsageCostValue(fields) ? fields : null;
}

/**
 * Parses one payload. Returns `null` when this payload carries no usable
 * gateway routing (`finalProvider` is the anchor field: no value, no
 * observation). Missing or mistyped secondary fields degrade to `null` values
 * instead of throwing.
 *
 * Usage costs follow the container resolution: `{ success, data }` reads
 * `data.usage`, a bare body reads root `usage` (A2). The numeric views of the
 * gateway string costs are never persisted in v1 (text columns only).
 *
 * `platformHint` is accepted for future parser dispatch; v1 ignores it and
 * only recognizes the Cline gateway structure.
 */
export function parseUpstreamProviderObservation(
  payload: unknown,
  platformHint?: string | null,
): UpstreamProviderObservation | null {
  void platformHint;

  const container = resolveContainer(payload);
  if (!container) return null;

  const choice = resolveChoice(container);
  if (!choice) return null;

  const metadata = resolveProviderMetadata(choice);
  if (!metadata) return null;

  const gateway = isRecord(metadata.gateway) ? metadata.gateway : null;
  const routing = gateway && isRecord(gateway.routing) ? gateway.routing : null;
  if (!routing) return null;

  const finalProvider = asTrimmedNonEmptyString(routing.finalProvider);
  if (!finalProvider) return null;

  const affinity = isRecord(routing.affinity) ? routing.affinity : null;
  const cacheBlock = resolveProviderCacheBlock(metadata, finalProvider);
  const fallbacksAvailable = asStringList(routing.fallbacksAvailable);
  const modelAttemptsSummary = summarizeModelAttempts(routing.modelAttempts);

  return {
    parserId: UPSTREAM_PROVIDER_PARSER_ID,
    parserVersion: UPSTREAM_PROVIDER_PARSER_VERSION,
    finalProvider,
    resolvedProvider: asTrimmedNonEmptyString(routing.resolvedProvider),
    canonicalSlug: asTrimmedNonEmptyString(routing.canonicalSlug),
    originalModelId: asTrimmedNonEmptyString(routing.originalModelId),
    affinityOutcome: asTrimmedNonEmptyString(affinity?.outcome),
    affinityPinnedProvider: asTrimmedNonEmptyString(affinity?.pinnedProvider),
    clientSessionId: asTrimmedNonEmptyString(routing.clientSessionId),
    clientSessionIdSource: asTrimmedNonEmptyString(routing.clientSessionIdSource),
    fallbacksAvailable,
    fallbackCount: fallbacksAvailable ? fallbacksAvailable.length : null,
    modelAttemptsSummary,
    modelAttemptCount: asInteger(routing.modelAttemptCount),
    totalProviderAttemptCount: asInteger(routing.totalProviderAttemptCount),
    cacheHitTokens: asInteger(cacheBlock?.promptCacheHitTokens),
    cacheMissTokens: asInteger(cacheBlock?.promptCacheMissTokens),
    systemFingerprint: asTrimmedNonEmptyString(cacheBlock?.systemFingerprint),
    ...resolveUsageCostFields(container, metadata),
  };
}
