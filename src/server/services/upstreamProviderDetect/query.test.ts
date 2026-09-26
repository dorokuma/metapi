import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatUtcSqlDateTime } from '../localTimeService.js';
import type { UpstreamProviderObservation } from './parse.js';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('./store.js');
type QueryModule = typeof import('./query.js');

// Must run before the static imports are evaluated so the sqlite runtime DB
// (config.dataDir) points at a test-only directory instead of repo `data/`.
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/upstream-provider-detect-query-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 8, 25, 7, 0, 0);
const BASE_UTC = formatUtcSqlDateTime(new Date(BASE_MS));

function buildObservation(overrides: Partial<UpstreamProviderObservation> = {}): UpstreamProviderObservation {
  return {
    parserId: 'cline-gateway',
    parserVersion: 1,
    finalProvider: 'deepseek',
    resolvedProvider: 'deepseek',
    canonicalSlug: 'deepseek/deepseek-v4.1-flash',
    originalModelId: 'deepseek/deepseek-v4.1-flash',
    affinityOutcome: 'confirmed',
    affinityPinnedProvider: 'deepseek',
    clientSessionId: 'sess-query-1',
    clientSessionIdSource: 'explicit',
    fallbacksAvailable: ['alibaba', 'baseten'],
    fallbackCount: 2,
    modelAttemptsSummary: [{
      canonicalSlug: 'deepseek/deepseek-v4.1-flash',
      success: true,
      providerAttemptCount: 1,
      providers: [{ provider: 'deepseek', credentialType: 'system', statusCode: 200, success: true }],
    }],
    modelAttemptCount: 1,
    totalProviderAttemptCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 34,
    systemFingerprint: 'fp-query',
    usageCost: 0.0000135,
    usageGatewayCost: 0.000027,
    usageMarketCost: 0.000027,
    gatewayCostText: '0.000027',
    gatewayCostNumber: 0.000027,
    gatewayInferenceCostText: '0.000027',
    gatewayInferenceCostNumber: 0.000027,
    gatewayGenerationId: 'gen_query',
    ...overrides,
  };
}

