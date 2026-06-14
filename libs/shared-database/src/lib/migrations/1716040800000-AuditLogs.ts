import { MigrationInterface, QueryRunner } from 'typeorm';

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
