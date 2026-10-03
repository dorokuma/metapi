import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { retainTokenRouterDumps, TokenRouterDumpRetentionDeps } from './tokenRouterDumpRetentionService.js';

const PREFIX = 'metapi-token-router-selection-';

// Test-only seam used to reproduce the *non-contention* `flock` failure class.
//
// The service always invokes flock in fd mode (`flock -x -n 3` with the lock fd
// handed over as stdio[3]); in that mode an real environment error (bad fd,
// unusable lock file, unsupported filesystem, ...) cannot be provoked from a
// test, because the fd is opened by the service itself and is always valid.
// Measured behaviour of util-linux 2.41 flock (see the note on the service):
//   * genuine contention            -> exit 1, stderr empty
//   * any other failure             -> exit >= 64, stderr non-empty
// The stub below therefore only fabricates the second shape, i.e. the exact
// spawnSync result the service must classify differently.
const flockFailureStub = vi.hoisted(() => ({
  result: null as { status: number | null; stderr: string } | null,
  /** How often the stub actually replaced a real spawnSync result. */
  hits: 0,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: ((command: string, args?: readonly string[], options?: unknown) => {
      const stub = flockFailureStub.result;
      if (stub !== null && command === '/usr/bin/flock' && Array.isArray(args) && args.includes('-n')) {
        flockFailureStub.hits += 1;
        return { status: stub.status, signal: null, stdout: '', stderr: stub.stderr, pid: 0 };
      }
      return (actual.spawnSync as (...a: unknown[]) => unknown)(command, args, options);
    }) as typeof actual.spawnSync,
  };
});

// Each test run gets its own private root directory so parallel test files
// that also touch tmpdir() cannot race and delete our dump directories
// before retainTokenRouterDumps processes them.
let privateRoot: string;

function ensurePrivateRoot(): string {
  if (!privateRoot || !require('node:fs').existsSync(privateRoot)) {
    privateRoot = mkdtempSync(join(tmpdir(), 'metapi-token-router-dump-retention-root-'));
  }
  return privateRoot;
}

function getLockPath(): string {
  return join(ensurePrivateRoot(), '.metapi-token-router-dump-retention.lock');
}

const FLOCK_BIN = '/usr/bin/flock';

/** A detached `flock` process used as an external lock holder. */
type LockHolder = ReturnType<typeof spawn>;

/**
 * Spawns a detached `flock` holder on `lockPath`.
 *
 * `/usr/bin/flock` forks the command it is given and both processes inherit the
 * same open file description (fd 3), so a flock(2) lock — which belongs to the
 * file description, not to an individual fd — is released only once the *last*
 * fd on that description is closed, i.e. after the forked command (`sleep`) has
 * exited as well. Always kill holders via `killLockHolder` so the whole process
 * group is taken down.
 */
function spawnLockHolder(lockPath: string): LockHolder {
  const child = spawn(FLOCK_BIN, ['-x', lockPath, '-c', 'echo LOCKED; sleep 1000'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) {
    throw new Error('spawn flock child failed');
  }
  return child;
}

/**
 * Resolves once the holder signalled that it owns the lock (up to ~5s), so the
 * caller never has to poll for the lock to be in place.
 */
async function waitForLockAcquisition(child: LockHolder): Promise<void> {
  let ready = false;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('LOCKED')) {
        ready = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  if (!ready) {
    killLockHolder(child);
    throw new Error('flock child did not acquire lock within 5s');
  }
}

/** SIGKILLs the holder's whole process group (`flock` plus the command it forked). */
function killLockHolder(child: LockHolder): void {
  if (!child.pid) return;
  // Once the direct child has been reaped its pid (hence its process group id)
  // can be recycled by an unrelated group: signalling -pid then would kill
  // innocent processes. Nothing to release either — a dead holder implies the
  // group kill already ran (or the group is empty).
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Bounded wait. A timeout throws loudly — a wait gate must never fail silently. */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * True when an exclusive flock on `lockPath` can be taken right now.
 *
 * Uses the same kernel primitive as the service but only probes it: nothing is
 * enumerated or deleted, so it is safe to call from a wait loop. Probe failures
 * report "not free" so a broken environment fails the bound instead of hanging.
 */
function isLockFree(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'a+');
  } catch {
    return false;
  }
  try {
    const probe = spawnSync(FLOCK_BIN, ['-x', '-n', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      encoding: 'utf8',
    });
    return !probe.error && probe.status === 0;
  } finally {
    closeSync(fd);
  }
}

