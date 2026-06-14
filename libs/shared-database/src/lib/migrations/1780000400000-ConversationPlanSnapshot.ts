import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Snapshot the plan/price at call START so a mid-call plan switch (POST
 * /billing/subscribe) or the monthly reset can't retroactively re-price an
 * already-answered call. End-of-call billing reads these columns instead of a
 * fresh getSummary(); rows created before this migration keep a NULL snapshot
 * and fall back to the live end-of-call summary (legacy behavior). Mirrors the
 * existing initial* provider snapshot columns on conversations.
 *
 * `initialPlanSource` is the UsageSource ('free'/'paid') the call was eligible
 * under and routes the atomic applyCharge branch — NOT the LLM-provider snapshot.
 */
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
