import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { formatUtcSqlDateTime } from "./localTimeService.js";

type ProjectorModule = typeof import("./usageAggregationService.js");

const mysqlLive = process.env.DB_PARITY_MYSQL_URL ? it : it.skip;
const postgresLive = process.env.DB_PARITY_POSTGRES_URL ? it : it.skip;

describe("usageAggregationService live", () => {
  let runUsageAggregationProjectionPass: ProjectorModule["runUsageAggregationProjectionPass"];
  let requestUsageAggregatesRecompute: ProjectorModule["requestUsageAggregatesRecompute"];
  let originalDialect: string;
  let originalDbUrl: string;
  let originalDbSsl: boolean;

  beforeAll(async () => {
    const dbModule = await import("../db/index.js");
    const projectorModule = await import("./usageAggregationService.js");
    runUsageAggregationProjectionPass = projectorModule.runUsageAggregationProjectionPass;
    requestUsageAggregatesRecompute = projectorModule.requestUsageAggregatesRecompute;

    originalDialect = dbModule.runtimeDbDialect;
    originalDbUrl = config.dbType === "sqlite" ? "" : config.dbUrl;
    originalDbSsl = config.dbSsl;
  });

  afterAll(async () => {
    const { switchRuntimeDatabase, closeDbConnections } = await import("../db/index.js");
    await switchRuntimeDatabase("sqlite", originalDbUrl, originalDbSsl);
    await closeDbConnections();
  });

  async function runRecomputeOnLiveDatabase(dialect: "mysql" | "postgres", connectionString: string) {
    const { switchRuntimeDatabase, db, schema } = await import("../db/index.js");

    await switchRuntimeDatabase(dialect, connectionString);

    let insertedSiteId: number | undefined;
    let insertedAccountId: number | undefined;

    try {
      const site = await db
        .insert(schema.sites)
        .values({
          name: `live-recompute-${dialect}-site`,
          url: `https://live-recompute-${dialect}.example.com`,
          platform: "new-api",
          status: "active",
        })
        .returning()
        .get();
      insertedSiteId = site.id;

      const account = await db
        .insert(schema.accounts)
        .values({
          siteId: site.id,
          username: `live-recompute-${dialect}-user`,
          accessToken: `live-recompute-${dialect}-token`,
          status: "active",
        })
        .returning()
        .get();
      insertedAccountId = account.id;

      await db.insert(schema.proxyLogs).values([
        {
          accountId: account.id,
          status: "success",
          modelRequested: "gpt-5",
          modelActual: "gpt-5",
          totalTokens: 100,
          estimatedCost: 0.2,
          latencyMs: 120,
          createdAt: formatUtcSqlDateTime(new Date("2026-04-08T02:10:00.000Z")),
        },
        {
          accountId: account.id,
          status: "failed",
          modelRequested: "gpt-5-mini",
          modelActual: "gpt-5-mini",
          totalTokens: 50,
          estimatedCost: 0.1,
          latencyMs: 80,
          createdAt: formatUtcSqlDateTime(new Date("2026-04-09T02:45:00.000Z")),
        },
      ]).run();

      const firstPass = await runUsageAggregationProjectionPass();
      expect(firstPass.processedLogs).toBe(2);

      const dayRowsAfterFirst = await db.select().from(schema.siteDayUsage).all();
      expect(dayRowsAfterFirst).toHaveLength(2);

      const laterLog = await db
        .select({ id: schema.proxyLogs.id })
        .from(schema.proxyLogs)
        .where(
          eq(
            schema.proxyLogs.createdAt,
            formatUtcSqlDateTime(new Date("2026-04-09T02:45:00.000Z")),
          ),
        )
        .get();
      expect(laterLog).toBeDefined();

      await requestUsageAggregatesRecompute(laterLog.id);

      const recomputePass = await runUsageAggregationProjectionPass();
      expect(recomputePass.recomputed).toBe(true);

      const allDayRows = await db.select().from(schema.siteDayUsage).all();
      expect(allDayRows).toHaveLength(2);

      const earlierDayRow = allDayRows.find((row) => row.successCalls === 1 && row.totalTokens === 100);
      const laterDayRow = allDayRows.find((row) => row.failedCalls === 1 && row.totalTokens === 50);
      expect(earlierDayRow).toBeDefined();
      expect(laterDayRow).toBeDefined();

      const checkpoint = await db
        .select()
        .from(schema.analyticsProjectionCheckpoints)
        .where(eq(schema.analyticsProjectionCheckpoints.projectorKey, "usage-aggregates-v1"))
        .get();
      expect(checkpoint?.recomputeFromId).toBeNull();
      expect(checkpoint?.recomputeRequestedAt).toBeNull();
    } finally {
      if (insertedAccountId) {
        await db.delete(schema.proxyLogs).where(eq(schema.proxyLogs.accountId, insertedAccountId)).run();
      }
      if (insertedSiteId) {
        await db.delete(schema.siteDayUsage).where(eq(schema.siteDayUsage.siteId, insertedSiteId)).run();
        await db.delete(schema.siteHourUsage).where(eq(schema.siteHourUsage.siteId, insertedSiteId)).run();
        await db.delete(schema.modelDayUsage).where(eq(schema.modelDayUsage.siteId, insertedSiteId)).run();
      }
      await db
        .delete(schema.analyticsProjectionCheckpoints)
        .where(eq(schema.analyticsProjectionCheckpoints.projectorKey, "usage-aggregates-v1"))
        .run();
      if (insertedSiteId) {
        await db.delete(schema.sites).where(eq(schema.sites.id, insertedSiteId)).run();
      }

      await switchRuntimeDatabase("sqlite", originalDbUrl, originalDbSsl);
    }
  }

  mysqlLive("recomputes from later day log id on mysql and preserves earlier day", async () => {
    await runRecomputeOnLiveDatabase("mysql", process.env.DB_PARITY_MYSQL_URL!);
  });

  postgresLive("recomputes from later day log id on postgres and preserves earlier day", async () => {
    await runRecomputeOnLiveDatabase("postgres", process.env.DB_PARITY_POSTGRES_URL!);
  });
});
