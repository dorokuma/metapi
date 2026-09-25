/**
 * Read side for upstream-provider observations: detail matching plus the
 * aggregate queries used by the `/api/stats/upstream-observations/*` routes.
 *
 * Detail association (F1): v1 does not backfill `proxy_log_id`, so the detail
 * API finds a unique observation by
 * `(account_id, channel_id, requested_model, created_at ± 2s)` — optionally
 * narrowed by `is_stream`. The ±2s window is computed in JS and applied with
 * plain `gte`/`lte` on the stored UTC ISO strings; no dialect-specific date
 * functions are involved. Zero or more than one candidate means "no guess":
 * the caller receives `observation: null` plus the candidate count.
 *
 * F2 metrics: every detail match records hit / ambiguous / zero-hit outcomes
 * (incomplete keys are counted separately, since they cannot participate in the
 * ±2s population at all). A throttled log line reports the counters and flags
 * `hardLinkSuggested` once the ambiguous rate exceeds 5 %.
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
};

export type UpstreamProviderObservationDetailMatch = {
  observation: UpstreamProviderObservationView | null;
  candidateCount: number;
  windowFrom: string | null;
  windowTo: string | null;
};

export type UpstreamProviderObservationMatchMetrics = {
  evaluated: number;
  uniqueHits: number;
  ambiguous: number;
  misses: number;
  incompleteKey: number;
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
};
let lastMatchMetricsLogAtMs = 0;

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
  matchMetrics = { evaluated: 0, uniqueHits: 0, ambiguous: 0, misses: 0, incompleteKey: 0 };
  lastMatchMetricsLogAtMs = nowMs;
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
      ambiguousRate: Number(metrics.ambiguousRate.toFixed(4)),
      ...(metrics.hardLinkSuggested
        ? { hardLinkSuggested: true, hint: 'ambiguous rate > 5%: evaluate hard proxy_log_id linkage' }
        : {}),
    },
  );
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
 * Finds the unique ±2s observation for one proxy log.
 *
 * Only `status === 'success'` proxy logs are eligible: observations are
 * written in the same breath as the success log (C4), so matching a
 * failed/retried log — or a log whose status is unknown — would only ever
 * surface a neighbour's upstream (also when `sample_rate < 1` hides the
 * request that produced the observation). Skipped lookups stay out of the F2
 * match metrics: they are not part of the ±2s population.
 *
 * `observation === null` + `candidateCount === 0` -> no observation in the
 * window (never observed, pruned, detection disabled, or skipped status).
 * `observation === null` + `candidateCount > 1` -> ambiguous window; the caller
 * must not guess between candidates.
 */
export async function findUpstreamProviderObservationForProxyLog(
  key: UpstreamProviderProxyLogMatchKey,
  nowMs = Date.now(),
): Promise<UpstreamProviderObservationDetailMatch> {
  if (normalizeStatus(key.status) !== 'success') {
    return { observation: null, candidateCount: 0, windowFrom: null, windowTo: null };
  }

  const accountId = toPositiveInt(key.accountId);
  const channelId = toPositiveInt(key.channelId);
  const requestedModel = normalizeModelKey(key.requestedModel);
  const createdAt = parseStoredUtcDateTime(key.createdAt ?? null);

  if (accountId == null || channelId == null || !requestedModel || !createdAt) {
    recordDetailMatchOutcome('incompleteKey', nowMs);
    return { observation: null, candidateCount: 0, windowFrom: null, windowTo: null };
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
  ];
  // F1 optional narrowing: only apply when the proxy log has an explicit
  // boolean, so legacy rows without `is_stream` keep matching.
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
    };
  }

  recordDetailMatchOutcome(candidates.length === 0 ? 'miss' : 'ambiguous', nowMs);
  return {
    observation: null,
    candidateCount: candidates.length,
    windowFrom,
    windowTo,
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
