import { randomUUID } from 'crypto';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Room, RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { ParticipantKind } from '@livekit/rtc-ffi-bindings';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Redis } from 'ioredis';
import * as silero from '@livekit/agents-plugin-silero';
import { voice } from '@livekit/agents';
import { EventEmitter } from 'events';

import { reportError } from '@mova-back/shared-config';
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

  /** ms-since-epoch when the agent joined the LiveKit room. Stamped at
   *  the start of `start()` and used to compute durationMs for every
   *  `call.ended` emit so the post-call sheet shows a real number. */
  private callStartTime: number | null = null;

  /** Watchdog that fires a fallback utterance if the LLM never produces
   *  an answer after the interlocutor finishes a turn. Without this, a
   *  silent LLM/TTS failure leaves the caller listening to dead air —
   *  the worst possible UX for a deaf-user proxy call. Armed on every
   *  `onInterlocutorFinal`, cleared on every `onAiFinal`. */
  private responseWatchdog: NodeJS.Timeout | null = null;
  private static readonly RESPONSE_TIMEOUT_MS = 10_000;
  /** Polite "I'm thinking" line we say when the watchdog fires. Kept
   *  short so it doesn't drown the AI if it eventually comes through
   *  late, and intentionally non-meta (never says "I'm an AI"). */
  private static readonly FALLBACK_LINES_UA = [
    'Перепрошую, можете повторити?',
    'Вибачте, мене не дуже добре чути. Повторіть, будь ласка.',
    'Дайте мені секунду.',
  ];
  /** Round-robin pointer so consecutive fallbacks don't repeat the same line. */
  private fallbackCursor = 0;

  /**
   * Idle-probe watchdog. Fires when the agent has been listening for too
   * long with NO sound from the interlocutor (no VAD, no STT partial, no
   * STT final). Without this the line goes silent both ways: the agent
   * politely waits for input that never comes, the user (caller and the
   * deaf-end mobile user) thinks "AI is silent" and hangs up.
   *
   * Armed: after each AI utterance finishes (initial greeting + every
   * `onAiFinal` + every fallback line).
   * Cleared: on any `user_input_transcribed` (partial or final).
   *
   * First probe lands later than subsequent ones — a fresh-connect human
   * deserves a few seconds to clear their throat; back-to-back silence
   * after we've already probed once means we're probably talking to a
   * machine or someone who genuinely didn't pick up.
   */
  private idleProbeTimer: NodeJS.Timeout | null = null;
  private idleProbeCount = 0;
  /** Cleared when the SIP participant joins; before that, idle probes
   *  are pointless — nobody's on the line yet. */
  private participantAnswered = false;
  private static readonly IDLE_FIRST_MS = 18_000;
  private static readonly IDLE_FOLLOWUP_MS = 25_000;
  /** After this many unanswered probes we give up and end the call so
   *  we don't run forever talking to nobody and burning balance. */
  private static readonly IDLE_MAX_PROBES = 3;
  private static readonly IDLE_PROBES_UA = [
    'Алло? Ви мене чуєте?',
    'Перепрошую, можливо погано чути — ви на лінії?',
    'Здається, нас не чути. Я ще трохи зачекаю і покладу слухавку.',
  ];

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
    this.callStartTime = callStartTime;
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
      // The SIP participant joins the room only after the trunk reports
      // that the called phone actually picked up. Surfacing this as a
      // separate event lets the mobile UI keep a ringing-loader on screen
      // until there's a real interlocutor — instead of swapping to the
      // chat the moment the agent is ready (which is hundreds of ms after
      // dialing the trunk, with a long wait still ahead).
      this.room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        if (this.participantAnswered) return;
        if (p.kind !== ParticipantKind.SIP) return;
        this.participantAnswered = true;
        this.logger.log(
          `📞 [Call Lifecycle] Interlocutor answered (identity=${p.identity})`,
        );
        this.emitTyped({
          type: 'call.answered',
          data: { participantIdentity: p.identity },
        });
      });
      this.room.on(RoomEvent.Disconnected, () => {
        const durationMs = Date.now() - callStartTime;
        this.logger.log(`🚪 [Call Lifecycle] Room disconnected after ${durationMs}ms.`);
        // Reason is best-effort — distinguishing interlocutor-hangup from
        // network drop needs SIP-event introspection (Phase 8 work).
        this.emitTyped({
          type: 'call.ended',
          data: { endedBy: 'interlocutor', reason: 'interlocutor', durationMs },
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

      // Greeting MUST be interruptible. LiveKit Agents JS keeps the
      // non-interruptible SpeechHandle pinned as `_currentSpeech` and then
      // refuses every subsequent `userTurnCompleted` with the warning
      // "skipping user input, current speech generation cannot be
      // interrupted" — i.e. the LLM is never triggered for any user
      // reply for the rest of the call. The cost of allowing
      // interruption is that an instantly-talking caller cuts the
      // greeting short by half a word, which is acceptable. Hard-blocking
      // the LLM is not.
      await this.session.say(this.agentFactory.getInitialGreeting(this.userContext), {
        allowInterruptions: true,
      });
      // Greeting done — start the idle-probe timer so a non-responsive
      // interlocutor doesn't strand the call in silence.
      this.armIdleProbe();

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
        data: {
          endedBy: 'system',
          reason: 'fatal_error',
          errorCode: 'AGENT_LOST',
          durationMs: Date.now() - callStartTime,
        },
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
    // The active SpeechHandle may have been created with `allowInterruptions:
    // false` (we do this for the initial greeting so the call doesn't
    // half-introduce itself if the user types instantly). Calling
    // `interrupt()` on it throws `This generation handle does not allow
    // interruptions` — which is not really an error in our flow: we just
    // want the new utterance to queue after the current one finishes.
    // Swallow that specific failure at warn level; surface any other.
    try {
      this.session.interrupt();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('does not allow interruptions')) {
        this.logger.debug(
          `[Agent Control] Skipped interrupt — current speech is non-interruptible; queueing new utterance.`,
        );
      } else {
        reportError(this.logger, '[Agent Control] interrupt() threw', err, {
          conversationId: this.conversationId,
        });
      }
    }
    try {
      // Same rule as for the greeting: this MUST be interruptible. A
      // non-interruptible say() pins `_currentSpeech` and starves every
      // future LLM turn ("skipping user input" warn). User-typed lines
      // are short anyway; if the user types a second one in quick
      // succession, interrupting the first is the right behavior.
      await this.session.say(text, { allowInterruptions: true, addToChatCtx: true });
      this.recordRecent('user_typed', text);
      // user.spoke goes to api-gateway persistence so the typed message
      // shows up in chat history. source=typed; the control handler can
      // override before publish if it knows it's actually a suggestion.
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
      reportError(this.logger, '[Agent Control] Failed to say user text', err, {
        conversationId: this.conversationId,
        textLength: text.length,
      });
    }
  }

  /** Stop the current TTS playback without saying anything new. */
  async stopTts(): Promise<void> {
    if (!this.session) return;
    try {
      this.session.interrupt();
    } catch (err) {
      // Same expected-noise case as interruptAndSpeak.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('does not allow interruptions')) {
        this.logger.debug(
          `[Agent Control] stopTts skipped — current speech is non-interruptible.`,
        );
        return;
      }
      reportError(this.logger, '[Agent Control] stopTts failed', err, {
        conversationId: this.conversationId,
      });
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
    const durationMs = this.callStartTime ? Date.now() - this.callStartTime : 0;
    this.emitTyped({
      type: 'call.ended',
      data: { endedBy: 'user', reason: 'user', durationMs },
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
    this.clearResponseWatchdog();
    this.clearIdleProbe();
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

      // Any sound from the interlocutor — partial or final — proves
      // they're alive. Stand the idle-probe down and reset the count
      // so it can re-arm fresh after the next AI turn.
      this.clearIdleProbe();
      this.idleProbeCount = 0;

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
        | {
            role?: string;
            content?: string | Array<unknown>;
            textContent?: string;
          }
        | undefined;
      if (!item || item.role !== 'assistant') return;

      // ChatMessage.content is ChatContent[] where ChatContent =
      // string | ImageContent | AudioContent. Plain text replies arrive as
      // an array of strings (NOT { text }), so the previous indexing into
      // `content[0].text` always returned undefined and the AI reply was
      // never published. Prefer the SDK-provided `textContent` getter, then
      // fall back to joining string parts of the content array, then to a
      // raw string. AudioContent has an optional `transcript` we also pick
      // up so realtime-API replies (audio-first) still surface as text.
      let text = '';
      if (typeof item.textContent === 'string' && item.textContent.length > 0) {
        text = item.textContent;
      } else if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        text = item.content
          .map((part) => {
            if (typeof part === 'string') return part;
            const obj = part as { text?: string; transcript?: string } | null;
            return obj?.text ?? obj?.transcript ?? '';
          })
          .filter((s) => s.length > 0)
          .join('\n');
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
      // Try to identify which plugin failed by inspecting the event's
      // `source` field; fall back to 'llm' since that's the most common
      // failure surface and the fallback line speaks the same regardless.
      const source = (err as { source?: { constructor?: { name?: string } } } | null)
        ?.source?.constructor?.name?.toLowerCase() ?? '';
      const providerType: 'stt' | 'llm' | 'tts' =
        source.includes('stt') ? 'stt' : source.includes('tts') ? 'tts' : 'llm';
      reportError(this.logger, '[AgentSession] plugin error', innerError, {
        conversationId: this.conversationId,
        providerType,
        sourceClass: source || 'unknown',
      });
      // Surface to the mobile client as a recoverable degradation banner.
      this.emitTyped({
        type: 'provider.failure',
        data: {
          providerType,
          providerName: source || 'unknown',
          errorCode: innerError?.name ?? 'PLUGIN_ERROR',
          errorMessage: innerError?.message ?? 'Plugin failed',
        },
      });
      // If we were waiting for an AI turn (watchdog armed), kick the
      // fallback immediately instead of waiting out the full window.
      if (this.responseWatchdog) {
        void this.handleAiSilence('plugin_error');
      }
    });
  }

  // ─── Idle-probe (interlocutor goes silent) ─────────────

  private armIdleProbe(): void {
    this.clearIdleProbe();
    // Don't probe before the SIP leg picked up — there's literally nobody
    // on the line yet.
    if (!this.participantAnswered) return;
    if (this.idleProbeCount >= AgentCallHandler.IDLE_MAX_PROBES) return;
    const delay =
      this.idleProbeCount === 0
        ? AgentCallHandler.IDLE_FIRST_MS
        : AgentCallHandler.IDLE_FOLLOWUP_MS;
    this.idleProbeTimer = setTimeout(() => {
      void this.fireIdleProbe();
    }, delay);
  }

  private clearIdleProbe(): void {
    if (this.idleProbeTimer) {
      clearTimeout(this.idleProbeTimer);
      this.idleProbeTimer = null;
    }
  }

  private async fireIdleProbe(): Promise<void> {
    this.clearIdleProbe();
    if (!this.session) return;
    if (this.idleProbeCount >= AgentCallHandler.IDLE_MAX_PROBES) {
      // We've prompted enough times with no answer — give up and end
      // the call so we don't keep talking to dead air on the user's
      // balance. The end emits the standard call.ended event so the
      // mobile post-call sheet renders normally.
      this.logger.warn(
        `[Idle probe] No response after ${AgentCallHandler.IDLE_MAX_PROBES} probes — ending call.`,
      );
      await this.stop();
      return;
    }
    const lines = AgentCallHandler.IDLE_PROBES_UA;
    const line = lines[this.idleProbeCount % lines.length]!;
    this.idleProbeCount += 1;
    this.logger.log(
      `[Idle probe] No interlocutor input — probing (${this.idleProbeCount}/${AgentCallHandler.IDLE_MAX_PROBES}): "${line}"`,
    );
    try {
      await this.session.say(line, { allowInterruptions: true });
      this.recordRecent('ai', line);
      this.emitTyped({
        type: 'ai.text.final',
        data: { text: line, llmProvider: 'idle_probe', llmModel: 'static' },
      });
      // Re-arm with the longer follow-up window so we don't pester.
      this.armIdleProbe();
    } catch (err) {
      reportError(this.logger, '[Idle probe] failed to speak probe line', err, {
        conversationId: this.conversationId,
        probeCount: this.idleProbeCount,
      });
    }
  }

  // ─── AI silence fallback ───────────────────────────────

  private armResponseWatchdog(): void {
    this.clearResponseWatchdog();
    this.responseWatchdog = setTimeout(() => {
      void this.handleAiSilence('timeout');
    }, AgentCallHandler.RESPONSE_TIMEOUT_MS);
  }

  private clearResponseWatchdog(): void {
    if (this.responseWatchdog) {
      clearTimeout(this.responseWatchdog);
      this.responseWatchdog = null;
    }
  }

  /**
   * Speak a generic fallback line when the LLM goes silent (timeout, plugin
   * error, anything). The goal is "never let the called party listen to
   * silence" — even a "give me a sec" beats a dead line. We rotate through
   * a small set of phrases so back-to-back fallbacks don't sound stuck.
   *
   * Marked `allowInterruptions: true` so when the real reply finally lands
   * (late LLM resolves after the watchdog fired) it cleanly overrides this
   * placeholder instead of queueing behind it.
   */
  private async handleAiSilence(
    reason: 'timeout' | 'plugin_error',
  ): Promise<void> {
    this.clearResponseWatchdog();
    if (!this.session) return;
    const lines = AgentCallHandler.FALLBACK_LINES_UA;
    const line = lines[this.fallbackCursor % lines.length]!;
    this.fallbackCursor += 1;
    this.logger.warn(
      `[AI fallback] AI silent (reason=${reason}); speaking: "${line}"`,
    );
    try {
      await this.session.say(line, { allowInterruptions: true });
      this.recordRecent('ai', line);
      // Mirror to the chat so the user sees the placeholder too —
      // otherwise they hear it but the transcript jumps from their
      // last turn straight to the eventual real reply.
      this.emitTyped({
        type: 'ai.text.final',
        data: {
          text: line,
          llmProvider: 'fallback',
          llmModel: 'static',
        },
      });
    } catch (err) {
      reportError(this.logger, '[AI fallback] failed to speak fallback line', err, {
        conversationId: this.conversationId,
        reason,
      });
    }
  }

  private onInterlocutorFinal(text: string): void {
    const messageId = randomUUID();
    this.recordRecent('interlocutor', text);
    // Interlocutor just finished — we now expect an AI reply within
    // RESPONSE_TIMEOUT_MS. If none arrives, the watchdog speaks a
    // fallback line so the line never goes mute.
    this.armResponseWatchdog();

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
    // AI replied — silence watchdog can stand down, and we re-arm the
    // idle probe because now we're back to waiting on the interlocutor.
    this.clearResponseWatchdog();
    this.armIdleProbe();
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
