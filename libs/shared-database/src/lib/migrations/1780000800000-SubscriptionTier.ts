import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds the MOVA Plus subscription tier: a recurring monthly plan with a pool of
// included seconds + a discounted overage rate, plus the recurring-mandate
// bookkeeping on the subscription. Additive + nullable/defaulted, so old code
// keeps working against the new schema.
export class SubscriptionTier1780000800000 implements MigrationInterface {
  name = 'SubscriptionTier1780000800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // New 'plus' value on the plan-code enum. ADD VALUE is safe on PG 12+ and
    // the value is only consumed later (by the boot seed), not in this tx.
    await queryRunner.query(
      `ALTER TYPE "plans_code_enum" ADD VALUE IF NOT EXISTS 'plus'`,
    );

    await queryRunner.query(
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "monthlyPriceCents" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "premiumVoices" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "unlimitedPeerCalls" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "premiumModel" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "recToken" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "cancelAtPeriodEnd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "recToken"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "provider"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" DROP COLUMN IF EXISTS "premiumModel"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" DROP COLUMN IF EXISTS "unlimitedPeerCalls"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" DROP COLUMN IF EXISTS "premiumVoices"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" DROP COLUMN IF EXISTS "monthlyPriceCents"`,
    );
    // The enum value 'plus' is intentionally left in place — PostgreSQL cannot
    // drop an enum value, and re-adding is idempotent.
  }
}
