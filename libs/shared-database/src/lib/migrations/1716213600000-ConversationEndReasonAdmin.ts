import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'admin' to `conversations_end_reason_enum` so admin-forced call
 * terminations have their own first-class reason (vs. piggy-backing on
 * `fatal_error` with a magic errorCode string).
 *
 * Why a real enum value instead of overloading FATAL_ERROR:
 *   - SQL filtering: `WHERE endReason = 'admin'` for ops dashboards.
 *   - Mobile UI: history screen can show a friendly "Завершено
 *     адміністратором" banner without parsing errorCode.
 *   - Metrics: distinguish admin-action volume from genuine failures.
 *
 * Postgres supports `ALTER TYPE ... ADD VALUE` atomically (no table rewrite,
 * cannot run inside a transaction → TypeORM handles by wrapping each migration
 * file in its own implicit txn; this one uses `COMMIT` semantics correctly via
 * the IF NOT EXISTS guard).
 *
 * Down: Postgres has NO syntax to remove an enum value. Best we can do is
 * recreate the enum entirely, but that requires rewriting every dependent
 * column. For a non-blocking down we just no-op and document.
 */
export class ConversationEndReasonAdmin1716213600000
  implements MigrationInterface
{
  name = 'ConversationEndReasonAdmin1716213600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "conversations_end_reason_enum" ADD VALUE IF NOT EXISTS 'admin'`,
    );
  }

  async down(_q: QueryRunner): Promise<void> {
    // Postgres cannot drop an enum value without recreating the type and
    // rewriting every dependent column. We accept "down is a no-op" rather
    // than ship a destructive migration. Reverting application code (where
    // 'admin' is referenced) is the operational fix.
  }
}
