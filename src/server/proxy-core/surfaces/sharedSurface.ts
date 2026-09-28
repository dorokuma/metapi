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
      type: 'upstream_error';
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

export function createSurfaceFailureToolkit(input: {
  warningScope: SurfaceWarningScope;
  downstreamPath: string;
  maxRetries: number;
  clientContext?: DownstreamClientContext | null;
  downstreamApiKeyId?: number | null;
}) {
  const log = async (args: {
    selected: SurfaceSelectedChannel;
    modelRequested: string;
    status: string;
    httpStatus: number;
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
            message: args.errText,
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
            message: args.failure.reason,
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
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage: args.errorMessage,
        retryCount: args.retryCount,
      });

      const retry = maybeRetry(args.retryCount);
      if (retry) return retry;

      runBestEffort('report proxy all failed', () => reportProxyAllFailed({
        model: args.requestedModel,
        reason: args.errorMessage || 'network failure',
      }));

      return {
        action: 'respond',
        status: 502,
        payload: {
          error: {
            message: `Upstream error: ${args.errorMessage || 'network failure'}`,
            type: 'upstream_error',
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
      runtimeFailureStatus?: number | null;
    }) {
      const errorMessage = args.errorMessage || 'stream processing failed';
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
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage,
        retryCount: args.retryCount,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        totalTokens: args.totalTokens,
        upstreamPath: args.upstreamPath,
      });
    },
  };
}
