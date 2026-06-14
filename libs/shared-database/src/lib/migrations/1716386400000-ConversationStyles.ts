import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationStyles1716386400000 implements MigrationInterface {
  name = 'ConversationStyles1716386400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "conversation_styles" (
        "id"            uuid          NOT NULL DEFAULT uuid_generate_v4(),
        "userId"        uuid          NOT NULL,
        "name"          varchar(60)   NOT NULL,
        "instructions"  varchar(2000) NOT NULL,
        "createdAt"     timestamptz   NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_styles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversation_styles_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX "idx_conversation_styles_user" ON "conversation_styles" ("userId")`,
    );

    await q.query(
      `ALTER TABLE "templates" ADD COLUMN IF NOT EXISTS "defaultStyleId" varchar(80)`,
    );
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferredStyleId" varchar(80)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "preferredStyleId"`);
    await q.query(`ALTER TABLE "templates" DROP COLUMN IF EXISTS "defaultStyleId"`);
    await q.query(`DROP TABLE IF EXISTS "conversation_styles"`);
  }
}
