import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');
type HydrationModule = typeof import('../../runtimeSettingsHydration.js');
type RulesModule = typeof import('../../services/upstreamParamCompat/rules.js');

// 必须在静态 import（config）之前把 DATA_DIR 指向独立目录，避免写工作树 data/。
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/settings-upstream-param-compat-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

const RAW_RULES = [
  { siteId: 9, model: '*', params: ['prompt_cache_key', 'prompt_cache_retention'] },
  { siteId: 12, model: 'GLM-5.3', params: ['some_param'], endpoints: ['messages'] as const },
];

const STORED_KEYS = ['model', 'params', 'siteId'];

describe('settings upstream param compat runtime settings', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let applyRuntimeSettings: HydrationModule['applyRuntimeSettings'];
  let resolveUpstreamParamCompatParams: RulesModule['resolveUpstreamParamCompatParams'];

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');
    const hydrationModule = await import('../../runtimeSettingsHydration.js');
    const rulesModule = await import('../../services/upstreamParamCompat/rules.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    applyRuntimeSettings = hydrationModule.applyRuntimeSettings;
    resolveUpstreamParamCompatParams = rulesModule.resolveUpstreamParamCompatParams;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatSelfHealEnabled = false;
    config.upstreamParamCompatRules = [];
  });

  afterAll(async () => {
    await app.close();
    rmSync(resolve(testDataDir), { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('persists the three keys, hot-applies them and echoes the raw rule shape without matcher', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamParamCompatEnabled: true,
        upstreamParamCompatSelfHealEnabled: true,
        upstreamParamCompatRules: RAW_RULES,
      },
    });

    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    const updated = updateResponse.json() as Record<string, unknown>;
    expect(updated.upstreamParamCompatEnabled).toBe(true);
    expect(updated.upstreamParamCompatSelfHealEnabled).toBe(true);
    expect(updated.upstreamParamCompatRules).toEqual(RAW_RULES);

    // 热生效：无需重启，运行中的 config 已切换；热路径 resolve 立即可用
    expect(config.upstreamParamCompatEnabled).toBe(true);
    expect(config.upstreamParamCompatSelfHealEnabled).toBe(true);
    expect(config.upstreamParamCompatRules).toHaveLength(2);
    expect(resolveUpstreamParamCompatParams({
      rules: config.upstreamParamCompatRules,
      siteId: 9,
      requestedModel: 'anything',
      endpoint: 'chat',
    })).toEqual(['prompt_cache_key', 'prompt_cache_retention']);
    // 省略 endpoints 的规则不打 messages
    expect(resolveUpstreamParamCompatParams({
      rules: config.upstreamParamCompatRules,
      siteId: 9,
      requestedModel: 'anything',
      endpoint: 'messages',
    })).toEqual([]);
    expect(resolveUpstreamParamCompatParams({
      rules: config.upstreamParamCompatRules,
      siteId: 12,
      requestedModel: 'GLM-5.3',
      endpoint: 'messages',
    })).toEqual(['some_param']);

    // 落库形状 = 原始形状（无 matcher、无双重编码）
    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_param_compat_rules'))
      .get();
    expect(savedRules?.value).toBe(JSON.stringify(RAW_RULES));
    expect(savedRules?.value).not.toContain('match');

    // 三键都落库
    for (const key of [
      'upstream_param_compat_enabled',
      'upstream_param_compat_self_heal_enabled',
      'upstream_param_compat_rules',
    ]) {
      const row = await db.select().from(schema.settings)
        .where(eq(schema.settings.key, key))
        .get();
      expect(row, key).toBeTruthy();
    }

    // GET 回显：归一后的原始形状，无编译残留
    const getResponse = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(getResponse.statusCode).toBe(200);
    const readBack = getResponse.json() as Record<string, unknown>;
    expect(readBack.upstreamParamCompatEnabled).toBe(true);
    expect(readBack.upstreamParamCompatSelfHealEnabled).toBe(true);
    expect(readBack.upstreamParamCompatRules).toEqual(RAW_RULES);
    expect(JSON.stringify(readBack.upstreamParamCompatRules)).not.toContain('match');
    expect(Object.keys((readBack.upstreamParamCompatRules as Array<Record<string, unknown>>)[0]).sort())
      .toEqual(STORED_KEYS);
  });

  it('round-trips through storage so a restart hydration behaves identically', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamParamCompatEnabled: true,
        upstreamParamCompatSelfHealEnabled: false,
        upstreamParamCompatRules: RAW_RULES,
      },
    });
    expect(updateResponse.statusCode).toBe(200);

    const savedRows = await db.select().from(schema.settings).all();
    const byKey = new Map(savedRows.map((row) => [row.key, row.value]));

    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatSelfHealEnabled = true;
    config.upstreamParamCompatRules = [];
    applyRuntimeSettings(new Map([
      ['upstream_param_compat_enabled', byKey.get('upstream_param_compat_enabled')!],
      ['upstream_param_compat_self_heal_enabled', byKey.get('upstream_param_compat_self_heal_enabled')!],
      ['upstream_param_compat_rules', byKey.get('upstream_param_compat_rules')!],
    ]));

    expect(config.upstreamParamCompatEnabled).toBe(true);
    expect(config.upstreamParamCompatSelfHealEnabled).toBe(false);
    expect(config.upstreamParamCompatRules).toHaveLength(2);
    expect(resolveUpstreamParamCompatParams({
      rules: config.upstreamParamCompatRules,
      siteId: 9,
      requestedModel: 'anything',
      endpoint: 'chat',
    })).toEqual(['prompt_cache_key', 'prompt_cache_retention']);
  });

  it('rejects an illegal rule without half-applying the other two keys (three-key atomicity)', async () => {
    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatSelfHealEnabled = false;
    config.upstreamParamCompatRules = [];

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamParamCompatEnabled: true,
        upstreamParamCompatSelfHealEnabled: true,
        upstreamParamCompatRules: [{ siteId: 9, model: '*', params: ['prompt_cache_key', 'model'] }],
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().message).toContain('禁止剥离的结构键：model');

    // 三键原子、不半应用：这三键的 config 与落库都不改
    expect(config.upstreamParamCompatEnabled).toBe(false);
    expect(config.upstreamParamCompatSelfHealEnabled).toBe(false);
    expect(config.upstreamParamCompatRules).toEqual([]);
    for (const key of [
      'upstream_param_compat_enabled',
      'upstream_param_compat_self_heal_enabled',
      'upstream_param_compat_rules',
    ]) {
      const row = await db.select().from(schema.settings)
        .where(eq(schema.settings.key, key))
        .get();
      expect(row, key).toBeUndefined();
    }
  });

  it('rejects invalid booleans and over-sized rules with a 400 without touching the three keys', async () => {
    const cases: Array<{ name: string; payload: Record<string, unknown>; expected: string }> = [
      {
        name: 'bad enabled boolean',
        payload: { upstreamParamCompatEnabled: 'yes' },
        expected: '上游参数兼容层开关格式无效',
      },
      {
        name: 'bad self-heal boolean',
        payload: { upstreamParamCompatSelfHealEnabled: 1 },
        expected: '上游参数兼容层自愈开关格式无效',
      },
      {
        name: '33 params',
        payload: {
          upstreamParamCompatRules: [{
            siteId: 9,
            model: '*',
            params: Array.from({ length: 33 }, (_, i) => `p_${i}`),
          }],
        },
        expected: '超过 32 个',
      },
      {
        name: '65 rules',
        payload: {
          upstreamParamCompatRules: Array.from({ length: 65 }, (_, i) => ({
            siteId: i + 1,
            model: '*',
            params: ['prompt_cache_key'],
          })),
        },
        expected: '超过 64 条',
      },
      {
        name: 'bad endpoints',
        payload: {
          upstreamParamCompatRules: [{ siteId: 1, model: '*', params: ['prompt_cache_key'], endpoints: ['chat', 'x'] }],
        },
        expected: 'endpoints 只能是',
      },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings/runtime',
        payload: testCase.payload,
      });
      expect(response.statusCode, `${testCase.name}: ${response.body}`).toBe(400);
      expect(response.json().message, testCase.name).toContain(testCase.expected);
    }

    expect(config.upstreamParamCompatEnabled).toBe(false);
    expect(config.upstreamParamCompatSelfHealEnabled).toBe(false);
    expect(config.upstreamParamCompatRules).toEqual([]);
    const rows = await db.select().from(schema.settings).all();
    expect(rows.filter((row) => row.key.startsWith('upstream_param_compat_'))).toEqual([]);
  });

  it('keeps the three keys independent when only one is submitted', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamParamCompatEnabled: true,
        upstreamParamCompatSelfHealEnabled: true,
        upstreamParamCompatRules: RAW_RULES,
      },
    });

    const selfHealOnly = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamParamCompatSelfHealEnabled: false },
    });
    expect(selfHealOnly.statusCode).toBe(200);
    expect(config.upstreamParamCompatEnabled).toBe(true);
    expect(config.upstreamParamCompatSelfHealEnabled).toBe(false);
    expect(config.upstreamParamCompatRules).toHaveLength(2);

    const clearRules = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { upstreamParamCompatRules: [] },
    });
    expect(clearRules.statusCode, clearRules.body).toBe(200);
    expect(config.upstreamParamCompatRules).toEqual([]);
    expect(config.upstreamParamCompatEnabled).toBe(true);

    const savedRules = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_param_compat_rules'))
      .get();
    expect(savedRules?.value).toBe(JSON.stringify([]));
  });

  it('applies imported rules through the lenient path: an illegal param voids the whole rule', async () => {
    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatRules = [];

    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/settings/backup/import',
      payload: {
        data: {
          timestamp: Date.now(),
          settings: [
            { key: 'upstream_param_compat_enabled', value: true },
            {
              key: 'upstream_param_compat_rules',
              value: [
                // 非法项（结构键）→ 整条丢弃，同条里的合法键也不生效
                { siteId: 9, model: '*', params: ['prompt_cache_key', 'model'] },
                { siteId: 9, model: '*', params: ['prompt_cache_retention'] },
              ],
            },
          ],
        },
      },
    });

    expect(importResponse.statusCode, importResponse.body).toBe(200);
    expect(config.upstreamParamCompatEnabled).toBe(true);
    expect(config.upstreamParamCompatRules).toHaveLength(1);
    expect(config.upstreamParamCompatRules[0].params).toEqual(['prompt_cache_retention']);
    expect(resolveUpstreamParamCompatParams({
      rules: config.upstreamParamCompatRules,
      siteId: 9,
      requestedModel: 'anything',
      endpoint: 'chat',
    })).toEqual(['prompt_cache_retention']);
  });
});