import { describe, expect, it } from 'vitest';
import { shouldAbortSameSiteEndpointFallback, shouldRetryProxyRequest } from './proxyRetryPolicy.js';

describe('proxyRetryPolicy', () => {
  it('retries on rate limit and server errors', () => {
    expect(shouldRetryProxyRequest(429, 'rate limit')).toBe(true);
    expect(shouldRetryProxyRequest(500, 'internal error')).toBe(true);
    expect(shouldRetryProxyRequest(503, 'service unavailable')).toBe(true);
  });

  it('retries on model unsupported messages from upstream', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":"当前 API 不支持所选模型 claude-sonnet-4-5-20250929","type":"error"}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"unsupported model: claude-3"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"The model `gpt-4.1` does not exist"}}'),
    ).toBe(true);
  });

  it('does not retry obvious request-shape errors that will fail on every channel', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid request body"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(422, '{"error":{"message":"unprocessable"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"not found"}}'),
    ).toBe(false);
  });

  it('keeps retrying channel-local compatibility and auth failures', () => {
    expect(
      shouldRetryProxyRequest(401, '{"error":{"message":"invalid access token"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(403, '{"error":{"message":"forbidden"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.'),
    ).toBe(true);
  });

  it('does not retry client-side timeout validation errors', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"timeout must be <= 60"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid timeout parameter"}}'),
    ).toBe(false);
  });

  it('aborts same-site endpoint fallback on rate-limit and quota responses', () => {
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"rate limit exceeded"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"quota exceeded"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"too many requests"}}'),
    ).toBe(true);
  });

  // 参数兼容层（参数剥离 + NIM 400 自愈）锁定：分类函数不改。
  it('keeps the NIM unsupported-parameter 400 non-retryable on the shared channel-retry classifier', () => {
    expect(shouldRetryProxyRequest(
      400,
      'Validation: Unsupported parameter(s): prompt_cache_key, prompt_cache_retention',
    )).toBe(false);
    expect(shouldRetryProxyRequest(
      400,
      'Validation: Unsupported parameter(s): prompt_cache_key, prompt_cache_retention.',
    )).toBe(false);
    expect(shouldRetryProxyRequest(400, 'unsupported parameter: prompt_cache_key')).toBe(false);
  });

  it('classifies a first-byte timeout 408 as retryable and as a same-site endpoint abort', () => {
    // 自愈失败后的第二次首字节超时按普通 408 失败分类（不走首次超时的 continue 分支）。
    expect(shouldRetryProxyRequest(408, 'first byte timeout (1s)')).toBe(true);
    expect(shouldAbortSameSiteEndpointFallback(408, 'first byte timeout (1s)')).toBe(true);
  });
});
