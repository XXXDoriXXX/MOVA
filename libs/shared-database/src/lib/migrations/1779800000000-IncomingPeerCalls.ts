import { MigrationInterface, QueryRunner } from 'typeorm';

export class IncomingPeerCalls1779800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "isDeafMute" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_is_deaf_mute"
       ON "users" ("isDeafMute")
       WHERE "deletedAt" IS NULL`,
    );

    await queryRunner.query(
      `CREATE TYPE "conversations_calltype_enum" AS ENUM ('sip_outbound', 'peer_inbound')`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations"
       ADD COLUMN "callType" "conversations_calltype_enum" NOT NULL DEFAULT 'sip_outbound'`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN "callerUserId" uuid NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations"
       ADD CONSTRAINT "fk_conversations_caller"
       FOREIGN KEY ("callerUserId") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_conversations_caller" ON "conversations" ("callerUserId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "targetPhone" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TYPE "conversations_endreason_enum" ADD VALUE IF NOT EXISTS 'declined'`,
    );

    await queryRunner.query(
      `CREATE TYPE "push_tokens_platform_enum" AS ENUM ('ios', 'android')`,
    );
    await queryRunner.query(
      `CREATE TYPE "push_tokens_kind_enum" AS ENUM ('data', 'voip')`,
    );
    await queryRunner.query(
      `CREATE TABLE "push_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "token" varchar(512) NOT NULL,
        "platform" "push_tokens_platform_enum" NOT NULL,
        "kind" "push_tokens_kind_enum" NOT NULL DEFAULT 'data',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "pk_push_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "fk_push_tokens_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_push_tokens_user" ON "push_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_push_tokens_token" ON "push_tokens" ("token")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "push_tokens"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "push_tokens_kind_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "push_tokens_platform_enum"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_conversations_caller"`);
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "fk_conversations_caller"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "callerUserId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "callType"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "conversations_calltype_enum"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_is_deaf_mute"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "isDeafMute"`,
    );
  }
}
