import { Inject, Logger, OnModuleDestroy, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BaseWsExceptionFilter, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';

import { JwtPayloadSchema } from '@mova-back/shared-auth';
import { CallLogger, type AppEnv } from '@mova-back/shared-config';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  CallControlAction,
  RedisChannels,
  parseClientCommand,
  type ClientCommand,
  type ServerEvent,
} from '@mova-back/shared-realtime';

import { ConversationAccessService } from './conversation-access.service';
import { RealtimeBridgeService } from './realtime-bridge.service';
import { ReplayService } from './replay.service';
import { makeStreamDeduper } from './stream-dedupe';

interface SocketData {
  userId: string;
  conversationId: string;
  unsubscribeBridge: () => void;
  heartbeatTimer: NodeJS.Timeout;
  lastStreamId: string | null;
}

function sockData(socket: Socket): SocketData {
  return socket.data as SocketData;
}


function sockLog(logger: Logger, socket: Socket): CallLogger {
  const data = socket.data as Partial<SocketData> | undefined;
  return new CallLogger(logger, {
    conversationId: data?.conversationId,
    userId: data?.userId,
    socketId: socket.id,
  });
}

const HEARTBEAT_GRACE_MS = 60_000;
const MAX_TEXT_LEN = 2_000;

@WebSocketGateway({
  namespace: '/calls',
  cors: { origin: true },
  serveClient: false,
})
@UseFilters(BaseWsExceptionFilter)
export class CallGateway implements OnModuleDestroy {
  private readonly logger = new Logger(CallGateway.name);

  @WebSocketServer()
  server!: Server;

  private readonly commandRate = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly access: ConversationAccessService,
    private readonly bridge: RealtimeBridgeService,
    private readonly replay: ReplayService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectMetric('mova_ws_connections')
    private readonly wsConnections: Gauge<string>,
    @InjectMetric('mova_ws_messages_total')
    private readonly wsMessages: Counter<string>,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
        (err: unknown) => next(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  async handleConnection(socket: Socket): Promise<void> {
    this.wsConnections.inc();
    const data = sockData(socket);
    const { userId, conversationId, lastStreamId } = data;

    // Monotonic de-dup: replay (from lastStreamId) and the live bridge buffer
    // overlap, so an event can be both replayed AND buffered live. Track the
    // highest stream id already emitted and drop any event at or below it, so a
    // reconnect never delivers duplicate transcript / AI / suggestion bubbles.
    const shouldEmit = makeStreamDeduper();
    const emitEvent = (event: ServerEvent): void => {
      if (shouldEmit(event.id)) socket.emit('event', event);
    };

    const liveBuffer: ServerEvent[] = [];
    let liveOpen = false;
    const unsubscribe = this.bridge.attach(conversationId, (event: ServerEvent) => {
      this.wsMessages.inc({ direction: 'outbound' });
      this.logger.debug({
        msg: 'ws.event.out',
        evt: 'ws.event.out',
        conversationId,
        userId,
        socketId: socket.id,
        type: event.type,
        buffered: !liveOpen,
      });
      if (liveOpen) {
        emitEvent(event);
      } else {
        liveBuffer.push(event);
      }
    });

    const heartbeatTimer = this.startHeartbeat(socket);

    data.unsubscribeBridge = unsubscribe;
    data.heartbeatTimer = heartbeatTimer;

    const clog = new CallLogger(this.logger, {
      conversationId,
      userId,
      socketId: socket.id,
    });
    clog.event('ws.connect', { reconnect: Boolean(lastStreamId), lastStreamId });

    if (lastStreamId) {
      try {
        const replayed = await this.replay.replayMissed(conversationId, lastStreamId);
        for (const event of replayed) {
          emitEvent(event);
        }
        if (replayed.length > 0) {
          clog.event('ws.replay', { events: replayed.length, fromStreamId: lastStreamId });
        }
      } catch (err) {
        clog.error('ws.replay.failed', err, { fromStreamId: lastStreamId });
      }
    }

    for (const event of liveBuffer) {
      emitEvent(event);
    }
    liveBuffer.length = 0;
    liveOpen = true;

    socket.emit('event', {
      type: 'call.connected',
      id: socket.id,
      timestamp: new Date().toISOString(),
      data: { conversationId },
    });
    clog.event('ws.ready');
  }

  handleDisconnect(socket: Socket): void {
    this.wsConnections.dec();
    const data = socket.data as Partial<SocketData> | undefined;
    if (data?.unsubscribeBridge) {
      data.unsubscribeBridge();
    }
    if (data?.heartbeatTimer) {
      clearTimeout(data.heartbeatTimer);
    }
    this.commandRate.delete(socket.id);
    sockLog(this.logger, socket).event('ws.disconnect');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.server) {
      this.server.disconnectSockets(true);
    }
    this.commandRate.clear();
  }

  private bindCommandHandler(socket: Socket): void {
    socket.on('command', async (raw: unknown) => {
      this.wsMessages.inc({ direction: 'inbound' });
      try {
        if (!this.allowCommand(socket.id)) {
          sockLog(this.logger, socket).warn('ws.command.rateLimited');
          socket.emit('event', this.buildRateLimitedEvent());
          return;
        }
        const cmd = parseClientCommand(raw);
        if (!cmd) {
          sockLog(this.logger, socket).warn('ws.command.invalidShape');
          return;
        }
        sockLog(this.logger, socket).event('ws.command', { command: cmd.type });
        await this.dispatchCommand(socket, cmd);
      } catch (err) {
        sockLog(this.logger, socket).error('ws.command.handlerError', err);
      }
    });
  }

