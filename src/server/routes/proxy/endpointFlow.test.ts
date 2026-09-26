import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import type { BuiltEndpointRequest } from './endpointFlow.js';
import { config } from '../../config.js';
import { shouldAbortSameSiteEndpointFallback, shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

vi.mock('../../services/siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_targetUrl: string, init: RequestInit) => init,
}));

const fetchMock = vi.mocked(fetch);

function requestFor(path: string): BuiltEndpointRequest {
  return {
    endpoint: 'responses',
    path,
    headers: { 'content-type': 'application/json' },
    body: { model: 'gpt-5.2', input: 'hello' },
  };
}

function toUndiciResponse(response: Response): Awaited<ReturnType<typeof fetch>> {
  return response as unknown as Awaited<ReturnType<typeof fetch>>;
}

describe('executeEndpointFlow', () => {
  let executeEndpointFlow: (input: any) => Promise<any>;

  beforeEach(async () => {
    if (!executeEndpointFlow) {
      ({ executeEndpointFlow } = await import('./endpointFlow.js'));
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('returns the first successful upstream response', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upstreamPath).toBe('/v1/responses');
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.com/v1/responses');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the injected dispatchRequest hook instead of the default fetch path', async () => {
    const dispatchRequest = vi.fn(async () => toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
      dispatchRequest,
    });

    expect(result.ok).toBe(true);
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
    expect(dispatchRequest.mock.calls[0]?.[1]).toBe('https://example.com/v1/responses');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('avoids duplicated /v1 when base url already ends with /v1', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await executeEndpointFlow({
      siteUrl: 'https://api.example.com/v1',
      endpointCandidates: ['chat'],
      buildRequest: () => ({ ...requestFor('/v1/chat/completions'), endpoint: 'chat' }),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('avoids duplicated /v1 when base url already ends with /api/v1', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await executeEndpointFlow({
      siteUrl: 'https://openrouter.ai/api/v1',
      endpointCandidates: ['chat'],
      buildRequest: () => ({ ...requestFor('/v1/chat/completions'), endpoint: 'chat' }),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('keeps a configured v3 Coding Plan base path without appending /v1', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await executeEndpointFlow({
      siteUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      endpointCandidates: ['chat'],
      buildRequest: () => ({ ...requestFor('/v1/chat/completions'), endpoint: 'chat' }),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions');
  });

  it('keeps url well-formed when base url includes query/hash', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await executeEndpointFlow({
      siteUrl: 'https://api.example.com/v1?foo=1#keep',
      endpointCandidates: ['chat'],
      buildRequest: () => ({ ...requestFor('/v1/chat/completions'), endpoint: 'chat' }),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/chat/completions?foo=1#keep');
  });

  it('downgrades to next endpoint when policy allows', async () => {
    fetchMock
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
        error: { message: 'unsupported endpoint', type: 'invalid_request_error' },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })))
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    const downgradedPaths: string[] = [];
    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      shouldDowngrade: () => true,
      onDowngrade: (ctx) => {
        downgradedPaths.push(ctx.request.path);
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upstreamPath).toBe('/v1/chat/completions');
    }
    expect(downgradedPaths).toEqual(['/v1/responses']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not downgrade to the next endpoint when cross protocol fallback is disabled', async () => {
    fetchMock
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
        error: { message: 'unsupported endpoint', type: 'invalid_request_error' },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })))
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    const onDowngrade = vi.fn();
    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      shouldDowngrade: () => true,
      disableCrossProtocolFallback: true,
      onDowngrade,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.errText).toContain('/v1/responses');
    }
    expect(onDowngrade).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('emits attempt callbacks for failed and successful endpoint probes', async () => {
    fetchMock
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
        error: { message: 'unsupported endpoint', type: 'invalid_request_error' },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })))
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    const onAttemptFailure = vi.fn();
    const onAttemptSuccess = vi.fn();

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      shouldDowngrade: () => true,
      onAttemptFailure,
      onAttemptSuccess,
    });

    expect(result.ok).toBe(true);
    expect(onAttemptFailure).toHaveBeenCalledTimes(1);
    expect(onAttemptFailure.mock.calls[0]?.[0]?.request?.path).toBe('/v1/responses');
    expect(onAttemptSuccess).toHaveBeenCalledTimes(1);
    expect(onAttemptSuccess.mock.calls[0]?.[0]?.request?.path).toBe('/v1/chat/completions');
  });

  it('stops same-site endpoint fallback when the failure is classified as a site outage', async () => {
    fetchMock
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
        error: { message: 'Service temporarily unavailable', type: 'upstream_error' },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })))
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      shouldAbortRemainingEndpoints: () => true,
      shouldDowngrade: () => true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.errText).toContain('Service temporarily unavailable');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts recovered response from tryRecover hook', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
      error: { message: 'upstream_error', type: 'upstream_error' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    const recovered = toUndiciResponse(new Response(JSON.stringify({ ok: 'recovered' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
      tryRecover: async () => ({
        upstream: recovered,
        upstreamPath: '/v1/responses',
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upstreamPath).toBe('/v1/responses');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses recovered request metadata for success callbacks', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
      error: { message: 'upstream_error', type: 'upstream_error' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    const recovered = toUndiciResponse(new Response(JSON.stringify({ ok: 'recovered' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const onAttemptSuccess = vi.fn();

    await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
      tryRecover: async () => ({
        upstream: recovered,
        upstreamPath: '/v1/messages',
        request: { ...requestFor('/v1/messages'), endpoint: 'messages' },
      }),
      onAttemptSuccess,
    });

    expect(onAttemptSuccess).toHaveBeenCalledTimes(1);
    expect(onAttemptSuccess.mock.calls[0]?.[0]?.request?.path).toBe('/v1/messages');
    expect(onAttemptSuccess.mock.calls[0]?.[0]?.targetUrl).toBe('https://example.com/v1/messages');
  });

  it('does not let attempt hook failures change routing', async () => {
    fetchMock
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
        error: { message: 'unsupported endpoint', type: 'invalid_request_error' },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })))
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      shouldDowngrade: () => true,
      onAttemptFailure: async () => {
        throw new Error('failure hook should be ignored');
      },
      onAttemptSuccess: async () => {
        throw new Error('success hook should be ignored');
      },
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses proxyUrl for the default fetch path when no dispatch hook is provided', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await executeEndpointFlow({
      siteUrl: 'https://example.com',
      proxyUrl: 'https://proxy.internal/base',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://proxy.internal/base/v1/responses');
  });
  it('normalizes proxyUrl with versioned base paths instead of duplicating path segments', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await executeEndpointFlow({
      siteUrl: 'https://example.com',
      proxyUrl: 'https://proxy.internal/api/v1?mode=relay#frag',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://proxy.internal/api/v1/responses?mode=relay#frag');
  });
  it('returns normalized final error when all endpoints fail', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
      error: { message: 'upstream_error', type: 'upstream_error' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.errText).toContain('[upstream:/v1/responses]');
      expect(result.errText).toContain('Upstream returned HTTP 400');
    }
  });
});