describe('tokenRouterDumpRetentionService', () => {
  let createdDirs: string[] = [];
  let lockHolders: LockHolder[] = [];

  function countMatchingDirs(root: string): number {
    let count = 0;
    try {
      const entries = require('node:fs').readdirSync(root);
      for (const name of entries) {
        if (name.startsWith(PREFIX) && name.length > PREFIX.length) {
          count += 1;
        }
      }
    } catch {
      // ignore
    }
    return count;
  }

  function createDumpDir(root: string): string {
    const dir = mkdtempSync(join(root, PREFIX));
    createdDirs.push(dir);
    return dir;
  }

  function baseDeps(): TokenRouterDumpRetentionDeps {
    return { lockPath: getLockPath() };
  }

  beforeEach(() => {
    createdDirs = [];
    // Belt-and-braces: an armed stub must never leak into another test.
    flockFailureStub.result = null;
    // Reap lock holders left behind by an earlier (possibly failed) test: a
    // surviving `sleep` still owns an fd on the lock file's file description,
    // which would keep the flock alive into the next test's window.
    for (const holder of lockHolders) killLockHolder(holder);
    lockHolders = [];
    const root = ensurePrivateRoot();
    // Clean up any leftover dump dirs in our private root from previous tests.
    try {
      const entries = require('node:fs').readdirSync(root);
      for (const name of entries) {
        if (name.startsWith(PREFIX) && name.length > PREFIX.length) {
          try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    try { rmSync(getLockPath(), { force: true }); } catch { /* ignore */ }
  });

  afterAll(() => {
    for (const holder of lockHolders) killLockHolder(holder);
    lockHolders = [];
    for (const dir of createdDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    createdDirs = [];
    try { rmSync(getLockPath(), { force: true }); } catch { /* ignore */ }
    // Clean up the private root used for retainTokenRouterDumps calls.
    if (privateRoot) {
      try { rmSync(privateRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      privateRoot = '';
    }
  });

  it('does not delete matching dirs when under maxCount and within TTL', () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    const beforeCount = countMatchingDirs(root);

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 60,
      maxCount: 10,
    });

    const afterCount = countMatchingDirs(root);
    expect(afterCount).toBe(beforeCount);
    expect(result.deletedExpired).toBe(0);
    expect(result.deletedExcess).toBe(0);
  });

  it('deletes expired directories when TTL is 0', () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    // Age the directory so the mtime is unambiguously in the past,
    // eliminating the clock-tick race where mkdtemp + retain can fall
    // within the same millisecond and mtimeMs > nowMs on fast CI.
    try {
      utimesSync(dir, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    } catch { /* ignore on platforms where utimes is restricted */ }
    const beforeCount = countMatchingDirs(root);

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 0,
      maxCount: 10,
    });

    const afterCount = countMatchingDirs(root);
    expect(afterCount).toBeLessThan(beforeCount);
    expect(result.deletedExpired).toBeGreaterThanOrEqual(1);
  });

  it('deletes oldest directories when over maxCount (FIFO)', () => {
    const root = ensurePrivateRoot();
    const oldest = createDumpDir(root);
    const middle = createDumpDir(root);
    const newest = createDumpDir(root);

    // Ensure distinct mtimes so FIFO order is deterministic.
    const now = Date.now();
    try {
      const fs = require('node:fs');
      fs.utimesSync(oldest, new Date(now - 2000), new Date(now - 2000));
      fs.utimesSync(middle, new Date(now - 1000), new Date(now - 1000));
      fs.utimesSync(newest, new Date(now), new Date(now));
    } catch { /* ignore on platforms where utimes is restricted */ }

    const beforeCount = countMatchingDirs(root);

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 1440,
      maxCount: 2,
    });

    const afterCount = countMatchingDirs(root);
    expect(afterCount).toBeLessThan(beforeCount);
    expect(afterCount).toBeLessThanOrEqual(2);
    expect(result.deletedExcess).toBeGreaterThanOrEqual(1);

    // FIFO: the oldest created dir should be gone; the newest should remain.
    expect(require('node:fs').existsSync(oldest)).toBe(false);
    expect(require('node:fs').existsSync(newest)).toBe(true);
  });

  it('ignores directories that do not match the prefix', () => {
    const root = ensurePrivateRoot();
    const otherDir = mkdtempSync(join(root, 'metapi-other-'));

    const beforeOtherCount = countMatchingDirs(root);
    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 1440,
      maxCount: 10,
    });
    const afterOtherCount = countMatchingDirs(root);

    try { rmSync(otherDir, { recursive: true, force: true }); } catch { /* ignore */ }

    expect(afterOtherCount).toBe(beforeOtherCount);
    expect(result.deletedExpired).toBe(0);
    expect(result.deletedExcess).toBe(0);
  });

  it('is fault-tolerant when stat fails on a matching entry', () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    const targetName = basename(dir);
    const originalStatSync = statSync;

    const mockStatSync: typeof statSync = ((...args: Parameters<typeof statSync>) => {
      const path = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (path.includes(targetName)) {
        throw new Error('mock stat failure');
      }
      return originalStatSync(...args);
    }) as typeof statSync;

    const deps: TokenRouterDumpRetentionDeps = { statSync: mockStatSync };

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 1440,
      maxCount: 10,
    }, deps);

    expect(result.deletedExpired).toBe(0);
    expect(result.deletedExcess).toBe(0);
  });

  it('warns and skips cleanup when another process holds an exclusive lock', async () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    const beforeCount = countMatchingDirs(root);
    const lockPath = getLockPath();

    // Spawn a detached child that holds an exclusive flock on lockPath.
    // The child echoes LOCKED once it has acquired the lock, so we can
    // deterministically wait for that marker instead of polling pkill.
    const child = spawnLockHolder(lockPath);
    lockHolders.push(child);
    await waitForLockAcquisition(child);

    const originalWarn = console.warn;
    const warnSpy = vi.fn((...args: unknown[]) => originalWarn(...args));
    (console as { warn: typeof warnSpy }).warn = warnSpy;

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 0,
      maxCount: 10,
    });

    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    expect(warnSpy.mock.calls.some((args) =>
      typeof args[0] === 'string' && args[0].includes('token-router-dump-retention'),
    )).toBe(true);
    // Genuine contention keeps the original, well-established wording...
    expect(warnSpy.mock.calls.some((args) =>
      typeof args[0] === 'string' && args[0].includes('cleanup lock held by another process; skipping'),
    )).toBe(true);
    // ...and must never be reported as an environment/flock error.
    expect(warnSpy.mock.calls.some((args) =>
      typeof args[0] === 'string' && args[0].includes('not lock contention'),
    )).toBe(false);

    (console as { warn: typeof originalWarn }).warn = originalWarn;

    const afterCount = countMatchingDirs(root);
    expect(afterCount).toBe(beforeCount);
    expect(result.deletedExpired).toBe(0);
    expect(result.deletedExcess).toBe(0);

    // Cleanup: kill child and remove lock file
    killLockHolder(child);
    try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  });

  it('reports a non-contention flock failure with its stderr instead of blaming lock contention', () => {
    const root = ensurePrivateRoot();
    const beforeCount = countMatchingDirs(root);

    const originalWarn = console.warn;
    const warns: string[] = [];
    const warnSpy = vi.fn((...args: unknown[]) => { warns.push(args.map((a) => String(a)).join(' ')); });
    (console as { warn: typeof warnSpy }).warn = warnSpy;

    function retentionWarns(): string[] {
      return warns.filter((message) => message.includes('token-router-dump-retention'));
    }

    try {
      // (a) environment error: flock could not even test the lock
      flockFailureStub.result = { status: 65, stderr: 'flock: 3: Bad file descriptor\nnoise second line\n' };
      flockFailureStub.hits = 0;

      const result = retainTokenRouterDumps({
        prefix: PREFIX,
        rootDir: root,
        ttlMinutes: 0,
        maxCount: 10,
      });

      // Self-check: the stub must really have intercepted the flock call. If the
      // call shape ever drifts (e.g. `-n` becoming `-xn`), the stub would stop
      // matching, the service would reach the real binary, this test would keep
      // passing without covering the branch — so assert the hit count instead.
      expect(flockFailureStub.hits).toBe(1);

      // fail-closed: exact same "skip this cleanup pass" contract as a real conflict
      expect(result).toEqual({ deletedExpired: 0, deletedExcess: 0, remaining: 0 });
      expect(countMatchingDirs(root)).toBe(beforeCount);

      const messages = retentionWarns();
      expect(messages).toHaveLength(1);
      // different wording, carrying the stderr excerpt for the operator
      expect(messages[0]).toContain('not lock contention');
      expect(messages[0]).toContain('Bad file descriptor');
      expect(messages[0]).not.toContain('held by another process');
      // only the first stderr line is surfaced
      expect(messages[0]).not.toContain('noise second line');

      // (b) a pathologically long stderr line is truncated
      warns.length = 0;
      flockFailureStub.result = { status: 64, stderr: `flock: ${'x'.repeat(500)}\n` };
      flockFailureStub.hits = 0;
      retainTokenRouterDumps({
        prefix: PREFIX,
        rootDir: root,
        ttlMinutes: 0,
        maxCount: 10,
      });

      expect(flockFailureStub.hits).toBe(1);

      const longMessages = retentionWarns();
      expect(longMessages).toHaveLength(1);
      expect(longMessages[0]).toContain('not lock contention');
      expect(longMessages[0]).not.toContain('x'.repeat(200));
      expect(longMessages[0].length).toBeLessThan(400);
    } finally {
      flockFailureStub.result = null;
      (console as { warn: typeof originalWarn }).warn = originalWarn;
    }
  });

  it('falls back to tmpdir lock when rootDir is not provided', () => {
    const uniquePrefix = `metapi-token-router-default-fallback-${process.pid}-${Date.now()}-`;
    const dir = mkdtempSync(join(tmpdir(), uniquePrefix));
    // Age the directory so the mtime is unambiguously in the past,
    // eliminating the clock-tick race where mkdtemp + retain can fall
    // within the same millisecond and mtimeMs > nowMs on fast CI.
    try {
      utimesSync(dir, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    } catch { /* ignore on platforms where utimes is restricted */ }
    try {
      const result = retainTokenRouterDumps({
        prefix: uniquePrefix,
        ttlMinutes: 0,
        maxCount: 10,
      });

      expect(require('node:fs').existsSync(dir)).toBe(false);
      expect(result.deletedExpired).toBeGreaterThanOrEqual(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('warns on rmSync failure without breaking the main flow', () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    // Age the directory so the mtime is unambiguously in the past,
    // eliminating the clock-tick race where mkdtemp + retain can fall
    // within the same millisecond and mtimeMs > nowMs on fast CI.
    try {
      utimesSync(dir, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    } catch { /* ignore on platforms where utimes is restricted */ }
    const beforeCount = countMatchingDirs(root);

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockRmSync = vi.fn((...args: Parameters<typeof rmSync>) => {
      const path = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (path === dir) {
        throw new Error('mock rmSync failure');
      }
      return rmSync(...args);
    });

    const deps: TokenRouterDumpRetentionDeps = { rmSync: mockRmSync };

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 0,
      maxCount: 10,
    }, deps);

    const warned = consoleWarnSpy.mock.calls.some((args) =>
      typeof args[0] === 'string' && args[0].includes('token-router-dump-retention'),
    );

    consoleWarnSpy.mockRestore();

    expect(result.deletedExpired).toBeGreaterThanOrEqual(0);
    expect(result.deletedExcess).toBeGreaterThanOrEqual(0);
    expect(warned).toBe(true);
  });

  it('writes pid and timestamp into the lock file during cleanup', () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    const lockPath = getLockPath();

    const fixedNow = 1234567890;
    let lockFileContent = '';
    const mockRmSync = vi.fn((...args: Parameters<typeof rmSync>) => {
      const path = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (path === lockPath) {
        // Ignore attempts to remove the lock path during cleanup.
        return;
      }
      // Capture lock file content during the first removal attempt.
      try {
        lockFileContent = require('node:fs').readFileSync(lockPath, 'utf8');
      } catch { /* ignore */ }
      return rmSync(...args);
    });

    const deps: TokenRouterDumpRetentionDeps = {
      ...baseDeps(),
      now: () => fixedNow,
      rmSync: mockRmSync,
    };

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 0,
      maxCount: 10,
    }, deps);

    expect(result.deletedExpired).toBeGreaterThanOrEqual(1);
    expect(lockFileContent).toBe(`${process.pid}\t${fixedNow}\n`);
  });

  it('recovers immediately after lock holder is SIGKILLd', { timeout: 30_000 }, async () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    const lockPath = getLockPath();

    // Spawn a detached child that holds an exclusive flock on lockPath.
    // The child echoes LOCKED once it has acquired the lock.
    const child = spawnLockHolder(lockPath);
    lockHolders.push(child);
    await waitForLockAcquisition(child);

    // First call should skip (lock held)
    const blockedResult = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 0,
      maxCount: 10,
    });
    expect(blockedResult.deletedExpired).toBe(0);

    // SIGKILL the holder's whole process group, then wait until the kernel has
    // really released the lock before asserting recovery.
    //
    // Why the direct child's 'exit' event is not enough (root cause of the CI
    // flake in run 37098506495, test file unchanged since 8e127dae):
    // /usr/bin/flock forks the command it was given (`sh -c 'echo LOCKED; sleep
    // 1000'`, dash execs the trailing `sleep`), and *both* processes inherit the
    // same open file description (fd 3, verified via /proc/<pid>/fd and lsof).
    // flock(2) attaches the lock to the file description, so the kernel drops it
    // only when the last fd on that description is closed — i.e. after `sleep`
    // has exited too, not when the `flock` process itself is reaped. The two
    // deaths are not ordered against this process: on an idle machine the
    // forked command's fd is released ~1-2ms *before* 'exit' is observed (so the
    // old version passed by a hair), but under load the ordering flips. A repro
    // with 3x CPU oversubscription measured the release lagging 'exit' by
    // 50-135ms, and the second call — which needs ~2ms — then raced the
    // still-held lock and returned deletedExpired=0 together with the service's
    // "[token-router-dump-retention] cleanup lock held by another process" warn.
    //
    // The bounded wait below gates on the *kernel* state (lock is free), which is
    // the precondition this test needs; it is not a retry of the service call:
    // the service must still succeed on its very first attempt after the release,
    // and the gate throws (fails) if the lock is never released.
    killLockHolder(child);

    // Wait for the direct child to die (async once on 'exit', with ~5s fallback)
    const deathPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await deathPromise;

    await waitForCondition(
      () => isLockFree(lockPath),
      5_000,
      'the kernel to release the flock after the holder process group was SIGKILLd',
    );

    // Second call should succeed (lock released by kernel on child death)
    const recoveredResult = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 0,
      maxCount: 10,
    });

    expect(
      recoveredResult.deletedExpired,
      'the lock is free and the dump dir is expired, so the first call after the release must delete it '
        + '(if the service reported the lock as held again, see its [token-router-dump-retention] warning above)',
    ).toBeGreaterThanOrEqual(1);
    expect(require('node:fs').existsSync(dir)).toBe(false);

    // Cleanup
    try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    killLockHolder(child);
  });
});
