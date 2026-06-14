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

export enum ClientPlatform {
  IOS = 'ios',
  ANDROID = 'android',
  WEB = 'web',
}

@Entity('client_error_reports')
@Index('idx_client_errors_created', ['createdAt'])
@Index('idx_client_errors_user', ['userId'])
@Index('idx_client_errors_name', ['name'])
export class ClientErrorReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'userId' })
  user!: User | null;

  @Column({ type: 'enum', enum: ClientPlatform })
  platform!: ClientPlatform;

  @Column({ type: 'varchar', length: 40, nullable: true })
  appVersion!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  deviceModel!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  osVersion!: string | null;

  @Column({ default: false })
  fatal!: boolean;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'text', nullable: true })
  stack!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  screen!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  context!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  clientCreatedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
