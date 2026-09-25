import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import {
  extractUpstreamProviderDetectHostname,
  matchUpstreamProviderDetectHost,
  normalizeUpstreamProviderDetectPlatforms,
  normalizeUpstreamProviderDetectSampleRate,
  resolveUpstreamProviderDetectSampleHit,
  shouldCollectUpstreamProviderObservation,
} from './gate.js';

const originalSettings = {
  enabled: config.upstreamProviderDetectEnabled,
  sampleRate: config.upstreamProviderDetectSampleRate,
  retentionDays: config.upstreamProviderDetectRetentionDays,
  platforms: config.upstreamProviderDetectPlatforms,
};

describe('upstreamProviderDetect gate', () => {
  beforeEach(() => {
    config.upstreamProviderDetectEnabled = true;
    config.upstreamProviderDetectSampleRate = 1;
    config.upstreamProviderDetectRetentionDays = 14;
    config.upstreamProviderDetectPlatforms = ['cline.bot'];
  });

  afterEach(() => {
    config.upstreamProviderDetectEnabled = originalSettings.enabled;
    config.upstreamProviderDetectSampleRate = originalSettings.sampleRate;
    config.upstreamProviderDetectRetentionDays = originalSettings.retentionDays;
    config.upstreamProviderDetectPlatforms = originalSettings.platforms;
  });

  describe('normalizeUpstreamProviderDetectPlatforms', () => {
    it('normalizes csv, scheme, wildcard, port, case and trailing dots, then dedupes', () => {
      expect(normalizeUpstreamProviderDetectPlatforms(
        ' Cline.BOT ,.api.cline.bot,*.cline.bot,https://api.cline.bot/api,cline.bot:443, ,',
      )).toEqual(['cline.bot', 'api.cline.bot']);
    });

    it('accepts arrays and drops non-string or empty entries', () => {
      expect(normalizeUpstreamProviderDetectPlatforms([' cline.bot ', 42, null, '', '*.cline.bot']))
        .toEqual(['cline.bot']);
      expect(normalizeUpstreamProviderDetectPlatforms(undefined)).toEqual([]);
      expect(normalizeUpstreamProviderDetectPlatforms('')).toEqual([]);
    });
  });

  describe('extractUpstreamProviderDetectHostname', () => {
    it('extracts the host from full urls and scheme-less urls', () => {
      expect(extractUpstreamProviderDetectHostname('https://api.cline.bot/api')).toBe('api.cline.bot');
      expect(extractUpstreamProviderDetectHostname('api.cline.bot/v1')).toBe('api.cline.bot');
      expect(extractUpstreamProviderDetectHostname('https://api.cline.bot.:8443/')).toBe('api.cline.bot');
    });

    it('returns null for malformed or non-string urls', () => {
      expect(extractUpstreamProviderDetectHostname('')).toBeNull();
      expect(extractUpstreamProviderDetectHostname('not a url')).toBeNull();
      expect(extractUpstreamProviderDetectHostname(null)).toBeNull();
      expect(extractUpstreamProviderDetectHostname(42)).toBeNull();
    });
  });

  describe('matchUpstreamProviderDetectHost', () => {
    it('matches exact hosts and dot-boundary subdomains', () => {
      expect(matchUpstreamProviderDetectHost('https://api.cline.bot', ['cline.bot'])).toBe(true);
      expect(matchUpstreamProviderDetectHost('https://cline.bot', ['cline.bot'])).toBe(true);
      expect(matchUpstreamProviderDetectHost('https://api.cline.bot:8443/api', ['cline.bot'])).toBe(true);
    });

    it('does not match lookalike hosts', () => {
      expect(matchUpstreamProviderDetectHost('https://evilcline.bot', ['cline.bot'])).toBe(false);
      expect(matchUpstreamProviderDetectHost('https://api.cline.bot.evil.example', ['cline.bot'])).toBe(false);
      expect(matchUpstreamProviderDetectHost('https://api.other.example', ['cline.bot'])).toBe(false);
    });

    it('returns false without platforms or host', () => {
      expect(matchUpstreamProviderDetectHost('https://api.cline.bot', [])).toBe(false);
      expect(matchUpstreamProviderDetectHost('', ['cline.bot'])).toBe(false);
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
    it('requires the master switch, a matching host suffix and a sample hit', () => {
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteUrl: 'https://api.cline.bot/api',
      })).toBe(true);

      config.upstreamProviderDetectEnabled = false;
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteUrl: 'https://api.cline.bot/api',
      })).toBe(false);

      config.upstreamProviderDetectEnabled = true;
      config.upstreamProviderDetectSampleRate = 0;
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteUrl: 'https://api.cline.bot/api',
      })).toBe(false);

      config.upstreamProviderDetectSampleRate = 1;
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteUrl: 'https://api.other.example',
      })).toBe(false);
    });

    it('collects nothing when the platform suffix list is empty', () => {
      config.upstreamProviderDetectPlatforms = [];
      expect(shouldCollectUpstreamProviderObservation({
        requestId: 'req-1',
        siteUrl: 'https://api.cline.bot/api',
      })).toBe(false);
    });
  });
});
