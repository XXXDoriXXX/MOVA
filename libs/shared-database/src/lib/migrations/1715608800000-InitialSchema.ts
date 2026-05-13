import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema — users + refresh_tokens.
 *
 * Future migrations (Phase 2+): templates, plans, subscriptions, conversations,
 * messages, suggestions, usage_records, payment_events.
 *
 * Safety notes:
 *   - Uses uuid_generate_v4() — extension created defensively at the top.
 *   - All FKs ON DELETE CASCADE for refresh_tokens (user removal cascades).
 *   - Soft-delete on users via `deletedAt`; partial unique index on email
 *     enforces uniqueness only on ACTIVE rows (so a deleted user can free
 *     their email for someone else after anonymization).
 */
export class InitialSchema1715608800000 implements MigrationInterface {
  name = 'InitialSchema1715608800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── enum types (TypeORM creates them inline but explicit DDL is cleaner) ──
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "users_role_enum" AS ENUM ('admin', 'user');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "users_language_enum" AS ENUM ('uk', 'en');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    // ── users ────────────────────────────────────────
    await q.query(`
      CREATE TABLE "users" (
        "id"                    uuid                  NOT NULL DEFAULT uuid_generate_v4(),
        "email"                 varchar               NOT NULL,
        "passwordHash"          varchar               NOT NULL,
        "name"                  varchar               NOT NULL,
        "phoneNumber"           varchar(20),
        "language"              "users_language_enum" NOT NULL DEFAULT 'uk',
        "preferredVoice"        varchar(100),
        "preferredLlmProvider"  varchar(50),
        "preferredLlmModel"     varchar(100),
        "preferredTtsProvider"  varchar(50),
        "role"                  "users_role_enum"     NOT NULL DEFAULT 'user',
        "isBlocked"             boolean               NOT NULL DEFAULT false,
        "blockedReason"         text,
        "createdAt"             timestamptz           NOT NULL DEFAULT now(),
        "updatedAt"             timestamptz           NOT NULL DEFAULT now(),
        "deletedAt"             timestamptz,
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);

    await q.query(`
      CREATE UNIQUE INDEX "idx_users_email_active"
        ON "users" ("email")
        WHERE "deletedAt" IS NULL
    `);

    // ── refresh_tokens ───────────────────────────────
    await q.query(`
      CREATE TABLE "refresh_tokens" (
        "id"          uuid          NOT NULL DEFAULT uuid_generate_v4(),
        "userId"      uuid          NOT NULL,
        "tokenHash"   varchar(64)   NOT NULL,
        "expiresAt"   timestamptz   NOT NULL,
        "revokedAt"   timestamptz,
        "userAgent"   varchar(500),
        "ipAddress"   inet,
        "createdAt"   timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await q.query(`CREATE INDEX "idx_refresh_tokens_user" ON "refresh_tokens" ("userId")`);
    await q.query(
      `CREATE UNIQUE INDEX "idx_refresh_tokens_hash" ON "refresh_tokens" ("tokenHash")`,
    );
    await q.query(`CREATE INDEX "idx_refresh_tokens_expires" ON "refresh_tokens" ("expiresAt")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
    await q.query(`DROP TABLE IF EXISTS "users"`);
    await q.query(`DROP TYPE IF EXISTS "users_language_enum"`);
    await q.query(`DROP TYPE IF EXISTS "users_role_enum"`);
    // Intentionally NOT dropping uuid-ossp extension — it may be in use by
    // other schemas. Migrations should never drop shared resources.
  }
}
