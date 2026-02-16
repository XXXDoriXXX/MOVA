import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

//Injection token for the Redis client
export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global() //make global for easy injection across the app
@Module({
  controllers: [],
  providers: [
    {
      provide:REDIS_CLIENT,
      useFactory: (config:ConfigService) => {
        return new Redis({
          host:config.get<string>('REDIS_HOST'),
          port:config.get<number>('REDIS_PORT'),
          password:config.get<string>('REDIS_PASSWORD'),
          //retry strategy
          retryStrategy: (times) => {
            const delay = Math.min(times*50,2000);
            return delay;
          }
        })
      },
      inject: [ConfigService],
    }
  ],
  exports: [REDIS_CLIENT],
})
export class SharedRedisModule {}
