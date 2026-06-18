import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { User, UserLanguage } from '@mova-back/shared-database';

interface CreateUserInput {
  email: string;
  passwordHash: string;
  name: string;
  username?: string;
  language?: UserLanguage;
}

interface UpdateProfileInput {
  name?: string;
  language?: UserLanguage;
  preferredVoice?: string;
  preferredVoiceGender?: 'female' | 'male';
  preferredLlmProvider?: string;
  preferredLlmModel?: string;
  preferredTtsProvider?: string;
  preferredStyleId?: string | null;
  isDeafMute?: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email: email.trim().toLowerCase(), deletedAt: IsNull() },
    });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { username: username.trim().toLowerCase(), deletedAt: IsNull() },
    });
  }

  // Resolve a search query (nickname or email) to a live, email-verified user —
  // the target a hearing user sends a contact request to.
  async findVerifiedByHandle(query: string): Promise<User | null> {
    const handle = query.trim().toLowerCase();
    const byEmail = handle.includes('@')
      ? await this.findByEmail(handle)
      : await this.findByUsername(handle);
    if (!byEmail || byEmail.emailVerifiedAt === null || byEmail.isBlocked) {
      return null;
    }
    return byEmail;
  }

  async findActiveById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.usersRepository.update(
      { id: userId },
      { emailVerifiedAt: new Date() },
    );
  }

  async findById(id: string): Promise<User | null> {
    return this.findActiveById(id);
  }

  async create(input: CreateUserInput): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const username = input.username?.trim().toLowerCase();
    if (await this.findByEmail(email)) {
      throw new ConflictException('Email already in use');
    }
    if (username && (await this.findByUsername(username))) {
      throw new ConflictException('Username already taken');
    }
    const user = this.usersRepository.create({
      email,
      username: username ?? null,
      passwordHash: input.passwordHash,
      name: input.name,
      language: input.language ?? UserLanguage.UK,
    });
    try {
      return await this.usersRepository.save(user);
    } catch (err) {
      // Lost the race against a concurrent signup with the same email/username.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('Email or username already taken');
      }
      throw err;
    }
  }

  async updateProfile(userId: string, patch: UpdateProfileInput): Promise<User> {
    await this.usersRepository.update({ id: userId }, patch);
    const user = await this.findActiveById(userId);
    if (!user) {
      throw new ConflictException('User no longer exists');
    }
    return user;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.usersRepository.update({ id: userId }, { passwordHash });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { googleId, deletedAt: IsNull() },
    });
  }

  async createFromGoogle(input: {
    email: string;
    googleId: string;
    name: string;
    language?: UserLanguage;
    passwordHash: string;
  }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email already in use');
    }
    const user = this.usersRepository.create({
      email,
      googleId: input.googleId,
      passwordHash: input.passwordHash,
      name: input.name,
      language: input.language ?? UserLanguage.UK,
      // Google already proved ownership of this email — no separate verification.
      emailVerifiedAt: new Date(),
    });
    return this.usersRepository.save(user);
  }

  async linkGoogleId(userId: string, googleId: string): Promise<void> {
    await this.usersRepository.update({ id: userId }, { googleId });
  }

  async softDelete(userId: string): Promise<void> {
    await this.usersRepository.softDelete({ id: userId });
  }
}
