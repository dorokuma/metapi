import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import type { SiteProxyConfigLike } from '../../services/siteProxy.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { hasUpstreamUsageObservation, resolveFinalUsage, type ResolveFinalUsageResult } from '../../services/proxyUsageNormalize.js';
import type { DownstreamRoutingPolicy } from '../../services/downstreamPolicyTypes.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { composeProxyLogMessage } from '../../services/proxyLogMessage.js';
import { resolveProxyLogBilling } from '../../services/proxyBilling.js';
import type { DownstreamClientContext } from '../downstreamClientContext.js';
import { insertProxyLog, type ProxyLogWriteResult } from '../../services/proxyLogStore.js';
import { dispatchRuntimeRequest } from '../../services/runtimeDispatch.js';
import type { BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { buildUpstreamUrl } from '../orchestration/upstreamRequest.js';
import { recordOauthQuotaHeadersSnapshot, recordOauthQuotaResetHint } from '../../services/oauth/quota.js';
import { refreshOauthAccessTokenSingleflight } from '../../services/oauth/refreshSingleflight.js';
import { proxyChannelCoordinator } from '../../services/proxyChannelCoordinator.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import { readRuntimeResponseText } from '../executors/types.js';
import { selectProxyChannelForAttempt } from '../channelSelection.js';
import { db, schema } from '../../db/index.js';
import { RETRY_EXHAUSTED_EVENT_TITLE } from '../../shared/eventTitles.js';

type SelectedChannel = Awaited<ReturnType<typeof tokenRouter.selectChannel>>;
type SurfaceWarningScope = 'chat' | 'responses' | 'rerank';

type SurfaceSelectedChannel = {
  channel: { routeId: number | null; id: number };
  account: { id: number; username?: string | null };
  site: { name?: string | null };
  actualModel?: string | null;
};

type SurfaceFailureResponse = {
  action: 'respond';
  status: number;
  payload: {
    error: {
      message: string;
      // 有真实上游 HTTP 响应 ⇒ `upstream_error`；无（网络层执行失败）⇒ `server_error` + 合成状态码。
      type: 'upstream_error' | 'server_error';
    };
  };
};

type SurfaceFailureOutcome =
  | { action: 'retry' }
  | SurfaceFailureResponse;

type SurfaceOauthRefreshSelectedChannel = {
  account: {
    id: number;
    accessToken?: string | null;
    extraConfig?: string | null;
  };
  tokenValue: string;
};

type SurfaceOauthRefreshContext<TRequest extends BuiltEndpointRequest> = {
  request: TRequest;
  response: Awaited<ReturnType<typeof dispatchRuntimeRequest>>;
  rawErrText: string;
};

type SurfaceSuccessSelectedChannel = SurfaceSelectedChannel & {
  account: Record<string, unknown> & {
    id: number;
    username?: string | null;
    accessToken?: string | null;
    apiToken?: string | null;
    extraConfig?: string | null;
    platformUserId?: number | null;
  };
  site: Record<string, unknown> & {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
    useSystemProxy?: boolean | null;
    proxyUrl?: string | null;
    name?: string | null;
  };
  tokenValue: string;
  tokenName?: string | null;
};

type SurfaceUsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 1h-TTL cache-creation tokens, only when upstream reports them separately (drives expr cc1h). */
  cacheCreationTokens1h?: number;
  promptTokensIncludeCache: boolean | null;
};

type SurfaceResolvedUsageSummary = {
  columns: ResolveFinalUsageResult['columns'];
  billing: ResolveFinalUsageResult['billing'];
  usageSource: ResolveFinalUsageResult['usageSource'];
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
  selfLogBillingMeta: import('../../services/proxyUsageFallbackService.js').SelfLogBillingMeta | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
  promptTokensIncludeCache: boolean | null;
};

export async function selectSurfaceChannelForAttempt(input: {
  requestedModel: string;
  downstreamPolicy: DownstreamRoutingPolicy;
  excludeChannelIds: number[];
  retryCount: number;
  stickySessionKey?: string | null;
  forcedChannelId?: number | null;
}): Promise<SelectedChannel> {
  return await selectProxyChannelForAttempt(input);
}

export function buildSurfaceStickySessionKey(input: {
  clientContext?: DownstreamClientContext | null;
  requestedModel: string;
  downstreamPath: string;
  downstreamApiKeyId?: number | null;
}): string | null {
  return proxyChannelCoordinator.buildStickySessionKey({
    clientKind: input.clientContext?.clientKind || null,
    sessionId: input.clientContext?.sessionId || null,
    requestedModel: input.requestedModel,
    downstreamPath: input.downstreamPath,
    downstreamApiKeyId: input.downstreamApiKeyId,
  });
}

export function getSurfaceStickyPreferredChannelId(stickySessionKey?: string | null): number | null {
  if (!stickySessionKey) return null;
  return proxyChannelCoordinator.getStickyChannelId(stickySessionKey) ?? null;
}

export function bindSurfaceStickyChannel(input: {
  stickySessionKey?: string | null;
  selected: {
    channel: { id: number };
    account?: { extraConfig?: string | null; oauthProvider?: string | null } | null;
  };
}): void {
  proxyChannelCoordinator.bindStickyChannel(
    input.stickySessionKey,
    input.selected.channel.id,
    input.selected.account || undefined,
  );
}

export function clearSurfaceStickyChannel(input: {
  stickySessionKey?: string | null;
  selected: {
    channel: { id: number };
  };
}): void {
  proxyChannelCoordinator.clearStickyChannel(
    input.stickySessionKey,
    input.selected.channel.id,
  );
}

