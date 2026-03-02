import { Injectable, OnApplicationBootstrap, OnApplicationShutdown, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as silero from '@livekit/agents-plugin-silero';
import { initializeLogger } from '@livekit/agents';
import { AgentFactory, AgentContext } from './agent/agent.factory';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { Redis } from 'ioredis';
import { AgentCallHandler } from './agent-call.handler';

@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentRunnerService.name);
  private vadModel: silero.VAD;
  private subscriber: Redis;

  private activeSessions = new Map<string, AgentCallHandler>();

  constructor(
    private readonly config: ConfigService,
    private readonly agentFactory: AgentFactory,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.logger.debug('🛠 [Init] Duplicating Redis client for SUB connection...');
    this.subscriber = this.redis.duplicate();
  }

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') {
      this.logger.warn('⚠️ [Bootstrap] Test environment detected. Skipping worker initialization.');
      return;
    }

    this.logger.log('🚀 [Bootstrap] Starting Embedded LiveKit Worker initialization process...');

    try {
      this.logger.debug('🛠 [Init] Initializing LiveKit internal logger...');
      initializeLogger({ level: 'debug', pretty: true });

      this.logger.debug('🧠 [VAD] Pre-warming Silero VAD model...');
      const vadStartTime = Date.now();

      // Memory management: singleton instance is maintained here
      this.vadModel = await silero.VAD.load();

      this.logger.log(`✅ [VAD] Silero VAD loaded into memory in ${Date.now() - vadStartTime}ms`);

      this.logger.debug('📡 [Redis] Subscribing to "call-dispatch" and "call-controls" channels...');
      this.subscriber.subscribe('call-dispatch', 'call-controls', (err) => {
        if (err) {
          this.logger.error(`❌ [Redis] Failed to subscribe to channels: ${err.message}`, err.stack);
        } else {
          this.logger.log('🎧 [Redis] Successfully subscribed. Listening for new calls and controls from API Gateway...');
        }
      });

      this.subscriber.on('message', async (channel, message) => {
        try {
          const payload = JSON.parse(message);

          if (channel === 'call-dispatch') {
            this.handleCallDispatch(payload);
          } else if (channel === 'call-controls') {
            this.handleCallControls(payload);
          }
        } catch (parseError) {
          const err = parseError as Error;
          this.logger.error(`❌ [Payload] Failed to parse Redis message on ${channel}: ${message}`, err.stack);
        }
      });

    } catch (bootstrapError) {
      const err = bootstrapError as Error;
      this.logger.error(`🚨 [Bootstrap] Critical failure during initialization`, err.stack);
    }
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`🛑 [Shutdown] Received OS signal: ${signal}. Initiating Graceful Shutdown sequence...`);

    if (this.subscriber) {
      await this.subscriber.unsubscribe('call-dispatch', 'call-controls');
      this.logger.log('🛑 [Shutdown] Unsubscribed from Redis. Stopped accepting new events.');
    }

    // Close all active sessions
    if (this.activeSessions.size > 0) {
      this.logger.log(`⏳ [Shutdown] Draining ${this.activeSessions.size} active sessions...`);

      const disconnectPromises = Array.from(this.activeSessions.values()).map(handler => handler.stop());
      await Promise.all(disconnectPromises);

      this.activeSessions.clear();
      this.logger.log('✅ [Shutdown] All active sessions safely stopped.');
    }

    // Close redis connections
    if (this.subscriber) {
      this.subscriber.quit();
      this.logger.log('✅ [Shutdown] Redis connections closed.');
    }

    this.logger.log('👋 [Shutdown] Graceful Shutdown complete. Process will exit safely.');
  }

  private async handleCallDispatch(payload: Record<string, any>) {
    const roomName = payload.roomName as string | undefined;
    if (!roomName) {
      this.logger.warn(`⚠️ [Payload] Received dispatch payload without roomName`);
      return;
    }

    if (this.activeSessions.has(roomName)) {
      this.logger.warn(`⚠️ [Concurrency] Session for room "${roomName}" is already active or connecting. Ignoring duplicate dispatch event.`);
      return;
    }

    this.logger.log(`⚡ [Event] Triggering direct call handler for room: ${roomName}`);

    // Non-blocking execution
    this.initiateCall(roomName).catch((err: Error) =>
      this.logger.error(`🚨 [Fatal] Unhandled error in call loop for room ${roomName}`, err.stack)
    );
  }

  private handleCallControls(payload: Record<string, any>) {
    const roomName = payload.roomName as string | undefined;
    if (!roomName) {
      this.logger.warn(`⚠️ [Payload] Received control payload without roomName`);
      return;
    }

    const handler = this.activeSessions.get(roomName);
    if (!handler) {
      this.logger.debug(`ℹ️ [Control] Received control for room ${roomName}, but no active session found locally. (Maybe on another node)`);
      return;
    }

    if (payload.action === 'interrupt_and_speak') {
      handler.interruptAndSpeak(payload.text).catch((err: Error) =>
        this.logger.error(`❌ [Control] Interrupt failed for ${roomName}`, err.stack)
      );
    }
  }

  private async initiateCall(roomName: string) {
    try {
      const redisKey = `call:${roomName}:context`;
      this.logger.debug(`🔍 [Context] Fetching user context from Redis key: ${redisKey}`);
      const contextRaw = await this.redis.get(redisKey);

      if (!contextRaw) {
        this.logger.warn(`🛑 [Context] Missing context for room ${roomName}. Aborting connection.`);
        return;
      }

      this.logger.debug(`✅ [Context] Successfully retrieved raw context for ${roomName}`);
      const userContext: AgentContext = JSON.parse(contextRaw) as AgentContext;

      const handler = new AgentCallHandler(
        roomName,
        userContext,
        this.config,
        this.agentFactory,
        this.vadModel,
        this.redis,
        (closedRoomName: string) => {
          this.activeSessions.delete(closedRoomName);
        }
      );

      // Lock the room
      this.activeSessions.set(roomName, handler);

      // Await start sequence
      await handler.start();

    } catch (error) {
      const err = error as Error;
      this.logger.error(`❌ [Call Lifecycle] Fatal error initiating call for room ${roomName}: ${err.message}`, err.stack);
      this.activeSessions.delete(roomName);
    }
  }
}
