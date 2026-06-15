import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt, { type JwtHeader, type JwtPayload } from 'jsonwebtoken';

import type { AppEnv } from '@mova-back/shared-config';

import {
  FirebaseTokenVerifier,
  InvalidFirebaseTokenError,
  type FirebasePhoneIdentity,
} from './firebase-token-verifier';

// Google's public x509 certs for Firebase Auth ID tokens (the `securetoken`
// service signs them). Rotated periodically — honour the response's max-age.
const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface FirebaseClaims extends JwtPayload {
  phone_number?: string;
  firebase?: { sign_in_provider?: string };
}

@Injectable()
export class FetchFirebaseTokenVerifier implements FirebaseTokenVerifier {
  private readonly logger = new Logger(FetchFirebaseTokenVerifier.name);
  private readonly projectId: string;
  private certs: Record<string, string> = {};
  private certsExpireAt = 0;

  constructor(config: ConfigService<AppEnv, true>) {
    this.projectId =
      config.get<string>('FIREBASE_PROJECT_ID', { infer: true } as never) ?? '';
    if (!this.projectId) {
      this.logger.warn(
        'FIREBASE_PROJECT_ID is not set — /auth/phone/confirm will reject every request.',
      );
    }
  }

  async verifyPhone(idToken: string): Promise<FirebasePhoneIdentity> {
    if (!this.projectId) {
      throw new InvalidFirebaseTokenError(
        'Phone verification is not configured on this server',
      );
    }
    if (!idToken || typeof idToken !== 'string') {
      throw new InvalidFirebaseTokenError('Empty Firebase ID token');
    }

    const decoded = jwt.decode(idToken, { complete: true });
    const kid = (decoded?.header as JwtHeader | undefined)?.kid;
    if (!kid) throw new InvalidFirebaseTokenError('Token missing key id');

    const pem = await this.certForKid(kid);
    if (!pem) throw new InvalidFirebaseTokenError('Unknown signing key');

    let claims: FirebaseClaims;
    try {
      claims = jwt.verify(idToken, pem, {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${this.projectId}`,
        audience: this.projectId,
      }) as FirebaseClaims;
    } catch (err) {
      throw new InvalidFirebaseTokenError(
        err instanceof Error ? err.message : 'Token verification failed',
      );
    }

    if (claims.firebase?.sign_in_provider !== 'phone') {
      throw new InvalidFirebaseTokenError('Token is not from phone sign-in');
    }
    if (!claims.sub) throw new InvalidFirebaseTokenError('Token missing subject');
    if (!claims.phone_number) {
      throw new InvalidFirebaseTokenError('Token missing phone_number');
    }

    return { firebaseUid: claims.sub, phoneNumber: claims.phone_number };
  }

  private async certForKid(kid: string): Promise<string | undefined> {
    if (Date.now() >= this.certsExpireAt) {
      await this.refreshCerts();
    }
    if (!this.certs[kid]) {
      // Key may have just rotated — force one refresh before giving up.
      await this.refreshCerts();
    }
    return this.certs[kid];
  }

  private async refreshCerts(): Promise<void> {
    const res = await fetch(CERTS_URL);
    if (!res.ok) {
      throw new InvalidFirebaseTokenError(
        `Could not fetch Firebase signing certs (HTTP ${res.status})`,
      );
    }
    this.certs = (await res.json()) as Record<string, string>;
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
    const ttlMs = maxAge ? Number(maxAge[1]) * 1000 : 60 * 60 * 1000;
    this.certsExpireAt = Date.now() + ttlMs;
  }
}
