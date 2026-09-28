import { describe, expect, it } from 'vitest';
import {
  hasProxyUsagePayload,
  mergeProxyUsage,
  parseProxyUsage,
  pullSseDataEvents,
} from './proxyUsageParser.js';

describe('proxyUsageParser', () => {
  it('parses standard OpenAI usage fields', () => {
    const usage = parseProxyUsage({
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
      },
    });

    expect(usage).toEqual({
      promptTokens: 123,
      completionTokens: 45,
      totalTokens: 168,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      promptTokensIncludeCache: null,
      presence: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });

  it('parses input/output token style usage fields', () => {
    const usage = parseProxyUsage({
      usage: {
        input_tokens: 80,
        output_tokens: 20,
      },
    });

    expect(usage).toEqual({
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      promptTokensIncludeCache: null,
      presence: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: false,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });

  it('parses Gemini usageMetadata shape', () => {
    const usage = parseProxyUsage({
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 34,
        totalTokenCount: 46,
      },
    });

    expect(usage).toEqual({
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      promptTokensIncludeCache: null,
      presence: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });

  it('parses deeply nested usage payloads', () => {
    const usage = parseProxyUsage({
      data: {
        result: {
          response: {
            usage: {
              prompt_tokens: 210,
              completion_tokens: 40,
              total_tokens: 250,
            },
          },
        },
      },
    });

    expect(usage).toEqual({
      promptTokens: 210,
      completionTokens: 40,
      totalTokens: 250,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      promptTokensIncludeCache: null,
      presence: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });

  it('reads detail objects for cache and reasoning without synthesizing prompt/completion/total', () => {
    const usage = parseProxyUsage({
      usage: {
        prompt_tokens_details: {
          text_tokens: 7,
          cached_tokens: 3,
        },
        completion_tokens_details: {
          reasoning_tokens: 20,
        },
      },
    });

    expect(usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
      reasoningTokens: 20,
      promptTokensIncludeCache: true,
      presence: {
        promptTokens: false,
        completionTokens: false,
        totalTokens: false,
        cacheReadTokens: true,
        cacheCreationTokens: false,
        reasoningTokens: true,
      },
    });
  });

  it('parses anthropic cache usage fields without treating input tokens as cache-inclusive', () => {
    const usage = parseProxyUsage({
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 40,
      },
    });

    expect(usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 0,
      cacheReadTokens: 1000,
      cacheCreationTokens: 40,
      reasoningTokens: 0,
      promptTokensIncludeCache: false,
      presence: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: false,
        cacheReadTokens: true,
        cacheCreationTokens: true,
        reasoningTokens: false,
      },
    });
  });

  it('extracts 1h-TTL cache-creation when upstream reports it separately', () => {
    const usage = parseProxyUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation: {
          ephemeral_5m_input_tokens: 120,
          ephemeral_1h_input_tokens: 330,
        },
      },
    });

    // Standard cache creation still reflects the total; the 1h share is surfaced separately.
    expect(usage.cacheCreationTokens).toBe(450);
    expect(usage.cacheCreationTokens1h).toBe(330);

    // The flat 1h field form also maps (and wins when larger).
    const flat = parseProxyUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 50 },
        claude_cache_creation_1_h_tokens: 800,
      },
    });
    expect(flat.cacheCreationTokens1h).toBe(800);
  });

  it('leaves cc1h at 0 when the 1h share is not separately reported', () => {
    const usage = parseProxyUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 120 },
      },
    });

    expect(usage.cacheCreationTokens).toBe(120);
    expect(usage.cacheCreationTokens1h ?? 0).toBe(0);
  });

  it('merges usage snapshots by keeping richer values', () => {
    const merged = mergeProxyUsage(
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        promptTokensIncludeCache: null,
        presence: {
          promptTokens: false,
          completionTokens: false,
          totalTokens: false,
          cacheReadTokens: false,
          cacheCreationTokens: false,
          reasoningTokens: false,
        },
      },
      {
        promptTokens: 90,
        completionTokens: 30,
        totalTokens: 120,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        promptTokensIncludeCache: null,
        presence: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          cacheReadTokens: false,
          cacheCreationTokens: false,
          reasoningTokens: false,
        },
      },
    );

    expect(merged).toEqual({
      promptTokens: 90,
      completionTokens: 30,
      totalTokens: 120,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      promptTokensIncludeCache: null,
      presence: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });

  it('does not treat null placeholders as explicit upstream usage', () => {
    expect(hasProxyUsagePayload({
      usage: {
        total_tokens: null,
        cache_creation: {},
      },
    })).toBe(false);
  });

  it('treats explicit zero usage values as upstream usage', () => {
    expect(hasProxyUsagePayload({
      usage: {
        total_tokens: 0,
      },
    })).toBe(true);
    expect(hasProxyUsagePayload({
      usage: {
        prompt_tokens_details: {
          cached_tokens: 0,
        },
      },
    })).toBe(true);
  });

  it('distinguishes missing keys from explicit zero values', () => {
    const usage = parseProxyUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 0,
        // total_tokens is absent
        cache_read_input_tokens: 0,
      },
    });

    expect(usage.presence.promptTokens).toBe(true);
    expect(usage.presence.completionTokens).toBe(true); // explicit 0 is present
    expect(usage.presence.totalTokens).toBe(false); // missing key
    expect(usage.presence.cacheReadTokens).toBe(true); // explicit 0 is present
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
  });

  it('takes the max across multiple aliases and preserves explicit zero', () => {
    const usage = parseProxyUsage({
      usage: {
        prompt_tokens: 10,
        promptTokens: 0,
        completion_tokens: 5,
        completionTokens: 20,
        total_tokens: 0,
        totalTokens: 50,
      },
    });

    expect(usage.promptTokens).toBe(10); // max(10, 0)
    expect(usage.presence.promptTokens).toBe(true);
    expect(usage.completionTokens).toBe(20); // max(5, 20)
    expect(usage.presence.completionTokens).toBe(true);
    expect(usage.totalTokens).toBe(50); // max(0, 50)
    expect(usage.presence.totalTokens).toBe(true);
  });

  it('reads OpenAI reasoning tokens from completion_tokens_details', () => {
    const usage = parseProxyUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        completion_tokens_details: {
          reasoning_tokens: 15,
        },
      },
    });

    expect(usage.reasoningTokens).toBe(15);
    expect(usage.presence.reasoningTokens).toBe(true);
    expect(usage.completionTokens).toBe(20);
    expect(usage.presence.completionTokens).toBe(true);
  });

  it('reads OpenAI reasoning tokens from output_tokens_details', () => {
    const usage = parseProxyUsage({
      usage: {
        prompt_tokens: 100,
        output_tokens: 20,
        output_tokens_details: {
          reasoning_tokens: 12,
        },
      },
    });

    expect(usage.reasoningTokens).toBe(12);
    expect(usage.presence.reasoningTokens).toBe(true);
  });

  it('prefers Gemini thoughtsTokenCount over nested reasoning tokens', () => {
    const usage = parseProxyUsage({
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 8,
        totalTokenCount: 18,
        completion_tokens_details: {
          reasoning_tokens: 99,
        },
      },
    });

    expect(usage.completionTokens).toBe(13); // 5 + 8
    expect(usage.reasoningTokens).toBe(8); // thoughts takes precedence
    expect(usage.presence.reasoningTokens).toBe(true);
  });

  it('pulls SSE data events across chunk boundaries', () => {
    const first = pullSseDataEvents('data: {"a":1}\n\ndata: {"b":');
    expect(first.events).toEqual(['{"a":1}']);
    expect(first.rest).toBe('data: {"b":');

    const second = pullSseDataEvents(`${first.rest}2}\n\ndata: [DONE]\n\n`);
    expect(second.events).toEqual(['{"b":2}']);
    expect(second.rest).toBe('');
  });
});
