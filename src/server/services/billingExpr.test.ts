import { describe, expect, it } from 'vitest';
import {
  evaluateBillingExpr,
  parseBillingExpr,
  type BillingExprContext,
} from './billingExpr.js';

// Real, evidenced upstream expressions (happycoding.xyz / zero.cat /api/pricing payloads).
const GLM_53 = 'tier("base", p * 1.4 + c * 4.4 + cr * 0.26)';
const DEEPSEEK_FLASH = 'tier("base", p * 0.3 + c * 1.2 + cr * 0.006)';
const GPT_6_SOL = 'len <= 272000 ? tier("0_272k", p * 2 + cr * 0.2 + cc * 2.5 + c * 10) : tier("272k_plus", p * 4 + cr * 0.4 + cc * 5 + c * 15)';
const GPT_5_6_SOL = 'len <= 272000 ? tier("0_272k", p * 5 + c * 30 + cr * 0.5 + cc * 6.25) : tier("272k_plus", p * 10 + c * 45 + cr * 1 + cc * 12.5)';
const CLAUDE_OPUS_55 = 'tier("standard", p * 4 + cr * 0.2 + cc * 5 + cc1h * 8 + c * 20)';
const DEEPSEEK_PRO = '(tier("base", p * 4.5 + c * 13.5 + cr * 0.15)) * (hour("UTC") >= 1 && hour("UTC") < 4 ? 2 : 1) * (hour("UTC") >= 6 && hour("UTC") < 10 ? 2 : 1)';
const PEAK_HOUR_TIERED = 'len <= 200000 ? tier("0_200k", p * 2 + c * 6 + cr * 0.3) * (hour("UTC") >= 9 && hour("UTC") < 18 ? 1.5 : 1) : tier("200k_plus", p * 4 + c * 12 + cr * 0.6) * (hour("UTC") >= 9 && hour("UTC") < 18 ? 1.5 : 1)';
const GROK_45 = 'len <= 200000 ? tier("0_200k", p * 2 + c * 6 + cr * 0.3) : tier("200k_plus", p * 4 + c * 12 + cr * 0.6)';

function evalExpr(source: string, ctx: BillingExprContext): number {
  const parsed = parseBillingExpr(source);
  if (!parsed) throw new Error(`expected "${source}" to parse`);
  return evaluateBillingExpr(parsed, ctx);
}

function utcDate(year: number, month: number, day: number, hour: number): Date {
  return new Date(Date.UTC(year, month, day, hour, 0, 0));
}

