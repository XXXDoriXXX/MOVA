import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationPlanSnapshot1780000400000
  implements MigrationInterface
{
  name = 'ConversationPlanSnapshot1780000400000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "initialPlanSource" varchar(10)`,
    );
    await q.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "initialPricePerSecondCents" integer`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "initialPricePerSecondCents"`,
    );
    await q.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "initialPlanSource"`,
    );
  }
}
