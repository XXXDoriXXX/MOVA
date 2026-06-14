import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

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

  static mask(value: string): string {
    if (value.length <= 4) return '••••';
    const tail = value.slice(-4);
    return `••••${tail}`;
  }
}
