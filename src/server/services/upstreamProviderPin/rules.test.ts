import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import {
  normalizeUpstreamProviderPinRules,
  parseUpstreamProviderPinRules,
  resolveUpstreamProviderPin,
  toUpstreamProviderPinStoredRules,
} from './rules.js';

const originalSettings = {
  enabled: config.upstreamProviderPinEnabled,
  rules: config.upstreamProviderPinRules,
};

function restoreSettings() {
  config.upstreamProviderPinEnabled = originalSettings.enabled;
  config.upstreamProviderPinRules = originalSettings.rules;
}

describe('upstreamProviderPin rules', () => {
  beforeEach(() => {
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: 49, model: 'cline-pass/deepseek-v4.1-flash', providers: ['deepseek'], mode: 'only' },
    ]);
  });

  afterEach(restoreSettings);

  describe('normalizeUpstreamProviderPinRules', () => {
    it('keeps the four-field shape and compiles a matcher for each rule', () => {
      const rules = normalizeUpstreamProviderPinRules([
        { siteId: 49, model: 'cline-pass/*', providers: ['deepseek', 'alibaba'], mode: 'order' },
      ]);

      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        siteId: 49,
        model: 'cline-pass/*',
        providers: ['deepseek', 'alibaba'],
        mode: 'order',
      });
      expect(typeof rules[0].match).toBe('function');
      expect(rules[0].match('cline-pass/deepseek-v4.1-flash')).toBe(true);
      expect(rules[0].match('cline-pass/')).toBe(true);
    });

    it('accepts a JSON string (stored form) and drops invalid entries', () => {
      const rules = normalizeUpstreamProviderPinRules(JSON.stringify([
        { siteId: 49, model: 'm', providers: ['deepseek'], mode: 'only' },
        { siteId: 'bad', model: 'm', providers: ['deepseek'], mode: 'only' },
        { siteId: 50, model: '', providers: ['deepseek'], mode: 'only' },
        { siteId: 51, model: 'm', providers: [], mode: 'only' },
        { siteId: 52, model: 'm', providers: ['deepseek'], mode: 'sometimes' },
        'not-an-object',
        null,
      ]));

      expect(rules).toHaveLength(1);
      expect(rules[0].siteId).toBe(49);
    });

    it('dedupes by siteId + model, trims providers and drops duplicates/empties', () => {
      const rules = normalizeUpstreamProviderPinRules([
        { siteId: 49, model: ' m ', providers: ['deepseek', ' deepseek ', '', 'alibaba'], mode: 'only' },
        { siteId: 49, model: 'm', providers: ['other'], mode: 'order' },
        { siteId: '49', model: 'm', providers: ['other'], mode: 'order' },
      ]);

      expect(rules).toHaveLength(1);
      expect(rules[0].providers).toEqual(['deepseek', 'alibaba']);
      expect(rules[0].model).toBe('m');
    });

    it('returns an empty array for empty/invalid payloads', () => {
      expect(normalizeUpstreamProviderPinRules(undefined)).toEqual([]);
      expect(normalizeUpstreamProviderPinRules(null)).toEqual([]);
      expect(normalizeUpstreamProviderPinRules('')).toEqual([]);
      expect(normalizeUpstreamProviderPinRules('{not json')).toEqual([]);
      expect(normalizeUpstreamProviderPinRules({ foo: 'bar' })).toEqual([]);
    });
  });

  describe('parseUpstreamProviderPinRules (strict PUT validation)', () => {
    it('returns the raw four-field shape without compiled artifacts', () => {
      const result = parseUpstreamProviderPinRules([
        { siteId: 49, model: 'cline-pass/*', providers: ['deepseek', ' deepseek '], mode: 'order' },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rules).toEqual([
        { siteId: 49, model: 'cline-pass/*', providers: ['deepseek'], mode: 'order' },
      ]);
      expect(Object.keys(result.rules[0]).sort()).toEqual(['mode', 'model', 'providers', 'siteId']);
      expect((result.rules[0] as Record<string, unknown>).match).toBeUndefined();
    });

    it('parses a JSON string first (W-4) and rejects malformed JSON', () => {
      const parsed = parseUpstreamProviderPinRules(JSON.stringify([
        { siteId: 49, model: 'm', providers: ['deepseek'], mode: 'only' },
      ]));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.rules).toHaveLength(1);

      const malformed = parseUpstreamProviderPinRules('{not json');
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.message).toContain('不是合法的 JSON');
    });

    it('rejects non-array payloads', () => {
      const result = parseUpstreamProviderPinRules({ siteId: 49 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('必须是数组');
    });

    it('rejects field type errors with a specific position message', () => {
      const badSiteId = parseUpstreamProviderPinRules([{ siteId: 0, model: 'm', providers: ['a'], mode: 'only' }]);
      expect(badSiteId.ok).toBe(false);
      if (!badSiteId.ok) expect(badSiteId.message).toContain('第 1 条规则');

      const badModel = parseUpstreamProviderPinRules([{ siteId: 1, model: 42, providers: ['a'], mode: 'only' }]);
      expect(badModel.ok).toBe(false);
      if (!badModel.ok) expect(badModel.message).toContain('model 必须是字符串');

      const emptyModel = parseUpstreamProviderPinRules([{ siteId: 1, model: '  ', providers: ['a'], mode: 'only' }]);
      expect(emptyModel.ok).toBe(false);
      if (!emptyModel.ok) expect(emptyModel.message).toContain('model 不能为空');

      const badProviders = parseUpstreamProviderPinRules([{ siteId: 1, model: 'm', providers: 'a', mode: 'only' }]);
      expect(badProviders.ok).toBe(false);
      if (!badProviders.ok) expect(badProviders.message).toContain('providers 必须是字符串数组');

      const nonStringProvider = parseUpstreamProviderPinRules([{ siteId: 1, model: 'm', providers: ['a', 2], mode: 'only' }]);
      expect(nonStringProvider.ok).toBe(false);
      if (!nonStringProvider.ok) expect(nonStringProvider.message).toContain('providers 只能包含字符串');

      const badMode = parseUpstreamProviderPinRules([{ siteId: 1, model: 'm', providers: ['a'], mode: 'first' }]);
      expect(badMode.ok).toBe(false);
      if (!badMode.ok) expect(badMode.message).toContain('mode 只能是 only 或 order');
    });

    it('rejects empty providers', () => {
      const emptyArray = parseUpstreamProviderPinRules([{ siteId: 1, model: 'm', providers: [], mode: 'only' }]);
      expect(emptyArray.ok).toBe(false);
      if (!emptyArray.ok) expect(emptyArray.message).toContain('providers 不能为空');

      const blankOnly = parseUpstreamProviderPinRules([{ siteId: 1, model: 'm', providers: ['  ', ''], mode: 'only' }]);
      expect(blankOnly.ok).toBe(false);
      if (!blankOnly.ok) expect(blankOnly.message).toContain('providers 不能为空');
    });

    it('rejects duplicate siteId + model combinations regardless of other fields', () => {
      const result = parseUpstreamProviderPinRules([
        { siteId: 49, model: 'm', providers: ['deepseek'], mode: 'only' },
        { siteId: 49, model: 'm', providers: ['alibaba'], mode: 'order' },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('存在重复规则');
        expect(result.message).toContain('第 2 条');
      }
    });

    it('accepts an empty array (clears all rules) and non-object items are rejected', () => {
      const cleared = parseUpstreamProviderPinRules([]);
      expect(cleared.ok).toBe(true);
      if (cleared.ok) expect(cleared.rules).toEqual([]);

      const notObject = parseUpstreamProviderPinRules(['rule']);
      expect(notObject.ok).toBe(false);
      if (!notObject.ok) expect(notObject.message).toContain('第 1 条规则必须是对象');
    });
  });

  describe('toUpstreamProviderPinStoredRules', () => {
    it('strips compiled artifacts back to the four-field shape', () => {
      const compiled = normalizeUpstreamProviderPinRules([
        { siteId: 49, model: 'm', providers: ['deepseek'], mode: 'only' },
      ]);
      const stored = toUpstreamProviderPinStoredRules(compiled);

      expect(stored).toEqual([{ siteId: 49, model: 'm', providers: ['deepseek'], mode: 'only' }]);
      expect(Object.keys(stored[0]).sort()).toEqual(['mode', 'model', 'providers', 'siteId']);
    });
  });

  describe('resolveUpstreamProviderPin', () => {
    beforeEach(() => {
      config.upstreamProviderPinEnabled = true;
      config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
        { siteId: 49, model: 'cline-pass/*', providers: ['deepseek', 'alibaba'], mode: 'order' },
        { siteId: 49, model: 'other/model', providers: ['baseten'], mode: 'only' },
        { siteId: 7, model: '*', providers: ['fallback-provider'], mode: 'order' },
      ]);
    });

    it('matches exact model names', () => {
      expect(resolveUpstreamProviderPin({
        siteId: 49,
        requestedModel: 'other/model',
      })).toEqual({ providers: ['baseten'], mode: 'only' });
    });

    it('matches wildcard patterns against the whole string (anchored, case sensitive)', () => {
      expect(resolveUpstreamProviderPin({
        siteId: 49,
        requestedModel: 'cline-pass/deepseek-v4.1-flash',
      })).toEqual({ providers: ['deepseek', 'alibaba'], mode: 'order' });

      // 全串锚定：不含前缀的子串不命中
      expect(resolveUpstreamProviderPin({
        siteId: 49,
        requestedModel: 'xcline-pass/abcx',
      })).toBeNull();
      // 大小写敏感
      expect(resolveUpstreamProviderPin({
        siteId: 49,
        requestedModel: 'Cline-Pass/deepseek-v4.1-flash',
      })).toBeNull();
    });

    it('returns the first matching rule in array order', () => {
      config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
        { siteId: 49, model: '*', providers: ['first'], mode: 'only' },
        { siteId: 49, model: 'm', providers: ['second'], mode: 'order' },
      ]);
      expect(resolveUpstreamProviderPin({
        siteId: 49,
        requestedModel: 'm',
      })).toEqual({ providers: ['first'], mode: 'only' });
    });

    it('requires the master switch', () => {
      config.upstreamProviderPinEnabled = false;
      expect(resolveUpstreamProviderPin({
        siteId: 49,
        requestedModel: 'other/model',
      })).toBeNull();
    });

    it('returns null for empty rules, unselected sites and invalid site ids', () => {
      config.upstreamProviderPinRules = [];
      expect(resolveUpstreamProviderPin({ siteId: 49, requestedModel: 'm' })).toBeNull();

      config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
        { siteId: 49, model: '*', providers: ['a'], mode: 'only' },
      ]);
      expect(resolveUpstreamProviderPin({ siteId: 12, requestedModel: 'm' })).toBeNull();
      expect(resolveUpstreamProviderPin({ siteId: null, requestedModel: 'm' })).toBeNull();
      expect(resolveUpstreamProviderPin({ siteId: undefined, requestedModel: 'm' })).toBeNull();
      expect(resolveUpstreamProviderPin({ siteId: 49, requestedModel: '' })).toBeNull();
    });

    it('returns a copy of providers so callers can never mutate config', () => {
      const resolved = resolveUpstreamProviderPin({
        siteId: 49,
        requestedModel: 'other/model',
      });
      expect(resolved).not.toBeNull();
      resolved!.providers.push('mutated');
      expect(config.upstreamProviderPinRules[1].providers).toEqual(['baseten']);
    });
  });
});
