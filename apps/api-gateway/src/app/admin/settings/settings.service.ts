import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Redis } from 'ioredis';

import { reportError, SecretCrypto } from '@mova-back/shared-config';
import { AppSetting } from '@mova-back/shared-database';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { RedisChannels } from '@mova-back/shared-realtime';

import { findKnownSetting, KNOWN_SETTINGS, type KnownSetting } from './known-settings';

export interface SettingRow {
  key: string;
  label: string;
  group: string;
  description: string;
  masked: string | null;
  source: 'db' | 'env' | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private crypto: SecretCrypto | null = null;
  private readonly originalEnv = new Map<string, string | undefined>();

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
        `Admin settings overlay disabled: ${
          err instanceof Error ? err.message : String(err)
        }. Set SETTINGS_ENCRYPTION_KEY in .env to enable.`,
      );
      return;
    }
    await this.hydrateProcessEnv();
    this.subscribeToUpdates();
  }

  async listForAdmin(): Promise<SettingRow[]> {
    const rows = await this.settings.find();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return KNOWN_SETTINGS.map((known) => {
      const dbRow = byKey.get(known.key);
      const envValue = process.env[known.key];
      let masked: string | null = null;
      let source: 'db' | 'env' | null = null;
      let updatedAt: string | null = null;
      let updatedBy: string | null = null;
      if (dbRow && this.crypto) {
        try {
          const plain = this.crypto.decrypt(dbRow.valueEncrypted);
          masked = SecretCrypto.mask(plain);
          source = 'db';
          updatedAt = dbRow.updatedAt.toISOString();
          updatedBy = dbRow.updatedBy;
        } catch (err) {
          reportError(this.logger, `Failed to decrypt ${known.key}`, err);
          masked = '⚠ corrupt';
          source = 'db';
        }
      } else if (envValue && envValue.length > 0) {
        masked = SecretCrypto.mask(envValue);
        source = 'env';
      }
      return {
        key: known.key,
        label: known.label,
        group: known.group,
        description: known.description,
        masked,
        source,
        updatedAt,
        updatedBy,
      };
    });
  }

  async set(
    key: string,
    value: string,
    actorUserId: string | null,
  ): Promise<{ masked: string }> {
    const known = this.requireKnown(key);
    if (value.length < known.minLength) {
      throw new Error(
        `Значення для ${key} занадто коротке (мінімум ${known.minLength} символів).`,
      );
    }
    const crypto = this.requireCrypto();
    const encrypted = crypto.encrypt(value);
    await this.settings.save({
      key,
      valueEncrypted: encrypted,
      updatedBy: actorUserId,
    });
    process.env[key] = value;
    await this.publish(key, 'upsert');
    return { masked: SecretCrypto.mask(value) };
  }

  async clear(key: string): Promise<void> {
    this.requireKnown(key);
    await this.settings.delete(key);
    await this.publish(key, 'delete');
  }

  private async hydrateProcessEnv(): Promise<void> {
    if (!this.crypto) return;
    let rows: AppSetting[];
    try {
      rows = await this.settings.find();
    } catch (err) {
      reportError(this.logger, 'Settings hydrate failed (DB unreachable?)', err);
      return;
    }
    let applied = 0;
    for (const row of rows) {
      try {
        const plain = this.crypto.decrypt(row.valueEncrypted);
        if (!this.originalEnv.has(row.key)) {
          this.originalEnv.set(row.key, process.env[row.key]);
        }
        process.env[row.key] = plain;
        applied += 1;
      } catch (err) {
        reportError(this.logger, `Failed to decrypt setting ${row.key}`, err);
      }
    }
    if (applied > 0) {
      this.logger.log(
        `Hydrated process.env from app_setting: ${applied} key(s) overridden`,
      );
    }
  }

  private subscribeToUpdates(): void {
    const subscriber = this.redis.duplicate();
    subscriber.subscribe(RedisChannels.settingsUpdated).catch((err) =>
      reportError(this.logger, 'Failed to subscribe to settings-updated', err),
    );
    subscriber.on('message', async (_channel, raw) => {
      try {
        const msg = JSON.parse(raw) as { key: string; action: 'upsert' | 'delete' };
        if (!msg.key) return;
        if (msg.action === 'delete') {
          this.revertEnv(msg.key);
          this.logger.log(
            `settings-updated: ${msg.key} deleted — reverted process.env.`,
          );
          return;
        }
        await this.rehydrateOne(msg.key);
      } catch (err) {
        reportError(this.logger, 'Bad payload on settings-updated', err, { raw });
      }
    });
  }

  private revertEnv(key: string): void {
    if (this.originalEnv.has(key)) {
      const original = this.originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
      this.originalEnv.delete(key);
    } else {
      delete process.env[key];
    }
  }

  private async rehydrateOne(key: string): Promise<void> {
    if (!this.crypto) return;
    const row = await this.settings.findOne({ where: { key } });
    if (!row) return;
    try {
      if (!this.originalEnv.has(key)) {
        this.originalEnv.set(key, process.env[key]);
      }
      process.env[key] = this.crypto.decrypt(row.valueEncrypted);
      this.logger.log(`Re-hydrated ${key} from settings-updated`);
    } catch (err) {
      reportError(this.logger, `Re-hydrate failed for ${key}`, err);
    }
  }

  private async publish(key: string, action: 'upsert' | 'delete'): Promise<void> {
    try {
      await this.redis.publish(
        RedisChannels.settingsUpdated,
        JSON.stringify({ key, action }),
      );
    } catch (err) {
      reportError(this.logger, 'settings-updated publish failed', err, { key });
    }
  }

  private requireKnown(key: string): KnownSetting {
    const k = findKnownSetting(key);
    if (!k) {
      throw new Error(`Unknown setting: ${key}`);
    }
    return k;
  }

  private requireCrypto(): SecretCrypto {
    if (!this.crypto) {
      throw new Error(
        'SETTINGS_ENCRYPTION_KEY is not configured — cannot persist secrets.',
      );
    }
    return this.crypto;
  }
}
