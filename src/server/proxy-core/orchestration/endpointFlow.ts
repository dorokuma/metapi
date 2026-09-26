import { fetch } from 'undici';
import { readRuntimeResponseText } from '../executors/types.js';
import { fetchWithObservedFirstByte, isObservedFirstByteTimeoutResponse } from '../firstByteTimeout.js';
import { withSiteProxyRequestInit } from '../../services/siteProxy.js';
import { resolveUpstreamParamCompatSelfHealPlan } from '../../services/upstreamParamCompat/selfHeal.js';
import {
  buildUpstreamUrl,
  summarizeUpstreamError,
  type UpstreamEndpoint,
} from './upstreamRequest.js';

export type BuiltEndpointRequest = {
  endpoint: UpstreamEndpoint;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime?: {
    executor: 'default' | 'codex' | 'gemini-native' | 'gemini-cli' | 'antigravity' | 'claude';
    modelName?: string;
    stream?: boolean;
    oauthProjectId?: string | null;
    action?: 'generateContent' | 'streamGenerateContent' | 'countTokens';
  };
};

export type EndpointAttemptContext = {
  endpointIndex: number;
  endpointCount: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  response: Awaited<ReturnType<typeof fetch>>;
  rawErrText: string;
  recoverApplied?: boolean;
};

export type EndpointAttemptSuccessContext = {
  endpointIndex: number;
  endpointCount: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  response: Awaited<ReturnType<typeof fetch>>;
  recoverApplied?: boolean;
};

export type EndpointRecoverResult = {
  upstream: Awaited<ReturnType<typeof fetch>>;
  upstreamPath: string;
  request?: BuiltEndpointRequest;
  targetUrl?: string;
} | null;

export type EndpointFlowResult =
  | {
    ok: true;
    upstream: Awaited<ReturnType<typeof fetch>>;
    upstreamPath: string;
  }
  | {
    ok: false;
    status: number;
    errText: string;
    rawErrText?: string;
  };

export type ExecuteEndpointFlowInput = {
  siteUrl: string;
  proxyUrl?: string | null;
  disableCrossProtocolFallback?: boolean;
  endpointCandidates: UpstreamEndpoint[];
  buildRequest: (endpoint: UpstreamEndpoint, endpointIndex: number) => BuiltEndpointRequest;
  dispatchRequest?: (
    request: BuiltEndpointRequest,
    targetUrl: string,
    signal?: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof fetch>>>;
  firstByteTimeoutMs?: number;
  tryRecover?: (ctx: EndpointAttemptContext) => Promise<EndpointRecoverResult>;
  shouldDowngrade?: (ctx: EndpointAttemptContext) => boolean;
  shouldAbortRemainingEndpoints?: (ctx: EndpointAttemptContext & { errText: string }) => boolean;
  onDowngrade?: (ctx: EndpointAttemptContext & { errText: string }) => void | Promise<unknown>;
  onAttemptFailure?: (ctx: EndpointAttemptContext & { errText: string }) => void | Promise<unknown>;
  onAttemptSuccess?: (ctx: EndpointAttemptSuccessContext) => void | Promise<unknown>;
};

export function withUpstreamPath(path: string, message: string): string {
  return `[upstream:${path}] ${message}`;
}

async function runEndpointFlowHook<T>(
  hook: ((ctx: T) => void | Promise<unknown>) | undefined,
  ctx: T,
  hookName: string,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(ctx);
  } catch (error) {
    console.error(`endpointFlow ${hookName} hook failed`, error);
  }
}

