/**
 * Read side for upstream-provider observations: detail matching plus the
 * aggregate queries used by the `/api/stats/upstream-observations/*` routes.
 *
 * Detail association (v2.1 hard linkage): rows written after this change pin the
 * id of the success `proxy_logs` row they belong to (`proxy_log_id`). Matching
 * order is
 * 1. status gate: only `status === 'success'` logs are eligible (C4) — anything
 *    else returns `matchKind: 'skipped'` and is not counted;
 * 2. hard lookup by `proxy_log_id = id` when the key carries a positive
 *    integer. Exactly one row with matching key columns is returned as
 *    `matchKind: 'hard'` (no ±2s requirement, no key-completeness requirement);
 *    one row whose key columns conflict is withheld as `matchKind: 'hardAnomaly'`
 *    with `candidateCount: 1` (only "both sides present and unequal" counts — a
 *    missing value is never a conflict); two or more rows for the same id are
 *    withheld as `matchKind: 'hardAmbiguous'` with `candidateCount >= 2` and
 *    never fall back to the window; zero rows fall through;
 * 3. window fallback (±2s, `is_stream` narrowing when the log has a boolean) is
 *    restricted to `proxy_log_id IS NULL`, so rows already pinned to other logs
 *    can no longer be borrowed. The window is computed in JS and applied with
 *    plain `gte`/`lte` on the stored UTC ISO strings; no dialect-specific date
 *    functions are involved. Zero or more than one candidate means "no guess".
 *
 * Legacy rows (and "log written but no id available") keep `proxy_log_id IS NULL`
 * forever: nothing is backfilled.
 *
 * Metrics: `evaluated` only counts window hit / ambiguous / miss outcomes.
 * `hardHits` counts exactly-one-clean hard rows and never includes `hardAnomaly`
 * or `hardAmbiguous`; those have their own counters and stay out of
 * `evaluated`, so `ambiguousRate` (window-only) is not diluted. With hard
 * linkage healthy and `sample_rate = 1`, detail lookups are almost all hard
 * hits and `evaluated` tends to 0, which keeps `hardLinkSuggested` false on
 * purpose — that is not a broken metric. A throttled log line reports the
 * counters and flags `hardLinkSuggested` once the window-fallback ambiguous rate
 * exceeds 5 % (hint is window health, no longer "go build hard linkage").
 */

import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { formatUtcSqlDateTime, parseStoredUtcDateTime } from '../localTimeService.js';

export const UPSTREAM_OBSERVATION_DETAIL_MATCH_WINDOW_MS = 2_000;
export const UPSTREAM_OBSERVATION_QUERY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const UPSTREAM_OBSERVATION_FALLBACK_GROUP_LIMIT = 50;
export const UPSTREAM_OBSERVATION_SESSION_ITEM_LIMIT = 200;
export const UPSTREAM_OBSERVATION_AMBIGUOUS_RATE_ALERT_THRESHOLD = 0.05;

const MATCH_METRICS_LOG_INTERVAL_MS = 60_000;

export type UpstreamProviderObservationView = {
  id: number;
  createdAt: string;
  proxyLogId: number | null;
  siteId: number | null;
  accountId: number | null;
  routeId: number | null;
  channelId: number | null;
  downstreamApiKeyId: number | null;
  requestedModel: string | null;
  actualModel: string | null;
  upstreamPath: string | null;
  isStream: boolean | null;
  parserId: string;
  parserVersion: number;
  finalProvider: string | null;
  resolvedProvider: string | null;
  canonicalSlug: string | null;
  originalModelId: string | null;
  affinityOutcome: string | null;
  affinityPinnedProvider: string | null;
  clientSessionId: string | null;
  clientSessionIdSource: string | null;
  fallbacks: string[] | null;
  fallbackCount: number | null;
  modelAttempts: Array<{
    canonicalSlug: string | null;
    success: boolean | null;
    providerAttemptCount: number | null;
    providers: Array<{
      provider: string | null;
      credentialType: string | null;
      statusCode: number | null;
      success: boolean | null;
    }>;
  }> | null;
  attemptsTruncated: boolean;
  modelAttemptCount: number | null;
  totalProviderAttemptCount: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  systemFingerprint: string | null;
  usageCost: number | null;
  usageGatewayCost: number | null;
  usageMarketCost: number | null;
  gatewayCostText: string | null;
  gatewayInferenceCostText: string | null;
  gatewayGenerationId: string | null;
};

