import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Conversation } from './conversation.entity';

export enum ProviderType {
  STT = 'stt',
  LLM = 'llm',
  TTS = 'tts',
}

@Entity('provider_incidents')
@Index('idx_provider_incidents_conversation', ['conversationId'])
@Index('idx_provider_incidents_active', ['providerName'], {
  where: '"recoveredAt" IS NULL',
})
@Index('idx_provider_incidents_occurred', ['occurredAt'])
export class ProviderIncident {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation!: Conversation | null;

  @Column({ type: 'enum', enum: ProviderType })
  providerType!: ProviderType;

  @Column({ type: 'varchar', length: 50 })
  providerName!: string;

  @Column({ type: 'varchar', length: 50 })
  errorCode!: string;

  @Column({ type: 'text' })
  errorMessage!: string;

  @CreateDateColumn()
  occurredAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  recoveredAt!: Date | null;
}
