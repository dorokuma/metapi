import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { config } from '../../config.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
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

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
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

describe('/v1/completions site api endpoint rotation', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-completions-site-api-endpoint-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./completions.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.completionsProxyRoute);
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
    insertProxyLogMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockReset();
    resolveProxyLogBillingMock.mockReset();

    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
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

  it('cools down a retryable failed endpoint and retries the next endpoint within the same site', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'nihao-panel',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'nihao-user',
      accessToken: '',
      apiToken: 'sk-nihao',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-a.example.com',
        enabled: true,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
      },
    ]).run();

    selectChannelMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-nihao',
      actualModel: 'gpt-4o-mini',
    });
    selectNextChannelMock.mockResolvedValue(null);

    fetchMock
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cmpl-ok',
        object: 'text_completion',
        choices: [{ text: 'ok' }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: {
        authorization: 'Bearer sk-downstream',
      },
      payload: {
        model: 'gpt-4o-mini',
        prompt: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'cmpl-ok',
      object: 'text_completion',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0] || '')).toBe('https://api-a.example.com/v1/completions');
    expect(String(fetchMock.mock.calls[1]?.[0] || '')).toBe('https://api-b.example.com/v1/completions');
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);

    const storedEndpoints = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.siteId, site.id))
      .orderBy(asc(schema.siteApiEndpoints.sortOrder), asc(schema.siteApiEndpoints.id))
      .all();
    expect(storedEndpoints[0]).toMatchObject({
      url: 'https://api-a.example.com',
      lastFailureReason: 'HTTP 502: bad gateway',
    });
    expect(storedEndpoints[0]?.cooldownUntil).toBeTruthy();
    expect(storedEndpoints[1]).toMatchObject({
      url: 'https://api-b.example.com',
    });
    expect(storedEndpoints[1]?.lastSelectedAt).toBeTruthy();
  });

  it('writes the real client_http_status on the in-band completion failure row', async () => {
    // O8 R4（P2）：completions 的「带内失败」出口（`detectProxyFailure` 命中失败关键词）此前未传
    // `client_http_status`（该列恒 NULL）。本出口不重试时 respond `failure.status` ⇒ 客户端实收 502。
    // 重试次数钉成 0，保证只走一轮、只写一条失败行。
    const previousAttempts = (config as any).proxyMaxChannelAttempts;
    const previousKeywords = config.proxyErrorKeywords;
    (config as any).proxyMaxChannelAttempts = 1;
    config.proxyErrorKeywords = ['bad gateway'];
    try {
      const site = await db.insert(schema.sites).values({
        name: 'completion-in-band-failure',
        url: 'https://console.example.com',
        platform: 'new-api',
        status: 'active',
      }).returning().get();

      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'completion-in-band-user',
        accessToken: '',
        apiToken: 'sk-inband',
        status: 'active',
        checkinEnabled: false,
        extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
      }).returning().get();

      await db.insert(schema.siteApiEndpoints).values({
        siteId: site.id,
        url: 'https://api-inband.example.com',
        enabled: true,
        sortOrder: 0,
      }).run();

      selectChannelMock.mockResolvedValue({
        channel: { id: 11, routeId: 22 },
        site,
        account,
        tokenName: 'default',
        tokenValue: 'sk-inband',
        actualModel: 'gpt-4o-mini',
      });
      selectNextChannelMock.mockResolvedValue(null);
      // 200 + 命中失败关键词的正文 ⇒ 走带内失败出口（不是端点池的 5xx 轮换）。
      fetchMock.mockResolvedValue(new Response('bad gateway', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/completions',
        headers: {
          authorization: 'Bearer fixture-downstream-key',
        },
        payload: {
          model: 'gpt-4o-mini',
          prompt: 'hello',
        },
      });

      expect(response.statusCode).toBe(502);
      expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        httpStatus: 502,
        clientHttpStatus: 502,
      }));
    } finally {
      (config as any).proxyMaxChannelAttempts = previousAttempts;
      config.proxyErrorKeywords = previousKeywords;
    }
  });

  it('writes the real client_http_status on the completion network-failure row', async () => {
    // O8 R4（P2）：completions helper 的 catch 失败行此前未传 `client_http_status`（该列恒 NULL）。
    // 网络类失败：日志 `http_status = 0`，respond 兜底 502 ⇒ 两列必须不同。
    const site = await db.insert(schema.sites).values({
      name: 'completion-network-failure',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'completion-network-user',
      accessToken: '',
      apiToken: 'sk-network',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-network.example.com',
      enabled: true,
      sortOrder: 0,
    }).run();

    selectChannelMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-network',
      actualModel: 'gpt-4o-mini',
    });
    selectNextChannelMock.mockResolvedValue(null);
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: {
        authorization: 'Bearer fixture-downstream-key',
      },
      payload: {
        model: 'gpt-4o-mini',
        prompt: 'hello',
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
