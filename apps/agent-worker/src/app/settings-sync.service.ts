import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Redis } from 'ioredis';

import { reportError, SecretCrypto } from '@mova-back/shared-config';
import { AppSetting } from '@mova-back/shared-database';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { RedisChannels } from '@mova-back/shared-realtime';

/**
 * Bootstraps + lives-updates agent-worker's `process.env` from the
 * `app_setting` table written by the admin panel.
 *
 * Why this mirrors api-gateway's SettingsService:
 *   - Both processes need their `process.env` to reflect admin-managed
 *     overrides (LiveKit Agents OpenAI plugin, ElevenLabs adapter,
 *     Deepgram STT all read from process.env directly at construction
 *     time).
 *   - Admin only ever writes via api-gateway. agent-worker is read-only:
 *     hydrate at boot, then react to Redis `settings-updated` pub-sub
 *     so an admin save in the UI mutates this process's env within
 *     milliseconds. New AgentSession instantiations pick up the new key
 *     without a container restart.
 *
 * Disabled (degraded) when SETTINGS_ENCRYPTION_KEY is unset — same
 * pattern as the api-gateway side. The worker still runs on env-only
 * config; admin just can't manage keys until the operator sets the
 * encryption key once.
 */
@Injectable()
export class SettingsSyncService implements OnModuleInit {
  private readonly logger = new Logger(SettingsSyncService.name);
  private crypto: SecretCrypto | null = null;

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

  private subscribe(): void {
    const sub = this.redis.duplicate();
    sub.subscribe(RedisChannels.settingsUpdated).catch((err) =>
      reportError(this.logger, 'subscribe(settings-updated) failed', err),
    );
    sub.on('message', async (_channel, raw) => {
      try {
        const msg = JSON.parse(raw) as { key: string; action: 'upsert' | 'delete' };
        if (!msg.key || !this.crypto) return;
        if (msg.action === 'delete') {
          this.logger.debug(
            `settings-updated: ${msg.key} deleted in DB — keeping current process.env.`,
          );
          return;
        }
        const row = await this.settings.findOne({ where: { key: msg.key } });
        if (!row) return;
        process.env[msg.key] = this.crypto.decrypt(row.valueEncrypted);
        this.logger.log(`Re-hydrated ${msg.key} from settings-updated.`);
      } catch (err) {
        reportError(this.logger, 'Bad payload on settings-updated', err);
      }
    });
  }
}
