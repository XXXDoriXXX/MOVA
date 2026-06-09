export const GOOGLE_TOKEN_VERIFIER = Symbol('GOOGLE_TOKEN_VERIFIER');

export interface GoogleIdentity {
  readonly googleId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

export interface GoogleTokenVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

export class InvalidGoogleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGoogleTokenError';
  }
}
