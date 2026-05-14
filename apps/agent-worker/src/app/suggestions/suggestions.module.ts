import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserStyleProfile } from '@mova-back/shared-database';

import { ProvidersModule } from '../providers/providers.module';
import { SuggestionsService } from './suggestions.service';
import { UserStyleReaderService } from './user-style-reader.service';

/**
 * Smart-reply suggestions. Phase 7 + style-adaptation follow-up.
 *
 * Depends on:
 *   - ProvidersModule (LLM access via the registry)
 *   - SharedRedisModule (global, for the publish step)
 *   - TypeOrmModule.forFeature([UserStyleProfile]) so SuggestionsService
 *     can read the user's style profile at every turn. Strictly read-only;
 *     writes live in api-gateway's events consumer.
 *
 * No DB WRITES here — Suggestion rows are persisted by api-gateway when
 * it consumes the `suggestions.generated` event from Redis.
 */
@Module({
  imports: [ProvidersModule, TypeOrmModule.forFeature([UserStyleProfile])],
  providers: [SuggestionsService, UserStyleReaderService],
  exports: [SuggestionsService],
})
export class SuggestionsModule {}
