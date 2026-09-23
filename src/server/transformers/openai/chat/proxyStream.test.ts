import { describe, expect, it } from 'vitest';

import { config } from '../../../config.js';
import { createChatProxyStreamSession } from './proxyStream.js';

function dataFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const DONE_FRAME = 'data: [DONE]\n\n';

function makeReader(frames: string[]) {
  return {
    reads: 0,
    async read() {
      if (this.reads >= frames.length) return { done: true };
      const frame = frames[this.reads];
      this.reads += 1;
      return { done: false, value: new TextEncoder().encode(frame) };
    },
    async cancel() {
      return undefined;
    },
    releaseLock() {},
  };
}

function parseStreamOutput(output: string): { payloads: Array<Record<string, unknown>>; done: number } {
  const payloads: Array<Record<string, unknown>> = [];
  let done = 0;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') {
      done += 1;
      continue;
    }
    try {
      payloads.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // ignore non-JSON frames
    }
  }
  return { payloads, done };
}

function isUsageChunk(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.choices) && payload.choices.length === 0 && !!(payload as { usage?: unknown }).usage;
}

describe('createChatProxyStreamSession (usage terminal chunk)', () => {
  it('streams content, a finish frame, then a terminal usage chunk before [DONE]', async () => {
    const lines: string[] = [];
    let ended = false;
    const reader = makeReader([
      dataFrame({ id: 'chatcmpl-1', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] }),
      dataFrame({ id: 'chatcmpl-1', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      dataFrame({
        id: 'chatcmpl-1',
        model: 'gpt-5',
        choices: [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 2 },
        },
      }),
      DONE_FRAME,
    ]);

    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/chat/completions',
      includeUsage: true,
      writeLines: (next) => { lines.push(...next); },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() { ended = true; } });
    expect(result).toEqual({ status: 'completed', errorMessage: null });
    expect(ended).toBe(true);

    const { payloads, done } = parseStreamOutput(lines.join(''));
    expect(done).toBe(1);
    // Exactly one choices:[] usage terminal chunk, and it is the final payload
    // before the [DONE] terminator (never emitted mid-stream).
    const usageChunks = payloads.filter(isUsageChunk);
    expect(usageChunks.length).toBe(1);
    expect(payloads[payloads.length - 1]).toBe(usageChunks[0]);
    // input_tokens/cached_tokens map onto the openai chat usage shape.
    expect((usageChunks[0] as any).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 },
    });
  });

  it('does not emit a usage chunk when includeUsage is false', async () => {
    const lines: string[] = [];
    const reader = makeReader([
      dataFrame({ id: 'chatcmpl-2', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] }),
      dataFrame({ id: 'chatcmpl-2', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      dataFrame({ id: 'chatcmpl-2', model: 'gpt-5', choices: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
      DONE_FRAME,
    ]);

    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/chat/completions',
      includeUsage: false,
      writeLines: (next) => { lines.push(...next); },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() {} });
    expect(result.status).toBe('completed');
    const { payloads, done } = parseStreamOutput(lines.join(''));
    expect(done).toBe(1);
    expect(payloads.some(isUsageChunk)).toBe(false);
  });

  it('does not pad a zero usage chunk when includeUsage is enabled but no usage frame arrived', async () => {
    const lines: string[] = [];
    const reader = makeReader([
      dataFrame({ id: 'chatcmpl-3', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] }),
      dataFrame({ id: 'chatcmpl-3', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      DONE_FRAME,
    ]);

    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/chat/completions',
      includeUsage: true,
      writeLines: (next) => { lines.push(...next); },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() {} });
    expect(result.status).toBe('completed');
    const { payloads, done } = parseStreamOutput(lines.join(''));
    expect(done).toBe(1);
    expect(payloads.some(isUsageChunk)).toBe(false);
    // No fabricated zero-valued usage object anywhere in the stream.
    expect(lines.join('')).not.toContain('"usage"');
  });

  it('does not append a usage chunk when the stream fails even if usage was already seen', async () => {
    const lines: string[] = [];
    const reader = makeReader([
      dataFrame({ id: 'chatcmpl-4', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] }),
      dataFrame({ id: 'chatcmpl-4', model: 'gpt-5', choices: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
      dataFrame({ type: 'error', error: { message: 'upstream stream failed' } }),
      DONE_FRAME,
    ]);

    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/chat/completions',
      includeUsage: true,
      writeLines: (next) => { lines.push(...next); },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() {} });
    expect(result.status).toBe('failed');
    const { payloads, done } = parseStreamOutput(lines.join(''));
    expect(done).toBe(1);
    expect(payloads.some(isUsageChunk)).toBe(false);
  });

  it('does not pad or synthesize a usage chunk when shouldFailEmptyChatCompletion triggers after usage was captured', async () => {
    const originalEmptyContentFail = config.proxyEmptyContentFailEnabled;
    config.proxyEmptyContentFailEnabled = true;
    try {
      const lines: string[] = [];
      let ended = false;
      const reader = makeReader([
        dataFrame({ id: 'chatcmpl-5', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
        dataFrame({ id: 'chatcmpl-5', model: 'gpt-5', choices: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
        DONE_FRAME,
      ]);

      const session = createChatProxyStreamSession({
        downstreamFormat: 'openai',
        modelName: 'gpt-5',
        successfulUpstreamPath: '/v1/chat/completions',
        includeUsage: true,
        writeLines: (next) => { lines.push(...next); },
        writeRaw: () => {},
      });

      const result = await session.run(reader as any, { end() { ended = true; } });
      expect(result).toEqual({ status: 'failed', errorMessage: 'Upstream returned empty content' });
      expect(ended).toBe(true);

      const output = lines.join('');
      const { payloads, done } = parseStreamOutput(output);
      // The empty-content failure is a hard failure: no terminal usage chunk is
      // backfilled from the usage frame, the stream carries zero (or only
      // synthesized) downstream frames, and no usage payload is written at all.
      expect(payloads.filter(isUsageChunk)).toHaveLength(0);
      expect(output).not.toContain('usage');
      expect(payloads).toHaveLength(0);
      expect(done).toBe(0);
    } finally {
      config.proxyEmptyContentFailEnabled = originalEmptyContentFail;
    }
  });
});
