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

export enum MessageRole {
  INTERLOCUTOR = 'interlocutor',
  AI = 'ai',
  USER_TYPED = 'user_typed',
  SYSTEM = 'system',
}

export enum TtsStatus {
  COMPLETED = 'completed',
  INTERRUPTED = 'interrupted',
  FAILED = 'failed',
}

export enum MessageSource {
  TYPED = 'typed',
  SUGGESTION = 'suggestion',
}

@Entity('messages')
@Index('idx_messages_conversation_created', ['conversationId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: Conversation;

  @Column({ type: 'enum', enum: MessageRole })
  role!: MessageRole;

  @Column({ type: 'enum', enum: MessageSource, nullable: true })
  source!: MessageSource | null;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'enum', enum: TtsStatus, nullable: true })
  ttsStatus!: TtsStatus | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  llmProvider!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  llmModel!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ttsProvider!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  ttsVoice!: string | null;

  @Column({ type: 'int', nullable: true })
  durationMs!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
