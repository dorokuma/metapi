import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../config.js';
import { buildUpstreamEndpointRequest } from '../../services/upstreamRequestBuilder.js';
import { normalizeUpstreamProviderPinRules } from '../../services/upstreamProviderPin/rules.js';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';

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
  invalidateTokenRouterCache: vi.fn(),
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

type DbModule = typeof import('../../db/index.js');

// Must run before the static `config` import is evaluated so the sqlite runtime
// DB (config.dataDir) points at a test-only directory instead of repo `data/`.
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/upstream-provider-pin-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

/**
 * 端到端四态：① 开关开+规则命中 → 注入两类字段；② 模型不命中；③ 站点不命中；④ 未传 siteId。
 * ②③ 与关闭开关的基线 body 逐字节相等，④ 直接用 builder 断言不注入。
 */
describe('upstream provider pin injection end to end', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  const dataDir = testDataDir;
  const originalPinSettings = {
    enabled: config.upstreamProviderPinEnabled,
    rules: config.upstreamProviderPinRules,
  };
  const originalDetectEnabled = config.upstreamProviderDetectEnabled;

  const OPENAI_CHAT_RESPONSE = {
    id: 'chatcmpl-pin-test',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek/deepseek-v4.1-flash',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };

  async function seedSite(input: { url: string; platform?: string; preferredEndpoint?: string }) {
    const site = await db.insert(schema.sites).values({
      name: `site-${input.url}`,
      url: input.url,
      platform: input.platform ?? 'openai',
      preferredEndpoint: input.preferredEndpoint ?? '',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${site.id}`,
      accessToken: '',
      apiToken: 'sk-cline',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: `${input.url.replace(/\/+$/, '')}/api`,
      enabled: true,
      sortOrder: 0,
    }).run();
    return { site, account };
  }

  function selectSeededChannel(seeded: { site: any; account: any }) {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: seeded.site,
      account: seeded.account,
      tokenName: 'default',
      tokenValue: 'sk-cline',
      actualModel: 'deepseek/deepseek-v4.1-flash',
    });
  }

  async function sendChatRequest() {
    return app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer downstream-key' },
      payload: {
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
  }

  function getLastUpstreamBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.at(-1);
    const init = call?.[1] as { body?: unknown } | undefined;
    return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  }

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;

    const routesModule = await import('./chat.js');
    app = Fastify();
    await app.register(routesModule.chatProxyRoute);
  });

  beforeEach(async () => {
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
    fetchModelPricingCatalogMock.mockClear();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    resetUpstreamEndpointRuntimeState();

    // 钉选默认关闭；上游探测关闭，避免旁路记录干扰本测试。
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];
    config.upstreamProviderDetectEnabled = false;
    config.proxyErrorKeywords = [];
    config.proxyEmptyContentFailEnabled = false;
    (config as any).openAiServiceTierRules = undefined;
    (config as any).disableCrossProtocolFallback = false;

    selectNextChannelMock.mockReturnValue(null);
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
      usageSource: 'upstream',
      estimatedCostFromQuota: 0,
      recoveredFromSelfLog: false,
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(OPENAI_CHAT_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await db.delete(schema.upstreamProviderObservations).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    await closeDbConnections();
    delete process.env.DATA_DIR;
    config.upstreamProviderPinEnabled = originalPinSettings.enabled;
    config.upstreamProviderPinRules = originalPinSettings.rules;
    config.upstreamProviderDetectEnabled = originalDetectEnabled;
    rmSync(resolve(dataDir), { recursive: true, force: true });
  });

  it('① injects both field shapes into the upstream body when the rule hits', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id, model: 'deepseek/deepseek-v4.1-flash', providers: ['deepseek'], mode: 'only' },
    ]);
    selectSeededChannel(seeded);

    const response = await sendChatRequest();
    expect(response.statusCode, response.body).toBe(200);

    const upstreamBody = getLastUpstreamBody();
    expect(upstreamBody.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    expect(upstreamBody.provider).toEqual({ only: ['deepseek'] });
    // 不改既有键（platform=openai 站点首选 responses 面，body 为 responses 形状）
    expect(upstreamBody.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(upstreamBody.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('①c injects into the chat endpoint body when the site pins chat', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot', preferredEndpoint: 'chat' });
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id, model: 'deepseek/deepseek-v4.1-flash', providers: ['deepseek'], mode: 'only' },
    ]);
    selectSeededChannel(seeded);

    const response = await sendChatRequest();
    expect(response.statusCode, response.body).toBe(200);

    const upstreamBody = getLastUpstreamBody();
    expect(upstreamBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(upstreamBody.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    expect(upstreamBody.provider).toEqual({ only: ['deepseek'] });
  });

  it('①b injects the order form and strips any only residue', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id, model: '*', providers: ['deepseek', 'alibaba'], mode: 'order' },
    ]);
    selectSeededChannel(seeded);

    const response = await sendChatRequest();
    expect(response.statusCode, response.body).toBe(200);

    const upstreamBody = getLastUpstreamBody();
    expect(upstreamBody.providerOptions).toEqual({
      gateway: { order: ['deepseek', 'alibaba'] },
    });
    expect(upstreamBody.provider).toEqual({ order: ['deepseek', 'alibaba'] });
    expect(JSON.stringify(upstreamBody)).not.toContain('"only"');
  });

  it('② leaves the body byte-identical to the baseline when the model does not hit', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    selectSeededChannel(seeded);

    const baselineResponse = await sendChatRequest();
    expect(baselineResponse.statusCode, baselineResponse.body).toBe(200);
    const baselineBody = getLastUpstreamBody();

    fetchMock.mockClear();
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id, model: 'other/model', providers: ['deepseek'], mode: 'only' },
    ]);

    const missResponse = await sendChatRequest();
    expect(missResponse.statusCode, missResponse.body).toBe(200);
    const missBody = getLastUpstreamBody();

    expect(JSON.stringify(missBody)).toBe(JSON.stringify(baselineBody));
    expect(missBody.provider).toBeUndefined();
    expect(missBody.providerOptions).toBeUndefined();
  });

  it('③ leaves the body byte-identical to the baseline when the site does not hit', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    selectSeededChannel(seeded);

    const baselineResponse = await sendChatRequest();
    expect(baselineResponse.statusCode, baselineResponse.body).toBe(200);
    const baselineBody = getLastUpstreamBody();

    fetchMock.mockClear();
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id + 1, model: '*', providers: ['deepseek'], mode: 'only' },
    ]);

    const missResponse = await sendChatRequest();
    expect(missResponse.statusCode, missResponse.body).toBe(200);
    const missBody = getLastUpstreamBody();

    expect(JSON.stringify(missBody)).toBe(JSON.stringify(baselineBody));
    expect(missBody.provider).toBeUndefined();
    expect(missBody.providerOptions).toBeUndefined();
  });

  it('④ never injects on call paths that do not pass a siteId', () => {
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: 49, model: '*', providers: ['deepseek'], mode: 'only' },
    ]);

    // WS 调用点 / 测活调用点的等价形态：同一构造器、不传 siteId
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      tokenValue: 'sk-cline',
      sitePlatform: 'openai',
      openaiBody: {
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.body.provider).toBeUndefined();
    expect(request.body.providerOptions).toBeUndefined();
    expect(request.body).toEqual({
      model: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  // ---- Phase 1 适配器分型 E2E（S4：追加用例，不改动上方四态断言） ----

  it('①d routes the openrouter adapter to top-level provider.only only (chat path)', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot', preferredEndpoint: 'chat' });
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id, model: 'deepseek/deepseek-v4.1-flash', providers: ['deepseek'], mode: 'only' },
    ]);
    const originalAdapterMap = config.upstreamProviderPinAdapterMap;
    config.upstreamProviderPinAdapterMap = { [seeded.site.id]: 'openrouter' };
    selectSeededChannel(seeded);

    try {
      const response = await sendChatRequest();
      expect(response.statusCode, response.body).toBe(200);

      const upstreamBody = getLastUpstreamBody();
      expect(upstreamBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(upstreamBody.provider).toEqual({ only: ['deepseek'] });
      // OpenRouter 忽略嵌套位：不得写入 providerOptions.gateway
      expect(upstreamBody.providerOptions).toBeUndefined();
      const serialized = JSON.stringify(upstreamBody);
      expect(serialized).not.toContain('"order"');
      // allow_fallbacks 不写不动（S1 精神：只写原生 only/order 键）
      expect(serialized).not.toContain('allow_fallbacks');
    } finally {
      config.upstreamProviderPinAdapterMap = originalAdapterMap;
    }
  });

  it('①e routes the openrouter adapter to top-level provider.order only (chat path)', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot', preferredEndpoint: 'chat' });
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id, model: 'deepseek/deepseek-v4.1-flash', providers: ['deepseek', 'alibaba'], mode: 'order' },
    ]);
    const originalAdapterMap = config.upstreamProviderPinAdapterMap;
    config.upstreamProviderPinAdapterMap = { [seeded.site.id]: 'openrouter' };
    selectSeededChannel(seeded);

    try {
      const response = await sendChatRequest();
      expect(response.statusCode, response.body).toBe(200);

      const upstreamBody = getLastUpstreamBody();
      expect(upstreamBody.provider).toEqual({ order: ['deepseek', 'alibaba'] });
      expect(upstreamBody.providerOptions).toBeUndefined();
      const serialized = JSON.stringify(upstreamBody);
      expect(serialized).not.toContain('"only"');
      expect(serialized).not.toContain('allow_fallbacks');
    } finally {
      config.upstreamProviderPinAdapterMap = originalAdapterMap;
    }
  });

  it('①f zero-injects for the none adapter on the responses default path (byte-identical to disabled baseline)', async () => {
    const seeded = await seedSite({ url: 'https://api.cline.bot' });
    selectSeededChannel(seeded);

    // 关闭态基线（platform=openai 站点首选 responses 面）
    const baselineResponse = await sendChatRequest();
    expect(baselineResponse.statusCode, baselineResponse.body).toBe(200);
    const baselineBody = getLastUpstreamBody();

    fetchMock.mockClear();
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: seeded.site.id, model: 'deepseek/deepseek-v4.1-flash', providers: ['deepseek'], mode: 'only' },
    ]);
    const originalAdapterMap = config.upstreamProviderPinAdapterMap;
    config.upstreamProviderPinAdapterMap = { [seeded.site.id]: 'none' };

    try {
      const zeroResponse = await sendChatRequest();
      expect(zeroResponse.statusCode, zeroResponse.body).toBe(200);
      const zeroBody = getLastUpstreamBody();

      // 能力不匹配/显式 no-op：与关闭态基线逐字节相等
      expect(JSON.stringify(zeroBody)).toBe(JSON.stringify(baselineBody));
      expect(zeroBody.provider).toBeUndefined();
      expect(zeroBody.providerOptions).toBeUndefined();
    } finally {
      config.upstreamProviderPinAdapterMap = originalAdapterMap;
    }
  });
});
