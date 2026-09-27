import { describe, expect, it } from 'vitest';
import { hasUpstreamUsageObservation, resolveFinalUsage } from './proxyUsageNormalize.js';

describe('proxyUsageNormalize', () => {
  describe('resolveFinalUsage', () => {
    it('returns zeros columns for zeros input', () => {
      const result = resolveFinalUsage({ zeros: true });
      expect(result.columns).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        promptTokensIncludeCache: null,
      });
      expect(result.usageSource).toBeNull();
    });

    it('returns unknown for empty upstream with no selfLog', () => {
      const result = resolveFinalUsage({});
      expect(result.columns).toEqual({
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        reasoningTokens: null,
        promptTokensIncludeCache: null,
      });
      expect(result.usageSource).toBe('unknown');
    });

    it('normalizes upstream with flag=true and clamps total', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 50,
          cacheReadTokens: 5,
          cacheCreationTokens: 3,
          reasoningTokens: 2,
          promptTokensIncludeCache: true,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            reasoningTokens: true,
          },
        },
      });
      expect(result.columns).toEqual({
        promptTokens: 22, // 30 - 5 - 3
        completionTokens: 10,
        totalTokens: 50,
        cacheReadTokens: 5,
        cacheCreationTokens: 3,
        reasoningTokens: 2,
        promptTokensIncludeCache: false,
      });
      expect(result.usageSource).toBe('upstream');
    });

    it('normalizes upstream with flag=false and preserves values', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 40,
          cacheReadTokens: 5,
          cacheCreationTokens: 3,
          reasoningTokens: 2,
          promptTokensIncludeCache: false,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            reasoningTokens: true,
          },
        },
      });
      expect(result.columns).toEqual({
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 48,
        cacheReadTokens: 5,
        cacheCreationTokens: 3,
        reasoningTokens: 2,
        promptTokensIncludeCache: false,
      });
      expect(result.usageSource).toBe('upstream');
    });

    it('writes NULL cache columns and keeps prompt unsubstracted when flag=null', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 40,
          promptTokensIncludeCache: null,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            reasoningTokens: false,
          },
        },
      });
      expect(result.columns).toEqual({
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 40,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        reasoningTokens: null,
        promptTokensIncludeCache: null,
      });
      expect(result.usageSource).toBe('upstream');
    });

    it('synthesizes total from parts when total is absent', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          cacheReadTokens: 5,
          presence: {
            promptTokens: true,
            completionTokens: true,
            cacheReadTokens: true,
            totalTokens: false,
            cacheCreationTokens: false,
            reasoningTokens: false,
          },
        },
      });
      expect(result.columns.totalTokens).toBe(40); // 30 + 10 + 5
      expect(result.usageSource).toBe('upstream');
    });

    it('clamps total to be at least sum of parts', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 20,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: false,
            cacheCreationTokens: false,
            reasoningTokens: false,
          },
        },
      });
      expect(result.columns.totalTokens).toBe(40); // max(20, 30+10)
    });

    it('uses selfLog when upstream has no observations', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          presence: {
            promptTokens: false,
            completionTokens: false,
            totalTokens: false,
            cacheReadTokens: false,
            cacheCreationTokens: false,
            reasoningTokens: false,
          },
        },
        selfLog: {
          promptTokens: 20,
          completionTokens: 8,
          totalTokens: 28,
        },
      });
      expect(result.columns).toEqual({
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        reasoningTokens: null,
        promptTokensIncludeCache: null,
      });
      expect(result.usageSource).toBe('self-log');
    });

    it('transfers flag=true to false during normalization', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 40,
          cacheReadTokens: 5,
          promptTokensIncludeCache: true,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: false,
            reasoningTokens: false,
          },
        },
      });
      expect(result.columns.promptTokensIncludeCache).toBe(false);
      expect(result.columns.promptTokens).toBe(25); // 30 - 5
    });

    it('keeps flag=false unchanged', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 40,
          cacheReadTokens: 5,
          promptTokensIncludeCache: false,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: false,
            reasoningTokens: false,
          },
        },
      });
      expect(result.columns.promptTokensIncludeCache).toBe(false);
      expect(result.columns.promptTokens).toBe(30);
    });

    it('writes NULL cache columns and does not subtract prompt when flag=null', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 40,
          cacheReadTokens: 5,
          cacheCreationTokens: 3,
          promptTokensIncludeCache: null,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            reasoningTokens: false,
          },
        },
      });
      expect(result.columns.cacheReadTokens).toBeNull();
      expect(result.columns.cacheCreationTokens).toBeNull();
      expect(result.columns.promptTokens).toBe(30); // not subtracted
    });

    it('does not use selfLog when upstream has observations', () => {
      const result = resolveFinalUsage({
        upstream: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          presence: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            cacheReadTokens: false,
            cacheCreationTokens: false,
            reasoningTokens: false,
          },
        },
        selfLog: {
          promptTokens: 20,
          completionTokens: 8,
          totalTokens: 28,
        },
      });
      expect(result.usageSource).toBe('upstream');
      expect(result.columns.promptTokens).toBe(10);
    });
  });

  describe('hasUpstreamUsageObservation', () => {
    it('returns true for explicit all-zero usage with presence (present, not missing)', () => {
      expect(hasUpstreamUsageObservation({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        presence: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          cacheReadTokens: false,
          cacheCreationTokens: false,
          reasoningTokens: false,
        },
      })).toBe(true);
    });

    it('returns false when nothing is present (true absence)', () => {
      expect(hasUpstreamUsageObservation({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        presence: {
          promptTokens: false,
          completionTokens: false,
          totalTokens: false,
          cacheReadTokens: false,
          cacheCreationTokens: false,
          reasoningTokens: false,
        },
      })).toBe(false);
    });

    it('infers presence from value > 0 for legacy inputs without presence', () => {
      expect(hasUpstreamUsageObservation({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toBe(false);
      expect(hasUpstreamUsageObservation({ promptTokens: 5, completionTokens: 0, totalTokens: 5 })).toBe(true);
    });
  });
});
