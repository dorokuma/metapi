/** 清理路径等待 reader.cancel() settle 的上限（毫秒）。 */
const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 250;

/**
 * 尽力取消一个 reader，并保证等待有界。
 *
 * `reader.cancel()` 的 promise 不保证会 settle：最典型的是 body 来自 `tee()` 的分支时，
 * 规范要求两个分支都取消后源流的 cancel 才 resolve——只取消一个分支会永远挂住。
 * 清理路径若无限等待，就会把「返回合成响应」的调用方一起挂死；因此这里给等待设上限，
 * 并吞掉取消最终失败或迟到的 rejection（避免无主 rejection 冒到事件循环上）。
 */
export async function settleReaderCancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array> | null | undefined,
  reason?: unknown,
  timeoutMs: number = DEFAULT_CANCEL_SETTLE_TIMEOUT_MS,
): Promise<void> {
  if (!reader) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      reader.cancel(reason).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } catch {
    // 取消失败按无操作处理：这里是清理路径，不应改变调用方的返回结果。
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
