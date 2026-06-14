import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Redis } from 'ioredis';

import { reportError, SecretCrypto } from '@mova-back/shared-config';
import { AppSetting } from '@mova-back/shared-database';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { RedisChannels } from '@mova-back/shared-realtime';

@Injectable()
export class SettingsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsSyncService.name);
  private crypto: SecretCrypto | null = null;
  private sub: Redis | null = null;

  constructor(
    @InjectRepository(AppSetting)
    private readonly settings: Repository<AppSetting>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.crypto = SecretCrypto.fromEnv();
    } catch (err) {
      this.logger.warn(
        `Settings overlay disabled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    await this.hydrate();
    this.subscribe();
  }

  private async hydrate(): Promise<void> {
    if (!this.crypto) return;
    let rows: AppSetting[];
    try {
      rows = await this.settings.find();
    } catch (err) {
      reportError(this.logger, 'Settings hydrate failed', err);
      return;
    }
    let applied = 0;
    for (const row of rows) {
      try {
        process.env[row.key] = this.crypto.decrypt(row.valueEncrypted);
        applied += 1;
      } catch (err) {
        reportError(this.logger, `Decrypt failed for ${row.key}`, err);
      }
    }
    if (applied > 0) {
      this.logger.log(`Hydrated process.env from app_setting: ${applied} key(s).`);
    }
  }

  private static readonly SETTINGS_DEBOUNCE_MS = 500;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  private subscribe(): void {
    const sub = this.redis.duplicate();
    this.sub = sub;
    sub.subscribe(RedisChannels.settingsUpdated).catch((err) =>
      reportError(this.logger, 'subscribe(settings-updated) failed', err),
    );
    sub.on('message', (_channel, raw) => {
      let msg: { key: string; action: 'upsert' | 'delete' };
      try {
        msg = JSON.parse(raw) as { key: string; action: 'upsert' | 'delete' };
      } catch (err) {
        reportError(this.logger, 'Bad payload on settings-updated', err);
        return;
      }
      if (!msg.key || !this.crypto) return;
      if (msg.action === 'delete') {
        this.logger.debug(
          `settings-updated: ${msg.key} deleted in DB — keeping current process.env.`,
        );
        const pending = this.debounceTimers.get(msg.key);
        if (pending) {
          clearTimeout(pending);
          this.debounceTimers.delete(msg.key);
        }
        return;
      }
      const existing = this.debounceTimers.get(msg.key);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        this.debounceTimers.delete(msg.key);
        void this.applyUpsert(msg.key);
      }, SettingsSyncService.SETTINGS_DEBOUNCE_MS);
      this.debounceTimers.set(msg.key, t);
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const t of this.debounceTimers.values()) {
      clearTimeout(t);
    }
    this.debounceTimers.clear();
    const sub = this.sub;
    this.sub = null;
    if (sub) {
      try {
        await sub.quit();
      } catch (err) {
        reportError(this.logger, 'Failed to quit settings-updated subscriber', err);
      }
    }
  }

  private async applyUpsert(key: string): Promise<void> {
    if (!this.crypto) return;
    try {
      const row = await this.settings.findOne({ where: { key } });
      if (!row) return;
      process.env[key] = this.crypto.decrypt(row.valueEncrypted);
      this.logger.log(`Re-hydrated ${key} from settings-updated.`);
    } catch (err) {
      reportError(this.logger, `Failed to re-hydrate ${key}`, err);
    }
  }
}
