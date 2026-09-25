import { describe, expect, it } from 'vitest';
import nonStreamFixture from './fixtures/cline-chat-completion-nonstream.sample.json' with { type: 'json' };
import streamFinalChunkFixture from './fixtures/cline-chat-stream-final-chunk.sample.json' with { type: 'json' };
import streamFirstChunkFixture from './fixtures/cline-chat-stream-first-chunk.sample.json' with { type: 'json' };
import {
  UPSTREAM_PROVIDER_FALLBACKS_LIMIT,
  UPSTREAM_PROVIDER_PARSER_ID,
  UPSTREAM_PROVIDER_PARSER_VERSION,
  parseUpstreamProviderObservation,
} from './parse.js';

const EXPECTED_SESSION_ID = 'sess-4d605219a573c92da07b4d11786413c8';
const EXPECTED_FALLBACKS = [
  'alibaba',
  'baseten',
  'fireworks',
  'runware',
  'relace',
  'particle',
  'novita',
  'togetherai',
  'deepinfra',
  'wafer',
  'parasail',
  'gmicloud',
  'modal',
  'morph',
  'boundless',
];

/** Builds a bare (unwrapped) payload whose routing carries only what a test needs. */
function buildPayload(input: {
  routing: Record<string, unknown>;
  metadataExtra?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  choiceExtra?: Record<string, unknown>;
  messageExtra?: Record<string, unknown>;
  choices?: unknown[];
}): Record<string, unknown> {
  const choices = input.choices ?? [{
    index: 0,
    message: {
      role: 'assistant',
      provider_metadata: {
        gateway: { routing: input.routing },
        ...(input.metadataExtra ?? {}),
      },
      ...(input.messageExtra ?? {}),
    },
    ...(input.choiceExtra ?? {}),
  }];
  return {
    choices,
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

describe('parseUpstreamProviderObservation', () => {
  describe('non-stream wrapped fixture ({ success, data })', () => {
    const observation = parseUpstreamProviderObservation(nonStreamFixture);

    it('recognizes the gateway routing and stable scalars', () => {
      expect(observation).not.toBeNull();
      expect(observation).toMatchObject({
        parserId: UPSTREAM_PROVIDER_PARSER_ID,
        parserVersion: UPSTREAM_PROVIDER_PARSER_VERSION,
        finalProvider: 'deepseek',
        resolvedProvider: 'deepseek',
        canonicalSlug: 'deepseek/deepseek-v4.1-flash',
        originalModelId: 'deepseek/deepseek-v4.1-flash',
        affinityOutcome: 'confirmed',
        affinityPinnedProvider: 'deepseek',
        clientSessionId: EXPECTED_SESSION_ID,
        clientSessionIdSource: 'explicit',
        modelAttemptCount: 1,
        totalProviderAttemptCount: 1,
        cacheHitTokens: 0,
        cacheMissTokens: 34,
        systemFingerprint: 'aeb56401ca74e127821c4f9126dcb669',
        gatewayGenerationId: 'gen_01M3BKQJW7VBXF3CAJGGKNP2WA',
      });
    });

    it('keeps fallbacksAvailable in original order and counts them', () => {
      expect(observation?.fallbacksAvailable).toEqual(EXPECTED_FALLBACKS);
      expect(observation?.fallbackCount).toBe(15);
    });

    it('keeps both cost sources without cross-filling', () => {
      expect(observation).toMatchObject({
        usageCost: 0.0000135,
        usageGatewayCost: 0.000027,
        usageMarketCost: 0.000027,
        gatewayCostText: '0.000027',
        gatewayCostNumber: 0.000027,
        gatewayInferenceCostText: '0.000027',
        gatewayInferenceCostNumber: 0.000027,
      });
    });

    it('summarizes model attempts without timing, planning or provider request ids', () => {
      expect(observation?.modelAttemptsSummary).toEqual([{
        canonicalSlug: 'deepseek/deepseek-v4.1-flash',
        success: true,
        providerAttemptCount: 1,
        providers: [{
          provider: 'deepseek',
          credentialType: 'system',
          statusCode: 200,
          success: true,
        }],
      }]);
      const serialized = JSON.stringify(observation?.modelAttemptsSummary);
      expect(serialized).not.toContain('providerRequestId');
      expect(serialized).not.toContain('providerResponseId');
      expect(serialized).not.toContain('startTime');
      expect(serialized).not.toContain('endTime');
      expect(serialized).not.toContain('planningReasoning');
    });

    it('reads the cache block from the key matching the actual final provider', () => {
      expect(observation?.cacheHitTokens).toBe(0);
      expect(observation?.cacheMissTokens).toBe(34);
      expect(observation?.systemFingerprint).toBe('aeb56401ca74e127821c4f9126dcb669');
    });
  });

  describe('stream final chunk fixture (bare SSE chunk)', () => {
    const observation = parseUpstreamProviderObservation(streamFinalChunkFixture);

    it('recognizes provider_metadata carried on delta without any wrapper', () => {
      expect(observation).toMatchObject({
        parserId: UPSTREAM_PROVIDER_PARSER_ID,
        parserVersion: 1,
        finalProvider: 'deepseek',
        resolvedProvider: 'deepseek',
        canonicalSlug: 'deepseek/deepseek-v4.1-flash',
        originalModelId: 'deepseek/deepseek-v4.1-flash',
        affinityOutcome: 'confirmed',
        affinityPinnedProvider: 'deepseek',
        clientSessionId: EXPECTED_SESSION_ID,
        clientSessionIdSource: 'explicit',
        fallbackCount: 15,
        modelAttemptCount: 1,
        totalProviderAttemptCount: 1,
        cacheHitTokens: 0,
        cacheMissTokens: 34,
        usageCost: 0.0000135,
        usageGatewayCost: 0.000027,
        usageMarketCost: 0.000027,
        gatewayCostText: '0.000027',
        gatewayInferenceCostText: '0.000027',
        gatewayGenerationId: 'gen_01M3BM0EVD723255539TXJAGCC',
      });
      expect(observation?.fallbacksAvailable).toEqual(EXPECTED_FALLBACKS);
    });

    it('returns null for a plain chunk without provider_metadata', () => {
      expect(parseUpstreamProviderObservation(streamFirstChunkFixture)).toBeNull();
      expect(parseUpstreamProviderObservation({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })).toBeNull();
    });
  });

  describe('container resolution', () => {
    it('returns null when success is not true', () => {
      expect(parseUpstreamProviderObservation({ success: false, data: nonStreamFixture.data })).toBeNull();
      expect(parseUpstreamProviderObservation({ success: 'true', data: nonStreamFixture.data })).toBeNull();
    });

    it('returns null when data is not an object', () => {
      expect(parseUpstreamProviderObservation({ success: true, data: 'text' })).toBeNull();
      expect(parseUpstreamProviderObservation({ success: true, data: [1] })).toBeNull();
      expect(parseUpstreamProviderObservation({ success: true })).toBeNull();
    });

    it('only looks inside data when the wrapper is present', () => {
      const payload = {
        success: true,
        data: { choices: [] },
        choices: nonStreamFixture.data.choices,
      };
      expect(parseUpstreamProviderObservation(payload)).toBeNull();
    });

    it('accepts bare objects without a success key', () => {
      const payload = buildPayload({ routing: { finalProvider: 'bare' } });
      expect(parseUpstreamProviderObservation(payload)?.finalProvider).toBe('bare');
    });

    it('returns null for non-object payloads', () => {
      expect(parseUpstreamProviderObservation(null)).toBeNull();
      expect(parseUpstreamProviderObservation(undefined)).toBeNull();
      expect(parseUpstreamProviderObservation('{}')).toBeNull();
      expect(parseUpstreamProviderObservation(42)).toBeNull();
      expect(parseUpstreamProviderObservation([{ choices: [] }])).toBeNull();
    });

    it('returns null for array payloads even when an element looks like a valid body', () => {
      expect(parseUpstreamProviderObservation([])).toBeNull();
      expect(parseUpstreamProviderObservation([nonStreamFixture.data])).toBeNull();
      expect(parseUpstreamProviderObservation([
        { choices: [{ index: 0, message: { provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } } }] },
      ])).toBeNull();
    });
  });

  describe('choice resolution', () => {
    it('returns null when choices is missing, not an array or empty', () => {
      expect(parseUpstreamProviderObservation({})).toBeNull();
      expect(parseUpstreamProviderObservation({ choices: 'nope' })).toBeNull();
      expect(parseUpstreamProviderObservation({ choices: [] })).toBeNull();
    });

    it('prefers index === 0 over sibling choices', () => {
      const payload = {
        choices: [
          { index: 1, message: { provider_metadata: { gateway: { routing: { finalProvider: 'second' } } } } },
          { index: 0, message: { provider_metadata: { gateway: { routing: { finalProvider: 'first' } } } } },
        ],
      };
      expect(parseUpstreamProviderObservation(payload)?.finalProvider).toBe('first');
    });

    it('falls back to the first array entry when no choice has index 0', () => {
      const payload = {
        choices: [
          { index: 3, message: { provider_metadata: { gateway: { routing: { finalProvider: 'only' } } } } },
          { index: 7, message: { provider_metadata: { gateway: { routing: { finalProvider: 'later' } } } } },
        ],
      };
      expect(parseUpstreamProviderObservation(payload)?.finalProvider).toBe('only');
    });

    it('returns null when the selected choice is not an object', () => {
      expect(parseUpstreamProviderObservation({ choices: ['nope'] })).toBeNull();
    });

    it('does not merge metadata across multiple choices', () => {
      const payload = {
        choices: [
          { index: 0, message: { provider_metadata: { gateway: { routing: { finalProvider: 'alpha' } } } } },
          {
            index: 1,
            message: {
              provider_metadata: {
                gateway: { routing: { finalProvider: 'beta', clientSessionId: 'sess-other' } },
              },
            },
          },
        ],
      };
      const observation = parseUpstreamProviderObservation(payload);
      expect(observation?.finalProvider).toBe('alpha');
      expect(observation?.clientSessionId).toBeNull();
    });
  });

  describe('provider_metadata resolution', () => {
    it('prefers message.provider_metadata over delta.provider_metadata', () => {
      const payload = {
        choices: [{
          index: 0,
          message: { provider_metadata: { gateway: { routing: { finalProvider: 'from-message' } } } },
          delta: { provider_metadata: { gateway: { routing: { finalProvider: 'from-delta' } } } },
        }],
      };
      expect(parseUpstreamProviderObservation(payload)?.finalProvider).toBe('from-message');
    });

    it('falls back to delta.provider_metadata when message has none', () => {
      const payload = {
        choices: [{
          index: 0,
          message: { role: 'assistant' },
          delta: { provider_metadata: { gateway: { routing: { finalProvider: 'from-delta' } } } },
        }],
      };
      expect(parseUpstreamProviderObservation(payload)?.finalProvider).toBe('from-delta');
    });

    it('returns null when provider_metadata is not an object', () => {
      const payload = {
        choices: [{ index: 0, message: { provider_metadata: 'nope' } }],
      };
      expect(parseUpstreamProviderObservation(payload)).toBeNull();
      expect(parseUpstreamProviderObservation({ choices: [{ index: 0, message: { provider_metadata: null } }] })).toBeNull();
    });
  });

  describe('routing resolution', () => {
    it('returns null when gateway.routing is absent or malformed', () => {
      expect(parseUpstreamProviderObservation({ choices: [{ index: 0, message: {} }] })).toBeNull();
      expect(parseUpstreamProviderObservation({
        choices: [{ index: 0, message: { provider_metadata: {} } }],
      })).toBeNull();
      expect(parseUpstreamProviderObservation({
        choices: [{ index: 0, message: { provider_metadata: { gateway: 'nope' } } }],
      })).toBeNull();
      expect(parseUpstreamProviderObservation({
        choices: [{ index: 0, message: { provider_metadata: { gateway: { routing: 'nope' } } } }],
      })).toBeNull();
    });

    it('returns null when finalProvider is missing, empty or not a string', () => {
      expect(parseUpstreamProviderObservation(buildPayload({ routing: {} }))).toBeNull();
      expect(parseUpstreamProviderObservation(buildPayload({ routing: { finalProvider: '' } }))).toBeNull();
      expect(parseUpstreamProviderObservation(buildPayload({ routing: { finalProvider: '   ' } }))).toBeNull();
      expect(parseUpstreamProviderObservation(buildPayload({ routing: { finalProvider: 42 } }))).toBeNull();
      expect(parseUpstreamProviderObservation(buildPayload({ routing: { finalProvider: null } }))).toBeNull();
    });

    it('keeps the observation and degrades the bad fields when the rest is malformed', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: {
          finalProvider: 'deepseek',
          affinity: 'nope',
          fallbacksAvailable: 'nope',
          modelAttempts: 'nope',
          modelAttemptCount: '2',
          totalProviderAttemptCount: 2.9,
          clientSessionId: 7,
        },
      }));
      expect(observation).toMatchObject({
        finalProvider: 'deepseek',
        affinityOutcome: null,
        affinityPinnedProvider: null,
        fallbacksAvailable: null,
        fallbackCount: null,
        modelAttemptsSummary: [],
        modelAttemptCount: 2,
        totalProviderAttemptCount: 2,
        clientSessionId: null,
      });
    });

    it('uses the last duplicate field value from parsed JSON (plain object semantics)', () => {
      const payload = JSON.parse(
        '{"choices":[{"index":0,"message":{"provider_metadata":{"gateway":{"routing":'
        + '{"finalProvider":"first-provider","finalProvider":"second-provider"}}}}}]}',
      );
      expect(parseUpstreamProviderObservation(payload)?.finalProvider).toBe('second-provider');
    });

    it('ignores the optional platformHint in v1', () => {
      const payload = buildPayload({ routing: { finalProvider: 'deepseek' } });
      expect(parseUpstreamProviderObservation(payload, 'openai')?.finalProvider).toBe('deepseek');
      expect(parseUpstreamProviderObservation(payload, null)?.finalProvider).toBe('deepseek');
    });
  });

  describe('fallbacksAvailable normalization', () => {
    it('filters non-strings and empty entries, keeping order', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'x', fallbacksAvailable: [1, 'alibaba', '', '  ', null, 'baseten'] },
      }));
      expect(observation?.fallbacksAvailable).toEqual(['alibaba', 'baseten']);
      expect(observation?.fallbackCount).toBe(2);
    });

    it('returns null when nothing usable remains', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'x', fallbacksAvailable: [1, null, '', '   '] },
      }));
      expect(observation?.fallbacksAvailable).toBeNull();
      expect(observation?.fallbackCount).toBeNull();
    });

    it(`truncates to ${UPSTREAM_PROVIDER_FALLBACKS_LIMIT} entries`, () => {
      const entries = Array.from({ length: UPSTREAM_PROVIDER_FALLBACKS_LIMIT + 5 }, (_value, index) => `provider-${index}`);
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'x', fallbacksAvailable: entries },
      }));
      expect(observation?.fallbacksAvailable).toHaveLength(UPSTREAM_PROVIDER_FALLBACKS_LIMIT);
      expect(observation?.fallbacksAvailable?.[0]).toBe('provider-0');
      expect(observation?.fallbacksAvailable?.at(-1)).toBe(`provider-${UPSTREAM_PROVIDER_FALLBACKS_LIMIT - 1}`);
      expect(observation?.fallbackCount).toBe(UPSTREAM_PROVIDER_FALLBACKS_LIMIT);
    });
  });

  describe('cache block resolution', () => {
    it('finds the provider block case-insensitively when the exact key is missing', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'DeepSeek' },
        metadataExtra: {
          deepseek: {
            promptCacheHitTokens: 3,
            promptCacheMissTokens: 7,
            systemFingerprint: 'fp-case',
          },
        },
      }));
      expect(observation).toMatchObject({
        finalProvider: 'DeepSeek',
        cacheHitTokens: 3,
        cacheMissTokens: 7,
        systemFingerprint: 'fp-case',
      });
    });

    it('prefers the exact provider key when both cases exist', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'DeepSeek' },
        metadataExtra: {
          deepseek: { promptCacheMissTokens: 1, systemFingerprint: 'fp-lower' },
          DeepSeek: { promptCacheMissTokens: 2, systemFingerprint: 'fp-exact' },
        },
      }));
      expect(observation).toMatchObject({
        cacheMissTokens: 2,
        systemFingerprint: 'fp-exact',
      });
    });

    it('returns null cache fields when the provider block is missing', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'unknown-provider' },
      }));
      expect(observation).toMatchObject({
        cacheHitTokens: null,
        cacheMissTokens: null,
        systemFingerprint: null,
      });
    });

    it('drops non-finite cache values instead of throwing', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'deepseek' },
        metadataExtra: {
          deepseek: {
            promptCacheHitTokens: 'many',
            promptCacheMissTokens: 12.7,
            systemFingerprint: '',
          },
        },
      }));
      expect(observation).toMatchObject({
        cacheHitTokens: null,
        cacheMissTokens: 12,
        systemFingerprint: null,
      });
    });
  });

  describe('cost parsing', () => {
    it('parses string-number costs and drops non-numeric text', () => {
      const payload = buildPayload({ routing: { finalProvider: 'deepseek' } });
      const metadata = (payload.choices as any[])[0].message.provider_metadata;
      metadata.gateway.cost = 'not-a-number';
      metadata.gateway.inferenceCost = '';
      const observation = parseUpstreamProviderObservation(payload);
      expect(observation).toMatchObject({
        gatewayCostText: 'not-a-number',
        gatewayCostNumber: null,
        gatewayInferenceCostText: null,
        gatewayInferenceCostNumber: null,
      });
    });

    it('accepts numeric gateway costs and keeps their text form', () => {
      const payload = buildPayload({ routing: { finalProvider: 'deepseek' } });
      const metadata = (payload.choices as any[])[0].message.provider_metadata;
      metadata.gateway.cost = 0.25;
      metadata.gateway.inferenceCost = 0;
      const observation = parseUpstreamProviderObservation(payload);
      expect(observation).toMatchObject({
        gatewayCostText: '0.25',
        gatewayCostNumber: 0.25,
        gatewayInferenceCostText: '0',
        gatewayInferenceCostNumber: 0,
      });
    });

    it('reads usage costs from the unwrapped container and never fills them from gateway', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'deepseek' },
        usage: { cost: '0.5', gateway_cost: 1, market_cost: 'abc' },
      }));
      expect(observation).toMatchObject({
        usageCost: 0.5,
        usageGatewayCost: 1,
        usageMarketCost: null,
        gatewayCostText: null,
        gatewayCostNumber: null,
      });
    });

    it('leaves usage costs null when usage is missing even if gateway costs exist', () => {
      const payload = buildPayload({ routing: { finalProvider: 'deepseek' } });
      const metadata = (payload.choices as any[])[0].message.provider_metadata;
      metadata.gateway.cost = '0.000027';
      const observation = parseUpstreamProviderObservation(payload);
      expect(observation).toMatchObject({
        usageCost: null,
        usageGatewayCost: null,
        usageMarketCost: null,
        gatewayCostText: '0.000027',
      });
    });

    it('reads usage costs from data.usage for wrapped payloads', () => {
      const observation = parseUpstreamProviderObservation({
        success: true,
        data: {
          choices: [{
            index: 0,
            message: { provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } },
          }],
          usage: { cost: 0.125, gateway_cost: 0.25, market_cost: 0.5 },
        },
      });
      expect(observation).toMatchObject({
        usageCost: 0.125,
        usageGatewayCost: 0.25,
        usageMarketCost: 0.5,
      });
    });

    it('never cross-reads usage between the wrapper root and data (A2 hardwired paths)', () => {
      const wrapped = parseUpstreamProviderObservation({
        success: true,
        usage: { cost: 999, gateway_cost: 999, market_cost: 999 },
        data: {
          choices: [{
            index: 0,
            message: { provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } },
          }],
          usage: { cost: 0.25 },
        },
      });
      expect(wrapped).toMatchObject({ usageCost: 0.25, usageGatewayCost: null, usageMarketCost: null });

      const bare = parseUpstreamProviderObservation({
        choices: [{
          index: 0,
          delta: { provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } },
        }],
        usage: { cost: 0.5 },
      });
      expect(bare).toMatchObject({ usageCost: 0.5, usageGatewayCost: null, usageMarketCost: null });

      const bareWithDataOnlyUsage = parseUpstreamProviderObservation({
        choices: [{
          index: 0,
          delta: { provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } },
        }],
        data: { usage: { cost: 999 } },
      });
      expect(bareWithDataOnlyUsage).toMatchObject({ usageCost: null });
    });
  });

  describe('model attempts summary', () => {
    it('reads the source field providerAttempts with content, ignoring a providers alias at attempt level', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: {
          finalProvider: 'deepseek',
          modelAttempts: [{
            canonicalSlug: 'a/b',
            success: true,
            providerAttemptCount: 1,
            // Legacy/aliased key must not be read: an implementation that
            // silently reads the wrong field would produce an empty array here.
            providers: [{ provider: 'legacy-alias', credentialType: 'system', statusCode: 200, success: true }],
          }, {
            canonicalSlug: 'c/d',
            success: true,
            providerAttemptCount: 1,
            providerAttempts: [{ provider: 'real-source', credentialType: 'user', statusCode: 200, success: true }],
          }],
        },
      }));
      expect(observation?.modelAttemptsSummary).toEqual([
        { canonicalSlug: 'a/b', success: true, providerAttemptCount: 1, providers: [] },
        {
          canonicalSlug: 'c/d',
          success: true,
          providerAttemptCount: 1,
          providers: [{ provider: 'real-source', credentialType: 'user', statusCode: 200, success: true }],
        },
      ]);
    });

    it('drops non-object attempts and non-object provider attempts', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: {
          finalProvider: 'deepseek',
          modelAttempts: [
            'nope',
            {
              canonicalSlug: 'a/b',
              success: false,
              providerAttemptCount: 2,
              providerAttempts: [
                null,
                { provider: 'p1', credentialType: 'system', statusCode: 429, success: false, providerRequestId: 'x' },
                { provider: 'p2', credentialType: 'user', statusCode: '200', success: true },
              ],
            },
            { canonicalSlug: null, success: 'yes', providerAttemptCount: null, providerAttempts: [] },
          ],
        },
      }));
      expect(observation?.modelAttemptsSummary).toEqual([
        {
          canonicalSlug: 'a/b',
          success: false,
          providerAttemptCount: 2,
          providers: [
            { provider: 'p1', credentialType: 'system', statusCode: 429, success: false },
            { provider: 'p2', credentialType: 'user', statusCode: 200, success: true },
          ],
        },
        {
          canonicalSlug: null,
          success: null,
          providerAttemptCount: null,
          providers: [],
        },
      ]);
    });

    it('returns an empty summary when modelAttempts is not an array', () => {
      const observation = parseUpstreamProviderObservation(buildPayload({
        routing: { finalProvider: 'deepseek', modelAttempts: 'nope' },
      }));
      expect(observation?.modelAttemptsSummary).toEqual([]);
    });
  });
});
