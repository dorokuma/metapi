import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');

describe('settings oauth site autocreate runtime api', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-oauth-autocreate-'));
    process.env.DATA_DIR = dataDir;

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
    config.oauthProviderSiteAutoCreateEnabled = true;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
    config.oauthProviderSiteAutoCreateEnabled = true;
  });

  it('keeps GET in sync with PUT and persists the flag', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(initial.statusCode).toBe(200);
    expect((initial.json() as { oauthProviderSiteAutoCreateEnabled?: boolean }).oauthProviderSiteAutoCreateEnabled).toBe(true);

    const disabled = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { oauthProviderSiteAutoCreateEnabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    // PUT 之后 GET 必须立即反映新值：此前只写库不同步 config，刷新后回弹。
    const afterOff = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect((afterOff.json() as { oauthProviderSiteAutoCreateEnabled?: boolean }).oauthProviderSiteAutoCreateEnabled).toBe(false);

    const stored = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'oauth_provider_site_autocreate_enabled'))
      .get();
    expect(stored?.value).toBe('false');

    const reEnabled = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { oauthProviderSiteAutoCreateEnabled: true },
    });
    expect(reEnabled.statusCode).toBe(200);
    const afterOn = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect((afterOn.json() as { oauthProviderSiteAutoCreateEnabled?: boolean }).oauthProviderSiteAutoCreateEnabled).toBe(true);
  });

  it('rejects non-boolean values', async () => {
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { oauthProviderSiteAutoCreateEnabled: 'yes' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
