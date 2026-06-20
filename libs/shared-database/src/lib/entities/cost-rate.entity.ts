import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * What one unit of a cost metric costs us. Admin-editable; defaults come from
 * the providers' published price sheets (seeded on boot, never overwritten).
 *
 * Rates are stored as a human-friendly decimal in `rate`, interpreted by
 * `rateUnit` (e.g. USD per 1M tokens, USD per 1M chars, UAH per minute). The
 * cost engine normalises every rate to "currency per single unit" and converts
 * USD → UAH via the `fx:usd_to_uah` row. Decimal (not integer) because the
 * numbers span many orders of magnitude (sub-cent tokens ↔ hryvnia-a-minute
 * telephony) and this is an internal cost ESTIMATE, not an invoiced amount.
 */
export enum CostMetric {
  LLM_INPUT_TOKEN = 'llm_input_token',
  LLM_OUTPUT_TOKEN = 'llm_output_token',
  TTS_CHAR = 'tts_char',
  STT_SECOND = 'stt_second',
  TELEPHONY_SECOND = 'telephony_second',
  FX = 'fx',
}

@Entity('cost_rates')
export class CostRate {
  // Stable identity, e.g. 'tts:elevenlabs:char', 'llm:groq:input_token',
  // 'telephony:second', 'fx:usd_to_uah'. The cost engine looks rates up by key.
  @PrimaryColumn({ type: 'varchar', length: 80 })
  key!: string;

  @Column({ type: 'varchar', length: 120 })
  label!: string;

  @Column({ type: 'varchar', length: 30 })
  metric!: CostMetric;

  // The billed provider this rate belongs to ('groq', 'elevenlabs', 'google',
  // 'deepgram', 'telephony', '' for fx). Used to match a message's provider.
  @Column({ type: 'varchar', length: 40, default: '' })
  provider!: string;

  // Human value, e.g. 0.59 (USD per 1M tokens), 152 (USD per 1M chars),
  // 6 (UAH per minute), 41.5 (UAH per USD). Stored as a numeric; TypeORM
  // returns it as a string — the engine parses it once.
  @Column({ type: 'numeric', precision: 18, scale: 6 })
  rate!: string;

  // How to read `rate`: 'usd_per_1m_tokens' | 'usd_per_1m_chars' |
  // 'usd_per_minute' | 'uah_per_minute' | 'uah_per_usd'. Drives normalisation.
  @Column({ type: 'varchar', length: 30 })
  rateUnit!: string;

  // Who last edited (a user id, or the synthetic 'admin-bypass' marker) —
  // varchar, not uuid, because the password-auth admin has no real user row.
  @Column({ type: 'varchar', length: 64, nullable: true })
  updatedBy!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
