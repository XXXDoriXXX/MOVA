import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
}

export enum UserLanguage {
  UK = 'uk',
  EN = 'en',
}

@Entity('users')
@Index('idx_users_email_active', ['email'], { where: '"deletedAt" IS NULL', unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  email!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  googleId!: string | null;

  @Column()
  name!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phoneNumber!: string | null;

  @Column({
    type: 'enum',
    enum: UserLanguage,
    default: UserLanguage.UK,
  })
  language!: UserLanguage;

  @Column({ type: 'varchar', length: 100, nullable: true })
  preferredVoice!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  preferredLlmProvider!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  preferredLlmModel!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  preferredTtsProvider!: string | null;

  /**
   * Global default conversation style — wins over a template's defaultStyleId.
   * Opaque ID — `builtin:<key>` or `custom:<uuid>`. Null falls through to the
   * template's default → built-in PERSONAL → FRIENDLY.
   */
  @Column({ type: 'varchar', length: 80, nullable: true })
  preferredStyleId!: string | null;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.USER,
  })
  role!: UserRole;

  @Index('idx_users_is_deaf_mute', ['isDeafMute'], {
    where: '"deletedAt" IS NULL',
  })
  @Column({ default: true })
  isDeafMute!: boolean;

  @Column({ default: false })
  isBlocked!: boolean;

  @Column({ type: 'text', nullable: true })
  blockedReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
