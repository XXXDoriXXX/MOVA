import { Inject, Logger, OnModuleDestroy, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BaseWsExceptionFilter, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';

import { JwtPayloadSchema } from '@mova-back/shared-auth';
import type { AppEnv } from '@mova-back/shared-config';
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

/**
 * Per-socket state attached to `socket.data`. Socket.IO types `data` as a
 * generic — we cast at access sites via a small helper to keep TS happy
 * without polluting the global Socket type (which leaks into other gateways).
 */
interface SocketData {
  userId: string;
  conversationId: string;
  /** Cleans up the Redis-bridge subscription on disconnect. */
  unsubscribeBridge: () => void;
  /** Heartbeat watchdog — kills the socket if no `ping` for too long. */
  heartbeatTimer: NodeJS.Timeout;
  /** Replay cursor (XADD stream id) from handshake; null on first connect. */
  lastStreamId: string | null;
}

function sockData(socket: Socket): SocketData {
  return socket.data as SocketData;
}

const HEARTBEAT_GRACE_MS = 60_000; // close socket if no ping for 60s
const MAX_TEXT_LEN = 2_000; // mirrors ws-events Zod constraint

/**
 * The WS gateway. One Socket.IO connection per (user, conversation).
 *
 * Connect URL (Socket.IO):
 *   wss://realtime.mova.app/calls?conversationId=<uuid>&token=<jwt>
 *
 * Authentication: JWT signature + Conversation ownership are verified in the
 * `auth` middleware below. Failure rejects the handshake — client receives
 * connect_error and disconnects without ever entering the active state.
 *
 * Wire protocol (matches shared-realtime/ws-events.ts):
 *   Server → Client:  event name = "event", payload = ServerEvent JSON
 *   Client → Server:  event name = "command", payload = ClientCommand JSON
 *
 * Backpressure: Socket.IO ack timeouts handle this for us; we throttle
 * command processing at 10/sec per socket via the bucket counter below.
 *
 * Mobile UX notes:
 *   - Reconnect: client must re-handshake with a fresh `lastEventId` (Phase 5
 *     follow-up). Until then, brief disconnects lose partials but the next
 *     final event recovers state.
 *   - Pings: mobile sends `{type:"ping"}` every 20s. Server replies with
 *     `{type:"pong"}` and resets the heartbeat watchdog.
 */
@WebSocketGateway({
  namespace: '/calls',
  // CORS is overridden by main.ts; mobile clients connect from a custom
  // scheme so this is mainly for admin UI / Swagger-derived testers.
  cors: { origin: true },
  // Hold buffered events while a client briefly disconnects.
  serveClient: false,
})
@UseFilters(BaseWsExceptionFilter)
export class CallGateway implements OnModuleDestroy {
  private readonly logger = new Logger(CallGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Per-socket command-throttle bucket (token-bucket simplified). */
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
      // Socket.IO's `next` expects (err?). Wrap explicitly so we don't pass
      // the resolved void value as an "error".
      void this.authenticate(socket).then(
        () => next(),
        (err: unknown) => next(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  async handleConnection(socket: Socket): Promise<void> {
    // Increment first so the gauge is correct even if the rest of
    // handleConnection throws — handleDisconnect always runs and
    // decrements regardless of the failure path. Without this
    // ordering, a thrown error here would leave the gauge stuck high.
    this.wsConnections.inc();
    const data = sockData(socket);
    const { userId, conversationId, lastStreamId } = data;

    // Subscribe to live events FIRST — buffer them locally until replay is
    // finished, then flush in order. This closes the race window where an
    // event arrives between XRANGE completion and pub/sub attach.
    const liveBuffer: ServerEvent[] = [];
    let liveOpen = false;
    const unsubscribe = this.bridge.attach(conversationId, (event: ServerEvent) => {
      // mova_ws_messages_total{direction="outbound"}: bumped here at the
      // main hot-path (one per published event per subscribed socket).
      // We deliberately don't count buffered-then-flushed events twice;
      // the metric reflects "send attempts to a connected client",
      // which is what the dashboards care about.
      this.wsMessages.inc({ direction: 'outbound' });
      if (liveOpen) {
        socket.emit('event', event);
      } else {
        liveBuffer.push(event);
      }
    });

    const heartbeatTimer = this.startHeartbeat(socket);

    data.unsubscribeBridge = unsubscribe;
    data.heartbeatTimer = heartbeatTimer;

    this.logger.log(
      `WS connect user=${userId} conversation=${conversationId} sid=${socket.id}` +
        (lastStreamId ? ` lastStreamId=${lastStreamId}` : ''),
    );

    // Replay missed events on reconnect, BEFORE we emit the call.connected
    // greeting — keeps the client's view monotonic. Replay errors are
    // swallowed (we don't want a Redis blip to fail the WS connect).
    if (lastStreamId) {
      try {
        const replayed = await this.replay.replayMissed(conversationId, lastStreamId);
        for (const event of replayed) {
          socket.emit('event', event);
        }
        if (replayed.length > 0) {
          this.logger.log(
            `Replayed ${replayed.length} events to sid=${socket.id} from ${lastStreamId}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Replay failed for sid=${socket.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Flush any live events that arrived during replay, then open the firehose.
    for (const event of liveBuffer) {
      socket.emit('event', event);
    }
    liveBuffer.length = 0;
    liveOpen = true;

    // Greet — mobile UI can render "online" instantly without waiting for
    // agent join. Emitted AFTER replay so the client knows reconnect drained.
    socket.emit('event', {
      type: 'call.connected',
      id: socket.id, // good-enough unique within this socket
      timestamp: new Date().toISOString(),
      data: { conversationId },
    });
  }

  handleDisconnect(socket: Socket): void {
    // Always decrement, even if auth bounced this socket before
    // attaching the bridge — we incremented unconditionally in
    // handleConnection so we must decrement unconditionally here
    // to keep the gauge honest.
    this.wsConnections.dec();
    const data = socket.data as Partial<SocketData> | undefined;
    if (data?.unsubscribeBridge) {
      data.unsubscribeBridge();
    }
    if (data?.heartbeatTimer) {
      clearTimeout(data.heartbeatTimer);
    }
    this.commandRate.delete(socket.id);
    this.logger.log(
      `WS disconnect user=${data?.userId} conversation=${data?.conversationId} sid=${socket.id}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.server) {
      this.server.disconnectSockets(true);
    }
    this.commandRate.clear();
  }

  // ── Client → Server ────────────────────────────────

  /**
   * Single handler for all commands. The discriminated-union parser
   * validates shape; we then translate each kind to a Redis call-controls
   * publish for agent-worker to consume.
   */
  // We don't use @SubscribeMessage('command') because we want to apply
  // rate-limiting before dispatch, which is easier with raw .on().
  private bindCommandHandler(socket: Socket): void {
    socket.on('command', async (raw: unknown) => {
      // Count BEFORE rate-limit check so the metric reflects raw
      // client traffic (rate-limited attempts still cost CPU + are
      // a useful signal of misbehaving clients).
      this.wsMessages.inc({ direction: 'inbound' });
      try {
        if (!this.allowCommand(socket.id)) {
          socket.emit('event', this.buildRateLimitedEvent());
          return;
        }
        const cmd = parseClientCommand(raw);
        if (!cmd) {
          this.logger.warn(`Invalid command shape on sid=${socket.id}`);
          return;
        }
        await this.dispatchCommand(socket, cmd);
      } catch (err) {
        this.logger.error(
          `Command handler error on sid=${socket.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  private async dispatchCommand(socket: Socket, cmd: ClientCommand): Promise<void> {
    const { conversationId } = sockData(socket);
    const channel = RedisChannels.callControls(conversationId);

    switch (cmd.type) {
      case 'ping':
        // Reset heartbeat watchdog + reply.
        clearTimeout(sockData(socket).heartbeatTimer);
        sockData(socket).heartbeatTimer = this.startHeartbeat(socket);
        socket.emit('event', {
          type: 'pong',
          id: socket.id,
          timestamp: new Date().toISOString(),
        });
        return;

      case 'user.speak':
        if (cmd.data.text.length > MAX_TEXT_LEN) return; // defense in depth
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
        // We do NOT validate the styleId here — the gateway is in the hot
        // path and doesn't own the DB. agent-worker resolves it; an invalid
        // id falls through to the default with a warn log. The mobile UI
        // should only ever send IDs that GET /styles returned.
        await this.redis.publish(
          channel,
          JSON.stringify({
            action: CallControlAction.CHANGE_STYLE,
            styleId: cmd.data.styleId,
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

  // ── Auth handshake ─────────────────────────────────

  private async authenticate(socket: Socket): Promise<void> {
    const { token, conversationId, lastStreamId } = this.extractAuthFromSocket(socket);
    if (!token || !conversationId) {
      throw new Error('Missing token or conversationId');
    }

    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get('JWT_SECRET', { infer: true }),
      });
    } catch {
      throw new Error('Invalid token');
    }
    const parsed = JwtPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Invalid token payload');
    }

    // Ownership check against the Redis-side call context.
    await this.access.assertOwner(conversationId, parsed.data.sub);

    // Persist on the socket for later use in handlers + lifecycle.
    const data: SocketData = {
      userId: parsed.data.sub,
      conversationId,
      unsubscribeBridge: () => undefined,
      heartbeatTimer: setTimeout(() => undefined, 1),
      lastStreamId,
    };
    (socket as Socket & { data: SocketData }).data = data;
    // Wire the `command` event handler now that we know the socket is trusted.
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
    // Replay cursor: mobile client persists the last `ServerEvent.id` it saw
    // (which equals the Redis Stream entry id) and replays missed events on
    // reconnect. Absent on first connect.
    const rawCursor =
      (handshake.auth?.['lastStreamId'] as string | undefined) ??
      (handshake.query['lastStreamId'] as string | undefined) ??
      null;
    // Sanity-check shape: "<ms>-<seq>" with digits only. Reject anything else
    // to avoid passing junk into XRANGE (Redis would error and we'd swallow it,
    // but better to fail fast on bad client input).
    const lastStreamId =
      rawCursor && /^\d+-\d+$/.test(rawCursor) ? rawCursor : null;
    return { token, conversationId, lastStreamId };
  }

  private bearerFromHeader(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }

  // ── Heartbeat ─────────────────────────────────────

  /**
   * Closes the socket if no ping arrives within HEARTBEAT_GRACE_MS. Mobile
   * client sends `{type:"ping"}` every 20s; missing two intervals → drop.
   */
  private startHeartbeat(socket: Socket): NodeJS.Timeout {
    return setTimeout(() => {
      this.logger.warn(`Heartbeat timeout sid=${socket.id} — disconnecting`);
      socket.disconnect(true);
    }, HEARTBEAT_GRACE_MS);
  }

  // ── Rate limiting ─────────────────────────────────

  /** Allow ≤10 commands per second per socket. Excess is silently dropped. */
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
