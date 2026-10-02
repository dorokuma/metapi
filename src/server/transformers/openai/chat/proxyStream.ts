import { anthropicMessagesTransformer } from '../../anthropic/messages/index.js';
import { createProxyStreamLifecycle } from '../../shared/protocolLifecycle.js';
import { type DownstreamFormat, type ParsedSseEvent } from '../../shared/normalized.js';
import { createOpenAiChatAggregateState, applyOpenAiChatStreamEvent, finalizeOpenAiChatAggregate } from './aggregator.js';
import {
  buildNormalizedFinalToOpenAiChatChunks,
  normalizeOpenAiChatFinalToNormalized,
} from './responseBridge.js';
import { openAiChatStream, buildTerminalUsageRecord } from './streamBridge.js';
import { config } from '../../../config.js';

type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

type ChatProxyStreamSessionInput = {
  downstreamFormat: DownstreamFormat;
  modelName: string;
  successfulUpstreamPath: string;
  // Opt-in terminal usage chunk for the openai downstream format. Claude stays
  // false (its terminal frame is message_delta/message_stop, never a usage chunk).
  includeUsage?: boolean;
  onParsedPayload?: (payload: unknown) => void;
  onEventParsed?: (payload: unknown) => void;
  /**
   * M2：调用方视角的「本轮是否已向下游写出过字节」（chatSurface 传 `() => streamStarted`）。
   *
   * 未写过字节时，带内失败帧**不再 hijack 成 200 SSE**，只 `markFailed(上游原文)`，把「状态码 + 上游原文」
   * 交给既有 HTTP 层失败出口（未 hijack 的 502 出口）；已写过字节时才走带内透传。缺省视为「已写过」
   * （无此回调的调用方保持既有行为）。
   */
  hasStartedDownstreamWrite?: () => boolean;
  /**
   * M1：本轮已向客户端交付带内失败信号时回调（调用方的「补帧门禁」据此不再补第二帧：已知原因
   * 绝不补一帧自写的 `Upstream stream interrupted before a terminal event`）。
   */
  onInBandFailureDelivered?: () => void;
  writeLines: (lines: string[]) => void;
  writeRaw: (chunk: string) => void;
};

type ResponseSink = {
  end(): void;
};

