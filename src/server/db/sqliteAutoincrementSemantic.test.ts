import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SQLite AUTOINCREMENT 语义守护（切片 11 收口，G1）。
 *
 * 守护对象：随仓发布的 SQLite DDL（drizzle/*.sql，`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL）
 * 在「哨兵 id=-1」场景下的自增序列行为。这是 token-usage 投影（site_id=-1 哨兵行）在 SQLite 上
 * 可用的前提：哨兵插入不得抬高 sqlite_sequence，哨兵-only 库随后新建必须得到 id=1。
 *
 * 口径来源：/tmp/plan-token-stats-v19.md §16.2 R2（「SQLite 已核安全」）；
 * 本文件把该口径变成可执行断言，期望值以引物实测为准（better-sqlite3 :memory:，全量迁移后插入）。
 *
 * 归属 CI job：test-core（主测试 job，ci.yml:44，`run: npm test`，ci.yml:71-74）。
 * `npm test` = `vitest run --root .`（package.json），vitest.config.ts 仅额外排除 `.worktrees/**`，
 * 本文件匹配 vitest 默认的测试文件 include 模式且无环境门控，随主测试 job 无条件执行。
 *
 * 变异思路（哪些实现改动会让本套件变红，推理不跑变异）：
 * 1. DDL 去掉 AUTOINCREMENT（退化为裸 `INTEGER PRIMARY KEY` rowid 别名）：
 *    a) 空表哨兵场景，默认插入候选值 = MAX(rowid)+1 = -1+1 = 0 → 首条默认插入得到 id=0 而非 1，
 *       「id 恰为 1」断言变红；
 *    b) 裸 rowid 表永不产生 sqlite_sequence 行 → 「哨兵插入后 sqlite_sequence 恰为 0」断言
 *       （期望行存在且值为 0）变红（实际为 null/无行）。
 * 2. 任何让显式 -1 抬高序列的实现（例如哨兵写入前/后对 sqlite_sequence 做 +1 或写正值）：
 *    sites 空表场景 seq 变为 1 → 「seq 保持 0」断言变红；且首条默认插入得到 2 而非 1 → 双重变红。
 * 3. 反向退化（序列机制完全不更新 sqlite_sequence）：「不抬高」断言会空洞地通过——
 *    故第 4 个用例用「显式正 id 确实抬高 seq（1 → 10 → 下一个默认 11）」做对照，
 *    保证序列机制本身被真实守护，前三个用例的「保持」断言不空洞。
 */

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

type MigrationJournalEntry = {
  tag: string;
  when: number;
};

function readMigrationJournalEntries(): MigrationJournalEntry[] {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: MigrationJournalEntry[] };
  return journal.entries ?? [];
}

function applyMigrationSql(sqlite: Database.Database, sqlText: string) {
  const statements = sqlText
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    sqlite.exec(statement);
  }
}

/** 打开内存库并应用全量 drizzle 迁移（与 migrateCurrentDatabase 同源的发布 DDL）。 */
function buildMigratedSqlite(): Database.Database {
  const sqlite = new Database(':memory:');
  for (const entry of readMigrationJournalEntries()) {
    const sqlText = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
    applyMigrationSql(sqlite, sqlText);
  }
  return sqlite;
}

/** 读表当前 AUTOINCREMENT 序列值；sqlite_sequence 无该行时返回 null。 */
function readAutoincSeq(sqlite: Database.Database, table: string): number | null {
  const row = sqlite
    .prepare('SELECT seq FROM sqlite_sequence WHERE name = ?')
    .get(table) as { seq: number } | undefined;
  return row ? row.seq : null;
}

