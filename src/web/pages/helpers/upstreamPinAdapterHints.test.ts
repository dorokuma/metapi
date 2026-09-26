import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UPSTREAM_PIN_ADAPTER_ID,
  resolveUpstreamPinAdapterForSite,
  resolveUpstreamPinRuleAdapterHint,
} from './upstreamPinAdapterHints.js';
import { getUpstreamPinAdapterCatalogEntry } from '../../../shared/upstreamPinAdapters.js';
import type { UpstreamPinAdapterCatalogEntry } from '../../../shared/upstreamPinAdapters.js';

const OPENROUTER = getUpstreamPinAdapterCatalogEntry('openrouter')!;
const NONE = getUpstreamPinAdapterCatalogEntry('none')!;

describe('resolveUpstreamPinAdapterForSite', () => {
  it('falls back to the default dual-posture adapter when the site has no mapping', () => {
    const resolved = resolveUpstreamPinAdapterForSite({ adapterMap: {}, siteId: 49 });
    expect(resolved.adapter?.id).toBe(DEFAULT_UPSTREAM_PIN_ADAPTER_ID);
    expect(resolved.unknownAdapterId).toBeNull();

    // siteId 未填写（0）= 新增空行：按默认展示，不报未知
    const draft = resolveUpstreamPinAdapterForSite({ adapterMap: {}, siteId: 0 });
    expect(draft.adapter?.id).toBe(DEFAULT_UPSTREAM_PIN_ADAPTER_ID);
    expect(draft.unknownAdapterId).toBeNull();
  });

  it('resolves registered ids and reports unregistered ids separately (服务端零注入在 UI 的镜像)', () => {
    const openrouter = resolveUpstreamPinAdapterForSite({
      adapterMap: { '49': 'openrouter' },
      siteId: 49,
    });
    expect(openrouter.adapter?.id).toBe('openrouter');
    expect(openrouter.unknownAdapterId).toBeNull();

    const unknown = resolveUpstreamPinAdapterForSite({
      adapterMap: { '49': 'litellm' },
      siteId: 49,
    });
    expect(unknown.adapter).toBeNull();
    expect(unknown.unknownAdapterId).toBe('litellm');
  });
});

describe('resolveUpstreamPinRuleAdapterHint (S2 按 mode 查能力)', () => {
  it('shows the adapter label without warning when the mode is expressible', () => {
    expect(resolveUpstreamPinRuleAdapterHint({
      adapter: OPENROUTER,
      unknownAdapterId: null,
      mode: 'only',
    })).toEqual({ label: 'OpenRouter', warning: null });

    expect(resolveUpstreamPinRuleAdapterHint({
      adapter: OPENROUTER,
      unknownAdapterId: null,
      mode: 'order',
    }).warning).toBeNull();
  });

  it('warns per mode: only checks capabilities.only, order checks capabilities.order', () => {
    const orderCapableOnly: UpstreamPinAdapterCatalogEntry = {
      id: 'vercel-ai-gateway',
      label: '合成适配器',
      mechanism: 'body',
      capabilities: { only: false, order: true },
      notes: '',
    };

    const onlyHint = resolveUpstreamPinRuleAdapterHint({
      adapter: orderCapableOnly,
      unknownAdapterId: null,
      mode: 'only',
    });
    expect(onlyHint.warning).toContain('无法严格表达 only');
    expect(onlyHint.warning).toContain('该请求不会受本规则约束');

    const orderHint = resolveUpstreamPinRuleAdapterHint({
      adapter: orderCapableOnly,
      unknownAdapterId: null,
      mode: 'order',
    });
    expect(orderHint.warning).toBeNull();

    const onlyCapableOnly: UpstreamPinAdapterCatalogEntry = {
      ...orderCapableOnly,
      capabilities: { only: true, order: false },
    };
    expect(resolveUpstreamPinRuleAdapterHint({
      adapter: onlyCapableOnly,
      unknownAdapterId: null,
      mode: 'only',
    }).warning).toBeNull();
    expect(resolveUpstreamPinRuleAdapterHint({
      adapter: onlyCapableOnly,
      unknownAdapterId: null,
      mode: 'order',
    }).warning).toContain('无法严格表达 order');
  });

  it('uses the honest none copy for the no-mechanism adapter regardless of mode (O5)', () => {
    for (const mode of ['only', 'order'] as const) {
      const hint = resolveUpstreamPinRuleAdapterHint({
        adapter: NONE,
        unknownAdapterId: null,
        mode,
      });
      expect(hint.label).toBe(NONE.label);
      expect(hint.warning).toBe('该网关无请求体钉选机制，规则不会注入。');
    }
  });

  it('warns for unregistered ids without throwing', () => {
    const hint = resolveUpstreamPinRuleAdapterHint({
      adapter: null,
      unknownAdapterId: 'portkey',
      mode: 'only',
    });
    expect(hint.label).toContain('未知适配器「portkey」');
    expect(hint.warning).toContain('该请求不会受本规则约束');
  });
});
