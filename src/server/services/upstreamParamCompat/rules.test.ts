import { describe, expect, it } from 'vitest';

import {
  isSafeStrippableUpstreamParam,
  normalizeUpstreamParamCompatRules,
  parseUpstreamParamCompatRules,
  resolveUpstreamParamCompatParams,
  toUpstreamParamCompatStoredRules,
  UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE,
  UPSTREAM_PARAM_COMPAT_MAX_RULES,
} from './rules.js';

describe('upstreamParamCompat rules normalize (lenient)', () => {
  it('compiles the raw shape and keeps the precompiled matcher off the stored echo', () => {
    const rules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['prompt_cache_key', 'prompt_cache_retention'] },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0].match('anything')).toBe(true);
    expect(rules[0].match('')).toBe(true);
    expect(toUpstreamParamCompatStoredRules(rules)).toEqual([
      { siteId: 9, model: '*', params: ['prompt_cache_key', 'prompt_cache_retention'] },
    ]);
    expect(JSON.stringify(toUpstreamParamCompatStoredRules(rules))).not.toContain('match');
  });

  it('drops the whole rule when any param is a structural key (even alongside legal names)', () => {
    const rules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['prompt_cache_key', 'model'] },
      { siteId: 9, model: '*', params: ['prompt_cache_key'] },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0].params).toEqual(['prompt_cache_key']);
  });

  it('drops rules with non-identifier params, prototype pollution names or empty params', () => {
    const rules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['a.b'] },
      { siteId: 9, model: '*', params: ['__proto__'] },
      { siteId: 9, model: '*', params: ['constructor'] },
      { siteId: 9, model: '*', params: ['1bad'] },
      { siteId: 9, model: '*', params: [] },
      { siteId: 9, model: '*', params: [42] },
    ]);

    expect(rules).toEqual([]);
  });

  it('drops a rule with 33 params entirely and keeps a rule with 32', () => {
    const paramName = (index: number) => `param_${index}`;
    const tooMany = Array.from({ length: UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE + 1 }, (_, i) => paramName(i));
    const justEnough = Array.from({ length: UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE }, (_, i) => paramName(i));

    const rules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: tooMany },
      { siteId: 10, model: '*', params: justEnough },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0].siteId).toBe(10);
    expect(rules[0].params).toHaveLength(UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE);
  });

  it('compiles only the first 64 rules and drops the tail', () => {
    const rawRules = Array.from({ length: UPSTREAM_PARAM_COMPAT_MAX_RULES + 3 }, (_, i) => ({
      siteId: i + 1,
      model: '*',
      params: ['prompt_cache_key'],
    }));

    const rules = normalizeUpstreamParamCompatRules(rawRules);

    expect(rules).toHaveLength(UPSTREAM_PARAM_COMPAT_MAX_RULES);
    expect(rules[rules.length - 1].siteId).toBe(UPSTREAM_PARAM_COMPAT_MAX_RULES);
  });

  it('accepts a JSON string and drops malformed input without throwing', () => {
    expect(normalizeUpstreamParamCompatRules('{not json')).toEqual([]);
    expect(normalizeUpstreamParamCompatRules(undefined)).toEqual([]);
    expect(normalizeUpstreamParamCompatRules({ siteId: 1 })).toEqual([]);
    expect(normalizeUpstreamParamCompatRules('[{"siteId":1,"model":"*","params":["prompt_cache_key"]}]'))
      .toHaveLength(1);
  });

  it('drops rules whose endpoints list is invalid or empty', () => {
    const rules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['prompt_cache_key'], endpoints: ['chat', 'unknown'] },
      { siteId: 9, model: '*', params: ['prompt_cache_key'], endpoints: [] },
      { siteId: 9, model: '*', params: ['prompt_cache_key'], endpoints: 'chat' },
      { siteId: 9, model: '*', params: ['prompt_cache_key'], endpoints: ['messages'] },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0].endpoints).toEqual(['messages']);
  });
});

