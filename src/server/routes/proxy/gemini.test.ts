import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';

const fetchMock = vi.fn();
const fetchModelPricingCatalogMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const refreshOauthAccessTokenSingleflightMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const explainSelectionMock = vi.fn();
const invalidateTokenRouterCacheMock = vi.fn();
const authorizeDownstreamTokenMock = vi.fn();
const consumeManagedKeyRequestMock = vi.fn();
const isModelAllowedByPolicyOrAllowedRoutesMock = vi.fn();
const dbSelectAllMock = vi.fn();
const dbSelectGetMock = vi.fn();
const dbInsertValuesMock = vi.fn((_values?: unknown) => ({
  run: () => undefined,
}));
const dbInsertMock = vi.fn((_table?: unknown) => ({
  values: (values: unknown) => dbInsertValuesMock(values),
}));
const startSurfaceProxyDebugTraceMock = vi.fn();
const safeUpdateSurfaceProxyDebugSelectionMock = vi.fn();
const safeUpdateSurfaceProxyDebugCandidatesMock = vi.fn();
const safeInsertSurfaceProxyDebugAttemptMock = vi.fn();
const safeFinalizeSurfaceProxyDebugTraceMock = vi.fn();

function createDbSelectChain() {
  return {
    from() {
      return this;
    },
    innerJoin() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    all: (...args: unknown[]) => dbSelectAllMock(...args),
    get: (...args: unknown[]) => dbSelectGetMock(...args),
  };
}

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/modelPricingService.js', () => ({
  fetchModelPricingCatalog: (...args: unknown[]) => fetchModelPricingCatalogMock(...args),
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/oauth/refreshSingleflight.js', () => ({
  refreshOauthAccessTokenSingleflight: (...args: unknown[]) => refreshOauthAccessTokenSingleflightMock(...args),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
    explainSelection: (...args: unknown[]) => explainSelectionMock(...args),
  },
  invalidateTokenRouterCache: (...args: unknown[]) => invalidateTokenRouterCacheMock(...args),
}));

vi.mock('../../services/downstreamApiKeyService.js', () => ({
  authorizeDownstreamToken: (...args: unknown[]) => authorizeDownstreamTokenMock(...args),
  consumeManagedKeyRequest: (...args: unknown[]) => consumeManagedKeyRequestMock(...args),
  isModelAllowedByPolicyOrAllowedRoutes: (...args: unknown[]) => isModelAllowedByPolicyOrAllowedRoutesMock(...args),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    select: (..._args: unknown[]) => createDbSelectChain(),
    insert: (arg: unknown) => dbInsertMock(arg),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogClientHttpStatusColumn: async () => true,
  // O8 R4：本文件现在要断言 `is_stream` / `client_http_status` 是否真的进写侧取值，故两列夹具均置真
  //（置假时 `insertProxyLog` 按设计整列丢弃，断言无法区分「未传」与「传了但被丢」）。
  hasProxyLogStreamTimingColumns: async () => true,
  schema: {
    proxyLogs: {},
    modelAvailability: {
      modelName: Symbol('modelAvailability.modelName'),
      accountId: Symbol('modelAvailability.accountId'),
      available: Symbol('modelAvailability.available'),
    },
    accounts: {
      id: Symbol('accounts.id'),
      siteId: Symbol('accounts.siteId'),
      status: Symbol('accounts.status'),
    },
    sites: {
      id: Symbol('sites.id'),
      status: Symbol('sites.status'),
    },
    siteApiEndpoints: {
      siteId: Symbol('siteApiEndpoints.siteId'),
      sortOrder: Symbol('siteApiEndpoints.sortOrder'),
      id: Symbol('siteApiEndpoints.id'),
    },
    tokenRoutes: {
      displayName: Symbol('tokenRoutes.displayName'),
      enabled: Symbol('tokenRoutes.enabled'),
    },
  },
}));

vi.mock('../../services/proxyDebugTraceRuntime.js', () => ({
  startSurfaceProxyDebugTrace: (...args: unknown[]) => startSurfaceProxyDebugTraceMock(...args),
  safeUpdateSurfaceProxyDebugSelection: (...args: unknown[]) => safeUpdateSurfaceProxyDebugSelectionMock(...args),
  safeUpdateSurfaceProxyDebugCandidates: (...args: unknown[]) => safeUpdateSurfaceProxyDebugCandidatesMock(...args),
  safeInsertSurfaceProxyDebugAttempt: (...args: unknown[]) => safeInsertSurfaceProxyDebugAttemptMock(...args),
  safeFinalizeSurfaceProxyDebugTrace: (...args: unknown[]) => safeFinalizeSurfaceProxyDebugTraceMock(...args),
  safeUpdateSurfaceProxyDebugAttempt: vi.fn(),
  reserveSurfaceProxyDebugAttemptBase: () => 0,
  buildSurfaceProxyDebugResponseHeaders: () => ({}),
  captureSurfaceProxyDebugSuccessResponseBody: async () => null,
  parseSurfaceProxyDebugTextPayload: (raw: string) => raw,
}));

function parseSsePayloads(body: string): Array<Record<string, unknown>> {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n'),
    )
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

function readWorkspaceFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('gemini transformer-owned path parsing', () => {
  it('keeps apiVersion and modelActionPath parsing in transformer helpers', async () => {
    const geminiRoute = readWorkspaceFile('src/server/routes/proxy/gemini.ts');

    expect(geminiRoute).not.toContain('function resolveGeminiApiVersion(');
    expect(geminiRoute).not.toContain('function extractGeminiModelActionPath(');

    const { geminiGenerateContentTransformer } = await import('../../transformers/gemini/generate-content/index.js');
    expect(geminiGenerateContentTransformer.parseProxyRequestPath({
      rawUrl: '/gemini/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      params: { geminiApiVersion: 'v1' },
    })).toEqual({
      apiVersion: 'v1',
      modelActionPath: 'models/gemini-2.5-flash:streamGenerateContent',
      requestedModel: 'gemini-2.5-flash',
      isStreamAction: true,
    });
  });
});

describe('gemini native proxy routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { proxyRoutes } = await import('./router.js');
    app = Fastify();
    await app.register(proxyRoutes);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    fetchModelPricingCatalogMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    refreshOauthAccessTokenSingleflightMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    explainSelectionMock.mockReset();
    authorizeDownstreamTokenMock.mockReset();
    consumeManagedKeyRequestMock.mockReset();
    isModelAllowedByPolicyOrAllowedRoutesMock.mockReset();
    dbInsertMock.mockClear();
    dbInsertValuesMock.mockClear();
    dbSelectAllMock.mockReset();
    dbSelectGetMock.mockReset();
    startSurfaceProxyDebugTraceMock.mockReset();
    safeUpdateSurfaceProxyDebugSelectionMock.mockReset();
    safeUpdateSurfaceProxyDebugCandidatesMock.mockReset();
    safeInsertSurfaceProxyDebugAttemptMock.mockReset();
    safeFinalizeSurfaceProxyDebugTraceMock.mockReset();

    startSurfaceProxyDebugTraceMock.mockResolvedValue({
      traceId: 801,
      options: {
        enabled: true,
        captureHeaders: true,
        captureBodies: true,
        captureStreamChunks: false,
        targetSessionId: '',
        targetClientKind: '',
        targetModel: '',
        retentionHours: 24,
        maxBodyBytes: 262144,
      },
    });

    authorizeDownstreamTokenMock.mockResolvedValue({
      ok: true,
      source: 'global',
      token: 'managed-gemini-token',
      policy: {},
    });
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    refreshModelsAndRebuildRoutesMock.mockResolvedValue(undefined);
    dbSelectGetMock.mockResolvedValue(null);
    dbSelectAllMock.mockResolvedValue([]);

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'gemini-site', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'gemini-key',
      actualModel: 'gemini-2.5-flash',
    });
    selectNextChannelMock.mockReturnValue(null);
    selectPreferredChannelMock.mockReturnValue(null);
    recordSuccessMock.mockResolvedValue(undefined);
    recordFailureMock.mockResolvedValue(undefined);
    resetUpstreamEndpointRuntimeState();
    explainSelectionMock.mockResolvedValue({ selectedChannelId: 11 });
    isModelAllowedByPolicyOrAllowedRoutesMock.mockResolvedValue(true);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts x-goog-api-key on /v1beta/models and returns gemini model list shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
        },
      ],
    });
  });

  it('falls back to the next channel for listModels when first Gemini channel fails', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'first channel failed' },
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 500,
      errorText: JSON.stringify({ error: { message: 'first channel failed' } }),
    }));
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toContain('key=gemini-key');
    expect(secondUrl).toContain('key=gemini-key-2');
  });

  it('pins /v1beta/models to the forced tester channel when present', async () => {
    selectPreferredChannelMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        channel: { id: 77, routeId: 22 },
        site: { id: 88, name: 'forced-gemini-site', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
        account: { id: 39, username: 'forced-user' },
        tokenName: 'forced',
        tokenValue: 'forced-gemini-key',
        actualModel: 'gemini-2.0-flash',
      });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      remoteAddress: '127.0.0.1',
      headers: {
        authorization: 'Bearer managed-gemini-token',
        'x-metapi-tester-request': '1',
        'x-metapi-tester-forced-channel-id': '77',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(2);
    expect(selectPreferredChannelMock).toHaveBeenNthCalledWith(
      1,
      'gemini-2.5-flash',
      77,
      expect.anything(),
      expect.any(Array),
    );
    expect(selectPreferredChannelMock).toHaveBeenNthCalledWith(
      2,
      'gemini-2.0-flash',
      77,
      expect.anything(),
      expect.any(Array),
    );
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toContain('key=forced-gemini-key');
  });

  it('serves gemini-cli model list from local static catalog without upstream fetch', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 21, routeId: 22 },
      site: { id: 55, name: 'gemini-cli-site', url: 'https://cloudcode-pa.googleapis.com', platform: 'gemini-cli' },
      account: {
        id: 35,
        username: 'gemini-cli-user@example.com',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'gemini-cli',
            email: 'gemini-cli-user@example.com',
            projectId: 'project-demo',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'oauth-access-token',
      actualModel: 'gemini-2.5-pro',
    });
    explainSelectionMock.mockImplementation(async (modelName: string) => (
      modelName === 'gemini-2.5-pro'
        ? { selectedChannelId: 21 }
        : { selectedChannelId: undefined }
    ));

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      models: expect.arrayContaining([
        {
          name: 'models/gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
        },
      ]),
    });
  });

  it('synthesizes /v1beta/models from locally available routed models for non-gemini upstreams', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 41, routeId: 22 },
      site: { id: 77, name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 37, username: 'openai-user@example.com' },
      tokenName: 'default',
      tokenValue: 'openai-access-token',
      actualModel: 'gpt-4.1',
    });
    dbSelectAllMock
      .mockResolvedValueOnce([
        { modelName: 'gpt-4.1' },
        { modelName: 'claude-sonnet-4-5-20250929' },
      ])
      .mockResolvedValueOnce([
        { displayName: 'gemini-2.5-flash' },
      ]);

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      models: [
        {
          name: 'models/claude-sonnet-4-5-20250929',
          displayName: 'claude-sonnet-4-5-20250929',
        },
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'gemini-2.5-flash',
        },
        {
          name: 'models/gpt-4.1',
          displayName: 'gpt-4.1',
        },
      ],
    });
  });

  it('forwards native generateContent requests through the gemini route group', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'hello from gemini' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(targetUrl).toContain('key=gemini-key');
    expect(JSON.parse(String(requestInit.body))).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
    });
    expect(response.json()).toEqual({
      responseId: '',
      modelVersion: '',
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ text: 'hello from gemini' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
  });

  it('wraps gemini-cli native generateContent requests and unwraps the response payload', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 31, routeId: 22 },
      site: { id: 66, name: 'gemini-cli-site', url: 'https://cloudcode-pa.googleapis.com', platform: 'gemini-cli' },
      account: {
        id: 36,
        username: 'gemini-cli-user@example.com',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'gemini-cli',
            email: 'gemini-cli-user@example.com',
            projectId: 'project-demo',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'oauth-access-token',
      actualModel: 'gemini-2.5-pro',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: 'hello from gemini cli' }],
              role: 'model',
            },
            finishReason: 'STOP',
          },
        ],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-pro:generateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(requestInit.headers).toMatchObject({
      Authorization: 'Bearer oauth-access-token',
    });
    expect((requestInit.headers as Record<string, string>)['User-Agent']).toContain('GeminiCLI/');
    expect((requestInit.headers as Record<string, string>)['X-Goog-Api-Client']).toContain('google-genai-sdk/');
    expect(JSON.parse(String(requestInit.body))).toEqual({
      project: 'project-demo',
      model: 'gemini-2.5-pro',
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });
    expect(response.json()).toEqual({
      responseId: '',
      modelVersion: '',
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ text: 'hello from gemini cli' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
  });

  it('refreshes gemini-cli oauth token and retries the same internal request on 401', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 31, routeId: 22 },
      site: { id: 66, name: 'gemini-cli-site', url: 'https://cloudcode-pa.googleapis.com', platform: 'gemini-cli' },
      account: {
        id: 36,
        username: 'gemini-cli-user@example.com',
        accessToken: 'oauth-access-token',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'gemini-cli',
            email: 'gemini-cli-user@example.com',
            projectId: 'project-before-refresh',
            refreshToken: 'gemini-refresh-token',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'oauth-access-token',
      actualModel: 'gemini-2.5-pro',
    });
    refreshOauthAccessTokenSingleflightMock.mockResolvedValue({
      accountId: 36,
      accessToken: 'refreshed-access-token',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'gemini-cli',
          email: 'gemini-cli-user@example.com',
          projectId: 'project-after-refresh',
          refreshToken: 'gemini-refresh-token',
        },
      }),
    });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'token expired' },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: 'hello after refresh' }],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-pro:generateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(refreshOauthAccessTokenSingleflightMock).toHaveBeenCalledWith(36);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(selectNextChannelMock).not.toHaveBeenCalled();

    const [, firstRequestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, secondRequestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstRequestInit.headers).toMatchObject({
      Authorization: 'Bearer oauth-access-token',
    });
    expect(secondRequestInit.headers).toMatchObject({
      Authorization: 'Bearer refreshed-access-token',
    });
    expect(JSON.parse(String(secondRequestInit.body))).toEqual({
      project: 'project-after-refresh',
      model: 'gemini-2.5-pro',
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });
    expect(response.json()).toEqual({
      responseId: '',
      modelVersion: '',
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ text: 'hello after refresh' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
  });

  it('returns a server error when gemini-cli oauth project metadata is missing at runtime', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 31, routeId: 22 },
      site: { id: 66, name: 'gemini-cli-site', url: 'https://cloudcode-pa.googleapis.com', platform: 'gemini-cli' },
      account: {
        id: 36,
        username: 'gemini-cli-user@example.com',
        accessToken: 'oauth-access-token',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'gemini-cli',
            email: 'gemini-cli-user@example.com',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'oauth-access-token',
      actualModel: 'gemini-2.5-pro',
    });
    selectNextChannelMock.mockReturnValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-pro:generateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledWith(31, {
      status: 500,
      errorText: 'Gemini CLI OAuth project is missing',
    });
    expect(JSON.parse(response.body)).toEqual({
      error: {
        message: 'Gemini CLI OAuth project is missing',
        type: 'server_error',
      },
    });
  });

  it('routes Gemini native generateContent requests to openai upstreams and serializes the response back to Gemini shape', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 41, routeId: 22 },
      site: { id: 77, name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 37, username: 'openai-user@example.com' },
      tokenName: 'default',
      tokenValue: 'openai-access-token',
      actualModel: 'gpt-4.1',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-openai-1',
      object: 'response',
      model: 'gpt-4.1',
      status: 'completed',
      output: [
        {
          id: 'msg-openai-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from openai' }],
        },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        total_tokens: 7,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://api.openai.com/v1/responses');
    expect(requestInit.headers).toMatchObject({
      Authorization: 'Bearer openai-access-token',
      'Content-Type': 'application/json',
    });
    expect(startSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(expect.objectContaining({
      downstreamPath: '/v1beta/models/gemini-2.5-flash:generateContent',
      requestedModel: 'gemini-2.5-flash',
    }));
    expect(safeUpdateSurfaceProxyDebugSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 801 }),
      expect.objectContaining({
        selectedChannelId: 41,
        selectedSitePlatform: 'openai',
      }),
    );
    expect(safeInsertSurfaceProxyDebugAttemptMock).toHaveBeenCalled();
    expect(safeFinalizeSurfaceProxyDebugTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 801 }),
      expect.objectContaining({
        finalStatus: 'success',
        finalUpstreamPath: '/v1/responses',
      }),
    );
    expect(JSON.parse(String(requestInit.body))).toEqual({
      model: 'gpt-4.1',
      stream: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hello',
            },
          ],
        },
      ],
    });
    expect(response.json()).toEqual({
      responseId: 'resp-openai-1',
      modelVersion: 'gpt-4.1',
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: 'hello from openai' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 3,
        totalTokenCount: 7,
      },
    });
  });

  it('serializes non-streaming generic upstream JSON into Gemini SSE when alt=sse is requested', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 41, routeId: 22 },
      site: { id: 77, name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 37, username: 'openai-user@example.com' },
      tokenName: 'default',
      tokenValue: 'openai-access-token',
      actualModel: 'gpt-4.1',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-openai-stream-1',
      object: 'response',
      model: 'gpt-4.1',
      status: 'completed',
      output: [
        {
          id: 'msg-openai-stream-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from openai stream fallback' }],
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        total_tokens: 11,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(parseSsePayloads(response.body)).toEqual([
      {
        responseId: 'resp-openai-stream-1',
        modelVersion: 'gpt-4.1',
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'hello from openai stream fallback' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 6,
          totalTokenCount: 11,
        },
      },
    ]);
  });

  it('exposes GeminiCLI downstream generateContent endpoint and wraps the downstream response payload', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 42, routeId: 22 },
      site: { id: 78, name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 38, username: 'openai-user@example.com' },
      tokenName: 'default',
      tokenValue: 'openai-access-token',
      actualModel: 'gpt-4.1',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-openai-2',
      object: 'response',
      model: 'gpt-4.1',
      status: 'completed',
      output: [
        {
          id: 'msg-openai-2',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from gemini cli downstream' }],
        },
      ],
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        total_tokens: 11,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1internal:generateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        model: 'gpt-4.1',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://api.openai.com/v1/responses');
    const forwardedBody = JSON.parse(String(requestInit.body));
    expect(forwardedBody).toMatchObject({
      model: 'gpt-4.1',
      stream: false,
    });
    expect(Array.isArray(forwardedBody.input)).toBe(true);
    expect(JSON.stringify(forwardedBody.input)).toContain('hello');
    expect(response.json()).toEqual({
      response: {
        responseId: 'resp-openai-2',
        modelVersion: 'gpt-4.1',
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'hello from gemini cli downstream' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 6,
          candidatesTokenCount: 5,
          totalTokenCount: 11,
        },
      },
    });
  });

  it('routes Gemini native document requests to responses endpoints on openai-compatible upstreams', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 42, routeId: 22 },
      site: { id: 78, name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 38, username: 'openai-user@example.com' },
      tokenName: 'default',
      tokenValue: 'openai-access-token',
      actualModel: 'gpt-4.1',
    });
    fetchMock.mockImplementation(async (target: unknown) => {
      const url = String(target);
      if (url === 'https://api.openai.com/v1/responses') {
        return new Response(JSON.stringify({
          id: 'resp-openai-file-1',
          object: 'response',
          model: 'gpt-4.1',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'document summary from responses' }],
            },
          ],
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            total_tokens: 13,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        return new Response(JSON.stringify({
          id: 'chatcmpl-openai-file-1',
          object: 'chat.completion',
          created: 1_742_160_002,
          model: 'gpt-4.1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'document summary from chat',
              },
              finish_reason: 'stop',
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected target url: ${url}`);
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'summarize this pdf' },
              {
                fileData: {
                  fileUri: 'https://example.com/brief.pdf',
                  mimeType: 'application/pdf',
                },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://api.openai.com/v1/responses');
  });

  it('routes Gemini native generateContent requests to antigravity special models through the internal stream endpoint and aggregates back to Gemini JSON', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 43, routeId: 22 },
      site: { id: 79, name: 'antigravity-site', url: 'https://cloudcode-pa.googleapis.com', platform: 'antigravity' },
      account: {
        id: 39,
        username: 'antigravity-user@example.com',
        extraConfig: JSON.stringify({
          oauth: {
            provider: 'antigravity',
            email: 'antigravity-user@example.com',
            projectId: 'project-demo',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'antigravity-access-token',
      actualModel: 'gemini-3-pro-preview',
    });
    fetchMock.mockResolvedValue(new Response([
      'data: {"response":{"responseId":"antigravity-response-1","modelVersion":"gemini-3-pro-preview","candidates":[{"content":{"role":"model","parts":[{"text":"hello "}]},"index":0}]}}',
      '',
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"from antigravity"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":4,"totalTokenCount":12}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-pro-preview:generateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    expect(requestInit.headers).toMatchObject({
      Authorization: 'Bearer antigravity-access-token',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'antigravity/1.19.6 darwin/arm64',
    });
    const upstreamBody = JSON.parse(String(requestInit.body));
    expect(upstreamBody).toMatchObject({
      project: 'project-demo',
      model: 'gemini-3-pro-preview',
      userAgent: 'antigravity',
      requestType: 'agent',
      request: {
        sessionId: expect.any(String),
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });
    expect(upstreamBody.requestId).toMatch(/^agent-[0-9a-f-]{36}$/i);
    expect(String(upstreamBody.request.sessionId)).toMatch(/^-\d+$/);
    expect(response.json()).toEqual({
      responseId: 'antigravity-response-1',
      modelVersion: 'gemini-3-pro-preview',
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: 'hello from antigravity' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 4,
        totalTokenCount: 12,
      },
    });
  });

  it('exposes GeminiCLI downstream streamGenerateContent endpoint and preserves GeminiCLI response envelopes', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 44, routeId: 22 },
      site: { id: 80, name: 'gemini-cli-site', url: 'https://cloudcode-pa.googleapis.com', platform: 'gemini-cli' },
      account: {
        id: 40,
        username: 'gemini-cli-user@example.com',
        extraConfig: JSON.stringify({
          oauth: {
            provider: 'gemini-cli',
            email: 'gemini-cli-user@example.com',
            projectId: 'project-demo',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'gemini-cli-access-token',
      actualModel: 'gemini-2.5-pro',
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":{"responseId":"cli-stream-1","candidates":[{"content":{"role":"model","parts":[{"text":"hello from cli stream"}]},"finishReason":"STOP"}]}}\n\n'));
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
      url: '/v1internal:streamGenerateContent',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        model: 'gemini-2.5-pro',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: {"response":{"responseId":"cli-stream-1"');
    expect(response.body).toContain('hello from cli stream');
  });

  it('exposes GeminiCLI downstream countTokens endpoint', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 45, routeId: 22 },
      site: { id: 81, name: 'gemini-cli-site', url: 'https://cloudcode-pa.googleapis.com', platform: 'gemini-cli' },
      account: {
        id: 41,
        username: 'gemini-cli-user@example.com',
        extraConfig: JSON.stringify({
          oauth: {
            provider: 'gemini-cli',
            email: 'gemini-cli-user@example.com',
            projectId: 'project-demo',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'gemini-cli-access-token',
      actualModel: 'gemini-2.5-pro',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      totalTokens: 13,
      promptTokensDetails: [
        {
          modality: 'TEXT',
          tokenCount: 13,
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1internal:countTokens',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
      payload: {
        model: 'gemini-2.5-pro',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://cloudcode-pa.googleapis.com/v1internal:countTokens');
    expect(JSON.parse(String(requestInit.body))).toEqual({
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });
    expect(response.json()).toEqual({
      totalTokens: 13,
      promptTokensDetails: [
        {
          modality: 'TEXT',
          tokenCount: 13,
        },
      ],
    });
  });

  it('filters Gemini native model list by downstream managed-key policy', async () => {
    authorizeDownstreamTokenMock.mockResolvedValue({
      ok: true,
      source: 'managed',
      token: 'managed-gemini-token',
      key: { id: 91 },
      policy: { supportedModels: ['gemini-2.5-flash'], allowedRouteIds: [], siteWeightMultipliers: {} },
    });
    isModelAllowedByPolicyOrAllowedRoutesMock.mockImplementation(async (modelName: string) => modelName === 'gemini-2.5-flash');
    explainSelectionMock.mockImplementation(async (modelName: string) => (
      modelName === 'gemini-2.5-flash'
        ? { selectedChannelId: 11 }
        : { selectedChannelId: undefined }
    ));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      headers: {
        authorization: 'Bearer managed-gemini-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
        },
      ],
    });
    expect(isModelAllowedByPolicyOrAllowedRoutesMock).toHaveBeenCalledWith('gemini-2.5-flash', { supportedModels: ['gemini-2.5-flash'], allowedRouteIds: [], siteWeightMultipliers: {} });
    expect(isModelAllowedByPolicyOrAllowedRoutesMock).toHaveBeenCalledWith('gemini-2.0-flash', { supportedModels: ['gemini-2.5-flash'], allowedRouteIds: [], siteWeightMultipliers: {} });
  });

  it('writes a proxy log row for successful native generateContent requests', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'hello from gemini' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(recordSuccessMock).toHaveBeenCalledWith(11, expect.any(Number), 0, 'gemini-2.5-flash');
    expect(dbInsertMock).toHaveBeenCalledTimes(1);
    expect(dbInsertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      routeId: 22,
      channelId: 11,
      accountId: 33,
      modelRequested: 'gemini-2.5-flash',
      modelActual: 'gemini-2.5-flash',
      status: 'success',
      httpStatus: 200,
      retryCount: 0,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      errorMessage: '[downstream:/v1beta/models/gemini-2.5-flash:generateContent] [upstream:/v1beta/models/gemini-2.5-flash:generateContent]',
      createdAt: expect.any(String),
    }));
  });

  it('keeps returning a successful Gemini response when channel success bookkeeping fails', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'hello despite bookkeeping failure' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    recordSuccessMock.mockImplementation(async () => {
      throw new Error('record success failed');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      responseId: '',
      modelVersion: '',
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ text: 'hello despite bookkeeping failure' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    });
  });

  it('forwards explicit gemini version paths through transformer-owned parsing helpers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'hello from v1 gemini' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/gemini/v1/models/gemini-2.5-flash:generateContent?alt=json',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toContain('/v1/models/gemini-2.5-flash:generateContent');
    expect(targetUrl).toContain('alt=json');
    expect(targetUrl).toContain('key=gemini-key');
    expect(JSON.parse(String(requestInit.body))).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
    });
    expect(response.json().candidates?.[0]?.content?.parts?.[0]?.text).toBe('hello from v1 gemini');
  });

  it('preserves structured Gemini-native fields instead of narrowing them to a bare passthrough shell', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'ok' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 1,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        systemInstruction: {
          parts: [{ text: 'be concise' }],
        },
        cachedContent: 'cached/abc123',
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
        generationConfig: {
          responseModalities: ['TEXT'],
          responseMimeType: 'application/json',
          temperature: 0.2,
          topP: 0.8,
          topK: 20,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingBudget: 512 },
          imageConfig: { aspectRatio: '1:1' },
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'lookup_weather',
                description: 'look up weather',
              },
            ],
          },
        ],
        contents: [
          {
            role: 'user',
            parts: [{ text: 'weather in shanghai' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      systemInstruction: {
        parts: [{ text: 'be concise' }],
      },
      cachedContent: 'cached/abc123',
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      generationConfig: {
        responseModalities: ['TEXT'],
        responseMimeType: 'application/json',
        temperature: 0.2,
        topP: 0.8,
        topK: 20,
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 512 },
        imageConfig: { aspectRatio: '1:1' },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup_weather',
              description: 'look up weather',
            },
          ],
        },
      ],
      contents: [
        {
          role: 'user',
          parts: [{ text: 'weather in shanghai' }],
        },
      ],
    });
  });

  it('keeps non-sse json-array streaming payloads on the wire as raw chunk responses', async () => {
    const upstreamPayload = [
      {
        promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { id: 'tool-1', name: 'lookup_weather', args: { city: 'Shanghai' } },
                  thoughtSignature: 'sig-tool-1',
                },
              ],
            },
            groundingMetadata: { source: 'web' },
          },
        ],
      },
      {
        serverContent: { modelTurn: { parts: [{ text: 'tool result received' }] } },
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'second', thoughtSignature: 'sig-1' }] },
            citationMetadata: { citations: [{ startIndex: 0, endIndex: 5 }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 6,
          totalTokenCount: 17,
          cachedContentTokenCount: 2,
          thoughtsTokenCount: 3,
        },
      },
    ];

    fetchMock.mockResolvedValue(new Response(JSON.stringify(upstreamPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(upstreamPayload);
  });

  it('derives gemini-3 thinkingLevel from OpenAI-style reasoning inputs in the runtime request path', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'gemini-site', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'gemini-key',
      actualModel: 'gemini-3-pro',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'ok' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-pro:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        reasoning_effort: 'high',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
      },
    });
  });

  it('streams SSE payloads as raw upstream events without reserializing tool-calling chunks', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"promptFeedback":{"blockReason":"BLOCK_REASON_UNSPECIFIED"},"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"tool-1","name":"lookup_weather","args":{"city":"Shanghai"}},"thoughtSignature":"sig-tool-1"}]},"groundingMetadata":{"source":"web"}}]}\r\n\r\n'));
        controller.enqueue(encoder.encode('data: {"serverContent":{"modelTurn":{"parts":[{"text":"tool result received"}]}},"candidates":[{"content":{"role":"model","parts":[{"text":"second","thoughtSignature":"sig-1"}]},"citationMetadata":{"citations":[{"startIndex":0,"endIndex":5}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":6,"totalTokenCount":17,"cachedContentTokenCount":2,"thoughtsTokenCount":3}}\r\n\r\n'));
        controller.enqueue(encoder.encode('data: [DONE]\r\n\r\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSsePayloads(response.body);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { id: 'tool-1', name: 'lookup_weather', args: { city: 'Shanghai' } },
                thoughtSignature: 'sig-tool-1',
              },
            ],
          },
          groundingMetadata: { source: 'web' },
        },
      ],
    });
    expect(events[0]).not.toHaveProperty('responseId');
    expect(events[0]).not.toHaveProperty('modelVersion');
    expect(events[0].candidates?.[0]).not.toHaveProperty('finishReason');
    expect(events[1]).toMatchObject({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'tool result received' }],
        },
      },
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 6,
        totalTokenCount: 17,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 3,
      },
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [{ text: 'second', thoughtSignature: 'sig-1' }],
          },
          citationMetadata: { citations: [{ startIndex: 0, endIndex: 5 }] },
        },
      ],
    });
    expect(response.body).toContain('\r\n\r\n');
    expect(response.body).toContain('data: [DONE]\r\n\r\n');
  });

  it('does not retry a Gemini SSE stream when channel success bookkeeping fails after bytes are written', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello after bookkeeping failure"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":4,"totalTokenCount":11}}\r\n\r\n'));
        controller.enqueue(encoder.encode('data: [DONE]\r\n\r\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));
    recordSuccessMock.mockImplementation(async () => {
      throw new Error('record success failed');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('hello after bookkeeping failure');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it('falls back to the next channel when first Gemini channel returns 400 before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'bad request on first channel' },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 400,
      errorText: JSON.stringify({ error: { message: 'bad request on first channel' } }),
    }));
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toContain('key=gemini-key');
    expect(secondUrl).toContain('key=gemini-key-2');
    expect(response.json().candidates?.[0]?.content?.parts?.[0]?.text).toContain('ok from fallback');
  });

  it('falls back to the next channel when first Gemini channel returns 403 before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'forbidden on first channel' },
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 403,
      errorText: JSON.stringify({ error: { message: 'forbidden on first channel' } }),
    }));
  });

  it('falls back to the next channel when first Gemini channel returns 500 before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response('upstream crash', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 500,
      errorText: 'upstream crash',
    }));
  });

  it('falls back to the next channel when first Gemini channel throws before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      errorText: 'socket hang up',
    }));
  });

  it('falls back to the next channel for SSE requests before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"responseId":"resp-fallback","candidates":[{"content":{"role":"model","parts":[{"text":"hello from fallback sse"}]},"finishReason":"STOP"}]}\r\n\r\n'));
        controller.close();
      },
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'upstream unavailable' },
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 500,
      errorText: JSON.stringify({ error: { message: 'upstream unavailable' } }),
    }));
    expect(response.body).toContain('hello from fallback sse');
  });

  it('writes failed and successful proxy log rows for Gemini-native stream retries', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"responseId":"resp-fallback","candidates":[{"content":{"role":"model","parts":[{"text":"hello from fallback sse"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":6,"totalTokenCount":17}}\r\n\r\n'));
        controller.close();
      },
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'upstream unavailable' },
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: {
        'x-goog-api-key': 'managed-gemini-token',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(dbInsertMock).toHaveBeenCalledTimes(2);
    expect(dbInsertValuesMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      channelId: 11,
      status: 'failed',
      httpStatus: 500,
      retryCount: 0,
      // O8 R4（P1/P2）：本行由非 SSE 失败出口（`!upstream.ok`）写。
      // `is_stream` 以前未传（恒 NULL）⇒ 取该请求的真值（本用例是 stream 动作 ⇒ true）；
      // `client_http_status` 以前未传（恒 NULL）⇒ 与本出口 respond 同码（`lastStatus` = 500）。
      isStream: true,
      clientHttpStatus: 500,
      errorMessage: '[downstream:/v1beta/models/gemini-2.5-flash:streamGenerateContent] [upstream:/v1beta/models/gemini-2.5-flash:streamGenerateContent] {\"error\":{\"message\":\"upstream unavailable\"}}',
    }));
    expect(dbInsertValuesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      channelId: 12,
      status: 'success',
      httpStatus: 200,
      retryCount: 1,
      promptTokens: 11,
      completionTokens: 6,
      totalTokens: 17,
      errorMessage: '[downstream:/v1beta/models/gemini-2.5-flash:streamGenerateContent] [upstream:/v1beta/models/gemini-2.5-flash:streamGenerateContent]',
    }));
    // O8 R4（P2）：成功行不动——helper 新增参数必须可选，不传即维持既有行为（该列不写）。
    expect(Object.keys(dbInsertValuesMock.mock.calls[1][0])).not.toContain('clientHttpStatus');
    expect(recordSuccessMock).toHaveBeenCalledWith(12, expect.any(Number), 0, 'gemini-2.5-flash');
  });

  it('writes 200 into client_http_status for a Gemini-native stream that breaks after the first byte', async () => {
    // O8 R4（P2）：流中断出口（上游 SSE 读到一半失败）在 `reply.hijack()` 之后、不再写 respond，
    // 客户端实收恒 200（HTTP 层早已发头）⇒ `client_http_status` 必须是 200，而不是日志里的 502。
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"responseId":"resp-broken","candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}\r\n\r\n'));
      },
      pull(controller) {
        // 首块被消费后才拉第二次 ⇒ 首帧已下发（已 hijack），随后断流。
        controller.error(new Error('terminated'));
      },
    });
    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: { 'x-goog-api-key': 'fixture-managed-gemini-key' },
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });

    expect(response.statusCode).toBe(200);
    expect(dbInsertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      httpStatus: 502,
      isStream: true,
      clientHttpStatus: 200,
    }));
  });

  it('writes the endpoint-layer failure code into client_http_status when the Gemini upstream is unreachable', async () => {
    // O8 R4（P2）+ R6 措辞订正：本夹具的 platform 是 `gemini`（走直连路径），ECONNRESET 实际落在
    // **外层 catch**；本用例钉的是「网络类失败行 cHttp = 502」（与直连 `!upstream.ok` 出口同码）。
    // compat 路径的端点层失败出口（`endpointResult.ok === false`）由本文件下一条 R6 用例覆盖。
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: { 'x-goog-api-key': 'fixture-managed-gemini-key' },
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });

    expect(response.statusCode).toBe(502);
    expect(dbInsertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      httpStatus: 502,
      clientHttpStatus: 502,
    }));
  });

  it('records the observed first-byte latency on the Gemini compat endpoint-layer failure exit', async () => {
    // R6：compat 路径的端点层失败出口（`endpointResult.ok === false`）此前把 `first_byte_latency_ms`
    // 写死 null（托词是「无 upstream 对象」）；实际上 `executeEndpointFlow` 的尝试响应带着观测 meta
    // （`fetchWithObservedFirstByte` 无条件打点）⇒ 现由既有 `onAttemptFailure` 钩子捕获真实首字节延迟。
    selectChannelMock.mockReturnValue({
      channel: { id: 41, routeId: 22 },
      site: { id: 77, name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 37, username: 'openai-user@example.com' },
      tokenName: 'default',
      tokenValue: 'openai-access-token',
      actualModel: 'gpt-4.1',
    });
    // 上游**确实回了**（500 +  JSON 体 ⇒ 已观测到首字节）；错误文本命中同站点端点中止模式，
    // 保证本轮只尝试一个端点，取值归属明确。
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'upstream rate limit exceeded' },
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: { authorization: 'Bearer fixture-managed-gemini-key' },
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });

    expect(response.statusCode).toBe(500);
    const failedRows = dbInsertValuesMock.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((values) => values.status === 'failed');
    // 只应有 1 行（重试轮在 `selectNextChannel` mock 返回空后就地收尾，不再写行）。
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toMatchObject({
      status: 'failed',
      httpStatus: 500,
      isStream: false,
      clientHttpStatus: 500,
      // 关键断言：改前恒为 null。
      firstByteLatencyMs: expect.any(Number),
    });
    // 该行的 errText 带 `[upstream:…]` 前缀（`withUpstreamPath` 打的）⇒ 证明这行来自上游端点层的
    // 真实失败（而非本地异常），且 `first_byte_latency_ms` 已由本轮 `onAttemptFailure` 捕获。
    expect(String(failedRows[0]?.errorMessage)).toContain('upstream rate limit exceeded');
    expect(String(failedRows[0]?.errorMessage)).toContain('[upstream:/v1/responses]');
  });

  it('does not carry a previous round first-byte latency into a later round Gemini failure', async () => {
    // R6 跨轮：轮 0 上游 500（观测到首字节 ⇒ 真值），轮 1 网络类失败（`endpointFlow` 合成的 502 无 meta）。
    // 轮 1 的失败行必须是 null（不得把轮 0 的延迟当成自己的值写出去）。
    selectChannelMock.mockReturnValue({
      channel: { id: 41, routeId: 22 },
      site: { id: 77, name: 'openai-site', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 37, username: 'openai-user@example.com' },
      tokenName: 'default',
      tokenValue: 'openai-access-token',
      actualModel: 'gpt-4.1',
    });
    selectNextChannelMock.mockReturnValue({
      channel: { id: 42, routeId: 22 },
      site: { id: 78, name: 'openai-site-2', url: 'https://api.openai.com', platform: 'openai' },
      account: { id: 38, username: 'openai-user-2@example.com' },
      tokenName: 'fallback',
      tokenValue: 'openai-access-token-2',
      actualModel: 'gpt-4.1',
    });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'upstream rate limit exceeded' },
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockRejectedValue(new Error('ECONNRESET'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: { authorization: 'Bearer fixture-managed-gemini-key' },
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });

    expect(response.statusCode).toBe(502);
    const failedRows = dbInsertValuesMock.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((values) => values.status === 'failed');
    expect(failedRows.length).toBeGreaterThanOrEqual(2);
    // 轮 0 确实观测到了（证明夹具真能产出真值，不是「全都为 null 蒙对了」）。
    expect(failedRows[0]).toMatchObject({ httpStatus: 500, firstByteLatencyMs: expect.any(Number) });
    // 轮 1（及之后）没有观测 ⇒ null，不得沿用轮 0 的值。
    expect(failedRows.at(-1)).toMatchObject({ httpStatus: 502, firstByteLatencyMs: null });
  });
});
