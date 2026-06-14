import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationAnsweredAt1780000000000 implements MigrationInterface {
  name = 'ConversationAnsweredAt1780000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "answeredAt" timestamptz`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "answeredAt"`,
    );
  }
}
