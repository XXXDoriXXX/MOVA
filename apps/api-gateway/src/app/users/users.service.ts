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

  async findActiveById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });
  }

  async findActiveByPhone(phoneNumber: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { phoneNumber, deletedAt: IsNull() },
    });
  }

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
