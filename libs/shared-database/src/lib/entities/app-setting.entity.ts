import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Admin-managed runtime configuration override.
 *
 * One row per overridable key — typically third-party API keys (OPENAI_API_KEY,
 * ELEVENLABS_API_KEY, …). Acts as an *overlay* on top of the `.env` file: at
 * service startup every row is loaded, decrypted, and written to
 * `process.env`, so both our own ConfigService consumers AND third-party
 * plugins that read `process.env` directly (LiveKit Agents plugins, OpenAI
 * SDK, …) see the value without further plumbing.
 *
 * Values are stored AES-256-GCM-encrypted with a key from
 * `SETTINGS_ENCRYPTION_KEY` (operator sets this once in `.env`). Wire format:
 * `<iv_b64>:<tag_b64>:<ciphertext_b64>`.
 *
 * `updatedBy` references the admin who last wrote the value. AuditLog rows
 * carry full per-change attribution (actor, timestamp, kind=setting_updated);
 * this column is a denormalised hint for the admin UI.
 *
 * Deletion semantics: removing a row causes the key to fall back to whatever
 * `.env` provides on next startup. Admin UI exposes this as "Revert to .env".
 */
@Entity({ name: 'app_setting' })
@Index('idx_app_setting_updated', ['updatedAt'])
export class AppSetting {
  /** Env-var-style name, e.g. "OPENAI_API_KEY". Whitelist enforced in
   *  api-gateway so admins can't write arbitrary process.env values. */
  @PrimaryColumn('varchar', { length: 80 })
  key!: string;

  /** AES-256-GCM ciphertext, packed as `<iv>:<tag>:<ct>` in base64. Encrypted
   *  at rest; decrypted by SettingsService.decrypt() on read. */
  @Column('text', { name: 'value_encrypted' })
  valueEncrypted!: string;

  /** UUID of the admin who last wrote this. null for password-bypass admins
   *  (synthetic actor) and for migrations. */
  @Column('uuid', { name: 'updated_by', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
