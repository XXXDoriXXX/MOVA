import { MigrationInterface, QueryRunner } from 'typeorm';

export class Contacts1780000700000 implements MigrationInterface {
  name = 'Contacts1780000700000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE "contacts_status_enum" AS ENUM ('pending', 'accepted', 'declined')`,
    );
    await q.query(`
      CREATE TABLE "contacts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "requesterId" uuid NOT NULL,
        "addresseeId" uuid NOT NULL,
        "status" "contacts_status_enum" NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "pk_contacts" PRIMARY KEY ("id"),
        CONSTRAINT "fk_contacts_requester" FOREIGN KEY ("requesterId")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_contacts_addressee" FOREIGN KEY ("addresseeId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_contacts_pair" ON "contacts" ("requesterId", "addresseeId")`,
    );
    await q.query(
      `CREATE INDEX "idx_contacts_addressee" ON "contacts" ("addresseeId", "status")`,
    );
    await q.query(
      `CREATE INDEX "idx_contacts_requester" ON "contacts" ("requesterId", "status")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "contacts"`);
    await q.query(`DROP TYPE IF EXISTS "contacts_status_enum"`);
  }
}
