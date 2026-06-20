import { MigrationInterface, QueryRunner } from 'typeorm';

export class CallBillingMultiplier1780001000000 implements MigrationInterface {
  name = 'CallBillingMultiplier1780001000000';

  public async up(q: QueryRunner): Promise<void> {
    // Per-call weight on billed seconds. A "realistic" (ElevenLabs) call costs us
    // more to produce, so it consumes the included pool / wallet faster. Existing
    // rows default to 1 (no change to historical billing). NOT NULL keeps the
    // lifecycle math total — it reads the snapshot, never recomputes the tariff.
    await q.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "billingSecondsMultiplier" integer NOT NULL DEFAULT 1`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "billingSecondsMultiplier"`,
    );
  }
}
