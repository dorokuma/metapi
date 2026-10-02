import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

describe('TokenRouter oauth route units', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let tokenRouterTestUtils: TokenRouterModule['__tokenRouterTestUtils'];
  let config: ConfigModule['config'];
  let originalDisableFailureDrivenCooldown = false;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-oauth-route-units-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    tokenRouterTestUtils = tokenRouterModule.__tokenRouterTestUtils;
    config = configModule.config;
    originalDisableFailureDrivenCooldown = config.disableFailureDrivenCooldown;
  });

  beforeEach(async () => {
    config.disableFailureDrivenCooldown = originalDisableFailureDrivenCooldown;
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    config.disableFailureDrivenCooldown = originalDisableFailureDrivenCooldown;
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('round robins across healthy oauth route unit members while keeping a single outer channel', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rr-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-rr-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-rr-a', email: 'rr-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rr-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-rr-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-rr-b', email: 'rr-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Codex RR Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const first = await router.selectChannel('gpt-5.4');
    const second = await router.selectChannel('gpt-5.4');

    expect(first?.channel.id).toBe(channel.id);
    expect(second?.channel.id).toBe(channel.id);
    expect(first?.account.id).toBe(accountA.id);
    expect(second?.account.id).toBe(accountB.id);
  });

  it('sticks to the same oauth route unit member until it becomes unavailable', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sticky-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-sticky-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-sticky-a', email: 'sticky-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sticky-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-sticky-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-sticky-b', email: 'sticky-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Codex Sticky Pool',
      strategy: 'stick_until_unavailable',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const first = await router.selectChannel('gpt-5.4');
    const second = await router.selectChannel('gpt-5.4');
    expect(first?.account.id).toBe(accountA.id);
    expect(second?.account.id).toBe(accountA.id);

    await router.recordFailure(channel.id, { status: 503, errorText: 'unavailable' }, accountA.id);
    const third = await router.selectChannel('gpt-5.4');
    expect(third?.channel.id).toBe(channel.id);
    expect(third?.account.id).toBe(accountB.id);
  });

  it('keeps unrelated stable-first cache entries when pooled member state updates', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-a@example.com',
      accessToken: 'oauth-cache-access-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-cache-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-cache-a', email: 'cache-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-b@example.com',
      accessToken: 'oauth-cache-access-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-cache-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-cache-b', email: 'cache-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      routingStrategy: 'weighted',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Cache Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    tokenRouterTestUtils.rememberStableFirstSiteSelectionForKey('999:other-model', 77);
    expect(tokenRouterTestUtils.getStableFirstRotationCacheSize()).toBe(1);

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-5.4');
    expect(selected?.channel.id).toBe(channel.id);
    expect(tokenRouterTestUtils.getStableFirstRotationCacheSize()).toBe(1);

    await router.recordFailure(channel.id, { status: 503, errorText: 'pooled unavailable' }, accountA.id);
    expect(tokenRouterTestUtils.getStableFirstRotationCacheSize()).toBe(1);
  });

  it('fails closed when a pooled channel has no loaded members', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'missing-members@example.com',
      accessToken: 'oauth-access-token-missing-members',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-missing-members',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-missing-members', email: 'missing-members@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Broken Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-5.4');

    expect(selected).toBeNull();
  });

  it('uses the api token fallback for pooled oauth members when the access token is blank', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fallback-a@example.com',
      accessToken: '   ',
      apiToken: 'oauth-api-token-a',
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-fallback-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-fallback-a', email: 'fallback-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fallback-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-fallback-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-fallback-b', email: 'fallback-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Fallback Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-5.4');

    expect(selected?.channel.id).toBe(channel.id);
    expect(selected?.account.id).toBe(accountA.id);
    expect(selected?.tokenValue).toBe('oauth-api-token-a');
  });

  it('does not immediately retry the same pooled member during failover when it just failed', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'failover-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-failover-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-failover-a', email: 'failover-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'failover-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'disabled',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-failover-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-failover-b', email: 'failover-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Failover Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const first = await router.selectChannel('gpt-5.4');
    expect(first?.account.id).toBe(accountA.id);

    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);
    const failover = await router.selectNextChannel('gpt-5.4', [channel.id]);

    expect(failover).toBeNull();
  });

  it('keeps the existing member cooldown when a failure lands during member cooldown', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cooling-member-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-cooling-member-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-cooling-member-a', email: 'cooling-member-a@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Sticky Pool',
      strategy: 'stick_until_unavailable',
      enabled: true,
    }).returning().get();
    const seededCooldownUntil = new Date(Date.now() + 9_000).toISOString();
    const member = await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: accountA.id,
      sortOrder: 0,
      failCount: 3,
      cooldownUntil: seededCooldownUntil,
    }).returning().get();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);

    const updatedMember = await db.select().from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.id, member.id))
      .get();

    // 成员冷却期内到账的失败只更新观测字段，不把当前冷却窗口往后推（fibonacci 递增留给下一次冷却起点）。
    expect(updatedMember?.cooldownUntil).toBe(seededCooldownUntil);
    expect(updatedMember?.failCount).toBe(4);
    expect(updatedMember?.lastFailAt).toBeTruthy();
  });

  it('keeps an active round robin member cooldown below the consecutive failure threshold', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rr-cooling-member-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-rr-cooling-member-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-rr-cooling-member-a', email: 'rr-cooling-member-a@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Round Robin Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    const seededCooldownUntil = new Date(Date.now() + 9 * 60 * 1000).toISOString();
    const member = await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: accountA.id,
      sortOrder: 0,
      failCount: 3,
      consecutiveFailCount: 0,
      cooldownUntil: seededCooldownUntil,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);

    const updatedMember = await db.select().from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.id, member.id))
      .get();

    // round_robin 未跨阈值时也必须复用已有窗口：成员冷却期内到账的失败不得把 cooldown_until 写成 NULL。
    expect(updatedMember?.cooldownUntil).toBe(seededCooldownUntil);
    expect(updatedMember?.consecutiveFailCount).toBe(1);
    expect(updatedMember?.cooldownLevel).toBe(0);
  });

  it('keeps an active round robin member cooldown when a failure crosses the consecutive failure threshold', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rr-cross-threshold-member-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-rr-cross-threshold-member-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-rr-cross-threshold-member-a', email: 'rr-cross-threshold-member-a@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Round Robin Cross Threshold Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    const seededCooldownUntil = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const member = await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: accountA.id,
      sortOrder: 0,
      failCount: 3,
      // 已在冷却中，且 consecutiveFailCount 已达阈值：本次失败会走跨阈值阶梯分支。
      consecutiveFailCount: 3,
      cooldownLevel: 0,
      cooldownUntil: seededCooldownUntil,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);

    const updatedMember = await db.select().from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.id, member.id))
      .get();

    // 跨阈值也必须复用已有窗口：阶梯只递增等级并清零连续计数，不得重算或清空 cooldown_until。
    expect(updatedMember?.cooldownUntil).toBe(seededCooldownUntil);
    expect(updatedMember?.consecutiveFailCount).toBe(0);
    expect(updatedMember?.cooldownLevel).toBe(1);
  });

  it('skips the round robin member cooldown ladder when the failure cooldown switch is on', async () => {
    config.disableFailureDrivenCooldown = true;

    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rr-switch-off-member-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-rr-switch-off-member-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-rr-switch-off-member-a', email: 'rr-switch-off-member-a@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Round Robin Switch Off Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    const member = await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: accountA.id,
      sortOrder: 0,
      // 连续失败计数已达阈值：本次失败会命中跨阈值阶梯分支。
      consecutiveFailCount: 3,
      cooldownLevel: 0,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);

    const updatedMember = await db.select().from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.id, member.id))
      .get();

    // 总开关开启：阶梯停摆（不写窗口、不递增等级、不清零连续计数），失败仍留痕。
    expect(updatedMember?.cooldownUntil).toBeNull();
    expect(updatedMember?.cooldownLevel).toBe(0);
    expect(updatedMember?.consecutiveFailCount).toBe(4);
    expect(updatedMember?.failCount).toBe(1);
    expect(updatedMember?.lastFailAt).toBeTruthy();
  });

  it('skips the stick-until-unavailable member cooldown window when the failure cooldown switch is on', async () => {
    config.disableFailureDrivenCooldown = true;

    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sticky-switch-off-member-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-sticky-switch-off-member-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-sticky-switch-off-member-a', email: 'sticky-switch-off-member-a@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Sticky Switch Off Pool',
      strategy: 'stick_until_unavailable',
      enabled: true,
    }).returning().get();
    const member = await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: accountA.id,
      sortOrder: 0,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);

    const updatedMember = await db.select().from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.id, member.id))
      .get();

    // 总开关开启：fibonacci 窗口不写，但 failCount / lastFailAt 照旧记录。
    expect(updatedMember?.cooldownUntil).toBeNull();
    expect(updatedMember?.failCount).toBe(1);
    expect(updatedMember?.lastFailAt).toBeTruthy();
  });

  it('releases an already written member cooldown when the failure cooldown switch is turned on', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'release-member-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-release-member-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-release-member-a', email: 'release-member-a@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Release Pool',
      strategy: 'stick_until_unavailable',
      enabled: true,
    }).returning().get();
    const member = await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: accountA.id,
      sortOrder: 0,
    }).returning().get();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const readMember = async () => await db.select().from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.id, member.id))
      .get();

    // 默认（开关 false）：失败写下成员冷却窗口（stick_until_unavailable ⇒ fibonacci）。
    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);
    const cooling = await readMember();
    expect(cooling?.cooldownUntil).toBeTruthy();
    expect(cooling?.failCount).toBe(1);
    await expect(router.selectChannel('gpt-5.4')).resolves.toBeNull();

    // 翻开关：窗口照旧留库做观测，读侧从这一刻起不再因它挡人。
    config.disableFailureDrivenCooldown = true;
    invalidateTokenRouterCache();

    const stillCooling = await readMember();
    expect(stillCooling?.cooldownUntil).toBe(cooling?.cooldownUntil);
    const released = await router.selectChannel('gpt-5.4');
    expect(released?.account.id).toBe(accountA.id);
  });

  it('still blocks a provider-directed member cooldown when the failure cooldown switch is on', async () => {
    config.disableFailureDrivenCooldown = true;

    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'provider-directed-member-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-provider-directed-member-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-provider-directed-member-a', email: 'provider-directed-member-a@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Provider Directed Pool',
      strategy: 'stick_until_unavailable',
      enabled: true,
    }).returning().get();
    // provider-directed 形状的成员窗口：窗口在、失败计数三件套全 0（配额/限流分支的写入形状）。
    await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: accountA.id,
      sortOrder: 0,
      failCount: 0,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const router = new TokenRouter();
    // 上游指令型窗口不得被总开关解除：成员仍不可用 ⇒ 候选不可用 ⇒ 选不出通道。
    await expect(router.selectChannel('gpt-5.4')).resolves.toBeNull();
  });
});