export type UpstreamProviderProxyLogMatchKey = {
  accountId?: number | null;
  channelId?: number | null;
  requestedModel?: string | null;
  createdAt?: string | null;
  isStream?: boolean | null;
  /**
   * Only successful proxy logs can have an observation by construction (C4);
   * any other value short-circuits to "no observation".
   */
  status?: string | null;
  /**
   * Id of the proxy log being opened. When it is a positive integer the hard
   * `proxy_log_id = id` lookup runs first; rows without an id skip it and go
   * straight to the ±2s window.
   */
  proxyLogId?: number | null;
};

/**
 * Internal-only match provenance. Never returned by the HTTP API: the detail
 * route still exposes only `upstreamObservation`.
 */
export type UpstreamProviderObservationMatchKind =
  | 'skipped'
  | 'hard'
  | 'hardAnomaly'
  | 'hardAmbiguous'
  | 'window'
  | 'incompleteKey';

export type UpstreamProviderObservationDetailMatch = {
  observation: UpstreamProviderObservationView | null;
  candidateCount: number;
  windowFrom: string | null;
  windowTo: string | null;
  matchKind: UpstreamProviderObservationMatchKind;
};

export type UpstreamProviderObservationMatchMetrics = {
  evaluated: number;
  uniqueHits: number;
  ambiguous: number;
  misses: number;
  incompleteKey: number;
  /** Hard hits that were returned; excludes `hardAnomaly` and `hardAmbiguous`. */
  hardHits: number;
  /** Two or more rows pinned to the same `proxy_log_id` (defensive). */
  hardAmbiguous: number;
  /** The pinned row disagrees with a key column that is present on both sides. */
  hardAnomaly: number;
  ambiguousRate: number;
  hardLinkSuggested: boolean;
};

export type UpstreamProviderObservationQueryWindow = {
  fromUtc: string;
  toUtc: string;
  fromMs: number;
  toMs: number;
  /** True when an explicit/absent window was clamped to the 7-day maximum (F3). */
  capped: boolean;
};

export type UpstreamProviderDistributionItem = {
  provider: string;
  requests: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
};

export type UpstreamProviderFallbackGroup = {
  siteId: number | null;
  requestedModel: string | null;
  canonicalSlug: string | null;
  finalProvider: string | null;
  latestCreatedAt: string;
  fallbacks: string[] | null;
  fallbackCount: number | null;
};

export type UpstreamProviderSessionItem = {
  id: number;
  createdAt: string;
  siteId: number | null;
  accountId: number | null;
  routeId: number | null;
  channelId: number | null;
  requestedModel: string | null;
  finalProvider: string | null;
  canonicalSlug: string | null;
  affinityOutcome: string | null;
  affinityPinnedProvider: string | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
};

let matchMetrics = {
  evaluated: 0,
  uniqueHits: 0,
  ambiguous: 0,
  misses: 0,
  incompleteKey: 0,
  hardHits: 0,
  hardAmbiguous: 0,
  hardAnomaly: 0,
};
let lastMatchMetricsLogAtMs = 0;
let hardAnomalyWarningLogged = false;
let hardAmbiguousWarningLogged = false;

function computeAmbiguousRate(metrics: { evaluated: number; ambiguous: number }): number {
  if (metrics.evaluated <= 0) return 0;
  return metrics.ambiguous / metrics.evaluated;
}

export function getUpstreamProviderObservationMatchMetrics(): UpstreamProviderObservationMatchMetrics {
  const ambiguousRate = computeAmbiguousRate(matchMetrics);
  return {
    ...matchMetrics,
    ambiguousRate,
    hardLinkSuggested: ambiguousRate > UPSTREAM_OBSERVATION_AMBIGUOUS_RATE_ALERT_THRESHOLD,
  };
}

