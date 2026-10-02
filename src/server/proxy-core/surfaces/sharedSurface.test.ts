import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY } from '../../services/downstreamPolicyTypes.js';

const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const composeProxyLogMessageMock = vi.fn();
const formatUtcSqlDateTimeMock = vi.fn();
const insertProxyLogMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withSiteRecordProxyRequestInitMock = vi.fn();
const dispatchRuntimeRequestMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const isTokenExpiredErrorMock = vi.fn();
const shouldRetryProxyRequestMock = vi.fn();
const recordOauthQuotaHeadersSnapshotMock = vi.fn();
const recordOauthQuotaResetHintMock = vi.fn();
const recordSuccessMock = vi.fn();
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn();
const resolveProxyLogBillingMock = vi.fn();
const refreshOauthAccessTokenSingleflightMock = vi.fn();
const getStickyChannelIdMock = vi.fn();
const bindStickyChannelMock = vi.fn();
const clearStickyChannelMock = vi.fn();
const acquireChannelLeaseMock = vi.fn();
const acquireSiteLeaseMock = vi.fn();
const buildStickySessionKeyMock = vi.fn();
const consoleWarnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
const consoleInfoMock = vi.spyOn(console, 'info').mockImplementation(() => {});
const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
  },
}));

vi.mock('../../services/proxyChannelCoordinator.js', () => ({
  proxyChannelCoordinator: {
    getStickyChannelId: (...args: unknown[]) => getStickyChannelIdMock(...args),
    bindStickyChannel: (...args: unknown[]) => bindStickyChannelMock(...args),
    clearStickyChannel: (...args: unknown[]) => clearStickyChannelMock(...args),
    acquireChannelLease: (...args: unknown[]) => acquireChannelLeaseMock(...args),
    acquireSiteLease: (...args: unknown[]) => acquireSiteLeaseMock(...args),
    buildStickySessionKey: (...args: unknown[]) => buildStickySessionKeyMock(...args),
  },
}));

vi.mock('../../services/routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/proxyLogMessage.js', () => ({
  composeProxyLogMessage: (...args: unknown[]) => composeProxyLogMessageMock(...args),
}));

vi.mock('../../services/localTimeService.js', () => ({
  formatUtcSqlDateTime: (...args: unknown[]) => formatUtcSqlDateTimeMock(...args),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args),
}));

vi.mock('../../services/siteProxy.js', () => ({
  resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
}));

vi.mock('../../services/runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: (...args: unknown[]) => isTokenExpiredErrorMock(...args),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  RETRYABLE_TIMEOUT_PATTERNS: [],
  shouldRetryProxyRequest: (...args: unknown[]) => shouldRetryProxyRequestMock(...args),
  shouldAbortSameSiteEndpointFallback: () => false,
}));

vi.mock('../../services/oauth/quota.js', () => ({
  recordOauthQuotaHeadersSnapshot: (...args: unknown[]) => recordOauthQuotaHeadersSnapshotMock(...args),
  recordOauthQuotaResetHint: (...args: unknown[]) => recordOauthQuotaResetHintMock(...args),
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (...args: unknown[]) => resolveProxyUsageWithSelfLogFallbackMock(...args),
}));

vi.mock('../../services/proxyBilling.js', () => ({
  resolveProxyLogBilling: (...args: unknown[]) => resolveProxyLogBillingMock(...args),
}));

vi.mock('../../services/oauth/refreshSingleflight.js', () => ({
  refreshOauthAccessTokenSingleflight: (...args: unknown[]) => refreshOauthAccessTokenSingleflightMock(...args),
}));