describe('executeEndpointFlow upstream param compat self-heal', () => {
  const originalSettings = {
    enabled: config.upstreamParamCompatEnabled,
    selfHealEnabled: config.upstreamParamCompatSelfHealEnabled,
    rules: config.upstreamParamCompatRules,
  };

  const NIM_400 = 'Validation: Unsupported parameter(s): prompt_cache_key, prompt_cache_retention';

  let runFlow: (input: any) => Promise<any>;
  let dispatches: Array<{
    path: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    signal?: AbortSignal;
  }>;
  let onAttemptSuccess: ReturnType<typeof vi.fn>;
  let onAttemptFailure: ReturnType<typeof vi.fn>;

  function textResponse(text: string, status: number): Awaited<ReturnType<typeof fetch>> {
    return toUndiciResponse(new Response(text, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })) as Awaited<ReturnType<typeof fetch>>;
  }

  function buildDelayedResponse(bodyText: string, delayMs: number, signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode(bodyText));
          controller.close();
        }, delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
        }, { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function healableRequest(path: string): BuiltEndpointRequest {
    return {
      endpoint: 'responses',
      path,
      headers: { 'content-type': 'application/json', session_id: 'codex-session-1' },
      body: { model: 'gpt-5.4', input: 'hello', prompt_cache_key: 'cache-1' },
    };
  }

  beforeEach(async () => {
    if (!runFlow) {
      ({ executeEndpointFlow: runFlow } = await import('./endpointFlow.js'));
    }
    config.upstreamParamCompatEnabled = true;
    config.upstreamParamCompatSelfHealEnabled = true;
    dispatches = [];
    onAttemptSuccess = vi.fn();
    onAttemptFailure = vi.fn();
  });

  afterEach(() => {
    config.upstreamParamCompatEnabled = originalSettings.enabled;
    config.upstreamParamCompatSelfHealEnabled = originalSettings.selfHealEnabled;
    config.upstreamParamCompatRules = originalSettings.rules;
  });

  function retryOnceThen(responseAfterRetry: () => Awaited<ReturnType<typeof fetch>>) {
    return vi.fn(async (
      request: BuiltEndpointRequest,
      _targetUrl?: string,
      signal?: AbortSignal,
    ) => {
      dispatches.push({ path: request.path, headers: request.headers, body: request.body, signal });
      if (dispatches.length === 1) return textResponse(NIM_400, 400);
      return responseAfterRetry();
    });
  }

  function runSingleEndpoint(dispatchRequest: any, extra: Record<string, unknown> = {}) {
    return runFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => healableRequest('/v1/responses'),
      dispatchRequest,
      tryRecover: async () => null,
      onAttemptSuccess,
      onAttemptFailure,
      ...extra,
    });
  }

  it('strips the named keys and re-dispatches exactly once, returning the healed upstream', async () => {
    const dispatchRequest = retryOnceThen(() => textResponse('{"ok":true}', 200));

    const result = await runSingleEndpoint(dispatchRequest);

    expect(result.ok).toBe(true);
    expect(result.upstreamPath).toBe('/v1/responses');
    expect(dispatchRequest).toHaveBeenCalledTimes(2);
    // 第二次出站：被点名键消失，其余字段不变；站点代理 / codex 请求头与会话字段保留
    expect(dispatches[1].body).toEqual({ model: 'gpt-5.4', input: 'hello' });
    expect(dispatches[1].headers).toEqual(dispatches[0].headers);
    expect(dispatches[1].path).toBe('/v1/responses');
    // 成功走 onAttemptSuccess（recoverApplied true），不调失败钩子，也没有第三次 dispatch
    expect(onAttemptSuccess).toHaveBeenCalledTimes(1);
    expect(onAttemptSuccess.mock.calls[0][0].recoverApplied).toBe(true);
    expect(onAttemptSuccess.mock.calls[0][0].request.body).not.toHaveProperty('prompt_cache_key');
    expect(onAttemptFailure).not.toHaveBeenCalled();
  });

  it('passes a timeout-capable signal to the second dispatch (S1: no bare dispatch)', async () => {
    const dispatchRequest = retryOnceThen(() => textResponse('{"ok":true}', 200));

    await runSingleEndpoint(dispatchRequest, { firstByteTimeoutMs: 5_000 });

    expect(dispatches).toHaveLength(2);
    expect(dispatches[0].signal).toBeDefined();
    expect(dispatches[1].signal).toBeDefined();
    expect(dispatches[0].signal?.aborted).toBe(false);
    expect(dispatches[1].signal?.aborted).toBe(false);
  });

  it('classifies on the second response: 400 then 500 is retryable (declared behaviour change)', async () => {
    const dispatchRequest = retryOnceThen(() => textResponse('upstream exploded', 500));

    const result = await runSingleEndpoint(dispatchRequest);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.errText).toContain('Upstream returned HTTP 500');
    expect(dispatchRequest).toHaveBeenCalledTimes(2);
    expect(onAttemptFailure).toHaveBeenCalledTimes(1);
    expect(onAttemptFailure.mock.calls[0][0].response.status).toBe(500);
    expect(shouldRetryProxyRequest(500, result.rawErrText)).toBe(true);
  });

  it('exposes the second 403 to the failure path so the existing oauth hint conditions hold', async () => {
    const dispatchRequest = retryOnceThen(() => textResponse('forbidden', 403));

    const result = await runSingleEndpoint(dispatchRequest);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(dispatchRequest).toHaveBeenCalledTimes(2);
    expect(onAttemptFailure).toHaveBeenCalledTimes(1);
    expect(onAttemptFailure.mock.calls[0][0].response.status).toBe(403);
  });

  it('treats a second-dispatch first-byte timeout as an ordinary 408 failure (no continue to the next endpoint)', async () => {
    const dispatchRequest = vi.fn(async (
      request: BuiltEndpointRequest,
      _targetUrl?: string,
      signal?: AbortSignal,
    ) => {
      dispatches.push({ path: request.path, headers: request.headers, body: request.body, signal });
      if (dispatches.length === 1) return textResponse(NIM_400, 400);
      return toUndiciResponse(buildDelayedResponse('{"ok":false}', 60, signal));
    });

    const result = await runFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint: string) => endpoint === 'responses'
        ? healableRequest('/v1/responses')
        : { ...healableRequest('/v1/chat/completions'), endpoint },
      dispatchRequest,
      tryRecover: async () => null,
      firstByteTimeoutMs: 10,
      shouldAbortRemainingEndpoints: (ctx: any) => shouldAbortSameSiteEndpointFallback(ctx.response.status, ctx.rawErrText),
      onAttemptSuccess,
      onAttemptFailure,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(408);
    expect(result.errText).toContain('first byte timeout');
    // 第二次超时不能走首次超时的 `continue` 下一端点分支：不再尝试同站下一端点 `chat`
    expect(dispatches.map((entry) => entry.path)).toEqual(['/v1/responses', '/v1/responses']);
    expect(dispatches.some((entry) => entry.path === '/v1/chat/completions')).toBe(false);
    expect(shouldAbortSameSiteEndpointFallback(408, 'first byte timeout')).toBe(true);
    expect(dispatches[1].signal?.aborted).toBe(true);
  });

  it('does not self-heal when only the self-heal switch is off', async () => {
    config.upstreamParamCompatSelfHealEnabled = false;
    const dispatchRequest = retryOnceThen(() => textResponse('{"ok":true}', 200));

    const result = await runSingleEndpoint(dispatchRequest);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
  });

  it('does not self-heal when the master switch is off even if the self-heal switch is on', async () => {
    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatSelfHealEnabled = true;
    const dispatchRequest = retryOnceThen(() => textResponse('{"ok":true}', 200));

    const result = await runSingleEndpoint(dispatchRequest);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
  });

  it('never self-heals when the caller does not pass tryRecover (rerank form)', async () => {
    const dispatchRequest = retryOnceThen(() => textResponse('{"ok":true}', 200));

    const result = await runFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => healableRequest('/v1/responses'),
      dispatchRequest,
      onAttemptSuccess,
      onAttemptFailure,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a third time when the second response is still 400, and downgrade sees the second text', async () => {
    const dispatchRequest = vi.fn(async (
      request: BuiltEndpointRequest,
      _targetUrl?: string,
      signal?: AbortSignal,
    ) => {
      dispatches.push({ path: request.path, headers: request.headers, body: request.body, signal });
      if (dispatches.length === 1) return textResponse(NIM_400, 400);
      return textResponse('Validation: Unsupported parameter(s): another_param', 400);
    });
    const shouldDowngrade = vi.fn(() => false);

    const result = await runFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint: string) => endpoint === 'responses'
        ? healableRequest('/v1/responses')
        : { ...healableRequest('/v1/chat/completions'), endpoint },
      dispatchRequest,
      tryRecover: async () => null,
      shouldDowngrade,
      onAttemptSuccess,
      onAttemptFailure,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errText).toContain('another_param');
    expect(dispatchRequest).toHaveBeenCalledTimes(2);
    expect(shouldDowngrade).toHaveBeenCalledTimes(1);
    expect(shouldDowngrade.mock.calls[0][0].rawErrText).toContain('another_param');
  });

  it('does not re-dispatch when the named parameter is not a top-level body key', async () => {
    const dispatchRequest = vi.fn(async (
      request: BuiltEndpointRequest,
      _targetUrl?: string,
      signal?: AbortSignal,
    ) => {
      dispatches.push({ path: request.path, headers: request.headers, body: request.body, signal });
      if (dispatches.length === 1) return textResponse('Unsupported parameter(s): not_in_body', 400);
      return textResponse('{"ok":true}', 200);
    });

    const result = await runSingleEndpoint(dispatchRequest);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
  });

  it('never strips structural keys named by the upstream error', async () => {
    const dispatchRequest = vi.fn(async (
      request: BuiltEndpointRequest,
      _targetUrl?: string,
      signal?: AbortSignal,
    ) => {
      dispatches.push({ path: request.path, headers: request.headers, body: request.body, signal });
      if (dispatches.length === 1) return textResponse('Unsupported parameter(s): model, system', 400);
      return textResponse('{"ok":true}', 200);
    });

    const result = await runSingleEndpoint(dispatchRequest);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
  });
});
