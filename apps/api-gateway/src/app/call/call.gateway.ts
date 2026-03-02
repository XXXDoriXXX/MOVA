import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { Redis } from 'ioredis';

@WebSocketGateway({
  cors: { origin: '*' }, //in production, specify allowed origins for security
  namespace: '/call-stream',
})
@Injectable()
export class CallGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(CallGateway.name);
  private subscriber: Redis;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    this.subscriber = this.redis.duplicate();
  }

  async onModuleInit() {
    await this.subscriber.subscribe('call-events', 'call-interim-events');

    this.subscriber.on('message', (channel, message) => {
      try {
        const payload = JSON.parse(message);
        const { roomName, ...data } = payload;
        this.server.to(roomName).emit(channel, data);
      } catch (error) {
        this.logger.error(`❌ [Gateway] Payload parsing error: ${error.message}`);
      }
    });
  }

  async onModuleDestroy() {
    await this.subscriber.quit();
  }

  handleConnection(client: Socket) {
    this.logger.debug(`🟢 [Gateway] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`🔴 [Gateway] Client disconnected: ${client.id}`);
  }


  @SubscribeMessage('join-room')
  handleJoinRoom(@ConnectedSocket() client: Socket, @MessageBody() data: { roomName: string }) {
    client.join(data.roomName);
    this.logger.log(`🔗 [Gateway] Client ${client.id} joined room ${data.roomName}`);
    return { status: 'joined', room: data.roomName };
  }


  @SubscribeMessage('interrupt-and-speak')
  async handleInterrupt(@ConnectedSocket() client: Socket, @MessageBody() data: { roomName: string, text: string }) {
    this.logger.log(`⚠️ [Gateway] Interrupt command received for room ${data.roomName}`);

    await this.redis.publish('call-controls', JSON.stringify({
      roomName: data.roomName,
      action: 'interrupt_and_speak',
      text: data.text,
      timestamp: new Date().toISOString()
    }));
  }
}
