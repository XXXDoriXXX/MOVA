import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationStyle, UserStyleProfile } from '@mova-back/shared-database';

import { ProvidersModule } from '../providers/providers.module';
import { StyleResolverService } from './style-resolver.service';
import { SuggestionsService } from './suggestions.service';
import { UserStyleReaderService } from './user-style-reader.service';

@Module({
  imports: [
    ProvidersModule,
    TypeOrmModule.forFeature([UserStyleProfile, ConversationStyle]),
  ],
  providers: [SuggestionsService, UserStyleReaderService, StyleResolverService],
  exports: [SuggestionsService, StyleResolverService],
})
export class SuggestionsModule {}
