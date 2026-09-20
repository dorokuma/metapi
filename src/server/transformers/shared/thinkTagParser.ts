export type ThinkTagParserState = {
  mode: 'content' | 'reasoning';
  pending: string;
  // Close tag of the variant that opened the current reasoning section, so a
  // `<thinking>` section is closed by `</thinking>` rather than `</think>`.
  closeTag: string | null;
  // True once non-whitespace content has been emitted. Upstreams that inline
  // their thinking open the tag at the very start of the stream; an opening
  // tag that appears AFTER real content is ambiguous: it is either a literal
  // tag mention (e.g. an assistant discussing these tags in its answer) or an
  // upstream echo of the reasoning. See reasoningChannelActive below.
  seenContent: boolean;
  // Set by the caller once the upstream has emitted thinking through a direct
  // reasoning channel (reasoning_content / thinking deltas) for this response.
  // When that channel is active, an opening tag found AFTER real content is
  // treated as an aggregator echo of the reasoning (duplicated into content
  // wrapped in think tags) and is discarded instead of leaking as text.
  reasoningChannelActive: boolean;
  // True while consuming an echo section: enclosed text is dropped entirely.
  echoing: boolean;
};

const TAG_VARIANTS: ReadonlyArray<{ open: string; close: string }> = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
  { open: '<thought>', close: '</thought>' },
  { open: '<reasoning>', close: '</reasoning>' },
];

const OPEN_TAGS = TAG_VARIANTS.map((variant) => variant.open);
const CLOSE_TAGS = TAG_VARIANTS.map((variant) => variant.close);
const MAX_TAG_LENGTH = Math.max(...TAG_VARIANTS.flatMap((variant) => [variant.open.length, variant.close.length]));

function findEarliestTag(haystack: string, tags: readonly string[]): { tag: string; index: number } | null {
  const haystackLower = haystack.toLowerCase();
  let best: { tag: string; index: number } | null = null;
  for (const tag of tags) {
    const index = haystackLower.indexOf(tag);
    if (index >= 0 && (!best || index < best.index)) {
      best = { tag, index };
    }
  }
  return best;
}

function longestSuffixThatIsTagPrefix(value: string, tags: readonly string[]): number {
  const valueLower = value.toLowerCase();
  const maxLength = Math.min(value.length, MAX_TAG_LENGTH - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = valueLower.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}

export function createThinkTagParserState(): ThinkTagParserState {
  return {
    mode: 'content',
    pending: '',
    closeTag: null,
    seenContent: false,
    reasoningChannelActive: false,
    echoing: false,
  };
}

type ConsumedChunk = {
  emitted: string;
  remaining: string;
  matched: boolean;
  matchedTag: string | null;
  // True when this match opened an ECHO reasoning section (discard mode).
  echoStart: boolean;
  // Suffix to hold back across chunk boundaries; null when the caller should
  // simply continue scanning `remaining` (literal-tag case).
  holdPending: string | null;
};

function consumeChunk(state: ThinkTagParserState, rest: string): ConsumedChunk {
  const tags = state.mode === 'content' ? OPEN_TAGS : [state.closeTag ?? '</think>'];
  const found = findEarliestTag(rest, tags);
  if (found) {
    // Real content precedes this opening tag (in prior chunks or earlier in
    // this same buffer): the tag is either a literal mention or an echo.
    const contentBeforeTag = state.seenContent || rest.slice(0, found.index).trim().length > 0;
    if (state.mode === 'content' && contentBeforeTag) {
      if (state.reasoningChannelActive) {
        // Echo: the direct reasoning channel already carries the thinking, so
        // this tagged copy after real content is dropped entirely. Text before
        // the tag is genuine content and must be kept.
        return {
          emitted: rest.slice(0, found.index),
          remaining: rest.slice(found.index + found.tag.length),
          matched: true,
          matchedTag: found.tag,
          echoStart: true,
          holdPending: null,
        };
      }
      // Literal tag: keep it in the content channel verbatim.
      return {
        emitted: rest.slice(0, found.index + found.tag.length),
        remaining: rest.slice(found.index + found.tag.length),
        matched: false,
        matchedTag: null,
        echoStart: false,
        holdPending: null,
      };
    }
    return {
      emitted: rest.slice(0, found.index),
      remaining: rest.slice(found.index + found.tag.length),
      matched: true,
      matchedTag: found.tag,
      echoStart: false,
      holdPending: null,
    };
  }

  const pendingLength = longestSuffixThatIsTagPrefix(rest, tags);
  return {
    emitted: rest.slice(0, rest.length - pendingLength),
    remaining: '',
    matched: false,
    matchedTag: null,
    echoStart: false,
    holdPending: rest.slice(rest.length - pendingLength),
  };
}

export function consumeThinkTaggedText(
  state: ThinkTagParserState,
  chunk: string,
): { content: string; reasoning: string } {
  if (!chunk) {
    return { content: '', reasoning: '' };
  }

  let content = '';
  let reasoning = '';
  let rest = `${state.pending}${chunk}`;
  state.pending = '';

  while (rest.length > 0) {
    const consumed = consumeChunk(state, rest);
    if (state.mode === 'content') {
      content += consumed.emitted;
      if (consumed.emitted.trim()) {
        state.seenContent = true;
      }
    } else if (!state.echoing) {
      reasoning += consumed.emitted;
    }

    rest = consumed.remaining;
    if (consumed.matched) {
      if (state.mode === 'content') {
        state.mode = 'reasoning';
        state.closeTag = TAG_VARIANTS.find((variant) => variant.open === consumed.matchedTag)?.close ?? '</think>';
        state.echoing = consumed.echoStart;
      } else {
        state.mode = 'content';
        state.closeTag = null;
        state.echoing = false;
      }
      continue;
    }

    if (consumed.holdPending !== null) {
      state.pending = consumed.holdPending;
      break;
    }
    // Literal tag consumed: keep scanning `remaining`.
  }

  return { content, reasoning };
}

export function flushThinkTaggedText(state: ThinkTagParserState): { content: string; reasoning: string } {
  if (!state.pending || state.echoing) {
    state.pending = '';
    return { content: '', reasoning: '' };
  }

  const remainder = state.pending;
  state.pending = '';
  return state.mode === 'content'
    ? { content: remainder, reasoning: '' }
    : { content: '', reasoning: remainder };
}

export function extractInlineThinkTags(
  text: string,
  options?: { reasoningChannelActive?: boolean },
): { content: string; reasoning: string } {
  if (!text) {
    return { content: '', reasoning: '' };
  }

  const state = createThinkTagParserState();
  if (options?.reasoningChannelActive) {
    state.reasoningChannelActive = true;
  }
  const consumed = consumeThinkTaggedText(state, text);
  const flushed = flushThinkTaggedText(state);
  return {
    content: `${consumed.content}${flushed.content}`,
    reasoning: `${consumed.reasoning}${flushed.reasoning}`,
  };
}
