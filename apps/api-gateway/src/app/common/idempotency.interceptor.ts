import { createHash } from 'crypto';

import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { type Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import type { AuthenticatedUser } from '@mova-back/shared-auth';

/** Cached envelope. Captures both the response body AND the status so a
 *  replay returns 100% the same wire envelope. */
interface CachedResponse {
  status: number;
  body: unknown;
  // Original timestamp so the client can see if a replay is being served
  // (useful for debugging "why did my server time not update").
  cachedAt: string;
}

/** Per-key cache TTL. 24h matches Stripe's documented idempotency window
 *  — long enough that a flaky network + manual retry tomorrow morning is
 *  still safe, short enough that the user's request history doesn't
 *  pile up in Redis indefinitely. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Bounds on the client-supplied key so we don't blow up Redis memory on
 *  pathological clients. The spec recommends UUIDs (36 chars); we accept
 *  anything up to 200 chars to leave headroom for app-specific prefixes. */
const MAX_KEY_LENGTH = 200;

/**
 * Idempotency-Key interceptor for mutating POST endpoints.
 *
 * Contract (mirrors Stripe / GitHub semantics):
 *
 *   - Client sends `Idempotency-Key: <unique-string>` header on the
 *     first request. Server processes it, caches the response.
 *   - On retry with the SAME key + same body hash, the server returns
 *     the cached response and skips the handler entirely. No duplicate
 *     SIP dial, no double-billing, no orphan conversation row.
 *   - If retry sends DIFFERENT body under same key, we treat that as
 *     misuse and let it through (current behaviour) — clients should
 *     never reuse a key with different payload. Logged at warn level
 *     for visibility.
 *   - Missing header → bypass entirely. Idempotency is opt-in; legacy
 *     clients that don't send it keep working.
 *   - Non-2xx responses are NOT cached. A 4xx from validation should
 *     be retry-able after the client fixes its input, not blocked
 *     by a stale failure.
 *
 * Race: two concurrent requests with the same key both miss the cache,
 * both proceed, both write the cache. The second write wins. For
 * /calls/start this isn't a real problem — the per-user concurrent
 * call limit (Phase 2.3) rejects the second one anyway. For /billing/topup
 * the payment provider itself is the source of truth (PaymentEvent has
 * a UNIQUE externalId). A future Phase 3.1 Redlock will close even
 * that tiny window if needed.
 *
 * Cache key includes a body hash so distinct payloads under the same
 * client-supplied key are namespaced separately (a misbehaving client
 * doesn't poison another payload's slot).
 *
 * Scope: keys are namespaced per-authed-user (or per-IP for pre-auth
 * routes). A user can't observe another user's cached response by
 * guessing keys.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<
      Request & { user?: AuthenticatedUser }
    >();
    const res = http.getResponse<Response>();

    const rawKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
    if (!rawKey) {
      // Opt-in only. No header → handler runs as usual.
      return next.handle();
    }
    if (rawKey.length > MAX_KEY_LENGTH) {
      // Don't 400 the client — that turns a misformed retry into a
      // permanent failure. Just skip caching and proceed. The handler
      // will succeed on its own merits.
      this.logger.warn({
        msg: 'idempotency.keyTooLong',
        keyLength: rawKey.length,
      });
      return next.handle();
    }

    const scope = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const bodyHash = hashBody(req.body);
    const redisKey = `idem:${scope}:${rawKey}:${bodyHash}`;

    // Cache lookup.
    let cachedRaw: string | null;
    try {
      cachedRaw = await this.redis.get(redisKey);
    } catch (err) {
      // Redis blip should never break a real request. Log and proceed —
      // worst case is one accidental duplicate, which the call-limit /
      // payment-event constraint protects against anyway.
      this.logger.warn({
        msg: 'idempotency.redisGetFailed',
        error: (err as Error).message,
      });
      return next.handle();
    }
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as CachedResponse;
        res.status(cached.status);
        res.setHeader('Idempotency-Replayed', 'true');
        res.setHeader('Idempotency-Cached-At', cached.cachedAt);
        return of(cached.body);
      } catch (err) {
        // Corrupted cache entry — log + treat as miss. Don't poison
        // the route by returning bad data.
        this.logger.warn({
          msg: 'idempotency.cacheParseFailed',
          redisKey,
          error: (err as Error).message,
        });
      }
    }

    // Cache miss: execute the handler, then store the response on success.
    return next.handle().pipe(
      tap({
        next: (body) => {
          // statusCode is set by NestJS after handler resolves. Default 200.
          const status = res.statusCode;
          if (status < 200 || status >= 300) return; // skip caching non-2xx
          const payload: CachedResponse = {
            status,
            body,
            cachedAt: new Date().toISOString(),
          };
          this.redis
            .set(redisKey, JSON.stringify(payload), 'EX', IDEMPOTENCY_TTL_SECONDS)
            .catch((err: Error) => {
              this.logger.warn({
                msg: 'idempotency.cacheStoreFailed',
                redisKey,
                error: err.message,
              });
            });
        },
      }),
    );
  }
}

/** Stable hash of the request body so cached responses are namespaced
 *  by payload. SHA-256 because collisions here would cross-pollute
 *  payloads under the same client key. */
function hashBody(body: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(body ?? {});
  } catch {
    // Circular reference / BigInt — give it an unguessable hash so it
    // can never match another request and effectively disables caching
    // for this oddball payload.
    serialized = String(Math.random());
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}
