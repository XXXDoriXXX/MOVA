import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Conversation persistence: conversations + messages + suggestions.
 *
 * Backward-compatibility note for usage_records:
 *   The earlier Billing migration declared `usage_records.conversationId` as
 *   a "soft FK" because Conversation didn't exist yet. We now ADD the FK
 *   constraint so cascade-delete of a conversation properly cleans up its
 *   usage rows. (Append-only semantics still hold for the table — we delete
 *   only when the parent user is removed via cascade.)
 *
 * Indexes:
 *   - conversations.livekitRoom UNIQUE — prevents two active conversations
 *     pointing at the same SIP room (defensive; api-gateway generates a
 *     fresh uuid per call already).
 *   - conversations(status) WHERE status IN (...) — fast lookup of dangling
 *     calls for the watchdog cron (Phase 8).
 *   - messages(conversationId, createdAt) — primary read pattern for the
 *     mobile chat-history pagination cursor.
 */
export class Conversations1715868000000 implements MigrationInterface {
  name = 'Conversations1715868000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "conversations_status_enum"
          AS ENUM ('pending', 'active', 'ended', 'failed');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "conversations_end_reason_enum"
          AS ENUM ('user', 'interlocutor', 'balance', 'fatal_error', 'timeout');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "messages_role_enum"
          AS ENUM ('interlocutor', 'ai', 'user_typed', 'system');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "messages_tts_status_enum"
          AS ENUM ('completed', 'interrupted', 'failed');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    // ── conversations ────────────────────────────────
    await q.query(`
      CREATE TABLE "conversations" (
        "id"                     uuid                              NOT NULL DEFAULT uuid_generate_v4(),
        "userId"                 uuid                              NOT NULL,
        "templateId"             uuid,
        "targetPhone"            varchar(20)                       NOT NULL,
        "livekitRoom"            varchar(64)                       NOT NULL,
        "status"                 "conversations_status_enum"       NOT NULL DEFAULT 'pending',
        "startedAt"              timestamptz                       NOT NULL DEFAULT now(),
        "connectedAt"            timestamptz,
        "endedAt"                timestamptz,
        "durationSeconds"        int                               NOT NULL DEFAULT 0,
        "endReason"              "conversations_end_reason_enum",
        "errorCode"              varchar(64),
        "initialLlmProvider"     varchar(50),
        "initialTtsProvider"     varchar(50),
        "initialVoice"           varchar(100),
        "createdAt"              timestamptz                       NOT NULL DEFAULT now(),
        "updatedAt"              timestamptz                       NOT NULL DEFAULT now(),
        "deletedAt"              timestamptz,
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_conversations_end_after_start"
          CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
        CONSTRAINT "FK_conversations_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversations_template"
          FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX "idx_conversations_user_started" ON "conversations" ("userId", "startedAt")`,
    );
    await q.query(
      `CREATE INDEX "idx_conversations_status_active"
         ON "conversations" ("status")
         WHERE "status" IN ('pending', 'active')`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "idx_conversations_livekit_room" ON "conversations" ("livekitRoom")`,
    );

    // ── messages ─────────────────────────────────────
    await q.query(`
      CREATE TABLE "messages" (
        "id"                uuid                          NOT NULL DEFAULT uuid_generate_v4(),
        "conversationId"    uuid                          NOT NULL,
        "role"              "messages_role_enum"          NOT NULL,
        "content"           text                          NOT NULL,
        "ttsStatus"         "messages_tts_status_enum",
        "llmProvider"       varchar(50),
        "llmModel"          varchar(100),
        "ttsProvider"       varchar(50),
        "ttsVoice"          varchar(100),
        "durationMs"        int,
        "createdAt"         timestamptz                   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_messages_conversation"
          FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX "idx_messages_conversation_created" ON "messages" ("conversationId", "createdAt")`,
    );

    // ── suggestions ──────────────────────────────────
    await q.query(`
      CREATE TABLE "suggestions" (
        "id"                uuid           NOT NULL DEFAULT uuid_generate_v4(),
        "conversationId"    uuid           NOT NULL,
        "parentMessageId"   uuid           NOT NULL,
        "content"           varchar(120)   NOT NULL,
        "position"          int            NOT NULL,
        "wasChosen"         boolean        NOT NULL DEFAULT false,
        "createdAt"         timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_suggestions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_suggestions_position" CHECK ("position" IN (1, 2, 3)),
        CONSTRAINT "FK_suggestions_conversation"
          FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_suggestions_parent"
          FOREIGN KEY ("parentMessageId") REFERENCES "messages"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`CREATE INDEX "idx_suggestions_conversation" ON "suggestions" ("conversationId")`);
    await q.query(`CREATE INDEX "idx_suggestions_parent" ON "suggestions" ("parentMessageId")`);

    // ── usage_records: backfill the FK now that conversations exists ──
    await q.query(`
      ALTER TABLE "usage_records"
        ADD CONSTRAINT "FK_usage_records_conversation"
          FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "usage_records" DROP CONSTRAINT IF EXISTS "FK_usage_records_conversation"`,
    );
    await q.query(`DROP TABLE IF EXISTS "suggestions"`);
    await q.query(`DROP TABLE IF EXISTS "messages"`);
    await q.query(`DROP TABLE IF EXISTS "conversations"`);
    await q.query(`DROP TYPE IF EXISTS "messages_tts_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "messages_role_enum"`);
    await q.query(`DROP TYPE IF EXISTS "conversations_end_reason_enum"`);
    await q.query(`DROP TYPE IF EXISTS "conversations_status_enum"`);
  }
}
