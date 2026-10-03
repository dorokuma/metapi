import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Response } from 'undici';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./proxyDebugTraceStore.js');

describe('proxyDebugTraceStore', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-debug-traces-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const storeModule = await import('./proxyDebugTraceStore.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = storeModule;
  });

  beforeEach(async () => {
    await db.delete(schema.proxyDebugAttempts).run();
    await db.delete(schema.proxyDebugTraces).run();
  });

  afterAll(async () => {
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('creates, updates, and reads debug traces and attempts with credential headers masked', async () => {
    // 安全口径：调试价值保留（头名、次序、非敏感头的值一字不改）、明文消失。
    // 四条落库列（trace/attempt 的 request/response headers）都过同一个 `serializeHeaders` 咽喉。
    // 夹具里的 token 全是假值（不得出现真凭据）。
    const trace = await store.createProxyDebugTrace({
      downstreamPath: '/v1/responses',
      clientKind: 'codex',
      sessionId: 'sess-1',
      traceHint: 'trace-abc',
      requestedModel: 'gpt-4o',
      downstreamApiKeyId: 7,
      requestHeaders: {
        authorization: 'Bearer fake-downstream-token',
        cookie: 'sid=fake-cookie-value',
        'x-client': 'Codex Desktop',
      },
      requestBody: {
        model: 'gpt-4o',
        input: [{ role: 'user', content: 'hello' }],
      },
    });

    await store.updateProxyDebugTraceSelection(trace.id, {
      stickySessionKey: 'key:7|codex|/v1/responses|gpt-4o|sess-1',
      stickyHitChannelId: 12,
      selectedChannelId: 12,
      selectedRouteId: 99,
      selectedAccountId: 33,
      selectedSiteId: 8,
      selectedSitePlatform: 'codex',
    });

    await store.updateProxyDebugTraceCandidates(trace.id, {
      endpointCandidates: ['responses', 'chat'],
      endpointRuntimeState: {
        preferredEndpoint: 'responses',
        blockedEndpoints: [],
      },
      decisionSummary: {
        reason: 'platform default + sticky session',
      },
    });

    const attempt = await store.insertProxyDebugAttempt({
      traceId: trace.id,
      attemptIndex: 0,
      endpoint: 'responses',
      requestPath: '/responses',
      targetUrl: 'https://chatgpt.com/backend-api/codex/responses',
      runtimeExecutor: 'codex',
      requestHeaders: {
        authorization: 'Bearer fake-upstream-token',
        'x-api-key': 'fake-api-key-value',
        'x-request-id': 'req-keep-plain',
      },
      requestBody: {
        model: 'gpt-4o',
        store: false,
      },
      responseStatus: 403,
      responseHeaders: {
        'content-type': 'application/json',
        'set-cookie': 'sid=fake-set-cookie-value; Path=/; HttpOnly',
      },
      responseBody: {
        error: {
          message: 'forbidden',
        },
      },
      rawErrorText: '{"error":{"message":"forbidden"}}',
      recoverApplied: false,
      downgradeDecision: true,
      downgradeReason: '[upstream:/responses] forbidden',
      memoryWrite: {
        action: 'failure',
        blockedEndpoint: 'responses',
      },
    });

    expect(attempt.id).toBeGreaterThan(0);

    await store.finalizeProxyDebugTrace(trace.id, {
      finalStatus: 'failed',
      finalHttpStatus: 503,
      finalUpstreamPath: '/responses',
      finalResponseHeaders: {
        'content-type': 'application/json',
        'set-cookie': 'sid=fake-final-cookie-value; Path=/',
      },
      finalResponseBody: {
        error: {
          message: 'Channel busy',
        },
      },
    });

    const list = await store.listProxyDebugTraces({ limit: 20 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      requestedModel: 'gpt-4o',
      downstreamPath: '/v1/responses',
      clientKind: 'codex',
      sessionId: 'sess-1',
      selectedChannelId: 12,
      finalStatus: 'failed',
      finalHttpStatus: 503,
      finalUpstreamPath: '/responses',
    });

    const detail = await store.getProxyDebugTraceDetail(trace.id);
    // 调试价值保留：头名在位、非敏感头的值与体照旧。
    expect(detail?.trace.requestBodyJson || '').toContain('"hello"');
    expect(detail?.trace.finalResponseBodyJson || '').toContain('Channel busy');
    expect(detail?.attempts).toHaveLength(1);
    expect(detail?.attempts[0]?.responseBodyJson || '').toContain('forbidden');
    expect(detail?.attempts[0]).toMatchObject({
      endpoint: 'responses',
      runtimeExecutor: 'codex',
      responseStatus: 403,
      downgradeDecision: true,
    });

    // 明文消失：四条列里都不得留下任何凭据原文（本用例全部为假值）。
    const headerColumns = [
      detail?.trace.requestHeadersJson,
      detail?.trace.finalResponseHeadersJson,
      detail?.attempts[0]?.requestHeadersJson,
      detail?.attempts[0]?.responseHeadersJson,
    ].map((value) => value || '');
    for (const leaked of [
      'fake-downstream-token',
      'fake-cookie-value',
      'fake-upstream-token',
      'fake-api-key-value',
      'fake-set-cookie-value',
      'fake-final-cookie-value',
    ]) {
      for (const column of headerColumns) {
        expect(column).not.toContain(leaked);
      }
    }

    // 头名保留 + 值变固定占位；次序与传入一致（按名排序），非敏感头原文保留。
    expect(detail?.trace.requestHeadersJson || '').toContain('authorization');
    expect(detail?.trace.requestHeadersJson || '').toContain(store.REDACTED_DEBUG_HEADER_VALUE);
    expect(JSON.parse(detail?.trace.requestHeadersJson || 'null')).toEqual({
      authorization: store.REDACTED_DEBUG_HEADER_VALUE,
      cookie: store.REDACTED_DEBUG_HEADER_VALUE,
      'x-client': 'Codex Desktop',
    });
    expect(JSON.parse(detail?.attempts[0]?.requestHeadersJson || 'null')).toEqual({
      authorization: store.REDACTED_DEBUG_HEADER_VALUE,
      'x-api-key': store.REDACTED_DEBUG_HEADER_VALUE,
      'x-request-id': 'req-keep-plain',
    });
    expect(JSON.parse(detail?.attempts[0]?.responseHeadersJson || 'null')).toEqual({
      'content-type': 'application/json',
      'set-cookie': store.REDACTED_DEBUG_HEADER_VALUE,
    });
    expect(JSON.parse(detail?.trace.finalResponseHeadersJson || 'null')).toEqual({
      'content-type': 'application/json',
      'set-cookie': store.REDACTED_DEBUG_HEADER_VALUE,
    });
  });

  it('judges sensitive header names by word token (key / …-key / signature / auth) without harming look-alikes', async () => {
    // R2-1：只按**子串**判定时，`key` / `x-access-key` / `x-auth-key` / `x-upstream-key` /
    // `x-litellm-key` / `x-amz-signature` 全部漏网（站点 `customHeaders` 允许任意头名并被合并进上游请求，
    // 故配 `{"x-upstream-key":"…"}` 即可把自家 key 明文写进调试库）。判定升为**词元判定**后它们都命中；
    // 同时 `x-monkey`（含 `key` 子串）等名字不得被误伤——这是本用例的反向控制组。
    // O-1：词元表当时**不含**长形变体 `authorization` / `authentication`（词元是整段短横段，`auth` 盖不住），
    // 故 `x-authorization` / `authentication` / `x-authentication` / `proxy-authentication` 的值仍明文落库。
    const sensitiveNames = [
      'authorization',
      'key',
      'x-access-key',
      'x-auth-key',
      // 站点自定义头复现路径（`siteCustomHeaders` 任意头名 ⇒ 合并进上游头 ⇒ 随 attempt 落库）。
      'x-upstream-key',
      'x-litellm-key',
      'x-amz-signature',
      'x-custom-site-token',
      // O-1 补的词元：长形变体头名（改前这一组整组明文落库）。
      'x-authorization',
      'authentication',
      'x-authentication',
      'proxy-authentication',
    ];
    const plainNames = ['x-monkey', 'x-request-id', 'content-type', 'x-client'];
    // 已知且**有意接受**的过掩码：`x-authentication-method` 的整段词元是 `authentication` ⇒ 与凭据头
    // 同一判据、一并掩码。典型值 `basic`/`bearer`/`oauth2` 本身不是凭据，但取「宁多勿漏」：过掩码只
    // 损失一条非密钥的调试元数据，漏掩码则留下可离线爆破的凭据存量（理由同 `auth` 词元的既有代价）。
    const overMaskedNames = ['x-authentication-method'];
    const requestHeaders = Object.fromEntries([
      ...sensitiveNames.map((name) => [name, `value-of-${name}`]),
      ...overMaskedNames.map((name) => [name, `value-of-${name}`]),
      ...plainNames.map((name) => [name, `value-of-${name}`]),
    ]);

    const trace = await store.createProxyDebugTrace({
      downstreamPath: '/v1/chat/completions',
      clientKind: 'codex',
      requestedModel: 'gpt-4o',
      requestHeaders,
      requestBody: { model: 'gpt-4o' },
    });

    const headers = JSON.parse(
      (await store.getProxyDebugTraceDetail(trace.id))?.trace.requestHeadersJson || 'null',
    ) as Record<string, string>;

    // 正例（改前这 6 个 `*-key` / `signature` 名字全部漏网 ⇒ 整组变红）：值一律变固定占位。
    expect(
      Object.fromEntries(sensitiveNames.map((name) => [name, headers[name]])),
    ).toEqual(
      Object.fromEntries(sensitiveNames.map((name) => [name, store.REDACTED_DEBUG_HEADER_VALUE])),
    );
    // 反例（控制组）：这些名字不得被误伤，值原文逐字保留。
    expect(
      Object.fromEntries(plainNames.map((name) => [name, headers[name]])),
    ).toEqual(
      Object.fromEntries(plainNames.map((name) => [name, `value-of-${name}`])),
    );
    // 过掩码判定（有意接受）：与凭据头同口径，值变占位。
    expect(
      Object.fromEntries(overMaskedNames.map((name) => [name, headers[name]])),
    ).toEqual(
      Object.fromEntries(overMaskedNames.map((name) => [name, store.REDACTED_DEBUG_HEADER_VALUE])),
    );
    // 明文消失：敏感头的值不得以任何形式留在落库文本里（含被截断预览）。
    for (const name of [...sensitiveNames, ...overMaskedNames]) {
      expect(String(requestHeaders[name])).toBe(`value-of-${name}`);
      expect(JSON.stringify(headers)).not.toContain(`value-of-${name}`);
    }
  });

  it('stores truncated debug payload previews as valid JSON text for json-capable databases', async () => {
    const trace = await store.createProxyDebugTrace({
      downstreamPath: '/v1/responses',
      clientKind: 'codex',
      requestedModel: 'gpt-5.4',
      requestHeaders: {
        // 敏感头的值现在会被掩码，故改用**非敏感**的长头值来触发截断（本用例要验的是
        // 「截断后的 preview 仍是合法 JSON」，与哪一个头无关）。
        authorization: 'Bearer fake-truncation-token',
        'x-client': `Codex Desktop ${'x'.repeat(5000)}`,
      },
      requestBody: {
        model: 'gpt-5.4',
        input: [{ role: 'user', content: 'hello '.repeat(2000) }],
      },
      maxBodyBytes: 1024,
    });

    const detail = await store.getProxyDebugTraceDetail(trace.id);
    const headersPayload = JSON.parse(detail?.trace.requestHeadersJson || 'null');
    const bodyPayload = JSON.parse(detail?.trace.requestBodyJson || 'null');

    expect(headersPayload).toMatchObject({
      __metapiTruncated: true,
    });
    expect(typeof headersPayload.preview).toBe('string');
    expect(headersPayload.preview).toContain('authorization');

    expect(bodyPayload).toMatchObject({
      __metapiTruncated: true,
    });
    expect(typeof bodyPayload.preview).toBe('string');
    expect(bodyPayload.preview).toContain('"model": "gpt-5.4"');
  });

  it('normalizes undici response headers for proxy debug capture', () => {
    const response = new Response('ok', {
      headers: {
        'content-type': 'application/json',
        'x-trace-id': 'trace-123',
      },
    });

    expect(store.normalizeProxyDebugResponseHeaders(response.headers)).toEqual({
      'content-type': 'application/json',
      'x-trace-id': 'trace-123',
    });
  });
});