describe('upstreamProviderDetect query', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let persistUpstreamProviderObservation: StoreModule['persistUpstreamProviderObservation'];
  let query: QueryModule;

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const storeModule = await import('./store.js');
    query = await import('./query.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    persistUpstreamProviderObservation = storeModule.persistUpstreamProviderObservation;
  });

  beforeEach(async () => {
    await db.delete(schema.upstreamProviderObservations).run();
    query.resetUpstreamProviderObservationMatchMetrics(BASE_MS);
  });

  afterAll(async () => {
    await closeDbConnections();
    delete process.env.DATA_DIR;
    rmSync(resolve(testDataDir), { recursive: true, force: true });
  });

  describe('detail matching (F1)', () => {
    const matchKey = {
      accountId: 8,
      channelId: 11,
      requestedModel: 'deepseek/deepseek-v4.1-flash',
      createdAt: BASE_UTC,
      isStream: false,
      status: 'success',
    };

    it('returns the unique observation inside the ±2s window without a proxy_log_id', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        siteId: 7,
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
      });

      const match = await query.findUpstreamProviderObservationForProxyLog(matchKey, BASE_MS);

      expect(match.candidateCount).toBe(1);
      expect(match.windowFrom).toBe(formatUtcSqlDateTime(new Date(BASE_MS - 2_000)));
      expect(match.windowTo).toBe(formatUtcSqlDateTime(new Date(BASE_MS + 2_000)));
      expect(match.observation).toMatchObject({
        proxyLogId: null,
        siteId: 7,
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        finalProvider: 'deepseek',
        canonicalSlug: 'deepseek/deepseek-v4.1-flash',
        affinityOutcome: 'confirmed',
        affinityPinnedProvider: 'deepseek',
        clientSessionId: 'sess-query-1',
        cacheMissTokens: 34,
        usageCost: 0.0000135,
        gatewayCostText: '0.000027',
        gatewayGenerationId: 'gen_query',
        attemptsTruncated: false,
      });
      expect(match.observation?.fallbacks).toEqual(['alibaba', 'baseten']);
      expect(match.observation?.modelAttempts?.[0]?.providers[0]).toMatchObject({
        provider: 'deepseek',
        statusCode: 200,
      });

      const metrics = query.getUpstreamProviderObservationMatchMetrics();
      expect(metrics).toMatchObject({ evaluated: 1, uniqueHits: 1, ambiguous: 0, misses: 0 });
      expect(metrics.ambiguousRate).toBe(0);
    });

    it('matches at +2s and rejects +3s (window boundary)', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS + 2_000,
      });

      const inside = await query.findUpstreamProviderObservationForProxyLog(matchKey, BASE_MS);
      expect(inside.observation).not.toBeNull();

      await db.delete(schema.upstreamProviderObservations).run();
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS + 3_000,
      });

      const outside = await query.findUpstreamProviderObservationForProxyLog(matchKey, BASE_MS);
      expect(outside.observation).toBeNull();
      expect(outside.candidateCount).toBe(0);
    });

    it('returns null (no guessing) when two observations fall into the same window', async () => {
      for (const createdAtMs of [BASE_MS - 1_000, BASE_MS + 1_000]) {
        await persistUpstreamProviderObservation({
          observation: buildObservation(),
          accountId: 8,
          channelId: 11,
          requestedModel: 'deepseek/deepseek-v4.1-flash',
          isStream: false,
          createdAtMs,
        });
      }

      const match = await query.findUpstreamProviderObservationForProxyLog(matchKey, BASE_MS);

      expect(match.observation).toBeNull();
      expect(match.candidateCount).toBe(2);
      const metrics = query.getUpstreamProviderObservationMatchMetrics();
      expect(metrics).toMatchObject({ evaluated: 1, uniqueHits: 0, ambiguous: 1, misses: 0 });
      expect(metrics.ambiguousRate).toBe(1);
      expect(metrics.hardLinkSuggested).toBe(true);
    });

    it('uses is_stream as a narrowing key so a stream/non-stream pair stays unique', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ cacheMissTokens: 99 }),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: true,
        createdAtMs: BASE_MS,
      });

      const nonStream = await query.findUpstreamProviderObservationForProxyLog(matchKey, BASE_MS);
      expect(nonStream.candidateCount).toBe(1);
      expect(nonStream.observation?.isStream).toBe(false);
      expect(nonStream.observation?.cacheMissTokens).toBe(34);

      const stream = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, isStream: true },
        BASE_MS,
      );
      expect(stream.candidateCount).toBe(1);
      expect(stream.observation?.isStream).toBe(true);
      expect(stream.observation?.cacheMissTokens).toBe(99);

      // Without the narrowing key the same window is ambiguous — the reason
      // is_stream is part of the match when the proxy log has it.
      const ambiguous = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, isStream: null },
        BASE_MS,
      );
      expect(ambiguous.observation).toBeNull();
      expect(ambiguous.candidateCount).toBe(2);
    });

    it('returns null for a non-success log even when a unique observation sits in the window', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
      });

      // Observations only exist for success logs, so a failed log must never
      // borrow the neighbour's upstream (unique-but-wrong) — and the skipped
      // lookup is not part of the F2 ±2s population.
      for (const status of ['failed', 'retried', null, 'SUCCESS']) {
        const match = await query.findUpstreamProviderObservationForProxyLog(
          { ...matchKey, status },
          BASE_MS,
        );
        if (status === 'SUCCESS') {
          expect(match.observation?.finalProvider).toBe('deepseek');
        } else {
          expect(match.observation).toBeNull();
          expect(match.candidateCount).toBe(0);
          expect(match.windowFrom).toBeNull();
        }
      }
      const metrics = query.getUpstreamProviderObservationMatchMetrics();
      expect(metrics).toMatchObject({ evaluated: 1, uniqueHits: 1, incompleteKey: 0 });
    });

    it('counts incomplete keys separately and never queries the window', async () => {
      const match = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, channelId: null },
        BASE_MS,
      );

      expect(match.observation).toBeNull();
      expect(match.candidateCount).toBe(0);
      expect(match.windowFrom).toBeNull();
      const metrics = query.getUpstreamProviderObservationMatchMetrics();
      expect(metrics).toMatchObject({ evaluated: 0, incompleteKey: 1 });
    });

    it('records a zero-hit outcome when nothing exists in the window', async () => {
      const match = await query.findUpstreamProviderObservationForProxyLog(matchKey, BASE_MS);
      expect(match.observation).toBeNull();
      expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
        evaluated: 1,
        uniqueHits: 0,
        ambiguous: 0,
        misses: 1,
      });
    });

    it('skips the hard lookup for a non-success log even when the id matches', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
        proxyLogId: 999,
      });

      const match = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, status: 'failed', proxyLogId: 999 },
        BASE_MS,
      );

      expect(match.observation).toBeNull();
      expect(match.candidateCount).toBe(0);
      expect(match.matchKind).toBe('skipped');
      expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
        evaluated: 0,
        hardHits: 0,
        hardAnomaly: 0,
        hardAmbiguous: 0,
      });
    });

    it('returns a hard hit by id without a window and without complete keys', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
        proxyLogId: 999,
      });

      // createdAt is an hour away from the row and the account key is missing on
      // the log side: neither blocks a hard id hit.
      const match = await query.findUpstreamProviderObservationForProxyLog(
        {
          ...matchKey,
          accountId: null,
          createdAt: formatUtcSqlDateTime(new Date(BASE_MS + 60 * 60 * 1000)),
          proxyLogId: 999,
        },
        BASE_MS,
      );

      expect(match.matchKind).toBe('hard');
      expect(match.candidateCount).toBe(1);
      expect(match.windowFrom).toBeNull();
      expect(match.windowTo).toBeNull();
      expect(match.observation?.finalProvider).toBe('deepseek');
      expect(match.observation?.proxyLogId).toBe(999);
      const metrics = query.getUpstreamProviderObservationMatchMetrics();
      expect(metrics).toMatchObject({
        hardHits: 1,
        hardAnomaly: 0,
        hardAmbiguous: 0,
        evaluated: 0,
        uniqueHits: 0,
        ambiguous: 0,
        misses: 0,
      });
      expect(metrics.ambiguousRate).toBe(0);
    });

    it('withholds a hard hit when a present key column disagrees (account, channel, model, stream)', async () => {
      const cases = [
        { rowPatch: { accountId: 9 } },
        { rowPatch: { channelId: 12 } },
        { rowPatch: { requestedModel: 'other/model' } },
        { rowPatch: { isStream: true } },
      ] as const;

      for (const { rowPatch } of cases) {
        await db.delete(schema.upstreamProviderObservations).run();
        query.resetUpstreamProviderObservationMatchMetrics(BASE_MS);

        await persistUpstreamProviderObservation({
          observation: buildObservation({ cacheMissTokens: 77 }),
          accountId: 8,
          channelId: 11,
          requestedModel: 'deepseek/deepseek-v4.1-flash',
          isStream: false,
          createdAtMs: BASE_MS,
          proxyLogId: 999,
          ...rowPatch,
        });
        // A NULL-pinned row sits in the same window: an anomaly must not fall
        // back to it, so this row must never be surfaced either.
        await persistUpstreamProviderObservation({
          observation: buildObservation({ cacheMissTokens: 88 }),
          accountId: 8,
          channelId: 11,
          requestedModel: 'deepseek/deepseek-v4.1-flash',
          isStream: false,
          createdAtMs: BASE_MS - 500,
        });

        const match = await query.findUpstreamProviderObservationForProxyLog(
          { ...matchKey, proxyLogId: 999 },
          BASE_MS,
        );

        expect(match.observation, JSON.stringify(rowPatch)).toBeNull();
        expect(match.candidateCount).toBe(1);
        expect(match.matchKind).toBe('hardAnomaly');
        expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
          hardAnomaly: 1,
          hardHits: 0,
          evaluated: 0,
        });
      }
    });

    it('keeps a hard hit clean when a key column is missing on one side only', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
        proxyLogId: 999,
      });

      // One side missing is not a conflict: no account key on the log, no
      // stream flag on this call, no requested model on the log.
      const match = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, accountId: null, requestedModel: null, isStream: null, proxyLogId: 999 },
        BASE_MS,
      );

      expect(match.matchKind).toBe('hard');
      expect(match.observation?.cacheMissTokens).toBe(34);
      expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
        hardHits: 1,
        hardAnomaly: 0,
        evaluated: 0,
      });
    });

    it('withholds (never guesses) when two observations carry the same proxy_log_id', async () => {
      for (const cacheMissTokens of [11, 22]) {
        await persistUpstreamProviderObservation({
          observation: buildObservation({ cacheMissTokens }),
          accountId: 8,
          channelId: 11,
          requestedModel: 'deepseek/deepseek-v4.1-flash',
          isStream: false,
          createdAtMs: BASE_MS,
          proxyLogId: 999,
        });
      }
      // A NULL row in the window must not be used as a fallback.
      await persistUpstreamProviderObservation({
        observation: buildObservation({ cacheMissTokens: 33 }),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS - 500,
      });

      const match = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, proxyLogId: 999 },
        BASE_MS,
      );

      expect(match.observation).toBeNull();
      expect(match.candidateCount).toBeGreaterThanOrEqual(2);
      expect(match.matchKind).toBe('hardAmbiguous');
      expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
        hardAmbiguous: 1,
        hardHits: 0,
        evaluated: 0,
      });
    });

    it('does not borrow a row already pinned to another proxy log (miss, not a fake unique hit)', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
        proxyLogId: 12345,
      });

      const match = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, proxyLogId: 999 },
        BASE_MS,
      );

      expect(match.observation).toBeNull();
      expect(match.candidateCount).toBe(0);
      expect(match.matchKind).toBe('window');
      expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
        evaluated: 1,
        misses: 1,
        uniqueHits: 0,
        hardHits: 0,
      });
    });

    it('matches the remaining NULL row when a window neighbour is pinned to another log', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation({ cacheMissTokens: 11 }),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS - 500,
        proxyLogId: 12345,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ cacheMissTokens: 22 }),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
      });

      const match = await query.findUpstreamProviderObservationForProxyLog(
        { ...matchKey, proxyLogId: 999 },
        BASE_MS,
      );

      expect(match.candidateCount).toBe(1);
      expect(match.matchKind).toBe('window');
      expect(match.observation?.cacheMissTokens).toBe(22);
      expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
        uniqueHits: 1,
        ambiguous: 0,
        hardHits: 0,
      });
    });
  });

  describe('query windows (F3)', () => {
    it('defaults to the last 7 days and caps explicit windows at 7 days', () => {
      const defaultWindow = query.resolveUpstreamProviderObservationQueryWindow({}, BASE_MS);
      expect(defaultWindow.capped).toBe(false);
      expect(defaultWindow.toUtc).toBe(BASE_UTC);
      expect(defaultWindow.fromUtc).toBe(formatUtcSqlDateTime(new Date(BASE_MS - 7 * DAY_MS)));

      const wideWindow = query.resolveUpstreamProviderObservationQueryWindow({
        from: formatUtcSqlDateTime(new Date(BASE_MS - 30 * DAY_MS)),
        to: BASE_UTC,
      }, BASE_MS);
      expect(wideWindow.capped).toBe(true);
      expect(wideWindow.fromUtc).toBe(formatUtcSqlDateTime(new Date(BASE_MS - 7 * DAY_MS)));

      const reversedWindow = query.resolveUpstreamProviderObservationQueryWindow({
        from: BASE_UTC,
        to: formatUtcSqlDateTime(new Date(BASE_MS - 10 * DAY_MS)),
      }, BASE_MS);
      expect(reversedWindow.capped).toBe(true);
      expect(reversedWindow.fromUtc).toBe(formatUtcSqlDateTime(new Date(BASE_MS - 17 * DAY_MS)));
    });

    it('never returns observations older than the capped window', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation({ finalProvider: 'fresh' }),
        siteId: 7,
        createdAtMs: BASE_MS - 1 * DAY_MS,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ finalProvider: 'stale' }),
        siteId: 7,
        createdAtMs: BASE_MS - 9 * DAY_MS,
      });

      const window = query.resolveUpstreamProviderObservationQueryWindow({}, BASE_MS);
      const rows = await query.loadUpstreamProviderObservationDistribution({
        siteId: 7,
        model: null,
        window,
      });

      expect(rows).toEqual([{
        provider: 'fresh',
        requests: 1,
        cacheHitTokens: 0,
        cacheMissTokens: 34,
      }]);
    });
  });

  describe('distribution aggregate', () => {
    it('groups by provider with request counts and cache sums, ordered by requests desc', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation({ finalProvider: 'deepseek', cacheHitTokens: 10, cacheMissTokens: 20 }),
        siteId: 7,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        createdAtMs: BASE_MS,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ finalProvider: 'deepseek', cacheHitTokens: 0, cacheMissTokens: 34 }),
        siteId: 7,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        createdAtMs: BASE_MS - 60_000,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ finalProvider: 'alibaba', cacheHitTokens: 5, cacheMissTokens: 1 }),
        siteId: 8,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        createdAtMs: BASE_MS - 120_000,
      });
      // Null providers are never surfaced by the distribution view.
      await db.insert(schema.upstreamProviderObservations).values({
        parserId: 'cline-gateway',
        parserVersion: 1,
        finalProvider: null,
        siteId: 7,
        createdAt: BASE_UTC,
      }).run();

      const window = query.resolveUpstreamProviderObservationQueryWindow({}, BASE_MS);
      const all = await query.loadUpstreamProviderObservationDistribution({ window });
      expect(all).toEqual([
        { provider: 'deepseek', requests: 2, cacheHitTokens: 10, cacheMissTokens: 54 },
        { provider: 'alibaba', requests: 1, cacheHitTokens: 5, cacheMissTokens: 1 },
      ]);

      const bySite = await query.loadUpstreamProviderObservationDistribution({ siteId: 7, window });
      expect(bySite).toEqual([
        { provider: 'deepseek', requests: 2, cacheHitTokens: 10, cacheMissTokens: 54 },
      ]);

      const byModel = await query.loadUpstreamProviderObservationDistribution({
        model: 'deepseek/deepseek-v4.1-flash',
        window,
      });
      expect(byModel).toEqual([
        { provider: 'deepseek', requests: 2, cacheHitTokens: 10, cacheMissTokens: 54 },
        { provider: 'alibaba', requests: 1, cacheHitTokens: 5, cacheMissTokens: 1 },
      ]);
    });
  });

  describe('fallbacks aggregate', () => {
    it('takes only the latest row per (site, requested_model, canonical_slug) — no union', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation({
          fallbacksAvailable: ['alibaba', 'baseten', 'fireworks'],
          fallbackCount: 3,
        }),
        siteId: 7,
        requestedModel: 'm1',
        createdAtMs: BASE_MS - 60_000,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({
          fallbacksAvailable: ['baseten'],
          fallbackCount: 1,
        }),
        siteId: 7,
        requestedModel: 'm1',
        createdAtMs: BASE_MS,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({
          canonicalSlug: 'deepseek/deepseek-v4.1',
          fallbacksAvailable: ['openrouter'],
          fallbackCount: 1,
        }),
        siteId: 7,
        requestedModel: 'm1',
        createdAtMs: BASE_MS - 30_000,
      });

      const window = query.resolveUpstreamProviderObservationQueryWindow({
        from: formatUtcSqlDateTime(new Date(BASE_MS - DAY_MS)),
        to: BASE_UTC,
      }, BASE_MS);
      const result = await query.loadUpstreamProviderObservationFallbacks({ siteId: 7, window });

      expect(result.truncated).toBe(false);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        siteId: 7,
        requestedModel: 'm1',
        canonicalSlug: 'deepseek/deepseek-v4.1-flash',
        latestCreatedAt: BASE_UTC,
        fallbacks: ['baseten'],
        fallbackCount: 1,
      });
      expect(result.items[1]).toMatchObject({
        canonicalSlug: 'deepseek/deepseek-v4.1',
        fallbacks: ['openrouter'],
      });
    });

    it('respects the requested_model filter', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation({ fallbacksAvailable: ['a'] }),
        siteId: 7,
        requestedModel: 'm1',
        createdAtMs: BASE_MS,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ fallbacksAvailable: ['b'] }),
        siteId: 7,
        requestedModel: 'm2',
        createdAtMs: BASE_MS,
      });

      const window = query.resolveUpstreamProviderObservationQueryWindow({}, BASE_MS);
      const result = await query.loadUpstreamProviderObservationFallbacks({
        siteId: 7,
        model: 'm2',
        window,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ requestedModel: 'm2', fallbacks: ['b'] });
    });
  });

  describe('sessions aggregate', () => {
    it('returns the provider sequence of one session in ascending time order', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation({ clientSessionId: 'sess-query-1', finalProvider: 'deepseek' }),
        siteId: 7,
        createdAtMs: BASE_MS - 120_000,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ clientSessionId: 'sess-query-1', finalProvider: 'alibaba' }),
        siteId: 7,
        createdAtMs: BASE_MS,
      });
      await persistUpstreamProviderObservation({
        observation: buildObservation({ clientSessionId: 'sess-query-2', finalProvider: 'openai' }),
        siteId: 7,
        createdAtMs: BASE_MS,
      });

      const result = await query.loadUpstreamProviderObservationSession({
        clientSessionId: 'sess-query-1',
      });

      expect(result.clientSessionId).toBe('sess-query-1');
      expect(result.count).toBe(2);
      expect(result.items.map((item) => item.finalProvider)).toEqual(['deepseek', 'alibaba']);
      expect(result.items[0]?.createdAt < result.items[1]?.createdAt).toBe(true);
    });

    it('returns an empty sequence for a blank session id instead of throwing', async () => {
      const result = await query.loadUpstreamProviderObservationSession({ clientSessionId: '   ' });
      expect(result).toEqual({ clientSessionId: '', count: 0, items: [] });
    });
  });

  describe('match metrics', () => {
    it('exposes the F2 counters and the >5% hard-link hint', async () => {
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS,
      });
      const key = {
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        createdAt: BASE_UTC,
        isStream: false,
        status: 'success',
      };

      await query.findUpstreamProviderObservationForProxyLog(key, BASE_MS);
      await persistUpstreamProviderObservation({
        observation: buildObservation(),
        accountId: 8,
        channelId: 11,
        requestedModel: 'deepseek/deepseek-v4.1-flash',
        isStream: false,
        createdAtMs: BASE_MS - 1_000,
      });
      await query.findUpstreamProviderObservationForProxyLog(key, BASE_MS);

      const metrics = query.getUpstreamProviderObservationMatchMetrics();
      expect(metrics).toMatchObject({ evaluated: 2, uniqueHits: 1, ambiguous: 1, misses: 0 });
      expect(metrics.ambiguousRate).toBe(0.5);
      expect(metrics.hardLinkSuggested).toBe(true);

      query.resetUpstreamProviderObservationMatchMetrics(BASE_MS);
      expect(query.getUpstreamProviderObservationMatchMetrics()).toMatchObject({
        evaluated: 0,
        uniqueHits: 0,
        ambiguous: 0,
        misses: 0,
        ambiguousRate: 0,
        hardLinkSuggested: false,
      });
    });
  });
});
