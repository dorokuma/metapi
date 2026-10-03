import { TextDecoder } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import { hasProxyUsagePayload, mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import {
  extractResponsesTerminalResponseId,
  isResponsesPreviousResponseNotFoundError,
  shouldInferResponsesPreviousResponseId,
  stripResponsesPreviousResponseId,
  withResponsesPreviousResponseId,
} from '../../transformers/openai/responses/continuation.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from '../../services/upstreamEndpointRuntime.js';
import {
  getUpstreamEndpointRuntimeStateSnapshot,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
} from '../../services/upstreamEndpointRuntimeMemory.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from '../../routes/proxy/downstreamPolicy.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { detectProxyFailure } from '../../services/proxyFailureJudge.js';
import {
  createUpstreamProviderObservationCollector,
  observeUpstreamProviderObservationSseText,
} from '../../services/upstreamProviderDetect/collect.js';
import { persistUpstreamProviderObservation, shouldPersistUpstreamObservation } from '../../services/upstreamProviderDetect/store.js';
import type { ProxyLogWriteResult } from '../../services/proxyLogStore.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import { normalizeInputFileBlock } from '../../transformers/shared/inputFile.js';
import { promoteRequiredEndpointCandidateAfterProtocolError } from '../../transformers/shared/endpointCompatibility.js';
import {
  ProxyInputFileResolutionError,
  resolveResponsesBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';
import {
  buildOauthProviderHeaders,
} from '../../services/oauth/service.js';
import { getOauthInfoFromAccount } from '../../services/oauth/oauthAccount.js';
import {
  collectResponsesFinalPayloadFromSse,
  collectResponsesFinalPayloadFromSseText,
  createSingleChunkStreamReader,
  looksLikeResponsesSseText,
} from '../runtime/responsesSseFinal.js';
import {
  createGeminiCliStreamReader,
  unwrapGeminiCliPayload,
} from '../../transformers/gemini/generate-content/cliBridge.js';
import { isCodexResponsesSurface } from '../cliProfiles/codexProfile.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { getRuntimeResponseReader, readRuntimeResponseText } from '../executors/types.js';
import { runCodexHttpSessionTask } from '../runtime/codexHttpSessionQueue.js';
import {
  buildCodexSessionResponseStoreKey,
  clearCodexSessionResponseId,
  getCodexSessionResponseId,
  setCodexSessionResponseId,
} from '../runtime/codexSessionResponseStore.js';
import {
  summarizeConversationFileInputsInOpenAiBody,
  summarizeConversationFileInputsInResponsesBody,
} from '../capabilities/conversationFileCapabilities.js';
import {
  ensureCompactResponsesJsonAcceptHeader,
  sanitizeCompactResponsesRequestBody,
  shouldForceResponsesUpstreamStream,
  shouldFallbackCompactResponsesToResponses,
} from '../capabilities/responsesCompact.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { validateExternalResponsesHttpRequest } from '../responsesPreflight.js';
import { applyOpenAiServiceTierPolicy } from '../serviceTierPolicy.js';
import { maybeHandleWebSearchOnlySimulation } from '../webSearchSimulation.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { shouldAbortSameSiteEndpointFallback } from '../../services/proxyRetryPolicy.js';
import {
  CLIENT_HTTP_STATUS_NON_TERMINAL,
  acquireSurfaceChannelLease,
  bindSurfaceStickyChannel,
  buildSurfaceConcurrencyBusyMessage,
  getSurfaceRequestFailure,
  insertRetryExhaustedEvent,
  buildSurfaceStickySessionKey,
  clearSurfaceStickyChannel,
  createSurfaceFailureToolkit,
  createSurfaceDispatchRequest,
  getSurfaceStickyPreferredChannelId,
  recordSurfaceSuccess,
  selectSurfaceChannelForAttempt,
  truncateUpstreamErrorMessage,
  trySurfaceOauthRefreshRecovery,
  writeSurfaceInBandStreamError,
  type SurfaceRetryTerminalFailure,
} from './sharedSurface.js';
import {
  buildSurfaceProxyDebugResponseHeaders,
  captureSurfaceProxyDebugSuccessResponseBody,
  parseSurfaceProxyDebugTextPayload,
  reserveSurfaceProxyDebugAttemptBase,
  safeFinalizeSurfaceProxyDebugTrace,
  safeInsertSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugCandidates,
  safeUpdateSurfaceProxyDebugSelection,
  startSurfaceProxyDebugTrace,
} from '../../services/proxyDebugTraceRuntime.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
} from '../channelSelection.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function getCodexSessionHeaderValue(headers: Record<string, string>): string {
  const normalizedEntries = Object.entries(headers).map(([rawKey, rawValue]) => [
    rawKey.trim().toLowerCase(),
    String(rawValue || '').trim(),
  ] as const);
  for (const preferredKey of ['session_id', 'session-id', 'conversation_id', 'conversation-id']) {
    const match = normalizedEntries.find(([normalizedKey, normalizedValue]) => (
      normalizedKey === preferredKey && normalizedValue
    ));
    if (match) {
      return match[1];
    }
  }
  return '';
}
function isResponsesWebsocketTransportRequest(headers: Record<string, unknown>): boolean {
  return Object.entries(headers)
    .some(([rawKey, rawValue]) => rawKey.trim().toLowerCase() === 'x-metapi-responses-websocket-transport'
      && String(rawValue).trim() === '1');
}

function rememberCodexSessionResponseId(sessionId: string, payload: unknown): void {
  const responseId = extractResponsesTerminalResponseId(payload);
  if (!responseId) return;
  setCodexSessionResponseId(sessionId, responseId);
}

function normalizeIncludeList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function hasExplicitInclude(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'include');
}

function hasResponsesReasoningRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const relevantKeys = ['effort', 'budget_tokens', 'budgetTokens', 'max_tokens', 'maxTokens', 'summary'];
  return relevantKeys.some((key) => {
    const entry = value[key];
    if (typeof entry === 'string') return entry.trim().length > 0;
    return entry !== undefined && entry !== null;
  });
}

function carriesResponsesReasoningContinuity(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesReasoningContinuity(item));
  }
  if (!isRecord(value)) return false;

  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (type === 'reasoning') {
    if (typeof value.encrypted_content === 'string' && value.encrypted_content.trim()) {
      return true;
    }
    if (Array.isArray(value.summary) && value.summary.length > 0) {
      return true;
    }
  }

  if (typeof value.reasoning_signature === 'string' && value.reasoning_signature.trim()) {
    return true;
  }

  return carriesResponsesReasoningContinuity(value.input)
    || carriesResponsesReasoningContinuity(value.content);
}

