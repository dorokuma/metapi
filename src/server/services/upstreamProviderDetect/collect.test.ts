import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import {
  createUpstreamProviderObservationCollector,
  observeUpstreamProviderObservationSseText,
  type UpstreamProviderObservationCollector,
} from './collect.js';

const originalSettings = {
  enabled: config.upstreamProviderDetectEnabled,
  sampleRate: config.upstreamProviderDetectSampleRate,
  retentionDays: config.upstreamProviderDetectRetentionDays,
  siteIds: config.upstreamProviderDetectSiteIds,
};

const REQUEST_INPUT = { requestId: 'req-collector-test', siteId: 9 };

function createActiveCollector(): UpstreamProviderObservationCollector {
  return createUpstreamProviderObservationCollector(REQUEST_INPUT);
}

function routingFrame(input: {
  finalProvider: string;
  clientSessionId?: string | null;
  gateway?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    choices: [{
      index: 0,
      delta: {
        provider_metadata: {
          gateway: {
            routing: {
              finalProvider: input.finalProvider,
              ...(input.clientSessionId !== undefined ? { clientSessionId: input.clientSessionId } : {}),
            },
            ...(input.gateway ?? {}),
          },
        },
      },
    }],
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

describe('upstream provider observation collector', () => {
  beforeEach(() => {
    config.upstreamProviderDetectEnabled = true;
    config.upstreamProviderDetectSampleRate = 1;
    config.upstreamProviderDetectRetentionDays = 14;
    config.upstreamProviderDetectSiteIds = [9];
  });

  afterEach(() => {
    config.upstreamProviderDetectEnabled = originalSettings.enabled;
    config.upstreamProviderDetectSampleRate = originalSettings.sampleRate;
    config.upstreamProviderDetectRetentionDays = originalSettings.retentionDays;
    config.upstreamProviderDetectSiteIds = originalSettings.siteIds;
  });

  it('is inactive (and observes nothing) when the gate does not match', () => {
    config.upstreamProviderDetectEnabled = false;
    const collector = createActiveCollector();
    expect(collector.active).toBe(false);
    collector.observe(routingFrame({ finalProvider: 'deepseek' }));
    expect(collector.snapshot()).toBeNull();

    config.upstreamProviderDetectEnabled = true;
    const offSite = createUpstreamProviderObservationCollector({
      requestId: 'req-off-site',
      siteId: 12,
    });
    expect(offSite.active).toBe(false);
    offSite.observe(routingFrame({ finalProvider: 'deepseek' }));
    expect(offSite.snapshot()).toBeNull();

    config.upstreamProviderDetectSiteIds = [];
    const noSelection = createActiveCollector();
    expect(noSelection.active).toBe(false);
    noSelection.observe(routingFrame({ finalProvider: 'deepseek' }));
    expect(noSelection.snapshot()).toBeNull();
  });

  it('returns null until a frame carries routing, and ignores non-object payloads', () => {
    const collector = createActiveCollector();
    expect(collector.snapshot()).toBeNull();

    collector.observe(null);
    collector.observe('data');
    collector.observe(42);
    collector.observe({ choices: [{ index: 0, delta: { content: 'hello' } }] });
    expect(collector.snapshot()).toBeNull();
  });

  it('keeps the last routing frame and lets intermediate frames without routing leave it untouched', () => {
    const collector = createActiveCollector();
    collector.observe(routingFrame({ finalProvider: 'first', clientSessionId: 'sess-1' }));
    collector.observe({ choices: [{ index: 0, delta: { content: 'still streaming' } }] });
    expect(collector.snapshot()).toMatchObject({ finalProvider: 'first', clientSessionId: 'sess-1' });

    collector.observe(routingFrame({ finalProvider: 'second', clientSessionId: 'sess-2' }));
    expect(collector.snapshot()).toMatchObject({ finalProvider: 'second', clientSessionId: 'sess-2' });
  });

  it('keeps routing from the metadata frame and cost from a later usage-only frame (choices: [])', () => {
    const collector = createActiveCollector();
    collector.observe(routingFrame({ finalProvider: 'deepseek', clientSessionId: 'sess-b1' }));
    collector.observe({
      choices: [],
      usage: { cost: 0.0000135, gateway_cost: 0.000027, market_cost: 0.000027 },
    });

    expect(collector.snapshot()).toMatchObject({
      finalProvider: 'deepseek',
      clientSessionId: 'sess-b1',
      usageCost: 0.0000135,
      usageGatewayCost: 0.000027,
      usageMarketCost: 0.000027,
    });
  });

  it('merges gateway text costs from the metadata frame with usage costs from the usage-only frame', () => {
    const collector = createActiveCollector();
    collector.observe(routingFrame({
      finalProvider: 'deepseek',
      gateway: { cost: '0.000027', inferenceCost: '0.000027', generationId: 'gen-b1' },
    }));
    collector.observe({ choices: [], usage: { cost: 0.5 } });

    expect(collector.snapshot()).toMatchObject({
      finalProvider: 'deepseek',
      usageCost: 0.5,
      gatewayCostText: '0.000027',
      gatewayCostNumber: 0.000027,
      gatewayInferenceCostText: '0.000027',
      gatewayGenerationId: 'gen-b1',
    });
  });

  it('keeps the freshest usage costs when a later routing frame carries no usage', () => {
    const collector = createActiveCollector();
    collector.observe(routingFrame({ finalProvider: 'first', usage: { cost: 0.1 } }));
    collector.observe({ choices: [], usage: { cost: 0.5 } });
    collector.observe(routingFrame({ finalProvider: 'second', clientSessionId: 'sess-late' }));

    expect(collector.snapshot()).toMatchObject({
      finalProvider: 'second',
      clientSessionId: 'sess-late',
      usageCost: 0.5,
    });
  });

  it('merges cost views per field, so a later routing frame with gateway costs does not wipe earlier usage costs (oracle repro)', () => {
    const collector = createActiveCollector();
    collector.observe({ choices: [], usage: { cost: 7 } });
    collector.observe(routingFrame({
      finalProvider: 'deepseek',
      gateway: { cost: '0.9' },
    }));

    expect(collector.snapshot()).toMatchObject({
      finalProvider: 'deepseek',
      usageCost: 7,
      gatewayCostText: '0.9',
      gatewayCostNumber: 0.9,
    });
  });

  it('does not clear staged costs when a later frame has usage without any cost field', () => {
    const collector = createActiveCollector();
    collector.observe(routingFrame({ finalProvider: 'deepseek', usage: { cost: 0.25 } }));
    collector.observe({ choices: [], usage: { prompt_tokens: 34, completion_tokens: 14, total_tokens: 48 } });

    expect(collector.snapshot()).toMatchObject({ usageCost: 0.25 });
  });

  it('starts empty for each new collector, so a collector is never reused across attempts (B2)', () => {
    const attemptOne = createActiveCollector();
    attemptOne.observe(routingFrame({ finalProvider: 'attempt-one', clientSessionId: 'sess-one' }));
    expect(attemptOne.snapshot()).toMatchObject({ finalProvider: 'attempt-one' });

    const attemptTwo = createActiveCollector();
    attemptTwo.observe(routingFrame({ finalProvider: 'attempt-two' }));
    expect(attemptTwo.snapshot()).toMatchObject({ finalProvider: 'attempt-two', clientSessionId: null });
    expect(attemptTwo.snapshot()?.finalProvider).not.toBe('attempt-one');
  });

  describe('observeUpstreamProviderObservationSseText', () => {
    const metadataSseFrame = `data: ${JSON.stringify(routingFrame({
      finalProvider: 'deepseek',
      clientSessionId: 'sess-sse',
      gateway: { cost: '0.000027', generationId: 'gen-sse' },
    }))}`;
    const usageOnlySseFrame = `data: ${JSON.stringify({ choices: [], usage: { cost: 0.75 } })}`;

    it('observes every data frame from raw SSE text and skips [DONE]', () => {
      const collector = createActiveCollector();
      observeUpstreamProviderObservationSseText(
        collector,
        [
          'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
          '',
          metadataSseFrame,
          '',
          usageOnlySseFrame,
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );

      expect(collector.snapshot()).toMatchObject({
        finalProvider: 'deepseek',
        clientSessionId: 'sess-sse',
        usageCost: 0.75,
        gatewayCostText: '0.000027',
        gatewayGenerationId: 'gen-sse',
      });
    });

    it('joins multi-line data fields and ignores malformed frames and non-string input', () => {
      const collector = createActiveCollector();
      const payloadJson = JSON.stringify(routingFrame({ finalProvider: 'multi-line' }));
      const splitAt = payloadJson.indexOf('[') + 1;
      observeUpstreamProviderObservationSseText(
        collector,
        `data: ${payloadJson.slice(0, splitAt)}\ndata: ${payloadJson.slice(splitAt)}\n\ndata: not-json\n\nevent: ping\ndata: [DONE]\n\n`,
      );
      expect(collector.snapshot()).toMatchObject({ finalProvider: 'multi-line' });

      const untouched = createActiveCollector();
      observeUpstreamProviderObservationSseText(untouched, null);
      observeUpstreamProviderObservationSseText(untouched, 42);
      observeUpstreamProviderObservationSseText(untouched, '');
      expect(untouched.snapshot()).toBeNull();
    });

    it('does not parse when the collector gate is inactive', () => {
      config.upstreamProviderDetectEnabled = false;
      const collector = createActiveCollector();
      observeUpstreamProviderObservationSseText(collector, metadataSseFrame);
      expect(collector.snapshot()).toBeNull();
    });
  });
});
