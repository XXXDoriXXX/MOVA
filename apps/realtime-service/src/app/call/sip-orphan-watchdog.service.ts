import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RoomServiceClient } from 'livekit-server-sdk';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { reportError, type AppEnv } from '@mova-back/shared-config';

@Injectable()
export class SipOrphanWatchdog implements OnModuleInit {
  private readonly logger = new Logger(SipOrphanWatchdog.name);
  private roomService: RoomServiceClient | null = null;
  private static readonly DISPATCH_GRACE_SECONDS = 60;

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const wssUrl = this.config.get('LIVEKIT_URL', { infer: true });
    const apiKey = this.config.get('LIVEKIT_API_KEY', { infer: true });
    const apiSecret = this.config.get('LIVEKIT_API_SECRET', { infer: true });
    if (!wssUrl || !apiKey || !apiSecret) {
      this.logger.warn(
        'LIVEKIT_* env not set — SIP-orphan watchdog disabled.',
      );
      return;
    }
    const httpUrl = wssUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');
    this.roomService = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    this.logger.log('SIP-orphan watchdog armed (every 30s).');
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    if (!this.roomService) return;
    let rooms;
    try {
      rooms = await this.roomService.listRooms();
    } catch (err) {
      this.logger.warn(
        `listRooms failed: ${(err as Error).message}`,
      );
      return;
    }
    const orphans: string[] = [];
    for (const room of rooms) {
      if (!room.name?.startsWith('call-')) continue;
      const ageSeconds = room.creationTime
        ? (Date.now() - Number(room.creationTime) * 1000) / 1000
        : Number.POSITIVE_INFINITY;
      if (ageSeconds < SipOrphanWatchdog.DISPATCH_GRACE_SECONDS) continue;

      let owner: string | null = null;
      try {
        owner = await this.redis.get(`call-owner:${room.name}`);
      } catch (err) {
        this.logger.debug(
          `owner lookup failed for ${room.name}: ${(err as Error).message}`,
        );
        continue;
      }
      if (owner) continue;
      orphans.push(room.name);
    }
    if (orphans.length === 0) return;
    this.logger.warn(
      `SIP-orphan sweep: ${orphans.length} unowned room(s) — force-deleting.`,
    );
    for (const name of orphans) {
      try {
        await this.roomService.deleteRoom(name);
        this.logger.log({
          msg: 'sip-orphan.deleted',
          roomName: name,
        });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (/not.?found|does not exist|404/i.test(message)) continue;
        reportError(this.logger, 'sip-orphan deleteRoom failed', err, {
          roomName: name,
        });
      }
    }
  }
}
