import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { isPublicApiRoute } from '../../desktop.js';
import type { UpstreamProviderObservation } from '../../services/upstreamProviderDetect/parse.js';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('../../services/upstreamProviderDetect/store.js');

// Must run before the static imports are evaluated so the sqlite runtime DB
// (config.dataDir) points at a test-only directory instead of repo `data/`.
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/upstream-provider-observations-route-test-${process.pid}`;
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
    clientSessionId: 'sess-route-1',
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
    systemFingerprint: 'fp-route',
    usageCost: 0.0000135,
    usageGatewayCost: 0.000027,
    usageMarketCost: 0.000027,
    gatewayCostText: '0.000027',
    gatewayCostNumber: 0.000027,
    gatewayInferenceCostText: '0.000027',
    gatewayInferenceCostNumber: 0.000027,
    gatewayGenerationId: 'gen_route',
    ...overrides,
  };
}

describe('upstream observations api', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let persistUpstreamProviderObservation: StoreModule['persistUpstreamProviderObservation'];

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const storeModule = await import('../../services/upstreamProviderDetect/store.js');
    const statsRoutesModule = await import('./stats.js');
    const routesModule = await import('./upstreamObservations.js');

    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    persistUpstreamProviderObservation = storeModule.persistUpstreamProviderObservation;

    app = Fastify();
    await app.register(statsRoutesModule.statsRoutes);
    await app.register(routesModule.upstreamObservationsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.upstreamProviderObservations).run();
    await db.delete(schema.proxyLogs).run();
  });

  afterAll(async () => {
    await app.close();
    await closeDbConnections();
    delete process.env.DATA_DIR;
    rmSync(resolve(testDataDir), { recursive: true, force: true });
  });

  it('is wired into the server and stays behind the global /api auth hook', () => {
    const indexSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    expect(indexSource).toContain("import { upstreamObservationsRoutes } from './routes/api/upstreamObservations.js';");
    expect(indexSource).toContain('await app.register(upstreamObservationsRoutes);');

    expect(isPublicApiRoute('/api/stats/upstream-observations/distribution')).toBe(false);
    expect(isPublicApiRoute('/api/stats/upstream-observations/fallbacks')).toBe(false);
    expect(isPublicApiRoute('/api/stats/upstream-observations/sessions')).toBe(false);
  });

  it('returns the provider distribution for the requested site/model, ordered by requests desc', async () => {
    await persistUpstreamProviderObservation({
      observation: buildObservation({ finalProvider: 'deepseek', cacheHitTokens: 10, cacheMissTokens: 20 }),
      siteId: 7,
      requestedModel: 'm1',
      createdAtMs: BASE_MS,
    });
    await persistUpstreamProviderObservation({
      observation: buildObservation({ finalProvider: 'deepseek', cacheHitTokens: 1, cacheMissTokens: 2 }),
      siteId: 7,
      requestedModel: 'm1',
      createdAtMs: BASE_MS - 30_000,
    });
    await persistUpstreamProviderObservation({
      observation: buildObservation({ finalProvider: 'alibaba', cacheHitTokens: 3, cacheMissTokens: 4 }),
      siteId: 8,
      requestedModel: 'm1',
      createdAtMs: BASE_MS - 30_000,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/upstream-observations/distribution?siteId=7&model=m1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { provider: 'deepseek', requests: 2, cacheHitTokens: 11, cacheMissTokens: 22 },
    ]);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/stats/upstream-observations/distribution?siteId=not-a-number',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('caps the default distribution window at 7 days (F3)', async () => {
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

    const response = await app.inject({
      method: 'GET',
      url: `/api/stats/upstream-observations/distribution?to=${encodeURIComponent(BASE_UTC)}`,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as Array<{ provider: string }>).map((item) => item.provider)).toEqual(['fresh']);
  });

  it('returns the latest channel list per group without unioning older rows', async () => {
    await persistUpstreamProviderObservation({
      observation: buildObservation({ fallbacksAvailable: ['alibaba', 'baseten'], fallbackCount: 2 }),
      siteId: 7,
      requestedModel: 'm1',
      createdAtMs: BASE_MS - 60_000,
    });
    await persistUpstreamProviderObservation({
      observation: buildObservation({ fallbacksAvailable: ['baseten'], fallbackCount: 1 }),
      siteId: 7,
      requestedModel: 'm1',
      createdAtMs: BASE_MS,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/stats/upstream-observations/fallbacks?siteId=7&from=${encodeURIComponent(formatUtcSqlDateTime(new Date(BASE_MS - DAY_MS)))}&to=${encodeURIComponent(BASE_UTC)}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ requestedModel: string | null; fallbacks: string[] | null; latestCreatedAt: string }>;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      requestedModel: 'm1',
      fallbacks: ['baseten'],
      latestCreatedAt: BASE_UTC,
    });
  });

  it('returns one session provider sequence and validates the session id', async () => {
    await persistUpstreamProviderObservation({
      observation: buildObservation({ clientSessionId: 'sess-route-1', finalProvider: 'deepseek' }),
      createdAtMs: BASE_MS - 60_000,
    });
    await persistUpstreamProviderObservation({
      observation: buildObservation({ clientSessionId: 'sess-route-1', finalProvider: 'alibaba' }),
      createdAtMs: BASE_MS,
    });
    await persistUpstreamProviderObservation({
      observation: buildObservation({ clientSessionId: 'sess-route-2', finalProvider: 'openai' }),
      createdAtMs: BASE_MS,
    });

    const missing = await app.inject({
      method: 'GET',
      url: '/api/stats/upstream-observations/sessions',
    });
    expect(missing.statusCode).toBe(400);

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/upstream-observations/sessions?clientSessionId=sess-route-1',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { clientSessionId: string; count: number; items: Array<{ finalProvider: string | null }> };
    expect(body.clientSessionId).toBe('sess-route-1');
    expect(body.count).toBe(2);
    expect(body.items.map((item) => item.finalProvider)).toEqual(['deepseek', 'alibaba']);
  });

  it('attaches the unique ±2s observation to the proxy log detail and null otherwise', async () => {
    const log = await db.insert(schema.proxyLogs).values({
      accountId: 8,
      channelId: 11,
      modelRequested: 'deepseek/deepseek-v4.1-flash',
      modelActual: 'deepseek/deepseek-v4.1-flash',
      status: 'success',
      httpStatus: 200,
      isStream: false,
      createdAt: BASE_UTC,
    }).returning().get();

    await persistUpstreamProviderObservation({
      observation: buildObservation(),
      siteId: 7,
      accountId: 8,
      channelId: 11,
      requestedModel: 'deepseek/deepseek-v4.1-flash',
      isStream: false,
      createdAtMs: BASE_MS,
    });

    const detail = await app.inject({ method: 'GET', url: `/api/stats/proxy-logs/${log.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const detailBody = detail.json() as { upstreamObservation?: { finalProvider?: string | null; fallbacks?: string[] | null; usageCost?: number | null } };
    expect(detailBody.upstreamObservation).toMatchObject({
      finalProvider: 'deepseek',
      fallbacks: ['alibaba', 'baseten'],
      usageCost: 0.0000135,
    });

    // A failed log never matches, even with the same unique observation in the
    // window (status gate in query.ts, wired through the stats detail route).
    const failedLog = await db.insert(schema.proxyLogs).values({
      accountId: 8,
      channelId: 11,
      modelRequested: 'deepseek/deepseek-v4.1-flash',
      modelActual: 'deepseek/deepseek-v4.1-flash',
      status: 'failed',
      httpStatus: 500,
      isStream: false,
      createdAt: BASE_UTC,
    }).returning().get();

    const failed = await app.inject({ method: 'GET', url: `/api/stats/proxy-logs/${failedLog.id}` });
    expect(failed.statusCode, failed.body).toBe(200);
    expect((failed.json() as { upstreamObservation: unknown }).upstreamObservation).toBeNull();

    // Ambiguous window -> null, never a guess.
    await persistUpstreamProviderObservation({
      observation: buildObservation(),
      siteId: 7,
      accountId: 8,
      channelId: 11,
      requestedModel: 'deepseek/deepseek-v4.1-flash',
      isStream: false,
      createdAtMs: BASE_MS - 1_000,
    });
    const ambiguous = await app.inject({ method: 'GET', url: `/api/stats/proxy-logs/${log.id}` });
    expect(ambiguous.statusCode).toBe(200);
    expect((ambiguous.json() as { upstreamObservation: unknown }).upstreamObservation).toBeNull();

    // No observation at all -> null (F4 copy is a UI concern).
    await db.delete(schema.upstreamProviderObservations).run();
    const missing = await app.inject({ method: 'GET', url: `/api/stats/proxy-logs/${log.id}` });
    expect(missing.statusCode).toBe(200);
    expect((missing.json() as { upstreamObservation: unknown }).upstreamObservation).toBeNull();
  });
});