export async function acquireSurfaceChannelLease(input: {
  stickySessionKey?: string | null;
  selected: {
    channel: { id: number };
    site: { id: number; maxConcurrency?: number | null };
    account?: { extraConfig?: string | null; oauthProvider?: string | null } | null;
  };
}) {
  const channelLeaseResult = await proxyChannelCoordinator.acquireChannelLease({
    // Only session-addressable requests should consume the guarded per-channel
    // lease pool. Requests without a stable downstream session key should keep
    // the pre-sticky-session parallel behavior instead of contending globally.
    channelId: input.stickySessionKey ? input.selected.channel.id : 0,
    accountExtraConfig: input.selected.account?.extraConfig,
    accountOauthProvider: input.selected.account?.oauthProvider,
  });
  if (channelLeaseResult.status === 'timeout') {
    return { ...channelLeaseResult, scope: 'channel' as const };
  }

  return channelLeaseResult;
}

export function buildSurfaceChannelBusyMessage(waitMs: number): string {
  return waitMs > 0
    ? `Channel busy: waited ${waitMs}ms for an available session slot`
    : 'Channel busy: no session slot available';
}

export function buildSurfaceConcurrencyBusyMessage(scope: 'channel' | 'site', waitMs: number): string {
  if (scope === 'site') {
    return waitMs > 0
      ? `Site busy: waited ${waitMs}ms for an available concurrency slot`
      : 'Site busy: no concurrency slot available';
  }
  return buildSurfaceChannelBusyMessage(waitMs);
}

type SurfaceSiteRequest = Parameters<typeof runWithSiteApiEndpointPool>[0];

/** 统一处理站点 API 地址池和站点并发租约，供各协议 surface 复用。 */
export async function runWithSurfaceSiteConcurrency<T>(
  site: SurfaceSiteRequest,
  operation: (siteBaseUrl: string) => Promise<T>,
): Promise<T> {
  // 即使站点不限制并发，也要经过地址池；这里的 0 只表示不限制租约数量。
  return runWithSiteApiEndpointPool(site, (target) => operation(target.baseUrl));
}

export function getSurfaceRequestFailure(error: unknown): {
  status: number;
  message: string;
  isSiteConcurrencyBusy: boolean;
} {
  const endpointError = error as {
    name?: unknown;
    status?: unknown;
    rawErrText?: unknown;
    siteConcurrencyTimeout?: unknown;
  } | null;
  const isEndpointError = (
    error instanceof SiteApiEndpointRequestError
    || (typeof error === 'object' && error !== null && endpointError?.name === 'SiteApiEndpointRequestError')
  );
  const status = isEndpointError && typeof endpointError?.status === 'number'
    ? endpointError.status
    : 502;
  const message = typeof endpointError?.rawErrText === 'string' && endpointError.rawErrText.trim()
    ? endpointError.rawErrText
    : (error instanceof Error ? error.message : 'Upstream request failed');
  return {
    status,
    message,
    isSiteConcurrencyBusy: endpointError?.siteConcurrencyTimeout === true,
  };
}

export async function writeSurfaceProxyLog(input: {
  warningScope: string;
  selected: {
    channel: { routeId: number | null; id: number | null };
    account: { id: number | null };
    actualModel?: string | null;
  };
  modelRequested: string;
  status: string;
  httpStatus: number;
  /** 客户端实收状态码（观测列）；不传则落 NULL（不拿 `httpStatus` 替代）。 */
  clientHttpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs: number;
  errorMessage: string | null;
  retryCount: number;
  downstreamPath: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  reasoningTokens?: number | null;
  promptTokensIncludeCache?: boolean | null;
  usageSource?: 'upstream' | 'self-log' | 'unknown' | null;
  estimatedCost?: number;
  billingDetails?: unknown;
  upstreamPath?: string | null;
  clientContext?: DownstreamClientContext | null;
  downstreamApiKeyId?: number | null;
}): Promise<ProxyLogWriteResult> {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: input.clientContext?.clientKind && input.clientContext.clientKind !== 'generic'
        ? input.clientContext.clientKind
        : null,
      sessionId: input.clientContext?.sessionId || null,
      traceHint: input.clientContext?.traceHint || null,
      downstreamPath: input.downstreamPath,
      upstreamPath: input.upstreamPath || null,
      usageSource: input.usageSource || null,
      errorMessage: input.errorMessage,
    });
    const proxyLogId = await insertProxyLog({
      routeId: input.selected.channel.routeId,
      channelId: input.selected.channel.id,
      accountId: input.selected.account.id,
      downstreamApiKeyId: input.downstreamApiKeyId ?? null,
      modelRequested: input.modelRequested,
      modelActual: input.selected.actualModel ?? null,
      status: input.status,
      httpStatus: input.httpStatus,
      clientHttpStatus: input.clientHttpStatus ?? null,
      isStream: input.isStream ?? null,
      firstByteLatencyMs: input.firstByteLatencyMs ?? null,
      latencyMs: input.latencyMs,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheCreationTokens: input.cacheCreationTokens ?? null,
      reasoningTokens: input.reasoningTokens ?? null,
      promptTokensIncludeCache: input.promptTokensIncludeCache ?? null,
      usageSource: input.usageSource ?? null,
      estimatedCost: input.estimatedCost ?? 0,
      billingDetails: input.billingDetails ?? null,
      clientFamily: input.clientContext?.clientKind || null,
      clientAppId: input.clientContext?.clientAppId || null,
      clientAppName: input.clientContext?.clientAppName || null,
      clientConfidence: input.clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount: input.retryCount,
      createdAt,
    });
    // written: true even when the dialect could not report a positive id —
    // "log written, id unavailable" must still persist the observation with a
    // NULL proxy_log_id. Only an actual insert failure is `written: false`.
    return proxyLogId != null && Number.isInteger(proxyLogId) && proxyLogId > 0
      ? { written: true, proxyLogId }
      : { written: true, proxyLogId: null };
  } catch (error) {
    console.warn(`[proxy/${input.warningScope}] failed to write proxy log`, error);
    return { written: false };
  }
}

