import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { User, UserLanguage } from '@mova-back/shared-database';

interface CreateUserInput {
  email: string;
  passwordHash: string;
  name: string;
  language?: UserLanguage;
}

interface UpdateProfileInput {
  name?: string;
  phoneNumber?: string;
  language?: UserLanguage;
  preferredVoice?: string;
  preferredLlmProvider?: string;
  preferredLlmModel?: string;
  preferredTtsProvider?: string;
  /**
   * Wire ID — "builtin:<key>" or "custom:<uuid>". Validated by
   * ConversationStylesService before this method is called. NULL clears.
   */
  preferredStyleId?: string | null;
}

/**
 * UsersService — the only place that reads/writes the User table.
 * Other modules go through here to keep ownership clear and to add
 * cross-cutting concerns (email normalization, soft-delete filtering,
 * cache invalidation later in Phase 5).
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * Find an active user (not soft-deleted) by email. Email is lower-cased
   * upstream in DTO validation, but we defensively normalize again here so
   * callers can't accidentally bypass that.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email: email.trim().toLowerCase(), deletedAt: IsNull() },
    });
  }

  async findActiveById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });
  }

  /**
   * @deprecated kept for JwtStrategy back-compat. Prefer `findActiveById`.
   */
  async findById(id: string): Promise<User | null> {
    return this.findActiveById(id);
  }

  async create(input: CreateUserInput): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email already in use');
    }
    const user = this.usersRepository.create({
      email,
      passwordHash: input.passwordHash,
      name: input.name,
      language: input.language ?? UserLanguage.UK,
    });
    return this.usersRepository.save(user);
  }

  async updateProfile(userId: string, patch: UpdateProfileInput): Promise<User> {
    // We use update + reload to keep the operation a single UPDATE statement;
    // findOneOrFail on an active user enforces soft-delete invariant.
    await this.usersRepository.update({ id: userId }, patch);
    const user = await this.findActiveById(userId);
    if (!user) {
      // Defensive: only happens if the user was deleted concurrently.
      throw new ConflictException('User no longer exists');
    }
    return user;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.usersRepository.update({ id: userId }, { passwordHash });
  }

  async softDelete(userId: string): Promise<void> {
    await this.usersRepository.softDelete({ id: userId });
  }
}
