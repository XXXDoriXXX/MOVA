import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Conversation,
  STYLE_EXEMPLAR_CAP,
  UserStyleProfile,
  type StyleExemplar,
} from '@mova-back/shared-database';

/**
 * Minimum content length to count as a style sample. Short replies ("ок",
 * "так", "ні") don't carry stylistic signal — they'd just dilute the
 * exemplar pool without teaching the model anything useful about the
 * user's dialect or phrasing.
 */
export const STYLE_MIN_CONTENT_LENGTH = 12;

/** Truncate exemplars before storing — JSONB column stays bounded. */
export const STYLE_EXEMPLAR_MAX_CHARS = 280;

export interface UserStyleProfileSummary {
  sampleCount: number;
  totalChars: number;
  avgMessageLength: number;
  exemplars: StyleExemplar[];
  lastUpdatedAt: string | null;
}

/**
 * Builds and maintains the per-user "writing style" profile that
 * SuggestionsService later reads to bias reply candidates toward the
 * user's own dialect / phrasing.
 *
 * Write semantics:
 *   - One row per user (PK = userId). UPSERT on every qualifying message.
 *   - Stats (`sampleCount`, `totalChars`, `avgMessageLength`) are monotonic.
 *   - Exemplar pool is most-recent-K capped: when full, the OLDEST entry
 *     drops. Recency bias is deliberate — style evolves; we don't want a
 *     2-year-old message dominating the prompt.
 *
 * Eligibility:
 *   - Only USER_TYPED messages with `source='typed'` (mobile client typed
 *     it, did NOT tap an AI suggestion). Accepted suggestions are the AI's
 *     words; training on them would collapse the user's style into the
 *     model's default register.
 *   - Content length ≥ STYLE_MIN_CONTENT_LENGTH. Filters out trivial acks.
 *
 * Concurrency: at-least-once consumer delivery can fire the same event
 * twice for the same Message. We accept eventual over-counting (small drift
 * in sampleCount/totalChars) rather than introduce a UNIQUE(messageId)
 * constraint that would force conflict handling everywhere. The averaged
 * stat still reflects the user's voice.
 */
@Injectable()
export class UserStyleProfileService {
  private readonly logger = new Logger(UserStyleProfileService.name);

  constructor(
    @InjectRepository(UserStyleProfile)
    private readonly profiles: Repository<UserStyleProfile>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
  ) {}

  /**
   * Convenience wrapper for the events consumer — looks up the conversation
   * owner so the consumer doesn't have to re-shape its handler signature.
   *
   * Best-effort by design: a failure to record style does NOT bubble up
   * (the user's message has already been persisted; style is a side-show).
   */
  async recordFromConversation(
    conversationId: string,
    content: string,
  ): Promise<void> {
    try {
      const row = await this.conversations.findOne({
        where: { id: conversationId },
        select: { id: true, userId: true },
      });
      if (!row) {
        this.logger.warn(
          `Style record skipped — conversation ${conversationId} not found`,
        );
        return;
      }
      await this.recordTypedMessage(row.userId, content);
    } catch (err) {
      this.logger.warn(
        `Style record failed for conv=${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Core write path. Idempotency: NOT enforced — see class docstring.
   * Returns the updated row (mostly for tests; production callers ignore it).
   */
  async recordTypedMessage(
    userId: string,
    content: string,
  ): Promise<UserStyleProfile | null> {
    const trimmed = content.trim();
    if (trimmed.length < STYLE_MIN_CONTENT_LENGTH) return null;

    const truncated = trimmed.slice(0, STYLE_EXEMPLAR_MAX_CHARS);

    // Load-or-init pattern. We do a SELECT + INSERT/UPDATE rather than a
    // raw UPSERT because we need to mutate the JSONB exemplar array in
    // application code (capped FIFO). A raw UPSERT can't append-and-trim
    // a JSONB array atomically without a custom Postgres function — not
    // worth the operational complexity for a write rate this low.
    const existing = await this.profiles.findOne({ where: { userId } });
    if (!existing) {
      const created = this.profiles.create({
        userId,
        sampleCount: 1,
        totalChars: truncated.length,
        avgMessageLength: truncated.length,
        exemplarMessages: [
          { content: truncated, createdAt: new Date().toISOString() },
        ],
      });
      return this.profiles.save(created);
    }

    const newCount = existing.sampleCount + 1;
    const newTotal = existing.totalChars + truncated.length;
    const updatedExemplars = appendCapped(existing.exemplarMessages, {
      content: truncated,
      createdAt: new Date().toISOString(),
    });

    existing.sampleCount = newCount;
    existing.totalChars = newTotal;
    existing.avgMessageLength = Math.round(newTotal / newCount);
    existing.exemplarMessages = updatedExemplars;
    return this.profiles.save(existing);
  }

  /**
   * Read-side for the user-facing endpoint (GET /v1/users/me/style-profile)
   * and admin debugging. Returns null when the user has no profile yet
   * (cold-start) — mobile UI renders "AI is still learning your style".
   */
  async getSummary(userId: string): Promise<UserStyleProfileSummary | null> {
    const row = await this.profiles.findOne({ where: { userId } });
    if (!row) return null;
    return {
      sampleCount: row.sampleCount,
      totalChars: row.totalChars,
      avgMessageLength: row.avgMessageLength,
      exemplars: row.exemplarMessages,
      lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Manual reset — exposed for "delete my data" UX and for support. Wipes
   * the row entirely (the cron rebuilds from scratch only as the user types
   * new qualifying messages).
   */
  async reset(userId: string): Promise<void> {
    await this.profiles.delete({ userId });
  }
}

/**
 * Append `entry` to `pool`, capping at STYLE_EXEMPLAR_CAP. Oldest entries
 * drop first. Pure function for easy testing — no Repository, no Date.now,
 * just array math.
 */
export function appendCapped(
  pool: StyleExemplar[],
  entry: StyleExemplar,
): StyleExemplar[] {
  const next = [...pool, entry];
  if (next.length <= STYLE_EXEMPLAR_CAP) return next;
  return next.slice(next.length - STYLE_EXEMPLAR_CAP);
}
