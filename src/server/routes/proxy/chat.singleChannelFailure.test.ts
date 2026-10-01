import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.js';
import { proxyChannelCoordinator } from '../../services/proxyChannelCoordinator.js';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const shouldRetryProxyRequestMock = vi.fn();
const startSurfaceProxyDebugTraceMock = vi.fn();
const safeUpdateSurfaceProxyDebugSelectionMock = vi.fn();
const safeUpdateSurfaceProxyDebugCandidatesMock = vi.fn();
const safeInsertSurfaceProxyDebugAttemptMock = vi.fn();
const safeFinalizeSurfaceProxyDebugTraceMock = vi.fn();

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
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
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
  shouldRetryProxyRequest: (...args: unknown[]) => shouldRetryProxyRequestMock(...args),
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: async ({ usage }: any) => ({
    ...usage,
    estimatedCostFromQuota: 0,
    recoveredFromSelfLog: false,
  }),
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

type DbModule = typeof import('../../db/index.js');

function buildSelectedChannel(input: {
  token: string;
  id?: number;
  siteId?: number;
}) {
  return {
    channel: { id: input.id ?? 11, routeId: 22 },
    site: {
      id: input.siteId ?? 901,
      name: 'single-channel-site',
      url: 'https://upstream.example.com',
      platform: 'openai',
      apiKey: null,
      useSystemProxy: false,
      proxyUrl: null,
      maxConcurrency: null,
    },
    account: {
      id: 33,
      username: 'single-channel-user',
      accessToken: '',
      apiToken: input.token,
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    },
    tokenName: 'default',
    tokenValue: input.token,
    actualModel: 'gpt-4o-mini',
  };
}

function readRequestHeader(init: any, name: string): string {
  const headers = init?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchedKey ? String(headers[matchedKey] ?? '') : '';
}

function upstreamErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({
    error: { message, type: 'upstream_error' },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('chat proxy retry exhaustion surfaces the real upstream failure', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  const injectChat = async () => app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    },
  });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-chat-single-channel-failure-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./chat.js');
    const responsesRoutesModule = await import('./responses.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.chatProxyRoute);
    await app.register(responsesRoutesModule.responsesProxyRoute);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    shouldRetryProxyRequestMock.mockReset();
    startSurfaceProxyDebugTraceMock.mockReset();
    safeUpdateSurfaceProxyDebugSelectionMock.mockReset();
    safeUpdateSurfaceProxyDebugCandidatesMock.mockReset();
    safeInsertSurfaceProxyDebugAttemptMock.mockReset();
    safeFinalizeSurfaceProxyDebugTraceMock.mockReset();

    resetUpstreamEndpointRuntimeState();
    await db.delete(schema.proxyLogs).run();
    // 站点与其 API 端点地址由单个用例按需写入，避免用例间串味。
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();

    // 3 次尝试（=2 次重试）：让「重试仍可继续」的轮次出现，才能走到重试耗尽分支。
    (config as any).proxyMaxChannelAttempts = 3;
    (config as any).codexHeaderDefaults = {
      userAgent: '',
      betaFeatures: '',
    };
    (config as any).payloadRules = {
      default: [],
      defaultRaw: [],
      override: [],
      overrideRaw: [],
      filter: [],
    };
    (config as any).disableCrossProtocolFallback = false;
    config.proxyEmptyContentFailEnabled = false;
    config.proxyErrorKeywords = [];

    // 429 与 5xx 属可重试失败（与真实 proxyRetryPolicy 口径一致）。
    shouldRetryProxyRequestMock.mockImplementation((status: number) => status === 429 || status >= 500);

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

    selectChannelMock.mockReturnValue(buildSelectedChannel({ token: 'sk-single' }));
    selectNextChannelMock.mockReturnValue(null);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    delete process.env.DATA_DIR;
  });

  it('returns the real 429 (not 503) when a single-channel upstream rate limit exhausts the retries', async () => {
    fetchMock.mockImplementation(async () => upstreamErrorResponse(429, 'rate limited: upstream quota exceeded'));

    const response = await injectChat();

    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body?.error?.type).toBe('upstream_error');
    expect(String(body?.error?.message)).toContain('rate limited: upstream quota exceeded');
    expect(String(body?.error?.message)).toContain('HTTP 429');
    // 单通道被排除后选不出通道 ⇒ 走的是「重试耗尽」出口，而不是「首轮无可用通道」出口。
    expect(selectNextChannelMock).toHaveBeenCalled();
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-4o-mini',
      reason: expect.stringContaining('rate limited'),
    }));
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 701 }),
      expect.objectContaining({
        finalStatus: 'failed',
        finalHttpStatus: 429,
      }),
    );
  });

  it('returns the real 500 when a single-channel upstream server error exhausts the retries', async () => {
    fetchMock.mockImplementation(async () => upstreamErrorResponse(500, 'upstream internal error'));

    const response = await injectChat();

    expect(response.statusCode).toBe(500);
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(String(response.json()?.error?.message)).toContain('upstream internal error');
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 701 }),
      expect.objectContaining({ finalHttpStatus: 500 }),
    );
  });

  it('returns 502 (not 503) when a single-channel network failure exhausts the retries', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'));

    const response = await injectChat();

    expect(response.statusCode).toBe(502);
    // 网络层执行失败没有真实上游 HTTP 响应 ⇒ 分流为 server_error（502 为合成值）。
    expect(response.json()?.error?.type).toBe('server_error');
    expect(String(response.json()?.error?.message)).toContain('Upstream error');
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 701 }),
      expect.objectContaining({ finalHttpStatus: 502 }),
    );
  });

  it('returns 502 + server_error carrying the local endpoint-pool failure when the retries are exhausted', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cooled-down-site',
      url: 'https://cooled.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();
    // 站点端点全冷却 ⇒ 端点池直接抛「当前站点的 API 请求地址均不可用」：本地侧失败，从未拿到上游响应。
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://cooled.example.com/v1',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    selectChannelMock.mockReturnValue(buildSelectedChannel({ token: 'sk-single', siteId: site.id }));

    const response = await injectChat();

    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body?.error?.type).toBe('server_error');
    expect(String(body?.error?.message)).toContain('当前站点的 API 请求地址均不可用');
    // 本地侧失败：全程没发出过上游请求，自然没有真实上游响应可回传。
    expect(fetchMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).toHaveBeenCalled();
  });

  it('returns the real channel-busy 503 under the retry-exhausted reason when the lease never frees', async () => {
    // B 类（租约忙）此前零覆盖：单通道 + 租约 timeout + 下一轮选不出通道 ⇒
    // 客户端应看到真实租约忙文案（而非旧的 503 `No available channels for this model`），
    // 且 events 原因带上「重试耗尽」专用判别串前缀。
    const acquireLeaseSpy = vi.spyOn(proxyChannelCoordinator, 'acquireChannelLease')
      .mockResolvedValue({ status: 'timeout', waitMs: 1500 });

    try {
      const response = await injectChat();

      // ① 客户端 503 + server_error + 真实租约忙文案。
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body?.error?.type).toBe('server_error');
      expect(String(body?.error?.message)).toContain('Channel busy:');
      expect(String(body?.error?.message)).not.toContain('No available channels');
      // ② 单通道被占用后下一轮选不出通道 ⇒ 走「重试耗尽」出口，reason 带判别串。
      expect(selectNextChannelMock).toHaveBeenCalled();
      expect(reportProxyAllFailedMock).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-4o-mini',
        reason: expect.stringMatching(/^retry exhausted: HTTP 503: /),
      }));
      // 租约忙从未触达上游，也就没有真实上游响应可回传。
      expect(fetchMock).not.toHaveBeenCalled();
      expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: 701 }),
        expect.objectContaining({
          finalStatus: 'failed',
          finalHttpStatus: 503,
        }),
      );
    } finally {
      acquireLeaseSpy.mockRestore();
    }
  });

  it('returns the last round real status when every channel fails (502 then 429)', async () => {
    selectChannelMock.mockReturnValue(buildSelectedChannel({ token: 'sk-first', id: 11 }));
    selectNextChannelMock
      .mockReturnValueOnce(buildSelectedChannel({ token: 'sk-second', id: 12 }))
      .mockReturnValue(null);
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const authorization = readRequestHeader(init, 'authorization');
      const status = authorization.includes('sk-second') ? 429 : 502;
      return upstreamErrorResponse(status, `upstream failure ${status}`);
    });

    const response = await injectChat();

    expect(response.statusCode).toBe(429);
    expect(String(response.json()?.error?.message)).toContain('upstream failure 429');
    expect(selectNextChannelMock).toHaveBeenCalledTimes(2);
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 701 }),
      expect.objectContaining({ finalHttpStatus: 429 }),
    );
  });

  it('keeps the original 503 wording when the first round has no available channel at all', async () => {
    selectChannelMock.mockReturnValue(null);

    const response = await injectChat();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        message: 'No available channels for this model',
        type: 'server_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-4o-mini',
      reason: 'No available channels after retries',
    }));
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 701 }),
      expect.objectContaining({ finalHttpStatus: 503 }),
    );
  });

  it('keeps the fixed-channel 503 wording when the forced channel is unavailable', async () => {
    // 固定通道模式：canRetryChannelSelection 恒假，选不到指定通道就直接 503，不进重试。
    selectPreferredChannelMock.mockReturnValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      remoteAddress: '127.0.0.1',
      headers: {
        'x-metapi-tester-request': '1',
        'x-metapi-tester-forced-channel-id': '77',
      },
      payload: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    const forcedMessage = '指定通道 #77 当前不可用，固定通道模式不会自动切换其他通道';
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        message: forcedMessage,
        type: 'server_error',
      },
    });
    expect(selectPreferredChannelMock).toHaveBeenCalled();
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      reason: forcedMessage,
    });
  });

  it('returns the real 429 on /v1/responses when the retries are exhausted', async () => {
    fetchMock.mockImplementation(async () => upstreamErrorResponse(429, 'responses surface rate limited'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-4o-mini',
        input: 'hi',
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(String(response.json()?.error?.message)).toContain('responses surface rate limited');
    expect(selectNextChannelMock).toHaveBeenCalled();
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 701 }),
      expect.objectContaining({
        finalStatus: 'failed',
        finalHttpStatus: 429,
      }),
    );
  });

  it('truncates an oversized upstream error message to the shared 1000-char cap', async () => {
    // 动态 import：顶层静态 import 会在 DATA_DIR 就位前把 db 客户端拉起来，破坏本文件的真实 sqlite 夹具。
    const {
      UPSTREAM_ERROR_MESSAGE_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER,
    } = await import('../../proxy-core/surfaces/sharedSurface.js');
    fetchMock.mockImplementation(async () => upstreamErrorResponse(429, 'y'.repeat(5000)));

    const response = await injectChat();

    expect(response.statusCode).toBe(429);
    const message = String(response.json()?.error?.message || '');
    expect(message.length).toBe(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
    expect(message.endsWith(UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER)).toBe(true);
    expect(message).toContain('HTTP 429');
    // 上游原文被截断，不会整段回传。
    expect(message.includes('y'.repeat(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH))).toBe(false);
  });
});
