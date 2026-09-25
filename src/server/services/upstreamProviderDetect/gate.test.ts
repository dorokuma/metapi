import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import {
  normalizeUpstreamProviderDetectSampleRate,
  resolveUpstreamProviderDetectSampleHit,
  shouldCollectUpstreamProviderObservation,
} from './gate.js';
import {
  isUpstreamProviderDetectSiteSelected,
  normalizeUpstreamProviderDetectSiteIds,
} from './siteIds.js';

const originalSettings = {
  enabled: config.upstreamProviderDetectEnabled,
  sampleRate: config.upstreamProviderDetectSampleRate,
  retentionDays: config.upstreamProviderDetectRetentionDays,
  siteIds: config.upstreamProviderDetectSiteIds,
};

describe('upstreamProviderDetect gate', () => {
  beforeEach(() => {
    config.upstreamProviderDetectEnabled = true;
    config.upstreamProviderDetectSampleRate = 1;
    config.upstreamProviderDetectRetentionDays = 14;
    config.upstreamProviderDetectSiteIds = [9];
  });

  afterEach(() => {
    config.upstreamProviderDetectEnabled = originalSettings.enabled;
    config.upstreamProviderDetectSampleRate = originalSettings.sampleRate;
    config.upstreamProviderDetectRetentionDays = originalSettings.retentionDays;
    config.upstreamProviderDetectSiteIds = originalSettings.siteIds;
  });

  describe('normalizeUpstreamProviderDetectSiteIds', () => {
    it('accepts numbers and numeric strings, truncates floats and dedupes', () => {
      expect(normalizeUpstreamProviderDetectSiteIds([9, '12', 9.7, ' 12 ', '9']))
        .toEqual([9, 12]);
    });

    it('accepts a comma separated string and single numbers', () => {
      expect(normalizeUpstreamProviderDetectSiteIds('9, 12,,13')).toEqual([9, 12, 13]);
      expect(normalizeUpstreamProviderDetectSiteIds('9')).toEqual([9]);
      expect(normalizeUpstreamProviderDetectSiteIds(9)).toEqual([9]);
    });

    it('drops empty, negative, zero and non-numeric entries', () => {
      expect(normalizeUpstreamProviderDetectSiteIds([0, -3, 'abc', '', null, undefined, 5]))
        .toEqual([5]);
      expect(normalizeUpstreamProviderDetectSiteIds(undefined)).toEqual([]);
      expect(normalizeUpstreamProviderDetectSiteIds(null)).toEqual([]);
      expect(normalizeUpstreamProviderDetectSiteIds('')).toEqual([]);
    });
  });

  describe('isUpstreamProviderDetectSiteSelected', () => {
    it('matches numeric and numeric-string ids against the selection', () => {
      expect(isUpstreamProviderDetectSiteSelected(9, [9, 12])).toBe(true);
      expect(isUpstreamProviderDetectSiteSelected('12', [9, 12])).toBe(true);
    });

    it('returns false for unselected or invalid ids', () => {
      expect(isUpstreamProviderDetectSiteSelected(7, [9, 12])).toBe(false);
      expect(isUpstreamProviderDetectSiteSelected(null, [9])).toBe(false);
      expect(isUpstreamProviderDetectSiteSelected(undefined, [9])).toBe(false);
      expect(isUpstreamProviderDetectSiteSelected(0, [9])).toBe(false);
      expect(isUpstreamProviderDetectSiteSelected(9, [])).toBe(false);
    });
  });

  describe('sampling', () => {
    it('normalizes rates to [0, 1] and defaults missing values to full sampling', () => {
      expect(normalizeUpstreamProviderDetectSampleRate(1.5)).toBe(1);
      expect(normalizeUpstreamProviderDetectSampleRate(-1)).toBe(0);
      expect(normalizeUpstreamProviderDetectSampleRate('0.5')).toBe(0.5);
      expect(normalizeUpstreamProviderDetectSampleRate('abc')).toBe(1);
      expect(normalizeUpstreamProviderDetectSampleRate(undefined)).toBe(1);
      expect(normalizeUpstreamProviderDetectSampleRate(null)).toBe(1);
      expect(normalizeUpstreamProviderDetectSampleRate('')).toBe(1);
    });

    it('is deterministic per request id and both full/zero shortcuts work', () => {
      expect(resolveUpstreamProviderDetectSampleHit('req-1', 1)).toBe(true);
      expect(resolveUpstreamProviderDetectSampleHit('req-1', 0)).toBe(false);

      const first = resolveUpstreamProviderDetectSampleHit('req-1', 0.5);
      expect(resolveUpstreamProviderDetectSampleHit('req-1', 0.5)).toBe(first);

      const outcomes = new Set(
        Array.from({ length: 200 }, (_value, index) => resolveUpstreamProviderDetectSampleHit(`req-${index}`, 0.5)),
      );
      expect(outcomes).toEqual(new Set([true, false]));
    });
  });

  describe('shouldCollectUpstreamProviderObservation', () => {
    it('requires the master switch, a selected site and a sample hit', () => {
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteId: 9,
      })).toBe(true);
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteId: '9',
      })).toBe(true);

      config.upstreamProviderDetectEnabled = false;
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteId: 9,
      })).toBe(false);

      config.upstreamProviderDetectEnabled = true;
      config.upstreamProviderDetectSampleRate = 0;
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteId: 9,
      })).toBe(false);

      config.upstreamProviderDetectSampleRate = 1;
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteId: 12,
      })).toBe(false);
    });

    it('collects nothing when no site is selected (default)', () => {
      config.upstreamProviderDetectSiteIds = [];
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteId: 9,
      })).toBe(false);
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
      })).toBe(false);
    });
  });
});
