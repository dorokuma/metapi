import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../config.js';
import { normalizePayloadRulesConfig } from './payloadRules.js';
import { normalizeUpstreamParamCompatRules } from './upstreamParamCompat/rules.js';
import { normalizeUpstreamProviderPinRules } from './upstreamProviderPin/rules.js';
import { buildUpstreamEndpointRequest } from './upstreamRequestBuilder.js';

const originalSettings = {
  paramCompatEnabled: config.upstreamParamCompatEnabled,
  paramCompatSelfHealEnabled: config.upstreamParamCompatSelfHealEnabled,
  paramCompatRules: config.upstreamParamCompatRules,
  payloadRules: config.payloadRules,
  pinEnabled: config.upstreamProviderPinEnabled,
  pinRules: config.upstreamProviderPinRules,
};

function restoreSettings() {
  config.upstreamParamCompatEnabled = originalSettings.paramCompatEnabled;
  config.upstreamParamCompatSelfHealEnabled = originalSettings.paramCompatSelfHealEnabled;
  config.upstreamParamCompatRules = originalSettings.paramCompatRules;
  config.payloadRules = originalSettings.payloadRules;
  config.upstreamProviderPinEnabled = originalSettings.pinEnabled;
  config.upstreamProviderPinRules = originalSettings.pinRules;
}

const PARAM_RULES = [
  { siteId: 9, model: '*', params: ['prompt_cache_key', 'prompt_cache_retention'] },
];

function chatInput(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: 'chat' as const,
    modelName: 'upstream-actual',
    stream: false,
    tokenValue: 'sk-test',
    sitePlatform: 'openai',
    siteId: 9,
    openaiBody: {
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_key: 'cache-1',
      prompt_cache_retention: '24h',
    },
    downstreamFormat: 'openai' as const,
    ...overrides,
  };
}

