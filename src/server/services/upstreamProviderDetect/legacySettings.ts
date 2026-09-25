/**
 * 旧配置键 `upstream_provider_detect_platforms`（站点 host 后缀列表）已被
 * 「参与站点」`upstream_provider_detect_site_ids` 取代。
 *
 * 旧键不再被任何代码读取，但历史库 / 备份导入可能残留该行；启动时删除一次，
 * 保证线上不存在「旧后缀 + 新站点集合」双配置并存的歧义。删除失败不阻塞启动
 * （残留行也不会再被读取），下次启动会继续尝试。
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

export const LEGACY_UPSTREAM_PROVIDER_DETECT_PLATFORMS_KEY = 'upstream_provider_detect_platforms';

/** 返回是否真的删除了残留行；表不存在/权限异常等错误一律吞掉并返回 false。 */
export async function dropLegacyUpstreamProviderDetectPlatformsSetting(): Promise<boolean> {
  try {
    const row = await db.select({ key: schema.settings.key })
      .from(schema.settings)
      .where(eq(schema.settings.key, LEGACY_UPSTREAM_PROVIDER_DETECT_PLATFORMS_KEY))
      .get();
    if (!row) return false;

    await db.delete(schema.settings)
      .where(eq(schema.settings.key, LEGACY_UPSTREAM_PROVIDER_DETECT_PLATFORMS_KEY))
      .run();
    return true;
  } catch {
    return false;
  }
}
