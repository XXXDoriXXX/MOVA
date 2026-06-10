import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

import type { AppEnv } from '@mova-back/shared-config';

interface ParticipantTokenInput {
  roomName: string;
  identity: string;
  name: string;
  canPublish: boolean;
  canSubscribe: boolean;
}

@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly wsUrl: string;
  private readonly roomService: RoomServiceClient;

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    this.apiKey = this.config.get('LIVEKIT_API_KEY', { infer: true });
    this.apiSecret = this.config.get('LIVEKIT_API_SECRET', { infer: true });
    this.wsUrl = this.config.get('LIVEKIT_URL', { infer: true });
    const httpUrl = this.wsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');
    this.roomService = new RoomServiceClient(httpUrl, this.apiKey, this.apiSecret);
  }

  get url(): string {
    return this.wsUrl;
  }

  async createParticipantToken(input: ParticipantTokenInput): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: input.identity,
      name: input.name,
    });
    at.addGrant({
      roomJoin: true,
      room: input.roomName,
      canPublish: input.canPublish,
      canSubscribe: input.canSubscribe,
    });
    return at.toJwt();
  }

  async deleteRoom(roomName: string): Promise<void> {
    try {
      await this.roomService.deleteRoom(roomName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not.?found|does not exist|404/i.test(message)) return;
      this.logger.warn(`deleteRoom ${roomName} failed: ${message}`);
    }
  }
}
