import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../config.js';
import {
  parseUnsupportedParameterNames,
  resolveUpstreamParamCompatSelfHealPlan,
} from './selfHeal.js';

const originalSettings = {
  enabled: config.upstreamParamCompatEnabled,
  selfHealEnabled: config.upstreamParamCompatSelfHealEnabled,
};

function restoreSettings() {
  config.upstreamParamCompatEnabled = originalSettings.enabled;
  config.upstreamParamCompatSelfHealEnabled = originalSettings.selfHealEnabled;
}

describe('parseUnsupportedParameterNames', () => {
  it('parses the NIM 400 wording, including the summarized prefix', () => {
    expect(parseUnsupportedParameterNames(
      'Validation: Unsupported parameter(s): prompt_cache_key, prompt_cache_retention',
    )).toEqual(['prompt_cache_key', 'prompt_cache_retention']);

    expect(parseUnsupportedParameterNames(
      'Upstream returned HTTP 400: Validation: Unsupported parameter(s): prompt_cache_key',
    )).toEqual(['prompt_cache_key']);
  });

  it('parses JSON error.message / top-level message and backtick or quoted names', () => {
    expect(parseUnsupportedParameterNames(JSON.stringify({
      error: { message: 'Validation: Unsupported parameter(s): `prompt_cache_key`, "prompt_cache_retention".' },
    }))).toEqual(['prompt_cache_key', 'prompt_cache_retention']);

    expect(parseUnsupportedParameterNames(JSON.stringify({
      message: 'Unsupported parameters: prompt_cache_key',
    }))).toEqual(['prompt_cache_key']);
  });

  it('accepts singular / plural / case-insensitive phrases and various separators', () => {
    expect(parseUnsupportedParameterNames('unsupported parameter: foo')).toEqual(['foo']);
    expect(parseUnsupportedParameterNames('UNSUPPORTED PARAMETERS: FOO')).toEqual(['FOO']);
    expect(parseUnsupportedParameterNames('Unknown parameter(s): foo and bar')).toEqual(['foo', 'bar']);
    expect(parseUnsupportedParameterNames('unrecognized parameters：foo，bar；baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('drops duplicates and caps the list at 8 names', () => {
    expect(parseUnsupportedParameterNames('Unsupported parameter(s): foo, foo')).toEqual(['foo']);

    const many = Array.from({ length: 10 }, (_, i) => `param_${i}`).join(', ');
    expect(parseUnsupportedParameterNames(`Unsupported parameter(s): ${many}`)).toEqual(
      Array.from({ length: 8 }, (_, i) => `param_${i}`),
    );
  });

  it('does not trigger on unsupported endpoint / bare validation / missing colon', () => {
    expect(parseUnsupportedParameterNames('unsupported endpoint: /v1/chat/completions')).toEqual([]);
    expect(parseUnsupportedParameterNames('Validation: something invalid')).toEqual([]);
    expect(parseUnsupportedParameterNames('Unsupported parameter(s) prompt_cache_key')).toEqual([]);
    expect(parseUnsupportedParameterNames('')).toEqual([]);
    expect(parseUnsupportedParameterNames(JSON.stringify({ error: { message: 'bad request' } }))).toEqual([]);
  });

  it('rejects structural keys, prototype pollution names and non-identifiers', () => {
    expect(parseUnsupportedParameterNames('Unsupported parameter(s): messages, system, model')).toEqual([]);
    expect(parseUnsupportedParameterNames('Unsupported parameter(s): __proto__')).toEqual([]);
    expect(parseUnsupportedParameterNames('Unsupported parameter(s): prompt.cache_key')).toEqual([]);
    expect(parseUnsupportedParameterNames('Unsupported parameter(s): temperature, top_p, n, stop')).toEqual([]);
    // 混在列表里的结构键逐个丢弃，合法名字保留
    expect(parseUnsupportedParameterNames('Unsupported parameter(s): model, prompt_cache_key'))
      .toEqual(['prompt_cache_key']);
  });
});

describe('resolveUpstreamParamCompatSelfHealPlan', () => {
  beforeEach(() => {
    config.upstreamParamCompatEnabled = true;
    config.upstreamParamCompatSelfHealEnabled = true;
  });

  afterEach(restoreSettings);

  it('returns the stripped next body when an advertised key is actually present', () => {
    const body = {
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_key: 'cache-1',
    };

    const plan = resolveUpstreamParamCompatSelfHealPlan({
      status: 400,
      rawErrText: 'Validation: Unsupported parameter(s): prompt_cache_key, prompt_cache_retention',
      body,
    });

    expect(plan).toEqual({
      params: ['prompt_cache_key'],
      body: {
        model: 'GLM-5.3',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    // 原对象不被 mutate
    expect(body.prompt_cache_key).toBe('cache-1');
  });

  it('requires both the master switch and the self-heal switch (gate set)', () => {
    const input = {
      status: 400,
      rawErrText: 'Unsupported parameter(s): prompt_cache_key',
      body: { prompt_cache_key: 'cache-1' },
    };

    config.upstreamParamCompatSelfHealEnabled = false;
    expect(resolveUpstreamParamCompatSelfHealPlan(input)).toBeNull();

    // 只关总开关、自愈开关仍为真 → 仍然不自愈
    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatSelfHealEnabled = true;
    expect(resolveUpstreamParamCompatSelfHealPlan(input)).toBeNull();
  });

  it('returns null for non-400 statuses, an already consumed attempt, and keys absent from the body', () => {
    config.upstreamParamCompatEnabled = true;
    config.upstreamParamCompatSelfHealEnabled = true;

    expect(resolveUpstreamParamCompatSelfHealPlan({
      status: 500,
      rawErrText: 'Unsupported parameter(s): prompt_cache_key',
      body: { prompt_cache_key: 'cache-1' },
    })).toBeNull();

    expect(resolveUpstreamParamCompatSelfHealPlan({
      status: 400,
      rawErrText: 'Unsupported parameter(s): prompt_cache_key',
      body: { prompt_cache_key: 'cache-1' },
      alreadySelfHealed: true,
    })).toBeNull();

    // 名字必须真实存在于顶层（不递归、大小写敏感）
    expect(resolveUpstreamParamCompatSelfHealPlan({
      status: 400,
      rawErrText: 'Unsupported parameter(s): prompt_cache_key',
      body: { Prompt_Cache_Key: 'cache-1', nested: { prompt_cache_key: 'x' } },
    })).toBeNull();

    // 点名结构键 → 不重试
    expect(resolveUpstreamParamCompatSelfHealPlan({
      status: 400,
      rawErrText: 'Unsupported parameter(s): messages',
      body: { messages: [] },
    })).toBeNull();
  });
});