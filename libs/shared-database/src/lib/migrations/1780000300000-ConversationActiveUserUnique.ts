import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationActiveUserUnique1780000300000
  implements MigrationInterface
{
  name = 'ConversationActiveUserUnique1780000300000';

  public async up(q: QueryRunner): Promise<void> {
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
