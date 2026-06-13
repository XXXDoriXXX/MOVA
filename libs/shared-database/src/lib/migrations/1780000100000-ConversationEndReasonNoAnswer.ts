import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'no_answer' to `conversations_end_reason_enum` — a call that reached
 * the callee but was never answered (rang out, rejected, or unavailable),
 * distinct from 'interlocutor' (a real conversation the other party hung up).
 *
 * Lets history and ops dashboards tell "nobody picked up" from "they talked
 * then hung up", and keeps such calls out of the call-error metric (it's not
 * our failure). Billing already charges 0 for them via the null `answeredAt`.
 *
 * Down is a no-op: Postgres cannot drop an enum value without recreating the
 * type and rewriting every dependent column. Reverting the application code is
 * the operational fix (mirrors ConversationEndReasonAdmin1716213600000).
 */
export class ConversationEndReasonNoAnswer1780000100000
  implements MigrationInterface
{
  name = 'ConversationEndReasonNoAnswer1780000100000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "conversations_end_reason_enum" ADD VALUE IF NOT EXISTS 'no_answer'`,
    );
  }

  async down(_q: QueryRunner): Promise<void> {
    // Postgres has no DROP VALUE for enums; a destructive recreate is not worth
    // it. Down is intentionally a no-op.
  }
}
