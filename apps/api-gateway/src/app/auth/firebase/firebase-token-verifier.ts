export const FIREBASE_TOKEN_VERIFIER = Symbol('FIREBASE_TOKEN_VERIFIER');

export interface FirebasePhoneIdentity {
  /** Firebase UID (the `sub` claim). */
  readonly firebaseUid: string;
  /** E.164 phone number proven via the SMS OTP. */
  readonly phoneNumber: string;
}

export interface FirebaseTokenVerifier {
  /** Verify a Firebase phone-auth ID token; returns the proven phone number. */
  verifyPhone(idToken: string): Promise<FirebasePhoneIdentity>;
}

export class InvalidFirebaseTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFirebaseTokenError';
  }
}
