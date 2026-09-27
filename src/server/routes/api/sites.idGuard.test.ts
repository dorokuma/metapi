import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('sites single-item id guard', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-idguard-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function seedSite(id: number): Promise<void> {
    await db.insert(schema.sites).values({
      id,
      name: `site-${id}`,
      url: `https://site-${id}.example.com`,
      platform: 'new-api',
    }).run();
  }

  async function getSite(id: number) {
    return await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
  }

  it('rejects PUT /api/sites/0 with 400 before any write (not 404)', async () => {
    await seedSite(1);
    const before = await db.select().from(schema.sites).all();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/sites/0',
      payload: { name: 'should-not-apply' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toBe('Invalid site id');

    // 不落写：行数与既有行内容均不变。
    const after = await db.select().from(schema.sites).all();
    expect(after).toHaveLength(before.length);
    const seeded = await getSite(1);
    expect(seeded?.name).toBe('site-1');
  });

  it('rejects PUT /api/sites/-1 with 400 before any write (not 404)', async () => {
    await seedSite(1);
    const before = await db.select().from(schema.sites).all();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/sites/-1',
      payload: { name: 'should-not-apply' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toBe('Invalid site id');

    const after = await db.select().from(schema.sites).all();
    expect(after).toHaveLength(before.length);
    const seeded = await getSite(1);
    expect(seeded?.name).toBe('site-1');
  });

  it('rejects DELETE /api/sites/0 with 400 and leaves the positive-id site intact', async () => {
    await seedSite(1);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sites/0',
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toBe('Invalid site id');

    // 目标（正 id）站点未被删。
    const seeded = await getSite(1);
    expect(seeded).not.toBeNull();
    expect(seeded?.id).toBe(1);
    expect(await db.select().from(schema.sites).all()).toHaveLength(1);
  });

  it('rejects DELETE /api/sites/-1 with 400 and leaves the positive-id site intact', async () => {
    await seedSite(1);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sites/-1',
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toBe('Invalid site id');

    const seeded = await getSite(1);
    expect(seeded).not.toBeNull();
    expect(seeded?.id).toBe(1);
    expect(await db.select().from(schema.sites).all()).toHaveLength(1);
  });

  it('still allows DELETE of an existing positive-id site', async () => {
    await seedSite(1);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sites/1',
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { success?: boolean }).success).toBe(true);
    expect(await getSite(1)).toBeUndefined();
  });

  it('still 404s PUT of a positive-id that does not exist', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/sites/999',
      payload: { name: 'missing' },
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error?: string }).error).toBe('Site not found');
  });
});
