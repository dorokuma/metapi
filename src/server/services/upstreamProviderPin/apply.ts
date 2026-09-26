/**
 * 钉选注入统一门禁：命中判定 → 适配器解析 → 能力协商 → 分发 applyBody / applyHeaders。
 *
 * 两个注入点（chat / responses 默认路径）只调用 `applyUpstreamProviderPin`，分发与协商逻辑集中在此，
 * 避免两个调用点漂移；header 挂点一并在此预留（Phase 1 无 header 族适配器 = 空操作，
 * Phase 2 portkey/helicone 经注册表接入后自动生效，调用点无需再改）。
 *
 * 判定顺序（父层行为不变映射）：
 * 1. `resolveUpstreamProviderPin` 未命中（开关关/规则空/站点或模型不命中）→ 原样返回（outcome: 'miss'）；
 * 2. 命中后再解析站点适配器（未配置 → generic-dual，未注册 id → 零注入）；
 * 3. 能力协商：mode 能力不足 → body 与 header 都不写（outcome: 'skipped'，不降级、不语义反转）；
 * 4. 适配器有 applyBody / applyHeaders 才调用，返回值即最终值（实现不得 mutate 入参，见 types.ts）。
 */
import { resolveUpstreamPinAdapter } from './adapterMap.js';
import { resolveUpstreamProviderPin } from './rules.js';
import type { UpstreamPinAdapter, UpstreamPinAdapterId } from './adapters/types.js';
import type { UpstreamProviderPinTarget } from './rules.js';

export type UpstreamPinApplicationOutcome = 'miss' | 'skipped' | 'applied';

export type UpstreamPinApplication = {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** miss = 规则未命中；skipped = 命中但能力不足/零注入适配器；applied = 已按适配器分发。 */
  outcome: UpstreamPinApplicationOutcome;
  /** 命中的适配器 id；未命中为 null。未注册 id 解析为零注入适配器（id = 'none'）。 */
  adapterId: UpstreamPinAdapterId | null;
};

/** 纯分发 + 能力协商（无 config 依赖，单测可用合成适配器覆盖 header 钩子等分支）。 */
export function applyUpstreamPinWithAdapter(input: {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  pin: UpstreamProviderPinTarget;
  adapter: UpstreamPinAdapter;
}): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  outcome: 'skipped' | 'applied';
} {
  const capabilityOk = input.pin.mode === 'only'
    ? input.adapter.capabilities.only
    : input.adapter.capabilities.order;
  if (!capabilityOk) {
    return { body: input.body, headers: input.headers, outcome: 'skipped' };
  }

  const nextBody = input.adapter.applyBody
    ? input.adapter.applyBody(input.body, input.pin)
    : input.body;
  const nextHeaders = input.adapter.applyHeaders
    ? input.adapter.applyHeaders(input.headers, input.pin)
    : input.headers;

  return { body: nextBody, headers: nextHeaders, outcome: 'applied' };
}

export function applyUpstreamProviderPin(input: {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  siteId: number | null | undefined;
  requestedModel: string;
}): UpstreamPinApplication {
  const siteId = input.siteId ?? null;
  const pin = resolveUpstreamProviderPin({
    siteId,
    requestedModel: input.requestedModel,
  });
  if (!pin) {
    return { body: input.body, headers: input.headers, outcome: 'miss', adapterId: null };
  }

  const adapter = resolveUpstreamPinAdapter(siteId);
  const application = applyUpstreamPinWithAdapter({
    body: input.body,
    headers: input.headers,
    pin,
    adapter,
  });
  return { ...application, adapterId: adapter.id };
}