describe('selectSurfaceChannelForAttempt', () => {
  afterAll(() => {
    consoleWarnMock.mockRestore();
    consoleInfoMock.mockRestore();
    consoleErrorMock.mockRestore();
  });

  beforeEach(() => {
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    composeProxyLogMessageMock.mockReset();
    formatUtcSqlDateTimeMock.mockReset();
    insertProxyLogMock.mockReset();
    resolveChannelProxyUrlMock.mockReset();
    withSiteRecordProxyRequestInitMock.mockReset();
    dispatchRuntimeRequestMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    isTokenExpiredErrorMock.mockReset();
    shouldRetryProxyRequestMock.mockReset();
    recordOauthQuotaHeadersSnapshotMock.mockReset();
    recordOauthQuotaResetHintMock.mockReset();
    recordSuccessMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockReset();
    resolveProxyLogBillingMock.mockReset();
    refreshOauthAccessTokenSingleflightMock.mockReset();
    getStickyChannelIdMock.mockReset();
    bindStickyChannelMock.mockReset();
    clearStickyChannelMock.mockReset();
    acquireChannelLeaseMock.mockReset();
    acquireSiteLeaseMock.mockReset();
    buildStickySessionKeyMock.mockReset();
    consoleWarnMock.mockClear();
    consoleInfoMock.mockClear();
    consoleErrorMock.mockClear();
  });

  it('observes a single route-refresh hit with its duration and cumulative counters', async () => {
    // 观测契约：刷新路径每次命中输出一行 `[proxy/route-refresh]`，带耗时与累计命中/成功/失败计数。
    // 纯观测：选择结果与刷新门禁不受影响（同一用例里断言 selectChannel 仍是两次、返回同一个 selected）。
    const selected = { channel: { id: 33 } };
    selectChannelMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(selected);

    const { getRouteRefreshObservation } = await import('../channelSelection.js');
    const before = getRouteRefreshObservation();
    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
    });
    const after = getRouteRefreshObservation();

    expect(result).toBe(selected);
    expect(selectChannelMock).toHaveBeenCalledTimes(2);
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
    expect(after.attempts - before.attempts).toBe(1);
    expect(after.successes - before.successes).toBe(1);
    expect(after.failures - before.failures).toBe(0);
    expect(after.totalDurationMs - before.totalDurationMs).toBeGreaterThanOrEqual(0);

    const refreshLogs = consoleInfoMock.mock.calls.filter((call) => call[0] === '[proxy/route-refresh]');
    expect(refreshLogs).toHaveLength(1);
    const payload = refreshLogs[0]?.[1] as Record<string, unknown>;
    expect(payload?.outcome).toBe('success');
    expect(payload?.trigger).toBe('empty-selection');
    expect(payload?.requestedModel).toBe('gpt-5.2');
    expect(payload?.attempts).toBe(after.attempts);
    expect(payload?.successes).toBe(after.successes);
    expect(typeof payload?.durationMs).toBe('number');
    expect(payload?.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('refreshes models and retries selectChannel on the first attempt when no channel is available', async () => {
    const selected = { channel: { id: 11 } };
    selectChannelMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
    });

    expect(result).toBe(selected);
    expect(selectChannelMock).toHaveBeenCalledTimes(2);
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
  });

  it('uses selectNextChannel on retry attempts without refreshing models', async () => {
    const selected = { channel: { id: 22 } };
    selectNextChannelMock.mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [11],
      retryCount: 1,
    });

    expect(result).toBe(selected);
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).toHaveBeenCalledWith(
      'gpt-5.2',
      [11],
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
    );
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
  });

  it('prefers the sticky session channel on the first attempt when it is still eligible', async () => {
    const selected = { channel: { id: 55 } };
    getStickyChannelIdMock.mockReturnValueOnce(55);
    selectPreferredChannelMock.mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: 'sticky-session',
    });

    expect(result).toBe(selected);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      'gpt-5.2',
      55,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(clearStickyChannelMock).not.toHaveBeenCalled();
  });

  it('uses the forced tester channel before sticky or automatic selection', async () => {
    const selected = { channel: { id: 88 } };
    selectPreferredChannelMock.mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: 'sticky-session',
      forcedChannelId: 88,
    });

    expect(result).toBe(selected);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      'gpt-5.2',
      88,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
    expect(getStickyChannelIdMock).not.toHaveBeenCalled();
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
  });

  it('does not refresh or fall back when the forced tester channel is unavailable', async () => {
    selectPreferredChannelMock.mockResolvedValueOnce(null);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      forcedChannelId: 91,
    });

    expect(result).toBeNull();
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      'gpt-5.2',
      91,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
  });

  it('refreshes and retries the sticky preferred channel before clearing a stale binding', async () => {
    const selected = { channel: { id: 22 } };
    getStickyChannelIdMock.mockReturnValueOnce(55);
    selectPreferredChannelMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    selectChannelMock.mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: 'sticky-session',
    });

    expect(result).toBe(selected);
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(2);
    expect(clearStickyChannelMock).toHaveBeenCalledWith('sticky-session', 55);
    expect(selectChannelMock).toHaveBeenCalledWith('gpt-5.2', EMPTY_DOWNSTREAM_ROUTING_POLICY);
  });

  it('keeps the sticky binding when route refresh recovers the preferred channel', async () => {
    const selected = { channel: { id: 55 } };
    getStickyChannelIdMock.mockReturnValueOnce(55);
    selectPreferredChannelMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: 'sticky-session',
    });

    expect(result).toBe(selected);
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(2);
    expect(clearStickyChannelMock).not.toHaveBeenCalled();
    expect(selectChannelMock).not.toHaveBeenCalled();
  });

  it('logs refresh failures and still retries selection once on the first attempt', async () => {
    const selected = { channel: { id: 33 } };
    selectChannelMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(selected);
    refreshModelsAndRebuildRoutesMock.mockRejectedValueOnce(new Error('refresh failed'));

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
    });

    expect(result).toBe(selected);
    expect(selectChannelMock).toHaveBeenCalledTimes(2);
    expect(consoleWarnMock).toHaveBeenCalledWith(
      '[proxy/surface] failed to refresh routes after empty selection',
      expect.any(Error),
    );
  });

  it('writes proxy logs through the shared log formatter and store', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);

    const { writeSurfaceProxyLog } = await import('./sharedSurface.js');
    await writeSurfaceProxyLog({
      warningScope: 'chat',
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33 },
        actualModel: 'upstream-model',
      },
      modelRequested: 'gpt-5.2',
      status: 'failed',
      httpStatus: 502,
      // 观测列：`http_status=502`（metapi 判定失败）与客户端实收并不总一致——
      // 已 hijack 的 SSE 出口客户端实收 200 + 流内错误帧，故两列分开传。
      clientHttpStatus: 200,
      latencyMs: 1200,
      errorMessage: 'upstream failed',
      retryCount: 1,
      downstreamPath: '/v1/chat/completions',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimatedCost: 0.42,
      billingDetails: { source: 'test' },
      upstreamPath: '/v1/responses',
      usageSource: 'self-log',
      clientContext: {
        clientKind: 'codex',
        clientAppId: 'app-id',
        clientAppName: 'App',
        clientConfidence: 'high',
        sessionId: 'sess-1',
        traceHint: 'trace-1',
      },
      downstreamApiKeyId: 44,
    });

    expect(composeProxyLogMessageMock).toHaveBeenCalledWith({
      clientKind: 'codex',
      sessionId: 'sess-1',
      traceHint: 'trace-1',
      downstreamPath: '/v1/chat/completions',
      upstreamPath: '/v1/responses',
      usageSource: 'self-log',
      errorMessage: 'upstream failed',
    });
    expect(insertProxyLogMock).toHaveBeenCalledWith({
      routeId: 22,
      channelId: 11,
      accountId: 33,
      downstreamApiKeyId: 44,
      modelRequested: 'gpt-5.2',
      modelActual: 'upstream-model',
      status: 'failed',
      httpStatus: 502,
      clientHttpStatus: 200,
      isStream: null,
      firstByteLatencyMs: null,
      latencyMs: 1200,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      reasoningTokens: null,
      promptTokensIncludeCache: null,
      usageSource: 'self-log',
      estimatedCost: 0.42,
      billingDetails: { source: 'test' },
      clientFamily: 'codex',
      clientAppId: 'app-id',
      clientAppName: 'App',
      clientConfidence: 'high',
      errorMessage: 'normalized error',
      retryCount: 1,
      createdAt: '2026-03-21 22:00:00',
    });
  });

  it('builds runtime dispatch requests with site proxy initialization', async () => {
    const site = { url: 'https://upstream.example.com' };
    const request = {
      endpoint: 'responses',
      path: '/v1/responses',
      headers: { authorization: 'Bearer test' },
      body: { model: 'gpt-5.2', input: 'hello' },
      runtime: { executor: 'default' },
    };
    resolveChannelProxyUrlMock.mockReturnValue('http://proxy.example.com');
    withSiteRecordProxyRequestInitMock.mockImplementation(async (_site, init, proxyUrl) => ({
      ...init,
      proxyUrl,
    }));
    dispatchRuntimeRequestMock.mockResolvedValue('ok');

    const { createSurfaceDispatchRequest } = await import('./sharedSurface.js');
    const dispatchRequest = createSurfaceDispatchRequest({
      site,
      accountExtraConfig: '{"proxyUrl":"http://proxy.example.com"}',
    });
    const result = await dispatchRequest(request, 'https://target.example.com/v1/responses');

    expect(result).toBe('ok');
    expect(resolveChannelProxyUrlMock).toHaveBeenCalledWith(
      site,
      '{"proxyUrl":"http://proxy.example.com"}',
    );
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchRuntimeRequestMock.mock.calls[0]?.[0];
    expect(dispatchArg.siteUrl).toBe('https://upstream.example.com');
    expect(dispatchArg.targetUrl).toBe('https://target.example.com/v1/responses');
    expect(dispatchArg.request).toBe(request);
    return dispatchArg.buildInit('https://target.example.com/v1/responses', {
      headers: { authorization: 'Bearer test' },
      body: { model: 'gpt-5.2', input: 'hello' },
    }).then((init: Record<string, unknown>) => {
      expect(withSiteRecordProxyRequestInitMock).toHaveBeenCalledWith(site, {
        method: 'POST',
        headers: { authorization: 'Bearer test' },
        body: JSON.stringify({ model: 'gpt-5.2', input: 'hello' }),
      }, 'http://proxy.example.com');
      expect(init).toEqual({
        method: 'POST',
        headers: { authorization: 'Bearer test' },
        body: JSON.stringify({ model: 'gpt-5.2', input: 'hello' }),
        proxyUrl: 'http://proxy.example.com',
      });
    });
  });

  it('retries retryable upstream HTTP failures through the shared failure toolkit', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(true);
    isTokenExpiredErrorMock.mockReturnValue(false);
    recordOauthQuotaResetHintMock.mockResolvedValue(null);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'chat',
      downstreamPath: '/v1/chat/completions',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: 44,
    });

    const result = await toolkit.handleUpstreamFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      status: 429,
      errText: 'quota exceeded',
      rawErrText: '{"error":"quota exceeded"}',
      latencyMs: 1200,
      retryCount: 0,
    });

    expect(result).toEqual({ action: 'retry' });
    expect(recordFailureMock).toHaveBeenCalledWith(11, {
      status: 429,
      errorText: '{"error":"quota exceeded"}',
      modelName: 'upstream-model',
    });
    expect(recordOauthQuotaResetHintMock).toHaveBeenCalledWith({
      accountId: 33,
      statusCode: 429,
      errorText: '{"error":"quota exceeded"}',
    });
    expect(reportProxyAllFailedMock).not.toHaveBeenCalled();
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 11,
      accountId: 33,
      downstreamApiKeyId: 44,
      modelRequested: 'gpt-5.2',
      modelActual: 'upstream-model',
      status: 'failed',
      httpStatus: 429,
      latencyMs: 1200,
      errorMessage: 'normalized error',
      retryCount: 0,
    }));
  });

  it('keeps retryable failures on the retry path even when quota hint recording fails', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(true);
    isTokenExpiredErrorMock.mockReturnValue(false);
    recordOauthQuotaResetHintMock.mockRejectedValue(new Error('hint failed'));

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'chat',
      downstreamPath: '/v1/chat/completions',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    await expect(toolkit.handleUpstreamFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      status: 429,
      errText: 'quota exceeded',
      rawErrText: '{"error":"quota exceeded"}',
      latencyMs: 1200,
      retryCount: 0,
    })).resolves.toEqual({ action: 'retry' });
  });

  it('returns a terminal upstream error response and reports token expiration when retries stop', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(false);
    isTokenExpiredErrorMock.mockReturnValue(true);
    recordOauthQuotaResetHintMock.mockResolvedValue(null);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath: '/v1/responses',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    const result = await toolkit.handleUpstreamFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      status: 401,
      errText: 'expired token',
      rawErrText: 'expired token',
      latencyMs: 900,
      retryCount: 2,
    });

    expect(result).toEqual({
      action: 'respond',
      status: 401,
      payload: {
        error: {
          message: 'expired token',
          type: 'upstream_error',
        },
      },
    });
    expect(reportTokenExpiredMock).toHaveBeenCalledWith({
      accountId: 33,
      username: 'oauth-user',
      siteName: 'Codex OAuth',
      detail: 'HTTP 401',
    });
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-5.2',
      reason: 'upstream returned HTTP 401',
    });
  });

  it('returns terminal failures even when final alerting throws', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(false);
    isTokenExpiredErrorMock.mockReturnValue(true);
    recordOauthQuotaResetHintMock.mockResolvedValue(null);
    reportTokenExpiredMock.mockRejectedValue(new Error('token alert failed'));

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath: '/v1/responses',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    await expect(toolkit.handleUpstreamFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      status: 401,
      errText: 'expired token',
      rawErrText: 'expired token',
      latencyMs: 900,
      retryCount: 2,
    })).resolves.toEqual({
      action: 'respond',
      status: 401,
      payload: {
        error: {
          message: 'expired token',
          type: 'upstream_error',
        },
      },
    });
  });

  it('handles detected proxy failures through the shared failure toolkit', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(false);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'chat',
      downstreamPath: '/v1/chat/completions',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    const result = await toolkit.handleDetectedFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      failure: {
        status: 500,
        reason: 'upstream failure',
      },
      latencyMs: 700,
      retryCount: 2,
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      upstreamPath: '/v1/responses',
    });

    expect(result).toEqual({
      action: 'respond',
      status: 500,
      payload: {
        error: {
          message: 'upstream failure',
          type: 'upstream_error',
        },
      },
    });
    expect(recordFailureMock).toHaveBeenCalledWith(11, {
      status: 500,
      errorText: 'upstream failure',
      modelName: 'upstream-model',
    });
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-5.2',
      reason: 'upstream failure',
    });
    expect(recordOauthQuotaResetHintMock).not.toHaveBeenCalled();
  });

  it('returns a terminal 502 for exhausted network failures through the shared failure toolkit', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath: '/v1/responses',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    const result = await toolkit.handleExecutionError({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      errorMessage: 'socket hang up',
      latencyMs: 650,
      retryCount: 2,
    });

    expect(result).toEqual({
      action: 'respond',
      status: 502,
      payload: {
        error: {
          message: 'Upstream error: socket hang up',
          // 无真实上游 HTTP 响应 ⇒ server_error + 合成 502（与两条 surf 侧出口同口径）。
          type: 'server_error',
        },
      },
    });
    expect(recordFailureMock).toHaveBeenCalledWith(11, {
      errorText: 'socket hang up',
      modelName: 'upstream-model',
    });
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-5.2',
      reason: 'socket hang up',
    });
    // 未 hijack 的同一出口：客户端实收就是出口合成的 502（取值器缺省时不得退化成别的值）。
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      httpStatus: 0,
      clientHttpStatus: 502,
    }));
  });

  it('logs the client-visible 200 for an execution error that happened after the SSE was hijacked', async () => {
    // 失真复现：已 hijack 的 SSE 断流也会走本出口（调用方在 `respondTerminalFailure` 里以
    // `streamStarted` 决定写 in-band 帧），此时客户端实收 200 + 流内错误帧，而 `http_status` 仍是 0
    // （从未拿到上游 HTTP 响应）。两列分道扬镳正是本列存在的意义，硬编码 502 会让该列首次上线即失真。
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'chat',
      downstreamPath: '/v1/chat/completions',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
      // 已 hijack ⇒ 取值器给 200（与 chatSurface/openAiResponsesSurface 的接线同形）。
      resolveClientHttpStatus: () => 200,
    });

    await toolkit.handleExecutionError({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      errorMessage: 'terminated',
      isStream: true,
      latencyMs: 650,
      retryCount: 2,
    });

    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      httpStatus: 0,
      clientHttpStatus: 200,
    }));
  });

  it('records stream failures with error text even without a runtime status code', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath: '/v1/responses',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    await toolkit.recordStreamFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      errorMessage: 'stream exploded',
      latencyMs: 450,
      retryCount: 1,
    });

    expect(recordFailureMock).toHaveBeenCalledWith(11, {
      errorText: 'stream exploded',
      modelName: 'upstream-model',
    });
  });

  it('refreshes oauth tokens through the shared recover helper and retries the rebuilt request', async () => {
    const refreshedResponse = {
      ok: true,
      status: 200,
      text: vi.fn(),
    };
    const selected = {
      account: {
        id: 33,
        accessToken: 'old-access-token',
        extraConfig: '{"oauth":{"refreshToken":"refresh"}}',
      },
      tokenValue: 'old-access-token',
    };
    const ctx = {
      request: {
        endpoint: 'responses' as const,
        path: '/v1/responses',
        headers: { authorization: 'Bearer old-access-token' },
        body: { model: 'gpt-5.2' },
      },
      response: {
        ok: false,
        status: 401,
        text: vi.fn(),
      },
      rawErrText: 'expired token',
    };
    refreshOauthAccessTokenSingleflightMock.mockResolvedValue({
      accessToken: 'new-access-token',
      extraConfig: '{"oauth":{"refreshToken":"refresh-next"}}',
    });
    const dispatchRequest = vi.fn().mockResolvedValue(refreshedResponse);

    const { trySurfaceOauthRefreshRecovery } = await import('./sharedSurface.js');
    const result = await trySurfaceOauthRefreshRecovery({
      ctx,
      selected,
      siteUrl: 'https://upstream.example.com',
      buildRequest: () => ({
        endpoint: 'responses',
        path: '/v1/responses',
        headers: { authorization: `Bearer ${selected.tokenValue}` },
        body: { model: 'gpt-5.2' },
      }),
      dispatchRequest,
    });

    expect(refreshOauthAccessTokenSingleflightMock).toHaveBeenCalledWith(33);
    expect(selected.tokenValue).toBe('new-access-token');
    expect(selected.account.accessToken).toBe('new-access-token');
    expect(selected.account.extraConfig).toBe('{"oauth":{"refreshToken":"refresh-next"}}');
    expect(dispatchRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: { authorization: 'Bearer new-access-token' },
    }), 'https://upstream.example.com/v1/responses');
    expect(result).toEqual({
      request: {
        endpoint: 'responses',
        path: '/v1/responses',
        headers: { authorization: 'Bearer new-access-token' },
        body: { model: 'gpt-5.2' },
      },
      targetUrl: 'https://upstream.example.com/v1/responses',
      upstream: refreshedResponse,
      upstreamPath: '/v1/responses',
    });
  });

  it('updates the recover context with the refreshed failure response when oauth refresh retry still fails', async () => {
    const refreshedResponse = {
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue('account mismatch'),
    };
    const ctx = {
      request: {
        endpoint: 'responses' as const,
        path: '/v1/responses',
        headers: { authorization: 'Bearer old-access-token' },
        body: { model: 'gpt-5.2' },
      },
      response: {
        ok: false,
        status: 401,
        text: vi.fn(),
      },
      rawErrText: 'expired token',
    };
    const selected = {
      account: {
        id: 33,
        accessToken: 'old-access-token',
        extraConfig: '{"oauth":{"refreshToken":"refresh"}}',
      },
      tokenValue: 'old-access-token',
    };
    refreshOauthAccessTokenSingleflightMock.mockResolvedValue({
      accessToken: 'new-access-token',
      extraConfig: '{"oauth":{"refreshToken":"refresh-next"}}',
    });

    const { trySurfaceOauthRefreshRecovery } = await import('./sharedSurface.js');
    const result = await trySurfaceOauthRefreshRecovery({
      ctx,
      selected,
      siteUrl: 'https://upstream.example.com',
      buildRequest: () => ({
        endpoint: 'responses',
        path: '/v1/responses',
        headers: { authorization: `Bearer ${selected.tokenValue}` },
        body: { model: 'gpt-5.2' },
      }),
      dispatchRequest: vi.fn().mockResolvedValue(refreshedResponse),
    });

    expect(result).toBeNull();
    expect(ctx.request.headers).toEqual({ authorization: 'Bearer new-access-token' });
    expect(ctx.response).toBe(refreshedResponse);
    expect(ctx.rawErrText).toBe('account mismatch');
  });

  it('records shared success bookkeeping with usage fallback, billing, and success logging', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 20,
      completionTokens: 8,
      totalTokens: 28,
      recoveredFromSelfLog: true,
      estimatedCostFromQuota: 0.42,
      selfLogBillingMeta: null,
      usageSource: 'self-log',
    });
    resolveProxyLogBillingMock.mockResolvedValue({
      estimatedCost: 0.42,
      billingDetails: { source: 'pricing-test' },
    });
    const logSuccess = vi.fn().mockResolvedValue({ written: true, proxyLogId: 77 });
    const recordDownstreamCost = vi.fn();

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    const result = await recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', name: 'Codex OAuth' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        promptTokensIncludeCache: null,
        presence: {
          promptTokens: false,
          completionTokens: false,
          totalTokens: false,
          cacheReadTokens: false,
          cacheCreationTokens: false,
          reasoningTokens: false,
        },
      },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 1,
      upstreamPath: '/v1/responses',
      logSuccess,
      recordDownstreamCost,
    });

    expect(resolveProxyUsageWithSelfLogFallbackMock).toHaveBeenCalledWith({
      site: { id: 44, url: 'https://upstream.example.com', name: 'Codex OAuth' },
      account: { id: 33, username: 'oauth-user' },
      tokenValue: 'live-token',
      tokenName: 'default',
      modelName: 'upstream-model',
      requestStartedAtMs: 1000,
      requestEndedAtMs: 1250,
      localLatencyMs: 250,
      upstreamUsagePresent: false,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    });
    expect(resolveProxyLogBillingMock).toHaveBeenCalledWith({
      site: { id: 44, url: 'https://upstream.example.com', name: 'Codex OAuth' },
      account: { id: 33, username: 'oauth-user' },
      modelName: 'upstream-model',
      resolvedUsage: {
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
        recoveredFromSelfLog: true,
        estimatedCostFromQuota: 0.42,
        selfLogBillingMeta: null,
      },
      resolvedUsageColumns: {
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        promptTokensIncludeCache: null,
        reasoningTokens: null,
      },
    });
    expect(recordSuccessMock).toHaveBeenCalledWith(11, 250, 0.42, 'upstream-model');
    expect(recordDownstreamCost).toHaveBeenCalledWith(0.42);
    expect(logSuccess).toHaveBeenCalledWith({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', name: 'Codex OAuth' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      modelRequested: 'gpt-5.2',
      status: 'success',
      httpStatus: 200,
      // 成功出口：客户端实收 200（JSON 或已 hijack 的 SSE），与 `httpStatus` 同值但语义独立。
      clientHttpStatus: 200,
      isStream: null,
      firstByteLatencyMs: null,
      latencyMs: 250,
      errorMessage: null,
      retryCount: 1,
      promptTokens: 20,
      completionTokens: 8,
      totalTokens: 28,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      reasoningTokens: null,
      promptTokensIncludeCache: null,
      usageSource: 'self-log',
      estimatedCost: 0.42,
      billingDetails: { source: 'pricing-test' },
      upstreamPath: '/v1/responses',
      siteId: 44,
    });
    expect(result).toEqual({
      resolvedUsage: {
        columns: {
          promptTokens: 20,
          completionTokens: 8,
          totalTokens: 28,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          reasoningTokens: null,
          promptTokensIncludeCache: null,
        },
        billing: {
          promptTokens: 20,
          completionTokens: 8,
          totalTokens: 28,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          promptTokensIncludeCache: null,
        },
        usageSource: 'self-log',
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        reasoningTokens: null,
        promptTokensIncludeCache: null,
        recoveredFromSelfLog: true,
        estimatedCostFromQuota: 0.42,
        selfLogBillingMeta: null,
      },
      estimatedCost: 0.42,
      billingDetails: { source: 'pricing-test' },
      proxyLogWrite: { written: true, proxyLogId: 77 },
    });
  });

  it('logs unknown usage as null tokens while preserving success bookkeeping', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      recoveredFromSelfLog: false,
      estimatedCostFromQuota: 0,
      selfLogBillingMeta: null,
      usageSource: 'unknown',
    });
    resolveProxyLogBillingMock.mockResolvedValue({
      estimatedCost: 0,
      billingDetails: null,
    });
    const logSuccess = vi.fn().mockResolvedValue(undefined);

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    await recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', platform: 'new-api', name: 'Upstream' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 0,
      upstreamPath: '/v1/chat/completions',
      logSuccess,
    });

    expect(resolveProxyUsageWithSelfLogFallbackMock).toHaveBeenCalledWith(expect.objectContaining({
      upstreamUsagePresent: false,
    }));
    expect(logSuccess).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageSource: 'unknown',
    }));
  });

  it('treats explicit all-zero upstream (presence=true) as present: no self-log lookup, upstream label, no quota cost', async () => {
    // 服务侧契约：upstreamUsagePresent=true 时不应查 self-log，
    // 这里用「若真回查则会拿到 quota 覆盖」的返回值做陷阱。
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      recoveredFromSelfLog: false,
      estimatedCostFromQuota: 0,
      selfLogBillingMeta: null,
      usageSource: 'upstream',
    });
    resolveProxyLogBillingMock.mockResolvedValue({
      estimatedCost: 0,
      billingDetails: null,
    });
    const logSuccess = vi.fn().mockResolvedValue({ written: true, proxyLogId: 77 });

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    const result = await recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', platform: 'new-api', name: 'Upstream' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        promptTokensIncludeCache: null,
        presence: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          cacheReadTokens: true,
          cacheCreationTokens: true,
          reasoningTokens: false,
        },
      },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 0,
      upstreamPath: '/v1/chat/completions',
      logSuccess,
    });

    // 显式全 0 是「上游在场」，不得被当成「上游缺失」触发 self-log 回查。
    expect(resolveProxyUsageWithSelfLogFallbackMock).toHaveBeenCalledWith(expect.objectContaining({
      upstreamUsagePresent: true,
    }));
    // 标签保持 'upstream'（不是 'unknown'），token 列写显式 0（不是 null）。
    expect(logSuccess).toHaveBeenCalledWith(expect.objectContaining({
      usageSource: 'upstream',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }));
    // estimatedCost 不被 quota 覆盖（计费输入为 0，非 self-log 恢复值）。
    expect(result.estimatedCost).toBe(0);
    expect(result.resolvedUsage.recoveredFromSelfLog).toBe(false);
    expect(result.resolvedUsage.estimatedCostFromQuota).toBe(0);
    expect(result.resolvedUsage.usageSource).toBe('upstream');
  });

  it('captures codex quota headers from successful upstream responses as best-effort bookkeeping', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      recoveredFromSelfLog: false,
      estimatedCostFromQuota: 0,
      selfLogBillingMeta: null,
      usageSource: 'upstream',
    });
    resolveProxyLogBillingMock.mockResolvedValue({
      estimatedCost: 0.12,
      billingDetails: null,
    });
    recordOauthQuotaHeadersSnapshotMock.mockResolvedValue(null);
    const logSuccess = vi.fn().mockResolvedValue(undefined);

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    await recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', name: 'Codex OAuth' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 0,
      upstreamPath: '/v1/responses',
      upstreamHeaders: new Headers({
        'x-codex-primary-used-percent': '61',
        'x-codex-secondary-used-percent': '13',
      }),
      logSuccess,
    });

    await vi.waitFor(() => {
      expect(recordOauthQuotaHeadersSnapshotMock).toHaveBeenCalledWith({
        accountId: 33,
        headers: expect.any(Headers),
      });
    });
  });

  it('treats success metrics as best-effort when requested', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockRejectedValueOnce(new Error('billing failed'));
    const logSuccess = vi.fn().mockResolvedValue({ written: true, proxyLogId: 77 });
    const recordDownstreamCost = vi.fn();

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    const result = await recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', name: 'Codex OAuth' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 1,
      upstreamPath: '/v1/responses',
      logSuccess,
      recordDownstreamCost,
      bestEffortMetrics: {
        errorLabel: '[proxy/chat] failed to record success metrics',
      },
    });

    expect(consoleErrorMock).toHaveBeenCalledWith(
      '[proxy/chat] failed to record success metrics',
      expect.any(Error),
    );
    expect(recordSuccessMock).toHaveBeenCalledWith(11, 250, 0, 'upstream-model');
    expect(recordDownstreamCost).toHaveBeenCalledWith(0);
    expect(logSuccess).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimatedCost: 0,
      billingDetails: null,
    }));
    expect(result).toEqual({
      resolvedUsage: {
        columns: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          reasoningTokens: null,
          promptTokensIncludeCache: null,
        },
        billing: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          promptTokensIncludeCache: null,
        },
        usageSource: 'upstream',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        reasoningTokens: null,
        promptTokensIncludeCache: null,
        recoveredFromSelfLog: false,
        estimatedCostFromQuota: 0,
        selfLogBillingMeta: null,
      },
      estimatedCost: 0,
      billingDetails: null,
      proxyLogWrite: { written: true, proxyLogId: 77 },
    });
  });

  it('carries a resolved `{ written: false }` through as the three-state contract (no throw)', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      recoveredFromSelfLog: false,
      estimatedCostFromQuota: 0,
      selfLogBillingMeta: null,
      usageSource: 'unknown',
    });
    resolveProxyLogBillingMock.mockResolvedValue({ estimatedCost: 0, billingDetails: null });
    const logSuccess = vi.fn().mockResolvedValue({ written: false });

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    const result = await recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', platform: 'new-api', name: 'Upstream' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 0,
      upstreamPath: '/v1/chat/completions',
      logSuccess,
    });

    expect(result.proxyLogWrite).toEqual({ written: false });
    expect(logSuccess).toHaveBeenCalledTimes(1);
  });

  it('normalizes the legacy resolved shape without `written` into `{ written: false }`', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      recoveredFromSelfLog: false,
      estimatedCostFromQuota: 0,
      selfLogBillingMeta: null,
      usageSource: 'unknown',
    });
    resolveProxyLogBillingMock.mockResolvedValue({ estimatedCost: 0, billingDetails: null });
    const logSuccess = vi.fn().mockResolvedValue(undefined);

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    const result = await recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', platform: 'new-api', name: 'Upstream' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 0,
      upstreamPath: '/v1/chat/completions',
      logSuccess,
    });

    expect(result.proxyLogWrite).toEqual({ written: false });
  });

  it('still propagates a rejected logSuccess as an exception, not as three-state', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      recoveredFromSelfLog: false,
      estimatedCostFromQuota: 0,
      selfLogBillingMeta: null,
      usageSource: 'unknown',
    });
    resolveProxyLogBillingMock.mockResolvedValue({ estimatedCost: 0, billingDetails: null });
    // Production `failureToolkit.log` never rejects (writeSurfaceProxyLog turns
    // insert failures into `{ written: false }`); this locks the propagation
    // contract for arbitrary callbacks. Do not add a catch to recordSurfaceSuccess
    // to make this pass.
    const logSuccess = vi.fn().mockRejectedValue(new Error('log chain rejected'));

    const { recordSurfaceSuccess } = await import('./sharedSurface.js');
    await expect(recordSurfaceSuccess({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { id: 44, url: 'https://upstream.example.com', platform: 'new-api', name: 'Upstream' },
        tokenValue: 'live-token',
        tokenName: 'default',
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      parsedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      requestStartedAtMs: 1000,
      latencyMs: 250,
      retryCount: 0,
      upstreamPath: '/v1/chat/completions',
      logSuccess,
    })).rejects.toThrow('log chain rejected');
  });

  it('resolves `{ written: false }` (warn, no throw) when the proxy-log insert rejects', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockRejectedValueOnce(new Error('insert exploded'));

    const { writeSurfaceProxyLog } = await import('./sharedSurface.js');
    const result = await writeSurfaceProxyLog({
      warningScope: 'chat',
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33 },
        actualModel: 'upstream-model',
      },
      modelRequested: 'gpt-5.2',
      status: 'success',
      httpStatus: 200,
      latencyMs: 1200,
      errorMessage: null,
      retryCount: 0,
      downstreamPath: '/v1/chat/completions',
    });

    expect(result).toEqual({ written: false });
    expect(consoleWarnMock).toHaveBeenCalledWith(
      '[proxy/chat] failed to write proxy log',
      expect.any(Error),
    );
  });
});

