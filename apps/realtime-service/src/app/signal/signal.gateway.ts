import { Logger, OnModuleDestroy, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BaseWsExceptionFilter, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { JwtPayloadSchema } from '@mova-back/shared-auth';
import type { AppEnv } from '@mova-back/shared-config';
import { SIGNAL_NAMESPACE, type SignalEvent } from '@mova-back/shared-realtime';

import { PresenceService } from './presence.service';
import { SignalBridgeService } from './signal-bridge.service';

interface SignalSocketData {
  userId: string;
  unsubscribe: () => void;
  presenceTimer: NodeJS.Timeout;
}

const PRESENCE_REFRESH_MS = 30_000;

@WebSocketGateway({
  namespace: SIGNAL_NAMESPACE,
  cors: { origin: true },
  serveClient: false,
})
@UseFilters(BaseWsExceptionFilter)
export class SignalGateway implements OnModuleDestroy {
  private readonly logger = new Logger(SignalGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly presence: PresenceService,
    private readonly bridge: SignalBridgeService,
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
    const data = sockData(socket);
    await this.presence.markOnline(data.userId);

    data.unsubscribe = this.bridge.attach(data.userId, (event: SignalEvent) => {
      socket.emit('signal', event);
    });
    data.presenceTimer = setInterval(() => {
      void this.presence.refresh(data.userId);
    }, PRESENCE_REFRESH_MS);

    socket.on('ping', () => {
      void this.presence.refresh(data.userId);
      socket.emit('pong');
    });

    this.logger.log(`Signal connect user=${data.userId} sid=${socket.id}`);
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const data = socket.data as Partial<SignalSocketData> | undefined;
    if (data?.unsubscribe) data.unsubscribe();
    if (data?.presenceTimer) clearInterval(data.presenceTimer);
    if (data?.userId) {
      await this.presence.markOffline(data.userId).catch(() => undefined);
      this.logger.log(`Signal disconnect user=${data.userId} sid=${socket.id}`);
    }
  }

  onModuleDestroy(): void {
    if (this.server) this.server.disconnectSockets(true);
  }

  private async authenticate(socket: Socket): Promise<void> {
    const token = this.extractToken(socket);
    if (!token) throw new Error('Missing token');

    let payload: unknown;
    const currentSecret = this.config.get('JWT_SECRET', { infer: true });
    const previousSecret = this.config.get('JWT_SECRET_PREVIOUS', {
      infer: true,
    }) as string | undefined;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: currentSecret });
    } catch {
      if (!previousSecret) throw new Error('Invalid token');
      try {
        payload = await this.jwt.verifyAsync(token, { secret: previousSecret });
      } catch {
        throw new Error('Invalid token');
      }
    }
    const parsed = JwtPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid token payload');

    const data: SignalSocketData = {
      userId: parsed.data.sub,
      unsubscribe: () => undefined,
      presenceTimer: setTimeout(() => undefined, 1),
    };
    (socket as Socket & { data: SignalSocketData }).data = data;
  }

  private extractToken(socket: Socket): string | null {
    const handshake = socket.handshake;
    const header = handshake.headers['authorization'];
    const bearer =
      header && header.toLowerCase().startsWith('bearer ')
        ? header.slice(7)
        : null;
    return (
      (handshake.auth?.['token'] as string | undefined) ??
      (handshake.query['token'] as string | undefined) ??
      bearer ??
      null
    );
  }
}

function sockData(socket: Socket): SignalSocketData {
  return socket.data as SignalSocketData;
}