function wantsNativeResponsesReasoning(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const include = normalizeIncludeList(body.include);
  if (include.some((item) => item.toLowerCase() === 'reasoning.encrypted_content')) {
    return true;
  }
  if (carriesResponsesReasoningContinuity(body.input)) {
    return true;
  }
  if (hasExplicitInclude(body)) {
    return false;
  }
  return hasResponsesReasoningRequest(body.reasoning);
}

function carriesResponsesFileUrlInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesFileUrlInput(item));
  }
  if (!isRecord(value)) return false;

  const normalizedFile = normalizeInputFileBlock(value);
  if (normalizedFile?.fileUrl) return true;

  return Object.values(value).some((entry) => carriesResponsesFileUrlInput(entry));
}

/** 确有真实上游 HTTP 响应（含上游 401/403）的终态：保持 `upstream_error` + 真实状态码原样回传。 */
function finalizeRetryAsUpstreamFailure(status: number, message: string) {
  return {
    action: 'respond' as const,
    status,
    payload: {
      error: {
        message: truncateUpstreamErrorMessage(message),
        type: 'upstream_error' as const,
      },
    },
  };
}

/**
 * 本地/网关侧执行失败的终态（网络层执行失败、站点端点池全冷却等，从未拿到真实上游 HTTP 响应）：
 * 按“有无真实上游响应”分流为 `server_error` + 合成 502；三类调用点均为无上游响应场景，可在此统一定型。
 */
function finalizeRetryAsExecutionFailure(message: string) {
  return {
    action: 'respond' as const,
    status: 502,
    payload: {
      error: {
        message: truncateUpstreamErrorMessage(`Upstream error: ${message}`),
        type: 'server_error' as const,
      },
    },
  };
}

function shouldRefreshOauthResponsesRequest(input: {
  oauthProvider?: string;
  status: number;
  response: { headers: { get(name: string): string | null } };
  rawErrText: string;
}): boolean {
  if (input.status === 401) return true;
  if (input.status !== 403 || input.oauthProvider !== 'codex') return false;
  const authenticate = input.response.headers.get('www-authenticate') || '';
  const combined = `${authenticate}\n${input.rawErrText || ''}`;
  return /\b(invalid_token|expired_token|expired|invalid|unauthorized|account mismatch|authentication)\b/i.test(combined);
}

type UsageSummary = ReturnType<typeof parseProxyUsage>;

