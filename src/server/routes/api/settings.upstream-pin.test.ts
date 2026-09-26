import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');
type HydrationModule = typeof import('../../runtimeSettingsHydration.js');
type RulesModule = typeof import('../../services/upstreamProviderPin/rules.js');
type AdapterMapModule = typeof import('../../services/upstreamProviderPin/adapterMap.js');

// 必须在静态 import（config）之前把 DATA_DIR 指向独立目录，避免写工作树 data/。
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/settings-upstream-pin-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

const RAW_RULES = [
  { siteId: 49, model: 'cline-pass/*', providers: ['deepseek', 'alibaba'], mode: 'order' as const },
  { siteId: 7, model: 'exact/model', providers: ['baseten'], mode: 'only' as const },
];

const STORED_KEYS = ['mode', 'model', 'providers', 'siteId'];

describe('settings upstream provider pin runtime settings', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let applyRuntimeSettings: HydrationModule['applyRuntimeSettings'];
  let resolveUpstreamProviderPin: RulesModule['resolveUpstreamProviderPin'];
  let resolveUpstreamPinAdapter: AdapterMapModule['resolveUpstreamPinAdapter'];
  let toStoredAdapterMap: AdapterMapModule['toStoredAdapterMap'];

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');
    const hydrationModule = await import('../../runtimeSettingsHydration.js');
    const rulesModule = await import('../../services/upstreamProviderPin/rules.js');
    const adapterMapModule = await import('../../services/upstreamProviderPin/adapterMap.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    applyRuntimeSettings = hydrationModule.applyRuntimeSettings;
    resolveUpstreamProviderPin = rulesModule.resolveUpstreamProviderPin;
    resolveUpstreamPinAdapter = adapterMapModule.resolveUpstreamPinAdapter;
    toStoredAdapterMap = adapterMapModule.toStoredAdapterMap;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];
  });

  afterAll(async () => {
    await app.close();
    rmSync(resolve(testDataDir), { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('persists the pin settings, hot-applies them and echoes the raw four-field shape', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: RAW_RULES,
      },
    });

    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    const updated = updateResponse.json() as Record<string, unknown>;
    expect(updated.upstreamProviderPinEnabled).toBe(true);
    expect(updated.upstreamProviderPinRules).toEqual(RAW_RULES);

    // 热生效：无需重启，运行中的 config 已切换；热路径 resolve 立即可命中
    expect(config.upstreamProviderPinEnabled).toBe(true);
    expect(config.upstreamProviderPinRules).toHaveLength(2);
    expect(resolveUpstreamProviderPin({
      siteId: 49,
      requestedModel: 'cline-pass/deepseek-v4.1-flash',
    })).toEqual({ providers: ['deepseek', 'alibaba'], mode: 'order' });
    expect(resolveUpstreamProviderPin({
      siteId: 7,
      requestedModel: 'exact/model',
    })).toEqual({ providers: ['baseten'], mode: 'only' });
    expect(resolveUpstreamProviderPin({
      siteId: 49,
      requestedModel: 'exact/model',
    })).toBeNull();

    // 落库形状 = 四字段原始形状（无 matcher/正则编译产物、无双重编码）
    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_rules'))
      .get();
    expect(savedRules?.value).toBe(JSON.stringify(RAW_RULES));
    expect(savedRules?.value).not.toContain('match');
    expect(JSON.parse(savedRules!.value)).toEqual(RAW_RULES);

    const savedEnabled = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_enabled'))
      .get();
    expect(savedEnabled?.value).toBe(JSON.stringify(true));

    // GET 回显：归一后的四字段原始形状，逐元素键集合恰为四字段，无编译残留
    const getResponse = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(getResponse.statusCode).toBe(200);
    const readBack = getResponse.json() as Record<string, unknown>;
    expect(readBack.upstreamProviderPinEnabled).toBe(true);
    expect(readBack.upstreamProviderPinRules).toEqual(RAW_RULES);
    for (const rule of readBack.upstreamProviderPinRules as Array<Record<string, unknown>>) {
      expect(Object.keys(rule).sort()).toEqual(STORED_KEYS);
    }
    expect(JSON.stringify(readBack.upstreamProviderPinRules)).not.toContain('match');
  });

  it('round-trips through storage so a restart hydration behaves identically', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: RAW_RULES,
      },
    });
    expect(updateResponse.statusCode).toBe(200);

    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_rules'))
      .get();
    expect(savedRules).toBeTruthy();
    const storedRaw = JSON.parse(savedRules!.value) as Array<Record<string, unknown>>;

    // 落库字符串为四字段原始形状，不含任何编译产物
    expect(storedRaw).toEqual(RAW_RULES);
    for (const rule of storedRaw) {
      expect(Object.keys(rule).sort()).toEqual(STORED_KEYS);
    }
    expect(savedRules!.value).not.toContain('match');
    expect(savedRules!.value).not.toContain('RegExp');

    // 模拟一次重启 hydration：清空运行态后，仅用落库字符串重建 settingsMap
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];
    const savedEnabled = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_enabled'))
      .get();
    applyRuntimeSettings(new Map([
      ['upstream_provider_pin_enabled', savedEnabled!.value],
      ['upstream_provider_pin_rules', savedRules!.value],
    ]));

    // 规则数与命中行为与 PUT 后一致（重启等价）
    expect(config.upstreamProviderPinRules).toHaveLength(RAW_RULES.length);
    expect(resolveUpstreamProviderPin({
      siteId: 49,
      requestedModel: 'cline-pass/deepseek-v4.1-flash',
    })).toEqual({ providers: ['deepseek', 'alibaba'], mode: 'order' });
    expect(resolveUpstreamProviderPin({
      siteId: 7,
      requestedModel: 'exact/model',
    })).toEqual({ providers: ['baseten'], mode: 'only' });
  });

  it('accepts a JSON string body for rules (W-4) and persists the parsed shape', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderPinRules: JSON.stringify([RAW_RULES[1]]),
      },
    });

    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    const updated = updateResponse.json() as Record<string, unknown>;
    expect(updated.upstreamProviderPinRules).toEqual([RAW_RULES[1]]);
    expect(config.upstreamProviderPinRules).toHaveLength(1);

    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_rules'))
      .get();
    expect(JSON.parse(savedRules!.value)).toEqual([RAW_RULES[1]]);
  });

  it('rejects invalid rules with a 400 and a specific Chinese message without touching runtime state', async () => {
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];

    const cases: Array<{ name: string; value: unknown; expected: string }> = [
      { name: 'malformed string', value: '{not json', expected: '不是合法的 JSON' },
      { name: 'non-array', value: { siteId: 1 }, expected: '必须是数组' },
      { name: 'non-object item', value: ['rule'], expected: '必须是对象' },
      {
        name: 'empty providers',
        value: [{ siteId: 1, model: 'm', providers: [], mode: 'only' }],
        expected: 'providers 不能为空',
      },
      {
        name: 'bad mode',
        value: [{ siteId: 1, model: 'm', providers: ['a'], mode: 'first' }],
        expected: 'mode 只能是 only 或 order',
      },
      {
        name: 'duplicate site + model',
        value: [
          { siteId: 1, model: 'm', providers: ['a'], mode: 'only' },
          { siteId: 1, model: 'm', providers: ['b'], mode: 'order' },
        ],
        expected: '存在重复规则',
      },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings/runtime',
        payload: { upstreamProviderPinRules: testCase.value },
      });
      expect(response.statusCode, `${testCase.name}: ${response.body}`).toBe(400);
      expect(response.json().message, testCase.name).toContain(testCase.expected);
    }

    // 校验失败不触碰运行态，也不落库
    expect(config.upstreamProviderPinEnabled).toBe(false);
    expect(config.upstreamProviderPinRules).toEqual([]);
    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_rules'))
      .get();
    expect(savedRules).toBeUndefined();
  });

  it('rejects invalid rules before applying the enabled toggle (R-A: no partial apply)', async () => {
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: [{ siteId: 1, model: 'm', providers: ['a'], mode: 'nope' }],
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().message).toContain('mode 只能是 only 或 order');

    // R-A：rules 非法时 enabled 不被改写、不落库（整段无部分应用）
    expect(config.upstreamProviderPinEnabled).toBe(false);
    expect(config.upstreamProviderPinRules).toEqual([]);
    const savedEnabled = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_enabled'))
      .get();
    expect(savedEnabled).toBeUndefined();
  });

  it('clears all rules with an empty array so nothing is injected', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamProviderPinEnabled: true, upstreamProviderPinRules: RAW_RULES },
    });
    expect(config.upstreamProviderPinRules).toHaveLength(2);

    const clearResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamProviderPinRules: [] },
    });
    expect(clearResponse.statusCode, clearResponse.body).toBe(200);
    expect(clearResponse.json().upstreamProviderPinRules).toEqual([]);
    expect(config.upstreamProviderPinEnabled).toBe(true);
    expect(config.upstreamProviderPinRules).toEqual([]);
    expect(resolveUpstreamProviderPin({
      siteId: 49,
      requestedModel: 'cline-pass/deepseek-v4.1-flash',
    })).toBeNull();

    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_rules'))
      .get();
    expect(savedRules?.value).toBe(JSON.stringify([]));
  });

  it('keeps the two pin keys independent when only one is submitted', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamProviderPinEnabled: true, upstreamProviderPinRules: RAW_RULES },
    });

    // 只提交开关：规则保持不动
    const toggleOnly = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamProviderPinEnabled: false },
    });
    expect(toggleOnly.statusCode).toBe(200);
    expect(config.upstreamProviderPinEnabled).toBe(false);
    expect(config.upstreamProviderPinRules).toHaveLength(2);

    // 只提交规则：开关保持不动
    const rulesOnly = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamProviderPinRules: [RAW_RULES[0]] },
    });
    expect(rulesOnly.statusCode).toBe(200);
    expect(config.upstreamProviderPinEnabled).toBe(false);
    expect(config.upstreamProviderPinRules).toHaveLength(1);
  });

  // ---- Phase 1 适配器映射追加用例（不改动上方既有断言） ----

  const ADAPTER_MAP_PAYLOAD = { '49': 'openrouter', '7': 'vercel-ai-gateway' };

  it('persists the adapter map, hot-applies it and round-trips through storage (S3)', async () => {
    config.upstreamProviderPinAdapterMap = {};

    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: RAW_RULES,
        upstreamProviderPinAdapterMap: ADAPTER_MAP_PAYLOAD,
      },
    });

    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    const updated = updateResponse.json() as Record<string, unknown>;
    expect(updated.upstreamProviderPinAdapterMap).toEqual(ADAPTER_MAP_PAYLOAD);

    // 热生效：config 持有编译形态（siteId 数字键），无需重启即可解析
    expect(config.upstreamProviderPinAdapterMap).toEqual({ 49: 'openrouter', 7: 'vercel-ai-gateway' });
    expect(resolveUpstreamPinAdapter(49).id).toBe('openrouter');
    expect(resolveUpstreamPinAdapter(7).id).toBe('vercel-ai-gateway');
    expect(resolveUpstreamPinAdapter(9).id).toBe('generic-dual');

    // 落库形状 = 原始对象（无编译产物、无双重编码）；键集合恰为站点 id 字符串
    const savedMap = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_adapter_map'))
      .get();
    expect(savedMap?.value).toBe(JSON.stringify({ 49: 'openrouter', 7: 'vercel-ai-gateway' }));
    expect(Object.keys(JSON.parse(savedMap!.value)).sort()).toEqual(['49', '7']);

    // GET 回显：数字键归一为字符串键，与落库/重启形状一致
    const getResponse = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(getResponse.statusCode).toBe(200);
    const readBack = getResponse.json() as Record<string, unknown>;
    expect(readBack.upstreamProviderPinAdapterMap).toEqual(ADAPTER_MAP_PAYLOAD);

    // 往返 = 重启等价：清空运行态后仅用落库字符串重建，解析结果与 GET/落库一致
    config.upstreamProviderPinAdapterMap = {};
    const savedEnabled = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_enabled'))
      .get();
    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_rules'))
      .get();
    applyRuntimeSettings(new Map([
      ['upstream_provider_pin_enabled', savedEnabled!.value],
      ['upstream_provider_pin_rules', savedRules!.value],
      ['upstream_provider_pin_adapter_map', savedMap!.value],
    ]));
    expect(resolveUpstreamPinAdapter(49).id).toBe('openrouter');
    expect(toStoredAdapterMap(config.upstreamProviderPinAdapterMap)).toEqual(ADAPTER_MAP_PAYLOAD);
  });

  it('rejects an invalid adapter map before applying enabled / rules (M1: no partial apply)', async () => {
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];
    config.upstreamProviderPinAdapterMap = {};

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: RAW_RULES,
        upstreamProviderPinAdapterMap: { '49': 'portkey' },
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().message).toContain('不在支持列表');

    // 三键一次保存：map 非法 → enabled / rules / map 的 config 与落库全部不变
    expect(config.upstreamProviderPinEnabled).toBe(false);
    expect(config.upstreamProviderPinRules).toEqual([]);
    expect(config.upstreamProviderPinAdapterMap).toEqual({});
    for (const key of [
      'upstream_provider_pin_enabled',
      'upstream_provider_pin_rules',
      'upstream_provider_pin_adapter_map',
    ]) {
      const saved = await db.select().from(schema.settings)
        .where(eq(schema.settings.key, key))
        .get();
      expect(saved, key).toBeUndefined();
    }
  });

  it('rejects malformed adapter maps with specific Chinese messages without touching runtime state', async () => {
    config.upstreamProviderPinAdapterMap = {};

    const cases: Array<{ name: string; value: unknown; expected: string }> = [
      { name: 'malformed string', value: '{not json', expected: '不是合法的 JSON' },
      { name: 'array payload', value: [1], expected: '必须是对象' },
      { name: 'fractional key', value: { '49.9': 'openrouter' }, expected: '必须是正整数站点 id' },
      { name: 'zero key', value: { '0': 'openrouter' }, expected: '必须是正整数站点 id' },
      { name: 'unregistered id', value: { '49': 'litellm' }, expected: '不在支持列表' },
      { name: 'non-string value', value: { '49': 42 }, expected: '必须是' },
      { name: 'duplicate normalized keys', value: { '49 ': 'openrouter', '049': 'none' }, expected: '存在重复' },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings/runtime',
        payload: { upstreamProviderPinAdapterMap: testCase.value },
      });
      expect(response.statusCode, `${testCase.name}: ${response.body}`).toBe(400);
      expect(response.json().message, testCase.name).toContain(testCase.expected);
    }

    expect(config.upstreamProviderPinAdapterMap).toEqual({});
    const saved = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_adapter_map'))
      .get();
    expect(saved).toBeUndefined();
  });

  it('keeps the existing adapter map when a two-key (legacy frontend) PUT omits it (S6②)', async () => {
    config.upstreamProviderPinAdapterMap = {};

    const mapOnly = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamProviderPinAdapterMap: { '49': 'openrouter' } },
    });
    expect(mapOnly.statusCode, mapOnly.body).toBe(200);
    expect(config.upstreamProviderPinAdapterMap).toEqual({ 49: 'openrouter' });

    const legacyPut = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamProviderPinEnabled: false, upstreamProviderPinRules: RAW_RULES },
    });
    expect(legacyPut.statusCode, legacyPut.body).toBe(200);

    // 不带 map 键 → 既有 map 不被清空（对照 payloadRules 先例）
    expect(config.upstreamProviderPinAdapterMap).toEqual({ 49: 'openrouter' });
    const saved = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_pin_adapter_map'))
      .get();
    expect(JSON.parse(saved!.value)).toEqual({ '49': 'openrouter' });
    expect(resolveUpstreamPinAdapter(49).id).toBe('openrouter');
  });
});
