import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { parseProxyUsage } from '../../services/proxyUsageParser.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import {
  runWithSurfaceSiteConcurrency,
  createSurfaceDispatchRequest,
  createSurfaceFailureToolkit,
  getSurfaceRequestFailure,
  recordSurfaceSuccess,
  selectSurfaceChannelForAttempt,
} from './sharedSurface.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
} from '../channelSelection.js';
import { executeEndpointFlow } from '../orchestration/endpointFlow.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { readRuntimeResponseText } from '../executors/types.js';
import { SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY } from '../../services/downstreamPolicyTypes.js';
import { recordManagedKeyCostUsage } from '../../services/downstreamApiKeyService.js';
import { reportProxyAllFailed } from '../../services/alertService.js';

/**
 * 执行 Rerank 的完整代理链路：选渠道、站点并发租约、地址池、失败重试、用量计费和日志。
 * 路由层不直接持有这些状态，避免同一套编排在不同协议入口中分叉。
 */
export async function handleRerankSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedModel: string,
) {
  const body = (request.body || {}) as Record<string, unknown>;
  const downstreamPath = '/v1/rerank';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body,
  });
  const downstreamPolicy = getProxyAuthContext(request)?.policy || EMPTY_DOWNSTREAM_ROUTING_POLICY;
  const forcedChannelId = getTesterForcedChannelId({
    headers: request.headers as Record<string, unknown>,
    clientIp: request.ip,
  });
  const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
  const firstByteTimeoutMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
  const maxRetries = getProxyMaxChannelRetries();
  const failureToolkit = createSurfaceFailureToolkit({
    warningScope: 'rerank',
    downstreamPath,
    maxRetries,
    clientContext,
    downstreamApiKeyId,
  });
  const excludeChannelIds: number[] = [];
  /** 观测列：失败出口要写出的「上游响应首字节延迟」真值（未观测到 ⇒ null）。 */
  let firstByteLatencyMs: number | null = null;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    const selected = await selectSurfaceChannelForAttempt({
      requestedModel,
      downstreamPolicy,
      excludeChannelIds,
      retryCount,
      forcedChannelId,
    });
    if (!selected) {
      const message = buildForcedChannelUnavailableMessage(forcedChannelId);
      await reportProxyAllFailed({ model: requestedModel, reason: message });
      return reply.code(503).send({ error: { message, type: 'server_error' } });
    }

    excludeChannelIds.push(selected.channel.id);
    const upstreamModel = selected.actualModel || requestedModel;
    const forwardBody = { ...body, model: upstreamModel };
    const startTime = Date.now();
    // 轮首重置：新的一轮不能沿用上一轮的观测值（与 chat / responses 面同口径）。
    firstByteLatencyMs = null;

    try {
      const endpointResult = await runWithSurfaceSiteConcurrency(selected.site, async (siteBaseUrl) => {
        const result = await executeEndpointFlow({
          siteUrl: siteBaseUrl,
          firstByteTimeoutMs,
          // executeEndpointFlow 统一处理首字节超时和响应体读取；Rerank 的路径由请求构造器明确指定。
          endpointCandidates: ['chat'],
          buildRequest: () => ({
            endpoint: 'chat',
            path: '/v1/rerank',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${selected.tokenValue}`,
            },
            body: forwardBody,
          }),
          dispatchRequest: createSurfaceDispatchRequest({
            site: selected.site,
            siteUrl: siteBaseUrl,
            accountExtraConfig: selected.account.extraConfig,
          }),
          // 纯观测取值（不参与任何选择/重试决策，不改任何对外语义）：失败尝试拿到的上游响应若已读到
          // 首字节，就把真实延迟留给外层失败出口；网络类失败（`endpointFlow` 合成的 502 无 meta）与
          // 首字节超时（`meta.firstByteLatencyMs = null`）在此落 NULL。与 chat / responses 面同法。
          onAttemptFailure: async (ctx) => {
            firstByteLatencyMs = getObservedResponseMeta(ctx.response)?.firstByteLatencyMs ?? null;
          },
        });
        if (result.ok) return result;
        const failure = new SiteApiEndpointRequestError(result.errText || 'unknown error', {
          status: result.status || 502,
          rawErrText: result.rawErrText || result.errText || 'unknown error',
        }) as SiteApiEndpointRequestError & { siteApiEndpointUpstreamFailure?: boolean };
        failure.siteApiEndpointUpstreamFailure = true;
        throw failure;
      });

      const text = await readRuntimeResponseText(endpointResult.upstream);
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // 上游可能返回非 JSON 文本，保持原始响应，避免把成功响应误判为协议失败。
      }
      const latency = Date.now() - startTime;
      const parsedUsage = parseProxyUsage(data);
      await recordSurfaceSuccess({
        selected,
        requestedModel,
        modelName: upstreamModel,
        parsedUsage,
        requestStartedAtMs: startTime,
        latencyMs: latency,
        retryCount,
        upstreamPath: endpointResult.upstreamPath,
        upstreamHeaders: endpointResult.upstream.headers,
        logSuccess: failureToolkit.log,
        recordDownstreamCost: (estimatedCost) => {
          if (downstreamApiKeyId !== null) void recordManagedKeyCostUsage(downstreamApiKeyId, estimatedCost);
        },
        bestEffortMetrics: {
          errorLabel: '[proxy/rerank] failed to record success metrics',
        },
      });
      return reply.code(endpointResult.upstream.status).send(data);
    } catch (error) {
      const failure = getSurfaceRequestFailure(error);
      if (failure.isSiteConcurrencyBusy) {
        await failureToolkit.log({
          selected,
          modelRequested: requestedModel,
          status: 'failed',
          httpStatus: failure.status,
          // 观测列：Rerank 端点结构上无流式语义 ⇒ `is_stream` 真值恒 `false`；
          // `first_byte_latency_ms` 本出口在站点并发繁忙、未走到上游尝试 ⇒ **有意不传**（NULL）。
          isStream: false,
          latencyMs: Date.now() - startTime,
          errorMessage: failure.message,
          retryCount,
        });
        if (canRetryChannelSelection(retryCount, forcedChannelId)) {
          retryCount += 1;
          continue;
        }
        return reply.code(failure.status).send({
          error: { message: failure.message, type: 'server_error' },
        });
      }

      const outcome = await failureToolkit.handleUpstreamFailure({
        selected,
        requestedModel,
        modelName: upstreamModel,
        status: failure.status,
        errText: failure.message,
        rawErrText: (error as { rawErrText?: string | null })?.rawErrText || failure.message,
        // 观测列：`is_stream` 取真值（Rerank 端点结构上恒非流式 ⇒ `false`，与上述 busy 出口同口径）；
        // `first_byte_latency_ms` 取 `onAttemptFailure` 捕获的上游首字节延迟（未观测到 ⇒ null，不编造）。
        isStream: false,
        firstByteLatencyMs,
        latencyMs: Date.now() - startTime,
        retryCount,
      });
      if (outcome.action === 'retry' && canRetryChannelSelection(retryCount, forcedChannelId)) {
        retryCount += 1;
        continue;
      }
      if (outcome.action === 'retry') {
        return reply.code(failure.status).send({
          error: { message: failure.message, type: 'upstream_error' },
        });
      }
      return reply.code(outcome.status).send(outcome.payload);
    }
  }

  return reply.code(503).send({
    error: { message: 'No available channels after retries', type: 'server_error' },
  });
}
