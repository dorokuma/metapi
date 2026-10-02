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
    // R4：claude 下游（`/v1/messages`）的失败语义也要在这一套真实 sqlite 夹具下可见。
    await app.register(routesModule.claudeMessagesProxyRoute);
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
    // 重试耗尽的运维标记现在落在 events（独立 title 直查）；清空以免用例间串味。
    await db.delete(schema.events).run();
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
    // 网络层异常（fetch reject）已归一到与「上游返回 !ok」同路径（#5），所以 type 从
    // `server_error` 纠正为 `upstream_error`；502 仍是本仓合成的状态码。
    expect(response.json()?.error?.type).toBe('upstream_error');
    // 归一后同走上游失败路径：客户端拿到的是**真实原因**（不再是笼统的 'Upstream error'），
    // 这也是「重试耗尽回传上游真实原因」既有口径的一部分。
    expect(String(response.json()?.error?.message)).toContain('network unreachable');
    expect(String(response.json()?.error?.message)).toContain('HTTP 502');
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

  it('writes exactly one retry-exhausted events row carrying the real status + retry-exhausted prefix', async () => {
    // 判别器（方案 A）：重试耗尽出口直插一条自己的 `events`（独立 title），使「重试耗尽」可被
    // `SELECT * FROM events WHERE title = '代理重试耗尽'` 1:1 直查——不再新增 `proxy_logs` 行、
    // 不再依赖 events 正文串（「代理全部失败」那条仍受聚合器保留集/文本规范化约束）。
    const { RETRY_EXHAUSTED_EVENT_TITLE } = await import('../../shared/eventTitles.js');
    fetchMock.mockImplementation(async () => upstreamErrorResponse(429, 'rate limited: upstream quota exceeded'));

    const response = await injectChat();

    expect(response.statusCode).toBe(429);
    // 出口不再新增任何带判别串的 `proxy_logs` 行（本批已拆除该写入）。
    // 注：此处仍会有该 attempt 自己的失败行（`failureToolkit.log` 在重试前就写了它），故不断言 proxy_logs 为空。
    const proxyLogRows = await db.select().from(schema.proxyLogs).all();
    expect(proxyLogRows.filter((row) => String(row.errorMessage || '').includes('retry exhausted:')).length).toBe(0);

    const rows = await db.select().from(schema.events).all();
    const exhaustedRows = rows.filter((row) => row.title === RETRY_EXHAUSTED_EVENT_TITLE);
    // 每轮重试耗尽只写一条。
    expect(exhaustedRows.length).toBe(1);
    const row = exhaustedRows[0];
    // 体例：`type='proxy'`（与 reportProxyAllFailed 的 eventType 同）+ `level='error'`；relatedType 按
    // 代理域既有体例挂 'route'（与 reportProxyAllFailed 一致；events 侧无 route id 可挂）。
    expect(row.type).toBe('proxy');
    expect(row.level).toBe('error');
    expect(row.relatedType).toBe('route');
    // 已从通知中心口径摘除（服务端排除该 title）；标记行仍可 SQL 直查。
    // 落库仍显式置已读（`read: true`）——本断言即锁该写入语义。
    expect(row.read).toBe(true);
    // 真实状态码 + 判别串都在 message 文本里（events 无结构化列）。
    expect(String(row.message)).toContain('retry exhausted: HTTP 429: ');
    expect(String(row.message)).toContain('rate limited: upstream quota exceeded');
    // 当时可得的上下文：模型 / 上游路径 / 轮次 / 试过的通道。该形态下 `retryFailure.upstreamPath` 为 null
    //（上游 429 经 `SiteApiEndpointRequestError` 分支进来，该分支只写 `upstreamPath: null`），故落 `upstream=-`；
    // 上游路径仍在 payload message 自带的 `[upstream:…]` 前缀里。
    expect(String(row.message)).toContain('model=gpt-4o-mini');
    expect(String(row.message)).toMatch(/; upstream=\S+; stream=false; attempt=1; tried_channels=\[11\]; forced_channel=-$/);
  });

  it('does not write a retry-exhausted events row for the first-round no-channel shape', async () => {
    // A 形态（首轮真无通道，lastRetryFailure 为 null）保持原行为：不新增 events 行。
    const { RETRY_EXHAUSTED_EVENT_TITLE } = await import('../../shared/eventTitles.js');
    selectChannelMock.mockReturnValue(null);

    const response = await injectChat();

    expect(response.statusCode).toBe(503);
    const rows = await db.select().from(schema.events).all();
    expect(rows.filter((row) => row.title === RETRY_EXHAUSTED_EVENT_TITLE).length).toBe(0);
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

  it('keeps the upstream raw bytes in the debug trace when a stream fails in-band (capture on)', async () => {
    // C：流式失败出口原来一律用自写的 502 JSON（`{error:{message,type:'stream_error'}}`）覆盖 debug trace
    // 的 body ⇒ trace 的 `final_response_body_json` 里看不到一个上游字节（上游到底回了什么、是什么帧形
    // 全部不可得）。采集开关（`captureStreamChunks`）开启且确实读到上游字节时，改为保留上游原文。
    startSurfaceProxyDebugTraceMock.mockResolvedValue({
      traceId: 701,
      options: {
        enabled: true,
        captureHeaders: true,
        captureBodies: true,
        captureStreamChunks: true,
        targetSessionId: '',
        targetClientKind: '',
        targetModel: '',
        retentionHours: 24,
        maxBodyBytes: 262144,
      },
    });

    const encoder = new TextEncoder();
    const upstreamSse = 'data: {"error":{"code":"stream_initialization_failed","message":"Rate limit exceeded: Retry after 29s.","request_id":"req_trace"}}\n\ndata: [DONE]\n\n';
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(upstreamSse));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    // 客户端侧（M2 后）：未写出过字节 ⇒ 不 hijack，走既有 HTTP 层 502 出口（状态码 + 上游原文）。
    expect(response.statusCode).toBe(502);
    expect(String(response.headers['content-type'] || '')).not.toContain('text/event-stream');
    expect(String(response.json()?.error?.message || '')).toContain('Rate limit exceeded: Retry after 29s.');

    const failureFinalize = safeFinalizeSurfaceProxyDebugTraceMock.mock.calls
      .find((call) => (call[1] as any)?.finalStatus === 'failed');
    expect(failureFinalize).toBeTruthy();
    // trace 的 body 是上游原始字节（不再是自写 502 JSON）；上游路径也落库。客户端拿到的 502 JSON 是封顶过的，
    // 上游原文只能从 trace / 落库看——这正是 C 的可用性价值。
    expect((failureFinalize![1] as any).finalResponseBody).toBe(upstreamSse);
    expect((failureFinalize![1] as any).finalUpstreamPath).toBeTruthy();

    // 落库：`proxy_logs.error_message` 保留上游原文（含 code/request_id 后缀），不封顶到 1000。
    const proxyLogRows = await db.select().from(schema.proxyLogs).all();
    expect(proxyLogRows.length).toBeGreaterThan(0);
    const streamFailureRow = proxyLogRows.find((row) => Number(row.clientHttpStatus) === 502 && row.status === 'failed');
    expect(streamFailureRow).toBeTruthy();
    const errorMessage = String(streamFailureRow?.errorMessage ?? '');
    expect(errorMessage).toContain('Rate limit exceeded: Retry after 29s.');
    expect(errorMessage).toContain('code=stream_initialization_failed');
    expect(errorMessage).toContain('request_id=req_trace');
  });

  it('claude downstream: an already-written legacy response.failed frame becomes one event: error frame, not end_turn/message_stop', async () => {
    // R4（R3-⑥ 闭环）：claude 客户端 + 上游老形失败（`response.failed`）+ **已写出字节**。
    // 旧行为：该帧继续走归一化块（`response.failed` ⇒ `finish_reason:'stop'`），claude 序列化器再把它
    // 渲染成 `message_delta{stop_reason:'end_turn'}` + `message_stop` ⇒ 客户端看到「正常结束（带部分内容）」
    // 而服务端记 failed（服务端与客户端对同一轮给出相反结论）。
    // 新行为：复用 M1 已在用的 claude 带内错误帧出口，发**恰好一帧** `event: error`（message = 上游原文，
    // 保留尾部 `(request_id=…)` 后缀），且不含任何本仓生成的终结帧；已写出的内容原样保留在前。
    // 另两处行为不变并各有既有用例守着：未写字节的 legacy 帧 ⇒ 502 + 上游原文
    // （`chat.stream.test.ts` 的 `gates the legacy failure frames the same way…` ① / `delivers an HTTP 502 …`）、
    // 新形 M1 的 claude 形恰一帧错误（`chat.stream.test.ts` 的 `claude downstream: an in-band stream_error frame
    // produces exactly one error frame`）。
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: {
        id: 901,
        name: 'openai-site',
        url: 'https://api.openai.com',
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
        apiToken: 'sk-openai',
        status: 'active',
        checkinEnabled: false,
        extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
      },
      tokenName: 'default',
      tokenValue: 'sk-openai',
      actualModel: 'gpt-4o-mini',
    });

    const encoder = new TextEncoder();
    // 上游形态：`/v1/responses` SSE（claude 下游 + openai 站点的上游路径），先写出一段内容（字节已到客户端），
    // 随后以老形 `response.failed` 收场。
    const upstreamSse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_claude_failed","model":"gpt-4o-mini","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_claude_failed","delta":"partial answer"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","request_id":"req_claude_legacy_failed","response":{"id":"resp_claude_failed","model":"gpt-4o-mini","status":"failed","error":{"message":"tool execution failed"}}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(upstreamSse));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    // ① 已 hijack：状态码停在 200，失败语义只能落在流内的错误帧上。
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'] || '')).toContain('text/event-stream');
    // ② 已写出的内容原样保留在前（不是把已写字节丢掉）。
    expect(response.body).toContain('partial answer');
    // ③ 恰好一帧 claude 错误帧，message = 上游原文 + 尾部标识后缀。
    expect(response.body.split('event: error').length - 1).toBe(1);
    expect(response.body).toContain('"type":"error"');
    expect(response.body).toContain('tool execution failed');
    expect(response.body).toContain('request_id=req_claude_legacy_failed');
    // ④ 不再给对方任何「正常结束」信号：既无 `message_delta`（end_turn），也无 `message_stop`。
    expect(response.body).not.toContain('message_delta');
    expect(response.body).not.toContain('end_turn');
    expect(response.body).not.toContain('message_stop');
    // ⑤ 落库：服务端仍记 failed（上游原文），客户端实收 200 落进观测列。
    expect(recordSuccessMock).not.toHaveBeenCalled();
    const proxyLogRows = await db.select().from(schema.proxyLogs).all();
    const failedRow = proxyLogRows.find((row) => row.status === 'failed');
    expect(failedRow).toBeTruthy();
    expect(Number(failedRow?.clientHttpStatus)).toBe(200);
    const errorMessage = String(failedRow?.errorMessage ?? '');
    expect(errorMessage).toContain('tool execution failed');
    expect(errorMessage).toContain('request_id=req_claude_legacy_failed');
  });
});
