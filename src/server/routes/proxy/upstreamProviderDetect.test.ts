import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../config.js';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';
import nonStreamFixture from '../../services/upstreamProviderDetect/fixtures/cline-chat-completion-nonstream.sample.json' with { type: 'json' };
import streamFinalChunkFixture from '../../services/upstreamProviderDetect/fixtures/cline-chat-stream-final-chunk.sample.json' with { type: 'json' };
import streamFirstChunkFixture from '../../services/upstreamProviderDetect/fixtures/cline-chat-stream-first-chunk.sample.json' with { type: 'json' };

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const estimateProxyCostMock = vi.fn(async (_arg?: any) => 0);
const buildProxyBillingDetailsMock = vi.fn(async (_arg?: any) => null);
const fetchModelPricingCatalogMock = vi.fn(async (_arg?: any): Promise<any> => null);
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
  invalidateTokenRouterCache: vi.fn(),
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
  buildProxyBillingDetails: (arg: any) => buildProxyBillingDetailsMock(arg),
  fetchModelPricingCatalog: (arg: any) => fetchModelPricingCatalogMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: () => false,
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

type DbModule = typeof import('../../db/index.js');

// Must run before the static `config` import is evaluated so the sqlite runtime
// DB (config.dataDir) points at a test-only directory instead of repo `data/`.
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/upstream-provider-detect-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

/**
 * 阶段 2 验收：总开关 + 参与站点命中 + 采样命中时流式/非流式各落 1 行，其余情况 0 行。
 *
 * C4 口径：观测行与成功 proxy log 同生共死——只有最终成功、且已写入成功 proxy log
 * 的那一次请求才写观测行；下游断开/上游流断裂/失败响应都不会产生观测行。
 */
