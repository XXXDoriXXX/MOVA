import { randomUUID } from 'crypto';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Redis } from 'ioredis';
import * as silero from '@livekit/agents-plugin-silero';
import { voice } from '@livekit/agents';
import { EventEmitter } from 'events';

import type { InternalCallEvent } from '@mova-back/shared-realtime';

import { AgentFactory, AgentContext } from './agent/agent.factory';
import { CallEventPublisher } from './events/call-event.publisher';
import { SuggestionsService } from './suggestions/suggestions.service';

/**
 * Per-call lifecycle handler. Bridges the LiveKit Agents JS SDK pipeline
 * to our typed internal event protocol.
 *
 * Phase 6 pt 2 additions over the prior version:
 *   1. Publishes typed `InternalCallEvent` to `call-events:{conversationId}`
 *      via `CallEventPublisher` — the channel consumed by api-gateway
 *      persistence (Phase 4 pt 2) and realtime-service forwarding (Phase 5).
 *   2. Triggers `SuggestionsService.generateAndEmit()` on every
 *      transcript.final from the interlocutor, in parallel with the main
 *      LLM turn. Fire-and-forget: never blocks the audio pipeline.
 *   3. Keeps legacy flat-channel publishes (`call-events`,
 *      `call-interim-events`) for any not-yet-migrated consumer. Cleanup
 *      lands once realtime-service stops listening to the legacy channels.
 *   4. Maintains a small rolling buffer of recent messages so suggestions
 *      are context-aware (last ≤10 turns), avoiding a DB hop on hot path.
 *
 * Mid-call provider swap (known limitation):
 *   The LiveKit Agents JS pipeline binds STT/LLM/TTS plugins at session
 *   creation. Mid-call swap would require recreating the session and
 *   would interrupt audio. `user.change_model` is therefore logged here
 *   but persisted via Template/user-prefs so it takes effect on the NEXT
 *   call. Real hot-swap is post-MVP — needs a custom pipeline replacing
 *   the LiveKit Agents framework.
 */
export class AgentCallHandler {
  private readonly logger: Logger;
  private room: Room | null = null;
  private session: voice.AgentSession | null = null;

  /** Rolling buffer of recent messages — feeds SuggestionsService context. */
  private readonly recentMessages: Array<{
    role: 'interlocutor' | 'ai' | 'user_typed';
    text: string;
  }> = [];
  private static readonly RECENT_BUFFER_MAX = 10;

  /** Heartbeat tick — realtime-service's watchdog declares AGENT_LOST after silence. */
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 5_000;

  constructor(
    private readonly roomName: string,
    public readonly userContext: AgentContext,
    private readonly config: ConfigService,
    private readonly agentFactory: AgentFactory,
    private readonly vadModel: silero.VAD,
    private readonly redis: Redis,
    private readonly publisher: CallEventPublisher,
    private readonly suggestions: SuggestionsService,
    private readonly onDisconnectCb: (roomName: string) => void,
  ) {
    this.logger = new Logger(`Call-${roomName}`);
  }

  /** Convenience accessor — present when api-gateway populated context. */
  get conversationId(): string | null {
    return this.userContext.conversationId ?? null;
  }

