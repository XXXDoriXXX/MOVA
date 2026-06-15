import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  controllers: [],
  providers: [
    {
      provide:REDIS_CLIENT,
      useFactory: (config:ConfigService) => {
        const retryStrategy = (times: number) => Math.min(times * 50, 2000);
        // A managed Redis (Heroku Key-Value Store etc.) hands you a single
        // connection URL, and its rediss:// endpoint presents a self-signed
        // cert — accept it. Fall back to discrete host/port/password locally.
        const url = config.get<string>('REDIS_URL');
        if (url) {
          return new Redis(url, {
            retryStrategy,
            ...(url.startsWith('rediss')
              ? { tls: { rejectUnauthorized: false } }
              : {}),
          });
        }
        return new Redis({
          host:config.get<string>('REDIS_HOST'),
          port:config.get<number>('REDIS_PORT'),
          password:config.get<string>('REDIS_PASSWORD'),
          retryStrategy,
        })
      },
      inject: [ConfigService],
    }
  ],
  exports: [REDIS_CLIENT],
})
export class SharedRedisModule {}
