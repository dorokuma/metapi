import { TextDecoder } from 'node:util';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import { hasProxyUsagePayload, mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { type DownstreamFormat } from '../../transformers/shared/normalized.js';
import { promoteRequiredEndpointCandidateAfterProtocolError } from '../../transformers/shared/endpointCompatibility.js';
import { shouldForceResponsesUpstreamStream } from '../capabilities/responsesCompact.js';
import {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
} from '../../services/upstreamEndpointRuntime.js';
import {
  getUpstreamEndpointRuntimeStateSnapshot,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
} from '../../services/upstreamEndpointRuntimeMemory.js';
import {
  ensureModelAllowedForDownstreamKey,
  getDownstreamRoutingPolicy,
  recordDownstreamCostUsage,
} from '../../routes/proxy/downstreamPolicy.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { detectProxyFailure } from '../../services/proxyFailureJudge.js';
import { formatErrorCause } from '../../services/errorChain.js';
import {
  createUpstreamProviderObservationCollector,
  observeUpstreamProviderObservationSseText,
} from '../../services/upstreamProviderDetect/collect.js';
import { persistUpstreamProviderObservation, shouldPersistUpstreamObservation } from '../../services/upstreamProviderDetect/store.js';
import type { ProxyLogWriteResult } from '../../services/proxyLogStore.js';
import { openAiChatTransformer } from '../../transformers/openai/chat/index.js';
import { anthropicMessagesTransformer } from '../../transformers/anthropic/messages/index.js';
import { shouldPreferResponsesForAnthropicContinuation } from '../../transformers/anthropic/messages/compatibility.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import {
  ProxyInputFileResolutionError,
  resolveOpenAiBodyInputFiles,
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
import { geminiGenerateContentTransformer } from '../../transformers/gemini/generate-content/index.js';
import { summarizeConversationFileInputsInOpenAiBody } from '../capabilities/conversationFileCapabilities.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { getRuntimeResponseReader, readRuntimeResponseText } from '../executors/types.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { shouldAbortSameSiteEndpointFallback } from '../../services/proxyRetryPolicy.js';
import { applyOpenAiServiceTierPolicy } from '../serviceTierPolicy.js';
import { maybeHandleWebSearchOnlySimulation } from '../webSearchSimulation.js';
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
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
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
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
} from '../channelSelection.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isGeminiNativeRuntimePath(path: string): boolean {
  return /\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(path);
}

function buildOpenAiFinalFromGeminiNativePayload(
  payload: unknown,
  modelName: string,
  fallbackText = '',
) {
  const aggregate = geminiGenerateContentTransformer.aggregator.createState();
  for (const item of geminiGenerateContentTransformer.stream.parseJsonArrayPayload(payload)) {
    geminiGenerateContentTransformer.aggregator.apply(aggregate, item);
  }
  const geminiFinal = geminiGenerateContentTransformer.outbound.serializeAggregateResponse(aggregate);
  return openAiChatTransformer.transformFinalResponse(geminiFinal, modelName, fallbackText);
}

type GeminiNativeStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

/**
 * Adapt Gemini native SSE events to OpenAI chat SSE incrementally. Native
 * Gemini chunks carry provider-specific candidate parts, so they cannot be
 * passed through the generic stream bridge directly; this reader translates
 * each complete event while retaining only the small tool-argument prefix
 * needed to avoid repeating cumulative function-call arguments.
 */
