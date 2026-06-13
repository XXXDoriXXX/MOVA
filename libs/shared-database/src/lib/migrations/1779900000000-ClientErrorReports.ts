import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClientErrorReports1779900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "client_error_reports_platform_enum" AS ENUM ('ios', 'android', 'web')`,
    );
    await queryRunner.query(
      `CREATE TABLE "client_error_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NULL,
        "platform" "client_error_reports_platform_enum" NOT NULL,
        "appVersion" varchar(40) NULL,
        "deviceModel" varchar(120) NULL,
        "osVersion" varchar(60) NULL,
        "fatal" boolean NOT NULL DEFAULT false,
        "name" varchar(120) NOT NULL,
        "message" text NOT NULL,
        "stack" text NULL,
        "screen" varchar(120) NULL,
        "context" jsonb NULL,
        "clientCreatedAt" TIMESTAMP WITH TIME ZONE NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "pk_client_error_reports" PRIMARY KEY ("id"),
        CONSTRAINT "fk_client_error_reports_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_client_errors_created" ON "client_error_reports" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_client_errors_user" ON "client_error_reports" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_client_errors_name" ON "client_error_reports" ("name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "client_error_reports"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "client_error_reports_platform_enum"`,
    );
  }
}