export function createSurfaceDispatchRequest(input: {
  site: SiteProxyConfigLike & { url: string };
  accountExtraConfig?: string | null;
  siteUrl?: string;
}) {
  const channelProxyUrl = resolveChannelProxyUrl(input.site, input.accountExtraConfig);
  return (
    request: BuiltEndpointRequest,
    targetUrl?: string,
    signal?: AbortSignal,
  ) => (
    dispatchRuntimeRequest({
      siteUrl: input.siteUrl ?? input.site.url,
      targetUrl,
      signal,
      request,
      buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(input.site, {
        method: 'POST',
        headers: requestForFetch.headers,
        body: JSON.stringify(requestForFetch.body),
      }, channelProxyUrl),
    })
  );
}

export async function trySurfaceOauthRefreshRecovery<TRequest extends BuiltEndpointRequest>(input: {
  ctx: SurfaceOauthRefreshContext<TRequest>;
  selected: SurfaceOauthRefreshSelectedChannel;
  siteUrl: string;
  buildRequest: (endpoint: TRequest['endpoint']) => TRequest;
  dispatchRequest: (
    request: TRequest,
    targetUrl: string,
  ) => Promise<Awaited<ReturnType<typeof dispatchRuntimeRequest>>>;
  captureFailureBody?: boolean;
}): Promise<{
  upstream: Awaited<ReturnType<typeof dispatchRuntimeRequest>>;
  upstreamPath: string;
  request?: TRequest;
  targetUrl?: string;
} | null> {
  try {
    const refreshed = await refreshOauthAccessTokenSingleflight(input.selected.account.id);
    input.selected.tokenValue = refreshed.accessToken;
    input.selected.account = {
      ...input.selected.account,
      accessToken: refreshed.accessToken,
      extraConfig: refreshed.extraConfig ?? input.selected.account.extraConfig,
    };

    const refreshedRequest = input.buildRequest(input.ctx.request.endpoint);
    const refreshedTargetUrl = buildUpstreamUrl(input.siteUrl, refreshedRequest.path);
    const refreshedResponse = await input.dispatchRequest(refreshedRequest, refreshedTargetUrl);
    if (refreshedResponse.ok) {
      return {
        upstream: refreshedResponse,
        upstreamPath: refreshedRequest.path,
        request: refreshedRequest,
        targetUrl: refreshedTargetUrl,
      };
    }

    input.ctx.request = refreshedRequest;
    input.ctx.response = refreshedResponse;
    if (input.captureFailureBody !== false) {
      const failureBody = await readRuntimeResponseText(refreshedResponse).catch(() => '');
      input.ctx.rawErrText = failureBody.trim() || 'unknown error';
    }
  } catch {
    return null;
  }

  return null;
}