/** Test/diagnostic helper; production counters are monotonic for the process. */
export function resetUpstreamProviderObservationMatchMetrics(nowMs = Date.now()): void {
  matchMetrics = {
    evaluated: 0,
    uniqueHits: 0,
    ambiguous: 0,
    misses: 0,
    incompleteKey: 0,
    hardHits: 0,
    hardAmbiguous: 0,
    hardAnomaly: 0,
  };
  lastMatchMetricsLogAtMs = nowMs;
  hardAnomalyWarningLogged = false;
  hardAmbiguousWarningLogged = false;
}

function maybeLogMatchMetrics(nowMs: number): void {
  if (nowMs - lastMatchMetricsLogAtMs < MATCH_METRICS_LOG_INTERVAL_MS) return;
  lastMatchMetricsLogAtMs = nowMs;

  const metrics = getUpstreamProviderObservationMatchMetrics();
  console.info(
    '[upstream-provider-detect] detail match metrics',
    {
      evaluated: metrics.evaluated,
      uniqueHits: metrics.uniqueHits,
      ambiguous: metrics.ambiguous,
      misses: metrics.misses,
      incompleteKey: metrics.incompleteKey,
      hardHits: metrics.hardHits,
      hardAmbiguous: metrics.hardAmbiguous,
      hardAnomaly: metrics.hardAnomaly,
      ambiguousRate: Number(metrics.ambiguousRate.toFixed(4)),
      ...(metrics.hardLinkSuggested
        ? {
          hardLinkSuggested: true,
          hint: 'time-window fallback ambiguous rate > 5% (proxy_log_id IS NULL matches only); hard linkage is active, this is not a "go build hard linkage" signal',
        }
        : {}),
    },
  );
}

function recordDetailMatchOutcome(outcome: 'hit' | 'ambiguous' | 'miss' | 'incompleteKey', nowMs = Date.now()): void {
  if (outcome === 'hit') matchMetrics.uniqueHits++;
  else if (outcome === 'ambiguous') matchMetrics.ambiguous++;
  else if (outcome === 'miss') matchMetrics.misses++;
  else matchMetrics.incompleteKey++;

  if (outcome !== 'incompleteKey') {
    matchMetrics.evaluated++;
  }

  if (outcome === 'incompleteKey') return;
  maybeLogMatchMetrics(nowMs);
}

/**
 * Hard-id outcomes never touch `evaluated`: a healthy hard hit is not part of
 * the window-fallback population, and `hardHits` deliberately excludes both
 * defensive branches so "returned" and "found but withheld" stay separable.
 */
function recordHardMatchOutcome(outcome: 'hard' | 'hardAmbiguous' | 'hardAnomaly', nowMs = Date.now()): void {
  if (outcome === 'hard') {
    matchMetrics.hardHits++;
  } else if (outcome === 'hardAmbiguous') {
    matchMetrics.hardAmbiguous++;
    if (!hardAmbiguousWarningLogged) {
      hardAmbiguousWarningLogged = true;
      console.warn('[upstream-provider-detect] multiple observations pinned to the same proxy_log_id; returning no observation');
    }
  } else {
    matchMetrics.hardAnomaly++;
    if (!hardAnomalyWarningLogged) {
      hardAnomalyWarningLogged = true;
      console.warn('[upstream-provider-detect] hard-linked observation disagrees with the proxy log keys; returning no observation');
    }
  }

  maybeLogMatchMetrics(nowMs);
}

function toPositiveInt(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : null;
}

