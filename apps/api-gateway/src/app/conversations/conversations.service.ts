import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, QueryFailedError, Repository } from 'typeorm';

import {
  Conversation,
  ConversationEndReason,
  ConversationStatus,
  ConversationType,
  Message,
  MessageRole,
  MessageSource,
  Suggestion,
  TtsStatus,
} from '@mova-back/shared-database';

interface CreateConversationInput {
  userId: string;
  templateId?: string | null;
  targetPhone?: string | null;
  livekitRoom: string;
  callType?: ConversationType;
  callerUserId?: string | null;
  initialLlmProvider?: string | null;
  initialTtsProvider?: string | null;
  initialVoice?: string | null;
  initialPlanSource?: string | null;
  initialPricePerSecondCents?: number | null;
  billingSecondsMultiplier?: number;
}

interface EndConversationInput {
  conversationId: string;
  reason: ConversationEndReason;
  errorCode?: string;
  endedAt?: Date;
}

interface InsertMessageInput {
  id?: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  ttsStatus?: TtsStatus | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  ttsProvider?: string | null;
  ttsVoice?: string | null;
  durationMs?: number | null;
  source?: MessageSource | null;
}

export interface ListConversationsQuery {
  userId: string;
  status?: ConversationStatus;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const APPEND_SUGGESTIONS_MAX_RETRIES = 5;
const APPEND_SUGGESTIONS_RETRY_DELAY_MS = 100;

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Suggestion) private readonly suggestions: Repository<Suggestion>,
  ) {}

  async createPending(input: CreateConversationInput): Promise<Conversation> {
    const entity = this.conversations.create({
      userId: input.userId,
      templateId: input.templateId ?? null,
      targetPhone: input.targetPhone ?? null,
      livekitRoom: input.livekitRoom,
      callType: input.callType ?? ConversationType.SIP_OUTBOUND,
      callerUserId: input.callerUserId ?? null,
      status: ConversationStatus.PENDING,
      initialLlmProvider: input.initialLlmProvider ?? null,
      initialTtsProvider: input.initialTtsProvider ?? null,
      initialVoice: input.initialVoice ?? null,
      initialPlanSource: input.initialPlanSource ?? null,
      initialPricePerSecondCents: input.initialPricePerSecondCents ?? null,
      billingSecondsMultiplier: input.billingSecondsMultiplier ?? 1,
      startedAt: new Date(),
    });
    try {
      return await this.conversations.save(entity);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'CALL_IN_PROGRESS',
          message:
            'Already on a call. End the current one before starting another.',
        });
      }
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      (err as QueryFailedError & { code?: string }).code === '23505'
    );
  }

  async markConnected(conversationId: string, connectedAt: Date = new Date()): Promise<void> {
    await this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({ status: ConversationStatus.ACTIVE, connectedAt })
      .where('id = :id AND "status" = :pending', {
        id: conversationId,
        pending: ConversationStatus.PENDING,
      })
      .execute();
  }

  async markAnswered(conversationId: string, answeredAt: Date = new Date()): Promise<void> {
    await this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({ answeredAt })
      .where('id = :id AND "answeredAt" IS NULL', { id: conversationId })
      .execute();
  }

  async markEnded(input: EndConversationInput): Promise<Conversation> {
    const conv = await this.conversations.findOne({ where: { id: input.conversationId } });
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }
    const endedAt = conv.endedAt ?? input.endedAt ?? new Date();
    const durationSeconds = conv.answeredAt
      ? Math.max(0, Math.floor((endedAt.getTime() - conv.answeredAt.getTime()) / 1000))
      : 0;

    const status =
      input.reason === ConversationEndReason.FATAL_ERROR
        ? ConversationStatus.FAILED
        : ConversationStatus.ENDED;

    await this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({
        status,
        endedAt,
        durationSeconds,
        endReason: input.reason,
        errorCode: input.errorCode ?? null,
      })
      .where('id = :id', { id: input.conversationId })
      .execute();

    return (await this.conversations.findOne({ where: { id: input.conversationId } }))!;
  }

  async countActiveForUser(userId: string): Promise<number> {
    return this.conversations.count({
      where: [
        { userId, status: ConversationStatus.PENDING },
        { userId, status: ConversationStatus.ACTIVE },
      ],
    });
  }

  async countActiveInvolving(userId: string): Promise<number> {
    return this.conversations
      .createQueryBuilder('c')
      .where('c."status" IN (:...statuses)', {
        statuses: [ConversationStatus.PENDING, ConversationStatus.ACTIVE],
      })
      .andWhere('(c."userId" = :userId OR c."callerUserId" = :userId)', {
        userId,
      })
      .getCount();
  }

  async findOrphaned(
    maxCallDurationSeconds: number,
    pendingStaleMinutes: number,
    activeMarginSeconds: number,
  ): Promise<Conversation[]> {
    const now = Date.now();
    const pendingCutoff = new Date(now - pendingStaleMinutes * 60_000);
    const activeCutoff = new Date(
      now - (maxCallDurationSeconds + activeMarginSeconds) * 1000,
    );
    return this.conversations
      .createQueryBuilder('c')
      .where(
        new Brackets((qb) => {
          qb.where(
            'c."status" = :pending AND c."updatedAt" < :pendingCutoff',
            { pending: ConversationStatus.PENDING, pendingCutoff },
          )
            .orWhere(
              'c."status" = :active AND c."answeredAt" IS NOT NULL AND c."answeredAt" < :activeCutoff',
              { active: ConversationStatus.ACTIVE, activeCutoff },
            )
            .orWhere(
              'c."status" = :activeStuck AND c."answeredAt" IS NULL AND c."updatedAt" < :pendingCutoff',
              { activeStuck: ConversationStatus.ACTIVE, pendingCutoff },
            );
        }),
      )
      .getMany();
  }

  async listForUser(query: ListConversationsQuery): Promise<CursorPage<Conversation>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const qb = this.conversations
      .createQueryBuilder('c')
      .leftJoin('c.caller', 'caller')
      .addSelect(['caller.id', 'caller.name'])
      .where('c."userId" = :userId AND c."deletedAt" IS NULL', { userId: query.userId })
      .orderBy('c."startedAt"', 'DESC')
      .limit(limit + 1);

    if (query.status) {
      qb.andWhere('c."status" = :status', { status: query.status });
    }
    if (query.from) {
      qb.andWhere('c."startedAt" >= :from', { from: query.from });
    }
    if (query.to) {
      qb.andWhere('c."startedAt" <= :to', { to: query.to });
    }
    if (query.cursor) {
      const cursorDate = new Date(query.cursor);
      qb.andWhere('c."startedAt" < :cursor', { cursor: cursorDate });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].startedAt.toISOString() : null;

    return { items, nextCursor };
  }

  async findById(conversationId: string): Promise<Conversation | null> {
    return this.conversations.findOne({
      where: { id: conversationId, deletedAt: IsNull() },
    });
  }

  async findOneForUser(userId: string, conversationId: string): Promise<Conversation> {
    const conv = await this.conversations
      .createQueryBuilder('c')
      .leftJoin('c.caller', 'caller')
      .addSelect(['caller.id', 'caller.name'])
      .where('c."id" = :id AND c."deletedAt" IS NULL', { id: conversationId })
      .getOne();
    if (!conv || conv.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }
    return conv;
  }

  async listMessages(
    userId: string,
    conversationId: string,
    after?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<CursorPage<Message>> {
    await this.findOneForUser(userId, conversationId);

    const cappedLimit = Math.min(limit, MAX_PAGE_SIZE);
    const qb = this.messages
      .createQueryBuilder('m')
      .where('m."conversationId" = :cid', { cid: conversationId })
      .orderBy('m."createdAt"', 'ASC')
      .limit(cappedLimit + 1);

    if (after) {
      qb.andWhere('m."createdAt" > :after', { after: new Date(after) });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > cappedLimit;
    const items = hasMore ? rows.slice(0, cappedLimit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;
    return { items, nextCursor };
  }

  async softDelete(userId: string, conversationId: string): Promise<void> {
    await this.findOneForUser(userId, conversationId);
    await this.conversations.softDelete({ id: conversationId });
  }

  async appendMessage(input: InsertMessageInput): Promise<Message> {
    return this.messages.save({
      ...(input.id ? { id: input.id } : {}),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      ttsStatus: input.ttsStatus ?? null,
      llmProvider: input.llmProvider ?? null,
      llmModel: input.llmModel ?? null,
      ttsProvider: input.ttsProvider ?? null,
      ttsVoice: input.ttsVoice ?? null,
      durationMs: input.durationMs ?? null,
      source:
        input.role === MessageRole.USER_TYPED ? input.source ?? null : null,
    });
  }

  async markMessageInterrupted(messageId: string): Promise<void> {
    await this.messages
      .createQueryBuilder()
      .update(Message)
      .set({ ttsStatus: TtsStatus.INTERRUPTED })
      .where('id = :id AND "ttsStatus" = :completed', {
        id: messageId,
        completed: TtsStatus.COMPLETED,
      })
      .execute();
  }

  async appendSuggestions(
    conversationId: string,
    parentMessageId: string,
    items: Array<{ id?: string; content: string }>,
  ): Promise<Suggestion[]> {
    if (items.length !== 3) {
      throw new Error(`Expected exactly 3 suggestions, got ${items.length}`);
    }
    const rows = items.map((item, idx) => ({
      conversationId,
      parentMessageId,
      content: item.content,
      position: idx + 1,
      wasChosen: false,
    }));
    let lastErr: unknown;
    for (let attempt = 0; attempt < APPEND_SUGGESTIONS_MAX_RETRIES; attempt++) {
      try {
        return await this.suggestions.save(rows);
      } catch (err) {
        if (!ConversationsService.isForeignKeyViolation(err)) {
          throw err;
        }
        lastErr = err;
        await new Promise((resolve) =>
          setTimeout(resolve, APPEND_SUGGESTIONS_RETRY_DELAY_MS),
        );
      }
    }
    throw lastErr;
  }

  private static isForeignKeyViolation(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    return (err as QueryFailedError & { code?: string }).code === '23503';
  }

  async markSuggestionChosen(suggestionId: string): Promise<Suggestion | null> {
    const result = await this.suggestions
      .createQueryBuilder()
      .update(Suggestion)
      .set({ wasChosen: true })
      .where('id = :id AND "wasChosen" = false', { id: suggestionId })
      .returning('*')
      .execute();
    return (result.raw as Suggestion[])[0] ?? null;
  }

}
