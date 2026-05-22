import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `app_setting` — admin-managed env-overlay table. See entity for the
 * full design notes. One row per overridable key (e.g. OPENAI_API_KEY).
 * Encryption is application-side (AES-256-GCM); column is plain text so
 * the DB layer never sees the secret material in column-type metadata.
 */
export class AppSettings1779500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "app_setting" (
        "key"             varchar(80)               NOT NULL,
        "value_encrypted" text                      NOT NULL,
        "updated_by"      uuid                      NULL,
        "created_at"      timestamptz DEFAULT now() NOT NULL,
        "updated_at"      timestamptz DEFAULT now() NOT NULL,
        CONSTRAINT "PK_app_setting" PRIMARY KEY ("key")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_app_setting_updated" ON "app_setting" ("updated_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_app_setting_updated"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "app_setting"`);
  }
}
