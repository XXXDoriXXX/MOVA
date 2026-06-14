import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConversationStyle } from '@mova-back/shared-database';
import {
  BUILTIN_STYLE_PRESETS,
  CUSTOM_STYLE_INSTRUCTIONS_MAX,
  CUSTOM_STYLE_NAME_MAX,
  customStyleId,
  isBuiltinStyleId,
  isCustomStyleId,
  isValidStyleId,
  parseCustomStyleId,
  type BuiltinStylePreset,
} from '@mova-back/shared-realtime';

export interface CreateCustomStyleInput {
  name: string;
  instructions: string;
}

export interface UpdateCustomStyleInput {
  name?: string;
  instructions?: string;
}

export interface BuiltinStyleSummary extends BuiltinStylePreset {
  kind: 'builtin';
}

export interface CustomStyleSummary {
  kind: 'custom';
  id: string;
  uuid: string;
  name: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}

export type StyleSummary = BuiltinStyleSummary | CustomStyleSummary;

export interface ListStylesResponse {
  builtin: BuiltinStyleSummary[];
  custom: CustomStyleSummary[];
}

@Injectable()
export class ConversationStylesService {
  private readonly logger = new Logger(ConversationStylesService.name);

  constructor(
    @InjectRepository(ConversationStyle)
    private readonly styles: Repository<ConversationStyle>,
  ) {}

  async listForUser(userId: string): Promise<ListStylesResponse> {
    const customs = await this.styles.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
    return {
      builtin: Object.values(BUILTIN_STYLE_PRESETS).map((preset) => ({
        ...preset,
        kind: 'builtin' as const,
      })),
      custom: customs.map((row) => this.toCustomSummary(row)),
    };
  }

  async create(
    userId: string,
    input: CreateCustomStyleInput,
  ): Promise<CustomStyleSummary> {
    const name = this.requireBoundedString(input.name, CUSTOM_STYLE_NAME_MAX, 'name');
    const instructions = this.requireBoundedString(
      input.instructions,
      CUSTOM_STYLE_INSTRUCTIONS_MAX,
      'instructions',
    );

    const saved = await this.styles.save(
      this.styles.create({ userId, name, instructions }),
    );
    this.logger.log(`Custom style created userId=${userId} id=${saved.id}`);
    return this.toCustomSummary(saved);
  }

  async update(
    userId: string,
    wireId: string,
    input: UpdateCustomStyleInput,
  ): Promise<CustomStyleSummary> {
    const row = await this.requireOwnedCustom(userId, wireId);

    if (input.name !== undefined) {
      row.name = this.requireBoundedString(input.name, CUSTOM_STYLE_NAME_MAX, 'name');
    }
    if (input.instructions !== undefined) {
      row.instructions = this.requireBoundedString(
        input.instructions,
        CUSTOM_STYLE_INSTRUCTIONS_MAX,
        'instructions',
      );
    }
    const saved = await this.styles.save(row);
    return this.toCustomSummary(saved);
  }

  async delete(userId: string, wireId: string): Promise<void> {
    const row = await this.requireOwnedCustom(userId, wireId);
    await this.styles.delete({ id: row.id });
  }

  async resolveById(
    userId: string | null,
    wireId: string,
  ): Promise<StyleSummary | null> {
    if (!isValidStyleId(wireId)) return null;
    if (isBuiltinStyleId(wireId)) {
      const preset = Object.values(BUILTIN_STYLE_PRESETS).find((p) => p.id === wireId);
      return preset ? { ...preset, kind: 'builtin' } : null;
    }
    const uuid = parseCustomStyleId(wireId);
    if (!uuid || !userId) return null;
    const row = await this.styles.findOne({ where: { id: uuid, userId } });
    return row ? this.toCustomSummary(row) : null;
  }

  async assertValidForUser(userId: string, wireId: string): Promise<void> {
    if (!isValidStyleId(wireId)) {
      throw new BadRequestException(
        `Invalid styleId: ${wireId}. Expected builtin:<key> or custom:<uuid>.`,
      );
    }
    if (isCustomStyleId(wireId)) {
      const resolved = await this.resolveById(userId, wireId);
      if (!resolved) {
        throw new NotFoundException(`Custom style ${wireId} not found`);
      }
    }
  }

  private async requireOwnedCustom(
    userId: string,
    wireId: string,
  ): Promise<ConversationStyle> {
    const uuid = parseCustomStyleId(wireId);
    if (!uuid) {
      throw new BadRequestException(
        `Invalid custom style id: ${wireId} (expected custom:<uuid>)`,
      );
    }
    const row = await this.styles.findOne({ where: { id: uuid, userId } });
    if (!row) {
      throw new NotFoundException(`Custom style ${wireId} not found`);
    }
    return row;
  }

  private requireBoundedString(value: string, max: number, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(`${field} must not be empty`);
    }
    if (trimmed.length > max) {
      throw new BadRequestException(`${field} exceeds ${max} chars`);
    }
    return trimmed;
  }

  private toCustomSummary(row: ConversationStyle): CustomStyleSummary {
    return {
      kind: 'custom',
      id: customStyleId(row.id),
      uuid: row.id,
      name: row.name,
      instructions: row.instructions,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
