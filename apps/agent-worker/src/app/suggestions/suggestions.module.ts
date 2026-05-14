import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';
import { SuggestionsService } from './suggestions.service';

/**
 * Smart-reply suggestions. Phase 7.
 *
 * Depends on ProvidersModule (LLM access via the registry) and the global
 * SharedRedisModule (already imported at AppModule level). No DB writes
 * here — Suggestion rows are persisted by api-gateway when it consumes
 * the `suggestions.generated` event from Redis.
 */
@Module({
  imports: [ProvidersModule],
  providers: [SuggestionsService],
  exports: [SuggestionsService],
})
export class SuggestionsModule {}
