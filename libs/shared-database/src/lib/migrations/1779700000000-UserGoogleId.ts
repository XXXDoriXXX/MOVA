import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserGoogleId1779700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "googleId" varchar(64) NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_users_googleId_active"
       ON "users" ("googleId")
       WHERE "googleId" IS NOT NULL AND "deletedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_googleId_active"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "googleId"`);
  }
}
