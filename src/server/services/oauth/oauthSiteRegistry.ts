import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { insertAndGetById } from '../../db/insertHelpers.js';
import { listOAuthProviderDefinitions, type OAuthProviderDefinition } from './providers.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { config } from '../../config.js';

/**
 * 启动时是否自动补齐 OAuth provider 站点。默认 true（保持历史行为）；
 * 置为 false 后，即使库里的 OAuth 站点被删掉也不会在重启时重建。
 */
export const OAUTH_PROVIDER_SITE_AUTOCREATE_SETTING_KEY = 'oauth_provider_site_autocreate_enabled';

export async function isOauthProviderSiteAutoCreateEnabled(): Promise<boolean> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, OAUTH_PROVIDER_SITE_AUTOCREATE_SETTING_KEY))
    .get();
  if (!row?.value) {
    // 无显式设置项时回落到已 hydrate 的 config（env 显式关闭同样生效），
    // config 默认 true 保持历史行为——不会因为缺行就改变默认补种语义。
    return config.oauthProviderSiteAutoCreateEnabled;
  }
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed === 'boolean') return parsed;
    return config.oauthProviderSiteAutoCreateEnabled;
  } catch {
    return config.oauthProviderSiteAutoCreateEnabled;
  }
}

export async function setOauthProviderSiteAutoCreateEnabled(enabled: boolean): Promise<void> {
  await upsertSetting(OAUTH_PROVIDER_SITE_AUTOCREATE_SETTING_KEY, enabled);
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('unique')
    || normalized.includes('duplicate')
    || normalized.includes('constraint failed');
}

async function getNextSiteSortOrder(): Promise<number> {
  const row = await db.select({
    maxSortOrder: sql<number>`COALESCE(MAX(${schema.sites.sortOrder}), -1)`,
  }).from(schema.sites).get();
  return (row?.maxSortOrder ?? -1) + 1;
}

export async function ensureOauthProviderSite(definition: OAuthProviderDefinition) {
  const existing = await db.select().from(schema.sites).where(and(
    eq(schema.sites.platform, definition.site.platform),
    eq(schema.sites.url, definition.site.url),
  )).get();
  if (existing) return existing;

  try {
    return await insertAndGetById<typeof schema.sites.$inferSelect>({
      table: schema.sites,
      idColumn: schema.sites.id,
      values: {
        name: definition.site.name,
        url: definition.site.url,
        platform: definition.site.platform,
        status: 'active',
        useSystemProxy: false,
        isPinned: false,
        globalWeight: 1,
        sortOrder: await getNextSiteSortOrder(),
      },
      insertErrorMessage: `failed to create oauth provider site: ${definition.site.platform}`,
      loadErrorMessage: `failed to load created oauth provider site: ${definition.site.platform}`,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const recovered = await db.select().from(schema.sites).where(and(
      eq(schema.sites.platform, definition.site.platform),
      eq(schema.sites.url, definition.site.url),
    )).get();
    if (recovered) return recovered;
    throw error;
  }
}

export async function ensureOauthProviderSitesExist(): Promise<void> {
  if (!(await isOauthProviderSiteAutoCreateEnabled())) return;
  const definitions = listOAuthProviderDefinitions();
  for (const definition of definitions) {
    await ensureOauthProviderSite(definition);
  }
}
