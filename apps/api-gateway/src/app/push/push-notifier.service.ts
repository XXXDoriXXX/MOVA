import { Injectable, Logger } from '@nestjs/common';

import { PushToken, PushTokenKind } from '@mova-back/shared-database';

export interface IncomingCallPush {
  conversationId: string;
  roomName: string;
  callerId: string;
  callerName: string;
}

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

@Injectable()
export class PushNotifierService {
  private readonly logger = new Logger(PushNotifierService.name);

  async sendIncomingCall(
    tokens: PushToken[],
    payload: IncomingCallPush,
  ): Promise<void> {
    if (tokens.length === 0) return;
    const voip = tokens.filter((t) => t.kind === PushTokenKind.VOIP);
    const data = tokens.filter((t) => t.kind === PushTokenKind.DATA);

    await Promise.all([
      this.sendExpo(data, payload),
      this.sendVoip(voip, payload),
    ]);
  }

  private async sendExpo(
    tokens: PushToken[],
    payload: IncomingCallPush,
  ): Promise<void> {
    if (tokens.length === 0) return;
    const messages = tokens.map((t) => ({
      to: t.token,
      title: 'Вхідний дзвінок',
      body: `${payload.callerName} телефонує`,
      sound: 'default',
      priority: 'high',
      channelId: 'incoming-calls',
      data: { type: 'incoming_call', ...payload },
    }));
    try {
      const res = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        this.logger.warn(`Expo push failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      this.logger.warn(
        `Expo push error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async sendVoip(
    tokens: PushToken[],
    payload: IncomingCallPush,
  ): Promise<void> {
    if (tokens.length === 0) return;
    const endpoint = process.env['VOIP_PUSH_ENDPOINT'];
    if (!endpoint) {
      this.logger.warn(
        `VOIP_PUSH_ENDPOINT not configured — skipping ${tokens.length} VoIP push(es) for conversation ${payload.conversationId}`,
      );
      return;
    }
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env['VOIP_PUSH_TOKEN']
            ? { authorization: `Bearer ${process.env['VOIP_PUSH_TOKEN']}` }
            : {}),
        },
        body: JSON.stringify({
          tokens: tokens.map((t) => t.token),
          payload: { type: 'incoming_call', ...payload },
        }),
      });
    } catch (err) {
      this.logger.warn(
        `VoIP push error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