function normalizeStatus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModelKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonArray(raw: string | null): unknown[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseFallbacks(raw: string | null): string[] | null {
  const parsed = parseJsonArray(raw);
  if (!parsed) return null;
  const fallbacks = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return fallbacks.length > 0 ? fallbacks : null;
}

function parseModelAttempts(raw: string | null): UpstreamProviderObservationView['modelAttempts'] {
  const parsed = parseJsonArray(raw);
  if (!parsed) return null;
  return parsed
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      canonicalSlug: typeof item.canonicalSlug === 'string' ? item.canonicalSlug : null,
      success: typeof item.success === 'boolean' ? item.success : null,
      providerAttemptCount: typeof item.providerAttemptCount === 'number' ? item.providerAttemptCount : null,
      providers: Array.isArray(item.providers)
        ? item.providers
            .filter((provider): provider is Record<string, unknown> => !!provider && typeof provider === 'object' && !Array.isArray(provider))
            .map((provider) => ({
              provider: typeof provider.provider === 'string' ? provider.provider : null,
              credentialType: typeof provider.credentialType === 'string' ? provider.credentialType : null,
              statusCode: typeof provider.statusCode === 'number' ? provider.statusCode : null,
              success: typeof provider.success === 'boolean' ? provider.success : null,
            }))
        : [],
    }));
}

function mapObservationRow(
  row: typeof schema.upstreamProviderObservations.$inferSelect,
): UpstreamProviderObservationView {
  return {
    id: row.id,
    createdAt: row.createdAt,
    proxyLogId: row.proxyLogId ?? null,
    siteId: row.siteId ?? null,
    accountId: row.accountId ?? null,
    routeId: row.routeId ?? null,
    channelId: row.channelId ?? null,
    downstreamApiKeyId: row.downstreamApiKeyId ?? null,
    requestedModel: row.requestedModel ?? null,
    actualModel: row.actualModel ?? null,
    upstreamPath: row.upstreamPath ?? null,
    isStream: row.isStream == null ? null : Boolean(row.isStream),
    parserId: row.parserId,
    parserVersion: row.parserVersion,
    finalProvider: row.finalProvider ?? null,
    resolvedProvider: row.resolvedProvider ?? null,
    canonicalSlug: row.canonicalSlug ?? null,
    originalModelId: row.originalModelId ?? null,
    affinityOutcome: row.affinityOutcome ?? null,
    affinityPinnedProvider: row.affinityPinnedProvider ?? null,
    clientSessionId: row.clientSessionId ?? null,
    clientSessionIdSource: row.clientSessionIdSource ?? null,
    fallbacks: parseFallbacks(row.fallbacksJson ?? null),
    fallbackCount: row.fallbackCount ?? null,
    modelAttempts: parseModelAttempts(row.modelAttemptsJson ?? null),
    attemptsTruncated: Boolean(row.attemptsTruncated),
    modelAttemptCount: row.modelAttemptCount ?? null,
    totalProviderAttemptCount: row.totalProviderAttemptCount ?? null,
    cacheHitTokens: row.cacheHitTokens ?? null,
    cacheMissTokens: row.cacheMissTokens ?? null,
    systemFingerprint: row.systemFingerprint ?? null,
    usageCost: row.usageCost ?? null,
    usageGatewayCost: row.usageGatewayCost ?? null,
    usageMarketCost: row.usageMarketCost ?? null,
    gatewayCostText: row.gatewayCostText ?? null,
    gatewayInferenceCostText: row.gatewayInferenceCostText ?? null,
    gatewayGenerationId: row.gatewayGenerationId ?? null,
  };
}

/**
 * Key columns of a hard-pinned row that are present on both sides must agree;
 * a missing value (null, empty string, non-boolean stream flag, non-positive
 * id) is never treated as a conflict, so legacy rows that lost `is_stream` to
 * the column-compat retry keep matching.
 */
function hasHardKeyMismatch(
  row: typeof schema.upstreamProviderObservations.$inferSelect,
  key: {
    accountId: number | null;
    channelId: number | null;
    requestedModel: string | null;
    isStream?: boolean | null;
  },
): boolean {
  const rowAccountId = toPositiveInt(row.accountId);
  if (rowAccountId != null && key.accountId != null && rowAccountId !== key.accountId) return true;
  const rowChannelId = toPositiveInt(row.channelId);
  if (rowChannelId != null && key.channelId != null && rowChannelId !== key.channelId) return true;
  const rowRequestedModel = normalizeModelKey(row.requestedModel);
  if (rowRequestedModel != null && key.requestedModel != null && rowRequestedModel !== key.requestedModel) return true;
  if (typeof key.isStream === 'boolean' && row.isStream != null && Boolean(row.isStream) !== key.isStream) return true;
  return false;
}

