import { describe, expect, it } from 'vitest';
import { injectUpstreamProviderPin } from './inject.js';
import type { UpstreamProviderPinTarget } from './rules.js';

const onlyPin: UpstreamProviderPinTarget = { providers: ['deepseek'], mode: 'only' };
const orderPin: UpstreamProviderPinTarget = { providers: ['deepseek', 'alibaba'], mode: 'order' };

describe('injectUpstreamProviderPin', () => {
  it('writes both the nested gateway field and the top-level provider field', () => {
    const body = { model: 'm', messages: [] };
    const injected = injectUpstreamProviderPin(body, onlyPin);

    expect(injected).toEqual({
      model: 'm',
      messages: [],
      providerOptions: { gateway: { only: ['deepseek'] } },
      provider: { only: ['deepseek'] },
    });
  });

  it('keeps sibling only/order keys mutually exclusive in all four positions (S2)', () => {
    const withOrderResidue = {
      providerOptions: { gateway: { order: ['old'], other: true } },
      provider: { order: ['old'], allow_fallbacks: false },
    };
    const injectedOnly = injectUpstreamProviderPin(withOrderResidue, onlyPin);

    expect(injectedOnly.providerOptions).toEqual({
      gateway: { only: ['deepseek'], other: true },
    });
    expect(injectedOnly.provider).toEqual({ only: ['deepseek'], allow_fallbacks: false });
    expect(JSON.stringify(injectedOnly)).not.toContain('order');

    const withOnlyResidue = {
      providerOptions: { gateway: { only: ['old'] } },
      provider: { only: ['old'] },
    };
    const injectedOrder = injectUpstreamProviderPin(withOnlyResidue, orderPin);

    expect(injectedOrder.providerOptions).toEqual({
      gateway: { order: ['deepseek', 'alibaba'] },
    });
    expect(injectedOrder.provider).toEqual({ order: ['deepseek', 'alibaba'] });
    expect(JSON.stringify(injectedOrder)).not.toContain('only');
  });

  it('shallow-merges nested positions and preserves unrelated keys', () => {
    const body = {
      providerOptions: {
        gateway: { extraField: 'kept', nested: { deep: true } },
        otherProviderOption: 7,
      },
      provider: { allow_fallbacks: false, extraProviderKey: 'kept' },
    };
    const injected = injectUpstreamProviderPin(body, onlyPin);

    expect(injected.providerOptions).toEqual({
      gateway: { extraField: 'kept', nested: { deep: true }, only: ['deepseek'] },
      otherProviderOption: 7,
    });
    // S1：payloadRules 写入的 allow_fallbacks 必须保留
    expect(injected.provider).toEqual({
      allow_fallbacks: false,
      extraProviderKey: 'kept',
      only: ['deepseek'],
    });
  });

  it('does not mutate the input body (shallow copy only)', () => {
    const body = {
      providerOptions: { gateway: { order: ['old'] } },
      provider: { order: ['old'] },
    };
    const snapshot = structuredClone(body);

    const injected = injectUpstreamProviderPin(body, onlyPin);

    expect(body).toEqual(snapshot);
    expect(injected).not.toBe(body);
    expect(injected.providerOptions).not.toBe(body.providerOptions);
  });

  describe('S3 boundary tolerance table', () => {
    it('skips nested injection when providerOptions exists but is not a plain object', () => {
      const body = { providerOptions: 'weird' as unknown, model: 'm' };
      const injected = injectUpstreamProviderPin(body, onlyPin);

      expect(injected.providerOptions).toBe('weird');
      expect(injected.provider).toEqual({ only: ['deepseek'] });

      const arrayBody = { providerOptions: [1, 2] as unknown };
      const injectedArray = injectUpstreamProviderPin(arrayBody, onlyPin);
      expect(injectedArray.providerOptions).toEqual([1, 2]);
      expect(injectedArray.provider).toEqual({ only: ['deepseek'] });
    });

    it('skips nested injection when gateway exists but is not a plain object', () => {
      const body = {
        providerOptions: { gateway: 'weird' as unknown, keep: true },
        provider: {},
      };
      const injected = injectUpstreamProviderPin(body, onlyPin);

      expect(injected.providerOptions).toEqual({ gateway: 'weird', keep: true });
      expect(injected.provider).toEqual({ only: ['deepseek'] });
    });

    it('skips top-level injection when provider is a string or array', () => {
      const stringBody = { provider: 'openai' as unknown };
      const injectedString = injectUpstreamProviderPin(stringBody, onlyPin);
      expect(injectedString.provider).toBe('openai');
      expect(injectedString.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });

      const arrayBody = { provider: ['openai'] as unknown };
      const injectedArray = injectUpstreamProviderPin(arrayBody, onlyPin);
      expect(injectedArray.provider).toEqual(['openai']);
      expect(injectedArray.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    });

    it('returns the body untouched when providers are empty', () => {
      const body = { model: 'm' };
      const result = injectUpstreamProviderPin(body, { providers: [], mode: 'only' });
      expect(result).toBe(body);

      const invalid = injectUpstreamProviderPin(body, {
        providers: undefined as unknown as string[],
        mode: 'only',
      });
      expect(invalid).toBe(body);
    });
  });

  it('keeps unrelated body keys byte-identical through JSON serialization', () => {
    const body = {
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { trace: 'abc' },
    };
    const injected = injectUpstreamProviderPin(body, orderPin);

    for (const key of Object.keys(body)) {
      expect(JSON.stringify(injected[key as keyof typeof injected]))
        .toBe(JSON.stringify(body[key as keyof typeof body]));
    }
  });
});
