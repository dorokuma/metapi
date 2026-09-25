import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, inArray } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
type LegacySettingsModule = typeof import('./legacySettings.js');

// 必须在 db 模块求值前把 DATA_DIR 指向独立目录，避免写工作树 data/。
const { testDataDir } = vi.hoisted(() => {
  const dir = `tmp/upstream-detect-legacy-settings-${process.pid}`;
  process.env.DATA_DIR = dir;
  return { testDataDir: dir };
});

describe('legacy upstream provider detect settings cleanup', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dropLegacySetting: LegacySettingsModule['dropLegacyUpstreamProviderDetectPlatformsSetting'];
  let legacyKey: LegacySettingsModule['LEGACY_UPSTREAM_PROVIDER_DETECT_PLATFORMS_KEY'];

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const legacyModule = await import('./legacySettings.js');
    db = dbModule.db;
    schema = dbModule.schema;
    dropLegacySetting = legacyModule.dropLegacyUpstreamProviderDetectPlatformsSetting;
    legacyKey = legacyModule.LEGACY_UPSTREAM_PROVIDER_DETECT_PLATFORMS_KEY;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    rmSync(resolve(testDataDir), { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('drops the legacy host-suffix key without touching the new site-id key', async () => {
    await db.insert(schema.settings).values([
      { key: legacyKey, value: JSON.stringify(['cline.bot']) },
      { key: 'upstream_provider_detect_site_ids', value: JSON.stringify([9]) },
    ]).run();

    await expect(dropLegacySetting()).resolves.toBe(true);

    const rows = await db.select().from(schema.settings)
      .where(inArray(schema.settings.key, [legacyKey, 'upstream_provider_detect_site_ids']))
      .all();
    expect(rows.map((row) => row.key)).toEqual(['upstream_provider_detect_site_ids']);
    expect(rows[0]?.value).toBe(JSON.stringify([9]));
  });

  it('is a no-op when the legacy key is absent', async () => {
    await expect(dropLegacySetting()).resolves.toBe(false);
    expect(await db.select().from(schema.settings).all()).toEqual([]);
  });
});
