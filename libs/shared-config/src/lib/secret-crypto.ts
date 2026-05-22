import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * AES-256-GCM helper for the app_setting table.
 *
 * Wire format: `<iv_b64>:<tag_b64>:<ciphertext_b64>`. IV is 12 bytes (the
 * standard for GCM); tag is 16 bytes. The key is derived once via SHA-256
 * over the operator-supplied `SETTINGS_ENCRYPTION_KEY` so any sane password
 * length is folded into the 32-byte key AES-256 wants — same trick e.g.
 * argon-id-then-truncate would handle, but cheaper and reversible (we just
 * need a constant key per process, not a slow KDF).
 *
 * Failure modes the caller should be ready for:
 *   - SecretCrypto.fromEnv() throws when SETTINGS_ENCRYPTION_KEY is unset
 *     or shorter than 16 chars — fail-fast is correct; a missing key
 *     means admin-managed settings simply aren't available.
 *   - decrypt() throws on tampered ciphertext (GCM tag mismatch). Callers
 *     in SettingsService log + skip the row rather than crashing the
 *     bootstrap pass.
 */
export class SecretCrypto {
  private readonly key: Buffer;

  constructor(passphrase: string) {
    if (!passphrase || passphrase.length < 16) {
      throw new Error(
        'SETTINGS_ENCRYPTION_KEY must be at least 16 characters long',
      );
    }
    this.key = createHash('sha256').update(passphrase, 'utf8').digest();
  }

  /** Pull the passphrase from process.env. Convenience entry point. */
  static fromEnv(): SecretCrypto {
    const k = process.env['SETTINGS_ENCRYPTION_KEY'];
    if (!k) {
      throw new Error(
        'SETTINGS_ENCRYPTION_KEY is not set — admin-managed settings cannot be loaded.',
      );
    }
    return new SecretCrypto(k);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(packed: string): string {
    const parts = packed.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format — expected iv:tag:ct');
    }
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  /**
   * Mask a value for display in the admin UI. Returns the last 4 characters
   * prefixed with • dots so we never echo full secret material back over the
   * wire — even to authenticated admins, even on read.
   */
  static mask(value: string): string {
    if (value.length <= 4) return '••••';
    const tail = value.slice(-4);
    return `••••${tail}`;
  }
}
