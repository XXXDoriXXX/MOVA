import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserStyleProfile1716300000000 implements MigrationInterface {
  name = 'UserStyleProfile1716300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "messages_source_enum" AS ENUM ('typed', 'suggestion');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      ALTER TABLE "messages"
      ADD COLUMN IF NOT EXISTS "source" "messages_source_enum"
    `);

    await q.query(`
      CREATE TABLE "user_style_profiles" (
        "userId"             uuid          NOT NULL,
        "sampleCount"        int           NOT NULL DEFAULT 0,
        "totalChars"         bigint        NOT NULL DEFAULT 0,
        "avgMessageLength"   int           NOT NULL DEFAULT 0,
        "exemplarMessages"   jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "lastUpdatedAt"      timestamptz   NOT NULL DEFAULT now(),
        "createdAt"          timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_style_profiles" PRIMARY KEY ("userId"),
        CONSTRAINT "FK_user_style_profiles_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        -- Defensive: sampleCount/totalChars can never go negative.
        CONSTRAINT "CHK_user_style_profiles_nonneg"
          CHECK ("sampleCount" >= 0 AND "totalChars" >= 0)
      )
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "user_style_profiles"`);
    await q.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "source"`);
    await q.query(`DROP TYPE IF EXISTS "messages_source_enum"`);
  }
}
