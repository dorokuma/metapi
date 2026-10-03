import { zstdCompressSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';
import { proxyChannelCoordinator } from '../../services/proxyChannelCoordinator.js';
import * as siteApiEndpointService from '../../services/siteApiEndpointService.js';
import * as sharedSurfaceModule from '../../proxy-core/surfaces/sharedSurface.js';

/** O8 R4：真实工厂引用（`vi.spyOn` 后还能拿到原实现，供壳子转发）。 */
const realCreateSurfaceFailureToolkit = sharedSurfaceModule.createSurfaceFailureToolkit;

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const estimateProxyCostMock = vi.fn(async (_arg?: any) => 0);
const buildProxyBillingDetailsMock = vi.fn(async (_arg?: any) => null);
const fetchModelPricingCatalogMock = vi.fn(async (_arg?: any): Promise<any> => null);
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));
const proxyLogValuesMock = vi.fn();
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: (values?: any) => {
    // O-d 回归：把每次写入的取值原样留证，才能断言 `is_stream` / `first_byte_latency_ms` 真的进了写侧。
    proxyLogValuesMock(values);
    return {
      run: () => undefined,
    };
  },
}));

/**
 * 取最近一次写向 `proxy_logs` 的取值对象（`proxy_debug_*` 走同一个 `db.insert`，用只属于 `proxy_logs` 的
 * `httpStatus` / `retryCount` 两个字段区分）。夹具把 `hasProxyLogStreamTimingColumns` 置真，否则
 * `insertProxyLog` 会按设计整列丢弃 `is_stream` / `first_byte_latency_ms`，断言就看不出「缺列」。
 */
const lastProxyLogValues = (): Record<string, any> | null => {
  for (let index = proxyLogValuesMock.mock.calls.length - 1; index >= 0; index -= 1) {
    const values = proxyLogValuesMock.mock.calls[index][0];
    if (values && typeof values === 'object' && 'httpStatus' in values && 'retryCount' in values) {
      return values as Record<string, any>;
    }
  }
  return null;
};

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
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
  buildProxyBillingDetails: (arg: any) => buildProxyBillingDetailsMock(arg),
  fetchModelPricingCatalog: (arg: any) => fetchModelPricingCatalogMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: () => false,
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: async () => [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: async () => undefined,
        }),
      }),
    }),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogClientHttpStatusColumn: async () => true,
  // 本文件现在要断言 `is_stream` / `first_byte_latency_ms` 是否真的进写侧取值，故置真（置假时
  // `insertProxyLog` 按设计整列丢弃这两列，断言无法区分「未传」与「传了但被丢」）。
  hasProxyLogStreamTimingColumns: async () => true,
  schema: {
    proxyLogs: {},
    siteApiEndpoints: {
      id: {},
      siteId: {},
      sortOrder: {},
    },
  },
}));