describe('sqlite AUTOINCREMENT sentinel semantics (slice 11 G1)', () => {
  it('sentinel-only sites: explicit id=-1 does not raise sqlite_sequence; first default insert gets id=1 exactly', () => {
    const sqlite = buildMigratedSqlite();
    try {
      // 空表基线：sites 在 sqlite_sequence 中无行（空 AUTOINCREMENT 表的序列等效值为 0）。
      expect(readAutoincSeq(sqlite, 'sites')).toBeNull();

      // F12 哨兵插入：显式 id=-1。
      sqlite
        .prepare('INSERT INTO sites (id, name, url, platform) VALUES (?, ?, ?, ?)')
        .run(-1, 'sentinel', 'null', 'reserved-unattributed');

      // 显式 -1 原样保留（SQLite 不改写负 rowid，哨兵设计依赖此点）。
      expect(sqlite.prepare('SELECT id FROM sites WHERE name = ?').get('sentinel')).toMatchObject({
        id: -1,
      });

      // 核心断言（G1a）：哨兵插入不抬高序列。行由哨兵插入创建，SQLite 把序列值钳到恰好 0
      // （不会记 -1，也不会抬高到 1）——空表「插入前状态」的等效序列值就是 0。
      expect(readAutoincSeq(sqlite, 'sites')).toBe(0);

      // 核心断言（G1b）：空表哨兵场景，第一条默认插入（不带 id）得到 id=1，恰好是 1。
      // 为何恰是 1：AUTOINCREMENT 候选值 = max(表内最大 rowid, sqlite_sequence) + 1
      // = max(-1, 0) + 1 = 1；哨兵 -1 低于序列下限 0，不参与抬高，故新站从 1 起而非 0 或 2。
      const first = sqlite
        .prepare('INSERT INTO sites (name, url, platform) VALUES (?, ?, ?)')
        .run('site-a', 'https://site-a.example', 'custom');
      expect(first.lastInsertRowid).toBe(1);

      // 序列随后正常前进（未被 -1 钉住，也没有跳到 2）。
      const second = sqlite
        .prepare('INSERT INTO sites (name, url, platform) VALUES (?, ?, ?)')
        .run('site-b', 'https://site-b.example', 'custom');
      expect(second.lastInsertRowid).toBe(2);
      expect(readAutoincSeq(sqlite, 'sites')).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it('explicit id=-1 does not raise sqlite_sequence on a non-empty sites table', () => {
    const sqlite = buildMigratedSqlite();
    try {
      const insertDefault = sqlite.prepare('INSERT INTO sites (name, url, platform) VALUES (?, ?, ?)');
      insertDefault.run('site-a', 'https://site-a.example', 'custom');
      insertDefault.run('site-b', 'https://site-b.example', 'custom');
      expect(readAutoincSeq(sqlite, 'sites')).toBe(2);

      // 非空表补插哨兵：序列保持 2（-1 < 2，不抬高也不回退）。
      sqlite
        .prepare('INSERT INTO sites (id, name, url, platform) VALUES (?, ?, ?, ?)')
        .run(-1, 'sentinel', 'null', 'reserved-unattributed');
      expect(readAutoincSeq(sqlite, 'sites')).toBe(2);

      const next = insertDefault.run('site-c', 'https://site-c.example', 'custom');
      expect(next.lastInsertRowid).toBe(3);
    } finally {
      sqlite.close();
    }
  });

  it('same-shape token-usage table site_day_usage: sentinel -1 does not raise seq, first default insert gets id=1 exactly', () => {
    const sqlite = buildMigratedSqlite();
    try {
      // 基线状态：0024_projection_leases.sql 的重建迁移（INSERT ... SELECT）在全新库上执行后
      // 已为 site_day_usage 预建 sqlite_sequence 行，seq=0。该断言钉住当前迁移侧效应。
      expect(readAutoincSeq(sqlite, 'site_day_usage')).toBe(0);

      // FK 要求 sites 哨兵行先存在。
      sqlite
        .prepare('INSERT INTO sites (id, name, url, platform) VALUES (?, ?, ?, ?)')
        .run(-1, 'sentinel', 'null', 'reserved-unattributed');
      sqlite
        .prepare('INSERT INTO site_day_usage (id, local_day, site_id) VALUES (?, ?, ?)')
        .run(-1, '2026-01-01', -1);

      // 哨兵不抬高既有 seq=0。
      expect(readAutoincSeq(sqlite, 'site_day_usage')).toBe(0);

      // 候选值 = max(-1, 0) + 1 = 1 → 恰好 1（与 sites 同一口径，覆盖 token-usage 聚合表）。
      const first = sqlite
        .prepare('INSERT INTO site_day_usage (local_day, site_id) VALUES (?, -1)')
        .run('2026-01-02');
      expect(first.lastInsertRowid).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('contrast: an explicit positive id DOES raise sqlite_sequence (no-raise assertions are not vacuous)', () => {
    const sqlite = buildMigratedSqlite();
    try {
      sqlite.prepare('INSERT INTO token_routes (model_pattern) VALUES (?)').run('m1');
      expect(readAutoincSeq(sqlite, 'token_routes')).toBe(1);

      // 显式正 id 参与抬高（序列机制真实工作），下一个默认 id 从其后续。
      sqlite.prepare('INSERT INTO token_routes (id, model_pattern) VALUES (10, ?)').run('big');
      expect(readAutoincSeq(sqlite, 'token_routes')).toBe(10);

      const next = sqlite.prepare('INSERT INTO token_routes (model_pattern) VALUES (?)').run('m2');
      expect(next.lastInsertRowid).toBe(11);
    } finally {
      sqlite.close();
    }
  });
});