  async start(): Promise<void> {
    const callStartTime = Date.now();
    this.logger.log(`📞 [Call Lifecycle] Initiating connection sequence...`);

    try {
      const apiKey = this.config.getOrThrow<string>('LIVEKIT_API_KEY');
      const apiSecret = this.config.getOrThrow<string>('LIVEKIT_API_SECRET');
      const wsURL = this.config.getOrThrow<string>('LIVEKIT_URL');

      const at = new AccessToken(apiKey, apiSecret, {
        identity: `agent-${this.roomName}`,
        name: this.userContext.userName,
      });
      at.addGrant({ roomJoin: true, room: this.roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();

      this.room = new Room();
      this.room.on(RoomEvent.Disconnected, () => {
        const duration = Date.now() - callStartTime;
        this.logger.log(`🚪 [Call Lifecycle] Room disconnected after ${duration}ms.`);
        // Reason is best-effort — distinguishing interlocutor-hangup from
        // network drop needs SIP-event introspection (Phase 8 work).
        this.emitTyped({
          type: 'call.ended',
          data: { endedBy: 'interlocutor', reason: 'interlocutor' },
        });
        this.cleanup();
      });

      await this.room.connect(wsURL, token);
      this.logger.log(`✅ [WebRTC] Agent joined room`);

      this.emitTyped({ type: 'call.connected', data: {} });

      // Start the heartbeat AFTER we've successfully joined the room. The
      // realtime-service watchdog tolerates ~15s gaps, so a 5s tick gives
      // us 3 misses before it declares AGENT_LOST — plenty of margin for
      // a single GC pause or Redis blip.
      this.startHeartbeat();

      this.session = await this.agentFactory.createSession(this.vadModel, this.userContext);
      const agent = this.agentFactory.createAgent(this.userContext);

      this.bindSessionEvents(this.session);

      this.session.start({ room: this.room, agent });

      await this.session.say(this.agentFactory.getInitialGreeting(this.userContext), {
        allowInterruptions: false,
      });

      this.logger.log(
        `🎉 [Call Lifecycle] Connection sequence completed in ${Date.now() - callStartTime}ms`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `❌ [Call Lifecycle] Fatal error during call setup: ${err.message}`,
        err.stack,
      );
      this.emitTyped({
        type: 'call.ended',
        data: { endedBy: 'system', reason: 'fatal_error', errorCode: 'AGENT_LOST' },
      });
      this.cleanup();
    }
  }

  /**
   * Interrupt current TTS (if any) and speak the supplied text on behalf of
   * the user. Triggered by `user.speak` and `user.accept_suggestion`.
   */
  async interruptAndSpeak(text: string): Promise<void> {
    if (!this.session) {
      this.logger.warn(`🛑 [Agent Control] Cannot speak — session not initialized.`);
      return;
    }
    try {
      this.session.interrupt();
      await this.session.say(text, { allowInterruptions: false, addToChatCtx: true });
      this.recordRecent('user_typed', text);

      // Typed user.spoke event — api-gateway persists it as a Message
      // (role=user_typed) so chat history reflects what the user said.
      // We mark source='typed' because the caller (the control handler) is
      // the one who knows if it was a suggestion vs. raw text; this is the
      // safe default. The control handler can override before publish if
      // it needs to (Phase 7 follow-up).
      this.emitTyped({
        type: 'user.spoke',
        data: {
          text,
          source: 'typed',
          ttsProvider: this.userContext.config?.tts?.provider ?? 'elevenlabs',
          ttsVoice: this.userContext.config?.tts?.voice ?? 'Rachel',
        },
      });
      this.publishLegacyFinal('user_manual', text);
    } catch (err) {
      this.logger.error(`❌ [Agent Control] Override failed: ${(err as Error).message}`);
    }
  }

  /** Stop the current TTS playback without saying anything new. */
  async stopTts(): Promise<void> {
    if (!this.session) return;
    try {
      this.session.interrupt();
    } catch (err) {
      this.logger.warn(`⚠️ [Agent Control] stopTts failed: ${(err as Error).message}`);
    }
  }

  /**
   * Mid-call conversation style swap. Cheap: just rewires the field that
   * SuggestionsService reads on the next turn. No audio is interrupted.
   *
   * We do NOT verify the styleId here — that's the resolver's job. If the
   * caller (realtime-service → Redis) passes a malformed id, the resolver
   * falls back to a built-in and logs.
   *
   * Emits a `call.config.changed` event so all subscribed clients (multiple
   * devices on the same call) converge on the new active selection.
   */
  async setActiveStyle(styleId: string): Promise<void> {
    this.userContext.activeStyleId = styleId;
    this.logger.log(`[Style] active style → ${styleId}`);
    this.emitTyped({
      type: 'call.config.changed',
      data: { styleId },
    });
  }

  /** Forced end of the call from the user side. */
  async stop(): Promise<void> {
    this.emitTyped({
      type: 'call.ended',
      data: { endedBy: 'user', reason: 'user' },
    });
    // `room.disconnect()` alone only drops the agent — the SIP participant
    // (the phone) stays in the room and the real call keeps ringing/talking.
    // Deleting the room kicks every participant, which terminates the SIP
    // leg on the trunk side. Best-effort: if LiveKit is unreachable we still
    // run local cleanup so we don't leak the session.
    try {
      const wssUrl = this.config.get<string>('LIVEKIT_URL');
      const apiKey = this.config.get<string>('LIVEKIT_API_KEY');
      const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET');
      if (wssUrl && apiKey && apiSecret) {
        const httpUrl = wssUrl
          .replace(/^wss:\/\//, 'https://')
          .replace(/^ws:\/\//, 'http://');
        const roomService = new RoomServiceClient(httpUrl, apiKey, apiSecret);
        await roomService.deleteRoom(this.roomName);
        this.logger.log(`📞 [Call Lifecycle] LiveKit room deleted — SIP leg hung up`);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to deleteRoom ${this.roomName}: ${(err as Error).message}`,
      );
    }
    this.cleanup();
  }

  // ─── internals ─────────────────────────────────────

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.session) {
      try {
        this.session.close();
      } catch (err) {
        this.logger.error(`❌ [Memory] Failed to close AgentSession: ${(err as Error).message}`);
      }
      this.session = null;
    }
    if (this.room) {
      try {
        this.room.disconnect();
      } catch (err) {
        this.logger.error(`❌ [Memory] Failed to disconnect room: ${(err as Error).message}`);
      }
      this.room = null;
    }
    this.onDisconnectCb(this.roomName);
  }

  private bindSessionEvents(session: voice.AgentSession): void {
    const sessionEmitter = session as unknown as EventEmitter;

    sessionEmitter.on('user_input_transcribed', (ev: Record<string, unknown>) => {
      const text = (ev['text'] as string) ?? (ev['transcript'] as string) ?? '';
      if (!text) return;

      if (ev['isFinal']) {
        this.onInterlocutorFinal(text);
      } else {
        this.emitTyped({
          type: 'transcript.partial',
          data: { text },
        });
        this.publishLegacyInterim('user', text);
      }
    });

    sessionEmitter.on('conversation_item_added', (ev: Record<string, unknown>) => {
      const item = ev['item'] as
        | { role?: string; content?: string | Array<{ text?: string }> }
        | undefined;
      if (!item || item.role !== 'assistant') return;

      let text = '';
      if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content) && item.content.length > 0) {
        text = item.content[0]?.text ?? '';
      }
      if (!text) return;

      this.onAiFinal(text);
    });

    sessionEmitter.on('error', (err: Record<string, unknown> | Error) => {
      const innerError = (
        err && 'error' in (err as object) ? (err as { error: Error }).error : err
      ) as Error;
      if (innerError?.name === 'APIUserAbortError' || innerError?.message?.includes('aborted')) {
        return;
      }
      this.logger.error(
        `❌ [AgentSession] SDK Exception: ${innerError?.message}`,
        innerError?.stack,
      );
    });
  }

  private onInterlocutorFinal(text: string): void {
    const messageId = randomUUID();
    this.recordRecent('interlocutor', text);

    this.emitTyped({
      type: 'transcript.final',
      data: {
        text,
        sttProvider: this.userContext.config?.stt?.provider ?? 'deepgram',
      },
    });
    this.publishLegacyFinal('user', text);

    // Fire suggestions in parallel — best-effort, never blocks the main turn.
    // Skipped if conversationId or template missing (legacy calls).
    if (this.conversationId && this.userContext.template) {
      void this.suggestions.generateAndEmit({
        conversationId: this.conversationId,
        parentMessageId: messageId,
        parentMessageText: text,
        systemPrompt: this.userContext.template.systemPrompt,
        recentMessages: this.recentMessages.slice(),
        language: this.userContext.template.language,
        // Forward userId so SuggestionsService can adapt to the user's style.
        // Optional — null userContext.userId disables style mimicry.
        userId: this.userContext.userId,
        // Forward the current style — mutated mid-call by setActiveStyle().
        // Resolver inside SuggestionsService handles missing / malformed.
        styleId: this.userContext.activeStyleId,
      });
    }
  }

  private onAiFinal(text: string): void {
    this.recordRecent('ai', text);
    const llmProvider =
      this.userContext.config?.llm?.provider ??
      this.userContext.template?.defaultLlmProvider ??
      'openai';
    const llmModel =
      this.userContext.config?.llm?.model ??
      this.userContext.template?.defaultLlmModel ??
      'gpt-4o-mini';

    this.emitTyped({
      type: 'ai.text.final',
      data: { text, llmProvider, llmModel },
    });
    this.publishLegacyFinal('agent', text);
  }

  /**
   * Build the full InternalCallEvent + publish through CallEventPublisher.
   * Caller passes type + data; we fill conversationId + occurredAt so every
   * emit satisfies the Zod schema downstream.
   */
  private emitTyped(partial: Pick<InternalCallEvent, 'type' | 'data'>): void {
    if (!this.conversationId) {
      // Legacy calls without a Conversation row — typed protocol can't be
      // satisfied. The legacy channels still carry the event.
      return;
    }
    const event = {
      ...partial,
      conversationId: this.conversationId,
      occurredAt: new Date().toISOString(),
    } as InternalCallEvent;
    void this.publisher.publish(event);
  }

  /**
   * Start emitting a heartbeat every 5s to `heartbeat:{conversationId}`.
   * realtime-service subscribes to this pattern; absence > ~15s triggers
   * AGENT_LOST in the watchdog there. We use a separate Redis channel
   * (not the event publisher) to keep this off the typed-event hot path —
   * heartbeat volume is irrelevant for persistence but constant for
   * presence detection.
   */
  private startHeartbeat(): void {
    if (!this.conversationId) return;
    const channel = `heartbeat:${this.conversationId}`;
    const tick = (): void => {
      this.redis
        .publish(channel, JSON.stringify({ ts: Date.now() }))
        .catch((err: Error) =>
          this.logger.debug(`Heartbeat publish failed: ${err.message}`),
        );
    };
    // Fire immediately so the watchdog sees us within 5s of room join.
    tick();
    this.heartbeatInterval = setInterval(tick, AgentCallHandler.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** Rolling buffer for suggestions context. */
  private recordRecent(
    role: 'interlocutor' | 'ai' | 'user_typed',
    text: string,
  ): void {
    this.recentMessages.push({ role, text });
    if (this.recentMessages.length > AgentCallHandler.RECENT_BUFFER_MAX) {
      this.recentMessages.shift();
    }
  }

  /** Legacy flat-channel publishes — kept for any non-migrated consumer. */
  private publishLegacyFinal(sender: string, text: string): void {
    this.redis
      .publish(
        'call-events',
        JSON.stringify({
          roomName: this.roomName,
          sender,
          text,
          timestamp: new Date(),
          isFinal: true,
        }),
      )
      .catch((err: Error) => this.logger.warn(`Legacy publish failed: ${err.message}`));
  }

  private publishLegacyInterim(sender: string, text: string): void {
    this.redis
      .publish(
        'call-interim-events',
        JSON.stringify({ roomName: this.roomName, sender, text, isFinal: false }),
      )
      .catch((err: Error) => this.logger.warn(`Legacy interim publish failed: ${err.message}`));
  }
}
