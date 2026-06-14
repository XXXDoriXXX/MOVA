import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProviderIncidents1715954400000 implements MigrationInterface {
  name = 'ProviderIncidents1715954400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "provider_incidents_provider_type_enum" AS ENUM ('stt', 'llm', 'tts');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    await q.query(`
      CREATE TABLE "provider_incidents" (
        "id"               uuid                                       NOT NULL DEFAULT uuid_generate_v4(),
        "conversationId"   uuid,
        "providerType"     "provider_incidents_provider_type_enum"    NOT NULL,
        "providerName"     varchar(50)                                NOT NULL,
        "errorCode"        varchar(50)                                NOT NULL,
        "errorMessage"     text                                       NOT NULL,
        "occurredAt"       timestamptz                                NOT NULL DEFAULT now(),
        "recoveredAt"      timestamptz,
        CONSTRAINT "PK_provider_incidents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_provider_incidents_conversation"
          FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE
      )
    `);

    await q.query(
      `CREATE INDEX "idx_provider_incidents_conversation" ON "provider_incidents" ("conversationId")`,
    );
    await q.query(
      `CREATE INDEX "idx_provider_incidents_active"
         ON "provider_incidents" ("providerName")
         WHERE "recoveredAt" IS NULL`,
    );
    await q.query(
      `CREATE INDEX "idx_provider_incidents_occurred" ON "provider_incidents" ("occurredAt")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "provider_incidents"`);
    await q.query(`DROP TYPE IF EXISTS "provider_incidents_provider_type_enum"`);
  }
}