describe('upstreamParamCompat rules parse (strict PUT)', () => {
  it('normalizes the stored shape and preserves an explicit endpoints list', () => {
    const result = parseUpstreamParamCompatRules([
      { siteId: '9', model: ' * ', params: ['prompt_cache_key', ' prompt_cache_key ', 'prompt_cache_retention'] },
      { siteId: 12, model: 'GLM-5.3', params: ['some_param'], endpoints: ['messages'] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toEqual([
      { siteId: 9, model: '*', params: ['prompt_cache_key', 'prompt_cache_retention'] },
      { siteId: 12, model: 'GLM-5.3', params: ['some_param'], endpoints: ['messages'] },
    ]);
  });

  it('rejects structural keys, non-identifiers, reserved names and over-sized params', () => {
    const cases: Array<{ name: string; value: unknown; expected: string }> = [
      { name: 'malformed json', value: '{not json', expected: '不是合法的 JSON' },
      { name: 'non array', value: { siteId: 1 }, expected: '必须是数组' },
      { name: 'non object rule', value: ['rule'], expected: '必须是对象' },
      { name: 'bad siteId', value: [{ siteId: 0, model: '*', params: ['a'] }], expected: 'siteId 必须是正整数' },
      { name: 'empty model', value: [{ siteId: 1, model: ' ', params: ['a'] }], expected: 'model 不能为空' },
      { name: 'empty params', value: [{ siteId: 1, model: '*', params: [] }], expected: 'params 不能为空' },
      {
        name: 'structural key',
        value: [{ siteId: 1, model: '*', params: ['prompt_cache_key', 'system'] }],
        expected: '禁止剥离的结构键：system',
      },
      {
        name: 'prototype pollution',
        value: [{ siteId: 1, model: '*', params: ['__proto__'] }],
        expected: '禁止剥离的结构键：__proto__',
      },
      {
        name: 'non-identifier',
        value: [{ siteId: 1, model: '*', params: ['prompt.cache_key'] }],
        expected: '非法参数名',
      },
      {
        name: 'too many params',
        value: [{
          siteId: 1,
          model: '*',
          params: Array.from({ length: UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE + 1 }, (_, i) => `p_${i}`),
        }],
        expected: `超过 ${UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE} 个`,
      },
      {
        name: 'too many rules',
        value: Array.from({ length: UPSTREAM_PARAM_COMPAT_MAX_RULES + 1 }, (_, i) => ({
          siteId: i + 1,
          model: '*',
          params: ['prompt_cache_key'],
        })),
        expected: `超过 ${UPSTREAM_PARAM_COMPAT_MAX_RULES} 条`,
      },
      {
        name: 'bad endpoints',
        value: [{ siteId: 1, model: '*', params: ['prompt_cache_key'], endpoints: ['foo'] }],
        expected: 'endpoints 只能是',
      },
    ];

    for (const testCase of cases) {
      const result = parseUpstreamParamCompatRules(testCase.value);
      expect(result.ok, testCase.name).toBe(false);
      if (!result.ok) {
        expect(result.message, testCase.name).toContain(testCase.expected);
      }
    }
  });

  it('reports the offending rule position and name in Chinese', () => {
    const result = parseUpstreamParamCompatRules([
      { siteId: 1, model: '*', params: ['prompt_cache_key'] },
      { siteId: 2, model: '*', params: ['prompt_cache_retention', 'tools'] },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('第 2 条规则');
      expect(result.message).toContain('tools');
    }
  });
});

describe('upstreamParamCompat hot-path resolution', () => {
  const rules = () => normalizeUpstreamParamCompatRules([
    { siteId: 9, model: '*', params: ['prompt_cache_key', 'prompt_cache_retention'] },
    { siteId: 9, model: 'GLM-5.3', params: ['extra_param'] },
    { siteId: 9, model: '*', params: ['custom_flag'], endpoints: ['messages'] },
  ]);

  it('unions every matched rule and stays case sensitive on the model', () => {
    expect(resolveUpstreamParamCompatParams({
      rules: rules(),
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toEqual(['prompt_cache_key', 'prompt_cache_retention', 'extra_param']);

    // 大小写敏感：GLM-5.3 规则不匹配 glm-5.3
    expect(resolveUpstreamParamCompatParams({
      rules: rules(),
      siteId: 9,
      requestedModel: 'glm-5.3',
      endpoint: 'chat',
    })).toEqual(['prompt_cache_key', 'prompt_cache_retention']);
  });

  it('matches on requestedModel or the actual upstream model', () => {
    expect(resolveUpstreamParamCompatParams({
      rules: rules(),
      siteId: 9,
      requestedModel: 'unrelated',
      actualModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toContain('extra_param');
  });

  it('excludes messages unless the rule opts in explicitly', () => {
    expect(resolveUpstreamParamCompatParams({
      rules: rules(),
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'messages',
    })).toEqual(['custom_flag']);

    const defaultOnly = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['prompt_cache_key'] },
    ]);
    expect(resolveUpstreamParamCompatParams({
      rules: defaultOnly,
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'messages',
    })).toEqual([]);
    expect(resolveUpstreamParamCompatParams({
      rules: defaultOnly,
      siteId: 9,
      requestedModel: 'GLM-5.3',
      endpoint: 'responses',
    })).toEqual(['prompt_cache_key']);
  });

  it('returns nothing for other sites, missing siteId or empty candidates', () => {
    expect(resolveUpstreamParamCompatParams({
      rules: rules(),
      siteId: 7,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toEqual([]);
    expect(resolveUpstreamParamCompatParams({
      rules: rules(),
      siteId: null,
      requestedModel: 'GLM-5.3',
      endpoint: 'chat',
    })).toEqual([]);
    expect(resolveUpstreamParamCompatParams({
      rules: rules(),
      siteId: 9,
      requestedModel: '',
      endpoint: 'chat',
    })).toEqual([]);
  });
});

describe('upstreamParamCompat param name guard', () => {
  it('accepts identifiers and rejects structural / reserved / malformed names', () => {
    expect(isSafeStrippableUpstreamParam('prompt_cache_key')).toBe(true);
    expect(isSafeStrippableUpstreamParam('_x1')).toBe(true);
    expect(isSafeStrippableUpstreamParam('model')).toBe(false);
    expect(isSafeStrippableUpstreamParam('system')).toBe(false);
    expect(isSafeStrippableUpstreamParam('providerOptions')).toBe(false);
    expect(isSafeStrippableUpstreamParam('__proto__')).toBe(false);
    expect(isSafeStrippableUpstreamParam('constructor')).toBe(false);
    expect(isSafeStrippableUpstreamParam('a.b')).toBe(false);
    expect(isSafeStrippableUpstreamParam('1abc')).toBe(false);
    expect(isSafeStrippableUpstreamParam(`a${'b'.repeat(65)}`)).toBe(false);
    expect(isSafeStrippableUpstreamParam(42)).toBe(false);
  });
});