import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `answeredAt` to conversations — the moment the interlocutor actually
 * picked up (SIP callStatus=active / peer joined), as opposed to `connectedAt`
 * which is merely when the agent joined and started dialing.
 *
 * Why: billing previously ran off `connectedAt ?? startedAt`, so a call that
 * only ever rang (never answered) was charged for the ring duration. Billing
 * now derives billable seconds from `answeredAt`; a NULL value means the call
 * was never answered and is charged 0.
 */
export class ConversationAnsweredAt1780000000000 implements MigrationInterface {
  name = 'ConversationAnsweredAt1780000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "answeredAt" timestamptz`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "answeredAt"`,
    );
  }
}
