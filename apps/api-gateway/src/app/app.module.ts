import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from '@mova-back/shared-config';
import { SharedRedisModule } from '@mova-back/shared-redis';
import { CallModule } from './call/call.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal:true,
      validate: (config) =>{
        const parsed = envSchema.safeParse(config);
        if(!parsed.success){
          console.error('[FATAL]: Invalid Configuration', parsed.error.format());
          throw new Error('Invalid configuration');
        }
        return parsed.data;
      }
    }),
    SharedRedisModule,
    CallModule,
    UsersModule,
    AuthModule
  ],
})
export class AppModule {}
