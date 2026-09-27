/**
 * 测试用「延迟首字节」响应替身。
 *
 * 调用方（first-byte 超时路径）拿到首块后会 cancel 这个 body。因此本替身必须
 * 感知 cancel：在 cancel 时清掉待触发的定时器，并吞掉迟到的 controller 写入。
 * 否则定时器回调会对已关闭的 controller 调 enqueue()，抛出
 * `ERR_INVALID_STATE: Controller is already closed` 的无主异常——它不归属任何
 * 断言，往往在测试环境 teardown 之后才冒出来，把整轮并行跑变成 flaky。
 */
export function buildDelayedResponse(
  bodyText: string,
  delayMs: number,
  options: {
    status?: number;
    signal?: AbortSignal;
    contentType?: string;
  } = {},
): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingWrite = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        timer = null;
        if (options.signal?.aborted) return;
        try {
          controller.enqueue(encoder.encode(bodyText));
          controller.close();
        } catch {
          // body 已被 cancel（first-byte 超时路径），迟到的写入按无操作处理。
        }
      }, delayMs);
      options.signal?.addEventListener('abort', clearPendingWrite, { once: true });
    },
    cancel: clearPendingWrite,
  });

  return new Response(body, {
    status: options.status ?? 200,
    headers: { 'content-type': options.contentType ?? 'application/json' },
  });
}
