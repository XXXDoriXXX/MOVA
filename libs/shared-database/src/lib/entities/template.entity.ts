import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User, UserLanguage } from './user.entity';

@Entity('templates')
@Index('idx_templates_user', ['userId'])
@Index('idx_templates_system_lang', ['language'], { where: '"isSystem" = true' })
@Index('idx_templates_user_default', ['userId'], {
  unique: true,
  where: '"isDefault" = true AND "deletedAt" IS NULL',
})
export class Template {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'userId' })
  user!: User | null;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 280 })
  description!: string;

  @Column({ type: 'text' })
  systemPrompt!: string;

  @Column({
    type: 'enum',
    enum: UserLanguage,
    default: UserLanguage.UK,
  })
  language!: UserLanguage;

  @Column({ type: 'varchar', length: 100, nullable: true })
  defaultVoice!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  defaultLlmProvider!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  defaultLlmModel!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  defaultTtsProvider!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  defaultStyleId!: string | null;

  @Column({ default: false })
  isDefault!: boolean;

  @Column({ default: false })
  isSystem!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
