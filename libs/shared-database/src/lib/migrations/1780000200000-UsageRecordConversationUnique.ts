import { MigrationInterface, QueryRunner } from 'typeorm';

export class UsageRecordConversationUnique1780000200000
  implements MigrationInterface
{
  name = 'UsageRecordConversationUnique1780000200000';

  public async up(q: QueryRunner): Promise<void> {
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
