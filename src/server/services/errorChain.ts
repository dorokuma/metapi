/**
 * 沿 `Error.cause` 链提取失败原因。
 *
 * 上游网络失败常只留下一个笼统的外层 message（如 `fetch failed` / `unknown error`），
 * 真正有用的 errno / syscall（`ECONNRESET`、`ETIMEDOUT` 等）藏在 `.cause` 链里，
 * 一旦只取 `.message` 就会丢失，导致失败分类（重试 / 轮换端点）与失败日志都看不出实因。
 * 这里统一把它摊平成可读文本，供代理失败日志、下游错误响应与失败分类复用。
 *
 * 约束：`seen` 集合防环，`maxDepth` 限深，避免自引用 / 环形 cause 造成死循环或超长文本。
 */

/** `.cause` 链条目对齐的最小结构（Node 系统错误 / undici TypeError / drizzle 包装错误等）。 */
export interface ErrorCauseLike {
  message?: string;
  code?: string | number;
  errno?: string | number;
  syscall?: string;
  cause?: unknown;
}

/** 默认最大链深：真实链通常 ≤3 层，超过即视为异常链。 */
export const DEFAULT_ERROR_CAUSE_MAX_DEPTH = 8;

function normalizeMaxDepth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_ERROR_CAUSE_MAX_DEPTH;
  }
  return Math.trunc(value);
}

function readToken(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * 单层错误的取证描述：`code` / `syscall` / `errno` 前缀 + message，
 * 已在 message 里出现过的 token 不重复拼接（避免 `connect ECONNRESET ECONNRESET connect ...`）。
 */
function describeErrorCauseNode(node: ErrorCauseLike): string {
  const message = typeof node.message === 'string' ? node.message.trim() : '';
  const loweredMessage = message.toLowerCase();
  const tokens: string[] = [];
  const pushToken = (token: string | null) => {
    if (!token) return;
    const lowered = token.toLowerCase();
    if (loweredMessage.includes(lowered) || tokens.includes(token)) return;
    tokens.push(token);
  };
  pushToken(readToken(node.code));
  pushToken(readToken(node.syscall));
  pushToken(readToken(node.errno));
  if (message) tokens.push(message);
  return tokens.join(' ');
}

/** 原始类型 cause（`throw 'boom'` / `throw 42` 等）没有 `.cause` 可续，视为叶子节点。 */
function isPrimitiveCause(value: unknown): value is string | number | boolean | bigint {
  return typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint';
}

/**
 * 收集 `.cause` 链上的错误节点（对象与原始类型都收；`seen` 防环，`maxDepth` 限深）。
 * 原始类型 cause 无法继续下钻，作为叶子节点收进 `message`（`code` 留空）后终止遍历。
 */
export function collectErrorChain(
  error: unknown,
  options: { maxDepth?: number } = {},
): ErrorCauseLike[] {
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const chain: ErrorCauseLike[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && chain.length < maxDepth) {
    if (isPrimitiveCause(current)) {
      chain.push({ message: String(current) });
      break;
    }
    if (typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);
    chain.push(current as ErrorCauseLike);
    current = (current as ErrorCauseLike).cause;
  }
  return chain;
}

/**
 * 把 `.cause` 链格式化成一行取证文本，例如：
 * `fetch failed (cause: ECONNRESET connection reset by peer)`。
 * 无 cause 时等价于单层 message；提取不到任何有用信息时返回空串。
 */
export function formatErrorCause(
  error: unknown,
  options: { maxDepth?: number } = {},
): string {
  if (error === null || error === undefined) return '';
  const chain = collectErrorChain(error, options);
  if (chain.length === 0) {
    return String(error).trim();
  }

  const descriptors: string[] = [];
  for (const node of chain) {
    const descriptor = describeErrorCauseNode(node);
    if (descriptor) descriptors.push(descriptor);
  }
  if (descriptors.length === 0) return '';

  // 由最深层往外拼：`outer (cause: inner (cause: root))`。
  let formatted = descriptors[descriptors.length - 1] as string;
  for (let index = descriptors.length - 2; index >= 0; index -= 1) {
    formatted = `${descriptors[index]} (cause: ${formatted})`;
  }
  return formatted;
}
