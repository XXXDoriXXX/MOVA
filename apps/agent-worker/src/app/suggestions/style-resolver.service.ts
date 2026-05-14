import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConversationStyle } from '@mova-back/shared-database';
import {
  BUILTIN_STYLE_IDS,
  BUILTIN_STYLE_PRESETS,
  isBuiltinStyleId,
  isCustomStyleId,
  parseBuiltinStyleKey,
  parseCustomStyleId,
} from '@mova-back/shared-realtime';

import { UserStyleReaderService } from './user-style-reader.service';

/**
 * Hard cap on the resolved style addendum. Custom styles are capped at 2KB
 * in the DB column already; this is the extra-defensive bound applied at
 * read time so a misbehaving migration / corrupted row can't blow the
 * prompt budget.
 */
const STYLE_ADDENDUM_MAX_BYTES = 2_500;

/**
 * Resolves a wire-format style ID into the prompt block that
 * SuggestionsService injects into the system prompt.
 *
 * Three branches:
 *   - `builtin:official` / `builtin:friendly` → static instruction string
 *     from BUILTIN_STYLE_PRESETS.
 *   - `builtin:personal` → delegate to UserStyleReaderService; if the user
 *     has not warmed up yet, fall back to FRIENDLY. PERSONAL is the
 *     "smart default" — the user gets neutral-friendly until enough typed
 *     samples accrue to mimic them.
 *   - `custom:<uuid>` → fetch from DB (filtered to owning userId so a
 *     malicious wire id can't expose another user's style row). Missing /
 *     deleted rows degrade to FRIENDLY rather than throw — keeps the
 *     suggestions path crash-proof.
 *
 * Returns null only on `userId === null` cold-paths (legacy calls without
 * authenticated context). Callers that get null skip style injection.
 */
@Injectable()
export class StyleResolverService {
  private readonly logger = new Logger(StyleResolverService.name);

  constructor(
    @InjectRepository(ConversationStyle)
    private readonly customStyles: Repository<ConversationStyle>,
    private readonly userStyle: UserStyleReaderService,
  ) {}

  async resolve(
    userId: string | null | undefined,
    styleId: string | null | undefined,
  ): Promise<string | null> {
    // Normalise — the agent context defaults are not enforced at the type
    // level upstream, so be defensive.
    const id = styleId && styleId.trim().length > 0 ? styleId.trim() : null;

    if (!id) {
      // No explicit style → behave like PERSONAL (which itself falls back to
      // FRIENDLY when the user hasn't warmed up).
      return this.resolveBuiltin(userId ?? null, BUILTIN_STYLE_IDS.PERSONAL);
    }

    if (isBuiltinStyleId(id)) {
      return this.resolveBuiltin(userId ?? null, id);
    }

    if (isCustomStyleId(id)) {
      if (!userId) {
        this.logger.warn(
          `Custom style requested but no userId — falling back to FRIENDLY`,
        );
        return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
      }
      return this.resolveCustom(userId, id);
    }

    // Malformed id — log and fall through to FRIENDLY. Never throw on the
    // suggestion-hot-path.
    this.logger.warn(`Unknown style id shape "${id}" — using FRIENDLY default`);
    return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
  }

  // ── helpers ─────────────────────────────────────────

  private async resolveBuiltin(
    userId: string | null,
    id: string,
  ): Promise<string | null> {
    const key = parseBuiltinStyleKey(id);
    if (!key) {
      this.logger.warn(`Unknown builtin key in "${id}" — using FRIENDLY default`);
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    if (key === 'personal') {
      // PERSONAL is dynamic — render from the user's profile.
      const addendum = await this.userStyle.buildPromptAddendum(userId);
      if (addendum) return this.cap(addendum);
      // Cold-start fallback: behave like FRIENDLY so the user still gets
      // suggestions in a sane register before their profile warms up.
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    const preset = BUILTIN_STYLE_PRESETS[key];
    return preset.instructions ? this.cap(preset.instructions) : null;
  }

  private async resolveCustom(userId: string, id: string): Promise<string> {
    const uuid = parseCustomStyleId(id);
    if (!uuid) {
      // Already shape-checked by isCustomStyleId, but guard anyway.
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    let row: ConversationStyle | null;
    try {
      // Filtering on userId here is the cross-tenant guard — even if a
      // malicious client guesses someone else's UUID, the row won't return.
      row = await this.customStyles.findOne({ where: { id: uuid, userId } });
    } catch (err) {
      this.logger.warn(
        `Custom style read failed for ${id}: ${
          err instanceof Error ? err.message : String(err)
        } — using FRIENDLY default`,
      );
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    if (!row) {
      // Style was deleted while a stale template / preference still points at
      // its id. Degrade silently — surfacing an error mid-call would be worse.
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    return this.cap(this.renderCustom(row));
  }

  private renderCustom(row: ConversationStyle): string {
    // Wrap user instructions in the same block markers as built-ins so the
    // LLM treats them uniformly.
    return [
      `--- Conversation style: CUSTOM (${row.name}) ---`,
      row.instructions,
      `Apply this style to all suggestions in this conversation.`,
    ].join('\n');
  }

  private cap(text: string | null): string | null {
    if (text == null) return null;
    if (Buffer.byteLength(text, 'utf8') <= STYLE_ADDENDUM_MAX_BYTES) return text;
    // Best-effort truncation at byte boundary; we don't try to preserve UTF-8
    // boundaries because the LLM tolerates a single stray cut at worst.
    return text.slice(0, STYLE_ADDENDUM_MAX_BYTES);
  }
}
