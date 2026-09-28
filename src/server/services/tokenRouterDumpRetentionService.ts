import { openSync, closeSync, unlinkSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const TOKEN_ROUTER_DUMP_PREFIX = 'metapi-token-router-';
const CLEANUP_LOCK_PATH = join(tmpdir(), '.metapi-token-router-dump-retention.lock');

export interface TokenRouterDumpRetentionOptions {
  prefix?: string;
  ttlMinutes?: number;
  maxCount?: number;
}

export interface TokenRouterDumpRetentionDeps {
  statSync?: typeof import('node:fs').statSync;
  rmSync?: typeof import('node:fs').rmSync;
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
  } catch (error) {
    return null;
  }
}

function acquireCleanupLock(): number | null {
  try {
    return openSync(CLEANUP_LOCK_PATH, 'wx');
  } catch {
    return null;
  }
}

function releaseCleanupLock(fd: number | null): void {
  if (fd == null) return;
  try { closeSync(fd); } catch {}
  try { unlinkSync(CLEANUP_LOCK_PATH); } catch {}
}

export function retainTokenRouterDumps(
  options: TokenRouterDumpRetentionOptions = {},
  deps: TokenRouterDumpRetentionDeps = {},
): TokenRouterDumpRetentionResult {
  const lockFd = acquireCleanupLock();
  if (lockFd === null) {
    return { deletedExpired: 0, deletedExcess: 0, remaining: 0 };
  }

  try {
    const prefix = options.prefix ?? TOKEN_ROUTER_DUMP_PREFIX;
    const ttlMinutes = Math.max(0, options.ttlMinutes ?? 60);
    const maxCount = Math.max(0, options.maxCount ?? 10);
    const statImpl = deps.statSync ?? statSync;
  const rmImpl = deps.rmSync ?? rmSync;

    const tempDir = tmpdir();
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
      if (dumpDirs.length - deletedExpired - deletedExcess <= maxCount && stats.mtimeMs > nowMs - ttlMs) {
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
        console.warn('[token-router-dump-retention] failed to remove directory', stats.path, error);
      }
    }

    return {
      deletedExpired,
      deletedExcess,
      remaining: dumpDirs.length - deletedExpired - deletedExcess,
    };
  } finally {
    releaseCleanupLock(lockFd);
  }
}
