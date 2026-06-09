import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { getToken } from '@willsoto/nestjs-prometheus';

import { PasswordBreachService } from '@mova-back/shared-auth';

import { AuthService } from '../auth.service';
import { RefreshTokenService } from '../refresh-token.service';
import { UsersService } from '../../users/users.service';
import {
  GOOGLE_TOKEN_VERIFIER,
  InvalidGoogleTokenError,
  type GoogleIdentity,
} from './google-token-verifier';

const ctx = { userAgent: 'jest', ipAddress: '127.0.0.1' };

const validIdentity: GoogleIdentity = {
  googleId: 'google-sub-123',
  email: 'user@example.com',
  emailVerified: true,
  name: 'Test User',
};

function buildUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    googleId: null,
    isBlocked: false,
    passwordHash: 'hash',
    language: 'uk',
    preferredStyleId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

async function buildSubject(overrides: {
  verifyResult?: Promise<GoogleIdentity>;
  findByGoogleId?: jest.Mock;
  findByEmail?: jest.Mock;
  createFromGoogle?: jest.Mock;
  linkGoogleId?: jest.Mock;
}) {
  const users = {
    findByGoogleId: overrides.findByGoogleId ?? jest.fn().mockResolvedValue(null),
    findByEmail: overrides.findByEmail ?? jest.fn().mockResolvedValue(null),
    createFromGoogle: overrides.createFromGoogle ?? jest.fn().mockResolvedValue(buildUser()),
    linkGoogleId: overrides.linkGoogleId ?? jest.fn().mockResolvedValue(undefined),
  };
  const refreshTokens = {
    issue: jest.fn().mockResolvedValue({
      token: 'refresh-raw',
      expiresAt: new Date(Date.now() + 60_000),
    }),
  };
  const jwt = { sign: jest.fn().mockReturnValue('access-jwt') };
  const passwordBreach = { assertNotBreached: jest.fn().mockResolvedValue(undefined) };
  const events = { emitAsync: jest.fn().mockResolvedValue([]) };
  const verifier = {
    verify: jest.fn().mockReturnValue(
      overrides.verifyResult ?? Promise.resolve(validIdentity),
    ),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: UsersService, useValue: users },
      { provide: RefreshTokenService, useValue: refreshTokens },
      { provide: JwtService, useValue: jwt },
      { provide: PasswordBreachService, useValue: passwordBreach },
      { provide: EventEmitter2, useValue: events },
      {
        provide: getToken('mova_signups_total'),
        useValue: { inc: jest.fn() },
      },
      { provide: GOOGLE_TOKEN_VERIFIER, useValue: verifier },
    ],
  }).compile();

  return {
    service: moduleRef.get(AuthService),
    users,
    refreshTokens,
    verifier,
    events,
  };
}

describe('AuthService.googleSignIn', () => {
  it('creates a brand-new user when Google id is unknown and email is free', async () => {
    const created = buildUser({ id: 'fresh-1', googleId: 'google-sub-123' });
    const { service, users, events } = await buildSubject({
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      createFromGoogle: jest.fn().mockResolvedValue(created),
    });

    const response = await service.googleSignIn('valid-id-token', ctx);

    expect(users.createFromGoogle).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@example.com',
        googleId: 'google-sub-123',
        name: 'Test User',
      }),
    );
    expect(events.emitAsync).toHaveBeenCalledWith(
      'user.registered',
      expect.objectContaining({ userId: 'fresh-1', email: 'user@example.com' }),
    );
    expect(response.user.email).toBe('user@example.com');
    expect(response.tokens.accessToken).toBe('access-jwt');
  });

  it('links Google id to an existing email-only account', async () => {
    const existing = buildUser({ id: 'existing-1', googleId: null });
    const { service, users, events } = await buildSubject({
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(existing),
    });

    await service.googleSignIn('valid-id-token', ctx);

    expect(users.linkGoogleId).toHaveBeenCalledWith('existing-1', 'google-sub-123');
    expect(users.createFromGoogle).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it('signs in directly when Google id already known', async () => {
    const user = buildUser({ id: 'returning-1', googleId: 'google-sub-123' });
    const { service, users } = await buildSubject({
      findByGoogleId: jest.fn().mockResolvedValue(user),
    });

    const response = await service.googleSignIn('valid-id-token', ctx);

    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(users.linkGoogleId).not.toHaveBeenCalled();
    expect(users.createFromGoogle).not.toHaveBeenCalled();
    expect(response.user.email).toBe('user@example.com');
  });

  it('rejects an unverified Google email', async () => {
    const { service, users } = await buildSubject({
      verifyResult: Promise.resolve({ ...validIdentity, emailVerified: false }),
    });

    await expect(service.googleSignIn('t', ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.findByGoogleId).not.toHaveBeenCalled();
  });

  it('rejects an invalid Google ID token', async () => {
    const { service } = await buildSubject({
      verifyResult: Promise.reject(new InvalidGoogleTokenError('Audience mismatch')),
    });

    await expect(service.googleSignIn('t', ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses to sign in a blocked existing account', async () => {
    const blocked = buildUser({ id: 'blocked-1', isBlocked: true });
    const { service } = await buildSubject({
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(blocked),
    });

    await expect(service.googleSignIn('t', ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
