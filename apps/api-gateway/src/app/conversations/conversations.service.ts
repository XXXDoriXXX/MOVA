import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

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
}

interface EndConversationInput {
  conversationId: string;
  reason: ConversationEndReason;
  errorCode?: string;
  endedAt?: Date;
}

interface InsertMessageInput {
  /** Optional explicit primary key. When provided (agent-worker plumbs a
   *  pre-generated UUID), the row is saved under it so cross-event FKs
   *  (suggestions → parent message) resolve. Omit to let the DB generate. */
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
  /** For role=USER_TYPED: distinguishes 'typed' vs 'suggestion'. Null otherwise. */
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

/**
 * Conversation + Message + Suggestion store.
 *
 * Cursor pagination strategy:
 *   - Cursor = ISO timestamp of the last item's createdAt/startedAt.
 *   - Stable as long as the index (userId, startedAt) holds. Ties on the
 *     exact same timestamp are extremely unlikely for human-paced calls;
 *     if they happen, we accept slight duplication over complex tie-breaking.
 *
 * No PII leaks:
 *   - Cross-user reads always return 404 (not 403) on findOneForUser.
 *   - DELETE soft-deletes; the audit row stays in DB indefinitely.
 */
@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Suggestion) private readonly suggestions: Repository<Suggestion>,
  ) {}

  // ─── Lifecycle (write side, called by call orchestrator) ────────────

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
      startedAt: new Date(),
    });
    return this.conversations.save(entity);
  }

  /**
   * Mark a conversation `active` and set connectedAt. Idempotent — re-running
   * on an already-active row is a no-op (we don't want a late SIP "joined"
   * event to clobber the original timestamp).
   */
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

  /**
   * Stamp the moment the interlocutor actually answered (SIP callStatus=active
   * / peer joined). Idempotent — only sets the first answer time, so a replayed
   * event can't move it. This is the single source of truth for billable
   * duration; a call with a null answeredAt is never billed.
   */
  async markAnswered(conversationId: string, answeredAt: Date = new Date()): Promise<void> {
    await this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({ answeredAt })
      .where('id = :id AND "answeredAt" IS NULL', { id: conversationId })
      .execute();
  }

  /**
   * Final state transition. Bills from `answeredAt` (the real pickup), NOT from
   * connect/dial time — a call that only rang and was never answered has a null
   * answeredAt and therefore durationSeconds = 0 (no charge). If status was
   * already `ended`/`failed` we DO update (allows error-reason backfill from a
   * follow-up watchdog), but reuse the existing endedAt.
   */
  async markEnded(input: EndConversationInput): Promise<Conversation> {
    const conv = await this.conversations.findOne({ where: { id: input.conversationId } });
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }
    const endedAt = conv.endedAt ?? input.endedAt ?? new Date();
    // Bill only the answered span. No answeredAt ⇒ never picked up ⇒ 0 seconds.
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

  /**
   * Count this user's calls that are in PENDING or ACTIVE state. Used by
   * call.service to refuse a new /calls/start while another one is still
   * in progress — without this, a flaky mobile retry loop or a stolen
   * JWT can dial two SIP legs at once, both bill, both confuse the user.
   *
   * Cheap query: hit covered by `idx_conversations_status_active`
   * (partial index on status IN ('pending', 'active')) — a few µs
   * regardless of total conversation table size.
   */
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

  /**
   * Find conversations that look like zombies — pending/active but no update
   * for `staleMinutes`. Watchdog cron (Phase 8) marks them failed.
   */
  async findStaleActive(staleMinutes: number): Promise<Conversation[]> {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    return this.conversations
      .createQueryBuilder('c')
      .where('c."status" IN (:...statuses)', {
        statuses: [ConversationStatus.PENDING, ConversationStatus.ACTIVE],
      })
      .andWhere('c."updatedAt" < :cutoff', { cutoff })
      .getMany();
  }

  // ─── Read side (user-facing) ────────────────────────────────────────

  async listForUser(query: ListConversationsQuery): Promise<CursorPage<Conversation>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const qb = this.conversations
      .createQueryBuilder('c')
      // Only id+name are selected for the caller — never the full User row
      // (passwordHash etc. must not leak through history serialization).
      .leftJoin('c.caller', 'caller')
      .addSelect(['caller.id', 'caller.name'])
      .where('c."userId" = :userId AND c."deletedAt" IS NULL', { userId: query.userId })
      .orderBy('c."startedAt"', 'DESC')
      .limit(limit + 1); // +1 to peek at "is there a next page"

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
      // Same 404 in both cases — never leak existence of someone else's call.
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
    // Authz check (also acts as existence check).
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
    // Validate ownership first to avoid leaking via the SOFT DELETE result.
    await this.findOneForUser(userId, conversationId);
    await this.conversations.softDelete({ id: conversationId });
  }

  // ─── Message + suggestion writes (called by agent-worker IPC) ───────

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
      // source only meaningful for USER_TYPED; defensively null otherwise so
      // the column never claims an AI message was "typed by the user".
      source:
        input.role === MessageRole.USER_TYPED ? input.source ?? null : null,
    });
  }

  /**
   * Flip a message's ttsStatus from `completed` to `interrupted`. Only
   * applies if the current status is `completed` — re-marking is a no-op
   * (the user can't un-interrupt a stopped TTS).
   */
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
    return this.suggestions.save(rows);
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

  /**
   * Prune zombie conversations older than `cutoff` that are still pending
   * or active. Phase 8 watchdog uses this.
   */
  async pruneStale(cutoff: Date): Promise<number> {
    const result = await this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({
        status: ConversationStatus.FAILED,
        endedAt: () => 'now()',
        endReason: ConversationEndReason.FATAL_ERROR,
        errorCode: 'AGENT_LOST',
      })
      .where('"status" IN (:...statuses) AND "updatedAt" < :cutoff', {
        statuses: [ConversationStatus.PENDING, ConversationStatus.ACTIVE],
        cutoff,
      })
      .execute();
    return result.affected ?? 0;
  }
}
