import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from './user.entity';

export enum PushPlatform {
  IOS = 'ios',
  ANDROID = 'android',
}

export enum PushTokenKind {
  DATA = 'data',
  VOIP = 'voip',
}

@Entity('push_tokens')
@Index('idx_push_tokens_user', ['userId'])
@Index('idx_push_tokens_token', ['token'], { unique: true })
export class PushToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar', length: 512 })
  token!: string;

  @Column({ type: 'enum', enum: PushPlatform })
  platform!: PushPlatform;

  @Column({ type: 'enum', enum: PushTokenKind, default: PushTokenKind.DATA })
  kind!: PushTokenKind;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
