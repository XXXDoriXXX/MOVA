import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Conversation } from './conversation.entity';
import { Message } from './message.entity';

@Entity('suggestions')
@Index('idx_suggestions_conversation', ['conversationId'])
@Index('idx_suggestions_parent', ['parentMessageId'])
@Check('"position" IN (1, 2, 3)')
export class Suggestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: Conversation;

  @Column({ type: 'uuid' })
  parentMessageId!: string;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parentMessageId' })
  parentMessage!: Message;

  @Column({ type: 'varchar', length: 120 })
  content!: string;

  @Column({ type: 'int' })
  position!: number;

  @Column({ default: false })
  wasChosen!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
