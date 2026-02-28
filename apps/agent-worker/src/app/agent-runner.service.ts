
import { Injectable, OnApplicationBootstrap,OnApplicationShutdown, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import * as silero from '@livekit/agents-plugin-silero';
import { initializeLogger } from '@livekit/agents';
import { AgentFactory, AgentContext } from './agent/agent.factory';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { Redis } from 'ioredis';

@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentRunnerService.name);
  private vadModel: silero.VAD;
  private subscriber: Redis;

  private activeRooms = new Map<string, Room>();

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
   initializeLogger({ level: 'info', pretty: false });

      this.logger.debug('🧠 [VAD] Pre-warming Silero VAD model...');
      const vadStartTime = Date.now();

      // Memory management: singleton instance is maintained here
      this.vadModel = await silero.VAD.load();

      this.logger.log(`✅ [VAD] Silero VAD loaded into memory in ${Date.now() - vadStartTime}ms`);

      this.logger.debug('📡 [Redis] Subscribing to "call-dispatch" channel...');
      this.subscriber.subscribe('call-dispatch', (err) => {
        if (err) {
          this.logger.error(`❌ [Redis] Failed to subscribe to call-dispatch: ${err.message}`, err.stack);
        } else {
          this.logger.log('🎧 [Redis] Successfully subscribed. Listening for new calls from API Gateway...');
        }
      });

      this.subscriber.on('message', async (channel, message) => {
        if (channel === 'call-dispatch') {
          this.logger.debug(`📥 [Redis] Received message on channel "${channel}": ${message}`);

          try {
            const payload = JSON.parse(message);
            if (payload.roomName) {
              this.logger.log(`⚡ [Event] Triggering direct call handler for room: ${payload.roomName}`);

              // Non-blocking execution
              this.handleDirectCall(payload.roomName).catch(err =>
                this.logger.error(`🚨 [Fatal] Unhandled error in call loop for room ${payload.roomName}`, err.stack)
              );
            } else {
              this.logger.warn(`⚠️ [Payload] Received payload without roomName: ${message}`);
            }
          } catch (parseError) {
            this.logger.error(`❌ [Payload] Failed to parse Redis message: ${message}`, parseError.stack);
          }
        }
      });

    } catch (bootstrapError) {
      this.logger.error(`🚨 [Bootstrap] Critical failure during initialization`, bootstrapError.stack);
    }
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`🛑 [Shutdown] Received OS signal: ${signal}. Initiating Graceful Shutdown sequence...`);

    if (this.subscriber) {
      await this.subscriber.unsubscribe('call-dispatch');
      this.logger.log('🛑 [Shutdown] Unsubscribed from Redis. Stopped accepting new calls.');
    }
    //close all active rooms
    if (this.activeRooms.size > 0) {
      this.logger.log(`⏳ [Shutdown] Draining ${this.activeRooms.size} active WebRTC connections...`);

      const disconnectPromises = Array.from(this.activeRooms.values()).map(room => room.disconnect());
      await Promise.all(disconnectPromises);

      this.activeRooms.clear();
      this.logger.log('✅ [Shutdown] All active rooms safely disconnected.');
    }

    //clsoe redis connections
    if (this.subscriber) {
      this.subscriber.quit();
      this.logger.log('✅ [Shutdown] Redis connections closed.');
    }

    this.logger.log('👋 [Shutdown] Graceful Shutdown complete. Process will exit safely.');
  }

  private async handleDirectCall(roomName: string) {
    const callStartTime = Date.now();
    this.logger.log(`📞 [Call Lifecycle] Initiating connection sequence for room: ${roomName}`);

    try {
      const redisKey = `call:${roomName}:context`;
      this.logger.debug(`🔍 [Context] Fetching user context from Redis key: ${redisKey}`);
      const contextRaw = await this.redis.get(redisKey);

      if (!contextRaw) {
        this.logger.warn(`🛑 [Context] Missing context for room ${roomName}. Aborting connection.`);
        return;
      }

      this.logger.debug(`✅ [Context] Successfully retrieved raw context: ${contextRaw}`);
      const userContext: AgentContext = JSON.parse(contextRaw);

      // Token Generation
      this.logger.debug('🔐 [Auth] Generating LiveKit Access Token...');
      const apiKey = this.config.getOrThrow<string>('LIVEKIT_API_KEY');
      const apiSecret = this.config.getOrThrow<string>('LIVEKIT_API_SECRET');
      const wsURL = this.config.getOrThrow<string>('LIVEKIT_URL');

      const at = new AccessToken(apiKey, apiSecret, {
        identity: `agent-${roomName}`,
        name: userContext.userName,
      });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();
      this.logger.debug('✅ [Auth] Token generated successfully');

      // Room Connection
      this.logger.debug(`🌐 [WebRTC] Connecting to LiveKit server at ${wsURL}...`);
      const room = new Room();

      this.activeRooms.set(roomName, room);

      const connectStartTime = Date.now();
      await room.connect(wsURL, token);
      this.logger.log(`✅ [WebRTC] Agent joined room "${roomName}" in ${Date.now() - connectStartTime}ms`);

      // Agent Initialization
      this.logger.debug('🤖 [Agent] Creating agent session and AI pipeline...');
      const session = await this.agentFactory.createSession(this.vadModel);
      const agent = this.agentFactory.createAgent(userContext);

      this.logger.debug('🔗 [Events] Binding SDK events with Type Assertion...');

      const sessionEmitter = session as any;

      const publishFinalEvent = (sender: string, text: string) => {
        this.logger.debug(`📤 [Event] Publishing final speech by ${sender}: "${text.substring(0, 30)}..."`);
        this.redis.publish('call-events', JSON.stringify({ roomName, sender, text, timestamp: new Date(), isFinal: true }))
          .catch(err => this.logger.error(`❌ [Event] Failed to publish event: ${err.message}`));
      };

      const publishInterimEvent = (sender: string, text: string) => {
        this.redis.publish('call-interim-events', JSON.stringify({ roomName, sender, text, isFinal: false }))
          .catch(err => this.logger.error(`❌ [Interim Event] Failed: ${err.message}`));
      };

      sessionEmitter.on('user_input_transcribed', (ev: any) => {
        const text = ev.text || ev.transcript || '';
        if (!text) return;

        if (ev.isFinal) {
          publishFinalEvent('user', text);
        } else {
          publishInterimEvent('user', text);
        }
      });

      sessionEmitter.on('conversation_item_added', (ev: any) => {
        const item = ev?.item;
        if (!item || item.role !== 'assistant') return;

        let text = '';
        if (typeof item.content === 'string') {
          text = item.content;
        } else if (Array.isArray(item.content) && item.content.length > 0) {
          text = item.content[0]?.text || '';
        }

        if (text) publishFinalEvent('agent', text);
      });
      const controlSubscriber = this.redis.duplicate();
      controlSubscriber.subscribe('call-controls');

      controlSubscriber.on('message', async (channel, message) => {
        const payload = JSON.parse(message);

        if (payload.roomName === roomName && payload.action === 'interrupt_and_speak') {
          this.logger.log(`🛑 [Agent Control] Interrupting AI in room ${roomName}.`);

          try {
            session.interrupt();
            await session.say(payload.text, {
              allowInterruptions: false,
              addToChatCtx: true
            });
            publishFinalEvent('user_manual', payload.text);
          } catch (err) {
            this.logger.error(`❌ [Agent Control] Override failed: ${err.message}`);
          }
        }
      });
      sessionEmitter.on('error', (err: any) => {

        const innerError = err?.error || err;

        if (innerError?.name === 'APIUserAbortError' || innerError?.message?.includes('aborted')) {
          this.logger.debug('⚠️ [AgentSession] TTS request gracefully aborted due to user interruption.');
          return;
        }
        this.logger.error(`❌ [AgentSession] Unhandled SDK Exception: ${innerError?.message || 'Unknown'}`, innerError?.stack);
      });

      room.on(RoomEvent.Disconnected, async () => {
        this.activeRooms.delete(roomName);

        try {
          await session.close();
          this.logger.debug(`🧹 [Memory] AgentSession successfully closed and resources deallocated.`);
        } catch (err) {
          this.logger.error(`❌ [Memory] Failed to close AgentSession: ${err.message}`);
        }

        controlSubscriber.quit().catch(err =>
          this.logger.error(`❌ [Redis] Failed to quit subscriber`, err)
        );

        const duration = Date.now() - callStartTime;
        this.logger.log(`🚪 [Call Lifecycle] Room "${roomName}" disconnected. Call duration: ${duration}ms.`);
      });

      this.logger.debug('▶️ [Agent] Starting session pipeline...');
      session.start({ room, agent });

      this.logger.debug('🗣 [Agent] Initiating greeting...');
      await session.say(this.agentFactory.getInitialGreeting(userContext), {
        allowInterruptions: false,
      });

      this.logger.log(`🎉 [Call Lifecycle] Connection sequence completed for room ${roomName} in ${Date.now() - callStartTime}ms`);

    } catch (error: any) {
      this.logger.error(`❌ [Call Lifecycle] Fatal error in room ${roomName}: ${error.message}`, error.stack);
    }
  }
}
