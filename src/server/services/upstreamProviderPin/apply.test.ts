import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../config.js';
import { applyUpstreamPinWithAdapter, applyUpstreamProviderPin } from './apply.js';
import { normalizeUpstreamProviderPinRules } from './rules.js';
import type { UpstreamPinAdapter } from './adapters/types.js';

const originalConfig = {
  map: config.upstreamProviderPinAdapterMap,
  enabled: config.upstreamProviderPinEnabled,
  rules: config.upstreamProviderPinRules,
};

afterEach(() => {
  config.upstreamProviderPinAdapterMap = originalConfig.map;
  config.upstreamProviderPinEnabled = originalConfig.enabled;
  config.upstreamProviderPinRules = originalConfig.rules;
});

describe('applyUpstreamProviderPin (命中判定 + 适配器解析 + 能力协商)', () => {
  beforeEach(() => {
    config.upstreamProviderPinAdapterMap = {};
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: 49, model: 'exact-model', providers: ['deepseek'], mode: 'only' },
    ]);
  });

  it('returns the same body / headers references when the rule does not hit', () => {
    const body = { model: 'm' };
    const headers = { accept: 'application/json' };

    const missModel = applyUpstreamProviderPin({
      body,
      headers,
      siteId: 49,
      requestedModel: 'other/model',
    });
    expect(missModel.outcome).toBe('miss');
    expect(missModel.adapterId).toBeNull();
    expect(missModel.body).toBe(body);
    expect(missModel.headers).toBe(headers);

    const missSite = applyUpstreamProviderPin({
      body,
      headers,
      siteId: 999,
      requestedModel: 'exact-model',
    });
    expect(missSite.outcome).toBe('miss');

    const noSiteId = applyUpstreamProviderPin({
      body,
      headers,
      siteId: null,
      requestedModel: 'exact-model',
    });
    expect(noSiteId.outcome).toBe('miss');

    config.upstreamProviderPinEnabled = false;
    const disabled = applyUpstreamProviderPin({
      body,
      headers,
      siteId: 49,
      requestedModel: 'exact-model',
    });
    expect(disabled.outcome).toBe('miss');
  });

  it('applies the default generic-dual adapter when the site has no adapter configured', () => {
    const body = { model: 'm' };
    const headers = { 'Content-Type': 'application/json' };

    const applied = applyUpstreamProviderPin({
      body,
      headers,
      siteId: 49,
      requestedModel: 'exact-model',
    });

    expect(applied.outcome).toBe('applied');
    expect(applied.adapterId).toBe('generic-dual');
    expect(applied.body.provider).toEqual({ only: ['deepseek'] });
    expect(applied.body.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    // 无 header 钩子 → 原引用返回（调用点必须使用返回值，见 types.ts 契约）
    expect(applied.headers).toBe(headers);
  });

  it('skips injection entirely (body and headers untouched) for the none adapter', () => {
    config.upstreamProviderPinAdapterMap = { 49: 'none' };
    const body = { model: 'm' };
    const headers = { accept: 'application/json' };

    const skipped = applyUpstreamProviderPin({
      body,
      headers,
      siteId: 49,
      requestedModel: 'exact-model',
    });

    expect(skipped.outcome).toBe('skipped');
    expect(skipped.adapterId).toBe('none');
    expect(skipped.body).toBe(body);
    expect(skipped.headers).toBe(headers);
  });
});

describe('applyUpstreamPinWithAdapter (纯分发与能力协商，合成适配器覆盖分支)', () => {
  const pinOnly = { providers: ['a'], mode: 'only' as const };
  const pinOrder = { providers: ['a'], mode: 'order' as const };

  it('checks the capability by mode: only→capabilities.only, order→capabilities.order (S2 服务端侧)', () => {
    const adapter: UpstreamPinAdapter = {
      id: 'vercel-ai-gateway',
      label: 'capability-test',
      mechanism: 'body',
      capabilities: { only: false, order: true },
      notes: '',
      applyBody: (body) => ({ ...body, hit: true }),
    };

    expect(applyUpstreamPinWithAdapter({
      body: {},
      headers: { h: '1' },
      pin: pinOnly,
      adapter,
    })).toEqual({ body: {}, headers: { h: '1' }, outcome: 'skipped' });

    const orderResult = applyUpstreamPinWithAdapter({
      body: {},
      headers: { h: '1' },
      pin: pinOrder,
      adapter,
    });
    expect(orderResult.outcome).toBe('applied');
    expect(orderResult.body).toEqual({ hit: true });
  });

  it('exercises the header hook (Phase 2 挂点) and never mutates the input headers', () => {
    const adapter: UpstreamPinAdapter = {
      id: 'none',
      label: 'header-hook-test',
      mechanism: 'header',
      capabilities: { only: true, order: true },
      notes: '',
      applyHeaders: (headers, pin) => ({ ...headers, 'x-test-provider': pin.providers.join(',') }),
    };
    const headers = { 'Content-Type': 'application/json' };

    const result = applyUpstreamPinWithAdapter({
      body: { model: 'm' },
      headers,
      pin: pinOrder,
      adapter,
    });

    expect(result.outcome).toBe('applied');
    expect(result.headers).toEqual({
      'Content-Type': 'application/json',
      'x-test-provider': 'a',
    });
    expect(result.body).toEqual({ model: 'm' });
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });
});
