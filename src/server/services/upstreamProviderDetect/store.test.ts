import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatUtcSqlDateTime } from '../localTimeService.js';
import type { UpstreamProviderObservation } from './parse.js';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('./store.js');

// Must run before the static imports are evaluated so the sqlite runtime DB
// (config.dataDir) points at a test-only directory instead of repo `data/`.
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/upstream-provider-detect-store-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

const DAY_MS = 24 * 60 * 60 * 1000;

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
    clientSessionId: 'sess-1',
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
    systemFingerprint: 'fp-test',
    usageCost: 0.0000135,
    usageGatewayCost: 0.000027,
    usageMarketCost: 0.000027,
    gatewayCostText: '0.000027',
    gatewayCostNumber: 0.000027,
    gatewayInferenceCostText: '0.000027',
    gatewayInferenceCostNumber: 0.000027,
    gatewayGenerationId: 'gen_test',
    ...overrides,
  };
}

describe('upstreamProviderDetect store', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let persistUpstreamProviderObservation: StoreModule['persistUpstreamProviderObservation'];
  let pruneUpstreamProviderObservations: StoreModule['pruneUpstreamProviderObservations'];
  let serializeModelAttemptsForStorage: StoreModule['serializeModelAttemptsForStorage'];

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const storeModule = await import('./store.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    persistUpstreamProviderObservation = storeModule.persistUpstreamProviderObservation;
    pruneUpstreamProviderObservations = storeModule.pruneUpstreamProviderObservations;
    serializeModelAttemptsForStorage = storeModule.serializeModelAttemptsForStorage;
  });

  beforeEach(async () => {
    await db.delete(schema.upstreamProviderObservations).run();
  });

  afterAll(async () => {
    await closeDbConnections();
    delete process.env.DATA_DIR;
    rmSync(resolve(testDataDir), { recursive: true, force: true });
  });

  it('persists the observation summary and reads every column back', async () => {
    const written = await persistUpstreamProviderObservation({
      observation: buildObservation(),
      siteId: 7,
      accountId: 8,
      routeId: 9,
      channelId: 10,
      downstreamApiKeyId: 11,
      requestedModel: 'deepseek/deepseek-v4.1-flash',
      actualModel: 'deepseek/deepseek-v4.1-flash',
      upstreamPath: '/v1/chat/completions',
      isStream: false,
      createdAtMs: Date.UTC(2026, 8, 25, 7, 0, 0),
    });
    expect(written).toBe(true);

    const rows = await db.select().from(schema.upstreamProviderObservations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      proxyLogId: null,
      siteId: 7,
      accountId: 8,
      routeId: 9,
      channelId: 10,
      downstreamApiKeyId: 11,
      requestedModel: 'deepseek/deepseek-v4.1-flash',
      actualModel: 'deepseek/deepseek-v4.1-flash',
      upstreamPath: '/v1/chat/completions',
      isStream: false,
      parserId: 'cline-gateway',
      parserVersion: 1,
      finalProvider: 'deepseek',
      resolvedProvider: 'deepseek',
      canonicalSlug: 'deepseek/deepseek-v4.1-flash',
      originalModelId: 'deepseek/deepseek-v4.1-flash',
      affinityOutcome: 'confirmed',
      affinityPinnedProvider: 'deepseek',
      clientSessionId: 'sess-1',
      clientSessionIdSource: 'explicit',
      fallbackCount: 2,
      attemptsTruncated: 0,
      modelAttemptCount: 1,
      totalProviderAttemptCount: 1,
      cacheHitTokens: 0,
      cacheMissTokens: 34,
      systemFingerprint: 'fp-test',
      usageCost: 0.0000135,
      usageGatewayCost: 0.000027,
      usageMarketCost: 0.000027,
      gatewayCostText: '0.000027',
      gatewayInferenceCostText: '0.000027',
      gatewayGenerationId: 'gen_test',
      createdAt: '2026-09-25 07:00:00',
    });
    expect(JSON.parse(rows[0].fallbacksJson ?? '[]')).toEqual(['alibaba', 'baseten']);
    expect(JSON.parse(rows[0].modelAttemptsJson ?? '[]')).toEqual([{
      canonicalSlug: 'deepseek/deepseek-v4.1-flash',
      success: true,
      providerAttemptCount: 1,
      providers: [{ provider: 'deepseek', credentialType: 'system', statusCode: 200, success: true }],
    }]);
  });

  it('skips insertion when there is no observation', async () => {
    expect(await persistUpstreamProviderObservation({ observation: null })).toBe(false);
    expect(await db.select().from(schema.upstreamProviderObservations).all()).toHaveLength(0);
  });

  it('persists null summaries without fake values', async () => {
    await persistUpstreamProviderObservation({
      observation: buildObservation({
        fallbacksAvailable: null,
        fallbackCount: null,
        modelAttemptsSummary: [],
        cacheHitTokens: null,
        cacheMissTokens: null,
        systemFingerprint: null,
        affinityOutcome: null,
        affinityPinnedProvider: null,
        clientSessionId: null,
        clientSessionIdSource: null,
        usageCost: null,
        usageGatewayCost: null,
        usageMarketCost: null,
        gatewayCostText: null,
        gatewayInferenceCostText: null,
        gatewayGenerationId: null,
      }),
    });

    const rows = await db.select().from(schema.upstreamProviderObservations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fallbacksJson: null,
      fallbackCount: null,
      cacheHitTokens: null,
      cacheMissTokens: null,
      gatewayCostText: null,
      usageCost: null,
    });
  });

  it('truncates oversized attempts summaries while keeping valid JSON', () => {
    const bigAttempts = Array.from({ length: 40 }, (_value, index) => ({
      canonicalSlug: `provider/model-${index}-${'x'.repeat(400)}`,
      success: true,
      providerAttemptCount: 1,
      providers: [{ provider: `provider-${index}`, credentialType: 'system', statusCode: 200, success: true }],
    }));

    const result = serializeModelAttemptsForStorage(bigAttempts);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.json, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    const parsed = JSON.parse(result.json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it('keeps small attempts summaries untouched', () => {
    const summary = buildObservation().modelAttemptsSummary;
    const result = serializeModelAttemptsForStorage(summary);
    expect(result.truncated).toBe(false);
    expect(JSON.parse(result.json)).toEqual(summary);
  });

  it('never byte-slices attempts JSON: a single oversized entry degrades to an empty array (D2)', () => {
    const oversizedSingle = [{
      canonicalSlug: 'x'.repeat(20 * 1024),
      success: true,
      providerAttemptCount: 1,
      providers: [],
    }];

    const result = serializeModelAttemptsForStorage(oversizedSingle);
    expect(result.truncated).toBe(true);
    expect(result.json).toBe('[]');
    expect(JSON.parse(result.json)).toEqual([]);
  });

  it('clamps clientSessionId to 256 characters before insert (D3)', async () => {
    await persistUpstreamProviderObservation({
      observation: buildObservation({ clientSessionId: 's'.repeat(300), clientSessionIdSource: 'explicit' }),
    });

    const rows = await db.select().from(schema.upstreamProviderObservations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].clientSessionId).toBe('s'.repeat(256));
  });

  it('prunes rows older than the retention window and keeps fresh rows', async () => {
    const nowMs = Date.UTC(2026, 8, 25, 7, 0, 0);
    await persistUpstreamProviderObservation({
      observation: buildObservation(),
      createdAtMs: nowMs - 15 * DAY_MS,
    });
    await persistUpstreamProviderObservation({
      observation: buildObservation(),
      createdAtMs: nowMs - 1 * DAY_MS,
    });

    const result = await pruneUpstreamProviderObservations(14, nowMs);
    expect(result.enabled).toBe(true);
    expect(result.deleted).toBe(1);
    expect(result.cutoffUtc).toBe(formatUtcSqlDateTime(new Date(nowMs - 14 * DAY_MS)));

    const rows = await db.select().from(schema.upstreamProviderObservations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe(formatUtcSqlDateTime(new Date(nowMs - 1 * DAY_MS)));
  });

  it('disables pruning when retention is not positive', async () => {
    await persistUpstreamProviderObservation({
      observation: buildObservation(),
      createdAtMs: Date.UTC(2026, 0, 1),
    });

    const result = await pruneUpstreamProviderObservations(0);
    expect(result).toMatchObject({ enabled: false, deleted: 0, cutoffUtc: null });
    expect(await db.select().from(schema.upstreamProviderObservations).all()).toHaveLength(1);
  });
});