type ChatProxyStreamResult = {
  status: 'completed' | 'failed';
  errorMessage: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 带内失败帧判据。上游把 provider 4xx/429 包成 HTTP 200 + `text/event-stream` 时，失败只写在帧里：
 * 实测形（Cline/Vercel 网关）为 `data: {"error":{"code":"stream_initialization_failed","message":
 * "…request failed with status 429: {\"error\":{\"message\":\"Rate limit exceeded … Retry after 29s.\"}}",
 * "request_id":"…"},"type":"stream_error"}` 后跟 `data: [DONE]`。旧判据只认 `type` 为
 * `response.failed` / `error`，这类帧认不到 ⇒ 归一化无匹配 ⇒ 序列化为空 ⇒ 文本被静默丢弃。
 *
 * 返回分类（`null` = 不是失败帧）：
 * - `legacy`：改动前就认得的形（`type` 为 `response.failed` / `error`），逐字保持原判据（不 trim / 不小写），
 *   继续走原有归一化 + 序列化路径，行为不变；
 * - `new`：本轮新增认得的形（顶层带 `error` 对象 / `type` 为 `stream_error` / SSE 帧名为 `error`）——
 *   这类帧不再进归一化链被丢弃，改走带内失败出口（见 `emitInBandFailureFrame`：上游 payload 原文 +
 *   本仓重建的 SSE 信封）。
 *
 * `legacy` 优先于 `new`：`event: error` + `{"type":"error",…}` 这类既有形必须继续走老路径。
 */
function classifyInBandFailure(eventName: string, payload: unknown): 'legacy' | 'new' | null {
  const payloadType = isRecord(payload) && typeof payload.type === 'string' ? payload.type : '';
  if (payloadType === 'response.failed' || payloadType === 'error') return 'legacy';
  if (payloadType.trim().toLowerCase() === 'stream_error') return 'new';
  // 顶层带 `error` 对象：含 `error.type` 为 `stream_error`、`error.code` 为 `stream_initialization_failed`
  // 的实测形，以及 OpenRouter 式 `{"error":{"code":429,…}}`。OpenAI chat 流协议里没有任何正常帧
  // 以顶层 `error` 对象承载正文，故这里是失败的无歧义信号。
  if (isRecord(payload) && isRecord(payload.error)) return 'new';
  if (eventName.trim().toLowerCase() === 'error') return 'new';
  return null;
}

/**
 * 上游带内失败帧的重建：**上游 payload 原文 + 本仓重建的 SSE 信封**（不是「上游字节原样」：
 * `data:` 行按原文本逐行前缀，多行 data 帧逐行加 `data: ` 还原，否则第二行起会变成非法 SSE
 * ——与 `anthropic/messages/streamBridge.ts` 的 `serializeAnthropicRawSseEvent` 同口径）。
 */
function formatRawSseBlock(eventBlock: ParsedSseEvent): string {
  const dataLines = eventBlock.data.split('\n').map((line) => `data: ${line}`).join('\n');
  return eventBlock.event
    ? `event: ${eventBlock.event}\n${dataLines}\n\n`
    : `${dataLines}\n\n`;
}

/**
 * 上游错误原文的结构化补充：`error.code` / `request_id` 通常在外层字段，原文本身不含，落库后无从定位
 * 是哪次上游请求失败，故在**不覆盖原文**的前提下追加一段后缀；两者都缺时原样返回（不留尾随标点）。
 */
function appendFailureIdentifiers(message: string, record: Record<string, unknown>): string {
  const error = isRecord(record.error) ? record.error : null;
  const code = typeof error?.code === 'string' && error.code.trim() ? error.code.trim() : '';
  const recordRequestId = typeof record.request_id === 'string' && record.request_id.trim()
    ? record.request_id.trim()
    : '';
  const errorRequestId = typeof error?.request_id === 'string' && error.request_id.trim()
    ? error.request_id.trim()
    : '';
  const requestId = recordRequestId || errorRequestId;
  const parts = [code ? `code=${code}` : '', requestId ? `request_id=${requestId}` : ''].filter(Boolean);
  if (parts.length <= 0) return message;
  return `${message} (${parts.join(', ')})`;
}

export function createChatProxyStreamSession(input: ChatProxyStreamSessionInput) {
  const downstreamTransformer = input.downstreamFormat === 'claude'
    ? anthropicMessagesTransformer
    : {
      createStreamContext: openAiChatStream.createContext,
      transformStreamEvent: openAiChatStream.normalizeEvent,
      serializeStreamEvent: openAiChatStream.serializeEvent,
      serializeDone: openAiChatStream.serializeDone,
      pullSseEvents: openAiChatStream.pullSseEvents,
    };
  const streamContext = downstreamTransformer.createStreamContext(input.modelName);
  streamContext.includeUsage = input.includeUsage === true;

  // For OpenAI downstream, flush buffered signatures as reasoning_details
  // chunks so pi receives the full thinking text + signature in a single
  // delta (pi concatenates successive reasoning.text items and stores the
  // resulting array as thinkingSignature for the next round).
  if (input.downstreamFormat === 'openai') {
    streamContext.onThinkingBlockStopped = (flushChunk) => {
      if (!flushChunk) return;
      const serialized = `data: ${JSON.stringify(flushChunk)}\n\n`;
      // Write directly (not via pendingWrites) so the signature chunk
      // reaches the client before [DONE] and is not trapped in the
      // pending-writes queue waiting for a subsequent tool/text chunk.
      input.writeLines([serialized]);
      // The signature chunk is real downstream output. Mark the stream as
      // forwarded so the terminal finish_reason chunk emitted in this same
      // event block (and any later chunk) is force-written directly instead
      // of being deferred to finalize's pendingWrites flush — guaranteeing
      // reasoning_details precedes finish_reason/[DONE].
      forwardedDownstreamOutput = true;
    };
  }
  const claudeContext = anthropicMessagesTransformer.createDownstreamContext();
  const chatAggregateState = input.downstreamFormat === 'openai'
    ? createOpenAiChatAggregateState()
    : null;
  let finalized = false;
  let terminalResult: ChatProxyStreamResult = {
    status: 'completed',
    errorMessage: null,
  };
  let terminalNormalizedFinal: ReturnType<typeof normalizeOpenAiChatFinalToNormalized> | null = null;
  let forwardedDownstreamOutput = false;
  /** 上游自己带了终结帧（`data: [DONE]`）：失败终态下本仓不生成终结帧，但仍原样透传上游那一个。 */
  let upstreamDoneSeen = false;
  const pendingWrites: string[] = [];

  const extractFailureMessage = (payload: unknown, fallback = 'upstream stream failed'): string => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
        const message = (record.error as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) {
          return appendFailureIdentifiers(message.trim(), record);
        }
      }
      if (typeof record.message === 'string' && record.message.trim()) {
        return appendFailureIdentifiers(record.message.trim(), record);
      }
      if (record.response && typeof record.response === 'object' && !Array.isArray(record.response)) {
        const responseError = (record.response as Record<string, unknown>).error;
        if (responseError && typeof responseError === 'object' && !Array.isArray(responseError)) {
          const message = (responseError as Record<string, unknown>).message;
          if (typeof message === 'string' && message.trim()) {
            return appendFailureIdentifiers(message.trim(), record);
          }
        }
      }
    }
    return fallback;
  };

  const markFailed = (payload: unknown, fallbackMessage?: string) => {
    terminalResult = {
      status: 'failed',
      errorMessage: extractFailureMessage(payload, fallbackMessage),
    };
    // A failed stream must never gain a trailing usage chunk, even when an
    // earlier frame already captured terminalUsage; drop the opt-in so
    // serializeStreamDone emits only [DONE]. Mirrors the suppression in
    // finalize so the invariant holds regardless of call ordering.
    streamContext.includeUsage = false;
  };

  const hasMeaningfulChatAggregateOutput = (): boolean => {
    if (input.downstreamFormat !== 'openai' || !chatAggregateState) return false;
    for (const choice of chatAggregateState.choices.values()) {
      if (choice.content.length > 0) return true;
      if (choice.reasoning.length > 0) return true;
      if (choice.toolCalls.some((item) => item.id || item.name || item.arguments)) return true;
    }
    return false;
  };

  const hasMeaningfulNormalizedFinalOutput = (): boolean => {
    if (!terminalNormalizedFinal) return false;
    const choices = Array.isArray(terminalNormalizedFinal.choices)
      ? terminalNormalizedFinal.choices
      : [];
    if (choices.some((choice) => (
      choice.content.length > 0
      || choice.reasoningContent.length > 0
      || choice.toolCalls.some((toolCall) => toolCall.id || toolCall.name || toolCall.arguments)
    ))) {
      return true;
    }
    if (terminalNormalizedFinal.content.length > 0) return true;
    if (terminalNormalizedFinal.reasoningContent.length > 0) return true;
    return terminalNormalizedFinal.toolCalls.some((toolCall) => toolCall.id || toolCall.name || toolCall.arguments);
  };

  const flushPendingWrites = () => {
    if (pendingWrites.length <= 0) return;
    input.writeLines([...pendingWrites]);
    pendingWrites.length = 0;
  };

  const emitLines = (lines: string[], options?: { meaningful?: boolean; force?: boolean }) => {
    if (lines.length <= 0) return;
    if (input.downstreamFormat !== 'openai') {
      input.writeLines(lines);
      return;
    }
    if (forwardedDownstreamOutput) {
      input.writeLines(lines);
      return;
    }
    if (options?.force) {
      pendingWrites.length = 0;
      forwardedDownstreamOutput = true;
      input.writeLines(lines);
      return;
    }
    if (options?.meaningful) {
      forwardedDownstreamOutput = true;
      flushPendingWrites();
      input.writeLines(lines);
      return;
    }
    pendingWrites.push(...lines);
  };

  const emitRaw = (chunk: string, options?: { meaningful?: boolean; force?: boolean }) => {
    if (!chunk) return;
    if (input.downstreamFormat !== 'openai') {
      input.writeRaw(chunk);
      return;
    }
    if (forwardedDownstreamOutput) {
      input.writeRaw(chunk);
      return;
    }
    if (options?.force) {
      pendingWrites.length = 0;
      forwardedDownstreamOutput = true;
      input.writeRaw(chunk);
      return;
    }
    if (options?.meaningful) {
      forwardedDownstreamOutput = true;
      flushPendingWrites();
      input.writeRaw(chunk);
      return;
    }
    pendingWrites.push(chunk);
  };

  /** 「本轮是否已向下游写出过字节」——M2 的分流依据（缺省视为已写过，保持无此回调时的既有行为）。 */
  const hasStartedDownstreamWrite = (): boolean => input.hasStartedDownstreamWrite?.() !== false;

  /**
   * M1：「已向客户端交付带内失败信号」的事实上报（调用方的补帧门禁据此不再补第二帧）。
   */
  const noteInBandFailureDelivered = () => {
    input.onInBandFailureDelivered?.();
  };

  /**
   * 带内失败出口：把上游带内失败帧写回客户端。
   *
   * - openai 下游：按**上游 payload 原文 + 本仓重建的 SSE 信封**写（保留 `event:` 名与 `data:` 原文；
   *   多行 data 逐行加 `data: `），`error.message` 原文、`error.code`、`request_id` 一个不改地到客户端；
   * - claude 下游：上游帧不是 Anthropic 形，按本仓既有 claude 带内错误帧形（
   *   `event: error` + `{"type":"error","error":{"type":"api_error","message":…}}`，与断流补帧
   *   `buildSurfaceInBandStreamErrorFrame` 同形）承载同一份上游原文。
   *
   * 一律 `force`：失败帧必须立即写出，既不能被 `pendingWrites` 扣住，也要把 `forwardedDownstreamOutput`
   * 置真，避免后续收尾再补合成帧。
   */
  const emitInBandFailureFrame = (eventBlock: ParsedSseEvent, message: string) => {
    if (input.downstreamFormat === 'claude') {
      emitLines([
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message },
        })}\n\n`,
      ], { force: true });
      return;
    }
    emitRaw(formatRawSseBlock(eventBlock), { force: true });
  };

  const shouldFailEmptyChatCompletion = (): boolean => {
    if (!config.proxyEmptyContentFailEnabled) return false;
    if (input.downstreamFormat !== 'openai') return false;
    if (terminalResult.status === 'failed') return false;
    if (hasMeaningfulChatAggregateOutput()) return false;
    if (hasMeaningfulNormalizedFinalOutput()) return false;
    // A buffered (or already-flushed) signature is meaningful output; don't
    // fail empty completion. After the flush clears pendingSignature, the
    // signatureDetailsSent flag carries the "we emitted a signed
    // reasoning_details" state, so a pure-signature (no tool/content) response
    // must not be killed by the empty-content interceptor.
    if (streamContext.pendingSignature || streamContext.signatureDetailsSent) return false;
    return true;
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;

    if (shouldFailEmptyChatCompletion()) {
      markFailed({
        error: {
          message: 'Upstream returned empty content',
        },
      }, 'Upstream returned empty content');
      return;
    }

    if (terminalResult.status === 'failed') {
      // M3（用户口径：统一不补）：失败终态下本仓**不再生成**终结帧（openai 的 `data: [DONE]` /
      // claude 的 `message_stop`）。上游自己带的终结帧若已到达，openai 下游原样透传上游那一个
      // （`upstreamDoneSeen`）；上游没带 ⇒ 客户端拿不到终结帧（与断流补帧出口一致：失败就是失败，
      // 不给出「正常结束」的信号）。claude 下游一律不补 `message_stop`。
      // M2：也**不 flush** 未写出的缓冲——未写字节时上游原文由 HTTP 层失败出口（502 JSON）下发，
      // flush 会把响应 hijack 成 200 SSE，客户端就再也拿不到状态码了。
      streamContext.includeUsage = false;
      if (upstreamDoneSeen && hasStartedDownstreamWrite() && input.downstreamFormat === 'openai') {
        // 用 `emitLines`（而不是 `emitRaw`）写上游自带的那一个 `[DONE]`：两者字节相同，
        // 但对只实现 `writeLines` 的调用方/夹具也会真实落地，不会静默丢掉终结帧。
        //
        // R3-B：**保留**这帧回放，不要顺手删。oracle 依 codex 源码核实：codex 系（`chat_completions.rs:415-416`）
        // 对**优雅 EOF** 同样 Emit Completed，`:313-340` 只在 HTTP 429/5xx 才触发重试 ⇒「客户端把失败当
        // 正常结束」不是这帧 `[DONE]` 造成的，删掉它既治不了病，又破坏「本仓不生成终结帧、只回放上游自带的
        // 那一个」这一口径（真正治病的是 R3-A：未写字节的失败根本不进 SSE，走 HTTP 502）。
        emitLines(['data: [DONE]\n\n'], { force: true });
      }
      return;
    }

    if (input.downstreamFormat === 'openai' && !forwardedDownstreamOutput) {
      forwardedDownstreamOutput = true;
      flushPendingWrites();
    }

    // For native Anthropic streams, EOF without message_stop is not a clean
    // completion. Forward the partial stream as-is instead of fabricating an
    // end_turn/message_stop pair that makes clients think the run finished.
    if (input.downstreamFormat === 'claude' && !claudeContext.doneSent) {
      return;
    }

    // 失败终态已在上面 early-return（`terminalResult.status === 'failed'` 分支），所以此处不再重复判 status。
    if (
      input.downstreamFormat === 'openai'
      && chatAggregateState
      && chatAggregateState.choices.size > 0
    ) {
      const needsTerminalFinishChunk = Array.from(chatAggregateState.choices.values())
        .some((choice) => !choice.finishReason);
      if (needsTerminalFinishChunk) {
        const terminalChunk = buildNormalizedFinalToOpenAiChatChunks(
          finalizeOpenAiChatAggregate(chatAggregateState, {
            id: streamContext.id,
            model: streamContext.model,
            created: streamContext.created,
            content: '',
            reasoningContent: '',
            finishReason: 'stop',
            toolCalls: [],
          }),
        ).slice(-1)[0];
        if (terminalChunk) {
          emitLines([`data: ${JSON.stringify(terminalChunk)}\n\n`], { meaningful: true });
        }
      }
    }

    emitLines(downstreamTransformer.serializeDone(streamContext, claudeContext), { meaningful: true });
  };

  const handleEventBlock = async (eventBlock: ParsedSseEvent): Promise<boolean> => {
    if (eventBlock.data === '[DONE]') {
      upstreamDoneSeen = true;
      finalize();
      return true;
    }

    let parsedPayload: unknown = null;
    if (input.downstreamFormat === 'claude') {
      const consumed = anthropicMessagesTransformer.consumeSseEventBlock(
        eventBlock,
        streamContext,
        claudeContext,
        input.modelName,
      );
      parsedPayload = consumed.parsedPayload;
      if (parsedPayload && typeof parsedPayload === 'object') {
        input.onParsedPayload?.(parsedPayload);
      }
      if (consumed.handled) {
        // A 识别（SSE `event: error` / Anthropic 原始 error 帧）：本仓 anthropic 转换器把这类帧当标准
        // 原始事件**原样转发**（客户端已经看到错误），但既不记失败也不留原文。这里只补上既有的
        // `markFailed` 语义（失败原因用上游原文），不改任何已写出的字节。
        //
        // M1：本支线转发的**就是**上游原生的失败帧（客户端看得懂），故一并上报「已交付带内失败信号」
        // ——否则收尾的补帧门禁会在它之后又补一帧自写的 `Upstream stream interrupted…`。
        // M2 不适用本支线：这里转发的是上游自己协议内的原生错误帧（claude 客户端本就认它），
        // 强行改成 HTTP 层 502 JSON 反而会把上游协议内的帧形弄丢。
        if (classifyInBandFailure(eventBlock.event, consumed.parsedPayload)) {
          markFailed(consumed.parsedPayload, eventBlock.data);
          noteInBandFailureDelivered();
        }
        input.writeLines(consumed.lines);
        return consumed.done;
      }
    } else {
      try {
        parsedPayload = JSON.parse(eventBlock.data);
      } catch {
        parsedPayload = null;
      }
      if (parsedPayload && typeof parsedPayload === 'object') {
        input.onParsedPayload?.(parsedPayload);
      }
    }

    // A 识别：先分类（`legacy` 逐字保持老行为，`new` 走带内失败出口）。
    const failureKind = classifyInBandFailure(eventBlock.event, parsedPayload);
    if (failureKind === 'new') {
      if (parsedPayload && typeof parsedPayload === 'object') {
        input.onEventParsed?.(parsedPayload);
      }
      // B：失败原因用上游原文（含 code / request_id），不再回落成自写的
      // `Upstream returned empty content`。
      const failureMessage = extractFailureMessage(parsedPayload, eventBlock.data);
      markFailed(parsedPayload, eventBlock.data);
      // M2：还没向下游写出过任何字节 ⇒ **不** hijack 写帧，交给 HTTP 层失败出口用状态码 + 上游原文
      // 交付（codex 系会自行退避重试，pi 也看得到原文）；已写过字节才走带内透传。
      if (hasStartedDownstreamWrite()) {
        emitInBandFailureFrame(eventBlock, failureMessage);
        noteInBandFailureDelivered();
      }
      return input.downstreamFormat === 'claude' && claudeContext.doneSent;
    }

    if (parsedPayload && typeof parsedPayload === 'object') {
      input.onEventParsed?.(parsedPayload);
      if (failureKind === 'legacy') {
        // R3-A：legacy 失败帧（`type:'error'` / `response.failed`）与 `new` 同受 M2 门禁——
        // **未写过字节时不 hijack**，只 `markFailed(上游原文)`，把「状态码 + 上游原文」交给既有 HTTP 层
        // 失败出口（502 JSON）。原因：下面的 `emitLines(..., { force: true })` 会在「一个字节都没写过」时把
        // 响应 hijack 成 200 SSE，而 codex 系对 `finish_reason:'error'` 与优雅 EOF 都发 Completed
        // ⇒ 客户端拿到的是「正常结束但空」。已写过字节时维持原行为（归一化块 + `force`）——
        // **claude 下游例外**（R4 后改发 `event: error`，见下）。
        if (!hasStartedDownstreamWrite()) {
          markFailed(parsedPayload, eventBlock.data);
          return input.downstreamFormat === 'claude' && claudeContext.doneSent;
        }
        // R4（R3-⑥ 闭环）：claude 下游 + 已写字节 + legacy 老形失败（`response.failed`）——上游帧不是
        // Anthropic 形，若继续走下面的归一化块，claude 序列化器会把 `response.failed` 归一化出的
        // `finish_reason:"stop"` 渲染成 `message_delta{stop_reason:"end_turn"}` + `message_stop`
        // （`anthropic/messages/streamBridge.ts:559` `buildDoneEvents` / `:758` `toClaudeStopReason` 把
        // `stop` 映射成 `end_turn`）
        // ⇒ 客户端把失败读成「正常结束（带部分内容）」，而服务端记 failed。
        // 改为复用 M1 已在用的 claude 带内错误帧出口（`emitInBandFailureFrame` 的 claude 分支，与本文件
        // `new` 形的出口同一条）：恰好一帧 `event: error`（message = 上游原文，保留末尾
        // `(code=…, request_id=…)` 后缀），且不含任何本仓生成的终结帧；已写出的内容原样保留在前。
        // openai 下游**不受影响**：维持归一化块语义（R3-A 用例 ② 锁住）。
        if (input.downstreamFormat === 'claude') {
          const failureMessage = extractFailureMessage(parsedPayload, eventBlock.data);
          markFailed(parsedPayload, eventBlock.data);
          emitInBandFailureFrame(eventBlock, failureMessage);
          noteInBandFailureDelivered();
          return claudeContext.doneSent;
        }
        markFailed(parsedPayload);
      }
      const normalizedEvent = downstreamTransformer.transformStreamEvent(parsedPayload, streamContext, input.modelName);
      if (input.downstreamFormat === 'openai' && chatAggregateState) {
        applyOpenAiChatStreamEvent(chatAggregateState, normalizedEvent);
      }
      emitLines(
        downstreamTransformer.serializeStreamEvent(normalizedEvent, streamContext, claudeContext),
        {
          meaningful: hasMeaningfulChatAggregateOutput(),
          force: failureKind === 'legacy',
        },
      );
      // M1：legacy 失败帧下发的 `finish_reason:"error"` 块也是「已交付失败信号」（客户端已知道原因），
      // 故收尾的补帧门禁不得再补一帧自写的断流文案。
      if (failureKind === 'legacy') {
        noteInBandFailureDelivered();
      }
      return input.downstreamFormat === 'claude' && claudeContext.doneSent;
    }

    if (input.downstreamFormat === 'openai') {
      emitRaw(`data: ${eventBlock.data}\n\n`, { meaningful: true });
      return false;
    }

    input.writeLines(anthropicMessagesTransformer.serializeStreamEvent({
      contentDelta: eventBlock.data,
    }, streamContext, claudeContext));
    return claudeContext.doneSent;
  };

  return {
    consumeUpstreamFinalPayload(payload: unknown, fallbackText: string, response?: ResponseSink): ChatProxyStreamResult {
      if (payload && typeof payload === 'object') {
        input.onParsedPayload?.(payload);
      }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const failureKind = classifyInBandFailure('', payload);
        if (failureKind === 'legacy') {
          markFailed(payload);
        } else if (failureKind === 'new') {
          markFailed(payload, fallbackText);
        }
      }
      if (input.downstreamFormat === 'openai') {
        const normalizedFinal = normalizeOpenAiChatFinalToNormalized(payload, input.modelName, fallbackText);
        terminalNormalizedFinal = normalizedFinal;
        streamContext.id = normalizedFinal.id;
        streamContext.model = normalizedFinal.model;
        streamContext.created = normalizedFinal.created;
        // Remember the final usage for the terminal usage chunk without altering
        // the synthetic chunks emitted by responseBridge.
        const terminalUsage = buildTerminalUsageRecord(normalizedFinal.usagePayload, normalizedFinal.usageDetails);
        if (terminalUsage) {
          streamContext.terminalUsage = terminalUsage;
        }
        emitLines(
          buildNormalizedFinalToOpenAiChatChunks(normalizedFinal)
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
          { meaningful: true },
        );
      } else {
        emitLines(
          anthropicMessagesTransformer.serializeUpstreamFinalAsStream(
            payload,
            input.modelName,
            fallbackText,
            streamContext,
            claudeContext,
          ),
          { meaningful: true },
        );
      }
      finalize();
      response?.end();
      return terminalResult;
    },
    async run(reader: StreamReader | null | undefined, response: ResponseSink): Promise<ChatProxyStreamResult> {
      const lifecycle = createProxyStreamLifecycle<ParsedSseEvent>({
        reader,
        response,
        pullEvents: (buffer) => downstreamTransformer.pullSseEvents(buffer),
        handleEvent: handleEventBlock,
        onEof: finalize,
      });
      await lifecycle.run();
      return terminalResult;
    },
  };
}