export async function recordSurfaceSuccess(input: {
  selected: SurfaceSuccessSelectedChannel;
  requestedModel: string;
  modelName: string;
  parsedUsage: SurfaceUsageSummary;
  upstreamUsagePresent?: boolean;
  upstreamHeaders?: { get(name: string): string | null } | null;
  requestStartedAtMs: number;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs: number;
  retryCount: number;
  upstreamPath?: string | null;
  logSuccess: (args: {
    selected: SurfaceSelectedChannel;
    modelRequested: string;
    status: string;
    httpStatus: number;
    clientHttpStatus?: number | null;
    isStream?: boolean | null;
    firstByteLatencyMs?: number | null;
    latencyMs: number;
    errorMessage: string | null;
    retryCount: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    reasoningTokens?: number | null;
    promptTokensIncludeCache?: boolean | null;
    usageSource?: 'upstream' | 'self-log' | 'unknown' | null;
    siteId?: number | null;
    estimatedCost?: number;
    billingDetails?: unknown;
    upstreamPath?: string | null;
  }) => Promise<ProxyLogWriteResult>;
  recordDownstreamCost?: (estimatedCost: number) => void;
  bestEffortMetrics?: {
    errorLabel: string;
  };
}): Promise<{
  resolvedUsage: SurfaceResolvedUsageSummary;
  estimatedCost: number;
  billingDetails: unknown;
  proxyLogWrite: ProxyLogWriteResult;
}> {
  // 上游在场判据：presence 化（与 chat/proxy 路径及 resolveFinalUsage 四分支裁决同口径）。
  // 显式全 0（presence=true）视为上游在场，不得按「上游缺失」进 self-log 回查；
  // 无 presence 的旧调用面按「值 > 0 视为观测到」推断。
  const parsedUpstreamHasObservation = hasUpstreamUsageObservation(input.parsedUsage);
  const hasUpstreamUsage = input.upstreamUsagePresent ?? parsedUpstreamHasObservation;
  let resolvedSelfLog: Awaited<ReturnType<typeof resolveProxyUsageWithSelfLogFallback>> | null = null;
  const initialResolve = resolveFinalUsage({
    upstream: {
      promptTokens: input.parsedUsage.promptTokens,
      completionTokens: input.parsedUsage.completionTokens,
      totalTokens: input.parsedUsage.totalTokens,
      cacheReadTokens: (input.parsedUsage as any).cacheReadTokens ?? 0,
      cacheCreationTokens: (input.parsedUsage as any).cacheCreationTokens ?? 0,
      reasoningTokens: (input.parsedUsage as any).reasoningTokens ?? 0,
      promptTokensIncludeCache: input.parsedUsage.promptTokensIncludeCache,
      presence: (input.parsedUsage as any).presence,
    },
    selfLog: null,
  });
  let resolvedUsage: SurfaceResolvedUsageSummary = {
    columns: initialResolve.columns,
    billing: initialResolve.billing,
    usageSource: hasUpstreamUsage ? 'upstream' : 'unknown',
    promptTokens: initialResolve.columns.promptTokens,
    completionTokens: initialResolve.columns.completionTokens,
    totalTokens: initialResolve.columns.totalTokens,
    cacheReadTokens: initialResolve.columns.cacheReadTokens,
    cacheCreationTokens: initialResolve.columns.cacheCreationTokens,
    reasoningTokens: initialResolve.columns.reasoningTokens,
    promptTokensIncludeCache: initialResolve.columns.promptTokensIncludeCache,
    recoveredFromSelfLog: false,
    estimatedCostFromQuota: 0,
    selfLogBillingMeta: null,
  };
  let billing: { estimatedCost: number; billingDetails: unknown } = { estimatedCost: 0, billingDetails: null };

  try {
    resolvedSelfLog = await resolveProxyUsageWithSelfLogFallback({
      site: input.selected.site,
      account: input.selected.account,
      tokenValue: input.selected.tokenValue,
      tokenName: input.selected.tokenName,
      modelName: input.modelName,
      requestStartedAtMs: input.requestStartedAtMs,
      requestEndedAtMs: input.requestStartedAtMs + input.latencyMs,
      localLatencyMs: input.latencyMs,
      upstreamUsagePresent: parsedUpstreamHasObservation,
      usage: {
        promptTokens: input.parsedUsage.promptTokens,
        completionTokens: input.parsedUsage.completionTokens,
        totalTokens: input.parsedUsage.totalTokens,
      },
    });
    const selfLogUsage = resolvedSelfLog?.recoveredFromSelfLog ? {
      promptTokens: resolvedSelfLog.promptTokens,
      completionTokens: resolvedSelfLog.completionTokens,
      totalTokens: resolvedSelfLog.totalTokens,
      cacheReadTokens: resolvedSelfLog.selfLogBillingMeta?.cacheReadTokens ?? null,
      cacheCreationTokens: resolvedSelfLog.selfLogBillingMeta?.cacheCreationTokens ?? null,
      reasoningTokens: (resolvedSelfLog as any).reasoningTokens ?? null,
      promptTokensIncludeCache: resolvedSelfLog.selfLogBillingMeta?.promptTokensIncludeCache ?? null,
    } : null;
    const updatedResolve = resolveFinalUsage({
      upstream: {
        promptTokens: input.parsedUsage.promptTokens,
        completionTokens: input.parsedUsage.completionTokens,
        totalTokens: input.parsedUsage.totalTokens,
        cacheReadTokens: (input.parsedUsage as any).cacheReadTokens,
        cacheCreationTokens: (input.parsedUsage as any).cacheCreationTokens,
        reasoningTokens: (input.parsedUsage as any).reasoningTokens,
        promptTokensIncludeCache: input.parsedUsage.promptTokensIncludeCache,
        presence: (input.parsedUsage as any).presence,
      },
      selfLog: selfLogUsage,
    });
    resolvedUsage = {
      columns: updatedResolve.columns,
      billing: updatedResolve.billing,
      usageSource: updatedResolve.usageSource,
      promptTokens: updatedResolve.columns.promptTokens,
      completionTokens: updatedResolve.columns.completionTokens,
      totalTokens: updatedResolve.columns.totalTokens,
      cacheReadTokens: updatedResolve.columns.cacheReadTokens,
      cacheCreationTokens: updatedResolve.columns.cacheCreationTokens,
      reasoningTokens: updatedResolve.columns.reasoningTokens,
      promptTokensIncludeCache: updatedResolve.columns.promptTokensIncludeCache,
      recoveredFromSelfLog: resolvedSelfLog?.recoveredFromSelfLog ?? false,
      estimatedCostFromQuota: resolvedSelfLog?.estimatedCostFromQuota ?? 0,
      selfLogBillingMeta: resolvedSelfLog?.selfLogBillingMeta ?? null,
    };
    billing = await resolveProxyLogBilling({
      site: input.selected.site,
      account: input.selected.account,
      modelName: input.modelName,
      resolvedUsage: {
        promptTokens: resolvedUsage.columns.promptTokens ?? 0,
        completionTokens: resolvedUsage.columns.completionTokens ?? 0,
        totalTokens: resolvedUsage.columns.totalTokens ?? 0,
        cacheReadTokens: resolvedUsage.columns.cacheReadTokens ?? 0,
        cacheCreationTokens: resolvedUsage.columns.cacheCreationTokens ?? 0,
        cacheCreationTokens1h: input.parsedUsage.cacheCreationTokens1h,
        promptTokensIncludeCache: resolvedUsage.columns.promptTokensIncludeCache,
        selfLogBillingMeta: resolvedUsage.selfLogBillingMeta,
        recoveredFromSelfLog: resolvedUsage.recoveredFromSelfLog,
        estimatedCostFromQuota: resolvedUsage.estimatedCostFromQuota,
      },
      resolvedUsageColumns: resolvedUsage.columns,
    });
  } catch (error) {
    if (!input.bestEffortMetrics) {
      throw error;
    }
    console.error(input.bestEffortMetrics.errorLabel, error);
  }

  tokenRouter.recordSuccess(
    input.selected.channel.id,
    input.latencyMs,
    billing.estimatedCost,
    input.modelName,
  );
  input.recordDownstreamCost?.(billing.estimatedCost);
  const logTokens = resolvedUsage.usageSource === 'unknown'
    ? {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      reasoningTokens: null,
    }
    : {
      promptTokens: resolvedUsage.columns.promptTokens,
      completionTokens: resolvedUsage.columns.completionTokens,
      totalTokens: resolvedUsage.columns.totalTokens,
      cacheReadTokens: resolvedUsage.columns.cacheReadTokens,
      cacheCreationTokens: resolvedUsage.columns.cacheCreationTokens,
      reasoningTokens: resolvedUsage.columns.reasoningTokens,
    };
  const rawProxyLogWrite = await input.logSuccess({
    selected: input.selected,
    modelRequested: input.requestedModel,
    status: 'success',
    httpStatus: 200,
    // 成功出口：客户端拿到的就是 200（JSON 或已 hijack 的 SSE）。
    clientHttpStatus: 200,
    isStream: input.isStream ?? null,
    firstByteLatencyMs: input.firstByteLatencyMs ?? null,
    latencyMs: input.latencyMs,
    errorMessage: null,
    retryCount: input.retryCount,
    promptTokens: logTokens.promptTokens,
    completionTokens: logTokens.completionTokens,
    totalTokens: logTokens.totalTokens,
    cacheReadTokens: logTokens.cacheReadTokens,
    cacheCreationTokens: logTokens.cacheCreationTokens,
    reasoningTokens: logTokens.reasoningTokens,
    promptTokensIncludeCache: resolvedUsage.columns.promptTokensIncludeCache,
    usageSource: resolvedUsage.usageSource,
    siteId: input.selected.site.id ?? null,
    estimatedCost: billing.estimatedCost,
    billingDetails: billing.billingDetails,
    upstreamPath: input.upstreamPath,
  });
  // Fail closed on malformed resolved shapes (e.g. an outdated test stub that
  // still resolves `undefined`): treat it as "not written". This does not
  // catch rejections and does not turn a legit `{ written: true, proxyLogId: null }`
  // into a failure.
  const proxyLogWrite: ProxyLogWriteResult = (
    rawProxyLogWrite && typeof rawProxyLogWrite.written === 'boolean'
  )
    ? rawProxyLogWrite
    : { written: false };

  if (input.upstreamHeaders) {
    void recordOauthQuotaHeadersSnapshot({
      accountId: input.selected.account.id,
      headers: input.upstreamHeaders,
    }).catch((error) => {
      console.warn('[proxy/shared] failed to record oauth quota headers', error);
    });
  }

  return {
    resolvedUsage,
    estimatedCost: billing.estimatedCost,
    billingDetails: billing.billingDetails,
    proxyLogWrite,
  };
}

