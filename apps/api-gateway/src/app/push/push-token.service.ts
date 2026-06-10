import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  PushPlatform,
  PushToken,
  PushTokenKind,
} from '@mova-back/shared-database';

interface UpsertInput {
  userId: string;
  token: string;
  platform: PushPlatform;
  kind: PushTokenKind;
}

@Injectable()
export class PushTokenService {
  constructor(
    @InjectRepository(PushToken)
    private readonly tokens: Repository<PushToken>,
  ) {}

  async upsert(input: UpsertInput): Promise<void> {
    const existing = await this.tokens.findOne({ where: { token: input.token } });
    if (existing) {
      await this.tokens.update(
        { id: existing.id },
        { userId: input.userId, platform: input.platform, kind: input.kind },
      );
      return;
    }
    await this.tokens.save(
      this.tokens.create({
        userId: input.userId,
        token: input.token,
        platform: input.platform,
        kind: input.kind,
      }),
    );
  }

  async remove(userId: string, token: string): Promise<void> {
    await this.tokens.delete({ userId, token });
  }

  async findForUser(userId: string): Promise<PushToken[]> {
    return this.tokens.find({ where: { userId } });
  }
}
