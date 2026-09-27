import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage, pullSseDataEvents } from '../../services/proxyUsageParser.js';
import { resolveFinalUsage } from '../../services/proxyUsageNormalize.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from '../../services/proxyLogMessage.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { detectProxyFailure } from '../../services/proxyFailureJudge.js';
import { resolveProxyLogBilling } from './proxyBilling.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from '../../proxy-core/downstreamClientContext.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { fetchWithObservedFirstByte, getObservedResponseMeta } from '../../proxy-core/firstByteTimeout.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
  selectProxyChannelForAttempt,
} from '../../proxy-core/channelSelection.js';

export async function completionsProxyRoute(app: FastifyInstance) {
  app.post('/v1/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = body?.model;
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/completions';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });

    const isStream = body.stream === true;
    const firstByteTimeoutMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= getProxyMaxChannelRetries()) {
      const selected = await selectProxyChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        forcedChannelId,
      });

      if (!selected) {
        const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
        await reportProxyAllFailed({
          model: requestedModel,
          reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: noChannelMessage, type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);

      const upstreamModel = selected.actualModel || requestedModel;
      const forwardBody = { ...body, model: upstreamModel };
      const startTime = Date.now();
      let estimatedCost = 0;
      let billingDetails: unknown = null;
      try {
        const { upstream, firstByteLatencyMs } = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const attemptStartedAtMs = Date.now();
          const targetUrl = buildUpstreamUrl(target.baseUrl, '/v1/completions');
          const response = await fetchWithObservedFirstByte(
            async (signal) => fetch(targetUrl, withSiteRecordProxyRequestInit(selected.site, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${selected.tokenValue}`,
              },
              body: JSON.stringify(forwardBody),
              signal,
            }, getProxyUrlFromExtraConfig(selected.account.extraConfig))),
            {
              firstByteTimeoutMs,
              startedAtMs: attemptStartedAtMs,
            },
          );
          const observedFirstByteLatencyMs = getObservedResponseMeta(response)?.firstByteLatencyMs ?? null;
          if (!response.ok) {
            const errText = await response.text().catch(() => 'unknown error');
            throw new SiteApiEndpointRequestError(errText || 'unknown error', {
              status: response.status,
              rawErrText: errText || null,
              firstByteLatencyMs: observedFirstByteLatencyMs,
            });
          }
          return {
            upstream: response,
            firstByteLatencyMs: observedFirstByteLatencyMs,
          };
        });

        if (isStream) {
          let streamEstimatedCost = 0;
          let streamBillingDetails: unknown = null;
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const reader = upstream.body?.getReader();
          if (!reader) {
            reply.raw.end();
            return;
          }

          const decoder = new TextDecoder();
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
          let sseBuffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              reply.raw.write(chunk);

              sseBuffer += chunk;
              const pulled = pullSseDataEvents(sseBuffer);
              sseBuffer = pulled.rest;
              for (const eventPayload of pulled.events) {
                try {
                  parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(JSON.parse(eventPayload)));
                } catch {}
              }
            }
            if (sseBuffer.trim().length > 0) {
              const pulled = pullSseDataEvents(`${sseBuffer}\n\n`);
              for (const eventPayload of pulled.events) {
                try {
                  parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(JSON.parse(eventPayload)));
                } catch {}
              }
            }
          } finally {
            reader.releaseLock();
            reply.raw.end();
          }

          const latency = Date.now() - startTime;
          const streamResolvedSelfLog = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
            tokenName: selected.tokenName,
            modelName: selected.actualModel || requestedModel,
            requestStartedAtMs: startTime,
            requestEndedAtMs: startTime + latency,
            localLatencyMs: latency,
            upstreamUsagePresent: (
              parsedUsage.totalTokens > 0
              || parsedUsage.promptTokens > 0
              || parsedUsage.completionTokens > 0
              || (parsedUsage as any).cacheReadTokens > 0
              || (parsedUsage as any).cacheCreationTokens > 0
              || (parsedUsage as any).reasoningTokens > 0
            ),
            usage: {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
            },
          });
          const streamFinalUsage = resolveFinalUsage({
            upstream: {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              cacheReadTokens: (parsedUsage as any).cacheReadTokens,
              cacheCreationTokens: (parsedUsage as any).cacheCreationTokens,
              reasoningTokens: (parsedUsage as any).reasoningTokens,
              promptTokensIncludeCache: parsedUsage.promptTokensIncludeCache,
              presence: (parsedUsage as any).presence,
            },
            selfLog: streamResolvedSelfLog?.recoveredFromSelfLog ? {
              promptTokens: streamResolvedSelfLog.promptTokens,
              completionTokens: streamResolvedSelfLog.completionTokens,
              totalTokens: streamResolvedSelfLog.totalTokens,
              cacheReadTokens: streamResolvedSelfLog.selfLogBillingMeta?.cacheReadTokens ?? 0,
              cacheCreationTokens: streamResolvedSelfLog.selfLogBillingMeta?.cacheCreationTokens ?? 0,
              promptTokensIncludeCache: streamResolvedSelfLog.selfLogBillingMeta?.promptTokensIncludeCache ?? null,
            } : null,
          });
          const resolvedBilling = await resolveProxyLogBilling({
            site: selected.site,
            account: selected.account,
            modelName: selected.actualModel || requestedModel,
            resolvedUsage: {
              promptTokens: streamFinalUsage.columns.promptTokens ?? 0,
              completionTokens: streamFinalUsage.columns.completionTokens ?? 0,
              totalTokens: streamFinalUsage.columns.totalTokens ?? 0,
              cacheReadTokens: streamFinalUsage.columns.cacheReadTokens ?? 0,
              cacheCreationTokens: streamFinalUsage.columns.cacheCreationTokens ?? 0,
              promptTokensIncludeCache: streamFinalUsage.columns.promptTokensIncludeCache,
              selfLogBillingMeta: streamResolvedSelfLog.selfLogBillingMeta,
              recoveredFromSelfLog: streamResolvedSelfLog.recoveredFromSelfLog,
              estimatedCostFromQuota: streamResolvedSelfLog.estimatedCostFromQuota,
            },
            resolvedUsageColumns: streamFinalUsage.columns,
          });
          streamEstimatedCost = resolvedBilling.estimatedCost;
          streamBillingDetails = resolvedBilling.billingDetails;
          await recordTokenRouterEventBestEffort('record channel success', () => (
            tokenRouter.recordSuccess(selected.channel.id, latency, streamEstimatedCost, upstreamModel)
          ));
          recordDownstreamCostUsage(request, streamEstimatedCost);
          logProxy(
            selected,
            requestedModel,
            'success',
            200,
            latency,
            null,
            retryCount,
            downstreamApiKeyId,
            streamFinalUsage.columns.promptTokens,
            streamFinalUsage.columns.completionTokens,
            streamFinalUsage.columns.totalTokens,
            streamFinalUsage.columns.cacheReadTokens,
            streamFinalUsage.columns.cacheCreationTokens,
            streamFinalUsage.columns.reasoningTokens,
            streamFinalUsage.columns.promptTokensIncludeCache,
            streamFinalUsage.usageSource,
            selected?.site?.id ?? null,
            streamEstimatedCost,
            streamBillingDetails,
            clientContext,
            downstreamPath,
            isStream,
            firstByteLatencyMs,
          );
          return;
        }

        const rawText = await upstream.text();
        let data: any = rawText;
        try {
          data = JSON.parse(rawText);
        } catch {
          data = rawText;
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(data);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
        if (failure) {
          const errText = failure.reason;
          await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
            status: failure.status,
            errorText: errText,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            failure.status,
            latency,
            errText,
            retryCount,
            downstreamApiKeyId,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            selected?.site?.id ?? null,
            estimatedCost,
            billingDetails,
            clientContext,
            downstreamPath,
            isStream,
            firstByteLatencyMs,
          );

          if (shouldRetryProxyRequest(failure.status, errText) && canRetryChannelSelection(retryCount, forcedChannelId)) {
            retryCount += 1;
            continue;
          }

          await reportProxyAllFailed({
            model: requestedModel,
            reason: failure.reason,
          });

          return reply.code(failure.status).send({
            error: { message: errText, type: 'upstream_error' },
          });
        }

        const resolvedSelfLog = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue,
          tokenName: selected.tokenName,
          modelName: selected.actualModel || requestedModel,
          requestStartedAtMs: startTime,
          requestEndedAtMs: startTime + latency,
          localLatencyMs: latency,
          usage: {
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
          },
        });
        const finalUsage = resolveFinalUsage({
          upstream: {
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
            cacheReadTokens: (parsedUsage as any).cacheReadTokens,
            cacheCreationTokens: (parsedUsage as any).cacheCreationTokens,
            reasoningTokens: (parsedUsage as any).reasoningTokens,
            promptTokensIncludeCache: parsedUsage.promptTokensIncludeCache,
            presence: (parsedUsage as any).presence,
          },
          selfLog: resolvedSelfLog?.recoveredFromSelfLog ? {
            promptTokens: resolvedSelfLog.promptTokens,
            completionTokens: resolvedSelfLog.completionTokens,
            totalTokens: resolvedSelfLog.totalTokens,
            cacheReadTokens: resolvedSelfLog.selfLogBillingMeta?.cacheReadTokens ?? 0,
            cacheCreationTokens: resolvedSelfLog.selfLogBillingMeta?.cacheCreationTokens ?? 0,
            promptTokensIncludeCache: resolvedSelfLog.selfLogBillingMeta?.promptTokensIncludeCache ?? null,
          } : null,
        });
        const resolvedBilling = await resolveProxyLogBilling({
          site: selected.site,
          account: selected.account,
          modelName: selected.actualModel || requestedModel,
          resolvedUsage: {
            promptTokens: finalUsage.columns.promptTokens ?? 0,
            completionTokens: finalUsage.columns.completionTokens ?? 0,
            totalTokens: finalUsage.columns.totalTokens ?? 0,
            cacheReadTokens: finalUsage.columns.cacheReadTokens ?? 0,
            cacheCreationTokens: finalUsage.columns.cacheCreationTokens ?? 0,
            promptTokensIncludeCache: finalUsage.columns.promptTokensIncludeCache,
            selfLogBillingMeta: resolvedSelfLog.selfLogBillingMeta,
            recoveredFromSelfLog: resolvedSelfLog.recoveredFromSelfLog,
            estimatedCostFromQuota: resolvedSelfLog.estimatedCostFromQuota,
          },
          resolvedUsageColumns: finalUsage.columns,
        });
        estimatedCost = resolvedBilling.estimatedCost;
        billingDetails = resolvedBilling.billingDetails;

        await recordTokenRouterEventBestEffort('record channel success', () => (
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, upstreamModel)
        ));
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(
          selected,
          requestedModel,
          'success',
          200,
          latency,
          null,
          retryCount,
          downstreamApiKeyId,
          finalUsage.columns.promptTokens,
          finalUsage.columns.completionTokens,
          finalUsage.columns.totalTokens,
          finalUsage.columns.cacheReadTokens,
          finalUsage.columns.cacheCreationTokens,
          finalUsage.columns.reasoningTokens,
          finalUsage.columns.promptTokensIncludeCache,
          finalUsage.usageSource,
          selected?.site?.id ?? null,
          estimatedCost,
          billingDetails,
          clientContext,
          downstreamPath,
          isStream,
          firstByteLatencyMs,
        );
        return reply.send(data);
      } catch (err: any) {
        const status = err instanceof SiteApiEndpointRequestError ? (err.status || 0) : 0;
        const errorText = err?.message || 'network failure';
        const firstByteLatencyMs = err instanceof SiteApiEndpointRequestError ? err.firstByteLatencyMs : null;
        await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
          status,
          errorText,
          modelName: upstreamModel,
        }));
        logProxy(
          selected,
          requestedModel,
          'failed',
          status,
          Date.now() - startTime,
          errorText,
          retryCount,
          downstreamApiKeyId,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          selected?.site?.id ?? null,
          estimatedCost,
          billingDetails,
          clientContext,
          downstreamPath,
          isStream,
          firstByteLatencyMs,
        );
        if (status > 0 && isTokenExpiredError({ status, message: errorText })) {
          await reportTokenExpired({
            accountId: selected.account.id,
            username: selected.account.username,
            siteName: selected.site.name,
            detail: `HTTP ${status}`,
          });
        }
        if ((status > 0 ? shouldRetryProxyRequest(status, errorText) : true) && canRetryChannelSelection(retryCount, forcedChannelId)) {
          retryCount++;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: errorText || 'network failure',
        });
        return reply.code(status || 502).send({
          error: { message: status > 0 ? errorText : `Upstream error: ${errorText}`, type: 'upstream_error' },
        });
      }
    }
  });
}

async function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  downstreamApiKeyId: number | null = null,
  promptTokens: number | null = null,
  completionTokens: number | null = null,
  totalTokens: number | null = null,
  cacheReadTokens: number | null = null,
  cacheCreationTokens: number | null = null,
  reasoningTokens: number | null = null,
  promptTokensIncludeCache: boolean | null = null,
  usageSource: 'upstream' | 'self-log' | 'unknown' | null = null,
  siteId: number | null = null,
  estimatedCost = 0,
  billingDetails: unknown = null,
  clientContext: DownstreamClientContext | null = null,
  downstreamPath = '/v1/completions',
  isStream: boolean,
  firstByteLatencyMs: number | null,
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
        ? clientContext.clientKind
        : null,
      sessionId: clientContext?.sessionId || null,
      traceHint: clientContext?.traceHint || null,
      downstreamPath,
      usageSource,
      errorMessage,
    });
    await insertProxyLog({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      downstreamApiKeyId,
      modelRequested,
      modelActual: selected.actualModel || modelRequested,
      status,
      httpStatus,
      isStream,
      firstByteLatencyMs,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      promptTokensIncludeCache,
      usageSource,
      siteId,
      estimatedCost,
      billingDetails,
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/completions] failed to write proxy log', error);
  }
}

async function recordTokenRouterEventBestEffort(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(`[proxy/completions] failed to ${label}`, error);
  }
}