describe('billingExpr — parse + evaluate (real upstream samples)', () => {
  it('evaluates a flat tier expression with p/c/cr', () => {
    expect(evalExpr(GLM_53, { p: 1, c: 1, cr: 1 })).toBeCloseTo(1.4 + 4.4 + 0.26, 10);
    expect(evalExpr(GLM_53, { p: 2, c: 3, cr: 4 })).toBeCloseTo(2 * 1.4 + 3 * 4.4 + 4 * 0.26, 10);
    expect(evalExpr(DEEPSEEK_FLASH, { p: 1, c: 1, cr: 1 })).toBeCloseTo(0.3 + 1.2 + 0.006, 10);
  });

  it('selects the len tier at and above the boundary', () => {
    // len below the 272k boundary -> 0_272k tier
    expect(evalExpr(GPT_6_SOL, { p: 1, c: 0, cr: 0, cc: 0, len: 100_000 })).toBeCloseTo(2, 10);
    expect(evalExpr(GPT_6_SOL, { p: 1, c: 1, cr: 1, cc: 1, len: 100_000 })).toBeCloseTo(2 + 10 + 0.2 + 2.5, 10);
    // len == boundary -> still 0_272k (<=)
    expect(evalExpr(GPT_6_SOL, { p: 1, c: 0, cr: 0, cc: 0, len: 272_000 })).toBeCloseTo(2, 10);
    // len above the boundary -> 272k_plus tier
    expect(evalExpr(GPT_6_SOL, { p: 1, c: 0, cr: 0, cc: 0, len: 300_000 })).toBeCloseTo(4, 10);
    expect(evalExpr(GPT_6_SOL, { p: 1, c: 1, cr: 1, cc: 1, len: 300_000 })).toBeCloseTo(4 + 15 + 0.4 + 5, 10);
    // grok uses a 200k boundary
    expect(evalExpr(GROK_45, { p: 1, c: 0, cr: 0, len: 199_999 })).toBeCloseTo(2, 10);
    expect(evalExpr(GROK_45, { p: 1, c: 0, cr: 0, len: 200_001 })).toBeCloseTo(4, 10);
  });

  it('handles the cc1h variable (1h cache creation) mapped to 0 when untracked', () => {
    expect(evalExpr(CLAUDE_OPUS_55, { p: 1, c: 1, cr: 1, cc: 1, cc1h: 0 })).toBeCloseTo(4 + 0.2 + 5 + 0 + 20, 10);
    expect(evalExpr(CLAUDE_OPUS_55, { p: 1, c: 1, cr: 1, cc: 1, cc1h: 2 })).toBeCloseTo(4 + 0.2 + 5 + 16 + 20, 10);
  });

  it('applies hour("UTC") window multipliers', () => {
    // hour 2 UTC: in [1,4) -> x2, not in [6,10) -> x1 => base * 2
    expect(evalExpr(DEEPSEEK_PRO, { p: 1, now: utcDate(2024, 0, 1, 2) })).toBeCloseTo(4.5 * 2, 10);
    // hour 3 UTC: still in [1,4) -> x2
    expect(evalExpr(DEEPSEEK_PRO, { p: 1, now: utcDate(2024, 0, 1, 3) })).toBeCloseTo(4.5 * 2, 10);
    // hour 4 UTC: 4 < 4 false -> out of [1,4); not in [6,10) -> base
    expect(evalExpr(DEEPSEEK_PRO, { p: 1, now: utcDate(2024, 0, 1, 4) })).toBeCloseTo(4.5, 10);
    // hour 7 UTC: not in [1,4), in [6,10) -> x2
    expect(evalExpr(DEEPSEEK_PRO, { p: 1, now: utcDate(2024, 0, 1, 7) })).toBeCloseTo(4.5 * 2, 10);
    // hour 12 UTC: neither window -> base
    expect(evalExpr(DEEPSEEK_PRO, { p: 1, now: utcDate(2024, 0, 1, 12) })).toBeCloseTo(4.5, 10);
    // hour 0 UTC: 0 >= 1 false -> out of [1,4) -> base
    expect(evalExpr(DEEPSEEK_PRO, { p: 1, now: utcDate(2024, 0, 1, 0) })).toBeCloseTo(4.5, 10);
  });

  it('selects len tier and applies hour multiplier together (real upstream sample)', () => {
    // Below 200k, off-peak (UTC 4): base tier, no peak multiplier.
    expect(evalExpr(PEAK_HOUR_TIERED, { p: 1, c: 1, cr: 0, len: 100_000, now: utcDate(2024, 0, 1, 4) })).toBeCloseTo(2 + 6, 10);
    // Below 200k, peak (UTC 10): base tier * 1.5
    expect(evalExpr(PEAK_HOUR_TIERED, { p: 1, c: 1, cr: 0, len: 100_000, now: utcDate(2024, 0, 1, 10) })).toBeCloseTo((2 + 6) * 1.5, 10);
    // Above 200k, off-peak (UTC 4): 200k_plus tier, no peak multiplier.
    expect(evalExpr(PEAK_HOUR_TIERED, { p: 1, c: 1, cr: 0, len: 300_000, now: utcDate(2024, 0, 1, 4) })).toBeCloseTo(4 + 12, 10);
    // Above 200k, peak (UTC 10): 200k_plus tier * 1.5
    expect(evalExpr(PEAK_HOUR_TIERED, { p: 1, c: 1, cr: 0, len: 300_000, now: utcDate(2024, 0, 1, 10) })).toBeCloseTo((4 + 12) * 1.5, 10);
    // At boundary (len == 200000): still 0_200k (<=)
    expect(evalExpr(PEAK_HOUR_TIERED, { p: 1, c: 0, cr: 0, len: 200_000, now: utcDate(2024, 0, 1, 10) })).toBeCloseTo(2 * 1.5, 10);
  });

  it('matches metapi ratio*2 semantics for the anchored gpt-5.6-sol', () => {
    // upstream: model_ratio 2.5, completion_ratio 6, cache_ratio 0.1, create_cache_ratio 1.25
    // metapi ratio path: input 2.5*2=5, output 2.5*6*2=30, cacheRead 2.5*0.1*2=0.5, cacheCreation 2.5*1.25*2=6.25
    expect(evalExpr(GPT_5_6_SOL, { p: 1, c: 0, cr: 0, cc: 0, len: 100_000 })).toBeCloseTo(5, 10);
    expect(evalExpr(GPT_5_6_SOL, { p: 0, c: 1, cr: 0, cc: 0, len: 100_000 })).toBeCloseTo(30, 10);
    expect(evalExpr(GPT_5_6_SOL, { p: 0, c: 0, cr: 1, cc: 0, len: 100_000 })).toBeCloseTo(0.5, 10);
    expect(evalExpr(GPT_5_6_SOL, { p: 0, c: 0, cr: 0, cc: 1, len: 100_000 })).toBeCloseTo(6.25, 10);
  });

  it('respects operator precedence and all covered operators', () => {
    expect(evalExpr('2 + 3 * 4', {})).toBe(14);
    expect(evalExpr('(2 + 3) * 4', {})).toBe(20);
    expect(evalExpr('10 - 4 / 2', {})).toBe(8);
    expect(evalExpr('-5 + 3', {})).toBe(-2);
    expect(evalExpr('2 < 3', {})).toBe(1);
    expect(evalExpr('3 < 2', {})).toBe(0);
    expect(evalExpr('2 <= 2', {})).toBe(1);
    expect(evalExpr('3 >= 2', {})).toBe(1);
    expect(evalExpr('1 == 1', {})).toBe(1);
    expect(evalExpr('1 != 2', {})).toBe(1);
    expect(evalExpr('1 && 0', {})).toBe(0);
    expect(evalExpr('1 || 0', {})).toBe(1);
    expect(evalExpr('1 ? 10 : 20', {})).toBe(10);
    expect(evalExpr('0 ? 10 : 20', {})).toBe(20);
    expect(evalExpr('1 ? 2 ? 30 : 40 : 50', {})).toBe(30);
    expect(evalExpr('len > 100 ? p * 2 : p * 1', { len: 150, p: 3 })).toBe(6);
  });

  it('evaluates logical negation !', () => {
    expect(evalExpr('!1', {})).toBe(0);
    expect(evalExpr('!0', {})).toBe(1);
    expect(evalExpr('!p', { p: 5 })).toBe(0);
    expect(evalExpr('!p', { p: 0 })).toBe(1);
    // ! participates in arithmetic
    expect(evalExpr('!0 * 4', {})).toBe(4);
    expect(evalExpr('!(p == 0) ? 10 : 20', { p: 3 })).toBe(10);
    expect(evalExpr('!(p == 0) ? 10 : 20', { p: 0 })).toBe(20);
  });

  it('treats UTC/GMT case-insensitively in hour()', () => {
    const at = utcDate(2024, 0, 1, 13);
    expect(evalExpr('hour("UTC")', { now: at })).toBe(13);
    expect(evalExpr('hour("utc")', { now: at })).toBe(13);
    expect(evalExpr('hour("GMT")', { now: at })).toBe(13);
    expect(evalExpr('hour("gmt")', { now: at })).toBe(13);
    expect(evalExpr('hour("utc") == hour("GMT")', { now: at })).toBe(1);
  });
});

