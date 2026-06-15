import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserUsername1780000600000 implements MigrationInterface {
  name = 'UserUsername1780000600000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" varchar(30)`,
    );
    // Unique nickname among live accounts (null allowed for legacy rows).
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_username_active"
         ON "users" ("username")
         WHERE "username" IS NOT NULL AND "deletedAt" IS NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_users_username_active"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "username"`);
  }
}