/**
 * 上游报错体 message 的长度上限（字符，含截断省略标记）。
 * 上游可以把整段 HTML/JSON 报错塞进 message，原样回传给下游会把响应体撑大，故统一在此封顶。
 */
export const UPSTREAM_ERROR_MESSAGE_MAX_LENGTH = 1000;

/** 截断省略标记（与上限同处定义，避免魔法字符串散落）。 */
export const UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER = '...(truncated)';

/**
 * 上游原文**落库**（`proxy_logs.error_message`）的守卫上限：远大于下发给客户端的 1000。
 * 上游可以把整段 HTML/JSON 报错塞进 message（无界），不经任何守卫就写库会把单行撑到任意大。
 */
export const UPSTREAM_ERROR_MESSAGE_LOG_MAX_LENGTH = 64 * 1024;

/**
 * 尾部标识后缀：`appendFailureIdentifiers`（proxyStream）追加的 `(code=…, request_id=…)`。
 * 只认最后一组不含嵌套括号的括号段，避免把上游原文自带的括号当后缀摘走。
 */
const UPSTREAM_ERROR_IDENTIFIER_SUFFIX_PATTERN = /(\s*\((?=[^()]*\b(?:code|request_id)=)[^()]*\))$/;

/** 按 Unicode 码点累加截取（不切出孤立代理对）。 */
function takeByCodePoints(text: string, maxUtf16Length: number): string {
  let kept = '';
  let used = 0;
  for (const codePoint of text) {
    if (used + codePoint.length > maxUtf16Length) break;
    kept += codePoint;
    used += codePoint.length;
  }
  return kept;
}

/**
 * 上游原文截断（可选上限，默认下发给客户端的 1000）：**尾部标识后缀不受截断影响**。
 *
 * 为什么单独保后缀：`code` / `request_id` 是定位「哪次上游请求失败」的唯一线索，而它们总在末尾，
 * 普通封顶头截会把它们第一个切掉——超长上游原文下，客户端与落库就再也拿不到定位信息。
 */
export function truncateUpstreamErrorMessageWithLimit(message: string, maxLength: number): string {
  const normalized = typeof message === 'string' ? message : '';
  if (normalized.length <= maxLength) return normalized;

  const suffixMatch = UPSTREAM_ERROR_IDENTIFIER_SUFFIX_PATTERN.exec(normalized);
  const suffix = suffixMatch ? suffixMatch[1] : '';
  const head = suffixMatch ? normalized.slice(0, suffixMatch.index) : normalized;
  const marker = UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER;
  const headBudget = maxLength - marker.length - suffix.length;
  if (headBudget <= 0) {
    return `${takeByCodePoints(head, Math.max(0, maxLength - suffix.length))}${suffix}`;
  }
  return `${takeByCodePoints(head, headBudget)}${marker}${suffix}`;
}

/**
 * 上游原文**落库**守卫：与下发同口径（尾后缀保留），但上限放宽到 `UPSTREAM_ERROR_MESSAGE_LOG_MAX_LENGTH`（64KB）。
 */
export function guardUpstreamErrorMessageForLog(message: string): string {
  return truncateUpstreamErrorMessageWithLimit(message, UPSTREAM_ERROR_MESSAGE_LOG_MAX_LENGTH);
}

