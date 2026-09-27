import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const analyticsProjectionCheckpoints = sqliteTable('analytics_projection_checkpoints', {
  projectorKey: text('projector_key').primaryKey(),
  timeZone: text('time_zone'),
  lastProxyLogId: integer('last_proxy_log_id'),
  watermarkCreatedAt: text('watermark_created_at'),
  recomputeFromId: integer('recompute_from_id'),
  recomputeRequestedAt: text('recompute_requested_at'),
  recomputeReason: text('recompute_reason'),
  recomputeStartedAt: text('recompute_started_at'),
  recomputeCompletedAt: text('recompute_completed_at'),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  lastProjectedAt: text('last_projected_at'),
  lastSuccessfulAt: text('last_successful_at'),
  lastError: text('last_error'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

const proxyLogs = sqliteTable('proxy_logs', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id'),
  createdAt: text('created_at'),
  status: text('status'),
  latencyMs: integer('latency_ms'),
  totalTokens: integer('total_tokens'),
  estimatedCost: real('estimated_cost'),
  modelActual: text('model_actual'),
  modelRequested: text('model_requested'),
});

const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey(),
  siteId: integer('site_id'),
});

const sites = sqliteTable('sites', {
  id: integer('id').primaryKey(),
  platform: text('platform'),
});

const siteDayUsage = sqliteTable('site_day_usage', {
  localDay: text('local_day'),
  siteId: integer('site_id'),
  totalCalls: integer('total_calls'),
  successCalls: integer('success_calls'),
  failedCalls: integer('failed_calls'),
  totalTokens: integer('total_tokens'),
  totalSummarySpend: real('total_summary_spend'),
  totalSiteSpend: real('total_site_spend'),
  totalLatencyMs: integer('total_latency_ms'),
  latencyCount: integer('latency_count'),
  updatedAt: text('updated_at'),
});

const siteHourUsage = sqliteTable('site_hour_usage', {
  bucketStartUtc: text('bucket_start_utc'),
  siteId: integer('site_id'),
  totalCalls: integer('total_calls'),
  successCalls: integer('success_calls'),
  failedCalls: integer('failed_calls'),
  totalTokens: integer('total_tokens'),
  totalSummarySpend: real('total_summary_spend'),
  totalSiteSpend: real('total_site_spend'),
  totalLatencyMs: integer('total_latency_ms'),
  latencyCount: integer('latency_count'),
  updatedAt: text('updated_at'),
});

const modelDayUsage = sqliteTable('model_day_usage', {
  localDay: text('local_day'),
  siteId: integer('site_id'),
  model: text('model'),
  totalCalls: integer('total_calls'),
  successCalls: integer('success_calls'),
  failedCalls: integer('failed_calls'),
  totalTokens: integer('total_tokens'),
  totalSpend: real('total_spend'),
  totalLatencyMs: integer('total_latency_ms'),
  latencyCount: integer('latency_count'),
  updatedAt: text('updated_at'),
});

const schema = {
  analyticsProjectionCheckpoints,
  proxyLogs,
  accounts,
  sites,
  siteDayUsage,
  siteHourUsage,
  modelDayUsage,
};

type MockState = {
  checkpoint: Record<string, unknown> | null;
  proxyRows: Array<Record<string, unknown>>;
  siteDayRows: Array<Record<string, unknown>>;
  siteHourRows: Array<Record<string, unknown>>;
  modelDayRows: Array<Record<string, unknown>>;
  onDuplicateKeyUpdateTables: string[];
  lastUpdateSetKeys: string[];
  zeroRowForNextNonLeaseUpdate: boolean;
  zeroRowEffect: 'delete-row' | 'takeover' | null;
  lastLeaseGuardSetValues: Record<string, unknown> | null;
};

const state: MockState = {
  checkpoint: null,
  proxyRows: [],
  siteDayRows: [],
  siteHourRows: [],
  modelDayRows: [],
  onDuplicateKeyUpdateTables: [],
  lastUpdateSetKeys: [],
  zeroRowForNextNonLeaseUpdate: false,
  zeroRowEffect: null,
  lastLeaseGuardSetValues: null,
};

function resetMockState() {
  state.checkpoint = null;
  state.proxyRows = [];
  state.siteDayRows = [];
  state.siteHourRows = [];
  state.modelDayRows = [];
  state.onDuplicateKeyUpdateTables = [];
  state.lastUpdateSetKeys = [];
  state.zeroRowForNextNonLeaseUpdate = false;
  state.zeroRowEffect = null;
  state.lastLeaseGuardSetValues = null;
}

function resolveTableName(table: unknown): string {
  if (table === analyticsProjectionCheckpoints) return 'analytics_projection_checkpoints';
  if (table === proxyLogs) return 'proxy_logs';
  if (table === siteDayUsage) return 'site_day_usage';
  if (table === siteHourUsage) return 'site_hour_usage';
  if (table === modelDayUsage) return 'model_day_usage';
  return 'unknown';
}

