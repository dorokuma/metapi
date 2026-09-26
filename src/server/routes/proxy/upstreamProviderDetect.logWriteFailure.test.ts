import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../config.js';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';
import nonStreamFixture from '../../services/upstreamProviderDetect/fixtures/cline-chat-completion-nonstream.sample.json' with { type: 'json' };

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

// Matrix #4: mock out `insertProxyLog` for this file only. The factory keeps
// every other export of proxyLogStore (`importActual`) so the harness still gets
// the real DB helpers; replacing `db/index.js` or the whole module would break
// `hasProxyLogBillingDetailsColumn` and the sqlite test runtime.
const { insertProxyLogMock } = vi.hoisted(() => ({
  insertProxyLogMock: vi.fn(),
}));

vi.mock('../../services/proxyLogStore.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/proxyLogStore.js')>(
    '../../services/proxyLogStore.js',
  );
  return {
    ...actual,
    insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args),
  };
});

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
  const dir = `tmp/upstream-provider-detect-log-write-failure-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

/**
 * v2.1 写侧行为变更验收（矩阵 #4）：成功日志 insert 抛错时，三态收成
 * `{ written: false }`，观测必须 0 行（今天会落 1 条 NULL 孤儿），且代理响应仍成功。
 * 该断言只在新文件里做，避免文件级 mock 连坐现有 e2e 的「日志仍在」用例。
 */
describe('upstream provider detection when the proxy-log insert fails', () => {
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
    insertProxyLogMock.mockReset();
    resetUpstreamEndpointRuntimeState();

    config.upstreamProviderDetectEnabled = true;
    config.upstreamProviderDetectSampleRate = 1;
    config.upstreamProviderDetectRetentionDays = 14;
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

  it('writes zero observations when the success proxy-log insert rejects, keeping the proxy response successful', async () => {
    insertProxyLogMock.mockRejectedValue(new Error('proxy log insert exploded'));
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
    expect(response.body).toContain('chat.completion');
    expect(insertProxyLogMock).toHaveBeenCalledTimes(1);

    // v2.1 behavior change: `written: false` must not call persist at all, so
    // the orphan NULL observation of the old code must be gone. The proxy log
    // row is absent too (the insert itself is mocked out) — this assertion is
    // intentionally not "the log is still there".
    expect(await db.select().from(schema.upstreamProviderObservations).all()).toHaveLength(0);
    expect(await db.select().from(schema.proxyLogs).all()).toHaveLength(0);
  });
});
