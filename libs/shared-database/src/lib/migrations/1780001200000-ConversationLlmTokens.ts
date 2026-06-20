import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationLlmTokens1780001200000 implements MigrationInterface {
  name = 'ConversationLlmTokens1780001200000';

  public async up(q: QueryRunner): Promise<void> {
    // Real LLM token spend per conversation, aggregated from the agent's
    // llm.usage events. Additive (default 0); existing rows stay 0 and the cost
    // view estimates them from message text until they accrue measured spend.
    await q.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "llmInputTokens" integer NOT NULL DEFAULT 0`,
    );
    await q.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "llmOutputTokens" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "llmOutputTokens"`,
    );
    await q.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "llmInputTokens"`,
    );
  }
}
