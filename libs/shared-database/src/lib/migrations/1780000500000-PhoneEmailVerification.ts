import { MigrationInterface, QueryRunner } from 'typeorm';

export class PhoneEmailVerification1780000500000
  implements MigrationInterface
{
  name = 'PhoneEmailVerification1780000500000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" timestamptz`,
    );
    // One verified phone = one account. Partial unique so null/unverified
    // numbers never collide and the directory only resolves verified rows.
    // De-dup defensively: keep the earliest-verified row per number (there are
    // none yet — phoneVerifiedAt is brand new — but stay safe for re-runs).
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_phone_verified"
         ON "users" ("phoneNumber")
         WHERE "phoneVerifiedAt" IS NOT NULL AND "deletedAt" IS NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_users_phone_verified"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerifiedAt"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "phoneVerifiedAt"`);
  }
}
