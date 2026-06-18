import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserVoiceGender1780000900000 implements MigrationInterface {
  name = 'UserVoiceGender1780000900000';

  public async up(q: QueryRunner): Promise<void> {
    // Provider-agnostic voice preference for the AI agent's TTS. Null → the
    // backend's default (female). The gateway maps gender → a concrete voice for
    // whatever premium provider is active, so the choice survives plan changes
    // and never persists a provider-specific voice id that could go invalid.
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferredVoiceGender" varchar(10)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "preferredVoiceGender"`,
    );
  }
}
