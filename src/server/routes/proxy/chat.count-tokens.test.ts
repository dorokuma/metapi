import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyChannelCoordinator } from '../../services/proxyChannelCoordinator.js';
import * as siteApiEndpointService from '../../services/siteApiEndpointService.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));
const startSurfaceProxyDebugTraceMock = vi.fn();
const safeUpdateSurfaceProxyDebugSelectionMock = vi.fn();
const safeUpdateSurfaceProxyDebugCandidatesMock = vi.fn();
const safeInsertSurfaceProxyDebugAttemptMock = vi.fn();
const safeFinalizeSurfaceProxyDebugTraceMock = vi.fn();
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: (values?: any) => {
    // O8 R4：把每次写入的取值原样留证，才能断言 `is_stream` / `client_http_status` 真的进了写侧。
    proxyLogValuesMock(values);
    return { run: () => undefined };
  },
}));
const proxyLogValuesMock = vi.fn();

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
  estimateProxyCost: async () => 0,
  buildProxyBillingDetails: async () => null,
  fetchModelPricingCatalog: async () => null,
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: () => false,
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

vi.mock('../../services/proxyDebugTraceRuntime.js', () => ({
  startSurfaceProxyDebugTrace: (...args: unknown[]) => startSurfaceProxyDebugTraceMock(...args),
  safeUpdateSurfaceProxyDebugSelection: (...args: unknown[]) => safeUpdateSurfaceProxyDebugSelectionMock(...args),
  safeUpdateSurfaceProxyDebugCandidates: (...args: unknown[]) => safeUpdateSurfaceProxyDebugCandidatesMock(...args),
  safeInsertSurfaceProxyDebugAttempt: (...args: unknown[]) => safeInsertSurfaceProxyDebugAttemptMock(...args),
  safeFinalizeSurfaceProxyDebugTrace: (...args: unknown[]) => safeFinalizeSurfaceProxyDebugTraceMock(...args),
  safeUpdateSurfaceProxyDebugAttempt: vi.fn(),
  reserveSurfaceProxyDebugAttemptBase: () => 0,
  buildSurfaceProxyDebugResponseHeaders: () => ({}),
  captureSurfaceProxyDebugSuccessResponseBody: async () => null,
  parseSurfaceProxyDebugTextPayload: (raw: string) => raw,
}));

vi.mock('../../services/oauth/quota.js', () => ({
  recordOauthQuotaHeadersSnapshot: async () => undefined,
  recordOauthQuotaResetHint: async () => undefined,
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: async () => [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: async () => undefined,
        }),
      }),
    }),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogClientHttpStatusColumn: async () => true,
  // O8 R4：本文件现在要断言 `is_stream` / `client_http_status` 是否真的进写侧取值，故两列夹具均置真
  //（置假时 `insertProxyLog` 按设计整列丢弃，断言无法区分「未传」与「传了但被丢」）。
  hasProxyLogStreamTimingColumns: async () => true,
  schema: {
    proxyLogs: {},
    siteApiEndpoints: {
      id: {},
      siteId: {},
      sortOrder: {},
    },
  },
}));

