import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getToken } from '@willsoto/nestjs-prometheus';
import * as bcrypt from 'bcrypt';

import { PasswordBreachService } from '@mova-back/shared-auth';
import { UserRole } from '@mova-back/shared-database';

import { AuthService } from './auth.service';
import { RegisterSchema } from './dto/auth.schemas';
import { RefreshTokenService } from './refresh-token.service';
import { GOOGLE_TOKEN_VERIFIER } from './google/google-token-verifier';
import { UsersService } from '../users/users.service';
import { EMAIL_SENDER } from '../email/email-sender';

const dto = RegisterSchema.parse({
  email: 'tester@example.com', password: 'Sup3rStr0ngPass!', name: 'Tester', username: 'tester',
});

async function makeSubject(enabled: boolean) {
  const users = {
    create: jest.fn().mockImplementation(async (input) => ({
      ...input, id: 'tester-id', role: UserRole.USER, emailVerifiedAt: null,
      isBlocked: false, createdAt: new Date(),
    })),
    markEmailVerified: jest.fn().mockResolvedValue(undefined),
    findByEmail: jest.fn(),
  };
  const events = { emitAsync: jest.fn().mockResolvedValue([]) };
  const email = { send: jest.fn() };
  const refresh = { issue: jest.fn().mockResolvedValue({ token: 'refresh', expiresAt: new Date() }) };
  const breach = { assertNotBreached: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = await Test.createTestingModule({ providers: [
    AuthService,
    { provide: UsersService, useValue: users },
    { provide: ConfigService, useValue: { get: jest.fn((key) => key === 'BETA_ACCESS_ENABLED' ? enabled : undefined) } },
    { provide: EventEmitter2, useValue: events },
    { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue('access') } },
    { provide: RefreshTokenService, useValue: refresh },
    { provide: PasswordBreachService, useValue: breach },
    { provide: GOOGLE_TOKEN_VERIFIER, useValue: {} },
    { provide: EMAIL_SENDER, useValue: email },
    { provide: getToken('mova_signups_total'), useValue: { inc: jest.fn() } },
  ] }).compile();
  return { service: moduleRef.get(AuthService), users, events, email, refresh, breach };
}

describe('admin-approved beta accounts', () => {
  it('rejects provisioning when beta access is disabled without creating an account', async () => {
    const { service, users, breach } = await makeSubject(false);
    await expect(service.createBetaTester(dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(users.create).not.toHaveBeenCalled();
    expect(breach.assertNotBreached).not.toHaveBeenCalled();
  });

  it('creates a verified regular tester without email or tokens, who can then log in', async () => {
    const { service, users, events, email, refresh, breach } = await makeSubject(true);
    const result = await service.createBetaTester(dto);
    const user = await users.create.mock.results[0].value;
    expect(result).toMatchObject({ role: UserRole.USER, emailVerified: true });
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('tokens');
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ email: dto.email, username: dto.username }));
    expect(users.markEmailVerified).toHaveBeenCalledWith('tester-id');
    expect(breach.assertNotBreached).toHaveBeenCalledWith(dto.password);
    expect(await bcrypt.compare(dto.password, user.passwordHash)).toBe(true);
    expect(events.emitAsync).toHaveBeenCalledWith('user.registered', expect.objectContaining({ userId: 'tester-id' }));
    expect(email.send).not.toHaveBeenCalled();
    expect(refresh.issue).not.toHaveBeenCalled();
    users.findByEmail.mockResolvedValue(user);
    expect(await service.login(dto, {})).toMatchObject({ tokens: { accessToken: 'access' } });
  });

  it('rejects public signup before password checks or writes during closed beta', async () => {
    const { service, users, email, breach, events } = await makeSubject(true);
    await expect(service.register(dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(breach.assertNotBreached).not.toHaveBeenCalled();
    expect(users.create).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('keeps normal public signup unverified when beta access is disabled', async () => {
    const { service, users, email } = await makeSubject(false);
    expect(await service.register(dto)).toMatchObject({ verificationRequired: true });
    expect(users.markEmailVerified).not.toHaveBeenCalled();
    expect(email.send).toHaveBeenCalled();
  });

  it('preserves duplicate-account conflicts without approval or a registration event', async () => {
    const { service, users, events } = await makeSubject(true);
    users.create.mockRejectedValue(new ConflictException('Email already in use'));
    await expect(service.createBetaTester(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(users.markEmailVerified).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
  });
});
