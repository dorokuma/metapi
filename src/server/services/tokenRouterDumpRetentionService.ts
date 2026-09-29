import { openSync, closeSync, readdirSync, rmSync, statSync, ftruncateSync, writeSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOKEN_ROUTER_DUMP_PREFIX = 'metapi-token-router-';
const FLOCK_BIN = '/usr/bin/flock';

export interface TokenRouterDumpRetentionOptions {
  rootDir?: string;
  prefix?: string;
  ttlMinutes?: number;
  maxCount?: number;
}

export interface TokenRouterDumpRetentionDeps {
  statSync?: typeof import('node:fs').statSync;
  rmSync?: typeof import('node:fs').rmSync;
  lockPath?: string;
  now?: () => number;
}

export interface TokenRouterDumpRetentionResult {
  deletedExpired: number;
  deletedExcess: number;
  remaining: number;
}

function isTokenRouterDumpDirectory(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && name.length > prefix.length;
}

function getDirectoryStats(
  dirPath: string,
  statImpl: typeof import('node:fs').statSync,
): { path: string; mtimeMs: number } | null {
  try {
    const stats = statImpl(dirPath);
    if (!stats.isDirectory()) return null;
    return { path: dirPath, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

function getLockPath(options: TokenRouterDumpRetentionOptions, deps: TokenRouterDumpRetentionDeps): string {
  return deps.lockPath ?? join(options.rootDir ?? tmpdir(), '.metapi-token-router-dump-retention.lock');
}

/**
 * Acquires an exclusive kernel lock via flock(2) on the given lockPath.
 *
 * Behavior contract:
 * - flock(2) associates the lock with the open file description; the parent
 *   fd is the mutex. Child processes spawned by spawnSync share the same
 *   open file description and therefore the same lock.
 * - A conflicting non-blocking request from another live process fails.
 * - When all descriptors referring to the open file description are closed
 *   (e.g. process crash), the kernel releases the lock immediately, so a
 *   crashed holder does not block subsequent acquisitions.
 * - Non-Linux / no flock binary: warns and returns null (cleanup skipped).
 *
 * The lock fd is held for the entire cleanup section and released in the
 * caller's finally block via closeSync(fd). Lock file is never unlinked
 * (avoids split-inode races and stale-pid timeout guessing).
 */
function acquireCleanupLock(lockPath: string, now: () => number): { fd: number } | null {
  let fd: number;

  // Open (or create) the lock file. 'a+' gives read/write, creates if missing.
  try {
    fd = openSync(lockPath, 'a+');
  } catch (error) {
    console.warn(
      '[token-router-dump-retention] failed to open lock file; skipping cleanup',
      error,
    );
    return null;
  }

  // Attempt exclusive non-blocking kernel lock via flock(2).
  // spawnSync inherits the parent's open file description (and therefore
  // the same lock) through stdio[3]=fd.
  const flockResult = spawnSync(FLOCK_BIN, ['-x', '-n', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd],
    encoding: 'utf8',
  });

  if (flockResult.error) {
    // flock binary missing or other spawn error → fail-closed
    console.warn(
      '[token-router-dump-retention] flock executable error; skipping cleanup',
      flockResult.error,
    );
    closeSync(fd);
    return null;
  }

  if (flockResult.status !== 0) {
    // Another process holds the lock → warn and skip (do NOT fall back to CAS)
    console.warn(
      '[token-router-dump-retention] cleanup lock held by another process; skipping',
    );
    closeSync(fd);
    return null;
  }

  // Post-lock consistency check: ensure the open file description we hold
  // still matches the on-disk inode. If an external actor replaced the lock
  // file between our open and flock, the inodes would diverge and we would
  // be guarding a stale inode. Fail-closed rather than retry.
  try {
    const fdIno = fstatSync(fd).ino;
    const pathIno = statSync(lockPath).ino;
    if (fdIno !== pathIno) {
      console.warn(
        '[token-router-dump-retention] lock file inode mismatch after acquire; skipping',
      );
      closeSync(fd);
      return null;
    }
  } catch (error) {
    console.warn(
      '[token-router-dump-retention] lock file stat failed after acquire; skipping',
      error,
    );
    closeSync(fd);
    return null;
  }

  // Truncate to avoid diagnostic content accumulation from previous runs,
  // then write current diagnostic content (pid + timestamp) for operators.
  // Content is for diagnostics only; acquisition is via fd, not content.
  try {
    ftruncateSync(fd, 0);
    const content = `${process.pid}\t${now()}\n`;
    writeSync(fd, content);
  } catch {
    // Write failure is non-fatal; the fd-based lock is already held.
  }

  return { fd };
}

export function retainTokenRouterDumps(
  options: TokenRouterDumpRetentionOptions = {},
  deps: TokenRouterDumpRetentionDeps = {},
): TokenRouterDumpRetentionResult {
  const lockPath = getLockPath(options, deps);
  const nowImpl = deps.now ?? (() => Date.now());
  const statImpl = deps.statSync ?? statSync;
  const rmImpl = deps.rmSync ?? rmSync;

  const lockState = acquireCleanupLock(lockPath, nowImpl);
  if (lockState === null) {
    return { deletedExpired: 0, deletedExcess: 0, remaining: 0 };
  }

  try {
    const prefix = options.prefix ?? TOKEN_ROUTER_DUMP_PREFIX;
    const ttlMinutes = Math.max(0, options.ttlMinutes ?? 60);
    const maxCount = Math.max(0, options.maxCount ?? 10);

    const tempDir = options.rootDir ?? tmpdir();
    let entries: string[] = [];
    try {
      entries = readdirSync(tempDir);
    } catch {
      return { deletedExpired: 0, deletedExcess: 0, remaining: 0 };
    }

    const dumpDirs = entries
      .filter((name) => isTokenRouterDumpDirectory(name, prefix))
      .map((name) => join(tempDir, name))
      .map((dirPath) => getDirectoryStats(dirPath, statImpl))
      .filter((stats): stats is { path: string; mtimeMs: number } => stats !== null)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);

    const nowMs = Date.now();
    const ttlMs = ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : 0;

    let deletedExpired = 0;
    let deletedExcess = 0;

    for (const stats of dumpDirs) {
      if (
        dumpDirs.length - deletedExpired - deletedExcess <= maxCount &&
        stats.mtimeMs > nowMs - ttlMs
      ) {
        continue;
      }

      try {
        rmImpl(stats.path, { recursive: true, force: true });
        if (stats.mtimeMs <= nowMs - ttlMs) {
          deletedExpired += 1;
        } else {
          deletedExcess += 1;
        }
      } catch (error) {
        console.warn(
          '[token-router-dump-retention] failed to remove directory',
          stats.path,
          error,
        );
      }
    }

    return {
      deletedExpired,
      deletedExcess,
      remaining: dumpDirs.length - deletedExpired - deletedExcess,
    };
  } finally {
    // Release kernel lock by closing fd. Never unlink — avoids split-inode races.
    try {
      closeSync(lockState.fd);
    } catch {
      // fd already closed; lock already released.
    }
  }
}
