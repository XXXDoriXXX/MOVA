import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Close the concurrent-call TOCTOU. The /calls/start gate was a non-atomic
 * count-then-INSERT (CallService.initiateCall, PeerCallService.start): two
 * near-simultaneous requests for the same user both read activeCount=0 and
 * both createPending + dial SIP + bill independently. Room names are fresh
 * per-request UUIDs, so the existing UNIQUE idx_conversations_livekit_room
 * never collides and the dedup-by-room 409 never fires.
 *
 * Add a PARTIAL UNIQUE index on userId WHERE status IN ('pending','active')
 * so the DB is the serialization point (CLAUDE.md rule #1): the second
 * concurrent INSERT loses with 23505 and createPending maps it to the
 * existing CALL_IN_PROGRESS 409.
 *
 * De-dup any pre-existing live rows first (keep the most recent startedAt per
 * user; mark the rest failed) so the UNIQUE index can be created.
 */
export class ConversationActiveUserUnique1780000300000
  implements MigrationInterface
{
  name = 'ConversationActiveUserUnique1780000300000';

  public async up(q: QueryRunner): Promise<void> {
    // Collapse pre-existing concurrent live calls per user: keep the newest
    // (latest startedAt, tie-break on id), fail the older ones so they don't
    // violate the new UNIQUE index.
    await q.query(`
      UPDATE "conversations" c
      SET "status" = 'failed',
          "endedAt" = COALESCE(c."endedAt", now()),
          "endReason" = 'fatal_error',
          "errorCode" = 'CALL_IN_PROGRESS'
      WHERE c."status" IN ('pending', 'active')
        AND EXISTS (
          SELECT 1 FROM "conversations" o
          WHERE o."userId" = c."userId"
            AND o."status" IN ('pending', 'active')
            AND (o."startedAt", o."id") > (c."startedAt", c."id")
        )
    `);
    await q.query(
      `CREATE UNIQUE INDEX "idx_conversations_active_user_unique"
         ON "conversations" ("userId")
         WHERE "status" IN ('pending', 'active')`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "idx_conversations_active_user_unique"`,
    );
  }
}
