/**
 * 「上游钉选适配器」静态注册表：id / label / mechanism / capabilities / notes 元数据来自共享目录
 * （src/shared/upstreamPinAdapters.js，Web 设置页同读），本文件只负责挂接 applyBody / applyHeaders 实现。
 *
 * - 纯静态注册（常量 + 查表），无动态加载、无 DI；新增适配器 = 新增实现文件 + 本表加一行 +
 *   共享目录加一项，不触碰 rules / builder / settings 主链路。
 * - **合法适配器 id 集合的唯一事实源 = 本注册表键集**（UPSTREAM_PIN_ADAPTER_IDS）：
 *   PUT 严格校验与热路径 resolve 共用；TS 联合类型仅编译期便利。
 * - Phase 1 只注册已实现四家：generic-dual / openrouter / vercel-ai-gateway / none。
 *   portkey / helicone / litellm / new-api 等一律不在集合内（拒绝「假通用」），PUT 提交即 400。
 */
import { listUpstreamPinAdapterCatalog } from '../../../../shared/upstreamPinAdapters.js';
import type { UpstreamPinAdapter, UpstreamPinAdapterId } from './types.js';
import { applyGenericDualBody } from './genericDual.js';
import { applyOpenRouterBody } from './openrouter.js';
import { applyVercelAiGatewayBody } from './vercelAiGateway.js';
import { NO_INJECTION_ADAPTER_IMPLEMENTATION } from './none.js';

const ADAPTER_IMPLEMENTATIONS: Record<
  UpstreamPinAdapterId,
  Pick<UpstreamPinAdapter, 'applyBody' | 'applyHeaders'>
> = {
  'generic-dual': { applyBody: applyGenericDualBody },
  'openrouter': { applyBody: applyOpenRouterBody },
  'vercel-ai-gateway': { applyBody: applyVercelAiGatewayBody },
  'none': NO_INJECTION_ADAPTER_IMPLEMENTATION,
};

/** 已注册适配器（目录项 + 实现；冻结防运行期改写）。 */
export const UPSTREAM_PIN_ADAPTERS: readonly UpstreamPinAdapter[] = Object.freeze(
  listUpstreamPinAdapterCatalog().map((entry) => Object.freeze({
    ...entry,
    capabilities: Object.freeze({ ...entry.capabilities }),
    ...ADAPTER_IMPLEMENTATIONS[entry.id],
  })),
);

/** 合法适配器 id 集合 = 注册表键集（PUT 校验 / 热路径 resolve / 测试共用同一来源）。 */
export const UPSTREAM_PIN_ADAPTER_IDS: readonly UpstreamPinAdapterId[] = Object.freeze(
  UPSTREAM_PIN_ADAPTERS.map((adapter) => adapter.id),
);

function requireAdapter(id: UpstreamPinAdapterId): UpstreamPinAdapter {
  const adapter = UPSTREAM_PIN_ADAPTERS.find((candidate) => candidate.id === id);
  // 静态注册表自检：目录与实现映射缺一不可；缺失属编码错误，启动期即炸（fail fast）。
  if (!adapter) throw new Error(`missing upstream pin adapter implementation: ${id}`);
  return adapter;
}

/** 未配置映射站点的默认适配器（= 现行为，逐字节回基线）。 */
export const GENERIC_DUAL_ADAPTER: UpstreamPinAdapter = requireAdapter('generic-dual');

/** 零注入适配器：`none` 显式选择与「未注册 id」热路径兜底共用（M2：零注入，绝不回落双姿势）。 */
export const ZERO_INJECTION_ADAPTER: UpstreamPinAdapter = requireAdapter('none');

/** 按 id 取注册适配器；未注册/非法输入返回 null（total，不抛）。 */
export function getUpstreamPinAdapter(id: unknown): UpstreamPinAdapter | null {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!normalizedId) return null;
  return UPSTREAM_PIN_ADAPTERS.find((adapter) => adapter.id === normalizedId) ?? null;
}

/** 是否注册适配器 id（合法集合 = 注册表键集）。 */
export function isUpstreamPinAdapterId(value: unknown): value is UpstreamPinAdapterId {
  return getUpstreamPinAdapter(value) !== null;
}
