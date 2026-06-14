import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationEndReasonNoAnswer1780000100000
  implements MigrationInterface
{
  name = 'ConversationEndReasonNoAnswer1780000100000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "conversations_end_reason_enum" ADD VALUE IF NOT EXISTS 'no_answer'`,
    );
  }

  async down(_q: QueryRunner): Promise<void> {
  }
}
