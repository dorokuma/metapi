import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../config.js';
import { normalizeUpstreamParamCompatRules, type UpstreamParamCompatRule } from './rules.js';
import { stripUnsupportedUpstreamParams } from './strip.js';

const originalSettings = {
  enabled: config.upstreamParamCompatEnabled,
  selfHealEnabled: config.upstreamParamCompatSelfHealEnabled,
  rules: config.upstreamParamCompatRules,
};

function restoreSettings() {
  config.upstreamParamCompatEnabled = originalSettings.enabled;
  config.upstreamParamCompatSelfHealEnabled = originalSettings.selfHealEnabled;
  config.upstreamParamCompatRules = originalSettings.rules;
}

function bodyWithUnknownKeys() {
  return {
    model: 'GLM-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    prompt_cache_key: 'cache-1',
    prompt_cache_retention: '24h',
  };
}

describe('stripUnsupportedUpstreamParams', () => {
  beforeEach(() => {
    config.upstreamParamCompatEnabled = true;
    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['prompt_cache_key', 'prompt_cache_retention'] },
    ]);
  });

  afterEach(restoreSettings);

  it('deletes the named top-level keys for a matching site without mutating the input', () => {
    const body = bodyWithUnknownKeys();
    const stripped = stripUnsupportedUpstreamParams(body, {
      siteId: 9,
      requestedModel: 'GLM-5.3',
      actualModel: 'glm-upstream-actual',
      endpoint: 'chat',
    });

    expect(stripped).not.toBe(body);
    expect(stripped).toEqual({
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 原对象不被 mutate
    expect(body.prompt_cache_key).toBe('cache-1');
    expect(body.prompt_cache_retention).toBe('24h');
  });

  it('returns the original reference when the master switch is off (even with rules + self-heal on)', () => {
    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatSelfHealEnabled = true;

    const body = bodyWithUnknownKeys();
    expect(stripUnsupportedUpstreamParams(body, {
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toBe(body);
  });

  it('returns the original reference for empty rules, other sites, missing siteId and absent keys', () => {
    const body = bodyWithUnknownKeys();

    config.upstreamParamCompatRules = [];
    expect(stripUnsupportedUpstreamParams(body, {
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toBe(body);

    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: 'GLM-5.3', params: ['prompt_cache_key'] },
    ]);
    // siteId 不命中
    expect(stripUnsupportedUpstreamParams(body, {
      siteId: 7,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toBe(body);
    // 无 siteId（WS / 测活 / gemini 面）
    expect(stripUnsupportedUpstreamParams(body, {
      siteId: undefined,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toBe(body);
    // 规则命中但键不在 body 顶层
    expect(stripUnsupportedUpstreamParams({ model: 'GLM-5.3' }, {
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toEqual({ model: 'GLM-5.3' });
  });

  it('does not strip messages unless the rule opts in explicitly', () => {
    const body = bodyWithUnknownKeys();
    expect(stripUnsupportedUpstreamParams(body, {
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'messages',
    })).toBe(body);

    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['prompt_cache_key'], endpoints: ['messages'] },
    ]);
    expect(stripUnsupportedUpstreamParams(body, {
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'messages',
    })).toEqual({
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_retention: '24h',
    });
  });

  it('re-validates every name on the hot path and never deletes structural keys', () => {
    // 模拟「内存里的编译结果被绕过」：直接塞入含结构键的规则。
    const bypassedRules: UpstreamParamCompatRule[] = [{
      siteId: 9,
      model: '*',
      params: ['model', 'system', '__proto__', 'prompt_cache_key'],
      match: () => true,
    }];
    config.upstreamParamCompatRules = bypassedRules;

    const stripped = stripUnsupportedUpstreamParams(bodyWithUnknownKeys(), {
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    });

    expect(stripped).not.toHaveProperty('prompt_cache_key');
    expect(stripped.model).toBe('GLM-5.3');
    expect(stripped).not.toHaveProperty('system');
  });
});