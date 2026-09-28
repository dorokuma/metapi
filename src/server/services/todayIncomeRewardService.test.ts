import { describe, expect, it } from 'vitest';
import {
  estimateRewardWithTodayIncomeFallback,
  getTodayIncomeDelta,
  getTodayIncomeValue,
  updateTodayIncomeSnapshot,
} from './todayIncomeRewardService.js';
import { formatLocalDate } from './localTimeService.js';

describe('today income reward service', () => {
  it('records latest income value for same-day snapshots', () => {
    const now = new Date('2026-02-25T08:00:00.000Z');
    const later = new Date('2026-02-25T10:00:00.000Z');
    const day = formatLocalDate(now);

    const first = updateTodayIncomeSnapshot(null, 12, now);
    expect(getTodayIncomeValue(first, day)).toBe(12);
    expect(getTodayIncomeDelta(first, day)).toBe(0);

    const second = updateTodayIncomeSnapshot(first, 15.5, later);
    expect(getTodayIncomeValue(second, day)).toBe(15.5);
    expect(getTodayIncomeDelta(second, day)).toBe(3.5);
  });

  it('resets baseline on day change', () => {
    const firstAt = new Date('2026-02-25T09:00:00.000Z');
    const secondAt = new Date('2026-02-26T09:00:00.000Z');
    const firstDay = formatLocalDate(firstAt);
    const secondDay = formatLocalDate(secondAt);
    const day1 = updateTodayIncomeSnapshot(null, 10, firstAt);
    const day2 = updateTodayIncomeSnapshot(day1, 4, secondAt);

    expect(getTodayIncomeValue(day2, firstDay)).toBe(0);
    expect(getTodayIncomeValue(day2, secondDay)).toBe(4);
    expect(getTodayIncomeDelta(day2, firstDay)).toBe(0);
    expect(getTodayIncomeDelta(day2, secondDay)).toBe(0);
  });

  it('falls back to today income value only when parsed rewards are missing', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    const extraConfig = updateTodayIncomeSnapshot(
      updateTodayIncomeSnapshot(null, 8, new Date('2026-02-25T08:00:00.000Z')),
      10.2,
      new Date('2026-02-25T12:00:00.000Z'),
    );

    const fallbackReward = estimateRewardWithTodayIncomeFallback({
      day,
      successCount: 1,
      parsedRewardCount: 0,
      rewardSum: 0,
      extraConfig,
    });
    expect(fallbackReward).toBeCloseTo(10.2, 6);

    const preferParsed = estimateRewardWithTodayIncomeFallback({
      day,
      successCount: 1,
      parsedRewardCount: 1,
      rewardSum: 1.5,
      extraConfig,
    });
    expect(preferParsed).toBe(1.5);
  });

  it('reads today income snapshots from parsed extraConfig objects', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    const extraConfig = {
      todayIncomeSnapshot: {
        day,
        baseline: 8,
        latest: 10.2,
        updatedAt: '2026-02-25T12:00:00.000Z',
      },
    };

    expect(getTodayIncomeValue(extraConfig, day)).toBeCloseTo(10.2, 6);
    expect(getTodayIncomeDelta(extraConfig, day)).toBeCloseTo(2.2, 6);
  });

  it('preserves missing extraConfig when income is invalid', () => {
    expect(updateTodayIncomeSnapshot(null, Number.NaN)).toBeNull();
    expect(updateTodayIncomeSnapshot(undefined, -1)).toBeNull();
    expect(updateTodayIncomeSnapshot('', Number.NaN)).toBeNull();
    expect(updateTodayIncomeSnapshot('{"demo":true}', Number.NaN)).toBe('{"demo":true}');
    expect(updateTodayIncomeSnapshot({ demo: true }, Number.NaN)).toBe('{"demo":true}');
  });

  it('normalizes quota-unit snapshot values on read for backward compatibility', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    // 旧快照：无 incomeUnitSource，latest 为 quota 量级
    const oldSnapshot = {
      todayIncomeSnapshot: {
        day,
        baseline: 50_000_000,
        latest: 50_000_005,
        updatedAt: '2026-02-25T12:00:00.000Z',
      },
    };

    // 默认 heuristic：值 >= 100_000 视为 quota 量级，除以 500_000
    expect(getTodayIncomeValue(oldSnapshot, day)).toBeCloseTo(100.00001, 5);
    expect(getTodayIncomeDelta(oldSnapshot, day)).toBeCloseTo(0.00001, 5);

    // 传入 platform=new-api 时同样归一（默认除数 500_000）
    expect(getTodayIncomeValue(oldSnapshot, day, 'new-api')).toBeCloseTo(100.00001, 5);
    expect(getTodayIncomeDelta(oldSnapshot, day, 'new-api')).toBeCloseTo(0.00001, 5);

    // 传入 platform=veloera 时除数为 1_000_000
    expect(getTodayIncomeValue(oldSnapshot, day, 'veloera')).toBeCloseTo(50.000005, 6);
    expect(getTodayIncomeDelta(oldSnapshot, day, 'veloera')).toBeCloseTo(0.000005, 6);
  });

  it('does not re-normalize dollar-level snapshot values', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    const dollarSnapshot = {
      todayIncomeSnapshot: {
        day,
        baseline: 25,
        latest: 28.5,
        updatedAt: '2026-02-25T12:00:00.000Z',
      },
    };

    expect(getTodayIncomeValue(dollarSnapshot, day)).toBeCloseTo(28.5, 6);
    expect(getTodayIncomeValue(dollarSnapshot, day, 'new-api')).toBeCloseTo(28.5, 6);
  });

  it('does not double-normalize snapshots marked as normalized (Critical A)', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    // 新格式：写入端已归一为 100.00001，标记为 normalized
    const normalizedSnapshot = {
      todayIncomeSnapshot: {
        day,
        baseline: 100.00001,
        latest: 100.00001,
        updatedAt: '2026-02-25T12:00:00.000Z',
        incomeUnitSource: 'normalized',
        incomePlatform: 'new-api',
      },
    };

    // 读取端遇 normalized 绝不重算，防止二次归一失真。
    expect(getTodayIncomeValue(normalizedSnapshot, day, 'new-api')).toBeCloseTo(100.00001, 5);
    expect(getTodayIncomeDelta(normalizedSnapshot, day, 'new-api')).toBeCloseTo(0, 6);
  });

  it('normalizes legacy quota-marked snapshots on read', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    // 旧格式：写入端标为 quota，值仍是原始 quota
    const legacyQuotaSnapshot = {
      todayIncomeSnapshot: {
        day,
        baseline: 50_000_000,
        latest: 50_000_005,
        updatedAt: '2026-02-25T12:00:00.000Z',
        incomeUnitSource: 'quota',
        incomePlatform: 'new-api',
      },
    };

    // legacy quota 标记仍应归一。
    expect(getTodayIncomeValue(legacyQuotaSnapshot, day, 'new-api')).toBeCloseTo(100.00001, 5);
    expect(getTodayIncomeDelta(legacyQuotaSnapshot, day, 'new-api')).toBeCloseTo(0.00001, 5);
  });

  it('writes snapshot as-is with normalized marker (write-path contract)', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    // 写入端刚性契约：传入即美元，直接入库，标记 normalized。
    const dollarsInput = updateTodayIncomeSnapshot(null, 600, new Date('2026-02-25T08:00:00.000Z'), 'new-api');
    const parsed = JSON.parse(dollarsInput || '{}');
    expect(parsed.todayIncomeSnapshot.latest).toBe(600);
    expect(parsed.todayIncomeSnapshot.incomeUnitSource).toBe('normalized');
    expect(parsed.todayIncomeSnapshot.incomePlatform).toBe('new-api');

    // 300 raw quota 在写入端不再猜测，原样存入；该场景由读取端 legacy 兜底处理。
    const rawQuotaInput = updateTodayIncomeSnapshot(null, 300, new Date('2026-02-25T08:00:00.000Z'), 'new-api');
    const parsedRaw = JSON.parse(rawQuotaInput || '{}');
    expect(parsedRaw.todayIncomeSnapshot.latest).toBe(300);
    expect(parsedRaw.todayIncomeSnapshot.incomeUnitSource).toBe('normalized');
  });

  it('fallback reward uses snapshot value as-is for normalized snapshots', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    // 写入端刚性契约：50_000_005 按美元原样存入，标记 normalized。
    const extraConfig = updateTodayIncomeSnapshot(null, 50_000_005, new Date('2026-02-25T08:00:00.000Z'), 'new-api');

    const reward = estimateRewardWithTodayIncomeFallback({
      day,
      successCount: 1,
      parsedRewardCount: 0,
      rewardSum: 0,
      extraConfig,
      platform: 'new-api',
    });
    // 读取端遇 normalized 标记不重算，返回写入值 50_000_005。
    // 300 raw quota 不再被写入端猜成 300 美元；legacy 无标记数据由读取端兜底。
    expect(reward).toBe(50_000_005);
  });

  it('does not max-mix parsed reward with income snapshot', () => {
    const day = formatLocalDate(new Date('2026-02-25T08:00:00.000Z'));
    // 既有签到解析奖励，又有 income 快照
    const extraConfig = updateTodayIncomeSnapshot(null, 50_000_005, new Date('2026-02-25T08:00:00.000Z'), 'new-api');

    // parsedRewardCount > 0 时应仅使用解析奖励，不取 max
    const reward = estimateRewardWithTodayIncomeFallback({
      day,
      successCount: 1,
      parsedRewardCount: 1,
      rewardSum: 1.5,
      extraConfig,
      platform: 'new-api',
    });
    expect(reward).toBe(1.5);
  });
});
