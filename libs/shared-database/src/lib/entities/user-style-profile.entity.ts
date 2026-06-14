import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from './user.entity';

export const STYLE_EXEMPLAR_CAP = 10;

export interface StyleExemplar {
  content: string;
  createdAt: string;
}

@Entity('user_style_profiles')
export class UserStyleProfile {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'int', default: 0 })
  sampleCount!: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer() })
  totalChars!: number;

  @Column({ type: 'int', default: 0 })
  avgMessageLength!: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  exemplarMessages!: StyleExemplar[];

  @UpdateDateColumn()
  lastUpdatedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

function bigintTransformer() {
  return {
    to: (value: number | null | undefined): string | null =>
      value == null ? null : String(value),
    from: (value: string | null): number =>
      value == null ? 0 : Number(value),
  };
}
