import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { getToken } from '@willsoto/nestjs-prometheus';
import { Test } from '@nestjs/testing';

import { PasswordBreachService } from '@mova-back/shared-auth';

import { AuthService } from '../auth.service';
import { UsersService } from '../../users/users.service';
import { RefreshTokenService } from '../refresh-token.service';
import { GOOGLE_TOKEN_VERIFIER } from '../google/google-token-verifier';
import {
  FIREBASE_TOKEN_VERIFIER,
  InvalidFirebaseTokenError,
} from './firebase-token-verifier';

async function makeService() {
  const users = { setVerifiedPhone: jest.fn().mockResolvedValue(undefined) };
  const firebase = { verifyPhone: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: UsersService, useValue: users },
      { provide: RefreshTokenService, useValue: {} },
      { provide: JwtService, useValue: {} },
      { provide: PasswordBreachService, useValue: {} },
      { provide: EventEmitter2, useValue: {} },
      { provide: getToken('mova_signups_total'), useValue: { inc: jest.fn() } },
      { provide: GOOGLE_TOKEN_VERIFIER, useValue: { verify: jest.fn() } },
      { provide: FIREBASE_TOKEN_VERIFIER, useValue: firebase },
    ],
  }).compile();
  return { service: moduleRef.get(AuthService), users, firebase };
}

describe('AuthService.confirmPhone', () => {
  it('claims the verified number for the user', async () => {
    const { service, users, firebase } = await makeService();
    firebase.verifyPhone.mockResolvedValue({
      firebaseUid: 'fb-1',
      phoneNumber: '+380501112233',
    });

    const result = await service.confirmPhone('user-1', 'tok');

    expect(result).toEqual({ phoneNumber: '+380501112233' });
    expect(users.setVerifiedPhone).toHaveBeenCalledWith(
      'user-1',
      '+380501112233',
    );
  });

  it('maps an invalid Firebase token to 401', async () => {
    const { service, firebase, users } = await makeService();
    firebase.verifyPhone.mockRejectedValue(
      new InvalidFirebaseTokenError('bad token'),
    );

    await expect(service.confirmPhone('user-1', 'tok')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.setVerifiedPhone).not.toHaveBeenCalled();
  });

  it('maps a duplicate verified number (23505) to 409', async () => {
    const { service, users, firebase } = await makeService();
    firebase.verifyPhone.mockResolvedValue({
      firebaseUid: 'fb-1',
      phoneNumber: '+380501112233',
    });
    users.setVerifiedPhone.mockRejectedValue({ code: '23505' });

    await expect(service.confirmPhone('user-1', 'tok')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
