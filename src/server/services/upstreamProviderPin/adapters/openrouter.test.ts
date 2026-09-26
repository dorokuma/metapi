import { describe, expect, it } from 'vitest';

import { applyOpenRouterBody } from './openrouter.js';
import type { UpstreamProviderPinTarget } from '../rules.js';

const ONLY_PIN: UpstreamProviderPinTarget = { providers: ['deepseek'], mode: 'only' };
const ORDER_PIN: UpstreamProviderPinTarget = { providers: ['deepseek', 'alibaba'], mode: 'order' };

describe('openrouter adapter (top-level provider.only / provider.order)', () => {
  it('writes provider.only for the only mode and strips the order sibling', () => {
    const body = {
      model: 'deepseek/deepseek-v4.1-flash',
      provider: {
        require_parameters: true,
        allow_fallbacks: true,
        order: ['legacy'],
      },
    };

    const next = applyOpenRouterBody(body, ONLY_PIN);

    expect(next.provider).toEqual({
      require_parameters: true,
      allow_fallbacks: true,
      only: ['deepseek'],
    });
    // OpenRouter 忽略嵌套位：本适配器零触碰
    expect(next.providerOptions).toBeUndefined();
    // 入参不被 mutate
    expect(body.provider).toEqual({
      require_parameters: true,
      allow_fallbacks: true,
      order: ['legacy'],
    });
  });

  it('writes provider.order for the order mode, strips only, and never writes allow_fallbacks', () => {
    const body = {
      model: 'deepseek/deepseek-v4.1-flash',
      provider: {
        only: ['legacy'],
        allow_fallbacks: false,
      },
    };

    const next = applyOpenRouterBody(body, ORDER_PIN);

    // allow_fallbacks 保留用户既有值（不写也不动），only 兄弟键删除
    expect(next.provider).toEqual({
      allow_fallbacks: false,
      order: ['deepseek', 'alibaba'],
    });
    expect(next.providerOptions).toBeUndefined();
  });

  it('creates the top-level provider object when it is absent (两种模式)', () => {
    const onlyNext = applyOpenRouterBody({ model: 'm' }, ONLY_PIN);
    expect(onlyNext).toEqual({ model: 'm', provider: { only: ['deepseek'] } });

    const orderNext = applyOpenRouterBody({ model: 'm' }, ORDER_PIN);
    expect(orderNext).toEqual({ model: 'm', provider: { order: ['deepseek', 'alibaba'] } });
  });

  it('does not touch an existing providerOptions.gateway passthrough field', () => {
    const body = {
      providerOptions: { gateway: { only: ['passthrough'] } },
    };

    const next = applyOpenRouterBody(body, ORDER_PIN);

    expect(next.providerOptions).toEqual({ gateway: { only: ['passthrough'] } });
    expect(next.provider).toEqual({ order: ['deepseek', 'alibaba'] });
  });

  it('skips top-level injection when provider exists but is not a plain object (S3)', () => {
    for (const provider of ['string-value', ['array-value'], null, 42] as unknown[]) {
      const body = { provider };
      const next = applyOpenRouterBody(body, ONLY_PIN);
      expect(next).toEqual(body);
      expect(next.provider).toBe(provider);
    }
  });

  it('returns the body untouched for empty providers or missing pin (防御性兜底)', () => {
    const body = { provider: { order: ['legacy'] } };
    expect(applyOpenRouterBody(body, { providers: [], mode: 'only' })).toBe(body);
    expect(applyOpenRouterBody(body, undefined as unknown as UpstreamProviderPinTarget)).toBe(body);
  });
});
