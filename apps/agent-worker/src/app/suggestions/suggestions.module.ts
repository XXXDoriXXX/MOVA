import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationStyle, UserStyleProfile } from '@mova-back/shared-database';

import { ProvidersModule } from '../providers/providers.module';
import { StyleResolverService } from './style-resolver.service';
import { SuggestionsService } from './suggestions.service';
import { UserStyleReaderService } from './user-style-reader.service';

/**
 * Smart-reply suggestions + per-conversation style adaptation.
 *
 * Depends on:
 *   - ProvidersModule (LLM access via the registry)
 *   - SharedRedisModule (global, for the publish step)
 *   - TypeOrmModule.forFeature([UserStyleProfile, ConversationStyle]) —
 *     UserStyleReader uses the first for "learned personal voice", and
 *     StyleResolver uses the second to resolve custom styles by id.
 *     Strictly read-only on both tables.
 *
 * No DB WRITES here — Suggestion rows are persisted by api-gateway when
 * it consumes the `suggestions.generated` event from Redis.
 */
@Module({
  imports: [
    ProvidersModule,
    TypeOrmModule.forFeature([UserStyleProfile, ConversationStyle]),
  ],
  providers: [SuggestionsService, UserStyleReaderService, StyleResolverService],
  exports: [SuggestionsService, StyleResolverService],
})
export class SuggestionsModule {}
