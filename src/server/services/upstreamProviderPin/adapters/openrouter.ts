/**
 * `openrouter`：OpenRouter 原生契约适配器（body 族，只写顶层 `provider`）。
 *
 * 官方现行契约（oracle 实抓复核，v3.1 §2.2）：
 * - `provider.only` = 白名单语义（请求 only 与账号级允许列表取交集，交集为空返回 404）；
 * - `provider.order` = 顺序优先（`allow_fallbacks` 默认 true 时可回退），`allow_fallbacks`
 *   与 order 配套、不是 only 的前提；
 * - `providerOptions.gateway` 被 OpenRouter 忽略——本适配器不写该位（若下游透传已有该字段，
 *   非本适配器注入职责，原样不动）。
 *
 * 与 inject.ts 双姿势共用的保守语义：
 * - S1：顶层 provider 为普通对象时浅合并（保留 `require_parameters`、`data_collection`、
 *   `allow_fallbacks` 等既有键），**不写也不动 `allow_fallbacks`**（显式写 true 会抹掉
 *   用户 payload 规则的值）；
 * - S2：only/order 兄弟键互斥（写 only 删 order，反之亦然）；
 * - S3：provider 存在但非普通对象 → 跳过顶层注入；空 providers 原样返回。
 */
import type { UpstreamProviderPinTarget } from '../rules.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function applyOpenRouterBody(
  body: Record<string, unknown>,
  pin: UpstreamProviderPinTarget,
): Record<string, unknown> {
  // 防御性兜底：正常路径 resolve 已保证 providers 非空。
  if (!pin || !Array.isArray(pin.providers) || pin.providers.length === 0) {
    return body;
  }

  const writeKey: 'only' | 'order' = pin.mode === 'only' ? 'only' : 'order';
  const siblingKey: 'only' | 'order' = pin.mode === 'only' ? 'order' : 'only';

  const next: Record<string, unknown> = { ...body };

  // 只注入顶层 provider.{only|order}；providerOptions.gateway 零触碰。
  const existingProvider = body.provider;
  if (existingProvider === undefined) {
    next.provider = { [writeKey]: [...pin.providers] };
  } else if (isPlainObject(existingProvider)) {
    const provider = { ...existingProvider };
    provider[writeKey] = [...pin.providers];
    delete provider[siblingKey];
    next.provider = provider;
  }
  // 顶层 provider 非普通对象 → 跳过注入（S3 同款容错）。

  return next;
}
