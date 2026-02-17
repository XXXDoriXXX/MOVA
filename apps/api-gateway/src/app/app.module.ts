import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envSchema } from '@mova-back/shared-config';
import { ConfigModule } from '@nestjs/config';
import { SharedRedisModule } from '@mova-back/shared-redis';
import { CallController } from './call/call.controller';
import { CallService } from './call/call.service';

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
    SharedRedisModule
  ],
  controllers: [CallController],
  providers: [CallService],
})
export class AppModule {}
