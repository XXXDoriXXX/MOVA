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

interface CachedResponse {
  status: number;
  body: unknown;
  cachedAt: string;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

const MAX_KEY_LENGTH = 200;

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
      return next.handle();
    }
    if (rawKey.length > MAX_KEY_LENGTH) {
      this.logger.warn({
        msg: 'idempotency.keyTooLong',
        keyLength: rawKey.length,
      });
      return next.handle();
    }

    const scope = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const bodyHash = hashBody(req.body);
    const redisKey = `idem:${scope}:${rawKey}:${bodyHash}`;

    let cachedRaw: string | null;
    try {
      cachedRaw = await this.redis.get(redisKey);
    } catch (err) {
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
        this.logger.warn({
          msg: 'idempotency.cacheParseFailed',
          redisKey,
          error: (err as Error).message,
        });
      }
    }

    return next.handle().pipe(
      tap({
        next: (body) => {
          const status = res.statusCode;
          if (status < 200 || status >= 300) return;
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

function hashBody(body: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(body ?? {});
  } catch {
    serialized = String(Math.random());
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}