function applyInsert(
  table: unknown,
  values: Record<string, unknown> | Array<Record<string, unknown>>,
  onDuplicateSet: Record<string, unknown> | null,
) {
  if (table === analyticsProjectionCheckpoints) {
    if (!state.checkpoint) {
      state.checkpoint = { ...(values as Record<string, unknown>) };
      return;
    }
    if (onDuplicateSet) {
      state.checkpoint = { ...state.checkpoint, ...onDuplicateSet };
    }
    return;
  }

  if (table === siteDayUsage) {
    state.siteDayRows.push({ ...(values as Record<string, unknown>) });
    return;
  }

  if (table === siteHourUsage) {
    state.siteHourRows.push({ ...(values as Record<string, unknown>) });
    return;
  }

  if (table === modelDayUsage) {
    state.modelDayRows.push({ ...(values as Record<string, unknown>) });
  }
}

function makeInsertChain(table: unknown) {
  let values: Record<string, unknown> | Array<Record<string, unknown>> = {};
  let onDuplicateSet: Record<string, unknown> | null = null;

  const chain = {
    values(nextValues: Record<string, unknown> | Array<Record<string, unknown>>) {
      values = nextValues;
      return chain;
    },
    onDuplicateKeyUpdate(input: { set: Record<string, unknown> }) {
      state.onDuplicateKeyUpdateTables.push(resolveTableName(table));
      onDuplicateSet = input.set;
      return chain;
    },
    run: vi.fn(async () => {
      applyInsert(table, values, onDuplicateSet);
      return { changes: 1 };
    }),
  };

  return chain;
}

function makeSelectChain() {
  let fromTable: unknown = null;

  const chain = {
    from(table: unknown) {
      fromTable = table;
      return chain;
    },
    leftJoin() {
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit() {
      return chain;
    },
    async get() {
      if (fromTable === analyticsProjectionCheckpoints) {
        return state.checkpoint ? { ...state.checkpoint } : undefined;
      }
      if (fromTable === proxyLogs) {
        return state.proxyRows[0] ? { ...state.proxyRows[0] } : undefined;
      }
      return undefined;
    },
    async all() {
      if (fromTable === proxyLogs) {
        return state.proxyRows.map((row) => ({ ...row }));
      }
      if (fromTable === siteDayUsage) {
        return state.siteDayRows.map((row) => ({ ...row }));
      }
      if (fromTable === siteHourUsage) {
        return state.siteHourRows.map((row) => ({ ...row }));
      }
      if (fromTable === modelDayUsage) {
        return state.modelDayRows.map((row) => ({ ...row }));
      }
      return [];
    },
  };

  return chain;
}

function makeUpdateChain(table: unknown) {
  let setValues: Record<string, unknown> = {};

  const chain = {
    set(nextValues: Record<string, unknown>) {
      setValues = nextValues;
      state.lastUpdateSetKeys = Object.keys(nextValues).sort();
      return chain;
    },
    where() {
      return chain;
    },
    run: vi.fn(async () => {
      if (table !== analyticsProjectionCheckpoints || !state.checkpoint) {
        return { changes: 0 };
      }

      // Detect lease acquisition vs batch/recompute write by SET keys.
      // Lease acquisition sets leaseToken to a non-null UUID; release sets it to null.
      const isLeaseAcquisition = 'leaseToken' in setValues && 'leaseOwner' in setValues && !('lastProxyLogId' in setValues) && setValues.leaseToken !== null;

      if (isLeaseAcquisition) {
        // Lease acquisition always succeeds (row exists).
        for (const [key, value] of Object.entries(setValues)) {
          if (typeof value === 'object' && value !== null && 'query' in value) continue;
          state.checkpoint = { ...state.checkpoint, [key]: value };
        }
        return { changes: 1 };
      }

      // Non-lease update: capture SET values for shape assertions.
      if ('recomputeFromId' in setValues) {
        state.lastLeaseGuardSetValues = { ...setValues };
      }

      if (state.zeroRowForNextNonLeaseUpdate) {
        state.zeroRowForNextNonLeaseUpdate = false;
        // Apply the zero-row side effect.
        if (state.zeroRowEffect === 'delete-row') {
          state.checkpoint = null;
        } else if (state.zeroRowEffect === 'takeover') {
          state.checkpoint = {
            ...state.checkpoint,
            leaseToken: 'taken-over-token',
            leaseOwner: 'other-owner',
          };
        }
        state.zeroRowEffect = null;
        return { changes: 0 };
      }

      // Normal update: merge plain values; skip SQL template objects.
      for (const [key, value] of Object.entries(setValues)) {
        if (typeof value === 'object' && value !== null && 'query' in value) continue;
        state.checkpoint = { ...state.checkpoint, [key]: value };
      }
      return { changes: 1 };
    }),
  };

  return chain;
}

function makeDeleteChain(table: unknown) {
  const chain = {
    where() {
      return chain;
    },
    run: vi.fn(async () => ({ changes: 0 })),
  };
  return chain;
}

const db = {
  insert: vi.fn((table: unknown) => makeInsertChain(table)),
  select: vi.fn(() => makeSelectChain()),
  update: vi.fn((table: unknown) => makeUpdateChain(table)),
  delete: vi.fn((table: unknown) => makeDeleteChain(table)),
  transaction: vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db)),
};

