import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * audit_logs — immutable trail of sensitive admin actions.
 *
 * Why an explicit table:
 *   - Compliance retention (years) outlives log-aggregator TTLs (~30 days).
 *   - SQL queryable by actor / target / action / time without log-pipeline ops.
 *   - Schema rigor where it matters (enum-validated actions, FK on actor).
 *
 * Indexes:
 *   - by actorId             → "what did admin X do recently?"
 *   - composite (target)     → "what happened to user/conversation Y?"
 *   - by action              → coarse aggregates ("how many blocks last week?")
 *   - by createdAt           → time-range scans + cursor pagination
 *
 * No DELETE pathway exists in app code — retention is an explicit future cron.
 * `actorId` is ON DELETE SET NULL so hard user-deletes don't blow away the trail.
 */
export class AuditLogs1716040800000 implements MigrationInterface {
  name = 'AuditLogs1716040800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "audit_logs_action_enum" AS ENUM (
          'user_blocked',
          'user_unblocked',
          'user_role_changed',
          'incident_resolved',
          'conversation_force_ended',
          'plan_created',
          'plan_updated',
          'plan_deactivated'
        );
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "audit_logs_target_type_enum" AS ENUM (
          'user',
          'conversation',
          'incident',
          'plan',
          'system'
        );
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    // The user_role enum already exists from InitialSchema — reuse it.
    await q.query(`
      CREATE TABLE "audit_logs" (
        "id"           uuid                              NOT NULL DEFAULT uuid_generate_v4(),
        "actorId"      uuid,
        "actorEmail"   varchar(320),
        "actorRole"    "users_role_enum",
        "action"       "audit_logs_action_enum"          NOT NULL,
        "targetType"   "audit_logs_target_type_enum"     NOT NULL,
        "targetId"     varchar(64)                       NOT NULL,
        "metadata"     jsonb                             NOT NULL DEFAULT '{}'::jsonb,
        "ipAddress"    varchar(45),
        "userAgent"    varchar(500),
        "createdAt"    timestamptz                       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_audit_logs_actor"
          FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await q.query(
      `CREATE INDEX "idx_audit_logs_actor" ON "audit_logs" ("actorId")`,
    );
    await q.query(
      `CREATE INDEX "idx_audit_logs_target" ON "audit_logs" ("targetType", "targetId")`,
    );
    await q.query(
      `CREATE INDEX "idx_audit_logs_action" ON "audit_logs" ("action")`,
    );
    await q.query(
      `CREATE INDEX "idx_audit_logs_created" ON "audit_logs" ("createdAt")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "audit_logs"`);
    await q.query(`DROP TYPE IF EXISTS "audit_logs_target_type_enum"`);
    await q.query(`DROP TYPE IF EXISTS "audit_logs_action_enum"`);
  }
}