describe('upstream provider detection bypass', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  const dataDir = testDataDir;
  const originalDetectSettings = {
    enabled: config.upstreamProviderDetectEnabled,
    sampleRate: config.upstreamProviderDetectSampleRate,
    retentionDays: config.upstreamProviderDetectRetentionDays,
    siteIds: config.upstreamProviderDetectSiteIds,
  };

  const createSseResponse = (chunks: string[], status = 200) => {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }), {
      status,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };

  async function seedSite(input: { url: string; platform?: string }) {
    const site = await db.insert(schema.sites).values({
      name: `site-${input.url}`,
      url: input.url,
      platform: input.platform ?? 'openai',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${site.id}`,
      accessToken: '',
      apiToken: 'sk-cline',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: `${input.url.replace(/\/+$/, '')}/api`,
      enabled: true,
      sortOrder: 0,
    }).run();
    return { site, account };
  }

  function selectSeededChannel(seeded: { site: any; account: any }) {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: seeded.site,
      account: seeded.account,
      tokenName: 'default',
      tokenValue: 'sk-cline',
      actualModel: 'deepseek/deepseek-v4.1-flash',
    });
  }

  async function readObservations() {
    return await db.select().from(schema.upstreamProviderObservations).all();
  }

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;

    const routesModule = await import('./chat.js');
    app = Fastify();
    await app.register(routesModule.chatProxyRoute);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    estimateProxyCostMock.mockClear();
    buildProxyBillingDetailsMock.mockClear();
    fetchModelPricingCatalogMock.mockClear();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    resetUpstreamEndpointRuntimeState();

    config.upstreamProviderDetectEnabled = true;
    config.upstreamProviderDetectSampleRate = 1;
    config.upstreamProviderDetectRetentionDays = 14;
    // 默认未勾选任何参与站点：各用例在 seed 站点后显式配置。
    config.upstreamProviderDetectSiteIds = [];
    config.proxyErrorKeywords = [];
    config.proxyEmptyContentFailEnabled = false;
    (config as any).openAiServiceTierRules = undefined;
    (config as any).disableCrossProtocolFallback = false;

    selectNextChannelMock.mockReturnValue(null);
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 34,
      completionTokens: 14,
      totalTokens: 48,
      usageSource: 'upstream',
      estimatedCostFromQuota: 0,
      recoveredFromSelfLog: false,
    });

    await db.delete(schema.upstreamProviderObservations).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    await closeDbConnections();
    delete process.env.DATA_DIR;
    config.upstreamProviderDetectEnabled = originalDetectSettings.enabled;
    config.upstreamProviderDetectSampleRate = originalDetectSettings.sampleRate;
    config.upstreamProviderDetectRetentionDays = originalDetectSettings.retentionDays;
    config.upstreamProviderDetectSiteIds = originalDetectSettings.siteIds;
    rmSync(resolve(dataDir), { recursive: true, force: true });
  });

  it('writes one observation for a successful non-stream chat request', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderDetectSiteIds = [seeded.site.id];
    selectSeededChannel(seeded);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(nonStreamFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer downstream-key' },
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);

    const rows = await readObservations();
    expect(rows, JSON.stringify(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      proxyLogId: null,
      siteId: seeded.site.id,
      accountId: seeded.account.id,
      routeId: 22,
      channelId: 11,
      requestedModel: 'deepseek/deepseek-v4.1-flash',
      actualModel: 'deepseek/deepseek-v4.1-flash',
      isStream: false,
      parserId: 'cline-gateway',
      parserVersion: 1,
      finalProvider: 'deepseek',
      resolvedProvider: 'deepseek',
      canonicalSlug: 'deepseek/deepseek-v4.1-flash',
      originalModelId: 'deepseek/deepseek-v4.1-flash',
      affinityOutcome: 'confirmed',
      affinityPinnedProvider: 'deepseek',
      clientSessionId: 'sess-4d605219a573c92da07b4d11786413c8',
      clientSessionIdSource: 'explicit',
      fallbackCount: 15,
      attemptsTruncated: 0,
      modelAttemptCount: 1,
      totalProviderAttemptCount: 1,
      cacheHitTokens: 0,
      cacheMissTokens: 34,
      usageCost: 0.0000135,
      usageGatewayCost: 0.000027,
      usageMarketCost: 0.000027,
      gatewayCostText: '0.000027',
      gatewayInferenceCostText: '0.000027',
      gatewayGenerationId: 'gen_01M3BKQJW7VBXF3CAJGGKNP2WA',
    });
    expect(JSON.parse(rows[0].fallbacksJson ?? '[]')).toHaveLength(15);
    expect(rows[0].modelAttemptsJson).toContain('deepseek');
    expect(rows[0].modelAttemptsJson).not.toContain('providerRequestId');

    // 旁路不改成功日志本身
    const logs = await db.select().from(schema.proxyLogs).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'success', httpStatus: 200, isStream: false });
  });

  it('writes one observation for a successful streamed chat request without changing SSE bytes', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderDetectSiteIds = [seeded.site.id];
    selectSeededChannel(seeded);
    fetchMock.mockResolvedValue(createSseResponse([
      `data: ${JSON.stringify(streamFirstChunkFixture)}\n\n`,
      `data: ${JSON.stringify(streamFinalChunkFixture)}\n\n`,
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer downstream-key' },
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: [DONE]');
    expect(response.body).not.toContain('provider_metadata');

    const rows = await readObservations();
    expect(rows, JSON.stringify(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      siteId: seeded.site.id,
      isStream: true,
      finalProvider: 'deepseek',
      clientSessionId: 'sess-4d605219a573c92da07b4d11786413c8',
      cacheMissTokens: 34,
      fallbackCount: 15,
      gatewayGenerationId: 'gen_01M3BM0EVD723255539TXJAGCC',
    });

    const logs = await db.select().from(schema.proxyLogs).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'success', httpStatus: 200, isStream: true });
  });

  it('writes nothing when the master switch is off', async () => {
    config.upstreamProviderDetectEnabled = false;
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderDetectSiteIds = [seeded.site.id];
    selectSeededChannel(seeded);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(nonStreamFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await readObservations()).toHaveLength(0);
    expect(await db.select().from(schema.proxyLogs).all()).toHaveLength(1);
  });

  it('writes nothing for a site that is not in the participating-site selection', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderDetectSiteIds = [seeded.site.id + 1000];
    selectSeededChannel(seeded);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(nonStreamFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await readObservations()).toHaveLength(0);
  });

  it('writes nothing when no participating site is selected (default)', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderDetectSiteIds = [];
    selectSeededChannel(seeded);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(nonStreamFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await readObservations()).toHaveLength(0);
  });

  it('writes nothing when the upstream stream breaks before completion (co-life with the success log)', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderDetectSiteIds = [seeded.site.id];
    selectSeededChannel(seeded);
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(streamFirstChunkFixture)}\n\n`));
        // Metadata frame arrives before the stream breaks: the collector saw it,
        // but a failed stream writes no success proxy log, so it must write no
        // observation row either (C4: co-life with the success log).
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(streamFinalChunkFixture)}\n\n`));
        controller.error(new Error('client disconnected'));
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(await readObservations()).toHaveLength(0);
  });

  it('writes nothing for failed upstream responses', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderDetectSiteIds = [seeded.site.id];
    selectSeededChannel(seeded);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'upstream exploded', type: 'server_error' },
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(await readObservations()).toHaveLength(0);
  });
});
