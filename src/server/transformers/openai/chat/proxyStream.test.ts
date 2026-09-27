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

  it('streams 864 pattern: empty reasoning + signature + tool_use through real proxy path', async () => {
    const lines: string[] = [];
    const reader = makeReader([
      dataFrame({ id: 'cmpl-864', model: 'gpt-5', choices: [{ index: 0, delta: { reasoning_signature: '864-uuid' }, finish_reason: null }] }),
      dataFrame({ id: 'cmpl-864', model: 'gpt-5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }] }),
      dataFrame({ id: 'cmpl-864', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
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

    // Signature chunk must appear before [DONE]
    const signatureChunks = payloads.filter((p) => p.choices?.[0]?.delta?.reasoning_details);
    expect(signatureChunks.length).toBe(1);
    expect(signatureChunks[0]?.choices?.[0]?.delta?.reasoning_details).toEqual([
      { type: 'reasoning.text', text: '', signature: '864-uuid' },
    ]);

    // tool_calls chunk must also be present
    const toolChunks = payloads.filter((p) => p.choices?.[0]?.delta?.tool_calls);
    expect(toolChunks.length).toBeGreaterThan(0);

    // Terminal finish_reason chunk
    const terminal = payloads.find((p) => p.choices?.[0]?.finish_reason === 'tool_calls');
    expect(terminal).toBeDefined();
  });

  it('does not fail empty completion when only a signature is buffered (no content/tools)', async () => {
    const originalEmptyContentFail = config.proxyEmptyContentFailEnabled;
    // Close the loop: enable the empty-content interceptor so this test
    // actually exercises the pendingSignature/signatureDetailsSent guard
    // instead of passing trivially with the switch off (false green).
    config.proxyEmptyContentFailEnabled = true;
    try {
      const lines: string[] = [];
      const reader = makeReader([
        dataFrame({ id: 'cmpl-sig-only', model: 'gpt-5', choices: [{ index: 0, delta: { reasoning_signature: 'sig-only' }, finish_reason: null }] }),
        dataFrame({ id: 'cmpl-sig-only', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
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
      const signatureChunks = payloads.filter((p) => p.choices?.[0]?.delta?.reasoning_details);
      expect(signatureChunks.length).toBe(1);
      expect(signatureChunks[0]?.choices?.[0]?.delta?.reasoning_details).toEqual([
        { type: 'reasoning.text', text: '', signature: 'sig-only' },
      ]);
    } finally {
      config.proxyEmptyContentFailEnabled = originalEmptyContentFail;
    }
  });

  it('B1: writes the buffered signature chunk before finish_reason and [DONE] (order guarantee)', async () => {
    const lines: string[] = [];
    const reader = makeReader([
      dataFrame({ id: 'cmpl-b1-order', model: 'gpt-5', choices: [{ index: 0, delta: { reasoning_signature: 'sig-b1-order' }, finish_reason: null }] }),
      dataFrame({ id: 'cmpl-b1-order', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
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

    const output = lines.join('');
    const detailIdx = output.indexOf('"reasoning_details"');
    const finishIdx = output.indexOf('finish_reason":"stop"');
    const doneIdx = output.indexOf('[DONE]');
    expect(detailIdx).toBeGreaterThan(-1);
    expect(finishIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    // reasoning_details precedes the finish_reason frame, which precedes [DONE].
    expect(detailIdx).toBeLessThan(finishIdx);
    expect(finishIdx).toBeLessThan(doneIdx);
    // Exactly one reasoning_details chunk carries the buffered signature.
    const { payloads } = parseStreamOutput(output);
    const signatureChunks = payloads.filter((p) => p.choices?.[0]?.delta?.reasoning_details);
    expect(signatureChunks.length).toBe(1);
    expect(signatureChunks[0]?.choices?.[0]?.delta?.reasoning_details).toEqual([
      { type: 'reasoning.text', text: '', signature: 'sig-b1-order' },
    ]);
  });

  it('B1: flushes a buffered signature before [DONE] on premature finalize (stream ends without finish_reason)', async () => {
    const originalEmptyContentFail = config.proxyEmptyContentFailEnabled;
    // Enable the interceptor so the buffered-signature guard is exercised on
    // the premature-finalize path (no finish_reason frame, direct [DONE]).
    config.proxyEmptyContentFailEnabled = true;
    try {
      const lines: string[] = [];
      const reader = makeReader([
        dataFrame({ id: 'cmpl-b1-eof', model: 'gpt-5', choices: [{ index: 0, delta: { reasoning_signature: 'sig-b1-eof' }, finish_reason: null }] }),
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
      // The buffered signature is meaningful output: must not be killed by the
      // empty-content interceptor even though no content/tool frame arrived.
      expect(result.status).toBe('completed');

      const output = lines.join('');
      const detailIdx = output.indexOf('"reasoning_details"');
      const doneIdx = output.indexOf('[DONE]');
      expect(detailIdx).toBeGreaterThan(-1);
      expect(doneIdx).toBeGreaterThan(-1);
      // The EOF-fallback flush (serializeStreamDone) writes the signature chunk
      // before the [DONE] terminator.
      expect(detailIdx).toBeLessThan(doneIdx);
      const { payloads, done } = parseStreamOutput(output);
      expect(done).toBe(1);
      const signatureChunks = payloads.filter((p) => p.choices?.[0]?.delta?.reasoning_details);
      expect(signatureChunks.length).toBe(1);
      expect(signatureChunks[0]?.choices?.[0]?.delta?.reasoning_details).toEqual([
        { type: 'reasoning.text', text: '', signature: 'sig-b1-eof' },
      ]);
    } finally {
      config.proxyEmptyContentFailEnabled = originalEmptyContentFail;
    }
  });
});
