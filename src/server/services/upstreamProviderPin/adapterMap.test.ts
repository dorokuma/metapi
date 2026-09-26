import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../config.js';
import {
  normalizeUpstreamPinAdapterMap,
  parseUpstreamPinAdapterMap,
  resolveUpstreamPinAdapter,
  toStoredAdapterMap,
} from './adapterMap.js';
import { applyUpstreamProviderPin } from './apply.js';
import { normalizeUpstreamProviderPinRules } from './rules.js';

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

describe('normalizeUpstreamPinAdapterMap (宽松归一：hydration / env / 导入)', () => {
  it('accepts raw objects and JSON strings, canonicalizing numeric string keys', () => {
    expect(normalizeUpstreamPinAdapterMap({ 49: 'openrouter' })).toEqual({ 49: 'openrouter' });
    expect(normalizeUpstreamPinAdapterMap({ '49': 'openrouter' })).toEqual({ 49: 'openrouter' });
    expect(normalizeUpstreamPinAdapterMap({ '049': 'none' })).toEqual({ 49: 'none' });
    expect(normalizeUpstreamPinAdapterMap({ '49 ': 'openrouter' })).toEqual({ 49: 'openrouter' });
    expect(normalizeUpstreamPinAdapterMap('{"49":"openrouter"}')).toEqual({ 49: 'openrouter' });
  });

  it('drops fractional / non-positive / non-numeric keys and non-string values (S6①)', () => {
    expect(normalizeUpstreamPinAdapterMap({
      '49.9': 'openrouter',
      '0': 'openrouter',
      '-5': 'openrouter',
      abc: 'openrouter',
      '': 'openrouter',
      '7': 42,
      '8': '',
      '9': null,
      '10': ['openrouter'],
    })).toEqual({});
  });

  it('keeps unregistered ids so the hot path can zero-inject instead of double-posture (M2)', () => {
    expect(normalizeUpstreamPinAdapterMap({ '50': 'litellm' })).toEqual({ 50: 'litellm' });
  });

  it('keeps the first entry when two keys normalize to the same site id (对齐 rules 宽松归一先例)', () => {
    expect(normalizeUpstreamPinAdapterMap({ '49 ': 'openrouter', '049': 'none' }))
      .toEqual({ 49: 'openrouter' });
    expect(normalizeUpstreamPinAdapterMap({ '049': 'none', '49 ': 'openrouter' }))
      .toEqual({ 49: 'none' });
  });

  it('returns {} for malformed or non-object input without throwing', () => {
    for (const value of [undefined, null, '{not json', '[1]', 42, [], '']) {
      expect(normalizeUpstreamPinAdapterMap(value)).toEqual({});
    }
  });
});

