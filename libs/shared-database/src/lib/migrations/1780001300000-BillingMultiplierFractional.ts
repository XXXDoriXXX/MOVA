import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillingMultiplierFractional1780001300000
  implements MigrationInterface
{
  name = 'BillingMultiplierFractional1780001300000';

  public async up(q: QueryRunner): Promise<void> {
    // Widen the voice-tier billing weight from int to double so the middle
    // ("realistic") tier can be 1.5×. int → double is lossless; existing 1/2
    // values are unchanged. Default stays 1.
    await q.query(
      `ALTER TABLE "conversations" ALTER COLUMN "billingSecondsMultiplier" TYPE double precision`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // Round back to int on revert (fractional tiers collapse to whole weights).
    await q.query(
      `ALTER TABLE "conversations" ALTER COLUMN "billingSecondsMultiplier" TYPE integer USING round("billingSecondsMultiplier")`,
    );
  }
}
