/**
 * Persistence for upstream-provider observations.
 *
 * Writes are strictly additive and never touch `proxy_logs`:
 * `insertProxyLog` keeps its signature, `proxy_log_id` stays null in v1, and
 * the observation is written after the success log has been recorded. Insert
 * failures are warned once and never propagate to the proxy request.
 */

import { lt } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { formatUtcSqlDateTime } from '../localTimeService.js';
import type { UpstreamProviderObservation, UpstreamProviderModelAttemptSummary } from './parse.js';

const MODEL_ATTEMPTS_JSON_MAX_BYTES = 8 * 1024;
const CLIENT_SESSION_ID_MAX_LENGTH = 256;
const DAY_MS = 24 * 60 * 60 * 1000;

let persistWarningLogged = false;

export type UpstreamProviderObservationContext = {
  observation: UpstreamProviderObservation | null;
  siteId?: number | null;
  accountId?: number | null;
  routeId?: number | null;
  channelId?: number | null;
  downstreamApiKeyId?: number | null;
  requestedModel?: string | null;
  actualModel?: string | null;
  upstreamPath?: string | null;
  isStream?: boolean | null;
  createdAtMs?: number;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Keeps the attempts summary valid JSON while respecting the 8KB cap by
 * dropping trailing attempt entries only (D2). Byte slicing is never used, so
 * MySQL JSON / PG JSONB always receive parseable JSON; in the pathological
 * case where a single entry alone exceeds the cap the summary degrades to `[]`
 * (still valid JSON, still within the cap).
 */
export function serializeModelAttemptsForStorage(
  summary: UpstreamProviderModelAttemptSummary[],
): { json: string; truncated: boolean } {
  let attempts = summary;
  let json = JSON.stringify(attempts);
  let truncated = false;

  while (attempts.length > 0 && byteLength(json) > MODEL_ATTEMPTS_JSON_MAX_BYTES) {
    truncated = true;
    attempts = attempts.slice(0, attempts.length - 1);
    json = JSON.stringify(attempts);
  }

  return { json, truncated };
}

/** D3: `clientSessionId` is an upstream-provided affiliate id, clamp before insert. */
function truncateClientSessionId(value: string | null): string | null {
  if (!value || value.length <= CLIENT_SESSION_ID_MAX_LENGTH) return value;
  return value.slice(0, CLIENT_SESSION_ID_MAX_LENGTH);
}

/**
 * Persists one observation, returning `false` when there is nothing to write
 * (gate inactive / payload had no routing) or when the write failed.
 */
export async function persistUpstreamProviderObservation(
  input: UpstreamProviderObservationContext,
): Promise<boolean> {
  const observation = input.observation;
  if (!observation) return false;

  try {
    const fallbacksAvailable = observation.fallbacksAvailable;
    const attempts = serializeModelAttemptsForStorage(observation.modelAttemptsSummary);

    await db.insert(schema.upstreamProviderObservations).values({
      proxyLogId: null,
      siteId: input.siteId ?? null,
      accountId: input.accountId ?? null,
      routeId: input.routeId ?? null,
      channelId: input.channelId ?? null,
      downstreamApiKeyId: input.downstreamApiKeyId ?? null,
      requestedModel: input.requestedModel ?? null,
      actualModel: input.actualModel ?? null,
      upstreamPath: input.upstreamPath ?? null,
      isStream: input.isStream ?? null,
      parserId: observation.parserId,
      parserVersion: observation.parserVersion,
      finalProvider: observation.finalProvider,
      resolvedProvider: observation.resolvedProvider,
      canonicalSlug: observation.canonicalSlug,
      originalModelId: observation.originalModelId,
      affinityOutcome: observation.affinityOutcome,
      affinityPinnedProvider: observation.affinityPinnedProvider,
      clientSessionId: truncateClientSessionId(observation.clientSessionId),
      clientSessionIdSource: observation.clientSessionIdSource,
      fallbacksJson: fallbacksAvailable ? JSON.stringify(fallbacksAvailable) : null,
      fallbackCount: observation.fallbackCount,
      modelAttemptsJson: attempts.json,
      attemptsTruncated: attempts.truncated ? 1 : 0,
      modelAttemptCount: observation.modelAttemptCount,
      totalProviderAttemptCount: observation.totalProviderAttemptCount,
      cacheHitTokens: observation.cacheHitTokens,
      cacheMissTokens: observation.cacheMissTokens,
      systemFingerprint: observation.systemFingerprint,
      usageCost: observation.usageCost,
      usageGatewayCost: observation.usageGatewayCost,
      usageMarketCost: observation.usageMarketCost,
      // v1 决策（主代理裁定）：gatewayCostNumber / gatewayInferenceCostNumber 只是
      // 解析便利视图，不落库；成本以 text 列为准，避免文本/数值双真相。
      gatewayCostText: observation.gatewayCostText,
      gatewayInferenceCostText: observation.gatewayInferenceCostText,
      gatewayGenerationId: observation.gatewayGenerationId,
      createdAt: formatUtcSqlDateTime(new Date(input.createdAtMs ?? Date.now())),
    }).run();
    return true;
  } catch (error) {
    if (!persistWarningLogged) {
      persistWarningLogged = true;
      console.warn('[upstream-provider-detect] failed to persist observation', error);
    }
    return false;
  }
}

export type UpstreamProviderObservationPruneResult = {
  enabled: boolean;
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
};

/** Retention is independent from proxy-log/usage cleanup; `<= 0` disables it. */
export async function pruneUpstreamProviderObservations(
  retentionDays: number = config.upstreamProviderDetectRetentionDays,
  nowMs = Date.now(),
): Promise<UpstreamProviderObservationPruneResult> {
  const normalizedDays = Number.isFinite(retentionDays) ? Math.max(0, Math.trunc(retentionDays)) : 0;
  if (normalizedDays <= 0) {
    return {
      enabled: false,
      retentionDays: normalizedDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const cutoffUtc = formatUtcSqlDateTime(new Date(nowMs - normalizedDays * DAY_MS));
  const deleted = (
    await db.delete(schema.upstreamProviderObservations)
      .where(lt(schema.upstreamProviderObservations.createdAt, cutoffUtc))
      .run()
  ).changes;

  return {
    enabled: true,
    retentionDays: normalizedDays,
    cutoffUtc,
    deleted,
  };
}