  private async dispatchCommand(socket: Socket, cmd: ClientCommand): Promise<void> {
    const { conversationId } = sockData(socket);
    const channel = RedisChannels.callControls(conversationId);

    switch (cmd.type) {
      case 'ping':
        clearTimeout(sockData(socket).heartbeatTimer);
        sockData(socket).heartbeatTimer = this.startHeartbeat(socket);
        socket.emit('event', {
          type: 'pong',
          id: socket.id,
          timestamp: new Date().toISOString(),
        });
        return;

      case 'user.speak':
        if (cmd.data.text.length > MAX_TEXT_LEN) return;
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.SPEAK,
            text: cmd.data.text,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.accept_suggestion':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.ACCEPT_SUGGESTION,
            suggestionId: cmd.data.suggestionId,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.stop_tts':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.STOP_TTS,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.change_voice':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.CHANGE_VOICE,
            voice: cmd.data.voice,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.change_model':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.CHANGE_MODEL,
            providerType: cmd.data.providerType,
            provider: cmd.data.provider,
            model: cmd.data.model,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.change_style':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.CHANGE_STYLE,
            styleId: cmd.data.styleId,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.accept_ai_reply':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.ACCEPT_AI_REPLY,
            candidateId: cmd.data.candidateId,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.cancel_ai_reply':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.CANCEL_AI_REPLY,
            candidateId: cmd.data.candidateId,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.set_auto_mode':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.SET_AUTO_MODE,
            enabled: cmd.data.enabled,
            initiatedBy: sockData(socket).userId,
          }),
        );
        return;

      case 'user.end_call':
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.END,
            initiatedBy: sockData(socket).userId,
            reason: 'user',
          }),
        );
        return;
    }
  }

  private async authenticate(socket: Socket): Promise<void> {
    const { token, conversationId, lastStreamId } = this.extractAuthFromSocket(socket);
    if (!token || !conversationId) {
      throw new Error('Missing token or conversationId');
    }

    let payload: unknown;
    const currentSecret = this.config.get('JWT_SECRET', { infer: true });
    const previousSecret = this.config.get('JWT_SECRET_PREVIOUS', {
      infer: true,
    }) as string | undefined;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: currentSecret });
    } catch (currentErr) {
      if (previousSecret) {
        try {
          payload = await this.jwt.verifyAsync(token, { secret: previousSecret });
        } catch {
          throw new Error('Invalid token');
        }
      } else {
        throw new Error('Invalid token');
      }
    }
    const parsed = JwtPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Invalid token payload');
    }

    try {
      await this.access.assertOwner(conversationId, parsed.data.sub);
    } catch (err) {
      this.logger.warn({
        msg: 'ws.auth.ownershipDenied',
        evt: 'ws.auth.ownershipDenied',
        conversationId,
        userId: parsed.data.sub,
        socketId: socket.id,
      });
      throw err;
    }

    const data: SocketData = {
      userId: parsed.data.sub,
      conversationId,
      unsubscribeBridge: () => undefined,
      heartbeatTimer: setTimeout(() => undefined, 1),
      lastStreamId,
    };
    (socket as Socket & { data: SocketData }).data = data;
    this.bindCommandHandler(socket);
  }

  private extractAuthFromSocket(socket: Socket): {
    token: string | null;
    conversationId: string | null;
    lastStreamId: string | null;
  } {
    const handshake = socket.handshake;
    const token =
      (handshake.auth?.['token'] as string | undefined) ??
      (handshake.query['token'] as string | undefined) ??
      this.bearerFromHeader(handshake.headers['authorization']) ??
      null;
    const conversationId =
      (handshake.auth?.['conversationId'] as string | undefined) ??
      (handshake.query['conversationId'] as string | undefined) ??
      null;
    const rawCursor =
      (handshake.auth?.['lastStreamId'] as string | undefined) ??
      (handshake.query['lastStreamId'] as string | undefined) ??
      null;
    const lastStreamId =
      rawCursor && /^\d+-\d+$/.test(rawCursor) ? rawCursor : null;
    return { token, conversationId, lastStreamId };
  }

  private bearerFromHeader(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }

  private startHeartbeat(socket: Socket): NodeJS.Timeout {
    return setTimeout(() => {
      sockLog(this.logger, socket).warn('ws.heartbeat.timeout', {
        graceMs: HEARTBEAT_GRACE_MS,
      });
      socket.disconnect(true);
    }, HEARTBEAT_GRACE_MS);
  }

  private allowCommand(socketId: string): boolean {
    const now = Date.now();
    const bucket = this.commandRate.get(socketId);
    if (!bucket || bucket.resetAt < now) {
      this.commandRate.set(socketId, { count: 1, resetAt: now + 1_000 });
      return true;
    }
    if (bucket.count >= 10) return false;
    bucket.count += 1;
    return true;
  }

  private buildRateLimitedEvent(): ServerEvent {
    return {
      type: 'call.error',
      id: `rl-${Date.now()}`,
      timestamp: new Date().toISOString(),
      data: {
        code: 'RATE_LIMITED' as never,
        message: 'Забагато запитів. Зачекайте кілька секунд.',
        recoverable: true,
      },
    };
  }
}
