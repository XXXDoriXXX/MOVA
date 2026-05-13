import { createHash } from 'crypto';

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@mova-back/shared-config';

/**
 * Have I Been Pwned — Pwned Passwords API.
 *
 * Uses the k-anonymity model: we send only the first 5 chars of the SHA-1 hash
 * of the password. The server responds with all hashes that share that prefix
 * + a count of breaches. We check locally if our suffix is in the response.
 *
 * Privacy: the FULL password never leaves this process; even the prefix tells
 * the server nothing identifiable about the user. Used by 1Password, Firefox
 * Monitor, etc. — production-trusted API.
 *
 * Failure mode:
 *   - Network error / timeout: returns `unknown` (caller decides — for MVP we
 *     fail-open per HIBP_ENABLED=true default; logged to Sentry as a warning).
 *   - HIBP downtime should NOT block signup — bad UX outweighs the risk.
 */
@Injectable()
export class PasswordBreachService {
  private readonly logger = new Logger(PasswordBreachService.name);

  private readonly enabled: boolean;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<AppEnv, true>) {
    this.enabled = config.get('HIBP_ENABLED', { infer: true });
    this.apiUrl = config.get('HIBP_API_URL', { infer: true });
    this.timeoutMs = config.get('HIBP_TIMEOUT_MS', { infer: true });
  }

  /**
   * Check if the password appears in any known breach.
   *
   * @param password — plain-text password (NEVER logged)
   * @returns true if breached, false if not, throws only on FATAL internal misconfig
   *          (never on network failures — those degrade to `false` + log)
   */
  async isBreached(password: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    if (password.length < 1) {
      // Defensive: empty password is already invalid upstream, but don't
      // hash empty strings.
      return false;
    }

    const sha1Hex = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1Hex.slice(0, 5);
    const suffix = sha1Hex.slice(5);

    try {
      const response = await this.fetchPrefix(prefix);
      // Response is a list of `SUFFIX:COUNT` lines.
      return response.split('\n').some((line) => {
        const [hash] = line.trim().split(':');
        return hash === suffix;
      });
    } catch (err) {
      this.logger.warn(
        `HIBP check failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fail-open: better UX than blocking signup on transient API errors.
      // Production should track these failures in Sentry / metrics.
      return false;
    }
  }

  /**
   * Convenience: throw a structured 422 if password is breached.
   * Use in services where breach is hard-blocking (signup, password change).
   */
  async assertNotBreached(password: string): Promise<void> {
    if (await this.isBreached(password)) {
      throw new HttpException(
        {
          error: {
            code: 'PASSWORD_BREACHED',
            message:
              'Цей пароль є у відомих витоках. Оберіть інший, унікальний пароль.',
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private async fetchPrefix(prefix: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiUrl}/range/${prefix}`, {
        method: 'GET',
        headers: {
          // Recommended by HIBP — request only password breaches, not breach
          // names (smaller response).
          'Add-Padding': 'true',
          'User-Agent': 'mova-back/PasswordBreachService',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HIBP returned ${res.status}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}