/**
 * 「已 hijack 的 SSE 流」上失败时给客户端看的 in-band 错误帧（纯函数，不做 IO）。
 *
 * 为什么需要它：SSE 一旦 `reply.hijack()`，回复头已发出，**不能再** `reply.code(502).send(...)`
 * （`ERR_HTTP_HEADERS_SENT`），也不再有任何 HTTP 状态码能告诉客户端「这轮失败了」。唯一剩下的通道
 * 就是流内的帧。所以断流（上游 body 中途 `terminated` / 流在任何终结帧之前结束）时补一帧标准错误，
 * 客户端据此能区分「出错」与「正常结束」。
 *
 * 帧形状按下游协议区分（两者都是各协议自己的标准错误形）：
 * - openai：`data: {"error":{"message":…,"type":"upstream_error","code":502}}\n\n`
 * - claude：`event: error\ndata: {"type":"error","error":{"type":"api_error","message":…}}\n\n`
 *
 * **绝不**在错误帧后追加 `data: [DONE]` 或 `message_stop`：那等于告诉客户端「成功结束」，
 * 会让错误被当成正常收尾吞掉（本轮改动的核心约束之一）。
 */
export function buildSurfaceInBandStreamErrorFrame(input: {
  downstreamFormat: 'openai' | 'claude';
  message: string | null;
}): string {
  const message = typeof input.message === 'string' && input.message.trim().length > 0
    ? input.message
    : 'upstream stream interrupted';
  if (input.downstreamFormat === 'claude') {
    const payload = JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message },
    });
    return `event: error\ndata: ${payload}\n\n`;
  }
  const payload = JSON.stringify({
    error: { message, type: 'upstream_error', code: 502 },
  });
  return `data: ${payload}\n\n`;
}

/**
 * 把上面的错误帧写进已 hijack 的回复并 `end()`（幂等：回复已结束则什么都不做）。
 * 返回是否真的写了帧——调用方通常不关心，但测试需要可断言。
 *
 * 三种「已经写不进去」的死状态一律挡住，且 write/end 包 try/catch：
 * - `writableEnded`：回复已规范化结束（重复写会被 Node 丢弃）；
 * - `destroyed`：客户端 abort 后 socket 已销毁，而 `writableEnded` 仍可能为 false；
 * - `closed`：底层流已关闭。
 * 不挡这些状态时 `write` 会抛 `ERR_STREAM_DESTROYED`——一次「尽量体面收尾」变成新异常，
 * 而错误帧本身是**尽力而为**的观测手段，失败就静默返回 false（不抛）。
 */
export function writeSurfaceInBandStreamError(input: {
  reply: {
    raw: {
      writableEnded: boolean;
      destroyed?: boolean;
      closed?: boolean;
      write(chunk: string): unknown;
      end(): unknown;
    };
  };
  downstreamFormat: 'openai' | 'claude';
  message: string | null;
}): boolean {
  const raw = input.reply.raw;
  if (raw.writableEnded || raw.destroyed === true || raw.closed === true) return false;
  try {
    raw.write(buildSurfaceInBandStreamErrorFrame({
      downstreamFormat: input.downstreamFormat,
      message: input.message,
    }));
    raw.end();
  } catch (error) {
    console.warn('[proxy/surface] failed to write in-band stream error frame', error);
    return false;
  }
  return true;
}

/**
 * 上游报错体 message 截断：总长封顶 `UPSTREAM_ERROR_MESSAGE_MAX_LENGTH`，截断处带明确省略标记。
 * 按 Unicode 码点截断（代理对整体取舍），不会切出孤立代理对；尾部的 `(code=…, request_id=…)`
 * 标识后缀不受截断影响（见 `truncateUpstreamErrorMessageWithLimit`）。
 */
