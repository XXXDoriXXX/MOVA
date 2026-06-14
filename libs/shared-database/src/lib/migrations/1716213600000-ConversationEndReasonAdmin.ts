import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationEndReasonAdmin1716213600000
  implements MigrationInterface
{
  name = 'ConversationEndReasonAdmin1716213600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "conversations_end_reason_enum" ADD VALUE IF NOT EXISTS 'admin'`,
    );
  }

  async down(_q: QueryRunner): Promise<void> {
  }
}
