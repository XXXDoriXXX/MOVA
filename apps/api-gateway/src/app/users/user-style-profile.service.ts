import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Conversation,
  STYLE_EXEMPLAR_CAP,
  UserStyleProfile,
  type StyleExemplar,
} from '@mova-back/shared-database';

export const STYLE_MIN_CONTENT_LENGTH = 12;

export const STYLE_EXEMPLAR_MAX_CHARS = 280;

export interface UserStyleProfileSummary {
  sampleCount: number;
  totalChars: number;
  avgMessageLength: number;
  exemplars: StyleExemplar[];
  lastUpdatedAt: string | null;
}

@Injectable()
export class UserStyleProfileService {
  private readonly logger = new Logger(UserStyleProfileService.name);

  constructor(
    @InjectRepository(UserStyleProfile)
    private readonly profiles: Repository<UserStyleProfile>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
  ) {}

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

  async recordTypedMessage(
    userId: string,
    content: string,
  ): Promise<UserStyleProfile | null> {
    const trimmed = content.trim();
    if (trimmed.length < STYLE_MIN_CONTENT_LENGTH) return null;

    const truncated = trimmed.slice(0, STYLE_EXEMPLAR_MAX_CHARS);

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

  async reset(userId: string): Promise<void> {
    await this.profiles.delete({ userId });
  }
}

export function appendCapped(
  pool: StyleExemplar[],
  entry: StyleExemplar,
): StyleExemplar[] {
  const next = [...pool, entry];
  if (next.length <= STYLE_EXEMPLAR_CAP) return next;
  return next.slice(next.length - STYLE_EXEMPLAR_CAP);
}
