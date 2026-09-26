import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import { applyRuntimeSettings } from './runtimeSettingsHydration.js';
import { resolveUpstreamPinAdapter } from './services/upstreamProviderPin/adapterMap.js';

// 不能 structuredClone(config)：设置 UPSTREAM_PROVIDER_PIN_RULES_JSON 后 config.upstreamProviderPinRules
// 含编译 matcher（函数），structuredClone 会抛 DataCloneError。这里只快照本测试会改动、且 JSON 安全的字段
// （数组按值复制，其余为原始值/引用保持原语义：测试只整体赋值、不改写原对象）。
const originalConfig = {
  disableCrossProtocolFallback: config.disableCrossProtocolFallback,
  responsesCompactFallbackToResponsesEnabled: config.responsesCompactFallbackToResponsesEnabled,
  webhookEnabled: config.webhookEnabled,
  barkEnabled: config.barkEnabled,
  serverChanEnabled: config.serverChanEnabled,
  globalAllowedModels: [...config.globalAllowedModels],
  smtpPort: config.smtpPort,
  upstreamProviderDetectSiteIds: [...config.upstreamProviderDetectSiteIds],
  upstreamProviderPinEnabled: config.upstreamProviderPinEnabled,
  upstreamProviderPinRules: config.upstreamProviderPinRules,
};

afterEach(() => {
  Object.assign(config, {
    ...originalConfig,
    globalAllowedModels: [...originalConfig.globalAllowedModels],
    upstreamProviderDetectSiteIds: [...originalConfig.upstreamProviderDetectSiteIds],
  });
});

describe('applyRuntimeSettings', () => {
  it('hydrates persisted runtime settings that should survive restarts', () => {
    config.disableCrossProtocolFallback = false;
    config.responsesCompactFallbackToResponsesEnabled = false;
    config.webhookEnabled = true;
    config.barkEnabled = true;
    config.serverChanEnabled = true;
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['disable_cross_protocol_fallback', JSON.stringify(true)],
      ['responses_compact_fallback_to_responses_enabled', JSON.stringify(true)],
      ['webhook_enabled', JSON.stringify(false)],
      ['bark_enabled', JSON.stringify(false)],
      ['serverchan_enabled', JSON.stringify(false)],
      ['global_allowed_models', JSON.stringify(['gpt-5.4', ' claude-3.7-sonnet '])],
    ]));

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.responsesCompactFallbackToResponsesEnabled).toBe(true);
    expect(config.webhookEnabled).toBe(false);
    expect(config.barkEnabled).toBe(false);
    expect(config.serverChanEnabled).toBe(false);
    expect(config.globalAllowedModels).toEqual(['gpt-5.4', 'claude-3.7-sonnet']);
  });

  it('normalizes smtpPort to a positive integer during hydration', () => {
    config.smtpPort = 587;

    applyRuntimeSettings(new Map([
      ['smtp_port', JSON.stringify(587.9)],
    ]));

    expect(config.smtpPort).toBe(587);
  });

  it('hydrates legacy double-encoded global model allowlist values', () => {
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['global_allowed_models', JSON.stringify(JSON.stringify(['model-alpha', ' model-beta ', 'model-gamma']))],
    ]));

    expect(config.globalAllowedModels).toEqual(['model-alpha', 'model-beta', 'model-gamma']);
  });

  it('hydrates the upstream detect participating-site selection and normalizes it', () => {
    config.upstreamProviderDetectSiteIds = [];

    applyRuntimeSettings(new Map([
      ['upstream_provider_detect_site_ids', JSON.stringify([9, '12', 9, 0, 'bad'])],
    ]));

    expect(config.upstreamProviderDetectSiteIds).toEqual([9, 12]);
  });

  it('hydrates the upstream provider pin settings from the stored raw rule shape', () => {
    config.upstreamProviderPinEnabled = false;
    config.upstreamProviderPinRules = [];

    applyRuntimeSettings(new Map([
      ['upstream_provider_pin_enabled', JSON.stringify(true)],
      ['upstream_provider_pin_rules', JSON.stringify([
        { siteId: 49, model: 'cline-pass/*', providers: ['deepseek', ' deepseek '], mode: 'order' },
        // 非法项在宽松归一时丢弃，不阻断其余规则
        { siteId: 'bad', model: 'm', providers: ['a'], mode: 'only' },
      ])],
    ]));

    expect(config.upstreamProviderPinEnabled).toBe(true);
    // 双形态约定：hydration 从存储原始形态编译一次，config 持有编译产物（带 matcher）。
    expect(config.upstreamProviderPinRules).toHaveLength(1);
    expect(config.upstreamProviderPinRules[0]).toMatchObject({
      siteId: 49,
      model: 'cline-pass/*',
      providers: ['deepseek'],
      mode: 'order',
    });
    expect(config.upstreamProviderPinRules[0].match('cline-pass/deepseek-v4.1-flash')).toBe(true);
  });

  it('ignores the removed legacy host-suffix key during hydration', () => {
    config.upstreamProviderDetectSiteIds = [3];

    applyRuntimeSettings(new Map([
      ['upstream_provider_detect_platforms', JSON.stringify(['cline.bot'])],
    ]));

    expect(config.upstreamProviderDetectSiteIds).toEqual([3]);
  });

  it('hydrates the upstream provider pin adapter map and keeps unregistered ids for zero-injection', () => {
    const originalAdapterMap = config.upstreamProviderPinAdapterMap;
    try {
      config.upstreamProviderPinAdapterMap = {};

      applyRuntimeSettings(new Map([
        ['upstream_provider_pin_adapter_map', JSON.stringify({
          '49': 'openrouter',
          '049': 'none',
          bad: 'openrouter',
          '50': 'litellm',
          '7': 42,
          '8': '',
        })],
      ]));

      // 键归一 + 冲突保留先出现者；未注册 id 保留（M2 零注入兜底），值非法丢弃
      expect(config.upstreamProviderPinAdapterMap).toEqual({ 49: 'openrouter', 50: 'litellm' });
      expect(resolveUpstreamPinAdapter(49).id).toBe('openrouter');
      expect(resolveUpstreamPinAdapter(50).id).toBe('none');
      expect(resolveUpstreamPinAdapter(999).id).toBe('generic-dual');
    } finally {
      config.upstreamProviderPinAdapterMap = originalAdapterMap;
    }
  });
});
