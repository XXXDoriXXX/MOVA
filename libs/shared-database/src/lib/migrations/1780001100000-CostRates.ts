import { MigrationInterface, QueryRunner } from 'typeorm';

export class CostRates1780001100000 implements MigrationInterface {
  name = 'CostRates1780001100000';

  public async up(q: QueryRunner): Promise<void> {
    // Admin-editable provider cost rates (our cost per unit). Seeded on boot
    // from provider price sheets (CostRateSeed, insert-if-missing). Powers the
    // admin-only per-conversation cost view; never exposed to end users.
    await q.query(`
      CREATE TABLE IF NOT EXISTS "cost_rates" (
        "key" varchar(80) PRIMARY KEY,
        "label" varchar(120) NOT NULL,
        "metric" varchar(30) NOT NULL,
        "provider" varchar(40) NOT NULL DEFAULT '',
        "rate" numeric(18,6) NOT NULL,
        "rateUnit" varchar(30) NOT NULL,
        "updatedBy" varchar(64),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "cost_rates"`);
  }
}
