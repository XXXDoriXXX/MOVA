import { createHash } from 'crypto';

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@mova-back/shared-config';

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

  async isBreached(password: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    const sha1Hex = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1Hex.slice(0, 5);
    const suffix = sha1Hex.slice(5);

    try {
      const response = await this.fetchPrefix(prefix);
      return response.split('\n').some((line) => {
        const [hash] = line.trim().split(':');
        return hash === suffix;
      });
    } catch (err) {
      this.logger.warn(
        `HIBP check failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

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
