import { describe, expect, it } from 'vitest';
import { buildStartupEndpoints, buildStartupSummaryLines } from './startupInfo.js';

describe('startupInfo', () => {
  it('builds single-port endpoint summary for admin and proxy APIs', () => {
    const endpoints = buildStartupEndpoints({ port: 4000, host: '0.0.0.0' });

    expect(endpoints.baseUrl).toBe('http://127.0.0.1:4000');
    expect(endpoints.adminDashboardUrl).toBe('http://127.0.0.1:4000');
    expect(endpoints.adminApiExample).toBe('http://127.0.0.1:4000/api/stats/dashboard');
    expect(endpoints.proxyApiExample).toBe('http://127.0.0.1:4000/v1/chat/completions');
  });

  it('renders copy-ready startup summary lines', () => {
    const lines = buildStartupSummaryLines({ port: 4000, host: '0.0.0.0' });

    expect(lines.some((line) => line.includes('metapi running'))).toBe(true);
    expect(lines.some((line) => line.includes('Dashboard: http://127.0.0.1:4000'))).toBe(true);
    expect(lines.some((line) => line.includes('/api/stats/dashboard'))).toBe(true);
    expect(lines.some((line) => line.includes('/v1/chat/completions'))).toBe(true);
  });

  it('只回显令牌占位，绝不把令牌明文写进启动横幅', () => {
    const lines = buildStartupSummaryLines({ port: 4000, host: '127.0.0.1' });
    const rendered = lines.join('\n');

    expect(rendered).toContain('$AUTH_TOKEN');
    expect(rendered).toContain('$PROXY_TOKEN');
    expect(rendered).not.toMatch(/Bearer\s+[^$\s]/);
  });
});
