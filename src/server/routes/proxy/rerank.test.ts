import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const insertProxyLogMock = vi.fn();

/** O8 R4：站点地址池默认直通实现（可用例级 `mockImplementationOnce` 覆盖）。 */
const defaultRunWithSiteApiEndpointPool = async (
  site: { url: string },
  callback: (target: { baseUrl: string }) => Promise<unknown>,
) => callback({ baseUrl: site.url });
const runWithSiteApiEndpointPoolMock = vi.fn(defaultRunWithSiteApiEndpointPool);

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return { ...actual, fetch: (...args: unknown[]) => fetchMock(...args) };
});
vi.mock('../../proxy-core/firstByteTimeout.js', () => ({
  fetchWithObservedFirstByte: async (runner: (signal?: AbortSignal) => Promise<Response>) => runner(),
  getObservedResponseMeta: () => ({ firstByteLatencyMs: 3 }),
  // O8 R4：失败路径会问「这是不是首字节超时合成响应」——不补这个导出，mock 会抛未导出错误，
  // 把上游 502 失败路径变成夹具自身抛错。
  isObservedFirstByteTimeoutResponse: () => false,
}));

vi.mock('../../proxy-core/channelSelection.js', () => ({
  buildForcedChannelUnavailableMessage: () => 'no channel',
  canRetryChannelSelection: () => false,
  getTesterForcedChannelId: () => null,
  selectProxyChannelForAttempt: (...args: unknown[]) => selectChannelMock(...args),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock('../../services/siteApiEndpointService.js', () => ({
  SiteApiEndpointRequestError: class SiteApiEndpointRequestError extends Error {
    status: number;
    firstByteLatencyMs: number | null;
    constructor(message: string, options: { status?: number; firstByteLatencyMs?: number | null } = {}) {
      super(message);
      this.status = options.status || 0;
      this.firstByteLatencyMs = options.firstByteLatencyMs ?? null;
    }
  },
  runWithSiteApiEndpointPool: (...args: unknown[]) => (runWithSiteApiEndpointPoolMock as any)(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: vi.fn(),
  reportTokenExpired: vi.fn(),
}));
vi.mock('../../services/proxyLogStore.js', () => ({ insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args) }));
vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: async (input: { usage: unknown }) => ({ ...(input.usage as object), usageSource: 'upstream' }),
}));
vi.mock('./proxyBilling.js', () => ({ resolveProxyLogBilling: async () => ({ estimatedCost: 0, billingDetails: null }) }));
vi.mock('./downstreamPolicy.js', () => ({
  ensureModelAllowedForDownstreamKey: async () => true,
  getDownstreamRoutingPolicy: () => ({}),
  recordDownstreamCostUsage: vi.fn(),
}));
vi.mock('../../services/siteProxy.js', () => ({
  resolveChannelProxyUrl: () => undefined,
  withSiteRecordProxyRequestInit: (_site: unknown, init: RequestInit) => init,
}));
vi.mock('../../services/accountExtraConfig.js', () => ({ getProxyUrlFromExtraConfig: () => undefined }));

describe('/v1/rerank route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    insertProxyLogMock.mockReset();
    runWithSiteApiEndpointPoolMock.mockReset();
    runWithSiteApiEndpointPoolMock.mockImplementation(defaultRunWithSiteApiEndpointPool);
    if (!app) {
      const { rerankProxyRoute } = await import('./rerank.js');
      app = Fastify();
      await app.register(rerankProxyRoute);
    }
    selectChannelMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 1, name: 'coding-site', url: 'https://ark.cn-beijing.volces.com/api/coding/v3', platform: 'openai' },
      account: { id: 2, username: 'user', extraConfig: null },
      tokenName: 'default',
      tokenValue: 'sk-upstream',
      actualModel: 'bge-reranker-v2-m3',
    });
  });

  it('rejects requests without model', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/rerank', payload: { query: 'hello', documents: ['world'] } });
    expect(response.statusCode).toBe(400);
  });

  it('forwards rerank requests to the configured upstream endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      payload: { model: 'bge-reranker-v2-m3', query: 'hello', documents: ['world'] },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ark.cn-beijing.volces.com/api/coding/v3/rerank');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'bge-reranker-v2-m3', query: 'hello' });
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('records is_stream on the rerank site-concurrency-busy failure row', async () => {
    // O8 R4（P1）：rerank 的「站点并发忙」出口此前未传 `is_stream`（该列恒 NULL）。
    // Rerank 端点结构上无流式语义 ⇒ 真值恒 `false`；`first_byte_latency_ms` 本出口在读写侧都被
    // `?? null` 归一（**有意不传**），无法区分「未传」与「传了 null」，故不在本用例断言它。
    const { SiteApiEndpointRequestError } = await import('../../services/siteApiEndpointService.js');
    runWithSiteApiEndpointPoolMock.mockImplementationOnce(async () => {
      throw Object.assign(
        new SiteApiEndpointRequestError('site concurrency slot timeout', { status: 503 }),
        { siteConcurrencyTimeout: true },
      );
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      payload: { model: 'bge-reranker-v2-m3', query: 'hello', documents: ['world'] },
    });

    // 对外语义不变：并发槽位耗尽时不上游、不降通道健康度 ⇒ 客户端 503 + server_error。
    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      httpStatus: 503,
      isStream: false,
    }));
  });

  it('records is_stream and the observed first_byte_latency_ms on the rerank upstream-failure row', async () => {
    // O8 R4（P1/P3）：rerank 的上游失败出口此前未传 `is_stream` / `first_byte_latency_ms`。
    // 两者都是真值：端点非流式 ⇒ `false`；失败尝试的上游响应已观测到首字节 ⇒ 夹具 mock 的 3。
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      payload: { model: 'bge-reranker-v2-m3', query: 'hello', documents: ['world'] },
    });

    expect(response.statusCode).toBe(502);
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      httpStatus: 502,
      isStream: false,
      firstByteLatencyMs: 3,
    }));
  });
});
