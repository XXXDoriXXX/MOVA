import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RoomServiceClient } from 'livekit-server-sdk';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { reportError, type AppEnv } from '@mova-back/shared-config';

/**
 * SIP-orphan watchdog. Force-deletes LiveKit rooms that no longer have
 * an owning agent-worker pod, so an orphaned SIP participant cannot
 * keep billing the user / telco indefinitely.
 *
 * Origin: when agent-worker crashes mid-call (SIGKILL, OOM, panic),
 * the AgentSession teardown never runs → room.deleteRoom() isn't called
 * → LiveKit holds the SIP leg until its own idle timeout (default 5 min,
 * sometimes longer). For a deaf-user proxy that's 5 min of the caller
 * thinking "hello? hello?" plus full per-second telco charges.
 *
 * Detection signal: the cross-pod ownership claims (`call-owner:{room}`)
 * written by agent-runner's `initiateCall` Phase 2.4. Active calls have
 * a non-expired owner. Dead pods leave LiveKit rooms behind with NO
 * owner — that's our orphan flag.
 *
 * Why this lives in realtime-service (not agent-worker / api-gateway):
 *   - agent-worker is the thing that died, so it can't cleanup itself.
 *   - api-gateway already has a `conversation-watchdog.service.ts` for
 *     the DB side (marks stale-active conversations failed). This
 *     service handles the LiveKit side.
 *   - realtime-service is already a long-lived control-plane process
 *     with the same Redis client + LiveKit creds — natural home.
 *
 * Failure modes we deliberately tolerate:
 *   - LiveKit listRooms() rate-limit / 5xx — skip this tick, retry next.
 *   - Redis blip during owner lookup — skip the affected room rather
 *     than wrongly declaring it orphan (false-positive is worse than
 *     false-negative here; a real orphan eventually times out at
 *     LiveKit anyway, but a wrongly-deleted active call kills a real
 *     conversation).
 */
@Injectable()
export class SipOrphanWatchdog implements OnModuleInit {
  private readonly logger = new Logger(SipOrphanWatchdog.name);
  private roomService: RoomServiceClient | null = null;
  /** Don't delete a room that was created less than this many seconds
   *  ago — the dispatch → first-heartbeat → ownership-claim race is
   *  typically <5s but can stretch to 20s on a slow cold-start. */
  private static readonly DISPATCH_GRACE_SECONDS = 60;

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    // LiveKit creds are validated at app bootstrap (env.validation),
    // so getOrThrow at module init means a misconfigured deployment
    // fails fast instead of silently disabling the watchdog.
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

  /**
   * Runs every 30s — same cadence as the agent's idle-probe window so
   * a single missed heartbeat doesn't cause back-to-back orphan
   * checks. Cron is per-replica; if you scale realtime-service to >1
   * pod, both will run this — and that's fine (Redis GET + LiveKit
   * deleteRoom are both idempotent). For now we trust there's a single
   * realtime-service replica per env; if/when that changes, add a
   * Redlock here too.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    if (!this.roomService) return; // disabled
    let rooms;
    try {
      rooms = await this.roomService.listRooms();
    } catch (err) {
      // Don't fail the cron — next tick will retry. Logged at warn so
      // a sustained LiveKit outage shows up in alerting.
      this.logger.warn(
        `listRooms failed: ${(err as Error).message}`,
      );
      return;
    }
    const orphans: string[] = [];
    for (const room of rooms) {
      // We only own room names matching `call-<uuid>`. Anything else
      // is someone else's traffic (manual SDK tests, dev exploration) —
      // do not touch.
      if (!room.name?.startsWith('call-')) continue;
      const ageSeconds = room.creationTime
        ? (Date.now() - Number(room.creationTime) * 1000) / 1000
        : Number.POSITIVE_INFINITY;
      if (ageSeconds < SipOrphanWatchdog.DISPATCH_GRACE_SECONDS) continue;

      let owner: string | null = null;
      try {
        owner = await this.redis.get(`call-owner:${room.name}`);
      } catch (err) {
        // Redis blip — skip THIS room, not the whole sweep.
        this.logger.debug(
          `owner lookup failed for ${room.name}: ${(err as Error).message}`,
        );
        continue;
      }
      if (owner) continue; // active call owned by a live pod — leave it
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
        // 404 = already gone (race with another orphan-sweeper or
        // LiveKit idle-timeout). Anything else log + move on so a
        // single failure doesn't block the sweep.
        const message = (err as Error).message ?? String(err);
        if (/not.?found|does not exist|404/i.test(message)) continue;
        reportError(this.logger, 'sip-orphan deleteRoom failed', err, {
          roomName: name,
        });
      }
    }
  }
}
