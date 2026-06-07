import { MigrationInterface, QueryRunner } from 'typeorm';

export class MessageSearchVector1779600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD COLUMN "searchVector" tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_messages_search_vector"
      ON "messages" USING GIN ("searchVector")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_search_vector"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "searchVector"`);
  }
}