/**
 * Finds the observation for one proxy log: hard `proxy_log_id` first, then the
 * legacy ±2s window restricted to `proxy_log_id IS NULL` rows.
 *
 * Only `status === 'success'` proxy logs are eligible: observations are
 * written in the same breath as the success log (C4), so matching a
 * failed/retried log — or a log whose status is unknown — would only ever
 * surface a neighbour's upstream (also when `sample_rate < 1` hides the
 * request that produced the observation). Skipped lookups stay out of the
 * match metrics: they are not part of the fallback population.
 *
 * Hard lookup: exactly one row with no key conflict -> `matchKind: 'hard'` +
 * `hardHits++` (no key-completeness requirement, no window requirement). One
 * conflicting row -> `null` + `matchKind: 'hardAnomaly'` + `candidateCount: 1`
 * (kept out of `hardHits`; no window fallback). Two or more rows pinned to the
 * same id -> `null` + `matchKind: 'hardAmbiguous'` + `candidateCount >= 2`
 * (defensive only; no window fallback).
 *
 * Window fallback: one candidate -> the row; zero candidates -> no observation
 * (`candidateCount: 0`, a miss); more than one NULL-pinned candidate ->
 * `candidateCount > 1` and "no guess". Incomplete window keys skip the window
 * entirely (`incompleteKey`) — but only after the hard lookup had its chance.
 */
export async function findUpstreamProviderObservationForProxyLog(
  key: UpstreamProviderProxyLogMatchKey,
  nowMs = Date.now(),
): Promise<UpstreamProviderObservationDetailMatch> {
  if (normalizeStatus(key.status) !== 'success') {
    return { observation: null, candidateCount: 0, windowFrom: null, windowTo: null, matchKind: 'skipped' };
  }

  const accountId = toPositiveInt(key.accountId);
  const channelId = toPositiveInt(key.channelId);
  const requestedModel = normalizeModelKey(key.requestedModel);
  const createdAt = parseStoredUtcDateTime(key.createdAt ?? null);
  const proxyLogId = toPositiveInt(key.proxyLogId);

  // Hard lookup first: the id is the authority and does not require the window
  // keys to be complete.
  if (proxyLogId != null) {
    const hardRows = await db
      .select()
      .from(schema.upstreamProviderObservations)
      .where(eq(schema.upstreamProviderObservations.proxyLogId, proxyLogId))
      .orderBy(asc(schema.upstreamProviderObservations.id))
      .limit(2)
      .all();

    if (hardRows.length >= 2) {
      recordHardMatchOutcome('hardAmbiguous', nowMs);
      return {
        observation: null,
        candidateCount: hardRows.length,
        windowFrom: null,
        windowTo: null,
        matchKind: 'hardAmbiguous',
      };
    }

    const hardRow = hardRows[0];
    if (hardRow) {
      if (hasHardKeyMismatch(hardRow, { accountId, channelId, requestedModel, isStream: key.isStream })) {
        recordHardMatchOutcome('hardAnomaly', nowMs);
        return {
          // candidateCount 1 separates "pinned row found but withheld" from
          // "nothing matched / nothing observed". Internal only, never in the API.
          observation: null,
          candidateCount: 1,
          windowFrom: null,
          windowTo: null,
          matchKind: 'hardAnomaly',
        };
      }
      recordHardMatchOutcome('hard', nowMs);
      return {
        observation: mapObservationRow(hardRow),
        candidateCount: 1,
        windowFrom: null,
        windowTo: null,
        matchKind: 'hard',
      };
    }
  }

  if (accountId == null || channelId == null || !requestedModel || !createdAt) {
    recordDetailMatchOutcome('incompleteKey', nowMs);
    return { observation: null, candidateCount: 0, windowFrom: null, windowTo: null, matchKind: 'incompleteKey' };
  }

  const windowFrom = formatUtcSqlDateTime(
    new Date(createdAt.getTime() - UPSTREAM_OBSERVATION_DETAIL_MATCH_WINDOW_MS),
  );
  const windowTo = formatUtcSqlDateTime(
    new Date(createdAt.getTime() + UPSTREAM_OBSERVATION_DETAIL_MATCH_WINDOW_MS),
  );

  const conditions = [
    eq(schema.upstreamProviderObservations.accountId, accountId),
    eq(schema.upstreamProviderObservations.channelId, channelId),
    eq(schema.upstreamProviderObservations.requestedModel, requestedModel),
    gte(schema.upstreamProviderObservations.createdAt, windowFrom),
    lte(schema.upstreamProviderObservations.createdAt, windowTo),
    // Hard linkage: a row already pinned to some log belongs to that log by
    // definition. Counting it here would manufacture a fake unique hit (single
    // pinned neighbour) or a fake ambiguity (pinned + NULL); both are wrong, and
    // the legacy behaviour for rows that are all NULL is unchanged.
    isNull(schema.upstreamProviderObservations.proxyLogId),
  ];
  // Optional narrowing: only apply when the proxy log has an explicit boolean,
  // so legacy rows without `is_stream` keep matching.
  if (typeof key.isStream === 'boolean') {
    conditions.push(eq(schema.upstreamProviderObservations.isStream, key.isStream));
  }

  const candidates = await db
    .select()
    .from(schema.upstreamProviderObservations)
    .where(and(...conditions))
    .orderBy(asc(schema.upstreamProviderObservations.createdAt), asc(schema.upstreamProviderObservations.id))
    .limit(4)
    .all();

  if (candidates.length === 1) {
    recordDetailMatchOutcome('hit', nowMs);
    return {
      observation: mapObservationRow(candidates[0]),
      candidateCount: 1,
      windowFrom,
      windowTo,
      matchKind: 'window',
    };
  }

  recordDetailMatchOutcome(candidates.length === 0 ? 'miss' : 'ambiguous', nowMs);
  return {
    observation: null,
    candidateCount: candidates.length,
    windowFrom,
    windowTo,
    matchKind: 'window',
  };
}