describe('truncateUpstreamErrorMessage', () => {
  it('caps ASCII messages at the shared limit and marks the cut', async () => {
    const {
      truncateUpstreamErrorMessage,
      UPSTREAM_ERROR_MESSAGE_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER,
    } = await import('./sharedSurface.js');

    const result = truncateUpstreamErrorMessage('y'.repeat(5000));

    expect(result.length).toBe(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
    expect(result.endsWith(UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER)).toBe(true);
  });

  it('truncates by code point so astral characters are never cut in half', async () => {
    const {
      truncateUpstreamErrorMessage,
      UPSTREAM_ERROR_MESSAGE_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER,
    } = await import('./sharedSurface.js');

    const result = truncateUpstreamErrorMessage('\u{1F600}'.repeat(2000));
    const kept = result.slice(0, result.length - UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER.length);

    expect(result.length).toBeLessThanOrEqual(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
    expect(Array.from(result).length).toBeLessThanOrEqual(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
    expect(result.endsWith(UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER)).toBe(true);
    // 保留部分必须整码点收尾：孤立代理对会让下游 JSON 序列化出 U+FFFD / 非法 UTF-8。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
    expect(kept.length % 2).toBe(0);
  });

  it('keeps the trailing (code/request_id) identifier suffix when an upstream message is capped', async () => {
    const {
      truncateUpstreamErrorMessage,
      UPSTREAM_ERROR_MESSAGE_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER,
    } = await import('./sharedSurface.js');

    const message = `${'y'.repeat(5000)} (code=stream_initialization_failed, request_id=req_cap)`;
    const result = truncateUpstreamErrorMessage(message);

    expect(result.length).toBeLessThanOrEqual(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
    expect(result).toContain(UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER);
    // 尾部标识后缀必须留住：排障要靠 `code`/`request_id` 定位上游那次请求（它俩总在末尾，
    // 普通头截会把它们第一个切掉）。
    expect(result.endsWith('(code=stream_initialization_failed, request_id=req_cap)')).toBe(true);
  });

  it('does not treat an upstream-authored parenthetical as an identifier suffix', async () => {
    const {
      truncateUpstreamErrorMessage,
      UPSTREAM_ERROR_MESSAGE_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER,
    } = await import('./sharedSurface.js');

    // 只有含 `code=` / `request_id=` 的尾部括号段才当标识后缀；上游原文自带的括号照常被截。
    const result = truncateUpstreamErrorMessage(`${'y'.repeat(5000)} (see docs for details)`);

    expect(result.length).toBe(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
    expect(result.endsWith(UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER)).toBe(true);
  });

  it('guards the logged upstream message at 64KB while still keeping the identifier suffix', async () => {
    const {
      guardUpstreamErrorMessageForLog,
      UPSTREAM_ERROR_MESSAGE_LOG_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER,
    } = await import('./sharedSurface.js');

    // 落库上限远大于下发上限：1000 与 64KB 之间的上游原文原样落库（不封顶到 1000）。
    const betweenLimits = 'z'.repeat(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH * 50);
    expect(guardUpstreamErrorMessageForLog(betweenLimits)).toBe(betweenLimits);

    const oversized = `${'z'.repeat(70_000)} (code=stream_initialization_failed, request_id=req_log)`;
    const guarded = guardUpstreamErrorMessageForLog(oversized);

    expect(guarded.length).toBeLessThanOrEqual(UPSTREAM_ERROR_MESSAGE_LOG_MAX_LENGTH);
    expect(guarded).toContain(UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER);
    expect(guarded.endsWith('(code=stream_initialization_failed, request_id=req_log)')).toBe(true);
  });
});

describe('writeSurfaceInBandStreamError', () => {
  function fakeHijackedReply() {
    const writes: string[] = [];
    let ended = false;
    return {
      writes,
      hasEnded: () => ended,
      reply: {
        raw: {
          get writableEnded() {
            return ended;
          },
          write: (chunk: string) => {
            writes.push(chunk);
            return true;
          },
          end: () => {
            ended = true;
          },
        },
      },
    };
  }

  it('writes the claude in-band error frame, ends the reply, and never appends [DONE]', async () => {
    const { writeSurfaceInBandStreamError } = await import('./sharedSurface.js');
    const handled = fakeHijackedReply();

    const written = writeSurfaceInBandStreamError({
      reply: handled.reply as any,
      downstreamFormat: 'claude',
      message: 'terminated',
    });

    expect(written).toBe(true);
    expect(handled.hasEnded()).toBe(true);
    expect(handled.writes.join('')).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"terminated"}}\n\n',
    );
    expect(handled.writes.join('')).not.toContain('[DONE]');

    // 幂等：已结束的回复不再写（Node 会丢弃 post-end 写入，不能假装补上了帧）。
    expect(writeSurfaceInBandStreamError({
      reply: handled.reply as any,
      downstreamFormat: 'claude',
      message: 'second',
    })).toBe(false);
    expect(handled.writes).toHaveLength(1);
  });

  it('returns false without touching a destroyed hijacked socket (client abort mid-stream)', async () => {
    // 客户端 abort 后 socket 已销毁，而 `writableEnded` 仍可能是 false；此时 `write` 会抛
    // `ERR_STREAM_DESTROYED`。错误帧只是「尽力而为」的观测手段，不能被一次收尾动作变成新异常，
    // 也不该真的去写（写了也没人收到）——门禁挡住 ⇒ 返回 false 且一次 write 都不发生。
    const { writeSurfaceInBandStreamError } = await import('./sharedSurface.js');
    let writeCalls = 0;
    let endCalls = 0;
    const destroyedReply = {
      raw: {
        writableEnded: false,
        destroyed: true,
        closed: false,
        write: () => {
          writeCalls += 1;
          throw new Error('ERR_STREAM_DESTROYED');
        },
        end: () => {
          endCalls += 1;
          throw new Error('ERR_STREAM_DESTROYED');
        },
      },
    };

    expect(writeSurfaceInBandStreamError({
      reply: destroyedReply as any,
      downstreamFormat: 'openai',
      message: 'terminated',
    })).toBe(false);
    expect(writeCalls).toBe(0);
    expect(endCalls).toBe(0);
  });
});
