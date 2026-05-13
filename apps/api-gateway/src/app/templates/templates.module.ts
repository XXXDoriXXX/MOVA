import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LakeraGuardService } from '@mova-back/shared-auth';
import { Template } from '@mova-back/shared-database';

import { UsersModule } from '../users/users.module';
import { TemplatesController } from './templates.controller';
import { TemplatesSeed } from './templates.seed';
import { TemplatesService } from './templates.service';

@Module({
  imports: [UsersModule, TypeOrmModule.forFeature([Template])],
  providers: [TemplatesService, TemplatesSeed, LakeraGuardService],
  controllers: [TemplatesController],
  exports: [TemplatesService],
})
export class TemplatesModule {}
