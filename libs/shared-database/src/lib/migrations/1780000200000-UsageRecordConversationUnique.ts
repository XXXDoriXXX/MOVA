import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the call-usage ledger idempotent per conversation. Previously
 * usage_records only had a NON-unique index on conversationId, so a duplicate
 * `call.ended` (agent end racing the realtime watchdog's AGENT_LOST, or admin
 * force-end racing a real end) could insert two rows and double-charge.
 *
 * De-duplicate any pre-existing duplicates first (keep the lowest id per
 * conversationId), then replace the plain index with a UNIQUE one so the DB is
 * the final backstop. BillingService.recordUsage catches 23505 and returns the
 * surviving row.
 */
export class UsageRecordConversationUnique1780000200000
  implements MigrationInterface
{
  name = 'UsageRecordConversationUnique1780000200000';

  public async up(q: QueryRunner): Promise<void> {
    // Collapse duplicates: keep the lowest id per conversationId.
    await q.query(`
      DELETE FROM "usage_records" a
      USING "usage_records" b
      WHERE a."conversationId" = b."conversationId"
        AND a."id" > b."id"
    `);
    await q.query(`DROP INDEX IF EXISTS "idx_usage_conversation"`);
    await q.query(
      `CREATE UNIQUE INDEX "idx_usage_conversation" ON "usage_records" ("conversationId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_usage_conversation"`);
    await q.query(
      `CREATE INDEX "idx_usage_conversation" ON "usage_records" ("conversationId")`,
    );
  }
}
