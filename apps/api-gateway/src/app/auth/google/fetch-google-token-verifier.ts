import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@mova-back/shared-config';

import {
  GoogleTokenVerifier,
  InvalidGoogleTokenError,
  type GoogleIdentity,
} from './google-token-verifier';

interface TokenInfoResponse {
  iss?: string;
  sub?: string;
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  exp?: string | number;
  error_description?: string;
}

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const VALID_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

@Injectable()
export class FetchGoogleTokenVerifier implements GoogleTokenVerifier {
  private readonly logger = new Logger(FetchGoogleTokenVerifier.name);
  private readonly audiences: ReadonlySet<string>;

  constructor(config: ConfigService<AppEnv, true>) {
    const raw =
      config.get<string>('GOOGLE_OAUTH_CLIENT_ID', { infer: true } as never) ??
      '';
    this.audiences = new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (this.audiences.size === 0) {
      this.logger.warn('GOOGLE_OAUTH_CLIENT_ID is not set — /auth/google will reject every request.');
    }
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (this.audiences.size === 0) {
      throw new InvalidGoogleTokenError('Google sign-in is not configured on this server');
    }
    if (!idToken || typeof idToken !== 'string') {
      throw new InvalidGoogleTokenError('Empty Google ID token');
    }

    const response = await fetch(
      `${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`,
      { method: 'GET' },
    );
    if (!response.ok) {
      throw new InvalidGoogleTokenError(
        `Google rejected the token (HTTP ${response.status})`,
      );
    }
    const payload = (await response.json()) as TokenInfoResponse;
    if (payload.error_description) {
      throw new InvalidGoogleTokenError(payload.error_description);
    }
    if (!payload.iss || !VALID_ISSUERS.includes(payload.iss)) {
      throw new InvalidGoogleTokenError(`Invalid issuer: ${payload.iss}`);
    }
    if (!payload.aud || !this.audiences.has(payload.aud)) {
      throw new InvalidGoogleTokenError('Audience mismatch');
    }
    const exp = Number(payload.exp ?? 0);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
      throw new InvalidGoogleTokenError('Token expired');
    }
    if (!payload.sub) {
      throw new InvalidGoogleTokenError('Token missing subject');
    }
    if (!payload.email) {
      throw new InvalidGoogleTokenError('Token missing email');
    }

    return {
      googleId: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified:
        payload.email_verified === true || payload.email_verified === 'true',
      name: payload.name ?? null,
    };
  }
}
