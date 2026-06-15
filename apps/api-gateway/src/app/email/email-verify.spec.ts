import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { getToken } from '@willsoto/nestjs-prometheus';
import { Test } from '@nestjs/testing';

import { PasswordBreachService } from '@mova-back/shared-auth';

import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { GOOGLE_TOKEN_VERIFIER } from '../auth/google/google-token-verifier';
import { EMAIL_SENDER } from './email-sender';

async function makeService() {
  const users = { markEmailVerified: jest.fn().mockResolvedValue(undefined) };
  const jwt = { sign: jest.fn().mockReturnValue("signed"), verify: jest.fn() };
  const email = { send: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: UsersService, useValue: users },
      { provide: RefreshTokenService, useValue: {} },
      { provide: JwtService, useValue: jwt },
      { provide: PasswordBreachService, useValue: {} },
      { provide: EventEmitter2, useValue: {} },
      { provide: getToken('mova_signups_total'), useValue: { inc: jest.fn() } },
      { provide: GOOGLE_TOKEN_VERIFIER, useValue: { verify: jest.fn() } },
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: EMAIL_SENDER, useValue: email },
    ],
  }).compile();
  return { service: moduleRef.get(AuthService), users, jwt, email };
}

describe('AuthService email verification', () => {
  it('sends a verification link to the email', async () => {
    const { service, email } = await makeService();
    await service.sendEmailVerification("user-1", "a@b.com");
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@b.com" }),
    );
  });

  it('confirms a valid email_verify token', async () => {
    const { service, users, jwt } = await makeService();
    jwt.verify.mockReturnValue({ sub: "user-1", purpose: "email_verify" });
    await service.confirmEmail("tok");
    expect(users.markEmailVerified).toHaveBeenCalledWith("user-1");
  });

  it('rejects a token with the wrong purpose', async () => {
    const { service, users, jwt } = await makeService();
    jwt.verify.mockReturnValue({ sub: "user-1", purpose: "access" });
    await expect(service.confirmEmail("tok")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(users.markEmailVerified).not.toHaveBeenCalled();
  });

  it('rejects an invalid/expired token', async () => {
    const { service, jwt } = await makeService();
    jwt.verify.mockImplementation(() => {
      throw new Error("jwt expired");
    });
    await expect(service.confirmEmail("tok")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
