import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown): Promise<any> => null);

vi.mock('./modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown) => fetchModelPricingCatalogMock(arg),
}));

import { resolveUpstreamEndpointCandidates } from './upstreamEndpointDerivation.js';
import {
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
  resetUpstreamEndpointRuntimeState,
} from './upstreamEndpointRuntimeMemory.js';

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: 'new-api',
    apiKey: null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('upstreamEndpointDerivation', () => {
  beforeEach(() => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    resetUpstreamEndpointRuntimeState();
  });

  it('derives compact requests directly to responses from the service owner', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
      undefined,
      undefined,
      {
        requestKind: 'responses-compact',
      },
    );

    expect(order).toEqual(['responses']);
  });

  it('derives codex oauth openai requests as responses-first without surface-local reordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
      undefined,
      undefined,
      {
        oauthProvider: 'codex',
      },
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('keeps explicit openai platforms on responses-first ordering even for claude-family models', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-opus-4-6',
      'openai',
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('keeps antigravity non-gemini compatibility requests on messages-first ordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'antigravity',
        },
      },
      'claude-opus-4-6',
      'openai',
      undefined,
      {
        hasNonImageFileInput: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('keeps claude-family file-url requests messages-first for claude upstreams', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'claude',
        },
      },
      'claude-opus-4-6',
      'responses',
      undefined,
      {
        hasNonImageFileInput: true,
      },
      {
        requiresNativeResponsesFileUrl: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('derives claude count_tokens requests as messages-only when the upstream supports messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-sonnet-4-5-20250929',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('keeps runtime memory preference behaviour unchanged when the site has no pin', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );

    expect(order).toEqual(['chat', 'messages', 'responses']);
  });

  it('pins the site preferred endpoint ahead of a remembered responses preference', async () => {
    const context = {
      ...baseContext,
      site: {
        ...baseContext.site,
        platform: 'openai',
      },
    };

    // 先记下运行时偏好：responses 曾成功，会被 runtime memory 顶到最前。
    recordUpstreamEndpointSuccess({
      siteId: context.site.id,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
    });

    const withoutPin = await resolveUpstreamEndpointCandidates(context, 'gpt-5.3', 'openai');
    expect(withoutPin[0]).toBe('responses');

    const withPin = await resolveUpstreamEndpointCandidates(
      {
        ...context,
        site: { ...context.site, preferredEndpoint: 'chat' },
      },
      'gpt-5.3',
      'openai',
    );

    expect(withPin).toEqual(['chat', 'responses', 'messages']);
  });

  it('does not revive a blocked endpoint when it is pinned', async () => {
    const context = {
      ...baseContext,
      site: {
        ...baseContext.site,
        platform: 'openai',
      },
    };

    recordUpstreamEndpointFailure({
      siteId: context.site.id,
      endpoint: 'chat',
      downstreamFormat: 'openai',
      status: 404,
      errorText: 'not found',
      modelName: 'gpt-5.3',
    });

    const order = await resolveUpstreamEndpointCandidates(
      {
        ...context,
        site: { ...context.site, preferredEndpoint: 'chat' },
      },
      'gpt-5.3',
      'openai',
    );

    expect(order).not.toContain('chat');
    expect(order).toEqual(['responses', 'messages']);
  });

  it('treats unknown or auto preferred endpoint values as no-op', async () => {
    const context = {
      ...baseContext,
      site: {
        ...baseContext.site,
        platform: 'openai',
      },
    };

    const baseline = ['responses', 'chat', 'messages'];
    for (const value of ['', 'auto', 'gemini', 'CHAT ', 'unknown']) {
      const order = await resolveUpstreamEndpointCandidates(
        {
          ...context,
          site: { ...context.site, preferredEndpoint: value },
        },
        'gpt-5.3',
        'openai',
      );
      if (value.trim().toLowerCase() === 'chat') {
        expect(order[0]).toBe('chat');
        continue;
      }
      expect(order, `preferredEndpoint=${JSON.stringify(value)}`).toEqual(baseline);
    }
  });

  it('keeps compact requests responses-only even when a different endpoint is pinned', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
          preferredEndpoint: 'chat',
        },
      },
      'gpt-5.3',
      'responses',
      undefined,
      undefined,
      {
        requestKind: 'responses-compact',
      },
    );

    expect(order).toEqual(['responses']);
  });
});