export function truncateUpstreamErrorMessage(message: string): string {
  return truncateUpstreamErrorMessageWithLimit(message, UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
}

/**
 * 「本轮终态失败」留存结构：重试耗尽（重试仍可继续但已无通道可选）时按它回传真实上游原因。
 */
export type SurfaceRetryTerminalFailure = {
  status: number;
  payload: {
    error: {
      message: string;
      type: 'upstream_error' | 'server_error';
    };
  };
  upstreamPath: string | null;
};

/**
 * 重试耗尽出口的运维标记事件：直插一条 `events` 行（与 `routes/api/sites.ts` 的
 * `applySiteStatusSideEffects`、`services/checkinService.ts` 的先例同形——`db.insert(schema.events)`，
 * **不触发推送**）。判别器：`SELECT * FROM events WHERE title = '代理重试耗尽'`。
 *
 * 每轮重试耗尽只调用一次（出口处）；A 形态（首轮真无通道、无留存失败）由调用方保证不调用。
 * `events` 没有结构化列，状态码（含在 `reason` 里）/ 模型 / 轮次 / 试过的通道等上下文只能进 `message` 文本；
 * `reason` 直接复用出口喂给 `reportProxyAllFailed` 的同一串（尾部是上游报错体），
 * 其长度已由出口的 message 截断封顶（≤ `UPSTREAM_ERROR_MESSAGE_MAX_LENGTH`），故整串有界。
 * **除 `reason` 尾段（上游报错体）外**均为本地元数据，不含任何上游凭据/密钥。
 *
 * 本行是**纯 SQL 运维标记**（唯一用途是 `title` 直查），**已从通知中心口径摘除**：
 * `routes/api/events.ts` 的两个读接口（列表 `GET /api/events`、未读计数 `GET /api/events/count`）
 * 按本 title 排除 ⇒ 不出现于通知面板列表、不计入未读徽标/计数；标记行仍照常落库、仍可 `title` 直查。
 * 另仍显式写 `read: true`（`schema.events.read` 为 `integer('read', { mode: 'boolean' }).default(false)`）
 * ⇒ 「只看未读」类筛选同样不命中本行。
 *
 * 写入失败只 warn：**不得**影响客户端响应路径（先例中 `sites.ts` 用空 `catch {}` 吞掉、
 * `checkinService.ts` 则直接 await 不捕获；此处按「不影响响应路径」的要求捕获并 warn）。
 */
export async function insertRetryExhaustedEvent(input: {
  reason: string;
  modelRequested: string;
  isStream?: boolean | null;
  upstreamPath?: string | null;
  /** 出口处循环计数器的值（= 已进行的尝试次数），与 attempt 行上的 0 基 `retry_count` 语义不同。 */
  attempt: number;
  triedChannelIds: number[];
  forcedChannelId?: number | null;
}): Promise<void> {
  const context = [
    `model=${input.modelRequested}`,
    `upstream=${input.upstreamPath || '-'}`,
    `stream=${input.isStream ? 'true' : 'false'}`,
    `attempt=${input.attempt}`,
    `tried_channels=[${input.triedChannelIds.join(',')}]`,
    `forced_channel=${input.forcedChannelId ?? '-'}`,
  ].join('; ');

  try {
    await db.insert(schema.events).values({
      type: 'proxy',
      title: RETRY_EXHAUSTED_EVENT_TITLE,
      message: `${input.reason}; ${context}`,
      level: 'error',
      // 已从通知中心口径摘除（服务端排除该 title）；标记行仍可 SQL 直查。
      read: true,
      relatedType: 'route',
      createdAt: formatUtcSqlDateTime(new Date()),
    }).run();
  } catch (error) {
    console.warn('[proxy] failed to write retry-exhausted event', error);
  }
}

export function createSurfaceFailureToolkit(input: {
  warningScope: SurfaceWarningScope;
  downstreamPath: string;
  maxRetries: number;
  clientContext?: DownstreamClientContext | null;
  downstreamApiKeyId?: number | null;
  /**
   * 客户端实收状态码取值器（仅供观测列 `client_http_status` 用，不影响任何响应行为）。
   *
   * 为什么需要取值器而不是固定值：同一条「流式失败」日志里，客户端实收状态取决于**当时是否已
   * `reply.hijack()`**——已 hijack（SSE 已发帧）时客户端实收 200 + 流内错误帧；未 hijack 时
   * 实收 HTTP 502 JSON。只有 surface 自己知道（chatSurface 的 `streamStarted`），且日志发生在
   * 出口之前，所以这里按调用时实时取值。缺省时沿用传入的 `httpStatus` 口径。
   */
  resolveClientHttpStatus?: () => number | null;
}) {
  const log = async (args: {
    selected: SurfaceSelectedChannel;
    modelRequested: string;
    status: string;
    httpStatus: number;
    clientHttpStatus?: number | null;
    isStream?: boolean | null | undefined;
    firstByteLatencyMs?: number | null | undefined;
    latencyMs: number;
    errorMessage: string | null;
    retryCount: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    reasoningTokens?: number | null;
    promptTokensIncludeCache?: boolean | null;
    usageSource?: 'upstream' | 'self-log' | 'unknown' | null;
    estimatedCost?: number;
    billingDetails?: unknown;
    upstreamPath?: string | null;
  }): Promise<ProxyLogWriteResult> => {
    return await writeSurfaceProxyLog({
      warningScope: input.warningScope,
      selected: args.selected,
      modelRequested: args.modelRequested,
      status: args.status,
      httpStatus: args.httpStatus,
      clientHttpStatus: args.clientHttpStatus ?? null,
      isStream: args.isStream ?? null,
      firstByteLatencyMs: args.firstByteLatencyMs ?? null,
      latencyMs: args.latencyMs,
      errorMessage: args.errorMessage,
      retryCount: args.retryCount,
      downstreamPath: input.downstreamPath,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
      cacheReadTokens: args.cacheReadTokens,
      cacheCreationTokens: args.cacheCreationTokens,
      reasoningTokens: args.reasoningTokens,
      promptTokensIncludeCache: args.promptTokensIncludeCache,
      usageSource: args.usageSource,
      estimatedCost: args.estimatedCost,
      billingDetails: args.billingDetails,
      upstreamPath: args.upstreamPath,
      clientContext: input.clientContext,
      downstreamApiKeyId: input.downstreamApiKeyId,
    });
  };

  const maybeRetry = (retryCount: number) => retryCount < input.maxRetries
    ? { action: 'retry' as const }
    : null;

  const runBestEffort = (label: string, fn: () => Promise<unknown>) => {
    void Promise.resolve()
      .then(fn)
      .catch((error) => {
        console.warn(`[proxy/${input.warningScope}] failed to ${label}`, error);
      });
  };

  const resolveStreamClientHttpStatus = (fallback: number): number => {
    const resolved = input.resolveClientHttpStatus?.();
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : fallback;
  };

  return {
    log,
    async handleUpstreamFailure(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      status: number;
      errText: string;
      rawErrText?: string | null;
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
    }): Promise<SurfaceFailureOutcome> {
      const rawErrText = args.rawErrText || args.errText;
      await tokenRouter.recordFailure(args.selected.channel.id, {
        status: args.status,
        errorText: rawErrText,
        modelName: args.modelName,
      });
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: args.status,
        // 客户端实收：本出口的 respond 状态就是 `args.status`（重试耗尽分支也用同一状态）。
        clientHttpStatus: args.status,
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage: args.errText,
        retryCount: args.retryCount,
      });
      runBestEffort('record oauth quota reset hint', () => recordOauthQuotaResetHint({
        accountId: args.selected.account.id,
        statusCode: args.status,
        errorText: rawErrText,
      }));

      if (isTokenExpiredError({ status: args.status, message: args.errText })) {
        runBestEffort('report token expired', () => reportTokenExpired({
          accountId: args.selected.account.id,
          username: args.selected.account.username,
          siteName: args.selected.site.name,
          detail: `HTTP ${args.status}`,
        }));
      }

      if (shouldRetryProxyRequest(args.status, args.errText)) {
        const retry = maybeRetry(args.retryCount);
        if (retry) return retry;
      }

      runBestEffort('report proxy all failed', () => reportProxyAllFailed({
        model: args.requestedModel,
        reason: `upstream returned HTTP ${args.status}`,
      }));

      return {
        action: 'respond',
        status: args.status,
        payload: {
          error: {
            // errText 来自 readRuntimeResponseText（无大小上限），上游可整段塞入报错体，故与两条
            // 重试耗尽出口同口径封顶（≤1000，含尾标），不改前缀与语义。
            message: truncateUpstreamErrorMessage(args.errText),
            type: 'upstream_error',
          },
        },
      };
    },

    async handleDetectedFailure(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      failure: { status: number; reason: string };
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
      promptTokens?: number | null;
      completionTokens?: number | null;
      totalTokens?: number | null;
      upstreamPath?: string | null;
    }): Promise<SurfaceFailureOutcome> {
      await tokenRouter.recordFailure(args.selected.channel.id, {
        status: args.failure.status,
        errorText: args.failure.reason,
        modelName: args.modelName,
      });
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: args.failure.status,
        // 客户端实收：同上，终端出口沿 `args.failure.status`。
        clientHttpStatus: args.failure.status,
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage: args.failure.reason,
        retryCount: args.retryCount,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        totalTokens: args.totalTokens,
        upstreamPath: args.upstreamPath,
      });

      if (shouldRetryProxyRequest(args.failure.status, args.failure.reason)) {
        const retry = maybeRetry(args.retryCount);
        if (retry) return retry;
      }

      runBestEffort('report proxy all failed', () => reportProxyAllFailed({
        model: args.requestedModel,
        reason: args.failure.reason,
      }));

      return {
        action: 'respond',
        status: args.failure.status,
        payload: {
          error: {
            message: truncateUpstreamErrorMessage(args.failure.reason),
            type: 'upstream_error',
          },
        },
      };
    },

    async handleExecutionError(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      errorMessage: string;
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
    }): Promise<SurfaceFailureOutcome> {
      await tokenRouter.recordFailure(args.selected.channel.id, {
        errorText: args.errorMessage,
        modelName: args.modelName,
      });
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: 0,
        // 客户端实收：本出口既可能是未 hijack 的合成 502 JSON，也可能是**已 hijack 后断流**的兜底
        // （chatSurface.ts / openAiResponsesSurface.ts 的 catch 都走 `respondTerminalFailure`，此时
        // 客户端实收 200 + 流内错误帧，硬编码 502 会让观测列首次上线即带已知失真）。
        // 故与 `recordStreamFailure` 同口径：沿取值器取值，缺省回落到合成的 502。
        clientHttpStatus: resolveStreamClientHttpStatus(502),
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        // 上游原文落库保留（排障靠它），但过 64KB 守卫；尾部 `(code=…, request_id=…)` 标识后缀不被截掉。
        errorMessage: guardUpstreamErrorMessageForLog(args.errorMessage),
        retryCount: args.retryCount,
      });

      const retry = maybeRetry(args.retryCount);
      if (retry) return retry;

      runBestEffort('report proxy all failed', () => reportProxyAllFailed({
        model: args.requestedModel,
        reason: args.errorMessage || 'network failure',
      }));

      // 本出口的调用方（chatSurface 两处 / openAiResponsesSurface 一处）都在「排除掉端点池失败与
      // 站点并发超时之后」的 catch 兜底分支里，即从未拿到真实上游 HTTP 响应（网络层执行失败）。
      // 按「有无真实上游响应」的分流规则：无 ⇒ `server_error` + 合成 502（状态码沿用 502）。
      return {
        action: 'respond',
        status: 502,
        payload: {
          error: {
            message: truncateUpstreamErrorMessage(`Upstream error: ${args.errorMessage || 'network failure'}`),
            type: 'server_error',
          },
        },
      };
    },

    async recordStreamFailure(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      errorMessage: string | null;
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
      promptTokens?: number | null;
      completionTokens?: number | null;
      totalTokens?: number | null;
      upstreamPath?: string | null;
      httpStatus?: number;
      /** 客户端实收状态码（见 `writeSurfaceProxyLog`）。 */
      clientHttpStatus?: number | null;
      runtimeFailureStatus?: number | null;
    }) {
      const errorMessage = args.errorMessage || 'stream processing failed';
      // 上游原文落库保留（排障靠它），但过 64KB 守卫；尾部 `(code=…, request_id=…)` 标识后缀不被截掉。
      const errorMessageForLog = guardUpstreamErrorMessageForLog(errorMessage);
      if (typeof args.runtimeFailureStatus === 'number') {
        await tokenRouter.recordFailure(args.selected.channel.id, {
          status: args.runtimeFailureStatus,
          errorText: errorMessage,
          modelName: args.modelName,
        });
      } else {
        await tokenRouter.recordFailure(args.selected.channel.id, {
          errorText: errorMessage,
          modelName: args.modelName,
        });
      }
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: args.httpStatus ?? 200,
        // 流式失败：调用方按「是否已 hijack 」告知客户端实收（已 hijack ⇒ 200 + 流内错误帧；
        // 未 hijack ⇒ 502 JSON），缺省沿用 `httpStatus` 口径。
        clientHttpStatus: resolveStreamClientHttpStatus(args.clientHttpStatus ?? args.httpStatus ?? 200),
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage: errorMessageForLog,
        retryCount: args.retryCount,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        totalTokens: args.totalTokens,
        upstreamPath: args.upstreamPath,
      });
    },
  };
}