vi.mock('../db/index.js', () => ({
  db,
  runtimeDbDialect: 'mysql',
  schema,
}));

vi.mock('./modelPricingService.js', () => ({
  fallbackTokenCost: vi.fn(() => 0),
}));

vi.mock('./localTimeService.js', () => ({
  getLocalRangeStartDayKey: vi.fn(() => '2026-04-08'),
  getResolvedTimeZone: vi.fn(() => 'Local'),
  toLocalDayKeyFromStoredUtc: vi.fn(() => '2026-04-08'),
  toLocalDayStartUtcFromStoredUtc: vi.fn(() => '2026-04-08 00:00:00'),
  toLocalHourStartUtcFromStoredUtc: vi.fn(() => '2026-04-08 02:00:00'),
}));

vi.mock('./snapshotCacheService.js', () => ({
  clearSnapshotCache: vi.fn(),
}));

type UsageAggregationModule = typeof import('./usageAggregationService.js');

describe('usageAggregationService mysql conflict handling', () => {
  let usageAggregationModule: UsageAggregationModule;

  beforeEach(async () => {
    resetMockState();
    vi.resetModules();
    usageAggregationModule = await import('./usageAggregationService.js');
    await usageAggregationModule.__resetUsageAggregationProjectorForTests();
  });

  it('uses mysql duplicate-key upserts for checkpoint and aggregate writes', async () => {
    state.proxyRows = [{
      id: 1,
      createdAt: '2026-04-08 02:10:00',
      status: 'success',
      latencyMs: 120,
      totalTokens: 100,
      estimatedCost: 0.2,
      modelActual: 'gpt-5',
      modelRequested: 'gpt-5',
      siteId: 7,
      sitePlatform: 'new-api',
    }];

    const result = await usageAggregationModule.runUsageAggregationProjectionPass();

    expect(result).toEqual({
      processedLogs: 1,
      watermarkId: 1,
      recomputed: false,
    });
    expect(state.onDuplicateKeyUpdateTables).toEqual([
      'analytics_projection_checkpoints',
      'site_day_usage',
      'site_hour_usage',
      'model_day_usage',
    ]);
    expect(state.siteDayRows).toEqual([
      expect.objectContaining({
        localDay: '2026-04-08',
        siteId: 7,
        totalCalls: 1,
        successCalls: 1,
        failedCalls: 0,
        totalTokens: 100,
      }),
    ]);
    expect(state.siteHourRows).toEqual([
      expect.objectContaining({
        bucketStartUtc: '2026-04-08 02:00:00',
        siteId: 7,
        totalCalls: 1,
      }),
    ]);
    expect(state.modelDayRows).toEqual([
      expect.objectContaining({
        localDay: '2026-04-08',
        siteId: 7,
        model: 'gpt-5',
        totalCalls: 1,
      }),
    ]);
    expect(state.checkpoint).toEqual(expect.objectContaining({
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
    }));
  });

  it('uses mysql update path for recompute requests (P4 single MIN-merge UPDATE)', async () => {
    // Pre-seed the checkpoint row so P4 UPDATE can match it.
    state.checkpoint = {
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 0,
      recomputeFromId: null,
    };

    await usageAggregationModule.requestUsageAggregatesRecompute(7);

    // P4 is a plain UPDATE, not an upsert — no onDuplicateKeyUpdate call.
    expect(state.onDuplicateKeyUpdateTables).toEqual([]);
    // P4 SET keys: recomputeFromId, recomputeRequestedAt, updatedAt.
    expect(state.lastUpdateSetKeys).toEqual([
      'recomputeFromId',
      'recomputeRequestedAt',
      'updatedAt',
    ]);
    expect(state.checkpoint).toEqual(expect.objectContaining({
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 0,
    }));
  });

  it('A: checkpoint_reset when guard UPDATE 0-rows and bare read finds no row (P2 branch)', async () => {
    // Pre-seed: recomputeFromId > 0, no proxy rows → P2 (row-missing) branch.
    state.checkpoint = {
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 0,
      recomputeFromId: 5,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    state.proxyRows = [];

    // Simulate: next non-lease checkpoint UPDATE returns 0 rows + row is deleted externally.
    state.zeroRowForNextNonLeaseUpdate = true;
    state.zeroRowEffect = 'delete-row';

    await expect(usageAggregationModule.runUsageAggregationProjectionPass())
      .rejects.toMatchObject({ code: 'checkpoint_reset', name: 'ProjectionCheckpointResetError' });

    // Row was deleted; release is a no-op (0 rows) → lastError NOT written.
    expect(state.checkpoint).toBeNull();
  });

  it('B: lease_lost when guard UPDATE 0-rows and bare read finds row with different token (P2 branch)', async () => {
    // Pre-seed: recomputeFromId > 0, no proxy rows → P2 (row-missing) branch.
    state.checkpoint = {
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 0,
      recomputeFromId: 5,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    state.proxyRows = [];

    // Simulate: next non-lease checkpoint UPDATE returns 0 rows + token is taken over.
    state.zeroRowForNextNonLeaseUpdate = true;
    state.zeroRowEffect = 'takeover';

    await expect(usageAggregationModule.runUsageAggregationProjectionPass())
      .rejects.toMatchObject({ code: 'lease_lost', name: 'ProjectionLeaseLostError' });

    // The error was correctly classified as lease_lost (B).
    // Note: the mock does not fully simulate WHERE clause matching for the
    // release UPDATE, so we do not assert the final checkpoint state here.
    // The A/B classification is the key behavior under test.
  });

  // ── Shape assertions: lock the CAS SQL form for P2/P3 recompute clears ──
  // Removing `IS NULL OR` from the recomputeRequestedAt CASE would silently
  // re-introduce the old F1 bug. The SQLite test reads the old value, the
  // MySQL mock does not evaluate CASE, and the live test is manual-only —
  // none of the three can catch this regression. A shape assertion is the
  // only oracle that works in the default suite.

  function extractSqlText(value: unknown): string {
    if (typeof value !== 'object' || value === null) return String(value);
    const obj = value as Record<string, unknown>;
    const chunks = obj.queryChunks;
    if (!Array.isArray(chunks)) return '';
    return chunks
      .map((chunk: unknown) => {
        const c = chunk as Record<string, unknown>;
        if (c && typeof c === 'object' && 'value' in c && Array.isArray(c.value)) {
          return c.value.join('');
        }
        return '';
      })
      .join('');
  }

  function assertCasShape(setValues: Record<string, unknown> | null, label: string) {
    expect(setValues, `${label}: no lease-guard SET values captured`).not.toBeNull();
    if (!setValues) return;
    const fromIdSql = extractSqlText(setValues.recomputeFromId);
    const requestedAtSql = extractSqlText(setValues.recomputeRequestedAt);
    // recomputeFromId: must be a CASE expression with the seenFromId guard.
    expect(fromIdSql, `${label}: recomputeFromId must be a CASE`).toContain('CASE');
    expect(fromIdSql, `${label}: recomputeFromId must reference = `).toContain('= ');
    // recomputeRequestedAt: must contain the dual-semantics safety form
    // `IS NULL OR` — removing it silently re-introduces F1.
    expect(requestedAtSql, `${label}: recomputeRequestedAt must contain IS NULL`).toContain('IS NULL');
    expect(requestedAtSql, `${label}: recomputeRequestedAt must contain OR`).toContain('OR');
  }

  it('P2 CAS shape: recompute clear SQL contains IS NULL OR dual-semantics guard', async () => {
    // recomputeFromId > 0, no proxy rows → P2 (missing-row) branch.
    state.checkpoint = {
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 0,
      recomputeFromId: 5,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    state.proxyRows = [];

    // P2 succeeds normally (no zero-row simulation).
    await usageAggregationModule.runUsageAggregationProjectionPass();

    assertCasShape(state.lastLeaseGuardSetValues, 'P2');
  });

  it('P3 CAS shape: restart clear SQL contains IS NULL OR dual-semantics guard', async () => {
    // recomputeFromId > 0, proxy row exists with a day boundary → P3 (restart) branch.
    state.checkpoint = {
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 0,
      recomputeFromId: 5,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    state.proxyRows = [{
      id: 5,
      createdAt: '2026-04-08 02:10:00',
      status: 'success',
      latencyMs: 50,
      totalTokens: 10,
      estimatedCost: 0.02,
      modelActual: 'gpt-5',
      modelRequested: 'gpt-5',
      siteId: 7,
      sitePlatform: 'new-api',
    }];

    // P3 succeeds normally (no zero-row simulation).
    await usageAggregationModule.runUsageAggregationProjectionPass();

    assertCasShape(state.lastLeaseGuardSetValues, 'P3');
  });
});
