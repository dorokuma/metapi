/**
 * Request-scoped collector for upstream-provider observations.
 *
 * Streams deliver the gateway metadata on one frame among many (never a fixed
 * index), and the final usage frame can arrive with `choices: []` (no routing
 * at all). Routing and costs are therefore staged **separately** (B1):
 * - `latestObservation` holds the last frame that carried `gateway.routing`;
 * - `latestUsageCosts` is a per-field merge of every frame that carried any
 *   cost/text field, even when it had no `choices`/metadata: a non-null field
 *   from a newer frame wins, older non-null fields survive frames that only
 *   carry part of the view (e.g. a later routing frame whose `gateway.cost`
 *   must not wipe `usage.cost` staged by an earlier usage-only frame);
 * - `snapshot()` merges the two, per field, preferring the freshest non-null
 *   value. This prevents a usage-only final frame from wiping the earlier
 *   observation's costs, and a later routing frame from wiping costs that
 *   arrived on a usage-only frame.
 *
 * The collector itself has no shared mutable state and never throws: parse
 * failures are swallowed (warned once per process) so a proxy request can never
 * be affected by detection.
 *
 * Lifecycle: callers must create one collector per retry attempt (B2) so an
 * observation captured by a failed attempt can never leak into the success log
 * of the next attempt. `snapshot() === null` means "nothing observed" and the
 * caller must skip the insert (B3).
 */

import { shouldCollectUpstreamProviderObservation } from './gate.js';
import {
  parseUpstreamProviderObservation,
  parseUpstreamProviderUsageCosts,
  type UpstreamProviderObservation,
  type UpstreamProviderUsageCostFields,
} from './parse.js';

export type UpstreamProviderObservationCollector = {
  readonly active: boolean;
  observe(payload: unknown): void;
  snapshot(): UpstreamProviderObservation | null;
};

let parseWarningLogged = false;

/**
 * Per-field merge of two cost views: non-null fields from `update` win, fields
 * that are null/absent in `update` keep the `previous` value.
 */
function mergeUsageCostViews(
  previous: UpstreamProviderUsageCostFields | null,
  update: UpstreamProviderUsageCostFields,
): UpstreamProviderUsageCostFields {
  if (!previous) return update;
  return {
    usageCost: update.usageCost ?? previous.usageCost,
    usageGatewayCost: update.usageGatewayCost ?? previous.usageGatewayCost,
    usageMarketCost: update.usageMarketCost ?? previous.usageMarketCost,
    gatewayCostText: update.gatewayCostText ?? previous.gatewayCostText,
    gatewayCostNumber: update.gatewayCostNumber ?? previous.gatewayCostNumber,
    gatewayInferenceCostText: update.gatewayInferenceCostText ?? previous.gatewayInferenceCostText,
    gatewayInferenceCostNumber: update.gatewayInferenceCostNumber ?? previous.gatewayInferenceCostNumber,
    gatewayGenerationId: update.gatewayGenerationId ?? previous.gatewayGenerationId,
  };
}

function mergeUsageCosts(
  observation: UpstreamProviderObservation,
  costs: UpstreamProviderUsageCostFields,
): UpstreamProviderObservation {
  return {
    ...observation,
    usageCost: costs.usageCost ?? observation.usageCost,
    usageGatewayCost: costs.usageGatewayCost ?? observation.usageGatewayCost,
    usageMarketCost: costs.usageMarketCost ?? observation.usageMarketCost,
    gatewayCostText: costs.gatewayCostText ?? observation.gatewayCostText,
    gatewayCostNumber: costs.gatewayCostNumber ?? observation.gatewayCostNumber,
    gatewayInferenceCostText: costs.gatewayInferenceCostText ?? observation.gatewayInferenceCostText,
    gatewayInferenceCostNumber: costs.gatewayInferenceCostNumber ?? observation.gatewayInferenceCostNumber,
    gatewayGenerationId: costs.gatewayGenerationId ?? observation.gatewayGenerationId,
  };
}

export function createUpstreamProviderObservationCollector(input: {
  requestId?: string | null;
  siteId?: number | string | null;
}): UpstreamProviderObservationCollector {
  const active = shouldCollectUpstreamProviderObservation(input);
  let latestObservation: UpstreamProviderObservation | null = null;
  let latestUsageCosts: UpstreamProviderUsageCostFields | null = null;

  return {
    active,
    observe(payload: unknown): void {
      if (!active) return;
      if (payload == null || typeof payload !== 'object') return;
      try {
        const observation = parseUpstreamProviderObservation(payload);
        if (observation) latestObservation = observation;
        const usageCosts = parseUpstreamProviderUsageCosts(payload);
        if (usageCosts) latestUsageCosts = mergeUsageCostViews(latestUsageCosts, usageCosts);
      } catch (error) {
        if (!parseWarningLogged) {
          parseWarningLogged = true;
          console.warn('[upstream-provider-detect] failed to parse upstream payload', error);
        }
      }
    },
    snapshot(): UpstreamProviderObservation | null {
      if (!latestObservation) return null;
      if (!latestUsageCosts) return latestObservation;
      return mergeUsageCosts(latestObservation, latestUsageCosts);
    },
  };
}

/**
 * B4: when a surface receives SSE text for a non-stream request and rebuilds a
 * final payload (`collectResponsesFinalPayloadFromSse*`), chat-shaped
 * `choices[].delta.provider_metadata` does not survive the rebuild. Scan the
 * raw SSE text instead and observe every `data:` frame, so detection works on
 * the original upstream bytes.
 *
 * Malformed frames are skipped; this never throws and never affects forwarding.
 */
export function observeUpstreamProviderObservationSseText(
  collector: UpstreamProviderObservationCollector,
  rawText: unknown,
): void {
  if (!collector.active) return;
  if (typeof rawText !== 'string' || rawText.length === 0) return;

  for (const event of rawText.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;

    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    collector.observe(payload);
  }
}