describe('upstreamRequestBuilder site-level param stripping', () => {
  beforeEach(() => {
    config.upstreamParamCompatEnabled = true;
    config.upstreamParamCompatSelfHealEnabled = true;
    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules(PARAM_RULES);
    config.payloadRules = normalizePayloadRulesConfig(undefined);
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];
  });

  afterEach(restoreSettings);

  it('strips the named keys from the chat body, leaving other top-level fields intact', () => {
    const request = buildUpstreamEndpointRequest(chatInput());

    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body).toEqual({
      model: 'upstream-actual',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('is byte-identical when the master switch is off, another site hits, rules are empty or siteId is absent', () => {
    config.upstreamParamCompatEnabled = false;
    const baseline = buildUpstreamEndpointRequest(chatInput());
    expect(baseline.body).toHaveProperty('prompt_cache_key');

    config.upstreamParamCompatEnabled = true;
    expect(JSON.stringify(buildUpstreamEndpointRequest(chatInput()).body)).not.toBe(JSON.stringify(baseline.body));

    config.upstreamParamCompatRules = [];
    expect(JSON.stringify(buildUpstreamEndpointRequest(chatInput()).body)).toBe(JSON.stringify(baseline.body));

    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules(PARAM_RULES);
    expect(JSON.stringify(buildUpstreamEndpointRequest(chatInput({ siteId: 8 })).body))
      .toBe(JSON.stringify(baseline.body));
    expect(JSON.stringify(buildUpstreamEndpointRequest(chatInput({ siteId: undefined })).body))
      .toBe(JSON.stringify(baseline.body));
  });

  it('keeps stripping when only the master switch is on (self-heal switch granularity)', () => {
    config.upstreamParamCompatSelfHealEnabled = false;

    const request = buildUpstreamEndpointRequest(chatInput());
    expect(request.body).not.toHaveProperty('prompt_cache_key');

    // 总开关关 + 自愈开关开 → (a) 也不剥
    config.upstreamParamCompatEnabled = false;
    config.upstreamParamCompatSelfHealEnabled = true;
    expect(buildUpstreamEndpointRequest(chatInput()).body).toHaveProperty('prompt_cache_key');
  });

  it('stays case sensitive on the rule model', () => {
    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: 'GLM-5.3', params: ['prompt_cache_key'] },
    ]);

    const lowerCase = buildUpstreamEndpointRequest(chatInput({
      openaiBody: {
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        prompt_cache_key: 'cache-1',
      },
    }));
    expect(lowerCase.body).toHaveProperty('prompt_cache_key');

    const exactCase = buildUpstreamEndpointRequest(chatInput({
      openaiBody: {
        model: 'GLM-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        prompt_cache_key: 'cache-1',
      },
    }));
    expect(exactCase.body).not.toHaveProperty('prompt_cache_key');
  });

  it('strips the responses passthrough body (not just openaiBody)', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-actual',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteId: 9,
      openaiBody: { model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] },
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'GLM-5.3',
        input: 'hello',
        prompt_cache_key: 'cache-1',
        prompt_cache_retention: '24h',
      },
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.body).not.toHaveProperty('prompt_cache_key');
    expect(request.body).not.toHaveProperty('prompt_cache_retention');
  });

  it('strips the codex responses body too (codex and default paths share the stripped body)', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'gpt-5.4',
      stream: false,
      tokenValue: 'oauth-access-token',
      sitePlatform: 'codex',
      siteUrl: 'https://chatgpt.com/backend-api/codex',
      siteId: 9,
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.4',
        input: 'hello codex',
        prompt_cache_key: 'codex-cache-123',
      },
      providerHeaders: { Originator: 'codex_cli_rs' },
      codexSessionCacheKey: 'gpt-5.4:user-456',
    });

    expect(request.runtime?.executor).toBe('codex');
    expect(request.body).not.toHaveProperty('prompt_cache_key');
  });

  it('never touches messages unless the rule opts in with endpoints: ["messages"]', () => {
    const messagesInput = () => ({
      endpoint: 'messages' as const,
      modelName: 'claude-opus-4-6',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      siteUrl: 'https://example.com',
      siteId: 9,
      downstreamFormat: 'claude' as const,
      openaiBody: { model: 'ignored', messages: [{ role: 'user', content: 'ignored' }] },
      claudeOriginalBody: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        some_extra_flag: 'keep-me',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['some_extra_flag'] },
    ]);
    expect(buildUpstreamEndpointRequest(messagesInput()).body).toHaveProperty('some_extra_flag');

    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['some_extra_flag'], endpoints: ['messages'] },
    ]);
    expect(buildUpstreamEndpointRequest(messagesInput()).body).not.toHaveProperty('some_extra_flag');
  });

  it('strips on the messages runtime (non-claude platform) return path as well', () => {
    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['some_extra_flag'], endpoints: ['messages'] },
    ]);

    const request = buildUpstreamEndpointRequest({
      endpoint: 'messages',
      modelName: 'claude-opus-4-6',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      siteId: 9,
      downstreamFormat: 'claude',
      openaiBody: { model: 'ignored', messages: [{ role: 'user', content: 'ignored' }] },
      claudeOriginalBody: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        some_extra_flag: 'drop-me',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(request.path).toBe('/v1/messages');
    expect(request.body).not.toHaveProperty('some_extra_flag');
  });

  it('removes a key that payload override re-adds (strip runs after payload rules)', () => {
    config.payloadRules = normalizePayloadRulesConfig({
      override: [{ models: [{ name: '*' }], params: { prompt_cache_key: 'injected-by-override' } }],
    });

    const request = buildUpstreamEndpointRequest(chatInput({
      openaiBody: {
        model: 'GLM-5.3',
        messages: [{ role: 'user', content: 'hi' }],
      },
    }));

    expect(request.body).not.toHaveProperty('prompt_cache_key');

    // 对照：剥离未命中时，override 写入的键会保留（证明 override 确实生效）
    config.upstreamParamCompatRules = [];
    const unstripped = buildUpstreamEndpointRequest(chatInput({
      openaiBody: {
        model: 'GLM-5.3',
        messages: [{ role: 'user', content: 'hi' }],
      },
    }));
    expect(unstripped.body.prompt_cache_key).toBe('injected-by-override');
  });

  it('coexists with provider pin injection (pin fields survive, stripped keys do not)', () => {
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: 9, model: '*', providers: ['deepseek'], mode: 'only' },
    ]);

    const request = buildUpstreamEndpointRequest(chatInput());

    expect(request.body.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    expect(request.body.provider).toEqual({ only: ['deepseek'] });
    expect(request.body).not.toHaveProperty('prompt_cache_key');
    expect(request.body).not.toHaveProperty('prompt_cache_retention');
  });

  it('does not strip the gemini-native early-return branches', () => {
    // 用 payload override 往最终体里放一个会被剥离的标记键；
    // gemini-native 分支提前 return，不调用剥离 → 标记键保留。
    config.payloadRules = normalizePayloadRulesConfig({
      override: [{ models: [{ name: '*' }], params: { some_marker: 'keep' } }],
    });
    config.upstreamParamCompatRules = normalizeUpstreamParamCompatRules([
      { siteId: 9, model: '*', params: ['some_marker'] },
    ]);

    const geminiNative = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'gemini-3.5-flash',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'gemini',
      siteUrl: 'https://generativelanguage.googleapis.com',
      siteId: 9,
      openaiBody: {
        model: 'GLM-5.3',
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            tool_calls: [{
              id: 'call_read',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"/tmp/a"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_read', content: 'file content' },
        ],
      },
      downstreamFormat: 'openai',
    });

    expect(geminiNative.runtime?.executor).toBe('gemini-native');
    expect(geminiNative.body.some_marker).toBe('keep');

    // 对照：同一标记键在普通 chat 出站体上会被剥掉
    const chat = buildUpstreamEndpointRequest(chatInput({
      openaiBody: {
        model: 'GLM-5.3',
        messages: [{ role: 'user', content: 'hi' }],
      },
    }));
    expect(chat.body.some_marker).toBeUndefined();
  });
});