describe('billingExpr — safe fallback (never throws into billing)', () => {
  it('returns null for empty / oversized sources', () => {
    expect(parseBillingExpr('')).toBeNull();
    expect(parseBillingExpr('   ')).toBeNull();
    expect(parseBillingExpr('p * 1 + '.repeat(1000))).toBeNull();
  });

  it('returns null for uncovered syntax (unknown identifier / function)', () => {
    expect(parseBillingExpr('x * 2')).toBeNull();
    expect(parseBillingExpr('min(p, c)')).toBeNull();
    expect(parseBillingExpr('len(p)')).toBeNull(); // len is a variable, not a function
  });

  it('returns null for malformed sources', () => {
    expect(parseBillingExpr('p *')).toBeNull();
    expect(parseBillingExpr('p +')).toBeNull();
    expect(parseBillingExpr('(p * 2')).toBeNull();
    expect(parseBillingExpr('p * 2)')).toBeNull();
    expect(parseBillingExpr('p ? 1')).toBeNull(); // missing ':' branch
  });

  it('parses a syntactically valid expression that only fails at evaluation', () => {
    // tier() arity is checked at evaluation time, so parse succeeds and eval throws.
    const badTier = parseBillingExpr('tier("base")');
    expect(badTier).not.toBeNull();
    expect(() => evaluateBillingExpr(badTier!, { p: 1 })).toThrow();

    // a bare string parses but is not a valid numeric expression
    const bareString = parseBillingExpr('"base"');
    expect(bareString).not.toBeNull();
    expect(() => evaluateBillingExpr(bareString!, {})).toThrow();
  });
});