function toStoredUtcString(value: Date): string {
  return formatUtcSqlDateTime(value);
}

/**
 * F3: aggregates never scan the whole table. Default window is `[now - 7d, now]`;
 * explicit bounds are clamped so that `to - from <= 7d`, and reversed bounds
 * degrade to the default window instead of failing.
 */
export function resolveUpstreamProviderObservationQueryWindow(
  input: { from?: string | null; to?: string | null },
  nowMs = Date.now(),
): UpstreamProviderObservationQueryWindow {
  const toDate = parseStoredUtcDateTime(input.to ?? null) ?? new Date(nowMs);
  const toMsRaw = toDate.getTime();
  const explicitFrom = parseStoredUtcDateTime(input.from ?? null);
  const defaultFromMs = toMsRaw - UPSTREAM_OBSERVATION_QUERY_MAX_WINDOW_MS;

  let fromMs = explicitFrom ? explicitFrom.getTime() : defaultFromMs;
  let capped = false;

  if (fromMs >= toMsRaw) {
    fromMs = defaultFromMs;
    capped = true;
  } else if (toMsRaw - fromMs > UPSTREAM_OBSERVATION_QUERY_MAX_WINDOW_MS) {
    fromMs = defaultFromMs;
    capped = true;
  }

  return {
    fromUtc: toStoredUtcString(new Date(fromMs)),
    toUtc: toStoredUtcString(new Date(toMsRaw)),
    fromMs,
    toMs: toMsRaw,
    capped,
  };
}

function buildAggregateConditions(input: {
  siteId?: number | null;
  model?: string | null;
  window: UpstreamProviderObservationQueryWindow;
}) {
  const conditions = [
    gte(schema.upstreamProviderObservations.createdAt, input.window.fromUtc),
    lte(schema.upstreamProviderObservations.createdAt, input.window.toUtc),
  ];
  const siteId = toPositiveInt(input.siteId);
  if (siteId != null) {
    conditions.push(eq(schema.upstreamProviderObservations.siteId, siteId));
  }
  const model = normalizeModelKey(input.model);
  if (model) {
    conditions.push(eq(schema.upstreamProviderObservations.requestedModel, model));
  }
  return conditions;
}

