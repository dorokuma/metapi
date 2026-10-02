import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { resetProxyChannelCoordinatorState } from './proxyChannelCoordinator.js';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type SiteApiEndpointServiceModule = typeof import('./siteApiEndpointService.js');

describe('siteApiEndpointService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let selectSiteApiEndpointTarget: SiteApiEndpointServiceModule['selectSiteApiEndpointTarget'];
  let recordSiteApiEndpointFailure: SiteApiEndpointServiceModule['recordSiteApiEndpointFailure'];
  let recordSiteApiEndpointSuccess: SiteApiEndpointServiceModule['recordSiteApiEndpointSuccess'];
  let dataDir = '';
  let originalEndpointCooldownSec = 60;
  let originalDisableFailureDrivenCooldown = false;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-api-endpoint-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const serviceModule = await import('./siteApiEndpointService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    originalEndpointCooldownSec = config.siteApiEndpointCooldownSec;
    originalDisableFailureDrivenCooldown = config.disableFailureDrivenCooldown;
    selectSiteApiEndpointTarget = serviceModule.selectSiteApiEndpointTarget;
    recordSiteApiEndpointFailure = serviceModule.recordSiteApiEndpointFailure;
    recordSiteApiEndpointSuccess = serviceModule.recordSiteApiEndpointSuccess;
  });

  beforeEach(async () => {
    resetProxyChannelCoordinatorState();
    config.siteApiEndpointCooldownSec = originalEndpointCooldownSec;
    config.disableFailureDrivenCooldown = originalDisableFailureDrivenCooldown;
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.siteApiEndpointCooldownSec = originalEndpointCooldownSec;
    config.disableFailureDrivenCooldown = originalDisableFailureDrivenCooldown;
    delete process.env.DATA_DIR;
  });

  it('returns a synthetic site-url fallback when the site has no configured api endpoints', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'panel-only-site',
      url: 'https://panel.example.com/',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'site-fallback',
      siteId: site.id,
      endpointId: null,
      baseUrl: 'https://panel.example.com',
      configuredEndpointCount: 0,
    });
  });

  it('selects the least recently selected enabled endpoint when sort order is tied', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'pool-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
        lastSelectedAt: '2026-03-31T11:59:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-a.example.com/',
        enabled: true,
        sortOrder: 0,
        lastSelectedAt: '2026-03-31T11:00:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      siteId: site.id,
      baseUrl: 'https://api-a.example.com',
      configuredEndpointCount: 2,
      endpoint: expect.objectContaining({
        url: 'https://api-a.example.com/',
        sortOrder: 0,
      }),
    });
  });

  it('prefers lower sortOrder before lastSelectedAt when selecting an enabled endpoint', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ordered-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-secondary.example.com',
        enabled: true,
        sortOrder: 1,
        lastSelectedAt: '2026-03-31T11:00:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-primary.example.com',
        enabled: true,
        sortOrder: 0,
        lastSelectedAt: '2026-03-31T11:59:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      siteId: site.id,
      baseUrl: 'https://api-primary.example.com',
      configuredEndpointCount: 2,
      endpoint: expect.objectContaining({
        url: 'https://api-primary.example.com',
        sortOrder: 0,
      }),
    });
  });

  it('skips disabled endpoints and endpoints that are still cooling down', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'filtered-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-disabled.example.com',
        enabled: false,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-cooling.example.com',
        enabled: true,
        sortOrder: 1,
        cooldownUntil: '2026-03-31T12:05:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-ready.example.com',
        enabled: true,
        sortOrder: 2,
        cooldownUntil: '2026-03-31T11:55:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      baseUrl: 'https://api-ready.example.com',
      configuredEndpointCount: 3,
    });
  });

  it('returns null when the site has configured api endpoints but none are currently eligible', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'exhausted-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-disabled.example.com',
        enabled: false,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-cooling.example.com',
        enabled: true,
        sortOrder: 1,
        cooldownUntil: '2026-03-31T12:05:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toBeNull();
  });

  it('records retryable failures with the configured endpoint cooldown', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'retryable-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-retryable.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      triggersEndpointCooldown: true,
      cooldownUntil: '2026-03-31T12:01:00.000Z',
      failureReason: 'HTTP 502: Bad gateway',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: '2026-03-31T12:01:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
    });
  });

  it('parses retryable HTTP status codes from failure messages when no explicit status is provided', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'message-status-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-message-status.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      message: 'HTTP 502: upstream temporarily unavailable',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      cooldownUntil: '2026-03-31T12:01:00.000Z',
      failureReason: 'HTTP 502: upstream temporarily unavailable',
    });
  });

  it('does not cool down or extend an endpoint cooldown for client-error statuses such as 429', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'client-error-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-client-error.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 429,
      message: 'Too Many Requests',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      triggersEndpointCooldown: false,
      cooldownUntil: null,
      failureReason: 'HTTP 429: Too Many Requests',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 429: Too Many Requests',
    });
  });

  it('does not trigger endpoint cooldown for a 4xx status outside both status tables', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'unlisted-client-error-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-unlisted-client-error.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    // 402 既不在 RETRYABLE_STATUS_CODES 也不在 NON_RETRYABLE_STATUS_CODES，
    // 会落到按文案匹配的分支；该分支不看 status，因此必须显式兜底为 4xx 不写端点冷却。
    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 402,
      message: 'network error while contacting upstream',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      triggersEndpointCooldown: false,
      cooldownUntil: null,
      failureReason: 'HTTP 402: network error while contacting upstream',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 402: network error while contacting upstream',
    });
  });

  it('keeps the existing cooldown when a retryable failure lands during cooldown', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cooling-endpoint-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-cooling-endpoint.example.com',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: '2026-03-31T12:03:00.000Z',
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      triggersEndpointCooldown: true,
      cooldownUntil: '2026-03-31T12:03:00.000Z',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: '2026-03-31T12:03:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
    });
  });

  it('honors the configured endpoint cooldown seconds', async () => {
    config.siteApiEndpointCooldownSec = 120;

    const site = await db.insert(schema.sites).values({
      name: 'configured-cooldown-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-configured-cooldown.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
    }, '2026-03-31T12:00:00.000Z');

    expect(result.cooldownUntil).toBe('2026-03-31T12:02:00.000Z');
  });

  it('records auth and validation failures without triggering cooldown rotation or clearing an existing cooldown', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'non-retryable-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-auth.example.com',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 401,
      message: 'Invalid token',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: false,
      rotateToNextEndpoint: false,
      triggersEndpointCooldown: false,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      failureReason: 'HTTP 401: Invalid token',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 401: Invalid token',
    });
  });

  it('clears cooldown metadata and updates lastSelectedAt after a recorded success', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'success-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-success.example.com',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
    }).returning().get();

    await recordSiteApiEndpointSuccess(endpoint.id, '2026-03-31T12:01:00.000Z');

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .orderBy(asc(schema.siteApiEndpoints.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastSelectedAt: '2026-03-31T12:01:00.000Z',
      lastFailureReason: null,
    });
  });

  it('holds the site lease until a streamed response is consumed', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'concurrency-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      maxConcurrency: 1,
    }).returning().get();

    const first = await (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({ upstream: new Response('first') }),
    );
    let secondSettled = false;
    const secondPromise = (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({ upstream: new Response('second') }),
    ).then((result) => {
      secondSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    await (first as { upstream: Response }).upstream.text();
    const second = await secondPromise;
    expect(await (second as { upstream: Response }).upstream.text()).toBe('second');
  });

  it('releases the site lease when a streamed response is cancelled', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cancelled-stream-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      maxConcurrency: 1,
    }).returning().get();

    const first = await (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({
        upstream: new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
          },
        })),
      }),
    );
    let secondSettled = false;
    const secondPromise = (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({ upstream: new Response('second') }),
    ).then((result) => {
      secondSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    await (first as { upstream: Response }).upstream.body?.cancel('client disconnected');
    const second = await secondPromise;
    expect(await (second as { upstream: Response }).upstream.text()).toBe('second');
  });

  it('surfaces the cause chain of a network failure into the recorded reason', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'network-failure-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-network-failure.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    // undici 的网络失败形状：外层只有 `fetch failed`，真实 errno 藏在 `.cause` 里。
    const networkFailure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' }),
    });

    await expect((await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => {
        throw networkFailure;
      },
    )).rejects.toBe(networkFailure);

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored?.lastFailureReason).toBe('fetch failed (cause: ECONNRESET connection reset by peer)');
    expect(stored?.cooldownUntil).not.toBeNull();
  });

  it('skips the endpoint cooldown write but still records the failure when the failure cooldown switch is on', async () => {
    config.disableFailureDrivenCooldown = true;

    const site = await db.insert(schema.sites).values({
      name: 'switch-on-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-switch-on.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
    }, '2026-03-31T12:00:00.000Z');

    // 失败分类不变（仍是「可触发冷却」的失败类型），但总开关开启后不写冷却窗口。
    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      triggersEndpointCooldown: true,
      cooldownUntil: null,
      failureReason: 'HTTP 502: Bad gateway',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
    });
  });

  it('rotates to the next endpoint in the same request when the failure cooldown switch is on', async () => {
    config.disableFailureDrivenCooldown = true;

    const site = await db.insert(schema.sites).values({
      name: 'switch-rotation-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-a.example.com',
        enabled: true,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
      },
    ]).run();

    const serviceModule = await import('./siteApiEndpointService.js');
    const attemptedBaseUrls: string[] = [];
    const result = await serviceModule.runWithSiteApiEndpointPool(site, async (target) => {
      attemptedBaseUrls.push(target.baseUrl);
      if (target.baseUrl === 'https://api-a.example.com') {
        throw new serviceModule.SiteApiEndpointRequestError('HTTP 502: Bad gateway', { status: 502 });
      }
      return { upstream: new Response('ok via api-b') };
    });

    // 冷却被总开关关掉后，同请求内的轮换只能靠「已尝试端点」排除集兜住。
    expect(attemptedBaseUrls).toEqual([
      'https://api-a.example.com',
      'https://api-b.example.com',
    ]);
    expect(await (result as { upstream: Response }).upstream.text()).toBe('ok via api-b');

    const storedEndpoints = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.siteId, site.id))
      .orderBy(asc(schema.siteApiEndpoints.sortOrder), asc(schema.siteApiEndpoints.id))
      .all();
    expect(storedEndpoints[0]).toMatchObject({
      cooldownUntil: null,
      lastFailureReason: 'HTTP 502: Bad gateway',
    });
    expect(storedEndpoints[0]?.lastFailedAt).toBeTruthy();
    expect(storedEndpoints[1]?.lastSelectedAt).toBeTruthy();
  });

  it('releases an already written failure-driven endpoint cooldown when the failure cooldown switch is turned on', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'switch-release-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-switch-release.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const failureAt = '2026-03-31T12:00:00.000Z';
    const readEndpoint = async () => await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();

    // 默认（开关 false）：失败写下端点冷却窗口。
    await recordSiteApiEndpointFailure(endpoint.id, { status: 502, message: 'Bad gateway' }, failureAt);
    const cooling = await readEndpoint();
    expect(cooling?.cooldownUntil).toBeTruthy();
    // 窗口未过期前，唯一端点被挡（selector 返回 null），反向对照。
    await expect(selectSiteApiEndpointTarget(site, failureAt)).resolves.toBeNull();

    // 翻开关：窗口不删、不改写，读侧从这一刻起不再因它挡人。
    config.disableFailureDrivenCooldown = true;
    const released = await selectSiteApiEndpointTarget(site, failureAt);
    expect(released?.endpointId).toBe(endpoint.id);
    // 窗口值照旧留库做观测（不删状态、不改写入点既有语义）。
    expect((await readEndpoint())?.cooldownUntil).toBe(cooling?.cooldownUntil);
  });

  it('lets a `.cause`-only errno flip the failure classification', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cause-classification-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-cause-classification.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    // 外层 message（`socket closed`）不命中任何 NETWORK_FAILURE_PATTERN，
    // 只有 `.cause` 里的 ECONNRESET 能把它推成网络失败分类。
    const networkFailure = new TypeError('socket closed', {
      cause: Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' }),
    });

    await expect((await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => {
        throw networkFailure;
      },
    )).rejects.toBe(networkFailure);

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored?.lastFailureReason).toBe('socket closed (cause: ECONNRESET connection reset by peer)');
    expect(stored?.cooldownUntil).not.toBeNull();
  });
});
