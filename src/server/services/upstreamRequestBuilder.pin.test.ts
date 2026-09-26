import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../config.js';
import { normalizeUpstreamProviderPinRules } from './upstreamProviderPin/rules.js';
import { buildUpstreamEndpointRequest } from './upstreamRequestBuilder.js';

const originalSettings = {
  enabled: config.upstreamProviderPinEnabled,
  rules: config.upstreamProviderPinRules,
};

function restoreSettings() {
  config.upstreamProviderPinEnabled = originalSettings.enabled;
  config.upstreamProviderPinRules = originalSettings.rules;
}

describe('upstreamRequestBuilder upstream provider pin injection', () => {
  beforeEach(() => {
    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: 49, model: 'cline-pass/*', providers: ['deepseek'], mode: 'only' },
      { siteId: 7, model: 'claude-requested', providers: ['alibaba', 'baseten'], mode: 'order' },
    ]);
  });

  afterEach(restoreSettings);

  it('injects both field shapes into the chat JSON body when the rule hits', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteId: 49,
      openaiBody: {
        model: 'cline-pass/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    expect(request.body.provider).toEqual({ only: ['deepseek'] });
    expect(request.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('injects into the responses default path JSON body when the rule hits', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteId: 49,
      openaiBody: {
        model: 'cline-pass/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.body.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    expect(request.body.provider).toEqual({ only: ['deepseek'] });
    expect(request.body.input).toBeDefined();
  });

  it('never injects into the codex platform responses path (W-1)', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'codex',
      siteId: 49,
      openaiBody: {
        model: 'cline-pass/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.runtime?.executor).toBe('codex');
    expect(request.body.providerOptions).toBeUndefined();
    expect(request.body.provider).toBeUndefined();
  });

  it('leaves the body unchanged when no siteId is passed (WS / probe call sites)', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      openaiBody: {
        model: 'cline-pass/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.body).toEqual({
      model: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('matches on requestedModelForPayloadRules priorities, not on raw input fields (W-2)', () => {
    // responses 面：responsesOriginalBody.model 优先于 openaiBody.model
    const responsesHit = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-actual',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteId: 7,
      openaiBody: { model: 'openai-unrelated', messages: [{ role: 'user', content: 'hi' }] },
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'claude-requested',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      },
    });
    expect(responsesHit.body.providerOptions).toEqual({
      gateway: { order: ['alibaba', 'baseten'] },
    });

    // claude 原始 body 优先于 openaiBody.model（chat 回退路径同样按请求模型匹配）
    const chatFallbackHit = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-actual',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteId: 7,
      openaiBody: { model: 'openai-unrelated', messages: [{ role: 'user', content: 'hi' }] },
      downstreamFormat: 'claude',
      claudeOriginalBody: { model: 'claude-requested', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chatFallbackHit.body.providerOptions).toEqual({
      gateway: { order: ['alibaba', 'baseten'] },
    });

    // 只有 openaiBody.model 命中也不误伤：请求模型为 claude-requested，openai-unrelated 不参与匹配
    config.upstreamProviderPinRules = normalizeUpstreamProviderPinRules([
      { siteId: 7, model: 'openai-unrelated', providers: ['should-not-hit'], mode: 'only' },
    ]);
    const miss = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-actual',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteId: 7,
      openaiBody: { model: 'openai-unrelated', messages: [{ role: 'user', content: 'hi' }] },
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'claude-requested',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      },
    });
    expect(miss.body.provider).toBeUndefined();
    expect(miss.body.providerOptions).toBeUndefined();
  });

  it('never injects into messages or gemini-native branches', () => {
    const messagesRequest = buildUpstreamEndpointRequest({
      endpoint: 'messages',
      modelName: 'claude-sonnet',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      siteId: 49,
      openaiBody: { model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] },
      downstreamFormat: 'openai',
    });
    expect(messagesRequest.body.providerOptions).toBeUndefined();
    expect(messagesRequest.body.provider).toBeUndefined();

    const geminiNativeRequest = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'gemini-3.5-flash',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'gemini',
      siteUrl: 'https://generativelanguage.googleapis.com',
      siteId: 49,
      openaiBody: {
        model: 'cline-pass/deepseek-v4.1-flash',
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
    expect(geminiNativeRequest.runtime?.executor).toBe('gemini-native');
    expect(geminiNativeRequest.body.providerOptions).toBeUndefined();
    expect(geminiNativeRequest.body.provider).toBeUndefined();
  });

  it('produces a byte-identical body when the feature is disabled or rules are empty', () => {
    const buildInput = {
      endpoint: 'chat' as const,
      modelName: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteId: 49,
      openaiBody: {
        model: 'cline-pass/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      downstreamFormat: 'openai' as const,
    };

    const withRules = buildUpstreamEndpointRequest(buildInput);
    expect(withRules.body.provider).toBeDefined();

    config.upstreamProviderPinEnabled = false;
    const disabled = buildUpstreamEndpointRequest(buildInput);
    expect(disabled.body).toEqual({
      model: 'deepseek/deepseek-v4.1-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(JSON.stringify(disabled.body)).not.toContain('providerOptions');

    config.upstreamProviderPinEnabled = true;
    config.upstreamProviderPinRules = [];
    const emptyRules = buildUpstreamEndpointRequest(buildInput);
    expect(JSON.stringify(emptyRules.body)).toBe(JSON.stringify(disabled.body));
  });
});