/** Provider distribution ordered by request count (desc). Null providers are dropped. */
export async function loadUpstreamProviderObservationDistribution(input: {
  siteId?: number | null;
  model?: string | null;
  window: UpstreamProviderObservationQueryWindow;
}): Promise<UpstreamProviderDistributionItem[]> {
  const requestCount = sql<number>`count(*)`;
  const rows = await db
    .select({
      provider: schema.upstreamProviderObservations.finalProvider,
      requests: requestCount,
      cacheHitTokens: sql<number>`coalesce(sum(${schema.upstreamProviderObservations.cacheHitTokens}), 0)`,
      cacheMissTokens: sql<number>`coalesce(sum(${schema.upstreamProviderObservations.cacheMissTokens}), 0)`,
    })
    .from(schema.upstreamProviderObservations)
    .where(and(
      ...buildAggregateConditions(input),
      isNotNull(schema.upstreamProviderObservations.finalProvider),
    ))
    .groupBy(schema.upstreamProviderObservations.finalProvider)
    .orderBy(desc(requestCount), asc(schema.upstreamProviderObservations.finalProvider))
    .all();

  return rows.map((row) => ({
    provider: String(row.provider),
    requests: Number(row.requests ?? 0),
    cacheHitTokens: Number(row.cacheHitTokens ?? 0),
    cacheMissTokens: Number(row.cacheMissTokens ?? 0),
  }));
}

/**
 * "Current channel list" per `(site_id, requested_model, canonical_slug)`: the
 * latest row's `fallbacks_json` only. Rows are deliberately not unioned across
 * the window — the list changes over time and a union would lie.
 */
export async function loadUpstreamProviderObservationFallbacks(input: {
  siteId?: number | null;
  model?: string | null;
  window: UpstreamProviderObservationQueryWindow;
  groupLimit?: number;
}): Promise<{ items: UpstreamProviderFallbackGroup[]; truncated: boolean }> {
  const groupLimit = Math.max(1, Math.min(
    UPSTREAM_OBSERVATION_FALLBACK_GROUP_LIMIT,
    Math.trunc(input.groupLimit ?? UPSTREAM_OBSERVATION_FALLBACK_GROUP_LIMIT),
  ));
  const latestCreatedAt = sql<string>`max(${schema.upstreamProviderObservations.createdAt})`;

  const groups = await db
    .select({
      siteId: schema.upstreamProviderObservations.siteId,
      requestedModel: schema.upstreamProviderObservations.requestedModel,
      canonicalSlug: schema.upstreamProviderObservations.canonicalSlug,
      latestCreatedAt,
    })
    .from(schema.upstreamProviderObservations)
    .where(and(...buildAggregateConditions(input)))
    .groupBy(
      schema.upstreamProviderObservations.siteId,
      schema.upstreamProviderObservations.requestedModel,
      schema.upstreamProviderObservations.canonicalSlug,
    )
    .orderBy(desc(latestCreatedAt))
    .limit(groupLimit + 1)
    .all();

  const truncated = groups.length > groupLimit;
  const visibleGroups = groups.slice(0, groupLimit);
  const items: UpstreamProviderFallbackGroup[] = [];

  for (const group of visibleGroups) {
    const groupConditions = [
      gte(schema.upstreamProviderObservations.createdAt, input.window.fromUtc),
      lte(schema.upstreamProviderObservations.createdAt, input.window.toUtc),
      eq(schema.upstreamProviderObservations.createdAt, group.latestCreatedAt),
      group.siteId == null
        ? isNull(schema.upstreamProviderObservations.siteId)
        : eq(schema.upstreamProviderObservations.siteId, group.siteId),
      group.requestedModel == null
        ? isNull(schema.upstreamProviderObservations.requestedModel)
        : eq(schema.upstreamProviderObservations.requestedModel, group.requestedModel),
      group.canonicalSlug == null
        ? isNull(schema.upstreamProviderObservations.canonicalSlug)
        : eq(schema.upstreamProviderObservations.canonicalSlug, group.canonicalSlug),
    ];
    const siteId = toPositiveInt(input.siteId);
    if (siteId != null) {
      groupConditions.push(eq(schema.upstreamProviderObservations.siteId, siteId));
    }
    const model = normalizeModelKey(input.model);
    if (model) {
      groupConditions.push(eq(schema.upstreamProviderObservations.requestedModel, model));
    }

    const latestRow = await db
      .select({
        finalProvider: schema.upstreamProviderObservations.finalProvider,
        fallbacksJson: schema.upstreamProviderObservations.fallbacksJson,
        fallbackCount: schema.upstreamProviderObservations.fallbackCount,
      })
      .from(schema.upstreamProviderObservations)
      .where(and(...groupConditions))
      .orderBy(desc(schema.upstreamProviderObservations.id))
      .limit(1)
      .all();

    const row = latestRow[0];
    if (!row) continue;
    const fallbacks = parseFallbacks(row.fallbacksJson ?? null);
    items.push({
      siteId: group.siteId ?? null,
      requestedModel: group.requestedModel ?? null,
      canonicalSlug: group.canonicalSlug ?? null,
      finalProvider: row.finalProvider ?? null,
      latestCreatedAt: String(group.latestCreatedAt),
      fallbacks,
      fallbackCount: row.fallbackCount ?? (fallbacks ? fallbacks.length : null),
    });
  }

  return { items, truncated };
}

