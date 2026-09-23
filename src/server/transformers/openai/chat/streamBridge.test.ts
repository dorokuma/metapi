import { describe, expect, it } from 'vitest';

import { createClaudeDownstreamContext, serializeStreamDone } from '../../shared/normalized.js';
import { openAiChatStream } from './streamBridge.js';

function parseSsePayloads(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.startsWith('data: ') && line.trim() !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function parseDoneUsageChunk(lines: string[]): Record<string, unknown> {
  const usageLine = lines.find((line) => line.startsWith('data: ') && line.trim() !== 'data: [DONE]');
  expect(usageLine).toBeDefined();
  return JSON.parse((usageLine as string).slice(6)) as Record<string, unknown>;
}

describe('openai chat stream bridge', () => {
  it('normalizes stream payloads with choice metadata', () => {
    const context = openAiChatStream.createContext('gpt-5');
    const normalized = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-1',
      model: 'gpt-5',
      choices: [{
        index: 0,
        finish_reason: null,
        delta: {
          role: 'assistant',
          content: 'hello',
          reasoning_content: 'think',
        },
      }],
    }, context, 'gpt-5');

    expect(normalized).toMatchObject({
      choiceIndex: 0,
      role: 'assistant',
      contentDelta: 'hello',
      reasoningDelta: 'think',
    });
  });

  it('serializes stream events and done markers as openai chat chunks', () => {
    const context = openAiChatStream.createContext('gpt-5');
    const lines = openAiChatStream.serializeEvent({
      role: 'assistant',
      contentDelta: 'hello',
    } as any, context, createClaudeDownstreamContext());
    const doneLines = openAiChatStream.serializeDone(context, createClaudeDownstreamContext());

    const payloads = parseSsePayloads(lines);
    expect(payloads[0]).toMatchObject({
      model: 'gpt-5',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: 'hello',
        },
      }],
    });
    expect(doneLines.join('')).toContain('[DONE]');
  });

  it('round-trips tool-call deltas without flattening them into plain text', () => {
    const context = openAiChatStream.createContext('gpt-5');
    const normalized = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-tool-1',
      model: 'gpt-5',
      choices: [{
        index: 0,
        finish_reason: null,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: '{"city":"Shanghai"}',
            },
          }],
        },
      }],
    }, context, 'gpt-5');

    expect(normalized).toMatchObject({
      choiceIndex: 0,
      choiceEvents: [{
        index: 0,
        role: 'assistant',
        toolCallDeltas: [{
          index: 0,
          id: 'call_1',
          name: 'lookup_weather',
          argumentsDelta: '{"city":"Shanghai"}',
        }],
      }],
    });

    const payloads = parseSsePayloads(
      openAiChatStream.serializeEvent(normalized, context, createClaudeDownstreamContext()),
    );

    expect(payloads[0]).toMatchObject({
      model: 'gpt-5',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: '{"city":"Shanghai"}',
            },
          }],
        },
        finish_reason: null,
      }],
    });
  });

  it('does not replay historical tool identity on later multi-choice argument deltas', () => {
    const context = openAiChatStream.createContext('gpt-5');

    const started = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-multi-tool-1',
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            role: 'assistant',
            content: 'choice-0',
          },
        },
        {
          index: 1,
          finish_reason: null,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: {
                name: 'lookup_weather',
              },
            }],
          },
        },
      ],
    }, context, 'gpt-5');

    openAiChatStream.serializeEvent(started, context, createClaudeDownstreamContext());

    const continued = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-multi-tool-1',
      model: 'gpt-5',
      choices: [
        {
          index: 1,
          finish_reason: null,
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                arguments: '{"city":"Shanghai"}',
              },
            }],
          },
        },
      ],
    }, context, 'gpt-5');

    const payloads = parseSsePayloads(
      openAiChatStream.serializeEvent(continued, context, createClaudeDownstreamContext()),
    );
    const toolCall = ((((payloads[0] as any).choices[0] as any).delta.tool_calls[0]) as Record<string, unknown>);

    expect((payloads[0] as any).choices[0]).toMatchObject({
      index: 1,
      delta: {
        tool_calls: [{
          index: 0,
          function: {
            arguments: '{"city":"Shanghai"}',
          },
        }],
      },
      finish_reason: null,
    });
    expect(toolCall.id).toBeUndefined();
    expect(toolCall.type).toBeUndefined();
    expect((toolCall.function as Record<string, unknown>).name).toBeUndefined();
  });

  it('emits a terminal usage chunk before [DONE] for usage-only frames when includeUsage is enabled', () => {
    const context = openAiChatStream.createContext('gpt-5');
    context.includeUsage = true;

    const usageEvent = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-usage-1',
      model: 'gpt-5',
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    }, context, 'gpt-5');

    // A usage-only frame must never be serialized as a chunk on its own.
    expect(openAiChatStream.serializeEvent(usageEvent, context, createClaudeDownstreamContext())).toEqual([]);

    const doneLines = openAiChatStream.serializeDone(context, createClaudeDownstreamContext());
    expect(doneLines.length).toBe(2);
    expect(parseDoneUsageChunk(doneLines)).toMatchObject({
      id: 'chatcmpl-usage-1',
      object: 'chat.completion.chunk',
      model: 'gpt-5',
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    expect(doneLines[1].trim()).toBe('data: [DONE]');
  });

  it('keeps only the last usage frame as the terminal usage when includeUsage is enabled', () => {
    const context = openAiChatStream.createContext('gpt-5');
    context.includeUsage = true;

    const first = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-usage-2',
      model: 'gpt-5',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }, context, 'gpt-5');
    expect(openAiChatStream.serializeEvent(first, context, createClaudeDownstreamContext())).toEqual([]);

    const second = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-usage-2',
      model: 'gpt-5',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }, context, 'gpt-5');
    expect(openAiChatStream.serializeEvent(second, context, createClaudeDownstreamContext())).toEqual([]);

    const doneLines = openAiChatStream.serializeDone(context, createClaudeDownstreamContext());
    expect((parseDoneUsageChunk(doneLines).usage as Record<string, unknown>)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });

  it('emits only [DONE] for usage-only frames when includeUsage is not enabled', () => {
    const context = openAiChatStream.createContext('gpt-5');

    const usageEvent = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-usage-3',
      model: 'gpt-5',
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }, context, 'gpt-5');
    expect(openAiChatStream.serializeEvent(usageEvent, context, createClaudeDownstreamContext())).toEqual([]);

    expect(openAiChatStream.serializeDone(context, createClaudeDownstreamContext())).toEqual(['data: [DONE]\n\n']);
  });

  it('emits only [DONE] when includeUsage is enabled but no usage frame arrived', () => {
    const context = openAiChatStream.createContext('gpt-5');
    context.includeUsage = true;

    const content = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-usage-4',
      model: 'gpt-5',
      choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: 'hi' } }],
    }, context, 'gpt-5');
    openAiChatStream.serializeEvent(content, context, createClaudeDownstreamContext());

    expect(openAiChatStream.serializeDone(context, createClaudeDownstreamContext())).toEqual(['data: [DONE]\n\n']);
  });

  it('does not emit a terminal usage chunk when usage cannot be parsed into a finite number', () => {
    const context = openAiChatStream.createContext('gpt-5');
    context.includeUsage = true;

    const emptyUsage = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-usage-5',
      model: 'gpt-5',
      choices: [],
      usage: {},
    }, context, 'gpt-5');
    expect(openAiChatStream.serializeEvent(emptyUsage, context, createClaudeDownstreamContext())).toEqual([]);

    expect(openAiChatStream.serializeDone(context, createClaudeDownstreamContext())).toEqual(['data: [DONE]\n\n']);
  });

  it('keeps claude done output free of an openai usage chunk even when includeUsage is set', () => {
    const context = openAiChatStream.createContext('gpt-5');
    context.includeUsage = true;

    const usageEvent = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-usage-6',
      model: 'gpt-5',
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }, context, 'gpt-5');
    openAiChatStream.serializeEvent(usageEvent, context, createClaudeDownstreamContext());

    const doneLines = serializeStreamDone('claude', context, createClaudeDownstreamContext());
    const output = doneLines.join('');
    expect(output).toContain('message_delta');
    expect(output).toContain('message_stop');
    expect(output).not.toContain('chat.completion.chunk');
  });
});