describe('claude count_tokens proxy route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { claudeMessagesProxyRoute } = await import('./chat.js');
    app = Fastify();
    await app.register(claudeMessagesProxyRoute);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    startSurfaceProxyDebugTraceMock.mockReset();
    safeUpdateSurfaceProxyDebugSelectionMock.mockReset();
    safeUpdateSurfaceProxyDebugCandidatesMock.mockReset();
    safeInsertSurfaceProxyDebugAttemptMock.mockReset();
    safeFinalizeSurfaceProxyDebugTraceMock.mockReset();
    dbInsertMock.mockClear();
    proxyLogValuesMock.mockClear();

    startSurfaceProxyDebugTraceMock.mockResolvedValue({
      traceId: 701,
      options: {
        enabled: true,
        captureHeaders: true,
        captureBodies: true,
        captureStreamChunks: false,
        targetSessionId: '',
        targetClientKind: '',
        targetModel: '',
        retentionHours: 24,
        maxBodyBytes: 262144,
      },
    });

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'claude-site', url: 'https://api.anthropic.com', platform: 'claude' },
      account: { id: 33, username: 'claude-user@example.com' },
      tokenName: 'default',
      tokenValue: 'sk-claude',
      actualModel: 'claude-opus-4-6',
    });
    selectNextChannelMock.mockReturnValue(null);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('forwards /v1/messages/count_tokens to the claude count_tokens upstream path', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      input_tokens: 42,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: {
        model: 'claude-opus-4-6',
        tools: [
          { name: 'lookup', input_schema: { type: 'object' } },
        ],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'count these tokens' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ input_tokens: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toBe('https://api.anthropic.com/v1/messages/count_tokens?beta=true');
    expect(options.headers['anthropic-version']).toBe('2023-06-01');
    expect(options.headers['anthropic-beta']).toContain('claude-code-20250219');
    expect(options.headers['anthropic-beta']).toContain('token-counting-2024-11-01');
    expect(options.headers['Accept-Encoding']).toBe('gzip, deflate, br, zstd');
    expect(startSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(expect.objectContaining({
      downstreamPath: '/v1/messages/count_tokens',
      requestedModel: 'claude-opus-4-6',
    }));
    expect(safeInsertSurfaceProxyDebugAttemptMock).toHaveBeenCalled();
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 701 }),
      expect.objectContaining({
        finalStatus: 'success',
        finalUpstreamPath: '/v1/messages/count_tokens?beta=true',
      }),
    );

    const forwardedBody = JSON.parse(String(options.body));
    expect(forwardedBody.model).toBe('claude-opus-4-6');
    expect(forwardedBody.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'count these tokens', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('supports /v1/messages/count_tokens for openai-platform gateways that expose Claude messages endpoints', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 23 },
      site: { name: 'gateway-site', url: 'https://gateway.example.com', platform: 'openai' },
      account: { id: 34, username: 'gateway-user@example.com' },
      tokenName: 'default',
      tokenValue: 'sk-gateway',
      actualModel: 'claude-sonnet-4-5-20250929',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      input_tokens: 9,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'count through a compatible gateway' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ input_tokens: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toBe('https://gateway.example.com/v1/messages/count_tokens?beta=true');
    // openai-platform 网关不是 Anthropic 原生站点：用 Authorization Bearer，不能用 x-api-key
    expect(options.headers['x-api-key']).toBeUndefined();
    expect(options.headers.Authorization).toBe('Bearer sk-gateway');
    expect(options.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('does not forward when claude count_tokens upstream compatibility is unavailable', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 23 },
      site: { name: 'codex-site', url: 'https://chatgpt.com/backend-api/codex', platform: 'codex' },
      account: { id: 34, username: 'codex-user@example.com' },
      tokenName: 'default',
      tokenValue: 'sk-codex',
      actualModel: 'gpt-5.4',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'count through codex' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        message: 'No available channels for this model',
        type: 'server_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes is_stream=false on the claude count-tokens channel-busy failure row', async () => {
    // O8 R4（P1）：count-tokens 的租约忙出口此前未传 `is_stream`（该列恒 NULL）。
    // 该端点自身无流式语义（请求体里的 `stream` 被忽略）⇒ 真值恒 `false`；
    // `first_byte_latency_ms` 本出口未触达上游 ⇒ **有意不传**（落 NULL）。
    const acquireLeaseSpy = vi.spyOn(proxyChannelCoordinator, 'acquireChannelLease')
      .mockResolvedValue({ status: 'timeout', waitMs: 800 } as any);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages/count_tokens',
        payload: {
          model: 'claude-opus-4-6',
          messages: [{ role: 'user', content: 'count these tokens' }],
        },
      });

      expect(response.statusCode).toBe(503);
      const failedRow = proxyLogValuesMock.mock.calls
        .map((call) => call[0])
        .find((values) => values && values.status === 'failed');
      expect(failedRow).toMatchObject({ status: 'failed', httpStatus: 503, isStream: false });
      expect(failedRow.firstByteLatencyMs).toBeNull();
    } finally {
      acquireLeaseSpy.mockRestore();
    }
  });

  it('writes the real client_http_status on the claude count-tokens site-concurrency-timeout row', async () => {
    // O8 R4（P1）：count-tokens 的站点并发超时出口此前未传 `client_http_status`（该列恒 NULL）；
    // 本出口与 respond 同码，故写 `failure.status`；`is_stream` 真值同 `false`。
    const poolSpy = vi.spyOn(siteApiEndpointService, 'runWithSiteApiEndpointPool')
      .mockRejectedValue(Object.assign(
        new siteApiEndpointService.SiteApiEndpointRequestError('site concurrency slot timeout', { status: 503 }),
        { siteConcurrencyTimeout: true },
      ));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages/count_tokens',
        payload: {
          model: 'claude-opus-4-6',
          messages: [{ role: 'user', content: 'count these tokens' }],
        },
      });

      expect(response.statusCode).toBe(503);
      const failedRow = proxyLogValuesMock.mock.calls
        .map((call) => call[0])
        .find((values) => values && values.status === 'failed');
      expect(failedRow).toMatchObject({
        status: 'failed',
        httpStatus: 503,
        clientHttpStatus: 503,
        isStream: false,
      });
    } finally {
      poolSpy.mockRestore();
    }
  });
});
