import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds client-side idempotency-key support to `payment_events`.
 *
 * Why an additional key alongside `externalId`:
 *   - `externalId` covers PROVIDER retries (LiqPay webhook duplicates).
 *   - `idempotencyKey` covers CLIENT retries (mobile network blip → user
 *     re-taps "topup" → we get two identical POSTs). The mobile client
 *     generates a UUID before the first attempt and reuses it on retry.
 *
 * UNIQUE composite on (userId, idempotencyKey) WHERE idempotencyKey IS NOT NULL:
 *   - Same key across DIFFERENT users is fine (independent ledgers).
 *   - NULL keys (server-driven topups) bypass the constraint entirely.
 *   - Postgres treats NULLs as distinct in UNIQUE indexes, so the partial
 *     predicate is belt-and-braces — explicit + future-proof against any
 *     setting change.
 */
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
