import { describe, expect, it } from 'vitest';

import { applyVercelAiGatewayBody } from './vercelAiGateway.js';
import type { UpstreamProviderPinTarget } from '../rules.js';

const ONLY_PIN: UpstreamProviderPinTarget = { providers: ['anthropic'], mode: 'only' };
const ORDER_PIN: UpstreamProviderPinTarget = { providers: ['anthropic', 'openai'], mode: 'order' };

describe('vercel-ai-gateway adapter (nested providerOptions.gateway only)', () => {
  it('writes gateway.only and strips the order sibling without touching other gateway keys', () => {
    const body = {
      model: 'claude-sonnet',
      providerOptions: {
        gateway: { order: ['legacy'], someFlag: true },
        otherProvider: { keep: 1 },
      },
    };

    const next = applyVercelAiGatewayBody(body, ONLY_PIN);

    expect(next.providerOptions).toEqual({
      gateway: { someFlag: true, only: ['anthropic'] },
      otherProvider: { keep: 1 },
    });
    // 顶层 provider 零触碰
    expect(next.provider).toBeUndefined();
    // 入参不被 mutate
    expect((body.providerOptions.gateway as Record<string, unknown>).order).toEqual(['legacy']);
  });

  it('writes gateway.order for the order mode and strips only', () => {
    const body = {
      providerOptions: { gateway: { only: ['legacy'] } },
      provider: { order: ['passthrough'] },
    };

    const next = applyVercelAiGatewayBody(body, ORDER_PIN);

    expect(next.providerOptions).toEqual({
      gateway: { order: ['anthropic', 'openai'] },
    });
    // Vercel 契约外字段：顶层 provider 原样保留、不注入
    expect(next.provider).toEqual({ order: ['passthrough'] });
  });

  it('creates nested providerOptions.gateway when absent', () => {
    expect(applyVercelAiGatewayBody({ model: 'm' }, ONLY_PIN)).toEqual({
      model: 'm',
      providerOptions: { gateway: { only: ['anthropic'] } },
    });
  });

  it('skips injection when providerOptions or gateway is not a plain object (S3)', () => {
    for (const providerOptions of ['raw', ['array'], null, 7] as unknown[]) {
      const body = { providerOptions };
      const next = applyVercelAiGatewayBody(body, ONLY_PIN);
      expect(next).toEqual(body);
      expect(next.providerOptions).toBe(providerOptions);
    }

    for (const gateway of ['raw', ['array'], null, 7] as unknown[]) {
      const body = { providerOptions: { gateway, other: 1 } };
      const next = applyVercelAiGatewayBody(body, ONLY_PIN);
      expect(next).toEqual(body);
      expect(next.providerOptions).toEqual({ gateway, other: 1 });
    }
  });

  it('returns the body untouched for empty providers (防御性兜底)', () => {
    const body = { providerOptions: { gateway: { order: ['legacy'] } } };
    expect(applyVercelAiGatewayBody(body, { providers: [], mode: 'only' })).toBe(body);
  });
});
