import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { retainTokenRouterDumps, TokenRouterDumpRetentionDeps } from './tokenRouterDumpRetentionService.js';

const PREFIX = 'metapi-token-router-selection-';

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

describe('tokenRouterDumpRetentionService', () => {
  let createdDirs: string[] = [];

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

  beforeEach(() => {
    createdDirs = [];
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

  it('skips cleanup when another process holds the lock', () => {
    const root = ensurePrivateRoot();
    const dir = createDumpDir(root);
    const beforeCount = countMatchingDirs(root);

    // Pre-create the lock file to simulate another holder.
    const lockPath = join(root, '.metapi-token-router-dump-retention.lock');
    try {
      rmSync(lockPath, { force: true });
    } catch { /* ignore */ }
    try {
      require('node:fs').writeFileSync(lockPath, '');
    } catch { /* ignore */ }

    const result = retainTokenRouterDumps({
      prefix: PREFIX,
      rootDir: root,
      ttlMinutes: 0,
      maxCount: 10,
    });

    try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }

    const afterCount = countMatchingDirs(root);
    expect(afterCount).toBe(beforeCount);
    expect(result.deletedExpired).toBe(0);
    expect(result.deletedExcess).toBe(0);
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
});
