import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { getToken } from '@willsoto/nestjs-prometheus';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';

import { PasswordBreachService } from '@mova-back/shared-auth';

import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { RefreshTokenService } from './refresh-token.service';
import { GOOGLE_TOKEN_VERIFIER } from './google/google-token-verifier';
import { FIREBASE_TOKEN_VERIFIER } from './firebase/firebase-token-verifier';
import { EMAIL_SENDER } from '../email/email-sender';

async function makeService() {
  const users = {
    create: jest.fn(),
    findByEmail: jest.fn(),
  };
  const email = { send: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: UsersService, useValue: users },
      { provide: RefreshTokenService, useValue: { issue: jest.fn() } },
      { provide: JwtService, useValue: { sign: jest.fn(() => 'jwt'), verify: jest.fn() } },
      {
        provide: PasswordBreachService,
        useValue: { assertNotBreached: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: EventEmitter2, useValue: { emitAsync: jest.fn().mockResolvedValue([]) } },
      { provide: getToken('mova_signups_total'), useValue: { inc: jest.fn() } },
      { provide: GOOGLE_TOKEN_VERIFIER, useValue: { verify: jest.fn() } },
      { provide: FIREBASE_TOKEN_VERIFIER, useValue: { verifyPhone: jest.fn() } },
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: EMAIL_SENDER, useValue: email },
    ],
  }).compile();
  return { service: moduleRef.get(AuthService), users, email };
}

const ctx = { userAgent: 'jest', ipAddress: '127.0.0.1' };

describe('AuthService registration email gate', () => {
  it('register issues NO session and mails a verification link', async () => {
    const { service, users, email } = await makeService();
    users.create.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      createdAt: new Date(),
    });

    const res = await service.register({
      email: 'a@b.com',
      password: 'Sup3rStr0ngPass!',
      name: 'A',
      username: 'aaa',
    } as never);

    expect(res).toEqual({ verificationRequired: true, email: 'a@b.com' });
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com' }),
    );
  });

  it('login is blocked until the email is verified', async () => {
    const { service, users } = await makeService();
    const passwordHash = await bcrypt.hash('pw123456', 4);
    users.findByEmail.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash,
      isBlocked: false,
      emailVerifiedAt: null,
    });

    await expect(
      service.login({ email: 'a@b.com', password: 'pw123456' } as never, ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
