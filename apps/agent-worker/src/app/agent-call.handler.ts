import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { AgentFactory, AgentContext } from './agent/agent.factory';
import { Redis } from 'ioredis';
import * as silero from '@livekit/agents-plugin-silero';
import { voice } from '@livekit/agents';
import { EventEmitter } from 'events';

export class AgentCallHandler {
  private readonly logger: Logger;
  private room: Room | null = null;
  private session: voice.AgentSession | null = null;

  constructor(
    private readonly roomName: string,
    private readonly userContext: AgentContext,
    private readonly config: ConfigService,
    private readonly agentFactory: AgentFactory,
    private readonly vadModel: silero.VAD,
    private readonly redis: Redis,
    private readonly onDisconnectCb: (roomName: string) => void,
  ) {
    this.logger = new Logger(`Call-${roomName}`);
  }

  async start() {
    const callStartTime = Date.now();
    this.logger.log(`📞 [Call Lifecycle] Initiating connection sequence...`);

    try {
      // 1. Token Generation
      this.logger.debug('🔐 [Auth] Generating LiveKit Access Token...');
      const apiKey = this.config.getOrThrow<string>('LIVEKIT_API_KEY');
      const apiSecret = this.config.getOrThrow<string>('LIVEKIT_API_SECRET');
      const wsURL = this.config.getOrThrow<string>('LIVEKIT_URL');

      const at = new AccessToken(apiKey, apiSecret, {
        identity: `agent-${this.roomName}`,
        name: this.userContext.userName,
      });
      at.addGrant({ roomJoin: true, room: this.roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();
      this.logger.debug('✅ [Auth] Token generated successfully');

      // 2. Room Connection
      this.logger.debug(`🌐 [WebRTC] Connecting to LiveKit server at ${wsURL}...`);
      this.room = new Room();

      // Listen for disconnects to clean up our side
      this.room.on(RoomEvent.Disconnected, async () => {
        const duration = Date.now() - callStartTime;
        this.logger.log(`🚪 [Call Lifecycle] Room disconnected. Call duration: ${duration}ms.`);
        this.cleanup();
      });

      const connectStartTime = Date.now();
      await this.room.connect(wsURL, token);
      this.logger.log(`✅ [WebRTC] Agent joined room in ${Date.now() - connectStartTime}ms`);

      // 3. Agent Initialization
      this.logger.debug('🤖 [Agent] Creating agent session and AI pipeline...');
      this.session = await this.agentFactory.createSession(this.vadModel);
      const agent = this.agentFactory.createAgent(this.userContext);

      this.bindSessionEvents(this.session, this.roomName, callStartTime);

      this.logger.debug('▶️ [Agent] Starting session pipeline...');
      this.session.start({ room: this.room, agent });

      this.logger.debug('🗣 [Agent] Initiating greeting...');
      await this.session.say(this.agentFactory.getInitialGreeting(this.userContext), {
        allowInterruptions: false,
      });

      this.logger.log(`🎉 [Call Lifecycle] Connection sequence completed in ${Date.now() - callStartTime}ms`);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`❌ [Call Lifecycle] Fatal error during call setup: ${err.message}`, err.stack);
      this.cleanup(); // Guarantee cleanup if setup fails
    }
  }

  public async interruptAndSpeak(text: string) {
    if (!this.session) {
      this.logger.warn(`🛑 [Agent Control] Cannot interrupt, session not initialized.`);
      return;
    }

    this.logger.log(`🛑 [Agent Control] Interrupting AI.`);
    try {
      this.session.interrupt();
      await this.session.say(text, {
        allowInterruptions: false,
        addToChatCtx: true,
      });
      this.publishFinalEvent('user_manual', text);
    } catch (err) {
      this.logger.error(`❌ [Agent Control] Override failed: ${(err as Error).message}`);
    }
  }

  public async stop() {
    this.logger.log(`🛑 [Call Lifecycle] Force stopping call handler...`);
    this.cleanup();
  }

  private cleanup() {
    if (this.session) {
      try {
        this.session.close();
        this.logger.debug(`🧹 [Memory] AgentSession closed.`);
      } catch (err) {
        this.logger.error(`❌ [Memory] Failed to close AgentSession: ${(err as Error).message}`);
      }
      this.session = null;
    }

    if (this.room) {
      try {
        this.room.disconnect();
        this.logger.debug(`🧹 [Memory] Room disconnected.`);
      } catch (err) {
        this.logger.error(`❌ [Memory] Failed to disconnect room: ${(err as Error).message}`);
      }
      this.room = null;
    }

    // Notify runner to remove from map
    this.onDisconnectCb(this.roomName);
  }

  private bindSessionEvents(session: voice.AgentSession, roomName: string, callStartTime: number) {
    this.logger.debug('🔗 [Events] Binding SDK events...');
    // Typecast to unknown then to typed event emitter or just listen to known events
    const sessionEmitter = session as unknown as EventEmitter;

    sessionEmitter.on('user_input_transcribed', (ev: Record<string, any>) => {
      const text = ev.text || ev.transcript || '';
      if (!text) return;

      if (ev.isFinal) {
        this.publishFinalEvent('user', text);
      } else {
        this.publishInterimEvent('user', text);
      }
    });

    sessionEmitter.on('conversation_item_added', (ev: Record<string, any>) => {
      const item = ev?.item;
      if (!item || item.role !== 'assistant') return;

      let text = '';
      if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content) && item.content.length > 0) {
        text = item.content[0]?.text || '';
      }

      if (text) this.publishFinalEvent('agent', text);
    });

    sessionEmitter.on('error', (err: Record<string, any> | Error) => {
      const innerError = (err && 'error' in err ? err.error : err) as Error;
      if (innerError?.name === 'APIUserAbortError' || innerError?.message?.includes('aborted')) {
        this.logger.debug('⚠️ [AgentSession] TTS request gracefully aborted due to user interruption.');
        return;
      }
      this.logger.error(`❌ [AgentSession] Unhandled SDK Exception: ${innerError?.message || 'Unknown'}`, innerError?.stack);
    });
  }

  private publishFinalEvent(sender: string, text: string) {
    this.logger.debug(`📤 [Event] Publishing final speech by ${sender}: "${text.substring(0, 30)}..."`);
    this.redis.publish('call-events', JSON.stringify({ roomName: this.roomName, sender, text, timestamp: new Date(), isFinal: true }))
      .catch((err: Error) => this.logger.error(`❌ [Event] Failed to publish final event: ${err.message}`));
  }

  private publishInterimEvent(sender: string, text: string) {
    this.redis.publish('call-interim-events', JSON.stringify({ roomName: this.roomName, sender, text, isFinal: false }))
      .catch((err: Error) => this.logger.error(`❌ [Interim Event] Failed: ${err.message}`));
  }
}
