import { describe, expect, it } from 'vitest';
import { formatErrorCause } from './errorChain.js';

describe('errorChain', () => {
  it('returns the message itself when there is no cause', () => {
    expect(formatErrorCause(new Error('upstream returned 500'))).toBe('upstream returned 500');
  });

  it('appends the `.cause` chain with code / syscall tokens', () => {
    const cause = Object.assign(new Error('connection reset by peer'), {
      code: 'ECONNRESET',
      syscall: 'read',
    });
    const error = new TypeError('fetch failed', { cause });

    expect(formatErrorCause(error)).toBe('fetch failed (cause: ECONNRESET read connection reset by peer)');
  });

  it('keeps a circular `.cause` chain finite', () => {
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a;

    expect(formatErrorCause(a)).toBe('a (cause: b)');
  });

  it('stops at the default depth limit', () => {
    const levels = Array.from({ length: 10 }, (_, index) => new Error(`depth-${index + 1}`));
    for (let index = 0; index < levels.length - 1; index += 1) {
      (levels[index] as Error).cause = levels[index + 1];
    }

    const formatted = formatErrorCause(levels[0]);
    expect(formatted).toContain('depth-8');
    expect(formatted).not.toContain('depth-9');
    expect(formatted).not.toContain('depth-10');
  });

  it('keeps a primitive `.cause` as a leaf node', () => {
    expect(formatErrorCause(new Error('outer', { cause: 'socket hang up' })))
      .toBe('outer (cause: socket hang up)');
  });

  it('formats a chain nested more than three levels deep', () => {
    const root = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const middle = Object.assign(new Error('request failed'), { cause: root, syscall: 'connect' });

    expect(formatErrorCause(new Error('fetch failed', { cause: middle })))
      .toBe('fetch failed (cause: connect request failed (cause: ECONNRESET socket hang up))');
  });
});
