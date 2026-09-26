import { describe, expect, it } from 'vitest';

import {
  GENERIC_DUAL_ADAPTER,
  UPSTREAM_PIN_ADAPTERS,
  UPSTREAM_PIN_ADAPTER_IDS,
  ZERO_INJECTION_ADAPTER,
  getUpstreamPinAdapter,
  isUpstreamPinAdapterId,
} from './registry.js';
import { listUpstreamPinAdapterCatalog } from '../../../../shared/upstreamPinAdapters.js';
import { injectUpstreamProviderPin } from '../inject.js';

describe('upstream pin adapter registry', () => {
  it('registers exactly the four implemented Phase 1 adapters', () => {
    expect(UPSTREAM_PIN_ADAPTER_IDS).toEqual([
      'generic-dual',
      'openrouter',
      'vercel-ai-gateway',
      'none',
    ]);
    expect(UPSTREAM_PIN_ADAPTERS.map((adapter) => adapter.id)).toEqual([...UPSTREAM_PIN_ADAPTER_IDS]);
    // Phase 2 适配器未注册：PUT 白名单以注册表键集为准（提交即 400）
    for (const id of ['portkey', 'helicone', 'litellm', 'new-api']) {
      expect(getUpstreamPinAdapter(id)).toBeNull();
      expect(isUpstreamPinAdapterId(id)).toBe(false);
    }
  });

  it('takes id / label / mechanism / capabilities / notes metadata from the shared catalog', () => {
    const catalog = listUpstreamPinAdapterCatalog();
    expect(UPSTREAM_PIN_ADAPTERS).toHaveLength(catalog.length);
    for (const entry of catalog) {
      const adapter = getUpstreamPinAdapter(entry.id);
      expect(adapter).not.toBeNull();
      expect(adapter).toMatchObject({
        id: entry.id,
        label: entry.label,
        mechanism: entry.mechanism,
        capabilities: entry.capabilities,
        notes: entry.notes,
      });
    }
  });

  it('pins the S1 hard guarantee: generic-dual.applyBody IS injectUpstreamProviderPin (同一函数引用)', () => {
    expect(GENERIC_DUAL_ADAPTER.id).toBe('generic-dual');
    expect(GENERIC_DUAL_ADAPTER.applyBody).toBe(injectUpstreamProviderPin);
    expect(GENERIC_DUAL_ADAPTER.capabilities).toEqual({ only: true, order: true });
  });

  it('ships none / zero-injection adapter without any apply hooks', () => {
    expect(ZERO_INJECTION_ADAPTER.id).toBe('none');
    expect(getUpstreamPinAdapter('none')).toBe(ZERO_INJECTION_ADAPTER);
    expect(ZERO_INJECTION_ADAPTER.applyBody).toBeUndefined();
    expect(ZERO_INJECTION_ADAPTER.applyHeaders).toBeUndefined();
    expect(ZERO_INJECTION_ADAPTER.capabilities).toEqual({ only: false, order: false });
  });

  it('keeps body-family adapters as pure body hooks (no header hooks in Phase 1)', () => {
    for (const id of ['generic-dual', 'openrouter', 'vercel-ai-gateway'] as const) {
      const adapter = getUpstreamPinAdapter(id)!;
      expect(adapter.mechanism).toBe('body');
      expect(typeof adapter.applyBody).toBe('function');
      expect(adapter.applyHeaders).toBeUndefined();
    }
  });

  it('resolves ids loosely (trim) and returns null for non-strings without throwing', () => {
    expect(getUpstreamPinAdapter(' openrouter ')?.id).toBe('openrouter');
    for (const value of [null, undefined, 42, {}, '', '   ']) {
      expect(getUpstreamPinAdapter(value)).toBeNull();
    }
  });
});
