import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  fromTransformerMetadataRecord,
  createStreamTransformContext,
  normalizeStopReason,
  normalizeUpstreamFinalResponse,
  normalizeUpstreamStreamEvent,
  parseDownstreamChatRequest,
  pullSseEventsWithDone,
  serializeFinalResponse,
  toTransformerMetadataRecord,
  type NormalizedFinalResponse,
  type TransformerMetadata,
} from './normalized.js';

describe('shared normalized helpers', () => {
  it('does not depend on route-level chatFormats helpers', () => {
    const source = readFileSync(new URL('./normalized.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('routes/proxy/chatFormats');
    expect(source).not.toContain('chatFormats.js');
  });

  it('exposes shared transformer metadata extensions', () => {
    const source = readFileSync(new URL('./normalized.ts', import.meta.url), 'utf8');
    expect(source).toContain('thoughtSignatures');
    expect(source).toContain('promptCacheKey');
    expect(source).toContain('truncation');
    expect(source).toContain('serviceTier');
  });

  it('parses SSE events and keeps the trailing partial block', () => {
    const pulled = pullSseEventsWithDone([
      'event: message',
      'data: {"id":"1"}',
      '',
      'data: [DONE]',
      '',
      'data: {"partial":true}',
    ].join('\n'));

    expect(pulled.events).toEqual([
      { event: 'message', data: '{"id":"1"}' },
      { event: '', data: '[DONE]' },
    ]);
    expect(pulled.rest).toBe('data: {"partial":true}');
  });

  it('normalizes responses payloads with tool calls', () => {
    expect(normalizeUpstreamFinalResponse({
      object: 'response',
      id: 'resp_1',
      model: 'gpt-test',
      created: 123,
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
      ],
      status: 'completed',
    }, 'fallback-model')).toEqual({
      id: 'resp_1',
      model: 'gpt-test',
      created: 123,
      content: 'hello',
      reasoningContent: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      }],
    });
  });

  it('normalizes custom tool calls from responses payloads through the existing tool-call shape', () => {
    expect(normalizeUpstreamFinalResponse({
      object: 'response',
      id: 'resp_custom_tool_1',
      model: 'gpt-test',
      created: 123,
      output: [
        {
          type: 'custom_tool_call',
          call_id: 'call_custom',
          name: 'MyTool',
          input: '{"path":"README.md"}',
        },
      ],
      status: 'completed',
    }, 'fallback-model')).toEqual({
      id: 'resp_custom_tool_1',
      model: 'gpt-test',
      created: 123,
      content: '',
      reasoningContent: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'call_custom',
        name: 'MyTool',
        arguments: '{"path":"README.md"}',
      }],
    });
  });

  it('unwraps terminal response.completed envelopes when normalizing final responses', () => {
    expect(normalizeUpstreamFinalResponse({
      type: 'response.completed',
      response: {
        id: 'resp_terminal_1',
        model: 'gpt-test',
        created_at: 123,
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'hello' }],
          },
          {
            type: 'custom_tool_call',
            call_id: 'call_custom_1',
            name: 'Shell',
            input: '{"command":"pwd"}',
          },
        ],
      },
    }, 'fallback-model')).toEqual({
      id: 'resp_terminal_1',
      model: 'gpt-test',
      created: 123,
      content: 'hello',
      reasoningContent: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'call_custom_1',
        name: 'Shell',
        arguments: '{"command":"pwd"}',
      }],
    });
  });

  it('unwraps terminal response.incomplete envelopes when normalizing final responses', () => {
    expect(normalizeUpstreamFinalResponse({
      type: 'response.incomplete',
      response: {
        id: 'resp_terminal_2',
        model: 'gpt-test',
        created: 456,
        incomplete_details: {
          reason: 'max_output_tokens',
        },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'partial answer' }],
          },
        ],
      },
    }, 'fallback-model')).toEqual({
      id: 'resp_terminal_2',
      model: 'gpt-test',
      created: 456,
      content: 'partial answer',
      reasoningContent: '',
      finishReason: 'length',
      toolCalls: [],
    });
  });

  it('preserves responses reasoning summaries and encrypted reasoning signatures in final normalization', () => {
    expect(normalizeUpstreamFinalResponse({
      object: 'response',
      id: 'resp_reasoning_1',
      model: 'gpt-test',
      created_at: 456,
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'plan quietly' }],
          encrypted_content: 'enc-1',
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      ],
      status: 'completed',
    }, 'fallback-model')).toEqual({
      id: 'resp_reasoning_1',
      model: 'gpt-test',
      created: 456,
      content: 'hello',
      reasoningContent: 'plan quietly',
      reasoningSignature: 'enc-1',
      finishReason: 'stop',
      toolCalls: [],
    });
  });

  it('normalizes responses payloads with reasoning summaries and encrypted signatures', () => {
    expect(normalizeUpstreamFinalResponse({
      object: 'response',
      id: 'resp_reasoning_1',
      model: 'gpt-test',
      created: 123,
      output: [
        {
          type: 'reasoning',
          encrypted_content: 'enc_1',
          summary: [
            { type: 'summary_text', text: 'plan quietly' },
          ],
        },
      ],
      status: 'completed',
    }, 'fallback-model')).toEqual({
      id: 'resp_reasoning_1',
      model: 'gpt-test',
      created: 123,
      content: '',
      reasoningContent: 'plan quietly',
      reasoningSignature: 'enc_1',
      finishReason: 'stop',
      toolCalls: [],
    });
  });

  it('treats response.reasoning_summary_text.done as reasoning-only stream output', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      text: 'plan first',
    }, context, 'fallback-model')).toEqual({
      reasoningDelta: 'plan first',
    });
  });

  it('normalizes terminal-only responses output_item.done message content into visible stream content', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    }, context, 'fallback-model')).toEqual({
      role: 'assistant',
      contentDelta: 'hello',
    });
  });

  it('normalizes terminal-only responses output_item.done tool metadata into tool deltas', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'Glob',
        arguments: '{"pattern":"README*"}',
        status: 'completed',
      },
    }, context, 'fallback-model')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_1',
        name: 'Glob',
        argumentsDelta: '{"pattern":"README*"}',
      }],
    });
  });

  it('normalizes terminal-only custom tool responses into tool deltas and final tool calls', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'ct_1',
        type: 'custom_tool_call',
        call_id: 'call_custom_1',
        name: 'MyTool',
        input: '{"foo":"bar"}',
        status: 'completed',
      },
    }, context, 'fallback-model')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_custom_1',
        name: 'MyTool',
        argumentsDelta: '{"foo":"bar"}',
      }],
    });

    expect(normalizeUpstreamFinalResponse({
      object: 'response',
      id: 'resp_custom_tool_1',
      model: 'gpt-test',
      created: 321,
      output: [
        {
          id: 'ct_1',
          type: 'custom_tool_call',
          call_id: 'call_custom_1',
          name: 'MyTool',
          input: '{"foo":"bar"}',
        },
      ],
      status: 'completed',
    }, 'fallback-model')).toEqual({
      id: 'resp_custom_tool_1',
      model: 'gpt-test',
      created: 321,
      content: '',
      reasoningContent: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'call_custom_1',
        name: 'MyTool',
        arguments: '{"foo":"bar"}',
      }],
    });
  });

  it('normalizes terminal-only responses output payloads carried on response.completed', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.completed',
      response: {
        id: 'resp_done_only',
        model: 'gpt-test',
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        ],
      },
    }, context, 'fallback-model')).toMatchObject({
      contentDelta: 'hello',
      finishReason: 'stop',
      done: true,
    });
  });

  it('maps claude tools, tool choice, metadata, and reasoning when parsing downstream requests', () => {
    const result = parseDownstreamChatRequest({
      model: 'gpt-5',
      stream: true,
      metadata: { user_id: 'user-1' },
      thinking: {
        type: 'enabled',
        budget_tokens: 2048,
      },
      output_config: {
        effort: 'high',
      },
      tools: [{
        name: 'Glob',
        description: 'Search files',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
          },
          required: ['pattern'],
        },
      }],
      tool_choice: {
        type: 'tool',
        name: 'Glob',
      },
      messages: [{
        role: 'user',
        content: 'hello',
      }],
    }, 'claude');

    expect(result.error).toBeUndefined();
    expect(result.value?.upstreamBody).toMatchObject({
      model: 'gpt-5',
      stream: true,
      metadata: { user_id: 'user-1' },
      reasoning_effort: 'high',
      reasoning_budget: 2048,
      tools: [{
        type: 'function',
        function: {
          name: 'Glob',
          description: 'Search files',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
            required: ['pattern'],
          },
        },
      }],
      tool_choice: {
        type: 'function',
        function: {
          name: 'Glob',
        },
      },
    });
  });

  it('keeps claude thinking in reasoning_content and emits tool results before follow-up user text', () => {
    const result = parseDownstreamChatRequest({
      model: 'gpt-5',
      max_tokens: 256,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'plan quietly' },
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'Glob',
              input: { pattern: 'README*' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc',
              content: [{ type: 'text', text: '{"matches":1}' }],
            },
            { type: 'text', text: 'continue' },
          ],
        },
      ],
    }, 'claude');

    expect(result.error).toBeUndefined();
    expect(result.value?.upstreamBody.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'plan quietly',
        tool_calls: [{
          id: 'toolu_abc',
          type: 'function',
          function: {
            name: 'Glob',
            arguments: '{"pattern":"README*"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'toolu_abc',
        content: '{"matches":1}',
      },
      {
        role: 'user',
        content: 'continue',
      },
    ]);
  });

  it('serializes normalized final responses for claude', () => {
    const normalized = {
      id: 'chatcmpl-1',
      model: 'claude-test',
      created: 456,
      content: 'done',
      reasoningContent: 'thinking',
      reasoningSignature: 'metapi:anthropic-signature:sig-1',
      redactedReasoningContent: 'ciphertext',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'tool_1', name: 'lookup', arguments: '{"q":"x"}' }],
    } as NormalizedFinalResponse & {
      reasoningSignature: string;
      redactedReasoningContent: string;
    };

    expect(serializeFinalResponse('claude', normalized, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })).toEqual({
      id: 'msg_chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'thinking', thinking: 'thinking', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'ciphertext' },
        { type: 'text', text: 'done' },
        { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    });
  });

  it('normalizes Gemini native function calls as OpenAI tool calls', () => {
    const normalized = normalizeUpstreamFinalResponse({
      responseId: 'resp-gemini-tool-1',
      modelVersion: 'gemini-3.5-flash',
      candidates: [{
        index: 0,
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call_read',
              name: 'read',
              args: { path: '/tmp/example.txt' },
            },
            thoughtSignature: 'sig-tool',
          }],
        },
      }],
    }, 'fallback-model');

    expect(normalized.toolCalls).toEqual([{
      id: 'call_read',
      name: 'read',
      arguments: '{"path":"/tmp/example.txt"}',
    }]);
    expect(normalized.content).toBe('');
    expect(normalized.finishReason).toBe('tool_calls');

    expect(serializeFinalResponse('openai', normalized, {
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
    })).toMatchObject({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_read',
            type: 'function',
            function: {
              name: 'read',
              arguments: '{"path":"/tmp/example.txt"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  it('serializes provider-tagged reasoning signatures for openai-compatible downstreams', () => {
    const normalized = {
      id: 'chatcmpl-2',
      model: 'gpt-test',
      created: 789,
      content: 'final',
      reasoningContent: 'deliberation',
      reasoningSignature: 'metapi:openai-encrypted-reasoning:enc-1',
      finishReason: 'stop',
      toolCalls: [],
    } as NormalizedFinalResponse & { reasoningSignature: string };

    expect(serializeFinalResponse('openai', normalized, {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    })).toMatchObject({
      choices: [{
        message: {
          role: 'assistant',
          content: 'final',
          reasoning_content: 'deliberation',
          reasoning_signature: 'metapi:openai-encrypted-reasoning:enc-1',
        },
      }],
    });
  });

  it('round-trips shared transformer metadata through transport-safe records', () => {
    const metadata: TransformerMetadata = {
      promptCacheKey: 'cache-key',
      truncation: 'auto',
      serviceTier: 'priority',
      citations: [{ uri: 'https://example.com/citation' }],
      thoughtSignature: 'sig-final',
      thoughtSignatures: ['sig-tool', 'sig-final'],
      geminiSafetySettings: [{ category: 'SAFE', threshold: 'BLOCK_NONE' }],
      geminiImageConfig: { aspectRatio: '16:9' },
      groundingMetadata: [{ webSearchQueries: ['cats'] }],
      usageMetadata: { totalTokenCount: 42 },
      passthrough: {
        cachedContent: 'cached/item-1',
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
    };

    expect(fromTransformerMetadataRecord(toTransformerMetadataRecord(metadata))).toEqual(metadata);
  });

  it('normalizes known stop reasons', () => {
    expect(normalizeStopReason('max_output_tokens')).toBe('length');
    expect(normalizeStopReason('tool_use')).toBe('tool_calls');
    expect(normalizeStopReason('completed')).toBe('stop');
    expect(normalizeStopReason('mystery')).toBeNull();
  });

  describe('streaming inline think tags (glm/stepfun style upstreams)', () => {
    const chunk = (
      context: ReturnType<typeof createStreamTransformContext>,
      delta: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => normalizeUpstreamStreamEvent({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, ...extra }],
    }, context, 'fallback-model');
    const tidy = (event: Record<string, unknown>) => Object.fromEntries(
      Object.entries(event).filter(([, value]) => value !== undefined && value !== null),
    );
    const tidyChunk = (
      context: ReturnType<typeof createStreamTransformContext>,
      delta: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => tidy(chunk(context, delta, extra) as Record<string, unknown>);
    const tidyEvent = (payload: Record<string, unknown>, context: ReturnType<typeof createStreamTransformContext>) =>
      tidy(normalizeUpstreamStreamEvent(payload, context, 'fallback-model') as Record<string, unknown>);

    it('routes an opening tag that is its own delta into reasoning', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, { content: '<think>' })).toEqual({});
      expect(tidyChunk(context, { content: '真思考' })).toEqual({ reasoningDelta: '真思考' });
      expect(tidyChunk(context, { content: '</think>' })).toEqual({});
      expect(tidyChunk(context, { content: '正文回答' })).toEqual({ contentDelta: '正文回答' });
    });

    it('routes a tag split across deltas into reasoning', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, { content: '<thinkin' })).toEqual({});
      expect(tidyChunk(context, { content: 'g>真思考' })).toEqual({ reasoningDelta: '真思考' });
      expect(tidyChunk(context, { content: '</think' })).toEqual({});
      expect(tidyChunk(context, { content: 'ing>正文' })).toEqual({ contentDelta: '正文' });
    });

    it('parses a tag glued to the thinking text in one delta', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, { content: '<think>真思考</think>正文' })).toEqual({
        reasoningDelta: '真思考',
        contentDelta: '正文',
      });
    });

    it('flushes an unclosed reasoning section as reasoning on finish', () => {
      const context = createStreamTransformContext('glm-5.3');

      tidyChunk(context, { content: '<think>真思' });
      tidyChunk(context, { content: '考剩余' });
      expect(tidyChunk(context, { content: '' }, { finish_reason: 'stop' })).toEqual({
        finishReason: 'stop',
      });
    });

    it('flushes a partial pending tag as content on finish', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, { content: '正文开' })).toEqual({ contentDelta: '正文开' });
      expect(tidyChunk(context, { content: '<thi' })).toEqual({});
      expect(tidyChunk(context, { content: '' }, { finish_reason: 'stop' })).toEqual({
        contentDelta: '<thi',
        finishReason: 'stop',
      });
    });

    it('strips an echoed reasoning when reasoning_content duplicates content', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, {
        content: '逐步推理文本',
        reasoning_content: '逐步推理文本',
      })).toEqual({
        reasoningDelta: '逐步推理文本',
      });
    });

    it('keeps genuinely different content when reasoning_content is present', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, {
        content: '这是正文',
        reasoning_content: '思考内容',
      })).toEqual({
        contentDelta: '这是正文',
        reasoningDelta: '思考内容',
      });
    });

    it('discards a tagged reasoning echo after content when the direct reasoning channel is active', () => {
      const context = createStreamTransformContext('step-5-preview');

      expect(tidyChunk(context, { reasoning_content: '直接思考第一段' })).toEqual({
        reasoningDelta: '直接思考第一段',
      });
      expect(tidyChunk(context, { content: '回复开头：<think>回显的思考' })).toEqual({
        contentDelta: '回复开头：',
      });
      expect(tidyChunk(context, { content: '</think>真正的回答' })).toEqual({
        contentDelta: '真正的回答',
      });
    });

    it('keeps a literal tag in content when real content was already emitted', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, { content: '前面正文，提到 ' })).toEqual({ contentDelta: '前面正文，提到 ' });
      expect(tidyChunk(context, { content: '<think> 这个标签本身' })).toEqual({ contentDelta: '<think> 这个标签本身' });
      expect(tidyChunk(context, { content: '结尾' })).toEqual({ contentDelta: '结尾' });
    });

    it('still parses an opening tag after whitespace-only content', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, { content: ' <think>真思考' })).toEqual({ reasoningDelta: '真思考' });
      expect(tidyChunk(context, { content: '</think>正文' })).toEqual({ contentDelta: '正文' });
    });

    it('routes response.reasoning_text.delta events into reasoning', () => {
      const context = createStreamTransformContext('step-3.7-flash');

      expect(tidyEvent({
        type: 'response.reasoning_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        delta: '思考增量',
      }, context)).toEqual({ reasoningDelta: '思考增量' });

      expect(tidyEvent({
        type: 'response.reasoning_text.done',
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        text: '思考增量完毕',
      }, context)).toEqual({ reasoningDelta: '完毕' });
    });

    it('keeps reasoning items out of content on response.completed', () => {
      const context = createStreamTransformContext('step-3.7-flash');

      expect(tidyEvent({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            { type: 'reasoning', content: [{ type: 'reasoning_text', text: '完整思考' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终答案' }] },
          ],
        },
      }, context)).toEqual({
        role: 'assistant',
        reasoningDelta: '完整思考',
        contentDelta: '最终答案',
        finishReason: 'stop',
        done: true,
      });
    });

    it('strips the <thinking> variant in streaming deltas', () => {
      const context = createStreamTransformContext('glm-5.3');

      expect(tidyChunk(context, { content: '<thinking>整段思考内容' })).toEqual({ reasoningDelta: '整段思考内容' });
      expect(tidyChunk(context, { content: '</thinking>正文回答' })).toEqual({ contentDelta: '正文回答' });
    });

    it('strips the <thinking> variant in non-streaming final responses', () => {
      expect(normalizeUpstreamFinalResponse({
        object: 'chat.completion',
        model: 'glm-5.3-flash',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '<thinking>内部推演</thinking>最终答案',
          },
          finish_reason: 'stop',
        }],
      }, 'glm-5.3-flash')).toMatchObject({
        content: '最终答案',
        reasoningContent: '内部推演',
      });
    });

    it('drops the tagged echo in non-streaming responses when reasoning_content is present', () => {
      expect(normalizeUpstreamFinalResponse({
        object: 'chat.completion',
        model: 'step-5-preview',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '回复开头：<think>回显思考</think>最终答案',
            reasoning_content: '直接思考',
          },
          finish_reason: 'stop',
        }],
      }, 'step-5-preview')).toMatchObject({
        content: '回复开头：最终答案',
        reasoningContent: '直接思考',
      });
    });
  });
});