function createGeminiNativeOpenAiStreamReader(
  upstreamReader: GeminiNativeStreamReader | null | undefined,
  modelName: string,
  onPayload: (payload: unknown) => void,
  onRawText: (chunk: string) => void,
): GeminiNativeStreamReader | null {
  if (!upstreamReader) return null;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const queued: Uint8Array[] = [];
  const toolArgumentsByIndex = new Map<number, string>();
  let buffer = '';
  let finished = false;
  let doneEventQueued = false;
  let stableId = '';
  let roleSent = false;

  const finishReasonFor = (payload: unknown): string | null => {
    if (!isRecord(payload)) return null;
    const candidate = Array.isArray(payload.candidates) && isRecord(payload.candidates[0])
      ? payload.candidates[0]
      : null;
    const rawReason = asTrimmedString(candidate?.finishReason || payload.finishReason).toUpperCase();
    if (!rawReason) return null;
    if (rawReason === 'FUNCTION_CALL' || rawReason === 'TOOL_CALLS') return 'tool_calls';
    if (rawReason === 'MAX_TOKENS' || rawReason === 'LENGTH') return 'length';
    if (rawReason === 'SAFETY' || rawReason === 'RECITATION') return 'content_filter';
    return 'stop';
  };

  const serializePayload = (payload: unknown): string => {
    onPayload(payload);
    const normalized = buildOpenAiFinalFromGeminiNativePayload(payload, modelName);
    if (!stableId) stableId = normalized.id;

    const delta: Record<string, unknown> = {};
    if (!roleSent) {
      delta.role = 'assistant';
      roleSent = true;
    }
    if (normalized.content) delta.content = normalized.content;
    if (normalized.reasoningContent) delta.reasoning_content = normalized.reasoningContent;
    if (normalized.toolCalls.length > 0) {
      delta.tool_calls = normalized.toolCalls.map((toolCall, index) => {
        const previousArguments = toolArgumentsByIndex.get(index) || '';
        const currentArguments = toolCall.arguments || '';
        const argumentsDelta = currentArguments.startsWith(previousArguments)
          ? currentArguments.slice(previousArguments.length)
          : currentArguments;
        toolArgumentsByIndex.set(index, currentArguments);
        return {
          index,
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            ...(argumentsDelta ? { arguments: argumentsDelta } : {}),
          },
        };
      });
    }
    const finishReason = finishReasonFor(payload);
    if (finishReason) {
      return `data: ${JSON.stringify({
        id: stableId,
        object: 'chat.completion.chunk',
        created: normalized.created,
        model: normalized.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    }
    if (Object.keys(delta).length <= 0) return '';
    return `data: ${JSON.stringify({
      id: stableId,
      object: 'chat.completion.chunk',
      created: normalized.created,
      model: normalized.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;
  };

  const queueParsedEvents = (input: string, flush = false) => {
    buffer += input;
    const parsed = geminiGenerateContentTransformer.stream.parseSsePayloads(
      flush ? `${buffer}\n\n` : buffer,
    );
    buffer = parsed.rest;
    for (const payload of parsed.events) {
      const line = serializePayload(payload);
      if (line) queued.push(encoder.encode(line));
    }
  };

  return {
    async read() {
      while (queued.length <= 0 && !finished) {
        const result = await upstreamReader.read();
        if (result.done) {
          const tail = decoder.decode();
          if (tail) {
            onRawText(tail);
            queueParsedEvents(tail, false);
          }
          queueParsedEvents('', true);
          finished = true;
          break;
        }
        if (!result.value) continue;
        const chunk = decoder.decode(result.value, { stream: true });
        if (!chunk) continue;
        onRawText(chunk);
        queueParsedEvents(chunk, false);
      }
      if (queued.length > 0) {
        return { done: false, value: queued.shift() };
      }
      if (finished && !doneEventQueued) {
        doneEventQueued = true;
        return { done: false, value: encoder.encode('data: [DONE]\n\n') };
      }
      return { done: true };
    },
    cancel(reason?: unknown) {
      finished = true;
      return upstreamReader.cancel(reason);
    },
    releaseLock() {
      upstreamReader.releaseLock();
    },
  };
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

/**
 * 流式失败 502 出口的 message 封顶（≤1000）：`streamResult.errorMessage` 是 `string | null`，
 * 仅对非空串套用 `truncateUpstreamErrorMessage`，空值保持原样（不把 null 改写成空串）。
 */
function truncateStreamFailureMessage(message: string | null): string | null {
  return message === null ? null : truncateUpstreamErrorMessage(message);
}

/**
 * 诊断字段 `has_content` 的取值：载荷里是否真有可见文本。
 *
 * 原来只看 `payload.content` / `choices[].content`，而 chat 协议里文本的真实载体是两个它都不认的位置：
 * 流式帧在 `choices[].delta.content`（`chat.completion.chunk`），完整 body 在 `choices[].message.content`
 * （`chat.completion`）。于是该字段在两种真实形下**恒假**——恒假的诊断字段比没有更糟，排障时会把
 * 「上游明明给了内容」误读成「上游没给内容」。故把四种载体一并认进去；纯观测字段，不影响任何响应行为。
 */
function payloadHasVisibleContent(record: Record<string, unknown> | null | undefined): boolean {
  if (!record) return false;
  if (record.content != null) return true;
  if (isRecord(record.delta) && record.delta.content != null) return true;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  return choices.some((choice) => {
    if (!isRecord(choice)) return false;
    if (choice.content != null) return true;
    if (isRecord(choice.delta) && choice.delta.content != null) return true;
    if (isRecord(choice.message) && choice.message.content != null) return true;
    return false;
  });
}

export async function handleChatSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamFormat: DownstreamFormat,
) {
  const downstreamTransformer = downstreamFormat === 'claude'
    ? anthropicMessagesTransformer
    : openAiChatTransformer;
  const downstreamPath = downstreamFormat === 'claude' ? '/v1/messages' : '/v1/chat/completions';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body: request.body,
  });
  const parsedRequestEnvelope = downstreamTransformer.transformRequest(request.body);
  if (parsedRequestEnvelope.error) {
    return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
  }

  const requestEnvelope = parsedRequestEnvelope.value!;
  const {
    requestedModel,
    isStream,
    upstreamBody,
    claudeOriginalBody,
  } = requestEnvelope.parsed;
  if (downstreamFormat === 'claude') {
    const handledSearch = await maybeHandleWebSearchOnlySimulation({
      app: request.server,
      request,
      reply,
      downstreamFormat: 'claude',
      body: (claudeOriginalBody || request.body || {}) as Record<string, unknown>,
      openAiBody: upstreamBody,
    });
    if (handledSearch) return;
  }
  if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
  const downstreamPolicy = getDownstreamRoutingPolicy(request);
  const forcedChannelId = getTesterForcedChannelId({
    headers: request.headers as Record<string, unknown>,
    clientIp: request.ip,
  });
  const owner = getProxyResourceOwner(request);
  let resolvedOpenAiBody = upstreamBody;
  if (owner) {
    try {
      resolvedOpenAiBody = await resolveOpenAiBodyInputFiles(upstreamBody, owner);
    } catch (error) {
      if (error instanceof ProxyInputFileResolutionError) {
        return reply.code(error.statusCode).send(error.payload);
      }
      throw error;
    }
  }
  const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(resolvedOpenAiBody);
  const hasNonImageFileInput = conversationFileSummary.hasDocument;
  const wantsContinuationAwareResponses = (
    downstreamFormat === 'claude'
    && shouldPreferResponsesForAnthropicContinuation(claudeOriginalBody)
  );
  const codexSessionCacheKey = deriveCodexSessionCacheKey({
    downstreamFormat,
    body: downstreamFormat === 'claude' ? claudeOriginalBody : request.body,
    requestedModel,
    proxyToken: getProxyAuthContext(request)?.token || null,
  });
  const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
  const maxRetries = getProxyMaxChannelRetries();
  const failureToolkit = createSurfaceFailureToolkit({
    warningScope: 'chat',
    downstreamPath,
    maxRetries,
    clientContext,
    downstreamApiKeyId,
    // 观测列 `client_http_status` 取值器：`streamStarted` 标「本轮是否已 reply.hijack()」。
    // 已 hijack（哪怕只在首帧后失败）⇒ 客户端实收 200 + 流内错误帧；未 hijack ⇒ 实收 502 JSON。
    // `streamStarted` 在下方 handler 作用域声明，供此闭包跨重试轮次实时读取；每轮轮首重置。
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
  // 本轮出口是否已开始向客户端写流（`reply.hijack()` 后只能走 200 + 流内错误帧）。
  // 提升到 handler 作用域：`failureToolkit` 的观测取值器要跨重试轮次读取它，轮首重置。
  let streamStarted = false;
  /**
   * 终态失败出口写 debug trace。
   *
   * `capturedUpstreamText` 是本次尝试已读到的**上游原始字节**（流式路径累积的 `rawText`）。采集开关
   * （`captureStreamChunks`）开启且确有字节时，trace 的 body **保留上游原文**——否则失败出口永远拿
   * 自写的 502 JSON 覆盖 body，trace 里看不到一个上游字节，排障只能拿到本仓合成文案（上游到底回了
   * 什么、是什么帧形，全部不可得）。未读到字节 / 未开采集时保持既有行为（写出口 payload）。
   */
  const finalizeDebugFailure = async (
    status: number,
    payload: unknown,
    upstreamPath: string | null = null,
    capturedUpstreamText: string | null = null,
  ) => {
    const preserveUpstreamText = debugTrace?.options.captureStreamChunks === true
      && typeof capturedUpstreamText === 'string'
      && capturedUpstreamText.length > 0;
    await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
      finalStatus: 'failed',
      finalHttpStatus: status,
      finalUpstreamPath: upstreamPath,
      finalResponseHeaders: {
        'content-type': 'application/json',
      },
      finalResponseBody: preserveUpstreamText ? capturedUpstreamText : payload,
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

  const excludeChannelIds: number[] = [];
  let retryCount = 0;
  // 本轮终态失败的真实原因：在确定「继续重试」之前留存（真实 status / 报错体 / 上游路径）。
  // 重试仍可继续、但下一轮已无通道可选（重试耗尽）时，据此向客户端回传上游真实原因，
  // 而不是用 503「No available channels」掩盖它；首轮真无可用通道时它仍为 null，保持原 503 文案。
  let lastRetryFailure: SurfaceRetryTerminalFailure | null = null;

  while (retryCount <= maxRetries) {
    // 轮首重置：`streamStarted` 已提升到 handler 作用域，新的一轮不能沿用上一轮是否已 hijack 的事实。
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
    const oauth = getOauthInfoFromAccount(selected.account);
    // 上游探测旁路：只在主开关 + 参与站点 + 采样都命中时收集；
    // 收集器随重试 attempt 作用域创建（B2），attempt 内的观测不会泄漏到下一次成功的日志；
    // 三态：成功日志写入失败（written: false）则不调用 persist，观测 0 行；
    // 写入成功但方言拿不到正整数 id 时仍写观测，proxy_log_id 为 NULL，读侧回退时间窗；
    // persist 自身不抛，不影响转发字节与状态码。
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
    const isCodexSite = String(selected.site.platform || '').trim().toLowerCase() === 'codex';
    let endpointCandidates = [
      ...await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        downstreamFormat,
        requestedModel,
        {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsContinuationAwareResponses,
        },
        {
          oauthProvider: oauth?.provider,
        },
      ),
    ];
    const endpointRuntimeContext = {
      siteId: selected.site.id,
      modelName,
      downstreamFormat,
      requestedModelHint: requestedModel,
      requestCapabilities: {
        hasNonImageFileInput,
        conversationFileSummary,
        wantsContinuationAwareResponses,
      },
    };
    await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
      endpointCandidates,
      endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
      decisionSummary: {
        retryCount,
        downstreamFormat,
        stickySessionKey,
        stickyPreferredChannelId,
        oauthProvider: oauth?.provider || null,
        isCodexSite,
        wantsContinuationAwareResponses,
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
        isCompactRequest: false,
      });
      const buildEndpointRequest = (
        endpoint: 'chat' | 'messages' | 'responses',
        options: { forceNormalizeClaudeBody?: boolean } = {},
      ) => {
        const upstreamStream = isStream || (forceResponsesUpstreamStream && endpoint === 'responses');
        const bodyForEndpoint = endpoint === 'responses'
          ? (() => {
            const policyResult = applyOpenAiServiceTierPolicy({
              body: resolvedOpenAiBody,
              context: {
                requestedModel,
                actualModel: modelName,
                sitePlatform: selected.site.platform,
                accountType: oauth?.planType,
              },
              rules: (config as any).openAiServiceTierRules,
            });
            if (!policyResult.ok) {
              const error = new SiteApiEndpointRequestError(policyResult.payload.error.message, {
                status: policyResult.statusCode,
                rawErrText: JSON.stringify(policyResult.payload),
              });
              (error as SiteApiEndpointRequestError & { serviceTierBlocked?: boolean }).serviceTierBlocked = true;
              throw error;
            }
            return policyResult.body;
          })()
          : resolvedOpenAiBody;
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
          openaiBody: bodyForEndpoint,
          downstreamFormat,
          claudeOriginalBody,
          forceNormalizeClaudeBody: options.forceNormalizeClaudeBody,
          downstreamHeaders: request.headers as Record<string, unknown>,
          providerHeaders: buildProviderHeaders(),
          codexSessionCacheKey,
        });
        return {
          endpoint,
          path: endpointRequest.path,
          headers: endpointRequest.headers,
          body: endpointRequest.body as Record<string, unknown>,
          runtime: endpointRequest.runtime,
        };
      };
      const dispatchRequest = createSurfaceDispatchRequest({
        site: selected.site,
        siteUrl: siteApiBaseUrl,
        accountExtraConfig: selected.account.extraConfig,
      });
      const endpointStrategy = downstreamTransformer.compatibility.createEndpointStrategy({
        downstreamFormat,
        endpointCandidates,
        modelName,
        requestedModelHint: requestedModel,
        sitePlatform: selected.site.platform,
        isStream: isStream || forceResponsesUpstreamStream,
        buildRequest: ({ endpoint, forceNormalizeClaudeBody }) => buildEndpointRequest(
          endpoint,
          { forceNormalizeClaudeBody },
        ),
        dispatchRequest,
      });
      const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
        if ((ctx.response.status === 401 || ctx.response.status === 403) && oauth) {
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
        return endpointStrategy.tryRecover(ctx);
      };
      const debugAttemptBase = reserveSurfaceProxyDebugAttemptBase(debugTrace, endpointCandidates.length);
      return executeEndpointFlow({
        siteUrl: siteApiBaseUrl,
        disableCrossProtocolFallback: config.disableCrossProtocolFallback,
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
          const memoryWrite = recordUpstreamEndpointFailure({
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
          const memoryWrite = recordUpstreamEndpointSuccess({
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
    let startTime = Date.now();
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
      if (canRetryChannelSelection(retryCount, forcedChannelId)) {
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
    // SSE 是否已 `reply.hijack()`（一旦 hijack，终态出口不能再 `reply.code().send()`）。
    // 本变量在 handler 作用域声明、每轮轮首重置（见上方 `streamStarted = false`）。
    /**
     * 终态失败出口：SSE 已 hijack 时不能再 `reply.code().send(...)`（`ERR_HTTP_HEADERS_SENT`），
     * 改为写一帧标准 in-band 错误后 `end()`（帧形按下游协议，见 `buildSurfaceInBandStreamErrorFrame`）；
     * 未 hijack 时保持既有 `reply.code(status).send(payload)`。
     */
    const respondTerminalFailure = (status: number, payload: any) => {
      if (streamStarted) {
        writeSurfaceInBandStreamError({
          reply,
          downstreamFormat,
          message: truncateStreamFailureMessage(
            typeof payload?.error?.message === 'string' ? payload.error.message : null,
          ),
        });
        return reply;
      }
      return reply.code(status).send(payload);
    };

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

      if (isStream) {
        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        const startSseResponse = () => {
          if (streamStarted) return;
          streamStarted = true;
          reply.hijack();
          reply.raw.statusCode = 200;
          reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
          reply.raw.setHeader('Connection', 'keep-alive');
          reply.raw.setHeader('X-Accel-Buffering', 'no');
        };

        let parsedUsage: ReturnType<typeof parseProxyUsage> = {
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
        const recordStreamSuccess = async (latencyMs: number) => {
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
            latencyMs,
            retryCount,
            upstreamPath: successfulUpstreamPath,
            logSuccess: failureToolkit.log,
            recordDownstreamCost: (estimatedCost) => {
              recordDownstreamCostUsage(request, estimatedCost);
            },
            bestEffortMetrics: {
              errorLabel: '[proxy/chat] failed to record success metrics',
            },
          });
          await persistUpstreamObservation(true, successfulUpstreamPath, proxyLogWrite);
        };

        // 终结帧观测：SSE 已 hijack 后，能告诉客户端「这轮成功还是失败」的只剩流内终结帧
        // （openai 的 `data: [DONE]` / claude 的 `message_stop`）。生命周期固定会在退出前
        // `streamResponse.end()`，所以在这里记住「有没有写过终结帧」与「断流原因」。
        const sseTerminalFrameMatcher = downstreamFormat === 'claude'
          ? /"type"\s*:\s*"message_stop"/
          : /\[DONE\]/;
        let sseTerminalFrameSeen = false;
        // M1：本轮是否已向客户端交付过带内失败信号（上游带内错误帧 / legacy `finish_reason:"error"` 块 /
        // 上游原生 Anthropic 错误帧三条出口都会置真）。补帧门禁看它：已知原因时绝不补第二帧。
        let sseInBandFailureDelivered = false;
        let streamInterruptionMessage: string | null = null;
        const noteSseFrame = (chunk: string) => {
          if (!sseTerminalFrameSeen && sseTerminalFrameMatcher.test(chunk)) {
            sseTerminalFrameSeen = true;
          }
        };
        const writeLines = (lines: string[]) => {
          startSseResponse();
          for (const line of lines) {
            noteSseFrame(line);
            reply.raw.write(line);
          }
        };
        const streamResponse = {
          end() {
            if (!streamStarted) return;
            // 已 hijack 且全程没见过终结帧 ⇒ 客户端拿到的是「无终结的流」（上游 body 中途 terminated /
            // 流在任何终结帧前结束）。此时 `reply.code().send(...)` 会 ERR_HTTP_HEADERS_SENT，
            // 改为写一帧标准 in-band 错误后 end()；**不**追加 `[DONE]` / `message_stop`。
            // M1：若本轮已交付过带内失败信号（带内错误帧 / legacy 错误块 / 原生 Anthropic 错误帧），客户端
            // 已知道失败原因，绝不在此又补一帧自写的 `Upstream stream interrupted…`（双错误帧）。
            if (!sseTerminalFrameSeen && !sseInBandFailureDelivered) {
              writeSurfaceInBandStreamError({
                reply,
                downstreamFormat,
                message: truncateStreamFailureMessage(
                  streamInterruptionMessage || 'Upstream stream interrupted before a terminal event',
                ),
              });
              return;
            }
            reply.raw.end();
          },
        };
        const streamSession = openAiChatTransformer.proxyStream.createSession({
          downstreamFormat,
          modelName,
          successfulUpstreamPath,
          // Only opt into a terminal usage chunk for the openai downstream format
          // when the client explicitly set stream_options.include_usage === true.
          // Claude stays false (its closeout is message_delta/message_stop).
          includeUsage: downstreamFormat === 'openai'
            && (requestEnvelope.metadata as { streamOptionsIncludeUsage?: boolean | null } | undefined)?.streamOptionsIncludeUsage === true,
          // M2：带内失败帧到来时，会话要知道「有没有已向下游写出的字节」：没写过 ⇒ 不 hijack，
          // 交给下面 4 处 `!streamStarted` 的 502 出口用状态码 + 上游原文交付。
          hasStartedDownstreamWrite: () => streamStarted,
          // M1：把「已交付带内失败信号」的事实回报给 `streamResponse.end()` 的补帧门禁。
          onInBandFailureDelivered: () => {
            sseInBandFailureDelivered = true;
          },
          onParsedPayload: (payload) => {
            if (payload && typeof payload === 'object') {
              upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
              parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
              upstreamObservationCollector.observe(payload);
            }
          },
          onEventParsed: (payload) => {
            if (!payload || typeof payload !== 'object') return;
            const record = payload as Record<string, unknown>;
            if (record.type && typeof record.type === 'string' && record.type !== 'http.response.start') return;
            const choice = record.choices && Array.isArray(record.choices) && isRecord(record.choices[0]) ? record.choices[0] : (isRecord(record) ? record : null);
            if (!choice) return;
            const finishReason = asTrimmedString(choice.finish_reason);
            const hasToolCalls = !!(record.tool_calls || (Array.isArray(record.choices) && record.choices.some((c: any) => c.tool_calls)));
            const hasContent = payloadHasVisibleContent(record);
            try {
              request.log.info({
                surface: 'chat/upstream-stream-event',
                requestId: request.id,
                upstream_model: modelName,
                raw_finish_reason: finishReason || null,
                has_tool_calls: hasToolCalls,
                has_content: hasContent,
              }, 'chat surface upstream stream event diagnostic');
            } catch {}
          },
          writeLines,
          writeRaw: (chunk) => {
            startSseResponse();
            noteSseFrame(chunk);
            reply.raw.write(chunk);
          },
        });
        /**
         * 断流取证：上游 body 中途 `terminated` 时 `reader.read()` 会抛，异常沿生命周期 `finally`
         * 冒泡使 `streamSession.run` reject。这里就地记下 `.cause` 链上的原因，供 `streamResponse.end()`
         * 写 in-band 错误帧时取用；异常本身原样再抛，不改任何既有失败分类 / 重试语义。
         */
        const guardStreamReader = <T extends {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
          cancel(reason?: unknown): Promise<unknown>;
          releaseLock(): void;
        }>(reader: T): T => ({
          read: async () => {
            try {
              return await reader.read();
            } catch (error) {
              streamInterruptionMessage = streamInterruptionMessage
                || formatErrorCause(error)
                || 'upstream stream interrupted';
              throw error;
            }
          },
          cancel: (reason?: unknown) => reader.cancel(reason),
          releaseLock: () => reader.releaseLock(),
        }) as unknown as T;
        let rawText = '';
        if (isGeminiNativeRuntimePath(successfulUpstreamPath)) {
          const nativeReader = createGeminiNativeOpenAiStreamReader(
            getRuntimeResponseReader(upstream),
            modelName,
            (payload) => {
              upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
              parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
            },
            (chunk) => {
              rawText += chunk;
            },
          );
          const streamResult = await streamSession.run(
            nativeReader ? guardStreamReader(nativeReader) : nativeReader,
            streamResponse,
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
              // 观测列：本出口只在 `if (isStream)` 内可达，`isStream` 取自本轮请求解析结果（非硬编码）；
              // `firstByteLatencyMs` 取上游响应观测到的首字节延迟（未观测到 ⇒ null），与成功出口同源。
              isStream,
              firstByteLatencyMs,
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
            }, successfulUpstreamPath, rawText);
            if (!streamStarted) {
              return reply.code(502).send({
                error: {
                  message: truncateStreamFailureMessage(streamResult.errorMessage),
                  type: 'upstream_error',
                },
              });
            }
            return;
          }
          await recordStreamSuccess(latency);
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            debugTrace?.options.captureStreamChunks
              ? rawText
              : {
                stream: true,
                usage: parsedUsage,
              },
          );
          bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
          });
          return;
        }
        if (!upstreamContentType.includes('text/event-stream')) {
          const fallbackText = await readRuntimeResponseText(upstream);
          rawText = fallbackText;
          if (looksLikeResponsesSseText(fallbackText)) {
            const streamResult = await streamSession.run(
              guardStreamReader(createSingleChunkStreamReader(fallbackText)),
              streamResponse,
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
                // 观测列：同上，本出口只在 `if (isStream)` 内可达；首字节已在 `readRuntimeResponseText` 时到达。
                isStream,
                firstByteLatencyMs,
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
              }, successfulUpstreamPath, rawText);
              if (!streamStarted) {
                return reply.code(502).send({
                  error: {
                    message: truncateStreamFailureMessage(streamResult.errorMessage),
                    type: 'upstream_error',
                  },
                });
              }
              return;
            }
            await recordStreamSuccess(latency);
            await finalizeDebugSuccess(
              200,
              successfulUpstreamPath,
              buildSurfaceProxyDebugResponseHeaders(upstream),
              debugTrace?.options.captureStreamChunks
                ? fallbackText
                : {
                  stream: true,
                  usage: parsedUsage,
                },
            );
            bindSurfaceStickyChannel({
              stickySessionKey,
              selected,
            });
            return;
          }
          let fallbackData: unknown = null;
          try {
            fallbackData = JSON.parse(fallbackText);
          } catch {
            fallbackData = fallbackText;
          }
          if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
            fallbackData = unwrapGeminiCliPayload(fallbackData);
          }
          upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(fallbackData);
          parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(fallbackData));
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
            return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
          }

          const streamResult = streamSession.consumeUpstreamFinalPayload(fallbackData, fallbackText, streamResponse);
          if (streamResult.status === 'failed') {
            clearSurfaceStickyChannel({
              stickySessionKey,
              selected,
            });
            await failureToolkit.recordStreamFailure({
              selected,
              requestedModel,
              modelName,
              // 观测列：同上，本出口只在 `if (isStream)` 内可达；首字节已在读取上游 body 时到达。
              isStream,
              firstByteLatencyMs,
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
            }, successfulUpstreamPath, rawText);
            if (!streamStarted) {
              return reply.code(502).send({
                error: {
                  message: truncateStreamFailureMessage(streamResult.errorMessage),
                  type: 'upstream_error',
                },
              });
            }
            return;
          }
          await recordStreamSuccess(latency);
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            debugTrace?.options.captureStreamChunks
              ? fallbackText
              : {
                stream: true,
                usage: parsedUsage,
              },
          );
          bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
          });
          return;
        } else {
          const upstreamReader = getRuntimeResponseReader(upstream);
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
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
          const streamResult = await streamSession.run(
            reader ? guardStreamReader(reader) : reader,
            streamResponse,
          );
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
              // 观测列：同上，本出口只在 `if (isStream)` 内可达；断流发生在首字节之后（reader 已读到过块）。
              isStream,
              firstByteLatencyMs,
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
            }, successfulUpstreamPath, rawText);
            if (!streamStarted) {
              return reply.code(502).send({
                error: {
                  message: truncateStreamFailureMessage(streamResult.errorMessage),
                  type: 'upstream_error',
                },
              });
            }
            return;
          }

          // Once SSE has been hijacked and streamed downstream, we can no longer
          // safely fall back to an HTTP error response or retry by switching the
          // channel mid-flight. Stream-level failures must be handled in-band by
          // the proxy stream session itself.
        }

        const latency = Date.now() - startTime;
        await recordStreamSuccess(latency);
        await finalizeDebugSuccess(
          200,
          successfulUpstreamPath,
          buildSurfaceProxyDebugResponseHeaders(upstream),
          debugTrace?.options.captureStreamChunks
            ? rawText
            : {
              stream: true,
              usage: parsedUsage,
            },
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
      if (upstreamContentType.includes('text/event-stream') && successfulUpstreamPath.endsWith('/responses')) {
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
      const upstreamRecord = isRecord(upstreamData) ? upstreamData : null;
      const upstreamFinishReason = upstreamRecord
        ? asTrimmedString(
            (upstreamRecord.choices && Array.isArray(upstreamRecord.choices)
              ? upstreamRecord.choices[0]
              : upstreamRecord).finish_reason,
          )
        : null;
      try {
        request.log.info({
          surface: 'chat/upstream-final',
          requestId: request.id,
          upstream_model: modelName,
          raw_finish_reason: upstreamFinishReason || null,
          has_tool_calls: !!(upstreamRecord && (upstreamRecord.tool_calls || (Array.isArray((upstreamRecord as any)?.choices) && (upstreamRecord as any).choices.some((c: any) => c.tool_calls)))),
          has_content: payloadHasVisibleContent(upstreamRecord),
        }, 'chat surface upstream final payload diagnostic');
      } catch {}
      if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
        upstreamData = unwrapGeminiCliPayload(upstreamData);
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
        return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
      }
      const normalizedFinal = isGeminiNativeRuntimePath(successfulUpstreamPath)
        ? buildOpenAiFinalFromGeminiNativePayload(upstreamData, modelName, rawText)
        : downstreamTransformer.transformFinalResponse(upstreamData, modelName, rawText);
      const downstreamResponse = downstreamTransformer.serializeFinalResponse(normalizedFinal, parsedUsage);

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
          errorLabel: '[proxy/chat] failed to record success metrics',
        },
      });
      await persistUpstreamObservation(false, successfulUpstreamPath, proxyLogWrite);
      await finalizeDebugSuccess(
        upstream.status,
        successfulUpstreamPath,
        buildSurfaceProxyDebugResponseHeaders(upstream),
        downstreamResponse,
      );
      bindSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });

      return reply.send(downstreamResponse);
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
        || err?.serviceTierBlocked === true
        || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
      );
      if (err?.serviceTierBlocked === true) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(err.rawErrText || '');
        } catch {
          payload = {
            error: {
              message: err.message || 'service_tier is blocked by policy',
              type: 'invalid_request_error',
            },
          };
        }
        await finalizeDebugFailure(endpointFailureStatus || 400, payload, null);
        return respondTerminalFailure(endpointFailureStatus || 400, payload);
      }
      if (isSiteApiEndpointFailure) {
        const failureOutcome = await failureToolkit.handleUpstreamFailure({
          selected,
          requestedModel,
          modelName,
          status: endpointFailureStatus || 502,
          errText: err.message || 'unknown error',
          rawErrText: err.rawErrText || err.message || 'unknown error',
          isStream,
          latencyMs: Date.now() - startTime,
          retryCount,
        });
        const terminalFailureOutcome = failureOutcome.action === 'retry'
          ? (canRetryChannelSelection(retryCount, forcedChannelId)
            ? null
            : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, err.message || 'unknown error'))
          : failureOutcome;
        if (!terminalFailureOutcome) {
          lastRetryFailure = {
            status: endpointFailureStatus || 502,
            payload: finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, err.message || 'unknown error').payload,
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
        errorMessage: formatErrorCause(err) || 'network failure',
        isStream,
        latencyMs: Date.now() - startTime,
        retryCount,
      });
      const terminalFailureOutcome = failureOutcome.action === 'retry'
        ? (canRetryChannelSelection(retryCount, forcedChannelId)
          ? null
          : finalizeRetryAsExecutionFailure(formatErrorCause(err) || 'network failure'))
        : failureOutcome;
      if (!terminalFailureOutcome) {
        lastRetryFailure = {
          status: 502,
          payload: finalizeRetryAsExecutionFailure(formatErrorCause(err) || 'network failure').payload,
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

function deriveCodexSessionCacheKey(input: {
  downstreamFormat: DownstreamFormat | 'responses';
  body: unknown;
  requestedModel: string;
  proxyToken: string | null;
}): string | null {
  if (isRecord(input.body)) {
    if (input.downstreamFormat === 'claude' && isRecord(input.body.metadata)) {
      const userId = asTrimmedString(input.body.metadata.user_id);
      if (userId) return `${input.requestedModel}:claude:${userId}`;
    }
    const promptCacheKey = asTrimmedString(input.body.prompt_cache_key);
    if (promptCacheKey) return `${input.requestedModel}:responses:${promptCacheKey}`;
  }

  const proxyToken = asTrimmedString(input.proxyToken);
  if (proxyToken) {
    return `${input.requestedModel}:proxy:${proxyToken}`;
  }

  return null;
}

export async function handleClaudeCountTokensSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const rawBody = isRecord(request.body) ? { ...request.body } : null;
  if (!rawBody) {
    return reply.code(400).send({
      error: {
        message: 'Request body must be a JSON object',
        type: 'invalid_request_error',
      },
    });
  }

  const requestedModel = asTrimmedString(rawBody.model);
  if (!requestedModel) {
    return reply.code(400).send({
      error: {
        message: 'model is required',
        type: 'invalid_request_error',
      },
    });
  }

  if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
  const downstreamPath = '/v1/messages/count_tokens';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body: rawBody,
  });
  const downstreamPolicy = getDownstreamRoutingPolicy(request);
  const forcedChannelId = getTesterForcedChannelId({
    headers: request.headers as Record<string, unknown>,
    clientIp: request.ip,
  });
  const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
  const maxRetries = getProxyMaxChannelRetries();
  const failureToolkit = createSurfaceFailureToolkit({
    warningScope: 'chat',
    downstreamPath,
    maxRetries,
    clientContext,
    downstreamApiKeyId,
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
    requestBody: rawBody,
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
  const excludeChannelIds: number[] = [];
  let retryCount = 0;

  while (retryCount <= maxRetries) {
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
      const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
      await reportProxyAllFailed({
        model: requestedModel,
        reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
      });
      await finalizeDebugFailure(503, {
        error: { message: noChannelMessage, type: 'server_error' },
      });
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
    const endpointRuntimeContext = {
      siteId: selected.site.id,
      modelName,
      downstreamFormat: 'claude' as const,
      requestedModelHint: requestedModel,
    };
    const endpointCandidates = await resolveUpstreamEndpointCandidates(
      {
        site: selected.site,
        account: selected.account,
      },
      modelName,
      'claude',
      requestedModel,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );
    await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
      endpointCandidates,
      endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
      decisionSummary: {
        retryCount,
        stickySessionKey,
        stickyPreferredChannelId,
        countTokens: true,
      },
    });
    if (endpointCandidates.length === 0) {
      if (canRetryChannelSelection(retryCount, forcedChannelId)) {
        retryCount += 1;
        continue;
      }
      await finalizeDebugFailure(501, {
        error: {
          message: 'Claude count_tokens compatibility is not implemented for this upstream',
          type: 'invalid_request_error',
        },
      });
      return reply.code(501).send({
        error: {
          message: 'Claude count_tokens compatibility is not implemented for this upstream',
          type: 'invalid_request_error',
        },
      });
    }
    const oauth = getOauthInfoFromAccount(selected.account);
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
      if (canRetryChannelSelection(retryCount, forcedChannelId)) {
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

    const buildRequest = () => {
      const upstreamRequest = buildClaudeCountTokensUpstreamRequest({
        modelName,
        tokenValue: selected.tokenValue,
        oauthProvider: oauth?.provider,
        sitePlatform: selected.site.platform,
        claudeBody: rawBody,
        downstreamHeaders: request.headers as Record<string, unknown>,
      });
      return {
        endpoint: 'messages' as const,
        path: upstreamRequest.path,
        headers: upstreamRequest.headers,
        body: upstreamRequest.body,
        runtime: upstreamRequest.runtime,
      };
    };

    try {
      const countTokensResult = await runWithSiteApiEndpointPool(selected.site, async (target) => {
        let upstreamRequest = buildRequest();
        const dispatchRequest = createSurfaceDispatchRequest({
          site: selected.site,
          siteUrl: target.baseUrl,
          accountExtraConfig: selected.account.extraConfig,
        });
        let upstream = await dispatchRequest(upstreamRequest);
        let recoverApplied = false;

        if ((upstream.status === 401 || upstream.status === 403) && oauth) {
          const recoverContext = {
            request: upstreamRequest,
            response: upstream,
            rawErrText: '',
          };
          const recovered = await trySurfaceOauthRefreshRecovery({
            ctx: recoverContext,
            selected,
            siteUrl: target.baseUrl,
            buildRequest: () => buildRequest(),
            dispatchRequest,
            captureFailureBody: false,
          });
          if (recovered?.upstream?.ok) {
            upstreamRequest = buildRequest();
            upstream = recovered.upstream;
            recoverApplied = true;
          } else {
            upstreamRequest = recoverContext.request;
            upstream = recoverContext.response;
          }
        }

        const latency = Date.now() - startTime;
        const contentType = upstream.headers.get('content-type') || 'application/json';
        const text = await readRuntimeResponseText(upstream);
        let payload: unknown = text;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
        await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
          attemptIndex: retryCount,
          endpoint: upstreamRequest.endpoint,
          requestPath: upstreamRequest.path,
          targetUrl: `${target.baseUrl}${upstreamRequest.path}`,
          runtimeExecutor: upstreamRequest.runtime?.executor || 'default',
          requestHeaders: upstreamRequest.headers,
          requestBody: upstreamRequest.body,
          responseStatus: upstream.status,
          responseHeaders: buildSurfaceProxyDebugResponseHeaders(upstream),
          responseBody: payload,
          rawErrorText: upstream.ok ? null : text,
          recoverApplied,
          downgradeDecision: false,
          downgradeReason: null,
          memoryWrite: null,
        });
        if (!upstream.ok) {
          const errText = typeof payload === 'string' ? payload : JSON.stringify(payload);
          throw new SiteApiEndpointRequestError(errText || 'unknown error', {
            status: upstream.status,
            rawErrText: typeof payload === 'string' ? payload : text,
          });
        }
        return {
          upstream,
          upstreamRequest,
          contentType,
          payload,
          latency,
        };
      });

      const {
        upstream,
        upstreamRequest,
        contentType,
        payload,
        latency,
      } = countTokensResult;

      tokenRouter.recordSuccess(selected.channel.id, latency, 0, modelName);
      recordDownstreamCostUsage(request, 0);
      await failureToolkit.log({
        selected,
        modelRequested: requestedModel,
        status: 'success',
        httpStatus: upstream.status,
        latencyMs: latency,
        errorMessage: null,
        retryCount,
        upstreamPath: upstreamRequest.path,
      });
      bindSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });
      await finalizeDebugSuccess(
        upstream.status,
        upstreamRequest.path,
        buildSurfaceProxyDebugResponseHeaders(upstream),
        payload,
      );
      return reply.code(upstream.status).type(contentType).send(payload);
    } catch (error: any) {
      clearSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });
      const endpointFailureStatus = typeof error?.status === 'number' ? error.status : null;
      if (error?.siteConcurrencyTimeout === true) {
        const failure = getSurfaceRequestFailure(error);
        await failureToolkit.log({
          selected,
          modelRequested: requestedModel,
          status: 'failed',
          httpStatus: failure.status,
          isStream: false,
          latencyMs: Date.now() - startTime,
          errorMessage: failure.message,
          retryCount,
        });
        if (canRetryChannelSelection(retryCount, forcedChannelId)) {
          retryCount += 1;
          continue;
        }
        const payload = { error: { message: failure.message, type: 'server_error' as const } };
        await finalizeDebugFailure(failure.status, payload, null);
        return reply.code(failure.status).send(payload);
      }
      const isSiteApiEndpointFailure = (
        error instanceof SiteApiEndpointRequestError
        || error?.name === 'SiteApiEndpointRequestError'
        || error?.siteApiEndpointUpstreamFailure === true
        || error?.serviceTierBlocked === true
        || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
      );
      if (error?.serviceTierBlocked === true) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(error.rawErrText || '');
        } catch {
          payload = {
            error: {
              message: error.message || 'service_tier is blocked by policy',
              type: 'invalid_request_error',
            },
          };
        }
        await finalizeDebugFailure(endpointFailureStatus || 400, payload, null);
        return reply.code(endpointFailureStatus || 400).send(payload);
      }
      if (isSiteApiEndpointFailure) {
        const failureOutcome = await failureToolkit.handleUpstreamFailure({
          selected,
          requestedModel,
          modelName,
          status: endpointFailureStatus || 502,
          errText: error.message || 'unknown error',
          rawErrText: error.rawErrText || error.message || 'unknown error',
          isStream: false,
          latencyMs: Date.now() - startTime,
          retryCount,
        });
        const terminalFailureOutcome = failureOutcome.action === 'retry'
          ? (canRetryChannelSelection(retryCount, forcedChannelId)
            ? null
            : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, error.message || 'unknown error'))
          : failureOutcome;
        if (!terminalFailureOutcome) {
          retryCount += 1;
          continue;
        }
        await finalizeDebugFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload, null);
        return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
      }
      const failureOutcome = await failureToolkit.handleExecutionError({
        selected,
        requestedModel,
        modelName,
        errorMessage: formatErrorCause(error) || 'network failure',
        isStream: false,
        latencyMs: Date.now() - startTime,
        retryCount,
      });
      const terminalFailureOutcome = failureOutcome.action === 'retry'
        ? (canRetryChannelSelection(retryCount, forcedChannelId)
          ? null
          : finalizeRetryAsExecutionFailure(formatErrorCause(error) || 'network failure'))
        : failureOutcome;
      if (!terminalFailureOutcome) {
        retryCount += 1;
        continue;
      }
      await finalizeDebugFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload, null);
      return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
    } finally {
      channelLease.release();
    }
  }
}
