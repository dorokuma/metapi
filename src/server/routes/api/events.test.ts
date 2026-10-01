import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETRY_EXHAUSTED_EVENT_TITLE } from '../../shared/eventTitles.js';

type DbModule = typeof import('../../db/index.js');

describe('events routes notification-center exclusion', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'] | undefined;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-events-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const eventsRoutesModule = await import('./events.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;

    app = Fastify();
    await app.register(eventsRoutesModule.eventsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (typeof closeDbConnections === 'function') {
      await closeDbConnections();
    }
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  it('excludes the retry-exhausted marker title from /api/events on both branches while keeping other titles', async () => {
    await db.insert(schema.events).values([
      {
        // 生产写入即为已读（`insertRetryExhaustedEvent`）；此处不看 read 条件，
        // 走的是不带 `read` 的 `?type=proxy` 分支 ⇒ 缺席只能由「按 title 排除」解释。
        type: 'proxy',
        title: RETRY_EXHAUSTED_EVENT_TITLE,
        message: 'retry exhausted: HTTP 429: rate limited',
        level: 'error',
        read: true,
        relatedType: 'route',
        createdAt: '2026-03-20 10:00:02',
      },
      {
        // 对照事件：同 type / 同 level / 同 read，仅 title 不同 ⇒ 证明不是整表被清空或过度过滤。
        type: 'proxy',
        title: '代理全部失败',
        message: 'No available channels after retries',
        level: 'error',
        read: true,
        relatedType: 'route',
        createdAt: '2026-03-20 10:00:01',
      },
    ]).run();

    const unfiltered = await app.inject({ method: 'GET', url: '/api/events' });
    expect(unfiltered.statusCode).toBe(200);
    expect((unfiltered.json() as Array<{ title: string }>).map((row) => row.title)).toEqual(['代理全部失败']);

    // 带 `filters` 的分支（`?type=proxy` 两条都命中 type，缺席只可能是 title 被排除）。
    const filtered = await app.inject({ method: 'GET', url: '/api/events?type=proxy' });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json() as Array<{ title: string }>).map((row) => row.title)).toEqual(['代理全部失败']);

    // `?read=true` × 排除（新过滤组合的守护）：标记行生产形态即 `read: true` ⇒ 该分支下 `read`
    // 过滤**不**遮盖它（与 case ② 的未读计数相反，那里的 `read = false` 条件会把它遮住）。
    // 故它若出现在结果里，只可能是「按 title 排除」失效 ⇒ 移除 `ne(...)` 本断言即 FAIL。
    const readTrue = await app.inject({ method: 'GET', url: '/api/events?read=true' });
    expect(readTrue.statusCode).toBe(200);
    expect((readTrue.json() as Array<{ title: string }>).map((row) => row.title)).toEqual(['代理全部失败']);
  });

  it('excludes the retry-exhausted marker title from /api/events/count unread total', async () => {
    await db.insert(schema.events).values([
      {
        // 生产写入为 `read: true`；此处刻意用 `read: false` 以隔离本次新增的「按 title 排除」语义——
        // 若沿用 `read: true`，未读计数会被既有的 `read = false` 条件遮盖，无法守护 title 排除。
        type: 'proxy',
        title: RETRY_EXHAUSTED_EVENT_TITLE,
        message: 'retry exhausted: HTTP 429: rate limited',
        level: 'error',
        read: false,
        relatedType: 'route',
        createdAt: '2026-03-20 10:00:02',
      },
      {
        // 对照事件：同为未读、同 type / 同 level，仅 title 不同 ⇒ 计数应为 1 而非 2（也不是 0）。
        type: 'proxy',
        title: '代理全部失败',
        message: 'No available channels after retries',
        level: 'error',
        read: false,
        relatedType: 'route',
        createdAt: '2026-03-20 10:00:01',
      },
    ]).run();

    const response = await app.inject({ method: 'GET', url: '/api/events/count' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 1 });
  });
});
