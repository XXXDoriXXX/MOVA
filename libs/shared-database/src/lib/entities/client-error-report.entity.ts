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

/**
 * A crash / error captured on the mobile (or web) client and shipped to the
 * backend for storage + investigation. Append-only; never updated.
 *
 * `userId` is nullable — errors that happen before login (auth screen, boot)
 * still get stored, attributed to null. `context` (JSONB) carries the
 * breadcrumb trail, device/app info and any call correlation (conversationId)
 * so we can reconstruct what the user did before the failure.
 */
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

  /** Error class name (e.g. "TypeError", "AxiosError"). */
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'text', nullable: true })
  stack!: string | null;

  /** Route / screen the user was on when it happened (expo-router path). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  screen!: string | null;

  /** Breadcrumbs, network state, conversationId, and any extra structured
   *  context the client attached. Shape is client-defined and best-effort. */
  @Column({ type: 'jsonb', nullable: true })
  context!: Record<string, unknown> | null;

  /** Client-side timestamp of the error (the device clock may differ from ours). */
  @Column({ type: 'timestamptz', nullable: true })
  clientCreatedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
