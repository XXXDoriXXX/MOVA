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

  /**
   * Per-key debounce window. settingsUpdated messages may arrive in
   * bursts when an operator clicks "save" multiple times or when the
   * admin UI sends optimistic updates that immediately revert. Without
   * a debounce, each message hits Postgres for findOne + decrypts —
   * cheap individually but easy to stack up under a rapid save loop.
   * 500ms is below human-perceivable latency for "the change applied"
   * and tight enough that even a true rapid sequence collapses to one
   * DB read per key.
   */
  private static readonly SETTINGS_DEBOUNCE_MS = 500;
  /** Per-key debounce timers; on a fresh message we reset the timer
   *  for that key, so only the LAST event in a burst triggers the
   *  hydrate. */
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  private subscribe(): void {
    const sub = this.redis.duplicate();
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
        // Don't debounce delete: it's a no-op on our side (we keep
        // the in-memory env value so an in-flight call doesn't
        // suddenly lose its provider key). Logging only.
        this.logger.debug(
          `settings-updated: ${msg.key} deleted in DB — keeping current process.env.`,
        );
        // Drop any pending re-hydrate for this key — the row is gone.
        const pending = this.debounceTimers.get(msg.key);
        if (pending) {
          clearTimeout(pending);
          this.debounceTimers.delete(msg.key);
        }
        return;
      }
      // upsert: debounce the actual DB read + decrypt. Resetting the
      // timer on a fresh message is the standard "trailing edge"
      // debounce — last event wins, intermediate writes collapse.
      const existing = this.debounceTimers.get(msg.key);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        this.debounceTimers.delete(msg.key);
        void this.applyUpsert(msg.key);
      }, SettingsSyncService.SETTINGS_DEBOUNCE_MS);
      this.debounceTimers.set(msg.key, t);
    });
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