describe('parseUpstreamPinAdapterMap (严格 PUT)', () => {
  it('parses and canonicalizes a valid map, accepting JSON strings', () => {
    expect(parseUpstreamPinAdapterMap({ '49': 'openrouter', '7': 'none' }))
      .toEqual({ ok: true, map: { 49: 'openrouter', 7: 'none' } });
    expect(parseUpstreamPinAdapterMap('{"49":"vercel-ai-gateway"}'))
      .toEqual({ ok: true, map: { 49: 'vercel-ai-gateway' } });
    expect(parseUpstreamPinAdapterMap('{"049":"none"}')).toEqual({ ok: true, map: { 49: 'none' } });
    expect(parseUpstreamPinAdapterMap({})).toEqual({ ok: true, map: {} });
    expect(parseUpstreamPinAdapterMap('')).toEqual({ ok: true, map: {} });
  });

  it('rejects malformed strings and non-object payloads with specific messages', () => {
    const malformed = parseUpstreamPinAdapterMap('{not json');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.message).toContain('不是合法的 JSON');

    for (const value of [42, [1], 'null', '[]']) {
      const result = parseUpstreamPinAdapterMap(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('必须是对象');
    }
  });

  it('rejects invalid keys (fractional / non-positive / non-numeric)', () => {
    for (const key of ['49.9', '0', '-3', 'abc', '']) {
      const result = parseUpstreamPinAdapterMap({ [key]: 'openrouter' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('必须是正整数站点 id');
    }
  });

  it('rejects values outside the registry key set (Phase 1 whitelist = 已注册四家，Phase 2 适配器也拒绝)', () => {
    for (const id of ['portkey', 'helicone', 'litellm']) {
      const notSupported = parseUpstreamPinAdapterMap({ '49': id });
      expect(notSupported.ok).toBe(false);
      if (!notSupported.ok) {
        expect(notSupported.message).toContain('不在支持列表');
        expect(notSupported.message).toContain('generic-dual、openrouter、vercel-ai-gateway、none');
      }
    }

    for (const value of [42, '', '   ', null]) {
      const result = parseUpstreamPinAdapterMap({ '49': value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('必须是');
    }
  });

  it('rejects two keys normalizing to the same site id as a duplicate (S6①)', () => {
    const result = parseUpstreamPinAdapterMap({ '49 ': 'openrouter', '049': 'none' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('存在重复');
  });
});

describe('toStoredAdapterMap (S3：往返 = 重启等价)', () => {
  it('converts compiled maps to the stored string-key shape, keeping unregistered ids', () => {
    expect(toStoredAdapterMap({ 49: 'openrouter', 7: 'litellm' }))
      .toEqual({ '49': 'openrouter', '7': 'litellm' });
    expect(Object.keys(toStoredAdapterMap({ 49: 'openrouter' }))).toEqual(['49']);
  });

  it('skips invalid entries and returns {} for non-object input', () => {
    expect(toStoredAdapterMap({ '49.9': 'openrouter', 7: '' } as unknown as Record<number, string>))
      .toEqual({});
    expect(toStoredAdapterMap(undefined)).toEqual({});
    expect(toStoredAdapterMap(null)).toEqual({});
  });
});

describe('resolveUpstreamPinAdapter (热路径，total 不抛)', () => {
  beforeEach(() => {
    config.upstreamProviderPinAdapterMap = {};
  });

  it('falls back to generic-dual when the site is not configured or siteId is malformed', () => {
    expect(resolveUpstreamPinAdapter(49).id).toBe('generic-dual');
    for (const siteId of [null, NaN, -1, 0, 1.5, 'x' as unknown as number]) {
      expect(resolveUpstreamPinAdapter(siteId).id).toBe('generic-dual');
    }
  });

  it('resolves registered ids and never throws on malformed compiled maps', () => {
    config.upstreamProviderPinAdapterMap = { 49: 'openrouter', 7: 'vercel-ai-gateway', 8: 'none' };
    expect(resolveUpstreamPinAdapter(49).id).toBe('openrouter');
    expect(resolveUpstreamPinAdapter(7).id).toBe('vercel-ai-gateway');
    expect(resolveUpstreamPinAdapter(8).id).toBe('none');

    for (const malformed of [null, 'string', 42, []]) {
      (config as { upstreamProviderPinAdapterMap: unknown }).upstreamProviderPinAdapterMap = malformed;
      expect(resolveUpstreamPinAdapter(49).id).toBe('generic-dual');
    }
  });

  it('returns the zero-injection adapter for unregistered ids (M2 回滚场景：DB 残留未知 id)', () => {
    config.upstreamProviderPinAdapterMap = { 49: 'litellm' };
    const adapter = resolveUpstreamPinAdapter(49);
    expect(adapter.id).toBe('none');
    expect(adapter.applyBody).toBeUndefined();

    // 命中规则时零注入，而不是回落双姿势
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: 49, model: '*', providers: ['deepseek'], mode: 'only' },
    ]);
    const application = applyUpstreamProviderPin({
      body: { model: 'm', messages: [] },
      headers: { 'Content-Type': 'application/json' },
      siteId: 49,
      requestedModel: 'm',
    });
    expect(application.outcome).toBe('skipped');
    expect(application.adapterId).toBe('none');
    expect(application.body).toEqual({ model: 'm', messages: [] });
    expect(application.body.provider).toBeUndefined();
    expect(application.body.providerOptions).toBeUndefined();
  });
});
