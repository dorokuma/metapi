import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('settings runtime notification templates api', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-notif-templates-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const settingsRoutesModule = await import('./settings.js');

    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.notificationTemplates).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('accepts the legacy flat payload and stores it as __global__', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      // 历史扁平格式：顶层直接是渠道键
      payload: { notificationTemplates: { telegram: { body: 'FLAT {{title}}' } } },
    });
    expect(put.statusCode).toBe(200);

    const stored = await db.select().from(schema.notificationTemplates)
      .where(eq(schema.notificationTemplates.eventType, '__global__'))
      .all();
    expect(stored.map((row) => ({ channel: row.channel, body: row.body }))).toEqual([
      { channel: 'telegram', body: 'FLAT {{title}}' },
    ]);

    const get = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { notificationTemplates: Record<string, unknown> }).notificationTemplates)
      .toEqual({ __global__: { telegram: { body: 'FLAT {{title}}' } } });
  });

  it('accepts the two-layer payload and rejects invalid structures', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        notificationTemplates: {
          __global__: { telegram: { body: 'GLOBAL {{message}}' } },
          token: { bark: { title: 'T', body: 'TOKEN {{message}}' } },
        },
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect((get.json() as { notificationTemplates: Record<string, unknown> }).notificationTemplates)
      .toEqual({
        __global__: { telegram: { body: 'GLOBAL {{message}}' } },
        token: { bark: { title: 'T', body: 'TOKEN {{message}}' } },
      });

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { notificationTemplates: { notAnEvent: { telegram: { body: 'x' } } } },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
