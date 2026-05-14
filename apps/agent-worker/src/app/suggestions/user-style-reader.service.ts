import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  UserStyleProfile,
  type StyleExemplar,
} from '@mova-back/shared-database';

/**
 * Below this sample threshold, we don't inject style guidance — the model
 * would over-fit on tiny sample sizes and the user's "voice" hasn't been
 * established yet. 3 keeps cold-start short while ensuring the addendum
 * carries real signal.
 */
export const STYLE_WARMUP_MIN_SAMPLES = 3;

/**
 * Hard cap on exemplar bytes injected — prevents a power user with 10
 * long exemplars from dominating the suggestions prompt budget. Most
 * exemplars are < 100 chars; a 10-row cap of ~1.2kB fits comfortably.
 */
const STYLE_PROMPT_BYTES_CAP = 1_200;

/**
 * Agent-worker–side reader for the per-user style profile that api-gateway
 * maintains. Strictly read-only: writes happen in the events consumer.
 *
 * Design choice — direct DB read (not HTTP / Redis fetch):
 *   - agent-worker already has a SharedDatabaseModule connection (used by
 *     ProviderRegistry → incidents writes). Reuse the pool.
 *   - Per-turn read; we want sub-ms latency on the hot path. A localhost
 *     HTTP call would add 1–3ms; a Redis cache layer adds invalidation
 *     complexity for tiny benefit. Postgres on the PK is plenty fast.
 *
 * Eventual consistency: api-gateway writes the profile asynchronously after
 * persisting the Message. A typed-message → suggestions-request race could
 * see a profile that's one sample behind. That's acceptable — the user
 * doesn't notice "you trained on N vs N+1 messages".
 */
@Injectable()
export class UserStyleReaderService {
  private readonly logger = new Logger(UserStyleReaderService.name);

  constructor(
    @InjectRepository(UserStyleProfile)
    private readonly profiles: Repository<UserStyleProfile>,
  ) {}

  /**
   * Fetch + render a prompt addendum. Returns null when:
   *   - no userId supplied (call without auth context — shouldn't happen
   *     post-Phase 4 but defensive)
   *   - profile doesn't exist (cold-start: user never typed a qualifying
   *     message)
   *   - sample count is below warmup threshold (too little signal)
   *   - exemplars array is empty (corrupt row — log + skip)
   *
   * Callers MUST tolerate null and fall back to neutral suggestions.
   */
  async buildPromptAddendum(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    let row: UserStyleProfile | null;
    try {
      row = await this.profiles.findOne({ where: { userId } });
    } catch (err) {
      // DB blip on the read side. Suggestions don't NEED the style boost —
      // degrade quietly to neutral mode rather than fail the turn.
      this.logger.debug(
        `Style profile read failed for user=${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    if (!row) return null;
    if (row.sampleCount < STYLE_WARMUP_MIN_SAMPLES) return null;
    if (!row.exemplarMessages || row.exemplarMessages.length === 0) return null;

    return renderStylePrompt(row.exemplarMessages, {
      avgLength: row.avgMessageLength,
      sampleCount: row.sampleCount,
    });
  }
}

/**
 * Pure function — easy to unit-test without TypeORM. Exported for tests.
 *
 * Output format is intentionally English-instruction + verbatim Ukrainian
 * (or whatever language) examples. LLMs respond better to instructions
 * in English even when the target output is another language — the
 * instructions don't bleed into the response, and we keep one canonical
 * phrasing across template languages.
 */
export function renderStylePrompt(
  exemplars: StyleExemplar[],
  stats: { avgLength: number; sampleCount: number },
): string {
  // Sort newest-first; recency matters more than equal-weighting.
  const sorted = [...exemplars].sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });

  // Pick as many as fit in the byte budget; we always include at least the
  // newest one (a single example beats no examples).
  const picked: string[] = [];
  let bytes = 0;
  for (const ex of sorted) {
    const line = `- "${ex.content.replace(/"/g, '\\"')}"`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (picked.length > 0 && bytes + lineBytes > STYLE_PROMPT_BYTES_CAP) break;
    picked.push(line);
    bytes += lineBytes;
  }

  return [
    `--- User's writing style (mimic this in suggestions) ---`,
    `Sample size: ${stats.sampleCount} messages, average length ~${stats.avgLength} chars.`,
    `Examples of how THIS user actually writes:`,
    ...picked,
    `Match this user's dialect, slang, punctuation habits, sentence length,`,
    `and formality level. If they use regional words or rare phrasings,`,
    `prefer those over textbook synonyms. Do NOT translate their dialect to`,
    `standard form. The goal is suggestions that sound like the user wrote them.`,
  ].join('\n');
}