describe('chat proxy stream behavior', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { chatProxyRoute, claudeMessagesProxyRoute } = await import('./chat.js');
    const { responsesProxyRoute } = await import('./responses.js');
    const { searchProxyRoute } = await import('./search.js');
    app = Fastify();
    await app.register(chatProxyRoute);
    await app.register(claudeMessagesProxyRoute);
    await app.register(responsesProxyRoute);
    await app.register(searchProxyRoute);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    estimateProxyCostMock.mockClear();
    buildProxyBillingDetailsMock.mockClear();
    fetchModelPricingCatalogMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    dbInsertMock.mockClear();
    proxyLogValuesMock.mockClear();
    resetUpstreamEndpointRuntimeState();

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'demo-site', url: 'https://upstream.example.com' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });
    selectNextChannelMock.mockReturnValue(null);
    fetchModelPricingCatalogMock.mockResolvedValue(null);
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
    (config as any).openAiServiceTierRules = undefined;
    config.proxyEmptyContentFailEnabled = false;
    config.proxyErrorKeywords = [];
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('converts non-SSE upstream streaming responses into SSE events', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-demo',
      object: 'chat.completion',
      created: 1_706_000_000,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello from upstream' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
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

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: ');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('hello from upstream');
    expect(response.body).toContain('data: [DONE]');
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it('decodes zstd-compressed non-stream chat responses before serializing downstream JSON', async () => {
    const payload = JSON.stringify({
      id: 'chatcmpl-zstd',
      object: 'chat.completion',
      created: 1_706_000_000,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '你好，来自 zstd 非流式响应' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    fetchMock.mockResolvedValue(new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'application/json; charset=utf-8',
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()?.choices?.[0]?.message?.content).toBe('你好，来自 zstd 非流式响应');
  });

  it('decodes zstd-compressed non-SSE streaming chat responses before SSE conversion', async () => {
    const payload = JSON.stringify({
      id: 'chatcmpl-zstd-stream',
      object: 'chat.completion',
      created: 1_706_000_000,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '你好，来自 zstd 流式回退' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    fetchMock.mockResolvedValue(new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'application/json; charset=utf-8',
      },
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

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('你好，来自 zstd 流式回退');
    expect(response.body).not.toContain('(�/�');
    expect(response.body).toContain('data: [DONE]');
  });

  it('decodes zstd-compressed native SSE chat streams before converting downstream chunks', async () => {
    fetchMock.mockResolvedValue(new Response(zstdCompressSync(Buffer.from([
      'data: {"id":"chatcmpl-zstd-native","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-zstd-native","model":"upstream-gpt","choices":[{"delta":{"content":"你好，来自 zstd 原生 SSE"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-zstd-native","model":"upstream-gpt","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''))), {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'text/event-stream; charset=utf-8',
      },
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

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('你好，来自 zstd 原生 SSE');
    expect(response.body).not.toContain('(�/�');
    expect(response.body).toContain('data: [DONE]');
  });

  it('returns upstream_error for empty non-stream chat responses when empty-content failure is enabled', async () => {
    config.proxyEmptyContentFailEnabled = true;

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-empty',
      object: 'chat.completion',
      created: 1_706_000_000,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 6, completion_tokens: 0, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(response.json()?.error?.message).toContain('empty content');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    // O8 追加一：本行由 `handleDetectedFailure` 出口写；改前该出口没传 `firstByteLatencyMs` ⇒ 该列恒 NULL。
    expect(lastProxyLogValues()?.firstByteLatencyMs).toEqual(expect.any(Number));
    // O8 R3：该出口此前也未传 `is_stream`。本用例是非流式请求 ⇒ 真值必须是 `false`（写死 `true` 会在此拆穿）。
    expect(lastProxyLogValues()?.isStream).toBe(false);
  });

  it('returns HTTP upstream_error instead of hijacking when streamed chat requests receive empty non-SSE payloads', async () => {
    config.proxyEmptyContentFailEnabled = true;

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-empty-stream',
      object: 'chat.completion',
      created: 1_706_000_000,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
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

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    // O8 追加一：本行由 `handleDetectedFailure` 出口写；改前该出口没传 `firstByteLatencyMs` ⇒ 该列恒 NULL。
    expect(lastProxyLogValues()?.firstByteLatencyMs).toEqual(expect.any(Number));
    // O8 R3：该出口此前也未传 `is_stream`；本用例是流式请求（`stream: true`）⇒ 真值 `true`。
    expect(lastProxyLogValues()?.isStream).toBe(true);
  });

  it('returns HTTP upstream_error when streamed chat SSE yields only empty deltas before DONE', async () => {
    config.proxyEmptyContentFailEnabled = true;

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-empty-sse","choices":[{"delta":{}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(response.json()?.error?.message).toContain('empty content');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
  });

  it('returns HTTP upstream_error when streamed chat SSE carries prompt usage but no assistant output', async () => {
    config.proxyEmptyContentFailEnabled = true;

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-empty-usage","choices":[{"delta":{}}],"usage":{"prompt_tokens":42203,"completion_tokens":0,"total_tokens":42203}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'long prompt' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(response.json()?.error?.message).toContain('empty content');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
  });

  it('returns HTTP upstream_error when streamed chat SSE carries completion usage but no assistant output', async () => {
    config.proxyEmptyContentFailEnabled = true;

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-empty-completion-usage","choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'long prompt' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(response.json()?.error?.message).toContain('empty content');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
  });

  it('keeps streamed non-SSE chat fallback successful when the final payload has visible output but zero completion usage', async () => {
    config.proxyEmptyContentFailEnabled = true;

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-visible-zero-usage',
      object: 'chat.completion',
      created: 1_706_000_000,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'visible answer despite zero output usage' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('visible answer despite zero output usage');
    expect(response.body).toContain('data: [DONE]');
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it('returns clear 400 when /v1/chat/completions receives responses-style input without messages', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body?.error?.type).toBe('invalid_request_error');
    expect(body?.error?.message).toContain('/v1/responses');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sets anti-buffering SSE headers for streamed chat responses', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-transform');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('"delta":{"role":"assistant","content":"hello"}');
    expect(response.body).toContain('data: [DONE]');
  });

  it('normalizes inline think tags into reasoning_content for /v1/chat/completions streams', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think","model":"upstream-gpt","choices":[{"delta":{"content":"<think>plan quietly</think>"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think","model":"upstream-gpt","choices":[{"delta":{"content":"visible answer"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think","model":"upstream-gpt","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        messages: [{ role: 'user', content: 'show your work and answer' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('"reasoning_content":"plan quietly"');
    expect(response.body).toContain('"content":"visible answer"');
    expect(response.body).not.toContain('<think>');
    expect(response.body).not.toContain('</think>');
    expect(response.body).toContain('data: [DONE]');
  });

  it('tracks split inline think tags across SSE chunks for /v1/chat/completions streams', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think-split","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think-split","model":"upstream-gpt","choices":[{"delta":{"content":"<thin"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think-split","model":"upstream-gpt","choices":[{"delta":{"content":"k>plan "},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think-split","model":"upstream-gpt","choices":[{"delta":{"content":"quietly</th"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think-split","model":"upstream-gpt","choices":[{"delta":{"content":"ink>visible "},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think-split","model":"upstream-gpt","choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-think-split","model":"upstream-gpt","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        messages: [{ role: 'user', content: 'show your work and answer' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('"reasoning_content":"plan "');
    expect(response.body).toContain('"reasoning_content":"quietly"');
    expect(response.body).toContain('"content":"visible "');
    expect(response.body).toContain('"content":"answer"');
    expect(response.body).not.toContain('<think>');
    expect(response.body).not.toContain('</think>');
    expect(response.body).not.toContain('<thin');
    expect(response.body).not.toContain('quietly</th');
    expect(response.body).not.toContain('ink>visible');
    expect(response.body).toContain('data: [DONE]');
  });

  it('synthesizes a terminal finish chunk when /v1/chat/completions upstream EOFs after visible content', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-eof","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-eof","model":"upstream-gpt","choices":[{"delta":{"content":"tail before eof"},"finish_reason":null}]}\n\n'));
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
        messages: [{ role: 'user', content: 'finish cleanly' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('tail before eof');
    expect(response.body).toContain('"finish_reason":"stop"');
    expect(response.body).toContain('data: [DONE]');
  });

  it('normalizes anthropic-style SSE events into OpenAI chunks for clients like OpenWebUI', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","model":"claude-opus-4-6"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
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
        model: 'claude-opus-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'who are you' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('"delta":{"content":"hello"}');
    expect(response.body).toContain('"finish_reason":"stop"');
    expect(response.body).toContain('data: [DONE]');
  });

  it('emits OpenAI-compatible assistant starter chunk for anthropic message_start events', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_compat","model":"claude-opus-4-6"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"compat"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
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
        model: 'claude-opus-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'compat test' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"delta":{"role":"assistant","content":""}');
    expect(response.body).toContain('"delta":{"content":"compat"}');
    expect(response.body).toContain('data: [DONE]');
  });

  it('converts OpenAI non-stream responses into Claude message format on /v1/messages', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      created: 1_706_000_001,
      model: 'claude-opus-4-6',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello from claude format' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 120, completion_tokens: 16, total_tokens: 136 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('claude-opus-4-6');
    expect(body.content?.[0]?.type).toBe('text');
    expect(body.content?.[0]?.text).toContain('hello from claude format');
    expect(body.stop_reason).toBe('end_turn');
  });

  it('converts OpenAI SSE chunks into Claude stream events on /v1/messages', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"claude-opus-4-6","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"claude-opus-4-6","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"claude-opus-4-6","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: message_start');
    expect(response.body).toContain('event: content_block_delta');
    expect(response.body).toContain('\"text\":\"hello\"');
    expect(response.body).toContain('event: message_stop');
  });

  it('normalizes null Claude message content before proxying on /v1/messages', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: {
        name: 'claude-site',
        url: 'https://upstream.example.com',
        platform: 'claude',
      },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'claude-opus-4-6',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: null },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const forwardedBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(forwardedBody.messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('prefers responses for Claude tool_result follow-ups that include continuation hints', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: {
        name: 'openai-site',
        url: 'https://upstream.example.com',
        platform: 'openai',
      },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'gpt-5.4',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_1',
      object: 'response',
      model: 'gpt-5.4',
      created_at: 1_706_000_000,
      status: 'completed',
      output: [{
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done' }],
      }],
      usage: {
        input_tokens: 5,
        output_tokens: 1,
        total_tokens: 6,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        previous_response_id: 'resp_prev_1',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_missing',
                content: [{ type: 'text', text: '{"matches":1}' }],
              },
              { type: 'text', text: 'continue' },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/responses');
    const forwardedBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(forwardedBody.previous_response_id).toBe('resp_prev_1');
    expect(forwardedBody.input[0]).toEqual({
      type: 'function_call_output',
      call_id: 'toolu_missing',
      output: '{"matches":1}',
    });
  });

  it('converts OpenAI tool_calls SSE into Claude tool_use stream events on /v1/messages', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-tool","model":"claude-opus-4-6","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-tool","model":"claude-opus-4-6","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_glob","type":"function","function":{"name":"Glob","arguments":""}}]},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-tool","model":"claude-opus-4-6","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\":\\"README*\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'find readme files' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: content_block_start');
    expect(response.body).toContain('"type":"tool_use"');
    expect(response.body).toContain('"name":"Glob"');
    expect(response.body).toContain('"type":"input_json_delta"');
    expect(response.body).toContain('"partial_json":"{\\"pattern\\":\\"README*\\"}"');
    expect(response.body).toContain('"stop_reason":"tool_use"');
  });

  it('keeps final content when upstream chunk carries both delta and finish_reason on /v1/messages', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-2","model":"claude-opus-4-6","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-2","model":"claude-opus-4-6","choices":[{"delta":{"content":"tail-token"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: content_block_delta');
    expect(response.body).toContain('\"text\":\"tail-token\"');
    expect(response.body).toContain('event: message_stop');
  });

  it('preserves Claude-specific payload fields and forwards claude headers on /v1/messages', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_headers',
      type: 'message',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        'anthropic-beta': 'code-2025-09-30',
        'x-claude-client': 'claude-code',
      },
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { session_id: 'abc123' },
        thinking: { type: 'enabled', budget_tokens: 1024 },
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(options.headers['anthropic-beta']).toContain('claude-code-20250219');
    expect(options.headers['anthropic-beta']).toContain('code-2025-09-30');
    expect(options.headers['x-claude-client']).toBe('claude-code');

    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.metadata).toEqual({ session_id: 'abc123' });
    expect(forwardedBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('stops forwarding extra SSE events after message_stop on /v1/messages', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stop_early","model":"claude-opus-4-6"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: message_stop');
    expect(response.body).not.toContain('event: ping');
  });

  it('does not synthesize message_stop when anthropic upstream EOFs before terminal event on /v1/messages', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_eof_early","model":"claude-opus-4-6"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: message_start');
    expect(response.body).toContain('event: content_block_delta');
    expect(response.body).not.toContain('event: message_stop');
    expect(response.body).not.toContain('"stop_reason":"end_turn"');
  });

  it('normalizes Claude thinking adaptive type for legacy upstreams on /v1/messages', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_headers_adaptive',
      type: 'message',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'adaptive', budget_tokens: 1024 },
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('retries /v1/messages with normalized Claude body when upstream says messages is required', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          type: '<nil>',
          message: 'messages is required',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_retry_ok',
        type: 'message',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'ok after normalized fallback' }],
        stop_reason: 'end_turn',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);

    const [_firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [_secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);

    expect(Array.isArray(firstBody.messages)).toBe(true);
    expect(Array.isArray(secondBody.messages)).toBe(true);
    expect(Array.isArray(secondBody.messages[0]?.content)).toBe(true);
    expect(secondBody.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('hello'),
        }),
      ]),
    );
  });

  it('keeps native Claude file blocks when retrying /v1/messages with normalized body', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          type: '<nil>',
          message: 'messages is required',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_retry_file_ok',
        type: 'message',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'ok after normalized fallback' }],
        stop_reason: 'end_turn',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'summarize this file' },
              {
                type: 'file',
                file: {
                  filename: 'brief.pdf',
                  file_data: 'JVBERi0xLjc=',
                },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);

    const [_firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [_secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);

    expect(firstBody.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'document',
          title: 'brief.pdf',
        }),
      ]),
    );
    expect(secondBody.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'document',
          title: 'brief.pdf',
        }),
      ]),
    );
  });

  it('downgrades to next endpoint when normalized Claude fallback still returns messages is required', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          type: '<nil>',
          message: 'messages is required',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          type: '<nil>',
          message: 'messages is required',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl_downgraded_ok',
        object: 'chat.completion',
        model: 'upstream-gpt',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok after endpoint downgrade' },
          finish_reason: 'stop',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(3);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    expect(firstUrl).toContain('/v1/messages');
    expect(secondUrl).toContain('/v1/messages');
    expect(thirdUrl).toContain('/v1/chat/completions');
    expect(response.json()?.type).toBe('message');
  });

  it('passes through Claude tool_use SSE events on /v1/messages for CLI tool execution', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_tool_1","model":"claude-opus-4-6","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Glob","input":{}}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"README*\\"}"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":6}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'find readme files' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: content_block_start');
    expect(response.body).toContain('"type":"tool_use"');
    expect(response.body).toContain('"name":"Glob"');
    expect(response.body).toContain('"partial_json":"{\\"pattern\\":\\"README*\\"}"');
    expect(response.body).toContain('event: message_stop');
  });

  it('serves /v1/responses via protocol translation when upstream is OpenAI-compatible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_123',
      object: 'response',
      output_text: 'hello from responses',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'accept-language': 'zh-CN',
        'openai-beta': 'responses-2025-03-11',
        'x-stainless-lang': 'typescript',
        originator: 'codex_cli_rs',
        session_id: 'session-123',
        conversation_id: 'conversation-123',
        'x-codex-turn-state': 'turn-state',
        'x-codex-turn-metadata': 'turn-metadata',
        version: '0.202.0',
      },
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('hello from responses');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
    const forwarded = JSON.parse(options.body);
    expect(forwarded.model).toBe('upstream-gpt');
    expect(forwarded.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
  });

  it('forces upstream SSE for non-stream /v1/responses requests on sub2api and aggregates the final payload', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'sub2api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'gpt-5.2-codex',
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_sub2api_forced_stream","model":"gpt-5.2-codex","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_sub2api_forced_stream","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_sub2api_forced_stream","delta":"hello from forced sub2api stream"}\n\n'));
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_sub2api_forced_stream","model":"gpt-5.2-codex","status":"completed","output":[{"id":"msg_sub2api_forced_stream","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello from forced sub2api stream"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello',
        store: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('hello from forced sub2api stream');

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    const forwarded = JSON.parse(options.body);
    expect(options.headers.accept).toBe('text/event-stream');
    expect(forwarded.stream).toBe(true);
    expect(forwarded.store).toBe(false);
  });

  it('continues downgrade to /v1/messages when /v1/chat/completions returns messages is required for /v1/responses', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'openai_error',
          type: 'bad_response_status_code',
          code: 'bad_response_status_code',
        },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'messages is required',
          type: 'upstream_error',
          code: null,
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_responses_retry_messages',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'ok from messages fallback' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    expect(firstUrl).toContain('/v1/responses');
    expect(secondUrl).toContain('/v1/chat/completions');
    expect(thirdUrl).toContain('/v1/messages');

    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('ok from messages fallback');
  });

  it('canonicalizes native /v1/responses SSE payloads instead of passing them through raw', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('response.output_text.delta');
    expect(response.body).toContain('response.output_text.done');
    expect(response.body).toContain('response.output_item.done');
    expect(response.body).toContain('response.completed');
    expect(response.body).toContain('[DONE]');
  });

  it('converts chat-completions SSE to Responses stream events for /v1/responses clients', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1","model":"upstream-gpt","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1","model":"upstream-gpt","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('response.output_item.added');
    expect(response.body).toContain('response.output_text.delta');
    expect(response.body).toContain('response.completed');
    expect(response.body).toContain('[DONE]');
  });

  it('replays downgraded chat-completions SSE for websocket transport without requiring native responses terminals', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1-ws","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1-ws","model":"upstream-gpt","choices":[{"delta":{"content":"hello from fallback"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1-ws","model":"upstream-gpt","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'x-metapi-responses-websocket-transport': '1',
      },
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('response.output_item.added');
    expect(response.body).toContain('response.output_text.delta');
    expect(response.body).toContain('response.completed');
    expect(response.body).not.toContain('response.failed');
    expect(response.body).toContain('[DONE]');
  });

  it('initializes reasoning items before emitting reasoning summary deltas on /v1/responses streams', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1-reasoning","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1-reasoning","model":"upstream-gpt","choices":[{"delta":{"reasoning_content":"plan first"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r1-reasoning","model":"upstream-gpt","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: response.output_item.added');
    expect(response.body).toContain('event: response.reasoning_summary_part.added');
    expect(response.body).toContain('event: response.reasoning_summary_text.delta');
    const eventBlocks = response.body.split('\n\n').filter((block) => block.trim().length > 0);
    const reasoningItemAddedIndex = eventBlocks.findIndex(
      (block) => block.includes('event: response.output_item.added') && block.includes('"type":"reasoning"'),
    );
    const reasoningSummaryPartAddedIndex = eventBlocks.findIndex(
      (block) => block.includes('event: response.reasoning_summary_part.added'),
    );
    const reasoningSummaryTextDeltaIndex = eventBlocks.findIndex(
      (block) => block.includes('event: response.reasoning_summary_text.delta'),
    );

    expect(reasoningItemAddedIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningItemAddedIndex).toBeLessThan(reasoningSummaryPartAddedIndex);
    expect(reasoningSummaryPartAddedIndex).toBeLessThan(reasoningSummaryTextDeltaIndex);
  });

  it('converts chat tool_calls SSE to Responses function_call events on /v1/responses', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r2","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r2","model":"upstream-gpt","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"Glob","arguments":""}}]},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r2","model":"upstream-gpt","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\":\\"README*\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'find readme',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"function_call"');
    expect(response.body).toContain('response.function_call_arguments.delta');
    expect(response.body).toContain('"name":"Glob"');
    expect(response.body).toContain('"delta":"{\\"pattern\\":\\"README*\\"}"');
    expect(response.body).toContain('response.completed');
  });

  it('emits response.failed without synthetic response.completed when upstream stream fails on /v1/responses', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r3","model":"upstream-gpt","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('event: error\ndata: {"type":"error","error":{"message":"upstream stream failed","type":"upstream_error"}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('response.failed');
    expect(response.body).toContain('"status":"failed"');
    expect(response.body).not.toContain('response.completed');
    expect(response.body).toContain('[DONE]');
  });

  it('preserves Responses-specific payload fields and forwards openai headers on /v1/responses', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_passthrough',
      object: 'response',
      status: 'completed',
      model: 'upstream-gpt',
      output_text: 'ok',
      output: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'openai-beta': 'responses-2025-03-11',
        'x-stainless-lang': 'typescript',
        originator: 'codex_cli_rs',
      },
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        metadata: { session_id: 'abc123' },
        reasoning: { effort: 'high' },
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(options.headers['openai-beta']).toBe('responses-2025-03-11');
    expect(options.headers['x-stainless-lang']).toBe('typescript');
    expect(options.headers.originator).toBe('codex_cli_rs');

    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.metadata).toEqual({ session_id: 'abc123' });
    expect(forwardedBody.reasoning).toEqual({ effort: 'high' });
    expect(forwardedBody.include).toEqual(['reasoning.encrypted_content']);
  });

  it('retries /v1/responses without metadata when upstream returns empty upstream_error', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: '',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_retry_without_metadata',
        object: 'response',
        status: 'completed',
        model: 'upstream-gpt',
        output_text: 'ok after stripping metadata',
        output: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        metadata: { trace_id: 'req-1' },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.output_text).toContain('ok after stripping metadata');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/responses');
    expect(secondUrl).toContain('/v1/responses');

    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);
    expect(firstBody.metadata).toEqual({ trace_id: 'req-1' });
    expect(secondBody.metadata).toBeUndefined();
  });

  it('retries /v1/responses with core body when upstream returns empty upstream_error', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: '',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_retry_core_body',
        object: 'response',
        status: 'completed',
        model: 'upstream-gpt',
        output_text: 'ok after core retry',
        output: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        store: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.output_text).toContain('ok after core retry');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [_firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [_secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);
    expect(firstBody.store).toBe(true);
    expect(secondBody.store).toBeUndefined();
    expect(secondBody.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
  });

  it('retries /v1/responses when upstream_error message is literal upstream_error and falls back to strict body', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'upstream_error',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'upstream_error',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_retry_strict_body',
        object: 'response',
        status: 'completed',
        model: 'upstream-gpt',
        output_text: 'ok after strict retry',
        output: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        temperature: 0.7,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.output_text).toContain('ok after strict retry');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const [, thirdOptions] = fetchMock.mock.calls[2] as [string, any];
    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);
    const thirdBody = JSON.parse(thirdOptions.body);
    expect(firstBody.temperature).toBe(0.7);
    expect(secondBody.temperature).toBe(0.7);
    expect(thirdBody.temperature).toBeUndefined();
    expect(thirdBody).toEqual({
      model: 'upstream-gpt',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
      stream: false,
    });
  });

  it('rejects external HTTP previous_response_id before sub2api compatibility retries', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'sub2api-site', url: 'https://sub2api.example.com', platform: 'sub2api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-sub2api',
      actualModel: 'upstream-gpt',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'upstream_error',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_sub2api_safe_headers',
        object: 'response',
        status: 'completed',
        model: 'upstream-gpt',
        output_text: 'sub2api safe header retry preserved responses semantics',
        output: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'accept-language': 'zh-CN',
        'openai-beta': 'responses-2025-03-11',
        'x-stainless-lang': 'typescript',
        originator: 'codex_cli_rs',
        session_id: 'session-123',
        conversation_id: 'conversation-123',
        'x-codex-turn-state': 'turn-state',
        'x-codex-turn-metadata': 'turn-metadata',
        version: '0.202.0',
      },
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        previous_response_id: 'resp_prev_1',
        include: ['reasoning.encrypted_content'],
        reasoning: { effort: 'high' },
        prompt_cache_key: 'cache-key-1',
        service_tier: 'priority',
        background: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('HTTP /v1/responses');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries generic 400 /v1/responses with minimal headers for strict compatibility fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'request validation failed',
          type: 'invalid_request_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'request validation failed',
          type: 'invalid_request_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'request validation failed',
          type: 'invalid_request_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_retry_minimal_headers',
        object: 'response',
        status: 'completed',
        model: 'upstream-gpt',
        output_text: 'ok after minimal headers retry',
        output: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'openai-beta': 'responses-2025-03-11',
      },
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        user: 'user-123',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.output_text).toContain('ok after minimal headers retry');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const [, thirdOptions] = fetchMock.mock.calls[2] as [string, any];
    const [, fourthOptions] = fetchMock.mock.calls[3] as [string, any];

    expect(firstOptions.headers['openai-beta']).toBe('responses-2025-03-11');
    expect(secondOptions.headers['openai-beta']).toBe('responses-2025-03-11');
    expect(thirdOptions.headers['openai-beta']).toBe('responses-2025-03-11');
    expect(fourthOptions.headers['openai-beta']).toBeUndefined();

    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);
    const thirdBody = JSON.parse(thirdOptions.body);
    const fourthBody = JSON.parse(fourthOptions.body);
    expect(firstBody.user).toBe('user-123');
    expect(secondBody.user).toBeUndefined();
    expect(thirdBody.user).toBeUndefined();
    expect(secondBody.include).toEqual(['reasoning.encrypted_content']);
    expect(thirdBody.include).toBeUndefined();
    expect(fourthBody.user).toBeUndefined();
  });

  it('returns concise Cloudflare host error on /v1/responses 502 html failures', async () => {
    const html = '<!DOCTYPE html><html><head><title>qaq.al | 502: Bad gateway</title></head><body>Cloudflare Ray ID: 9d6f7c889ffbc8eb</body></html>';
    fetchMock.mockImplementation(() => Promise.resolve(new Response(html, {
      status: 502,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    })));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.error?.type).toBe('upstream_error');
    expect(body.error?.message).toContain('[upstream:');
    expect(body.error?.message).toContain('Cloudflare 502: Bad gateway');
    expect(body.error?.message).not.toContain('<!DOCTYPE html>');
  });

  it('does not downgrade /v1/responses to /v1/chat/completions on generic 400 upstream_error without endpoint mismatch hints', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: '',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-fallback-upstream-error',
        object: 'chat.completion',
        model: 'upstream-gpt',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok via chat fallback from upstream_error' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(firstUrl).toContain('/v1/responses');

    const body = response.json();
    expect(body.error?.message).toBeTruthy();
  });

  it('downgrades /v1/responses to /v1/chat/completions when upstream responses endpoint returns 502', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(
        '<!DOCTYPE html><html><head><title>qaq.al | 502: Bad gateway</title></head><body>Cloudflare</body></html>',
        {
          status: 502,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-fallback-502',
        object: 'chat.completion',
        model: 'upstream-gpt',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok via chat fallback' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/responses');
    expect(secondUrl).toContain('/v1/chat/completions');
    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('ok via chat fallback');
  });

  it('retries /v1/chat/completions with minimal JSON headers on unsupported media type', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "Unsupported Media Type: Only 'application/json' is allowed",
          type: 'invalid_request_error',
        },
      }), {
        status: 415,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-media-type-retry',
        object: 'chat.completion',
        created: 1_706_123_456,
        model: 'upstream-gpt',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok after header retry' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'openai-beta': 'responses-2025-03-11',
      },
      payload: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/chat/completions');
    expect(firstOptions.headers['openai-beta']).toBe('responses-2025-03-11');
    expect(secondOptions.headers['openai-beta']).toBeUndefined();
    expect(secondOptions.headers['content-type']).toBe('application/json');
    expect(secondOptions.headers.accept).toBe('application/json');
  });

  it('sets stream accept header for /v1/responses when downstream omits accept', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_accept","model":"upstream-gpt","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(options.headers.accept).toBe('text/event-stream');
  });

  it('deduplicates cumulative text chunks when /v1/responses is converted from /v1/messages stream', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    const fullText = "I'm Claude, an AI assistant made by Anthropic.";
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_dup_1","model":"upstream-gpt"}}\n\n'));
        controller.enqueue(encoder.encode(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(fullText)}}}\n\n`));
        controller.enqueue(encoder.encode(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(fullText)}}}\n\n`));
        controller.enqueue(encoder.encode(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(fullText)}}}\n\n`));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-sonnet-4-6',
        stream: true,
        input: 'whoru',
      },
    });

    expect(response.statusCode).toBe(200);
    const deltaMatches = response.body.match(/event: response\.output_text\.delta/g) || [];
    expect(deltaMatches.length).toBe(1);
    const textMatches = response.body.match(/I'm Claude, an AI assistant made by Anthropic\./g) || [];
    expect(textMatches.length).toBeGreaterThan(0);
    expect(textMatches.length).toBeLessThanOrEqual(6);
  });

  it('deduplicates overlapping text windows when /v1/responses is converted from /v1/messages stream', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_overlap_1","model":"upstream-gpt"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The user asked \\"whoru\\" which is a common"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"which is a common internet slang"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" internet slang and shorthand for who are you."}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-sonnet-4-6',
        stream: true,
        input: 'whoru',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"delta":" internet slang"');
    expect(response.body).not.toContain('"delta":"which is a common internet slang"');
    expect(response.body).toContain('"text":"The user asked \\"whoru\\" which is a common internet slang and shorthand for who are you."');
  });

  it('preserves legitimate repeated short deltas when /v1/responses is converted from /v1/messages stream', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_repeat_short_1","model":"upstream-gpt"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ha"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ha"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-sonnet-4-6',
        stream: true,
        input: 'laugh',
      },
    });

    expect(response.statusCode).toBe(200);
    const deltaMatches = response.body.match(/event: response\.output_text\.delta/g) || [];
    expect(deltaMatches.length).toBe(2);
    expect(response.body).toContain('"delta":"ha"');
    expect(response.body).toContain('"text":"haha"');
  });

  it('preserves function_call/function_call_output when /v1/responses falls back to /v1/chat/completions', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl_responses_fallback_chat',
      object: 'chat.completion',
      created: 1_706_000_111,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'find readme' }],
          },
          {
            type: 'function_call',
            call_id: 'call_abc',
            name: 'Glob',
            arguments: '{"pattern":"README*"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_abc',
            output: '{"matches":1}',
          },
        ],
        tools: [{
          type: 'function',
          name: 'Glob',
          description: 'Search files',
          parameters: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
            required: ['pattern'],
          },
          strict: true,
        }],
        tool_choice: {
          type: 'function',
          name: 'Glob',
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/chat/completions');

    const forwarded = JSON.parse(options.body);
    expect(Array.isArray(forwarded.messages)).toBe(true);

    const assistantWithToolCall = forwarded.messages.find((item: any) =>
      item?.role === 'assistant'
      && Array.isArray(item?.tool_calls)
      && item.tool_calls.length > 0,
    );
    expect(assistantWithToolCall).toBeTruthy();
    expect(assistantWithToolCall.tool_calls[0].id).toBe('call_abc');
    expect(assistantWithToolCall.tool_calls[0].function?.name).toBe('Glob');
    expect(assistantWithToolCall.tool_calls[0].function?.arguments).toContain('README*');

    const toolMessage = forwarded.messages.find((item: any) => item?.role === 'tool');
    expect(toolMessage).toBeTruthy();
    expect(toolMessage.tool_call_id).toBe('call_abc');
    expect(toolMessage.content).toContain('matches');

    expect(forwarded.tools?.[0]?.function?.name).toBe('Glob');
    expect(forwarded.tool_choice?.function?.name).toBe('Glob');
  });


  it('preserves function_call/function_call_output when /v1/responses falls back to /v1/messages', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['anthropic'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_responses_fallback_messages',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'find readme' }],
          },
          {
            type: 'function_call',
            call_id: 'call_abc',
            name: 'Glob',
            arguments: '{"pattern":"README*"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_abc',
            output: '{"matches":1}',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');

    const forwarded = JSON.parse(options.body);
    expect(Array.isArray(forwarded.messages)).toBe(true);

    const assistantMessage = forwarded.messages.find((item: any) => item?.role === 'assistant');
    expect(Array.isArray(assistantMessage?.content)).toBe(true);
    expect(assistantMessage.content.some((part: any) => part?.type === 'tool_use')).toBe(true);

    const userToolResultMessage = forwarded.messages.find((item: any) =>
      item?.role === 'user'
      && Array.isArray(item?.content)
      && item.content.some((part: any) => part?.type === 'tool_result'),
    );
    expect(userToolResultMessage).toBeTruthy();
    expect(userToolResultMessage.content[0].tool_use_id).toBe('call_abc');
  });

  it('routes /v1/responses to /v1/messages when upstream catalog is anthropic-only', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['anthropic'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_900',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'hello from anthropic messages upstream' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('hello from anthropic messages upstream');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('does not stick generic /v1/responses traffic to /v1/messages after a fallback success', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Gateway time-out', type: 'upstream_error' },
      }), {
        status: 504,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Bad gateway', type: 'upstream_error' },
      }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_fallback_1',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'ok via messages fallback' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_recovered_1',
        object: 'response',
        model: 'upstream-gpt',
        status: 'completed',
        output_text: 'ok via recovered responses',
        usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello',
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json().output_text).toContain('ok via messages fallback');

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello again',
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json().output_text).toContain('ok via recovered responses');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    const [fourthUrl] = fetchMock.mock.calls[3] as [string, any];
    expect(firstUrl).toContain('/v1/responses');
    expect(secondUrl).toContain('/v1/chat/completions');
    expect(thirdUrl).toContain('/v1/messages');
    expect(fourthUrl).toContain('/v1/responses');
  });

  it('prefers native /v1/responses for claude-family /v1/responses requests that explicitly ask for encrypted reasoning', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_reasoning_1',
      object: 'response',
      model: 'upstream-gpt',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_reasoning_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      status: 'completed',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
        include: ['reasoning.encrypted_content'],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
  });

  it('returns upstream_error for empty non-stream /v1/responses payloads when empty-content failure is enabled', async () => {
    config.proxyEmptyContentFailEnabled = true;

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-empty',
      object: 'response',
      model: 'gpt-5.4',
      status: 'completed',
      output: [],
      output_text: '',
      usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(response.json()?.error?.message).toContain('empty content');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    // O8 追加一：本行由 `handleDetectedFailure` 出口写；改前该出口没传 `firstByteLatencyMs` ⇒ 该列恒 NULL。
    expect(lastProxyLogValues()?.firstByteLatencyMs).toEqual(expect.any(Number));
    // O8 R3：该出口此前也未传 `is_stream`。本用例是非流式请求 ⇒ 真值必须是 `false`（写死 `true` 会在此拆穿）。
    expect(lastProxyLogValues()?.isStream).toBe(false);
  });

  it('returns HTTP upstream_error instead of hijacking when streamed /v1/responses receives empty non-SSE payloads', async () => {
    config.proxyEmptyContentFailEnabled = true;

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-empty-stream',
      object: 'response',
      model: 'gpt-5.4',
      status: 'completed',
      output: [],
      output_text: '',
      usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    // O8 追加一：本行由 `handleDetectedFailure` 出口写；改前该出口没传 `firstByteLatencyMs` ⇒ 该列恒 NULL。
    expect(lastProxyLogValues()?.firstByteLatencyMs).toEqual(expect.any(Number));
    // O8 R3：该出口此前也未传 `is_stream`；本用例是流式请求（`stream: true`）⇒ 真值 `true`。
    expect(lastProxyLogValues()?.isStream).toBe(true);
  });

  it('prefers native /v1/responses for claude-family /v1/responses requests that include input_file file_url', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_file_url_1',
      object: 'response',
      model: 'upstream-gpt',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_file_url_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      status: 'completed',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'read this remote file' },
              {
                type: 'input_file',
                filename: 'remote.pdf',
                file_url: 'https://example.com/remote.pdf',
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.input[0].content[1]).toEqual({
      type: 'input_file',
      filename: 'remote.pdf',
      file_url: 'https://example.com/remote.pdf',
    });
  });

  it('converts input_file file_url into Claude document url blocks for claude-only upstreams', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'claude-site', url: 'https://upstream.example.com', platform: 'claude' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-claude',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_file_url_1',
      type: 'message',
      role: 'assistant',
      model: 'upstream-claude',
      content: [{ type: 'text', text: 'hello from claude messages' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'read this remote file' },
              {
                type: 'input_file',
                filename: 'remote.pdf',
                file_url: 'https://example.com/remote.pdf',
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.messages[0].content[1]).toMatchObject({
      type: 'document',
      title: 'remote.pdf',
      source: {
        type: 'url',
        url: 'https://example.com/remote.pdf',
      },
    });
  });

  it('does not let remote document url success poison later inline document endpoint preference', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });
    fetchMock.mockImplementation(async (target: unknown) => {
      const url = String(target);
      if (url.includes('/v1/responses')) {
        return new Response(JSON.stringify({
          id: 'resp_file_url_runtime_1',
          object: 'response',
          model: 'upstream-gpt',
          output_text: 'hello from responses upstream',
          output: [
            {
              id: 'msg_file_url_runtime_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello from responses upstream' }],
            },
          ],
          status: 'completed',
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v1/messages')) {
        return new Response(JSON.stringify({
          id: 'msg_inline_runtime_1',
          type: 'message',
          role: 'assistant',
          model: 'upstream-gpt',
          content: [{ type: 'text', text: 'hello from messages upstream' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 3 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected target url: ${url}`);
    });

    const remoteResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'read this remote file' },
              {
                type: 'input_file',
                filename: 'remote.pdf',
                file_url: 'https://example.com/remote.pdf',
              },
            ],
          },
        ],
      },
    });

    expect(remoteResponse.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/responses');

    const inlineResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'read this inline file' },
              {
                type: 'input_file',
                filename: 'brief.pdf',
                file_data: 'data:application/pdf;base64,JVBERi0xLjQK',
              },
            ],
          },
        ],
      },
    });

    expect(inlineResponse.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/messages');
  });

  it('prefers native /v1/responses for claude-family /v1/responses requests that opt into reasoning without injecting a generic default include', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_reasoning_2',
      object: 'response',
      model: 'upstream-gpt',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_reasoning_2',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      status: 'completed',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
        reasoning: {
          effort: 'high',
          summary: 'auto',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.include).toBeUndefined();
  });

  it('keeps generic claude-family /v1/responses requests on the default messages-first order when codex headers are absent', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_default_messages_first',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'messages endpoint selected by default' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('defaults encrypted reasoning include and prefers native /v1/responses for claude-family codex-surface requests even without reasoning config', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_reasoning_default',
      object: 'response',
      model: 'upstream-gpt',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_reasoning_default',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      status: 'completed',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'openai-beta': 'responses-2025-03-11',
        'x-stainless-lang': 'typescript',
        originator: 'codex_cli_rs',
      },
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.include).toEqual(['reasoning.encrypted_content']);
  });

  it('keeps explicit empty include on claude-family codex-surface responses requests and stays on the default messages-first order', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_explicit_empty_include',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'messages endpoint selected because include stayed empty' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'openai-beta': 'responses-2025-03-11',
        'x-stainless-lang': 'typescript',
        originator: 'codex_cli_rs',
      },
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
        reasoning: {
          effort: 'high',
          summary: 'auto',
        },
        include: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('keeps explicit custom include on claude-family codex-surface responses requests and stays on the default messages-first order', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://upstream.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_explicit_custom_include',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'messages endpoint selected because custom include stayed explicit' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'openai-beta': 'responses-2025-03-11',
        'x-stainless-lang': 'typescript',
        originator: 'codex_cli_rs',
      },
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
        reasoning: {
          effort: 'high',
          summary: 'auto',
        },
        include: ['message.input_image.image_url'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('forces anyrouter platform to prefer /v1/messages even when catalog says openai', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'anyrouter-site', url: 'https://anyrouter.example.com', platform: 'anyrouter' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['openai'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_anyrouter',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'anyrouter prefers messages' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('anyrouter prefers messages');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('prefers /v1/responses on openai platform for claude-family models on /v1/chat/completions', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'claude-opus-4-6',
          supportedEndpointTypes: ['/v1/chat/completions', 'openai'],
        },
      ],
      groupRatio: {},
    });

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-openai',
      actualModel: 'claude-opus-4-6',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_openai_platform_claude',
      object: 'response',
      model: 'claude-opus-4-6',
      status: 'completed',
      output: [{
        id: 'msg_openai_platform_claude',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'responses endpoint selected' }],
      }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-opus-4-6',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
  });

  it('falls back from /v1/responses to /v1/messages on openai platform when responses endpoint is unavailable', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-openai',
      actualModel: 'claude-opus-4-6',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Not Found', type: 'not_found_error' },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_openai_fallback_messages',
        type: 'message',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'fallback to messages completed' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-opus-4-6',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/responses');
    expect(secondUrl).toContain('/v1/chat/completions');
  });

  it('falls back to /v1/responses for /v1/chat/completions when messages/chat endpoints return 502', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'claude-haiku-4-5-20251001',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(
        '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>Cloudflare</body></html>',
        {
          status: 502,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        },
      ))
      .mockResolvedValueOnce(new Response(
        '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>Cloudflare</body></html>',
        {
          status: 502,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_anyrouter_fallback',
        object: 'response',
        model: 'claude-haiku-4-5-20251001',
        status: 'completed',
        output_text: 'ok via responses fallback after 502',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    expect(firstUrl).toContain('/v1/messages');
    expect(secondUrl).toContain('/v1/chat/completions');
    expect(thirdUrl).toContain('/v1/responses');

    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('ok via responses fallback after 502');
  });

  it('stops after the first failed protocol when cross protocol fallback is disabled', async () => {
    (config as any).disableCrossProtocolFallback = true;
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'claude-haiku-4-5-20251001',
    });

    fetchMock.mockResolvedValueOnce(new Response(
      '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>Cloudflare</body></html>',
      {
        status: 502,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      },
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(firstUrl).toContain('/v1/messages');
    const body = response.json();
    expect(body?.error?.message).toContain('/v1/messages');
  });

  it('continues to /v1/responses when /v1/messages dispatch is denied for /v1/chat/completions', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'gpt-5.2-codex',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Unsupported endpoint /v1/chat/completions', type: 'unsupported_endpoint' },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'This group does not allow /v1/messages dispatch', type: 'forbidden' },
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_dispatch_denied_fallback',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'ok via responses after messages dispatch denied',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.2-codex',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
    expect(thirdUrl).toContain('/v1/responses');
    expect(response.json()?.choices?.[0]?.message?.content).toContain('ok via responses');
  });

  it('prefers /v1/responses immediately after explicit legacy protocol rejection on /v1/chat/completions', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'sub2api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'gpt-5.2-codex',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_legacy_protocol_preferred","model":"gpt-5.2-codex","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'));
          controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_legacy_protocol_preferred","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n'));
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_legacy_protocol_preferred","delta":"ok via direct responses preference"}\n\n'));
          controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_legacy_protocol_preferred","model":"gpt-5.2-codex","status":"completed","output":[{"id":"msg_legacy_protocol_preferred","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok via direct responses preference"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.2-codex',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/responses');
    expect(secondUrl).not.toContain('/v1/messages');
    expect(secondOptions.headers.accept).toBe('text/event-stream');
    const forwarded = JSON.parse(secondOptions.body);
    expect(forwarded.stream).toBe(true);
    expect(forwarded.store).toBe(false);
    expect(response.json()?.choices?.[0]?.message?.content).toContain('ok via direct responses preference');
  });

  it('prefers /v1/messages immediately after a generic chat endpoint says messages is required', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'gpt-5.2',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'messages is required',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_messages_required_preferred_1',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'ok via messages fallback' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_messages_required_preferred_2',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'ok via direct messages preference' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.2',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json()?.choices?.[0]?.message?.content).toContain('ok via messages fallback');

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.2',
        stream: false,
        messages: [{ role: 'user', content: 'hello again' }],
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()?.choices?.[0]?.message?.content).toContain('ok via direct messages preference');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
    expect(thirdUrl).toContain('/v1/messages');
    expect(thirdUrl).not.toContain('/v1/chat/completions');
  });

  it('promotes /v1/responses to the next same-request attempt when a generic chat endpoint says input is required', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'gpt-5.2',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'input is required',
          type: 'invalid_request_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_input_required_preferred_1',
        object: 'response',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok via same-request responses promotion' }],
        }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_input_required_preferred_2',
        object: 'response',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok via learned direct responses preference' }],
        }],
        usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.2',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json()?.choices?.[0]?.message?.content).toContain('ok via same-request responses promotion');

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.2',
        stream: false,
        messages: [{ role: 'user', content: 'hello again' }],
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()?.choices?.[0]?.message?.content).toContain('ok via learned direct responses preference');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/responses');
    expect(secondUrl).not.toContain('/v1/messages');
    expect(thirdUrl).toContain('/v1/responses');
    expect(thirdUrl).not.toContain('/v1/chat/completions');
  });

  it('keeps messages-first semantics for claude-family models on generic upstreams', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'generic-site', url: 'https://generic.example.com', platform: 'new-api' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-generic',
      actualModel: 'claude-haiku-4-5-20251001',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'This group does not allow /v1/messages dispatch', type: 'forbidden' },
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.',
          type: 'upstream_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_claude_generic_messages_first',
        object: 'response',
        model: 'claude-haiku-4-5-20251001',
        status: 'completed',
        output_text: 'ok via responses after preserving messages-first order',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    const [thirdUrl] = fetchMock.mock.calls[2] as [string, any];
    expect(firstUrl).toContain('/v1/messages');
    expect(secondUrl).toContain('/v1/chat/completions');
    expect(thirdUrl).toContain('/v1/responses');
    expect(response.json()?.choices?.[0]?.message?.content).toContain('ok via responses');
  });

  it('forces openai platform to use /v1/responses for claude downstream requests', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-openai',
      actualModel: 'gpt-4o-mini',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-openai-for-claude-downstream',
      object: 'response',
      model: 'gpt-4o-mini',
      status: 'completed',
      output: [{
        id: 'msg-openai-for-claude-downstream',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'openai endpoint selected' }],
      }],
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'gpt-4o-mini',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
    expect(targetUrl).not.toContain('/v1/messages');
  });

  it('preserves claude tool_use/tool_result when claude downstream is routed to openai responses endpoint', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-openai',
      actualModel: 'gpt-4o-mini',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-openai-tools',
      object: 'response',
      model: 'gpt-4o-mini',
      status: 'completed',
      output: [{
        id: 'msg-openai-tools',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'tool payload received' }],
      }],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'gpt-4o-mini',
        max_tokens: 256,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_abc',
                name: 'Glob',
                input: { pattern: 'README*' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_abc',
                content: [{ type: 'text', text: '{\"matches\":1}' }],
              },
              {
                type: 'text',
                text: 'continue',
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/v1/responses');
    const forwardedInput = Array.isArray(forwardedBody.input) ? forwardedBody.input : [];

    const functionCall = forwardedInput.find((item: any) => item?.type === 'function_call');
    expect(functionCall).toBeTruthy();
    expect(functionCall.call_id).toBe('toolu_abc');
    expect(functionCall.name).toBe('Glob');
    expect(String(functionCall.arguments || '')).toContain('README*');

    const toolOutput = forwardedInput.find((item: any) => item?.type === 'function_call_output');
    expect(toolOutput).toBeTruthy();
    expect(toolOutput.call_id).toBe('toolu_abc');
    expect(String(toolOutput.output || '')).toContain('matches');
  });

  it('maps claude tool config and thinking budget before routing claude downstream requests to openai responses endpoint', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-openai',
      actualModel: 'gpt-4o-mini',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-openai-config-mapped',
      object: 'response',
      model: 'gpt-4o-mini',
      status: 'completed',
      output: [{
        id: 'msg-openai-config-mapped',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'tool config mapped' }],
      }],
      usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'gpt-4o-mini',
        max_tokens: 256,
        metadata: { user_id: 'user-1' },
        thinking: { type: 'enabled', budget_tokens: 1024 },
        tools: [{
          name: 'Glob',
          description: 'Search files',
          input_schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
            required: ['pattern'],
          },
        }],
        tool_choice: {
          type: 'tool',
          name: 'Glob',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/v1/responses');
    expect(forwardedBody.metadata).toEqual({ user_id: 'user-1' });
    expect(forwardedBody.reasoning).toEqual({
      budget_tokens: 1024,
    });
    expect(forwardedBody.tools).toEqual([{
      type: 'function',
      name: 'Glob',
      description: 'Search files',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      },
    }]);
    expect(forwardedBody.tool_choice).toEqual({
      type: 'function',
      name: 'Glob',
    });
  });

  it('forces claude platform to use /v1/messages with x-api-key auth for openai downstream requests', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'claude-site', url: 'https://api.anthropic.com', platform: 'claude' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-claude',
      actualModel: 'claude-sonnet-4-5-20250929',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_claude_upstream',
      type: 'message',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'claude endpoint selected' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
    expect(options.headers['x-api-key']).toBe('sk-claude');
    expect(options.headers['anthropic-version']).toBeTruthy();
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('preserves openai tool context when /v1/chat/completions is routed to /v1/messages upstream', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'claude-site', url: 'https://api.anthropic.com', platform: 'claude' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-claude',
      actualModel: 'claude-sonnet-4-5-20250929',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_claude_tool_context',
      type: 'message',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        stream: false,
        tools: [{
          type: 'function',
          function: {
            name: 'Glob',
            description: 'Search files',
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string' },
              },
              required: ['pattern'],
            },
          },
        }],
        tool_choice: {
          type: 'function',
          function: {
            name: 'Glob',
          },
        },
        messages: [
          {
            role: 'assistant',
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: {
                name: 'Glob',
                arguments: '{"pattern":"README*"}',
              },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_abc',
            content: '{"matches":1}',
          },
          {
            role: 'user',
            content: 'continue',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(Array.isArray(forwardedBody.messages)).toBe(true);

    const assistantMessage = forwardedBody.messages.find((item: any) => item?.role === 'assistant');
    expect(Array.isArray(assistantMessage?.content)).toBe(true);
    expect(assistantMessage.content.some((part: any) => part?.type === 'tool_use')).toBe(true);

    const userToolResultMessage = forwardedBody.messages.find((item: any) =>
      item?.role === 'user'
      && Array.isArray(item?.content)
      && item.content.some((part: any) => part?.type === 'tool_result'),
    );
    expect(userToolResultMessage).toBeTruthy();
    expect(userToolResultMessage.content[0].tool_use_id).toBe('call_abc');

    expect(forwardedBody.tools?.[0]?.name).toBe('Glob');
    expect(forwardedBody.tools?.[0]?.input_schema?.properties?.pattern?.type).toBe('string');
    expect(forwardedBody.tool_choice).toEqual({ type: 'tool', name: 'Glob' });
  });

  it('groups consecutive tool messages into one anthropic user turn when routing /v1/chat/completions to /v1/messages', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'claude-site', url: 'https://api.anthropic.com', platform: 'claude' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-claude',
      actualModel: 'claude-sonnet-4-5-20250929',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_claude_grouped_tool_results',
      type: 'message',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        stream: false,
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_one',
                type: 'function',
                function: { name: 'Glob', arguments: '{"pattern":"README*"}' },
              },
              {
                id: 'call_two',
                type: 'function',
                function: { name: 'Read', arguments: '{"file":"README.md"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_one', content: '{"matches":["README.md"]}' },
          { role: 'tool', tool_call_id: 'call_two', content: '{"content":"hello"}' },
          { role: 'user', content: 'continue' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const [_targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(Array.isArray(forwardedBody.messages)).toBe(true);

    const userMessages = forwardedBody.messages.filter((item: any) => item?.role === 'user');
    expect(userMessages.length).toBe(1);
    expect(Array.isArray(userMessages[0]?.content)).toBe(true);
    expect(userMessages[0].content.filter((part: any) => part?.type === 'tool_result').length).toBe(2);
    expect(userMessages[0].content.some((part: any) => part?.type === 'tool_result' && part?.tool_use_id === 'call_one')).toBe(true);
    expect(userMessages[0].content.some((part: any) => part?.type === 'tool_result' && part?.tool_use_id === 'call_two')).toBe(true);
    expect(userMessages[0].content.some((part: any) => part?.type === 'text' && part?.text === 'continue')).toBe(true);
  });

  it('converts /v1/responses function_call SSE to OpenAI tool_calls on /v1/chat/completions', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/responses'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123","model":"upstream-gpt","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"Glob"}}\n\n'));
        controller.enqueue(encoder.encode('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"call_id":"call_abc","delta":"{\\"pattern\\":\\"README*\\"}"}\n\n'));
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_123","model":"upstream-gpt","status":"completed","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        model: 'claude-haiku-4-5-20251001',
        stream: true,
        messages: [{ role: 'user', content: 'find readme' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"tool_calls"');
    expect(response.body).toContain('"id":"call_abc"');
    expect(response.body).toContain('"name":"Glob"');
    expect(response.body).toContain('\\"pattern\\":\\"README*\\"');
  });

  it('uses response.function_call_arguments.done when upstream omits delta on /v1/chat/completions', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/responses'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_done_only","model":"upstream-gpt","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_done_only","name":"Glob"}}\n\n'));
        controller.enqueue(encoder.encode('event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":0,"call_id":"call_done_only","arguments":"{\\"pattern\\":\\"README*\\"}"}\n\n'));
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_done_only","model":"upstream-gpt","status":"completed","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        model: 'claude-haiku-4-5-20251001',
        stream: true,
        messages: [{ role: 'user', content: 'find readme' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"tool_calls"');
    expect(response.body).toContain('"id":"call_done_only"');
    expect(response.body).toContain('"name":"Glob"');
    expect(response.body).toContain('\\"pattern\\":\\"README*\\"');
  });

  it('does not duplicate tool arguments when upstream sends both delta and done on /v1/chat/completions', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/responses'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_delta_done","model":"upstream-gpt","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_delta_done","name":"Glob"}}\n\n'));
        controller.enqueue(encoder.encode('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"call_id":"call_delta_done","delta":"{\\"pattern\\":\\"README*\\"}"}\n\n'));
        controller.enqueue(encoder.encode('event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":0,"call_id":"call_delta_done","arguments":"{\\"pattern\\":\\"README*\\"}"}\n\n'));
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_delta_done","model":"upstream-gpt","status":"completed","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        model: 'claude-haiku-4-5-20251001',
        stream: true,
        messages: [{ role: 'user', content: 'find readme' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const matches = response.body.match(/\\"pattern\\":\\"README\*\\"/g) || [];
    expect(matches.length).toBe(1);
  });

  it('delivers an HTTP 502 with the upstream reason when /v1/chat/completions receives response.failed from /v1/responses upstream', async () => {
    // R3-A 后本用例的形态变了（故意，非回归）：上游在**一个字节都没写过**时就给 legacy `response.failed`
    // 帧，旧行为是 `force` 写出归一化块（`finish_reason:"stop"`）+ 回放 `[DONE]` —— 客户端以为「正常结束
    // 但空」（服务端已记 failed，客户端却看不出来）。现在与 `new` 形同门禁：不 hijack，走既有 HTTP 层
    // 502 出口，body = 状态码 + 上游原文（`tool execution failed`）。
    // `response.failed` → `finish_reason:"stop"` 的归一化映射仍由单元层锁住，未失去覆盖：
    // `transformers/openai/chat/index.test.ts:623`、`transformers/shared/chatFormatsCore.test.ts:371`。
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/responses'],
        },
      ],
      groupRatio: {},
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fail_1","model":"upstream-gpt","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'));
        controller.enqueue(encoder.encode('event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_fail_1","model":"upstream-gpt","status":"failed","error":{"message":"tool execution failed"}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
        model: 'claude-haiku-4-5-20251001',
        stream: true,
        messages: [{ role: 'user', content: 'find readme' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(String(response.headers['content-type'] || '')).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    expect(String(response.json()?.error?.message)).toContain('tool execution failed');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
  });

  it('preserves non-stream function_call output when /v1/chat/completions falls back to /v1/responses', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/responses'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_tool_nonstream',
      object: 'response',
      model: 'upstream-gpt',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_abc',
        name: 'Glob',
        arguments: '{"pattern":"README*"}',
      }],
      output_text: '',
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'find readme' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe('call_abc');
    expect(body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('Glob');
    expect(body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments).toContain('README*');
    expect(body?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('preserves openai tool context when /v1/chat/completions is routed to /v1/responses upstream', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/responses'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_tool_forward',
      object: 'response',
      model: 'upstream-gpt',
      status: 'completed',
      output: [],
      output_text: 'ok',
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: false,
        tools: [{
          type: 'function',
          function: {
            name: 'Glob',
            parameters: {
              type: 'object',
              properties: { pattern: { type: 'string' } },
              required: ['pattern'],
            },
          },
        }],
        tool_choice: {
          type: 'function',
          function: { name: 'Glob' },
        },
        messages: [
          {
            role: 'assistant',
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: {
                name: 'Glob',
                arguments: '{"pattern":"README*"}',
              },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_abc',
            content: '{"matches":1}',
          },
          {
            role: 'user',
            content: 'continue',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');

    const forwardedBody = JSON.parse(options.body);
    expect(Array.isArray(forwardedBody.input)).toBe(true);
    expect(forwardedBody.input.some((item: any) => item?.type === 'function_call')).toBe(true);
    expect(forwardedBody.input.some((item: any) => item?.type === 'function_call_output')).toBe(true);
    expect(forwardedBody.tools?.[0]?.name).toBe('Glob');
    expect(forwardedBody.tool_choice).toEqual({ type: 'function', name: 'Glob' });
  });

  it('forwards legacy functions/function_call when /v1/chat/completions is routed to /v1/responses upstream', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/responses'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_legacy_chat',
      object: 'response',
      model: 'upstream-gpt',
      status: 'completed',
      output: [],
      output_text: 'ok',
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: false,
        functions: [{
          name: 'legacy_lookup',
          parameters: { type: 'object' },
        }],
        function_call: { name: 'legacy_lookup' },
        messages: [
          {
            role: 'function',
            name: 'legacy_lookup',
            content: '{"ok":true}',
          },
          {
            role: 'user',
            content: 'continue',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/responses');
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.tools).toEqual([
      { type: 'function', name: 'legacy_lookup', parameters: { type: 'object' } },
    ]);
    expect(forwardedBody.tool_choice).toEqual({ type: 'function', name: 'legacy_lookup' });
    expect(forwardedBody.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'legacy_lookup',
      output: '{"ok":true}',
    });
  });

  it('returns synthetic Anthropic web_search server tool results without adding a new search dependency', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'search.result',
      data: [{ title: 'Metapi', url: 'https://example.com/metapi' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        stream: false,
        tools: [{ type: 'web_search_20250305', max_uses: 2 }],
        messages: [{ role: 'user', content: 'metapi protocol compatibility' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectChannelMock).toHaveBeenCalledWith('__search', expect.anything());
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toBe('https://upstream.example.com/v1/search');
    expect(JSON.parse(options.body)).toMatchObject({
      query: 'metapi protocol compatibility',
      max_results: 2,
    });

    const body = response.json();
    expect(body.content?.[0]).toMatchObject({
      type: 'server_tool_use',
      name: 'web_search',
    });
    expect(body.content?.[1]).toMatchObject({
      type: 'web_search_tool_result',
    });
  });

  it('streams synthetic Anthropic web_search server tool results over SSE', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'search.result',
      data: [{ title: 'Metapi SSE' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        stream: true,
        tools: [{ type: 'web_search_20250305' }],
        messages: [{ role: 'user', content: 'metapi sse search' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('"type":"server_tool_use"');
    expect(response.body).toContain('"type":"web_search_tool_result"');
    expect(response.body).toContain('message_stop');
  });

  it('returns synthetic Responses web_search results without touching completions upstreams', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'search.result',
      data: [{ title: 'Metapi Responses', url: 'https://example.com/responses' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-4.1',
        stream: false,
        tools: [{ type: 'web_search', name: 'web_search', max_results: 3 }],
        input: 'metapi responses web search',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectChannelMock).toHaveBeenCalledWith('__search', expect.anything());
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toBe('https://upstream.example.com/v1/search');
    expect(JSON.parse(options.body)).toMatchObject({
      query: 'metapi responses web search',
      max_results: 3,
    });

    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('Metapi Responses');
    expect(body.output?.[0]).toMatchObject({
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'metapi responses web search',
      },
    });
    expect(body.output?.[1]?.content?.[0]?.text).toContain('Metapi Responses');
  });

  it('routes gemini platform to OpenAI-compatible upstream endpoint path', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'gemini-site', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'gemini-key',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-gemini-openai-compat',
      object: 'chat.completion',
      created: 1_706_000_004,
      model: 'gemini-2.5-flash',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'gemini endpoint selected' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gemini-2.5-flash',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1beta/openai/chat/completions');
    expect(options.headers.Authorization).toBe('Bearer gemini-key');
  });

  it('chooses /v1/messages upstream when catalog indicates messages-only endpoint support', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_100',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'hello from messages only' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('hello from messages only');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('prefers Messages endpoint for claude-family models when catalog uses generic openai/anthropic labels', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['anthropic', 'openai'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg-claude-first',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'hello from messages endpoint' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('hello from messages endpoint');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('falls back to /v1/messages when catalog only declares openai and chat endpoint fails', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['openai'],
        },
      ],
      groupRatio: {},
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'openai_error',
          type: 'bad_response_status_code',
          code: 'bad_response_status_code',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_fallback_500',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'fallback to messages from openai-only catalog' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('fallback to messages from openai-only catalog');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
  });

  it('downgrades endpoint when upstream returns convert_request_failed/not implemented', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions', '/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'not implemented (request id: abc123)',
          type: 'new_api_error',
          code: 'convert_request_failed',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_200',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'fallback from messages' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 6, total_tokens: 17 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('fallback from messages');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
  });

  it('downgrades endpoint when upstream returns openai_error bad_response_status_code', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions', '/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'openai_error',
          type: 'bad_response_status_code',
          code: 'bad_response_status_code',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_300',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'fallback from bad_response_status_code' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('fallback from bad_response_status_code');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
  });

  it('keeps the streamed failure 502 message within the shared upstream-error cap', async () => {
    // chat 主 handler 的 4 处流式失败 502 出口（`!streamStarted` 分支）现在统一把 message 交给共享封顶
    // （`truncateUpstreamErrorMessage`，≤1000）。本用例锁住该出口对外的不变量：502 + `upstream_error`
    // + 非 SSE，且客户端拿到的 message 不超过共享上限、不带截断标记、文案保持原样。
    //
    // 历史注释（M2 后局部失效，保留供对照）：本条原来只能断言本地文案，因为「上游超长原文 → 这 4 处出口」
    // 当时**夹具内不可构造**——上游的 error/response.failed 帧会被 `proxyStream` 以 `force` 立刻写成 SSE
    // 帧（`streamStarted` 变 true），到不了 `!streamStarted` 分支。M2（未写出字节 ⇒ 不 hijack）之后，
    // 上游原文**可以**走这 4 处出口，封顶因此可构造，见
    // `delivers an in-band failure over the HTTP layer when no downstream byte was written yet`。
    // 本条只锁出口不变量本身：502 + `upstream_error` + 非 SSE，且 message 不超过共享上限、不带截断标记。
    const {
      UPSTREAM_ERROR_MESSAGE_MAX_LENGTH,
      UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER,
    } = await import('../../proxy-core/surfaces/sharedSurface.js');
    config.proxyEmptyContentFailEnabled = true;

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-cap-502","choices":[{"delta":{}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    const message = String(response.json()?.error?.message ?? '');
    // 出口封顶：客户端拿到的 message 不得超过共享上限。
    expect(message.length).toBeLessThanOrEqual(UPSTREAM_ERROR_MESSAGE_MAX_LENGTH);
    // 文案保持原样；未触发截断（长度未顶到上限）时不得带截断标记。
    expect(message).toContain('empty content');
    if (message.length < UPSTREAM_ERROR_MESSAGE_MAX_LENGTH) {
      expect(message).not.toContain(UPSTREAM_ERROR_MESSAGE_TRUNCATION_MARKER);
    }
  });

  it('serves an oversized upstream error frame verbatim in-band (uncapped) once a downstream byte was written', async () => {
    // 客户端可见的带内失败帧**不封顶**：共享 1000 上限只作用于本仓自写的出口 JSON 与落库题干，
    // 不作用于带内透传的上游帧。这里用 5000 字符 message 证明整段到达客户端。
    // M2 之后这条路径要求「已写出过字节」（前置内容帧）——未写过字节时走 HTTP 层 502 出口，见下一条用例。
    const oversizedMessage = 'y'.repeat(5000);
    const oversizedFrame = `data: ${JSON.stringify({ error: { code: 'stream_initialization_failed', message: oversizedMessage, request_id: 'req_oversized' } })}\n\n`;
    streamSseUpstream(`${openAiPreContentFrame}${oversizedFrame}data: [DONE]\n\n`);

    const response = await injectChatStream();

    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'] || '')).toContain('text/event-stream');
    // 上游 payload 原文 + 本仓重建的 SSE 信封 + 上游自带的 `[DONE]`，逐字下发（不截断、不封顶）。
    expect(response.body.endsWith(`${oversizedFrame}data: [DONE]\n\n`)).toBe(true);
    expect(response.body).toContain(oversizedMessage);
    expect(response.body).not.toContain('...(truncated)');
    // 落库也不封顶到 1000（只过 64KB 守卫）：上游原文整段可见。
    expect(String(recordedFailure().errorText)).toContain(oversizedMessage);
  });

  it('delivers an in-band failure over the HTTP layer when no downstream byte was written yet', async () => {
    // M2（用户已定：混合）：带内失败帧到来时若**尚未写出任何下游字节**（`streamStarted=false`），
    // 不强行 hijack 写帧——只记失败，交给既有 HTTP 层失败出口用「状态码 + 上游原文」交付（codex 系
    // 据此自行退避重试，pi 也看得到原文）。客户端拿到的是 502 JSON，且 message 里保留上游原文；
    // 5000 字符走共享 1000 封顶，但尾部的 `code`/`request_id` 标识后缀必须留住（否则排障丢坐标）。
    config.proxyEmptyContentFailEnabled = true;
    const oversizedMessage = 'y'.repeat(5000);
    streamSseUpstream(`data: ${JSON.stringify({ error: { code: 'stream_initialization_failed', message: oversizedMessage, request_id: 'req_oversized' } })}\n\ndata: [DONE]\n\n`);

    const response = await injectChatStream();

    expect(response.statusCode).toBe(502);
    expect(String(response.headers['content-type'] || '')).not.toContain('text/event-stream');
    expect(response.json()?.error?.type).toBe('upstream_error');
    const message = String(response.json()?.error?.message ?? '');
    expect(message.length).toBeLessThanOrEqual(1000);
    expect(message).toContain('...(truncated)');
    expect(message.endsWith('(code=stream_initialization_failed, request_id=req_oversized)')).toBe(true);
    // 判失败（不再记 success），且落库保留未封顶的上游原文。
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(String(recordedFailure().errorText)).toContain(oversizedMessage);
  });

  it('gates the legacy failure frames the same way: 502 before any byte, normalized block afterwards', async () => {
    // R3-A：legacy 形（`type:"error"` / `response.failed`）此前**没有** M2 门禁——它用
    // `emitLines(..., { force: true })` 立即写出归一化块，即使一个字节都没写过也会把响应 hijack 成
    // 200 SSE；而 codex 系对 `finish_reason:"error"` 与优雅 EOF 都发 Completed ⇒ 客户端看到的是
    // 「正常结束但空」。现在 legacy 与 `new` 同门禁：未写字节 ⇒ 走既有 HTTP 层失败出口（502 + 上游原文）。
    // 语义边界：已写过字节时**维持原行为**（归一化块 + `force`），与既有 M3 用例 ② 锁的口径一致。
    config.proxyEmptyContentFailEnabled = true;

    // ① 未写字节：上游直接给 legacy 失败帧 ⇒ 客户端实收 502 JSON + 上游原文（不是 200 SSE 归一化块）。
    streamSseUpstream('data: {"type":"error","error":{"message":"boom","type":"upstream_error"}}\n\ndata: [DONE]\n\n');
    const httpLayerResponse = await injectChatStream();
    expect(httpLayerResponse.statusCode).toBe(502);
    expect(String(httpLayerResponse.headers['content-type'] || '')).not.toContain('text/event-stream');
    expect(httpLayerResponse.json()?.error?.type).toBe('upstream_error');
    expect(String(httpLayerResponse.json()?.error?.message)).toContain('boom');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(String(recordedFailure().errorText)).toBe('boom');

    // ② 已写字节：归一化块照旧（`finish_reason:"error"`），本轮门禁不改变这一半。
    recordFailureMock.mockClear();
    recordSuccessMock.mockClear();
    streamSseUpstream(`${openAiPreContentFrame}data: {"type":"error","error":{"message":"boom","type":"upstream_error"}}\n\ndata: [DONE]\n\n`);
    const inBandResponse = await injectChatStream();
    expect(inBandResponse.statusCode).toBe(200);
    expect(String(inBandResponse.headers['content-type'] || '')).toContain('text/event-stream');
    expect(inBandResponse.body).toContain('"object":"chat.completion.chunk"');
    expect(inBandResponse.body).toContain('"finish_reason":"error"');
    expect(inBandResponse.body).not.toContain('Upstream stream interrupted');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(String(recordedFailure().errorText)).toBe('boom');
  });

  it('never fabricates a terminal frame on a terminally failed stream (no [DONE] the upstream did not send)', async () => {
    // M3（用户已定：统一不补）：失败终态下本仓**不再生成**终结帧。上游没带 `data: [DONE]` 时客户端
    // 就看不到任何终结帧（只看到失败信号）；上游带了则原样透传（见上面 429 用例）。两种形都不再出现
    // 「本仓补的 [DONE] 把失败包装成正常收尾」。
    config.proxyEmptyContentFailEnabled = true;

    // ① 新形（顶层带 `error` 对象的 `stream_error` 帧）。
    streamSseUpstream(`${openAiPreContentFrame}data: ${JSON.stringify({ error: { code: 'stream_initialization_failed', message: 'rate limited: Retry after 29s.' }, type: 'stream_error' })}\n\n`);
    const newShaped = await injectChatStream();
    expect(newShaped.statusCode).toBe(200);
    expect(newShaped.body).not.toContain('[DONE]');
    expect(newShaped.body).toContain('Retry after 29s.');

    // ② legacy 形（`type:"error"`）——M3 一并改变它的行为：同样不再补 `[DONE]`（既有用例
    //    `keeps the existing failure judgments` 仍锁住它的归一化/序列化路径不变——R3-A 后那条
    //    带前置内容帧，即「已写过字节」的形）。
    recordFailureMock.mockClear();
    recordSuccessMock.mockClear();
    streamSseUpstream(`${openAiPreContentFrame}data: {"type":"error","error":{"message":"boom","type":"upstream_error"}}\n\n`);
    const legacyShaped = await injectChatStream();
    expect(legacyShaped.statusCode).toBe(200);
    expect(legacyShaped.body).toContain('"finish_reason":"error"');
    expect(legacyShaped.body).not.toContain('[DONE]');
  });

  it('claude downstream: an in-band stream_error frame produces exactly one error frame (no synthesized second one)', async () => {
    // S1 + M1：claude 下游 + 上游 `{"error":{…},"type":"stream_error"}` 帧（已写出过字节）。
    // 旧行为：上游原文帧之后，收尾的补帧门禁又补了一帧自写的
    // `Upstream stream interrupted before a terminal event`（claude 分支从不置 `doneSent`）⇒ 双错误帧。
    config.proxyEmptyContentFailEnabled = true;
    const upstreamMessage = 'Rate limit exceeded: Retry after 29s.';
    const requestId = 'req_claude_stream_error';
    streamSseUpstream(`data: hello\n\ndata: ${JSON.stringify({ error: { code: 'stream_initialization_failed', message: upstreamMessage, request_id: requestId }, type: 'stream_error' })}\n\ndata: [DONE]\n\n`);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    // 错误帧恰好一帧；含上游原文与 code/request_id；不得出现自写的断流补帧，也不得补 `message_stop`。
    expect(response.statusCode).toBe(200);
    expect(response.body.split('event: error').length - 1).toBe(1);
    expect(response.body).toContain(upstreamMessage);
    expect(response.body).toContain('code=stream_initialization_failed');
    expect(response.body).toContain(`request_id=${requestId}`);
    expect(response.body).not.toContain('Upstream stream interrupted');
    expect(response.body).not.toContain('message_stop');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(String(recordedFailure().errorText)).toContain(upstreamMessage);
    expect(String(recordedFailure().errorText)).toContain(`request_id=${requestId}`);
  });

  it('rebuilds a multi-line data failure frame as valid SSE (every line keeps its data: prefix)', async () => {
    // S2：上游把 JSON 拆到多行 `data:`（`data: {...` / `data: ...}`）时，重建帧的**每一行**都要带
    // `data: ` 前缀，否则第二行起会变成非法 SSE 字段行（客户端解不出来）；与
    // `anthropic/messages/streamBridge.ts` 的 `serializeAnthropicRawSseEvent` 同口径。
    config.proxyEmptyContentFailEnabled = true;
    const firstHalf = '{"error":{"code":"stream_initialization_failed",';
    const secondHalf = '"message":"Rate limit exceeded: Retry after 29s.","request_id":"req_multiline"},"type":"stream_error"}';
    streamSseUpstream(`${openAiPreContentFrame}data: ${firstHalf}\ndata: ${secondHalf}\n\ndata: [DONE]\n\n`);

    const response = await injectChatStream();

    const expectedFrame = `data: ${firstHalf}\ndata: ${secondHalf}\n\n`;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(expectedFrame);
    expect(expectedFrame.trimEnd().split('\n').every((line) => line.startsWith('data: '))).toBe(true);
    // 多行帧同样被判为失败、且失败原因取上游原文（含 code/request_id 后缀）。
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(String(recordedFailure().errorText)).toContain('Rate limit exceeded: Retry after 29s.');
    expect(String(recordedFailure().errorText)).toContain('code=stream_initialization_failed');
  });

  it('writes an in-band openai error frame (and never [DONE]) when the upstream body breaks mid-stream', async () => {
    // #6 客户端可见失败语义（②）：响应头已到、body 中途 `terminated`。SSE 已 `reply.hijack()`，
    // 拿不到任何 HTTP 状态码，唯一能告知客户端「这轮失败」的通道就是流内错误帧；
    // 且**不得**补 `data: [DONE]`（那会把错误当正常收尾吞掉）。
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-break","choices":[{"delta":{"content":"partial"}}]}\n\n'));
      },
      pull(controller) {
        // 首块被消费后才拉第二次 ⇒ 首帧可达下游（streamStarted 变 true），随后断流。
        controller.error(new Error('terminated'));
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

    // 已 hijack：状态码停留在 200（不可能再改），失败语义只能落在一帧错误上。
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'] || '')).toContain('text/event-stream');
    expect(response.body).toContain(
      'data: {"error":{"message":"terminated","type":"upstream_error","code":502}}',
    );
    // 绝不追加正常结束标记。
    expect(response.body).not.toContain('[DONE]');
  });

  it('writes exactly one in-band openai error frame (and no [DONE]/response.completed) when a hijacked /v1/responses stream breaks mid-flight', async () => {
    // #6 客户端可见失败语义（②）responses 面：响应头已到（`reply.hijack()` 已发生）、上游 body 中途
    // 断流。已 hijack ⇒ 不可能再改 HTTP 状态码，也不可能 `reply.code(502).send(...)`
    // （Fastify 5 对已 hijack 的回复只 `log.warn(FST_ERR_REP_ALREADY_SENT)` 然后**丢弃**：客户端
    // 一个失败信号都拿不到）；失败只能落在一帧流内错误上。
    // 断言四项：① 有且只有**一帧**错误帧；② 不补 `[DONE]`；③ 不误发 `response.completed`；
    // ④ 没退化成 JSON 失败体（那个出口在 hijack 后写不进去，只会被静默丢弃）。
    // 这里把重试钉成 1 次尝试，不留第二轮 hijack 的噪声。
    const previousAttempts = (config as any).proxyMaxChannelAttempts;
    (config as any).proxyMaxChannelAttempts = 1;
    try {
      fetchModelPricingCatalogMock.mockResolvedValue({
        models: [
          {
            modelName: 'upstream-gpt',
            supportedEndpointTypes: ['/v1/chat/completions'],
          },
        ],
        groupRatio: {},
      });

      // —— 场景：先写出一帧（流已 hijack），随后上游 body 中断、且没有终结帧。
      // 流生命周期收尾（`streamSink.end()`）负责补这一帧；surface 终态出口也会尝试写，靠
      // `writableEnded` 门禁去重 ⇒ 客户端只收到一帧。
      const encoder = new TextEncoder();
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"chatcmpl-r-break","model":"upstream-gpt","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
        },
        pull(controller) {
          // 首块被消费后才拉第二次 ⇒ 首帧可达下游，随后断流。
          controller.error(new Error('terminated'));
        },
      });

      fetchMock.mockResolvedValue(new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: {
          model: 'gpt-5.2',
          input: 'hello',
          stream: true,
        },
      });

      // 已 hijack：状态码停在 200，失败语义只能落在流内。
      expect(response.statusCode).toBe(200);
      expect(String(response.headers['content-type'] || '')).toContain('text/event-stream');
      // 一帧错误、且只有一帧（生命周期出口与终态出口都尝试过写，去重后只剩这一帧）。
      expect(response.body.split('"type":"upstream_error"').length - 1).toBe(1);
      expect(response.body).toContain(
        'data: {"error":{"message":"Upstream stream interrupted before a terminal event","type":"upstream_error","code":502}}',
      );
      // 断流**不得**被写成正常收尾：既不补 `[DONE]`，也不误发 `response.completed`。
      expect(response.body).not.toContain('[DONE]');
      expect(response.body).not.toContain('response.completed');
      // 失败没有退化成 JSON 出口（那个出口在 hijack 后写不进去，会被静默丢弃）。
      expect(response.body).not.toContain('"type":"server_error"');

      // O8（responses 面）：本行由外层 catch 的 `handleExecutionError` 出口写。改前 `firstByteLatencyMs`
      // 声明在 `try` 内 ⇒ catch 作用域取不到 ⇒ 本行 `first_byte_latency_ms` 恒 NULL；提升到 handler
      // 作用域并按轮重置后，必须落本轮观测到的真实首字节延迟。
      const breakRow = lastProxyLogValues();
      // `client_http_status` 在本夹具被 `hasProxyLogClientHttpStatusColumn() => false` 整列丢弃，故不断言它。
      expect(breakRow).toMatchObject({
        status: 'failed',
        httpStatus: 0,
        isStream: true,
      });
      expect(breakRow?.firstByteLatencyMs).toEqual(expect.any(Number));

    } finally {
      (config as any).proxyMaxChannelAttempts = previousAttempts;
    }
  });

  it('records is_stream / first_byte_latency_ms on the chat stream failure exits', async () => {
    // O-d：这三处非抛异类流式失败出口（① SSE reader 出口，②「看起来像 responses SSE 的单块」出口，
    // ③ `consumeUpstreamFinalPayload` 出口）此前都没传 `is_stream` / `first_byte_latency_ms` ⇒ 观测列恒 NULL。
    // 出口由夹具的 upstream content-type 决定（SSE ⇒ reader 出口；非 SSE 文本/JSON ⇒ 另两处）。
    // 三处取值先收集、最后一次性断言——这样一跑就能看到三处各自的取值，不被首个断言短路。
    config.proxyEmptyContentFailEnabled = true;
    const observed: Array<{ exit: string; isStream: unknown; firstByteLatencyMs: unknown }> = [];
    const captureObserved = (exit: string) => {
      const row = lastProxyLogValues();
      // 三个出口都写终态失败行；`errorMessage` 由调用方断言以对应到各夹具。
      expect(row?.status).toBe('failed');
      observed.push({ exit, isStream: row?.isStream, firstByteLatencyMs: row?.firstByteLatencyMs });
      return row;
    };

    // ① SSE content-type + 空内容 ⇒ `streamSession.run` 返回 failed（不抛异常）。
    streamSseUpstream('data: {"id":"chatcmpl-empty","choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n');
    const sseResponse = await injectChatStream();
    expect(sseResponse.statusCode).toBe(502);
    expect(String(captureObserved('sse-reader')?.errorMessage)).toContain('empty content');

    // ② content-type 非 SSE，正文是「看起来像 responses SSE」的带内失败帧 ⇒ 单块流出口。
    proxyLogValuesMock.mockClear();
    fetchMock.mockResolvedValue(new Response(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom-single-chunk"}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    ));
    await injectChatStream();
    expect(String(captureObserved('non-sse-single-chunk')?.errorMessage)).toContain('boom-single-chunk');

    // ③ content-type 非 SSE、正文是 JSON：带可见正文但被判为带内失败 ⇒ `consumeUpstreamFinalPayload` 出口。
    proxyLogValuesMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-inband-json',
      type: 'stream_error',
      message: 'boom-final-payload',
      choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await injectChatStream();
    expect(String(captureObserved('non-sse-final-payload')?.errorMessage)).toContain('boom-final-payload');

    // O-d 判据：三处都必须是「真实流式取值 true」（取自请求解析结果，非硬编码）+「真实首字节延迟」。
    expect(observed).toEqual([
      { exit: 'sse-reader', isStream: true, firstByteLatencyMs: expect.any(Number) },
      { exit: 'non-sse-single-chunk', isStream: true, firstByteLatencyMs: expect.any(Number) },
      { exit: 'non-sse-final-payload', isStream: true, firstByteLatencyMs: expect.any(Number) },
    ]);
  });

  it('records is_stream / first_byte_latency_ms on the responses stream failure exits', async () => {
    // O-d：responses 面与 chat 面对称的三处非抛异类流式失败出口（reader / 单块 / final payload）。
    config.proxyEmptyContentFailEnabled = true;
    const observed: Array<{ exit: string; isStream: unknown; firstByteLatencyMs: unknown }> = [];
    const captureObserved = (exit: string) => {
      const row = lastProxyLogValues();
      expect(row?.status).toBe('failed');
      observed.push({ exit, isStream: row?.isStream, firstByteLatencyMs: row?.firstByteLatencyMs });
      return row;
    };
    const injectResponsesStream = () => app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-5.2', input: 'hello', stream: true },
    });

    // ① SSE content-type + 空内容 ⇒ `streamSession.run` 返回 failed。
    fetchMock.mockResolvedValue(new Response(
      'data: {"type":"response.completed","response":{"id":"resp-empty","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    ));
    await injectResponsesStream();
    expect(String(captureObserved('sse-reader')?.errorMessage)).toContain('empty content');

    // ② content-type 非 SSE，正文是「看起来像 responses SSE」的带内失败帧 ⇒ 单块流出口。
    proxyLogValuesMock.mockClear();
    fetchMock.mockResolvedValue(new Response(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom-single-chunk"}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    ));
    await injectResponsesStream();
    expect(String(captureObserved('non-sse-single-chunk')?.errorMessage)).toContain('boom-single-chunk');

    // ③ content-type 非 SSE、正文是 responses JSON：有可见输出、但 `type=response.failed` ⇒ final payload 出口。
    proxyLogValuesMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-inband-json',
      object: 'response',
      type: 'response.failed',
      output_text: 'partial',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
      error: { message: 'boom-final-payload' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await injectResponsesStream();
    expect(String(captureObserved('non-sse-final-payload')?.errorMessage)).toContain('boom-final-payload');

    expect(observed).toEqual([
      { exit: 'sse-reader', isStream: true, firstByteLatencyMs: expect.any(Number) },
      { exit: 'non-sse-single-chunk', isStream: true, firstByteLatencyMs: expect.any(Number) },
      { exit: 'non-sse-final-payload', isStream: true, firstByteLatencyMs: expect.any(Number) },
    ]);
  });

  // —— 上游「带内错误帧」（HTTP 200 + `text/event-stream`）的识别与原样透传 ——
  // 帧形来自真实抓取（Cline/Vercel 网关把 provider 429 包成 200 + SSE），此处只内联帧形与关键文案，
  // 不复制原始样本文件。
  const clineRequestId = 'jKvTekvqyRNgEmhOeUgEcZtJcwNJqEpo';
  const clineInBandFailureFrame = JSON.stringify({
    error: {
      code: 'stream_initialization_failed',
      message: `Failed to create stream: inference request failed: failed to generate stream from Vercel: failed to invoke model 'deepseek/deepseek-v4.1-flash' with streaming: request failed with status 429: ${JSON.stringify({
        error: {
          message: "Rate limit exceeded for deepseek/deepseek-v4.1-flash: this team's limit of 100000000 input tokens per minute (per region) was reached. Retry after 29s.",
          type: 'rate_limit_exceeded',
        },
      })}`,
      request_id: clineRequestId,
    },
    request_id: clineRequestId,
    type: 'stream_error',
  });
  const clineInBandFailureSse = `data: ${clineInBandFailureFrame}\n\ndata: [DONE]\n\n`;

  // 「已向下游写出过字节」的前置内容帧：M2 之后，带内失败帧只有在这种「已写过字节」的流里才走带内
  // 透传；未写过字节会走 HTTP 层 502 出口（见下两条用例）。
  const openAiPreContentFrame = 'data: {"id":"chatcmpl-pre","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"pre"},"finish_reason":null}]}\n\n';

  function streamSseUpstream(sse: string) {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));
  }

  function injectChatStream() {
    return app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
  }

  function recordedFailure(callIndex = 0): any {
    return (recordFailureMock.mock.calls[callIndex] as any[])[1];
  }

  it('recognizes an upstream in-band 429 error frame and forwards it to the client verbatim', async () => {
    // 上游 provider 429 被网关包成 HTTP 200 + `text/event-stream`，失败只写在流内错误帧里。
    // 旧行为：带内失败判据只认顶层 `type` 为 response.failed/error ⇒ 该帧归一化无匹配、序列化为空 ⇒
    // 文本被静默丢弃、不日志不计数不下发 ⇒ 空内容兜底把失败改写成自写的
    // `Upstream returned empty content`（502 JSON），上游字节永不可得。
    // 新行为：认出该帧（走既有 `markFailed`），并在**已写出过字节**时把「上游 payload 原文 + 本仓
    // 重建的 SSE 信封」写回客户端（M2）。
    config.proxyEmptyContentFailEnabled = true;
    streamSseUpstream(`${openAiPreContentFrame}${clineInBandFailureSse}`);

    const response = await injectChatStream();

    // ① 判为失败而不再记 success；落库原因用上游原文（含 429 文案 / type / code / request_id）。
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(String(recordedFailure().errorText)).toContain('Rate limit exceeded for deepseek/deepseek-v4.1-flash');
    expect(String(recordedFailure().errorText)).toContain('Retry after 29s.');
    expect(String(recordedFailure().errorText)).toContain('rate_limit_exceeded');
    expect(String(recordedFailure().errorText)).toContain('code=stream_initialization_failed');
    expect(String(recordedFailure().errorText)).toContain(`request_id=${clineRequestId}`);
    expect(String(recordedFailure().errorText)).not.toContain('Upstream returned empty content');

    // ② 客户端可见的带内错误帧带上游 429 文案与 request_id：已写出过字节 ⇒ 带内透传，从内容帧之后
    //    逐字等于上游帧序列（含上游自己带的 `[DONE]`，M3：本仓不再自行补终结帧）。
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'] || '')).toContain('text/event-stream');
    expect(response.body.endsWith(clineInBandFailureSse)).toBe(true);
    expect(response.body).toContain('Retry after 29s.');
    expect(response.body).toContain(clineRequestId);
    // 内容帧先于错误帧（不是把已写出的内容丢掉）。
    expect(response.body.indexOf('"content":"pre"')).toBeLessThan(response.body.indexOf('stream_initialization_failed'));

    // ③ 不重复写终结帧：`[DONE]` 恰好一帧（上游自带那一个），且没有另外补合成的 finish_reason 帧。
    expect(response.body.split('data: [DONE]').length - 1).toBe(1);
    expect(response.body).not.toContain('"finish_reason":"stop"');
    expect(response.body).not.toContain('Upstream returned empty content');
  });

  it('recognizes an SSE event: error frame as an in-band failure and forwards it verbatim', async () => {
    // 带 `event: error` 帧名、正文非 JSON 的形（旧判据只看载荷 `type`，帧名完全没看）——已写出过字节 ⇒
    // 带内透传（未写出字节的形见 `delivers an in-band failure over the HTTP layer …`）。
    config.proxyEmptyContentFailEnabled = true;
    const upstreamSse = 'event: error\ndata: rate limited: Retry after 29s.\n\ndata: [DONE]\n\n';
    streamSseUpstream(`${openAiPreContentFrame}${upstreamSse}`);

    const response = await injectChatStream();

    expect(response.statusCode).toBe(200);
    // 从错误帧起逐字等于上游帧序列（含上游自带的 `[DONE]`；M3：本仓不再补终结帧）。
    expect(response.body.endsWith(upstreamSse)).toBe(true);
    // 失败原因用上游原文（帧名之外的正文），不再落成自写的空内容文案，也不再被 502 JSON 出口吞掉。
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(String(recordedFailure().errorText)).toBe('rate limited: Retry after 29s.');
    // 这轮已交付过带内失败信号（M1）且有 `[DONE]` 终结帧，所以不应再叠加断流补帧。
    expect(response.body).not.toContain('Upstream stream interrupted');
    expect(response.body.split('data: [DONE]').length - 1).toBe(1);
  });

  it('keeps the existing failure judgments: {type:"error"} frames and pure empty content', async () => {
    // ④ 不回归（两个既有判定）：
    // ① 既有 `{type:"error"}` 帧仍走原归一化 / 序列化路径：客户端拿 `finish_reason:"error"` 的
    //    chat.completion.chunk（不是上游帧原文），失败原因仍是上游 `error.message`。
    //    R3-A 后这一半必须带上「已写过字节」的前置内容帧：未写过字节的 legacy 帧现在走 HTTP 层 502
    //    （见 `gates the legacy failure frames the same way …`），那是新增门禁、不是判据被吃掉。
    // ② 纯空内容（没有任何失败帧）仍由既有空内容判定兜底：502 + 既有文案（既有用例
    //    `keeps the streamed failure 502 message within the shared upstream error cap` 锁的是同一不变量）。
    config.proxyEmptyContentFailEnabled = true;

    streamSseUpstream(`${openAiPreContentFrame}data: {"type":"error","error":{"message":"boom","type":"upstream_error"}}\n\ndata: [DONE]\n\n`);
    const errorFrameResponse = await injectChatStream();
    expect(errorFrameResponse.statusCode).toBe(200);
    expect(errorFrameResponse.body).toContain('"object":"chat.completion.chunk"');
    expect(errorFrameResponse.body).toContain('"delta":{}');
    expect(errorFrameResponse.body).toContain('"finish_reason":"error"');
    expect(errorFrameResponse.body.split('data: [DONE]').length - 1).toBe(1);
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(String(recordedFailure().errorText)).toBe('boom');

    recordFailureMock.mockClear();
    recordSuccessMock.mockClear();
    streamSseUpstream('data: {"id":"chatcmpl-empty","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const emptyResponse = await injectChatStream();
    expect(emptyResponse.statusCode).toBe(502);
    expect(String(emptyResponse.headers['content-type'] || '')).not.toContain('text/event-stream');
    expect(String(emptyResponse.json()?.error?.message)).toContain('empty content');
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it('claude downstream: recognizes an SSE event: error frame as a failure while still forwarding it verbatim', async () => {
    // claude 下游 + 上游 Anthropic 原始 `event: error` 帧：本仓 anthropic 转换器本来就把它当标准原始
    // 事件原样转发（客户端看到错误），但既不记失败也不留原文；本片只补既有的 `markFailed` 语义，
    // 不改任何已写出的字节。
    config.proxyEmptyContentFailEnabled = true;
    const upstreamErrorFrame = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    streamSseUpstream(`${upstreamErrorFrame}data: [DONE]\n\n`);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    // 上游帧仍逐字节原样转发；失败原因取上游原文（不再是「记成成功」）。
    expect(response.body).toContain(upstreamErrorFrame.trimEnd());
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(String(recordedFailure().errorText)).toBe('Overloaded');
    // 错误帧后不得追加终结帧（claude 的 `message_stop`）。
    expect(response.body).not.toContain('message_stop');
  });

  it('reports has_content=true for the real text carriers (streaming delta.content / full-body message.content)', async () => {
    // 诊断字段 `has_content` 原来只看 `payload.content` / `choices[].content`，而 chat 协议里文本的真实载体是
    // `choices[].delta.content`（流式 chunk）与 `choices[].message.content`（完整 body）⇒ 两种真实形下恒假，
    // 排障时会把「上游明明给了内容」误读成「上游没给内容」。这里用带日志流的 app 捕获诊断行，锁住修后的取值。
    const logLines: string[] = [];
    const loggingApp = Fastify({
      logger: {
        level: 'info',
        stream: { write: (chunk: string) => { logLines.push(chunk); } },
      },
    });
    const { chatProxyRoute } = await import('./chat.js');
    await loggingApp.register(chatProxyRoute);
    try {
      // 流式：文本在 `choices[].delta.content`。
      streamSseUpstream('data: {"id":"chatcmpl-log","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-log","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');
      const streamResponse = await loggingApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(streamResponse.statusCode, streamResponse.body).toBe(200);
      const streamDiagnostics = logLines.filter((line) => line.includes('chat/upstream-stream-event'));
      expect(streamDiagnostics.length).toBeGreaterThan(0);
      expect(streamDiagnostics.some((line) => line.includes('"has_content":true'))).toBe(true);

      // 非流式：文本在 `choices[].message.content`。
      logLines.length = 0;
      fetchMock.mockResolvedValue(new Response(JSON.stringify({
        id: 'chatcmpl-log-json',
        object: 'chat.completion',
        model: 'upstream-gpt',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'hello from body' },
          finish_reason: 'stop',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      const jsonResponse = await loggingApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(jsonResponse.statusCode, jsonResponse.body).toBe(200);
      const finalDiagnostics = logLines.filter((line) => line.includes('chat/upstream-final'));
      expect(finalDiagnostics.length).toBeGreaterThan(0);
      expect(finalDiagnostics.some((line) => line.includes('"has_content":true'))).toBe(true);
    } finally {
      await loggingApp.close();
    }
  });

  // —— O8：外层 catch 失败出口的 `first_byte_latency_ms`（改前因变量声明在 `try` 内而恒 NULL）——
  // 两个外层出口：`handleExecutionError`（中途断流 / 执行类异常）与 `handleUpstreamFailure`（上游非 2xx）。
  // 取值口径：= 本轮上游响应观测到的首字节延迟（`getObservedResponseMeta`）；本轮未观测到 ⇒ NULL。
  const proxyLogRowsInOrder = (): Array<Record<string, any>> => proxyLogValuesMock.mock.calls
    .map((call) => call[0])
    .filter((values): values is Record<string, any> => (
      !!values && typeof values === 'object' && 'httpStatus' in values && 'retryCount' in values
    ));

  it('records a real first_byte_latency_ms on the chat outer-catch exit when the upstream body breaks mid-stream', async () => {
    // O8：SSE body 中途 `terminated`（`reader.read()` 抛）⇒ 异常从 `try` 冒泡到外层 catch →
    // `handleExecutionError` 出口。重试钉成 1 次尝试，保证只写一行、不被后续轮次干扰。
    const previousAttempts = (config as any).proxyMaxChannelAttempts;
    (config as any).proxyMaxChannelAttempts = 1;
    try {
      const encoder = new TextEncoder();
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"chatcmpl-o8-break","choices":[{"delta":{"content":"partial"}}]}\n\n'));
        },
        pull(controller) {
          // 首块被消费后才拉第二次 ⇒ 首帧可达下游（首字节已观测），随后断流。
          controller.error(new Error('terminated'));
        },
      });
      fetchMock.mockResolvedValue(new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));

      const response = await injectChatStream();
      // 已 hijack：状态码停在 200，失败语义落在流内错误帧（本条只关心落库观测列的取值）。
      expect(response.statusCode).toBe(200);

      const rows = proxyLogRowsInOrder();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', isStream: true });
      expect(rows[0].firstByteLatencyMs).toEqual(expect.any(Number));
      expect(rows[0].firstByteLatencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      (config as any).proxyMaxChannelAttempts = previousAttempts;
    }
  });

  it('records a real first_byte_latency_ms on the chat outer-catch exit when the upstream throws (HTTP 429)', async () => {
    // O8：上游非 2xx（429）⇒ `executeEndpointFlow` 回流 `ok: false` ⇒ 站内 API 端点池回调抛
    // `SiteApiEndpointRequestError` ⇒ 外层 catch 的 `handleUpstreamFailure` 出口。
    // 该出口的取值来源是本轮**失败尝试**的上游响应（`onAttemptFailure` 钩子里的 `getObservedResponseMeta`）：
    // 429 响应已到达且 body 已读到 ⇒ 真实首字节延迟可得。
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'rate limited', type: 'rate_limit_exceeded' },
    }), { status: 429, headers: { 'content-type': 'application/json; charset=utf-8' } }));

    const response = await injectChatStream();
    // 对外语义不变：客户端实收 429（`shouldRetryProxyRequest` 在本夹具里不触发重试）。
    expect(response.statusCode).toBe(429);

    const rows = proxyLogRowsInOrder();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', httpStatus: 429 });
    expect(rows[0].firstByteLatencyMs).toEqual(expect.any(Number));
    expect(rows[0].firstByteLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('resets first_byte_latency_ms per retry iteration when a later attempt observes no first byte', async () => {
    // O8 的主要风险（两审点名）：把变量提升到重试循环之外后，上一轮观测到的值不能漏到下一轮。
    // 夹具：第 1 轮上游已回 200 且首块到达（观测到真实延迟）→ SSE body 中途断 → 外层 catch
    // （`handleExecutionError`）写行并继续重试；第 2 轮上游根本没回（网络类失败，`endpointFlow`
    // 合成的 502 无 meta）⇒ 第 2 轮该行必须落 NULL，不得沿用第 1 轮的值。
    // 注：非流式 body 断流不会走这里（`readRuntimeResponseText` 把读取异常吞成空串），必须用流式夹具。
    const previousAttempts = (config as any).proxyMaxChannelAttempts;
    const previousFallback = (config as any).disableCrossProtocolFallback;
    (config as any).proxyMaxChannelAttempts = 2;
    // 单端点：避免本轮 502 在每个非末端点各写一条降级行（那是既有行为，与本用例无关），
    // 使每一轮重试恰好只留一条终态失败行。
    (config as any).disableCrossProtocolFallback = true;
    try {
      // 第 2 轮要真选到通道才会再次打上游（`retryCount > 0` 走 `selectNextChannel`）。
      selectNextChannelMock.mockReturnValue({
        channel: { id: 12, routeId: 22 },
        site: { name: 'demo-site', url: 'https://upstream.example.com' },
        account: { id: 33, username: 'demo-user' },
        tokenName: 'default',
        tokenValue: 'sk-demo',
        actualModel: 'upstream-gpt',
      });

      const encoder = new TextEncoder();
      const firstAttemptBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"chatcmpl-o8-retry","choices":[{"delta":{"content":"partial"}}]}\n\n'));
        },
        pull(controller) {
          controller.error(new Error('terminated'));
        },
      });
      fetchMock
        .mockResolvedValueOnce(new Response(firstAttemptBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }))
        .mockRejectedValueOnce(new Error('ECONNRESET'));

      // 第 1 轮已 hijack（流已写出首帧）⇒ 不再断言 HTTP 状态码（那是本片不动的既有语义），
      // 只断言两条落库行的观测列。
      await injectChatStream();

      const rows = proxyLogRowsInOrder();
      expect(rows).toHaveLength(2);
      // 第 1 轮：`handleExecutionError` 出口，已观测到首字节 ⇒ 真实值。
      expect(rows[0]).toMatchObject({ status: 'failed', httpStatus: 0, isStream: true });
      expect(rows[0].firstByteLatencyMs).toEqual(expect.any(Number));
      // 第 2 轮：`handleUpstreamFailure` 出口（合成 502），本轮未观测到任何首字节 ⇒ 必须 NULL。
      expect(rows[1]).toMatchObject({ status: 'failed', httpStatus: 502, isStream: true });
      expect(rows[1].firstByteLatencyMs).toBeNull();
    } finally {
      (config as any).proxyMaxChannelAttempts = previousAttempts;
      (config as any).disableCrossProtocolFallback = previousFallback;
    }
  });

  it('records a real first_byte_latency_ms on the responses outer-catch exit when the upstream throws (HTTP 429)', async () => {
    // O8（responses 面）：与 chat 面同形的 `handleUpstreamFailure` 出口。
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'rate limited', type: 'rate_limit_exceeded' },
    }), { status: 429, headers: { 'content-type': 'application/json; charset=utf-8' } }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-5.2', input: 'hello' },
    });
    expect(response.statusCode).toBe(429);

    const rows = proxyLogRowsInOrder();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', httpStatus: 429 });
    expect(rows[0].firstByteLatencyMs).toEqual(expect.any(Number));
  });

  // —— O8 R4（P1/P3）：租约忙 & 站点并发超时出口的观测列 ——
  it('records the real is_stream value on the responses channel-busy failure row', async () => {
    // O8 R4（P1）：responses 面的租约忙出口此前未传 `is_stream`（该列恒 NULL）。
    // 本用例用**流式**请求：实现若写死成 `false` 会在此拆穿。
    const previousAttempts = (config as any).proxyMaxChannelAttempts;
    (config as any).proxyMaxChannelAttempts = 1;
    const acquireLeaseSpy = vi.spyOn(proxyChannelCoordinator, 'acquireChannelLease')
      .mockResolvedValue({ status: 'timeout', waitMs: 700 } as any);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: { model: 'gpt-5.2', input: 'hello', stream: true },
      });

      // 对外语义不变：租约忙 + 无重试轮次 ⇒ 客户端仍是 503。
      expect(response.statusCode).toBe(503);
      const rows = proxyLogRowsInOrder();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', httpStatus: 503 });
      expect(rows[0].isStream).toBe(true);
      // 有意 NULL：本出口从未触达上游。
      expect(rows[0].firstByteLatencyMs).toBeNull();
    } finally {
      acquireLeaseSpy.mockRestore();
      (config as any).proxyMaxChannelAttempts = previousAttempts;
    }
  });

  it('records the real client_http_status and an explicit first_byte_latency_ms on the chat site-concurrency-timeout row', async () => {
    // O8 R4（P1/P3）：chat 面「站点并发超时」出口此前既没传 `client_http_status`（该列恒 NULL），
    // 也没传 `first_byte_latency_ms`。
    // `first_byte_latency_ms` 在本出口**结构上恒 null**（轮首重置 + 站点租约超时先于任何上游尝试，
    // 不可能有首字节观测），而落库侧会对 null 做 `?? null` 归一 ⇒ 「没传」与「传了 null」落库后一模一样。
    // 故除断言落库取值外，另用工厂壳子捕获 surface 传给 toolkit 的**原始入参**，锁住「确实显式传了该键」。
    const poolSpy = vi.spyOn(siteApiEndpointService, 'runWithSiteApiEndpointPool')
      .mockRejectedValue(Object.assign(
        new siteApiEndpointService.SiteApiEndpointRequestError('site concurrency slot timeout', { status: 503 }),
        { siteConcurrencyTimeout: true },
      ));
    const toolkitLogArgs: Array<Record<string, any>> = [];
    const toolkitSpy = vi.spyOn(sharedSurfaceModule, 'createSurfaceFailureToolkit')
      .mockImplementation(((input: any) => {
        const real = realCreateSurfaceFailureToolkit(input);
        return {
          ...real,
          log: async (args: Record<string, any>) => {
            toolkitLogArgs.push(args);
            return await real.log(args);
          },
        };
      }) as any);
    const previousAttempts = (config as any).proxyMaxChannelAttempts;
    (config as any).proxyMaxChannelAttempts = 1;
    try {
      const response = await injectChatStream();

      expect(response.statusCode).toBe(503);
      const rows = proxyLogRowsInOrder();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', httpStatus: 503, clientHttpStatus: 503, isStream: true });

      expect(toolkitLogArgs).toHaveLength(1);
      expect(Object.keys(toolkitLogArgs[0])).toContain('clientHttpStatus');
      expect(Object.keys(toolkitLogArgs[0])).toContain('firstByteLatencyMs');
      expect(toolkitLogArgs[0].firstByteLatencyMs).toBeNull();
    } finally {
      toolkitSpy.mockRestore();
      poolSpy.mockRestore();
      (config as any).proxyMaxChannelAttempts = previousAttempts;
    }
  });

  it('records the real client_http_status and an explicit first_byte_latency_ms on the responses site-concurrency-timeout row', async () => {
    // O8 R4（P1/P3）：responses 面同形出口（与 chat 面同口径）。
    const poolSpy = vi.spyOn(siteApiEndpointService, 'runWithSiteApiEndpointPool')
      .mockRejectedValue(Object.assign(
        new siteApiEndpointService.SiteApiEndpointRequestError('site concurrency slot timeout', { status: 503 }),
        { siteConcurrencyTimeout: true },
      ));
    const toolkitLogArgs: Array<Record<string, any>> = [];
    const toolkitSpy = vi.spyOn(sharedSurfaceModule, 'createSurfaceFailureToolkit')
      .mockImplementation(((input: any) => {
        const real = realCreateSurfaceFailureToolkit(input);
        return {
          ...real,
          log: async (args: Record<string, any>) => {
            toolkitLogArgs.push(args);
            return await real.log(args);
          },
        };
      }) as any);
    const previousAttempts = (config as any).proxyMaxChannelAttempts;
    (config as any).proxyMaxChannelAttempts = 1;
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: { model: 'gpt-5.2', input: 'hello', stream: true },
      });

      expect(response.statusCode).toBe(503);
      const rows = proxyLogRowsInOrder();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', httpStatus: 503, clientHttpStatus: 503, isStream: true });

      expect(toolkitLogArgs).toHaveLength(1);
      expect(Object.keys(toolkitLogArgs[0])).toContain('clientHttpStatus');
      expect(Object.keys(toolkitLogArgs[0])).toContain('firstByteLatencyMs');
      expect(toolkitLogArgs[0].firstByteLatencyMs).toBeNull();
    } finally {
      toolkitSpy.mockRestore();
      poolSpy.mockRestore();
      (config as any).proxyMaxChannelAttempts = previousAttempts;
    }
  });
});
