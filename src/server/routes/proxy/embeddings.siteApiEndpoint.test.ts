import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fetchMock = vi.fn();
const fetchWithObservedFirstByteMock = vi.fn();
const getObservedResponseMetaMock = vi.fn();
const selectChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const insertProxyLogMock = vi.fn();
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn();
const resolveProxyLogBillingMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../proxy-core/firstByteTimeout.js', () => ({
  fetchWithObservedFirstByte: (...args: unknown[]) => fetchWithObservedFirstByteMock(...args),
  getObservedResponseMeta: (...args: unknown[]) => getObservedResponseMetaMock(...args),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
  invalidateTokenRouterCache: vi.fn(),
}));

vi.mock('../../services/routeRefreshWorkflow.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/routeRefreshWorkflow.js')>(
      '../../services/routeRefreshWorkflow.js',
    );
  return {
    ...actual,
    refreshModelsAndRebuildRoutes: (...args: unknown[]) =>
      refreshModelsAndRebuildRoutesMock(...args),
  };
});

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args),
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (...args: unknown[]) => resolveProxyUsageWithSelfLogFallbackMock(...args),
}));

vi.mock('./proxyBilling.js', () => ({
  resolveProxyLogBilling: (...args: unknown[]) => resolveProxyLogBillingMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('/v1/embeddings usage source logging', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-embeddings-site-api-endpoint-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./embeddings.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.embeddingsProxyRoute);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    fetchWithObservedFirstByteMock.mockReset();
    getObservedResponseMetaMock.mockReset();
    selectChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    insertProxyLogMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockReset();
    resolveProxyLogBillingMock.mockReset();

    fetchWithObservedFirstByteMock.mockImplementation(async (runner: (signal?: AbortSignal) => Promise<Response>) => runner());
    getObservedResponseMetaMock.mockReturnValue({ firstByteLatencyMs: 14 });
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      recoveredFromSelfLog: true,
      usageSource: 'self-log',
    });
    resolveProxyLogBillingMock.mockResolvedValue({
      estimatedCost: 0,
      billingDetails: null,
    });

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
    delete process.env.DATA_DIR;
  });

  it('stores usage source metadata on successful embedding logs', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'usage-site',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'usage-user',
      accessToken: '',
      apiToken: 'sk-usage',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-a.example.com',
      enabled: true,
      sortOrder: 0,
    }).run();

    selectChannelMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-usage',
      actualModel: 'text-embedding-3-large',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'list',
      data: [
        {
          object: 'embedding',
          embedding: [0.1, 0.2],
          index: 0,
        },
      ],
      model: 'text-embedding-3-large',
      usage: {
        prompt_tokens: 1,
        total_tokens: 1,
        cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 330 },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer sk-downstream',
      },
      payload: {
        model: 'text-embedding-3-large',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    // 上游有观测（usage prompt_tokens=1/total_tokens=1）时，标签只取 resolveFinalUsage
    // 四分支裁决（'upstream'），不得被 self-log mock 的 recoveredFromSelfLog=true 改写。
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      errorMessage: expect.stringContaining('[usage:upstream]'),
    }));
    // cc1h 回归：上游 1h 缓存字段必须透传到 resolveProxyLogBilling。
    expect(resolveProxyLogBillingMock).toHaveBeenCalledWith(expect.objectContaining({
      resolvedUsage: expect.objectContaining({ cacheCreationTokens1h: 330 }),
    }));
  });

  it('writes the real client_http_status on the embedding upstream-failure row', async () => {
    // O8 R4（P2）：embeddings helper 的失败行此前未传 `client_http_status`（该列恒 NULL）。
    // 本用例取「网络类失败（拿不到上游响应）」：日志 `http_status = 0`，而 respond 兜底 502 ⇒
    // 两列必须不同（写 `-1` 哨兵或直接抄 `httpStatus` 都会在此拆穿）。
    const site = await db.insert(schema.sites).values({
      name: 'failure-site',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'failure-user',
      accessToken: '',
      apiToken: 'sk-failure',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-failure.example.com',
      enabled: true,
      sortOrder: 0,
    }).run();

    selectChannelMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-failure',
      actualModel: 'text-embedding-3-large',
    });

    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer fixture-downstream-key',
      },
      payload: {
        model: 'text-embedding-3-large',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      httpStatus: 0,
      clientHttpStatus: 502,
    }));
  });
});
