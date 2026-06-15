import { Injectable, Logger } from '@nestjs/common';

import { PushToken, PushTokenKind } from '@mova-back/shared-database';

import { PushTokenService } from './push-token.service';

interface ExpoTicket {
  status?: string;
  details?: { error?: string };
}

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

  constructor(private readonly pushTokens: PushTokenService) {}

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
    let res: Response;
    try {
      res = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(messages),
      });
    } catch (err) {
      this.logger.warn({
        msg: 'push.expo.requestError',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!res.ok) {
      this.logger.warn({
        msg: 'push.expo.httpError',
        status: res.status,
        body: await res.text().catch(() => ''),
      });
      return;
    }
    // Expo returns HTTP 200 even when individual messages fail. Parse the
    // per-ticket receipts: a DeviceNotRegistered / InvalidCredentials ticket
    // means the device's token is dead — delete it so it stops absorbing every
    // future incoming-call push (and stops inflating the reachability check).
    let parsed: { data?: ExpoTicket[] };
    try {
      parsed = (await res.json()) as { data?: ExpoTicket[] };
    } catch {
      return;
    }
    const tickets = parsed.data ?? [];
    const dead: PushToken[] = [];
    tickets.forEach((ticket, i) => {
      if (ticket?.status !== 'error') return;
      const code = ticket.details?.error;
      const tok = tokens[i];
      this.logger.warn({ msg: 'push.expo.ticketError', error: code ?? null });
      if (tok && (code === 'DeviceNotRegistered' || code === 'InvalidCredentials')) {
        dead.push(tok);
      }
    });
    if (dead.length === 0) return;
    await Promise.all(
      dead.map((t) =>
        this.pushTokens.remove(t.userId, t.token).catch((err) =>
          this.logger.warn({
            msg: 'push.expo.pruneFailed',
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
    this.logger.warn({ msg: 'push.expo.prunedDeadTokens', count: dead.length });
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
