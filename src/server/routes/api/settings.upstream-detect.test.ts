import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

// 必须在静态 import（config）之前把 DATA_DIR 指向独立目录，避免写工作树 data/。
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/settings-upstream-detect-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

describe('settings upstream provider detect runtime settings', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    config.upstreamProviderDetectEnabled = false;
    config.upstreamProviderDetectSampleRate = 1;
    config.upstreamProviderDetectRetentionDays = 14;
    config.upstreamProviderDetectSiteIds = [];
  });

  afterAll(async () => {
    await app.close();
    rmSync(resolve(testDataDir), { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('persists the participating-site selection under the new key and hot-applies it', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderDetectEnabled: true,
        upstreamProviderDetectSampleRate: 0.5,
        upstreamProviderDetectRetentionDays: 7,
        // 数字、数字字符串、重复值与非法值混合：服务端归一化后落库
        upstreamProviderDetectSiteIds: [9, '12', 9, 0, -3, 'bad'],
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as Record<string, unknown>;
    expect(updated.upstreamProviderDetectEnabled).toBe(true);
    expect(updated.upstreamProviderDetectSampleRate).toBe(0.5);
    expect(updated.upstreamProviderDetectRetentionDays).toBe(7);
    expect(updated.upstreamProviderDetectSiteIds).toEqual([9, 12]);

    // 热生效：无需重启，运行中的 config 已切换为参与站点集合
    expect(config.upstreamProviderDetectEnabled).toBe(true);
    expect(config.upstreamProviderDetectSampleRate).toBe(0.5);
    expect(config.upstreamProviderDetectRetentionDays).toBe(7);
    expect(config.upstreamProviderDetectSiteIds).toEqual([9, 12]);

    const savedSiteIds = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_detect_site_ids'))
      .get();
    expect(savedSiteIds?.value).toBe(JSON.stringify([9, 12]));

    const getResponse = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(getResponse.statusCode).toBe(200);
    const readBack = getResponse.json() as Record<string, unknown>;
    expect(readBack.upstreamProviderDetectEnabled).toBe(true);
    expect(readBack.upstreamProviderDetectSampleRate).toBe(0.5);
    expect(readBack.upstreamProviderDetectRetentionDays).toBe(7);
    expect(readBack.upstreamProviderDetectSiteIds).toEqual([9, 12]);
  });

  it('ignores the removed legacy platforms key and never writes it back', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderDetectEnabled: false,
        upstreamProviderDetectSiteIds: [4],
        // 旧键（host 后缀列表）已移除：请求里带上也不再产生任何效果
        upstreamProviderDetectPlatforms: ['cline.bot'],
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as Record<string, unknown>;
    expect(updated.upstreamProviderDetectSiteIds).toEqual([4]);
    expect(config.upstreamProviderDetectSiteIds).toEqual([4]);

    const legacySaved = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_detect_platforms'))
      .get();
    expect(legacySaved).toBeUndefined();
  });

  it('allows clearing the selection so nothing is collected', async () => {
    config.upstreamProviderDetectEnabled = true;
    config.upstreamProviderDetectSiteIds = [9];

    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        upstreamProviderDetectSiteIds: [],
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(config.upstreamProviderDetectSiteIds).toEqual([]);
    const savedSiteIds = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'upstream_provider_detect_site_ids'))
      .get();
    expect(savedSiteIds?.value).toBe(JSON.stringify([]));
  });
});
