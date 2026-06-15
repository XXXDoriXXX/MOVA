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
// Nickname — the public handle a hearing user searches by to send a contact
// request. Stored already-lowercased; unique among live accounts.
@Index('uq_users_username_active', ['username'], {
  unique: true,
  where: '"username" IS NOT NULL AND "deletedAt" IS NULL',
})
// One verified phone = one account. Partial-unique so unverified/null numbers
// don't collide; the peer-call lookup only ever resolves verified rows.
@Index('uq_users_phone_verified', ['phoneNumber'], {
  unique: true,
  where: '"phoneVerifiedAt" IS NOT NULL AND "deletedAt" IS NULL',
})
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

  @Column({ type: 'varchar', length: 30, nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phoneNumber!: string | null;

  // Set only after the number is proven via Firebase Phone Auth (SMS OTP).
  // The peer-call directory matches verified numbers ONLY — an unverified
  // phone must never be reachable, or anyone could claim someone else's number
  // and hijack their incoming calls.
  @Column({ type: 'timestamptz', nullable: true })
  phoneVerifiedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

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
