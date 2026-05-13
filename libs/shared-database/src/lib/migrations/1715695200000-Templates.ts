import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add templates table — system + user-owned presets for AI conversation behavior.
 *
 * Indexes:
 *   - idx_templates_user                  → fast list-by-user (most common query)
 *   - idx_templates_system_lang (partial) → fast pick-default-by-language for
 *                                           users without their own default
 *   - idx_templates_user_default (partial unique) → enforces one isDefault per
 *                                           user, deleted rows excluded
 */
export class Templates1715695200000 implements MigrationInterface {
  name = 'Templates1715695200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "templates" (
        "id"                    uuid                  NOT NULL DEFAULT uuid_generate_v4(),
        "userId"                uuid,
        "name"                  varchar(80)           NOT NULL,
        "description"           varchar(280)          NOT NULL,
        "systemPrompt"          text                  NOT NULL,
        "language"              "users_language_enum" NOT NULL DEFAULT 'uk',
        "defaultVoice"          varchar(100),
        "defaultLlmProvider"    varchar(50),
        "defaultLlmModel"       varchar(100),
        "defaultTtsProvider"    varchar(50),
        "isDefault"             boolean               NOT NULL DEFAULT false,
        "isSystem"              boolean               NOT NULL DEFAULT false,
        "createdAt"             timestamptz           NOT NULL DEFAULT now(),
        "updatedAt"             timestamptz           NOT NULL DEFAULT now(),
        "deletedAt"             timestamptz,
        CONSTRAINT "PK_templates" PRIMARY KEY ("id"),
        CONSTRAINT "FK_templates_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await q.query(`CREATE INDEX "idx_templates_user" ON "templates" ("userId")`);
    await q.query(`
      CREATE INDEX "idx_templates_system_lang"
        ON "templates" ("language")
        WHERE "isSystem" = true
    `);
    await q.query(`
      CREATE UNIQUE INDEX "idx_templates_user_default"
        ON "templates" ("userId")
        WHERE "isDefault" = true AND "deletedAt" IS NULL
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "templates"`);
  }
}
