import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './user.entity';

@Entity('refresh_tokens')
@Index('idx_refresh_tokens_user', ['userId'])
@Index('idx_refresh_tokens_hash', ['tokenHash'], { unique: true })
@Index('idx_refresh_tokens_expires', ['expiresAt'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'inet', nullable: true })
  ipAddress!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
