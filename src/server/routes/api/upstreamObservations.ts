/**
 * Read-only aggregate API for upstream-provider observations.
 *
 * These routes live under `/api/stats/upstream-observations/*` and therefore
 * inherit the global `/api` auth hook (they are not in the public allowlist).
 * The heavy lifting lives in `services/upstreamProviderDetect/query.ts`; this
 * module only validates query params and shapes the responses.
 *
 * F3: every aggregate uses a window capped at 7 days (see the shared resolver),
 * so none of them can scan the whole table.
 */

import { FastifyInstance } from 'fastify';
import {
  loadUpstreamProviderObservationDistribution,
  loadUpstreamProviderObservationFallbacks,
  loadUpstreamProviderObservationSession,
  resolveUpstreamProviderObservationQueryWindow,
} from '../../services/upstreamProviderDetect/query.js';

type UpstreamObservationQuery = {
  siteId?: string;
  model?: string;
  from?: string;
  to?: string;
  clientSessionId?: string;
  limit?: string;
};

/** `undefined` = absent (no filter); `null` = present but invalid (400). */
function parseOptionalPositiveInt(raw?: string): number | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const numeric = Number.parseInt(trimmed, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function parseOptionalModel(raw?: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function upstreamObservationsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: UpstreamObservationQuery }>(
    '/api/stats/upstream-observations/distribution',
    async (request, reply) => {
      const siteId = parseOptionalPositiveInt(request.query.siteId);
      if (siteId === null) {
        return reply.code(400).send({ message: 'siteId is invalid' });
      }
      const window = resolveUpstreamProviderObservationQueryWindow({
        from: request.query.from,
        to: request.query.to,
      });
      return loadUpstreamProviderObservationDistribution({
        siteId: siteId ?? null,
        model: parseOptionalModel(request.query.model),
        window,
      });
    },
  );

  app.get<{ Querystring: UpstreamObservationQuery }>(
    '/api/stats/upstream-observations/fallbacks',
    async (request, reply) => {
      const siteId = parseOptionalPositiveInt(request.query.siteId);
      if (siteId === null) {
        return reply.code(400).send({ message: 'siteId is invalid' });
      }
      const window = resolveUpstreamProviderObservationQueryWindow({
        from: request.query.from,
        to: request.query.to,
      });
      return loadUpstreamProviderObservationFallbacks({
        siteId: siteId ?? null,
        model: parseOptionalModel(request.query.model),
        window,
      });
    },
  );

  app.get<{ Querystring: UpstreamObservationQuery }>(
    '/api/stats/upstream-observations/sessions',
    async (request, reply) => {
      const clientSessionId = typeof request.query.clientSessionId === 'string'
        ? request.query.clientSessionId.trim()
        : '';
      if (!clientSessionId) {
        return reply.code(400).send({ message: 'clientSessionId is required' });
      }
      const limit = parseOptionalPositiveInt(request.query.limit);
      if (limit === null) {
        return reply.code(400).send({ message: 'limit is invalid' });
      }
      return loadUpstreamProviderObservationSession({
        clientSessionId,
        ...(limit !== undefined ? { limit } : {}),
      });
    },
  );
}
