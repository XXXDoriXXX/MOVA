import { MigrationInterface, QueryRunner } from 'typeorm';

export class Billing1715781600000 implements MigrationInterface {
  name = 'Billing1715781600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "plans_code_enum" AS ENUM ('free', 'paid');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "subscriptions_status_enum"
          AS ENUM ('active', 'cancelled', 'suspended');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "usage_records_source_enum" AS ENUM ('free', 'paid');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "payment_events_status_enum"
          AS ENUM ('success', 'failed', 'refunded', 'pending');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    await q.query(`
      CREATE TABLE "plans" (
        "id"                     uuid               NOT NULL DEFAULT uuid_generate_v4(),
        "code"                   "plans_code_enum"  NOT NULL,
        "name"                   varchar(80)        NOT NULL,
        "freeSecondsPerMonth"    int                NOT NULL DEFAULT 0,
        "pricePerSecondCents"    int                NOT NULL DEFAULT 0,
        "currency"               char(3)            NOT NULL DEFAULT 'UAH',
        "maxConcurrentCalls"     int                NOT NULL DEFAULT 1,
        "maxCallDurationSeconds" int                NOT NULL DEFAULT 3600,
        "isActive"               boolean            NOT NULL DEFAULT true,
        "createdAt"              timestamptz        NOT NULL DEFAULT now(),
        CONSTRAINT "PK_plans" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_plans_code" UNIQUE ("code")
      )
    `);
    await q.query(`CREATE UNIQUE INDEX "idx_plans_code" ON "plans" ("code")`);

    await q.query(`
      CREATE TABLE "subscriptions" (
        "id"                    uuid                          NOT NULL DEFAULT uuid_generate_v4(),
        "userId"                uuid                          NOT NULL,
        "planId"                uuid                          NOT NULL,
        "status"                "subscriptions_status_enum"   NOT NULL DEFAULT 'active',
        "currentPeriodStart"    timestamptz                   NOT NULL,
        "currentPeriodEnd"      timestamptz                   NOT NULL,
        "freeSecondsUsed"       int                           NOT NULL DEFAULT 0,
        "balanceCents"          int                           NOT NULL DEFAULT 0,
        "createdAt"             timestamptz                   NOT NULL DEFAULT now(),
        "updatedAt"             timestamptz                   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_subs_balance_nonneg" CHECK ("balanceCents" >= 0),
        CONSTRAINT "CHK_subs_free_nonneg" CHECK ("freeSecondsUsed" >= 0),
        CONSTRAINT "FK_subscriptions_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subscriptions_plan"
          FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX "idx_subscriptions_user" ON "subscriptions" ("userId")`,
    );
    await q.query(
      `CREATE INDEX "idx_subscriptions_period_end" ON "subscriptions" ("currentPeriodEnd")`,
    );

    await q.query(`
      CREATE TABLE "usage_records" (
        "id"               uuid                         NOT NULL DEFAULT uuid_generate_v4(),
        "userId"           uuid                         NOT NULL,
        "conversationId"   uuid                         NOT NULL,
        "secondsBilled"    int                          NOT NULL,
        "costCents"        int                          NOT NULL DEFAULT 0,
        "source"           "usage_records_source_enum"  NOT NULL,
        "recordedAt"       timestamptz                  NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usage_records" PRIMARY KEY ("id"),
        CONSTRAINT "FK_usage_records_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX "idx_usage_user_recorded" ON "usage_records" ("userId", "recordedAt")`,
    );
    await q.query(
      `CREATE INDEX "idx_usage_conversation" ON "usage_records" ("conversationId")`,
    );

    await q.query(`
      CREATE TABLE "payment_events" (
        "id"            uuid                           NOT NULL DEFAULT uuid_generate_v4(),
        "userId"        uuid                           NOT NULL,
        "externalId"    varchar(255)                   NOT NULL,
        "amountCents"   int                            NOT NULL,
        "currency"      char(3)                        NOT NULL DEFAULT 'UAH',
        "status"        "payment_events_status_enum"   NOT NULL,
        "payload"       jsonb                          NOT NULL,
        "processedAt"   timestamptz,
        "createdAt"     timestamptz                    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payment_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payment_events_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX "idx_payment_external_id" ON "payment_events" ("externalId")`,
    );
    await q.query(
      `CREATE INDEX "idx_payment_user_created" ON "payment_events" ("userId", "createdAt")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "payment_events"`);
    await q.query(`DROP TABLE IF EXISTS "usage_records"`);
    await q.query(`DROP TABLE IF EXISTS "subscriptions"`);
    await q.query(`DROP TABLE IF EXISTS "plans"`);
    await q.query(`DROP TYPE IF EXISTS "payment_events_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "usage_records_source_enum"`);
    await q.query(`DROP TYPE IF EXISTS "subscriptions_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "plans_code_enum"`);
  }
}
