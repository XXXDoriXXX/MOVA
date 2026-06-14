import { MigrationInterface, QueryRunner } from 'typeorm';

export class PaymentIdempotencyKey1716127200000 implements MigrationInterface {
  name = 'PaymentIdempotencyKey1716127200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "payment_events"
      ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(64)
    `);

    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_payment_user_idempotency"
      ON "payment_events" ("userId", "idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_payment_user_idempotency"`);
    await q.query(`ALTER TABLE "payment_events" DROP COLUMN IF EXISTS "idempotencyKey"`);
  }
}
