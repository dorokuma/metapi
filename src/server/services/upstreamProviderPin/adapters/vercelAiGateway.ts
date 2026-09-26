/**
 * `vercel-ai-gateway`：Vercel AI Gateway 契约适配器（body 族，只写嵌套位）。
 *
 * 公开契约恰为 `providerOptions.gateway.{only|order}`（only 命中不回退、order 优先尝试）。
 * 与 inject.ts 双姿势共用的保守语义（嵌套位照搬）：
 * - S1：`providerOptions` / `providerOptions.gateway` 为普通对象时浅合并保留既有键；
 * - S2：only/order 兄弟键互斥；
 * - S3：`providerOptions` / `providerOptions.gateway` 存在但非普通对象 → 跳过嵌套注入。
 *
 * 不写顶层 `provider`（Vercel 契约外字段，写入即未知字段透传风险；F-7 实测前不开放）。
 */
import type { UpstreamProviderPinTarget } from '../rules.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function applyVercelAiGatewayBody(
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

  // 只注入嵌套位 providerOptions.gateway.{only|order}；顶层 provider 零触碰。
  const existingProviderOptions = body.providerOptions;
  if (existingProviderOptions === undefined) {
    next.providerOptions = { gateway: { [writeKey]: [...pin.providers] } };
  } else if (isPlainObject(existingProviderOptions)) {
    const providerOptions = { ...existingProviderOptions };
    const existingGateway = providerOptions.gateway;
    if (existingGateway === undefined) {
      providerOptions.gateway = { [writeKey]: [...pin.providers] };
      next.providerOptions = providerOptions;
    } else if (isPlainObject(existingGateway)) {
      const gateway = { ...existingGateway };
      gateway[writeKey] = [...pin.providers];
      // only/order 兄弟键互斥：避免历史残留字段与注入指令冲突。
      delete gateway[siblingKey];
      providerOptions.gateway = gateway;
      next.providerOptions = providerOptions;
    }
    // gateway 存在但非普通对象 → 不覆盖 gateway。
  }
  // providerOptions 存在但非普通对象 → 不覆盖该字段。

  return next;
}
