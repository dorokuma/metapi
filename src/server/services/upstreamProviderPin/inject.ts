/**
 * 「上游供应商钉选注入」纯函数：把命中规则转换为上游请求体上的两类字段。
 *
 * 输出语义：
 * - 同时写嵌套 `providerOptions.gateway.{only|order}` 与顶层 `provider.{only|order}` 两个位置
 *   （Cline 当前静默丢弃，OpenRouter / New API 等聚合商按各自口径读取）。
 * - 返回浅拷贝，不 mutate 入参；只复制被改写的层级。
 *
 * 边界容错（保守：不破坏未知语义字段）：
 * - `providerOptions` / `providerOptions.gateway` / 顶层 `provider` 存在但不是普通对象时，
 *   跳过对应位置的注入（数组、字符串、null 一律视为“存在但非对象”），不覆盖原值；
 * - 空 providers（调用方违约）原样返回 body，零改动。
 */

import type { UpstreamProviderPinTarget } from './rules.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function injectUpstreamProviderPin(
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

  // 嵌套位：providerOptions.gateway.{only|order}
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
    // gateway 存在但非普通对象 → 不覆盖 gateway，只做顶层注入。
  }
  // providerOptions 存在但非普通对象 → 不覆盖该字段，只做顶层注入。

  // 顶层位：provider.{only|order}
  const existingProvider = body.provider;
  if (existingProvider === undefined) {
    next.provider = { [writeKey]: [...pin.providers] };
  } else if (isPlainObject(existingProvider)) {
    // S1：浅合并保留其其他键（例如 payloadRules 写入的 allow_fallbacks）。
    const provider = { ...existingProvider };
    provider[writeKey] = [...pin.providers];
    delete provider[siblingKey];
    next.provider = provider;
  }
  // 顶层 provider 非对象 → 跳过顶层注入，只保留嵌套注入。

  return next;
}