export async function handleOpenAiResponsesSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamPath: '/v1/responses' | '/v1/responses/compact',
) {
    const body = request.body as Record<string, unknown>;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const defaultEncryptedReasoningInclude = isCodexResponsesSurface(
      request.headers as Record<string, unknown>,
    );
    if (!isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>)) {
      const preflight = validateExternalResponsesHttpRequest(body, {
        allowContinuationToolOutput: defaultEncryptedReasoningInclude,
      });
      if (!preflight.ok) {
        return reply.code(preflight.statusCode).send(preflight.payload);
      }
    }
    const parsedRequestEnvelope = openAiResponsesTransformer.transformRequest(body, {
      defaultEncryptedReasoningInclude,
    });
    if (parsedRequestEnvelope.error) {
      return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
    }
    const requestEnvelope = parsedRequestEnvelope.value!;
    const requestedModel = requestEnvelope.model;
    const isStream = requestEnvelope.stream;
    const isCompactRequest = downstreamPath === '/v1/responses/compact';
    if (isCompactRequest && isStream) {
      return reply.code(400).send({
        error: {
          message: 'stream is not supported on /v1/responses/compact',
          type: 'invalid_request_error',
        },
      });
    }
    if (!isCompactRequest) {
      const handledSearch = await maybeHandleWebSearchOnlySimulation({
        app: request.server,
        request,
        reply,
        downstreamFormat: 'responses',
        body: requestEnvelope.parsed.normalizedBody,
      });
      if (handledSearch) return;
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const maxRetries = getProxyMaxChannelRetries();
    // 本轮出口是否已 `reply.hijack()`（见下方 `startSseResponse`）：已 hijack 后终态出口不能再
    // `reply.code().send()`，只能写 in-band 错误帧；同时它是观测列 `client_http_status` 的取值依据
    // （已 hijack ⇒ 客户端实收 200）。与 chatSurface 同语义：**每轮轮首重置**（见 while 循环首行）。
    let streamStarted = false;
    const failureToolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath,
      maxRetries,
      clientContext,
      downstreamApiKeyId,
      // 口径与 chat 面一致：成功=200；未 hijack 失败=出口状态码；已 hijack 流式失败=200。
      resolveClientHttpStatus: () => (streamStarted ? 200 : 502),
    });
    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext,
      requestedModel,
      downstreamPath,
      downstreamApiKeyId,
    });
    const debugTrace = await startSurfaceProxyDebugTrace({
      downstreamPath,
      clientKind: clientContext.clientKind,
      sessionId: clientContext.sessionId || null,
      traceHint: clientContext.traceHint || null,
      requestedModel,
      downstreamApiKeyId,
      requestHeaders: request.headers as Record<string, unknown>,
      requestBody: request.body,
    });
    const finalizeDebugFailure = async (status: number, payload: unknown, upstreamPath: string | null = null) => {
      await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
        finalStatus: 'failed',
        finalHttpStatus: status,
        finalUpstreamPath: upstreamPath,
        finalResponseHeaders: {
          'content-type': 'application/json',
        },
        finalResponseBody: payload,
      });
    };
    const finalizeDebugSuccess = async (status: number, upstreamPath: string | null, responseHeaders: unknown, responseBody: unknown) => {
      await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
        finalStatus: 'success',
        finalHttpStatus: status,
        finalUpstreamPath: upstreamPath,
        finalResponseHeaders: responseHeaders as Record<string, unknown> | null,
        finalResponseBody: responseBody,
      });
    };
    /**
     * 终态失败出口（与 `chatSurface.ts` 的 `respondTerminalFailure` 同口径）。
     *
     * 流式出口一旦 `reply.hijack()`（`startSseResponse`）就不能再 `reply.code().send(...)`：
     * 那会在已发出的 200 头之后又写一份状态行 + JSON 体（双写），并抛
     * `ERR_HTTP_HEADERS_SENT` / `FST_ERR_REP_ALREADY_SENT`。此时改为写一帧标准 in-band 错误
     * （`writeSurfaceInBandStreamError` 自带 `writableEnded`/`destroyed`/`closed` 门禁，且**绝不**
     * 追加 `[DONE]`）；未 hijack 时才走原 `reply.code(status).send(payload)`。
     */
    const respondTerminalFailure = (status: number, payload: any) => {
      if (streamStarted) {
        writeSurfaceInBandStreamError({
          reply,
          downstreamFormat: 'openai',
          message: typeof payload?.error?.message === 'string'
            ? truncateUpstreamErrorMessage(payload.error.message)
            : null,
        });
        return reply;
      }
      return reply.code(status).send(payload);
    };
    const excludeChannelIds: number[] = [];
    let retryCount = 0;
    // 本轮终态失败的真实原因：在确定「继续重试」之前留存（真实 status / 报错体 / 上游路径）。
    // 重试仍可继续、但下一轮已无通道可选（重试耗尽）时，据此向客户端回传上游真实原因，
    // 而不是用 503「No available channels」掩盖它；首轮真无可用通道时它仍为 null，保持原 503 文案。
    let lastRetryFailure: SurfaceRetryTerminalFailure | null = null;

    while (retryCount <= maxRetries) {
      // 轮首重置：新的一轮不能沿用上一轮是否已 hijack 的事实（否则会误写 in-band 帧 / 误判实收状态码）。
      streamStarted = false;
      const stickyPreferredChannelId = retryCount === 0
        ? getSurfaceStickyPreferredChannelId(stickySessionKey)
        : null;
      const selected = await selectSurfaceChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        stickySessionKey,
        forcedChannelId,
      });

      if (!selected) {
        const retryFailure = lastRetryFailure;
        if (retryFailure) {
          const reason = `retry exhausted: HTTP ${retryFailure.status}: ${retryFailure.payload.error.message}`;
          await reportProxyAllFailed({
            model: requestedModel,
            reason,
          });
          // 重试耗尽运维标记：独立 title 直插 events（不推送、不进聚合器），判别器
          // `SELECT * FROM events WHERE title = '代理重试耗尽'`。每轮重试耗尽只写这一条；
          // A 形态（首轮真无通道，retryFailure 为 null）不写。写失败不影响本出口的响应路径。
          await insertRetryExhaustedEvent({
            reason,
            modelRequested: requestedModel,
            isStream,
            upstreamPath: retryFailure.upstreamPath,
            attempt: retryCount,
            triedChannelIds: excludeChannelIds,
            forcedChannelId,
          });
          await finalizeDebugFailure(retryFailure.status, retryFailure.payload, retryFailure.upstreamPath);
          return reply.code(retryFailure.status).send(retryFailure.payload);
        }
        const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
        await reportProxyAllFailed({
          model: requestedModel,
          reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        });
        const payload = {
          error: { message: noChannelMessage, type: 'server_error' as const },
        };
        await finalizeDebugFailure(503, payload, null);
        return reply.code(503).send({
          error: { message: noChannelMessage, type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);
      await safeUpdateSurfaceProxyDebugSelection(debugTrace, {
        stickySessionKey,
        stickyHitChannelId: (
          stickyPreferredChannelId && stickyPreferredChannelId === selected.channel.id
            ? stickyPreferredChannelId
            : null
        ),
        selectedChannelId: selected.channel.id,
        selectedRouteId: selected.channel.routeId ?? null,
        selectedAccountId: selected.account.id,
        selectedSiteId: selected.site.id,
        selectedSitePlatform: selected.site.platform,
      });

      const modelName = selected.actualModel || requestedModel;
      // 上游探测旁路：只在主开关 + 参与站点 + 采样都命中时收集；
      // 收集器随重试 attempt 作用域创建（B2），attempt 内的观测不会泄漏到下一次成功的日志；
      // C4 三态：成功日志写入失败（written: false）则不调用 persist，观测 0 行；
      // 写入成功才钉 id（拿不到正整数 id 时列保持 NULL，读侧回退时间窗）；
      // `logSuccess` 的 rejection 仍由外层处理，不是这条三态；persist 自身不抛，不影响转发字节与状态码。
      const upstreamObservationCollector = createUpstreamProviderObservationCollector({
        requestId: String(request.id ?? ''),
        siteId: selected.site.id,
      });
      const persistUpstreamObservation = async (
        streamRequest: boolean,
        upstreamPath: string | null,
        write: ProxyLogWriteResult,
      ) => {
        // 只看三态，不得用 proxyLogId == null 判失败（written: true 且 id 为 null 仍要落库）。
        if (!shouldPersistUpstreamObservation(write)) return;
        await persistUpstreamProviderObservation({
          observation: upstreamObservationCollector.snapshot(),
          siteId: selected.site.id,
          accountId: selected.account.id,
          routeId: selected.channel.routeId ?? null,
          channelId: selected.channel.id,
          downstreamApiKeyId,
          requestedModel,
          actualModel: modelName,
          upstreamPath,
          isStream: streamRequest,
          proxyLogId: write.written ? write.proxyLogId : null,
        });
      };
      const oauth = getOauthInfoFromAccount(selected.account);
      const isCodexSite = String(selected.site.platform || '').trim().toLowerCase() === 'codex';
      const codexSessionId = isCodexSite
        ? getCodexSessionHeaderValue(request.headers as Record<string, string>)
        : '';
      const codexSessionStoreKey = (
        isCodexSite
        && codexSessionId
      )
        ? buildCodexSessionResponseStoreKey({
          sessionId: codexSessionId,
          siteId: selected.site.id,
          accountId: selected.account.id,
          channelId: selected.channel.id,
        })
        : '';
      const owner = getProxyResourceOwner(request);
      let normalizedResponsesBody: Record<string, unknown> = {
        ...requestEnvelope.parsed.normalizedBody,
        model: modelName,
        stream: isStream,
      };
      const serviceTierPolicy = applyOpenAiServiceTierPolicy({
        body: normalizedResponsesBody,
        context: {
          requestedModel,
          actualModel: modelName,
          sitePlatform: selected.site.platform,
          accountType: oauth?.planType,
        },
        rules: (config as any).openAiServiceTierRules,
      });
      if (!serviceTierPolicy.ok) {
        await finalizeDebugFailure(serviceTierPolicy.statusCode, serviceTierPolicy.payload, null);
        return reply.code(serviceTierPolicy.statusCode).send(serviceTierPolicy.payload);
      }
      normalizedResponsesBody = serviceTierPolicy.body;
      if (body.generate === false) {
        normalizedResponsesBody.generate = false;
      }
      if (owner) {
        try {
          normalizedResponsesBody = await resolveResponsesBodyInputFiles(normalizedResponsesBody, owner);
        } catch (error) {
          if (error instanceof ProxyInputFileResolutionError) {
            return reply.code(error.statusCode).send(error.payload);
          }
          throw error;
        }
      }
      const openAiBody = openAiResponsesTransformer.inbound.toOpenAiBody(
        normalizedResponsesBody,
        modelName,
        isStream,
        { defaultEncryptedReasoningInclude },
      );
      const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(openAiBody);
      const hasNonImageFileInput = conversationFileSummary.hasDocument;
      const prefersNativeResponsesReasoning = wantsNativeResponsesReasoning(normalizedResponsesBody);
      const responsesConversationFileSummary = summarizeConversationFileInputsInResponsesBody(normalizedResponsesBody);
      const requiresNativeResponsesFileUrl = responsesConversationFileSummary.hasRemoteDocumentUrl
        || carriesResponsesFileUrlInput(normalizedResponsesBody.input);
      const endpointCandidates: UpstreamEndpoint[] = isCompactRequest
        ? await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          'responses',
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
            wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
          },
          {
            requestKind: 'responses-compact',
            requiresNativeResponsesFileUrl,
          },
        )
        : await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          'responses',
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
            wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
          },
          {
            requiresNativeResponsesFileUrl,
          },
        );
      const endpointRuntimeContext = {
        siteId: selected.site.id,
        modelName,
        downstreamFormat: 'responses' as const,
        requestedModelHint: requestedModel,
        requestCapabilities: {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
      };
      await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
        endpointCandidates,
        endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
        decisionSummary: {
          retryCount,
          downstreamFormat: 'responses',
          stickySessionKey,
          stickyPreferredChannelId,
          oauthProvider: oauth?.provider || null,
          isCodexSite,
          requiresNativeResponsesFileUrl,
          isCompactRequest,
        },
      });
      const buildProviderHeaders = () => (
        buildOauthProviderHeaders({
          account: selected.account,
          downstreamHeaders: request.headers as Record<string, unknown>,
        })
      );
      const executeEndpointResultForSiteApiBaseUrl = async (siteApiBaseUrl: string) => {
        const forceResponsesUpstreamStream = shouldForceResponsesUpstreamStream({
          sitePlatform: selected.site.platform,
          isCompactRequest,
        });
        const buildEndpointRequest = (endpoint: 'chat' | 'messages' | 'responses') => {
          const upstreamStream = isStream || (forceResponsesUpstreamStream && endpoint === 'responses');
          const responsesOriginalBody = (
            endpoint === 'responses'
            && isCodexSite
            && codexSessionStoreKey
            && shouldInferResponsesPreviousResponseId(
              normalizedResponsesBody,
              getCodexSessionResponseId(codexSessionStoreKey),
            )
          )
            ? withResponsesPreviousResponseId(
              normalizedResponsesBody,
              getCodexSessionResponseId(codexSessionStoreKey)!,
            )
            : normalizedResponsesBody;
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: upstreamStream,
            tokenValue: selected.tokenValue,
            oauthProvider: oauth?.provider,
            oauthProjectId: oauth?.projectId,
            sitePlatform: selected.site.platform,
            siteUrl: siteApiBaseUrl,
            siteId: selected.site.id,
            openaiBody: openAiBody,
            downstreamFormat: 'responses',
            responsesOriginalBody,
            downstreamHeaders: request.headers as Record<string, unknown>,
            providerHeaders: buildProviderHeaders(),
            codexExplicitSessionId: codexSessionId || null,
          });
          const upstreamPath = (
            isCompactRequest && endpoint === 'responses'
              ? `${endpointRequest.path}/compact`
              : endpointRequest.path
          );
          const requestBody = (
            isCompactRequest && endpoint === 'responses'
              ? sanitizeCompactResponsesRequestBody(endpointRequest.body as Record<string, unknown>, {
                sitePlatform: selected.site.platform,
              })
              : endpointRequest.body as Record<string, unknown>
          );
          const requestHeaders = (
            isCompactRequest && endpoint === 'responses'
              ? ensureCompactResponsesJsonAcceptHeader(endpointRequest.headers, {
                sitePlatform: selected.site.platform,
              })
              : endpointRequest.headers
          );
          return {
            endpoint,
            path: upstreamPath,
            headers: requestHeaders,
            body: requestBody,
            runtime: endpointRequest.runtime,
          };
        };
        const baseDispatchRequest = createSurfaceDispatchRequest({
          site: selected.site,
          siteUrl: siteApiBaseUrl,
          accountExtraConfig: selected.account.extraConfig,
        });
        const dispatchRequest = (
          endpointRequest: BuiltEndpointRequest,
          targetUrl?: string,
        ) => {
          if (!isCodexSite || !endpointRequest.path.startsWith('/responses')) {
            return baseDispatchRequest(endpointRequest, targetUrl);
          }
          const sessionId = getCodexSessionHeaderValue(endpointRequest.headers);
          return runCodexHttpSessionTask(
            codexSessionStoreKey || sessionId,
            () => baseDispatchRequest(endpointRequest, targetUrl),
          );
        };
        const endpointStrategy = openAiResponsesTransformer.compatibility.createEndpointStrategy({
          isStream: isStream || forceResponsesUpstreamStream,
          requiresNativeResponsesFileUrl,
          sitePlatform: selected.site.platform,
          dispatchRequest,
        });
        const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
          if (oauth && shouldRefreshOauthResponsesRequest({
            oauthProvider: oauth.provider,
            status: ctx.response.status,
            response: ctx.response,
            rawErrText: ctx.rawErrText || '',
          })) {
            const recovered = await trySurfaceOauthRefreshRecovery({
              ctx,
              selected,
              siteUrl: siteApiBaseUrl,
              buildRequest: (endpoint) => buildEndpointRequest(endpoint),
              dispatchRequest,
            });
            if (recovered?.upstream?.ok) {
              return recovered;
            }
          }
          if (
            ctx.request.endpoint === 'responses'
            && isResponsesPreviousResponseNotFoundError({
              rawErrText: ctx.rawErrText,
            })
          ) {
            if (codexSessionStoreKey) {
              clearCodexSessionResponseId(codexSessionStoreKey);
            }
            const previousResponseRecovery = stripResponsesPreviousResponseId(ctx.request.body);
            if (previousResponseRecovery.removed) {
              const recoveredRequest = {
                ...ctx.request,
                body: previousResponseRecovery.body,
              };
              const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
              if (recoveredResponse.ok) {
                return {
                  upstream: recoveredResponse,
                  upstreamPath: recoveredRequest.path,
                  request: recoveredRequest,
                  targetUrl: ctx.targetUrl,
                };
              }
              ctx.request = recoveredRequest;
              ctx.response = recoveredResponse;
              ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
            }
          }
          const compactFallbackEnabled = config.responsesCompactFallbackToResponsesEnabled;
          if (
            isCompactRequest
            && compactFallbackEnabled
            && ctx.request.endpoint === 'responses'
            && ctx.request.path.endsWith('/responses/compact')
            && shouldFallbackCompactResponsesToResponses({
              status: ctx.response.status,
              rawErrText: ctx.rawErrText,
              requestPath: ctx.request.path,
            })
          ) {
            const normalizedSitePlatform = String(selected.site.platform || '').trim().toLowerCase();
            const recoveredUpstreamStream = shouldForceResponsesUpstreamStream({
              sitePlatform: selected.site.platform,
              isCompactRequest: false,
            });
            const recoveredHeaders = { ...ctx.request.headers } as Record<string, string>;
            delete (recoveredHeaders as Record<string, unknown>).Accept;
            if (recoveredUpstreamStream) {
              recoveredHeaders.accept = 'text/event-stream';
            }
            const recoveredBody = isRecord(ctx.request.body)
              ? { ...ctx.request.body }
              : ctx.request.body;
            if (isRecord(recoveredBody)) {
              if (recoveredUpstreamStream) {
                recoveredBody.stream = true;
              }
              if (normalizedSitePlatform === 'codex' || normalizedSitePlatform === 'sub2api') {
                recoveredBody.store = false;
              }
            }
            const recoveredRequest = {
              ...ctx.request,
              path: ctx.request.path.replace(/\/compact$/, ''),
              headers: recoveredHeaders,
              body: recoveredBody,
            };
            const recoveredResponse = await dispatchRequest(recoveredRequest);
            if (recoveredResponse.ok) {
              return {
                upstream: recoveredResponse,
                upstreamPath: recoveredRequest.path,
                request: recoveredRequest,
              };
            }
            ctx.request = recoveredRequest;
            ctx.response = recoveredResponse;
            ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
          }
          return endpointStrategy.tryRecover(ctx);
        };

        const debugAttemptBase = reserveSurfaceProxyDebugAttemptBase(debugTrace, endpointCandidates.length);
        return executeEndpointFlow({
          siteUrl: siteApiBaseUrl,
          disableCrossProtocolFallback: isCompactRequest || config.disableCrossProtocolFallback,
          firstByteTimeoutMs: Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000)),
          endpointCandidates,
          buildRequest: (endpoint) => buildEndpointRequest(endpoint),
          dispatchRequest,
          tryRecover,
          shouldAbortRemainingEndpoints: (ctx) => shouldAbortSameSiteEndpointFallback(
            ctx.response.status,
            ctx.rawErrText || ctx.errText,
          ),
          onAttemptFailure: async (ctx) => {
            const memoryWrite = isCompactRequest
              ? null
              : recordUpstreamEndpointFailure({
                ...endpointRuntimeContext,
                endpoint: ctx.request.endpoint,
                status: ctx.response.status,
                errorText: ctx.rawErrText,
              });
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: debugAttemptBase + ctx.endpointIndex,
              endpoint: ctx.request.endpoint,
              requestPath: ctx.request.path,
              targetUrl: ctx.targetUrl,
              runtimeExecutor: ctx.request.runtime?.executor || 'default',
              requestHeaders: ctx.request.headers,
              requestBody: ctx.request.body,
              responseStatus: ctx.response.status,
              responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
              responseBody: parseSurfaceProxyDebugTextPayload(ctx.rawErrText),
              rawErrorText: ctx.rawErrText,
              recoverApplied: ctx.recoverApplied === true,
              downgradeDecision: false,
              downgradeReason: null,
              memoryWrite,
            });
          },
          onAttemptSuccess: async (ctx) => {
            const memoryWrite = isCompactRequest
              ? null
              : recordUpstreamEndpointSuccess({
                ...endpointRuntimeContext,
                endpoint: ctx.request.endpoint,
              });
            const responseBody = await captureSurfaceProxyDebugSuccessResponseBody(debugTrace, ctx);
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: debugAttemptBase + ctx.endpointIndex,
              endpoint: ctx.request.endpoint,
              requestPath: ctx.request.path,
              targetUrl: ctx.targetUrl,
              runtimeExecutor: ctx.request.runtime?.executor || 'default',
              requestHeaders: ctx.request.headers,
              requestBody: ctx.request.body,
              responseStatus: ctx.response.status,
              responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
              responseBody,
              rawErrorText: null,
              recoverApplied: ctx.recoverApplied === true,
              downgradeDecision: false,
              downgradeReason: null,
              memoryWrite,
            });
          },
          shouldDowngrade: endpointStrategy.shouldDowngrade,
          onDowngrade: async (ctx) => {
            promoteRequiredEndpointCandidateAfterProtocolError(endpointCandidates, {
              currentEndpoint: ctx.request.endpoint,
              upstreamErrorText: ctx.rawErrText,
            });
            await safeUpdateSurfaceProxyDebugAttempt(debugTrace, debugAttemptBase + ctx.endpointIndex, {
              downgradeDecision: true,
              downgradeReason: ctx.errText,
              rawErrorText: ctx.rawErrText,
            });
            return failureToolkit.log({
              selected,
              modelRequested: requestedModel,
              status: 'failed',
              httpStatus: ctx.response.status,
              // 降级行 = **非终态行**：本轮端点失败后 `endpointFlow` 会继续试下一个端点（`continue`），
              // 客户端此刻还没收到任何终态结果 ⇒ `client_http_status` 写非终态哨兵（不写猜测值）；
              // 该请求客户端实收的真实状态码在后续终态行（成功行 / 失败出口行）上。
              clientHttpStatus: CLIENT_HTTP_STATUS_NON_TERMINAL,
              // 流式请求一律 true：这一列描述「本轮请求是不是流式」，与该行是否为终态无关。
              isStream,
              latencyMs: Date.now() - startTime,
              errorMessage: ctx.errText,
              retryCount,
            });
          },
        });
      };

      const startTime = Date.now();
      const leaseResult = await acquireSurfaceChannelLease({
        stickySessionKey,
        selected,
      });
      if (leaseResult.status === 'timeout') {
        clearSurfaceStickyChannel({
          stickySessionKey,
          selected,
        });
      const busyMessage = buildSurfaceConcurrencyBusyMessage(leaseResult.scope || 'channel', leaseResult.waitMs);
      await failureToolkit.log({
        selected,
        modelRequested: requestedModel,
        status: 'failed',
        httpStatus: 503,
        latencyMs: leaseResult.waitMs,
        errorMessage: busyMessage,
        retryCount,
      });
      if (retryCount < maxRetries && canRetryChannelSelection(retryCount, forcedChannelId)) {
        lastRetryFailure = {
          status: 503,
          payload: { error: { message: busyMessage, type: 'server_error' } },
          upstreamPath: null,
        };
        retryCount += 1;
        continue;
      }
        await finalizeDebugFailure(503, {
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
        return reply.code(503).send({
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
      }
      const channelLease = leaseResult.lease;
      // #5：网络类异常归一后，失败出口也能拿到最后一次尝试的上游路径（写进 `final_upstream_path`）。
      let lastEndpointFailureUpstreamPath: string | null = null;

      try {
        const endpointResult = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const result = await executeEndpointResultForSiteApiBaseUrl(target.baseUrl);
          if (!result.ok) {
            lastEndpointFailureUpstreamPath = result.upstreamPath ?? null;
            const upstreamFailure = new SiteApiEndpointRequestError(result.errText || 'unknown error', {
              status: result.status || 502,
              rawErrText: result.rawErrText || result.errText || 'unknown error',
            }) as SiteApiEndpointRequestError & { siteApiEndpointUpstreamFailure?: boolean };
            upstreamFailure.siteApiEndpointUpstreamFailure = true;
            throw upstreamFailure;
          }
          return result;
        });

        const upstream = endpointResult.upstream;
        const successfulUpstreamPath = endpointResult.upstreamPath;
        const firstByteLatencyMs = getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null;
        const finalizeStreamSuccess = async (
          parsedUsage: UsageSummary,
          latency: number,
          streamDebugBody: unknown,
          upstreamUsagePresent: boolean,
        ) => {
          try {
            const { proxyLogWrite } = await recordSurfaceSuccess({
              selected,
              requestedModel,
              modelName,
              parsedUsage,
              upstreamUsagePresent,
              upstreamHeaders: upstream.headers,
              requestStartedAtMs: startTime,
              isStream: true,
              firstByteLatencyMs,
              latencyMs: latency,
              retryCount,
              upstreamPath: successfulUpstreamPath,
              logSuccess: failureToolkit.log,
              recordDownstreamCost: (estimatedCost) => {
                recordDownstreamCostUsage(request, estimatedCost);
              },
              bestEffortMetrics: {
                errorLabel: '[responses] post-stream bookkeeping failed:',
              },
            });
            await persistUpstreamObservation(true, successfulUpstreamPath, proxyLogWrite);
          } catch (error) {
            console.error('[responses] post-stream success logging failed:', error);
          }
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            streamDebugBody,
          );
        };

        if (isStream) {
          const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
          const startSseResponse = () => {
            reply.hijack();
            streamStarted = true;
            reply.raw.statusCode = 200;
            reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
          };

          let parsedUsage: UsageSummary = {
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
          };
          let upstreamUsagePresent = false;
          // 终结帧观测（与 chatSurface 同口径）：responses 流会话正常收尾时总会写一个终止事件
          // （`response.completed` / `response.incomplete` / `response.failed` / `[DONE]`）；
          // 若流在任何终止事件之前就结束（上游 body 中途 terminated），客户端会拿到「无终结的流」。
          const responsesTerminalFrameMatcher = /response\.(completed|failed|incomplete)|\[DONE\]/;
          let responsesTerminalFrameSeen = false;
          let responsesStreamFrameSeen = false;
          const noteResponsesFrame = (chunk: string) => {
            responsesStreamFrameSeen = true;
            if (!responsesTerminalFrameSeen && responsesTerminalFrameMatcher.test(chunk)) {
              responsesTerminalFrameSeen = true;
            }
          };
          const writeLines = (lines: string[]) => {
            for (const line of lines) {
              noteResponsesFrame(line);
              reply.raw.write(line);
            }
          };
          /**
           * 已 hijack 的流式出口统一 `end()` 点：无终止帧时补一帧标准 in-band 错误
           * （已 hijack 后不能 `reply.code().send()`：`ERR_HTTP_HEADERS_SENT`；且绝不追加 `[DONE]`）。
           * 一帧都没写过的失败仍保持既有行为（直接 end，交由调用方的 JSON 失败出口）。
           */
          const streamSink = {
            end() {
              if (reply.raw.writableEnded) return;
              if (responsesStreamFrameSeen && !responsesTerminalFrameSeen) {
                writeSurfaceInBandStreamError({
                  reply,
                  downstreamFormat: 'openai',
                  message: 'Upstream stream interrupted before a terminal event',
                });
                return;
              }
              reply.raw.end();
            },
          };
          const websocketTransportRequest = isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>);
          const streamSession = openAiResponsesTransformer.proxyStream.createSession({
            modelName,
            successfulUpstreamPath,
            getUsage: () => parsedUsage,
            onParsedPayload: (payload) => {
              if (payload && typeof payload === 'object') {
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
                if (codexSessionStoreKey) {
                  rememberCodexSessionResponseId(codexSessionStoreKey, payload);
                }
                upstreamObservationCollector.observe(payload);
              }
            },
            writeLines,
            writeRaw: (chunk) => {
              noteResponsesFrame(chunk);
              reply.raw.write(chunk);
            },
          });
          if (!upstreamContentType.includes('text/event-stream')) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              startSseResponse();
              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                streamSink,
              );
              const latency = Date.now() - startTime;
	              if (streamResult.status === 'failed') {
	                clearSurfaceStickyChannel({
	                  stickySessionKey,
	                  selected,
	                });
              await failureToolkit.recordStreamFailure({
	                  selected,
	                  requestedModel,
                  modelName,
                  errorMessage: streamResult.errorMessage,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                });
                await finalizeDebugFailure(502, {
                  error: {
                    message: streamResult.errorMessage,
                    type: 'stream_error',
                  },
                }, successfulUpstreamPath);
                return;
	              }

	              await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                  upstreamUsagePresent,
                );
	              bindSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              return;
	            }
            let upstreamData: unknown = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
            if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
              upstreamData = unwrapGeminiCliPayload(upstreamData);
            }
            if (codexSessionStoreKey) {
              rememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
            }

            parsedUsage = parseProxyUsage(upstreamData);
            upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(upstreamData);
            const latency = Date.now() - startTime;
            const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	            if (failure) {
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              const failureOutcome = await failureToolkit.handleDetectedFailure({
	                selected,
	                requestedModel,
	                modelName,
                failure,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
	              });
	              const terminalFailureOutcome = failureOutcome.action === 'retry'
	                ? (canRetryChannelSelection(retryCount, forcedChannelId)
	                  ? null
	                  : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
	                : failureOutcome;
	              if (!terminalFailureOutcome) {
	                lastRetryFailure = {
	                  status: failure.status,
	                  payload: finalizeRetryAsUpstreamFailure(failure.status, failure.reason).payload,
	                  upstreamPath: successfulUpstreamPath,
	                };
	                retryCount += 1;
	                continue;
	              }
	              await finalizeDebugFailure(
	                terminalFailureOutcome.status,
	                terminalFailureOutcome.payload,
	                successfulUpstreamPath,
	              );
	              return respondTerminalFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload);
            }

            startSseResponse();
            const streamResult = streamSession.consumeUpstreamFinalPayload(upstreamData, rawText, streamSink);
	            if (streamResult.status === 'failed') {
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
              await failureToolkit.recordStreamFailure({
	                selected,
	                requestedModel,
                modelName,
                errorMessage: streamResult.errorMessage,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
                runtimeFailureStatus: 502,
              });
              await finalizeDebugFailure(502, {
                error: {
                  message: streamResult.errorMessage,
                  type: 'stream_error',
                },
              }, successfulUpstreamPath);
              return;
	            }

	            await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : upstreamData,
                upstreamUsagePresent,
              );
	            bindSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            return;
	          }

          startSseResponse();

          let replayReader: ReturnType<typeof createSingleChunkStreamReader> | null = null;
          if (websocketTransportRequest) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              try {
                const collectedPayload = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
                upstreamObservationCollector.observe(collectedPayload);
                // B4: also scan the raw SSE frames; the rebuilt payload drops
                // chat-shaped `choices[].delta.provider_metadata`.
                observeUpstreamProviderObservationSseText(upstreamObservationCollector, rawText);
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(collectedPayload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(collectedPayload));
                const createdPayload = {
                  ...collectedPayload,
                  status: 'in_progress',
                  output: [],
                  output_text: '',
                };
                const terminalEventType = String(collectedPayload.status || '').trim().toLowerCase() === 'incomplete'
                  ? 'response.incomplete'
                  : 'response.completed';
                writeLines([
                  `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: createdPayload })}\n\n`,
                  `event: ${terminalEventType}\ndata: ${JSON.stringify({ type: terminalEventType, response: collectedPayload })}\n\n`,
                  'data: [DONE]\n\n',
                ]);
                if (codexSessionStoreKey) {
                  rememberCodexSessionResponseId(codexSessionStoreKey, collectedPayload);
                }
                reply.raw.end();
                const latency = Date.now() - startTime;
                await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : collectedPayload,
                  upstreamUsagePresent,
                );
                bindSurfaceStickyChannel({
                  stickySessionKey,
                  selected,
                });
                return;
              } catch {
                // Fall through to the generic stream session for response.failed/error terminals.
              }

              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                streamSink,
              );
              const latency = Date.now() - startTime;
              if (streamResult.status === 'failed') {
                await failureToolkit.recordStreamFailure({
                  selected,
                  requestedModel,
                  modelName,
                  errorMessage: streamResult.errorMessage,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                  runtimeFailureStatus: 502,
                });
                await finalizeDebugFailure(502, {
                  error: {
                    message: streamResult.errorMessage,
                    type: 'stream_error',
                  },
                }, successfulUpstreamPath);
                return;
              }

              await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                upstreamUsagePresent,
              );
              return;
            }

            replayReader = createSingleChunkStreamReader(rawText);
          }

          const upstreamReader = replayReader ?? getRuntimeResponseReader(upstream);
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
          let rawText = '';
          const decoder = new TextDecoder();
          const reader = baseReader
            ? {
              async read() {
                const result = await baseReader.read();
                if (result.value) {
                  rawText += decoder.decode(result.value, { stream: true });
                }
                return result;
              },
              async cancel(reason?: unknown) {
                return baseReader.cancel(reason);
              },
              releaseLock() {
                return baseReader.releaseLock();
              },
            }
            : baseReader;
          const streamResult = await streamSession.run(reader, streamSink);
          rawText += decoder.decode();

          const latency = Date.now() - startTime;
	          if (streamResult.status === 'failed') {
	            clearSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            await failureToolkit.recordStreamFailure({
	              selected,
	              requestedModel,
              modelName,
              errorMessage: streamResult.errorMessage,
              latencyMs: latency,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
              runtimeFailureStatus: 502,
            });
            await finalizeDebugFailure(502, {
              error: {
                message: streamResult.errorMessage,
                type: 'stream_error',
              },
            }, successfulUpstreamPath);
            return;
          }

          // Once SSE has been hijacked and bytes may already be on the wire, we
          // must not attempt to convert stream failures into a fresh HTTP error
          // response or retry on another channel. Responses stream failures are
	          // handled in-band by the proxy stream session.

	          await finalizeStreamSuccess(
              parsedUsage,
              latency,
              debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
              upstreamUsagePresent,
            );
	          bindSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          return;
	        }

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let rawText = '';
        let upstreamData: unknown;
        if (
          upstreamContentType.includes('text/event-stream')
          && (
            successfulUpstreamPath.endsWith('/responses')
            || successfulUpstreamPath.endsWith('/responses/compact')
          )
        ) {
          const collected = await collectResponsesFinalPayloadFromSse(upstream, modelName);
          rawText = collected.rawText;
          upstreamData = collected.payload;
          // B4: the rebuilt payload is SSE-aggregated, not a chat-shaped body;
          // scan the raw frames so provider_metadata is still observed.
          observeUpstreamProviderObservationSseText(upstreamObservationCollector, rawText);
        } else {
          rawText = await readRuntimeResponseText(upstream);
          if (looksLikeResponsesSseText(rawText)) {
            upstreamData = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
            observeUpstreamProviderObservationSseText(upstreamObservationCollector, rawText);
          } else {
            upstreamData = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
          }
        }
        if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
          upstreamData = unwrapGeminiCliPayload(upstreamData);
        }
        if (codexSessionStoreKey) {
          rememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const upstreamUsagePresent = hasProxyUsagePayload(upstreamData);
        upstreamObservationCollector.observe(upstreamData);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	        if (failure) {
	          clearSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          const failureOutcome = await failureToolkit.handleDetectedFailure({
	            selected,
	            requestedModel,
	            modelName,
            failure,
            latencyMs: latency,
            retryCount,
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
            upstreamPath: successfulUpstreamPath,
	          });
	          const terminalFailureOutcome = failureOutcome.action === 'retry'
	            ? (canRetryChannelSelection(retryCount, forcedChannelId)
	              ? null
	              : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
	            : failureOutcome;
	          if (!terminalFailureOutcome) {
	            lastRetryFailure = {
	              status: failure.status,
	              payload: finalizeRetryAsUpstreamFailure(failure.status, failure.reason).payload,
	              upstreamPath: successfulUpstreamPath,
	            };
	            retryCount += 1;
	            continue;
	          }
	          await finalizeDebugFailure(
	            terminalFailureOutcome.status,
	            terminalFailureOutcome.payload,
	            successfulUpstreamPath,
	          );
	          return respondTerminalFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload);
        }
        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = openAiResponsesTransformer.outbound.serializeFinal({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
          serializationMode: isCompactRequest ? 'compact' : 'response',
        });
        try {
          const { proxyLogWrite } = await recordSurfaceSuccess({
            selected,
            requestedModel,
            modelName,
            parsedUsage,
            upstreamUsagePresent,
            upstreamHeaders: upstream.headers,
            requestStartedAtMs: startTime,
            isStream: false,
            firstByteLatencyMs,
            latencyMs: latency,
            retryCount,
            upstreamPath: successfulUpstreamPath,
            logSuccess: failureToolkit.log,
            recordDownstreamCost: (estimatedCost) => {
              recordDownstreamCostUsage(request, estimatedCost);
            },
            bestEffortMetrics: {
              errorLabel: '[responses] post-response bookkeeping failed:',
            },
          });
            await persistUpstreamObservation(false, successfulUpstreamPath, proxyLogWrite);
	        } catch (error) {
	          console.error('[responses] post-response success logging failed:', error);
	        }
	        await finalizeDebugSuccess(
            upstream.status,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            downstreamData,
          );
	        bindSurfaceStickyChannel({
	          stickySessionKey,
	          selected,
	        });
	        return reply.send(downstreamData);
	      } catch (err: any) {
	        clearSurfaceStickyChannel({
	          stickySessionKey,
	          selected,
	        });
          const endpointFailureStatus = typeof err?.status === 'number' ? err.status : null;
          if (err?.siteConcurrencyTimeout === true) {
            const failure = getSurfaceRequestFailure(err);
            await failureToolkit.log({
              selected,
              modelRequested: requestedModel,
              status: 'failed',
              httpStatus: failure.status,
              isStream,
              latencyMs: Date.now() - startTime,
              errorMessage: failure.message,
              retryCount,
            });
            if (canRetryChannelSelection(retryCount, forcedChannelId)) {
              lastRetryFailure = {
                status: failure.status,
                payload: { error: { message: failure.message, type: 'server_error' } },
                upstreamPath: null,
              };
              retryCount += 1;
              continue;
            }
            const payload = { error: { message: failure.message, type: 'server_error' as const } };
            await finalizeDebugFailure(failure.status, payload, null);
            return respondTerminalFailure(failure.status, payload);
          }
          const isSiteApiEndpointFailure = (
            err instanceof SiteApiEndpointRequestError
            || err?.name === 'SiteApiEndpointRequestError'
            || err?.siteApiEndpointUpstreamFailure === true
            || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
          );
          if (isSiteApiEndpointFailure) {
            const failureOutcome = await failureToolkit.handleUpstreamFailure({
              selected,
          requestedModel,
          modelName,
          status: endpointFailureStatus || 502,
          errText: err?.message || 'unknown error',
          rawErrText: err?.rawErrText || err?.message || 'unknown error',
          isStream,
          latencyMs: Date.now() - startTime,
          retryCount,
        });
            const terminalFailureOutcome = failureOutcome.action === 'retry'
              ? (canRetryChannelSelection(retryCount, forcedChannelId)
                ? null
                : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, err?.message || 'unknown error'))
              : failureOutcome;
            if (!terminalFailureOutcome) {
              lastRetryFailure = {
                status: endpointFailureStatus || 502,
                payload: finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, err?.message || 'unknown error').payload,
                upstreamPath: lastEndpointFailureUpstreamPath,
              };
              retryCount += 1;
              continue;
            }
            await finalizeDebugFailure(
              terminalFailureOutcome.status,
              terminalFailureOutcome.payload,
              lastEndpointFailureUpstreamPath,
            );
            return respondTerminalFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload);
          }
	        const failureOutcome = await failureToolkit.handleExecutionError({
	          selected,
	          requestedModel,
            modelName,
            errorMessage: err?.message || 'network failure',
            isStream,
            latencyMs: Date.now() - startTime,
            retryCount,
          });
          const terminalFailureOutcome = failureOutcome.action === 'retry'
            ? (canRetryChannelSelection(retryCount, forcedChannelId)
              ? null
              : finalizeRetryAsExecutionFailure(err?.message || 'network failure'))
            : failureOutcome;
          if (!terminalFailureOutcome) {
            lastRetryFailure = {
              status: 502,
              payload: finalizeRetryAsExecutionFailure(err?.message || 'network failure').payload,
              upstreamPath: null,
            };
            retryCount += 1;
            continue;
	        }
		        await finalizeDebugFailure(
	            terminalFailureOutcome.status,
	            terminalFailureOutcome.payload,
	            null,
	          );
		        return respondTerminalFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload);
	      } finally {
	        channelLease.release();
	      }
	    }
}