export async function executeEndpointFlow(input: ExecuteEndpointFlowInput): Promise<EndpointFlowResult> {
  const endpointCount = input.endpointCandidates.length;
  if (endpointCount <= 0) {
    return {
      ok: false,
      status: 502,
      errText: 'Upstream request failed',
    };
  }

  let finalStatus = 0;
  let finalErrText = 'unknown error';
  let finalRawErrText: string | undefined;

  /** 上游目标 URL：首次尝试与自愈重发共用同一口径（含 proxyUrl 场景）。 */
  const resolveTargetUrl = (path: string): string => (
    input.proxyUrl
      ? buildUpstreamUrl(input.proxyUrl, path)
      : buildUpstreamUrl(input.siteUrl, path)
  );

  /**
   * 出站统一入口：首次尝试与 (b) 自愈重发都走这里，保证两者都带首字节超时保护，
   * 且都经同一个 `dispatchRequest` 拿到 timeout signal（保留站点代理与 codex 请求头 / 会话字段）。
   */
  const dispatchAttempt = (
    request: BuiltEndpointRequest,
    targetUrl: string,
  ): Promise<Awaited<ReturnType<typeof fetch>>> => (
    fetchWithObservedFirstByte(
      async (signal) => (
        input.dispatchRequest
          ? await input.dispatchRequest(request, targetUrl, signal)
          : await fetch(targetUrl, await withSiteProxyRequestInit(targetUrl, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal,
          }))
      ),
      {
        firstByteTimeoutMs: input.firstByteTimeoutMs,
        startedAtMs: Date.now(),
      },
    )
  );

  /** 三条成功路径共用（首次 2xx / 既有 tryRecover 成功 / 自愈成功），禁止复制粘贴。 */
  const returnAttemptSuccess = async (
    ctx: EndpointAttemptSuccessContext,
  ): Promise<EndpointFlowResult> => {
    await runEndpointFlowHook(input.onAttemptSuccess, ctx, 'onAttemptSuccess');
    return {
      ok: true,
      upstream: ctx.response,
      upstreamPath: ctx.request.path,
    };
  };

  for (let endpointIndex = 0; endpointIndex < endpointCount; endpointIndex += 1) {
    const endpoint = input.endpointCandidates[endpointIndex] as UpstreamEndpoint;
    const request = input.buildRequest(endpoint, endpointIndex);
    const targetUrl = resolveTargetUrl(request.path);
    // 每个端点尝试最多一次自愈（标志在这次 flow 的局部变量上，不进 retryCount）。
    let selfHealConsumed = false;

    let response = await dispatchAttempt(request, targetUrl);

    if (response.ok) {
      return returnAttemptSuccess({
        endpointIndex,
        endpointCount,
        request,
        targetUrl,
        response,
        recoverApplied: false,
      });
    }

    let rawErrText = await readRuntimeResponseText(response).catch(() => 'unknown error');
    const baseContext: EndpointAttemptContext = {
      endpointIndex,
      endpointCount,
      request,
      targetUrl,
      response,
      rawErrText,
      recoverApplied: false,
    };
    const isLastEndpoint = endpointIndex >= endpointCount - 1;

    if (isObservedFirstByteTimeoutResponse(response) && !isLastEndpoint) {
      const errText = rawErrText.trim() || 'first byte timeout';
      const timeoutContext = {
        ...baseContext,
        errText,
      };
      await runEndpointFlowHook(input.onAttemptFailure, timeoutContext, 'onAttemptFailure');
      finalStatus = response.status || 408;
      finalErrText = errText;
      finalRawErrText = rawErrText;
      if (input.disableCrossProtocolFallback) {
        break;
      }
      continue;
    }

    if (input.tryRecover) {
      const recovered = await input.tryRecover(baseContext);
      baseContext.recoverApplied = recovered !== null
        || baseContext.request !== request
        || baseContext.response !== response
        || baseContext.rawErrText !== rawErrText;
      if (recovered?.upstream?.ok) {
        const recoveredRequest = recovered.request ?? baseContext.request;
        const recoveredTargetUrl = recovered.targetUrl ?? resolveTargetUrl(recovered.upstreamPath);
        return returnAttemptSuccess({
          endpointIndex,
          endpointCount,
          request: recoveredRequest,
          targetUrl: recoveredTargetUrl,
          response: recovered.upstream,
          recoverApplied: true,
        });
      }

      // (b) 自愈：仍在 `if (input.tryRecover)` 内、surface recover 之后、onAttemptFailure 之前。
      // 没有 tryRecover 的调用方（rerank）整段跳过，包括自愈。
      // 门禁（总开关 + 自愈开关）、400、每端点一次、解析 / 结构键拒绝 / present 判定都在 selfHeal 内。
      const selfHealPlan = resolveUpstreamParamCompatSelfHealPlan({
        status: baseContext.response.status,
        rawErrText: baseContext.rawErrText,
        body: baseContext.request.body,
        alreadySelfHealed: selfHealConsumed,
      });
      if (selfHealPlan) {
        selfHealConsumed = true;
        const healedRequest: BuiltEndpointRequest = {
          ...baseContext.request,
          body: selfHealPlan.body,
        };
        const healedTargetUrl = resolveTargetUrl(healedRequest.path);
        const healedResponse = await dispatchAttempt(healedRequest, healedTargetUrl);
        // 一行 info：只含端点、被删键名与两次状态码；不打 body / header / token。
        console.info('[upstream-param-compat] self-heal', {
          endpoint: healedRequest.endpoint,
          path: healedRequest.path,
          removed: selfHealPlan.params,
          firstStatus: baseContext.response.status,
          secondStatus: healedResponse.status,
          outcome: healedResponse.ok ? 'success' : 'failed',
        });
        if (healedResponse.ok) {
          // 成功：显式构造成功上下文走同一 helper；本端点不再有第三次 dispatch。
          return returnAttemptSuccess({
            endpointIndex,
            endpointCount,
            request: healedRequest,
            targetUrl: healedTargetUrl,
            response: healedResponse,
            recoverApplied: true,
          });
        }
        // 失败：先更新 baseContext，再 fall through，让通道重试 / 降级 / oauth hint /
        // 失败日志全部看到第二次的实际响应（有意行为变更）。
        baseContext.request = healedRequest;
        baseContext.response = healedResponse;
        baseContext.rawErrText = await readRuntimeResponseText(healedResponse).catch(() => 'unknown error');
        baseContext.recoverApplied = true;
      }
    }

    rawErrText = baseContext.rawErrText;
    response = baseContext.response;
    const errText = withUpstreamPath(
      baseContext.request.path,
      summarizeUpstreamError(response.status, rawErrText),
    );
    await runEndpointFlowHook(input.onAttemptFailure, {
      ...baseContext,
      errText,
    }, 'onAttemptFailure');

    if (input.disableCrossProtocolFallback && !isLastEndpoint) {
      finalStatus = response.status;
      finalErrText = errText;
      finalRawErrText = rawErrText;
      break;
    }
    const shouldAbortRemainingEndpoints = !isLastEndpoint && !!input.shouldAbortRemainingEndpoints?.({
      ...baseContext,
      errText,
    });
    if (shouldAbortRemainingEndpoints) {
      finalStatus = response.status;
      finalErrText = errText;
      finalRawErrText = rawErrText;
      break;
    }
    const shouldDowngrade = !isLastEndpoint && !!input.shouldDowngrade?.(baseContext);
    if (shouldDowngrade) {
      await runEndpointFlowHook(input.onDowngrade, {
        ...baseContext,
        errText,
      }, 'onDowngrade');
      continue;
    }

    finalStatus = response.status;
    finalErrText = errText;
    finalRawErrText = rawErrText;
    break;
  }

  return {
    ok: false,
    status: finalStatus || 502,
    errText: finalErrText || 'unknown error',
    rawErrText: finalRawErrText,
  };
}