/** Provider sequence of one upstream (Cline) session; read-only, ascending time. */
export async function loadUpstreamProviderObservationSession(input: {
  clientSessionId: string;
  limit?: number;
}): Promise<{ clientSessionId: string; count: number; items: UpstreamProviderSessionItem[] }> {
  const clientSessionId = normalizeModelKey(input.clientSessionId) ?? '';
  if (!clientSessionId) {
    return { clientSessionId: '', count: 0, items: [] };
  }
  const limit = Math.max(1, Math.min(
    UPSTREAM_OBSERVATION_SESSION_ITEM_LIMIT,
    Math.trunc(input.limit ?? UPSTREAM_OBSERVATION_SESSION_ITEM_LIMIT),
  ));

  const rows = await db
    .select({
      id: schema.upstreamProviderObservations.id,
      createdAt: schema.upstreamProviderObservations.createdAt,
      siteId: schema.upstreamProviderObservations.siteId,
      accountId: schema.upstreamProviderObservations.accountId,
      routeId: schema.upstreamProviderObservations.routeId,
      channelId: schema.upstreamProviderObservations.channelId,
      requestedModel: schema.upstreamProviderObservations.requestedModel,
      finalProvider: schema.upstreamProviderObservations.finalProvider,
      canonicalSlug: schema.upstreamProviderObservations.canonicalSlug,
      affinityOutcome: schema.upstreamProviderObservations.affinityOutcome,
      affinityPinnedProvider: schema.upstreamProviderObservations.affinityPinnedProvider,
      cacheHitTokens: schema.upstreamProviderObservations.cacheHitTokens,
      cacheMissTokens: schema.upstreamProviderObservations.cacheMissTokens,
    })
    .from(schema.upstreamProviderObservations)
    .where(eq(schema.upstreamProviderObservations.clientSessionId, clientSessionId))
    .orderBy(asc(schema.upstreamProviderObservations.createdAt), asc(schema.upstreamProviderObservations.id))
    .limit(limit)
    .all();

  return {
    clientSessionId,
    count: rows.length,
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      siteId: row.siteId ?? null,
      accountId: row.accountId ?? null,
      routeId: row.routeId ?? null,
      channelId: row.channelId ?? null,
      requestedModel: row.requestedModel ?? null,
      finalProvider: row.finalProvider ?? null,
      canonicalSlug: row.canonicalSlug ?? null,
      affinityOutcome: row.affinityOutcome ?? null,
      affinityPinnedProvider: row.affinityPinnedProvider ?? null,
      cacheHitTokens: row.cacheHitTokens ?? null,
      cacheMissTokens: row.cacheMissTokens ?? null,
    })),
  };
}
