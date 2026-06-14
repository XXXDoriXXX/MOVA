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

const STYLE_ADDENDUM_MAX_BYTES = 2_500;

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
    const id = styleId && styleId.trim().length > 0 ? styleId.trim() : null;

    if (!id) {
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

    this.logger.warn(`Unknown style id shape "${id}" — using FRIENDLY default`);
    return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
  }

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
      const addendum = await this.userStyle.buildPromptAddendum(userId);
      if (addendum) return this.cap(addendum);
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    const preset = BUILTIN_STYLE_PRESETS[key];
    return preset.instructions ? this.cap(preset.instructions) : null;
  }

  private async resolveCustom(userId: string, id: string): Promise<string> {
    const uuid = parseCustomStyleId(id);
    if (!uuid) {
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    let row: ConversationStyle | null;
    try {
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
      return this.cap(BUILTIN_STYLE_PRESETS.friendly.instructions);
    }
    return this.cap(this.renderCustom(row));
  }

  private renderCustom(row: ConversationStyle): string {
    return [
      `--- Conversation style: CUSTOM (${row.name}) ---`,
      row.instructions,
      `Apply this style to all suggestions in this conversation.`,
    ].join('\n');
  }

  private cap(text: string | null): string | null {
    if (text == null) return null;
    if (Buffer.byteLength(text, 'utf8') <= STYLE_ADDENDUM_MAX_BYTES) return text;
    return text.slice(0, STYLE_ADDENDUM_MAX_BYTES);
  }
}
